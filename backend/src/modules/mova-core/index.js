// MOVA CORE — F1: ponto de entrada. Junta roteador → laço de ferramentas → executor seguro → verificador, com orçamento,
// continuidade mínima, auditoria, métricas e MODO SOMBRA. Não envia mensagens nem escreve nada: devolve a resposta para quem
// chama decidir (na sombra, só registra a comparação com o motor atual).
import { CATALOGO, FERRAMENTAS, OPERACOES_DO_CATALOGO, definicoesParaApi } from "./catalogo.js";
import { criarExecutor, novaSessao } from "./executor.js";
import { executarLaco, PADROES_DO_LACO } from "./laco.js";
import { decidirRota, ROTA, RESPOSTAS_FIXAS } from "./roteador.js";
import { criarMemoriaDeConversas } from "./conversa.js";
import { criarMetricas } from "./metricas.js";
import { criarResolvedorDeConceitos } from "./resolucao.js";

export { CATALOGO, FERRAMENTAS, ROTA, decidirRota, definicoesParaApi };
export { verificarFidelidade } from "./verificador.js";
export { criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "./orcamentoMemoria.js";
export { ferramentasDoAgenteCrescer, PERMISSOES_DO_AGENTE_CRESCER } from "./agenteCrescer.js";
export { criarMemoriaEmCamadas, PADROES_DA_MEMORIA } from "./memoria.js";
export { criarServicoDeIdentidade, acessoDaPlataforma, chaveCanonica } from "./identidade.js";
export { custoRealMicrousd, TARIFAS } from "./custo.js";
export { resolverEntidade, criarResolvedorDeConceitos, GLOSSARIO_BASE, pontuar, radical } from "./resolucao.js";
export { criarRepositorioDeIdentidadePostgres, criarRepositorioDeMemoriaPostgres } from "./persistencia.js";

/**
 * @param {object} deps
 * @param {object} deps.porta       porta de LEITURA do Financeiro (criarPortaFinanceira do MOVA)
 * @param {object|null} deps.cliente cliente da API (messages.create); null ⇒ núcleo indisponível (fallback ao extrator)
 * @param {object} deps.orcamento   reservar/concluir/falhar (renovável em homologação; memória no ambiente isolado)
 * @param {Array}  [deps.ferramentasExtras] p.ex. ferramentasDoAgenteCrescer(...)
 */
export function criarMovaCore({ porta, cliente = null, orcamento, auditoria = { registrar() {} }, ferramentasExtras = [], ferramentasDaPessoa = null, memoria = criarMemoriaDeConversas(), opcoes = {}, relogio = () => Date.now(), glossario = null }) {
  const montar = (extras) => ({
    catalogo: { ...CATALOGO, ...Object.fromEntries(extras.map((f) => [f.nome, f])) },
    definicoes: [...definicoesParaApi(), ...extras.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema }))],
  });
  const base = montar(ferramentasExtras);
  const catalogo = base.catalogo; const definicoes = base.definicoes;
  const metricas = criarMetricas();
  const conceitos = criarResolvedorDeConceitos(glossario ? { glossario } : {});
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
    const conversa = await memoria.obter({ organizacaoId: e.organizacaoId, conversaId: e.conversaId, participanteId: e.participanteId });
    // F2: ferramentas que dependem de QUEM é a pessoa (Agente Crescer só com vínculo resolvido AGORA pelo servidor)
    const daPessoa = ferramentasDaPessoa ? (await ferramentasDaPessoa(e)) ?? [] : [];
    const { catalogo: catalogoDaVez, definicoes: definicoesDaVez } = daPessoa.length ? montar([...ferramentasExtras, ...daPessoa]) : base;
    const executor = criarExecutor({ catalogo: catalogoDaVez, porta, auditoria, relogio });
    // F2: só fatos FRESCOS voltam como fonte (a memória nunca responde saldo antigo)
    // F2.1: e nunca fato de POSIÇÃO quando a pergunta é sobre o estado atual, nem de outra unidade, nem de ferramenta que a
    // pessoa não alcança AGORA (vínculo revogado ou permissão retirada desde o turno anterior)
    const fatosDaMemoria = memoria.fatosValidos
      ? memoria.fatosValidos(conversa, { pergunta: String(e.texto ?? ""), unidadeId: e.unidadeId, ferramentasPermitidas: new Set(Object.keys(catalogoDaVez)) })
      : conversa.fatos;
    const sessao = novaSessao({ conversa, fatos: fatosDaMemoria, organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId, unidadesPermitidas: e.unidadesPermitidas, perfil: e.perfil, podeValores: e.podeValores, requisicaoId });
    const recuperado = memoria.recuperar ? await memoria.recuperar(conversa, String(e.texto)) : null;
    // F3: o que cada conceito financeiro citado É no sistema (glossário versionado) — orienta, não substitui as ferramentas
    const orientacao = conceitos.orientacao(String(e.texto ?? ""));
    const contexto = [orientacao, recuperado].filter(Boolean).join("\n") || null;
    const unidade = e.unidadesPermitidas.find((u) => u.id === e.unidadeId)?.nome ?? "—";
    const r = await executarLaco({
      cliente, executor, sessao, orcamento, ferramentas: definicoesDaVez, historico: memoria.historico(conversa, String(e.texto)), pergunta: String(e.texto).slice(0, 2000),
      ambiente: { hoje: e.hoje, unidade, perfil: e.perfil?.nome ?? "—", podeValores: e.podeValores, contexto }, opcoes: { ...PADROES_DO_LACO, ...opcoes }, relogio,
      registrar: (x) => auditoria.registrar(x),
    });
    await memoria.registrarTurno(conversa, { pergunta: e.texto, resposta: r.texto, ferramentas: r.ferramentas.map((x) => x.nome), fatos: sessao.fatos, esclarecimentoPedido: r.motivo === "RESPONDIDO" && /\?\s*$/.test(String(r.texto ?? "")) && !(r.ferramentas ?? []).some((x) => x.ok) });
    auditoria.registrar({ tipo: "MOVA_CORE_RESPOSTA", requisicaoId, rota: rota.rota, motivo: r.motivo, ferramentas: r.ferramentas.map((x) => x.nome), custoMicrousd: r.uso.custoMicrousd, latenciaMs: r.latenciaMs, verificador: r.verificacao?.ok ?? null });
    metricas.registrar({ rota: rota.rota, motivo: r.motivo, ferramentas: r.ferramentas, uso: r.uso, latenciaMs: r.latenciaMs, verificacao: r.verificacao });
    return { requisicaoId, rota: rota.rota, ...r, fatos: sessao.fatos };
  }
  return Object.freeze({ responder, metricas, catalogo, definicoes, somenteLeitura: Boolean(porta?.[SOMENTE_LEITURA]) && orcamento?.ambiente === "ISOLADO" });
}

/**
 * MODO SOMBRA: roda o MOVA CORE ao lado do motor atual, NUNCA envia nada e nunca derruba o motor. Registra a comparação
 * (rota, ferramentas, resposta resumida, custo, latência, verificador) para avaliação. Ligação em produção: só com autorização.
 */
export function criarSombra({ core, registrar }) {
  if (!core?.somenteLeitura) throw new TypeError("modo sombra só com núcleo montado por criarSombraIsolada (porta somente leitura + orçamento isolado)");
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

const SOMENTE_LEITURA = Symbol.for("mova-core.portaSomenteLeitura");
/**
 * F2 — PORTA SOMENTE LEITURA: só `ler` das operações do catálogo (todas consultas via b.consultar) e a leitura de permissões.
 * Qualquer outra coisa (registrar, baixar, enviar, notificar…) não existe nesta porta: quem tentar recebe erro.
 */
export function portaSomenteLeitura(porta) {
  const permitidas = new Set(OPERACOES_DO_CATALOGO);
  const alvo = {
    [SOMENTE_LEITURA]: true,
    async ler(op, escopo, entrada) { if (!permitidas.has(op)) throw Object.assign(new Error(`operação fora da leitura do catálogo: ${op}`), { codigo: "SOMENTE_LEITURA" }); return porta.ler(op, escopo, entrada); },
    permissoesDoUsuario: (escopo) => porta.permissoesDoUsuario(escopo),
    ehErroDeRegra: (e) => porta.ehErroDeRegra?.(e) ?? false,
  };
  return new Proxy(Object.freeze(alvo), { get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; return () => { throw Object.assign(new Error(`porta somente leitura: ${String(k)} não existe`), { codigo: "SOMENTE_LEITURA" }); }; } });
}

/** Núcleo para o MODO SOMBRA em homologação isolada: porta somente leitura, orçamento ISOLADO, sem ferramentas da pessoa. */
export function criarSombraIsolada({ porta, cliente, orcamento, registrar, memoria, opcoes, relogio }) {
  if (orcamento?.ambiente !== "ISOLADO") throw new TypeError("modo sombra exige orçamento ISOLADO (nunca o de produção)");
  const core = criarMovaCore({ porta: portaSomenteLeitura(porta), cliente, orcamento, auditoria: { registrar }, memoria, opcoes, relogio });
  return criarSombra({ core, registrar });
}
