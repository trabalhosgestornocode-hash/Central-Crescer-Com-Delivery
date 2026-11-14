// Execução 08E — HOMOLOGAÇÃO COM RESSALVAS (decisão de produto F-1).
//
// Não se homologa direto do fechamento preliminar enquanto houver pendência que exige documentação e ainda não foi
// tratada. Uma pendência só vira RESSALVA admissível pelas suas propriedades — natureza e impacto conhecidos —, nunca
// pelo texto: descrição, justificativa e decisão são obrigatórias, mas sozinhas não tornam nada admissível.
//
// Sem política de materialidade quantitativa: nenhum valor é "pequeno demais para importar". O que decide é se o efeito
// da pendência no RESULTADO da competência é conhecido e CONSERVADOR: ressalva só para o que, no pior caso, deixa o
// resultado subestimado por um valor conhecido (receita possivelmente não registrada, até o valor da entrada). O que pode
// SUPERESTIMAR o resultado (saída sem vínculo = possível despesa não reconhecida; classificação provisória) bloqueia.
const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

/** Efeito da pendência no resultado (DRE) da competência. */
export const EFEITO_NO_RESULTADO = enumerar(
  "SEM_EFEITO", // o resultado registrado não muda: a pendência é de tesouraria, conferência cruzada ou documentação
  "CONHECIDO", // o efeito existe e está quantificado (valor conhecido) e tratado pela metodologia
  "INDETERMINADO", // pode distorcer o resultado de modo ainda não esclarecido: precisa ser RESOLVIDA, nunca ressalvada
);

const E = EFEITO_NO_RESULTADO;
/**
 * Natureza de cada pendência quanto ao resultado. Código desconhecido = INDETERMINADO (o lado seguro).
 * Esta tabela é uma decisão de produto registrada no doc 21 (§ 2); mudá-la exige revisão do responsável financeiro.
 */
export const EFEITO_POR_CODIGO = Object.freeze({
  // Tesouraria e conciliação: a receita/despesa da competência já está reconhecida; falta o dinheiro bater.
  VENDA_SEM_PAGAMENTO: E.SEM_EFEITO, PAGAMENTO_INCOMPATIVEL: E.SEM_EFEITO, RECEBIMENTO_DIRETO_NAO_IDENTIFICADO: E.SEM_EFEITO,
  RECEBIVEL_SEM_REPASSE: E.SEM_EFEITO, RECEBIVEL_ATRASADO: E.SEM_EFEITO, REPASSE_INFORMADO_SEM_CREDITO: E.SEM_EFEITO,
  CREDITO_SEM_COMPROVACAO_BANCARIA: E.SEM_EFEITO, CORRESPONDENCIA_A_DECIDIR: E.SEM_EFEITO, DIFERENCA_DE_CAIXA: E.SEM_EFEITO,
  VENDA_SEM_CANAL: E.SEM_EFEITO, IMPORTACAO_COM_PENDENCIAS: E.SEM_EFEITO,
  // Conferência cruzada incompleta: o relatório que falta não alimenta o resultado registrado, só a conferência dele.
  FONTE_SEM_DOCUMENTO: E.SEM_EFEITO,
  // Efeito conhecido e quantificado.
  OBRIGACAO_SEM_COMPROVANTE: E.CONHECIDO, // despesa reconhecida pelo valor da conta; falta o documento que a comprova
  // Execução 09 (revisão da matriz): crédito do processador MENOR que o esperado é taxa/perda fora da DRE — o resultado
  // fica SUPERESTIMADO. Não é ressalva: resolve-se registrando o ajuste (taxa) com evidência. Ver doc 22, § 7.
  TAXA_OU_VALOR_DIVERGENTE: E.INDETERMINADO,
  TOTAIS_DE_RELATORIOS_DIFERENTES: E.CONHECIDO, // só chega aqui JUSTIFICADA (aberta é bloqueio)
  // Entrada sem origem / transação sem pedido: no pior caso, receita não registrada ATÉ o valor (resultado subestimado,
  // nunca superestimado) — efeito limitado e conhecido.
  CREDITO_NAO_IDENTIFICADO: E.CONHECIDO, TRANSACAO_SEM_PEDIDO: E.CONHECIDO,
  // Pode distorcer o resultado de modo ainda não esclarecido.
  DESPESA_A_CLASSIFICAR: E.INDETERMINADO, DESCONTO_A_CLASSIFICAR: E.INDETERMINADO, SAIDA_SEM_CLASSIFICACAO: E.INDETERMINADO,
  PROPOSTA_EM_ABERTO: E.INDETERMINADO,
  IMPORTACAO_A_REVISAR: E.INDETERMINADO, SOBREPOSICAO_AGREGADO_PEDIDOS: E.INDETERMINADO, SALDO_DIVERGENTE: E.INDETERMINADO,
});
export const efeitoNoResultado = (codigo) => EFEITO_POR_CODIGO[codigo] ?? E.INDETERMINADO;

/** Situação de cada pendência diante do fechamento. */
export const SITUACAO_NO_FECHAMENTO = enumerar(
  "RESOLVIDA", // estava documentada e deixou de existir
  "DOCUMENTADA_ADMISSIVEL", // documentada e admissível como ressalva
  "BLOQUEANTE", // impede a homologação até ser resolvida (por natureza ou por impacto indeterminado)
  "SEM_EVIDENCIA_SUFICIENTE", // documentada, mas falta decisão, o que falta/evidência, ou o impacto mudou desde a documentação
  "NAO_DOCUMENTADA", // exige documentação e não foi documentada
  "NAO_EXIGE", // não bloqueia nem exige documentação (acompanhamento)
);
const S = SITUACAO_NO_FECHAMENTO;

const texto = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Avalia as pendências ATUAIS da competência contra as DOCUMENTADAS no fechamento.
 * @param {{pendencias:object[], documentadas:object[], impedimentos:object[]}} e
 */
export function avaliarPendenciasDoFechamento({ pendencias, documentadas = [], impedimentos = [] }) {
  const porChave = new Map(documentadas.filter((x) => x.chave).map((x) => [x.chave, x]));
  const itens = [];
  for (const p of pendencias) {
    if (p.situacao === "INFORMATIVA") continue;
    const efeito = efeitoNoResultado(p.codigo);
    const doc = porChave.get(p.chave) ?? null;
    const base = { chave: p.chave, codigo: p.codigo, titulo: p.titulo, grupo: p.grupo, efeitoNoFechamento: p.efeitoNoFechamento, efeitoNoResultado: efeito, valorCentavos: p.valorCentavos ?? null, documentada: Boolean(doc) };
    let situacao;
    let motivo;
    if (p.efeitoNoFechamento === "NAO_BLOQUEIA") { situacao = S.NAO_EXIGE; motivo = "Não altera o resultado nem exige documentação: fica em acompanhamento."; }
    else if (p.efeitoNoFechamento === "BLOQUEIA") { situacao = S.BLOQUEANTE; motivo = "Bloqueia a homologação por natureza: precisa ser resolvida."; }
    else if (efeito === E.INDETERMINADO) { situacao = S.BLOQUEANTE; motivo = "Pode distorcer o resultado de modo ainda não esclarecido: precisa ser resolvida, não ressalvada."; }
    else if (efeito === E.CONHECIDO && p.valorCentavos == null) { situacao = S.BLOQUEANTE; motivo = "O impacto no resultado ainda não é conhecido: precisa ser quantificado ou resolvido."; }
    else if (!doc) { situacao = S.NAO_DOCUMENTADA; motivo = "Exige documentação no fechamento antes de homologar."; }
    else if (!texto(doc.decisao)) { situacao = S.SEM_EVIDENCIA_SUFICIENTE; motivo = "Falta a decisão registrada sobre a pendência."; }
    else if (!texto(doc.documentacaoFaltante) && !(doc.evidenciaDocumentoIds?.length > 0)) { situacao = S.SEM_EVIDENCIA_SUFICIENTE; motivo = "Falta registrar o documento que falta ou anexar evidência."; }
    else if (efeito === E.CONHECIDO && doc.valorCentavos !== p.valorCentavos) { situacao = S.SEM_EVIDENCIA_SUFICIENTE; motivo = "O impacto mudou desde a documentação: documente de novo."; }
    else { situacao = S.DOCUMENTADA_ADMISSIVEL; motivo = efeito === E.CONHECIDO ? "Ressalva admissível: impacto conhecido e documentado." : "Ressalva admissível: não altera o resultado registrado."; }
    itens.push({ ...base, situacao, motivo, documentacao: doc });
  }
  const atuais = new Set(pendencias.map((p) => p.chave));
  const resolvidas = documentadas.filter((x) => x.chave && !atuais.has(x.chave)).map((x) => ({ chave: x.chave, codigo: x.codigo ?? null, titulo: x.titulo ?? x.descricao, situacao: S.RESOLVIDA, documentacao: x }));
  const de = (s) => itens.filter((x) => x.situacao === s);
  const ressalvas = de(S.DOCUMENTADA_ADMISSIVEL);
  const impeditivas = [...de(S.BLOQUEANTE), ...de(S.NAO_DOCUMENTADA), ...de(S.SEM_EVIDENCIA_SUFICIENTE)];
  const motivos = [];
  if (impedimentos.length) motivos.push(`${impedimentos.length} impedimento(s) do núcleo sem resolução comprovada.`);
  if (de(S.BLOQUEANTE).length) motivos.push(`${de(S.BLOQUEANTE).length} pendência(s) bloqueante(s): precisam ser resolvidas.`);
  if (de(S.NAO_DOCUMENTADA).length) motivos.push(`${de(S.NAO_DOCUMENTADA).length} pendência(s) que exigem documentação ainda não documentada(s).`);
  if (de(S.SEM_EVIDENCIA_SUFICIENTE).length) motivos.push(`${de(S.SEM_EVIDENCIA_SUFICIENTE).length} pendência(s) documentada(s) sem decisão ou evidência suficiente.`);
  const limpo = impedimentos.length === 0 && impeditivas.length === 0;
  return {
    itens, resolvidas, ressalvas, impeditivas, motivos,
    contagem: Object.fromEntries(Object.values(S).map((s) => [s, s === S.RESOLVIDA ? resolvidas.length : de(s).length])),
    // Preliminar → homologada: nada impeditivo E nada a ressalvar (ressalvas passam por "com pendências documentadas").
    semRessalvas: limpo && ressalvas.length === 0,
    // Com pendências documentadas → homologada: nada impeditivo; as admissíveis viram ressalvas guardadas na versão.
    comRessalvas: limpo,
    // Preliminar → "com pendências documentadas" (08E, achado da jornada): o estado só vale quando TUDO o que resta são
    // ressalvas admissíveis. Nada por documentar, nada insuficiente, nenhuma bloqueante, nenhum impedimento — o estado
    // não serve para "estacionar" pendências não tratadas (e nele as escritas viram correção auditada).
    podeRegistrarComPendencias: limpo && ressalvas.length > 0,
  };
}

/** Ressalva como fica guardada na competência e na versão homologada (retrato; não muda depois). */
export const ressalvaGuardada = (x) => ({
  chave: x.chave, codigo: x.codigo, titulo: x.titulo, efeitoNoResultado: x.efeitoNoResultado, valorCentavos: x.valorCentavos,
  decisao: x.documentacao?.decisao ?? null, documentacaoFaltante: x.documentacao?.documentacaoFaltante ?? null,
  evidenciaDocumentoIds: x.documentacao?.evidenciaDocumentoIds ?? [], responsavelId: x.documentacao?.responsavelId ?? null,
  documentadaEm: x.documentacao?.documentadaEm ?? null, documentadaPor: x.documentacao?.documentadaPor ?? null,
});
