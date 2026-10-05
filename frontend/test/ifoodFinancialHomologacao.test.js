// Homologação Financial do iFood — lado da interface.
//   * polling da Reconciliation On Demand (backoff, 429, 5xx, tempo total, cancelamento);
//   * dados mínimos de Sales (forma de pagamento, responsável, comissões, taxas);
//   * fiação da aba Reconciliation (Baixar CSV, resumo do repasse, retomada, requestId secundário).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  criarAcompanhamentoReconciliacao, proximoAtraso, erroTransitorio, POLLING_RECONCILIACAO,
} from "../src/ifoodReconciliacaoPolling.js";
import {
  rotuloMetodoPagamento, rotuloResponsavelPagamento, rotuloTipoPagamento, resumirPagamentosVenda,
  classificarLancamentosVenda, rotuloLancamentoVenda, FASE_ON_DEMAND_ROTULO,
} from "../src/ifoodEstado.js";

const SRC = (f) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", f), "utf8");
const IFOOD = SRC("ifood.js");

// Relógio e sono falsos: o teste controla o tempo, nada espera de verdade.
function relogio() {
  let t = 0;
  const esperas = [];
  return {
    esperas,
    agora: () => t,
    dormir: async (ms, sinal) => { esperas.push(ms); if (!sinal?.aborted) t += ms; },
  };
}
const erro = (codigo, message = codigo) => Object.assign(new Error(message), { codigo });

describe("polling da Reconciliation On Demand", () => {
  test("sucesso direto: 1 consulta imediata, sem esperar", async () => {
    const r = relogio();
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => ({ status: "processed", finalizado: true }), ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "concluido");
    assert.equal(fim.tentativas, 1);
    assert.deepEqual(r.esperas, []);
  });

  test("processing -> concluído, com backoff exponencial 2s, 4s, 8s, 16s, 30s, 30s (teto)", async () => {
    const r = relogio();
    const seq = ["created", "enqueue", "enqueue", "enqueue", "enqueue", "enqueue", "processed"];
    const eventos = [];
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => ({ status: seq.shift() }), aoAtualizar: (e) => eventos.push(e), ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "concluido");
    assert.equal(fim.tentativas, 7);
    assert.deepEqual(r.esperas, [2000, 4000, 8000, 16000, 30000, 30000]);
    assert.ok(eventos.every((e) => e.fase === "processando"));
    assert.equal(eventos[0].proximaEmMs, 2000);
  });

  test("status 'error' do iFood encerra como 'falhou' (sem insistir)", async () => {
    const r = relogio();
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => ({ status: "error", mensagemErro: "No financial entries found." }), ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "falhou");
    assert.equal(fim.resultado.mensagemErro, "No financial entries found.");
  });

  test("429: continua, e a espera da rodada dobra (além do backoff normal)", async () => {
    const r = relogio();
    let n = 0;
    const a = criarAcompanhamentoReconciliacao({
      consultar: async () => { n += 1; if (n === 1) throw erro("IFOOD_RATE_LIMITED"); return { status: "processed" }; },
      ...r,
    });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "concluido");
    assert.deepEqual(r.esperas, [4000]);
  });

  test("5xx/rede intermitente: tenta de novo e conclui", async () => {
    const r = relogio();
    const respostas = [() => { throw erro("IFOOD_INDISPONIVEL"); }, () => { throw new Error("Failed to fetch"); }, () => ({ status: "processed" })];
    const fases = [];
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => respostas.shift()(), aoAtualizar: (e) => fases.push(e.fase), ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "concluido");
    assert.deepEqual(fases, ["instavel", "instavel"]);
  });

  test("falhas transitórias seguidas acima do teto encerram com erro", async () => {
    const r = relogio();
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => { throw erro("IFOOD_INDISPONIVEL", "iFood fora"); }, ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "erro");
    assert.equal(fim.tentativas, POLLING_RECONCILIACAO.maxErrosTransitoriosSeguidos);
    assert.equal(fim.erro.message, "iFood fora");
  });

  test("erro definitivo (solicitação desconhecida/expirada) encerra na hora", async () => {
    const r = relogio();
    for (const codigo of ["IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA", "IFOOD_RECONCILIATION_INVALIDA", "IFOOD_MERCHANT_SEM_PERMISSAO", "IFOOD_TOKEN_EXPIRADO"]) {
      const a = criarAcompanhamentoReconciliacao({ consultar: async () => { throw erro(codigo); }, ...r });
      const fim = await a.iniciar("req");
      assert.equal(fim.estado, "erro", codigo);
      assert.equal(fim.tentativas, 1, codigo);
    }
    assert.deepEqual(r.esperas, []);
  });

  test("timeout total: para com 'tempo_esgotado' sem estourar o teto de tempo", async () => {
    const r = relogio();
    const a = criarAcompanhamentoReconciliacao({ consultar: async () => ({ status: "enqueue" }), ...r });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "tempo_esgotado");
    assert.ok(r.agora() <= POLLING_RECONCILIACAO.tempoTotalMaxMs);
    assert.ok(fim.tentativas > 5 && fim.tentativas < 40, `não é agressivo: ${fim.tentativas} consultas em 10 min`);
  });

  test("cancelamento (sair da tela / trocar de unidade) encerra sem novas consultas", async () => {
    let consultas = 0;
    let a;
    const dormir = async () => { a.cancelar(); };
    a = criarAcompanhamentoReconciliacao({ consultar: async () => { consultas += 1; return { status: "enqueue" }; }, dormir, agora: () => 0 });
    const fim = await a.iniciar("req");
    assert.equal(fim.estado, "cancelado");
    assert.equal(consultas, 1);
    assert.equal(a.ativo, false);
  });

  test("nova solicitação substitui o acompanhamento anterior (o antigo vira 'cancelado')", async () => {
    let liberar;
    const pendente = new Promise((r) => { liberar = r; });
    const a = criarAcompanhamentoReconciliacao({
      consultar: async (id) => (id === "velho" ? (await pendente, { status: "enqueue" }) : { status: "processed" }),
      dormir: async () => {}, agora: () => 0,
    });
    const velho = a.iniciar("velho");
    const novo = await a.iniciar("novo");
    liberar();
    assert.equal(novo.estado, "concluido");
    assert.equal((await velho).estado, "cancelado");
  });

  test("helpers: proximoAtraso respeita o teto; sem código = transitório", () => {
    assert.equal(proximoAtraso(2000), 4000);
    assert.equal(proximoAtraso(20000), 30000);
    assert.equal(erroTransitorio(new Error("rede")), true);
    assert.equal(erroTransitorio(erro("IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA")), false);
  });

  test("todas as fases têm rótulo em português", () => {
    for (const f of ["solicitando", "processando", "instavel", "concluido", "falhou", "erro", "tempo_esgotado", "cancelado"]) {
      assert.ok(FASE_ON_DEMAND_ROTULO[f], f);
    }
  });
});

describe("Sales — dados mínimos da homologação", () => {
  test("forma de pagamento: cartão, dinheiro, Pix, vale; desconhecido aparece cru", () => {
    assert.equal(rotuloMetodoPagamento("CREDIT"), "Cartão de crédito");
    assert.equal(rotuloMetodoPagamento("DEBIT"), "Cartão de débito");
    assert.equal(rotuloMetodoPagamento("CASH"), "Dinheiro");
    assert.equal(rotuloMetodoPagamento("PIX"), "Pix");
    assert.equal(rotuloMetodoPagamento("MEAL_VOUCHER"), "Vale-refeição");
    assert.equal(rotuloMetodoPagamento("NOVO_METODO"), "NOVO_METODO");
    assert.equal(rotuloMetodoPagamento(null), "Não informado");
  });

  test("responsável pelo pagamento: iFood x Loja; ausente = Não informado", () => {
    assert.equal(rotuloResponsavelPagamento("IFOOD"), "iFood");
    assert.equal(rotuloResponsavelPagamento("MERCHANT"), "Loja");
    assert.equal(rotuloResponsavelPagamento(undefined), "Não informado");
    assert.equal(rotuloTipoPagamento("ONLINE"), "Online (no app)");
    assert.equal(rotuloTipoPagamento("OFFLINE"), "Na entrega");
  });

  test("resumo para a tabela: um método, vários métodos, nenhum", () => {
    assert.deepEqual(resumirPagamentosVenda([{ metodo: "CREDIT", responsavel: "IFOOD" }]), { metodo: "Cartão de crédito", responsavel: "iFood" });
    assert.deepEqual(resumirPagamentosVenda([{ metodo: "CASH", responsavel: "MERCHANT" }, { metodo: "PIX", responsavel: "IFOOD" }]), { metodo: "Dinheiro + Pix", responsavel: "Loja + iFood" });
    assert.deepEqual(resumirPagamentosVenda([]), { metodo: "Não informado", responsavel: "Não informado" });
    assert.deepEqual(resumirPagamentosVenda(undefined), { metodo: "Não informado", responsavel: "Não informado" });
  });

  test("comissões e taxas: múltiplas taxas, total em centavos, demais lançamentos separados", () => {
    const c = classificarLancamentosVenda({ lancamentos: [
      { nome: "ORDER_PAYMENT", valor: 50 },
      { nome: "ORDER_COMMISSION", valor: -6.1 },
      { nome: "SERVICE_FEE", valor: -0.99 },
      { nome: "DELIVERY_FEE_IFOOD", valor: -0.2 },
      { nome: "IFOOD_SUBSIDY", valor: 5 },
    ] });
    assert.deepEqual(c.comissoes.map((l) => l.rotulo), ["Comissão do iFood"]);
    assert.deepEqual(c.taxas.map((l) => l.nome), ["SERVICE_FEE", "DELIVERY_FEE_IFOOD"]);
    assert.deepEqual(c.outros.map((l) => l.nome), ["ORDER_PAYMENT", "IFOOD_SUBSIDY"]);
    assert.equal(c.totalComissoes, -6.1);
    assert.equal(c.totalTaxas, -1.19);
  });

  test("taxas zero são exibidas como R$ 0 (não somem); sem taxa nenhuma = null", () => {
    const zero = classificarLancamentosVenda({ lancamentos: [{ nome: "SERVICE_FEE", valor: 0 }] });
    assert.equal(zero.totalTaxas, 0);
    assert.equal(zero.taxas.length, 1);
    const sem = classificarLancamentosVenda({ lancamentos: [{ nome: "ORDER_PAYMENT", valor: 10 }] });
    assert.equal(sem.totalTaxas, null);
    assert.equal(sem.totalComissoes, null);
  });

  test("dados ausentes: resumoFinanceiro nulo ou sem lançamentos", () => {
    for (const rf of [null, undefined, {}, { lancamentos: [] }]) {
      const c = classificarLancamentosVenda(rf);
      assert.equal(c.informado, false);
      assert.deepEqual([c.comissoes, c.taxas, c.outros], [[], [], []]);
    }
    assert.equal(classificarLancamentosVenda({ lancamentos: [{ nome: "ORDER_COMMISSION", valor: null }] }).comissoes[0].valor, null);
  });

  test("rótulos de lançamento: nomes oficiais traduzidos, desconhecido cru", () => {
    assert.equal(rotuloLancamentoVenda("ORDER_COMMISSION"), "Comissão do iFood");
    assert.equal(rotuloLancamentoVenda("XPTO"), "XPTO");
  });

  test("tabela de Sales mostra Pagamento e Comissões e taxas; detalhe tem as seções exigidas", () => {
    assert.match(IFOOD, /<th>Pagamento<\/th>/);
    assert.match(IFOOD, /<th class="num">Comissões e taxas<\/th>/);
    assert.match(IFOOD, /colspan="8" class="ifood-vazio">\$\{s\.carregando/);
    for (const secao of ['titulo: "Venda"', 'titulo: "Pagamento"', 'titulo: "Comissões"', 'titulo: "Taxas"']) assert.ok(IFOOD.includes(secao), secao);
    assert.match(IFOOD, /"Responsável pelo pagamento"/);
    assert.match(IFOOD, /abrirDetalheItem\(`Venda \$\{venda\.shortId \?\? venda\.id \?\? ""\}`, \[\], venda, secoesDetalheVenda\(venda\)\)/);
  });
});

describe("aba Reconciliation — fiação de homologação", () => {
  test("'Baixar CSV' só aparece com arquivo disponível e chama o proxy do backend", () => {
    assert.match(IFOOD, /\$\{rOd\?\.arquivoDisponivel \? `[\s\S]*?id="ifrec-od-baixar"/);
    assert.match(IFOOD, /api\.ifoodFinancialReconciliationOnDemandArquivo\(od\.requestId\)/);
    assert.match(IFOOD, /el\("#ifrec-od-baixar"\)\?\.addEventListener\("click", baixarCsvReconciliationOnDemand\)/);
    assert.doesNotMatch(IFOOD, /downloadPath/, "o frontend nunca lida com a URL assinada");
  });

  test("acompanhamento automático substitui o 'Verificar status' manual", () => {
    assert.doesNotMatch(IFOOD, /sem atualização automática/);
    assert.match(IFOOD, /criarAcompanhamentoReconciliacao\(/);
    assert.match(IFOOD, /if \(requestId\) acompanharReconciliationOnDemand\(requestId\)/);
    assert.match(IFOOD, /Verificar agora/);
  });

  test("polling para ao sair da tela, ao trocar de unidade e ao reabrir o iFood", () => {
    const reset = IFOOD.slice(IFOOD.indexOf("registrarResetDeContexto(() => {"), IFOOD.indexOf("});", IFOOD.indexOf("registrarResetDeContexto(() => {")));
    assert.match(reset, /pararAcompanhamentoOnDemand\(\)/);
    assert.match(IFOOD, /function fecharFinanceiro\(\) \{\s*pararAcompanhamentoOnDemand\(\);/);
    assert.match(IFOOD, /export function renderIfood\(\) \{\s*pararContador\(\);\s*pararAcompanhamentoOnDemand\(\);/);
  });

  test("reload/reentrada: retoma a solicitação vigente uma única vez", () => {
    assert.match(IFOOD, /if \(!rec\.onDemand\.retomadaVerificada\) retomarReconciliationOnDemand\(\)/);
    assert.match(IFOOD, /api\.ifoodFinancialReconciliationOnDemandAtual\(od\.competencia\)/);
  });

  test("duplo clique em 'Solicitar geração' não dispara duas solicitações", () => {
    assert.match(IFOOD, /if \(!od \|\| od\.carregando\) return; \/\/ duplo clique/);
  });

  test("resumo do impacto no repasse nas duas seções; requestId só como dado técnico secundário", () => {
    assert.equal((IFOOD.match(/blocoImpactoRepasse\(r(Od)?\.arquivo\.resumoRepasse\)/g) ?? []).length, 2);
    assert.match(IFOOD, /Valor que compõe o repasse/);
    assert.match(IFOOD, /Total bruto do arquivo/);
    assert.match(IFOOD, /<p class="ifin-tecnico">Identificador da solicitação no iFood/);
    assert.doesNotMatch(IFOOD, /<span>requestId<\/span>/);
  });
});
