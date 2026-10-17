-- PROVISÓRIO — rollback da 122 única (conciliação + períodos + cancelamento de transferência + exceção de fechamento + endurecimentos F-A/F-B).
-- AUTO-RESTAURA o estado da 121: recria fin_lancamentos_guarda e fin_confirmar_importacao (versões da 121) e devolve o EXECUTE de
-- fin_desvincular_transferencia ao service_role. NÃO é preciso reaplicar a 121 depois (F-C do Agente 1). Tudo numa transação: ou volta inteiro, ou nada.
-- RECUSA se houver DADOS nas estruturas novas. Linhas 'aberto' VAZIAS em fin_periodos (âncoras de trava criadas pela 122, ex.: GET/lançamento em mês vazio)
-- são descartadas — sem snapshot nem responsável, não são dado — para que o rollback da 121 não seja bloqueado por elas.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('public.fin_referencias') is not null then
    if exists (select 1 from fin_referencias) or exists (select 1 from fin_conciliacao_resolucoes) or exists (select 1 from fin_sangria_excecoes)
       or (to_regclass('public.fin_excecoes_fechamento') is not null and exists (select 1 from fin_excecoes_fechamento))
       or exists (select 1 from fin_lancamentos where revisao_motivos <> '{}') or exists (select 1 from fin_contas where canal_referencia is not null)
       or exists (select 1 from fin_periodos where status <> 'aberto' or snapshot is not null)
       or exists (select 1 from fin_transferencias where status <> 'vinculada') then
      raise exception 'rollback recusado: ha dados de conciliacao/periodos/cancelamento/excecao; exporte e descarte de forma supervisionada';
    end if;
  end if;
end $$;

-- 1) Restaura as funções da 121 (cópia literal) ANTES de remover o que a 122 introduziu.
create or replace function fin_lancamentos_guarda() returns trigger language plpgsql as $$
declare mes_novo date; mes_velho date;
begin
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
       or new.origem is distinct from old.origem or new.chave_origem is distinct from old.chave_origem
       or new.importacao_id is distinct from old.importacao_id or new.criado_por is distinct from old.criado_por then
      raise exception 'fin_campo_imutavel' using errcode = '23514';
    end if;
    if (new.valor_centavos is distinct from old.valor_centavos or new.sentido is distinct from old.sentido
        or new.conta_id is distinct from old.conta_id or new.data_movimento is distinct from old.data_movimento
        or new.status is distinct from old.status)
       and exists (select 1 from fin_transferencias t where t.lancamento_saida_id = old.id or t.lancamento_entrada_id = old.id) then
      raise exception 'fin_transferencia_vinculada: desvincule o par antes de alterar este lancamento' using errcode = '23514';
    end if;
    mes_velho := date_trunc('month', old.data_movimento)::date;
  end if;
  mes_novo := date_trunc('month', new.data_movimento)::date;
  if exists (select 1 from fin_periodos p where p.unidade_id = new.unidade_id and p.status = 'fechado' and p.mes in (mes_novo, coalesce(mes_velho, mes_novo))) then
    raise exception 'fin_periodo_fechado' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function fin_confirmar_importacao(p_org uuid, p_unidade uuid, p_usuario uuid, p_importacao uuid)
returns jsonb language plpgsql as $$
declare v fin_importacoes; n_lanc int; n_dup int; n_saldos int; n_pares int; r jsonb;
begin
  select * into v from fin_importacoes where id = p_importacao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin_importacao_nao_encontrada' using errcode = 'P0002'; end if;
  if v.status = 'confirmada' then return coalesce(v.resumo, '{}'::jsonb) || jsonb_build_object('jaConfirmada', true); end if;
  if v.status <> 'previa' then raise exception 'fin_importacao_estado_invalido: %', v.status using errcode = '23514'; end if;

  insert into fin_contas (organizacao_id, unidade_id, nome, tipo_conta, criado_por, atualizado_por)
  select p_org, p_unidade, c->>'nome', coalesce(c->>'tipo_conta','outra'), p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'contas','[]')) c on conflict (unidade_id, nome) do nothing;

  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel, criado_por, atualizado_por)
  select p_org, c->>'tipo', c->>'natureza', c->>'nome', c->>'papel', p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'categorias','[]')) c on conflict (organizacao_id, tipo, natureza, nome) do nothing;

  insert into fin_saldos_abertura (organizacao_id, unidade_id, conta_id, data_referencia, valor_centavos, origem, criado_por)
  select p_org, p_unidade, c.id, (s->>'data')::date, (s->>'valor_centavos')::bigint, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'saldos','[]')) s
  join fin_contas c on c.unidade_id = p_unidade and c.nome = s->>'conta'
  on conflict (conta_id, data_referencia) do nothing;
  get diagnostics n_saldos = row_count;

  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento,
                               origem, importacao_id, chave_origem, referencia_origem, classificacao_pendente, nota_revisao, criado_por, atualizado_por)
  select p_org, p_unidade, c.id, pc.id, l->>'descricao', l->>'sentido', (l->>'valor_centavos')::bigint, (l->>'data')::date,
         'importacao', p_importacao, l->>'chave', l->>'referencia', coalesce((l->>'pendente')::boolean, false) or pc.id is null,
         nullif(l->>'nota',''), p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l
  join fin_contas c on c.unidade_id = p_unidade and c.nome = l->>'conta'
  left join fin_plano_contas pc on pc.organizacao_id = p_org and l->'categoria' is not null and jsonb_typeof(l->'categoria') = 'object'
       and pc.tipo = l#>>'{categoria,tipo}' and pc.natureza = l#>>'{categoria,natureza}' and pc.nome = l#>>'{categoria,nome}'
  where coalesce((l->>'importar')::boolean, true)
  on conflict (organizacao_id, unidade_id, chave_origem) where chave_origem is not null do nothing;
  get diagnostics n_lanc = row_count;
  n_dup := (select count(*) from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l where coalesce((l->>'importar')::boolean, true)) - n_lanc;

  insert into fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id, origem, criado_por)
  select p_org, p_unidade, ls.id, le.id, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'pares','[]')) p
  join fin_lancamentos ls on ls.organizacao_id = p_org and ls.unidade_id = p_unidade and ls.chave_origem = p->>'saida'
  join fin_lancamentos le on le.organizacao_id = p_org and le.unidade_id = p_unidade and le.chave_origem = p->>'entrada'
  where coalesce((p->>'confirmado')::boolean, false)
  on conflict do nothing;
  get diagnostics n_pares = row_count;

  r := jsonb_build_object('lancamentosGravados', n_lanc, 'jaExistentes', n_dup, 'saldosGravados', n_saldos, 'paresVinculados', n_pares);
  update fin_importacoes set status = 'confirmada', resumo = r, confirmado_por = p_usuario, confirmado_em = now() where id = p_importacao;
  return r;
end $$;

do $$
declare r text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function fin_desvincular_transferencia(uuid,uuid,uuid,uuid) to service_role;
    grant execute on function fin_confirmar_importacao(uuid,uuid,uuid,uuid) to service_role;
  end if;
end $$;

-- 2) Remove o que a 122 criou.
drop trigger if exists trg_fin_periodos_bloqueia_reabertura on fin_periodos;
drop trigger if exists trg_fin_par_status_consistente on fin_lancamentos;
drop trigger if exists trg_fin_transferencias_guarda on fin_transferencias;
drop trigger if exists trg_fin_saldos_periodo on fin_saldos_abertura;
drop trigger if exists trg_fin_periodos_guarda on fin_periodos;
drop function if exists fin_periodos_bloqueia_reabertura();
drop function if exists fin_conceder_excecao_fechamento(uuid,uuid,uuid,date,text,int,int,jsonb);
drop function if exists fin_revogar_excecao_fechamento(uuid,uuid,uuid,uuid,text);
drop function if exists fin_consumir_excecao_fechamento(uuid,uuid);
drop function if exists fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text);
drop function if exists fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text);
drop function if exists fin_par_status_consistente();
drop function if exists fin_transferencias_guarda();
drop function if exists fin_reabrir_periodo(uuid,uuid,uuid,date,int,text);
drop function if exists fin_fechar_periodo(uuid,uuid,uuid,date,int,text,jsonb,int,boolean);
drop function if exists fin_abrir_periodo(uuid,uuid,uuid,date);
drop function if exists fin_fingerprint_periodo(uuid,uuid,date);
drop table if exists fin_excecoes_fechamento cascade;
drop function if exists fin_mfa_evidencia_valida(jsonb);
drop function if exists fin_excecoes_fechamento_guarda();
drop table if exists fin_sangria_excecoes, fin_conciliacao_resolucoes, fin_referencias cascade;
drop function if exists fin_guarda_periodo_data();
drop function if exists fin_periodos_guarda();
-- a 121 restaurada acima não depende da trava; só agora é seguro removê-la
drop function if exists fin_periodo_travar_e_checar(uuid,uuid,date) cascade;
alter table fin_lancamentos drop constraint if exists fin_lancamentos_importacao_tenant_fk;
alter table fin_lancamentos drop constraint if exists fin_lancamentos_importacao_fk;
alter table fin_importacoes drop constraint if exists fin_importacoes_tenant_uk;
alter table fin_transferencias drop constraint if exists fin_transferencias_cancelamento_check;
alter table fin_transferencias drop constraint if exists fin_transferencias_status_check;
alter table fin_transferencias drop column if exists motivo_cancelamento, drop column if exists cancelada_em, drop column if exists cancelada_por, drop column if exists status;
alter table fin_lancamentos drop column if exists revisao_motivos;
alter table fin_contas drop column if exists canal_referencia;
-- âncoras vazias de trava (nenhuma outra linha existe, garantido pela recusa acima)
delete from fin_periodos where status = 'aberto' and snapshot is null;
alter table fin_periodos drop column if exists versao;
commit;
