// 28/11 — MOVA Operador Financeiro (fase 1): pedido de CORREÇÃO CADASTRAL de conta a pagar em linguagem natural, SEM IA (custo zero).
// "MOVA, altere o fornecedor da segunda parcela do bebedouro" · "altere o vencimento da conta de energia para 15/12" ·
// "adicione uma observação nessa conta: paga pela sócia" · "mude a forma de pagamento do aluguel para pix".
// Só ENTENDE o pedido (campo, valor novo, qual conta, qual parcela ou todas). Quem decide se pode, procura a conta, mostra o
// antes/depois e pede a confirmação é o motor; quem confere e grava é o Financeiro (ação estreita corrigir_conta_a_pagar, 0036).
const sem = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const CAMPO_CORRECAO = Object.freeze({ FORNECEDOR: "fornecedor", VENCIMENTO: "vencimento", DESCRICAO: "descricao", OBSERVACAO: "observacao", FORMA: "formaPagamento" });
export const NOME_DO_CAMPO = Object.freeze({ fornecedor: "fornecedor", vencimento: "vencimento", descricao: "descrição", observacao: "observação", formaPagamento: "forma de pagamento" });
export const NOME_DA_FORMA = Object.freeze({ CARTAO: "cartão", BOLETO: "boleto", PIX: "Pix", DINHEIRO: "dinheiro", TRANSFERENCIA: "transferência" });

const VERBO = /\b(alter(e|a|ar|ando)|mud(e|a|ar|ando)|troc(a|ar|ando)|troque|corrij(a|o)|corrig(e|ir|indo)|atualiz(e|a|ar)|adicion(e|a|ar)|acrescent(e|a|ar)|inclu(a|i|ir)|coloqu(e|ar)|coloc(a|ar)|ajust(e|a|ar)|edit(e|a|ar)|pass(e|a|ar))\b/;
const CAMPOS = [
  [CAMPO_CORRECAO.FORMA, /\b(forma|meio) de pagamento\b/],
  [CAMPO_CORRECAO.FORNECEDOR, /\b(fornecedor|favorecido|beneficiario|credor)\b/],
  [CAMPO_CORRECAO.VENCIMENTO, /\b(vencimento|data de vencimento|vence)\b/],
  [CAMPO_CORRECAO.DESCRICAO, /\bdescricao\b/],
  [CAMPO_CORRECAO.OBSERVACAO, /\b(observacao|observacoes|obs)\b/],
];
const ORDINAIS = { primeira: 1, segunda: 2, terceira: 3, quarta: 4, quinta: 5, sexta: 6, setima: 7, oitava: 8, nona: 9, decima: 10 };
const FORMAS = [["PIX", /\bpix\b/], ["BOLETO", /\bboleto\b/], ["CARTAO", /\b(cartao|credito|debito)\b/], ["DINHEIRO", /\b(dinheiro|especie)\b/], ["TRANSFERENCIA", /\b(transferencia|ted|doc)\b/]];
const VAZIAS = new Set(["a", "o", "as", "os", "da", "do", "das", "dos", "de", "na", "no", "nas", "nos", "em", "e", "conta", "contas", "parcela", "parcelas", "mova", "por", "favor",
  "pf", "pfv", "essa", "esta", "dessa", "desta", "nessa", "nesta", "compra", "toda", "todas", "inteira", "ultima", "uma", "um", "pagar", "a pagar", "referente", "ref", "que", "para", "pra",
  ...Object.keys(ORDINAIS)]);

/** Data "15/12", "15/12/2026", "15-12-26" → AAAA-MM-DD. Sem ano: a próxima ocorrência a partir de 60 dias antes de hoje. */
export function dataDoTexto(texto, hoje) {
  const m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(String(texto ?? ""));
  if (!m) return null;
  const [d, mes] = [Number(m[1]), Number(m[2])];
  if (d < 1 || d > 31 || mes < 1 || mes > 12) return null;
  let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(hoje.slice(0, 4));
  const iso = (a) => `${a}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!m[3]) { const limite = new Date(Date.parse(`${hoje}T12:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10); if (iso(ano) < limite) ano += 1; }
  const r = iso(ano);
  return Number.isNaN(Date.parse(`${r}T12:00:00Z`)) || new Date(`${r}T12:00:00Z`).getUTCDate() !== d ? null : r;
}

export function formaDoTexto(texto) {
  const t = sem(texto);
  const achadas = FORMAS.filter(([, re]) => re.test(t)).map(([f]) => f);
  return achadas.length === 1 ? achadas[0] : null;
}

/** Valor NOVO a partir do texto livre do campo (resposta à pergunta "qual o novo …?" ou o trecho depois de "para"/":"). */
export function valorDoCampo(campo, bruto, hoje) {
  const v = String(bruto ?? "").trim().replace(/^["“'”]+|["“'”.!]+$/g, "").trim();
  if (!v) return null;
  if (campo === CAMPO_CORRECAO.VENCIMENTO) return dataDoTexto(v, hoje);
  if (campo === CAMPO_CORRECAO.FORMA) return formaDoTexto(v);
  if (campo === CAMPO_CORRECAO.FORNECEDOR) return v.length >= 2 && v.length <= 120 && /[a-z]/i.test(sem(v)) ? v.replace(/\s+/g, " ") : null;
  return v.length >= 2 && v.length <= (campo === CAMPO_CORRECAO.DESCRICAO ? 300 : 500) ? v.replace(/\s+/g, " ") : null;
}

/**
 * Pedido de correção? → { campo, valor (null = perguntar), bruto, parcela (n | "ULTIMA" | null), todas, nessaConta, termos[] } | null.
 * Um campo por pedido (dois campos ⇒ null: a pessoa faz um de cada vez, sem adivinhação).
 */
export function interpretarPedidoDeCorrecao(texto, hoje) {
  const original = String(texto ?? "").replace(/^\s*mova[\s,:-]*/i, "").trim();
  const t = sem(original);
  if (!t || t.length > 400 || !VERBO.test(t)) return null;
  const campos = CAMPOS.filter(([, re]) => re.test(t)).map(([c]) => c);
  // "forma de pagamento" contém "pagamento", não "vencimento"; "vence" só conta se não houver outro campo
  const unicos = campos.length > 1 && campos.includes(CAMPO_CORRECAO.VENCIMENTO) && /\bvence\b/.test(t) && !/\bvencimento\b/.test(t) ? campos.filter((c) => c !== CAMPO_CORRECAO.VENCIMENTO) : campos;
  if (unicos.length !== 1) return null;
  const campo = unicos[0];
  // valor novo: depois de ":" ou do PRIMEIRO " para "/" pra "/" por " depois do nome do campo (trecho do texto ORIGINAL, preservando
  // maiúsculas; "Gelo para festas" continua inteiro). `sem()` preserva os índices de um texto NFC.
  const dois = original.indexOf(":");
  const posCampo = CAMPOS.find(([c]) => c === campo)[1].exec(t)?.index ?? 0;
  const para = [...original.normalize("NFC").matchAll(/\s(para|pra|por)\s(?!favor\b)/gi)].find((m) => m.index > posCampo);
  let bruto = null; let alvoTexto = original;
  if (dois >= 0) { bruto = original.slice(dois + 1); alvoTexto = original.slice(0, dois); } else if (para) { bruto = original.slice(para.index + para[0].length); alvoTexto = original.slice(0, para.index); }
  if (campo === CAMPO_CORRECAO.VENCIMENTO && !bruto) { const d = dataDoTexto(original, hoje); if (d) { bruto = d; alvoTexto = original.replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/, ""); } }
  if (campo === CAMPO_CORRECAO.FORMA && !bruto) { const f = formaDoTexto(original.replace(/forma de pagamento/i, "")); if (f) bruto = f; }
  const valor = bruto ? valorDoCampo(campo, bruto, hoje) : null;
  const a = sem(alvoTexto);
  const ord = /\b(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona|decima|ultima)\s+parcela\b/.exec(a);
  const num = /\bparcela\s+(\d{1,2})\b/.exec(a) ?? /\b(\d{1,2})\s*(a|ª)\s+parcela\b/.exec(a);
  const parcela = ord ? (ord[1] === "ultima" ? "ULTIMA" : ORDINAIS[ord[1]]) : num ? Number(num[1]) : null;
  const todas = /\btodas as parcelas\b|\b(compra|conta) (toda|inteira)\b|\btodas\b/.test(a) && parcela === null;
  const nessaConta = /\b(nessa|nesta|essa|esta|dessa|desta)\s+(conta|parcela)\b/.test(a);
  const campoRe = CAMPOS.find(([c]) => c === campo)[1];
  const termos = a.replace(campoRe, " ").replace(VERBO, " ").replace(/\b(forma|meio) de pagamento\b|\bdata de vencimento\b/g, " ").replace(/\b\d+\b/g, " ")
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !VAZIAS.has(w));
  return { campo, valor, bruto: bruto ? String(bruto).trim() : null, valorInvalido: Boolean(bruto) && valor === null, parcela, todas, nessaConta, termos: [...new Set(termos)] };
}

/** A conta (título do Financeiro) casa com os termos? Todos os termos precisam aparecer na descrição ou no fornecedor. */
export function contaCasa(titulo, termos) {
  if (!termos.length) return false;
  const alvo = sem(`${titulo.descricao ?? ""} ${titulo.fornecedor?.nome ?? ""} ${titulo.categoria?.nome ?? ""}`);
  return termos.every((w) => alvo.includes(w));
}

const reais = (c) => `R$ ${(Number(c ?? 0) / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
export const valorAtual = (t, campo) => ({ fornecedor: t.fornecedor?.nome ?? "—", vencimento: dataBr(t.vencimento), descricao: t.descricao ?? "—",
  observacao: t.observacao ?? "(sem observação)", formaPagamento: NOME_DA_FORMA[t.formaPagamentoInformada] ?? "(não informada)" }[campo]);
export const valorNovo = (campo, v) => (campo === CAMPO_CORRECAO.VENCIMENTO ? dataBr(v) : campo === CAMPO_CORRECAO.FORMA ? NOME_DA_FORMA[v] ?? v : v);
export const rotuloDaConta = (t, unidadeNome = null) => `${t.descricao ?? "Conta"}${t.parcela?.total > 1 ? ` — parcela ${t.parcela.numero}/${t.parcela.total}` : ""} · ${t.fornecedor?.nome ?? "sem fornecedor"} · ${reais(t.saldoCentavos)} · vence ${dataBr(t.vencimento)}${unidadeNome ? ` · ${unidadeNome}` : ""}`;
