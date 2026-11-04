// Implantação CONTROLADA da migration 150 (índice único: UMA execução Foody EM_ANDAMENTO por unidade).
//
// Só um OPERADOR AUTORIZADO roda, no PRÓPRIO terminal. A conexão vem SÓ de FOODY_CONN (nunca impressa nem gravada); o alvo é
// FOODY_ALVO (local | teste | producao), conferido contra host/usuário pelas MESMAS travas do kit 147–149.
//
//   node kit150.mjs pacote       gera os SQL e confere o SHA-256 fixado (não conecta)
//   node kit150.mjs prevoo       SOMENTE LEITURA: 147–149 registradas, 150 ausente, nenhuma unidade com 2+ EM_ANDAMENTO, locks
//   FOODY_AUTORIZO=SIM FOODY_BACKUP_CONFIRMADO=SIM node kit150.mjs aplicar
//                                pré-voo + aplicação em UMA transação (índice + registro no histórico + autoverificação) + validar
//   node kit150.mjs validar      SOMENTE LEITURA: índice único, parcial, válido, na coluna certa, registrado UMA vez
//   FOODY_AUTORIZO=SIM node kit150.mjs recuperar
//                                remove SÓ o índice e o registro da 150 (não toca dado nenhum); confere; a trava da aplicação segue
// Ensaio no TESTE sem deixar rastro: `ensaio` roda o pacote de aplicação + validação + recuperação numa transação com ROLLBACK.
// Ensaio local: FOODY_ALVO=local + FOODY_ENSAIO_LOCAL=1 (só 127.0.0.1/localhost).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { travasDeAlvo } from "../foody-147-149/implantar.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(AQUI, "..", "..", "..", "database", "migrations");
export const NOME = "150_foody_sync_uma_em_andamento";
export const ANTERIORES = ["147_foody_camada_central", "148_foody_conexao_compartilhada", "149_foody_conexao_administracao"];
export const INDICE = "foody_sync_execucoes_uma_em_andamento";
const TAG = "$foody150$";
const lista = (xs) => xs.map((x) => `'${x}'`).join(", ");

// SHA-256 dos SQL gerados no commit revisado. Mudou a 150, o rollback ou o kit? Regere e atualize AQUI, via PR.
export const SHA_ESPERADO = {
  "aplicar_150.sql": "ad028b819525bc7d593490c8abb84893f8614c95a97c4f9b2d521d67a6151087",
  "recuperar_150.sql": "c89aaa0153497032c421f617c9e5e0b25880467954cca099472171f0eb82cd89",
  "leitura_150.sql": "55acc62955f24b856807900d6aed543d089e3b0978b170524c85605386fd38fd",
};

const ler = (f) => readFileSync(join(MIGRATIONS, f), "utf8").replace(/\r\n/g, "\n");
/** Corpo executável do arquivo: sem as linhas `begin;`/`commit;` próprias (o pacote tem UMA transação). */
const corpo = (sql) => sql.split("\n").filter((l) => !/^\s*(begin|commit);\s*$/i.test(l)).join("\n").trim();

const VERIFICAR_INDICE = `(select jsonb_build_object(
    'existe', to_regclass('public.${INDICE}') is not null,
    'unico', coalesce((select i.indisunique from pg_index i where i.indexrelid = to_regclass('public.${INDICE}')), false),
    'valido', coalesce((select i.indisvalid and i.indisready from pg_index i where i.indexrelid = to_regclass('public.${INDICE}')), false),
    'tabela', (select i.indrelid::regclass::text from pg_index i where i.indexrelid = to_regclass('public.${INDICE}')),
    'colunas', (select coalesce(jsonb_agg(a.attname order by k.ord), '[]') from pg_index i
                  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                  where i.indexrelid = to_regclass('public.${INDICE}')),
    'predicado', (select pg_get_expr(i.indpred, i.indrelid) from pg_index i where i.indexrelid = to_regclass('public.${INDICE}'))))`;

const ESTADO = `select jsonb_build_object(
  'identidade', jsonb_build_object('db', current_database(), 'somente_leitura', current_setting('transaction_read_only'),
     'replica', pg_is_in_recovery(), 'versao', current_setting('server_version_num')::int),
  'historico_existe', to_regclass('supabase_migrations.schema_migrations') is not null,
  'anteriores_registradas', (select coalesce(jsonb_agg(name order by name), '[]') from supabase_migrations.schema_migrations where name in (${lista(ANTERIORES)})),
  'registros_150', (select count(*) from supabase_migrations.schema_migrations where name = '${NOME}'),
  'numero_150_ocupado_por_outra', (select coalesce(jsonb_agg(name), '[]') from supabase_migrations.schema_migrations where name like '150\\_%' and name <> '${NOME}'),
  'tabela_execucoes', to_regclass('public.foody_sync_execucoes') is not null,
  'indice', ${VERIFICAR_INDICE},
  'em_andamento', (select count(*) from public.foody_sync_execucoes where status = 'EM_ANDAMENTO'),
  'em_andamento_mais_de_1h', (select count(*) from public.foody_sync_execucoes where status = 'EM_ANDAMENTO' and iniciado_em < now() - interval '1 hour'),
  'unidades_com_2_ou_mais', (select count(*) from (select unidade_id from public.foody_sync_execucoes where status = 'EM_ANDAMENTO' group by 1 having count(*) > 1) x),
  'locks_externos', (select count(*) from pg_locks l where l.relation = 'public.foody_sync_execucoes'::regclass and l.pid <> pg_backend_pid()),
  'linhas', jsonb_build_object('execucoes', (select count(*) from public.foody_sync_execucoes),
     'pedidos', (select count(*) from public.foody_pedidos), 'fechamentos', (select count(*) from public.foody_fechamentos_logisticos))
) as estado;`;

export const SQL_LEITURA = `begin transaction read only;\nset local statement_timeout = '30s';\n${ESTADO}\nrollback;\n`;

const AUTOVERIFICACAO = `do $auto$
declare v jsonb := ${VERIFICAR_INDICE}; n int;
begin
  select count(*) into n from supabase_migrations.schema_migrations where name = '${NOME}';
  if not (v->>'existe')::boolean or not (v->>'unico')::boolean or not (v->>'valido')::boolean
     or v->>'tabela' <> 'foody_sync_execucoes' or v->'colunas' <> '["unidade_id"]'::jsonb
     or coalesce(v->>'predicado', '') !~ 'status.*EM_ANDAMENTO' or n <> 1 then
    raise exception '150: AUTOVERIFICACAO reprovou — % (registros %); nada foi aplicado', v, n using errcode = '55000';
  end if;
end $auto$;`;

export function gerarPacote() {
  const mig = ler(`${NOME}.sql`), rb = ler("150_rollback.sql");
  if (mig.includes(TAG)) throw new Error("150 contém a tag do registro");
  const aplicar = `-- PACOTE 150 — APLICAR (uma transação; qualquer falha desfaz tudo). Gerado por kit150.mjs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $pre$ declare n int; begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception '150: SEM_HISTORICO — nada foi aplicado' using errcode = '55000'; end if;
  select count(*) into n from supabase_migrations.schema_migrations where name in (${lista(ANTERIORES)});
  if n <> 3 then raise exception '150: exige 147–149 registradas (achei %) — nada foi aplicado', n using errcode = '55000'; end if;
  if exists (select 1 from supabase_migrations.schema_migrations where name like '150\\_%') then
    raise exception '150: JA_REGISTRADA (ou número 150 ocupado) — nada foi aplicado' using errcode = '55000'; end if;
  if to_regclass('public.${INDICE}') is not null then
    raise exception '150: ESTADO_PARCIAL — índice existe sem registro; use validar/recuperar' using errcode = '55000'; end if;
end $pre$;
-- ===== ${NOME}.sql (corpo, sem begin/commit) =====
${corpo(mig)}
-- ===== registro no histórico (statements = conteúdo ORIGINAL do arquivo) =====
insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values
  (to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '${NOME}', array[${TAG}${mig}${TAG}], 'kit-foody-150');
-- ===== autoverificação (ainda dentro da transação) =====
${AUTOVERIFICACAO}
commit;
`;
  const recuperar = `-- PACOTE 150 — RECUPERAR (remove SÓ o índice e o registro da 150; nenhum dado é tocado). Gerado por kit150.mjs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $pre$ begin
  if to_regclass('public.${INDICE}') is null and not exists (select 1 from supabase_migrations.schema_migrations where name = '${NOME}') then
    raise exception '150: NADA_A_RECUPERAR' using errcode = '55000'; end if;
end $pre$;
-- ===== 150_rollback.sql (corpo, sem begin/commit) =====
${corpo(rb)}
delete from supabase_migrations.schema_migrations where name = '${NOME}';
do $pos$ begin
  if to_regclass('public.${INDICE}') is not null or exists (select 1 from supabase_migrations.schema_migrations where name = '${NOME}') then
    raise exception '150: recuperação incompleta — nada foi alterado' using errcode = '55000'; end if;
end $pos$;
commit;
`;
  const arquivos = { "aplicar_150.sql": aplicar, "recuperar_150.sql": recuperar, "leitura_150.sql": SQL_LEITURA };
  const sha = Object.fromEntries(Object.entries(arquivos).map(([n, t]) => [n, createHash("sha256").update(t).digest("hex")]));
  return { arquivos, sha };
}

/** Ensaio sem rastro: aplicar + validar + recuperar + confirmar a volta, tudo numa transação que termina em ROLLBACK. */
export function sqlEnsaio({ arquivos }) {
  const tirarTransacao = (s) => s.split("\n").filter((l) => !/^(begin|commit);$/.test(l)).join("\n");
  return `begin;
${tirarTransacao(arquivos["aplicar_150.sql"])}
select 'ENSAIO_APLICADO ' || (${VERIFICAR_INDICE})::text;
do $dup$ declare u uuid; c uuid; o uuid; begin
  select unidade_id, conexao_id, organizacao_id into u, c, o from public.foody_sync_execucoes limit 1;
  if u is null then raise notice 'ENSAIO_SEM_EXECUCOES (prova de unicidade só no ensaio local)'; return; end if;
  begin
    insert into public.foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
    values (o, u, c, current_date, now(), now() + interval '1 day', 'manual', 1);
    insert into public.foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
    values (o, u, c, current_date, now(), now() + interval '1 day', 'manual', 1);
    raise exception 'ENSAIO_FALHOU: duas EM_ANDAMENTO aceitas';
  exception when unique_violation then raise notice 'ENSAIO_UNICIDADE_OK (23505)';
  end;
end $dup$;
${tirarTransacao(arquivos["recuperar_150.sql"])}
select 'ENSAIO_RECUPERADO ' || (to_regclass('public.${INDICE}') is null)::text || ' ' ||
  (select count(*) from supabase_migrations.schema_migrations where name = '${NOME}')::text;
rollback;
`;
}

// ------------------------------------------------------------------ portões (puros)
export function avaliarPrevoo(p) {
  const e = [], avisos = [];
  if (p.identidade?.somente_leitura !== "on") e.push("sessão de pré-voo não está em somente leitura");
  if (p.identidade?.replica) e.push("conectado a uma réplica");
  if (!p.historico_existe) e.push("histórico supabase_migrations.schema_migrations ausente");
  if (JSON.stringify(p.anteriores_registradas) !== JSON.stringify(ANTERIORES)) e.push(`147–149 não estão todas registradas: ${JSON.stringify(p.anteriores_registradas)}`);
  if (p.registros_150 !== 0) e.push("150 já registrada");
  if ((p.numero_150_ocupado_por_outra ?? []).length) e.push(`número 150 ocupado: ${JSON.stringify(p.numero_150_ocupado_por_outra)}`);
  if (!p.tabela_execucoes) e.push("foody_sync_execucoes ausente");
  if (p.indice?.existe) e.push("índice da 150 já existe (estado parcial)");
  if (p.unidades_com_2_ou_mais !== 0) e.push(`${p.unidades_com_2_ou_mais} unidade(s) com 2+ execuções EM_ANDAMENTO — encerre-as antes (a 150 recusaria)`);
  if (p.locks_externos !== 0) e.push(`${p.locks_externos} lock(s) de outra sessão em foody_sync_execucoes — aguarde (coleta em curso?)`);
  if (p.em_andamento > 0) avisos.push(`${p.em_andamento} execução(ões) EM_ANDAMENTO (${p.em_andamento_mais_de_1h} com mais de 1 h): com ENABLED desligado devem ser órfãs; a próxima coleta as encerra como ABANDONADA`);
  return { falhas: e, avisos };
}

export function avaliarValidacao(p) {
  const e = [], i = p.indice ?? {};
  if (!i.existe) e.push("índice ausente");
  if (!i.unico) e.push("índice não é único");
  if (!i.valido) e.push("índice inválido/não pronto");
  if (i.tabela !== "foody_sync_execucoes") e.push(`índice na tabela errada: ${i.tabela}`);
  if (JSON.stringify(i.colunas) !== '["unidade_id"]') e.push(`colunas do índice: ${JSON.stringify(i.colunas)}`);
  if (!/status.*EM_ANDAMENTO/.test(i.predicado ?? "")) e.push(`predicado inesperado: ${i.predicado}`);
  if (p.registros_150 !== 1) e.push(`registros da 150 no histórico: ${p.registros_150}`);
  if (JSON.stringify(p.anteriores_registradas) !== JSON.stringify(ANTERIORES)) e.push("147–149 não estão todas registradas");
  return e;
}

// ------------------------------------------------------------------ execução
function psql(env, { arquivo, texto }) {
  const conn = env.FOODY_CONN;
  const r = spawnSync(env.FOODY_PSQL || env.PSQL || "psql", [conn, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", arquivo ?? "-"],
    { input: arquivo ? undefined : texto, encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8", ...(env.FOODY_ALVO === "local" ? { PGOPTIONS: "-c lc_messages=C" } : {}) }, timeout: 180_000 });
  const limpar = (s) => String(s ?? "").split(conn).join("<conexão>");
  return { ok: r.status === 0, saida: limpar(r.stdout).trim(), erro: limpar(r.stderr).trim() };
}
const estadoDe = (r) => { if (!r.ok) throw new Error(`leitura falhou: ${r.erro.slice(0, 400)}`); return JSON.parse(r.saida.split(/\r?\n/).filter((l) => l.startsWith("{")).pop()); };

export function executar(modo, env = process.env, log = console.log) {
  const kit = gerarPacote();
  if (modo === "pacote") {
    const dif = Object.entries(SHA_ESPERADO).filter(([n, s]) => kit.sha[n] !== s);
    log(JSON.stringify(kit.sha, null, 2));
    if (dif.length) throw new Error(`SHA-256 diverge do revisado: ${dif.map(([n]) => n).join(", ")}`);
    return { sha: kit.sha };
  }
  const travas = travasDeAlvo(env);
  if (travas.length) throw new Error(`alvo recusado: ${travas.join("; ")}`);
  const dif = Object.entries(SHA_ESPERADO).filter(([n, s]) => kit.sha[n] !== s);
  if (dif.length) throw new Error(`kit diverge do revisado (SHA-256): ${dif.map(([n]) => n).join(", ")}`);
  const evid = resolve(env.FOODY_EVIDENCIAS || join(tmpdir(), "evidencias-foody-150"), `${modo}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(evid, { recursive: true });
  for (const [n, t] of Object.entries(kit.arquivos)) writeFileSync(join(evid, n), t);
  const guardar = (n, x) => writeFileSync(join(evid, n), typeof x === "string" ? x : JSON.stringify(x, null, 2));
  const ler = () => estadoDe(psql(env, { arquivo: join(evid, "leitura_150.sql") }));

  if (modo === "prevoo") { const p = ler(); const g = avaliarPrevoo(p); guardar("prevoo.json", { p, ...g }); log(JSON.stringify(g)); return { estado: p, ...g }; }
  if (modo === "validar") { const p = ler(); const f = avaliarValidacao(p); guardar("validar.json", { p, falhas: f }); log(JSON.stringify({ falhas: f })); return { estado: p, falhas: f }; }
  if (modo === "ensaio") {
    if (env.FOODY_ALVO === "producao") throw new Error("ensaio é só para local/teste");
    const r = psql(env, { texto: sqlEnsaio(kit) }); guardar("ensaio.log", `${r.saida}\n${r.erro}`);
    if (!r.ok) throw new Error(`ensaio falhou: ${r.erro.slice(0, 400)}`);
    const depois = ler(); guardar("ensaio-depois.json", depois);
    return { saida: r.saida, avisos: r.erro, depois };
  }
  if (modo === "aplicar") {
    if (env.FOODY_AUTORIZO !== "SIM") throw new Error("aplicar exige FOODY_AUTORIZO=SIM");
    if (env.FOODY_ALVO !== "local" && env.FOODY_BACKUP_CONFIRMADO !== "SIM") throw new Error("aplicar exige FOODY_BACKUP_CONFIRMADO=SIM");
    const p = ler(); const g = avaliarPrevoo(p); guardar("prevoo.json", { p, ...g });
    if (g.falhas.length) throw new Error(`pré-voo reprovou (nada aplicado): ${g.falhas.join("; ")}`);
    const r = psql(env, { arquivo: join(evid, "aplicar_150.sql") }); guardar("aplicacao.log", `${r.saida}\n${r.erro}`);
    if (!r.ok) throw new Error(`aplicação falhou e foi desfeita: ${r.erro.slice(0, 400)}`);
    const pos = ler(); const f = avaliarValidacao(pos); guardar("validar.json", { p: pos, falhas: f });
    if (f.length) throw new Error(`APLICADO, mas a validação reprovou: ${f.join("; ")} — avalie recuperar`);
    if (JSON.stringify(pos.linhas) !== JSON.stringify(p.linhas)) throw new Error("contagem de linhas mudou durante a aplicação — investigue");
    log("150 APLICADA e validada"); return { antes: p, depois: pos };
  }
  if (modo === "recuperar") {
    if (env.FOODY_AUTORIZO !== "SIM") throw new Error("recuperar exige FOODY_AUTORIZO=SIM");
    const p = ler();
    const r = psql(env, { arquivo: join(evid, "recuperar_150.sql") }); guardar("recuperacao.log", `${r.saida}\n${r.erro}`);
    if (!r.ok) throw new Error(`recuperação falhou e foi desfeita: ${r.erro.slice(0, 400)}`);
    const pos = ler(); guardar("depois.json", pos);
    if (pos.indice?.existe || pos.registros_150 !== 0) throw new Error("recuperação incompleta");
    if (JSON.stringify(pos.linhas) !== JSON.stringify(p.linhas)) throw new Error("contagem de linhas mudou na recuperação — investigue");
    log("150 RECUPERADA (índice e registro removidos; dados intactos)"); return { antes: p, depois: pos };
  }
  throw new Error("modo: pacote | prevoo | aplicar | validar | recuperar | ensaio");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { executar(process.argv[2]); } catch (err) { console.error(err.message); process.exit(1); }
}
