// MODO PLATAFORMA da interface do Financeiro v2 (Execução 10). Aberto pelo item "Dashboard Financeiro" da Crescer quando a
// unidade está liberada (`/financeiro-v2/?modo=plataforma`), na MESMA aba e na MESMA origem — sem login próprio:
//   - credenciais = as da plataforma: token de acesso do Supabase (renovado pelo próprio cliente) + `x-context-token`
//     (sessionStorage da aba, emitido pelo servidor na escolha da unidade);
//   - endereços da demonstração (/api/fv2/...) viram as rotas reais (/api/v1/financeiro-v2/...);
//   - a unidade é SEMPRE a da sessão (o servidor ignora qualquer unidade vinda daqui);
//   - falha da API real NUNCA vira dado sintético: a tela mostra o estado (sem sessão, sem permissão, não liberado,
//     desligado, autorização indisponível, falha) e nada mais.

export const emModoPlataforma = (busca = globalThis.location?.search ?? "") => new URLSearchParams(busca).get("modo") === "plataforma";

/** Endereço da demonstração → rota real. Fora da lista → null (não é enviado). */
export function traduzirEndereco(url) {
  const u = String(url);
  if (u === "/api/fv2/sessao" || u.startsWith("/api/fv2/sessao?")) return `/api/v1/financeiro-v2/sessao${u.slice("/api/fv2/sessao".length)}`;
  if (u.startsWith("/api/fv2/acoes/")) return `/api/v1/financeiro-v2/acoes/${u.slice("/api/fv2/acoes/".length)}`;
  if (u.startsWith("/api/fv2/corporativo/")) return `/api/v1/financeiro-v2/corporativo/${u.slice("/api/fv2/corporativo/".length)}`;
  if (u.startsWith("/api/fv2/administracao/")) return `/api/v1/financeiro-v2/administracao/${u.slice("/api/fv2/administracao/".length)}`;
  if (u.startsWith("/api/fv2/login") || u.startsWith("/api/fv2/logout") || u.startsWith("/api/fv2/documentos/arquivo")) return null;
  if (u.startsWith("/api/fv2/")) return `/api/v1/financeiro-v2/api/${u.slice("/api/fv2/".length)}`;
  return null;
}

const CABECALHOS_DA_DEMONSTRACAO = ["x-fv2-demo-sessao", "x-fv2-csrf"];
const respostaLocal = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

/** Rotas OFICIAIS da plataforma (as mesmas do roteador da Crescer; nada aqui é inventado). `setor` é lido uma vez pelo shell da plataforma. */
export const ROTAS_PLATAFORMA = Object.freeze({
  entrar: "/?setor=financeiro", // sessão vencida: a plataforma pede o login e, ao entrar, volta ao financeiro (se a pessoa ainda tiver acesso)
  inicio: "/?setor=escolher", // escolha de setor/unidade da plataforma
  operacional: "/?setor=operacional", // Dashboard Operacional (só se o servidor ainda autorizar o setor)
});

const ehMfa = (c) => String(c?.motivo ?? c?.codigo ?? c?.erro ?? "").startsWith("MFA") || c?.motivo === "REAUTENTICACAO_RECENTE";

/**
 * Transporte (assinatura de fetch) que leva as credenciais da plataforma às rotas reais.
 * Em 401 (e só então) tenta UMA renovação do login pelo fluxo existente (`renovar`) e UMA repetição da chamada: nunca em laço.
 * @param {{credenciais:()=>Promise<{token:string|null, contexto:string|null}>, renovar?:()=>Promise<boolean>, fetchFn?:typeof fetch}} p
 */
export function criarTransportePlataforma({ credenciais, renovar = null, fetchFn = (...a) => fetch(...a) }) {
  return async (url, opcoes = {}) => {
    const alvo = traduzirEndereco(url);
    if (!alvo) return respostaLocal(404, { erro: "INDISPONIVEL_NA_PLATAFORMA", mensagem: "Este recurso não está disponível no Crescer Com Delivery Financeiro." });
    const cab = Object.fromEntries(Object.entries(opcoes.headers ?? {}).filter(([k]) => !CABECALHOS_DA_DEMONSTRACAO.includes(k.toLowerCase())));
    // Ações: a unidade NUNCA vai no corpo (o servidor usa a da sessão e recusa campos fora da lista) e a caixa
    // "confirmar" é só da tela (a pessoa já confirmou para o envio acontecer).
    let corpo = opcoes.body;
    if (alvo.startsWith("/api/v1/financeiro-v2/acoes/") && typeof corpo === "string") {
      try { const { unidade: _u, confirmar: _c, ...resto } = JSON.parse(corpo); corpo = JSON.stringify(resto); } catch { /* corpo inválido segue e o servidor recusa */ }
    }
    const enviarCom = async () => {
      let c;
      try { c = await credenciais(); } catch { c = { token: null, contexto: null }; }
      if (!c?.token) return { local: respostaLocal(401, { erro: "SEM_SESSAO", motivo: "SESSAO_EXPIRADA", mensagem: "Sua sessão expirou. Entre novamente pela plataforma." }) };
      if (!c?.contexto) return { local: respostaLocal(409, { erro: "SEM_CONTEXTO", mensagem: "Escolha a unidade na plataforma antes de abrir o financeiro." }) };
      return { resposta: await fetchFn(alvo, { ...opcoes, ...(corpo !== undefined ? { body: corpo } : {}), credentials: "same-origin", headers: { ...cab, Authorization: `Bearer ${c.token}`, "x-context-token": c.contexto } }) };
    };
    let r = await enviarCom();
    const ruim401 = async (x) => (x.local ? x.local.status === 401 : x.resposta.status === 401 && !ehMfa(await x.resposta.clone().json().catch(() => ({}))));
    if (renovar && (await ruim401(r))) {
      let renovou = false;
      try { renovou = await renovar(); } catch { renovou = false; }
      if (renovou) r = await enviarCom(); // UMA repetição; se falhar de novo, o 401 segue para a tela
    }
    return r.local ?? r.resposta;
  };
}

async function garantirSupabase() {
  if (globalThis.window?.supabase) return;
  await new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"; // o MESMO script da página da plataforma
    s.onload = ok; s.onerror = falha;
    document.head.append(s);
  });
}

/** Credenciais da plataforma (mesmos módulos da Crescer; o cliente Supabase renova o token sozinho). */
export async function credenciaisDaPlataforma() {
  await garantirSupabase();
  const [{ tokenAtual }, { contextTokenAtual }] = await Promise.all([import("../src/supabaseClient.js"), import("../src/sessao.js")]);
  return { token: await tokenAtual(), contexto: contextTokenAtual() };
}

// Renovação do login: UMA por vez (as chamadas simultâneas dividem o resultado) e no máximo uma a cada 20 s — sem laço de renovação.
let renovacaoEmCurso = null;
let ultimaRenovacao = 0;
export async function renovarCredenciaisDaPlataforma(agora = () => Date.now()) {
  if (renovacaoEmCurso) return renovacaoEmCurso;
  if (agora() - ultimaRenovacao < 20_000) return false;
  renovacaoEmCurso = (async () => {
    try {
      await garantirSupabase();
      const { getSupabase } = await import("../src/supabaseClient.js");
      const { data, error } = await (await getSupabase()).auth.refreshSession();
      return !error && Boolean(data?.session?.access_token);
    } catch { return false; } finally { ultimaRenovacao = agora(); renovacaoEmCurso = null; }
  })();
  return renovacaoEmCurso;
}

/**
 * Aquece a autenticação em paralelo com o resto do carregamento (script do Supabase, módulos da plataforma e leitura da sessão local):
 * quando a primeira consulta precisar do token, ele já está pronto. Não envia nada ao servidor financeiro e ignora qualquer falha
 * (a consulta de verdade refaz o caminho e mostra o estado correto: sem sessão, sem permissão etc.).
 */
export function aquecerCredenciais() { credenciaisDaPlataforma().catch(() => {}); }

/** Estados da tela a partir da resposta de erro (status + código + motivo do servidor). */
export function estadoDoErro(r) {
  const m = r?.motivo ?? null;
  const e = r?.erro ?? null;
  if (r?.status === 0 || e === "SEM_CONEXAO") return { tipo: "rede", mensagem: "Não foi possível falar com o servidor. Confira a conexão e tente de novo; nada foi alterado." };
  if (r?.status === 401 || e === "SEM_SESSAO" || m === "SESSAO_EXPIRADA" || m === "TOKEN_DE_OUTRA_CONTA") return { tipo: "sem-sessao", mensagem: "Por segurança, os dados desta tela foram removidos. Nada foi alterado." };
  if (r?.status === 409 && e === "SEM_CONTEXTO") return { tipo: "sem-contexto", mensagem: r.mensagem };
  if (e === "FINANCEIRO_V2_DESLIGADO") return { tipo: "negado", mensagem: "O Crescer Com Delivery Financeiro está desativado. O financeiro desta unidade segue no painel atual." };
  if (m === "UNIDADE_NAO_LIBERADA" || m === "EMPRESA_NAO_LIBERADA") return { tipo: "negado", mensagem: "O Crescer Com Delivery Financeiro não está liberado para esta unidade." };
  if (m === "SEM_CONCESSAO") return { tipo: "negado", mensagem: "Você não tem permissão no Crescer Com Delivery Financeiro nesta unidade. Peça ao administrador financeiro." };
  if (["IMPERSONACAO", "PERFIL_DE_EXIBICAO", "CONTA_COMPARTILHADA", "PESSOA_SEM_IDENTIDADE", "UNIDADE_NAO_AUTORIZADA", "SEM_UNIDADE"].includes(m)) return { tipo: "negado", mensagem: r.mensagem };
  if (e === "AUTORIZACAO_FINANCEIRA_INDISPONIVEL") return { tipo: "erro", mensagem: "O serviço de autorização financeira está indisponível. Tente de novo em instantes; nada foi alterado." };
  if (String(m ?? "").startsWith("MFA") || m === "REAUTENTICACAO_RECENTE") return { tipo: "negado", mensagem: "Esta operação exige confirmar o segundo fator (código do aplicativo autenticador) nos últimos 10 minutos." };
  if (["ESCRITA_DESLIGADA", "HOMOLOGACAO_AGUARDA_MATRIZ", "COFRE_INDISPONIVEL"].includes(e)) return { tipo: "negado", mensagem: r.mensagem };
  if (r?.status === 403) return { tipo: "negado", mensagem: r.mensagem };
  return { tipo: "erro", mensagem: r?.mensagem ?? "Não foi possível carregar." };
}
