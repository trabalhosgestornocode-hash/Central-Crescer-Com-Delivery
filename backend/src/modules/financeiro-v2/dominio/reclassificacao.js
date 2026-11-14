// RECLASSIFICAÇÃO FINANCEIRA (Execução 08C) — regras PURAS. Nenhuma escrita, nenhum acesso a banco.
//
// Reclassificar muda a CATEGORIA de um lançamento econômico que JÁ EXISTE (e, com ela, classificação e natureza). Nunca:
//   - cria receita ou despesa nova (o fato econômico continua sendo o mesmo registro, com o mesmo id, valor e competência);
//   - cria lançamento compensatório para "acertar" a DRE;
//   - transforma receita em despesa (ou o contrário), nem dedução em despesa: a natureza econômica é preservada;
//   - tira um lançamento da classificação PROVISÓRIA sem evidência (documento) que comprove a natureza;
//   - atua sobre movimentação bancária: dinheiro que saiu sem obrigação não tem natureza econômica comprovada — a saída é
//     VINCULADA a uma conta a pagar (que tem categoria), nunca "classificada" direto, para não reconhecer a despesa duas vezes.
import { NATUREZA_LANCAMENTO as N, SITUACAO_LANCAMENTO, TIPO } from "./catalogos.js";
import { CODIGO, falhar } from "./erros.js";
import { CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_DESPESA_A_CLASSIFICAR } from "./planoDeContas.js";

const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

/** Situações econômicas distintas tratadas pela reclassificação (cada uma com regra e texto próprios). */
export const CASO = enumerar(
  "MOVIMENTACAO_SEM_NATUREZA", // saída/entrada bancária sem título: não se reclassifica — vincula-se
  "OBRIGACAO_SEM_CATEGORIA_CONFIRMADA", // conta a pagar reconhecida na categoria "a classificar"
  "DESCONTO_SEM_FINANCIADOR", // dedução provisória: financiador do desconto não comprovado
  "CLASSIFICACAO_DE_RECEITA", // receita mudando de categoria de receita
  "CLASSIFICACAO_DE_DESPESA", // despesa provisória (fora de obrigação) recebendo a categoria definitiva
  "REATRIBUICAO_ENTRE_CATEGORIAS", // categoria confirmada trocada por outra de mesma natureza
  "CORRECAO_DOCUMENTAL", // só falta o documento: vincula-se a evidência, a categoria não muda
  "OPERACAO_CANCELADA_OU_ESTORNADA", // lançamento cancelado/estornado: não se reclassifica
);

export const TEXTO_DO_CASO = Object.freeze({
  MOVIMENTACAO_SEM_NATUREZA: "Movimentação bancária sem natureza econômica comprovada. Ela não é reclassificada: vincule-a a uma conta a pagar ou a receber existente (ou registre a conta com documento). Assim a despesa ou receita não é reconhecida duas vezes.",
  OBRIGACAO_SEM_CATEGORIA_CONFIRMADA: "Conta a pagar já reconhecida, mas na categoria \"a classificar\": fica fora da DRE até receber a categoria definitiva, com evidência.",
  DESCONTO_SEM_FINANCIADOR: "Desconto deduzido de forma provisória porque a fonte não informa quem o financiou. Só muda para outra dedução, com o relatório do canal como evidência.",
  CLASSIFICACAO_DE_RECEITA: "Receita: só muda para outra categoria de receita. Receita nunca vira despesa.",
  CLASSIFICACAO_DE_DESPESA: "Despesa provisória recebendo a categoria definitiva, com evidência.",
  REATRIBUICAO_ENTRE_CATEGORIAS: "Categoria já confirmada trocada por outra da mesma natureza econômica (ex.: comissão → anúncio).",
  CORRECAO_DOCUMENTAL: "A categoria está correta; falta apenas o documento. Use o vínculo de documento — a classificação não muda.",
  OPERACAO_CANCELADA_OU_ESTORNADA: "Lançamento cancelado ou estornado: não pode ser reclassificado. O histórico fica preservado.",
});

/** Categorias provisórias (do sistema): ninguém reclassifica PARA elas — são o ponto de partida, não um destino. */
export const PROVISORIAS = Object.freeze([CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_DESPESA_A_CLASSIFICAR]);
export const ehProvisoria = (codigo) => PROVISORIAS.includes(codigo);

/** Caso econômico de um lançamento. */
export function casoDoLancamento(l) {
  if (l.situacao !== SITUACAO_LANCAMENTO.ATIVO) return CASO.OPERACAO_CANCELADA_OU_ESTORNADA;
  if (l.categoria === CATEGORIA_DESPESA_A_CLASSIFICAR) return l.origem?.tipo === TIPO.OBRIGACAO ? CASO.OBRIGACAO_SEM_CATEGORIA_CONFIRMADA : CASO.CLASSIFICACAO_DE_DESPESA;
  if (l.categoria === CATEGORIA_DESCONTO_A_CLASSIFICAR) return CASO.DESCONTO_SEM_FINANCIADOR;
  if (l.natureza === N.RECEITA) return CASO.CLASSIFICACAO_DE_RECEITA;
  return CASO.REATRIBUICAO_ENTRE_CATEGORIAS;
}

/**
 * Naturezas de DESTINO compatíveis com o lançamento. A natureza é preservada; a única troca aceita é despesa ⇄ patrimonial
 * numa CONTA A PAGAR (ex.: boleto "a classificar" que era o principal de um empréstimo), porque nos dois casos o título é
 * uma dívida da empresa e nada de receita é criado.
 */
export function naturezasPermitidas(l) {
  if (l.natureza === N.RECEITA) return [N.RECEITA];
  if (l.natureza === N.DEDUCAO) return [N.DEDUCAO];
  if (l.origem?.tipo === TIPO.OBRIGACAO && [N.DESPESA, N.PATRIMONIAL].includes(l.natureza)) return [N.DESPESA, N.PATRIMONIAL];
  return [l.natureza];
}

/** Destinos possíveis no plano da unidade (lançáveis, ativos, compatíveis, não provisórios e diferentes do atual). */
export function categoriasDeDestino(l, categorias) {
  const nat = naturezasPermitidas(l);
  return categorias.filter((c) => c.aceitaLancamento && c.ativa !== false && !ehProvisoria(c.codigo) && c.codigo !== l.categoria && nat.includes(c.natureza))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/** Recusa (falha fechada) o que a regra econômica não permite. */
export function exigirReclassificacaoValida(l, categoria) {
  if (l.situacao !== SITUACAO_LANCAMENTO.ATIVO) falhar(CODIGO.OPERACAO_INVALIDA, "Lançamento cancelado ou estornado não pode ser reclassificado.");
  if (ehProvisoria(categoria.codigo)) {
    falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria provisória é do sistema: não serve de destino de reclassificação.", { categoria: categoria.codigo });
  }
  if (!naturezasPermitidas(l).includes(categoria.natureza)) {
    const receita = l.natureza === N.RECEITA || categoria.natureza === N.RECEITA;
    falhar(CODIGO.CATEGORIA_INVALIDA, receita
      ? "Reclassificação não transforma receita em despesa nem o contrário: cancele e registre de novo."
      : "A categoria escolhida tem natureza econômica incompatível com a deste lançamento.", { categoria: categoria.codigo, natureza: categoria.natureza });
  }
}

/** Sair da classificação provisória — ou ir para uma categoria que exige documento — só com evidência. */
export const exigeEvidencia = (l, categoria) => ehProvisoria(l.categoria) || categoria.exigeDocumento === true;

/** Sugestão pelo histórico (nunca aplicada sozinha): categoria mais usada em OUTRAS contas da mesma contraparte. */
export function sugestaoPorHistorico(l, { obrigacoes, lancamentos, categorias }) {
  if (l.origem?.tipo !== TIPO.OBRIGACAO) return null;
  const minha = obrigacoes.find((o) => o.lancamentoId === l.id);
  if (!minha?.contraparteId) return null;
  const porId = new Map(lancamentos.map((x) => [x.id, x]));
  const contagem = new Map();
  for (const o of obrigacoes.filter((x) => x.contraparteId === minha.contraparteId && x.lancamentoId !== l.id)) {
    const outro = porId.get(o.lancamentoId);
    if (!outro || outro.situacao !== SITUACAO_LANCAMENTO.ATIVO || ehProvisoria(outro.categoria)) continue;
    contagem.set(outro.categoria, (contagem.get(outro.categoria) ?? 0) + 1);
  }
  const permitidas = new Set(categoriasDeDestino(l, categorias).map((c) => c.codigo));
  const [melhor] = [...contagem.entries()].filter(([c]) => permitidas.has(c)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!melhor) return null;
  const cat = categorias.find((c) => c.codigo === melhor[0]);
  return { categoria: melhor[0], nome: cat?.nome ?? melhor[0], ocorrencias: melhor[1], motivo: `Usada em ${melhor[1]} outra(s) conta(s) do mesmo fornecedor. É só sugestão: não é aplicada sem confirmação.` };
}

/** O lançamento como ficaria — usado SÓ em memória pela prévia (nada é gravado). */
export const comoReclassificado = (l, categoria) => ({ ...l, categoriaId: categoria.id, categoria: categoria.codigo, classificacao: categoria.classificacao, natureza: categoria.natureza });

/**
 * Impacto da reclassificação calculado pelos MESMOS motores (apuração e conferências) sobre os registros reais com UM
 * lançamento trocado em memória. A tela só mostra; não recalcula nada.
 * @param {object} e { antes, depois: apurações; impedimentosAntes, impedimentosDepois; titulosAntes, titulosDepois; lancamento; categoriaNova }
 */
export function impactoDaReclassificacao(e) {
  const { antes, depois } = e;
  const linhas = antes.dre.linhas.map((la) => {
    const ld = depois.dre.linhas.find((x) => x.codigo === la.codigo);
    return { codigo: la.codigo, nome: la.nome, antesCentavos: la.valorCentavos, depoisCentavos: ld?.valorCentavos ?? null, situacaoAntes: la.situacao, situacaoDepois: ld?.situacao ?? null };
  });
  const canaisAntes = antes.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL?.porCanal ?? [];
  const canaisDepois = depois.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL?.porCanal ?? [];
  const canais = canaisAntes.map((ca) => {
    const cd = canaisDepois.find((x) => x.canal === ca.canal);
    return { canal: ca.canal, antesCentavos: ca.liquidoGerencialCentavos ?? null, depoisCentavos: cd?.liquidoGerencialCentavos ?? null };
  }).filter((c) => c.antesCentavos !== c.depoisCentavos);
  const foraAntes = antes.dre.foraDoResultado.aClassificar.length;
  const foraDepois = depois.dre.foraDoResultado.aClassificar.length;
  const codigos = (lista) => [...new Set(lista.map((x) => x.codigo))].sort();
  return {
    valorCentavos: e.lancamento.valorCentavos,
    competencia: e.lancamento.competencia,
    categoriaAnterior: { codigo: e.lancamento.categoria, natureza: e.lancamento.natureza, classificacao: e.lancamento.classificacao },
    categoriaNova: { codigo: e.categoriaNova.codigo, nome: e.categoriaNova.nome, natureza: e.categoriaNova.natureza, classificacao: e.categoriaNova.classificacao },
    dre: { linhasAlteradas: linhas.filter((x) => x.antesCentavos !== x.depoisCentavos || x.situacaoAntes !== x.situacaoDepois), lancamentosForaDoResultado: { antes: foraAntes, depois: foraDepois } },
    canais: { alterados: canais, observacao: canais.length ? null : e.lancamento.canal ? "O líquido por canal não muda." : "Lançamento sem canal: a composição por canal não muda." },
    titulos: (e.titulosAntes ?? []).map((ta) => {
      const td = (e.titulosDepois ?? []).find((x) => x.id === ta.id);
      return { id: ta.id, descricao: ta.descricao, saldoCentavos: ta.saldoCentavos, situacaoAntes: ta.situacao, situacaoDepois: td?.situacao ?? null, efeitoNaDreAntes: ta.efeitoNaDre, efeitoNaDreDepois: td?.efeitoNaDre ?? null };
    }),
    caixa: { efeito: "NENHUM", explicacao: "Reclassificar não movimenta dinheiro: saldos de caixa e bancos, pagamentos e recebimentos ficam como estão." },
    impedimentos: { antes: codigos(e.impedimentosAntes), depois: codigos(e.impedimentosDepois), quantidadeAntes: e.impedimentosAntes.length, quantidadeDepois: e.impedimentosDepois.length },
    pendenciasQuePermanecem: e.impedimentosDepois.map((x) => ({ codigo: x.codigo, mensagem: x.mensagem })),
    gravado: false,
  };
}
