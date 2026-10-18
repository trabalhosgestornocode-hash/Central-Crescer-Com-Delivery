-- Rollback da 124 — remove finalidade/ambiente das conexões, o índice por (unidade, finalidade) e os triggers de coerência.
--
-- RECUSA-SE (sem alterar nada) se existir conexão VIVA rotulada (finalidade <> 'legado'; linhas revogadas são só histórico) ou sessão OAuth com finalidade:
-- rotular de volta para 'legado' é uma ação supervisionada (database/operacoes/ifood-conexao-rotular-rollback.sql) e, com duas
-- conexões vivas na mesma unidade, o índice antigo (uq_ifood_conexao_unidade_viva, se a 125 o tiver removido) precisa ser recriado
-- (125_rollback.sql) ANTES — senão esta limpeza apagaria a distinção entre as conexões. Idempotente.

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'ifood_conexoes' and column_name = 'finalidade') then
    if exists (select 1 from ifood_conexoes where finalidade <> 'legado' and status <> 'revogada') then
      raise exception '124_rollback: ha conexao rotulada (finalidade <> legado). Rotule de volta para legado antes (operacoes/ifood-conexao-rotular-rollback.sql).';
    end if;
    if exists (select 1 from ifood_conexoes where status <> 'revogada' group by unidade_id having count(*) > 1) then
      raise exception '124_rollback: ha unidade com mais de uma conexao viva. Revogue a extra ou aplique 125_rollback.sql antes.';
    end if;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'ifood_oauth_sessoes' and column_name = 'finalidade') then
    if exists (select 1 from ifood_oauth_sessoes where finalidade is not null and status = 'pending') then
      raise exception '124_rollback: ha sessao OAuth pendente com finalidade. Aguarde expirar ou cancele-a antes.';
    end if;
  end if;
end $$;

drop trigger if exists trg_ifood_credencial_finalidade on ifood_credenciais;
drop trigger if exists trg_ifood_conexao_finalidade on ifood_conexoes;
do $$
begin
  if to_regclass('ifood_conexao_lojas') is not null then
    execute 'drop trigger if exists trg_ifood_loja_finalidade on ifood_conexao_lojas';
  end if;
end $$;
drop function if exists ifood_credencial_confere_finalidade();
drop function if exists ifood_conexao_confere_finalidade();
drop function if exists ifood_conexao_loja_confere_finalidade();

drop index if exists uq_ifood_conexao_unidade_finalidade_viva;
alter table ifood_conexoes drop constraint if exists ck_ifood_conexao_finalidade_ambiente;
alter table ifood_conexoes drop constraint if exists ck_ifood_conexao_ambiente;
alter table ifood_conexoes drop constraint if exists ck_ifood_conexao_finalidade;
alter table ifood_conexoes drop column if exists ambiente;
alter table ifood_conexoes drop column if exists finalidade;
alter table ifood_oauth_sessoes drop constraint if exists ck_ifood_oauth_sessao_finalidade;
alter table ifood_oauth_sessoes drop column if exists finalidade;

commit;
