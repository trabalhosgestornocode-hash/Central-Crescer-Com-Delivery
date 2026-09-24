// ENVIO MANUAL da Central de Comunicação — um OPERADOR HUMANO escreve na conversa de um responsável autorizado.
//
// NÃO É UM SEGUNDO PIPELINE. É o mesmo caminho do teste controlado e do worker, só que disparado por uma pessoa:
//   Backend → (gates no service administrativo) → outbox (comunicacao_mensagens) → RPCs fenced iniciar/finalizar_envio → WhatsAppService → HMAC →
//   Gateway → onWhatsApp (JID canônico) → sendMessage → recibos (095: SENT → DELIVERED → READ).
// A verificação do destinatário (onWhatsApp), o JID canônico e o HMAC acontecem DENTRO do Gateway/provider — aqui não há atalho para eles.
//
// PRINCÍPIOS
//   * Idempotência por `wa:manual:{envioId}:v1` (UNIQUE do banco). Quem CRIA a linha é o único que chama o provider ⇒ duplo clique/reenvio = 1 envio.
//   * 1 provider call no máximo por envio, SEM retry e SEM reenvio automático: falha pré-envio comprovada = FAILED; incerta = DELIVERY_UNKNOWN.
//   * A linha nasce PROCESSING com `expira_em` <= fim do lease: o worker de automação nunca a reivindica (ver comunicacao.fila.repo.js).
//   * Só passa pelo provider via WhatsAppService (a invariante "Provider.send* só em whatsapp.service.js" continua valendo).
//   * Este arquivo NÃO decide autorização nem gates de consentimento/piloto — isso é do service administrativo (ator humano). FAIL-CLOSED lá.

import * as filaRepo from "./comunicacao.fila.repo.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { classificarErroEnvio } from "./comunicacao.entrega.js";
import { RESULTADO_FINAL_ENVIO, STATUS_MENSAGEM, CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";

export { TIPO_MENSAGEM_MANUAL, PROPOSITO_MANUAL, ORIGEM_MANUAL_PAINEL, chaveIdempotenciaManual } from "./comunicacao.fila.repo.js";

/** Tamanho máximo do texto de uma mensagem manual (o mesmo teto do inbound). */
export const TEXTO_MANUAL_MAX = 4096;

const sanitizarErro = (e) => String(e?.message ?? e).slice(0, 300);
const melhorEsforco = async (fn) => { try { return await fn(); } catch { return null; } };

/**
 * Texto de uma mensagem manual: aparado, sem NUL, 1..4096 caracteres. `null` = inválido (nunca lança, nunca corrige "no escuro").
 * @param {unknown} bruto
 */
export function normalizarTextoManual(bruto) {
  if (typeof bruto !== "string") return null;
  const limpo = bruto.replace(/\u0000/g, "").trim();
  if (limpo === "" || Array.from(limpo).length > TEXTO_MANUAL_MAX) return null;
  return limpo;
}

/**
 * Cria (idempotente) e, SÓ se este chamador é o criador, envia UMA mensagem manual.
 * @param {{envioId: string, organizacaoId: string, unidadeId?: string|null, contatoId: string, destinatarioPerfilId?: string|null,
 *   telefoneE164: string, texto: string, atorPerfilId?: string|null, atorNome?: string|null,
 *   whatsAppService: {enviarTexto: Function}, aoIniciar?: ((mensagemId: string) => Promise<void>)|null}} p
 * @returns {Promise<{resultado: 'JA_EXISTIA'|'ENVIADO'|'FALHOU'|'ENTREGA_INCERTA'|'POSSE_PERDIDA', mensagemId: string, status?: string|null, classificacao?: string, erro?: string|null}>}
 */
export async function enviarMensagemManual({
  envioId, organizacaoId, unidadeId = null, contatoId, destinatarioPerfilId = null, telefoneE164, texto, atorPerfilId = null, atorNome = null, whatsAppService, aoIniciar = null,
}, deps = {}) {
  const { criada, mensagem, worker } = await filaRepo.criarMensagemManual({ envioId, organizacaoId, unidadeId, contatoId, destinatarioPerfilId, conteudo: texto, atorPerfilId, atorNome }, deps);
  // Quem NÃO criou nunca chama o provider (duplo clique, corrida, reenvio da tela): só devolve o que já existe.
  if (!criada) return { resultado: "JA_EXISTIA", mensagemId: mensagem.id, status: mensagem.status };

  // Passou em TODOS os gates (feitos antes): registra o INÍCIO (auditoria do operador) — melhor esforço, nunca impede nem duplica o envio.
  if (aoIniciar) await melhorEsforco(() => aoIniciar(mensagem.id));

  const claim = { id: mensagem.id, worker, claimGeracao: mensagem.claim_geracao };
  // PROCESSING -> SENDING: aqui nasce o attempt. null = perdeu a posse ⇒ NÃO chama o provider.
  const emEnvio = await filaRepo.iniciarEnvio(claim, deps);
  if (!emEnvio) return { resultado: "POSSE_PERDIDA", mensagemId: mensagem.id };
  const attempt = { ...claim, tentativa: emEnvio.tentativas };
  await melhorEsforco(() => tentativasRepo.registrarTentativaIniciada({ mensagemId: mensagem.id, tentativaNumero: emEnvio.tentativas, workerId: worker, iniciadoEm: new Date().toISOString() }, deps));

  let envio;
  try {
    envio = await whatsAppService.enviarTexto({ telefoneE164, texto, idempotencyKey: mensagem.idempotency_key });
  } catch (e) {
    // SEM retry: pré-envio comprovado e permanente vira FAILED; incerto vira DELIVERY_UNKNOWN. Nunca SCHEDULED/RETRY.
    const classificacao = classificarErroEnvio(e);
    const erroSanitizado = sanitizarErro(e);
    const incerto = classificacao === CLASSIFICACAO_ERRO.INCERTO;
    let r = null;
    try {
      r = await filaRepo.finalizarEnvio({ ...attempt, resultado: incerto ? RESULTADO_FINAL_ENVIO.DELIVERY_UNKNOWN : RESULTADO_FINAL_ENVIO.FAILED, erro: erroSanitizado }, deps);
    } catch { /* a varredura move SENDING expirado para DELIVERY_UNKNOWN */ }
    await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({
      mensagemId: mensagem.id, tentativaNumero: attempt.tentativa, erroClassificacao: classificacao, erroSanitizado,
      resultado: incerto ? STATUS_MENSAGEM.DELIVERY_UNKNOWN : STATUS_MENSAGEM.FAILED,
    }, deps));
    return { resultado: incerto ? "ENTREGA_INCERTA" : "FALHOU", mensagemId: mensagem.id, status: r?.status ?? null, classificacao, erro: erroSanitizado };
  }

  // O provider confirmou (sendMessage resolveu). Falha de registro daqui em diante NUNCA reclassifica nem reenvia: a linha fica SENDING e a varredura a
  // marca DELIVERY_UNKNOWN.
  const providerMessageId = envio?.providerMessageId ?? null;
  let finalizada = null;
  try { finalizada = await filaRepo.finalizarEnvio({ ...attempt, resultado: RESULTADO_FINAL_ENVIO.SENT, providerMessageId }, deps); } catch { /* ver acima */ }
  await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({ mensagemId: mensagem.id, tentativaNumero: attempt.tentativa, resultado: STATUS_MENSAGEM.SENT, providerMessageId }, deps));
  return { resultado: "ENVIADO", mensagemId: mensagem.id, status: finalizada?.status ?? STATUS_MENSAGEM.SENDING, registrado: !!finalizada };
}
