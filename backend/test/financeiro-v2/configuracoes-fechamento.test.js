// Execução 06D — conciliação × competência homologada, fechamento (versões, homologação, reabertura), configurações,
// permissões e responsáveis, cofre documental. Dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACAO, CODIGO, criarCofreDisco, criarCofreMemoria, criarNucleoFinanceiro, criarRegistroDeAcessosNegadosMemoria } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, OUTRO_USUARIO, UNI_A, UNI_A2, UNI_B, USUARIO, ctx, entrada, montar, montarComCadastros, obrigacao, prepararHomologacao, provisionarAdministrador, rejeita, saida, sha } from "./helpers/cenario.js";

const SET = "2026-09";
const OUT = "2026-10";
// 08E: homologar passa pelo caminho certo (pendências que exigem documentação são documentadas como ressalva sintética).
const homologar = async (n, c, competencia = SET, extra = {}) => { await prepararHomologacao(n, c, competencia); return n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética.", confirmar: true, ...extra }); };
const preliminar = (n, c, competencia = SET) => n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_PRELIMINAR" });
const fechar = async (n, c, competencia = SET) => { await preliminar(n, c, competencia); return homologar(n, c, competencia); };
const vendaStone = (id, valor, data = "2026-09-10") => ({ canal: "BALCAO", dataVenda: data, brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: id }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: valor }] });
const pdf = (extra = "") => new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog ${extra} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const lancamentosSnapshot = async (n, c) => (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).map((l) => `${l.id}:${l.versao}:${l.situacao}:${l.valorCentavos}`).sort().join("|");

async function guardarDocumento(nucleo, cofre, c, conteudo, tipoMime, extra = {}) {
  const g = await cofre.guardar(c, { conteudo, tipoMime });
  return (await nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-09-15", descricao: "Comprovante sintético", ...extra })).documento;
}

// ---------------------------------------------------------------------------------------------------- Fase B
test("1, 2 — conciliação em competência aberta; em competência homologada a decisão e a candidata são recusadas", async () => {
  const { nucleo: n, c, banco } = await montarComCadastros();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 10000))).recebiveis[0];
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 10000, { dataEfetiva: "2026-09-25" }))).movimentacao;
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 10000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 10000 }] });
  assert.deepEqual([cand.competenciaDaConciliacao, cand.posteriorAoFechamento], [SET, []]);
  // Segunda candidata, que ficará em aberto quando setembro for homologado.
  const credito2 = (await n.registrarMovimentacao(c, entrada(banco.id, 500, { dataEfetiva: "2026-09-26" }))).movimentacao;
  const r2 = (await n.registrarVenda(c, vendaStone("V-2", 500))).recebiveis[0];
  const aberta = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r2.id, valorCentavos: 500 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito2.id, valorCentavos: 500 }] });
  const confirmada = await n.confirmarConciliacao(c, { correspondenciaId: cand.id });
  assert.equal(confirmada.situacao, "CONFIRMADA");
  await fechar(n, c);
  const antes = await lancamentosSnapshot(n, c);
  // Toda decisão sobre vínculo de setembro é recusada no núcleo — confirmar, rejeitar, aguardar documento, divergência.
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: aberta.id }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(n.rejeitarCorrespondencia(c, { correspondenciaId: aberta.id, justificativa: "x" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(n.marcarAguardandoDocumento(c, { correspondenciaId: aberta.id, justificativa: "x" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r2.id, valorCentavos: 500 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito2.id, valorCentavos: 500 }], justificativa: "nova" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  const depois = (await n.consultarRegistros(c, { tipo: "CORRESPONDENCIA" })).find((x) => x.id === aberta.id);
  assert.deepEqual([depois.situacao, depois.versao], ["CANDIDATA", 1]);
  assert.equal((await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((m) => m.id === credito2.id).situacaoConciliacao, "NAO_CONCILIADA");
  assert.equal(await lancamentosSnapshot(n, c), antes, "nenhuma alteração financeira não autorizada (42)");
});

test("3 — venda de setembro recebida em outubro: legítimo em outubro, auditado, sem reescrever a versão homologada", async () => {
  const { nucleo: n, c, banco } = await montarComCadastros();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 20000))).recebiveis[0];
  const h = await fechar(n, c);
  assert.equal(h.versao.tipo, "HOMOLOGADA");
  const dreAntes = await n.apurarCompetencia(c, { competencia: SET });
  // Crédito de outubro liquida o recebível de setembro (posição financeira) e é conciliado com ele.
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 20000, { dataEfetiva: "2026-10-03" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: credito.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: 20000 }] });
  const corr = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 20000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 20000 }] });
  const conf = await n.confirmarConciliacao(c, { correspondenciaId: corr.id, justificativa: "Repasse Stone de outubro." });
  assert.deepEqual([conf.situacao, conf.competenciaDaConciliacao, conf.posteriorAoFechamento], ["CONFIRMADA", OUT, [SET]]);
  // Um ajuste ECONÔMICO no título de setembro (taxa descoberta) continua proibido.
  await rejeita(n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: -100, motivo: "Taxa", categoria: "TAXAS_STONE" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  // Setembro: resultado intacto; a versão homologada continua reproduzível; o histórico registra a atualização posterior.
  const dreDepois = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(dreDepois.indicadores.RESULTADO_GERENCIAL.valorCentavos, dreAntes.indicadores.RESULTADO_GERENCIAL.valorCentavos);
  assert.equal(dreDepois.versaoHomologada.numero, h.versao.numero);
  assert.equal(dreDepois.versaoHomologada.reproduz, true);
  const comp = await n.consultarCompetencia(c, { competencia: SET });
  const hist = await n.consultarHistorico(c, { registroTipo: "COMPETENCIA", registroId: comp.id });
  assert.ok(hist.some((x) => x.evento === "ATUALIZACAO_POSTERIOR_AO_FECHAMENTO" && x.depois.motivo === "liquidação de título"));
  assert.ok(hist.some((x) => x.evento === "ATUALIZACAO_POSTERIOR_AO_FECHAMENTO" && x.depois.motivo === "decisão de conciliação"));
  // Recebimento DATADO em setembro (dentro da competência homologada) é recusado.
  await rejeita(n.registrarMovimentacao(c, entrada(banco.id, 10, { dataEfetiva: "2026-09-29" })), CODIGO.COMPETENCIA_HOMOLOGADA);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("4 — conciliação e homologação simultâneas: nenhuma decisão de setembro entra depois da homologação", async () => {
  const { nucleo: n, c, banco } = await montarComCadastros();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 7000))).recebiveis[0];
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 7000, { dataEfetiva: "2026-09-20" }))).movimentacao;
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 7000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 7000 }] });
  await preliminar(n, c);
  const [conc, homol] = await Promise.allSettled([n.confirmarConciliacao(c, { correspondenciaId: cand.id }), homologar(n, c)]);
  assert.equal(homol.status, "fulfilled");
  const comp = await n.consultarCompetencia(c, { competencia: SET });
  const histComp = await n.consultarHistorico(c, { registroTipo: "COMPETENCIA", registroId: comp.id });
  const momentoHomologacao = histComp.find((x) => x.depois?.estado === "FECHAMENTO_HOMOLOGADO").em;
  if (conc.status === "fulfilled") {
    const decisao = (await n.consultarHistorico(c, { registroTipo: "CORRESPONDENCIA", registroId: cand.id })).find((x) => x.evento === "CONCILIACAO");
    assert.ok(decisao.em <= momentoHomologacao, "a decisão aconteceu antes; a homologação a viu");
  } else {
    assert.equal(conc.reason.codigo, CODIGO.COMPETENCIA_HOMOLOGADA);
    assert.equal((await n.consultarRegistros(c, { tipo: "CORRESPONDENCIA" }))[0].situacao, "CANDIDATA");
  }
});

// ---------------------------------------------------------------------------------------------------- Fase F
test("5, 6, 9, 32–36 — preliminar, com pendências, homologação, reabertura; versões imutáveis; repetição sem efeito", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  await n.registrarVenda(c, vendaStone("V-1", 5000));
  const p1 = await preliminar(n, c);
  assert.deepEqual([p1.versao.tipo, p1.versao.numero], ["PRELIMINAR", 1]);
  await rejeita(n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Extrato não importado" }] }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Extrato", impacto: "x", responsavelId: OUTRO_USUARIO }] }), CODIGO.ENTRADA_INVALIDA);
  const p2 = await n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Extrato bancário não importado", impacto: "Saldo do banco não conferido", documentacaoFaltante: "Extrato de setembro", decisao: "Fechar com pendência documentada" }], justificativa: "Documentando." });
  assert.equal(p2.versao.tipo, "COM_PENDENCIAS");
  const fech = await n.consultarFechamento(c, { competencia: SET });
  assert.equal(fech.pendenciasDocumentadas[0].impacto, "Saldo do banco não conferido");
  // Homologar exige confirmação explícita e responsável (o usuário da sessão).
  await rejeita(n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "m" }), CODIGO.CONFIRMACAO_EXIGIDA);
  const h = await homologar(n, c);
  assert.deepEqual([h.estado, h.decididoPor, h.versao.tipo, h.versao.numero], ["FECHAMENTO_HOMOLOGADO", USUARIO, "HOMOLOGADA", 3]);
  // 32: repetir a homologação não cria versão nem histórico.
  const repetida = await homologar(n, c);
  assert.equal(repetida.repetido, true);
  assert.equal((await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes.length, 3);
  // 6: reabrir sem justificativa ou sem confirmação é recusado; 5: com ambos (e permissão de revisar) reabre.
  // 08B: reabrir homologada exige a ação PRÓPRIA `reabrir` (revisar não basta).
  await rejeita(n.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REVISAR]), { competencia: SET, novoEstado: "ABERTA", justificativa: "x", confirmar: true }), CODIGO.PERMISSAO_INSUFICIENTE);
  const revisor = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REABRIR]);
  await rejeita(n.alterarEstadoDaCompetencia(revisor, { competencia: SET, novoEstado: "ABERTA", confirmar: true }), CODIGO.TRANSICAO_INVALIDA);
  await rejeita(n.alterarEstadoDaCompetencia(revisor, { competencia: SET, novoEstado: "ABERTA", justificativa: "Nota chegou" }), CODIGO.CONFIRMACAO_EXIGIDA);
  await rejeita(n.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.FECHAR, ACAO.HOMOLOGAR]), { competencia: SET, novoEstado: "ABERTA", confirmar: true, justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const reaberta = await n.alterarEstadoDaCompetencia(revisor, { competencia: SET, novoEstado: "ABERTA", confirmar: true, justificativa: "Nota fiscal sintética chegou." });
  assert.deepEqual([reaberta.estado, reaberta.revisoes, reaberta.versaoHomologadaAnteriorId], ["ABERTA", 1, h.versao.id]);
  // Nova apuração depois das alterações e nova homologação: a versão anterior continua preservada.
  await n.registrarVenda(c, vendaStone("V-2", 1000));
  await preliminar(n, c);
  const h2 = await homologar(n, c);
  const versoes = (await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes;
  // 08E: depois da reabertura, as pendências novas precisam ser documentadas: a segunda homologação passa por
  // "com pendências documentadas" (v5) e homologa com ressalvas (v6). A documentação anterior não se perde.
  assert.deepEqual(versoes.map((v) => [v.numero, v.tipo, v.vigente]), [[6, "HOMOLOGADA", true], [5, "COM_PENDENCIAS", false], [4, "PRELIMINAR", false], [3, "HOMOLOGADA", false], [2, "COM_PENDENCIAS", false], [1, "PRELIMINAR", false]]);
  assert.equal(versoes[3].faturamentoBrutoCentavos, 5000);
  assert.equal(versoes[0].faturamentoBrutoCentavos, 6000);
  assert.notEqual(versoes[0].impressao, versoes[3].impressao);
  assert.equal(h2.versao.numero, 6);
  assert.equal(versoes[0].verificacoes.comRessalvas, true);
  assert.ok(versoes[0].pendencias.some((x) => x.descricao === "Extrato bancário não importado"), "a nota documentada na primeira rodada continua guardada");
});

test("7, 8 — divergência de conciliação sem resolução comprovada bloqueia; recebível em aberto não bloqueia", async () => {
  const { nucleo: n, c, banco, cofre } = await montarComCadastros();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 10000))).recebiveis[0];
  await n.registrarVenda(c, vendaStone("V-2", 3000)); // recebível em aberto: não bloqueia
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 9500, { dataEfetiva: "2026-09-25" }))).movimentacao;
  const corr = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 10000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 9500 }] });
  await n.registrarDivergencia(c, { correspondenciaId: corr.id, justificativa: "Recebido a menor (sintético)." });
  await preliminar(n, c);
  const previa = await n.previaDaMudancaDeEstado(c, { competencia: SET, novoEstado: "FECHAMENTO_HOMOLOGADO" });
  assert.equal(previa.permitida, false);
  assert.deepEqual(previa.impedimentos.map((x) => x.codigo), ["CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO"]);
  await rejeita(homologar(n, c), CODIGO.HOMOLOGACAO_BLOQUEADA);
  // Documentar sem evidência NÃO resolve.
  await rejeita(n.resolverDivergenciaDeConciliacao(c, { correspondenciaId: corr.id, justificativa: "Taxa", evidenciaDocumentoIds: [] }), CODIGO.ENTRADA_INVALIDA);
  const doc = await guardarDocumento(n, cofre, c, pdf(), "application/pdf");
  await n.resolverDivergenciaDeConciliacao(c, { correspondenciaId: corr.id, justificativa: "Taxa de antecipação comprovada no extrato.", evidenciaDocumentoIds: [doc.id] });
  assert.equal((await n.previaDaMudancaDeEstado(c, { competencia: SET, novoEstado: "FECHAMENTO_HOMOLOGADO" })).permitida, true);
  assert.equal((await homologar(n, c)).estado, "FECHAMENTO_HOMOLOGADO");
});

test("10, 41 — metodologia versionada; DRE da homologada = versão homologada (reproduzível); Visão Geral coerente", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  await n.registrarVenda(c, vendaStone("V-1", 8000));
  await preliminar(n, c);
  await rejeita(homologar(n, c, SET, { metodologiaVersao: "OUTRA@v9" }), CODIGO.TRANSICAO_INVALIDA);
  const cfg = await n.consultarConfiguracoes(c);
  const vigente = cfg.metodologias.find((m) => m.vigente);
  assert.equal(vigente.identificador, "DRE_GERENCIAL_SEM_AJUSTE_DE_ESTOQUE@v1");
  assert.ok(vigente.criteriosDeFechamento.some((x) => /Recebíveis válidos/.test(x)));
  const h = await homologar(n, c, SET, { metodologiaVersao: vigente.identificador });
  const v = (await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes[0];
  assert.deepEqual([v.metodologiaVersao, v.vigente], [vigente.identificador, true]);
  const dre = await n.apurarCompetencia(c, { competencia: SET });
  assert.deepEqual([dre.versaoHomologada.numero, dre.versaoHomologada.reproduz, dre.versaoHomologada.impressao], [h.versao.numero, true, dre.impressao]);
  assert.equal(dre.versaoHomologada.apuracao.indicadores.RESULTADO_GERENCIAL.valorCentavos, dre.indicadores.RESULTADO_GERENCIAL.valorCentavos);
  const vg = await n.apurarVisaoGeral(c, { competencia: SET });
  assert.equal(vg.faturamentoBruto.valorCentavos, dre.versaoHomologada.apuracao.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos);
});

// ---------------------------------------------------------------------------------------------------- Fase C
test("11, 12 — plano de contas: histórico; categoria inativa com registros não é excluída e não aceita lançamento novo", async () => {
  const { nucleo: n, c, fornecedor } = await montarComCadastros();
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "SUCO", valorOriginalCentavos: 4000 }));
  await n.alterarCategoria(c, { codigo: "SUCO", mudancas: { nome: "Sucos e polpas" }, justificativa: "Nome mais claro." });
  await n.alterarCategoria(c, { codigo: "SUCO", mudancas: { ativa: false }, justificativa: "Fornecedor de polpa encerrado." });
  const cat = await n.consultarCategoria(c, { codigo: "SUCO" });
  assert.deepEqual([cat.ativa, cat.podeExcluir, cat.uso.lancamentos, cat.uso.competencias], [false, false, 1, [SET]]);
  assert.deepEqual(cat.historico.map((h) => h.evento), ["CRIACAO", "CORRECAO", "CORRECAO"]);
  assert.deepEqual([cat.historico[1].nomeDepois, cat.historico[2].ativaDepois], ["Sucos e polpas", false]);
  await rejeita(n.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "SUCO", descricao: "Nova" })), CODIGO.CATEGORIA_INVALIDA);
  const dre = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(dre.indicadores.CUSTOS_OPERACIONAIS.valorCentavos, -4000, "o histórico continua apurável");
  await rejeita(n.alterarCategoria(c, { codigo: "VENDA_BALCAO", mudancas: { ativa: false }, justificativa: "x" }), CODIGO.CATEGORIA_INVALIDA);
});

test("13, 14, 15 — canais, processadores e contas financeiras", async () => {
  const { nucleo: n, c, banco, caixa } = await montarComCadastros();
  await n.registrarCanalOuProcessador(c, { papel: "CANAL", codigo: "BALCAO", nome: "Balcão da loja", justificativa: "Canal principal." });
  await n.registrarCanalOuProcessador(c, { papel: "CANAL", codigo: "DELIVERY_PROPRIO", codigoBase: "OUTRO", nome: "Entrega própria", justificativa: "Pedidos por telefone." });
  await n.registrarCanalOuProcessador(c, { papel: "PROCESSADOR", codigo: "VALE_SINTETICO", codigoBase: "OPERADORA_BENEFICIOS", nome: "Vale sintético", justificativa: "Operadora de vale." });
  await rejeita(n.registrarCanalOuProcessador(c, { papel: "CANAL", codigo: "STONE", nome: "Stone", justificativa: "x" }), CODIGO.ENTRADA_INVALIDA); // Stone é processador, não canal
  await rejeita(n.registrarCanalOuProcessador(c, { papel: "PROCESSADOR", codigo: "X1", codigoBase: "STONE", nome: "x", taxaContratual: 2.5, justificativa: "x" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.registrarCanalOuProcessador(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR]), { papel: "CANAL", codigo: "OUTRO", nome: "x", justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await n.registrarCanalOuProcessador(c, { papel: "CANAL", codigo: "DELIVERY_PROPRIO", codigoBase: "OUTRO", nome: "Entrega própria", situacao: "INATIVO", justificativa: "Encerrado." });
  const cfg = await n.consultarConfiguracoes(c);
  assert.deepEqual(cfg.canais.find((x) => x.codigo === "BALCAO").nome, "Balcão da loja");
  assert.deepEqual(cfg.canais.find((x) => x.codigo === "DELIVERY_PROPRIO").situacao, "INATIVO");
  assert.equal(cfg.processadores.find((x) => x.codigo === "VALE_SINTETICO").codigoBase, "OPERADORA_BENEFICIOS");
  assert.match(cfg.observacaoComercial, /não são cadastradas nem presumidas/);
  // Contas: renomear exige configurar; desativar exige também conciliar e nenhuma sessão de caixa aberta.
  await n.alterarContaFinanceira(c, { contaId: banco.id, nome: "Unicred (sintética)", justificativa: "Nome do banco." });
  await rejeita(n.alterarContaFinanceira(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.CONFIGURAR]), { contaId: banco.id, ativa: false, justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await n.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-10-14", saldoContadoCentavos: 0 });
  await rejeita(n.alterarContaFinanceira(c, { contaId: caixa.id, ativa: false, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
  await n.configurarUnidade(c, { nomeExibicao: "Unidade sintética", situacao: "ATIVA", justificativa: "Identificação." });
  const cfg2 = await n.consultarConfiguracoes(c);
  assert.equal(cfg2.contas.find((x) => x.id === banco.id).nome, "Unicred (sintética)");
  assert.equal(cfg2.contas.find((x) => x.id === caixa.id).sessaoDeCaixaAberta, true);
  assert.equal(cfg2.unidade.nomeExibicao, "Unidade sintética");
  const hist = await n.consultarHistorico(c, { registroTipo: "CONTA", registroId: banco.id });
  assert.equal(hist.at(-1).justificativa, "Nome do banco.");
});

// ---------------------------------------------------------------------------------------------------- Fase D
test("16–21 — concessões por organização e unidade; escalada e autoconcessão negadas; revogação vale na próxima ação", async () => {
  const { repositorio } = montar({ concessoesDeTeste: false }); // 07B: nenhuma concessão-fixture — só as gravadas pelo teste
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const autoridadeId = "eeeeeeee-0000-4000-8000-000000000001";
  const chaveAutoridade = randomBytes(32);
  const assinar = (ato) => createHmac("sha256", chaveAutoridade).update(JSON.stringify([ato.organizacaoId, ato.unidadeId, ato.usuarioId, [...ato.acoes].sort()])).digest("hex");
  // Provisionamento só existe com a autoridade; aqui não há → o administrador vem do teste 22 (outro núcleo).
  await rejeita(n.provisionarAdministradorInicial({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO, acoes: [ACAO.VER], justificativa: "x", evidencia: "y", atestado: "z" }), CODIGO.PROVISIONAMENTO_RECUSADO);
  const comAutoridade = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, autoridadeDeProvisionamento: { verificar: async (ato) => ({ ok: ato.atestado === assinar(ato), autoridadeId, nivelAutenticacao: "aal2" }) } });
  const ato = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO, acoes: [ACAO.VER, ACAO.CONCEDER, ACAO.REVOGAR, ACAO.CONCILIAR, ACAO.REVISAR], justificativa: "Primeiro administrador financeiro (sintético).", evidencia: "Ata sintética nº 1" };
  await comAutoridade.provisionarAdministradorInicial({ ...ato, atestado: assinar(ato) });
  const adm = ctx(ORG_A, UNI_A, ato.acoes);
  // 16, 17: a concessão vale só na unidade A da organização A.
  await rejeita(n.consultarFechamento(ctx(ORG_A, UNI_A2, ato.acoes), { competencia: SET }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.consultarFechamento(ctx(ORG_B, UNI_B, ato.acoes), { competencia: SET }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await n.consultarFechamento(adm, { competencia: SET })).estado, "ABERTA");
  // 18: concessão autorizada, com histórico.
  await n.concederAcesso(adm, { usuarioId: OUTRO_USUARIO, acoes: [ACAO.VER, ACAO.CONCILIAR], justificativa: "Conciliação do mês." });
  // 19: escalada — conceder ação que não possui (homologar) é recusado.
  await rejeita(n.concederAcesso(adm, { usuarioId: OUTRO_USUARIO, acoes: [ACAO.HOMOLOGAR], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // 21: autoconcessão e autorrevogação recusadas.
  await rejeita(n.concederAcesso(adm, { usuarioId: USUARIO, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Um contexto que ALEGA permissões que a concessão gravada não tem não opera (sem confiar no cliente).
  await rejeita(n.consultarFechamento(ctx(ORG_A, UNI_A, [ACAO.VER], "cccccccc-0000-4000-8000-000000000099"), { competencia: SET }), CODIGO.PERMISSAO_INSUFICIENTE);
  const outro = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.CONCILIAR], OUTRO_USUARIO);
  const banco = await comAutoridade.configurarContaFinanceira(ctx(ORG_A, UNI_A, Object.values(ACAO)), { tipo: "BANCARIA", nome: "Banco" }).catch((e) => e);
  assert.equal(banco.codigo, CODIGO.PERMISSAO_INSUFICIENTE, "nem o administrador configura sem ter a ação concedida");
  await n.consultarFechamento(outro, { competencia: SET });
  // 20: revogação — o MESMO contexto (estado de autorização antigo) deixa de operar na próxima ação.
  await n.revogarAcesso(adm, { usuarioId: OUTRO_USUARIO, acoes: [ACAO.CONCILIAR], justificativa: "Mudou de função." });
  await rejeita(n.gerarCandidatasDeConciliacao(outro, { relacao: "SAIPOS_X_STONE", periodoInicio: "2026-09-01", periodoFim: "2026-09-30" }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await n.consultarFechamento(outro, { competencia: SET })).estado, "ABERTA", "o VER continua concedido");
  const perm = await n.consultarPermissoes(adm);
  const doOutro = perm.itens.find((x) => x.usuarioId === OUTRO_USUARIO);
  assert.deepEqual([doOutro.acoes, doOutro.historico.map((h) => h.evento)], [[ACAO.VER], ["CRIACAO", "CANCELAMENTO"]]);
  assert.deepEqual((await n.consultarPermissoes(outro)).itens.map((x) => x.usuarioId), [OUTRO_USUARIO], "quem não concede só vê o próprio acesso");
});

test("22 — provisionamento inicial: só com autoridade atestando, uma vez por unidade, nunca a si mesma", async () => {
  const { repositorio } = montar();
  const autoridadeId = "eeeeeeee-0000-4000-8000-000000000001";
  const chave = randomBytes(32);
  const assinar = (ato) => createHmac("sha256", chave).update(JSON.stringify([ato.organizacaoId, ato.unidadeId, ato.usuarioId, [...ato.acoes].sort()])).digest("hex");
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, autoridadeDeProvisionamento: { verificar: async (ato) => ({ ok: ato.atestado === assinar(ato), autoridadeId, nivelAutenticacao: "aal2" }) } });
  const ato = { organizacaoId: ORG_A, unidadeId: UNI_A2, usuarioId: USUARIO, acoes: [ACAO.VER, ACAO.CONCEDER], justificativa: "Administrador inicial (sintético).", evidencia: "Ata sintética nº 2" };
  await rejeita(n.provisionarAdministradorInicial({ ...ato, atestado: "forjado" }), CODIGO.PROVISIONAMENTO_RECUSADO);
  await rejeita(n.provisionarAdministradorInicial({ ...ato, acoes: [ACAO.VER, ACAO.CONCEDER, "superadmin"], atestado: "x" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.provisionarAdministradorInicial({ ...ato, usuarioId: autoridadeId, atestado: assinar({ ...ato, usuarioId: autoridadeId }) }), CODIGO.PROVISIONAMENTO_RECUSADO);
  await rejeita(n.provisionarAdministradorInicial({ ...ato, unidadeId: "ffffffff-0000-4000-8000-000000000009", atestado: assinar({ ...ato, unidadeId: "ffffffff-0000-4000-8000-000000000009" }) }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  const c = await n.provisionarAdministradorInicial({ ...ato, atestado: assinar(ato) });
  assert.deepEqual([c.usuarioId, c.concedidoPor, c.acoes], [USUARIO, autoridadeId, [ACAO.CONCEDER, ACAO.VER]]);
  const ato2 = { ...ato, usuarioId: OUTRO_USUARIO };
  await rejeita(n.provisionarAdministradorInicial({ ...ato2, atestado: assinar(ato2) }), CODIGO.PROVISIONAMENTO_RECUSADO); // já existe administrador
  const hist = await n.consultarHistorico(ctx(ORG_A, UNI_A2), { registroTipo: "CONCESSAO", registroId: c.id });
  assert.match(hist[0].justificativa, /Ata sintética nº 2/);
});

test("23, 24 — responsável por pendência: usuário com acesso real, reatribuição justificada, histórico", async () => {
  const m = montar();
  await provisionarAdministrador(m.repositorio); // 07B: quem concede precisa ter a concessão gravada
  const { nucleo: n, c, banco } = await montarComCadastros({ repositorio: m.repositorio });
  await n.registrarMovimentacao(c, saida(banco.id, 1234, { natureza: "OUTRA", dataEfetiva: "2026-09-12" }));
  const p = (await n.consultarPendencias(c, { competencia: SET })).itens[0];
  assert.ok(p, "há pendência no cenário");
  await rejeita(n.atribuirResponsavelDePendencia(c, { competencia: SET, chave: p.chave, responsavelId: "99999999-0000-4000-8000-000000000001" }), CODIGO.ENTRADA_INVALIDA);
  await n.concederAcesso(c, { usuarioId: OUTRO_USUARIO, acoes: [ACAO.VER], justificativa: "Responsável pelas pendências." });
  const a = await n.atribuirResponsavelDePendencia(c, { competencia: SET, chave: p.chave, responsavelId: OUTRO_USUARIO, dataRevisao: "2026-10-20", comentario: "Verificar extrato." });
  assert.deepEqual([a.situacao, a.dataRevisao, a.comentarios.length], ["ATRIBUIDA", "2026-10-20", 1]);
  await n.concederAcesso(c, { usuarioId: "cccccccc-0000-4000-8000-000000000003", acoes: [ACAO.VER], justificativa: "Novo analista." });
  await rejeita(n.atribuirResponsavelDePendencia(c, { competencia: SET, chave: p.chave, responsavelId: "cccccccc-0000-4000-8000-000000000003" }), CODIGO.ENTRADA_INVALIDA);
  await n.atribuirResponsavelDePendencia(c, { competencia: SET, chave: p.chave, responsavelId: "cccccccc-0000-4000-8000-000000000003", justificativa: "Redistribuição da equipe." });
  await rejeita(n.atualizarAcompanhamentoDePendencia(c, { competencia: SET, chave: p.chave, situacao: "CONCLUIDA" }), CODIGO.ENTRADA_INVALIDA);
  await n.atualizarAcompanhamentoDePendencia(c, { competencia: SET, chave: p.chave, situacao: "EM_ANALISE", comentario: "Em análise." });
  await rejeita(n.atribuirResponsavelDePendencia(ctx(ORG_A, UNI_A, [ACAO.VER]), { competencia: SET, chave: p.chave, responsavelId: OUTRO_USUARIO, justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const det = await n.detalharPendencia(c, { competencia: SET, chave: p.chave });
  assert.deepEqual([det.atribuicao.situacao, det.atribuicao.comentarios.length, det.historicoDaAtribuicao.length], ["EM_ANALISE", 2, 3]);
  assert.deepEqual([det.historicoDaAtribuicao[1].responsavelAntes, det.historicoDaAtribuicao[1].responsavelDepois, det.historicoDaAtribuicao[1].justificativa], [OUTRO_USUARIO, "cccccccc-0000-4000-8000-000000000003", "Redistribuição da equipe."]);
  // Atribuir não resolve: a pendência continua na lista, agora com o responsável.
  const lista = await n.consultarPendencias(c, { competencia: SET });
  assert.equal(lista.itens.find((x) => x.chave === p.chave).atribuicao.situacao, "EM_ANALISE");
});

// ---------------------------------------------------------------------------------------------------- Fase E
test("25–30 — cofre: acesso autorizado, outra unidade negada, sem caminho do cliente, adulteração detectada, versões, visualização segura", async () => {
  const acessosNegados = criarRegistroDeAcessosNegadosMemoria();
  const { nucleo: n, c, cofre } = await montarComCadastros({ acessosNegados });
  const doc = await guardarDocumento(n, cofre, c, pdf(), "application/pdf");
  // 25: com a ação de documentos.
  const visto = await n.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "VISUALIZAR" });
  assert.deepEqual([visto.modo, visto.cabecalhos["content-type"], visto.cabecalhos["x-content-type-options"]], ["EM_LINHA", "application/pdf", "nosniff"]);
  assert.match(visto.cabecalhos["content-security-policy"], /sandbox/);
  assert.match(visto.cabecalhos["content-disposition"], /^inline; filename="documento-v1\.pdf"$/);
  assert.equal(createHash("sha256").update(visto.conteudo).digest("hex"), doc.hashSha256);
  await rejeita(n.obterArquivoDoDocumento(ctx(ORG_A, UNI_A, [ACAO.VER]), { id: doc.id, finalidade: "BAIXAR" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const lista = await n.consultarDocumentos(ctx(ORG_A, UNI_A, [ACAO.VER]), {});
  assert.deepEqual([lista.itens[0].podeAbrir, lista.itens[0].arquivoNoCofre], [false, true]);
  // 26: outra unidade e outra organização não enxergam o documento (e a tentativa é registrada).
  await rejeita(n.obterArquivoDoDocumento(ctx(ORG_A, UNI_A2), { id: doc.id, finalidade: "BAIXAR" }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.detalharDocumento(ctx(ORG_B, UNI_B), { id: doc.id }), CODIGO.NAO_ENCONTRADO);
  assert.ok((await acessosNegados.listar()).some((x) => x.codigo === "DOCUMENTO_FORA_DO_ESCOPO" && x.documentoId === doc.id));
  // 27: o cliente não informa caminho — só o identificador opaco da ficha.
  await rejeita(n.obterArquivoDoDocumento(c, { id: "../../../etc/passwd", finalidade: "BAIXAR" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "BAIXAR", arquivoId: "cofre:../x" }), CODIGO.ENTRADA_INVALIDA);
  const raiz = mkdtempSync(join(tmpdir(), "fv2-cofre-teste-"));
  const disco = criarCofreDisco({ raiz });
  await assert.rejects(disco.ler(c, `cofre:${"../".repeat(8)}etc`), (e) => e.codigo === CODIGO.NAO_ENCONTRADO);
  // 30: PDF com conteúdo ativo e CSV não são exibidos em linha; só baixados como anexo neutro.
  const ativo = await guardarDocumento(n, cofre, c, pdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"), "application/pdf");
  await rejeita(n.obterArquivoDoDocumento(c, { id: ativo.id, finalidade: "VISUALIZAR" }), CODIGO.DOCUMENTO_INDISPONIVEL);
  const baixado = await n.obterArquivoDoDocumento(c, { id: ativo.id, finalidade: "BAIXAR" });
  assert.deepEqual([baixado.modo, baixado.cabecalhos["content-type"]], ["ANEXO", "application/octet-stream"]);
  assert.match(baixado.cabecalhos["content-disposition"], /^attachment;/);
  const csv = await guardarDocumento(n, cofre, c, new TextEncoder().encode("data;valor\n2026-09-01;10,00\n"), "text/csv");
  await rejeita(n.obterArquivoDoDocumento(c, { id: csv.id, finalidade: "VISUALIZAR" }), CODIGO.DOCUMENTO_INDISPONIVEL);
  // 29: nova versão aponta para a anterior; a anterior continua consultável e marcada como substituída.
  const v2 = await guardarDocumento(n, cofre, c, pdf("/Lang (pt-BR)"), "application/pdf", { substituiId: doc.id });
  const det = await n.detalharDocumento(c, { id: doc.id });
  assert.deepEqual(det.versoes.map((x) => [x.versao, x.vigente]), [[2, true], [1, false]]);
  assert.equal((await n.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "BAIXAR" })).hashSha256, doc.hashSha256);
  assert.deepEqual((await n.consultarDocumentos(c, { situacao: "SUBSTITUIDO" })).itens.map((x) => x.id), [doc.id]);
  assert.equal(v2.versaoDocumento, 2);
  // 28: arquivo alterado no cofre é detectado pelo hash; acesso bloqueado; a verificação fica no histórico.
  cofre.__adulterarParaTeste(c, doc.arquivoId);
  assert.equal((await n.verificarIntegridadeDoDocumento(c, { id: doc.id })).conferido, false);
  await rejeita(n.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "BAIXAR" }), CODIGO.DOCUMENTO_ADULTERADO);
  const hist = (await n.detalharDocumento(c, { id: doc.id })).historico;
  assert.ok(hist.filter((h) => h.evento === "ACESSO_DOCUMENTO").length >= 2);
  assert.ok(!JSON.stringify(hist).includes("%PDF"), "conteúdo do arquivo nunca vai para o histórico");
  // Ficha sem arquivo no cofre deste ambiente: só metadados, sem link falso.
  const semArquivo = (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: "cofre:" + sha("a"), hashSha256: sha("a"), tipo: "BOLETO", recebidoEm: "2026-09-01" })).documento;
  await rejeita(n.obterArquivoDoDocumento(c, { id: semArquivo.id, finalidade: "BAIXAR" }), CODIGO.DOCUMENTO_INDISPONIVEL);
  assert.equal((await n.detalharDocumento(c, { id: semArquivo.id })).arquivoNoCofre, false);
});

test("cofre ausente no ambiente: documentos ficam só com metadados (sem simular acesso)", async () => {
  const { repositorio } = montar();
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: null });
  const d = (await n.registrarDocumento(ctx(), { origem: "MANUAL", arquivoId: "cofre:" + sha("b"), hashSha256: sha("b"), tipo: "BOLETO", recebidoEm: "2026-09-01" })).documento;
  await rejeita(n.obterArquivoDoDocumento(ctx(), { id: d.id, finalidade: "BAIXAR" }), CODIGO.COFRE_INDISPONIVEL);
  assert.equal((await n.consultarDocumentos(ctx(), {})).itens[0].arquivoNoCofre, false);
  const m = criarCofreMemoria();
  assert.equal(typeof m.ler, "function");
});
