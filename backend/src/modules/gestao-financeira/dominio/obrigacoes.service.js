// Contas a pagar (Financeiro 2.0): fornecedores, obrigações, pagamentos, quitação, classificação de acréscimos e painel de juros.
// Regras: a diferença é calculada sobre o TOTAL pago e só na obrigação QUITADA; pagamento parcial nunca vira desconto; registro feito por
// quem não pode confirmar (sem `conciliar`) nasce PROVISÓRIO e bloqueia o fechamento até ser confirmado; classificar exige `classificar`.
// A autoridade final é o banco (migration 151): este serviço valida a entrada, monta a visão e traduz erros.
import * as repositorio from "./repositorio.js";
import { exigirContexto, ACAO } from "./contexto.js";
import { texto, uuid, enumerado, data, valorPositivo, bad, mesAno } from "./validacao.js";
import { diferenca, situacao, diasAtraso, painelJuros as calcularPainelJuros, jurosDoMes as calcularJurosDoMes, ultimoPagamento, NATUREZAS_ACRESCIMO } from "../../../financeiro-calculos/contasPagar.js";
import { PAPEL } from "../../../financeiro-calculos/planoContas.js";
import { ApiError } from "../../../shared/ApiError.js";

const padrao = { repo: repositorio, db: undefined, hoje: () => new Date().toISOString().slice(0, 10) };
const pode = (perms, acao) => Array.isArray(perms) && perms.includes(acao);
const exigir = (perms, acao, msg) => { if (!pode(perms, acao)) throw ApiError.forbidden(msg, { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" }); };
const ultimoDiaDoMes = (ym) => { const [a, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const hojeDe = (deps) => (deps.hoje ?? padrao.hoje)();
/** Data-base dos status: fim do mês escolhido, ou hoje se o mês ainda não acabou. */
const dataBaseDe = (mes, deps) => { const h = hojeDe(deps); if (!mes) return h; const fim = ultimoDiaDoMes(mes); return fim < h ? fim : h; };
const motivo = (v) => { const m = texto(v, "motivo", { max: 1000 }); if (m.length < 10) throw bad("Informe o motivo (mínimo de 10 caracteres).", "MOTIVO_OBRIGATORIO"); return m; };

async function carregar(c, deps) {
  const [obrs, pags, forn, cats, contas, vincs] = await Promise.all([
    deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarPagamentos(c, deps.db), deps.repo.listarFornecedores(c, deps.db),
    deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarContas(c, deps.db), deps.repo.listarVinculosSaidas(c, deps.db),
  ]);
  const pagsPor = new Map();
  for (const p of pags) { if (!pagsPor.has(p.obrigacao_id)) pagsPor.set(p.obrigacao_id, []); pagsPor.get(p.obrigacao_id).push(p); }
  const conciliados = new Set(vincs.filter((v) => v.status === "conciliado").map((v) => v.pagamento_id));
  const vinculados = new Set(vincs.filter((v) => ["sugerido", "conciliado", "divergente"].includes(v.status)).map((v) => v.pagamento_id));
  return { obrs, pagsPor, forn: new Map(forn.map((f) => [f.id, f])), cats: new Map(cats.map((x) => [x.id, x])), contas: new Map(contas.map((x) => [x.id, x])), conciliados, vinculados };
}

function montarItem(o, base, dataBase) {
  const pags = base.pagsPor.get(o.id) ?? [];
  const d = diferenca(o, pags);
  const ativos = pags.filter((p) => p.status === "ativo");
  return {
    id: o.id, fornecedorId: o.fornecedor_id, fornecedor: base.forn.get(o.fornecedor_id)?.nome ?? null, categoriaId: o.categoria_id, categoria: base.cats.get(o.categoria_id)?.nome ?? null,
    descricao: o.descricao, competencia: String(o.competencia).slice(0, 7), vencimento: o.vencimento, valorOriginalCentavos: Number(o.valor_original_centavos),
    status: o.status, provisoria: o.provisoria === true || ativos.some((p) => p.provisorio === true), registroProvisorio: o.provisoria === true, dataQuitacao: o.data_quitacao ?? null, classificacao: o.classificacao_diferenca ?? null,
    observacoes: o.observacoes ?? null, motivoCancelamento: o.motivo_cancelamento ?? null, motivoReversao: o.motivo_reversao ?? null, origem: o.origem, chaveOrigem: o.chave_origem ?? null,
    ...d, situacao: situacao(o, pags, dataBase), diasAtraso: diasAtraso(o, pags, dataBase), ultimoPagamento: ultimoPagamento(pags),
    pagamentos: pags.map((p) => ({ id: p.id, data: p.data_pagamento, valorCentavos: Number(p.valor_centavos), contaId: p.conta_id ?? null, conta: base.contas.get(p.conta_id)?.nome ?? null, status: p.status,
      origemPagamento: p.origem_pagamento ?? "conta", terceiro: p.terceiro_nome ?? null, dividaId: p.divida_id ?? null,
      comprovanteRef: p.comprovante_ref ?? null, observacao: p.observacao ?? null, motivoCancelamento: p.motivo_cancelamento ?? null, provisorio: p.provisorio === true,
      conciliacao: p.status !== "ativo" ? null : base.conciliados.has(p.id) ? "conciliado" : base.vinculados.has(p.id) ? "em_analise" : "pendente" })),
    pagamentosConciliados: ativos.filter((p) => base.conciliados.has(p.id)).length, pagamentosAtivos: ativos.length,
  };
}

/** Pertence ao mês: competência no mês, quitada no mês, ou ainda aberta e vencida/vencendo até o fim do mês (carrega o saldo de meses anteriores). */
const doMes = (i, mes) => i.competencia === mes || (i.dataQuitacao ?? "").startsWith(mes) || (i.status === "aberta" && i.vencimento <= ultimoDiaDoMes(mes) && i.competencia <= mes);

// ---------------------------------------------------------------- fornecedores
export async function listarFornecedores(ctx, deps = padrao) {
  return (await deps.repo.listarFornecedores(exigirContexto(ctx), deps.db)).map((f) => ({ id: f.id, nome: f.nome, documento: f.documento ?? null, ativo: f.ativo }));
}
export async function criarFornecedor(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const nome = texto(b?.nome, "nome", { max: 120 });
  const documento = texto(b?.documento, "documento", { max: 20, obrigatorio: false });
  const f = await deps.repo.inserirFornecedor(c, { nome, documento }, deps.db);
  return { id: f.id, nome: f.nome, documento: f.documento ?? null, ativo: f.ativo };
}
async function resolverFornecedor(c, b, deps) {
  const id = uuid(b?.fornecedorId, "fornecedorId", { obrigatorio: false });
  const lista = await deps.repo.listarFornecedores(c, deps.db);
  if (id) { const f = lista.find((x) => x.id === id); if (!f) throw bad("Fornecedor não encontrado.", "FORNECEDOR_INEXISTENTE"); return f.id; }
  const nome = texto(b?.fornecedorNome, "fornecedor", { max: 120 });
  const igual = lista.find((x) => x.nome.trim().toLowerCase() === nome.toLowerCase());
  return igual ? igual.id : (await deps.repo.inserirFornecedor(c, { nome }, deps.db)).id;
}
async function categoriaValida(c, id, deps) {
  const cat = (await deps.repo.listarPlanoContas(c, deps.db)).find((x) => x.id === id);
  if (!cat) throw bad("Categoria não encontrada.", "CATEGORIA_INEXISTENTE");
  if (!cat.ativo) throw bad("Categoria inativa.", "CATEGORIA_INATIVA");
  if ([PAPEL.TRANSFERENCIA, PAPEL.SALDO_ANTERIOR, "receita_operacional"].includes(cat.papel)) throw bad("Escolha uma categoria de custo ou despesa.", "CATEGORIA_NAO_DESPESA");
  return cat;
}
async function contaValida(c, id, deps) {
  const conta = (await deps.repo.listarContas(c, deps.db)).find((x) => x.id === id);
  if (!conta) throw bad("Conta não encontrada.", "CONTA_INEXISTENTE");
  if (!conta.ativo) throw bad("Conta inativa.", "CONTA_INATIVA");
  return conta;
}

// ---------------------------------------------------------------- consultas
export async function listar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = q?.mes ? mesAno(q.mes) : null;
  const dataBase = dataBaseDe(mes, deps);
  const base = await carregar(c, deps);
  let itens = base.obrs.map((o) => montarItem(o, base, dataBase));
  if (mes) itens = itens.filter((i) => doMes(i, mes));
  const filtro = {
    situacao: q?.situacao ? String(q.situacao) : null, fornecedorId: uuid(q?.fornecedorId, "fornecedorId", { obrigatorio: false }),
    categoriaId: uuid(q?.categoriaId, "categoriaId", { obrigatorio: false }), contaId: uuid(q?.contaId, "contaId", { obrigatorio: false }),
    busca: texto(q?.busca, "busca", { max: 80, obrigatorio: false })?.toLowerCase() ?? null,
  };
  const todos = itens;
  itens = itens.filter((i) => (!filtro.situacao || i.situacao === filtro.situacao || (filtro.situacao === "provisoria" && i.provisoria))
    && (!filtro.fornecedorId || i.fornecedorId === filtro.fornecedorId) && (!filtro.categoriaId || i.categoriaId === filtro.categoriaId)
    && (!filtro.contaId || i.pagamentos.some((p) => p.contaId === filtro.contaId))
    && (!filtro.busca || `${i.fornecedor} ${i.descricao}`.toLowerCase().includes(filtro.busca)));
  const soma = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const abertas = todos.filter((i) => i.status === "aberta");
  return {
    mes, dataBase, itens: itens.sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.id.localeCompare(b.id)),
    resumo: {
      emAbertoCentavos: soma(abertas, (i) => i.saldoAbertoCentavos),
      vencidoCentavos: soma(abertas.filter((i) => i.vencimento < dataBase), (i) => i.saldoAbertoCentavos),
      aVencerCentavos: soma(abertas.filter((i) => i.vencimento >= dataBase), (i) => i.saldoAbertoCentavos),
      quitadas: todos.filter((i) => i.status === "quitada").length,
      acrescimosCentavos: soma(todos.filter((i) => (i.diferencaCentavos ?? 0) > 0 && (!mes || (i.dataQuitacao ?? "").startsWith(mes))), (i) => i.diferencaCentavos),
      acrescimosPresumidosCentavos: soma(todos.filter((i) => i.natureza === "presumido" && (!mes || (i.dataQuitacao ?? "").startsWith(mes))), (i) => i.diferencaCentavos),
      aVerificar: todos.filter((i) => i.natureza === "a_verificar").length,
      quitacaoPendente: todos.filter((i) => i.situacao === "quitacao_pendente").length,
      provisorias: todos.filter((i) => i.provisoria && i.status !== "cancelada").length,
    },
  };
}

export async function obter(ctx, id, deps = padrao) {
  const c = exigirContexto(ctx);
  const oid = uuid(id, "id");
  const base = await carregar(c, deps);
  const o = base.obrs.find((x) => x.id === oid);
  if (!o) throw ApiError.notFound("Conta a pagar não encontrada.");
  const item = montarItem(o, base, dataBaseDe(null, deps));
  const auditoria = await deps.repo.listarAuditoria(c, { entidade: "fin_obrigacoes", entidadeId: oid, limite: 50 }, deps.db);
  return { ...item, historico: auditoria.map((a) => ({ id: a.id, em: a.created_at, ator: a.ator_id, acao: a.acao, antes: resumoAud(a.antes), depois: resumoAud(a.depois) })) };
}
const resumoAud = (j) => (j ? { status: j.status, valorOriginalCentavos: j.valor_original_centavos != null ? Number(j.valor_original_centavos) : undefined, classificacao: j.classificacao_diferenca ?? null, provisoria: j.provisoria, dataQuitacao: j.data_quitacao ?? null } : null);

// ---------------------------------------------------------------- escrita
/**
 * Registrar uma conta a pagar (e, opcionalmente, o primeiro pagamento e a quitação na mesma ação de tela).
 * Etapas em sequência (não é uma transação única): se o pagamento for recusado, a conta fica registrada e ABERTA, e o erro é devolvido.
 */
export async function criar(ctx, b, deps = padrao, { permissoes = [] } = {}) {
  const o = await criarSemRetorno(ctx, b, deps, { permissoes });
  return obter(exigirContexto(ctx), o.id, deps);
}
/** Mesma criação, sem recarregar a conta completa no fim (usado na importação em lote, para não reler as tabelas a cada título). */
export async function criarSemRetorno(ctx, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  const quitar = b?.quitar === true;
  if (quitar) exigir(permissoes, ACAO.CONCILIAR, "Seu perfil registra o pagamento, mas não confirma a quitação: um gerente, a contadora ou o administrador confirma.");
  const categoria = await categoriaValida(c, uuid(b?.categoriaId, "categoriaId"), deps);
  const fornecedorId = await resolverFornecedor(c, b, deps);
  const pag = b?.pagamento ? await validarPagamento(c, b.pagamento, deps) : null;
  const o = await deps.repo.inserirObrigacao(c, {
    fornecedor_id: fornecedorId, categoria_id: categoria.id, descricao: texto(b?.descricao ?? categoria.nome, "descricao"),
    competencia: `${mesAno(b?.competencia, "competencia")}-01`, vencimento: data(b?.vencimento, "vencimento"), valor_original_centavos: valorPositivo(b?.valorOriginal, "valorOriginal"),
    observacoes: texto(b?.observacoes, "observacoes", { max: 1000, obrigatorio: false }), provisoria: !pode(permissoes, ACAO.CONCILIAR),
  }, deps.db);
  if (pag) await deps.repo.inserirPagamento(c, { obrigacao_id: o.id, ...pag, provisorio: !pode(permissoes, ACAO.CONCILIAR) }, deps.db);
  if (pag && quitar) await deps.repo.quitarObrigacaoRpc(c, o.id, deps.db);
  return o;
}

export const ORIGENS_PAGAMENTO = ["conta", "origem_pendente", "terceiro"];
/**
 * Pagamento com a CONTA DA EMPRESA (padrão), com ORIGEM PENDENTE (despesa paga e reconhecida, conta de saída ainda desconhecida) ou PAGO POR TERCEIRO
 * (vinculado à dívida de reembolso). Origem pendente e terceiro NÃO criam saída bancária e nunca são conciliados com extrato.
 */
async function validarPagamento(c, p, deps) {
  const origem = enumerado(p?.origemPagamento ?? "conta", "origemPagamento", ORIGENS_PAGAMENTO);
  const base = { data_pagamento: data(p?.data, "data do pagamento"), valor_centavos: valorPositivo(p?.valor, "valor pago"), comprovante_ref: texto(p?.comprovanteRef, "comprovante", { max: 300, obrigatorio: false }),
    observacao: texto(p?.observacao, "observacao", { max: 1000, obrigatorio: origem !== "conta" }), origem_pagamento: origem, conta_id: null, terceiro_nome: null, divida_id: null };
  if (origem !== "conta" && base.observacao.length < 10) throw bad("Sem conta de saída, escreva a fonte do pagamento (mínimo de 10 caracteres): documento, quem informou e quando.", "FONTE_OBRIGATORIA");
  if (origem === "conta") { base.conta_id = (await contaValida(c, uuid(p?.contaId, "contaId"), deps)).id; return base; }
  if (origem === "terceiro") {
    if (!p?.dividaId) throw bad("Escolha a dívida de reembolso (ex.: a da sócia): é o vínculo do pagamento por terceiro.", "DIVIDA_OBRIGATORIA");
    const div = (await deps.repo.listarDividas(c, deps.db)).find((d) => d.id === uuid(p.dividaId, "dividaId"));
    if (!div || div.status !== "ativa") throw bad("Escolha uma dívida ativa de reembolso (ex.: a da sócia): é o vínculo do pagamento por terceiro.", "DIVIDA_OBRIGATORIA");
    base.divida_id = div.id; base.terceiro_nome = texto(p?.terceiro ?? div.credor, "terceiro", { max: 120 });
  }
  return base;
}

/** Edição. Quem não confirma (sem `conciliar`) e altera dado financeiro de conta já confirmada a devolve a PROVISÓRIA (precisa reconfirmação). */
export async function atualizar(ctx, id, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  const oid = uuid(id, "id");
  const atual = await deps.repo.obterObrigacao(c, oid, deps.db);
  if (!atual) throw ApiError.notFound("Conta a pagar não encontrada.");
  const campos = {};
  if (b?.descricao !== undefined) campos.descricao = texto(b.descricao, "descricao");
  if (b?.vencimento !== undefined) campos.vencimento = data(b.vencimento, "vencimento");
  if (b?.valorOriginal !== undefined) campos.valor_original_centavos = valorPositivo(b.valorOriginal, "valorOriginal");
  if (b?.competencia !== undefined) campos.competencia = `${mesAno(b.competencia, "competencia")}-01`;
  if (b?.categoriaId !== undefined) campos.categoria_id = (await categoriaValida(c, uuid(b.categoriaId, "categoriaId"), deps)).id;
  if (b?.fornecedorId !== undefined || b?.fornecedorNome !== undefined) campos.fornecedor_id = await resolverFornecedor(c, b, deps);
  if (b?.observacoes !== undefined) campos.observacoes = texto(b.observacoes, "observacoes", { max: 1000, obrigatorio: false });
  if (!Object.keys(campos).length) throw bad("Nada para atualizar.");
  const norm = (k, v) => (k === "valor_original_centavos" ? Number(v) : k === "competencia" || k === "vencimento" ? String(v ?? "").slice(0, 10) : String(v ?? ""));
  const financeiro = ["valor_original_centavos", "competencia", "categoria_id", "fornecedor_id", "vencimento"].some((k) => k in campos && norm(k, campos[k]) !== norm(k, atual[k]));
  if (financeiro && !pode(permissoes, ACAO.CONCILIAR)) {
    if (atual.status === "quitada") throw ApiError.forbidden("Conta quitada: a alteração de dados financeiros é feita por um gerente, a contadora ou o administrador.", { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" });
    if (!atual.provisoria) campos.provisoria = true;
  }
  await deps.repo.atualizarObrigacao(c, oid, campos, deps.db);
  return obter(c, oid, deps);
}

export async function registrarPagamento(ctx, id, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  const oid = uuid(id, "id");
  if (b?.quitar === true) exigir(permissoes, ACAO.CONCILIAR, "Seu perfil registra o pagamento, mas não confirma a quitação.");
  if (b?.quitar === true && (b?.origemPagamento ?? "conta") === "origem_pendente") throw bad("Pagamento com origem pendente não quita a conta: identifique primeiro de qual conta ele saiu.", "ORIGEM_PENDENTE_NAO_QUITA");
  if (!(await deps.repo.obterObrigacao(c, oid, deps.db))) throw ApiError.notFound("Conta a pagar não encontrada.");
  // (revisão #5) pagamento registrado por quem não confirma (operador) nasce PROVISÓRIO e bloqueia o fechamento até ser confirmado
  const pg = await validarPagamento(c, b, deps);
  await deps.repo.inserirPagamento(c, { obrigacao_id: oid, ...pg, provisorio: pg.origem_pagamento === "origem_pendente" || !pode(permissoes, ACAO.CONCILIAR) }, deps.db);
  if (b?.quitar === true) await deps.repo.quitarObrigacaoRpc(c, oid, deps.db);
  return obter(c, oid, deps);
}

export async function cancelarPagamento(ctx, pagamentoId, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const pid = uuid(pagamentoId, "id");
  const p = await deps.repo.obterPagamento(c, pid, deps.db);
  if (!p) throw ApiError.notFound("Pagamento não encontrado.");
  if (p.status === "cancelado") return obter(c, p.obrigacao_id, deps);
  await deps.repo.atualizarPagamento(c, pid, { status: "cancelado", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: new Date().toISOString() }, deps.db);
  return obter(c, p.obrigacao_id, deps);
}

/** Resolve a ORIGEM PENDENTE de um pagamento: informa a conta de onde saiu (uma vez). Continua provisório até a quitação/confirmação. */
export async function resolverOrigemPagamento(ctx, pagamentoId, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const pid = uuid(pagamentoId, "id");
  const p = await deps.repo.obterPagamento(c, pid, deps.db);
  if (!p) throw ApiError.notFound("Pagamento não encontrado.");
  if (p.origem_pagamento !== "origem_pendente") throw bad("Só pagamento com origem pendente pode ter a conta informada.", "ORIGEM_JA_DEFINIDA");
  const conta = await contaValida(c, uuid(b?.contaId, "contaId"), deps);
  await deps.repo.atualizarPagamento(c, pid, { conta_id: conta.id, origem_pagamento: "conta", observacao: `${p.observacao ?? ""} · Conta de saída informada depois: ${conta.nome}.`.slice(0, 1000) }, deps.db);
  return obter(c, p.obrigacao_id, deps);
}

export async function quitar(ctx, id, deps = padrao) {
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  if ((await deps.repo.listarPagamentos(c, deps.db)).some((p) => p.obrigacao_id === oid && p.status !== "cancelado" && p.origem_pagamento === "origem_pendente")) throw bad("Há pagamento com origem pendente nesta conta: identifique a conta de saída antes de quitar.", "ORIGEM_PENDENTE_NAO_QUITA");
  await deps.repo.quitarObrigacaoRpc(c, oid, deps.db);
  return obter(c, oid, deps);
}
export async function desfazerQuitacao(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  await deps.repo.desfazerQuitacaoRpc(c, oid, motivo(b?.motivo), deps.db);
  return obter(c, oid, deps);
}
/** Classificar a diferença (null = voltar a "presumido"/"a verificar"). O banco confere o sinal da diferença. */
export async function classificar(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  const cl = b?.classificacao === null || b?.classificacao === "" ? null : enumerado(b?.classificacao, "classificacao", [...NATUREZAS_ACRESCIMO, "desconto"]);
  await deps.repo.classificarObrigacaoRpc(c, oid, cl, deps.db);
  return obter(c, oid, deps);
}
/** Quitar e classificar o acréscimo em UMA decisão (datas efetivas dos pagamentos preservadas; quitação = data do último pagamento). */
export async function quitarEClassificar(ctx, id, b, deps = padrao, { permissoes = [] } = {}) {
  exigir(permissoes, ACAO.CONCILIAR, "Quitar e classificar exige também a permissão de confirmar a quitação.");
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  const cl = enumerado(b?.classificacao, "classificacao", NATUREZAS_ACRESCIMO);
  const m = texto(b?.motivo, "motivo", { max: 300 }); if (m.length < 10) throw bad("Informe o motivo da classificação (mínimo de 10 caracteres).", "MOTIVO_OBRIGATORIO");
  const atual = await obter(c, oid, deps);
  if (atual.status === "aberta") await quitar(c, oid, deps);
  await deps.repo.classificarObrigacaoRpc(c, oid, cl, deps.db);
  return obter(c, oid, deps);
}
export async function confirmarRegistro(ctx, id, deps = padrao) {
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  await deps.repo.confirmarRegistroRpc(c, oid, deps.db);
  return obter(c, oid, deps);
}
export async function cancelar(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx); const oid = uuid(id, "id");
  await deps.repo.cancelarObrigacaoRpc(c, oid, motivo(b?.motivo), deps.db);
  return obter(c, oid, deps);
}

// ---------------------------------------------------------------- juros e encargos
/** Painel de juros e encargos de CONTAS A PAGAR no intervalo de meses [de, ate] (mês da quitação). Juros de empréstimo NÃO entram. */
export async function painelJuros(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const de = q?.de ? mesAno(q.de, "de") : null, ate = q?.ate ? mesAno(q.ate, "ate") : null;
  if (de && ate && de > ate) throw bad("O período está invertido (de > ate).");
  const base = await carregar(c, deps);
  const itens = base.obrs.filter((o) => o.status === "quitada" && (!de || String(o.data_quitacao).slice(0, 7) >= de) && (!ate || String(o.data_quitacao).slice(0, 7) <= ate))
    .map((o) => ({ obrigacao: o, pagamentos: base.pagsPor.get(o.id) ?? [], fornecedor: base.forn.get(o.fornecedor_id)?.nome, categoria: base.cats.get(o.categoria_id)?.nome }));
  return { de, ate, natureza: "contas_a_pagar", observacao: "Acréscimos de contas pagas (atraso, multa, tarifa). Juros de empréstimos ficam em Empréstimos, com natureza própria.", ...calcularPainelJuros(itens) };
}

/** Juros e encargos de um mês em duas leituras: pagos no mês × da competência (inclui obrigação ainda aberta com pago acima do original). */
export async function jurosDoMes(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const base = await carregar(c, deps);
  const itens = base.obrs.map((o) => ({ obrigacao: o, pagamentos: base.pagsPor.get(o.id) ?? [], fornecedor: base.forn.get(o.fornecedor_id)?.nome, categoria: base.cats.get(o.categoria_id)?.nome }));
  return { natureza: "contas_a_pagar", observacao: "Acréscimo = total pago − valor original da obrigação. Pagamento parcial não é desconto. Juros de empréstimos ficam em Dívidas.", ...calcularJurosDoMes(itens, mes) };
}

/** Resumo para a Visão Geral e o pré-fechamento: contas a pagar + bloqueios de fechamento do mês (do banco). */
export async function resumoMes(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const [lista, juros, bloqueios] = await Promise.all([listar(c, { mes }, deps), painelJuros(c, { de: mes, ate: mes }, deps), deps.repo.bloqueiosFechamentoRpc(c, `${mes}-01`, deps.db)]);
  return { mes, dataBase: lista.dataBase, contasPagar: lista.resumo, juros: juros.totais, bloqueiosFechamento: bloqueios };
}
