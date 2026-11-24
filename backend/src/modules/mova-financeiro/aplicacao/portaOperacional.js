// PORTA OPERACIONAL do MOVA (Agente 2 — Frentes C e D): o ÚNICO caminho de ESCRITA do agente até o Financeiro v2.
//
// Separada da porta de leitura de propósito:
//   - usa uma IDENTIDADE OPERACIONAL própria, distinta da identidade de leitura (piloto/operação). A credencial só-leitura do
//     piloto NUNCA chega aqui (o núcleo injetado é o de escrita, montado pela integração com a identidade operacional);
//   - lista FECHADA de operações de escrita, cada uma com a ÚNICA ação que ela exige; nenhuma paga, estorna, cancela ou apaga;
//   - a ação precisa estar na CONCESSÃO gravada da identidade operacional NAQUELA unidade (lida a cada chamada: revogar vale
//     na hora). O contexto leva só [ver, ação]: nunca o poder de quem fala com o MOVA;
//   - o núcleo do Financeiro confere tudo de novo (permissão, escopo, competência, versão, idempotência, auditoria).
import { ErroTransitorio } from "../gateway/fila.js";
import { exigirContratoFinanceiro } from "./portaFinanceira.js";

export class ErroDeExecucao extends Error {
  constructor(codigo, detalhes = {}) { super(codigo); this.name = "ErroDeExecucao"; this.codigo = codigo; this.detalhes = detalhes; }
}

/** Operação de escrita → nome da ação (chave de ACAO) que ela exige. Qualquer outra é recusada antes do núcleo. */
export const OPERACOES_DE_ESCRITA = Object.freeze({
  enviarEvidencia: "ENVIAR_DOCUMENTO",
  vincularPagamentoDoExtrato: "VINCULAR_PAGAMENTO",
  anexarDocumentoDoEntregador: "ENVIAR_DOCUMENTO",
  // Execução 17: pagamento por comprovante (sem saída bancária) e, quando o extrato chega, a conciliação com a MESMA baixa.
  registrarPagamentoPorComprovante: "BAIXAR_POR_COMPROVANTE",
  conciliarPagamentoPorComprovante: "VINCULAR_PAGAMENTO",
  // 23/11: conta a pagar NOVA a partir do documento (só com a ação estreita; política e chave próprias).
  registrarObrigacaoDocumental: "REGISTRAR_OBRIGACAO",
  // 23/11: pagamento por comprovante COM encargo (juros/multa confirmados) — ação estreita `registrar_juros` (migração 0031).
  registrarPagamentoComEncargo: ["BAIXAR_POR_COMPROVANTE", "REGISTRAR_JUROS"], // exige as DUAS ações (o contexto leva só [ver, as duas])
  // 24/11: compra NOVA já paga — conta + comprovante + pagamento por comprovante numa ÚNICA transação do Financeiro (as mesmas
  // três ações que a sequência antiga já exigia; nenhuma concessão nova).
  registrarDespesaPagaPorComprovante: ["REGISTRAR_OBRIGACAO", "BAIXAR_POR_COMPROVANTE", "ENVIAR_DOCUMENTO"],
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{nucleo:object, concessoes:{listar:Function}, financeiro:object, identidade:string, identidadeLeitura:string}} deps
 */
export function criarPortaOperacional({ nucleo, concessoes, financeiro, identidade, identidadeLeitura }) {
  const { ACAO, ErroFinanceiro } = exigirContratoFinanceiro(financeiro);
  if (!nucleo || !concessoes?.listar) throw new TypeError("porta operacional exige núcleo e concessões");
  if (!UUID.test(identidade ?? "")) throw new TypeError("identidade operacional inválida");
  if (String(identidade).toLowerCase() === String(identidadeLeitura ?? "").toLowerCase()) throw new TypeError("a identidade operacional precisa ser DIFERENTE da identidade de leitura do MOVA");
  for (const k of Object.values(OPERACOES_DE_ESCRITA).flat()) if (typeof ACAO[k] !== "string") throw new TypeError(`contrato do Financeiro sem a ação ${k}`);

  /** Ações exigidas pela operação (uma ou mais), já no valor do contrato; undefined se a operação não é de escrita do MOVA. */
  const acoesDaOperacao = (op) => {
    const chaves = [].concat(OPERACOES_DE_ESCRITA[op] ?? []);
    return chaves.length && chaves.every((k) => typeof ACAO[k] === "string") ? chaves.map((k) => ACAO[k]) : undefined;
  };

  async function acoesNaUnidade({ organizacaoId, unidadeId }) {
    let lista;
    try { lista = await concessoes.listar({ organizacaoId, usuarioId: identidade }); } catch { throw new ErroTransitorio("CONCESSOES_INDISPONIVEIS"); }
    return (lista ?? []).find((c) => c.unidadeId === unidadeId)?.acoes ?? [];
  }

  return Object.freeze({
    identidade,
    /** A identidade operacional pode executar `op` nesta unidade (concessão gravada)? */
    async pode(op, escopo) {
      const exigidas = acoesDaOperacao(op);
      if (!exigidas) return false;
      const acoes = await acoesNaUnidade(escopo);
      return acoes.includes(ACAO.VER) && exigidas.every((a) => acoes.includes(a));
    },
    async chamar(op, escopo, entrada) {
      const exigidas = acoesDaOperacao(op);
      if (!exigidas || typeof nucleo[op] !== "function") throw new ErroDeExecucao("OPERACAO_NAO_PERMITIDA", { op });
      const acoes = await acoesNaUnidade(escopo);
      if (!acoes.includes(ACAO.VER) || !exigidas.every((a) => acoes.includes(a))) throw new ErroDeExecucao("SEM_CONCESSAO_OPERACIONAL", { op });
      const ctx = { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, usuarioId: identidade, permissoes: [ACAO.VER, ...exigidas] };
      try { return await nucleo[op](ctx, entrada); } catch (e) {
        if (e instanceof ErroFinanceiro) throw e;
        throw new ErroTransitorio("FINANCEIRO_INDISPONIVEL");
      }
    },
  });
}

/** Adaptador para quando uma PESSOA confirma na Central: mesma lista fechada, com o contexto VERIFICADO dela (sessão). */
export function executorDaPessoa({ nucleo, ctx }) {
  return Object.freeze({
    identidade: ctx.usuarioId,
    async chamar(op, escopo, entrada) {
      if (!OPERACOES_DE_ESCRITA[op] || typeof nucleo[op] !== "function") throw new ErroDeExecucao("OPERACAO_NAO_PERMITIDA", { op });
      if (escopo.organizacaoId !== ctx.organizacaoId || escopo.unidadeId !== ctx.unidadeId) throw new ErroDeExecucao("FORA_DO_ESCOPO");
      return nucleo[op](ctx, entrada);
    },
  });
}
