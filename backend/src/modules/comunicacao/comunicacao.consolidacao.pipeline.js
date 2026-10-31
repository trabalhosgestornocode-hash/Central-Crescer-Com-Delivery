// ADAPTADOR de produção da consolidação por telefone: liga as portas de `processarLoteConsolidado` às fases REAIS do pipeline do D-1
// (processarJobReivindicado → reservarEnvio → whatsAppService.enviarTexto → finalizarEnvio). Só é carregado (import dinâmico) por
// `processarProximoLote` quando COMUNICACAO_CONSOLIDACAO_POR_TELEFONE=true; com a flag desligada nada daqui executa.
//
//   avaliar      = processarJobReivindicado com `preparoDeEnvio`: roda TODOS os portões de hoje (TTL, alerta, política, janela, duplicidade,
//                  reforço/tardio) e PARA antes da reserva; terminal/adiado já foi gravado pelo próprio pipeline.
//   relerEstado  = a mesma avaliação, de novo, imediatamente antes de reservar (revogação/opt-out/pausa/categoria valem até o último instante).
//   reservar     = filaRepo.a MESMA reserva (closure do pipeline, com os MESMOS parâmetros) do envio individual + a chave da mensagem física: o banco (migration 140)
//                  conta as linhas da chave como UMA mensagem no teto do telefone/dia. Cooldown, taxa e limites por organização intactos.
//   enviar       = UMA chamada ao gateway por mensagem física (chave de idempotência `cons:<hash>`; bloco único mantém a chave original).
//   finalizar    = finalizarEnvio SENT por componente (mesmo provider id) ou resolverFalhaDeEnvio (a classificação de hoje: retry só se provado
//                  pré-envio; na dúvida DELIVERY_UNKNOWN e nunca reenvio).
import { supabase } from "../../config/supabase.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as filaRepo from "./comunicacao.fila.repo.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { processarJobReivindicado, resolverFalhaDeEnvio } from "./comunicacao.alertas.service.js";
import { processarLoteConsolidado, DESTINO } from "./comunicacao.consolidacao.integracao.js";
import { MOTIVO_DA_RESERVA } from "./comunicacao.adiamento.js";
import { RESULTADO_RESERVA, RESULTADO_FINAL_ENVIO, STATUS_MENSAGEM, CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";
import { classificarErroEnvio } from "./comunicacao.entrega.js";

const ESTADO_AUTORIZADO = Object.freeze({ registroAtivo: true, revogado: false, optOutContato: false, categoriaHabilitada: true, empresaHabilitada: true, empresaPausadaAte: null, escopoUnidades: null });
const ESTADO_BARRADO = Object.freeze({ registroAtivo: false });   // o pipeline já barrou/adiou/cancelou o job e auditou o motivo real
const MOTIVOS_QUE_VOLTAM_AO_INDIVIDUAL = new Set(["ITEM_INVALIDO", "BLOCO_MAIOR_QUE_O_LIMITE_DO_PROVEDOR"]);
const melhorEsforco = async (fn) => { try { await fn(); } catch { /* auxiliar: nunca decide o envio */ } };

/**
 * @param {{jobs: object[], opcoes: object, deps?: object, env?: object, maxCaracteres?: number}} p
 * @returns {Promise<{resultados: object[], individuais: object[]}>}  `individuais`: jobs que seguem o fluxo de hoje (sem par, ou fora do que a consolidação cobre)
 */
export async function processarLoteComConsolidacao({ jobs, opcoes, deps = {}, env = process.env, maxCaracteres }) {
  const db = deps.supabase ?? supabase;
  const { whatsAppService } = opcoes;
  // pontos de injeção (testes): por padrão, as peças reais do pipeline
  const impl = { processarJob: processarJobReivindicado, resolverFalha: resolverFalhaDeEnvio, finalizarEnvio: filaRepo.finalizarEnvio,
    registrarIni: tentativasRepo.registrarTentativaIniciada, registrarFin: tentativasRepo.registrarTentativaFinalizada, auditar, ...(deps.consolidacaoImpl ?? {}) };
  const preparos = new Map(); const pipeline = new Map(); const nomes = new Map(); const porId = new Map(jobs.map((j) => [j.id, j]));

  const nomeDe = async (tabela, id) => {
    const k = `${tabela}:${id}`;
    if (!nomes.has(k)) {
      const { data, error } = await db.from(tabela).select("id, nome").eq("id", id).maybeSingle();
      if (error) throw new Error(`nome de ${tabela} indisponível`);
      nomes.set(k, data?.nome ?? null);
    }
    return nomes.get(k);
  };
  const avaliarJob = async (job) => {
    let preparo = null;
    const r = await impl.processarJob(job, { ...opcoes, preparoDeEnvio: (p) => { preparo = p; return { id: job.id, resultado: "PRONTO_PARA_RESERVA" }; } }, deps);
    if (!preparo) { pipeline.set(job.id, r); return null; }
    preparos.set(job.id, preparo);
    return preparo;
  };

  const portas = {
    avaliar: async (job) => {
      const p = await avaliarJob(job);
      if (!p) return { pronto: false, resultado: pipeline.get(job.id)?.resultado ?? "TERMINAL" };
      const [empresa, unidade] = await Promise.all([nomeDe("organizacoes", job.organizacao_id), job.unidade_id ? nomeDe("unidades", job.unidade_id) : null]);
      return { pronto: true, item: { id: job.id, idempotencyKey: job.idempotency_key, contatoWhatsappId: job.contato_id, organizacaoId: job.organizacao_id, empresa, unidade, unidadeId: job.unidade_id ?? null, conteudo: job.conteudo } };
    },
    relerEstado: async (item) => ((await avaliarJob(porId.get(item.id))) ? ESTADO_AUTORIZADO : ESTADO_BARRADO),
    reservar: async (job, ctx) => {
      const p = preparos.get(job.id);
      const reserva = await p.reservar(ctx.chave ? { consolidacaoChave: ctx.chave } : {});
      if (reserva.resultado === RESULTADO_RESERVA.INICIADO) {
        const tentativa = reserva.mensagem.tentativas;
        await melhorEsforco(() => impl.registrarIni({ mensagemId: job.id, tentativaNumero: tentativa, workerId: job.claimed_by ?? "manual", iniciadoEm: new Date().toISOString() }, deps));
        await impl.auditar({ acao: ACOES.COMUNICACAO_ENVIO_PERMITIDO, atorTipo: "sistema", organizacaoId: job.organizacao_id, entidade: "comunicacao_mensagens", entidadeId: job.id, detalhes: { motivo: null, tipo: job.tipo, tentativa, consolidada: !!ctx.chave } });
        return { iniciado: true, tentativa };
      }
      let r;
      if (reserva.resultado === RESULTADO_RESERVA.POSSE_PERDIDA) r = p.posseSemEfeito;
      else if (reserva.resultado === RESULTADO_RESERVA.EXPIRADA) r = await p.cancelarPorExpiracao({ linhaJaCancelada: true });
      else r = await p.adiarOuBloquear(MOTIVO_DA_RESERVA[reserva.resultado], { ratePorDia: reserva.resultado === RESULTADO_RESERVA.RATE_LIMIT_DIA || reserva.resultado === RESULTADO_RESERVA.RATE_LIMIT_DIA_ORGANIZACAO });
      pipeline.set(job.id, r);
      return { iniciado: false, resultado: reserva.resultado };
    },
    enviar: async ({ ids, texto, idempotencyKey, contatoWhatsappId }) => {
      const telefones = new Set(ids.map((id) => preparos.get(id)?.contato?.telefone_e164));
      if (telefones.size !== 1 || ![...telefones][0]) throw Object.assign(new Error("telefone do grupo inconsistente"), { preEnvio: true });   // nada saiu
      return whatsAppService.enviarTexto({ telefoneE164: [...telefones][0], texto, idempotencyKey, contatoId: contatoWhatsappId });
    },
    classificarFalha: (e) => {
      const c = classificarErroEnvio(e);
      return c === CLASSIFICACAO_ERRO.RETRYAVEL ? "RETRY" : c === CLASSIFICACAO_ERRO.PERMANENTE ? "FAILED" : "DELIVERY_UNKNOWN";
    },
    finalizar: async (job, tentativa, r) => {
      const attempt = { id: job.id, worker: job.claimed_by, claimGeracao: job.claim_geracao, tentativa };
      if (r.resultado === "SENT") {
        let finalizada = null;
        try { finalizada = await impl.finalizarEnvio({ ...attempt, resultado: RESULTADO_FINAL_ENVIO.SENT, providerMessageId: r.providerMessageId ?? null }, deps); }
        catch (e) { console.error("[comunicacao] envio consolidado confirmado mas o registro SENT falhou (fica SENDING; a varredura o marca DELIVERY_UNKNOWN):", e?.message); }
        await melhorEsforco(() => impl.registrarFin({ mensagemId: job.id, tentativaNumero: tentativa, resultado: STATUS_MENSAGEM.SENT, providerMessageId: r.providerMessageId ?? null }, deps));
        pipeline.set(job.id, { id: job.id, resultado: "ENVIADO", registrado: !!finalizada, consolidada: !!r.consolidadaEm });
        return;
      }
      // reservou mas a mensagem não saiu (não coube / falha do gateway): a classificação de hoje decide (retry só se provado pré-envio)
      const erro = r.erro ?? Object.assign(new Error("CONSOLIDACAO_NAO_ENVIADA"), { preEnvio: true });
      pipeline.set(job.id, await impl.resolverFalha(job, attempt, erro, deps));
    },
  };

  const saida = await processarLoteConsolidado({ jobs, env, maxCaracteres, portas });
  if (!saida) return { resultados: [], individuais: jobs };                       // flag desligada: nada foi tocado

  const individuais = [...saida.individuais];
  const ja = new Set(individuais.map((j) => j.id));
  const resultados = [];
  for (const [id, d] of saida.destinos) {
    if (ja.has(id)) continue;
    // excluído por regra da consolidação (não por veto do pipeline): segue o fluxo individual de hoje, que reavalia tudo
    if (d.destino === DESTINO.EXCLUIDO_POR_AUTORIZACAO && !pipeline.has(id) && MOTIVOS_QUE_VOLTAM_AO_INDIVIDUAL.has(d.detalhe)) { individuais.push(porId.get(id)); continue; }
    resultados.push(pipeline.get(id) ?? { id, resultado: d.destino === DESTINO.ERRO_INTERNO ? "ERRO_INTERNO" : d.destino });
  }
  return { resultados, individuais };
}
