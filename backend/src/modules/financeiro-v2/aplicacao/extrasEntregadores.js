// SERVIÇOS EXTRAS dos entregadores próprios: valores fora das taxas do parser Foody, sempre separados delas.
//
//   Total devido = taxas Foody + extras reconhecidos. Saldo em aberto = total devido − pagamentos.
//   * Extra já pago aumenta o custo e o pago, nunca o saldo, e nunca é abatido das taxas normais.
//   * Conta ou saída que já existe é REUTILIZADA: nada de nova despesa, nova saída de caixa ou nova cobrança.
//   * Pago sem comprovação técnica fica "aguardando vínculo": não cria conta, despesa nem movimento até uma pessoa apontar a origem.
//   * Coincidência de valor e data só alerta: nenhuma sangria ou saída é vinculada automaticamente.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirCentavos, somarLista } from "../dominio/dinheiro.js";
import { CATEGORIA_ENTREGADORES, descricaoDaConta, rotuloDaSemana, semanaDe } from "../dominio/entregadoresProprios.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";
import { operacoesEconomicas } from "./economico.js";

export const SITUACAO_EXTRA = Object.freeze({ PENDENTE: "PENDENTE", PAGO: "PAGO", AGUARDANDO_VINCULO: "PAGO_AGUARDANDO_VINCULO", CANCELADO: "CANCELADO" });
export const MEIOS_DE_PAGAMENTO = Object.freeze(["DINHEIRO", "PIX", "OUTRO"]);
export const PREFIXO_FONTE_EXTRA = "entregador-extra:";
const norm = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
const hash = (t) => createHash("sha256").update(t).digest("hex");
const chaveDoExtra = (e) => `extra:${hash([e.entregadorChave, e.dataServico, e.valorCentavos, norm(e.descricao)].join("|"))}`;
const ativo = (x) => x.situacao !== SITUACAO_EXTRA.CANCELADO;
const opcional = (v, campo) => (v === undefined || v === null || v === "" ? null : exigirUuid(v, campo));

const validar = (e) => {
  semCamposDesconhecidos(e, ["entregador", "entregadorNome", "data", "descricao", "valorCentavos", "situacao", "meioPagamento", "contaId", "movimentacaoId", "obrigacaoExistenteId", "registroFonteId", "documentoId", "justificativa", "confirmarSemDuplicidade"], "extra");
  const situacao = exigirUmDe(e.situacao, [SITUACAO_EXTRA.PAGO, SITUACAO_EXTRA.PENDENTE], "situacao");
  const c = {
    entregadorChave: exigirTexto(e.entregador, "entregador", { max: 200 }), entregadorNome: exigirTexto(e.entregadorNome, "entregadorNome", { max: 200 }), dataServico: exigirData(e.data, "data"),
    descricao: exigirTexto(e.descricao, "descricao", { max: 300 }), valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }), situacao,
    meioPagamento: situacao === SITUACAO_EXTRA.PAGO ? exigirUmDe(e.meioPagamento, MEIOS_DE_PAGAMENTO, "meioPagamento") : null, contaId: opcional(e.contaId, "contaId"), movimentacaoId: opcional(e.movimentacaoId, "movimentacaoId"),
    obrigacaoExistenteId: opcional(e.obrigacaoExistenteId, "obrigacaoExistenteId"), registroFonteId: opcional(e.registroFonteId, "registroFonteId"), documentoId: opcional(e.documentoId, "documentoId"),
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }), confirmarSemDuplicidade: e.confirmarSemDuplicidade === true,
  };
  if (c.movimentacaoId && c.obrigacaoExistenteId) falhar(CODIGO.ENTRADA_INVALIDA, "Aponte a saída do caixa ou a conta existente, não as duas.", { campo: "movimentacaoId" });
  if (situacao === SITUACAO_EXTRA.PENDENTE && (c.movimentacaoId || c.registroFonteId)) falhar(CODIGO.ENTRADA_INVALIDA, "Extra pendente ainda não tem pagamento para vincular.", { campo: "situacao" });
  return c;
};

export function operacoesDeExtras(b) {
  const nucleoNa = (tx, cx) => { const bt = baseNaTransacao(b, tx, cx); return { ...operacoesEconomicas(bt), ...operacoesDeCaixa(bt) }; };
  const extrasDe = (tx, cx) => tx.listar(cx, TIPO.EXTRA_ENTREGADOR);

  async function criarConta(tx, cx, c, chave, vencimento) {
    const r = await nucleoNa(tx, cx).registrarObrigacao(cx, {
      contraparteNova: { tipo: "FORNECEDOR", nome: c.entregadorNome }, valorOriginalCentavos: c.valorCentavos, categoria: CATEGORIA_ENTREGADORES, descricao: `${descricaoDaConta(c.entregadorNome, semanaDe(c.dataServico).inicio)} — extra: ${c.descricao}`.slice(0, 300),
      competencia: c.dataServico.slice(0, 7), dataEmissao: c.dataServico, vencimento, fonte: { sistema: "MANUAL", idExterno: `${PREFIXO_FONTE_EXTRA}${hash(chave).slice(0, 64)}` },
    });
    return r.obrigacoes[0];
  }

  /** Confere a origem apontada e devolve o vínculo. Nunca cria saída de dinheiro. */
  async function resolverVinculo(tx, cx, c, chave, extras, proprioId = null) {
    const usado = (campo, id) => extras.some((x) => x.id !== proprioId && ativo(x) && x[campo] === id);
    if (c.registroFonteId) {
      const r = await b.obterOuFalhar(tx, cx, TIPO.REGISTRO_FONTE, c.registroFonteId, "Movimentação da SAIPOS");
      if (r.tipoRelatorio !== "SAIPOS_MOVIMENTOS_CAIXA" || r.dataReferencia !== c.dataServico || Math.abs(r.valorCentavos) !== c.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "A movimentação da SAIPOS não confere em data e valor com este extra.", { motivo: "SANGRIA_NAO_CONFERE" });
      if (extras.some((x) => x.id !== proprioId && ativo(x) && x.dados.registroFonteId === c.registroFonteId)) falhar(CODIGO.OPERACAO_INVALIDA, "Esta movimentação da SAIPOS já está vinculada a outro extra.", { motivo: "SANGRIA_JA_VINCULADA" });
    }
    if (c.obrigacaoExistenteId) {
      if (usado("obrigacaoId", c.obrigacaoExistenteId)) falhar(CODIGO.OPERACAO_INVALIDA, "Esta conta já está vinculada a outro extra.", { motivo: "CONTA_JA_VINCULADA" });
      const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoExistenteId, "Conta a pagar");
      if (o.situacao === SITUACAO_TITULO.CANCELADA || o.valorBaseCentavos + o.ajustesCentavos !== c.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "O valor da conta existente é diferente do valor do extra.", { motivo: "CONTA_NAO_CONFERE" });
      if (c.situacao === SITUACAO_EXTRA.PAGO && o.saldoCentavos !== 0) falhar(CODIGO.OPERACAO_INVALIDA, "A conta indicada ainda tem saldo em aberto: registre o extra como pendente.", { motivo: "CONTA_EM_ABERTO" });
      return { obrigacaoId: o.id, movimentacaoId: null, situacao: o.saldoCentavos === 0 ? SITUACAO_EXTRA.PAGO : SITUACAO_EXTRA.PENDENTE, origem: "CONTA_EXISTENTE" };
    }
    if (c.movimentacaoId) {
      if (usado("movimentacaoId", c.movimentacaoId)) falhar(CODIGO.OPERACAO_INVALIDA, "Esta saída já está vinculada a outro extra.", { motivo: "SAIDA_JA_VINCULADA" });
      const m = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Saída");
      if (m.sentido !== "SAIDA" || m.situacao !== "VALIDA" || m.transferenciaId) falhar(CODIGO.OPERACAO_INVALIDA, "Aponte uma saída válida que não seja transferência interna.", { motivo: "SAIDA_INVALIDA" });
      if (m.valorCentavos - m.alocadoCentavos < c.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "Esta saída já paga outra conta: aponte a conta existente em vez de lançar de novo.", { motivo: "SAIDA_JA_UTILIZADA" });
      const conta = await criarConta(tx, cx, c, chave, c.dataServico);
      await nucleoNa(tx, cx).registrarLiquidacao(cx, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: conta.id, valorCentavos: c.valorCentavos }] });
      return { obrigacaoId: conta.id, movimentacaoId: m.id, situacao: SITUACAO_EXTRA.PAGO, origem: "SAIDA_EXISTENTE" };
    }
    return null;
  }

  async function exigirSemDuplicidade(tx, cx, c, extras) {
    if (c.confirmarSemDuplicidade || c.obrigacaoExistenteId || c.movimentacaoId) return;
    const mesmoExtra = extras.find((x) => ativo(x) && x.entregadorChave === c.entregadorChave && x.dataServico === c.dataServico && x.valorCentavos === c.valorCentavos);
    if (mesmoExtra) falhar(CODIGO.OPERACAO_INVALIDA, "Já existe um extra deste entregador com a mesma data e o mesmo valor.", { motivo: "POSSIVEL_DUPLICIDADE", extraId: mesmoExtra.id });
    const vinculadas = new Set(extras.filter(ativo).map((x) => x.obrigacaoId));
    const conta = (await tx.listar(cx, TIPO.OBRIGACAO)).find((o) => o.situacao !== SITUACAO_TITULO.CANCELADA && !vinculadas.has(o.id) && o.valorBaseCentavos + o.ajustesCentavos === c.valorCentavos && [o.dataEmissao, o.vencimento].includes(c.dataServico));
    if (conta) falhar(CODIGO.OPERACAO_INVALIDA, "Existe uma conta com o mesmo valor nesta data. Vincule-a ou confirme que é outro serviço.", { motivo: "POSSIVEL_DUPLICIDADE", obrigacaoId: conta.id });
  }

  return {
    registrarExtraDoEntregador(ctx, entrada = {}) {
      const c = validar(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        b.exigirNaoFutura(c.dataServico, "data");
        await tx.travar(cx, "entregadores-extras", "EXCLUSIVA");
        const chave = chaveDoExtra(c);
        const repetido = await tx.buscarPorChave(cx, TIPO.EXTRA_ENTREGADOR, chave);
        if (repetido) return { extra: repetido, repetido: true };
        const extras = await extrasDe(tx, cx);
        await exigirSemDuplicidade(tx, cx, c, extras);
        let vinculo = await resolverVinculo(tx, cx, c, chave, extras);
        if (!vinculo && c.situacao === SITUACAO_EXTRA.PENDENTE) {
          const venc = semanaDe(c.dataServico).vencimento;
          const conta = await criarConta(tx, cx, c, chave, venc > b.hoje() ? venc : b.hoje());
          vinculo = { obrigacaoId: conta.id, movimentacaoId: null, situacao: SITUACAO_EXTRA.PENDENTE, origem: "CONTA_NOVA" };
        }
        vinculo ??= { obrigacaoId: null, movimentacaoId: null, situacao: SITUACAO_EXTRA.AGUARDANDO_VINCULO, origem: "INFORMADO" };
        const extra = await b.criar(tx, cx, TIPO.EXTRA_ENTREGADOR, {
          entregadorChave: c.entregadorChave, entregadorNome: c.entregadorNome, dataServico: c.dataServico, semanaInicio: semanaDe(c.dataServico).inicio, descricao: c.descricao, valorCentavos: c.valorCentavos,
          situacao: vinculo.situacao, obrigacaoId: vinculo.obrigacaoId, movimentacaoId: vinculo.movimentacaoId, chaveIdempotencia: chave, impressao: null,
          dados: { origem: vinculo.origem, meioPagamento: c.meioPagamento, contaId: c.contaId, registroFonteId: c.registroFonteId, documentoId: c.documentoId, justificativa: c.justificativa, responsavel: cx.usuarioId },
        }, c.justificativa);
        return { extra, repetido: false };
      });
    },

    /** Aponta depois a origem de um extra pago: conta existente ou saída já registrada. */
    vincularExtraAoCaixa(ctx, e = {}) {
      semCamposDesconhecidos(e, ["extraId", "movimentacaoId", "obrigacaoExistenteId", "registroFonteId", "justificativa"], "vinculo");
      const extraId = exigirUuid(e.extraId, "extraId");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      const origem = { movimentacaoId: opcional(e.movimentacaoId, "movimentacaoId"), obrigacaoExistenteId: opcional(e.obrigacaoExistenteId, "obrigacaoExistenteId"), registroFonteId: opcional(e.registroFonteId, "registroFonteId") };
      if (Boolean(origem.movimentacaoId) === Boolean(origem.obrigacaoExistenteId)) falhar(CODIGO.ENTRADA_INVALIDA, "Aponte a saída do caixa ou a conta existente.", { campo: "movimentacaoId" });
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await tx.travar(cx, "entregadores-extras", "EXCLUSIVA");
        const x = await b.obterOuFalhar(tx, cx, TIPO.EXTRA_ENTREGADOR, extraId, "Serviço extra");
        if (x.situacao !== SITUACAO_EXTRA.AGUARDANDO_VINCULO) falhar(CODIGO.OPERACAO_INVALIDA, "Este extra não está aguardando vínculo.");
        const v = await resolverVinculo(tx, cx, { ...x, ...origem, situacao: SITUACAO_EXTRA.PAGO }, x.chaveIdempotencia, await extrasDe(tx, cx), x.id);
        return b.alterar(tx, cx, TIPO.EXTRA_ENTREGADOR, x, { situacao: SITUACAO_EXTRA.PAGO, obrigacaoId: v.obrigacaoId, movimentacaoId: v.movimentacaoId, dados: { ...x.dados, origem: v.origem, registroFonteId: origem.registroFonteId } }, EVENTO_HISTORICO.CONCILIACAO, justificativa);
      });
    },

    cancelarExtraDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["extraId", "justificativa"], "cancelamento");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const x = await b.obterOuFalhar(tx, cx, TIPO.EXTRA_ENTREGADOR, exigirUuid(e.extraId, "extraId"), "Serviço extra");
        if (x.situacao !== SITUACAO_EXTRA.AGUARDANDO_VINCULO) falhar(CODIGO.OPERACAO_INVALIDA, "Extra com conta vinculada é corrigido pelo fluxo da própria conta.", { motivo: "EXTRA_COM_CONTA" });
        return b.alterar(tx, cx, TIPO.EXTRA_ENTREGADOR, x, { situacao: SITUACAO_EXTRA.CANCELADO }, EVENTO_HISTORICO.CANCELAMENTO, justificativa);
      });
    },
  };
}

/** Visão de um extra com o saldo da conta vinculada. */
export const visaoDoExtra = (x, contas) => {
  const o = x.obrigacaoId ? contas.get(x.obrigacaoId) : null;
  const pago = x.situacao === SITUACAO_EXTRA.AGUARDANDO_VINCULO ? x.valorCentavos : o?.liquidadoCentavos ?? 0;
  return { id: x.id, entregador: { chave: x.entregadorChave, nome: x.entregadorNome }, data: x.dataServico, semanaInicio: x.semanaInicio, rotuloSemana: rotuloDaSemana(x.semanaInicio), descricao: x.descricao, valorCentavos: x.valorCentavos, situacao: x.situacao,
    pagoCentavos: pago, saldoCentavos: Math.max(0, x.valorCentavos - pago), obrigacaoId: x.obrigacaoId, movimentacaoId: x.movimentacaoId, meioPagamento: x.dados.meioPagamento ?? null, origem: x.dados.origem, registroFonteId: x.dados.registroFonteId ?? null, justificativa: x.dados.justificativa };
};

/**
 * Resumo da semana por entregador: taxas e extras nunca se misturam. `taxas` = [{chave, nome, valorCentavos, pagoCentavos}].
 * Total devido = taxas + extras; saldo = total devido − pago.
 */
export function resumoDaSemana(taxas, extras, pendenciasDocumentais = 0) {
  const por = new Map();
  const de = (chave, nome) => { if (!por.has(chave)) por.set(chave, { chave, nome, taxasCentavos: 0, taxasPagasCentavos: 0, extrasCentavos: 0, extrasPagosCentavos: 0, aguardandoVinculoCentavos: 0 }); return por.get(chave); };
  for (const t of taxas) { const p = de(t.chave, t.nome); p.taxasCentavos += t.valorCentavos; p.taxasPagasCentavos += t.pagoCentavos; }
  for (const x of extras) {
    const p = de(x.entregador.chave, x.entregador.nome);
    p.extrasCentavos += x.valorCentavos; p.extrasPagosCentavos += x.pagoCentavos;
    if (x.situacao === SITUACAO_EXTRA.AGUARDANDO_VINCULO) p.aguardandoVinculoCentavos += x.valorCentavos;
  }
  const porEntregador = [...por.values()].map((p) => {
    const totalDevidoCentavos = p.taxasCentavos + p.extrasCentavos;
    const totalPagoCentavos = p.taxasPagasCentavos + p.extrasPagosCentavos;
    return { ...p, totalDevidoCentavos, totalPagoCentavos, saldoAbertoCentavos: Math.max(0, p.taxasCentavos - p.taxasPagasCentavos) + Math.max(0, p.extrasCentavos - p.extrasPagosCentavos) };
  }).sort((a, x) => a.nome.localeCompare(x.nome, "pt-BR"));
  const soma = (k) => somarLista(porEntregador, (p) => p[k]);
  return { taxasFoodyCentavos: soma("taxasCentavos"), extrasCentavos: soma("extrasCentavos"), totalDevidoCentavos: soma("totalDevidoCentavos"), totalPagoCentavos: soma("totalPagoCentavos"), saldoAbertoCentavos: soma("saldoAbertoCentavos"), aguardandoVinculoCentavos: soma("aguardandoVinculoCentavos"), pendenciasDocumentais, porEntregador };
}
