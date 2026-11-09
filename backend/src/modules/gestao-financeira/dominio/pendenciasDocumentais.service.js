// PENDÊNCIAS DOCUMENTAIS (migration 156): cadastro manual, na Central de Conferências, do que depende de comprovação, classificação ou aprovação
// e que NÃO é um registro financeiro do sistema (ex.: diferença de caixa sem destino). Registrar uma pendência NUNCA cria lançamento,
// pagamento, recebimento ou conciliação, e nunca altera os dados originais. Confirmar exige evidência + permissão (CLASSIFICAR na rota) e
// registra quem, quando e com base em qual documento. Cada alteração fica na trilha de auditoria (fin_auditar).
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, valorOuNulo, mesAno, enumerado, data, bad } from "./validacao.js";

const padrao = { repo: repositorio, db: undefined, agora: () => new Date().toISOString() };
export const ESTADOS = ["pendente", "estimado", "aguardando_comprovacao", "confirmado"];
const ESTADOS_CADASTRO = ESTADOS.filter((e) => e !== "confirmado");   // 'confirmado' só pela ação própria, com evidência
export const ROTULO_ESTADO = { pendente: "Pendente", estimado: "Estimado", aguardando_comprovacao: "Aguardando comprovação", confirmado: "Confirmado" };

/** Modelos preparados (NÃO gravados): o responsável cadastra cada um, individualmente, depois de conferir. Valores e fatos vêm da homologação de setembro/2026. */
export const MODELOS = Object.freeze([
  { chave: "doc:2026-09:diferenca-caixa-190-53", descricao: "Diferença de fechamento de caixa — R$ 190,53", valorCentavos: 19053, dataReferencia: "2026-09-30", competencia: "2026-09",
    motivo: "Contagem física do caixa × saldo calculado em 30/09/2026.", evidenciaNecessaria: "Contagem física do caixa e conferência de cada levada de dinheiro (depósitos e pagamentos em espécie) do mês.", responsavel: "Contadora", estado: "pendente",
    relacionadaChave: "doc:2026-09:destino-caixa-195-25", observacoes: "Composição documentada: R$ 195,25 sem destino − R$ 4,72 de contagens divergentes (Fluxo × Conciliação). Pode estar relacionado ao item de R$ 195,25: não tratar como duas perdas independentes sem validação." },
  { chave: "doc:2026-09:destino-caixa-195-25", descricao: "Destino de dinheiro do caixa não identificado — R$ 195,25", valorCentavos: 19525, dataReferencia: "2026-09-30", competencia: "2026-09",
    motivo: "Levadas de dinheiro do caixa em datas diferentes das conferências; a contadora marcou VERIFICAR (PD-05 / INC-009) e não há lançamento que explique o valor.", evidenciaNecessaria: "Data e destino de cada levada de dinheiro (depósito, pagamento ou retirada) que some R$ 195,25.", responsavel: "Contadora", estado: "pendente",
    relacionadaChave: "doc:2026-09:diferenca-caixa-190-53", observacoes: "Pode estar relacionado à diferença de caixa de R$ 190,53 (190,53 = 195,25 − 4,72). Validar antes de tratar como itens independentes." },
  { chave: "doc:2026-09:pix-14-09-200-00", descricao: "Pix de 14/09 — R$ 200,00, classificação pendente", valorCentavos: 20000, dataReferencia: "2026-09-14", competencia: "2026-09",
    motivo: "Entrada de Pix sem identificação da finalidade; a classificação não foi definida e não foi presumida.", evidenciaNecessaria: "Identificação do remetente e da finalidade do Pix (comprovante ou mensagem do pagador).", responsavel: "Proprietário e contadora", estado: "pendente",
    relacionadaChave: null, observacoes: "Compõe o resíduo de R$ 390,53 em \"outras entradas e diferenças\" (190,53 do caixa + 200,00 do Pix)." },
  { chave: "doc:2026-09:divergencia-caixa-0-82", descricao: "Divergência de caixa — R$ 0,82", valorCentavos: 82, dataReferencia: "2026-09-04", competencia: "2026-09",
    motivo: "Compra de supermercado de 04/09: R$ 96,82 no Fluxo de Caixa × R$ 96,00 na Conciliação (MOV-01267).", evidenciaNecessaria: "Nota ou cupom fiscal da compra de 04/09 para definir qual valor está correto.", responsavel: "Operador financeiro", estado: "aguardando_comprovacao",
    relacionadaChave: null, observacoes: "Nenhum valor foi ajustado para eliminar a diferença." },
  { chave: "doc:2026-09:divergencias-sangria", descricao: "Divergências de sangria de setembro/2026 (dias 02, 04, 10, 15 e 21)", valorCentavos: null, dataReferencia: null, competencia: "2026-09",
    motivo: "A sangria registrada no sistema difere da tabela SAIPOS em 5 dias; 04/09, 10/09 e 21/09 envolvem depósitos no banco que a tabela de sangria não inclui.", evidenciaNecessaria: "Relatório de sangrias do mês × comprovantes de depósito e pagamentos em espécie, dia a dia.", responsavel: "Operador financeiro e contadora", estado: "pendente",
    relacionadaChave: null, observacoes: "Fatos documentados: 02/09 = R$ 61,00 × R$ 51,00; 15/09 = R$ 0,00 × R$ 1.057,53 (aluguel em espécie); 04/09 (R$ 381,52), 10/09 (R$ 1.350,00) e 21/09 (R$ 1.302,00) incluem depósitos no banco. Conferir os valores e as datas antes de confirmar." },
]);

const linha = (r) => ({ id: r.id, competencia: String(r.competencia).slice(0, 7), dataReferencia: r.data_referencia ? String(r.data_referencia).slice(0, 10) : null, descricao: r.descricao,
  valorCentavos: r.valor_centavos == null ? null : Number(r.valor_centavos), motivo: r.motivo, evidenciaNecessaria: r.evidencia_necessaria, responsavel: r.responsavel, estado: r.estado, estadoRotulo: ROTULO_ESTADO[r.estado],
  observacoes: r.observacoes ?? null, documentoReferencia: r.documento_referencia ?? null, relacionadaChave: r.relacionada_chave ?? null, chaveOrigem: r.chave_origem ?? null,
  confirmacao: r.estado === "confirmado" ? { por: r.confirmado_por, em: r.confirmado_em, evidencia: r.confirmacao_evidencia } : null, criadoPor: r.criado_por, criadoEm: r.created_at, atualizadoPor: r.atualizado_por, atualizadoEm: r.updated_at });
export { linha as linhaPendenciaDocumental };

function dados(b, { parcial = false } = {}) {
  const out = {};
  const pega = (k, f) => { if (!parcial || b?.[k] !== undefined) out[k] = f(); };
  pega("descricao", () => texto(b?.descricao, "descricao", { max: 300 }));
  if (!parcial || b?.valor !== undefined || b?.valorCentavos !== undefined) out.valor_centavos = b?.valorCentavos != null ? Number(b.valorCentavos) : valorOuNulo(b?.valor, "valor");
  if (out.valor_centavos != null && (!Number.isSafeInteger(out.valor_centavos) || out.valor_centavos < 0)) throw bad("Valor inválido.");
  pega("motivo", () => texto(b?.motivo, "motivo", { max: 500 }));
  pega("evidencia_necessaria", () => texto(b?.evidenciaNecessaria, "evidenciaNecessaria", { max: 500 }));
  pega("responsavel", () => texto(b?.responsavel, "responsavel", { max: 120 }));
  pega("estado", () => enumerado(b?.estado ?? "pendente", "estado", ESTADOS_CADASTRO));
  pega("observacoes", () => texto(b?.observacoes, "observacoes", { max: 1000, obrigatorio: false }));
  pega("documento_referencia", () => texto(b?.documentoReferencia, "documentoReferencia", { max: 300, obrigatorio: false }));
  pega("relacionada_chave", () => texto(b?.relacionadaChave, "relacionadaChave", { max: 160, obrigatorio: false }));
  pega("data_referencia", () => data(b?.dataReferencia, "dataReferencia", { obrigatorio: false }));
  if (!parcial || b?.competencia !== undefined || b?.dataReferencia) {
    const mes = b?.competencia ? mesAno(b.competencia, "competencia") : out.data_referencia ? out.data_referencia.slice(0, 7) : null;
    if (!mes) throw bad("Informe a competência (AAAA-MM) ou a data.");
    out.competencia = `${mes}-01`;
  }
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Lista as pendências do mês e marca quais modelos ainda não foram cadastrados (por chave). Somente leitura. */
export async function listar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const itens = (await deps.repo.listarPendenciasDocumentais(c, { competencia: `${mes}-01` }, deps.db)).map(linha);
  const chaves = new Set((await deps.repo.listarPendenciasDocumentais(c, {}, deps.db)).map((r) => r.chave_origem).filter(Boolean));
  return { mes, itens, modelos: MODELOS.filter((m) => m.competencia === mes).map((m) => ({ ...m, cadastrada: chaves.has(m.chave) })) };
}

/** Registra uma pendência. Não cria movimentação. Recusa duplicidade (mesma chave; mesma competência+descrição; ou mesmo valor de uma pendência automática, salvo `confirmaDistinta`). */
export async function registrar(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const campos = dados(b);
  const chave = texto(b?.chaveOrigem, "chaveOrigem", { max: 160, obrigatorio: false });
  const existentes = await deps.repo.listarPendenciasDocumentais(c, {}, deps.db);
  if (chave && existentes.some((r) => r.chave_origem === chave)) throw bad("Esta pendência documental já está cadastrada.", "PENDENCIA_DUPLICADA");
  if (existentes.some((r) => r.competencia === campos.competencia && norm(r.descricao) === norm(campos.descricao))) throw bad("Já existe uma pendência com a mesma descrição nesta competência.", "PENDENCIA_DUPLICADA");
  if (campos.valor_centavos && deps.automaticas && b?.confirmaDistinta !== true) {
    const auto = (await deps.automaticas(c, campos.competencia.slice(0, 7))).find((p) => Math.abs(p.valorCentavos ?? 0) === campos.valor_centavos);
    if (auto) throw bad(`Já existe uma pendência automática de mesmo valor: «${auto.titulo}». Se for um assunto diferente, confirme que é distinta.`, "POSSIVEL_DUPLICIDADE_AUTOMATICA");
  }
  const r = await deps.repo.inserirPendenciaDocumental(c, { ...campos, chave_origem: chave }, deps.db);
  return linha(r);
}
/** Cadastra um modelo preparado (um por vez, ação explícita). */
export async function registrarModelo(ctx, chave, b, deps = padrao) {
  const m = MODELOS.find((x) => x.chave === chave);
  if (!m) throw bad("Modelo de pendência desconhecido.", "NAO_ENCONTRADO");
  return registrar(ctx, { ...m, valorCentavos: m.valorCentavos, ...(b ?? {}), chaveOrigem: m.chave, confirmaDistinta: true }, deps);
}

export async function editar(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const atual = await deps.repo.buscarPendenciaDocumental(c, id, deps.db);
  if (!atual || atual.status !== "ativa") throw bad("Pendência não encontrada.", "NAO_ENCONTRADO");
  if (atual.estado === "confirmado") throw bad("Pendência confirmada não pode ser editada: cancele e registre outra, com motivo.", "PENDENCIA_CONFIRMADA");
  const campos = dados(b, { parcial: true });
  if (!Object.keys(campos).length) throw bad("Nada para alterar.");
  const r = await deps.repo.atualizarPendenciaDocumental(c, id, campos, deps.db);
  return linha(r);
}
/** Concluir = confirmar com evidência (documento) e permissão (CLASSIFICAR). Estimado nunca vira confirmado sozinho. */
export async function confirmar(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const evidencia = texto(b?.evidencia, "evidencia", { max: 500 });
  if (evidencia.length < 5) throw bad("Informe a evidência da confirmação (documento, período e valores conferidos).", "EVIDENCIA_OBRIGATORIA");
  const atual = await deps.repo.buscarPendenciaDocumental(c, id, deps.db);
  if (!atual || atual.status !== "ativa") throw bad("Pendência não encontrada.", "NAO_ENCONTRADO");
  if (atual.estado === "confirmado") throw bad("Pendência já confirmada.", "PENDENCIA_CONFIRMADA");
  const doc = texto(b?.documentoReferencia, "documentoReferencia", { max: 300, obrigatorio: false });
  const r = await deps.repo.atualizarPendenciaDocumental(c, id, { estado: "confirmado", confirmacao_evidencia: evidencia, confirmado_por: c.usuarioId, confirmado_em: (deps.agora ?? padrao.agora)(), ...(doc ? { documento_referencia: doc } : {}) }, deps.db);
  return linha(r);
}
export async function cancelar(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const motivo = texto(b?.motivo, "motivo", { max: 500 });
  if (motivo.length < 5) throw bad("Informe o motivo (mínimo de 5 caracteres).", "MOTIVO_OBRIGATORIO");
  const r = await deps.repo.atualizarPendenciaDocumental(c, id, { status: "cancelada", motivo_cancelamento: motivo, cancelado_por: c.usuarioId, cancelado_em: (deps.agora ?? padrao.agora)() }, deps.db);
  if (!r) throw bad("Pendência não encontrada.", "NAO_ENCONTRADO");
  return linha(r);
}
/** Histórico de alterações (trilha imutável) de uma pendência. */
export async function historico(ctx, id, deps = padrao) {
  const c = exigirContexto(ctx);
  const t = await deps.repo.listarAuditoria(c, { entidade: "fin_pendencias_documentais", entidadeId: id, limite: 100 }, deps.db);
  return { itens: (t ?? []).map((a) => ({ id: a.id, acao: a.acao, em: a.created_at, ator: a.ator_id })) };
}
