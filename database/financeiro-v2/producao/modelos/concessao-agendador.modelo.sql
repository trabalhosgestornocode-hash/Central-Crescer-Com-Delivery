-- Financeiro v2 — concessão técnica do fechamento semanal de entregadores na Subway Saci — Matriz.
-- Autorização do proprietário em 27/11/2026. Executar como postgres (autoridade de infraestrutura), numa ÚNICA transação.
-- Mesmo formato da concessão que a mesma identidade já tem no Açaí no Grau Saci (executor sintético ...0b0075).
-- Só financeiro_v2.ver e financeiro_v2.registrar. Idempotente: se já existir, não faz nada. Não altera a concessão do Açaí.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$
declare
  v_org uuid := '@ORG@';
  v_uni uuid := '@UNI@';
  v_usr uuid := '@USR@';
  v_exec uuid := '@EXEC@';
  v_acoes jsonb := '["financeiro_v2.registrar","financeiro_v2.ver"]'::jsonb;
  v_just text := 'Identidade técnica exclusiva do fechamento semanal de entregadores próprios na Subway Saci — Matriz (autorização do proprietário em 27/11/2026); só ver e registrar.';
  v_id uuid := gen_random_uuid(); v_agora timestamptz := clock_timestamp();
begin
  if session_user <> 'postgres' then raise exception 'só o papel postgres executa — nada foi feito'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fv2|' || v_org || '|' || v_uni || '|concessoes', 0));
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = v_org and e.unidade_id = v_uni) then raise exception 'unidade fora dos escopos do financeiro'; end if;
  if exists (select 1 from fv2_concessao c where c.organizacao_id = v_org and c.unidade_id = v_uni and c.usuario_id = v_usr) then
    raise notice 'concessão já existe — nada a fazer'; return;
  end if;
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  values (v_id, v_org, v_uni, 1, v_agora, v_exec, v_agora, v_exec, 'concessao:' || v_usr, null, '{}'::jsonb, v_usr, v_acoes, 'ATIVA', v_exec, v_just);
  insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
  values (gen_random_uuid(), v_org, v_uni, 'CONCESSAO', v_id, 'CRIACAO', null,
          jsonb_build_object('id', v_id, 'organizacaoId', v_org, 'unidadeId', v_uni, 'versao', 1, 'criadoEm', v_agora, 'criadoPor', v_exec, 'atualizadoEm', v_agora, 'atualizadoPor', v_exec,
                             'chaveIdempotencia', 'concessao:' || v_usr, 'impressao', null, 'usuarioId', v_usr, 'acoes', v_acoes, 'situacao', 'ATIVA', 'concedidoPor', v_exec, 'justificativa', v_just),
          v_just, v_exec, v_agora);
  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao, acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (v_org, v_uni, v_id, v_usr, v_exec, null, 'INFRAESTRUTURA_AUTORIZADA_PELO_PROPRIETARIO', 'CONCESSAO', '[]'::jsonb, v_acoes, 'ATIVA', v_just);
end $$;
-- Conferência (deve listar Açaí e Subway, ambas ATIVA, 2 ações):
select unidade_id, acoes, situacao from fv2_concessao where usuario_id = '@USR@' order by unidade_id;
commit;
