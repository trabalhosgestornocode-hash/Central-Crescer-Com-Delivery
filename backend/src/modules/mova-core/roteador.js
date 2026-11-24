// MOVA CORE — F1: ROTEAMENTO. Perguntas em linguagem natural vão para o LAÇO DE FERRAMENTAS (o modelo combina capacidades;
// não há intenção fechada por pergunta). O caminho DETERMINÍSTICO fica só para:
//   • documento/anexo (pipeline de leitura e conferência do motor atual);
//   • resposta INEQUÍVOCA a uma pergunta pendente do MOVA ("sim", "não", "pode", "cancela") — o motor atual já vincula a
//     confirmação à mesma pessoa e à versão da conta (dominio/confirmacao.js);
//   • segurança (tentativa de mudar regras, obter instruções internas, agir por outra pessoa/unidade): recusa fixa.
// O extrator de intenções fechadas antigo continua SÓ como compatibilidade/fallback (núcleo de IA desligado, orçamento
// esgotado, falha). Saudação pura só é tratada sem IA se a mensagem for INTEIRAMENTE saudação — nada de expressão regular
// que capture o começo de uma pergunta ("oi, quanto devemos…" vai para as ferramentas).
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[!.?,;:]+/g, " ").replace(/\s+/g, " ").trim();
const CONFIRMACAO = new Set(["sim", "s", "nao", "n", "pode", "pode sim", "confirmo", "confirmado", "isso", "isso mesmo", "ok", "certo", "correto", "cancela", "cancelar", "nao pode", "errado", "pode registrar", "sim pode"]);
const SAUDACAO = new Set(["oi", "ola", "bom dia", "boa tarde", "boa noite", "e ai", "opa", "oi mova", "ola mova", "bom dia mova", "boa tarde mova", "boa noite mova"]);
const SEGURANCA = [
  /\b(ignore|ignora|ignorar|esquece|esqueca|esquecer|desconsidere|desconsidera)\b.{0,40}\b(instruc|regra|orienta|limite|permiss)/,
  /\b(mostre|mostra|revele|me (de|da|passa))\b.{0,30}\b(prompt|instruc(ao|oes) (internas|do sistema)|chave|token|senha)\b/,
  /\b(voce agora e|finja que|aja como)\b/,
  /\b(libera|liberar|me (de|da)|conceda)\b.{0,30}\b(permissao|acesso|admin)/,
  /\b(em nome d[eoa]|como se fosse)\b.{0,30}\b(aprova|confirma|paga)/,
];

export const ROTA = Object.freeze({ DOCUMENTO: "DOCUMENTO", CONFIRMACAO: "CONFIRMACAO", SEGURANCA: "SEGURANCA", SAUDACAO: "SAUDACAO", FERRAMENTAS: "FERRAMENTAS", FALLBACK_EXTRATOR: "FALLBACK_EXTRATOR" });

/**
 * @param {{texto?:string, temAnexo?:boolean, pendenciaAberta?:boolean, nucleoDisponivel?:boolean}} m
 */
export function decidirRota({ texto, temAnexo = false, pendenciaAberta = false, nucleoDisponivel = true }) {
  const n = norm(texto);
  if (temAnexo) return { rota: ROTA.DOCUMENTO, motivo: "ANEXO" };
  if (SEGURANCA.some((r) => r.test(n))) return { rota: ROTA.SEGURANCA, motivo: "PEDIDO_DE_SEGURANCA" };
  if (pendenciaAberta && CONFIRMACAO.has(n.replace(/^mova /, ""))) return { rota: ROTA.CONFIRMACAO, motivo: "RESPOSTA_INEQUIVOCA_A_PENDENCIA" };
  if (SAUDACAO.has(n)) return { rota: ROTA.SAUDACAO, motivo: "SO_SAUDACAO" };
  if (!n) return { rota: ROTA.SAUDACAO, motivo: "VAZIA" };
  if (!nucleoDisponivel) return { rota: ROTA.FALLBACK_EXTRATOR, motivo: "NUCLEO_INDISPONIVEL" };
  return { rota: ROTA.FERRAMENTAS, motivo: "LINGUAGEM_NATURAL" };
}

export const RESPOSTAS_FIXAS = Object.freeze({
  SEGURANCA: "Não consigo fazer isso. Minhas regras e permissões não mudam pela conversa.",
  SAUDACAO: "Oi! Pode perguntar sobre contas, pagamentos, caixa, vendas ou entregadores da unidade.",
});
