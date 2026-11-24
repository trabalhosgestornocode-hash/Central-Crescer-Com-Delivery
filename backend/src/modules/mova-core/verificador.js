// MOVA CORE — F1: VERIFICADOR DE FIDELIDADE. Antes de qualquer resposta sair, cada VALOR em reais citado é conferido contra os
// FATOS que as ferramentas devolveram nesta requisição — e não só o número: a relação valor × ENTIDADE × PERÍODO × UNIDADE ×
// SIGNIFICADO financeiro (um valor certo atribuído ao fornecedor errado, ao mês errado, à unidade errada, ou "pago" no lugar de
// "em aberto", é reprovado). Também reprova resposta que afirma ter registrado algo (nenhuma escrita existe nesta fase).
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const DINHEIRO = /(?:R\$\s?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?))|(?:\b(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s+reais\b)/gi;
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Classes de significado reconhecidas no texto → significados de fato compatíveis. */
const CLASSES = [
  { nome: "EM_ABERTO", termos: /\b(devemos|deve|devendo|em aberto|a pagar|falta pagar|pendente de pagamento|divida)\b/, aceita: (s) => /^(A_PAGAR|ENTREGADOR_A_PAGAR|RESUMO:.*pagar)/i.test(s) },
  { nome: "VENCIDO", termos: /\bvencid[oa]s?\b|\batrasad[oa]s?\b/, aceita: (s) => /^(A_PAGAR_VENCIDO|A_PAGAR|RESUMO:.*venc|A_RECEBER)/i.test(s) },
  { nome: "PAGO", termos: /\b(pago|pagos|paga|pagas|pagamos|paguei|foi pago|ja pago)\b/, aceita: (s) => /^(PAGO|ENTREGADOR_PAGO|INFORMADO_PELA_PESSOA|RESUMO:.*pag|DRE:)/i.test(s) },
  { nome: "VENDAS", termos: /\b(faturamento|faturou|faturamos|vendemos|vendas|vendeu)\b/, aceita: (s) => /^(VENDAS:|DRE:|RESUMO:.*(fatur|venda|receita))/i.test(s) },
  { nome: "SALDO", termos: /\bsaldo\b/, aceita: (s) => /^(SALDO_|DIFERENCA_DE_SALDO|RESUMO:.*saldo|A_PAGAR|A_RECEBER|FLUXO:)/i.test(s) },
  { nome: "RECEBER", termos: /\b(a receber|receberemos|repasse)\b/, aceita: (s) => /^(A_RECEBER|RECEBIDO|RESUMO:.*receb)/i.test(s) },
];
const ESCRITA_AFIRMADA = /\b(registrei|lancei|anotei|baixei|dei baixa|foi registrad[oa]|ficou registrad[oa]|registrad[oa] com sucesso|ja (esta|foi) lancad[oa]|lancamento feito)\b/;

export function valoresDoTexto(texto) {
  const r = [];
  for (const m of texto.matchAll(DINHEIRO)) {
    const bruto = m[1] ?? (m[2] + (m[3] ? `,${m[3]}` : ""));
    const [inteiro, centavos] = bruto.replace(/\./g, "").split(",");
    const comCentavos = centavos !== undefined;
    const v = Number(inteiro) * 100 + (comCentavos ? Number(centavos.padEnd(2, "0")) * Math.sign(Number(inteiro) || 1) : 0);
    if (Number.isFinite(v)) r.push({ valorCentavos: Math.abs(v), comCentavos, inicio: m.index, fim: m.index + m[0].length, texto: m[0] });
  }
  return r;
}

const escapar = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const casaValor =(f, v) => f.valorCentavos !== null && (Math.abs(f.valorCentavos) === v.valorCentavos || (!v.comCentavos && Math.round(Math.abs(f.valorCentavos) / 100) * 100 === v.valorCentavos));
const contem = (seg, nome) => { const n = norm(nome).trim(); if (n.length < 3) return false; return n.split(/\s+/).filter((w) => w.length >= 3).every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(seg)); };
function mesesNoTexto(seg) {
  const ms = [];
  MESES.forEach((m, i) => { if (new RegExp(`\\b${m}\\b`).test(seg)) ms.push(i + 1); });
  for (const m of seg.matchAll(/\b(\d{1,2})\/(\d{4})\b/g)) ms.push(Number(m[1]));
  return ms;
}
const mesDoPeriodo = (p) => { const m = /^(\d{4})-(\d{2})/.exec(String(p ?? "")); return m ? Number(m[2]) : null; };

/**
 * @param {string} resposta texto final
 * @param {object} ctx { fatos:[{valorCentavos, significado, entidade, periodo, unidade, derivado?}], unidades:[nomes], houvePreparacao:boolean }
 * @returns {{ok:boolean, violacoes:Array<{tipo:string, valor?:string, detalhe?:string}>, valores:number}}
 */
export function verificarFidelidade(resposta, { fatos = [], unidades = [] } = {}) {
  const texto = String(resposta ?? "");
  const n = norm(texto);
  const violacoes = [];
  const valores = valoresDoTexto(texto);
  const monetarios = fatos.filter((f) => Number.isInteger(f.valorCentavos));
  const entidadesConhecidas = [...new Set(monetarios.map((f) => f.entidade).filter((e) => e && String(e).length >= 3))];

  valores.forEach((v, i) => {
    const candidatos = monetarios.filter((f) => casaValor(f, v));
    if (!candidatos.length) { violacoes.push({ tipo: "VALOR_SEM_FONTE", valor: v.texto }); return; }
    // segmento: do valor anterior até o próximo (a "frase" que descreve ESTE valor)
    const ini = i > 0 ? valores[i - 1].fim : Math.max(0, texto.lastIndexOf("\n", v.inicio));
    const fim = i < valores.length - 1 ? valores[i + 1].inicio : texto.length;
    const seg = norm(texto.slice(ini, fim));
    if (candidatos.some((f) => f.derivado || f.significado === "INFORMADO_PELA_PESSOA")) return; // cálculo do próprio código / valor que a pessoa disse

    const unidadesCitadas = unidades.filter((u) => contem(seg, u));
    if (unidadesCitadas.length && !candidatos.some((f) => !f.unidade || unidadesCitadas.some((u) => norm(u) === norm(f.unidade)))) violacoes.push({ tipo: "UNIDADE_TROCADA", valor: v.texto, detalhe: unidadesCitadas.join(",") });

    // a entidade que descreve ESTE valor é a citada MAIS PERTO dele dentro do segmento (evita "X no caixa… e no banco Y")
    const posValor = v.inicio - ini;
    const distancia = (e) => { const w = norm(e).split(/\s+/).find((x) => x.length >= 3) ?? ""; let melhor = Infinity; for (const m of seg.matchAll(new RegExp(`\\b${escapar(w)}`, "g"))) melhor = Math.min(melhor, Math.abs(m.index - posValor)); return melhor; };
    const citadas = entidadesConhecidas.filter((e) => contem(seg, e)).map((e) => [e, distancia(e)]).sort((a, b) => a[1] - b[1]);
    const entidadesCitadas = citadas.length ? citadas.filter(([, d]) => d === citadas[0][1]).map(([e]) => e) : [];
    if (entidadesCitadas.length && candidatos.every((f) => f.entidade) && !candidatos.some((f) => entidadesCitadas.some((e) => norm(e) === norm(f.entidade) || contem(norm(f.entidade), e) || contem(norm(e), f.entidade)))) {
      violacoes.push({ tipo: "ENTIDADE_TROCADA", valor: v.texto, detalhe: entidadesCitadas.join(",") });
    }

    const meses = mesesNoTexto(seg);
    const mesesFatos = candidatos.map((f) => mesDoPeriodo(f.periodo));
    if (meses.length && mesesFatos.every((m) => m !== null) && !mesesFatos.some((m) => meses.includes(m))) violacoes.push({ tipo: "PERIODO_TROCADO", valor: v.texto, detalhe: meses.join(",") });

    const classes = CLASSES.filter((c) => c.termos.test(seg));
    // a classe mais próxima do valor decide (o texto antes do número costuma nomear o que ele é)
    if (classes.length && !classes.some((c) => candidatos.some((f) => c.aceita(f.significado)))) violacoes.push({ tipo: "SIGNIFICADO_TROCADO", valor: v.texto, detalhe: classes.map((c) => c.nome).join(",") });
  });

  // afirmação de escrita: só vale se NÃO vier negada ("não registrei", "nada foi registrado")
  for (const m of n.matchAll(new RegExp(ESCRITA_AFIRMADA.source, "g"))) {
    const antes = n.slice(Math.max(0, m.index - 25), m.index);
    if (!/\b(nao|nada|nenhum|ainda nao|sem)\b[^.]*$/.test(antes)) violacoes.push({ tipo: "ESCRITA_SIMULADA", detalhe: m[0] });
  }
  return { ok: violacoes.length === 0, violacoes, valores: valores.length };
}
