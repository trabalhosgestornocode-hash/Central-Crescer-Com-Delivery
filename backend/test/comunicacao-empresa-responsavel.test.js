// Migration 100 — RESPONSÁVEL DE COMUNICAÇÃO POR EMPRESA + disponibilidade dos dados do iFood (D-1).
//
// Regressão do bug "Jailton Matos aparece em Subway Centro - Mogi Mirim - SP": o perfil tem ACESSO ativo a
// (quase) todas as empresas; o WhatsApp dele só está cadastrado para "Grupo Jailton e Vanessa". Acesso não é
// responsável de comunicação.
//
// Sem banco real, sem rede: supabase FAKE em memória. Rodar: node --test test/comunicacao-empresa-responsavel.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ??= "http://localhost:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x";
process.env.SUPABASE_ANON_KEY ??= "x";

const svc = await import("../src/modules/administrativo/administrativo.comunicacao.service.js");
const repoEmp = await import("../src/modules/comunicacao/comunicacao.contatosEmpresa.repo.js");
const disp = await import("../src/modules/comunicacao/comunicacao.disponibilidade.js");
const { agendarEnviosPendentes, calcularInstanteDeEnvio } = await import("../src/modules/comunicacao/comunicacao.alertas.service.js");
const { dentroDaJanelaLocal, partesLocais } = await import("../src/modules/comunicacao/comunicacao.horario.js");
const { definirDisponibilidadeIfood, obterDisponibilidadeIfood } = await import("../src/modules/comunicacao/comunicacao.config.js");
const { avaliarEnvio } = await import("../src/modules/comunicacao/comunicacao.policy.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uuid = (l) => { const h = Buffer.from(l).toString("hex").padEnd(32, "0").slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

const GRUPO = uuid("grupo-jailton-vanessa");
const MOGI = uuid("subway-centro-mogi-mirim");
const SEM_CONTATO = uuid("empresa-sem-contato");
const OUTRA = uuid("outra-empresa");
const JAILTON = uuid("perfil-jailton");
const AUTOR = { contaId: uuid("conta-adm"), perfilId: uuid("perfil-adm"), nome: "Admin" };

// ---- supabase fake mínimo (select/eq/in/ilike/order/limit/maybeSingle/single/insert/update/upsert/rpc) ----
function fakeDb(estado, { rpcs = [] } = {}) {
  let seq = 0;
  function from(tabela) {
    const ctx = { eq: [], inF: null, ilike: null };
    const casa = (r) => ctx.eq.every(([c, v]) => r[c] === v) && (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col]))
      && (!ctx.ilike || String(r[ctx.ilike.col] ?? "").toLowerCase().includes(ctx.ilike.v.toLowerCase()));
    const linhas = () => (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
    const run = (single) => { const l = linhas(); return Promise.resolve(single ? { data: l[0] ?? null, error: null } : { data: l, error: null, count: l.length }); };
    const b = {
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => (ctx.inF = { col: c, vals }, b),
      ilike: (c, p) => (ctx.ilike = { col: c, v: String(p).replace(/%/g, "") }, b), order: () => b, range: () => b, limit: () => b, gte: () => b, lte: () => b,
      maybeSingle: () => run(true), single: () => run(true), then: (res, rej) => run(false).then(res, rej),
      insert: (obj) => {
        const linha = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, created_at: new Date().toISOString(), ...obj };
        estado[tabela] = [...(estado[tabela] ?? []), linha];
        return { select: () => ({ single: () => Promise.resolve({ data: { ...linha }, error: null }) }), then: (res) => res({ data: null, error: null }) };
      },
      upsert: (obj, { onConflict } = {}) => {
        const lista = estado[tabela] ?? []; const k = onConflict || "id";
        const i = lista.findIndex((r) => r[k] === obj[k]);
        const linha = i >= 0 ? { ...lista[i], ...obj } : { ...obj };
        if (i >= 0) lista[i] = linha; else lista.push(linha);
        estado[tabela] = lista;
        return { select: () => ({ single: () => Promise.resolve({ data: { ...linha }, error: null }) }) };
      },
      update: (obj) => ({
        eq: (c, v) => {
          estado[tabela] = (estado[tabela] ?? []).map((r) => (r[c] === v ? { ...r, ...obj } : r));
          const p = Promise.resolve({ data: null, error: null });
          p.select = () => ({ single: () => Promise.resolve({ data: (estado[tabela] ?? []).find((r) => r[c] === v) ?? null, error: null }) });
          return p;
        },
      }),
    };
    return b;
  }
  return { from, rpc: async (nome, args) => { rpcs.push({ nome, args }); return { data: { acao: "CRIADA", mensagem_id: "m1" }, error: null }; } };
}

function estadoBase() {
  return {
    organizacoes: [
      { id: GRUPO, nome: "Grupo Jailton e Vanessa", status: "ativa", eh_modelo: false },
      { id: MOGI, nome: "Subway Centro - Mogi Mirim - SP", status: "ativa", eh_modelo: false },
      { id: SEM_CONTATO, nome: "Empresa Sem Contato", status: "ativa", eh_modelo: false },
      { id: OUTRA, nome: "Outra Empresa", status: "ativa", eh_modelo: false },
    ],
    unidades: [
      { id: uuid("u1"), organizacao_id: GRUPO, nome: "Loja Florianópolis-SC 1", ativo: true },
      { id: uuid("u2"), organizacao_id: GRUPO, nome: "Loja Florianópolis-SC 2", ativo: true },
      { id: uuid("u3"), organizacao_id: GRUPO, nome: "Subway Saci — Matriz", ativo: true },
      { id: uuid("u-matriz-mogi"), organizacao_id: MOGI, nome: "Matriz Subway Centro - Mogi Mirim - SP", ativo: true },
      { id: uuid("u-o"), organizacao_id: OUTRA, nome: "Loja Outra", ativo: true },
    ],
    // o perfil Jailton tem ACESSO a quase tudo — exatamente o cenário de produção
    perfis_operacionais: [{ id: JAILTON, conta_id: uuid("conta-jailton"), nome: "Jailton Matos", ativo: true }],
    usuarios_organizacoes: [GRUPO, MOGI, SEM_CONTATO, OUTRA].map((o) => ({ organizacao_id: o, perfil_id: JAILTON, ativo: true })),
    usuarios_unidades: [{ perfil_id: JAILTON, unidade_id: uuid("u-matriz-mogi") }, { perfil_id: JAILTON, unidade_id: uuid("u3") }],
    comunicacao_habilitacoes: [], comunicacao_contatos_empresa: [], contatos_whatsapp: [], comunicacao_mensagens: [],
    comunicacao_configuracoes: [{ chave: "modo", valor: "DISABLED" }], plataforma_auditoria: [],
  };
}

async function cadastrarJailtonNoGrupo(deps) {
  return svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Jailton Matos", telefoneE164: "+5586988846788" }, AUTOR, deps);
}

describe("BUG JAILTON — responsável de comunicação é EXPLÍCITO por empresa (regressão obrigatória)", () => {
  test("Jailton (responsável do Grupo) aparece SOMENTE no Grupo Jailton e Vanessa — jamais em Subway Centro - Mogi Mirim - SP / Matriz", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    await cadastrarJailtonNoGrupo(deps);

    const lista = await svc.organizacoes({}, deps);
    const grupo = lista.find((e) => e.organizacaoId === GRUPO);
    const mogi = lista.find((e) => e.organizacaoId === MOGI);
    assert.equal(grupo.responsavel.nome, "Jailton Matos");
    assert.equal(mogi.responsavel, null, "Mogi Mirim não tem responsável cadastrado, mesmo com Jailton tendo ACESSO a ela");
    assert.equal(mogi.whatsappStatus, "NAO_CADASTRADO");
    assert.doesNotMatch(JSON.stringify(mogi), /Jailton/);

    const detMogi = await svc.detalheOrganizacao({ organizacaoId: MOGI }, deps);
    assert.equal(detMogi.configuracao.destinatario, null);
    assert.doesNotMatch(JSON.stringify(detMogi), /Jailton/, "nem o detalhe nem as unidades da Matriz Mogi Mirim citam o Jailton");
    assert.equal(detMogi.checklistPiloto.responsavelDefinido, false);

    const detGrupo = await svc.detalheOrganizacao({ organizacaoId: GRUPO }, deps);
    assert.equal(detGrupo.configuracao.destinatario.nome, "Jailton Matos");
    // o vínculo gravado é EMPRESA -> responsável; a empresa Mogi nunca ganhou nenhuma linha
    assert.deepEqual(estado.comunicacao_contatos_empresa.map((c) => c.organizacao_id), [GRUPO]);
    assert.equal(estado.comunicacao_habilitacoes.find((h) => h.organizacao_id === MOGI), undefined);
  });

  test("mudar ACESSOS (usuarios_unidades / usuarios_organizacoes / perfil ativo) NÃO altera nenhum responsável", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    await cadastrarJailtonNoGrupo(deps);
    const antes = await svc.organizacoes({}, deps);

    // "troca de unidade no seletor": o Jailton passa a ter acesso a outra unidade e perde a da Matriz Mogi
    estado.usuarios_unidades = [{ perfil_id: JAILTON, unidade_id: uuid("u1") }];
    // perfil ativo diferente / desativado, e acesso removido da empresa Grupo
    estado.perfis_operacionais[0].ativo = false;
    estado.usuarios_organizacoes = estado.usuarios_organizacoes.filter((v) => v.organizacao_id !== GRUPO);
    const depois = await svc.organizacoes({}, deps);
    assert.deepEqual(depois, antes);

    const det = await svc.detalheOrganizacao({ organizacaoId: GRUPO }, deps);
    assert.equal(det.configuracao.destinatario.nome, "Jailton Matos", "sem acesso ao Grupo ele continua sendo o responsável cadastrado");
  });

  test("o código de comunicação nunca consulta usuarios_organizacoes/usuarios_unidades/perfis para decidir responsável (guarda estática)", () => {
    const arquivos = [
      "../src/modules/comunicacao/comunicacao.contatosEmpresa.repo.js",
      "../src/modules/comunicacao/comunicacao.habilitacao.js",
      "../src/modules/administrativo/administrativo.comunicacao.service.js",
    ];
    for (const a of arquivos) {
      const codigo = fs.readFileSync(path.join(__dirname, a), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      assert.doesNotMatch(codigo, /usuarios_organizacoes|usuarios_unidades|perfilTemVinculo|listarPerfisElegiveis|resolverContatosDaUnidade/, `${a} não pode inferir responsável por acesso`);
    }
    const repo = fs.readFileSync(path.join(__dirname, "../src/modules/administrativo/administrativo.comunicacao.repo.js"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(repo, /usuarios_organizacoes|usuarios_unidades|perfilTemVinculo/);
  });
});

describe("Empresa A + Responsável A / Empresa B + Responsável B", () => {
  test("cada responsável aparece só na sua empresa e o telefone nunca sai completo", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Responsável A", telefoneE164: "+5586988846788" }, AUTOR, deps);
    await svc.salvarResponsavel({ organizacaoId: OUTRA, nome: "Responsável B", telefoneE164: "+5511999990000" }, AUTOR, deps);
    const lista = await svc.organizacoes({}, deps);
    const a = lista.find((e) => e.organizacaoId === GRUPO), b = lista.find((e) => e.organizacaoId === OUTRA);
    assert.equal(a.responsavel.nome, "Responsável A");
    assert.equal(b.responsavel.nome, "Responsável B");
    assert.doesNotMatch(JSON.stringify(a), /Responsável B/);
    assert.doesNotMatch(JSON.stringify(b), /Responsável A/);
    assert.doesNotMatch(JSON.stringify(lista), /5586988846788|5511999990000/, "telefone completo nunca é devolvido");
  });

  test("um responsável da empresa A não pode ser validado/desativado usando o id da empresa B (404)", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    const a = await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Resp A", telefoneE164: "+5586988846788" }, AUTOR, deps);
    await assert.rejects(() => svc.validarResponsavel({ organizacaoId: OUTRA, contatoEmpresaId: a.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR, deps), { statusCode: 404 });
    await assert.rejects(() => svc.definirAtivoResponsavel({ organizacaoId: OUTRA, contatoEmpresaId: a.contatoEmpresaId, ativo: false }, AUTOR, deps), { statusCode: 404 });
    assert.equal(estado.comunicacao_contatos_empresa[0].ativo, true);
    assert.equal(estado.comunicacao_contatos_empresa[0].whatsapp_status, "AGUARDANDO_VALIDACAO");
  });

  test("salvar o responsável NUNCA altera `habilitado` de uma empresa já habilitada (só o ponteiro)", async () => {
    const estado = estadoBase();
    estado.comunicacao_habilitacoes = [{ organizacao_id: GRUPO, habilitado: true, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"] }];
    const deps = { supabase: fakeDb(estado) };
    await cadastrarJailtonNoGrupo(deps);
    const h = estado.comunicacao_habilitacoes[0];
    assert.equal(h.habilitado, true);
    assert.equal(h.destinatario_contato_empresa_id, estado.comunicacao_contatos_empresa[0].id);
    assert.equal(h.destinatario_perfil_id, null, "o responsável não exige perfil/usuário");
  });

  test("trocar o telefone invalida a validação (volta a AGUARDANDO) e aponta para um NOVO registro de telefone sem consentimento", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    const r = await cadastrarJailtonNoGrupo(deps);
    await svc.validarResponsavel({ organizacaoId: GRUPO, contatoEmpresaId: r.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR, deps);
    assert.equal(estado.comunicacao_contatos_empresa[0].whatsapp_status, "VALIDADO");
    await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Jailton Matos", telefoneE164: "+5511977776666" }, AUTOR, deps);
    const ce = estado.comunicacao_contatos_empresa[0];
    assert.equal(ce.whatsapp_status, "AGUARDANDO_VALIDACAO");
    assert.equal(ce.whatsapp_validado_em, null);
    const novo = estado.contatos_whatsapp.find((c) => c.id === ce.contato_whatsapp_id);
    assert.notEqual(novo.consentimento, true); // (o banco aplica default false)
    assert.notEqual(novo.verificado, true);
  });

  test("telefone inválido e nome vazio são recusados", async () => {
    const deps = { supabase: fakeDb(estadoBase()) };
    await assert.rejects(() => svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "X", telefoneE164: "abc" }, AUTOR, deps), { statusCode: 400 });
    await assert.rejects(() => svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "  ", telefoneE164: "+5586988846788" }, AUTOR, deps), { statusCode: 400 });
  });
});

describe("Aba Empresas — uma linha por EMPRESA, status, busca e filtros", () => {
  test("empresa com várias unidades aparece UMA vez, com a contagem de unidades", async () => {
    const deps = { supabase: fakeDb(estadoBase()) };
    const lista = await svc.organizacoes({}, deps);
    assert.equal(lista.filter((e) => e.organizacaoId === GRUPO).length, 1);
    assert.equal(lista.find((e) => e.organizacaoId === GRUPO).unidadesMonitoradas, 3);
    assert.equal(lista.length, 4, "4 empresas, não 5 unidades");
    assert.ok(!lista.some((e) => /Loja Florian|Matriz/.test(e.nome)), "unidades nunca são listadas como empresas");
  });

  test("empresa sem contato aparece como sem responsável / NAO_CADASTRADO", async () => {
    const deps = { supabase: fakeDb(estadoBase()) };
    const e = (await svc.organizacoes({}, deps)).find((x) => x.organizacaoId === SEM_CONTATO);
    assert.equal(e.responsavel, null);
    assert.equal(e.whatsappStatus, "NAO_CADASTRADO");
    assert.equal(e.proximaAcao, "Cadastrar o responsável pelas comunicações");
  });

  test("filtros: configurados / sem_responsavel / aguardando_validacao / validados / desativada; filtro inválido -> 400", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado) };
    const g = await cadastrarJailtonNoGrupo(deps);
    const o = await svc.salvarResponsavel({ organizacaoId: OUTRA, nome: "Fulano", telefoneE164: "+5511999990000" }, AUTOR, deps);
    await svc.validarResponsavel({ organizacaoId: OUTRA, contatoEmpresaId: o.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR, deps);
    const ids = async (filtro) => (await svc.organizacoes({ filtro }, deps)).map((e) => e.organizacaoId).sort();
    assert.deepEqual(await ids("configurados"), [GRUPO, OUTRA].sort());
    assert.deepEqual(await ids("sem_responsavel"), [MOGI, SEM_CONTATO].sort());
    assert.deepEqual(await ids("aguardando_validacao"), [GRUPO]);
    assert.deepEqual(await ids("validados"), [OUTRA]);
    await svc.definirAtivoResponsavel({ organizacaoId: GRUPO, contatoEmpresaId: g.contatoEmpresaId, ativo: false }, AUTOR, deps);
    assert.deepEqual(await ids("desativada"), [GRUPO]);
    assert.equal((await svc.organizacoes({}, deps)).find((e) => e.organizacaoId === GRUPO).whatsappStatus, "DESATIVADO");
    await assert.rejects(() => svc.organizacoes({ filtro: "qualquer" }, deps), { statusCode: 400 });
  });

  test("busca por empresa, responsável e telefone (o número completo só é usado no servidor)", async () => {
    const deps = { supabase: fakeDb(estadoBase()) };
    await cadastrarJailtonNoGrupo(deps);
    const ids = async (busca) => (await svc.organizacoes({ busca }, deps)).map((e) => e.organizacaoId);
    assert.deepEqual(await ids("grupo jailton"), [GRUPO]);
    assert.deepEqual(await ids("jailton matos"), [GRUPO], "busca por responsável NÃO traz Mogi Mirim");
    assert.deepEqual(await ids("86988846788"), [GRUPO]);
    assert.deepEqual(await ids("mogi mirim"), [MOGI]);
  });

  test("resumo: configuradas/validados/semResponsavel vêm da camada de comunicação", async () => {
    const deps = { supabase: fakeDb(estadoBase()) };
    await cadastrarJailtonNoGrupo(deps);
    const r = await svc.resumo(deps);
    assert.equal(r.empresas.configuradas, 1);
    assert.equal(r.empresas.semResponsavel, 3);
    assert.equal(r.empresas.validados, 0);
  });
});

describe("Pré-envio: o responsável precisa pertencer à empresa, estar ativo e validado", () => {
  const job = { organizacao_id: GRUPO, contato_id: "c1", telefone_snapshot: "+5586988846788" };
  const ce = (extra = {}) => ({ organizacao_id: GRUPO, ativo: true, whatsapp_status: "VALIDADO", contato_whatsapp_id: "c1", telefone_e164: "+5586988846788", ...extra });
  const contato = { telefone_e164: "+5586988846788" };

  test("responsável ok -> válido", () => assert.deepEqual(repoEmp.avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa: ce() }), { valido: true, motivo: null }));
  test("contato de OUTRA empresa -> SEM_RESPONSAVEL (nunca aceito por existir)", () =>
    assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa: ce({ organizacao_id: OUTRA }) }).motivo, "SEM_RESPONSAVEL"));
  test("sem responsável -> SEM_RESPONSAVEL", () => assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa: null }).motivo, "SEM_RESPONSAVEL"));
  test("contato desativado NÃO recebe mensagem", () => assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa: ce({ ativo: false }) }).motivo, "RESPONSAVEL_INATIVO"));
  test("WhatsApp não validado NÃO recebe mensagem", () => {
    for (const s of ["NAO_VALIDADO", "AGUARDANDO_VALIDACAO", "ERRO", undefined]) {
      assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa: ce({ whatsapp_status: s }) }).motivo, "WHATSAPP_NAO_VALIDADO");
    }
  });
  test("telefone trocado depois do agendamento invalida a mensagem da fila", () => {
    assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job, contato: { telefone_e164: "+5511977776666" }, contatoEmpresa: ce() }).motivo, "TELEFONE_DIVERGENTE");
    assert.equal(repoEmp.avaliarResponsavelDaMensagem({ job: { ...job, contato_id: "outro" }, contato, contatoEmpresa: ce() }).motivo, "TELEFONE_DIVERGENTE");
  });
  test("a política bloqueia (permanente) quando o snapshot vem de responsável inativo/sem vínculo/não validado", () => {
    const base = {
      modo: "NORMAL", ehProativo: true, contatoExiste: true, telefoneVerificado: true, optOut: false, consentimento: true, destinatarioAtivo: true, vinculoValido: true,
      empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, configHorarioValida: true, pendenciaAindaExiste: true, duplicado: false,
      cooldownAtivo: false, dentroDaJanela: true, rateLimitExcedido: false, providerConectado: true, identidadeConfirmada: true,
    };
    assert.equal(avaliarEnvio(base).allowed, true);
    assert.equal(avaliarEnvio({ ...base, destinatarioAtivo: false }).reason, "USER_INACTIVE");
    assert.equal(avaliarEnvio({ ...base, vinculoValido: false }).reason, "SEM_VINCULO");
    assert.equal(avaliarEnvio({ ...base, telefoneVerificado: false }).reason, "PHONE_NOT_VERIFIED");
  });
});

// ------------------------------------------------------------------------------------------------
// HORÁRIO — dados do iFood (D-1) só disponíveis depois do horário configurado
// 2026-09-25 (sexta). America/Sao_Paulo = UTC-3 (sem horário de verão em 2026). D-1 = 2026-09-24.
// ------------------------------------------------------------------------------------------------
const TZ = "America/Sao_Paulo";
const local = (hhmm, dia = "2026-09-25") => new Date(`${dia}T${hhmm}:00-03:00`);
const CFG = { dados_disponiveis_apos: "10:00", envios_permitidos_apos: "10:30" };
const D1 = "2026-09-24";

describe("D-1 do iFood: sem cobrança antes do horário de disponibilidade", () => {
  test("08:00 e 09:59 -> D-1 pendente NÃO é cobrado (dados indisponíveis)", () => {
    for (const h of ["00:00", "08:00", "08:30", "09:59"]) {
      const r = disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local(h), timezone: TZ, config: CFG });
      assert.deepEqual(r, { disponivel: false, motivo: "DADOS_IFOOD_INDISPONIVEIS" }, h);
    }
  });
  test("10:00-10:29: dados disponíveis mas ainda antes do horário mínimo de envio; 10:30+ libera", () => {
    assert.deepEqual(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("10:00"), timezone: TZ, config: CFG }), { disponivel: false, motivo: "AGUARDANDO_HORARIO_MINIMO_ENVIO" });
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("10:29"), timezone: TZ, config: CFG }).disponivel, false);
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("10:30"), timezone: TZ, config: CFG }).disponivel, true);
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("10:45"), timezone: TZ, config: CFG }).disponivel, true);
  });
  test("pendência mais antiga que D-1 (D-2, D-3...) NÃO espera a disponibilidade", () => {
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: "2026-09-23", agora: local("08:00"), timezone: TZ, config: CFG }).disponivel, true);
  });
  test("o horário é da EMPRESA (timezone dela), não do servidor: 12:30Z é 09:30 em São Paulo mas 07:30 em Manaus... e 10:30 em Recife-UTC-3", () => {
    const agora = new Date("2026-09-25T13:30:00Z"); // 10:30 em SP (-3), 09:30 em Manaus (-4)
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora, timezone: "America/Sao_Paulo", config: CFG }).disponivel, true);
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora, timezone: "America/Manaus", config: CFG }).disponivel, false);
  });
  test("horários CONFIGURÁVEIS: nada de 10:00 hardcoded (ex.: 11:00/11:30) e valor corrompido cai no padrão", () => {
    const c = { dados_disponiveis_apos: "11:00", envios_permitidos_apos: "11:30" };
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("10:45"), timezone: TZ, config: c }).disponivel, false);
    assert.equal(disp.avaliarDisponibilidadeD1({ dataReferencia: D1, agora: local("11:30"), timezone: TZ, config: c }).disponivel, true);
    assert.deepEqual(disp.normalizarDisponibilidade({ dados_disponiveis_apos: "lixo" }), disp.DISPONIBILIDADE_IFOOD_PADRAO);
    assert.equal(disp.disponibilidadeValida({ dados_disponiveis_apos: "10:30", envios_permitidos_apos: "10:00" }), false, "envio antes da disponibilidade é inválido");
  });
  test("janelas efetivas para D-1: início vira max(janela, horário mínimo); dia sem janela útil fecha", () => {
    const j = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "10:00" }, dom: null };
    const r = disp.janelasParaReferencia({ janelas: j, dataReferencia: D1, agora: local("09:00"), timezone: TZ, config: CFG });
    assert.deepEqual(r.seg_sex, { inicio: "10:30", fim: "18:00" });
    assert.equal(r.sab, null);
    assert.deepEqual(disp.janelasParaReferencia({ janelas: j, dataReferencia: "2026-09-20", agora: local("09:00"), timezone: TZ, config: CFG }), j);
    assert.equal(dentroDaJanelaLocal(local("09:30"), TZ, r), false);
    assert.equal(dentroDaJanelaLocal(local("10:45"), TZ, r), true);
  });
  test("calcularInstanteDeEnvio: D-1 nunca é agendado antes de 10:30 local; à noite o D-1 de hoje já é D-2 amanhã (08:00 normal)", () => {
    const janelas = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };
    const p = { timezone: TZ, janelas, dataReferencia: D1, disponibilidade: CFG, chave: "k", spreadMaxMs: 30 * 60_000 };
    const cedo = calcularInstanteDeEnvio({ ...p, base: local("08:30") });
    const l = partesLocais(cedo, TZ);
    assert.ok(l.hora * 60 + l.minuto >= 10 * 60 + 30, `agendado às ${l.hora}:${l.minuto}`);
    const noite = calcularInstanteDeEnvio({ ...p, base: local("20:00") }); // sexta 20:00 -> sábado 08:xx (D-2, sem espera)
    const n = partesLocais(noite, TZ);
    assert.equal(n.dia, 26);
    assert.ok(n.hora === 8, `sábado ${n.hora}:${n.minuto}`);
  });
  test("definirDisponibilidadeIfood valida, grava e é lido de volta (configurável no Painel)", async () => {
    const estado = { comunicacao_configuracoes: [] }; const deps = { supabase: fakeDb(estado) };
    assert.deepEqual(await obterDisponibilidadeIfood(deps), disp.DISPONIBILIDADE_IFOOD_PADRAO);
    await definirDisponibilidadeIfood({ dadosDisponiveisApos: "10:15", enviosPermitidosApos: "11:00" }, { atorPerfilId: AUTOR.perfilId }, deps);
    assert.deepEqual(await obterDisponibilidadeIfood(deps), { dados_disponiveis_apos: "10:15", envios_permitidos_apos: "11:00" });
    await assert.rejects(() => definirDisponibilidadeIfood({ dadosDisponiveisApos: "12:00", enviosPermitidosApos: "11:00" }, {}, deps), { statusCode: 400 });
    await assert.rejects(() => definirDisponibilidadeIfood({ dadosDisponiveisApos: "25:00", enviosPermitidosApos: "26:00" }, {}, deps), { statusCode: 400 });
  });
});

describe("agendarEnviosPendentes — o motor respeita a disponibilidade e usa o responsável da empresa", () => {
  const alerta = (extra = {}) => ({
    id: uuid("alerta-1"), organizacao_id: GRUPO, unidade_id: uuid("u1"), tipo_alerta: "dashboard_ifood_d1", status: "DETECTED",
    data_referencia: D1, motivo: "1 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Florianópolis-SC 1" }, severidade: "atencao", ...extra,
  });
  const hab = async (extra = {}) => ({
    empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
    destinatarioContatoId: "c1", destinatarioContatoEmpresaId: "ce1", destinatarioPerfilId: null,
    timezone: TZ, janelas: null, configHorarioValida: true, fonte: "TESTE", ...extra,
  });
  const montar = (alertas) => { const rpcs = []; return { rpcs, deps: { supabase: fakeDb({ comunicacao_alertas: alertas, comunicacao_configuracoes: [] }, { rpcs }) } }; };

  test("08:30 com D-1 pendente: NADA é agendado (empresa não está atrasada); o RPC nem é chamado", async () => {
    const { rpcs, deps } = montar([alerta()]);
    const r = await agendarEnviosPendentes({ agora: local("08:30"), resolverHabilitacao: hab }, deps);
    assert.equal(r.agendados, 0);
    assert.equal(r.aguardandoDisponibilidadeIfood, 1);
    assert.equal(rpcs.length, 0);
  });
  test("09:59 idem; 10:15 (dados ok, antes do horário mínimo) idem", async () => {
    for (const h of ["09:59", "10:15"]) {
      const { rpcs, deps } = montar([alerta()]);
      const r = await agendarEnviosPendentes({ agora: local(h), resolverHabilitacao: hab }, deps);
      assert.equal(r.aguardandoDisponibilidadeIfood, 1, h);
      assert.equal(rpcs.length, 0, h);
    }
  });
  test("10:45 com D-1 ainda pendente: agenda (o banco recebe o RPC do alerta) num horário >= 10:45, dentro da janela", async () => {
    const { rpcs, deps } = montar([alerta()]);
    const r = await agendarEnviosPendentes({ agora: local("10:45"), resolverHabilitacao: hab }, deps);
    assert.equal(r.agendados, 1);
    assert.equal(r.aguardandoDisponibilidadeIfood, 0);
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0].nome, "comunicacao_agendar_mensagem_alerta");
    assert.ok(new Date(rpcs[0].args.p_disponivel_em).getTime() >= local("10:45").getTime());
  });
  test("pendência D-3 às 08:30 já pode ser agendada (dado completo há dias)", async () => {
    const { rpcs, deps } = montar([alerta({ data_referencia: "2026-09-22" })]);
    const r = await agendarEnviosPendentes({ agora: local("08:30"), resolverHabilitacao: hab }, deps);
    assert.equal(r.agendados, 1);
    assert.equal(rpcs.length, 1);
  });
  test("SEM responsável da empresa (só perfil/contato solto): não agenda — nunca infere destinatário", async () => {
    const { rpcs, deps } = montar([alerta()]);
    const r = await agendarEnviosPendentes({ agora: local("11:00"), resolverHabilitacao: async () => hab({ destinatarioContatoEmpresaId: null, destinatarioPerfilId: "perfil-com-acesso" }) }, deps);
    assert.equal(r.semDestinatario, 1);
    assert.equal(rpcs.length, 0);
  });
});

describe("Migration 100 — schema (guarda estática do SQL)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../database/migrations/100_comunicacao_responsavel_empresa.sql"), "utf8");
  test("organizacao_id é obrigatório e o vínculo da habilitação é por (id, organizacao_id)", () => {
    assert.match(sql, /organizacao_id\s+uuid not null references organizacoes/);
    assert.match(sql, /foreign key \(destinatario_contato_empresa_id, organizacao_id\)/);
    assert.match(sql, /unique \(id, organizacao_id\)/);
  });
  test("não é destrutiva: sem drop table/delete/truncate (só drop constraint do par contato/perfil)", () => {
    assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
    assert.doesNotMatch(sql, /drop column/i);
  });
  test("o RPC de agendamento grava o snapshot e recusa responsável de outra empresa / inativo / não validado", () => {
    assert.match(sql, /empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia/);
    assert.match(sql, /organizacao_id = a\.organizacao_id/);
    assert.match(sql, /ce\.whatsapp_status <> 'VALIDADO'/);
    assert.doesNotMatch(sql.slice(sql.indexOf("create or replace function comunicacao_agendar_mensagem_alerta")), /usuarios_organizacoes|usuarios_unidades/);
  });
  test("seed de disponibilidade: 10:00 / 10:30, editável (on conflict do nothing)", () => {
    assert.match(sql, /'disponibilidade_ifood'.*10:00.*10:30/s);
    assert.match(sql, /on conflict \(chave\) do nothing/);
  });
});

describe("`habilitado` só muda por ação EXPLÍCITA (nunca ao configurar / salvar responsável)", () => {
  const habilitadaBase = () => {
    const estado = estadoBase();
    estado.contatos_whatsapp = [{ id: "c-hab", telefone_e164: "+5586988846788", verificado: true, consentimento: true, opt_out: false }];
    estado.comunicacao_contatos_empresa = [{ id: "ce-hab", organizacao_id: GRUPO, nome: "Jailton Matos", telefone_e164: "+5586988846788", tipo: "principal", ativo: true, contato_whatsapp_id: "c-hab", whatsapp_status: "VALIDADO", whatsapp_validado_em: "2026-09-01T00:00:00Z" }];
    estado.comunicacao_habilitacoes = [{ organizacao_id: GRUPO, habilitado: true, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"], destinatario_contato_id: "c-hab", destinatario_contato_empresa_id: "ce-hab" }];
    return estado;
  };

  test("PUT configuração (timezone/tipos/pausa) preserva habilitado=true", async () => {
    const estado = habilitadaBase(); const deps = { supabase: fakeDb(estado) };
    await svc.atualizarConfiguracao({ organizacaoId: GRUPO, timezone: "America/Fortaleza", tiposPermitidos: ["dashboard_ifood_d1"], pausadoAte: null }, AUTOR, deps);
    assert.equal(estado.comunicacao_habilitacoes[0].habilitado, true);
    assert.equal(estado.comunicacao_habilitacoes[0].timezone, "America/Fortaleza");
  });
  test("salvar/editar responsável (nome, telefone, observações, ativo) preserva habilitado=true", async () => {
    const estado = habilitadaBase(); const deps = { supabase: fakeDb(estado) };
    await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Novo Nome", telefoneE164: "+5511977776666", observacoes: "x", ativo: false }, AUTOR, deps);
    assert.equal(estado.comunicacao_habilitacoes[0].habilitado, true);
  });
  test("payload de configuração com `habilitado` verdadeiro/truthy é recusado", async () => {
    const deps = { supabase: fakeDb(habilitadaBase()) };
    for (const h of [true, 1, "true"]) await assert.rejects(() => svc.atualizarConfiguracao({ organizacaoId: GRUPO, habilitado: h }, AUTOR, deps), { statusCode: 400 });
  });
  test("habilitar (ação explícita já existente) exige o RESPONSÁVEL da empresa, ativo e com WhatsApp validado — antes de qualquer gate do piloto", async () => {
    const estado = estadoBase(); const deps = { supabase: fakeDb(estado), env: {} };
    await assert.rejects(() => svc.definirHabilitacao({ organizacaoId: GRUPO, habilitado: true, confirmacaoExplicita: true }, AUTOR, deps), (e) => e.details?.codigo === "SEM_DESTINATARIO" || /responsável/i.test(e.message));
    const r = await cadastrarJailtonNoGrupo(deps);
    await assert.rejects(() => svc.definirHabilitacao({ organizacaoId: GRUPO, habilitado: true, confirmacaoExplicita: true }, AUTOR, deps), /Valide o WhatsApp/);
    await svc.validarResponsavel({ organizacaoId: GRUPO, contatoEmpresaId: r.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR, deps);
    await svc.definirAtivoResponsavel({ organizacaoId: GRUPO, contatoEmpresaId: r.contatoEmpresaId, ativo: false }, AUTOR, deps);
    await assert.rejects(() => svc.definirHabilitacao({ organizacaoId: GRUPO, habilitado: true, confirmacaoExplicita: true }, AUTOR, deps), /desativados/);
    assert.equal(estado.comunicacao_habilitacoes[0].habilitado, false);
  });
});
