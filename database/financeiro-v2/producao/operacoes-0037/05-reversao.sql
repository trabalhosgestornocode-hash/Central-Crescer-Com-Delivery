-- 05 — REVERSÃO da 0037 (só se necessário; revisar antes).
-- ===================== A) concessões: tira SÓ as 4 ações de quem as tem e está ATIVA (identidade do MOVA). Não reativa concessão revogada,
-- não devolve ação retirada depois, não toca outra identidade nem outra ação. Rodar de novo não faz nada.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
with alvo as (select * from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and situacao = 'ATIVA' and (acoes ?| array['financeiro_v2.reclassificar_conta_a_pagar', 'financeiro_v2.ajustar_conta_a_pagar', 'financeiro_v2.mover_competencia_conta_a_pagar', 'financeiro_v2.cancelar_conta_a_pagar']) for update),
alterada as (
  update fv2_concessao c set acoes = c.acoes - array['financeiro_v2.reclassificar_conta_a_pagar', 'financeiro_v2.ajustar_conta_a_pagar', 'financeiro_v2.mover_competencia_conta_a_pagar', 'financeiro_v2.cancelar_conta_a_pagar'], versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9',
         justificativa = 'Reversão da 0037: retirada só das 4 ações de operações de conta a pagar'
    from alvo where c.id = alvo.id
  returning c.*, alvo.acoes as acoes_antes, alvo.versao as versao_antes, alvo.situacao as situacao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, '63d66676-f042-4197-9b51-076f5145c1b9', now() from alterada;
select organizacao_id, unidade_id, versao, situacao, acoes from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;
commit;
-- ===================== B) banco: volta EXATAMENTE à 0036 (funções anteriores recortadas do Git; políticas sem os termos da 0037)
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if exists (select 1 from fv2_concessao where acoes ?| array['financeiro_v2.reclassificar_conta_a_pagar', 'financeiro_v2.ajustar_conta_a_pagar', 'financeiro_v2.mover_competencia_conta_a_pagar', 'financeiro_v2.cancelar_conta_a_pagar']) then raise exception '0037: ainda há concessão com as ações da 0037 (outra identidade?) — revise; nada foi feito'; end if;
end $$;
drop trigger fv2_lancamento_operacao_estreita on fv2_lancamento;
drop trigger fv2_lancamento_ajuste_estreito on fv2_lancamento;
drop trigger fv2_ajuste_estreito on fv2_ajuste;
drop trigger fv2_obrigacao_estreita_coerente on fv2_obrigacao;
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  -- 0036: correção cadastral estreita — ALGUM campo cadastral muda e nenhuma coluna de posição; fv2_correcao_de_conta confere que
  -- NADA além do cadastral mudou (competência, valor, situação… são recusados lá). Sem campo cadastral mudando, segue a barreira abaixo.
  if tg_table_name = 'fv2_obrigacao' and fv2_so_corrige_conta()
     and ((to_jsonb(old)->'contraparte_id') is distinct from (to_jsonb(new)->'contraparte_id') or (to_jsonb(old)->'vencimento') is distinct from (to_jsonb(new)->'vencimento')
       or (to_jsonb(old)->'descricao') is distinct from (to_jsonb(new)->'descricao')
       or (to_jsonb(old)->'extras'->'observacao') is distinct from (to_jsonb(new)->'extras'->'observacao')
       or (to_jsonb(old)->'extras'->'formaPagamento') is distinct from (to_jsonb(new)->'extras'->'formaPagamento'))
     and (to_jsonb(old)->>'liquidado_centavos') is not distinct from (to_jsonb(new)->>'liquidado_centavos')
     and (to_jsonb(old)->>'saldo_centavos') is not distinct from (to_jsonb(new)->>'saldo_centavos')
     and (to_jsonb(old)->>'ajustes_centavos') is not distinct from (to_jsonb(new)->>'ajustes_centavos')
     and (to_jsonb(old)->>'situacao') is not distinct from (to_jsonb(new)->>'situacao') then
    return new;
  end if;
  -- 0036: quem só muda a posição não reescreve a observação nem a forma de pagamento da conta
  if tg_table_name = 'fv2_obrigacao'
     and ((to_jsonb(old)->'extras'->'observacao') is distinct from (to_jsonb(new)->'extras'->'observacao')
       or (to_jsonb(old)->'extras'->'formaPagamento') is distinct from (to_jsonb(new)->'extras'->'formaPagamento')) then
    raise exception 'Financeiro v2: a baixa não altera a observação nem a forma de pagamento da conta.' using errcode = '42501';
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
    -- Sem mudança de categoria: as ações de sempre (0036: + corrigir_conta_a_pagar, limitada à DESCRIÇÃO por fv2_correcao_de_lancamento). `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar']) then
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
create or replace function fv2_correcao_de_lancamento() returns trigger language plpgsql as $$
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) then
    raise exception 'Financeiro v2: a correção estreita muda no lançamento só a descrição.' using errcode = '42501';
  end if;
  if old.origem->>'tipo' <> 'OBRIGACAO' or exists (
       select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
          and not fv2_conta_corrigivel(o.organizacao_id, o.unidade_id, o.id))
     or not exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id) then
    raise exception 'Financeiro v2: a descrição do lançamento só muda com todas as parcelas da conta abertas e sem pagamento.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function fv2_juros_documental() returns trigger language plpgsql as $$
declare
  o record;
  l record;
begin
  if not fv2_so_registra_juros() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or new.retido_no_repasse then
      raise exception 'Financeiro v2: o encargo do pagamento é uma despesa ativa na categoria oficial de juros e multas.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_ajuste
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos <= 0 or new.lancamento_id is null then
    raise exception 'Financeiro v2: o encargo é um ajuste positivo de conta a pagar, com seu lançamento.' using errcode = '42501';
  end if;
  select x.* into o from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into l from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if o.id is null or l.id is null or l.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or l.valor_centavos <> new.valor_centavos then
    raise exception 'Financeiro v2: o encargo aponta para a conta e para o lançamento de juros e multas com o mesmo valor.' using errcode = '42501';
  end if;
  if new.valor_centavos * 10 > o.valor_base_centavos then
    raise exception 'Financeiro v2: encargo acima de 10%% do valor da conta exige uma pessoa autorizada.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  documental boolean := fv2_so_registra_obrigacao();
  parcelada boolean := fv2_so_registra_conta_parcelada();
begin
  if not documental and not parcelada then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    -- 27/11: PRESERVA a exceção da 0031 (encargo do pagamento por quem tem registrar_juros; forma conferida por
    -- fv2_juros_documental). A primeira versão desta migração a perdia e recusava toda despesa paga com juros/multa.
    if documental and new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new;
    end if;
    if new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: só se registra lançamento ativo nascido de conta a pagar.' using errcode = '42501';
    end if;
    if new.natureza = 'DESPESA' or (parcelada and new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO')
       or fv2_principal_de_emprestimo(new.natureza, new.categoria_codigo) then
      return new;
    end if;
    raise exception 'Financeiro v2: conta a pagar estreita só em categoria de DESPESA (ou compra de equipamentos, na relatada, ou principal de empréstimo com registrar_emprestimo).' using errcode = '42501';
  end if;
  -- fv2_obrigacao
  if new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar estreita nasce em aberto, sem repetição.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text then
    raise exception 'Financeiro v2: a conta a pagar estreita aponta para o lançamento criado com ela (mesma transação).' using errcode = '42501';
  end if;
  -- forma da 0030: uma parcela, valor igual ao do lançamento, natureza DESPESA (0035: ou principal de empréstimo com a ação nova)
  if documental and (new.parcela->>'total')::int = 1 and l.valor_centavos = new.valor_base_centavos
     and (l.natureza = 'DESPESA' or fv2_principal_de_emprestimo(l.natureza, l.categoria_codigo)) then
    return new;
  end if;
  -- forma da 0033: 1 a 24 parcelas do MESMO lançamento (a soma é conferida no fim da transação)
  if parcelada and (new.parcela->>'total')::int between 1 and 24 and (new.parcela->>'numero')::int between 1 and (new.parcela->>'total')::int
     and new.valor_base_centavos > 0 and new.valor_base_centavos <= l.valor_centavos and cardinality(new.documento_ids) = 0 then
    return new;
  end if;
  raise exception 'Financeiro v2: forma de conta a pagar não permitida para esta permissão estreita.' using errcode = '42501';
end $$;
drop function fv2_lancamento_operacao_estreita();
drop function fv2_ajuste_estreito_confere();
drop function fv2_conta_estreita_coerente();
drop function fv2_ajuste_estreito();
drop function fv2_forma_estreita_da_conta(fv2_obrigacao, fv2_obrigacao);
drop function fv2_colunas_alteradas(jsonb, jsonb);
drop function fv2_compra_elegivel(text, jsonb, text, text);
drop function fv2_periodo_estreito(uuid, uuid, text);
drop function fv2_pode_estreita(text);
do $$ declare r record; termo text := ' OR \( SELECT (financeiro_v2\.)?fv2_tem_acao\(ARRAY\[''financeiro_v2\.(reclassificar_conta_a_pagar|ajustar_conta_a_pagar|mover_competencia_conta_a_pagar|cancelar_conta_a_pagar)''::text\]\) AS fv2_tem_acao\)'; q text; w text; begin
  for r in select c.relname tabela, p.polname politica, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
             from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace and (c.relname, p.polname) in (('fv2_lancamento', 'fv2_lancamento_alterar'), ('fv2_lancamento', 'fv2_lancamento_incluir'), ('fv2_ajuste', 'fv2_ajuste_incluir'), ('fv2_obrigacao', 'fv2_obrigacao_alterar'), ('fv2_historico', 'fv2_historico_incluir')) loop
    q := regexp_replace(r.q, termo, '', 'g');
    w := regexp_replace(r.w, termo, '', 'g');
    if r.q is not null and q is distinct from r.q then execute format('alter policy %I on %I using (%s)', r.politica, r.tabela, q); end if;
    if r.w is not null and w is distinct from r.w then execute format('alter policy %I on %I with check (%s)', r.politica, r.tabela, w); end if;
  end loop;
end $$;
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos", "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros", "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany", "financeiro_v2.registrar_emprestimo", "financeiro_v2.corrigir_conta_a_pagar"]'::jsonb);
delete from fv2_migracao where nome = '0037_operacoes_de_conta_a_pagar.sql';
do $$ begin
  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace
              and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ '(reclassificar|ajustar|mover_competencia|cancelar)_conta_a_pagar')
     or exists (select 1 from pg_proc where pronamespace = 'financeiro_v2'::regnamespace and prosrc ~ '(reclassificar|ajustar|mover_competencia|cancelar)_conta_a_pagar') then
    raise exception '0037 reversão: ainda há referência às ações da 0037 — nada foi feito';
  end if;
end $$;
select count(*) migracoes from fv2_migracao;
commit;
