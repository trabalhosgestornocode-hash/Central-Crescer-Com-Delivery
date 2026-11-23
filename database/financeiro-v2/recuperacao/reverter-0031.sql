-- Financeiro v2 — RECUPERAÇÃO da migração 0031 (encargo no pagamento por comprovante). Só DEFINIÇÕES: nenhum dado é alterado.
-- Aplicar como `postgres` (não superusuário, com BYPASSRLS), numa ÚNICA transação, só com autorização específica.
-- Recusa se: 0031 não aplicada; houver migração posterior; ALGUMA concessão tiver `registrar_juros` (revogue antes).
-- Lançamentos e ajustes de juros já gravados continuam válidos (são registros normais da DRE); só a ação e a barreira somem.
set local search_path = financeiro_v2, pg_catalog;
do $$ declare n int; begin
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'reverter-0031: não aplicar como superusuário'; end if;
  if not (select rolbypassrls from pg_roles where rolname = current_user) then raise exception 'reverter-0031: exige BYPASSRLS (senão as contagens enganam)'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql') then raise exception 'reverter-0031: 0031 não aplicada — nada foi feito'; end if;
  select count(*) into n from fv2_migracao where nome > '0031_registrar_juros_no_pagamento.sql';
  if n > 0 then raise exception 'reverter-0031: há % migração(ões) posterior(es) — nada foi feito', n; end if;
  select count(*) into n from fv2_concessao where acoes ? 'financeiro_v2.registrar_juros';
  if n > 0 then raise exception 'reverter-0031: % concessão(ões) com registrar_juros — revogue antes', n; end if;
end $$;
grant fv2_guardiao to current_user;
drop trigger fv2_lancamento_juros on fv2_lancamento;
drop trigger fv2_ajuste_juros on fv2_ajuste;
drop function fv2_juros_documental();
drop function fv2_so_registra_juros();
-- gatilho da 0030 como era (sem a exceção do encargo)
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_registra_obrigacao() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: por documento só se registra lançamento de DESPESA nascido de conta a pagar.' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar por documento tem uma parcela, sem repetição e em aberto.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
    raise exception 'Financeiro v2: a conta a pagar por documento aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
  end if;
  return new;
end $$;
-- barreira da 0018 como era (sem a exceção do encargo)
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  if tg_table_name = 'fv2_obrigacao' and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao"]'::jsonb);
-- políticas: remove só a cláusula da ação nova da expressão ATUAL
do $$
declare r record; expr text; limpa text;
begin
  for r in select * from (values ('fv2_lancamento', 'fv2_lancamento_incluir'), ('fv2_ajuste', 'fv2_ajuste_incluir'), ('fv2_historico', 'fv2_historico_incluir')) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then raise exception 'reverter-0031: política %.% não encontrada', r.tabela, r.politica; end if;
    limpa := regexp_replace(expr, ' OR \(\( SELECT fv2_tem_acao\(ARRAY\[''financeiro_v2\.registrar_juros''::text\]\) AS fv2_tem_acao\)\)', '', 'g');
    limpa := regexp_replace(limpa, ' OR \(SELECT fv2_tem_acao\(ARRAY\[''financeiro_v2\.registrar_juros''::text\]\) AS fv2_tem_acao\)', '', 'g');
    if limpa like '%registrar_juros%' then raise exception 'reverter-0031: não consegui remover registrar_juros de %.%', r.tabela, r.politica; end if;
    execute format('alter policy %I on %I with check (%s)', r.politica, r.tabela, limpa);
  end loop;
end $$;
delete from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql';
revoke fv2_guardiao from current_user;
do $$ declare n int; begin
  select count(*) into n from fv2_migracao;
  if n <> 30 then raise exception 'reverter-0031 pós: % migrações (esperado 30)', n; end if;
  if exists (select 1 from pg_trigger where tgname in ('fv2_lancamento_juros', 'fv2_ajuste_juros')) then raise exception 'reverter-0031 pós: gatilho ainda existe'; end if;
end $$;
