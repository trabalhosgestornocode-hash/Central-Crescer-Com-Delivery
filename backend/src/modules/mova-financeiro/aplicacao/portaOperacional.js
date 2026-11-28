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
  // 26/11: sem arquivo arquivado, o comprovante vira uma FICHA (hash) no banco — o banco exige `enviar_documento` para gravar a ficha.
  vincularPagamentoDoExtrato: ["VINCULAR_PAGAMENTO", "ENVIAR_DOCUMENTO"],
  anexarDocumentoDoEntregador: "ENVIAR_DOCUMENTO",
  // Execução 17: pagamento por comprovante (sem saída bancária) e, quando o extrato chega, a conciliação com a MESMA baixa.
  registrarPagamentoPorComprovante: ["BAIXAR_POR_COMPROVANTE", "ENVIAR_DOCUMENTO"],
  conciliarPagamentoPorComprovante: "VINCULAR_PAGAMENTO",
  // 23/11: conta a pagar NOVA a partir do documento (só com a ação estreita; política e chave próprias).
  registrarObrigacaoDocumental: "REGISTRAR_OBRIGACAO",
  // 23/11: pagamento por comprovante COM encargo (juros/multa confirmados) — ação estreita `registrar_juros` (migração 0031).
  registrarPagamentoComEncargo: ["BAIXAR_POR_COMPROVANTE", "REGISTRAR_JUROS", "ENVIAR_DOCUMENTO"], // exige as DUAS ações (o contexto leva só [ver, as duas])
  // 24/11: compra NOVA já paga — conta + comprovante + pagamento por comprovante numa ÚNICA transação do Financeiro (as mesmas
  // três ações que a sequência antiga já exigia; nenhuma concessão nova).
  registrarDespesaPagaPorComprovante: ["REGISTRAR_OBRIGACAO", "BAIXAR_POR_COMPROVANTE", "ENVIAR_DOCUMENTO"],
  // 25/11: compra nova paga com juros/multa DISCRIMINADOS no comprovante — a mesma operação atômica + `registrar_juros`.
  registrarDespesaPagaComEncargo: ["REGISTRAR_OBRIGACAO", "BAIXAR_POR_COMPROVANTE", "ENVIAR_DOCUMENTO", "REGISTRAR_JUROS"],
  // MOVA CORE F4 (24/11): prestação de contas da SANGRIA — despesa paga com a PRÓPRIA retirada (conta + liquidação contra a saída
  // da sangria, numa transação) e troco devolvido ao MESMO caixa. Nenhuma saída nova; o núcleo trava a retirada e recusa excedente.
  // 25/11: ação ESTREITA `prestar_sangria` (0032) — nunca a ampla `registrar` (que o provedor operacional recusa).
  registrarDespesaDaSangria: "PRESTAR_SANGRIA",
  registrarTrocoDaSangria: "PRESTAR_SANGRIA",
  // 26/11: conta a pagar RELATADA por texto (parcelas explícitas, em aberto, sem documento) — ação ESTREITA própria (0033); a de
  // conta por documento (`registrar_obrigacao`) não cobre esta modalidade.
  registrarContaParcelada: "REGISTRAR_CONTA_PARCELADA",
  // 27/11 (0035): EMPRÉSTIMO — a mesma conta relatada / o mesmo pagamento por comprovante, só na categoria do principal (+ registrar_emprestimo)
  registrarContaParceladaDeEmprestimo: ["REGISTRAR_CONTA_PARCELADA", "REGISTRAR_EMPRESTIMO"],
  registrarPagamentoDeEmprestimoPorComprovante: ["REGISTRAR_OBRIGACAO", "BAIXAR_POR_COMPROVANTE", "ENVIAR_DOCUMENTO", "REGISTRAR_EMPRESTIMO"],
  // 28/11 (0036): correção cadastral de conta a pagar aberta e sem pagamento (fornecedor, vencimento, descrição, observação, forma)
  corrigirContaAPagar: "CORRIGIR_CONTA_A_PAGAR",
  // 28/11 (0037): fase 2 — cada operação com a SUA ação estreita
  reclassificarContaAPagar: "RECLASSIFICAR_CONTA_A_PAGAR",
  ajustarValorDeContaAPagar: "AJUSTAR_CONTA_A_PAGAR",
  moverCompetenciaDeContaAPagar: "MOVER_COMPETENCIA_CONTA_A_PAGAR",
  cancelarContaAPagar: "CANCELAR_CONTA_A_PAGAR",
});
/**
 * 27/11 — operações que gravam em DUAS empresas numa transação (passivo numa, ativo na outra). Ação ESTREITA nas duas; nunca a
 * ampla `registrar`. Conta NOVA na devedora não passa por aqui (exigiria registrar conta): fica para a aprovação humana.
 */
export const OPERACOES_ENTRE_EMPRESAS = Object.freeze({ registrarPagamentoPorOutraEmpresa: "REGISTRAR_INTERCOMPANY" });
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
    /**
     * 27/11 (PR #236) — operação entre empresas pela identidade operacional: a ação ESTREITA `registrar_intercompany` tem de estar
     * na concessão gravada da identidade nas DUAS unidades (lida agora); cada lado recebe só [ver, registrar_intercompany].
     */
    async podeEntreEmpresas(op, escopos) {
      const acao = OPERACOES_ENTRE_EMPRESAS[op] && ACAO[OPERACOES_ENTRE_EMPRESAS[op]];
      if (!acao || !Array.isArray(escopos) || escopos.length !== 2) return false;
      for (const e of escopos) { const acoes = await acoesNaUnidade(e); if (!acoes.includes(ACAO.VER) || !acoes.includes(acao)) return false; }
      return true;
    },
    async chamarEntreEmpresas(op, [devedora, credora] = [], entrada) {
      const acao = OPERACOES_ENTRE_EMPRESAS[op] && ACAO[OPERACOES_ENTRE_EMPRESAS[op]];
      if (!acao || typeof nucleo[op] !== "function" || !devedora || !credora) throw new ErroDeExecucao("OPERACAO_NAO_PERMITIDA", { op });
      for (const e of [devedora, credora]) { const acoes = await acoesNaUnidade(e); if (!acoes.includes(ACAO.VER) || !acoes.includes(acao)) throw new ErroDeExecucao("SEM_CONCESSAO_OPERACIONAL", { op, unidadeId: e.unidadeId }); }
      const ctx = (e) => ({ organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: identidade, permissoes: [ACAO.VER, acao] });
      try { return await nucleo[op](ctx(devedora), ctx(credora), entrada); } catch (e) {
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
