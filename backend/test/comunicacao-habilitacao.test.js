// D.3-D — HABILITAÇÃO por organização (migration 088), fail-closed.
//   Parte 1 (unitária, sem banco): interpretarHabilitacao / resolverHabilitacaoEmpresa com banco simulado.
//   Parte 2 (integração, banco de TESTE): a tabela real — constraints/trigger, isolamento entre organizações.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-habilitacao.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada, migracao088Aplicada, criarDestinatario, apagarDestinatario, responsavelDoContato } from "./helpers/comunicacao-fixtures.js";
import { interpretarHabilitacao, resolverHabilitacaoEmpresa, janelasEfetivas } from "../src/modules/comunicacao/comunicacao.habilitacao.js";
import { avaliarEnvio } from "../src/modules/comunicacao/comunicacao.policy.js";
import { MOTIVOS_BLOQUEIO, MODOS, TIPOS_ALERTA } from "../src/modules/comunicacao/comunicacao.constants.js";

const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const AGORA = new Date("2026-09-16T13:00:00Z");
const linhaOk = (extra = {}) => ({
  organizacao_id: "org-1", habilitado: true, envio_automatico: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza",
  janelas: null, pausado_ate: null, pausado_motivo: null, destinatario_contato_id: "contato-1", destinatario_contato_empresa_id: "ce-1", destinatario_perfil_id: "perfil-1", ...extra,
});

describe("interpretarHabilitacao — fail-closed (unitário)", () => {
  test("sem registro / null / undefined / lixo -> tudo fechado", () => {
    for (const linha of [null, undefined, 0, "x", []]) {
      const h = interpretarHabilitacao(linha, TIPO, AGORA);
      assert.equal(h.empresaHabilitada, false, JSON.stringify(linha));
      assert.equal(h.tipoPermitido, false);
      assert.equal(h.configHorarioValida, false);
    }
  });

  test("habilitado=false (ou qualquer coisa != true) -> fechada, mesmo com tipo listado e timezone ok", () => {
    for (const habilitado of [false, null, undefined, "true", 1, "sim"]) {
      const h = interpretarHabilitacao(linhaOk({ habilitado }), TIPO, AGORA);
      assert.equal(h.empresaHabilitada, false, String(habilitado));
      assert.equal(h.tipoPermitido, false, "tipo NÃO pode valer numa empresa fechada");
    }
  });

  test("habilitado=true + tipo NÃO permitido -> empresa habilitada, tipoPermitido=false", () => {
    const h = interpretarHabilitacao(linhaOk({ tipos_permitidos: ["outro_tipo"] }), TIPO, AGORA);
    assert.equal(h.empresaHabilitada, true);
    assert.equal(h.tipoPermitido, false);
    for (const tipos of [[], null, undefined, "dashboard_ifood_d1", {}]) {
      assert.equal(interpretarHabilitacao(linhaOk({ tipos_permitidos: tipos }), TIPO, AGORA).tipoPermitido, false, JSON.stringify(tipos));
    }
    assert.equal(interpretarHabilitacao(linhaOk(), "", AGORA).tipoPermitido, false, "tipo vazio nunca é permitido");
    assert.equal(interpretarHabilitacao(linhaOk(), null, AGORA).tipoPermitido, false);
  });

  test("habilitado=true + tipo permitido -> prossegue (habilitada, permitido, horário válido, sem pausa)", () => {
    const h = interpretarHabilitacao(linhaOk(), TIPO, AGORA);
    assert.deepEqual(
      { e: h.empresaHabilitada, t: h.tipoPermitido, p: h.empresaPausada, c: h.configHorarioValida, tz: h.timezone },
      { e: true, t: true, p: false, c: true, tz: "America/Fortaleza" },
    );
  });

  test("o ponteiro LEGADO do destinatário NÃO é mais requisito (104): os destinatários são TODOS os ativos da empresa, resolvidos no banco", () => {
    const casos = [
      { destinatario_contato_id: null }, { destinatario_contato_empresa_id: null }, { destinatario_contato_id: "" }, { destinatario_contato_empresa_id: "" },
      { destinatario_contato_id: undefined, destinatario_contato_empresa_id: undefined }, { destinatario_contato_id: 42 }, { destinatario_contato_empresa_id: {} },
    ];
    for (const extra of casos) {
      const h = interpretarHabilitacao(linhaOk(extra), TIPO, AGORA);
      assert.equal(h.empresaHabilitada, true, JSON.stringify(extra));
      assert.equal(h.tipoPermitido, true);
    }
    const h = interpretarHabilitacao(linhaOk({ destinatario_contato_id: null, destinatario_contato_empresa_id: null }), TIPO, AGORA);
    assert.equal(h.destinatarioContatoId, null);
    assert.equal(h.destinatarioContatoEmpresaId, null);
  });

  test("ENVIO AUTOMÁTICO é opt-in separado: habilitada sem envio_automatico=true -> envioAutomatico=false (habilitar não o liga)", () => {
    for (const valor of [false, null, undefined, "true", 1, 0]) {
      const h = interpretarHabilitacao(linhaOk({ envio_automatico: valor }), TIPO, AGORA);
      assert.equal(h.empresaHabilitada, true, String(valor));
      assert.equal(h.envioAutomatico, false, `envio_automatico=${JSON.stringify(valor)} não pode ligar o envio automático`);
    }
    assert.equal(interpretarHabilitacao(linhaOk({ envio_automatico: true }), TIPO, AGORA).envioAutomatico, true);
    // empresa FECHADA nunca tem envio automático, mesmo com a coluna true
    assert.equal(interpretarHabilitacao(linhaOk({ habilitado: false, envio_automatico: true }), TIPO, AGORA).envioAutomatico, false);
  });

  test("limite diário da empresa e cooldown por destinatário: só inteiros positivos valem (senão o padrão global)", () => {
    const h = interpretarHabilitacao(linhaOk({ limite_diario_org: 7, cooldown_minutos: 90 }), TIPO, AGORA);
    assert.deepEqual([h.limiteDiarioOrg, h.cooldownMinutos], [7, 90]);
    for (const ruim of [0, -1, 1.5, "7", null, undefined]) {
      const r = interpretarHabilitacao(linhaOk({ limite_diario_org: ruim, cooldown_minutos: ruim }), TIPO, AGORA);
      assert.deepEqual([r.limiteDiarioOrg, r.cooldownMinutos], [null, null], JSON.stringify(ruim));
    }
  });

  test("o responsável NÃO precisa ser usuário: sem perfil, a habilitação segue válida (migration 100)", () => {
    const h = interpretarHabilitacao(linhaOk({ destinatario_perfil_id: null }), TIPO, AGORA);
    assert.equal(h.empresaHabilitada, true);
    assert.equal(h.destinatarioContatoEmpresaId, "ce-1");
    assert.equal(h.destinatarioPerfilId, null);
  });

  test("o destinatário configurado é devolvido EXATAMENTE como está (nunca inferido de outra fonte)", () => {
    const h = interpretarHabilitacao(linhaOk({ destinatario_contato_id: "contato-B", destinatario_perfil_id: "perfil-B" }), TIPO, AGORA);
    assert.equal(h.empresaHabilitada, true);
    assert.deepEqual([h.destinatarioContatoId, h.destinatarioPerfilId], ["contato-B", "perfil-B"]);
  });

  test("registro INCOMPLETO (habilitado sem timezone) -> fechada; nunca assume UTC", () => {
    for (const timezone of [null, undefined, "", "   "]) {
      const h = interpretarHabilitacao(linhaOk({ timezone }), TIPO, AGORA);
      assert.equal(h.empresaHabilitada, false, JSON.stringify(timezone));
      assert.equal(h.timezone, null);
      assert.equal(h.configHorarioValida, false);
    }
  });

  test("timezone INVÁLIDO (offset, lixo, inexistente) -> configHorarioValida=false (a política ADIA com CONFIG_INVALIDA); nunca UTC", () => {
    for (const timezone of ["-03:00", "+03:00", "UTC+3", "GMT-3", "Mars/Olympus", "Fortaleza", "12345"]) {
      const h = interpretarHabilitacao(linhaOk({ timezone }), TIPO, AGORA);
      assert.equal(h.configHorarioValida, false, timezone);
      assert.equal(janelasEfetivas(h, { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null }), null, `${timezone}: sem janelas efetivas`);
    }
  });

  test("janelas PRÓPRIAS inválidas -> configHorarioValida=false (não cai silenciosamente na janela global)", () => {
    for (const janelas of [{ seg_sex: { inicio: "18:00", fim: "08:00" } }, { seg_sex: null, sab: null, dom: null }, { seg_sex: { inicio: "8", fim: "18" } }, []]) {
      assert.equal(interpretarHabilitacao(linhaOk({ janelas }), TIPO, AGORA).configHorarioValida, false, JSON.stringify(janelas));
    }
    const ok = interpretarHabilitacao(linhaOk({ janelas: { seg_sex: { inicio: "09:00", fim: "17:00" }, sab: null, dom: null } }), TIPO, AGORA);
    assert.equal(ok.configHorarioValida, true);
    assert.deepEqual(janelasEfetivas(ok, { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null }).seg_sex, { inicio: "09:00", fim: "17:00" }, "a janela própria vence a global");
  });

  test("pausa ATIVA (futuro) -> empresaPausada=true com pausadoAte; pausa VENCIDA -> segue normal; sem pausa -> normal", () => {
    const futuro = new Date(AGORA.getTime() + 3600_000).toISOString();
    const passado = new Date(AGORA.getTime() - 3600_000).toISOString();
    const ativa = interpretarHabilitacao(linhaOk({ pausado_ate: futuro, pausado_motivo: "manutenção" }), TIPO, AGORA);
    assert.equal(ativa.empresaPausada, true);
    assert.equal(ativa.pausadoAte.toISOString(), futuro);
    assert.equal(ativa.pausadoMotivo, "manutenção");
    assert.equal(ativa.empresaHabilitada, true, "pausa não é desabilitação");

    const vencida = interpretarHabilitacao(linhaOk({ pausado_ate: passado }), TIPO, AGORA);
    assert.equal(vencida.empresaPausada, false);
    assert.equal(vencida.pausadoAte, null);
    // exatamente no instante: a pausa terminou
    assert.equal(interpretarHabilitacao(linhaOk({ pausado_ate: AGORA.toISOString() }), TIPO, AGORA).empresaPausada, false);
  });

  test("pausado_ate ILEGÍVEL -> tratado como pausa ativa (fail-closed), sem fim conhecido", () => {
    const h = interpretarHabilitacao(linhaOk({ pausado_ate: "não-é-data" }), TIPO, AGORA);
    assert.equal(h.empresaPausada, true);
    assert.equal(h.pausadoAte, null);
  });

  test("`pausado_motivo` é só auditoria/UX: nunca decide nada", () => {
    const a = interpretarHabilitacao(linhaOk({ pausado_motivo: "qualquer coisa" }), TIPO, AGORA);
    const b = interpretarHabilitacao(linhaOk({ pausado_motivo: null }), TIPO, AGORA);
    assert.equal(a.empresaPausada, b.empresaPausada);
    assert.equal(a.empresaHabilitada, b.empresaHabilitada);
  });
});

describe("habilitado=true SOZINHO não basta — a política ainda exige o resto", () => {
  const snapshotLiberado = (h, extra = {}) => ({
    modo: MODOS.NORMAL, ehProativo: true, contatoExiste: true, telefoneVerificado: true, optOut: false, consentimento: true,
    destinatarioAtivo: true, vinculoValido: true, empresaHabilitada: h.empresaHabilitada, tipoPermitido: h.tipoPermitido, envioAutomatico: h.envioAutomatico, categoriaPermitida: true,
    empresaPausada: h.empresaPausada, configHorarioValida: h.configHorarioValida, pendenciaAindaExiste: true,
    duplicado: false, cooldownAtivo: false, rateLimitExcedido: false, dentroDaJanela: true, providerConectado: true, identidadeConfirmada: true, ...extra,
  });

  test("tudo liberado -> allowed; cada gate removido bloqueia com o motivo certo", () => {
    const h = interpretarHabilitacao(linhaOk(), TIPO, AGORA);
    assert.deepEqual(avaliarEnvio(snapshotLiberado(h)), { allowed: true, reason: null });
    assert.equal(avaliarEnvio(snapshotLiberado(h, { modo: MODOS.DISABLED })).reason, MOTIVOS_BLOQUEIO.DISABLED);
    assert.equal(avaliarEnvio(snapshotLiberado(h, { consentimento: false })).reason, MOTIVOS_BLOQUEIO.NO_CONSENT);
    assert.equal(avaliarEnvio(snapshotLiberado(h, { telefoneVerificado: false })).reason, MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED);
    assert.equal(avaliarEnvio(snapshotLiberado(h, { optOut: true })).reason, MOTIVOS_BLOQUEIO.OPT_OUT);
    assert.equal(avaliarEnvio(snapshotLiberado(h, { dentroDaJanela: false })).reason, MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW);
  });

  test("tipo não listado -> TIPO_NAO_PERMITIDO; pausa ativa -> EMPRESA_PAUSADA; timezone inválido -> CONFIG_INVALIDA; sem registro -> EMPRESA_DESABILITADA", () => {
    const tipoFora = interpretarHabilitacao(linhaOk({ tipos_permitidos: ["x"] }), TIPO, AGORA);
    assert.equal(avaliarEnvio(snapshotLiberado(tipoFora)).reason, MOTIVOS_BLOQUEIO.TIPO_NAO_PERMITIDO);
    const pausada = interpretarHabilitacao(linhaOk({ pausado_ate: new Date(AGORA.getTime() + 60_000).toISOString() }), TIPO, AGORA);
    assert.equal(avaliarEnvio(snapshotLiberado(pausada)).reason, MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA);
    const tzRuim = interpretarHabilitacao(linhaOk({ timezone: "Mars/Olympus" }), TIPO, AGORA);
    assert.equal(avaliarEnvio(snapshotLiberado(tzRuim)).reason, MOTIVOS_BLOQUEIO.CONFIG_INVALIDA);
    const semRegistro = interpretarHabilitacao(null, TIPO, AGORA);
    assert.equal(avaliarEnvio(snapshotLiberado(semRegistro)).reason, MOTIVOS_BLOQUEIO.EMPRESA_DESABILITADA);
  });

  test("os bloqueios de pausa e de configuração são TRANSITÓRIOS (adiam); desabilitada/tipo são terminais", async () => {
    const { bloqueioEhTransitorio } = await import("../src/modules/comunicacao/comunicacao.constants.js");
    assert.equal(bloqueioEhTransitorio(MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA), true);
    assert.equal(bloqueioEhTransitorio(MOTIVOS_BLOQUEIO.CONFIG_INVALIDA), true);
    assert.equal(bloqueioEhTransitorio(MOTIVOS_BLOQUEIO.EMPRESA_DESABILITADA), false);
    assert.equal(bloqueioEhTransitorio(MOTIVOS_BLOQUEIO.TIPO_NAO_PERMITIDO), false);
  });
});

describe("resolverHabilitacaoEmpresa — banco simulado (sem I/O real)", () => {
  const dbFalso = (resposta, espionar = []) => ({
    from: (tabela) => {
      const q = { tabela, filtros: {} };
      espionar.push(q);
      const cadeia = {
        select: () => cadeia,
        eq: (col, val) => { q.filtros[col] = val; return cadeia; },
        maybeSingle: async () => resposta,
      };
      return cadeia;
    },
  });

  test("sempre consulta ESCOPADO por organizacao_id (nenhuma leitura global)", async () => {
    const espiao = [];
    await resolverHabilitacaoEmpresa({ organizacaoId: "org-A", tipoAlerta: TIPO, agora: AGORA }, { supabase: dbFalso({ data: null, error: null }, espiao) });
    assert.equal(espiao.length, 1);
    assert.equal(espiao[0].tabela, "comunicacao_habilitacoes");
    assert.deepEqual(espiao[0].filtros, { organizacao_id: "org-A" });
  });

  test("sem organizacaoId (null/undefined/vazio/não-string) -> fechada e NEM consulta o banco", async () => {
    const espiao = [];
    for (const org of [null, undefined, "", 123, {}]) {
      const h = await resolverHabilitacaoEmpresa({ organizacaoId: org, tipoAlerta: TIPO }, { supabase: dbFalso({ data: linhaOk(), error: null }, espiao) });
      assert.equal(h.empresaHabilitada, false, String(org));
      assert.equal(h.fonte, "SEM_ORGANIZACAO");
    }
    assert.equal(espiao.length, 0, "consultou o banco sem organização");
  });

  test("CROSS-ORG: uma linha que pertence a OUTRA organização nunca habilita esta", async () => {
    const h = await resolverHabilitacaoEmpresa({ organizacaoId: "org-B", tipoAlerta: TIPO, agora: AGORA },
      { supabase: dbFalso({ data: linhaOk({ organizacao_id: "org-A" }), error: null }) });
    assert.equal(h.empresaHabilitada, false);
    assert.equal(h.tipoPermitido, false);
    assert.equal(h.fonte, "REGISTRO_DE_OUTRA_ORGANIZACAO");
  });

  test("erro de LEITURA propaga (não vira 'empresa desabilitada'/BLOCKED terminal por falha transitória de rede)", async () => {
    await assert.rejects(
      () => resolverHabilitacaoEmpresa({ organizacaoId: "org-A", tipoAlerta: TIPO }, { supabase: dbFalso({ data: null, error: { message: "fetch failed" } }) }),
      /fetch failed/,
    );
  });

  test("linha válida da própria organização habilita normalmente", async () => {
    const h = await resolverHabilitacaoEmpresa({ organizacaoId: "org-1", tipoAlerta: TIPO, agora: AGORA }, { supabase: dbFalso({ data: linhaOk(), error: null }) });
    assert.equal(h.empresaHabilitada, true);
    assert.equal(h.tipoPermitido, true);
    assert.equal(h.fonte, "comunicacao_habilitacoes");
  });
});

// ---------------------------------------------------------------------------
// Integração — a tabela REAL (migration 088), banco de TESTE
// ---------------------------------------------------------------------------
const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgA = null, orgB = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  if (!migracaoOk) return;
  orgA = await criarOrganizacao("TESTE habilitacao A — descartável");
  orgB = await criarOrganizacao("TESTE habilitacao B — descartável");
  destA = await criarDestinatario({ organizacaoId: orgA, tag: tagH, sufixo: "a" });
  destA2 = await criarDestinatario({ organizacaoId: orgA, tag: tagH, sufixo: "a2" });
  destB = await criarDestinatario({ organizacaoId: orgB, tag: tagH, sufixo: "b" });
  // migration 091: o destinatário é o RESPONSÁVEL DA EMPRESA (um por dest)
  ceA = await responsavelDoContato({ organizacaoId: orgA, contatoId: destA.contatoId, perfilId: destA.perfilId });
  ceA2 = await responsavelDoContato({ organizacaoId: orgA, contatoId: destA2.contatoId, perfilId: destA2.perfilId });
  ceB = await responsavelDoContato({ organizacaoId: orgB, contatoId: destB.contatoId, perfilId: destB.perfilId });
});
after(async () => {
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB); // cascade apaga as habilitações
  for (const d of [destA, destA2, destB]) await apagarDestinatario(d);
});

const inserir = (linha) => supabase.from("comunicacao_habilitacoes").insert(linha);
// destinatários EXPLÍCITOS (o banco exige: habilitado=true sem destinatário é recusado)
let destA = null, destA2 = null, destB = null, ceA = null, ceA2 = null, ceB = null;
const tagH = `hab${Date.now()}`;
const comDestA = (extra = {}) => ({ organizacao_id: orgA, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza", destinatario_contato_id: destA.contatoId, destinatario_contato_empresa_id: ceA, destinatario_perfil_id: destA.perfilId, ...extra });

describe("comunicacao_habilitacoes — tabela real (banco de TESTE)", { skip: PULAR_INTEGRACAO }, () => {
  test("SEM registro -> a organização está FECHADA (o padrão de produção)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const h = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.equal(h.empresaHabilitada, false);
    assert.equal(h.fonte, "SEM_REGISTRO");
  });

  test("a tabela nasce fechada: habilitado default false, tipos_permitidos default vazio", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const { error } = await inserir({ organizacao_id: orgA });
    assert.equal(error, null, error?.message);
    const { data } = await supabase.from("comunicacao_habilitacoes").select("*").eq("organizacao_id", orgA).single();
    assert.equal(data.habilitado, false);
    assert.deepEqual(data.tipos_permitidos, []);
    assert.equal(data.timezone, null);
    const h = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.equal(h.empresaHabilitada, false);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });

  test("o banco RECUSA habilitado sem timezone (registro incompleto) e timezone que não é IANA", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const semTz = await inserir(comDestA({ timezone: null }));
    assert.ok(semTz.error, "aceitou habilitado=true sem timezone");
    for (const timezone of ["-03:00", "UTC+3", "Mars/Olympus", "Fortaleza", ""]) {
      const r = await inserir({ organizacao_id: orgA, habilitado: false, timezone });
      assert.ok(r.error, `aceitou o timezone inválido ${JSON.stringify(timezone)}`);
    }
    const { count } = await supabase.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("organizacao_id", orgA);
    assert.equal(count, 0, "sobrou linha de um insert que deveria ter falhado");
  });

  test("habilitado + tipo permitido + timezone IANA -> prossegue; tipo não listado -> tipoPermitido=false", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const r = await inserir(comDestA());
    assert.equal(r.error, null, r.error?.message);
    const ok = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.deepEqual([ok.empresaHabilitada, ok.tipoPermitido, ok.empresaPausada, ok.configHorarioValida], [true, true, false, true]);
    const outro = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: "tipo_nao_listado" });
    assert.deepEqual([outro.empresaHabilitada, outro.tipoPermitido], [true, false]);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });

  test("pausa ATIVA adia (empresaPausada); pausa VENCIDA volta a valer; pausado_motivo só informa", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const futuro = new Date(Date.now() + 3600_000).toISOString();
    await inserir(comDestA({ pausado_ate: futuro, pausado_motivo: "teste" }));
    const ativa = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.equal(ativa.empresaPausada, true);
    assert.equal(ativa.pausadoAte.toISOString(), new Date(futuro).toISOString());
    assert.equal(ativa.empresaHabilitada, true);
    await supabase.from("comunicacao_habilitacoes").update({ pausado_ate: new Date(Date.now() - 1000).toISOString() }).eq("organizacao_id", orgA);
    const vencida = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.equal(vencida.empresaPausada, false, "a pausa vencida continua bloqueando");
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });

  test("CROSS-ORG (banco real): habilitar a organização A NUNCA habilita a B; e um `tipos_permitidos` de A não vale para B", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await inserir(comDestA());
    const a = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    const b = await resolverHabilitacaoEmpresa({ organizacaoId: orgB, tipoAlerta: TIPO });
    assert.equal(a.empresaHabilitada, true);
    assert.equal(b.empresaHabilitada, false, "a habilitação de A vazou para B");
    assert.equal(b.tipoPermitido, false);
    assert.equal(b.fonte, "SEM_REGISTRO");

    // B com registro FECHADO e timezone diferente: cada uma enxerga só o seu
    await inserir({ organizacao_id: orgB, habilitado: false, tipos_permitidos: [TIPO], timezone: "America/New_York", destinatario_contato_id: destB.contatoId, destinatario_contato_empresa_id: ceB, destinatario_perfil_id: destB.perfilId });
    const b2 = await resolverHabilitacaoEmpresa({ organizacaoId: orgB, tipoAlerta: TIPO });
    assert.equal(b2.empresaHabilitada, false);
    assert.equal(b2.tipoPermitido, false, "tipo listado numa empresa FECHADA não pode valer");
    const a2 = await resolverHabilitacaoEmpresa({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.equal(a2.timezone, "America/Fortaleza", "o timezone de B vazou para A");
    await supabase.from("comunicacao_habilitacoes").delete().in("organizacao_id", [orgA, orgB]);
  });

  test("apagar a organização apaga a habilitação (ON DELETE CASCADE) — sem linha órfã", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const org = await criarOrganizacao("TESTE habilitacao cascade — descartável");
    const destC = await criarDestinatario({ organizacaoId: org, tag: tagH, sufixo: "c" });
    const ceC = await responsavelDoContato({ organizacaoId: org, contatoId: destC.contatoId, perfilId: destC.perfilId });
    await inserir({ organizacao_id: org, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza", destinatario_contato_id: destC.contatoId, destinatario_contato_empresa_id: ceC, destinatario_perfil_id: destC.perfilId });
    await apagarOrganizacao(org);
    await apagarDestinatario(destC);
    const { count } = await supabase.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("organizacao_id", org);
    assert.equal(count, 0);
  });

  test("habilitado=true SEM ponteiro é ACEITO (104: destinatários não são mais um ponteiro), mas o envio automático nasce DESLIGADO e o banco exige coerência", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const semDest = await inserir({ organizacao_id: orgA, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" });
    assert.equal(semDest.error, null, semDest.error?.message);
    const { data } = await supabase.from("comunicacao_habilitacoes").select("habilitado, envio_automatico").eq("organizacao_id", orgA).single();
    assert.deepEqual([data.habilitado, data.envio_automatico], [true, false], "habilitar NÃO liga o envio automático");
    // o par contato/responsável incompleto continua recusado pelo banco
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
    const soContato = await inserir({ organizacao_id: orgA, habilitado: false, destinatario_contato_id: destA.contatoId });
    assert.ok(soContato.error, "aceitou o par contato/responsável incompleto");
    // envio automático sem estar habilitada é recusado (constraint)
    const autoSemHab = await inserir({ organizacao_id: orgA, habilitado: false, envio_automatico: true });
    assert.ok(autoSemHab.error, "aceitou envio_automatico=true numa empresa NÃO habilitada");
    const { count } = await supabase.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("organizacao_id", orgA);
    assert.equal(count, 0);
  });

  test("DOIS destinatários elegíveis existem -> AMBOS são resolvidos (nada é escolhido implicitamente por ordem; nenhum é ignorado)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await inserir({ organizacao_id: orgA, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" });
    const { resolverDestinatarios } = await import("../src/modules/comunicacao/comunicacao.fila.repo.js");
    const lista = await resolverDestinatarios({ organizacaoId: orgA, tipoAlerta: TIPO });
    const elegiveis = lista.filter((d) => d.elegivel).map((d) => d.contato_empresa_id).sort();
    assert.deepEqual(elegiveis, [ceA, ceA2].sort(), "todos os destinatários elegíveis da empresa devem aparecer");
    assert.ok(lista.every((d) => d.contato_empresa_id !== ceB), "destinatário de OUTRA empresa apareceu na resolução");
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });

  test("desativar um destinatário o tira da resolução; o outro segue elegível (independência)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await inserir({ organizacao_id: orgA, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" });
    const { resolverDestinatarios } = await import("../src/modules/comunicacao/comunicacao.fila.repo.js");
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", ceA);
    const lista = await resolverDestinatarios({ organizacaoId: orgA, tipoAlerta: TIPO });
    assert.deepEqual(lista.filter((d) => d.elegivel).map((d) => d.contato_empresa_id), [ceA2]);
    assert.equal(lista.find((d) => d.contato_empresa_id === ceA).motivo, "DESTINATARIO_INATIVO");
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceA);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });

  test("CROSS-ORG: o banco RECUSA o contato/perfil de OUTRA organização como destinatário (no insert e no update)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const ins = await inserir(comDestA({ destinatario_contato_id: destB.contatoId, destinatario_contato_empresa_id: ceB, destinatario_perfil_id: destB.perfilId }));
    assert.ok(ins.error, "aceitou o destinatário da organização B na A");
    assert.match(ins.error.message, /responsavel de comunicacao inexistente( , inativo)? ?ou de outra empresa|responsavel de comunicacao inexistente, inativo ou de outra empresa|foreign key/i);
    await inserir(comDestA());
    const upd = await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: destB.contatoId, destinatario_contato_empresa_id: ceB, destinatario_perfil_id: destB.perfilId }).eq("organizacao_id", orgA);
    assert.ok(upd.error, "o update trocou o destinatário para outra organização");
    const { data } = await supabase.from("comunicacao_habilitacoes").select("destinatario_contato_id").eq("organizacao_id", orgA).single();
    assert.equal(data.destinatario_contato_id, destA.contatoId, "a recusa não pode alterar a linha");
    // par inexistente (contato de A com o perfil de A2) também é recusado
    const par = await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: destA.contatoId, destinatario_contato_empresa_id: ceA2, destinatario_perfil_id: destA2.perfilId }).eq("organizacao_id", orgA);
    assert.ok(par.error, "aceitou um par contato/responsável inexistente");
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  });
});
