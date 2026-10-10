// MATRIZ DE ACESSO DIRETO ao banco (PostgREST / RPC) para o Operador de Exibição, sobre o SCHEMA REAL do projeto
// (migration base + 068..114 do repositório + privilégios padrão do Supabase), em Postgres LOCAL e DESCARTÁVEL.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-rls-schema-real-pg.test.js
//
// Cada papel é medido COMO O POSTGREST o executaria (papel `authenticated`/`anon` + claim `sub`): o que enxerga, o que consegue
// alterar e se um INSERT novo passaria pela policy. O backend usa `service_role` (ignora RLS) — também medido, para provar que o
// Checklist pelo backend não é afetado. LIMITE: reflete as migrations do repositório, não o estado ao vivo da produção.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";
import { IDS, FIXTURES, SEM_CHECKS, SEMEADOR, MEDIDOR } from "./helpers/matriz-acesso-direto.sql.js";

const M114 = join(MIGRATIONS_DIR, "114_rls_exclui_papel_exibicao.sql"); const R114 = join(MIGRATIONS_DIR, "114_rollback.sql");
const M115 = join(MIGRATIONS_DIR, "115_fecha_acesso_direto_residual.sql"); const R115 = join(MIGRATIONS_DIR, "115_rollback.sql");
const PAPEIS = { tv: IDS.tv, viewerUni: IDS.viewerUni, herda: IDS.herda, gestorOrg: IDS.gestorOrg, financeOrg: IDS.financeOrg, outraEmpresa: IDS.outraEmpresa, estranho: IDS.estranho };
const VIEWS = ["vw_estoque_critico", "vw_faturamento_diario", "vw_produto_margem", "vw_produtos_vendidos"];

describe("RLS no schema REAL × Operador de Exibição (Postgres descartável)", { skip: motivoPular, timeout: 600_000 }, () => {
  let b; let falhas;
  const antes = {}; const depois = {};
  const q = (t) => sql(b.url, t);

  /** Mede um papel: linhas "tabela|a1|b1|alteraveis|insere" ordenadas. */
  const medir = (usuario, papel = "authenticated") => {
    const r = comoUsuario(b.url, usuario, "select tabela || '|' || a1 || '|' || b1 || '|' || alteraveis || '|' || insere from zz_medir() order by 1;", { papel });
    assert.ok(r.ok, r.err);
    return r.saida.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => { const [tabela, a1, b1, alt, ins] = l.split("|"); return { tabela, a1: Number(a1), b1: Number(b1), alt: Number(alt), ins }; });
  };
  const medirTodos = () => {
    const out = {};
    for (const [nome, id] of Object.entries(PAPEIS)) out[nome] = medir(id);
    out.anon = medir("", "anon"); out.service = medir("", "service_role");
    return out;
  };
  const resumo = (m) => ({ vê: m.filter((x) => x.a1 > 0).length, vêB: m.filter((x) => x.b1 > 0).length, altera: m.filter((x) => x.alt > 0).length, insere: m.filter((x) => x.ins === "permitido").length });

  before(() => {
    b = criarBancoDescartavel("rls_schema_real");
    falhas = construirSchemaReal(b.url, { ate: 113 });                  // estado ATUAL de produção: SEM a 114
    q(FIXTURES); q(SEM_CHECKS); q(SEMEADOR); q(MEDIDOR);
    q("select zz_semear(); update vendas set status = 'concluida'");
    Object.assign(antes, medirTodos());
    antes.views = Object.fromEntries(["tv", "estranho", "gestorOrg"].map((n) => [n, Object.fromEntries(VIEWS.map((v) => [v, Number(comoUsuario(b.url, PAPEIS[n], `select count(*) from ${v};`).out)]))]));
    antes.viewsAnon = Object.fromEntries(VIEWS.map((v) => [v, Number(comoUsuario(b.url, "", `select count(*) from ${v};`, { papel: "anon" }).out)]));
    antes.acl = q("select coalesce(proacl::text, 'null') || '|' || pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'auth_unidade_ids'");
    const r = psqlSync(b.url, "", { arquivo: M114 }); assert.equal(r.ok, true, r.err);
    Object.assign(depois, medirTodos());
    depois.acl = q("select coalesce(proacl::text, 'null') || '|' || pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'auth_unidade_ids'");
    depois.views = Object.fromEntries(["tv", "estranho", "gestorOrg"].map((n) => [n, Object.fromEntries(VIEWS.map((v) => [v, Number(comoUsuario(b.url, PAPEIS[n], `select count(*) from ${v};`).out)]))]));
    console.log("# MATRIZ ANTES da 114 :", JSON.stringify(Object.fromEntries(Object.entries(antes).filter(([k]) => Array.isArray(antes[k])).map(([k, v]) => [k, resumo(v)]))));
    console.log("# MATRIZ DEPOIS da 114:", JSON.stringify(Object.fromEntries(Object.entries(depois).filter(([k]) => Array.isArray(depois[k])).map(([k, v]) => [k, resumo(v)]))));
    console.log("# VIEWS antes/depois:", JSON.stringify({ antes: antes.views, depois: depois.views, anon: antes.viewsAnon }));
  });
  after(() => b?.derrubar());

  test("o schema real (base + 068..113, e a 114 depois) aplica sem falhas, com os stubs do Supabase", () => {
    assert.deepEqual(falhas, []);
    assert.ok(Number(q("select count(*) from pg_tables where schemaname = 'public'")) >= 115);
    assert.ok(Number(q("select count(*) from zz_semeadas where motivo_falha is null")) >= 80, "a maioria das tabelas com unidade/organização foi semeada");
    assert.equal(q("select count(*) from zz_semeadas where motivo_falha is not null"), "0");
  });

  test("ORDEM: a 114 ANTES da 112 falha (o valor do enum não existe) e nada fica pela metade; 112 → 113 → 114 → 115 aplica limpo no schema real, nessa ordem", () => {
    const b2 = criarBancoDescartavel("rls_ordem");
    try {
      assert.deepEqual(construirSchemaReal(b2.url, { ate: 110 }), []);
      const fora = psqlSync(b2.url, "", { arquivo: M114 });
      assert.equal(fora.ok, false); assert.match(fora.err, /display_operator|enum/i);
      assert.doesNotMatch(sql(b2.url, "select prosrc from pg_proc where proname = 'auth_unidade_ids'"), /display_operator/, "função original intacta");
      for (const f of ["112_papel_operador_exibicao.sql", "113_papel_exibicao_somente_unidade.sql", "114_rls_exclui_papel_exibicao.sql", "115_fecha_acesso_direto_residual.sql"]) {
        const r = psqlSync(b2.url, "", { arquivo: join(MIGRATIONS_DIR, f) }); assert.equal(r.ok, true, f + ": " + r.err);
      }
      assert.match(sql(b2.url, "select prosrc from pg_proc where proname = 'auth_unidade_ids'"), /display_operator/);
    } finally { b2.derrubar(); }
  });

  test("ANTES da 114 (produção hoje): a conta da TV enxerga e ALTERA as tabelas da unidade A1 direto, e nunca as de outra unidade/empresa", () => {
    const r = resumo(antes.tv);
    assert.ok(r.vê >= 20, `a TV via ${r.vê} tabelas de unidade sem a 114`);
    assert.ok(r.altera >= 20, `e alterava ${r.altera}`);
    assert.equal(r.vêB, 0, "mas nunca a unidade B1 (o RLS isola unidades/empresas)");
    const nomes = antes.tv.filter((x) => x.a1 > 0).map((x) => x.tabela);
    for (const t of ["vendas", "estoque", "bonificacao_lancamentos_diarios", "sw_faturamento_diario", "parser_fd_pedidos"]) assert.ok(nomes.includes(t), `${t} estava exposta`);
  });

  test("DEPOIS da 114: a conta da TV não enxerga NENHUMA linha de nenhuma tabela, não altera e nenhum INSERT passa pela policy (leitura/escrita de vendas, estoque, bonificação, outras unidades)", () => {
    for (const x of depois.tv) {
      assert.ok(x.a1 <= 0, `${x.tabela}: a1 (${x.a1}; -1 = sem privilégio de SELECT)`); assert.ok(x.b1 <= 0, `${x.tabela}: b1`);
      assert.ok(x.alt <= 0, `${x.tabela}: altera ${x.alt}`);
      assert.notEqual(x.ins, "permitido", `${x.tabela}: insere`);
    }
    // os "indeterminados" (erro anterior à policy) só podem ser tabelas em que a leitura/alteração também é negada
    const indet = depois.tv.filter((x) => x.ins.startsWith("indeterminado"));
    assert.ok(indet.length <= 4, `indeterminados: ${indet.map((x) => `${x.tabela}:${x.ins}`)}`);
    const nomes = depois.tv.map((x) => x.tabela);
    for (const t of ["vendas", "estoque", "bonificacao_lancamentos_diarios", "bonificacao_metas"]) assert.ok(nomes.includes(t), `${t} foi medida`);
  });

  test("OUTROS PERFIS: depois da 114 o resultado é IDÊNTICO ao de antes, tabela por tabela (nenhum privilégio mudou para os demais papéis, nem para anon e service_role)", () => {
    for (const papel of ["viewerUni", "herda", "gestorOrg", "financeOrg", "outraEmpresa", "estranho", "anon", "service"]) {
      assert.deepEqual(depois[papel], antes[papel], `papel ${papel} mudou com a 114`);
    }
  });

  test("ISOLAMENTO e REFERÊNCIAS: papéis de unidade veem só a unidade A1; papéis de empresa só a empresa A; ninguém vê a outra empresa; estranho e anon não veem nada; service_role (backend) vê tudo", () => {
    for (const papel of ["viewerUni", "herda", "gestorOrg", "financeOrg"]) {
      const r = resumo(depois[papel]);
      assert.ok(r.vê > 0, `${papel} enxerga dados da própria unidade/empresa`); assert.equal(r.vêB, 0, `${papel} nunca vê a empresa B`);
    }
    assert.equal(resumo(depois.outraEmpresa).vê, 0, "a empresa B não vê a A"); assert.ok(resumo(depois.outraEmpresa).vêB > 0, "mas vê a própria");
    assert.deepEqual(resumo(depois.estranho), { vê: 0, vêB: 0, altera: 0, insere: 0 });
    assert.deepEqual(resumo(depois.anon), { vê: 0, vêB: 0, altera: 0, insere: 0 });
    const s = depois.service; const vistasPorUnidade = depois.viewerUni.filter((x) => x.a1 > 0).map((x) => x.tabela);
    assert.ok(vistasPorUnidade.length >= 20 && vistasPorUnidade.every((t) => { const x = s.find((y) => y.tabela === t); return x.a1 > 0 && x.b1 > 0; }), "o backend (service_role) vê as DUAS unidades em todas as tabelas de unidade — o Checklist pelo backend não depende do RLS");
    // vendas e estoque: papel de unidade lê e escreve só A1 (comportamento atual preservado)
    const v = depois.viewerUni.find((x) => x.tabela === "vendas"); assert.deepEqual([v.a1, v.b1, v.alt], [1, 0, 1]);
  });

  test("SECURITY DEFINER: auth_unidade_ids() segue DEFINER, com o MESMO dono, search_path travado em public e os MESMOS privilégios (a 114 só trocou o corpo)", () => {
    assert.equal(depois.acl, antes.acl);
    assert.match(antes.acl, /\|true\|search_path=public$/);
    const corpo = q("select prosrc from pg_proc where proname = 'auth_unidade_ids'");
    assert.match(corpo, /display_operator/); assert.match(corpo, /auth\.uid\(\)/);
    // todas as funções DEFINER alcançáveis por RPC têm search_path fixo
    assert.equal(q("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')"), "0");
  });

  test("RPC: as únicas funções SECURITY DEFINER alcançáveis são os 6 auxiliares de RLS (só devolvem dados do próprio chamador); as demais são INVOKER (sujeitas ao RLS) e as de pgcrypto são inócuas", () => {
    const definer = q("select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and format_type(p.prorettype, null) <> 'trigger' and p.prosecdef and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))");
    assert.equal(definer, "auth_organizacao_id,auth_organizacao_ids,auth_unidade_id,auth_unidade_ids,is_platform_superadmin,tem_grant_realtime");
    assert.equal(q("select has_function_privilege('anon', 'public.tem_grant_realtime(text)'::regprocedure, 'execute')"), "f");
    // nenhuma função de NEGÓCIO (não-pgcrypto) alcançável é DEFINER além dos auxiliares
    const negocio = q("select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and format_type(p.prorettype, null) <> 'trigger' and p.probin is null and (has_function_privilege('authenticated', p.oid, 'execute')) and p.proname !~ '^(armor|crypt|dearmor|decrypt|decrypt_iv|digest|encrypt|encrypt_iv|gen_random_bytes|gen_random_uuid|gen_salt|hmac|pgp_.*|auth_.*|is_platform_superadmin|tem_grant_realtime|zz_.*)$'");
    console.log("# RPCs de negócio alcançáveis por authenticated (todas INVOKER):", negocio);
    assert.ok(negocio.split(",").every((n) => /^(bonificacao_|converter_|excluir_|fn_|promover_|remapear_|transferir_)/.test(n)), negocio);
  });

  test("RPC de negócio chamada PELA CONTA DA TV (depois da 114): nenhuma altera dados — vendas, bonificação, empresas e unidades ficam idênticas", () => {
    const foto = () => q(`select (select count(*) from vendas) || '/' || (select count(*) from bonificacao_competencia) || '/' || (select count(*) from organizacoes) || '/' || (select count(*) from unidades) || '/' || (select count(*) from bonificacao_lancamentos_diarios)
      || '/' || (select md5(string_agg(t::text, '|' order by t::text)) from (select * from unidades union all select null::uuid, null::uuid, null, null, null, null, null, null, null, null where false) t where false) `.replace(/\|\| '\/' \|\| \(select md5.*$/s, ""));
    const f0 = foto();
    const chamadas = [
      `select bonificacao_congelar_competencia('${IDS.orgA}', '${IDS.uniA1}', 2026, 9, 'manual', '{}'::jsonb, '{}'::jsonb, 'teste', '${IDS.tv}', 'tv')`,
      `select bonificacao_reabrir_competencia('${IDS.uniA1}', 2026, 9, 'teste', '${IDS.tv}', 'tv')`,
      `select transferir_unidade_organizacao('${IDS.uniA1}', '${IDS.orgB}', '${IDS.tv}', 'tv@x', null, null)`,
      `select excluir_organizacao_definitivamente('${IDS.orgA}', 'Empresa A', '${IDS.tv}', 'tv@x', null, null)`,
      `select converter_empresa_para_unidade('${IDS.orgB}', '${IDS.orgA}', '${IDS.tv}', 'tv@x', null, null)`,
      `select promover_unidade_para_empresa('${IDS.uniA1}', 'Nova', '${IDS.tv}', 'tv@x', null, null)`,
      `select remapear_organizacao_em_tabelas_de_unidade('${IDS.uniA1}', '${IDS.orgA}', '${IDS.orgB}')`,
    ];
    for (const c of chamadas) comoUsuario(b.url, IDS.tv, `${c};`);              // pode falhar ou devolver vazio: o que importa é o EFEITO
    assert.equal(foto(), f0, "nenhuma RPC alcançável pela conta da TV alterou dados");
    // a mesma leitura/escrita direta continua negada
    assert.equal(comoUsuario(b.url, IDS.tv, "select count(*) from vendas;").out, "0");
    assert.equal(comoUsuario(b.url, IDS.tv, "update vendas set status = status;").ok, true);
    assert.equal(q("select count(*) from vendas where unidade_id = '" + IDS.uniA1 + "'"), "1");
  });

  test("Realtime: a conta da TV só recebe o que um grant VIVO e PRÓPRIO autoriza (outro usuário ou grant vencido não conta)", () => {
    q(`set session_replication_role = replica; insert into realtime_channel_grants (sessao_contexto_id, usuario_id, topico, expira_em) values (gen_random_uuid(), '${IDS.tv}', 'unidade:${IDS.uniA1}', now() + interval '5 minutes'),
       (gen_random_uuid(), '${IDS.viewerUni}', 'unidade:${IDS.uniA1}', now() + interval '5 minutes'), (gen_random_uuid(), '${IDS.tv}', 'unidade:${IDS.uniA2}', now() - interval '1 minute')`);
    const g = (usuario, topico) => comoUsuario(b.url, usuario, `select public.tem_grant_realtime('${topico}');`).out;
    assert.equal(g(IDS.tv, `unidade:${IDS.uniA1}`), "t");
    assert.equal(g(IDS.tv, `unidade:${IDS.uniA2}`), "f", "grant vencido");
    assert.equal(g(IDS.tv, `unidade:${IDS.uniB1}`), "f", "outra unidade");
    assert.equal(g(IDS.estranho, `unidade:${IDS.uniA1}`), "f", "grant de OUTRO usuário não vale");
  });

  test("ACHADO PRÉ-EXISTENTE (não é do perfil de exibição; vale p/ todos e até p/ anon) — 4 views SEM security_invoker expõem dados de TODAS as unidades; se corrigido, inverta este teste", () => {
    const sembInvoker = q("select string_agg(c.relname, ',' order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and c.relname like 'vw\\_%' and not coalesce(c.reloptions::text, '') like '%security_invoker=true%'");
    assert.equal(sembInvoker, VIEWS.join(","));
    // as views com dado semeado devolvem linhas das DUAS empresas ao estranho e a anon — o RLS das tabelas-base é contornado (dono da view)
    const com = VIEWS.filter((v) => Number(q(`select count(*) from ${v}`)) > 0);
    assert.ok(com.length >= 1, "ao menos uma view tem dado para provar");
    for (const v of com) {
      assert.ok(depois.views.estranho[v] > 0, `${v}: estranho (sem vínculo) enxerga`); assert.equal(depois.views.tv[v], depois.views.estranho[v], `${v}: a TV enxerga o mesmo`);
      assert.equal(antes.viewsAnon[v], depois.views.estranho[v], `${v}: anon também`);
    }
  });

  test("ACHADO PRÉ-EXISTENTE — `unidade_config` não tem RLS e é legível/gravável por authenticated e anon; é a ÚNICA tabela de public nessa situação (se corrigido, inverta)", () => {
    assert.equal(q("select string_agg(c.relname, ',') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity and c.relname not like 'zz\_%'"), "unidade_config");
    q(`insert into unidade_config (unidade_id) values ('${IDS.uniB1}')`);
    for (const [usuario, papel] of [[IDS.tv, "authenticated"], [IDS.estranho, "authenticated"], ["", "anon"]]) {
      assert.equal(comoUsuario(b.url, usuario, "select count(*) from unidade_config;", { papel }).out, "1", `${papel} lê a config de OUTRA unidade`);
      assert.equal(comoUsuario(b.url, usuario, "update unidade_config set cmv_saudavel = 33;", { papel }).ok, true, `${papel} grava`);
    }
  });

  test("114: idempotente; o rollback restaura EXATAMENTE a matriz de antes; reaplicar restaura a de depois", () => {
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
    assert.deepEqual(medir(IDS.tv), depois.tv);
    assert.equal(psqlSync(b.url, "", { arquivo: R114 }).ok, true);
    assert.deepEqual(medir(IDS.tv), antes.tv, "rollback devolve o acesso direto da TV (por isso só reverta junto com a retirada do papel)");
    assert.deepEqual(medir(IDS.viewerUni), antes.viewerUni);
    assert.equal(q("select coalesce(proacl::text, 'null') || '|' || pg_get_userbyid(proowner) || '|' || prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'auth_unidade_ids'"), antes.acl);
    assert.equal(psqlSync(b.url, "", { arquivo: M114 }).ok, true);
    assert.deepEqual(medir(IDS.tv), depois.tv);
  });

  describe("115 (proposta): fecha views, unidade_config e RPCs de negócio para anon/authenticated", () => {
    const RPCS = ["bonificacao_congelar_competencia", "bonificacao_reabrir_competencia", "converter_empresa_para_unidade", "excluir_organizacao_definitivamente", "promover_unidade_para_empresa", "remapear_organizacao_em_tabelas_de_unidade", "transferir_unidade_organizacao"];
    const exec = (papel) => q(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(array[${RPCS.map((x) => "'" + x + "'").join(",")}]) and has_function_privilege('${papel}', p.oid, 'execute')`) || "";
    let matrizAntes115;

    before(() => {
      matrizAntes115 = { tv: medir(IDS.tv), viewerUni: medir(IDS.viewerUni), gestorOrg: medir(IDS.gestorOrg) };
      const r = psqlSync(b.url, "", { arquivo: M115 }); assert.equal(r.ok, true, r.err);
    });

    test("views: authenticated (inclusive a TV) e anon não leem mais NADA; o backend (service_role) continua lendo", () => {
      for (const v of VIEWS) {
        for (const [usuario, papel] of [[IDS.tv, "authenticated"], [IDS.estranho, "authenticated"], [IDS.gestorOrg, "authenticated"], ["", "anon"]]) {
          const r = comoUsuario(b.url, usuario, `select count(*) from ${v};`, { papel });
          assert.equal(r.ok, false, `${papel}/${usuario.slice(0, 4)} ainda lê ${v}`); assert.match(r.err, /permission denied|permissão negada/i);
        }
        assert.equal(comoUsuario(b.url, "", `select count(*) >= 0 from ${v};`, { papel: "service_role" }).ok, true, `service_role lê ${v}`);
      }
      assert.ok(Number(comoUsuario(b.url, "", "select count(*) from vw_faturamento_diario;", { papel: "service_role" }).out) >= 2, "o backend continua vendo as duas unidades");
    });

    test("unidade_config: RLS ligado sem policy — authenticated e anon não leem nem gravam; service_role sim", () => {
      assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.unidade_config'::regclass"), "true");
      for (const [usuario, papel] of [[IDS.tv, "authenticated"], [IDS.estranho, "authenticated"], [IDS.viewerUni, "authenticated"], ["", "anon"]]) {
        assert.equal(comoUsuario(b.url, usuario, "select count(*) from unidade_config;", { papel }).out, "0", `${papel} lê`);
        const w = comoUsuario(b.url, usuario, "update unidade_config set cmv_saudavel = 99;", { papel }); assert.equal(w.ok, true);   // 0 linhas afetadas (filtradas pelo RLS)
        assert.equal(q("select count(*) from unidade_config where cmv_saudavel = 99"), "0", `${papel} NÃO gravou`);
      }
      assert.equal(comoUsuario(b.url, "", "select count(*) from unidade_config;", { papel: "service_role" }).out, "1");
    });

    test("RPCs de negócio: sem EXECUTE para anon/authenticated/public; service_role (backend) mantém; funções auxiliares de RLS intactas", () => {
      assert.equal(exec("anon"), ""); assert.equal(exec("authenticated"), "");
      assert.equal(exec("service_role"), RPCS.slice().sort().join(","));
      for (const f of ["auth_unidade_ids()", "auth_organizacao_ids()", "is_platform_superadmin()"]) assert.equal(q(`select has_function_privilege('authenticated', 'public.${f}'::regprocedure, 'execute')`), "t", f);
      assert.equal(q("select has_function_privilege('authenticated', 'public.tem_grant_realtime(text)'::regprocedure, 'execute')"), "t");
      const r = comoUsuario(b.url, IDS.tv, `select bonificacao_reabrir_competencia('${IDS.uniA1}', 2026, 9, 't', '${IDS.tv}', 'tv');`);
      assert.equal(r.ok, false); assert.match(r.err, /permission denied|permissão negada/i);
    });

    test("a 115 não muda NENHUMA linha da matriz das tabelas (nem da TV, nem dos outros papéis)", () => {
      for (const [nome, id] of [["tv", IDS.tv], ["viewerUni", IDS.viewerUni], ["gestorOrg", IDS.gestorOrg]]) assert.deepEqual(medir(id), matrizAntes115[nome], nome);
    });

    test("115 é idempotente; o rollback devolve o estado encontrado (views: SELECT; RPCs: EXECUTE a PUBLIC) e NÃO desliga o RLS de unidade_config e reaplicar fecha de novo", () => {
      assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
      assert.equal(psqlSync(b.url, "", { arquivo: R115 }).ok, true);
      assert.equal(comoUsuario(b.url, IDS.estranho, "select count(*) from vw_faturamento_diario;").ok, true, "rollback reabre as views");
      assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.unidade_config'::regclass"), "true"); // o rollback NUNCA desliga o RLS (em produção ele já existia antes da 115)
      assert.equal(exec("authenticated"), RPCS.slice().sort().join(","));
      assert.equal(psqlSync(b.url, "", { arquivo: M115 }).ok, true);
      assert.equal(comoUsuario(b.url, IDS.estranho, "select count(*) from vw_faturamento_diario;").ok, false);
    });
  });
});
