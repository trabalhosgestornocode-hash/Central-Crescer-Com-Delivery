// Configuração do Dashboard iFood da unidade pelo SuperAdmin — produto
// simplificado do Checkpoint F: uma opção, "Considerar Sanduíches + Saladas".
// plataforma.dashboardIfood.service.js (migration 108).
//
// Unit test SEM rede e SEM a migration aplicada. O fake do supabase:
//   * permite só LEITURA direta de tabela — qualquer insert/update/upsert/
//     delete direto falha o teste: toda escrita tem que passar pela RPC
//     atômica `dashboard_ifood_salvar_config_unidade`;
//   * emula essa RPC de forma transacional (trabalha numa CÓPIA do estado e
//     só a confirma se tudo der certo), com os mesmos códigos de erro do SQL;
//   * emula `dashboard_ifood_config_versao` (muda a cada gravação).
// A atomicidade REAL (rollback do Postgres) é validada à parte, contra a
// própria migration 108, num Postgres efêmero (PGlite) — ver relatório C.1.
//
// Rodar: node --test test/plataforma-dashboard-ifood.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { obterConfigDashboardIfood, salvarConfigDashboardIfood, planejarSanduichesSaladas } =
  await import("../src/modules/plataforma/plataforma.dashboardIfood.service.js");
const { ACOES } = await import("../src/shared/auditoria.js");
const { EVENTOS_DASHBOARD_IFOOD } = await import("../src/modules/dashboard-executivo/dashboardExecutivo.eventos.js");
const { requireSuperadmin } = await import("../src/middlewares/auth.js");
const { plataformaRouter } = await import("../src/modules/plataforma/plataforma.routes.js");
const { dashboardExecutivoRouter } = await import("../src/modules/dashboard-executivo/dashboardExecutivo.routes.js");

const ORG_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const UNI_A = "11111111-1111-4111-8111-111111111111";
const UNI_A2 = "22222222-2222-4222-8222-222222222222";   // mesma empresa, outra unidade
const UNI_B = "33333333-3333-4333-8333-333333333333";    // outra empresa

const req = {
  user: { id: "00000000-0000-4000-8000-000000000000", email: "super@crescer.com", nome: "Super", superadmin: true },
  headers: {}, socket: {}, header: () => null,
};

// --- emulação da RPC (mesmas regras/códigos da migration 108, seção 7.2) ----
const chave = (n) => String(n).trim().toLowerCase();
const erroRpc = (codigo, texto = codigo) => ({ data: null, error: { code: "P0001", message: `${codigo}: ${texto}` } });

function versaoDe(estado, unidadeId) {
  const cfg = estado.dashboard_ifood_unidade_config.find((c) => c.unidade_id === unidadeId);
  const canais = estado.dashboard_ifood_canais.filter((c) => c.unidade_id === unidadeId).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("md5").update(JSON.stringify({ cfg: cfg ?? null, canais })).digest("hex");
}

function rpcSalvar(estado, a, { falharEm } = {}) {
  const unidade = estado.unidades.find((u) => u.id === a.p_unidade_id);
  if (!unidade) return erroRpc("UNIDADE_NAO_ENCONTRADA", "unidade.");
  if (a.p_organizacao_id !== unidade.organizacao_id) return erroRpc("ORGANIZACAO_DIVERGENTE", "a unidade não pertence a esta empresa.");
  if (!a.p_versao || a.p_versao !== versaoDe(estado, unidade.id)) return erroRpc("CONFIG_DESATUALIZADA", "alterada por outra pessoa.");
  if (!["padrao", "multicanal"].includes(a.p_estrutura)) return erroRpc("ESTRUTURA_INVALIDA");
  if (a.p_escopo != null && !["unidade", "canal"].includes(a.p_escopo)) return erroRpc("ESCOPO_INVALIDO");

  const copia = structuredClone(estado);                 // "transação"
  const canaisDaUnidade = copia.dashboard_ifood_canais.filter((c) => c.unidade_id === unidade.id);
  const ordemAntes = canaisDaUnidade.slice().sort((x, y) => x.ordem - y.ordem || x.nome.localeCompare(y.nome)).map((c) => c.id).join();
  const cfgAtual = copia.dashboard_ifood_unidade_config.find((c) => c.unidade_id === unidade.id);
  const estruturaAnt = cfgAtual?.estrutura ?? "padrao";
  const escopoAnt = cfgAtual?.taxas_entregadores_escopo ?? "unidade";
  const escopo = a.p_escopo ?? escopoAnt;
  const diff = { criados: [], renomeados: [], ativados: [], desativados: [] };
  let ativos;

  if (a.p_canais != null) {
    const ids = new Set();
    for (const it of a.p_canais) {
      const nome = String(it.nome ?? "").trim();
      if (nome.length < 1 || nome.length > 60) return erroRpc("NOME_CANAL_INVALIDO");
      if (it.id) {
        if (!canaisDaUnidade.some((c) => c.id === it.id)) return erroRpc("CANAL_DE_OUTRA_UNIDADE");
        if (ids.has(it.id)) return erroRpc("CANAL_DUPLICADO");
        ids.add(it.id);
      }
    }
    if (canaisDaUnidade.some((c) => !ids.has(c.id))) return erroRpc("CANAL_AUSENTE", "canais não podem ser excluídos — desative em vez de remover.");
    const nomes = a.p_canais.map((it) => chave(it.nome));
    if (new Set(nomes).size !== nomes.length) return erroRpc("NOME_CANAL_DUPLICADO", "já existe um canal com este nome nesta unidade.");
    a.p_canais.forEach((it, pos) => {
      const nome = it.nome.trim();
      const ativo = it.ativo ?? true;
      if (it.id) {
        const c = canaisDaUnidade.find((x) => x.id === it.id);
        if (c.nome !== nome) diff.renomeados.push({ id: c.id, de: c.nome, para: nome });
        if (ativo && !c.ativo) diff.ativados.push({ id: c.id, nome });
        if (!ativo && c.ativo) diff.desativados.push({ id: c.id, nome });
        if (c.nome !== nome || c.ordem !== pos || c.ativo !== ativo) Object.assign(c, { nome, ordem: pos, ativo, rev: (c.rev ?? 0) + 1 });
      } else {
        const novo = { id: randomUUID(), organizacao_id: unidade.organizacao_id, unidade_id: unidade.id, nome, ordem: pos, ativo };
        copia.dashboard_ifood_canais.push(novo);
        diff.criados.push({ id: novo.id, nome, ativo });
      }
    });
    if (falharEm === "canais") return { data: null, error: { message: "falha simulada no meio da RPC" } };
    ativos = a.p_canais.filter((it) => it.ativo ?? true).length;
  } else {
    ativos = canaisDaUnidade.filter((c) => c.ativo).length;
  }
  if (a.p_estrutura === "multicanal" && ativos < 2) return erroRpc("MULTICANAL_MINIMO_CANAIS", `múltiplos canais exige pelo menos 2 canais ativos (hoje: ${ativos}).`);
  if (a.p_estrutura !== estruturaAnt || escopo !== escopoAnt) {
    if (falharEm === "config") return { data: null, error: { message: "falha simulada ao gravar a configuração" } };
    const linha = { unidade_id: unidade.id, organizacao_id: unidade.organizacao_id, estrutura: a.p_estrutura, taxas_entregadores_escopo: escopo,
      atualizado_por: a.p_usuario_id, atualizado_por_nome: a.p_usuario_nome, atualizado_por_email: a.p_usuario_email };
    if (cfgAtual) Object.assign(cfgAtual, linha, { rev: (cfgAtual.rev ?? 0) + 1 }); else copia.dashboard_ifood_unidade_config.push(linha);
  }
  const depois = copia.dashboard_ifood_canais.filter((c) => c.unidade_id === unidade.id).sort((x, y) => x.ordem - y.ordem || x.nome.localeCompare(y.nome));
  const ordemDepois = depois.filter((c) => ordemAntes.split(",").includes(c.id)).map((c) => c.id).join();

  Object.assign(estado, copia);                           // "commit"
  return { data: {
    versao: versaoDe(estado, unidade.id),
    estrutura: a.p_estrutura !== estruturaAnt ? { de: estruturaAnt, para: a.p_estrutura } : null,
    escopo: escopo !== escopoAnt ? { de: escopoAnt, para: escopo } : null,
    ...diff,
    ordemAlterada: ordemAntes !== ordemDepois,
    ordem: depois.map((c) => ({ id: c.id, nome: c.nome })),
  }, error: null };
}

// --- fake supabase: leitura direta, escrita SÓ pela RPC -----------------------
function fakeDb(estado, opts = {}) {
  const log = [];
  return {
    log,
    async rpc(nome, args) {
      log.push({ rpc: nome, args });
      if (opts.rpcAusente) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${nome}` } };
      if (nome === "dashboard_ifood_config_versao") return { data: versaoDe(estado, args.p_unidade_id), error: null };
      if (nome === "dashboard_ifood_salvar_config_unidade") {
        opts.antesDaRpc?.(estado);
        if (opts.rpcErro) return { data: null, error: opts.rpcErro };
        return rpcSalvar(estado, args, opts);
      }
      throw new Error(`rpc inesperada: ${nome}`);
    },
    from(tabela) {
      const ctx = { filtros: [], single: false, escrita: null };
      const run = () => {
        log.push({ tabela, op: ctx.escrita ?? "select" });
        if (ctx.escrita) throw new Error(`escrita direta proibida em ${tabela} (${ctx.escrita}) — use a RPC atômica`);
        if (opts.falhas?.[tabela]) return { data: null, error: opts.falhas[tabela] };
        const achados = (estado[tabela] ?? []).filter((l) => ctx.filtros.every(([c, v]) => l[c] === v));
        return { data: ctx.single ? (achados[0] ?? null) : achados, error: null };
      };
      const b = {
        select() { return b; },
        eq(c, v) { ctx.filtros.push([c, v]); return b; },
        order() { return b; },
        insert() { ctx.escrita = "insert"; return b; },
        update() { ctx.escrita = "update"; return b; },
        upsert() { ctx.escrita = "upsert"; return b; },
        delete() { ctx.escrita = "delete"; return b; },
        maybeSingle() { ctx.single = true; return Promise.resolve().then(run); },
        single() { ctx.single = true; return Promise.resolve().then(run); },
        then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
      };
      return b;
    },
  };
}

function cenario({ config = [], canais = [], valores = [], modelo = "marketplace", modulosEmpresa = ["ifood_dashboard"], modulosUnidade = ["ifood_dashboard"], ...opts } = {}) {
  const estado = {
    unidades: [
      { id: UNI_A, nome: "Unidade A", organizacao_id: ORG_A },
      { id: UNI_A2, nome: "Unidade A2", organizacao_id: ORG_A },
      { id: UNI_B, nome: "Unidade B", organizacao_id: ORG_B },
    ],
    dashboard_ifood_unidade_config: config,
    dashboard_ifood_canais: canais,
    lancamentos_financeiros_canais: valores,
  };
  const db = fakeDb(estado, opts);
  const auditorias = [];
  const eventos = [];
  const deps = {
    supabase: db,
    auditar: async (e) => { auditorias.push(e); },
    emitirEvento: async (e) => { eventos.push(e); },
    modulosDaEmpresa: async () => modulosEmpresa,
    modulosDaUnidade: async () => modulosUnidade,
    obterModeloLogistico: async () => ({ modeloLogistico: modelo, modeloLogisticoRotulo: modelo === "full_service" ? "Full Service" : "Marketplace" }),
  };
  return { estado, db, auditorias, eventos, deps };
}

const canal = (id, nome, ordem, ativo = true, unidade = UNI_A, org = ORG_A) => ({ id, nome, ordem, ativo, unidade_id: unidade, organizacao_id: org });
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const C3 = "c3c3c3c3-0000-4000-8000-000000000003";
const CB = "cbcbcbcb-0000-4000-8000-00000000000b";   // canal da Unidade B (outra empresa)
const CA2 = "ca2ca2ca-0000-4000-8000-0000000000a2";  // canal da Unidade A2 (mesma empresa)

const chamadasSalvar = (db) => db.log.filter((l) => l.rpc === "dashboard_ifood_salvar_config_unidade");
const acoes = (auditorias) => auditorias.map((a) => a.acao);
const foto = (s) => JSON.stringify({ c: s.estado.dashboard_ifood_canais, cfg: s.estado.dashboard_ifood_unidade_config });

/** PUT como a tela faz: lê a versão atual (GET) e manda junto, salvo se `versao` vier explícita. */
async function salvar(s, body, unidade = UNI_A) {
  const versao = "versao" in body ? body.versao : (await obterConfigDashboardIfood(unidade, s.deps)).versao;
  return salvarConfigDashboardIfood(req, unidade, { ...body, versao }, s.deps);
}
const ligar = (s, extra = {}) => salvar(s, { sanduichesSaladas: true, ...extra });
const desligar = (s, extra = {}) => salvar(s, { sanduichesSaladas: false, ...extra });
const canaisDe = (s, unidade = UNI_A) => s.estado.dashboard_ifood_canais.filter((c) => c.unidade_id === unidade)
  .sort((a, b) => a.ordem - b.ordem).map((c) => ({ id: c.id, nome: c.nome, ativo: c.ativo, ordem: c.ordem }));
const configDe = (s, unidade = UNI_A) => s.estado.dashboard_ifood_unidade_config.find((c) => c.unidade_id === unidade);

// ---------------------------------------------------------------------------
describe("GET — leitura", () => {
  test("20: sem configuração -> opção DESLIGADA, nada é criado (nenhuma ativação automática)", async () => {
    const s = cenario();
    const r = await obterConfigDashboardIfood(UNI_A, s.deps);
    assert.equal(r.sanduichesSaladas, false);
    assert.equal(r.estrutura, "padrao");
    assert.deepEqual(r.canais, []);
    assert.equal(typeof r.versao, "string");
    assert.equal(chamadasSalvar(s.db).length, 0);
    assert.equal(s.estado.dashboard_ifood_unidade_config.length, 0);
    assert.equal(s.estado.dashboard_ifood_canais.length, 0);
  });

  test("20: nome da unidade/empresa não liga nada — uma unidade chamada 'Subway ...' continua desligada", async () => {
    const s = cenario();
    s.estado.unidades[0].nome = "Subway Saci — Matriz";
    const r = await obterConfigDashboardIfood(UNI_A, s.deps);
    assert.equal(r.sanduichesSaladas, false);
    assert.equal(chamadasSalvar(s.db).length, 0);
  });

  test("status do módulo é o estado REAL (empresa ∩ unidade)", async () => {
    assert.equal((await obterConfigDashboardIfood(UNI_A, cenario().deps)).modulo.ativo, true);
    assert.equal((await obterConfigDashboardIfood(UNI_A, cenario({ modulosUnidade: [] }).deps)).modulo.ativo, false);
  });

  test("unidade inexistente -> 404; migration ausente -> aviso no GET e 409 no PUT", async () => {
    await assert.rejects(obterConfigDashboardIfood("99999999-9999-4999-8999-999999999999", cenario().deps), (e) => e.statusCode === 404);
    const r = await obterConfigDashboardIfood(UNI_A, cenario({ rpcAusente: true }).deps);
    assert.deepEqual([r.migracaoPendente, r.sanduichesSaladas], [true, false]);
    await assert.rejects(salvarConfigDashboardIfood(req, UNI_A, { sanduichesSaladas: true, versao: "x" }, cenario({ rpcAusente: true }).deps), (e) => e.statusCode === 409);
  });
});

// ---------------------------------------------------------------------------
describe("PUT — ligar / desligar", () => {
  test("2/6: ligar cria EXATAMENTE Sanduíches e Saladas, estrutura multicanal, entregadores na unidade — numa RPC", async () => {
    const s = cenario();
    const r = await ligar(s);
    assert.equal(r.sanduichesSaladas, true);
    assert.equal(r.alterado, true);
    assert.deepEqual(canaisDe(s).map((c) => [c.nome, c.ativo, c.ordem]), [["Sanduíches", true, 0], ["Saladas", true, 1]]);
    assert.deepEqual([configDe(s).estrutura, configDe(s).taxas_entregadores_escopo], ["multicanal", "unidade"]);
    assert.equal(chamadasSalvar(s.db).length, 1);
    const args = chamadasSalvar(s.db)[0].args;
    assert.deepEqual([args.p_estrutura, args.p_escopo, args.p_organizacao_id], ["multicanal", "unidade", ORG_A]);
  });

  test("3/4: desligar volta ao padrão e NÃO apaga os canais nem o histórico deles", async () => {
    const s = cenario({ valores: [] });
    await ligar(s);
    const ids = canaisDe(s).map((c) => c.id);
    s.estado.lancamentos_financeiros_canais.push({ canal_id: ids[1], unidade_id: UNI_A, valor_vendas_ifood: 5000 });
    const antesValores = JSON.stringify(s.estado.lancamentos_financeiros_canais);
    const r = await desligar(s);
    assert.equal(r.sanduichesSaladas, false);
    assert.equal(configDe(s).estrutura, "padrao");
    assert.deepEqual(canaisDe(s).map((c) => c.id), ids);
    assert.equal(JSON.stringify(s.estado.lancamentos_financeiros_canais), antesValores);
    assert.equal(chamadasSalvar(s.db).at(-1).args.p_canais, null, "desligar não toca nos canais");
    assert.ok(!s.db.log.some((l) => l.tabela === "lancamentos_financeiros_diarios"), "nenhum dia é reinterpretado");
  });

  test("5: religar reaproveita os MESMOS ids", async () => {
    const s = cenario();
    await ligar(s);
    const ids = canaisDe(s).map((c) => c.id);
    await desligar(s);
    await ligar(s);
    assert.deepEqual(canaisDe(s).map((c) => c.id), ids);
    assert.equal(s.estado.dashboard_ifood_canais.length, 2);
  });

  test("7: nunca existe um terceiro canal ATIVO — um canal legado fica inativo, preservado (não apagado)", async () => {
    const s = cenario({ canais: [canal(C3, "Outro (legado)", 0), canal(C1, "saladas", 1)] });
    await ligar(s);
    const lista = canaisDe(s);
    assert.deepEqual(lista.filter((c) => c.ativo).map((c) => c.nome), ["Sanduíches", "Saladas"]);
    assert.equal(lista.find((c) => c.id === C1).nome, "Saladas", "reaproveita o existente de mesmo nome (sem diferenciar maiúsculas)");
    assert.deepEqual(lista.find((c) => c.id === C3), { id: C3, nome: "Outro (legado)", ativo: false, ordem: 2 });
    assert.equal(lista.length, 3, "nada apagado");
  });

  test("7: o corpo não aceita nomes, canais, quantidade nem escopo — só a opção", async () => {
    const s = cenario();
    await salvar(s, { sanduichesSaladas: true, canais: [{ nome: "Bebidas" }], taxasEntregadoresEscopo: "canal", estrutura: "multicanal" });
    assert.deepEqual(canaisDe(s).map((c) => c.nome), ["Sanduíches", "Saladas"]);
    assert.equal(configDe(s).taxas_entregadores_escopo, "unidade");
    await assert.rejects(salvar(s, { sanduichesSaladas: "sim" }), /sanduichesSaladas: true\/false/);
  });

  test("6: entregadores SEMPRE na unidade — inclusive ao ligar uma unidade com configuração legada 'canal'", async () => {
    const s = cenario({ config: [{ unidade_id: UNI_A, organizacao_id: ORG_A, estrutura: "padrao", taxas_entregadores_escopo: "canal" }] });
    await ligar(s);
    assert.equal(configDe(s).taxas_entregadores_escopo, "unidade");
  });

  test("Full Service não impede ligar (entregadores simplesmente não se aplica no lançamento)", async () => {
    const s = cenario({ modelo: "full_service" });
    const r = await ligar(s);
    assert.deepEqual([r.sanduichesSaladas, r.entregadoresAplicavel], [true, false]);
  });

  test("sem mudança: ligar o que já está ligado (ou desligar o desligado) não grava, não audita, não emite", async () => {
    const s = cenario();
    assert.equal((await desligar(s)).alterado, false);
    await ligar(s);
    const nAud = s.auditorias.length;
    const nEv = s.eventos.length;
    assert.equal((await ligar(s)).alterado, false);
    assert.equal(chamadasSalvar(s.db).length, 1);
    assert.deepEqual([s.auditorias.length, s.eventos.length], [nAud, nEv]);
  });
});

// ---------------------------------------------------------------------------
describe("18/19 — auditoria, concorrência, atomicidade", () => {
  test("18: auditoria do que DE FATO mudou, sem payload sensível; Realtime depois do commit", async () => {
    const s = cenario();
    await ligar(s);
    assert.deepEqual(acoes(s.auditorias), [
      ACOES.UNIDADE_DASHBOARD_IFOOD_ESTRUTURA, ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_CRIADO, ACOES.UNIDADE_DASHBOARD_IFOOD_CANAL_CRIADO,
    ]);
    assert.deepEqual(s.auditorias[0].detalhes, { unidade: "Unidade A", modalidade: "sanduiches_saladas", de: "padrao", para: "multicanal", sanduichesSaladas: true });
    assert.deepEqual(s.auditorias.slice(1).map((a) => a.detalhes.nome), ["Sanduíches", "Saladas"]);
    assert.ok(s.auditorias.every((a) => a.atorTipo === "superadmin" && a.entidadeId === UNI_A && a.organizacaoId === ORG_A));
    assert.deepEqual(s.eventos.map((e) => e.tipo), [EVENTOS_DASHBOARD_IFOOD.ESTRUTURA_ATUALIZADA]);
    await desligar(s);
    assert.deepEqual(s.auditorias.at(-1).detalhes, { unidade: "Unidade A", modalidade: "sanduiches_saladas", de: "multicanal", para: "padrao", sanduichesSaladas: false });
  });

  test("19: Admin B com tela antiga depois de Admin A -> 409, nada de B aplicado", async () => {
    const s = cenario();
    const telaDeB = await obterConfigDashboardIfood(UNI_A, s.deps);
    await ligar(s);
    const depoisDeA = foto(s);
    await assert.rejects(desligar(s, { versao: telaDeB.versao }), (e) => e.statusCode === 409 && e.codigo === "CONFIG_DESATUALIZADA");
    assert.equal(foto(s), depoisDeA);
  });

  test("19: conflito detectado só dentro da RPC -> 409", async () => {
    const s = cenario({ antesDaRpc: (estado) => { estado.dashboard_ifood_unidade_config.push({ unidade_id: UNI_A, organizacao_id: ORG_A, estrutura: "padrao", taxas_entregadores_escopo: "unidade", rev: 9 }); } });
    await assert.rejects(ligar(s), (e) => e.statusCode === 409);
    assert.equal(s.auditorias.length + s.eventos.length, 0);
  });

  test("falha da RPC no meio -> nada persiste, nada auditado, nenhum Realtime", async () => {
    for (const falharEm of ["canais", "config"]) {
      const s = cenario({ falharEm });
      const antes = foto(s);
      await assert.rejects(ligar(s), (e) => e.statusCode === 500);
      assert.equal(foto(s), antes);
      assert.equal(s.auditorias.length + s.eventos.length, 0);
    }
  });

  test("PUT sem versão é recusado; nenhuma escrita direta em tabela", async () => {
    const s = cenario();
    await assert.rejects(salvar(s, { sanduichesSaladas: true, versao: undefined }), (e) => e.statusCode === 400);
    await ligar(s);
    assert.ok(!s.db.log.some((l) => l.op && l.op !== "select"));
  });
});

describe("planejamento puro", () => {
  test("desligar nunca mexe em canais; ligar respeita ordem fixa Sanduíches, Saladas", () => {
    const atual = { estrutura: "multicanal", taxasEntregadoresEscopo: "unidade", canais: [] };
    assert.deepEqual(planejarSanduichesSaladas(atual, false), { estrutura: "padrao", escopo: "unidade", canais: null, mudou: true });
    const p = planejarSanduichesSaladas({ estrutura: "padrao", taxasEntregadoresEscopo: "unidade", canais: [] }, true);
    assert.deepEqual(p.canais, [{ nome: "Sanduíches", ativo: true }, { nome: "Saladas", ativo: true }]);
  });
});

// ---------------------------------------------------------------------------
describe("Autorização", () => {
  const passa = (user) => { let erro; requireSuperadmin({ user }, {}, (e) => { erro = e ?? null; }); return erro; };

  test("usuário não SuperAdmin é recusado pelo guard do router (mesmo com todas as permissões de tenant)", () => {
    assert.equal(passa({ id: "u", superadmin: false, permissoes: ["dashboard_executivo.configurar", "dashboard_executivo.corrigir"] }).statusCode, 403);
    assert.equal(passa({ id: "u", superadmin: false, painelAdministrativo: true }).statusCode, 403);
    assert.equal(passa({ id: "sa", superadmin: true }), null);
  });

  test("as rotas novas existem só no router da plataforma, que aplica requireSuperadmin a TODAS as rotas", () => {
    const camadas = plataformaRouter.stack;
    assert.equal(camadas[0].handle, requireSuperadmin, "requireSuperadmin é a primeira camada do router");
    const rotas = camadas.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    assert.ok(rotas.includes("GET /unidades/:id/dashboard-ifood"));
    assert.ok(rotas.includes("PUT /unidades/:id/dashboard-ifood"));
    const tenant = dashboardExecutivoRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(!tenant.some((p) => /estrutura|canais|dashboard-ifood/.test(p)), "nenhuma rota de configuração no mundo tenant");
  });
});
