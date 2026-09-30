// PAINEL ADMINISTRATIVO — WhatsApp por EMPRESA (migration 104): ROUTER REAL -> controller -> service -> repository -> BANCO DE TESTE (Supabase descartável).
// Cobre: status administrativo, habilitar/desabilitar, envio_automatico, criação de destinatário, normalização do telefone, consentimento/opt-out,
// ativação/desativação, categorias, teto de destinatários ativos (banco + API + configurável), isolamento multi-tenant, limites, ENTREGA PARCIAL por
// destinatário e o dry-run pelo endpoint (zero escrita operacional). Nenhum WhatsApp real: nem existe provider neste caminho.
// PULA (não falha) sem credencial de banco descartável / sem a migration 104.
// Rodar: node --env-file=.env --env-file=.env.test-integracao --test --test-concurrency=1 test/administrativo-comunicacao-empresa-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarContaComPerfil, apagarConta, criarOrganizacao, apagarOrganizacao, criarUnidade, migracao082Aplicada, migracao088Aplicada, migracao104Aplicada,
  definirTetoDestinatariosT, restaurarTetoDestinatariosT,
} from "./helpers/comunicacao-fixtures.js";
import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { simularCiclo } from "../src/modules/comunicacao/comunicacao.dryrun.js";
import { resumirEntregaAlerta, SITUACAO_ENTREGA } from "../src/modules/comunicacao/comunicacao.entregaAlerta.js";
import { ACOES } from "../src/shared/auditoria.js";
import { TIPOS_ALERTA } from "../src/modules/comunicacao/comunicacao.constants.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";

const PULAR = motivoPularIntegracao();
const tag = `admemp${Date.now()}`;
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
let migracaoOk = true;
let conta = null, orgA = null, orgB = null, uniA = null;
let modoDeTeste = "NORMAL";
let pendenciaDoDryRun = null;
let tetoOriginal = null;
const ORGS = () => [orgA, orgB];
const criarOuObterAlerta = async ({ organizacaoId, unidadeId, data }) => (await alertasRepo.criarOuEscalonarAlerta({
  organizacaoId, unidadeId, tipoAlerta: TIPO, dataReferencia: data, destinatarioPerfilId: null, severidade: "atencao", motivo: "3 dia(s) pendente(s)", metadados: {},
})).alerta;

const USER_COMUM = { id: "11111111-1111-4111-8111-111111111111", email: "comum@teste.com", nome: "Comum", painelAdministrativo: false };
const userPainel = () => ({ id: conta.contaId, email: `${tag}@example.com`, nome: "Operador Painel", painelAdministrativo: true });

function chamar(user, metodo, path, corpo) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) { req.user = user; req.perfil = { id: conta?.perfilId ?? null, nome: user.nome }; } next(); });
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  // DB REAL (deps default); só o MODO global e a leitura de pendências do dry-run são injetados (não mexemos no modo global compartilhado).
  app.locals.adminDeps = {
    lerModo: async () => modoDeTeste,
    simularCiclo: (args, d) => simularCiclo({ ...args, lerModo: async () => modoDeTeste, lerPendencias: async () => pendenciaDoDryRun ?? ({ d1: "2026-09-15", total: 0, unidades: [], organizacoesMonitoradas: [] }) }, d),
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}
const base = (org) => `/administrativo/comunicacao/organizacoes/${org}`;
const api = (metodo, path, corpo, user = null) => chamar(user ?? userPainel(), metodo, path, corpo);
const codigoDe = (r) => r.json?.error?.details?.codigo ?? r.json?.details?.codigo ?? r.json?.codigo ?? null;
const habOrg = async (org) => (await supabase.from("comunicacao_habilitacoes").select("*").eq("organizacao_id", org).maybeSingle()).data;
const ceDaOrg = async (org) => (await supabase.from("comunicacao_contatos_empresa").select("*").eq("organizacao_id", org).order("created_at")).data ?? [];
const auditoria = async (org, acao) => ((await supabase.from("plataforma_auditoria").select("acao, detalhes, ator_id, entidade_id").eq("organizacao_id", org).eq("acao", acao)).data ?? []);
let seqTel = 0;
const telBr = () => `6299${String(Date.now() * 13 + ++seqTel * 7919).slice(-7)}`; // DDD 62 + 9 + 7 dígitos = celular válido (11 dígitos)
const e164De = (br) => `+55${br}`;

/** Cria via API (o caminho real) um destinatário e devolve id + telefone. */
async function criarViaApi(org, nome, extra = {}) {
  const tel = extra.telefone ?? telBr();
  const r = await api("POST", `${base(org)}/destinatarios`, { nome, telefone: tel, tipo: "operacional", categorias: ["pendencia_d1"], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { id: r.json.data.destinatario.id, tel, e164: e164De(String(tel).replace(/\D/g, "").replace(/^55/, "")) };
}
const autorizar = (org, id) => api("POST", `${base(org)}/destinatarios/${id}/autorizar`, { confirmacaoExplicita: true });
/** Destinatário criado E autorizado (elegível). */
async function elegivel(org, nome) { const d = await criarViaApi(org, nome); assert.equal((await autorizar(org, d.id)).status, 200); return d; }
const resolver = async (org) => (await supabase.rpc("comunicacao_resolver_destinatarios", { p_organizacao_id: org, p_tipo_alerta: TIPO })).data ?? [];
const motivoDe = async (org, id) => (await resolver(org)).find((x) => x.contato_empresa_id === id);

before(async () => {
  if (PULAR) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao104Aplicada());
  if (!migracaoOk) return;
  conta = await criarContaComPerfil(tag, "adm");
  tetoOriginal = await definirTetoDestinatariosT(5);
  orgA = await criarOrganizacao("TESTE adm-empresa A — descartável");
  orgB = await criarOrganizacao("TESTE adm-empresa B — descartável");
  uniA = await criarUnidade(orgA, "Loja Admin A");
});
after(async () => {
  if (!migracaoOk || PULAR) return;
  await restaurarTetoDestinatariosT(tetoOriginal);
  for (const org of ORGS()) {
    await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", org);
    await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", org);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", org);
  }
  const cs = (await supabase.from("comunicacao_contatos_empresa").select("contato_whatsapp_id").in("organizacao_id", ORGS())).data ?? [];
  await supabase.from("comunicacao_contatos_empresa").delete().in("organizacao_id", ORGS());
  const ids = cs.map((c) => c.contato_whatsapp_id).filter(Boolean);
  if (ids.length) await supabase.from("contatos_whatsapp").delete().in("id", ids);
  await supabase.from("plataforma_auditoria").delete().in("organizacao_id", ORGS());
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB);
  await apagarConta(conta?.contaId);
});
beforeEach(async () => {
  if (PULAR || !migracaoOk) return;
  modoDeTeste = "NORMAL"; pendenciaDoDryRun = null;
  await supabase.from("plataforma_auditoria").delete().in("organizacao_id", ORGS());
  await definirTetoDestinatariosT(5);
  for (const org of ORGS()) {
    await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", org);
    await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", org);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", org);
  }
  const cs = (await supabase.from("comunicacao_contatos_empresa").select("contato_whatsapp_id").in("organizacao_id", ORGS())).data ?? [];
  await supabase.from("comunicacao_contatos_empresa").delete().in("organizacao_id", ORGS());
  const ids = cs.map((c) => c.contato_whatsapp_id).filter(Boolean);
  if (ids.length) await supabase.from("contatos_whatsapp").delete().in("id", ids);
});
const pular = (t) => { if (!migracaoOk) { t.skip("migration 104 ainda não aplicada — pulando."); return true; } return false; };
const configurarEmpresa = (org, extra = {}) => supabase.from("comunicacao_habilitacoes").upsert({ organizacao_id: org, habilitado: false, envio_automatico: false, tipos_permitidos: [TIPO], timezone: "America/Fortaleza", ...extra }, { onConflict: "organizacao_id" });

// ---------------------------------------------------------------------------
describe("autorização — só o Painel Administrativo, em todas as rotas novas", { skip: PULAR }, () => {
  test("usuário comum e sem sessão: 403/401 em TODAS as rotas de empresa; nada é criado nem alterado", async (t) => {
    if (pular(t)) return;
    const d = await elegivel(orgA, "João");
    const rotas = [
      ["GET", `${base(orgA)}/whatsapp`], ["POST", `${base(orgA)}/destinatarios`, { nome: "X", telefone: telBr(), categorias: ["pendencia_d1"] }],
      ["PUT", `${base(orgA)}/destinatarios/${d.id}`, { nome: "Y" }], ["PUT", `${base(orgA)}/destinatarios/${d.id}/categorias`, { categorias: [] }],
      ["PUT", `${base(orgA)}/destinatarios/${d.id}/ativo`, { ativo: false }], ["POST", `${base(orgA)}/destinatarios/${d.id}/autorizar`, { confirmacaoExplicita: true }],
      ["POST", `${base(orgA)}/destinatarios/${d.id}/opt-out`, { confirmacaoExplicita: true }], ["PUT", `${base(orgA)}/envio-automatico`, { ligar: true, confirmacaoExplicita: true }],
      ["PUT", `${base(orgA)}/limites`, { limiteDiarioOrg: 5 }], ["POST", `${base(orgA)}/dry-run`, {}], ["PUT", `${base(orgA)}/habilitacao`, { habilitado: true, confirmacaoExplicita: true }],
    ];
    for (const [m, p, c] of rotas) {
      assert.equal((await chamar(USER_COMUM, m, p, c)).status, 403, `${m} ${p}`);
      assert.ok([401, 403].includes((await chamar(null, m, p, c)).status), `sem sessão ${m} ${p}`);
    }
    const [linha] = await ceDaOrg(orgA);
    assert.equal(linha.nome, "João"); assert.equal(linha.ativo, true);
    assert.equal((await ceDaOrg(orgA)).length, 1);
    assert.equal(await habOrg(orgA), null);
  });
});

// ---------------------------------------------------------------------------
describe("leitura do status administrativo (GET .../whatsapp)", { skip: PULAR }, () => {
  test("empresa sem nada: 'WhatsApp desativado'; nenhum telefone completo na resposta; diagnóstico LEGACY sem valores", async (t) => {
    if (pular(t)) return;
    const r = await api("GET", `${base(orgA)}/whatsapp`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.status.codigo, "DESATIVADO_PARA_EMPRESA");
    assert.equal(r.json.data.status.envioAutomatico, false);
    assert.deepEqual(r.json.data.destinatarios, []);
    assert.deepEqual(r.json.data.alertasRecentes, []);
    assert.equal(r.json.data.diagnostico.pilotoLegado.semEfeito, true);
    assert.match(r.json.data.diagnostico.pilotoLegado.rotulo, /LEGACY/);
    assert.equal(r.json.data.configuracao.tetoDestinatariosAtivos, 5);
    assert.deepEqual(r.json.data.categoriasDisponiveis.map((c) => c.codigo).includes("pendencia_d1"), true);
  });

  test("precedência do status: incompleta -> sem ativos -> envio automático desligado -> pausada -> modo global DISABLED -> ATIVO", async (t) => {
    if (pular(t)) return;
    const status = async () => (await api("GET", `${base(orgA)}/whatsapp`)).json.data.status;
    await configurarEmpresa(orgA, { habilitado: true });
    assert.equal((await status()).codigo, "CONFIGURACAO_INCOMPLETA");           // habilitada, sem destinatário
    const d = await criarViaApi(orgA, "João");
    assert.equal((await status()).codigo, "CONFIGURACAO_INCOMPLETA");           // ativo, mas ainda sem WhatsApp validado
    await autorizar(orgA, d.id);
    assert.equal((await status()).codigo, "ENVIO_AUTOMATICO_DESLIGADO");
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: true, pausado_ate: new Date(Date.now() + 3_600_000).toISOString() }).eq("organizacao_id", orgA);
    assert.equal((await status()).codigo, "EMPRESA_PAUSADA");
    await supabase.from("comunicacao_habilitacoes").update({ pausado_ate: null }).eq("organizacao_id", orgA);
    modoDeTeste = "DISABLED";
    const s = await status();
    assert.equal(s.codigo, "ENVIO_GLOBAL_DESATIVADO"); assert.equal(s.envioRealPermitido, false); assert.equal(s.modoGlobal, "DISABLED");
    modoDeTeste = "NORMAL";
    const ok = await status();
    assert.equal(ok.codigo, "ATIVO"); assert.equal(ok.destinatariosAtivos, 1); assert.equal(ok.envioAutomatico, true);
    await api("PUT", `${base(orgA)}/destinatarios/${d.id}/ativo`, { ativo: false });
    assert.equal((await status()).codigo, "SEM_DESTINATARIOS_ATIVOS");
  });

  test("organização inexistente -> 404; id inválido -> 400", async (t) => {
    if (pular(t)) return;
    assert.equal((await api("GET", `${base("99999999-9999-4999-8999-999999999999")}/whatsapp`)).status, 404);
    assert.equal((await api("GET", `${base("nao-e-uuid")}/whatsapp`)).status, 400);
  });
});

// ---------------------------------------------------------------------------
describe("habilitar/desabilitar a empresa e envio_automatico", { skip: PULAR }, () => {
  test("habilitar: exige confirmação e um destinatário ELEGÍVEL; habilitar NÃO liga o envio automático; auditado", async (t) => {
    if (pular(t)) return;
    await configurarEmpresa(orgA);
    const hab = (corpo) => api("PUT", `${base(orgA)}/habilitacao`, corpo);
    assert.equal((await hab({ habilitado: true })).status, 400);
    assert.equal((await hab({ habilitado: true, confirmacaoExplicita: true })).status, 409);           // sem destinatário
    const d = await criarViaApi(orgA, "João");
    const r2 = await hab({ habilitado: true, confirmacaoExplicita: true });
    assert.equal(r2.status, 409, "destinatário ainda não autorizado");
    await autorizar(orgA, d.id);
    const r3 = await hab({ habilitado: true, confirmacaoExplicita: true });
    assert.equal(r3.status, 200, JSON.stringify(r3.json));
    const h = await habOrg(orgA);
    assert.equal(h.habilitado, true); assert.equal(h.envio_automatico, false, "habilitar não liga envio automático");
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_ORGANIZACAO_HABILITADA)).length >= 1);
    assert.equal((await hab({ habilitado: true, confirmacaoExplicita: true })).json.data.alterou, false, "idempotente");
  });

  test("envio automático: 400 sem confirmação; 409 sem empresa habilitada / sem destinatário elegível; liga; desliga; desabilitar a empresa desliga também", async (t) => {
    if (pular(t)) return;
    await configurarEmpresa(orgA);
    const auto = (corpo) => api("PUT", `${base(orgA)}/envio-automatico`, corpo);
    assert.equal((await auto({ ligar: "sim", confirmacaoExplicita: true })).status, 400);
    assert.equal((await auto({ ligar: true })).status, 400);
    let r = await auto({ ligar: true, confirmacaoExplicita: true });
    assert.equal(r.status, 409); assert.equal(codigoDe(r), "EMPRESA_NAO_HABILITADA");
    await configurarEmpresa(orgA, { habilitado: true });
    r = await auto({ ligar: true, confirmacaoExplicita: true });
    assert.equal(r.status, 409); assert.equal(codigoDe(r), "SEM_DESTINATARIO_ELEGIVEL");
    await elegivel(orgA, "João");
    r = await auto({ ligar: true, confirmacaoExplicita: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await habOrg(orgA)).envio_automatico, true);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_ENVIO_AUTOMATICO_LIGADO)).length >= 1);
    r = await auto({ ligar: false });
    assert.equal(r.status, 200); assert.equal((await habOrg(orgA)).envio_automatico, false);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_ENVIO_AUTOMATICO_DESLIGADO)).length >= 1);
    await auto({ ligar: true, confirmacaoExplicita: true });
    const off = await api("PUT", `${base(orgA)}/habilitacao`, { habilitado: false });
    assert.equal(off.status, 200);
    const h = await habOrg(orgA);
    assert.deepEqual([h.habilitado, h.envio_automatico], [false, false], "desabilitar a empresa também desliga o envio automático");
  });

  test("o banco recusa envio_automatico=true em empresa NÃO habilitada (constraint), mesmo por escrita direta", async (t) => {
    if (pular(t)) return;
    const { error } = await supabase.from("comunicacao_habilitacoes").upsert({ organizacao_id: orgA, habilitado: false, envio_automatico: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" }, { onConflict: "organizacao_id" });
    assert.ok(error, "deveria violar automatico_exige_habilitado");
    assert.match(error.message, /automatico_exige_habilitado/);
  });
});

// ---------------------------------------------------------------------------
describe("destinatários — criação, normalização do telefone e validações", { skip: PULAR }, () => {
  test("formatos diferentes do MESMO número normalizam para o mesmo E.164; a resposta só traz telefone mascarado", async (t) => {
    if (pular(t)) return;
    const digitos = telBr();
    const formatos = [digitos, `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`, `+55 ${digitos.slice(0, 2)} ${digitos.slice(2, 7)}-${digitos.slice(7)}`, `55${digitos}`];
    const primeiro = await api("POST", `${base(orgA)}/destinatarios`, { nome: "Fmt 0", telefone: formatos[0], categorias: ["pendencia_d1"] });
    assert.equal(primeiro.status, 201, JSON.stringify(primeiro.json));
    assert.match(primeiro.json.data.destinatario.telefoneMascarado, /^\*{8}\d{2}$/);
    assert.doesNotMatch(JSON.stringify(primeiro.json), new RegExp(digitos));
    assert.equal((await ceDaOrg(orgA))[0].telefone_e164, e164De(digitos));
    for (const f of formatos.slice(1)) {
      const dup = await api("POST", `${base(orgA)}/destinatarios`, { nome: "Dup", telefone: f, categorias: ["pendencia_d1"] });
      assert.equal(dup.status, 409, `formato ${f} deveria ser reconhecido como o mesmo número`);
      assert.equal(codigoDe(dup), "DESTINATARIO_DUPLICADO");
    }
    assert.equal((await ceDaOrg(orgA)).length, 1);
  });

  test("telefones inválidos -> 400 TELEFONE_INVALIDO, nada criado", async (t) => {
    if (pular(t)) return;
    for (const telefone of ["abc", "", "123", "11111111111", "6199999999", "05991234567", "62891234567", "+55 62 9999-9999-9999"]) {
      const r = await api("POST", `${base(orgA)}/destinatarios`, { nome: "Inv", telefone, categorias: ["pendencia_d1"] });
      assert.equal(r.status, 400, `telefone ${JSON.stringify(telefone)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.equal((await ceDaOrg(orgA)).length, 0);
  });

  test("validações de corpo: nome vazio, tipo inválido, categorias ausentes/vazias/inexistentes -> 400", async (t) => {
    if (pular(t)) return;
    const post = (c) => api("POST", `${base(orgA)}/destinatarios`, { telefone: telBr(), categorias: ["pendencia_d1"], nome: "Ok", ...c });
    assert.equal((await post({ nome: "   " })).status, 400);
    assert.equal((await post({ tipo: "chefe" })).status, 400);
    assert.equal((await post({ categorias: undefined })).status, 400);
    assert.equal((await post({ categorias: [] })).status, 400);
    assert.equal((await post({ categorias: ["nao_existe"] })).status, 400);
    assert.equal((await post({ categorias: "pendencia_d1" })).status, 400);
    assert.equal((await ceDaOrg(orgA)).length, 0);
  });

  test("nasce ATIVO, AGUARDANDO_VALIDACAO, sem consentimento/verificação e INELEGÍVEL; auditado sem o telefone completo", async (t) => {
    if (pular(t)) return;
    const d = await criarViaApi(orgA, "João");
    const [ce] = await ceDaOrg(orgA);
    assert.deepEqual([ce.ativo, ce.whatsapp_status], [true, "AGUARDANDO_VALIDACAO"]);
    const ct = (await supabase.from("contatos_whatsapp").select("consentimento, verificado, opt_out").eq("id", ce.contato_whatsapp_id).single()).data;
    assert.deepEqual([ct.consentimento, ct.verificado, ct.opt_out], [false, false, false]);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, false);
    const aud = (await auditoria(orgA, ACOES.COMUNICACAO_DESTINATARIO_CRIADO)).filter((a) => a.detalhes?.categorias?.length && a.entidade_id === d.id);
    assert.equal(aud.length, 1);
    assert.doesNotMatch(JSON.stringify(aud), new RegExp(d.tel.slice(-8)), "telefone completo nunca na auditoria");
    assert.match(aud[0].detalhes.telefone_mascarado, /\*+\d{2}$/);
  });

  test("editar: trocar o telefone INVALIDA a autorização (volta a AGUARDANDO_VALIDACAO); editar só o nome preserva", async (t) => {
    if (pular(t)) return;
    const d = await elegivel(orgA, "João");
    assert.equal((await motivoDe(orgA, d.id)).elegivel, true);
    let r = await api("PUT", `${base(orgA)}/destinatarios/${d.id}`, { nome: "João Silva" });
    assert.equal(r.status, 200); assert.equal(r.json.data.telefoneAlterado, false);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, true);
    r = await api("PUT", `${base(orgA)}/destinatarios/${d.id}`, { telefone: telBr() });
    assert.equal(r.status, 200); assert.equal(r.json.data.telefoneAlterado, true);
    const m = await motivoDe(orgA, d.id);
    assert.equal(m.elegivel, false);
    assert.ok(["WHATSAPP_NAO_VALIDADO", "TELEFONE_NAO_VERIFICADO", "SEM_CONSENTIMENTO"].includes(m.motivo), m.motivo);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_DESTINATARIO_NUMERO_ALTERADO)).length >= 1);
    assert.equal((await api("PUT", `${base(orgA)}/destinatarios/${d.id}`, { telefone: "lixo" })).status, 400);
  });
});

// ---------------------------------------------------------------------------
describe("consentimento, opt-out, ativação e categorias", { skip: PULAR }, () => {
  test("autorizar exige confirmação explícita; registra quem/quando; só então o destinatário fica elegível", async (t) => {
    if (pular(t)) return;
    const d = await criarViaApi(orgA, "João");
    assert.equal((await api("POST", `${base(orgA)}/destinatarios/${d.id}/autorizar`, {})).status, 400);
    assert.equal((await api("POST", `${base(orgA)}/destinatarios/${d.id}/autorizar`, { confirmacaoExplicita: "true" })).status, 400);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, false);
    assert.equal((await autorizar(orgA, d.id)).status, 200);
    const [ce] = await ceDaOrg(orgA);
    assert.equal(ce.whatsapp_status, "VALIDADO"); assert.ok(ce.autorizacao_registrada_em); assert.equal(ce.autorizacao_registrada_por, conta.perfilId);
    const ct = (await supabase.from("contatos_whatsapp").select("consentimento, verificado").eq("id", ce.contato_whatsapp_id).single()).data;
    assert.deepEqual([ct.consentimento, ct.verificado], [true, true]);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, true);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_DESTINATARIO_AUTORIZADO)).length >= 1);
  });

  test("opt-out: exige confirmação; bloqueia SÓ aquele destinatário (motivo OPT_OUT) e os outros continuam elegíveis", async (t) => {
    if (pular(t)) return;
    const joao = await elegivel(orgA, "João"), maria = await elegivel(orgA, "Maria");
    assert.equal((await api("POST", `${base(orgA)}/destinatarios/${joao.id}/opt-out`, {})).status, 400);
    assert.equal((await api("POST", `${base(orgA)}/destinatarios/${joao.id}/opt-out`, { confirmacaoExplicita: true })).status, 200);
    assert.deepEqual([(await motivoDe(orgA, joao.id)).elegivel, (await motivoDe(orgA, joao.id)).motivo], [false, "OPT_OUT"]);
    assert.equal((await motivoDe(orgA, maria.id)).elegivel, true);
    const painel = (await api("GET", `${base(orgA)}/whatsapp`)).json.data;
    assert.equal(painel.destinatarios.find((x) => x.id === joao.id).optOut, true);
    assert.equal(painel.destinatarios.find((x) => x.id === maria.id).optOut, false);
  });

  test("ativar/desativar: desativado fica DESTINATARIO_INATIVO na hora; reativar volta a elegível; valor não booleano -> 400", async (t) => {
    if (pular(t)) return;
    const d = await elegivel(orgA, "João");
    const ativo = (v) => api("PUT", `${base(orgA)}/destinatarios/${d.id}/ativo`, { ativo: v });
    assert.equal((await ativo("nao")).status, 400);
    const off = await ativo(false);
    assert.equal(off.status, 200); assert.equal(off.json.data.alterou, true);
    assert.equal((await motivoDe(orgA, d.id)).motivo, "DESTINATARIO_INATIVO");
    assert.equal((await ativo(false)).json.data.alterou, false, "idempotente");
    assert.equal((await ativo(true)).status, 200);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, true);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_DESTINATARIO_DESATIVADO)).length >= 1);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_DESTINATARIO_ATIVADO)).length >= 1);
  });

  test("categorias: PUT define EXATAMENTE o conjunto; vazio -> CATEGORIA_NAO_HABILITADA; inexistente -> 400; auditado", async (t) => {
    if (pular(t)) return;
    const d = await elegivel(orgA, "João");
    const put = (categorias) => api("PUT", `${base(orgA)}/destinatarios/${d.id}/categorias`, { categorias });
    let r = await put([]);
    assert.equal(r.status, 200); assert.deepEqual(r.json.data.desabilitadas, ["pendencia_d1"]);
    assert.equal((await motivoDe(orgA, d.id)).motivo, "CATEGORIA_NAO_HABILITADA");
    assert.equal((await put(["nao_existe"])).status, 400);
    assert.equal((await put("pendencia_d1")).status, 400);
    r = await put(["pendencia_d1", "pendencia_d1"]);
    assert.equal(r.status, 200); assert.deepEqual(r.json.data.habilitadas, ["pendencia_d1"]);
    assert.equal((await motivoDe(orgA, d.id)).elegivel, true);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_CATEGORIA_DESABILITADA)).length >= 1);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_CATEGORIA_HABILITADA)).length >= 1);
  });
});

// ---------------------------------------------------------------------------
describe("limite de destinatários ATIVOS por empresa (5, configurável) — API e banco", { skip: PULAR }, () => {
  test("6º ativo -> 409 LIMITE_DESTINATARIOS; desativar libera vaga; reativar acima do teto -> 409; nada mudou nas recusas", async (t) => {
    if (pular(t)) return;
    const ds = [];
    for (let i = 1; i <= 5; i++) ds.push(await criarViaApi(orgA, `D${i}`));
    let r = await api("POST", `${base(orgA)}/destinatarios`, { nome: "D6", telefone: telBr(), categorias: ["pendencia_d1"] });
    assert.equal(r.status, 409); assert.equal(codigoDe(r), "LIMITE_DESTINATARIOS");
    assert.equal((await ceDaOrg(orgA)).length, 5);
    assert.equal((await api("PUT", `${base(orgA)}/destinatarios/${ds[0].id}/ativo`, { ativo: false })).status, 200);
    const d6 = await criarViaApi(orgA, "D6");                                       // vaga liberada
    r = await api("PUT", `${base(orgA)}/destinatarios/${ds[0].id}/ativo`, { ativo: true });
    assert.equal(r.status, 409, "reativar com 5 já ativos estoura o teto");
    assert.equal((await supabase.from("comunicacao_contatos_empresa").select("ativo").eq("id", ds[0].id).single()).data.ativo, false);
    assert.ok(d6.id);
  });

  test("o BANCO impõe o teto sozinho (trigger), mesmo com escrita direta que ignora a API", async (t) => {
    if (pular(t)) return;
    for (let i = 1; i <= 5; i++) await criarViaApi(orgA, `D${i}`);
    const { data: ct } = await supabase.from("contatos_whatsapp").insert({ telefone_e164: e164De(telBr()), verificado: false, consentimento: false, opt_out: false }).select("id, telefone_e164").single();
    const { error } = await supabase.from("comunicacao_contatos_empresa").insert({ organizacao_id: orgA, nome: "Direto", telefone_e164: ct.telefone_e164, tipo: "secundario", contato_whatsapp_id: ct.id, whatsapp_status: "AGUARDANDO_VALIDACAO", ativo: true });
    assert.ok(error, "trigger deveria recusar o 6º ativo");
    assert.match(error.message, /MAX_DESTINATARIOS_ATIVOS|limite/i);
    const { error: e2 } = await supabase.from("comunicacao_contatos_empresa").insert({ organizacao_id: orgA, nome: "Direto inativo", telefone_e164: ct.telefone_e164, tipo: "secundario", contato_whatsapp_id: ct.id, whatsapp_status: "AGUARDANDO_VALIDACAO", ativo: false });
    assert.equal(e2, null, "inativos não contam para o teto");
    await supabase.from("contatos_whatsapp").delete().eq("id", ct.id);
  });

  test("o teto é CONFIGURÁVEL (comunicacao_configuracoes.destinatarios): com 2, o 3º é recusado; a API lê o novo valor; o teto é POR empresa", async (t) => {
    if (pular(t)) return;
    await definirTetoDestinatariosT(2);
    await criarViaApi(orgA, "D1"); await criarViaApi(orgA, "D2");
    const r = await api("POST", `${base(orgA)}/destinatarios`, { nome: "D3", telefone: telBr(), categorias: ["pendencia_d1"] });
    assert.equal(r.status, 409); assert.equal(codigoDe(r), "LIMITE_DESTINATARIOS");
    assert.match(JSON.stringify(r.json), /limite de 2 destinat/);
    assert.equal((await api("GET", `${base(orgA)}/whatsapp`)).json.data.configuracao.tetoDestinatariosAtivos, 2);
    await criarViaApi(orgB, "B1");                                                   // outra empresa tem o seu próprio teto
    await criarViaApi(orgB, "B2");
  });
});

// ---------------------------------------------------------------------------
describe("isolamento MULTI-TENANT", { skip: PULAR }, () => {
  test("destinatário da empresa A usado pela URL da empresa B: 404 em TODAS as operações, e A permanece intacta", async (t) => {
    if (pular(t)) return;
    const a = await elegivel(orgA, "João de A");
    const antes = (await ceDaOrg(orgA))[0];
    const ops = [
      ["PUT", `${base(orgB)}/destinatarios/${a.id}`, { nome: "Sequestrado" }],
      ["PUT", `${base(orgB)}/destinatarios/${a.id}/categorias`, { categorias: [] }],
      ["PUT", `${base(orgB)}/destinatarios/${a.id}/ativo`, { ativo: false }],
      ["POST", `${base(orgB)}/destinatarios/${a.id}/autorizar`, { confirmacaoExplicita: true }],
      ["POST", `${base(orgB)}/destinatarios/${a.id}/opt-out`, { confirmacaoExplicita: true }],
    ];
    for (const [m, p, c] of ops) assert.equal((await api(m, p, c)).status, 404, `${m} ${p}`);
    const depois = (await ceDaOrg(orgA))[0];
    assert.deepEqual([depois.nome, depois.ativo, depois.whatsapp_status], [antes.nome, antes.ativo, antes.whatsapp_status]);
    assert.equal((await motivoDe(orgA, a.id)).elegivel, true, "categorias/opt-out/ativo de A não mudaram");
    assert.deepEqual((await api("GET", `${base(orgB)}/whatsapp`)).json.data.destinatarios, [], "B não enxerga destinatário de A");
  });

  test("mesmo telefone em duas empresas é permitido (cada uma com o seu cadastro); habilitação, envio automático e limites são POR empresa", async (t) => {
    if (pular(t)) return;
    const tel = telBr();
    await criarViaApi(orgA, "Em A", { telefone: tel }); await criarViaApi(orgB, "Em B", { telefone: tel });
    await configurarEmpresa(orgA, { habilitado: true }); await configurarEmpresa(orgB, { habilitado: true });
    const [ceA] = await ceDaOrg(orgA);
    await autorizar(orgA, ceA.id);
    assert.equal((await api("PUT", `${base(orgA)}/envio-automatico`, { ligar: true, confirmacaoExplicita: true })).status, 200);
    assert.equal((await habOrg(orgB)).envio_automatico, false, "ligar em A não liga B");
    assert.equal((await api("PUT", `${base(orgA)}/limites`, { limiteDiarioOrg: 7, cooldownMinutos: 45 })).status, 200);
    const hb = await habOrg(orgB);
    assert.deepEqual([hb.limite_diario_org, hb.cooldown_minutos], [null, null], "limites de A não vazam para B");
    assert.equal((await api("PUT", `${base(orgA)}/habilitacao`, { habilitado: false })).status, 200);
    assert.equal((await habOrg(orgB)).habilitado, true, "desabilitar A não desabilita B");
  });

  test("leitura: os alertas recentes de A não aparecem no painel de B", async (t) => {
    if (pular(t)) return;
    const a = await criarOuObterAlerta({ organizacaoId: orgA, unidadeId: uniA, data: "2026-08-02" });
    assert.ok(a.id);
    assert.equal((await api("GET", `${base(orgA)}/whatsapp`)).json.data.alertasRecentes.length, 1);
    assert.equal((await api("GET", `${base(orgB)}/whatsapp`)).json.data.alertasRecentes.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("limites por empresa", { skip: PULAR }, () => {
  test("valores válidos gravam e auditam; null volta ao padrão global; inválidos -> 400; corpo vazio -> 400", async (t) => {
    if (pular(t)) return;
    await configurarEmpresa(orgA);
    const put = (c) => api("PUT", `${base(orgA)}/limites`, c);
    let r = await put({ limiteDiarioOrg: 12, cooldownMinutos: 90 });
    assert.equal(r.status, 200); assert.deepEqual([r.json.data.limiteDiarioOrg, r.json.data.cooldownMinutos], [12, 90]);
    let h = await habOrg(orgA);
    assert.deepEqual([h.limite_diario_org, h.cooldown_minutos], [12, 90]);
    assert.ok((await auditoria(orgA, ACOES.COMUNICACAO_LIMITES_ALTERADOS)).length >= 1);
    r = await put({ limiteDiarioOrg: null });
    assert.equal(r.status, 200); h = await habOrg(orgA);
    assert.deepEqual([h.limite_diario_org, h.cooldown_minutos], [null, 90], "só o campo enviado muda");
    for (const c of [{ limiteDiarioOrg: 0 }, { limiteDiarioOrg: -3 }, { limiteDiarioOrg: 1.5 }, { cooldownMinutos: "x" }, { limiteDiarioOrg: 1_000_000 }, {}]) {
      assert.equal((await put(c)).status, 400, JSON.stringify(c));
    }
    const painel = (await api("GET", `${base(orgA)}/whatsapp`)).json.data.configuracao.limites;
    assert.equal(painel.cooldownMinutos, 90); assert.equal(painel.limiteDiarioOrg, null);
    assert.ok(painel.padraoGlobal.maxPorOrganizacaoPorDia >= 1);
  });
});

// ---------------------------------------------------------------------------
describe("ENTREGA PARCIAL por destinatário — nunca escondida (o alerta agregado continua 'enviado')", { skip: PULAR }, () => {
  const msg = async ({ alertaId, org, unidade, d, status, erro = null, proposito = "inicial" }) => {
    const ce = (await supabase.from("comunicacao_contatos_empresa").select("contato_whatsapp_id").eq("id", d.id).single()).data;
    // nasce SCHEDULED e transita (como no pipeline real): o trigger que agrega o status do alerta dispara na transição.
    const { data: nova, error } = await supabase.from("comunicacao_mensagens").insert({
      alerta_id: alertaId, organizacao_id: org, unidade_id: unidade, contato_id: ce.contato_whatsapp_id, contato_empresa_id: d.id, canal: "whatsapp", direcao: "saida",
      tipo: TIPO, conteudo: "x", idempotency_key: `parc-${crypto.randomUUID()}`, status: "SCHEDULED", metadados: { proposito }, disponivel_em: new Date().toISOString(),
    }).select("id").single();
    assert.equal(error, null, error?.message);
    if (status !== "SCHEDULED") {
      const { error: e2 } = await supabase.from("comunicacao_mensagens").update({ status, erro }).eq("id", nova.id);
      assert.equal(e2, null, e2?.message);
    }
  };

  test("João enviado + Maria falha permanente: alerta SENT (sem reprocessar), mas a API mostra 'Entregue parcialmente — 1 de 2' com contagens separadas", async (t) => {
    if (pular(t)) return;
    const joao = await elegivel(orgA, "João"), maria = await elegivel(orgA, "Maria");
    const alerta = await criarOuObterAlerta({ organizacaoId: orgA, unidadeId: uniA, data: "2026-08-03" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: joao, status: "SENT" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: maria, status: "FAILED" });
    assert.equal((await supabase.from("comunicacao_alertas").select("status").eq("id", alerta.id).single()).data.status, "SENT", "máquina de estados do alerta inalterada");
    const antes = (await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA)).count;
    const r = await api("GET", `${base(orgA)}/whatsapp`);
    const e = r.json.data.alertasRecentes[0].entrega;
    assert.equal(r.json.data.alertasRecentes[0].status, "SENT");
    assert.equal(e.situacao, "PARCIAL");
    assert.match(e.rotulo, /Entregue parcialmente — 1 de 2 destinatários receberam/);
    assert.deepEqual([e.previstos, e.enviados, e.pendentes, e.falhaPermanente, e.optOut, e.bloqueados], [2, 1, 0, 1, 0, 0]);
    assert.equal((await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA)).count, antes, "ler NÃO cria nem reenvia nada");
  });

  test("com opt-out, bloqueio de política e pendente: contagens separadas e situação 'parcial em andamento'", async (t) => {
    if (pular(t)) return;
    const [a, b, c, d] = [await elegivel(orgA, "A"), await elegivel(orgA, "B"), await elegivel(orgA, "C"), await elegivel(orgA, "D")];
    const alerta = await criarOuObterAlerta({ organizacaoId: orgA, unidadeId: uniA, data: "2026-08-04" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: a, status: "DELIVERED" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: b, status: "BLOCKED", erro: "OPT_OUT" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: c, status: "BLOCKED", erro: "CATEGORIA_NAO_PERMITIDA" });
    await msg({ alertaId: alerta.id, org: orgA, unidade: uniA, d: d, status: "SCHEDULED" });
    const e = (await api("GET", `${base(orgA)}/whatsapp`)).json.data.alertasRecentes[0].entrega;
    assert.deepEqual([e.previstos, e.enviados, e.entreguesConfirmados, e.pendentes, e.optOut, e.bloqueados, e.falhaPermanente], [4, 1, 1, 1, 1, 1, 0]);
    assert.equal(e.situacao, "PARCIAL_EM_ANDAMENTO");
  });

  test("resumirEntregaAlerta (pura): tabela de situações; reforço nunca entra na conta; sem reenvio implícito", () => {
    const S = (...s) => s.map((status) => ({ status, direcao: "saida", metadados: {} }));
    const casos = [
      [[], SITUACAO_ENTREGA.SEM_MENSAGENS], [S("SENT"), SITUACAO_ENTREGA.COMPLETA], [S("SENT", "READ"), SITUACAO_ENTREGA.COMPLETA],
      [S("SENT", "FAILED"), SITUACAO_ENTREGA.PARCIAL], [S("SENT", "BLOCKED"), SITUACAO_ENTREGA.PARCIAL], [S("DELIVERED", "CANCELLED"), SITUACAO_ENTREGA.PARCIAL],
      [S("SENT", "SCHEDULED"), SITUACAO_ENTREGA.PARCIAL_EM_ANDAMENTO], [S("SENT", "DELIVERY_UNKNOWN"), SITUACAO_ENTREGA.PARCIAL_EM_ANDAMENTO],
      [S("SCHEDULED", "SCHEDULED"), SITUACAO_ENTREGA.PENDENTE], [S("DELIVERY_UNKNOWN"), SITUACAO_ENTREGA.INCERTA],
      [S("FAILED", "FAILED"), SITUACAO_ENTREGA.SEM_ENTREGA], [S("BLOCKED", "FAILED"), SITUACAO_ENTREGA.SEM_ENTREGA],
    ];
    for (const [ms, esperado] of casos) assert.equal(resumirEntregaAlerta(ms).situacao, esperado, ms.map((m) => m.status).join(","));
    const comReforco = [...S("SENT"), { status: "FAILED", direcao: "saida", metadados: { proposito: "reforco" } }, { status: "SENT", direcao: "entrada", metadados: {} }];
    const r = resumirEntregaAlerta(comReforco);
    assert.deepEqual([r.previstos, r.enviados, r.falhaPermanente, r.situacao], [1, 1, 0, "COMPLETA"]);
    assert.equal(resumirEntregaAlerta(undefined).situacao, "SEM_MENSAGENS");
  });
});

// ---------------------------------------------------------------------------
describe("DRY-RUN pelo endpoint administrativo — somente leitura", { skip: PULAR }, () => {
  const contagens = async () => {
    const n = async (tabela, col = "organizacao_id") => (await supabase.from(tabela).select("*", { count: "exact", head: true }).in(col, ORGS())).count;
    return {
      alertas: await n("comunicacao_alertas"), mensagens: await n("comunicacao_mensagens"), destinatarios: await n("comunicacao_contatos_empresa"),
      categorias: await n("comunicacao_destinatario_categorias"), habilitacoes: await n("comunicacao_habilitacoes"),
      tentativas: (await supabase.from("comunicacao_tentativas").select("*", { count: "exact", head: true })).count,
    };
  };
  const pendencia = () => ({ d1: "2026-09-15", total: 1, unidades: [{ organizacaoId: orgA, unidadeId: uniA, unidadeNome: "Loja Admin A", empresaNome: "Rede A", criticidade: "atencao", pendenciaMaisAntiga: "2026-09-10", diasPendentes: 3 }], organizacoesMonitoradas: [orgA] });

  test("com destinatários elegíveis e bloqueados: 200, mensagens simuladas, provider não chamado, ZERO escrita operacional — inclusive em DISABLED", async (t) => {
    if (pular(t)) return;
    await configurarEmpresa(orgA, { habilitado: true, envio_automatico: true });
    await elegivel(orgA, "João"); await elegivel(orgA, "Maria");
    const ruim = await criarViaApi(orgA, "Opt");
    await autorizar(orgA, ruim.id); await api("POST", `${base(orgA)}/destinatarios/${ruim.id}/opt-out`, { confirmacaoExplicita: true });
    pendenciaDoDryRun = pendencia(); modoDeTeste = "DISABLED";
    const antes = await contagens();
    const hAntes = await habOrg(orgA);
    const r = await api("POST", `${base(orgA)}/dry-run`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const d = r.json.data;
    assert.equal(d.dryRun, true); assert.equal(d.providerChamado, false); assert.equal(d.mensagensCriadas, 0);
    assert.equal(d.modoGlobal, "DISABLED"); assert.equal(d.envioRealPermitido, false);
    assert.equal(d.alertas[0].destinatarios_elegiveis, 2);
    assert.equal(d.alertas[0].mensagens_que_seriam_geradas.length, 2);
    assert.deepEqual(d.alertas[0].destinatarios_bloqueados.map((x) => x.motivo), ["OPT_OUT"]);
    assert.doesNotMatch(JSON.stringify(d), /\+55\d{11}|55\d{11}/, "sem telefone completo");
    assert.deepEqual(await contagens(), antes, "o dry-run não escreveu em nenhuma tabela operacional");
    assert.deepEqual(await habOrg(orgA), hAntes, "nenhum limite/cooldown/ultimo_envio alterado");
    const aud = await auditoria(orgA, ACOES.COMUNICACAO_DRY_RUN_EXECUTADO);
    assert.equal(aud.length, 1); assert.equal(aud[0].detalhes.provider_chamado, false);
    assert.equal(aud[0].ator_id, conta.contaId, "audita QUEM executou");
  });

  test("empresa sem envio automático / sem destinatários: reporta o motivo; 404 para empresa inexistente; 403 para usuário comum", async (t) => {
    if (pular(t)) return;
    await configurarEmpresa(orgA, { habilitado: true, envio_automatico: false });
    pendenciaDoDryRun = pendencia();
    const r = await api("POST", `${base(orgA)}/dry-run`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.data.alertas[0].empresa_elegivel, false);
    assert.ok(r.json.data.alertas[0].motivos_empresa.includes("ENVIO_AUTOMATICO_DESLIGADO"));
    assert.equal((await api("POST", `${base("99999999-9999-4999-8999-999999999999")}/dry-run`, {})).status, 404);
    assert.equal((await chamar(USER_COMUM, "POST", `${base(orgA)}/dry-run`, {})).status, 403);
  });
});
