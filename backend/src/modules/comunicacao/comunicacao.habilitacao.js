// Habilitação de WhatsApp PROATIVO por empresa (organização) e por tipo de
// alerta — a segunda metade do "fail-closed" do D.3-C (a primeira é o
// consentimento por CONTATO, em comunicacao.policy.js).
//
// AUDITORIA (D.3): não existe hoje uma estrutura com a semântica correta.
//   * `comunicacao_configuracoes` é GLOBAL (chave/valor), não por empresa.
//   * `organizacao_modulos` (shared/modulos.js, migration 030) é um dado por
//     empresa e poderia carregar o "habilitado SIM/NÃO", mas NÃO carrega
//     tipos de alerta permitidos, timezone nem pausa temporária — e criar um
//     módulo novo mexe no catálogo/menu do frontend.
//   Decisão (D.3): NÃO criar schema sem aprovação. Enquanto a estrutura
//   definitiva não existe, a resposta padrão é FECHADA: nenhuma empresa está
//   habilitada e nenhum tipo é permitido — logo NENHUMA mensagem proativa
//   pode sair, mesmo que haja telefone cadastrado, consentimento e modo
//   NORMAL. O desenho da migration futura está no relatório do D.3.
//
// `processarProximoLote` recebe esta função por injeção (como
// `verificarPendenciaAindaExiste`) — os testes injetam uma habilitação
// explícita; produção usa este padrão fechado.

/**
 * @typedef {object} Habilitacao
 * @property {boolean} empresaHabilitada  a empresa optou por receber WhatsApp proativo?
 * @property {boolean} tipoPermitido      este tipo de alerta está entre os permitidos dela?
 * @property {string}  fonte              de onde veio a decisão (diagnóstico/auditoria)
 */

/**
 * @param {{organizacaoId: string, tipoAlerta: string}} _params
 * @param {{supabase?: any}} [_deps]
 * @returns {Promise<Habilitacao>}
 */
export async function resolverHabilitacaoEmpresa(_params, _deps = {}) {
  return { empresaHabilitada: false, tipoPermitido: false, fonte: "SEM_ESTRUTURA_DE_HABILITACAO" };
}
