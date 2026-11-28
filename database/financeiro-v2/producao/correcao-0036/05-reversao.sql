-- 05 — REVERSÃO da 0036 (só se necessário; revisar antes).
-- ===================== A) concessões: tira SÓ corrigir_conta_a_pagar de quem a tem e está ATIVA (identidade do MOVA). Não reativa
-- concessão revogada, não devolve ação retirada depois, não toca outra identidade nem outra ação. Rodar de novo não faz nada.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
with alvo as (select * from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and situacao = 'ATIVA' and acoes ? 'financeiro_v2.corrigir_conta_a_pagar' for update),
alterada as (
  update fv2_concessao c set acoes = c.acoes - 'financeiro_v2.corrigir_conta_a_pagar', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9',
         justificativa = 'Reversão da 0036: retirada só de corrigir_conta_a_pagar'
    from alvo where c.id = alvo.id
  returning c.*, alvo.acoes as acoes_antes, alvo.versao as versao_antes, alvo.situacao as situacao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, '63d66676-f042-4197-9b51-076f5145c1b9', now() from alterada;
select organizacao_id, unidade_id, versao, situacao, acoes from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;
commit;
-- ===================== B) banco: volta EXATAMENTE à 0035 (funções da 0031/0014 recortadas do Git; políticas sem o termo da 0036)
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if exists (select 1 from fv2_concessao where acoes ? 'financeiro_v2.corrigir_conta_a_pagar') then raise exception '0036: ainda há concessão com corrigir_conta_a_pagar (outra identidade?) — revise; nada foi feito'; end if;
end $$;
drop trigger fv2_obrigacao_correcao_estreita on fv2_obrigacao;
drop trigger fv2_lancamento_correcao_estreita on fv2_lancamento;
drop function fv2_correcao_de_conta();
drop function fv2_correcao_de_lancamento();
drop function fv2_conta_corrigivel(uuid, uuid, uuid);
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if tg_table_name = 'fv2_obrigacao' and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint
       or (to_jsonb(new)->>'ajustes_centavos')::bigint < (to_jsonb(old)->>'ajustes_centavos')::bigint
       or new.situacao is distinct from old.situacao then
      raise exception 'Financeiro v2: o encargo só soma à conta o ajuste registrado com ele, sem reduzir nem mudar a situação.' using errcode = '42501';
    end if;
    livres := livres || array['ajustes_centavos', 'saldo_centavos'];
    so_encargo := true;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  -- Na conta, a situação resultante de uma baixa só pode ser parcial ou quitada (nunca cancelar ou reabrir); o encargo não muda a situação.
  if tg_table_name = 'fv2_obrigacao' and not so_encargo and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function fv2_exigir_acao_do_lancamento() returns trigger language plpgsql as $$
declare
  cat record;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if (new.categoria_id, new.categoria_codigo, new.classificacao, new.natureza)
       is not distinct from (old.categoria_id, old.categoria_codigo, old.classificacao, old.natureza) then
    -- Sem mudança de categoria: as ações de sempre. `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar']) then
      raise exception 'Financeiro v2: alterar o lançamento exige cancelar, corrigir ou revisar.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not fv2_tem_acao(array['financeiro_v2.reclassificar']) then
    raise exception 'Financeiro v2: mudar a categoria de um lançamento exige reclassificar.' using errcode = '42501';
  end if;
  if old.situacao <> 'ATIVO' then
    raise exception 'Financeiro v2: lançamento cancelado não é reclassificado.' using errcode = 'FV037';
  end if;
  if (new.valor_centavos, new.moeda, new.competencia, new.situacao, new.data_operacao, new.descricao, new.origem, new.canal,
      new.retido_no_repasse, new.fonte_sistema, new.fonte_id_externo)
       is distinct from (old.valor_centavos, old.moeda, old.competencia, old.situacao, old.data_operacao, old.descricao, old.origem, old.canal,
      old.retido_no_repasse, old.fonte_sistema, old.fonte_id_externo) then
    raise exception 'Financeiro v2: a reclassificação muda só a categoria — a identidade do fato econômico é preservada.' using errcode = 'FV037';
  end if;
  if not (new.natureza = old.natureza
          or (old.origem->>'tipo' = 'OBRIGACAO' and old.natureza in ('DESPESA', 'PATRIMONIAL') and new.natureza in ('DESPESA', 'PATRIMONIAL'))) then
    raise exception 'Financeiro v2: natureza econômica incompatível na reclassificação.' using errcode = 'FV038';
  end if;
  if new.categoria_codigo in ('DESCONTOS_A_CLASSIFICAR', 'DESPESAS_A_CLASSIFICAR') then
    raise exception 'Financeiro v2: categoria provisória não é destino de reclassificação.' using errcode = 'FV038';
  end if;
  select c.codigo, c.natureza, c.classificacao, c.aceita_lancamento, c.ativa into cat
    from fv2_categoria c where c.id = new.categoria_id and c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id;
  if cat.codigo is null or cat.codigo <> new.categoria_codigo or cat.natureza <> new.natureza or cat.classificacao <> new.classificacao
     or not cat.aceita_lancamento or not cat.ativa then
    raise exception 'Financeiro v2: a categoria de destino não confere com o plano de contas da unidade.' using errcode = 'FV038';
  end if;
  return new;
end $$;
drop function fv2_so_corrige_conta();
do $$ declare r record; termo text := ' OR \( SELECT (financeiro_v2\.)?fv2_tem_acao\(ARRAY\[''financeiro_v2.corrigir_conta_a_pagar''::text\]\) AS fv2_tem_acao\)'; q text; w text; begin
  for r in select c.relname tabela, p.polname politica, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
             from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace and (c.relname, p.polname) in (('fv2_obrigacao', 'fv2_obrigacao_alterar'), ('fv2_lancamento', 'fv2_lancamento_alterar'), ('fv2_contraparte', 'fv2_contraparte_incluir'), ('fv2_historico', 'fv2_historico_incluir')) loop
    q := regexp_replace(r.q, termo, '');
    w := regexp_replace(r.w, termo, '');
    if r.q is not null and q is distinct from r.q then execute format('alter policy %I on %I using (%s)', r.politica, r.tabela, q); end if;
    if r.w is not null and w is distinct from r.w then execute format('alter policy %I on %I with check (%s)', r.politica, r.tabela, w); end if;
  end loop;
end $$;
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos", "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros", "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany", "financeiro_v2.registrar_emprestimo"]'::jsonb);
delete from fv2_migracao where nome = '0036_corrigir_conta_a_pagar.sql';
do $$ begin
  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace
              and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%corrigir_conta_a_pagar%')
     or exists (select 1 from pg_proc where pronamespace = 'financeiro_v2'::regnamespace and prosrc like '%corrigir_conta_a_pagar%') then
    raise exception '0036 reversão: ainda há referência a corrigir_conta_a_pagar — nada foi feito';
  end if;
end $$;
select count(*) migracoes from fv2_migracao;
commit;
