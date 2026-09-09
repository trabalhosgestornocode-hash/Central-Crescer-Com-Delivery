import { ApiError } from '../../../shared/ApiError.js';
import { hojeIsoBrasil } from '../../dashboard-executivo/dashboardExecutivo.calc.js';
import { listarUnidadesElegiveis } from '../administrativo.repo.js';
import { configuracaoPerformance, CAMPOS } from './performance.config.js';
import { deslocarMes, consolidar, comparar, diagnosticar } from './performance.calc.js';
import { montarCompetencia, paraResposta } from './performance.competencia.js';
import { configuracaoMetas } from './performance.targets.js';
import { analisarSerie, compararUnidades, diagnosticoGeral } from './performance.analysis.js';
import { criarRepositorio } from './performance.repo.js';

function validarMes(m, hoje) {
  if (typeof m !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(m) || m > hoje.slice(0,7)) throw ApiError.badRequest('Competência inválida. Use AAAA-MM, sem mês futuro.');
  return m;
}
export function criarService(deps = {}) {
  const hoje = () => deps.hoje ?? hojeIsoBrasil();
  const config = deps.config ?? configuracaoPerformance();
  const metas = deps.metas ?? configuracaoMetas();
  const repo = deps.repo ?? criarRepositorio(deps);
  async function unidades() {
    const listar = deps.listarUnidadesElegiveis ?? listarUnidadesElegiveis;
    const elegiveis = (await listar({ moduloId:'ifood_dashboard' },deps)).filter(u => config.unidadeIds.includes(u.unidadeId));
    const parserIds = config.parserUnidadeIds ?? [];
    const comParser = parserIds.length ? await listar({ moduloId:'parser_food_delivery' },deps) : [];
    return elegiveis.map(u => ({ ...u, usaParser:parserIds.includes(u.unidadeId) && comParser.some(p => p.unidadeId === u.unidadeId) }));
  }
  async function alvo(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw ApiError.badRequest('Informe uma unidade válida.');
    const u = (await unidades()).find(u => u.unidadeId === id);
    if (!u) throw ApiError.forbidden('Unidade fora do escopo autorizado da Central de Performance.');
    return u;
  }
  async function abrir(id, competencia) {
    validarMes(competencia,hoje());
    const u = await alvo(id);
    return montarCompetencia(u,competencia,await repo.carregar(u,competencia,competencia),hoje());
  }
  async function salvar(id, competencia, body, ator) {
    if (!ator) throw ApiError.unauthorized();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('Corpo inválido.');
    if (Object.keys(body).some(k => !['versao','campos','acao'].includes(k))) throw ApiError.badRequest('Propriedade não permitida.');
    const { versao, campos = {}, acao = 'salvar' } = body;
    if (!Number.isInteger(versao) || versao < 0 || !['salvar','fechar','reabrir'].includes(acao) || !campos || typeof campos !== 'object' || Array.isArray(campos)) throw ApiError.badRequest('Versão, ação ou campos inválidos.');
    const atual = await abrir(id,competencia);
    if (atual.versao !== versao) throw new ApiError(409,'A competência mudou. Recarregue antes de salvar.');
    if (atual.manual?.status === 'fechado' && (acao === 'salvar' || Object.keys(campos).length)) throw new ApiError(409,'Reabra a competência antes de editar.');
    if (acao === 'reabrir' && (Object.keys(campos).length || atual.manual?.status !== 'fechado')) throw ApiError.badRequest('Reabertura exige uma competência fechada, sem edição de campos.');
    const patch = {};
    for (const [chave,valor] of Object.entries(campos)) {
      const def = CAMPOS[chave];
      if (!Object.hasOwn(CAMPOS,chave)) throw ApiError.badRequest(`Campo não complementar: ${chave}.`);
      if (!atual.campos.find(c => c.chave === chave)?.editavel) throw new ApiError(409,`${def.nome} possui fonte oficial e não pode ser sobrescrito.`);
      if (valor !== null && (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || valor > (def.tipo === 'percentual' ? 100 : def.tipo === 'inteiro' ? 2147483647 : 999999999999.99) || (def.tipo === 'inteiro' && !Number.isInteger(valor)))) throw ApiError.badRequest(`Valor inválido para ${def.nome}.`);
      const casas = def.tipo === 'percentual' ? 4 : def.tipo === 'inteiro' ? 0 : 2;
      patch[def.coluna] = valor == null ? null : Number(valor.toFixed(casas));
    }
    if (acao === 'salvar' && !Object.keys(patch).length) throw ApiError.badRequest('Nenhum complemento foi informado.');
    // Releitura antes de gravar, inclusive depois da edição: automático sempre prevalece.
    const dados = await repo.carregar(atual.unidade,competencia,competencia);
    const fresca = montarCompetencia(atual.unidade,competencia,dados,hoje());
    if (fresca.versao !== versao) throw new ApiError(409,'A competência mudou durante a edição.');
    for (const chave of Object.keys(campos)) if (!fresca.campos.find(c => c.chave === chave)?.editavel) throw new ApiError(409,'Uma fonte oficial ficou disponível. Recarregue a competência.');
    const candidata = { ...fresca.manual, ...patch, unidade_id:atual.unidade.unidadeId, organizacao_id:atual.unidade.organizacaoId, competencia:`${competencia}-01`, status:'rascunho' };
    const unificada = montarCompetencia(atual.unidade,competencia,{ ...dados, complementos:[candidata] },hoje());
    if (acao === 'fechar' && !unificada.podeFechar) throw new ApiError(409,'Competência incompleta, parcial ou em andamento. Complete e revise as fontes antes de fechar.');
    Object.assign(patch,{ status:acao === 'fechar' ? 'fechado':'rascunho', fechado_em:acao === 'fechar' ? new Date().toISOString():null, fechado_por:acao === 'fechar' ? ator:null, fechamento_hash:acao === 'fechar' ? unificada.hash:null });
    await repo.salvar(atual.unidade,competencia,fresca.manual,patch,ator);
    return paraResposta(await abrir(id,competencia));
  }
  async function listar(query = {}) {
    const inicio = validarMes(query.inicio ?? '2026-04',hoje());
    const fim = validarMes(query.fim ?? hoje().slice(0,7),hoje());
    const meses = [];
    for (let m = inicio; m <= fim && meses.length <= 24; m = deslocarMes(m,1)) meses.push(m);
    if (!meses.length || meses.length > 24) throw ApiError.badRequest('Selecione de 1 a 24 competências.');
    const disponiveis = await unidades();
    if (query.unidade_id && !disponiveis.some(u => u.unidadeId === query.unidade_id)) throw ApiError.forbidden('Unidade fora do escopo autorizado.');
    const alvos = query.unidade_id ? disponiveis.filter(u => u.unidadeId === query.unidade_id) : disponiveis;
    const competencias = [];
    const pontosAnteriores = [];
    for (const u of alvos) {
      const dados = await repo.carregar(u,deslocarMes(inicio,-meses.length),fim);
      const evolucao = meses.map(m => paraResposta(montarCompetencia(u,m,dados,hoje())));
      const anteriores = meses.map(m => montarCompetencia(u,deslocarMes(m,-meses.length),dados,hoje()));
      pontosAnteriores.push(...anteriores);
      const indicadores = consolidar(evolucao);
      const anterior = consolidar(anteriores);
      const analise = analisarSerie(evolucao, { metas });
      competencias.push({ unidade:u, evolucao, indicadores, variacoes:comparar(indicadores,anterior), diagnosticos:diagnosticar(indicadores,anterior,[...anteriores,...evolucao],config),
        tendencias:analise.tendencias, metas:analise.metas, status:analise.status, prioridades:analise.prioridades,
        diagnosticoGerencial:analise.diagnosticos, investigacao:analise.investigacao, resumo:analise.resumo, analise });
    }
    const consolidado = consolidar(competencias.flatMap(c => c.evolucao));
    // Série consolidada mês a mês para tendência/diagnóstico do agregado.
    const evolucaoConsolidada = meses.map((m,i) => ({ competencia:m, indicadores:consolidar(competencias.map(c => c.evolucao[i])),
      incompleto:competencias.some(c => c.evolucao[i].incompleto), parcial:competencias.some(c => c.evolucao[i].parcial),
      financeiroAte:competencias.map(c => c.evolucao[i].financeiroAte).filter(Boolean).sort()[0] ?? null }));
    const analiseConsolidada = analisarSerie(evolucaoConsolidada, { metas });
    const paraComparar = competencias.map(c => ({ nome:c.unidade.unidadeNome, indicadores:c.indicadores, analise:c.analise }));
    const comparativo = competencias.length > 1 ? compararUnidades(paraComparar) : { disponivel:false, motivo:'Selecione "Todas as unidades" para o comparativo gerencial.', destaques:{}, observacoes:[] };
    return { unidades:disponiveis, inicio,fim, periodo:{ inicio, fim, meses:meses.length },
      metas:{ conversaoMinima:metas.conversaoMinima, crescimentoMinimo:metas.crescimentoMinimo, crescimentoDesejado:metas.crescimentoDesejado },
      competencias, consolidado, variacoes:comparar(consolidado,consolidar(pontosAnteriores)),
      consolidadoAnalise:analiseConsolidada, comparativo, diagnosticoGeral:diagnosticoGeral(paraComparar, comparativo),
      qualidadeDados:analiseConsolidada.qualidade };
  }
  return { listar, unidades, abrir:async (...args) => paraResposta(await abrir(...args)), salvar };
}
