// PILOTO ENCERRADO (migration 104) — este arquivo NÃO decide mais NADA.
//
// A allowlist de telefones do piloto (COMUNICACAO_PILOTO_ENABLED / COMUNICACAO_PILOTO_TELEFONES_E164) foi substituída pela configuração
// definitiva por empresa: habilitação + envio automático + destinatários cadastrados no Painel (comunicacao_habilitacoes,
// comunicacao_contatos_empresa, comunicacao_destinatario_categorias). As variáveis continuam podendo existir no Render, mas:
//   * NENHUMA função daqui autoriza ou bloqueia envio;
//   * NADA cai de volta para elas (nenhum fallback);
//   * só aparecem no diagnóstico técnico como  "LEGACY — sem efeito",  para podermos removê-las num checkpoint separado.
//
// Segurança do diagnóstico: NUNCA devolve o valor bruto nem qualquer telefone — apenas presença e quantidade de entradas.

export const ROTULO_LEGADO = "LEGACY — sem efeito";

/**
 * Diagnóstico das variáveis legadas do piloto. Nunca lança, nunca devolve o valor nem telefones.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{rotulo: string, semEfeito: true, variaveis: {COMUNICACAO_PILOTO_ENABLED: 'presente'|'ausente', COMUNICACAO_PILOTO_TELEFONES_E164: 'presente'|'ausente'}, quantidadeEntradas: number, configurado: boolean}}
 */
export function diagnosticoPilotoLegado(env = process.env) {
  const enabled = env?.COMUNICACAO_PILOTO_ENABLED;
  const telefones = env?.COMUNICACAO_PILOTO_TELEFONES_E164;
  const temEnabled = enabled !== undefined && enabled !== null && String(enabled).trim() !== "";
  const temTelefones = telefones !== undefined && telefones !== null && String(telefones).trim() !== "";
  const quantidadeEntradas = temTelefones ? String(telefones).split(",").map((s) => s.trim()).filter(Boolean).length : 0;
  return {
    rotulo: ROTULO_LEGADO,
    semEfeito: true,
    variaveis: {
      COMUNICACAO_PILOTO_ENABLED: temEnabled ? "presente" : "ausente",
      COMUNICACAO_PILOTO_TELEFONES_E164: temTelefones ? "presente" : "ausente",
    },
    quantidadeEntradas,
    configurado: temEnabled || temTelefones,
  };
}
