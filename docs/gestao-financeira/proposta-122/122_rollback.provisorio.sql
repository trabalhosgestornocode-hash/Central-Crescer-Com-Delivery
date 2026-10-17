-- PROVISÓRIO — rollback do 122 (conciliação + períodos + cancelamento de transferência). Recusa se houver DADOS nas estruturas novas.
-- DEPOIS de rodar este rollback, REAPLIQUE o 121: ele restaura (create or replace) fin_lancamentos_guarda e fin_confirmar_importacao
-- e devolve o EXECUTE de fin_desvincular_transferencia ao service_role.
do $$
begin
  if to_regclass('public.fin_referencias') is not null then
    if exists (select 1 from fin_referencias) or exists (select 1 from fin_conciliacao_resolucoes) or exists (select 1 from fin_sangria_excecoes) or exists (select 1 from fin_config)
       or exists (select 1 from fin_lancamentos where revisao_motivos <> '{}') or exists (select 1 from fin_contas where canal_referencia is not null)
       or exists (select 1 from fin_periodos where status <> 'aberto' or snapshot is not null)
       or exists (select 1 from fin_transferencias where status <> 'vinculada') then
      raise exception 'rollback recusado: ha dados de conciliacao/periodos/cancelamento; exporte e descarte de forma supervisionada';
    end if;
  end if;
  drop trigger if exists trg_fin_par_status_consistente on fin_lancamentos;
  drop trigger if exists trg_fin_transferencias_guarda on fin_transferencias;
  drop trigger if exists trg_fin_saldos_periodo on fin_saldos_abertura;
  drop trigger if exists trg_fin_periodos_guarda on fin_periodos;
  drop function if exists fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text);
  drop function if exists fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text);
  drop function if exists fin_par_status_consistente();
  drop function if exists fin_transferencias_guarda();
  drop function if exists fin_reabrir_periodo(uuid,uuid,uuid,date,int,text);
  drop function if exists fin_fechar_periodo(uuid,uuid,uuid,date,int,text,jsonb,int,boolean);
  drop function if exists fin_abrir_periodo(uuid,uuid,uuid,date);
  drop function if exists fin_fingerprint_periodo(uuid,uuid,date);
  drop table if exists fin_config, fin_sangria_excecoes, fin_conciliacao_resolucoes, fin_referencias cascade;
  drop function if exists fin_guarda_periodo_data();
  drop function if exists fin_periodos_guarda();
  -- o 121 recria fin_lancamentos_guarda sem depender desta; só depois disto é seguro remover a função de trava
  drop function if exists fin_periodo_travar_e_checar(uuid,uuid,date) cascade;
  alter table fin_lancamentos drop constraint if exists fin_lancamentos_importacao_fk;
  alter table fin_transferencias drop constraint if exists fin_transferencias_cancelamento_check;
  alter table fin_transferencias drop constraint if exists fin_transferencias_status_check;
  alter table fin_transferencias drop column if exists motivo_cancelamento, drop column if exists cancelada_em, drop column if exists cancelada_por, drop column if exists status;
  alter table fin_lancamentos drop column if exists revisao_motivos;
  alter table fin_contas drop column if exists canal_referencia;
  alter table fin_periodos drop column if exists versao;
end $$;
