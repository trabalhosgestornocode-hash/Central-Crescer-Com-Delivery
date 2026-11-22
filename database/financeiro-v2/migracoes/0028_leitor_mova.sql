-- =====================================================================================================================
-- Financeiro v2 — migração 0028: LEITOR DO MOVA (piloto de consultas pelo WhatsApp, Execução 16A)
--
-- O MOVA (assistente financeiro no WhatsApp) passa a LER o Financeiro v2 com uma credencial PRÓPRIA, que não escreve
-- nada. Três barreiras independentes:
--   1. Papel fv2_leitor_mova: só SELECT nas tabelas que a aplicação lê, e EXECUTE só nas funções de leitura.
--      Nenhum INSERT, UPDATE, DELETE ou TRUNCATE. Não emite sessão de outra pessoa (sem fv2_abrir_sessao).
--   2. fv2_abrir_sessao_mova: emite sessão SÓ para a identidade técnica do MOVA, SÓ na unidade onde ela tem concessão
--      ATIVA exatamente igual a ["financeiro_v2.ver"]. A sessão nasce com pode_escrever = false e vale 5 minutos.
--      RLS da sessão: só a organização e a unidade da sessão aparecem.
--   3. Gatilho em fv2_concessao: a identidade do MOVA nunca fica ATIVA com outra ação além de financeiro_v2.ver, mesmo
--      por engano de um administrador. Revogar continua sempre possível.
--
-- O que NÃO muda: nenhuma tabela, nenhum dado, nenhuma concessão existente e nenhum outro papel.
-- A credencial de LOGIN (papel com senha, membro de fv2_leitor_mova) é criada na implantação, fora desta migração.
-- =====================================================================================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_leitor_mova') then
    create role fv2_leitor_mova nologin;
  end if;
end $$;
grant usage on schema financeiro_v2 to fv2_leitor_mova;

-- 1. SELECT só onde a aplicação já lê (RLS e a sessão decidem as linhas).
do $$ declare t record; begin
  for t in select c.oid::regclass as tab from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'financeiro_v2' and c.relkind in ('r', 'p', 'v') and has_table_privilege('fv2_app', c.oid, 'SELECT') loop
    execute format('grant select on %s to fv2_leitor_mova', t.tab);
  end loop;
end $$;

-- EXECUTE: funções comuns (SECURITY INVOKER: rodam com os privilégios do leitor, que não escreve) e só três funções
-- SECURITY DEFINER de leitura, usadas pelas políticas. Nenhuma função que grava (concessão, liberação, sessão alheia).
do $$ declare f record; begin
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'financeiro_v2' and has_function_privilege('fv2_app', p.oid, 'EXECUTE')
              and (not p.prosecdef or p.oid in ('financeiro_v2.fv2__sessao_vigente()'::regprocedure,
                                                'financeiro_v2.fv2_tem_acao(text[])'::regprocedure,
                                                'financeiro_v2.fv2_liberacao_estado(uuid, uuid)'::regprocedure)) loop
    execute format('grant execute on function %s to fv2_leitor_mova', f.fn);
  end loop;
end $$;

-- 2. Sessão do MOVA: identidade fixa, concessão somente-leitura, sem escrita, 5 minutos.
create function fv2_abrir_sessao_mova(p_organizacao uuid, p_unidade uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  identidade constant uuid := '00000000-0000-4000-8000-00000000a0a0';
  acoes jsonb;
  token text := fv2__novo_token();
begin
  if p_organizacao is null or p_unidade is null then
    raise exception 'MOVA: sessão sem organização ou unidade.' using errcode = '22023';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV020';
  end if;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, false);
  select c.acoes into acoes from fv2_concessao c
   where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = identidade and c.situacao = 'ATIVA';
  if acoes is distinct from '["financeiro_v2.ver"]'::jsonb then
    raise exception 'MOVA: sem concessão somente-leitura ativa nesta unidade.' using errcode = 'FV020';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), identidade, p_organizacao, p_unidade, 'OPERACAO', false, 'automacao:mova',
          clock_timestamp() + interval '300 seconds');
  return token;
end $$;
alter function fv2_abrir_sessao_mova(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_abrir_sessao_mova(uuid, uuid) from public;
grant execute on function fv2_abrir_sessao_mova(uuid, uuid) to fv2_leitor_mova;

-- 3. A identidade do MOVA só pode ter financeiro_v2.ver (inclusive em concessões futuras).
create function fv2_mova_somente_leitura() returns trigger language plpgsql as $$
begin
  -- Só concessão ATIVA: revogar (ações vazias, situação diferente de ATIVA) continua sempre possível.
  if new.usuario_id = '00000000-0000-4000-8000-00000000a0a0'::uuid and new.situacao = 'ATIVA'
     and new.acoes is distinct from '["financeiro_v2.ver"]'::jsonb then
    raise exception 'FV2: a identidade do MOVA só pode ter financeiro_v2.ver.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_concessao_mova_somente_leitura before insert or update on fv2_concessao
  for each row execute function fv2_mova_somente_leitura();
revoke all on function fv2_mova_somente_leitura() from public;

