-- =====================================================================================================================
-- Financeiro v2 — migração 0024: CANAL 99FOOD e OPERADORAS de pagamento (Fase 02, doc 40)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * canal NOVENTA_E_NOVE_FOOD passa a ser aceito (lançamento, venda, recebível, cadastro de canais). Os canais existentes
--     continuam iguais e nenhum registro é alterado.
--   * processadores PAGBANK, MAQUININHA_IFOOD (maquininha do iFood usada no balcão: operadora, não canal) e
--     NOVENTA_E_NOVE_FOOD (repasse do marketplace 99Food) passam a ser aceitos (pagamento, recebível, cadastro).
--   * Operadoras, tabelas de taxas e taxa estimada vivem nas extensões (`extras`) já existentes: nenhuma coluna nova.
--   * Só troca restrições CHECK por versões mais amplas: nenhuma linha atual deixa de valer.
-- =====================================================================================================================

do $$
declare
  r record;
begin
  -- Remove as CHECK antigas de canal/processador (nomes gerados pelo PostgreSQL) — identificadas pela definição.
  for r in
    select c.conname, t.relname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'c'
       and n.nspname = current_schema()
       and t.relname in ('fv2_lancamento', 'fv2_venda', 'fv2_pagamento_venda', 'fv2_recebivel', 'fv2_canal_processador')
       and pg_get_constraintdef(c.oid) like '%ANOTA_AI%'
  loop
    execute format('alter table %I drop constraint %I', r.relname, r.conname);
  end loop;
end $$;

-- A varredura acima apaga TODA CHECK que cita 'ANOTA_AI' nessas tabelas, e isso inclui a da origem da venda (SAIPOS, IFOOD,
-- ANOTA_AI, MANUAL), que não deve mudar. Ela volta aqui, idêntica à da fundação (0001): nenhuma linha atual a viola.
alter table fv2_venda add constraint fv2_venda_fonte_sistema_check
  check (fonte_sistema in ('SAIPOS', 'IFOOD', 'ANOTA_AI', 'MANUAL'));

alter table fv2_lancamento add constraint fv2_lancamento_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_venda add constraint fv2_venda_canal_valido
  check (canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_pagamento_venda add constraint fv2_pagamento_venda_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_canal_processador add constraint fv2_canal_processador_codigo_base_valido
  check ((papel = 'CANAL' and codigo_base in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'))
      or (papel = 'PROCESSADOR' and codigo_base in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO')));
