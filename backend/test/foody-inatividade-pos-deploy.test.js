// INATIVIDADE APÓS O DEPLOY dos PRs #79–#82 com as variáveis REAIS de produção (04/11: só FOODY_CENTRAL_ADMIN_ENABLED=true,
// FOODY_CENTRAL_SECRET definido; nenhuma das flags novas existe). Nada coleta, agenda, lê fechamento ou altera mensagem:
//   * sincronização manual → DESLIGADO antes de qualquer acesso ao banco ou à API;
//   * agendador embutido → não monta (nem importa) nada;
//   * Parser → não lê foody_fechamentos_logisticos;
//   * relatórios do Checklist → não leem Foody; mensagem idêntica.
// Banco/rede "explosivos": qualquer acesso reprova o teste.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-falsa-local";
process.env.SUPABASE_ANON_KEY ??= "chave-falsa-local";

const { solicitarSyncManual } = await import("../src/modules/foody/foody.sync.manual.js");
const { iniciarFoodyEmbutido } = await import("../src/worker-foody/foody.embedded.js");
const { carregarFonteLogistica, fonteFoodyNoParserPermitida } = await import("../src/modules/parser-food-delivery/parserFoodDelivery.foody.js");
const { lerFechamentosFoody, logisticaFoodyPermitida } = await import("../src/modules/notificacoes/notificacoes.relatorios.foody.js");
const { agendamentoPermitido, unidadePermitida, compartilhamentoPermitido, administracaoPermitida } = await import("../src/modules/foody/foody.flags.js");

const SUBWAY = "00000000-0000-0000-0000-0000000000a1", ACAI = "4d3b75bd-79b5-4335-ae5b-a183580c3555";
const ORG = "11111111-1111-4111-8111-111111111111";
const PRODUCAO_04_11 = Object.freeze({ FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_SECRET: "x".repeat(48), NODE_ENV: "production",
  NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO: "true" });
const explosivo = (nome) => new Proxy({}, { get: (_, k) => { if (k === "then") return undefined; throw new Error(`${nome}.${String(k)} acessado com tudo desligado`); } });

describe("inatividade após o deploy (variáveis reais de produção)", () => {
  test("flags: só a administração; coleta, allowlist, compartilhamento, agendador, Parser e relatório desligados", () => {
    assert.equal(administracaoPermitida(PRODUCAO_04_11), true);
    for (const u of [SUBWAY, ACAI]) {
      assert.equal(unidadePermitida(PRODUCAO_04_11, u), false);
      assert.equal(fonteFoodyNoParserPermitida(PRODUCAO_04_11, u), false);
      assert.equal(logisticaFoodyPermitida(PRODUCAO_04_11, u), false);
    }
    assert.equal(compartilhamentoPermitido(PRODUCAO_04_11), false);
    assert.equal(agendamentoPermitido(PRODUCAO_04_11), false);
  });

  test("sincronização manual: DESLIGADO antes de tocar banco, API ou estado", async () => {
    await assert.rejects(
      solicitarSyncManual({ ator: { perfilId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", papel: "organization_admin", impersonando: false, organizacaoId: ORG },
        tenant: { organizacaoId: ORG, unidadeId: SUBWAY }, competencias: ["2026-11-03"] },
      { env: PRODUCAO_04_11, repo: explosivo("repo"), estado: explosivo("estado"), executar: () => { throw new Error("executou"); }, log: () => {} }),
      (e) => e.codigo === "DESLIGADO");
  });

  test("agendador embutido: não monta nada (nem import dinâmico)", async () => {
    let montou = false;
    const r = await iniciarFoodyEmbutido({ env: PRODUCAO_04_11, log: () => {}, montar: async () => { montou = true; throw new Error("montou"); } });
    assert.equal(r.habilitado, false); assert.equal(montou, false);
    // mesmo com ENABLED + allowlist, sem AGENDADOR não inicia
    const r2 = await iniciarFoodyEmbutido({ env: { ...PRODUCAO_04_11, FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: SUBWAY, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true" },
      log: () => {}, montar: async () => { montou = true; throw new Error("montou"); } });
    assert.equal(r2.habilitado, false); assert.equal(montou, false, "piloto manual (ENABLED+allowlist+compartilhamento) não liga o agendador");
  });

  test("Parser e relatórios: nenhuma leitura de foody_fechamentos_logisticos — inclusive DURANTE o piloto manual", async () => {
    const piloto = { ...PRODUCAO_04_11, FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: SUBWAY, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true" };
    for (const env of [PRODUCAO_04_11, piloto]) {
      for (const unidadeId of [SUBWAY, ACAI]) {
        assert.equal(await carregarFonteLogistica({ db: explosivo("db"), env, organizacaoId: ORG, unidadeId, dataInicio: "2026-11-01", dataFim: "2026-11-03",
          pedidosElegiveis: [], todos: [], resumoPorDia: () => ({}) }), null);
        let leu = false;
        assert.equal(await lerFechamentosFoody({ env, organizacaoId: ORG, unidadeId, de: "2026-11-01", ate: "2026-11-03", ler: async () => { leu = true; return []; } }), null);
        assert.equal(leu, false);
      }
    }
  });
});
