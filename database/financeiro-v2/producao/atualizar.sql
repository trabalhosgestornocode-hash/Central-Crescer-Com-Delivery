-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql, 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql, 0025_fechamento_manual_caixa.sql, 0026_entregadores_proprios.sql, 0027_bloqueio_automacao_definer.sql, 0028_leitor_mova.sql, 0029_pagamento_por_comprovante.sql, 0030_registrar_obrigacao_documental.sql, 0031_registrar_juros_no_pagamento.sql, 0032_prestar_sangria.sql, 0033_registrar_conta_parcelada.sql, 0034_operacoes_entre_empresas.sql, 0035_registrar_emprestimo.sql, 0036_corrigir_conta_a_pagar.sql
-- Novas: 0037_operacoes_de_conta_a_pagar.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 36 then raise exception 'FV2 atualização: % migrações registradas (esperado 36) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21'), ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23'), ('0024_canais_e_operadoras.sql', '06d24fc401594af33601efceee76a0945059eb10bb8c729ef0b5c5ba185a7a59'), ('0025_fechamento_manual_caixa.sql', 'ffb42c1db5a02ba97eaeaf8c0047d4efbcc4568476f7907eda633b2d261135a2'), ('0026_entregadores_proprios.sql', '787d09876c61debe4c1d600862b80b482d7034a37c845596862383ee5d796312'), ('0027_bloqueio_automacao_definer.sql', '957abaa956fbb97a0b39f4549e43647e798ba8badc268955713f40b97332f25e'), ('0028_leitor_mova.sql', '760ac6416ee6b357c2a55edf92a894e89aa0da151435bf06450ccc2813b40b6b'), ('0029_pagamento_por_comprovante.sql', '9d071a32523aaa71ab1f9792cb4d002ba34222bafcb4814c8108a621113ab679'), ('0030_registrar_obrigacao_documental.sql', '2d39204d2d2de6f3806266e1ab2c1c45129ce62d61b3b8ec91a0f54574a83e09'), ('0031_registrar_juros_no_pagamento.sql', '7deef8e2183cb59df0bce45fa8a30d0d7edc5bb7f135ce3ecd9388de22e93e1b'), ('0032_prestar_sangria.sql', '144ef8570397022abe8fcc3d49249d821bb36a726830e06395328a59815106e8'), ('0033_registrar_conta_parcelada.sql', '6182191b1090739bf7ee2e1305a71ec347ad291bfbd8e80008b931844f63f7bc'), ('0034_operacoes_entre_empresas.sql', 'd2ee48024db6ec4f4163718a08b5306468673f9ac234af40663c3f5bc558ac92'), ('0035_registrar_emprestimo.sql', '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509'), ('0036_corrigir_conta_a_pagar.sql', 'dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 36 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0037_operacoes_de_conta_a_pagar.sql (arquivo d35d12cca2c55001cdf8925cc640bcfaee8a94e02b92ba008e799150d1255e44)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0037: OPERAÇÕES ESTREITAS DE CONTA A PAGAR EXISTENTE — MOVA Operador Financeiro, fase 2 (28/11/2026)
--
-- Espelho de aplicacao/contaAPagarEstreita.js. Quatro ações novas (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente as recebe),
-- cada uma só com a SUA forma, conferida aqui mesmo quando a sessão da identidade enxerga TODAS as ações da concessão (lição da 0036):
--   * reclassificar_conta_a_pagar      — categoria do LANÇAMENTO da compra (despesa ↔ despesa / equipamento), grupo sem ajuste nem
--                                        parcela cancelada; a forma da reclassificação continua a da 0014 (só categoria muda).
--   * ajustar_conta_a_pagar            — AJUSTE documentado (lançamento próprio, MESMA categoria e competência da compra) numa parcela
--                                        aberta ou parcial; o saldo continua positivo e a situação não muda. O valor original nunca muda.
--   * mover_competencia_conta_a_pagar  — competência do lançamento e de TODAS as parcelas, sem pagamento, ajuste ou parcela cancelada,
--                                        entre dois períodos ABERTOS/PRELIMINARES. Vencimentos, liquidações e caixa não mudam.
--   * cancelar_conta_a_pagar           — parcela sem pagamento CANCELADA (com ajuste negativo do valor dela, saldo zero) ou a compra
--                                        inteira (parcelas, lançamento e lançamentos de ajuste cancelados). Nada é apagado.
-- Comum: lançamento ATIVO nascido de conta a pagar, de DESPESA ou PATRIMONIAL só em IMOBILIZADO (empréstimo, parcelamento tributário,
-- entre empresas e outras patrimoniais ficam FORA); período ABERTO ou FECHAMENTO_PRELIMINAR; nenhuma ação ampla.
-- As barreiras existentes (posição da 0018/0031/0036, juros da 0031, contas estreitas da 0030/0033/0035, ações do lançamento da
-- 0014/0036) passam a reconhecer EXATAMENTE essas formas; tudo o mais segue recusado como antes.
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
  "financeiro_v2.registrar_emprestimo", "financeiro_v2.corrigir_conta_a_pagar", "financeiro_v2.reclassificar_conta_a_pagar",
  "financeiro_v2.ajustar_conta_a_pagar", "financeiro_v2.mover_competencia_conta_a_pagar", "financeiro_v2.cancelar_conta_a_pagar"]'::jsonb);

-- 2) Políticas: acrescenta a ação às expressões ATUAIS, só onde a operação grava.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'using', 'reclassificar_conta_a_pagar'), ('fv2_lancamento', 'fv2_lancamento_alterar', 'check', 'reclassificar_conta_a_pagar'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'using', 'mover_competencia_conta_a_pagar'), ('fv2_lancamento', 'fv2_lancamento_alterar', 'check', 'mover_competencia_conta_a_pagar'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'using', 'cancelar_conta_a_pagar'), ('fv2_lancamento', 'fv2_lancamento_alterar', 'check', 'cancelar_conta_a_pagar'),
      ('fv2_lancamento', 'fv2_lancamento_incluir', 'check', 'ajustar_conta_a_pagar'), ('fv2_lancamento', 'fv2_lancamento_incluir', 'check', 'cancelar_conta_a_pagar'),
      ('fv2_ajuste', 'fv2_ajuste_incluir', 'check', 'ajustar_conta_a_pagar'), ('fv2_ajuste', 'fv2_ajuste_incluir', 'check', 'cancelar_conta_a_pagar'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using', 'ajustar_conta_a_pagar'), ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check', 'ajustar_conta_a_pagar'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using', 'mover_competencia_conta_a_pagar'), ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check', 'mover_competencia_conta_a_pagar'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using', 'cancelar_conta_a_pagar'), ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check', 'cancelar_conta_a_pagar'),
      ('fv2_historico', 'fv2_historico_incluir', 'check', 'reclassificar_conta_a_pagar'), ('fv2_historico', 'fv2_historico_incluir', 'check', 'ajustar_conta_a_pagar'),
      ('fv2_historico', 'fv2_historico_incluir', 'check', 'mover_competencia_conta_a_pagar'), ('fv2_historico', 'fv2_historico_incluir', 'check', 'cancelar_conta_a_pagar')
    ) as v(tabela, politica, parte, acao) loop
    select case r.parte when 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0037: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case r.parte when 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.' || r.acao);
  end loop;
end $$;

-- 3) Predicados comuns.
create or replace function fv2_pode_estreita(p_acao text) returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array[p_acao])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;
create or replace function fv2_periodo_estreito(p_org uuid, p_unidade uuid, p_competencia text) returns boolean language sql stable as $$
  select coalesce((select c.estado from fv2_competencia c where c.organizacao_id = p_org and c.unidade_id = p_unidade and c.competencia = p_competencia), 'ABERTA')
         in ('ABERTA', 'FECHAMENTO_PRELIMINAR')
$$;
-- Lançamento de COMPRA elegível: ativo, nascido de conta a pagar, despesa ou equipamento (IMOBILIZADO).
create or replace function fv2_compra_elegivel(p_situacao text, p_origem jsonb, p_natureza text, p_categoria text) returns boolean language sql immutable as $$
  select p_situacao = 'ATIVO' and p_origem->>'tipo' = 'OBRIGACAO' and (p_natureza = 'DESPESA' or (p_natureza = 'PATRIMONIAL' and p_categoria = 'IMOBILIZADO'))
$$;
-- Colunas que MUDARAM (fora as de controle de versão).
create or replace function fv2_colunas_alteradas(p_old jsonb, p_new jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_old || p_new) k
   where k not in ('versao', 'atualizado_em', 'atualizado_por') and (p_old->k) is distinct from (p_new->k)
$$;

-- 4) Forma ESTREITA de uma alteração de CONTA (fv2_obrigacao): 'COMPETENCIA' | 'AJUSTE' | 'CANCELAMENTO' | null (não é desta migração).
create or replace function fv2_forma_estreita_da_conta(o fv2_obrigacao, n fv2_obrigacao) returns text language plpgsql stable as $$
declare
  mud text[] := fv2_colunas_alteradas(to_jsonb(o), to_jsonb(n));
  l record;
  soma bigint;
begin
  select x.situacao, x.origem, x.natureza, x.categoria_codigo, x.competencia into l from fv2_lancamento x
   where x.organizacao_id = o.organizacao_id and x.unidade_id = o.unidade_id and x.id = o.lancamento_id;
  if l is null or not fv2_compra_elegivel(l.situacao, l.origem, l.natureza, l.categoria_codigo) or not fv2_periodo_estreito(o.organizacao_id, o.unidade_id, l.competencia) then
    return null;
  end if;
  select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a where a.organizacao_id = n.organizacao_id and a.unidade_id = n.unidade_id and a.alvo_tipo = 'OBRIGACAO' and a.alvo_id = n.id;
  if mud = array['competencia'] and fv2_pode_estreita('financeiro_v2.mover_competencia_conta_a_pagar')
     and o.situacao = 'ABERTA' and o.liquidado_centavos = 0 and o.ajustes_centavos = 0 and soma = 0
     and fv2_periodo_estreito(o.organizacao_id, o.unidade_id, o.competencia) and fv2_periodo_estreito(n.organizacao_id, n.unidade_id, n.competencia) then
    return 'COMPETENCIA';
  end if;
  if mud <@ array['ajustes_centavos', 'saldo_centavos'] and 'ajustes_centavos' = any(mud) and fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar')
     and o.situacao in ('ABERTA', 'PARCIAL') and n.situacao = o.situacao and n.saldo_centavos > 0 and n.ajustes_centavos = soma then
    return 'AJUSTE';
  end if;
  if mud <@ array['situacao', 'ajustes_centavos', 'saldo_centavos'] and n.situacao = 'CANCELADA' and o.situacao = 'ABERTA' and o.liquidado_centavos = 0
     and fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar') and n.ajustes_centavos = soma
     and (not 'ajustes_centavos' = any(mud) or n.saldo_centavos = 0) then
    return 'CANCELAMENTO';
  end if;
  return null;
end $$;

-- 5) Forma ESTREITA de uma alteração de LANÇAMENTO: confere reclassificação, competência e cancelamento (descrição é da 0036).
create or replace function fv2_lancamento_operacao_estreita() returns trigger language plpgsql as $$
declare
  mud text[] := fv2_colunas_alteradas(to_jsonb(old), to_jsonb(new));
  a record;
  ruim boolean;
begin
  -- quem altera lançamento por uma ação ESTREITA (correção da 0036 ou as desta migração): só as formas reconhecidas abaixo
  if not (fv2_pode_estreita('financeiro_v2.corrigir_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.reclassificar_conta_a_pagar')
          or fv2_pode_estreita('financeiro_v2.mover_competencia_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')) then
    return new;
  end if;
  if mud <@ array['descricao'] then
    return new; -- correção cadastral (0036) ou nada
  end if;
  -- reclassificação da COMPRA (a forma "só categoria" é conferida pela 0014)
  if mud <@ array['categoria_id', 'categoria_codigo', 'classificacao', 'natureza'] and 'categoria_codigo' = any(mud) then
    if fv2_tem_acao(array['financeiro_v2.reclassificar']) then
      return new; -- reclassificação oficial (ampla): regras da 0014
    end if;
    select exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
                    and (o.situacao = 'CANCELADA' or o.ajustes_centavos <> 0)) into ruim;
    if fv2_pode_estreita('financeiro_v2.reclassificar_conta_a_pagar') and fv2_compra_elegivel(old.situacao, old.origem, old.natureza, old.categoria_codigo)
       and (new.natureza = 'DESPESA' or (new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO'))
       and new.categoria_codigo not in ('DESPESAS_A_CLASSIFICAR', 'DESCONTOS_A_CLASSIFICAR')
       and fv2_periodo_estreito(old.organizacao_id, old.unidade_id, old.competencia) and not ruim then
      return new;
    end if;
    raise exception 'Financeiro v2: a reclassificação estreita vale só para a compra de despesa/equipamento sem ajuste nem parcela cancelada, em período aberto.' using errcode = '42501';
  end if;
  -- competência da COMPRA: as parcelas já estão no período novo (mesma transação), sem pagamento nem ajuste
  if mud = array['competencia'] then
    select exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
                    and (o.competencia <> new.competencia or o.situacao <> 'ABERTA' or o.liquidado_centavos <> 0 or o.ajustes_centavos <> 0)) into ruim;
    if fv2_pode_estreita('financeiro_v2.mover_competencia_conta_a_pagar') and fv2_compra_elegivel(old.situacao, old.origem, old.natureza, old.categoria_codigo)
       and fv2_periodo_estreito(old.organizacao_id, old.unidade_id, old.competencia) and fv2_periodo_estreito(new.organizacao_id, new.unidade_id, new.competencia) and not ruim then
      return new;
    end if;
    raise exception 'Financeiro v2: a competência estreita muda a compra inteira (sem pagamento, ajuste ou parcela cancelada) entre períodos abertos.' using errcode = '42501';
  end if;
  -- cancelamento: (a) o lançamento da COMPRA com todas as parcelas já canceladas, sem pagamento; (b) o lançamento de AJUSTE de uma
  -- parcela dessa compra (cancelado junto com ela)
  if mud = array['situacao'] and old.situacao = 'ATIVO' and new.situacao = 'CANCELADO' and fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')
     and fv2_periodo_estreito(old.organizacao_id, old.unidade_id, old.competencia) then
    if fv2_compra_elegivel(old.situacao, old.origem, old.natureza, old.categoria_codigo)
       and not exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
                        and (o.situacao <> 'CANCELADA' or o.liquidado_centavos <> 0))
       and exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id) then
      return new;
    end if;
    if old.origem->>'tipo' = 'AJUSTE' then
      select aj.alvo_id, ob.situacao, ob.liquidado_centavos, lc.natureza, lc.categoria_codigo into a
        from fv2_ajuste aj join fv2_obrigacao ob on ob.organizacao_id = aj.organizacao_id and ob.unidade_id = aj.unidade_id and ob.id = aj.alvo_id
        join fv2_lancamento lc on lc.organizacao_id = ob.organizacao_id and lc.unidade_id = ob.unidade_id and lc.id = ob.lancamento_id
       where aj.organizacao_id = old.organizacao_id and aj.unidade_id = old.unidade_id and aj.id = (old.origem->>'id')::uuid and aj.alvo_tipo = 'OBRIGACAO';
      if a.alvo_id is not null and a.situacao = 'CANCELADA' and a.liquidado_centavos = 0 and a.categoria_codigo = old.categoria_codigo then
        return new;
      end if;
    end if;
    raise exception 'Financeiro v2: o cancelamento estreito vale só para a compra sem pagamento (ou o ajuste de parcela dela), em período aberto.' using errcode = '42501';
  end if;
  raise exception 'Financeiro v2: alteração de lançamento fora das operações estreitas de conta a pagar.' using errcode = '42501';
end $$;
create trigger fv2_lancamento_operacao_estreita before update on fv2_lancamento for each row execute function fv2_lancamento_operacao_estreita();

-- 6) AJUSTE estreito (valor ou cancelamento de parcela): o lançamento do ajuste e o ajuste apontam um para o outro, na MESMA categoria
--    e competência da compra, para uma parcela aberta/parcial elegível. Conferido no FIM da transação (o lançamento nasce antes do ajuste).
create or replace function fv2_ajuste_estreito_confere() returns trigger language plpgsql as $$
declare
  aj record;
  ob record;
  lc record;
begin
  if not (fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar'))
     or new.origem->>'tipo' is distinct from 'AJUSTE' or new.categoria_codigo = 'JUROS_E_MULTAS_DE_FORNECEDORES' then
    return null; -- juros: forma da 0031
  end if;
  select x.* into aj from fv2_ajuste x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = (new.origem->>'id')::uuid;
  if aj.id is null or aj.lancamento_id is distinct from new.id or aj.alvo_tipo <> 'OBRIGACAO' or aj.valor_centavos <> new.valor_centavos then
    raise exception 'Financeiro v2: o lançamento de ajuste estreito precisa do ajuste correspondente, com o mesmo valor.' using errcode = '42501';
  end if;
  select x.* into ob from fv2_obrigacao x where x.organizacao_id = aj.organizacao_id and x.unidade_id = aj.unidade_id and x.id = aj.alvo_id;
  select x.* into lc from fv2_lancamento x where x.organizacao_id = ob.organizacao_id and x.unidade_id = ob.unidade_id and x.id = ob.lancamento_id;
  if ob.id is null or lc.id is null or lc.categoria_codigo <> new.categoria_codigo or lc.competencia <> new.competencia or new.retido_no_repasse
     or not fv2_compra_elegivel(lc.situacao, lc.origem, lc.natureza, lc.categoria_codigo) or not fv2_periodo_estreito(new.organizacao_id, new.unidade_id, new.competencia) then
    raise exception 'Financeiro v2: o ajuste estreito fica na mesma categoria e competência da compra elegível.' using errcode = '42501';
  end if;
  return null;
end $$;
create constraint trigger fv2_lancamento_ajuste_estreito after insert on fv2_lancamento deferrable initially deferred
  for each row execute function fv2_ajuste_estreito_confere();

-- 6b) Fim da transação: a CONTA alterada pela forma estreita termina coerente com a COMPRA — competência igual à do lançamento; parcela
--     cancelada com saldo zero pelo ajuste (parcela) ou com o lançamento da compra cancelado (compra inteira).
create or replace function fv2_conta_estreita_coerente() returns trigger language plpgsql as $$
declare
  lc record;
begin
  if not (fv2_pode_estreita('financeiro_v2.mover_competencia_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')) then
    return null;
  end if;
  select x.competencia, x.situacao into lc from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if new.competencia is distinct from old.competencia and new.competencia is distinct from lc.competencia then
    raise exception 'Financeiro v2: a competência muda na compra inteira (lançamento e parcelas juntos).' using errcode = '42501';
  end if;
  if new.situacao = 'CANCELADA' and old.situacao <> 'CANCELADA' and not (new.saldo_centavos = 0 or lc.situacao = 'CANCELADO') then
    raise exception 'Financeiro v2: parcela cancelada sozinha exige o ajuste do valor dela; a compra inteira cancela também o lançamento.' using errcode = '42501';
  end if;
  return null;
end $$;
create constraint trigger fv2_obrigacao_estreita_coerente after update on fv2_obrigacao deferrable initially deferred
  for each row execute function fv2_conta_estreita_coerente();

-- 7) Inclusão do AJUSTE estreito: aponta para uma conta aberta/parcial da compra elegível e para o SEU lançamento (criado antes, mesma
--    transação), com o mesmo valor, a mesma categoria e a mesma competência da compra. Ajuste de juros segue a forma da 0031.
create or replace function fv2_ajuste_estreito() returns trigger language plpgsql as $$
declare
  ob record;
  lc record;
  la record;
begin
  if not (fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')) then
    return new;
  end if;
  select x.* into la from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if la.id is not null and la.categoria_codigo = 'JUROS_E_MULTAS_DE_FORNECEDORES' and fv2_so_registra_juros() then
    return new; -- encargo do pagamento: forma da 0031
  end if;
  select x.* into ob from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into lc from fv2_lancamento x where x.organizacao_id = ob.organizacao_id and x.unidade_id = ob.unidade_id and x.id = ob.lancamento_id;
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos = 0 or la.id is null or la.origem->>'tipo' <> 'AJUSTE' or la.origem->>'id' <> new.id::text
     or la.valor_centavos <> new.valor_centavos or ob.id is null or ob.situacao not in ('ABERTA', 'PARCIAL') or lc.id is null
     or la.categoria_codigo <> lc.categoria_codigo or la.competencia <> lc.competencia or new.competencia <> lc.competencia
     or not fv2_compra_elegivel(lc.situacao, lc.origem, lc.natureza, lc.categoria_codigo) or not fv2_periodo_estreito(new.organizacao_id, new.unidade_id, new.competencia) then
    raise exception 'Financeiro v2: o ajuste estreito aponta para uma conta aberta da compra elegível e para o seu lançamento, na mesma categoria e competência.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_ajuste_estreito before insert on fv2_ajuste for each row execute function fv2_ajuste_estreito();

-- 8) Barreira de POSIÇÃO (0018/0031/0036): IDÊNTICA, reconhecendo as formas estreitas desta migração.
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  -- 0037: operação ESTREITA de conta (competência, ajuste de valor, cancelamento) reconhecida na forma EXATA (fv2_forma_estreita_da_conta)
  if tg_table_name = 'fv2_obrigacao' then
    if fv2_forma_estreita_da_conta(old, new) is not null then
      return new;
    end if;
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

-- 9) Barreira de AÇÕES do lançamento (0014/0036): IDÊNTICA, com as ações estreitas desta migração nas listas.
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
    -- 0037: + mover_competencia/cancelar_conta_a_pagar (a forma é conferida por fv2_lancamento_operacao_estreita)
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar',
                              'financeiro_v2.mover_competencia_conta_a_pagar', 'financeiro_v2.cancelar_conta_a_pagar']) then
      raise exception 'Financeiro v2: alterar o lançamento exige cancelar, corrigir ou revisar.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- 0037: + reclassificar_conta_a_pagar (só a compra elegível: fv2_lancamento_operacao_estreita)
  if not fv2_tem_acao(array['financeiro_v2.reclassificar', 'financeiro_v2.reclassificar_conta_a_pagar']) then
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

-- 10) Forma do ENCARGO (0031): IDÊNTICA, deixando o ajuste estreito (fora da categoria de juros) para os gatilhos desta migração.
create or replace function fv2_juros_documental() returns trigger language plpgsql as $$
declare
  o record;
  l record;
begin
  if not fv2_so_registra_juros() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;
    -- 0037: ajuste ESTREITO de valor/cancelamento (fora da categoria de juros): conferido pelos gatilhos da 0037
    if new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' and (fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')) then
      return new;
    end if;
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or new.retido_no_repasse then
      raise exception 'Financeiro v2: o encargo do pagamento é uma despesa ativa na categoria oficial de juros e multas.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_ajuste
  -- 0037: ajuste ESTREITO (lançamento fora da categoria de juros): conferido por fv2_ajuste_estreito
  if (fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar')) and coalesce((select x.categoria_codigo from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id), '') <> 'JUROS_E_MULTAS_DE_FORNECEDORES' then
    return new;
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos <= 0 or new.lancamento_id is null then
    raise exception 'Financeiro v2: o encargo é um ajuste positivo de conta a pagar, com seu lançamento.' using errcode = '42501';
  end if;
  select x.* into o from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into l from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if o.id is null or l.id is null or l.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or l.valor_centavos <> new.valor_centavos then
    raise exception 'Financeiro v2: o encargo aponta para a conta e para o lançamento de juros e multas com o mesmo valor.' using errcode = '42501';
  end if;
  if new.valor_centavos * 10 > o.valor_base_centavos then
    raise exception 'Financeiro v2: encargo acima de 10%% do valor da conta exige uma pessoa autorizada.' using errcode = '42501';
  end if;
  return new;
end $$;

-- 12) Correção de lançamento (0036): IDÊNTICA, mas só atua quando a DESCRIÇÃO muda (as demais formas são das barreiras da 0037).
create or replace function fv2_correcao_de_lancamento() returns trigger language plpgsql as $$
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  -- 0037: a descrição NÃO mudou ⇒ não é correção cadastral (reclassificação, competência, cancelamento: conferidos pelas barreiras da 0037)
  if old.descricao is not distinct from new.descricao then
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

-- 11) Contas estreitas (0030/0033/0035): IDÊNTICA, aceitando o lançamento de AJUSTE estreito (conferido pelos gatilhos desta migração).
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
    -- 0037: + ajuste ESTREITO de valor/cancelamento de parcela (forma conferida pelos gatilhos da 0037)
    if new.origem->>'tipo' = 'AJUSTE' and ((documental and fv2_tem_acao(array['financeiro_v2.registrar_juros'])) or (fv2_pode_estreita('financeiro_v2.ajustar_conta_a_pagar') or fv2_pode_estreita('financeiro_v2.cancelar_conta_a_pagar'))) then
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
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0037_operacoes_de_conta_a_pagar.sql', 'd35d12cca2c55001cdf8925cc640bcfaee8a94e02b92ba008e799150d1255e44', 'd35d12cca2c55001cdf8925cc640bcfaee8a94e02b92ba008e799150d1255e44');

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
  if n <> 37 then raise exception 'FV2 pós: % migrações registradas (esperado 37)', n; end if;
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
