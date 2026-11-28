// 28/11 — MOVA Operador Financeiro (fase 1): pedido de CORREÇÃO CADASTRAL de conta a pagar em linguagem natural, SEM IA (custo zero).
// "MOVA, altere o fornecedor da segunda parcela do bebedouro" · "altere o vencimento da conta de energia para 15/12" ·
// "adicione uma observação nessa conta: paga pela sócia" · "mude a forma de pagamento do aluguel para pix".
// Só ENTENDE o pedido (campo, valor novo, qual conta, qual parcela ou todas). Quem decide se pode, procura a conta, mostra o
// antes/depois e pede a confirmação é o motor; quem confere e grava é o Financeiro (ação estreita corrigir_conta_a_pagar, 0036).
const sem = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const CAMPO_CORRECAO = Object.freeze({ FORNECEDOR: "fornecedor", VENCIMENTO: "vencimento", DESCRICAO: "descricao", OBSERVACAO: "observacao", FORMA: "formaPagamento",
  // 28/11 — fase 2 (0037): operações sobre a conta (cada uma com a sua ação estreita)
  CATEGORIA: "categoria", VALOR: "valor", COMPETENCIA: "competencia", CANCELAR: "cancelar" });
export const NOME_DO_CAMPO = Object.freeze({ fornecedor: "fornecedor", vencimento: "vencimento", descricao: "descrição", observacao: "observação", formaPagamento: "forma de pagamento",
  categoria: "categoria", valor: "valor", competencia: "competência", cancelar: "cancelamento" });
/** Operações da fase 2: a compra inteira (categoria, competência), uma parcela (valor) ou qualquer uma das duas (cancelar). */
export const CAMPOS_DA_FASE_2 = Object.freeze(["categoria", "valor", "competencia", "cancelar"]);
const MESES_NOME = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const CANCELA = /\b(cancel(e|a|ar|em)|anul(e|a|ar)|exclu(a|ir)|apague|apagar|remov(a|er))\b/;
export const NOME_DA_FORMA = Object.freeze({ CARTAO: "cartão", BOLETO: "boleto", PIX: "Pix", DINHEIRO: "dinheiro", TRANSFERENCIA: "transferência" });

const VERBO = /\b(alter(e|a|ar|ando)|mud(e|a|ar|ando)|troc(a|ar|ando)|troque|corrij(a|o)|corrig(e|ir|indo)|atualiz(e|a|ar)|adicion(e|a|ar)|acrescent(e|a|ar)|inclu(a|i|ir)|coloqu(e|ar)|coloc(a|ar)|ajust(e|a|ar)|edit(e|a|ar)|pass(e|a|ar))\b/;
const CAMPOS = [
  [CAMPO_CORRECAO.FORMA, /\b(forma|meio) de pagamento\b/],
  [CAMPO_CORRECAO.FORNECEDOR, /\b(fornecedor|favorecido|beneficiario|credor)\b/],
  [CAMPO_CORRECAO.VENCIMENTO, /\b(vencimento|data de vencimento|vence)\b/],
  [CAMPO_CORRECAO.DESCRICAO, /\bdescricao\b/],
  [CAMPO_CORRECAO.OBSERVACAO, /\b(observacao|observacoes|obs)\b/],
  [CAMPO_CORRECAO.CATEGORIA, /\b(categoria|classificacao)\b/],
  [CAMPO_CORRECAO.VALOR, /\bvalor\b/],
  [CAMPO_CORRECAO.COMPETENCIA, /\b(competencia|mes de referencia)\b/],
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

/** "R$ 1.234,56" · "325" · "325,5" → centavos (o ÚLTIMO valor do trecho); nada de datas. */
export function centavosDoTexto(texto) {
  const t = String(texto ?? "").replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ");
  const ms = [...t.matchAll(/(?:r\$\s*)?\b(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\b/gi)];
  if (!ms.length) return null;
  const m = ms.at(-1);
  const v = Number(m[1].replace(/\./g, "")) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  return v > 0 && v < 100000000000 ? v : null;
}
/** "novembro/2026" · "nov/26" · "11/2026" · "novembro de 2026" · "novembro" (ano corrente) → AAAA-MM. */
export function competenciaDoTexto(texto, hoje) {
  const t = sem(texto).replace(/\s+de\s+/g, " ");
  const num = /\b(0?[1-9]|1[0-2])[/.-](20\d{2}|\d{2})\b/.exec(t);
  if (num) return (num[2].length === 2 ? "20" + num[2] : num[2]) + "-" + num[1].padStart(2, "0");
  const nome = new RegExp("\\b(" + MESES_NOME.join("|") + "|" + MESES_NOME.map((x) => x.slice(0, 3)).join("|") + ")\\b[\\s/.-]*(20\\d{2}|\\d{2})?").exec(t);
  if (!nome) return null;
  const mes = MESES_NOME.findIndex((x) => x === nome[1] || x.slice(0, 3) === nome[1]) + 1;
  const ano = nome[2] ? (nome[2].length === 2 ? 2000 + Number(nome[2]) : Number(nome[2])) : Number(hoje.slice(0, 4));
  return ano + "-" + String(mes).padStart(2, "0");
}

/** Valor NOVO a partir do texto livre do campo (resposta à pergunta "qual o novo …?" ou o trecho depois de "para"/":"). */
export function valorDoCampo(campo, bruto, hoje) {
  const v = String(bruto ?? "").trim().replace(/^["“'”]+|["“'”.!]+$/g, "").trim();
  if (!v) return null;
  if (campo === CAMPO_CORRECAO.VENCIMENTO) return dataDoTexto(v, hoje);
  if (campo === CAMPO_CORRECAO.FORMA) return formaDoTexto(v);
  if (campo === CAMPO_CORRECAO.VALOR) return centavosDoTexto(v);
  if (campo === CAMPO_CORRECAO.COMPETENCIA) return competenciaDoTexto(v, hoje);
  if (campo === CAMPO_CORRECAO.CATEGORIA) return v.length >= 3 && v.length <= 80 ? v.replace(/\s+/g, " ") : null;
  if (campo === CAMPO_CORRECAO.FORNECEDOR) return v.length >= 2 && v.length <= 120 && /[a-z]/i.test(sem(v)) ? v.replace(/\s+/g, " ") : null;
  return v.length >= 2 && v.length <= (campo === CAMPO_CORRECAO.DESCRICAO ? 300 : 500) ? v.replace(/\s+/g, " ") : null;
}

/**
 * Pedido de correção? → { campo, valor (null = perguntar), bruto, parcela (n | "ULTIMA" | null), todas, nessaConta, termos[] } | null.
 * Um campo por pedido (dois campos ⇒ null: a pessoa faz um de cada vez, sem adivinhação).
 */
export function interpretarPedidoDeCorrecao(texto, hoje) {
  const r = interpretarSemJustificativa(texto, hoje);
  return r ? { ...r, justificativa: justificativaDoTexto(texto) } : null;
}
/** O motivo DITO pela pessoa ("… porque o frete foi à parte", "… motivo: nota errada"): vai para o histórico como foi dito. */
export function justificativaDoTexto(texto) {
  const m = /[\s,.;]+(porque|pois|j[aá] que|motivo:?|justificativa:?)\s+(.{4,300})$/i.exec(String(texto ?? "").trim());
  return m ? m[2].trim().replace(/[.!]+$/, "") : null;
}
const semJustificativa = (texto) => String(texto ?? "").replace(/[\s,.;]+(porque|pois|j[aá] que|motivo:?|justificativa:?)\s+.{4,300}$/i, "");
function interpretarSemJustificativa(texto, hoje) {
  const original = semJustificativa(texto).replace(/^\s*mova[\s,:-]*/i, "").trim();
  const t = sem(original);
  if (!t || t.length > 400) return null;
  const campos = CAMPOS.filter(([, re]) => re.test(t)).map(([c]) => c);
  // 28/11 (fase 2): CANCELAR — verbo de cancelamento e nenhum campo ("cancele a segunda parcela do freezer", "cancele a compra do freezer")
  if (CANCELA.test(t) && !campos.length) {
    const alvo = alvoDoPedido(original, t.replace(CANCELA, " "));
    // "cancele a COMPRA do freezer" = a compra inteira; "a conta"/"o freezer" sem parcela = pergunta (nunca presume todas)
    return { campo: CAMPO_CORRECAO.CANCELAR, valor: true, bruto: null, valorInvalido: false, ...alvo, todas: alvo.todas || (alvo.parcela === null && /\bcompra\b/.test(t)) };
  }
  // "o valor correto da 2ª parcela do freezer é R$ 325" também é pedido (sem verbo de alteração)
  if (!VERBO.test(t) && !(campos.length === 1 && campos[0] === CAMPO_CORRECAO.VALOR && /\bvalor (correto|certo)\b/.test(t))) return null;
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
  // "o valor correto da 2ª parcela do freezer é R$ 325,00": o valor depois de " é "
  if (campo === CAMPO_CORRECAO.VALOR && !bruto) { const e = / (é|e|eh|seria|deveria ser) /i.exec(original.slice(posCampo)); if (e) { bruto = original.slice(posCampo + e.index + e[0].length); alvoTexto = original.slice(0, posCampo + e.index); } }
  const valor = bruto ? valorDoCampo(campo, bruto, hoje) : null;
  const campoRe = CAMPOS.find(([c]) => c === campo)[1];
  return { campo, valor, bruto: bruto ? String(bruto).trim() : null, valorInvalido: Boolean(bruto) && valor === null, ...alvoDoPedido(alvoTexto, sem(alvoTexto).replace(campoRe, " ")) };
}

/** Qual conta: parcela indicada, "todas"/"compra inteira", "nessa conta" e os termos de busca (descrição/fornecedor). */
function alvoDoPedido(alvoTexto, semCampo) {
  const a = sem(alvoTexto);
  const ord = /\b(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona|decima|ultima)\s+parcela\b/.exec(a);
  const num = /\bparcela\s+(\d{1,2})\b/.exec(a) ?? /\b(\d{1,2})\s*(a|ª)\s+parcela\b/.exec(a);
  const parcela = ord ? (ord[1] === "ultima" ? "ULTIMA" : ORDINAIS[ord[1]]) : num ? Number(num[1]) : null;
  const todas = /\btodas as parcelas\b|\b(compra|conta) (toda|inteira)\b|\btodas\b/.test(a) && parcela === null;
  const nessaConta = /\b(nessa|nesta|essa|esta|dessa|desta)\s+(conta|parcela)\b/.test(a);
  const termos = semCampo.replace(VERBO, " ").replace(/\b(valor|correto|certo|categoria|competencia)\b/g, " ").replace(/\b(forma|meio) de pagamento\b|\bdata de vencimento\b/g, " ").replace(/\b\d+\b/g, " ")
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !VAZIAS.has(w));
  return { parcela, todas, nessaConta, termos: [...new Set(termos)] };
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
