// Agendador dos relatórios operacionais ligado ao boot do backend: desligado por padrão, guarda de efeitos externos, parada idempotente
// e nenhum acoplamento com o worker de comunicação / D-1.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { iniciarRelatoriosOperacionaisEmbutido, pararRelatoriosOperacionaisEmbutido, relatoriosAgendadorHabilitado } = await import("../src/worker-comunicacao/relatorios.embedded.js");

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ON = { NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO: "true", EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" };   // fora do Render a guarda exige autorização explícita
const RENDER_AUTORIZADO = { NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO: "true", RENDER: "true", IS_PULL_REQUEST: "false", EFEITOS_EXTERNOS_PERMITIDOS: "true", EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS: "srv-d96rl5naqgkc73ccflr0", RENDER_SERVICE_ID: "srv-d96rl5naqgkc73ccflr0" };
const agendadorFalso = () => { const e = { iniciou: 0, parou: 0, aoTerminar: null }; e.criar = (p) => { e.aoTerminar = p.aoTerminarCiclo; return { iniciar() { e.iniciou++; }, parar() { e.parou++; } }; }; return e; };

describe("agendador embutido dos relatórios", () => {
  test("DESLIGADO por padrão: não cria nada (nem carrega o módulo)", async () => {
    const ag = agendadorFalso();
    for (const env of [{}, { NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO: "false" }, { NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO: "1" }]) {
      const r = await iniciarRelatoriosOperacionaisEmbutido({ env, criarAgendador: ag.criar });
      assert.equal(r.habilitado, false);
    }
    assert.equal(ag.iniciou, 0); assert.equal(relatoriosAgendadorHabilitado({}), false);
    await pararRelatoriosOperacionaisEmbutido("SIGTERM");               // no-op sem erro
  });
  test("guarda de efeitos externos: PR Preview e Render sem autorização do serviço BLOQUEIAM mesmo com a flag", async () => {
    const ag = agendadorFalso();
    assert.match((await iniciarRelatoriosOperacionaisEmbutido({ env: { ...LOCAL_ON, IS_PULL_REQUEST: "true" }, criarAgendador: ag.criar })).motivo, /efeitos externos bloqueados/);
    assert.match((await iniciarRelatoriosOperacionaisEmbutido({ env: { ...LOCAL_ON, RENDER: "true", IS_PULL_REQUEST: "false" }, criarAgendador: ag.criar })).motivo, /efeitos externos bloqueados/);
    assert.equal(ag.iniciou, 0);
  });
  test("com a flag e ambiente permitido: inicia UMA vez e para de forma idempotente; falha ao iniciar não propaga", async () => {
    const ag = agendadorFalso(); const logs = [];
    const log = (n, e, d) => logs.push([n, e, d]);
    const r = await iniciarRelatoriosOperacionaisEmbutido({ env: LOCAL_ON, log, criarAgendador: ag.criar });
    assert.equal(r.habilitado, true); assert.equal(ag.iniciou, 1);
    assert.equal((await iniciarRelatoriosOperacionaisEmbutido({ env: LOCAL_ON, log, criarAgendador: ag.criar })).motivo, "já iniciado"); assert.equal(ag.iniciou, 1);
    ag.aoTerminar({ recusadas: [{ unidadeId: "u1", motivo: "x" }], enfileirados: [{ unidadeId: "u2" }, { erro: "boom" }], envio: { desligado: true, motivo: "ALLOWLIST_OBRIGATORIA" } });
    const ciclo = logs.find(([, e]) => e === "relatorios.ciclo"); assert.deepEqual(ciclo[2], { recusadas: 1, enfileirados: 1, erros: 1, despacho: "ALLOWLIST_OBRIGATORIA" });
    await pararRelatoriosOperacionaisEmbutido("SIGTERM"); await pararRelatoriosOperacionaisEmbutido("SIGTERM"); assert.equal(ag.parou, 1);
    const ruim = await iniciarRelatoriosOperacionaisEmbutido({ env: LOCAL_ON, criarAgendador: () => { throw new Error("config"); } });
    assert.deepEqual([ruim.habilitado, ruim.motivo], [false, "falha ao iniciar"]);
  });
});

describe("integração com o boot", () => {
  test("server.js só liga o agendador pelo módulo embutido (flag) e o para no encerramento gracioso", () => {
    const s = readFileSync(path.join(RAIZ, "src/server.js"), "utf8");
    assert.match(s, /iniciarRelatoriosOperacionaisEmbutido\(/); assert.match(s, /pararRelatoriosOperacionaisEmbutido\(sinal\)/);
    assert.doesNotMatch(s, /criarAgendadorRelatorios|processarFilaRelatorios/, "o boot não chama o agendador direto");
  });
  test("o D-1 não conhece os relatórios: worker de comunicação, fila e alertas não importam nada de relatórios", () => {
    for (const f of ["src/worker-comunicacao/lifecycle.js", "src/worker-comunicacao/loop.js", "src/modules/comunicacao/comunicacao.alertas.service.js", "src/modules/comunicacao/comunicacao.fila.repo.js"]) {
      assert.doesNotMatch(readFileSync(path.join(RAIZ, f), "utf8"), /relatorios/i, f);
    }
  });
});

describe("guarda no Render", () => {
  test("no serviço autorizado inicia; em OUTRO serviço (ou sem autorização) bloqueia", async () => {
    const ag = agendadorFalso();
    assert.equal((await iniciarRelatoriosOperacionaisEmbutido({ env: RENDER_AUTORIZADO, criarAgendador: ag.criar })).habilitado, true);
    await pararRelatoriosOperacionaisEmbutido();
    assert.match((await iniciarRelatoriosOperacionaisEmbutido({ env: { ...RENDER_AUTORIZADO, RENDER_SERVICE_ID: "srv-aaaaaaaaaaaaaaaaaaaa" }, criarAgendador: ag.criar })).motivo, /bloqueados/);
    assert.match((await iniciarRelatoriosOperacionaisEmbutido({ env: { ...RENDER_AUTORIZADO, EFEITOS_EXTERNOS_PERMITIDOS: "false" }, criarAgendador: ag.criar })).motivo, /bloqueados/);
  });
});
