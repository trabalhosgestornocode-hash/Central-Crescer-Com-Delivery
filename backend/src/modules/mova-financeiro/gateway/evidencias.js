// ARMAZENAMENTO DE EVIDÊNCIAS do MOVA (porta + implementação em memória).
//
// Contrato: `guardar(bytes, {mime, nomeArquivo})` → {referencia, sha256, tamanhoBytes, repetido}; `obter(referencia)` → bytes.
// O mesmo conteúdo (sha256) é guardado uma vez só — é a base da idempotência por DOCUMENTO. Nada aqui loga conteúdo.
//
// A implementação durável é PENDENTE: bucket PRIVADO (mesmo padrão de fv2-integracao/cofreNotasSupabase.js), com
// antimalware ou aceite explícito do proprietário, e retenção definida. Enquanto isso, só memória (simulação/testes).
import { createHash } from "node:crypto";

export const METODOS_DAS_EVIDENCIAS = Object.freeze(["guardar", "obter"]);

export function criarEvidenciasMemoria() {
  const porSha = new Map();
  return {
    async guardar(bytes, { mime, nomeArquivo = null } = {}) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError("bytes inválidos");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const referencia = `evd_${sha256.slice(0, 32)}`;
      const repetido = porSha.has(sha256);
      if (!repetido) porSha.set(sha256, { referencia, mime, nomeArquivo, bytes: Buffer.from(bytes) });
      return { referencia, sha256, tamanhoBytes: bytes.length, repetido };
    },
    async obter(referencia) {
      for (const v of porSha.values()) if (v.referencia === referencia) return v.bytes;
      return null;
    },
    quantidade: () => porSha.size,
  };
}
