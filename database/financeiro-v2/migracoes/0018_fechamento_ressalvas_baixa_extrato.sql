-- =====================================================================================================================
-- Financeiro v2 — migração 0018: HOMOLOGAÇÃO COM RESSALVAS (F-1) e BAIXA POR SAÍDA DO EXTRATO (F-2) — Execução 08E
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- F-1 (espelho de dominio/ressalvas.js + aplicacao/competencias.js), linha a linha em fv2_competencia:
--   * não se cria competência já homologada;
--   * homologar não reescreve as pendências documentadas;
--   * do PRELIMINAR só se homologa sem ressalvas; do COM_PENDENCIAS, cada ressalva precisa estar documentada (com
--     decisão e "o que falta"/evidência) e ter natureza admissível (efeito no resultado SEM_EFEITO ou CONHECIDO com valor);
--   * verificações OBJETIVAS que o banco faz sozinho, sem confiar na aplicação: nenhum lançamento ativo da competência
--     em categoria provisória ("a classificar") e nenhuma saída do período sem vínculo — esses distorcem o resultado de
--     modo ainda não esclarecido e nunca viram ressalva.
--
-- F-2: ação nova `financeiro_v2.vincular_pagamento` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe).
--   * quem só vincula NÃO insere movimentação (a política de inclusão de fv2_movimentacao não a lista): vincular nunca
--     cria saída nova; também não insere lançamento (nunca cria despesa);
--   * a liquidação gravada só por `vincular_pagamento` precisa apontar para uma SAÍDA válida, que já existia ANTES desta
--     transação, e para uma conta a pagar; e precisa carregar a evidência (documento) ou uma conciliação confirmada;
--   * na saída, só pode AUMENTAR o valor alocado; na conta, só mudar a posição (liquidado, saldo, situação).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento"]'::jsonb);

-- 2) USING de alteração (alcançar linhas referenciadas, ex.: SELECT ... FOR UPDATE da saída e das contas).
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar', 'enviar_documento', 'vincular_pagamento']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) O que `vincular_pagamento` pode gravar: liquidação (inclusão), posição da conta e alocado da saída (alteração),
--    vínculo documental da evidência e histórico. NUNCA movimentação nova, lançamento ou obrigação nova.
alter policy fv2_liquidacao_incluir on fv2_liquidacao with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_movimentacao_alterar on fv2_movimentacao with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.registrar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_obrigacao_alterar on fv2_obrigacao with check (
  (select fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento', 'financeiro_v2.vincular_pagamento'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento',
    'financeiro_v2.vincular_pagamento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 4) Barreiras linha a linha para quem grava SÓ com `vincular_pagamento`.
create or replace function fv2_so_vincula() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.corrigir'])
$$;

create or replace function fv2_vinculo_extrato_liquidacao() returns trigger language plpgsql as $$
declare
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_vincula() then
    return new;
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
create trigger fv2_liquidacao_vinculo_extrato before insert on fv2_liquidacao for each row execute function fv2_vinculo_extrato_liquidacao();

create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_movimentacao_vinculo_extrato before update on fv2_movimentacao for each row
  execute function fv2_vinculo_extrato_posicao('{alocado_centavos}', 'alocado_centavos');
create trigger fv2_obrigacao_vinculo_extrato before update on fv2_obrigacao for each row
  execute function fv2_vinculo_extrato_posicao('{liquidado_centavos,saldo_centavos,situacao_financeira}', 'liquidado_centavos');

-- 5) F-1 no banco: homologação só com pendências tratadas.
create or replace function fv2_homologacao_com_ressalvas() returns trigger language plpgsql as $$
declare
  h jsonb;
  r jsonb;
  doc jsonb;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.estado <> 'FECHAMENTO_HOMOLOGADO' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: competência não nasce homologada — passe pelo fechamento preliminar.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_HOMOLOGADO' then
    return new;
  end if;
  h := new.extras->'homologacao';
  if h is null or jsonb_typeof(h) <> 'object' or jsonb_typeof(h->'ressalvas') <> 'array' or (h->>'de') is distinct from old.estado
     or coalesce((h->>'pendenciasNaoTratadas')::int, -1) <> 0 then
    raise exception 'Financeiro v2: homologação sem a avaliação das pendências (nenhuma pendência pode estar sem tratamento).' using errcode = 'FV040';
  end if;
  if new.pendencias is distinct from old.pendencias then
    raise exception 'Financeiro v2: homologar não reescreve as pendências documentadas.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_PRELIMINAR' and jsonb_array_length(h->'ressalvas') > 0 then
    raise exception 'Financeiro v2: ressalvas exigem o fechamento com pendências documentadas antes da homologação.' using errcode = 'FV040';
  end if;
  for r in select * from jsonb_array_elements(h->'ressalvas') loop
    if coalesce(r->>'efeitoNoResultado', '') not in ('SEM_EFEITO', 'CONHECIDO')
       or (r->>'efeitoNoResultado' = 'CONHECIDO' and (r->'valorCentavos' is null or jsonb_typeof(r->'valorCentavos') <> 'number')) then
      raise exception 'Financeiro v2: ressalva inadmissível (efeito no resultado indeterminado): %', r->>'chave' using errcode = 'FV040';
    end if;
    select d into doc from jsonb_array_elements(old.pendencias) d where d->>'chave' = r->>'chave' limit 1;
    if doc is null or length(btrim(coalesce(doc->>'decisao', ''))) = 0
       or (length(btrim(coalesce(doc->>'documentacaoFaltante', ''))) = 0 and jsonb_array_length(coalesce(doc->'evidenciaDocumentoIds', '[]'::jsonb)) = 0) then
      raise exception 'Financeiro v2: ressalva sem documentação suficiente no fechamento: %', r->>'chave' using errcode = 'FV040';
    end if;
  end loop;
  -- Verificações objetivas, independentes do que a aplicação informa.
  if exists (select 1 from fv2_lancamento l where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id
              and l.competencia = new.competencia and l.situacao = 'ATIVO' and l.categoria_codigo in ('DESPESAS_A_CLASSIFICAR', 'DESCONTOS_A_CLASSIFICAR')) then
    raise exception 'Financeiro v2: há lançamento da competência em categoria provisória ("a classificar"): não homologa.' using errcode = 'FV040';
  end if;
  if exists (select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id
              and to_char(m.data_efetiva, 'YYYY-MM') = new.competencia and m.sentido = 'SAIDA' and m.situacao = 'VALIDA'
              and m.alocado_centavos < m.valor_centavos and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null) then
    raise exception 'Financeiro v2: há saída bancária do período sem vínculo (pode ser despesa não reconhecida): não homologa.' using errcode = 'FV040';
  end if;
  return new;
end $$;
create trigger fv2_competencia_ressalvas before insert or update on fv2_competencia for each row execute function fv2_homologacao_com_ressalvas();
