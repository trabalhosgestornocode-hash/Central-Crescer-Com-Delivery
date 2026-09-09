import { createHash } from 'node:crypto';
import { diasDoMes } from '../../dashboard-executivo/dashboardExecutivo.calc.js';
import { CAMPOS, INDICADORES_OBRIGATORIOS } from './performance.config.js';
import { calcularMes, derivar, numero } from './performance.calc.js';

const DERIVADOS = {
  aposDespesas: ['Faturamento após despesas iFood','moeda'],
  ticketMedio: ['Ticket médio (faturamento iFood / pedidos)','moeda'],
  retencaoAposIfoodPct: ['Retenção após iFood','percentual'],
  custoIfoodPct: ['Custo iFood','percentual'],
  custoEntregadoresPct: ['Taxas de entregadores iFood / faturamento','percentual'],
  custoPorPedido: ['Taxa de entregador iFood por pedido','moeda'],
  custoExternosPct: ['Custo de entregadores externos / faturamento','percentual'],
  custoExternoPorPedido: ['Custo de entregador externo por pedido','moeda'],
};
export function fontesExternas(importacoes, competencia) {
  const [ano,mes] = competencia.split('-').map(Number);
  const dias = diasDoMes(ano,mes);
  const candidatas = importacoes.filter(r => r.status === 'concluida' && r.periodo_inicio <= dias.at(-1) && r.periodo_fim >= dias[0]);
  // Mesma janela do resumo oficial: importações inteiramente contidas no mês.
  const contidas = candidatas.filter(r => r.periodo_inicio >= dias[0] && r.periodo_fim <= dias.at(-1)).sort((a,b) => a.periodo_inicio.localeCompare(b.periodo_inicio));
  const sobrepostas = contidas.some((r,i) => i > 0 && r.periodo_inicio <= contidas[i-1].periodo_fim);
  const ambiguo = sobrepostas || contidas.length !== candidatas.length;
  const conhecido = contidas.length > 0 && contidas.every(r => numero(r.taxas_validas) != null);
  const valor = conhecido && !ambiguo ? numero(contidas.reduce((s,r) => s + Number(r.taxas_validas),0)) : null;
  const completo = valor != null && dias.every(d => contidas.some(r => r.periodo_inicio <= d && r.periodo_fim >= d));
  return { valor, parcial: candidatas.length > 0 && !completo, bloqueado: candidatas.length > 0 && valor == null,
    aviso: ambiguo ? 'Food Delivery: importações sobrepostas ou atravessando meses exigem revisão na origem.' : candidatas.length && !completo ? 'Food Delivery: cobertura mensal parcial das importações.' : null };
}
export function montarCompetencia(u, competencia, dados, hoje) {
  // Defesa adicional além dos filtros SQL: nenhuma linha de outro escopo entra no cálculo.
  const pertence = r => r.unidade_id === u.unidadeId && r.organizacao_id === u.organizacaoId;
  const linhas = dados.linhas.filter(pertence);
  const manual = dados.complementos.find(r => pertence(r) && r.competencia === `${competencia}-01`) ?? null;
  const oficial = calcularMes(linhas, competencia, hoje);
  const externos = u.usaParser ? fontesExternas(dados.importacoes.filter(pertence), competencia) : { valor:null, parcial:false, bloqueado:false, aviso:null };
  const automaticos = { ...oficial.indicadores, entregadoresExternos: externos.valor };
  const base = {};
  const campos = [];
  for (const [chave,def] of Object.entries(CAMPOS)) {
    const auto = numero(automaticos[chave]);
    const complemento = numero(manual?.[def.coluna]);
    const bloqueado = chave === 'entregadoresExternos' && externos.bloqueado;
    const valor = auto ?? (bloqueado ? null : complemento);
    base[chave] = valor;
    campos.push({ chave, nome:def.nome, tipo:def.tipo, valor,
      origem: auto != null ? 'AUTOMÁTICO' : valor != null ? 'MANUAL' : 'SEM DADOS',
      fonte: chave === 'entregadoresExternos' && (auto != null || bloqueado) ? 'Food Delivery · importações conciliadas da unidade habilitada' : auto != null || bloqueado ? def.fonte : valor != null ? 'Complemento mensal de Performance' : def.fonte,
      editavel: auto == null && !bloqueado, complementoIgnorado: auto != null && complemento != null,
      status: valor == null ? 'Pendente' : 'Disponível' });
  }
  const indicadores = derivar(base);
  for (const [chave,[nome,tipo]] of Object.entries(DERIVADOS)) campos.push({ chave,nome,tipo,valor:indicadores[chave],origem:indicadores[chave] == null ? 'SEM DADOS':'CALCULADO',fonte:'Calculado no backend a partir dos indicadores desta competência',editavel:false,status:indicadores[chave] == null ? 'Sem base de cálculo':'Disponível' });
  const [ano,mes] = competencia.split('-').map(Number);
  const ultimo = diasDoMes(ano,mes).at(-1);
  const parcialFinanceiro = oficial.financeiroAte != null && oficial.financeiroAte < ultimo;
  if (parcialFinanceiro) for (const campo of campos) {
    if (campo.origem === 'AUTOMÁTICO' && ['faturamento','despesasIfood','entregadores'].includes(campo.chave)) campo.status = 'Parcial';
  }
  const rascunhoOficial = linhas.some(r => r.data_lancamento.startsWith(competencia) && r.status === 'rascunho');
  const faltantes = INDICADORES_OBRIGATORIOS.filter(k => indicadores[k] == null);
  // Fonte externa é opcional: sua ausência/cobertura não bloqueia o fechamento iFood.
  const parcial = parcialFinanceiro || rascunhoOficial;
  const emAndamento = competencia >= hoje.slice(0,7);
  const completo = !faltantes.length && !parcial && !emAndamento;
  const hash = createHash('sha256').update(JSON.stringify({ indicadores, origens:campos.map(c => c.origem), parcial, financeiroAte:oficial.financeiroAte })).digest('hex');
  const revisao = manual?.status === 'fechado' && (manual.fechamento_hash !== hash || !completo);
  const status = revisao ? 'revisao_necessaria' : manual?.status === 'fechado' ? 'fechado' : emAndamento ? 'em_andamento' : completo ? 'completo' : 'incompleto';
  const avisos = [
    parcialFinanceiro ? `Financeiro parcial: último snapshot em ${oficial.financeiroAte}. Complete o mês na fonte oficial; o complemento não substitui esse valor.` : null,
    rascunhoOficial ? 'Há lançamentos oficiais em rascunho nesta competência.' : null,
    externos.aviso,
    revisao ? 'A fonte mudou após o fechamento. Revise e feche novamente.' : null,
    'Taxas de entregadores iFood já integram as despesas iFood. Custos externos são uma métrica separada e não são descontados novamente da retenção após iFood.',
  ].filter(Boolean);
  return { unidade:u, competencia, indicadores, campos, status, parcial, incompleto:!completo,
    completudePct:(INDICADORES_OBRIGATORIOS.length-faltantes.length)/INDICADORES_OBRIGATORIOS.length*100,
    obrigatorios:INDICADORES_OBRIGATORIOS, faltantes, financeiroAte:oficial.financeiroAte, avisos,
    versao:manual?.versao ?? 0, podeFechar:completo, fechadoEm:manual?.fechado_em ?? null,
    auditoria:manual ? { criadoEm:manual.criado_em, criadoPor:manual.criado_por, atualizadoEm:manual.atualizado_em, atualizadoPor:manual.atualizado_por, fechadoPor:manual.fechado_por } : null,
    hash, manual };
}
export function paraResposta(c) {
  const { manual, hash, ...publico } = c;
  return publico;
}
