// IDENTIDADE OPERACIONAL do MOVA (Execução 17): o provedor que a montagem do MOVA pede quando MOVA_OPERACAO_ESCRITA=1.
// Cada chamada roda no contexto de AUTOMAÇÃO da plataforma com a referência própria "automacao:mova-operacional": a sessão de
// banco é aberta PARA a identidade operacional e só existe se ela tiver concessão ATIVA na unidade (fv2_abrir_sessao). Não há
// credencial nova, papel novo nem atalho: o banco (RLS + gatilhos da 0018/0029) continua decidindo o que a sessão pode gravar.
//
// Perfis de permissão (o que conceder à identidade, unidade por unidade, sempre junto com `ver`):
//   CONSULTAR                     ver
//   ANEXAR_DOCUMENTOS             enviar_documento
//   REGISTRAR_PAGAMENTO_COMPROVANTE  baixar_por_comprovante (+ enviar_documento para anexar o comprovante)
//   VINCULAR_EXTRATO              vincular_pagamento (liga a saída do extrato; nunca cria saída)
//   CRIAR_OBRIGACOES              registrar_obrigacao (estreita: conta a pagar de UMA parcela, despesa, com documento — 0030);
//                                 só com política e chave próprias; NÃO concedida em produção sem política específica
//   PAGAR_COM_ENCARGO             registrar_juros (+ baixar_por_comprovante + enviar_documento): pagamento por comprovante com juros/multa
//                                 confirmados; teto de 10% da conta; só com política JUROS_DOCUMENTAL e chave própria (0031)
//   REVERTER_OPERACOES            NÃO concedido ao MOVA: estorno é do responsável (cancelar), pela Central
// Ações amplas (registrar, corrigir, cancelar, configurar, conceder, revogar, aplicar, homologar, reabrir) são RECUSADAS aqui.
export const PERFIS_OPERACIONAIS = Object.freeze({
  CONSULTAR: Object.freeze(["financeiro_v2.ver"]),
  ANEXAR_DOCUMENTOS: Object.freeze(["financeiro_v2.ver", "financeiro_v2.enviar_documento"]),
  REGISTRAR_PAGAMENTO_COMPROVANTE: Object.freeze(["financeiro_v2.ver", "financeiro_v2.enviar_documento", "financeiro_v2.baixar_por_comprovante"]),
  VINCULAR_EXTRATO: Object.freeze(["financeiro_v2.ver", "financeiro_v2.vincular_pagamento"]),
  CRIAR_OBRIGACOES: Object.freeze(["financeiro_v2.ver", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_obrigacao"]),
  PAGAR_COM_ENCARGO: Object.freeze(["financeiro_v2.ver", "financeiro_v2.enviar_documento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_juros"]),
});
export const ACOES_PERMITIDAS_AO_MOVA = Object.freeze([...new Set(Object.values(PERFIS_OPERACIONAIS).flat())]);

/**
 * @param {{repositorio:object, rodar:(fn:Function)=>Promise<any>, criarNucleoFinanceiro:Function, criarConcessoesDoRepositorio:Function, relogio?:Function}} deps
 * @returns {(p:{identidade:string, escopos:{organizacaoId:string, unidadeId:string}[]}) => Promise<{nucleo:object, concessoes:{listar:Function}}>}
 */
export function criarOperacionalMova({ repositorio, rodar, criarNucleoFinanceiro, criarConcessoesDoRepositorio, relogio }) {
  if (!repositorio || typeof rodar !== "function") throw new TypeError("operacional do MOVA exige repositório e contexto de automação");
  return async ({ identidade, escopos }) => {
    if (!Array.isArray(escopos) || escopos.length === 0) throw Object.assign(new Error("sem escopos"), { codigo: "SEM_ESCOPO" });
    const base = criarNucleoFinanceiro({ repositorio, exigirConcessaoPersistida: true, escoposAutorizados: escopos, ...(relogio ? { relogio } : {}) });
    const nucleo = Object.freeze(Object.fromEntries(Object.entries(base).map(([k, f]) => [k, typeof f === "function" ? (...a) => rodar(() => f(...a)) : f])));
    const lista = criarConcessoesDoRepositorio({ repositorio, escopos });
    const concessoes = Object.freeze({
      async listar({ organizacaoId, usuarioId }) {
        if (String(usuarioId).toLowerCase() !== String(identidade).toLowerCase()) return []; // só a própria identidade
        const r = await rodar(() => lista.listar({ organizacaoId, usuarioId }));
        // Concessão com ação ampla é tratada como AUSENTE para o MOVA (falha fechada): o MOVA nunca opera com permissão larga.
        return r.map((c) => (c.acoes.every((a) => ACOES_PERMITIDAS_AO_MOVA.includes(a)) ? c : { ...c, acoes: [], recusada: "ACAO_AMPLA_NA_CONCESSAO" }));
      },
    });
    return { nucleo, concessoes };
  };
}
