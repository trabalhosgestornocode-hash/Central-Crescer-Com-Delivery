import { CODIGOS } from "./errors.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recusa = () => Object.assign(new Error("Operação de conexão obsoleta ou indisponível."), { status: 409, statusCode: 409, codigo: "OPERACAO_INVALIDA" });

// Recusas anteriores a qualquer efeito externo (guardas no início de conectar/desconectar/resetar): provadamente sem efeito.
const DETERMINISTICOS = new Set([CODIGOS.SEM_LEASE, CODIGOS.JA_CONECTADO, CODIGOS.NAO_CONECTADO]);
const deterministico = (e) => e?.antesDoEfeito === true || DETERMINISTICOS.has(e?.codigo);

/** Token consumido no PostgreSQL ANTES do efeito. Sem ACK a trava persiste; timeout não autoriza takeover. */
export function criarExecutorOperacao(sessao, backendClient) {
  const acoes = {
    CONECTAR: () => sessao.conectar({ persistirIntencaoConectada: true }),
    ENCERRAR: () => sessao.desconectar({ persistirIntencao: true }),
    DESCONECTAR: () => sessao.desconectarConta({ desvincular: true }),
    RESET: () => sessao.resetarSessao(),
  };
  return async ({ operacaoId, token, acao } = {}) => {
    if (!UUID.test(operacaoId ?? "") || !UUID.test(token ?? "") || !Object.hasOwn(acoes, acao)) throw recusa();
    const contexto = { operacaoId, token, acao };
    if ((await backendClient.operacaoEfeito({ ...contexto, fase: "CONSUMIR" }))?.ok !== true) throw recusa();
    try {
      const resultado = await acoes[acao]();
      if ((await backendClient.operacaoEfeito({ ...contexto, fase: "CONCLUIR" }))?.ok !== true) throw recusa();
      return resultado ?? { ok: true };
    } catch (error) {
      // Falha determinística ANTES do efeito: libera sem reconciliação. Qualquer outra (timeout, queda, resposta perdida) é incerteza real.
      if (deterministico(error) && (await backendClient.operacaoEfeito({ ...contexto, fase: "FALHA_DETERMINISTICA" }).catch(() => null))?.ok === true) throw error;
      await backendClient.operacaoEfeito({ ...contexto, fase: "INCERTO" }).catch(() => {});
      error.reconciliacaoNecessaria = true;
      throw error;
    }
  };
}
