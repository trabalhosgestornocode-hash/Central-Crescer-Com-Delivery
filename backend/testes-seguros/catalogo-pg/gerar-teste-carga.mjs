#!/usr/bin/env node
// Gera um teste SQL a partir de uma carga REAL simulada (payload.json + relatorio.json do importador).
//
//   node gerar-teste-carga.mjs --payload <payload.json> --relatorio <relatorio.json> --saida <arquivo.sql>
//
// Os dois JSON têm receitas, custos e preços do cliente: ficam FORA do repositório (pasta privada) e o SQL gerado
// também (o runner carga_real.sh grava num diretório temporário). Este gerador só monta asserções:
//   1. 1ª carga cria tudo; 2ª carga é idempotente (0 novos, fichas preservadas, nada duplicado);
//   2. custo unitário no banco (fn_custo_produto) = custo unitário da PLANILHA para cada ficha completa;
//   3. ficha incompleta não tem custo apresentável como completo (fica 'pendente' e com pendência bloqueante);
//   4. isolamento: nada de outra organização muda (snapshot antes × depois), e um catálogo pré-existente na
//      MESMA organização (ex.: modelo Subway semeado por engano) não é tocado.
import { readFileSync, writeFileSync } from "node:fs";

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, t, i, arr) => (t.startsWith("--") ? [...acc, [t.slice(2), arr[i + 1]]] : acc), []));
if (!a.payload || !a.relatorio || !a.saida) { console.error("uso: --payload <json> --relatorio <json> --saida <sql>"); process.exit(2); }
const payload = JSON.parse(readFileSync(a.payload, "utf8"));
const rel = JSON.parse(readFileSync(a.relatorio, "utf8"));

const ORG = "d0000000-0000-4000-8000-0000000000aa"; // empresa-alvo fictícia (o id real NUNCA entra aqui)
const FONTE = "teste-carga-real";
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pendentes = new Set(rel.fichas_pendentes.map((f) => f.chave));
const completas = payload.produtos.filter((p) => !pendentes.has(p.chave) && typeof p.referencia?.custo_unit_planilha === "number");
const nIns = payload.insumos.length; const nProd = payload.produtos.length;
const nLinhas = payload.produtos.reduce((s, p) => s + p.linhas.length, 0);
const json = q(JSON.stringify(payload));

const sql = `
\\set ON_ERROR_STOP on
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALHA: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into organizacoes (id, nome) values (${q(ORG)}, 'Empresa alvo (teste)');
-- catálogo pré-existente NA MESMA empresa (simula o modelo Subway semeado): não pode ser tocado pela carga
insert into insumos (id, organizacao_id, nome, unidade_medida, preco_caixa, rendimento, preco_unitario)
  values ('e0000000-0000-4000-8000-0000000000a1', ${q(ORG)}, 'Insumo pré-existente', 'g', 10, 1000, 0.01);
insert into produtos (id, organizacao_id, nome, tipo, vendavel) values ('e0000000-0000-4000-8000-0000000000a2', ${q(ORG)}, 'Produto pré-existente', 'sanduiche', true);
insert into ficha_tecnica (produto_id, insumo_id, quantidade) values ('e0000000-0000-4000-8000-0000000000a2','e0000000-0000-4000-8000-0000000000a1', 100);
select fn_recalc_custo('e0000000-0000-4000-8000-0000000000a2');

create temp table snap_outros as
  select 'p:'||p.id k, p.nome||'|'||p.homologacao||'|'||round(fn_custo_produto(p.id),8)||'|'||p.ativo v from produtos p where p.organizacao_id <> ${q(ORG)} or p.id='e0000000-0000-4000-8000-0000000000a2'
  union all select 'i:'||i.id, i.nome||'|'||coalesce(i.preco_caixa::text,'∅')||'|'||i.ativo from insumos i where i.organizacao_id <> ${q(ORG)} or i.id='e0000000-0000-4000-8000-0000000000a1'
  union all select 'f:'||f.id, f.produto_id||'|'||coalesce(f.insumo_id::text,f.subproduto_id::text)||'|'||f.quantidade from ficha_tecnica f join produtos p on p.id=f.produto_id where p.organizacao_id <> ${q(ORG)} or p.id='e0000000-0000-4000-8000-0000000000a2';

create temp table r1 as select fn_catalogo_importar(${q(ORG)}, ${q(FONTE)}, ${json}::jsonb) r;
select t_assert((select (r->>'insumos_novos')::int from r1) = ${nIns}, '1ª carga: ${nIns} insumos/embalagens novos');
select t_assert((select (r->>'produtos_novos')::int from r1) = ${nProd}, '1ª carga: ${nProd} produtos/preparações novos');
select t_assert((select (r->>'linhas_ficha')::int from r1) = ${nLinhas}, '1ª carga: ${nLinhas} linhas de ficha');

create temp table r2 as select fn_catalogo_importar(${q(ORG)}, ${q(FONTE)}, ${json}::jsonb) r;
select t_assert((select (r->>'insumos_novos')::int + (r->>'produtos_novos')::int from r2) = 0, 'reimportação: nada novo');
select t_assert((select (r->>'fichas_preservadas')::int from r2) = ${nProd}, 'reimportação: todas as ${nProd} fichas preservadas');
select t_assert((select jsonb_array_length(r->'precos_divergentes') from r2) = 0, 'reimportação: nenhum preço divergente');
select t_assert((select count(*) from produtos where organizacao_id=${q(ORG)}) = ${nProd} + 1, 'reimportação não duplica produtos');
select t_assert((select count(*) from insumos where organizacao_id=${q(ORG)}) = ${nIns} + 1, 'reimportação não duplica insumos');
select t_assert((select count(*) from catalogo_importacoes where organizacao_id=${q(ORG)}) = 2, 'duas importações registradas (rastreabilidade)');

create temp table esperado(chave text, custo numeric);
insert into esperado values ${completas.map((p) => `(${q(p.chave)}, ${p.referencia.custo_unit_planilha})`).join(",\n  ")};
create temp table calc as
  select e.chave, e.custo esperado, fn_custo_produto(o.entidade_id) obtido
    from esperado e join catalogo_origem o on o.organizacao_id=${q(ORG)} and o.fonte=${q(FONTE)} and o.entidade='produto' and o.chave=e.chave;
select t_assert((select count(*) from calc) = ${completas.length}, '${completas.length} fichas completas localizadas pela origem');
select t_assert((select count(*) from calc where abs(obtido - esperado) > 0.001) = 0,
  'custo unitário no banco = custo unitário da planilha (± R$ 0,001) nas ${completas.length} fichas completas');

select t_assert((select count(*) from produtos p join catalogo_origem o on o.entidade_id=p.id and o.entidade='produto'
                  where p.organizacao_id=${q(ORG)} and p.homologacao <> 'pendente') = 0, 'toda ficha importada nasce pendente (nenhuma homologada)');
select t_assert((select count(*) from catalogo_origem o where o.organizacao_id=${q(ORG)} and o.entidade='produto'
                  and o.chave in (${[...pendentes].map(q).join(",") || "''"})
                  and not exists (select 1 from jsonb_array_elements(o.pendencias) x where x->>'codigo' in
                    ('layout_inesperado','linha_sem_quantidade','componente_nao_encontrado','linha_com_erro_na_planilha','sem_rendimento',
                     'sem_componentes','insumo_sem_custo','preparacao_incompleta','custo_planilha_invalido','ciclo_na_receita'))) = 0,
  '${pendentes.size} fichas incompletas gravadas com pendência bloqueante');
select t_assert((select count(*) from catalogo_origem o where o.organizacao_id=${q(ORG)}
                  and coalesce(o.referencia->'fontes'->0->>'aba', o.referencia->'fontes'->0->>'onde') is null) = 0,
  'todo registro rastreável até a aba/linha de origem');

select t_assert((select count(*) from (
  select k, v from snap_outros except (
  select 'p:'||p.id, p.nome||'|'||p.homologacao||'|'||round(fn_custo_produto(p.id),8)||'|'||p.ativo from produtos p
  union all select 'i:'||i.id, i.nome||'|'||coalesce(i.preco_caixa::text,'∅')||'|'||i.ativo from insumos i
  union all select 'f:'||f.id, f.produto_id||'|'||coalesce(f.insumo_id::text,f.subproduto_id::text)||'|'||f.quantidade from ficha_tecnica f)) d) = 0,
  'isolamento: outras empresas e o catálogo pré-existente da própria empresa intactos');
select t_assert((select count(*) from catalogo_origem where organizacao_id <> ${q(ORG)} and fonte=${q(FONTE)}) = 0, 'nenhuma origem gravada em outra empresa');
`;
writeFileSync(a.saida, sql);
console.log(`teste gerado: ${completas.length} completas, ${pendentes.size} pendentes, ${nIns} insumos, ${nProd} produtos`);
