// Checkpoint H.4-B.1 — alavancas de envio no Painel Administrativo (frontend): contrato da API e construtores
// HTML->string (sem DOM/jsdom neste projeto, mesmo padrão de painelAdmComunicacao.test.js).
// Rodar: node --test frontend/test/painelAdmAtivacao.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ??= {};
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "jwt-identidade-fake" } } }) } }) };

const { painelAdmApi } = await import("../src/painelAdmApi.js");
const { htmlAtivacaoPiloto, htmlAcaoHabilitacao, htmlDrawerComunicacao } = await import("../src/painelAdmViews.js");

let capturado;
const fetchOriginal = globalThis.fetch;
beforeEach(() => {
  capturado = null;
  globalThis.fetch = async (url, opcoes) => { capturado = { url, opcoes }; return { ok: true, status: 200, statusText: "200", json: async () => ({ data: { ok: true } }) }; };
});
afterEach(() => { globalThis.fetch = fetchOriginal; });
const rotaDe = (u) => new URL(u, "http://x").pathname;

describe("painelAdmApi — contrato das alavancas (Bearer, sem x-context-token)", () => {
  test("GET /comunicacao/ativacao", async () => {
    await painelAdmApi.comunicacaoAtivacao();
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/ativacao");
    assert.equal(capturado.opcoes.headers.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(capturado.opcoes.headers).some((k) => k.toLowerCase() === "x-context-token"));
  });
  test("habilitar: PUT .../habilitacao com { habilitado:true, confirmacaoExplicita:true } e mais nada", async () => {
    await painelAdmApi.comunicacaoDefinirHabilitacao("org-1", true);
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/organizacoes/org-1/habilitacao");
    assert.equal(capturado.opcoes.method, "PUT");
    assert.deepEqual(JSON.parse(capturado.opcoes.body), { habilitado: true, confirmacaoExplicita: true });
  });
  test("desabilitar: { habilitado:false } SEM confirmação; qualquer valor não-true vira desabilitar (nunca habilita por acidente)", async () => {
    for (const v of [false, undefined, "true", 1, null]) {
      await painelAdmApi.comunicacaoDefinirHabilitacao("org-1", v);
      assert.deepEqual(JSON.parse(capturado.opcoes.body), { habilitado: false }, String(v));
    }
  });
  test("modo: NORMAL leva confirmacaoExplicita; DISABLED não; qualquer outro valor vira DISABLED (kill switch por padrão)", async () => {
    await painelAdmApi.comunicacaoDefinirModo("NORMAL");
    assert.equal(rotaDe(capturado.url), "/api/v1/administrativo/comunicacao/modo");
    assert.equal(capturado.opcoes.method, "PUT");
    assert.deepEqual(JSON.parse(capturado.opcoes.body), { modo: "NORMAL", confirmacaoExplicita: true });
    for (const m of ["DISABLED", "REACTIVE_ONLY", "normal", undefined]) {
      await painelAdmApi.comunicacaoDefinirModo(m);
      assert.deepEqual(JSON.parse(capturado.opcoes.body), { modo: "DISABLED" }, String(m));
    }
  });
});

const ATIV_PRONTA = { modo: "DISABLED", piloto: { ativo: true, quantidadeDestinos: 1 }, organizacoesHabilitadas: 1, destinatariosPermitidos: true, pendenciasElegiveis: 1, gateway: "conectado" };

describe("htmlAtivacaoPiloto — painel global", () => {
  test("sem dados -> vazio (o painel é acessório e nunca derruba a tela)", () => {
    assert.equal(htmlAtivacaoPiloto(null), "");
  });
  test("modo pausado + tudo pronto: 'Ativar piloto' habilitado, confirmação forte OCULTA com o texto exigido e Cancelar/Ativar piloto", () => {
    const html = htmlAtivacaoPiloto(ATIV_PRONTA);
    assert.match(html, /data-padm-acao="pedir-ativar-piloto"(?![^>]*disabled)/);
    assert.match(html, /class="padm-ativacao-confirmar" hidden/);
    assert.ok(html.includes("Você está prestes a ativar a comunicação automática do piloto. Existe 1 organização habilitada e 1 pendência D-1 elegível. Ao confirmar, o worker poderá criar e enviar a mensagem conforme as regras de horário, jitter, rate-limit, JIT e allowlist."));
    assert.ok(html.includes('data-padm-acao="cancelar-ativar-piloto"'));
    assert.ok(html.includes('data-padm-acao="confirmar-ativar-piloto"'));
    assert.ok(html.includes("Comunicação automática pausada"));
    assert.doesNotMatch(html, /desativar-comunicacao/);
  });
  test("pré-requisito ausente (piloto inativo, 0/2 empresas, destino fora, gateway fora) -> 'Ativar piloto' DESABILITADO", () => {
    for (const parcial of [
      { piloto: { ativo: false, quantidadeDestinos: 1 } }, { piloto: { ativo: true, quantidadeDestinos: 2 } },
      { organizacoesHabilitadas: 0 }, { organizacoesHabilitadas: 2 }, { destinatariosPermitidos: false }, { gateway: "desconectado" },
    ]) {
      assert.match(htmlAtivacaoPiloto({ ...ATIV_PRONTA, ...parcial }), /data-padm-acao="pedir-ativar-piloto"[^>]*disabled/, JSON.stringify(parcial));
    }
  });
  test("modo NORMAL -> mostra 'Desativar comunicação' (kill switch sem modal) e nenhuma opção de ativar", () => {
    const html = htmlAtivacaoPiloto({ ...ATIV_PRONTA, modo: "NORMAL" });
    assert.ok(html.includes('data-padm-acao="desativar-comunicacao"'));
    assert.ok(html.includes("Desativar comunicação"));
    assert.ok(html.includes("Comunicação automática ativa"));
    assert.doesNotMatch(html, /pedir-ativar-piloto|confirmar-ativar-piloto/);
  });
  test("nunca expõe telefone, enum de engenharia ou segredo", () => {
    for (const modo of ["DISABLED", "NORMAL"]) {
      const html = htmlAtivacaoPiloto({ ...ATIV_PRONTA, modo });
      assert.doesNotMatch(html, /\+55|\d{8,}|DISABLED|CONNECTED|COMUNICACAO_PILOTO|E164/i);
    }
  });
});

const detalhe = (checklist = {}, extra = {}) => ({
  organizacao: { organizacaoId: "o1", nome: "Grupo Jailton e Vanessa", status: "ativa" },
  configuracao: { status: "PRONTA_PARA_PILOTO", timezone: "America/Sao_Paulo", tiposPermitidos: ["dashboard_ifood_d1"], destinatario: { telefoneMascarado: "+558********88", verificado: true, consentimento: true, optOut: false, perfilOperacionalId: "p1" } },
  checklistPiloto: { perfilAssociado: true, telefoneValido: true, consentimento: true, telefoneVerificado: true, timezone: true, tipoAlerta: true, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false, ...checklist },
  unidades: [], tiposAlertaDisponiveis: ["dashboard_ifood_d1"], ...extra,
});

describe("htmlAcaoHabilitacao — ação da empresa", () => {
  test("pronta e não habilitada: 'Habilitar comunicação' com confirmação OCULTA, nome da empresa e Cancelar", () => {
    const html = htmlAcaoHabilitacao(detalhe());
    assert.ok(html.includes('data-padm-acao="pedir-habilitar-comunicacao"'));
    assert.match(html, /class="padm-habilitacao-confirmar" hidden/);
    assert.ok(html.includes("Grupo Jailton e Vanessa"));
    assert.ok(html.includes('data-padm-acao="cancelar-habilitar-comunicacao"'));
    assert.ok(html.includes('data-padm-acao="confirmar-habilitar-comunicacao"'));
    assert.doesNotMatch(html, /desabilitar-comunicacao-org/);
  });
  test("faltando consentimento/verificação/perfil/timezone/tipo -> sem botão de habilitar, com orientação", () => {
    for (const f of [{ consentimento: false }, { telefoneVerificado: false }, { perfilAssociado: false }, { telefoneValido: false }, { timezone: false }, { tipoAlerta: false }]) {
      const html = htmlAcaoHabilitacao(detalhe(f));
      assert.doesNotMatch(html, /pedir-habilitar-comunicacao/, JSON.stringify(f));
      assert.ok(html.includes("Conclua a configuração"));
    }
  });
  test("já habilitada -> 'Desabilitar comunicação' (sem modal) e nenhuma opção de habilitar", () => {
    const html = htmlAcaoHabilitacao(detalhe({ organizacaoHabilitada: true }));
    assert.ok(html.includes('data-padm-acao="desabilitar-comunicacao-org"'));
    assert.ok(html.includes("Comunicação habilitada"));
    assert.doesNotMatch(html, /pedir-habilitar-comunicacao|confirmar-habilitar-comunicacao/);
  });
  test("sem checklist -> vazio", () => {
    assert.equal(htmlAcaoHabilitacao({ organizacao: {} }), "");
  });
  test("o drawer inclui a seção 'Comunicação da empresa' e o vocabulário antigo proibido (enviar/Agente Crescer) continua fora", () => {
    const html = htmlDrawerComunicacao(detalhe(), []);
    assert.ok(html.includes("Comunicação da empresa"));
    assert.ok(html.includes("Habilitar comunicação"));
    assert.doesNotMatch(html, /Enviar|Habilitar organização|Ativar comunicação|Agente Crescer/i);
  });
});
