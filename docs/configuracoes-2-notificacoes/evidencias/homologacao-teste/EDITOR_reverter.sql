-- PROJETO DE TESTE APENAS (wiqqsxnysbzhcrzrrean / teste-multiempresarial). Uma transação: tudo ou nada.
begin;
-- Pacote REVERTER 135→132 — gerado de database/migrations em 2026-10-30T17:04:19.432Z. SOMENTE projeto de TESTE.

-- ===== 135_rollback.sql =====
-- Rollback da 135 — remove as cotas próprias das categorias novas. O D-1 não é afetado (nunca teve cota própria). Idempotente.
set local lock_timeout = '5s';
drop function if exists comunicacao_cota_categoria_disponivel(text, uuid, uuid, uuid, timestamptz);
alter table if exists comunicacao_categorias drop constraint if exists comunicacao_categorias_d1_sem_cota_propria;
alter table if exists comunicacao_categorias drop constraint if exists comunicacao_categorias_cota_valida;
drop function if exists comunicacao_cota_valida(jsonb);
alter table if exists comunicacao_categorias drop column if exists cota;


-- ===== 134_rollback.sql =====
-- Rollback da 134 — remove convites, desafios, livro-razão de consentimento e termos.
-- ATENÇÃO: o livro-razão é PROVA de consentimento/revogação — exportar antes. As revogações já aplicadas (categorias desligadas,
-- opt-out) PERMANECEM: o rollback não reativa nada. Idempotente.
set local lock_timeout = '5s';
drop trigger if exists trg_comunicacao_dest_cat_revogada on comunicacao_destinatario_categorias;
drop trigger if exists trg_comunicacao_escopo_revogada on comunicacao_destinatario_escopos;
drop function if exists comunicacao_revogar(text, uuid[], text[], uuid, text, uuid, uuid, boolean, text);
drop function if exists comunicacao_titular_consentir(uuid, uuid, text[], integer, text, text, text);
drop function if exists comunicacao_desafio_verificar(uuid, text);
drop function if exists comunicacao_desafio_criar(text, uuid, text, text, text, text, boolean, integer, uuid);
drop function if exists comunicacao_desafio_criar(text, uuid, text, text, text, text, boolean, integer);   -- versão anterior da 134 (não publicada)
drop function if exists comunicacao_bloquear_reativacao_revogada();
drop function if exists comunicacao_consentimento_vigente(uuid, text);
alter table if exists comunicacao_destinatario_escopos drop column if exists verificacao_simulada;
drop table if exists comunicacao_consentimentos;
drop table if exists comunicacao_desafios_titular;
drop table if exists comunicacao_convites;
drop function if exists comunicacao_convites_coerencia();
drop table if exists comunicacao_termos;


-- ===== 133_rollback.sql =====
-- Rollback da 133 — restaura EXATAMENTE o agendamento do D-1 da 104 e remove escopo, snapshot, ativação M3 e as categorias novas.
-- ATENÇÃO: apaga escopos e o snapshot (se a M3 tiver sido ativada, exportar antes — o snapshot é a prova da migração).
-- Desliga a seleção por escopo (remove a chave). Idempotente.
set local lock_timeout = '5s';

create or replace function comunicacao_agendar_mensagens_alerta(
  p_alerta_id uuid, p_proposito text, p_origem text, p_itens jsonb, p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; h comunicacao_habilitacoes; m comunicacao_mensagens; ex comunicacao_mensagens; ini comunicacao_mensagens;
  it jsonb; r jsonb; v_dest jsonb; v_org_nome text; v_ce uuid; v_chave text; v_criadas integer := 0; v_itens jsonb := '[]'::jsonb;
  v_meta jsonb; v_contato uuid; v_reparar boolean := false;
begin
  if p_proposito is null or p_proposito not in ('inicial', 'reforco') then return jsonb_build_object('acao', 'PROPOSITO_INVALIDO'); end if;
  if p_origem is not null and (p_origem <> 'prazo_final_d1' or p_proposito <> 'inicial') then return jsonb_build_object('acao', 'ORIGEM_INVALIDA'); end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 50 then
    return jsonb_build_object('acao', 'ITENS_INVALIDOS');
  end if;

  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;
  if p_origem = 'prazo_final_d1' and a.tipo_alerta <> 'dashboard_ifood_d1' then return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO'); end if;

  -- EMPRESA (fail-closed): habilitada E com envio automático ligado
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then return jsonb_build_object('acao', 'NAO_HABILITADA'); end if;
  if h.envio_automatico is not true then return jsonb_build_object('acao', 'ENVIO_AUTOMATICO_DESLIGADO'); end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO'); end if;

  if p_proposito = 'inicial' and a.status <> 'DETECTED' then return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status); end if;
  if p_proposito = 'reforco' and a.status not in ('SCHEDULED', 'SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'ALERTA_SEM_PRIMEIRO_ENVIO', 'status_alerta', a.status);
  end if;

  v_dest := comunicacao_resolver_destinatarios(a.organizacao_id, a.tipo_alerta);
  select nome into v_org_nome from organizacoes where id = a.organizacao_id;
  v_meta := case when p_proposito = 'reforco' then jsonb_build_object('proposito', 'reforco')
                 when p_origem is not null then jsonb_build_object('proposito', 'inicial', 'origem', p_origem)
                 else '{}'::jsonb end;

  for it in select value from jsonb_array_elements(p_itens) loop
    if it->>'contato_empresa_id' is null or it->>'contato_empresa_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(it->>'conteudo', '') = '' or it->>'disponivel_em' is null then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('acao', 'ITEM_INVALIDO')); continue;
    end if;
    v_ce := (it->>'contato_empresa_id')::uuid;
    select e into r from jsonb_array_elements(v_dest) e where (e->>'contato_empresa_id')::uuid = v_ce limit 1;
    if r is null then v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'DESTINATARIO_INEXISTENTE')); continue; end if;
    if (r->>'elegivel')::boolean is not true then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'DESTINATARIO_INELEGIVEL', 'motivo', r->>'motivo')); continue;
    end if;
    v_contato := (r->>'contato_id')::uuid;

    -- já existe uma mensagem DESTE destinatário para ESTE propósito? (inclui as legadas, pré-100, sem contato_empresa_id, casadas pelo contato)
    select * into ex from comunicacao_mensagens x
     where x.alerta_id = a.id and x.direcao = 'saida' and coalesce(x.metadados->>'proposito', 'inicial') = p_proposito
       and (x.contato_empresa_id = v_ce or (x.contato_empresa_id is null and x.contato_id = v_contato))
     order by x.created_at limit 1;
    if found then
      -- REPARO: mensagem inicial já viva (resíduo de fluxo não atômico) com o alerta ainda DETECTED -> o alerta acompanha (sem duplicar nada)
      if p_proposito = 'inicial' and ex.status in ('SCHEDULED', 'PROCESSING', 'SENDING') then v_reparar := true; end if;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'mensagem_id', ex.id, 'status', ex.status,
        'acao', case when ex.status = 'CANCELLED' and ex.erro = 'EXPIRADA' then 'MENSAGEM_EXPIRADA' else 'JA_EXISTIA' end));
      continue;
    end if;

    if p_proposito = 'reforco' then
      -- o reforço deste destinatário exige a inicial DELE já enviada e nenhuma entrega dele em curso/incerta
      select * into ini from comunicacao_mensagens x
       where x.alerta_id = a.id and x.direcao = 'saida' and coalesce(x.metadados->>'proposito', 'inicial') = 'inicial'
         and (x.contato_empresa_id = v_ce or (x.contato_empresa_id is null and x.contato_id = v_contato))
       order by x.created_at limit 1;
      if not found or ini.status not in ('SENT', 'DELIVERED', 'READ') then
        v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'PRIMEIRA_MENSAGEM_NAO_ENVIADA')); continue;
      end if;
    end if;

    v_chave := 'wa:alerta:' || a.id::text || ':dest:' || v_ce::text || case when p_proposito = 'reforco' then ':reforco:v1' else ':v1' end;
    begin
      insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                         contato_empresa_id, empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia,
                                         tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
      values (a.id, a.organizacao_id, a.unidade_id, v_contato, (r->>'perfil_id')::uuid,
              v_ce, v_org_nome, r->>'nome', r->>'telefone', a.data_referencia,
              a.tipo_alerta, it->>'conteudo', v_chave, 'SCHEDULED', (it->>'disponivel_em')::timestamptz, nullif(it->>'expira_em', '')::timestamptz,
              coalesce(p_max_tentativas, 5), v_meta)
      returning * into m;
      v_criadas := v_criadas + 1;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'CRIADA', 'mensagem_id', m.id));
    exception when unique_violation then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'JA_EXISTIA'));
    end;
  end loop;

  if p_proposito = 'inicial' and (v_criadas > 0 or v_reparar) and a.status = 'DETECTED' then
    update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  end if;
  return jsonb_build_object('acao', 'OK', 'criadas', v_criadas, 'itens', v_itens);
end;
$$;
comment on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) is
  'Cria, NUMA transação, uma mensagem por destinatário ELEGÍVEL (revalidado aqui) de um alerta. Idempotência por alerta+destinatário+propósito (índice único parcial + chave derivada no banco). proposito = inicial|reforco; origem = NULL|prazo_final_d1 (1ª mensagem tardia). Recusas do conjunto: PROPOSITO_INVALIDO, ORIGEM_INVALIDA, ITENS_INVALIDOS, ALERTA_INEXISTENTE, TIPO_NAO_SUPORTADO, NAO_HABILITADA, ENVIO_AUTOMATICO_DESLIGADO, TIPO_NAO_PERMITIDO, ALERTA_NAO_DETECTED, ALERTA_SEM_PRIMEIRO_ENVIO. Por item: CRIADA | JA_EXISTIA | MENSAGEM_EXPIRADA | DESTINATARIO_INELEGIVEL | DESTINATARIO_INEXISTENTE | PRIMEIRA_MENSAGEM_NAO_ENVIADA | ITEM_INVALIDO.';
revoke all on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) to service_role;

delete from comunicacao_configuracoes where chave = 'selecao_por_escopo';
drop function if exists comunicacao_legado_vincular_unidade(uuid, uuid, uuid, uuid, uuid);
drop function if exists comunicacao_escopo_preferencias(uuid, uuid, uuid, uuid, text, boolean, jsonb, jsonb, boolean, uuid);
drop function if exists comunicacao_escopo_suspender(uuid, uuid, uuid, uuid, text, boolean, text, uuid);
drop function if exists comunicacao_escopo_gestor_permitido(uuid, uuid, uuid, uuid);
drop function if exists comunicacao_desativar_selecao_por_escopo(uuid);
drop function if exists comunicacao_ativar_selecao_por_escopo(uuid, jsonb, text, uuid);
drop function if exists comunicacao_resolver_destinatarios_unidade(uuid, uuid, text);
drop function if exists comunicacao_selecao_por_escopo_ligada();
drop function if exists comunicacao_resolver_destinatarios_por_escopo(uuid, uuid, text);
drop table if exists comunicacao_destinatario_escopos;
drop function if exists comunicacao_escopos_coerencia();
drop function if exists comunicacao_faixa_horaria_valida(jsonb);
drop table if exists comunicacao_legado_snapshot;
drop function if exists comunicacao_registro_imutavel();

delete from comunicacao_categorias c
 where c.codigo in ('fechamento_operacional_diario', 'resumo_semanal', 'cancelamentos_relevantes', 'atrasos_operacionais', 'disputas',
                    'falha_integracao', 'financeiro_divergencias', 'gestao_metas')
   and not exists (select 1 from comunicacao_destinatario_categorias dc where dc.categoria = c.codigo);
alter table comunicacao_categorias drop column if exists ordem;
alter table comunicacao_categorias drop column if exists prioridade;
alter table comunicacao_categorias drop column if exists transporte;
alter table comunicacao_categorias drop column if exists estado;
alter table comunicacao_categorias drop column if exists exige_consentimento;
alter table comunicacao_categorias drop column if exists grupo;



-- ===== 132_rollback.sql =====
-- Rollback da 132 — remove o convite de usuário e as colunas de fuso/horário da unidade.
-- ATENÇÃO: apaga convites pendentes e o fuso/horário configurados nas unidades (exportar antes, se houver). Idempotente.
set local lock_timeout = '5s';
drop function if exists usuarios_convite_consumir(text, text, uuid);
drop table if exists usuarios_convites;
drop function if exists usuarios_convites_coerencia();
drop trigger if exists trg_unidades_validar_fuso_horario on unidades;
drop function if exists unidades_validar_fuso_horario();
alter table unidades drop column if exists horario_funcionamento;
alter table unidades drop column if exists timezone;

commit;
