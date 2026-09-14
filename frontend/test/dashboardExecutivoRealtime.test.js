// Etapa 2 — Dashboard iFood em tempo real: relevância/dedup/reconexão do lado
// do FRONTEND (backend + a prova de dois clientes real ficam em
// backend/test/dashboard-executivo-realtime-e2e.test.js).
//
// Diferente dos outros testes de dashboardExecutivo.js (só leitura de texto
// fonte, ver dashboardExecutivoPendenciasUi.test.js): aqui o módulo é
// IMPORTADO E EXECUTADO de verdade, com um fake mínimo de DOM/storage/fetch
// (mesma técnica de configuracoes.test.js — "Sem jsdom no projeto"). Isso
// exercita o código de VERDADE (realtimeBus.registrarInteresse +
// escopoBate/competenciaBate/eventoRelevanteParaTelaAtual reais), não uma
// reimplementação da lógica nos testes.
//
// Sinal observável escolhido: contagem de chamadas a `fetch` no endpoint
// `/dashboard-executivo/mes` (ou `/historico`) — é exatamente o que
// `carregarConteudo`/`renderHistorico` disparam quando decidem re-buscar.
// "Não disparou" = a chamada não aparece nessa contagem.
//
// Rodar: node --test frontend/test/dashboardExecutivoRealtime.test.js
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- fake DOM/storage/fetch mínimos -------------------------------------
function elementoFake() {
  return {
    _html: "", get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
    textContent: "", classList: { toggle: () => {}, add: () => {}, remove: () => {} }, style: {}, dataset: {},
  };
}
globalThis.document = {
  querySelector: () => elementoFake(), querySelectorAll: () => [], createElement: () => elementoFake(),
  addEventListener: () => {}, dispatchEvent: () => {}, documentElement: { setAttribute: () => {} },
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

/** Resposta de `/dashboard-executivo/unidades` — trocada entre os grupos de teste (ver `configurarUnidades`). */
let respostaUnidades = { data: { unidades: [], agregadoDisponivel: false } };
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const u = String(url);
  if (u.includes("/api/config")) return { ok: true, status: 200, json: async () => ({ supabaseUrl: "https://x.example", supabaseAnonKey: "anon" }) };
  if (u.includes("/dashboard-executivo/unidades")) return { ok: true, status: 200, json: async () => respostaUnidades };
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) };

const { state } = await import("../src/state.js");
const { receberEvento } = await import("../src/realtime/realtimeBus.js");
const { EVENTOS_DASHBOARD_IFOOD, RESINCRONIZACAO } = await import("../src/realtime/realtimeEvents.js");
const { renderDashboardExecutivo, _resetCoalescingParaTeste } = await import("../src/dashboardExecutivo.js");

const FONTE = readFileSync(fileURLToPath(new URL("../src/dashboardExecutivo.js", import.meta.url)), "utf8");

const ORG = "org-1";
const hoje = new Date();
const COMPETENCIA_ATUAL = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
const COMPETENCIA_OUTRO_MES = `${hoje.getFullYear()}-${String(((hoje.getMonth() + 10) % 12) + 1).padStart(2, "0")}`;

function chamadasDashboard() {
  return fetchCalls.filter((u) => u.includes("/dashboard-executivo/mes") || u.includes("/dashboard-executivo/historico")).length;
}

/** Reseta contagem de fetch E a janela de coalescing de 3s
 * (`_resetCoalescingParaTeste`) — sem isso, o refresh de um teste "conta como
 * recente" para o próximo que rodar poucos ms depois, e um refetch legítimo
 * seria suprimido por engano só por causa da ordem de execução dos testes. */
function comecarTeste() {
  fetchCalls.length = 0;
  _resetCoalescingParaTeste();
}

let seq = 0;
function evento(overrides) {
  seq += 1;
  return {
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_ATUALIZADO, organizacaoId: ORG,
    entidadeId: `lanc-${seq}`, versao: `v${seq}`, competencia: COMPETENCIA_ATUAL,
    ...overrides,
  };
}

/** Refaz `renderDashboardExecutivo()` com uma lista de unidades escolhida — é o
 * caminho REAL (não um atalho de teste) pelo qual `dex.unidadeId` muda: o
 * módulo não expõe setter nenhum de propósito (ver a auditoria da Etapa 2). */
async function configurarUnidades(unidades, agregadoDisponivel) {
  respostaUnidades = { data: { unidades, agregadoDisponivel } };
  await renderDashboardExecutivo();
  comecarTeste(); // descarta as chamadas do próprio setup (unidades + mes inicial) e a janela de coalescing que ele abriu
}

before(() => {
  state.rota = "dashboard-executivo";
  state.sessao.empresa = { id: ORG };
  state.sessao.permissoes = [];
});

describe("Dashboard iFood — relevância do Realtime (unidade específica)", () => {
  before(() => configurarUnidades([{ id: "uni-x", nome: "Unidade X" }], false)); // dex.unidadeId vira "uni-x" de verdade

  test("evento da mesma unidade, mesma competência -> dispara refetch", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });

  test("evento de OUTRA unidade -> não dispara nada", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-y" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
  });

  test("evento de outra ORGANIZAÇÃO -> não dispara (defesa em profundidade, mesmo que o canal já devesse filtrar)", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x", organizacaoId: "org-outra" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
  });

  test("mesma unidade, competência de OUTRO mês -> não dispara", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x", competencia: COMPETENCIA_OUTRO_MES }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
  });

  test("modelo_logistico_atualizado ignora competência -- dispara mesmo de 'outro mês'", async () => {
    comecarTeste();
    receberEvento(evento({ tipo: EVENTOS_DASHBOARD_IFOOD.MODELO_LOGISTICO_ATUALIZADO, unidadeId: "uni-x", competencia: undefined }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });

  test("_realtime.resincronizado da mesma unidade dispara refetch mesmo sem 'competencia' (reconexão nunca reproduz eventos perdidos, só busca o estado atual)", async () => {
    comecarTeste();
    receberEvento({ tipo: RESINCRONIZACAO, organizacaoId: ORG, unidadeId: "uni-x" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });

  test("_realtime.resincronizado de OUTRA unidade -> ignorado", async () => {
    comecarTeste();
    receberEvento({ tipo: RESINCRONIZACAO, organizacaoId: ORG, unidadeId: "uni-y" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
  });

  test("entrega duplicada empresa+unidade do MESMO evento (mesmo tipo/org/unidade/entidade/versão) -> só 1 refetch (dedup do realtimeBus)", async () => {
    comecarTeste();
    const e = evento({ unidadeId: "uni-x" });
    receberEvento({ ...e }); // "chegou pelo tópico da unidade"
    receberEvento({ ...e }); // "chegou pelo tópico da empresa" -- mesmo payload, mesma chave de dedup
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });

  test("duas atualizações dentro da janela de 3s -- a segunda é suprimida (coalescing local)", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x" }));
    await new Promise((r) => setTimeout(r, 50));
    receberEvento(evento({ unidadeId: "uni-x" })); // versão/entidade DIFERENTES -- não é dedup do bus, é a janela de coalescing (NÃO chamar comecarTeste() entre os dois)
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1, "a segunda mudança genuína chega dentro de poucos segundos, não fica perdida para sempre — só atrasada");
  });

  test("depois de trocar de unidade (novo contexto), evento da unidade ANTERIOR já não é relevante", async () => {
    await configurarUnidades([{ id: "uni-nova", nome: "Unidade Nova" }], false); // dex.unidadeId agora é "uni-nova"
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x" })); // contexto antigo
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);

    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-nova" })); // contexto atual
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });
});

describe("Dashboard iFood — relevância do Realtime ('Todas as unidades')", () => {
  before(() => configurarUnidades([], true)); // sem unidade selecionável -> dex.unidadeId vira null

  test("evento de QUALQUER unidade da mesma empresa dispara refetch (o agregado depende de todas)", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-qualquer" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 1);
  });

  test("evento de outra empresa continua ignorado mesmo em 'Todas as unidades'", async () => {
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-qualquer", organizacaoId: "org-outra" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
  });
});

describe("Dashboard iFood — módulo fechado", () => {
  before(() => configurarUnidades([{ id: "uni-x", nome: "Unidade X" }], false));

  test("state.rota diferente de 'dashboard-executivo' -> nenhum evento reage (Fase J: tela não montada, próximo fetch normal já vem atualizado)", async () => {
    const rotaAnterior = state.rota;
    state.rota = "outra-tela";
    comecarTeste();
    receberEvento(evento({ unidadeId: "uni-x" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chamadasDashboard(), 0);
    state.rota = rotaAnterior;
  });
});

// ---------------------------------------------------------------------------
// Conflito com formulário aberto — testado por leitura de fonte, não em
// execução: `avisarAlteracaoExterna` só age quando existe um `fm` (estado do
// MODAL) internamente montado em dashboardExecutivoForm.js, e montá-lo de
// verdade exige simular a abertura completa do modal (fetch do lançamento +
// render do passo a passo) — fora do escopo do fake-DOM mínimo usado acima.
// O comportamento de `avisarAlteracaoExterna` em si (não-destrutivo, só
// sinaliza `fm.conflitoExterno`) já é garantido por construção — ver o
// comentário da função em dashboardExecutivoForm.js. Aqui só travamos que a
// FIAÇÃO em dashboardExecutivo.js chama essa função, incondicionalmente
// (antes de qualquer filtro de relevância/competência), só para os dois
// tipos que podem descrever a MESMA entidade que já está aberta.
// ---------------------------------------------------------------------------
describe("Dashboard iFood — conflito com formulário aberto (fiação, ver nota acima)", () => {
  test("avisarAlteracaoExterna é chamada para atualizado/excluído, e ANTES do filtro de relevância", () => {
    const bloco = FONTE.slice(FONTE.indexOf("aoReceber: (evento)"), FONTE.indexOf("registrarInteresse({") + FONTE.slice(FONTE.indexOf("registrarInteresse({")).indexOf("});"));
    const posAviso = bloco.indexOf("avisarAlteracaoExterna(evento.entidadeId)");
    const posFiltroRelevancia = bloco.indexOf("eventoRelevanteParaTelaAtual(evento)");
    assert.ok(posAviso > -1, "chamada a avisarAlteracaoExterna não encontrada em aoReceber");
    assert.ok(posFiltroRelevancia > -1);
    assert.ok(posAviso < posFiltroRelevancia, "o aviso de conflito precisa rodar ANTES do filtro de relevância — mesmo um evento fora de mês/aba pode ser da mesma entidade aberta no formulário");
  });

  test("só lancamento_atualizado/excluido entram no conjunto de conflito -- criação nunca colide com um id já aberto", () => {
    const inicio = FONTE.indexOf("EVENTOS_QUE_PODEM_CONFLITAR_COM_FORMULARIO = new Set([");
    const fim = FONTE.indexOf("]);", inicio);
    const bloco = FONTE.slice(inicio, fim);
    assert.match(bloco, /LANCAMENTO_ATUALIZADO/);
    assert.match(bloco, /LANCAMENTO_EXCLUIDO/);
    assert.doesNotMatch(bloco, /LANCAMENTO_CRIADO/);
  });
});
