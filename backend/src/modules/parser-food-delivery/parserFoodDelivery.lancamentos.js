// Lançamentos operacionais do Parser Food Delivery — a camada que
// representa o CUSTO REAL com entregadores que NÃO aparece (ou aparece
// errado) no relatório do iFood:
//   - manual        : entrega incluída à mão (deveria ter entrado no iFood)
//   - taxa_adicional: valor pago a outro entregador de um pedido existente
//                     (caso Ronaldo/Vitor) — nunca altera o entregador final
//   - avulso        : serviço sem relação com pedido iFood (buscar pães, etc.)
//
// NUNCA toca em parser_fd_pedidos (registro bruto do iFood). Soft-delete em
// tudo; hard delete só via RPC transacional (SuperAdmin). Toda ação passa
// por parser_fd_auditoria.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { resolverUnidade, registrarAuditoriaGenerica } from "./parserFoodDelivery.shared.js";
import { resolverEntregadorParaLancamento } from "./parserFoodDelivery.entregadores.js";
import { chaveEntregador } from "./parserFoodDelivery.calc.js";
import {
  ORIGEM_LANCAMENTO, MOTIVO_MANUAL_PADRAO, motivoObrigatorio, motivoValido, rotuloMotivo,
} from "./parserFoodDelivery.lancamentos.calc.js";

const TABELA = "parser_fd_lancamentos";
const ORIGENS = Object.values(ORIGEM_LANCAMENTO);

// ---------------------------------------------------------------------------
// MAPEAMENTO DB <-> API
// ---------------------------------------------------------------------------
export function paraApiLancamento(row, { entregadorAtual = null, pedidoDisponivel = null } = {}) {
  return {
    id: row.id,
    organizacaoId: row.organizacao_id,
    unidadeId: row.unidade_id,
    origem: row.origem,
    origemRotulo: { manual: "Manual", taxa_adicional: "Taxa adicional", avulso: "Avulso" }[row.origem] || row.origem,
    pedidoId: row.pedido_id,
    numeroPedido: row.numero_pedido,
    importacaoId: row.importacao_id,
    // Item 4 dos refinamentos: taxa_adicional cujo pedido foi excluído depois
    // continua taxa_adicional; a UI só marca que o pedido ficou indisponível.
    pedidoDisponivel: pedidoDisponivel == null ? row.pedido_id != null : pedidoDisponivel,
    entregadorId: row.entregador_id,
    entregadorNomeSnapshot: row.entregador_nome_snapshot,
    entregadorNome: entregadorAtual || row.entregador_nome_snapshot,
    entregadorChave: chaveEntregador(entregadorAtual || row.entregador_nome_snapshot),
    data: row.data,
    hora: row.hora,
    valor: row.valor == null ? null : Number(row.valor),
    motivo: row.motivo,
    motivoRotulo: rotuloMotivo(row.origem, row.motivo),
    motivoDescricao: row.motivo_descricao,
    observacao: row.observacao,
    situacao: row.situacao,
    classificacao: row.classificacao,
    criadoPorNome: row.criado_por_nome,
    criadoPorEmail: row.criado_por_email,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    atualizadoPorNome: row.atualizado_por_nome,
    excluido: row.excluido,
    excluidoEm: row.excluido_em,
    excluidoPorNome: row.excluido_por_nome,
    motivoExclusao: row.motivo_exclusao,
  };
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO DE ENTRADA (item 17 do pedido)
// ---------------------------------------------------------------------------
async function resolverPedidoVinculado({ organizacaoId, unidadeId, pedidoId, numeroPedidoManual }) {
  if (!pedidoId) return { pedidoId: null, numeroPedido: numeroPedidoManual || null, importacaoId: null };
  const { data: pedido, error } = await supabase.from("parser_fd_pedidos")
    .select("id, numero_pedido, importacao_id, organizacao_id, unidade_id")
    .eq("id", pedidoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!pedido) throw ApiError.badRequest("Pedido informado não encontrado.");
  if (pedido.organizacao_id !== organizacaoId || pedido.unidade_id !== unidadeId) {
    throw ApiError.forbidden("O pedido informado é de outra empresa/unidade.");
  }
  return { pedidoId: pedido.id, numeroPedido: pedido.numero_pedido, importacaoId: pedido.importacao_id };
}

/**
 * Normaliza + valida o corpo de um lançamento. Devolve o objeto pronto para
 * INSERT (colunas do banco). `entregador` já resolvido pela camada mestre.
 */
async function montarLinha({ organizacaoId, unidadeId, body, usuario }) {
  const origem = v.umDe(body?.origem, "Origem do lançamento", ORIGENS);

  const valor = v.numero(body?.valor, "Valor", { min: 0, max: 1_000_000 });
  const observacao = v.textoOpcional(body?.observacao, "Observação", { max: 1000 });
  // Item 1 dos refinamentos: valor 0 só com justificativa real na observação.
  if (valor === 0 && !observacao) {
    throw ApiError.badRequest("Valor R$ 0,00 só é aceito com uma justificativa na observação.");
  }

  const data = v.dataOpcional(body?.data, "Data") || null;
  if (!data) throw ApiError.badRequest("Informe a data do lançamento.");
  const hoje = new Date().toISOString().slice(0, 10);
  if (data > hoje) throw ApiError.badRequest("A data do lançamento não pode ser no futuro.");

  const hora = body?.hora && /^\d{2}:\d{2}(:\d{2})?$/.test(String(body.hora)) ? String(body.hora) : null;

  // Motivo: obrigatório e do catálogo para taxa_adicional/avulso; opcional
  // para manual (default 'inclusao_manual').
  let motivo = body?.motivo ? String(body.motivo).trim() : null;
  if (origem === ORIGEM_LANCAMENTO.MANUAL && !motivo) motivo = MOTIVO_MANUAL_PADRAO;
  if (motivoObrigatorio(origem) && !motivo) throw ApiError.badRequest("Informe o motivo do lançamento.");
  if (motivo && !motivoValido(origem, motivo)) throw ApiError.badRequest(`Motivo "${motivo}" não é válido para esta origem.`);
  const motivoDescricao = v.textoOpcional(body?.motivoDescricao, "Descrição do motivo", { max: 500 });
  if (motivo === "outro" && !motivoDescricao) throw ApiError.badRequest('Descreva o motivo quando escolher "Outro".');

  // Vínculo com pedido.
  let pedidoId = body?.pedidoId ? v.uuid(body.pedidoId, "Pedido") : null;
  if (origem === ORIGEM_LANCAMENTO.AVULSO && pedidoId) {
    throw ApiError.badRequest("Um serviço avulso não pode ser vinculado a um pedido do iFood.");
  }
  const vinculo = await resolverPedidoVinculado({
    organizacaoId, unidadeId, pedidoId,
    numeroPedidoManual: origem === ORIGEM_LANCAMENTO.AVULSO ? null : (body?.numeroPedido ? String(body.numeroPedido).trim() : null),
  });
  if (origem === ORIGEM_LANCAMENTO.TAXA_ADICIONAL && !vinculo.numeroPedido) {
    throw ApiError.badRequest("A taxa adicional precisa estar vinculada a um pedido (informe o pedido ou o código).");
  }

  // Campos só de entrega manual.
  const situacao = origem === ORIGEM_LANCAMENTO.MANUAL ? v.textoOpcional(body?.situacao, "Situação", { max: 80 }) : null;
  const classificacao = origem === ORIGEM_LANCAMENTO.MANUAL
    ? v.umDeOpcional(body?.classificacao, "Classificação", ["recebe_taxa", "nao_recebe_taxa"])
    : null;

  const entregador = await resolverEntregadorParaLancamento({
    organizacaoId, unidadeId,
    entregadorId: body?.entregadorId || null,
    nome: body?.entregadorNome || null,
    criarSeNaoExistir: !!body?.criarEntregador,
    usuario,
  });

  return {
    linha: {
      organizacao_id: organizacaoId, unidade_id: unidadeId, origem,
      pedido_id: origem === ORIGEM_LANCAMENTO.AVULSO ? null : vinculo.pedidoId,
      numero_pedido: origem === ORIGEM_LANCAMENTO.AVULSO ? null : vinculo.numeroPedido,
      importacao_id: origem === ORIGEM_LANCAMENTO.AVULSO ? null : vinculo.importacaoId,
      entregador_id: entregador.id, entregador_nome_snapshot: entregador.nome,
      data, hora, valor, motivo, motivo_descricao: motivoDescricao,
      observacao, situacao, classificacao,
    },
    entregador,
  };
}

// ---------------------------------------------------------------------------
// LEITURA
// ---------------------------------------------------------------------------
export async function listarLancamentos({ organizacaoId, unidadeId, dataInicio, dataFim, origem, incluirExcluidos = false }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  let q = supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId);
  if (dataInicio) q = q.gte("data", v.dataOpcional(dataInicio, "Data inicial"));
  if (dataFim) q = q.lte("data", v.dataOpcional(dataFim, "Data final"));
  if (origem) q = q.eq("origem", v.umDe(origem, "Origem", ORIGENS));
  if (!incluirExcluidos) q = q.eq("excluido", false);
  const { data, error } = await q.order("data", { ascending: false }).order("criado_em", { ascending: false });
  if (error) throw ApiError.internal(error.message);

  const idsPedidos = [...new Set((data || []).map((r) => r.pedido_id).filter(Boolean))];
  const vivos = new Set();
  if (idsPedidos.length) {
    const { data: existentes } = await supabase.from("parser_fd_pedidos").select("id").in("id", idsPedidos);
    for (const p of existentes || []) vivos.add(p.id);
  }
  return (data || []).map((r) => paraApiLancamento(r, { pedidoDisponivel: r.pedido_id ? vivos.has(r.pedido_id) : null }));
}

/**
 * Usado por parserFoodDelivery.service.js (analisarPeriodo / obterImportacao)
 * para anexar `custoReal` e `lancamentos[]` ao resultado. Filtra por data
 * operacional [inicio, fimExclusivo).
 */
export async function lancamentosDoPeriodo({ organizacaoId, unidadeId, inicio, fimExclusivo }) {
  let q = supabase.from(TABELA).select("*")
    .eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).eq("excluido", false);
  if (inicio) q = q.gte("data", inicio.slice(0, 10));
  if (fimExclusivo) q = q.lt("data", fimExclusivo.slice(0, 10));
  const { data, error } = await q.order("data", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return (data || []).map((r) => paraApiLancamento(r));
}

/**
 * Lançamentos que compõem o custo real de UMA importação: os vinculados a
 * ela (por `importacao_id` snapshot) MAIS os avulsos/manuais cuja `data`
 * cai dentro do período da importação (um avulso não tem importação de
 * origem, mas é custo operacional daquele período).
 */
export async function lancamentosDaImportacao({ organizacaoId, unidadeId, importacaoId, periodoInicio, periodoFim }) {
  const vistos = new Map();
  const push = (rows) => { for (const r of rows || []) vistos.set(r.id, r); };

  const { data: porImportacao, error: e1 } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).eq("excluido", false)
    .eq("importacao_id", importacaoId);
  if (e1) throw ApiError.internal(e1.message);
  push(porImportacao);

  if (periodoInicio && periodoFim) {
    const { data: porData, error: e2 } = await supabase.from(TABELA).select("*")
      .eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).eq("excluido", false)
      .gte("data", periodoInicio).lte("data", periodoFim);
    if (e2) throw ApiError.internal(e2.message);
    push(porData);
  }
  return [...vistos.values()].map((r) => paraApiLancamento(r));
}

// ---------------------------------------------------------------------------
// ESCRITA
// ---------------------------------------------------------------------------
export async function criarLancamento({ organizacaoId, unidadeId, usuario, ...body }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { linha } = await montarLinha({ organizacaoId, unidadeId, body, usuario });

  const { data, error } = await supabase.from(TABELA).insert({
    ...linha,
    criado_por: usuario?.id || null, criado_por_nome: usuario?.nome || null, criado_por_email: usuario?.email || null,
  }).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao: "lancamento_criado",
    lancamentoId: data.id, entregadorId: data.entregador_id,
    pedidoId: data.pedido_id, numeroPedido: data.numero_pedido, importacaoId: data.importacao_id,
    valorDepois: Number(data.valor), dadosDepois: paraApiLancamento(data), motivo: data.motivo, usuario,
  });
  return paraApiLancamento(data);
}

export async function editarLancamento({ organizacaoId, unidadeId, lancamentoId, usuario, ...body }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: atual, error: eAtual } = await supabase.from(TABELA).select("*")
    .eq("id", lancamentoId).eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eAtual) throw ApiError.internal(eAtual.message);
  if (!atual) throw ApiError.notFound("Lançamento não encontrado nesta unidade.");
  if (atual.excluido) throw ApiError.badRequest("Este lançamento está excluído. Restaure-o antes de editar.");

  // A origem nunca muda numa edição (evita transmutar taxa_adicional <-> avulso).
  const merged = { ...body, origem: atual.origem };
  // Campos não informados no PATCH mantêm o valor atual.
  const fallback = {
    valor: atual.valor, data: atual.data, hora: atual.hora, observacao: atual.observacao,
    motivo: atual.motivo, motivoDescricao: atual.motivo_descricao, situacao: atual.situacao,
    classificacao: atual.classificacao, entregadorId: atual.entregador_id,
    numeroPedido: atual.numero_pedido, pedidoId: atual.pedido_id,
  };
  for (const [k, val] of Object.entries(fallback)) if (merged[k] === undefined) merged[k] = val;

  const { linha } = await montarLinha({ organizacaoId, unidadeId, body: merged, usuario });

  const { data, error } = await supabase.from(TABELA).update({
    ...linha, atualizado_por_nome: usuario?.nome || null,
  }).eq("id", lancamentoId).eq("unidade_id", unidadeId).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao: "lancamento_editado",
    lancamentoId, entregadorId: data.entregador_id, pedidoId: data.pedido_id, numeroPedido: data.numero_pedido,
    valorAntes: Number(atual.valor), valorDepois: Number(data.valor),
    dadosAntes: paraApiLancamento(atual), dadosDepois: paraApiLancamento(data), usuario,
  });
  return paraApiLancamento(data);
}

export async function excluirLancamento({ organizacaoId, unidadeId, lancamentoId, motivo: motivoRaw, usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: atual, error } = await supabase.from(TABELA).select("*")
    .eq("id", lancamentoId).eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!atual) throw ApiError.notFound("Lançamento não encontrado nesta unidade.");
  if (atual.excluido) throw ApiError.badRequest("Este lançamento já está excluído.");

  const { data, error: eUp } = await supabase.from(TABELA).update({
    excluido: true, excluido_em: new Date().toISOString(),
    excluido_por_nome: usuario?.nome || null, motivo_exclusao: motivo,
  }).eq("id", lancamentoId).eq("unidade_id", unidadeId).select("*").single();
  if (eUp) throw ApiError.badRequest(eUp.message);

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao: "lancamento_excluido", motivo,
    lancamentoId, entregadorId: atual.entregador_id, pedidoId: atual.pedido_id, numeroPedido: atual.numero_pedido,
    valorAntes: Number(atual.valor), dadosAntes: paraApiLancamento(atual), usuario,
  });
  return paraApiLancamento(data);
}

export async function restaurarLancamento({ organizacaoId, unidadeId, lancamentoId, usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: atual, error } = await supabase.from(TABELA).select("*")
    .eq("id", lancamentoId).eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!atual) throw ApiError.notFound("Lançamento não encontrado nesta unidade.");
  if (!atual.excluido) throw ApiError.badRequest("Este lançamento não está excluído.");

  const { data, error: eUp } = await supabase.from(TABELA).update({
    excluido: false, excluido_em: null, excluido_por_nome: null, motivo_exclusao: null,
  }).eq("id", lancamentoId).eq("unidade_id", unidadeId).select("*").single();
  if (eUp) throw ApiError.badRequest(eUp.message);

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao: "lancamento_restaurado",
    lancamentoId, entregadorId: atual.entregador_id, pedidoId: atual.pedido_id, numeroPedido: atual.numero_pedido,
    dadosAntes: paraApiLancamento(atual), dadosDepois: paraApiLancamento(data), usuario,
  });
  return paraApiLancamento(data);
}

/**
 * Hard delete — SOMENTE SuperAdmin (o gate fica na rota). Snapshot + delete
 * na MESMA transação, via função PL/pgSQL da migration 079.
 */
export async function hardDeleteLancamento({ organizacaoId, unidadeId, lancamentoId, motivo: motivoRaw, usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const motivo = v.texto(motivoRaw, "Motivo da exclusão definitiva", { min: 3, max: 500 });

  // Grava o motivo antes (a função copia motivo_exclusao para a auditoria).
  const { data: atual, error } = await supabase.from(TABELA).select("id")
    .eq("id", lancamentoId).eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!atual) throw ApiError.notFound("Lançamento não encontrado nesta unidade.");
  await supabase.from(TABELA).update({ motivo_exclusao: motivo }).eq("id", lancamentoId);

  const { error: eRpc } = await supabase.rpc("parser_fd_lancamento_hard_delete", {
    p_id: lancamentoId, p_org: organizacaoId, p_unidade: unidadeId,
    p_usuario_id: usuario?.id || null, p_usuario_nome: usuario?.nome || null, p_usuario_email: usuario?.email || null,
  });
  if (eRpc) throw ApiError.internal(`Falha ao excluir definitivamente: ${eRpc.message}`);
  return { removido: true, lancamentoId };
}
