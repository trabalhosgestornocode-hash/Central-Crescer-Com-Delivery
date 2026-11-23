// UNIDADE PELO PAGADOR do comprovante (24/11) — o titular da CONTA DE ORIGEM identifica a unidade (ex.: o titular da conta do Açaí → Açaí,
// o da Subway → Subway). Regra explícita e auditável: os titulares de cada unidade moram no CADASTRO da unidade no MOVA
// (mova.grupo_unidade / mova.unidade_sem_grupo, coluna `pagadores`, migração 0015) — nunca no código.
//
// Garantias:
//   - só o campo PAGADOR (quem pagou) e o documento do pagador contam; favorecido, descrição e o resto do texto NUNCA identificam;
//   - nome: igualdade do nome NORMALIZADO (sem acento, maiúsculas, pontuação), com tolerância APENAS a sufixos societários
//     (LTDA, ME, EPP, EIRELI, S/A…) para nomes de 4+ caracteres. Nome curto (ex.: "MP") exige igualdade EXATA — "MP LTDA",
//     "MP PAGAMENTOS", "MERCADO PAGO" e "MP" dentro de outra palavra nunca casam;
//   - documento (CPF/CNPJ) do pagador: igualdade dos dígitos com um documento cadastrado; documento mascarado nunca conta;
//   - nome e documento apontando para unidades diferentes ⇒ CONFLITO (nada é gravado);
//   - a identificação NUNCA amplia acesso: quem decide se a conversa pode atuar na unidade é resolverUnidade (unidades do grupo/
//     da pessoa) e, na escrita, a concessão da identidade operacional naquela unidade.
import { normalizar, normalizarDocumento } from "./configuracao.js";

export const SUFIXOS_SOCIETARIOS = Object.freeze(["ltda", "me", "epp", "eireli", "sa", "s a", "slu", "mei", "ss"]);
/** Nomes com menos caracteres que isto (sem espaços) exigem igualdade exata (sem tolerância a sufixo). */
export const MINIMO_PARA_SUFIXO = 4;

/** Nome comparável: normalizado (configuracao.normalizar) e em maiúsculas para leitura nos registros. */
export const nomeDoPagador = (t) => normalizar(t);

function semSufixo(nome) {
  let n = ` ${nome} `;
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const s of SUFIXOS_SOCIETARIOS) {
      if (n.endsWith(` ${s} `) && n.trim() !== s) { n = n.slice(0, n.length - s.length - 1); mudou = true; }
    }
  }
  return n.trim();
}

/** O nome lido do comprovante corresponde ao nome cadastrado? (ambos já normalizados) */
export function nomeCorresponde(lido, cadastrado) {
  if (!lido || !cadastrado) return false;
  if (lido === cadastrado) return true;
  if (cadastrado.replace(/ /g, "").length < MINIMO_PARA_SUFIXO) return false; // "mp": só igualdade exata
  return semSufixo(lido) === semSufixo(cadastrado);
}

/** Documento completo (CPF 11 ou CNPJ 14 dígitos) — mascarado ("***.123.456-**") ou parcial nunca identifica. */
export function documentoUtil(t) {
  if (typeof t !== "string" || /[*xX•]/.test(t)) return "";
  const d = normalizarDocumento(t);
  return /^[0-9]{11}$|^[0-9]{14}$/.test(d) ? d : "";
}

/**
 * Valida a lista de pagadores de UMA unidade (cadastro). Cada item: { nome?: string, documento?: string } (ao menos um).
 * @returns {Readonly<{nomes:readonly string[], documentos:readonly string[]}>}
 */
export function validarPagadores(lista, { exigir, campo }) {
  exigir(lista === undefined || lista === null || Array.isArray(lista), campo);
  const nomes = new Set();
  const documentos = new Set();
  for (const [i, p] of (lista ?? []).entries()) {
    exigir(p && typeof p === "object" && !Array.isArray(p), `${campo}[${i}]`);
    for (const k of Object.keys(p)) exigir(["nome", "documento"].includes(k), `${campo}[${i}].${k}`);
    const nome = p.nome == null ? "" : nomeDoPagador(p.nome);
    const doc = p.documento == null ? "" : documentoUtil(String(p.documento));
    exigir(p.nome == null || (typeof p.nome === "string" && p.nome.length <= 120 && nome.length >= 2), `${campo}[${i}].nome`);
    exigir(p.documento == null || doc !== "", `${campo}[${i}].documento`);
    exigir(nome || doc, `${campo}[${i}]`);
    if (nome) nomes.add(nome);
    if (doc) documentos.add(doc);
  }
  return Object.freeze({ nomes: Object.freeze([...nomes]), documentos: Object.freeze([...documentos]) });
}

export const RESULTADO_PAGADOR = Object.freeze({
  SEM_EVIDENCIA: "SEM_EVIDENCIA",       // comprovante sem pagador cadastrado (ou sem pagador lido)
  IDENTIFICADA: "IDENTIFICADA",
  CONFLITO: "CONFLITO",                 // nome × documento (ou o mesmo pagador em duas unidades)
});

/**
 * Unidade dona do pagador lido (procura em TODAS as unidades configuradas: a decisão de acesso é de resolverUnidade).
 * @param {{unidades:readonly object[], pagador?:string|null, documentoPagador?:string|null}} p
 * @returns {{resultado:string, unidade:object|null, evidencia:string|null}}
 */
export function unidadePeloPagador({ unidades, pagador = null, documentoPagador = null }) {
  const nome = pagador ? nomeDoPagador(pagador) : "";
  const doc = documentoPagador ? documentoUtil(documentoPagador) : "";
  const porNome = nome ? unidades.filter((u) => (u.pagadores?.nomes ?? []).some((c) => nomeCorresponde(nome, c))) : [];
  const porDoc = doc ? unidades.filter((u) => (u.pagadores?.documentos ?? []).includes(doc)) : [];
  if (porNome.length > 1 || porDoc.length > 1) return { resultado: RESULTADO_PAGADOR.CONFLITO, unidade: null, evidencia: "PAGADOR_EM_VARIAS_UNIDADES" };
  const [n] = porNome;
  const [d] = porDoc;
  if (n && d && n.unidadeId !== d.unidadeId) return { resultado: RESULTADO_PAGADOR.CONFLITO, unidade: null, evidencia: "PAGADOR_NOME_X_DOCUMENTO" };
  if (d) return { resultado: RESULTADO_PAGADOR.IDENTIFICADA, unidade: d, evidencia: "DOCUMENTO_DO_PAGADOR" };
  if (n) return { resultado: RESULTADO_PAGADOR.IDENTIFICADA, unidade: n, evidencia: "TITULAR_DO_PAGADOR" };
  return { resultado: RESULTADO_PAGADOR.SEM_EVIDENCIA, unidade: null, evidencia: null };
}
