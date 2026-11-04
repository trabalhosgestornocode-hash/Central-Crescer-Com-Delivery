// Trechos SQL COMPARTILHADOS pelo pacote de aplicação, pela recuperação, pelo pré-voo, pela pós-verificação e pelo diagnóstico
// da camada Foody (migrations 147, 148 e 149). Um único lugar para a lista de objetos e para as impressões (md5), para que a
// recuperação confira EXATAMENTE a mesma assinatura que a pós-verificação registrou.
//
// NUMERAÇÃO: em produção o número 144 já está registrado por `144_termo_v3_aprovado_internamente` (Termo v3, aplicado em
// 01/11/2026 a partir de docs/configuracoes-2-notificacoes/termo-v3-APROVAR-ANTES-DE-APLICAR.sql). Por isso a camada Foody, que
// nasceu como 144/145/146, foi renumerada para 147/148/149. Toda checagem do histórico é por NOME EXATO — nunca por número ou regex.

export const NOMES = ["147_foody_camada_central", "148_foody_conexao_compartilhada", "149_foody_conexao_administracao"];
export const ARQUIVOS = NOMES.map((n) => `${n}.sql`);
export const ROLLBACK_CAMADA = "147_rollback.sql";     // remove a camada INTEIRA (147 + 148 + 149); só roda depois das travas
export const REGISTRO_TERMO_V3 = "144_termo_v3_aprovado_internamente";

export const TABELAS = ["foody_conexoes", "foody_sync_execucoes", "foody_pedidos", "foody_fechamentos_logisticos",
  "foody_conexao_destinos", "foody_destinos_eventos", "foody_triagem_decisoes", "foody_conexoes_eventos"];

export const FUNCOES = [
  // 147
  "foody_validar_tenant", "foody_unidade_imutavel", "foody_validar_vinculo_execucao", "foody_validar_conexao_execucao",
  "foody_registro_imutavel", "foody_fechamento_registrar",
  // 148
  "foody_eh_admin_da_organizacao", "foody_destino_validar", "foody_conexao_revogar_destinos", "foody_destino_auditar",
  "foody_pedido_validar_destino", "foody_fech_exigir_destino_ativo", "foody_triagem_decisao_validar",
  // 149
  "foody_conexao_administrar", "foody_conexao_guardas", "foody_conexao_auditar_transferencia",
];
export const FUNCOES_SECURITY_DEFINER = ["foody_conexao_administrar", "foody_conexao_auditar_transferencia", "foody_destino_auditar",
  "foody_fechamento_registrar"];
export const FUNCOES_SERVICE_ROLE = ["foody_conexao_administrar", "foody_fechamento_registrar"];   // as únicas chamadas por /rpc

// Privilégios de TABELA esperados para service_role (sem DELETE em nenhuma) e colunas com UPDATE próprio.
export const PRIVILEGIOS_SERVICE_ROLE = {
  foody_conexoes: "SIU", foody_sync_execucoes: "SIU", foody_pedidos: "SIU", foody_fechamentos_logisticos: "S",
  foody_conexao_destinos: "SI", foody_destinos_eventos: "S", foody_triagem_decisoes: "SI", foody_conexoes_eventos: "S",
};
export const UPDATE_DE_COLUNA = {   // tabela sem UPDATE de tabela, mas com UPDATE nestas colunas (transferência de unidade)
  foody_fechamentos_logisticos: ["organizacao_id"], foody_destinos_eventos: ["organizacao_id"],
  foody_triagem_decisoes: ["organizacao_id"], foody_conexoes_eventos: ["organizacao_id"],
  foody_conexao_destinos: ["estado", "aprovado_titular_por", "aprovado_titular_em", "aprovado_destino_por", "aprovado_destino_em",
    "revogado_por", "revogado_em", "revogado_motivo", "organizacao_id", "atualizado_em"],
};

const lista = (xs) => xs.map((x) => `'${x}'`).join(", ");
export const SQL_TABELAS = lista(TABELAS);
export const SQL_FUNCOES = lista(FUNCOES);
export const SQL_NOMES = lista(NOMES);

// Relações/funções/gatilhos/restrições/tipos do escopo Foody (o que existir, esperado ou não).
export const SQL_OBJETOS_FOODY = `(
  select 'rel:' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like '%foody%'
  union all select 'fn:' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%foody%'
  union all select 'trg:' || t.tgname from pg_trigger t where t.tgname like '%foody%'
  union all select 'con:' || x.conname from pg_constraint x join pg_namespace n on n.oid = x.connamespace where n.nspname = 'public' and x.conname like '%foody%'
  union all select 'tipo:' || y.typname from pg_type y join pg_namespace n on n.oid = y.typnamespace where n.nspname = 'public' and y.typname like '%foody%' and y.typrelid = 0
)`;

// ASSINATURA do escopo Foody: estrutura completa (colunas, defaults, restrições, índices, gatilhos, funções, ACL, RLS, policies).
// A recuperação só roda se a assinatura atual for IGUAL à registrada pela pós-verificação da aplicação.
export const SQL_ASSINATURA_FOODY = `(select md5(coalesce(string_agg(x, E'\\n' order by x), '')) from (
  select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') x
    from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'foody\\_%'
  union all select 'con:' || c.relname || '.' || x.conname || ':' || pg_get_constraintdef(x.oid)
    from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'foody\\_%'
  union all select 'idx:' || i.relname || ':' || pg_get_indexdef(i.oid)
    from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class c on c.oid = ix.indrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like 'foody\\_%'
  union all select 'trg:' || c.relname || '.' || t.tgname || ':' || pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'foody\\_%' and not t.tgisinternal
  union all select 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(pg_get_functiondef(p.oid)) || ':' || p.prosecdef || ':' || coalesce(p.proacl::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'foody\\_%'
  union all select 'acl:' || c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'foody\\_%' and c.relkind = 'r'
  union all select 'colacl:' || c.relname || '.' || a.attname || ':' || a.attacl::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attacl is not null
   where n.nspname = 'public' and c.relname like 'foody\\_%'
  union all select 'pol:' || tablename || '.' || policyname from pg_policies where schemaname = 'public' and tablename like 'foody\\_%'
) z)`;

// IMPRESSÃO de tudo FORA do escopo Foody no schema public (estrutura, não dados). Antes = depois prova que a aplicação/recuperação
// não tocou Parser, Dashboard, Checklist, iFood, notificações nem nada além de foody_*.
const naoFoody = (col) => `${col} not like '%foody%'`;
export const SQL_IMPRESSAO_FORA = `jsonb_build_object(
  'colunas', (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable, ';' order by table_name, column_name))
                from information_schema.columns where table_schema = 'public' and ${naoFoody("table_name")}),
  'funcoes', (select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ';' order by p.proname, pg_get_function_identity_arguments(p.oid)))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p') and ${naoFoody("p.proname")}),
  'gatilhos', (select md5(string_agg(c.relname || '.' || t.tgname || ':' || pg_get_triggerdef(t.oid), ';' order by c.relname, t.tgname))
                from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal and ${naoFoody("c.relname")}),
  'restricoes', (select md5(string_agg(c.relname || '.' || x.conname || ':' || pg_get_constraintdef(x.oid), ';' order by c.relname, x.conname))
                from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and ${naoFoody("c.relname")}),
  'indices', (select md5(string_agg(pg_get_indexdef(i.oid), ';' order by i.relname))
                from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class c on c.oid = ix.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and ${naoFoody("c.relname")}),
  'politicas', (select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ';' order by tablename, policyname))
                from pg_policies where schemaname = 'public' and ${naoFoody("tablename")}),
  'acl_rls', (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ';' order by c.relname))
                from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') and ${naoFoody("c.relname")}),
  'n_tabelas', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and ${naoFoody("c.relname")}),
  'n_funcoes', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and ${naoFoody("p.proname")}))`;

// Linhas por tabela Foody (só contagem). Só pode ser usada quando as 8 tabelas existem (dinâmica, via query_to_xml).
export const SQL_CONTAGENS = `(select jsonb_object_agg(t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', t), false, true, '')))[1]::text::bigint)
  from unnest(array[${SQL_TABELAS}]) t where to_regclass('public.' || t) is not null)`;
