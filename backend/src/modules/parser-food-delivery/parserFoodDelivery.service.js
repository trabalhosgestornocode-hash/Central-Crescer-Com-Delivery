// Serviço central do Parser Food Delivery — import preview/confirm SEM
// estado no servidor (mesmo padrão de bonificacaoMensal.service.js): o
// frontend reenvia o arquivo em base64 a cada chamada, nada fica "em
// rascunho" no backend entre a prévia e a confirmação.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { lerRelatorio, decodificarArquivo } from "./parserFoodDelivery.parser.js";
import {
  classificarPedido, resumoConciliacao, agruparPorEntregador, chaveEntregador, validarCodigo, temEntregador,
  ehCancelado, classificacaoEfetivaCancelamento, resolverStatusConciliacao, STATUS_CONCILIACAO, somarResumosPeriodo,
  limitesDoMes, inicioMesSeguinte, resolverCandidatoPedido, explicarCancelamento,
} from "./parserFoodDelivery.calc.js";
import { classificarOperacao, OPERACAO, rotuloOperacao } from "./parserFoodDelivery.operacao.js";
import { classificarCancelamento, CLASSIFICACAO_CANCELAMENTO } from "./parserFoodDelivery.classificacao.js";

import { normalizarPeriodo, consolidarPedidosPeriodo, horaOperacional } from "./parserFoodDelivery.periodo.js";

const TABELA_IMPORT = "parser_fd_importacoes";
const TABELA_PEDIDOS = "parser_fd_pedidos";
const TABELA_AUDIT = "parser_fd_auditoria";
const BUCKET = "parser-food-delivery";

// Colunas de fato usadas por paraApiPedido()/paraApiPedidoIgnorado() (+ as 3
// datas de entrega, guardadas de propósito pra uma futura métrica de tempo
// médio — ver migration 037). De propósito SEM `dados_brutos`: é a linha
// original completa do relatório (auditoria, nunca lida de volta pela API) —
// um pedido de food delivery real chega a alguns KB de JSON cada; um
// relatório com centenas/milhares de pedidos multiplicava isso à toa em
// TODA visualização de uma importação (era a causa do carregamento lento ao
// abrir o Parser Food Delivery). Continua gravada no insert, só não é mais
// buscada de volta nas leituras — quem precisar dela de verdade, consulta o
// banco diretamente.
const COLUNAS_PEDIDO_LEITURA = [
  "id", "importacao_id", "numero_pedido", "data_hora", "situacao", "entregador",
  "taxa_entregador", "valor_total_pedido", "forma_pagamento", "razao_cancelamento",
  "justificativa_cancelamento", "data_entregue", "data_finalizado", "data_cancelado",
  "origem", "sem_taxa_informado", "status_conciliacao", "operacao", "operacao_motivo",
  "detalhes_pedido", "criado_em",
  // Timeline (motor de classificação de cancelamentos, ver
  // parserFoodDelivery.classificacao.js) + resultado da classificação
  // automática + override manual — colunas novas da reformulação.
  "data_pronto", "data_despachado", "data_aceito", "data_coletado", "data_chegada_entrega",
  "data_rejeitado", "razao_rejeicao", "justificativa_rejeicao",
  "classificacao_cancelamento", "classificacao_motivo", "classificacao_nivel_confianca", "classificacao_regra",
  "classificacao_original", "classificacao_override_usuario_nome", "classificacao_override_motivo", "classificacao_override_em",
].join(", ");

/** Number(x), mas preserva null/undefined — "não informado" nunca vira 0. */
const numOuNulo = (x) => (x == null ? null : Number(x));

const entregadoresParaApi = (pedidos) => agruparPorEntregador(pedidos)
  .map((e) => ({ ...e, chave: chaveEntregador(e.entregador) }))
  .sort((a, b) => b.taxasValidas - a.taxasValidas);

// Tamanho de página deliberadamente abaixo do limite padrão do PostgREST
// (`db.max_rows`, 1000 neste projeto) — nunca pedir num único .range() mais
// linhas do que o Supabase devolveria de qualquer forma, senão a paginação
// herdaria o mesmo truncamento silencioso que ela existe pra evitar.
const PAGINA_PEDIDOS = 500;

/**
 * Busca TODAS as linhas de parser_fd_pedidos de uma importação, paginando
 * explicitamente com `.range()`. Um `select()` sem paginação é truncado
 * silenciosamente em `db.max_rows` pelo PostgREST — sem erro, sem aviso.
 * Causa raiz real encontrada em produção (25/08/2026): uma importação com
 * 1330 pedidos aparecia com `taxasValidas` diferente na Visão Geral
 * (recalculada aqui, truncada em 1000 linhas) e no Histórico (calculada em
 * memória em `confirmarImportacao`, nunca lida de volta, por isso nunca
 * truncada). Toda leitura de pedidos de UMA importação inteira precisa
 * passar por aqui — nunca por um `.select()` direto na tabela.
 * Ordena por (data_hora, id) como critério de desempate estável: sem um
 * desempate determinístico, linhas com a mesma `data_hora` podem ser
 * puladas ou repetidas entre páginas.
 * @param {{importacaoId: string, colunas?: string}} p
 * @returns {Promise<object[]>} sempre um array (nunca null/undefined)
 */
async function buscarTodosPedidos({ importacaoId, colunas = COLUNAS_PEDIDO_LEITURA }) {
  const todos = [];
  for (let offset = 0; ; offset += PAGINA_PEDIDOS) {
    const { data, error } = await supabase.from(TABELA_PEDIDOS).select(colunas)
      .eq("importacao_id", importacaoId)
      .order("data_hora", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + PAGINA_PEDIDOS - 1);
    if (error) throw ApiError.internal(error.message);
    todos.push(...(data || []));
    if (!data || data.length < PAGINA_PEDIDOS) break;
  }
  return todos;
}

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — mesmo princípio do Dashboard iFood/Bonificação Mensal:
// nunca confia em unidadeId vindo do cliente sem checar contra a sessão.
// ---------------------------------------------------------------------------
async function resolverUnidade({ organizacaoId, unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acessar o Parser Food Delivery.");
  const { data: unidade, error } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade;
}

// ---------------------------------------------------------------------------
// MAPEAMENTO DB <-> API
// ---------------------------------------------------------------------------
function paraApiImportacao(row) {
  return {
    id: row.id, unidadeId: row.unidade_id,
    periodoInicio: row.periodo_inicio, periodoFim: row.periodo_fim,
    nomeArquivo: row.nome_arquivo,
    totalPedidos: row.total_pedidos,
    pedidosSubway: row.pedidos_subway, pedidosAcai: row.pedidos_acai, pedidosRevisao: row.pedidos_revisao,
    pedidosSemEntregador: row.pedidos_sem_entregador,
    colunaDetalhesEncontrada: row.coluna_detalhes_encontrada,
    entregues: row.entregues, cancelados: row.cancelados,
    canceladosComTaxa: row.cancelados_com_taxa, canceladosSemTaxa: row.cancelados_sem_taxa,
    canceladosRecebemTaxa: row.cancelados_recebem_taxa, canceladosNaoRecebemTaxa: row.cancelados_nao_recebem_taxa, canceladosRevisao: row.cancelados_revisao,
    taxasBrutas: numOuNulo(row.taxas_brutas), taxasDescartadas: numOuNulo(row.taxas_descartadas), taxasValidas: numOuNulo(row.taxas_validas),
    codigosSemTaxa: row.codigos_sem_taxa || [],
    status: row.status, mensagemErro: row.mensagem_erro,
    usuarioNome: row.usuario_nome, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
  };
}

/** Aceita tanto uma linha do banco (status_conciliacao) quanto um pedido recém-classificado (statusConciliacao). */
function paraApiPedido(row) {
  return {
    id: row.id ?? null, importacaoId: row.importacao_id ?? row.importacaoId ?? null, numeroPedido: row.numero_pedido ?? row.numeroPedido, dataHora: horaOperacional(row.data_hora ?? row.dataHora),
    situacao: row.situacao, cancelado: ehCancelado(row.situacao), entregador: row.entregador,
    entregadorChave: chaveEntregador(row.entregador),
    taxaEntregador: numOuNulo(row.taxa_entregador ?? row.taxaEntregador),
    valorTotalPedido: numOuNulo(row.valor_total_pedido ?? row.valorTotalPedido),
    formaPagamento: row.forma_pagamento ?? row.formaPagamento,
    razaoCancelamento: row.razao_cancelamento ?? row.razaoCancelamento,
    justificativaCancelamento: row.justificativa_cancelamento ?? row.justificativaCancelamento,
    origem: row.origem,
    detalhesPedido: row.detalhes_pedido ?? row.detalhesPedido ?? null,
    operacao: row.operacao ?? OPERACAO.SUBWAY,
    operacaoMotivo: row.operacao_motivo ?? row.operacaoMotivo ?? null,
    semTaxaInformado: row.semTaxaInformado ?? !!row.sem_taxa_informado,
    statusConciliacao: row.statusConciliacao ?? row.status_conciliacao ?? null,
    // Timeline do pedido (item 14 — motor de classificação + timeline visual
    // da aba Cancelamentos). Ausente em relatórios antigos: fica null.
    dataPronto: horaOperacional(row.data_pronto ?? row.dataPronto),
    dataDespachado: horaOperacional(row.data_despachado ?? row.dataDespachado),
    dataAceito: horaOperacional(row.data_aceito ?? row.dataAceito),
    dataColetado: horaOperacional(row.data_coletado ?? row.dataColetado),
    dataChegadaEntrega: horaOperacional(row.data_chegada_entrega ?? row.dataChegadaEntrega),
    dataEntregue: horaOperacional(row.data_entregue ?? row.dataEntregue),
    dataFinalizado: horaOperacional(row.data_finalizado ?? row.dataFinalizado),
    dataCancelado: horaOperacional(row.data_cancelado ?? row.dataCancelado),
    dataRejeitado: horaOperacional(row.data_rejeitado ?? row.dataRejeitado),
    razaoRejeicao: row.razao_rejeicao ?? row.razaoRejeicao ?? null,
    justificativaRejeicao: row.justificativa_rejeicao ?? row.justificativaRejeicao ?? null,
    // Classificação automática do cancelamento + override manual (seção 29).
    classificacaoCancelamento: row.classificacao_cancelamento ?? row.classificacaoCancelamento ?? null,
    classificacaoEfetiva: classificacaoEfetivaCancelamento({ situacao: row.situacao,
      statusConciliacao: row.statusConciliacao ?? row.status_conciliacao,
      classificacaoCancelamento: row.classificacao_cancelamento ?? row.classificacaoCancelamento,
      classificacaoOverrideEm: row.classificacao_override_em ?? row.classificacaoOverrideEm }),
    classificacaoMotivo: row.classificacao_motivo ?? row.classificacaoMotivo ?? null,
    classificacaoNivelConfianca: row.classificacao_nivel_confianca ?? row.classificacaoNivelConfianca ?? null,
    classificacaoRegra: row.classificacao_regra ?? row.classificacaoRegra ?? null,
    classificacaoOriginal: row.classificacao_original ?? row.classificacaoOriginal ?? null,
    classificacaoOverrideUsuarioNome: row.classificacao_override_usuario_nome ?? null,
    classificacaoOverrideMotivo: row.classificacao_override_motivo ?? null,
    classificacaoOverrideEm: row.classificacao_override_em ?? null,
  };
}

/** Só entra na conciliação/cálculos/entregadores: Subway E com entregador atribuído. */
const ehElegivelConciliacao = (p) => p.operacao === OPERACAO.SUBWAY && temEntregador(p.entregador);

/**
 * Pedido "ignorado" (fora da conciliação) sempre por UM de dois motivos:
 * outra operação, ou Subway sem entregador atribuído. Unifica os dois numa
 * única forma de exibição pra "Ver pedidos ignorados" — a razão de cada um
 * fica clara sem precisar duas telas diferentes.
 */
function paraApiPedidoIgnorado(p) {
  const base = paraApiPedido(p);
  if (base.operacao !== OPERACAO.SUBWAY) {
    return { ...base, classificacaoIgnorado: rotuloOperacao(base.operacao), motivoIgnorado: base.operacaoMotivo };
  }
  return {
    ...base, classificacaoIgnorado: "Sem entregador",
    motivoIgnorado: "Pedido sem nome de entregador atribuído — não entra na conciliação nem nos valores financeiros.",
  };
}

const fmtDataHoraBr = (iso) => { try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; } };

function contarPorSituacao(pedidos) {
  const contagem = {};
  for (const p of pedidos) { const chave = p.situacao || "—"; contagem[chave] = (contagem[chave] || 0) + 1; }
  return contagem;
}

// ---------------------------------------------------------------------------
// IDENTIFICAÇÃO DA OPERAÇÃO — camada única (parserFoodDelivery.operacao.js).
// Roda logo depois do parsing e ANTES de qualquer cálculo — ordem obrigatória
// do pedido: Arquivo bruto -> Identificação da operação -> Remover Açaí ->
// Pedidos válidos Subway -> Conciliação -> Cálculos -> Entregadores. Nunca
// calcular primeiro e filtrar depois.
// ---------------------------------------------------------------------------
function classificarOperacoes(pedidos, colunaDetalhesEncontrada) {
  if (!colunaDetalhesEncontrada) {
    // Sem a coluna "Detalhes do pedido" não dá pra separar por operação —
    // melhor avisar (colunaDetalhesEncontrada=false na resposta) do que
    // fingir certeza jogando tudo em "revisão necessária".
    return pedidos.map((p) => ({ ...p, operacao: OPERACAO.SUBWAY, operacaoMotivo: null }));
  }
  return pedidos.map((p) => {
    const r = classificarOperacao(p);
    return { ...p, operacao: r.operacao, operacaoMotivo: r.motivo };
  });
}

/**
 * Classifica UM pedido já elegível (Subway + com entregador) com o motor
 * automático de cancelamentos (parserFoodDelivery.classificacao.js) — a
 * fonte PRIMÁRIA da decisão desde a reformulação. `codigosSemTaxa` continua
 * aceito só por compatibilidade com o mecanismo manual antigo: se o código
 * do pedido está na lista, ele sempre vence sobre a decisão automática
 * (usado hoje só pelo endpoint legado `editarCodigosSemTaxa`/importações
 * feitas antes desta reformulação — o wizard novo nunca envia códigos).
 * Pedido não cancelado nem passa pelo motor: sempre incluído.
 * @param {object} p pedido já com operação resolvida
 * @param {Set<string>} codigosSemTaxa
 */
function classificarComMotor(p, codigosSemTaxa) {
  if (!ehCancelado(p.situacao)) {
    return { ...p, statusConciliacao: STATUS_CONCILIACAO.INCLUIDO, semTaxaInformado: false, classificacaoCancelamento: null, classificacaoMotivo: null, classificacaoNivelConfianca: null, classificacaoRegra: null };
  }
  const r = classificarCancelamento(p);
  const semTaxaManual = codigosSemTaxa.has(p.numeroPedido);
  const statusConciliacao = semTaxaManual ? STATUS_CONCILIACAO.EXCLUIDO : resolverStatusConciliacao(r.classificacao);
  return {
    ...p, statusConciliacao, semTaxaInformado: semTaxaManual,
    classificacaoCancelamento: r.classificacao, classificacaoMotivo: r.motivo,
    classificacaoNivelConfianca: r.nivelConfianca, classificacaoRegra: r.regra,
  };
}

/**
 * `subway` aqui já é só quem REALMENTE entra na conciliação (Subway + com
 * entregador) — `semEntregador` é o contador à parte de quem é Subway mas
 * ficou de fora só por falta de entregador (item novo do pedido).
 */
function resumoFiltragem(pedidosComOperacao) {
  const subwayTodos = pedidosComOperacao.filter((p) => p.operacao === OPERACAO.SUBWAY);
  const semEntregador = subwayTodos.filter((p) => !temEntregador(p.entregador));
  return {
    subway: subwayTodos.length - semEntregador.length,
    semEntregador: semEntregador.length,
    acaiNoGrau: pedidosComOperacao.filter((p) => p.operacao === OPERACAO.ACAI_NO_GRAU).length,
    revisaoNecessaria: pedidosComOperacao.filter((p) => p.operacao === OPERACAO.REVISAO_NECESSARIA).length,
  };
}

// ---------------------------------------------------------------------------
// PASSO 1 — só lê e valida o arquivo (item 1 do pedido: formato/período/qtd).
// ---------------------------------------------------------------------------
export async function previewArquivo({ organizacaoId, unidadeId, arquivo }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);
  const pedidosComOperacao = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    nomeArquivo: relatorio.nomeArquivo, hash: relatorio.hash,
    periodoInicio: relatorio.periodoInicio, periodoFim: relatorio.periodoFim, periodoDetectado: relatorio.periodoDetectado,
    totalPedidos: relatorio.pedidos.length, porSituacao: contarPorSituacao(relatorio.pedidos),
    colunasEncontradas: relatorio.colunasEncontradas,
    colunaDetalhesEncontrada: relatorio.colunaDetalhesEncontrada,
    filtragem: resumoFiltragem(pedidosComOperacao),
  };
}

async function avisosDuplicidade({ unidadeId, hash, periodoInicio, periodoFim }) {
  const { data: porHash } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, criado_em")
    .eq("unidade_id", unidadeId).eq("hash_arquivo", hash).eq("status", "concluida").maybeSingle();

  let periodosSobrepostos = [];
  if (periodoInicio && periodoFim) {
    const { data } = await supabase.from(TABELA_IMPORT).select("id, periodo_inicio, periodo_fim, nome_arquivo")
      .eq("unidade_id", unidadeId).eq("status", "concluida")
      .lte("periodo_inicio", periodoFim).gte("periodo_fim", periodoInicio);
    periodosSobrepostos = (data || []).map((r) => ({ id: r.id, periodoInicio: r.periodo_inicio, periodoFim: r.periodo_fim, nomeArquivo: r.nome_arquivo }));
  }
  return {
    hashDuplicado: porHash ? { id: porHash.id, nomeArquivo: porHash.nome_arquivo, criadoEm: porHash.criado_em } : null,
    periodosSobrepostos,
  };
}

// ---------------------------------------------------------------------------
// PASSO 2/3 — reparseia + classifica com os códigos "sem taxa" informados.
// Chamado a cada mudança na lista de códigos (idempotente, nunca salva).
// ---------------------------------------------------------------------------
export async function conciliarPreview({ organizacaoId, unidadeId, arquivo, codigosSemTaxa = [], periodoInicioManual, periodoFimManual }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);

  const periodoInicio = relatorio.periodoInicio || v.dataOpcional(periodoInicioManual, "Período inicial");
  const periodoFim = relatorio.periodoFim || v.dataOpcional(periodoFimManual, "Período final");

  // Identificação da operação -> remoção do que não é Subway -> remoção de
  // quem não tem entregador atribuído -> só então "pedidos válidos" entram
  // na conciliação/cálculo/entregadores (ordem obrigatória do pedido).
  const todosPedidos = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  const pedidosElegiveis = todosPedidos.filter(ehElegivelConciliacao);
  const pedidosIgnorados = todosPedidos.filter((p) => !ehElegivelConciliacao(p));

  const codigosSet = new Set((codigosSemTaxa || []).map((c) => String(c).trim()).filter(Boolean));
  // Validação do código contra TODOS os pedidos (não só os elegíveis) — só
  // assim dá pra avisar "este código é de outra operação"/"sem entregador"
  // em vez de "não encontrado".
  const pedidosPorNumero = new Map(todosPedidos.map((p) => [p.numeroPedido, p]));
  const validacaoCodigos = [...codigosSet].map((c) => validarCodigo(c, pedidosPorNumero));

  // Conciliação + cálculos de taxas + desempenho dos entregadores: só nos
  // pedidos elegíveis (Subway + com entregador). A decisão de cada
  // cancelamento vem do motor automático (classificarComMotor) — códigos
  // digitados manualmente (`codigosSet`) continuam funcionando como
  // override de compatibilidade, mas o wizard novo nunca os envia.
  const classificados = pedidosElegiveis.map((p) => classificarComMotor(p, codigosSet));
  const resumo = resumoConciliacao(classificados);
  const entregadores = entregadoresParaApi(classificados);
  const avisos = await avisosDuplicidade({ unidadeId, hash: relatorio.hash, periodoInicio, periodoFim });

  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    nomeArquivo: relatorio.nomeArquivo, hash: relatorio.hash,
    periodoInicio, periodoFim, periodoDetectado: relatorio.periodoDetectado,
    colunaDetalhesEncontrada: relatorio.colunaDetalhesEncontrada,
    filtragem: resumoFiltragem(todosPedidos),
    codigosSemTaxa: [...codigosSet], validacaoCodigos,
    resumo, entregadores,
    pedidos: classificados.map(paraApiPedido),
    pedidosIgnorados: pedidosIgnorados.map(paraApiPedidoIgnorado),
    avisos,
  };
}

async function uploadOriginal({ buf, unidadeId, hash, nomeArquivo }) {
  const nome = String(nomeArquivo || "relatorio.xlsx").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${unidadeId}/${String(hash || "").slice(0, 10)}-${nome}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: "application/octet-stream", upsert: true });
  if (error) { console.warn("[parser-food-delivery] storage:", error.message, "— importação segue sem o arquivo original."); return null; }
  return path;
}

async function registrarAuditoria({
  importacaoId, organizacaoId, unidadeId, acao, codigosAntes = null, codigosDepois = null,
  taxasValidasAntes = null, taxasValidasDepois = null, motivo = null, snapshot = null, usuario,
  pedidoId = null, numeroPedido = null, classificacaoAntes = null, classificacaoDepois = null,
}) {
  const { error } = await supabase.from(TABELA_AUDIT).insert({
    importacao_id: importacaoId, organizacao_id: organizacaoId, unidade_id: unidadeId, acao,
    codigos_antes: codigosAntes, codigos_depois: codigosDepois,
    taxas_validas_antes: taxasValidasAntes, taxas_validas_depois: taxasValidasDepois,
    motivo, snapshot, pedido_id: pedidoId, numero_pedido: numeroPedido,
    classificacao_antes: classificacaoAntes, classificacao_depois: classificacaoDepois,
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
  });
  if (error) console.error("[parser-food-delivery] falha ao registrar auditoria:", error.message);
}

async function inserirPedidosEmLotes(linhas) {
  const TAM = 500;
  for (let i = 0; i < linhas.length; i += TAM) {
    const { error } = await supabase.from(TABELA_PEDIDOS).insert(linhas.slice(i, i + TAM));
    if (error) {
      // "N Pedido" pode se repetir dentro do mesmo relatório (visto em produção) —
      // a unicidade errada foi removida na migration 040. Se este erro ainda
      // aparecer, é porque a migration não foi aplicada nesta base.
      if (String(error.message).toLowerCase().includes("uq_pfdped_importacao_pedido")) {
        throw ApiError.badRequest("Este relatório tem códigos de pedido repetidos, e o banco ainda não está atualizado pra aceitar isso — aplique a migration 040_parser_fd_remove_unique_pedido.sql no Supabase e tente novamente.");
      }
      throw ApiError.internal(`Falha ao gravar pedidos: ${error.message}`);
    }
  }
}

const timestampPersistido = (valor) => valor ? `${horaOperacional(valor)}Z` : null;

function paraLinhaPedido(p, { importacaoId, organizacaoId, unidadeId }) {
  return {
    importacao_id: importacaoId, organizacao_id: organizacaoId, unidade_id: unidadeId,
    numero_pedido: p.numeroPedido, data_hora: timestampPersistido(p.dataHora), situacao: p.situacao, entregador: p.entregador,
    taxa_entregador: p.taxaEntregador, valor_total_pedido: p.valorTotalPedido, forma_pagamento: p.formaPagamento,
    razao_cancelamento: p.razaoCancelamento, justificativa_cancelamento: p.justificativaCancelamento,
    data_entregue: timestampPersistido(p.dataEntregue), data_finalizado: timestampPersistido(p.dataFinalizado), data_cancelado: timestampPersistido(p.dataCancelado),
    origem: p.origem, sem_taxa_informado: p.semTaxaInformado, status_conciliacao: p.statusConciliacao ?? null,
    operacao: p.operacao, operacao_motivo: p.operacaoMotivo, detalhes_pedido: p.detalhesPedido,
    dados_brutos: p.dadosBrutos,
    // Timeline lida do relatório (motor de classificação de cancelamentos).
    data_pronto: timestampPersistido(p.dataPronto), data_despachado: timestampPersistido(p.dataDespachado), data_aceito: timestampPersistido(p.dataAceito),
    data_coletado: timestampPersistido(p.dataColetado), data_chegada_entrega: timestampPersistido(p.dataChegadaEntrega),
    data_rejeitado: timestampPersistido(p.dataRejeitado), razao_rejeicao: p.razaoRejeicao ?? null, justificativa_rejeicao: p.justificativaRejeicao ?? null,
    // Resultado da classificação automática — `classificacao_original` é o
    // snapshot congelado no momento do import, nunca sobrescrito por um
    // override manual posterior (auditoria: sempre dá pra ver o que o motor
    // decidiu originalmente).
    classificacao_cancelamento: p.classificacaoCancelamento ?? null, classificacao_motivo: p.classificacaoMotivo ?? null,
    classificacao_nivel_confianca: p.classificacaoNivelConfianca ?? null, classificacao_regra: p.classificacaoRegra ?? null,
    classificacao_original: p.classificacaoCancelamento ?? null,
  };
}

// ---------------------------------------------------------------------------
// CONFIRMAÇÃO — persiste importação + pedidos + arquivo original + auditoria.
// Bloqueia reimportar o MESMO arquivo (mesmo hash) para a mesma unidade.
// ---------------------------------------------------------------------------
export async function confirmarImportacao({ organizacaoId, unidadeId, usuario, arquivo, codigosSemTaxa = [], periodoInicioManual, periodoFimManual }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);

  const periodoInicio = relatorio.periodoInicio || v.dataOpcional(periodoInicioManual, "Período inicial");
  const periodoFim = relatorio.periodoFim || v.dataOpcional(periodoFimManual, "Período final");
  if (!periodoInicio || !periodoFim) {
    throw ApiError.badRequest("Não consegui determinar o período deste relatório automaticamente. Informe o período inicial e final antes de confirmar.");
  }

  const { data: existente } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, criado_em")
    .eq("unidade_id", unidadeId).eq("hash_arquivo", relatorio.hash).eq("status", "concluida").maybeSingle();
  if (existente) {
    throw ApiError.badRequest(`Este arquivo já foi importado (${existente.nome_arquivo || "importação"}, em ${fmtDataHoraBr(existente.criado_em)}). Para corrigir os códigos "cancelado sem taxa", edite a importação já salva em vez de reenviar o arquivo.`);
  }

  // Identificação da operação -> remoção do que não é Subway -> remoção de
  // quem não tem entregador atribuído -> só então conciliar/calcular/persistir
  // (ordem obrigatória do pedido).
  const todosPedidos = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  const codigosSet = new Set((codigosSemTaxa || []).map((c) => String(c).trim()).filter(Boolean));
  const pedidosProcessados = todosPedidos.map((p) => (ehElegivelConciliacao(p)
    ? classificarComMotor(p, codigosSet)
    : { ...p, statusConciliacao: null, semTaxaInformado: false, classificacaoCancelamento: null, classificacaoMotivo: null, classificacaoNivelConfianca: null, classificacaoRegra: null }));
  const pedidosElegiveis = pedidosProcessados.filter(ehElegivelConciliacao);
  const filtragem = resumoFiltragem(pedidosProcessados);
  const resumo = resumoConciliacao(pedidosElegiveis);

  const storage = await uploadOriginal({ buf, unidadeId, hash: relatorio.hash, nomeArquivo: arquivo?.nomeArquivo });

  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    periodo_inicio: periodoInicio, periodo_fim: periodoFim,
    nome_arquivo: arquivo?.nomeArquivo || null, hash_arquivo: relatorio.hash, arquivo_storage: storage,
    total_pedidos: pedidosProcessados.length,
    pedidos_subway: filtragem.subway, pedidos_acai: filtragem.acaiNoGrau, pedidos_revisao: filtragem.revisaoNecessaria,
    pedidos_sem_entregador: filtragem.semEntregador,
    coluna_detalhes_encontrada: relatorio.colunaDetalhesEncontrada,
    entregues: resumo.entregues, cancelados: resumo.cancelados,
    cancelados_com_taxa: resumo.canceladosComTaxa, cancelados_sem_taxa: resumo.canceladosSemTaxa,
    cancelados_recebem_taxa: resumo.canceladosRecebemTaxa, cancelados_nao_recebem_taxa: resumo.canceladosNaoRecebemTaxa, cancelados_revisao: resumo.canceladosRevisao,
    taxas_brutas: resumo.taxasBrutas, taxas_descartadas: resumo.taxasDescartadas, taxas_validas: resumo.taxasValidas,
    codigos_sem_taxa: [...codigosSet], status: "erro",
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
  }).select("*").single();
  if (error) {
    if (String(error.message).toLowerCase().includes("uq_pfdimp_hash")) {
      throw ApiError.badRequest("Este arquivo já foi importado anteriormente para esta unidade.");
    }
    throw ApiError.badRequest(error.message);
  }

  await inserirPedidosEmLotes(pedidosProcessados.map((p) => paraLinhaPedido(p, { importacaoId: importacao.id, organizacaoId, unidadeId })));
  await registrarAuditoria({
    importacaoId: importacao.id, organizacaoId, unidadeId, acao: "importacao_criada",
    codigosDepois: [...codigosSet], taxasValidasDepois: resumo.taxasValidas, usuario,
  });

  const { error: erroConclusao } = await supabase.from(TABELA_IMPORT)
    .update({ status: "concluida" }).eq("id", importacao.id)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId);
  if (erroConclusao) throw ApiError.internal(erroConclusao.message);
  return obterImportacao({ organizacaoId, unidadeId, importacaoId: importacao.id });
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
export async function listarImportacoes({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(200);
  if (error) throw ApiError.internal(error.message);
  return (data || []).map(paraApiImportacao);
}

export async function obterImportacao({ organizacaoId, unidadeId, importacaoId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const pedidosRows = await buscarTodosPedidos({ importacaoId });

  const todosPedidos = pedidosRows.map(paraApiPedido);
  const pedidos = todosPedidos.filter(ehElegivelConciliacao);
  const pedidosIgnorados = todosPedidos.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado);
  const resumo = resumoConciliacao(pedidos);
  const entregadores = entregadoresParaApi(pedidos);
  return { importacao: paraApiImportacao(importacao), resumo, pedidos, pedidosIgnorados, entregadores };
}

export async function arquivoOriginal({ organizacaoId, unidadeId, importacaoId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: imp } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, arquivo_storage").eq("unidade_id", unidadeId).eq("id", importacaoId).maybeSingle();
  if (!imp) throw ApiError.notFound("Importação não encontrada.");
  if (!imp.arquivo_storage) throw ApiError.notFound("Esta importação não tem o arquivo original guardado.");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(imp.arquivo_storage, 3600);
  if (error) throw ApiError.internal("Falha ao gerar o link do arquivo: " + error.message);
  return { url: data.signedUrl, nomeArquivo: imp.nome_arquivo };
}

// ---------------------------------------------------------------------------
// EDIÇÃO DOS CÓDIGOS "SEM TAXA" DE UMA IMPORTAÇÃO JÁ SALVA (item 13 —
// alteração posterior sempre registrada em auditoria, antes/depois).
// ---------------------------------------------------------------------------
export async function editarCodigosSemTaxa({ organizacaoId, unidadeId, importacaoId, novosCodigos, usuario }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidade.id).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const pedidosRows = await buscarTodosPedidos({ importacaoId });

  const codigosAntes = importacao.codigos_sem_taxa || [];
  const codigosDepois = [...new Set((novosCodigos || []).map((c) => String(c).trim()).filter(Boolean))];
  const codigosSet = new Set(codigosDepois);

  // Só recalcula pedidos elegíveis (Subway + com entregador) — os demais
  // (outra operação, ou sem entregador) nunca entraram na conciliação e
  // continuam de fora dela (status_conciliacao permanece null, mesmo
  // espírito do pipeline de import).
  const classificados = (pedidosRows || []).map((row) => {
    if (!ehElegivelConciliacao(row)) return { ...row, statusConciliacao: null, semTaxaInformado: false };
    const statusConciliacao = classificarPedido({ numeroPedido: row.numero_pedido, situacao: row.situacao }, codigosSet);
    return { ...row, statusConciliacao, semTaxaInformado: codigosSet.has(row.numero_pedido) };
  });

  const alterados = classificados.filter((p) => ehElegivelConciliacao(p)
    && (p.statusConciliacao !== p.status_conciliacao || p.semTaxaInformado !== p.sem_taxa_informado));
  for (const p of alterados) {
    const { error: eUp } = await supabase.from(TABELA_PEDIDOS)
      .update({ status_conciliacao: p.statusConciliacao, sem_taxa_informado: p.semTaxaInformado }).eq("id", p.id);
    if (eUp) throw ApiError.internal(`Falha ao atualizar pedido ${p.numero_pedido}: ${eUp.message}`);
  }

  const resumo = resumoConciliacao(classificados.filter(ehElegivelConciliacao).map((p) => ({
    situacao: p.situacao, taxaEntregador: numOuNulo(p.taxa_entregador), statusConciliacao: p.statusConciliacao,
    classificacaoCancelamento: p.classificacao_cancelamento ?? null,
  })));

  const { data: salvo, error: eImp } = await supabase.from(TABELA_IMPORT).update({
    codigos_sem_taxa: codigosDepois,
    entregues: resumo.entregues, cancelados: resumo.cancelados,
    cancelados_com_taxa: resumo.canceladosComTaxa, cancelados_sem_taxa: resumo.canceladosSemTaxa,
    cancelados_recebem_taxa: resumo.canceladosRecebemTaxa, cancelados_nao_recebem_taxa: resumo.canceladosNaoRecebemTaxa, cancelados_revisao: resumo.canceladosRevisao,
    taxas_brutas: resumo.taxasBrutas, taxas_descartadas: resumo.taxasDescartadas, taxas_validas: resumo.taxasValidas,
  }).eq("id", importacaoId).select("*").single();
  if (eImp) throw ApiError.badRequest(eImp.message);

  await registrarAuditoria({
    importacaoId, organizacaoId, unidadeId: unidade.id, acao: "codigos_alterados",
    codigosAntes, codigosDepois, taxasValidasAntes: numOuNulo(importacao.taxas_validas), taxasValidasDepois: resumo.taxasValidas, usuario,
  });

  // `classificados` ainda tem o formato bruto do banco (taxa_entregador, não
  // taxaEntregador) — agruparPorEntregador precisa do formato da API, senão
  // soma sempre 0 de taxa (bug real já visto em produção). Mapeia uma vez e
  // reaproveita tanto no agrupamento quanto no retorno de pedidos.
  const pedidosApi = classificados.map(paraApiPedido);
  const pedidosElegiveisApi = pedidosApi.filter(ehElegivelConciliacao);
  const pedidosIgnoradosApi = pedidosApi.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado);
  const entregadores = entregadoresParaApi(pedidosElegiveisApi);
  return { importacao: paraApiImportacao(salvo), resumo, entregadores, pedidos: pedidosElegiveisApi, pedidosIgnorados: pedidosIgnoradosApi };
}

// ---------------------------------------------------------------------------
// ALTERAÇÃO MANUAL DE UMA CLASSIFICAÇÃO AUTOMÁTICA (item 29 — sempre com
// motivo obrigatório, sempre preservando o que o motor decidiu originalmente
// em `classificacao_cancelamento`/`classificacao_original`, nunca sobrescrito
// aqui). REVISAR não é um destino válido de override — o override serve
// exatamente pra RESOLVER um REVISAR (ou corrigir um recebe/não recebe) para
// uma das duas decisões financeiras finais.
// ---------------------------------------------------------------------------
export async function alterarClassificacaoCancelamento({ organizacaoId, unidadeId, importacaoId, pedidoId, classificacaoFinal, motivo: motivoRaw, usuario }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  if (![CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA, CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA].includes(classificacaoFinal)) {
    throw ApiError.badRequest('Classificação inválida — informe "recebe_taxa" ou "nao_recebe_taxa".');
  }
  const motivo = v.texto(motivoRaw, "Motivo da alteração", { min: 3, max: 500 });

  const { data: importacao, error: eImp } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidade.id).eq("id", importacaoId).maybeSingle();
  if (eImp) throw ApiError.internal(eImp.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const { data: pedido, error: ePed } = await supabase.from(TABELA_PEDIDOS).select(COLUNAS_PEDIDO_LEITURA).eq("id", pedidoId).eq("importacao_id", importacaoId).maybeSingle();
  if (ePed) throw ApiError.internal(ePed.message);
  if (!pedido) throw ApiError.notFound("Pedido não encontrado nesta importação.");
  if (!ehCancelado(pedido.situacao)) throw ApiError.badRequest("Só é possível alterar a classificação de pedidos cancelados.");
  if (!temEntregador(pedido.entregador)) throw ApiError.badRequest("Este pedido não tem entregador atribuído — não faz parte da conciliação.");

  const classificacaoAntes = pedido.status_conciliacao;
  const statusConciliacao = resolverStatusConciliacao(classificacaoFinal);

  const { error: eUp } = await supabase.from(TABELA_PEDIDOS).update({
    status_conciliacao: statusConciliacao,
    classificacao_override_usuario_id: usuario?.id || null, classificacao_override_usuario_nome: usuario?.nome || null,
    classificacao_override_usuario_email: usuario?.email || null, classificacao_override_motivo: motivo,
    classificacao_override_em: new Date().toISOString(),
  }).eq("id", pedidoId);
  if (eUp) throw ApiError.internal(`Falha ao alterar classificação: ${eUp.message}`);

  await registrarAuditoria({
    importacaoId, organizacaoId, unidadeId: unidade.id, acao: "classificacao_alterada",
    pedidoId, numeroPedido: pedido.numero_pedido, classificacaoAntes, classificacaoDepois: statusConciliacao,
    taxasValidasAntes: numOuNulo(importacao.taxas_validas), motivo, usuario,
  });

  // Recalcula o resumo da importação inteira (mesma técnica de editarCodigosSemTaxa).
  const pedidosRows = await buscarTodosPedidos({ importacaoId });
  const pedidosApi = pedidosRows.map(paraApiPedido);
  const pedidosElegiveisApi = pedidosApi.filter(ehElegivelConciliacao);
  const pedidosIgnoradosApi = pedidosApi.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado);
  const resumo = resumoConciliacao(pedidosElegiveisApi);
  const entregadores = entregadoresParaApi(pedidosElegiveisApi);

  const { data: salvo, error: eImp2 } = await supabase.from(TABELA_IMPORT).update({
    entregues: resumo.entregues, cancelados: resumo.cancelados,
    cancelados_com_taxa: resumo.canceladosComTaxa, cancelados_sem_taxa: resumo.canceladosSemTaxa,
    cancelados_recebem_taxa: resumo.canceladosRecebemTaxa, cancelados_nao_recebem_taxa: resumo.canceladosNaoRecebemTaxa, cancelados_revisao: resumo.canceladosRevisao,
    taxas_brutas: resumo.taxasBrutas, taxas_descartadas: resumo.taxasDescartadas, taxas_validas: resumo.taxasValidas,
  }).eq("id", importacaoId).select("*").single();
  if (eImp2) throw ApiError.badRequest(eImp2.message);

  return { importacao: paraApiImportacao(salvo), resumo, entregadores, pedidos: pedidosElegiveisApi, pedidosIgnorados: pedidosIgnoradosApi };
}

// ---------------------------------------------------------------------------
// EXCLUSÃO — sempre com motivo + snapshot ANTES de apagar (mesmo padrão de
// bonificacaoMensal.service.js#excluirLancamento). Libera o hash para
// reimportação (o arquivo apagado deixa de "existir" para efeito de duplicidade).
// ---------------------------------------------------------------------------
export async function excluirImportacao({ organizacaoId, unidadeId, importacaoId, motivo: motivoRaw, usuario }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidade.id).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const { data: pedidosRows } = await supabase.from(TABELA_PEDIDOS)
    .select("numero_pedido, situacao, entregador, taxa_entregador, status_conciliacao, operacao").eq("importacao_id", importacaoId);

  await registrarAuditoria({
    importacaoId, organizacaoId, unidadeId: unidade.id, acao: "excluida", motivo,
    codigosAntes: importacao.codigos_sem_taxa, taxasValidasAntes: numOuNulo(importacao.taxas_validas),
    snapshot: { importacao, pedidos: pedidosRows || [] }, usuario,
  });

  if (importacao.arquivo_storage) {
    const { error: eStorage } = await supabase.storage.from(BUCKET).remove([importacao.arquivo_storage]);
    if (eStorage) console.error("[parser-food-delivery] falha ao remover arquivo do storage:", eStorage.message);
  }

  // parser_fd_pedidos cai em cascata (FK on delete cascade) — sem passo manual.
  const { error: eDel } = await supabase.from(TABELA_IMPORT).delete().eq("id", importacaoId);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { excluido: true, importacaoId };
}

// ---------------------------------------------------------------------------
// AGENTE CRESCER (Etapa D) — leitura agregada/pontual para as tools do
// agente. Nenhuma reclassificação aqui: a decisão de cada cancelamento já
// foi tomada pelo motor determinístico (classificacao.js) no momento da
// importação — estas funções só leem/somam/filtram o que já existe.
// ---------------------------------------------------------------------------

/**
 * Resumo AGREGADO de cancelamentos/taxas de um MÊS inteiro — soma os
 * resumos já calculados de todas as importações CONCLUÍDAS cujo período de
 * referência está TOTALMENTE contido no mês pedido (decisão explícita:
 * nunca soma parcialmente uma importação que atravessa a virada do mês, o
 * que poderia contar um pedido só "meio" dentro do período perguntado).
 * Responde "quantos pedidos foram cancelados este mês", "qual o valor das
 * taxas envolvidas", "quantos recebem/não recebem taxa", "quantos precisam
 * de revisão".
 * @param {{organizacaoId: string, unidadeId: string, ano: number, mes: number}} p
 */
export async function resumoCancelamentosPeriodo({ organizacaoId, unidadeId, ano, mes }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { inicio, fim } = limitesDoMes(ano, mes);

  const { data, error } = await supabase.from(TABELA_IMPORT).select("*")
    .eq("unidade_id", unidadeId).eq("status", "concluida")
    .gte("periodo_inicio", inicio).lte("periodo_fim", fim);
  if (error) throw ApiError.internal(error.message);

  const importacoes = (data ?? []).map(paraApiImportacao);
  return {
    periodo: { ano, mes },
    ...somarResumosPeriodo(importacoes),
    importacoesConsideradas: importacoes.map((i) => ({
      id: i.id, nomeArquivo: i.nomeArquivo, periodoInicio: i.periodoInicio, periodoFim: i.periodoFim,
    })),
  };
}

export const MAX_CANCELAMENTOS_TOOL = 30;
const LIMITE_CANCELAMENTOS_PADRAO = 15;

/**
 * Lista os cancelamentos (individuais) de um MÊS, já classificados pelo
 * motor automático — nunca reclassifica, só filtra/pagina o que já está
 * gravado. Filtra por `data_hora` do PEDIDO (não pelo período da
 * importação): um pedido só entra se ele mesmo aconteceu dentro do mês
 * pedido, com `classificacao_cancelamento` preenchido (== cancelado E
 * elegível para conciliação — pedidos fora da conciliação ou de
 * importações anteriores ao motor automático nunca têm esse campo).
 * Responde "quais cancelamentos precisam da minha atenção" (classificacao:
 * "revisar") e "quais têm confiança muito alta" (nivelConfianca).
 * @param {{organizacaoId: string, unidadeId: string, ano: number, mes: number,
 *   classificacao?: string, nivelConfianca?: string, limite?: number}} p
 */
export async function listarCancelamentosPeriodo({ organizacaoId, unidadeId, ano, mes, classificacao, nivelConfianca, limite }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { inicio } = limitesDoMes(ano, mes);
  const fimExclusivo = inicioMesSeguinte(ano, mes);

  let q = supabase.from(TABELA_PEDIDOS).select(COLUNAS_PEDIDO_LEITURA)
    .eq("unidade_id", unidadeId)
    .not("classificacao_cancelamento", "is", null)
    .gte("data_hora", inicio).lt("data_hora", fimExclusivo);
  if (classificacao) q = q.eq("classificacao_cancelamento", classificacao);
  if (nivelConfianca) q = q.eq("classificacao_nivel_confianca", nivelConfianca);

  const limiteAplicado = Math.min(MAX_CANCELAMENTOS_TOOL, Math.max(1, Number(limite) || LIMITE_CANCELAMENTOS_PADRAO));
  const { data, error } = await q.order("data_hora", { ascending: false }).limit(limiteAplicado + 1);
  if (error) throw ApiError.internal(error.message);

  const linhas = data ?? [];
  const truncado = linhas.length > limiteAplicado;
  return {
    periodo: { ano, mes },
    itens: linhas.slice(0, limiteAplicado).map(paraResumoCancelamento),
    limiteAplicado, truncado,
  };
}

/** Recorte enxuto de 1 linha de pedido cancelado — usado tanto na listagem quanto na explicação individual. */
function paraResumoCancelamento(row) {
  const p = paraApiPedido(row);
  return {
    numeroPedido: p.numeroPedido, dataHora: p.dataHora, taxaEntregador: p.taxaEntregador,
    classificacaoCancelamento: p.classificacaoCancelamento, classificacaoMotivo: p.classificacaoMotivo,
    classificacaoNivelConfianca: p.classificacaoNivelConfianca, classificacaoRegra: p.classificacaoRegra,
    statusConciliacao: p.statusConciliacao,
    correcaoManual: p.classificacaoOverrideEm ? {
      usuarioNome: p.classificacaoOverrideUsuarioNome, motivo: p.classificacaoOverrideMotivo, em: p.classificacaoOverrideEm,
    } : null,
  };
}

/**
 * Explica UM pedido específico — "por que o pedido #XXXX recebe/não recebe
 * taxa?". Busca por `numeroPedido` dentro da unidade; se houver mais de um
 * candidato (o mesmo número pode repetir em relatórios de meses diferentes),
 * `ano`/`mes` desambiguam pelo mês do pedido — sem eles, mais de 1 resultado
 * volta como "ambiguo" (nunca escolhe sozinho). A decisão de candidato e a
 * montagem da explicação são funções PURAS (calc.js) — aqui só a consulta.
 * @param {{organizacaoId: string, unidadeId: string, numeroPedido: string, ano?: number, mes?: number}} p
 */
export async function consultarCancelamento({ organizacaoId, unidadeId, numeroPedido, ano, mes }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const numero = String(numeroPedido ?? "").trim();
  if (!numero) throw ApiError.badRequest("Informe o número do pedido.");

  const { data, error } = await supabase.from(TABELA_PEDIDOS).select(COLUNAS_PEDIDO_LEITURA)
    .eq("unidade_id", unidadeId).eq("numero_pedido", numero);
  if (error) throw ApiError.internal(error.message);

  const candidatos = (data ?? []).map(paraApiPedido);
  const escolha = resolverCandidatoPedido(candidatos, { ano, mes });

  if (escolha.status === "nao_encontrado") return { encontrado: false, motivo: "nao_encontrado", numeroPedido: numero };
  if (escolha.status === "ambiguo") {
    return {
      encontrado: false, motivo: "ambiguo", numeroPedido: numero,
      candidatos: escolha.candidatos.map((p) => ({ dataHora: p.dataHora, situacao: p.situacao })),
    };
  }
  return explicarCancelamento(escolha.candidato);
}

/** Consulta operacional, independente do Histórico e do limite de 200 arquivos. */
export async function analisarPeriodo({ organizacaoId, unidadeId, dataInicio, dataFim }) {
  const periodo = normalizarPeriodo(dataInicio, dataFim);
  await resolverUnidade({ organizacaoId, unidadeId });
  const linhas = [];
  const fontes = new Map();
  // Join com importações concluídas evita N+1 e processamento parcial.
  for (let offset = 0; ; offset += PAGINA_PEDIDOS) {
    const { data, error } = await supabase.from(TABELA_PEDIDOS)
      .select(COLUNAS_PEDIDO_LEITURA + ", organizacao_id, unidade_id, fonte:parser_fd_importacoes!inner(id, organizacao_id, unidade_id, status, criado_em, nome_arquivo, periodo_inicio, periodo_fim, usuario_nome, coluna_detalhes_encontrada)")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
      .eq("fonte.organizacao_id", organizacaoId).eq("fonte.unidade_id", unidadeId)
      .eq("fonte.status", "concluida")
      .gte("data_hora", periodo.inicio).lt("data_hora", periodo.fimExclusivo)
      .order("data_hora", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + PAGINA_PEDIDOS - 1);
    if (error) throw ApiError.internal(error.message);
    for (const row of data || []) {
      linhas.push(row);
      fontes.set(row.importacao_id, paraApiImportacao(row.fonte));
    }
    if (!data || data.length < PAGINA_PEDIDOS) break;
  }
  const todos = consolidarPedidosPeriodo(linhas).map(paraApiPedido);
  const pedidos = todos.filter(ehElegivelConciliacao);
  const filtragem = resumoFiltragem(todos);
  return {
    periodo: { dataInicio, dataFim }, consolidado: true,
    importacao: { id: null, periodoInicio: dataInicio, periodoFim: dataFim,
      totalPedidos: todos.length, pedidosSubway: filtragem.subway,
      pedidosAcai: filtragem.acaiNoGrau, pedidosRevisao: filtragem.revisaoNecessaria,
      pedidosSemEntregador: filtragem.semEntregador, codigosSemTaxa: [],
      colunaDetalhesEncontrada: [...fontes.values()].every((f) => f.colunaDetalhesEncontrada !== false) },
    resumo: resumoConciliacao(pedidos), pedidos,
    pedidosIgnorados: todos.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado),
    entregadores: entregadoresParaApi(pedidos),
    fontes: [...fontes.values()], duplicadosSobrepostos: linhas.length - todos.length,
  };
}
