-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql, 0028_leitor_mova.sql, 0029_pagamento_por_comprovante.sql, 0030_registrar_obrigacao_documental.sql, 0031_registrar_juros_no_pagamento.sql
-- Novas: 0032_prestar_sangria.sql, 0033_registrar_conta_parcelada.sql, 0034_operacoes_entre_empresas.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 31 then raise exception 'FV2 atualização: % migrações registradas (esperado 31) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312'), ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e'), ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b'), ('0029_pagamento_por_comprovante.sql', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679'), ('0030_registrar_obrigacao_documental.sql', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09'), ('0031_registrar_juros_no_pagamento.sql', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 31 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0032_prestar_sangria.sql (arquivo 144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0032: PRESTAÇÃO DE CONTAS DA SANGRIA com ação ESTREITA — MOVA CORE (25/11/2026)
--
-- Espelho de aplicacao/prestacaoDeSangria.js. Ação nova `financeiro_v2.prestar_sangria` (MIGRAÇÃO RESTRITIVA: nenhuma
-- concessão existente a recebe). Quem a tem SEM ação ampla (registrar/aplicar/corrigir/cancelar/conciliar/revisar) grava SÓ:
--   * DESPESA paga com o dinheiro de uma sangria EXISTENTE: um lançamento de DESPESA + a conta de UMA parcela criados juntos e
--     a liquidação dessa conta CONTRA A PRÓPRIA SAÍDA DA SANGRIA (saída do caixa físico registrada como SANGRIA numa sessão);
--   * TROCO devolvido: UMA entrada (natureza OUTRA) no caixa físico e a operação ENTRADA acrescentada à sessão de caixa;
--   * a posição da sangria (alocado e o registro da prestação em `extras.prestacaoSangria`) e a da conta (pago/saldo/situação);
--   * a contraparte nova do formulário, o histórico e o vínculo documental dessa operação.
-- Nada de pagamento, transferência, saída nova, receita, alteração de outra movimentação/conta/sessão ou de outros campos.
-- Políticas AMPLIADAS a partir da expressão atual (pg_policy). Reversão: recuperacao/reverter-0032.sql.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria"]'::jsonb);

-- 2) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir', 'check'),
      ('fv2_contraparte', 'fv2_contraparte_incluir', 'check'),
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check'),
      ('fv2_movimentacao', 'fv2_movimentacao_incluir', 'check'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'using'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_sessao_caixa', 'fv2_sessao_caixa_alterar', 'using'),
      ('fv2_sessao_caixa', 'fv2_sessao_caixa_alterar', 'check'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case when r.parte = 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0032: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case when r.parte = 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.prestar_sangria');
  end loop;
end $$;

-- 3) Quem SÓ presta contas de sangria (sem ação ampla): o banco confere a forma de tudo o que é gravado.
create or replace function fv2_so_presta_sangria() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.prestar_sangria'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.revisar'])
$$;

-- Saída do caixa físico registrada como SANGRIA numa sessão de caixa da unidade.
create or replace function fv2_e_saida_de_sangria(p_org uuid, p_uni uuid, p_mov uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from fv2_movimentacao m join fv2_conta c on c.organizacao_id = m.organizacao_id and c.unidade_id = m.unidade_id and c.id = m.conta_id
     where m.organizacao_id = p_org and m.unidade_id = p_uni and m.id = p_mov
       and m.sentido = 'SAIDA' and c.tipo = 'CAIXA_FISICO' and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null
       and exists (select 1 from fv2_sessao_caixa s, jsonb_array_elements(s.operacoes) o
                    where s.organizacao_id = p_org and s.unidade_id = p_uni and s.conta_id = m.conta_id
                      and o->>'operacao' = 'SANGRIA' and o->>'movimentacaoId' = p_mov::text))
$$;

create or replace function fv2_prestacao_de_sangria() returns trigger language plpgsql as $$
declare
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  l record;
  o record;
  tipo_conta text;
  ultima jsonb;
begin
  if not fv2_so_presta_sangria() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: na prestação de sangria só se registra lançamento de DESPESA nascido da conta paga com a retirada.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_obrigacao' then
    if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
      raise exception 'Financeiro v2: a despesa da sangria tem uma parcela, sem repetição, e nasce em aberto.' using errcode = '42501';
    end if;
    select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
    if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
      raise exception 'Financeiro v2: a despesa da sangria aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_liquidacao' then
    if new.movimentacao_id is null or new.alvo_tipo <> 'OBRIGACAO' or not fv2_e_saida_de_sangria(new.organizacao_id, new.unidade_id, new.movimentacao_id) then
      raise exception 'Financeiro v2: na prestação de sangria a conta é liquidada só contra a PRÓPRIA saída da sangria.' using errcode = '42501';
    end if;
    select x.xmin::text as criado_em_xid into o from fv2_obrigacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
    if not found or o.criado_em_xid <> xid_atual then
      raise exception 'Financeiro v2: a sangria só paga a despesa registrada na mesma operação (nunca uma conta existente).' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_movimentacao' then
    if tg_op = 'INSERT' then
      select c.tipo into tipo_conta from fv2_conta c where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.id = new.conta_id;
      if new.sentido <> 'ENTRADA' or new.natureza <> 'OUTRA' or tipo_conta is distinct from 'CAIXA_FISICO' or new.valor_centavos <= 0
         or new.transferencia_id is not null or new.pagamento_id is not null or new.estorno_id is not null or new.alocado_centavos <> 0 then
        raise exception 'Financeiro v2: na prestação de sangria só entra o TROCO devolvido ao caixa físico.' using errcode = '42501';
      end if;
      return new;
    end if;
    -- UPDATE: só a própria saída da sangria, só a posição e o registro da prestação
    if not fv2_e_saida_de_sangria(old.organizacao_id, old.unidade_id, old.id)
       or (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'alocado_centavos']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'alocado_centavos'])
       or (coalesce(old.extras, '{}'::jsonb) - 'prestacaoSangria') is distinct from (coalesce(new.extras, '{}'::jsonb) - 'prestacaoSangria')
       or new.alocado_centavos < old.alocado_centavos then
      raise exception 'Financeiro v2: a prestação de sangria só atualiza a posição da própria retirada.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_sessao_caixa' then
    -- só acrescenta UMA operação ENTRADA (o troco) ligada a uma entrada criada nesta mesma transação; nada mais muda
    if jsonb_array_length(new.operacoes) <> jsonb_array_length(old.operacoes) + 1
       or (new.operacoes - (jsonb_array_length(new.operacoes) - 1)) is distinct from old.operacoes
       or (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'operacoes']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'operacoes']) then
      raise exception 'Financeiro v2: a prestação de sangria só acrescenta o troco à sessão de caixa.' using errcode = '42501';
    end if;
    ultima := new.operacoes -> (jsonb_array_length(new.operacoes) - 1);
    if ultima->>'operacao' <> 'ENTRADA' or not exists (
         select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id and m.id::text = ultima->>'movimentacaoId'
            and m.conta_id = new.conta_id and m.sentido = 'ENTRADA' and m.xmin::text = xid_atual) then
      raise exception 'Financeiro v2: o troco acrescentado à sessão precisa ser a entrada registrada nesta operação.' using errcode = '42501';
    end if;
    return new;
  end if;
  return new;
end $$;
create trigger fv2_lancamento_sangria before insert on fv2_lancamento for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_obrigacao_sangria before insert on fv2_obrigacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_liquidacao_sangria before insert on fv2_liquidacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_movimentacao_sangria before insert or update on fv2_movimentacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_sessao_caixa_sangria before update on fv2_sessao_caixa for each row execute function fv2_prestacao_de_sangria();

-- 4) Pagamento por comprovante (0029): quem só baixa por comprovante continua sem gravar liquidação com saída bancária; a
--    liquidação contra a saída da SANGRIA é a exceção de quem tem `prestar_sangria` (forma conferida pelo gatilho acima).
create or replace function fv2_pagamento_por_comprovante() returns trigger language plpgsql as $$
declare
  tipo_doc text;
  m record;
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'movimentacao_id'];
  so_documental boolean;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  so_documental := not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.cancelar']);
  if tg_op = 'INSERT' then
    if new.movimentacao_id is not null then
      if so_documental and not fv2_so_presta_sangria() then
        raise exception 'Financeiro v2: quem só baixa por comprovante não grava liquidação com saída bancária.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE' then
      raise exception 'Financeiro v2: liquidação sem saída bancária só para pagamento de conta por comprovante.' using errcode = '42501';
    end if;
    select d.tipo into tipo_doc from fv2_documento d
     where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
    if tipo_doc is distinct from 'COMPROVANTE' then
      raise exception 'Financeiro v2: pagamento sem extrato exige um documento COMPROVANTE desta unidade.' using errcode = '42501';
    end if;
    if new.data_efetiva > current_date + 1 then
      raise exception 'Financeiro v2: pagamento por comprovante não pode ter data futura (agendamento não é pagamento).' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'Financeiro v2: a saída de uma liquidação não se troca.' using errcode = '42501';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
       or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE'
       or (old.extras->'documentoId') is distinct from (new.extras->'documentoId') then
      raise exception 'Financeiro v2: conciliar o pagamento por comprovante só liga a saída do extrato (nada mais muda).' using errcode = '42501';
    end if;
    select x.* into m from fv2_movimentacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
       or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA')
       or m.valor_centavos <> new.valor_centavos - new.estornado_centavos then
      raise exception 'Financeiro v2: a conciliação exige saída válida do extrato com o valor do pagamento.' using errcode = '42501';
    end if;
    return new;
  end if;
  if fv2_so_vincula() and (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    raise exception 'Financeiro v2: sem permissão para alterar esta liquidação além da conciliação.' using errcode = '42501';
  end if;
  return new;
end $$;

-- 5) Vínculo de extrato (0018): quem só vincula continua sem liquidar fora do extrato; a liquidação contra a saída da SANGRIA é a
--    exceção de quem só presta contas de sangria (forma conferida pelo gatilho do item 3).
create or replace function fv2_vinculo_extrato_liquidacao() returns trigger language plpgsql as $$
declare
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if new.movimentacao_id is null then
    return new; -- pagamento por comprovante (0029)
  end if;
  if fv2_so_presta_sangria() and fv2_e_saida_de_sangria(new.organizacao_id, new.unidade_id, new.movimentacao_id) then
    return new; -- prestação de contas da sangria (0032): forma conferida por fv2_prestacao_de_sangria
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' then
    raise exception 'Financeiro v2: vincular pagamento do extrato só baixa conta a pagar.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criada_em_xid into m from fv2_movimentacao x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
  if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
     or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA') then
    raise exception 'Financeiro v2: a baixa por extrato exige uma saída válida, que não seja transferência nem devolução.' using errcode = '42501';
  end if;
  if m.criada_em_xid = xid_atual then
    raise exception 'Financeiro v2: vincular pagamento do extrato usa saída JÁ registrada — não cria saída nova.' using errcode = '42501';
  end if;
  if coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    raise exception 'Financeiro v2: liquidação gravada por vincular_pagamento precisa ser marcada como vínculo de extrato.' using errcode = '42501';
  end if;
  if new.extras->>'documentoId' is null and not exists (
    select 1 from fv2_correspondencia c
     where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.situacao = 'CONFIRMADA'
       and cardinality(c.evidencia_documento_ids) > 0
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'MOVIMENTACAO', 'id', new.movimentacao_id::text))
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'OBRIGACAO', 'id', new.alvo_id::text))) then
    raise exception 'Financeiro v2: a baixa por extrato exige documento que comprove o pagamento ou conciliação confirmada com evidência.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0032_prestar_sangria.sql', '144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8', '144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8');

-- ------------------------------------------------------------------------- 0033_registrar_conta_parcelada.sql (arquivo 18094440f9d94cc0057c1cb2cb4c3ff603e6feb3038aa93198b242d5f0b3f5f9)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0033: CONTA A PAGAR RELATADA E PARCELADA com ação ESTREITA — MOVA (26/11/2026)
--
-- Espelho de economico.registrarContaParcelada. Ação nova `financeiro_v2.registrar_conta_parcelada` (MIGRAÇÃO RESTRITIVA:
-- nenhuma concessão existente a recebe). Caso real: "compra de bebedouro para o açaí, 2 parcelas no cartão, dia 19/12 e 19/01,
-- R$ 194,50" — conta a pagar SEM documento (o relato confirmado no WhatsApp é a origem), em N parcelas com vencimentos EXPLÍCITOS.
-- Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) grava:
--   * UM lançamento ATIVO pelo TOTAL, de DESPESA — ou PATRIMONIAL apenas na categoria IMOBILIZADO ("Compra de equipamentos e
--     bens", que não entra no resultado) —, com origem OBRIGACAO, criado na MESMA transação das parcelas;
--   * de 1 a 24 parcelas em aberto, sem recorrência, apontando para esse lançamento; a SOMA das parcelas é igual ao total
--     (conferida no fim da transação);
--   * a contraparte nova do relato (ou "Fornecedor não informado") e o histórico dessa operação.
-- Nada de movimentação, liquidação (a conta NÃO nasce paga), documento, receita, dedução, conta, categoria ou alteração de registro
-- existente: as políticas de ALTERAÇÃO não são ampliadas. Políticas ampliadas a partir da expressão ATUAL (pg_policy).
-- A forma de quem só tem `registrar_obrigacao` (0030: uma parcela, despesa, valor igual ao do lançamento) continua IGUAL.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS (sem vínculo documental: a conta relatada não tem documento).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir'),
      ('fv2_contraparte', 'fv2_contraparte_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0033: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_conta_parcelada');
  end loop;
end $$;

-- 3) Quem grava SEM ação ampla: a forma do que é gravado é conferida pelo banco (qualquer gravador não superusuário).
create or replace function fv2_so_registra_conta_parcelada() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_conta_parcelada'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

-- A função da 0030 passa a conhecer as DUAS formas estreitas. A identidade que tem as duas ações grava qualquer uma delas, e cada
-- gravação é conferida pela forma em que se encaixa (uma parcela com o valor do lançamento = 0030; parcelada = 0033).
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
    if new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: só se registra lançamento ativo nascido de conta a pagar.' using errcode = '42501';
    end if;
    if new.natureza = 'DESPESA' or (parcelada and new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO') then
      return new;
    end if;
    raise exception 'Financeiro v2: conta a pagar estreita só em categoria de DESPESA (ou compra de equipamentos, na relatada).' using errcode = '42501';
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
  -- forma da 0030: uma parcela, valor igual ao do lançamento, natureza DESPESA
  if documental and (new.parcela->>'total')::int = 1 and l.valor_centavos = new.valor_base_centavos and l.natureza = 'DESPESA' then
    return new;
  end if;
  -- forma da 0033: 1 a 24 parcelas do MESMO lançamento (a soma é conferida no fim da transação)
  if parcelada and (new.parcela->>'total')::int between 1 and 24 and (new.parcela->>'numero')::int between 1 and (new.parcela->>'total')::int
     and new.valor_base_centavos > 0 and new.valor_base_centavos <= l.valor_centavos and cardinality(new.documento_ids) = 0 then
    return new;
  end if;
  raise exception 'Financeiro v2: forma de conta a pagar não permitida para esta permissão estreita.' using errcode = '42501';
end $$;

-- 4) Soma das parcelas = total do lançamento (no fim da transação, quando todas as parcelas já foram gravadas).
create or replace function fv2_conta_parcelada_soma() returns trigger language plpgsql as $$
declare
  total bigint;
  soma bigint;
  qtd int;
begin
  if not fv2_so_registra_conta_parcelada() then
    return null;
  end if;
  select l.valor_centavos into total from fv2_lancamento l
   where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id and l.id = new.lancamento_id;
  select coalesce(sum(o.valor_base_centavos), 0), count(*) into soma, qtd from fv2_obrigacao o
   where o.organizacao_id = new.organizacao_id and o.unidade_id = new.unidade_id and o.grupo_id = new.grupo_id;
  if soma <> total or qtd <> (new.parcela->>'total')::int then
    raise exception 'Financeiro v2: as parcelas da conta relatada precisam somar o total do lançamento.' using errcode = '42501';
  end if;
  return null;
end $$;
create constraint trigger fv2_obrigacao_parcelada_soma after insert on fv2_obrigacao deferrable initially deferred
  for each row execute function fv2_conta_parcelada_soma();
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0033_registrar_conta_parcelada.sql', '18094440f9d94cc0057c1cb2cb4c3ff603e6feb3038aa93198b242d5f0b3f5f9', '18094440f9d94cc0057c1cb2cb4c3ff603e6feb3038aa93198b242d5f0b3f5f9');

-- ------------------------------------------------------------------------- 0034_operacoes_entre_empresas.sql (arquivo 961e40e9581334bd982ec8829c37788470f7029188ae3e0f9e9f501d1930df22)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0034: OPERAÇÕES ENTRE EMPRESAS (intercompany) — MOVA (26/11/2026)
--
-- Espelho de aplicacao/intercompany.js. Caso real: a Subway Saci (MP ALIMENTOS) pagou R$ 6.495,60 à distribuidora pelo Açaí no Grau
-- Saci (AF PRODUTOS). Empresa PAGADORA e empresa BENEFICIÁRIA são dimensões diferentes:
--   * DEVEDORA (quem se beneficiou, ex.: Açaí): a conta do fornecedor é LIQUIDADA "paga por outra empresa" — liquidação SEM saída
--     bancária nesta empresa (`extras.origemDoVinculo = 'INTERCOMPANY'`) — e nasce o PASSIVO com a credora. A despesa é reconhecida
--     UMA vez (pela conta do fornecedor); nenhuma saída de banco ou caixa é inventada na devedora.
--   * CREDORA (quem pagou, ex.: Subway): nasce o ATIVO (a receber da devedora). A saída real é a do EXTRATO: ela só é LIGADA ao
--     ativo quando existe (nunca criada aqui) — não é despesa operacional da credora nem duplica a saída importada.
-- Os dois lados (um em cada escopo) compartilham UM vínculo (`vinculo_id`), gravados na MESMA transação do banco (a aplicação assume
-- a sessão de cada escopo em sequência). REEMBOLSO (parcial ou integral) liquida os dois lados; não é receita nem despesa.
-- Vencimento do reembolso é OPCIONAL (nunca inventado). Categoria contábil: OPERACOES_ENTRE_EMPRESAS (patrimonial; fora da DRE).
-- Ação nova `financeiro_v2.registrar_intercompany` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe).
-- Mesmas proteções das demais tabelas: escopo por empresa/unidade (RLS), sem exclusão, versão e histórico obrigatórios.
-- =====================================================================================================================

create table fv2_intercompany (
  seq                        bigint generated always as identity,
  id                         uuid not null primary key,
  organizacao_id             uuid not null,
  unidade_id                 uuid not null,
  versao                     integer not null check (versao >= 1),
  criado_em                  timestamptz not null,
  criado_por                 uuid not null,
  atualizado_em              timestamptz not null,
  atualizado_por             uuid not null,
  chave_idempotencia         text not null check (length(chave_idempotencia) between 1 and 400),
  impressao                  text,
  extras                     jsonb not null default '{}'::jsonb check (jsonb_typeof(extras) = 'object'),
  vinculo_id                 uuid not null,
  papel                      text not null check (papel in ('DEVEDORA', 'CREDORA')),
  contraparte_organizacao_id uuid not null,
  contraparte_unidade_id     uuid not null,
  contraparte_nome           text not null check (length(btrim(contraparte_nome)) between 1 and 200),
  descricao                  text not null check (length(btrim(descricao)) between 1 and 300),
  data_pagamento             date not null,
  valor_centavos             bigint not null check (valor_centavos > 0),
  reembolsado_centavos       bigint not null default 0 check (reembolsado_centavos >= 0),
  saldo_centavos             bigint not null,
  vencimento                 date,
  situacao                   text not null check (situacao in ('ABERTO', 'PARCIAL', 'LIQUIDADO')),
  obrigacao_id               uuid,
  movimentacao_id            uuid,
  documento_ids              uuid[] not null default '{}',
  liquidacoes                jsonb not null default '[]'::jsonb check (jsonb_typeof(liquidacoes) = 'array'),
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, vinculo_id),
  check (reembolsado_centavos <= valor_centavos),
  check (saldo_centavos = valor_centavos - reembolsado_centavos),
  check (situacao = case when reembolsado_centavos = 0 then 'ABERTO' when reembolsado_centavos = valor_centavos then 'LIQUIDADO' else 'PARCIAL' end),
  check ((organizacao_id, unidade_id) <> (contraparte_organizacao_id, contraparte_unidade_id)),
  check (papel = 'DEVEDORA' or obrigacao_id is null),
  check (papel = 'CREDORA' or movimentacao_id is null),
  check (vencimento is null or vencimento >= data_pagamento),
  check (atualizado_em >= criado_em)
);
alter table fv2_intercompany add constraint fv2_intercompany_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_intercompany_chave_uq on fv2_intercompany (organizacao_id, unidade_id, chave_idempotencia);
-- uma conta do fornecedor só é paga por outra empresa UMA vez; uma saída do extrato só sustenta UM ativo intercompany
create unique index fv2_intercompany_obrigacao_uq on fv2_intercompany (organizacao_id, unidade_id, obrigacao_id) where obrigacao_id is not null;
create unique index fv2_intercompany_movimentacao_uq on fv2_intercompany (organizacao_id, unidade_id, movimentacao_id) where movimentacao_id is not null;
create index fv2_intercompany_vencimento on fv2_intercompany (organizacao_id, unidade_id, vencimento) where situacao <> 'LIQUIDADO';

create trigger fv2_intercompany_sem_delete before delete on fv2_intercompany for each row execute function fv2_proibir_exclusao();
create trigger fv2_intercompany_sem_truncate before truncate on fv2_intercompany for each statement execute function fv2_proibir_exclusao();
create trigger fv2_intercompany_versao before update on fv2_intercompany for each row execute function fv2_guardar_versao();
create constraint trigger fv2_intercompany_historico after insert or update on fv2_intercompany deferrable initially deferred
  for each row execute function fv2_exigir_historico('INTERCOMPANY');

-- O fato original é imutável: só o reembolso (posição + histórico de liquidações), o vencimento informado depois e a ligação da saída
-- do extrato (uma vez) mudam. O histórico de liquidações só CRESCE.
create function fv2_intercompany_imutavel() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'reembolsado_centavos', 'saldo_centavos', 'situacao', 'liquidacoes', 'vencimento', 'movimentacao_id'];
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if tg_op = 'INSERT' then
    if new.reembolsado_centavos <> 0 or jsonb_array_length(new.liquidacoes) <> 0 then
      raise exception 'FV2: a operação entre empresas nasce sem reembolso' using errcode = 'FV010';
    end if;
    if new.movimentacao_id is not null then
      select x.* into m from fv2_movimentacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
      if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.valor_centavos <> new.valor_centavos or m.xmin::text = xid_atual then
        raise exception 'FV2: só uma saída JÁ importada do extrato, válida e do mesmo valor, é ligada ao ativo entre empresas' using errcode = 'FV010';
      end if;
    end if;
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'FV2: o fato original da operação entre empresas não pode ser alterado' using errcode = 'FV010';
  end if;
  if new.reembolsado_centavos < old.reembolsado_centavos or jsonb_array_length(new.liquidacoes) < jsonb_array_length(old.liquidacoes)
     or coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(new.liquidacoes) with ordinality t(e, i) where i <= jsonb_array_length(old.liquidacoes)), '[]'::jsonb) is distinct from old.liquidacoes
     or new.reembolsado_centavos <> coalesce((select sum((e->>'valorCentavos')::bigint) from jsonb_array_elements(new.liquidacoes) e), 0) then
    raise exception 'FV2: reembolso entre empresas só acrescenta liquidações (nada é apagado ou reescrito)' using errcode = 'FV010';
  end if;
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'FV2: a saída do extrato ligada à operação entre empresas não se troca' using errcode = 'FV010';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    select x.* into m from fv2_movimentacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.valor_centavos <> new.valor_centavos or m.xmin::text = xid_atual then
      raise exception 'FV2: só uma saída JÁ importada do extrato, válida e do mesmo valor, é ligada ao ativo entre empresas' using errcode = 'FV010';
    end if;
  end if;
  return new;
end $$;
create trigger fv2_intercompany_fato before insert or update on fv2_intercompany for each row execute function fv2_intercompany_imutavel();

alter table fv2_intercompany enable row level security;
alter table fv2_intercompany force row level security;
create policy fv2_intercompany_escopo on fv2_intercompany
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_intercompany_ler on fv2_intercompany as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_intercompany_incluir on fv2_intercompany as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.registrar_intercompany'])));
create policy fv2_intercompany_alterar on fv2_intercompany as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar_intercompany'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar_intercompany'])));
grant select, insert, update on fv2_intercompany to fv2_app;

create or replace function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
    when 'IMPORTACAO' then 'fv2_importacao' when 'REGISTRO_FONTE' then 'fv2_registro_fonte' when 'CONCESSAO' then 'fv2_concessao'
    when 'PROPOSTA' then 'fv2_proposta' when 'DIVERGENCIA_FONTE' then 'fv2_divergencia_fonte'
    when 'SALDO_CONTA' then 'fv2_saldo_conta' when 'SESSAO_CAIXA' then 'fv2_sessao_caixa'
    when 'VERSAO_FECHAMENTO' then 'fv2_versao_fechamento' when 'ATRIBUICAO_PENDENCIA' then 'fv2_atribuicao_pendencia'
    when 'CANAL_PROCESSADOR' then 'fv2_canal_processador' when 'CONFIGURACAO_UNIDADE' then 'fv2_configuracao_unidade'
    when 'ABERTURA' then 'fv2_abertura' when 'FECHAMENTO_CAIXA' then 'fv2_fechamento_caixa'
    when 'SEMANA_ENTREGADORES' then 'fv2_semana_entregadores' when 'FECHAMENTO_ENTREGADOR' then 'fv2_fechamento_entregador'
    when 'EXTRA_ENTREGADOR' then 'fv2_extra_entregador' when 'INTERCOMPANY' then 'fv2_intercompany'
  end::regclass
$$;

-- Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany"]'::jsonb);

-- Liquidação SEM saída bancária: por comprovante (0029) ou PAGA POR OUTRA EMPRESA (esta migração, com o passivo intercompany).
alter table fv2_liquidacao drop constraint fv2_liquidacao_sem_movimentacao;
alter table fv2_liquidacao add constraint fv2_liquidacao_sem_movimentacao check (
  movimentacao_id is not null
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'COMPROVANTE' and (extras->>'documentoId') is not null)
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'INTERCOMPANY' and (extras->>'intercompanyId') is not null));

-- Políticas: a ação estreita liquida a conta do fornecedor (liquidação + posição da conta) e grava o histórico. Nada mais.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case when r.parte = 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0034: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case when r.parte = 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.registrar_intercompany');
  end loop;
end $$;

-- Quem SÓ tem a ação estreita de intercompany (sem ação ampla nem outra ação que altere contas) só muda a POSIÇÃO da conta liquidada.
create or replace function fv2_so_intercompany() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_intercompany'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
                                'financeiro_v2.baixar_por_comprovante', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.prestar_sangria', 'financeiro_v2.registrar_juros'])
$$;
create or replace function fv2_obrigacao_paga_por_outra_empresa() returns trigger language plpgsql as $$
begin
  if not fv2_so_intercompany() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'liquidado_centavos', 'saldo_centavos', 'situacao'])
       is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'liquidado_centavos', 'saldo_centavos', 'situacao'])
     or new.liquidado_centavos <= old.liquidado_centavos then
    raise exception 'Financeiro v2: a operação entre empresas só registra o pagamento da conta (nada mais muda).' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_obrigacao_intercompany before update on fv2_obrigacao for each row execute function fv2_obrigacao_paga_por_outra_empresa();

-- Pagamento por comprovante (0029/0032) + liquidação PAGA POR OUTRA EMPRESA: exige o passivo DEVEDORA desta unidade, desta conta e
-- do mesmo valor, gravado antes na mesma transação. Data não futura. Quem só tem a ação estreita nunca grava liquidação com saída.
create or replace function fv2_pagamento_por_comprovante() returns trigger language plpgsql as $$
declare
  tipo_doc text;
  m record;
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'movimentacao_id'];
  so_documental boolean;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  so_documental := not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.cancelar']);
  if tg_op = 'INSERT' then
    if new.movimentacao_id is not null then
      if so_documental and not fv2_so_presta_sangria() then
        raise exception 'Financeiro v2: quem só baixa por comprovante não grava liquidação com saída bancária.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.alvo_tipo = 'OBRIGACAO' and coalesce(new.extras->>'origemDoVinculo', '') = 'INTERCOMPANY' then
      if not exists (select 1 from fv2_intercompany i
                      where i.organizacao_id = new.organizacao_id and i.unidade_id = new.unidade_id and i.id = (new.extras->>'intercompanyId')::uuid
                        and i.papel = 'DEVEDORA' and i.obrigacao_id = new.alvo_id and i.valor_centavos = new.valor_centavos
                        and i.data_pagamento = new.data_efetiva) then
        raise exception 'Financeiro v2: conta paga por outra empresa exige o passivo entre empresas desta conta, do mesmo valor e data.' using errcode = '42501';
      end if;
      if new.data_efetiva > current_date + 1 then
        raise exception 'Financeiro v2: pagamento por outra empresa não pode ter data futura.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE' then
      raise exception 'Financeiro v2: liquidação sem saída bancária só para pagamento de conta por comprovante.' using errcode = '42501';
    end if;
    select d.tipo into tipo_doc from fv2_documento d
     where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
    if tipo_doc is distinct from 'COMPROVANTE' then
      raise exception 'Financeiro v2: pagamento sem extrato exige um documento COMPROVANTE desta unidade.' using errcode = '42501';
    end if;
    if new.data_efetiva > current_date + 1 then
      raise exception 'Financeiro v2: pagamento por comprovante não pode ter data futura (agendamento não é pagamento).' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'Financeiro v2: a saída de uma liquidação não se troca.' using errcode = '42501';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
       or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE'
       or (old.extras->'documentoId') is distinct from (new.extras->'documentoId') then
      raise exception 'Financeiro v2: conciliar o pagamento por comprovante só liga a saída do extrato (nada mais muda).' using errcode = '42501';
    end if;
    select x.* into m from fv2_movimentacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
       or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA')
       or m.valor_centavos <> new.valor_centavos - new.estornado_centavos then
      raise exception 'Financeiro v2: a conciliação exige saída válida do extrato com o valor do pagamento.' using errcode = '42501';
    end if;
    return new;
  end if;
  if fv2_so_vincula() and (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    raise exception 'Financeiro v2: sem permissão para alterar esta liquidação além da conciliação.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0034_operacoes_entre_empresas.sql', '961e40e9581334bd982ec8829c37788470f7029188ae3e0f9e9f501d1930df22', '961e40e9581334bd982ec8829c37788470f7029188ae3e0f9e9f501d1930df22');

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
  if n <> 34 then raise exception 'FV2 pós: % migrações registradas (esperado 34)', n; end if;
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
