// Aba CONEXÃO — reconciliação de efeito INCERTO (migration 099). Só regressão de contrato/comportamento: o visual aprovado não muda.
// O operador apenas DISPARA a verificação; o backend decide. Nada de sucesso manual, token ou operação editável.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlConexao, htmlBlocoReconciliacao, precisaReconciliar } from "../src/central/centralConexaoUi.js";
import { criarControleConexao } from "../src/central/centralConexao.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const TOKEN = "3f2c9a10-aaaa-4bbb-8ccc-0123456789ab";

const est = (o = {}) => ({
  estado: "CONNECTED", rotulo: "Conectado", conectado: true, reconectando: false, semSinal: false,
  identidade: { status: "CONFIRMADA", ambiente: "TESTE", ambienteRotulo: "Ambiente de teste", nomeOperacional: null, agenteCrescer: false, confirmadoEm: iso(60) },
  conta: { nome: "Crescer Teste", iniciais: "CT", fotoUrl: null, telefoneMascarado: "********21", tipoConta: "DESCONHECIDO", tipoContaRotulo: "Tipo não identificado", descricao: "" },
  saude: { id: "saudavel", rotulo: "Saudável", ultimoSinalEm: iso(1), conectadoEm: iso(60) },
  tecnico: { gateway: "Respondendo", heartbeatEm: iso(1), sessaoValida: true, socket: "Aberto", ultimaConexaoEm: iso(60), ultimaDesconexaoEm: null, motivoUltimaDesconexao: null },
  permissoes: { gerenciar: true }, operacao: null, reconciliacao: null, ...o,
});
const incerto = (o = {}) => ({ reconciliacaoNecessaria: true, acao: "DESCONECTAR", incertoDesde: iso(12), ultimaVerificacaoEm: iso(3), ultimoResultado: "AINDA_INCERTO:gateway_indisponivel", verificacoes: 2, ...o });
const comIncerto = (o = {}) => est({ reconciliacao: incerto(), operacao: { id: "op-1", tipo: "TROCAR", ...incerto(), efeitoAcao: "DESCONECTAR", efeitoEstado: "INCERTO", podeReconciliar: true }, ...o });

describe("observação do estado INCERTO", () => {
  test("sem incerteza: nenhum bloco é desenhado (visual aprovado intacto)", () => {
    assert.equal(htmlBlocoReconciliacao(est()), "");
    assert.doesNotMatch(htmlConexao(est(), { agora: AGORA }), /data-cc-reconciliacao/);
    assert.equal(precisaReconciliar(est()), false);
  });
  test("reconciliacaoNecessaria: aviso elegante com operação, desde quando, último resultado e última verificação", () => {
    const h = htmlConexao(comIncerto(), { agora: AGORA });
    assert.match(h, /data-cc-reconciliacao/);
    assert.match(h, /Não foi possível confirmar automaticamente o resultado da última operação/);
    assert.match(h, /Desconectar a conta/); assert.match(h, /Sem confirmação desde/); assert.match(h, /há 12 min/);
    assert.match(h, /Gateway sem resposta/); assert.match(h, /Última verificação/); assert.match(h, /há 3 min/);
  });
  test("o bloco vem do contrato de leitura (reconciliacao) mesmo sem operacao, que é só de quem gerencia", () => {
    const h = htmlConexao(est({ permissoes: { gerenciar: false }, operacao: null, reconciliacao: incerto() }), { agora: AGORA });
    assert.match(h, /data-cc-reconciliacao/);
  });
});

describe("permissão", () => {
  test("com permissão: botão 'Verificar estado da conexão' que dispara só a ação reconciliar", () => {
    const h = htmlBlocoReconciliacao(comIncerto(), { agora: AGORA });
    assert.match(h, /data-cc-conexao="reconciliar"[^>]*>Verificar estado da conexão</);
    assert.equal((h.match(/<button/g) ?? []).length, 1);
  });
  test("somente leitura: mostra o estado, nenhum botão e orienta procurar um administrador autorizado", () => {
    const h = htmlBlocoReconciliacao(comIncerto({ permissoes: { gerenciar: false }, operacao: null }), { agora: AGORA });
    assert.match(h, /Um administrador autorizado precisa verificar o estado da conexão/);
    assert.doesNotMatch(h, /<button/); assert.doesNotMatch(h, /data-cc-conexao/);
  });
  test("nenhum controle para marcar sucesso, forçar aborto, escolher resultado, editar token ou operação", () => {
    const h = htmlConexao(comIncerto(), { agora: AGORA });
    const bloco = h.slice(h.indexOf("data-cc-reconciliacao"));
    assert.doesNotMatch(bloco.slice(0, bloco.indexOf("</section>")), /<input|<select|<textarea|contenteditable|data-cc-valor/);
    assert.doesNotMatch(bloco.slice(0, bloco.indexOf("</section>")), /forçar|marcar como|sucesso manual/i);
  });
});

describe("estados do botão e mensagens", () => {
  test("verificando: botão desabilitado com aria-busy", () => {
    const h = htmlBlocoReconciliacao(comIncerto(), { agora: AGORA, verificacao: { fase: "verificando" } });
    assert.match(h, /disabled aria-busy="true">Verificando…</);
  });
  test("AINDA_INCERTO é neutro (não é falha da aplicação) e informa que dá para verificar depois", () => {
    const h = htmlBlocoReconciliacao(comIncerto(), { agora: AGORA, verificacao: { fase: "resultado", decisao: "AINDA_INCERTO" } });
    assert.match(h, /Ainda não há evidência suficiente/); assert.match(h, /verificar novamente mais tarde/);
    assert.match(h, /cc-recon-resultado--neutro/); assert.doesNotMatch(h, /cc-recon-resultado--erro/);
  });
  test("CONCLUIDO, ABORTADO e JA_RESOLVIDO mostram o resultado mesmo depois que a pendência some", () => {
    for (const [decisao, rx] of [["CONCLUIDO", /confirmada como executada/], ["ABORTADO", /confirmada como não executada/], ["JA_RESOLVIDO", /já foi resolvida/]]) {
      const h = htmlBlocoReconciliacao(est(), { agora: AGORA, verificacao: { fase: "resultado", decisao } });
      assert.match(h, rx, decisao); assert.match(h, new RegExp(`data-cc-recon-resultado="${decisao}"`)); assert.doesNotMatch(h, /<button/);
    }
  });
  test("erro: mensagem clara e o botão continua disponível para nova tentativa", () => {
    const h = htmlBlocoReconciliacao(comIncerto(), { agora: AGORA, verificacao: { fase: "erro" } });
    assert.match(h, /Não foi possível verificar agora/); assert.match(h, /cc-recon-resultado--erro/); assert.match(h, /data-cc-conexao="reconciliar"/);
  });
  test("decisão desconhecida do servidor não vira texto cru", () => {
    assert.equal(htmlBlocoReconciliacao(est(), { agora: AGORA, verificacao: { fase: "resultado", decisao: "<img onerror=x>" } }), "");
  });
});

describe("segredo", () => {
  test("nenhum token, id de operação ou valor cru aparece no HTML; resultados desconhecidos são descartados", () => {
    const c = comIncerto();
    c.operacao.efeitoToken = TOKEN; c.operacao.efeito_token = TOKEN;
    c.reconciliacao.ultimoResultado = `DECISAO_FALSA:${TOKEN}`;
    const h = htmlConexao(c, { agora: AGORA });
    assert.equal(h.includes(TOKEN), false); assert.equal(h.includes("op-1"), false); assert.doesNotMatch(h, /efeito_token|efeitoToken/);
    const ok = htmlConexao(comIncerto({ reconciliacao: incerto({ ultimoResultado: "AINDA_INCERTO:<script>x</script>" }) }), { agora: AGORA });
    assert.doesNotMatch(ok, /<script>/);
  });
});

// --- controlador: request correto, um clique = uma requisição, sem polling ------------------------------------------------------------------
function montar({ estado, resposta, falha } = {}) {
  const chamadas = []; const timers = [];
  const container = { innerHTML: "", querySelector: () => null };
  const api = {
    conexaoEstado: async () => estado ?? comIncerto(),
    conexaoReconciliar: async (...a) => { chamadas.push(["reconciliar", a]); if (falha) throw falha; return resposta; },
    conexaoCancelar: async () => est(),
  };
  const topo = [];
  const ctl = criarControleConexao({
    api, host: { querySelector: () => null }, doc: { visibilityState: "visible", activeElement: null },
    janela: { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; } },
    agora: () => AGORA.getTime(), aoEstado: (r) => topo.push(r),
  });
  ctl._estado.estado = estado ?? comIncerto();
  ctl.pintar(container);
  const clicar = (acao) => ctl.aoClicar({ target: { closest: (s) => (s === "[data-cc-conexao]" ? { dataset: { ccConexao: acao } } : null), matches: () => false } });
  return { ctl, container, chamadas, clicar, timers };
}
const pausa = () => new Promise((r) => setImmediate(r));

describe("controlador: botão Verificar estado da conexão", () => {
  test("request correto (sem corpo editável) e resultado renderizado; estado do servidor é a fonte", async () => {
    const m = montar({ resposta: { decisao: "CONCLUIDO", motivo: "sessao_encerrada", estado: est({ estado: "DISCONNECTED", conectado: false, conta: null }) } });
    assert.match(m.container.innerHTML, /Verificar estado da conexão/);
    assert.equal(m.clicar("reconciliar"), true);
    assert.match(m.container.innerHTML, /Verificando…/);
    await pausa(); await pausa();
    assert.deepEqual(m.chamadas, [["reconciliar", []]]);
    assert.match(m.container.innerHTML, /data-cc-recon-resultado="CONCLUIDO"/);
    assert.doesNotMatch(m.container.innerHTML, /Verificar estado da conexão/);
  });
  test("AINDA_INCERTO: mantém o aviso, o botão volta e nenhum polling de reconciliação é agendado", async () => {
    const m = montar({ resposta: { decisao: "AINDA_INCERTO", motivo: "gateway_indisponivel", estado: comIncerto() } });
    m.clicar("reconciliar"); await pausa(); await pausa();
    assert.match(m.container.innerHTML, /Ainda não há evidência suficiente/); assert.match(m.container.innerHTML, /Verificar estado da conexão/);
    assert.equal(m.chamadas.length, 1);
    const ativos = m.timers.filter(Boolean);
    assert.equal(ativos.length, 1, "só o ciclo de leitura de estado já existente");
    assert.equal(ativos[0][1], 10000, "nenhum timer novo de reconciliação");
  });
  test("duplo clique enquanto verifica: uma única requisição", async () => {
    const m = montar({ resposta: { decisao: "ABORTADO", motivo: "sessao_original_ativa", estado: est() } });
    m.clicar("reconciliar"); m.clicar("reconciliar"); await pausa(); await pausa();
    assert.equal(m.chamadas.length, 1);
    assert.match(m.container.innerHTML, /confirmada como não executada/);
  });
  test("erro de rede/servidor: mensagem de erro e possibilidade de tentar de novo", async () => {
    const m = montar({ falha: Object.assign(new Error("HTTP 500"), { status: 500 }) });
    m.clicar("reconciliar"); await pausa(); await pausa();
    assert.match(m.container.innerHTML, /Não foi possível verificar agora/); assert.match(m.container.innerHTML, /data-cc-conexao="reconciliar"/);
  });
  test("sem permissão o clique nem chega ao backend", async () => {
    const m = montar({ estado: comIncerto({ permissoes: { gerenciar: false }, operacao: null }) });
    assert.doesNotMatch(m.container.innerHTML, /data-cc-conexao="reconciliar"/);
    m.clicar("reconciliar"); await pausa();
    assert.equal(m.chamadas.length, 0);
  });
});
