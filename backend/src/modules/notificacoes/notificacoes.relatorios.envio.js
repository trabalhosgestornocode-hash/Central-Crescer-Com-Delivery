// Relatórios operacionais → ENVIO pelo gateway Baileys existente (whatsapp.service#enviarTexto: kill switch do modo global + conta confirmada).
// DESLIGADO por padrão (NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO=true liga). NÃO usa a fila nem as cotas do D-1: fila e cota próprias (migration 141).
//
// Para cada item da fila, nesta ordem (qualquer dúvida = não envia):
//   1. lista de números autorizados OBRIGATÓRIA por padrão (mesma regra do OTP) — fora da lista: o item aguarda (não é descartado);
//   2. autorização ATUAL relida (cadastro ativo, WhatsApp validado, escopo da unidade ativo, convite+OTP, consentimento vigente, sem opt-out):
//      revogada ⇒ BLOQUEADO (terminal);
//   3. integração iFood RELIDA: coletor momentaneamente parado ⇒ o item AGUARDA (o dia fechado já tem a própria prova de cobertura); não ativada /
//      autorização do iFood expirada ⇒ BLOQUEADO;
//   4. reserva atômica no banco (posse + cota diária por destinatário/categoria);
//   5. UMA chamada ao gateway; resultado: ENVIADO | pré-envio provado ⇒ RETRY (limitado) | permanente ⇒ FALHOU | dúvida ⇒ INCERTO e NUNCA reenvio;
//   6. auditoria de cada desfecho (sem telefone nem texto).
import { auditar, ACOES } from "../../shared/auditoria.js";
import { classificarErroEnvio, backoffRetrySegundos } from "../comunicacao/comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "../comunicacao/comunicacao.constants.js";
import { servicoDoAmbiente, listaAutorizada, exigeAllowlist } from "../comunicacao/comunicacao.relatorios.transporte.js";
import * as repoPadrao from "./notificacoes.relatorios.repository.js";
import { lerIntegracaoDaUnidade } from "./notificacoes.relatorios.integracao.js";
import { classificarIntegracao } from "./notificacoes.relatorios.js";

export const relatoriosEnvioHabilitado = (env = process.env) => String(env?.NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO ?? "").trim().toLowerCase() === "true";
const inteiro = (v, padrao, min, max) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isInteger(n) && n >= min && n <= max ? n : padrao; };
export const maxPorDestinatarioDia = (env = process.env) => inteiro(env?.NOTIFICACOES_RELATORIOS_MAX_DIA, 3, 1, 20);

/** Início do dia local do instante (para a cota diária). */
function inicioDoDia(agoraMs, fuso = "America/Sao_Paulo") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(agoraMs)).map((x) => [x.type, x.value]));
  return new Date(agoraMs - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000);
}

/**
 * @param {{agora?: () => Date, limite?: number, worker?: string, env?: object, deps?: {relatorios?: object, servico?: object, lerIntegracao?: Function, auditar?: Function}}} p
 * @returns {Promise<{desligado?: boolean, motivo?: string, resultados: Array<{id: string, resultado: string, motivo?: string}>}>}
 */
export async function processarFilaRelatorios({ agora = () => new Date(), limite = 10, worker = `rel-${process.pid}`, env = process.env, deps = {} } = {}) {
  if (!relatoriosEnvioHabilitado(env)) return { desligado: true, resultados: [] };
  const R = deps.relatorios ?? repoPadrao; const aud = deps.auditar ?? auditar;
  const servico = deps.servico ?? servicoDoAmbiente(env);
  if (!servico) return { desligado: true, motivo: "GATEWAY_NAO_CONFIGURADO", resultados: [] };
  const lista = listaAutorizada(env);
  if (exigeAllowlist(env) && (!lista || lista.size === 0)) return { desligado: true, motivo: "ALLOWLIST_OBRIGATORIA", resultados: [] };
  const lerIntegracao = deps.lerIntegracao ?? ((x) => lerIntegracaoDaUnidade({ ...x, agora, deps: deps.integracaoDeps ?? {} }));
  const resultados = [];
  const agoraMs = agora().getTime();
  const itens = await R.proximosPendentes({ limite, agoraIso: new Date(agoraMs).toISOString() }, deps.repoDeps ?? {});

  for (const it of itens) {
    const reg = (resultado, motivo) => resultados.push({ id: it.id, resultado, ...(motivo ? { motivo } : {}) });
    const auditarDesfecho = (resultado, motivo, extra = {}) => aud({ acao: ACOES.NOTIFICACAO_RELATORIO_ENVIO, atorTipo: "sistema", organizacaoId: it.organizacao_id, entidade: "operacional_relatorios_envios", entidadeId: it.id,
      detalhes: { resultado, motivo: motivo ?? null, tipo: it.tipo, categoria: it.categoria, referencia: it.referencia, proposito: it.proposito, destinatario: it.contato_empresa_id, unidade: it.unidade_id, ...extra } }).catch(() => {});
    try {
      const aut = await R.autorizacaoAtual({ organizacaoId: it.organizacao_id, unidadeId: it.unidade_id, contatoEmpresaId: it.contato_empresa_id, categoria: it.categoria }, deps.repoDeps ?? {});
      const reservarEBloquear = async (motivo) => {
        const r = await R.reservar({ id: it.id, worker, inicioDiaIso: inicioDoDia(agoraMs).toISOString(), maxPorDestinatarioDia: null }, deps.repoDeps ?? {});
        if (r?.resultado === "INICIADO") await R.finalizar({ id: it.id, worker, resultado: "BLOQUEADO", motivo }, deps.repoDeps ?? {});
        await auditarDesfecho("BLOQUEADO", motivo); reg("BLOQUEADO", motivo);
      };
      if (!aut.autorizado) { await reservarEBloquear(aut.motivo); continue; }
      if (lista && !lista.has(aut.telefoneE164)) { reg("AGUARDANDO", "FORA_DA_LISTA_AUTORIZADA"); continue; }
      const integracao = await lerIntegracao({ organizacaoId: it.organizacao_id, unidadeId: it.unidade_id });
      const ci = classificarIntegracao(integracao);
      if (ci.bloqueia) { await reservarEBloquear(ci.motivo); continue; }
      if (ci.adiavel) { reg("AGUARDANDO", ci.motivo); continue; }

      const res = await R.reservar({ id: it.id, worker, inicioDiaIso: inicioDoDia(agoraMs).toISOString(), maxPorDestinatarioDia: maxPorDestinatarioDia(env) }, deps.repoDeps ?? {});
      if (res?.resultado !== "INICIADO") { if (["EXPIRADO", "INCERTO", "FALHOU"].includes(res?.resultado)) await auditarDesfecho(res.resultado, "RESERVA"); reg(res?.resultado ?? "SEM_RESULTADO"); continue; }

      let envio = null; let falha = null;
      try { envio = await servico.enviarTexto({ telefoneE164: aut.telefoneE164, texto: it.mensagem, idempotencyKey: it.chave_idempotencia, contatoId: aut.contatoWhatsappId ?? null }); } catch (e) { falha = e; }
      if (!falha) {
        const fin = await R.finalizar({ id: it.id, worker, resultado: "ENVIADO", providerMessageId: envio?.providerMessageId ?? null }, deps.repoDeps ?? {}).catch(() => null);
        await auditarDesfecho("ENVIADO", null, { registrado: fin?.resultado === "GRAVADO" }); reg("ENVIADO");
        continue;
      }
      const cls = classificarErroEnvio(falha);
      const resultado = cls === CLASSIFICACAO_ERRO.PERMANENTE ? "FALHOU" : cls === CLASSIFICACAO_ERRO.RETRYAVEL ? "RETRY" : "INCERTO";
      await R.finalizar({ id: it.id, worker, resultado, motivo: cls, retryAposSegundos: resultado === "RETRY" ? backoffRetrySegundos(res.tentativa ?? 1) : null }, deps.repoDeps ?? {}).catch(() => null);
      await auditarDesfecho(resultado, cls); reg(resultado === "RETRY" ? "RETRY" : resultado, cls);
    } catch (e) { reg("ERRO_INTERNO", String(e?.message ?? e).slice(0, 120)); }   // um item com erro nunca derruba os outros nem reenvia às cegas
  }
  return { resultados };
}
