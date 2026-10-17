begin;
set local lock_timeout = '5s';
-- Rollback da 121 — domínio financeiro. Rodar ANTES do rollback da 120. Recusa se houver DADOS (lançamentos, saldos, importações confirmadas, períodos).
-- Para descartar dados de verdade, é uma operação supervisionada e com backup — nunca automática. Checagem e remoção no MESMO bloco.
do $$
begin
  if to_regclass('public.fin_lancamentos') is not null then
    if exists (select 1 from fin_lancamentos) or exists (select 1 from fin_saldos_abertura) or exists (select 1 from fin_periodos)
       or exists (select 1 from fin_importacoes) or exists (select 1 from fin_plano_contas) or exists (select 1 from fin_contas) then
      raise exception 'rollback recusado: o dominio financeiro contem dados; exporte e descarte de forma supervisionada';
    end if;
  end if;
  -- A auditoria é imutável por gatilho; sem dados de domínio, só restam linhas de auditoria de estruturas vazias. Remove o gatilho para dropar.
  if to_regclass('public.fin_auditoria') is not null then
    drop trigger if exists trg_fin_auditoria_imutavel on fin_auditoria;
    drop trigger if exists trg_fin_auditoria_truncate on fin_auditoria;
  end if;
  drop function if exists fin_confirmar_importacao(uuid,uuid,uuid,uuid);
  drop function if exists fin_desvincular_transferencia(uuid,uuid,uuid,uuid);
  drop function if exists fin_vincular_transferencia(uuid,uuid,uuid,uuid,uuid);
  drop function if exists fin_criar_transferencia(uuid,uuid,uuid,uuid,uuid,bigint,date,text,uuid);
  drop table if exists fin_transferencias, fin_importacoes, fin_periodos, fin_saldos_abertura, fin_lancamentos, fin_contas, fin_plano_contas, fin_auditoria cascade;
  drop function if exists fin_auditoria_imutavel();
  drop function if exists fin_auditar();
  drop function if exists fin_transferencias_validar();
  drop function if exists fin_plano_contas_guarda();
  drop function if exists fin_lancamentos_guarda();
  drop function if exists fin_validar_escopo();
  drop function if exists fin_touch_updated_at();
end $$;

commit;
