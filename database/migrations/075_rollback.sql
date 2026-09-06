-- =====================================================================
-- ROLLBACK da MIGRATION 075 — volta ao estado equivalente à 074
-- =====================================================================
-- Reverte, em ordem inversa:
--   1. drop das 2 tabelas novas (_snapshot -> competencia) + função de imutabilidade
--   2. drop das colunas adicionadas pela 075 (seguras: criadas pela 075, sem
--      dado de produção — a 074 nunca foi usada)
--   3. FKs org/unidade -> de volta para ON DELETE CASCADE
--   4. renomeia índices/trigger/constraints de volta
--   5. renomeia colunas de volta
--   6. RENAME TABLE bonificacao_fechamento_mensal -> bonificacao_mix_mensal
--   7. RLS -> volta para o nome antigo da policy
--
-- Tudo com IF EXISTS -> reexecutável, e seguro mesmo se a 075 tiver
-- aplicado só parcialmente. NÃO destrói dado (as colunas dropadas são as
-- que a 075 criou). Roda em begin/commit.
--
-- COMO USAR: Supabase -> SQL Editor -> cole ESTE ARQUIVO INTEIRO e execute.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Funções do fluxo transacional da F4 (secção 6 da 075)
-- ---------------------------------------------------------------------
drop function if exists bonificacao_congelar_competencia(uuid, uuid, int, int, text, jsonb, jsonb, text, uuid, text);
drop function if exists bonificacao_reabrir_competencia(uuid, int, int, text, uuid, text);

-- ---------------------------------------------------------------------
-- 1. Tabelas novas + função de imutabilidade
-- ---------------------------------------------------------------------
drop trigger if exists trg_bcsnap_no_update on bonificacao_competencia_snapshot;
drop trigger if exists trg_bcsnap_no_delete on bonificacao_competencia_snapshot;
drop table   if exists bonificacao_competencia_snapshot;
drop function if exists bonificacao_snapshot_imutavel();
drop table   if exists bonificacao_competencia;

-- ---------------------------------------------------------------------
-- 2. Reverter a tabela de fechamento para o formato 074.
--    Só faz sentido se a 075 chegou a renomear a tabela.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'bonificacao_fechamento_mensal') then
    return; -- 075 não foi aplicada (ou já revertida) — nada a fazer
  end if;

  -- 2.1 constraints/colunas adicionadas pela 075
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_completo;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_produtos_total_itens_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_faturamento_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_ticket_medio_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_cupons_validos_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_cupons_vendas_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bfm_vendas_origem_check;
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_vendas_usuario_id_fkey;
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_produtos_usuario_id_fkey;

  alter table bonificacao_fechamento_mensal
    drop column if exists produtos_torque,
    drop column if exists produtos_perdas,
    drop column if exists produtos_fat_sanduiches,
    drop column if exists produtos_pct_fat_sanduiches,
    drop column if exists produtos_total_itens,
    drop column if exists produtos_canal_confirmado,
    drop column if exists produtos_atualizado_em,
    drop column if exists vendas_faturamento,
    drop column if exists vendas_ticket_medio,
    drop column if exists vendas_cupons_validos,
    drop column if exists vendas_cupons_vendas,
    drop column if exists vendas_metodos_pagamento,
    drop column if exists vendas_estabelecimento,
    drop column if exists vendas_origem,
    drop column if exists vendas_hash_arquivo,
    drop column if exists vendas_arquivo_storage,
    drop column if exists vendas_usuario_id,
    drop column if exists vendas_usuario_nome,
    drop column if exists vendas_atualizado_em,
    drop column if exists periodo_confirmado_usuario;

  -- 2.2 FKs org/unidade -> de volta para ON DELETE CASCADE (estado 074)
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_organizacao_id_fkey;
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_mix_mensal_organizacao_id_fkey;
  alter table bonificacao_fechamento_mensal add  constraint bonificacao_mix_mensal_organizacao_id_fkey
    foreign key (organizacao_id) references organizacoes(id) on delete cascade;
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_unidade_id_fkey;
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_mix_mensal_unidade_id_fkey;
  alter table bonificacao_fechamento_mensal add  constraint bonificacao_mix_mensal_unidade_id_fkey
    foreign key (unidade_id) references unidades(id) on delete cascade;

  -- 2.3 índices/trigger de volta
  alter index if exists idx_bfm_unidade rename to idx_bmm_unidade;
  alter index if exists idx_bfm_org     rename to idx_bmm_org;
  alter trigger trg_bfm_upd on bonificacao_fechamento_mensal rename to trg_bmm_upd;

  -- 2.4 constraints renomeadas de volta
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_pkey                          to bonificacao_mix_mensal_pkey;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_unidade_ano_mes_key           to bonificacao_mix_mensal_unidade_id_ano_mes_key;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_ano_check                     to bonificacao_mix_mensal_ano_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_mes_check                     to bonificacao_mix_mensal_mes_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_produtos_origem_check         to bonificacao_mix_mensal_origem_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_produtos_qtd_sanduiches_check to bonificacao_mix_mensal_qtd_sanduiches_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_produtos_qtd_bebidas_check    to bonificacao_mix_mensal_qtd_bebidas_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_produtos_qtd_adicionais_check to bonificacao_mix_mensal_qtd_adicionais_check;
  alter table bonificacao_fechamento_mensal rename constraint bonificacao_fechamento_mensal_produtos_qtd_diversos_check   to bonificacao_mix_mensal_qtd_diversos_check;

  -- restaura FK do usuário com o nome 074
  alter table bonificacao_fechamento_mensal drop constraint if exists bonificacao_fechamento_mensal_produtos_usuario_id_fkey;
  alter table bonificacao_fechamento_mensal add  constraint bonificacao_mix_mensal_usuario_id_fkey
    foreign key (produtos_usuario_id) references perfis(id) on delete set null;

  -- 2.5 colunas renomeadas de volta
  alter table bonificacao_fechamento_mensal rename column produtos_qtd_sanduiches     to qtd_sanduiches;
  alter table bonificacao_fechamento_mensal rename column produtos_qtd_bebidas        to qtd_bebidas;
  alter table bonificacao_fechamento_mensal rename column produtos_qtd_adicionais     to qtd_adicionais;
  alter table bonificacao_fechamento_mensal rename column produtos_qtd_diversos       to qtd_diversos;
  alter table bonificacao_fechamento_mensal rename column produtos_pct_bebidas_pdf    to percentual_bebidas_pdf;
  alter table bonificacao_fechamento_mensal rename column produtos_pct_adicionais_pdf to percentual_adicionais_pdf;
  alter table bonificacao_fechamento_mensal rename column produtos_pct_diversos_pdf   to percentual_diversos_pdf;
  alter table bonificacao_fechamento_mensal rename column produtos_faturamento_loja   to faturamento_loja;
  alter table bonificacao_fechamento_mensal rename column produtos_ppd                to ppd_loja;
  alter table bonificacao_fechamento_mensal rename column produtos_estabelecimento    to estabelecimento;
  alter table bonificacao_fechamento_mensal rename column produtos_hash_arquivo       to hash_arquivo;
  alter table bonificacao_fechamento_mensal rename column produtos_arquivo_storage    to arquivo_storage;
  alter table bonificacao_fechamento_mensal rename column produtos_origem             to origem;
  alter table bonificacao_fechamento_mensal rename column produtos_usuario_id         to usuario_id;
  alter table bonificacao_fechamento_mensal rename column produtos_usuario_nome       to usuario_nome;

  -- 2.6 RLS -> nome antigo
  drop policy if exists rls_bonificacao_fechamento_mensal_tenant on bonificacao_fechamento_mensal;
  drop policy if exists rls_bonificacao_mix_mensal_tenant        on bonificacao_fechamento_mensal;

  -- 2.7 RENAME TABLE de volta
  alter table bonificacao_fechamento_mensal rename to bonificacao_mix_mensal;

  create policy rls_bonificacao_mix_mensal_tenant on bonificacao_mix_mensal
    for all to authenticated
    using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
    with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());
end $$;

commit;

-- =====================================================================
-- VERIFICAÇÃO pós-rollback (rode separadamente):
--   \d+ bonificacao_mix_mensal      -> formato 074 (qtd_*, percentual_*_pdf,
--                                      faturamento_loja, ppd_loja; FKs CASCADE)
--   select to_regclass('bonificacao_fechamento_mensal');       -- NULL
--   select to_regclass('bonificacao_competencia');             -- NULL
--   select to_regclass('bonificacao_competencia_snapshot');    -- NULL
-- =====================================================================
