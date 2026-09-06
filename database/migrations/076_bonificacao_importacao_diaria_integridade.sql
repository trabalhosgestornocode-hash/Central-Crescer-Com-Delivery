-- Importação DIÁRIA apenas. Não modifica dados legados, fechamento, competência ou snapshot.
-- Aplicar antes do backend correspondente. Revisão e testes locais; NÃO aplicada em produção.
--
-- ROLLBACK: database/migrations/076_rollback.sql (dropa os 3 gatilhos/funções +
--   as 3 colunas de período; reexecutável; não toca em dado).
-- TESTE:   backend/test/bonificacao-importacao-postgres.test.js
--   (BM_IMPORT_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres — nunca produção).
-- IDEMPOTENTE: reexecutável (create or replace / drop if exists / add column if not exists).
begin;

alter table public.bonificacao_importacoes
  add column if not exists periodo_inicio date,
  add column if not exists periodo_fim date,
  add column if not exists periodo_fonte text;

create or replace function public.bonificacao_validar_documento_diario()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if TG_OP = 'UPDATE' then
    if row(new.organizacao_id,new.unidade_id,new.tipo_relatorio,new.data_lancamento,new.hash_arquivo,new.periodo_inicio,new.periodo_fim,new.periodo_fonte,new.status)
       is distinct from row(old.organizacao_id,old.unidade_id,old.tipo_relatorio,old.data_lancamento,old.hash_arquivo,old.periodo_inicio,old.periodo_fim,old.periodo_fonte,old.status) then
      raise exception 'A identidade e o período da importação são imutáveis. Registre um novo documento.' using errcode='23514';
    end if;
    return new;
  end if;
  if new.status <> 'concluida' then return new; end if;
  if new.hash_arquivo is null or new.hash_arquivo !~ '^[a-f0-9]{64}$'
     or new.data_lancamento is null or new.periodo_inicio is distinct from new.data_lancamento
     or new.periodo_fim is distinct from new.data_lancamento
     or new.periodo_fonte is null or new.periodo_fonte not in ('conteudo','confirmacao_usuario') then
    raise exception 'Importação diária exige hash e período de um único dia confirmado.' using errcode='23514';
  end if;
  if not exists(select 1 from public.unidades u where u.id=new.unidade_id and u.organizacao_id=new.organizacao_id) then
    raise exception 'Organização/unidade incompatíveis na importação.' using errcode='23514';
  end if;
  -- Serializa o documento dentro da unidade, inclusive se o tipo informado mudar.
  perform pg_advisory_xact_lock(hashtextextended(new.unidade_id::text || ':' || new.hash_arquivo, 0));
  if exists(select 1 from public.bonificacao_importacoes i where i.unidade_id=new.unidade_id
      and i.hash_arquivo=new.hash_arquivo and i.status='concluida') then
    raise exception 'Este documento já foi importado nesta unidade.' using errcode='23505';
  end if;
  if new.substituiu_importacao_id is not null and not exists (
    select 1 from public.bonificacao_importacoes i where i.id=new.substituiu_importacao_id
    and i.organizacao_id=new.organizacao_id and i.unidade_id=new.unidade_id
    and i.tipo_relatorio=new.tipo_relatorio and i.data_lancamento=new.data_lancamento
  ) then
    raise exception 'A importação substituída pertence a outro contexto ou dia.' using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_bonificacao_documento_diario on public.bonificacao_importacoes;
create trigger trg_bonificacao_documento_diario before insert or update on public.bonificacao_importacoes
for each row execute function public.bonificacao_validar_documento_diario();

create or replace function public.bonificacao_validar_vinculos_diarios()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare documento public.bonificacao_importacoes%rowtype; ref uuid; tipo text;
begin
  foreach tipo in array array['geral','loja'] loop
    ref := case when tipo='loja' then new.importacao_loja_id else new.importacao_geral_id end;
    if ref is null then continue; end if;
    select * into documento from public.bonificacao_importacoes where id=ref for update;
    if not found then raise exception 'Importação não encontrada.' using errcode='23514'; end if;
    if documento.organizacao_id is distinct from new.organizacao_id
       or documento.unidade_id is distinct from new.unidade_id
       or documento.tipo_relatorio::text is distinct from tipo
       or documento.status is distinct from 'concluida'
       or documento.data_lancamento is distinct from new.data
       or coalesce(documento.periodo_inicio,documento.data_lancamento) is distinct from new.data
       or coalesce(documento.periodo_fim,documento.data_lancamento) is distinct from new.data then
      raise exception 'A importação pertence a outro dia/período, organização, unidade ou tipo. Vínculo recusado.' using errcode='23514';
    end if;
    if exists(select 1 from public.bonificacao_lancamentos_diarios l
      where (l.importacao_loja_id=ref or l.importacao_geral_id=ref)
      and (l.unidade_id,l.data) is distinct from (new.unidade_id,new.data)) then
      raise exception 'O mesmo documento já alimenta outro dia. Vínculo duplicado recusado.' using errcode='23514';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists trg_bonificacao_vinculos_diarios on public.bonificacao_lancamentos_diarios;
create trigger trg_bonificacao_vinculos_diarios before insert or update of
  organizacao_id,unidade_id,data,importacao_geral_id,importacao_loja_id
on public.bonificacao_lancamentos_diarios for each row execute function public.bonificacao_validar_vinculos_diarios();

-- Auditoria na MESMA transação. Se falhar, a alteração do lançamento é revertida.
create or replace function public.bonificacao_auditar_importacao_diaria()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare anterior jsonb; documentos jsonb;
begin
  if TG_OP='UPDATE' then anterior := to_jsonb(old); end if;
  if new.importacao_geral_id is null and new.importacao_loja_id is null
     and (anterior->>'importacao_geral_id') is null and (anterior->>'importacao_loja_id') is null then return new; end if;
  select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) into documentos
    from public.bonificacao_importacoes i where i.id in (new.importacao_geral_id,new.importacao_loja_id);
  insert into public.plataforma_auditoria(ator_id,ator_tipo,acao,entidade,entidade_id,organizacao_id,detalhes)
  values(new.usuario_id,'usuario','bonificacao_mensal.importacao_diaria_gravada','bonificacao_lancamento',new.id::text,new.organizacao_id,
    jsonb_build_object('operacao',TG_OP,'usuarioNome',new.usuario_nome,'antes',anterior,'depois',to_jsonb(new),'documentos',documentos));
  return new;
end $$;

drop trigger if exists trg_bonificacao_auditar_importacao_diaria on public.bonificacao_lancamentos_diarios;
create trigger trg_bonificacao_auditar_importacao_diaria after insert or update of importacao_geral_id,importacao_loja_id
on public.bonificacao_lancamentos_diarios for each row execute function public.bonificacao_auditar_importacao_diaria();

revoke all on function public.bonificacao_validar_documento_diario() from public;
revoke all on function public.bonificacao_validar_vinculos_diarios() from public;
revoke all on function public.bonificacao_auditar_importacao_diaria() from public;
commit;
