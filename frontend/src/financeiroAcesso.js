// Resolução EXPLÍCITA do acesso ao Dashboard Financeiro — decide QUAL interface montar ANTES de montar qualquer uma.
//
// Causa do bug corrigido aqui: o shell financeiro montava o menu legado e abria a "Visão Geral" antiga de imediato e só
// DEPOIS (assíncrono) consultava o feature flag; quando a resposta chegava, trocava o menu e redirecionava para o
// painel 2.0. Resultado em toda atualização: Financeiro antigo → "Carregando…" → Financeiro 2.0. Além disso, uma falha
// de rede no flag era engolida e o legado ficava como se o flag estivesse desligado.
//
// Agora o estado começa em `loading` (tela neutra, sem menu financeiro nenhum) e só vira uma interface depois da
// resposta do servidor. O legado NUNCA é o padrão enquanto a consulta roda, e erro de rede é `error` — jamais legado.
import { MENU_FINANCEIRO, MODULOS_FINANCEIRO, ROTULOS_AGRUPADOS, SECAO_FINANCEIRO } from "./financeiroMenu.js";

export const ESTADO_FINANCEIRO = Object.freeze({
  LOADING: "loading",
  FINANCEIRO_2: "financeiro_2",
  LEGADO: "financeiro_legado",
  NEGADO: "access_denied",
  ERRO: "error",
});

/** Recusa de acesso vinda do backend (revogação, expiração, módulo desligado) — mesma regra do roteador financeiro. */
export function ehRecusaDeAcesso(e) {
  return e?.status === 403 || e?.status === 409 || /^FINANCEIRO_/.test(e?.details?.codigo ?? e?.codigo ?? "");
}

/** Traduz a resposta de GET /gestao-financeira/status num estado. Resposta malformada é ERRO, nunca legado. */
export function estadoDoStatus(status) {
  if (!status || typeof status !== "object") return ESTADO_FINANCEIRO.ERRO;
  if (status.habilitado === false) return ESTADO_FINANCEIRO.NEGADO;
  return status.financeiro2 === true ? ESTADO_FINANCEIRO.FINANCEIRO_2 : ESTADO_FINANCEIRO.LEGADO;
}

/**
 * Consulta o servidor UMA vez e devolve o estado resolvido.
 * @param {{ get: (url: string) => Promise<{data?: any}> }} http
 * @returns {Promise<{ estado: string, status: any, erro?: any }>}
 */
export async function resolverAcessoFinanceiro(http) {
  try {
    const status = (await http.get("/api/v1/gestao-financeira/status"))?.data;
    return { estado: estadoDoStatus(status), status };
  } catch (erro) {
    return { estado: ehRecusaDeAcesso(erro) ? ESTADO_FINANCEIRO.NEGADO : ESTADO_FINANCEIRO.ERRO, status: null, erro };
  }
}

/** Endereço do Financeiro v2 dentro da plataforma (mesma aba, mesma origem, mesmo login). */
export const ENDERECO_FINANCEIRO_V2 = "/financeiro-v2/?modo=plataforma#/visao-geral";

/**
 * Execução 10 — o Financeiro v2 SUBSTITUI o painel atual só na unidade LIBERADA. Desligado ou não liberado = nada muda.
 * @returns {Promise<{ok:true, liberado:boolean, operavel:boolean, motivo:string|null}|{ok:false}>} falha = ERRO (nunca legado)
 */
export async function resolverFinanceiroV2(http) {
  try {
    // O cliente da plataforma (sessao.js#chamar) devolve o JSON da rota SEM envelope; aceita também `{ data }`.
    const r = await http.get("/api/v1/financeiro-v2/status");
    const s = typeof r?.liberado === "boolean" ? r : r?.data;
    if (!s || typeof s.liberado !== "boolean") return { ok: false };
    return { ok: true, liberado: s.liberado, operavel: s.liberado && s.disponivel === true && s.operavel === true, motivo: s.motivo ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Itens do menu financeiro para um estado já RESOLVIDO. Em `loading`/`error`/`access_denied` não há menu algum —
 * nada do legado é desenhado enquanto não se sabe qual interface é a certa.
 * @returns {Array<{ secao: string, itens: Array<{ id: string, label: string, icon: string }> }>}
 */
export function menuDoEstado(estado) {
  if (estado === ESTADO_FINANCEIRO.FINANCEIRO_2) {
    const porId = new Map(MENU_FINANCEIRO.map((m) => [m.id, m]));
    return MODULOS_FINANCEIRO.map((g) => ({
      secao: g.rotulo,
      itens: g.itens.map((id) => porId.get(id)).filter(Boolean).map((m) => ({ ...m, label: ROTULOS_AGRUPADOS[m.id] ?? m.label })),
    }));
  }
  if (estado === ESTADO_FINANCEIRO.LEGADO) return [{ secao: SECAO_FINANCEIRO, itens: MENU_FINANCEIRO.filter((m) => !m.fin2) }];
  return [];
}

/** Rota de entrada: respeita a rota pedida se ela existe no estado resolvido; senão, a primeira do menu desse estado. */
export function rotaDeEntrada(estado, rotaPedida) {
  const ids = menuDoEstado(estado).flatMap((s) => s.itens.map((i) => i.id));
  if (!ids.length) return null;
  if (estado === ESTADO_FINANCEIRO.FINANCEIRO_2 && (!rotaPedida || !ids.includes(rotaPedida))) return "fin-painel";
  return rotaPedida && ids.includes(rotaPedida) ? rotaPedida : ids[0];
}

// ---------- status pré-resolvido: evita a 2ª consulta idêntica na primeira página ----------
// O shell acabou de consultar o status para decidir a interface; a primeira página aberta logo em seguida reaproveita
// ESSA resposta (uma vez só, e só se for recente e do mesmo contexto). As navegações seguintes voltam a consultar o
// servidor a cada página, como antes — a reconferência de acesso por página continua valendo.
const VALIDADE_MS = 15_000;
let preResolvido = null;

export function guardarStatusPreResolvido(status, chaveContexto, agora = Date.now()) {
  preResolvido = status ? { status, chaveContexto, em: agora } : null;
}

export function consumirStatusPreResolvido(chaveContexto, agora = Date.now()) {
  const p = preResolvido;
  preResolvido = null;
  if (!p || p.chaveContexto !== chaveContexto || agora - p.em > VALIDADE_MS) return null;
  return p.status;
}

/** Marcação do carregamento neutro (sem menu, sem número, sem cara de nenhuma das duas versões). */
export const CARREGAMENTO_NEUTRO = `<div class="fin-carregando" role="status" aria-live="polite" aria-busy="true"><span class="fin-carregando-ponto"></span><span class="fin-carregando-ponto"></span><span class="fin-carregando-ponto"></span><span class="sr-only">Carregando</span></div>`;
