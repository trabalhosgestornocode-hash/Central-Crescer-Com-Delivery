-- Rollback da 125 — recria o índice "uma conexão viva por unidade".
-- RECUSA-SE se alguma unidade já tiver mais de uma conexão viva (o índice não poderia ser criado): revogue a conexão extra
-- explicitamente (ação supervisionada) antes. Nada é apagado por este script. Idempotente.

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from ifood_conexoes where status <> 'revogada' group by unidade_id having count(*) > 1) then
    raise exception '125_rollback: ha unidade com mais de uma conexao viva; revogue a extra antes de recriar o indice.';
  end if;
end $$;

create unique index if not exists uq_ifood_conexao_unidade_viva
  on ifood_conexoes(unidade_id) where status <> 'revogada';

commit;
