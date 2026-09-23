// ORQUESTRAÇÃO — a "fronteira clara" pedida no Checkpoint B. Funções públicas,
// NENHUMA delas chamada em loop por este backend hoje (sem setInterval, sem
// cron, sem worker embutido — ver o comentário no topo da migration 082). O
// processo persistente do Checkpoint C é quem vai chamar `executarCiclo` (ou as
// três etapas) periodicamente.
//
//   detectarESincronizarAlertas -> lê o SNAPSHOT de administrativo.service.pendencias()
//     (a MESMA fonte de verdade do Painel Administrativo — nunca recalcula a
//     regra), cria/escalona/resolve comunicacao_alertas.
//
//   agendarEnviosPendentes -> para alertas DETECTED de organização HABILITADA, calcula o
//     horário REAL (timezone/janela da organização + jitter determinístico) e cria a
//     mensagem E move o alerta para SCHEDULED na MESMA transação (RPC
//     comunicacao_agendar_mensagem_alerta). O DESTINATÁRIO não é escolhido aqui: é o
//     configurado EXPLICITAMENTE na habilitação da organização (o banco o lê; sem ele,
//     nada é agendado). Nunca "o primeiro contato encontrado".
//
//   processarProximoLote -> claim atômico + Policy Engine + reserva atômica de
//     capacidade + WhatsAppService. NINGUÉM MAIS chama o provider — ver
//     whatsapp.service.js.
//
//   executarCiclo -> lê `pendencias()` UMA vez e usa esse mesmo snapshot nas três
//     etapas (consistência da frota inteira; nada é relido por unidade/job).
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
// (contatosRepo não escolhe mais destinatário: só carrega o contato/perfil JÁ configurado para a política.)
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { obterConfig, modoAtual, obterTtlHoras, obterJitterMaxMs } from "./comunicacao.config.js";
import { avaliarEnvio } from "./comunicacao.policy.js";
import { classificarErroEnvio, backoffRetrySegundos } from "./comunicacao.entrega.js";
import { dentroDaJanelaLocal, proximoHorarioDeEnvio, inicioDoDiaLocal, ConfiguracaoHorarioInvalida } from "./comunicacao.horario.js";
import { resolverHabilitacaoEmpresa, janelasEfetivas } from "./comunicacao.habilitacao.js";
import { telefoneAutorizadoNoPiloto } from "./comunicacao.piloto.js";
import { formatarMensagemPendencia, formatarMensagemReforcoDia } from "./comunicacao.template.js";
import {
  janelaDeReforcoAgora, instanteDoReforco, espacamentoCumprido, mesmoDiaLocal, prazoD1VenceHoje, propositoDaMensagem,
  chaveIdempotenciaReforco, PROPOSITO, MOTIVO_REFORCO,
} from "./comunicacao.reforco.js";
import { calcularDisponivelEm, chaveDeJitter, MOTIVO_DA_RESERVA } from "./comunicacao.adiamento.js";
import {
  TIPOS_ALERTA, STATUS_ALERTA, STATUS_MENSAGEM, SEVERIDADE, CLASSIFICACAO_ERRO, MODOS,
  RESULTADO_FINAL_ENVIO, RESULTADO_RESERVA, DESTINO_SEM_ENVIO, MOTIVO_EXPIRADA, MOTIVOS_BLOQUEIO, bloqueioEhTransitorio,
} from "./comunicacao.constants.js";

const MIN = 60_000;
const HORA = 60 * MIN;
/** Espera-base de um bloqueio TRANSITÓRIO sem horário próprio (cooldown, provider offline...). O instante final é sempre empurrado para dentro da janela da organização. */
const ADIAMENTO_PADRAO_MS = 15 * MIN;
/** Lease da fase SENDING — bem acima do timeout do provider (15s), para o worker vivo sempre finalizar antes de a varredura agir. */
const LEASE_ENVIO_SEGUNDOS = 90;
/** Só usados se a configuração vier corrompida (linha existe mas sem a chave): nunca "sem limite". */
const COOLDOWN_PADRAO_HORAS = 8;
/** Alertas cujo 1º aviso já saiu — os únicos candidatos ao reforço. */
const STATUS_JA_ENVIADOS = [STATUS_ALERTA.SENT, STATUS_ALERTA.DELIVERED, STATUS_ALERTA.READ];
const LIMITE_MINUTO_PADRAO = 5;
const LIMITE_MINUTO_ORGANIZACAO_PADRAO = 3;
const LIMITE_DIA_PADRAO = 3;

const numeroOuPadrao = (v, padrao) => (v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : padrao);

// Movida para comunicacao.template.js (Checkpoint H.4-A) — reaproveitada aqui
// E pela pré-visualização somente-leitura do Painel Administrativo
// (administrativo.comunicacao.service.js#preverMensagem) sem violar o teste
// arquitetural que só permite worker-comunicacao/ importar ESTE arquivo: o
// template é puro texto, não é o pipeline de orquestração.

/**
 * A pendência que originou este alerta existe NESTE snapshot? Função pura — o
 * snapshot vem de UMA leitura de `pendencias()` por ciclo/lote.
 * @param {{unidades?: Array<{organizacaoId: string, unidadeId: string, criticidade: string}>}} snapshot
 * @param {{organizacao_id: string, unidade_id: string|null}} alerta
 */
export function pendenciaExisteNoSnapshot(snapshot, alerta) {
  return (snapshot?.unidades ?? []).some((u) => u.organizacaoId === alerta.organizacao_id && u.unidadeId === alerta.unidade_id
    && (u.criticidade === SEVERIDADE.ATENCAO || u.criticidade === SEVERIDADE.CRITICO));
}

/**
 * Sincroniza comunicacao_alertas com a lista REAL de pendências (fonte:
 * administrativo.service.pendencias() — monitor dashboard_ifood/D-1).
 * Cria/escalona o que ainda é pendência; RESOLVE (e cancela envio ainda não
 * reivindicado) o que deixou de aparecer na lista.
 *
 *   - `pendenciasSnapshot` (opcional): o snapshot do ciclo. Sem ele, lê `pendencias()` agora.
 *   - NEGÓCIO × TRANSPORTE: o alerta é a pendência; a incerteza de entrega é da MENSAGEM. Uma
 *     pendência que sumiu resolve o alerta MESMO com uma mensagem em DELIVERY_UNKNOWN (ela
 *     continua exigindo reconciliação e segue contando nos limites; nada novo é enviado por
 *     causa dela — quem cria mensagem é só o agendamento, que recusa evento com UNKNOWN).
 *   - Uma organização que ZEROU as pendências também tem os alertas resolvidos
 *     (varre `organizacoesMonitoradas`, não só as que aparecem com problema).
 *   - Mensagem SENDING nunca é tocada; PROCESSING é encerrada pelo próprio job (com token).
 * @param {{hojeIso?: string, pendenciasSnapshot?: object}} [opts]
 * @param {{supabase?: any}} [deps]
 */
export async function detectarESincronizarAlertas({ hojeIso, pendenciasSnapshot } = {}, deps = {}) {
  const resultado = pendenciasSnapshot ?? await pendencias({ hojeIso }, deps);
  const criados = [], escalonados = [], resolvidos = [], terminaisIgnorados = [];

  const chavesAtuais = new Set();
  for (const u of resultado.unidades) {
    if (u.criticidade !== SEVERIDADE.ATENCAO && u.criticidade !== SEVERIDADE.CRITICO) continue;
    const dataReferencia = u.pendenciaMaisAntiga ?? resultado.d1;
    if (!dataReferencia) continue; // sem data de referência não há como formar a chave — não deveria acontecer

    const { alerta, criado, escalonado, terminal } = await alertasRepo.criarOuEscalonarAlerta({
      organizacaoId: u.organizacaoId, unidadeId: u.unidadeId,
      tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, dataReferencia,
      destinatarioPerfilId: null, // resolvido depois, em agendarEnviosPendentes
      severidade: u.criticidade,
      motivo: `${u.diasPendentes} dia(s) pendente(s)${u.pendenciaHerdada ? ` (herdado desde ${u.pendenciaHerdadaDesde})` : ""}`,
      metadados: { unidade_nome: u.unidadeNome ?? null, empresa_nome: u.empresaNome ?? null },
    }, deps);
    if (terminal) { terminaisIgnorados.push(alerta.id); continue; } // mesma pendência que persiste: NÃO é evento novo
    chavesAtuais.add(alerta.id);
    if (criado) criados.push(alerta);
    if (escalonado) escalonados.push(alerta);
  }

  // O que estava ATIVO e não apareceu nesta rodada -> a pendência sumiu (regularizada).
  // A varredura é por organização MONITORADA neste snapshot (nunca um wildcard: não toca
  // tenants que este ciclo não avaliou) — inclusive as que ficaram sem nenhuma pendência.
  const organizacoesMonitoradas = new Set(resultado.organizacoesMonitoradas ?? resultado.unidades.map((u) => u.organizacaoId));
  for (const orgId of organizacoesMonitoradas) {
    const ativosDaOrg = await alertasRepo.listarAlertasAtivos({ organizacaoId: orgId, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1 }, deps);
    for (const a of ativosDaOrg) {
      if (chavesAtuais.has(a.id)) continue;
      if (!(await alertasRepo.resolverAlerta(a.id, deps))) continue; // já terminal: nada a fazer
      const canceladas = await filaRepo.cancelarPendentesPorAlerta(a.id, deps);
      resolvidos.push({ alertaId: a.id, mensagensCanceladas: canceladas.length });
    }
  }

  return {
    criados: criados.length, escalonados: escalonados.length, resolvidos: resolvidos.length, detalheResolvidos: resolvidos,
    terminaisIgnorados: terminaisIgnorados.length,
  };
}

/**
 * Para alertas DETECTED com organização HABILITADA e um contato resolvível, agenda o
 * envio — IDEMPOTENTE (mesma idempotencyKey por alerta: chamar 100 vezes gera no
 * máximo UMA mensagem) e ATÔMICO (mensagem + alerta SCHEDULED na mesma transação).
 *
 * HORÁRIO REAL: timezone IANA e janela da ORGANIZAÇÃO (ou a global, se ela não tiver
 * janela própria). Se `agora` está dentro da janela, envia já; senão, abertura da
 * PRÓXIMA janela + jitter determinístico (hash da idempotency_key + data lógica +
 * organização — nunca Math.random). Pausa ativa (`pausado_ate`) empurra o início.
 * `expira_em` = instante de envio + `ttl_horas`.
 *
 * FAIL-CLOSED: organização sem habilitação/tipo/DESTINATÁRIO explícito não recebe
 * agendamento (o alerta continua DETECTED, sem mensagem órfã); timezone/janela inválidos
 * idem (`configInvalida`) — nunca assume UTC. O evento cuja mensagem JÁ EXPIROU não é
 * recriado (`mensagensExpiradas`): lembrete/nova versão exige uma regra explícita futura.
 *
 * `organizacaoId` omitido = agenda a FROTA INTEIRA num lote só. Passe `organizacaoId`
 * para escopar a um teste/cenário específico.
 * @param {{organizacaoId?: string|null, tipoAlerta?: string, agora?: Date, resolverHabilitacao?: Function}} [params]
 */
export async function agendarEnviosPendentes({
  organizacaoId = null, tipoAlerta = TIPOS_ALERTA.DASHBOARD_IFOOD_D1, agora = new Date(), resolverHabilitacao = resolverHabilitacaoEmpresa,
} = {}, deps = {}) {
  const r = {
    agendados: 0, semDestinatario: 0, destinatarioInelegivel: 0, semHabilitacao: 0, configInvalida: 0,
    jaExistiam: 0, mensagensExpiradas: 0, entregaDesconhecida: 0, ignorados: 0,
  };
  const ativos = await alertasRepo.listarAlertasAtivos({ organizacaoId, tipoAlerta }, deps);
  const detectados = ativos.filter((a) => a.status === STATUS_ALERTA.DETECTED);
  if (!detectados.length) return r;

  const [janelasGlobais, ttlHoras, jitterMaxMs] = await Promise.all([obterConfig("janelas", deps), obterTtlHoras(deps), obterJitterMaxMs(deps)]);
  const habilitacoes = new Map(); // uma leitura por organização por ciclo
  const habilitacaoDa = async (orgId) => {
    if (!habilitacoes.has(orgId)) habilitacoes.set(orgId, await resolverHabilitacao({ organizacaoId: orgId, tipoAlerta, agora }, deps));
    return habilitacoes.get(orgId);
  };

  for (const alerta of detectados) {
    const hab = await habilitacaoDa(alerta.organizacao_id);
    if (hab?.empresaHabilitada !== true || hab?.tipoPermitido !== true) { r.semHabilitacao += 1; continue; }
    const janelas = janelasEfetivas(hab, janelasGlobais);
    // pausa ativa sem um fim legível: não há horário confiável -> não agenda
    if (!janelas || (hab.empresaPausada === true && !hab.pausadoAte)) { r.configInvalida += 1; continue; }

    // DESTINATÁRIO EXPLÍCITO: sem ele não há para quem enviar (fail-closed). O par contato/perfil
    // NÃO é escolhido aqui nem passado ao banco — `comunicacao_agendar_mensagem_alerta` o lê da
    // habilitação da organização e ainda revalida consentimento/verificação/opt-out/vínculo.
    if (!hab.destinatarioContatoId || !hab.destinatarioPerfilId) { r.semDestinatario += 1; continue; }

    const idempotencyKey = `wa:alerta:${alerta.id}:v1`;
    const base = hab.empresaPausada === true && hab.pausadoAte && hab.pausadoAte.getTime() > agora.getTime() ? hab.pausadoAte : agora;
    let instante;
    try {
      ({ instante } = proximoHorarioDeEnvio(base, hab.timezone, janelas,
        chaveDeJitter({ idempotencyKey, dataLogica: alerta.data_referencia, organizacaoId: alerta.organizacao_id }),
        { spreadMaxMs: jitterMaxMs }));
    } catch (e) {
      if (e instanceof ConfiguracaoHorarioInvalida) { r.configInvalida += 1; continue; }
      throw e;
    }

    const conteudo = formatarMensagemPendencia({
      unidadeNome: alerta.metadados?.unidade_nome ?? null,
      diasPendentes: Number(alerta.motivo?.match(/^(\d+)/)?.[1] ?? 1),
      pendenciaMaisAntiga: alerta.data_referencia,
    });

    const res = await filaRepo.agendarMensagemDoAlerta({
      alertaId: alerta.id,
      tipo: alerta.tipo_alerta, conteudo, idempotencyKey,
      disponivelEm: instante, expiraEm: new Date(instante.getTime() + ttlHoras * HORA),
    }, deps);
    if (res.acao === "CRIADA") r.agendados += 1;
    else if (res.acao === "JA_EXISTIA") r.jaExistiam += 1;
    else if (res.acao === "MENSAGEM_EXPIRADA") r.mensagensExpiradas += 1;
    else if (res.acao === "ENTREGA_DESCONHECIDA") r.entregaDesconhecida += 1;
    else if (res.acao === "NAO_HABILITADA" || res.acao === "TIPO_NAO_PERMITIDO") r.semHabilitacao += 1;
    else if (res.acao === "SEM_DESTINATARIO") r.semDestinatario += 1;
    else if (res.acao === "DESTINATARIO_INELEGIVEL") r.destinatarioInelegivel += 1;
    else r.ignorados += 1; // ALERTA_NAO_DETECTED | CHAVE_EM_USO | ALERTA_INEXISTENTE
  }
  return r;
}

/**
 * REFORÇO DE PRAZO FINAL D-1 — a 2ª e ÚLTIMA mensagem de um alerta dashboard_ifood_d1 cujo prazo
 * vence HOJE (dataReferencia === diaAnterior(hoje local); backlog antigo nunca) e cuja 1ª mensagem
 * (`wa:alerta:{id}:v1`) já saiu HOJE. Só AGENDA: a mensagem entra na MESMA fila do primeiro aviso e
 * passa pelo MESMO claim -> JIT (revalidação definitiva, com as regras do reforço) -> policy ->
 * reserva (rate-limit) -> gateway -> provider. Nenhum transporte paralelo.
 *
 * Só cria quando TODOS valem: alerta em SENT/DELIVERED/READ; empresa habilitada e não pausada;
 * hoje é segunda a sábado e agora está em 20:00–22:00 locais (comunicacao.reforco.js); a 1ª mensagem
 * saiu hoje há >= 2h (espaçamento PRÓPRIO — o cooldown normal de 8h/4h não controla o reforço);
 * destinatário explícito. `expiraEm` = 22:30 locais (hard cutoff): nunca vira cobrança de amanhã.
 * Idempotência: `wa:alerta:{id}:reforco:v1`, única no banco (RPC 092).
 * @param {{organizacaoId?: string|null, tipoAlerta?: string, agora?: Date, resolverHabilitacao?: Function}} [params]
 */
export async function agendarReforcosPendentes({
  organizacaoId = null, tipoAlerta = TIPOS_ALERTA.DASHBOARD_IFOOD_D1, agora = new Date(), resolverHabilitacao = resolverHabilitacaoEmpresa,
} = {}, deps = {}) {
  const r = {
    agendados: 0, jaExistiam: 0, semHabilitacao: 0, empresaPausada: 0, semDestinatario: 0, destinatarioInelegivel: 0, configInvalida: 0,
    foraDaJanelaReforco: 0, foraDoPrazoD1: 0, primeiraNaoEnviada: 0, primeiraDeOutroDia: 0, espacamentoPendente: 0, entregaEmCurso: 0, ignorados: 0,
  };
  const ativos = await alertasRepo.listarAlertasAtivos({ organizacaoId, tipoAlerta }, deps);
  const candidatos = ativos.filter((a) => a.tipo_alerta === TIPOS_ALERTA.DASHBOARD_IFOOD_D1 && STATUS_JA_ENVIADOS.includes(a.status));
  if (!candidatos.length) return r;

  const habilitacoes = new Map(); // uma leitura por organização por ciclo
  const habilitacaoDa = async (orgId) => {
    if (!habilitacoes.has(orgId)) habilitacoes.set(orgId, await resolverHabilitacao({ organizacaoId: orgId, tipoAlerta, agora }, deps));
    return habilitacoes.get(orgId);
  };

  for (const alerta of candidatos) {
    const hab = await habilitacaoDa(alerta.organizacao_id);
    if (hab?.empresaHabilitada !== true || hab?.tipoPermitido !== true) { r.semHabilitacao += 1; continue; }
    if (hab.empresaPausada === true) { r.empresaPausada += 1; continue; }
    if (hab.configHorarioValida !== true || !hab.timezone) { r.configInvalida += 1; continue; }
    if (!hab.destinatarioContatoId || !hab.destinatarioPerfilId) { r.semDestinatario += 1; continue; }

    let janela;
    try { janela = janelaDeReforcoAgora(agora, hab.timezone); }
    catch (e) {
      if (e instanceof ConfiguracaoHorarioInvalida) { r.configInvalida += 1; continue; }
      throw e;
    }
    if (!janela) { r.foraDaJanelaReforco += 1; continue; }
    // H.4-A.8: SÓ o D-1 que vence hoje; comparação de DATA, nunca contagem de dias pendentes.
    if (!prazoD1VenceHoje(alerta.data_referencia, agora, hab.timezone)) { r.foraDoPrazoD1 += 1; continue; }

    const inicial = await filaRepo.obterMensagemInicialDoAlerta(alerta.id, deps);
    if (!inicial || !STATUS_JA_ENVIADOS.includes(inicial.status) || !inicial.enviado_em) { r.primeiraNaoEnviada += 1; continue; }
    if (!mesmoDiaLocal(inicial.enviado_em, agora, hab.timezone)) { r.primeiraDeOutroDia += 1; continue; }
    if (!espacamentoCumprido(inicial.enviado_em, agora)) { r.espacamentoPendente += 1; continue; }

    const idempotencyKey = chaveIdempotenciaReforco(alerta.id);
    const instante = instanteDoReforco(agora, janela, chaveDeJitter({ idempotencyKey, dataLogica: alerta.data_referencia, organizacaoId: alerta.organizacao_id }));
    const conteudo = formatarMensagemReforcoDia({
      unidadeNome: alerta.metadados?.unidade_nome ?? null, pendenciaMaisAntiga: alerta.data_referencia,
    });
    const res = await filaRepo.agendarReforcoDoAlerta({ alertaId: alerta.id, conteudo, disponivelEm: instante, expiraEm: janela.cutoff }, deps);
    if (res.acao === "CRIADA") r.agendados += 1;
    else if (res.acao === "JA_EXISTIA") r.jaExistiam += 1;
    else if (res.acao === "ENTREGA_EM_CURSO") r.entregaEmCurso += 1;
    else if (res.acao === "NAO_HABILITADA" || res.acao === "TIPO_NAO_PERMITIDO") r.semHabilitacao += 1;
    else if (res.acao === "SEM_DESTINATARIO") r.semDestinatario += 1;
    else if (res.acao === "DESTINATARIO_INELEGIVEL") r.destinatarioInelegivel += 1;
    else if (res.acao === "ALERTA_SEM_PRIMEIRO_ENVIO" || res.acao === "PRIMEIRA_MENSAGEM_NAO_ENVIADA") r.primeiraNaoEnviada += 1;
    else r.ignorados += 1; // ALERTA_INEXISTENTE | CHAVE_INVALIDA | CHAVE_EM_USO
  }
  return r;
}

/**
 * JIT ESPECÍFICO DO REFORÇO (H.4-A.8): as condições que só valem para `proposito=reforco` — a janela
 * comercial normal NÃO se aplica a ele. Devolve `null` se tudo vale, senão o MOTIVO do cancelamento
 * TERMINAL (o reforço nunca é reagendado para outro dia; provider = 0). Consentimento/verificação/
 * opt-out/habilitação/piloto/rate-limit continuam na policy e na reserva, iguais às da mensagem inicial.
 * A existência da pendência é revalidada antes, no passo 1 do JIT (`verificarPendenciaAindaExiste`).
 */
async function motivoDeCancelamentoDoReforco({ job, alerta, timezone, agora }, deps) {
  if (!alerta || alerta.tipo_alerta !== TIPOS_ALERTA.DASHBOARD_IFOOD_D1 || job.tipo !== TIPOS_ALERTA.DASHBOARD_IFOOD_D1) return MOTIVO_REFORCO.TIPO_NAO_SUPORTADO;
  if (!prazoD1VenceHoje(alerta.data_referencia, agora, timezone)) return MOTIVO_REFORCO.PRAZO_NAO_E_HOJE;
  if (!janelaDeReforcoAgora(agora, timezone)) return MOTIVO_REFORCO.FORA_DA_JANELA; // domingo, antes das 20:00, a partir das 22:00 ou do cutoff 22:30
  const inicial = await filaRepo.obterMensagemInicialDoAlerta(alerta.id, deps);
  if (!inicial || !STATUS_JA_ENVIADOS.includes(inicial.status) || !inicial.enviado_em || !mesmoDiaLocal(inicial.enviado_em, agora, timezone)) return MOTIVO_REFORCO.PRIMEIRA_NAO_ENVIADA;
  if (!espacamentoCumprido(inicial.enviado_em, agora)) return MOTIVO_REFORCO.ESPACAMENTO_INSUFICIENTE;
  return null;
}

/** Revalidação AO VIVO (uma leitura de `pendencias()` por chamada) — só o fallback de quem chama `processarJobReivindicado` sem snapshot. */
async function pendenciaAindaExisteAoVivo(alerta, deps) {
  return pendenciaExisteNoSnapshot(await pendencias({}, deps), alerta);
}

/** Diagnóstico/auditoria nunca pode derrubar nem reclassificar um envio já decidido. */
async function melhorEsforco(fn) {
  try { return await fn(); } catch (e) { console.error("[comunicacao] registro auxiliar falhou:", String(e?.message ?? e).slice(0, 200)); return null; }
}
const sanitizarErro = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * A FRONTEIRA (ajuste aprovado): claim atômico + Policy Engine + reserva atômica de
 * capacidade + WhatsAppService. Não é chamada em loop por este processo — quem chama
 * em intervalo é o worker persistente (ainda não existe). Segura para chamar
 * manualmente/via teste quantas vezes quiser.
 *
 * PORTÃO DE MODO (D.3-C): só processa com modo === NORMAL. Em DISABLED,
 * REACTIVE_ONLY ou qualquer valor desconhecido NÃO reivindica nada — as
 * mensagens ficam SCHEDULED, intactas, esperando o operador religar. (O
 * Policy Engine ainda bloqueia por modo dentro de cada job, como defesa em
 * profundidade contra o modo mudar entre o portão e a avaliação.)
 *
 * `pendencias()` é lido NO MÁXIMO UMA VEZ por lote (ou nenhuma, se o chamador já
 * passou o `pendenciasSnapshot` do ciclo) — nunca uma vez por job/unidade.
 *
 * `verificarPendenciaAindaExiste` e `resolverHabilitacao` são injetáveis (mesmo
 * espírito do `deps` usado em todo o módulo) — em produção são o snapshot do motor do
 * Painel Administrativo e a habilitação persistida (comunicacao.habilitacao.js);
 * os testes injetam versões controladas.
 * @param {{limite?: number, worker?: string, whatsAppService: import('./whatsapp.service.js').ReturnType, agora?: Date, adiamentoMs?: number, pendenciasSnapshot?: object, verificarPendenciaAindaExiste?: (alerta: object, deps: object) => Promise<boolean>, resolverHabilitacao?: (params: {organizacaoId: string, tipoAlerta: string, agora?: Date}, deps: object) => Promise<import('./comunicacao.habilitacao.js').Habilitacao>}} params
 */
export async function processarProximoLote({
  limite = 10, worker = "manual", whatsAppService, agora = new Date(), adiamentoMs = ADIAMENTO_PADRAO_MS,
  pendenciasSnapshot = null, verificarPendenciaAindaExiste = null, resolverHabilitacao = resolverHabilitacaoEmpresa,
}, deps = {}) {
  if ((await modoAtual(deps)) !== MODOS.NORMAL) return [];

  // TTL: a MENSAGEM que expirou sem sair é cancelada ANTES do claim (relógio do banco) — um aviso
  // velho nunca chega a ser reivindicado. A PENDÊNCIA NÃO expira: o alerta continua ativo (o
  // trigger do banco o devolve a DETECTED) e só vira RESOLVED quando `pendencias()` provar que a
  // condição de negócio sumiu. NENHUMA mensagem nova nasce daqui (lembrete/escalonamento = regra futura).
  const expiradas = await filaRepo.cancelarExpiradas({ worker }, deps);
  for (const m of expiradas) {
    await melhorEsforco(() => auditar({
      acao: ACOES.COMUNICACAO_ENVIO_BLOQUEADO, atorTipo: "sistema", organizacaoId: m.organizacao_id,
      entidade: "comunicacao_mensagens", entidadeId: m.id,
      detalhes: { motivo: MOTIVO_EXPIRADA, tipo: m.tipo, transitorio: false, statusResultante: STATUS_MENSAGEM.CANCELLED },
    }));
  }

  const jobs = await filaRepo.claimJobs({ limite, worker }, deps);
  if (!jobs.length) return [];

  // UMA leitura de `pendencias()` por lote (memoizada; lazy — só se algum job precisar).
  let snapshotEmVoo = pendenciasSnapshot ? Promise.resolve(pendenciasSnapshot) : null;
  const obterSnapshot = () => (snapshotEmVoo ??= pendencias({}, deps));
  const verificar = verificarPendenciaAindaExiste ?? (async (alerta) => pendenciaExisteNoSnapshot(await obterSnapshot(), alerta));

  const resultados = [];
  for (const job of jobs) {
    try {
      resultados.push(await processarJobReivindicado(job, { whatsAppService, agora, adiamentoMs, verificarPendenciaAindaExiste: verificar, resolverHabilitacao }, deps));
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

/**
 * UM CICLO completo com UM snapshot: lê `pendencias()` uma vez e alimenta detecção,
 * agendamento e processamento — todos os alertas do ciclo derivam da MESMA leitura
 * da frota. Não é chamado por ninguém (sem boot/cron/worker).
 * @param {{whatsAppService: object, agora?: Date, hojeIso?: string, limite?: number, worker?: string, adiamentoMs?: number, resolverHabilitacao?: Function, lerPendencias?: Function, organizacaoId?: string|null}} params
 */
export async function executarCiclo({ whatsAppService, agora = new Date(), hojeIso, limite = 10, worker = "ciclo", adiamentoMs = ADIAMENTO_PADRAO_MS, resolverHabilitacao = resolverHabilitacaoEmpresa, lerPendencias = pendencias, organizacaoId = null }, deps = {}) {
  const snapshot = await lerPendencias({ hojeIso }, deps); // a ÚNICA leitura da frota neste ciclo
  const deteccao = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshot }, deps);
  const agendamento = await agendarEnviosPendentes({ organizacaoId, agora, resolverHabilitacao }, deps);
  const reforco = await agendarReforcosPendentes({ organizacaoId, agora, resolverHabilitacao }, deps);
  const lote = await processarProximoLote({ limite, worker, whatsAppService, agora, adiamentoMs, pendenciasSnapshot: snapshot, resolverHabilitacao }, deps);
  return {
    snapshot: { dataReferencia: snapshot.dataReferencia, d1: snapshot.d1, unidadesComPendencia: snapshot.total },
    deteccao, agendamento, reforco, lote,
  };
}

const POSSE_PERDIDA = (job) => ({ id: job.id, resultado: "POSSE_PERDIDA" });

/**
 * TTL vencido: a MENSAGEM NUNCA é enviada — CANCELLED + motivo EXPIRADA (sem status novo). O
 * ALERTA NÃO é cancelado: a pendência de negócio persiste (o trigger do banco o devolve a
 * DETECTED); só `pendencias()` o resolve. `linhaJaCancelada`: a reserva atômica (088) já
 * cancelou a linha na própria transação; nesse caso não há mais o que encerrar com o token do claim.
 */
async function cancelarPorExpiracao(job, claim, deps, { linhaJaCancelada = false } = {}) {
  if (!linhaJaCancelada) {
    const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.CANCELLED, motivo: MOTIVO_EXPIRADA }, deps);
    if (!r) return POSSE_PERDIDA(job);
  }
  await auditar({
    acao: ACOES.COMUNICACAO_ENVIO_BLOQUEADO, atorTipo: "sistema", organizacaoId: job.organizacao_id,
    entidade: "comunicacao_mensagens", entidadeId: job.id,
    detalhes: { motivo: MOTIVO_EXPIRADA, tipo: job.tipo, transitorio: false, statusResultante: STATUS_MENSAGEM.CANCELLED },
  });
  return { id: job.id, resultado: "CANCELADO_EXPIRADA" };
}

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
 *   - O ATTEMPT só nasce em `reservarEnvio` (PROCESSING -> SENDING, `tentativas`+1,
 *     migration 088 — a reserva de capacidade é atômica, sob advisory lock). O
 *     provider só é chamado DEPOIS de INICIADO; qualquer outro resultado = NÃO envia
 *     (posse perdida aborta sem efeito externo; capacidade/cooldown adia; TTL cancela).
 */
export async function processarJobReivindicado(job, {
  whatsAppService, agora = new Date(), adiamentoMs = ADIAMENTO_PADRAO_MS,
  verificarPendenciaAindaExiste = pendenciaAindaExisteAoVivo, resolverHabilitacao = resolverHabilitacaoEmpresa,
}, deps = {}) {
  const claim = { id: job.id, worker: job.claimed_by, claimGeracao: job.claim_geracao };

  // 0) attempts reais já esgotados (política de retries de falha PRÉ-ENVIO):
  //    não há mais o que tentar -> FAILED. (BLOCKED é só veto de política.)
  if (job.tentativas >= job.max_tentativas) {
    const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.FAILED, motivo: "TENTATIVAS_ESGOTADAS" }, deps);
    if (!r) return POSSE_PERDIDA(job);
    // (o alerta acompanha a mensagem FAILED pelo trigger do banco — sem passo JS entre as duas escritas)
    return { id: job.id, resultado: "FALHOU_TENTATIVAS_ESGOTADAS" };
  }

  // 0b) TTL: um aviso velho perdeu o sentido. (O relógio DO BANCO decide de novo, em
  //     `reservarEnvio`, no instante de enviar — este é o atalho antes de qualquer trabalho.)
  if (job.expira_em && new Date(job.expira_em).getTime() <= agora.getTime()) return cancelarPorExpiracao(job, claim, deps);

  // 1) revalida o alerta/pendência (teste 6) — se o evento já não existe como problema
  //    real, cancela ESTE job (com o token do claim) em vez de mandar um aviso obsoleto.
  let alerta = null;
  if (job.alerta_id) {
    alerta = await alertasRepo.obterAlerta(job.alerta_id, deps);
    if (alerta && (alerta.status === STATUS_ALERTA.CANCELLED || alerta.status === STATUS_ALERTA.RESOLVED)) {
      // alerta já encerrado: NUNCA enviar o aviso de um evento que não existe mais.
      const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.CANCELLED, motivo: "ALERTA_ENCERRADO" }, deps);
      if (!r) return POSSE_PERDIDA(job);
      return { id: job.id, resultado: "CANCELADO_ALERTA_ENCERRADO" };
    }
    if (alerta) {
      const aindaExiste = await verificarPendenciaAindaExiste(alerta, deps);
      if (!aindaExiste) {
        const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.CANCELLED, motivo: "PENDENCIA_RESOLVIDA" }, deps);
        if (!r) return POSSE_PERDIDA(job);
        await filaRepo.cancelarPendentesPorAlerta(alerta.id, deps); // qualquer OUTRO pendente (SCHEDULED) do mesmo alerta
        await alertasRepo.resolverAlerta(alerta.id, deps); // guardado: nunca sobrescreve RESOLVED/CANCELLED
        return { id: job.id, resultado: "CANCELADO_PENDENCIA_RESOLVIDA" };
      }
    }
  }

  // 2) monta o snapshot do Policy Engine (100% dados já resolvidos — nada de I/O dentro de avaliarEnvio).
  const [modo, janelasGlobais, cooldowns, limites, contato, perfil, statusProvider, habilitacao] = await Promise.all([
    modoAtual(deps), obterConfig("janelas", deps), obterConfig("cooldowns_horas", deps),
    obterConfig("limites", deps),
    job.contato_id ? contatosRepo.obterContato(job.contato_id, deps) : null,
    job.destinatario_perfil_id ? contatosRepo.obterPerfilOperacional(job.destinatario_perfil_id, deps) : null,
    // Gateway fora do ar NÃO é erro do job: é "provider offline" (bloqueio transitório).
    Promise.resolve().then(() => whatsAppService.getStatus()).catch(() => ({ conectado: false })),
    resolverHabilitacao({ organizacaoId: job.organizacao_id, tipoAlerta: job.tipo, agora }, deps),
  ]);

  // O destinatário é configurado por ORGANIZAÇÃO (habilitação): o vínculo exigido é o da organização
  // (usuarios_organizacoes ativo) — não o de uma unidade específica do alerta.
  const vinculoValido = job.destinatario_perfil_id
    ? await contatosRepo.perfilTemVinculo({ perfilId: job.destinatario_perfil_id, organizacaoId: job.organizacao_id, unidadeId: null }, deps)
    : false;

  // Duplicidade REAL: outra mensagem do mesmo evento que já saiu/pode ter saído (inclui DELIVERY_UNKNOWN).
  const duplicado = job.alerta_id ? await filaRepo.existeOutraEntregaDoAlerta({ alertaId: job.alerta_id, exceptId: job.id, proposito: propositoDaMensagem(job) }, deps) : false;

  // HORÁRIO: sempre no timezone IANA da organização — nunca a hora do servidor, nunca UTC assumido.
  const janelas = janelasEfetivas(habilitacao, janelasGlobais);
  let configHorarioValida = janelas !== null;
  let dentroDaJanela = false;
  if (janelas) {
    try { dentroDaJanela = dentroDaJanelaLocal(agora, habilitacao.timezone, janelas); }
    catch (e) { if (!(e instanceof ConfiguracaoHorarioInvalida)) throw e; configHorarioValida = false; }
  }

  // H.4-A.8 — JIT do REFORÇO: regras próprias (20:00-22:00, D-1 de hoje, dom fora, cutoff 22:30, 1ª enviada hoje há >= 2h).
  // Falhou qualquer uma -> cancelamento TERMINAL, provider = 0 (config de horário inválida cai na policy: CONFIG_INVALIDA).
  const ehReforco = propositoDaMensagem(job) === PROPOSITO.REFORCO;
  if (ehReforco && configHorarioValida) {
    let motivoReforco;
    try { motivoReforco = await motivoDeCancelamentoDoReforco({ job, alerta, timezone: habilitacao.timezone, agora }, deps); }
    catch (e) { if (!(e instanceof ConfiguracaoHorarioInvalida)) throw e; motivoReforco = null; configHorarioValida = false; }
    if (motivoReforco) {
      const r = await filaRepo.encerrarProcessamento({ ...claim, destino: DESTINO_SEM_ENVIO.CANCELLED, motivo: motivoReforco }, deps);
      if (!r) return POSSE_PERDIDA(job);
      await auditar({
        acao: ACOES.COMUNICACAO_ENVIO_BLOQUEADO, atorTipo: "sistema", organizacaoId: job.organizacao_id,
        entidade: "comunicacao_mensagens", entidadeId: job.id,
        detalhes: { motivo: motivoReforco, tipo: job.tipo, proposito: PROPOSITO.REFORCO, transitorio: false, statusResultante: r.status },
      });
      return { id: job.id, resultado: "CANCELADO_REFORCO_FORA_DE_CONDICAO", motivo: motivoReforco };
    }
  }

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
    empresaPausada: habilitacao?.empresaPausada,
    configHorarioValida,
    pendenciaAindaExiste: true, // já revalidado no passo 1 — chega aqui só se ainda existe (ou não é alerta)
    duplicado,
    // cooldown e cota são decididos ATOMICAMENTE em `reservarEnvio` (advisory lock): uma leitura
    // aqui seria a corrida "dois workers veem 4/5 e ambos enviam". O resultado da reserva volta
    // como COOLDOWN/RATE_LIMIT no mesmo vocabulário de bloqueio da política.
    cooldownAtivo: false,
    rateLimitExcedido: false,
    // reforço: a janela comercial normal não se aplica — o gate acima já provou 20:00-22:00 (ou config inválida, que a policy barra antes).
    dentroDaJanela: ehReforco ? true : dentroDaJanela,
    providerConectado: statusProvider?.conectado === true,
    // Checkpoint H.4-A: defesa em profundidade, opt-in via COMUNICACAO_PILOTO_ENABLED
    // (ver comunicacao.piloto.js). Com o piloto desligado, sempre `true` (não interfere).
    telefoneNaAllowlistPiloto: telefoneAutorizadoNoPiloto(contato?.telefone_e164),
  };

  /**
   * Bloqueio: TRANSITÓRIO -> volta a SCHEDULED no PRÓXIMO instante real (janela/timezone
   * da organização, pausa, cota do dia), SEM consumir attempt e SEM linha em
   * comunicacao_tentativas; PERMANENTE -> BLOCKED terminal (só uma ação humana muda).
   */
  const adiarOuBloquear = async (motivo, { ratePorDia = false } = {}) => {
    const transitorio = bloqueioEhTransitorio(motivo);
    let disponivelEm = null;
    if (transitorio) {
      disponivelEm = calcularDisponivelEm({
        motivo, agora, adiamentoMs, timezone: habilitacao?.timezone ?? null, janelas, pausadoAte: habilitacao?.pausadoAte ?? null, ratePorDia,
        chave: chaveDeJitter({ idempotencyKey: job.idempotency_key, dataLogica: alerta?.data_referencia ?? null, organizacaoId: job.organizacao_id }),
        jitterMaxMs: await obterJitterMaxMs(deps),
      });
    }
    // REFORÇO: um adiamento nunca o empurra para depois do cutoff (expira_em = 22:30 locais) nem para outro dia:
    // se o novo horário estouraria, ele EXPIRA (CANCELLED/EXPIRADA) em vez de virar cobrança velha.
    const expiraReforco = transitorio && ehReforco && (!disponivelEm || (job.expira_em && disponivelEm.getTime() >= new Date(job.expira_em).getTime()));
    const r = await filaRepo.encerrarProcessamento({
      ...claim, destino: expiraReforco ? DESTINO_SEM_ENVIO.CANCELLED : (transitorio ? DESTINO_SEM_ENVIO.SCHEDULED : DESTINO_SEM_ENVIO.BLOCKED),
      motivo: expiraReforco ? MOTIVO_EXPIRADA : motivo, disponivelEm: expiraReforco ? null : disponivelEm,
    }, deps);
    if (!r) return POSSE_PERDIDA(job);

    await auditar({
      acao: ACOES.COMUNICACAO_ENVIO_BLOQUEADO, atorTipo: "sistema", organizacaoId: job.organizacao_id,
      entidade: "comunicacao_mensagens", entidadeId: job.id,
      detalhes: { motivo, tipo: job.tipo, transitorio, statusResultante: r.status, disponivelEm: r.disponivel_em ?? null },
    });
    if (expiraReforco) return { id: job.id, resultado: "CANCELADO_REFORCO_EXPIRADO", motivo };
    if (transitorio) return { id: job.id, resultado: "ADIADO", motivo, disponivelEm: r.disponivel_em ?? null };
    // DUPLICATE = OUTRA mensagem do mesmo evento já saiu/pode ter saído (SENT ou DELIVERY_UNKNOWN): o evento NÃO está
    // "bloqueado", só esta segunda linha — o alerta não pode mudar de estado por causa dela.
    // O reforço é só a 2ª mensagem de um alerta cujo 1º aviso já saiu: o veto dele não muda o estado do alerta.
    if (job.alerta_id && motivo !== MOTIVOS_BLOQUEIO.DUPLICATE && propositoDaMensagem(job) !== PROPOSITO.REFORCO) await melhorEsforco(() => alertasRepo.atualizarStatusAlerta(job.alerta_id, STATUS_ALERTA.BLOCKED, deps));
    return { id: job.id, resultado: "BLOQUEADO", motivo };
  };

  const decisao = avaliarEnvio(snapshot);
  if (!decisao.allowed) return adiarOuBloquear(decisao.reason);

  // RESERVA ATÔMICA + PROCESSING -> SENDING ANTES da chamada externa, com CAS: aqui NASCE o
  // attempt. É o rastro durável que distingue "nunca tentei" (PROCESSING) de "estava tentando
  // quando morri" (SENDING) — e a PROVA de que este worker ainda é o dono do claim e de que a
  // capacidade (cooldown/cota diária/taxa por minuto) foi consumida sem corrida. Sem INICIADO,
  // o provider NÃO é chamado.
  const reserva = await filaRepo.reservarEnvio({
    ...claim, leaseSegundos: LEASE_ENVIO_SEGUNDOS,
    // reforço: cooldown normal (8h/4h) NÃO vale — o espaçamento próprio (>= 2h) já foi provado no JIT acima; cota diária e por minuto seguem valendo.
    cooldownHoras: ehReforco ? null : numeroOuPadrao(alerta ? cooldowns?.[alerta.severidade] ?? cooldowns?.atencao : cooldowns?.atencao, COOLDOWN_PADRAO_HORAS),
    maxPorContatoDia: numeroOuPadrao(limites?.max_por_contato_por_dia, LIMITE_DIA_PADRAO),
    // DUAS camadas, ambas precisam ter vaga (atômico no banco): global (o único número) e por organização.
    maxPorMinuto: numeroOuPadrao(limites?.max_proativas_por_minuto, LIMITE_MINUTO_PADRAO),
    maxPorMinutoOrganizacao: numeroOuPadrao(limites?.max_proativas_por_minuto_por_organizacao, LIMITE_MINUTO_ORGANIZACAO_PADRAO),
    inicioDia: inicioDoDiaLocal(agora, habilitacao.timezone), // a política já provou timezone válido
  }, deps);

  if (reserva.resultado === RESULTADO_RESERVA.POSSE_PERDIDA) return POSSE_PERDIDA(job);
  if (reserva.resultado === RESULTADO_RESERVA.EXPIRADA) return cancelarPorExpiracao(job, claim, deps, { linhaJaCancelada: true });
  if (reserva.resultado !== RESULTADO_RESERVA.INICIADO) {
    return adiarOuBloquear(MOTIVO_DA_RESERVA[reserva.resultado], { ratePorDia: reserva.resultado === RESULTADO_RESERVA.RATE_LIMIT_DIA });
  }

  const emEnvio = reserva.mensagem;
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
  // (o alerta acompanha a mensagem SENT pelo trigger do banco, na mesma instrução do finalizarEnvio)
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

  // INCERTO: a incerteza é de TRANSPORTE e fica na MENSAGEM (DELIVERY_UNKNOWN). O ALERTA não muda: continua
  // representando a pendência (pode ser RESOLVED se ela sumir). Enquanto houver a UNKNOWN, nada novo nasce
  // para o evento (o agendamento recusa) e ela segue contando nos limites.
  if (classificacao === CLASSIFICACAO_ERRO.INCERTO) return { id: job.id, resultado: "ENTREGA_INCERTA" };
  // (FAILED: o alerta acompanha a mensagem pelo trigger do banco)
  return { id: job.id, resultado: statusFinal === STATUS_MENSAGEM.SCHEDULED ? "FALHOU_RETRY" : "FALHOU_DEFINITIVO" };
}
