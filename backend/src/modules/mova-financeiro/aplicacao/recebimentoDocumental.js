// Agente 2 — RECEBIMENTO DE DOCUMENTOS SEM IA (MOVA_OPERACAO_DOCUMENTOS_SEM_IA=1).
// O arquivo NÃO é lido (nem por IA, nem por extrator): é conferido (formato, tamanho, integridade), guardado em privado no banco do
// MOVA (mova.evidencia, já deduplicado por sha256 no recebimento) e registrado como "aguardando conferência" para a revisão humana
// na Central de Operações. Nada é criado no Financeiro: sem proposta, sem baixa, sem alteração de obrigação.
// O arquivo é conteúdo NÃO CONFIÁVEL: só os bytes iniciais e marcadores de conteúdo ativo de PDF são examinados; nada é
// interpretado, renderizado nem executado no servidor.
import { createHash } from "node:crypto";

/** Só PDF e imagens no recebimento sem leitura (áudio fica de fora: sem transcrição não há o que conferir). */
export const MIMES_SEM_LEITURA = Object.freeze(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
export const MODO_SEM_LEITURA = "SEM_LEITURA";
export const ESTADO_CONFERENCIA = Object.freeze({ AGUARDANDO: "AGUARDANDO_CONFERENCIA", REVISADO: "REVISADO", ENCAMINHADO: "ENCAMINHADO" });
export const TIPOS_INFORMADOS = Object.freeze(["COMPROVANTE", "BOLETO", "NOTA_FISCAL", "RECIBO", "OUTRO"]);
const LEGENDA_MAX = 300;

const comeca = (b, ...bytes) => bytes.every((x, i) => b[i] === x);
/** Assinatura dos bytes iniciais confere com o tipo declarado (um .exe renomeado para .pdf não passa). */
export function formatoConfere(bytes, mime) {
  if (!bytes || bytes.length < 12) return false;
  if (mime === "application/pdf") return comeca(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
  if (mime === "image/jpeg") return comeca(bytes, 0xff, 0xd8, 0xff);
  if (mime === "image/png") return comeca(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === "image/webp") return comeca(bytes, 0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return false;
}

// PDF com JavaScript, ação de abrir programa ou arquivo embutido não é comprovante bancário: recusado sem abrir.
const PDF_ATIVO = [/\/JavaScript\b/, /\/JS\b/, /\/Launch\b/, /\/EmbeddedFiles?\b/, /\/RichMedia\b/, /\/XFA\b/];
export function pdfComConteudoAtivo(bytes) {
  const texto = Buffer.from(bytes).toString("latin1");
  return PDF_ATIVO.some((r) => r.test(texto));
}

/** Confere o arquivo GUARDADO (não o que veio na mensagem): integridade com o sha256 registrado, formato e conteúdo ativo. */
export function conferirArquivo({ bytes, sha256, mime }) {
  if (!MIMES_SEM_LEITURA.includes(mime)) return { ok: false, motivo: "FORMATO_NAO_ACEITO" };
  if (!bytes || bytes.length === 0) return { ok: false, motivo: "ARQUIVO_NAO_GUARDADO" };
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return { ok: false, motivo: "ARQUIVO_NAO_CONFERE" };
  if (!formatoConfere(bytes, mime)) return { ok: false, motivo: "FORMATO_NAO_CONFERE" };
  if (mime === "application/pdf" && pdfComConteudoAtivo(bytes)) return { ok: false, motivo: "PDF_COM_CONTEUDO_ATIVO" };
  return { ok: true };
}

/** Legenda da mensagem (entrada não confiável): só para a revisão humana; sem o acionamento "MOVA". */
export function legendaDoDocumento(texto) {
  const t = String(texto ?? "").replace(/^\s*@?mova\b[\s,:;.!-]*/i, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, LEGENDA_MAX) : null;
}

export const RESPOSTA_DOCUMENTO = Object.freeze({
  recebido: (unidade) => `Documento recebido e registrado para conferência no Financeiro do ${unidade}. Ainda não foi identificado nem conciliado automaticamente. Nada foi pago, baixado ou alterado.`,
  formatoNaoAceito: () => "Por enquanto recebo só PDF ou foto (JPG, PNG ou WEBP) de comprovantes, boletos, notas e recibos. Nada foi registrado.",
  naoConfere: () => "Não consegui conferir este arquivo (o conteúdo não corresponde ao formato). Envie de novo o PDF ou a foto original. Nada foi registrado.",
  conteudoAtivo: () => "Este PDF tem conteúdo ativo (script ou arquivo embutido) e não foi aceito. Envie o PDF original do banco ou uma foto do documento. Nada foi registrado.",
  jaRecebido: () => "Este mesmo arquivo já foi recebido antes e está registrado para conferência. Não registrei de novo.",
  falhaAoRegistrar: () => "Não consegui registrar o documento agora. Envie de novo em alguns minutos. Nada foi registrado.",
});
