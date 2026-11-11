// Importação de CONTAS A PAGAR por planilha (núcleo puro, sem banco nem rede).
// Entrada: linhas brutas lidas da aba de saídas (vencimento, valor previsto/realizado, descrição, categoria, conta de pagamento, data de pagamento, origem).
// Escopo: só linhas cuja ORIGEM indica TÍTULO DO SISTEMA da loja. "Só extrato" (pagamento sem título) já está no livro-caixa e fica de fora.
// Cada linha vira uma conta a pagar e, se já foi paga, um pagamento. Nunca cria movimento bancário: o pagamento depois é conciliado com a saída do extrato.
import { createHash } from "node:crypto";
import { paraCentavos } from "./dinheiro.js";

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
export const norm = semAcento;

/** Marca gravada em `observacoes` da conta criada: é o que torna a importação idempotente (reenviar o arquivo não duplica). */
export const MARCA = "imp-cp";
export const marcaDe = (chave) => `[${MARCA}:${chave}]`;
export const chaveDaObservacao = (obs) => /\[imp-cp:([0-9a-f]{16})\]/.exec(String(obs ?? ""))?.[1] ?? null;

const iso = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number") { if (v < 20000 || v > 80000) return null; return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
};
const dataOk = (s) => !!s && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** "título do sistema" = a origem cita o sistema e não é "só extrato". */
export function ehTituloDoSistema(origem) {
  const o = semAcento(origem);
  return o.includes("SISTEMA") && !o.startsWith("SO EXTRATO");
}

/** "Serviços advocatícios – Glauber Benício" → fornecedor "Glauber Benício"; sem travessão, o fornecedor é a própria descrição. */
export function fornecedorDe(descricao) {
  const d = String(descricao ?? "").trim();
  const partes = d.split(/\s+[–—-]\s+/);
  const f = partes.length > 1 ? partes[partes.length - 1] : d;
  return f.trim().slice(0, 120) || d.slice(0, 120);
}

const cent = (v, nome, erros) => {
  try { const c = paraCentavos(typeof v === "string" ? v : v == null || v === "" ? null : Number(v)); return c ?? 0; }
  catch { erros.push(`${nome} inválido`); return 0; }
};

/**
 * Normaliza as linhas brutas. Devolve { itens, fora, erros }.
 *  - itens: contas a pagar a criar (com `chave` estável, `categoriaChave` e `contaChave` para o mapeamento);
 *  - fora: linhas que não são título do sistema (contagem e soma, só informativo);
 *  - erros: [{ linha, motivo }] — com erro, nada é importado.
 */
export function normalizarContasPagar(brutas) {
  const itens = [], erros = [], fora = { quantidade: 0, valorCentavos: 0 };
  const vistas = new Map();
  for (const b of brutas ?? []) {
    const motivos = [];
    const previsto = cent(b.previsto, "valor previsto", motivos), realizado = cent(b.realizado, "valor realizado", motivos);
    if (!ehTituloDoSistema(b.origem)) { fora.quantidade += 1; fora.valorCentavos += realizado || previsto; continue; }
    const vencimento = iso(b.vencimento), dataPagamento = iso(b.dataPagamento);
    const descricao = String(b.descricao ?? "").replace(/\s+/g, " ").trim();
    if (!dataOk(vencimento)) motivos.push("vencimento inválido");
    if (!descricao) motivos.push("descrição ausente");
    if (previsto <= 0) motivos.push("valor previsto precisa ser maior que zero");
    if (realizado < 0) motivos.push("valor realizado negativo");
    if (realizado > 0 && !dataOk(dataPagamento)) motivos.push("pago sem data de pagamento válida");
    if (realizado > 0 && !String(b.formaPagamento ?? "").trim()) motivos.push("pago sem a conta/forma de pagamento");
    if (motivos.length) { erros.push({ linha: b.linha, motivo: motivos.join("; ") }); continue; }
    const base = [vencimento, semAcento(descricao), previsto, realizado, dataPagamento ?? "", semAcento(b.formaPagamento)].join("|");
    const seq = (vistas.get(base) ?? 0) + 1; vistas.set(base, seq);
    const chave = createHash("sha1").update(`${base}|${seq}`).digest("hex").slice(0, 16);
    itens.push({
      linha: b.linha, chave, vencimento, competencia: vencimento.slice(0, 7), descricao, fornecedor: fornecedorDe(descricao),
      previstoCentavos: previsto, realizadoCentavos: realizado, dataPagamento: realizado > 0 ? dataPagamento : null, formaPagamento: String(b.formaPagamento ?? "").trim(),
      categoriaChave: [semAcento(b.classificacao), semAcento(b.categoria), semAcento(b.natureza)].join("|"),
      categoriaRotulo: [b.classificacao, b.categoria].filter(Boolean).join(" · ") || "—",
      contaChave: realizado > 0 ? semAcento(b.formaPagamento) : null, origem: String(b.origem ?? "").trim(),
    });
  }
  return { itens, fora, erros };
}

// ---------------------------------------------------------------- sugestões de mapeamento (a pessoa confirma ou troca na tela)
const ALIAS_CATEGORIA = [
  [/^(DESPESA\|FINANCEIRA)\|/, "TARIFAS E JUROS"], [/^DESPESA\|TRIBUTARIA\|/, "IMPOSTOS E GUIAS"], [/^DESPESA\|PESSOAL\|VARIAVEL$/, "DIARIAS DE EXTRAS"],
  [/^MOVIMENTACAO FINANCEIRA\|/, "EMPRESTIMOS / FINANCIAMENTOS"], [/^OBRIGACOES TRIBUTARIAS\|/, "PARCELAMENTO DE TRIBUTOS"], [/^INVESTIMENTO\|/, "IMOBILIZADO"],
];
/** Categoria do plano sugerida para a categoria da planilha: nome igual (sem acento) ou apelido conhecido. Sem base, null (a pessoa escolhe). */
export function sugerirCategoriaPlano(categoriaChave, plano) {
  const ok = (plano ?? []).filter((c) => c.ativo && !["transferencia", "saldo_anterior", "receita_operacional"].includes(c.papel));
  const [, cat = "", nat = ""] = String(categoriaChave).split("|");
  const alias = ALIAS_CATEGORIA.find(([re]) => re.test(categoriaChave))?.[1];
  const achar = (nome) => {
    const iguais = ok.filter((c) => semAcento(c.nome) === nome);
    if (iguais.length <= 1) return iguais[0] ?? null;
    // mesmo nome em mais de um papel (ex.: COMERCIAL fixa e variável): decide pela natureza da planilha; se não der, não chuta
    const papeis = { FIXA: ["despesa_fixa"], VARIAVEL: ["despesa_variavel", "custo_variavel"], PESSOAL: ["despesa_pessoal"], FINANCEIRA: ["despesa_financeira"] }[nat] ?? [];
    const filtrados = iguais.filter((c) => papeis.includes(c.papel));
    return filtrados.length === 1 ? filtrados[0] : null;
  };
  return (alias && achar(alias)) || achar(cat) || null;
}
/** Conta financeira sugerida para "Unicred MP", "Caixa (espécie)"… : a conta ativa cuja primeira palavra é igual; se houver mais de uma, nenhuma. */
export function sugerirContaFinanceira(contaChave, contas) {
  const prim = String(contaChave ?? "").replace(/[^A-Z0-9 ]/g, " ").trim().split(" ")[0];
  if (!prim) return null;
  const achadas = (contas ?? []).filter((c) => c.ativo && semAcento(c.nome).split(" ")[0] === prim);
  return achadas.length === 1 ? achadas[0] : null;
}

/** Grupos para a tela de mapeamento: cada chave distinta com quantidade, soma e sugestão. */
export function gruposDeMapeamento(itens, { plano, contas }) {
  const cats = new Map(), cts = new Map();
  for (const i of itens) {
    const c = cats.get(i.categoriaChave) ?? { chave: i.categoriaChave, rotulo: i.categoriaRotulo, quantidade: 0, valorCentavos: 0 }; c.quantidade += 1; c.valorCentavos += i.previstoCentavos; cats.set(i.categoriaChave, c);
    if (i.contaChave) { const k = cts.get(i.contaChave) ?? { chave: i.contaChave, rotulo: i.formaPagamento, quantidade: 0, valorCentavos: 0 }; k.quantidade += 1; k.valorCentavos += i.realizadoCentavos; cts.set(i.contaChave, k); }
  }
  return {
    categorias: [...cats.values()].map((g) => ({ ...g, sugestaoId: sugerirCategoriaPlano(g.chave, plano)?.id ?? null })),
    contas: [...cts.values()].map((g) => ({ ...g, sugestaoId: sugerirContaFinanceira(g.chave, contas)?.id ?? null })),
  };
}
