// MOVA CORE — F3: RESOLUÇÃO DE ENTIDADES E CONCEITOS (camada reutilizável; substitui o "contém a palavra" das ferramentas).
//
// Princípios:
//  - a entidade SEMPRE é validada nos registros oficiais: esta camada só COMPARA o termo da pessoa com nomes que vieram da
//    ferramenta (fornecedores, entregadores, categorias, canais); nunca cria nem presume entidade;
//  - a comparação é morfológica e tolerante, não uma lista de palavras: normalização (acentos, caixa, pontuação), redução leve
//    de flexão do português (plural, -ões/-ães, -ns, -is), erro de digitação (distância de edição proporcional ao tamanho),
//    abreviação (prefixo ≥ 4 letras), sufixo societário ignorado, e APELIDOS registrados no próprio cadastro (quando houver);
//  - com mais de um candidato plausível de ENTIDADES DIFERENTES, o resultado é AMBIGUO (quem chama pergunta ou usa contexto),
//    nunca "o primeiro";
//  - conceitos financeiros (entrada de caixa × reforço, retirada × despesa…) vêm de um GLOSSÁRIO versionado com origem e
//    escopo (dados, não código): a camada só aponta o conceito provável e as confusões a evitar; a decisão final continua
//    sendo das ferramentas oficiais e do verificador.

const SUFIXOS_SOCIETARIOS = new Set(["ltda", "eireli", "epp", "me", "sa", "s/a", "cia", "mei", "comercio", "com", "ind"]);
const VAZIAS = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "em", "no", "na", "nos", "nas", "com", "para", "por", "um", "uma"]);

export const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();

/** Redução LEVE de flexão (plural e algumas terminações). Não é dicionário: é morfologia regular do português. */
export function radical(palavra) {
  let w = normalizar(palavra);
  if (w.length <= 3 || /\d/.test(w)) return w;
  const regras = [[/oes$/, "ao"], [/aes$/, "ao"], [/aos$/, "ao"], [/ns$/, "m"], [/eis$/, "el"], [/ais$/, "al"], [/ois$/, "ol"], [/(?<=[^aeiou])is$/, "il"],
    [/res$/, "r"], [/zes$/, "z"], [/ses$/, "s"], [/ies$/, "ie"], [/s$/, ""]];
  for (const [re, sub] of regras) if (re.test(w)) { w = w.replace(re, sub); break; }
  // gênero/número regular no fim (fornecedora/fornecedor, paga/pago): só a vogal temática final de palavras longas
  if (w.length >= 6) w = w.replace(/[ao]$/, "");
  return w;
}

/** Distância de edição com transposição (Damerau-Levenshtein restrita), limitada a `teto` para ser barata. */
export function distancia(a, b, teto = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let minLinha = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      minLinha = Math.min(minLinha, d[i][j]);
    }
    if (minLinha > teto) return teto + 1;
  }
  return d[a.length][b.length];
}
const tolerancia = (n) => (n >= 9 ? 2 : n >= 5 ? 1 : 0);

const tokens = (s) => normalizar(s).split(" ").filter((w) => w.length >= 2 && !VAZIAS.has(w) && !SUFIXOS_SOCIETARIOS.has(w));

/**
 * Quão bem UMA palavra da pessoa combina com UMA palavra do cadastro: 1 exata · 0.95 mesmo radical · 0.85 prefixo/abreviação ·
 * 0.75 erro de digitação · 0 nada.
 */
function combinaPalavra(p, c) {
  if (p === c) return 1;
  const rp = radical(p); const rc = radical(c);
  if (rp === rc && rp.length >= 3) return 0.95;
  if (p.length >= 4 && (c.startsWith(p) || rc.startsWith(rp))) return 0.85; // abreviação: "atac" → "atacadão"
  if (c.length >= 5 && (p.startsWith(c) || rp.startsWith(rc))) return 0.85; // flexão verbal: "comprar"/"custou" → "compra"/"custo"
  const tol = tolerancia(Math.min(p.length, c.length));
  if (tol && distancia(rp, rc, tol) <= tol) return 0.75;
  return 0;
}

/**
 * Pontuação de um termo contra os textos de UM registro (nome, apelidos, descrição, categoria): todas as palavras do termo
 * precisam encontrar par (como antes), e a nota é a média dos melhores pares. 0 = não combina.
 */
export function pontuar(termo, ...textos) {
  const ps = tokens(termo);
  if (!ps.length) return 0;
  const cs = [...new Set(textos.flatMap((t) => (Array.isArray(t) ? t : [t])).flatMap(tokens))];
  if (!cs.length) return 0;
  let soma = 0;
  for (const p of ps) {
    const melhor = Math.max(0, ...cs.map((c) => combinaPalavra(p, c)));
    if (!melhor) return 0;
    soma += melhor;
  }
  return soma / ps.length;
}

/** Compatível com o antigo `bate`: o termo combina com algum dos textos? (agora morfológico e tolerante) */
export const combina = (termo, ...textos) => pontuar(termo, ...textos) > 0;

/**
 * Resolve um termo contra candidatos OFICIAIS (vindos da ferramenta).
 * @param {string} termo
 * @param {Array<{id?:string, nome:string, apelidos?:string[], tipo?:string, textos?:string[]}>} candidatos
 * @param {{preferidos?:string[]}} [contexto]  nomes já esclarecidos na conversa (decisões da memória) — desempatam
 * @returns {{estado:'UNICO'|'AMBIGUO'|'NENHUM', escolhido?:object, candidatos:Array<{nome, nota, id?}>}}
 */
export function resolverEntidade(termo, candidatos, { preferidos = [] } = {}) {
  const notas = candidatos.map((c) => ({ c, nota: pontuar(termo, c.nome, c.apelidos ?? [], c.textos ?? []) })).filter((x) => x.nota > 0)
    .sort((a, b) => b.nota - a.nota);
  // um mesmo registro (mesmo id ou mesmo nome) não conta duas vezes
  const unicos = []; const vistos = new Set();
  for (const x of notas) { const k = x.c.id ?? normalizar(x.c.nome); if (!vistos.has(k)) { vistos.add(k); unicos.push(x); } }
  const lista = unicos.map((x) => ({ nome: x.c.nome, nota: Number(x.nota.toFixed(2)), ...(x.c.id ? { id: x.c.id } : {}) }));
  if (!unicos.length) return { estado: "NENHUM", candidatos: [] };
  const exatos = unicos.filter((x) => normalizar(x.c.nome) === normalizar(termo) || (x.c.apelidos ?? []).some((a) => normalizar(a) === normalizar(termo)));
  if (exatos.length === 1) return { estado: "UNICO", escolhido: exatos[0].c, candidatos: lista };
  const pref = unicos.filter((x) => preferidos.some((p) => normalizar(p) === normalizar(x.c.nome)));
  if (pref.length === 1) return { estado: "UNICO", escolhido: pref[0].c, candidatos: lista, motivo: "ESCLARECIDO_NA_CONVERSA" };
  const topo = unicos[0].nota;
  const empatados = unicos.filter((x) => topo - x.nota < 0.1);
  if (empatados.length === 1) return { estado: "UNICO", escolhido: unicos[0].c, candidatos: lista };
  return { estado: "AMBIGUO", candidatos: lista.filter((x) => topo - x.nota < 0.1) };
}

// ------------------------------------------------------------------------------------------------------- conceitos
/**
 * GLOSSÁRIO BASE (versionado). Cada conceito diz a NATUREZA financeira, a(s) ferramenta(s) oficial(is) que o respondem e as
 * CONFUSÕES a evitar. É a semente do conhecimento corporativo (F5): origem e aprovação registradas; quando a base aprovada
 * existir, ela substitui/estende este conteúdo por organização (`criarResolvedorDeConceitos({ glossario })`).
 * As expressões são EXEMPLOS de como as pessoas falam, comparados pelo mesmo casamento morfológico — não uma lista fechada:
 * o modelo continua interpretando a pergunta; este bloco só lembra o que cada coisa É no sistema.
 */
export const GLOSSARIO_BASE = Object.freeze({
  versao: "2026-11-24.2",
  origem: "MOVA CORE F3 — regras do Financeiro 2.0 (docs/financeiro-2-0) e achados das avaliações reais",
  aprovadoPor: null, // pendente de aprovação do proprietário (F5)
  conceitos: Object.freeze([
    { id: "ENTRADA_DE_CAIXA", expressoes: ["entrou no caixa", "entrada de caixa", "entradas do caixa", "dinheiro que entrou", "quanto entrou"],
      natureza: "FLUXO_DE_CAIXA", ferramentas: ["fluxo_de_caixa", "movimentos_do_caixa_fisico", "vendas"],
      explicacao: "Tudo o que entrou: vendas em dinheiro/recebimentos E reforços. Reforço sozinho NÃO é a entrada do caixa.",
      confundirCom: ["REFORCO"] },
    { id: "REFORCO", expressoes: ["reforço", "suprimento", "troco colocado", "colocaram dinheiro no caixa"], natureza: "MOVIMENTO_DE_CAIXA", ferramentas: ["movimentos_do_caixa_fisico"],
      explicacao: "Dinheiro colocado no caixa físico (ex.: troco). Não é venda nem receita.", confundirCom: ["ENTRADA_DE_CAIXA", "RECEITA"] },
    { id: "RETIRADA_DE_CAIXA", expressoes: ["sangria", "retirada do caixa", "tirou do caixa", "retirada de dinheiro", "pegou dinheiro do caixa"], natureza: "MOVIMENTO_DE_CAIXA", ferramentas: ["movimentos_do_caixa_fisico"],
      explicacao: "Saída de dinheiro do caixa físico. Só vira DESPESA quando a destinação é confirmada (compra com comprovante); pode ser guarda ou transferência.", confundirCom: ["DESPESA"] },
    // avaliação real F3 (rodada 1): "despesas operacionais de novembro" foi respondida com a soma das contas da competência; é a
    // LINHA DA DRE (apuração gerencial), que tem metodologia própria. Expressão mais longa vence a mais curta (ver `conceitos`).
    { id: "LINHA_DO_RESULTADO", expressoes: ["despesas operacionais", "despesa operacional", "resultado operacional", "resultado do mês", "lucro", "prejuízo", "margem", "cmv", "custo da mercadoria vendida", "faturamento bruto", "dre"],
      natureza: "APURACAO", ferramentas: ["resultado_do_mes"],
      explicacao: "Linha da DRE gerencial da competência (apuração oficial). NÃO é a soma das contas a pagar do mês: use resultado_do_mes e cite a linha pelo nome.", confundirCom: ["DESPESA"] },
    { id: "DESPESA", expressoes: ["despesa", "gasto", "gastamos", "custo", "compra", "aquisição", "comprou"], natureza: "OBRIGACAO", ferramentas: ["contas_a_pagar", "analisar"],
      explicacao: "Obrigação reconhecida pela COMPETÊNCIA (o que se gastou no mês), paga ou não. Não é o mesmo que o pagamento.", confundirCom: ["PAGAMENTO", "RETIRADA_DE_CAIXA"] },
    { id: "PAGAMENTO", expressoes: ["pagamento", "pagamos", "pago", "quitado", "liquidação", "baixa"], natureza: "PAGAMENTO", ferramentas: ["contas_a_pagar", "analisar"],
      explicacao: "Liquidação de uma obrigação, pela DATA DO PAGAMENTO. Uma despesa de outubro pode ser paga em novembro.", confundirCom: ["DESPESA"] },
    { id: "SALDO_EM_ABERTO", expressoes: ["em aberto", "falta pagar", "pendente", "devemos", "a pagar"], natureza: "OBRIGACAO", ferramentas: ["contas_a_pagar"],
      explicacao: "O que ainda falta pagar (saldo). O VALOR TOTAL da conta pode ser maior se houve pagamento parcial.", confundirCom: ["VALOR_TOTAL"] },
    { id: "VALOR_TOTAL", expressoes: ["valor total", "valor da conta", "total da nota", "valor cheio"], natureza: "OBRIGACAO", ferramentas: ["detalhe_conta_a_pagar"],
      explicacao: "Valor original da obrigação, independente do que já foi pago.", confundirCom: ["SALDO_EM_ABERTO"] },
    { id: "RECEITA", expressoes: ["receita", "faturamento", "vendemos", "vendas", "faturou"], natureza: "FATURAMENTO", ferramentas: ["vendas", "resultado_do_mes"],
      explicacao: "Venda reconhecida (bruta ou líquida). Não é o dinheiro recebido: cartão e iFood caem depois.", confundirCom: ["RECEBIMENTO"] },
    { id: "RECEBIMENTO", expressoes: ["recebemos", "recebimento", "caiu na conta", "repasse", "a receber"], natureza: "RECEBIMENTO", ferramentas: ["contas_a_receber"],
      explicacao: "Dinheiro efetivamente recebido (ou a receber) de canais e clientes, pela data do crédito.", confundirCom: ["RECEITA"] },
    { id: "ENTREGADOR", expressoes: ["entregador", "motoboy", "motoqueiro", "boy", "entregas"], natureza: null, ferramentas: ["entregadores_da_semana", "historico_do_entregador"],
      explicacao: "Pessoa que faz entregas. QUANTIDADE de entregas e CUSTO das entregas são indicadores diferentes.", confundirCom: [] },
    { id: "FORNECEDOR", expressoes: ["fornecedor", "distribuidor", "distribuidora", "atacado", "atacadista", "quem vende pra gente"], natureza: null, ferramentas: ["contas_a_pagar", "analisar"],
      explicacao: "Favorecido de obrigações. Confirme o nome no cadastro: nomes parecidos podem ser fornecedores diferentes.", confundirCom: [] },
    { id: "COMPETENCIA", expressoes: ["competência", "do mês", "referente a", "mês de referência"], natureza: null, ferramentas: [],
      explicacao: "Mês a que a despesa/receita PERTENCE — diferente da data em que foi paga ou recebida.", confundirCom: ["DATA_DO_PAGAMENTO"] },
    { id: "DATA_DO_PAGAMENTO", expressoes: ["quando pagamos", "data do pagamento", "pago em", "pagamos dia"], natureza: null, ferramentas: [],
      explicacao: "Dia da liquidação. Não muda a competência.", confundirCom: ["COMPETENCIA"] },
    { id: "VALOR_UNITARIO", expressoes: ["por unidade", "cada um", "unitário", "por entrega", "média por"], natureza: "CALCULO", ferramentas: ["calcular"],
      explicacao: "Total dividido pela quantidade — sempre calculado pela ferramenta, nunca de cabeça.", confundirCom: ["VALOR_TOTAL"] },
  ]),
});

/** Resolve os conceitos financeiros prováveis de uma pergunta (para orientar o modelo e o verificador). */
export function criarResolvedorDeConceitos({ glossario = GLOSSARIO_BASE } = {}) {
  const indice = glossario.conceitos.map((c) => ({ c, exps: c.expressoes.map((e) => tokens(e)) }));
  /** Trechos [início, fim) da pergunta onde a expressão aparece em sequência (tolerando flexão/erro de digitação em cada palavra). */
  function trechos(ps, toks) {
    // conceito: erro de digitação só em palavra longa (≥ 6 letras) — "caixa" e "baixa" são coisas diferentes
    const ok = (p, t) => { const n = combinaPalavra(p, t); return n >= 0.85 || (n >= 0.75 && Math.min(p.length, t.length) >= 6); };
    const r = [];
    for (let i = 0; i + toks.length <= ps.length; i++) if (toks.every((t, k) => ok(ps[i + k], t))) r.push([i, i + toks.length]);
    return r;
  }
  return Object.freeze({
    versao: glossario.versao,
    conceitos(pergunta) {
      const ps = tokens(pergunta);
      const achados = indice.map(({ c, exps }) => ({ c, ts: exps.flatMap((toks) => (toks.length ? trechos(ps, toks) : [])) })).filter((x) => x.ts.length);
      // EXPRESSÃO MAIS ESPECÍFICA VENCE: um conceito cujos trechos estão TODOS dentro de um trecho mais longo de outro sai
      // ("despesas operacionais" é linha do resultado, não "despesa" genérica). Conceitos em trechos diferentes ficam todos
      // (a pessoa pode estar comparando: "reforço" × "entrada").
      const dentro = (a, b) => b[0] <= a[0] && a[1] <= b[1] && b[1] - b[0] > a[1] - a[0];
      return achados.filter((x) => !x.ts.every((t) => achados.some((y) => y !== x && y.ts.some((u) => dentro(t, u))))).map((x) => x.c);
    },
    /** Bloco curto para o contexto do modelo: o que cada conceito citado É no sistema e com o que não confundir. */
    orientacao(pergunta) {
      const cs = this.conceitos(pergunta);
      if (!cs.length) return null;
      return `Conceitos na pergunta (glossário ${glossario.versao}): ${cs.map((c) => `${c.id.toLowerCase().replace(/_/g, " ")} = ${c.explicacao}${c.ferramentas.length ? ` [${c.ferramentas.join(", ")}]` : ""}`).join(" | ")}`;
    },
  });
}
