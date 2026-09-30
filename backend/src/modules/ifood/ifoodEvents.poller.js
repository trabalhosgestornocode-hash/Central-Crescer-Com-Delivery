// Events do iFood — poller (um ciclo) e loop serial.
//
// CICLO (`executarCiclo`)
//   lease -> reprocessa pendentes -> lista merchants (conexões vivas)
//     -> por grupo: poll -> persistir/processar -> (renova lease) -> ACK
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

import { IFOOD_APP_ORDER, IFOOD_EVENTS } from "./ifood.constants.js";
import { IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import * as eventsClient from "./ifoodEvents.client.js";
import { processarLote, reprocessarPendentes, enviarAcks } from "./ifoodEvents.service.js";
import { processarDetalhesPendentes } from "./ifoodOrder.service.js";

/** Grupos de polling conforme o escopo do token. */
export function montarGrupos(conexoes, escopo, tamanho = IFOOD_EVENTS.maxMerchantsPorPolling) {
  if (escopo === "app") {
    return eventsClient.dividirMerchantsEmLotes(conexoes.map((c) => c.merchant_id), tamanho)
      .map((merchantIds) => ({ conexaoId: null, merchantIds }));
  }
  return conexoes.map((c) => ({ conexaoId: c.id, merchantIds: [c.merchant_id] }));
}

/**
 * @param {{
 *   repo: object, token: object, http?: object, client?: object,
 *   holder: string, leaseTtlS?: number, agora?: () => Date, log?: Function,
 *   appType?: string,
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
}) {
  if (!holder) throw new Error("holder é obrigatório");
  let temLease = false;
  const info = { ultimoCiclo: null, ultimoEstado: null, geracao: null };

  const adquirir = () => repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder, ttlS: leaseTtlS });

  const comToken = (conexaoId, fn) => token.comAccessTokenValido({ conexaoId, appType, deps: { http }, fn });

  async function pollGrupo(grupo, merchantIds) {
    return comToken(grupo.conexaoId, (accessToken) => client.buscarEventos({ accessToken, merchantIds, http }));
  }

  async function executarCiclo() {
    const inicio = agora();
    info.ultimoCiclo = inicio.toISOString();

    const lease = await adquirir();
    temLease = lease.adquirido;
    info.geracao = lease.geracao;
    if (!lease.adquirido) {
      log("info", "events.lease_de_outro", { titular: lease.holder, leaseAte: lease.leaseAte });
      return (info.ultimoEstado = { estado: "LEASE_DE_OUTRO" });
    }

    // Eventos persistidos que ficaram sem processar (queda entre persistir e processar).
    const reproc = await reprocessarPendentes({ repo, agora, log })
      .catch((e) => { log("warn", "events.reprocessar_falhou", { erro: String(e?.message ?? e).slice(0, 200) }); return null; });

    const conexoes = await repo.listarConexoesComMerchant();
    if (conexoes.length === 0) {
      log("info", "events.sem_merchants", {});
      return (info.ultimoEstado = { estado: "SEM_MERCHANTS", reprocessados: reproc?.tentados ?? 0 });
    }
    const porMerchant = new Map(conexoes.map((c) => [c.merchant_id, c]));
    const grupos = montarGrupos(conexoes, token.escopoDoToken?.() ?? "conexao");

    const total = { polls: 0, eventos: 0, novos: 0, reentregas: 0, acks: 0 };
    for (const grupo of grupos) {
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
            return (info.ultimoEstado = { estado: "RATE_LIMITED", ...total });
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
      if (!eventos || eventos.length === 0) continue;   // 204: nada a fazer, nada a reconhecer

      total.eventos += eventos.length;
      // Persistir + processar. Se lançar, NADA é reconhecido (o evento volta no próximo polling).
      const { idsParaAck, resumo } = await processarLote({ eventosBrutos: eventos, conexoesPorMerchant: porMerchant, repo, agora, log });
      total.novos += resumo.novos;
      total.reentregas += resumo.reentregas;
      log("info", "events.lote", { ...resumo });

      if (idsParaAck.length === 0) continue;

      // Fencing leve: ainda sou o titular? Senão, não reconheço.
      const renovado = await adquirir();
      temLease = renovado.adquirido;
      if (!renovado.adquirido) {
        log("error", "events.lease_perdido_antes_do_ack", { titular: renovado.holder });
        return (info.ultimoEstado = { estado: "LEASE_PERDIDO", ...total });
      }

      const r = await enviarAcks({
        idsParaAck, repo, agora, log,
        dividir: client.dividirEmLotesDeAck,
        confirmar: (ids) => comToken(grupo.conexaoId, (accessToken) => client.confirmarEventos({ accessToken, eventIds: ids, http })),
      });
      total.acks += r.confirmados;
    }
    if (detalhes) {
      // Falha aqui não derruba o ciclo: os eventos já foram persistidos e reconhecidos.
      total.detalhes = await processarDetalhesPendentes({
        repo, token, http, conexoesPorMerchant: porMerchant, agora, log, ...(detalhes.client ? { client: detalhes.client } : {}),
      }).catch((e) => { log("warn", "order.detalhes_passo_falhou", { erro: String(e?.message ?? e).slice(0, 200) }); return null; });
    }
    return (info.ultimoEstado = { estado: "OK", ...total });
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
 */
export function criarLoopDoPoller({
  poller, intervaloMs = IFOOD_EVENTS.intervaloPollingMs, sleep, agora = () => Date.now(), log = ifoodLog, aoFinalizarCiclo,
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
      await dormir(Math.max(intervalo - (agora() - t0), 0) + extraMs);
    }
  }

  return {
    intervaloMs: intervalo,
    iniciar() { promessaLoop ??= rodar(); return promessaLoop; },
    /** Para depois do ciclo em andamento e libera o lease. */
    async parar() {
      parar = true;
      acordar?.();
      await promessaLoop;
      await poller.encerrar?.();
    },
  };
}
