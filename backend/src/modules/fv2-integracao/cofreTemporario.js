// doc 37 — COFRE TEMPORÁRIO para importar SEM GUARDAR o arquivo (o cofre documental de verdade segue desligado enquanto não
// houver verificação antimalware). O arquivo vive só na MEMÓRIA do processo, pelo tempo de revisar a prévia e confirmar
// (padrão 30 minutos), com limite por arquivo e total; nunca vai a disco, banco ou rede. O que fica registrado é só a
// impressão digital (SHA-256), o tamanho e as linhas extraídas pela importação. Mesma porta de contratos/cofre.js.
// Arquivo expirado ou de outro escopo responde igual: "envie de novo" (o mesmo arquivo cai na mesma importação).
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../financeiro-v2/dominio/erros.js";
import { ehUuid } from "../financeiro-v2/dominio/validacao.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const TIPO_MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,90}$/;
export const LIMITE_POR_ARQUIVO_BYTES = 5 * 1024 * 1024;
const LIMITE_TOTAL_BYTES = 40 * 1024 * 1024;
const VALIDADE_MS = 30 * 60 * 1000;

const chaveDoEscopo = (escopo) => {
  if (!ehUuid(escopo?.organizacaoId) || !ehUuid(escopo?.unidadeId)) falhar(CODIGO.CONTEXTO_INVALIDO, "O cofre exige organização e unidade.");
  return `${escopo.organizacaoId.toLowerCase()}|${escopo.unidadeId.toLowerCase()}`;
};

/** @param {{validadeMs?: number, limitePorArquivo?: number, limiteTotal?: number, agora?: () => number}} [opcoes] */
export function criarCofreTemporario({ validadeMs = VALIDADE_MS, limitePorArquivo = LIMITE_POR_ARQUIVO_BYTES, limiteTotal = LIMITE_TOTAL_BYTES, agora = () => Date.now() } = {}) {
  /** chave escopo|arquivoId → { conteudo, hashSha256, tipoMime, expiraEm } (ordem de inserção = mais antigo primeiro) */
  const itens = new Map();
  let total = 0;
  const descartar = (k) => { const x = itens.get(k); if (x) { total -= x.conteudo.byteLength; itens.delete(k); } };
  const limparVencidos = () => { const t = agora(); for (const [k, x] of itens) if (x.expiraEm <= t) descartar(k); };

  return Object.freeze({
    semGuarda: true,
    async guardar(escopo, entrada) {
      const e = chaveDoEscopo(escopo);
      limparVencidos();
      const conteudo = entrada?.conteudo;
      if (!(conteudo instanceof Uint8Array) || conteudo.byteLength === 0 || conteudo.byteLength > limitePorArquivo) {
        falhar(CODIGO.DOCUMENTO_INVALIDO, `Arquivo vazio ou maior que ${Math.floor(limitePorArquivo / 1048576)} MiB.`);
      }
      if (typeof entrada.tipoMime !== "string" || !TIPO_MIME.test(entrada.tipoMime)) falhar(CODIGO.DOCUMENTO_INVALIDO, "Tipo de arquivo inválido.");
      const hashSha256 = sha256(conteudo);
      const arquivoId = `cofre:${hashSha256}`;
      const k = `${e}|${arquivoId}`;
      const repetido = itens.has(k);
      descartar(k);
      while (itens.size && total + conteudo.byteLength > limiteTotal) descartar(itens.keys().next().value);
      itens.set(k, { conteudo: Uint8Array.from(conteudo), hashSha256, tipoMime: entrada.tipoMime, expiraEm: agora() + validadeMs });
      total += conteudo.byteLength;
      return { arquivoId, hashSha256, tamanhoBytes: conteudo.byteLength, repetido, semGuarda: true };
    },
    async ler(escopo, arquivoId) {
      limparVencidos();
      const x = itens.get(`${chaveDoEscopo(escopo)}|${arquivoId}`);
      if (!x) falhar(CODIGO.NAO_ENCONTRADO, "O arquivo não fica guardado: envie o mesmo arquivo de novo (cai na mesma importação) e confirme em seguida.");
      if (sha256(x.conteudo) !== x.hashSha256) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo em memória não confere com o hash registrado.");
      return { conteudo: Uint8Array.from(x.conteudo), hashSha256: x.hashSha256, tamanhoBytes: x.conteudo.byteLength, tipoMime: x.tipoMime };
    },
    async existe(escopo, arquivoId) {
      limparVencidos();
      return itens.has(`${chaveDoEscopo(escopo)}|${arquivoId}`);
    },
    async inventario() { return []; },
    async limparTemporarios() { const antes = itens.size; limparVencidos(); return antes - itens.size; },
  });
}
