// FONTES DE RECEITA por unidade — o MOVA nunca forma receita, e nunca deixa a mesma venda ser contada duas vezes.
//
// Regra do Financeiro v2 (aplicacao/formacao.js, CANAIS_SO_PELA_FONTE_OFICIAL; aplicacao/fontesDeFaturamento.js):
//   - balcão/presencial: pelo sistema de loja da unidade (SAIPOS ou SWF) — exatamente um;
//   - iFood e 99Food: SÓ pela fonte oficial da plataforma; o pedido que aparece no PDV serve apenas para conferência;
//   - Anota AI: entra pela SAIPOS (por pedido), quando a unidade usa SAIPOS.
// O MOVA recebe documento de VENDA (relatório, print de repasse) só como evidência: ele responde qual é a fonte oficial e
// não cria proposta de receita. Unidade com fontes "A_CONFIRMAR" ⇒ nenhuma resposta presume fonte.
import { SITUACAO_FONTES } from "./configuracao.js";

export const CANAIS_SO_PELA_PLATAFORMA = Object.freeze(["IFOOD", "NOVENTA_E_NOVE_FOOD"]);

/**
 * Fonte oficial de cada canal na unidade.
 * @returns {{situacao:string, canais:Record<string,string>}} canal → fonte oficial ("SWF", "SAIPOS", "IFOOD", ...)
 */
export function fontesOficiais(unidade) {
  const f = unidade.fontes;
  if (f.situacao !== SITUACAO_FONTES.CONFIRMADA) return { situacao: f.situacao, canais: {} };
  const canais = { BALCAO: f.sistemaDeLoja };
  for (const p of f.plataformas) canais[p] = p;
  if (f.anotaAiPelaSaipos) canais.ANOTA_AI = "SAIPOS";
  return { situacao: f.situacao, canais };
}

/**
 * A receita de `canal` pode vir de `fonte` nesta unidade? (false = contaria em dobro ou fonte não configurada)
 */
export function receitaPodeVirDe(unidade, canal, fonte) {
  const { situacao, canais } = fontesOficiais(unidade);
  if (situacao !== SITUACAO_FONTES.CONFIRMADA) return false;
  if (CANAIS_SO_PELA_PLATAFORMA.includes(canal)) return fonte === canal && canais[canal] === canal;
  return canais[canal] === fonte;
}
