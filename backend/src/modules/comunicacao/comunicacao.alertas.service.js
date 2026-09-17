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
import { classificarErroEnvio, permiteRetryAutomatico } from "./comunicacao.entrega.js";
import { dentroDaJanela, distribuirHorarios } from "./comunicacao.scheduler.js";
import { TIPOS_ALERTA, STATUS_ALERTA, STATUS_MENSAGEM, SEVERIDADE, CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";

const MIN = 60_000;

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

/**
 * A FRONTEIRA (ajuste aprovado): claim atômico + Policy Engine +
 * WhatsAppService. Não é chamada em loop por este processo — quem chama
 * em intervalo é o worker persistente do Checkpoint C. Segura para
 * chamar manualmente/via teste quantas vezes quiser.
 *
 * `verificarPendenciaAindaExiste` é injetável (mesmo espírito do `deps`
 * usado em todo o módulo) — em produção é `pendenciaAindaExiste` (chama o
 * motor real do Painel Administrativo); os testes do Checkpoint B injetam
 * uma versão controlada para provar a revalidação pós-claim (teste 6) sem
 * precisar montar uma frota real inteira.
 * @param {{limite?: number, worker?: string, whatsAppService: import('./whatsapp.service.js').ReturnType, agora?: Date, verificarPendenciaAindaExiste?: (alerta: object, deps: object) => Promise<boolean>}} params
 */
export async function processarProximoLote({ limite = 10, worker = "manual", whatsAppService, agora = new Date(), verificarPendenciaAindaExiste = pendenciaAindaExiste }, deps = {}) {
  const jobs = await filaRepo.claimJobs({ limite, worker }, deps);
  const resultados = [];

  for (const job of jobs) {
    resultados.push(await processarUmJob(job, { whatsAppService, agora, verificarPendenciaAindaExiste }, deps));
  }
  return resultados;
}

async function processarUmJob(job, { whatsAppService, agora, verificarPendenciaAindaExiste }, deps) {
  // 1) revalida a pendência (teste 6) — se o alerta já não existe mais como
  //    problema real, cancela o job em vez de mandar um aviso obsoleto.
  if (job.alerta_id) {
    const alerta = await alertasRepo.obterAlerta(job.alerta_id, deps);
    if (alerta && alerta.status !== STATUS_ALERTA.CANCELLED && alerta.status !== STATUS_ALERTA.RESOLVED) {
      const aindaExiste = await verificarPendenciaAindaExiste(alerta, deps);
      if (!aindaExiste) {
        await filaRepo.cancelarPendentesPorAlerta(alerta.id, deps); // cancela este e qualquer outro pendente do mesmo alerta
        await alertasRepo.resolverAlerta(alerta.id, deps);
        return { id: job.id, resultado: "CANCELADO_PENDENCIA_RESOLVIDA" };
      }
    }
  }

  // 2) monta o snapshot do Policy Engine (100% dados já resolvidos — nada de I/O dentro de avaliarEnvio).
  const [modo, janelas, cooldowns, limites, contato, perfil, statusProvider] = await Promise.all([
    modoAtual(deps), obterConfig("janelas", deps), obterConfig("cooldowns_horas", deps),
    obterConfig("limites", deps),
    job.contato_id ? contatosRepo.obterContato(job.contato_id, deps) : null,
    job.destinatario_perfil_id ? contatosRepo.obterPerfilOperacional(job.destinatario_perfil_id, deps) : null,
    whatsAppService.getStatus(),
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
    telefoneVerificado: contato?.verificado ?? false,
    optOut: contato?.opt_out ?? false,
    destinatarioAtivo: perfil?.ativo === true,
    vinculoValido,
    pendenciaAindaExiste: true, // já revalidado no passo 1 — chega aqui só se ainda existe (ou não é alerta)
    duplicado,
    cooldownAtivo: enviosRecentes > 0,
    dentroDaJanela: dentroDaJanela(agora, janelas),
    rateLimitExcedido: enviosHoje >= (limites.max_por_contato_por_dia ?? Infinity) || proativosUltimoMinuto >= (limites.max_proativas_por_minuto ?? Infinity),
    providerConectado: !!statusProvider?.conectado,
  };

  const decisao = avaliarEnvio(snapshot);

  await auditar({
    acao: decisao.allowed ? ACOES.COMUNICACAO_ENVIO_PERMITIDO : ACOES.COMUNICACAO_ENVIO_BLOQUEADO,
    atorTipo: "sistema", organizacaoId: job.organizacao_id,
    entidade: "comunicacao_mensagens", entidadeId: job.id,
    detalhes: { motivo: decisao.reason, tipo: job.tipo },
  });

  // Fecha qualquer tentativa órfã (worker anterior morreu com o lease
  // expirado — só chegamos aqui se isso já expirou, ver claim) e abre a
  // tentativa DESTA vez. `job.tentativas` já vem incrementado pela RPC de
  // claim — é o número exato desta tentativa.
  await tentativasRepo.abandonarTentativasEmAberto(job.id, deps);
  await tentativasRepo.registrarTentativaIniciada({
    mensagemId: job.id, tentativaNumero: job.tentativas, workerId: job.claimed_by ?? "manual", iniciadoEm: job.claimed_at ?? new Date().toISOString(),
  }, deps);

  if (!decisao.allowed) {
    await filaRepo.marcarBloqueado(job.id, { motivo: decisao.reason }, deps);
    if (job.alerta_id) await alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.BLOCKED, deps);
    await tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: job.tentativas, resultado: STATUS_MENSAGEM.BLOCKED }, deps);
    return { id: job.id, resultado: "BLOQUEADO", motivo: decisao.reason };
  }

  // PROCESSING -> SENDING ANTES da chamada externa: é o rastro durável que
  // permite distinguir, depois de um crash, "nunca tentei" (PROCESSING) de
  // "estava tentando quando morri" (SENDING) — ver comunicacao.entrega.js.
  await filaRepo.marcarEnviando(job.id, deps);

  try {
    const envio = await whatsAppService.enviarTexto({
      telefoneE164: contato.telefone_e164, texto: job.conteudo, idempotencyKey: job.idempotency_key,
    });
    await filaRepo.marcarEnviado(job.id, { providerMessageId: envio.providerMessageId }, deps);
    if (job.alerta_id) await alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.SENT, deps);
    await tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: job.tentativas, resultado: STATUS_MENSAGEM.SENT, providerMessageId: envio.providerMessageId }, deps);
    return { id: job.id, resultado: "ENVIADO" };
  } catch (e) {
    const classificacao = classificarErroEnvio(e);
    const erroSanitizado = e?.message ?? String(e); // provider/FakeProvider nunca deveria colocar segredo aqui — ver comunicacao_tentativas.erro_sanitizado

    // INCERTO (ajuste 6): NUNCA reenvio automático — nem SCHEDULED, nem
    // FAILED (que também poderia ser mal-lido como "definitivamente não
    // chegou"). Vai para DELIVERY_UNKNOWN e para por aqui até reconciliação
    // (fora do escopo do B.1).
    if (!permiteRetryAutomatico(classificacao) && classificacao === CLASSIFICACAO_ERRO.INCERTO) {
      await filaRepo.marcarEntregaIncerta(job.id, { erro: erroSanitizado }, deps);
      await tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: job.tentativas, resultado: STATUS_MENSAGEM.DELIVERY_UNKNOWN, erroClassificacao: classificacao, erroSanitizado }, deps);
      await auditar({ acao: ACOES.COMUNICACAO_ENVIO_FALHOU, atorTipo: "sistema", organizacaoId: job.organizacao_id, entidade: "comunicacao_mensagens", entidadeId: job.id, detalhes: { erro: erroSanitizado, classificacao, statusResultante: STATUS_MENSAGEM.DELIVERY_UNKNOWN } });
      return { id: job.id, resultado: "ENTREGA_INCERTA" };
    }

    const permanente = classificacao === CLASSIFICACAO_ERRO.PERMANENTE;
    const r = await filaRepo.marcarFalha(job.id, { erro: erroSanitizado, permanente }, deps);
    // resultado da TENTATIVA é sempre FAILED aqui (ela falhou) — se o JOB
    // como um todo volta para SCHEDULED (retry) ou termina em FAILED é
    // decisão separada, já aplicada por marcarFalha acima (`r.status`).
    await tentativasRepo.registrarTentativaFinalizada({ mensagemId: job.id, tentativaNumero: job.tentativas, resultado: STATUS_MENSAGEM.FAILED, erroClassificacao: classificacao, erroSanitizado }, deps);
    await auditar({ acao: ACOES.COMUNICACAO_ENVIO_FALHOU, atorTipo: "sistema", organizacaoId: job.organizacao_id, entidade: "comunicacao_mensagens", entidadeId: job.id, detalhes: { erro: erroSanitizado, classificacao, statusResultante: r.status } });
    if (job.alerta_id && r.status === STATUS_MENSAGEM.FAILED) await alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.FAILED, deps);
    return { id: job.id, resultado: r.status === STATUS_MENSAGEM.FAILED ? "FALHOU_DEFINITIVO" : "FALHOU_RETRY" };
  }
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
