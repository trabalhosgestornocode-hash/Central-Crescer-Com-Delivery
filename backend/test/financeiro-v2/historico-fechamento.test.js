// Fase E — 10 (correção com histórico preservado) + auditoria e fechamento de competência.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, conferirTransacao, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, OUTRO_USUARIO, UNI_A, USUARIO, ctx, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

const historico = (nucleo, c, registroTipo, registroId) => nucleo.consultarHistorico(c, { registroTipo, registroId });

test("correção preserva o valor anterior, quem alterou, quando e por quê", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const outro = ctx(ORG_A, UNI_A, undefined, OUTRO_USUARIO);
  await rejeita(nucleo.corrigirObrigacao(outro, { obrigacaoId: ob.id, mudancas: { vencimento: "2026-09-25" } }), CODIGO.ENTRADA_INVALIDA); // sem justificativa
  const corrigida = await nucleo.corrigirObrigacao(outro, { obrigacaoId: ob.id, mudancas: { vencimento: "2026-09-25", descricao: "Compra sintética (boleto reemitido)" }, justificativa: "Fornecedor reemitiu o boleto", versaoEsperada: 1 });
  assert.deepEqual([corrigida.vencimento, corrigida.versao, corrigida.atualizadoPor, corrigida.criadoPor], ["2026-09-25", 2, OUTRO_USUARIO, USUARIO]);
  assert.equal(corrigida.valorBaseCentavos, 100000); // valor não muda por correção cadastral

  const h = await historico(nucleo, c, "OBRIGACAO", ob.id);
  assert.deepEqual(h.map((e) => e.evento), ["CRIACAO", "CORRECAO"]);
  assert.equal(h[0].antes, null);
  assert.deepEqual([h[1].antes.vencimento, h[1].depois.vencimento], ["2026-09-20", "2026-09-25"]);
  assert.deepEqual([h[1].antes.descricao, h[1].antes.versao, h[1].depois.versao], ["Compra sintética", 1, 2]);
  assert.deepEqual([h[1].usuarioId, h[1].justificativa], [OUTRO_USUARIO, "Fornecedor reemitiu o boleto"]);
  assert.ok(h.every((e) => e.em && e.id));
});

test("correção concorrente e campos imutáveis são recusados", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  await nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas: { descricao: "primeira" }, justificativa: "a", versaoEsperada: 1 });
  await rejeita(nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas: { descricao: "segunda" }, justificativa: "b", versaoEsperada: 1 }), CODIGO.CONFLITO_VERSAO);
  for (const mudancas of [{ valorBaseCentavos: 1 }, { saldoCentavos: 0 }, { situacao: "QUITADA" }, { organizacaoId: "x" }, { competencia: "2026-10" }, {}]) {
    await rejeita(nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas, justificativa: "tentativa" }), CODIGO.ENTRADA_INVALIDA);
  }
  await rejeita(nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas: { vencimento: "2026-09-01" }, justificativa: "antes da emissão" }), CODIGO.DATA_INVALIDA);
  assert.equal((await historico(nucleo, c, "OBRIGACAO", ob.id)).length, 2);
});

test("cancelamento é lógico: o registro continua existindo, com motivo, e sai do resultado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes, lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { parcelas: 2 }));
  await nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: obrigacoes[0].id, valorCentavos: 500, motivo: "Multa", categoria: "MULTA" });
  const despesas = async () => (await nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos;
  assert.equal(await despesas(), 100500);

  // Com pagamento vinculado, não cancela.
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 1000))).movimentacao;
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacoes[1].id, valorCentavos: 1000 }] });
  await rejeita(nucleo.cancelarObrigacao(c, { obrigacaoId: obrigacoes[0].id, justificativa: "Lançada em duplicidade" }), CODIGO.OPERACAO_INVALIDA);
  await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "Vínculo indevido" });

  await rejeita(nucleo.cancelarObrigacao(c, { obrigacaoId: obrigacoes[0].id }), CODIGO.ENTRADA_INVALIDA); // sem motivo
  const r = await nucleo.cancelarObrigacao(c, { obrigacaoId: obrigacoes[0].id, justificativa: "Lançada em duplicidade" });
  assert.ok(r.obrigacoes.length === 2 && r.obrigacoes.every((o) => o.situacao === "CANCELADA"));
  assert.equal(await despesas(), 0);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "SALDO_A_PAGAR", competencia: "2026-09" })).totalCentavos, 0);

  // Nada foi apagado: obrigações, lançamentos e ajuste permanecem consultáveis, com o motivo no histórico.
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 2);
  const lancs = await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" });
  assert.ok(lancs.length === 2 && lancs.every((l) => l.situacao === "CANCELADO"));
  const h = await historico(nucleo, c, "LANCAMENTO", lancamento.id);
  assert.deepEqual([h.at(-1).evento, h.at(-1).justificativa, h.at(-1).antes.situacao], ["CANCELAMENTO", "Lançada em duplicidade", "ATIVO"]);
  await rejeita(nucleo.cancelarObrigacao(c, { obrigacaoId: obrigacoes[1].id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacoes[1].id, valorCentavos: 1 }] }), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("reclassificação de lançamento fica no histórico", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const novo = await nucleo.reclassificarLancamento(c, { lancamentoId: lancamento.id, categoria: "EMBALAGENS", justificativa: "Classificação inicial errada" });
  assert.deepEqual([novo.categoria, novo.valorCentavos, novo.versao], ["EMBALAGENS", 100000, 2]);
  const h = await historico(nucleo, c, "LANCAMENTO", lancamento.id);
  assert.deepEqual([h[1].evento, h[1].antes.categoria, h[1].depois.categoria], ["RECLASSIFICACAO", "INSUMOS", "EMBALAGENS"]);
});

test("a porta de persistência não tem exclusão e o histórico só cresce", async () => {
  const repositorio = criarRepositorioMemoria();
  await repositorio.transacao((tx) => {
    assert.deepEqual(conferirTransacao(tx), { faltando: [], indevidos: [], ok: true });
    assert.deepEqual(Object.keys(tx).sort(), ["anexarHistorico", "atualizar", "buscarPorChave", "inserir", "listar", "listarHistorico", "obter"]);
  });
  await assert.rejects(repositorio.leitura((tx) => tx.inserir("CONTA", { id: "x", organizacaoId: ORG_A, unidadeId: UNI_A })), (e) => e.codigo === CODIGO.REPOSITORIO_INVALIDO);
  // Registros devolvidos são imutáveis: mexer no retorno não altera o que está gravado.
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const [lida] = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.throws(() => { lida.saldoCentavos = 0; }, TypeError);
  assert.throws(() => { lida.parcela.numero = 9; }, TypeError);
  const h = await historico(nucleo, c, "OBRIGACAO", ob.id);
  assert.throws(() => { h[0].depois.valorBaseCentavos = 1; }, TypeError);
});

test("estados de fechamento seguem a ordem prevista e exigem o que cada um pede", async () => {
  const { nucleo, c } = await montarComCadastros();
  const mudar = (novoEstado, extra = {}) => nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado, ...extra });
  assert.equal((await nucleo.consultarCompetencia(c, { competencia: "2026-09" })).estado, "ABERTA");
  await rejeita(mudar("FECHAMENTO_HOMOLOGADO", { metodologia: "m" }), CODIGO.TRANSICAO_INVALIDA); // não pula etapas
  await rejeita(mudar("FECHAMENTO_COM_PENDENCIAS", { pendencias: ["x"] }), CODIGO.TRANSICAO_INVALIDA);
  await rejeita(mudar("ABERTA", { justificativa: "já está" }), CODIGO.TRANSICAO_INVALIDA);
  await rejeita(mudar("ENCERRADA"), CODIGO.ENTRADA_INVALIDA);

  assert.equal((await mudar("FECHAMENTO_PRELIMINAR")).estado, "FECHAMENTO_PRELIMINAR");
  await rejeita(mudar("FECHAMENTO_COM_PENDENCIAS"), CODIGO.TRANSICAO_INVALIDA); // pendências precisam ser listadas
  const comPend = await mudar("FECHAMENTO_COM_PENDENCIAS", { pendencias: ["Composição do Balcão não conciliada"] });
  assert.deepEqual(comPend.pendencias, ["Composição do Balcão não conciliada"]);
  await rejeita(mudar("FECHAMENTO_HOMOLOGADO"), CODIGO.TRANSICAO_INVALIDA); // sem metodologia
  const homologada = await mudar("FECHAMENTO_HOMOLOGADO", { metodologia: "Regime de competência; conciliação por extrato" });
  assert.deepEqual([homologada.estado, homologada.metodologia, homologada.decididoPor], ["FECHAMENTO_HOMOLOGADO", "Regime de competência; conciliação por extrato", USUARIO]);
  await rejeita(mudar("FECHAMENTO_PRELIMINAR"), CODIGO.TRANSICAO_INVALIDA); // homologada só sai por revisão
  const h = await historico(nucleo, c, "COMPETENCIA", homologada.id);
  assert.deepEqual(h.map((e) => e.depois.estado), ["FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO"]);
});

test("competência homologada não sofre alteração silenciosa; revisão é explícita e auditada", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob], lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 40000))).movimentacao;
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 40000 }] });
  const mudar = (novoEstado, extra = {}) => nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado, ...extra });
  await mudar("FECHAMENTO_PRELIMINAR");
  await mudar("FECHAMENTO_HOMOLOGADO", { metodologia: "Metodologia sintética" });
  const retrato = JSON.stringify([await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" }), await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" }), await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }), await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })]);

  const tentativas = [
    () => nucleo.registrarObrigacao(c, obrigacao(fornecedor.id)),
    () => nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 100, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 100 }], fonte: { sistema: "SAIPOS", idExterno: "TARDE" } }),
    () => nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 100, competencia: "2026-09" }),
    () => nucleo.registrarMovimentacao(c, saida(banco.id, 100)),
    () => nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 100, dataEfetiva: "2026-09-30" }),
    () => nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100 }] }),
    () => nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "x" }),
    () => nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100, motivo: "juros", categoria: "JUROS" }),
    () => nucleo.corrigirObrigacao(c, { obrigacaoId: ob.id, mudancas: { descricao: "x" }, justificativa: "y" }),
    () => nucleo.cancelarObrigacao(c, { obrigacaoId: ob.id, justificativa: "y" }),
    () => nucleo.reclassificarLancamento(c, { lancamentoId: lancamento.id, categoria: "OUTRA", justificativa: "y" }),
  ];
  for (const t of tentativas) await rejeita(t, CODIGO.COMPETENCIA_HOMOLOGADA);
  const depois = JSON.stringify([await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" }), await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" }), await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }), await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })]);
  assert.equal(depois, retrato);

  // Outra competência segue aberta.
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-10" }));
  // Pagar em outubro uma obrigação de setembro é permitido: o caixa de outubro está aberto e a despesa de setembro não muda.
  const pgOut = (await nucleo.registrarMovimentacao(c, saida(banco.id, 60000, { dataEfetiva: "2026-10-05" }))).movimentacao;
  await nucleo.registrarLiquidacao(c, { movimentacaoId: pgOut.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 60000 }] });
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos, 100000);

  // Revisão: exige justificativa, fica contada e registrada; só então a competência volta a aceitar escrita.
  await rejeita(mudar("ABERTA"), CODIGO.TRANSICAO_INVALIDA);
  const reaberta = await mudar("ABERTA", { justificativa: "Nota fiscal de setembro recebida com atraso" });
  assert.deepEqual([reaberta.estado, reaberta.revisoes], ["ABERTA", 1]);
  const h = await historico(nucleo, c, "COMPETENCIA", reaberta.id);
  assert.deepEqual([h.at(-1).evento, h.at(-1).justificativa, h.at(-1).antes.estado], ["MUDANCA_ESTADO", "Nota fiscal de setembro recebida com atraso", "FECHAMENTO_HOMOLOGADO"]);
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 777 }));
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});
