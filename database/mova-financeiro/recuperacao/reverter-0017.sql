-- MOVA — RECUPERAÇÃO da 0017_mova_conversa_contexto (remove a coluna de contexto da conversa; o resto da continuidade não muda).
-- Uma transação; só DEFINIÇÕES (o contexto é efêmero, expira em minutos, e não é histórico).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql') then raise exception 'MOVA recuperação: 0017 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0017_mova_conversa_contexto.sql') then raise exception 'MOVA recuperação: há migrações depois da 0017'; end if;
end $$;
alter table mova.conversa_ativa drop column contexto;
delete from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql';
