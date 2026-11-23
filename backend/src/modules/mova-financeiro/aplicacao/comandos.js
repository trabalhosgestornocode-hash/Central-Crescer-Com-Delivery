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
  const m = MESES.findIndex((x) => t.includes(` ${x} `));
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
  // Agente 2 — conferência de contas a pagar (custo zero).
  if (tem(t, "fornecedor", "fornecedores") && tem(t, "mais contas", "pendent", "em aberto", "devendo", "devemos", "mais deve", "contas")) return "FORNECEDORES_COM_PENDENCIAS";
  if (tem(t, "semdocumento")) return "CONTAS_SEM_COMPROVANTE";
  if (tem(t, "concilia", "conciliar", "conciliad", "nao conciliad")) return "PAGAMENTOS_A_CONCILIAR";
  if (pagar && tem(t, "parcial", "parcialmente", "pagas em parte", "pago em parte")) return "CONTAS_PARCIAIS";
  if (pagar && tem(t, "maiores", "maior", "mais altas", "mais caras", "de maior valor")) return "MAIORES_CONTAS_ABERTAS";
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
  const conta = interpretarPerguntaDeConta(bruto, hoje);
  if (conta) return conta;
  if (!bruto || bruto.length > MAXIMO || /\d/.test(bruto)) return null;
  // "sem comprovante/documento/nota" é a CONSULTA de contas sem documento, não o envio de um comprovante.
  const t = sem(bruto.replace(/^\s*@?mova[\s,!.:-]*/i, "")).replace(/ sem (comprovantes?|documentos?|recibos?|notas?( fiscal| fiscais)?)(?= )/g, " semdocumento ");
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

// ------------------------------------------------------------------------------------------------------------------
// Agente 2 — PERGUNTA SOBRE UMA CONTA ("me explique a conta da Distribuidora de R$ 1.234,56", "a conta do fornecedor X já foi
// paga?", "por que a Contabilidade de setembro está vencida?"). Só leitura: vira SITUACAO_DE_CONTA com as palavras do nome,
// o valor e o mês. Relato ("paguei"), pedido de execução, registro, baixa ou cancelamento NUNCA casam (seguem as guardas).
const PERGUNTA_DE_CONTA = [
  / (explica|explique|explicar|me explica|detalha|detalhe|detalhar|me fala|me fale|fale|conta mais) /,
  / (ja foi|foi|esta|ta|ja esta|ja ta) (paga|pago|quitada|quitado) /,
  / (por que|porque|pq|por qual motivo) .*(vencid|em aberto|atrasad|pendente|aberta)/,
];
const NAO_E_PERGUNTA = ["paguei", "pagamos", "pague", "pagar ", "transfir", "registr", "lanc", "cadastr", "anot", "aprov", "corrig", "exclu", "apag", "cancel", "baix", "quit "];
const VAZIAS = new Set(["mova", "me", "a", "o", "as", "os", "da", "do", "das", "dos", "de", "na", "no", "em", "um", "uma", "conta", "contas", "boleto", "fatura",
  "explica", "explique", "explicar", "detalha", "detalhe", "detalhar", "fala", "fale", "falar", "mais", "sobre", "ja", "foi", "esta", "ta", "paga", "pago", "quitada", "quitado",
  "por", "que", "porque", "pq", "qual", "motivo", "vencida", "vencido", "aberta", "aberto", "atrasada", "atrasado", "pendente", "valor", "reais", "r", "para", "pra",
  "essa", "esta", "aquela", "referente", "ainda", "nao", "sim", "voce", "pode", "poderia", "favor", "ok", "mes", "e", "ai",
  // pronomes/fillers de conversa ("detalha melhor isso", "me explica de onde saiu esse valor"): sem nome de conta, vai à IA com o contexto
  "isso", "isto", "esse", "desse", "disso", "dessa", "melhor", "onde", "saiu", "veio", "tudo", "pessoal", "gente"]);

/** "R$ 1.234,56" / "1234,56" / "R$ 12" ⇒ centavos; null se não houver valor. */
function valorCitado(bruto) {
  const m = bruto.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?(?!\s*[/\d])/i);
  if (!m || (!/r\$/i.test(bruto) && m[2] === undefined)) return null;
  const v = Number(m[1].replace(/\./g, "")) * 100 + Number(m[2] ?? 0);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

export function interpretarPerguntaDeConta(texto, hoje) {
  const bruto = String(texto ?? "").trim();
  if (!bruto || bruto.length > 160) return null;
  const t = sem(bruto.replace(/^\s*@?mova[\s,!.:-]*/i, ""));
  if (!PERGUNTA_DE_CONTA.some((r) => r.test(t)) || NAO_E_PERGUNTA.some((x) => t.includes(x))) return null;
  const valorCentavos = valorCitado(bruto);
  const iMes = MESES.findIndex((x) => t.includes(` ${x} `));
  let competencia = null;
  if (iMes >= 0) { const [ano, atual] = competencia_(hoje).split("-").map(Number); competencia = `${iMes + 1 > atual ? ano - 1 : ano}-${String(iMes + 1).padStart(2, "0")}`; }
  const termos = t.trim().split(" ").filter((w) => w.length >= 3 && !/\d/.test(w) && !VAZIAS.has(w) && !MESES.includes(w));
  if (!termos.length && !valorCentavos) return null;
  const v = validarSaidaDaIa({
    ...SAIDA_VAZIA, legivel: true, tipoDocumento: "OUTRO", intencao: "CONSULTAR", consulta: "SITUACAO_DE_CONTA", confianca: "ALTA",
    favorecido: termos.length ? termos.slice(0, 6).join(" ").slice(0, 120) : null, valorCentavos, competencia,
    justificativa: "pergunta sobre uma conta (sem IA)",
  });
  return v.ok ? { saida: v.saida, soPeriodo: false } : null;
}
const competencia_ = (data) => data.slice(0, 7);

// ------------------------------------------------------------------------------------------------------------------
// CONTINUIDADE DA CONVERSA sem IA (custo zero). Perguntas de acompanhamento curtas e inequívocas, que só fazem sentido com a
// consulta ANTERIOR da mesma pessoa na mesma conversa ("só as vencidas", "agora por fornecedor", "nas duas"). O recorte
// (período) vem do contexto curto que o próprio MOVA guardou — nunca de texto do usuário. A unidade NÃO é decidida aqui: segue
// a regra determinística do motor (resolverUnidade), então o histórico jamais amplia o que a pessoa pode ver.
const FAMILIA_CONTAS = Object.freeze(["CONTAS_A_PAGAR_ABERTAS", "CONTAS_VENCENDO", "CONTAS_VENCIDAS", "MAIORES_CONTAS_ABERTAS", "CONTAS_PARCIAIS", "FORNECEDORES_COM_PENDENCIAS", "CONTAS_SEM_COMPROVANTE"]);

/** Saída validada (mesmo formato da IA) que repete a consulta da conversa, com o mesmo período. null se o contexto não valida. */
export function saidaDeContinuacao(consulta, conversa, extra = {}) {
  const r = conversa?.contexto && typeof conversa.contexto === "object" ? conversa.contexto : {};
  const v = validarSaidaDaIa({
    ...SAIDA_VAZIA, legivel: true, tipoDocumento: "OUTRO", intencao: "CONSULTAR", consulta, confianca: "ALTA",
    competencia: r.competencia ?? null, periodoInicio: r.periodoInicio ?? null, periodoFim: r.periodoFim ?? null,
    justificativa: "continuação da conversa (sem IA)", ...extra,
  });
  return v.ok ? v.saida : null;
}

/** @returns {object|null} saída validada para a pergunta de acompanhamento, ou null (segue o fluxo normal, inclusive IA). */
export function interpretarSeguimento(texto, conversa) {
  const bruto = String(texto ?? "").trim();
  if (!conversa?.consulta || !bruto || bruto.length > 60 || /\d/.test(bruto)) return null;
  const t = sem(bruto.replace(/^\s*@?mova[\s,!.:-]*/i, ""));
  if (NAO_E_COMANDO.some((x) => t.includes(x))) return null;
  const familiaContas = FAMILIA_CONTAS.includes(conversa.consulta);
  if (familiaContas && /^ (e )?(so|apenas|somente) (as |os )?(vencid|atrasad)[a-z]* $/.test(t)) return saidaDeContinuacao("CONTAS_VENCIDAS", conversa);
  if (familiaContas && /^ (e )?(agora )?(por|pelos|por cada) fornecedor(es)? $/.test(t)) return saidaDeContinuacao("FORNECEDORES_COM_PENDENCIAS", conversa);
  if (/^ (e )?(nas|em|para|pras) (as )?(duas|ambas)( empresas| unidades| lojas)? $/.test(t) || /^ (e )?(nas|nos) dois $/.test(t)) return saidaDeContinuacao(conversa.consulta, conversa, { todasUnidades: true });
  return null;
}
