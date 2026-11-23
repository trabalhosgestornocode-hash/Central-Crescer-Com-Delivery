// MOVA — Agente 2, Execução 17: PAGAMENTO POR COMPROVANTE (baixa documental) × CONCILIAÇÃO COM O EXTRATO.
// Financeiro v2 REAL em memória (serviços oficiais registrarPagamentoPorComprovante, conciliarPagamentoPorComprovante,
// enviarEvidencia), banco do MOVA no PostgreSQL local isolado, IA SIMULADA. Tudo sintético; nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { FINANCEIRO, ALFA, BETA, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { decidirAutonomia } from "../../src/modules/mova-financeiro/dominio/autonomia.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { avaliarComprovante } from "../../src/modules/mova-financeiro/dominio/comprovante.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3"; // identidade OPERACIONAL (≠ identidade de leitura do MOVA)
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const ID_TX = "E00000000202610101200SINTMAN400";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
/** Pix CONCLUÍDO de R$ 400,00 — MANUTENÇÃO (sintético). */
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 40000, dataPagamento: "2026-10-10",
  favorecido: "Fornecedor Sintético", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", idTransacao: ID_TX, situacaoTransacao: "CONCLUIDA",
  categoriaSugerida: "MANUTENCAO", ...x });
const POLITICA = (x = {}) => ({ operacao: "BAIXA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 50000,
  responsavel: "Administrador Sintético", motivo: "Baixa documental de comprovantes Pix concluídos de baixo valor", vigenteDe: "2026-10-01", ...x });
const ESCRITA = ["financeiro_v2.ver", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento"];
const ESCRITAS = ["enviarEvidencia", "registrarPagamentoPorComprovante", "conciliarPagamentoPorComprovante", "vincularPagamentoDoExtrato", "pagarContaAPagar", "registrarMovimentacao"];

async function documental({ responder = () => PIX(), concessao = ESCRITA, valorConta = 40000, politica = null, extratoAutomatico = false, falhar = null, ligado = true } = {}) {
  const s = await cenario({
    responder,
    extras: ({ nucleo }) => {
      const nucleoOp = falhar ? { ...nucleo, [falhar.op]: async (...a) => { if (falhar.vezes-- > 0) throw new Error("Financeiro indisponível (sintético)"); return nucleo[falhar.op](...a); } } : nucleo;
      return {
        autonomia: true, pagamentoPorComprovante: ligado,
        operacional: criarPortaOperacional({ nucleo: nucleoOp, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
          concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) }),
      };
    },
  });
  const cx = s.c(ORG, ALFA);
  const banco = await s.m.nucleo.configurarContaFinanceira(cx, { tipo: "BANCARIA", nome: "Banco Sintético", instituicao: "Banco Teste" });
  const conta = valorConta ? (await s.conta("2026-10-30", valorConta)).obrigacoes[0] : null;
  const criada = { por: HUMANO };
  if (politica) await s.mova.armazenamento.politicas.criar(POLITICA(politica), { criadaPor: criada.por });
  if (extratoAutomatico) await s.mova.armazenamento.politicas.criar({ ...POLITICA(), operacao: "BAIXA_POR_EXTRATO", motivo: "Conciliação automática de saídas do extrato conferidas" }, { criadaPor: criada.por });
  const saidaDoExtrato = async (valor = 40000, data = "2026-10-10") => (await s.m.nucleo.registrarMovimentacao(cx, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO",
    fonte: { sistema: "UNICRED", idExterno: `EXT-${Math.random().toString(16).slice(2, 10)}` } })).movimentacao;
  const titulo = async (id = conta.id) => (await s.m.nucleo.detalharContaAPagar(cx, { id })).titulo;
  const propostas = () => s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA });
  const escritas = () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome));
  const saidas = async () => (await s.m.nucleo.consultarRegistros(cx, { tipo: "MOVIMENTACAO" })).filter((m) => m.sentido === "SAIDA");
  const liquidacoes = async () => s.m.nucleo.consultarRegistros(cx, { tipo: "LIQUIDACAO" });
  const resposta = async () => (await s.saida()).filter((r) => r.destino === FIN).at(-1)?.texto ?? "";
  const escopo = { organizacaoId: ORG, unidadeId: ALFA };
  return { ...s, cx, banco, conta, saidaDoExtrato, titulo, propostas, escritas, saidas, liquidacoes, resposta, escopo };
}

t("A2-D1 manutenção R$ 400 (Pix concluído, política documental): PAGO POR COMPROVANTE sem saída; o extrato depois CONCILIA a mesma baixa — sem 2ª despesa, 2ª saída ou 2ª baixa", async () => {
  const s = await documental({ politica: {}, extratoAutomatico: true });
  await s.enviar(gw({ texto: "MOVA comprovante da manutenção da alfa", doc: pdf("D1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"]);
  let t1 = await s.titulo();
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao, t1.saldoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 0]);
  assert.equal((await s.saidas()).length, 0, "nenhuma saída inventada");
  assert.deepEqual(s.escritas().map((x) => x.nome), ["enviarEvidencia", "registrarPagamentoPorComprovante"]);
  for (const x of s.escritas()) assert.equal(x.permissoes.length, 2, "identidade operacional só com [ver, ação]");
  const [op] = await s.mova.armazenamento.operacoes.listar(s.escopo);
  assert.deepEqual([op.operacao, op.estado, op.executadaPor], ["BAIXA_DOCUMENTAL", "EXECUTADA", OPERADOR]);
  const txt = await s.resposta();
  assert.match(txt, /Pagamento registrado por comprovante: R\$ 400,00/);
  assert.match(txt, /Conciliação bancária: pendente/);
  assert.doesNotMatch(txt, /conciliad[oa] com/i);
  // O extrato chega (saída de R$ 400,00 do mesmo dia): a conciliação liga a saída à baixa existente.
  const mov = await s.saidaDoExtrato();
  assert.deepEqual((await s.mova.execucao.reconferirPendentes(s.escopo)).length, 0, "a proposta já aplicada não é baixada de novo");
  const [k] = await s.mova.execucao.conciliarPendentes(s.escopo);
  assert.deepEqual([k.situacao, k.movimentacaoId], ["CONCILIADO_COM_EXTRATO", mov.id]);
  t1 = await s.titulo();
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao, t1.saldoCentavos, t1.pagoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIADO_COM_EXTRATO", 0, 40000]);
  const sa = await s.saidas();
  assert.deepEqual([sa.length, sa[0].alocadoCentavos], [1, 40000], "uma única saída: a do extrato");
  assert.equal((await s.liquidacoes()).length, 1, "uma única baixa");
  assert.equal((await s.m.nucleo.consultarRegistros(s.cx, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO").length, 1, "uma única despesa (a da conta)");
  // Segunda rodada: nada a fazer; vincular a mesma saída como baixa nova é recusado pelo Financeiro.
  assert.deepEqual(await s.mova.execucao.conciliarPendentes(s.escopo), []);
  await assert.rejects(s.m.nucleo.vincularPagamentoDoExtrato(s.cx, { movimentacaoId: mov.id, versaoMovimentacao: (await s.saidas())[0].versao, alocacoes: [{ obrigacaoId: s.conta.id, valorCentavos: 40000 }], justificativa: "x", confirmar: true }));
  assert.deepEqual((await s.m.nucleo.verificarConservacao(s.cx)).violacoes ?? [], []);
});

t("A2-D2 sem política documental: só PROPOSTA (nada escrito); a resposta não diz pago", async () => {
  const s = await documental();
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D2") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.equal(s.escritas().length, 0);
  assert.equal((await s.titulo()).saldoCentavos, 40000);
  assert.match(await s.resposta(), /Nada foi lançado ainda/);
  assert.doesNotMatch(await s.resposta(), /Pagamento registrado/);
});

t("A2-D3 Pix AGENDADO, transferência PENDENTE e transação CANCELADA: orientação, nada proposto como pago", async () => {
  for (const [st, re] of [["AGENDADA", /AGENDAMENTO/], ["PENDENTE", /PENDENTE/], ["CANCELADA", /CANCELADA/]]) {
    const s = await documental({ politica: {}, responder: () => PIX({ situacaoTransacao: st }) });
    await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf(`D3${st}`) }));
    assert.equal((await s.ultima()).decisao, "ORIENTACAO", st);
    assert.equal((await s.propostas()).length, 0, st);
    assert.equal(s.escritas().length, 0, st);
    const txt = (await s.saida()).at(-1).texto;
    assert.match(txt, re);
    assert.match(txt, /Nada foi registrado como pago/);
  }
});

t("A2-D4 leitura inconsistente (confiança média, conclusão não identificada, sem favorecido): política existe, mas fica para conferência humana", async () => {
  for (const x of [{ confianca: "MEDIA" }, { situacaoTransacao: "NAO_IDENTIFICADA" }, { incertezas: ["dois valores no documento"] }]) {
    const s = await documental({ politica: {}, responder: () => PIX(x) });
    await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf(`D4${JSON.stringify(x)}`) }));
    const [p] = await s.propostas();
    assert.equal(p.autonomiaDocumental.nivel, "SOMENTE_PROPOR", JSON.stringify(x));
    assert.equal(p.comprovante.situacao, "DOCUMENTO_INCONSISTENTE");
    assert.equal(s.escritas().length, 0);
    assert.match(await s.resposta(), /conferência humana/);
  }
});

t("A2-D5 sem identificador da transação → confirmação humana; acima do limite → confirmação; o responsável confirma: pago por comprovante, sem saída", async () => {
  for (const [opcoes, motivo] of [[{ responder: () => PIX({ idTransacao: null }) }, "SEM_IDENTIFICADOR_DA_TRANSACAO"], [{ politica: { limiteCentavos: 30000 } }, "ACIMA_DO_LIMITE"]]) {
    const s = await documental({ politica: {}, ...opcoes });
    await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf(`D5${motivo}`) }));
    const [p] = await s.propostas();
    assert.deepEqual([p.autonomiaDocumental.nivel, p.autonomiaDocumental.motivos.includes(motivo)], ["APLICAR_COM_CONFIRMACAO", true]);
    assert.equal(s.escritas().length, 0);
    assert.match(await s.resposta(), /Falta a confirmação de um responsável para registrar como pago por comprovante/);
    // Pessoa sem a permissão de baixa por comprovante: recusada; com ela, aplica (o contexto DELA vai ao Financeiro).
    await assert.rejects(s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS.filter((a) => a !== "financeiro_v2.baixar_por_comprovante"), "eeeeeeee-0000-4000-8000-000000000009"), { propostaId: p.id }), /PERMISSAO_INSUFICIENTE/);
    const aplicada = await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id });
    assert.equal(aplicada.estado, "APLICADA");
    assert.equal(aplicada.resultado.situacaoPagamento, "PAGO_POR_COMPROVANTE");
    assert.equal((await s.titulo()).situacaoConciliacao, "CONCILIACAO_PENDENTE");
    assert.equal((await s.saidas()).length, 0, "nenhuma saída nova (nem pela aprovação humana)");
  }
});

t("A2-D6 comprovante DUPLICADO (mesma transação em outro arquivo): não cria segunda proposta nem segunda baixa", async () => {
  const s = await documental({ politica: {} });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D6a") }));
  await s.enviar(gw({ texto: "MOVA comprovante da alfa (de novo)", doc: pdf("D6b") }));
  assert.equal((await s.ultima()).decisao, "DUPLICADO");
  assert.equal((await s.liquidacoes()).length, 1);
  assert.equal(s.escritas().filter((x) => x.nome === "registrarPagamentoPorComprovante").length, 1);
});

t("A2-D7 pagamento PARCIAL por comprovante: conta parcialmente paga, conciliação pendente do valor pago", async () => {
  const s = await documental({ politica: {}, responder: () => PIX({ valorCentavos: 15000 }) });
  await s.enviar(gw({ texto: "MOVA pagamento parcial da alfa", doc: pdf("D7") }));
  const t1 = await s.titulo();
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao, t1.saldoCentavos, t1.aConciliarCentavos], ["PARCIALMENTE_PAGO", "CONCILIACAO_PENDENTE", 25000, 15000]);
  assert.match(await s.resposta(), /pagamento parcial/);
});

t("A2-D8 extrato JÁ importado: segue a baixa pelo extrato (paga E conciliada), não a documental", async () => {
  const s = await documental({ politica: {}, extratoAutomatico: true });
  await s.saidaDoExtrato();
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D8") }));
  assert.deepEqual([(await s.ultima()).conciliacao], ["EXECUTADA"]);
  assert.deepEqual(s.escritas().map((x) => x.nome), ["enviarEvidencia", "vincularPagamentoDoExtrato"]);
  assert.equal((await s.titulo()).situacaoConciliacao, "CONCILIADO_COM_EXTRATO");
});

t("A2-D9 extrato AMBÍGUO depois do pagamento por comprovante: não concilia sozinho (fica para o financeiro); divergência de valor também não", async () => {
  const s = await documental({ politica: {}, extratoAutomatico: true });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D9") }));
  await s.saidaDoExtrato(40000, "2026-10-10");
  await s.saidaDoExtrato(40000, "2026-10-11");
  const [k] = await s.mova.execucao.conciliarPendentes(s.escopo);
  assert.equal(k.situacao, "AMBIGUA");
  assert.equal((await s.titulo()).situacaoConciliacao, "CONCILIACAO_PENDENTE");
  const s2 = await documental({ politica: {}, extratoAutomatico: true });
  await s2.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D9b") }));
  await s2.saidaDoExtrato(39990);
  assert.equal((await s2.mova.execucao.conciliarPendentes(s2.escopo))[0].situacao, "SEM_EXTRATO");
});

t("A2-D10 política REVOGADA vale na hora; sem concessão operacional nada é escrito", async () => {
  const s = await documental({ politica: {} });
  const [pol] = await s.mova.armazenamento.politicas.listar(ORG);
  await s.mova.aprovador.revogarPolitica(ctx(ORG, ALFA, TODAS, HUMANO), { politicaId: pol.id });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D10") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.equal(s.escritas().length, 0);
  const s2 = await documental({ politica: {}, concessao: ["financeiro_v2.ver", "financeiro_v2.enviar_documento"] });
  await s2.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D10b") }));
  assert.equal((await s2.ultima()).decisao, "PROPOSTA");
  assert.equal(s2.escritas().length, 0);
  assert.equal((await s2.titulo()).saldoCentavos, 40000);
});

t("A2-D11 falha do Financeiro na baixa: proposta volta para revisão, operação FALHOU; nova tentativa (reinício) conclui uma única vez", async () => {
  const s = await documental({ politica: {}, falhar: { op: "registrarPagamentoPorComprovante", vezes: 1 } });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D11") }));
  const [p] = await s.propostas();
  assert.equal(p.estado, "AGUARDANDO_REVISAO");
  const [op] = await s.mova.armazenamento.operacoes.listar(s.escopo);
  assert.equal(op.estado, "FALHOU");
  assert.equal((await s.titulo()).saldoCentavos, 40000);
  const [r] = await s.mova.execucao.reconferirPendentes(s.escopo);
  assert.equal(r.situacao, "PAGO_POR_COMPROVANTE");
  const de2 = await s.mova.execucao.pagarPorComprovante({ proposta: (await s.propostas())[0], escopo: s.escopo, nivel: "APLICAR_AUTOMATICO", executor: s.mova.execucao.operacional });
  assert.deepEqual([de2.ok, de2.repetida], [true, true], "idempotente: devolve a operação já executada, não paga de novo");
  assert.equal((await s.liquidacoes()).length, 1);
  assert.equal((await s.titulo()).saldoCentavos, 0);
});

t("A2-D12 despesa NOVA (sem conta) com comprovante: proposta; a aprovação humana registra a conta e o pagamento POR COMPROVANTE (sem saída)", async () => {
  const s = await documental({ valorConta: 0, politica: {}, responder: () => PIX({ competencia: "2026-10" }) });
  await s.enviar(gw({ texto: "MOVA comprovante manutenção freezer alfa", doc: pdf("D12") }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.comando.operacao], ["DESPESA_PAGA", "registrarObrigacao+registrarPagamentoPorComprovante"]);
  assert.equal(s.escritas().length, 0, "obrigação nova nunca é automática");
  const aplicada = await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id });
  assert.equal(aplicada.resultado.situacaoPagamento, "PAGO_POR_COMPROVANTE");
  const t1 = await s.titulo(aplicada.resultado.obrigacaoId);
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE"]);
  assert.equal((await s.saidas()).length, 0);
  assert.equal(s.escritas().filter((x) => x.nome === "pagarContaAPagar").length, 0, "o caminho antigo (saída nova) não é usado com comprovante");
});

t("A2-D13 avaliação determinística: a IA não atesta autenticidade; agendado, pendente, cancelado, ilegível, duplicado e arquivo suspeito nunca são aptos", () => {
  const hoje = "2026-10-15";
  const casos = [
    [PIX(), "PIX_CONCLUIDO", true], [PIX({ situacaoTransacao: "AGENDADA" }), "PIX_AGENDADO", false], [PIX({ situacaoTransacao: "PENDENTE" }), "TRANSFERENCIA_PENDENTE", false],
    [PIX({ situacaoTransacao: "CANCELADA" }), "TRANSACAO_CANCELADA", false], [PIX({ legivel: false }), "DOCUMENTO_ILEGIVEL", false],
    [PIX({ dataPagamento: "2026-10-20" }), "DOCUMENTO_INCONSISTENTE", false], [PIX({ favorecido: null }), "DOCUMENTO_INCONSISTENTE", false],
    [PIX({ tipoDocumento: "BOLETO" }), "NAO_E_COMPROVANTE", false],
  ];
  for (const [leitura, situacao, apto] of casos) assert.deepEqual([avaliarComprovante(leitura, { hoje }).situacao, avaliarComprovante(leitura, { hoje }).apto], [situacao, apto], situacao);
  assert.equal(avaliarComprovante(PIX(), { hoje, duplicado: true }).situacao, "COMPROVANTE_DUPLICADO");
  assert.equal(avaliarComprovante(PIX(), { hoje, integridadeOk: false }).situacao, "DOCUMENTO_SUSPEITO");
});

t("A2-D14 Central: linha do tempo do documento (pago por comprovante ≠ conciliado); lista 'a conciliar'; o responsável concilia pela Central sem 2ª baixa", async () => {
  const { CONSULTAS_MOVA, ACOES_MOVA } = await import("../../src/modules/fv2-integracao/movaRotas.js");
  const s = await documental({ politica: {} });
  await s.enviar(gw({ texto: "MOVA comprovante da manutenção da alfa", doc: pdf("D14") }));
  const humano = ctx(ORG, ALFA, TODAS, HUMANO);
  const [p] = await s.propostas();
  const consultar = (rota, params = {}) => CONSULTAS_MOVA[rota]({ ctx: humano, mova: s.mova, nucleo: s.m.nucleo, params });
  let lt = await consultar("/mova/linha-do-tempo", { proposta: p.id });
  const sit = (x) => Object.fromEntries(x.etapas.map((e) => [e.etapa, e.situacao]));
  assert.deepEqual(lt.etapas.map((e) => e.etapa), ["RECEBIMENTO", "EXTRACAO", "IDENTIFICACAO", "CLASSIFICACAO", "OBRIGACAO", "PAGAMENTO", "EXTRATO", "CONCILIACAO", "RESULTADO"]);
  assert.deepEqual([sit(lt).PAGAMENTO, sit(lt).EXTRATO, sit(lt).CONCILIACAO, sit(lt).RESULTADO], ["FEITO", "PENDENTE", "PENDENTE", "FEITO"]);
  assert.match(lt.etapas.find((e) => e.etapa === "PAGAMENTO").detalhe, /Pago por comprovante/);
  assert.match(lt.etapas.find((e) => e.etapa === "CONCILIACAO").detalhe, /Conciliação pendente/);
  const mov = await s.saidaDoExtrato();
  const pc = await consultar("/mova/pagamentos-a-conciliar");
  assert.deepEqual([pc.podeConciliar, pc.itens.length, pc.itens[0].situacao], [true, 1, "CANDIDATA_UNICA"]);
  // Sem vincular_pagamento a Central não concilia (o núcleo recusa).
  const semVincular = ctx(ORG, ALFA, TODAS.filter((a) => a !== "financeiro_v2.vincular_pagamento"), HUMANO);
  const b = { liquidacaoId: pc.itens[0].liquidacaoId, movimentacaoId: mov.id, versaoMovimentacao: mov.versao };
  await assert.rejects(ACOES_MOVA["/mova/conciliar-comprovante"].fazer({ ctx: semVincular, mova: s.mova, nucleo: s.m.nucleo, b }));
  const k = await ACOES_MOVA["/mova/conciliar-comprovante"].fazer({ ctx: humano, mova: s.mova, nucleo: s.m.nucleo, b });
  assert.equal(k.conciliacao, "CONCILIADO_COM_EXTRATO");
  lt = await consultar("/mova/linha-do-tempo", { proposta: p.id });
  assert.deepEqual([sit(lt).PAGAMENTO, sit(lt).EXTRATO, sit(lt).CONCILIACAO], ["FEITO", "FEITO", "FEITO"]);
  assert.deepEqual([(await s.saidas()).length, (await s.liquidacoes()).length], [1, 1]);
  assert.equal((await consultar("/mova/pagamentos-a-conciliar")).itens.length, 0);
});

// ------------------------------------------------------------------ política aprovada: R$ 1.000,00 por pagamento, só a unidade
const LIMITE_APROVADO = { limiteCentavos: 100000 };

t("A2-D15 política aprovada (R$ 1.000,00 por pagamento): R$ 1.000,00 exato é automático; R$ 1.000,01 vai para aprovação humana", async () => {
  const s = await documental({ politica: LIMITE_APROVADO, valorConta: 100000, responder: () => PIX({ valorCentavos: 100000 }) });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D15a") }));
  assert.equal((await s.ultima()).conciliacao, "PAGO_POR_COMPROVANTE");
  const s2 = await documental({ politica: LIMITE_APROVADO, valorConta: 100001, responder: () => PIX({ valorCentavos: 100001 }) });
  await s2.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D15b") }));
  const [p] = await s2.propostas();
  assert.deepEqual([p.autonomiaDocumental.nivel, p.autonomiaDocumental.motivos.includes("ACIMA_DO_LIMITE")], ["APLICAR_COM_CONFIRMACAO", true]);
  assert.equal(s2.escritas().length, 0);
});

t("A2-D16 FRACIONAMENTO: dividir um pagamento em comprovantes menores não contorna o limite (mesma conta e mesmo favorecido em poucos dias)", async () => {
  // Mesma conta de R$ 1.500,00 paga em R$ 800,00 + R$ 700,00: o 1º é automático; o 2º somaria R$ 1.500,00 ⇒ confirmação humana.
  let i = 0;
  const partes = [PIX({ valorCentavos: 80000, idTransacao: "E0000000020261010SINTFRAC0001" }), PIX({ valorCentavos: 70000, idTransacao: "E0000000020261010SINTFRAC0002" })];
  const s = await documental({ politica: LIMITE_APROVADO, valorConta: 150000, responder: () => partes[Math.min(i++, 1)] });
  await s.enviar(gw({ texto: "MOVA pagamento parcial da alfa (1)", doc: pdf("D16a") }));
  assert.equal((await s.ultima()).conciliacao, "PAGO_POR_COMPROVANTE");
  await s.enviar(gw({ texto: "MOVA pagamento parcial da alfa (2)", doc: pdf("D16b") }));
  const segunda = (await s.propostas()).find((p) => p.valorCentavos === 70000);
  assert.deepEqual([segunda.autonomiaDocumental.nivel, segunda.autonomiaDocumental.motivos.includes("POSSIVEL_FRACIONAMENTO")], ["APLICAR_COM_CONFIRMACAO", true]);
  assert.equal(s.escritas().filter((x) => x.nome === "registrarPagamentoPorComprovante").length, 1, "só a 1ª parte foi baixada sozinha");
  assert.equal((await s.titulo()).saldoCentavos, 70000);
});

t("A2-D17 política só da unidade: outra unidade (ou a empresa) não herda a baixa documental automática", async () => {
  const s = await documental({ politica: { ...LIMITE_APROVADO, unidadeId: BETA } });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D17") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  const [p] = await s.propostas();
  assert.deepEqual(p.autonomiaDocumental.motivos, ["SEM_POLITICA"]);
  assert.equal(s.escritas().length, 0);
});

t("A2-D18 arquivo SUSPEITO, Pix agendado e comprovante duplicado nunca recebem baixa automática, mesmo dentro do limite", () => {
  const pol = { id: "p1", ...POLITICA(LIMITE_APROVADO) };
  const decidir = (comprovante, extra = {}) => decidirAutonomia({ politicas: [pol], operacao: "BAIXA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, valorCentavos: 40000, hoje: "2026-10-15", conciliacao: { situacao: "AGUARDANDO_EXTRATO" }, comprovante, ...extra });
  assert.equal(decidir(avaliarComprovante(PIX(), { hoje: "2026-10-15" })).nivel, "APLICAR_AUTOMATICO");
  for (const c of [avaliarComprovante(PIX(), { hoje: "2026-10-15", integridadeOk: false }), avaliarComprovante(PIX({ situacaoTransacao: "AGENDADA" }), { hoje: "2026-10-15" }), avaliarComprovante(PIX(), { hoje: "2026-10-15", duplicado: true })]) {
    assert.equal(decidir(c).nivel, "SOMENTE_PROPOR", c.situacao);
  }
  assert.equal(decidir(avaliarComprovante(PIX(), { hoje: "2026-10-15" }), { conciliacao: { situacao: "AMBIGUA" } }).nivel, "SOMENTE_PROPOR", "ambíguo");
  assert.equal(decidir(avaliarComprovante(PIX(), { hoje: "2026-10-15" }), { acumuladoCentavos: 70000 }).nivel, "APLICAR_COM_CONFIRMACAO", "fracionamento");
});

t("A2-D19 chave MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE DESLIGADA (estado depois do merge): nada é pago por comprovante — nem pela política, nem pela Central", async () => {
  const s = await documental({ politica: { limiteCentavos: 100000 }, ligado: false });
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: pdf("D19") }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.equal(s.escritas().length, 0);
  assert.equal(s.mova.pagamentoPorComprovante, false);
  assert.deepEqual(await s.mova.execucao.conciliarPendentes(s.escopo), []);
  const { ACOES_MOVA } = await import("../../src/modules/fv2-integracao/movaRotas.js");
  await assert.rejects(ACOES_MOVA["/mova/conciliar-comprovante"].fazer({ ctx: ctx(ORG, ALFA, TODAS, HUMANO), mova: s.mova, nucleo: s.m.nucleo, b: { liquidacaoId: "x", movimentacaoId: "y", versaoMovimentacao: 1 } }), /ainda não foi ativado/);
  assert.equal((await s.titulo()).saldoCentavos, 40000);
});
