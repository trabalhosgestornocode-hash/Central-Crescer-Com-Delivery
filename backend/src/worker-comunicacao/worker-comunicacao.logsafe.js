// Sanitização de logs do worker de comunicação.
//
// REGRA ABSOLUTA (Checkpoint H.2-A): nenhum log deste worker pode conter
// conteúdo de mensagem, telefone, JID, providerMessageId ou nome de
// cliente/organização — só agregados (contagens) e metadados operacionais.
// Todo log do worker passa por workerLog() — nunca console.* direto aqui.

const CHAVES_PROIBIDAS = [
  "telefone", "telefonee164", "phone", "jid", "conteudo", "texto", "mensagem",
  "providermessageid", "provider_message_id", "nome", "cliente", "email",
  "password", "senha", "token", "secret", "segredo", "authorization", "hmac",
];

const MASCARA = "[REDACTED]";
const PROFUNDIDADE_MAX = 6;

function chaveEhSensivel(chave) {
  const k = String(chave).toLowerCase().replace(/[-_\s]/g, "");
  return CHAVES_PROIBIDAS.some((p) => k.includes(p.replace(/[-_\s]/g, "")));
}

/** Devolve uma CÓPIA segura de qualquer valor. Nunca muta a entrada. */
export function sanitizar(valor, profundidade = 0) {
  if (valor == null) return valor;
  if (profundidade > PROFUNDIDADE_MAX) return "[...]";
  if (typeof valor !== "object") return valor;
  if (valor instanceof Error) return { nome: valor.name, mensagem: String(valor.message).slice(0, 300) };
  if (Array.isArray(valor)) return valor.map((v) => sanitizar(v, profundidade + 1));

  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    saida[k] = chaveEhSensivel(k) ? MASCARA : sanitizar(v, profundidade + 1);
  }
  return saida;
}

/** Log estruturado padronizado do worker. `dados` sempre sanitizado. */
export function workerLog(nivel, evento, dados = {}) {
  const linha = { escopo: "comunicacao-worker", evento, ...sanitizar(dados) };
  const fn = nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log;
  fn(JSON.stringify(linha));
}
