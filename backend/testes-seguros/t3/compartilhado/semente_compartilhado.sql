-- T3 COMPARTILHADO — semente sintética (A3). Só roda pelo t3c.mjs (passo "semente"), DENTRO do embrulho: trava do modo compartilhado,
-- transação única e conferência, antes do COMMIT, de que nada fora da allowlist mudou. Não toca em usuários, perfis nem em dados existentes.
-- Organizações e unidades com ids da allowlist (00000000-0000-0000-0000-0000000f1a__) e nome [T3-FIN]; o módulo financeiro é habilitado SÓ nelas.
-- Idempotente (on conflict do nothing). Qualquer erro aborta tudo (este corpo roda SEM ON_ERROR_ROLLBACK).
insert into public.organizacoes (id, nome) values
  ('00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Org A (sintética)'),
  ('00000000-0000-0000-0000-0000000f1a02', '[T3-FIN] Org B (sintética)')
on conflict (id) do nothing;
insert into public.unidades (id, organizacao_id, nome) values
  ('00000000-0000-0000-0000-0000000f1a11', '00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Unidade A'),
  ('00000000-0000-0000-0000-0000000f1a12', '00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Unidade A3'),
  ('00000000-0000-0000-0000-0000000f1a13', '00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Unidade A4'),
  ('00000000-0000-0000-0000-0000000f1a14', '00000000-0000-0000-0000-0000000f1a02', '[T3-FIN] Unidade B'),
  ('00000000-0000-0000-0000-0000000f1a15', '00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Unidade livre (sem Financeiro; prova de transferência)'),
  ('00000000-0000-0000-0000-0000000f1a16', '00000000-0000-0000-0000-0000000f1a01', '[T3-FIN] Unidade F-3/F-4')
on conflict (id) do nothing;
insert into public.organizacao_modulos (organizacao_id, modulo_id)
  select o, 'gestao_financeira' from unnest(array['00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02']::uuid[]) o
on conflict do nothing;
insert into public.unidade_modulos (unidade_id, modulo_id)
  select u, 'gestao_financeira' from unnest(array['00000000-0000-0000-0000-0000000f1a11', '00000000-0000-0000-0000-0000000f1a12', '00000000-0000-0000-0000-0000000f1a13',
                                                  '00000000-0000-0000-0000-0000000f1a14', '00000000-0000-0000-0000-0000000f1a16']::uuid[]) u
on conflict do nothing;
-- categoria e conta que as adversariais esperam (mesmos ids de linha do seed descartável; as tabelas fin_* nascem vazias neste banco)
insert into public.fin_plano_contas (id, organizacao_id, tipo, natureza, nome, papel) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000f1a01', 'RECEITA', 'RECEBIMENTO', 'VENDAS', 'receita_operacional')
on conflict (id) do nothing;
insert into public.fin_contas (id, organizacao_id, unidade_id, nome) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a11', 'A')
on conflict (id) do nothing;
do $semente$
begin
  if (select count(*) from public.organizacoes where id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02') and nome like '[T3-FIN]%') <> 2
     or (select count(*) from public.unidades where organizacao_id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02')) <> 6
     or (select count(*) from public.unidade_modulos where modulo_id = 'gestao_financeira') <> 5
     or (select count(*) from public.organizacao_modulos where modulo_id = 'gestao_financeira') <> 2 then
    raise exception 'SEMENTE: estado inesperado (ids da allowlist já usados por outra coisa, ou módulo financeiro habilitado fora delas) — nada foi gravado';
  end if;
  raise notice 'PASS  semente: 2 organizações e 6 unidades [T3-FIN]; módulo habilitado só nelas';
end $semente$;
