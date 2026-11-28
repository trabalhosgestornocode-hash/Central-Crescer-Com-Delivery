-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql, 0028_leitor_mova.sql, 0029_pagamento_por_comprovante.sql, 0030_registrar_obrigacao_documental.sql, 0031_registrar_juros_no_pagamento.sql, 0032_prestar_sangria.sql, 0033_registrar_conta_parcelada.sql, 0034_operacoes_entre_empresas.sql, 0035_registrar_emprestimo.sql
-- Novas: 0036_corrigir_conta_a_pagar.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 35 then raise exception 'FV2 atualização: % migrações registradas (esperado 35) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312'), ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e'), ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b'), ('0029_pagamento_por_comprovante.sql', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679'), ('0030_registrar_obrigacao_documental.sql', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09'), ('0031_registrar_juros_no_pagamento.sql', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b'), ('0032_prestar_sangria.sql', '144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8'), ('0033_registrar_conta_parcelada.sql', '6182191b1090739bf7ee2e1305a71ec347ad291bfbd8e80008b931844f63f7bc'), ('0034_operacoes_entre_empresas.sql', 'd2ee48024db6ec4f4163718a08b5306468673f9ac234af40663c3f5bc558ac92'), ('0035_registrar_emprestimo.sql', '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 35 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0036_corrigir_conta_a_pagar.sql (arquivo dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0036: CORREÇÃO CADASTRAL DE CONTA A PAGAR com ação ESTREITA — MOVA Operador Financeiro (28/11/2026)
--
-- Espelho de economico.corrigirContaAPagar. Ação nova `financeiro_v2.corrigir_conta_a_pagar` (MIGRAÇÃO RESTRITIVA: nenhuma
-- concessão existente a recebe). Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) altera numa conta a pagar
-- APENAS: fornecedor (contraparte_id), vencimento, descrição e, em `extras`, `observacao` e `formaPagamento`. E só quando:
--   * a conta está ABERTA, sem nenhum pagamento (liquidado 0);
--   * o lançamento da conta está ATIVO e é de DESPESA (ou PATRIMONIAL só em IMOBILIZADO). Empréstimo, parcelamento tributário,
--     operações entre empresas e qualquer outra patrimonial ficam FORA (têm proteções próprias);
--   * a competência da conta aceita a correção estreita (ABERTA ou FECHAMENTO_PRELIMINAR; com pendências ou homologada, nunca).
-- No lançamento, só a DESCRIÇÃO, e só quando TODAS as parcelas do grupo cumprem as mesmas condições. Valor, competência, categoria,
-- situação, parcelas e posição nunca mudam por esta ação. Pode incluir fornecedor novo (cadastro) e o histórico da correção.
--
-- Achado da auditoria (28/11): `extras` era coluna LIVRE na barreira de quem só baixa/vincula (0018/0031); essa identidade podia
-- reescrever `observacao`/`formaPagamento`. Agora quem só muda a POSIÇÃO não altera essas duas chaves.
-- Políticas ampliadas a partir da expressão ATUAL (pg_policy), sem reescrever as regras das migrações anteriores.
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
  "financeiro_v2.registrar_emprestimo", "financeiro_v2.corrigir_conta_a_pagar"]'::jsonb);

-- 2) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'using'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'check'),
      ('fv2_contraparte', 'fv2_contraparte_incluir', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case r.parte when 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0036: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case r.parte when 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.corrigir_conta_a_pagar');
  end loop;
end $$;

-- 3) Quem corrige SEM ação ampla.
create or replace function fv2_so_corrige_conta() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.corrigir_conta_a_pagar'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

-- A conta (e o seu grupo) aceita a correção estreita? Aberta, sem pagamento, lançamento ativo de despesa/imobilizado, competência editável.
create or replace function fv2_conta_corrigivel(p_org uuid, p_unidade uuid, p_obrigacao uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from fv2_obrigacao o join fv2_lancamento l on l.organizacao_id = o.organizacao_id and l.unidade_id = o.unidade_id and l.id = o.lancamento_id
     where o.organizacao_id = p_org and o.unidade_id = p_unidade and o.id = p_obrigacao
       and o.situacao = 'ABERTA' and o.liquidado_centavos = 0
       and l.situacao = 'ATIVO' and l.origem->>'tipo' = 'OBRIGACAO'
       and (l.natureza = 'DESPESA' or (l.natureza = 'PATRIMONIAL' and l.categoria_codigo = 'IMOBILIZADO'))
       and coalesce((select c.estado from fv2_competencia c where c.organizacao_id = o.organizacao_id and c.unidade_id = o.unidade_id and c.competencia = o.competencia), 'ABERTA')
           in ('ABERTA', 'FECHAMENTO_PRELIMINAR'))
$$;

-- 4) A forma da correção (conta): só as colunas cadastrais; em `extras`, só observacao/formaPagamento; conta elegível ANTES da mudança.
create or replace function fv2_correcao_de_conta() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'contraparte_id', 'vencimento', 'descricao', 'extras'];
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is not distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    return new;
  end if;
  -- Nenhum campo CADASTRAL mudou (baixa, vínculo, encargo, intercompany — mesmo quando a sessão da identidade enxerga TODAS as ações da
  -- concessão): não é correção; a forma dessas gravações é conferida pelas barreiras próprias delas (0018/0029/0031/0034), como antes.
  if old.contraparte_id is not distinct from new.contraparte_id and old.vencimento is not distinct from new.vencimento
     and old.descricao is not distinct from new.descricao
     and (coalesce(old.extras, '{}'::jsonb)->'observacao') is not distinct from (coalesce(new.extras, '{}'::jsonb)->'observacao')
     and (coalesce(old.extras, '{}'::jsonb)->'formaPagamento') is not distinct from (coalesce(new.extras, '{}'::jsonb)->'formaPagamento') then
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
     or (coalesce(old.extras, '{}'::jsonb) - array['observacao', 'formaPagamento']) is distinct from (coalesce(new.extras, '{}'::jsonb) - array['observacao', 'formaPagamento']) then
    raise exception 'Financeiro v2: a correção estreita muda só fornecedor, vencimento, descrição, observação e forma de pagamento.' using errcode = '42501';
  end if;
  if new.extras ? 'formaPagamento' and new.extras->>'formaPagamento' is not null
     and new.extras->>'formaPagamento' not in ('CARTAO', 'BOLETO', 'PIX', 'DINHEIRO', 'TRANSFERENCIA') then
    raise exception 'Financeiro v2: forma de pagamento inválida.' using errcode = '42501';
  end if;
  if not fv2_conta_corrigivel(old.organizacao_id, old.unidade_id, old.id) then
    raise exception 'Financeiro v2: só se corrige conta a pagar aberta, sem pagamento, de despesa (ou equipamento) e de período editável.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_obrigacao_correcao_estreita before update on fv2_obrigacao for each row execute function fv2_correcao_de_conta();

-- 5) A forma da correção (lançamento): só a descrição, e só com TODAS as parcelas do grupo elegíveis.
create or replace function fv2_correcao_de_lancamento() returns trigger language plpgsql as $$
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) then
    raise exception 'Financeiro v2: a correção estreita muda no lançamento só a descrição.' using errcode = '42501';
  end if;
  if old.origem->>'tipo' <> 'OBRIGACAO' or exists (
       select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
          and not fv2_conta_corrigivel(o.organizacao_id, o.unidade_id, o.id))
     or not exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id) then
    raise exception 'Financeiro v2: a descrição do lançamento só muda com todas as parcelas da conta abertas e sem pagamento.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_correcao_estreita before update on fv2_lancamento for each row execute function fv2_correcao_de_lancamento();

-- 6) Barreira da 0018/0031 (quem não tem ações amplas só muda a POSIÇÃO): a correção estreita passa (conferida no item 4) e,
--    na posição, `extras.observacao`/`extras.formaPagamento` deixam de ser livres (achado da auditoria).
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  -- 0036: correção cadastral estreita — ALGUM campo cadastral muda e nenhuma coluna de posição; fv2_correcao_de_conta confere que
  -- NADA além do cadastral mudou (competência, valor, situação… são recusados lá). Sem campo cadastral mudando, segue a barreira abaixo.
  if tg_table_name = 'fv2_obrigacao' and fv2_so_corrige_conta()
     and ((to_jsonb(old)->'contraparte_id') is distinct from (to_jsonb(new)->'contraparte_id') or (to_jsonb(old)->'vencimento') is distinct from (to_jsonb(new)->'vencimento')
       or (to_jsonb(old)->'descricao') is distinct from (to_jsonb(new)->'descricao')
       or (to_jsonb(old)->'extras'->'observacao') is distinct from (to_jsonb(new)->'extras'->'observacao')
       or (to_jsonb(old)->'extras'->'formaPagamento') is distinct from (to_jsonb(new)->'extras'->'formaPagamento'))
     and (to_jsonb(old)->>'liquidado_centavos') is not distinct from (to_jsonb(new)->>'liquidado_centavos')
     and (to_jsonb(old)->>'saldo_centavos') is not distinct from (to_jsonb(new)->>'saldo_centavos')
     and (to_jsonb(old)->>'ajustes_centavos') is not distinct from (to_jsonb(new)->>'ajustes_centavos')
     and (to_jsonb(old)->>'situacao') is not distinct from (to_jsonb(new)->>'situacao') then
    return new;
  end if;
  -- 0036: quem só muda a posição não reescreve a observação nem a forma de pagamento da conta
  if tg_table_name = 'fv2_obrigacao'
     and ((to_jsonb(old)->'extras'->'observacao') is distinct from (to_jsonb(new)->'extras'->'observacao')
       or (to_jsonb(old)->'extras'->'formaPagamento') is distinct from (to_jsonb(new)->'extras'->'formaPagamento')) then
    raise exception 'Financeiro v2: a baixa não altera a observação nem a forma de pagamento da conta.' using errcode = '42501';
  end if;
  if tg_table_name = 'fv2_obrigacao' and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint
       or (to_jsonb(new)->>'ajustes_centavos')::bigint < (to_jsonb(old)->>'ajustes_centavos')::bigint
       or new.situacao is distinct from old.situacao then
      raise exception 'Financeiro v2: o encargo só soma à conta o ajuste registrado com ele, sem reduzir nem mudar a situação.' using errcode = '42501';
    end if;
    livres := livres || array['ajustes_centavos', 'saldo_centavos'];
    so_encargo := true;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  if tg_table_name = 'fv2_obrigacao' and not so_encargo and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;

-- 7) Barreira de ações do lançamento (0014): IDÊNTICA, com `corrigir_conta_a_pagar` na lista de quem altera sem mudar a categoria.
--    O que essa ação pode mudar no lançamento (só a descrição, com todas as parcelas elegíveis) é conferido no item 5.
create or replace function fv2_exigir_acao_do_lancamento() returns trigger language plpgsql as $$
declare
  cat record;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if (new.categoria_id, new.categoria_codigo, new.classificacao, new.natureza)
       is not distinct from (old.categoria_id, old.categoria_codigo, old.classificacao, old.natureza) then
    -- Sem mudança de categoria: as ações de sempre (0036: + corrigir_conta_a_pagar, limitada à DESCRIÇÃO por fv2_correcao_de_lancamento). `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar']) then
      raise exception 'Financeiro v2: alterar o lançamento exige cancelar, corrigir ou revisar.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not fv2_tem_acao(array['financeiro_v2.reclassificar']) then
    raise exception 'Financeiro v2: mudar a categoria de um lançamento exige reclassificar.' using errcode = '42501';
  end if;
  if old.situacao <> 'ATIVO' then
    raise exception 'Financeiro v2: lançamento cancelado não é reclassificado.' using errcode = 'FV037';
  end if;
  if (new.valor_centavos, new.moeda, new.competencia, new.situacao, new.data_operacao, new.descricao, new.origem, new.canal,
      new.retido_no_repasse, new.fonte_sistema, new.fonte_id_externo)
       is distinct from (old.valor_centavos, old.moeda, old.competencia, old.situacao, old.data_operacao, old.descricao, old.origem, old.canal,
      old.retido_no_repasse, old.fonte_sistema, old.fonte_id_externo) then
    raise exception 'Financeiro v2: a reclassificação muda só a categoria — a identidade do fato econômico é preservada.' using errcode = 'FV037';
  end if;
  if not (new.natureza = old.natureza
          or (old.origem->>'tipo' = 'OBRIGACAO' and old.natureza in ('DESPESA', 'PATRIMONIAL') and new.natureza in ('DESPESA', 'PATRIMONIAL'))) then
    raise exception 'Financeiro v2: natureza econômica incompatível na reclassificação.' using errcode = 'FV038';
  end if;
  if new.categoria_codigo in ('DESCONTOS_A_CLASSIFICAR', 'DESPESAS_A_CLASSIFICAR') then
    raise exception 'Financeiro v2: categoria provisória não é destino de reclassificação.' using errcode = 'FV038';
  end if;
  select c.codigo, c.natureza, c.classificacao, c.aceita_lancamento, c.ativa into cat
    from fv2_categoria c where c.id = new.categoria_id and c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id;
  if cat.codigo is null or cat.codigo <> new.categoria_codigo or cat.natureza <> new.natureza or cat.classificacao <> new.classificacao
     or not cat.aceita_lancamento or not cat.ativa then
    raise exception 'Financeiro v2: a categoria de destino não confere com o plano de contas da unidade.' using errcode = 'FV038';
  end if;
  return new;
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0036_corrigir_conta_a_pagar.sql', 'dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a', 'dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a');

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
  if n <> 36 then raise exception 'FV2 pós: % migrações registradas (esperado 36)', n; end if;
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
