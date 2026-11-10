// Modelo da CENTRAL DE CONFERÊNCIAS (puro, sem DOM nem rede): organiza o que GET /conferencias e GET /pendencias-documentais
// já devolvem em grupos por assunto, nomes simples, motivo de uma frase, prioridade verificável, filtros, busca e ordenação.
// NUNCA decide nada: não confirma, não soma grupos como se fossem um prejuízo e não inventa dado para preencher a tela.
import { moeda, dataBr, diaMes } from "./modelo.js";

/** Seis assuntos. Cada tipo de pendência tem UMA categoria principal (nunca aparece em duas). */
export const CATEGORIAS = Object.freeze([
  { id: "vendas", rotulo: "Vendas e ajustes", tipos: ["ajuste_vendas", "divergencia_canais"] },
  { id: "contas", rotulo: "Contas, pagamentos e juros", tipos: ["juros_presumido", "conta_sem_pagamento", "origem_pendente", "pagamento_terceiro"] },
  { id: "custos", rotulo: "Custos e rateios", tipos: ["rateios"] },
  { id: "caixa", rotulo: "Caixa e conciliação", tipos: ["transferencias_internas"] },
  { id: "classificacoes", rotulo: "Classificações financeiras", tipos: ["classificacao_pendente", "categoria_sem_regra"] },
  { id: "documentais", rotulo: "Pendências documentais", tipos: ["pendencia_documental"] },
]);
const CATEGORIA_DO_TIPO = new Map(CATEGORIAS.flatMap((c) => c.tipos.map((t) => [t, c.id])));
/** Tipo desconhecido (versão nova do backend) cai em Classificações — nunca some e nunca duplica. */
export const categoriaDe = (p) => CATEGORIA_DO_TIPO.get(p?.tipo) ?? "classificacoes";

export const STATUS = Object.freeze({
  pendente: { rotulo: "Pendente", tom: "warn" },
  estimado: { rotulo: "Estimado", tom: "info" },
  aguardando_comprovacao: { rotulo: "Aguardando comprovação", tom: "muted" },
  confirmado: { rotulo: "Confirmado", tom: "ok" },
});
export const FILTROS_STATUS = Object.freeze([
  { valor: "todas", rotulo: "Todas" }, { valor: "pendente", rotulo: "Pendentes" }, { valor: "estimado", rotulo: "Estimadas" },
  { valor: "aguardando_comprovacao", rotulo: "Aguardando comprovação" }, { valor: "confirmado", rotulo: "Concluídas" },
]);
export const ORDENS = Object.freeze([{ valor: "prioridade", rotulo: "Prioridade" }, { valor: "data", rotulo: "Data" }, { valor: "valor", rotulo: "Valor" }]);

/** Primeira frase de um texto (o resto vai para "Detalhes técnicos"). */
export function primeiraFrase(t) {
  const s = String(t ?? "").trim();
  if (!s) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return (m ? m[1] : s).trim();
}
/** "Contadora (iFood: com o Portal do Parceiro)" → "Contadora". */
export const responsavelCurto = (r) => String(r ?? "").replace(/\s*\(.*\)\s*$/, "").trim() || "—";
/** Pessoas a filtrar, a partir do que as pendências trazem (sem inventar ninguém). */
export function responsaveis(itens) {
  const nomes = new Set();
  for (const p of itens) for (const parte of responsavelCurto(p.responsavel).split(/\s+(?:e|ou)\s+|,\s*/)) if (parte && parte !== "—") nomes.add(parte[0].toUpperCase() + parte.slice(1));
  return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

const sufixo = (t) => String(t ?? "").replace(/^[^—]*—\s*/, "").trim();

/** Nome simples, motivo de uma frase e como apresentar o valor de cada pendência. */
export function resumir(p) {
  const n = (p.itens ?? p.linhas ?? []).length;
  const base = { nome: p.titulo, motivo: primeiraFrase(p.motivo ?? p.descricao), valor: p.valorCentavos ?? null, valorRotulo: null };
  switch (p.tipo) {
    case "ajuste_vendas":
      return { ...base, nome: `Ajuste ${p.canal ?? "de vendas"}`, valor: p.valorCentavos == null ? null : Math.abs(p.valorCentavos),
        motivo: p.checklist ? "Aguardando relatório do Portal do Parceiro." : "Aguardando relatório do canal de vendas." };
    case "divergencia_canais": return { ...base, nome: "Vendas por canal × faturamento oficial", motivo: "A soma dos canais difere do faturamento oficial do mês." };
    case "rateios": return { ...base, nome: `Rateios propostos (${n})`, motivo: "Cada rateio aguarda aprovação individual da contadora.", valorRotulo: `${n} rateio${n === 1 ? "" : "s"} · valores individuais no detalhe` };
    case "juros_presumido": return { ...base, nome: `Acréscimo pago — ${sufixo(p.titulo)}`, motivo: p.quitada === false ? "Falta quitar a conta e, depois, classificar o acréscimo." : "Falta classificar a natureza do acréscimo (juros, multa ou tarifa)." };
    case "conta_sem_pagamento": return { ...base, nome: `Conta vencida — ${sufixo(p.titulo)}`, motivo: p.vencimento ? `Venceu em ${diaMes(p.vencimento)} e não há pagamento registrado.` : "Venceu e não há pagamento registrado." };
    case "origem_pendente": return { ...base, nome: `Pagamento sem conta de origem — ${sufixo(p.titulo)}`, motivo: "Não se sabe de qual conta o dinheiro saiu; nada foi presumido." };
    case "pagamento_terceiro": return { ...base, nome: `Pago por ${p.terceiroNome ?? "terceiro"} — ${sufixo(p.titulo)}`, motivo: "Pago com recursos pessoais: não saiu de conta bancária da empresa." };
    case "transferencias_internas": return { ...base, nome: `Transferências entre contas (${n})`, motivo: "Pares propostos aguardando conferência no extrato; nada foi vinculado sozinho.",
      valorRotulo: `${n} transferência${n === 1 ? "" : "s"} · dinheiro movido entre contas, não é perda` };
    case "classificacao_pendente": return { ...base, nome: `Lançamentos sem classificação (${n})`, motivo: "Falta identificar a natureza de cada movimentação.", valor: null, valorRotulo: `${n} movimentaç${n === 1 ? "ão" : "ões"}` };
    case "categoria_sem_regra": return { ...base, nome: "Categorias sem regra gerencial", motivo: "Falta definir em qual grupo da DRE cada categoria entra." };
    case "pendencia_documental": return { ...base, nome: p.titulo };
    default: return base;
  }
}

/**
 * Prioridade com critério VERIFICÁVEL (nunca urgência inventada):
 *   alta  → conta vencida sem pagamento; pagamento sem conta de origem (fica provisório e bloqueia o fechamento do mês);
 *   média → muda um número do resultado enquanto não decidida (ajuste estimado, acréscimo presumido, rateio proposto);
 *   normal → o resto (sem prazo nem impacto registrado).
 */
export function prioridade(p, hoje = new Date().toISOString().slice(0, 10)) {
  if (p.status === "confirmado") return { nivel: "normal", peso: 0, criterio: "Concluída." };
  if (p.tipo === "conta_sem_pagamento") return { nivel: "alta", peso: 3, criterio: `Conta vencida em ${dataBr(p.vencimento)} sem pagamento registrado.` };
  if (p.tipo === "origem_pendente") return { nivel: "alta", peso: 3, criterio: "Pagamento provisório: bloqueia o fechamento do mês até a origem ser informada." };
  if (p.vencimento && p.vencimento < hoje && p.tipo !== "juros_presumido") return { nivel: "alta", peso: 3, criterio: `Vencimento em ${dataBr(p.vencimento)} já passou.` };
  if (p.tipo === "ajuste_vendas") return { nivel: "media", peso: 2, criterio: "Enquanto estimado, o valor do ajuste não está confirmado no resultado." };
  if (p.tipo === "juros_presumido") return { nivel: "media", peso: 2, criterio: "A natureza do acréscimo muda a classificação da despesa." };
  if (p.tipo === "rateios") return { nivel: "media", peso: 2, criterio: "O rateio muda o custo de cada competência." };
  return { nivel: "normal", peso: 1, criterio: "Sem prazo ou impacto registrado." };
}
export const ROTULO_PRIORIDADE = Object.freeze({ alta: "Alta", media: "Média", normal: "Normal" });

/** Linhas da lista (pendências em aberto + documentais concluídas), cada uma com categoria e resumo. */
export function linhas(d, hoje) {
  const abertas = (d?.pendencias ?? []).map((p) => ({ ...p, status: p.status ?? "pendente" }));
  const concluidas = (d?.concluidasDocumentais ?? []).map((x) => ({ id: `doc:${x.id}`, docId: x.id, tipo: "pendencia_documental", titulo: x.descricao, descricao: x.motivo, motivo: x.motivo,
    valorCentavos: x.valorCentavos, responsavel: x.responsavel, evidenciaNecessaria: x.evidenciaNecessaria, status: "confirmado", statusRotulo: "Confirmado", confirmacao: x.confirmacao,
    documentoReferencia: x.documentoReferencia, observacoes: x.observacoes, data: x.dataReferencia ?? null, concluida: true }));
  return [...abertas, ...concluidas].map((p) => ({ ...p, categoria: categoriaDe(p), resumo: resumir(p), prioridade: prioridade(p, hoje) }));
}

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** "788,15", "788.15", "R$ 1.234,56" → centavos; texto que não é valor → null. */
export function valorDaBusca(t) {
  const s = String(t ?? "").replace(/R\$\s*/i, "").trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const norm = /,\d{1,2}$/.test(s) || /\.\d{3}/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(",", ".");
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
/** Texto pesquisável: nome, título, descrição, fornecedor, referência, documento e as linhas internas. */
function textoDe(p) {
  const internos = [...(p.itens ?? []), ...(p.linhas ?? []).flatMap((l) => [l.saida, ...(l.contrapartidas ?? [])])]
    .map((x) => [x?.descricao, x?.obrigacao, x?.fornecedor, x?.conta, x?.categoria].join(" "));
  return semAcento([p.resumo?.nome, p.titulo, p.descricao, p.motivo, p.fornecedor, p.categoria, p.canal, p.documentoReferencia, p.observacoes, p.terceiroNome, p.obrigacao?.descricao, p.divida?.descricao, p.id, ...internos].join(" "));
}
function valoresDe(p) {
  const v = [p.valorCentavos, ...(p.itens ?? []).map((x) => x.valorCentavos ?? x.valorElegivelCentavos), ...(p.linhas ?? []).flatMap((l) => [l.saida?.valorCentavos, ...(l.contrapartidas ?? []).map((x) => x.valorCentavos)])];
  return v.filter((x) => x != null).map((x) => Math.abs(Number(x)));
}

/** Filtros + busca. `responsavel` casa por nome contido ("Contadora" acha "Proprietário e contadora"). */
export function filtrar(itens, { status = "todas", responsavel = "", categoria = "", busca = "" } = {}) {
  const q = String(busca ?? "").trim(), qv = valorDaBusca(q), qt = semAcento(q);
  return itens.filter((p) => {
    if (status !== "todas" && p.status !== status) return false;
    if (categoria && p.categoria !== categoria) return false;
    if (responsavel && !semAcento(p.responsavel).includes(semAcento(responsavel))) return false;
    if (!q) return true;
    if (qv != null && valoresDe(p).includes(qv)) return true;
    return textoDe(p).includes(qt);
  });
}

export function ordenar(itens, por = "prioridade") {
  const v = (p) => (p.resumo?.valor ?? p.valorCentavos);
  const cmp = {
    prioridade: (a, b) => b.prioridade.peso - a.prioridade.peso || String(a.data ?? "9999").localeCompare(String(b.data ?? "9999")),
    data: (a, b) => String(a.data ?? "9999").localeCompare(String(b.data ?? "9999")),
    valor: (a, b) => Math.abs(v(b) ?? -1) - Math.abs(v(a) ?? -1),
  }[por] ?? (() => 0);
  return [...itens].sort((a, b) => cmp(a, b) || String(a.resumo?.nome).localeCompare(String(b.resumo?.nome), "pt-BR"));
}

/** Agrupa por categoria (ordem fixa). Só CONTA itens; nunca soma valores de um grupo. */
export function agrupar(itens) {
  return CATEGORIAS.map((c) => ({ ...c, itens: itens.filter((p) => p.categoria === c.id) }));
}

/** Sugestões documentais ainda não cadastradas, as dispensadas (com justificativa) e as relações entre elas (ex.: 190,53 × 195,25). */
export function sugestoes(pd) {
  const modelos = pd?.modelos ?? [];
  const abertas = modelos.filter((m) => !m.cadastrada && !m.dispensada);
  const dispensadas = modelos.filter((m) => !m.cadastrada && m.dispensada);
  const porChave = new Map(modelos.map((m) => [m.chave, m]));
  const relacoes = [], vistos = new Set();
  for (const m of abertas) {
    const o = m.relacionadaChave ? porChave.get(m.relacionadaChave) : null;
    if (!o || vistos.has(o.chave) || m.valorCentavos == null || o.valorCentavos == null) continue;
    vistos.add(m.chave); vistos.add(o.chave);
    const [maior, menor] = m.valorCentavos >= o.valorCentavos ? [m, o] : [o, m];
    relacoes.push({ chaves: [maior.chave, menor.chave], maior, menor, diferencaCentavos: maior.valorCentavos - menor.valorCentavos,
      conta: `${moeda(maior.valorCentavos)} − ${moeda(maior.valorCentavos - menor.valorCentavos)} = ${moeda(menor.valorCentavos)}`,
      // a origem da diferença vem da observação documentada no próprio modelo — nada é deduzido aqui
      origemDiferenca: menor.observacoes ?? maior.observacoes ?? null,
      texto: "Os dois valores podem descrever o MESMO dinheiro. Não contar como duas perdas independentes antes de validar." });
  }
  return { abertas, dispensadas, relacoes };
}

/** Comparação Sistema × apresentação oficial: sem referência, diz isso — nunca "0 de 0 indicadores conferem". */
export function textoComparacao(resumo) {
  if (!resumo?.total) return { vazio: true, texto: "Nenhuma referência documental cadastrada para comparação." };
  const div = resumo.total - resumo.conferem;
  return { vazio: false, texto: `${resumo.conferem} de ${resumo.total} indicadores conferem${div ? `; ${div} com diferença explicada abaixo` : ""}.` };
}

/** Dados do cabeçalho. Metodologia: pendente quando o backend devolve o aviso geral "metodologia". */
export function cabecalho(d, pd) {
  const metod = (d?.geral ?? []).find((g) => g.tipo === "metodologia" || g.id === "metodologia");
  return {
    grupos: d?.total ?? 0,
    sugestoes: sugestoes(pd).abertas.length,
    metodologia: metod ? { aprovada: false, rotulo: "Aguardando aprovação", texto: metod.descricao } : { aprovada: true, rotulo: "Aprovada", texto: "A metodologia gerencial está aprovada." },
  };
}
