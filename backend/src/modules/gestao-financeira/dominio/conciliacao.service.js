// Conciliação financeira (B7). Venda realizada ≠ recebimento efetivo. Referências são dados externos (manual / arquivo / PDV futuro):
// nada é inventado. Diferenças só são explicadas por classificação MANUAL autorizada, registrada e auditada (nunca "prazo" automático).
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, enumerado, data, mesAno, valorPositivo, bad, periodo } from "./validacao.js";
import { paraCentavos, ValorInvalidoError } from "../../../financeiro-calculos/dinheiro.js";
import { paraEntradaMotor } from "../../../financeiro-calculos/relatorios.js";
import { conciliar, validarResolucao, agruparPendencias, CLASSIFICACOES, ESCOPO } from "../../../financeiro-calculos/conciliacao.js";
import { primeiroDia, ultimoDia } from "../../../financeiro-calculos/periodos.js";
import { lerReferencias, chaveReferencia } from "./importacao/leitorReferencias.js";
import { ApiError } from "../../../shared/ApiError.js";
import * as lanc from "./lancamentos.service.js";

const padrao = { repo: repositorio, db: undefined };
const TIPOS_REF = ["venda", "taxa", "sangria", "dinheiro"];

/** Carrega tudo do mês e calcula a conciliação (usado também pelo fechamento). */
export async function calcularMes(ctx, mes, deps = padrao) {
  const [lancs, cats, contas, refs, resols, exc] = await Promise.all([
    deps.repo.listarTodosLancamentos(ctx, { de: primeiroDia(mes), ate: ultimoDia(mes) }, deps.db), deps.repo.listarPlanoContas(ctx, deps.db), deps.repo.listarContas(ctx, deps.db),
    deps.repo.listarReferencias(ctx, { mes }, deps.db), deps.repo.listarResolucoes(ctx, { mes }, deps.db), deps.repo.listarExcecoesSangria(ctx, { apenasAtivas: true }, deps.db),
  ]);
  const porId = new Map(cats.map((c) => [c.id, c]));
  const mov = paraEntradaMotor(lancs, porId);
  const resultado = conciliar({
    mes, lancamentos: mov.map((l) => ({ ...l, data: l.data })), contas,
    referencias: refs.map((r) => ({ id: r.id, data: r.data, tipo: r.tipo, canal: r.canal, valorCentavos: Number(r.valor_centavos) })),
    excecoesSangria: new Set(exc.map((e) => e.categoria_id)),
    resolucoes: resols.map((r) => ({ id: r.id, escopo: r.escopo, chave: r.chave, classificacao: r.classificacao, valorCentavos: Number(r.valor_centavos), nota: r.nota })),
  });
  return { resultado, referencias: refs, excecoes: exc, categorias: cats, contas, lancamentos: lancs };
}

export async function resumo(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes);
  const { resultado, referencias, excecoes, categorias } = await calcularMes(c, mes, deps);
  const nomeCat = new Map(categorias.map((x) => [x.id, x.nome]));
  return {
    ...resultado,
    referencias: referencias.map((r) => ({ id: r.id, data: r.data, tipo: r.tipo, canal: r.canal, valorCentavos: Number(r.valor_centavos), fonte: r.fonte, nota: r.nota })),
    excecoesSangria: excecoes.map((e) => ({ id: e.id, categoriaId: e.categoria_id, categoria: nomeCat.get(e.categoria_id) ?? null, motivo: e.motivo, aprovadaEm: e.aprovada_em })),
    classificacoesPossiveis: CLASSIFICACOES,
  };
}

export async function pendencias(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const lancs = await deps.repo.listarTodosLancamentos(c, p, deps.db);
  return { periodo: p, ...agruparPendencias(lancs) };
}

// ---- referências ----
export async function listarReferencias(ctx, q, deps = padrao) {
  return deps.repo.listarReferencias(exigirContexto(ctx), { mes: q?.mes ? mesAno(q.mes) : undefined, incluirCanceladas: q?.todas === "true" }, deps.db);
}

export async function registrarReferencias(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  if (!Array.isArray(b?.itens) || !b.itens.length || b.itens.length > 500) throw bad("Informe de 1 a 500 itens.", "ITENS_INVALIDOS");
  const itens = b.itens.map((i, k) => {
    let valor;
    try { valor = paraCentavos(i?.valor); } catch (e) { if (e instanceof ValorInvalidoError) throw bad(`Item ${k + 1}: valor inválido.`, "VALOR_INVALIDO"); throw e; }
    if (valor == null || valor < 0) throw bad(`Item ${k + 1}: valor obrigatório (zero é permitido e significa "zero informado").`, "VALOR_INVALIDO");
    const canal = typeof i?.canal === "string" && i.canal.trim() ? i.canal.trim().toUpperCase().slice(0, 40) : null;
    return { data: data(i?.data, `Item ${k + 1}: data`), tipo: enumerado(i?.tipo, `Item ${k + 1}: tipo`, TIPOS_REF), canal, valor_centavos: valor, fonte: "manual", nota: texto(i?.nota, "nota", { max: 500, obrigatorio: false }) };
  });
  return deps.repo.inserirReferencias(c, itens, deps.db);
}

/** Importa referências de um CSV/XLSX genérico. `simular:true` valida e conta sem gravar. Idempotente (impressão + ocorrência). */
export async function importarReferencias(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const b64 = b?.conteudoBase64;
  if (typeof b64 !== "string" || !b64) throw bad("Arquivo não enviado.", "ARQUIVO_AUSENTE");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad("Arquivo em formato inválido.", "ARQUIVO_INVALIDO");
  const { itens, erros } = (deps.leitorReferencias ?? lerReferencias)(Buffer.from(b64, "base64"));
  if (b?.simular === true || erros.length) return { simulado: true, lidos: itens.length, erros, gravados: 0, ignorados: 0, bloqueadoPorErros: erros.length > 0 && b?.simular !== true };
  const r = await deps.repo.inserirReferencias(c, itens, deps.db);
  return { simulado: false, lidos: itens.length, erros: [], ...r };
}

export async function cancelarReferencia(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await deps.repo.cancelarReferencia(c, uuid(id, "id"), texto(b?.motivo, "motivo", { max: 500 }), deps.db);
  if (!r) throw ApiError.notFound("Referência ativa não encontrada.");
  return { cancelada: true };
}

// ---- classificação manual autorizada ----
export async function classificar(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const escopo = enumerado(b?.escopo, "escopo", Object.values(ESCOPO));
  const chave = data(b?.chave, "chave");
  const mes = chave.slice(0, 7);
  if (escopo === ESCOPO.PONTE && chave !== `${mes}-01`) throw bad("A ponte mensal usa o primeiro dia do mês como chave.", "CHAVE_INVALIDA");
  let valorCentavos;
  try { valorCentavos = paraCentavos(b?.valor); } catch { throw bad("valor inválido.", "VALOR_INVALIDO"); }
  const { resultado } = await calcularMes(c, mes, deps);
  const dados = { escopo, chave, classificacao: b?.classificacao, valorCentavos, nota: b?.nota };
  const erros = validarResolucao(resultado, dados);
  if (erros.length) throw bad(erros.join(" "), "CLASSIFICACAO_INVALIDA");
  const item = escopo === ESCOPO.PONTE ? resultado.ponte : (escopo === ESCOPO.CAIXA ? resultado.caixaDias : resultado.sangriaDias).find((d) => d.chave === chave);
  const diferenca = escopo === ESCOPO.PONTE ? item.residualCentavos : item.diferencaCentavos;
  return deps.repo.inserirResolucao(c, { escopo, chave, classificacao: b.classificacao, valor_centavos: valorCentavos, diferenca_no_momento_centavos: diferenca, nota: String(b.nota).trim() }, deps.db);
}

export async function revogarClassificacao(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await deps.repo.revogarResolucao(c, uuid(id, "id"), texto(b?.motivo, "motivo", { max: 500 }), deps.db);
  if (!r) throw ApiError.notFound("Classificação vigente não encontrada.");
  return { revogada: true };
}

// ---- exceções de sangria (configuráveis, aprovadas e auditáveis) ----
export async function listarExcecoes(ctx, deps = padrao) { return deps.repo.listarExcecoesSangria(exigirContexto(ctx), {}, deps.db); }
export async function aprovarExcecao(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const categoriaId = uuid(b?.categoriaId, "categoriaId");
  const cat = (await deps.repo.listarPlanoContas(c, deps.db)).find((x) => x.id === categoriaId);
  if (!cat) throw bad("Categoria não encontrada.", "CATEGORIA_INEXISTENTE");
  const motivo = texto(b?.motivo, "motivo", { max: 500 });
  if (motivo.length < 5) throw bad("Informe o motivo da exceção (mínimo de 5 caracteres).", "MOTIVO_OBRIGATORIO");
  return deps.repo.inserirExcecaoSangria(c, { categoria_id: categoriaId, motivo }, deps.db);
}
export async function desativarExcecao(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await deps.repo.desativarExcecaoSangria(c, uuid(id, "id"), texto(b?.motivo, "motivo", { max: 500 }), deps.db);
  if (!r) throw ApiError.notFound("Exceção ativa não encontrada.");
  return { desativada: true };
}

/** Classificação manual de um lançamento pendente (autorizada por `conciliar`): reutiliza as regras do lançamento (nota obrigatória, trilha). */
export async function resolverPendencia(ctx, id, b, deps = padrao) {
  const corpo = { notaRevisao: b?.nota, classificacaoPendente: false };
  if (b?.categoriaId) corpo.categoriaId = b.categoriaId;
  return lanc.atualizarLancamento(ctx, id, corpo, deps);
}

export { valorPositivo, chaveReferencia };
