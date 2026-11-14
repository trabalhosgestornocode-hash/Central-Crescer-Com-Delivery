-- =====================================================================================================================
-- Financeiro v2 — migração 0014: RECLASSIFICAÇÃO COM PERMISSÃO PRÓPRIA (Execução 08C)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Mudar a categoria de um lançamento passa a exigir `financeiro_v2.reclassificar` — também NO BANCO, linha a linha:
--   * a ação nova entra no catálogo; NENHUMA concessão existente a recebe (migração restritiva);
--   * gatilho em fv2_lancamento: mudança de categoria/classificação/natureza exige `reclassificar` e não pode mudar, na
--     MESMA gravação, valor, competência, situação, origem, canal, data, descrição ou fonte (a identidade do fato econômico
--     é preservada); receita nunca vira não-receita (nem o contrário); a natureza só muda despesa ⇄ patrimonial em conta a
--     pagar; a categoria de destino precisa existir no escopo, aceitar lançamento, estar ativa e não ser provisória;
--   * mudanças que NÃO tocam a categoria continuam exigindo cancelar/corrigir/revisar — `reclassificar` sozinho não
--     altera valor nem cancela nada;
--   * a evidência vinculada na reclassificação (vínculo documental) e o histórico aceitam a ação nova;
--   * para ALCANÇAR linhas referenciadas (SELECT ... FOR UPDATE da competência, do documento), o USING de alteração de
--     todas as tabelas passa a incluir a ação nova — a ALTERAÇÃO em si continua decidida pelo WITH CHECK de cada tabela.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar"]'::jsonb);

-- 2) USING de alteração (alcançar a linha) com a ação nova, em todas as tabelas com política por ação.
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) Lançamento: a ação nova pode ALTERAR a linha (o gatilho decide O QUE pode mudar).
alter policy fv2_lancamento_alterar on fv2_lancamento with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.reclassificar'])));

-- 4) Evidência da reclassificação (vínculo documento → lançamento) e histórico.
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 5) Gatilho: o que a reclassificação pode (e não pode) mudar, conferido no banco.
create function fv2_exigir_acao_do_lancamento() returns trigger language plpgsql as $$
declare
  cat record;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if (new.categoria_id, new.categoria_codigo, new.classificacao, new.natureza)
       is not distinct from (old.categoria_id, old.categoria_codigo, old.classificacao, old.natureza) then
    -- Sem mudança de categoria: as ações de sempre. `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar']) then
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
create trigger fv2_lancamento_acao before update on fv2_lancamento for each row execute function fv2_exigir_acao_do_lancamento();
