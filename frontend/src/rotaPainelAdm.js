// Rota do PAINEL ADMINISTRATIVO no hash da URL — sobrevive ao F5, vale por aba (cada aba tem sua URL) e permite
// link direto. É só um ENDEREÇO: quem decide o acesso continua sendo o backend (GET /administrativo/ping e as
// próprias rotas, que devolvem 403/404). Nenhum dado sensível vai na URL — só a tela e ids opacos.
//
//   #/painel-adm/<tela>
//   #/painel-adm/nucleo-mentorados/<empresa>/<aba>
//   #/painel-adm/nucleo-mentorados/<empresa>/<aba>/apresentacao/<id>/<slide>

const PREFIXO = "#/painel-adm";
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_TELA = /^[a-z][a-z-]{1,40}$/;
const ABAS = new Set(["visao", "historico", "comparativo", "evolucao", "apresentacoes"]);

/** @returns {{tela: string|null, org?: string, aba?: string, apresentacao?: string, slide?: number}|null} null = não é rota do painel */
export function lerRota(hash = "") {
  if (typeof hash !== "string" || !(hash === PREFIXO || hash.startsWith(PREFIXO + "/"))) return null;
  const partes = hash.slice(PREFIXO.length).split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  const tela = RE_TELA.test(partes[0] ?? "") ? partes[0] : null;
  const rota = { tela };
  if (tela === "nucleo-mentorados" && RE_ID.test(partes[1] ?? "")) {
    rota.org = partes[1].toLowerCase();
    rota.aba = ABAS.has(partes[2]) ? partes[2] : "visao";
    if (partes[3] === "apresentacao" && RE_ID.test(partes[4] ?? "")) {
      rota.apresentacao = partes[4].toLowerCase();
      const n = Number(partes[5]);
      rota.slide = Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1;
    }
  }
  return rota;
}

export function montarRota(r = {}) {
  let h = PREFIXO;
  if (!r.tela) return h;
  h += `/${r.tela}`;
  if (r.tela === "nucleo-mentorados" && r.org) {
    h += `/${r.org}/${ABAS.has(r.aba) ? r.aba : "visao"}`;
    if (r.apresentacao) h += `/apresentacao/${r.apresentacao}/${r.slide ?? 1}`;
  }
  return h;
}

/** Grava sem criar entrada no histórico (Voltar do navegador não vira navegação interna). */
export function gravarRota(r, loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !hist) return;
  const h = montarRota(r);
  if (loc.hash !== h) hist.replaceState(hist.state, "", h);
}

export function limparRota(loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !hist || !lerRota(loc.hash)) return;
  hist.replaceState(hist.state, "", loc.pathname + loc.search);
}

export const rotaAtual = (loc = globalThis.location) => lerRota(loc?.hash ?? "");

/**
 * Decide se o boot deve reabrir o Painel Administrativo a partir do endereço. Só para contas com o acesso
 * (painelAdministrativo ou SuperAdmin no /me); a confirmação final é do backend (/administrativo/ping).
 */
export function podeRestaurarPainel(rota, usuario) {
  return !!rota && !!(usuario?.painelAdministrativo || usuario?.superadmin);
}
