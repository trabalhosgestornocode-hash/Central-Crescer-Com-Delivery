// SQL da MATRIZ DE ACESSO DIRETO (PostgREST) sobre o schema REAL — usado por perfil-exibicao-rls-schema-real-pg.test.js.
//
// Fixtures: 2 empresas (A: unidades A1 e A2; B: unidade B1), contas por papel e uma linha "semente" por tabela com
// `unidade_id`/`organizacao_id`, em CADA unidade (A1 e B1). `zz_medir()` roda com os privilégios de QUEM CHAMA
// (SECURITY INVOKER): mede o que aquele papel enxerga, altera e consegue inserir — exatamente o que a API REST permitiria.

export const IDS = {
  orgA: "a0000000-0000-4000-8000-00000000000a", orgB: "b0000000-0000-4000-8000-00000000000b",
  uniA1: "a1000000-0000-4000-8000-0000000000a1", uniA2: "a2000000-0000-4000-8000-0000000000a2", uniB1: "b1000000-0000-4000-8000-0000000000b1",
  tv: "11111111-1111-4111-8111-111111111111",          // conta da TV: SÓ vínculo de unidade A1 com display_operator
  viewerUni: "22222222-2222-4222-8222-222222222222",   // vínculo de UNIDADE A1 com papel viewer (referência: o RLS libera por vínculo)
  gestorOrg: "33333333-3333-4333-8333-333333333333",  // vínculo de EMPRESA A (unit_manager)
  financeOrg: "44444444-4444-4444-8444-444444444444", // vínculo de EMPRESA A (finance)
  herda: "55555555-5555-4555-8555-555555555555",       // unidade A1 com papel NULL (herda da empresa) + vínculo de empresa A (operations)
  estranho: "66666666-6666-4666-8666-666666666666",    // sem nenhum vínculo
  outraEmpresa: "77777777-7777-4777-8777-777777777777", // viewer na empresa B
};

/** Fixtures. `comTv=false` reproduz o banco de PRODUÇÃO atual: o valor display_operator ainda NÃO existe, então a conta da TV não é criada. */
export function fixturesSql({ comTv = true } = {}) {
  const contas = [comTv ? `'${IDS.tv}'` : null, `'${IDS.viewerUni}'`, `'${IDS.gestorOrg}'`, `'${IDS.financeOrg}'`, `'${IDS.herda}'`, `'${IDS.estranho}'`, `'${IDS.outraEmpresa}'`].filter(Boolean).join(",");
  return `
  insert into auth.users (id, email) select u, u::text || '@teste.invalid' from unnest(array[${contas}]::uuid[]) u;
  insert into perfis (id, nome) select u, 'conta-' || left(u::text, 4) from unnest(array[${contas}]::uuid[]) u;
  insert into perfis_operacionais (id, conta_id, nome) select u, u, 'perfil-' || left(u::text, 4) from unnest(array[${contas}]::uuid[]) u;
  insert into organizacoes (id, nome) values ('${IDS.orgA}', 'Empresa A'), ('${IDS.orgB}', 'Empresa B');
  insert into unidades (id, organizacao_id, nome) values ('${IDS.uniA1}', '${IDS.orgA}', 'A1'), ('${IDS.uniA2}', '${IDS.orgA}', 'A2'), ('${IDS.uniB1}', '${IDS.orgB}', 'B1');
  insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values
    ${comTv ? `('${IDS.tv}', '${IDS.tv}', '${IDS.uniA1}', 'display_operator'),` : ""}
    ('${IDS.viewerUni}', '${IDS.viewerUni}', '${IDS.uniA1}', 'viewer'),
    ('${IDS.herda}', '${IDS.herda}', '${IDS.uniA1}', null);
  insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values
    ('${IDS.gestorOrg}', '${IDS.gestorOrg}', '${IDS.orgA}', 'unit_manager'),
    ('${IDS.financeOrg}', '${IDS.financeOrg}', '${IDS.orgA}', 'finance'),
    ('${IDS.herda}', '${IDS.herda}', '${IDS.orgA}', 'operations'),
    ('${IDS.outraEmpresa}', '${IDS.outraEmpresa}', '${IDS.orgB}', 'viewer');`;
}
export const FIXTURES = fixturesSql();

/** Semeia 1 linha por unidade (A1 e B1) em toda tabela com unidade_id/organizacao_id. Roda como dono (ignora RLS) e sem FKs/triggers. */
/** Só para SEMEAR (banco descartável): remove os CHECKs de public para qualquer tabela aceitar a linha-semente. Não afeta RLS/grants. */
export const SEM_CHECKS = `
  do $$ declare r record; begin
    for r in select c.conrelid::regclass::text as t, c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and c.contype = 'c' loop
      execute format('alter table %s drop constraint %I', r.t, r.conname);
    end loop;
  end $$;`;

export const SEMEADOR = `
  create table zz_semeadas (tabela text primary key, coluna text not null, motivo_falha text);
  create table zz_probe (tabela text not null, unidade uuid not null, linha jsonb not null);
  create function zz_valor(tipo text, udt text, col text, unidade uuid, org uuid) returns text language plpgsql as $f$
  declare rot text;
  begin
    if col = 'unidade_id' then return quote_literal(unidade) || '::uuid'; end if;
    if col = 'organizacao_id' then return quote_literal(org) || '::uuid'; end if;
    if tipo = 'uuid' then return 'gen_random_uuid()'; end if;
    if tipo in ('text','character varying','character') then return '(''x'' || gen_random_uuid()::text)'; end if;
    if tipo in ('integer','bigint','smallint','numeric','double precision','real') then return '0'; end if;
    if tipo = 'boolean' then return 'false'; end if;
    if tipo = 'date' then return 'current_date'; end if;
    if tipo like 'timestamp%' then return 'now()'; end if;
    if tipo in ('jsonb','json') then return '''{}''::' || tipo; end if;
    if tipo = 'ARRAY' then return '''{}'''; end if;
    if tipo = 'bytea' then return '''''::bytea'; end if;
    if tipo = 'USER-DEFINED' then
      select e.enumlabel into rot from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = udt order by e.enumsortorder limit 1;
      return quote_literal(rot) || '::' || quote_ident(udt);
    end if;
    return 'null';
  end $f$;
  create function zz_semear() returns void language plpgsql as $f$
  declare t record; c record; cols text; vals text; u record; col text;
  begin
    set session_replication_role = replica;
    for t in select cl.relname from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
             where n.nspname = 'public' and cl.relkind = 'r' and cl.relname not like 'zz\_%'
               and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=cl.relname and k.column_name in ('unidade_id','organizacao_id'))
               and cl.relname not in ('unidades','organizacoes','usuarios_unidades','usuarios_organizacoes','perfis','perfis_operacionais','sessoes_contexto','unidade_config')
             order by 1 loop
      col := case when exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=t.relname and k.column_name='unidade_id') then 'unidade_id' else 'organizacao_id' end;
      begin
        for u in select * from (values ('${IDS.uniA1}'::uuid, '${IDS.orgA}'::uuid), ('${IDS.uniB1}'::uuid, '${IDS.orgB}'::uuid)) v(unid, org) loop
          cols := ''; vals := '';
          for c in select column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity from information_schema.columns
                   where table_schema='public' and table_name=t.relname order by ordinal_position loop
            continue when c.is_generated = 'ALWAYS' or c.is_identity = 'YES';
            continue when (c.is_nullable = 'YES' or c.column_default is not null) and c.column_name not in ('unidade_id','organizacao_id');
            cols := cols || case when cols = '' then '' else ',' end || quote_ident(c.column_name);
            vals := vals || case when vals = '' then '' else ',' end || zz_valor(c.data_type, c.udt_name, c.column_name, u.unid, u.org);
          end loop;
          if cols = '' then execute format('insert into %I default values', t.relname);
          else execute format('insert into %I (%s) values (%s)', t.relname, cols, vals); end if;
          execute format('insert into zz_probe select %L, %L::uuid, to_jsonb(r) from %I r where r.%I = %L::uuid limit 1', t.relname, u.unid, t.relname, col, case when col = 'unidade_id' then u.unid else u.org end);
        end loop;
        insert into zz_semeadas values (t.relname, col, null);
      exception when others then
        insert into zz_semeadas values (t.relname, col, sqlerrm) on conflict (tabela) do update set motivo_falha = excluded.motivo_falha;
      end;
    end loop;
    reset session_replication_role;
  end $f$;`;

/** Mede, COMO QUEM CHAMA (invoker): linhas visíveis por unidade, linhas alteráveis, se um INSERT de linha nova passa. */
export const MEDIDOR = `
  create function zz_medir() returns table (tabela text, a1 int, b1 int, alteraveis int, insere text, erro text) language plpgsql as $f$
  declare s record; p record; n_a int; n_b int; n_upd int; ok text; st text; filtro_a text; filtro_b text; ins jsonb; nova jsonb; tem_id boolean;
  begin
    for s in select * from zz_semeadas where motivo_falha is null order by tabela loop
      begin
        execute format('select count(*) from %I where %I = %L::uuid', s.tabela, s.coluna, case when s.coluna='unidade_id' then '${IDS.uniA1}' else '${IDS.orgA}' end) into n_a;
        execute format('select count(*) from %I where %I = %L::uuid', s.tabela, s.coluna, case when s.coluna='unidade_id' then '${IDS.uniB1}' else '${IDS.orgB}' end) into n_b;
      exception when others then n_a := -1; n_b := -1; end;
      n_upd := 0;
      begin
        execute format('update %I set %I = %I', s.tabela, s.coluna, s.coluna); get diagnostics n_upd = row_count;
      exception when others then n_upd := -1; end;
      ok := 'sem-linha-teste'; st := null;
      select linha into ins from zz_probe where zz_probe.tabela = s.tabela and unidade = '${IDS.uniA1}' limit 1;
      if ins is not null then
        tem_id := (ins ? 'id') and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=s.tabela and k.column_name='id' and k.data_type='uuid');
        nova := case when tem_id then ins || jsonb_build_object('id', gen_random_uuid()) else ins end;
        begin
          execute format('insert into %I select (jsonb_populate_record(null::%I, %L::jsonb)).*', s.tabela, s.tabela, nova::text);
          raise exception using errcode = 'ZZ001', message = 'desfaz';
        exception when others then st := SQLSTATE; ok := case SQLSTATE when 'ZZ001' then 'permitido' when '42501' then 'negado' else 'indeterminado:' || SQLSTATE end; end;
      end if;
      tabela := s.tabela; a1 := n_a; b1 := n_b; alteraveis := n_upd; insere := ok; erro := null;
      return next;
    end loop;
  end $f$;
  grant execute on function zz_medir() to anon, authenticated, service_role;
  grant select on zz_semeadas, zz_probe to anon, authenticated, service_role;`;
