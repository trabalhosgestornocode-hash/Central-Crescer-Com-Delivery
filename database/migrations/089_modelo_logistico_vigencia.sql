-- =====================================================================
-- MIGRATION 089 — Vigência (data de início) da troca de modelo logístico
-- =====================================================================
-- PROBLEMA
--   `unidades.modelo_logistico_ifood` (migration 024) guarda UM valor: o modelo
--   ATUAL da unidade (Marketplace ou Full Service). Todo cálculo do Dashboard
--   iFood lia esse valor "ao vivo", então uma troca — mesmo legítima, no meio
--   do mês — reinterpretava TODO o histórico pelo modelo novo: os dias de
--   Marketplace de 01–12/09 passavam a ser avaliados com metas, componentes e
--   Total de Deduções de Full Service.
--
-- SOLUÇÃO (reaproveita a tabela existente, sem estrutura paralela)
--   `unidade_modelo_logistico_historico` (024) já registra cada troca
--   (modelo_anterior -> modelo_novo, quem, quando FOI REGISTRADA em created_at).
--   Falta só a data em que a troca VALE: `vigencia_inicio`.
--
--   Cada linha com `vigencia_inicio` é um PONTO DE TROCA: "a partir desta data
--   a unidade opera em `modelo_novo`; antes dela operava em `modelo_anterior`".
--   Os períodos de vigência são DERIVADOS desses pontos ordenados:
--       período k = [ponto_k.vigencia_inicio, ponto_k+1.vigencia_inicio - 1 dia]
--   O fim de cada período NÃO é uma coluna — é sempre a véspera da troca
--   seguinte. Assim períodos sobrepostos ou com buraco são IMPOSSÍVEIS por
--   construção (não há `vigencia_fim` para ficar dessincronizado).
--
--   Regra de consulta (equivalente a "inicio <= data AND (fim IS NULL OR fim >= data)"):
--     modelo na data D = modelo_novo do último ponto com vigencia_inicio <= D;
--     sem nenhum ponto <= D  ->  modelo_anterior do PRIMEIRO ponto;
--     sem nenhum ponto       ->  unidades.modelo_logistico_ifood (comportamento
--                                anterior, inalterado).
--
-- BACKFILL: NENHUM (deliberado). Não existe, no banco, evidência de QUANDO cada
--   unidade passou a operar no modelo atual (`created_at` da linha de histórico
--   é a data do REGISTRO, não da vigência — e a própria troca em curso é
--   retroativa). Inventar datas reescreveria o passado. Sem ponto de troca datado
--   a unidade continua com um único modelo (o atual), exatamente como hoje.
--   Linhas antigas (vigencia_inicio NULL) permanecem só como auditoria.
--   Unidades que JÁ trocaram de modelo no passado precisam ter a data efetiva
--   informada manualmente (ver consulta de VERIFICAÇÃO no fim).
--
-- IDEMPOTENTE, ADITIVA, NÃO DESTRUTIVA. Nenhum dado existente é alterado.
-- PRÉ-REQUISITO: migration 024 aplicada.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- ROLLBACK: 089_rollback.sql (reverta o backend ANTES).
-- =====================================================================

alter table unidade_modelo_logistico_historico
  add column if not exists vigencia_inicio date;

comment on column unidade_modelo_logistico_historico.vigencia_inicio is
  'Data (inclusive) a partir da qual modelo_novo vale para a unidade. NULL = linha antiga/de auditoria, sem vigência conhecida (não define período).';

-- Uma única troca por unidade e data.
create unique index if not exists uq_umlh_unidade_vigencia
  on unidade_modelo_logistico_historico (unidade_id, vigencia_inicio)
  where vigencia_inicio is not null;

-- Um ponto de troca datado sempre troca DE UM modelo PARA OUTRO.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'umlh_vigencia_troca_real') then
    alter table unidade_modelo_logistico_historico
      add constraint umlh_vigencia_troca_real
      check (vigencia_inicio is null or (modelo_anterior is not null and modelo_anterior <> modelo_novo));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Guarda no banco (defesa em profundidade — o backend valida antes, mas o
-- banco não confia em quem escreve): a cadeia de pontos de troca de uma unidade
-- tem que ser estritamente crescente no tempo e encadeada (o `modelo_anterior`
-- de cada ponto é o `modelo_novo` do ponto anterior).
--   INSERT : só ao FIM da cadeia (depois da última troca) e encadeado;
--   UPDATE : um ponto datado é IMUTÁVEL (não se reordena nem se reescreve o passado);
--   DELETE : só o ponto MAIS RECENTE pode ser removido (é o que o backend faz para
--            desfazer uma troca cujo 2º passo falhou) — nunca um do meio da cadeia.
-- ---------------------------------------------------------------------
create or replace function umlh_valida_vigencia()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_ult record;
begin
  if tg_op = 'DELETE' then
    if old.vigencia_inicio is not null and exists (
      select 1 from unidade_modelo_logistico_historico
      where unidade_id = old.unidade_id and vigencia_inicio > old.vigencia_inicio
    ) then
      raise exception 'Só a troca de modelo mais recente pode ser removida.' using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.vigencia_inicio is not null then
    if new.unidade_id is distinct from old.unidade_id
       or new.vigencia_inicio is distinct from old.vigencia_inicio
       or new.modelo_anterior is distinct from old.modelo_anterior
       or new.modelo_novo is distinct from old.modelo_novo then
      raise exception 'Uma troca de modelo já registrada não pode ser alterada.' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.vigencia_inicio is null then
    return new;
  end if;

  select vigencia_inicio, modelo_novo into v_ult
  from unidade_modelo_logistico_historico
  where unidade_id = new.unidade_id
    and vigencia_inicio is not null
    and id is distinct from new.id
  order by vigencia_inicio desc
  limit 1;

  if found then
    if new.vigencia_inicio <= v_ult.vigencia_inicio then
      raise exception 'A vigência deve começar depois da última troca registrada (%).', v_ult.vigencia_inicio
        using errcode = '23514';
    end if;
    if new.modelo_anterior is distinct from v_ult.modelo_novo then
      raise exception 'O modelo anterior (%) não corresponde ao modelo vigente (%).', new.modelo_anterior, v_ult.modelo_novo
        using errcode = '23514';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_umlh_valida_vigencia on unidade_modelo_logistico_historico;
create trigger trg_umlh_valida_vigencia
  before insert or delete or update of unidade_id, vigencia_inicio, modelo_anterior, modelo_novo
  on unidade_modelo_logistico_historico
  for each row execute function umlh_valida_vigencia();

-- RLS: sem mudança. A policy rls_umlh_tenant (024) continua sendo a única
-- (SELECT por organização); escrita segue só pelo backend (service role).

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   -- 1) coluna e índice:
--   select column_name from information_schema.columns
--    where table_name = 'unidade_modelo_logistico_historico' and column_name = 'vigencia_inicio';
--   -- Esperado: 1 linha.
--
--   -- 2) unidades que JÁ tiveram troca real de modelo antes desta migration —
--   --    a data efetiva NÃO é conhecida; informar manualmente pelo Dashboard iFood
--   --    (a troca datada só vale para frente da última linha datada):
--   select unidade_id, count(*) as trocas, min(created_at) as primeira, max(created_at) as ultima
--     from unidade_modelo_logistico_historico
--    where modelo_anterior is distinct from modelo_novo and vigencia_inicio is null
--    group by unidade_id;
-- =====================================================================
-- FIM
-- =====================================================================
