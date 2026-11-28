// LEITOR da NFS-e no layout nacional (DANFSe v2.0, emissor nacional / "Prestador NFS-e MEI"). Puro: recebe as LINHAS de texto
// do PDF (formatos/pdf.js) e devolve os dados que a pessoa digitaria ao anexar a nota. Não valida a nota fiscalmente: um PDF
// não comprova validade sozinho; a conferência e a aprovação continuam humanas. Layout desconhecido → null (nada é inventado).

const somenteDigitos = (t) => String(t ?? "").replace(/\D/g, "");
const formatarCnpj = (d) => (d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : null);
const dataIso = (br) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br ?? ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
/** "R$ 1.234,56" → 123456 (inteiro, sem ponto flutuante). */
export function centavosDeTexto(t) {
  const m = /R\$\s*([\d.]+),(\d{2})\b/.exec(t ?? "");
  return m ? Number(`${m[1].replace(/\./g, "")}${m[2]}`) : null; // reais e centavos concatenados: inteiro, sem multiplicação
}

/** Linha imediatamente depois da linha que contém o rótulo (o DANFSe imprime rótulos numa linha e valores na seguinte). */
const depoisDe = (linhas, rotulo, desde = 0) => {
  const i = linhas.findIndex((l, k) => k >= desde && l.toUpperCase().includes(rotulo));
  return i >= 0 && i + 1 < linhas.length ? { linha: linhas[i + 1], indice: i + 1 } : null;
};

/** CNPJ/CPF no começo da linha, tolerando os espaços que o PDF insere ("63.208.897/0001- 63"). */
const documentoNoInicio = (linha) => {
  const m = /^\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\s?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\s?\d{2})(?!\d)/.exec(linha ?? "");
  const d = somenteDigitos(m?.[1]);
  return d.length === 14 || d.length === 11 ? d : null;
};

/** "63.208.897 FULANO DE TAL Teresina / PI 22.11001 / ..." → "FULANO DE TAL" (sem o prefixo do CNPJ do MEI e sem o município). */
const nomeDaParte = (linha) => {
  const t = String(linha ?? "").replace(/^\s*\d{2}\.\d{3}\.\d{3}\s+(?=\D)/, "");
  // O nome vem em MAIÚSCULAS; o município, com só a inicial maiúscula, seguido de "/ UF" e do código IBGE.
  const m = /^(.*?)\s+[A-ZÀ-Ú][a-zà-ú]+(?:\s[A-Za-zÀ-ú]+)*\s\/\s[A-Z]{2}\s/.exec(t);
  return (m ? m[1] : t).trim() || null;
};

/**
 * @param {string[]} linhas linhas de texto de todas as páginas, na ordem
 * @returns {null | { modelo, chaveAcesso, numero, competencia, emissao, prestador:{documento, nome}, tomador:{documento, nome}, valorCentavos, valorLiquidoCentavos, periodo:{inicio, fim}|null, descricao }}
 */
export function lerNotaDeServico(linhas) {
  const ls = (linhas ?? []).map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  const texto = ls.join("\n");
  if (!/DANFSe/i.test(texto) || !/CHAVE DE ACESSO DA NFS/i.test(texto)) return null;
  const chave = depoisDe(ls, "CHAVE DE ACESSO DA NFS");
  const chaveAcesso = /^\d{50}$/.test(somenteDigitos(chave?.linha)) ? somenteDigitos(chave.linha) : (/\b(\d{50})\b/.exec(texto)?.[1] ?? null);
  const ident = depoisDe(ls, "NÚMERO DA NFS");
  const mId = /^(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/.exec(ident?.linha ?? "");
  const prest = depoisDe(ls, "PRESTADOR / FORNECEDOR");
  const nomePrest = prest ? depoisDe(ls, "NOME / NOME EMPRESARIAL", prest.indice) : null;
  const tom = depoisDe(ls, "TOMADOR / ADQUIRENTE");
  const nomeTom = tom ? depoisDe(ls, "NOME / NOME EMPRESARIAL", tom.indice) : null;
  const total = depoisDe(ls, "VALOR TOTAL DA NFS");
  const liquido = depoisDe(ls, "VALOR LÍQUIDO DA NFS");
  const descricao = depoisDe(ls, "DESCRIÇÃO DO SERVIÇO")?.linha ?? null;
  // Período escrito à mão pelo MEI: "09/11/2026 a 15/11/2026", "02/11 a 08/11", "15/112026"… O ano ausente vem da competência.
  const per = /(\d{2})\/(\d{2})(?:\/(\d{4}))?\D{1,20}?(\d{2})\/(\d{2})(?:\/?(\d{4}))?/.exec(descricao ?? "");
  const ano = (dataIso(mId?.[2]) ?? dataIso(mId?.[3]) ?? "").slice(0, 4) || null;
  const docPrest = documentoNoInicio(prest?.linha);
  const docTom = documentoNoInicio(tom?.linha);
  const valorCentavos = centavosDeTexto(total?.linha);
  const liquidoTxt = liquido?.linha ? [...liquido.linha.matchAll(/R\$\s*[\d.]+,\d{2}/g)].map((x) => x[0]) : [];
  return {
    modelo: "DANFSE_NACIONAL",
    chaveAcesso,
    numero: mId?.[1] ?? null,
    competencia: dataIso(mId?.[2]),
    emissao: dataIso(mId?.[3]),
    prestador: { documento: docPrest ? formatarCnpj(docPrest) : null, nome: nomeDaParte(nomePrest?.linha) },
    tomador: /TOMADOR\s*\/\s*ADQUIRENTE DA OPERA\S* N\S*O IDENTIFICADO/i.test(texto)
      ? { documento: null, nome: null, naoIdentificado: true }
      : { documento: docTom ? formatarCnpj(docTom) : null, nome: nomeDaParte(nomeTom?.linha) },
    valorCentavos,
    valorLiquidoCentavos: liquidoTxt.length ? centavosDeTexto(liquidoTxt[0]) : null,
    periodo: per ? { inicio: `${per[3] ?? ano}-${per[2]}-${per[1]}`, fim: `${per[6] ?? per[3] ?? ano}-${per[5]}-${per[4]}` } : null,
    descricao,
  };
}

/** Texto curto para os campos da nota ("NOME (CNPJ)"). */
export const parteComoTexto = (p) => (p?.nome ? `${p.nome}${p.documento ? ` (${p.documento})` : ""}` : p?.documento ?? null);

// ── NFS-e em XML (padrão nacional) ──────────────────────────────────────────────────────────────────────────────
// O XML é conteúdo NÃO CONFIÁVEL: nunca passa por um interpretador de XML. Aceita-se só texto sem DTD, entidade, CDATA, folha de
// estilo ou instrução de processamento; a leitura é por busca textual de marcadores (sem expansão, sem rede, sem arquivos).
export const XML_LIMITE_BYTES = 2_000_000;
const XML_PROIBIDO = [[/<!DOCTYPE/i, "XML_COM_DTD"], [/<!ENTITY/i, "XML_COM_ENTIDADE"], [/<!ELEMENT|<!ATTLIST|<!NOTATION/i, "XML_COM_DTD"], [/<\?xml-stylesheet/i, "XML_COM_FOLHA_DE_ESTILO"],
  [/<!\[CDATA\[/i, "XML_COM_CDATA"], [/<\?(?!xml\s)/i, "XML_COM_INSTRUCAO"], [/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/i, "XML_COM_ENTIDADE_DESCONHECIDA"]];

/** @returns {{ ok: true, texto: string } | { ok: false, motivo: string }} */
export function validarXmlDeNota(bytes) {
  if (!bytes || !bytes.length) return { ok: false, motivo: "XML_VAZIO" };
  if (bytes.length > XML_LIMITE_BYTES) return { ok: false, motivo: "XML_GRANDE" };
  if (bytes.includes(0)) return { ok: false, motivo: "XML_NAO_E_TEXTO" };
  let texto;
  try { texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, motivo: "XML_NAO_E_TEXTO" }; }
  texto = texto.replace(/^﻿/, "");
  for (const [r, motivo] of XML_PROIBIDO) if (r.test(texto)) return { ok: false, motivo };
  if (!/^\s*(?:<\?xml\s[^>]*\?>\s*)?<[A-Za-z_]/.test(texto)) return { ok: false, motivo: "XML_NAO_CONFERE" };
  const raiz = /<([A-Za-z_][\w.:-]*)[\s>/]/.exec(texto.replace(/^\s*<\?xml[^>]*\?>/, ""))?.[1];
  if (!raiz || !texto.trimEnd().endsWith(`</${raiz}>`)) return { ok: false, motivo: "XML_INCOMPLETO" };
  return { ok: true, texto };
}

const xmlTag = (xml, nome) => {
  const m = new RegExp(String.raw`<(?:\w+:)?${nome}(?:\s[^>]*)?>([\s\S]*?)</(?:\w+:)?${nome}>`, "i").exec(xml);
  return m ? m[1].trim().replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : null;
};
const xmlCentavos = (t) => { const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(t ?? "").trim()); return m ? Number(`${m[1]}${(m[2] ?? "").padEnd(2, "0")}`) : null; };
const xmlData = (t) => /^(\d{4}-\d{2}-\d{2})/.exec(String(t ?? ""))?.[1] ?? null;

/** Lê a NFS-e nacional em XML no MESMO formato de `lerNotaDeServico` (PDF); layout irreconhecível ⇒ null. */
export function lerNotaDeXml(bytes) {
  const v = validarXmlDeNota(bytes);
  if (!v.ok) return null;
  const xml = v.texto;
  if (!/<(?:\w+:)?(?:NFSe|infNFSe|CompNfse|Nfse)\b/i.test(xml)) return null;
  const emit = xmlTag(xml, "emit");
  if (!emit) return null;
  const toma = xmlTag(xml, "toma");
  const doc = (b) => { const x = xmlTag(b ?? "", "CNPJ") ?? xmlTag(b ?? "", "CPF"); const d = somenteDigitos(x); return d ? formatarCnpj(d) : null; };
  const valores = xmlTag(xml, "valores") ?? xml;
  const competencia = xmlData(xmlTag(xml, "dCompet"));
  return {
    modelo: "NFSE_XML",
    chaveAcesso: /<(?:\w+:)?infNFSe\b[^>]*\bId="NFS(\d{50})"/i.exec(xml)?.[1] ?? null,
    numero: xmlTag(xml, "nNFS") ?? xmlTag(xml, "Numero"),
    competencia,
    emissao: xmlData(xmlTag(xml, "dhEmi") ?? xmlTag(xml, "dhProc")),
    prestador: { documento: doc(emit), nome: xmlTag(emit, "xNome") },
    tomador: toma ? { documento: doc(toma), nome: xmlTag(toma, "xNome") } : { documento: null, nome: null, naoIdentificado: true },
    valorCentavos: xmlCentavos(xmlTag(valores, "vServ") ?? xmlTag(valores, "vLiq")),
    valorLiquidoCentavos: xmlCentavos(xmlTag(valores, "vLiq")),
    periodo: null,
    descricao: xmlTag(xml, "xDescServ"),
  };
}
