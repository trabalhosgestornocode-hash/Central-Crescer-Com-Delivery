// MOVA CORE — F1: VERIFICADOR DE FIDELIDADE. Antes de qualquer resposta sair, cada VALOR em reais citado é conferido contra os
// FATOS que as ferramentas devolveram nesta requisição — e não só o número: a relação valor × ENTIDADE × PERÍODO × UNIDADE ×
// SIGNIFICADO financeiro (um valor certo atribuído ao fornecedor errado, ao mês errado, à unidade errada, ou "pago" no lugar de
// "em aberto", é reprovado). Também reprova resposta que afirma ter registrado algo (nenhuma escrita existe nesta fase).
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const DINHEIRO = /(?:R\$\s?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?))|(?:\b(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s+reais\b)/gi;
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Classes de significado reconhecidas no texto → significados de fato compatíveis. */
const CLASSES = [
  { nome: "EM_ABERTO", termos: /\b(devemos|deve|devendo|(?<!contas )a pagar|falta pagar|faltam pagar|pendente de pagamento|divida|restantes?|(ainda )?(nao|sem) (foi )?(pago|paga|pagos|pagas|pagamento)|(nada|nenhuma?) (foi )?(pago|paga))\b/, aceita: (s) => /^(A_PAGAR|ENTREGADOR_A_PAGAR|RESUMO:.*pagar)/i.test(s) },
  // "em aberto" sozinho vale para pagar E receber ("total em aberto: R$ 27.900" de contas a receber); "devemos" continua só pagar
  { nome: "ABERTO", termos: /\b(em aberto|pendentes?|saldo a receber)\b/, aceita: (s) => /^(A_PAGAR|ENTREGADOR_A_PAGAR|A_RECEBER|RESUMO:.*(pagar|receb))/i.test(s) },
  { nome: "VENCIDO", termos: /\bvencid[oa]s?\b|\batrasad[oa]s?\b/, aceita: (s) => /^(A_PAGAR_VENCIDO|A_PAGAR|RESUMO:.*venc|A_RECEBER)/i.test(s) },
  { nome: "PAGO", termos: /(?<!\b(nao|sem|nada|nenhuma?) (foi )?)\b(pago|pagos|paga|pagas|pagamos|paguei|pagou|pagaram|ja pago)\b/, aceita: (s) => /^(PAGO|ENTREGADOR_PAGO|INFORMADO_PELA_PESSOA|RESUMO:.*pag|DRE:)/i.test(s) },
  { nome: "VENDAS", termos: /\b(faturamento|faturou|faturamos|vendemos|vendas|vendeu)\b/, aceita: (s) => /^(VENDAS:|DRE:|RESUMO:.*(fatur|venda|receita))/i.test(s) },
  { nome: "SALDO", termos: /\b(saldo|informado|contado)\b/, aceita: (s) => /^(SALDO_|DIFERENCA_DE_SALDO|RESUMO:.*saldo|A_PAGAR|A_RECEBER|FLUXO:)/i.test(s) },
  { nome: "RECEBER", termos: /\b(a receber|receberemos|repasse)\b/, aceita: (s) => /^(A_RECEBER|RECEBIDO|RESUMO:.*receb|ENTREGADOR_A_PAGAR)/i.test(s) }, // "o entregador tem R$ 99 a receber" = o que a loja deve a ele
  // avaliação real 24/11: "vencida em 22/11, valor de R$ 264,00, com R$ 100,00 já pagos" — o valor TOTAL da conta
  // F2: "médio/média/por entrega" só com resultado de DIVISÃO/MÉDIA calculada pelo código (um total dito como média é troca de natureza)
  { nome: "MEDIA", termos: /\b(media|medio|em media|por entrega|por pedido|cada entrega|ticket)\b/, aceita: (s) => /^(CALCULO:(MEDIA|DIVISAO)|.*TICKET|.*MEDI[OA])/i.test(s) },
  // F2: sangria/retirada de caixa só com movimento de caixa (não com despesa nem pagamento a fornecedor)
  { nome: "MOVIMENTO_DE_CAIXA", termos: /\b(sangrias?|retiradas? de caixa|reforcos?( de caixa)?|suprimentos? de caixa)\b/, aceita: (s) => /^(SANGRIA|RETIRADA|REFORCO|MOVIMENTO|CAIXA|SALDO_|FLUXO:|INFORMADO_PELA_PESSOA)/i.test(s) },
  { nome: "VALOR_DA_CONTA", termos: /\b(valor(?! (informado|calculado|contado))( original| total| da conta)?|total da conta|contas a pagar|somou|somaram)\b/, aceita: (s) => /^(VALOR_DAS_CONTAS|A_PAGAR|PAGO|ENTREGADOR_|A_RECEBER|RECEBIDO|VENDAS:|DRE:|RESUMO:|CALCULO:SOMA)/i.test(s) }, // "valor"/"somaram" são genéricos: só não aceitam saldo nem cálculo de outra natureza
];
const ESCRITA_AFIRMADA = /\b(registrei|lancei|anotei|baixei|dei baixa|(?<!\b(que|como|quanto) )foi registrad[oa]|ficou registrad[oa]|registrad[oa] com sucesso|ja (esta|foi) lancad[oa]|lancamento feito)\b/;

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

const FIM_DE_FRASE = /\n|[.!?;](?=\s)/g;
const AGREGADO = /^(todas|todos|bancos|total|consolidad)/i;
const FALA_DE_TOTAL = /\b(total|consolidad[oa]|somando|soma|ao todo|juntos?|(entre )?(bancos? e caixa|caixa e bancos?))\b/;
/** ")" sem "(" correspondente no trecho: o trecho atravessa o fim de um parêntese (o que está do outro lado é de outro valor). */
const fechaSemAbrir = (s) => { let d = 0; for (const ch of s) { if (ch === "(") d++; else if (ch === ")") { if (d === 0) return true; d--; } } return false; };
const raizDoNome = (w) => (w.length > 4 ? w.replace(/s$/, "") : w);
const escapar = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const casaValor =(f, v) => f.valorCentavos !== null && (Math.abs(f.valorCentavos) === v.valorCentavos || (!v.comCentavos && Math.round(Math.abs(f.valorCentavos) / 100) * 100 === v.valorCentavos));
// sufixos societários não precisam aparecer ("Doce Brownie" cita "Doce Brownie Ltda"); plural tolerado ("reforço" cita "reforços")
const SUFIXO_SOCIETARIO = new Set(["ltda", "eireli", "epp", "me", "s/a", "sa", "cia"]);
const contem = (seg, nome) => { const n = norm(nome).trim(); if (n.length < 3) return false; return n.split(/\s+/).filter((w) => w.length >= 3 && !SUFIXO_SOCIETARIO.has(w)).map(raizDoNome).every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(seg)); };
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
    // segmento: a FRASE/LINHA deste valor, entre o valor anterior e o próximo (avaliação real 24/11: em listas, o nome da linha
    // seguinte ficava "mais perto" e o valor era atribuído a ele)
    const limiteAntes = Math.max(0, ...[...texto.slice(0, v.inicio).matchAll(FIM_DE_FRASE)].map((m) => m.index + m[0].length));
    const depois = [...texto.slice(v.fim).matchAll(FIM_DE_FRASE)][0];
    const ini = Math.max(i > 0 ? valores[i - 1].fim : 0, limiteAntes);
    const fim = Math.min(i < valores.length - 1 ? valores[i + 1].inicio : texto.length, depois ? v.fim + depois.index : texto.length);
    const seg = norm(texto.slice(ini, fim));
    if (candidatos.some((f) => f.derivado || f.significado === "INFORMADO_PELA_PESSOA")) return; // cálculo do próprio código / valor que a pessoa disse

    const unidadesCitadas = unidades.filter((u) => contem(seg, u));
    if (unidadesCitadas.length && !candidatos.some((f) => !f.unidade || unidadesCitadas.some((u) => norm(u) === norm(f.unidade)))) violacoes.push({ tipo: "UNIDADE_TROCADA", valor: v.texto, detalhe: unidadesCitadas.join(",") });

    // a entidade que descreve ESTE valor é a citada MAIS PERTO dele dentro do segmento (evita "X no caixa… e no banco Y")
    const posValor = v.inicio - ini;
    const distancia = (e) => { const w = raizDoNome(norm(e).split(/\s+/).find((x) => x.length >= 3 && !SUFIXO_SOCIETARIO.has(x)) ?? ""); let melhor = Infinity; for (const m of seg.matchAll(new RegExp(`\\b${escapar(w)}`, "g"))) { const antes = m.index <= posValor; if (fechaSemAbrir(antes ? seg.slice(m.index, posValor) : seg.slice(v.fim - ini, m.index))) continue; melhor = Math.min(melhor, antes ? posValor - m.index : (m.index - posValor) * 3); } return melhor; }; // o nome ANTES do valor o descreve ("• Atacadão: R$ 540"); do outro lado de um ")" é de outro valor
    const citadas = entidadesConhecidas.filter((e) => contem(seg, e)).map((e) => [e, distancia(e)]).filter(([, d]) => d !== Infinity).sort((a, b) => a[1] - b[1]);
    const entidadesCitadas = citadas.length ? citadas.filter(([, d]) => d === citadas[0][1]).map(([e]) => e) : [];
    const agregadoComoTotal = candidatos.some((f) => !f.entidade || AGREGADO.test(norm(f.entidade))) && FALA_DE_TOTAL.test(seg);
    if (!agregadoComoTotal && entidadesCitadas.length && candidatos.every((f) => f.entidade) && !candidatos.some((f) => entidadesCitadas.some((e) => norm(e) === norm(f.entidade) || contem(norm(f.entidade), e) || contem(norm(e), f.entidade)))) {
      violacoes.push({ tipo: "ENTIDADE_TROCADA", valor: v.texto, detalhe: entidadesCitadas.join(",") });
    }

    const meses = mesesNoTexto(seg);
    const mesesFatos = candidatos.map((f) => mesDoPeriodo(f.periodo));
    if (meses.length && mesesFatos.every((m) => m !== null) && !mesesFatos.some((m) => meses.includes(m))) violacoes.push({ tipo: "PERIODO_TROCADO", valor: v.texto, detalhe: meses.join(",") });

    // a classe cujo termo está MAIS PERTO do valor decide (o texto antes do número nomeia o que ele é; depois pesa 3×):
    // "vencida em 22/11, valor de R$ 264" → VALOR_DA_CONTA; "valor vencido de R$ 264" → VENCIDO
    // avaliação real 2 (24/11): termo que FECHA o parêntese de outro valor ("(R$ 320,00, paga) e … (R$ 185,00") não descreve este;
    // "colado depois" só sem vírgula ("R$ 164,00 restantes"); com vírgula o termo pode ser do valor seguinte ("R$ 264,00, já pago R$ 100,00")
    const posFim = v.fim - ini;
    const pertoDe = (c) => { let melhor = Infinity; for (const m of seg.matchAll(new RegExp(c.termos.source, "g"))) { const p = m.index + m[0].length; if (/["“'‘]/.test(seg[m.index - 1] ?? "")) continue; /* termo entre aspas é CITADO, não afirmado */ if (p <= posValor) { if (fechaSemAbrir(seg.slice(p, posValor))) continue; if (i > 0 && ini === valores[i - 1].fim && m.index <= 3 && m.index < posValor - p) continue; /* colado ao valor ANTERIOR ("R$ 11,00 por entrega: R$ 99,00") */ if (i > 0 && ini === valores[i - 1].fim && /^\s*(e|,|;)\s*$/.test(seg.slice(p, posValor))) continue; /* fecha a oração do valor anterior ("R$ 320,00 já foram pagos e R$ 185,00 …") */ melhor = Math.min(melhor, posValor - p); } else { const vao = seg.slice(posFim, m.index); if (i < valores.length - 1 && fim === valores[i + 1].inicio && seg.length - p <= 3 && seg.length - p <= vao.length) continue; /* colado ao valor SEGUINTE ("R$ 320,00 e falta pagar R$ 185,00") */ melhor = Math.min(melhor, vao.length <= 3 && !/[,;(]/.test(vao) ? 0 : (m.index - posFim) * 3); } } return melhor; }; // colado DEPOIS ("R$ 185,00 a pagar") vale mais que tudo
    const operando = /^\s*(÷|dividid[oa]s? por|\/\s*\d)/.test(texto.slice(v.fim)); // "R$ 418,00 ÷ 38": o valor é operando de uma conta mostrada, não tem natureza própria
    const classes = operando ? [] : CLASSES.filter((c) => c.termos.test(seg)).map((c) => [c, pertoDe(c)]).filter(([, d]) => d !== Infinity).sort((a, b) => a[1] - b[1]);
    const decide = classes.length ? classes.filter(([, d]) => d === classes[0][1]).map(([c]) => c) : [];
    if (decide.length && !decide.some((c) => candidatos.some((f) => c.aceita(f.significado)))) violacoes.push({ tipo: "SIGNIFICADO_TROCADO", valor: v.texto, detalhe: decide.map((c) => c.nome).join(",") });
  });

  // afirmação de escrita: só vale se NÃO vier negada ("não registrei", "nada foi registrado")
  for (const m of n.matchAll(new RegExp(ESCRITA_AFIRMADA.source, "g"))) {
    const antes = n.slice(Math.max(0, m.index - 25), m.index);
    if (!/\b(nao|nada|nenhum|ainda nao|sem)\b[^.]*$/.test(antes)) violacoes.push({ tipo: "ESCRITA_SIMULADA", detalhe: m[0] });
  }
  return { ok: violacoes.length === 0, violacoes, valores: valores.length };
}

/**
 * F2 — RESPOSTA SEGURA QUE APROVEITA OS FATOS VÁLIDOS: das frases/linhas de um rascunho reprovado, mantém só as que não contêm
 * nenhum valor reprovado nem afirmação de escrita, e o que sobrar tem de passar inteiro no verificador. Nada sobra ⇒ null.
 */
export function aproveitarFatosValidos(texto, violacoes, ctx) {
  const ruins = new Set(violacoes.filter((v) => v.valor).map((v) => v.valor));
  const escrita = violacoes.some((v) => v.tipo === "ESCRITA_SIMULADA");
  const linhas = String(texto ?? "").split("\n");
  const mantidas = [];
  for (const linha of linhas) {
    const frases = linha.split(/(?<=[.!?])\s+/);
    const boas = frases.filter((f) => ![...ruins].some((r) => f.includes(r)) && !(escrita && ESCRITA_AFIRMADA.test(norm(f))));
    if (boas.length === frases.length || boas.some((f) => valoresDoTexto(f).length)) mantidas.push(boas.join(" "));
  }
  const resto = mantidas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (resto.length < 40) return null;
  if (!verificarFidelidade(resto, ctx).ok) return null;
  return `${resto}\n\n(Retirei uma parte que não consegui conferir com os dados. Se precisar dela, pergunte de novo de forma mais específica.)`;
}
