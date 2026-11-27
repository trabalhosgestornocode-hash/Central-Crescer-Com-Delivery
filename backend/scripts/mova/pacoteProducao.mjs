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
  "aprovacao", "auditoria", "aviso_diario", "core_conhecimento", "core_conhecimento_evento", "core_desafio_vinculo", "core_memoria_conversa", "core_proposta", "core_tentativa_vinculo", "core_vinculo", "automacao", "consumo_ia", "controle", "conversa_ativa", "decisao", "documento", "entregador_autorizado",
  "entregador_envio", "evento", "evidencia", "fila", "grupo_autorizado", "grupo_membros", "grupo_unidade", "instancia_gateway",
  "mensagem_pendente", "nota_entregador", "operacao_executada", "orcamento_ia", "orcamento_ia_alerta", "orcamento_ia_politica", "participante", "participante_autorizado",
  "politica_autonomia", "proposta", "resposta", "unidade_sem_grupo", "mova_migracao",
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
export const INSTALADAS_EM_PRODUCAO = Object.freeze(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015"]); // conferido em produção 24/11 (nome + sha256); 0015 entra pelo atualizar.sql
// ^ base HISTÓRICA dos aplicar-<NNNN>.sql já usados (0017, orçamento, propostas, sangria, multiempresa): não mudar, eles provam a ordem daquela época.
// 27/11 (PR #236) — base do atualizar.sql: produção conferida SOMENTE LEITURA em 27/11 (nome + sha256 iguais ao Git): 0001–0018, 0020, 0022–0024.
export const INSTALADAS_PARA_ATUALIZAR = Object.freeze([...INSTALADAS_EM_PRODUCAO, "0016", "0017", "0018", "0020", "0022", "0023", "0024"]);
/** Migrações ADIADAS por decisão (não entram no atualizar.sql até serem autorizadas). 0010 autorizada em 23/11 com a 0012 (PR #188). */
// 0019 (MOVA CORE: vínculo e memória) e 0021 (conhecimento corporativo F5): só no banco ISOLADO de homologação até autorização
// específica — nenhuma das duas está em produção (27/11) e a 0025 não depende delas.
export const ADIADAS_EM_PRODUCAO = Object.freeze(["0019", "0021"]);

/**
 * atualizar.sql: UMA transação; exige o schema mova com as migrações instaladas registradas com o MESMO sha256, aplica só as
 * novas e as registra. Aborta (sem mudar nada) se alguma nova já estiver registrada ou se o banco for o de homologação.
 */
export function gerarAtualizar(migracoes = listarMigracoes()) {
  const ja = migracoes.filter((m) => INSTALADAS_PARA_ATUALIZAR.includes(m.nome.slice(0, 4)));
  const novas = migracoes.filter((m) => !INSTALADAS_PARA_ATUALIZAR.includes(m.nome.slice(0, 4)) && !ADIADAS_EM_PRODUCAO.includes(m.nome.slice(0, 4)));
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

/**
 * aplicar-<NNNN>.sql: aplica UMA migração isolada (sem arrastar outras pendentes, ex.: a 0016 de avisos de entregadores). UMA
 * transação; exige o schema mova com as instaladas (nome + sha256), a migração ainda NÃO registrada e a tabela que ela altera.
 * Só para migrações aditivas e independentes das pendentes (0017: coluna nula em conversa_ativa).
 */
export function gerarAplicarUnica(prefixo, { tabelaExigida }, migracoes = listarMigracoes()) {
  const m = migracoes.find((x) => x.nome.startsWith(`${prefixo}_`));
  if (!m) throw new Error(`migração ${prefixo} inexistente`);
  const ja = migracoes.filter((x) => INSTALADAS_EM_PRODUCAO.includes(x.nome.slice(0, 4)));
  const conferir = ja.map((x) => `  if not exists (select 1 from mova.mova_migracao where nome = '${x.nome}' and sha256 = '${x.sha256}') then raise exception 'MOVA ${prefixo}: ${x.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  return `-- MOVA — APLICAÇÃO ISOLADA da ${m.nome} em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo. Não aplica nenhuma outra migração.
-- Exige as já instaladas (nome + sha256): ${ja.map((x) => x.nome.slice(0, 4)).join(", ")}.
-- Compatibilidade: o código ANTERIOR não referencia a coluna nova (INSERT/SELECT por lista de colunas) e continua funcionando.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA ${prefixo}: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA ${prefixo}: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${conferir.join("\n")}
  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA ${prefixo}: já aplicada — nada foi feito'; end if;
  if to_regclass('mova.${tabelaExigida}') is null then raise exception 'MOVA ${prefixo}: tabela mova.${tabelaExigida} não existe — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})
${m.sql.trimEnd()}
insert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');
`;
}

/** Migrações conferidas no banco do MOVA em PRODUÇÃO em 25/11/2026 (nome + sha256, leitura): 0001 a 0017. */
export const CONFERIDAS_EM_PRODUCAO_25_11 = Object.freeze(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017"]);
/**
 * aplicar-orcamento-renovavel.sql (25/11): SÓ o indispensável para o orçamento renovável — 0018 (política, colunas de
 * controle, alertas) e 0022 (parte guardada para documentos, chamadas de conversa por dia, tipo de uso). Não aplica 0019,
 * 0020 nem 0021. UMA transação; exige 0001–0017 com o mesmo sha256 e nenhuma das duas registrada. Não liga nada: a política
 * fica ativo = false; ligar é um passo separado (ver docs/mova-core/10-piloto-acai.md).
 */
export function gerarAplicarOrcamento(migracoes = listarMigracoes()) {
  const alvo = ["0018", "0022"].map((p) => { const m = migracoes.find((x) => x.nome.startsWith(`${p}_`)); if (!m) throw new Error(`migração ${p} inexistente`); return m; });
  const ja = migracoes.filter((x) => CONFERIDAS_EM_PRODUCAO_25_11.includes(x.nome.slice(0, 4)));
  const conferir = ja.map((x) => `  if not exists (select 1 from mova.mova_migracao where nome = '${x.nome}' and sha256 = '${x.sha256}') then raise exception 'MOVA orçamento: ${x.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  const naoAplicadas = alvo.map((m) => `  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA orçamento: ${m.nome} já aplicada — nada foi feito'; end if;`);
  return `-- MOVA — ORÇAMENTO RENOVÁVEL em PRODUÇÃO: aplica SÓ ${alvo.map((m) => m.nome).join(" + ")} (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Exige as já instaladas (nome + sha256): ${ja.map((x) => x.nome.slice(0, 4)).join(", ")}. Não liga o orçamento (política ativo = false).
-- Compatibilidade: o código anterior não lê nenhuma coluna ou tabela nova; o orçamento acumulado continua valendo até a chave.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA orçamento: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA orçamento: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${conferir.join("\n")}
${naoAplicadas.join("\n")}
end $$;
${alvo.map((m) => `
-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})
${m.sql.trimEnd()}
insert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');
`).join("")}`;
}

/** Estado do banco do MOVA em PRODUÇÃO depois do orçamento renovável (25/11): 0001–0018 + 0022. */
export const ESTADO_PRODUCAO_APOS_ORCAMENTO = Object.freeze([...CONFERIDAS_EM_PRODUCAO_25_11, "0018", "0022"]);
/**
 * aplicar-propostas-core.sql (25/11, PR #223): SÓ a 0020 (tabela de propostas do MOVA CORE). Aditiva e independente de
 * 0019/0021 (nenhuma delas é referenciada). UMA transação; exige 0001–0018 + 0022 com o mesmo sha256, a 0020 não registrada e
 * a tabela inexistente; confere no fim as permissões do papel da aplicação. Sem linhas, nada muda no comportamento.
 */
export function gerarAplicarPropostas(migracoes = listarMigracoes()) {
  const m = migracoes.find((x) => x.nome.startsWith("0020_"));
  if (!m) throw new Error("migração 0020 inexistente");
  const ja = migracoes.filter((x) => ESTADO_PRODUCAO_APOS_ORCAMENTO.includes(x.nome.slice(0, 4)));
  const conferir = ja.map((x) => `  if not exists (select 1 from mova.mova_migracao where nome = '${x.nome}' and sha256 = '${x.sha256}') then raise exception 'MOVA 0020: ${x.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  return `-- MOVA — PROPOSTAS DO MOVA CORE em PRODUÇÃO: aplica SÓ ${m.nome} (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo. Não aplica 0019 nem 0021.
-- Exige as já instaladas (nome + sha256): ${ja.map((x) => x.nome.slice(0, 4)).join(", ")}. Reversão: producao/reverter-propostas-core.sql.
-- Compatibilidade: o código anterior não lê a tabela; o código novo só a usa com MOVA_CORE_OPERACOES ligado.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA 0020: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA 0020: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${conferir.join("\n")}
  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA 0020: já aplicada — nada foi feito'; end if;
  if to_regclass('mova.core_proposta') is not null then raise exception 'MOVA 0020: mova.core_proposta já existe — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})
${m.sql.trimEnd()}
insert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');

do $$ begin
  if not (has_table_privilege('mova_app', 'mova.core_proposta', 'select') and has_table_privilege('mova_app', 'mova.core_proposta', 'insert') and has_table_privilege('mova_app', 'mova.core_proposta', 'update')) then
    raise exception 'MOVA 0020: mova_app sem permissão em mova.core_proposta — tudo desfeito'; end if;
  if has_table_privilege('mova_app', 'mova.core_proposta', 'delete') then raise exception 'MOVA 0020: mova_app não pode apagar propostas — tudo desfeito'; end if;
end $$;
`;
}

/**
 * reverter-propostas-core.sql: desfaz a aplicação acima no estado de PRODUÇÃO (0022 já aplicada, independente da 0020 — a
 * recuperacao/reverter-0020.sql genérica aborta por haver migração posterior). Aborta se houver qualquer migração fora de
 * 0001–0018, 0020 e 0022 (algo novo poderia depender da tabela) ou proposta EXECUTANDO.
 */
export function gerarReverterPropostas(migracoes = listarMigracoes()) {
  const m = migracoes.find((x) => x.nome.startsWith("0020_"));
  const permitidas = [...ESTADO_PRODUCAO_APOS_ORCAMENTO, "0020"].map((p) => `'${p}'`).join(", ");
  return `-- MOVA — REVERSÃO das propostas do MOVA CORE em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão). Uma transação.
-- Antes: MOVA_CORE_OPERACOES=DESLIGADO. As propostas não são dado financeiro (o Financeiro guarda o executado, com chave idempotente).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA reversão 0020: não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where left(nome, 4) not in (${permitidas})) then raise exception 'MOVA reversão 0020: há migração fora do estado conhecido — nada foi feito'; end if;
  if exists (select 1 from mova.core_proposta where estado = 'EXECUTANDO') then raise exception 'MOVA reversão 0020: há proposta EXECUTANDO — aguarde o desfecho'; end if;
end $$;
drop table mova.core_proposta;
delete from mova.mova_migracao where nome = '${m.nome}';
`;
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

/** Estado do banco do MOVA em PRODUÇÃO depois das propostas do MOVA CORE (25/11): 0001–0018, 0020 e 0022. */
export const ESTADO_PRODUCAO_APOS_PROPOSTAS = Object.freeze([...ESTADO_PRODUCAO_APOS_ORCAMENTO, "0020"]);
/**
 * aplicar-politica-sangria.sql (25/11): SÓ a 0023 (PRESTACAO_DE_SANGRIA nas listas fechadas de políticas e execuções). UMA
 * transação; exige 0001–0018, 0020 e 0022 com o mesmo sha256 e a 0023 não registrada. Não semeia política nenhuma.
 */
export function gerarAplicarPoliticaSangria(migracoes = listarMigracoes()) {
  const m = migracoes.find((x) => x.nome.startsWith("0023_"));
  if (!m) throw new Error("migração 0023 inexistente");
  const ja = migracoes.filter((x) => ESTADO_PRODUCAO_APOS_PROPOSTAS.includes(x.nome.slice(0, 4)));
  const conferir = ja.map((x) => `  if not exists (select 1 from mova.mova_migracao where nome = '${x.nome}' and sha256 = '${x.sha256}') then raise exception 'MOVA 0023: ${x.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  return `-- MOVA — POLÍTICA DE SANGRIA em PRODUÇÃO: aplica SÓ ${m.nome} (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Exige as já instaladas (nome + sha256): ${ja.map((x) => x.nome.slice(0, 4)).join(", ")}. Reversão: recuperacao/reverter-0023.sql.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA 0023: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA 0023: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${conferir.join("\n")}
  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA 0023: já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})
${m.sql.trimEnd()}
insert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');
`;
}

/** Estado do banco do MOVA em PRODUÇÃO depois da política de sangria (25/11): 0001–0018, 0020, 0022 e 0023. */
export const ESTADO_PRODUCAO_APOS_POLITICA_SANGRIA = Object.freeze([...ESTADO_PRODUCAO_APOS_PROPOSTAS, "0023"]);
/**
 * aplicar-grupo-multiempresa.sql (25/11): SÓ a 0024 (marca multiempresa no grupo; padrão false, nenhum grupo muda). UMA transação;
 * exige 0001–0018, 0020, 0022 e 0023 com o mesmo sha256 e a 0024 não registrada. Não marca grupo nenhum.
 */
export function gerarAplicarGrupoMultiempresa(migracoes = listarMigracoes()) {
  const m = migracoes.find((x) => x.nome.startsWith("0024_"));
  if (!m) throw new Error("migração 0024 inexistente");
  const ja = migracoes.filter((x) => ESTADO_PRODUCAO_APOS_POLITICA_SANGRIA.includes(x.nome.slice(0, 4)));
  const conferir = ja.map((x) => `  if not exists (select 1 from mova.mova_migracao where nome = '${x.nome}' and sha256 = '${x.sha256}') then raise exception 'MOVA 0024: ${x.nome} ausente ou com outro conteúdo — nada foi feito'; end if;`);
  return `-- MOVA — GRUPO MULTIEMPRESA em PRODUÇÃO: aplica SÓ ${m.nome} (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como \`postgres\` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Exige as já instaladas (nome + sha256): ${ja.map((x) => x.nome.slice(0, 4)).join(", ")}. Reversão: recuperacao/reverter-0024.sql.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA 0024: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\\_HOMOLOGACAO:%' then
    raise exception 'MOVA 0024: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
${conferir.join("\n")}
  if exists (select 1 from mova.mova_migracao where nome = '${m.nome}') then raise exception 'MOVA 0024: já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})
${m.sql.trimEnd()}
insert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');
`;
}

function principal() {
  const arquivos = { "instalar.sql": gerarInstalar(), "atualizar.sql": gerarAtualizar(), "inventario.sql": gerarInventario(), "aplicar-0017.sql": gerarAplicarUnica("0017", { tabelaExigida: "conversa_ativa" }), "aplicar-orcamento-renovavel.sql": gerarAplicarOrcamento(), "aplicar-propostas-core.sql": gerarAplicarPropostas(), "reverter-propostas-core.sql": gerarReverterPropostas(), "aplicar-politica-sangria.sql": gerarAplicarPoliticaSangria(), "aplicar-grupo-multiempresa.sql": gerarAplicarGrupoMultiempresa() };
  if (process.argv.includes("--conferir")) {
    const divergentes = Object.entries(arquivos).filter(([n, c]) => { try { return readFileSync(join(DESTINO, n), "utf8") !== c; } catch { return true; } }).map(([n]) => n);
    if (divergentes.length) { console.error(`pacote MOVA desatualizado: ${divergentes.join(", ")} — rode node scripts/mova/pacoteProducao.mjs`); process.exit(1); }
    console.log("pacote MOVA confere com as migrações"); return;
  }
  for (const [n, c] of Object.entries(arquivos)) writeFileSync(join(DESTINO, n), c);
  console.log(`gerados: ${Object.keys(arquivos).join(", ")}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) principal();
