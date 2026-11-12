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

// ------------------------------------------------------------------------------------------- PDF e OFX → tabela
const CABECALHO = ["Data", "Histórico", "Documento", "Valor", "Saldo", "Identificador", "Página"];
const VALOR = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}(?:\s?[CD]\b|-)?`;
const FIM_COM_VALORES = new RegExp(String.raw`^(.*?)\s+(${VALOR})(?:\s+(${VALOR}))?$`);
const RUIDO = /^(p[aá]g(ina)?\.?\s*\d|data\s|hist[oó]rico|extrato|cooperativ|ag[eê]ncia|conta\s|per[ií]odo|cnpj|cpf|lan[cç]amentos|valor\s|saldo\s*\(|total\b|emitido|ouvidoria|sac\b)/i;

function dataComAno(ddmm, periodo) {
  const [d, m, a] = ddmm.split("/");
  const ano = a ? (a.length === 2 ? `20${a}` : a) : periodo.inicio.slice(0, 4);
  return `${ano}-${m}-${d}`;
}

/**
 * Linhas de texto do PDF → tabela do extrato. Layout esperado (a confirmar com a amostra real): data no início da linha,
 * descrição, valor e (opcional) saldo no fim. Descrição quebrada em várias linhas é juntada à movimentação anterior;
 * linha de valores sem data herda a data anterior; o que não se encaixa vira aviso (nunca é descartado em silêncio).
 */
export function tabelaDoPdf(documento, periodo) {
  const linhas = [CABECALHO];
  const avisos = [];
  let ultima = null;
  let pendente = null;
  let ultimaData = null;
  for (const pagina of documento.paginas) {
    for (const texto of pagina.linhas) {
      const h = rotulo(texto);
      const comData = /^(\d{2}\/\d{2}(?:\/\d{2,4})?)\s+(.*)$/.exec(texto);
      const resto = comData ? comData[2] : texto;
      const valores = FIM_COM_VALORES.exec(resto);
      if (/^saldo/.test(rotulo(resto)) || /^saldo/.test(h)) {
        if (valores) linhas.push([comData ? dataComAno(comData[1], periodo) : periodo.inicio, valores[1].trim(), "", "", (valores[3] ?? valores[2]).trim(), "", String(pagina.numero)]);
        ultima = null;
        continue;
      }
      if (comData) ultimaData = dataComAno(comData[1], periodo);
      if (valores && (comData || ultimaData)) {
        const descricao = [pendente?.descricao, valores[1].trim()].filter(Boolean).join(" ");
        ultima = [comData ? ultimaData : (pendente?.data ?? ultimaData), descricao, "", valores[2].trim(), (valores[3] ?? "").trim(), "", String(pagina.numero)];
        linhas.push(ultima);
        pendente = null;
        continue;
      }
      if (comData && !valores) { pendente = { data: ultimaData, descricao: resto.trim() }; ultima = null; continue; }
      if (RUIDO.test(texto)) continue;
      if (ultima) { ultima[1] = `${ultima[1]} ${texto.trim()}`; continue; }
      if (pendente) { pendente.descricao = `${pendente.descricao} ${texto.trim()}`; continue; }
      avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: `Página ${pagina.numero}: linha não interpretada.`, linha: null });
    }
  }
  if (pendente) avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: "Movimentação sem valor ao fim do documento.", linha: null });
  const declaradas = documento.paginas.flatMap((p) => p.linhas).map((l) => /p[aá]gina\s+\d+\s+de\s+(\d+)/i.exec(l)?.[1]).find(Boolean);
  if (declaradas && Number(declaradas) !== documento.paginas.length) {
    avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: `O rodapé indica ${declaradas} página(s), o arquivo tem ${documento.paginas.length}.`, linha: null });
  }
  return { linhas, avisos };
}

/** OFX → tabela do extrato. O saldo do OFX só vira saldo FINAL se for da data de fim do período. */
export function tabelaDoOfx(ofx, periodo) {
  const linhas = [CABECALHO];
  for (const t of ofx.transacoes) {
    linhas.push([t.data ?? "", [t.nome, t.memo].filter(Boolean).join(" — ") || (t.tipo ?? ""), t.documento ?? "", t.valor ?? "", "", t.fitid ?? "", ""]);
  }
  if (ofx.saldo?.valor) {
    const fim = ofx.fim ?? periodo.fim;
    linhas.push([ofx.saldo.em ?? "", ofx.saldo.em === fim ? "SALDO FINAL" : "SALDO ATUAL", "", "", ofx.saldo.valor, "", ""]);
  }
  return { linhas, avisos: [] };
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
    identificador: col(["Identificador", "FITID", "ID da transação"], false),
    pagina: col(["Página"], false),
  },
  formatos: Object.freeze(["csv", "xlsx", "pdf", "ofx"]),
  tabelaDoPdf,
  tabelaDoOfx,
  // Linhas de saldo (anterior/final) não são movimento: viram controle.
  ehTotal: (u) => /^saldo/.test(rotulo(u.bruto("historico"))),
  lerTotal(u) {
    const h = rotulo(u.bruto("historico"));
    const campo = u.bruto("saldo") ? "saldo" : "valor";
    const valor = u.valor(campo);
    if (valor === null) return null;
    if (/anterior|inicial/.test(h)) return { tipo: "SALDO_INICIAL", valorCentavos: valor };
    // "Saldo atual/disponível" é a posição NA DATA DE EMISSÃO (pode ser posterior ao período): nunca substitui o final.
    if (/atual|disponivel/.test(h)) return { tipo: "SALDO_ATUAL", valorCentavos: valor };
    if (/final|do periodo/.test(h)) return { tipo: "SALDO_FINAL", valorCentavos: valor };
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
      tipoRegistro: "LANCAMENTO_BANCARIO", idExterno: u.bruto("identificador") || null, data, valorCentavos: valor,
      dados: {
        sentido, historico, documento: u.bruto("documento") || null, saldoAposCentavos: saldo, categoriaSugerida: categoriaBancaria(historico, sentido),
        classificacaoConfirmada: false, pagina: u.bruto("pagina") ? Number(u.bruto("pagina")) : null,
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
        saldoAtualCentavos: declarados.find((d) => d.tipo === "SALDO_ATUAL")?.valorCentavos ?? null,
        observacao: "Fechar o saldo comprova só a consistência aritmética do extrato, não a classificação dos movimentos.",
      },
      divergencias,
    };
  },
});

export const FONTES_UNICRED = Object.freeze([UNICRED_EXTRATO]);
