// Limites de CMV EM USO — os da unidade do contexto atual, ou os defaults
// oficiais do sistema quando a unidade não tem `unidade_config`.
//
// POR QUE UM MÓDULO SÓ PRA ISSO
//   `statusCmv()` (utils.js) classifica CADA produto/linha. Buscar a config
//   por linha seria N chamadas de rede. Aqui a config é carregada UMA vez
//   (app.js#mostrarApp, ao entrar/trocar de unidade) e todo mundo reusa.
//
//   Ao trocar de unidade o contexto reseta (registrarResetDeContexto) e os
//   limites voltam ao default até a config nova ser carregada — nunca
//   reaproveita os da unidade anterior.
import { CMV_LIMITES } from "./config.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";

// Default oficial do sistema (fonte única do número: config.js).
const PADRAO = Object.freeze({
  saudavel: Number(CMV_LIMITES.saudavel),
  atencao: Number(CMV_LIMITES.atencao),
});

let atual = { ...PADRAO };

/** Limites em uso agora ({ saudavel, atencao }). Sempre um objeto válido. */
export function limitesCmv() {
  return atual;
}

/**
 * Define os limites a partir da resposta de /api/v1/unidade/metas-cmv
 * (aceita camelCase `cmvSaudavel/cmvAtencao` ou já `{saudavel,atencao}`).
 * Valores ausentes/ inválidos caem no default do sistema — nunca quebram.
 */
export function definirLimitesCmv(cfg) {
  const s = Number(cfg?.cmvSaudavel ?? cfg?.saudavel);
  const a = Number(cfg?.cmvAtencao ?? cfg?.atencao);
  atual = {
    saudavel: Number.isFinite(s) && s > 0 ? s : PADRAO.saudavel,
    atencao: Number.isFinite(a) && a > 0 ? a : PADRAO.atencao,
  };
  return atual;
}

/** Volta ao default do sistema. */
export function resetarLimitesCmv() {
  atual = { ...PADRAO };
  return atual;
}

// Troca de empresa/unidade: zera antes de a config nova chegar.
registrarResetDeContexto(resetarLimitesCmv);
