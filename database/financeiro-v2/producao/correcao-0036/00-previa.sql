-- 00 — PRÉVIA em produção (SOMENTE LEITURA). Esperado: 35 migrações (o 02 confere nome+hash e recusa se não); a 0036 ausente;
-- nenhuma concessão com corrigir_conta_a_pagar; as concessões do MOVA exatamente nas versões/ações abaixo (o 04 recusa se mudarem).
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select count(*) from financeiro_v2.fv2_migracao where nome = '0036_corrigir_conta_a_pagar.sql') tem_0036,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.corrigir_conta_a_pagar') concessoes_com_a_acao,
       (select count(*) from pg_proc where proname in ('fv2_so_corrige_conta', 'fv2_conta_corrigivel', 'fv2_correcao_de_conta', 'fv2_correcao_de_lancamento')) funcoes_novas_presentes;
select organizacao_id, unidade_id, versao, situacao, acoes,
       (acoes @> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_emprestimo","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb and '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_emprestimo","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb @> acoes) acoes_conferem
  from financeiro_v2.fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;
-- esperado: Açaí no Grau Saci versão 5; Subway Saci versão 3; ações = financeiro_v2.baixar_por_comprovante, financeiro_v2.enviar_documento, financeiro_v2.registrar_conta_parcelada, financeiro_v2.registrar_emprestimo, financeiro_v2.registrar_intercompany, financeiro_v2.registrar_juros, financeiro_v2.registrar_obrigacao, financeiro_v2.ver
