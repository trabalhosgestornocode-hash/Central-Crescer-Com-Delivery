-- T3 — semente mínima no projeto Supabase DESCARTÁVEL, com os MESMOS ids que os scripts de teste usam (organização A e unidade A; a organização B/unidade B são criadas pelos
-- próprios testes). Rodar DEPOIS de aplicar 120, 121 e 122 e ANTES de adversarial122*.sql / f1_concorrencia.sh / parity_m1.mjs / desempenho_m1.sql.
-- ATENÇÃO: o esquema real de `organizacoes` e `unidades` pode ter colunas NOT NULL além das usadas aqui (ex.: slug, status). Ajuste este arquivo ao esquema real; NÃO altere
-- os ids. Dados sintéticos; nunca use um projeto que tenha dados reais.
-- TRAVA DE AMBIENTE DESCARTÁVEL (cópia INLINE de t3/guarda_descartavel.sql: erro dentro de \ir NÃO encerra o script que incluiu)
\set ON_ERROR_STOP on
\if :{?CONFIRMO}
\else
  \set CONFIRMO 'ausente'
\endif
select (:'CONFIRMO' = 'ESTE_PROJETO_E_DESCARTAVEL') as guarda_confirmado \gset
\if :guarda_confirmado
\else
  do $guarda$ begin raise exception 'RECUSADO: rode com -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL (somente banco/projeto DESCARTAVEL).'; end $guarda$;
\endif
do $guarda$
begin
  if to_regclass('public.organizacoes') is not null
     and exists (select 1 from public.organizacoes where id::text not like '00000000-0000-0000-0000-0000000000__') then
    raise exception 'RECUSADO: ha organizacoes que nao sao de teste neste banco; isto nao parece um ambiente descartavel.';
  end if;
end $guarda$;
-- fim da trava
insert into organizacoes(id, nome) values ('00000000-0000-0000-0000-0000000000a1', 'T3 Organização A') on conflict (id) do nothing;
insert into unidades(id, organizacao_id, nome) values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'T3 Unidade A') on conflict (id) do nothing;
-- categoria e conta usadas pelos testes adversariais (adversarial122.sql cria as demais)
insert into fin_plano_contas(id, organizacao_id, tipo, natureza, nome, papel) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'RECEITA', 'RECEBIMENTO', 'VENDAS', 'receita_operacional') on conflict (id) do nothing;
insert into fin_contas(id, organizacao_id, unidade_id, nome) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'A') on conflict (id) do nothing;
