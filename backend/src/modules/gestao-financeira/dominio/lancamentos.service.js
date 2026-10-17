// Lançamentos e transferências. Regras: nada é excluído (cancelamento é status com motivo); reclassificar exige motivo;
// resolver pendência exige nota; transferências são pares atômicos; mês fechado é protegido pelo banco.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, enumerado, data, valorPositivo, bad, periodo } from "./validacao.js";
import { PAPEL } from "../../../financeiro-calculos/planoContas.js";
import { ApiError } from "../../../shared/ApiError.js";

const padrao = { repo: repositorio, db: undefined };

async function categoriaDaOrg(ctx, categoriaId, deps) {
  const cats = await deps.repo.listarPlanoContas(ctx, deps.db);
  const c = cats.find((x) => x.id === categoriaId);
  if (!c) throw bad("Categoria não encontrada.", "CATEGORIA_INEXISTENTE");
  if (!c.ativo) throw bad("Categoria inativa.", "CATEGORIA_INATIVA");
  return c;
}
async function contaDaUnidade(ctx, contaId, deps) {
  const contas = await deps.repo.listarContas(ctx, deps.db);
  const c = contas.find((x) => x.id === contaId);
  if (!c) throw bad("Conta não encontrada.", "CONTA_INEXISTENTE");
  if (!c.ativo) throw bad("Conta inativa.", "CONTA_INATIVA");
  return c;
}

export async function listarLancamentos(ctx, q, deps = padrao) {
  const { de, ate } = periodo(q);
  return deps.repo.listarLancamentos(exigirContexto(ctx), {
    de, ate, contaId: uuid(q?.contaId, "contaId", { obrigatorio: false }), categoriaId: uuid(q?.categoriaId, "categoriaId", { obrigatorio: false }),
    sentido: enumerado(q?.sentido, "sentido", ["entrada", "saida"], { obrigatorio: false }),
    status: enumerado(q?.status, "status", ["realizado", "previsto", "cancelado"], { obrigatorio: false }),
    pendente: q?.pendente === undefined || q?.pendente === "" ? null : q.pendente === "true" || q.pendente === true,
    busca: texto(q?.busca, "busca", { max: 80, obrigatorio: false }),
    limite: Math.min(Math.max(parseInt(q?.limite ?? "200", 10) || 200, 1), 500), deslocamento: Math.max(parseInt(q?.deslocamento ?? "0", 10) || 0, 0),
  }, deps.db);
}

export async function criarLancamento(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const contaId = uuid(b?.contaId, "contaId");
  await contaDaUnidade(c, contaId, deps);
  const categoriaId = uuid(b?.categoriaId, "categoriaId", { obrigatorio: false });
  let pendente = false;
  if (categoriaId) {
    const cat = await categoriaDaOrg(c, categoriaId, deps);
    if (cat.papel === PAPEL.SALDO_ANTERIOR) throw bad("Use saldo de abertura para saldo anterior.", "CATEGORIA_SALDO_ANTERIOR");
    if (cat.papel === PAPEL.TRANSFERENCIA) pendente = true; // perna avulsa; só deixa de ser pendente ao ser vinculada a um par
  } else pendente = true;
  return deps.repo.inserirLancamento(c, {
    conta_id: contaId, categoria_id: categoriaId, descricao: texto(b?.descricao, "descricao"), sentido: enumerado(b?.sentido, "sentido", ["entrada", "saida"]),
    valor_centavos: valorPositivo(b?.valor), data_movimento: data(b?.dataMovimento, "dataMovimento"),
    data_competencia: data(b?.dataCompetencia, "dataCompetencia", { obrigatorio: false }), data_vencimento: data(b?.dataVencimento, "dataVencimento", { obrigatorio: false }),
    status: enumerado(b?.status ?? "realizado", "status", ["realizado", "previsto"]), classificacao_pendente: pendente,
    nota_revisao: texto(b?.notaRevisao, "notaRevisao", { max: 1000, obrigatorio: false }),
  }, deps.db);
}

/**
 * Edição. Reclassificar (trocar categoria já definida) exige `notaRevisao` com o motivo; resolver uma pendência
 * (classificacaoPendente=false) também. A trilha antes/depois é gravada pelo banco (fin_auditoria).
 */
export async function atualizarLancamento(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const atual = await deps.repo.obterLancamento(c, uuid(id, "id"), deps.db);
  if (!atual) throw bad("Lançamento não encontrado.", "LANCAMENTO_INEXISTENTE");
  if (atual.status === "cancelado") throw bad("Lançamento cancelado não pode ser alterado.", "LANCAMENTO_CANCELADO");
  const campos = {};
  const nota = texto(b?.notaRevisao, "notaRevisao", { max: 1000, obrigatorio: false });
  if (b?.descricao !== undefined) campos.descricao = texto(b.descricao, "descricao");
  if (b?.valor !== undefined) campos.valor_centavos = valorPositivo(b.valor);
  if (b?.dataMovimento !== undefined) campos.data_movimento = data(b.dataMovimento, "dataMovimento");
  if (b?.dataCompetencia !== undefined) campos.data_competencia = data(b.dataCompetencia, "dataCompetencia", { obrigatorio: false });
  if (b?.dataVencimento !== undefined) campos.data_vencimento = data(b.dataVencimento, "dataVencimento", { obrigatorio: false });
  if (b?.contaId !== undefined) { const id2 = uuid(b.contaId, "contaId"); await contaDaUnidade(c, id2, deps); campos.conta_id = id2; }
  if (b?.status !== undefined) campos.status = enumerado(b.status, "status", ["realizado", "previsto"]);
  if (b?.categoriaId !== undefined) {
    const novaId = uuid(b.categoriaId, "categoriaId");
    if (novaId !== atual.categoria_id) {
      const cat = await categoriaDaOrg(c, novaId, deps);
      if (cat.papel === PAPEL.SALDO_ANTERIOR) throw bad("Use saldo de abertura para saldo anterior.", "CATEGORIA_SALDO_ANTERIOR");
      if (atual.categoria_id && !nota) throw bad("Reclassificar exige o motivo em notaRevisao.", "RECLASSIFICACAO_SEM_MOTIVO");
      campos.categoria_id = novaId;
    }
  }
  if (b?.classificacaoPendente === false && atual.classificacao_pendente) {
    if (!nota) throw bad("Resolver uma pendência exige a justificativa em notaRevisao.", "PENDENCIA_SEM_JUSTIFICATIVA");
    if (!(campos.categoria_id ?? atual.categoria_id)) throw bad("Defina a categoria antes de resolver a pendência.", "PENDENCIA_SEM_CATEGORIA");
    campos.classificacao_pendente = false;
  }
  if (nota) campos.nota_revisao = atual.nota_revisao ? `${atual.nota_revisao} | ${nota}` : nota; // histórico de notas é cumulativo
  if (!Object.keys(campos).length) throw bad("Nada para atualizar.");
  return deps.repo.atualizarLancamento(c, id, campos, deps.db);
}

/**
 * Cancelar lançamento ISOLADO. Perna de transferência VINCULADA não pode ser cancelada sozinha (nem desvinculando para depois cancelar só uma):
 * use "Cancelar transferência" (par inteiro) ou "Desvincular" (pareamento errado, pernas seguem ativas). Perna SEM par (movimento externo)
 * só é cancelada com confirmação explícita, para não "sumir" metade de uma transferência por engano.
 */
async function exigirPernaIsolada(c, atual, b, deps) {
  const pares = await deps.repo.listarTransferencias(c, deps.db);
  if (pares.some((p) => p.lancamento_saida_id === atual.id || p.lancamento_entrada_id === atual.id)) {
    throw bad("Este lançamento faz parte de uma transferência vinculada. Use «Cancelar transferência» para cancelar as duas pernas, ou «Desvincular» se o pareamento estiver errado.", "FIN_TRANSFERENCIA_VINCULADA");
  }
  const cat = atual.categoria_id ? (await deps.repo.listarPlanoContas(c, deps.db)).find((x) => x.id === atual.categoria_id) : null;
  if (cat?.papel === PAPEL.TRANSFERENCIA && b?.confirmoPernaIsolada !== true) {
    throw bad("Esta é uma perna de transferência sem par. Confirme que deseja cancelar só esta perna (confirmoPernaIsolada).", "PERNA_ISOLADA_SEM_CONFIRMACAO");
  }
}

/** Cancelamento (nunca exclusão): exige motivo; pernas de transferência vinculada precisam ser desvinculadas antes (banco). */
export async function cancelarLancamento(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const motivo = texto(b?.motivo, "motivo", { max: 1000 });
  const atual = await deps.repo.obterLancamento(c, uuid(id, "id"), deps.db);
  if (!atual) throw bad("Lançamento não encontrado.", "LANCAMENTO_INEXISTENTE");
  if (atual.status === "cancelado") return atual;
  await exigirPernaIsolada(c, atual, b, deps);
  return deps.repo.atualizarLancamento(c, id, { status: "cancelado", nota_revisao: atual.nota_revisao ? `${atual.nota_revisao} | Cancelado: ${motivo}` : `Cancelado: ${motivo}` }, deps.db);
}

// ---- transferências ----
export async function listarTransferencias(ctx, deps = padrao) {
  return deps.repo.listarTransferencias(exigirContexto(ctx), deps.db);
}
export async function criarTransferencia(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const origem = uuid(b?.contaOrigemId, "contaOrigemId");
  const destino = uuid(b?.contaDestinoId, "contaDestinoId");
  if (origem === destino) throw bad("Origem e destino devem ser contas diferentes.", "TRANSFERENCIA_MESMA_CONTA");
  await contaDaUnidade(c, origem, deps);
  await contaDaUnidade(c, destino, deps);
  let categoriaId = uuid(b?.categoriaId, "categoriaId", { obrigatorio: false });
  if (categoriaId) {
    if ((await categoriaDaOrg(c, categoriaId, deps)).papel !== PAPEL.TRANSFERENCIA) throw bad("A categoria precisa ter o papel de transferência.", "CATEGORIA_NAO_TRANSFERENCIA");
  } else {
    const cands = (await deps.repo.listarPlanoContas(c, deps.db)).filter((x) => x.ativo && x.papel === PAPEL.TRANSFERENCIA);
    if (cands.length !== 1) throw bad(cands.length ? "Há mais de uma categoria de transferência; informe categoriaId." : "Cadastre uma categoria com papel de transferência.", "CATEGORIA_TRANSFERENCIA_INDEFINIDA");
    categoriaId = cands[0].id;
  }
  const id = await deps.repo.criarTransferenciaRpc(c, {
    contaOrigemId: origem, contaDestinoId: destino, valorCentavos: valorPositivo(b?.valor), data: data(b?.data, "data"),
    descricao: texto(b?.descricao ?? "Transferência entre contas", "descricao"), categoriaId,
  }, deps.db);
  return { id };
}
/** Vincula duas pernas existentes (ex.: importadas). Ação humana e explícita. */
export async function vincularTransferencia(ctx, b, deps = padrao) {
  const id = await deps.repo.vincularTransferenciaRpc(exigirContexto(ctx), uuid(b?.saidaId, "saidaId"), uuid(b?.entradaId, "entradaId"), deps.db);
  return { id };
}
/** Desvincular pareamento INCORRETO: motivo obrigatório; as duas pernas continuam ATIVAS e voltam a pendentes. Não cancela nada. */
export async function desvincularTransferencia(ctx, id, b, deps = padrao) {
  const motivo = texto(b?.motivo, "motivo", { max: 1000 });
  if (motivo.length < 10) throw bad("Informe o motivo (mínimo de 10 caracteres).", "MOTIVO_OBRIGATORIO");
  const ok = await deps.repo.desvincularTransferenciaRpc(exigirContexto(ctx), uuid(id, "id"), motivo, deps.db);
  if (!ok) throw ApiError.notFound("Transferência não encontrada.");
  return { desvinculada: true };
}

/** Cancelar a TRANSFERÊNCIA INTEIRA (par + duas pernas), atômico, com motivo e auditoria; idempotente. */
export async function cancelarTransferencia(ctx, id, b, deps = padrao) {
  const motivo = texto(b?.motivo, "motivo", { max: 1000 });
  if (motivo.length < 10) throw bad("Informe o motivo (mínimo de 10 caracteres).", "MOTIVO_OBRIGATORIO");
  return deps.repo.cancelarTransferenciaRpc(exigirContexto(ctx), uuid(id, "id"), motivo, deps.db);
}
