-- =====================================================================
-- MIGRATION 058 — Configuração operacional por unidade (unidade_config)
-- =====================================================================
-- OBJETIVO
--   Persistência REAL, por unidade, do card Configurações -> "Metas e
--   Limites de CMV". Até aqui essa tela era um formulário decorativo: os
--   valores eram lidos de uma constante global (`CMV_LIMITES` no frontend)
--   e "salvar" só gravava em localStorage — nada chegava ao banco.
--
--   Campos (todos da UNIDADE, uma linha por loja):
--     - cmv_saudavel      : teto do CMV "saudável" (%)
--     - cmv_atencao       : teto do CMV "atenção" (%); acima disso = crítico
--     - meta_fat_dia      : meta de faturamento diário (R$)
--     - meta_fat_mes      : meta de faturamento mensal (R$)
--     - margem_minima     : margem mínima desejada (%)
--
--   REGRA DE LEITURA (backend — unidade.service.js#obterMetasCmv):
--     * sem linha para a unidade  -> devolve os DEFAULTS OFICIAIS do sistema
--       (cmv_saudavel=32, cmv_atencao=40; metas/margem = null).
--     * com linha                 -> devolve os valores persistidos DAQUELA
--       unidade.
--   A escrita (upsert) cria a linha da unidade na primeira vez que se salva.
--
--   ISOLAMENTO: `unidade_id` é PK e FK -> uma unidade só consegue ler/gravar
--   a própria linha; o backend filtra SEMPRE por `req.tenant.unidadeId`
--   (Context Token), nunca por id vindo do frontend.
--
--   ESCOPO DELIBERADAMENTE FORA DESTA MIGRATION:
--     ATUALIZAÇÃO (Fase C.1): os consumidores de CMV no frontend JÁ passaram
--     a respeitar a config da unidade — statusCmv() lê frontend/src/cmvConfig.js,
--     carregado 1x ao entrar/trocar de unidade (app.js#mostrarApp) e resetado
--     na troca de contexto. O default 32/40 (frontend/src/config.js#CMV_LIMITES)
--     é só o fallback quando não há linha aqui.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE / REVERSÍVEL.
--   - Tabela nova e vazia. Ausência de linha = usa default do sistema.
--   - Nenhuma alteração em tabela existente.
--
-- IMPACTO NOS DADOS ATUAIS: nenhum.
--
-- ROLLBACK:
--     drop table if exists unidade_config;
--   (perde apenas as metas configuradas por unidade; as faixas de CMV
--    voltam ao default do sistema, que é o comportamento atual.)
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção.
-- =====================================================================

create table if not exists unidade_config (
  unidade_id     uuid primary key references unidades(id) on delete cascade,
  cmv_saudavel   numeric(5,2) check (cmv_saudavel   is null or (cmv_saudavel   >= 0 and cmv_saudavel   <= 100)),
  cmv_atencao    numeric(5,2) check (cmv_atencao    is null or (cmv_atencao    >= 0 and cmv_atencao    <= 100)),
  meta_fat_dia   numeric(14,2) check (meta_fat_dia  is null or meta_fat_dia  >= 0),
  meta_fat_mes   numeric(14,2) check (meta_fat_mes  is null or meta_fat_mes  >= 0),
  margem_minima  numeric(5,2) check (margem_minima  is null or (margem_minima >= 0 and margem_minima <= 100)),
  updated_at     timestamptz not null default now(),
  atualizado_por uuid,          -- auth.users.id de quem salvou; sem FK (sobrevive à exclusão da conta)
  -- Coerência das faixas: "saudável" nunca pode ser maior que "atenção".
  constraint unidade_config_faixas_coerentes
    check (cmv_saudavel is null or cmv_atencao is null or cmv_saudavel <= cmv_atencao)
);

comment on table  unidade_config is 'Configuração operacional por unidade (Metas e Limites de CMV). Uma linha por loja; ausência de linha = defaults do sistema.';
comment on column unidade_config.cmv_saudavel  is 'Teto do CMV saudável (%). Default do sistema quando não há linha: 32.';
comment on column unidade_config.cmv_atencao   is 'Teto do CMV atenção (%); acima disso = crítico. Default do sistema quando não há linha: 40.';
comment on column unidade_config.meta_fat_dia  is 'Meta de faturamento diário (R$). Default quando não há linha: null.';
comment on column unidade_config.meta_fat_mes  is 'Meta de faturamento mensal (R$). Default quando não há linha: null.';
comment on column unidade_config.margem_minima is 'Margem mínima desejada (%). Default quando não há linha: null.';

-- updated_at automático (mesmo helper das demais tabelas — ver schema.sql#0)
drop trigger if exists trg_unidade_config_updated_at on unidade_config;
create trigger trg_unidade_config_updated_at
  before update on unidade_config
  for each row execute function set_updated_at();
