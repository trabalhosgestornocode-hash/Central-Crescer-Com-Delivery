-- =====================================================================================================================
-- Financeiro v2 — migração 0019: "FECHAMENTO COM PENDÊNCIAS DOCUMENTADAS" SEM CONTORNO — Execução 08E (achado da jornada)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- A jornada no navegador mostrou que a passagem PRELIMINAR → COM_PENDENCIAS aceitava pendências não documentadas e
-- bloqueantes (a homologação continuava barrada, mas o estado afirmava algo falso). Regra (espelho do núcleo,
-- dominio/ressalvas.js → podeRegistrarComPendencias): o estado só vale quando o que resta são ressalvas admissíveis.
-- O banco confere o que consegue conferir sozinho:
--   * a competência não nasce nesse estado;
--   * ao ENTRAR nele, há ao menos uma pendência documentada e cada uma tem decisão e "o que falta" ou evidência;
--   * as mesmas verificações OBJETIVAS da homologação (0018): nenhum lançamento ativo em categoria provisória e nenhuma
--     saída do período sem vínculo — essas nunca viram ressalva.
-- A classificação de admissibilidade de cada pendência (natureza × impacto) continua no núcleo; o banco barra a
-- homologação com ressalva inadmissível (0018).
-- =====================================================================================================================

create or replace function fv2_com_pendencias_documentadas() returns trigger language plpgsql as $$
declare
  doc jsonb;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.estado <> 'FECHAMENTO_COM_PENDENCIAS' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: competência não nasce com pendências documentadas — passe pelo fechamento preliminar.' using errcode = 'FV040';
  end if;
  if old.estado = 'FECHAMENTO_COM_PENDENCIAS' then
    return new; -- documentar/atualizar pendências dentro do estado continua permitido
  end if;
  if jsonb_typeof(new.pendencias) <> 'array' or jsonb_array_length(new.pendencias) = 0 then
    raise exception 'Financeiro v2: fechamento com pendências exige ao menos uma pendência documentada.' using errcode = 'FV040';
  end if;
  for doc in select * from jsonb_array_elements(new.pendencias) loop
    if length(btrim(coalesce(doc->>'decisao', ''))) = 0
       or (length(btrim(coalesce(doc->>'documentacaoFaltante', ''))) = 0 and jsonb_array_length(coalesce(doc->'evidenciaDocumentoIds', '[]'::jsonb)) = 0) then
      raise exception 'Financeiro v2: pendência sem documentação suficiente (decisão e o que falta ou evidência): %', coalesce(doc->>'chave', doc->>'descricao') using errcode = 'FV040';
    end if;
  end loop;
  if exists (select 1 from fv2_lancamento l where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id
              and l.competencia = new.competencia and l.situacao = 'ATIVO' and l.categoria_codigo in ('DESPESAS_A_CLASSIFICAR', 'DESCONTOS_A_CLASSIFICAR')) then
    raise exception 'Financeiro v2: há lançamento da competência em categoria provisória ("a classificar"): resolva antes do fechamento com pendências.' using errcode = 'FV040';
  end if;
  if exists (select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id
              and to_char(m.data_efetiva, 'YYYY-MM') = new.competencia and m.sentido = 'SAIDA' and m.situacao = 'VALIDA'
              and m.alocado_centavos < m.valor_centavos and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null) then
    raise exception 'Financeiro v2: há saída bancária do período sem vínculo: resolva antes do fechamento com pendências.' using errcode = 'FV040';
  end if;
  return new;
end $$;
create trigger fv2_competencia_com_pendencias before insert or update on fv2_competencia for each row execute function fv2_com_pendencias_documentadas();
