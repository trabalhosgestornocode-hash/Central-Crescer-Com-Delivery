-- =====================================================================================================================
-- Financeiro v2 — migração 0013: AÇÕES GRANULARES (Execução 08B)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Separa decisões sensíveis que antes dividiam a mesma ação:
--   aprovar (aprovar/rejeitar proposta) ≠ aplicar (aplicar proposta aprovada) ≠ revisar;
--   conceder ≠ revogar; importar ≠ confirmar_importacao; homologar ≠ reabrir (antes: revisar).
--
-- MIGRAÇÃO RESTRITIVA: nenhuma concessão existente recebe as ações novas. Quem tinha `revisar`, `importar` ou
-- `conceder` continua com elas e PERDE, na prática, aprovar/aplicar/confirmar/revogar/reabrir até receber concessão
-- explícita (registrada, justificada e auditada pelo fluxo normal).
--
-- O mapa tabela × operação foi MEDIDO de novo com a suíte instrumentada (docs/financeiro-v2/18, seção 4).
-- =====================================================================================================================

-- 1) Catálogo do banco.
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint where conrelid = 'fv2_concessao'::regclass and pg_get_constraintdef(oid) like '%<@%' loop
    execute format('alter table fv2_concessao drop constraint %I', r.conname);
  end loop;
end $$;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir"]'::jsonb);

-- 2) Conceder ≠ revogar na função guardada (mesma assinatura, dono e privilégios mantidos).
create or replace function fv2_gravar_concessao(p jsonb, p_versao_esperada integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  s fv2_sessao_vigente;
  r fv2_concessao;
  atual fv2_concessao;
  ator jsonb;
  antes jsonb;
  novas jsonb;
  removidas jsonb;
  operacao text;
  n integer;
begin
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco ausente, expirada ou revogada.' using errcode = '42501';
  end if;
  r := jsonb_populate_record(null::fv2_concessao, p);
  if r.organizacao_id is distinct from s.organizacao_id or r.unidade_id is distinct from s.unidade_id then
    raise exception 'Financeiro v2: concessão fora do escopo da sessão.' using errcode = '42501';
  end if;
  perform fv2__trava_concessoes(s.organizacao_id, s.unidade_id, true);
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco revogada durante a operação.' using errcode = '42501';
  end if;
  if r.usuario_id = s.usuario_id then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if r.atualizado_por is distinct from s.usuario_id or r.concedido_por is distinct from s.usuario_id then
    raise exception 'Financeiro v2: a autoria da concessão é a do usuário da sessão.' using errcode = 'FV031';
  end if;
  select * into atual from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id;
  if atual.id is not null and atual.usuario_id <> r.usuario_id then
    raise exception 'Financeiro v2: uma concessão não muda de usuário.' using errcode = 'FV033';
  end if;
  antes := case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end;
  select coalesce(jsonb_agg(a), '[]'::jsonb) into novas from jsonb_array_elements_text(r.acoes) a where not (antes ? a);
  select coalesce(jsonb_agg(a), '[]'::jsonb) into removidas from jsonb_array_elements_text(antes) a
   where r.situacao <> 'ATIVA' or not (r.acoes ? a);

  if s.finalidade = 'PROVISIONAMENTO' then
    if r.usuario_id is distinct from s.alvo or r.situacao <> 'ATIVA' or fv2__acoes_ordenadas(r.acoes) is distinct from s.acoes_autorizadas then
      raise exception 'Financeiro v2: o provisionamento grava exatamente o que foi atestado.' using errcode = 'FV035';
    end if;
    if exists (select 1 from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id
                and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: a unidade já tem administrador.' using errcode = 'FV035';
    end if;
    operacao := 'PROVISIONAMENTO';
  else
    select c.acoes into ator from fv2_concessao c
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id and c.situacao = 'ATIVA';
    -- Acrescentar exige `conceder` (e só repassa o que o ator tem); retirar exige `revogar`.
    if jsonb_array_length(novas) > 0 and (ator is null or not (ator ? 'financeiro_v2.conceder')) then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para conceder.' using errcode = 'FV032';
    end if;
    if jsonb_array_length(removidas) > 0 and (ator is null or not (ator ? 'financeiro_v2.revogar')) then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para revogar.' using errcode = 'FV036';
    end if;
    if jsonb_array_length(novas) = 0 and jsonb_array_length(removidas) = 0 and (ator is null or not (ator ?| array['financeiro_v2.conceder', 'financeiro_v2.revogar'])) then
      raise exception 'Financeiro v2: o usuário da sessão não administra concessões.' using errcode = 'FV032';
    end if;
    if exists (select 1 from jsonb_array_elements_text(novas) a where not (ator ? a)) then
      raise exception 'Financeiro v2: não é possível conceder uma ação que você não possui.' using errcode = 'FV034';
    end if;
    operacao := case when jsonb_array_length(novas) > 0 and jsonb_array_length(removidas) > 0 then 'CONCESSAO_E_REVOGACAO'
                     when jsonb_array_length(novas) > 0 then 'CONCESSAO' else 'REVOGACAO' end;
  end if;

  if p_versao_esperada is null then
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                               chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (r.id, r.organizacao_id, r.unidade_id, r.versao, r.criado_em, r.criado_por, r.atualizado_em, r.atualizado_por,
            r.chave_idempotencia, r.impressao, coalesce(r.extras, '{}'::jsonb), r.usuario_id, r.acoes, r.situacao, r.concedido_por, r.justificativa);
    n := 1;
  else
    update fv2_concessao c
       set versao = r.versao, atualizado_em = r.atualizado_em, atualizado_por = r.atualizado_por, impressao = r.impressao,
           extras = coalesce(r.extras, '{}'::jsonb), acoes = r.acoes, situacao = r.situacao, concedido_por = r.concedido_por,
           justificativa = r.justificativa
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id and c.versao = p_versao_esperada;
    get diagnostics n = row_count;
    if n = 0 then
      return 0;
    end if;
  end if;

  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (s.organizacao_id, s.unidade_id, r.id, r.usuario_id, s.usuario_id, s.sessao_id, s.finalidade, operacao,
          coalesce(atual.acoes, '[]'::jsonb), r.acoes, r.situacao, r.justificativa);
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada'
   where b.usuario_id = r.usuario_id and b.organizacao_id = s.organizacao_id and b.unidade_id = s.unidade_id and b.revogada_em is null;
  if s.finalidade = 'PROVISIONAMENTO' then
    update fv2_provisionamento_inicial pi set concluido_em = clock_timestamp() where pi.sessao_id = s.sessao_id and pi.concluido_em is null;
  end if;
  return n;
end $$;

-- 3) Políticas por ação com o mapa novo (medido).
create temporary table fv2__mapa (tabela text, operacao text, acoes text[]) on commit drop;
insert into fv2__mapa values
  ('fv2_ajuste', 'I', '{aplicar,cancelar,corrigir,registrar}'),
  ('fv2_atribuicao_pendencia', 'I', '{revisar}'), ('fv2_atribuicao_pendencia', 'U', '{revisar}'),
  ('fv2_canal_processador', 'I', '{configurar}'), ('fv2_canal_processador', 'U', '{configurar}'),
  ('fv2_categoria', 'I', '{configurar,registrar}'), ('fv2_categoria', 'U', '{configurar}'),
  ('fv2_competencia', 'I', '{fechar}'), ('fv2_competencia', 'U', '{fechar,homologar,reabrir}'),
  ('fv2_configuracao_unidade', 'I', '{configurar}'), ('fv2_configuracao_unidade', 'U', '{configurar}'),
  ('fv2_conta', 'I', '{configurar}'), ('fv2_conta', 'U', '{configurar}'),
  ('fv2_contraparte', 'I', '{aplicar,registrar}'), ('fv2_contraparte', 'U', '{registrar,configurar}'),
  ('fv2_correspondencia', 'I', '{conciliar}'), ('fv2_correspondencia', 'U', '{conciliar}'),
  ('fv2_divergencia_fonte', 'I', '{registrar,importar}'), ('fv2_divergencia_fonte', 'U', '{revisar}'),
  ('fv2_documento', 'I', '{importar,registrar}'), ('fv2_documento', 'U', '{confirmar_importacao,registrar}'),
  ('fv2_estorno', 'I', '{cancelar}'),
  ('fv2_importacao', 'I', '{importar}'), ('fv2_importacao', 'U', '{confirmar_importacao,importar}'),
  ('fv2_lancamento', 'I', '{aplicar,cancelar,corrigir,registrar,revisar}'), ('fv2_lancamento', 'U', '{cancelar,corrigir,revisar}'),
  ('fv2_liquidacao', 'I', '{registrar,aplicar}'), ('fv2_liquidacao', 'U', '{cancelar}'),
  ('fv2_movimentacao', 'I', '{aplicar,cancelar,registrar,revisar}'), ('fv2_movimentacao', 'U', '{cancelar,conciliar,registrar}'),
  ('fv2_obrigacao', 'I', '{aplicar,registrar}'), ('fv2_obrigacao', 'U', '{cancelar,corrigir,registrar}'),
  ('fv2_pagamento_venda', 'I', '{aplicar,registrar,revisar}'), ('fv2_pagamento_venda', 'U', '{cancelar}'),
  ('fv2_proposta', 'I', '{registrar,importar}'), ('fv2_proposta', 'U', '{aplicar,aprovar,cancelar,registrar,revisar}'),
  ('fv2_recebivel', 'I', '{aplicar,registrar}'), ('fv2_recebivel', 'U', '{aplicar,cancelar,corrigir,registrar}'),
  ('fv2_registro_fonte', 'I', '{confirmar_importacao}'), ('fv2_registro_fonte', 'U', '{confirmar_importacao}'),
  ('fv2_saldo_conta', 'I', '{registrar}'),
  ('fv2_sessao_caixa', 'I', '{registrar}'), ('fv2_sessao_caixa', 'U', '{registrar}'),
  ('fv2_transferencia', 'I', '{registrar}'), ('fv2_transferencia', 'U', '{cancelar}'),
  ('fv2_venda', 'I', '{aplicar,registrar,revisar}'), ('fv2_venda', 'U', '{aplicar,cancelar,registrar}'),
  ('fv2_versao_fechamento', 'I', '{fechar,homologar,reabrir}'),
  ('fv2_vinculo_documental', 'I', '{registrar,importar}');

do $$
declare
  t record;
  acoes text;
  inc text;
  alt text;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'I';
    inc := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'U';
    alt := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    execute format('alter policy %I on %I with check (%s)', t.relname || '_incluir', t.relname, inc);
    -- USING (alcançar/reservar a linha, inclusive SELECT ... FOR UPDATE de registros REFERENCIADOS pela operação, como a
    -- conta do caixa ao aplicar uma venda): qualquer ação de escrita. A ALTERAÇÃO em si é decidida no WITH CHECK, só
    -- com as ações da tabela — e quem não as tem recebe ERRO explícito, nunca um UPDATE "que não achou nada".
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s]))) with check (%s)', t.relname || '_alterar', t.relname, escritas, alt);
  end loop;
end $$;

alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- 4) Reabrir competência homologada exige `reabrir` (espelho de dominio/fechamento.js).
create or replace function fv2_exigir_acao_da_transicao() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case
    when new.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.homologar'
    when tg_op = 'UPDATE' and old.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.reabrir'
    else 'financeiro_v2.fechar' end;
  if not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: a mudança de estado da competência exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;

-- 5) Proposta: a decisão depende da TRANSIÇÃO de estado (a tabela também é alterada por outras ações legítimas,
--    então o mapa por tabela não basta): aprovar/rejeitar exige `aprovar`; aplicar exige `aplicar`.
create function fv2_exigir_acao_da_proposta() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case new.estado
    when 'APROVADA' then 'financeiro_v2.aprovar'
    when 'REJEITADA' then 'financeiro_v2.aprovar'
    when 'APLICADA' then 'financeiro_v2.aplicar'
    else null end;
  if exigida is not null and not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: esta decisão sobre a proposta exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_proposta_acao before insert or update on fv2_proposta for each row execute function fv2_exigir_acao_da_proposta();
