-- =====================================================================================================================
-- Financeiro v2 — migração 0015: ÍNDICES DA CARGA DIRIGIDA POR COMPETÊNCIA (Execução 08C)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Cada índice corresponde a uma consulta de aplicacao/cargaDaCompetencia.js (Vendas, Recebimentos, Central, Pendências,
-- Fechamento): sementes por competência/período e o fecho dos vínculos por chave estrangeira. Sem mudança de dados,
-- regras ou permissões. Todos começam por organização + unidade (o escopo de toda consulta).
-- =====================================================================================================================

-- Sementes por competência / período.
create index if not exists fv2_venda_competencia on fv2_venda (organizacao_id, unidade_id, competencia);
create index if not exists fv2_recebivel_competencia on fv2_recebivel (organizacao_id, unidade_id, competencia);
create index if not exists fv2_obrigacao_competencia on fv2_obrigacao (organizacao_id, unidade_id, competencia);
create index if not exists fv2_ajuste_competencia on fv2_ajuste (organizacao_id, unidade_id, competencia);
create index if not exists fv2_liquidacao_data on fv2_liquidacao (organizacao_id, unidade_id, data_efetiva);
create index if not exists fv2_estorno_data on fv2_estorno (organizacao_id, unidade_id, data_efetiva);
create index if not exists fv2_registro_fonte_competencia on fv2_registro_fonte (organizacao_id, unidade_id, competencia, tipo_registro);

-- Fecho dos vínculos (ida e volta).
create index if not exists fv2_pagamento_venda_venda on fv2_pagamento_venda (organizacao_id, unidade_id, venda_id);
create index if not exists fv2_recebivel_venda on fv2_recebivel (organizacao_id, unidade_id, venda_id);
create index if not exists fv2_obrigacao_grupo on fv2_obrigacao (organizacao_id, unidade_id, grupo_id);
create index if not exists fv2_movimentacao_pagamento on fv2_movimentacao (organizacao_id, unidade_id, pagamento_id);
create index if not exists fv2_estorno_alvo on fv2_estorno (organizacao_id, unidade_id, alvo_id);
create index if not exists fv2_vinculo_documental_registro on fv2_vinculo_documental (organizacao_id, unidade_id, registro_id);
-- Lançamento → origem (venda, recebível, ajuste, obrigação, proposta, estorno): subcampos do JSON `origem`.
create index if not exists fv2_lancamento_origem_id on fv2_lancamento (organizacao_id, unidade_id, (origem->>'id'));
create index if not exists fv2_lancamento_origem_venda on fv2_lancamento (organizacao_id, unidade_id, (origem->>'vendaId'));
