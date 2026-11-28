// MOVA — leitura DETERMINÍSTICA da nota fiscal do entregador (28/11/2026). Puro: nenhuma E/S, nenhuma IA.
// Ordem de preferência para obter os dados de uma nota: (1) o que já foi lido para o MESMO arquivo (cache por hash),
// (2) XML da NFS-e/NF-e, (3) texto do PDF do emissor nacional (leitor injetado), (4) IA em texto, (5) visão — só se as anteriores falharem.
// Aqui ficam o leitor de XML e a conversão de qualquer leitura para o formato que a conferência do MOVA entende.
import { FONTE, normalizarLeitura } from "./identidadeFiscal.js";
import { validarXmlSeguro } from "./xmlSeguro.js";

const tag = (xml, nome, de = 0) => {
  const m = new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, "i").exec(xml.slice(de));
  return m ? { valor: decodificar(m[1].trim()), fim: de + m.index + m[0].length, ini: de + m.index } : null;
};
const decodificar = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const bloco = (xml, nome) => { const t = tag(xml, nome); return t ? t.valor : null; };
const decimalParaCentavos = (t) => { const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(t ?? "").trim()); return m ? Number(`${m[1]}${(m[2] ?? "").padEnd(2, "0")}`) : null; };
const dataDe = (t) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(t ?? ""))?.[1] ?? null);

/** NFS-e nacional em XML (emit / toma / valores / nNFS / Id). Qualquer campo ausente vira null; layout irreconhecível ⇒ null. */
export function lerNotaXml(texto) {
  const xml = String(texto ?? "");
  if (xml.length > 2_000_000 || !/<(?:\w+:)?(?:NFSe|infNFSe|CompNfse|Nfse)\b/i.test(xml)) return null;
  const emit = bloco(xml, "emit");
  const toma = bloco(xml, "toma");
  if (!emit) return null;
  const doc = (b) => { const x = bloco(b ?? "", "CNPJ") ?? bloco(b ?? "", "CPF"); return x ? x.replace(/\D/g, "") : null; };
  const id = /<(?:\w+:)?infNFSe\b[^>]*\bId="NFS(\d{50})"/i.exec(xml)?.[1] ?? null;
  const valores = bloco(xml, "valores") ?? xml;
  return {
    modelo: "NFSE_XML",
    chaveAcesso: id,
    numero: bloco(xml, "nNFS") ?? bloco(xml, "Numero"),
    competencia: dataDe(bloco(xml, "dCompet")),
    emissao: dataDe(bloco(xml, "dhEmi") ?? bloco(xml, "dhProc")),
    codigoVerificacao: bloco(xml, "CodigoVerificacao"),
    prestador: { documento: doc(emit), nome: bloco(emit, "xNome"), nomeFantasia: bloco(emit, "xFant"), municipio: bloco(xml, "xLocEmi") ?? bloco(emit, "xMun") },
    tomador: toma ? { documento: doc(toma), nome: bloco(toma, "xNome") } : { documento: null, nome: null, naoIdentificado: true },
    valorCentavos: decimalParaCentavos(bloco(valores, "vServ") ?? bloco(valores, "vLiq")),
    periodo: null,
    descricao: bloco(xml, "xDescServ"),
  };
}

const mesDe = (iso) => (/^\d{4}-\d{2}/.test(iso ?? "") ? String(iso).slice(0, 7) : null);

/**
 * Converte a leitura bruta (DANFSe/XML) para o formato da conferência do MOVA (o mesmo que a IA devolve) + os campos fiscais extras.
 * Devolve null quando faltar o essencial (valor): quem chama cai para a próxima fonte, nunca inventa.
 */
export function leituraParaConferencia(bruta, fonte) {
  const l = normalizarLeitura(bruta, fonte);
  if (!l || l.valorCentavos === null) return null;
  return {
    tipoDocumento: "NOTA_FISCAL", legivel: true, confianca: "ALTA", fonte,
    valorCentavos: l.valorCentavos, competencia: mesDe(l.competencia ?? l.emissao), dataEmissao: l.emissao ?? null,
    favorecido: l.prestadorNome, pagador: bruta.tomador?.nome ?? null, documentoDestinatario: l.tomadorDocumento, identificadorDocumento: l.numero,
    prestadorDocumento: l.prestadorDocumento, nomeFantasia: l.nomeFantasia, municipio: l.municipio, chaveAcesso: l.chaveAcesso, codigoVerificacao: l.codigoVerificacao,
    periodo: l.periodo, tomadorNaoIdentificado: l.tomadorNaoIdentificado,
  };
}

/**
 * Leitura de uma nota SEM IA: tenta o XML e depois o leitor de PDF injetado (texto do PDF). `leitorPdf(bytes)` devolve a leitura bruta ou null.
 * @returns {{ leitura, fonte } | null}
 */
export function lerNotaSemIa({ bytes, mime, leitorPdf = null }) {
  try {
    if (/xml/i.test(String(mime ?? ""))) {
      const seguro = validarXmlSeguro(bytes);
      if (!seguro.ok) return null; // XML com DTD/entidade/instrução nunca é lido
      const b = lerNotaXml(seguro.texto);
      const l = b ? leituraParaConferencia(b, FONTE.XML) : null;
      return l ? { leitura: l, fonte: FONTE.XML } : null;
    }
    if (/pdf/i.test(String(mime ?? "")) && typeof leitorPdf === "function") {
      const b = leitorPdf(bytes);
      const l = b ? leituraParaConferencia(b, FONTE.PDF_TEXTO) : null;
      return l ? { leitura: l, fonte: FONTE.PDF_TEXTO } : null;
    }
  } catch { /* leitor falhou: cai para a próxima fonte */ }
  return null;
}
