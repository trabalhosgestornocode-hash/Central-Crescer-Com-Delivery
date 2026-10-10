// Vínculo MANUAL do merchant — unidades conectadas SÓ com o app Order (pedidos e eventos).
//
// O app distribuído de pedidos não tem o módulo Merchant, e o fluxo antigo valida a loja com o token
// Financial (ifoodMerchant.service.js). Aqui o gestor INFORMA o ID da loja (Portal do Parceiro) e o vínculo
// anda por estados explícitos — nunca vira definitivo só porque o ID foi digitado:
//
//   informarMerchant      -> `informado`             (não chama o iFood)
//   confirmarMerchant     -> `aguardando_validacao`  (conferência visual do responsável; não chama o iFood)
//   verificarAutorizacao  -> registra que o token Order cobre o merchant, ou `rejeitado`   [flag]
//   concluirValidacao     -> `validado` + merchant gravado em ifood_conexoes (conexão `ativa`) [flag]
//
// Enquanto não for `validado`, ifood_conexoes.merchant_id continua NULL e a conexão `pendente`: o poller de
// Events (que só lê conexões `ativa` com merchant) não enxerga a unidade. Este módulo NÃO altera o poller,
// o processamento de pedidos nem o fluxo Financial.
//
// As duas últimas etapas só existem com IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED=true (janela acompanhada):
//   * `verificarAutorizacao` faz UMA consulta de eventos restrita ao merchant informado, com o token Order
//     da PRÓPRIA conexão. 403 com o merchant em `unauthorizedMerchants` = rejeitado. Resposta positiva é
//     evidência NECESSÁRIA, nunca suficiente: não prova a identidade da loja (o mesmo dono pode ter várias).
//     Os eventos devolvidos são descartados — nada é gravado e NUNCA há ACK aqui. A consulta pode manter a
//     loja aberta por alguns minutos (heartbeat): por isso só em janela acompanhada, e com freio de tentativas
//     (consultar merchant não autorizado é infração no iFood).
//   * `concluirValidacao` exige, além disso, a declaração explícita de conferência no Portal do Parceiro e
//     de confirmação operacional.
//
// Tenant SEMPRE do contexto validado no servidor (req.tenant). O merchant só é aceito no formato do iFood,
// nunca é ecoado inteiro em log ou resposta, e é único entre conexões (validadas e em aberto).

import { IFOOD_APP_ORDER } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import * as repositorio from "./ifood.repository.js";
import * as vinculoRepositorio from "./ifoodMerchantVinculo.repository.js";
import * as tokenService from "./ifoodToken.service.js";
import * as eventsClient from "./ifoodEvents.client.js";
import * as httpClient from "./ifoodHttp.client.js";

export const VINCULO_MANUAL = Object.freeze({
  maxVerificacoes: 3,                       // consultas de autorização por vínculo
  intervaloVerificacaoMs: 10 * 60_000,      // espera mínima entre duas consultas do mesmo vínculo
  maxRejeicoesPorDia: 3,                    // rejeições por falta de autorização, por conexão, em 24 h
  validadeVerificacaoMs: 24 * 3_600_000,    // a checagem de autorização vale por 24 h para a validação final
});

export const MOTIVOS = Object.freeze({
  SEM_AUTORIZACAO: "SEM_AUTORIZACAO",
  MERCHANT_JA_VINCULADO: "MERCHANT_JA_VINCULADO",
  SUBSTITUIDO: "SUBSTITUIDO_PELO_GESTOR",
  CANCELADO: "CANCELADO_PELO_GESTOR",
  DESCONEXAO: "CONEXAO_DESFEITA",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ID de loja no formato do iFood (UUID), normalizado. Qualquer outra coisa é recusada antes de tudo. */
export function normalizarMerchantId(valor) {
  const s = typeof valor === "string" ? valor.trim().toLowerCase() : "";
  if (!UUID.test(s)) throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_ID_INVALIDO);
  return s;
}

function dependencias(deps = {}) {
  return {
    repo: deps.repo ?? repositorio,
    vinculos: deps.vinculos ?? vinculoRepositorio,
    token: deps.token ?? tokenService,
    client: deps.client ?? eventsClient,
    http: deps.http ?? httpClient,
    agora: deps.agora ?? (() => new Date()),
    log: deps.log ?? ifoodLog,
  };
}

/**
 * Pré-condições comuns a TODAS as etapas: unidade no piloto, conexão viva DA unidade e credencial Order
 * ativa DESSA conexão. Sem chamada ao iFood.
 */
async function exigirOrderDaUnidade({ organizacaoId, unidadeId, repo, token }) {
  if (!token.orderLiberadoParaUnidade(unidadeId)) throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_NAO_CONECTADO);
  // Defesa em profundidade: a conexão devolvida tem de ser do tenant pedido.
  if (conexao.organizacao_id !== organizacaoId || conexao.unidade_id !== unidadeId) throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_NAO_CONECTADO);
  const cred = await repo.obterCredencial({ conexaoId: conexao.id, appType: IFOOD_APP_ORDER });
  if (!cred || cred.status !== "ativa") throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_NAO_CONECTADO);
  return conexao;
}

/** O merchant já pertence a OUTRA conexão (validada ou em aberto)? Lança duplicidade. */
async function exigirMerchantLivre({ merchantId, conexaoId, repo, vinculos }) {
  const validada = await repo.conexaoVivaDoMerchant({ merchantId });
  if (validada && validada.id !== conexaoId) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
  const aberto = await vinculos.vinculoAbertoDoMerchant({ merchantId });
  if (aberto && aberto.conexao_id !== conexaoId) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
}

/** Forma pública do vínculo: sem o merchant inteiro, sem ids de usuário. */
export function resumirVinculo(v) {
  if (!v) return null;
  return {
    estado: v.estado,
    idMascarado: mascararId(v.merchant_id),
    informadoEm: v.informado_em ?? null,
    confirmadoEm: v.confirmado_em ?? null,
    autorizacaoVerificadaEm: v.autorizacao_verificada_em ?? null,
    validadoEm: v.validado_em ?? null,
    rejeitadoEm: v.rejeitado_em ?? null,
    motivo: v.encerrado_motivo ?? null,
  };
}

// =====================================================================
// 1. INFORMAR
// =====================================================================

/**
 * O gestor informa o ID da loja. Estado resultante: `informado`. Não chama o iFood.
 * Repetir com o MESMO ID é seguro (devolve o vínculo em aberto como está); com OUTRO ID, o anterior é
 * cancelado e nasce um novo `informado` (a conferência visual recomeça).
 */
export async function informarMerchant({ organizacaoId, unidadeId, merchantId, usuarioId, deps }) {
  const { repo, vinculos, token, agora, log } = dependencias(deps);
  const id = normalizarMerchantId(merchantId);
  const conexao = await exigirOrderDaUnidade({ organizacaoId, unidadeId, repo, token });

  if (conexao.merchant_id) {
    if (conexao.merchant_id === id) return { vinculo: null, jaVinculada: true };
    throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_JA_VINCULADO);
  }
  await exigirMerchantLivre({ merchantId: id, conexaoId: conexao.id, repo, vinculos });

  const aberto = await vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
  if (aberto?.merchant_id === id) return { vinculo: resumirVinculo(aberto), jaVinculada: false };

  const desdeIso = new Date(agora().getTime() - 24 * 3_600_000).toISOString();
  const rejeicoes = await vinculos.contarRejeicoesRecentes({ organizacaoId, unidadeId, conexaoId: conexao.id, desdeIso });
  if (rejeicoes >= VINCULO_MANUAL.maxRejeicoesPorDia) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_TENTATIVAS_ESGOTADAS);

  if (aberto) {
    await vinculos.cancelarVinculosAbertos({ organizacaoId, unidadeId, conexaoId: conexao.id, motivo: MOTIVOS.SUBSTITUIDO });
    log("info", "merchant_manual.substituido", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(aberto.merchant_id), por: usuarioId });
  }
  const criado = await vinculos.criarVinculo({ organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: id, usuarioId });
  log("info", "merchant_manual.informado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(id), por: usuarioId });
  return { vinculo: resumirVinculo(criado), jaVinculada: false };
}

// =====================================================================
// 2. CONFIRMAR (conferência visual do responsável)
// =====================================================================

/**
 * O responsável confere o ID e o reenvia. Só passa se for IDÊNTICO ao informado.
 * `informado` -> `aguardando_validacao`. Não chama o iFood. Repetir é seguro.
 */
export async function confirmarMerchant({ organizacaoId, unidadeId, merchantId, usuarioId, deps }) {
  const { repo, vinculos, token, agora, log } = dependencias(deps);
  const id = normalizarMerchantId(merchantId);
  const conexao = await exigirOrderDaUnidade({ organizacaoId, unidadeId, repo, token });

  const aberto = await vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
  if (!aberto) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_NAO_ENCONTRADO);
  if (aberto.merchant_id !== id) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_CONFIRMACAO_DIVERGENTE);
  if (aberto.estado === "aguardando_validacao") return { vinculo: resumirVinculo(aberto) };

  await exigirMerchantLivre({ merchantId: id, conexaoId: conexao.id, repo, vinculos });
  const gravado = await vinculos.atualizarVinculo({
    organizacaoId, unidadeId, id: aberto.id, seEstado: "informado",
    campos: { estado: "aguardando_validacao", confirmado_por: usuarioId ?? null, confirmado_em: agora().toISOString() },
  });
  if (!gravado) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO);
  log("info", "merchant_manual.confirmado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(id), por: usuarioId });
  return { vinculo: resumirVinculo(gravado) };
}

// =====================================================================
// CANCELAR (desistência / corrigir o ID)
// =====================================================================

/** Encerra o vínculo em aberto da unidade. Idempotente. Não exige piloto nem credencial (é só limpeza). */
export async function cancelarMerchantInformado({ organizacaoId, unidadeId, usuarioId, deps }) {
  const { repo, vinculos, log } = dependencias(deps);
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  if (!conexao) return { cancelados: 0 };
  const cancelados = await vinculos.cancelarVinculosAbertos({ organizacaoId, unidadeId, conexaoId: conexao.id, motivo: MOTIVOS.CANCELADO });
  if (cancelados) log("info", "merchant_manual.cancelado", { organizacaoId, unidadeId, conexaoId: conexao.id, por: usuarioId });
  return { cancelados };
}

// =====================================================================
// 3. VERIFICAR AUTORIZAÇÃO NO IFOOD   [só com a flag de validação]
// =====================================================================

/**
 * UMA consulta de eventos restrita ao merchant informado, com o token Order da própria conexão.
 *   * 403 com o merchant em `unauthorizedMerchants` -> `rejeitado` (SEM_AUTORIZACAO).
 *   * resposta positiva -> registra `autorizacao_verificada_em`. O estado CONTINUA `aguardando_validacao`.
 *   * qualquer outra falha -> nada muda no estado (a tentativa conta); o erro sobe.
 * Nunca grava evento, nunca reconhece (ACK), nunca promove a conexão.
 */
export async function verificarAutorizacao({ organizacaoId, unidadeId, usuarioId, deps }) {
  const { repo, vinculos, token, client, http, agora, log } = dependencias(deps);
  if (!token.validacaoMerchantManualHabilitada()) throw ifoodErro(IFOOD_ERROS.IFOOD_VALIDACAO_NAO_HABILITADA);
  const conexao = await exigirOrderDaUnidade({ organizacaoId, unidadeId, repo, token });

  const aberto = await vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
  if (!aberto) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_NAO_ENCONTRADO);
  if (aberto.estado !== "aguardando_validacao") throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO);

  const agoraMs = agora().getTime();
  const tentativas = Number(aberto.autorizacao_tentativas ?? 0);
  const ultima = aberto.autorizacao_ultima_tentativa_em ? Date.parse(aberto.autorizacao_ultima_tentativa_em) : null;
  if (tentativas >= VINCULO_MANUAL.maxVerificacoes) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_TENTATIVAS_ESGOTADAS);
  if (ultima != null && agoraMs - ultima < VINCULO_MANUAL.intervaloVerificacaoMs) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_TENTATIVAS_ESGOTADAS);

  // A tentativa é contada ANTES da chamada (compare-and-set): duas requisições simultâneas não geram duas consultas.
  const reservado = await vinculos.atualizarVinculo({
    organizacaoId, unidadeId, id: aberto.id, seEstado: "aguardando_validacao", seTentativas: tentativas,
    campos: { autorizacao_tentativas: tentativas + 1, autorizacao_ultima_tentativa_em: new Date(agoraMs).toISOString() },
  });
  if (!reservado) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO);

  const merchantId = aberto.merchant_id;
  try {
    // Os eventos devolvidos são DESCARTADOS de propósito: nada é gravado e nada é reconhecido aqui.
    await token.comAccessTokenValido({
      conexaoId: conexao.id, appType: IFOOD_APP_ORDER, deps: { http },
      fn: (accessToken) => client.buscarEventos({ accessToken, merchantIds: [merchantId], http }),
    });
  } catch (e) {
    const recusados = e?.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO ? e.details?.unauthorizedMerchants : null;
    if (Array.isArray(recusados) && recusados.map((m) => String(m).toLowerCase()).includes(merchantId)) {
      const rejeitado = await vinculos.atualizarVinculo({
        organizacaoId, unidadeId, id: aberto.id, seEstado: "aguardando_validacao",
        campos: { estado: "rejeitado", rejeitado_em: agora().toISOString(), encerrado_motivo: MOTIVOS.SEM_AUTORIZACAO },
      });
      log("warn", "merchant_manual.rejeitado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(merchantId), motivo: MOTIVOS.SEM_AUTORIZACAO, por: usuarioId });
      return { vinculo: resumirVinculo(rejeitado ?? { ...aberto, estado: "rejeitado", encerrado_motivo: MOTIVOS.SEM_AUTORIZACAO }), autorizacaoVerificada: false };
    }
    log("warn", "merchant_manual.verificacao_falhou", { organizacaoId, unidadeId, conexaoId: conexao.id, codigo: e?.codigo ?? "ERRO_INTERNO" });
    throw e;
  }

  const verificado = await vinculos.atualizarVinculo({
    organizacaoId, unidadeId, id: aberto.id, seEstado: "aguardando_validacao",
    campos: { autorizacao_verificada_em: agora().toISOString() },
  });
  if (!verificado) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO);
  log("info", "merchant_manual.autorizacao_verificada", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(merchantId), por: usuarioId });
  return { vinculo: resumirVinculo(verificado), autorizacaoVerificada: true };
}

// =====================================================================
// 4. VALIDAÇÃO FINAL   [só com a flag de validação]
// =====================================================================

/**
 * Promove o vínculo: grava o merchant na conexão (que passa a `ativa`) e marca `validado`. Exige TUDO:
 * estado `aguardando_validacao`, autorização verificada (e recente), o ID reenviado idêntico, e as duas
 * declarações explícitas (conferência no Portal do Parceiro + confirmação operacional).
 * Não chama o iFood.
 */
export async function concluirValidacao({
  organizacaoId, unidadeId, merchantId, evidenciaPortalParceiro, confirmacaoOperacional, usuarioId, deps,
}) {
  const { repo, vinculos, token, agora, log } = dependencias(deps);
  if (!token.validacaoMerchantManualHabilitada()) throw ifoodErro(IFOOD_ERROS.IFOOD_VALIDACAO_NAO_HABILITADA);
  const id = normalizarMerchantId(merchantId);
  if (evidenciaPortalParceiro !== true || confirmacaoOperacional !== true) throw ifoodErro(IFOOD_ERROS.IFOOD_VALIDACAO_SEM_EVIDENCIA);
  const conexao = await exigirOrderDaUnidade({ organizacaoId, unidadeId, repo, token });

  const aberto = await vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
  if (!aberto) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_NAO_ENCONTRADO);
  if (aberto.merchant_id !== id) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_CONFIRMACAO_DIVERGENTE);
  if (aberto.estado !== "aguardando_validacao" || !aberto.confirmado_em) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO);
  const verificadaMs = aberto.autorizacao_verificada_em ? Date.parse(aberto.autorizacao_verificada_em) : null;
  if (verificadaMs == null || agora().getTime() - verificadaMs > VINCULO_MANUAL.validadeVerificacaoMs) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO, { mensagem: "A autorização da loja no iFood precisa ser verificada antes da validação final." });
  }
  if (conexao.merchant_id && conexao.merchant_id !== id) throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_JA_VINCULADO);

  const rejeitarDuplicado = async () => {
    await vinculos.atualizarVinculo({
      organizacaoId, unidadeId, id: aberto.id, seEstado: "aguardando_validacao",
      campos: { estado: "rejeitado", rejeitado_em: agora().toISOString(), encerrado_motivo: MOTIVOS.MERCHANT_JA_VINCULADO },
    });
    log("warn", "merchant_manual.rejeitado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(id), motivo: MOTIVOS.MERCHANT_JA_VINCULADO, por: usuarioId });
  };

  const dono = await repo.conexaoVivaDoMerchant({ merchantId: id });
  if (dono && dono.id !== conexao.id) { await rejeitarDuplicado(); throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO); }

  try {
    // Mesma gravação do fluxo antigo (conexão `ativa`). Nome/razão social ficam vazios: não há Merchant API.
    await repo.definirMerchantDaConexao({ organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: id, nome: null, razaoSocial: null });
  } catch (e) {
    if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO) await rejeitarDuplicado();   // corrida: o índice único barrou
    throw e;
  }
  const quando = agora().toISOString();
  const validado = await vinculos.atualizarVinculo({
    organizacaoId, unidadeId, id: aberto.id, seEstado: "aguardando_validacao",
    campos: { estado: "validado", validado_por: usuarioId ?? null, validado_em: quando },
  });
  log("info", "merchant_manual.validado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(id), por: usuarioId });
  return { vinculo: resumirVinculo(validado ?? { ...aberto, estado: "validado", validado_em: quando }) };
}
