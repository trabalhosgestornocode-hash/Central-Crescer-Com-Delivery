// DIVERGÊNCIA entre o comprovante e as contas a pagar (MOVA financeiro autônomo, 23/11/2026) — regras PURAS, sem I/O.
//
// O motor decide uma de três coisas ao casar um comprovante com as contas abertas:
//   EXECUTAR   — valor igual ao saldo de UMA conta (baixa), ou nenhuma conta do favorecido (despesa nova);
//   PERGUNTAR  — valor maior (juros? outra compra?), valor menor (parcial?), várias contas candidatas;
//   (encaminhar para conferência fica no motor: duplicidade, perfil, competência fechada, limite etc.)
// Regra de ouro: diferença de valor NUNCA é presumida como juros, nem a conta presumida como compra nova; uma pergunta
// objetiva resolve e a conversa continua sem segunda confirmação. A IA não decide nada aqui: respostas são interpretadas
// por regras determinísticas.

export const TIPO_DIVERGENCIA = Object.freeze({ MAIOR: "MAIOR", MENOR: "MENOR", VARIAS: "VARIAS" });
export const DESFECHO = Object.freeze({ JUROS: "JUROS", PARCIAL: "PARCIAL", NOVA: "NOVA", ESCOLHER: "ESCOLHER", NAO_ENTENDI: "NAO_ENTENDI" });
export const MAX_CANDIDATAS_NA_PERGUNTA = 5;

export const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const SIM = /^(sim|s|isso|isso mesmo|exato|exatamente|correto|certo|confirmo|isso ai|e sim|sao|sao sim|foi|foi sim|ok)$/;
const NAO = /^(nao|n|negativo|nao e|nao sao|nao foi|nao eh)$/;
const PALAVRA_JUROS = /\b(juros?|multa|mora|encargos?|acrescimos?)\b/;
const PALAVRA_PARCIAL = /\b(parcial|parcela|entrada|sinal|adiantamento|restante|resto|metade|primeira)\b/;
const PALAVRA_NOVA = /\b(nova|novo|outra|outro|compra|nenhuma|nenhum|diferente|avulsa)\b/;

/** A legenda da mensagem deixa claro que o pagamento é parcial? (só então a baixa parcial dispensa pergunta) */
export const legendaIndicaParcial = (legenda) => PALAVRA_PARCIAL.test(normalizar(legenda));
/** A legenda cita juros/multa? (mesmo assim o MOVA confirma a composição da diferença; nunca presume) */
export const legendaCitaJuros = (legenda) => PALAVRA_JUROS.test(normalizar(legenda));

/** Texto curto que parece resposta a uma pergunta de divergência (para a memória curta, sem citação). */
export function parecerRespostaDeDivergencia(texto) {
  const t = normalizar(texto);
  if (!t || t.length > 60) return false;
  return SIM.test(t) || NAO.test(t) || /^[1-9]$/.test(t) || PALAVRA_JUROS.test(t) || PALAVRA_PARCIAL.test(t) || PALAVRA_NOVA.test(t);
}

/**
 * Interpreta a resposta da pessoa à pergunta pendente.
 * @param {string} texto
 * @param {{tipo:string, candidatas:Array<object>}} pendencia
 * @returns {{desfecho:string, indice?:number}}
 */
export function interpretarResposta(texto, pendencia) {
  const t = normalizar(texto);
  if (!t) return { desfecho: DESFECHO.NAO_ENTENDI };
  const numero = /^([1-9])\b/.exec(t);
  if (pendencia.tipo === TIPO_DIVERGENCIA.VARIAS) {
    if (numero && Number(numero[1]) <= pendencia.candidatas.length) return { desfecho: DESFECHO.ESCOLHER, indice: Number(numero[1]) - 1 };
    if (PALAVRA_NOVA.test(t) || NAO.test(t)) return { desfecho: DESFECHO.NOVA };
    return { desfecho: DESFECHO.NAO_ENTENDI };
  }
  if (PALAVRA_NOVA.test(t) && !PALAVRA_JUROS.test(t) && !PALAVRA_PARCIAL.test(t)) return { desfecho: DESFECHO.NOVA };
  if (NAO.test(t)) return { desfecho: DESFECHO.NOVA };
  if (pendencia.tipo === TIPO_DIVERGENCIA.MAIOR) {
    if (SIM.test(t) || PALAVRA_JUROS.test(t) || (numero && numero[1] === "1")) return { desfecho: DESFECHO.JUROS };
    if (numero && numero[1] === "2") return { desfecho: DESFECHO.NOVA };
  }
  if (pendencia.tipo === TIPO_DIVERGENCIA.MENOR) {
    if (SIM.test(t) || PALAVRA_PARCIAL.test(t) || (numero && numero[1] === "1")) return { desfecho: DESFECHO.PARCIAL };
    if (numero && numero[1] === "2") return { desfecho: DESFECHO.NOVA };
  }
  return { desfecho: DESFECHO.NAO_ENTENDI };
}

/**
 * Classifica o casamento comprovante × contas candidatas (já filtradas por favorecido).
 * @returns {{caso:"NENHUMA"|"EXATA"|"MAIOR"|"MENOR"|"VARIAS", conta?:object, candidatas?:object[]}}
 */
export function classificarCasamento({ valorCentavos, candidatas }) {
  if (candidatas.length === 0) return { caso: "NENHUMA" };
  const exatas = candidatas.filter((t) => t.saldoCentavos === valorCentavos);
  if (exatas.length === 1) return { caso: "EXATA", conta: exatas[0] };
  if (candidatas.length > 1) return { caso: "VARIAS", candidatas };
  const [t] = candidatas;
  return { caso: valorCentavos > t.saldoCentavos ? "MAIOR" : "MENOR", conta: t };
}

/** Termos da legenda/categoria → trechos do nome de categoria do plano de contas (despesa/custo). Só sugere; a IA não escolhe conta. */
const SINONIMOS = Object.freeze([
  [/\b(brownie|brownies|bolo|doce|sorvete|acai|fruta|ingrediente|ingredientes|mercadoria|insumo|insumos|compra)\b/, ["insumo", "mercadoria", "materia prima"]],
  [/\b(descartavel|descartaveis|embalagem|embalagens|copo|copos|colher|sacola|sacolas)\b/, ["embalag", "descartav"]],
  [/\b(gas)\b/, ["gas"]],
  [/\b(luz|energia|eletrica)\b/, ["energia"]],
  [/\b(aluguel)\b/, ["aluguel"]],
  [/\b(agua)\b/, ["agua"]],
  [/\b(limpeza)\b/, ["limpez"]],
  [/\b(manutencao|conserto|reparo)\b/, ["manuten"]],
]);
/**
 * Escolhe a categoria do plano pela descrição: exatamente UMA categoria lançável de custo/despesa que case; senão null (o motor
 * usa a provisória "a classificar" e avisa). Nunca inventa código: só devolve um código que existe no plano da unidade.
 */
export function escolherCategoria({ categorias, categoriaSugerida, legenda }) {
  const lancaveis = (categorias ?? []).filter((c) => c?.aceitaLancamento && c.ativa !== false && ["CUSTO", "DESPESA"].includes(c.natureza));
  const consulta = normalizar(`${String(categoriaSugerida ?? "").replace(/_/g, " ")} ${legenda ?? ""}`);
  if (!consulta) return null;
  const alvos = new Set();
  for (const [regra, termos] of SINONIMOS) if (regra.test(consulta)) termos.forEach((x) => alvos.add(x));
  for (const w of normalizar(String(categoriaSugerida ?? "").replace(/_/g, " ")).split(" ")) if (w.length >= 4) alvos.add(w);
  if (alvos.size === 0) return null;
  const casadas = lancaveis.filter((c) => { const n = normalizar(c.nome); return [...alvos].some((a) => n.includes(a)); });
  const unicas = [...new Map(casadas.map((c) => [c.codigo, c])).values()];
  return unicas.length === 1 ? unicas[0].codigo : null;
}
