-- =====================================================================================================================
-- Financeiro v2 — migração 0020: BAIXA POR EXTRATO COM SAÍDA ANTERIOR À EMISSÃO (pagamento antecipado) — Execução 09
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Espelho de aplicacao/baixaPorExtrato.js: sem bloqueio absoluto por data, mas a liquidação de VÍNCULO DE EXTRATO cuja
-- saída é anterior à emissão da conta só é gravada se vier marcada como pagamento antecipado (extras.antecipacao, com
-- os dias de antecedência coerentes com as datas reais) e com DOCUMENTO de tipo compatível (comprovante, contrato, nota
-- fiscal ou boleto). Conciliação confirmada sozinha não basta aqui. Vale para qualquer gravador (não só "só vincula").
-- =====================================================================================================================

create or replace function fv2_baixa_antecipada() returns trigger language plpgsql as $$
declare
  data_saida date;
  emissao date;
  ant jsonb;
  tipo_doc text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    return new;
  end if;
  select m.data_efetiva into data_saida from fv2_movimentacao m
   where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id and m.id = new.movimentacao_id;
  select o.data_emissao into emissao from fv2_obrigacao o
   where o.organizacao_id = new.organizacao_id and o.unidade_id = new.unidade_id and o.id = new.alvo_id;
  ant := new.extras->'antecipacao';
  if data_saida is null or emissao is null or data_saida >= emissao then
    if ant is not null and jsonb_typeof(ant) <> 'null' then
      raise exception 'Financeiro v2: a saída não é anterior à emissão — não pode ser marcada como pagamento antecipado.' using errcode = 'FV041';
    end if;
    return new;
  end if;
  if ant is null or jsonb_typeof(ant) <> 'object' or (ant->>'dias')::int is distinct from (emissao - data_saida)
     or ant->>'dataSaida' is distinct from data_saida::text or ant->>'dataEmissao' is distinct from emissao::text then
    raise exception 'Financeiro v2: saída anterior à emissão da conta exige identificação explícita de pagamento antecipado.' using errcode = 'FV041';
  end if;
  select d.tipo into tipo_doc from fv2_documento d
   where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
  if tipo_doc is null or tipo_doc not in ('COMPROVANTE', 'CONTRATO', 'NOTA_FISCAL', 'BOLETO') then
    raise exception 'Financeiro v2: pagamento antecipado exige documento compatível (comprovante, contrato, nota fiscal ou boleto).' using errcode = 'FV041';
  end if;
  return new;
end $$;
create trigger fv2_liquidacao_baixa_antecipada before insert on fv2_liquidacao for each row execute function fv2_baixa_antecipada();
