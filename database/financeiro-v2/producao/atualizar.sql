-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql
-- Novas: 0027_bloqueio_automacao_definer.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 26 then raise exception 'FV2 atualização: % migrações registradas (esperado 26) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 26 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0027_bloqueio_automacao_definer.sql (arquivo 957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0027: BLOQUEIO DA IDENTIDADE TÉCNICA independente de quem grava
--
-- Problema: o gatilho da 0026 consultava a sessão com os privilégios de quem gravava. Papéis sem acesso às sessões
-- (como o instalador) recebiam "permission denied" e não conseguiam criar a concessão técnica.
--
-- O que muda (e o que NÃO muda):
--   * A função do gatilho passa a rodar como fv2_guardiao, que já lê as sessões.
--   * Nenhum papel ganha acesso a fv2__sessao_vigente.
--   * A regra é a mesma: sessão da identidade técnica não altera as tabelas protegidas.
--   * Nenhum dado é alterado.
-- =====================================================================================================================

create or replace function fv2_bloquear_identidade_de_automacao() returns trigger
language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if (select usuario_id from fv2__sessao_vigente()) = '00000000-0000-4000-8000-00000000e7e9'::uuid then
    raise exception 'FV2: a identidade técnica de entregadores não pode alterar %', tg_table_name using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
alter function fv2_bloquear_identidade_de_automacao() owner to fv2_guardiao;
revoke all on function fv2_bloquear_identidade_de_automacao() from public, fv2_app, fv2_autoridade;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e');

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
  if n <> 27 then raise exception 'FV2 pós: % migrações registradas (esperado 27)', n; end if;
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
