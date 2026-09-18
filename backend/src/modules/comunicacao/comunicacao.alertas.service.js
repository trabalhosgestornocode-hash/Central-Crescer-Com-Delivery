// ORQUESTRAÇÃO — a "fronteira clara" pedida no Checkpoint B. Três funções
// públicas, NENHUMA delas chamada em loop por este backend hoje (sem
// setInterval, sem cron, sem worker embutido — ver o comentário no topo da
// migration 082). O processo persistente do Checkpoint C é quem vai
// chamar `processarProximoLote` periodicamente.
//
//   detectarESincronizarAlertas -> lê administrativo.service.pendencias()
//     (a MESMA fonte de verdade do Painel Administrativo — nunca recalcula
//     a regra), cria/escalona/resolve comunicacao_alertas.
//
//   agendarEnviosPendentes -> para alertas DETECTED com destinatário
//     resolvível, calcula o horário (Scheduler) e cria a linha na fila
//     (idempotente).
//
//   processarProximoLote -> claim atômico + Policy Engine + WhatsAppService.
//     NINGUÉM MAIS chama o provider — ver whatsapp.service.js.
//
// ESCOPO DA FASE 1 (ajuste aprovado): só o monitor `dashboard_ifood` (D-1).
// `pendencias()` de administrativo.service.js já é só esse monitor hoje —
// este arquivo não filtra por monitor porque não há outro para filtrar,
// mas o `tipo_alerta` gravado é explicitamente TIPOS_ALERTA.DASHBOARD_IFOOD_D1
// (nunca um valor genérico) para não precisar de migration ao ligar o
// próximo monitor.

import { pendencias } from "../administrativo/administrativo.service.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as alertasRepo from "./comunicacao.alertas.repo.js";
import * as filaRepo from "./comunicacao.fila.repo.js";
import * as contatosRepo from "./comunicacao.contatos.repo.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { obterConfig, modoAtual } from "./comunicacao.config.js";
import { avaliarEnvio } from "./comunicacao.policy.js";
import { classificarErroEnvio, backoffRetrySegundos } from "./comunicacao.entrega.js";
import { dentroDaJanela, distribuirHorarios } from "./comunicacao.scheduler.js";
import { resolverHabilitacaoEmpresa } from "./comunicacao.habilitacao.js";
import {
  TIPOS_ALERTA, STATUS_ALERTA, STATUS_MENSAGEM, SEVERIDADE, CLASSIFICACAO_ERRO, MODOS,
  RESULTADO_FINAL_ENVIO, DESTINO_SEM_ENVIO, bloqueioEhTransitorio,
} from "./comunicacao.constants.js";

const MIN = 60_000;
/** Adiamento padrão de um bloqueio TRANSITÓRIO (o D.3-D calcula o próximo horário real: janela/timezone). */
const ADIAMENTO_PADRAO_MS = 15 * MIN;
/** Lease da fase SENDING — bem acima do timeout do provider (15s), para o worker vivo sempre finalizar antes de a varredura agir. */
const LEASE_ENVIO_SEGUNDOS = 90;

function formatarMensagemPendencia({ unidadeNome, empresaNome, diasPendentes, pendenciaMaisAntiga }) {
  const dias = diasPendentes === 1 ? "1 dia" : `${diasPendentes} dias`;
  const desde = pendenciaMaisAntiga ? ` (desde ${pendenciaMaisAntiga.split("-").reverse().join("/")})` : "";
  return `Olá! Identificamos que a unidade ${unidadeNome ?? "—"}${empresaNome ? ` (${empresaNome})` : ""} está com um lançamento pendente no Crescer com Delivery há ${dias}${desde}. Se quiser, posso te mostrar exatamente o que falta concluir.`;
}

/**
 * Sincroniza comunicacao_alertas com a lista REAL de pendências (fonte:
 * administrativo.service.pendencias() — monitor dashboard_ifood/D-1).
 * Cria/escalona o que ainda é pendência; RESOLVE (e cancela envio
 * pendente) o que deixou de aparecer na lista.
 * @param {{hojeIso?: string}} [opts]
 * @param {{supabase?: any}} [deps]
 */
export async function detectarESincronizarAlertas({ hojeIso } = {}, deps = {}) {
  const resultado = await pendencias({ hojeIso }, deps);
  const criados = [], escalonados = [], resolvidos = [];

  const chavesAtuais = new Set();
  for (const u of resultado.unidades) {
    if (u.criticidade !== SEVERIDADE.ATENCAO && u.criticidade !== SEVERIDADE.CRITICO) continue;
    const dataReferencia = u.pendenciaMaisAntiga ?? resultado.d1;
    if (!dataReferencia) continue; // sem data de referência não há como formar a chave — não deveria acontecer

    const { alerta, criado, escalonado } = await alertasRepo.criarOuEscalonarAlerta({
      organizacaoId: u.organizacaoId, unidadeId: u.unidadeId,
      tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, dataReferencia,
      destinatarioPerfilId: null, // resolvido depois, em agendarEnviosPendentes
      severidade: u.criticidade,
      motivo: `${u.diasPendentes} dia(s) pendente(s)${u.pendenciaHerdada ? ` (herdado desde ${u.pendenciaHerdadaDesde})` : ""}`,
    }, deps);
    chavesAtuais.add(alerta.id);
    if (criado) criados.push(alerta);
    if (escalonado) escalonados.push(alerta);
  }

  // O que estava ATIVO e não apareceu nesta rodada -> a pendência sumiu
  // (regularizada). `pendencias()` cobre TODAS as organizações monitoradas
  // de uma vez, então a varredura "o que sumiu" itera por organização
  // efetivamente vista nesta rodada (nunca um wildcard — evita varrer
  // tenants que este ciclo nem tocou).
  const organizacoesVistas = new Set(resultado.unidades.map((u) => u.organizacaoId));
  for (const orgId of organizacoesVistas) {
    const ativosDaOrg = await alertasRepo.listarAlertasAtivos({ organizacaoId: orgId, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1 }, deps);
    for (const a of ativosDaOrg) {
      if (chavesAtuais.has(a.id)) continue;
      await alertasRepo.resolverAlerta(a.id, deps);
      const canceladas = await filaRepo.cancelarPendentesPorAlerta(a.id, deps);
      resolvidos.push({ alertaId: a.id, mensagensCanceladas: canceladas.length });
    }
  }

  return { criados: criados.length, escalonados: escalonados.length, resolvidos: resolvidos.length, detalheResolvidos: resolvidos };
}

/**
 * Para alertas DETECTED com um contato resolvível, agenda o envio (fila) —
 * idempotente: chamar de novo não duplica (mesma idempotencyKey por
 * alerta). Calcula o horário via Scheduler, distribuindo os N alertas
 * elegíveis dentro da janela comercial atual (carga/capacidade — nunca
 * "parecer humano").
 * `organizacaoId` omitido = agenda a FROTA INTEIRA num lote só (a
 * distribuição de horários é global — evita rajada na conexão de
 * WhatsApp, não só dentro de uma empresa). Passe `organizacaoId` para
 * escopar a um teste/cenário específico.
 * @param {{organizacaoId?: string|null, tipoAlerta?: string, agora?: Date}} [params]
 */
export async function agendarEnviosPendentes({ organizacaoId = null, tipoAlerta = TIPOS_ALERTA.DASHBOARD_IFOOD_D1, agora = new Date() } = {}, deps = {}) {
  const ativos = await alertasRepo.listarAlertasAtivos({ organizacaoId, tipoAlerta }, deps);
  const detectados = ativos.filter((a) => a.status === STATUS_ALERTA.DETECTED);
  if (!detectados.length) return { agendados: 0, semDestinatario: 0 };

  const janelas = await obterConfig("janelas", deps);
  const fimDaJanelaHoje = new Date(agora); fimDaJanelaHoje.setHours(23, 59, 59, 999);
  const horarios = distribuirHorarios({
    quantidade: detectados.length, inicio: agora, fim: fimDaJanelaHoje,
    intervaloMinimoMs: Number(process.env.WHATSAPP_INTERVALO_MINIMO_MS) || 3 * MIN,
    janelas,
  });

  let agendados = 0, semDestinatario = 0;
  for (let i = 0; i < detectados.length; i++) {
    const alerta = detectados[i];
    const candidatos = await contatosRepo.resolverContatosDaUnidade({ organizacaoId: alerta.organizacao_id, unidadeId: alerta.unidade_id }, deps);
    if (!candidatos.length) { semDestinatario += 1; continue; }
    // ⚠️ NÃO APTO PARA PRODUÇÃO (ajuste 10, Checkpoint B.1): "pegue o
    // primeiro candidato" é um mecanismo TÉCNICO de teste — prova que o
    // pipeline agenda/envia de ponta a ponta, nada mais. O fluxo real
    // exige uma regra de destinatário explícita (empresa/unidade ->
    // responsável formalmente associado -> contato verificado ->
    // consentimento), não "o primeiro que aparecer". Decisão adiada para o
    // Checkpoint D/E — não implementar escalonamento/seleção automática
    // real em cima disto sem revisitar esta função primeiro.
    const escolhido = candidatos[0]; // já ordenado: principal primeiro, depois mais antigo

    await alertasRepo.atualizarStatusAlerta(alerta.id, STATUS_ALERTA.SCHEDULED, deps);
    const conteudo = formatarMensagemPendencia({
      unidadeNome: alerta.metadados?.unidade_nome ?? null,
      empresaNome: alerta.metadados?.empresa_nome ?? null,
      diasPendentes: Number(alerta.motivo?.match(/^(\d+)/)?.[1] ?? 1),
      pendenciaMaisAntiga: alerta.data_referencia,
    });

    await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: alerta.organizacao_id, unidadeId: alerta.unidade_id,
      contatoId: escolhido.contatoId, destinatarioPerfilId: escolhido.perfilId,
      tipo: alerta.tipo_alerta, conteudo, idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: horarios[i],
    }, deps);
    agendados += 1;
  }
  return { agendados, semDestinatario };
}


/** A pendência que originou este alerta ainda existe, agora mesmo? Revalidação de última hora (teste 6). */
async function pendenciaAindaExiste(alerta, deps) {
  const resultado = await pendencias({}, deps);
  return resultado.unidades.some((u) => u.organizacaoId === alerta.organizacao_id && u.unidadeId === alerta.unidade_id
    && (u.criticidade === SEVERIDADE.ATENCAO || u.criticidade === SEVERIDADE.CRITICO));
}

/** Diagnóstico/auditoria nunca pode derrubar nem reclassificar um envio já decidido. */
async function melhorEsforco(fn) {
  try { return await fn(); } catch (e) { console.error("[comunicacao] registro auxiliar falhou:", String(e?.message ?? e).slice(0, 200)); return null; }
}
const sanitizarErro = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * A FRONTEIRA (ajuste aprovado): claim atômico + Policy Engine +
 * WhatsAppService. Não é chamada em loop por este processo — quem chama
 * em intervalo é o worker persistente (ainda não existe). Segura para
 * chamar manualmente/via teste quantas vezes quiser.
 *
 * PORTÃO DE MODO (D.3-C): só processa com modo === NORMAL. Em DISABLED,
 * REACTIVE_ONLY ou qualquer valor desconhecido NÃO reivindica nada — as
 * mensagens ficam SCHEDULED, intactas, esperando o operador religar. (O
 * Policy Engine ainda bloqueia por modo dentro de cada job, como defesa em
 * profundidade contra o modo mudar entre o portão e a avaliação.)
 *
 * `verificarPendenciaAindaExiste` e `resolverHabilitacao` são injetáveis
 * (mesmo espírito do `deps` usado em todo o módulo) — em produção são o
 * motor real do Painel Administrativo e a habilitação FECHADA por padrão
 * (comunicacao.habilitacao.js); os testes injetam versões controladas.
 * @param {{limite?: number, worker?: string, whatsAppService: import('./whatsapp.service.js').ReturnType, agora?: Date, adiamentoMs?: number, verificarPendenciaAindaExiste?: (alerta: object, deps: object) => Promise<boolean>, resolverHabilitacao?: (params: {organizacaoId: string, tipoAlerta: string}, deps: object) => Promise<import('./comunicacao.habilitacao.js').Habilitacao>}} params
 */
export async function processarProximoLote({
  limite = 10, worker = "manual", whatsAppService, agora = new Date(), adiamentoMs = ADIAMENTO_PADRAO_MS,
  verificarPendenciaAindaExiste = pendenciaAindaExiste, resolverHabilitacao = resolverHabilitacaoEmpresa,
}, deps = {}) {
  if ((await modoAtual(deps)) !== MODOS.NORMAL) return [];

  const jobs = await filaRepo.claimJobs({ limite, worker }, deps);
  const resultados = [];
  for (const job of jobs) {
    try {
      resultados.push(await processarJobReivindicado(job, { whatsAppService, agora, adiamentoMs, verificarPendenciaAindaExiste, resolverHabilitacao }, deps));
    } catch (e) {
      // Um job com erro interno NÃO derruba o lote nem é reenviado às cegas:
      // se estava antes de SENDING, o lease expira e ele é reivindicado de
      // novo com segurança; se já estava em SENDING, a varredura o move para
      // DELIVERY_UNKNOWN. Nos dois casos, nunca um retry automático de envio.
      resultados.push({ id: job.id, resultado: "ERRO_INTERNO", erro: sanitizarErro(e) });
    }
  }
  return resultados;
}

const POSSE_PERDIDA = (job) => ({ id: job.id, resultado: "POSSE_PERDIDA" });

/**
 * Processa UM job já reivindicado. Exportado para os testes de concorrência
 * (worker antigo que "acorda" com um job que já não é dele); produção só o
 * alcança via `processarProximoLote`.
 *
 * CLAIM × ATTEMPT (migration 087):
 *   - O job chega com o token do CLAIM (`claimed_by` + `claim_geracao`). Tudo
 *     que acontece em PROCESSING (revalidação, política, adiamento, bloqueio,
 *     cancelamento) é CAS com esse token e NÃO consome tentativa: um
 *     adiamento gera um claim e ZERO attempts.
 *   - O ATTEMPT só nasce em `iniciarEnvio` (PROCESSING -> SENDING,
 *     `tentativas`+1). O provider só é chamado DEPOIS de `iniciarEnvio` devolver
 *     a linha; `null` de qualquer CAS = este worker perdeu a posse => ABORTA sem
 *     efeito externo (nunca chama o provider, nunca sobrescreve outro attempt).
 */
export async function processarJobReivindicado(job, { whatsAppService, agora, adiamentoMs, verificarPendenciaAindaExiste, resolverHabilitacao }, deps = {}) {
  const claim = { id: job.id, worker: job.claimed_by, claimGeracao: job.claim_geracao };

  // 0) attempts reais já esgotados (política de retries de falha PRÉ-ENVIO):
  //    não há mais o que tentar -> FAILED. (BLOCKED é só veto de política.)
  if (job.tentativas >= job.max_tentativas) {
    const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.FAILED, motivo: "TENTATIVAS_ESGOTADAS" }, deps);
    if (!r) return POSSE_PERDIDA(job);
    if (job.alerta_id) await melhorEsforco(() => alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.FAILED, deps));
    return { id: job.id, resultado: "FALHOU_TENTATIVAS_ESGOTADAS" };
  }

  // 1) revalida a pendência (teste 6) — se o alerta já não existe mais como
  //    problema real, cancela ESTE job (com o token do claim) em vez de mandar um aviso obsoleto.
  if (job.alerta_id) {
    const alerta = await alertasRepo.obterAlerta(job.alerta_id, deps);
    if (alerta && alerta.status !== STATUS_ALERTA.CANCELLED && alerta.status !== STATUS_ALERTA.RESOLVED) {
      const aindaExiste = await verificarPendenciaAindaExiste(alerta, deps);
      if (!aindaExiste) {
        const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.CANCELLED, motivo: "PENDENCIA_RESOLVIDA" }, deps);
        if (!r) return POSSE_PERDIDA(job);
        await filaRepo.cancelarPendentesPorAlerta(alerta.id, deps); // qualquer OUTRO pendente (SCHEDULED) do mesmo alerta
        await alertasRepo.resolverAlerta(alerta.id, deps);
        return { id: job.id, resultado: "CANCELADO_PENDENCIA_RESOLVIDA" };
      }
    }
  }

  // 2) monta o snapshot do Policy Engine (100% dados já resolvidos — nada de I/O dentro de avaliarEnvio).
  const [modo, janelas, cooldowns, limites, contato, perfil, statusProvider, habilitacao] = await Promise.all([
    modoAtual(deps), obterConfig("janelas", deps), obterConfig("cooldowns_horas", deps),
    obterConfig("limites", deps),
    job.contato_id ? contatosRepo.obterContato(job.contato_id, deps) : null,
    job.destinatario_perfil_id ? contatosRepo.obterPerfilOperacional(job.destinatario_perfil_id, deps) : null,
    // Gateway fora do ar NÃO é erro do job: é "provider offline" (bloqueio transitório).
    Promise.resolve().then(() => whatsAppService.getStatus()).catch(() => ({ conectado: false })),
    resolverHabilitacao({ organizacaoId: job.organizacao_id, tipoAlerta: job.tipo }, deps),
  ]);

  const vinculoValido = job.destinatario_perfil_id
    ? await contatosRepo.perfilTemVinculo({ perfilId: job.destinatario_perfil_id, organizacaoId: job.organizacao_id, unidadeId: job.unidade_id }, deps)
    : false;

  const alertaAtual = job.alerta_id ? await alertasRepo.obterAlerta(job.alerta_id, deps) : null;
  const cooldownHoras = alertaAtual ? (cooldowns[alertaAtual.severidade] ?? cooldowns.atencao) : cooldowns.atencao;
  const enviosRecentes = await filaRepo.contarEnviosRecentes({ contatoId: job.contato_id, tipo: job.tipo, janelaHoras: cooldownHoras }, deps);
  const duplicado = job.alerta_id ? await duplicadoAlemDesteJob() : false;
  const enviosHoje = job.contato_id ? await filaRepo.contarEnviosHoje({ contatoId: job.contato_id }, deps) : 0;
  const proativosUltimoMinuto = await filaRepo.contarEnviosProativosUltimoMinuto(deps);

  const snapshot = {
    modo, ehProativo: true,
    contatoExiste: !!contato,
    telefoneVerificado: contato?.verificado,
    optOut: contato?.opt_out,
    consentimento: contato?.consentimento,
    destinatarioAtivo: perfil?.ativo === true,
    vinculoValido,
    empresaHabilitada: habilitacao?.empresaHabilitada,
    tipoPermitido: habilitacao?.tipoPermitido,
    pendenciaAindaExiste: true, // já revalidado no passo 1 — chega aqui só se ainda existe (ou não é alerta)
    duplicado,
    cooldownAtivo: enviosRecentes > 0,
    dentroDaJanela: dentroDaJanela(agora, janelas),
    rateLimitExcedido: enviosHoje >= (limites.max_por_contato_por_dia ?? Infinity) || proativosUltimoMinuto >= (limites.max_proativas_por_minuto ?? Infinity),
    providerConectado: statusProvider?.conectado === true,
  };

  const decisao = avaliarEnvio(snapshot);

  if (!decisao.allowed) {
    // Condição TRANSITÓRIA (janela, cooldown, rate limit, provider offline,
    // modo desligado): ADIA — volta a SCHEDULED com `disponivel_em` futuro, SEM
    // consumir attempt e SEM linha em comunicacao_tentativas (nada foi tentado).
    // Veto PERMANENTE (sem consentimento, opt-out, sem vínculo, empresa/tipo
    // não habilitados...): BLOCKED terminal — só uma ação humana muda.
    const transitorio = bloqueioEhTransitorio(decisao.reason);
    const r = await filaRepo.encerrarProcessamento({
      ...claim,
      destino: transitorio ? DESTINO_SEM_ENVIO.SCHEDULED : DESTINO_SEM_ENVIO.BLOCKED,
      motivo: decisao.reason,
      disponivelEm: transitorio ? new Date(agora.getTime() + adiamentoMs) : null,
    }, deps);
    if (!r) return POSSE_PERDIDA(job);

    await auditar({
      acao: ACOES.COMUNICACAO_ENVIO_BLOQUEADO, atorTipo: "sistema", organizacaoId: job.organizacao_id,
      entidade: "comunicacao_mensagens", entidadeId: job.id,
      detalhes: { motivo: decisao.reason, tipo: job.tipo, transitorio, statusResultante: r.status },
    });
    if (transitorio) return { id: job.id, resultado: "ADIADO", motivo: decisao.reason };
    if (job.alerta_id) await melhorEsforco(() => alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.BLOCKED, deps));
    return { id: job.id, resultado: "BLOQUEADO", motivo: decisao.reason };
  }

  // PROCESSING -> SENDING ANTES da chamada externa, com CAS: aqui NASCE o
  // attempt. É o rastro durável que distingue "nunca tentei" (PROCESSING) de
  // "estava tentando quando morri" (SENDING) — e a PROVA de que este worker
  // ainda é o dono do claim. Sem a linha de volta, o provider NÃO é chamado.
  const emEnvio = await filaRepo.iniciarEnvio({ ...claim, leaseSegundos: LEASE_ENVIO_SEGUNDOS }, deps);
  if (!emEnvio) return POSSE_PERDIDA(job);

  // Token do ATTEMPT: (claim_geracao, tentativas da linha devolvida).
  const attempt = { ...claim, tentativa: emEnvio.tentativas };
  await melhorEsforco(() => tentativasRepo.registrarTentativaIniciada({
    mensagemId: job.id, tentativaNumero: emEnvio.tentativas, workerId: job.claimed_by ?? "manual", iniciadoEm: new Date().toISOString(),
  }, deps));
  await auditar({
    acao: ACOES.COMUNICACAO_ENVIO_PERMITIDO, atorTipo: "sistema", organizacaoId: job.organizacao_id,
    entidade: "comunicacao_mensagens", entidadeId: job.id, detalhes: { motivo: null, tipo: job.tipo, tentativa: emEnvio.tentativas },
  });

  let envio;
  try {
    envio = await whatsAppService.enviarTexto({
      telefoneE164: contato.telefone_e164, texto: job.conteudo, idempotencyKey: job.idempotency_key,
    });
  } catch (e) {
    return resolverFalhaDeEnvio(job, attempt, e, deps);
  }

  // O provider CONFIRMOU o envio. Daqui em diante NENHUMA falha de
  // registro pode reclassificar o resultado nem provocar retry: o pior caso
  // é a linha ficar em SENDING e a varredura movê-la para DELIVERY_UNKNOWN —
  // nunca um segundo envio.
  const providerMessageId = envio?.providerMessageId ?? null;
  let finalizada = null;
  try {
    finalizada = await filaRepo.finalizarEnvio({ ...attempt, resultado: RESULTADO_FINAL_ENVIO.SENT, providerMessageId }, deps);
  } catch (e) {
    console.error("[comunicacao] envio confirmado mas o registro SENT falhou (fica SENDING; a varredura o marca DELIVERY_UNKNOWN):", sanitizarErro(e));
  }
  await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: attempt.tentativa, resultado: STATUS_MENSAGEM.SENT, providerMessageId }, deps));
  if (job.alerta_id) await melhorEsforco(() => alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.SENT, deps));
  return { id: job.id, resultado: "ENVIADO", registrado: !!finalizada };
}

/** Falha do provider: classifica e grava com CAS do ATTEMPT. NUNCA faz retry a partir de INCERTO. */
async function resolverFalhaDeEnvio(job, attempt, e, deps) {
  const classificacao = classificarErroEnvio(e);
  const erroSanitizado = sanitizarErro(e);

  // INCERTO (na dúvida, INCERTO): NUNCA reenvio automático — nem SCHEDULED,
  // nem FAILED (que também poderia ser mal-lido como "definitivamente não
  // chegou"). Vai para DELIVERY_UNKNOWN e para por aqui até reconciliação.
  const resultado = classificacao === CLASSIFICACAO_ERRO.INCERTO ? RESULTADO_FINAL_ENVIO.DELIVERY_UNKNOWN
    : classificacao === CLASSIFICACAO_ERRO.PERMANENTE ? RESULTADO_FINAL_ENVIO.FAILED
      : RESULTADO_FINAL_ENVIO.RETRY; // RETRYAVEL: falha PRÉ-ENVIO comprovada

  let r = null;
  try {
    r = await filaRepo.finalizarEnvio({
      ...attempt, resultado, erro: erroSanitizado,
      retryAposSegundos: resultado === RESULTADO_FINAL_ENVIO.RETRY ? backoffRetrySegundos(attempt.tentativa) : null,
    }, deps);
  } catch (err) {
    // Sem conseguir gravar, a linha fica SENDING -> a varredura a move para
    // DELIVERY_UNKNOWN (conservador, mesmo para uma falha pré-envio).
    console.error("[comunicacao] falha ao gravar o resultado do envio:", sanitizarErro(err));
  }

  const statusFinal = r?.status ?? null;
  const tentativaResultado = classificacao === CLASSIFICACAO_ERRO.INCERTO ? STATUS_MENSAGEM.DELIVERY_UNKNOWN : STATUS_MENSAGEM.FAILED;
  await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: attempt.tentativa, resultado: tentativaResultado, erroClassificacao: classificacao, erroSanitizado }, deps));
  await auditar({
    acao: ACOES.COMUNICACAO_ENVIO_FALHOU, atorTipo: "sistema", organizacaoId: job.organizacao_id,
    entidade: "comunicacao_mensagens", entidadeId: job.id,
    detalhes: { erro: erroSanitizado, classificacao, statusResultante: statusFinal },
  });

  if (classificacao === CLASSIFICACAO_ERRO.INCERTO) return { id: job.id, resultado: "ENTREGA_INCERTA" };
  if (statusFinal === STATUS_MENSAGEM.FAILED && job.alerta_id) {
    await melhorEsforco(() => alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.FAILED, deps));
  }
  return { id: job.id, resultado: statusFinal === STATUS_MENSAGEM.SCHEDULED ? "FALHOU_RETRY" : "FALHOU_DEFINITIVO" };
}

/**
 * Existe duplicidade real para este alerta? Na Fase 1 isto é
 * estruturalmente impossível: `agendarEnviosPendentes` só cria uma
 * mensagem por alerta, sempre com a MESMA idempotency_key
 * (`wa:alerta:<id>:v1`) — a UNIQUE da migration 082 barra uma segunda
 * linha antes mesmo de chegar aqui. Mantido como função nomeada (não um
 * `false` solto no snapshot) para o dia em que 1 alerta puder gerar mais
 * de um envio (escalonamento, Checkpoint E+) — aí sim tem de checar de
 * verdade.
 */
async function duplicadoAlemDesteJob() {
  return false;
}
