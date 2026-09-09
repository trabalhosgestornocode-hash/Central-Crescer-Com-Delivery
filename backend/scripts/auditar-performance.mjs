// Auditoria estritamente de leitura. Não imprime credenciais nem dados pessoais.
import { writeFile } from 'node:fs/promises';
import { supabase } from '../src/config/supabase.js';
import { calcularMes } from '../src/modules/administrativo/performance/performance.calc.js';
import { listarUnidadesElegiveis } from '../src/modules/administrativo/administrativo.repo.js';
const check = r => { if (r.error) throw new Error(r.error.message); return r.data ?? []; };
// OpenAPI do próprio banco confirma as colunas expostas, sem inferir pelo frontend.
const schemaRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/openapi+json' } });
if (!schemaRes.ok) throw new Error(`Consulta ao catálogo falhou: ${schemaRes.status}`);
const schema = await schemaRes.json();
const tabelas = Object.fromEntries(Object.entries(schema.definitions ?? {}).map(([nome, d]) => [nome, Object.keys(d.properties ?? {})]));
const candidatasConversao = Object.entries(tabelas).flatMap(([tabela, colunas]) => colunas.filter(c => /conversao|conversão|visitas|visitantes|conversion/i.test(c)).map(coluna => ({ tabela, coluna })));
const unidades = check(await supabase.from('unidades').select('id,nome,organizacao_id,ativo,eh_teste').ilike('nome', '%Montes Claros%'));
const elegiveis = await listarUnidadesElegiveis({ moduloId: 'ifood_dashboard' });
const resultados = [];
for (const unidade of unidades) {
  const linhas = [];
  for (let offset = 0; ; offset += 1000) {
    const lote = check(await supabase.from('lancamentos_financeiros_diarios')
      .select('id,unidade_id,organizacao_id,data_lancamento,status,situacao,origem_lancamento,valor_vendas_ifood,taxas_comissoes,servicos_promocoes,taxas_entregadores,ajustes_contra_loja,qtd_vendas,valor_vendas_bruto,novos_clientes')
      .eq('organizacao_id', unidade.organizacao_id).eq('unidade_id', unidade.id)
      .gte('data_lancamento', '2026-04-01').lte('data_lancamento', '2026-08-31').order('data_lancamento').order('id').range(offset, offset + 999));
    linhas.push(...lote);
    if (lote.length < 1000) break;
  }
  const imports = await supabase.from('parser_fd_importacoes').select('id,unidade_id,periodo_inicio,periodo_fim,status,taxas_validas').eq('organizacao_id', unidade.organizacao_id).eq('unidade_id', unidade.id);
  const distribuicoes = check(await supabase.from('lancamentos_financeiros_distribuicao_mensal').select('*').eq('organizacao_id', unidade.organizacao_id).eq('unidade_id', unidade.id).eq('ano',2026).gte('mes',4).lte('mes',8));
  resultados.push({ unidade, elegivelPainel: elegiveis.some(u => u.unidadeId === unidade.id), registros: linhas.length,
    meses: ['04','05','06','07','08'].map(m => calcularMes(linhas, `2026-${m}`, '2026-09-09')),
    distribuicoes: distribuicoes.map(r => ({ competencia: `${r.ano}-${String(r.mes).padStart(2,'0')}`, camposDisponiveis: Object.keys(r).filter(k => r[k] != null && /total|extra/.test(k)) })),
    foodDelivery: imports.error ? { erro: imports.error.message } : imports.data });
}
const resultado = { consultadoEm: new Date().toISOString(), somenteLeitura: true, catalogo: { tabelasConsultadas: Object.keys(tabelas).length, candidatasConversao, fontes: Object.fromEntries(Object.entries(tabelas).filter(([t]) => /lancamentos_financeiros_diarios|lancamentos_financeiros_distribuicao_mensal$|parser_fd_importacoes|parser_fd_pedidos/.test(t))) }, unidades: resultados };
await writeFile(new URL('../../docs/performance-auditoria-dados.json', import.meta.url), JSON.stringify(resultado, null, 2));
console.log(JSON.stringify(resultado, null, 2));
