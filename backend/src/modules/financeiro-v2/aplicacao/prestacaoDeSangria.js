// F4 (MOVA CORE §12) — PRESTAÇÃO DE CONTAS DA SANGRIA (retirada de dinheiro do caixa para uma compra).
//
// Uma sangria NÃO é despesa definitiva antes de o destino ser confirmado. Ela continua sendo o que o núcleo já grava: a operação
// SANGRIA de uma sessão de caixa, que cria uma SAÍDA do caixa físico sem classificação (`registrarOperacaoDeCaixa`). A prestação de
// contas diz para onde o dinheiro foi, SEM criar uma segunda saída de dinheiro:
//   - DESPESA paga com o dinheiro da retirada: a conta (lançamento na competência) é registrada e liquidada contra a PRÓPRIA saída da
//     sangria (`registrarObrigacao` + `registrarLiquidacao`, na MESMA transação). Várias despesas podem sair de uma retirada.
//   - TROCO devolvido: ENTRADA no caixa físico (natureza OUTRA, como a entrada de caixa do núcleo; DEVOLUCAO é só estorno de
//     venda), nunca receita, numa sessão ABERTA do MESMO caixa, ligada à sangria (trocoDaSangria).
//   - pendente = valor da retirada − despesas vinculadas − troco devolvido. Nunca negativo (trava + recálculo dentro da transação).
// Estado: AGUARDANDO_DESTINO (nada prestado), PARCIAL, PRESTADA (pendente zero) e ATRASADA (pendente > 0 depois do prazo). O prazo
// é configurável por unidade (`prazoPrestacaoSangriaHoras` na configuração da unidade; padrão 48 h).
// Correção/estorno: `estornarLiquidacao` (núcleo) devolve o valor à saída e a pendência volta sozinha; a conta pode ser cancelada pelo
// caminho normal. Comprovante posterior: a despesa sem documento fica marcada `comprovantePendente` até um documento ser vinculado.
// Idempotência: cada item tem uma `chave` (formulário/proposta); repetir devolve o que já existe; outra entrada com a mesma chave é
// recusada. Permissão: `registrar` (a mesma de operar o caixa), conferida no contexto e na concessão (b.executar).
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, NATUREZA_MOVIMENTACAO, OPERACAO_CAIXA, SENTIDO, SITUACAO_MOVIMENTACAO, SITUACAO_SESSAO_CAIXA, TIPO, TIPO_CONTA } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";
import { operacoesEconomicas } from "./economico.js";

export const PRAZO_PADRAO_PRESTACAO_HORAS = 48;
export const ESTADO_PRESTACAO = Object.freeze({ AGUARDANDO_DESTINO: "AGUARDANDO_DESTINO", PARCIAL: "PARCIAL", PRESTADA: "PRESTADA", ATRASADA: "ATRASADA", ESTORNADA: "ESTORNADA" });
const CHAVE = /^[A-Za-z0-9:_.-]{8,120}$/;
const exigirChave = (v) => { if (typeof v !== "string" || !CHAVE.test(v)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a chave do pedido (8 a 120 caracteres: letras, números, : _ . -).", { campo: "chave" }); return v; };
const exigirValor = (v, campo) => { if (!Number.isInteger(v) || v <= 0) falhar(CODIGO.VALOR_INVALIDO, "Valor em centavos, inteiro e positivo.", { campo }); return v; };
const vazia = () => ({ despesas: [], devolucoes: [], devolvidoCentavos: 0 });

/** Prazo da unidade (horas). Configuração ausente ⇒ padrão; fora de 1..720 ⇒ padrão (nunca prazo absurdo). */
export async function prazoDaUnidade(tx, cx) {
  const cfg = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
  const h = cfg?.prazoPrestacaoSangriaHoras;
  return Number.isInteger(h) && h >= 1 && h <= 720 ? h : PRAZO_PADRAO_PRESTACAO_HORAS;
}

/** A retirada (operação SANGRIA da sessão) e a sua saída do caixa, conferidas no escopo. Sangria para outra conta não presta contas. */
async function sangriaDe(b, tx, cx, sessaoId, movimentacaoId) {
  const sessao = await b.obterOuFalhar(tx, cx, TIPO.SESSAO_CAIXA, sessaoId, "Sessão de caixa");
  const operacao = (sessao.operacoes ?? []).find((o) => o.operacao === OPERACAO_CAIXA.SANGRIA && o.movimentacaoId === movimentacaoId);
  if (!operacao) falhar(CODIGO.OPERACAO_INVALIDA, "Esta saída não é uma sangria desta sessão de caixa (transferência para outra conta não presta contas por aqui).", { motivo: "NAO_E_SANGRIA" });
  const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, movimentacaoId, "Saída da sangria");
  const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, mov.contaId, "Caixa");
  if (mov.sentido !== SENTIDO.SAIDA || conta.tipo !== TIPO_CONTA.CAIXA_FISICO) falhar(CODIGO.OPERACAO_INVALIDA, "A sangria precisa ser uma saída do caixa físico.");
  return { sessao, operacao, mov, conta };
}

/** Retrato da prestação de UMA retirada, calculado pelo código (nunca pela IA). */
export function retratoDaPrestacao({ operacao, mov }, { agora, prazoHoras }) {
  const p = mov.prestacaoSangria ?? vazia();
  const estornada = mov.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA;
  const vinculado = mov.alocadoCentavos ?? 0;
  const pendente = Math.max(0, mov.valorCentavos - vinculado - (p.devolvidoCentavos ?? 0));
  const desde = operacao.registradoEm ?? `${mov.dataEfetiva}T00:00:00.000Z`;
  const prazoAte = new Date(new Date(desde).getTime() + prazoHoras * 3600_000).toISOString();
  const estado = estornada ? ESTADO_PRESTACAO.ESTORNADA
    : pendente === 0 ? ESTADO_PRESTACAO.PRESTADA
    : new Date(agora).getTime() > new Date(prazoAte).getTime() ? ESTADO_PRESTACAO.ATRASADA
    : vinculado + (p.devolvidoCentavos ?? 0) > 0 ? ESTADO_PRESTACAO.PARCIAL : ESTADO_PRESTACAO.AGUARDANDO_DESTINO;
  return {
    movimentacaoId: mov.id, data: mov.dataEfetiva, descricao: operacao.descricao, valorCentavos: mov.valorCentavos,
    despesasCentavos: vinculado, trocoDevolvidoCentavos: p.devolvidoCentavos ?? 0, pendenteCentavos: pendente, estado, prazoAte, prazoHoras,
    despesas: p.despesas ?? [], devolucoes: p.devolucoes ?? [], comprovantesPendentes: (p.despesas ?? []).filter((d) => d.comprovantePendente).length,
  };
}

export function operacoesDePrestacaoDeSangria(b) {
  const naTx = (tx, cx) => { const bt = baseNaTransacao(b, tx, cx); return { ...operacoesEconomicas(bt), ...operacoesDeCaixa(bt) }; };
  const repetida = (lista, chave, impressao) => {
    const ja = (lista ?? []).find((x) => x.chave === chave);
    if (ja && ja.impressao !== impressao) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Este pedido já foi registrado com outro conteúdo.", { campo: "chave" });
    return ja ?? null;
  };

  return {
    /** Leitura: cada sangria do período com o que foi prestado, o troco, o pendente, o prazo e o estado. */
    consultarPrestacaoDeSangrias(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["inicio", "fim", "somentePendentes"], "consulta");
      const inicio = entrada.inicio ? exigirData(entrada.inicio, "inicio") : null;
      const fim = entrada.fim ? exigirData(entrada.fim, "fim") : null;
      return b.consultar(ctx, async (cx, tx) => {
        const prazoHoras = await prazoDaUnidade(tx, cx);
        const itens = [];
        const sessoes = await tx.listar(cx, TIPO.SESSAO_CAIXA);
        // (leitura) caixa aberto AGORA de cada conta: o troco de uma retirada cujo caixa já fechou volta no caixa atual (sem reabrir nada)
        const abertaDaConta = new Map(sessoes.filter((x) => x.situacao === SITUACAO_SESSAO_CAIXA.ABERTA).sort((x, y) => String(x.dataAbertura).localeCompare(String(y.dataAbertura))).map((x) => [x.contaId, x]));
        for (const sessao of sessoes) {
          for (const operacao of sessao.operacoes ?? []) {
            if (operacao.operacao !== OPERACAO_CAIXA.SANGRIA || !operacao.movimentacaoId) continue; // sangria para o banco = transferência
            if ((inicio && operacao.data < inicio) || (fim && operacao.data > fim)) continue;
            const mov = await tx.obter(cx, TIPO.MOVIMENTACAO, operacao.movimentacaoId);
            if (!mov) continue;
            const r = { sessaoId: sessao.id, caixaDaRetirada: sessao.situacao, caixaAbertoAgora: abertaDaConta.get(sessao.contaId) ? { sessaoId: abertaDaConta.get(sessao.contaId).id, dataAbertura: abertaDaConta.get(sessao.contaId).dataAbertura } : null, ...retratoDaPrestacao({ operacao, mov }, { agora: b.agora(), prazoHoras }) };
            if (!entrada.somentePendentes || r.pendenteCentavos > 0) itens.push(r);
          }
        }
        itens.sort((a, x) => a.data.localeCompare(x.data));
        return { prazoHoras, itens, totais: { retiradoCentavos: itens.reduce((t, i) => t + i.valorCentavos, 0), pendenteCentavos: itens.reduce((t, i) => t + i.pendenteCentavos, 0), atrasadas: itens.filter((i) => i.estado === ESTADO_PRESTACAO.ATRASADA).length } };
      });
    },

    /**
     * DESPESA paga com o dinheiro da sangria: conta + liquidação contra a PRÓPRIA saída da sangria, numa só transação.
     * @param {{sessaoId, movimentacaoId, chave, obrigacao:object, documentoId?:string|null, justificativa:string, confirmar:boolean}} entrada
     */
    registrarDespesaDaSangria(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["sessaoId", "movimentacaoId", "chave", "obrigacao", "documentoId", "justificativa", "confirmar"], "despesaDaSangria");
      const chave = exigirChave(entrada.chave);
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 300 });
      if (justificativa.trim().length < 10) falhar(CODIGO.ENTRADA_INVALIDA, "Diga em poucas palavras o que foi comprado com o dinheiro da retirada.", { campo: "justificativa" });
      if (!entrada.obrigacao || typeof entrada.obrigacao !== "object") falhar(CODIGO.ENTRADA_INVALIDA, "Informe a despesa.", { campo: "obrigacao" });
      if ((entrada.obrigacao.parcelas ?? 1) !== 1 || entrada.obrigacao.recorrencia) falhar(CODIGO.ENTRADA_INVALIDA, "Despesa paga com dinheiro da retirada entra em uma parcela, sem repetição.", { campo: "parcelas" });
      const valor = exigirValor(entrada.obrigacao.valorOriginalCentavos, "obrigacao.valorOriginalCentavos");
      if (entrada.confirmar !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a despesa, o valor e a retirada e confirme.");
      const impressao = JSON.stringify([entrada.movimentacaoId, valor, entrada.obrigacao.descricao ?? null, entrada.obrigacao.categoria ?? null, entrada.obrigacao.competencia ?? null, entrada.documentoId ?? null]);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await tx.travar(cx, `movimentacao:${entrada.movimentacaoId}`, "EXCLUSIVA"); // duas prestações nunca consomem o mesmo pendente
        const s = await sangriaDe(b, tx, cx, entrada.sessaoId, entrada.movimentacaoId);
        const p = s.mov.prestacaoSangria ?? vazia();
        const ja = repetida(p.despesas, chave, impressao);
        if (ja) return { repetido: true, despesa: ja, prestacao: retratoDaPrestacao(s, { agora: b.agora(), prazoHoras: await prazoDaUnidade(tx, cx) }) };
        if (s.mov.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA) falhar(CODIGO.OPERACAO_INVALIDA, "A sangria foi estornada: não há dinheiro a prestar contas.");
        const pendente = s.mov.valorCentavos - (s.mov.alocadoCentavos ?? 0) - (p.devolvidoCentavos ?? 0);
        if (valor > pendente) falhar(CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO, "A despesa passa do que ainda falta prestar contas desta retirada.", { pendenteCentavos: pendente, valorCentavos: valor });
        const documento = entrada.documentoId ? await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, entrada.documentoId, "Comprovante") : null;
        const n = naTx(tx, cx);
        const registrada = await n.registrarObrigacao(cx, {
          dataEmissao: s.mov.dataEfetiva, vencimento: s.mov.dataEfetiva, competencia: s.mov.dataEfetiva.slice(0, 7), ...entrada.obrigacao,
          fonte: { sistema: "MANUAL", idExterno: `prestacao-sangria:${s.mov.id}:${chave}` },
        });
        const [conta] = registrada.obrigacoes;
        const liq = await n.registrarLiquidacao(cx, { movimentacaoId: s.mov.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: conta.id, valorCentavos: valor }] });
        if (documento) {
          for (const [tipo, id] of [[TIPO.MOVIMENTACAO, s.mov.id], [TIPO.OBRIGACAO, conta.id]]) {
            const chaveV = `${documento.id}|${tipo}|${id}`;
            if (!(await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chaveV))) await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { documentoId: documento.id, registroTipo: tipo, registroId: id, chaveIdempotencia: chaveV, finalidade: "Comprova a despesa paga com dinheiro da sangria" }, justificativa);
          }
        }
        const despesa = { chave, impressao, obrigacaoId: conta.id, liquidacaoId: liq.liquidacoes[0].id, valorCentavos: valor, descricao: conta.descricao ?? entrada.obrigacao.descricao ?? null, documentoId: documento?.id ?? null, comprovantePendente: !documento, registradoEm: b.agora(), registradoPor: cx.usuarioId };
        const mov = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, liq.movimentacao, { prestacaoSangria: { ...p, despesas: [...(p.despesas ?? []), despesa] } }, EVENTO_HISTORICO.LIQUIDACAO, `Prestação de contas da sangria: ${justificativa}`);
        return { repetido: false, despesa, obrigacao: liq.titulos[0], lancamento: registrada.lancamento, prestacao: retratoDaPrestacao({ operacao: s.operacao, mov }, { agora: b.agora(), prazoHoras: await prazoDaUnidade(tx, cx) }), efeito: { novasDespesas: 1, novasSaidas: 0 } };
      });
    },

    /**
     * TROCO devolvido ao caixa: entrada (OUTRA, ligada à sangria) numa sessão ABERTA do mesmo caixa. Sem sessão aberta, recusa com o motivo.
     * @param {{sessaoId, movimentacaoId, sessaoDaDevolucaoId, chave, valorCentavos, data, confirmar}} entrada
     */
    registrarTrocoDaSangria(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["sessaoId", "movimentacaoId", "sessaoDaDevolucaoId", "chave", "valorCentavos", "data", "confirmar"], "trocoDaSangria");
      const chave = exigirChave(entrada.chave);
      const valor = exigirValor(entrada.valorCentavos, "valorCentavos");
      const data = exigirData(entrada.data, "data");
      if (entrada.confirmar !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira o troco devolvido e confirme.");
      const impressao = JSON.stringify([entrada.movimentacaoId, valor, data, entrada.sessaoDaDevolucaoId ?? entrada.sessaoId]);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await tx.travar(cx, `movimentacao:${entrada.movimentacaoId}`, "EXCLUSIVA");
        const s = await sangriaDe(b, tx, cx, entrada.sessaoId, entrada.movimentacaoId);
        await tx.travar(cx, `caixa:${s.conta.id}`, "EXCLUSIVA");
        const p = s.mov.prestacaoSangria ?? vazia();
        const ja = repetida(p.devolucoes, chave, impressao);
        if (ja) return { repetido: true, devolucao: ja, prestacao: retratoDaPrestacao(s, { agora: b.agora(), prazoHoras: await prazoDaUnidade(tx, cx) }) };
        const pendente = s.mov.valorCentavos - (s.mov.alocadoCentavos ?? 0) - (p.devolvidoCentavos ?? 0);
        if (valor > pendente) falhar(CODIGO.VALOR_INVALIDO, "O troco passa do que ainda falta prestar contas desta retirada.", { pendenteCentavos: pendente, valorCentavos: valor });
        if (data < s.mov.dataEfetiva) falhar(CODIGO.DATA_INVALIDA, "O troco não pode voltar antes da retirada.", { campo: "data" });
        const sessaoDev = await b.obterOuFalhar(tx, cx, TIPO.SESSAO_CAIXA, entrada.sessaoDaDevolucaoId ?? entrada.sessaoId, "Sessão de caixa da devolução");
        if (sessaoDev.situacao !== SITUACAO_SESSAO_CAIXA.ABERTA) falhar(CODIGO.OPERACAO_INVALIDA, "O caixa está fechado: abra o caixa para registrar o troco devolvido.", { motivo: "CAIXA_FECHADO" });
        if (sessaoDev.contaId !== s.conta.id) falhar(CODIGO.OPERACAO_INVALIDA, "O troco volta para o MESMO caixa de onde o dinheiro saiu.", { motivo: "OUTRO_CAIXA" });
        if (data < sessaoDev.dataAbertura) falhar(CODIGO.DATA_INVALIDA, "A devolução não pode ser anterior à abertura do caixa.", { campo: "data" });
        const descricao = `Troco da sangria de ${s.mov.dataEfetiva.slice(8, 10)}/${s.mov.dataEfetiva.slice(5, 7)}: ${s.operacao.descricao}`.slice(0, 300);
        const m = await naTx(tx, cx).registrarMovimentacao(cx, { contaId: s.conta.id, dataEfetiva: data, sentido: SENTIDO.ENTRADA, valorCentavos: valor, natureza: NATUREZA_MOVIMENTACAO.OUTRA, descricao });
        const devolucao = { chave, impressao, movimentacaoId: m.movimentacao.id, valorCentavos: valor, data, sessaoId: sessaoDev.id, registradoEm: b.agora(), registradoPor: cx.usuarioId };
        await b.alterar(tx, cx, TIPO.SESSAO_CAIXA, sessaoDev, { operacoes: [...(sessaoDev.operacoes ?? []), { operacao: OPERACAO_CAIXA.ENTRADA, valorCentavos: valor, data, descricao, movimentacaoId: m.movimentacao.id, transferenciaId: null, registradoEm: b.agora(), chave: `troco:${chave}`, trocoDaSangria: s.mov.id }] }, EVENTO_HISTORICO.OPERACAO_DE_CAIXA, descricao);
        const atual = await tx.obter(cx, TIPO.MOVIMENTACAO, s.mov.id);
        const mov = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, atual, { prestacaoSangria: { ...p, devolvidoCentavos: (p.devolvidoCentavos ?? 0) + valor, devolucoes: [...(p.devolucoes ?? []), devolucao] } }, EVENTO_HISTORICO.OPERACAO_DE_CAIXA, descricao);
        return { repetido: false, devolucao, prestacao: retratoDaPrestacao({ operacao: s.operacao, mov }, { agora: b.agora(), prazoHoras: await prazoDaUnidade(tx, cx) }), efeito: { novasDespesas: 0, novasEntradas: 1, receita: 0 } };
      });
    },
  };
}
