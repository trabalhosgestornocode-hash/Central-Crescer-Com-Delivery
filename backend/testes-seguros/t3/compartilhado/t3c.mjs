// T3 no Supabase de testes COMPARTILHADO (doc 23). ÚNICO caminho de escrita nesse banco. Os scripts originais (trava "banco descartável",
// que recusa este banco por ter organizações reais) NÃO mudam: aqui eles só rodam ADAPTADOS (ids da allowlist, trava própria) e embrulhados.
//
//   node backend/testes-seguros/t3/compartilhado/t3c.mjs <passo> [opções]
//   passos: preflight | m115 | migracoes | semente | provas [nomes,...] | encerrar | verificar | bloqueados
//
// Travas (todas falham FECHADAS, antes de conectar quando possível):
//   * só variáveis T3C_* explícitas; nunca lê backend/.env nem aceita NODE_OPTIONS com --env-file; filhos recebem um ambiente montado do zero;
//   * recusa o ref de PRODUÇÃO em qualquer variável do terminal; exige o ref EXATO do projeto de testes (URL, host/usuário da conexão);
//   * T3C_CONFIRMO=COMPARTILHADO_<ref> (diferente do token dos scripts descartáveis) e T3C_IDENTIDADE = impressão do banco lida no preflight;
//   * cada passo de escrita exige a SUA autorização (T3C_AUTORIZO_<PASSO>=SIM); sem ela, só lista o que faria;
//   * só arquivos do MANIFESTO, sem alteração local (git) e com o sha256 impresso; lint de construções proibidas (reset, truncate,
//     session_replication_role, grant/revoke, DDL fora de pg_temp, controle de transação, meta-comandos de arquivo/shell);
//   * dados só nas organizações da allowlist (e unidades delas): as provas SQL rodam numa transação REPEATABLE READ e, antes do COMMIT,
//     comparam a impressão de TUDO o que está fora da allowlist — qualquer diferença aborta (ROLLBACK). Provas multissessão: impressão antes/depois.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const t3 = path.resolve(aqui, "..");
const backend = path.resolve(t3, "..", "..");
const raiz = path.resolve(backend, "..");
const { PROJETO_PRODUCAO_REF, PROJETO_TESTE_REF } = await import(pathToFileURL(path.join(backend, "src", "modules", "ifood", "ifood.ambienteTeste.js")).href);

// ---------------- allowlist sintética ----------------
export const ORGS = ["00000000-0000-0000-0000-0000000f1a01", "00000000-0000-0000-0000-0000000f1a02"];
export const UNIDADES = {
  a: "00000000-0000-0000-0000-0000000f1a11", a3: "00000000-0000-0000-0000-0000000f1a12", a4: "00000000-0000-0000-0000-0000000f1a13",
  b: "00000000-0000-0000-0000-0000000f1a14", livre: "00000000-0000-0000-0000-0000000f1a15",
  f3: "00000000-0000-0000-0000-0000000f1a16",   // só da F-3/F-4 (meses próprios, sem colidir com os fechamentos das adversariais)
};
// ids fixos dos scripts descartáveis → allowlist (organizações e unidades; ids de linhas financeiras ficam como estão: as tabelas fin_* nascem vazias)
const MAPA = {
  "00000000-0000-0000-0000-0000000000a1": ORGS[0], "00000000-0000-0000-0000-0000000000b1": ORGS[1],
  "00000000-0000-0000-0000-0000000000a2": UNIDADES.a, "00000000-0000-0000-0000-0000000000a3": UNIDADES.a3,
  "00000000-0000-0000-0000-0000000000a4": UNIDADES.a4, "00000000-0000-0000-0000-0000000000b2": UNIDADES.b,
};

// ---------------- manifesto ----------------
const P = (...p) => path.join(backend, "testes-seguros", ...p);
const MIGRACOES = [
  { arq: path.join(raiz, "database/migrations/120_gestao_financeira_fundacao.sql"), modo: "propria" },        // begin/commit + lock_timeout próprios
  { arq: path.join(raiz, "database/migrations/121_gestao_financeira_dominio.sql"), modo: "propria" },
  { arq: path.join(raiz, "database/migrations/122_conciliacao_periodos.sql"), modo: "propria" },        // promovida: begin/commit + lock_timeout próprios (corpo = o aplicado no T3)
];
const M115 = path.join(raiz, "database/migrations/115_fecha_acesso_direto_residual.sql");
const PROVAS = {
  d1: { arq: P("pg/adversarial_d1_periodo_fechado.sql"), iso: "repeatable read" },
  adv122: { arq: P("pg/adversarial122.sql"), iso: "repeatable read",
    cortes: [{ de: /^\\echo '=== S6\./m, ate: /^\\echo '===/m, rotulo: "S6a/S6b (exceção vencida: exige desligar os gatilhos da sessão)" }] },
  adv122c: { arq: P("pg/adversarial122_complemento.sql"), iso: "repeatable read",
    cortes: [{ de: /^-- S7v:/m, ate: /^set session_replication_role = origin;\n/m, inclusivo: true, rotulo: "S7v/S7w (CHECK com gatilhos desligados: exige desligar os gatilhos da sessão)" }] },
  r1: { arq: P("pg/reproduz_r1.sql"), iso: "repeatable read", esperaErro: /fin_conciliacao_divergente/ },   // reprodução: o fechamento TEM de ser recusado
  transferencia: { arq: path.join(aqui, "transferencia_compartilhado.sql"), iso: "read committed", proprio: true },   // a guarda exige READ COMMITTED
  f1: { arq: P("pg/f1_concorrencia.sh"), multissessao: true },
  f3f4: { arq: path.join(t3, "f3_f4_e2e.mjs"), multissessao: true, api: true },
};
export const BLOQUEADOS = {
  "parity_m1.mjs": "usa session_replication_role = replica para semear (proibido no compartilhado); paridade JS×SQL provada no local (631/631) e, no compartilhado, pela F-3 (f3f4)",
  "desempenho_m1.sql": "300 mil linhas permanentes num banco que não é descartável",
  "adversarial122_concorrencia.sh": "ids fixos fora da allowlist em sessões paralelas sem embrulho transacional; coberto por f1 (concorrência com sessões reais)",
  "seed_descartavel.sql": "pressupõe banco vazio (trava 'nenhuma organização real'); substituído por semente_compartilhado.sql",
  "aplicar_estrutura_t3.sh": "etapa base reaplicaria TODAS as migrations da main num banco existente",
  "sim_supabase.sh / ciclo_120_121_122.sh / transferencia_unidades.sh / ensaio_115_120.sh / run.sh": "recriam bancos (drop database) — só no cluster local descartável",
  "*_rollback.sql": "rollback destrutivo; a 120 nem volta neste banco (doc 21 §6)",
};
const AUTORIZACAO = { m115: "T3C_AUTORIZO_115", migracoes: "T3C_AUTORIZO_MIGRACOES", semente: "T3C_AUTORIZO_SEMENTE", provas: "T3C_AUTORIZO_PROVAS", encerrar: "T3C_AUTORIZO_ENCERRAMENTO" };

// ---------------- travas de ambiente (sem rede) ----------------
const E = process.env;
const ENSAIO = E.T3C_ENSAIO_LOCAL === "1";   // ensaio contra o cluster LOCAL descartável (127.0.0.1:54321 + MARCADOR_DESCARTAVEL); relaxa só ref/URL
export function travasDeAmbiente(env = E, { ensaio = ENSAIO } = {}) {
  const erros = [];
  for (const [k, v] of Object.entries(env)) if (String(v ?? "").includes(PROJETO_PRODUCAO_REF)) erros.push(`${k} contém o ref de PRODUÇÃO: abra um terminal limpo`);
  if (/--env-file/.test(env.NODE_OPTIONS ?? "")) erros.push("NODE_OPTIONS com --env-file: o T3 compartilhado nunca carrega arquivos .env");
  const conn = env.T3C_PSQL_CONN ?? "";
  if (!conn) erros.push("defina T3C_PSQL_CONN (conexão do projeto de TESTES, só por variável)");
  if (env.T3C_CONFIRMO !== `COMPARTILHADO_${PROJETO_TESTE_REF}`) erros.push(`T3C_CONFIRMO precisa ser exatamente COMPARTILHADO_${PROJETO_TESTE_REF}`);
  let url = null; try { url = new URL(conn); } catch { if (conn) erros.push("T3C_PSQL_CONN não é uma URL postgresql:// válida"); }
  if (ensaio) {
    const cluster = env.PG_CLUSTER_DIR ?? "";
    if (!cluster || !existsSync(path.join(cluster, "MARCADOR_DESCARTAVEL"))) erros.push("ensaio local exige PG_CLUSTER_DIR com MARCADOR_DESCARTAVEL");
    if (url && !(url.hostname === "127.0.0.1" && url.port === "54321")) erros.push("ensaio local só aceita 127.0.0.1:54321");
  } else {
    if (env.T3C_PROJECT_REF !== PROJETO_TESTE_REF) erros.push(`T3C_PROJECT_REF precisa ser ${PROJETO_TESTE_REF} (projeto de testes)`);
    if (url) {
      const usuario = decodeURIComponent(url.username);
      const hostOk = url.hostname === `db.${PROJETO_TESTE_REF}.supabase.co` || (/\.pooler\.supabase\.com$/.test(url.hostname) && usuario === `postgres.${PROJETO_TESTE_REF}`);
      if (!hostOk) erros.push("T3C_PSQL_CONN não é do projeto de testes (db.<ref>.supabase.co ou pooler com usuário postgres.<ref>)");
    }
    if (env.T3C_SUPABASE_URL && env.T3C_SUPABASE_URL.replace(/\/$/, "") !== `https://${PROJETO_TESTE_REF}.supabase.co`) erros.push("T3C_SUPABASE_URL não é a URL do projeto de testes");
  }
  return erros;
}

// ---------------- lint e adaptação ----------------
const PROIBIDOS = [
  [/session_replication_role/i, "session_replication_role"], [/\btruncate\b/i, "truncate"], [/\breset\s+all\b/i, "reset all"], [/\bdiscard\b/i, "discard"],
  [/\bset\s+session\s+authorization\b/i, "set session authorization"], [/\b(grant|revoke)\s/i, "grant/revoke"], [/\bcall\s+\w/i, "call (procedimento)"],
  [/\bdrop\s+(table|schema|database|owned|role|policy|trigger|view|index|extension|type|sequence)\b/i, "drop de objeto"],
  [/\bdrop\s+function\s+(?!(if\s+exists\s+)?pg_temp\.)/i, "drop function fora de pg_temp"],
  [/\balter\s+(table|function|role|default|policy|database|system|schema|type|sequence|view|trigger)\b/i, "alter"],
  [/\bcreate\s+(or\s+replace\s+)?function\s+(?!pg_temp\.)/i, "create function fora de pg_temp"],
  [/\bcreate\s+(unique\s+)?(table|view|schema|role|policy|index|trigger|type|sequence|extension|rule)\b/i, "create de objeto permanente"],
  [/^\s*\\(c|connect|!|o|out|copy|i|ir|include|include_relative|w|write|gexec|setenv|cd|unset|q)(?=\s|$)/im, "meta-comando proibido"],
  [/^\s*\\set\s+ON_ERROR_ROLLBACK\b/im, "ON_ERROR_ROLLBACK"],
  [/\bdelete\s+from\s+(?!(public\.)?(fin_|organizacao_modulos\b|unidade_modulos\b))/i, "delete fora de fin_* / módulos da allowlist"],
  [/\bset\s+role\s+(?!(?:service_role|anon|authenticated)\b|:"DONO")/i, "set role para papel não previsto"],
  [/0{8}-0{4}-0{4}-0{4}-0{10}(a1|b1|a2|a3|a4|b2)\b/i, "id descartável não remapeado"],
];
// controle de transação só no nível do script (fora de corpos $tag$...$tag$, onde begin/end são do plpgsql)
const TRANSACAO = /^\s*(begin|commit|rollback|end|abort|start\s+transaction|savepoint|release)\b\s*(transaction|work|isolation|;)/im;
const semCorpos = (t) => t.replace(/(\$[A-Za-z_0-9]*\$)[\s\S]*?\1/g, "$$$$");
export function lint(texto) {
  const achados = PROIBIDOS.filter(([re]) => re.test(texto)).map(([, nome]) => nome);
  if (TRANSACAO.test(semCorpos(texto))) achados.push("controle de transação");
  return achados;
}

export function adaptar(nome, texto) {
  const prova = PROVAS[nome]; const cortados = [];
  let t = texto.replace(/\r\n/g, "\n");
  if (!prova.proprio) {
    const ini = t.indexOf("-- TRAVA DE AMBIENTE DESCARTÁVEL"); const fim = t.indexOf("-- fim da trava");
    if (ini < 0 || fim < ini) throw new Error(`${nome}: trava original não encontrada (arquivo mudou?) — recusado`);
    t = t.slice(0, ini) + "-- (trava descartável removida pelo t3c: a trava do modo compartilhado vem no embrulho)\n" + t.slice(t.indexOf("\n", fim) + 1);
  }
  for (const c of prova.cortes ?? []) {
    const m = c.de.exec(t); if (!m) throw new Error(`${nome}: trecho a cortar não encontrado (${c.rotulo}) — recusado`);
    const resto = t.slice(m.index + m[0].length); const m2 = c.ate.exec(resto);
    if (!m2) throw new Error(`${nome}: fim do trecho a cortar não encontrado (${c.rotulo}) — recusado`);
    const fimCorte = m.index + m[0].length + m2.index + (c.inclusivo ? m2[0].length : 0);
    t = t.slice(0, m.index) + `\\echo 'NAO EXECUTADO no compartilhado: ${c.rotulo.replace(/'/g, "")}'\n` + t.slice(fimCorte);
    cortados.push(c.rotulo);
  }
  for (const [de, para] of Object.entries(MAPA)) t = t.split(de).join(para);
  return { texto: t, cortados };
}

// ---------------- SQL do embrulho ----------------
const lista = (ids) => `array[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`;
// impressão de TUDO o que está fora da allowlist (por tabela do public, exceto fin_*/gestao_financeira_*) + auth.users; e violações nas tabelas financeiras
export const sqlImpressao = (destino) => `
do $t3c$
declare r record; n bigint; h text; orgs uuid[] := ${lista(ORGS)}; filtro text; viol bigint;
begin
  for r in select c.relname,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organizacao_id' and not a.attisdropped) as tem_org,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'unidade_id' and not a.attisdropped) as tem_uni
             from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
              and c.relname not like 'fin\\_%' and c.relname not like 'gestao\\_financeira\\_%' order by c.relname loop
    filtro := case when r.relname = 'organizacoes' then ' where t.id <> all($1)'
                   when r.tem_org then ' where t.organizacao_id is null or t.organizacao_id <> all($1)'
                   when r.tem_uni then ' where t.unidade_id is null or t.unidade_id not in (select u.id from public.unidades u where u.organizacao_id = any($1))'
                   else '' end;
    execute format('select count(*), coalesce(md5(string_agg(md5(t::text), '''' order by md5(t::text))), '''') from public.%I t', r.relname) || filtro into n, h using orgs;
    ${destino("r.relname", "n", "h")}
  end loop;
  select count(*), coalesce(md5(string_agg(id::text, ',' order by id)), '') into n, h from auth.users;
  ${destino("'auth.users'", "n", "h")}
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
            and (c.relname like 'fin\\_%' or c.relname like 'gestao\\_financeira\\_%') order by 1 loop
    execute format('select count(*) from public.%I where organizacao_id is null or organizacao_id <> all($1)', r.relname) into viol using orgs;
    ${destino("'FIN_FORA_DA_ALLOWLIST:' || r.relname", "viol", "''")}
  end loop;
end $t3c$;`;
const paraNotice = (t, n, h) => `raise notice 'IMPRESSAO|%|%|%', ${t}, ${n}, ${h};`;
const paraTabela = (tab) => (t, n, h) => `insert into ${tab} values (${t}, ${n}, ${h});`;
// identidade = oid do banco + oid do schema public + versões registradas em supabase_migrations (query_to_xml: não quebra se a tabela não existir)
const sqlIdentidadeSegura = `select md5((select oid::text from pg_database where datname = current_database()) || '|' || 'public'::regnamespace::oid::text || '|' ||
  case when to_regclass('supabase_migrations.schema_migrations') is null then 'sem-registro'
       else query_to_xml('select string_agg(version, '','' order by version) as v from supabase_migrations.schema_migrations', false, true, '')::text end)`;

export function embrulhar({ passo, corpo, iso, tolerante = false, permitidas = [] }) {
  // tolerante: só as PROVAS (que provocam erros de propósito) rodam com ON_ERROR_ROLLBACK; semente/encerramento abortam no primeiro erro.
  // permitidas: tabelas cuja impressão PODE mudar neste passo. Nenhuma nos passos embrulhados.
  return `\\set ON_ERROR_STOP on
\\set ON_ERROR_ROLLBACK off
\\if :{?T3C_CONFIRMO} \\else \\set T3C_CONFIRMO ausente \\endif
\\if :{?T3C_AUTORIZO} \\else \\set T3C_AUTORIZO ausente \\endif
\\if :{?T3C_IDENTIDADE} \\else \\set T3C_IDENTIDADE ausente \\endif
select (:'T3C_CONFIRMO' = 'COMPARTILHADO_${PROJETO_TESTE_REF}' and :'T3C_AUTORIZO' = '${passo}') as t3c_ok \\gset
\\if :t3c_ok \\else
  do $t3c$ begin raise exception 'RECUSADO (t3c): confirmacao/autorizacao do passo ${passo} ausente'; end $t3c$;
\\endif
begin isolation level ${iso};
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select (${sqlIdentidadeSegura}) = :'T3C_IDENTIDADE' as t3c_mesmo_banco \\gset
\\if :t3c_mesmo_banco \\else
  do $t3c$ begin raise exception 'RECUSADO (t3c): a identidade do banco difere da lida no preflight'; end $t3c$;
\\endif
create temp table t3c_antes (tabela text, linhas bigint, hash text) on commit drop;
create temp table t3c_depois (tabela text, linhas bigint, hash text) on commit drop;
${sqlImpressao(paraTabela("t3c_antes"))}
\\echo '==T3C== inicio do corpo (${passo})'
${tolerante ? "\\set ON_ERROR_ROLLBACK on" : ""}
${corpo}
\\set ON_ERROR_ROLLBACK off
\\set ON_ERROR_STOP on
\\echo '==T3C== fim do corpo'
reset role;
${sqlImpressao(paraTabela("t3c_depois"))}
do $t3c$
declare d text;
begin
  select string_agg(coalesce(a.tabela, b.tabela) || ' (' || coalesce(a.linhas::text, '-') || ' -> ' || coalesce(b.linhas::text, '-') || ')', '; ') into d
    from t3c_antes a full join t3c_depois b on a.tabela = b.tabela
   where (a.linhas, a.hash) is distinct from (b.linhas, b.hash)
     and coalesce(a.tabela, b.tabela) not like 'FIN_FORA_DA_ALLOWLIST:%'
     and coalesce(a.tabela, b.tabela) <> all (array[${permitidas.map((t) => `'${t}'`).join(",")}]::text[]);
  if d is not null then raise exception 'VIOLACAO (t3c): dados FORA da allowlist mudaram: % — nada foi gravado (ROLLBACK)', d; end if;
  select string_agg(tabela || '=' || linhas, '; ') into d from t3c_depois where tabela like 'FIN_FORA_DA_ALLOWLIST:%' and linhas > 0;
  if d is not null then raise exception 'VIOLACAO (t3c): linhas financeiras fora da allowlist: % — nada foi gravado (ROLLBACK)', d; end if;
  raise notice 'T3C OK: nenhuma linha fora da allowlist mudou';
end $t3c$;
commit;
`;
}

// ---------------- execução ----------------
const PSQL = E.PSQL || "C:/Program Files/PostgreSQL/17/bin/psql.exe";
function ambienteFilho(extra = {}) {   // montado do zero: nada do terminal além do necessário para o SO e o psql
  const base = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec"]) if (E[k]) base[k] = E[k];
  if (process.platform === "win32" && !base.SystemRoot && !base.SYSTEMROOT) base.SystemRoot = "C:\\WINDOWS";   // sem ele o psql do Windows não abre socket
  return { ...base, PGCLIENTENCODING: "UTF8", PGAPPNAME: "t3c-financeiro", PGCONNECT_TIMEOUT: "15", ...extra };
}
const conexao = () => E.T3C_PSQL_CONN;
const limpar = (s) => String(s ?? "").split(conexao() || "\u0000").join("<conexão>");
function psql(args, { input, somenteLeitura = false, vars = {} } = {}) {
  const v = Object.entries(vars).flatMap(([k, val]) => ["-v", `${k}=${val}`]);
  const r = spawnSync(PSQL, ["-X", "-q", ...v, ...args, conexao()], {
    input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: ambienteFilho({ PGOPTIONS: somenteLeitura ? "-c default_transaction_read_only=on -c statement_timeout=60000" : "-c lock_timeout=5000 -c statement_timeout=120000" }),
  });
  return { status: r.status, saida: limpar(r.stdout), erro: limpar(r.stderr) };
}
function arquivoDoManifesto(arq) {
  if (!existsSync(arq)) throw new Error(`arquivo do manifesto ausente: ${arq}`);
  const rel = path.relative(raiz, arq).replaceAll("\\", "/");
  const sujo = execFileSync("git", ["-C", raiz, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim();
  if (sujo && !ENSAIO) throw new Error(`${rel} tem alteração local não commitada — o T3 só roda arquivos commitados`);
  const texto = readFileSync(arq, "utf8");
  return { rel, texto, sha: createHash("sha256").update(texto).digest("hex"), sujo: !!sujo };
}
function evid(nome, conteudo) {
  const dir = E.T3C_EVIDENCIAS || path.join(os.tmpdir(), "evidencias-t3c"); mkdirSync(dir, { recursive: true });   // fora do Git
  const f = path.join(dir, nome); writeFileSync(f, conteudo); return f;
}
function lerImpressao() {
  const r = psql(["-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sqlImpressao(paraNotice), somenteLeitura: true });
  if (r.status !== 0) throw new Error(`impressão falhou: ${r.erro.split("\n")[0]}`);
  const m = {}; for (const l of r.erro.split(/\r?\n/)) { const x = /IMPRESSAO\|([^|]*)\|([^|]*)\|(.*)$/.exec(l); if (x) m[x[1]] = { linhas: Number(x[2]), hash: x[3].trim() }; }
  // falha FECHADA: uma impressão vazia tornaria a conferência inútil (todas as comparações "iguais")
  if (Object.keys(m).length < 10 || !m.organizacoes || !m.unidades || !m["auth.users"]) throw new Error(`impressão incompleta (${Object.keys(m).length} tabelas) — recusado`);
  return m;
}
const diferencas = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !(k.startsWith("FIN_FORA_DA_ALLOWLIST:") && !(b[k]?.linhas > 0)));
function identidadeViva() {
  const r = psql(["-tA", "-v", "ON_ERROR_STOP=1", "-c", sqlIdentidadeSegura], { somenteLeitura: true });
  if (r.status !== 0) throw new Error(`identidade: ${r.erro.split("\n")[0]}`);
  return r.saida.trim();
}
function exigirIdentidade() {
  const viva = identidadeViva();
  if (E.T3C_IDENTIDADE !== viva) throw new Error("T3C_IDENTIDADE ausente ou diferente da identidade viva do banco — rode o preflight e confira o alvo");
  return viva;
}

// ---------------- passos ----------------
const passo = process.argv[2]; const args = process.argv.slice(3);
const sair = (cod, msg) => { if (msg) (cod ? console.error : console.log)(msg); process.exit(cod); };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await principal();   // importado (testes): só exporta

async function principal() {
  if (!passo || passo === "-h") sair(2, "uso: t3c.mjs preflight|m115|migracoes|semente|provas [nomes]|encerrar|verificar|bloqueados");
  if (passo === "bloqueados") { for (const [k, v] of Object.entries(BLOQUEADOS)) console.log(`BLOQUEADO  ${k}: ${v}`); sair(0); }
  const erros = travasDeAmbiente();
  if (erros.length) sair(2, erros.map((e) => `RECUSADO: ${e}`).join("\n"));
  if (ENSAIO) console.log("ENSAIO LOCAL (cluster descartável): checagens de ref/URL relaxadas; todas as demais travas valem.");
  const varAut = AUTORIZACAO[passo];
  const autorizado = varAut ? E[varAut] === "SIM" : true;

  if (passo === "preflight") {
    const ident = identidadeViva();
    const r = psql(["-tA", "-v", "ON_ERROR_STOP=1", "-c", `select current_setting('transaction_read_only') || '|' || current_user || '|' || (select count(*) from public.organizacoes) || '|' ||
      (select count(*) from public.organizacoes where id = any(${lista(ORGS)})) || '|' || (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'fin\\_%') || '|' ||
      (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'transferir_unidade_organizacao' and has_function_privilege('anon', p.oid, 'execute')) || '|' ||
      (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'active')`], { somenteLeitura: true });
    if (r.status !== 0) sair(2, `RECUSADO: leitura falhou: ${r.erro.split("\n")[0]}`);
    const [ro, usuario, orgs, sinteticas, fin, anon115, ativas] = r.saida.trim().split("|");
    if (ro !== "on") sair(2, "RECUSADO: a sessão do preflight não ficou somente leitura");
    const imp = lerImpressao();
    const f = evid(`linha-de-base-${Date.now()}.json`, JSON.stringify({ identidade: ident, impressao: imp }, null, 2));
    console.log(JSON.stringify({ identidade: ident, usuario, organizacoes: Number(orgs), sinteticasJaExistentes: Number(sinteticas), tabelasFin: Number(fin),
      m115Aplicada: anon115 === "0", sessoesAtivasDeOutros: Number(ativas), tabelasImpressas: Object.keys(imp).length, linhaDeBase: f }, null, 2));
    console.log(`\nPara os próximos passos: T3C_IDENTIDADE=${ident} e T3C_LINHA_DE_BASE=<arquivo acima>. Sessões ativas de outros > 0 ⇒ combine a janela antes de escrever.`);
    sair(0);
  }
  if (passo === "verificar") {
    exigirIdentidade();
    const base = JSON.parse(readFileSync(E.T3C_LINHA_DE_BASE ?? "", "utf8")).impressao; const agora = lerImpressao();
    const d = diferencas(base, agora);
    for (const k of d) console.log(`DIFERE  ${k}: ${JSON.stringify(base[k])} -> ${JSON.stringify(agora[k])}`);
    console.log(d.length ? `${d.length} tabela(s) fora da allowlist diferem da linha de base (esperado após migracoes: só 'modulos').` : "fora da allowlist: idêntico à linha de base");
    sair(d.filter((k) => k !== "modulos").length ? 1 : 0);
  }

  // ---- passos de escrita ----
  const plano = [];
  if (passo === "m115") plano.push({ tipo: "migracao", ...arquivoDoManifesto(M115), modo: "propria" });
  else if (passo === "migracoes") for (const m of MIGRACOES) plano.push({ tipo: "migracao", ...arquivoDoManifesto(m.arq), modo: m.modo });
  else if (passo === "semente" || passo === "encerrar") {
    const a = arquivoDoManifesto(path.join(aqui, passo === "semente" ? "semente_compartilhado.sql" : "encerrar_compartilhado.sql"));
    const l = lint(a.texto); if (l.length) sair(2, `RECUSADO: ${a.rel} tem construções proibidas: ${l.join(", ")}`);
    plano.push({ tipo: "sql", ...a, iso: "read committed", corpo: a.texto, tolerante: false });
  } else if (passo === "provas") {
    const nomes = (args[0] ?? Object.keys(PROVAS).join(",")).split(",");
    for (const n of nomes) {
      if (!PROVAS[n]) sair(2, `RECUSADO: prova '${n}' fora do manifesto (bloqueados: node t3c.mjs bloqueados)`);
      const a = arquivoDoManifesto(PROVAS[n].arq);
      if (PROVAS[n].multissessao) { plano.push({ tipo: "multi", nome: n, ...a }); continue; }
      const { texto, cortados } = adaptar(n, a.texto);
      const l = lint(texto); if (l.length) sair(2, `RECUSADO: ${a.rel} (adaptado) tem construções proibidas: ${l.join(", ")}`);
      const corpo = PROVAS[n].esperaErro ? `\\set ON_ERROR_STOP off\n${texto}` : texto;
      plano.push({ tipo: "sql", nome: n, ...a, iso: PROVAS[n].iso, corpo, cortados, tolerante: true, esperaErro: PROVAS[n].esperaErro });
    }
  } else sair(2, `passo desconhecido: ${passo}`);

  console.log(`passo: ${passo} | autorização ${varAut}=${autorizado ? "SIM" : "ausente"} | commit ${execFileSync("git", ["-C", raiz, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}`);
  for (const p of plano) console.log(`  ${p.tipo.padEnd(8)} ${p.rel}  sha256=${p.sha.slice(0, 16)}${p.sujo ? "  (ALTERADO LOCALMENTE — só no ensaio)" : ""}${p.cortados?.length ? `  cortes: ${p.cortados.join("; ")}` : ""}`);
  if (!autorizado) sair(0, "Somente listagem: falta a autorização expressa deste passo. Nada foi conectado.");
  if (passo === "provas" && E.T3C_ACEITO_DADOS_PERMANENTES !== "SIM") sair(2, "RECUSADO: as provas deixam linhas financeiras sintéticas PERMANENTES (A4): defina T3C_ACEITO_DADOS_PERMANENTES=SIM");
  const ident = exigirIdentidade();
  const vars = { T3C_CONFIRMO: E.T3C_CONFIRMO, T3C_AUTORIZO: passo, T3C_IDENTIDADE: ident, DONO: ENSAIO ? (E.T3C_DONO || "dono_sim") : "postgres" };
  let falhou = false; const log = [];

  if (passo === "migracoes") {
    const r = psql(["-tA", "-c", "select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('transferir_unidade_organizacao','promover_unidade_para_empresa','remapear_organizacao_em_tabelas_de_unidade','converter_empresa_para_unidade','excluir_organizacao_definitivamente') and has_function_privilege('anon', p.oid, 'execute')"], { somenteLeitura: true });
    if (r.saida.trim() !== "0" && E.T3C_SEM_115 !== "CIENTE") sair(2, "RECUSADO: a 115 não está aplicada (RPCs de estrutura executáveis por anon). Aplique antes (passo m115) ou declare T3C_SEM_115=CIENTE.");
  }
  const antes = (passo === "migracoes" || passo === "m115" || plano.some((p) => p.tipo === "multi")) ? lerImpressao() : null;
  for (const p of plano) {
    if (p.tipo === "migracao") {
      const r = psql(["-v", "ON_ERROR_STOP=1", ...(p.modo === "single" ? ["--single-transaction"] : []), "-f", path.join(raiz, p.rel)]);
      log.push(`== ${p.rel}\n${r.saida}\n${r.erro}`); console.log(`${r.status === 0 ? "OK   " : "ERRO "} ${p.rel}`);
      if (r.status !== 0) { console.error(r.erro.split("\n").slice(0, 4).join("\n")); falhou = true; break; }
    } else if (p.tipo === "sql") {
      const sql = embrulhar({ passo, corpo: p.corpo, iso: p.iso, tolerante: p.tolerante });
      const r = psql(["-f", "-"], { input: sql, vars });
      let pass = (r.erro.match(/PASS /g) ?? []).length + (r.saida.match(/^OK /gm) ?? []).length;
      let fal = (r.erro.match(/FALHA /g) ?? []).length + (r.saida.match(/^FALHA /gm) ?? []).length;
      let engolidos = (r.erro.match(/^psql:.*(ERRO|ERROR):/gm) ?? []).length;   // erros fora de pg_temp.exp (ON_ERROR_ROLLBACK): ficam visíveis no resumo
      if (p.esperaErro) { if (p.esperaErro.test(r.erro)) { pass += 1; engolidos -= 1; } else fal += 1; }   // o erro esperado É o resultado da prova
      const ok = r.status === 0 && /T3C OK/.test(r.erro);
      log.push(`== ${p.rel}\n${r.saida}\n${r.erro}`);
      console.log(`${ok && !fal ? "OK   " : "FALHA"} ${p.nome ?? p.rel}: PASS=${pass} FALHA=${fal} erros_de_comando=${engolidos} ${ok ? "(commit; nada fora da allowlist mudou)" : "(ROLLBACK)"}`);
      if (!ok) { console.error((r.erro.match(/.*(VIOLACAO|RECUSADO|ERRO|ERROR).*/g) ?? [r.erro.split("\n")[0]]).slice(0, 3).join("\n")); falhou = true; break; }
      if (fal) falhou = true;
    } else if (p.tipo === "multi") {
      // token só no ambiente do filho, depois das travas acima; T3_DONO_ROLE = mesmo DONO das provas SQL (no Supabase: postgres)
      const extra = { T3_ORG_ID: ORGS[0], T3_UNIDADE_ID: UNIDADES.f3, T3_CONFIRMO: "ESTE_PROJETO_E_DESCARTAVEL", T3_DONO_ROLE: vars.DONO };
      let r;
      if (p.nome === "f1") r = spawnSync("bash", [path.join(raiz, p.rel)], { encoding: "utf8", env: ambienteFilho({ ...extra, T3_PSQL_CONN: conexao(), PATH: E.PATH }) });
      else {
        if (!E.T3C_SUPABASE_URL || !E.T3C_SERVICE_ROLE_KEY) { console.log("PULADO f3f4: defina T3C_SUPABASE_URL e T3C_SERVICE_ROLE_KEY (do projeto de testes)"); continue; }
        r = spawnSync(process.execPath, [path.join(raiz, p.rel)], { encoding: "utf8", cwd: backend,
          env: ambienteFilho({ ...extra, T3_SUPABASE_URL: E.T3C_SUPABASE_URL, T3_SERVICE_ROLE_KEY: E.T3C_SERVICE_ROLE_KEY, T3_PROJECT_REF: PROJETO_TESTE_REF }) });
      }
      const out = limpar(r.stdout) + limpar(r.stderr); log.push(`== ${p.rel}\n${out}`);
      const fal = (out.match(/^FALHA/gm) ?? []).length;
      console.log(`${r.status === 0 && !fal ? "OK   " : "FALHA"} ${p.nome}: PASS=${(out.match(/^PASS/gm) ?? []).length} FALHA=${fal} (multissessão: conferência depois)`);
      for (const l of out.match(/^FALHA.*$/gm) ?? []) console.log(`  ${l.slice(0, 220)}`);
      if (r.status !== 0 || fal) falhou = true;
    }
  }
  if (antes) {
    const depois = lerImpressao(); const permit = passo === "migracoes" ? ["modulos"] : [];
    const d = diferencas(antes, depois).filter((k) => !permit.includes(k));
    if (d.length) { console.error(`VIOLACAO (t3c, detectada depois): fora da allowlist mudou: ${d.join(", ")} — PARE e investigue (não há rollback automático neste passo)`); falhou = true; }
    else console.log(`fora da allowlist: sem mudança${permit.length ? ` (exceto o permitido: ${permit.join(", ")})` : ""}`);
  }
  console.log(`evidência: ${evid(`${passo}-${Date.now()}.log`, log.join("\n"))}`);
  sair(falhou ? 1 : 0, falhou ? "PASSO COM FALHA" : "PASSO OK");
}
