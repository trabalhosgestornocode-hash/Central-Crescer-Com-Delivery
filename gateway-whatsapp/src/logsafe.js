// Sanitização de logs do Gateway.
//
// Este processo é o ÚNICO ponto do sistema que vê o auth state do WhatsApp
// (creds/keys do Baileys), o QR de pareamento e o conteúdo bruto das
// mensagens. Nenhum desses pode chegar ao log.
//
// Porte de worker-martinbrower/src/logsafe.js. Mantidos separados de
// propósito — cada processo é deployado e versionado independentemente
// (mesmo motivo documentado lá).

// Ambíguas: só mascaram quando a chave é EXATAMENTE isto.
//
// `iv` (vetor de inicialização do AES-GCM) só é segredo-de-log quando a chave
// é EXATAMENTE `iv`. Como substring ele mascarava campos inocentes e essenciais
// ao diagnóstico — `tentativa`, `motivo`, `ativo` (visto ao vivo em 2026-09-19:
// `"tentativa":"[REDACTED]"` nos logs de reconexão) — porque "tentativa" contém
// "iv". `authtag` e `ciphertext` continuam parciais (nenhum campo legítimo os contém).
// As grafias comuns do MESMO vetor (`ivBase64`, `iv_hex`, `initVector`...) entram como
// exatas também — o antigo "substring" as cobria sem querer e não pode haver regressão.
const CHAVES_EXATAS = [
  "codigo", "code", "senha", "pass", "pwd", "token", "auth", "secret", "qr",
  "iv", "ivbase64", "ivb64", "ivhex", "initvector", "initializationvector",
];

// Inequívocas: qualquer chave que CONTENHA isto é segredo.
const CHAVES_PARCIAIS = [
  "password", "authorization", "accesstoken", "refreshtoken", "jwt", "bearer",
  "cookie", "setcookie", "signature",
  "authstate", "creds", "credenciais", "credentials",
  "signalkey", "prekey", "senderkey", "appstatesyncrey", "appstatesynckey",
  "encryptionkey", "ciphertext", "authtag",
  "conteudo", "texto", "caption", "legenda", // corpo de mensagem — nunca no log
];

const MASCARA = "[REDACTED]";
const PROFUNDIDADE_MAX = 6;

const normalizarChave = (c) => String(c).toLowerCase().replace(/[-_\s]/g, "");

function chaveEhSensivel(chave) {
  const k = normalizarChave(chave);
  if (CHAVES_EXATAS.includes(k)) return true;
  return CHAVES_PARCIAIS.some((p) => k.includes(normalizarChave(p)));
}

const PADROES_TEXTO = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASCARA],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${MASCARA}`],
  // Formato versionado do auth state cifrado (src/crypto.js) — nunca no log
  // mesmo cifrado, por reflexo: um blob cifrado ainda é o material mais
  // sensível deste processo.
  [/\bv1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, MASCARA],
];

const sanitizarTexto = (t) => PADROES_TEXTO.reduce((s, [re, sub]) => s.replace(re, sub), t);

export function sanitizar(valor, profundidade = 0) {
  if (valor == null) return valor;
  if (profundidade > PROFUNDIDADE_MAX) return "[...]";
  if (typeof valor === "string") return sanitizarTexto(valor);
  if (typeof valor !== "object") return valor;
  if (valor instanceof Error) {
    return { nome: valor.name, mensagem: sanitizarTexto(valor.message), codigo: valor.codigo ?? null };
  }
  if (Array.isArray(valor)) return valor.map((v) => sanitizar(v, profundidade + 1));

  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    saida[k] = chaveEhSensivel(k) ? MASCARA : sanitizar(v, profundidade + 1);
  }
  return saida;
}

// Assinatura HMAC no log: só os 8 primeiros caracteres, o suficiente para
// correlacionar duas linhas sem permitir reconstrução.
export const prefixoAssinatura = (sig) =>
  typeof sig === "string" && sig.length > 8 ? `${sig.slice(0, 8)}…` : "[curta]";

// Telefone: nunca completo no log. Mantém DDI + 2 últimos dígitos, o
// suficiente para correlacionar sem expor o número inteiro.
export function mascararTelefone(telefoneE164) {
  const s = String(telefoneE164 ?? "");
  const digitos = s.replace(/\D/g, "");
  if (!digitos) return null;
  if (digitos.length <= 4) return "•".repeat(digitos.length);
  return `+${digitos.slice(0, 2)}${"•".repeat(digitos.length - 4)}${digitos.slice(-2)}`;
}

// Log estruturado em JSON.
export function log(nivel, evento, dados = {}) {
  const linha = {
    severity: nivel === "error" ? "ERROR" : nivel === "warn" ? "WARNING" : "INFO",
    servico: "gateway-whatsapp",
    evento,
    ...sanitizar(dados),
  };
  const fn = nivel === "error" ? console.error : console.log;
  fn(JSON.stringify(linha));
}
