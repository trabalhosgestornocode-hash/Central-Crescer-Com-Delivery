-- CONTINGÊNCIA (ESCRITA) — restaura o catálogo-modelo removido A PARTIR DOS ARQUIVOS do backup somente-leitura
-- (produtos.jsonl, insumos.jsonl, ficha_tecnica.jsonl, produto_precos.jsonl; 1 linha = to_jsonb(linha)), para o caso
-- de o backup_ops não estar disponível. Rodar com psql (não no SQL Editor: usa \copy do lado do cliente).
-- Uso: troque <PASTA> pela pasta do backup (barras normais, ex.: C:/backup) e rode: psql "<url>" -v ON_ERROR_STOP=1 -f arquivo.sql
-- Recusa se algum id já existir. Transação única.
\encoding UTF8
-- (os arquivos são UTF-8; sem isto o psql do Windows pode ler como WIN1252 e corromper acentos)
create temp table r_produtos(linha jsonb);
create temp table r_insumos(linha jsonb);
create temp table r_ficha_tecnica(linha jsonb);
create temp table r_produto_precos(linha jsonb);
\copy r_produtos(linha) from '<PASTA>/produtos.jsonl' with (format csv, quote e'\x01', delimiter e'\x02')
\copy r_insumos(linha) from '<PASTA>/insumos.jsonl' with (format csv, quote e'\x01', delimiter e'\x02')
\copy r_ficha_tecnica(linha) from '<PASTA>/ficha_tecnica.jsonl' with (format csv, quote e'\x01', delimiter e'\x02')
\copy r_produto_precos(linha) from '<PASTA>/produto_precos.jsonl' with (format csv, quote e'\x01', delimiter e'\x02')
begin;
do $$ begin
  if exists (select 1 from produtos p join r_produtos r on (r.linha->>'id')::uuid = p.id)
     or exists (select 1 from insumos i join r_insumos r on (r.linha->>'id')::uuid = i.id) then
    raise exception 'Itens do backup já existem: nada foi alterado.';
  end if;
end $$;
insert into insumos select (jsonb_populate_record(null::insumos, linha)).* from r_insumos;
insert into produtos select (jsonb_populate_record(null::produtos, linha)).* from r_produtos;
insert into produto_precos select (jsonb_populate_record(null::produto_precos, linha)).* from r_produto_precos;
insert into ficha_tecnica select (jsonb_populate_record(null::ficha_tecnica, linha)).* from r_ficha_tecnica;
select 'restaurados (produtos/insumos/ficha/preços)' item,
  (select count(*) from r_produtos)||'/'||(select count(*) from r_insumos)||'/'||(select count(*) from r_ficha_tecnica)||'/'||(select count(*) from r_produto_precos) valor;
commit;
