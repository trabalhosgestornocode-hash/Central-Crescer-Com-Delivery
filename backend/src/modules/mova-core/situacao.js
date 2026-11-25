// MOVA CORE — SITUAÇÃO DA CONSULTA (pedido de 24/11, §3). Toda resposta de ferramenta diz, de forma ESTRUTURADA, o que ela é:
//   COMPLETA        consulta completa com registros (valores podem ser citados);
//   VALOR_ZERO      consulta completa, há registros e o valor é realmente zero (ex.: conta quitada) — "não falta nada";
//   SEM_REGISTROS   consulta completa, nenhum registro encontrado — "não encontrei", NUNCA "R$ 0,00" como se fosse um gasto;
//   PARCIAL         só parte do pedido foi consultada (unidade sem permissão, mês sem dado, leitura cortada) — nunca total;
//   BLOQUEADO       permissão/perfil/escopo impede — dizer que não pode mostrar, sem valor e sem "zero";
//   FALHA_TECNICA   o sistema não respondeu — "não consegui consultar agora", nunca zero nem "não existe";
//   NAO_CALCULAVEL  o indicador não existe/não foi apurado com os dados e regras da unidade — não estimar;
//   INDISPONIVEL    o MOVA não tem acesso a essa informação (ferramenta/módulo fora do alcance desta conversa).
// O código decide a situação; o modelo só a comunica. O verificador reprova "R$ 0,00" apoiado só em soma de lista vazia.

export const SITUACAO = Object.freeze({
  COMPLETA: "COMPLETA", VALOR_ZERO: "VALOR_ZERO", SEM_REGISTROS: "SEM_REGISTROS", PARCIAL: "PARCIAL", BLOQUEADO: "BLOQUEADO",
  FALHA_TECNICA: "FALHA_TECNICA", NAO_CALCULAVEL: "NAO_CALCULAVEL", INDISPONIVEL: "INDISPONIVEL",
});

/** Como comunicar cada situação (vai junto do resultado da ferramenta; é orientação, não texto pronto). */
export const COMO_COMUNICAR = Object.freeze({
  COMPLETA: null,
  VALOR_ZERO: "Há registros e o valor é realmente zero: diga que não falta nada / está quitado.",
  SEM_REGISTROS: "A consulta foi completa e NÃO encontrou registros: diga que não encontrou (e o que foi buscado). Não apresente R$ 0,00 como valor gasto, pago ou devido.",
  PARCIAL: "Só parte do pedido foi consultada: diga o que ficou de fora e não apresente a soma como total.",
  BLOQUEADO: "Sem permissão para isso nesta conversa: diga que não pode mostrar. Não informe valores nem zero.",
  FALHA_TECNICA: "O sistema não respondeu: diga que não conseguiu consultar agora e sugira tentar de novo. Não diga que é zero nem que não existe.",
  NAO_CALCULAVEL: "Esse indicador não está apurado para essa unidade/período: diga que não dá para informar. Não estime.",
  INDISPONIVEL: "O MOVA não alcança essa informação nesta conversa: diga isso e, se houver, onde a pessoa encontra.",
});

const POR_CODIGO = Object.freeze({
  SEM_PERMISSAO: "BLOQUEADO", SEM_PERMISSAO_PARA_VALORES: "BLOQUEADO", FORA_DO_ESCOPO: "BLOQUEADO", SEM_ACESSO: "BLOQUEADO",
  FINANCEIRO_INDISPONIVEL: "FALHA_TECNICA", FALHA_INTERNA_DA_FERRAMENTA: "FALHA_TECNICA", TEMPO_ESGOTADO: "FALHA_TECNICA", PLATAFORMA_INDISPONIVEL: "FALHA_TECNICA",
  NAO_ENCONTRADO_OU_INVALIDO: "SEM_REGISTROS",
  FERRAMENTA_DESCONHECIDA: "INDISPONIVEL", MODULO_INDISPONIVEL: "INDISPONIVEL", CMV_NAO_VALIDADO: "NAO_CALCULAVEL", CALCULO_INVALIDO: "NAO_CALCULAVEL",
});
/** Situação de uma FALHA da ferramenta (código do executor/ferramenta); argumentos/limites não são situação de dado (null). */
export const situacaoDoCodigo = (codigo) => POR_CODIGO[codigo] ?? null;

const LISTAS = ["itens", "linhas", "contas", "entregadores", "semanas", "periodos", "dias", "titulos", "pagamentos", "unidades", "resultados", "trechos"];
/** Conta registros nas listas conhecidas do resultado (nível de cima e um nível abaixo). null = o resultado não é uma listagem. */
export function contarRegistros(dados) {
  if (!dados || typeof dados !== "object") return null;
  let achou = false; let n = 0;
  const olhar = (o) => { for (const k of LISTAS) if (Array.isArray(o?.[k])) { achou = true; n += o[k].length; } };
  olhar(dados);
  for (const v of Object.values(dados)) if (v && typeof v === "object" && !Array.isArray(v)) olhar(v);
  const total = dados.paginacao?.total ?? dados.total;
  if (Number.isInteger(total)) { achou = true; n = Math.max(n, total); }
  return achou ? n : null;
}

/**
 * Situação de um resultado bem-sucedido. A ferramenta pode declarar (r.situacao); senão, o código deduz:
 * cobertura incompleta ⇒ PARCIAL; listagem vazia ⇒ SEM_REGISTROS; há registros e todos os fatos monetários são zero ⇒ VALOR_ZERO.
 */
export function situacaoDoResultado(r) {
  if (r?.situacao && SITUACAO[r.situacao]) return r.situacao;
  const d = r?.dados ?? {};
  if (d.cobertura && d.cobertura.completa === false) return SITUACAO.PARCIAL;
  const n = contarRegistros(d);
  const monetarios = (r?.fatos ?? []).filter((f) => Number.isInteger(f?.valorCentavos));
  if (n === 0) return SITUACAO.SEM_REGISTROS;
  if (n !== null && monetarios.length && monetarios.every((f) => f.valorCentavos === 0)) return SITUACAO.VALOR_ZERO;
  return SITUACAO.COMPLETA;
}

/** Fatos de uma consulta SEM REGISTROS: o zero de uma soma vazia não é um valor afirmável (o verificador reprova). */
export function marcarFatos(fatos, situacao) {
  if (situacao !== SITUACAO.SEM_REGISTROS) return fatos;
  return (fatos ?? []).map((f) => (f && f.valorCentavos === 0 ? { ...f, semRegistros: true } : f));
}
