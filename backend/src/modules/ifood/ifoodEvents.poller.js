// Events do iFood — poller (um ciclo) e loop serial.
//
// CICLO (`executarCiclo`)
//   lease -> reprocessa pendentes -> lista conexões elegíveis
//     -> por grupo (isolado): poll -> persistir/processar -> (renova lease) -> ACK
//
// SEM setInterval: o próximo ciclo só nasce quando o anterior TERMINA (loop serial
// com espera calculada). Nunca há dois ciclos na mesma instância; entre instâncias
// o `ifood_poller_lease` (relógio do banco) garante um poller por vez.
//
// TOKEN: só pela interface comum `token.comAccessTokenValido` — este módulo não
// sabe se o token vem de authorization_code, refresh_token ou client_credentials.
// Escopo do token (`escopoDoToken`): 'app' -> um grupo com todos os merchants
// (lotes de até 100); 'conexao' -> um grupo por conexão (cada unidade, seu token).
//
// FENCING LEVE: o lease é renovado imediatamente antes do ACK. Se foi perdido
// (worker parado por muito tempo), NÃO reconhece — o outro poller cuida; o evento
// volta e a UNIQUE impede efeito duplicado.
//
// MULTI-LOJA: uma conexão NUNCA impede o polling das outras.
//   1. Seleção (modo distribuído): só conexões com credencial `order`; `reauth_required` é pulada sem chamar
//      o iFood e sai no resultado como `conexoesIgnoradas` (monitorável).
//   2. Isolamento: cada grupo roda no seu try/catch; a falha vira `conexoesComFalha` (conexão, merchant
//      mascarado, código, etapa, horário) e o ciclo segue. Só quando TODOS os grupos falham o erro sobe
//      (o loop aplica backoff — mesmo comportamento de antes com uma única conexão).
//   Globais de propósito (param o ciclo inteiro): 429 (throttling é do app, não da loja) e lease perdido.
//
// PILOTO (IFOOD_ORDER_PILOT_UNITS): o poller só enxerga conexões cuja UNIDADE está na lista — nos dois modos
//   (distribuído e centralizado). Fail-closed: lista vazia/ausente = nenhuma loja é consultada, nenhum token é
//   pedido/renovado e nenhum ACK sai. O critério é sempre `unidade_id` da conexão (nunca organização/merchant).
//   Eventos já gravados de uma unidade que saiu da lista NÃO são apagados nem aplicados: ficam pendentes.
//   A lista é relida a cada ciclo; um ciclo já em andamento termina com a lista com que começou.

import { IFOOD_APP_ORDER, IFOOD_EVENTS } from "./ifood.constants.js";
import { IFOOD_ERROS, ifoodErro } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import { mensagemSegura } from "./ifoodAcoes.util.js";
import * as eventsClient from "./ifoodEvents.client.js";
import { processarLote, reprocessarPendentes, enviarAcks } from "./ifoodEvents.service.js";
import { processarDetalhesPendentes } from "./ifoodOrder.service.js";
import { unidadeNoPilotoOrder } from "./ifoodOrderPiloto.js";

/** Grupos de polling conforme o escopo do token. */
export function montarGrupos(conexoes, escopo, tamanho = IFOOD_EVENTS.maxMerchantsPorPolling) {
  if (escopo === "app") {
    return eventsClient.dividirMerchantsEmLotes(conexoes.map((c) => c.merchant_id), tamanho)
      .map((merchantIds) => ({ conexaoId: null, merchantIds }));
  }
  return conexoes.map((c) => ({ conexaoId: c.id, merchantIds: [c.merchant_id] }));
}

// Mensagem de erro para log: além do "Bearer ***" de mensagemSegura, remove qualquer header de autorização inteiro.
const erroParaLog = (e) => mensagemSegura(e).replace(/authorization\s*[:=]\s*(bearer\s+)?\S+/gi, "[header removido]");

// Falha de token/credencial daquela conexão (e não do polling em si).
const ERROS_DE_AUTENTICACAO = new Set([
  IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA, IFOOD_ERROS.IFOOD_REFRESH_FALHOU, IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO,
  IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL, IFOOD_ERROS.IFOOD_TOKEN_TROCA_FALHOU,
]);

/**
 * @param {{
 *   repo: object, token: object, http?: object, client?: object,
 *   holder: string, leaseTtlS?: number, agora?: () => Date, log?: Function,
 *   appType?: string, unidadesPiloto?: () => string[],
 * }} p
 */
export function criarPoller({
  repo, token, http, client = eventsClient, holder,
  leaseTtlS = IFOOD_EVENTS.leaseTtlS, agora = () => new Date(), log = ifoodLog,
  // Events/Order trabalham com appType = "order" (NUNCA financial): quem decide de onde vem o token é o
  // Auth Provider (centralized_test -> token do app centralizado; distributed -> credencial `order` da conexão).
  appType = IFOOD_APP_ORDER,
  // Checkpoint C: `detalhes = { client? }` liga o passo "buscar Order Details dos pedidos pendentes" no fim de
  // cada ciclo. Desligado por padrão (o poller de Events continua funcionando sozinho).
  detalhes = null,
  // Unidades autorizadas (ids normalizados). Padrão: o que o token service lê de IFOOD_ORDER_PILOT_UNITS;
  // sem essa fonte = lista vazia (fail-closed). Nunca "todas as conexões" por omissão.
  unidadesPiloto = () => token?.unidadesPilotoOrder?.() ?? [],
}) {
  if (!holder) throw new Error("holder é obrigatório");
  let temLease = false;
  // Escopo do ciclo em andamento: conexões e merchants das unidades do piloto. Refeito a cada ciclo.
  let autorizadas = new Set();
  let merchantsAutorizados = new Set();
  let merchantsForaDoPiloto = new Set();   // merchants de conexões vivas cuja unidade NÃO está no piloto
  // `lease`: última leitura do lease (titular e vencimento) — só observabilidade; quem decide é o banco.
  const info = { ultimoCiclo: null, ultimoEstado: null, geracao: null, lease: null };

  const adquirir = async () => {
    const r = await repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder, ttlS: leaseTtlS });
    temLease = r.adquirido;
    info.lease = { souTitular: r.adquirido, titular: r.holder ?? null, ate: r.leaseAte ?? null };
    return r;
  };

  // TRAVA do token: nenhum token é pedido (nem renovado) para conexão/merchant fora do escopo do ciclo.
  // Distribuído: a conexão tem de estar entre as autorizadas. Centralizado (conexaoId null, token do app):
  // todos os merchants do lote têm de ser de unidades autorizadas.
  const comToken = async (grupo, merchantIds, fn) => {
    const dentro = grupo.conexaoId != null
      ? autorizadas.has(grupo.conexaoId)
      : merchantIds.length > 0 && merchantIds.every((m) => merchantsAutorizados.has(m));
    if (!dentro) throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
    return token.comAccessTokenValido({ conexaoId: grupo.conexaoId, appType, deps: { http }, fn });
  };

  async function pollGrupo(grupo, merchantIds) {
    return comToken(grupo, merchantIds, (accessToken) => client.buscarEventos({ accessToken, merchantIds, http }));
  }

  async function executarCiclo() {
    const inicio = agora();
    info.ultimoCiclo = inicio.toISOString();

    const lease = await adquirir();
    info.geracao = lease.geracao;
    if (!lease.adquirido) {
      log("info", "events.lease_de_outro", { titular: lease.holder, leaseAte: lease.leaseAte });
      return (info.ultimoEstado = { estado: "LEASE_DE_OUTRO" });
    }

    // PILOTO: a lista é lida a cada ciclo (hoje vem do `config`, fixado no boot — mudar a variável só vale depois
    // do restart/deploy). Vazia = nenhuma unidade: o ciclo não chama o iFood, não renova token e não faz ACK.
    const piloto = (unidadesPiloto() ?? []).map((u) => String(u).toLowerCase());
    autorizadas = new Set();
    merchantsAutorizados = new Set();
    merchantsForaDoPiloto = new Set();

    // Eventos persistidos que ficaram sem processar (queda entre persistir e processar) — só das unidades do piloto.
    const reproc = await reprocessarPendentes({ repo, agora, log, unidades: piloto })
      .catch((e) => { log("warn", "events.reprocessar_falhou", { erro: String(e?.message ?? e).slice(0, 200) }); return null; });

    // Distribuído (escopo 'conexao'): só conexões com credencial `order`. Centralizado de teste (escopo 'app'):
    // o token é do app, não há credencial por conexão — todas as conexões com merchant. NOS DOIS, só entram as
    // conexões cuja UNIDADE está em IFOOD_ORDER_PILOT_UNITS (nunca a empresa nem o merchant como critério).
    const escopo = token.escopoDoToken?.() ?? "conexao";
    const todas = escopo === "app" ? await repo.listarConexoesComMerchant() : await repo.listarConexoesElegiveisParaEvents();
    const conexoes = todas.filter((c) => unidadeNoPilotoOrder(piloto, c.unidade_id));
    const foraDoPiloto = todas.length - conexoes.length;
    for (const c of todas) if (!unidadeNoPilotoOrder(piloto, c.unidade_id)) merchantsForaDoPiloto.add(c.merchant_id);
    if (foraDoPiloto > 0) log("info", "events.conexoes_fora_do_piloto", { quantidade: foraDoPiloto });
    if (conexoes.length === 0) {
      log("info", "events.sem_merchants", { foraDoPiloto });
      return (info.ultimoEstado = { estado: "SEM_MERCHANTS", reprocessados: reproc?.tentados ?? 0, foraDoPiloto });
    }
    for (const c of conexoes) { autorizadas.add(c.id); merchantsAutorizados.add(c.merchant_id); }
    const porMerchant = new Map(conexoes.map((c) => [c.merchant_id, c]));

    // reauth_required: o refresh já falhou e só uma nova autorização resolve — NÃO chama o iFood por ela.
    const conexoesIgnoradas = [];
    const aptas = conexoes.filter((c) => {
      if (c.credencial_order_status !== "reauth_required") return true;
      const ignorada = { conexaoId: c.id, merchant: mascararId(c.merchant_id), motivo: "reauth_required", em: agora().toISOString() };
      conexoesIgnoradas.push(ignorada);
      log("warn", "events.conexao_ignorada", ignorada);
      return false;
    });
    const grupos = montarGrupos(aptas, escopo);

    // `grupos`: conexões (distribuído) ou lotes de merchants (centralizado) tentados neste ciclo.
    const total = { grupos: grupos.length, polls: 0, eventos: 0, novos: 0, reentregas: 0, acks: 0 };
    const conexoesComFalha = [];
    let primeiroErro = null;

    for (const grupo of grupos) {
      const etapa = { atual: "polling" };
      try {
        const global = await processarGrupo(grupo, { porMerchant, total, etapa });
        if (global) return (info.ultimoEstado = { ...global, ...total, conexoesComFalha, conexoesIgnoradas });
      } catch (e) {
        primeiroErro ??= e;
        const falha = {
          conexaoId: grupo.conexaoId,
          merchant: grupo.merchantIds.length === 1 ? mascararId(grupo.merchantIds[0]) : `${grupo.merchantIds.length} merchants`,
          codigo: e?.codigo ?? "ERRO_INTERNO",
          etapa: etapa.atual === "polling" && ERROS_DE_AUTENTICACAO.has(e?.codigo) ? "autenticacao" : etapa.atual,
          em: agora().toISOString(),
        };
        conexoesComFalha.push(falha);
        // Nunca token/header/segredo: só código, status HTTP e a mensagem sanitizada.
        log("error", "events.conexao_falhou", { ...falha, status: e?.details?.status ?? null, erro: erroParaLog(e) });
      }
    }

    // Todas as conexões aptas falharam (banco fora, iFood fora, ou a única loja): o erro sobe e o loop aplica
    // backoff. Com pelo menos uma bem-sucedida, o ciclo termina PARCIAL e segue no intervalo normal.
    if (grupos.length > 0 && conexoesComFalha.length === grupos.length) throw primeiroErro;

    if (detalhes) {
      // Falha aqui não derruba o ciclo: os eventos já foram persistidos e reconhecidos.
      total.detalhes = await processarDetalhesPendentes({
        repo, token, http, conexoesPorMerchant: porMerchant, agora, log, ...(detalhes.client ? { client: detalhes.client } : {}),
      }).catch((e) => { log("warn", "order.detalhes_passo_falhou", { erro: String(e?.message ?? e).slice(0, 200) }); return null; });
    }
    const estado = conexoesComFalha.length ? "PARCIAL" : grupos.length ? "OK" : "SEM_CONEXOES_APTAS";
    return (info.ultimoEstado = { estado, ...total, conexoesComFalha, conexoesIgnoradas });
  }

  /**
   * Um grupo (uma conexão no distribuído; um lote de merchants no centralizado): poll -> persistir/processar
   * -> renovar lease -> ACK. Devolve um estado GLOBAL que encerra o ciclo (429, lease perdido) ou null.
   * Lança em falha daquele grupo (quem chama isola). `etapa.atual` diz onde parou.
   */
  async function processarGrupo(grupo, { porMerchant, total, etapa }) {
    let merchantIds = grupo.merchantIds;
    let eventos;
    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        total.polls += 1;
        eventos = await pollGrupo(grupo, merchantIds);
        break;
      } catch (e) {
        if (e?.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED) {
          log("warn", "events.rate_limited", { polls: total.polls });
          return { estado: "RATE_LIMITED" };
        }
        // 403: o token não acessa alguns merchants. Tira SÓ eles e tenta de novo uma vez.
        const nao = e?.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO ? e.details?.unauthorizedMerchants : null;
        if (tentativa === 1 && Array.isArray(nao) && nao.length) {
          log("warn", "events.merchants_sem_permissao", { merchants: nao.map(mascararId) });
          merchantIds = merchantIds.filter((m) => !nao.includes(m));
          if (merchantIds.length === 0) { eventos = []; break; }
          continue;
        }
        throw e;
      }
    }
    if (!eventos || eventos.length === 0) return null;   // 204: nada a fazer, nada a reconhecer

    // Defesa: o iFood só deveria devolver os merchants pedidos. Se vier evento de uma loja NOSSA que está fora
    // do piloto, ele não é gravado, não é aplicado e NÃO é reconhecido (continua disponível no iFood).
    const alheios = eventos.filter((e) => merchantsForaDoPiloto.has(e?.merchantId));
    if (alheios.length) {
      total.eventosForaDoPiloto = (total.eventosForaDoPiloto ?? 0) + alheios.length;
      log("warn", "events.evento_fora_do_piloto", { quantidade: alheios.length });
      eventos = eventos.filter((e) => !merchantsForaDoPiloto.has(e?.merchantId));
      if (eventos.length === 0) return null;
    }

    total.eventos += eventos.length;
    // Persistir + processar. Se lançar, NADA é reconhecido (o evento volta no próximo polling).
    etapa.atual = "persistir";
    const { idsParaAck, resumo } = await processarLote({ eventosBrutos: eventos, conexoesPorMerchant: porMerchant, repo, agora, log });
    total.novos += resumo.novos;
    total.reentregas += resumo.reentregas;
    log("info", "events.lote", { ...resumo });

    if (idsParaAck.length === 0) return null;

    // Fencing leve: ainda sou o titular? Senão, não reconheço.
    etapa.atual = "lease";
    let fencing = await renovarParaAck();
    if (!fencing) {
      log("error", "events.lease_perdido_antes_do_ack", { titular: info.lease?.titular ?? null });
      return { estado: "LEASE_PERDIDO" };
    }

    etapa.atual = "ack";
    let semLease = false;
    let lotes = 0;
    const r = await enviarAcks({
      idsParaAck, repo, agora, log,
      dividir: client.dividirEmLotesDeAck,
      confirmar: async (ids) => {
        // Do 2º lote em diante, renova de novo: cada lote sai com um prazo recém-verificado.
        if ((lotes += 1) > 1) fencing = await renovarParaAck();
        const restanteMs = fencing ? fencing.restanteMs() : 0;
        if (restanteMs <= 0) { semLease = true; throw new Error("lease sem prazo para o ACK"); }
        // O prazo aborta o ACK (e qualquer retry dele) antes que o lease possa vencer.
        const sinal = AbortSignal.timeout(restanteMs);
        return comToken(grupo, merchantIds, (accessToken) => client.confirmarEventos({ accessToken, eventIds: ids, http, sinal }));
      },
    }).catch((e) => { if (semLease) return null; throw e; });
    if (semLease) {
      log("error", "events.lease_perdido_antes_do_ack", { titular: info.lease?.titular ?? null, lote: lotes });
      return { estado: "LEASE_PERDIDO" };
    }
    total.acks += r.confirmados;
    return null;
  }

  /**
   * Renova o lease para reconhecer. O prazo conta do instante ANTES da renovação: a linha do banco vence em
   * (relógio do banco na renovação + TTL), que é sempre depois disso. Com a margem, nenhum ACK desta instância
   * sai depois que o lease poderia ter vencido — e outra instância só consegue o lease depois do vencimento.
   * @returns {Promise<{restanteMs: () => number}|null>} null = não sou mais o titular.
   */
  async function renovarParaAck() {
    const antesMs = agora().getTime();
    const renovado = await adquirir();
    if (!renovado.adquirido) return null;
    const ateMs = antesMs + leaseTtlS * 1000 - IFOOD_EVENTS.margemFencingAckMs;
    return { restanteMs: () => ateMs - agora().getTime() };
  }

  /** Shutdown gracioso: libera o lease para outro poller assumir sem esperar o TTL. */
  async function encerrar() {
    if (!temLease) return false;
    temLease = false;
    return repo.liberarLease({ nome: IFOOD_EVENTS.leaseNome, holder }).catch(() => false);
  }

  return { executarCiclo, encerrar, info, holder };
}

/**
 * Loop SERIAL (sem setInterval). Intervalo de início a início, nunca abaixo de 30 s.
 * Erros: espera crescente (teto 5 min). 429/throttling: espera extra de 60 s.
 * `aoAgendarProximo(esperaMs)`: chamado antes de cada espera (observabilidade: "próximo ciclo em").
 */
export function criarLoopDoPoller({
  poller, intervaloMs = IFOOD_EVENTS.intervaloPollingMs, sleep, agora = () => Date.now(), log = ifoodLog, aoFinalizarCiclo, aoAgendarProximo,
}) {
  const intervalo = Math.max(Number(intervaloMs) || 0, IFOOD_EVENTS.intervaloMinimoMs);
  let parar = false;
  let falhasSeguidas = 0;
  let acordar = null;
  let promessaLoop = null;

  // SEM unref(): entre ciclos este timer é o que mantém o processo do worker vivo. Com unref (e sem
  // health server) o Node saía com código 0 logo depois do 1º ciclo, sem liberar o lease.
  // O shutdown não depende disso: parar() chama acordar() -> clearTimeout.
  const dormir = sleep ?? ((ms) => new Promise((resolve) => {
    const t = setTimeout(() => { acordar = null; resolve(); }, ms);
    acordar = () => { clearTimeout(t); acordar = null; resolve(); };
  }));

  async function rodar() {
    while (!parar) {
      const t0 = agora();
      let extraMs = 0;
      try {
        const r = await poller.executarCiclo();
        falhasSeguidas = 0;
        if (r?.estado === "RATE_LIMITED") extraMs = IFOOD_EVENTS.espera429Ms;
        aoFinalizarCiclo?.(r);
      } catch (e) {
        falhasSeguidas += 1;
        extraMs = Math.min(IFOOD_EVENTS.backoffMaxMs, 1000 * 2 ** Math.min(falhasSeguidas, 9));
        log("error", "events.ciclo_falhou", { codigo: e?.codigo ?? null, erro: String(e?.message ?? e).slice(0, 200), falhasSeguidas, esperaExtraMs: extraMs });
        aoFinalizarCiclo?.({ estado: "ERRO", codigo: e?.codigo ?? null });
      }
      if (parar) break;
      const esperaMs = Math.max(intervalo - (agora() - t0), 0) + extraMs;
      aoAgendarProximo?.(esperaMs);
      await dormir(esperaMs);
    }
  }

  return {
    intervaloMs: intervalo,
    iniciar() { promessaLoop ??= rodar(); return promessaLoop; },
    /**
     * Para depois do ciclo em andamento e libera o lease.
     * `prazoMs` (modo embarcado): espera o ciclo em voo no máximo isso. Se ele não terminou, o lease NÃO é
     * liberado — o ciclo ainda pode reconhecer eventos; o lease vence sozinho (TTL) e só então outra instância
     * assume. Sem `prazoMs` (worker dedicado): espera o ciclo terminar, como sempre.
     * @param {{prazoMs?: number}} [opcoes]
     * @returns {Promise<{drenado: boolean, leaseLiberado: boolean}>}
     */
    async parar({ prazoMs } = {}) {
      parar = true;
      acordar?.();
      if (prazoMs == null) {
        await promessaLoop;
        return { drenado: true, leaseLiberado: (await poller.encerrar?.()) === true };
      }
      let timer;
      const drenado = await Promise.race([
        Promise.resolve(promessaLoop).then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), prazoMs); }),
      ]);
      clearTimeout(timer);
      if (!drenado) return { drenado: false, leaseLiberado: false };
      return { drenado: true, leaseLiberado: (await poller.encerrar?.()) === true };
    },
  };
}
