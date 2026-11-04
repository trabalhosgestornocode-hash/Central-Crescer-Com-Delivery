-- Rollback da 146 — remove a ADMINISTRAÇÃO da conexão Foody pela tela (volta ao desenho da 145).
--
-- FAIL-CLOSED: se já existir QUALQUER evento de conexão (auditoria de quem cadastrou, ativou, pausou ou revogou), o rollback
-- RECUSA — apagar a trilha esconderia quem mexeu no token. Nesse caso exporte e use o rollback da 144 (remove a camada inteira):
--   copy (select * from foody_conexoes_eventos order by criado_em) to stdout with csv header;
-- Não mexe em conexões, pedidos, destinos nem fechamentos. Idempotente.

begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.foody_conexoes_eventos') is not null then
    if exists (select 1 from foody_conexoes_eventos) then
      raise exception 'rollback 146 recusado: existem eventos de administração da conexão (auditoria). Use o rollback da 144.' using errcode = '55000';
    end if;
  end if;
end $$;

drop function if exists public.foody_conexao_administrar(text, uuid, uuid, uuid, text, text, text, text);
do $$ begin
  if to_regclass('public.foody_conexoes') is not null then
    execute 'drop trigger if exists trg_foody_conexoes_guardas on public.foody_conexoes';
    execute 'drop trigger if exists trg_foody_conexoes_auditar_transferencia on public.foody_conexoes';
  end if;
end $$;
drop table if exists public.foody_conexoes_eventos;
drop function if exists public.foody_conexao_auditar_transferencia();
drop function if exists public.foody_conexao_guardas();
notify pgrst, 'reload schema';
commit;
