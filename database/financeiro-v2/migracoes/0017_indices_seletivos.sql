-- =====================================================================================================================
-- Financeiro v2 — migração 0017: ÍNDICES COM A COLUNA SELETIVA PRIMEIRO (Execução 08D)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Achado da 08C: sem estatísticas (banco recém-carregado, antes do autovacuum/ANALYZE), o planejador usava só o prefixo
-- organização+unidade dos índices da 0015 e filtrava a unidade inteira ("Rows Removed by Filter"). Organização e unidade
-- quase não distinguem linhas (uma empresa tem poucas unidades); a competência, a data e as chaves do fecho distinguem.
-- Com a coluna seletiva na FRENTE, a condição `= any(...)`/faixa vira condição do índice com ou sem estatísticas.
-- Organização e unidade continuam no índice (e no RLS); nenhuma regra de segurança muda. ANALYZE continua recomendado.
-- =====================================================================================================================

drop index if exists fv2_venda_competencia;
drop index if exists fv2_recebivel_competencia;
drop index if exists fv2_obrigacao_competencia;
drop index if exists fv2_ajuste_competencia;
drop index if exists fv2_liquidacao_data;
drop index if exists fv2_estorno_data;
drop index if exists fv2_registro_fonte_competencia;
drop index if exists fv2_pagamento_venda_venda;
drop index if exists fv2_recebivel_venda;
drop index if exists fv2_obrigacao_grupo;
drop index if exists fv2_movimentacao_pagamento;
drop index if exists fv2_estorno_alvo;
drop index if exists fv2_vinculo_documental_registro;
drop index if exists fv2_lancamento_origem_id;
drop index if exists fv2_lancamento_origem_venda;

-- Sementes por competência / período.
create index fv2_venda_competencia_sel on fv2_venda (competencia, organizacao_id, unidade_id);
create index fv2_lancamento_competencia_sel on fv2_lancamento (competencia, organizacao_id, unidade_id);
create index fv2_recebivel_competencia_sel on fv2_recebivel (competencia, organizacao_id, unidade_id);
create index fv2_obrigacao_competencia_sel on fv2_obrigacao (competencia, organizacao_id, unidade_id);
create index fv2_ajuste_competencia_sel on fv2_ajuste (competencia, organizacao_id, unidade_id);
create index fv2_proposta_competencia_sel on fv2_proposta (competencia, organizacao_id, unidade_id);
create index fv2_movimentacao_data_sel on fv2_movimentacao (data_efetiva, organizacao_id, unidade_id);
create index fv2_liquidacao_data_sel on fv2_liquidacao (data_efetiva, organizacao_id, unidade_id);
create index fv2_estorno_data_sel on fv2_estorno (data_efetiva, organizacao_id, unidade_id);
create index fv2_registro_fonte_competencia_sel on fv2_registro_fonte (competencia, tipo_registro, organizacao_id, unidade_id);
create index fv2_correspondencia_competencia_sel on fv2_correspondencia ((extras->>'competencia'), organizacao_id, unidade_id);
create index fv2_correspondencia_conciliacao_sel on fv2_correspondencia ((extras->>'competenciaDaConciliacao'), organizacao_id, unidade_id);

-- Fecho dos vínculos.
create index fv2_pagamento_venda_venda_sel on fv2_pagamento_venda (venda_id, organizacao_id, unidade_id);
create index fv2_recebivel_venda_sel on fv2_recebivel (venda_id, organizacao_id, unidade_id);
create index fv2_obrigacao_grupo_sel on fv2_obrigacao (grupo_id, organizacao_id, unidade_id);
create index fv2_movimentacao_pagamento_sel on fv2_movimentacao (pagamento_id, organizacao_id, unidade_id);
create index fv2_liquidacao_alvo_sel on fv2_liquidacao (alvo_id, organizacao_id, unidade_id);
create index fv2_liquidacao_movimentacao_sel on fv2_liquidacao (movimentacao_id, organizacao_id, unidade_id);
create index fv2_ajuste_alvo_sel on fv2_ajuste (alvo_id, organizacao_id, unidade_id);
create index fv2_estorno_alvo_sel on fv2_estorno (alvo_id, organizacao_id, unidade_id);
create index fv2_vinculo_documental_registro_sel on fv2_vinculo_documental (registro_id, organizacao_id, unidade_id);
create index fv2_lancamento_origem_id_sel on fv2_lancamento ((origem->>'id'), organizacao_id, unidade_id);
create index fv2_lancamento_origem_venda_sel on fv2_lancamento ((origem->>'vendaId'), organizacao_id, unidade_id);
