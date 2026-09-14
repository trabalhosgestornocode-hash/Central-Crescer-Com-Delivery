// Sessão do frontend: quem sou eu, e em qual empresa estou.
//
// O Context Token é opaco para o frontend — ele não abre, não lê e não monta o
// token. Guarda o que o servidor devolveu e reenvia. O company_id, portanto,
// nunca é uma escolha do cliente: é consequência de uma seleção que o servidor
// validou e assinou.
//
// Armazenamento: sessionStorage, não localStorage. O contexto vale para a aba —
// fechar a aba encerra o contexto, e duas abas podem, no futuro, estar em
// unidades diferentes sem se atropelar.

import { API_BASE } from "./config.js";
import { state } from "./state.js";
import { getSupabase, tokenAtual } from "./supabaseClient.js";
import { geracaoContexto, contextoMudou, invalidarGeracaoDeContexto } from "./contextoEscopo.js";

const CHAVE_TOKEN = "cd.contextToken";

/** @typedef {import('./state.js').Sessao} Sessao */

// ---------------------------------------------------------------------------
// Token de contexto
// ---------------------------------------------------------------------------

export function contextTokenAtual() {
  return sessionStorage.getItem(CHAVE_TOKEN);
}

function guardarContextToken(token) {
  if (token) sessionStorage.setItem(CHAVE_TOKEN, token);
  else sessionStorage.removeItem(CHAVE_TOKEN);
}

export function limparContexto() {
  invalidarGeracaoDeContexto(); // respostas em voo do contexto que acabou não valem mais
  guardarContextToken(null);
  state.sessao.empresa = null;
  state.sessao.unidade = null;
  state.sessao.papel = null;
  state.sessao.papelRotulo = null;
  state.sessao.permissoes = [];
  state.sessao.modulos = [];
  state.sessao.impersonando = false;
  state.sessao.unidadesDaEmpresa = [];
  state.sessao.perfil = null; // Fase I — a PESSOA do contexto (a CONTA fica em state.sessao.usuario)
  // Fase F — a prova de PIN nunca sobrevive à queda do contexto.
  state.sessao.profileSelectionToken = null;
}

// ---------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------

async function cabecalhos(extra = {}) {
  const token = await tokenAtual();
  const ctx = contextTokenAtual();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ctx ? { "x-context-token": ctx } : {}),
  };
}

/**
 * Chamada à API com tratamento dos dois modos de falha que importam aqui:
 *   401 -> a identidade caiu: precisa fazer login de novo.
 *   409 -> a identidade está boa, o CONTEXTO caiu: basta escolher a unidade.
 * Tratar os dois como 401 expulsaria o usuário do sistema a cada contexto
 * expirado, que é o erro mais comum e o menos grave.
 */
async function chamar(url, opcoes = {}) {
  // Geração do contexto no momento do ENVIO — ver o comentário longo em
  // api.js#tratar: um 409 de uma requisição do contexto ANTERIOR, chegando
  // depois de o usuário já ter entrado em outra unidade, não pode apagar o
  // token da unidade nova nem mandá-lo de volta para a tela de seleção.
  const g = geracaoContexto();
  const r = await fetch(API_BASE + url, {
    ...opcoes,
    headers: await cabecalhos(opcoes.headers ?? {}),
  });

  if (r.status === 401) {
    const c = await r.json().catch(() => ({}));
    if ((c?.codigo || c?.details?.codigo) === "MFA_REQUERIDA") {
      // A sessão é válida — falta o 2º fator. NÃO expulsa para o login.
      document.dispatchEvent(new CustomEvent("app:mfa-requerida", { detail: c.error }));
      const e = new Error(c.error || "Verificação em duas etapas necessária.");
      e.codigo = "MFA_REQUERIDA"; e.status = 401;
      throw e;
    }
    document.dispatchEvent(new CustomEvent("app:sessao-expirada"));
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  const corpo = await r.json().catch(() => ({}));
  if (r.status === 409 && corpo?.details?.contexto === "invalido") {
    if (!contextoMudou(g)) {
      limparContexto();
      document.dispatchEvent(new CustomEvent("app:contexto-invalido", { detail: corpo.error }));
    }
    throw new Error(corpo.error || "Contexto encerrado.");
  }
  if (!r.ok) {
    const erro = new Error(corpo.error || `${r.status} ${r.statusText}`);
    erro.status = r.status;
    erro.codigo = corpo.codigo || corpo.details?.codigo || null; // Fase F/H — ex.: CONFIGURACAO_PIN_INCOMPLETA
    erro.details = corpo.details ?? null;
    throw erro;
  }
  return corpo;
}

const get = (url) => chamar(url);
const post = (url, body) => chamar(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
});

// ---------------------------------------------------------------------------
// Login e identidade
// ---------------------------------------------------------------------------

function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "E-mail ainda não confirmado.";
  if (m.includes("rate limit")) return "Muitas tentativas. Aguarde um instante.";
  return msg || "Falha no login.";
}

/**
 * Login: e-mail e senha, nada mais. A empresa NÃO é escolhida aqui — é o
 * requisito central do fluxo novo. O que vem depois do login é a lista de
 * acessos, e a decisão de para onde ir.
 * @param {string} email
 * @param {string} senha
 */
export async function login(email, senha) {
  if (!email?.trim() || !senha?.trim()) throw new Error("Preencha e-mail e senha.");
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) throw new Error(traduzErro(error.message));
  limparContexto();               // login novo nunca herda contexto antigo
  await carregarIdentidade();
  return data;
}

/** Carrega /me para state.sessao.usuario. */
export async function carregarIdentidade() {
  const { data } = await get("/api/v1/me");
  state.sessao.usuario = data;
  return data;
}

/** True quando a conta ainda usa a senha provisória definida por um admin. */
export function precisaDefinirSenha() {
  return state.sessao.usuario?.senhaProvisoria === true;
}

/**
 * Define a nova senha do primeiro acesso e recarrega a identidade (a flag
 * `senhaProvisoria` volta como false). Depois disso o fluxo normal segue.
 * @param {string} senha
 */
export async function definirNovaSenha(senha) {
  if (!senha || senha.length < 8) throw new Error("A senha deve ter ao menos 8 caracteres.");
  await post("/api/v1/sessao/senha", { senha });
  await carregarIdentidade();
}

/** Restaura a sessão persistida do Supabase (com refresh do token). */
export async function restaurarSessao() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  if (!data?.session?.user) return false;
  await carregarIdentidade();
  return true;
}

export async function logout() {
  // Avisa quem precisa desligar por causa do logout (hoje: o RealtimeManager
  // — ver realtime/realtimeManager.js) ANTES de qualquer coisa: nenhum outro
  // módulo aqui precisa conhecer Realtime, só reagir ao mesmo padrão de
  // evento DOM já usado por app:sessao-expirada/app:contexto-invalido.
  document.dispatchEvent(new CustomEvent("app:logout"));
  // Revoga o contexto no servidor ANTES de derrubar o login: depois do signOut
  // não haveria mais Access Token para autenticar a chamada, e a sessão de
  // contexto ficaria viva até expirar.
  try { await post("/api/v1/sessao/encerrar"); } catch { /* sessão já pode ter caído */ }
  limparContexto();
  try {
    const sb = await getSupabase();
    // `scope: "local"` — encerra SÓ a credencial DESTE dispositivo. O default
    // do supabase-js é `"global"`, que revoga os refresh tokens da conta em
    // TODOS os dispositivos — inaceitável para a conta compartilhada
    // multi-perfil: Fulana 1 clicando "Sair" derrubaria a Fulana 2 no outro
    // computador (ver docs/multi-perfil-fase-a1-revisao.md §1). "Sair de todos
    // os dispositivos" é uma ação SEPARADA (não implementada nesta fase).
    await sb.auth.signOut({ scope: "local" });
  } catch { /* ignora */ }
  state.sessao.usuario = null;
  state.sessao.perfil = null;
  state.sessao.perfisDisponiveis = [];
  state.sessao.profileSelectionToken = null;
}

// ---------------------------------------------------------------------------
// Perfil operacional (Fase F) — a PESSOA, entre a CONTA e o CONTEXTO
// ---------------------------------------------------------------------------

/** Perfis operacionais ATIVOS da conta autenticada (nunca o hash do PIN). */
export async function carregarPerfis() {
  const { data } = await get("/api/v1/sessao/perfis");
  state.sessao.perfisDisponiveis = Array.isArray(data) ? data : [];
  return state.sessao.perfisDisponiveis;
}

/**
 * Valida (ou dispensa) o PIN de um perfil e guarda a PROVA (Profile Selection
 * Token) em memória para `selecionarContexto` usar. `pin` só transita aqui —
 * nunca é gravado em lugar nenhum. A resposta pode pedir `precisaPin`.
 * @param {{ perfilId: string, pin?: string }} p
 */
export async function selecionarPerfil({ perfilId, pin }) {
  const { data } = await post("/api/v1/sessao/selecionar-perfil", { perfilId, ...(pin ? { pin } : {}) });
  if (data.profileSelectionToken) {
    state.sessao.profileSelectionToken = data.profileSelectionToken; // memória, nunca localStorage
    state.sessao.perfil = data.perfil ?? null;
  }
  return data; // { perfil, precisaPin, profileSelectionToken?, proximoPasso }
}

/** Descarta a prova de PIN e o perfil pendente (voltar / trocar de perfil). */
export function limparPerfilPendente() {
  state.sessao.profileSelectionToken = null;
  state.sessao.perfil = null;
}

// ---------------------------------------------------------------------------
// Contexto de empresa
// ---------------------------------------------------------------------------

/**
 * Empresas/unidades que o usuário pode acessar. Com `perfilId` (Fase F) só os
 * acessos DAQUELE perfil; sem ele, o caminho legado (acessos da conta).
 * @param {string|null} [perfilId]
 */
export async function listarAcessos(perfilId = null) {
  const rota = perfilId ? `/api/v1/sessao/acessos?perfilId=${encodeURIComponent(perfilId)}` : "/api/v1/sessao/acessos";
  const { data } = await get(rota);
  state.sessao.acessos = data.opcoes ?? [];
  state.sessao.superadmin = !!data.superadmin;
  // "Pode entrar no ambiente Painel Administrativo?" — vem PRONTO do backend
  // (associação explícita OU SuperAdmin por bypass). Nunca é fonte de
  // autorização: só decide se o botão de entrada aparece; o backend revalida
  // em /administrativo/ping ao abrir.
  state.sessao.painelAdministrativo = !!data.painelAdministrativo;
  return data;
}

/**
 * Seleciona a empresa/unidade e recebe o Context Token.
 * @param {{organizacaoId: string, unidadeId?: string|null, troca?: boolean}} escolha
 */
export async function selecionarContexto({ organizacaoId, unidadeId = null, troca = false }) {
  // Fase F/H — para conta multi-perfil o backend EXIGE a prova de PIN. Conta de
  // 1 perfil resolve o perfil sozinho e ignora o campo.
  const prova = state.sessao.profileSelectionToken || undefined;
  const { data } = await post("/api/v1/sessao/selecionar", {
    organizacaoId, unidadeId, troca,
    ...(prova ? { profileSelectionToken: prova } : {}),
  });
  aplicarContexto(data);
  // A prova é de uso único — consumida na criação do Context Token.
  state.sessao.profileSelectionToken = null;
  return data;
}

/** Grava no estado o contexto recebido do servidor (seleção ou impersonação). */
export function aplicarContexto(data) {
  // A identidade do contexto muda AQUI — a geração tem que subir junto, antes
  // que mostrarApp() monte a tela nova (ver contextoEscopo.js).
  invalidarGeracaoDeContexto();
  guardarContextToken(data.contextToken);
  state.sessao.empresa = data.empresa;
  state.sessao.unidade = data.unidade;
  state.sessao.papel = data.papel;
  state.sessao.papelRotulo = data.papelRotulo;
  state.sessao.permissoes = data.permissoes ?? [];
  state.sessao.modulos = data.modulos ?? [];
  state.sessao.impersonando = !!data.impersonando;
  // Fase I — a PESSOA operacional deste contexto (null em impersonação).
  // `state.sessao.usuario` continua sendo a CONTA (/me). Sem UI ainda (Fase F).
  state.sessao.perfil = data.perfil ?? null;
}

/**
 * Recupera o contexto do servidor após um recarregamento de página.
 * Devolve false se não havia contexto válido — quem chama decide para onde ir.
 */
export async function restaurarContexto() {
  if (!contextTokenAtual()) return false;
  try {
    const { data } = await get("/api/v1/sessao/atual");
    state.sessao.empresa = data.empresa;
    state.sessao.unidade = data.unidade;
    state.sessao.papel = data.papel;
    state.sessao.papelRotulo = data.papelRotulo;
    state.sessao.permissoes = data.permissoes ?? [];
    state.sessao.modulos = data.modulos ?? [];
    state.sessao.impersonando = !!data.impersonando;
    state.sessao.perfil = data.perfil ?? null; // Fase I — a PESSOA (null em impersonação)
    return true;
  } catch {
    limparContexto();
    return false;
  }
}

/**
 * Troca de unidade a partir do seletor global do topbar — usa uma rota
 * diferente de `selecionarContexto` porque só ela sabe (no servidor) se a
 * sessão atual é uma impersonação, e é isso que decide a regra de
 * autorização (ver sessao.service.js#trocarUnidadeDoContexto no backend).
 * @param {{unidadeId: string|null}} params
 */
export async function trocarUnidadeDoContexto({ unidadeId }) {
  const { data } = await post("/api/v1/sessao/trocar-unidade", { unidadeId: unidadeId ?? null });
  aplicarContexto(data);
  return data;
}

/**
 * Unidades da empresa do contexto ATUAL que o seletor global do topbar pode
 * oferecer (Fase G) — sempre buscado fresco (nunca reaproveita o snapshot de
 * `state.sessao.acessos` do login), porque é chamado depois de TODA entrada
 * no shell do tenant: login, F5, troca de unidade e impersonação. É esse
 * "sempre fresco" que resolve o contexto sem saída (empresa com várias
 * unidades, `unidadeId` nulo, sem nenhum jeito visível de escolher uma).
 * Falha de rede não pode travar `mostrarApp()` — o chip só fica informativo.
 */
export async function listarUnidadesContexto() {
  try {
    const { data } = await get("/api/v1/sessao/unidades");
    state.sessao.unidadesDaEmpresa = data.unidades ?? [];
  } catch {
    state.sessao.unidadesDaEmpresa = [];
  }
  return state.sessao.unidadesDaEmpresa;
}

/** Encerra apenas o contexto (mantém o login). Usado por "Trocar unidade". */
export async function encerrarContexto() {
  try { await post("/api/v1/sessao/encerrar"); } catch { /* ignora */ }
  limparContexto();
}

/** @param {string} permissao */
export function pode(permissao) {
  // Em impersonação o superadmin passa por tudo — o servidor decide igual, e
  // esconder botões aqui só criaria divergência entre UI e API.
  if (state.sessao.impersonando) return true;
  return state.sessao.permissoes.includes(permissao);
}

/**
 * A empresa do contexto atual contratou este módulo? Controla o menu lateral
 * (app.js#montarMenu) e a guarda de rota (router.js#renderRotaAtual). Mesmo
 * bypass de impersonação de `pode()` — o backend (requireModulo) decide
 * igual, então esconder aqui e liberar lá seria a UI mentir para o suporte.
 * @param {string} moduloId
 */
export function temModulo(moduloId) {
  if (state.sessao.impersonando) return true;
  return state.sessao.modulos.includes(moduloId);
}

// Exportado para o cliente do painel SuperAdmin reaproveitar o mesmo
// tratamento de erro e os mesmos cabeçalhos.
export const http = { get, post, chamar, cabecalhos };
