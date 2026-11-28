-- 03 — CONFERÊNCIA (somente leitura). Depois do 02: 35 migrações; a 0035 com o hash do Git (aplicado = arquivo); a ação na lista;
-- a função nova. Depois do 04: SÓ as 2 concessões do MOVA (Açaí no Grau Saci, Subway Saci) com a ação; nenhuma com prestar_sangria.
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select bool_or(nome = '0035_registrar_emprestimo.sql') from financeiro_v2.fv2_migracao) tem_0035,
       (select bool_and(sha256 = '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509' and sha256_aplicado = '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509') from financeiro_v2.fv2_migracao where nome = '0035_registrar_emprestimo.sql') hash_confere,
       (select pg_get_constraintdef(oid) like '%registrar_emprestimo%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao_na_lista,
       (select count(*) from pg_proc where proname = 'fv2_principal_de_emprestimo') funcao_nova,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') concessoes_com_a_acao,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo' and not (usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and (organizacao_id, unidade_id) in (('e7216085-1ece-45dc-bc41-d74f11a88e40'::uuid, '4d3b75bd-79b5-4335-ae5b-a183580c3555'::uuid), ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-0000000000a1'::uuid)))) fora_do_alcance,
       (select count(*) from financeiro_v2.fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and acoes ? 'financeiro_v2.prestar_sangria') com_sangria;
