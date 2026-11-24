// MOVA — Agente 2 (23/11/2026): DESPESA SEM CONTA PRÉVIA paga por comprovante (operação DESPESA_DOCUMENTAL).
// Comprovante + legenda → unidade → leitura → sem conta existente → conta a pagar NOVA (ação estreita registrar_obrigacao) →
// comprovante anexado → pagamento POR COMPROVANTE (sem saída bancária; conciliação pendente) → resposta.
// Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL isolado, IA SIMULADA. Tudo sintético; nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { FINANCEIRO, ALFA, BETA, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
/** Pix CONCLUÍDO de gás (sintético), competência informada, sem conta a pagar prévia. */
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 35000, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: "Distribuidora de Gás Sintética", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", idTransacao: `E0000000020261010SINTGAS${String(++seq).padStart(4, "0")}`,
  situacaoTransacao: "CONCLUIDA", categoriaSugerida: "GAS", ...x });
const POLITICA = (x = {}) => ({ operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100000,
  responsavel: "Administrador Sintético", motivo: "Despesa paga por comprovante Pix concluído até R$ 1.000,00 (sintético)", vigenteDe: "2026-10-01", ...x });
const CRIAR = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
const ESCRITAS = ["registrarDespesaPagaPorComprovante", "enviarEvidencia", "registrarObrigacaoDocumental", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar"];

async function despesa({ responder = () => PIX(), concessao = CRIAR, politica = {}, criarDespesas = true, falhar = null } = {}) {
  const s = await cenario({
    responder,
    extras: ({ nucleo }) => {
      const nucleoOp = falhar ? { ...nucleo, [falhar.op]: async (...a) => { if (falhar.vezes-- > 0) throw new Error("Financeiro indisponível (sintético)"); return nucleo[falhar.op](...a); } } : nucleo;
      return {
        autonomia: true, pagamentoPorComprovante: true, criarDespesas,
        operacional: criarPortaOperacional({ nucleo: nucleoOp, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
          concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) }),
      };
    },
  });
  const cx = s.c(ORG, ALFA);
  const politicaId = politica ? await s.mova.armazenamento.politicas.criar(POLITICA(politica), { criadaPor: HUMANO }) : null;
  const contas = async () => s.m.nucleo.consultarRegistros(cx, { tipo: "OBRIGACAO" });
  const saidas = async () => (await s.m.nucleo.consultarRegistros(cx, { tipo: "MOVIMENTACAO" })).filter((m) => m.sentido === "SAIDA");
  const liquidacoes = async () => s.m.nucleo.consultarRegistros(cx, { tipo: "LIQUIDACAO" });
  const despesas = async () => (await s.m.nucleo.consultarRegistros(cx, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA");
  const escritas = () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome));
  const resposta = async () => (await s.saida()).filter((r) => r.destino === FIN).at(-1)?.texto ?? "";
  const escopo = { organizacaoId: ORG, unidadeId: ALFA };
  const propostas = () => s.mova.armazenamento.propostas.listar(escopo);
  return { ...s, cx, politicaId, contas, saidas, liquidacoes, despesas, escritas, resposta, escopo, propostas };
}

t("A2-H1 despesa INEXISTENTE até R$ 1.000 (Pix concluído, política DESPESA_DOCUMENTAL): conta nova + pago por comprovante, sem saída; DRE uma vez; resposta", async () => {
  const s = await despesa();
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"]);
  const [conta] = await s.contas();
  assert.equal((await s.contas()).length, 1, "uma conta a pagar nova");
  const t1 = (await s.m.nucleo.detalharContaAPagar(s.cx, { id: conta.id })).titulo;
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao, t1.saldoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 0]);
  assert.equal((await s.saidas()).length, 0, "nenhuma saída bancária fictícia");
  assert.equal((await s.liquidacoes()).length, 1, "uma única baixa");
  assert.equal((await s.despesas()).length, 1, "a despesa entra UMA vez na DRE");
  // 24/11: conta + comprovante + pagamento numa ÚNICA operação atômica do Financeiro (antes: três chamadas separadas).
  assert.deepEqual(s.escritas().map((x) => x.nome), ["registrarDespesaPagaPorComprovante"]);
  for (const x of s.escritas()) assert.equal(x.permissoes.length, 4, "identidade operacional só com [ver + as três ações da operação]");
  const [op] = await s.mova.armazenamento.operacoes.listar(s.escopo);
  assert.deepEqual([op.operacao, op.estado, op.executadaPor], ["DESPESA_DOCUMENTAL", "EXECUTADA", OPERADOR]);
  const txt = await s.resposta();
  assert.match(txt, /Despesa registrada e paga por comprovante: R\$ 350,00/);
  assert.match(txt, /Conciliação bancária: pendente/);
});

t("A2-H2 ACIMA do limite (R$ 1.200,00): só proposta, aguardando confirmação humana — nada gravado", async () => {
  const s = await despesa({ responder: () => PIX({ valorCentavos: 120000 }) });
  await s.enviar(gw({ texto: "MOVA comprovante do gás da alfa", doc: pdf("H2") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.deepEqual([s.escritas().length, (await s.contas()).length], [0, 0]);
  const [p] = await s.propostas();
  assert.deepEqual([p.autonomiaDocumental.nivel, p.autonomiaDocumental.motivos], ["APLICAR_COM_CONFIRMACAO", ["ACIMA_DO_LIMITE"]]);
});

t("A2-H3 chave de criação DESLIGADA, sem concessão de registrar_obrigacao ou sem política: só proposta, nenhuma escrita", async () => {
  for (const variante of [{ criarDespesas: false }, { concessao: ["financeiro_v2.ver", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"] }, { politica: null }]) {
    const s = await despesa(variante);
    await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf(`H3-${JSON.stringify(variante)}`) }));
    assert.equal((await s.ultima()).decisao, "PROPOSTA", JSON.stringify(variante));
    assert.deepEqual([s.escritas().length, (await s.contas()).length], [0, 0], JSON.stringify(variante));
  }
});

t("A2-H4 falha de escrita e NOVA TENTATIVA: operação atômica — nada sobra da falha; a nova tentativa grava conta e baixa juntas", async () => {
  const s = await despesa({ falhar: { op: "registrarDespesaPagaPorComprovante", vezes: 1 } });
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H4") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA", "falhou: volta para revisão");
  assert.equal((await s.contas()).length, 0, "24/11: nenhuma conta em aberto sobra da falha (antes ficava registrada sem pagamento)");
  assert.equal((await s.liquidacoes()).length, 0);
  const [p] = await s.propostas();
  assert.equal(p.estado, "AGUARDANDO_REVISAO");
  const r = await s.mova.execucao.aposDespesaNova(p, s.escopo);
  assert.equal(r.situacao, "PAGO_POR_COMPROVANTE");
  assert.equal(r.resultado.despesaCriada, true, "a conta nasce agora, junto com a baixa");
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length, (await s.despesas()).length, (await s.saidas()).length], [1, 1, 1, 0]);
});

t("A2-H5 CONCORRÊNCIA: três execuções simultâneas da mesma proposta → uma conta, uma baixa", async () => {
  const s = await despesa({ criarDespesas: true, politica: { nivel: "APLICAR_COM_CONFIRMACAO" } }); // proposta fica parada
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H5") }));
  await s.mova.armazenamento.politicas.revogar({ id: s.politicaId, organizacaoId: ORG, por: HUMANO });
  await s.mova.armazenamento.politicas.criar(POLITICA(), { criadaPor: HUMANO });
  const [p] = await s.propostas();
  const r = await Promise.all([1, 2, 3].map(() => s.mova.execucao.aposDespesaNova(p, s.escopo)));
  assert.equal(r.filter((x) => x.situacao === "PAGO_POR_COMPROVANTE").length >= 1, true);
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length, (await s.saidas()).length], [1, 1, 0]);
});

t("A2-H6 FRACIONAMENTO: 700 + 500 ao mesmo favorecido em dois comprovantes → o segundo vai para confirmação (POSSIVEL_FRACIONAMENTO)", async () => {
  let v = 70000;
  const s = await despesa({ responder: () => PIX({ valorCentavos: v }) });
  await s.enviar(gw({ texto: "MOVA gás parte 1 da alfa", doc: pdf("H6a") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  v = 50000;
  await s.enviar(gw({ texto: "MOVA gás parte 2 da alfa", doc: pdf("H6b") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  const p = (await s.propostas()).find((x) => x.valorCentavos === 50000);
  assert.ok(p.autonomiaDocumental.motivos.includes("POSSIVEL_FRACIONAMENTO"));
  assert.equal((await s.contas()).length, 1);
});

t("A2-H7 Pix AGENDADO, documento INCONSISTENTE e identificador REPETIDO nunca viram despesa paga automática", async () => {
  const ag = await despesa({ responder: () => PIX({ situacaoTransacao: "AGENDADA" }) });
  await ag.enviar(gw({ texto: "MOVA gás agendado da alfa", doc: pdf("H7a") }));
  assert.notEqual((await ag.ultima()).decisao, "EXECUTADO");
  assert.equal((await ag.contas()).length, 0);
  const inc = await despesa({ responder: () => PIX({ confianca: "BAIXA", incertezas: ["valor"] }) });
  await inc.enviar(gw({ texto: "MOVA gás da alfa", doc: pdf("H7b") }));
  assert.notEqual((await inc.ultima()).decisao, "EXECUTADO");
  assert.equal(inc.escritas().length, 0);
  const id = "E0000000020261010SINTREPETIDO01";
  const rep = await despesa({ responder: () => PIX({ idTransacao: id }) });
  await rep.enviar(gw({ texto: "MOVA gás da alfa", doc: pdf("H7c") }));
  assert.equal((await rep.ultima()).decisao, "EXECUTADO");
  await rep.enviar(gw({ texto: "MOVA gás de novo da alfa", doc: pdf("H7d") }));
  assert.notEqual((await rep.ultima()).decisao, "EXECUTADO", "mesmo identificador de transação: não paga de novo");
  assert.deepEqual([(await rep.contas()).length, (await rep.liquidacoes()).length], [1, 1]);
});

t("A2-H8 política REVOGADA vale na hora; unidade NÃO autorizada (BETA, política só da ALFA) fica em SEM_POLITICA", async () => {
  const s = await despesa();
  await s.mova.armazenamento.politicas.revogar({ id: s.politicaId, organizacaoId: ORG, por: HUMANO });
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H8") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.equal(s.escritas().length, 0);
  const [p] = await s.propostas();
  assert.deepEqual(p.autonomiaDocumental.motivos, ["SEM_POLITICA"]);
  const { decidirAutonomia } = await import("../../src/modules/mova-financeiro/dominio/autonomia.js");
  const d = decidirAutonomia({ politicas: [{ ...POLITICA(), id: "x" }], operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: BETA, valorCentavos: 35000, hoje: "2026-10-10" });
  assert.deepEqual(d.motivos, ["SEM_POLITICA"]);
});

const COM_EXTRATO = [...CRIAR, "financeiro_v2.vincular_pagamento"];
async function comExtrato(s) {
  await s.mova.armazenamento.politicas.criar({ ...POLITICA(), operacao: "BAIXA_POR_EXTRATO", motivo: "Conciliação automática de saídas do extrato conferidas (sintético)" }, { criadaPor: HUMANO });
  const banco = await s.m.nucleo.configurarContaFinanceira(s.cx, { tipo: "BANCARIA", nome: `Banco Sintético ${Math.random().toString(16).slice(2, 8)}`, instituicao: "Banco Teste" });
  return async (valor = 35000, data = "2026-10-10") => (await s.m.nucleo.registrarMovimentacao(s.cx, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO",
    fonte: { sistema: "UNICRED", idExterno: `EXT-${Math.random().toString(16).slice(2, 10)}` } })).movimentacao;
}

t("A2-H9 extrato DEPOIS: a despesa nova paga por comprovante é conciliada com a saída — uma saída, uma baixa, uma despesa", async () => {
  const s = await despesa({ concessao: COM_EXTRATO });
  const saidaDoExtrato = await comExtrato(s);
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H9") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  const mov = await saidaDoExtrato();
  const [k] = await s.mova.execucao.conciliarPendentes(s.escopo);
  assert.deepEqual([k.situacao, k.movimentacaoId], ["CONCILIADO_COM_EXTRATO", mov.id]);
  const [conta] = await s.contas();
  const t1 = (await s.m.nucleo.detalharContaAPagar(s.cx, { id: conta.id })).titulo;
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao], ["PAGO_POR_COMPROVANTE", "CONCILIADO_COM_EXTRATO"]);
  assert.deepEqual([(await s.saidas()).length, (await s.liquidacoes()).length, (await s.despesas()).length], [1, 1, 1]);
});

t("A2-H10 extrato ANTES: a saída já importada não vira 2ª despesa; o comprovante cria a conta, paga sem nova saída e a conciliação liga à saída existente", async () => {
  const s = await despesa({ concessao: COM_EXTRATO });
  const saidaDoExtrato = await comExtrato(s);
  const mov = await saidaDoExtrato();
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H10") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  const [k] = await s.mova.execucao.conciliarPendentes(s.escopo);
  assert.deepEqual([k.situacao, k.movimentacaoId], ["CONCILIADO_COM_EXTRATO", mov.id]);
  assert.deepEqual([(await s.saidas()).length, (await s.liquidacoes()).length, (await s.despesas()).length, (await s.contas()).length], [1, 1, 1, 1]);
});

t("A2-H11 orçamento de IA ESGOTADO: o comprovante não é lido e nada é gravado (sem conta, sem baixa)", async () => {
  const { ErroDeIa } = await import("../../src/modules/mova-financeiro/index.js");
  assert.equal(typeof ErroDeIa, "function");
  const s = await despesa({ responder: () => { throw new ErroDeIa("ORCAMENTO_ESGOTADO"); } });
  await s.enviar(gw({ texto: "MOVA paguei o gás da alfa", doc: pdf("H11") })).catch(() => {});
  assert.notEqual((await s.ultima())?.decisao, "EXECUTADO");
  assert.deepEqual([s.escritas().length, (await s.contas()).length, (await s.liquidacoes()).length], [0, 0, 0]);
});
