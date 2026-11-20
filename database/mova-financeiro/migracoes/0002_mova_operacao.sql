-- MOVA — Execução 03: operação (revisão de classificação, envio de respostas, retenção de evidências, papel restrito).
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE nesta execução. Nada aqui foi aplicado em produção.

-- 1. Revisão de classificação: enquanto AGUARDANDO_REVISAO, o administrador pode ajustar os DADOS (ex.: categoria escolhida)
--    sem mudar o estado. Toda mudança sobe a versão (concorrência otimista na rota). Estados finais continuam imutáveis.
create or replace function mova.proposta_transicao() returns trigger language plpgsql as $$
begin
  if old.estado in ('APLICADA','REJEITADA') then
    raise exception 'MOVA: proposta % já está %.', old.id, old.estado using errcode = 'MV003';
  end if;
  if new.estado = old.estado then
    if old.estado <> 'AGUARDANDO_REVISAO' then
      raise exception 'MOVA: dados só mudam em AGUARDANDO_REVISAO.' using errcode = 'MV004';
    end if;
    if new.tipo <> old.tipo or new.unidade_id <> old.unidade_id or new.organizacao_id <> old.organizacao_id
       or new.valor_centavos is distinct from old.valor_centavos or new.evento_id <> old.evento_id then
      raise exception 'MOVA: revisão não altera tipo, unidade, valor nem origem.' using errcode = 'MV005';
    end if;
  elsif not ((old.estado = 'AGUARDANDO_REVISAO' and new.estado in ('APLICANDO','REJEITADA'))
          or (old.estado = 'APLICANDO' and new.estado in ('APLICADA','AGUARDANDO_REVISAO'))) then
    raise exception 'MOVA: transição % → % inválida.', old.estado, new.estado using errcode = 'MV004';
  end if;
  new.versao := old.versao + 1;
  new.atualizada_em := now();
  return new;
end $$;

-- 2. Envio de respostas: lease para o enviador (vários processos sem enviar duas vezes) e tentativas.
alter table mova.resposta drop constraint resposta_estado_check;
alter table mova.resposta add constraint resposta_estado_check check (estado in ('PENDENTE','ENVIANDO','ENVIADA','FALHOU','SUPRIMIDA'));
alter table mova.resposta add column tentativas integer not null default 0;
alter table mova.resposta add column lease_ate timestamptz;
alter table mova.resposta add column ultimo_erro text;
alter table mova.resposta add column enviada_em timestamptz;
create index resposta_pendentes on mova.resposta (estado, seq);

-- 3. Evidências: unidade dona (acesso por unidade), retenção e EXCLUSÃO SEGURA (apaga o conteúdo, mantém hash e trilha).
alter table mova.evidencia add column organizacao_id uuid;
alter table mova.evidencia add column unidade_id uuid;
alter table mova.evidencia add column expira_em timestamptz not null default (now() + interval '400 days');
alter table mova.evidencia add column removida_em timestamptz;
alter table mova.evidencia alter column conteudo drop not null;
alter table mova.evidencia add constraint evidencia_conteudo_ou_removida check ((conteudo is null) = (removida_em is not null));

-- Expurgo: só evidência VENCIDA e que NÃO sustenta proposta aplicada (essa fica como prova do lançamento). Registra auditoria.
create function mova.expurgar_evidencias(p_agora timestamptz) returns integer language plpgsql as $$
declare n integer;
begin
  with alvo as (
    select e.sha256 from mova.evidencia e
     where e.removida_em is null and e.expira_em <= p_agora
       and not exists (select 1 from mova.documento d join mova.proposta p on p.id = d.proposta_id where d.sha256 = e.sha256 and p.estado in ('APLICADA','APLICANDO','AGUARDANDO_REVISAO'))
  ), feito as (
    update mova.evidencia e set conteudo = null, removida_em = p_agora from alvo where e.sha256 = alvo.sha256 returning e.sha256
  ), trilha as (
    insert into mova.auditoria (acao, ator_tipo, alvo, dados) select 'EVIDENCIA_EXPURGADA', 'SISTEMA', sha256, '{}'::jsonb from feito returning 1
  )
  select count(*) into n from trilha;
  return n;
end $$;

-- 4. Papel restrito da aplicação MOVA: sem login próprio (o papel de login herda dele), sem DELETE, sem DDL, sem acesso ao
--    schema do Financeiro v2. O backend usaria um papel de login membro de mova_app (MOVA_DATABASE_URL).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mova_app') then
    create role mova_app nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;
revoke all on schema mova from public;
grant usage on schema mova to mova_app;
grant select, insert on all tables in schema mova to mova_app;
grant update on mova.participante, mova.proposta, mova.mensagem_pendente, mova.resposta, mova.fila, mova.evidencia to mova_app;
grant usage on all sequences in schema mova to mova_app;
grant execute on function mova.expurgar_evidencias(timestamptz) to mova_app;
revoke delete, truncate on all tables in schema mova from mova_app;
