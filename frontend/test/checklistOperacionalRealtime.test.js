// Checklist Operacional — tempo real (Checkpoint 2).
//
// 1. Sincronizador (relógio falso, rede controlada): uma consulta por vez, rajada vira uma consulta, resposta
//    antiga não sobrescreve nova, parar() descarta o que estava em voo, polling de segurança com recuo.
// 2. Cadeia REAL RealtimeManager → realtimeBus → filtro do Checklist (cliente Supabase falso, mesmo padrão de
//    realtimeManager.test.js): aviso da unidade consulta; de outra unidade/empresa não; reconexão resincroniza;
//    troca de contexto encerra; status do canal vira o selo "tempo real".
//
// Rodar: node --test frontend/test/checklistOperacionalRealtime.test.js

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.document = new EventTarget();
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { state } = await import("../src/state.js");
const { resetarEscopoDeContexto } = await import("../src/contextoEscopo.js");
const M = await import("../src/realtime/realtimeManager.js");
const bus = await import("../src/realtime/realtimeBus.js");
const { EVENTOS_IFOOD_PEDIDOS, RESINCRONIZACAO } = await import("../src/realtime/realtimeEvents.js");
const S = await import("../src/checklistOperacionalSincronizacao.js");
const { adaptarResumo } = await import("../src/checklistOperacionalDados.js");
const { METAS_EXEMPLO } = await import("../src/checklistOperacionalModelo.js");
const { montarTela } = await import("../src/checklistOperacionalVisual.js");

const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const EVENTO = EVENTOS_IFOOD_PEDIDOS.ESTADO_ATUALIZADO;
const ORG = "org-1"; const UN = "uni-1";

// ---------------------------------------------------------------------------
// Relógio falso + rede controlada
// ---------------------------------------------------------------------------
function criarRelogio() {
  let agora = 0; let id = 0; const tarefas = new Map();
  return {
    setTimeout(fn, ms) { id += 1; tarefas.set(id, { t: agora + ms, fn }); return id; },
    clearTimeout(i) { tarefas.delete(i); },
    pendentes: () => tarefas.size,
    async avancar(ms) {
      const alvo = agora + ms;
      for (;;) {
        const proxima = [...tarefas.entries()].filter(([, x]) => x.t <= alvo).sort((a, b) => a[1].t - b[1].t)[0];
        if (!proxima) break;
        tarefas.delete(proxima[0]); agora = proxima[1].t; proxima[1].fn();
        await liberar();
      }
      agora = alvo; await liberar();
    },
  };
}
const liberar = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

/** Rede: cada consulta fica pendente até o teste responder (ou responde sozinha). */
function criarRede({ automatica = true } = {}) {
  const chamadas = []; let n = 0;
  const buscar = () => new Promise((resolve, reject) => {
    n += 1;
    const servidorEm = new Date(Date.UTC(2026, 9, 9, 15, 0, n)).toISOString();
    const c = { n, resolve: (extra = {}) => resolve({ data: { servidorEm, ...extra } }), reject };
    chamadas.push(c);
    if (automatica) c.resolve();
  });
  return { chamadas, buscar };
}

function montar({ automatica = true, aleatorio = () => 0 } = {}) {
  const relogio = criarRelogio(); const rede = criarRede({ automatica });
  const aplicadas = []; const falhas = [];
  const sinc = S.criarSincronizador({
    buscar: rede.buscar, intervaloMs: 30_000, relogio, aleatorio,
    aplicar: (r) => aplicadas.push(r.data), falhou: (e) => falhas.push(e),
  });
  return { relogio, rede, aplicadas, falhas, sinc };
}

describe("sincronizador", () => {
  test("iniciar consulta já; aviso consulta depois da janela curta (não espera o polling)", async () => {
    const { relogio, rede, sinc } = montar();
    sinc.iniciar(); await liberar();
    assert.equal(rede.chamadas.length, 1);
    sinc.avisar();
    await relogio.avancar(S.JANELA_AVISO_MS - 1);
    assert.equal(rede.chamadas.length, 1);
    await relogio.avancar(1);
    assert.equal(rede.chamadas.length, 2);
  });

  test("rajada de avisos (evento duplicado, vários pedidos) vira UMA consulta", async () => {
    const { relogio, rede, sinc } = montar();
    sinc.iniciar(); await liberar();
    for (let i = 0; i < 10; i += 1) sinc.avisar();
    await relogio.avancar(S.JANELA_AVISO_MS + S.ESPALHAMENTO_MAX_MS);
    assert.equal(rede.chamadas.length, 2);
  });

  test("uma consulta por vez: pedidos no meio viram UMA consulta logo depois (sem cascata)", async () => {
    const { rede, sinc, aplicadas } = montar({ automatica: false });
    sinc.iniciar(); await liberar();
    sinc.agora(); sinc.agora(); sinc.agora();
    assert.equal(rede.chamadas.length, 1, "nunca duas em voo");
    rede.chamadas[0].resolve(); await liberar();
    assert.equal(rede.chamadas.length, 2, "as três viraram uma");
    rede.chamadas[1].resolve(); await liberar();
    assert.equal(rede.chamadas.length, 2);
    assert.equal(aplicadas.length, 2);
  });

  test("resposta com servidorEm ANTERIOR à já aplicada é descartada (nunca volta no tempo)", async () => {
    const { rede, sinc, aplicadas } = montar({ automatica: false });
    sinc.iniciar(); await liberar();
    rede.chamadas[0].resolve({ servidorEm: "2026-10-09T15:00:10.000Z", marca: "nova" }); await liberar();
    sinc.agora(); await liberar();
    rede.chamadas[1].resolve({ servidorEm: "2026-10-09T15:00:05.000Z", marca: "velha" }); await liberar();
    assert.deepEqual(aplicadas.map((a) => a.marca), ["nova"]);
    assert.equal(sinc.estatisticas.descartadas, 1);
  });

  test("parar() (troca de unidade / saiu da tela): resposta em voo não é aplicada e nada mais é agendado", async () => {
    const { relogio, rede, sinc, aplicadas } = montar({ automatica: false });
    sinc.iniciar(); await liberar();
    sinc.parar();
    rede.chamadas[0].resolve(); await liberar();
    assert.equal(aplicadas.length, 0);
    sinc.avisar(); sinc.agora();
    await relogio.avancar(120_000);
    assert.equal(rede.chamadas.length, 1);
    assert.equal(relogio.pendentes(), 0);
  });

  test("polling de segurança continua sem nenhum aviso (Broadcast fora do ar)", async () => {
    const { relogio, rede, sinc } = montar();
    sinc.iniciar(); await liberar();
    await relogio.avancar(30_000);
    await relogio.avancar(30_000);
    await relogio.avancar(30_000);
    assert.equal(rede.chamadas.length, 4);
  });

  test("aviso adianta o polling: o próximo ciclo conta a partir da última consulta", async () => {
    const { relogio, rede, sinc } = montar();
    sinc.iniciar(); await liberar();
    await relogio.avancar(20_000);
    sinc.avisar();
    await relogio.avancar(S.JANELA_AVISO_MS);            // consulta do aviso em t≈20,4 s
    assert.equal(rede.chamadas.length, 2);
    await relogio.avancar(10_000);                         // t≈30,4 s: o polling antigo (t=30 s) foi cancelado
    assert.equal(rede.chamadas.length, 2);
    await relogio.avancar(20_000);                         // t≈50,4 s: 30 s depois da última
    assert.equal(rede.chamadas.length, 3);
  });

  test("falha: recuo 30 → 60 → 120 → 120 s; volta ao normal quando a rede volta", async () => {
    const relogio = criarRelogio();
    let falhando = true; let n = 0; const instantes = []; let t = 0;
    const sinc = S.criarSincronizador({
      relogio, intervaloMs: 30_000, aleatorio: () => 0, aplicar: () => {}, falhou: () => {},
      buscar: () => { n += 1; instantes.push(t); return falhando ? Promise.reject(new Error("rede")) : Promise.resolve({ data: {} }); },
    });
    const andar = async (ms) => { t += ms; await relogio.avancar(ms); };
    sinc.iniciar(); await liberar();
    await andar(30_000); await andar(60_000); await andar(120_000); await andar(120_000);
    assert.deepEqual(instantes, [0, 30_000, 90_000, 210_000, 330_000]);
    falhando = false;
    await andar(120_000);                                  // a 6ª consulta funciona
    await andar(30_000);                                   // e o intervalo volta a 30 s
    assert.equal(n, 7);
    assert.equal(sinc.falhas, 0);
  });

  test("várias TVs da mesma unidade: cada uma consulta UMA vez, espalhadas no tempo, e chegam ao mesmo dado", async () => {
    const tvA = montar({ aleatorio: () => 0 });
    const tvB = montar({ aleatorio: () => 0.99 });
    for (const tv of [tvA, tvB]) { tv.sinc.iniciar(); await liberar(); tv.sinc.avisar(); }
    await tvA.relogio.avancar(S.JANELA_AVISO_MS);
    await tvB.relogio.avancar(S.JANELA_AVISO_MS);
    assert.equal(tvA.rede.chamadas.length, 2);
    assert.equal(tvB.rede.chamadas.length, 1, "a segunda TV ainda espera o espalhamento");
    await tvB.relogio.avancar(S.ESPALHAMENTO_MAX_MS);
    assert.equal(tvB.rede.chamadas.length, 2);
    assert.equal(tvA.aplicadas.length, 2);
    assert.equal(tvB.aplicadas.length, 2);
  });
});

describe("filtro do aviso (organização + unidade do contexto)", () => {
  const ctx = { organizacaoId: ORG, unidadeId: UN };
  test("da minha unidade: sim; de outra unidade ou empresa: não", () => {
    assert.equal(S.avisoDaMinhaUnidade({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN }, ctx), true);
    assert.equal(S.avisoDaMinhaUnidade({ tipo: EVENTO, organizacaoId: ORG, unidadeId: "uni-2" }, ctx), false);
    assert.equal(S.avisoDaMinhaUnidade({ tipo: EVENTO, organizacaoId: "org-2", unidadeId: UN }, ctx), false);
  });
  test("resincronização do canal da unidade: sim; do canal da empresa (sem unidade): não", () => {
    assert.equal(S.avisoDaMinhaUnidade({ tipo: RESINCRONIZACAO, organizacaoId: ORG, unidadeId: UN }, ctx), true);
    assert.equal(S.avisoDaMinhaUnidade({ tipo: RESINCRONIZACAO, organizacaoId: ORG, unidadeId: null }, ctx), false);
  });
  test("sem contexto de unidade: nada é relevante", () => {
    assert.equal(S.avisoDaMinhaUnidade({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN }, { organizacaoId: ORG, unidadeId: null }), false);
  });
});

// ---------------------------------------------------------------------------
// Cadeia real: manager → bus → filtro do Checklist → sincronizador
// ---------------------------------------------------------------------------
function criarClienteFake() {
  const canais = [];
  const cliente = {
    auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
    realtime: { setAuth() {} },
    channel(topico, opts) {
      const handlers = {}; let statusCb = null;
      const canal = {
        topico, opts,
        on(tipo, _f, cb) { handlers[tipo] = cb; return canal; },
        subscribe(cb) { statusCb = cb; canais.push(canal); statusCb("SUBSCRIBED"); return canal; },
        broadcast(payload) { handlers.broadcast?.({ payload }); },
        status(s) { statusCb?.(s); },
      };
      return canal;
    },
    removeChannel() {},
  };
  return { cliente, canais, canal: (t) => canais.find((c) => c.topico === t) };
}

let fake; let tela;
before(() => {
  M._injetarDependenciasParaTeste({
    // Como o backend: os tópicos autorizados são os do contexto ATUAL (realtime.topicos.js).
    obterCliente: async () => fake?.cliente,
    solicitarCredencial: async () => ({ validadeS: 300, topicos: [`empresa:${state.sessao.empresa?.id}`, `unidade:${state.sessao.unidade?.id}`] }),
    obterTokenAuth: async () => "tok", setTimeout: () => 1, clearTimeout: () => {},
  });
  M.iniciar();
});

beforeEach(async () => {
  await M._resetParaTeste();
  bus._resetParaTeste();
  fake = criarClienteFake();
  state.sessao.empresa = { id: ORG };
  state.sessao.unidade = { id: UN };
  state.rota = "checklist-operacional";
  // A "tela": sincronizador + o MESMO filtro que checklistOperacional.js registra.
  tela = montar();
  bus.registrarInteresse({
    eventos: [EVENTO, RESINCRONIZACAO],
    relevante: (ev) => state.rota === "checklist-operacional" && tela.sinc.ativo
      && S.avisoDaMinhaUnidade(ev, { organizacaoId: state.sessao.empresa?.id, unidadeId: state.sessao.unidade?.id }),
    aoReceber: () => tela.sinc.avisar(),
  });
  tela.sinc.iniciar(); await liberar();
  await M.conectarParaContextoAtual();
});

const esperarAviso = () => tela.relogio.avancar(S.JANELA_AVISO_MS + S.ESPALHAMENTO_MAX_MS);

describe("cadeia Realtime → Checklist", () => {
  test("pedido processado (aviso no canal da unidade) gera nova consulta", async () => {
    fake.canal(`unidade:${UN}`).broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN });
    await esperarAviso();
    assert.equal(tela.rede.chamadas.length, 2);
  });

  test("aviso duplicado (mesmo evento entregue duas vezes) gera UMA consulta", async () => {
    const c = fake.canal(`unidade:${UN}`);
    c.broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN });
    c.broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN });
    await esperarAviso();
    assert.equal(tela.rede.chamadas.length, 2);
  });

  test("aviso de OUTRA unidade não atualiza a tela (mesmo chegando por um canal assinado)", async () => {
    fake.canal(`empresa:${ORG}`).broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: "uni-2" });
    fake.canal(`unidade:${UN}`).broadcast({ tipo: EVENTO, organizacaoId: "org-2", unidadeId: UN });
    await esperarAviso();
    assert.equal(tela.rede.chamadas.length, 1);
  });

  test("reconexão do canal da unidade resincroniza: consulta o estado atual", async () => {
    const c = fake.canal(`unidade:${UN}`);
    c.status("CHANNEL_ERROR");
    assert.equal(bus.statusCanal(`unidade:${UN}`), "CHANNEL_ERROR");
    c.status("SUBSCRIBED");                                 // voltou: o manager injeta RESINCRONIZACAO
    await esperarAviso();
    assert.equal(tela.rede.chamadas.length, 2);
    assert.equal(bus.statusCanal(`unidade:${UN}`), "SUBSCRIBED");
  });

  test("troca de unidade: status antigo some e aviso do canal antigo é descartado", async () => {
    const antigo = fake.canal(`unidade:${UN}`);
    tela.sinc.parar();                                      // o que parar() do Checklist faz
    state.sessao.unidade = { id: "uni-2" };
    resetarEscopoDeContexto();                              // funil real de troca de contexto (manager desliga e reconecta)
    await liberar();
    assert.equal(bus.statusCanal(`unidade:${UN}`), null);
    assert.equal(bus.statusCanal("unidade:uni-2"), "SUBSCRIBED", "o canal da unidade nova assume");
    antigo.broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN });
    antigo.status("SUBSCRIBED");
    await esperarAviso();
    assert.equal(tela.rede.chamadas.length, 1, "nada do contexto antigo dispara consulta");
  });

  test("selo 'tempo real' exige avisos ativos no servidor E o canal da unidade assinado", () => {
    const canal = () => bus.statusCanal(`unidade:${UN}`);
    assert.equal(S.textoModoAtualizacao(canal(), 30, true), "tempo real");
    // canal conectado, mas o servidor não emite avisos (flag desligada ou recebimento parado): NÃO é tempo real
    assert.equal(S.textoModoAtualizacao(canal(), 30, false), "atualiza a cada 30 s");
    assert.equal(S.textoModoAtualizacao(canal(), 30, undefined), "atualiza a cada 30 s");
    // avisos ativos, mas o canal caiu: também não
    fake.canal(`unidade:${UN}`).status("TIMED_OUT");
    assert.equal(S.textoModoAtualizacao(canal(), 30, true), "atualiza a cada 30 s");
    assert.equal(S.textoModoAtualizacao(null, 30, true), "atualiza a cada 30 s");
  });

  test("compatível com o Dashboard iFood no mesmo bus: um não dispara o outro", async () => {
    let dashboard = 0;
    bus.registrarInteresse({
      eventos: ["dashboard_ifood.lancamento_criado", RESINCRONIZACAO],
      relevante: () => true,
      aoReceber: (ev) => { if (ev.tipo !== RESINCRONIZACAO) dashboard += 1; },
    });
    const c = fake.canal(`unidade:${UN}`);
    c.broadcast({ tipo: EVENTO, organizacaoId: ORG, unidadeId: UN });
    await esperarAviso();
    assert.equal(dashboard, 0, "aviso do Checklist não chega ao Dashboard");
    assert.equal(tela.rede.chamadas.length, 2);
    c.broadcast({ tipo: "dashboard_ifood.lancamento_criado", organizacaoId: ORG, unidadeId: UN });
    await esperarAviso();
    assert.equal(dashboard, 1);
    assert.equal(tela.rede.chamadas.length, 2, "evento do Dashboard não consulta o Checklist");
  });
});

describe("aviso perdido", () => {
  test("Broadcast perdido (processo encerrou, rede caiu): o polling de segurança traz a mudança no próximo ciclo", async () => {
    const relogio = criarRelogio();
    let versaoNoServidor = 1; let n = 0;
    const aplicadas = [];
    const sinc = S.criarSincronizador({
      relogio, intervaloMs: 30_000, aleatorio: () => 0, falhou: () => {},
      aplicar: (r) => aplicadas.push(r.data.versao),
      buscar: async () => { n += 1; return { data: { servidorEm: new Date(Date.UTC(2026, 9, 9, 15, 0, n)).toISOString(), versao: versaoNoServidor } }; },
    });
    sinc.iniciar(); await liberar();
    versaoNoServidor = 2;                                   // pedido mudou no servidor; o aviso NUNCA chega
    await relogio.avancar(29_999);
    assert.deepEqual(aplicadas, [1]);
    await relogio.avancar(1);
    assert.deepEqual(aplicadas, [1, 2], "no máximo um intervalo depois, a tela está certa");
  });
});

describe("indicação vinda do servidor", () => {
  const base = { servidorEm: "2026-10-09T15:00:00.000Z", integracao: { estado: "ao_vivo" } };
  const ad = (tempoReal) => adaptarResumo({ ...base, tempoReal }, { unidade: { id: UN }, metas: METAS_EXEMPLO, recebidoEmMs: Date.parse(base.servidorEm) });
  test("avisos ativos só com `true` explícito do servidor (flag + recebimento ao vivo)", () => {
    assert.equal(ad({ habilitado: true, avisosAtivos: true }).avisosTempoReal, true);
    assert.equal(ad({ habilitado: true, avisosAtivos: false }).avisosTempoReal, false);
    assert.equal(ad({ habilitado: false, avisosAtivos: false }).avisosTempoReal, false);
    assert.equal(ad(undefined).avisosTempoReal, false, "servidor antigo (sem o campo): polling");
    assert.equal(ad({ disponivel: true }).avisosTempoReal, false, "campo antigo não liga o selo");
  });
});

describe("dado real depois do aviso", () => {
  test("integração ativa sem pedidos: a consulta disparada pelo aviso não cria número nenhum", () => {
    const vazio = {
      versao: 1, origem: "api", servidorEm: "2026-10-09T15:00:00.000Z", atualizarEmS: 30,
      integracao: { estado: "ao_vivo", ultimaSincronizacao: "2026-10-09T15:00:00.000Z" }, semPedidosNoDia: true,
      indicadores: {}, pedidosAtivos: [], ultimosPedidos: [], contagemDia: { recebidos: 0, concluidos: 0, cancelados: 0, emAndamento: 0 },
      alertas: [], avaliacoes: { disponivel: false },
    };
    const r = adaptarResumo(vazio, { unidade: { id: UN, nome: "Saci" }, metas: METAS_EXEMPLO, recebidoEmMs: Date.parse(vazio.servidorEm) });
    const html = montarTela(r, Date.parse(vazio.servidorEm));
    assert.match(html, /Nenhum pedido registrado no período/);
    assert.doesNotMatch(html, /cko-nivel-txt--\w+" title="[^"]*">(<span[^>]*>≈<\/span>)?\d+,\d min/);
  });
});

describe("encaixe no controlador", () => {
  const fonte = ler("../src/checklistOperacional.js");
  test("assina o aviso e a resincronização pelo bus, com o filtro de organização + unidade", () => {
    assert.match(fonte, /registrarInteresse\(\{\s*\n\s*eventos: \[EVENTOS_IFOOD_PEDIDOS\.ESTADO_ATUALIZADO, RESINCRONIZACAO\]/);
    assert.match(fonte, /avisoDaMinhaUnidade\(evento, \{ organizacaoId: state\.sessao\?\.empresa\?\.id, unidadeId: state\.sessao\?\.unidade\?\.id \}\)/);
    assert.match(fonte, /aoReceber: \(\) => estado\.sincronizador\?\.avisar\(\)/);
  });
  test("nunca fala com o Supabase Realtime direto (só pelo bus) e para o sincronizador ao sair/trocar", () => {
    assert.doesNotMatch(fonte, /\.channel\(|setAuth|realtimeManager|getSupabase/);
    assert.match(fonte, /function parar\(\) \{[\s\S]*?estado\.sincronizador\?\.parar\(\);\s*\n\s*estado\.sincronizador = null;/);
  });
  test("demonstração não cria sincronizador (nada de consulta nem aviso)", () => {
    assert.match(fonte, /if \(demonstracaoPedida\(\)\) \{[\s\S]*?desenhar\(\);\s*\n\s*return;\s*\n\s*\}/);
    assert.ok(fonte.indexOf("estado.sincronizador = criarSincronizadorDaTela") > fonte.indexOf("if (demonstracaoPedida())"));
  });
});
