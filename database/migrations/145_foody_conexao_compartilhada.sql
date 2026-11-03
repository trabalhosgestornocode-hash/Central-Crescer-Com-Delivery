-- 145 — Camada central Foody: CONEXÃO COMPARTILHADA entre organizações (piloto em SOMBRA).
--
-- Caso real: a conta Foody da Subway Saci (unidade titular da conexão) despacha também os pedidos do Açaí no Grau Saci, que é
-- OUTRA organização. A coleta continua ÚNICA (uma conexão, um token, uma consulta à API); os pedidos são DISTRIBUÍDOS por
-- operação:
--   * operação da titular (Subway)           → unidade titular, dados completos;
--   * operação com DESTINO ATIVO (Açaí)      → unidade de destino, dados completos (destino_id);
--   * operação sem destino ativo             → unidade titular, só o mínimo logístico (regra da 144);
--   * classificação sem evidência segura     → TRIAGEM (operacao = 'triagem', unidade titular, sem dado comercial).
--
-- ADITIVA sobre a 144 (que também NÃO está aplicada em produção: as duas sobem juntas, com GO próprio). Não toca tabelas fora do
-- prefixo foody_. Os 2.495 pedidos de Açaí que o Parser guarda na Subway (parser_fd_pedidos) NÃO são lidos nem alterados.
--
-- REGRAS GARANTIDAS PELO BANCO (além da aplicação):
--   1. Destino só fica ATIVO com DUAS aprovações: organization_admin ATIVO da organização TITULAR e da organização de DESTINO
--      (conferido em usuarios_organizacoes no momento da aprovação). Toda mudança gera evento em foody_destinos_eventos
--      (somente inclusão). Mudança da organização da unidade (transferência/promoção) REVOGA o destino automaticamente.
--   2. A mesma conta (token) continua com UMA conexão ativa (uq_foody_conexoes_conta_ativa, 144) — o compartilhamento é um
--      VÍNCULO da conexão, nunca uma segunda conexão.
--   3. Um pedido nunca está ATIVO em duas unidades/organizações: índice único (conexao_id, foody_uid) onde roteamento_ativo
--      (cobre destino, titular e triagem — tudo na mesma tabela).
--   4. Linha com dado comercial de uma operação só existe na unidade TITULAR (Subway) ou na unidade DESTINO ATIVO daquela
--      operação; linha desativada e linha de triagem ficam sem dado comercial.
--   5. Registro filho só aponta para execução da própria unidade OU de conexão da qual a unidade é destino.
--   6. Decisão de triagem: só organization_admin de uma das organizações do vínculo; somente inclusão (auditável).
--
-- SEGURANÇA: RLS ligado, NENHUMA policy, nenhum grant a anon/authenticated (igual à 144). service_role sem DELETE.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 0. Quem pode aprovar: organization_admin ATIVO da organização (vínculo canônico por perfil_id — migration 063).
--    Superadmin de plataforma/impersonação NÃO conta: a aprovação é da própria empresa.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function foody_eh_admin_da_organizacao(p_perfil_id uuid, p_organizacao_id uuid) returns boolean
language sql stable set search_path = public as $$
  select p_perfil_id is not null and exists (
    select 1 from usuarios_organizacoes uo
     where uo.perfil_id = p_perfil_id and uo.organizacao_id = p_organizacao_id
       and uo.papel = 'organization_admin' and uo.ativo);
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Destinos da conexão (vínculo entre organizações)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_conexao_destinos (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references foody_conexoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,     -- organização de DESTINO
  unidade_id uuid not null references unidades(id) on delete cascade,             -- unidade de DESTINO
  operacao text not null check (operacao in ('acai_no_grau')),                    -- a operação da titular (subway) não tem destino
  estado text not null default 'PENDENTE' check (estado in ('PENDENTE', 'ATIVO', 'REVOGADO')),
  organizacao_titular_id uuid not null references organizacoes(id) on delete cascade,  -- foto da titular na proposta
  aprovado_titular_por uuid,
  aprovado_titular_em timestamptz,
  aprovado_destino_por uuid,
  aprovado_destino_em timestamptz,
  revogado_por uuid,
  revogado_em timestamptz,
  revogado_motivo text check (revogado_motivo is null or length(btrim(revogado_motivo)) between 3 and 300),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_foody_destino_ativo check (estado <> 'ATIVO' or (aprovado_titular_em is not null and aprovado_destino_em is not null
    and aprovado_titular_por is not null and aprovado_destino_por is not null)),
  constraint ck_foody_destino_revogado check (estado <> 'REVOGADO' or (revogado_em is not null and revogado_motivo is not null)),
  constraint ck_foody_destino_aprovacoes_par check ((aprovado_titular_por is null) = (aprovado_titular_em is null)
    and (aprovado_destino_por is null) = (aprovado_destino_em is null))
);
-- Uma operação, um destino vivo por conexão; uma unidade recebe cada operação de uma só conexão.
create unique index if not exists uq_foody_destino_conexao_operacao on foody_conexao_destinos(conexao_id, operacao) where estado <> 'REVOGADO';
create unique index if not exists uq_foody_destino_unidade_operacao on foody_conexao_destinos(unidade_id, operacao) where estado <> 'REVOGADO';
create index if not exists idx_foody_destino_tenant on foody_conexao_destinos(organizacao_id, unidade_id);

create or replace function foody_destino_validar() returns trigger
language plpgsql set search_path = public as $$
declare
  con record;
begin
  select c.organizacao_id, c.unidade_id, c.status into con from foody_conexoes c where c.id = new.conexao_id;
  if not found then raise exception 'foody_conexao_destinos: conexão % não existe', new.conexao_id using errcode = '23503'; end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'PENDENTE' then raise exception 'foody_conexao_destinos: todo destino nasce PENDENTE' using errcode = '42501'; end if;
    if new.unidade_id = con.unidade_id then
      raise exception 'foody_conexao_destinos: a unidade titular não é destino da própria conexão' using errcode = '42501';
    end if;
    if new.organizacao_titular_id is distinct from con.organizacao_id then
      raise exception 'foody_conexao_destinos: organização titular diverge da conexão' using errcode = '42501';
    end if;
    -- A unidade de destino não pode ter conexão Foody PRÓPRIA viva (seriam duas fontes para os mesmos pedidos).
    if exists (select 1 from foody_conexoes c where c.unidade_id = new.unidade_id and c.status <> 'REVOGADA') then
      raise exception 'foody_conexao_destinos: a unidade de destino já tem conexão Foody própria' using errcode = '42501';
    end if;
    if new.aprovado_destino_por is not null then
      raise exception 'foody_conexao_destinos: a aprovação do destino é um passo próprio' using errcode = '42501';
    end if;
  else
    if new.conexao_id is distinct from old.conexao_id or new.unidade_id is distinct from old.unidade_id
       or new.operacao is distinct from old.operacao or new.organizacao_titular_id is distinct from old.organizacao_titular_id then
      raise exception 'foody_conexao_destinos: conexão, unidade, operação e titular não mudam (revogue e proponha outro)' using errcode = '42501';
    end if;
    -- Transferência/promoção da unidade de destino (remapeamento de organizacao_id): o vínculo aprovado por outra empresa CAI.
    if new.organizacao_id is distinct from old.organizacao_id then
      if old.estado <> 'REVOGADO' then
        new.estado := 'REVOGADO'; new.revogado_em := now(); new.revogado_por := null;
        new.revogado_motivo := 'Organização da unidade de destino mudou (transferência/promoção).';
      end if;
      new.atualizado_em := now();
      return new;
    end if;
    if old.estado = 'REVOGADO' then raise exception 'foody_conexao_destinos: destino revogado é definitivo' using errcode = '42501'; end if;
    -- Aprovações são gravadas UMA vez.
    if (old.aprovado_titular_por is not null and new.aprovado_titular_por is distinct from old.aprovado_titular_por)
       or (old.aprovado_titular_em is not null and new.aprovado_titular_em is distinct from old.aprovado_titular_em)
       or (old.aprovado_destino_por is not null and new.aprovado_destino_por is distinct from old.aprovado_destino_por)
       or (old.aprovado_destino_em is not null and new.aprovado_destino_em is distinct from old.aprovado_destino_em) then
      raise exception 'foody_conexao_destinos: aprovação registrada não muda' using errcode = '42501';
    end if;
    if not ((old.estado, new.estado) in (('PENDENTE', 'PENDENTE'), ('PENDENTE', 'ATIVO'), ('PENDENTE', 'REVOGADO'), ('ATIVO', 'REVOGADO'))) then
      raise exception 'foody_conexao_destinos: transição % -> % não permitida', old.estado, new.estado using errcode = '42501';
    end if;
    if new.estado = 'REVOGADO' and new.revogado_por is not null
       and not (foody_eh_admin_da_organizacao(new.revogado_por, new.organizacao_titular_id)
                or foody_eh_admin_da_organizacao(new.revogado_por, new.organizacao_id)) then
      raise exception 'foody_conexao_destinos: só organization_admin de uma das organizações revoga' using errcode = '42501';
    end if;
    if new.estado = 'ATIVO' and con.status <> 'ATIVA' then
      raise exception 'foody_conexao_destinos: conexão não está ATIVA' using errcode = '42501';
    end if;
  end if;

  -- Quem aprova: organization_admin ATIVO da organização certa, conferido NO MOMENTO da aprovação.
  if new.aprovado_titular_por is not null and (tg_op = 'INSERT' or old.aprovado_titular_por is null)
     and not foody_eh_admin_da_organizacao(new.aprovado_titular_por, new.organizacao_titular_id) then
    raise exception 'foody_conexao_destinos: aprovação da titular exige organization_admin da organização titular' using errcode = '42501';
  end if;
  if new.aprovado_destino_por is not null and (tg_op = 'INSERT' or old.aprovado_destino_por is null)
     and not foody_eh_admin_da_organizacao(new.aprovado_destino_por, new.organizacao_id) then
    raise exception 'foody_conexao_destinos: aprovação do destino exige organization_admin da organização de destino' using errcode = '42501';
  end if;
  if new.aprovado_destino_por is not null and new.aprovado_titular_por is null then
    raise exception 'foody_conexao_destinos: o destino só aprova depois da titular' using errcode = '42501';
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists trg_foody_destino_validar on foody_conexao_destinos;
create trigger trg_foody_destino_validar before insert or update on foody_conexao_destinos
  for each row execute function foody_destino_validar();
drop trigger if exists trg_foody_destino_tenant on foody_conexao_destinos;
create constraint trigger trg_foody_destino_tenant after insert or update on foody_conexao_destinos
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_destino_imutavel_del on foody_conexao_destinos;
create trigger trg_foody_destino_imutavel_del before delete on foody_conexao_destinos
  for each row execute function foody_registro_imutavel();

-- Mudança da organização da conexão (transferência da unidade TITULAR): todos os destinos vivos caem.
create or replace function foody_conexao_revogar_destinos() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id or (new.status = 'REVOGADA' and old.status <> 'REVOGADA') then
    update foody_conexao_destinos
       set estado = 'REVOGADO', revogado_em = now(), revogado_por = null,
           revogado_motivo = case when new.organizacao_id is distinct from old.organizacao_id
                                  then 'Organização da unidade titular mudou (transferência/promoção).'
                                  else 'Conexão revogada.' end
     where conexao_id = new.id and estado <> 'REVOGADO';
  end if;
  return null;
end $$;
drop trigger if exists trg_foody_conexoes_revogar_destinos on foody_conexoes;
create trigger trg_foody_conexoes_revogar_destinos after update on foody_conexoes
  for each row execute function foody_conexao_revogar_destinos();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Auditoria do vínculo (somente inclusão, gerada pelo banco — não dá para pular)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_destinos_eventos (
  id uuid primary key default gen_random_uuid(),
  destino_id uuid not null references foody_conexao_destinos(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  evento text not null check (evento in ('PROPOSTO', 'APROVADO_TITULAR', 'APROVADO_DESTINO', 'ATIVADO', 'REVOGADO')),
  ator_perfil_id uuid,                                          -- null = automático (transferência/revogação da conexão)
  motivo text check (motivo is null or length(motivo) <= 300),
  criado_em timestamptz not null default now()
);
create index if not exists idx_foody_destinos_eventos on foody_destinos_eventos(destino_id, criado_em);

-- SECURITY DEFINER: o service_role NÃO tem INSERT em foody_destinos_eventos (a trilha só nasce por aqui, não dá para forjar).
create or replace function foody_destino_auditar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id)
      values (new.id, new.organizacao_id, new.unidade_id, 'PROPOSTO', new.aprovado_titular_por);
    if new.aprovado_titular_por is not null then
      insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id)
        values (new.id, new.organizacao_id, new.unidade_id, 'APROVADO_TITULAR', new.aprovado_titular_por);
    end if;
    return null;
  end if;
  if old.aprovado_titular_por is null and new.aprovado_titular_por is not null then
    insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id)
      values (new.id, new.organizacao_id, new.unidade_id, 'APROVADO_TITULAR', new.aprovado_titular_por);
  end if;
  if old.aprovado_destino_por is null and new.aprovado_destino_por is not null then
    insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id)
      values (new.id, new.organizacao_id, new.unidade_id, 'APROVADO_DESTINO', new.aprovado_destino_por);
  end if;
  if old.estado <> 'ATIVO' and new.estado = 'ATIVO' then
    insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id)
      values (new.id, new.organizacao_id, new.unidade_id, 'ATIVADO', new.aprovado_destino_por);
  end if;
  if old.estado <> 'REVOGADO' and new.estado = 'REVOGADO' then
    insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento, ator_perfil_id, motivo)
      values (new.id, new.organizacao_id, new.unidade_id, 'REVOGADO', new.revogado_por, new.revogado_motivo);
  end if;
  return null;
end $$;
drop trigger if exists trg_foody_destino_auditar on foody_conexao_destinos;
create trigger trg_foody_destino_auditar after insert or update on foody_conexao_destinos
  for each row execute function foody_destino_auditar();

drop trigger if exists trg_foody_destinos_eventos_tenant on foody_destinos_eventos;
create constraint trigger trg_foody_destinos_eventos_tenant after insert or update on foody_destinos_eventos
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_destinos_eventos_imutavel on foody_destinos_eventos;
create trigger trg_foody_destinos_eventos_imutavel before update or delete on foody_destinos_eventos
  for each row execute function foody_registro_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Pedidos: conexão de origem, destino, roteamento ativo e TRIAGEM
-- ---------------------------------------------------------------------------------------------------------------------------
alter table foody_pedidos add column if not exists conexao_id uuid references foody_conexoes(id);
alter table foody_pedidos add column if not exists destino_id uuid references foody_conexao_destinos(id);
alter table foody_pedidos add column if not exists roteamento_ativo boolean not null default true;
alter table foody_pedidos add column if not exists roteamento_motivo text
  check (roteamento_motivo is null or roteamento_motivo ~ '^[A-Z_]{2,40}$');
alter table foody_pedidos add column if not exists triagem_motivo text
  check (triagem_motivo is null or triagem_motivo ~ '^[A-Z_]{2,40}$');
alter table foody_pedidos add column if not exists catalogo_versao text
  check (catalogo_versao is null or length(catalogo_versao) <= 40);

-- Operação passa a aceitar 'triagem' (classificação sem evidência segura no modo compartilhado).
alter table foody_pedidos drop constraint if exists foody_pedidos_operacao_check;
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_operacao;
alter table foody_pedidos add constraint ck_foody_pedidos_operacao
  check (operacao in ('subway', 'acai_no_grau', 'revisao_necessaria', 'triagem'));

-- Dado comercial: titular (subway/revisão) OU destino da própria operação (validado pela trigger abaixo). Triagem e linha
-- desativada: nunca. A regra da 144 (outra operação sem destino = só o mínimo) continua.
alter table foody_pedidos drop constraint if exists ck_foody_pedidos_outra_operacao_minima;
alter table foody_pedidos add constraint ck_foody_pedidos_outra_operacao_minima check (
  (operacao in ('subway', 'revisao_necessaria') and destino_id is null)
  or (operacao not in ('subway', 'revisao_necessaria', 'triagem') and destino_id is not null)
  or (detalhes_pedido is null and valor_total is null and taxa_entrega is null and forma_pagamento is null
      and cancelamento_razao is null and cancelamento_justificativa is null)
  or (operacao = 'triagem' and valor_total is null and taxa_entrega is null and forma_pagamento is null
      and cancelamento_razao is null and cancelamento_justificativa is null));
alter table foody_pedidos add constraint ck_foody_pedidos_triagem check (
  operacao <> 'triagem' or (destino_id is null and triagem_motivo is not null));
alter table foody_pedidos add constraint ck_foody_pedidos_inativo_minimo check (
  roteamento_ativo or (roteamento_motivo is not null and detalhes_pedido is null and valor_total is null and taxa_entrega is null
    and forma_pagamento is null and cancelamento_razao is null and cancelamento_justificativa is null));

-- NUNCA ativo em duas unidades/organizações (destino, titular e triagem estão na mesma tabela).
create unique index if not exists uq_foody_pedidos_conexao_uid_ativo on foody_pedidos(conexao_id, foody_uid)
  where roteamento_ativo and conexao_id is not null;
create index if not exists idx_foody_pedidos_conexao_competencia on foody_pedidos(conexao_id, competencia) where roteamento_ativo;

create or replace function foody_pedido_validar_destino() returns trigger
language plpgsql set search_path = public as $$
declare
  exec_conexao uuid;
  con record;
  d record;
  escrita_de_dado boolean;
begin
  select e.conexao_id into exec_conexao from foody_sync_execucoes e where e.id = new.ultima_execucao_id;
  if new.conexao_id is null then new.conexao_id := exec_conexao; end if;
  if new.conexao_id is distinct from exec_conexao then
    raise exception 'foody_pedidos: conexao_id diverge da conexão da execução' using errcode = '42501';
  end if;
  -- Conexão e uid são fixos; a única transição aceita é nula → conexão da execução (linha gravada pela 144 antes desta migration).
  if tg_op = 'UPDATE' and ((old.conexao_id is not null and new.conexao_id is distinct from old.conexao_id)
                           or new.foody_uid is distinct from old.foody_uid) then
    raise exception 'foody_pedidos: conexão e uid de um pedido não mudam' using errcode = '42501';
  end if;
  -- Escrita de DADO (nova sincronização ou reativação) — distinta de desativação e de remapeamento de organização.
  escrita_de_dado := tg_op = 'INSERT' or new.ultima_execucao_id is distinct from old.ultima_execucao_id
                     or (new.roteamento_ativo and not old.roteamento_ativo);

  select c.unidade_id into con from foody_conexoes c where c.id = new.conexao_id;
  if new.destino_id is null then
    -- Sem destino, a linha só existe na unidade TITULAR da conexão.
    if new.unidade_id is distinct from con.unidade_id then
      raise exception 'foody_pedidos: pedido em unidade que não é a titular exige destino' using errcode = '42501';
    end if;
  else
    select * into d from foody_conexao_destinos x where x.id = new.destino_id;
    if not found or d.conexao_id <> new.conexao_id or d.unidade_id <> new.unidade_id or d.operacao <> new.operacao then
      raise exception 'foody_pedidos: destino não confere com conexão, unidade e operação do pedido' using errcode = '42501';
    end if;
    if escrita_de_dado and new.roteamento_ativo and d.estado <> 'ATIVO' then
      raise exception 'foody_pedidos: destino % não está ATIVO', d.estado using errcode = '42501';
    end if;
  end if;
  if not new.roteamento_ativo and new.roteamento_motivo is null then
    raise exception 'foody_pedidos: desativação exige motivo' using errcode = '42501';
  end if;
  -- Linha DESATIVADA só recebe dado novo se for reativada explicitamente. Impede que uma sincronização sem o modo compartilhado
  -- (flag desligada com destino em uso) regrave a linha antiga e a deixe inativa em silêncio — falha alto, em vez de sumir.
  if tg_op = 'UPDATE' and not old.roteamento_ativo and not new.roteamento_ativo
     and new.ultima_execucao_id is distinct from old.ultima_execucao_id then
    raise exception 'foody_pedidos: linha desativada recebe dado novo só quando reativada' using errcode = '42501';
  end if;
  if new.roteamento_ativo then new.roteamento_motivo := null; end if;
  return new;
end $$;
drop trigger if exists trg_foody_pedidos_valida_destino on foody_pedidos;
create trigger trg_foody_pedidos_valida_destino before insert or update on foody_pedidos
  for each row execute function foody_pedido_validar_destino();
-- Linhas gravadas pela 144 antes desta migration (se houver) ganham a conexão da própria execução: assim TODO pedido entra na
-- unicidade global. Idempotente; não muda dado comercial nem o estado da linha.
update foody_pedidos p set conexao_id = e.conexao_id
  from foody_sync_execucoes e where p.conexao_id is null and e.id = p.ultima_execucao_id;

-- Vínculo com a execução (substitui a versão da 144): mesma unidade OU unidade que é destino da conexão da execução.
-- Aceita destino em qualquer estado aqui (atualizações de transferência de linhas antigas); a exigência de destino ATIVO para
-- gravar dado novo fica em foody_pedido_validar_destino e em foody_fech_exigir_destino_ativo.
create or replace function foody_validar_vinculo_execucao() returns trigger
language plpgsql set search_path = public as $$
declare
  col text := tg_argv[0];
  ref_id uuid;
begin
  ref_id := (to_jsonb(new) ->> col)::uuid;
  if ref_id is null then return new; end if;
  if exists (select 1 from foody_sync_execucoes e where e.id = ref_id and e.unidade_id = new.unidade_id) then return new; end if;
  if exists (select 1 from foody_sync_execucoes e join foody_conexao_destinos d on d.conexao_id = e.conexao_id
              where e.id = ref_id and d.unidade_id = new.unidade_id) then return new; end if;
  raise exception '%: % aponta para execução de outra unidade', tg_table_name, col using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Execução: contagem da distribuição (sem valores)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table foody_sync_execucoes add column if not exists pedidos_triagem integer not null default 0 check (pedidos_triagem >= 0);
alter table foody_sync_execucoes add column if not exists distribuicao jsonb not null default '{}'::jsonb;
alter table foody_sync_execucoes add column if not exists catalogo_versao text check (catalogo_versao is null or length(catalogo_versao) <= 40);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Fechamento de unidade DESTINO: só com destino ATIVO no momento da gravação
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function foody_fech_exigir_destino_ativo() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.sync_execucao_id is null then return new; end if;
  if exists (select 1 from foody_sync_execucoes e where e.id = new.sync_execucao_id and e.unidade_id = new.unidade_id) then return new; end if;
  if not exists (select 1 from foody_sync_execucoes e join foody_conexao_destinos d on d.conexao_id = e.conexao_id
                  where e.id = new.sync_execucao_id and d.unidade_id = new.unidade_id and d.estado = 'ATIVO') then
    raise exception 'foody_fechamentos_logisticos: unidade sem destino ATIVO na conexão da sincronização' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_foody_fech_destino_ativo on foody_fechamentos_logisticos;
create trigger trg_foody_fech_destino_ativo before insert on foody_fechamentos_logisticos
  for each row execute function foody_fech_exigir_destino_ativo();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Decisões de triagem (somente inclusão, auditáveis). A última decisão de cada uid vale nas próximas sincronizações.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_triagem_decisoes (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references foody_conexoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,     -- tenant da conexão (titular)
  unidade_id uuid not null references unidades(id) on delete cascade,
  foody_uid text not null check (length(foody_uid) between 1 and 80),
  operacao_decidida text not null check (operacao_decidida in ('subway', 'acai_no_grau')),
  decidido_por uuid not null,
  motivo text not null check (length(btrim(motivo)) between 3 and 300),
  catalogo_versao text check (catalogo_versao is null or length(catalogo_versao) <= 40),
  decidido_em timestamptz not null default now()
);
create index if not exists idx_foody_triagem_decisoes on foody_triagem_decisoes(conexao_id, foody_uid, decidido_em desc);

create or replace function foody_triagem_decisao_validar() returns trigger
language plpgsql set search_path = public as $$
declare
  con record;
begin
  select c.organizacao_id, c.unidade_id into con from foody_conexoes c where c.id = new.conexao_id;
  if not found or con.unidade_id <> new.unidade_id then
    raise exception 'foody_triagem_decisoes: a decisão fica no tenant da conexão' using errcode = '42501';
  end if;
  -- Quem decide: admin da titular, ou admin de uma organização com destino ATIVO nesta conexão.
  if not (foody_eh_admin_da_organizacao(new.decidido_por, con.organizacao_id)
          or exists (select 1 from foody_conexao_destinos d where d.conexao_id = new.conexao_id and d.estado = 'ATIVO'
                      and foody_eh_admin_da_organizacao(new.decidido_por, d.organizacao_id))) then
    raise exception 'foody_triagem_decisoes: só organization_admin de uma organização do vínculo decide' using errcode = '42501';
  end if;
  if not exists (select 1 from foody_pedidos p where p.conexao_id = new.conexao_id and p.foody_uid = new.foody_uid) then
    raise exception 'foody_triagem_decisoes: pedido % não existe nesta conexão', new.foody_uid using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists trg_foody_triagem_decisao_validar on foody_triagem_decisoes;
create trigger trg_foody_triagem_decisao_validar before insert on foody_triagem_decisoes
  for each row execute function foody_triagem_decisao_validar();
drop trigger if exists trg_foody_triagem_decisao_tenant on foody_triagem_decisoes;
create constraint trigger trg_foody_triagem_decisao_tenant after insert or update on foody_triagem_decisoes
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_triagem_decisao_imutavel on foody_triagem_decisoes;
create trigger trg_foody_triagem_decisao_imutavel before update or delete on foody_triagem_decisoes
  for each row execute function foody_registro_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. RLS e privilégios (mesmo padrão da 144)
-- ---------------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['foody_conexao_destinos', 'foody_destinos_eventos', 'foody_triagem_decisoes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on public.%I from service_role', t);   -- zera privilégio padrão; o necessário vem abaixo
    end if;
  end loop;
end $$;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Destinos: propor (insert), aprovar/revogar (update de colunas). Sem DELETE: revogar = estado REVOGADO.
    grant select, insert on foody_conexao_destinos to service_role;
    grant update (estado, aprovado_titular_por, aprovado_titular_em, aprovado_destino_por, aprovado_destino_em,
                  revogado_por, revogado_em, revogado_motivo, organizacao_id, atualizado_em) on foody_conexao_destinos to service_role;
    -- Eventos: escritos SÓ pela trigger; o backend lê. UPDATE só de organizacao_id (transferência de unidade).
    grant select on foody_destinos_eventos to service_role;
    grant update (organizacao_id) on foody_destinos_eventos to service_role;
    grant select, insert on foody_triagem_decisoes to service_role;
    grant update (organizacao_id) on foody_triagem_decisoes to service_role;
    -- foody_pedidos/foody_sync_execucoes já têm SELECT/INSERT/UPDATE de tabela (144): as colunas novas herdam.
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['foody_eh_admin_da_organizacao(uuid, uuid)', 'foody_destino_validar()', 'foody_conexao_revogar_destinos()',
    'foody_destino_auditar()', 'foody_pedido_validar_destino()', 'foody_fech_exigir_destino_ativo()', 'foody_triagem_decisao_validar()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
