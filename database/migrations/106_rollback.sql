-- ROLLBACK da migration 106. NÃO aplicar sem autorização.
-- A tabela só guarda requestIds temporários (validade de 24h no iFood) — sem
-- dado financeiro. Remover não afeta nenhuma outra tabela; o backend volta a
-- usar o registro em memória (ifoodFinancial.solicitacoes.js).
drop trigger if exists trg_ifood_fin_recon_od_upd on ifood_financial_reconciliacoes_on_demand;
drop table if exists ifood_financial_reconciliacoes_on_demand;
