// EVIDÊNCIAS ENVIADAS PELA INTERFACE (Execução 08D) — regras PURAS de formato. Nenhum acesso a disco ou banco.
//
// O arquivo vem do navegador e NADA nele é confiável: nem o nome, nem a extensão, nem o tipo declarado. Só entra o que
// o conteúdo comprova (assinatura binária) e que bate com o tipo e a extensão declarados. O nome nunca vira caminho:
// o cofre endereça pelo SHA-256; o nome higienizado serve só para a pessoa reconhecer o documento.
import { CODIGO, falhar } from "./erros.js";

/** Formatos aceitos como evidência. Executáveis, scripts, HTML, SVG e compactados nunca entram. */
export const FORMATOS_DE_EVIDENCIA = Object.freeze({
  "application/pdf": Object.freeze({ nome: "PDF", extensoes: Object.freeze([".pdf"]), assinatura: Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]) }),
  "image/png": Object.freeze({ nome: "Imagem PNG", extensoes: Object.freeze([".png"]), assinatura: Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
  "image/jpeg": Object.freeze({ nome: "Imagem JPEG", extensoes: Object.freeze([".jpg", ".jpeg"]), assinatura: Object.freeze([0xff, 0xd8, 0xff]) }),
});
export const TAMANHO_MAXIMO_DE_EVIDENCIA = 10 * 1024 * 1024; // 10 MiB por arquivo enviado pela tela

/** Nome de exibição seguro: só o último trecho, sem caracteres de controle nem separadores; nunca usado como caminho. */
export function nomeSeguro(nome) {
  if (typeof nome !== "string" || !nome.trim()) falhar(CODIGO.DOCUMENTO_INVALIDO, "Nome de arquivo ausente.", { campo: "nomeArquivo" });
  const base = nome.split(/[\\/]/).pop().normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base || base === "." || base === "..") falhar(CODIGO.DOCUMENTO_INVALIDO, "Nome de arquivo inválido.", { campo: "nomeArquivo" });
  const limpo = base.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(-100);
  const m = /(\.[a-z0-9]{2,5})$/i.exec(limpo);
  return { nome: limpo, extensao: m ? m[1].toLowerCase() : "" };
}

/** Confere tipo declarado × extensão × conteúdo. Devolve o formato e se o PDF tem conteúdo ativo (só download). */
export function exigirFormatoDeEvidencia({ conteudo, tipoMime, nomeArquivo }) {
  if (!(conteudo instanceof Uint8Array) || conteudo.byteLength === 0) falhar(CODIGO.DOCUMENTO_INVALIDO, "Arquivo vazio.");
  if (conteudo.byteLength > TAMANHO_MAXIMO_DE_EVIDENCIA) falhar(CODIGO.DOCUMENTO_INVALIDO, "Arquivo maior que o limite de 10 MiB.", { limiteBytes: TAMANHO_MAXIMO_DE_EVIDENCIA });
  const formato = FORMATOS_DE_EVIDENCIA[tipoMime];
  if (!formato) falhar(CODIGO.DOCUMENTO_INVALIDO, "Formato não aceito como evidência: envie PDF, PNG ou JPEG.", { tipoMime: String(tipoMime).slice(0, 60) });
  const { nome, extensao } = nomeSeguro(nomeArquivo);
  if (!formato.extensoes.includes(extensao)) falhar(CODIGO.DOCUMENTO_INVALIDO, "A extensão do arquivo não corresponde ao tipo informado.", { extensao });
  if (formato.assinatura.some((byte, i) => conteudo[i] !== byte)) {
    falhar(CODIGO.DOCUMENTO_INVALIDO, "O conteúdo do arquivo não corresponde ao tipo informado (assinatura do formato ausente).");
  }
  let conteudoAtivo = false;
  if (tipoMime === "application/pdf") {
    const texto = new TextDecoder("latin1").decode(conteudo);
    conteudoAtivo = /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(texto);
  }
  return { formato: formato.nome, tipoMime, nome, extensao, tamanhoBytes: conteudo.byteLength, conteudoAtivo };
}
