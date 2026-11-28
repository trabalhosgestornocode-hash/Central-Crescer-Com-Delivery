-- 03 — CONFERÊNCIA (somente leitura). Depois do 02: 36 migrações; a 0036 com o hash do Git (aplicado = arquivo); a ação na lista;
-- as 4 funções e os 2 gatilhos novos. Depois do 04: SÓ as 2 concessões do MOVA (Açaí no Grau Saci, Subway Saci) com a ação; nenhuma com sangria.
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select bool_or(nome = '0036_corrigir_conta_a_pagar.sql') from financeiro_v2.fv2_migracao) tem_0036,
       (select bool_and(sha256 = 'dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a' and sha256_aplicado = 'dd66132c67499b31a025ba6cb3b1b3b16509cbc4192a55c5649ec2fb69b7cf7a') from financeiro_v2.fv2_migracao where nome = '0036_corrigir_conta_a_pagar.sql') hash_confere,
       (select pg_get_constraintdef(oid) like '%corrigir_conta_a_pagar%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao_na_lista,
       (select count(*) from pg_proc where proname in ('fv2_so_corrige_conta', 'fv2_conta_corrigivel', 'fv2_correcao_de_conta', 'fv2_correcao_de_lancamento')) funcoes_novas,
       (select count(*) from pg_trigger where tgname in ('fv2_obrigacao_correcao_estreita', 'fv2_lancamento_correcao_estreita')) gatilhos_novos,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.corrigir_conta_a_pagar') concessoes_com_a_acao,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.corrigir_conta_a_pagar' and not (usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and (organizacao_id, unidade_id) in (('e7216085-1ece-45dc-bc41-d74f11a88e40'::uuid, '4d3b75bd-79b5-4335-ae5b-a183580c3555'::uuid), ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-0000000000a1'::uuid)))) fora_do_alcance,
       (select count(*) from financeiro_v2.fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and acoes ? 'financeiro_v2.prestar_sangria') com_sangria;
