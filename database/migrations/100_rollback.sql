-- ROLLBACK da migration 100. Restaura os corpos EXATOS (idênticos aos de produção) de 088/092/094/093, o trigger de validação da habilitação e a view do roster (096),
-- e remove o que a 100 criou. NÃO apaga contatos_whatsapp nem habilitações. Reverta o deploy do backend ANTES (o backend da 100 depende destas estruturas).
-- ATENÇÃO: os responsáveis de comunicação (comunicacao_contatos_empresa) são PERDIDOS no rollback; habilitações cujo responsável NÃO tem perfil voltam
-- DESABILITADAS e sem destinatário (o modelo antigo exige perfil). As colunas de snapshot das mensagens são removidas.
begin;

-- 1. habilitações sem perfil não são representáveis no modelo antigo: desabilita e limpa o destinatário
update comunicacao_habilitacoes
   set habilitado = false, destinatario_contato_id = null, destinatario_perfil_id = null
 where destinatario_perfil_id is null and destinatario_contato_id is not null;

alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_destinatario_coerente;
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_contato_empresa_fk;
alter table comunicacao_habilitacoes drop column if exists destinatario_contato_empresa_id;
alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_destinatario_par
  check ((destinatario_contato_id is null) = (destinatario_perfil_id is null));
alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_destinatario_fk
  foreign key (destinatario_contato_id, destinatario_perfil_id)
  references contatos_whatsapp_perfis (contato_id, perfil_operacional_id);

create or replace function comunicacao_habilitacoes_valida()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- IANA "Regiao/Cidade" (ou UTC): recusa offsets e aliases de offset fixo (EST, GMT, Etc/GMT+3)
  if new.timezone is not null and (
       not exists (select 1 from pg_timezone_names where name = new.timezone)
       or (new.timezone <> 'UTC' and (new.timezone not like '%/%' or new.timezone ilike 'etc/%'))) then
    raise exception 'timezone IANA invalido: %', new.timezone using errcode = '22023';
  end if;
  if new.janelas is not null and jsonb_typeof(new.janelas) <> 'object' then
    raise exception 'janelas deve ser um objeto jsonb' using errcode = '22023';
  end if;
  -- destinatário: o perfil TEM de ter vínculo ativo com ESTA organização (cross-org é impossível)
  -- e o par contato<->perfil tem de estar ativo.
  if new.destinatario_perfil_id is not null then
    if not exists (select 1 from usuarios_organizacoes uo
                    where uo.perfil_id = new.destinatario_perfil_id and uo.organizacao_id = new.organizacao_id and uo.ativo) then
      raise exception 'destinatario sem vinculo ativo com a organizacao' using errcode = '22023';
    end if;
    if not exists (select 1 from contatos_whatsapp_perfis cp
                    where cp.contato_id = new.destinatario_contato_id and cp.perfil_operacional_id = new.destinatario_perfil_id and cp.ativo) then
      raise exception 'par contato<->perfil inexistente ou inativo' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_habilitacoes_valida() from public, anon, authenticated;

create or replace function comunicacao_agendar_mensagem_alerta(
  p_alerta_id uuid, p_tipo text, p_conteudo text,
  p_idempotency_key text, p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    -- a mensagem deste evento lógico já EXPIROU: NÃO cria outra (lembrete/nova versão = regra explícita futura)
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id);
    end if;
    if a.status = 'DETECTED' and m.status in ('SCHEDULED', 'PROCESSING', 'SENDING') then
      update comunicacao_alertas set status = 'SCHEDULED' where id = a.id; -- repara alerta preso
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- entrega desconhecida/em curso para este evento lógico: nada novo até reconciliar
  select count(*) into n from comunicacao_mensagens where alerta_id = a.id and status in ('SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_DESCONHECIDA'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed): nenhuma escolha do chamador
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if p_tipo is null or not (p_tipo = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;
  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true
     or not exists (select 1 from perfis_operacionais where id = h.destinatario_perfil_id and ativo)
     or not exists (select 1 from usuarios_organizacoes uo where uo.perfil_id = h.destinatario_perfil_id and uo.organizacao_id = a.organizacao_id and uo.ativo)
     or not exists (select 1 from contatos_whatsapp_perfis cp where cp.contato_id = h.destinatario_contato_id and cp.perfil_operacional_id = h.destinatario_perfil_id and cp.ativo) then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          p_tipo, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas)
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
revoke all on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) to service_role;

create or replace function comunicacao_agendar_reforco_alerta(
  p_alerta_id uuid, p_conteudo text, p_idempotency_key text,
  p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; ini comunicacao_mensagens;
  h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  -- A chave do reforço é DETERMINÍSTICA e validada aqui: impossível criar um 2º reforço com outra chave.
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':reforco:v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Estado coerente com "o 1º aviso já saiu". DETECTED/SCHEDULED/PROCESSING/BLOCKED/FAILED/
  -- RESPONDED/RESOLVED/CANCELLED nunca recebem reforço.
  if a.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'ALERTA_SEM_PRIMEIRO_ENVIO', 'status_alerta', a.status);
  end if;

  -- A 1ª mensagem precisa existir E ter saído de fato (DELIVERY_UNKNOWN = incerto -> fail-closed).
  select * into ini from comunicacao_mensagens where idempotency_key = ('wa:alerta:' || a.id::text || ':v1');
  if not found or ini.alerta_id is distinct from a.id or ini.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'PRIMEIRA_MENSAGEM_NAO_ENVIADA');
  end if;

  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed) — MESMAS checagens da RPC NORMAL (088).
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;
  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true
     or not exists (select 1 from perfis_operacionais where id = h.destinatario_perfil_id and ativo)
     or not exists (select 1 from usuarios_organizacoes uo where uo.perfil_id = h.destinatario_perfil_id and uo.organizacao_id = a.organizacao_id and uo.ativo)
     or not exists (select 1 from contatos_whatsapp_perfis cp where cp.contato_id = h.destinatario_contato_id and cp.perfil_operacional_id = h.destinatario_perfil_id and cp.ativo) then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('proposito', 'reforco'))
  returning * into m;
  -- O status do ALERTA não muda aqui nem depois (ver o trigger, item 2): o reforço tem fonte de verdade própria.
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
revoke all on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

create or replace function comunicacao_agendar_aviso_tardio_d1(
  p_alerta_id uuid, p_conteudo text, p_idempotency_key text,
  p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; c contatos_whatsapp; n integer;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  if a.tipo_alerta <> 'dashboard_ifood_d1' then return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO'); end if;

  -- MESMA identidade da 1ª mensagem: impossível uma 2ª identidade "tardia".
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id); -- expirou: NUNCA recria (nem amanhã)
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Nenhuma OUTRA mensagem inicial (de qualquer chave) e nenhuma entrega em curso/incerta para este alerta.
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and coalesce(metadados->>'proposito', 'inicial') = 'inicial';
  if n > 0 then return jsonb_build_object('acao', 'INICIAL_JA_EXISTE'); end if;
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

  -- HABILITAÇÃO + DESTINATÁRIO (fail-closed) — MESMAS checagens da RPC NORMAL (088).
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;
  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true
     or not exists (select 1 from perfis_operacionais where id = h.destinatario_perfil_id and ativo)
     or not exists (select 1 from usuarios_organizacoes uo where uo.perfil_id = h.destinatario_perfil_id and uo.organizacao_id = a.organizacao_id and uo.ativo)
     or not exists (select 1 from contatos_whatsapp_perfis cp where cp.contato_id = h.destinatario_contato_id and cp.perfil_operacional_id = h.destinatario_perfil_id and cp.ativo) then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, h.destinatario_contato_id, h.destinatario_perfil_id,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('proposito', 'inicial', 'origem', 'prazo_final_d1'))
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
revoke all on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

create or replace function comunicacao_habilitar_organizacao_piloto(
  p_organizacao_id uuid, p_ator_perfil_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  h comunicacao_habilitacoes; c contatos_whatsapp; v_modo text; n integer; v_ator uuid;
begin
  -- Serializa TODAS as habilitações (mesmo de organizações diferentes): "nenhuma outra habilitada" só é
  -- verdade se duas habilitações concorrentes nunca leem o mesmo estado.
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar_organizacao_piloto'));

  select trim(both '"' from (valor #>> '{}')) into v_modo from comunicacao_configuracoes where chave = 'modo';
  if coalesce(v_modo, 'DISABLED') <> 'DISABLED' then
    return jsonb_build_object('acao', 'MODO_NAO_DESABILITADO', 'modo', v_modo);
  end if;

  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  if h.habilitado then return jsonb_build_object('acao', 'JA_HABILITADA'); end if;

  select count(*) into n from comunicacao_habilitacoes where habilitado and organizacao_id <> p_organizacao_id;
  if n > 0 then return jsonb_build_object('acao', 'OUTRA_ORGANIZACAO_HABILITADA'); end if;

  if h.timezone is null then return jsonb_build_object('acao', 'TIMEZONE_AUSENTE'); end if;
  if coalesce(array_length(h.tipos_permitidos, 1), 0) = 0 then return jsonb_build_object('acao', 'TIPO_AUSENTE'); end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;

  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  -- atualizado_por tem FK para perfis_operacionais: um ator sem perfil operacional vira NULL (a auditoria do backend guarda o ator real).
  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;

  update comunicacao_habilitacoes
     set habilitado = true, atualizado_por = v_ator, updated_at = now()
   where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'HABILITADA');
end;
$$;
revoke all on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) to service_role;

-- roster: como a 096 definiu (perfil com acesso). As colunas responsavel_* somem — por isso drop + create.
drop view if exists comunicacao_roster_autorizado;
create or replace view comunicacao_roster_autorizado
with (security_invoker = true) as
select
  c.id                      as contato_id,
  c.telefone_e164,
  c.consentimento,
  c.verificado,
  c.opt_out,
  po.id                     as perfil_id,
  po.nome                   as perfil_nome,
  o.id                      as organizacao_id,
  o.nome                    as organizacao_nome,
  uo.papel::text            as papel,
  un.id                     as unidade_id,
  un.nome                   as unidade_nome
from contatos_whatsapp c
join contatos_whatsapp_perfis cp on cp.contato_id = c.id and cp.ativo
join perfis_operacionais po      on po.id = cp.perfil_operacional_id and po.ativo
join usuarios_organizacoes uo    on uo.perfil_id = po.id and uo.ativo
join organizacoes o              on o.id = uo.organizacao_id
left join unidades un            on un.organizacao_id = o.id and un.ativo
                                 and (
                                   exists (select 1 from usuarios_unidades uu where uu.perfil_id = po.id and uu.unidade_id = un.id and uu.ativo)
                                   or not exists (select 1 from usuarios_unidades uu2 join unidades u2 on u2.id = uu2.unidade_id
                                                   where uu2.perfil_id = po.id and u2.organizacao_id = o.id and uu2.ativo)
                                 );
revoke all on comunicacao_roster_autorizado from public, anon, authenticated;
grant select on comunicacao_roster_autorizado to service_role;

drop function if exists comunicacao_resolver_destinatario(uuid);
drop function if exists comunicacao_vincular_mensagens_ao_responsavel();
alter table comunicacao_mensagens drop column if exists contato_empresa_id;
alter table comunicacao_mensagens drop column if exists empresa_nome_snapshot;
alter table comunicacao_mensagens drop column if exists contato_nome_snapshot;
alter table comunicacao_mensagens drop column if exists telefone_snapshot;
alter table comunicacao_mensagens drop column if exists data_referencia;
drop table if exists comunicacao_contatos_empresa;
delete from comunicacao_configuracoes where chave = 'disponibilidade_ifood';

notify pgrst, 'reload schema';
commit;
