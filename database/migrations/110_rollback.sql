-- ROLLBACK da MIGRATION 110 — remove as telas de exibição e o pareamento. ABORTA se houver tela ativa (não
-- revogada e não expirada): desligar telas em uso sem aviso deixaria TVs das lojas em branco. Para forçar, revogue
-- antes as telas pela Central (ou exibicao_dispositivos_revogar) e rode de novo. Não toca em `unidades` além de
-- remover o gatilho que esta migration criou.
begin;

do $$
begin
  if to_regclass('public.dispositivos_exibicao') is not null
     and exists (select 1 from public.dispositivos_exibicao where revogado_em is null and expira_em > now()) then
    raise exception 'ROLLBACK 110 abortado: há telas de exibição ativas. Revogue-as antes.';
  end if;
end;
$$;

drop trigger if exists trg_exibicao_unidade_alterada on unidades;
drop function if exists exibicao_limpar(integer);
drop function if exists exibicao_dispositivos_revogar(uuid, uuid, uuid, uuid);
drop function if exists exibicao_dispositivo_renomear(uuid, uuid, uuid, text);
drop function if exists exibicao_dispositivos_listar(uuid, uuid);
drop function if exists exibicao_dispositivo_desconectar(text);
drop function if exists exibicao_dispositivo_rotacionar(uuid, text, text);
drop function if exists exibicao_dispositivo_resolver(text, text, text);
drop function if exists exibicao_pareamento_cancelar(text);
drop function if exists exibicao_pareamento_consumir(text, text, integer, integer, integer);
drop function if exists exibicao_pareamento_consultar(text);
drop function if exists exibicao_pareamento_aprovar(text, uuid, uuid, uuid, uuid, text, text);
drop function if exists exibicao_pareamento_estado(text);
drop function if exists exibicao_pareamento_iniciar(text, text, integer, text, text);
drop table if exists pareamentos_exibicao;
drop table if exists dispositivos_exibicao;
drop function if exists exibicao_unidade_elegivel(uuid, uuid);
drop function if exists exibicao_unidade_alterada();
drop function if exists exibicao_conferir_tenant();

commit;
