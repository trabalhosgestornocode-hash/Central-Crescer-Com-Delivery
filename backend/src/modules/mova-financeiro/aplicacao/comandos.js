// COMANDOS SIMPLES sem IA (Agente 2 — velocidade e custo). Perguntas curtas e inequívocas ("MOVA, contas a pagar da semana",
// "faturamento do mês passado", "contas vencidas") viram a consulta do catálogo FECHADO direto no backend: nenhuma chamada paga,
// resposta imediata. Na menor dúvida devolve null e a mensagem segue o caminho normal (IA estrita).
//
// Nunca interpreta como comando: mensagem com número (valor, data), relato de pagamento, documento, boleto, nota, pedido de
// registro ou qualquer texto longo — isso é leitura de documento/relato e continua com a IA e com as guardas do motor.
// A saída tem o MESMO formato da saída validada da IA (validarSaidaDaIa), então o motor não tem um segundo caminho de regras.
import { SAIDA_VAZIA, validarSaidaDaIa } from "../ia/contratos.js";

const sem = (t) => ` ${String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9$]+/g, " ").trim()} `;
const tem = (t, ...termos) => termos.some((x) => t.includes(` ${x}`));
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const NAO_E_COMANDO = ["paguei", "pagamos", "pago ", "pagou", "boleto", "comprovante", "recibo", "nota fiscal", "lanc", "registr", "cadastr", "anot", "aprov", "corrig", "exclu", "apag", "transfer", "pix", "deposit"];
const MAXIMO = 90;

const dia = (d) => d.toISOString().slice(0, 10);
const somar = (data, n) => { const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return dia(d); };
const segunda = (data) => { const d = new Date(`${data}T12:00:00Z`); const w = (d.getUTCDay() + 6) % 7; return somar(data, -w); };
const competencia = (data) => data.slice(0, 7);
const mesAnterior = (comp) => { const [a, m] = comp.split("-").map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; };

/** Período citado no texto (já normalizado). null = nenhum. */
function periodo(t, hoje) {
  if (tem(t, "hoje")) return { periodoInicio: hoje, periodoFim: hoje };
  if (tem(t, "ontem")) { const d = somar(hoje, -1); return { periodoInicio: d, periodoFim: d }; }
  if (tem(t, "amanha")) { const d = somar(hoje, 1); return { periodoInicio: d, periodoFim: d }; }
  if (tem(t, "semana que vem", "proxima semana")) { const s = somar(segunda(hoje), 7); return { periodoInicio: s, periodoFim: somar(s, 6) }; }
  if (tem(t, "semana passada", "ultima semana")) { const s = somar(segunda(hoje), -7); return { periodoInicio: s, periodoFim: somar(s, 6) }; }
  if (tem(t, "esta semana", "essa semana", "nesta semana", "nessa semana", "semana atual")) { const s = segunda(hoje); return { periodoInicio: s, periodoFim: somar(s, 6) }; }
  // "da semana"/"na semana" sem dizer qual: os próximos 7 dias a partir de hoje (o que ainda vai acontecer).
  if (tem(t, "semana")) return { periodoInicio: hoje, periodoFim: somar(hoje, 6) };
  if (tem(t, "mes passado", "ultimo mes")) return { competencia: mesAnterior(competencia(hoje)) };
  if (tem(t, "este mes", "esse mes", "neste mes", "nesse mes", "mes atual", "do mes")) return { competencia: competencia(hoje) };
  const m = MESES.findIndex((x) => tem(t, x));
  if (m >= 0) {
    const [ano, atual] = competencia(hoje).split("-").map(Number);
    return { competencia: `${m + 1 > atual ? ano - 1 : ano}-${String(m + 1).padStart(2, "0")}` };
  }
  return null;
}

/** Consulta pedida (texto normalizado). Ordem importa: o mais específico primeiro. */
function consulta(t, p) {
  const pagar = tem(t, "a pagar", "contas", "boletos a vencer");
  if (tem(t, "entregador", "motoboy", "motoqueiro") && tem(t, "fechamento", "semana", "pagar", "pagamento", "nota", "notas", "acerto", "valor", "quanto")) return "FECHAMENTO_ENTREGADORES";
  if (pagar && tem(t, "vencid", "atrasad", "em atraso")) return "CONTAS_VENCIDAS";
  if (pagar && (tem(t, "vence", "vencend", "vencimento", "vencem") || (p && (p.periodoInicio || p.periodoFim)))) return "CONTAS_VENCENDO";
  if (tem(t, "a pagar")) return "CONTAS_A_PAGAR_ABERTAS";
  if (tem(t, "a receber", "recebiveis", "recebivel")) return "CONTAS_A_RECEBER";
  if (tem(t, "fluxo de caixa")) return "FLUXO_DE_CAIXA";
  if (tem(t, "liquid", "custo", "custos", "despesa", "despesas", "dre", "resultado", "lucro")) return "DRE_RESUMO";
  if (tem(t, "fatur", "vendas", "vendeu", "vendemos")) return "FATURAMENTO";
  if (tem(t, "pendencia", "pendencias")) return "PENDENCIAS";
  return null;
}

/**
 * @returns {{saida:object, soPeriodo:boolean}|null} saida no formato validado da IA; `soPeriodo` = continuação
 *   ("e a semana que vem?"): o motor completa com a consulta anterior do MESMO participante, se houver.
 */
export function interpretarComando(texto, hoje) {
  const bruto = String(texto ?? "").trim();
  if (!bruto || bruto.length > MAXIMO || /\d/.test(bruto)) return null;
  const t = sem(bruto.replace(/^\s*@?mova[\s,!.:-]*/i, ""));
  if (NAO_E_COMANDO.some((x) => t.includes(x))) return null;
  const p = periodo(t, hoje);
  const c = consulta(t, p);
  if (!c && !p) return null;
  // Continuação só de período: texto curto que é praticamente só o período ("e mês passado?", "e a semana que vem?").
  if (!c) {
    const resto = t.replace(/ (e|a|o|da|do|de|na|no|em|para|pra|semana|que|vem|proxima|passada|esta|essa|nesta|nessa|passado|ultima|ultimo|mes|este|esse|neste|nesse|atual|hoje|ontem|amanha|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|e ai|tambem|mova)(?= )/g, " ").trim();
    if (resto !== "") return null;
  }
  const v = validarSaidaDaIa({
    ...SAIDA_VAZIA, legivel: true, tipoDocumento: "OUTRO", intencao: "CONSULTAR", consulta: c, confianca: "ALTA",
    competencia: p?.competencia ?? null, periodoInicio: p?.periodoInicio ?? null, periodoFim: p?.periodoFim ?? null,
    justificativa: "comando simples (sem IA)",
  });
  return v.ok ? { saida: v.saida, soPeriodo: !c } : null;
}
