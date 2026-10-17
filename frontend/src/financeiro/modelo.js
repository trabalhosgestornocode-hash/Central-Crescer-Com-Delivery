// Modelo do Dashboard Financeiro (puro, sem DOM): formatação e regras de apresentação.
// Dinheiro chega do backend em CENTAVOS INTEIROS; aqui só se formata. Valor ausente (null) NUNCA vira "R$ 0,00".

const NBSP = " ";

export function moeda(centavos, { sinal = false } = {}) {
  if (centavos === null || centavos === undefined || !Number.isFinite(Number(centavos))) return "—";
  const n = Number(centavos);
  const abs = Math.abs(n);
  const inteiro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const corpo = `R$${NBSP}${inteiro},${String(abs % 100).padStart(2, "0")}`;
  if (n < 0) return `−${corpo}`;
  return sinal && n > 0 ? `+${corpo}` : corpo;
}

export function pct(bps) {
  if (bps === null || bps === undefined || !Number.isFinite(Number(bps))) return "—";
  const n = Number(bps);
  const abs = Math.abs(n);
  return `${n < 0 ? "−" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}%`;
}

export const dataBr = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
export const diaMes = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : String(iso ?? ""));

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const rotuloMes = (ym) => (/^\d{4}-\d{2}$/.test(ym ?? "") ? `${MESES[Number(ym.slice(5)) - 1]}/${ym.slice(0, 4)}` : "—");

/** "2026-09" → { de: "2026-09-01", ate: "2026-09-30" } */
export function periodoDoMes(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym ?? "")) return null;
  const [a, m] = ym.split("-").map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { de: `${ym}-01`, ate: `${ym}-${String(ultimo).padStart(2, "0")}` };
}
export function mesAnterior(ym) {
  const [a, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export const mesDe = (hoje = new Date()) => `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;

export function queryString(obj) {
  const p = Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return p.length ? `?${p.join("&")}` : "";
}

export const ROTULO_PAPEL = Object.freeze({
  receita_operacional: "Receita operacional", custo_variavel: "Custo variável", despesa_variavel: "Despesa variável", tributo: "Tributo",
  despesa_fixa: "Despesa fixa", despesa_pessoal: "Despesa com pessoal", despesa_financeira: "Despesa financeira", financiamento: "Financiamento",
  transferencia: "Transferência", saldo_anterior: "Saldo anterior",
});
export const ROTULO_STATUS_IND = Object.freeze({ ok: "Calculado", parcial: "Parcial", indisponivel: "Indisponível" });
export const ROTULO_TIPO_CONTA = Object.freeze({ banco: "Banco", adquirente: "Adquirente", caixa_fisico: "Caixa físico", carteira_plataforma: "Carteira de plataforma", outra: "Outra" });

/** Nunca assume zero: saldo sem abertura conhecida é exibido como parcial, com o movimento à parte. */
export function descreverSaldo(c) {
  if (c.saldoCentavos === null || c.saldoCentavos === undefined) {
    return { principal: "Saldo parcial", detalhe: `Abertura desconhecida · movimento ${moeda(c.saldoSemAberturaCentavos ?? c.variacao)}`, parcial: true };
  }
  return { principal: moeda(c.saldoCentavos), detalhe: `Abertura ${moeda(c.aberturaCentavos)} · variação ${moeda(c.variacao, { sinal: true })}`, parcial: false };
}

/** Variação mês a mês para exibição; base zero ou ausente → sem percentual. */
export function variacaoTexto(atual, anterior) {
  if (atual == null || anterior == null) return null;
  const delta = atual - anterior;
  if (anterior === 0) return { delta, texto: `${moeda(delta, { sinal: true })}` };
  const bps = Math.round((delta * 10000) / Math.abs(anterior));
  return { delta, texto: `${moeda(delta, { sinal: true })} (${bps > 0 ? "+" : ""}${pct(bps)})` };
}

export const nivelAlerta = (a) => (a.nivel === "erro" ? "bad" : "warn");
export const podeAcao = (ctx, acao) => (ctx?.permissoes ?? []).includes(acao);
export const ACAO = Object.freeze({
  VER: "gestao_financeira.ver", LANCAR: "gestao_financeira.lancar", EDITAR: "gestao_financeira.editar", CONCILIAR: "gestao_financeira.conciliar",
  CONFIGURAR: "gestao_financeira.configurar", EXCLUIR: "gestao_financeira.excluir",
});

/** Motivos de revisão da importação → rótulo curto. */
export const ROTULO_MOTIVO = Object.freeze({
  sem_papel: "Sem classificação", a_identificar: "A identificar", comentario: "Comentário", valor_por_formula: "Valor por fórmula",
  identica_no_arquivo: "Linha idêntica", transferencia_sem_contraparte: "Transferência sem par", possivel_alteracao: "Possível alteração",
});

/** Arquivo → base64 puro (sem prefixo data:). */
export async function arquivoParaBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
