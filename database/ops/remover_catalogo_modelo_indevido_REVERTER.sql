-- REVERTER (ESCRITA) — devolve o catálogo-modelo removido pelo APLICAR, a partir da cópia em backup_ops.
-- Uso: troque <LOTE> pelo id de lote que o APLICAR mostrou. Transação única; reinsere com os MESMOS ids e valores e
-- devolve o modelo_origem_id anterior da empresa (se ainda estiver nulo).
-- Recusa se algum id já existir (por exemplo, se o APLICAR não chegou a remover ou se já foi revertido).
begin;
create temp table _lote on commit drop as select '<LOTE>'::uuid lote;

do $$ begin
  if not exists (select 1 from backup_ops.modelo_indevido_produtos b, _lote l where b.lote = l.lote) then
    raise exception 'Lote não encontrado na cópia de segurança.';
  end if;
  if exists (select 1 from produtos p join backup_ops.modelo_indevido_produtos b on (b.linha->>'id')::uuid = p.id join _lote l on b.lote = l.lote)
     or exists (select 1 from insumos i join backup_ops.modelo_indevido_insumos b on (b.linha->>'id')::uuid = i.id join _lote l on b.lote = l.lote) then
    raise exception 'Itens do lote já existem: nada foi alterado.';
  end if;
end $$;

insert into insumos select (jsonb_populate_record(null::insumos, b.linha)).* from backup_ops.modelo_indevido_insumos b join _lote l on b.lote = l.lote;
insert into produtos select (jsonb_populate_record(null::produtos, b.linha)).* from backup_ops.modelo_indevido_produtos b join _lote l on b.lote = l.lote;
insert into produto_precos select (jsonb_populate_record(null::produto_precos, b.linha)).* from backup_ops.modelo_indevido_precos b join _lote l on b.lote = l.lote;
insert into ficha_tecnica select (jsonb_populate_record(null::ficha_tecnica, b.linha)).* from backup_ops.modelo_indevido_ficha b join _lote l on b.lote = l.lote;
update organizacoes o set modelo_origem_id = e.modelo_origem_id
  from backup_ops.modelo_indevido_empresa e join _lote l on e.lote = l.lote
  where o.id = e.organizacao_id and o.modelo_origem_id is null;

select 'produtos devolvidos' item, count(*)::text valor from backup_ops.modelo_indevido_produtos b join _lote l on b.lote = l.lote
union all select 'insumos devolvidos', count(*)::text from backup_ops.modelo_indevido_insumos b join _lote l on b.lote = l.lote;
commit;
