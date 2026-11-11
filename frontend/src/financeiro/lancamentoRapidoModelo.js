// Modelo do LANÇAMENTO RÁPIDO (puro, sem DOM nem rede): a pessoa diz o que aconteceu em linguagem comum — "saiu dinheiro", "entrou
// dinheiro", "passei entre minhas contas" — e informa o quê, quanto e quando. O resto (categoria, conta, competência) é SUGERIDO a
// partir do que já foi lançado, sempre visível e trocável; nada é gravado escondido. Aqui só se monta o pedido para os endpoints que
// já existem (POST /lancamentos, /transferencias, /contas-pagar), que mantêm todas as regras e permissões.
import { moeda, rotuloMes } from "./modelo.js";

export const ACOES = Object.freeze({
  saiu: { id: "saiu", icone: "trending-down", tom: "bad", titulo: "Saiu dinheiro", desc: "Paguei ou vou pagar algo: compra, boleto, salário, taxa…" },
  entrou: { id: "entrou", icone: "trending-up", tom: "ok", titulo: "Entrou dinheiro", desc: "Recebi algo: venda, repasse, Pix, depósito…" },
  transferi: { id: "transferi", icone: "refresh", tom: "info", titulo: "Passei entre minhas contas", desc: "Tirei de uma conta minha e coloquei em outra." },
});

const sem = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const PALAVRAS_FRACAS = new Set(["para", "pagamento", "compra", "conta", "referente", "ref", "pix", "ted", "doc", "boleto", "nota", "fiscal", "loja", "valor", "mes", "dia", "com", "dos", "das", "por", "uma", "uns"]);
const fortes = (s) => sem(s).split(" ").filter((t) => t.length >= 4 && !PALAVRAS_FRACAS.has(t) && !/^\d+$/.test(t));

/** Valor digitado ("1.234,56", "120", "12,5", "R$ 8,00") → centavos inteiros; inválido, zero ou negativo → null. */
export function valorEmCentavos(texto) {
  const s = String(texto ?? "").replace(/R\$/i, "").replace(/\s+/g, "");
  if (!/^\d{1,3}(\.\d{3})+(,\d{1,2})?$|^\d+(,\d{1,2})?$|^\d+\.\d{1,2}$/.test(s)) return null;
  const n = /^\d+\.\d{1,2}$/.test(s) ? Number(s) : Number(s.replace(/\./g, "").replace(",", "."));
  const c = Math.round(n * 100);
  return Number.isSafeInteger(c) && c > 0 ? c : null;
}
/** Centavos → texto no formato que o servidor aceita ("120.50"). */
export const valorParaServidor = (centavos) => `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "Hoje" no relógio local do navegador (Brasil), sem passar por UTC. */
export const hojeIso = (agora = new Date()) => iso(agora);
export const ontemIso = (agora = new Date()) => { const d = new Date(agora); d.setDate(d.getDate() - 1); return iso(d); };
export const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && !Number.isNaN(Date.parse(`${s}T12:00:00`)) && iso(new Date(`${s}T12:00:00`)) === s;

/** Categorias que fazem sentido para o que aconteceu. Transferência e saldo anterior nunca aparecem aqui. */
export function categoriasPara(acao, categorias, { aPagar = false } = {}) {
  const ativas = (categorias ?? []).filter((c) => c.ativo && c.papel !== "saldo_anterior" && c.papel !== "transferencia");
  if (acao === "entrou") { const receitas = ativas.filter((c) => c.papel === "receita_operacional"); return receitas.length ? receitas : ativas; }
  return ativas.filter((c) => c.papel !== "receita_operacional" && (aPagar ? c.papel !== "financiamento" : true));
}

/**
 * Sugere a categoria a partir do histórico (lançamentos já feitos). Só sugere com base real:
 *   1) mesma descrição → a categoria mais usada nela;
 *   2) uma palavra "forte" em comum (ex.: o nome do fornecedor) → a categoria mais usada entre esses lançamentos.
 * Sem base, devolve null — nunca chuta. O resultado vem com o motivo escrito, para a pessoa conferir.
 */
export function sugerirCategoria(descricao, historico, categoriasPermitidas, acao) {
  const permitidas = new Set((categoriasPermitidas ?? []).map((c) => c.id));
  const base = (historico ?? []).filter((l) => l.categoria_id && permitidas.has(l.categoria_id) && l.status !== "cancelado" && (!acao || (acao === "entrou") === (l.sentido === "entrada")));
  const alvo = sem(descricao);
  if (alvo.length < 3 || !base.length) return null;
  const mais = (ls) => { const n = new Map(); for (const l of ls) n.set(l.categoria_id, (n.get(l.categoria_id) ?? 0) + 1); return [...n.entries()].sort((a, b) => b[1] - a[1])[0]; };
  const iguais = base.filter((l) => sem(l.descricao) === alvo);
  if (iguais.length) { const [id, n] = mais(iguais); return { categoriaId: id, motivo: `Lançamentos anteriores iguais (“${iguais[0].descricao}”) usaram esta categoria: ${n} de ${iguais.length}.` }; }
  const meus = new Set(fortes(descricao));
  const parecidos = meus.size ? base.filter((l) => fortes(l.descricao).some((t) => meus.has(t))) : [];
  if (parecidos.length) { const [id, n] = mais(parecidos); const t = fortes(parecidos[0].descricao).find((x) => meus.has(x)); return { categoriaId: id, motivo: `Lançamentos anteriores com “${t}” usaram esta categoria: ${n} de ${parecidos.length}.` }; }
  return null;
}

/** Conta sugerida: a do lançamento mais recente do mesmo sentido; senão a única conta ativa; senão nenhuma (a pessoa escolhe). */
export function sugerirConta(historico, contas, acao) {
  const ativas = (contas ?? []).filter((c) => c.ativo);
  const ok = new Set(ativas.map((c) => c.id));
  const recentes = (historico ?? []).filter((l) => ok.has(l.conta_id) && l.status !== "cancelado" && (!acao || (acao === "entrou") === (l.sentido === "entrada")))
    .sort((a, b) => String(b.data_movimento).localeCompare(String(a.data_movimento)));
  if (recentes[0]) return recentes[0].conta_id;
  return ativas.length === 1 ? ativas[0].id : null;
}

/**
 * Valida o que a pessoa preencheu e monta o pedido para o endpoint certo. Devolve { erros } (texto simples, por campo) ou { rota, corpo, resumo }.
 *  f: { acao, quando: "agora"|"depois", descricao, valor, data, contaId, categoriaId, fornecedor, contaDestinoId, competencia }
 */
export function montarPedido(f, { contas = [], categorias = [] } = {}) {
  const erros = {};
  const centavos = valorEmCentavos(f.valor);
  if (centavos == null) erros.valor = "Informe um valor maior que zero, por exemplo 120,50.";
  if (!dataValida(f.data)) erros.data = "Informe uma data válida.";
  const nome = (id) => contas.find((c) => c.id === id)?.nome ?? "—";
  const catNome = (id) => categorias.find((c) => c.id === id)?.nome ?? null;
  const descricao = String(f.descricao ?? "").trim();

  if (f.acao === "transferi") {
    if (!f.contaId) erros.contaId = "Escolha a conta de onde saiu.";
    if (!f.contaDestinoId) erros.contaDestinoId = "Escolha a conta para onde foi.";
    if (f.contaId && f.contaId === f.contaDestinoId) erros.contaDestinoId = "As duas contas precisam ser diferentes.";
    if (Object.keys(erros).length) return { erros };
    return { rota: "/transferencias", corpo: { contaOrigemId: f.contaId, contaDestinoId: f.contaDestinoId, valor: valorParaServidor(centavos), data: f.data, ...(descricao ? { descricao } : {}) },
      resumo: `Transferência de ${moeda(centavos)} em ${dataBr(f.data)}: ${nome(f.contaId)} → ${nome(f.contaDestinoId)}.`, ondeAparece: "Fluxo de Caixa (não entra na DRE, não é despesa nem receita)" };
  }

  if (descricao.length < 3) erros.descricao = f.acao === "entrou" ? "Diga em poucas palavras o que entrou." : "Diga em poucas palavras o que foi.";

  if (f.acao === "saiu" && f.quando === "depois") {
    if (!String(f.fornecedor ?? "").trim()) erros.fornecedor = "Diga para quem você vai pagar.";
    if (!f.categoriaId) erros.categoriaId = "Escolha a categoria: ela define onde a conta entra no resultado.";
    const competencia = f.competencia || String(f.data).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(competencia)) erros.competencia = "Informe o mês a que a conta pertence.";
    if (Object.keys(erros).length) return { erros };
    return { rota: "/contas-pagar", corpo: { categoriaId: f.categoriaId, fornecedorNome: String(f.fornecedor).trim(), descricao, competencia, vencimento: f.data, valorOriginal: valorParaServidor(centavos) },
      resumo: `Conta a pagar de ${moeda(centavos)} para ${String(f.fornecedor).trim()}, vence em ${dataBr(f.data)}. Entra no resultado de ${rotuloMes(competencia)} (${catNome(f.categoriaId)}).`,
      ondeAparece: "Contas a Pagar e DRE (pela categoria). Ainda não saiu dinheiro: o pagamento é registrado depois." };
  }

  if (!f.contaId) erros.contaId = "Escolha a conta.";
  if (Object.keys(erros).length) return { erros };
  const sentido = f.acao === "entrou" ? "entrada" : "saida";
  const cat = f.categoriaId ? catNome(f.categoriaId) : null;
  return { rota: "/lancamentos", corpo: { contaId: f.contaId, sentido, descricao, valor: valorParaServidor(centavos), dataMovimento: f.data, ...(f.categoriaId ? { categoriaId: f.categoriaId } : {}) },
    resumo: `${sentido === "entrada" ? "Entrada" : "Saída"} de ${moeda(centavos)} em ${dataBr(f.data)} · ${nome(f.contaId)} · ${cat ? `categoria ${cat}` : "sem categoria (fica para classificar depois)"}.`,
    ondeAparece: cat ? "Fluxo de Caixa, saldos e DRE (pela categoria)" : "Fluxo de Caixa e saldos; vai para a lista de classificação pendente" };
}
const dataBr = (s) => (dataValida(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—");
