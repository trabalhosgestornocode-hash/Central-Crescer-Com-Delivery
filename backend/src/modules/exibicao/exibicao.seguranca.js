// Telas de exibição (TV/tablet) — CONTRATO DE SEGURANÇA (funções puras, sem I/O).
//
// Ainda NÃO está ligado a nenhuma rota: este módulo fixa as regras que o backend do Checkpoint 5C vai usar, e é
// testado isoladamente. Modelo completo (ameaças, cookies, contratos): docs/exibicao-sessoes-modelo.md.
// Banco: database/migrations/110_exibicao_dispositivos.sql (só hashes; acesso só por função).
//
// TRÊS segredos diferentes, cada um com seu papel:
//   token da tela      256 bits aleatórios, só em cookie HttpOnly da TV. Banco: SHA-256. É a credencial.
//   segredo do pedido  256 bits aleatórios, só em cookie HttpOnly da TV durante o pareamento. Banco: SHA-256.
//                      Liga o pedido ao navegador que o criou: quem só viu o código não pega a credencial.
//   código             8 caracteres (~40 bits) mostrados na TV / no QR. NÃO é credencial: sozinho não dá acesso a
//                      nada (aprovar exige login + permissão na Central; consumir exige o segredo do pedido).
//                      Banco: HMAC-SHA-256 com segredo do servidor (vazamento do banco não reverte códigos).
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Políticas (valores propostos — ver docs; a migration impõe os tetos)
// ---------------------------------------------------------------------------
export const POLITICA = Object.freeze({
  pareamentoValidadeS: 10 * 60,     // pedido de código: 10 min (banco aceita 60..900 s)
  telaValidadeDias: 90,             // validade absoluta da tela (banco: até 180)
  telaInatividadeDias: 30,          // sem uso por 30 dias: expira (banco: 1..90)
  telasPorUnidade: 10,              // telas ativas por unidade
  rotacaoHoras: 24,                 // troca do token (o banco decide quando é devida)
  // Tela sem resposta boa do servidor (offline): marca "desatualizado" e, depois de um tempo, ESCONDE os números.
  offlineDesatualizadoS: 90,
  offlineOcultarS: 15 * 60,
});

// ---------------------------------------------------------------------------
// Token da tela
// ---------------------------------------------------------------------------
/** Token novo: 32 bytes aleatórios em base64url (43 caracteres). Só vai para o cookie; nunca para o banco. */
export function gerarTokenTela() {
  return crypto.randomBytes(32).toString("base64url");
}

/** Hash guardado no banco (hex minúsculo, 64). Token de alta entropia: SHA-256 puro basta (sem sal/KDF). */
export function hashSegredo(valor) {
  if (typeof valor !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(valor)) throw new Error("segredo em formato inválido");
  return crypto.createHash("sha256").update(valor, "utf8").digest("hex");
}

/** Segredo do pedido de pareamento — mesmo formato e mesmo hash do token. */
export const gerarSegredoPareamento = gerarTokenTela;

// ---------------------------------------------------------------------------
// Código de pareamento (o que a pessoa lê na TV / no QR)
// ---------------------------------------------------------------------------
/** Base32 de Crockford: sem I, L, O, U (nada que se confunda lendo de longe). 32 símbolos = 5 bits cada. */
export const ALFABETO_CODIGO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TAMANHO_CODIGO = 8; // 40 bits

/** Código uniforme (randomInt não tem viés de módulo). Ex.: "7KQ2-M9XD". */
export function gerarCodigoPareamento() {
  let s = "";
  for (let i = 0; i < TAMANHO_CODIGO; i++) s += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normaliza o que a pessoa digitou: maiúsculas, sem espaço/traço; O->0, I/L->1. `null` se não for um código. */
export function normalizarCodigo(entrada) {
  if (typeof entrada !== "string") return null;
  const s = entrada.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== TAMANHO_CODIGO) return null;
  for (const c of s) if (!ALFABETO_CODIGO.includes(c)) return null;
  return s;
}

/** HMAC do código normalizado com o segredo do servidor (pepper). Pepper curto é recusado. */
export function hashCodigo(codigoNormalizado, pepper) {
  if (typeof pepper !== "string" || pepper.length < 32) throw new Error("pepper do código ausente ou curto");
  if (normalizarCodigo(codigoNormalizado) !== codigoNormalizado) throw new Error("código não normalizado");
  return crypto.createHmac("sha256", pepper).update(`exibicao:codigo:${codigoNormalizado}`, "utf8").digest("hex");
}

/**
 * Endereço do QR: abre a aprovação NA CENTRAL (onde o gerente já está logado). O código vai no FRAGMENTO (#):
 * fragmento não é enviado ao servidor, não aparece em log de acesso nem em Referer. O código não é credencial.
 */
export function urlAprovacaoQr(baseUrl, codigo) {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error("QR exige https");
  u.pathname = "/";
  u.search = "";
  u.hash = `aprovar-tela=${encodeURIComponent(codigo)}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export const PATH_API_EXIBICAO = "/api/v1/exibicao";
export const COOKIE_TELA = "__Secure-cko_tela";
export const COOKIE_PAREAMENTO = "__Secure-cko_par";
export const COOKIE_TELA_DEV = "cko_tela";       // http://localhost (sem Secure, sem prefixo)
export const COOKIE_PAREAMENTO_DEV = "cko_par";

/**
 * Opções do Set-Cookie. HttpOnly (JS não lê), SameSite=Strict (não vai em requisição de outro site), Path restrito
 * à API de exibição (não vai para o resto da Central), SEM Domain (só o host exato), Secure em produção.
 * @param {{producao: boolean, tipo: "tela"|"pareamento", maxAgeS: number}} p
 */
export function opcoesCookie({ producao, tipo, maxAgeS }) {
  if (!Number.isInteger(maxAgeS) || maxAgeS < 1) throw new Error("maxAgeS inválido");
  return {
    nome: producao ? (tipo === "tela" ? COOKIE_TELA : COOKIE_PAREAMENTO) : (tipo === "tela" ? COOKIE_TELA_DEV : COOKIE_PAREAMENTO_DEV),
    httpOnly: true,
    secure: producao,
    sameSite: "strict",
    path: tipo === "tela" ? PATH_API_EXIBICAO : `${PATH_API_EXIBICAO}/pareamentos`,
    maxAge: maxAgeS * 1000, // express usa ms
  };
}

/**
 * Lê o cookie da tela do cabeçalho Cookie. Mais de um cookie com o mesmo nome (tentativa de fixação por um
 * subdomínio ou cookie antigo com outro Path) => recusa (null + `duplicado`), nunca "escolhe um".
 */
export function lerCookieUnico(cabecalhoCookie, nome) {
  if (typeof cabecalhoCookie !== "string" || !cabecalhoCookie) return { valor: null, duplicado: false };
  const valores = cabecalhoCookie.split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${nome}=`)).map((p) => p.slice(nome.length + 1));
  if (valores.length > 1) return { valor: null, duplicado: true };
  return { valor: valores[0] ?? null, duplicado: false };
}

// ---------------------------------------------------------------------------
// CSRF / origem
// ---------------------------------------------------------------------------
/** Cabeçalho obrigatório em TODA chamada da página de exibição (força preflight em chamada de outra origem). */
export const CABECALHO_EXIBICAO = "x-crescer-exibicao";

/**
 * Operação que muda estado com autenticação por cookie: exige Origin presente e na lista. Sem Origin => recusa
 * (navegadores atuais sempre mandam Origin em POST). GET nunca muda estado.
 */
export function origemPermitida(metodo, origin, permitidas) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(metodo).toUpperCase())) return true;
  if (typeof origin !== "string" || !origin) return false;
  return (permitidas ?? []).includes(origin);
}

// ---------------------------------------------------------------------------
// Identificação mínima do aparelho (sem PII)
// ---------------------------------------------------------------------------
/** IPv4 -> /24; IPv6 -> /48. Nunca o IP completo. */
export function prefixoRede(ip) {
  if (typeof ip !== "string") return null;
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) return m.slice(1).every((o) => Number(o) <= 255) ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":")) {
    const partes = ip.toLowerCase().split("::")[0].split(":").filter(Boolean);
    if (!partes.length) return null;
    return `${[...partes, "0", "0"].slice(0, 3).join(":")}::/48`;
  }
  return null;
}

/** Família do navegador + sistema, para a pessoa reconhecer a TV na lista. Sem versão completa nem identificadores. */
export function resumoNavegador(ua) {
  if (typeof ua !== "string" || !ua) return null;
  const nav = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const so = /Tizen/i.test(ua) ? "Tizen (TV)" : /Web0S|webOS/i.test(ua) ? "webOS (TV)" : /Android TV|AFT[A-Z]|BRAVIA/i.test(ua) ? "Android TV"
    : /Android/.test(ua) ? "Android" : /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Windows/.test(ua) ? "Windows"
      : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "outro";
  return `${nav} / ${so}`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Resultado do banco -> resposta HTTP (fail-closed)
// ---------------------------------------------------------------------------
const STATUS_RESOLUCAO = Object.freeze({
  ok: 200, ok_token_anterior: 200,
  nao_encontrado: 401, revogado: 401, expirado: 401, inativo: 401, token_substituido: 401,
  unidade_indisponivel: 403, empresa_indisponivel: 403, modulo_indisponivel: 403,
});

/** Qualquer resultado desconhecido vira 401 (nunca dados). Erro de banco vira 503 (nunca dados). */
export function respostaDaResolucao(resultado, { erroBanco = false } = {}) {
  if (erroBanco) return { status: 503, codigo: "EXIBICAO_INDISPONIVEL", servirDados: false, limparCookie: false };
  const status = STATUS_RESOLUCAO[resultado] ?? 401;
  return {
    status,
    codigo: status === 200 ? null : status === 403 ? "EXIBICAO_SEM_ACESSO" : `EXIBICAO_${String(resultado || "invalida").toUpperCase()}`,
    servirDados: status === 200,
    // Credencial que não vale mais: apaga o cookie. `token_substituido` NÃO apaga (a TV legítima pode ter o novo).
    limparCookie: ["nao_encontrado", "revogado", "expirado", "inativo"].includes(resultado) || !(resultado in STATUS_RESOLUCAO),
  };
}

// ---------------------------------------------------------------------------
// Permissão e auditoria
// ---------------------------------------------------------------------------
/** Permissão nova (proposta): NÃO derivada de integracoes.ver. */
export const PERMISSAO_GERENCIAR_TELAS = "checklist.telas.gerenciar";
/** Papéis que a receberiam (proposta; organization_admin já recebe tudo via Object.values). */
export const PAPEIS_COM_GESTAO_DE_TELAS = Object.freeze(["organization_admin", "unit_manager"]);

export const ACOES_AUDITORIA = Object.freeze({
  PAREAMENTO_APROVADO: "exibicao.pareamento_aprovado",
  PAREAMENTO_RECUSADO: "exibicao.pareamento_recusado",   // código inexistente/expirado/unidade inválida (sem o código)
  TELA_CRIADA: "exibicao.tela_criada",
  TELA_RENOMEADA: "exibicao.tela_renomeada",
  TELA_REVOGADA: "exibicao.tela_revogada",
  TELAS_REVOGADAS_UNIDADE: "exibicao.telas_revogadas_unidade",
  TELA_DESCONECTADA: "exibicao.tela_desconectada",       // pela própria TV
  // Token anterior bloqueado depois da folga: sinal de suspeita para a gestão (NÃO revoga sozinho).
  TOKEN_ANTERIOR_REAPARECEU: "exibicao.token_anterior_reapareceu",
});

/** Campos permitidos em `detalhes` por ação. Tudo fora disto é descartado. */
const CAMPOS_PERMITIDOS = Object.freeze({
  [ACOES_AUDITORIA.PAREAMENTO_APROVADO]: ["dispositivoNome", "modo", "unidadeId", "redePrefixo", "navegador"],
  [ACOES_AUDITORIA.PAREAMENTO_RECUSADO]: ["motivo", "unidadeId"],
  [ACOES_AUDITORIA.TELA_CRIADA]: ["dispositivoId", "dispositivoNome", "modo", "unidadeId"],
  [ACOES_AUDITORIA.TELA_RENOMEADA]: ["dispositivoId", "nomeAnterior", "nomeNovo", "unidadeId"],
  [ACOES_AUDITORIA.TELA_REVOGADA]: ["dispositivoId", "unidadeId", "motivo"],
  [ACOES_AUDITORIA.TELAS_REVOGADAS_UNIDADE]: ["unidadeId", "quantidade"],
  [ACOES_AUDITORIA.TELA_DESCONECTADA]: ["dispositivoId", "unidadeId"],
  [ACOES_AUDITORIA.TOKEN_ANTERIOR_REAPARECEU]: ["dispositivoId", "unidadeId", "redePrefixo", "contador"],
});

const PROIBIDO = /token|segredo|secret|cookie|codigo|code|hash|senha|password|^ip$|email|telefone|cpf/i;
const PARECE_SEGREDO = /^[A-Za-z0-9_-]{40,}$|^[0-9a-f]{64}$/;

/**
 * Detalhes de auditoria seguros: só os campos permitidos para a ação, sem nada que pareça credencial.
 * Ação desconhecida lança (evento sem contrato não é gravado por engano).
 */
export function detalhesAuditoria(acao, dados = {}) {
  const permitidos = CAMPOS_PERMITIDOS[acao];
  if (!permitidos) throw new Error(`ação de auditoria desconhecida: ${acao}`);
  const out = {};
  for (const campo of permitidos) {
    if (PROIBIDO.test(campo)) continue;
    const v = dados[campo];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && PARECE_SEGREDO.test(v)) continue;
    out[campo] = typeof v === "string" ? v.slice(0, 120) : v;
  }
  return out;
}
