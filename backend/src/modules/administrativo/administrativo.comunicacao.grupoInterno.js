// GRUPO INTERNO — camada do PAINEL ADMINISTRATIVO (requirePainelAdministrativo + MFA, ver administrativo.routes.js).
//   * listarGrupos      — SÓ LEITURA: os grupos da conta conectada (nome + JID), para o operador encontrar o JID real do grupo
//                         "Crescer Com Delivery - Central" e configurá-lo (WHATSAPP_GRUPO_INTERNO_JID no backend E no Gateway).
//   * preparoTesteGrupo — SÓ LEITURA: todos os gates do teste + a pré-visualização da mensagem.
//   * enviarTesteGrupo  — UMA mensagem de teste ao grupo, com confirmação explícita e `testeId` (duplo clique = mesmo teste = 1 envio).
//
// SEM exceção ao KILL SWITCH nem ao gate de conta confirmada (os mesmos do teste individual, administrativo.comunicacao.teste.js).
// FAIL-CLOSED: qualquer gate falhando ⇒ o provider NÃO é chamado.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { modoAtual } from "../comunicacao/comunicacao.config.js";
import { modoPermiteEnvioReal } from "../comunicacao/comunicacao.constants.js";
import { identidadeConfirmada as lerIdentidadeConfirmada } from "../comunicacao/comunicacao.identidade.js";
import { criarWhatsAppServiceDoAmbiente } from "../comunicacao/comunicacao.teste.js";
import {
  grupoInternoJidDoAmbiente, textoTesteGrupo, chaveTesteGrupo, enviarAoGrupoInterno, obterPorChave, listarUltimos, motivoDaFalha,
  TIPO_ENVIO_GRUPO, NOME_GRUPO_INTERNO, logGrupo, mascararJidGrupo,
} from "../comunicacao/comunicacao.grupoInterno.js";

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });

// Costuras de TESTE (produção nunca as passa).
const lerModo = (deps) => (typeof deps.lerModo === "function" ? deps.lerModo() : modoAtual(deps));
const lerGateway = (deps) => (deps.estadoGateway !== undefined ? deps.estadoGateway : repo.obterEstadoGateway(deps));
const servicoDoAmbiente = async (deps) => (deps.whatsAppService !== undefined ? deps.whatsAppService : criarWhatsAppServiceDoAmbiente(deps.env ?? process.env));

const MENSAGENS = Object.freeze({
  MODO_DISABLED: "Envio bloqueado: o módulo WhatsApp está em modo DISABLED.",
  GATEWAY_INDISPONIVEL: "O WhatsApp não está conectado no momento.",
  CONEXAO_NAO_CONFIRMADA: "A conta do WhatsApp conectada ainda não foi confirmada na aba Conexão.",
  WHATSAPP_NAO_CONFIGURADO: "A conexão do backend com o WhatsApp não está configurada.",
  GRUPO_NAO_CONFIGURADO: "O grupo interno não está configurado (WHATSAPP_GRUPO_INTERNO_JID).",
  GRUPO_NAO_AUTORIZADO_NO_GATEWAY: "O Gateway não reconhece este grupo como o grupo interno (WHATSAPP_GRUPO_INTERNO_JID do Gateway diferente ou ausente).",
  GRUPO_NAO_ENCONTRADO: "O grupo configurado não foi encontrado ou a conta conectada não participa dele.",
  GRUPO_SEM_PERMISSAO: "Só administradores podem enviar neste grupo e a conta conectada não é administradora.",
  CONSULTA_GRUPO_FALHOU: "Não foi possível consultar o grupo no WhatsApp agora.",
});

const MOTIVO_PARA_BLOQUEIO = Object.freeze({
  whatsapp_gateway_unavailable: "GATEWAY_INDISPONIVEL",
  grupo_nao_autorizado_no_gateway: "GRUPO_NAO_AUTORIZADO_NO_GATEWAY",
  grupo_nao_encontrado: "GRUPO_NAO_ENCONTRADO",
  grupo_sem_permissao_de_envio: "GRUPO_SEM_PERMISSAO",
});

function ator(autor) {
  return { atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null };
}

/** GET /administrativo/comunicacao/grupo-interno/grupos — SÓ LEITURA. */
export async function listarGrupos(deps = {}) {
  const env = deps.env ?? process.env;
  const servico = await servicoDoAmbiente(deps);
  if (!servico) throw conflito(MENSAGENS.WHATSAPP_NAO_CONFIGURADO, "WHATSAPP_NAO_CONFIGURADO");
  let r;
  try {
    r = await servico.listarGrupos();
  } catch (e) {
    const motivo = motivoDaFalha(e);
    logGrupo("warn", "listar_grupos_falhou", { motivo });
    throw conflito(motivo === "whatsapp_gateway_unavailable" ? MENSAGENS.GATEWAY_INDISPONIVEL : MENSAGENS.CONSULTA_GRUPO_FALHOU, motivo === "whatsapp_gateway_unavailable" ? "GATEWAY_INDISPONIVEL" : "CONSULTA_GRUPO_FALHOU");
  }
  const grupos = (Array.isArray(r?.grupos) ? r.grupos : []).map((g) => ({
    jid: String(g.jid ?? ""), nome: g.nome ?? null, participantes: g.participantes ?? null, somenteAdminsEnviam: g.somenteAdminsEnviam === true,
  }));
  const jidBackend = grupoInternoJidDoAmbiente(env);
  const jidGateway = typeof r?.grupoInternoJid === "string" ? r.grupoInternoJid : null;
  const candidatos = grupos.filter((g) => (g.nome ?? "").trim().toLowerCase() === NOME_GRUPO_INTERNO.toLowerCase());
  logGrupo("info", "grupos_listados", { total: grupos.length, candidatosPorNome: candidatos.length });
  return {
    nomeEsperado: NOME_GRUPO_INTERNO,
    grupos,
    // Conferência humana: o nome identifica, o JID é o que fica configurado. Mais de um grupo com o mesmo nome ⇒ o operador escolhe.
    candidatosPorNome: candidatos.map((g) => g.jid),
    configuracao: {
      backendJid: jidBackend, gatewayJid: jidGateway,
      concordam: !!jidBackend && jidBackend === jidGateway,
      encontradoNaConta: !!jidBackend && grupos.some((g) => g.jid === jidBackend),
    },
  };
}

/** Avalia TODOS os gates do teste do grupo. Somente leitura (consulta o grupo no WhatsApp, não envia). */
async function avaliarGates(deps = {}) {
  const env = deps.env ?? process.env;
  const grupoJid = grupoInternoJidDoAmbiente(env);
  const [modo, gateway, confirmada, servico] = await Promise.all([
    lerModo(deps), lerGateway(deps),
    deps.identidadeConfirmada !== undefined ? deps.identidadeConfirmada : lerIdentidadeConfirmada(deps),
    servicoDoAmbiente(deps),
  ]);
  const bloqueios = [];
  if (!modoPermiteEnvioReal(modo)) bloqueios.push("MODO_DISABLED");
  if (gateway?.estado !== "conectado") bloqueios.push("GATEWAY_INDISPONIVEL");
  if (confirmada !== true) bloqueios.push("CONEXAO_NAO_CONFIRMADA");
  if (!servico) bloqueios.push("WHATSAPP_NAO_CONFIGURADO");
  if (!grupoJid) bloqueios.push("GRUPO_NAO_CONFIGURADO");

  // Consulta o grupo no PRÓPRIO WhatsApp só quando há com quem/sobre o que perguntar.
  let grupo = null;
  if (servico && grupoJid && gateway?.estado === "conectado") {
    try {
      grupo = await servico.verificarGrupoInterno({ grupoJid });
      if (!grupo?.participa) bloqueios.push("GRUPO_NAO_ENCONTRADO");
      else if (!grupo?.podeEnviar) bloqueios.push("GRUPO_SEM_PERMISSAO");
    } catch (e) {
      const codigo = MOTIVO_PARA_BLOQUEIO[motivoDaFalha(e)] ?? "CONSULTA_GRUPO_FALHOU";
      if (!bloqueios.includes(codigo)) bloqueios.push(codigo);
    }
  }
  return { grupoJid, grupo, modo, gateway, servico, bloqueios: [...new Set(bloqueios)] };
}

/** GET /administrativo/comunicacao/grupo-interno/teste/preparo */
export async function preparoTesteGrupo(deps = {}) {
  const g = await avaliarGates(deps);
  return {
    grupo: {
      nomeEsperado: NOME_GRUPO_INTERNO,
      jid: g.grupoJid,
      nomeNoWhatsApp: g.grupo?.nome ?? null,
      participantes: g.grupo?.participantes ?? null,
      nomeConfere: g.grupo?.nome ? g.grupo.nome.trim().toLowerCase() === NOME_GRUPO_INTERNO.toLowerCase() : null,
    },
    whatsapp: g.gateway?.estado ?? "desconhecido",
    modo: g.modo,
    previewTexto: textoTesteGrupo(),
    podeEnviar: g.bloqueios.length === 0,
    bloqueios: g.bloqueios.map((codigo) => ({ codigo, mensagem: MENSAGENS[codigo] })),
    ultimosEnvios: await listarUltimos({ tipo: TIPO_ENVIO_GRUPO.TESTE, limite: 5 }, deps).catch(() => []),
  };
}

/**
 * POST /administrativo/comunicacao/grupo-interno/teste   { testeId, confirmacaoExplicita: true }
 * `testeId` (UUID) é gerado pela tela/operador: repetir o MESMO testeId nunca gera uma segunda mensagem.
 */
export async function enviarTesteGrupo({ testeId, confirmacaoExplicita } = {}, autor, deps = {}) {
  if (!autor?.contaId) throw ApiError.unauthorized("Operador não identificado.");
  const tid = v.uuid(testeId, "Teste");
  if (confirmacaoExplicita !== true) {
    throw ApiError.badRequest("Confirmação explícita obrigatória para enviar a mensagem de teste ao grupo.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  }
  const chave = chaveTesteGrupo(tid);
  const jaExiste = await obterPorChave(chave, deps);
  if (jaExiste) return respostaEnvio(jaExiste, "JA_EXISTIA");

  logGrupo("info", "teste_grupo_iniciando", { testeId: tid });
  const g = await avaliarGates(deps);
  if (g.bloqueios.length) {
    const codigo = g.bloqueios[0];
    logGrupo("warn", "teste_grupo_bloqueado", { testeId: tid, bloqueios: g.bloqueios });
    throw conflito(MENSAGENS[codigo], codigo);
  }

  const base = ator(autor);
  const detalhes = { teste_id: tid, grupo: mascararJidGrupo(g.grupoJid), grupo_nome: g.grupo?.nome ?? null, origem: "teste_grupo_painel" };
  await auditar({ ...base, acao: ACOES.COMUNICACAO_GRUPO_TESTE_INICIADO, entidade: "comunicacao_envios_grupo", entidadeId: null, organizacaoId: null, detalhes });
  const r = await enviarAoGrupoInterno({
    tipo: TIPO_ENVIO_GRUPO.TESTE, chave, grupoJid: g.grupoJid, conteudo: textoTesteGrupo(),
    resumo: { grupo_nome: g.grupo?.nome ?? null, teste_id: tid }, criadoPor: autor.perfilId ?? null, whatsAppService: g.servico,
  }, deps);
  if (r.resultado === "ENVIADO") {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_GRUPO_TESTE_ENVIADO, entidade: "comunicacao_envios_grupo", entidadeId: r.envio.id, organizacaoId: null, detalhes });
  } else if (r.resultado !== "JA_EXISTIA") {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_GRUPO_TESTE_FALHOU, entidade: "comunicacao_envios_grupo", entidadeId: r.envio?.id ?? null, organizacaoId: null, detalhes: { ...detalhes, resultado: r.resultado, motivo: r.motivo ?? null } });
  }
  return respostaEnvio(r.envio, r.resultado);
}

function respostaEnvio(envio, resultado) {
  return {
    envioId: envio?.id ?? null, resultado, status: envio?.status ?? null, motivo: envio?.motivo ?? null,
    messageId: envio?.provider_message_id ?? null, enviadoEm: envio?.enviado_em ?? null, jaExistia: resultado === "JA_EXISTIA",
  };
}
