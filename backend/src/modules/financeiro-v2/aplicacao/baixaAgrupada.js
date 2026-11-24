// BAIXA AGRUPADA — várias contas a pagar quitadas por UMA saída bancária já registrada (ex.: VR de vários funcionários
// pago num único PIX ao iFood Benefícios).
//
// Nada novo no modelo: a saída e as contas já existem; a baixa grava uma LIQUIDAÇÃO por conta, todas com a mesma
// `movimentacaoId`, pela MESMA função da baixa individual (baixarSaidaNaTransacao): trava na saída e nas contas, versão,
// idempotência, escopo da unidade, permissão própria, evidência do extrato e competência aberta. Nenhuma despesa nova,
// nenhuma saída nova. "Pertencem ao mesmo pagamento" = liquidações válidas da mesma saída.
// A reversão estorna TODAS as liquidações do grupo numa só transação, com o estorno auditável de cada uma.
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_LIQUIDACAO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somarLista, subtrair } from "../dominio/dinheiro.js";
import { aceitaEscrita } from "../dominio/fechamento.js";
import { competenciaDe } from "../dominio/tempo.js";
import { exigirInteiro, exigirLista, exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { antecipacaoDe, baixarSaidaNaTransacao, motivoDeSaidaInelegivel } from "./baixaPorExtrato.js";
import { operacoesDeCaixa } from "./caixa.js";

export const MINIMO_DE_CONTAS = 2;
export const MAXIMO_DE_CONTAS = 50;

function idsDeContas(lista) {
  const ids = exigirLista(lista, "obrigacaoIds", { min: MINIMO_DE_CONTAS, max: MAXIMO_DE_CONTAS }).map((x, i) => exigirUuid(x, `obrigacaoIds[${i}]`));
  if (new Set(ids).size !== ids.length) falhar(CODIGO.ENTRADA_INVALIDA, "A mesma conta aparece mais de uma vez.", { campo: "obrigacaoIds" });
  return ids;
}

const valido = (l) => subtrair(l.valorCentavos, l.estornadoCentavos ?? 0);
const ativa = (l) => l.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA && valido(l) > 0;

/** Liquidações válidas da saída = composição do pagamento (agrupado quando há mais de uma conta). */
async function composicaoDaSaida(tx, cx, movimentacaoId) {
  const liqs = (await tx.listar(cx, TIPO.LIQUIDACAO, { onde: { movimentacaoId } })).filter(ativa);
  const contas = [];
  for (const l of liqs) {
    const o = await tx.obter(cx, TIPO.OBRIGACAO, l.alvoId);
    const contraparte = o?.contraparteId ? (await tx.obter(cx, TIPO.CONTRAPARTE, o.contraparteId))?.nome ?? null : null;
    contas.push({ liquidacaoId: l.id, obrigacaoId: l.alvoId, descricao: o?.descricao ?? null, contraparte, competencia: o?.competencia ?? null, vencimento: o?.vencimento ?? null, valorCentavos: valido(l), dataEfetiva: l.dataEfetiva, viaExtrato: Boolean(l.origemDoVinculo), justificativa: l.justificativa ?? null });
  }
  return contas.sort((a, z) => String(a.descricao).localeCompare(String(z.descricao), "pt-BR"));
}

export function operacoesDeBaixaAgrupada(b) {
  return {
    /**
     * PRÉVIA (nada é gravado): contas selecionadas, soma, saídas elegíveis (NENHUMA pré-selecionada; só se marca a que tem
     * saldo igual à soma) e, para a saída escolhida, a diferença, os bloqueios e o efeito.
     */
    previaDaBaixaAgrupada(ctx, e = {}) {
      semCamposDesconhecidos(e, ["obrigacaoIds", "movimentacaoId"], "baixaAgrupada");
      const ids = idsDeContas(e.obrigacaoIds);
      const movimentacaoId = e.movimentacaoId ? exigirUuid(e.movimentacaoId, "movimentacaoId") : null;
      return b.consultar(ctx, async (cx, tx) => {
        const comps = new Map();
        const editavel = async (comp) => {
          if (!comps.has(comp)) { const x = await b.competenciaAtual(tx, cx, comp); comps.set(comp, !x || aceitaEscrita(x.estado)); }
          return comps.get(comp);
        };
        const contas = [];
        for (const id of ids) {
          const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, id, "Conta a pagar"); // outra unidade: não existe aqui
          const contraparte = o.contraparteId ? (await tx.obter(cx, TIPO.CONTRAPARTE, o.contraparteId))?.nome ?? null : null;
          const bloqueios = [];
          if (o.situacao === SITUACAO_TITULO.CANCELADA) bloqueios.push("Conta cancelada.");
          else if (!(o.saldoCentavos > 0)) bloqueios.push("Conta já quitada.");
          contas.push({ id: o.id, versao: o.versao, descricao: o.descricao, contraparte, competencia: o.competencia, vencimento: o.vencimento, dataEmissao: o.dataEmissao ?? null, valorOriginalCentavos: o.valorOriginalCentavos ?? o.valorBaseCentavos, saldoCentavos: o.saldoCentavos, situacao: o.situacao, bloqueios });
        }
        const somaCentavos = somarLista(contas, (c) => Math.max(c.saldoCentavos, 0));
        const contasBancarias = new Map((await tx.listar(cx, TIPO.CONTA)).map((x) => [x.id, x.nome]));
        const saidas = (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { sentido: "SAIDA" } })).filter((m) => !motivoDeSaidaInelegivel(m));
        const elegiveis = [];
        for (const m of saidas.sort((a, z) => z.dataEfetiva.localeCompare(a.dataEfetiva) || z.valorCentavos - a.valorCentavos)) {
          const disponivel = subtrair(m.valorCentavos, m.alocadoCentavos ?? 0);
          elegiveis.push({ id: m.id, versao: m.versao, data: m.dataEfetiva, conta: contasBancarias.get(m.contaId) ?? "Conta", descricao: m.descricao ?? null, valorCentavos: m.valorCentavos, disponivelCentavos: disponivel, igualASoma: disponivel === somaCentavos, competenciaAceitaBaixa: await editavel(competenciaDe(m.dataEfetiva)) });
        }
        let escolhida = null;
        if (movimentacaoId) {
          const m = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, movimentacaoId, "Saída bancária");
          const disponivel = subtrair(m.valorCentavos, m.alocadoCentavos ?? 0);
          const bloqueios = [];
          const inelegivel = motivoDeSaidaInelegivel(m);
          if (inelegivel) bloqueios.push(inelegivel);
          if (contas.some((c) => c.bloqueios.length)) bloqueios.push("Há conta selecionada cancelada ou já quitada: retire-a da seleção.");
          if (somaCentavos > disponivel) bloqueios.push("A soma das contas supera o saldo ainda não vinculado da saída.");
          if (!(await editavel(competenciaDe(m.dataEfetiva)))) bloqueios.push("A competência da saída está homologada: a baixa não pode ser gravada nela.");
          const antecipadas = contas.filter((c) => antecipacaoDe(m, c)).map((c) => c.id);
          if (antecipadas.length) bloqueios.push("A saída é anterior à emissão de alguma conta: pagamento antecipado se vincula conta a conta, com comprovante.");
          const exigeDocumento = !m.documentoId;
          const diferenca = subtrair(disponivel, somaCentavos);
          escolhida = {
            id: m.id, versao: m.versao, data: m.dataEfetiva, conta: contasBancarias.get(m.contaId) ?? "Conta", descricao: m.descricao ?? null, valorCentavos: m.valorCentavos, disponivelCentavos: disponivel,
            diferencaCentavos: diferenca, exigeDocumento, bloqueios, antecipadas, composicaoAtual: await composicaoDaSaida(tx, cx, m.id),
            efeito: {
              contas: `${contas.length} conta(s) ficam quitadas pelo valor do saldo; cada uma mantém descrição, categoria e competência.`,
              banco: "O saldo bancário NÃO muda: a saída já está registrada; nenhuma saída nova é criada.",
              dre: "A DRE NÃO muda: as despesas já estão reconhecidas nas contas; nenhuma despesa nova é criada.",
              diferenca: diferenca > 0 ? `Sobra ${diferenca} centavo(s) da saída sem vínculo: continua como saída a classificar (nada é lançado para fechar).` : null,
            },
          };
        }
        return { contas, somaCentavos, saidasElegiveis: elegiveis, escolhida, permissaoExigida: ACAO.VINCULAR_PAGAMENTO, voceTemPermissao: cx.permissoes.includes(ACAO.VINCULAR_PAGAMENTO) };
      });
    },

    /** Grava a baixa agrupada: cada conta recebe o SALDO, todas na mesma transação e na mesma saída. */
    vincularPagamentoAgrupado(ctx, e = {}) {
      semCamposDesconhecidos(e, ["movimentacaoId", "versaoMovimentacao", "obrigacaoIds", "documentoId", "justificativa", "confirmar"], "baixaAgrupada");
      const ids = idsDeContas(e.obrigacaoIds);
      const movimentacaoId = exigirUuid(e.movimentacaoId, "movimentacaoId");
      const versaoMovimentacao = exigirInteiro(e.versaoMovimentacao, "versaoMovimentacao", { min: 1 });
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      const documentoId = e.documentoId ? exigirUuid(e.documentoId, "documentoId") : null;
      return b.executar(ctx, ACAO.VINCULAR_PAGAMENTO, async (cx, tx) => {
        // Repetição do mesmo envio: a chave de idempotência da baixa depende das alocações, que dependem do saldo — por
        // isso, se TODAS as contas já estão quitadas por esta saída, devolve o grupo existente em vez de recusar.
        const ja = await composicaoDaSaida(tx, cx, movimentacaoId);
        if (ids.every((id) => ja.some((c) => c.obrigacaoId === id))) {
          const todas = await Promise.all(ids.map((id) => tx.obter(cx, TIPO.OBRIGACAO, id)));
          if (todas.every((o) => o && !(o.saldoCentavos > 0))) return { repetido: true, composicao: ja };
        }
        const alocacoes = [];
        for (const id of ids) {
          const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, id, "Conta a pagar");
          if (o.situacao === SITUACAO_TITULO.CANCELADA || !(o.saldoCentavos > 0)) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Conta cancelada ou já quitada na seleção: atualize a prévia.", { obrigacaoId: id });
          alocacoes.push({ obrigacaoId: id, valorCentavos: o.saldoCentavos });
        }
        const r = await baixarSaidaNaTransacao(b, tx, cx, { movimentacaoId, versaoMovimentacao, alocacoes, documentoId, justificativa: `[Baixa agrupada: ${ids.length} contas] ${justificativa}`.slice(0, 500), confirmar: e.confirmar === true, pagamentoAntecipado: false, jurosCentavos: 0 });
        return { ...r, composicao: await composicaoDaSaida(tx, cx, movimentacaoId) };
      });
    },

    /** Composição do pagamento de uma saída (para expandir no calendário e em Contas a Pagar). */
    consultarPagamentoAgrupado(ctx, e = {}) {
      semCamposDesconhecidos(e, ["movimentacaoId"], "pagamento");
      const movimentacaoId = exigirUuid(e.movimentacaoId, "movimentacaoId");
      return b.consultar(ctx, async (cx, tx) => {
        const m = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, movimentacaoId, "Saída bancária");
        const contas = await composicaoDaSaida(tx, cx, m.id);
        return { movimentacao: { id: m.id, versao: m.versao, data: m.dataEfetiva, descricao: m.descricao ?? null, valorCentavos: m.valorCentavos, alocadoCentavos: m.alocadoCentavos ?? 0, disponivelCentavos: subtrair(m.valorCentavos, m.alocadoCentavos ?? 0) }, agrupado: contas.length > 1, contas, totalCentavos: somarLista(contas, (c) => c.valorCentavos) };
      });
    },

    /**
     * REVERSÃO CONTROLADA: estorna TODAS as liquidações válidas da saída numa só transação (cada uma com o seu estorno
     * auditável). As contas voltam a ficar em aberto e a saída volta a ter saldo a vincular. Nada é apagado.
     */
    reverterPagamentoAgrupado(ctx, e = {}) {
      semCamposDesconhecidos(e, ["movimentacaoId", "versaoMovimentacao", "justificativa", "confirmar"], "reversao");
      const movimentacaoId = exigirUuid(e.movimentacaoId, "movimentacaoId");
      const versaoMovimentacao = exigirInteiro(e.versaoMovimentacao, "versaoMovimentacao", { min: 1 });
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      if (justificativa.trim().length < 10) falhar(CODIGO.ENTRADA_INVALIDA, "Explique a reversão (mínimo 10 caracteres).", { campo: "justificativa" });
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        if (!(cx.permissoes ?? []).includes(ACAO.VINCULAR_PAGAMENTO)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Reverter uma baixa do extrato exige também a permissão de vincular pagamentos.", { acaoExigida: ACAO.VINCULAR_PAGAMENTO });
        if (e.confirmar !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira as contas do pagamento e confirme a reversão.");
        await tx.travar(cx, `movimentacao:${movimentacaoId}`, "EXCLUSIVA");
        const m = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, movimentacaoId, "Saída bancária");
        if (m.versao !== versaoMovimentacao) falhar(CODIGO.CONFLITO_VERSAO, "A saída mudou desde a consulta. Atualize e confira de novo.", { versaoAtual: m.versao, versaoEsperada: versaoMovimentacao });
        const liqs = (await tx.listar(cx, TIPO.LIQUIDACAO, { onde: { movimentacaoId } })).filter(ativa).sort((a, z) => (a.alvoId < z.alvoId ? -1 : 1));
        if (!liqs.length) falhar(CODIGO.OPERACAO_INVALIDA, "Esta saída não tem baixa válida para reverter.");
        for (const l of liqs) await tx.travar(cx, `obrigacao:${l.alvoId}`, "EXCLUSIVA");
        const caixa = operacoesDeCaixa(baseNaTransacao(b, tx, cx));
        const estornos = [];
        for (const l of liqs) estornos.push(await caixa.estornarLiquidacao(cx, { liquidacaoId: l.id, justificativa: `[Reversão da baixa agrupada] ${justificativa}`.slice(0, 500) }));
        return { revertidas: estornos.length, totalCentavos: somarLista(liqs, valido), estornos: estornos.map((x) => ({ estornoId: x.estorno.id, liquidacaoId: x.liquidacao.id, obrigacaoId: x.titulo.id, saldoCentavos: x.titulo.saldoCentavos })), movimentacao: await tx.obter(cx, TIPO.MOVIMENTACAO, movimentacaoId) };
      });
    },
  };
}
