-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql
-- Novas: 0028_leitor_mova.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 27 then raise exception 'FV2 atualização: % migrações registradas (esperado 27) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312'), ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 27 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0028_leitor_mova.sql (arquivo 760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
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
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b');

do $$ declare f record; begin
  -- A5 (auditoria A-1): nenhuma função do módulo fica executável por PUBLIC (o padrão do PostgreSQL). Quem tinha o
  -- EXECUTE de PUBLIC passa a ter EXECUTE só para os três papéis do módulo; as funções protegidas já sem PUBLIC ficam
  -- exatamente como as migrações deixaram.
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'financeiro_v2' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') loop
    execute format('grant execute on function %s to fv2_app, fv2_autoridade, fv2_guardiao', f.fn);
    execute format('revoke execute on function %s from public', f.fn);
  end loop;
end $$;
grant fv2_guardiao to current_user;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema financeiro_v2 from %I', r);
      execute format('revoke all on all sequences in schema financeiro_v2 from %I', r);
      execute format('revoke all on all functions in schema financeiro_v2 from %I', r);
    end if;
  end loop;
end $$;
revoke fv2_guardiao from current_user;
do $$ declare n int; txt text; begin
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 28 then raise exception 'FV2 pós: % migrações registradas (esperado 28)', n; end if;
  select string_agg(c.relname, ', ') into txt from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'financeiro_v2' and c.relkind = 'r' and c.relname <> 'fv2_migracao'
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
    where s.nspname = 'financeiro_v2' and c.relkind in ('r','p','v','m','S') and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator'));
  if n > 0 then raise exception 'FV2 pós: % privilégio(s) de PUBLIC ou credencial comum em tabela do schema', n; end if;
  select count(*) into n from pg_publication_tables where schemaname = 'financeiro_v2';
  if n > 0 then raise exception 'FV2 pós: % tabela(s) do v2 em publicação de replicação', n; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname <> 'financeiro_v2' and s.nspname not like 'pg\_%' and c.relname like 'fv2\_%';
  if n > 0 then raise exception 'FV2 pós: % relações fv2_* fora do schema', n; end if;
end $$;
