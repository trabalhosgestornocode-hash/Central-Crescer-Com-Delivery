// NÚCLEO MENTORADOS — serviço (Painel Administrativo).
//
// Leituras cross-tenant com service_role, SEMPRE filtradas pela empresa do parâmetro (nunca uma consulta "de todos" que
// depois é filtrada na memória para um mentorado). Fontes:
//   * mentoria_*                         — cadastro, histórico importado, registros e apresentações (migration 162)
//   * lancamentos_financeiros_diarios    — Dashboard iFood (SOMENTE LEITURA; o cálculo mensal é o oficial do Dashboard:
//                                          snapshotFinanceiroMaisRecente / desempenhoParaTicketMedio / novosClientesAcumulados)
// Nenhum registro financeiro oficial é escrito aqui.

import { createHash } from "node:crypto";
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar } from "../../shared/auditoria.js";
import { hojeIsoBrasil, snapshotFinanceiroMaisRecente, desempenhoParaTicketMedio, novosClientesAcumulados, diasDoMes } from "../dashboard-executivo/dashboardExecutivo.calc.js";
import * as calc from "./calc.js";
import { lerPlanilhaHistorico } from "./leitorPlanilha.js";

export const ACOES_NUCLEO = Object.freeze({
  PARTICIPANTE_SALVO: "nucleo_mentorados.participante_salvo",
  REGISTRO_CRIADO: "nucleo_mentorados.registro_criado",
  REGISTRO_ALTERADO: "nucleo_mentorados.registro_alterado",
  REGISTRO_REMOVIDO: "nucleo_mentorados.registro_removido",
  IMPORTACAO_CONFIRMADA: "nucleo_mentorados.importacao_confirmada",
  APRESENTACAO_GERADA: "nucleo_mentorados.apresentacao_gerada",
  APRESENTACAO_EXPORTADA: "nucleo_mentorados.apresentacao_exportada",
  VINCULO_EM_MASSA: "nucleo_mentorados.vinculo_em_massa",
  FONTE_ESCOLHIDA: "nucleo_mentorados.fonte_escolhida",
  FONTE_REVOGADA: "nucleo_mentorados.fonte_escolha_revogada",
});

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_TABELA_AUSENTE = /mentoria_|does not exist|schema cache|could not find the (table|function)/i;

const naoInstalado = () => new ApiError(503, "O Núcleo Mentorados ainda não foi instalado neste ambiente (migration 162).", { codigo: "NUCLEO_NAO_INSTALADO" });

function falha(error) {
  if (error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202" || RE_TABELA_AUSENTE.test(error.message || ""))) return naoInstalado();
  return ApiError.internal(error?.message || "Falha ao consultar o banco.");
}
const dados = ({ data, error }) => { if (error) throw falha(error); return data; };

export function validarUuid(v, nome = "id") {
  if (typeof v !== "string" || !RE_UUID.test(v)) throw ApiError.badRequest(`${nome} inválido.`, { codigo: "ID_INVALIDO" });
  return v.toLowerCase();
}
function validarData(v, nome, { obrigatoria = false } = {}) {
  if (v == null || v === "") { if (obrigatoria) throw ApiError.badRequest(`${nome} é obrigatória.`); return null; }
  if (typeof v !== "string" || !RE_DATA.test(v) || Number.isNaN(Date.parse(v))) throw ApiError.badRequest(`${nome} inválida (use AAAA-MM-DD).`);
  return v;
}
function texto(v, nome, max, { obrigatorio = false } = {}) {
  if (v == null || (typeof v === "string" && !v.trim())) { if (obrigatorio) throw ApiError.badRequest(`${nome} é obrigatório.`); return null; }
  if (typeof v !== "string") throw ApiError.badRequest(`${nome} inválido.`);
  const t = v.trim();
  if (t.length > max) throw ApiError.badRequest(`${nome}: no máximo ${max} caracteres.`);
  return t;
}
const umDe = (v, nome, opcoes, padrao) => {
  if (v == null || v === "") return padrao;
  if (!opcoes.includes(v)) throw ApiError.badRequest(`${nome} inválido.`);
  return v;
};

/** Pagina um select até o fim (PostgREST corta em 1.000 linhas). */
async function paginar(fabrica) {
  const saida = [];
  for (let de = 0; ; de += 1000) {
    const lote = dados(await fabrica().range(de, de + 999));
    saida.push(...(lote ?? []));
    if (!lote || lote.length < 1000) return saida;
  }
}

// ---------------------------------------------------------------------------
// Dashboard iFood -> meses canônicos por empresa (soma das unidades; campo ausente em uma unidade = ausente no mês)
// ---------------------------------------------------------------------------
const COLUNAS_LANC = "organizacao_id, unidade_id, data_lancamento, situacao, origem_lancamento, valor_vendas_ifood, taxas_comissoes, servicos_promocoes, taxas_entregadores, qtd_vendas, valor_vendas_bruto, novos_clientes";

export function mesesDoDashboard(linhas) {
  const grupos = new Map(); // "AAAA-MM" -> Map(unidade -> linhas)
  for (const r of linhas) {
    const ym = r.data_lancamento.slice(0, 7);
    const porUni = grupos.get(ym) ?? new Map();
    (porUni.get(r.unidade_id) ?? porUni.set(r.unidade_id, []).get(r.unidade_id)).push(r);
    grupos.set(ym, porUni);
  }
  const meses = [];
  for (const [ym, porUni] of [...grupos].sort(([a], [b]) => a.localeCompare(b))) {
    const [ano, mes] = ym.split("-").map(Number);
    const dias = diasDoMes(ano, mes);
    const acc = { valorVendas: 0, taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, qtdPedidos: 0, valorVendasDesempenho: 0, novosClientes: 0 };
    const ausente = new Set();
    let algumaUnidade = false;
    for (const ls of porUni.values()) {
      const snap = snapshotFinanceiroMaisRecente(ls);
      if (!snap) continue;
      algumaUnidade = true;
      const somar = (chave, v) => { if (v == null) ausente.add(chave); else acc[chave] += Number(v); };
      somar("valorVendas", snap.valor_vendas_ifood);
      somar("taxasComissoes", snap.taxas_comissoes);
      somar("servicosPromocoes", snap.servicos_promocoes);
      somar("taxasEntregadores", snap.taxas_entregadores);
      const desemp = desempenhoParaTicketMedio(ls);
      somar("qtdPedidos", desemp?.qtdVendas ?? null);
      somar("valorVendasDesempenho", desemp?.valorVendasBruto ?? null);
      somar("novosClientes", novosClientesAcumulados(dias, ls));
    }
    if (!algumaUnidade) continue;
    for (const k of ausente) acc[k] = null;
    meses.push(calc.mesCanonico(ym, acc));
  }
  return meses;
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------
async function carregarParticipantes(db, orgIds = null) {
  let q = db.from("mentoria_participantes").select("*");
  if (orgIds) q = q.in("organizacao_id", orgIds);
  return dados(await q) ?? [];
}

async function carregarSeries(db, orgIds) {
  if (!orgIds.length) return new Map();
  const [importados, lancamentos, importacoes, escolhas, mudancas] = await Promise.all([
    paginar(() => db.from("mentoria_historico_mensal").select("*").in("organizacao_id", orgIds).order("mes")),
    paginar(() => db.from("lancamentos_financeiros_diarios").select(COLUNAS_LANC).in("organizacao_id", orgIds).order("data_lancamento")),
    paginar(() => db.from("mentoria_importacoes").select("id, organizacao_id, arquivo_nome, arquivo_sha256, leitor_versao, mes_inicio, mes_fim, meses, metas, created_at, importado_por_email").in("organizacao_id", orgIds).order("created_at")),
    paginar(() => db.from("mentoria_escolhas_fonte").select("*").in("organizacao_id", orgIds).order("created_at")),
    paginar(() => db.from("mentoria_registros").select("organizacao_id, data_registro, titulo, modelo_anterior, modelo_novo").in("organizacao_id", orgIds).eq("tipo", "mudanca_operacional").order("data_registro")),
  ]);
  const por = (lista) => { const m = new Map(); for (const r of lista) (m.get(r.organizacao_id) ?? m.set(r.organizacao_id, []).get(r.organizacao_id)).push(r); return m; };
  const imp = por(importados), lanc = por(lancamentos), imps = por(importacoes), esc = por(escolhas), mud = por(mudancas);
  const saida = new Map();
  for (const org of orgIds) {
    saida.set(org, {
      importacao: (imp.get(org) ?? []).map(calc.mesDaImportacao),
      dashboard: mesesDoDashboard(lanc.get(org) ?? []),
      importacoes: imps.get(org) ?? [],
      escolhasBrutas: esc.get(org) ?? [],
      escolhas: (esc.get(org) ?? []).map(escolhaParaCalc),
      mudancas: (mud.get(org) ?? []).map((r) => ({ mes: r.data_registro, de: r.modelo_anterior, para: r.modelo_novo, titulo: r.titulo })),
    });
  }
  return saida;
}

const escolhaParaCalc = (e) => ({ id: e.id, inicio: e.mes_inicio, fim: e.mes_fim, grupo: e.grupo, fonte: e.fonte, criadaEm: e.created_at, revogada: !!e.revogada_em });

/** Metas: as da importação mais recente (rótulos da planilha) + metas registradas pelo mentor (vencem). */
function metasVigentes(importacoes, registros = []) {
  const ultima = importacoes.at(-1)?.metas ?? {};
  const metas = {};
  for (const k of ["taxasComissoes", "servicosPromocoes", "taxasMaisServicos", "taxasEntregadores", "custosIfoodTotal"]) {
    if (ultima[k]?.maximo != null) metas[k] = ultima[k].maximo;
  }
  for (const r of registros) if (r.tipo === "meta" && r.meta_indicador && r.meta_valor != null && r.meta_unidade === "percentual") metas[r.meta_indicador] = Number(r.meta_valor);
  return { maximos: metas, referencia: ultima };
}

function analisarEmpresa({ participante, serieFontes, registros = [], hojeIso }) {
  const { meses, divergencias } = calc.consolidarSerie({ importacao: serieFontes.importacao, dashboard: serieFontes.dashboard, preferencia: participante.fonte_preferencial, escolhas: serieFontes.escolhas });
  const metas = metasVigentes(serieFontes.importacoes, registros);
  const analise = calc.analisar({ participante, serie: meses, divergencias, metas: metas.maximos, hojeIso, mudancas: serieFontes.mudancas });
  return { serie: meses, divergencias, metas, analise };
}

// ---------------------------------------------------------------------------
// Casos de uso
// ---------------------------------------------------------------------------

/** Listagem: só empresas CADASTRADAS como participantes. Nenhuma empresa vira mentorada por existir. */
export async function listar({ hojeIso } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const hoje = hojeIso ?? hojeIsoBrasil();
  const participantes = await carregarParticipantes(db);
  const orgIds = participantes.map((p) => p.organizacao_id);
  const [orgs, series] = await Promise.all([
    orgIds.length ? dados(await db.from("organizacoes").select("id, nome, status, responsavel_nome").in("id", orgIds)) : [],
    carregarSeries(db, orgIds),
  ]);
  const orgPorId = new Map((orgs ?? []).map((o) => [o.id, o]));
  const itens = participantes.map((p) => {
    const org = orgPorId.get(p.organizacao_id) ?? {};
    const { analise, divergencias, serie } = analisarEmpresa({ participante: p, serieFontes: series.get(p.organizacao_id), hojeIso: hoje });
    // Manchete = último ciclo COMPLETO (um ciclo parcial de 1 ou 2 meses não resume a mentoria); o ciclo em curso vai à parte.
    const comp = analise.comparativos[analise.comparativoPrincipal] ?? null;
    const emCurso = analise.comparativos.at(-1);
    const vendasEmCurso = emCurso && emCurso !== comp ? emCurso.indicadores.find((i) => i.chave === "valorVendas") : null;
    const vendas = comp?.indicadores.find((i) => i.chave === "valorVendas") ?? null;
    const custos = comp?.indicadores.find((i) => i.chave === "pctTaxasMaisServicos") ?? null;
    return {
      organizacaoId: p.organizacao_id, empresa: org.nome ?? "(empresa removida)", empresaStatus: org.status ?? null,
      responsavel: p.responsavel_nome ?? org.responsavel_nome ?? null, mentor: p.mentor_nome, cidade: p.cidade, uf: p.uf,
      status: p.status, dataEntrada: p.data_entrada, dataRenovacao: p.data_renovacao,
      mesesDeMentoria: analise.periodos.mesesDeMentoria,
      cicloAtual: comp ? { rotulo: comp.ciclo.rotulo, parcial: comp.ciclo.parcial, meses: comp.ciclo.meses, inicio: comp.ciclo.inicio, fim: comp.ciclo.fim, referencia: comp.ciclo.referencia } : null,
      variacaoVendas: vendas ? { comparavel: vendas.comparavel, percentual: vendas.variacaoPercentual, motivo: vendas.motivo } : null,
      cicloEmCurso: vendasEmCurso ? { rotulo: emCurso.ciclo.rotulo, meses: emCurso.ciclo.meses, comparavel: vendasEmCurso.comparavel, percentual: vendasEmCurso.variacaoPercentual } : null,
      custosIfood: custos ? { comparavel: custos.comparavel, atual: custos.atual, referencia: custos.referencia, pontosPercentuais: custos.pontosPercentuais } : null,
      ultimoMesComDado: analise.ultimoMesComDado,
      pendencias: [!p.data_entrada && "data de entrada", !p.data_renovacao && "data de renovação", !p.mentor_nome && "mentor"].filter(Boolean),
      divergenciasPendentes: new Set(divergencias.filter((d) => !d.resolvidaPor).map((d) => d.mes)).size,
      disponibilidade: serie.some((m) => m.valorVendas != null) ? (analise.alertas.some((a) => a.codigo === "ANTES_INCOMPLETO") ? "parcial" : "completa") : "sem_dados",
      divergencias: new Set(divergencias.map((d) => d.mes)).size,
      alertas: analise.alertas,
    };
  }).sort((a, b) => a.empresa.localeCompare(b.empresa, "pt-BR"));
  return { mentorados: itens, total: itens.length, hojeIso: hoje };
}

/** Empresas que podem ser cadastradas (todas as ativas; o cadastro é uma decisão explícita do administrador). */
export async function candidatas({ hojeIso } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const hoje = hojeIso ?? hojeIsoBrasil();
  // "Usa o Dashboard iFood" = tem lançamento nos últimos 90 dias (leitura de 2 colunas, paginada).
  const desde = new Date(Date.parse(hoje) - 90 * 864e5).toISOString().slice(0, 10);
  const [orgs, part, lanc] = await Promise.all([
    paginar(() => db.from("organizacoes").select("id, nome, status, responsavel_nome").eq("eh_modelo", false).order("nome")),
    carregarParticipantes(db),
    paginar(() => db.from("lancamentos_financeiros_diarios").select("organizacao_id, data_lancamento").gte("data_lancamento", desde).order("data_lancamento")),
  ]);
  const ja = new Set(part.map((p) => p.organizacao_id));
  const ultimo = new Map();
  for (const l of lanc) if (!ultimo.has(l.organizacao_id) || l.data_lancamento > ultimo.get(l.organizacao_id)) ultimo.set(l.organizacao_id, l.data_lancamento);
  return {
    empresas: orgs.filter((o) => !ja.has(o.id)).map((o) => ({ id: o.id, nome: o.nome, status: o.status, responsavel: o.responsavel_nome,
      usaDashboardIfood: ultimo.has(o.id), ultimoLancamento: ultimo.get(o.id) ?? null })),
    janelaDashboardDesde: desde,
  };
}

/**
 * Vincula VÁRIAS empresas já cadastradas de uma vez (sem duplicar cadastro). Exige a confirmação explícita de que
 * participam da mentoria. Datas são opcionais e nunca presumidas: sem data de entrada, o vínculo fica pendente.
 * Empresas já vinculadas são devolvidas em `jaVinculadas` e não são alteradas. Uma única inserção (atômica).
 */
export async function vincularEmMassa({ corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  if (corpo.confirmacao !== true) throw ApiError.badRequest("Confirme que as empresas selecionadas participam da mentoria.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  const itens = Array.isArray(corpo.itens) ? corpo.itens : [];
  if (!itens.length || itens.length > 200) throw ApiError.badRequest("Selecione de 1 a 200 empresas.");
  const mentorPadrao = texto(corpo.mentorPadrao, "Mentor", 120);
  const vistos = new Set();
  const linhas = itens.map((it, i) => {
    const orgId = validarUuid(it?.organizacaoId, `itens[${i}].organizacaoId`);
    if (vistos.has(orgId)) throw ApiError.badRequest("Empresa repetida na seleção.");
    vistos.add(orgId);
    const dataEntrada = validarData(it.dataEntrada, `Data de entrada (${i + 1})`);
    const dataRenovacao = validarData(it.dataRenovacao, `Data de renovação (${i + 1})`);
    if (dataEntrada && dataRenovacao && dataRenovacao <= dataEntrada) throw ApiError.badRequest(`Renovação deve ser posterior à entrada (${i + 1}).`);
    return { organizacao_id: orgId, status: "ativa", data_entrada: dataEntrada, data_renovacao: dataRenovacao,
      mentor_nome: texto(it.mentor, "Mentor", 120) ?? mentorPadrao, fonte_preferencial: "dashboard_ifood",
      criado_por: autor?.id ?? null, atualizado_por: autor?.id ?? null };
  });
  const ids = linhas.map((l) => l.organizacao_id);
  const [orgs, existentes] = await Promise.all([
    db.from("organizacoes").select("id, nome, eh_modelo").in("id", ids).then(dados),
    carregarParticipantes(db, ids),
  ]);
  const validas = new Set((orgs ?? []).filter((o) => !o.eh_modelo).map((o) => o.id));
  const inexistentes = ids.filter((id) => !validas.has(id));
  if (inexistentes.length) throw ApiError.badRequest("Há empresas inexistentes na seleção.", { codigo: "EMPRESA_INEXISTENTE", ids: inexistentes });
  const ja = new Set(existentes.map((p) => p.organizacao_id));
  const novas = linhas.filter((l) => !ja.has(l.organizacao_id));
  const gravadas = novas.length ? dados(await db.from("mentoria_participantes").insert(novas).select("organizacao_id, data_entrada, data_renovacao, mentor_nome")) : [];
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.VINCULO_EM_MASSA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_participantes", entidadeId: null, detalhes: { vinculadas: gravadas.map((g) => g.organizacao_id), jaVinculadas: [...ja] }, ip: req?.ip });
  return {
    vinculadas: gravadas.length, jaVinculadas: [...ja],
    pendentes: gravadas.filter((g) => !g.data_entrada || !g.data_renovacao || !g.mentor_nome).map((g) => g.organizacao_id),
  };
}

async function exigirParticipante(db, orgId) {
  const lista = await carregarParticipantes(db, [orgId]);
  if (!lista.length) throw ApiError.notFound("Empresa não cadastrada no Núcleo Mentorados.", { codigo: "NAO_PARTICIPANTE" });
  return lista[0];
}

export async function perfil({ organizacaoId, hojeIso } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const hoje = hojeIso ?? hojeIsoBrasil();
  const participante = await exigirParticipante(db, orgId);
  const [orgArr, series, registros, apresentacoes] = await Promise.all([
    db.from("organizacoes").select("id, nome, status, responsavel_nome, logo_url").eq("id", orgId).then(dados),
    carregarSeries(db, [orgId]),
    db.from("mentoria_registros").select("*").eq("organizacao_id", orgId).order("data_registro", { ascending: false }).then(dados),
    db.from("mentoria_apresentacoes").select("id, versao, titulo, created_at, criado_por_nome, snapshot_sha256").eq("organizacao_id", orgId).order("versao", { ascending: false }).then(dados),
  ]);
  const fontes = series.get(orgId);
  const r = analisarEmpresa({ participante, serieFontes: fontes, registros: registros ?? [], hojeIso: hoje });
  return {
    empresa: orgArr?.[0] ?? { id: orgId }, participante, hojeIso: hoje,
    serie: r.serie, divergencias: r.divergencias, metas: r.metas, analise: r.analise,
    importacoes: fontes.importacoes, registros: registros ?? [], apresentacoes: apresentacoes ?? [], escolhasFonte: fontes.escolhasBrutas,
    fontes: { importacao: fontes.importacao.length, dashboard: fontes.dashboard.length, preferencial: participante.fonte_preferencial },
  };
}

export async function salvarParticipante({ organizacaoId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const org = dados(await db.from("organizacoes").select("id, nome").eq("id", orgId));
  if (!org?.length) throw ApiError.notFound("Empresa não encontrada.");
  const linha = {
    organizacao_id: orgId,
    status: umDe(corpo.status, "status", ["ativa", "pausada", "encerrada"], "ativa"),
    data_entrada: validarData(corpo.dataEntrada, "Data de entrada"),
    data_renovacao: validarData(corpo.dataRenovacao, "Data de renovação"),
    mentor_nome: texto(corpo.mentor, "Mentor", 120),
    responsavel_nome: texto(corpo.responsavel, "Responsável", 120),
    cidade: texto(corpo.cidade, "Cidade", 80),
    uf: corpo.uf ? umDe(String(corpo.uf).toUpperCase(), "UF", UFS, null) : null,
    modelo_operacao: umDe(corpo.modeloOperacao, "Modelo de operação", ["marketplace", "full_service", "misto"], null),
    fonte_preferencial: umDe(corpo.fontePreferencial, "Fonte preferencial", ["importacao", "dashboard_ifood"], "dashboard_ifood"),
    observacoes: texto(corpo.observacoes, "Observações", 2000),
    atualizado_por: autor?.id ?? null,
  };
  if (linha.data_entrada && linha.data_renovacao && linha.data_renovacao <= linha.data_entrada) throw ApiError.badRequest("A renovação deve ser posterior à entrada.");
  const existente = await carregarParticipantes(db, [orgId]);
  const salvo = dados(await db.from("mentoria_participantes")
    .upsert(existente.length ? linha : { ...linha, criado_por: autor?.id ?? null }, { onConflict: "organizacao_id" }).select("*"));
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.PARTICIPANTE_SALVO, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_participantes", entidadeId: orgId, organizacaoId: orgId,
    detalhes: { novo: !existente.length, antes: existente[0] ?? null, depois: salvo?.[0] ?? null }, ip: req?.ip, userAgent: req?.get?.("user-agent") });
  return { participante: salvo?.[0] ?? null };
}

const TIPOS_REGISTRO = ["diagnostico", "estrategia", "meta", "evidencia", "observacao", "mudanca_operacional"];
const MODELOS = ["marketplace", "full_service", "misto", "outro"];
const INDICADORES_VALIDOS = new Set(calc.INDICADORES.map((i) => i.chave).concat(["taxasMaisServicos", "custosIfoodTotal"]));

function normalizarRegistro(corpo) {
  const indicadores = Array.isArray(corpo.indicadores) ? corpo.indicadores : [];
  if (indicadores.length > 12 || indicadores.some((i) => !INDICADORES_VALIDOS.has(i))) throw ApiError.badRequest("Indicadores inválidos.");
  const tipo = umDe(corpo.tipo, "tipo", TIPOS_REGISTRO, null);
  if (!tipo) throw ApiError.badRequest("tipo é obrigatório.");
  const linha = {
    tipo, data_registro: validarData(corpo.data, "Data", { obrigatoria: true }),
    titulo: texto(corpo.titulo, "Título", 160, { obrigatorio: true }), descricao: texto(corpo.descricao, "Descrição", 4000),
    indicadores, privado: typeof corpo.privado === "boolean" ? corpo.privado : tipo === "observacao",
    meta_indicador: null, meta_valor: null, meta_unidade: null, modelo_anterior: null, modelo_novo: null,
  };
  if (tipo === "mudanca_operacional") {
    linha.modelo_novo = umDe(corpo.modeloNovo, "Novo modelo", MODELOS, null);
    linha.modelo_anterior = umDe(corpo.modeloAnterior, "Modelo anterior", MODELOS, null);
    if (!linha.modelo_novo) throw ApiError.badRequest("Informe o novo modelo operacional.");
    if (linha.modelo_anterior === linha.modelo_novo) throw ApiError.badRequest("O novo modelo deve ser diferente do anterior.");
    linha.privado = typeof corpo.privado === "boolean" ? corpo.privado : false; // contexto que a apresentação deve mostrar
  }
  if (tipo === "meta") {
    linha.meta_indicador = corpo.metaIndicador ?? null;
    if (linha.meta_indicador && !INDICADORES_VALIDOS.has(linha.meta_indicador)) throw ApiError.badRequest("Indicador da meta inválido.");
    if (corpo.metaValor != null && corpo.metaValor !== "") {
      const v = Number(corpo.metaValor);
      if (!Number.isFinite(v)) throw ApiError.badRequest("Valor da meta inválido.");
      linha.meta_valor = v;
    }
    linha.meta_unidade = umDe(corpo.metaUnidade, "Unidade da meta", ["reais", "percentual", "quantidade"], null);
  }
  return linha;
}

export async function criarRegistro({ organizacaoId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  await exigirParticipante(db, orgId);
  const linha = { ...normalizarRegistro(corpo), organizacao_id: orgId, autor_id: autor?.id ?? null, autor_nome: autor?.nome ?? null };
  const salvo = dados(await db.from("mentoria_registros").insert(linha).select("*"));
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.REGISTRO_CRIADO, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_registros", entidadeId: salvo?.[0]?.id, organizacaoId: orgId, detalhes: { tipo: linha.tipo, titulo: linha.titulo }, ip: req?.ip });
  return { registro: salvo?.[0] ?? null };
}

export async function alterarRegistro({ organizacaoId, registroId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const id = validarUuid(registroId, "registroId");
  const linha = normalizarRegistro(corpo);
  // Filtro duplo (id + empresa): um id de outra empresa nunca é alterado por esta rota.
  const salvo = dados(await db.from("mentoria_registros").update(linha).eq("id", id).eq("organizacao_id", orgId).select("*"));
  if (!salvo?.length) throw ApiError.notFound("Registro não encontrado.");
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.REGISTRO_ALTERADO, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_registros", entidadeId: id, organizacaoId: orgId, detalhes: { tipo: linha.tipo, titulo: linha.titulo }, ip: req?.ip });
  return { registro: salvo[0] };
}

export async function removerRegistro({ organizacaoId, registroId, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const id = validarUuid(registroId, "registroId");
  const apagado = dados(await db.from("mentoria_registros").delete().eq("id", id).eq("organizacao_id", orgId).select("id, tipo, titulo"));
  if (!apagado?.length) throw ApiError.notFound("Registro não encontrado.");
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.REGISTRO_REMOVIDO, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_registros", entidadeId: id, organizacaoId: orgId, detalhes: apagado[0], ip: req?.ip });
  return { removido: id };
}

// ---------------------------------------------------------------------------
// Escolha auditável da fonte válida (por período e grupo). Nunca altera dado nenhum.
// ---------------------------------------------------------------------------
const RE_YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const mesParaData = (ym, nome) => {
  if (typeof ym !== "string" || !RE_YM.test(ym)) throw ApiError.badRequest(`${nome} inválido (use AAAA-MM).`);
  return `${ym}-01`;
};

export async function escolherFonte({ organizacaoId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  await exigirParticipante(db, orgId);
  const linha = {
    organizacao_id: orgId,
    mes_inicio: mesParaData(corpo.inicio, "Mês inicial"), mes_fim: mesParaData(corpo.fim, "Mês final"),
    grupo: umDe(corpo.grupo, "Grupo", ["financeiro", "desempenho"], null),
    fonte: umDe(corpo.fonte, "Fonte", ["importacao", "dashboard_ifood"], null),
    justificativa: texto(corpo.justificativa, "Justificativa", 1000, { obrigatorio: true }),
    criado_por: autor?.id ?? null, criado_por_nome: autor?.nome ?? null,
  };
  if (!linha.grupo || !linha.fonte) throw ApiError.badRequest("Informe o grupo e a fonte.");
  if (linha.mes_fim < linha.mes_inicio) throw ApiError.badRequest("O mês final deve ser igual ou posterior ao inicial.");
  if (linha.justificativa.length < 10) throw ApiError.badRequest("Justificativa: escreva ao menos 10 caracteres.");
  const salvo = dados(await db.from("mentoria_escolhas_fonte").insert(linha).select("*"));
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.FONTE_ESCOLHIDA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_escolhas_fonte", entidadeId: salvo?.[0]?.id, organizacaoId: orgId,
    detalhes: { inicio: corpo.inicio, fim: corpo.fim, grupo: linha.grupo, fonte: linha.fonte, justificativa: linha.justificativa }, ip: req?.ip });
  return { escolha: salvo?.[0] ?? null };
}

export async function revogarEscolhaFonte({ organizacaoId, escolhaId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const id = validarUuid(escolhaId, "escolhaId");
  const motivo = texto(corpo.motivo, "Motivo", 1000, { obrigatorio: true });
  if (motivo.length < 10) throw ApiError.badRequest("Motivo: escreva ao menos 10 caracteres.");
  const atual = dados(await db.from("mentoria_escolhas_fonte").select("id, revogada_em").eq("id", id).eq("organizacao_id", orgId));
  if (!atual?.length) throw ApiError.notFound("Escolha não encontrada.");
  if (atual[0].revogada_em) throw ApiError.badRequest("Esta escolha já foi revogada.");
  const salvo = dados(await db.from("mentoria_escolhas_fonte").update({ revogada_em: new Date().toISOString(), revogada_por: autor?.id ?? null, motivo_revogacao: motivo })
    .eq("id", id).eq("organizacao_id", orgId).select("*"));
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.FONTE_REVOGADA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_escolhas_fonte", entidadeId: id, organizacaoId: orgId, detalhes: { motivo }, ip: req?.ip });
  return { escolha: salvo?.[0] ?? null };
}

// ---------------------------------------------------------------------------
// Importação da planilha: PRÉVIA (nada é gravado) -> CONFIRMAÇÃO (atômica e idempotente)
// ---------------------------------------------------------------------------
function decodificar(corpo) {
  const nome = texto(corpo.arquivoNome, "Nome do arquivo", 255, { obrigatorio: true });
  if (typeof corpo.conteudoBase64 !== "string" || !corpo.conteudoBase64) throw ApiError.badRequest("Arquivo ausente.");
  return { nome, buffer: Buffer.from(corpo.conteudoBase64, "base64") };
}

/** Diagnóstico de duplicidade e compatibilidade: o que a importação faria, sem gravar. */
export function diagnosticarImportacao({ lido, existentes, importacoesAnteriores, dashboard, preferencia }) {
  const jaImportada = importacoesAnteriores.find((i) => i.arquivo_sha256 === lido.sha256) ?? null;
  const novos = lido.meses.map(calc.mesDaImportacao);
  const atuais = new Map(existentes.map((m) => [m.mes, m]));
  const substituicoes = [];
  for (const m of novos) {
    const a = atuais.get(m.mes);
    if (!a) continue;
    const campos = Object.keys(calc.CAMPOS).filter((c) => a[c] !== m[c]);
    if (campos.length) substituicoes.push({ mes: m.mes, campos });
  }
  const { divergencias } = calc.consolidarSerie({ importacao: novos, dashboard, preferencia });
  const sobrepostos = novos.filter((m) => dashboard.some((d) => d.mes === m.mes)).map((m) => m.mes);
  const cobertura = {};
  for (const c of Object.keys(calc.CAMPOS)) cobertura[c] = novos.filter((m) => m[c] != null).length;
  return {
    arquivoSha256: lido.sha256, leitorVersao: lido.leitorVersao, titulo: lido.titulo,
    intervalo: { inicio: novos[0].mes, fim: novos.at(-1).mes, meses: novos.length },
    jaImportada: jaImportada ? { id: jaImportada.id, em: jaImportada.created_at, arquivo: jaImportada.arquivo_nome } : null,
    mesesNovos: novos.filter((m) => !atuais.has(m.mes)).length,
    mesesSubstituidos: substituicoes,
    mesesIguais: novos.filter((m) => atuais.has(m.mes) && !substituicoes.some((s) => s.mes === m.mes)).length,
    sobreposicaoDashboard: sobrepostos,
    divergenciasDashboard: divergencias,
    cobertura,
    metas: lido.metas, notas: lido.notas, avisos: lido.avisos,
    regra: "Cada mês usa UMA fonte (a preferencial da empresa); a outra aparece como divergência e nunca é somada. Nenhum registro do Dashboard iFood é alterado.",
    meses: novos,
  };
}

export async function previaImportacao({ organizacaoId, corpo = {} } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const participante = await exigirParticipante(db, orgId);
  const { nome, buffer } = decodificar(corpo);
  const lido = lerPlanilhaHistorico(buffer, { arquivoNome: nome });
  const fontes = (await carregarSeries(db, [orgId])).get(orgId);
  return diagnosticarImportacao({ lido, existentes: fontes.importacao, importacoesAnteriores: fontes.importacoes, dashboard: fontes.dashboard, preferencia: participante.fonte_preferencial });
}

export async function confirmarImportacao({ organizacaoId, corpo = {}, autor, req } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const participante = await exigirParticipante(db, orgId);
  const { nome, buffer } = decodificar(corpo);
  const lido = lerPlanilhaHistorico(buffer, { arquivoNome: nome });
  // A confirmação exige o hash que o usuário viu na prévia: arquivo trocado no meio = recusa.
  if (corpo.arquivoSha256 !== lido.sha256) throw ApiError.badRequest("O arquivo mudou desde a prévia. Gere a prévia novamente.", { codigo: "PREVIA_DESATUALIZADA" });
  const fontes = (await carregarSeries(db, [orgId])).get(orgId);
  const diag = diagnosticarImportacao({ lido, existentes: fontes.importacao, importacoesAnteriores: fontes.importacoes, dashboard: fontes.dashboard, preferencia: participante.fonte_preferencial });
  const { meses: _m, ...diagSemMeses } = diag;
  const r = dados(await db.rpc("mentoria_importar_historico", {
    p_org: orgId,
    p_importacao: {
      arquivo_nome: nome, arquivo_sha256: lido.sha256, leitor_versao: lido.leitorVersao,
      mes_inicio: lido.meses[0].mes, mes_fim: lido.meses.at(-1).mes, meses: lido.meses.length,
      metas: lido.metas, diagnostico: { ...diagSemMeses, divergenciasDashboard: diag.divergenciasDashboard.length },
      importado_por: autor?.id ?? "", importado_por_email: autor?.email ?? null,
    },
    p_meses: lido.meses,
  }));
  const linha = Array.isArray(r) ? r[0] : r;
  if (!linha?.ja_existia) {
    await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.IMPORTACAO_CONFIRMADA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
      entidade: "mentoria_importacoes", entidadeId: linha?.importacao_id, organizacaoId: orgId,
      detalhes: { arquivo: nome, sha256: lido.sha256, meses: lido.meses.length, substituidos: diag.mesesSubstituidos.length }, ip: req?.ip });
  }
  // Opcional: manter a planilha como fonte válida nos meses que o Dashboard também tem (ex.: números já homologados
  // cujas divergências ainda estão em análise). Vira uma escolha auditável comum, revogável depois.
  let escolha = null;
  const pres = corpo.preservarPlanilhaNaSobreposicao;
  if (pres && diag.sobreposicaoDashboard.length) {
    escolha = (await escolherFonte({ organizacaoId: orgId, autor, req, corpo: {
      inicio: diag.sobreposicaoDashboard[0], fim: diag.sobreposicaoDashboard.at(-1), grupo: "financeiro", fonte: "importacao",
      justificativa: pres.justificativa } }, deps)).escolha;
  }
  return { importacaoId: linha?.importacao_id ?? null, jaExistia: !!linha?.ja_existia, mesesGravados: linha?.meses_gravados ?? 0, escolhaId: escolha?.id ?? null };
}

// ---------------------------------------------------------------------------
// Apresentações: o snapshot guarda EXATAMENTE os números exibidos (reabrir não recalcula)
// ---------------------------------------------------------------------------
export function montarSnapshot(p) {
  return {
    versaoSnapshot: 1,
    geradoEm: new Date().toISOString(),
    hojeIso: p.hojeIso,
    empresa: { id: p.empresa.id, nome: p.empresa.nome },
    participante: {
      dataEntrada: p.participante.data_entrada, dataRenovacao: p.participante.data_renovacao, mentor: p.participante.mentor_nome,
      cidade: p.participante.cidade, uf: p.participante.uf, modeloOperacao: p.participante.modelo_operacao, fontePreferencial: p.participante.fonte_preferencial,
    },
    serie: p.serie, divergencias: p.divergencias, metas: p.metas, analise: p.analise,
    registros: p.registros.map((r) => ({ id: r.id, tipo: r.tipo, data: r.data_registro, titulo: r.titulo, descricao: r.descricao, indicadores: r.indicadores, privado: r.privado, metaIndicador: r.meta_indicador, metaValor: r.meta_valor, metaUnidade: r.meta_unidade, modeloAnterior: r.modelo_anterior, modeloNovo: r.modelo_novo })),
    fontes: {
      importacoes: p.importacoes.map((i) => ({ id: i.id, arquivo: i.arquivo_nome, sha256: i.arquivo_sha256, leitor: i.leitor_versao, em: i.created_at, inicio: i.mes_inicio, fim: i.mes_fim })),
      dashboardIfood: { meses: p.fontes.dashboard, regra: "snapshot mensal oficial do Dashboard iFood (somente leitura)" },
      preferencial: p.fontes.preferencial,
      escolhas: (p.escolhasFonte ?? []).filter((e) => !e.revogada_em).map((e) => ({ id: e.id, inicio: e.mes_inicio, fim: e.mes_fim, grupo: e.grupo, fonte: e.fonte, justificativa: e.justificativa, em: e.created_at, por: e.criado_por_nome })),
    },
  };
}

const SLIDES = ["capa", "diagnostico", "estrategias", "vendas", "evolucao", "clientes", "eficiencia", "metas", "oportunidades", "plano"];

function normalizarConfiguracao(c = {}) {
  const ocultos = Array.isArray(c.slidesOcultos) ? c.slidesOcultos.filter((s) => SLIDES.includes(s)) : [];
  const notas = {};
  for (const s of SLIDES) { const t = texto(c.notas?.[s], `Nota (${s})`, 2000); if (t) notas[s] = t; }
  return {
    slidesOcultos: [...new Set(ocultos)],
    ocultarIndisponiveis: c.ocultarIndisponiveis !== false,
    notas, // privadas do mentor: só aparecem na visão do apresentador
    oportunidades: texto(c.oportunidades, "Oportunidades", 3000),
    plano: texto(c.plano, "Plano do próximo ciclo", 3000),
  };
}

export async function gerarApresentacao({ organizacaoId, corpo = {}, autor, req, hojeIso } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const p = await perfil({ organizacaoId, hojeIso }, deps);
  const orgId = p.empresa.id;
  const snapshot = montarSnapshot(p);
  const configuracao = normalizarConfiguracao(corpo.configuracao);
  const titulo = texto(corpo.titulo, "Título", 160) ?? `Resultados da mentoria — ${p.empresa.nome ?? ""}`.slice(0, 160);
  const sha = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const versao = (p.apresentacoes[0]?.versao ?? 0) + 1 + tentativa;
    const { data, error } = await db.from("mentoria_apresentacoes").insert({
      organizacao_id: orgId, versao, titulo, configuracao, snapshot, snapshot_sha256: sha,
      criado_por: autor?.id ?? null, criado_por_nome: autor?.nome ?? null,
    }).select("id, versao, titulo, created_at, snapshot_sha256");
    if (error?.code === "23505") continue; // corrida de versão: tenta a próxima
    if (error) throw falha(error);
    await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.APRESENTACAO_GERADA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
      entidade: "mentoria_apresentacoes", entidadeId: data[0].id, organizacaoId: orgId, detalhes: { versao, sha256: sha }, ip: req?.ip });
    return { apresentacao: data[0] };
  }
  throw ApiError.internal("Não foi possível reservar a versão da apresentação.");
}

export async function obterApresentacao({ organizacaoId, apresentacaoId } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const orgId = validarUuid(organizacaoId, "organizacaoId");
  const id = validarUuid(apresentacaoId, "apresentacaoId");
  const r = dados(await db.from("mentoria_apresentacoes").select("*").eq("id", id).eq("organizacao_id", orgId));
  if (!r?.length) throw ApiError.notFound("Apresentação não encontrada.");
  return { apresentacao: r[0] };
}

export async function registrarExportacao({ organizacaoId, apresentacaoId, formato, autor, req } = {}, deps = {}) {
  const { apresentacao } = await obterApresentacao({ organizacaoId, apresentacaoId }, deps);
  const f = umDe(formato, "formato", ["pdf"], "pdf");
  await (deps.auditar ?? auditar)({ acao: ACOES_NUCLEO.APRESENTACAO_EXPORTADA, atorId: autor?.id, atorEmail: autor?.email, perfilId: autor?.perfilId,
    entidade: "mentoria_apresentacoes", entidadeId: apresentacao.id, organizacaoId: apresentacao.organizacao_id, detalhes: { formato: f, versao: apresentacao.versao }, ip: req?.ip });
  return { registrado: true };
}

const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
