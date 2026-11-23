// Execução 08E (F-2) — BAIXA DE CONTA A PAGAR COM SAÍDA JÁ REGISTRADA (extrato importado ou movimento registrado).
//
// Regra fundamental: vincular um débito que já existe NÃO cria outro movimento bancário e NÃO reconhece despesa de novo.
// Só cria LIQUIDAÇÕES (a baixa) que ligam a saída existente às contas, consumindo o saldo alocável da saída.
//   - cada saída tem saldo alocável = valor − alocado; nunca negativo, nunca reutilizado (trava + versão + banco);
//   - uma saída pode quitar várias contas; uma conta pode ser quitada por várias saídas; pagamento parcial é permitido;
//   - nada de baixa "por coincidência": exige documento que comprove o pagamento ou conciliação CONFIRMADA com evidência;
//   - diferença entre saída e contas fica como está (saldo alocável restante = saída ainda sem classificação): nada de
//     taxa, juro ou desconto inventado para fechar valores;
//   - permissão própria `financeiro_v2.vincular_pagamento` (no núcleo e no banco), separada de registrar pagamento novo;
//   - Execução 09 — saída ANTERIOR à emissão da conta (pagamento antecipado): sem bloqueio absoluto por data, mas com
//     alerta na prévia, identificação explícita, documento compatível (conciliação sozinha não basta), justificativa
//     detalhada e marca auditável na liquidação; sem isso, recusa (o vínculo não é comprovável). Também no banco (0020).
import { exigirPagamentoLiberado } from "./guardaEntregadores.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, EVENTO_HISTORICO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LIQUIDACAO, SITUACAO_MOVIMENTACAO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { formatarBRL, proporcao, somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { diasEntre } from "../dominio/tempo.js";
import { aceitaEscrita } from "../dominio/fechamento.js";
import { competenciaDe } from "../dominio/tempo.js";
import { aplicarLiquidacao } from "../dominio/titulos.js";
import { CATEGORIA_JUROS_E_MULTAS, cadeiaDoSistema } from "../dominio/planoDeContas.js";
import { CODIGO as COD } from "../dominio/erros.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { validarPreviaDeVinculo, validarVinculoDeExtrato } from "../contratos/comandos.js";
import { exigirSemComprovantePendente } from "./baixaPorComprovante.js";

/** Por que uma saída não pode receber baixa de conta (null = pode). */
export function motivoDeSaidaInelegivel(m) {
  if (!m || m.sentido !== SENTIDO.SAIDA) return "Só saídas de conta quitam contas a pagar.";
  if (m.situacao !== SITUACAO_MOVIMENTACAO.VALIDA || m.estornoId) return "Saída estornada ou inválida.";
  if (m.transferenciaId || m.natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA) return "Transferência entre contas próprias não paga contas.";
  if (m.pagamentoId) return "Esta saída já é a devolução de um pagamento de venda.";
  if (m.natureza === NATUREZA_MOVIMENTACAO.DEVOLUCAO) return "Saída classificada como devolução: não paga conta a pagar (investigue a classificação antes).";
  if (subtrair(m.valorCentavos, m.alocadoCentavos ?? 0) <= 0) return "Saída já integralmente vinculada a outras contas.";
  return null;
}

/** Documentos aceitos como evidência de pagamento ANTECIPADO (comprovam o pagamento ou o acordo de pagar antes). */
export const DOCUMENTOS_DE_ANTECIPACAO = Object.freeze(["COMPROVANTE", "CONTRATO", "NOTA_FISCAL", "BOLETO"]);
export const JUSTIFICATIVA_MINIMA_ANTECIPACAO = 30;
/** Antecipação da saída em relação à emissão da conta (null quando não é anterior). */
export const antecipacaoDe = (mov, o) => (o.dataEmissao && mov.dataEfetiva < o.dataEmissao
  ? { dias: diasEntre(mov.dataEfetiva, o.dataEmissao), dataSaida: mov.dataEfetiva, dataEmissao: o.dataEmissao } : null);

const chaveDoVinculo = (movId, alocacoes) => `vinculo-extrato:${movId}:${alocacoes.map((a) => `${a.obrigacaoId}=${a.valorCentavos}`).sort().join(",")}`;
const lados = (c) => [...(c.ladoA ?? []), ...(c.ladoB ?? [])];

/** Conciliação CONFIRMADA, com evidência, que liga esta saída a esta conta (prova do vínculo sem documento novo). */
async function conciliacaoComprovada(tx, cx, movId, obrigacaoId) {
  const cs = await tx.listar(cx, TIPO.CORRESPONDENCIA, { onde: { situacao: "CONFIRMADA" } });
  return cs.find((c) => lados(c).some((r) => r.tipo === TIPO.MOVIMENTACAO && r.id === movId) && lados(c).some((r) => r.tipo === TIPO.OBRIGACAO && r.id === obrigacaoId) && (c.evidenciaDocumentoIds ?? []).length > 0) ?? null;
}

export function operacoesDeBaixaPorExtrato(b) {
  async function historicoDaSaida(tx, cx, m) {
    const liqs = (await tx.listar(cx, TIPO.LIQUIDACAO, { onde: { movimentacaoId: m.id } })).filter((l) => l.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA);
    const corr = (await tx.listar(cx, TIPO.CORRESPONDENCIA)).filter((c) => lados(c).some((r) => r.tipo === TIPO.MOVIMENTACAO && r.id === m.id));
    const docs = await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.MOVIMENTACAO, registroId: m.id } });
    return {
      liquidacoes: liqs.map((l) => ({ id: l.id, obrigacaoId: l.alvoId, valorCentavos: subtrair(l.valorCentavos, l.estornadoCentavos ?? 0), dataEfetiva: l.dataEfetiva, viaExtrato: Boolean(l.origemDoVinculo) })),
      conciliacoes: corr.map((c) => ({ id: c.id, situacao: c.situacao, forca: c.forca ?? null, evidencias: (c.evidenciaDocumentoIds ?? []).length })),
      documentoIds: [...new Set([...(m.documentoId ? [m.documentoId] : []), ...docs.map((v) => v.documentoId)])],
    };
  }

  return {
    /**
     * PRÉVIA (nada é gravado): a conta, as saídas elegíveis — NENHUMA pré-selecionada por valor ou data —, e, para a
     * saída escolhida, o histórico, as conciliações, as evidências e o efeito exato da baixa em cada tela.
     */
    previaDoVinculoDoExtrato(ctx, entrada) {
      const c = validarPreviaDeVinculo(entrada);
      return b.consultar(ctx, async (cx, tx) => {
        const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoId, "Conta a pagar");
        const contas = new Map((await tx.listar(cx, TIPO.CONTA)).map((x) => [x.id, x.nome]));
        const saidas = (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { sentido: SENTIDO.SAIDA } })).filter((m) => !motivoDeSaidaInelegivel(m));
        const comps = new Map();
        const editavel = async (comp) => {
          if (!comps.has(comp)) { const x = await b.competenciaAtual(tx, cx, comp); comps.set(comp, !x || aceitaEscrita(x.estado)); }
          return comps.get(comp);
        };
        const elegiveis = [];
        for (const m of saidas.sort((a, z) => z.dataEfetiva.localeCompare(a.dataEfetiva) || z.valorCentavos - a.valorCentavos)) {
          const aberta = await editavel(competenciaDe(m.dataEfetiva));
          elegiveis.push({ id: m.id, versao: m.versao, data: m.dataEfetiva, conta: contas.get(m.contaId) ?? "Conta", descricao: m.descricao ?? m.fonte?.idExterno ?? null, valorCentavos: m.valorCentavos, alocadoCentavos: m.alocadoCentavos, disponivelCentavos: subtrair(m.valorCentavos, m.alocadoCentavos), competenciaAceitaBaixa: aberta });
        }
        const pagos = (await tx.listar(cx, TIPO.LIQUIDACAO, { onde: { alvoId: o.id } })).filter((l) => l.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA);
        const obrigacao = {
          id: o.id, versao: o.versao, descricao: o.descricao, competencia: o.competencia, vencimento: o.vencimento, situacao: o.situacaoFinanceira ?? o.situacao,
          valorOriginalCentavos: o.valorOriginalCentavos, pagoCentavos: o.liquidadoCentavos ?? 0, saldoCentavos: o.saldoCentavos, parcela: o.parcela ?? null,
          pagamentos: pagos.map((l) => ({ data: l.dataEfetiva, valorCentavos: subtrair(l.valorCentavos, l.estornadoCentavos ?? 0), movimentacaoId: l.movimentacaoId, viaExtrato: Boolean(l.origemDoVinculo) })),
        };
        let escolhida = null;
        if (c.movimentacaoId) {
          const m = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Saída bancária");
          const disponivel = subtrair(m.valorCentavos, m.alocadoCentavos ?? 0);
          const valor = c.valorCentavos ?? Math.min(o.saldoCentavos, Math.max(disponivel, 0));
          const bloqueios = [];
          const inelegivel = motivoDeSaidaInelegivel(m);
          if (inelegivel) bloqueios.push(inelegivel);
          if (o.situacao === SITUACAO_TITULO.CANCELADA) bloqueios.push("Conta cancelada.");
          if (o.saldoCentavos <= 0) bloqueios.push("Conta já quitada.");
          if (valor > o.saldoCentavos) bloqueios.push("O valor supera o saldo em aberto da conta.");
          if (valor > disponivel) bloqueios.push("O valor supera o saldo ainda não vinculado da saída.");
          if (!(await editavel(competenciaDe(m.dataEfetiva)))) bloqueios.push("A competência da saída está homologada: a baixa não pode ser gravada nela.");
          const antecipacao = antecipacaoDe(m, o);
          const contraparte = o.contraparteId ? (await tx.obter(cx, TIPO.CONTRAPARTE, o.contraparteId))?.nome ?? null : null;
          const historico = await historicoDaSaida(tx, cx, m);
          const conc = await conciliacaoComprovada(tx, cx, m.id, o.id);
          const docsDaConta = (await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.OBRIGACAO, registroId: o.id } })).map((v) => v.documentoId);
          const docAutomatico = !antecipacao && m.documentoId ? await tx.obter(cx, TIPO.DOCUMENTO, m.documentoId) : null;
          const diferenca = subtrair(disponivel, valor);
          // Sobra que PODE ser juro/multa: saída maior que o saldo. Nada é escolhido sozinho; a pessoa decide na confirmação.
          const sobra = subtrair(disponivel, o.saldoCentavos);
          const limiteJuros = limiteDeJurosSemJustificativa(o.valorBaseCentavos);
          const juros = !inelegivel && o.saldoCentavos > 0 && sobra > 0
            ? { sobraCentavos: sobra, categoria: cadeiaDoSistema(CATEGORIA_JUROS_E_MULTAS).at(-1).nome, competencia: competenciaDe(m.dataEfetiva), limiteSemJustificativaCentavos: limiteJuros, acimaDoLimite: sobra > limiteJuros, justificativaMinima: JUSTIFICATIVA_MINIMA_JUROS, permissaoExigida: ACAO.CORRIGIR, voceTemPermissao: cx.permissoes.includes(ACAO.CORRIGIR) }
            : null;
          escolhida = {
            id: m.id, versao: m.versao, data: m.dataEfetiva, conta: contas.get(m.contaId) ?? "Conta", descricao: m.descricao ?? null, valorCentavos: m.valorCentavos, alocadoCentavos: m.alocadoCentavos, disponivelCentavos: disponivel,
            historico, evidencia: { conciliacaoConfirmadaComEvidencia: conc ? conc.id : null, documentosDaSaida: historico.documentoIds, documentosDaConta: docsDaConta, exigeDocumento: Boolean(antecipacao) || (!conc && !docAutomatico), documentoAutomatico: docAutomatico ? { id: docAutomatico.id, tipo: docAutomatico.tipo, descricao: docAutomatico.descricao ?? null, periodoInicio: docAutomatico.periodoInicio ?? null, periodoFim: docAutomatico.periodoFim ?? null } : null, tiposAceitos: antecipacao ? DOCUMENTOS_DE_ANTECIPACAO : null },
            // 09: alerta de PAGAMENTO ANTECIPADO — a pessoa confere beneficiário e valor no comprovante e identifica a antecipação.
            antecipacao: antecipacao ? { ...antecipacao, contraparte, justificativaMinima: JUSTIFICATIVA_MINIMA_ANTECIPACAO,
              alerta: `A saída (${antecipacao.dataSaida}) é ${antecipacao.dias} dia(s) ANTERIOR à emissão da conta (${antecipacao.dataEmissao}). Só vincule se for pagamento antecipado comprovado deste beneficiário: valor e data parecidos não provam o vínculo.` } : null,
            valorPropostoCentavos: valor, bloqueios, juros,
            efeito: {
              obrigacao: { saldoAntesCentavos: o.saldoCentavos, saldoDepoisCentavos: subtrair(o.saldoCentavos, valor), quitada: subtrair(o.saldoCentavos, valor) === 0 },
              saida: { disponivelAntesCentavos: disponivel, disponivelDepoisCentavos: diferenca },
              banco: "O saldo da conta bancária NÃO muda: a saída já está registrada; nenhuma nova saída é criada.",
              dre: "A DRE NÃO muda: a despesa já foi reconhecida na conta a pagar (competência dela).",
              fluxo: "Fluxo realizado não muda (a saída já está nele); o previsto deixa de mostrar o valor pago desta conta.",
              diferenca: diferenca > 0 ? `Sobram ${diferenca} centavos da saída sem vínculo: continuam como saída a classificar (nada é lançado como taxa ou desconto).` : null,
            },
          };
        }
        return { obrigacao, saidasElegiveis: elegiveis, escolhida, permissaoExigida: ACAO.VINCULAR_PAGAMENTO, voceTemPermissao: cx.permissoes.includes(ACAO.VINCULAR_PAGAMENTO) };
      });
    },

    /** Vincula a saída existente às contas (baixa). Transacional, idempotente, protegido por trava, versão e escopo. */
    vincularPagamentoDoExtrato(ctx, entrada) {
      const c = validarVinculoDeExtrato(entrada);
      return b.executar(ctx, ACAO.VINCULAR_PAGAMENTO, (cx, tx) => baixarSaidaNaTransacao(b, tx, cx, c));
    },
  };
}

/** Juro/multa acima de 10% do valor da conta exige justificativa detalhada (provavelmente não é só juro). */
export const LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL = 10;
export const JUSTIFICATIVA_MINIMA_JUROS = 30;
export const limiteDeJurosSemJustificativa = (valorOriginalCentavos) => proporcao(valorOriginalCentavos, LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL, 100);

/**
 * JURO/MULTA descoberto na baixa: a parte do valor vinculado que passa do saldo da conta vira AJUSTE da própria conta
 * (categoria "Juros e multas pagos a fornecedores", despesa financeira, competência do PAGAMENTO), na MESMA transação da
 * baixa. Só quita a conta inteira (o valor sem os juros é igual ao saldo) e só vem de saída que cobre os dois valores.
 */
async function lancarJurosDaBaixa(b, tx, cx, c, mov) {
  if (c.alocacoes.length !== 1) falhar(COD.ENTRADA_INVALIDA, "Juros ou multa só se classificam numa baixa de uma única conta.", { campo: "jurosCentavos" });
  if (!(cx.permissoes ?? []).includes(ACAO.CORRIGIR)) falhar(COD.PERMISSAO_INSUFICIENTE, "Classificar juros ou multa exige também a permissão de corrigir contas.", { acaoExigida: ACAO.CORRIGIR });
  const [a] = c.alocacoes;
  const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, a.obrigacaoId, "Conta a pagar");
  if (o.situacao === SITUACAO_TITULO.CANCELADA || !(o.saldoCentavos > 0)) falhar(COD.ENTRADA_INVALIDA, "Só uma conta em aberto recebe juros ou multa.", { campo: "jurosCentavos" });
  if (c.jurosCentavos >= a.valorCentavos) falhar(COD.ENTRADA_INVALIDA, "O juro não pode ser o valor inteiro vinculado.", { campo: "jurosCentavos" });
  const principal = subtrair(a.valorCentavos, c.jurosCentavos);
  if (principal !== o.saldoCentavos) falhar(COD.ENTRADA_INVALIDA, "Juros ou multa só se classificam quando a baixa quita a conta: o valor sem os juros precisa ser igual ao saldo em aberto.", { campo: "jurosCentavos", saldoCentavos: o.saldoCentavos, principalCentavos: principal });
  if (c.jurosCentavos > limiteDeJurosSemJustificativa(o.valorBaseCentavos) && c.justificativa.trim().length < JUSTIFICATIVA_MINIMA_JUROS) {
    falhar(COD.ENTRADA_INVALIDA, `O juro passa de ${LIMITE_JUROS_SEM_JUSTIFICATIVA_PERCENTUAL}% do valor da conta: explique o motivo (mínimo ${JUSTIFICATIVA_MINIMA_JUROS} caracteres).`, { motivo: "JUROS_ACIMA_DO_USUAL", campo: "justificativa" });
  }
  const documentoId = c.documentoId ?? mov.documentoId ?? null;
  await b.categoriaDoSistema(tx, cx, CATEGORIA_JUROS_E_MULTAS); // existe em qualquer unidade, mesmo em plano implantado antes dela
  return operacoesEconomicas(baseNaTransacao(b, tx, cx)).registrarAjuste(cx, {
    alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id, valorCentavos: c.jurosCentavos, categoria: CATEGORIA_JUROS_E_MULTAS, competencia: competenciaDe(mov.dataEfetiva),
    motivo: `Juros/multa pagos ao fornecedor (conta ${formatarBRL(o.valorBaseCentavos)} + ${formatarBRL(c.jurosCentavos)}): ${c.justificativa}`.slice(0, 500), ...(documentoId ? { documentoId } : {}),
  });
}

/**
 * A BAIXA propriamente dita, dentro da transação de quem chama: pelo vínculo manual (acima) ou pela confirmação da
 * conciliação conta × saída (conciliacao.js, doc 33), que assim baixa a conta NA MESMA transação em que confirma.
 * Mesmas travas, versão, idempotência, regras de antecipação e auditoria nos dois caminhos.
 * @param {{conciliacaoConfirmadaId?: string|null}} [opcoes]
 */
export async function baixarSaidaNaTransacao(b, tx, cx, c, opcoes = {}) {
  // Trava EXCLUSIVA na saída: duas sessões nunca consomem o mesmo saldo alocável (a outra espera e vê a versão nova).
  await tx.travar(cx, `movimentacao:${c.movimentacaoId}`, "EXCLUSIVA");
  const chave = chaveDoVinculo(c.movimentacaoId, c.alocacoes);
  const ja = await tx.buscarPorChave(cx, TIPO.LIQUIDACAO, `${chave}#${c.alocacoes[0].obrigacaoId}`);
  if (ja) {
    const liquidacoes = [];
    for (const a of c.alocacoes) liquidacoes.push(await tx.buscarPorChave(cx, TIPO.LIQUIDACAO, `${chave}#${a.obrigacaoId}`));
    return { repetido: true, liquidacoes, movimentacao: await tx.obter(cx, TIPO.MOVIMENTACAO, c.movimentacaoId) };
  }
  if (!c.confirmar) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a prévia e confirme a baixa.");
  const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Saída bancária");
  if (mov.versao !== c.versaoMovimentacao) {
    falhar(CODIGO.CONFLITO_VERSAO, "A saída mudou desde a prévia (outra baixa, conciliação ou correção). Atualize e confira de novo.", { versaoAtual: mov.versao, versaoEsperada: c.versaoMovimentacao });
  }
  const inelegivel = motivoDeSaidaInelegivel(mov);
  if (inelegivel) falhar(/integralmente/.test(inelegivel) ? CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO : CODIGO.LIQUIDACAO_INCOMPATIVEL, inelegivel);
  const disponivel = subtrair(mov.valorCentavos, mov.alocadoCentavos ?? 0);
  const total = somarLista(c.alocacoes, (a) => a.valorCentavos);
  if (total > disponivel) falhar(CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO, "O total vinculado supera o saldo ainda não vinculado da saída.", { disponivelCentavos: disponivel, totalCentavos: total });
  // Contas: travadas em ordem (sem impasse), carregadas no escopo (outra unidade simplesmente não existe aqui).
  for (const id of c.alocacoes.map((a) => a.obrigacaoId).sort()) await tx.travar(cx, `obrigacao:${id}`, "EXCLUSIVA");
  // Juros/multa vira ajuste da conta ANTES de carregá-la: a baixa abaixo já enxerga o saldo com os juros.
  const juros = c.jurosCentavos > 0 ? await lancarJurosDaBaixa(b, tx, cx, c, mov) : null;
  const contas = [];
  for (const a of c.alocacoes) contas.push(await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, a.obrigacaoId, "Conta a pagar"));
  for (const o of contas) await exigirPagamentoLiberado(tx, cx, o); // entregador próprio: só com nota e demonstrativo conferidos
  // Execução 17: conta já paga por comprovante (mesmo valor, sem conciliação) não recebe segunda baixa: concilia-se.
  for (const a of c.alocacoes) await exigirSemComprovantePendente(tx, cx, a.obrigacaoId, a.valorCentavos);
  // Evidência: documento que comprove o pagamento OU conciliação confirmada com evidência para CADA conta.
  const documentoExplicito = c.documentoId ? await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento de evidência") : null;
  // 09: pagamento ANTECIPADO (saída anterior à emissão) — identificação explícita + documento compatível + justificativa.
  const antecipacoes = contas.map((o) => antecipacaoDe(mov, o));
  // A saída escolhida veio de um extrato importado: esse extrato É o documento que comprova o pagamento (a pessoa não precisa escolhê-lo).
  // Pagamento antecipado continua exigindo comprovante/contrato/nota/boleto escolhido de propósito.
  const documento = documentoExplicito ?? (!antecipacoes.some(Boolean) && mov.documentoId ? await tx.obter(cx, TIPO.DOCUMENTO, mov.documentoId) : null);
  const documentoId = documento?.id ?? null;
  if (antecipacoes.some(Boolean)) {
    const quais = contas.flatMap((o, i) => (antecipacoes[i] ? [{ obrigacaoId: o.id, ...antecipacoes[i] }] : []));
    if (!c.pagamentoAntecipado) falhar(CODIGO.EVIDENCIA_EXIGIDA, "A saída é anterior à emissão da conta: só vincule identificando o PAGAMENTO ANTECIPADO e anexando o comprovante.", { motivo: "ANTECIPACAO_NAO_IDENTIFICADA", antecipadas: quais });
    if (!documento) falhar(CODIGO.EVIDENCIA_EXIGIDA, "Pagamento antecipado exige o documento que o comprove (conciliação ou coincidência de valor não bastam).", { motivo: "ANTECIPACAO_SEM_DOCUMENTO", antecipadas: quais });
    if (!DOCUMENTOS_DE_ANTECIPACAO.includes(documento.tipo)) falhar(CODIGO.EVIDENCIA_EXIGIDA, "O documento não comprova pagamento antecipado: use comprovante, contrato, nota fiscal ou boleto.", { motivo: "ANTECIPACAO_DOCUMENTO_INCOMPATIVEL", tipo: documento.tipo });
    if (c.justificativa.trim().length < JUSTIFICATIVA_MINIMA_ANTECIPACAO) falhar(CODIGO.ENTRADA_INVALIDA, `Explique o pagamento antecipado (mínimo ${JUSTIFICATIVA_MINIMA_ANTECIPACAO} caracteres): beneficiário, motivo e conferência do valor.`, { motivo: "ANTECIPACAO_SEM_JUSTIFICATIVA", campo: "justificativa" });
  } else if (c.pagamentoAntecipado) {
    falhar(CODIGO.ENTRADA_INVALIDA, "A saída não é anterior à emissão da conta: não marque como pagamento antecipado.", { motivo: "ANTECIPACAO_INDEVIDA", campo: "pagamentoAntecipado" });
  }
  // Sem documento: cada conta precisa de conciliação confirmada com evidência (antecipada já foi recusada acima).
  // Na confirmação da conciliação (mesma transação), a correspondência que está sendo confirmada É a evidência do vínculo.
  if (!documento && !opcoes.conciliacaoConfirmadaId) {
    for (const o of contas) {
      if (!(await conciliacaoComprovada(tx, cx, mov.id, o.id))) {
        falhar(CODIGO.EVIDENCIA_EXIGIDA, "Vincular exige o documento que comprova o pagamento (comprovante, boleto pago) ou uma conciliação confirmada com evidência. Valor e data iguais não bastam.", { obrigacaoId: o.id });
      }
    }
  }
  await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(mov.dataEfetiva)], referenciadas: contas.map((o) => o.competencia), motivo: "baixa de conta com saída do extrato" });
  const liquidacoes = [];
  const titulos = [];
  const rotulo = (ant) => (ant ? `[Pagamento antecipado: saída ${ant.dias} dia(s) antes da emissão] ${c.justificativa}` : c.justificativa);
  for (const [i, a] of c.alocacoes.entries()) {
    const o = contas[i];
    const mudancas = aplicarLiquidacao(o, a.valorCentavos); // saldo nunca negativo; conta cancelada é recusada
    liquidacoes.push(await b.criar(tx, cx, TIPO.LIQUIDACAO, {
      movimentacaoId: mov.id, alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id, valorCentavos: a.valorCentavos, estornadoCentavos: 0, dataEfetiva: mov.dataEfetiva,
      situacao: SITUACAO_LIQUIDACAO.VALIDA, chaveIdempotencia: `${chave}#${o.id}`, origemDoVinculo: "EXTRATO", ...(opcoes.conciliacaoConfirmadaId ? { conciliacaoId: opcoes.conciliacaoConfirmadaId } : {}), documentoId: documentoId, justificativa: c.justificativa,
      antecipacao: antecipacoes[i] ? { ...antecipacoes[i], identificadaPor: cx.usuarioId, documentoTipo: documento?.tipo ?? null } : null,
    }, rotulo(antecipacoes[i])));
    titulos.push(await b.alterar(tx, cx, TIPO.OBRIGACAO, o, mudancas, EVENTO_HISTORICO.LIQUIDACAO, rotulo(antecipacoes[i])));
  }
  const movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: somar(mov.alocadoCentavos, total) }, EVENTO_HISTORICO.LIQUIDACAO, c.justificativa);
  // A evidência fica vinculada à saída e a cada conta (rastreável dos dois lados).
  if (documentoId) {
    for (const [tipo, id] of [[TIPO.MOVIMENTACAO, mov.id], ...contas.map((o) => [TIPO.OBRIGACAO, o.id])]) {
      const chaveV = `${documentoId}|${tipo}|${id}`;
      if (!(await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chaveV))) {
        await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { documentoId: documentoId, registroTipo: tipo, registroId: id, chaveIdempotencia: chaveV, finalidade: "Comprova o pagamento vinculado do extrato" }, c.justificativa);
      }
    }
  }
  return {
    repetido: false, movimentacao, liquidacoes, titulos, ...(juros ? { juros: { ajuste: juros.ajuste, lancamento: juros.lancamento } } : {}),
    efeito: { novasSaidas: 0, novasDespesas: juros ? 1 : 0, ...(juros ? { jurosCentavos: c.jurosCentavos } : {}), vinculadoCentavos: total, disponivelDepoisCentavos: subtrair(disponivel, total) },
  };
}
