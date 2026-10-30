// Fluxo do TITULAR (sem conta na Crescer): convite → código (OTP) → consentimento; e a página de GESTÃO (ver e revogar).
//
// Posse (OTP) e consentimento são ATOS SEPARADOS: o código prova a posse do número; a tela seguinte mostra o termo
// versionado e as categorias, nenhuma pré-marcada. O código nunca é guardado (só HMAC), nunca é logado e nunca volta pela API.
// Anti-enumeração na gestão: a resposta e o tempo são os mesmos exista ou não o número. Rotas públicas com limite próprio.
// Este módulo e notificacoes.envio.js são os ÚNICOS que decifram o número (teste arquitetural).
import crypto from "node:crypto";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as repo from "./notificacoes.repository.js";
import { validarWhatsapp, gerarCodigoOtp, hashToken, tokenValido, codigoValido, SESSAO_GESTAO_MS, logNotificacoes } from "./notificacoes.basico.js";
import { segredosDisponiveis, cifrarTelefone, decifrarTelefone, hmacTelefone, hmacCodigo, hmacIp, compararSeguro, VERSAO_CHAVE_ATUAL } from "./notificacoes.segredos.js";
import { entregarCodigoOtp, capacidades } from "./notificacoes.envio.js";

const R = (deps) => deps?.repo ?? repo;
const RESPOSTA_GENERICA = "Se este número estiver cadastrado para receber avisos, enviamos um código de 6 dígitos para ele no WhatsApp.";
const indisponivel = () => new ApiError(503, "Verificação por WhatsApp indisponível no momento.", { codigo: "VERIFICACAO_INDISPONIVEL" });

function exigirAmbiente(deps) {
  const ok = deps?.segredosDisponiveis ? deps.segredosDisponiveis() : segredosDisponiveis();
  if (!ok) throw indisponivel();
}

async function conviteDoToken(token, deps) {
  if (!tokenValido(token)) throw ApiError.notFound("Convite inválido ou expirado.");
  const c = await R(deps).obterConvitePorToken(hashToken(token), deps);
  if (!c || Date.parse(c.expira_em) <= Date.now() || !["PENDENTE", "VERIFICADO"].includes(c.status)) throw ApiError.notFound("Convite inválido ou expirado.");
  return c;
}

/** O que o titular vê ao abrir o convite: empresa, unidades, categorias e o termo vigente — nenhum dado operacional. */
export async function abrirConvite({ token, deps = {} }) {
  exigirAmbiente(deps);
  const c = await conviteDoToken(token, deps);
  const r = R(deps);
  const [nomes, cats, termo] = await Promise.all([r.obterNomes({ organizacaoId: c.organizacao_id, unidadeIds: c.unidades_pretendidas }, deps), r.listarCategorias(deps), r.termoVigente(deps)]);
  const rot = new Map(cats.map((k) => [k.codigo, k]));
  return {
    empresa: nomes.empresa, nome: c.nome, etapa: c.status === "VERIFICADO" ? "consentimento" : "verificacao",
    unidades: nomes.unidades.map((u) => u.nome),
    categorias: c.categorias_pretendidas.map((k) => ({ codigo: k, rotulo: rot.get(k)?.rotulo ?? k, descricao: rot.get(k)?.descricao ?? null, simulacao: rot.get(k)?.estado === "SIMULACAO" })),
    termo: termo ? { versao: termo.versao, texto: termo.texto.replaceAll("{empresa}", nomes.empresa), rascunho: termo.rascunho } : null,
    verificacaoDisponivel: capacidades(deps.env).otp, simulacao: capacidades(deps.env).simulado, expiraEm: c.expira_em,
  };
}

/** O titular pede o código (o pedido parte do aparelho dele — o gestor nunca vê o código). */
export async function pedirCodigoConvite({ token, ip, deps = {} }) {
  exigirAmbiente(deps);
  const cap = capacidades(deps.env);
  if (!cap.otp) throw indisponivel();
  const c = await conviteDoToken(token, deps);
  if (c.status !== "PENDENTE") return { ok: true, etapa: "consentimento" };
  return emitirDesafio({ tipo: "verificacao", conviteId: c.id, telefoneCifrado: c.telefone_cifrado, telefoneHmac: c.telefone_hmac, ip, simulado: cap.simulado, deps });
}

async function emitirDesafio({ tipo, conviteId = null, telefoneCifrado, telefoneHmac, ip, simulado, id = null, provisorio = crypto.randomUUID(), deps }) {
  const r = R(deps);
  const codigo = gerarCodigoOtp();
  // o HMAC do código é ligado a um valor PROVISÓRIO que só o cliente conhece (o mesmo código em outro desafio não confere)
  const criado = await r.criarDesafio({ tipo, conviteId, telefoneCifrado, telefoneHmac, codigoHmac: hmacCodigo(provisorio, codigo),
    ipHmac: hmacIp(ip), simulado, chaveVersao: VERSAO_CHAVE_ATUAL, id }, deps);
  if (criado?.resultado === "AGUARDE") return { ok: false, motivo: "AGUARDE", segundos: criado.segundos };
  if (criado?.resultado === "LIMITE") return { ok: false, motivo: "LIMITE" };
  if (criado?.resultado !== "CRIADO") return { ok: false, motivo: "INDISPONIVEL" };
  const entrega = await (deps.entregarCodigoOtp ?? entregarCodigoOtp)({ desafioId: criado.desafio_id, telefoneCifrado, telefoneHmac, codigo, provisorio }, { env: deps.env });
  if (!entrega.entregue) return { ok: false, motivo: "INDISPONIVEL" };
  return { ok: true, desafio: criado.desafio_id, provisorio, expiraEmSegundos: 300, reenvioEmSegundos: 60 };
}

/** Confere o código. A comparação é feita no banco sobre HMACs (o código em claro nunca chega lá). */
export async function verificarCodigoConvite({ token, desafio, provisorio, codigo, deps = {} }) {
  exigirAmbiente(deps);
  if (!codigoValido(codigo)) throw ApiError.badRequest("Digite os 6 números do código.");
  const c = await conviteDoToken(token, deps);
  const r = await R(deps).verificarDesafio({ desafioId: desafio, codigoHmac: hmacCodigo(provisorio, codigo) }, deps);
  if (r?.resultado === "VERIFICADO") {
    await (deps.auditar ?? auditar)({ acao: ACOES.NOTIFICACAO_TITULAR_VERIFICOU, atorTipo: "sistema", organizacaoId: c.organizacao_id, entidade: "notificacoes", entidadeId: c.id,
      detalhes: { unidade_id: c.unidades_pretendidas?.[0] ?? null, simulado: r.simulado === true } });
  }
  return { resultado: r?.resultado ?? "INVALIDO", restantes: r?.restantes ?? null };
}

/** O titular escolhe as categorias e aceita o termo. Sem nenhuma marcada = recusa (registrada, nada é criado). */
export async function consentirConvite({ token, desafio, categorias, termoVersao, ip, userAgent, deps = {} }) {
  exigirAmbiente(deps);
  const c = await conviteDoToken(token, deps);
  const lista = Array.isArray(categorias) ? [...new Set(categorias.map(String))] : [];
  const r = await R(deps).consentir({ conviteId: c.id, desafioId: desafio, categorias: lista, termoVersao: Number(termoVersao),
    telefoneE164: decifrarTelefone(c.telefone_cifrado), ipHmac: hmacIp(ip), userAgent: resumirUa(userAgent) }, deps);
  if (r?.resultado === "CONSENTIDO" || r?.resultado === "RECUSADO_PELO_TITULAR") {
    await (deps.auditar ?? auditar)({ acao: ACOES.NOTIFICACAO_TITULAR_CONSENTIU, atorTipo: "sistema", organizacaoId: c.organizacao_id, entidade: "notificacoes",
      entidadeId: r.contato_empresa_id ?? c.id, detalhes: { unidade_id: c.unidades_pretendidas?.[0] ?? null, categorias: lista, termo_versao: Number(termoVersao), recusou: lista.length === 0, simulado: r.simulado === true } });
  }
  return { resultado: r?.resultado ?? "INDISPONIVEL" };
}

const resumirUa = (ua) => (typeof ua === "string" ? ua.replace(/[^\w ./;()-]/g, "").slice(0, 120) : null);

// ---------------------------------------------------------------------------------------------------------------------------
// Página de GESTÃO do titular (ver e revogar sem conta). Sessão curta (15 min) assinada, ligada ao desafio consumido.
// ---------------------------------------------------------------------------------------------------------------------------
const assinar = (desafioId, exp) => hmacCodigo(desafioId, `sessao-gestao:${exp}`);
function emitirSessao(desafioId) { const exp = Date.now() + SESSAO_GESTAO_MS; return `${desafioId}.${exp}.${assinar(desafioId, exp)}`; }
function lerSessao(sessao) {
  const [id, exp, sig] = String(sessao ?? "").split(".");
  if (!id || !exp || !sig || Number(exp) <= Date.now() || !compararSeguro(sig, assinar(id, Number(exp)))) throw ApiError.unauthorized("Sessão expirada. Peça um novo código.");
  return id;
}

/**
 * Pede código para gerenciar. Anti-enumeração por CONSTRUÇÃO: os identificadores são gerados aqui, a resposta sai na hora (sem
 * esperar o banco) e é idêntica exista ou não o número. A busca do número e a criação do desafio acontecem DEPOIS, em segundo plano
 * — o tempo de resposta não depende delas. Falhas do segundo plano não aparecem para quem pediu (log sem número).
 */
export async function pedirCodigoGestao({ telefone, ip, deps = {} }) {
  exigirAmbiente(deps);
  const cap = capacidades(deps.env);
  if (!cap.otp) throw indisponivel();
  const e164 = validarWhatsapp(telefone);
  const desafio = crypto.randomUUID();
  const provisorio = crypto.randomUUID();
  const processamento = (async () => {
    if (!e164) return;
    if (!((await R(deps).destinatariosDoNumero(e164, deps)).length > 0)) return;
    await emitirDesafio({ tipo: "gestao", telefoneCifrado: cifrarTelefone(e164), telefoneHmac: hmacTelefone(e164), ip, simulado: cap.simulado, id: desafio, provisorio, deps });
  })().catch((e) => logNotificacoes("warn", "gestao.codigo_falhou", { motivo: e?.message }));
  const resposta = { ok: true, mensagem: RESPOSTA_GENERICA, desafio, provisorio };
  Object.defineProperty(resposta, "_processamento", { value: processamento, enumerable: false });   // só testes aguardam; nunca vai no JSON
  return resposta;
}

export async function verificarCodigoGestao({ desafio, provisorio, codigo, deps = {} }) {
  exigirAmbiente(deps);
  if (!codigoValido(codigo)) throw ApiError.badRequest("Digite os 6 números do código.");
  const r = await R(deps).verificarDesafio({ desafioId: desafio, codigoHmac: hmacCodigo(provisorio, codigo) }, deps);
  // anti-enumeração: número inexistente (desafio fictício), código errado, expirado ou bloqueado dão a MESMA resposta
  if (r?.resultado !== "VERIFICADO") return { resultado: "NAO_CONFERE" };
  return { resultado: "VERIFICADO", sessao: emitirSessao(desafio) };
}

async function numeroDaSessao(sessao, deps) {
  const desafioId = lerSessao(sessao);
  const d = await R(deps).obterDesafio(desafioId, deps);
  if (!d || d.tipo !== "gestao" || !d.consumido_em) throw ApiError.unauthorized("Sessão inválida. Peça um novo código.");
  return d;
}

/** O que o titular recebe, por empresa (só nomes e categorias; nada operacional). */
export async function minhasInscricoes({ sessao, e164, deps = {} }) {
  exigirAmbiente(deps);
  const d = await numeroDaSessao(sessao, deps);
  const numero = validarWhatsapp(e164);
  if (!numero || !compararSeguro(hmacTelefone(numero), d.telefone_hmac)) throw ApiError.unauthorized("Sessão inválida para este número.");
  const r = R(deps);
  const lista = await r.destinatariosDoNumero(numero, deps);
  const cats = await r.listarCategorias(deps);
  const rot = new Map(cats.map((c) => [c.codigo, c.rotulo]));
  const porEmpresa = new Map();
  for (const ce of lista) {
    const dados = await r.listarDestinatarios({ organizacaoId: ce.organizacao_id }, deps);
    const nomes = await r.obterNomes({ organizacaoId: ce.organizacao_id, unidadeIds: [] }, deps);
    const ativas = new Set([
      ...dados.categoriasLegadas.filter((c) => c.contato_empresa_id === ce.id && c.habilitado).map((c) => c.categoria),
      ...dados.escopos.filter((e) => e.contato_empresa_id === ce.id && e.habilitado && !e.suspenso_em).map((e) => e.categoria),
    ]);
    const atual = porEmpresa.get(ce.organizacao_id) ?? { organizacaoId: ce.organizacao_id, empresa: nomes.empresa, categorias: new Set() };
    for (const k of ativas) atual.categorias.add(k);
    porEmpresa.set(ce.organizacao_id, atual);
  }
  return [...porEmpresa.values()].map((x) => ({ organizacaoId: x.organizacaoId, empresa: x.empresa, categorias: [...x.categorias].map((k) => ({ codigo: k, rotulo: rot.get(k) ?? k })) }));
}

/** O TITULAR revoga: categorias de uma empresa, uma empresa inteira, ou tudo (inclui o opt-out do número). Efeito imediato. */
export async function revogarComoTitular({ sessao, e164, organizacaoId = null, categorias = null, sairDeTudo = false, ip, deps = {} }) {
  exigirAmbiente(deps);
  const d = await numeroDaSessao(sessao, deps);
  const numero = validarWhatsapp(e164);
  if (!numero || !compararSeguro(hmacTelefone(numero), d.telefone_hmac)) throw ApiError.unauthorized("Sessão inválida para este número.");
  const lista = (await R(deps).destinatariosDoNumero(numero, deps)).filter((ce) => sairDeTudo || !organizacaoId || ce.organizacao_id === organizacaoId);
  if (!lista.length) return { resultado: "NADA_A_REVOGAR" };
  const r = await R(deps).revogar({ telefoneHmac: d.telefone_hmac, contatosEmpresa: lista.map((x) => x.id), categorias: sairDeTudo ? null : categorias,
    origem: "pagina_gestao_otp", evidenciaId: d.id, sairDeTudo, ipHmac: hmacIp(ip) }, deps);
  for (const org of new Set(lista.map((x) => x.organizacao_id))) {
    await (deps.auditar ?? auditar)({ acao: ACOES.NOTIFICACAO_TITULAR_REVOGOU, atorTipo: "sistema", organizacaoId: org, entidade: "notificacoes",
      detalhes: { categorias: sairDeTudo ? "todas" : (categorias ?? "todas"), sair_de_tudo: !!sairDeTudo } });
  }
  logNotificacoes("info", "titular.revogou", { empresas: new Set(lista.map((x) => x.organizacao_id)).size, sairDeTudo: !!sairDeTudo });
  return { resultado: "REVOGADO", mensagensCanceladas: r?.mensagens_canceladas ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Palavra-chave de saída no WhatsApp (SAIR/PARAR/STOP) — atrás de flag; usa o mesmo caminho de revogação
// ---------------------------------------------------------------------------------------------------------------------------
const PALAVRAS_SAIDA = new Set(["SAIR", "PARAR", "STOP", "CANCELAR", "DESCADASTRAR"]);
export function ehPalavraDeSaida(texto) {
  const t = String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase().replace(/[.!]+$/, "");
  return PALAVRAS_SAIDA.has(t);
}
export async function processarPalavraDeSaida({ telefoneE164, texto, env = process.env, deps = {} }) {
  if (env.NOTIFICACOES_PALAVRA_CHAVE_SAIR !== "true" || !ehPalavraDeSaida(texto)) return { aplicado: false };
  if (!(deps.segredosDisponiveis ? deps.segredosDisponiveis() : segredosDisponiveis())) return { aplicado: false, motivo: "SEM_SEGREDO" };
  const numero = validarWhatsapp(telefoneE164);
  if (!numero) return { aplicado: false };
  const lista = await R(deps).destinatariosDoNumero(numero, deps);
  if (!lista.length) return { aplicado: false };
  const r = await R(deps).revogar({ telefoneHmac: hmacTelefone(numero), contatosEmpresa: lista.map((x) => x.id), categorias: null, origem: "palavra_chave_inbound", sairDeTudo: true }, deps);
  return { aplicado: true, mensagensCanceladas: r?.mensagens_canceladas ?? 0 };
}
