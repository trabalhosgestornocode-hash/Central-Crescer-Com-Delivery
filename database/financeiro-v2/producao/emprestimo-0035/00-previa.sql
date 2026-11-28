-- 00 — PRÉVIA em produção (SOMENTE LEITURA). Esperado: 34 migrações, todas conferidas por nome+hash (o 02 recusa se não);
-- nenhuma concessão com registrar_emprestimo; as concessões do MOVA exatamente nas versões/ações abaixo (o 04 recusa se mudarem).
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select count(*) from financeiro_v2.fv2_migracao where nome = '0035_registrar_emprestimo.sql') tem_0035,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') concessoes_com_a_acao;
select organizacao_id, unidade_id, versao, situacao, acoes,
       (acoes @> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb and '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb @> acoes) acoes_conferem
  from financeiro_v2.fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;
-- esperado: Açaí no Grau Saci versão 4; Subway Saci versão 2; ações = financeiro_v2.baixar_por_comprovante, financeiro_v2.enviar_documento, financeiro_v2.registrar_conta_parcelada, financeiro_v2.registrar_intercompany, financeiro_v2.registrar_juros, financeiro_v2.registrar_obrigacao, financeiro_v2.ver
