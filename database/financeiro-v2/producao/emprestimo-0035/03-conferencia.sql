-- 03 — CONFERÊNCIA depois da 0035 (somente leitura). Esperado: 35 migrações; a ação na lista; a função nova; NENHUMA concessão com a ação.
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select bool_or(nome = '0035_registrar_emprestimo.sql') from financeiro_v2.fv2_migracao) tem_0035,
       (select pg_get_constraintdef(oid) like '%registrar_emprestimo%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao_na_lista,
       (select count(*) from pg_proc where proname = 'fv2_principal_de_emprestimo') funcao_nova,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') concessoes_com_a_acao;
