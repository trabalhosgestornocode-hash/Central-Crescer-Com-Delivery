-- Rollback da 145 — remove a conexão compartilhada e volta a camada Foody ao desenho da 144 (uma unidade por conexão).
--
-- FAIL-CLOSED: se já existir QUALQUER dado do modo compartilhado (destino, decisão de triagem, pedido em unidade de destino,
-- pedido em triagem ou pedido desativado por roteamento), o rollback RECUSA — apagar isso perderia a trilha de auditoria e
-- deixaria pedidos de uma organização sem o vínculo que autorizou a cópia. Nesse caso: revogue os destinos, exporte o que
-- precisar e rode o rollback da 144 (remove a camada inteira). Idempotente quando não há dado compartilhado.
--   copy (select * from foody_destinos_eventos order by criado_em) to stdout with csv header;

begin;
set local lock_timeout = '5s';

do $$
declare tem boolean;
begin
  -- A 146 (administração da conexão) depende da 145: desfaça a 146 primeiro.
  if to_regclass('public.foody_conexoes_eventos') is not null then
    raise exception 'rollback 145 recusado: a migration 146 está aplicada. Rode o 146_rollback.sql antes (ou o rollback da 144).' using errcode = '55000';
  end if;
  -- IFs aninhados: a expressão inteira é preparada de uma vez, e a tabela pode já não existir (rollback idempotente).
  if to_regclass('public.foody_conexao_destinos') is not null then
    if exists (select 1 from foody_conexao_destinos) then
      raise exception 'rollback 145 recusado: existem destinos de compartilhamento (auditoria). Use o rollback da 144.' using errcode = '55000';
    end if;
  end if;
  if to_regclass('public.foody_triagem_decisoes') is not null then
    if exists (select 1 from foody_triagem_decisoes) then
      raise exception 'rollback 145 recusado: existem decisões de triagem (auditoria). Use o rollback da 144.' using errcode = '55000';
    end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'foody_pedidos' and column_name = 'destino_id') then
    -- SQL dinâmico: as colunas só existem com a 145 aplicada.
    if exists (select 1 from foody_pedidos) then
      execute 'select exists (select 1 from foody_pedidos where destino_id is not null or operacao = ''triagem'' or not roteamento_ativo)' into tem;
      if tem then
        raise exception 'rollback 145 recusado: existem pedidos distribuídos/triagem. Use o rollback da 144.' using errcode = '55000';
      end if;
    end if;
  end if;
end $$;

-- Pedidos: triggers, índices, constraints e colunas da 145; volta as constraints da 144.
drop trigger if exists trg_foody_pedidos_valida_destino on foody_pedidos;
drop index if exists uq_foody_pedidos_conexao_uid_ativo;
drop index if exists idx_foody_pedidos_conexao_competencia;
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_inativo_minimo;
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_triagem;
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_outra_operacao_minima;
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_operacao;
alter table foody_pedidos drop constraint if exists foody_pedidos_operacao_check;
alter table foody_pedidos add constraint foody_pedidos_operacao_check
  check (operacao in ('subway', 'acai_no_grau', 'revisao_necessaria'));
alter table foody_pedidos add constraint ck_foody_pedidos_outra_operacao_minima check (
  operacao in ('subway', 'revisao_necessaria')
  or (detalhes_pedido is null and valor_total is null and taxa_entrega is null and forma_pagamento is null
      and cancelamento_razao is null and cancelamento_justificativa is null));
alter table foody_pedidos drop column if exists catalogo_versao;
alter table foody_pedidos drop column if exists triagem_motivo;
alter table foody_pedidos drop column if exists roteamento_motivo;
alter table foody_pedidos drop column if exists roteamento_ativo;
alter table foody_pedidos drop column if exists destino_id;
alter table foody_pedidos drop column if exists conexao_id;

alter table foody_sync_execucoes drop column if exists fechamentos_pendentes;
alter table foody_sync_execucoes drop column if exists fechamentos;
alter table foody_sync_execucoes drop column if exists catalogo_versao;
alter table foody_sync_execucoes drop column if exists distribuicao;
alter table foody_sync_execucoes drop column if exists pedidos_triagem;

drop trigger if exists trg_foody_fech_destino_ativo on foody_fechamentos_logisticos;
drop trigger if exists trg_foody_conexoes_revogar_destinos on foody_conexoes;

drop table if exists foody_triagem_decisoes;
drop table if exists foody_destinos_eventos;
drop table if exists foody_conexao_destinos;

drop function if exists foody_triagem_decisao_validar();
drop function if exists foody_fech_exigir_destino_ativo();
drop function if exists foody_pedido_validar_destino();
drop function if exists foody_destino_auditar();
drop function if exists foody_conexao_revogar_destinos();
drop function if exists foody_destino_validar();
drop function if exists foody_eh_admin_da_organizacao(uuid, uuid);

-- Vínculo com a execução: versão EXATA da 144 (mesma unidade).
create or replace function foody_validar_vinculo_execucao() returns trigger
language plpgsql set search_path = public as $$
declare
  col text := tg_argv[0];
  ref_id uuid;
begin
  ref_id := (to_jsonb(new) ->> col)::uuid;
  if ref_id is null then return new; end if;
  if not exists (select 1 from foody_sync_execucoes e where e.id = ref_id and e.unidade_id = new.unidade_id) then
    raise exception '%: % aponta para execução de outra unidade', tg_table_name, col using errcode = '42501';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
commit;
