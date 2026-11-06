// Aplicação da migration 151 (Financeiro 2.0: contas a pagar, acréscimos, conciliação de saídas) em PRODUÇÃO (uqybgauuxcrqzquultfu), com travas.
// Mesmo modelo do prod-migrar.mjs (120–122) e do prod-migrar-126.mjs: só um OPERADOR AUTORIZADO roda, no PRÓPRIO terminal; a conexão vem SÓ de
// PROD_CONN, nunca é lida de arquivo, impressa nem gravada. Procedimento: docs/financeiro-2-0/producao/02-plano-implantacao-reversao.md
//   node backend/testes-seguros/producao/prod-migrar-151.mjs preflight            -> somente leitura (transação read-only); imprime PROD_IDENTIDADE
//   PROD_IDENTIDADE=<…> node …/prod-migrar-151.mjs exportar                       -> somente leitura: pg_dump dos dados financeiros + conferência; imprime PROD_EXPORTACAO
//   PROD_IDENTIDADE=<…> PROD_EXPORTACAO=<…> PROD_BACKUP_CONFIRMADO=SIM PROD_BACKUP_TIPO=pitr|diario PROD_BACKUP_HORARIO=<UTC> PROD_AUTORIZO=SIM node …/prod-migrar-151.mjs aplicar
//   PROD_IDENTIDADE=<…> node …/prod-migrar-151.mjs verificar                      -> somente leitura
//   PROD_IDENTIDADE=<…> PROD_QA_ORG=<uuid> node …/prod-migrar-151.mjs isolamento   -> somente leitura: dados da 151 só na organização de QA
//   PROD_IDENTIDADE=<…> PROD_QA_ORG=<uuid> PROD_QA_NOME="<nome exato>" [PROD_FLAG_SEM_QA=SIM PROD_AUTORIZO_LIMPEZA=SIM] node …/prod-migrar-151.mjs limpar-qa
//        -> por padrão SÓ SIMULA (conta). Apaga apenas as linhas das 4 tabelas da 151 da organização de QA, numa transação que confere que nada fora dela mudou.
//   PROD_IDENTIDADE=<…> PROD_AUTORIZO_REVERSAO=SIM node …/prod-migrar-151.mjs reverter   -> 151_rollback.sql (recusa se houver qualquer dado)
// Ensaio: PROD_ENSAIO_LOCAL=1 aceita só 127.0.0.1:<PROD_ENSAIO_PORTA, padrão 54321> com MARCADOR_DESCARTAVEL (PG_CLUSTER_DIR).
// NÃO escreve dados: só DDL da 151 (aditiva) e, na reversão, o DDL do rollback. Impressões digitais = md5 calculado NO BANCO (nenhum dado sai).
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REF_PROD = "uqybgauuxcrqzquultfu", REF_TESTE = "wiqqsxnysbzhcrzrrean";
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// sha256 dos arquivos REVISADOS (atualizar só junto com nova revisão independente)
const M151 = ["database/migrations/151_financeiro_2_contas_pagar.sql", process.env.PROD_SHA151_ESPERADO || "b3b0cb48ba045b2d4c3d4281787c1b8521b0a029cab09ba8000c8b9281827ab8"];
const R151 = ["database/migrations/151_rollback.sql", process.env.PROD_SHA151RB_ESPERADO || "2253b3e626e109a9f12c30b1f072ed60500223439be6acc07cee4552e010636c"];
// md5(prosrc) das funções compartilhadas: versão da 120 (esperada ANTES) e versão da 151 (esperada DEPOIS). Medidos na cadeia origin/main + 120→122 + 126.
const MD5 = {
  antes: { lista: "8cca1ee27dce7ad6175a7919a8519750", guarda: "381bb213260aa0c699e99d184abc90fb" },
  depois: { lista: "84b3c0292990f2236874d2be1cad0141", guarda: "a485373a2317b9d12016f6aeda6a3f79" },
};
const CHECK_NIVEL_ANTES = "CHECK ((nivel = ANY (ARRAY['leitura'::text, 'operador'::text, 'gestor'::text])))";
const TABELAS_151 = ["fin_fornecedores", "fin_obrigacoes", "fin_pagamentos", "fin_conciliacao_saidas"];
const E = process.env, ENSAIO = E.PROD_ENSAIO_LOCAL === "1", PORTA_ENSAIO = E.PROD_ENSAIO_PORTA || "54321";
const EVID = E.PROD_EVIDENCIAS || path.join(os.tmpdir(), "evidencias-prod");   // fora do Git; sem a conexão
const PSQL = E.PSQL || (existsSync("C:/Program Files/PostgreSQL/17/bin/psql.exe") ? "C:/Program Files/PostgreSQL/17/bin/psql.exe" : "psql");
const sair = (c, m) => { (c ? console.error : console.log)(m); process.exit(c); };
const CONN = E.PROD_CONN ?? "";
const ocultar = (s) => String(s ?? "").split(CONN || "\u0000").join("<conexão>");

function travas() {
  const e = [];
  if (!CONN) e.push("defina PROD_CONN no seu terminal (não cole a conexão no chat)");
  if (CONN.includes(REF_TESTE)) e.push("PROD_CONN aponta para o projeto de TESTES");
  // (reverificação, M-2) a libpq não trata '#' como fragmento: '/#?host=…' desviaria o destino sem aparecer em URL.searchParams
  if (/[#\s]/.test(CONN)) e.push("PROD_CONN contém '#' ou espaço: não permitido (codifique a senha: # -> %23)");
  if (!ENSAIO) {
    // formato ESTRITO, ancorado: usuário, senha (só caracteres seguros ou %XX), host do projeto, porta 5432, banco postgres, só sslmode cifrado
    const R = REF_PROD;   // só [a-z]
    const estrito = new RegExp(String.raw`^postgres(?:ql)?://(?:postgres@|postgres:[A-Za-z0-9%._~!$'()*+,;=-]+@)db\.${R}\.supabase\.co:5432/postgres(?:\?sslmode=(?:require|verify-ca|verify-full))?$`
      + String.raw`|^postgres(?:ql)?://postgres\.${R}(?::[A-Za-z0-9%._~!$'()*+,;=-]+)?@aws-[0-9]+-us-west-2\.pooler\.supabase\.com:5432/postgres(?:\?sslmode=(?:require|verify-ca|verify-full))?$`);
    if (!estrito.test(CONN)) e.push(`PROD_CONN fora do formato exigido: postgresql://postgres:<senha codificada>@db.${REF_PROD}.supabase.co:5432/postgres?sslmode=require (ou o pooler de sessão, porta 5432)`);
  }
  // (revisão final, M-2) a libpq dá precedência a host/hostaddr/port/service da query string sobre o host da URL: só sslmode é aceito
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
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-migracao-151", PGCONNECT_TIMEOUT: "15",
    PGOPTIONS: leitura ? "-c default_transaction_read_only=on -c statement_timeout=120000" : "-c statement_timeout=180000" });
  const r = spawnSync(PSQL, ["-X", "-v", "ON_ERROR_STOP=1", ...args, CONN], { input, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, saida: ocultar(r.stdout), erro: ocultar(r.stderr) };
}
const lerJson = (sql) => { const r = psql(["-tA", "-c", sql], { leitura: true }); if (r.status !== 0) sair(2, `leitura falhou: ${r.erro.split("\n")[0]}`); return JSON.parse(r.saida.trim()); };
function evid(nome, txt) { mkdirSync(EVID, { recursive: true }); const f = path.join(EVID, `151-${nome}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`); writeFileSync(f, txt); return f; }

// (revisão final, M-1) oid do banco/schema é igual em todo projeto Supabase: a identidade usa o system_identifier do cluster (único por cluster).
// Se não puder ser lido, a leitura falha e o passo é RECUSADO (fail-closed).
const SQL_IDENT = `select to_json(md5((select system_identifier::text from pg_control_system()) || '|' || (select oid::text from pg_database where datname = current_database()) || '|' || current_database()))`;
// Estado: dependências, versão das funções compartilhadas, níveis, objetos da 151 e IMPRESSÃO DIGITAL do conteúdo de toda tabela financeira e de
// plataforma relevante (md5 calculado no banco sobre as linhas ordenadas; só o hash e a contagem saem). Nenhum dado pessoal é impresso.
const SQL_ESTADO = `
with tabs as (
  select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%' or c.relname in ('organizacoes','unidades','organizacao_modulos','unidade_modulos'))
)
select json_build_object(
  'tabelasFinAntigas', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'fin\\_%' and relname <> all (array[${TABELAS_151.map((t) => `'${t}'`).join(",")}])),
  'dependencias', json_build_object(
     'fin_lancamentos', to_regclass('public.fin_lancamentos') is not null, 'fin_periodos', to_regclass('public.fin_periodos') is not null,
     'gestao_financeira_concessoes', to_regclass('public.gestao_financeira_concessoes') is not null,
     'fin_periodo_travar_e_checar', to_regprocedure('public.fin_periodo_travar_e_checar(uuid,uuid,date)') is not null,
     'fin_guarda_periodo_data', to_regprocedure('public.fin_guarda_periodo_data()') is not null,
     'fin_validar_escopo', to_regprocedure('public.fin_validar_escopo()') is not null, 'fin_auditar', to_regprocedure('public.fin_auditar()') is not null,
     'fin_fechar_periodo', to_regprocedure('public.fin_fechar_periodo(uuid,uuid,uuid,date,integer,text,jsonb,text[],boolean)') is not null,
     'regra_126', coalesce((select position('plataforma_admins' in prosrc) > 0 from pg_proc where oid = to_regprocedure('public.gfc_validar()')), false)),
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
  'tabelas151', (select coalesce(json_agg(relname order by relname), '[]'::json) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${TABELAS_151.map((t) => `'${t}'`).join(",")}])),
  'gatilhos151', (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and (tgname like 'trg\\_fin2\\_%' or tgrelid = any (select to_regclass('public.' || t) from unnest(array[${TABELAS_151.map((t) => `'${t}'`).join(",")}]) t))),
  'rls151', (select coalesce(bool_and(relrowsecurity), false) from pg_class where relnamespace = 'public'::regnamespace and relname = any (array[${TABELAS_151.map((t) => `'${t}'`).join(",")}])),
  'transacoesLongas', (select count(*) from pg_stat_activity where datname = current_database() and xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid()),
  'locksEsperando', (select count(*) from pg_locks where not granted),
  'impressoes', (select json_object_agg(relname, (xpath('/row/h/text()', query_to_xml(format('select count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as h from public.%I t', relname), false, true, '')))[1]::text order by relname) from tabs)
)::text`;
function arquivosConferidos() {
  const head = execFileSync("git", ["-C", RAIZ, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`repositório em ${head}; conferindo sha256 da 151 e do rollback`);
  for (const [rel, esperado] of [M151, R151]) {
    if (execFileSync("git", ["-C", RAIZ, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim()) sair(2, `RECUSADO: ${rel} alterado localmente`);
    const s = createHash("sha256").update(readFileSync(path.join(RAIZ, rel))).digest("hex");
    if (s !== esperado) sair(2, `RECUSADO: sha256 de ${rel} = ${s.slice(0, 16)}…, esperado ${esperado.slice(0, 16)}… (arquivo diferente do revisado)`);
  }
}
/** Condições para APLICAR. Devolve a lista de motivos de recusa (vazia = pode). */
function avaliarAntes(x) {
  const m = [];
  for (const [k, v] of Object.entries(x.dependencias)) if (!v) m.push(k === "regra_126" ? "a migration 126 não está em vigor (gfc_validar sem a regra do SuperAdmin ativo)" : `dependência ausente: ${k} (120/121/122 não estão aplicadas como esperado)`);
  if (x.tabelasFinAntigas < 12) m.push(`esperadas ≥ 12 tabelas fin_* da 120–122, encontradas ${x.tabelasFinAntigas}`);
  if (x.tabelas151.length) m.push(`objetos da 151 já existem: ${x.tabelas151.join(", ")} (use 'verificar')`);
  if (x.md5Lista !== MD5.antes.lista) m.push("gestao_financeira_tabelas_da_unidade() em produção DIFERE da versão da 120 (alguém a alterou): a 151 a sobrescreveria");
  if (x.md5Guarda !== MD5.antes.guarda) m.push("gestao_financeira_verificar_unidade_transferivel() em produção DIFERE da versão da 120: a 151 a sobrescreveria");
  // (3ª revisão, B-3) a guarda de transferência de lojas precisa estar LIGADA ao fluxo real, não só existir
  if (!x.remapearChamaGuarda) m.push("remapear_organizacao_em_tabelas_de_unidade não chama mais a guarda de transferência da 120");
  if (!x.gatilhoUnidadesAtivo) m.push("gatilho trg_unidades_guarda_financeiro ausente ou desabilitado em unidades");
  if (!x.atributosFuncoes) m.push("funções compartilhadas com atributos inesperados (SECURITY DEFINER ou sem search_path fixo)");
  if (!x.donoAdministra) m.push("o papel conectado não administra a função compartilhada (use postgres)");
  // a exportação obrigatória precisa ler TODAS as linhas (há tabelas com RLS forçada); sem isso o pg_dump recusa ou sairia incompleta
  if (!x.leTudo) m.push("o papel conectado não tem BYPASSRLS: a exportação financeira obrigatória ficaria incompleta (não usar --enable-row-security)");
  if (x.checkNivel !== CHECK_NIVEL_ANTES) m.push(`CHECK de níveis inesperado: ${x.checkNivel}`);
  const fora = x.niveisEmUso.filter((n) => !["leitura", "operador", "gestor"].includes(n)); if (fora.length) m.push(`níveis inesperados em uso: ${fora.join(",")}`);
  if (x.transacoesLongas > 0) m.push(`${x.transacoesLongas} transação(ões) com mais de 5 min: espere e repita o preflight`);
  if (x.locksEsperando > 0) m.push(`${x.locksEsperando} trava(s) aguardando: espere e repita o preflight`);
  return m;
}
const resumo = (x) => `tabelas fin_* antigas: ${x.tabelasFinAntigas} | objetos 151: ${x.tabelas151.length ? x.tabelas151.join(",") : "nenhum"} | funções compartilhadas: ${x.md5Lista === MD5.antes.lista && x.md5Guarda === MD5.antes.guarda ? "versão da 120" : x.md5Lista === MD5.depois.lista && x.md5Guarda === MD5.depois.guarda ? "versão da 151" : "VERSÃO DESCONHECIDA"} | níveis em uso: ${x.niveisEmUso.join(",") || "—"} | transações longas: ${x.transacoesLongas} | travas aguardando: ${x.locksEsperando}`;
/** Comparação de conteúdo antes × depois: toda tabela que existia ANTES precisa ter a mesma impressão digital (as da 151 nascem vazias). */
function compararConteudo(antes, depois) {
  const existentes = Object.keys(antes.impressoes).filter((t) => !TABELAS_151.includes(t));
  const mudou = existentes.filter((t) => antes.impressoes[t] !== depois.impressoes[t]);
  const novas151 = TABELAS_151.filter((t) => depois.impressoes[t] !== undefined && !String(depois.impressoes[t]).startsWith("0:"));
  return { mudou, novas151 };
}

const PG_DUMP = E.PG_DUMP || PSQL.replace(/psql(\.exe)?$/, (m, x) => `pg_dump${x ?? ""}`);
const PG_RESTORE = E.PG_RESTORE || PSQL.replace(/psql(\.exe)?$/, (m, x) => `pg_restore${x ?? ""}`);
const MANIFESTO = path.join(EVID, "151-exportacao-manifesto.json");
const SQL_TABELAS_FIN = `select coalesce(json_agg(relname order by relname), '[]'::json)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')`;
/** Confere o arquivo de exportação: existe, sha256 bate com o manifesto e lista TODAS as tabelas financeiras atuais (com dados de tabela). */
function conferirExportacao({ exigirRecente = true } = {}) {
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
  const faltam = JSON.parse(lerJsonTxt(SQL_TABELAS_FIN)).filter((t) => !presentes.has(t));
  if (faltam.length) e.push(`a exportação não contém: ${faltam.join(", ")}`);
  return e;
}
function lerJsonTxt(sql) { const r = psql(["-tA", "-c", sql], { leitura: true }); if (r.status !== 0) sair(2, `leitura falhou: ${r.erro.split("\n")[0]}`); return r.saida.trim(); }
/** Backup informado pelo operador depois de conferir no painel: tipo e horário (UTC) do último backup/ponto de recuperação válido. */
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

const passo = process.argv[2];
if (!["preflight", "exportar", "aplicar", "verificar", "isolamento", "limpar-qa", "reverter"].includes(passo)) sair(2, "uso: node prod-migrar-151.mjs preflight | exportar | aplicar | verificar | isolamento | limpar-qa | reverter");
const erros = travas(); if (erros.length) sair(2, erros.map((x) => `RECUSADO: ${x}`).join("\n"));
if (E.PROD_SO_TRAVAS === "1") sair(0, "TRAVAS: OK (nenhuma conexão foi aberta)");   // só para o ensaio do formato da conexão
console.log(`${ENSAIO ? "ENSAIO LOCAL — " : ""}alvo: ${ENSAIO ? `127.0.0.1:${PORTA_ENSAIO} (descartável)` : `produção ${REF_PROD}`} | passo: ${passo}`);

if (passo === "preflight") {
  arquivosConferidos();
  const ident = lerJson(SQL_IDENT); const x = lerJson(SQL_ESTADO); console.log(resumo(x));
  const m = avaliarAntes(x);
  const f = evid("preflight", `identidade ${ident}\n${JSON.stringify(x, null, 1)}\nrecusas: ${JSON.stringify(m)}`);
  if (m.length) { console.log(`\nPREFLIGHT: NÃO APLICAR\n${m.map((s) => `  - ${s}`).join("\n")}\nevidência: ${f}`); process.exit(1); }
  console.log(`\nPREFLIGHT: OK — pode aplicar (com autorização própria)\nPROD_IDENTIDADE=${ident}\nevidência: ${f}`); process.exit(0);
}

const ident = lerJson(SQL_IDENT);
if (E.PROD_IDENTIDADE !== ident) sair(2, "RECUSADO: PROD_IDENTIDADE ausente ou diferente da identidade lida agora — rode o preflight e confira o alvo");

if (passo === "exportar") {
  // Somente leitura. Exporta os DADOS de todas as tabelas fin_* e gestao_financeira_* (contém dados financeiros reais: o arquivo fica FORA do Git,
  // na pasta de evidências, e deve ser guardado com acesso restrito). Depois confere: pg_restore -l lista todas as tabelas; grava o sha256.
  mkdirSync(EVID, { recursive: true });
  const arquivo = path.join(EVID, `151-exportacao-financeiro-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  const env = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (E[k]) env[k] = E[k];
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-exportacao-151", PGOPTIONS: "-c default_transaction_read_only=on" });
  const r = spawnSync(PG_DUMP, ["--data-only", "--format=custom", "-t", "public.fin_*", "-t", "public.gestao_financeira_*", "-f", arquivo, "--dbname", CONN], { env, encoding: "utf8" });
  if (r.status !== 0) sair(1, `EXPORTAÇÃO FALHOU: ${ocultar(r.stderr).split("\n")[0]}`);
  const sha = createHash("sha256").update(readFileSync(arquivo)).digest("hex");
  writeFileSync(MANIFESTO, JSON.stringify({ arquivo, sha256: sha, em: new Date().toISOString(), identidade: ident }, null, 1));
  E.PROD_EXPORTACAO = sha;
  const e = conferirExportacao();
  if (e.length) sair(1, `EXPORTAÇÃO NÃO CONFERE:\n${e.map((x) => `  - ${x}`).join("\n")}`);
  console.log(`EXPORTAÇÃO: OK — todas as tabelas financeiras presentes\narquivo: ${arquivo}\nPROD_EXPORTACAO=${sha}`);
  process.exit(0);
}

if (passo === "verificar") {
  const x = lerJson(SQL_ESTADO); console.log(resumo(x));
  const ok = x.tabelas151.length === 4 && x.rls151 && x.gatilhos151 >= 14 && x.md5Lista === MD5.depois.lista && x.md5Guarda === MD5.depois.guarda && x.checkNivel?.includes("'contador'");
  const f = evid("verificar", JSON.stringify(x, null, 1));
  console.log(`${ok ? "VERIFICAÇÃO: OK — 151 completa (4 tabelas, RLS, gatilhos, funções compartilhadas da 151, níveis novos)" : "VERIFICAÇÃO: INCOMPLETA/DIVERGENTE — analise a evidência"}\nevidência: ${f}`);
  process.exit(ok ? 0 : 1);
}

if (passo === "isolamento") {
  const qa = String(E.PROD_QA_ORG ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(qa)) sair(2, "RECUSADO: defina PROD_QA_ORG=<uuid da organização de QA>");
  const x = lerJson(`select json_build_object(${TABELAS_151.map((t) => `'${t}', (select json_build_object('qa', count(*) filter (where organizacao_id = '${qa}'), 'fora', count(*) filter (where organizacao_id <> '${qa}')) from public.${t})`).join(", ")},
    'auditoriaFora', (select count(*) from public.fin_auditoria where entidade = any (array[${TABELAS_151.map((t) => `'${t}'`).join(",")}]) and coalesce(organizacao_id::text, '') <> '${qa}'))::text`);
  const fora = TABELAS_151.reduce((a, t) => a + Number(x[t].fora), 0) + Number(x.auditoriaFora);
  console.log(TABELAS_151.map((t) => `${t}: QA=${x[t].qa} | fora do QA=${x[t].fora}`).join("\n") + `\nauditoria das tabelas novas fora do QA: ${x.auditoriaFora}`);
  const f = evid("isolamento", JSON.stringify(x));
  console.log(`${fora === 0 ? "ISOLAMENTO: OK — dados do Financeiro 2.0 só na organização de QA" : `ISOLAMENTO: FALHA — ${fora} registro(s) fora da organização de QA`}\nevidência: ${f}`);
  process.exit(fora === 0 ? 0 : 1);
}

if (passo === "limpar-qa") {
  // LIMPEZA DA ORGANIZAÇÃO DE QA (dados SINTÉTICOS da homologação). Escopo ESTRITO: só fin_conciliacao_saidas, fin_pagamentos, fin_obrigacoes e
  // fin_fornecedores, só onde organizacao_id = PROD_QA_ORG. Não toca: fin_lancamentos/contas/plano/periodos da QA (financeiro anterior),
  // fin_auditoria (imutável por desenho: o histórico da QA permanece), concessões, plataforma, nem qualquer outra empresa.
  const qa = String(E.PROD_QA_ORG ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(qa)) sair(2, "RECUSADO: defina PROD_QA_ORG=<uuid da organização de QA>");
  const nomeInf = String(E.PROD_QA_NOME ?? "");
  const org = lerJson(`select coalesce((select json_build_object('nome', nome) from public.organizacoes where id = '${qa}'), 'null'::json)::text`);
  if (!org) sair(2, "RECUSADO: organização de QA não encontrada");
  if (org.nome !== nomeInf) sair(2, "RECUSADO: PROD_QA_NOME não confere exatamente com o nome da organização (confira no Painel)");
  if (!/\bQA\b/.test(org.nome) || !/sint[eé]tic/i.test(org.nome)) sair(2, `RECUSADO: o nome da organização não a identifica como QA sintética ("${org.nome}"): limpeza recusada`);
  const contar = () => lerJson(`select json_build_object(${TABELAS_151.map((t) => `'${t}', (select json_build_object('qa', count(*) filter (where organizacao_id = '${qa}'), 'fora', count(*) filter (where organizacao_id <> '${qa}'), 'foraMd5', md5(coalesce(string_agg(x::text, '|' order by x::text) filter (where organizacao_id <> '${qa}'), ''))) from public.${t} x)`).join(", ")})::text`);
  const antes = contar();
  console.log(TABELAS_151.map((t) => `${t}: QA=${antes[t].qa} (a apagar) | outras empresas=${antes[t].fora} (intocadas)`).join("\n"));
  if (E.PROD_AUTORIZO_LIMPEZA !== "SIM") { const f = evid("limpar-qa-simulacao", JSON.stringify({ org: qa, antes })); console.log(`SIMULAÇÃO — nada foi apagado. Para executar: PROD_FLAG_SEM_QA=SIM PROD_AUTORIZO_LIMPEZA=SIM\nevidência: ${f}`); process.exit(0); }
  if (E.PROD_FLAG_SEM_QA !== "SIM") sair(2, "RECUSADO: confirme PROD_FLAG_SEM_QA=SIM — a organização de QA já foi RETIRADA de FINANCEIRO_2_ORGANIZACOES (senão a aplicação continua gravando)");
  const outrasAntes = lerJson(SQL_ESTADO).impressoes;
  // Uma transação: trava as 4 tabelas, apaga só a QA na ordem das FKs, confere em SQL que as linhas de outras empresas são idênticas (md5) — senão aborta.
  // O gatilho de período de fin_pagamentos é desligado SÓ nesta transação (DDL transacional; o dono pode), porque meses da QA podem estar fechados.
  const imp = (t) => `md5(coalesce((select string_agg(x::text, '|' order by x::text) from public.${t} x where organizacao_id <> '${qa}'), ''))`;
  const sql = `begin;
set local lock_timeout = '5s';
lock table public.fin_conciliacao_saidas, public.fin_pagamentos, public.fin_obrigacoes, public.fin_fornecedores in share row exclusive mode;
create temp table _fin2_outras on commit drop as select ${TABELAS_151.map((t) => `${imp(t)} as ${t}`).join(", ")};
alter table public.fin_pagamentos disable trigger trg_fin_pagamentos_periodo;
delete from public.fin_conciliacao_saidas where organizacao_id = '${qa}';
delete from public.fin_pagamentos where organizacao_id = '${qa}';
delete from public.fin_obrigacoes where organizacao_id = '${qa}';
delete from public.fin_fornecedores where organizacao_id = '${qa}';
alter table public.fin_pagamentos enable trigger trg_fin_pagamentos_periodo;
do $$ begin
  if exists (select 1 from _fin2_outras o where ${TABELAS_151.map((t) => `o.${t} is distinct from ${imp(t)}`).join(" or ")}) then
    raise exception 'LIMPEZA ABORTADA: linhas de outras empresas mudaram';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_fin_pagamentos_periodo' and tgenabled = 'O') then raise exception 'LIMPEZA ABORTADA: gatilho de periodo nao religado'; end if;
end $$;
commit;`;
  const r = psql(["-q", "-f", "-"], { input: sql });
  const depois = contar();
  const outrasDepois = lerJson(SQL_ESTADO).impressoes;
  const mudaram = Object.keys(outrasAntes).filter((t) => !TABELAS_151.includes(t) && t !== "fin_auditoria" && outrasAntes[t] !== outrasDepois[t]);
  const ok = r.status === 0 && TABELAS_151.every((t) => Number(depois[t].qa) === 0 && depois[t].foraMd5 === antes[t].foraMd5) && mudaram.length === 0;
  const f = evid(ok ? "limpar-qa" : "limpar-qa-FALHA", JSON.stringify({ org: qa, antes, depois, mudaram, exit: r.status, erro: r.erro }));
  if (r.status !== 0) sair(1, `LIMPEZA FALHOU — transação desfeita, nada foi apagado.\n${r.erro.split("\n").filter((l) => /ERRO|ERROR/.test(l)).slice(0, 3).join("\n")}\nevidência: ${f}`);
  console.log(`${ok ? "LIMPEZA: OK — só os dados da 151 da organização de QA foram apagados; demais empresas e tabelas idênticas (a auditoria da QA permanece, por desenho)" : `LIMPEZA: DIVERGÊNCIA — ${mudaram.join(", ")}`}\nevidência: ${f}`);
  process.exit(ok ? 0 : 1);
}

if (passo === "reverter") {
  if (E.PROD_AUTORIZO_REVERSAO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO_REVERSAO=SIM");
  arquivosConferidos();
  const antes = lerJson(SQL_ESTADO);
  const r = psql(["-q", "-f", path.join(RAIZ, R151[0])]);
  const depois = r.status === 0 ? lerJson(SQL_ESTADO) : antes;
  const f = evid(r.status === 0 ? "reverter" : "reverter-RECUSADO", `antes ${JSON.stringify(antes)}\nexit ${r.status}\n${r.saida}\n${r.erro}\ndepois ${JSON.stringify(depois)}`);
  if (r.status !== 0) sair(1, `REVERSÃO RECUSADA/FALHOU — nada mudou (o rollback recusa se houver dados da 151).\n${r.erro.split("\n").filter((l) => /ERRO|ERROR/.test(l)).slice(0, 3).join("\n")}\nevidência: ${f}`);
  const { mudou } = compararConteudo(antes, depois);   // tabelas que já existiam antes da 151 precisam continuar idênticas
  const ok = depois.tabelas151.length === 0 && depois.md5Lista === MD5.antes.lista && depois.md5Guarda === MD5.antes.guarda && depois.checkNivel === CHECK_NIVEL_ANTES && mudou.length === 0;
  console.log(`${ok ? "REVERSÃO: OK — estado da 120–126 restaurado; conteúdo das tabelas existentes idêntico" : `REVERSÃO: DIVERGÊNCIA — ${mudou.join(", ")}`}\nevidência: ${f}`);
  process.exit(ok ? 0 : 1);
}

// ---------------- aplicar ----------------
if (E.PROD_AUTORIZO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO=SIM");
{ const b = conferirBackup(); if (b.length) sair(2, b.map((x) => `RECUSADO: ${x}`).join("\n")); }
{ const x = conferirExportacao(); if (x.length) sair(2, x.map((y) => `RECUSADO: ${y}`).join("\n")); }
console.log(`backup informado: ${E.PROD_BACKUP_TIPO} em ${E.PROD_BACKUP_HORARIO} | exportação conferida: ${E.PROD_EXPORTACAO.slice(0, 16)}…`);
arquivosConferidos();
const antes = lerJson(SQL_ESTADO);
const recusas = avaliarAntes(antes);
if (recusas.length) sair(2, `RECUSADO (o estado mudou desde o preflight):\n${recusas.map((s) => `  - ${s}`).join("\n")}`);
const t0 = Date.now(); const r = psql(["-q", "-f", path.join(RAIZ, M151[0])]);
const depois = r.status === 0 ? lerJson(SQL_ESTADO) : antes;
const { mudou, novas151 } = compararConteudo(antes, depois);
const f = evid(r.status === 0 ? "aplicar" : "aplicar-FALHA", `identidade ${ident}\nantes ${JSON.stringify(antes)}\nexit ${r.status} (${Date.now() - t0} ms)\n${r.saida}\n${r.erro}\ndepois ${JSON.stringify(depois)}\nmudou ${JSON.stringify(mudou)} novas151NaoVazias ${JSON.stringify(novas151)}\n`);
if (r.status !== 0) sair(1, `FALHA — a transação da 151 foi desfeita; nada mudou.\n${r.erro.split("\n").filter((l) => /ERRO|ERROR/.test(l)).slice(0, 4).join("\n")}\nevidência: ${f}`);
console.log(resumo(depois));
const ok = depois.tabelas151.length === 4 && depois.rls151 && depois.md5Lista === MD5.depois.lista && depois.md5Guarda === MD5.depois.guarda && mudou.length === 0 && novas151.length === 0;
console.log(ok ? "RESULTADO: OK — 151 aplicada; NENHUMA tabela existente mudou de conteúdo; tabelas novas vazias." : `RESULTADO: DIVERGÊNCIA — tabelas com conteúdo alterado: ${mudou.join(", ") || "—"}; novas não vazias: ${novas151.join(", ") || "—"} (ver plano de reversão).`);
console.log(`evidência: ${f}`); process.exit(ok ? 0 : 1);
