-- =====================================================================================================================
-- Financeiro v2 — migração 0005: composição econômica da venda (Execução 03B)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
-- Compatível com as vendas existentes: descontos_centavos nasce 0 e composicao nasce nula (venda sem composição).
--   * descontos_centavos — descontos com efeito PRÓPRIO (da loja ou com financiador não comprovado), lançados como dedução;
--     subsídio de terceiro NÃO entra aqui: é pagamento do terceiro (recebível dele);
--   * composicao        — itens, acréscimos, serviços e descontos com financiador, como vieram da fonte.
-- Regras no banco: descontos não negativos; pago + devolvido + descontos próprios nunca superam a receita; a receita da
-- venda continua ÚNICA e do valor bruto próprio (fv2_conferir_venda inalterada: só conta lançamentos de RECEITA).
-- =====================================================================================================================

alter table fv2_venda add column descontos_centavos bigint not null default 0 check (descontos_centavos >= 0);
alter table fv2_venda add column composicao jsonb check (composicao is null or jsonb_typeof(composicao) = 'object');
alter table fv2_venda add constraint fv2_venda_composicao_fecha check (pago_centavos + devolvido_centavos + descontos_centavos <= bruto_centavos);
