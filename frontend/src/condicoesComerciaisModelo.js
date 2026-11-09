// Condições comerciais por canal — modelo PURO da tela de Configurações (sem DOM/fetch).
// A API trafega percentuais como FRAÇÃO (0.27 = 27%); a tela trabalha em % com vírgula. Campo vazio = "não configurado"
// (null) — nunca zero. Quem não tem taxa/promoção digita 0 de forma explícita.

export const CANAIS_CONDICOES = [
  { id: "ifood", rotulo: "iFood", dica: "Comissão do marketplace, taxas de pagamento e promoções custeadas pela loja." },
  { id: "balcao", rotulo: "Balcão", dica: "Venda direta na loja. Informe 0% de comissão se não houver." },
  { id: "uber", rotulo: "Uber Eats", dica: "Comissão e taxas do Uber Eats, se a loja vender por lá." },
  { id: "app", rotulo: "App próprio", dica: "Aplicativo ou site próprio da empresa." },
  { id: "outro", rotulo: "Outro canal", dica: "Qualquer outro canal de venda." },
];
export const rotuloCanal = (id) => CANAIS_CONDICOES.find((c) => c.id === id)?.rotulo ?? id;

export const RESPONSAVEIS = [
  { id: "", rotulo: "Não informado" },
  { id: "loja", rotulo: "A loja (entregador próprio)" },
  { id: "plataforma", rotulo: "A plataforma (ex.: entrega iFood)" },
  { id: "terceiro", rotulo: "Um terceiro (ex.: motoboy contratado)" },
];

/** "23,5" -> 0.235 ; "" -> null ; inválido -> {erro}. Aceita % e vírgula. */
export function percParaFracao(texto) {
  const t = String(texto ?? "").trim().replace("%", "").replace(",", ".");
  if (t === "") return { valor: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { erro: "valor inválido" };
  if (n < 0 || n >= 100) return { erro: "deve estar entre 0% e menos de 100%" };
  return { valor: Math.round(n * 100) / 10000 }; // 2 casas decimais em %, evita 0.23000000000000001
}
export function fracaoParaPerc(f) {
  if (f === null || f === undefined || !Number.isFinite(Number(f))) return "";
  return (Number(f) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}
const numReais = (t) => {
  const s = String(t ?? "").trim().replace(",", ".");
  if (s === "") return { valor: null };
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? { valor: n } : { erro: "valor inválido" };
};

/** Condição vinda da API (ou null) -> campos do formulário (strings). */
export function condicaoParaForm(c) {
  return {
    comissao: fracaoParaPerc(c?.comissao), taxas: fracaoParaPerc(c?.taxas), promocao: fracaoParaPerc(c?.promocao), tributos: fracaoParaPerc(c?.tributos),
    entrega_responsavel: c?.entrega_responsavel ?? "",
    entrega_custo: c?.entrega_custo == null ? "" : String(c.entrega_custo).replace(".", ","),
    outras: (c?.outras_deducoes ?? []).map((o) => ({ nome: o.nome, pct: fracaoParaPerc(o.pct) })),
    observacao: c?.observacao ?? "",
  };
}

/** Formulário (strings) -> corpo da API. Devolve {payload} ou {erros:{campo:mensagem}}. */
export function formParaPayload(canal, f) {
  const erros = {};
  const campo = (k, rotulo, obrigatorio = false) => {
    const r = percParaFracao(f[k]);
    if (r.erro) erros[k] = `${rotulo}: ${r.erro}.`;
    else if (obrigatorio && r.valor === null) erros[k] = `${rotulo}: informe o valor (use 0 se não houver).`;
    return r.valor ?? null;
  };
  const comissao = campo("comissao", "Comissão", true);
  const taxas = campo("taxas", "Taxas");
  const promocao = campo("promocao", "Promoções");
  const tributos = campo("tributos", "Tributos");
  const ec = numReais(f.entrega_custo);
  if (ec.erro) erros.entrega_custo = "Custo de entrega: valor inválido.";
  const resp = f.entrega_responsavel || null;
  if (ec.valor != null && ec.valor > 0 && resp !== "loja") erros.entrega_custo = "O custo de entrega por pedido só se aplica quando a loja é a responsável.";
  const outras = [];
  (f.outras ?? []).forEach((o, i) => {
    const nome = String(o.nome ?? "").trim();
    if (!nome && String(o.pct ?? "").trim() === "") return; // linha em branco: ignora
    const r = percParaFracao(o.pct);
    if (!nome) erros[`outras_${i}`] = "Dê um nome à dedução.";
    else if (r.erro || r.valor === null) erros[`outras_${i}`] = `"${nome}": informe um percentual válido.`;
    else outras.push({ nome, pct: r.valor });
  });
  if (outras.length > 10) erros.outras = "No máximo 10 outras deduções.";
  if (Object.keys(erros).length) return { erros };
  return { payload: { canal, comissao, taxas, promocao, tributos, entrega_responsavel: resp, entrega_custo: resp === "loja" ? ec.valor : null, outras_deducoes: outras, observacao: String(f.observacao ?? "").trim() || null } };
}

/** Situação do canal para o selo: completo / parcial (faltam campos que o dashboard usa) / não configurado. */
export function situacaoCondicao(c) {
  if (!c) return { chave: "ausente", texto: "Não configurado", classe: "bad", ajuda: "Sem esta configuração, simulações deste canal ficam parciais." };
  const faltam = [];
  if (c.taxas == null) faltam.push("taxas");
  if (c.promocao == null) faltam.push("promoções");
  if (faltam.length) return { chave: "parcial", texto: "Parcial", classe: "warn", ajuda: `Informe ${faltam.join(" e ")} (use 0 se não houver) para a margem estimada do Dashboard.` };
  return { chave: "completo", texto: "Configurado", classe: "ok", ajuda: "" };
}

export function resumoCondicao(c) {
  if (!c) return "—";
  const p = (rot, v) => (v == null ? null : `${rot} ${fracaoParaPerc(v)}%`);
  const resp = { loja: "entrega pela loja", plataforma: "entrega pela plataforma", terceiro: "entrega por terceiro" }[c.entrega_responsavel];
  return [p("comissão", c.comissao), p("taxas", c.taxas), p("promoções", c.promocao), p("tributos", c.tributos), resp,
    c.entrega_custo ? `entrega R$ ${String(c.entrega_custo).replace(".", ",")}/pedido` : null,
    ...(c.outras_deducoes ?? []).map((o) => `${o.nome} ${fracaoParaPerc(o.pct)}%`)].filter(Boolean).join(" · ");
}
