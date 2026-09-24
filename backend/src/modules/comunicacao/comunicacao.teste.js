// TESTE CONTROLADO de comunicação (H.4-B.5) — valida a INFRAESTRUTURA do WhatsApp (Backend → HMAC → Gateway → onWhatsApp → sendMessage → receipts)
// SEM depender do scheduler, do worker, de alerta D-1, de reforço ou de aviso tardio.
//
// PRINCÍPIOS
//   * Fluxo INDEPENDENTE do worker: só roda com o modo global em DISABLED (o worker está pulando ciclos), então nenhum fluxo operacional coexiste.
//   * NUNCA cria/altera alerta. A mensagem tem identidade própria: tipo `teste_comunicacao`, metadados.proposito='teste', origem='teste_painel'.
//   * Usa o MESMO outbox e as MESMAS RPCs fenced (iniciar_envio / finalizar_envio) — SENT/DELIVERED/READ seguem o pipeline da 095.
//   * Só passa pelo provider via WhatsAppService (a invariante "Provider.send* só em whatsapp.service.js" continua valendo).
//   * 1 provider call no máximo por teste: idempotência por wa:teste:{testeId}:v1 (quem CRIA envia), sem retry, sem reenvio automático.
//   * LIMITE global de mensagens reais de teste (padrão 1), avaliado de forma atômica APÓS a criação: uma corrida entre 2 testeIds diferentes
//     mantém só a mais antiga e cancela a outra ANTES de qualquer envio.
//
// Este arquivo NÃO decide autorização de operador nem gates de piloto/consentimento — isso é do service administrativo (ator humano).

import * as filaRepo from "./comunicacao.fila.repo.js";
import * as tentativasRepo from "./comunicacao.tentativas.repo.js";
import { classificarErroEnvio } from "./comunicacao.entrega.js";
import { RESULTADO_FINAL_ENVIO, DESTINO_SEM_ENVIO, STATUS_MENSAGEM, CLASSIFICACAO_ERRO } from "./comunicacao.constants.js";

export { TIPO_MENSAGEM_TESTE, PROPOSITO_TESTE, ORIGEM_TESTE_PAINEL, chaveIdempotenciaTeste } from "./comunicacao.fila.repo.js";

/** Limite de mensagens reais de teste (todas, de todos os operadores). Padrão 1 — só o operador altera, via env do serviço. */
export function limiteTestesReais(env = process.env) {
  const n = Number(String(env.COMUNICACAO_TESTE_MAX ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

/** Texto EXATO do teste (nunca uma mensagem de pendência). */
export function textoDoTeste(unidadeNome) {
  const nome = String(unidadeNome ?? "").trim() || "Subway Saci — Matriz";
  return `Mensagem de teste — Crescer com Delivery.\n\nEste é um teste de comunicação da unidade ${nome}.\n\nNenhuma ação é necessária.\n\n— Crescer com Delivery`;
}

const sanitizarErro = (e) => String(e?.message ?? e).slice(0, 300);
const melhorEsforco = async (fn) => { try { return await fn(); } catch { return null; } };

/**
 * Serviço de WhatsApp do AMBIENTE (mesma config do worker: WHATSAPP_GATEWAY_URL + WHATSAPP_GATEWAY_SECRET). `null` se ausente — fail-closed.
 * @returns {Promise<ReturnType<import('./whatsapp.service.js').criarWhatsAppService>|null>}
 */
export async function criarWhatsAppServiceDoAmbiente(env = process.env) {
  const gatewayUrl = String(env.WHATSAPP_GATEWAY_URL ?? "").trim();
  const segredoHmac = String(env.WHATSAPP_GATEWAY_SECRET ?? "");
  if (!gatewayUrl || !segredoHmac.trim()) return null;
  const { criarWhatsAppService } = await import("./whatsapp.service.js");
  const { criarBaileysGatewayProvider } = await import("./providers/baileysGateway.provider.js");
  return criarWhatsAppService({ provider: criarBaileysGatewayProvider({ gatewayUrl, segredoHmac }) });
}

/**
 * Cria (idempotente) e, SÓ se este chamador é o criador, envia UMA mensagem de teste.
 * @param {{testeId: string, organizacaoId: string, unidadeId: string, contatoId: string, destinatarioPerfilId?: string|null,
 *   telefoneE164: string, texto: string, atorPerfilId?: string|null, limite?: number,
 *   whatsAppService: {enviarTexto: Function}, modoAtual: () => Promise<string>}} p
 * @returns {Promise<{resultado: 'JA_EXISTIA'|'ENVIADO'|'FALHOU'|'ENTREGA_INCERTA'|'LIMITE_ATINGIDO'|'MODO_NAO_PERMITIDO'|'POSSE_PERDIDA', mensagemId: string|null, status?: string, classificacao?: string, erro?: string|null}>}
 */
export async function enviarMensagemTeste({
  testeId, organizacaoId, unidadeId, contatoId, destinatarioPerfilId = null, telefoneE164, texto, atorPerfilId = null,
  limite = limiteTestesReais(), whatsAppService, modoAtual, aoIniciar = null,
}, deps = {}) {
  const { criada, mensagem, worker } = await filaRepo.criarMensagemTeste({ testeId, organizacaoId, unidadeId, contatoId, destinatarioPerfilId, conteudo: texto, atorPerfilId }, deps);
  // Quem NÃO criou nunca chama o provider (duplo clique, corrida, reenvio da tela): só devolve o que já existe.
  if (!criada) return { resultado: "JA_EXISTIA", mensagemId: mensagem.id, status: mensagem.status };

  const claim = { id: mensagem.id, worker, claimGeracao: mensagem.claim_geracao };
  const cancelar = async (destino, motivo) => melhorEsforco(() => filaRepo.encerrarProcessamento({ ...claim, destino, motivo }, deps));

  // LIMITE atômico: depois de criada, só as `limite` mais antigas contabilizadas podem enviar.
  const contabilizadas = await filaRepo.listarMensagensTesteContabilizadas(deps);
  const posicao = contabilizadas.findIndex((m) => m.id === mensagem.id);
  if (posicao === -1 || posicao >= limite) {
    await cancelar(DESTINO_SEM_ENVIO.CANCELLED, "LIMITE_DE_TESTES_ATINGIDO");
    return { resultado: "LIMITE_ATINGIDO", mensagemId: mensagem.id };
  }
  // Rechecagem do modo IMEDIATAMENTE antes da fronteira do envio (fail-closed: qualquer valor diferente de DISABLED cancela).
  if ((await modoAtual()) !== "DISABLED") {
    await cancelar(DESTINO_SEM_ENVIO.CANCELLED, "MODO_NAO_DISABLED");
    return { resultado: "MODO_NAO_PERMITIDO", mensagemId: mensagem.id };
  }

  // Passou em TODOS os gates: registra o INÍCIO (auditoria do operador) — melhor esforço, nunca impede nem duplica o envio.
  if (aoIniciar) await melhorEsforco(() => aoIniciar(mensagem.id));

  // PROCESSING -> SENDING: aqui nasce o attempt. null = perdeu a posse ⇒ NÃO chama o provider.
  const emEnvio = await filaRepo.iniciarEnvio(claim, deps);
  if (!emEnvio) return { resultado: "POSSE_PERDIDA", mensagemId: mensagem.id };
  const attempt = { ...claim, tentativa: emEnvio.tentativas };
  await melhorEsforco(() => tentativasRepo.registrarTentativaIniciada({ mensagemId: mensagem.id, tentativaNumero: emEnvio.tentativas, workerId: worker, iniciadoEm: new Date().toISOString() }, deps));

  let envio;
  try {
    envio = await whatsAppService.enviarTexto({ telefoneE164, texto, idempotencyKey: mensagem.idempotency_key });
  } catch (e) {
    // SEM retry: pré-envio comprovado e permanente viram FAILED; incerto vira DELIVERY_UNKNOWN. Nunca SCHEDULED/RETRY.
    const classificacao = classificarErroEnvio(e);
    const erroSanitizado = sanitizarErro(e);
    const resultado = classificacao === CLASSIFICACAO_ERRO.INCERTO ? RESULTADO_FINAL_ENVIO.DELIVERY_UNKNOWN : RESULTADO_FINAL_ENVIO.FAILED;
    let r = null;
    try { r = await filaRepo.finalizarEnvio({ ...attempt, resultado, erro: erroSanitizado }, deps); } catch { /* a varredura move SENDING expirado para DELIVERY_UNKNOWN */ }
    await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({
      mensagemId: mensagem.id, tentativaNumero: attempt.tentativa, erroClassificacao: classificacao, erroSanitizado,
      resultado: classificacao === CLASSIFICACAO_ERRO.INCERTO ? STATUS_MENSAGEM.DELIVERY_UNKNOWN : STATUS_MENSAGEM.FAILED,
    }, deps));
    return {
      resultado: classificacao === CLASSIFICACAO_ERRO.INCERTO ? "ENTREGA_INCERTA" : "FALHOU",
      mensagemId: mensagem.id, status: r?.status ?? null, classificacao, erro: erroSanitizado,
    };
  }

  // O provider confirmou (sendMessage resolveu). Falha de registro daqui em diante NUNCA reclassifica nem reenvia: a linha fica SENDING e a varredura
  // a marca DELIVERY_UNKNOWN.
  const providerMessageId = envio?.providerMessageId ?? null;
  let finalizada = null;
  try { finalizada = await filaRepo.finalizarEnvio({ ...attempt, resultado: RESULTADO_FINAL_ENVIO.SENT, providerMessageId }, deps); } catch { /* ver acima */ }
  await melhorEsforco(() => tentativasRepo.registrarTentativaFinalizada({ mensagemId: mensagem.id, tentativaNumero: attempt.tentativa, resultado: STATUS_MENSAGEM.SENT, providerMessageId }, deps));
  return { resultado: "ENVIADO", mensagemId: mensagem.id, status: finalizada?.status ?? STATUS_MENSAGEM.SENDING, registrado: !!finalizada };
}
