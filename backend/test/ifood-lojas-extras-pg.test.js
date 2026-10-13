// Lojas ADICIONAIS por conexão (migration 117) em Postgres LOCAL e DESCARTÁVEL, sobre o schema REAL do projeto (base + 068..117):
// a migration, as constraints, o gatilho de estados, as funções SQL, as permissões (backend-only), os scripts de operação
// (cadastrar / liberar / desativar), o rollback e — de ponta a ponta — o poller com o repositório REAL falando (via PostgREST falso)
// com este banco: o bloqueio por 403 é PERSISTENTE (um poller novo, depois de "reiniciar", não consulta a loja de novo).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --experimental-vm-modules --test test/ifood-lojas-extras-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const OPS = join(MIGRATIONS_DIR, "..", "operacoes");
const M117 = join(MIGRATIONS_DIR, "117_ifood_conexao_lojas.sql");
const R117 = join(MIGRATIONS_DIR, "117_rollback.sql");
const R118 = join(MIGRATIONS_DIR, "118_rollback.sql");   // a 118 depende da tabela da 117: o rollback é na ORDEM INVERSA (118 antes da 117)

const ORG = "00000000-0000-0000-0000-0000000000a0"; const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const UN_A = "00000000-0000-0000-0000-0000000000a1"; const UN_B = "00000000-0000-0000-0000-0000000000b1";
const CON_A = "11111111-1111-4111-8111-1111111111a1"; const CON_B = "11111111-1111-4111-8111-1111111111b1";
const M_SAND = "a6e54f00-0000-4000-8000-0000000039b9"; const M_OUT = "55c8f400-0000-4000-8000-000000007040";
const M_SAL = "04a17bf5-b9e6-4693-a862-a5715e9f9374"; const M_X = "cccccccc-0000-4000-8000-00000000000c";

/** psql com variáveis (-v), como o responsável rodaria os scripts de operação. Devolve { ok, out, err }. */
function psqlComVars(url, arquivo, vars) {
  const args = [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", arquivo];
  const r = spawnSync(process.env.EXIBICAO_PSQL || "psql", args, { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" }, timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe("lojas adicionais por conexão (117) — Postgres descartável, schema real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b; let falhas;
  const q = (t) => sql(b.url, t);
  const tenta = (t) => psqlSync(b.url, t);
  const estadoDe = (m) => q(`select estado || '|' || verificacoes || '|' || coalesce(bloqueio_motivo, '-') from ifood_conexao_lojas where merchant_id = '${m}' and estado <> 'desativada' order by criado_em desc limit 1`);
  const cadastrar = (m, rotulo = "Saladas", unidade = UN_A) => psqlComVars(b.url, join(OPS, "ifood-loja-extra-cadastrar.sql"), { unidade, merchant: m, rotulo });
  const liberar = (m, por = "responsavel (teste)") => psqlComVars(b.url, join(OPS, "ifood-loja-extra-liberar.sql"), { merchant: m, por });
  const ok = (r) => assert.equal(r.ok, true, r.err);
  const desativar = (m) => psqlComVars(b.url, join(OPS, "ifood-loja-extra-desativar.sql"), { merchant: m });

  before(() => {
    b = criarBancoDescartavel("lojas_extras");
    falhas = construirSchemaReal(b.url);
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A'), ('${ORG2}', 'Org B');
       insert into unidades (id, nome, organizacao_id) values ('${UN_A}', 'Subway Saci — Matriz', '${ORG}'), ('${UN_B}', 'Outra loja', '${ORG2}');
       insert into ifood_conexoes (id, organizacao_id, unidade_id, merchant_id, status) values
         ('${CON_A}', '${ORG}', '${UN_A}', '${M_SAND}', 'ativa'), ('${CON_B}', '${ORG2}', '${UN_B}', '${M_OUT}', 'ativa');
       insert into ifood_credenciais (conexao_id, app_type, access_token_cifrado, refresh_token_cifrado, expira_em, status) values
         ('${CON_A}', 'order', 'x', 'y', now() + interval '1 hour', 'ativa'), ('${CON_B}', 'order', 'x', 'y', now() + interval '1 hour', 'ativa');`);
  });
  after(() => b?.derrubar());

  // =====================================================================
  describe("migration, permissões e restrições", () => {
    test("o schema real (base + 068..117) aplica sem falhas; reaplicar a 117 é idempotente", () => {
      assert.deepEqual(falhas, [], JSON.stringify(falhas));
      assert.equal(psqlSync(b.url, "", { arquivo: M117 }).ok, true);
      assert.equal(q("select count(*) from ifood_conexao_lojas"), "0");
    });

    test("backend-only: RLS ligada, ZERO policies, anon/authenticated/PUBLIC sem nenhum privilégio; service_role só select/insert/update", () => {
      assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.ifood_conexao_lojas'::regclass"), "true");
      assert.equal(q("select count(*) from pg_policy where polrelid = 'public.ifood_conexao_lojas'::regclass"), "0");
      for (const papel of ["anon", "authenticated"]) {
        assert.equal(q(`select has_table_privilege('${papel}', 'public.ifood_conexao_lojas', 'select,insert,update,delete,truncate,references,trigger')::text`), "false", papel);
        for (const f of ["ifood_loja_iniciar_verificacao(uuid, integer)", "ifood_loja_marcar_ativa(uuid)", "ifood_loja_bloquear(uuid, text)"]) {
          assert.equal(q(`select has_function_privilege('${papel}', 'public.${f}', 'execute')::text`), "false", `${papel} ${f}`);
        }
      }
      assert.equal(q("select has_table_privilege('service_role', 'public.ifood_conexao_lojas', 'select,insert,update')::text"), "true");
      assert.equal(q("select has_table_privilege('service_role', 'public.ifood_conexao_lojas', 'delete')::text"), "false");
      for (const f of ["ifood_loja_iniciar_verificacao(uuid, integer)", "ifood_loja_marcar_ativa(uuid)", "ifood_loja_bloquear(uuid, text)"]) {
        assert.equal(q(`select has_function_privilege('service_role', 'public.${f}', 'execute')::text`), "true", f);
      }
      // PUBLIC (pseudo-role) também não executa
      assert.equal(q("select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname like 'ifood_loja_%' and a.grantee = 0"), "0");
    });

    test("nenhuma coluna das tabelas existentes mudou (migration 100% aditiva)", () => {
      assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_conexoes' and column_name in ('merchant_id', 'unidade_id', 'organizacao_id', 'status', 'merchant_nome')"), "5");
      assert.equal(q("select count(*) from pg_indexes where indexname in ('uq_ifood_conexao_unidade_viva', 'uq_ifood_conexao_merchant_vivo')"), "2");
    });

    test("rejeita: merchant fora do formato UUID, rótulo vazio/longo, estado inicial diferente de `pendente`", () => {
      const ins = (extra) => tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id ${extra.col ?? ""}) values ('${CON_A}', '${ORG}', '${UN_A}', '${extra.m ?? M_SAL}' ${extra.val ?? ""})`);
      assert.equal(ins({ m: "nao-e-uuid" }).ok, false);
      assert.equal(ins({ col: ", rotulo", val: ", '   '" }).ok, false);
      assert.equal(ins({ col: ", rotulo", val: `, '${"x".repeat(41)}'` }).ok, false);
      assert.match(ins({ col: ", estado, liberada_em", val: ", 'liberada', now()" }).err, /nasce `pendente`/);
      assert.match(ins({ col: ", estado, ativada_em", val: ", 'ativa', now()" }).err, /nasce `pendente`/);
      assert.equal(q("select count(*) from ifood_conexao_lojas"), "0");
    });

    test("isolamento: a loja só pode ter a organização/unidade DA conexão (outra unidade, outra organização: recusado)", () => {
      assert.match(tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_B}', '${M_SAL}')`).err, /diferem as da conexão/);
      assert.match(tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG2}', '${UN_A}', '${M_SAL}')`).err, /diferem as da conexão/);
      assert.match(tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('99999999-9999-4999-8999-999999999999', '${ORG}', '${UN_A}', '${M_SAL}')`).err, /não existe|foreign key|violates/);
    });

    test("o merchant adicional não pode ser a loja principal de nenhuma conexão viva (nem da outra unidade) e não repete entre lojas vivas", () => {
      for (const m of [M_SAND, M_OUT]) {
        assert.match(tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_A}', '${m}')`).err, /já é a loja principal/);
      }
      q(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id, rotulo) values ('${CON_A}', '${ORG}', '${UN_A}', '${M_X}', 'X')`);
      assert.match(tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_A}', '${M_X}')`).err, /duplicate key|unique/);
      q(`update ifood_conexao_lojas set estado = 'desativada', desativada_em = now() where merchant_id = '${M_X}'`);
      q(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_A}', '${M_X}')`);   // desativada libera o merchant
      q(`delete from ifood_conexao_lojas where merchant_id = '${M_X}'`);
    });

    test("a loja principal e a conexão continuam intactas: o cadastro de loja adicional não altera ifood_conexoes", () => {
      assert.equal(q(`select merchant_id || '|' || status from ifood_conexoes where id = '${CON_A}'`), `${M_SAND}|ativa`);
    });
  });

  // =====================================================================
  describe("máquina de estados e funções SQL", () => {
    const nova = (m) => { q(`delete from ifood_conexao_lojas where merchant_id = '${m}'`); q(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_A}', '${m}')`); return q(`select id from ifood_conexao_lojas where merchant_id = '${m}'`); };
    const set = (m, trecho) => tenta(`update ifood_conexao_lojas set ${trecho} where merchant_id = '${m}'`);

    test("transições proibidas são recusadas pelo banco (pendente→ativa, pendente→bloqueada, ativa→liberada…)", () => {
      nova(M_X);
      assert.match(set(M_X, "estado = 'ativa', ativada_em = now()").err, /transição pendente -> ativa/);
      assert.match(set(M_X, "estado = 'bloqueada', bloqueada_em = now(), bloqueio_motivo = 'X'").err, /transição pendente -> bloqueada/);
      assert.equal(set(M_X, "estado = 'liberada', liberada_em = now()").ok, true);
      assert.equal(set(M_X, "estado = 'ativa', ativada_em = now()").ok, true);
      assert.match(set(M_X, "estado = 'liberada', liberada_em = now()").err, /transição ativa -> liberada/);
      assert.match(set(M_X, "estado = 'pendente'").err, /transição ativa -> pendente/);
    });

    test("conexão, merchant e tenant são imutáveis; CHECKs exigem os carimbos de cada estado", () => {
      nova(M_X);
      assert.match(set(M_X, `merchant_id = '${M_SAL}'`).err, /não mudam/);
      // outra conexão da MESMA unidade (revogada, que o índice único permite): o tenant confere, então é a imutabilidade que recusa
      q(`insert into ifood_conexoes (id, organizacao_id, unidade_id, status) values ('11111111-1111-4111-8111-1111111111c1', '${ORG}', '${UN_A}', 'revogada') on conflict do nothing`);
      assert.match(set(M_X, `conexao_id = '11111111-1111-4111-8111-1111111111c1'`).err, /não mudam/);
      assert.match(set(M_X, `conexao_id = '${CON_B}'`).err, /diferem as da conexão/);
      assert.match(set(M_X, "estado = 'liberada'").err, /ck_ifood_conexao_lojas_liberada|violates check/);
    });

    test("SAÍDA do bloqueio: só com a liberação supervisionada explícita (chave na transação)", () => {
      nova(M_X);
      q(`update ifood_conexao_lojas set estado = 'liberada', liberada_em = now() where merchant_id = '${M_X}'`);
      assert.equal(q(`select ifood_loja_bloquear(id, 'SEM_AUTORIZACAO')::text from ifood_conexao_lojas where merchant_id = '${M_X}'`), "true");
      assert.equal(estadoDe(M_X), "bloqueada|0|SEM_AUTORIZACAO");
      // sem a chave: recusado, e nenhuma função do poller reabre
      assert.match(set(M_X, "estado = 'liberada', liberada_em = now()").err, /exige a liberação supervisionada/);
      assert.match(set(M_X, "estado = 'ativa', ativada_em = now()").err, /transição bloqueada -> ativa/);
      assert.equal(q(`select ifood_loja_marcar_ativa(id)::text from ifood_conexao_lojas where merchant_id = '${M_X}'`), "false");
      assert.equal(q(`select ifood_loja_iniciar_verificacao(id, 3) from ifood_conexao_lojas where merchant_id = '${M_X}'`), "estado_invalido");
      // com a chave (o que o script de liberação faz): permitido
      assert.equal(tenta(`begin; set local app.liberacao_supervisionada = 'on'; update ifood_conexao_lojas set estado = 'liberada', liberada_em = now() where merchant_id = '${M_X}'; commit;`).ok, true);
      assert.equal(q(`select estado from ifood_conexao_lojas where merchant_id = '${M_X}'`), "liberada");
    });

    test("iniciar_verificacao: conta até o máximo e então bloqueia (TENTATIVAS_ESGOTADAS); não funciona fora de `liberada`", () => {
      const id = nova(M_X);
      assert.equal(q(`select ifood_loja_iniciar_verificacao('${id}', 3)`), "estado_invalido");
      q(`update ifood_conexao_lojas set estado = 'liberada', liberada_em = now() where id = '${id}'`);
      assert.deepEqual([1, 2, 3].map(() => q(`select ifood_loja_iniciar_verificacao('${id}', 3)`)), ["ok", "ok", "ok"]);
      assert.equal(q(`select ifood_loja_iniciar_verificacao('${id}', 3)`), "bloqueada");
      assert.equal(estadoDe(M_X), "bloqueada|3|TENTATIVAS_ESGOTADAS");
      assert.equal(q(`select ifood_loja_iniciar_verificacao('${id}', 3)`), "estado_invalido");
      assert.equal(q("select ifood_loja_iniciar_verificacao('99999999-9999-4999-8999-999999999999', 3)"), "nao_encontrada");
    });

    test("marcar_ativa só a partir de `liberada`; bloquear é idempotente (segunda vez = false) e funciona em `ativa`", () => {
      const id = nova(M_X);
      assert.equal(q(`select ifood_loja_marcar_ativa('${id}')::text`), "false");
      q(`update ifood_conexao_lojas set estado = 'liberada', liberada_em = now() where id = '${id}'`);
      assert.equal(q(`select ifood_loja_marcar_ativa('${id}')::text`), "true");
      assert.equal(q(`select ifood_loja_marcar_ativa('${id}')::text`), "false");
      assert.equal(q(`select ifood_loja_bloquear('${id}', '  ')::text`), "true");
      assert.equal(estadoDe(M_X), "bloqueada|0|BLOQUEADA");
      assert.equal(q(`select ifood_loja_bloquear('${id}', 'OUTRO')::text`), "false");
      assert.equal(q(`select bloqueios from ifood_conexao_lojas where id = '${id}'`), "1");
    });
  });

  // =====================================================================
  describe("scripts de operação (cadastrar → liberar → desativar)", () => {
    test("cadastrar: nasce `pendente`, com auditoria, SEM consulta ao iFood; rótulo gravado", () => {
      q(`delete from ifood_conexao_lojas`);
      const r = cadastrar(M_SAL, "Saladas");
      assert.equal(r.ok, true, r.err);
      assert.equal(estadoDe(M_SAL), "pendente|0|-");
      assert.equal(q(`select rotulo from ifood_conexao_lojas where merchant_id = '${M_SAL}'`), "Saladas");
      assert.equal(q("select count(*) from plataforma_auditoria where acao = 'ifood.loja_extra_cadastrada'"), "1");
      assert.equal(q("select detalhes->>'consulta_ao_ifood' from plataforma_auditoria where acao = 'ifood.loja_extra_cadastrada'"), "false");
    });

    test("cadastrar ABORTA sem gravar nada: merchant principal, merchant inválido, repetido, unidade sem conexão ativa/credencial Order", () => {
      const antes = q("select count(*) from ifood_conexao_lojas") + "/" + q("select count(*) from plataforma_auditoria");
      assert.equal(cadastrar(M_SAND).ok, false);                                 // é a loja principal
      assert.equal(cadastrar("nao-e-uuid").ok, false);
      assert.equal(cadastrar(M_SAL).ok, false);                                  // já cadastrada
      q(`update ifood_credenciais set status = 'reauth_required' where conexao_id = '${CON_B}'`);
      assert.equal(cadastrar(M_X, "X", UN_B).ok, false);                         // credencial Order não está `ativa`
      q(`update ifood_credenciais set status = 'ativa' where conexao_id = '${CON_B}'`);
      assert.equal(cadastrar(M_X, "X", "99999999-9999-4999-8999-999999999999").ok, false);   // unidade inexistente
      assert.equal(q("select count(*) from ifood_conexao_lojas") + "/" + q("select count(*) from plataforma_auditoria"), antes);
    });

    test("liberar: pendente → liberada com quem autorizou e auditoria; não consulta o iFood (quem consulta é o poller)", () => {
      const r = liberar(M_SAL, "Gerente de Delivery");
      assert.equal(r.ok, true, r.err);
      assert.equal(estadoDe(M_SAL), "liberada|0|-");
      assert.equal(q(`select liberada_por from ifood_conexao_lojas where merchant_id = '${M_SAL}'`), "Gerente de Delivery");
      assert.match(q("select detalhes->>'consulta_feita_por' from plataforma_auditoria where acao = 'ifood.loja_extra_liberada'"), /poller/);
    });

    test("liberar ABORTA se não houver loja pendente/bloqueada com o merchant (já liberada, inexistente, desativada)", () => {
      assert.equal(liberar(M_SAL).ok, false);                                    // já liberada
      assert.equal(liberar(M_X).ok, false);                                      // não existe
      assert.equal(estadoDe(M_SAL), "liberada|0|-");
    });

    test("depois de BLOQUEADA, o script de liberação supervisionada é o único caminho de volta (zera tentativas e limpa o bloqueio)", () => {
      q(`select ifood_loja_bloquear(id, 'SEM_AUTORIZACAO') from ifood_conexao_lojas where merchant_id = '${M_SAL}'`);
      assert.equal(estadoDe(M_SAL), "bloqueada|0|SEM_AUTORIZACAO");
      const r = liberar(M_SAL, "Responsavel");
      assert.equal(r.ok, true, r.err);
      assert.equal(estadoDe(M_SAL), "liberada|0|-");
      assert.equal(q(`select bloqueios from ifood_conexao_lojas where merchant_id = '${M_SAL}'`), "1", "o histórico de bloqueios é preservado");
    });

    test("desativar: encerra o cadastro com auditoria, preserva a linha; depois não há o que desativar", () => {
      const r = desativar(M_SAL);
      assert.equal(r.ok, true, r.err);
      assert.equal(q(`select estado from ifood_conexao_lojas where merchant_id = '${M_SAL}'`), "desativada");
      assert.equal(q("select count(*) from plataforma_auditoria where acao = 'ifood.loja_extra_desativada'"), "1");
      assert.equal(desativar(M_SAL).ok, false);
    });
  });

  // =====================================================================
  describe("poller de ponta a ponta: repositório REAL → PostgREST falso → este banco", () => {
    let falso; let repoReal; let fakes; let clienteReal; let pollerMod; let pilotoDe;
    const montar = ({ respostas = [], holder = "w1", relogio } = {}) => {
      relogio ??= fakes.criarRelogio();
      const mem = fakes.criarRepoEmMemoria({ relogio, conexoes: [{ id: CON_A, organizacao_id: ORG, unidade_id: UN_A, merchant_id: M_SAND }] });
      // tudo em memória (eventos/pedidos/lease), EXCETO as lojas adicionais: essas vão ao banco real pelo repositório de produção
      for (const f of ["listarLojasExtrasParaPolling", "iniciarVerificacaoLoja", "marcarLojaAtiva", "bloquearLoja"]) mem[f] = (...a) => repoReal[f](...a);
      const client = fakes.criarClienteFake(clienteReal, { respostasPolling: respostas });
      const poller = pollerMod.criarPoller({ repo: mem, token: fakes.criarTokenFake({ escopo: "conexao" }), client, holder, agora: relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: pilotoDe(mem) });
      return { mem, client, poller, relogio, ciclo: async () => { const r = await poller.executarCiclo(); relogio.avancarS(30); return r; } };
    };

    before(async () => {
      const { iniciarSupabaseFalso } = await import("./helpers/supabase-falso-pg.js");
      falso = await iniciarSupabaseFalso({ pgUrl: b.url, usuarios: new Map() });
      Object.assign(process.env, { SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a") });
      repoReal = await import("../src/modules/ifood/ifoodEvents.repository.js");
      pollerMod = await import("../src/modules/ifood/ifoodEvents.poller.js");
      clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
      fakes = await import("./helpers/ifood-events-fakes.js");
      pilotoDe = fakes.pilotoDe;
      q("delete from ifood_conexao_lojas");
    });
    after(() => falso?.parar?.());

    test("pendente nunca é consultada; liberada é consultada UMA vez no mesmo polling e, aceita, vira `ativa` NO BANCO; ativa segue sem contar tentativa", async () => {
      ok(cadastrar(M_SAL, "Saladas"));
      const m = montar({ respostas: [[], [], [fakes.ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SAL, min: 1 })], []] });
      await m.ciclo();
      assert.deepEqual(m.client.polls[0].merchantIds, [M_SAND], "pendente: NUNCA consultada");
      ok(liberar(M_SAL, "Gerente"));
      await m.ciclo();
      assert.deepEqual(m.client.polls[1].merchantIds, [M_SAND, M_SAL]);
      assert.equal(estadoDe(M_SAL), "ativa|1|-");
      await m.ciclo();
      assert.deepEqual(m.client.polls[2].merchantIds, [M_SAND, M_SAL]);
      assert.equal(estadoDe(M_SAL), "ativa|1|-", "ativa não conta tentativa");
      assert.equal(m.mem.pedidos.get("o-sal").unidade_id, UN_A);
      assert.equal(m.mem.pedidos.get("o-sal").merchant_id, M_SAL);
    });

    test("desativar no banco: o poller para de consultar a loja no PRÓXIMO ciclo, sem deploy", async () => {
      const m = montar({ respostas: [[], []] });
      await m.ciclo();
      assert.deepEqual(m.client.polls[0].merchantIds, [M_SAND, M_SAL]);
      ok(desativar(M_SAL));
      await m.ciclo();
      assert.deepEqual(m.client.polls[1].merchantIds, [M_SAND]);
    });

    test("403 bloqueia de forma PERSISTENTE no banco: um poller NOVO (restart) nunca mais consulta; só a liberação supervisionada reabre", async () => {
      ok(cadastrar(M_SAL, "Saladas"));
      ok(liberar(M_SAL, "Gerente"));
      const m = montar({ respostas: [fakes.erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SAL] }), [fakes.ev("s1", "PLC", { orderId: "o-sand", merchantId: M_SAND, min: 1 })]] });
      const r = await m.ciclo();
      assert.equal(r.estado, "OK", "a Saladas recusada não derruba a Sanduíches");
      assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_SAND, M_SAL], [M_SAND]]);
      assert.equal(m.mem.pedidos.get("o-sand").status_oficial, "PLACED");
      assert.equal(estadoDe(M_SAL), "bloqueada|1|SEM_AUTORIZACAO");
      // "reinicia": outro processo, memória zerada, mesmo banco
      const novo = montar({ respostas: [[], [], []], holder: "w-novo" });
      for (let i = 0; i < 3; i += 1) await novo.ciclo();
      assert.deepEqual(novo.client.polls.map((p) => p.merchantIds), [[M_SAND], [M_SAND], [M_SAND]]);
      assert.equal(estadoDe(M_SAL), "bloqueada|1|SEM_AUTORIZACAO");
      // nova liberação supervisionada reabre; agora o iFood aceita
      ok(liberar(M_SAL, "Gerente (nova verificacao)"));
      const depois = montar({ respostas: [[]], holder: "w-depois" });
      await depois.ciclo();
      assert.deepEqual(depois.client.polls[0].merchantIds, [M_SAND, M_SAL]);
      assert.equal(estadoDe(M_SAL), "ativa|1|-");
    });

    test("falhas NÃO-403 esgotam as 3 tentativas no banco e bloqueiam (TENTATIVAS_ESGOTADAS) — não consulta para sempre", async () => {
      ok(desativar(M_SAL));
      ok(cadastrar(M_SAL, "Saladas"));
      ok(liberar(M_SAL, "Gerente"));
      const m = montar({ respostas: Array.from({ length: 8 }, () => new Error("rede caiu")) });
      for (let i = 0; i < 6; i += 1) await m.ciclo().catch(() => null);
      assert.equal(estadoDe(M_SAL), "bloqueada|3|TENTATIVAS_ESGOTADAS");
      assert.equal(m.client.polls.filter((p) => p.merchantIds.includes(M_SAL)).length, 3);
    });

    test("sem a tabela (migration ainda não aplicada), o poller segue só com a Sanduíches — ordem de implantação segura (código antes da migration)", async () => {
      const antes = q("select count(*) from ifood_conexao_lojas");
      assert.ok(Number(antes) >= 1);
      const banco2 = criarBancoDescartavel("lojas_extras_sem");
      try {
        sql(banco2.url, `create table ifood_conexoes (id uuid primary key)`);
        const falso2 = await (await import("./helpers/supabase-falso-pg.js")).iniciarSupabaseFalso({ pgUrl: banco2.url, usuarios: new Map() });
        const { createClient } = await import("@supabase/supabase-js");
        const cli = createClient(falso2.url, "chave-service-role-de-teste-".padEnd(48, "z"), { auth: { persistSession: false } });
        await assert.rejects(repoReal.listarLojasExtrasParaPolling({ conexaoIds: [CON_A], db: cli }), /ifood_conexao_lojas|does not exist|relation/i);
        await falso2.parar();
      } finally { banco2.derrubar(); }
      const m = montar({ respostas: [[]] });
      m.mem.listarLojasExtrasParaPolling = async () => { throw new Error('relation "ifood_conexao_lojas" does not exist'); };
      const r = await m.ciclo();
      assert.equal(r.estado, "OK");
      assert.deepEqual(m.client.polls[0].merchantIds, [M_SAND]);
    });
  });

  // =====================================================================
  describe("rollback", () => {
    test("recusa se houver loja `ativa`/`liberada` (nada é removido); com tudo desativado remove tabela e funções; idempotente", () => {
      assert.equal(psqlSync(b.url, "", { arquivo: R118 }).ok, true, "ordem inversa: a 118 sai antes da 117");
      q("delete from ifood_conexao_lojas");
      ok(cadastrar(M_SAL, "Saladas"));
      ok(liberar(M_SAL, "Gerente"));
      const r = psqlSync(b.url, "", { arquivo: R117 });
      assert.equal(r.ok, false);
      assert.match(r.err, /Rollback 117 abortado/);
      assert.equal(q("select to_regclass('public.ifood_conexao_lojas') is not null"), "t");
      ok(desativar(M_SAL));
      assert.equal(psqlSync(b.url, "", { arquivo: R117 }).ok, true);
      assert.equal(q("select to_regclass('public.ifood_conexao_lojas') is null"), "t");
      assert.equal(q("select count(*) from pg_proc where proname in ('ifood_loja_iniciar_verificacao', 'ifood_loja_marcar_ativa', 'ifood_loja_bloquear', 'ifood_conexao_lojas_validar')"), "0");
      assert.equal(psqlSync(b.url, "", { arquivo: R117 }).ok, true, "idempotente");
      assert.equal(q(`select count(*) from ifood_conexoes where id = '${CON_A}' and merchant_id = '${M_SAND}'`), "1", "a loja principal não é afetada");
      assert.equal(psqlSync(b.url, "", { arquivo: M117 }).ok, true, "e a migration reaplica depois do rollback");
    });

    test("pós-condição da migration: se anon/authenticated ainda alcançarem a tabela por OUTRA via (herança de role), a 117 ABORTA e desfaz TUDO", () => {
      const papel = `zz_heranca_${Date.now().toString(36)}`;
      psqlSync(b.url, "", { arquivo: R117 });                         // parte do zero (a 117 reaplicada acima é removida)
      assert.equal(q("select to_regclass('public.ifood_conexao_lojas') is null"), "t");
      try {
        q(`create role ${papel} nologin; grant ${papel} to anon; alter default privileges in schema public grant all on tables to ${papel}`);
        const r = psqlSync(b.url, "", { arquivo: M117 });
        assert.equal(r.ok, false);
        assert.match(r.err, /MIGRATION 117 abortada e DESFEITA/);
        assert.match(r.err, /tabela ← anon/);
        assert.equal(q("select to_regclass('public.ifood_conexao_lojas') is null"), "t", "nada ficou criado");
        assert.equal(q("select count(*) from pg_proc where proname like 'ifood_loja_%' or proname = 'ifood_conexao_lojas_validar'"), "0");
      } finally {
        psqlSync(b.url, `alter default privileges in schema public revoke all on tables from ${papel}; revoke ${papel} from anon; drop role if exists ${papel}`);
      }
      assert.equal(psqlSync(b.url, "", { arquivo: M117 }).ok, true, "sem a herança, aplica normalmente");
    });
  });
});
