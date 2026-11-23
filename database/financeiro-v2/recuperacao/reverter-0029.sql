-- Financeiro v2 — RECUPERAÇÃO da 0029_pagamento_por_comprovante (escrito à mão a partir das definições LIDAS da produção
-- em 22/11/2026, antes da aplicação). Desfaz SÓ o que a 0029 mudou e volta ao estado exato da 0028.
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação (psql -v ON_ERROR_STOP=1 -1 -f reverter-0029.sql).
-- ABORTA, sem mudar nada, se já existir qualquer pagamento por comprovante ou concessão com a nova ação: nesse caso não há
-- "voltar atrás" sem decisão humana sobre esses registros (nada financeiro é apagado por este arquivo).

set local search_path = financeiro_v2, pg_catalog;
do $$ declare n int; begin
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 recuperação: não aplicar como superusuário'; end if;
  -- As conferências abaixo precisam ver TODAS as linhas (RLS forçada): sem BYPASSRLS a contagem poderia dar zero falsamente.
  if not (select rolbypassrls from pg_roles where rolname = current_user) then raise exception 'FV2 recuperação: o executor precisa de BYPASSRLS (o postgres do Supabase tem)'; end if;
  if not exists (select 1 from financeiro_v2.fv2_migracao where nome = '0029_pagamento_por_comprovante.sql') then raise exception 'FV2 recuperação: 0029 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from financeiro_v2.fv2_migracao where nome > '0029_pagamento_por_comprovante.sql') then raise exception 'FV2 recuperação: há migrações depois da 0029 — desfazer na ordem inversa'; end if;
  select count(*) into n from financeiro_v2.fv2_liquidacao where movimentacao_id is null;
  if n > 0 then raise exception 'FV2 recuperação: % pagamento(s) por comprovante sem saída — decidir antes (estornar ou conciliar); nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.baixar_por_comprovante';
  if n > 0 then raise exception 'FV2 recuperação: % concessão(ões) com baixar_por_comprovante — revogar antes; nada foi feito', n; end if;
end $$;

grant fv2_guardiao to current_user;

-- 1. gatilho e função novos
drop trigger if exists fv2_liquidacao_por_comprovante on fv2_liquidacao;
drop function if exists fv2_pagamento_por_comprovante();

-- 2. funções de volta às definições da 0028 (lidas da produção)
CREATE OR REPLACE FUNCTION financeiro_v2.fv2_tg_liquidacao()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, new.alvo_tipo, new.alvo_id);
  perform fv2_conferir_movimentacao(new.organizacao_id, new.unidade_id, new.movimentacao_id);
  return null;
end $function$;

CREATE OR REPLACE FUNCTION financeiro_v2.fv2_vinculo_extrato_liquidacao()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

-- 3. coluna e restrições
alter table fv2_liquidacao drop constraint if exists fv2_liquidacao_sem_movimentacao;
alter table fv2_liquidacao alter column movimentacao_id set not null;
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos", "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento"]'::jsonb);

-- 4. políticas de RLS de volta às expressões da 0028 (lidas da produção)
do $$ declare
  todas text := $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao)$q$;
begin
  execute format('alter policy fv2_documento_alterar on financeiro_v2.fv2_documento using (%s) with check (%s)', todas, $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.registrar'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_obrigacao_alterar on financeiro_v2.fv2_obrigacao using (%s) with check (%s)', todas, $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.cancelar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_movimentacao_alterar on financeiro_v2.fv2_movimentacao using (%s) with check (%s)', todas, $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_liquidacao_alterar on financeiro_v2.fv2_liquidacao using (%s) with check (%s)', todas, $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.cancelar'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_liquidacao_incluir on financeiro_v2.fv2_liquidacao with check (%s)', $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_vinculo_documental_incluir on financeiro_v2.fv2_vinculo_documental with check (%s)', $q$( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao)$q$);
  execute format('alter policy fv2_historico_incluir on financeiro_v2.fv2_historico with check (%s)', format($q$(%s OR (( SELECT financeiro_v2.fv2_em_provisionamento() AS fv2_em_provisionamento) AND (registro_tipo = 'CONCESSAO'::text)) OR ((CURRENT_USER = 'fv2_guardiao'::name) AND (registro_tipo = 'CONCESSAO'::text)))$q$, todas));
end $$;

-- 5. registro
delete from fv2_migracao where nome = '0029_pagamento_por_comprovante.sql';
revoke fv2_guardiao from current_user;

do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'fv2_liquidacao_por_comprovante') then raise exception 'FV2 recuperação pós: gatilho ainda existe'; end if;
  if (select is_nullable from information_schema.columns where table_schema = 'financeiro_v2' and table_name = 'fv2_liquidacao' and column_name = 'movimentacao_id') <> 'NO' then raise exception 'FV2 recuperação pós: movimentacao_id ainda aceita nulo'; end if;
  if (select count(*) from financeiro_v2.fv2_migracao) <> 28 then raise exception 'FV2 recuperação pós: esperado 28 migrações registradas'; end if;
end $$;
