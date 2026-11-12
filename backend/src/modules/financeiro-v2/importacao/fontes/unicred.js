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
    ["TARIFA", ["tarifa", "cesta de servic", "taxa de manut", "conta pj"]],
    ["SEGURO", ["seguro"]],
    ["EMPRESTIMO", ["emprestimo", "financiamento", "parcela de credito", "capital de giro"]],
    ["PAGAMENTO_BOLETO", ["boleto", "pagto titulo", "pagamento de titulo", "liquidacao de titulo"]],
    ["ARRECADACAO_CONVENIO", ["arrecadacao", "convenio"]],
    ["CREDITO_ADQUIRENTE", ["stone", "pagar me", "cielo", "rede adquir"]],
    ["PLATAFORMA", ["ifood"]],
    ["PIX", ["pix"]],
    ["TRANSFERENCIA", [/\bted\b/, "transf", /\bdoc\b(?!\s*[.:])/]],
  ]);
  if (c === "PIX") return sentido === "ENTRADA" ? "PIX_RECEBIDO" : "PIX_ENVIADO";
  // iFood só é "repasse" quando o dinheiro ENTRA; saída para o iFood é pagamento (mensalidade, anúncio...).
  if (c === "PLATAFORMA") return sentido === "ENTRADA" ? "REPASSE_PLATAFORMA" : "PAGAMENTO_PLATAFORMA";
  // Crédito de adquirente só se ENTRA; o nome sozinho não prova que é repasse da Stone (pode ser crédito da própria empresa).
  if (c === "CREDITO_ADQUIRENTE" && sentido !== "ENTRADA") return "OUTRO";
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
  if (ehLayoutUnicred(documento)) return tabelaDoPdfUnicred(documento, periodo);
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

// ------------------------------------------------------------------------------------------- layout REAL do PDF Unicred
// Conferido com o extrato de setembro/2026 (layout "Data | Lançamentos | Valor (R$) | Saldo (R$)"):
//   - movimentação em TRÊS partes: início da descrição ("TIPO ( Doc.: N / ...") ANTES da linha "dd/mm/aaaa [-] R$ v R$ s",
//     e o fim da descrição DEPOIS dela, até fechar o parêntese; ou numa linha só ("dd/mm/aaaa TIPO ( Doc.: N ) - R$ v R$ s");
//   - "-" antes de "R$" = débito; o saldo após cada movimentação vem na própria linha;
//   - cabeçalho: "Período de A a B", "Saldo atual" (posição na EMISSÃO), "Saldo em dd/mm/aaaa:" (saldo na data — antes do
//     período = saldo inicial); rodapé: "Saldo no final do período" (saldo final), "Saldo atual", bloqueios, lançamentos futuros.
const R$ = String.raw`R\$\s*(-?\s*[\d.]+,\d{2})`;
// Descrição curta (preguiçosa) ANTES do sinal: assim o "-" de débito nunca é engolido como texto.
const LINHA_VALORES = new RegExp(String.raw`^(\d{2}/\d{2}/\d{4})\s+(.*?)\s*(-)?\s*${R$}\s+${R$}$`);
const CABECALHO_TABELA = /^Data\s+Lan[cç]amentos\s+Valor\s*\(R\$\)\s+Saldo\s*\(R\$\)$/i;
const RODAPE = /^(CENTRAL DE RELACIONAMENTO|\d{4} \d{3} \d{4} - No exterior)/i;
const saldoNaData = /^Saldo em (\d{2}\/\d{2}\/\d{4}):?\s+R\$\s*(-?[\d.]+,\d{2})$/i;
const ddmmaaaa = (t) => `${t.slice(6, 10)}-${t.slice(3, 5)}-${t.slice(0, 2)}`;
const saldoDe = (t) => t.replace(/\s+/g, "");
const balanco = (s) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;

export function ehLayoutUnicred(documento) {
  return documento.paginas.some((p) => p.linhas.some((l) => CABECALHO_TABELA.test(l)));
}

export function tabelaDoPdfUnicred(documento, periodo) {
  const linhas = [CABECALHO];
  const avisos = [];
  let pre = [];
  let aberto = null;
  let naTabela = false;
  let terminou = false;
  let periodoDoc = null;
  const fechar = (mov) => { linhas.push(mov.linha); };
  for (const pagina of documento.paginas) {
    naTabela = false;
    for (const texto of pagina.linhas) {
      const t = texto.trim();
      const per = /^Per[ií]odo de (\d{2}\/\d{2}\/\d{4}) a (\d{2}\/\d{2}\/\d{4})$/i.exec(t);
      if (per) { periodoDoc = { inicio: ddmmaaaa(per[1]), fim: ddmmaaaa(per[2]) }; continue; }
      const sd = saldoNaData.exec(t);
      if (sd) {
        const data = ddmmaaaa(sd[1]);
        const tipo = data < periodo.inicio ? "SALDO ANTERIOR" : data === periodo.fim ? "SALDO FINAL" : "SALDO NA DATA";
        linhas.push([data, tipo, "", "", saldoDe(sd[2]), "", String(pagina.numero)]);
        continue;
      }
      if (/^Saldo no final do per[ií]odo\s+R\$/i.test(t)) {
        linhas.push([periodo.fim, "SALDO FINAL", "", "", saldoDe(/R\$\s*(-?[\d.]+,\d{2})/.exec(t)[1]), "", String(pagina.numero)]);
        terminou = true;
        continue;
      }
      if (/^Saldo atual\s+R\$/i.test(t)) {
        linhas.push(["", "SALDO ATUAL", "", "", saldoDe(/R\$\s*(-?[\d.]+,\d{2})/.exec(t)[1]), "", String(pagina.numero)]);
        continue;
      }
      if (CABECALHO_TABELA.test(t)) { naTabela = true; pre = []; continue; }
      if (RODAPE.test(t) || !naTabela || terminou) continue;
      if (aberto) {
        aberto.linha[1] = `${aberto.linha[1]} ${t}`;
        aberto.saldoParenteses += balanco(t);
        if (aberto.saldoParenteses <= 0) { fechar(aberto); aberto = null; }
        continue;
      }
      const v = LINHA_VALORES.exec(t);
      if (v) {
        const descricao = [...pre, v[2] ?? ""].join(" ").replace(/\s+/g, " ").trim();
        pre = [];
        const documentoRef = /Doc\.:\s*([^\s)/]+)/.exec(descricao)?.[1] ?? "";
        const mov = { linha: [ddmmaaaa(v[1]), descricao, documentoRef, `${v[3] ? "-" : ""}${saldoDe(v[4]).replace(/^-/, "")}`, saldoDe(v[5]), "", String(pagina.numero)], saldoParenteses: balanco(descricao) };
        if (mov.saldoParenteses > 0) aberto = mov; else fechar(mov);
        continue;
      }
      pre.push(t);
    }
  }
  if (aberto) { fechar(aberto); avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: "Última movimentação sem fechamento da descrição.", linha: null }); }
  if (pre.length) avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: `${pre.length} linha(s) da tabela sem valor associado.`, linha: null });
  if (!periodoDoc) avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: "O extrato não declara o período.", linha: null });
  else if (periodoDoc.inicio !== periodo.inicio || periodoDoc.fim !== periodo.fim) {
    avisos.push({ codigo: "PERIODO_DIVERGENTE", mensagem: `O extrato declara ${periodoDoc.inicio} a ${periodoDoc.fim}; a importação declarou ${periodo.inicio} a ${periodo.fim}.`, linha: null });
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
  formatosHomologados: ["pdf"],
  tabelaDoPdf,
  tabelaDoOfx,
  // Linhas de saldo (anterior/final) não são movimento: viram controle.
  ehTotal: (u) => /^saldo/.test(rotulo(u.bruto("historico"))),
  lerTotal(u) {
    const h = rotulo(u.bruto("historico"));
    const campo = u.bruto("saldo") ? "saldo" : "valor";
    const valor = u.valor(campo);
    if (valor === null) return null;
    if (/na data/.test(h)) return null;
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
