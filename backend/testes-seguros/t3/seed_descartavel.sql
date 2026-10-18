-- T3 — semente mínima no projeto Supabase DESCARTÁVEL, com os MESMOS ids que os scripts de teste usam (organização A e unidade A; a organização B/unidade B são criadas pelos
-- próprios testes). Rodar DEPOIS de aplicar 120, 121 e 122 e ANTES de adversarial122*.sql / f1_concorrencia.sh / parity_m1.mjs / desempenho_m1.sql.
-- ATENÇÃO: o esquema real de `organizacoes` e `unidades` pode ter colunas NOT NULL além das usadas aqui (ex.: slug, status). Ajuste este arquivo ao esquema real; NÃO altere
-- os ids. Dados sintéticos; nunca use um projeto que tenha dados reais.
insert into organizacoes(id, nome) values ('00000000-0000-0000-0000-0000000000a1', 'T3 Organização A') on conflict (id) do nothing;
insert into unidades(id, organizacao_id, nome) values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'T3 Unidade A') on conflict (id) do nothing;
-- categoria e conta usadas pelos testes adversariais (adversarial122.sql cria as demais)
insert into fin_plano_contas(id, organizacao_id, tipo, natureza, nome, papel) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'RECEITA', 'RECEBIMENTO', 'VENDAS', 'receita_operacional') on conflict (id) do nothing;
insert into fin_contas(id, organizacao_id, unidade_id, nome) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'A') on conflict (id) do nothing;
