// MOVA CORE — F1: ponto de entrada. Junta roteador → laço de ferramentas → executor seguro → verificador, com orçamento,
// continuidade mínima, auditoria, métricas e MODO SOMBRA. Não envia mensagens nem escreve nada: devolve a resposta para quem
// chama decidir (na sombra, só registra a comparação com o motor atual).
import { CATALOGO, FERRAMENTAS, OPERACOES_DO_CATALOGO, definicoesParaApi } from "./catalogo.js";
import { intencaoDeterministica, ferramentasDeOperacao, textoDoDesfecho } from "./operacoes.js";
import { ferramentasDeConhecimento } from "./conhecimento.js";
import { decidirEscalonamento, mensagensParaEscalonar } from "./escalonamento.js";
import { fatosDaMensagem } from "./verificador.js";
import { criarExecutor, novaSessao } from "./executor.js";
import { executarLaco, PADROES_DO_LACO } from "./laco.js";
import { decidirRota, ROTA, RESPOSTAS_FIXAS } from "./roteador.js";
import { criarMemoriaDeConversas } from "./conversa.js";
import { criarMetricas } from "./metricas.js";
import { criarResolvedorDeConceitos } from "./resolucao.js";

export { CATALOGO, FERRAMENTAS, ROTA, decidirRota, definicoesParaApi };
export { verificarFidelidade, fatosDaMensagem } from "./verificador.js";
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
export function criarMovaCore({ porta, cliente = null, orcamento, auditoria = { registrar() {} }, ferramentasExtras: extrasDadas = [], ferramentasDaPessoa = null, memoria = criarMemoriaDeConversas(), opcoes = {}, relogio = () => Date.now(), glossario = null, operacoes = null, conhecimento = null, escalonamento = null }) {
  // F4 integrada: com o serviço de operações, o modelo ganha preparar_operacao / propostas_do_mova (NUNCA executar)
  // F5: com a base de conhecimento, o modelo ganha buscar_conhecimento / sugerir_conhecimento (sugere; NUNCA aprova)
  const ferramentasExtras = [...extrasDadas, ...(operacoes ? ferramentasDeOperacao() : []), ...(conhecimento ? ferramentasDeConhecimento() : [])];
  const montar = (extras) => ({
    catalogo: { ...CATALOGO, ...Object.fromEntries(extras.map((f) => [f.nome, f])) },
    // F5: com a base de conhecimento ligada, como_funciona (temas fixos) SAI — buscar_conhecimento cobre e é versionada
    definicoes: [...definicoesParaApi().filter((d) => !(conhecimento && d.name === "como_funciona")), ...extras.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema }))],
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
    const conversaChave = `${e.organizacaoId}|${e.conversaId}|${e.participanteId}`;
    const autor = e.usuarioId ?? e.participanteId ?? null;
    // F4 §11: CONFIRMAR / CANCELAR é decidido pelo SERVIDOR, antes do modelo e sem ele: só resposta inequívoca à proposta aberta
    // desta conversa. "sim, mas..." ou qualquer correção vai para o modelo (nova versão). O texto sai do resultado REAL.
    if (operacoes && !e.anexo?.arquivo) {
      const intencao = intencaoDeterministica(e.texto);
      const aberta = intencao ? await operacoes.abertaDaConversa(conversaChave) : null;
      // 'sim' a uma proposta que foi para REVISÃO HUMANA: responde a verdade (nada entrou), sem executar e sem o modelo
      const emRevisao = intencao === "CONFIRMAR" && !aberta ? await operacoes.emRevisaoDaConversa(conversaChave) : null;
      if (aberta || emRevisao) {
        const r = emRevisao ? { ok: false, motivo: "REVISAO_HUMANA", proposta: emRevisao }
          : intencao === "CONFIRMAR" ? await operacoes.confirmar({ conversaChave, autor, autorizacaoDeEscrita: e.autorizacaoDeEscrita ?? null }) : await operacoes.cancelar({ conversaChave, autor });
        const texto = textoDoDesfecho(r);
        if (texto) {
          const conversa = await memoria.obter({ organizacaoId: e.organizacaoId, conversaId: e.conversaId, participanteId: e.participanteId });
          await memoria.registrarTurno(conversa, { pergunta: e.texto, resposta: texto, ferramentas: [], fatos: conversa.fatos ?? [] });
          const motivo = r.ok ? (r.executada ? "OPERACAO_EXECUTADA" : "OPERACAO_CANCELADA") : `OPERACAO_${r.motivo}`;
          auditoria.registrar({ tipo: "MOVA_CORE_RESPOSTA", requisicaoId, rota: "OPERACAO", motivo, ferramentas: [], custoMicrousd: 0, latenciaMs: 0 });
          metricas.registrar({ rota: "OPERACAO", motivo });
          return { requisicaoId, rota: "OPERACAO", motivo, texto, ferramentas: [], uso: null, latenciaMs: 0,
            operacao: { intencao, executada: Boolean(r.executada), estado: r.proposta?.estado ?? null, propostaId: r.proposta?.id ?? null, feitos: r.feitos ?? [] } };
        }
      }
    }
    // documento NO NÚCLEO só com operações ligadas e a opção explícita (homologação); senão o motor atual trata o anexo
    const documentoNoCore = Boolean(operacoes && opcoes.documentosNoCore && e.anexo?.arquivo);
    const rota = decidirRota({ texto: e.texto, temAnexo: documentoNoCore ? false : e.temAnexo, pendenciaAberta: e.pendenciaAberta, nucleoDisponivel: Boolean(cliente) });
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
    const sessao = novaSessao({ conversa, fatos: fatosDaMemoria, organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId, unidadesPermitidas: e.unidadesPermitidas, perfil: e.perfil, podeValores: e.podeValores, requisicaoId, hoje: e.hoje ?? null });
    sessao.fatos.push(...fatosDaMensagem(e.texto)); // números que a pessoa escreveu: só para repetir em frase neutra
    Object.assign(sessao, { operacoes, conhecimento, conversaChave, autor, textoDaPessoa: String(e.texto ?? "").slice(0, 2000), anexo: documentoNoCore ? e.anexo : null });
    const recuperado = memoria.recuperar ? await memoria.recuperar(conversa, String(e.texto)) : null;
    // F3: o que cada conceito financeiro citado É no sistema (glossário versionado) — orienta, não substitui as ferramentas
    const orientacao = conceitos.orientacao(String(e.texto ?? ""));
    let notaDoServidor = null;
    if (documentoNoCore) {
      const aberta = await operacoes.abertaDaConversa(conversaChave);
      if (aberta && aberta.autor === autor && (aberta.requisitos ?? []).includes("COMPROVANTE")) {
        const r = await operacoes.preparar({ conversaChave, sessao, autor, tipo: aberta.tipo, args: aberta.args ?? {}, anexo: e.anexo });
        notaDoServidor = r.ok ? `[servidor] O documento desta mensagem foi anexado à proposta aberta (${r.proposta.id}, estado ${r.proposta.estado}). Consulte propostas_do_mova ou siga com preparar_operacao; nada entrou no Financeiro ainda.` : null;
      }
    }
    // troca de unidade no meio da conversa: as respostas anteriores eram da OUTRA unidade e continuam certas para ela
    // (avaliação real: sem este aviso, o modelo dizia que a resposta anterior "estava errada")
    const unidadeAnterior = conversa.unidadeDaUltimaResposta ?? null;
    conversa.unidadeDaUltimaResposta = e.unidadeId;
    const nomeDe = (id) => e.unidadesPermitidas.find((u) => u.id === id)?.nome ?? null;
    const avisoDeUnidade = unidadeAnterior && unidadeAnterior !== e.unidadeId && nomeDe(unidadeAnterior)
      ? `[servidor] A unidade desta conversa MUDOU de ${nomeDe(unidadeAnterior)} para ${nomeDe(e.unidadeId) ?? "outra unidade"}. As respostas anteriores se referiam a ${nomeDe(unidadeAnterior)} e continuam corretas para ela: não as chame de erradas; responda agora sobre ${nomeDe(e.unidadeId) ?? "a unidade atual"}.` : null;
    const contexto = [orientacao, recuperado, notaDoServidor, avisoDeUnidade].filter(Boolean).join("\n") || null;
    const unidade = e.unidadesPermitidas.find((u) => u.id === e.unidadeId)?.nome ?? "—";
    const argsDoLaco = {
      cliente, executor, sessao, orcamento, ferramentas: definicoesDaVez, historico: memoria.historico(conversa, String(e.texto)), pergunta: String(e.texto).slice(0, 2000),
      ambiente: { hoje: e.hoje, unidade, perfil: e.perfil?.nome ?? "—", podeValores: e.podeValores, contexto }, opcoes: { ...PADROES_DO_LACO, ...opcoes }, relogio,
      registrar: (x) => auditoria.registrar(x),
    };
    let r = await executarLaco(argsDoLaco);
    // §4 (homologação): o SERVIDOR decide se um modelo maior tenta de novo, com as consultas já feitas; nunca por falta de dado,
    // permissão, regra ou escrita. Fica a melhor resposta CONFERIDA; o custo das duas tentativas é somado.
    const decisao = decidirEscalonamento({ r, sessao, config: escalonamento });
    let infoEscalonamento = escalonamento?.habilitado ? { escalou: false, motivo: decisao.motivo } : null;
    if (decisao.escalar) {
      const r2 = await executarLaco({ ...argsDoLaco, mensagensIniciais: mensagensParaEscalonar(r.mensagens, decisao.motivo), opcoes: { ...argsDoLaco.opcoes, modelo: escalonamento.modelo, esforco: escalonamento.esforco, maxPassos: escalonamento.maxPassos } });
      const conferida = (x) => (x.motivo === "RESPONDIDO" ? 2 : x.motivo === "RESPOSTA_PARCIAL_CONFERIDA" ? 1 : 0);
      const melhor = conferida(r2) > conferida(r) ? r2 : r;
      const somar = (k) => (r.uso[k] ?? 0) + (r2.uso[k] ?? 0);
      infoEscalonamento = { escalou: true, motivo: decisao.motivo, de: r.modelo, para: r2.modelo, motivoDepois: r2.motivo, usouResposta: melhor === r2 ? "ESCALONADA" : "PRINCIPAL",
        custoPrincipalMicrousd: r.uso.custoMicrousd, custoEscalonadoMicrousd: r2.uso.custoMicrousd, latenciaPrincipalMs: r.latenciaMs, latenciaEscalonadaMs: r2.latenciaMs };
      auditoria.registrar({ tipo: "MOVA_CORE_ESCALONAMENTO", requisicaoId, ...infoEscalonamento });
      r = { ...melhor, ferramentas: [...r.ferramentas, ...r2.ferramentas.map((f) => ({ ...f, escalonada: true }))], latenciaMs: r.latenciaMs + r2.latenciaMs,
        uso: { entrada: somar("entrada"), saida: somar("saida"), cacheLeitura: somar("cacheLeitura"), cacheEscrita: somar("cacheEscrita"), custoMicrousd: somar("custoMicrousd"), chamadas: somar("chamadas") } };
    }
    const { mensagens: _m, ...semMensagens } = r; void _m; r = { ...semMensagens, ...(infoEscalonamento ? { escalonamento: infoEscalonamento } : {}) };
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
