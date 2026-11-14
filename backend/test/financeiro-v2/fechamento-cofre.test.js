// Regra de fechamento por estado (decisão da Execução 01B) e contrato do cofre privado de documentos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, METODOS_DO_COFRE, conferirCofre, criarCofreMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, entrada, montarComCadastros, obrigacao, prepararHomologacao, rejeita, saida } from "./helpers/cenario.js";

const SET = "2026-09";
const estado = (nucleo, c, novoEstado, extra = {}) => nucleo.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado, confirmar: true, ...extra });
const so = (...acoes) => ctx(ORG_A, UNI_A, acoes);
const eventosDaCompetencia = async (nucleo, c) => {
  const [comp] = (await nucleo.consultarRegistros(c, { tipo: "COMPETENCIA" })).filter((x) => x.competencia === SET);
  return nucleo.consultarHistorico(c, { registroTipo: "COMPETENCIA", registroId: comp.id });
};

test("aberta e fechamento preliminar aceitam operações autorizadas, com histórico", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const operador = so(ACAO.VER, ACAO.REGISTRAR);
  await nucleo.registrarObrigacao(operador, obrigacao(fornecedor.id));
  await estado(nucleo, c, "FECHAMENTO_PRELIMINAR");
  const r = await nucleo.registrarObrigacao(operador, obrigacao(fornecedor.id, { descricao: "Lançada durante o preliminar" }));
  assert.equal(r.repetido, false);
  assert.equal((await nucleo.consultarCompetencia(c, { competencia: SET })).estado, "FECHAMENTO_PRELIMINAR");
  const h = await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: r.obrigacoes[0].id });
  assert.deepEqual(h.map((e) => [e.evento, e.usuarioId]), [["CRIACAO", operador.usuarioId]]);
  assert.deepEqual((await eventosDaCompetencia(nucleo, c)).map((e) => e.evento), ["CRIACAO"]); // preliminar não marca correção
});

test("fechamento com pendências: só correções auditadas — exige permissão de corrigir e deixa marca na competência", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  await estado(nucleo, c, "FECHAMENTO_PRELIMINAR");
  await rejeita(estado(nucleo, c, "FECHAMENTO_COM_PENDENCIAS"), CODIGO.TRANSICAO_INVALIDA); // pendências precisam estar documentadas
  // 08E: documenta as pendências REAIS (conta sem comprovante = ressalva admissível) e então passa pelo estado.
  await prepararHomologacao(nucleo, c, "2026-09");
  assert.equal((await nucleo.consultarCompetencia(c, { competencia: "2026-09" })).estado, "FECHAMENTO_COM_PENDENCIAS");

  // Quem só registra não escreve mais nesta competência; nada é gravado.
  const operador = so(ACAO.VER, ACAO.REGISTRAR);
  await rejeita(nucleo.registrarObrigacao(operador, obrigacao(fornecedor.id, { descricao: "Tentativa sem permissão de corrigir" })), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.registrarMovimentacao(operador, saida(banco.id, 100)), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 1);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 0);

  // Com permissão de corrigir a escrita entra, com o histórico do registro E a marca na competência.
  const corretor = so(ACAO.VER, ACAO.REGISTRAR, ACAO.CORRIGIR);
  const nova = await nucleo.registrarObrigacao(corretor, obrigacao(fornecedor.id, { descricao: "Nota que faltava" }));
  await nucleo.corrigirObrigacao(corretor, { obrigacaoId: ob.id, mudancas: { descricao: "Descrição corrigida no fechamento" }, justificativa: "Conferência com a nota" });
  const eventos = (await eventosDaCompetencia(nucleo, c)).filter((e) => e.evento !== "DOCUMENTACAO_DE_PENDENCIA");
  assert.deepEqual(eventos.map((e) => e.evento), ["CRIACAO", "MUDANCA_ESTADO", "CORRECAO_EM_FECHAMENTO", "CORRECAO_EM_FECHAMENTO"]);
  assert.deepEqual(eventos.slice(2).map((e) => [e.usuarioId, e.depois.estado]), [[corretor.usuarioId, "FECHAMENTO_COM_PENDENCIAS"], [corretor.usuarioId, "FECHAMENTO_COM_PENDENCIAS"]]);
  assert.equal((await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: nova.obrigacoes[0].id })).length, 1);
  // Outra competência (aberta) não é afetada pela regra.
  assert.equal((await nucleo.registrarObrigacao(operador, obrigacao(fornecedor.id, { competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-10" }))).repetido, false);
});

test("homologada bloqueia escrita ordinária; reabrir exige permissão própria, justificativa e fica auditado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob], lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 1000))).movimentacao;
  // 08E: saída sem vínculo bloqueia a homologação (pode ser despesa não reconhecida): ela paga parte da conta antes.
  await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1000 }] });
  // Entrada sem origem: ressalva admissível (efeito limitado e conservador) — usada abaixo na tentativa de estorno.
  const en = (await nucleo.registrarMovimentacao(c, entrada(banco.id, 500))).movimentacao;
  await estado(nucleo, c, "FECHAMENTO_PRELIMINAR");
  await rejeita(estado(nucleo, c, "FECHAMENTO_HOMOLOGADO"), CODIGO.TRANSICAO_INVALIDA); // sem metodologia
  // 08E (F-1): pendências que exigem documentação são documentadas como ressalva sintética antes de homologar.
  await prepararHomologacao(nucleo, c, SET);
  await estado(nucleo, c, "FECHAMENTO_HOMOLOGADO", { metodologia: "Conferência sintética com o extrato" });

  const antes = { ob: (await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, mov: (await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, lan: (await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length };
  for (const tentativa of [
    () => nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { descricao: "Tardia" })),
    () => nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 100, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 100 }], fonte: { sistema: "SAIPOS", idExterno: "TARDE" } }),
    () => nucleo.registrarMovimentacao(c, saida(banco.id, 100)),
    () => nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1000 }] }),
    () => nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas: { descricao: "x" }, justificativa: "y" }),
    () => nucleo.cancelarObrigacao(c, { obrigacaoId: ob.id, justificativa: "y" }),
    () => nucleo.corrigirLancamento(c, { lancamentoId: lancamento.id, mudancas: { descricao: "x" }, justificativa: "y" }),
    () => nucleo.estornarMovimentacao(c, { movimentacaoId: en.id, justificativa: "y" }),
  ]) {
    await rejeita(tentativa, CODIGO.COMPETENCIA_HOMOLOGADA);
  }
  assert.deepEqual({ ob: (await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, mov: (await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, lan: (await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length }, antes);

  // Reabertura: permissão de fechar/homologar não basta; sem justificativa não reabre.
  await rejeita(estado(nucleo, so(ACAO.VER, ACAO.FECHAR, ACAO.HOMOLOGAR), "ABERTA", { justificativa: "Quero mexer" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(estado(nucleo, c, "ABERTA"), CODIGO.TRANSICAO_INVALIDA);
  await rejeita(estado(nucleo, c, "FECHAMENTO_PRELIMINAR"), CODIGO.TRANSICAO_INVALIDA); // homologada só sai por reabertura
  await rejeita(estado(nucleo, so(ACAO.VER, ACAO.REVISAR), "ABERTA", { justificativa: "Revisar não reabre" }), CODIGO.PERMISSAO_INSUFICIENTE); // 08B
  const revisor = so(ACAO.VER, ACAO.REABRIR);
  const reaberta = await estado(nucleo, revisor, "ABERTA", { justificativa: "Nota fiscal sintética chegou depois da homologação" });
  assert.deepEqual([reaberta.estado, reaberta.revisoes, reaberta.decididoPor], ["ABERTA", 1, revisor.usuarioId]);
  const ultimo = (await eventosDaCompetencia(nucleo, c)).at(-1);
  assert.deepEqual([ultimo.evento, ultimo.justificativa, ultimo.antes.estado, ultimo.depois.estado, ultimo.usuarioId], ["MUDANCA_ESTADO", "Nota fiscal sintética chegou depois da homologação", "FECHAMENTO_HOMOLOGADO", "ABERTA", revisor.usuarioId]);
  assert.equal((await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { descricao: "Depois da reabertura" }))).repetido, false);
});

test("cofre de documentos: privado por escopo, íntegro, sem exclusão e sem link público", async () => {
  const cofre = criarCofreMemoria();
  assert.deepEqual(conferirCofre(cofre), { faltando: [], indevidos: [], ok: true });
  assert.deepEqual(METODOS_DO_COFRE, ["guardar", "ler", "existe"]);
  const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
  const A2 = { organizacaoId: ORG_A, unidadeId: UNI_A2 };
  const B = { organizacaoId: ORG_B, unidadeId: UNI_B };
  const arquivo = new TextEncoder().encode("extrato sintético;data;valor\n2026-09-01;100,00\n");

  const g = await cofre.guardar(A, { conteudo: arquivo, tipoMime: "text/csv" });
  assert.match(g.hashSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([g.tamanhoBytes, g.repetido, g.arquivoId.includes("extrato")], [arquivo.byteLength, false, false]); // o identificador não revela o conteúdo
  assert.equal((await cofre.guardar(A, { conteudo: arquivo, tipoMime: "text/csv" })).repetido, true); // mesmo arquivo não é guardado duas vezes
  const lido = await cofre.ler(A, g.arquivoId);
  assert.deepEqual([...lido.conteudo], [...arquivo]);
  assert.equal(lido.hashSha256, g.hashSha256);

  // Outro escopo (mesmo outra unidade da mesma organização) não enxerga o arquivo.
  for (const alheio of [A2, B]) {
    assert.equal(await cofre.existe(alheio, g.arquivoId), false);
    await rejeita(cofre.ler(alheio, g.arquivoId), CODIGO.NAO_ENCONTRADO);
  }
  await rejeita(cofre.ler({ organizacaoId: "x", unidadeId: "y" }, g.arquivoId), CODIGO.CONTEXTO_INVALIDO);
  await rejeita(cofre.guardar(A, { conteudo: new Uint8Array(0), tipoMime: "text/csv" }), CODIGO.DOCUMENTO_INVALIDO);
  await rejeita(cofre.guardar(A, { conteudo: "texto solto", tipoMime: "text/csv" }), CODIGO.DOCUMENTO_INVALIDO);
  await rejeita(cofre.guardar(A, { conteudo: arquivo, tipoMime: "não é tipo" }), CODIGO.DOCUMENTO_INVALIDO);

  // Adulteração do arquivo guardado é detectada na leitura.
  cofre.__adulterarParaTeste(A, g.arquivoId);
  await rejeita(cofre.ler(A, g.arquivoId), CODIGO.DOCUMENTO_INVALIDO);
});

test("do cofre para a ficha: o documento registrado no núcleo carrega o hash do arquivo e fica vinculado ao registro", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const cofre = criarCofreMemoria();
  const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode("nota fiscal sintética nº 1"), tipoMime: "application/pdf" });
  const { documento } = await nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "NOTA_FISCAL", competencia: SET, recebidoEm: "2026-09-06" });
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { documentoIds: [documento.id] }));
  await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "OBRIGACAO", registroId: ob.id });
  assert.equal((await cofre.ler(c, documento.arquivoId)).hashSha256, documento.hashSha256);
  // O mesmo arquivo guardado de novo cai na mesma ficha (não cria documento duplicado).
  const g2 = await cofre.guardar(c, { conteudo: new TextEncoder().encode("nota fiscal sintética nº 1"), tipoMime: "application/pdf" });
  assert.equal((await nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g2.arquivoId, hashSha256: g2.hashSha256, tipo: "NOTA_FISCAL", competencia: SET, recebidoEm: "2026-09-06" })).repetido, true);
  // Cancelar a obrigação não remove a evidência.
  await nucleo.cancelarObrigacao(c, { obrigacaoId: ob.id, justificativa: "Nota cancelada pelo fornecedor" });
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" })).length, 1);
  assert.equal(await cofre.existe(c, documento.arquivoId), true);
});
