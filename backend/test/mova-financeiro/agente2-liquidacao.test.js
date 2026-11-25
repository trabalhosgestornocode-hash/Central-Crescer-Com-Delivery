// MOVA — Agente 2, Frente C INTEGRADA: comprovante → extração → obrigação → EXTRATO → POLÍTICA → liquidação oficial → resposta.
// Financeiro v2 REAL em memória (serviços oficiais: previaDoVinculoDoExtrato, enviarEvidencia, vincularPagamentoDoExtrato,
// estornarLiquidacao), banco do MOVA no PostgreSQL local isolado, IA SIMULADA. Tudo sintético; nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { FINANCEIRO, ALFA, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c2"; // identidade OPERACIONAL (≠ identidade de leitura do MOVA)
const ID_TX = "E00000000202610141200SINTLIQ0001";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 30000, dataPagamento: "2026-10-14",
  favorecido: "Fornecedor Sintético", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", idTransacao: ID_TX, ...x });
const POLITICA = (x = {}) => ({ operacao: "BAIXA_POR_EXTRATO", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 50000,
  responsavel: "Administrador Sintético", motivo: "Baixa automática de comprovantes conferidos com o extrato", vigenteDe: "2026-10-01", ...x });
const ESCRITA = ["financeiro_v2.ver", "financeiro_v2.vincular_pagamento", "financeiro_v2.enviar_documento"];

/** Cenário da liquidação: conta bancária, conta a pagar e (opcional) saída no extrato; porta operacional com concessão. */
async function liquidacao({ responder = () => PIX(), concessao = ESCRITA, valorConta = 30000, saidas = [30000], politica = null } = {}) {
  const s = await cenario({
    responder,
    extras: ({ nucleo }) => ({
      autonomia: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) }),
    }),
  });
  const cx = s.c(ORG, ALFA);
  const banco = await s.m.nucleo.configurarContaFinanceira(cx, { tipo: "BANCARIA", nome: "Banco Sintético", instituicao: "Banco Teste" });
  const conta = (await s.conta("2026-10-16", valorConta)).obrigacoes[0];
  const novaSaida = async (valor, extra = {}) => (await s.m.nucleo.registrarMovimentacao(cx, { contaId: banco.id, dataEfetiva: "2026-10-14", sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO",
    fonte: { sistema: "UNICRED", idExterno: `EXT-${Math.random().toString(16).slice(2, 10)}` }, ...extra })).movimentacao;
  const movs = [];
  for (const v of saidas) movs.push(await novaSaida(v));
  if (politica) await s.mova.armazenamento.politicas.criar(POLITICA(politica), { criadaPor: "eeeeeeee-0000-4000-8000-000000000001" });
  const titulo = async () => (await s.m.nucleo.detalharContaAPagar(cx, { id: conta.id })).titulo;
  const propostas = () => s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA });
  const escritas = () => s.chamadas.filter((x) => ["enviarEvidencia", "vincularPagamentoDoExtrato", "estornarLiquidacao", "pagarContaAPagar"].includes(x.nome));
  return { ...s, cx, banco, conta, novaSaida, movs, titulo, propostas, escritas };
}

t("A2-L1 sem política: conferida com o extrato, mas SÓ proposta (nenhuma escrita); resposta pede confirmação", async () => {
  const s = await liquidacao();
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao, h.autonomia], ["PROPOSTA", "CONFERIDA", "SOMENTE_PROPOR"]);
  const [p] = await s.propostas();
  assert.deepEqual([p.estado, p.conciliacao.situacao, p.conciliacao.movimentacaoId], ["AGUARDANDO_REVISAO", "CONFERIDA", s.movs[0].id]);
  assert.equal(s.escritas().length, 0);
  assert.equal((await s.titulo()).saldoCentavos, 30000);
  assert.match((await s.saida()).find((r) => r.destino === FIN).texto, /conferida com a saída do extrato.*confirmação/);
});

t("A2-L2 política AUTOMÁTICA + identidade operacional: liquida pelo extrato (sem saída nova), anexa o comprovante, idempotente", async () => {
  const s = await liquidacao({ politica: {} });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L2") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "EXECUTADA"]);
  const t1 = await s.titulo();
  assert.equal(t1.saldoCentavos, 0);
  // Escrita só pela identidade OPERACIONAL, só com [ver, ação], e nunca pagarContaAPagar (que criaria outra saída).
  assert.deepEqual(s.escritas().map((x) => x.nome), ["enviarEvidencia", "vincularPagamentoDoExtrato"]);
  for (const x of s.escritas()) assert.equal(x.permissoes.length, 2);
  const mov = (await s.m.nucleo.consultarRegistros(s.cx, { tipo: "MOVIMENTACAO" })).filter((m) => m.sentido === "SAIDA");
  assert.equal(mov.length, 1, "nenhuma saída nova");
  assert.equal(mov[0].alocadoCentavos, 30000);
  const [p] = await s.propostas();
  assert.equal(p.estado, "APLICADA");
  const [op] = await s.mova.armazenamento.operacoes.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.deepEqual([op.estado, op.nivel, op.executadaPor], ["EXECUTADA", "APLICAR_AUTOMATICO", OPERADOR]);
  assert.match((await s.saida()).find((r) => r.destino === FIN).texto, /Baixa registrada no Financeiro: R\$ 300,00/);
  // Idempotência: a mesma proposta não liquida de novo (nem pela execução direta).
  const de2 = await s.mova.execucao.liquidar({ proposta: p, escopo: { organizacaoId: ORG, unidadeId: ALFA }, movimentacaoId: s.movs[0].id, nivel: "APLICAR_AUTOMATICO", executor: s.mova.execucao.operacional });
  assert.equal(de2.repetida, true);
  assert.equal(s.escritas().length, 2);
});

t("A2-L3 sem concessão operacional não escreve; acima do limite pede CONFIRMAÇÃO e o responsável confirma na Central", async () => {
  const sem = await liquidacao({ politica: {}, concessao: null });
  await sem.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L3a") }));
  assert.equal((await sem.ultima()).decisao, "PROPOSTA");
  assert.equal(sem.escritas().length, 0);

  const s = await liquidacao({ politica: { limiteCentavos: 10000 } });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L3b") }));
  const [p] = await s.propostas();
  assert.deepEqual([p.autonomia.nivel, p.autonomia.motivos], ["APLICAR_COM_CONFIRMACAO", ["ACIMA_DO_LIMITE"]]);
  assert.equal(s.escritas().length, 0);
  // Pessoa sem permissão de vincular: recusada. Com permissão: confirma (o contexto DELA vai ao Financeiro).
  await assert.rejects(s.mova.aprovador.confirmarBaixaPorExtrato(ctx(ORG, ALFA, ["financeiro_v2.ver", "financeiro_v2.aprovar"], "eeeeeeee-0000-4000-8000-000000000009"), { propostaId: p.id }), /PERMISSAO_INSUFICIENTE/);
  const humano = ctx(ORG, ALFA, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  // O "Aprovar" antigo (pagarContaAPagar) criaria uma SEGUNDA saída: recusado para baixa já conferida com o extrato.
  await assert.rejects(s.mova.aprovador.aplicar(humano, { propostaId: p.id, contaId: s.banco.id }), /BAIXA_CONFERIDA_COM_EXTRATO/);
  const r = await s.mova.aprovador.confirmarBaixaPorExtrato(humano, { propostaId: p.id });
  assert.equal(r.ok, true);
  assert.equal((await s.titulo()).saldoCentavos, 0);
  assert.ok(s.escritas().every((x) => x.permissoes.length === TODAS.length), "escrita com o contexto da pessoa, não da identidade do MOVA");
});

t("A2-L4 comprovante ANTES do extrato: aguarda; quando a saída é importada, a reconferência liquida", async () => {
  const s = await liquidacao({ politica: {}, saidas: [] });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L4") }));
  assert.equal((await s.ultima()).conciliacao, "AGUARDANDO_EXTRATO");
  assert.match((await s.saida()).find((r) => r.destino === FIN).texto, /Ainda não achei a saída/);
  assert.equal((await s.mova.execucao.reconferirPendentes({ organizacaoId: ORG, unidadeId: ALFA }))[0].situacao, "AGUARDANDO_EXTRATO");
  await s.novaSaida(30000);
  const [r] = await s.mova.execucao.reconferirPendentes({ organizacaoId: ORG, unidadeId: ALFA });
  assert.equal(r.situacao, "EXECUTADA");
  assert.equal((await s.titulo()).saldoCentavos, 0);
});

t("A2-L5 pagamento PARCIAL: baixa só do valor pago; a conta segue em aberto com o restante", async () => {
  const s = await liquidacao({ politica: {}, saidas: [10000], responder: () => PIX({ valorCentavos: 10000 }) });
  await s.enviar(gw({ texto: "MOVA pagamento parcial da alfa", doc: pdf("L5") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  const t1 = await s.titulo();
  assert.equal(t1.saldoCentavos, 20000);
  assert.match((await s.saida()).find((r) => r.destino === FIN).texto, /pagamento parcial/);
});

t("A2-L6 reversão pelo estorno oficial, só por quem pode cancelar; registrada e não repetível", async () => {
  const s = await liquidacao({ politica: {} });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L6") }));
  const [op] = await s.mova.armazenamento.operacoes.listar({ organizacaoId: ORG, unidadeId: ALFA });
  await assert.rejects(s.mova.aprovador.reverterOperacao(ctx(ORG, ALFA, ["financeiro_v2.ver"], "eeeeeeee-0000-4000-8000-000000000009"), { operacaoId: op.id, justificativa: "Comprovante de outra conta" }), /PERMISSAO_INSUFICIENTE/);
  const humano = ctx(ORG, ALFA, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  await assert.rejects(s.mova.aprovador.reverterOperacao(humano, { operacaoId: op.id, justificativa: "curta" }), /JUSTIFICATIVA_OBRIGATORIA/);
  const r = await s.mova.aprovador.reverterOperacao(humano, { operacaoId: op.id, justificativa: "Comprovante era de outra conta a pagar" });
  assert.equal(r.estado, "REVERTIDA");
  assert.equal((await s.titulo()).saldoCentavos, 30000);
  await assert.rejects(s.mova.aprovador.reverterOperacao(humano, { operacaoId: op.id, justificativa: "Comprovante era de outra conta a pagar" }), /OPERACAO_NAO_REVERSIVEL/);
});

t("A2-L7 duas saídas iguais no extrato: AMBÍGUA, nada é escolhido sozinho; porta operacional fechada", async () => {
  const s = await liquidacao({ politica: {}, saidas: [30000, 30000], responder: () => PIX({ idTransacao: null }) });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("L7") }));
  assert.equal((await s.ultima()).conciliacao, "AMBIGUA");
  assert.equal(s.escritas().length, 0);
  assert.match((await s.saida()).find((r) => r.destino === FIN).texto, /mais de uma saída/);
  assert.throws(() => criarPortaOperacional({ nucleo: s.m.nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: OPERADOR, concessoes: criarConcessoesMemoria([]) }), /DIFERENTE/);
  await assert.rejects(s.mova.execucao.operacional.chamar("pagarContaAPagar", { organizacaoId: ORG, unidadeId: ALFA }, {}), /OPERACAO_NAO_PERMITIDA/);
});
