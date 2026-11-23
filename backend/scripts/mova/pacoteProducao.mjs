// MOVA — gera o PACOTE DE PRODUÇÃO do schema `mova` (database/mova-financeiro/producao/). Não conecta em banco nenhum.
//
//   node scripts/mova/pacoteProducao.mjs          (re)gera instalar.sql e inventario.sql
//   node scripts/mova/pacoteProducao.mjs --conferir  falha se os arquivos versionados não batem com as migrações
//
// instalar.sql: UMA transação (psql -1 / apply_migration), aditiva, com pré-condições que abortam antes de qualquer mudança:
//   schema mova inexistente; banco que NÃO é o de homologação do MOVA; nenhuma publicação FOR ALL TABLES; PostgreSQL 13+.
// Registra cada migração com o sha256 do arquivo (mova.mova_migracao) e confere objetos e permissões no fim (aborta se faltar).
// NÃO cria login nem senha e NÃO marca o schema: os dois passos são do operador, fora do repositório (ver LEIA-ME.md).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro");
const MIGRACOES = join(RAIZ, "migracoes");
const DESTINO = join(RAIZ, "producao");

export const TABELAS_ESPERADAS = Object.freeze([
  "aprovacao", "auditoria", "automacao", "consumo_ia", "controle", "conversa_ativa", "decisao", "documento", "entregador_autorizado",
  "entregador_envio", "evento", "evidencia", "fila", "grupo_autorizado", "grupo_membros", "grupo_unidade", "instancia_gateway",
  "mensagem_pendente", "nota_entregador", "operacao_executada", "orcamento_ia", "participante", "participante_autorizado",
  "politica_autonomia", "proposta", "resposta", "mova_migracao",
]);

export function listarMigracoes() {
  return readdirSync(MIGRACOES).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((nome) => {
    const sql = readFileSync(join(MIGRACOES, nome), "utf8");
    return { nome, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  });
}

export function gerarInstalar(migracoes = listarMigracoes()) {
  const partes = [];
  partes.push(`-- MOVA — INSTALAÇÃO do schema PRÓPRIO \`mova\` no banco de PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação (psql -v ON_ERROR_STOP=1 -1 -f instalar.sql). Qualquer falha desfaz tudo.
-- Aditivo: só cria o schema mova, o papel mova_app (sem login) e as tabelas do MOVA. Não toca em public nem no financeiro_v2.
-- Migrações: ${migracoes.map((m) => m.nome).join(", ")}

-- ===================================================================================== pré-condições (abortam)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA instalação: schema mova já existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA instalação: este é o banco de HOMOLOGAÇÃO do MOVA — a operação usa o banco de produção; nada foi feito';
  end if;
  if exists (select 1 from pg_publication where puballtables) then
    raise exception 'MOVA instalação: existe publicação FOR ALL TABLES (%) — as tabelas do MOVA entrariam na replicação; nada foi feito',
      (select string_agg(pubname, ', ') from pg_publication where puballtables);
  end if;
  if current_setting('server_version_num')::int < 130000 then raise exception 'MOVA instalação: PostgreSQL 13+ exigido'; end if;
end $$;
`);
  for (const m of migracoes) partes.push(`\n-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})\n${m.sql.trimEnd()}\n`);
  partes.push(`
-- ================================================================================ registro, isolamento e conferência
create table mova.mova_migracao (nome text primary key, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), aplicada_em timestamptz not null default now());
insert into mova.mova_migracao (nome, sha256) values
${migracoes.map((m) => `  ('${m.nome}', '${m.sha256}')`).join(",\n")};
grant select on mova.mova_migracao to mova_app;
revoke all on schema mova from public;
do $$ begin
  -- Supabase: o schema do MOVA nunca fica acessível aos papéis da API pública.
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema mova from anon'; execute 'revoke all on all tables in schema mova from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema mova from authenticated'; execute 'revoke all on all tables in schema mova from authenticated'; end if;
end $$;
do $$ declare faltando text; begin
  select string_agg(t, ', ') into faltando from unnest(array[${TABELAS_ESPERADAS.map((t) => `'${t}'`).join(", ")}]) t
   where not exists (select 1 from pg_tables where schemaname = 'mova' and tablename = t);
  if faltando is not null then raise exception 'MOVA instalação: tabelas ausentes: %', faltando; end if;
  -- Única exclusão permitida: mova.conversa_ativa (estado efêmero da conversa; 0005). Nada financeiro, nenhum histórico.
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'mova' and grantee = 'mova_app'
             and (privilege_type = 'TRUNCATE' or (privilege_type = 'DELETE' and table_name <> 'conversa_ativa'))) then
    raise exception 'MOVA instalação: mova_app só pode excluir de mova.conversa_ativa';
  end if;
  if (select rolcanlogin from pg_roles where rolname = 'mova_app') then raise exception 'MOVA instalação: mova_app não pode ter login'; end if;
end $$;
`);
  return partes.join("");
}

/** Migrações JÁ instaladas em produção (instalar.sql de 22/11/2026). As seguintes entram por atualizar.sql. */
export const INSTALADAS_EM_PRODUCAO = Object.freeze(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);

/**
 * atualizar.sql: UMA transação; exige o schema mova com as migrações instaladas registradas com o MESMO sha256, aplica só as
 * novas e as registra. Aborta (sem mudar nada) se alguma nova já estiver registrada ou se o banco for o de homologação.
 */
export function gerarAtualizar(migracoes = listarMigracoes()) {
  const ja = migracoes.filter((m) => INSTALADAS_EM_PRODUCAO.includes(m.nome.slice(0, 4)));
  const novas = migracoes.filter((m) => !INSTALADAS_EM_PRODUCAO.includes(m.nome.slice(0, 4)));
  const conferir = ja.map((m) => `  if not exists (select 1 from mova.mova_migracao where nome = '${m.nome}' and sha256 = '${m.sha256}') then raise exception 'MOVA atualização: ${m.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  const inedita = novas.map((m) => `  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA atualização: ${m.nome} já aplicada — nada foi feito'; end if;`);
  const partes = [`-- MOVA — ATUALIZAÇÃO do schema \`mova\` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): ${ja.map((m) => m.nome).join(", ")}
-- Novas: ${novas.map((m) => m.nome).join(", ") || "(nenhuma)"}

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA atualização: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA atualização: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${[...conferir, ...inedita].join("\n")}
end $$;
`];
  for (const m of novas) partes.push(`\n-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})\n${m.sql.trimEnd()}\ninsert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');\n`);
  return partes.join("");
}

export function gerarInventario() {
  return `-- MOVA — INVENTÁRIO SOMENTE LEITURA (gerado por backend/scripts/mova/pacoteProducao.mjs). Rodar ANTES e DEPOIS da instalação.
-- Não altera nada. Não lê conteúdo de mensagens: só existência, contagens, permissões e marcadores.
select 'banco' as item, current_database() as valor, shobj_description(d.oid, 'pg_database') as detalhe from pg_database d where d.datname = current_database()
union all select 'versao', current_setting('server_version'), null
union all select 'executor', current_user, (select case when rolsuper then 'superusuario' else 'comum' end from pg_roles where rolname = current_user)
union all select 'schema_mova', coalesce((select 'EXISTE' from pg_namespace where nspname = 'mova'), 'AUSENTE'), (select obj_description(oid, 'pg_namespace') from pg_namespace where nspname = 'mova')
union all select 'papel_mova_app', coalesce((select case when rolcanlogin then 'COM_LOGIN' else 'SEM_LOGIN' end from pg_roles where rolname = 'mova_app'), 'AUSENTE'), null
union all select 'logins_membros_de_mova_app', coalesce((select string_agg(r.rolname, ', ') from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where g.rolname = 'mova_app'), '(nenhum)'), null
union all select 'publicacoes_for_all_tables', coalesce((select string_agg(pubname, ', ') from pg_publication where puballtables), '(nenhuma)'), null
union all select 'tabelas_mova', (select count(*)::text from pg_tables where schemaname = 'mova'), null
union all select 'conexoes_ativas_no_banco', (select count(*)::text from pg_stat_activity where datname = current_database()), null
union all select 'migracao_em_curso', coalesce((select string_agg(left(query, 60), ' | ') from pg_stat_activity where datname = current_database() and state = 'active' and query ~* '(create|alter|drop) (table|schema|role)' and pid <> pg_backend_pid()), '(nenhuma)'), null;
-- Depois da instalação: select nome, sha256, aplicada_em from mova.mova_migracao order by nome;
`;
}

function principal() {
  const arquivos = { "instalar.sql": gerarInstalar(), "atualizar.sql": gerarAtualizar(), "inventario.sql": gerarInventario() };
  if (process.argv.includes("--conferir")) {
    const divergentes = Object.entries(arquivos).filter(([n, c]) => { try { return readFileSync(join(DESTINO, n), "utf8") !== c; } catch { return true; } }).map(([n]) => n);
    if (divergentes.length) { console.error(`pacote MOVA desatualizado: ${divergentes.join(", ")} — rode node scripts/mova/pacoteProducao.mjs`); process.exit(1); }
    console.log("pacote MOVA confere com as migrações"); return;
  }
  for (const [n, c] of Object.entries(arquivos)) writeFileSync(join(DESTINO, n), c);
  console.log(`gerados: ${Object.keys(arquivos).join(", ")}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) principal();
