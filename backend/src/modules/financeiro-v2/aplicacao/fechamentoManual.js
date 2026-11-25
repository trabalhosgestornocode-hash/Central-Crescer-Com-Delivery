// Fase 04 (doc 42) — fechamento manual de caixa: registro (com correção auditada) e consulta com a comparação diária.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_CONCILIACAO, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { calcularFechamento, compararDia, validarFechamentoManual } from "../dominio/fechamentoManual.js";
import { competenciaDe, exigirData } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { operadoraNaData } from "../dominio/operadoras.js";
import { operacoesDeVendas } from "./vendas.js";
import { validarFaturamentoManual } from "../dominio/fechamentoManual.js";
import { dinheiroDoDia, fundoFixoDaUnidade, movimentosDoPeriodo, resumirMovimentosDoDia } from "./movimentosDeCaixa.js";

/** Venda de faturamento manual provisório: origem MANUAL com este prefixo no identificador. */
export const PREFIXO_PROVISORIO = "faturamento-manual:";
export const ehProvisoria = (v) => v?.fonte?.sistema === "MANUAL" && String(v.fonte.idExterno ?? "").startsWith(PREFIXO_PROVISORIO);

/**
 * Dias do período com fechamento manual e/ou vendas (Presencial e Anota Aí), cada um com a comparação fechamento × vendas.
 * Base da área "Fechamento manual" e do calendário de faturamento (uma só fonte).
 */
export async function diasDeFechamento(tx, cx, inicio, fim) {
  const fechamentos = (await tx.listar(cx, TIPO.FECHAMENTO_CAIXA)).filter((f) => f.data >= inicio && f.data <= fim);
  const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => v.dataVenda >= inicio && v.dataVenda <= fim && (v.canal === "BALCAO" || v.canal === "ANOTA_AI"));
  const ids = new Set(vendas.map((v) => v.id));
  const pagamentos = (await tx.listar(cx, TIPO.PAGAMENTO_VENDA)).filter((p) => ids.has(p.vendaId) && p.situacao === "VALIDO");
  const porVenda = new Map();
  for (const p of pagamentos) { if (!porVenda.has(p.vendaId)) porVenda.set(p.vendaId, []); porVenda.get(p.vendaId).push(p); }
  // Sangrias/reforços/transferências importados da SAIPOS: só LEITURA para conferir o dinheiro do dia (nunca viram faturamento nem somam sozinhos ao fechamento).
  const movimentos = await movimentosDoPeriodo(tx, cx, inicio, fim);
  const fundoFixoCentavos = await fundoFixoDaUnidade(tx, cx);
  const datas = [...new Set([...fechamentos.map((f) => f.data), ...vendas.map((v) => v.dataVenda), ...movimentos.map((r) => r.dataReferencia)])].sort();
  return datas.map((data) => {
    const doDia = fechamentos.filter((f) => f.data === data).sort((a, x) => a.caixa.localeCompare(x.caixa));
    const vendasDoDia = vendas.filter((v) => v.dataVenda === data).map((v) => ({ ...v, pagamentos: porVenda.get(v.id) ?? [] }));
    const provisorias = vendasDoDia.filter(ehProvisoria).map((v) => ({ id: v.id, canal: v.canal, brutoCentavos: v.brutoCentavos, descricao: v.descricao, caixa: String(v.fonte.idExterno).split(":").at(-1) }));
    const movDoDia = movimentos.filter((r) => r.dataReferencia === data);
    const vendasEmDinheiroCentavos = vendasDoDia.length ? vendasDoDia.reduce((s, v) => s + v.pagamentos.filter((p) => p.forma === "DINHEIRO").reduce((t, p) => t + p.valorCentavos - (p.estornadoCentavos ?? 0), 0), 0) : null;
    const movimentosDeCaixa = movDoDia.length ? resumirMovimentosDoDia({ data, movimentos: movDoDia, fechamentos: doDia, vendasEmDinheiroCentavos }) : null;
    return {
      data, fechamentos: doDia, provisorias, ...compararDia({ fechamentos: doDia, vendas: vendasDoDia }),
      movimentosDeCaixa, dinheiroDoDia: movDoDia.length || doDia.length ? dinheiroDoDia({ resumo: movimentosDeCaixa, fechamentos: doDia, vendasEmDinheiroCentavos, fundoFixoCentavos }) : null,
    };
  });
}

/** Formas informadas → pagamentos da venda (mesmo de-para da SAIPOS). O que não tem destino claro fica pendente (nunca presumido). */
function pagamentosDoFaturamentoManual(f, { config, caixaId }) {
  const pagamentos = [];
  const pendencias = [];
  const cartaoCadastrado = (Array.isArray(config?.operadoras) ? config.operadoras : []).some((o) => ["STONE", "PAGBANK", "MAQUINA_TERCEIROS"].includes(o.processador));
  for (const x of f.formas) {
    const base = { valorCentavos: x.valorCentavos, descricaoOriginal: `Faturamento manual: ${x.grupo}${x.bandeira ? ` ${x.bandeira}` : ""}${x.operadora ? ` ${x.operadora}` : ""}` };
    if (x.grupo === "DINHEIRO") { if (caixaId) pagamentos.push({ ...base, forma: "DINHEIRO", contaId: caixaId }); else pendencias.push({ ...x, motivo: "Sem caixa físico único cadastrado." }); continue; }
    if (x.grupo === "CREDITO" || x.grupo === "DEBITO") {
      const op = operadoraNaData({ config, data: f.data, forma: x.grupo, processadores: ["STONE", "PAGBANK", "MAQUINA_TERCEIROS"] });
      if (op.operadora) pagamentos.push({ ...base, forma: x.grupo, bandeira: x.bandeira, processador: op.processador, operadora: op.operadora });
      else if (!cartaoCadastrado && op.situacao === "SEM_OPERADORA") pagamentos.push({ ...base, forma: x.grupo, bandeira: x.bandeira, processador: "STONE" });
      else pendencias.push({ ...x, motivo: op.candidatas.length ? `Operadoras ativas ao mesmo tempo: ${op.candidatas.join(", ")}.` : "Nenhuma operadora de cartão ativa na data." });
      continue;
    }
    if (x.grupo === "PIX") { if (["MAQUININHA_IFOOD", "STONE", "PAGBANK"].includes(x.operadora)) pagamentos.push({ ...base, forma: "PIX", processador: x.operadora, operadora: x.operadora }); else pendencias.push({ ...x, motivo: "Pix sem operadora (direto na conta): informe a conta na conciliação." }); continue; }
    if (x.grupo === "VOUCHER") { pagamentos.push({ ...base, forma: "VALE", bandeira: x.bandeira, processador: "OPERADORA_BENEFICIOS" }); continue; }
    if (x.grupo === "ANOTA_AI") { pagamentos.push({ ...base, forma: "OUTRA", processador: "ANOTA_AI" }); continue; }
    pendencias.push({ ...x, motivo: "Forma sem destino definido." });
  }
  return { pagamentos, pendencias };
}

const chaveDoFechamento = (data, caixa) => `fechamento-caixa:${data}:${caixa.trim().toUpperCase()}`;

export function operacoesDeFechamentoManual(b) {
  const vendas = operacoesDeVendas(b); // mesmas operações de venda (permissão, transação, idempotência, histórico)
  return {
    /**
     * Registra o fechamento de UM caixa num dia. Repetir igual não faz nada; com valores diferentes é CORREÇÃO (exige
     * justificativa; a versão anterior fica no histórico). Nenhum efeito financeiro.
     */
    registrarFechamentoManual(ctx, entrada) {
      const f = validarFechamentoManual(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        b.exigirNaoFutura(f.data, "data");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(f.data));
        const chave = chaveDoFechamento(f.data, f.caixa);
        const { justificativa, data, caixa, observacao, ...resto } = f;
        const dados = { ...resto, ...calcularFechamento(f), origem: "MANUAL", registradoPor: cx.usuarioId };
        const impressao = JSON.stringify({ data, caixa, observacao, ...resto });
        const existente = await tx.buscarPorChave(cx, TIPO.FECHAMENTO_CAIXA, chave);
        if (existente) {
          if (existente.impressao === impressao) return { fechamento: existente, repetido: true };
          if (!justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Este caixa já tem fechamento neste dia: para corrigir, informe a justificativa (a versão anterior fica no histórico).", { campo: "justificativa" });
          const corrigido = await b.alterar(tx, cx, TIPO.FECHAMENTO_CAIXA, existente, { dados: { ...dados, registradoPor: existente.dados.registradoPor, corrigidoPor: cx.usuarioId }, observacao, impressao, situacao: "REGISTRADO" }, EVENTO_HISTORICO.CORRECAO, justificativa);
          return { fechamento: corrigido, repetido: false, corrigido: true };
        }
        const novo = await b.criar(tx, cx, TIPO.FECHAMENTO_CAIXA, { data, caixa, situacao: "REGISTRADO", dados, observacao, chaveIdempotencia: chave, impressao });
        return { fechamento: novo, repetido: false };
      });
    },

    /**
     * Fase 08 (doc 44) — FATURAMENTO MANUAL PROVISÓRIO: ação EXPLÍCITA (o fechamento sozinho nunca cria receita). Uma venda
     * por dia × caixa × canal (Presencial ou Anota Aí), origem MANUAL marcada como provisória, com as formas/bandeiras e a
     * taxa estimada pelo motor existente. Recusada se o dia já tem vendas importadas do canal; depois de registrada, a
     * importação SAIPOS do mesmo dia/canal é recusada até a substituição auditada (substituirFaturamentoProvisorio).
     */
    async registrarFaturamentoManual(ctx, entrada) {
      const f = validarFaturamentoManual(entrada);
      b.exigirNaoFutura(f.data, "data");
      const contexto = await b.consultar(ctx, async (cx, tx) => {
        const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, canal: f.canal } })).filter((v) => v.dataVenda === f.data);
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const caixas = (await tx.listar(cx, TIPO.CONTA)).filter((c) => c.ativa && c.tipo === "CAIXA_FISICO");
        return { importadas: vendas.filter((v) => v.fonte?.sistema === "SAIPOS").length, config, caixaId: caixas.length === 1 ? caixas[0].id : null };
      });
      if (contexto.importadas) falhar(CODIGO.OPERACAO_INVALIDA, `Já há ${contexto.importadas} venda(s) importada(s) da SAIPOS neste dia e canal: o faturamento manual duplicaria a receita.`, { motivo: "IMPORTACAO_EXISTENTE" });
      const { pagamentos, pendencias } = pagamentosDoFaturamentoManual(f, contexto);
      const bruto = f.formas.reduce((s, x) => s + x.valorCentavos, 0);
      const r = await vendas.registrarVenda(ctx, {
        canal: f.canal, dataVenda: f.data, brutoCentavos: bruto, pagamentos, ...(pendencias.length ? { pagamentoParcial: true } : {}),
        fonte: { sistema: "MANUAL", idExterno: `${PREFIXO_PROVISORIO}${f.data}:${f.canal}:${f.caixa.trim().toUpperCase()}` },
        descricao: `Faturamento manual PROVISÓRIO — caixa ${f.caixa} (${f.justificativa})`.slice(0, 200),
      });
      return { ...r, provisorio: true, pendencias };
    },

    /** Substitui (cancela, com justificativa e histórico) o faturamento provisório do dia × canal para a importação oficial entrar. */
    async substituirFaturamentoProvisorio(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["data", "canal", "justificativa"], "substituicao");
      const data = exigirData(entrada.data, "data");
      const canal = String(entrada.canal ?? "").toUpperCase();
      if (!["BALCAO", "ANOTA_AI"].includes(canal)) falhar(CODIGO.ENTRADA_INVALIDA, "canal: BALCAO ou ANOTA_AI.", { campo: "canal" });
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 400 });
      const provisorias = await b.consultar(ctx, async (cx, tx) => {
        const lista = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, canal } })).filter((v) => v.dataVenda === data && ehProvisoria(v));
        const pagamentos = await tx.listar(cx, TIPO.PAGAMENTO_VENDA);
        const doDia = lista.map((v) => ({ ...v, entradasEmConta: pagamentos.filter((p) => p.vendaId === v.id && p.movimentacaoId && p.situacao === "VALIDO") }));
        // Tudo o que impediria a substituição é conferido ANTES de alterar qualquer coisa (cada estorno é uma transação própria:
        // recusar no meio deixaria o dinheiro estornado e a venda ainda ativa).
        let repasseRecebido = 0;
        let entradaConciliada = 0;
        for (const v of doDia) {
          for (const p of pagamentos.filter((x) => x.vendaId === v.id && x.situacao !== "CANCELADO")) {
            if (p.recebivelId && ((await tx.obter(cx, TIPO.RECEBIVEL, p.recebivelId))?.liquidadoCentavos ?? 0) > 0) repasseRecebido += 1;
          }
          for (const p of v.entradasEmConta) {
            if ((await tx.obter(cx, TIPO.MOVIMENTACAO, p.movimentacaoId))?.situacaoConciliacao !== SITUACAO_CONCILIACAO.NAO_CONCILIADA) entradaConciliada += 1;
          }
        }
        return { doDia, repasseRecebido, entradaConciliada };
      }).then(({ doDia, repasseRecebido, entradaConciliada }) => {
        if (repasseRecebido) falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Parte do faturamento provisório já foi recebida (repasse conciliado). Nada foi alterado: estorne a liquidação antes de substituir.", { motivo: "REPASSE_JA_RECEBIDO", repasses: repasseRecebido });
        if (entradaConciliada) falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Uma entrada do faturamento provisório já está conciliada com o extrato. Nada foi alterado: revise a conciliação antes de substituir.", { motivo: "ENTRADA_CONCILIADA", entradas: entradaConciliada });
        return doDia;
      });
      if (!provisorias.length) falhar(CODIGO.NAO_ENCONTRADO, "Não há faturamento manual provisório ativo neste dia e canal.");
      const canceladas = [];
      for (const v of provisorias) {
        // Entrada provisória no caixa/conta: CORREÇÃO (a movimentação fica estornada, com histórico; nenhuma saída nova).
        for (const p of v.entradasEmConta) await vendas.estornarPagamentoDeVenda(ctx, { pagamentoId: p.id, motivo: "CORRECAO_DE_PAGAMENTO", justificativa: `Faturamento provisório substituído: ${justificativa}` });
        canceladas.push((await vendas.cancelarVenda(ctx, { vendaId: v.id, justificativa: `Substituído pela importação oficial: ${justificativa}` })).venda?.id ?? v.id);
      }
      return { data, canal, canceladas: canceladas.length, valorCentavos: provisorias.reduce((s, v) => s + v.brutoCentavos, 0) };
    },

    /** Fechamentos do período, agrupados por dia, com a comparação contra as vendas do dia (Presencial e Anota Aí). */
    consultarFechamentoManual(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
      const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
      const fim = exigirData(entrada.periodoFim, "periodoFim");
      if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
      return b.consultar(ctx, async (cx, tx) => ({ periodoInicio: inicio, periodoFim: fim, dias: await diasDeFechamento(tx, cx, inicio, fim) }));
    },
  };
}
