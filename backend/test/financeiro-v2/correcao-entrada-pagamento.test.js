// Correção de ENTRADA EM CONTA de um pagamento de venda (17/11/2026): rota restrita que reaproveita o motor único de estorno.
// Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local (FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, TODAS, UNI_A, UNI_A2, USUARIO, ctx, montar, rejeita } from "./helpers/cenario.js";

const ROTA = "/vendas/pagamento/corrigir-entrada";
const MOTIVO = "Importação por forma de pagamento substituída pela por pedido (sintético).";
let seq = 0;

async function cenario(opcoes) {
  const m = montar(opcoes);
  const c = ctx();
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const vender = async (pagamentos, bruto = 1500) => (await m.nucleo.registrarVenda(c, {
    canal: "BALCAO", dataVenda: "2026-09-05", brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `CE-${(seq += 1)}` }, pagamentos,
  })).venda;
  const comDinheiro = await vender([{ forma: "DINHEIRO", valorCentavos: 1500, contaId: caixa.id }]);
  const pagDinheiro = (await m.nucleo.consultarRegistros(c, { tipo: "PAGAMENTO_VENDA" })).find((p) => p.vendaId === comDinheiro.id);
  return { ...m, c, caixa, vender, comDinheiro, pagDinheiro };
}
const registros = (m, tipo, c = m.c) => m.nucleo.consultarRegistros(c, { tipo });
const corrigir = (m, venda, pagamento, extra = {}, c = m.c) => m.nucleo.corrigirEntradaDePagamentoDeVenda(c, { vendaId: venda.id, pagamentoId: pagamento.id, justificativa: MOTIVO, ...extra });
const foto = async (m) => Object.fromEntries(await Promise.all(["VENDA", "PAGAMENTO_VENDA", "MOVIMENTACAO", "ESTORNO"].map(async (t) => [t, JSON.stringify(await registros(m, t))])));

test("estorno válido: anula a entrada no caixa, a venda fica ativa com valor pendente, nada é apagado e o histórico registra quem e por quê", async () => {
  const m = await cenario();
  const r = await corrigir(m, m.comDinheiro, m.pagDinheiro);
  assert.equal(r.repetido, false);
  assert.deepEqual([r.estorno.motivo, r.estorno.valorCentavos, r.estorno.justificativa, r.estorno.alvoId], ["CORRECAO_DE_PAGAMENTO", 1500, MOTIVO, m.pagDinheiro.id]);
  assert.equal(r.lancamento, null, "correção não gera dedução nem devolução");

  const [mov] = await registros(m, "MOVIMENTACAO");
  assert.deepEqual([mov.situacao, mov.estornoId, mov.valorCentavos], ["ESTORNADA", r.estorno.id, 1500], "a entrada continua gravada, marcada como estornada");
  const pag = (await registros(m, "PAGAMENTO_VENDA")).find((p) => p.id === m.pagDinheiro.id);
  assert.equal(pag.estornadoCentavos, 1500);
  const venda = (await registros(m, "VENDA")).find((v) => v.id === m.comDinheiro.id);
  assert.deepEqual([venda.situacao, venda.brutoCentavos, venda.pagoCentavos, venda.devolvidoCentavos], ["ATIVA", 1500, 0, 0], "receita intacta; só o pagamento foi corrigido");
  assert.equal((await registros(m, "LANCAMENTO")).filter((l) => l.origem?.tipo === "ESTORNO").length, 0);

  const hist = await m.nucleo.consultarHistorico(m.c, { registroTipo: "MOVIMENTACAO", registroId: mov.id });
  const evento = hist.find((h) => h.evento === "ESTORNO");
  assert.ok(evento, "histórico da entrada registra o estorno");
  assert.deepEqual([evento.usuarioId, evento.justificativa, evento.antes.situacao, evento.depois.situacao], [USUARIO, MOTIVO, "VALIDA", "ESTORNADA"]);
  const histPag = await m.nucleo.consultarHistorico(m.c, { registroTipo: "PAGAMENTO_VENDA", registroId: m.pagDinheiro.id });
  assert.ok(histPag.some((h) => h.evento === "ESTORNO" && h.justificativa === MOTIVO), "histórico do pagamento também");

  // O passo seguinte do plano (cancelar a venda) deixa de ser recusado.
  const cancelada = await m.nucleo.cancelarVenda(m.c, { vendaId: m.comDinheiro.id, justificativa: MOTIVO });
  assert.equal(cancelada.venda?.situacao ?? cancelada.situacao, "CANCELADA");
});

test("antes da correção, cancelar a venda com dinheiro em conta continua recusado (a rota não muda a regra)", async () => {
  const m = await cenario();
  await rejeita(m.nucleo.cancelarVenda(m.c, { vendaId: m.comDinheiro.id, justificativa: MOTIVO }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
});

test("operação repetida é idempotente: devolve o mesmo estorno, sem criar outro nem mexer no caixa de novo", async () => {
  const m = await cenario();
  const a = await corrigir(m, m.comDinheiro, m.pagDinheiro);
  const antes = await foto(m);
  const b = await ESCRITAS[ROTA].fazer(m.nucleo, m.c, { venda: m.comDinheiro.id, pagamento: m.pagDinheiro.id, justificativa: MOTIVO });
  assert.equal(b.repetido, true);
  assert.equal(b.estorno.id, a.estorno.id);
  assert.deepEqual(await foto(m), antes);
  assert.equal((await registros(m, "ESTORNO")).length, 1);
});

test("pagamento já estornado por outro motivo (devolução) não é 'corrigido' de novo", async () => {
  const m = await cenario();
  await m.nucleo.estornarPagamentoDeVenda(m.c, { pagamentoId: m.pagDinheiro.id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução sintética ao cliente." });
  const antes = await foto(m);
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(await foto(m), antes);
});

test("pagamento parcialmente estornado é recusado (a correção é sempre total)", async () => {
  const m = await cenario();
  await m.nucleo.estornarPagamentoDeVenda(m.c, { pagamentoId: m.pagDinheiro.id, valorCentavos: 500, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução parcial sintética." });
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro), CODIGO.OPERACAO_INVALIDA);
});

test("entrada já conciliada é recusada por esta rota e nada muda", async () => {
  const m = await cenario();
  const [mov] = await registros(m, "MOVIMENTACAO");
  const titulo = (await m.nucleo.registrarRecebivel(m.c, { processador: "STONE", brutoCentavos: 1500, competencia: "2026-09", fonte: { sistema: "STONE", idExterno: "CE-REC" } })).recebivel;
  const cand = await m.nucleo.criarCorrespondenciaCandidata(m.c, { ladoA: [{ tipo: "MOVIMENTACAO", id: mov.id, valorCentavos: 1500 }], ladoB: [{ tipo: "RECEBIVEL", id: titulo.id, valorCentavos: 1500 }], justificativa: "Conciliação sintética." });
  await m.nucleo.confirmarConciliacao(m.c, { correspondenciaId: cand.id });
  assert.equal((await registros(m, "MOVIMENTACAO"))[0].situacaoConciliacao, "CONCILIADA");
  const antes = await foto(m);
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  assert.deepEqual(await foto(m), antes);
});

test("venda inexistente, pagamento de outra venda e pagamento com repasse de processador são recusados", async () => {
  const m = await cenario();
  await rejeita(corrigir(m, { id: "aaaaaaaa-0000-4000-8000-00000000ffff" }, m.pagDinheiro), CODIGO.NAO_ENCONTRADO);
  const outra = await m.vender([{ forma: "DINHEIRO", valorCentavos: 900, contaId: m.caixa.id }], 900);
  await rejeita(corrigir(m, outra, m.pagDinheiro), CODIGO.OPERACAO_INVALIDA);
  const cartao = await m.vender([{ forma: "DEBITO", valorCentavos: 2000, processador: "STONE" }], 2000);
  const pagCartao = (await registros(m, "PAGAMENTO_VENDA")).find((p) => p.vendaId === cartao.id);
  await rejeita(corrigir(m, cartao, pagCartao), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await registros(m, "ESTORNO")).length, 0);
});

test("pagamento de outra unidade: não é encontrado no escopo de quem pede", async () => {
  const m = await cenario();
  const outraUnidade = ctx(ORG_A, UNI_A2);
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro, {}, outraUnidade), CODIGO.NAO_ENCONTRADO);
  assert.equal((await registros(m, "MOVIMENTACAO"))[0].situacao, "VALIDA");
});

test("sem a permissão CORRIGIR, ou sem CANCELAR, é recusado antes de qualquer gravação", async () => {
  const m = await cenario();
  const semCorrigir = ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== ACAO.CORRIGIR));
  const semCancelar = ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== ACAO.CANCELAR));
  const soVer = ctx(ORG_A, UNI_A, [ACAO.VER]);
  for (const x of [semCorrigir, semCancelar, soVer]) await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro, {}, x), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await registros(m, "ESTORNO")).length, 0);
});

test("justificativa ausente/curta e campos fora do contrato (valor, conta, motivo) são recusados", async () => {
  const m = await cenario();
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro, { justificativa: undefined }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro, { justificativa: "" }), CODIGO.ENTRADA_INVALIDA);
  for (const extra of [{ valorCentavos: 100 }, { contaId: m.caixa.id }, { motivo: "DEVOLUCAO_AO_CLIENTE" }]) {
    await rejeita(corrigir(m, m.comDinheiro, m.pagDinheiro, extra), CODIGO.ENTRADA_INVALIDA);
  }
  assert.deepEqual(ESCRITAS[ROTA].campos, ["venda", "pagamento", "justificativa"], "a rota HTTP aceita só venda, pagamento e justificativa");
  assert.equal((await registros(m, "ESTORNO")).length, 0);
});

test("falha intermediária: se a gravação do estorno falhar, a transação inteira é desfeita (caixa, pagamento e venda intactos)", async () => {
  const base = montar();
  let falhar = false;
  const repo = {
    ...base.repositorio,
    transacao: (fn, opcoes) => base.repositorio.transacao((tx) => fn(new Proxy(tx, {
      get: (alvo, nome) => (nome === "inserir" ? (tipo, reg) => { if (falhar && tipo === "ESTORNO") throw new Error("falha sintética no meio do estorno"); return alvo.inserir(tipo, reg); } : typeof alvo[nome] === "function" ? alvo[nome].bind(alvo) : alvo[nome]),
    })), opcoes),
  };
  const m = await cenario({ repositorio: repo });
  const antes = await foto(m);
  falhar = true;
  await assert.rejects(corrigir(m, m.comDinheiro, m.pagDinheiro), /falha sintética/);
  falhar = false;
  assert.deepEqual(await foto(m), antes);
  const r = await corrigir(m, m.comDinheiro, m.pagDinheiro);
  assert.equal(r.repetido, false, "depois da falha, a correção ainda pode ser feita uma única vez");
});

test("integridade do caixa: só a entrada corrigida sai do saldo; outras entradas da mesma conta não mudam", async () => {
  const m = await cenario();
  const outra = await m.vender([{ forma: "DINHEIRO", valorCentavos: 700, contaId: m.caixa.id }], 700);
  await corrigir(m, m.comDinheiro, m.pagDinheiro);
  const movs = await registros(m, "MOVIMENTACAO");
  const validas = movs.filter((x) => x.situacao === "VALIDA");
  assert.equal(movs.length, 2, "nenhuma entrada apagada");
  assert.deepEqual(validas.map((x) => x.valorCentavos), [700]);
  assert.equal((await registros(m, "VENDA")).find((v) => v.id === outra.id).pagoCentavos, 700);
});
