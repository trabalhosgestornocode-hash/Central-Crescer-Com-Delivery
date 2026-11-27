-- =====================================================================================================================
-- Financeiro v2 — migração 0035: EMPRÉSTIMOS E FINANCIAMENTOS (principal) com ação ESTREITA — MOVA (27/11/2026)
-- =====================================================================================================================
-- Ação nova `financeiro_v2.registrar_emprestimo` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe). Ela NÃO grava nada
-- sozinha: é um COMPLEMENTO das ações estreitas que já existem e só amplia a CATEGORIA aceita por elas:
--   * `registrar_conta_parcelada` (0033): conta de empréstimo AINDA A PAGAR, em 1 a 24 parcelas, em aberto;
--   * `registrar_obrigacao` + `baixar_por_comprovante` (0030/0029): pagamento de empréstimo COMPROVADAMENTE realizado (conta e
--     pagamento por comprovante na mesma transação, quitada);
--   * a baixa de conta de empréstimo EXISTENTE por comprovante já é da `baixar_por_comprovante` (nenhuma regra de categoria).
-- A ampliação é UMA categoria: lançamento PATRIMONIAL `EMPRESTIMOS_E_FINANCIAMENTOS` ("Empréstimos e financiamentos (principal)",
-- fora da DRE). Distribuição de lucros, aportes/retiradas de sócios, operações entre empresas, valores de terceiros, títulos
-- anteriores, parcelamento tributário e qualquer outra patrimonial continuam RECUSADOS para as ações estreitas. Nenhuma política
-- de inclusão/alteração (RLS) é ampliada: sem a ação estreita de base, `registrar_emprestimo` não grava nada. Nada de
-- transferência, movimentação bancária, receita ou juros (encargo segue só pela 0031, na categoria oficial de juros e multas).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao",
  "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany",
  "financeiro_v2.registrar_emprestimo"]'::jsonb);

-- 2) Principal de empréstimo aceito pela forma estreita SÓ para quem tem a ação nova (e só nesta categoria).
create or replace function fv2_principal_de_emprestimo(natureza text, categoria text) returns boolean language sql stable as $$
  select natureza = 'PATRIMONIAL' and categoria = 'EMPRESTIMOS_E_FINANCIAMENTOS' and fv2_tem_acao(array['financeiro_v2.registrar_emprestimo'])
$$;

-- 3) A função das contas a pagar estreitas (0030/0033) com UMA cláusula a mais em cada forma; todo o resto é idêntico à 0033.
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  documental boolean := fv2_so_registra_obrigacao();
  parcelada boolean := fv2_so_registra_conta_parcelada();
begin
  if not documental and not parcelada then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    -- 27/11: PRESERVA a exceção da 0031 (encargo do pagamento por quem tem registrar_juros; forma conferida por
    -- fv2_juros_documental). A primeira versão desta migração a perdia e recusava toda despesa paga com juros/multa.
    if documental and new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new;
    end if;
    if new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: só se registra lançamento ativo nascido de conta a pagar.' using errcode = '42501';
    end if;
    if new.natureza = 'DESPESA' or (parcelada and new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO')
       or fv2_principal_de_emprestimo(new.natureza, new.categoria_codigo) then
      return new;
    end if;
    raise exception 'Financeiro v2: conta a pagar estreita só em categoria de DESPESA (ou compra de equipamentos, na relatada, ou principal de empréstimo com registrar_emprestimo).' using errcode = '42501';
  end if;
  -- fv2_obrigacao
  if new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar estreita nasce em aberto, sem repetição.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text then
    raise exception 'Financeiro v2: a conta a pagar estreita aponta para o lançamento criado com ela (mesma transação).' using errcode = '42501';
  end if;
  -- forma da 0030: uma parcela, valor igual ao do lançamento, natureza DESPESA (0035: ou principal de empréstimo com a ação nova)
  if documental and (new.parcela->>'total')::int = 1 and l.valor_centavos = new.valor_base_centavos
     and (l.natureza = 'DESPESA' or fv2_principal_de_emprestimo(l.natureza, l.categoria_codigo)) then
    return new;
  end if;
  -- forma da 0033: 1 a 24 parcelas do MESMO lançamento (a soma é conferida no fim da transação)
  if parcelada and (new.parcela->>'total')::int between 1 and 24 and (new.parcela->>'numero')::int between 1 and (new.parcela->>'total')::int
     and new.valor_base_centavos > 0 and new.valor_base_centavos <= l.valor_centavos and cardinality(new.documento_ids) = 0 then
    return new;
  end if;
  raise exception 'Financeiro v2: forma de conta a pagar não permitida para esta permissão estreita.' using errcode = '42501';
end $$;
