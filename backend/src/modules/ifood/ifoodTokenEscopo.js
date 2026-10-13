// iFood — ESCOPO de merchants de um access token (JWT), de forma PURA e SEGURA.
//
// Os access tokens do iFood (distribuído) são JWT com a claim `merchant_scope`: uma lista de "<merchantId>:<módulo>" (ex.:
// "a6e54f…:order", "a6e54f…:events"). Quem pode consultar o quê vem daí. Este módulo só LÊ essa claim — sem rede, sem gravar,
// sem verificar a assinatura (a assinatura é do iFood: a leitura da claim NÃO prova que o servidor aceita o token; prova só o que o token
// declara). Serve para uma coisa: antes de SUBSTITUIR a credencial ativa de uma conexão por uma nova, provar que o token novo declara
// TODAS as lojas (e módulos) que a credencial atual já cobre — nunca perder uma loja que funciona.
//
// Nunca lança, nunca loga o token, nunca devolve o token ou o payload inteiro: só merchants/módulos e datas.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ESCOPO = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z_-]{1,40})$/i;

/** Módulos que a conexão Order usa (Events + Order). Padrão de exigência quando o token atual não pode ser lido. */
export const MODULOS_ORDER = Object.freeze(["order", "events"]);
/** Folga mínima de validade do token novo (ms): um token quase vencido não serve de prova nem de credencial. */
export const FOLGA_VALIDADE_MS = 60_000;

export const mascararMerchant = (id) => (typeof id === "string" && id.length >= 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : "?");

/**
 * @param {unknown} token
 * @returns {{formato: "jwt"|"opaco"|"ausente", temEscopo: boolean, merchants: Map<string, Set<string>>, expMs: number|null, iatMs: number|null}}
 */
export function escopoDoAccessToken(token) {
  const vazio = (formato) => ({ formato, temEscopo: false, merchants: new Map(), expMs: null, iatMs: null });
  if (typeof token !== "string" || token.trim() === "") return vazio("ausente");
  const partes = token.trim().split(".");
  if (partes.length !== 3) return vazio("opaco");
  let payload;
  try { payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")); } catch { return vazio("opaco"); }
  if (!payload || typeof payload !== "object") return vazio("opaco");

  const merchants = new Map();
  const lista = Array.isArray(payload.merchant_scope) ? payload.merchant_scope : null;
  for (const item of lista ?? []) {
    const m = typeof item === "string" ? ESCOPO.exec(item.trim()) : null;
    if (!m) continue;                                                     // entrada fora do formato: ignorada (nunca "inventa" cobertura)
    const id = m[1].toLowerCase();
    (merchants.get(id) ?? merchants.set(id, new Set()).get(id)).add(m[2].toLowerCase());
  }
  const ms = (s) => (Number.isFinite(s) ? s * 1000 : null);
  return { formato: "jwt", temEscopo: lista !== null, merchants, expMs: ms(payload.exp), iatMs: ms(payload.iat) };
}

/**
 * Prova de cobertura para SUBSTITUIR uma credencial: o token NOVO precisa declarar, para cada loja exigida, os mesmos módulos que o token
 * ATUAL declara para ela (ou, se o atual não puder ser lido, `modulosPadrao`). Sem escopo legível no token novo = SEM prova = não cobre.
 *
 * @param {{novo: string, atual?: string|null, merchantsExigidos: string[], modulosPadrao?: readonly string[], agoraMs?: number}} p
 * @returns {{cobre: boolean, motivo: "ok"|"token_novo_sem_escopo"|"token_novo_vencido"|"faltam_lojas", faltando: Array<{merchant: string, modulos: string[]}>, novasLojas: string[]}}
 */
export function coberturaDoToken({ novo, atual = null, merchantsExigidos, modulosPadrao = MODULOS_ORDER, agoraMs = Date.now() }) {
  const exigidos = [...new Set((merchantsExigidos ?? []).filter((m) => typeof m === "string" && UUID.test(m.toLowerCase())).map((m) => m.toLowerCase()))];
  const n = escopoDoAccessToken(novo);
  if (n.formato !== "jwt" || !n.temEscopo) return { cobre: false, motivo: "token_novo_sem_escopo", faltando: exigidos.map((merchant) => ({ merchant: mascararMerchant(merchant), modulos: [...modulosPadrao] })), novasLojas: [] };
  if (n.expMs !== null && n.expMs - agoraMs < FOLGA_VALIDADE_MS) return { cobre: false, motivo: "token_novo_vencido", faltando: [], novasLojas: [] };

  const a = escopoDoAccessToken(atual);
  const faltando = [];
  for (const merchant of exigidos) {
    const doAtual = a.formato === "jwt" && a.temEscopo ? a.merchants.get(merchant) : null;
    const requeridos = doAtual && doAtual.size ? [...doAtual] : [...modulosPadrao];
    const tem = n.merchants.get(merchant) ?? new Set();
    const faltam = requeridos.filter((mod) => !tem.has(mod));
    if (faltam.length) faltando.push({ merchant: mascararMerchant(merchant), modulos: faltam });
  }
  const novasLojas = [...n.merchants.keys()].filter((m) => !exigidos.includes(m)).map(mascararMerchant);
  return { cobre: faltando.length === 0, motivo: faltando.length ? "faltam_lojas" : "ok", faltando, novasLojas };
}
