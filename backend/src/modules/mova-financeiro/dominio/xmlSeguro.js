// MOVA — validação SEGURA de XML recebido (NFS-e). Puro: nenhuma E/S. O arquivo é conteúdo NÃO CONFIÁVEL e NUNCA passa por um
// interpretador de XML: o leitor da nota usa só busca textual por marcadores. Aqui se recusa tudo que poderia abusar de um parser
// (XXE, expansão de entidades "bilhão de risadas", DTD externa, folha de estilo, instrução de processamento) e o que não é texto.
export const XML_MAX_BYTES = 2_000_000;
export const MIMES_XML = Object.freeze(["application/xml", "text/xml"]);
export const mimeEhXml = (mime) => MIMES_XML.includes(String(mime ?? "").split(";")[0].trim().toLowerCase());

const PROIBIDOS = [
  [/<!DOCTYPE/i, "XML_COM_DTD"], [/<!ENTITY/i, "XML_COM_ENTIDADE"], [/<!ELEMENT|<!ATTLIST|<!NOTATION/i, "XML_COM_DTD"],
  [/<\?xml-stylesheet/i, "XML_COM_FOLHA_DE_ESTILO"], [/<!\[CDATA\[/i, "XML_COM_CDATA"], [/<\?(?!xml\s)/i, "XML_COM_INSTRUCAO"],
  [/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/i, "XML_COM_ENTIDADE_DESCONHECIDA"],
];

/** @returns {{ ok: true, texto: string } | { ok: false, motivo: string }} */
export function validarXmlSeguro(bytes) {
  if (!bytes || !bytes.length) return { ok: false, motivo: "XML_VAZIO" };
  if (bytes.length > XML_MAX_BYTES) return { ok: false, motivo: "XML_GRANDE" };
  if (bytes.includes(0)) return { ok: false, motivo: "XML_NAO_E_TEXTO" };
  let texto;
  try { texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, motivo: "XML_NAO_E_TEXTO" }; }
  texto = texto.replace(/^﻿/, "");
  for (const [r, motivo] of PROIBIDOS) if (r.test(texto)) return { ok: false, motivo };
  if (!/^\s*(?:<\?xml\s[^>]*\?>\s*)?<[A-Za-z_]/.test(texto)) return { ok: false, motivo: "XML_NAO_CONFERE" };
  const raiz = /<([A-Za-z_][\w.:-]*)[\s>/]/.exec(texto.replace(/^\s*<\?xml[^>]*\?>/, ""))?.[1];
  if (!raiz || !texto.trimEnd().endsWith(`</${raiz}>`)) return { ok: false, motivo: "XML_INCOMPLETO" };
  return { ok: true, texto };
}
