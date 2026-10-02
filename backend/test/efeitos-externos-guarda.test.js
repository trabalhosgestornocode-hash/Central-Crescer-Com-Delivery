// Guarda de EFEITOS EXTERNOS (src/ambiente/efeitosExternos.js) — autorização positiva, fail closed.
//
// ISOLAMENTO: nenhum teste aqui alcança Supabase, Gateway, iFood ou Martin Brower reais. Os ambientes são objetos
// FICTÍCIOS (ids srv-… inventados, URLs .invalid); o fetch é substituído; as rotinas recebem dependências falsas; os
// workers dedicados rodam como processo filho com ambiente mínimo e explícito (sem .env, nada herdado do shell).
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { avaliarEfeitosExternos, efeitosExternosPermitidos } from "../src/ambiente/efeitosExternos.js";

// Sem .env e sem rede (mesmo padrão de comunicacao-config-agendamento.test.js): alguns módulos importam o cliente
// Supabase, que só precisa de valores sintáticos — 127.0.0.1:1 nunca responde e nenhum teste aqui chega a chamá-lo.
const SUPABASE_SEM_REDE = { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "teste-sem-rede", SUPABASE_ANON_KEY: "teste-sem-rede" };
Object.assign(process.env, SUPABASE_SEM_REDE);
const { criarBaileysGatewayProvider } = await import("../src/modules/comunicacao/providers/baileysGateway.provider.js");
const { iniciarWorkerComunicacaoEmbutido, pararWorkerComunicacaoEmbutido } = await import("../src/worker-comunicacao/lifecycle.js");
const { iniciarPurgaPeriodica } = await import("../src/modules/comunicacao/comunicacao.inbox.retencao.js");
const { iniciarEventsIfoodEmbutido } = await import("../src/worker-ifood/embedded.js");
const { workerHabilitado } = await import("../src/modules/martinbrower/martinbrower.worker.contract.js");

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRV_PROD = "srv-prodfake000000000001";
const SRV_PREVIEW = "srv-previewfake00000001";

// Produção AUTORIZADA fictícia: tudo o que o Render injeta + a autorização positiva + as flags das rotinas ligadas.
const PROD = Object.freeze({
  RENDER: "true", IS_PULL_REQUEST: "false", RENDER_SERVICE_ID: SRV_PROD,
  EFEITOS_EXTERNOS_PERMITIDOS: "true", EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: SRV_PROD,
  COMUNICACAO_WORKER_ENABLED: "true", IFOOD_EVENTS_EMBEDDED_ENABLED: "true", IFOOD_EVENTS_WORKER_ENABLED: "true", MB_PLAYWRIGHT_ENABLED: "true",
  ...SUPABASE_SEM_REDE, WHATSAPP_GATEWAY_URL: "http://gateway.invalid", WHATSAPP_GATEWAY_SECRET: "segredo-ficticio-de-teste-0123456789",
});
// PR Preview: HERDA todas as variáveis de PROD (doc. do Render); o Render muda só o que é por instância.
const PREVIEW = Object.freeze({ ...PROD, IS_PULL_REQUEST: "true", RENDER_SERVICE_ID: SRV_PREVIEW });

const silencio = () => {};
afterEach(() => mock.restoreAll());

describe("guarda — matriz de ambientes", () => {
  test("1. Render produção autorizada ⇒ PERMITIDO", () => {
    assert.deepEqual(avaliarEfeitosExternos(PROD), { permitido: true, ambiente: "render", motivo: "servico_autorizado" });
    assert.equal(efeitosExternosPermitidos({ ...PROD, EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: `srv-outrofake0000000001, ${SRV_PROD}` }), true, "lista com vários ids");
  });

  test("2. Render PR Preview herdando TODAS as envs de produção ⇒ BLOQUEADO (mesmo se a lista incluir o id do preview)", () => {
    assert.deepEqual(avaliarEfeitosExternos(PREVIEW), { permitido: false, ambiente: "preview", motivo: "render_pull_request_preview" });
    assert.equal(efeitosExternosPermitidos({ ...PREVIEW, EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: `${SRV_PROD},${SRV_PREVIEW}` }), false);
    assert.equal(efeitosExternosPermitidos({ ...PREVIEW, EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }), false);
  });

  test("3. local sem autorização ⇒ BLOQUEADO — inclusive com as envs de produção copiadas para o .env", () => {
    assert.equal(avaliarEfeitosExternos({}).permitido, false);
    assert.equal(avaliarEfeitosExternos({}).ambiente, "local");
    const envCopiadoDeProducao = { ...PROD }; delete envCopiadoDeProducao.RENDER; delete envCopiadoDeProducao.IS_PULL_REQUEST; delete envCopiadoDeProducao.RENDER_SERVICE_ID;
    assert.deepEqual(avaliarEfeitosExternos(envCopiadoDeProducao), { permitido: false, ambiente: "local", motivo: "fora_do_render_sem_autorizacao" });
    assert.equal(efeitosExternosPermitidos({ EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }), true, "opt-in local explícito");
  });

  test("4. test sem autorização ⇒ BLOQUEADO", () => {
    assert.deepEqual(avaliarEfeitosExternos({ NODE_ENV: "test" }), { permitido: false, ambiente: "teste", motivo: "fora_do_render_sem_autorizacao" });
    assert.equal(avaliarEfeitosExternos({ NODE_TEST_CONTEXT: "child-v8" }).ambiente, "teste");
    assert.equal(efeitosExternosPermitidos({ NODE_ENV: "test", EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }), true, "teste que exige explicitamente");
  });

  test("5. variável inválida ⇒ BLOQUEADO", () => {
    for (const v of ["1", "yes", "on", "verdadeiro", " ", "TRUE!"]) {
      assert.equal(efeitosExternosPermitidos({ ...PROD, EFEITOS_EXTERNOS_PERMITIDOS: v }), false, `EFEITOS_EXTERNOS_PERMITIDOS=${JSON.stringify(v)}`);
      assert.equal(efeitosExternosPermitidos({ EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: v }), false, `EFEITOS_EXTERNOS_LOCAL_PERMITIDOS=${JSON.stringify(v)}`);
    }
    for (const v of ["yes", "1", "preview", "maybe"]) assert.equal(avaliarEfeitosExternos({ ...PROD, IS_PULL_REQUEST: v }).motivo, "is_pull_request_invalido");
    for (const lista of [`${SRV_PROD},nao-e-id`, `${SRV_PROD},`, "SRV-PRODFAKE000000000001", "*"]) {
      assert.equal(efeitosExternosPermitidos({ ...PROD, EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: lista }), false, `lista ${JSON.stringify(lista)}`);
    }
    assert.equal(avaliarEfeitosExternos({ ...PROD, RENDER: "sim" }).motivo, "render_invalido");
  });

  test("6. ambiente desconhecido/contraditório ⇒ BLOQUEADO", () => {
    const semPr = { ...PROD }; delete semPr.IS_PULL_REQUEST;
    assert.equal(avaliarEfeitosExternos(semPr).motivo, "is_pull_request_ausente", "Render sem IS_PULL_REQUEST");
    assert.equal(avaliarEfeitosExternos({ RENDER_SERVICE_ID: SRV_PROD, EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }).motivo, "ambiente_contraditorio");
    assert.equal(avaliarEfeitosExternos({ IS_PULL_REQUEST: "false", EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }).motivo, "ambiente_contraditorio");
    assert.equal(avaliarEfeitosExternos({ ...PROD, RENDER_SERVICE_ID: "" }).motivo, "render_service_id_invalido");
  });

  test("7. serviço do Render fora da lista (serviço novo/copiado) ⇒ BLOQUEADO; Render sem autorização/lista ⇒ BLOQUEADO", () => {
    assert.equal(avaliarEfeitosExternos({ ...PROD, RENDER_SERVICE_ID: "srv-copiadofake000000001" }).motivo, "servico_nao_autorizado");
    const semFlag = { ...PROD }; delete semFlag.EFEITOS_EXTERNOS_PERMITIDOS;
    assert.equal(avaliarEfeitosExternos(semFlag).motivo, "render_sem_autorizacao", "o Render sozinho NÃO concede permissão");
    assert.equal(avaliarEfeitosExternos({ ...PROD, EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: "" }).motivo, "lista_de_servicos_ausente");
    assert.equal(efeitosExternosPermitidos({ ...PROD, EFEITOS_EXTERNOS_PERMITIDOS: undefined, EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" }), false, "opt-in local não vale no Render");
  });

  test("o resultado só carrega vocabulário fechado (nunca o id do serviço, URL ou segredo)", () => {
    for (const env of [PROD, PREVIEW, {}, { ...PROD, RENDER_SERVICE_ID: "srv-copiadofake000000001" }]) {
      const s = JSON.stringify(avaliarEfeitosExternos(env));
      for (const proibido of [SRV_PROD, SRV_PREVIEW, "srv-copiadofake", "gateway.invalid", "segredo-ficticio", "teste-sem-rede"]) assert.ok(!s.includes(proibido), proibido);
    }
  });
});

describe("guarda — provider WhatsApp (ponto único de chamada ao Gateway)", () => {
  const respostaOk = () => new Response(JSON.stringify({ providerMessageId: "wa-1", enviadoEm: "2026-10-02T00:00:00.000Z" }), { status: 200, headers: { "Content-Type": "application/json" } });
  const pedido = { telefoneE164: "+5511900000000", texto: "texto-secreto-do-teste", idempotencyKey: "k-guarda-1" };

  for (const [nome, env] of [["preview", PREVIEW], ["local sem autorização", {}], ["test sem autorização", { NODE_ENV: "test" }], ["serviço não autorizado", { ...PROD, RENDER_SERVICE_ID: "srv-copiadofake000000001" }]]) {
    test(`8. ${nome}: envio, status, connect e reset são RECUSADOS sem tocar a rede; erro sem telefone/texto`, async () => {
      const fetchFalso = mock.method(globalThis, "fetch", async () => respostaOk());
      const p = criarBaileysGatewayProvider({ gatewayUrl: "http://gateway.invalid", segredoHmac: "segredo-ficticio", env });
      await assert.rejects(p.sendText(pedido), (e) => {
        assert.match(e.message, /^BAILEYS_GATEWAY_EFEITOS_EXTERNOS_BLOQUEADOS: [a-z_]+$/);
        assert.equal(e.preEnvio, true); assert.equal(e.permanente, true);
        assert.ok(!e.message.includes(pedido.telefoneE164) && !e.message.includes(pedido.texto));
        return true;
      });
      await assert.rejects(p.getStatus(), /EFEITOS_EXTERNOS_BLOQUEADOS/);
      await assert.rejects(p.connect(), /EFEITOS_EXTERNOS_BLOQUEADOS/);
      await assert.rejects(p.reset(), /EFEITOS_EXTERNOS_BLOQUEADOS/);
      assert.equal(fetchFalso.mock.callCount(), 0, "nenhuma chamada de rede");
    });
  }

  test("14. produção autorizada: o provider chama o Gateway exatamente como antes", async () => {
    const fetchFalso = mock.method(globalThis, "fetch", async () => respostaOk());
    const p = criarBaileysGatewayProvider({ gatewayUrl: "http://gateway.invalid", segredoHmac: "segredo-ficticio", env: PROD });
    const r = await p.sendText(pedido);
    assert.equal(r.providerMessageId, "wa-1");
    assert.equal(fetchFalso.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(fetchFalso.mock.calls[0].arguments[1].body), { telefoneE164: pedido.telefoneE164, tipo: "text", texto: pedido.texto, idempotencyKey: pedido.idempotencyKey }, "corpo idêntico ao de antes (sem retryResend)");
  });
});

describe("guarda — rotinas do Web Service", () => {
  const depsWorker = (marcar) => ({
    carregarConfig: () => { marcar(); return { intervalMs: 60_000, gatewayUrl: "http://gateway.invalid", segredoHmac: "segredo-ficticio" }; },
    criarLoopWorker: () => { marcar(); return { iniciar() {}, encerrar: async () => {}, obterEstado: () => ({}) }; },
    modoAtual: async () => { marcar(); return "DISABLED"; },
    executarCiclo: async () => { marcar(); return {}; },
    criarWhatsAppService: () => { marcar(); return {}; },
    criarBaileysGatewayProvider: () => { marcar(); return {}; },
  });

  test("9. worker de comunicação em preview NÃO inicia e não toca nenhuma dependência (fila/provider)", async () => {
    let tocou = 0;
    const logs = [];
    const r = await iniciarWorkerComunicacaoEmbutido({ env: PREVIEW, log: (...l) => logs.push(l), ...depsWorker(() => { tocou += 1; }) });
    assert.equal(r.habilitado, false);
    assert.equal(tocou, 0);
    assert.deepEqual(logs.at(-1)?.[2], { reason: "efeitos_externos_bloqueados", ambiente: "preview", motivo: "render_pull_request_preview" });
  });

  test("processo sem autorização explícita (local/test com a flag ligada) não consome a fila de comunicação", async () => {
    for (const env of [{ COMUNICACAO_WORKER_ENABLED: "true" }, { COMUNICACAO_WORKER_ENABLED: "true", NODE_ENV: "test" }, { ...PROD, RENDER_SERVICE_ID: "srv-copiadofake000000001" }]) {
      let tocou = 0;
      const r = await iniciarWorkerComunicacaoEmbutido({ env, log: silencio, ...depsWorker(() => { tocou += 1; }) });
      assert.equal(r.habilitado, false);
      assert.equal(tocou, 0);
    }
  });

  test("14. worker de comunicação em produção autorizada inicia como antes", async () => {
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: PROD, log: silencio,
      carregarConfig: () => ({ intervalMs: 60_000, gatewayUrl: "http://gateway.invalid", segredoHmac: "segredo-ficticio" }),
      modoAtual: async () => "DISABLED", executarCiclo: async () => ({}),
      criarWhatsAppService: () => ({}), criarBaileysGatewayProvider: () => ({}),
    });
    assert.equal(r.habilitado, true);
    await pararWorkerComunicacaoEmbutido("TESTE");
  });

  test("10. purga em preview/local/test NÃO inicia (nenhum timer, nenhuma remoção); produção autorizada continua no padrão de 6 h", () => {
    for (const env of [PREVIEW, {}, { NODE_ENV: "test" }]) {
      const logs = [];
      const r = iniciarPurgaPeriodica({ env, log: (...l) => logs.push(l), deps: { supabase: { from() { throw new Error("NÃO pode tocar o banco"); } } } });
      assert.equal(r.ativa, false);
      assert.equal(logs.at(-1)?.[1], "comunicacao.inbox_purga_bloqueada");
    }
    const r = iniciarPurgaPeriodica({ env: PROD, log: silencio, primeiraMs: 3_600_000, deps: { supabase: { from() { throw new Error("NÃO pode tocar o banco"); } } } });
    assert.equal(r.ativa, true);
    r.parar();
  });

  test("11. iFood Events embarcado em preview NÃO inicia (runtime nem é montado)", async () => {
    let montou = 0;
    const r = await iniciarEventsIfoodEmbutido({ env: PREVIEW, log: silencio, montarRuntime: async () => { montou += 1; return { ok: false }; } });
    assert.equal(r.habilitado, false);
    assert.equal(montou, 0);
  });

  test("12. Martin Brower em preview/local NÃO é habilitado (mesmo com MB_PLAYWRIGHT_ENABLED=true herdado); produção autorizada sim", () => {
    const original = { ...process.env };
    try {
      for (const env of [PREVIEW, { MB_PLAYWRIGHT_ENABLED: "true" }, PROD]) {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, { PATH: original.PATH }, env);
        assert.equal(workerHabilitado(), env === PROD);
      }
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, original);
    }
  });
});

describe("13. guarda — workers dedicados (processo filho, ambiente mínimo fictício)", () => {
  function rodar(entrypoint, env) {
    return new Promise((resolve, reject) => {
      const filho = spawn(process.execPath, [entrypoint], {
        cwd: BACKEND, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ["ignore", "pipe", "pipe"],
      });
      let saida = "";
      filho.stdout.on("data", (b) => { saida += b; });
      filho.stderr.on("data", (b) => { saida += b; });
      const t = setTimeout(() => { filho.kill(); reject(new Error(`não saiu sozinho: ${saida.slice(0, 500)}`)); }, 20_000);
      filho.on("exit", (code) => { clearTimeout(t); resolve({ code, saida }); });
    });
  }

  for (const [nome, env] of [["preview", PREVIEW], ["local sem autorização", { ...PROD, RENDER: "", IS_PULL_REQUEST: "", RENDER_SERVICE_ID: "" }], ["serviço não autorizado", { ...PROD, RENDER_SERVICE_ID: "srv-copiadofake000000001" }]]) {
    test(`worker-comunicacao dedicado — ${nome}: sai com 0 sem consumir a fila`, async () => {
      const { code, saida } = await rodar("src/worker-comunicacao/index.js", env);
      assert.equal(code, 0, saida);
      assert.match(saida, /efeitos_externos_bloqueados/);
      assert.doesNotMatch(saida, /gateway\.invalid|segredo-ficticio|teste-sem-rede|srv-/, "log sem URL, segredo ou id de serviço");
    });

    test(`worker-ifood dedicado — ${nome}: sai com 0 sem polling`, async () => {
      const { code, saida } = await rodar("src/worker-ifood/index.js", env);
      assert.equal(code, 0, saida);
      assert.match(saida, /bloqueado_efeitos_externos/);
      assert.doesNotMatch(saida, /gateway\.invalid|segredo-ficticio|teste-sem-rede|srv-/);
    });
  }
});
