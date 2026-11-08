// Aplicação, UMA POR VEZ, das migrations 153, 154 e 155 do Financeiro 2.0 em PRODUÇÃO (uqybgauuxcrqzquultfu), com as mesmas travas do prod-migrar-151/152
// (conexão estrita, identidade do cluster, backup informado, exportação conferida, sha256 do arquivo revisado, impressão digital do conteúdo antes × depois).
// Pré-requisito: 151 e 152 aplicadas e íntegras (o preflight confere). Ordem obrigatória: 153 → 154 → 155 (cada uma exige a anterior; a reversão é na ordem inversa).
//   node …/prod-migrar-fin2.mjs conferir                        -> SOMENTE LEITURA: estado de 152–155, funções compartilhadas e impressões; não exige nada além da conexão
//   node …/prod-migrar-fin2.mjs preflight <153|154|155>         -> somente leitura; imprime PROD_IDENTIDADE
//   PROD_IDENTIDADE=<…> node …/prod-migrar-fin2.mjs exportar <n> -> somente leitura: pg_dump dos dados financeiros; imprime PROD_EXPORTACAO
//   PROD_IDENTIDADE=<…> PROD_EXPORTACAO=<…> PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr|diario PROD_BACKUP_HORARIO=<UTC> PROD_AUTORIZO=SIM node …/prod-migrar-fin2.mjs aplicar <n>
//   PROD_IDENTIDADE=<…> node …/prod-migrar-fin2.mjs verificar <n>   -> somente leitura
//   PROD_IDENTIDADE=<…> PROD_AUTORIZO_REVERSAO=SIM node …/prod-migrar-fin2.mjs reverter <n>   -> <n>_rollback.sql (recusa se houver qualquer dado nas tabelas novas)
// Nenhum passo escreve DADOS: só DDL aditivo da migration e, na reversão, o DDL do rollback. A feature flag do Financeiro 2.0 NÃO é tocada (é variável do backend).
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REF_PROD = "uqybgauuxcrqzquultfu", REF_TESTE = "wiqqsxnysbzhcrzrrean";
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// md5(prosrc) de gestao_financeira_tabelas_da_unidade() em cada etapa (medido no banco descartável: 152 → 153 → 154 (inalterada) → 155). A guarda NÃO muda em nenhuma.
const LISTA = { a152: "634f0be24f43eede516ad9ab392eaee4", a153: "7dc3f5350da69a9546c020113d7441f8", a155: "a884649238479da400247f12b35f3f50" };
const GUARDA = "a485373a2317b9d12016f6aeda6a3f79";
const MIG = {
  153: { arq: ["database/migrations/153_financeiro_2_vendas_por_canal.sql", process.env.PROD_SHA153_ESPERADO || "9528c2a6233127af4ae05d5075ba52847a98db7f47bdf1bbed757e449603baad"],
         rb: ["database/migrations/153_rollback.sql", process.env.PROD_SHA153RB_ESPERADO || "2c5c4b2482d6f1daffcee2cfcd51f4e0bb7b3bd276eef4305dc5efcae102f16e"],
         novas: ["fin_vendas_canal", "fin_vendas_ajustes"], listaAntes: LISTA.a152, listaDepois: LISTA.a153, anterior: null, seguinte: 154 },
  154: { arq: ["database/migrations/154_financeiro_2_pagamento_origem.sql", process.env.PROD_SHA154_ESPERADO || "b549007e9041a36f284c8487fa3e228eb91db5115145a83487e851e1a74d376c"],
         rb: ["database/migrations/154_rollback.sql", process.env.PROD_SHA154RB_ESPERADO || "cd6a96752c79a45cd61f88474584da1c8a708d8141663978606342bb6be6ce1f"],
         novas: [], listaAntes: LISTA.a153, listaDepois: LISTA.a153, anterior: 153, seguinte: 155 },
  155: { arq: ["database/migrations/155_financeiro_2_transferencia_multipla.sql", process.env.PROD_SHA155_ESPERADO || "b60058cc387da6ddf92402a9c7616ea313020109e03b7066dadb4b1edb766666"],
         rb: ["database/migrations/155_rollback.sql", process.env.PROD_SHA155RB_ESPERADO || "3f8064a748c5f444f1ac9aafcadc16505b772c5ea71d7083af39adc1cf953c57"],
         novas: ["fin_transferencias_multiplas", "fin_transferencias_multiplas_entradas"], listaAntes: LISTA.a153, listaDepois: LISTA.a155, anterior: 154, seguinte: null },
};
const T152 = ["fin_rateios", "fin_rateio_parcelas", "fin_recebiveis", "fin_recebimentos", "fin_dividas", "fin_divida_eventos"];
const T153 = MIG[153].novas, T155 = MIG[155].novas, NOVAS_154 = ["origem_pagamento", "terceiro_nome", "divida_id"];
const NIVEIS = ["leitura", "operador", "gestor", "contador", "administrador"];
const E = process.env, ENSAIO = E.PROD_ENSAIO_LOCAL === "1", PORTA_ENSAIO = E.PROD_ENSAIO_PORTA || "54321";
const EVID = E.PROD_EVIDENCIAS || path.join(os.tmpdir(), "evidencias-prod");   // fora do Git; sem a conexão
const PSQL = E.PSQL || (existsSync("C:/Program Files/PostgreSQL/17/bin/psql.exe") ? "C:/Program Files/PostgreSQL/17/bin/psql.exe" : "psql");
const sair = (c, m) => { (c ? console.error : console.log)(m); process.exit(c); };
const CONN = E.PROD_CONN ?? "";
const ocultar = (s) => String(s ?? "").split(CONN || "\u0000").join("<conexão>");
const aspas = (a) => a.map((t) => `'${t}'`).join(",");

function travas() {
  const e = [];
  if (!CONN) e.push("defina PROD_CONN no seu terminal (não cole a conexão no chat)");
  if (CONN.includes(REF_TESTE)) e.push("PROD_CONN aponta para o projeto de TESTES");
  if (/[#\s]/.test(CONN)) e.push("PROD_CONN contém '#' ou espaço: não permitido (codifique a senha: # -> %23)");
  if (!ENSAIO) {
    const R = REF_PROD;
    const estrito = new RegExp(String.raw`^postgres(?:ql)?://(?:postgres@|postgres:[A-Za-z0-9%._~!$'()*+,;=-]+@)db\.${R}\.supabase\.co:5432/postgres(?:\?sslmode=(?:require|verify-ca|verify-full))?$`
      + String.raw`|^postgres(?:ql)?://postgres\.${R}(?::[A-Za-z0-9%._~!$'()*+,;=-]+)?@aws-[0-9]+-us-west-2\.pooler\.supabase\.com:5432/postgres(?:\?sslmode=(?:require|verify-ca|verify-full))?$`);
    if (!estrito.test(CONN)) e.push(`PROD_CONN fora do formato exigido: postgresql://postgres:<senha codificada>@db.${REF_PROD}.supabase.co:5432/postgres?sslmode=require (ou o pooler de sessão, porta 5432)`);
  }
  { let q; try { q = new URL(CONN).searchParams; } catch { q = null; }
    if (q) for (const [k, v] of q) {
      if (k !== "sslmode") e.push(`parâmetro de conexão não permitido na URL: "${k}" (só sslmode é aceito)`);
      else if (!["require", "verify-ca", "verify-full"].includes(v) && !ENSAIO) e.push(`sslmode="${v}" não permitido (use require, verify-ca ou verify-full)`);
    }
    if (/^[^@]*@[^/]*,/.test(CONN.replace(/^postgres(ql)?:\/\//, ""))) e.push("mais de um host na conexão não é permitido"); }
  if (ENSAIO) {
    if (!new RegExp(String.raw`^postgres(?:ql)?://[A-Za-z0-9_.-]+(?::[A-Za-z0-9%._~-]*)?@127\.0\.0\.1:${PORTA_ENSAIO}/[A-Za-z0-9_]+(?:\?sslmode=[a-z-]+)?$`).test(CONN)) e.push(`ensaio: só 127.0.0.1:${PORTA_ENSAIO}`);
    if (!E.PG_CLUSTER_DIR || !existsSync(path.join(E.PG_CLUSTER_DIR, "MARCADOR_DESCARTAVEL"))) e.push("ensaio: PG_CLUSTER_DIR sem MARCADOR_DESCARTAVEL");
  } else {
    let u; try { u = new URL(CONN); } catch { e.push("PROD_CONN não é uma URL postgres"); }
    if (u) {
      const host = u.hostname, user = decodeURIComponent(u.username);
      const direto = host === `db.${REF_PROD}.supabase.co`, pooler = /\.pooler\.supabase\.com$/.test(host) && user === `postgres.${REF_PROD}`;
      if (!direto && !pooler) e.push(`host/usuário não são do projeto de produção ${REF_PROD}`);
      if ((u.port || "5432") === "6543") e.push("porta 6543 (pooler em modo transação): use a conexão direta ou o pooler de sessão (5432)");
      if (direto && user !== "postgres") e.push("na conexão direta o usuário deve ser postgres");
    }
  }
  return e;
}
function psql(args, { input, leitura = false } = {}) {
  const env = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (E[k]) env[k] = E[k];
  if (!env.SystemRoot && !env.SYSTEMROOT) env.SystemRoot = "C:\\WINDOWS";
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-migracao-fin2", PGCONNECT_TIMEOUT: "15",
    PGOPTIONS: leitura ? "-c default_transaction_read_only=on -c statement_timeout=120000" : "-c statement_timeout=180000" });
  const r = spawnSync(PSQL, ["-X", "-v", "ON_ERROR_STOP=1", ...args, CONN], { input, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, saida: ocultar(r.stdout), erro: ocultar(r.stderr) };
}
const lerTxt = (sql) => { const r = psql(["-tA", "-c", sql], { leitura: true }); if (r.status !== 0) sair(2, `leitura falhou: ${r.erro.split("\n")[0]}`); return r.saida.trim(); };
const lerJson = (sql) => JSON.parse(lerTxt(sql));
const passo = process.argv[2], N = Number(process.argv[3]), cfg = MIG[N];
function evid(nome, txt) { mkdirSync(EVID, { recursive: true }); const f = path.join(EVID, `fin2-${N || "estado"}-${nome}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`); writeFileSync(f, txt); return f; }

const SQL_IDENT = `select to_json(md5((select system_identifier::text from pg_control_system()) || '|' || (select oid::text from pg_database where datname = current_database()) || '|' || current_database()))`;
// Impressão digital do conteúdo de toda tabela financeira. fin_pagamentos é impressa SEM as 3 colunas que a 154 acrescenta (o conteúdo antigo não pode mudar).
const SQL_ESTADO = `
with tabs as (
  select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%' or c.relname in ('organizacoes','unidades','organizacao_modulos','unidade_modulos'))
)
select json_build_object(
  'dependencias', json_build_object(
     'fin_lancamentos', to_regclass('public.fin_lancamentos') is not null, 'fin_periodos', to_regclass('public.fin_periodos') is not null,
     'gestao_financeira_concessoes', to_regclass('public.gestao_financeira_concessoes') is not null,
     'fin_periodo_travar_e_checar', to_regprocedure('public.fin_periodo_travar_e_checar(uuid,uuid,date)') is not null,
     'fin_validar_escopo', to_regprocedure('public.fin_validar_escopo()') is not null, 'fin_auditar', to_regprocedure('public.fin_auditar()') is not null,
     'fin_obrigacoes_151', to_regclass('public.fin_obrigacoes') is not null and to_regclass('public.fin_pagamentos') is not null and to_regclass('public.fin_conciliacao_saidas') is not null,
     'tabelas_152', (select count(*) = 6 from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${aspas(T152)}])),
     'fin_rateio_definir_152', to_regprocedure('public.fin_rateio_definir(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text,text)') is not null),
  'tabelas153', (select coalesce(json_agg(relname order by relname), '[]'::json) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${aspas(T153)}])),
  'tabelas155', (select coalesce(json_agg(relname order by relname), '[]'::json) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${aspas(T155)}])),
  'colunas154', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'fin_pagamentos' and column_name = any (array[${aspas(NOVAS_154)}])),
  'contaNullable154', (select is_nullable = 'YES' from information_schema.columns where table_schema = 'public' and table_name = 'fin_pagamentos' and column_name = 'conta_id'),
  'constraints154', (select count(*) from pg_constraint where conrelid = to_regclass('public.fin_pagamentos') and conname like 'fin\\_pag\\_origem\\_%'),
  'gatilhos154', (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_fin_pagamentos_origem', 'trg_fin_conciliacao_saidas_origem')),
  'funcoes155', (select count(*) from pg_proc where oid in (to_regprocedure('public.fin_vincular_transferencia_multipla(uuid,uuid,uuid,uuid,uuid[],text)'), to_regprocedure('public.fin_desvincular_transferencia_multipla(uuid,uuid,uuid,uuid,text)'))),
  'gatilhos155', (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in ('trg_fin_transferencias_multipla_excl', 'trg_fin_lancamentos_multipla_guarda', 'trg_fin_transf_mult_excl', 'trg_fin_transf_mult_ent_excl', 'trg_fin_transf_mult_imut', 'trg_fin_transf_mult_ent_imut')),
  'rls153', (select coalesce(bool_and(relrowsecurity), false) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${aspas(T153)}])),
  'rls155', (select coalesce(bool_and(relrowsecurity), false) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${aspas(T155)}])),
  'policiesNovas', (select count(*) from pg_policies where schemaname = 'public' and tablename = any (array[${aspas([...T153, ...T155])}])),
  'md5Lista', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.gestao_financeira_tabelas_da_unidade()')),
  'md5Guarda', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.gestao_financeira_verificar_unidade_transferivel(uuid)')),
  'remapearChamaGuarda', coalesce((select position('gestao_financeira_verificar_unidade_transferivel' in prosrc) > 0 from pg_proc where oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)')), false),
  'gatilhoUnidadesAtivo', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.unidades') and tgname = 'trg_unidades_guarda_financeiro' and tgenabled <> 'D'),
  'atributosFuncoes', (select bool_and(not prosecdef and coalesce(array_to_string(proconfig, ','), '') like '%search_path%') from pg_proc
                        where oid in (to_regprocedure('public.gestao_financeira_tabelas_da_unidade()'), to_regprocedure('public.gestao_financeira_verificar_unidade_transferivel(uuid)'))),
  'leTudo', (select rolsuper or rolbypassrls from pg_roles where rolname = current_user),
  'donoAdministra', coalesce((select pg_has_role(current_user, proowner, 'USAGE') from pg_proc where oid = to_regprocedure('public.gestao_financeira_verificar_unidade_transferivel(uuid)')), false),
  'checkNivel', (select pg_get_constraintdef(oid) from pg_constraint where conrelid = to_regclass('public.gestao_financeira_concessoes') and contype = 'c' and pg_get_constraintdef(oid) ilike '%nivel%'),
  'niveisEmUso', (select coalesce(json_agg(distinct nivel), '[]'::json) from public.gestao_financeira_concessoes),
  'transacoesLongas', (select count(*) from pg_stat_activity where datname = current_database() and xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid()),
  'locksEsperando', (select count(*) from pg_locks where not granted),
  'impressoes', (select json_object_agg(relname, (xpath('/row/h/text()', query_to_xml(format('select count(*) || '':'' || md5(coalesce(string_agg(%s, ''|'' order by %s), '''')) as h from public.%I t',
      case when relname = 'fin_pagamentos' then $q$(to_jsonb(t) - 'origem_pagamento' - 'terceiro_nome' - 'divida_id')::text$q$ else 't::text' end,
      case when relname = 'fin_pagamentos' then $q$(to_jsonb(t) - 'origem_pagamento' - 'terceiro_nome' - 'divida_id')::text$q$ else 't::text' end, relname), false, true, '')))[1]::text order by relname) from tabs)
)::text`;

const jaTem = (x, n) => (n === 153 ? x.tabelas153.length === 2 : n === 154 ? x.colunas154 > 0 : x.tabelas155.length === 2);
const resumo = (x) => `152: ${x.dependencias.tabelas_152 ? "sim" : "NÃO"} | 153: ${jaTem(x, 153) ? "sim" : "não"} | 154: ${jaTem(x, 154) ? "sim" : "não"} | 155: ${jaTem(x, 155) ? "sim" : "não"} | lista de tabelas: ${[["a152", "versão da 152"], ["a153", "versão da 153/154"], ["a155", "versão da 155"]].find(([k]) => LISTA[k] === x.md5Lista)?.[1] ?? "VERSÃO DESCONHECIDA"} | guarda: ${x.md5Guarda === GUARDA ? "inalterada" : "ALTERADA"} | níveis em uso: ${x.niveisEmUso.join(",") || "—"} | transações longas: ${x.transacoesLongas} | travas aguardando: ${x.locksEsperando}`;

function arquivosConferidos() {
  const head = execFileSync("git", ["-C", RAIZ, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`repositório em ${head}; conferindo sha256 da ${N} e do rollback`);
  for (const [rel, esperado] of [cfg.arq, cfg.rb]) {
    if (execFileSync("git", ["-C", RAIZ, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim()) sair(2, `RECUSADO: ${rel} alterado localmente`);
    const s = createHash("sha256").update(readFileSync(path.join(RAIZ, rel))).digest("hex");
    if (s !== esperado) sair(2, `RECUSADO: sha256 de ${rel} = ${s.slice(0, 16)}…, esperado ${esperado.slice(0, 16)}… (arquivo diferente do revisado)`);
  }
}
/** Condições para APLICAR a migration N. Devolve os motivos de recusa (vazia = pode). */
function avaliarAntes(x) {
  const m = [];
  for (const [k, v] of Object.entries(x.dependencias)) if (!v) m.push(`dependência ausente: ${k} (120/121/122/126/151/152 não estão aplicadas como esperado)`);
  if (jaTem(x, N)) m.push(`objetos da ${N} já existem (use 'verificar')`);
  if (cfg.anterior && !jaTem(x, cfg.anterior)) m.push(`a ${cfg.anterior} precisa estar aplicada antes da ${N}`);
  if (cfg.seguinte && jaTem(x, cfg.seguinte)) m.push(`a ${cfg.seguinte} já está aplicada: ordem inválida`);
  if (x.md5Lista !== cfg.listaAntes) m.push(`gestao_financeira_tabelas_da_unidade() em produção DIFERE da versão esperada antes da ${N}: a migration a sobrescreveria`);
  if (x.md5Guarda !== GUARDA) m.push("gestao_financeira_verificar_unidade_transferivel() em produção DIFERE da versão esperada");
  if (!x.remapearChamaGuarda) m.push("remapear_organizacao_em_tabelas_de_unidade não chama mais a guarda de transferência da 120");
  if (!x.gatilhoUnidadesAtivo) m.push("gatilho trg_unidades_guarda_financeiro ausente ou desabilitado em unidades");
  if (!x.atributosFuncoes) m.push("funções compartilhadas com atributos inesperados (SECURITY DEFINER ou sem search_path fixo)");
  if (!x.donoAdministra) m.push("o papel conectado não administra a função compartilhada (use postgres)");
  if (!x.leTudo) m.push("o papel conectado não tem BYPASSRLS: a exportação financeira obrigatória ficaria incompleta");
  if (!NIVEIS.every((n) => String(x.checkNivel ?? "").includes(`'${n}'`))) m.push(`CHECK de níveis sem os níveis esperados: ${x.checkNivel}`);
  const fora = x.niveisEmUso.filter((n) => !NIVEIS.includes(n)); if (fora.length) m.push(`níveis inesperados em uso: ${fora.join(",")}`);
  if (x.transacoesLongas > 0) m.push(`${x.transacoesLongas} transação(ões) com mais de 5 min: espere e repita o preflight`);
  if (x.locksEsperando > 0) m.push(`${x.locksEsperando} trava(s) aguardando: espere e repita o preflight`);
  return m;
}
/** Conteúdo antes × depois: toda tabela que já existia precisa manter a impressão digital; as novas nascem vazias. */
function compararConteudo(antes, depois) {
  const novas = cfg.novas;
  const mudou = Object.keys(antes.impressoes).filter((t) => !novas.includes(t) && antes.impressoes[t] !== depois.impressoes[t]);
  const novasNaoVazias = novas.filter((t) => depois.impressoes[t] !== undefined && !String(depois.impressoes[t]).startsWith("0:"));
  return { mudou, novasNaoVazias };
}
/** A migration N está completa e íntegra? (pós-condições externas às do próprio SQL) */
function completa(x, pagNaoConta) {
  if (N === 153) return x.tabelas153.length === 2 && x.rls153 && x.policiesNovas === 0 && x.md5Lista === LISTA.a153 && x.md5Guarda === GUARDA;
  if (N === 154) return x.colunas154 === 3 && x.contaNullable154 === true && x.constraints154 >= 3 && x.gatilhos154 === 2 && x.md5Lista === LISTA.a153 && x.md5Guarda === GUARDA && pagNaoConta === 0;
  return x.tabelas155.length === 2 && x.rls155 && x.policiesNovas === 0 && x.funcoes155 === 2 && x.gatilhos155 === 6 && x.md5Lista === LISTA.a155 && x.md5Guarda === GUARDA;
}
const naoConta = () => (lerJson(SQL_ESTADO).colunas154 === 3 ? Number(lerTxt("select count(*) from public.fin_pagamentos where origem_pagamento <> 'conta'")) : null);

const PG_DUMP = E.PG_DUMP || PSQL.replace(/psql(\.exe)?$/, (m, x) => `pg_dump${x ?? ""}`);
const PG_RESTORE = E.PG_RESTORE || PSQL.replace(/psql(\.exe)?$/, (m, x) => `pg_restore${x ?? ""}`);
const MANIFESTO = path.join(EVID, "fin2-exportacao-manifesto.json");
const SQL_TABELAS_FIN = `select coalesce(json_agg(relname order by relname), '[]'::json)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')`;
function conferirExportacao(ident, { exigirRecente = true } = {}) {
  if (!existsSync(MANIFESTO)) return ["não há exportação: rode o passo 'exportar' antes"];
  const man = JSON.parse(readFileSync(MANIFESTO, "utf8")); const e = [];
  if (!existsSync(man.arquivo)) return [`arquivo de exportação ausente: ${man.arquivo}`];
  const sha = createHash("sha256").update(readFileSync(man.arquivo)).digest("hex");
  if (sha !== man.sha256) e.push("o arquivo de exportação foi alterado depois de exportado (sha256 diferente)");
  if (E.PROD_EXPORTACAO !== man.sha256) e.push("PROD_EXPORTACAO ausente ou diferente do sha256 da exportação conferida");
  if (exigirRecente && Date.now() - Date.parse(man.em) > 24 * 3600e3) e.push("a exportação tem mais de 24 h: exporte de novo");
  if (man.identidade !== ident) e.push("a exportação é de outro banco (identidade diferente)");
  const l = spawnSync(PG_RESTORE, ["-l", man.arquivo], { encoding: "utf8" });
  if (l.status !== 0) e.push("pg_restore -l não leu a exportação");
  const presentes = new Set((l.stdout || "").split(/\r?\n/).map((x) => /TABLE DATA public (\S+)/.exec(x)?.[1]).filter(Boolean));
  const faltam = JSON.parse(lerTxt(SQL_TABELAS_FIN)).filter((t) => !presentes.has(t));
  if (faltam.length) e.push(`a exportação não contém: ${faltam.join(", ")}`);
  return e;
}
function conferirBackup() {
  const e = [];
  if (E.PROD_BACKUP_CONFIRMADO !== "SIM") e.push("falta PROD_BACKUP_CONFIRMADO=SIM (confira no painel do Supabase: Database → Backups)");
  if (!["pitr", "diario"].includes(E.PROD_BACKUP_TIPO ?? "")) e.push("defina PROD_BACKUP_TIPO=pitr ou diario (o que o painel mostra para o projeto)");
  const t = Date.parse(E.PROD_BACKUP_HORARIO ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(E.PROD_BACKUP_HORARIO ?? "") || Number.isNaN(t)) e.push("defina PROD_BACKUP_HORARIO=<AAAA-MM-DDTHH:MMZ, UTC> do último backup/ponto de recuperação válido");
  else if (t > Date.now() + 5 * 60e3) e.push("PROD_BACKUP_HORARIO está no futuro");
  else if (Date.now() - t > (E.PROD_BACKUP_TIPO === "pitr" ? 1 : 26) * 3600e3) e.push(`o último backup informado é antigo demais para aplicar agora (${E.PROD_BACKUP_TIPO === "pitr" ? "PITR: até 1 h" : "diário: até 26 h"})`);
  return e;
}

if (!["conferir", "preflight", "exportar", "aplicar", "verificar", "reverter"].includes(passo)) sair(2, "uso: node prod-migrar-fin2.mjs conferir | preflight|exportar|aplicar|verificar|reverter <153|154|155>");
if (passo !== "conferir" && !cfg) sair(2, "informe a migration: 153, 154 ou 155 (nesta ordem)");
const erros = travas(); if (erros.length) sair(2, erros.map((x) => `RECUSADO: ${x}`).join("\n"));
if (E.PROD_SO_TRAVAS === "1") sair(0, "TRAVAS: OK (nenhuma conexão foi aberta)");
console.log(`${ENSAIO ? "ENSAIO LOCAL — " : ""}alvo: ${ENSAIO ? `127.0.0.1:${PORTA_ENSAIO} (descartável)` : `produção ${REF_PROD}`} | passo: ${passo}${cfg ? ` ${N}` : ""}`);

if (passo === "conferir") {
  // SOMENTE LEITURA, sem alterar nada em nenhuma organização. Serve antes (estado de partida) e depois (nada mais mudou): compare as impressões.
  const ident = lerJson(SQL_IDENT); const x = lerJson(SQL_ESTADO); console.log(resumo(x));
  const f = evid("conferir", `identidade ${ident}\n${JSON.stringify(x, null, 1)}`);
  const antigas = Object.keys(x.impressoes).length;
  // PROD_COMPARAR_COM=<evidência de um 'conferir' anterior>: lista toda tabela cujo conteúdo mudou (esperado: nenhuma, salvo as novas das migrations aplicadas nesse intervalo)
  if (E.PROD_COMPARAR_COM) {
    if (!existsSync(E.PROD_COMPARAR_COM)) sair(2, `RECUSADO: evidência anterior não encontrada: ${E.PROD_COMPARAR_COM}`);
    const txt = readFileSync(E.PROD_COMPARAR_COM, "utf8"); const nl = txt.indexOf(String.fromCharCode(10)); const idAnt = txt.slice(0, nl).replace("identidade ", "").trim(); const ant = JSON.parse(txt.slice(nl + 1));
    if (idAnt !== ident) sair(2, "RECUSADO: a evidência anterior é de outro banco (identidade diferente)");
    const mudou = Object.keys(ant.impressoes).filter((t) => x.impressoes[t] !== ant.impressoes[t]);
    const novas = Object.keys(x.impressoes).filter((t) => ant.impressoes[t] === undefined);
    console.log(`comparação com a execução anterior: tabelas com CONTEÚDO alterado: ${mudou.length ? mudou.join(", ") : "nenhuma"} | tabelas novas: ${novas.length ? novas.join(", ") : "nenhuma"}`);
  }
  console.log(`identidade do cluster: ${ident}\ntabelas conferidas: ${antigas} (contagem:impressão digital de cada uma gravada na evidência)\nlinhas financeiras: ${Object.entries(x.impressoes).filter(([t]) => t.startsWith("fin_")).map(([t, h]) => `${t}=${String(h).split(":")[0]}`).join(" ")}\nevidência: ${f}`);
  process.exit(0);
}
if (passo === "preflight") {
  arquivosConferidos();
  const ident = lerJson(SQL_IDENT); const x = lerJson(SQL_ESTADO); console.log(resumo(x));
  const m = avaliarAntes(x);
  const f = evid("preflight", `identidade ${ident}\n${JSON.stringify(x, null, 1)}\nrecusas: ${JSON.stringify(m)}`);
  if (m.length) { console.log(`\nPREFLIGHT ${N}: NÃO APLICAR\n${m.map((s) => `  - ${s}`).join("\n")}\nevidência: ${f}`); process.exit(1); }
  console.log(`\nPREFLIGHT ${N}: OK — pode aplicar (com autorização própria)\nPROD_IDENTIDADE=${ident}\nevidência: ${f}`); process.exit(0);
}

const ident = lerJson(SQL_IDENT);
if (E.PROD_IDENTIDADE !== ident) sair(2, "RECUSADO: PROD_IDENTIDADE ausente ou diferente da identidade lida agora — rode o preflight e confira o alvo");

if (passo === "exportar") {
  mkdirSync(EVID, { recursive: true });
  const arquivo = path.join(EVID, `fin2-exportacao-financeiro-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  const env = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (E[k]) env[k] = E[k];
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-exportacao-fin2", PGOPTIONS: "-c default_transaction_read_only=on" });
  const r = spawnSync(PG_DUMP, ["--data-only", "--format=custom", "-t", "public.fin_*", "-t", "public.gestao_financeira_*", "-f", arquivo, "--dbname", CONN], { env, encoding: "utf8" });
  if (r.status !== 0) sair(1, `EXPORTAÇÃO FALHOU: ${ocultar(r.stderr).split("\n")[0]}`);
  const sha = createHash("sha256").update(readFileSync(arquivo)).digest("hex");
  writeFileSync(MANIFESTO, JSON.stringify({ arquivo, sha256: sha, em: new Date().toISOString(), identidade: ident }, null, 1));
  E.PROD_EXPORTACAO = sha;
  const e = conferirExportacao(ident);
  if (e.length) sair(1, `EXPORTAÇÃO NÃO CONFERE:\n${e.map((x) => `  - ${x}`).join("\n")}`);
  console.log(`EXPORTAÇÃO: OK — todas as tabelas financeiras presentes\narquivo: ${arquivo}\nPROD_EXPORTACAO=${sha}`);
  process.exit(0);
}

if (passo === "verificar") {
  const x = lerJson(SQL_ESTADO); console.log(resumo(x));
  const ok = completa(x, naoConta());
  const f = evid("verificar", JSON.stringify(x, null, 1));
  console.log(`${ok ? `VERIFICAÇÃO ${N}: OK — objetos, RLS sem policy, gatilhos, funções e lista de tabelas conforme o esperado; guarda inalterada` : `VERIFICAÇÃO ${N}: INCOMPLETA/DIVERGENTE — analise a evidência`}\nevidência: ${f}`);
  process.exit(ok ? 0 : 1);
}

if (passo === "reverter") {
  if (E.PROD_AUTORIZO_REVERSAO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO_REVERSAO=SIM");
  arquivosConferidos();
  const antes = lerJson(SQL_ESTADO);
  if (cfg.seguinte && jaTem(antes, cfg.seguinte)) sair(2, `RECUSADO: reverta a ${cfg.seguinte} antes da ${N} (ordem inversa)`);
  const r = psql(["-q", "-f", path.join(RAIZ, cfg.rb[0])]);
  const depois = r.status === 0 ? lerJson(SQL_ESTADO) : antes;
  const f = evid(r.status === 0 ? "reverter" : "reverter-RECUSADO", `antes ${JSON.stringify(antes)}\nexit ${r.status}\n${r.saida}\n${r.erro}\ndepois ${JSON.stringify(depois)}`);
  if (r.status !== 0) sair(1, `REVERSÃO RECUSADA/FALHOU — nada mudou (o rollback recusa se houver dados nas tabelas novas).\n${r.erro.split("\n").filter((l) => /ERRO|ERROR/.test(l)).slice(0, 3).join("\n")}\nevidência: ${f}`);
  const { mudou } = compararConteudo(antes, depois);
  const ok = !jaTem(depois, N) && depois.md5Lista === cfg.listaAntes && depois.md5Guarda === GUARDA && mudou.length === 0;
  console.log(`${ok ? `REVERSÃO ${N}: OK — estado anterior restaurado; conteúdo das tabelas existentes idêntico` : `REVERSÃO ${N}: DIVERGÊNCIA — ${mudou.join(", ") || "estado"}`}\nevidência: ${f}`);
  process.exit(ok ? 0 : 1);
}

// ---------------- aplicar ----------------
if (E.PROD_AUTORIZO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO=SIM");
{ const b = conferirBackup(); if (b.length) sair(2, b.map((x) => `RECUSADO: ${x}`).join("\n")); }
{ const x = conferirExportacao(ident); if (x.length) sair(2, x.map((y) => `RECUSADO: ${y}`).join("\n")); }
console.log(`backup informado: ${E.PROD_BACKUP_TIPO} em ${E.PROD_BACKUP_HORARIO} | exportação conferida: ${E.PROD_EXPORTACAO.slice(0, 16)}…`);
arquivosConferidos();
const antes = lerJson(SQL_ESTADO);
const recusas = avaliarAntes(antes);
if (recusas.length) sair(2, `RECUSADO (o estado mudou desde o preflight):\n${recusas.map((s) => `  - ${s}`).join("\n")}`);
const t0 = Date.now(); const r = psql(["-q", "-f", path.join(RAIZ, cfg.arq[0])]);
const depois = r.status === 0 ? lerJson(SQL_ESTADO) : antes;
const { mudou, novasNaoVazias } = compararConteudo(antes, depois);
const f = evid(r.status === 0 ? "aplicar" : "aplicar-FALHA", `identidade ${ident}\nantes ${JSON.stringify(antes)}\nexit ${r.status} (${Date.now() - t0} ms)\n${r.saida}\n${r.erro}\ndepois ${JSON.stringify(depois)}\nmudou ${JSON.stringify(mudou)} novasNaoVazias ${JSON.stringify(novasNaoVazias)}\n`);
if (r.status !== 0) sair(1, `FALHA — a transação da ${N} foi desfeita; nada mudou.\n${r.erro.split("\n").filter((l) => /ERRO|ERROR/.test(l)).slice(0, 4).join("\n")}\nevidência: ${f}`);
console.log(resumo(depois));
const ok = completa(depois, naoConta()) && mudou.length === 0 && novasNaoVazias.length === 0;
console.log(ok ? `RESULTADO ${N}: OK — aplicada; NENHUMA tabela existente mudou de conteúdo; tabelas novas vazias.` : `RESULTADO ${N}: DIVERGÊNCIA — conteúdo alterado: ${mudou.join(", ") || "—"}; novas não vazias: ${novasNaoVazias.join(", ") || "—"} (ver plano de reversão).`);
console.log(`evidência: ${f}`); process.exit(ok ? 0 : 1);
