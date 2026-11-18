// Movimentações de Frente de Caixa da SAIPOS (sangria, reforço, transferência): LEITURA e CONFERÊNCIA. Nada aqui grava dinheiro.
//
// O relatório entra pelo importador de sempre (fonte SAIPOS_MOVIMENTOS_CAIXA → registros de fonte "MOVIMENTO_CAIXA", sem efeito
// financeiro). Esta camada só lê esses registros e os apresenta:
//   - NÃO é faturamento e importar não lança nada. A retirada vira DESPESA só na etapa explícita de sangriasComoDespesa.js; reforço e transferência nunca;
//   - o relatório não traz caixa, operador nem horário: o vínculo com a frente de caixa fica PENDENTE (nunca é inventado);
//   - contra o fechamento manual (que a equipe digita) a comparação é por dia: valores iguais viram "possível duplicidade" para
//     REVISÃO (nunca somados duas vezes); valores diferentes viram divergência; o sistema não escolhe um dos lados sozinho.
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { formatarBRL } from "../dominio/dinheiro.js";
import { exigirData } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { NATUREZA_MOVIMENTO_CAIXA as N } from "../importacao/fontes/saipos.js";

export const TIPO_REGISTRO_MOVIMENTO_CAIXA = "MOVIMENTO_CAIXA";

/** Registros ativos de movimentação de caixa com data de referência no período (já respeita empresa e unidade: o repositório é escopado). */
export async function movimentosDoPeriodo(tx, cx, inicio, fim) {
  return (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: TIPO_REGISTRO_MOVIMENTO_CAIXA } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dataReferencia >= inicio && r.dataReferencia <= fim);
}

const soma = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
const bloco = (lista) => ({ quantidade: lista.length, totalCentavos: soma(lista, (r) => r.dados.valorAbsolutoCentavos) });

/** Situação da comparação de UM tipo de movimento entre o relatório importado e o fechamento manual do dia. */
export function compararComFechamento(importadoCentavos, manualCentavos) {
  const i = importadoCentavos ?? 0;
  const m = manualCentavos ?? 0;
  if (!i && !m) return null;
  if (i && !m) return "SO_IMPORTADO";
  if (!i && m) return "SO_MANUAL";
  return i === m ? "POSSIVEL_DUPLICIDADE" : "DIVERGENTE";
}

const itemDe = (r) => ({
  id: r.id, importacaoId: r.importacaoId, linha: r.linha, data: r.dataReferencia, natureza: r.dados.natureza, valorCentavos: r.dados.valorAbsolutoCentavos,
  descricao: r.dados.descricaoOriginal, conta: r.dados.contaOriginal, categoria: r.dados.categoriaOriginal, considerar: r.dados.considerar, pago: r.dados.pago,
  motivo: r.dados.naturezaMotivo, caixa: r.dados.caixa ?? null, vinculoComCaixa: r.dados.vinculoComCaixa ?? "PENDENTE",
});

/**
 * Resumo de UM dia. `fechamentos` = fechamentos manuais do dia (todos os caixas); `vendasEmDinheiroCentavos` = dinheiro vendido segundo
 * as vendas importadas (null = sem vendas importadas no dia, o que não é zero).
 */
export function resumirMovimentosDoDia({ data, movimentos, fechamentos = [], vendasEmDinheiroCentavos = null }) {
  const contam = movimentos.filter((r) => r.dados.considerar);
  const por = (natureza) => contam.filter((r) => r.dados.natureza === natureza);
  const retiradas = bloco(por(N.SANGRIA));
  const reforcos = bloco(por(N.REFORCO));
  const transferencias = bloco(por(N.TRANSFERENCIA));
  const desconhecidas = bloco(movimentos.filter((r) => r.dados.natureza === N.DESCONHECIDA));
  // Transferência não entra na conta do caixa (sentido desconhecido): aparece à parte, "a confirmar".
  const transferenciasAConfirmar = bloco(movimentos.filter((r) => r.dados.natureza === N.TRANSFERENCIA && r.dados.pago === true));
  const naoPagas = movimentos.filter((r) => r.dados.pago !== true);
  const manual = (campo) => {
    const valores = fechamentos.map((f) => f.dados?.dinheiro?.[campo]).filter((v) => v !== null && v !== undefined);
    return valores.length ? soma(valores, (v) => v) : null;
  };
  const conferencia = {
    retiradas: compararComFechamento(retiradas.totalCentavos, manual("retiradasCentavos")),
    reforcos: compararComFechamento(reforcos.totalCentavos, manual("reforcosCentavos")),
    transferencias: compararComFechamento(transferencias.totalCentavos, manual("transferenciasCentavos")),
  };
  const manuais = { retiradasCentavos: manual("retiradasCentavos"), reforcosCentavos: manual("reforcosCentavos"), transferenciasCentavos: manual("transferenciasCentavos") };
  const nomes = { retiradas: "retiradas", reforcos: "reforços", transferencias: "transferências" };
  const divergencias = [];
  const alertas = [];
  for (const k of Object.keys(conferencia)) {
    const imp = { retiradas, reforcos, transferencias }[k].totalCentavos;
    const man = manuais[`${k}Centavos`];
    if (conferencia[k] === "POSSIVEL_DUPLICIDADE") {
      alertas.push({ codigo: "POSSIVEL_DUPLICIDADE", movimento: k, mensagem: `O fechamento manual já informa ${nomes[k]} de ${formatarBRL(man)}, igual ao relatório importado: é o mesmo dinheiro? Confira antes de somar — o sistema usa o valor uma vez só.` });
    } else if (conferencia[k] === "DIVERGENTE") {
      divergencias.push({ codigo: "MOVIMENTO_DIVERGE_DO_FECHAMENTO", movimento: k, importadoCentavos: imp, manualCentavos: man, mensagem: `${nomes[k][0].toUpperCase()}${nomes[k].slice(1)}: o relatório importado traz ${formatarBRL(imp)} e o fechamento manual ${formatarBRL(man)}. Revise antes de conferir o caixa.` });
    }
  }
  if (desconhecidas.quantidade) divergencias.push({ codigo: "MOVIMENTO_A_CLASSIFICAR", quantidade: desconhecidas.quantidade, valorCentavos: desconhecidas.totalCentavos, mensagem: `${desconhecidas.quantidade} movimentação(ões) sem classificação segura: ficam pendentes e fora dos totais.` });
  if (transferenciasAConfirmar.quantidade) divergencias.push({ codigo: "TRANSFERENCIA_A_CONFIRMAR", quantidade: transferenciasAConfirmar.quantidade, valorCentavos: transferenciasAConfirmar.totalCentavos, mensagem: `${transferenciasAConfirmar.quantidade} transferência(s) a confirmar: o relatório não diz se o dinheiro sai ou entra no caixa, então ficam fora do dinheiro esperado.` });
  if (naoPagas.length) divergencias.push({ codigo: "MOVIMENTO_NAO_PAGO", quantidade: naoPagas.length, mensagem: `${naoPagas.length} movimentação(ões) não paga(s) no relatório: fora dos totais.` });
  const abertura = manual("aberturaCentavos");
  if (retiradas.totalCentavos > 0 && vendasEmDinheiroCentavos !== null && retiradas.totalCentavos > vendasEmDinheiroCentavos + (abertura ?? 0)) {
    alertas.push({ codigo: "RETIRADA_ACIMA_DO_DINHEIRO_DO_DIA", mensagem: `As retiradas do dia (${formatarBRL(retiradas.totalCentavos)}) passam do dinheiro vendido (${formatarBRL(vendasEmDinheiroCentavos)})${abertura === null ? ": confira a abertura do caixa (troco inicial), que não foi informada" : " somado à abertura informada"}.` });
  }
  return {
    data, retiradas, reforcos, transferencias, transferenciasAConfirmar, desconhecidas, naoPagas: { quantidade: naoPagas.length },
    pendenciasDeCaixa: { quantidade: contam.length, mensagem: contam.length ? "O relatório não informa o caixa (frente de caixa) de cada movimentação: o vínculo fica pendente." : null },
    conferenciaComFechamento: conferencia, alertas, divergencias, itens: movimentos.map(itemDe).sort((a, x) => a.linha - x.linha),
  };
}

/**
 * Conferência do DINHEIRO do dia: abertura + vendas em dinheiro + reforços − sangrias − transferências = esperado; diferença = informado − esperado.
 * Cada movimento entra UMA vez: importado e manual iguais contam uma vez (e viram alerta de duplicidade); importado e manual diferentes
 * impedem o cálculo (REVISAR_MOVIMENTOS) em vez de escolher um lado.
 */
export function dinheiroDoDia({ resumo, fechamentos = [], vendasEmDinheiroCentavos = null }) {
  const manual = (campo) => {
    const valores = fechamentos.map((f) => f.dados?.dinheiro?.[campo]).filter((v) => v !== null && v !== undefined);
    return valores.length ? soma(valores, (v) => v) : null;
  };
  const escolher = (importado, manualCentavos, situacao) => {
    if (situacao === "DIVERGENTE") return { valorCentavos: null, origem: "CONFLITO" };
    if (situacao === "POSSIVEL_DUPLICIDADE") return { valorCentavos: importado, origem: "IMPORTADO_E_MANUAL_IGUAIS" };
    if (situacao === "SO_IMPORTADO") return { valorCentavos: importado, origem: "IMPORTADO" };
    if (situacao === "SO_MANUAL") return { valorCentavos: manualCentavos, origem: "MANUAL" };
    return { valorCentavos: 0, origem: null };
  };
  const c = resumo?.conferenciaComFechamento ?? { retiradas: null, reforcos: null, transferencias: null };
  const ret = escolher(resumo?.retiradas.totalCentavos ?? 0, manual("retiradasCentavos"), c.retiradas);
  const ref = escolher(resumo?.reforcos.totalCentavos ?? 0, manual("reforcosCentavos"), c.reforcos);
  const tra = escolher(resumo?.transferencias.totalCentavos ?? 0, manual("transferenciasCentavos"), c.transferencias);
  const abertura = manual("aberturaCentavos");
  const vendasManual = manual("vendasCentavos");
  const vendas = vendasEmDinheiroCentavos ?? vendasManual;
  const informado = manual("informadoCentavos");
  const conflito = [ret, ref, tra].some((x) => x.origem === "CONFLITO");
  const esperado = conflito ? null : (abertura ?? 0) + (vendas ?? 0) + ref.valorCentavos - ret.valorCentavos - tra.valorCentavos;
  return {
    aberturaCentavos: abertura, vendasEmDinheiroCentavos: vendas, origemDasVendas: vendasEmDinheiroCentavos !== null ? "IMPORTADO" : vendasManual !== null ? "MANUAL" : null,
    retiradasCentavos: ret.valorCentavos, reforcosCentavos: ref.valorCentavos, transferenciasCentavos: tra.valorCentavos,
    origem: { retiradas: ret.origem, reforcos: ref.origem, transferencias: tra.origem },
    esperadoCentavos: esperado, informadoCentavos: informado, diferencaCentavos: esperado !== null && informado !== null ? informado - esperado : null,
    aberturaInformada: abertura !== null,
    situacao: conflito ? "REVISAR_MOVIMENTOS" : informado === null ? "SEM_VALOR_INFORMADO" : esperado === informado ? "CONFERE" : "DIFERENTE",
  };
}

export function operacoesDeMovimentosDeCaixa(b) {
  return {
    /** Movimentações do período, por dia, com os totais, a conferência com o fechamento manual e a lista que compõe cada total. */
    consultarMovimentosDeCaixa(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
      const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
      const fim = exigirData(entrada.periodoFim, "periodoFim");
      if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
      return b.consultar(ctx, async (cx, tx) => {
        const movimentos = await movimentosDoPeriodo(tx, cx, inicio, fim);
        const fechamentos = (await tx.listar(cx, TIPO.FECHAMENTO_CAIXA)).filter((f) => f.data >= inicio && f.data <= fim);
        const datas = [...new Set(movimentos.map((r) => r.dataReferencia))].sort();
        const dias = datas.map((data) => resumirMovimentosDoDia({ data, movimentos: movimentos.filter((r) => r.dataReferencia === data), fechamentos: fechamentos.filter((f) => f.data === data) }));
        const totais = {
          retiradas: bloco(movimentos.filter((r) => r.dados.considerar && r.dados.natureza === N.SANGRIA)),
          reforcos: bloco(movimentos.filter((r) => r.dados.considerar && r.dados.natureza === N.REFORCO)),
          transferencias: bloco(movimentos.filter((r) => r.dados.considerar && r.dados.natureza === N.TRANSFERENCIA)),
          desconhecidas: bloco(movimentos.filter((r) => r.dados.natureza === N.DESCONHECIDA)),
          semCaixaIdentificado: movimentos.filter((r) => r.dados.considerar).length,
        };
        return { periodoInicio: inicio, periodoFim: fim, dias, totais, observacao: "Retiradas de caixa são despesas pagas em dinheiro, mas só viram conta quando você as lança (etapa explícita). Reforço e transferência não são despesa. Nada aqui é faturamento." };
      });
    },
  };
}
