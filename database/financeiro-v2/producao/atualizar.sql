-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql, 0028_leitor_mova.sql, 0029_pagamento_por_comprovante.sql, 0030_registrar_obrigacao_documental.sql, 0031_registrar_juros_no_pagamento.sql, 0032_prestar_sangria.sql, 0033_registrar_conta_parcelada.sql, 0034_operacoes_entre_empresas.sql
-- Novas: 0035_registrar_emprestimo.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 34 then raise exception 'FV2 atualização: % migrações registradas (esperado 34) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312'), ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e'), ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b'), ('0029_pagamento_por_comprovante.sql', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679'), ('0030_registrar_obrigacao_documental.sql', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09'), ('0031_registrar_juros_no_pagamento.sql', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b'), ('0032_prestar_sangria.sql', '144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8'), ('0033_registrar_conta_parcelada.sql', '6182191b1090739bf7ee2e1305a71ec347ad291bfbd8e80008b931844f63f7bc'), ('0034_operacoes_entre_empresas.sql', 'd2ee48024db6ec4f4163718a08b5306468673f9ac234af40663c3f5bc558ac92')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 34 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0035_registrar_emprestimo.sql (arquivo 3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0035: EMPRÉSTIMOS E FINANCIAMENTOS (principal) com ação ESTREITA — MOVA (27/11/2026)
-- =====================================================================================================================
-- Ação nova `financeiro_v2.registrar_emprestimo` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe). Ela NÃO grava nada
-- sozinha: é um COMPLEMENTO das ações estreitas que já existem e só amplia a CATEGORIA aceita por elas:
--   * `registrar_conta_parcelada` (0033): conta de empréstimo AINDA A PAGAR, em 1 a 24 parcelas, em aberto;
--   * `registrar_obrigacao` + `baixar_por_comprovante` (0030/0029): pagamento de empréstimo COMPROVADAMENTE realizado (conta e
--     pagamento por comprovante na mesma transação, quitada);
--   * a baixa de conta de empréstimo EXISTENTE por comprovante já é da `baixar_por_comprovante` (nenhuma regra de categoria).
-- A ampliação é UMA categoria: lançamento PATRIMONIAL `EMPRESTIMOS_E_FINANCIAMENTOS` ("Empréstimos e financiamentos (principal)",
-- fora da DRE). Distribuição de lucros, aportes/retiradas de sócios, operações entre empresas, valores de terceiros, títulos
-- anteriores, parcelamento tributário e qualquer outra patrimonial continuam RECUSADOS para as ações estreitas. Nenhuma política
-- de inclusão/alteração (RLS) é ampliada: sem a ação estreita de base, `registrar_emprestimo` não grava nada. Nada de
-- transferência, movimentação bancária, receita ou juros (encargo segue só pela 0031, na categoria oficial de juros e multas).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao",
  "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany",
  "financeiro_v2.registrar_emprestimo"]'::jsonb);

-- 2) Principal de empréstimo aceito pela forma estreita SÓ para quem tem a ação nova (e só nesta categoria).
create or replace function fv2_principal_de_emprestimo(natureza text, categoria text) returns boolean language sql stable as $$
  select natureza = 'PATRIMONIAL' and categoria = 'EMPRESTIMOS_E_FINANCIAMENTOS' and fv2_tem_acao(array['financeiro_v2.registrar_emprestimo'])
$$;

-- 3) A função das contas a pagar estreitas (0030/0033) com UMA cláusula a mais em cada forma; todo o resto é idêntico à 0033.
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  documental boolean := fv2_so_registra_obrigacao();
  parcelada boolean := fv2_so_registra_conta_parcelada();
begin
  if not documental and not parcelada then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    -- 27/11: PRESERVA a exceção da 0031 (encargo do pagamento por quem tem registrar_juros; forma conferida por
    -- fv2_juros_documental). A primeira versão desta migração a perdia e recusava toda despesa paga com juros/multa.
    if documental and new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new;
    end if;
    if new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: só se registra lançamento ativo nascido de conta a pagar.' using errcode = '42501';
    end if;
    if new.natureza = 'DESPESA' or (parcelada and new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO')
       or fv2_principal_de_emprestimo(new.natureza, new.categoria_codigo) then
      return new;
    end if;
    raise exception 'Financeiro v2: conta a pagar estreita só em categoria de DESPESA (ou compra de equipamentos, na relatada, ou principal de empréstimo com registrar_emprestimo).' using errcode = '42501';
  end if;
  -- fv2_obrigacao
  if new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar estreita nasce em aberto, sem repetição.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text then
    raise exception 'Financeiro v2: a conta a pagar estreita aponta para o lançamento criado com ela (mesma transação).' using errcode = '42501';
  end if;
  -- forma da 0030: uma parcela, valor igual ao do lançamento, natureza DESPESA (0035: ou principal de empréstimo com a ação nova)
  if documental and (new.parcela->>'total')::int = 1 and l.valor_centavos = new.valor_base_centavos
     and (l.natureza = 'DESPESA' or fv2_principal_de_emprestimo(l.natureza, l.categoria_codigo)) then
    return new;
  end if;
  -- forma da 0033: 1 a 24 parcelas do MESMO lançamento (a soma é conferida no fim da transação)
  if parcelada and (new.parcela->>'total')::int between 1 and 24 and (new.parcela->>'numero')::int between 1 and (new.parcela->>'total')::int
     and new.valor_base_centavos > 0 and new.valor_base_centavos <= l.valor_centavos and cardinality(new.documento_ids) = 0 then
    return new;
  end if;
  raise exception 'Financeiro v2: forma de conta a pagar não permitida para esta permissão estreita.' using errcode = '42501';
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0035_registrar_emprestimo.sql', '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509', '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509');

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
  if n <> 35 then raise exception 'FV2 pós: % migrações registradas (esperado 35)', n; end if;
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
