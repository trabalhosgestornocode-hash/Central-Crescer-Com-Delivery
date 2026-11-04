// Fase B — agendador Foody embarcado: flags, guarda de efeitos externos, trava compartilhada com a tela, interrupção entre dias,
// parada graciosa, primeiro ciclo atrasado e (com Postgres local) a migration 150. Nada fala com a Foody nem com o Supabase.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarFoodyEmbutido, pararFoodyEmbutido, resumirCiclo, ATRASO_INICIAL_MS, LIMITES_AGENDADOR, _agendadorAtual } from "../src/worker-foody/foody.embedded.js";
import { executarCicloFoody, criarAgendadorFoody } from "../src/modules/foody/foody.agendador.js";
import { reservarUnidade, UNIDADES_EM_COLETA } from "../src/modules/foody/foody.trava.js";
import { solicitarSyncManual, criarEstadoSyncManual } from "../src/modules/foody/foody.sync.manual.js";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";
import { join } from "node:path";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG = "11111111-1111-4111-8111-111111111111", UNI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", UNI2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ON = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_AGENDADOR_ENABLED: "true", FOODY_CENTRAL_UNIDADES: `${UNI},${UNI2}`,
  EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true" };
const AGORA = () => new Date("2026-11-05T12:00:00Z");

function repoFalso({ conexoes = { [UNI]: { id: "c1", status: "ATIVA" }, [UNI2]: { id: "c2", status: "ATIVA" } }, abertas = [] } = {}) {
  const concluidas = [];
  return {
    concluidas,
    async obterConexao(t) { const c = conexoes[t.unidadeId]; return c ? { ...c, organizacao_id: t.organizacaoId, unidade_id: t.unidadeId } : null; },
    async listarExecucoesEmAndamento(t) { return abertas.filter((a) => a.unidade_id === t.unidadeId); },
    async concluirExecucao(t, id, campos) { concluidas.push({ id, ...campos }); },
    async listarConexoesAtivasDaAllowlist(ids) { return [...ids].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })); },
  };
}
const temporizadorFalso = () => { const chamadas = []; return { chamadas, set: (fn, ms) => { chamadas.push(ms); return chamadas.length; }, clear: () => {} }; };

describe("ponte embutida (worker-foody/foody.embedded.js)", () => {
  test("flags desligadas: não monta nada (nem import dinâmico)", async () => {
    let montou = false;
    for (const env of [{}, { ...ON, FOODY_CENTRAL_AGENDADOR_ENABLED: "TRUE " + "x" }, { ...ON, FOODY_CENTRAL_ENABLED: "1" }, { ...ON, FOODY_CENTRAL_UNIDADES: "" }]) {
      const r = await iniciarFoodyEmbutido({ env, montar: async () => { montou = true; } });
      assert.equal(r.habilitado, false);
    }
    assert.equal(montou, false);
  });
  test("guarda de efeitos externos: PR Preview e Render sem autorização bloqueiam mesmo com as flags", async () => {
    let montou = false;
    const base = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_AGENDADOR_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI };
    for (const env of [{ ...base, IS_PULL_REQUEST: "true", RENDER: "true" }, { ...base, RENDER: "true", IS_PULL_REQUEST: "false" }, base]) {
      const r = await iniciarFoodyEmbutido({ env, montar: async () => { montou = true; } });
      assert.equal(r.habilitado, false); assert.match(r.motivo, /efeitos externos bloqueados/);
    }
    assert.equal(montou, false);
  });
  test("segredo ausente: não inicia e não expõe nada", async () => {
    const logs = [];
    const r = await iniciarFoodyEmbutido({ env: ON, log: (...a) => logs.push(a), montar: async () => { throw Object.assign(new Error("x"), { codigo: "SEGREDO_AUSENTE" }); } });
    assert.deepEqual(r, { habilitado: false, motivo: "FOODY_CENTRAL_SECRET ausente" });
    assert.equal(_agendadorAtual(), null);
    assert.doesNotMatch(JSON.stringify(logs), /FOODY_CENTRAL_SECRET=/);
  });
  test("ligado: primeiro ciclo ATRASADO (3 min), trava ligada, limites da tela; parada idempotente", async () => {
    const tmp = temporizadorFalso();
    let opcoes = null;
    const r = await iniciarFoodyEmbutido({ env: ON, montar: async () => ({
      repo: repoFalso(), seguranca: {}, temporizador: tmp,
      criarAgendadorFoody: (o) => { opcoes = o; return criarAgendadorFoody(o); },
    }) });
    assert.equal(r.habilitado, true);
    assert.deepEqual(tmp.chamadas, [ATRASO_INICIAL_MS]);
    assert.equal(ATRASO_INICIAL_MS, 180_000);
    assert.equal(opcoes.trava, true);
    assert.deepEqual(opcoes.deps.limites, LIMITES_AGENDADOR);
    assert.equal((await iniciarFoodyEmbutido({ env: ON, montar: async () => { throw new Error("não deveria montar de novo"); } })).motivo, "já iniciado");
    await pararFoodyEmbutido("SIGTERM");
    assert.equal(_agendadorAtual(), null);
    await pararFoodyEmbutido("SIGTERM");   // no-op
  });
  test("resumo do ciclo: só contagens e códigos (sem ids de unidade nem de pedido)", () => {
    const r = resumirCiclo([{ unidadeId: UNI, competencia: "2026-11-04", resultado: "REGISTRADO" }, { unidadeId: UNI, competencia: "2026-11-03", resultado: "SEM_MUDANCA" },
      { unidadeId: UNI, competencia: "2026-11-02", erro: "AUTENTICACAO" }, { unidadeId: UNI2, erro: "CONCORRENCIA" }]);
    assert.deepEqual(r, { dias: 3, registrados: 1, semMudanca: 1, reconciliacoes: 0, erros: { AUTENTICACAO: 1, CONCORRENCIA: 1 } });
    assert.doesNotMatch(JSON.stringify(r), /aaaaaaaa|bbbbbbbb/);
  });
});

describe("ciclo com trava (executarCicloFoody, trava: true)", () => {
  const u = [{ organizacaoId: ORG, unidadeId: UNI }];
  test("unidade já em coleta no processo (tela) → CONCORRENCIA, sem chamar a coleta", async () => {
    let chamou = 0;
    UNIDADES_EM_COLETA.add(UNI);
    try {
      const r = await executarCicloFoody({ unidades: u, env: ON, agora: AGORA, trava: true, deps: { repo: repoFalso() }, executar: async () => { chamou++; return {}; } });
      assert.deepEqual(r, [{ unidadeId: UNI, erro: "CONCORRENCIA" }]);
      assert.equal(chamou, 0);
    } finally { UNIDADES_EM_COLETA.delete(UNI); }
  });
  test("EM_ANDAMENTO recente no banco (outra instância) → CONCORRENCIA; antiga → ABANDONADA e roda", async () => {
    let chamou = 0;
    const executar = async (p) => { chamou++; return { fechamento: { resultado: "REGISTRADO" } }; };
    const recente = repoFalso({ abertas: [{ id: "e1", unidade_id: UNI, iniciado_em: "2026-11-05T11:30:00Z" }] });
    assert.deepEqual(await executarCicloFoody({ unidades: u, env: ON, agora: AGORA, trava: true, deps: { repo: recente }, executar }), [{ unidadeId: UNI, erro: "CONCORRENCIA" }]);
    assert.equal(chamou, 0);
    const antiga = repoFalso({ abertas: [{ id: "e0", unidade_id: UNI, iniciado_em: "2026-11-05T09:00:00Z" }] });
    const r = await executarCicloFoody({ unidades: u, env: ON, agora: AGORA, trava: true, deps: { repo: antiga }, executar });
    assert.deepEqual(antiga.concluidas, [{ id: "e0", status: "FALHOU", erro_codigo: "ABANDONADA" }]);
    assert.deepEqual(r.map((x) => x.competencia), ["2026-11-04", "2026-11-03", "2026-11-02"], "D-1, D-2, D-3");
    assert.equal(UNIDADES_EM_COLETA.has(UNI), false, "trava liberada no fim");
  });
  test("conexão ausente ou não ATIVA → pula a unidade sem coletar", async () => {
    const r = await executarCicloFoody({ unidades: [...u, { organizacaoId: ORG, unidadeId: UNI2 }], env: ON, agora: AGORA, trava: true,
      deps: { repo: repoFalso({ conexoes: { [UNI2]: { id: "c2", status: "PAUSADA" } } }) }, executar: async () => assert.fail("não coleta") });
    assert.deepEqual(r, [{ unidadeId: UNI, erro: "SEM_CONEXAO" }, { unidadeId: UNI2, erro: "CONEXAO_INATIVA" }]);
  });
  test("erro na coleta libera a trava (a tela consegue sincronizar depois)", async () => {
    const r = await executarCicloFoody({ unidades: u, env: ON, agora: AGORA, trava: true, deps: { repo: repoFalso() },
      executar: async () => { throw Object.assign(new Error("x"), { codigo: "AUTENTICACAO" }); } });
    assert.deepEqual(r, [{ unidadeId: UNI, competencia: "2026-11-04", erro: "AUTENTICACAO" }], "401 para os outros dias");
    assert.equal(UNIDADES_EM_COLETA.has(UNI), false);
  });
  test("agendador coletando → a sincronização manual da tela recebe CONCORRENCIA (mesma trava do processo)", async () => {
    const repo = { ...repoFalso(), obterConexao: async (t) => ({ id: "c1", status: "ATIVA", organizacao_id: t.organizacaoId, unidade_id: t.unidadeId }) };
    let liberarDia;
    const executar = () => new Promise((r) => { liberarDia = () => r({ fechamento: { resultado: "REGISTRADO" } }); });
    const ciclo = executarCicloFoody({ unidades: u, env: ON, agora: AGORA, trava: true, deps: { repo }, executar, deveParar: (() => { let n = 0; return () => n++ > 1; })() });
    await new Promise((r) => setImmediate(r));
    const tela = await solicitarSyncManual({ ator: { perfilId: "a1000000-0000-4000-8000-000000000001", papel: "organization_admin", impersonando: false, organizacaoId: ORG }, tenant: { organizacaoId: ORG, unidadeId: UNI }, competencias: ["2026-11-04"] },
      { env: { ...ON, FOODY_CENTRAL_ADMIN_ENABLED: "true" }, repo, agora: AGORA, estado: criarEstadoSyncManual(), executar: async () => assert.fail("não coleta"), log: () => {} })
      .then(() => "aceitou", (e) => e.codigo);
    assert.equal(tela, "CONCORRENCIA");
    liberarDia();
    await ciclo;
    assert.equal(UNIDADES_EM_COLETA.has(UNI), false);
  });
});

describe("parada graciosa (criarAgendadorFoody)", () => {
  test("parar() durante um dia: termina o dia em curso, NÃO começa o próximo e não reagenda", async () => {
    const tmp = temporizadorFalso();
    const feitos = [];
    let liberar;
    const executar = (p) => new Promise((r) => { liberar = () => { feitos.push(p.competencia); r({ fechamento: { resultado: "REGISTRADO" } }); }; });
    let resumo = null;
    const ag = criarAgendadorFoody({ unidades: [{ organizacaoId: ORG, unidadeId: UNI }], env: ON, agora: AGORA, executar, temporizador: tmp, aoTerminarCiclo: (r) => { resumo = r; } });
    ag.iniciar();
    const ciclo = ag.tique();
    await new Promise((r) => setImmediate(r));
    assert.equal(ag.rodando, true);
    const parada = ag.parar();
    liberar();
    await parada; await ciclo;
    assert.deepEqual(feitos, ["2026-11-04"]);
    assert.deepEqual(resumo.map((x) => x.erro ?? "ok"), ["ok", "INTERROMPIDO", "INTERROMPIDO"]);
    assert.deepEqual(tmp.chamadas, [0], "nenhum novo agendamento depois de parar");
    assert.equal(ag.ativo, false);
  });
  test("falha ao listar unidades não derruba o laço: registra e reagenda", async () => {
    const tmp = temporizadorFalso();
    const falhas = [];
    const ag = criarAgendadorFoody({ unidades: async () => { throw Object.assign(new Error("banco fora"), { codigo: "BANCO" }); }, env: ON, agora: AGORA,
      temporizador: tmp, intervaloMs: 1234, aoFalharCiclo: (e) => falhas.push(e.codigo) });
    ag.iniciar();
    await ag.tique();
    assert.deepEqual(falhas, ["BANCO"]);
    assert.deepEqual(tmp.chamadas, [0, 1234]);
    await ag.parar();
  });
  test("flag do agendador desligada em execução: para sozinho e não reagenda", async () => {
    const tmp = temporizadorFalso();
    const env = { ...ON };
    const ag = criarAgendadorFoody({ unidades: [], env, agora: AGORA, temporizador: tmp });
    ag.iniciar();
    env.FOODY_CENTRAL_AGENDADOR_ENABLED = "false";
    await ag.tique();
    assert.equal(ag.ativo, false);
    assert.deepEqual(tmp.chamadas, [0]);
  });
});

describe("trava (foody.trava.js)", () => {
  test("reserva → libera; erro na leitura do banco libera a memória", async () => {
    const r = await reservarUnidade({ t: { organizacaoId: ORG, unidadeId: UNI }, conexaoId: "c1", repo: repoFalso(), agora: AGORA });
    assert.equal(UNIDADES_EM_COLETA.has(UNI), true);
    r.liberar();
    assert.equal(UNIDADES_EM_COLETA.has(UNI), false);
    await assert.rejects(reservarUnidade({ t: { organizacaoId: ORG, unidadeId: UNI }, conexaoId: "c1", agora: AGORA,
      repo: { ...repoFalso(), listarExecucoesEmAndamento: async () => { throw new Error("banco fora"); } } }), /banco fora/);
    assert.equal(UNIDADES_EM_COLETA.has(UNI), false);
  });
});

describe("migration 150 — Postgres real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b;
  const q = (texto) => psqlSync(b.url, texto);
  const CX = "c0000000-0000-4000-8000-000000000001";
  const inserirExec = (status = "EM_ANDAMENTO") => q(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao, status)
    values ('${ORG}', '${UNI}', '${CX}', '2026-11-04', '2026-11-04T03:00:00Z', '2026-11-05T03:00:00Z', 'manual', 1, '${status}');`);
  before(() => {
    b = criarBancoDescartavel("foodyagendador150");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 149 }), []);
    const l = prepararConexao({ organizacaoId: ORG, unidadeId: UNI, token: TOKEN_TESTE }, criarSegurancaFoody(SEGREDO_TESTE));
    const r = q(`insert into organizacoes (id, nome) values ('${ORG}', 'org'); insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'u');
      insert into foody_conexoes (id, organizacao_id, unidade_id, status, token_cifrado, token_impressao) values ('${CX}', '${ORG}', '${UNI}', 'PAUSADA', '${l.token_cifrado}', '${l.token_impressao}');`);
    assert.equal(r.ok, true, r.err);
  });
  after(() => b?.derrubar?.());
  const aplicar150 = () => psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "150_foody_sync_uma_em_andamento.sql") });
  test("recusa aplicar com duas EM_ANDAMENTO na mesma unidade, sem alterar nada", () => {
    assert.equal(inserirExec().ok, true); assert.equal(inserirExec().ok, true);
    const r = aplicar150();
    assert.equal(r.ok, false); assert.match(r.err, /150 recusada/);
    assert.equal(q(`select count(*) from pg_indexes where indexname = 'foody_sync_execucoes_uma_em_andamento';`).out.trim(), "0");
    assert.equal(q(`select count(*) from foody_sync_execucoes where status = 'EM_ANDAMENTO';`).out.trim(), "2");
  });
  test("aplicada: segunda EM_ANDAMENTO da unidade → 23505; concluídas não contam; rollback remove só o índice", () => {
    assert.equal(q(`update foody_sync_execucoes set status = 'FALHOU', erro_codigo = 'ABANDONADA', concluido_em = now() where status = 'EM_ANDAMENTO';`).ok, true);
    const ap = aplicar150(); assert.equal(ap.ok, true, ap.err);
    assert.equal(aplicar150().ok, true, "idempotente");
    assert.equal(inserirExec().ok, true);
    const dup = inserirExec();
    assert.equal(dup.ok, false); assert.match(dup.err, /foody_sync_execucoes_uma_em_andamento/);
    assert.equal(inserirExec("FALHOU").ok, true, "execuções encerradas não são limitadas");
    const rb = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "150_rollback.sql") }); assert.equal(rb.ok, true, rb.err);
    assert.equal(q(`select count(*) from pg_indexes where indexname = 'foody_sync_execucoes_uma_em_andamento';`).out.trim(), "0");
    assert.equal(q(`select count(*) from foody_sync_execucoes;`).out.trim(), "4", "rollback não toca dados");
  });
});
