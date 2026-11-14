// POLÍTICA DO GATEWAY DE AUTORIDADE (Execução 09B) — contrato PURO que o gateway real deverá aplicar antes de emitir
// qualquer sessão de banco (`fv2_abrir_sessao`). O gateway é o ÚNICO processo com a credencial `fv2_autoridade`; o
// serviço comum da aplicação nunca a vê. Este módulo não emite nada: decide e descreve.
//
// Regras:
//   - a identidade vem da sessão da PLATAFORMA verificada (mesmas recusas do adaptador: impersonação, perfil de
//     exibição, senha provisória, contexto divergente, "todas as unidades", expirada);
//   - conta compartilhada nunca recebe sessão financeira;
//   - escopo: UMA organização e UMA unidade (as da sessão); o pedido não escolhe escopo nem ações (vêm da concessão);
//   - finalidades sensíveis (ação com MFA, provisionamento, liberação) exigem prova VERIFICADA de segundo fator da
//     MESMA conta (provaDeAutenticacao.js);
//   - validade curta: ≤ 15 min (≤ 5 min para finalidade sensível) e nunca além da sessão da plataforma;
//   - eventos sem token, senha, segredo ou cabeçalho de autorização.
import { identificarSessao } from "./plataforma.js";
import { ehUuid } from "../dominio/validacao.js";

export const FINALIDADE = Object.freeze({ OPERACAO: "OPERACAO", ACAO_SENSIVEL: "ACAO_SENSIVEL", PROVISIONAMENTO: "PROVISIONAMENTO", LIBERACAO: "LIBERACAO" });
const SENSIVEIS = [FINALIDADE.ACAO_SENSIVEL, FINALIDADE.PROVISIONAMENTO, FINALIDADE.LIBERACAO];
export const VALIDADE_MAXIMA_S = 15 * 60;
export const VALIDADE_SENSIVEL_S = 5 * 60;

/**
 * @param {object} e
 * @param {object} e.sessao sessão da plataforma verificada no servidor ({ user, tenant, acesso })
 * @param {{finalidade:string, unidadeId?:string}} e.pedido o que o serviço da aplicação pede (sem escopo nem ações)
 * @param {{ok:boolean, contaId?:string}|null} e.prova prova de segundo fator verificada (ou null)
 * @param {boolean} e.contaPessoal a conta tem exatamente uma pessoa ativa
 * @param {string[]} e.acoesConcedidas ações da concessão VIGENTE no banco (lidas pelo gateway, não pelo pedido)
 * @param {number} e.agoraMs
 * @returns {{emitir:true, escopo:{organizacaoId, unidadeId, usuarioId}, acoes:string[], validadeSegundos:number, exigiuSegundoFator:boolean}|{emitir:false, motivo:string}}
 */
export function decidirEmissao({ sessao, pedido, prova = null, contaPessoal, acoesConcedidas = [], agoraMs }) {
  let s;
  try { s = identificarSessao(sessao, agoraMs); } catch (e) { return { emitir: false, motivo: e?.detalhes?.motivo ?? "SESSAO_INVALIDA" }; }
  if (!pedido || typeof pedido !== "object" || !Object.values(FINALIDADE).includes(pedido.finalidade)) return { emitir: false, motivo: "FINALIDADE_INVALIDA" };
  for (const proibido of ["organizacaoId", "acoes", "permissoes", "usuarioId", "validadeSegundos"]) {
    if (proibido in pedido) return { emitir: false, motivo: "PEDIDO_TENTA_DEFINIR_ESCOPO" };
  }
  if (pedido.unidadeId !== undefined && (!ehUuid(pedido.unidadeId) || pedido.unidadeId.toLowerCase() !== s.unidadeId)) return { emitir: false, motivo: "UNIDADE_DIFERENTE_DA_SESSAO" };
  if (contaPessoal !== true) return { emitir: false, motivo: "CONTA_COMPARTILHADA" };
  const sensivel = SENSIVEIS.includes(pedido.finalidade);
  if (sensivel && (!prova?.ok || String(prova.contaId ?? "").toLowerCase() !== s.contaId)) return { emitir: false, motivo: "SEM_PROVA_DE_SEGUNDO_FATOR" };
  if (pedido.finalidade !== FINALIDADE.PROVISIONAMENTO && pedido.finalidade !== FINALIDADE.LIBERACAO && !(acoesConcedidas?.length > 0)) return { emitir: false, motivo: "SEM_CONCESSAO" };
  const restanteDaPlataformaS = Math.floor((Date.parse(s.expiraEm) - agoraMs) / 1000);
  const validadeSegundos = Math.min(sensivel ? VALIDADE_SENSIVEL_S : VALIDADE_MAXIMA_S, restanteDaPlataformaS);
  if (validadeSegundos < 30) return { emitir: false, motivo: "SESSAO_DA_PLATAFORMA_PERTO_DE_EXPIRAR" };
  return { emitir: true, escopo: { organizacaoId: s.organizacaoId, unidadeId: s.unidadeId, usuarioId: s.perfilId }, acoes: [...acoesConcedidas], validadeSegundos, exigiuSegundoFator: sensivel };
}

const CAMPO_SECRETO = /token|senha|password|segredo|secret|authorization|cookie|chave|pin/i;
const VALOR_PARECE_TOKEN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$|^Bearer\s/i;
/** Evento do gateway pronto para registro: tira qualquer campo/valor que pareça credencial (recursivo). */
export function eventoSemSegredos(evento) {
  const limpar = (v, profundidade = 0) => {
    if (profundidade > 5) return "[profundo]";
    if (Array.isArray(v)) return v.map((x) => limpar(x, profundidade + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !CAMPO_SECRETO.test(k)).map(([k, x]) => [k, limpar(x, profundidade + 1)]));
    if (typeof v === "string" && VALOR_PARECE_TOKEN.test(v)) return "[removido]";
    return v;
  };
  return limpar(evento);
}
