// MOVA CORE — F1: ponto de entrada. Junta roteador → laço de ferramentas → executor seguro → verificador, com orçamento,
// continuidade mínima, auditoria, métricas e MODO SOMBRA. Não envia mensagens nem escreve nada: devolve a resposta para quem
// chama decidir (na sombra, só registra a comparação com o motor atual).
import { CATALOGO, FERRAMENTAS, definicoesParaApi } from "./catalogo.js";
import { criarExecutor, novaSessao } from "./executor.js";
import { executarLaco, PADROES_DO_LACO } from "./laco.js";
import { decidirRota, ROTA, RESPOSTAS_FIXAS } from "./roteador.js";
import { criarMemoriaDeConversas } from "./conversa.js";
import { criarMetricas } from "./metricas.js";

export { CATALOGO, FERRAMENTAS, ROTA, decidirRota, definicoesParaApi };
export { verificarFidelidade } from "./verificador.js";
export { criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "./orcamentoMemoria.js";
export { ferramentasDoAgenteCrescer } from "./agenteCrescer.js";
export { custoRealMicrousd, TARIFAS } from "./custo.js";

/**
 * @param {object} deps
 * @param {object} deps.porta       porta de LEITURA do Financeiro (criarPortaFinanceira do MOVA)
 * @param {object|null} deps.cliente cliente da API (messages.create); null ⇒ núcleo indisponível (fallback ao extrator)
 * @param {object} deps.orcamento   reservar/concluir/falhar (renovável em homologação; memória no ambiente isolado)
 * @param {Array}  [deps.ferramentasExtras] p.ex. ferramentasDoAgenteCrescer(...)
 */
export function criarMovaCore({ porta, cliente = null, orcamento, auditoria = { registrar() {} }, ferramentasExtras = [], memoria = criarMemoriaDeConversas(), opcoes = {}, relogio = () => Date.now() }) {
  const catalogo = { ...CATALOGO, ...Object.fromEntries(ferramentasExtras.map((f) => [f.nome, f])) };
  const definicoes = [...definicoesParaApi(), ...ferramentasExtras.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema }))];
  const executor = criarExecutor({ catalogo, porta, auditoria, relogio });
  const metricas = criarMetricas();
  let seq = 0;

  /**
   * @param {object} e  { organizacaoId, conversaId, participanteId, usuarioId, unidadeId, unidadesPermitidas:[{id,nome}], perfil:{nome,consultas},
   *                      podeValores, texto, temAnexo, pendenciaAberta, hoje:'AAAA-MM-DD', requisicaoId? }
   */
  async function responder(e) {
    const requisicaoId = e.requisicaoId ?? `core-${Date.now().toString(36)}-${++seq}`;
    const rota = decidirRota({ texto: e.texto, temAnexo: e.temAnexo, pendenciaAberta: e.pendenciaAberta, nucleoDisponivel: Boolean(cliente) });
    if (rota.rota !== ROTA.FERRAMENTAS) {
      const texto = rota.rota === ROTA.SEGURANCA ? RESPOSTAS_FIXAS.SEGURANCA : rota.rota === ROTA.SAUDACAO ? RESPOSTAS_FIXAS.SAUDACAO : null; // null = o motor atual trata
      metricas.registrar({ rota: rota.rota });
      return { requisicaoId, rota: rota.rota, motivo: rota.motivo, texto, ferramentas: [], uso: null, latenciaMs: 0 };
    }
    if (!e.unidadesPermitidas?.some((u) => u.id === e.unidadeId)) throw new TypeError("a unidade da conversa precisa estar entre as permitidas");
    const conversa = memoria.obter({ organizacaoId: e.organizacaoId, conversaId: e.conversaId, participanteId: e.participanteId });
    const sessao = novaSessao({ conversa, organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId, unidadesPermitidas: e.unidadesPermitidas, perfil: e.perfil, podeValores: e.podeValores, requisicaoId });
    const unidade = e.unidadesPermitidas.find((u) => u.id === e.unidadeId)?.nome ?? "—";
    const r = await executarLaco({
      cliente, executor, sessao, orcamento, ferramentas: definicoes, historico: memoria.historico(conversa), pergunta: String(e.texto).slice(0, 2000),
      ambiente: { hoje: e.hoje, unidade, perfil: e.perfil?.nome ?? "—", podeValores: e.podeValores }, opcoes: { ...PADROES_DO_LACO, ...opcoes }, relogio,
      registrar: (x) => auditoria.registrar(x),
    });
    memoria.registrarTurno(conversa, { pergunta: e.texto, resposta: r.texto, ferramentas: r.ferramentas.map((x) => x.nome), fatos: sessao.fatos });
    auditoria.registrar({ tipo: "MOVA_CORE_RESPOSTA", requisicaoId, rota: rota.rota, motivo: r.motivo, ferramentas: r.ferramentas.map((x) => x.nome), custoMicrousd: r.uso.custoMicrousd, latenciaMs: r.latenciaMs, verificador: r.verificacao?.ok ?? null });
    metricas.registrar({ rota: rota.rota, motivo: r.motivo, ferramentas: r.ferramentas, uso: r.uso, latenciaMs: r.latenciaMs, verificacao: r.verificacao });
    return { requisicaoId, rota: rota.rota, ...r, fatos: sessao.fatos };
  }
  return Object.freeze({ responder, metricas, catalogo, definicoes });
}

/**
 * MODO SOMBRA: roda o MOVA CORE ao lado do motor atual, NUNCA envia nada e nunca derruba o motor. Registra a comparação
 * (rota, ferramentas, resposta resumida, custo, latência, verificador) para avaliação. Ligação em produção: só com autorização.
 */
export function criarSombra({ core, registrar }) {
  return Object.freeze({
    async observar(entrada, legado = {}) {
      try {
        const r = await core.responder(entrada);
        registrar({ tipo: "MOVA_CORE_SOMBRA", requisicaoId: r.requisicaoId, rota: r.rota, motivo: r.motivo, ferramentas: (r.ferramentas ?? []).map((x) => x.nome),
          respostaCore: r.texto ? String(r.texto).slice(0, 500) : null, decisaoLegado: legado.decisao ?? null, motivoLegado: legado.motivo ?? null,
          custoMicrousd: r.uso?.custoMicrousd ?? 0, latenciaMs: r.latenciaMs ?? 0, verificador: r.verificacao?.ok ?? null });
        return { observado: true };
      } catch (e) {
        registrar({ tipo: "MOVA_CORE_SOMBRA_FALHOU", erro: String(e?.message ?? e).slice(0, 200) });
        return { observado: false };
      }
    },
  });
}
