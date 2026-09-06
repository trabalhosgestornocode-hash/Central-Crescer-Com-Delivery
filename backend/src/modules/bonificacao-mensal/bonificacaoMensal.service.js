// Serviço central da Bonificação Mensal — lançamentos diários, importação
// dos 2 PDFs da Visio (preview + confirmação, mesmo padrão de
// vendas/vendas.service.js) e avaliação das metas do mês.
import { supabase } from "../../config/supabase.js";
import { prepararImportacaoDiaria, registrarImportacaoDiaria, conferirImportacao } from "./bonificacaoMensal.importacao.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { parseVisioProductReport, parseVisioSalesReport, decodificarPdfVisio } from "./visio-parser.js";
import {
  hojeIsoBrasil, diasDoMes, STATUS_DIA_BONIFICACAO, statusDia, percentualDerivado, mixDoDia,
  validarPercentualCruzado, detectarInversaoRelatorios, faturamentoAcumulado, mixMensalPonderado,
  mediaDiaria, somaValida, ticketMedioPonderado, projecaoFaturamento, ritmoNecessario, participacaoLoja, mesmaUnidadeVisio,
} from "./bonificacaoMensal.calc.js";
import { evaluateBonusMetric, resolverMetaVigente, totalBonificacao } from "./bonificacaoMensal.metas.js";
import { avaliarElegibilidadeBonificacao, avaliarSuperRestaurante } from "./bonificacaoMensal.elegibilidade.js";
// Camada de fechamento mensal (arquitetura v3.1). Puro — sem I/O.
import {
  montarResultadoCompetencia, montarResultadoFechamentoOficial, validarFechamentoMensal,
  roteamentoObterMes, fechamentoStatusAoVivo, classificarAcompanhamento,
} from "./bonificacaoMensal.fechamento.js";

const TABELA = "bonificacao_lancamentos_diarios";
const TABELA_IMPORT = "bonificacao_importacoes";
const TABELA_METAS = "bonificacao_metas";
const TABELA_FAIXAS = "bonificacao_metas_faixas";
const TABELA_REV_MENSAL = "bonificacao_rev_mensal";
// Fechamento Mensal Visio (migrations 074→075). obterMes() NUNCA lê
// TABELA_FECHAMENTO para decidir o resultado — quem manda é TABELA_COMPETENCIA.status.
const TABELA_FECHAMENTO = "bonificacao_fechamento_mensal";
const TABELA_COMPETENCIA = "bonificacao_competencia";
const TABELA_SNAPSHOT = "bonificacao_competencia_snapshot";
const BUCKET = "bonificacao-visio";

// Indicadores sem fonte automática (item 76-B): lançamento manual próprio,
// mas MESMA granularidade diária da Visio (item corrigido — a 1ª versão
// usava uma tabela mensal à parte; migrations 042/043 criaram e reverteram
// isso no mesmo dia). O valor mora nas colunas de sempre em
// bonificacao_lancamentos_diarios (pesquisas_qtd, avaliacao_ifood,
// pedidos_chamado_pct — migration 028), uma por dia, agregadas no mês do
// mesmo jeito que sempre foram (CAMPOS_INDICADOR abaixo).
// Cancelamentos entrou nesta lista em 15/08/2026 (auditoria) — sem fonte
// automática comprovada até hoje, mesmo tratamento dos outros 4.
//
// REV SAIU DAQUI (virou mensal, migration 052): diferente de
// Pesquisas/Nota iFood/Chamados/Cancelamentos, REV não é uma contagem ou
// média que evolui dia a dia — é uma nota publicada pela operação UMA VEZ
// por competência. Passou a morar em bonificacao_rev_mensal (ver
// obterRevMensal/salvarRevMensal abaixo), granularidade unidade+ano+mês.
const INDICADORES_MANUAIS = ["pesquisas", "avaliacao_ifood", "pedidos_chamado", "cancelamentos"];
// campo da API (paraApiLancamento) por indicador manual — usado pro
// calendário/lançamento por dia (obterCalendarioIndicador/salvarValorDiaIndicador).
const CAMPO_API_INDICADOR_MANUAL = {
  pesquisas: "pesquisasQtd", avaliacao_ifood: "avaliacaoIfood",
  pedidos_chamado: "pedidosChamadoPct", cancelamentos: "cancelamentosPct",
};
// Todos os indicadores com meta (espelha o check constraint de bonificacao_metas.indicador).
const INDICADORES_META = [
  "faturamento", "bebidas", "adicionais", "diversos", "cmv", "ticket_medio",
  "avaliacao_ifood", "cancelamentos", "pedidos_chamado", "rev", "pesquisas",
];
const LABEL_INDICADOR = {
  faturamento: "Faturamento", bebidas: "Bebidas", adicionais: "Adicionais", diversos: "Diversos",
  cmv: "CMV", ticket_medio: "Ticket Médio", avaliacao_ifood: "Avaliação/Nota iFood",
  cancelamentos: "Cancelamentos", pedidos_chamado: "Pedidos com Chamado", rev: "REV", pesquisas: "Pesquisas",
};

function validarIndicadorManual(indicador) {
  if (!INDICADORES_MANUAIS.includes(indicador)) throw ApiError.badRequest("Indicador manual inválido.");
}

/** Number(x), mas preserva null/undefined — "não informado" nunca vira 0. */
const numOuNulo = (x) => (x == null ? null : Number(x));

/** Indicadores que a importação da Visio alimenta automaticamente (item 27); os 4 manuais entram por CAMPO_API_INDICADOR_MANUAL, mesma agregação diária de sempre. */
const CAMPOS_INDICADOR = {
  faturamento: (m) => faturamentoAcumulado(m.lancamentos),
  bebidas: (m) => m.mix.bebidas,
  adicionais: (m) => m.mix.adicionais,
  diversos: (m) => m.mix.diversos,
  cmv: (m) => mediaDiaria(m.lancamentos.map((l) => l.cmvPct)),
  // Ponderado pelo volume de cupons de cada dia (faturamento acumulado ÷
  // cupons acumulados), nunca média simples dos tickets diários — mesmo
  // princípio do Mix (item 9 das instruções da auditoria de 15/08/2026).
  ticket_medio: (m) => ticketMedioPonderado(m.lancamentos),
  cancelamentos: (m) => mediaDiaria(m.lancamentos.map((l) => l.cancelamentosPct)),
  avaliacao_ifood: (m) => mediaDiaria(m.lancamentos.map((l) => l.avaliacaoIfood)),
  pedidos_chamado: (m) => mediaDiaria(m.lancamentos.map((l) => l.pedidosChamadoPct)),
  // REV não é mais média de dias — é o valor ÚNICO da competência (migration
  // 052). `m.revMensal` vem de bonificacao_rev_mensal, resolvido em obterMes().
  rev: (m) => m.revMensal?.valor ?? null,
  // Pesquisas é CONTAGEM acumulada no mês, não média (item 34) — cada dia
  // informa quantas pesquisas novas chegaram.
  pesquisas: (m) => somaValida(m.lancamentos.map((l) => l.pesquisasQtd)),
};

// ---------------------------------------------------------------------------
// MAPEAMENTO DB <-> API
// ---------------------------------------------------------------------------
function paraApiLancamento(row) {
  if (!row) return null;
  return {
    id: row.id,
    unidadeId: row.unidade_id,
    data: row.data,
    semOperacao: !!row.sem_operacao,
    motivoSemOperacao: row.motivo_sem_operacao ?? null,
    faturamentoGeral: numOuNulo(row.faturamento_geral),
    ppdGeral: numOuNulo(row.ppd_geral), // legado — o Relatório de Vendas (novo Geral) não traz mais PPD; coluna preservada só pra dado histórico
    cuponsValidosGeral: row.cupons_validos_geral ?? null,
    cuponsVendasGeral: row.cupons_vendas_geral ?? null,
    estabelecimentoGeral: row.estabelecimento_geral ?? null,
    faturamentoLoja: numOuNulo(row.faturamento_loja),
    ppdLoja: numOuNulo(row.ppd_loja),
    qtdSanduichesLoja: numOuNulo(row.qtd_sanduiches_loja),
    qtdBebidasLoja: numOuNulo(row.qtd_bebidas_loja),
    qtdAdicionaisLoja: numOuNulo(row.qtd_adicionais_loja),
    qtdDiversosLoja: numOuNulo(row.qtd_diversos_loja),
    estabelecimentoLoja: row.estabelecimento_loja ?? null,
    percentualBebidasPdf: numOuNulo(row.percentual_bebidas_pdf),
    percentualAdicionaisPdf: numOuNulo(row.percentual_adicionais_pdf),
    percentualDiversosPdf: numOuNulo(row.percentual_diversos_pdf),
    cmvPct: numOuNulo(row.cmv_pct),
    ticketMedio: numOuNulo(row.ticket_medio),
    avaliacaoIfood: numOuNulo(row.avaliacao_ifood),
    cancelamentosPct: numOuNulo(row.cancelamentos_pct),
    pedidosChamadoPct: numOuNulo(row.pedidos_chamado_pct),
    revNota: numOuNulo(row.rev_nota),
    pesquisasQtd: row.pesquisas_qtd ?? null,
    origem: row.origem,
    manualOverride: row.manual_override || {},
    importacaoGeralId: row.importacao_geral_id ?? null,
    importacaoLojaId: row.importacao_loja_id ?? null,
    usuarioNome: row.usuario_nome ?? null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    mix: mixDoDia({
      qtdSanduichesLoja: numOuNulo(row.qtd_sanduiches_loja), qtdBebidasLoja: numOuNulo(row.qtd_bebidas_loja),
      qtdAdicionaisLoja: numOuNulo(row.qtd_adicionais_loja), qtdDiversosLoja: numOuNulo(row.qtd_diversos_loja),
    }),
    participacaoLoja: participacaoLoja(numOuNulo(row.faturamento_loja), numOuNulo(row.faturamento_geral)),
  };
}

function paraApiImportacao(row) {
  return {
    id: row.id, unidadeId: row.unidade_id, data: row.data_lancamento, tipoRelatorio: row.tipo_relatorio,
    nomeArquivo: row.nome_arquivo, estabelecimentoDetectado: row.estabelecimento_detectado,
    status: row.status, mensagemErro: row.mensagem_erro,
    usuarioNome: row.usuario_nome, criadoEm: row.criado_em,
  };
}

function paraApiMeta(meta) {
  return {
    id: meta.id, indicador: meta.indicador, direcao: meta.direcao,
    validFrom: meta.valid_from, validUntil: meta.valid_until, observacao: meta.observacao ?? null,
    faixas: (meta.bonificacao_metas_faixas || []).slice().sort((a, b) => a.ordem - b.ordem).map((f) => ({
      ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus),
    })),
  };
}

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — mesmo princípio do Dashboard iFood: nunca confia em
// unidadeId vindo do cliente sem checar contra a sessão/organização.
// ---------------------------------------------------------------------------
async function resolverUnidade({ organizacaoId, unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acessar a Bonificação Mensal.");
  const { data: unidade, error } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade;
}

// ---------------------------------------------------------------------------
// METAS
// ---------------------------------------------------------------------------
async function carregarMetas({ unidadeId }) {
  const { data, error } = await supabase.from(TABELA_METAS)
    .select("*, bonificacao_metas_faixas(*)").eq("unidade_id", unidadeId).order("valid_from", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return data || [];
}

/** Metas vigentes na data de referência, uma por indicador (a mais recente aplicável). */
function metasVigentesPorIndicador(metas, dataReferencia) {
  const porIndicador = {};
  for (const m of metas) {
    if (!porIndicador[m.indicador]) porIndicador[m.indicador] = [];
    porIndicador[m.indicador].push(m);
  }
  const vigentes = {};
  for (const [indicador, lista] of Object.entries(porIndicador)) {
    const candidatas = lista.map((m) => ({ ...m, validFrom: m.valid_from, validUntil: m.valid_until }));
    const escolhida = resolverMetaVigente(candidatas, dataReferencia);
    if (escolhida) {
      vigentes[indicador] = {
        indicador, direcao: escolhida.direcao,
        faixas: (escolhida.bonificacao_metas_faixas || []).map((f) => ({
          ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus),
        })),
      };
    }
  }
  return vigentes;
}

export async function listarMetas({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const metas = await carregarMetas({ unidadeId });
  return metas.map(paraApiMeta);
}

// ---------------------------------------------------------------------------
// METAS — CRUD com vigência (item 76-B). Editar NUNCA reescreve o passado:
// uma vigência nova sempre fecha a anterior (valid_until) em vez de
// sobrescrevê-la; só uma meta que ainda não começou a valer pode ser
// corrigida in-place (mesmo `valid_from` exato).
// ---------------------------------------------------------------------------
const TIPOS_FAIXA = ["limite_minimo", "limite_maximo", "intervalo"];

function validarFaixas(faixas) {
  if (!Array.isArray(faixas) || !faixas.length) throw ApiError.badRequest("Cadastre ao menos uma faixa.");
  const ordens = new Set();
  return faixas.map((f, i) => {
    const ordem = Number(f?.ordem ?? i + 1);
    if (!Number.isInteger(ordem) || ordem < 1) throw ApiError.badRequest(`Faixa ${i + 1}: ordem inválida.`);
    if (ordens.has(ordem)) throw ApiError.badRequest(`Duas faixas não podem ter a mesma ordem (${ordem}).`);
    ordens.add(ordem);
    if (!TIPOS_FAIXA.includes(f?.tipo)) throw ApiError.badRequest(`Faixa ${ordem}: tipo inválido.`);
    const valorMin = f.valorMin === "" || f.valorMin == null ? null : Number(f.valorMin);
    const valorMax = f.valorMax === "" || f.valorMax == null ? null : Number(f.valorMax);
    const bonus = f.bonus === "" || f.bonus == null ? null : Number(f.bonus);
    if (f.tipo === "limite_minimo" && (valorMin == null || !Number.isFinite(valorMin))) throw ApiError.badRequest(`Faixa ${ordem}: informe o valor mínimo.`);
    if (f.tipo === "limite_maximo" && (valorMax == null || !Number.isFinite(valorMax))) throw ApiError.badRequest(`Faixa ${ordem}: informe o valor máximo.`);
    if (f.tipo === "intervalo" && (valorMin == null || valorMax == null || !Number.isFinite(valorMin) || !Number.isFinite(valorMax))) {
      throw ApiError.badRequest(`Faixa ${ordem}: informe o intervalo completo (mínimo e máximo).`);
    }
    if (bonus != null && !Number.isFinite(bonus)) throw ApiError.badRequest(`Faixa ${ordem}: bônus inválido.`);
    return { ordem, tipo: f.tipo, valorMin, valorMax, bonus };
  });
}

const fmtFaixaResumo = (f) => {
  const alvo = f.tipo === "intervalo" ? `${f.valorMin}–${f.valorMax}` : f.tipo === "limite_maximo" ? `até ${f.valorMax}` : `${f.valorMin}+`;
  return `${alvo}→${f.bonus == null ? "sem valor" : "R$" + f.bonus}`;
};
const resumoFaixas = (faixas) => (faixas || []).slice().sort((a, b) => a.ordem - b.ordem).map(fmtFaixaResumo).join(", ");

/**
 * @param {{organizacaoId:string, unidadeId:string, usuario:object, indicador:string,
 *   direcao:'higher_is_better'|'lower_is_better', validFrom:string, faixas:Array, observacao?:string}} p
 */
export async function salvarMeta({ organizacaoId, unidadeId, usuario, indicador, direcao, validFrom, faixas, observacao }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  if (!INDICADORES_META.includes(indicador)) throw ApiError.badRequest("Indicador inválido.");
  if (!["higher_is_better", "lower_is_better"].includes(direcao)) throw ApiError.badRequest("Direção da meta inválida.");
  const dataVigencia = v.dataOpcional(validFrom, "Vigente a partir de");
  if (!dataVigencia) throw ApiError.badRequest("Informe a partir de quando a meta vale.");
  const faixasValidadas = validarFaixas(faixas);
  const hoje = hojeIsoBrasil();

  const { data: metasExistentes, error: eList } = await supabase.from(TABELA_METAS).select("*")
    .eq("unidade_id", unidadeId).eq("indicador", indicador).order("valid_from", { ascending: false });
  if (eList) throw ApiError.internal(eList.message);

  const mesmaData = (metasExistentes || []).find((m) => m.valid_from === dataVigencia);
  let metaId, antesResumo = null;

  if (mesmaData) {
    // Corrige uma vigência que ainda não começou (ou começa hoje) — nunca uma já vivida.
    if (dataVigencia < hoje) throw ApiError.badRequest("Não é possível alterar uma vigência que já passou — o histórico é preservado.");
    const { data: faixasAntes } = await supabase.from(TABELA_FAIXAS).select("*").eq("meta_id", mesmaData.id).order("ordem");
    antesResumo = resumoFaixas((faixasAntes || []).map((f) => ({ ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus) })));
    const { error: eUpd } = await supabase.from(TABELA_METAS).update({ direcao, observacao: observacao || null }).eq("id", mesmaData.id);
    if (eUpd) throw ApiError.badRequest(eUpd.message);
    const { error: eDelFaixas } = await supabase.from(TABELA_FAIXAS).delete().eq("meta_id", mesmaData.id);
    if (eDelFaixas) throw ApiError.badRequest(eDelFaixas.message);
    metaId = mesmaData.id;
  } else {
    // Vigência nova de verdade — nunca antes de hoje (não reescreve o passado, item 10).
    if (dataVigencia < hoje) throw ApiError.badRequest("A nova vigência precisa começar hoje ou numa data futura — não é possível reescrever meses já fechados.");
    const aberta = (metasExistentes || []).find((m) => !m.valid_until && m.valid_from < dataVigencia);
    if (aberta) {
      const { data: faixasAntes } = await supabase.from(TABELA_FAIXAS).select("*").eq("meta_id", aberta.id).order("ordem");
      antesResumo = resumoFaixas((faixasAntes || []).map((f) => ({ ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus) })));
      const d = new Date(dataVigencia + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1);
      const { error: eClose } = await supabase.from(TABELA_METAS).update({ valid_until: d.toISOString().slice(0, 10) }).eq("id", aberta.id);
      if (eClose) throw ApiError.badRequest(eClose.message);
    }
    const { data: nova, error: eIns } = await supabase.from(TABELA_METAS).insert({
      organizacao_id: organizacaoId, unidade_id: unidadeId, indicador, direcao,
      valid_from: dataVigencia, valid_until: null, observacao: observacao || null,
    }).select("id").single();
    if (eIns) throw ApiError.badRequest(eIns.message);
    metaId = nova.id;
  }

  const { error: eFaixas } = await supabase.from(TABELA_FAIXAS).insert(
    faixasValidadas.map((f) => ({ meta_id: metaId, ordem: f.ordem, tipo: f.tipo, valor_min: f.valorMin, valor_max: f.valorMax, bonus: f.bonus })),
  );
  if (eFaixas) throw ApiError.badRequest(eFaixas.message);

  const depoisResumo = resumoFaixas(faixasValidadas);
  const label = LABEL_INDICADOR[indicador] || indicador;
  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_META_ALTERADA, entidade: "bonificacao_meta", entidadeId: metaId, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, indicador, validFrom: dataVigencia, direcao,
      antes: antesResumo, depois: depoisResumo,
      resumo: antesResumo
        ? `Meta de ${label} alterada de ${antesResumo} para ${depoisResumo} (vigente a partir de ${dataVigencia})`
        : `Meta de ${label} cadastrada: ${depoisResumo} (vigente a partir de ${dataVigencia})`,
    },
  });

  const { data: metaSalva, error: eGet } = await supabase.from(TABELA_METAS)
    .select("*, bonificacao_metas_faixas(*)").eq("id", metaId).single();
  if (eGet) throw ApiError.internal(eGet.message);
  return paraApiMeta(metaSalva);
}

// ---------------------------------------------------------------------------
// REV MENSAL (migration 052): 1 valor por unidade+mês,
// nunca um por dia. Mesmo padrão de auditoria de salvarValorDiaIndicador,
// só que sem o recorte "um dia" — a granularidade JÁ é o mês inteiro.
// ---------------------------------------------------------------------------

/** @param {{organizacaoId:string, unidadeId:string, ano:number, mes:number}} p */
export async function obterRevMensal({ organizacaoId, unidadeId, ano, mes }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data, error } = await supabase.from(TABELA_REV_MENSAL).select("*")
    .eq("unidade_id", unidadeId).eq("ano", ano).eq("mes", mes).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) return null;
  return { valor: numOuNulo(data.valor), usuarioNome: data.usuario_nome ?? null, atualizadoEm: data.atualizado_em };
}

/**
 * Lança/corrige o REV do mês. Upsert por (unidade, ano, mes) — nunca cria um
 * segundo registro pro mesmo período (unique constraint da migration 052 é
 * quem garante isso na última instância; aqui só refletimos o mesmo
 * contrato pra dar um erro claro em vez de estourar 23505 cru).
 * @param {{organizacaoId:string, unidadeId:string, usuario:object, ano:unknown, mes:unknown, valor:unknown}} p
 */
export async function salvarRevMensal({ organizacaoId, unidadeId, usuario, ano, mes, valor }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(anoNum) || !Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    throw ApiError.badRequest("Informe ano e mês válidos.");
  }
  const valorNum = v.numeroOpcionalNulo(valor, "REV");
  if (valorNum == null) throw ApiError.badRequest("Informe o valor de REV do mês.");
  if (valorNum < 0) throw ApiError.badRequest("REV não pode ser negativo.");
  await exigirCompetenciaEditavel({ unidadeId, ano: anoNum, mes: mesNum, acao: "alterar o REV" });

  const anterior = await obterRevMensal({ organizacaoId, unidadeId, ano: anoNum, mes: mesNum });

  const { data: salvo, error } = await supabase.from(TABELA_REV_MENSAL)
    .upsert({
      organizacao_id: organizacaoId, unidade_id: unidadeId, ano: anoNum, mes: mesNum, valor: valorNum,
      usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null,
    }, { onConflict: "unidade_id,ano,mes" })
    .select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_INDICADOR_LANCADO, entidade: "bonificacao_rev_mensal", entidadeId: salvo.id, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, indicador: "rev", ano: anoNum, mes: mesNum,
      valorAnterior: anterior?.valor ?? null, valorNovo: valorNum,
      resumo: anterior?.valor != null
        ? `REV de ${mesNum}/${anoNum} atualizado de ${anterior.valor} para ${valorNum}`
        : `REV de ${mesNum}/${anoNum} lançado: ${valorNum}`,
    },
  });

  return { valor: numOuNulo(salvo.valor), usuarioNome: salvo.usuario_nome ?? null, atualizadoEm: salvo.atualizado_em };
}

// ---------------------------------------------------------------------------
// ESTADO DA COMPETÊNCIA (arquitetura v3.1) — bonificacao_competencia.status é
// a ÚNICA fonte da verdade de QUAL resultado vale. obterMes() decide por ele:
//   fechada / legado_sem_fechamento → serve o snapshot congelado
//   aberta / reaberta / (sem linha) → cálculo AO VIVO (ignora bonificacao_fechamento_mensal)
//
// Resiliente à migration 075 ainda não aplicada: se a tabela não existe,
// obterCompetencia() devolve null e tudo segue no cálculo ao vivo.
// ---------------------------------------------------------------------------

/** true quando o erro do supabase-js é "tabela não existe" (migration pendente). */
function tabelaAusente(error, nome) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const m = String(error.message || "").toLowerCase();
  return (m.includes(nome) && (m.includes("exist") || m.includes("schema cache")))
    || (m.includes("could not find the table") && m.includes(nome));
}

function paraApiCompetencia(row) {
  if (!row) return null;
  return {
    id: row.id, organizacaoId: row.organizacao_id, unidadeId: row.unidade_id,
    ano: row.ano, mes: row.mes,
    status: row.status, versaoAtual: row.versao_atual ?? 0, fechamentoId: row.fechamento_id ?? null,
    fechadaEm: row.fechada_em ?? null, fechadaPorNome: row.fechada_por_nome ?? null,
    reabertaEm: row.reaberta_em ?? null, reabertaPorNome: row.reaberta_por_nome ?? null, reaberturaMotivo: row.reabertura_motivo ?? null,
    legadoCapturadoEm: row.legado_capturado_em ?? null,
  };
}

/** Lê a competência (bonificacao_competencia) ou null. Null-safe se a 075 ainda não rodou. */
async function obterCompetencia({ unidadeId, ano, mes }) {
  const { data, error } = await supabase.from(TABELA_COMPETENCIA).select("*")
    .eq("unidade_id", unidadeId).eq("ano", ano).eq("mes", mes).maybeSingle();
  if (error) {
    if (tabelaAusente(error, TABELA_COMPETENCIA)) return null;
    throw ApiError.internal(error.message);
  }
  return paraApiCompetencia(data);
}

/** Snapshot vigente (versao_atual) da competência congelada. Null se ausente. */
async function obterSnapshotVigente(competencia) {
  if (!competencia || !competencia.versaoAtual) return null;
  const { data, error } = await supabase.from(TABELA_SNAPSHOT).select("*")
    .eq("competencia_id", competencia.id).eq("versao", competencia.versaoAtual).maybeSingle();
  if (error) {
    if (tabelaAusente(error, TABELA_SNAPSHOT)) return null;
    throw ApiError.internal(error.message);
  }
  return data || null;
}

// ---------------------------------------------------------------------------
// INDICADORES MANUAIS (Pesquisas/Avaliação iFood/Pedidos com chamado) —
// acompanhamento DIÁRIO, igual à Visio (item corrigido a pedido do usuário:
// a 1ª versão era mensal, ver migrations 042/043). O valor mora nas mesmas
// colunas de sempre em bonificacao_lancamentos_diarios; estas funções só
// expõem um recorte "um indicador, um mês" (calendário) e "salvar um dia"
// em cima do que obterMes()/upsertLancamentoManual() já fazem — nenhuma
// lógica de agregação nova, reaproveita tudo.
// ---------------------------------------------------------------------------

/** Calendário do mês para UM indicador manual — mesmo `obterMes`, recortado. */
export async function obterCalendarioIndicador({ organizacaoId, unidadeId, indicador, ano, mes }) {
  validarIndicadorManual(indicador);
  const r = await obterMes({ organizacaoId, unidadeId, ano, mes });
  const campo = CAMPO_API_INDICADOR_MANUAL[indicador];
  const dias = r.calendario.map((d) => {
    const valor = d.lancamento ? d.lancamento[campo] : null;
    let status;
    if (d.status === STATUS_DIA_BONIFICACAO.FUTURO) status = "FUTURO";
    else if (d.status === STATUS_DIA_BONIFICACAO.SEM_OPERACAO) status = "SEM_OPERACAO";
    else status = valor != null ? "PREENCHIDO" : "PENDENTE";
    return { data: d.data, valor, status };
  });
  return { unidade: r.unidade, ano: r.ano, mes: r.mes, mesFechado: r.mesFechado, indicador, agregado: r.indicadores[indicador], dias };
}

/** Últimos N meses (padrão 6) desse indicador — mesma agregação de `obterMes`, um resumo por mês. */
export async function historicoMensalIndicador({ organizacaoId, unidadeId, indicador, meses = 6 }) {
  validarIndicadorManual(indicador);
  const qtd = v.limite(meses, 6, 1, 12);
  const hoje = hojeIsoBrasil();
  let ano = Number(hoje.slice(0, 4)), mes = Number(hoje.slice(5, 7));
  const lista = [];
  for (let i = 0; i < qtd; i++) {
    const r = await obterMes({ organizacaoId, unidadeId, ano, mes });
    lista.push({ ano, mes, ...r.indicadores[indicador] });
    mes--; if (mes < 1) { mes = 12; ano--; }
  }
  return lista;
}

/**
 * Lança/edita o valor de UM indicador manual em UM dia — mesmo mecanismo de
 * `upsertLancamentoManual` (preserva os outros campos do dia intactos), só
 * que restrito a um dos 4 indicadores sem fonte automática e SEMPRE com
 * auditoria (item 13 — "REV de dd/mm/aaaa atualizado de X para Y").
 */
export async function salvarValorDiaIndicador({ organizacaoId, unidadeId, usuario, indicador, data, valor }) {
  validarIndicadorManual(indicador);
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const dataIso = v.dataOpcional(data, "Data");
  if (!dataIso) throw ApiError.badRequest("Informe a data do lançamento.");
  await exigirCompetenciaEditavel({ unidadeId, dataIso, acao: `lançar ${LABEL_INDICADOR[indicador] || indicador}` });
  const campo = CAMPO_API_INDICADOR_MANUAL[indicador];
  const label = LABEL_INDICADOR[indicador] || indicador;

  const valorNum = v.numeroOpcionalNulo(valor, label);
  if (valorNum == null) throw ApiError.badRequest(`Informe o valor de ${label}.`);
  if (valorNum < 0) throw ApiError.badRequest(`${label} não pode ser negativo.`);

  const existente = await obterLancamentoPorData({ organizacaoId, unidadeId, data: dataIso });
  const valorAnterior = existente ? numOuNulo(existente[campo]) : null;

  const salvo = await upsertLancamentoManual({ organizacaoId, unidadeId, usuario, dados: { data: dataIso, [campo]: valorNum } });
  const valorNovo = numOuNulo(salvo[campo]);

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_INDICADOR_LANCADO, entidade: "bonificacao_indicador_manual", entidadeId: salvo.id, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, indicador, data: dataIso, valorAnterior, valorNovo,
      resumo: valorAnterior != null
        ? `${label} de ${dataIso} atualizado de ${valorAnterior} para ${valorNovo}`
        : `${label} de ${dataIso} lançado: ${valorNovo}`,
    },
  });

  return salvo;
}

// ---------------------------------------------------------------------------
// MÊS — calendário, resumo, avaliação de cada indicador
// ---------------------------------------------------------------------------
export async function obterMes({ organizacaoId, unidadeId, ano, mes }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(anoNum) || !Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    throw ApiError.badRequest("Informe ano e mês válidos.");
  }

  // ROTEAMENTO por estado da competência (arquitetura v3.1 §4). O que decide
  // qual resultado vale é bonificacao_competencia.status — NUNCA a existência
  // de uma linha em bonificacao_fechamento_mensal.
  const competencia = await obterCompetencia({ unidadeId, ano: anoNum, mes: mesNum });
  if (roteamentoObterMes(competencia) === "snapshot") {
    const snap = await obterSnapshotVigente(competencia);
    if (snap) return montarRespostaCongelada({ competencia, snapshot: snap, unidade, anoNum, mesNum });
    console.warn(`[bonificacao-mensal] competência ${unidadeId} ${anoNum}-${String(mesNum).padStart(2, "0")} status=${competencia.status} sem snapshot v${competencia.versaoAtual} — usando cálculo ao vivo.`);
  }
  return obterMesAoVivo({ unidade, anoNum, mesNum, competencia, organizacaoId, unidadeId });
}

/**
 * Competência FECHADA ou LEGADO → serve o SNAPSHOT congelado. Não recalcula
 * indicadores nem lê lançamento diário para agregação. O calendário (leitura)
 * segue vindo dos dias reais, só que travado (podeEditarDiario=false).
 */
async function montarRespostaCongelada({ competencia, snapshot, unidade, anoNum, mesNum }) {
  const dias = diasDoMes(anoNum, mesNum);
  const hojeIso = hojeIsoBrasil();
  const { data: rows } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidade.id).gte("data", dias[0]).lte("data", dias[dias.length - 1]).order("data");
  const porData = new Map((rows || []).map((r) => [r.data, paraApiLancamento(r)]));
  const calendario = dias.map((d) => {
    const l = porData.get(d) || null;
    return { data: d, status: statusDia({ lancamento: l, dataIso: d, hojeIso }), lancamento: l };
  });

  const s = snapshot.snapshot || {};
  // (a) fechamento_mensal_direto → tem valoresOficiais (formato §5.4);
  // (b) acompanhamento_diario / legado_pre_refatoracao → formato obterMes ao vivo.
  const visio = !!s.valoresOficiais;
  const vo = s.valoresOficiais || {};
  // `percentuais` é o formato vigente; `percentuaisCalculados` fica só como
  // fallback para snapshots gravados antes da limpeza de forma (nenhum em prod).
  const pc = vo.percentuais || vo.percentuaisCalculados || {};

  const resumo = {
    bonificacaoAtual: s.bonificacao?.definitiva ?? s.resumo?.bonificacaoAtual ?? null,
    bonificacaoBruta: s.bonificacao?.bruta ?? s.resumo?.bonificacaoBruta ?? null,
    bonificacaoMaxima: s.bonificacao?.maxima ?? s.resumo?.bonificacaoMaxima ?? null,
    metasAtingidas: s.bonificacao?.metasAtingidas ?? s.resumo?.metasAtingidas ?? 0,
    metasComRegra: s.bonificacao?.metasComRegra ?? s.resumo?.metasComRegra ?? 0,
    progressoPct: null,
  };
  resumo.progressoPct = resumo.bonificacaoMaxima > 0 ? ((resumo.bonificacaoAtual ?? 0) / resumo.bonificacaoMaxima) * 100 : null;

  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    ano: anoNum, mes: mesNum, mesFechado: true,
    congelado: true,
    origemResultado: s.origem || (competencia.status === "legado_sem_fechamento" ? "legado_pre_refatoracao" : "fechamento_mensal_direto"),
    fechamentoStatus: competencia.status === "fechada" ? "fechado" : "legado_sem_fechamento",
    podeEditarDiario: false,
    versaoSnapshot: snapshot.versao,
    calendario,
    resumo,
    faturamento: {
      acumulado: visio ? (vo.faturamento ?? null) : (s.faturamento?.acumulado ?? null),
      projecao: visio ? (vo.faturamento ?? null) : (s.faturamento?.projecao ?? null),
      mesFechado: true, diasRestantes: 0, ritmoNecessarioProximaFaixa: null,
    },
    mix: {
      bebidas: pc.bebidas ?? s.mix?.bebidas ?? null,
      adicionais: pc.adicionais ?? s.mix?.adicionais ?? null,
      diversos: pc.diversos ?? s.mix?.diversos ?? null,
      somaSanduiches: vo.sanduichesSaladas ?? s.mix?.somaSanduiches ?? null,
      diasComDados: null,
    },
    valoresOficiais: visio ? vo : null,
    indicadores: s.indicadores || {},
    revMensal: null,
    fechamentoMensal: null,
    elegibilidade: s.elegibilidade || null,
    superRestaurante: s.superRestaurante || null,
    diasPendentes: [],
    indicadoresAtencao: s.indicadoresAtencao || [],
  };
}

/**
 * Competência ABERTA / REABERTA (ou inexistente) → cálculo AO VIVO.
 * bonificacao_fechamento_mensal NUNCA é lido aqui como fonte de resultado.
 */
async function obterMesAoVivo({ unidade, anoNum, mesNum, competencia, organizacaoId, unidadeId }) {
  const hojeIso = hojeIsoBrasil();
  const dias = diasDoMes(anoNum, mesNum);
  const primeiroDia = dias[0], ultimoDia = dias[dias.length - 1];
  const mesFechado = `${anoNum}-${String(mesNum).padStart(2, "0")}` < hojeIso.slice(0, 7);

  const [{ data: rows, error }, metasRaw, revMensal] = await Promise.all([
    supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).gte("data", primeiroDia).lte("data", ultimoDia).order("data"),
    carregarMetas({ unidadeId }),
    obterRevMensal({ organizacaoId, unidadeId, ano: anoNum, mes: mesNum }),
  ]);
  if (error) throw ApiError.internal(error.message);

  const lancamentosPorData = new Map((rows || []).map((r) => [r.data, paraApiLancamento(r)]));
  const calendario = dias.map((d) => {
    const l = lancamentosPorData.get(d) || null;
    return { data: d, status: statusDia({ lancamento: l, dataIso: d, hojeIso }), lancamento: l };
  });
  const lancamentos = [...lancamentosPorData.values()];

  const mix = mixMensalPonderado(lancamentos);
  const projecao = projecaoFaturamento({ lancamentos, ano: anoNum, mes: mesNum, hojeIso });
  const metasVigentes = metasVigentesPorIndicador(metasRaw, primeiroDia);

  // valor cru de cada indicador (mesma fonte de sempre para o cálculo ao vivo)
  const valorMensal = { mix, lancamentos, revMensal };
  const valores = {};
  for (const [ind, fn] of Object.entries(CAMPOS_INDICADOR)) valores[ind] = fn(valorMensal);
  valores.faturamento = projecao.acumulado; // projeção acumulada, não a soma bruta

  // motor compartilhado — o MESMO usado por montarResultadoFechamentoOficial
  const core = montarResultadoCompetencia({ valores, metasVigentes, mesFechado });

  const fatIndicador = core.indicadores.faturamento;
  const ritmoFaturamento = fatIndicador?.proximaFaixa
    ? ritmoNecessario(
      fatIndicador.proximaFaixa.valorMin != null ? fatIndicador.proximaFaixa.valorMin - (projecao.projecao ?? projecao.acumulado ?? 0) : null,
      projecao.diasRestantes,
    )
    : null;

  const diasPendentes = calendario.filter((d) => d.status === STATUS_DIA_BONIFICACAO.PENDENTE).map((d) => d.data);

  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    ano: anoNum, mes: mesNum, mesFechado,
    congelado: false,
    origemResultado: "ao_vivo",
    fechamentoStatus: fechamentoStatusAoVivo(competencia, mesFechado),
    podeEditarDiario: true,
    calendario,
    resumo: core.resumo,
    faturamento: { ...projecao, ritmoNecessarioProximaFaixa: ritmoFaturamento },
    mix,
    fechamentoMensal: null, // v3.1: fechamento só vira resultado quando a competência está 'fechada' (serve snapshot)
    indicadores: core.indicadores,
    revMensal,
    elegibilidade: core.elegibilidade,
    superRestaurante: core.superRestaurante,
    diasPendentes,
    indicadoresAtencao: core.indicadoresAtencao,
  };
}

export async function obterLancamentoPorData({ organizacaoId, unidadeId, data }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const dataIso = v.dataOpcional(data, "Data");
  if (!dataIso) throw ApiError.badRequest("Data inválida.");
  const { data: row, error } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataIso).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!row) return null;
  const lancamento = paraApiLancamento(row);
  const validacaoCruzada = {
    bebidas: validarPercentualCruzado(lancamento.percentualBebidasPdf, lancamento.mix.bebidas),
    adicionais: validarPercentualCruzado(lancamento.percentualAdicionaisPdf, lancamento.mix.adicionais),
    diversos: validarPercentualCruzado(lancamento.percentualDiversosPdf, lancamento.mix.diversos),
  };
  return { ...lancamento, validacaoCruzada };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO MANUAL (criação direta ou correção pós-importação — item 73)
// ---------------------------------------------------------------------------
// `revNota`/`rev_nota` SAI daqui de propósito (migration 052, Super
// Restaurante): REV não é mais editável por dia, então não é mais um campo
// gravável por este caminho — usa salvarRevMensal(). A coluna continua no
// banco (dado legado, nunca apagado), só deixa de ser escrita.
const CAMPOS_EDITAVEIS = [
  "faturamentoGeral", "ppdGeral", "faturamentoLoja", "ppdLoja", "qtdSanduichesLoja", "qtdBebidasLoja",
  "qtdAdicionaisLoja", "qtdDiversosLoja", "cmvPct", "ticketMedio", "avaliacaoIfood", "cancelamentosPct",
  "pedidosChamadoPct", "pesquisasQtd",
];
const CAMPO_DB = {
  faturamentoGeral: "faturamento_geral", ppdGeral: "ppd_geral", faturamentoLoja: "faturamento_loja", ppdLoja: "ppd_loja",
  qtdSanduichesLoja: "qtd_sanduiches_loja", qtdBebidasLoja: "qtd_bebidas_loja", qtdAdicionaisLoja: "qtd_adicionais_loja",
  qtdDiversosLoja: "qtd_diversos_loja", cmvPct: "cmv_pct", ticketMedio: "ticket_medio", avaliacaoIfood: "avaliacao_ifood",
  cancelamentosPct: "cancelamentos_pct", pedidosChamadoPct: "pedidos_chamado_pct", pesquisasQtd: "pesquisas_qtd",
};

export async function upsertLancamentoManual({ organizacaoId, unidadeId, usuario, dados }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const dataIso = v.dataOpcional(dados?.data, "Data do lançamento");
  if (!dataIso) throw ApiError.badRequest("Informe a data do lançamento.");
  await exigirCompetenciaEditavel({ unidadeId, dataIso, acao: "editar o lançamento diário" });
  const semOperacao = v.booleano(dados?.semOperacao, false);
  if (semOperacao && !v.textoOpcional(dados?.motivoSemOperacao, "Motivo")) {
    throw ApiError.badRequest("Informe o motivo de a unidade não ter operado neste dia.");
  }

  const { data: existente } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataIso).maybeSingle();

  const manualOverrideAnterior = existente?.manual_override || {};
  const manualOverride = { ...manualOverrideAnterior };
  const linha = { organizacao_id: organizacaoId, unidade_id: unidadeId, data: dataIso };

  if (semOperacao) {
    linha.sem_operacao = true;
    linha.motivo_sem_operacao = v.texto(dados.motivoSemOperacao, "Motivo");
    for (const campo of CAMPOS_EDITAVEIS) linha[CAMPO_DB[campo]] = null;
  } else {
    linha.sem_operacao = false;
    linha.motivo_sem_operacao = null;
    for (const campo of CAMPOS_EDITAVEIS) {
      if (!(campo in (dados || {}))) continue; // campo não enviado -> mantém o que já existia
      const valorNovo = dados[campo] === "" ? null : v.numeroOpcionalNulo(dados[campo], campo);
      const dbKey = CAMPO_DB[campo];
      linha[dbKey] = valorNovo;
      const valorAnterior = existente ? numOuNulo(existente[dbKey]) : null;
      if (valorNovo !== valorAnterior) manualOverride[campo] = true; // item 19 — nunca silencioso
    }
  }

  const tinhaOrigemVisio = existente && (existente.origem === "visio" || existente.origem === "misto");
  linha.origem = tinhaOrigemVisio ? "misto" : "manual";
  linha.manual_override = manualOverride;
  linha.usuario_id = usuario?.id || null;
  linha.usuario_nome = usuario?.nome || null;
  // preserva o que não foi tocado (ex.: campos de importação e ids de importação)
  if (existente) {
    for (const [campo, dbKey] of Object.entries(CAMPO_DB)) if (!(dbKey in linha)) linha[dbKey] = existente[dbKey];
    linha.importacao_geral_id = existente.importacao_geral_id;
    linha.importacao_loja_id = existente.importacao_loja_id;
    linha.estabelecimento_geral = existente.estabelecimento_geral;
    linha.estabelecimento_loja = existente.estabelecimento_loja;
    linha.percentual_bebidas_pdf = existente.percentual_bebidas_pdf;
    linha.percentual_adicionais_pdf = existente.percentual_adicionais_pdf;
    linha.percentual_diversos_pdf = existente.percentual_diversos_pdf;
  }

  const { data: salvo, error } = await supabase.from(TABELA).upsert(linha, { onConflict: "unidade_id,data" }).select("*").single();
  if (error) throw ApiError.badRequest(error.message);
  return paraApiLancamento(salvo);
}

// ---------------------------------------------------------------------------
// IMPORTAÇÃO VISIO — preview (dry-run) + confirmação (mesmo padrão de
// vendas/vendas.service.js processarImportacaoVendas).
// ---------------------------------------------------------------------------
async function uploadOriginal({ buf, unidadeId, data, tipo, hash, nomeArquivo }) {
  if (!buf) return null;
  const nome = String(nomeArquivo || "relatorio.pdf").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${unidadeId}/${data}/${tipo}-${String(hash || "").slice(0, 10)}-${nome}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: "application/pdf", upsert: true });
  if (error) { console.warn("[bonificacao-mensal] storage:", error.message, "— importação segue sem o arquivo original."); return null; }
  return path;
}

/**
 * @param {{organizacaoId:string, unidadeId:string, usuario:object, payload:{data:string, geral?:object, loja?:object, substituir?:boolean}, confirmar:boolean}} p
 */
export async function processarImportacaoVisio({ organizacaoId, unidadeId, usuario, payload, confirmar = false }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });

  const dataLancamento = v.dataOpcional(payload?.data, "Data do lançamento");
  if (!dataLancamento) throw ApiError.badRequest("Informe a data do lançamento — a Visio não traz uma data diária confiável no relatório.");
  if (!payload?.geral && !payload?.loja) throw ApiError.badRequest("Envie pelo menos um dos dois relatórios (Geral ou Loja).");
  if (confirmar) await exigirCompetenciaEditavel({ unidadeId, dataIso: dataLancamento, acao: "importar lançamento diário" });

  let bufGeral = null, bufLoja = null, parsedGeral = null, parsedLoja = null;
  // Geral = "Relatório de Vendas" (novo layout — Faturamento + Ticket Médio,
  // sem PPD). Loja continua no "Relatório de Produtos" de sempre (Mix).
  if (payload.geral) { bufGeral = decodificarPdfVisio(payload.geral, "Geral"); parsedGeral = await parseVisioSalesReport(bufGeral, { rotulo: "Geral" }); }
  if (payload.loja) { bufLoja = decodificarPdfVisio(payload.loja, "Loja"); parsedLoja = await parseVisioProductReport(bufLoja, { rotulo: "Loja" }); }

  // item 19 — correção manual ANTES de salvar (a leitura do PDF pode ter
  // interpretado algum número errado). Cada campo corrigido entra no
  // manual_override — nunca silencioso, e sempre em cima do valor já
  // validado pelo parser (a correção passa pelas MESMAS validações abaixo:
  // inversão, unidade etc.).
  const camposCorrigidosGeral = [], camposCorrigidosLoja = [];
  if (parsedGeral && payload.correcoes?.geral) {
    for (const [campo, valor] of Object.entries(payload.correcoes.geral)) {
      if (!["faturamento", "ticketMedio", "cuponsValidos", "cuponsVendas"].includes(campo) || valor === undefined || valor === "") continue;
      const num = Number(valor);
      if (!Number.isFinite(num) || num < 0) continue;
      if (num !== parsedGeral[campo]) { parsedGeral[campo] = num; camposCorrigidosGeral.push(campo); }
    }
  }
  if (parsedLoja && payload.correcoes?.loja) {
    for (const [campo, valor] of Object.entries(payload.correcoes.loja)) {
      if (!["faturamento", "ppd", "sandwichesSalads", "beverages", "additions", "miscellaneous"].includes(campo) || valor === undefined || valor === "") continue;
      const num = Number(valor);
      if (!Number.isFinite(num) || num < 0) continue;
      if (num !== parsedLoja[campo]) { parsedLoja[campo] = num; camposCorrigidosLoja.push(campo); }
    }
  }

  // item 16 — CRÍTICA: unidade do relatório precisa bater com a selecionada
  for (const [rotulo, parsed] of [["Geral", parsedGeral], ["Loja", parsedLoja]]) {
    if (!parsed) continue;
    if (mesmaUnidadeVisio(unidade.nome, parsed.estabelecimento) === false) {
      throw ApiError.badRequest(`O relatório ${rotulo} pertence a uma unidade diferente da unidade atualmente selecionada (relatório de "${parsed.estabelecimento}").`);
    }
  }

  // itens 14-15 — possível inversão dos relatórios
  let inversao = null;
  if (parsedGeral && parsedLoja) {
    inversao = detectarInversaoRelatorios(parsedGeral, parsedLoja);
    if (inversao.invertido) {
      throw ApiError.badRequest("Os relatórios parecem estar invertidos: o relatório informado como Loja possui valores superiores ao relatório Geral. Verifique os arquivos antes de continuar (troque os relatórios de campo e tente novamente).");
    }
  }

  // item 20 — duplicidade por unidade+data. Continua montando a prévia
  // mesmo assim (não retorna cedo): o frontend precisa mostrar VALORES
  // ATUAIS (existente) e NOVOS (preview) lado a lado antes de substituir.
  const { data: existente, error: erroExistente } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataLancamento).maybeSingle();
  if (erroExistente) throw ApiError.internal("Não foi possível verificar o lançamento existente.");
  const planos = {};
  for (const [tipo, parsed, buf] of [["geral", parsedGeral, bufGeral], ["loja", parsedLoja, bufLoja]]) {
    const alvo = { organizacaoId, unidadeId, tipo, data: dataLancamento };
    if (parsed) {
      planos[tipo] = await prepararImportacaoDiaria(supabase, { alvo, parsed, buf, arquivo: payload[tipo] });
    } else if (existente?.[`importacao_${tipo}_id`]) {
      // Um upload parcial não pode perpetuar um vínculo inválido no outro slot.
      const { data: imp, error } = await supabase.from(TABELA_IMPORT).select("*").eq("id", existente[`importacao_${tipo}_id`]).maybeSingle();
      if (error) throw ApiError.internal("Não foi possível verificar a importação preservada.");
      if (!imp) throw ApiError.badRequest("Importação preservada não encontrada.");
      await conferirImportacao(supabase, imp, alvo);
    }
  }
  const duplicado = !!existente && payload.substituir !== true;

  // mix calculado + validação cruzada (item 11)
  let mixCalculado = null, validacaoCruzada = null, avisos = [];
  if (parsedLoja) {
    mixCalculado = {
      bebidas: percentualDerivado(parsedLoja.beverages, parsedLoja.sandwichesSalads),
      adicionais: percentualDerivado(parsedLoja.additions, parsedLoja.sandwichesSalads),
      diversos: percentualDerivado(parsedLoja.miscellaneous, parsedLoja.sandwichesSalads),
    };
    validacaoCruzada = {
      bebidas: validarPercentualCruzado(parsedLoja.percentualBebidasPdf, mixCalculado.bebidas),
      adicionais: validarPercentualCruzado(parsedLoja.percentualAdicionaisPdf, mixCalculado.adicionais),
      diversos: validarPercentualCruzado(parsedLoja.percentualDiversosPdf, mixCalculado.diversos),
    };
    for (const [chave, r] of Object.entries(validacaoCruzada)) {
      if (r.divergente) avisos.push(`No Relatório de Produtos, o percentual impresso de ${chave} não corresponde às quantidades do próprio relatório (diferença de ${r.diferenca.toFixed(1)} p.p.). Confira o arquivo antes de confirmar.`);
    }
  }

  const preview = {
    data: dataLancamento,
    unidade: { id: unidade.id, nome: unidade.nome },
    geral: parsedGeral && {
      faturamento: parsedGeral.faturamento, ticketMedio: parsedGeral.ticketMedio,
      cuponsValidos: parsedGeral.cuponsValidos, cuponsVendas: parsedGeral.cuponsVendas,
      estabelecimento: parsedGeral.estabelecimento,
    },
    loja: parsedLoja && {
      faturamento: parsedLoja.faturamento, ppd: parsedLoja.ppd, estabelecimento: parsedLoja.estabelecimento,
      sanduichesSaladas: parsedLoja.sandwichesSalads, bebidas: parsedLoja.beverages, adicionais: parsedLoja.additions, diversos: parsedLoja.miscellaneous,
      mixCalculado, percentuaisPdf: { bebidas: parsedLoja.percentualBebidasPdf, adicionais: parsedLoja.percentualAdicionaisPdf, diversos: parsedLoja.percentualDiversosPdf },
    },
    periodos: Object.fromEntries(Object.entries(planos).map(([tipo, plano]) => [tipo, plano.periodo])),
    validacaoCruzada, avisos,
    camposCorrigidos: { geral: camposCorrigidosGeral, loja: camposCorrigidosLoja },
  };

  if (duplicado) return { duplicado: true, existente: paraApiLancamento(existente), persistido: false, preview };
  if (!confirmar) return { duplicado: false, existente: existente ? paraApiLancamento(existente) : null, persistido: false, preview };

  // ---------- PERSISTE ----------
  const [storageGeral, storageLoja] = await Promise.all([
    parsedGeral && !planos.geral.existente ? uploadOriginal({ buf: bufGeral, unidadeId, data: dataLancamento, tipo: "geral", hash: parsedGeral.hash, nomeArquivo: payload.geral.nomeArquivo }) : null,
    parsedLoja && !planos.loja.existente ? uploadOriginal({ buf: bufLoja, unidadeId, data: dataLancamento, tipo: "loja", hash: parsedLoja.hash, nomeArquivo: payload.loja.nomeArquivo }) : null,
  ]);

  const registrar = (tipo, parsed, storage) => registrarImportacaoDiaria(supabase, {
    alvo: { organizacaoId, unidadeId, tipo, data: dataLancamento }, parsed, storage,
    nomeArquivo: payload[tipo].nomeArquivo, usuario, periodo: planos[tipo].periodo,
    anteriorId: existente?.[`importacao_${tipo}_id`],
  });
  const importacaoGeralId = parsedGeral ? await registrar("geral", parsedGeral, storageGeral) : null;
  const importacaoLojaId = parsedLoja ? await registrar("loja", parsedLoja, storageLoja) : null;

  const camposVisio = {};
  if (parsedGeral) {
    camposVisio.faturamento_geral = parsedGeral.faturamento;
    camposVisio.ticket_medio = parsedGeral.ticketMedio;
    camposVisio.cupons_validos_geral = parsedGeral.cuponsValidos;
    camposVisio.cupons_vendas_geral = parsedGeral.cuponsVendas;
    camposVisio.estabelecimento_geral = parsedGeral.estabelecimento;
  }
  if (parsedLoja) {
    camposVisio.faturamento_loja = parsedLoja.faturamento; camposVisio.ppd_loja = parsedLoja.ppd; camposVisio.estabelecimento_loja = parsedLoja.estabelecimento;
    camposVisio.qtd_sanduiches_loja = parsedLoja.sandwichesSalads; camposVisio.qtd_bebidas_loja = parsedLoja.beverages;
    camposVisio.qtd_adicionais_loja = parsedLoja.additions; camposVisio.qtd_diversos_loja = parsedLoja.miscellaneous;
    camposVisio.percentual_bebidas_pdf = parsedLoja.percentualBebidasPdf; camposVisio.percentual_adicionais_pdf = parsedLoja.percentualAdicionaisPdf; camposVisio.percentual_diversos_pdf = parsedLoja.percentualDiversosPdf;
  }

  const manualOverrideAnterior = existente?.manual_override || {};
  const manualOverride = { ...manualOverrideAnterior };
  for (const campo of Object.keys(camposVisio)) delete manualOverride[campo]; // acabou de vir fresco da Visio

  // item 19 — campos corrigidos manualmente na prévia ficam marcados mesmo
  // vindo desta importação (não são mais 100% "extração automática").
  const DB_POR_CAMPO_GERAL = { faturamento: "faturamento_geral", ticketMedio: "ticket_medio" };
  const DB_POR_CAMPO_LOJA = {
    faturamento: "faturamento_loja", ppd: "ppd_loja", sandwichesSalads: "qtd_sanduiches_loja",
    beverages: "qtd_bebidas_loja", additions: "qtd_adicionais_loja", miscellaneous: "qtd_diversos_loja",
  };
  for (const campo of camposCorrigidosGeral) if (DB_POR_CAMPO_GERAL[campo]) manualOverride[DB_POR_CAMPO_GERAL[campo]] = true;
  for (const campo of camposCorrigidosLoja) if (DB_POR_CAMPO_LOJA[campo]) manualOverride[DB_POR_CAMPO_LOJA[campo]] = true;
  const houveCorrecaoManual = camposCorrigidosGeral.length > 0 || camposCorrigidosLoja.length > 0;

  const sobramCamposManuais = houveCorrecaoManual || (existente && Object.keys(manualOverrideAnterior).some((k) => !(k in camposVisio)));

  const linha = {
    organizacao_id: organizacaoId, unidade_id: unidadeId, data: dataLancamento,
    sem_operacao: false, motivo_sem_operacao: null,
    ...camposVisio,
    origem: sobramCamposManuais ? "misto" : "visio",
    manual_override: manualOverride,
    importacao_geral_id: importacaoGeralId ?? existente?.importacao_geral_id ?? null,
    importacao_loja_id: importacaoLojaId ?? existente?.importacao_loja_id ?? null,
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null,
  };
  // preserva indicadores manuais que não vieram da Visio. Ticket Médio agora
  // VEM do Geral (Relatório de Vendas) — só preserva o valor antigo quando
  // este import NÃO trouxe um Geral novo (senão sobrescreveria o valor
  // fresco que `camposVisio` acabou de gravar em `linha`, alguns campos
  // acima, com um valor desatualizado).
  if (existente) {
    for (const dbKey of ["cmv_pct", "avaliacao_ifood", "cancelamentos_pct", "pedidos_chamado_pct", "pesquisas_qtd"]) linha[dbKey] = existente[dbKey];
    if (!parsedGeral) linha.ticket_medio = existente.ticket_medio;
  }

  const { data: salvo, error } = await supabase.from(TABELA).upsert(linha, { onConflict: "unidade_id,data" }).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  return { duplicado: false, persistido: true, preview, lancamento: paraApiLancamento(salvo) };
}

// ---------------------------------------------------------------------------
// FECHAMENTO MENSAL VISIO — PRÉVIA (F3). Recebe os DOIS relatórios mensais
// (Vendas + Produtos/Loja), parseia, valida (bloqueios × alertas) e monta o
// RESULTADO OFICIAL canônico da competência via montarResultadoFechamentoOficial
// — que NÃO chama obterMes(). NÃO persiste nada e NÃO fecha a competência: a
// gravação + o snapshot congelado entram na F4 (arquitetura v3.1 §7.3).
// ---------------------------------------------------------------------------
const MESES_PT_FECHAMENTO = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const competenciaLabel = (ano, mes) => `${MESES_PT_FECHAMENTO[mes] || mes}/${ano}`;
const competenciaPath = (ano, mes) => `${ano}-${String(mes).padStart(2, "0")}`;

function validarCompetencia(ano, mes) {
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(anoNum) || !Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12 || anoNum < 2000 || anoNum > 2100) {
    throw ApiError.badRequest("Informe ano e mês válidos para o fechamento mensal.");
  }
  return { anoNum, mesNum };
}

/** Soma das colunas Loja dos lançamentos diários da competência — só para os cross-checks (alertas). */
function agregarSomaDiaria(rows) {
  const acc = { sanduiches: 0, bebidas: 0, adicionais: 0, diversos: 0, faturamentoLoja: 0, dias: 0 };
  for (const r of rows || []) {
    if (r.qtd_sanduiches_loja == null && r.faturamento_loja == null) continue;
    acc.sanduiches += Number(r.qtd_sanduiches_loja ?? 0);
    acc.bebidas += Number(r.qtd_bebidas_loja ?? 0);
    acc.adicionais += Number(r.qtd_adicionais_loja ?? 0);
    acc.diversos += Number(r.qtd_diversos_loja ?? 0);
    acc.faturamentoLoja += Number(r.faturamento_loja ?? 0);
    acc.dias++;
  }
  return acc.dias ? acc : null;
}

/** Indicadores manuais mensais (mesmas fórmulas de sempre — nada migrou de regra nesta fase). */
function manuaisMensais(lancamentos, revMensal) {
  return {
    cmv: mediaDiaria(lancamentos.map((l) => l.cmvPct)),
    avaliacaoIfood: mediaDiaria(lancamentos.map((l) => l.avaliacaoIfood)),
    cancelamentos: mediaDiaria(lancamentos.map((l) => l.cancelamentosPct)),
    pedidosChamado: mediaDiaria(lancamentos.map((l) => l.pedidosChamadoPct)),
    pesquisas: somaValida(lancamentos.map((l) => l.pesquisasQtd)),
    rev: revMensal?.valor ?? null,
  };
}

/** Aplica correções manuais da prévia (item 19) sobre o objeto do parser — nunca silencioso. */
function aplicarCorrecoes(parsed, correcoes) {
  const campos = [];
  if (!correcoes) return campos;
  for (const [campo, valor] of Object.entries(correcoes)) {
    if (!(campo in parsed) || valor === undefined || valor === "" || valor === null) continue;
    const num = Number(valor);
    if (!Number.isFinite(num) || num < 0) continue;
    if (num !== parsed[campo]) { parsed[campo] = num; campos.push(campo); }
  }
  return campos;
}

/** Normaliza o retorno do parser de Produtos para o formato canônico esperado por montarResultadoFechamentoOficial. */
function produtosParaCanonico(p) {
  return {
    qtdSanduiches: p.sandwichesSalads, qtdBebidas: p.beverages, qtdAdicionais: p.additions, qtdDiversos: p.miscellaneous,
    ppd: p.ppd ?? null, torque: p.torque ?? null, perdas: p.perdas ?? null,
    fatSanduiches: p.fatSanduichesSaladas ?? null, pctFatSanduiches: p.pctFatSanduichesSaladas ?? null,
    totalItens: p.totalItens ?? null, produtosFuncionais: p.produtosFuncionais ?? null,
    faturamentoLoja: p.faturamento ?? null, estabelecimento: p.estabelecimento ?? null,
    percentualBebidasPdf: p.percentualBebidasPdf ?? null,
    percentualAdicionaisPdf: p.percentualAdicionaisPdf ?? null,
    percentualDiversosPdf: p.percentualDiversosPdf ?? null,
    hash: p.hash, origem: "visio",
  };
}

/**
 * PRÉVIA do fechamento mensal. Não persiste. `confirmar: true` é recusado
 * nesta fase (a gravação + snapshot congelado entram na F4).
 * @param {{organizacaoId:string, unidadeId:string, usuario:object,
 *   payload:{ano:unknown, mes:unknown, vendas?:object, produtos?:object,
 *            produtosCanalConfirmado?:boolean, periodoConfirmadoUsuario?:boolean, correcoes?:object},
 *   confirmar:boolean}} p
 */
export async function processarImportacaoFechamentoMensal({ organizacaoId, unidadeId, usuario, payload, confirmar = false }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { anoNum, mesNum } = validarCompetencia(payload?.ano, payload?.mes);

  // 1. os DOIS PDFs são obrigatórios
  if (!payload?.vendas && !payload?.produtos) throw ApiError.badRequest("Envie os dois relatórios mensais: Relatório de Vendas e Relatório de Produtos.");
  if (!payload?.vendas) throw ApiError.badRequest("Falta o Relatório de Vendas mensal.");
  if (!payload?.produtos) throw ApiError.badRequest("Falta o Relatório de Produtos mensal.");

  const bufVendas = decodificarPdfVisio(payload.vendas, "de Vendas");
  const bufProdutos = decodificarPdfVisio(payload.produtos, "de Produtos");

  // 2. parse + validação de TIPO (o parser recusa slot trocado — F2)
  const vendas = await parseVisioSalesReport(bufVendas, { rotulo: "de Vendas" });
  const produtos = await parseVisioProductReport(bufProdutos, { rotulo: "de Produtos" });

  // correções manuais da prévia
  const camposCorrigidosVendas = aplicarCorrecoes(vendas, payload.correcoes?.vendas);
  const camposCorrigidosProdutos = aplicarCorrecoes(produtos, payload.correcoes?.produtos);

  const produtosCanon = produtosParaCanonico(produtos);
  const vendasCanon = { ...vendas, origem: "visio" };

  // 3. soma diária da competência (cross-checks — alertas)
  const dias = diasDoMes(anoNum, mesNum);
  const [{ data: rowsMes }, competenciaExistente, metasRaw] = await Promise.all([
    supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).gte("data", dias[0]).lte("data", dias[dias.length - 1]).order("data"),
    obterCompetencia({ unidadeId, ano: anoNum, mes: mesNum }),
    carregarMetas({ unidadeId }),
  ]);
  const lancamentos = (rowsMes || []).map(paraApiLancamento);
  const somaDiaria = agregarSomaDiaria(rowsMes);
  const revMensal = await obterRevMensal({ organizacaoId, unidadeId, ano: anoNum, mes: mesNum });

  // 3b. CLASSIFICAÇÃO DE ACOMPANHAMENTO (determinística) — o fechamento mensal
  //   direto só existe para competências SEM acompanhamento diário.
  const acompanhamento = classificarAcompanhamento({ lancamentos, ano: anoNum, mes: mesNum, hojeIso: hojeIsoBrasil() });

  // 4. BLOQUEIOS × ALERTAS (função pura)
  const { bloqueios, alertas, crossChecks } = validarFechamentoMensal({
    vendas: vendasCanon, produtos: produtosCanon, unidadeNome: unidade.nome,
    somaDiaria, competenciaExistente, acompanhamento,
    produtosCanalConfirmado: !!payload.produtosCanalConfirmado,
    periodoConfirmadoUsuario: !!payload.periodoConfirmadoUsuario,
  });

  // 5. RESULTADO OFICIAL canônico — função PURA, NÃO chama obterMes()
  const metasVigentes = metasVigentesPorIndicador(metasRaw, dias[0]);
  const resultadoOficial = montarResultadoFechamentoOficial({
    vendas: vendasCanon,
    produtos: produtosCanon,
    manuais: manuaisMensais(lancamentos, revMensal),
    metasVigentes,
    contexto: {
      unidade: { id: unidade.id, nome: unidade.nome, organizacaoId },
      ano: anoNum, mes: mesNum,
      canalConfirmado: !!payload.produtosCanalConfirmado,
      periodoConfirmado: !!payload.periodoConfirmadoUsuario,
      codigoVersao: process.env.RENDER_GIT_COMMIT || null,
      confirmadoPor: null, // preenchido só na confirmação (F4)
      avisosImportacao: alertas.map((a) => a.msg),
      crossChecks,
    },
  });

  const preview = {
    competencia: { ano: anoNum, mes: mesNum, label: competenciaLabel(anoNum, mesNum) },
    unidade: { id: unidade.id, nome: unidade.nome },
    vendas: {
      faturamento: vendas.faturamento, ticketMedio: vendas.ticketMedio,
      quantidadeVendas: vendas.cuponsVendas ?? null, cuponsValidos: vendas.cuponsValidos ?? null,
      estabelecimento: vendas.estabelecimento, metodosPagamento: vendas.metodosPagamento ?? [],
    },
    produtos: {
      sanduichesSaladas: produtosCanon.qtdSanduiches, bebidas: produtosCanon.qtdBebidas,
      adicionais: produtosCanon.qtdAdicionais, diversos: produtosCanon.qtdDiversos,
      ppd: produtosCanon.ppd, torque: produtosCanon.torque, perdas: produtosCanon.perdas,
      fatSanduiches: produtosCanon.fatSanduiches, pctFatSanduiches: produtosCanon.pctFatSanduiches,
      totalItens: produtosCanon.totalItens, faturamentoLoja: produtosCanon.faturamentoLoja,
      estabelecimento: produtosCanon.estabelecimento,
      // único percentual do mix — a regra da Bonificação
      percentuais: resultadoOficial.valoresOficiais.percentuais,
    },
    camposCorrigidos: { vendas: camposCorrigidosVendas, produtos: camposCorrigidosProdutos },
    // Classificação do acompanhamento diário da competência (determinística).
    // A F7 usa isto para decidir qual botão mostrar.
    acompanhamento,
    // `conferencia`: TÉCNICO, só para revisar a importação. Não é resultado da
    // Bonificação nem uma segunda versão dos dados da competência.
    validacao: {
      bloqueios,
      alertas,
      conferencia: {
        crossChecks,
        percentuais: {
          regra: resultadoOficial.valoresOficiais.percentuais,
          impressosNoPdf: resultadoOficial.metadados.conferenciaImportacao.percentuaisImpressosNoPdf,
          divergenciaPP: resultadoOficial.metadados.conferenciaImportacao.divergenciaPercentualPP,
        },
        registradoNaCompetencia: somaDiaria ? {
          sanduichesSaladas: somaDiaria.sanduiches, bebidas: somaDiaria.bebidas,
          adicionais: somaDiaria.adicionais, diversos: somaDiaria.diversos,
          faturamentoLoja: somaDiaria.faturamentoLoja, dias: somaDiaria.dias,
        } : null,
      },
    },
    resultadoOficial,
    prontoParaConfirmar: bloqueios.length === 0,
    persistido: false,
  };

  if (!confirmar) return preview;

  // ----- CONFIRMAÇÃO (F4) — congela a competência ATOMICAMENTE (RPC) -----
  if (bloqueios.length) {
    throw ApiError.badRequest(`Não dá para confirmar o fechamento: ${bloqueios.join("; ")}`);
  }

  const pFechamento = {
    produtos_qtd_sanduiches: produtosCanon.qtdSanduiches,
    produtos_qtd_bebidas: produtosCanon.qtdBebidas,
    produtos_qtd_adicionais: produtosCanon.qtdAdicionais,
    produtos_qtd_diversos: produtosCanon.qtdDiversos,
    produtos_pct_bebidas_pdf: produtosCanon.percentualBebidasPdf,
    produtos_pct_adicionais_pdf: produtosCanon.percentualAdicionaisPdf,
    produtos_pct_diversos_pdf: produtosCanon.percentualDiversosPdf,
    produtos_faturamento_loja: produtosCanon.faturamentoLoja,
    produtos_ppd: produtosCanon.ppd,
    produtos_torque: produtosCanon.torque,
    produtos_perdas: produtosCanon.perdas,
    produtos_fat_sanduiches: produtosCanon.fatSanduiches,
    produtos_pct_fat_sanduiches: produtosCanon.pctFatSanduiches,
    produtos_total_itens: produtosCanon.totalItens,
    produtos_estabelecimento: produtosCanon.estabelecimento,
    produtos_hash_arquivo: produtosCanon.hash ?? null,
    produtos_arquivo_storage: null, // upload dos PDFs entra na F7
    produtos_origem: camposCorrigidosProdutos.length ? "misto" : "visio",
    vendas_faturamento: vendasCanon.faturamento,
    vendas_ticket_medio: vendasCanon.ticketMedio,
    vendas_cupons_validos: vendasCanon.cuponsValidos ?? null,
    vendas_cupons_vendas: vendasCanon.cuponsVendas ?? null,
    vendas_metodos_pagamento: vendasCanon.metodosPagamento ?? [],
    vendas_estabelecimento: vendasCanon.estabelecimento ?? null,
    vendas_hash_arquivo: vendasCanon.hash ?? null,
    vendas_arquivo_storage: null,
    vendas_origem: camposCorrigidosVendas.length ? "misto" : "visio",
  };

  const { data: rpcData, error: rpcErro } = await supabase.rpc("bonificacao_congelar_competencia", {
    p_organizacao_id: organizacaoId,
    p_unidade_id: unidadeId,
    p_ano: anoNum,
    p_mes: mesNum,
    p_origem: "fechamento_mensal_direto",
    p_snapshot: resultadoOficial,
    p_fechamento: pFechamento,
    p_motivo: null,
    p_por_id: usuario?.id ?? null,
    p_por_nome: usuario?.nome ?? null,
  });
  if (rpcErro) {
    if (funcaoAusente(rpcErro) || tabelaAusente(rpcErro, TABELA_COMPETENCIA)) {
      throw ApiError.internal("O fechamento mensal ainda não está disponível neste ambiente (migration 075 não aplicada).");
    }
    if (/ABORTADO/i.test(rpcErro.message || "")) throw ApiError.badRequest(rpcErro.message);
    throw ApiError.internal(rpcErro.message);
  }

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_FECHAMENTO_MENSAL_ALTERADO,
    entidade: "bonificacao_competencia", entidadeId: rpcData?.competencia_id ?? null, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, competencia: competenciaPath(anoNum, mesNum),
      versao: rpcData?.versao ?? null, status: rpcData?.status ?? null, origem: "fechamento_mensal_direto",
      alertas: alertas.map((a) => a.msg),
      resumo: `Fechamento mensal DIRETO de ${competenciaLabel(anoNum, mesNum)} confirmado (versão ${rpcData?.versao ?? "?"}) — competência ${rpcData?.status ?? "fechada"}, sem acompanhamento diário.`,
    },
  });

  return {
    ...preview,
    persistido: true,
    prontoParaConfirmar: false,
    origem: "fechamento_mensal_direto",
    competencia: {
      ...preview.competencia,
      id: rpcData?.competencia_id ?? null,
      status: rpcData?.status ?? "fechada",
      versao: rpcData?.versao ?? null,
    },
  };
}

/** true quando o erro do supabase-js é "função não existe" (RPC da F4 sem a migration 075). */
function funcaoAusente(error) {
  if (!error) return false;
  if (error.code === "42883" || error.code === "PGRST202") return true;
  const m = String(error.message || "").toLowerCase();
  return m.includes("function") && (m.includes("does not exist") || m.includes("não existe") || m.includes("could not find"));
}

// ---------------------------------------------------------------------------
// REABERTURA (F4) — volta uma competência FECHADA para cálculo ao vivo.
// Nada é apagado: o snapshot da versão vigente continua no histórico.
// ---------------------------------------------------------------------------
export async function reabrirCompetencia({ organizacaoId, unidadeId, usuario, ano, mes, motivo }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { anoNum, mesNum } = validarCompetencia(ano, mes);
  const motivoLimpo = String(motivo ?? "").trim();
  if (motivoLimpo.length < 3) throw ApiError.badRequest("Informe o motivo da reabertura (mínimo 3 caracteres).");

  const { data, error } = await supabase.rpc("bonificacao_reabrir_competencia", {
    p_unidade_id: unidadeId, p_ano: anoNum, p_mes: mesNum,
    p_motivo: motivoLimpo, p_por_id: usuario?.id ?? null, p_por_nome: usuario?.nome ?? null,
  });
  if (error) {
    if (funcaoAusente(error)) throw ApiError.internal("O fechamento mensal ainda não está disponível neste ambiente (migration 075 não aplicada).");
    if (/não existe|no_data_found/i.test(error.message || "")) throw ApiError.notFound(`Não existe fechamento para ${competenciaLabel(anoNum, mesNum)}.`);
    if (/não está fechada|restrict/i.test(error.message || "")) throw ApiError.badRequest(error.message);
    throw ApiError.internal(error.message);
  }

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_FECHAMENTO_MENSAL_ALTERADO,
    entidade: "bonificacao_competencia", entidadeId: data?.competencia_id ?? null, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, competencia: competenciaPath(anoNum, mesNum),
      motivo: motivoLimpo,
      resumo: `Fechamento mensal de ${competenciaLabel(anoNum, mesNum)} REABERTO — volta ao cálculo ao vivo até o próximo fechamento. Motivo: ${motivoLimpo}`,
    },
  });
  return { competencia: paraApiCompetencia({ ...data, unidade_id: unidadeId, organizacao_id: organizacaoId, ano: anoNum, mes: mesNum }), reaberta: true };
}

// ---------------------------------------------------------------------------
// CONGELAR A COMPETÊNCIA A PARTIR DO RESULTADO AO VIVO — helper compartilhado.
// Usado por:
//   consolidarAcompanhamentoDiario  → origem 'acompanhamento_diario' (status 'fechada')
//   capturarLegado                  → origem 'legado_pre_refatoracao' (status 'legado_sem_fechamento')
// REUTILIZA obterMesAoVivo — ZERO fórmula nova, ZERO segunda implementação do
// motor. O snapshot congela EXATAMENTE o que o cálculo diário produziu.
// ---------------------------------------------------------------------------
async function congelarCompetenciaDoAoVivo({ organizacaoId, unidadeId, usuario, unidade, anoNum, mesNum, competencia, origem, motivo }) {
  const aoVivo = await obterMesAoVivo({ unidade, anoNum, mesNum, competencia, organizacaoId, unidadeId });
  const snapshot = {
    escopoBonificacao: "unidade",
    unidade: { id: unidade.id, nome: unidade.nome, organizacaoId },
    competencia: { ano: anoNum, mes: mesNum },
    origem, // ÚNICA e obrigatória — nunca mistura fontes
    geradoEm: new Date().toISOString(),
    indicadores: aoVivo.indicadores,
    resumo: aoVivo.resumo,
    faturamento: aoVivo.faturamento,
    mix: aoVivo.mix,
    elegibilidade: aoVivo.elegibilidade,
    superRestaurante: aoVivo.superRestaurante,
    indicadoresAtencao: aoVivo.indicadoresAtencao,
    metadados: { congeladoPor: usuario?.nome ?? null, motivo: motivo ?? null },
  };
  const { data, error } = await supabase.rpc("bonificacao_congelar_competencia", {
    p_organizacao_id: organizacaoId, p_unidade_id: unidadeId, p_ano: anoNum, p_mes: mesNum,
    p_origem: origem, p_snapshot: snapshot, p_fechamento: null,
    p_motivo: motivo ?? null, p_por_id: usuario?.id ?? null, p_por_nome: usuario?.nome ?? null,
  });
  if (error) {
    if (funcaoAusente(error)) throw ApiError.internal("O fechamento mensal ainda não está disponível neste ambiente (migration 075 não aplicada).");
    if (/ABORTADO/i.test(error.message || "")) throw ApiError.badRequest(error.message);
    throw ApiError.internal(error.message);
  }
  return { data, aoVivo };
}

// ---------------------------------------------------------------------------
// CONSOLIDAR ACOMPANHAMENTO DIÁRIO (correção conceitual F4) — congela a
// competência a partir dos lançamentos diários. É o fechamento NORMAL de um
// mês que foi acompanhado dia a dia. Snapshot origem 'acompanhamento_diario'.
// ---------------------------------------------------------------------------
export async function consolidarAcompanhamentoDiario({ organizacaoId, unidadeId, usuario, ano, mes }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { anoNum, mesNum } = validarCompetencia(ano, mes);

  const competencia = await obterCompetencia({ unidadeId, ano: anoNum, mes: mesNum });
  if (competencia && (competencia.status === "fechada" || competencia.status === "legado_sem_fechamento")) {
    throw new ApiError(409, `A competência ${competenciaLabel(anoNum, mesNum)} já está "${competencia.status}". Reabra antes de reconsolidar.`);
  }

  const dias = diasDoMes(anoNum, mesNum);
  const { data: rowsMes } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidadeId).gte("data", dias[0]).lte("data", dias[dias.length - 1]).order("data");
  const lancamentos = (rowsMes || []).map(paraApiLancamento);
  const acompanhamento = classificarAcompanhamento({ lancamentos, ano: anoNum, mes: mesNum, hojeIso: hojeIsoBrasil() });

  if (acompanhamento.tipo === "SEM_ACOMPANHAMENTO") {
    throw ApiError.badRequest(
      `A competência ${competenciaLabel(anoNum, mesNum)} não tem acompanhamento diário para consolidar. `
      + "Use o fechamento mensal direto (Relatório Geral de Vendas + Relatório de Produtos do mês inteiro).",
    );
  }
  if (acompanhamento.tipo === "ACOMPANHAMENTO_PARCIAL") {
    const p = acompanhamento.diasPendentes;
    throw ApiError.badRequest(
      `Acompanhamento parcial (${acompanhamento.diasComAcompanhamento} de ${acompanhamento.diasEsperados} dias). `
      + `Complete os dias pendentes (${p.slice(0, 8).join(", ")}${p.length > 8 ? "…" : ""}) antes de consolidar a competência.`,
    );
  }

  const { data, aoVivo } = await congelarCompetenciaDoAoVivo({
    organizacaoId, unidadeId, usuario, unidade, anoNum, mesNum, competencia,
    origem: "acompanhamento_diario",
    motivo: `Consolidação do acompanhamento diário (${acompanhamento.diasEsperados} dias)`,
  });

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_FECHAMENTO_MENSAL_ALTERADO,
    entidade: "bonificacao_competencia", entidadeId: data?.competencia_id ?? null, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, competencia: competenciaPath(anoNum, mesNum),
      versao: data?.versao ?? null, status: data?.status ?? "fechada", origem: "acompanhamento_diario",
      diasEsperados: acompanhamento.diasEsperados, diasCobertos: acompanhamento.diasCobertos,
      resumo: `Competência ${competenciaLabel(anoNum, mesNum)} CONSOLIDADA a partir do acompanhamento diário (versão ${data?.versao ?? "?"}).`,
    },
  });

  return {
    persistido: true,
    origem: "acompanhamento_diario",
    competencia: { ano: anoNum, mes: mesNum, id: data?.competencia_id ?? null, status: data?.status ?? "fechada", versao: data?.versao ?? null },
    acompanhamento,
    resultado: { indicadores: aoVivo.indicadores, resumo: aoVivo.resumo, elegibilidade: aoVivo.elegibilidade, superRestaurante: aoVivo.superRestaurante },
  };
}

// ---------------------------------------------------------------------------
// CAPTURA DE LEGADO (F4 — mecanismo; o rollout em massa é a F8).
// Congela o resultado ATUAL (obterMesAoVivo) de uma competência antiga como
// snapshot `legado_pre_refatoracao`. Não exige reimportação; a partir daí a
// competência não recalcula mais.
// ---------------------------------------------------------------------------
export async function capturarLegado({ organizacaoId, unidadeId, usuario, ano, mes, motivo }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { anoNum, mesNum } = validarCompetencia(ano, mes);

  const competencia = await obterCompetencia({ unidadeId, ano: anoNum, mes: mesNum });
  if (competencia && competencia.status !== "aberta") {
    throw ApiError.badRequest(`A competência ${competenciaLabel(anoNum, mesNum)} já tem estado "${competencia.status}" — nada a capturar.`);
  }

  const { data } = await congelarCompetenciaDoAoVivo({
    organizacaoId, unidadeId, usuario, unidade, anoNum, mesNum, competencia,
    origem: "legado_pre_refatoracao",
    motivo: motivo ?? "captura de legado pré-refatoração",
  });

  await auditar({
    atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, atorTipo: "usuario",
    acao: ACOES.BONIFICACAO_FECHAMENTO_MENSAL_ALTERADO,
    entidade: "bonificacao_competencia", entidadeId: data?.competencia_id ?? null, organizacaoId,
    detalhes: {
      unidadeId, unidadeNome: unidade.nome, competencia: competenciaPath(anoNum, mesNum), origem: "legado_pre_refatoracao",
      resumo: `Competência ${competenciaLabel(anoNum, mesNum)} congelada como HISTÓRICO LEGADO (pré-refatoração).`,
    },
  });
  return { competencia: competenciaPath(anoNum, mesNum), status: "legado_sem_fechamento", versao: data?.versao ?? 1 };
}

/**
 * Guard de edição: uma competência FECHADA ou LEGADO não aceita mais alteração
 * de lançamento diário / indicador manual / REV. Chame com a data ou (ano,mes).
 * Lança ApiError.conflict se travada; no-op se aberta/reaberta/inexistente ou
 * se a tabela de competência ainda não existe (migration 075 pendente).
 */
async function exigirCompetenciaEditavel({ unidadeId, dataIso, ano, mes, acao = "editar" }) {
  let anoNum = Number(ano), mesNum = Number(mes);
  if (dataIso) { anoNum = Number(dataIso.slice(0, 4)); mesNum = Number(dataIso.slice(5, 7)); }
  if (!Number.isInteger(anoNum) || !Number.isInteger(mesNum)) return;
  const competencia = await obterCompetencia({ unidadeId, ano: anoNum, mes: mesNum });
  if (!competencia) return;
  // Mesma autoridade do obterMes: 'snapshot' ⇒ resultado congelado ⇒ diário travado.
  if (roteamentoObterMes(competencia) === "snapshot") {
    const rotulo = competencia.status === "fechada" ? "está fechada" : "é histórico legado congelado";
    throw new ApiError(409,
      `A competência ${String(mesNum).padStart(2, "0")}/${anoNum} ${rotulo} — não é possível ${acao}. `
      + (competencia.status === "fechada" ? "Reabra o fechamento mensal para voltar a editar." : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// HISTÓRICO DE IMPORTAÇÕES E ARQUIVO ORIGINAL (item 47)
// ---------------------------------------------------------------------------
export async function listarImportacoes({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(200);
  if (error) throw ApiError.internal(error.message);
  return (data || []).map(paraApiImportacao);
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
// EXCLUSÃO DE VERDADE (DELETE) — restrita a quem tem
// BONIFICACAO_MENSAL_EXCLUIR (só organization_admin, ver permissoes.js).
// Mesmo princípio do Dashboard iFood (dashboardExecutivo.service.js
// #excluirLancamento): sempre com motivo + snapshot completo ANTES de
// apagar — nunca se apaga um lançamento financeiro em silêncio.
//
// Diferente daquele, aqui a exclusão também LIBERA os PDFs importados: apaga
// as linhas de bonificacao_importacoes ligadas a este lançamento (e o
// arquivo no Storage). Sem isso, `uq_bimp_hash` continuaria bloqueando
// reimportar o MESMO arquivo — que é justamente o caso de uso ("importei no
// dia errado, quero corrigir a data"): sem liberar a importação, apagar o
// lançamento não ajudaria em nada.
// ---------------------------------------------------------------------------
export async function excluirLancamento({ organizacaoId, unidadeId, usuario, data: dataRaw, motivo: motivoRaw }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const data = v.dataOpcional(dataRaw, "Data do lançamento");
  if (!data) throw ApiError.badRequest("Informe a data do lançamento a excluir.");
  await exigirCompetenciaEditavel({ unidadeId, dataIso: data, acao: "excluir o lançamento diário" });
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: linha, error } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidade.id).eq("data", data).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!linha) throw ApiError.notFound("Nenhum lançamento encontrado nesta data.");

  // Snapshot ANTES de apagar — tabela própria, sem FK para o lançamento (que
  // está prestes a deixar de existir), então o registro da exclusão nunca
  // some junto com o que foi apagado.
  const { error: eLog } = await supabase.from("bonificacao_lancamentos_exclusoes").insert({
    organizacao_id: organizacaoId, unidade_id: unidade.id, data_lancamento: data,
    lancamento_snapshot: linha, motivo,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  });
  if (eLog) console.error("[bonificacao-mensal] falha ao registrar log de exclusão:", eLog.message);

  // Libera os PDFs para reimportação: arquivo no Storage primeiro (best
  // effort — mesmo espírito de uploadOriginal, um erro aqui não pode travar
  // a exclusão), depois as linhas de bonificacao_importacoes.
  const idsImportacao = [linha.importacao_geral_id, linha.importacao_loja_id].filter(Boolean);
  if (idsImportacao.length) {
    const { data: imps } = await supabase.from(TABELA_IMPORT).select("id, arquivo_storage").in("id", idsImportacao);
    for (const imp of imps || []) {
      if (!imp.arquivo_storage) continue;
      const { error: eStorage } = await supabase.storage.from(BUCKET).remove([imp.arquivo_storage]);
      if (eStorage) console.error("[bonificacao-mensal] falha ao remover arquivo do storage:", eStorage.message);
    }
    const { error: eImp } = await supabase.from(TABELA_IMPORT).delete().in("id", idsImportacao);
    if (eImp) console.error("[bonificacao-mensal] falha ao remover importações do lançamento excluído:", eImp.message);
  }

  const { error: eDel } = await supabase.from(TABELA).delete().eq("id", linha.id);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { excluido: true, data, unidadeId: unidade.id, importacoesLiberadas: idsImportacao.length };
}

// ---------------------------------------------------------------------------
// HISTÓRICO DE MESES (aba Histórico — item 50)
// ---------------------------------------------------------------------------
export async function listarHistoricoMeses({ organizacaoId, unidadeId, ano }) {
  const anoNum = Number(ano) || Number(hojeIsoBrasil().slice(0, 4));
  const meses = [];
  for (let mes = 1; mes <= 12; mes++) {
    const hoje = hojeIsoBrasil();
    const consultaIso = `${anoNum}-${String(mes).padStart(2, "0")}`;
    if (consultaIso > hoje.slice(0, 7)) continue; // não lista meses futuros
    const r = await obterMes({ organizacaoId, unidadeId, ano: anoNum, mes });
    meses.push({
      ano: anoNum, mes, mesFechado: r.mesFechado,
      bonificacaoAtual: r.resumo.bonificacaoAtual, bonificacaoBruta: r.resumo.bonificacaoBruta, bonificacaoMaxima: r.resumo.bonificacaoMaxima,
      metasAtingidas: r.resumo.metasAtingidas, metasComRegra: r.resumo.metasComRegra,
      faturamentoAcumulado: r.faturamento?.acumulado ?? null,
      // Estado da competência: 'aberto' | 'aguardando_fechamento' | 'fechado' | 'reaberto' | 'legado_sem_fechamento'.
      fechamentoStatus: r.fechamentoStatus ?? null,
      origemResultado: r.origemResultado ?? null,
      congelado: !!r.congelado,
      bebidas: r.indicadores?.bebidas?.valorAtual ?? null, adicionais: r.indicadores?.adicionais?.valorAtual ?? null, diversos: r.indicadores?.diversos?.valorAtual ?? null,
      // Elegibilidade da bonificação mensal (Nota iFood + REV + Pesquisas).
      notaIfood: r.indicadores?.avaliacao_ifood?.valorAtual ?? null, rev: r.revMensal?.valor ?? r.indicadores?.rev?.valorAtual ?? null, pesquisas: r.indicadores?.pesquisas?.valorAtual ?? null,
      elegibilidade: r.elegibilidade?.status ?? null,
      // Super Restaurante = Avaliação + Cancelamentos + Pedidos com Chamado.
      cancelamentos: r.indicadores?.cancelamentos?.valorAtual ?? null, pedidosChamado: r.indicadores?.pedidos_chamado?.valorAtual ?? null,
      superRestauranteDentroDaMeta: r.superRestaurante?.dentroDaMeta ?? null, superRestauranteTotalComMeta: r.superRestaurante?.totalComMeta ?? null,
    });
  }
  return meses.reverse();
}
