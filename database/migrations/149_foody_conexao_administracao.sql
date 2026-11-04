-- 149 — Camada central Foody: ADMINISTRAÇÃO da conexão pela própria Crescer (tela de Configurações → Integrações).
--
-- ADITIVA sobre a 147 + 148 (nenhuma das três está aplicada em produção: sobem juntas, com backup e GO próprio). Não toca
-- tabelas fora do prefixo foody_. Não cria nenhum agendamento e não liga sincronização: administrar a conexão (cadastrar, ativar,
-- pausar, revogar) NUNCA coleta pedidos — a coleta continua dependendo das flags de sincronização (FOODY_CENTRAL_ENABLED +
-- allowlist + agendador), que são outra decisão.
--
-- REGRAS GARANTIDAS PELO BANCO:
--   1. Toda mudança administrativa da conexão passa por foody_conexao_administrar (SECURITY DEFINER, só service_role executa):
--      o ator precisa ser organization_admin ATIVO da organização da unidade NO MOMENTO da ação (usuarios_organizacoes), a
--      unidade precisa pertencer à organização, e cada ação gera um evento imutável em foody_conexoes_eventos (mesma transação).
--   2. Dupla contagem: a unidade que é DESTINO vivo de um compartilhamento não pode ter conexão Foody própria viva (o inverso
--      a 148 já garante), e o token de uma conexão com compartilhamento vivo não pode ser trocado (seria outra conta debaixo de
--      um vínculo aprovado para a anterior). A mesma conta (impressão do token) segue com UMA conexão viva (147).
--   3. Transferência/promoção da unidade titular (organizacao_id muda): a conexão ATIVA volta a PAUSADA (a nova organização
--      decide reativar) e o evento fica registrado; os destinos já caem pela 148.
--   4. Eventos: somente inclusão (UPDATE só de organizacao_id, para a transferência de unidade; DELETE recusado).
--
-- SEGURANÇA: RLS ligado, NENHUMA policy, nenhum grant a anon/authenticated. service_role: SELECT nos eventos (+ UPDATE de
-- organizacao_id, exigido por remapear_organizacao_em_tabelas_de_unidade) e EXECUTE na função. O token NUNCA passa em claro por
-- aqui: a função recebe o token já cifrado pela aplicação (AES-256-GCM, AAD da unidade) e a impressão (12 hex).
-- Rollback: 149_rollback.sql (fail-closed se houver eventos).

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.foody_conexao_destinos') is null or to_regprocedure('public.foody_eh_admin_da_organizacao(uuid, uuid)') is null then
    raise exception '149: exige as migrations 147 e 148 (camada central Foody + conexão compartilhada)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Auditoria da conexão (somente inclusão)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_conexoes_eventos (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references foody_conexoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  evento text not null check (evento in ('CADASTRADA', 'RECONECTADA', 'TOKEN_SUBSTITUIDO', 'ATIVADA', 'PAUSADA', 'REVOGADA',
                                          'PONTO_COLETA_ALTERADO', 'PAUSADA_POR_TRANSFERENCIA')),
  ator_perfil_id uuid,                                           -- null = automático (transferência de unidade)
  status_anterior text,
  status_novo text not null,
  token_impressao text check (token_impressao is null or token_impressao ~ '^[0-9a-f]{12}$'),   -- impressão, nunca o token
  motivo text check (motivo is null or length(motivo) between 3 and 300),
  criado_em timestamptz not null default now()
);
create index if not exists idx_foody_conexoes_eventos_tenant on foody_conexoes_eventos(organizacao_id, unidade_id, criado_em desc);
create index if not exists idx_foody_conexoes_eventos_conexao on foody_conexoes_eventos(conexao_id, criado_em desc);

drop trigger if exists trg_foody_conexoes_eventos_tenant on foody_conexoes_eventos;
create constraint trigger trg_foody_conexoes_eventos_tenant after insert or update on foody_conexoes_eventos
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_conexoes_eventos_imutavel on foody_conexoes_eventos;
create trigger trg_foody_conexoes_eventos_imutavel before update or delete on foody_conexoes_eventos
  for each row execute function foody_registro_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Guardas na própria tabela de conexões (valem para QUALQUER escrita, inclusive fora da função)
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function foody_conexao_guardas() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Dupla contagem: unidade que recebe pedidos como DESTINO vivo não tem conexão própria viva.
  if new.status <> 'REVOGADA' and (tg_op = 'INSERT' or old.status = 'REVOGADA' or new.unidade_id is distinct from old.unidade_id)
     and exists (select 1 from foody_conexao_destinos d where d.unidade_id = new.unidade_id and d.estado <> 'REVOGADO') then
    raise exception 'foody_conexoes: DESTINO_VIVO — a unidade já recebe pedidos Foody como destino de um compartilhamento'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    -- Trocar o token de uma conexão com compartilhamento vivo = outra conta debaixo de um vínculo aprovado para a anterior.
    if new.token_impressao is distinct from old.token_impressao
       and exists (select 1 from foody_conexao_destinos d where d.conexao_id = new.id and d.estado <> 'REVOGADO') then
      raise exception 'foody_conexoes: COMPARTILHAMENTO_VIVO — revogue o compartilhamento antes de trocar o token'
        using errcode = '42501';
    end if;
    -- Transferência/promoção da unidade titular: a nova organização decide reativar.
    if new.organizacao_id is distinct from old.organizacao_id and new.status = 'ATIVA' then
      new.status := 'PAUSADA';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_foody_conexoes_guardas on foody_conexoes;
create trigger trg_foody_conexoes_guardas before insert or update on foody_conexoes
  for each row execute function foody_conexao_guardas();

create or replace function foody_conexao_auditar_transferencia() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id then
    insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, ator_perfil_id, status_anterior, status_novo, motivo)
    values (new.id, new.organizacao_id, new.unidade_id, 'PAUSADA_POR_TRANSFERENCIA', null, old.status, new.status,
            'Organização da unidade mudou (transferência/promoção).');
  end if;
  return null;
end $$;
drop trigger if exists trg_foody_conexoes_auditar_transferencia on foody_conexoes;
create trigger trg_foody_conexoes_auditar_transferencia after update on foody_conexoes
  for each row execute function foody_conexao_auditar_transferencia();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Ações administrativas (uma função, uma transação, um evento)
-- ---------------------------------------------------------------------------------------------------------------------------
-- Erros com código estável na mensagem ("foody_conexao_administrar: CODIGO — texto"), lidos pela aplicação:
--   SEM_PERMISSAO, UNIDADE_FORA_DA_ORGANIZACAO, ACAO_INVALIDA, TOKEN_INVALIDO, MOTIVO_INVALIDO, SEM_CONEXAO, CONEXAO_EXISTENTE,
--   CONEXAO_REVOGADA, CONTA_JA_CONECTADA, DESTINO_VIVO, COMPARTILHAMENTO_VIVO, TRANSICAO_INVALIDA.
create or replace function foody_conexao_administrar(
  p_acao text, p_organizacao_id uuid, p_unidade_id uuid, p_ator uuid,
  p_token_cifrado text default null, p_token_impressao text default null, p_ponto_coleta text default null, p_motivo text default null
) returns table (resultado text, conexao_id uuid, status text, evento text)
language plpgsql security definer set search_path = public as $$
declare
  c foody_conexoes%rowtype;
  achou boolean;
  novo_status text;
  ev text;
  motivo_limpo text := nullif(btrim(coalesce(p_motivo, '')), '');
  ponto_limpo text := nullif(left(btrim(coalesce(p_ponto_coleta, '')), 120), '');
begin
  if p_acao not in ('CADASTRAR', 'SUBSTITUIR_TOKEN', 'ATIVAR', 'PAUSAR', 'REVOGAR', 'PONTO_COLETA') then
    raise exception 'foody_conexao_administrar: ACAO_INVALIDA — ação desconhecida' using errcode = '22023';
  end if;
  if not foody_eh_admin_da_organizacao(p_ator, p_organizacao_id) then
    raise exception 'foody_conexao_administrar: SEM_PERMISSAO — só organization_admin ativo da organização administra a conexão'
      using errcode = '42501';
  end if;
  if not exists (select 1 from unidades u where u.id = p_unidade_id and u.organizacao_id = p_organizacao_id) then
    raise exception 'foody_conexao_administrar: UNIDADE_FORA_DA_ORGANIZACAO — a unidade não pertence à organização'
      using errcode = '42501';
  end if;
  if motivo_limpo is not null and length(motivo_limpo) > 300 then
    raise exception 'foody_conexao_administrar: MOTIVO_INVALIDO — motivo de 3 a 300 caracteres' using errcode = '22023';
  end if;

  -- Serializa as ações da unidade (duas abas, dois administradores).
  perform pg_advisory_xact_lock(hashtextextended('foody_conexao:' || p_unidade_id::text, 0));
  select * into c from foody_conexoes x where x.unidade_id = p_unidade_id for update;
  achou := found;
  if achou and c.organizacao_id <> p_organizacao_id then
    raise exception 'foody_conexao_administrar: SEM_PERMISSAO — conexão de outra organização' using errcode = '42501';
  end if;

  if p_acao in ('CADASTRAR', 'SUBSTITUIR_TOKEN') then
    if p_token_cifrado is null or p_token_cifrado !~ '^k[0-9]+:' or p_token_impressao is null or p_token_impressao !~ '^[0-9a-f]{12}$' then
      raise exception 'foody_conexao_administrar: TOKEN_INVALIDO — token cifrado e impressão obrigatórios' using errcode = '22023';
    end if;
    if exists (select 1 from foody_conexoes x where x.token_impressao = p_token_impressao and x.status <> 'REVOGADA'
                and x.unidade_id <> p_unidade_id) then
      raise exception 'foody_conexao_administrar: CONTA_JA_CONECTADA — esta conta Foody já está conectada a outra unidade'
        using errcode = '23505';
    end if;
    if exists (select 1 from foody_conexao_destinos d where d.unidade_id = p_unidade_id and d.estado <> 'REVOGADO') then
      raise exception 'foody_conexao_administrar: DESTINO_VIVO — a unidade já recebe pedidos Foody como destino de um compartilhamento'
        using errcode = '42501';
    end if;
  end if;

  if p_acao = 'CADASTRAR' then
    if achou and c.status <> 'REVOGADA' then
      raise exception 'foody_conexao_administrar: CONEXAO_EXISTENTE — a unidade já tem conexão; use a troca de token'
        using errcode = '23505';
    end if;
    if achou then
      -- Reconexão depois de uma revogação: mesma linha (histórico de pedidos e eventos preservado), novo token, nasce PAUSADA.
      update foody_conexoes set token_cifrado = p_token_cifrado, token_impressao = p_token_impressao, status = 'PAUSADA',
             ponto_coleta_esperado = ponto_limpo, ultimo_erro_codigo = null, atualizado_em = now()
       where id = c.id;
      ev := 'RECONECTADA';
    else
      insert into foody_conexoes (organizacao_id, unidade_id, status, token_cifrado, token_impressao, ponto_coleta_esperado, criado_por)
      values (p_organizacao_id, p_unidade_id, 'PAUSADA', p_token_cifrado, p_token_impressao, ponto_limpo, p_ator::text)
      returning * into c;
      ev := 'CADASTRADA';
    end if;
    insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, ator_perfil_id, status_anterior, status_novo, token_impressao, motivo)
    values (c.id, p_organizacao_id, p_unidade_id, ev, p_ator, case when achou then c.status end, 'PAUSADA', p_token_impressao, motivo_limpo);
    return query select 'REGISTRADO'::text, c.id, 'PAUSADA'::text, ev;
    return;
  end if;

  if not achou then
    raise exception 'foody_conexao_administrar: SEM_CONEXAO — a unidade não tem conexão Foody' using errcode = '22023';
  end if;
  if c.status = 'REVOGADA' then
    raise exception 'foody_conexao_administrar: CONEXAO_REVOGADA — conexão revogada; cadastre um novo token' using errcode = '22023';
  end if;

  if p_acao = 'SUBSTITUIR_TOKEN' then
    if p_token_impressao = c.token_impressao then
      return query select 'SEM_MUDANCA'::text, c.id, c.status, null::text;
      return;
    end if;
    if exists (select 1 from foody_conexao_destinos d where d.conexao_id = c.id and d.estado <> 'REVOGADO') then
      raise exception 'foody_conexao_administrar: COMPARTILHAMENTO_VIVO — revogue o compartilhamento antes de trocar o token'
        using errcode = '42501';
    end if;
    update foody_conexoes set token_cifrado = p_token_cifrado, token_impressao = p_token_impressao, status = 'PAUSADA',
           ultimo_erro_codigo = null, atualizado_em = now() where id = c.id;
    insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, ator_perfil_id, status_anterior, status_novo, token_impressao, motivo)
    values (c.id, p_organizacao_id, p_unidade_id, 'TOKEN_SUBSTITUIDO', p_ator, c.status, 'PAUSADA', p_token_impressao, motivo_limpo);
    return query select 'REGISTRADO'::text, c.id, 'PAUSADA'::text, 'TOKEN_SUBSTITUIDO'::text;
    return;
  end if;

  if p_acao = 'PONTO_COLETA' then
    if ponto_limpo is not distinct from c.ponto_coleta_esperado then
      return query select 'SEM_MUDANCA'::text, c.id, c.status, null::text;
      return;
    end if;
    update foody_conexoes set ponto_coleta_esperado = ponto_limpo, atualizado_em = now() where id = c.id;
    insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, ator_perfil_id, status_anterior, status_novo, motivo)
    values (c.id, p_organizacao_id, p_unidade_id, 'PONTO_COLETA_ALTERADO', p_ator, c.status, c.status, motivo_limpo);
    return query select 'REGISTRADO'::text, c.id, c.status, 'PONTO_COLETA_ALTERADO'::text;
    return;
  end if;

  novo_status := case p_acao when 'ATIVAR' then 'ATIVA' when 'PAUSAR' then 'PAUSADA' else 'REVOGADA' end;
  ev := case p_acao when 'ATIVAR' then 'ATIVADA' when 'PAUSAR' then 'PAUSADA' else 'REVOGADA' end;
  if p_acao = 'REVOGAR' and (motivo_limpo is null or length(motivo_limpo) < 3) then
    raise exception 'foody_conexao_administrar: MOTIVO_INVALIDO — revogar exige motivo (3 a 300 caracteres)' using errcode = '22023';
  end if;
  if c.status = novo_status then
    return query select 'SEM_MUDANCA'::text, c.id, c.status, null::text;
    return;
  end if;
  if (p_acao = 'ATIVAR' and c.status not in ('PAUSADA', 'ERRO')) or (p_acao = 'PAUSAR' and c.status not in ('ATIVA', 'ERRO')) then
    raise exception 'foody_conexao_administrar: TRANSICAO_INVALIDA — % → % não permitida', c.status, novo_status using errcode = '22023';
  end if;
  update foody_conexoes set status = novo_status, atualizado_em = now() where id = c.id;
  insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, ator_perfil_id, status_anterior, status_novo, motivo)
  values (c.id, p_organizacao_id, p_unidade_id, ev, p_ator, c.status, novo_status, motivo_limpo);
  return query select 'REGISTRADO'::text, c.id, novo_status, ev;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. RLS e privilégios (mesmo padrão da 147/148)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table foody_conexoes_eventos enable row level security;
do $$
declare
  fn_admin constant text := 'foody_conexao_administrar(text, uuid, uuid, uuid, text, text, text, text)';
  f text;
begin
  execute 'revoke all on public.foody_conexoes_eventos from public, anon, authenticated';
  foreach f in array array[fn_admin, 'foody_conexao_guardas()', 'foody_conexao_auditar_transferencia()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on public.foody_conexoes_eventos from service_role';
    execute format('revoke all on function public.%s from service_role', fn_admin);
    -- Eventos: escritos SÓ pela função/trigger; o backend lê. UPDATE só de organizacao_id (transferência de unidade).
    grant select on foody_conexoes_eventos to service_role;
    grant update (organizacao_id) on foody_conexoes_eventos to service_role;
    execute format('grant execute on function public.%s to service_role', fn_admin);
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
