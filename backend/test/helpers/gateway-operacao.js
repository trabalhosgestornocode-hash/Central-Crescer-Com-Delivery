import { criarExecutorOperacao } from "../../../gateway-whatsapp/src/operacaoConexao.js";
import { transicaoEfeito } from "../../src/modules/comunicacao/comunicacao.operacoes.js";

/** Provider simulado, protocolo de fencing real; pode usar fake DB ou PostgreSQL de teste. */
export function instalarExecutorTeste(svc, deps) {
  svc.conexaoExecutarOperacao = criarExecutorOperacao({
    conectar: () => svc.conexaoConectar(), desconectar: () => svc.conexaoEncerrar(),
    desconectarConta: () => svc.conexaoDesconectarConta({ desvincular: true }), resetarSessao: () => svc.conexaoEncerrar(),
  }, { operacaoEfeito: async (p) => ({ ok: await transicaoEfeito({ ...p, organizacaoId: deps.organizacaoConexaoId }, deps) }) });
  return svc;
}
