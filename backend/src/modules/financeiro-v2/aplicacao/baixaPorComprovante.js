// Execução 17 — PAGAMENTO REGISTRADO POR COMPROVANTE (baixa documental) × CONCILIAÇÃO COM O EXTRATO.
//
// Duas dimensões independentes de uma conta a pagar:
//   - PAGAMENTO: a conta fica paga (parcial ou quitada) quando há COMPROVANTE de pagamento concluído — sem exigir que o
//     extrato já tenha sido importado. A liquidação nasce SEM movimentação bancária (`movimentacaoId = null`,
//     `origemDoVinculo = "COMPROVANTE"`): nenhuma saída é inventada; saldo de banco e fluxo realizado só mudam com o extrato.
//   - CONCILIAÇÃO: fica PENDENTE até a saída do extrato chegar. Conciliar LIGA a saída existente à MESMA liquidação
//     (preenche `movimentacaoId` e consome o alocável da saída) — não cria segunda liquidação, segunda saída nem despesa;
//     a posição da conta não muda.
// Travas:
//   - permissão própria `financeiro_v2.baixar_por_comprovante` (nenhuma concessão existente a recebe); conciliar usa
//     `financeiro_v2.vincular_pagamento`;
//   - o documento precisa existir na unidade e ser do tipo COMPROVANTE; o mesmo comprovante (ou o mesmo identificador de
//     transação) só baixa UMA vez, em qualquer conta (idempotente para o mesmo pedido, recusa para outro);
//   - a baixa pelo extrato comum (vincularPagamentoDoExtrato/registrarLiquidacao) recusa a conta que tem pagamento por
//     comprovante do mesmo valor ainda sem conciliação: o caminho certo é conciliar, nunca baixar de novo;
//   - o banco repete as regras (migração 0029).
import { exigirPagamentoLiberado } from "./guardaEntregadores.js";
import { JUSTIFICATIVA_MINIMA_JUROS, LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL, limiteDeJurosSemJustificativa, motivoDeSaidaInelegivel } from "./baixaPorExtrato.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { CATEGORIA_JUROS_E_MULTAS } from "../dominio/planoDeContas.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, EVENTO_HISTORICO, SITUACAO_LIQUIDACAO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { formatarBRL, somar, subtrair } from "../dominio/dinheiro.js";
import { competenciaDe, diasEntre, exigirData, somarDias } from "../dominio/tempo.js";
import { aplicarLiquidacao } from "../dominio/titulos.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos, exigirInteiro } from "../dominio/validacao.js";
import { exigirCentavos } from "../dominio/dinheiro.js";

export const ORIGEM_COMPROVANTE = "COMPROVANTE";
/** Situação da CONCILIAÇÃO bancária de uma liquidação (independente da situação do pagamento). */
export const CONCILIACAO_BANCARIA = Object.freeze({ PENDENTE: "CONCILIACAO_PENDENTE", CONCILIADA: "CONCILIADO_COM_EXTRATO" });
/** Diferença máxima (dias) entre a data do comprovante e a da saída do extrato para conciliar sem revisão. */
export const TOLERANCIA_DIAS_CONCILIACAO = 3;

const valido = (l) => subtrair(l.valorCentavos, l.estornadoCentavos ?? 0);
export const ehPorComprovante = (l) => l?.origemDoVinculo === ORIGEM_COMPROVANTE;
export const comprovantePendente = (l) => ehPorComprovante(l) && !l.movimentacaoId && l.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA && valido(l) > 0;
const distancia = (a, b) => { const [x, y] = [a, b].sort(); return diasEntre(x, y); };
const ID_TRANSACAO = /^[A-Za-z0-9._:/-]{6,80}$/;

function validarBaixaPorComprovante(e) {
  semCamposDesconhecidos(e ?? {}, ["obrigacaoId", "valorCentavos", "dataPagamento", "documentoId", "idTransacao", "justificativa", "confirmar"], "baixaPorComprovante");
  const idTransacao = e.idTransacao === undefined || e.idTransacao === null || e.idTransacao === "" ? null : String(e.idTransacao).trim();
  if (idTransacao !== null && !ID_TRANSACAO.test(idTransacao)) falhar(CODIGO.ENTRADA_INVALIDA, "Identificador de transação inválido.", { campo: "idTransacao" });
  return {
    obrigacaoId: exigirUuid(e.obrigacaoId, "obrigacaoId"),
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    dataPagamento: exigirData(e.dataPagamento, "dataPagamento"),
    documentoId: exigirUuid(e.documentoId, "documentoId"),
    idTransacao,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
    confirmar: e.confirmar === true,
  };
}

export const TIPOS_DE_ENCARGO = Object.freeze(["JUROS", "MULTA", "JUROS_E_MULTA"]);
const ROTULO_ENCARGO = Object.freeze({ JUROS: "Juros", MULTA: "Multa", JUROS_E_MULTA: "Juros e multa" });
/** Pagamento por comprovante COM encargo: o valor do comprovante é o TOTAL (principal = saldo da conta + encargo). */
function validarPagamentoComEncargo(e) {
  const { encargoCentavos, tipoEncargo, ...resto } = e ?? {};
  const c = validarBaixaPorComprovante(resto);
  const tipo = tipoEncargo === undefined || tipoEncargo === null ? "JUROS" : String(tipoEncargo);
  if (!TIPOS_DE_ENCARGO.includes(tipo)) falhar(CODIGO.ENTRADA_INVALIDA, "Tipo de encargo inválido.", { campo: "tipoEncargo" });
  return { ...c, encargoCentavos: exigirCentavos(encargoCentavos, "encargoCentavos", { positivo: true }), tipoEncargo: tipo };
}

function validarConciliacaoDoComprovante(e) {
  semCamposDesconhecidos(e ?? {}, ["liquidacaoId", "movimentacaoId", "versaoMovimentacao", "justificativa", "confirmar"], "conciliacaoDoComprovante");
  return {
    liquidacaoId: exigirUuid(e.liquidacaoId, "liquidacaoId"),
    movimentacaoId: exigirUuid(e.movimentacaoId, "movimentacaoId"),
    versaoMovimentacao: exigirInteiro(e.versaoMovimentacao, "versaoMovimentacao", { min: 1 }),
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
    confirmar: e.confirmar === true,
  };
}

/** Chave única do comprovante: o próprio documento (um comprovante baixa uma única vez, em qualquer conta). */
const chaveDoComprovante = (c) => `comprovante:doc:${c.documentoId}`;
/** Janela (dias) em que se procura o MESMO identificador de transação usado por outro documento. */
const JANELA_ID_TRANSACAO = 90;

/**
 * Trava usada pela baixa por EXTRATO: a conta com pagamento por comprovante do mesmo valor ainda não conciliado não
 * recebe outra baixa — a saída deve ser CONCILIADA com a liquidação que já existe.
 */
export async function exigirSemComprovantePendente(tx, cx, obrigacaoId, valorCentavos) {
  const pend = (await tx.listar(cx, TIPO.LIQUIDACAO, { onde: { alvoId: obrigacaoId } })).filter(comprovantePendente);
  const igual = pend.find((l) => valido(l) === valorCentavos);
  if (igual) {
    falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Esta conta já foi paga por comprovante e aguarda a conciliação: concilie a saída do extrato com esse pagamento (não baixe de novo).",
      { motivo: "PAGAMENTO_POR_COMPROVANTE_A_CONCILIAR", liquidacaoId: igual.id, valorCentavos });
  }
}

/**
 * Corpo ÚNICO do pagamento por comprovante (com ou sem encargo): transacional e idempotente pelo documento. Com encargo, o
 * ajuste (juros/multa) e a liquidação nascem na MESMA transação; a repetição nunca lança o encargo de novo.
 */
async function pagarPorComprovante(b, tx, cx, c) {
  const chave = chaveDoComprovante(c);
  await tx.travar(cx, chave, "EXCLUSIVA");
  const ja = await tx.buscarPorChave(cx, TIPO.LIQUIDACAO, chave);
  if (ja) {
    if (ja.alvoId === c.obrigacaoId && ja.valorCentavos === c.valorCentavos && ja.documentoId === c.documentoId) {
      return { repetido: true, liquidacao: ja, titulo: await tx.obter(cx, TIPO.OBRIGACAO, ja.alvoId), conciliacao: ja.movimentacaoId ? CONCILIACAO_BANCARIA.CONCILIADA : CONCILIACAO_BANCARIA.PENDENTE };
    }
    falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Este comprovante (ou esta transação) já foi usado para registrar um pagamento.", { motivo: "COMPROVANTE_DUPLICADO", liquidacaoId: ja.id, obrigacaoId: ja.alvoId });
  }
  if (!c.confirmar) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a conta, o valor e o comprovante e confirme o registro do pagamento.");
  if (c.dataPagamento > b.hoje()) falhar(CODIGO.DATA_INVALIDA, "A data do pagamento não pode estar no futuro (comprovante de agendamento não é pagamento).", { campo: "dataPagamento" });
  const doc = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Comprovante");
  if (doc.tipo !== "COMPROVANTE") falhar(CODIGO.EVIDENCIA_EXIGIDA, "Só um documento do tipo COMPROVANTE registra pagamento sem extrato.", { motivo: "DOCUMENTO_NAO_E_COMPROVANTE", tipo: doc.tipo });
  // A MESMA transação (identificador do banco) num outro arquivo também não baixa duas vezes.
  if (c.idTransacao) {
    const tx0 = c.idTransacao.toUpperCase();
    await tx.travar(cx, `comprovante:tx:${tx0}`, "EXCLUSIVA");
    const perto = await tx.listar(cx, TIPO.LIQUIDACAO, { desde: { dataEfetiva: somarDias(c.dataPagamento, -JANELA_ID_TRANSACAO) }, ate: { dataEfetiva: somarDias(c.dataPagamento, JANELA_ID_TRANSACAO) } });
    const mesma = perto.find((l) => ehPorComprovante(l) && String(l.idTransacao ?? "").toUpperCase() === tx0 && l.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA);
    if (mesma) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Esta transação já foi usada (outro arquivo do mesmo comprovante) para registrar um pagamento.", { motivo: "COMPROVANTE_DUPLICADO", liquidacaoId: mesma.id, obrigacaoId: mesma.alvoId });
  }
  await tx.travar(cx, `obrigacao:${c.obrigacaoId}`, "EXCLUSIVA");
  let o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoId, "Conta a pagar");
  if (o.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Conta cancelada não recebe pagamento.");
  let encargo = null;
  if (c.encargoCentavos) { encargo = await lancarEncargoDoPagamento(b, tx, cx, c, o); o = encargo.alvo; }
  if (c.valorCentavos > o.saldoCentavos) {
    falhar(CODIGO.LIQUIDACAO_EXCEDE_SALDO, `O comprovante (${formatarBRL(c.valorCentavos)}) supera o saldo em aberto da conta (${formatarBRL(o.saldoCentavos)}): revisar.`, { motivo: "VALOR_ACIMA_DO_SALDO", saldoCentavos: o.saldoCentavos });
  }
  await exigirPagamentoLiberado(tx, cx, o);
  await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(c.dataPagamento)], referenciadas: [o.competencia], motivo: "pagamento registrado por comprovante" });
  const liquidacao = await b.criar(tx, cx, TIPO.LIQUIDACAO, {
    movimentacaoId: null, alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id, valorCentavos: c.valorCentavos, estornadoCentavos: 0, dataEfetiva: c.dataPagamento,
    situacao: SITUACAO_LIQUIDACAO.VALIDA, chaveIdempotencia: chave, origemDoVinculo: ORIGEM_COMPROVANTE, documentoId: doc.id, idTransacao: c.idTransacao,
  }, c.justificativa);
  const titulo = await b.alterar(tx, cx, TIPO.OBRIGACAO, o, aplicarLiquidacao(o, c.valorCentavos), EVENTO_HISTORICO.LIQUIDACAO, `Pago por comprovante: ${c.justificativa}`.slice(0, 500));
  const chaveV = `${doc.id}|${TIPO.OBRIGACAO}|${o.id}`;
  if (!(await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chaveV))) {
    await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { documentoId: doc.id, registroTipo: TIPO.OBRIGACAO, registroId: o.id, chaveIdempotencia: chaveV, finalidade: "Comprova o pagamento (conciliação com o extrato pendente)" }, c.justificativa);
  }
  return { repetido: false, liquidacao, titulo, conciliacao: CONCILIACAO_BANCARIA.PENDENTE, ...(encargo ? { encargo: { ajuste: encargo.ajuste, lancamento: encargo.lancamento, tipo: c.tipoEncargo, valorCentavos: c.encargoCentavos } } : {}),
    efeito: { novasSaidas: 0, novasDespesas: encargo ? 1 : 0, pagoCentavos: c.valorCentavos, ...(encargo ? { encargoCentavos: c.encargoCentavos } : {}) } };
}

/**
 * Encargo (juros/multa) do pagamento por comprovante — ação ESTREITA `registrar_juros`, sempre junto com o pagamento:
 *   • só quita a conta: comprovante = saldo em aberto + encargo; • teto de ${LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL}% do valor da conta (acima: revisão humana, sem exceção);
 *   • categoria oficial "Juros e multas pagos a fornecedores" (despesa financeira, competência do PAGAMENTO), nunca outra;
 *   • o lançamento do ajuste usa o mecanismo oficial (registrarAjuste); a elevação a `corrigir` é interna a esta operação.
 */
async function lancarEncargoDoPagamento(b, tx, cx, c, o) {
  if (!(cx.permissoes ?? []).includes(ACAO.REGISTRAR_JUROS)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Registrar juros ou multa exige a permissão específica de registrar juros.", { acaoExigida: ACAO.REGISTRAR_JUROS });
  if (o.situacao === SITUACAO_TITULO.CANCELADA || !(o.saldoCentavos > 0)) falhar(CODIGO.ENTRADA_INVALIDA, "Só uma conta em aberto recebe juros ou multa.", { campo: "encargoCentavos" });
  if (c.encargoCentavos >= c.valorCentavos) falhar(CODIGO.ENTRADA_INVALIDA, "O encargo não pode ser o valor inteiro do comprovante.", { campo: "encargoCentavos" });
  const principal = subtrair(c.valorCentavos, c.encargoCentavos);
  if (principal !== o.saldoCentavos) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Juros ou multa só se classificam quando o pagamento quita a conta: o valor sem o encargo precisa ser igual ao saldo em aberto.", { campo: "encargoCentavos", saldoCentavos: o.saldoCentavos, principalCentavos: principal });
  }
  if (c.encargoCentavos > limiteDeJurosSemJustificativa(o.valorBaseCentavos)) {
    falhar(CODIGO.ENTRADA_INVALIDA, `O encargo passa de ${LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL}% do valor da conta: só uma pessoa autorizada registra (justificativa mínima ${JUSTIFICATIVA_MINIMA_JUROS} caracteres).`, { motivo: "ENCARGO_ACIMA_DO_LIMITE", campo: "encargoCentavos" });
  }
  // A categoria oficial existe no plano da unidade; a PRIMEIRA vez (se faltar) só quem pode corrigir a cria — esta ação não cria categoria.
  if (!(await b.categoriaPorCodigo(tx, cx, CATEGORIA_JUROS_E_MULTAS))) {
    if (!(cx.permissoes ?? []).includes(ACAO.CORRIGIR)) {
      falhar(CODIGO.ENTRADA_INVALIDA, "A categoria oficial de juros e multas ainda não existe nesta unidade: o primeiro encargo é registrado por uma pessoa autorizada.", { motivo: "CATEGORIA_DE_JUROS_AUSENTE", campo: "encargoCentavos" });
    }
    await b.categoriaDoSistema(tx, cx, CATEGORIA_JUROS_E_MULTAS);
  }
  const cxAjuste = { ...cx, permissoes: [...(cx.permissoes ?? []), ACAO.CORRIGIR] };
  return operacoesEconomicas(baseNaTransacao(b, tx, cxAjuste)).registrarAjuste(cxAjuste, {
    alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id, valorCentavos: c.encargoCentavos, categoria: CATEGORIA_JUROS_E_MULTAS, competencia: competenciaDe(c.dataPagamento),
    motivo: `${ROTULO_ENCARGO[c.tipoEncargo]} pagos ao fornecedor (conta ${formatarBRL(o.valorBaseCentavos)} + ${formatarBRL(c.encargoCentavos)}), pagamento por comprovante: ${c.justificativa}`.slice(0, 500),
    documentoId: c.documentoId,
  });
}

export function operacoesDeBaixaPorComprovante(b) {
  return {
    /**
     * Registra o PAGAMENTO de uma conta a pagar pelo comprovante (sem movimentação bancária). Conciliação fica pendente.
     * Transacional e idempotente (mesmo comprovante + mesma conta + mesmo valor ⇒ devolve o já registrado).
     */
    registrarPagamentoPorComprovante(ctx, entrada) {
      const c = validarBaixaPorComprovante(entrada);
      return b.executar(ctx, ACAO.BAIXAR_POR_COMPROVANTE, (cx, tx) => pagarPorComprovante(b, tx, cx, c));
    },

    /**
     * 23/11 — PAGAMENTO por comprovante COM encargo (juros/multa confirmados): lança o encargo como ajuste da conta (categoria
     * oficial) e liquida o TOTAL do comprovante na mesma transação. Exige `baixar_por_comprovante` + `registrar_juros` (+ o
     * comprovante); não cria saída, segunda despesa de compra nem segundo pagamento. Idempotente pelo documento.
     */
    registrarPagamentoComEncargo(ctx, entrada) {
      const c = validarPagamentoComEncargo(entrada);
      return b.executar(ctx, ACAO.BAIXAR_POR_COMPROVANTE, (cx, tx) => pagarPorComprovante(b, tx, cx, c));
    },

    /**
     * Pagamentos por comprovante ainda sem conciliação e, para cada um, as saídas do extrato candidatas (mesmo valor,
     * até TOLERANCIA_DIAS_CONCILIACAO dias de diferença, alocável suficiente). Mais de uma candidata ⇒ AMBIGUA (revisão).
     */
    consultarPagamentosPorComprovanteAConciliar(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const pendentes = (await tx.listar(cx, TIPO.LIQUIDACAO)).filter(comprovantePendente);
        const saidas = pendentes.length ? (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { sentido: "SAIDA" } })).filter((m) => !motivoDeSaidaInelegivel(m)) : [];
        const itens = [];
        for (const l of pendentes) {
          const candidatas = saidas.filter((m) => subtrair(m.valorCentavos, m.alocadoCentavos ?? 0) >= valido(l) && m.valorCentavos === valido(l)
            && distancia(l.dataEfetiva, m.dataEfetiva) <= TOLERANCIA_DIAS_CONCILIACAO)
            .map((m) => ({ movimentacaoId: m.id, versao: m.versao, data: m.dataEfetiva, contaId: m.contaId, descricao: m.descricao ?? null, valorCentavos: m.valorCentavos }));
          itens.push({
            liquidacaoId: l.id, obrigacaoId: l.alvoId, valorCentavos: valido(l), dataPagamento: l.dataEfetiva, documentoId: l.documentoId ?? null, idTransacao: l.idTransacao ?? null,
            situacao: candidatas.length === 0 ? "SEM_EXTRATO" : candidatas.length === 1 ? "CANDIDATA_UNICA" : "AMBIGUA", candidatas,
          });
        }
        return { itens, permissaoExigida: ACAO.VINCULAR_PAGAMENTO, voceTemPermissao: cx.permissoes.includes(ACAO.VINCULAR_PAGAMENTO) };
      });
    },

    /**
     * CONCILIA a saída do extrato com o pagamento JÁ registrado por comprovante: liga a saída à mesma liquidação.
     * Nada de segunda liquidação, segunda saída ou despesa; a posição da conta não muda. Idempotente.
     */
    conciliarPagamentoPorComprovante(ctx, entrada) {
      const c = validarConciliacaoDoComprovante(entrada);
      return b.executar(ctx, ACAO.VINCULAR_PAGAMENTO, async (cx, tx) => {
        await tx.travar(cx, `movimentacao:${c.movimentacaoId}`, "EXCLUSIVA");
        const liq = await b.obterOuFalhar(tx, cx, TIPO.LIQUIDACAO, c.liquidacaoId, "Pagamento por comprovante");
        if (!ehPorComprovante(liq)) falhar(CODIGO.OPERACAO_INVALIDA, "Só o pagamento registrado por comprovante é conciliado por aqui.");
        if (liq.movimentacaoId === c.movimentacaoId) return { repetido: true, liquidacao: liq, movimentacao: await tx.obter(cx, TIPO.MOVIMENTACAO, c.movimentacaoId), conciliacao: CONCILIACAO_BANCARIA.CONCILIADA };
        if (liq.movimentacaoId) falhar(CODIGO.OPERACAO_INVALIDA, "Este pagamento já foi conciliado com outra saída do extrato.", { motivo: "JA_CONCILIADO", movimentacaoId: liq.movimentacaoId });
        if (liq.situacao === SITUACAO_LIQUIDACAO.ESTORNADA || valido(liq) <= 0) falhar(CODIGO.OPERACAO_INVALIDA, "Pagamento estornado não se concilia.");
        if (!c.confirmar) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a saída do extrato e confirme a conciliação.");
        const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Saída bancária");
        if (mov.versao !== c.versaoMovimentacao) falhar(CODIGO.CONFLITO_VERSAO, "A saída mudou desde a consulta. Atualize e confira de novo.", { versaoAtual: mov.versao, versaoEsperada: c.versaoMovimentacao });
        const inelegivel = motivoDeSaidaInelegivel(mov);
        if (inelegivel) falhar(/integralmente/.test(inelegivel) ? CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO : CODIGO.LIQUIDACAO_INCOMPATIVEL, inelegivel);
        const valor = valido(liq);
        if (mov.valorCentavos !== valor) falhar(CODIGO.CONCILIACAO_INVALIDA, `A saída (${formatarBRL(mov.valorCentavos)}) não tem o valor do pagamento (${formatarBRL(valor)}): divergente, revisar.`, { motivo: "VALOR_DIVERGENTE" });
        if (subtrair(mov.valorCentavos, mov.alocadoCentavos ?? 0) < valor) falhar(CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO, "A saída já está vinculada a outro pagamento.");
        if (distancia(liq.dataEfetiva, mov.dataEfetiva) > TOLERANCIA_DIAS_CONCILIACAO) falhar(CODIGO.CONCILIACAO_INVALIDA, `A saída é de ${mov.dataEfetiva} e o comprovante de ${liq.dataEfetiva}: fora da tolerância de ${TOLERANCIA_DIAS_CONCILIACAO} dias, revisar.`, { motivo: "DATA_DIVERGENTE" });
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(mov.dataEfetiva)], referenciadas: [], motivo: "conciliação de pagamento por comprovante" });
        const liquidacao = await b.alterar(tx, cx, TIPO.LIQUIDACAO, liq, { movimentacaoId: mov.id, conciliadaEm: b.agora(), conciliadaPor: cx.usuarioId }, EVENTO_HISTORICO.CONCILIACAO, c.justificativa);
        const movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: somar(mov.alocadoCentavos ?? 0, valor) }, EVENTO_HISTORICO.CONCILIACAO, c.justificativa);
        if (liq.documentoId) {
          const chaveV = `${liq.documentoId}|${TIPO.MOVIMENTACAO}|${mov.id}`;
          if (!(await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chaveV))) {
            await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { documentoId: liq.documentoId, registroTipo: TIPO.MOVIMENTACAO, registroId: mov.id, chaveIdempotencia: chaveV, finalidade: "Comprovante do pagamento conciliado com esta saída" }, c.justificativa);
          }
        }
        return { repetido: false, liquidacao, movimentacao, conciliacao: CONCILIACAO_BANCARIA.CONCILIADA, efeito: { novasSaidas: 0, novasDespesas: 0, novasBaixas: 0, conciliadoCentavos: valor } };
      });
    },
  };
}
