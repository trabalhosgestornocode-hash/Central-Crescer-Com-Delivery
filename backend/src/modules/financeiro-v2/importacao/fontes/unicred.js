// UNICRED — extrato bancário. Conferência obrigatória: saldo inicial + entradas − saídas = saldo final, e cada linha
// encadeia com o saldo da anterior. Isso prova só a CONSISTÊNCIA ARITMÉTICA do extrato — não a classificação econômica.
// Crédito bancário não vira venda; débito bancário não vira despesa. A categoria bancária é só SUGESTÃO por palavras do
// histórico e alimenta a busca de candidatas de conciliação; nada é confirmado aqui.
import { somar, subtrair } from "../../dominio/dinheiro.js";
import { centavos, rotulo } from "../leitor.js";
import { DIVERGENCIA, ERRO, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

export function categoriaBancaria(historico, sentido) {
  const c = classificarPorPalavras(historico, [
    ["TARIFA", ["tarifa", "cesta de servic", "taxa de manut"]],
    ["EMPRESTIMO", ["emprestimo", "financiamento", "parcela de credito", "capital de giro"]],
    ["PAGAMENTO_BOLETO", ["boleto", "pagto titulo", "pagamento de titulo", "liquidacao de titulo"]],
    ["CREDITO_ADQUIRENTE", ["stone", "pagar me", "cielo", "rede adquir"]],
    ["REPASSE_PLATAFORMA", ["ifood"]],
    ["PIX", ["pix"]],
    ["TRANSFERENCIA", ["ted", "transf", "doc "]],
  ]);
  if (c === "PIX") return sentido === "ENTRADA" ? "PIX_RECEBIDO" : "PIX_ENVIADO";
  return c ?? "OUTRO";
}

/** Valor com sinal: "-10,00", "10,00 D", "10,00-" ou coluna Tipo = D → saída. Devolve o texto sem sinal e o sentido. */
function valorComSentido(u) {
  let texto = u.bruto("valor").replace(/\s+/g, " ").trim();
  let sentido = null;
  const sufixo = /\s?([CD])$/i.exec(texto);
  if (sufixo) { sentido = sufixo[1].toUpperCase() === "D" ? "SAIDA" : "ENTRADA"; texto = texto.slice(0, sufixo.index).trim(); }
  if (texto.endsWith("-")) { texto = texto.slice(0, -1).trim(); sentido = "SAIDA"; }
  if (texto.startsWith("-")) { texto = texto.slice(1).trim(); sentido = "SAIDA"; }
  const tipo = rotulo(u.bruto("tipo"));
  if (!sentido && tipo) sentido = /^(d|debito|saida)$/.test(tipo) ? "SAIDA" : /^(c|credito|entrada)$/.test(tipo) ? "ENTRADA" : null;
  return { texto, sentido: sentido ?? "ENTRADA" };
}

export const UNICRED_EXTRATO = definirFonte({
  fonte: "UNICRED",
  tipoRelatorio: "UNICRED_EXTRATO",
  tipoDocumento: "EXTRATO_BANCARIO",
  descricao: "extrato da conta Unicred",
  colunas: {
    data: col(["Data", "Data do movimento", "Data lançamento"]),
    historico: col(["Histórico", "Descrição", "Lançamento"]),
    documento: col(["Documento", "Nº documento", "Nr. documento"], false),
    valor: col(["Valor", "Valor (R$)"]),
    tipo: col(["Tipo", "C/D", "D/C"], false),
    saldo: col(["Saldo", "Saldo (R$)"], false),
  },
  // Linhas de saldo (anterior/final) não são movimento: viram controle.
  ehTotal: (u) => /^saldo/.test(rotulo(u.bruto("historico"))),
  lerTotal(u) {
    const h = rotulo(u.bruto("historico"));
    const campo = u.bruto("saldo") ? "saldo" : "valor";
    const valor = u.valor(campo);
    if (valor === null) return null;
    if (/anterior|inicial/.test(h)) return { tipo: "SALDO_INICIAL", valorCentavos: valor };
    if (/final|atual/.test(h)) return { tipo: "SALDO_FINAL", valorCentavos: valor };
    return null;
  },
  converter(u) {
    const data = u.data("data");
    const historico = u.texto("historico");
    const saldo = u.valor("saldo", { opcional: true });
    const { texto, sentido } = valorComSentido(u);
    let valor = null;
    if (!texto) u.erro(ERRO.CAMPO_OBRIGATORIO, "Campo obrigatório vazio: valor.", "valor");
    else {
      try {
        valor = centavos(texto, "valor");
      } catch (e) {
        u.erro(ERRO.VALOR_INVALIDO, e.message, "valor");
      }
    }
    if (u.erros.length) return null;
    return {
      tipoRegistro: "LANCAMENTO_BANCARIO", idExterno: null, data, valorCentavos: valor,
      dados: {
        sentido, historico, documento: u.bruto("documento") || null, saldoAposCentavos: saldo, categoriaSugerida: categoriaBancaria(historico, sentido),
        classificacaoConfirmada: false,
      },
      identidade: { data, historico: rotulo(historico), documento: u.bruto("documento"), valor, sentido, saldo },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    let entradas = 0;
    let saidas = 0;
    const inicial = declarados.find((d) => d.tipo === "SALDO_INICIAL")?.valorCentavos ?? null;
    let corrente = inicial;
    for (const r of registros) {
      const sinal = r.dados.sentido === "SAIDA" ? -r.valorCentavos : r.valorCentavos;
      if (r.dados.sentido === "SAIDA") saidas = somar(saidas, r.valorCentavos); else entradas = somar(entradas, r.valorCentavos);
      if (corrente !== null) corrente = somar(corrente, sinal);
      if (corrente !== null && r.dados.saldoAposCentavos !== null && r.dados.saldoAposCentavos !== corrente) {
        divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, "O saldo após o lançamento não encadeia com o saldo anterior.", corrente, r.dados.saldoAposCentavos, { linha: r.linha }));
        corrente = r.dados.saldoAposCentavos;
      }
    }
    const ultimoSaldo = [...registros].reverse().find((r) => r.dados.saldoAposCentavos !== null)?.dados.saldoAposCentavos ?? null;
    const final = declarados.find((d) => d.tipo === "SALDO_FINAL")?.valorCentavos ?? ultimoSaldo;
    if (inicial === null) divergencias.push({ codigo: DIVERGENCIA.SALDO_NAO_FECHA, mensagem: "O extrato não informa o saldo inicial: a consistência não pode ser comprovada." });
    if (final === null) divergencias.push({ codigo: DIVERGENCIA.SALDO_NAO_FECHA, mensagem: "O extrato não informa o saldo final: a consistência não pode ser comprovada." });
    const calculado = inicial === null ? null : subtrair(somar(inicial, entradas), saidas);
    if (calculado !== null && final !== null && calculado !== final) {
      divergencias.push(diferenca(DIVERGENCIA.SALDO_NAO_FECHA, "Saldo inicial + entradas − saídas não é igual ao saldo final.", final, calculado));
    }
    return {
      controles: {
        saldoInicialCentavos: inicial, entradasCentavos: entradas, saidasCentavos: saidas, saldoFinalCentavos: final, saldoCalculadoCentavos: calculado,
        saldoFecha: calculado !== null && final !== null && calculado === final,
        observacao: "Fechar o saldo comprova só a consistência aritmética do extrato, não a classificação dos movimentos.",
      },
      divergencias,
    };
  },
});

export const FONTES_UNICRED = Object.freeze([UNICRED_EXTRATO]);
