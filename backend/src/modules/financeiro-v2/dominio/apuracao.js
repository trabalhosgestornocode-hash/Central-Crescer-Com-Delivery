// MOTOR DE APURAÇÃO (Execução 04) — fonte ÚNICA dos indicadores, da DRE Gerencial e da futura Visão Geral.
// Puro: recebe os registros de UM escopo e UMA competência; devolve indicadores com valor, fórmula, composição
// hierárquica até o registro e o documento, situação de confiabilidade e pendências. Nenhuma tela calcula nada.
//
// Princípios:
//   - cada lançamento econômico ativo entra UMA vez, na linha da sua classificação (natureza vem da categoria);
//   - o líquido gerencial por canal é OUTRA LEITURA dos mesmos lançamentos: não cria lançamento nem volta a subtrair;
//   - recebimentos, pagamentos, transferências, recebíveis e saldos bancários NÃO são resultado;
//   - lançamentos PATRIMONIAIS (principal de empréstimo, aporte, imobilizado) ficam fora do resultado;
//   - desconhecido ≠ zero: sem registros, o valor é nulo e a situação explica o bloqueio;
//   - nada de CMV por estoque: o resultado é "Resultado Gerencial — Sem Ajuste de Estoque".
import { CLASSIFICACAO as K, NATUREZA_LANCAMENTO as N, SITUACAO_LANCAMENTO, SITUACAO_MOVIMENTACAO, TIPO } from "./catalogos.js";
import { somar, subtrair } from "./dinheiro.js";
import { competenciaDe } from "./tempo.js";

export const METODOLOGIA = Object.freeze({ nome: "DRE_GERENCIAL_SEM_AJUSTE_DE_ESTOQUE", versao: "v1" });

export const SITUACAO_INDICADOR = Object.freeze({
  CONFIRMADO: "CONFIRMADO",
  CALCULADO_AGUARDANDO_CONFERENCIA: "CALCULADO_AGUARDANDO_CONFERENCIA",
  PRELIMINAR: "PRELIMINAR",
  PARCIAL: "PARCIAL",
  PENDENTE_DE_CLASSIFICACAO: "PENDENTE_DE_CLASSIFICACAO",
  BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE: "BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE",
});
const S = SITUACAO_INDICADOR;

export const CANAIS_PRINCIPAIS = Object.freeze(["BALCAO", "IFOOD", "ANOTA_AI"]);
export const SEM_CANAL = "NAO_IDENTIFICADO";

/**
 * Despesa "a classificar" (natureza econômica não comprovada) NÃO entra em nenhuma linha: fica fora do resultado,
 * listada à parte e como pendência, até ser reclassificada (auditoria A.2 da Execução 06B).
 */
export const CATEGORIA_FORA_ATE_CLASSIFICAR = "DESPESAS_A_CLASSIFICAR";
const naDre = (l) => l.categoria !== CATEGORIA_FORA_ATE_CLASSIFICAR;

/** Linhas da DRE: classificações (e natureza) que cada linha soma, e o sinal com que entram no resultado. */
const LINHAS_BASE = [
  { codigo: "FATURAMENTO_BRUTO_PROPRIO", nome: "(+) Faturamento Bruto Próprio", sinal: 1, filtro: (l) => l.natureza === N.RECEITA && l.classificacao === K.RECEITA_OPERACIONAL },
  { codigo: "DEDUCOES_COMERCIAIS", nome: "(−) Deduções Comerciais", sinal: -1, filtro: (l) => l.natureza === N.DEDUCAO },
  { codigo: "CUSTOS_OPERACIONAIS", nome: "(−) Custos Operacionais Gerenciais", sinal: -1, filtro: (l) => l.natureza === N.DESPESA && l.classificacao === K.CUSTOS_OPERACIONAIS },
  {
    codigo: "DESPESAS_OPERACIONAIS", nome: "(−) Despesas Operacionais e Comerciais", sinal: -1,
    filtro: (l) => l.natureza === N.DESPESA && [K.DESPESAS_COMERCIAIS, K.DESPESAS_RECEBIMENTO_PROCESSAMENTO, K.DESPESAS_ADMINISTRATIVAS, K.PESSOAL, K.MARKETING, K.DESPESAS_PLATAFORMAS, K.TRIBUTOS].includes(l.classificacao),
  },
  { codigo: "RESULTADO_FINANCEIRO", nome: "(+/−) Resultado Financeiro", sinal: 1, filtro: (l) => l.classificacao === K.DESPESAS_FINANCEIRAS && [N.RECEITA, N.DESPESA].includes(l.natureza), assinado: true },
  { codigo: "DEMAIS_EFEITOS_GERENCIAIS", nome: "(+/−) Demais Efeitos Gerenciais", sinal: 1, filtro: (l) => l.classificacao === K.OUTROS_EFEITOS_GERENCIAIS && [N.RECEITA, N.DESPESA].includes(l.natureza), assinado: true },
];
const LINHAS = LINHAS_BASE.map((def) => ({ ...def, filtro: (l) => naDre(l) && def.filtro(l) }));
/** Valor do lançamento com o sinal da sua natureza (só para linhas "assinadas", que misturam receitas e despesas). */
const assinado = (l) => (l.natureza === N.RECEITA ? l.valorCentavos : -l.valorCentavos);

// ------------------------------------------------------------------------------------------- percentuais
/**
 * Participação de cada parte no total em CENTÉSIMOS DE PONTO PERCENTUAL (10000 = 100%), por maior resto: a soma das
 * partes é exatamente 10000 quando as partes somam o total. Partes negativas (prejuízo, resultado financeiro negativo)
 * entram com sinal — nada é forçado a ser positivo. Total ≤ 0 ou nulo: sem percentuais.
 */
export function participacoes(partes, total) {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const T = BigInt(total);
  const brutos = partes.map((v) => BigInt(v) * 10000n);
  const pisos = brutos.map((x) => (x >= 0n ? x / T : -((-x + T - 1n) / T)));
  const restos = brutos.map((x, i) => x - pisos[i] * T);
  let falta = 10000n - pisos.reduce((s, x) => s + x, 0n);
  const ordem = restos.map((r, i) => [r, i]).sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : a[1] - b[1]));
  const saida = [...pisos];
  for (const [, i] of ordem) { if (falta <= 0n) break; saida[i] += 1n; falta -= 1n; }
  return saida.map(Number);
}
export function comoPercentual(pontos) {
  if (pontos === null || pontos === undefined) return null;
  const t = String(Math.abs(pontos)).padStart(3, "0");
  return `${pontos < 0 ? "-" : ""}${t.slice(0, -2)},${t.slice(-2)}%`;
}

// ------------------------------------------------------------------------------------------- apuração
/**
 * @param {object} d registros do escopo: lancamentos, categorias, vendas, propostas, obrigacoes, movimentacoes, recebiveis,
 *                   ajustes, competencias, registrosControle (registros de fonte agregados)
 * @param {{competencia:string, escopo:{organizacaoId:string, unidadeId:string}, apuradoEm:string}} p
 */
export function apurar(d, p) {
  const comp = p.competencia;
  const ativos = d.lancamentos.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.competencia === comp);
  const categorias = new Map(d.categorias.map((c) => [c.id, c]));
  const porCodigo = new Map(d.categorias.map((c) => [c.codigo, c]));
  const propostaDoEfeito = new Map();
  for (const pr of d.propostas) for (const e of pr.efeitos ?? []) propostaDoEfeito.set(e.id, pr);
  const vendas = new Map(d.vendas.map((v) => [v.id, v]));
  const ajustes = new Map(d.ajustes.map((a) => [a.id, a]));
  const obrigacoesDoLancamento = new Map();
  for (const o of d.obrigacoes) obrigacoesDoLancamento.set(o.lancamentoId, [...(obrigacoesDoLancamento.get(o.lancamentoId) ?? []), o]);

  /** Documentos que sustentam um lançamento: da proposta que o criou, do ajuste, da obrigação ou do desconto. */
  function documentosDe(l) {
    const ids = new Set();
    for (const id of propostaDoEfeito.get(l.id)?.documentoIds ?? []) ids.add(id);
    if (l.origem?.tipo === TIPO.VENDA) for (const id of propostaDoEfeito.get(l.origem.id)?.documentoIds ?? []) ids.add(id);
    if (l.origem?.tipo === TIPO.AJUSTE && ajustes.get(l.origem.id)?.documentoId) ids.add(ajustes.get(l.origem.id).documentoId);
    if (l.origem?.documentoId) ids.add(l.origem.documentoId);
    for (const o of obrigacoesDoLancamento.get(l.id) ?? []) for (const id of o.documentoIds ?? []) ids.add(id);
    return [...ids].sort();
  }

  // ---------------------------------------------------------------- pendências (afetam a situação dos indicadores)
  const pendencias = [];
  for (const l of ativos.filter((x) => x.categoria === "DESCONTOS_A_CLASSIFICAR")) {
    pendencias.push({ tipo: "DESCONTO_A_CLASSIFICAR", gravidade: "CLASSIFICACAO", afeta: ["DEDUCOES_COMERCIAIS", "RESULTADO_GERENCIAL"], valorCentavos: l.valorCentavos, lancamentoId: l.id, financiador: l.origem?.financiador ?? null, mensagem: "Desconto com financiador não comprovado: dedução provisória (não prova que a loja suporta o desconto)." });
  }
  for (const l of ativos.filter((x) => !naDre(x))) {
    pendencias.push({ tipo: "DESPESA_A_CLASSIFICAR", gravidade: "CLASSIFICACAO", afeta: ["RESULTADO_GERENCIAL"], valorCentavos: l.valorCentavos, lancamentoId: l.id, mensagem: "Despesa com natureza econômica não comprovada: fica FORA do resultado até ser classificada (não é presumida despesa)." });
  }
  const abertas = ["PROPOSTA", "AGUARDANDO_EVIDENCIA", "AGUARDANDO_REVISAO", "APROVADA"];
  for (const pr of d.propostas.filter((x) => x.competencia === comp && abertas.includes(x.estado))) {
    const venda = ["VENDA", "VENDA_AGREGADA"].includes(pr.operacao);
    pendencias.push({ tipo: venda ? "VENDA_NAO_APLICADA" : `PROPOSTA_${pr.operacao}`, gravidade: "PARCIAL", afeta: venda ? ["FATURAMENTO_BRUTO_PROPRIO", "RESULTADO_GERENCIAL"] : ["RESULTADO_GERENCIAL"], valorCentavos: pr.valorCentavos, propostaId: pr.id, estado: pr.estado, mensagem: venda ? "Venda/agregado ainda não aplicado: o faturamento da competência está incompleto." : "Proposta financeira ainda não aplicada." });
  }
  for (const m of d.movimentacoes.filter((x) => x.situacao === SITUACAO_MOVIMENTACAO.VALIDA && competenciaDe(x.dataEfetiva) === comp && x.sentido === "SAIDA" && x.alocadoCentavos < x.valorCentavos && !x.transferenciaId && !x.estornoId && !x.pagamentoId)) {
    pendencias.push({ tipo: "SAIDA_SEM_CLASSIFICACAO", gravidade: "CLASSIFICACAO", afeta: ["RESULTADO_GERENCIAL"], valorCentavos: subtrair(m.valorCentavos, m.alocadoCentavos), movimentacaoId: m.id, mensagem: "Saída bancária sem obrigação vinculada: pode ser despesa ainda não reconhecida." });
  }
  // Sobreposição agregado × pedidos no mesmo dia: uma operação nunca pode contar duas vezes.
  const diasAgregados = new Set(ativos.filter((l) => l.natureza === N.RECEITA && !l.canal && l.origem?.tipo === TIPO.PROPOSTA).map((l) => l.dataOperacao));
  for (const dia of diasAgregados) {
    if (ativos.some((l) => l.natureza === N.RECEITA && l.origem?.tipo === TIPO.VENDA && l.dataOperacao === dia)) {
      pendencias.push({ tipo: "SOBREPOSICAO_AGREGADO_PEDIDOS", gravidade: "BLOQUEIO", afeta: ["FATURAMENTO_BRUTO_PROPRIO", "RESULTADO_GERENCIAL"], data: dia, mensagem: "Agregado e pedidos do mesmo dia com receita ativa: risco de contagem dupla." });
    }
  }

  const estadoComp = d.competencias.find((c) => c.competencia === comp)?.estado ?? "ABERTA";
  const temRegistros = ativos.length > 0;
  function situacaoDe(codigo) {
    const minhas = pendencias.filter((x) => x.afeta.includes(codigo));
    if (!temRegistros || minhas.some((x) => x.gravidade === "BLOQUEIO")) return S.BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE;
    if (minhas.some((x) => x.gravidade === "CLASSIFICACAO")) return S.PENDENTE_DE_CLASSIFICACAO;
    if (minhas.some((x) => x.gravidade === "PARCIAL")) return S.PARCIAL;
    if (estadoComp === "FECHAMENTO_HOMOLOGADO") return S.CONFIRMADO;
    if (estadoComp === "FECHAMENTO_COM_PENDENCIAS") return S.CALCULADO_AGUARDANDO_CONFERENCIA;
    return S.PRELIMINAR;
  }

  // ---------------------------------------------------------------- composição hierárquica: linha → categoria → subcategoria → lançamento → documento
  function folha(l, sinal, total) {
    const docs = documentosDe(l);
    const no = {
      id: `LANCAMENTO:${l.id}`, nome: l.descricao ?? l.categoria, natureza: l.natureza, valorCentavos: sinal * l.valorCentavos, sinal, origem: l.origem ?? null,
      situacao: l.categoria === "DESCONTOS_A_CLASSIFICAR" ? "PENDENTE_DE_CLASSIFICACAO" : "REGISTRADO", canal: l.canal ?? null, dataOperacao: l.dataOperacao,
      referencias: { registroTipo: TIPO.LANCAMENTO, registroId: l.id, fonte: l.fonte ?? null, documentoIds: docs, propostaId: propostaDoEfeito.get(l.id)?.id ?? null }, filhos: [],
    };
    const obrigacoes = obrigacoesDoLancamento.get(l.id) ?? [];
    if (obrigacoes.length) {
      no.detalhe = {
        obrigacoes: obrigacoes.map((o) => ({ obrigacaoId: o.id, contraparteId: o.contraparteId, valorReconhecidoCentavos: o.valorBaseCentavos, pagoCentavos: o.liquidadoCentavos, saldoCentavos: o.saldoCentavos, situacao: o.situacao, vencimento: o.vencimento })),
        ...(propostaDoEfeito.get(l.id)?.pedidos ? { pedidos: propostaDoEfeito.get(l.id).pedidos, taxasRejeitadas: propostaDoEfeito.get(l.id).taxasRejeitadas, canceladas: propostaDoEfeito.get(l.id).canceladas } : {}),
      };
    }
    if (l.origem?.tipo === TIPO.VENDA && vendas.get(l.origem.id)?.composicao && l.natureza === N.RECEITA) no.detalhe = { composicao: vendas.get(l.origem.id).composicao };
    no.percentualDoBruto = total > 0 ? participacoes([no.valorCentavos], total)?.[0] ?? null : null;
    return no;
  }

  /** Agrupa folhas por categoria e sobe a árvore do plano (subcategoria → categoria pai). Nenhum nó vazio. */
  function arvore(lancs, sinalDe, total) {
    const nos = new Map();
    const noDaCategoria = (cat) => {
      if (!cat) return null;
      const id = `CATEGORIA:${cat.codigo}`;
      if (!nos.has(id)) nos.set(id, { id, nome: cat.nome, natureza: cat.natureza, valorCentavos: 0, sinal: 0, origem: null, situacao: cat.codigo === "DESCONTOS_A_CLASSIFICAR" ? "PENDENTE_DE_CLASSIFICACAO" : "REGISTRADO", referencias: { categoria: cat.codigo }, filhos: [], pai: cat.paiId ? categorias.get(cat.paiId) : null });
      return nos.get(id);
    };
    for (const l of lancs) {
      const s = sinalDe(l);
      const f = folha(l, s, total);
      let atual = noDaCategoria(categorias.get(l.categoriaId) ?? porCodigo.get(l.categoria));
      if (!atual) { atual = noDaCategoria({ codigo: l.categoria, nome: l.categoria, natureza: l.natureza, paiId: null }); }
      atual.filhos.push(f);
    }
    // Sobe a hierarquia: cada categoria com valor vira filha da categoria pai (até a raiz da classificação).
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (const no of [...nos.values()]) {
        if (no.pai && !no.ligado) {
          const pai = noDaCategoria(no.pai);
          pai.filhos.push(no);
          no.ligado = true;
          mudou = true;
        }
      }
    }
    const somarNo = (no) => { if (no.filhos.length && !no.id.startsWith("LANCAMENTO:")) no.valorCentavos = no.filhos.reduce((s, f) => somar(s, somarNo(f)), 0); return no.valorCentavos; };
    const raizes = [...nos.values()].filter((n) => !n.ligado);
    for (const r of raizes) somarNo(r);
    const limpar = (no) => {
      no.pai = undefined;
      no.ligado = undefined;
      no.filhos.forEach(limpar);
      no.filhos.sort((a, b) => Math.abs(b.valorCentavos) - Math.abs(a.valorCentavos) || (a.id < b.id ? -1 : 1));
      no.sinal = Math.sign(no.valorCentavos);
      if (!no.id.startsWith("LANCAMENTO:")) no.percentualDoBruto = total > 0 ? participacoes([no.valorCentavos], total)?.[0] ?? null : null;
      return no;
    };
    return raizes.map(limpar).sort((a, b) => Math.abs(b.valorCentavos) - Math.abs(a.valorCentavos));
  }

  // ---------------------------------------------------------------- DRE
  const bruto = ativos.filter(LINHAS[0].filtro).reduce((s, l) => somar(s, l.valorCentavos), 0);
  const indicador = (codigo, nome, descricao, formula, valor, componentes, extra = {}) => ({
    codigo, nome, descricao, competencia: comp, organizacaoId: p.escopo.organizacaoId, unidadeId: p.escopo.unidadeId, formula,
    valorCentavos: temRegistros ? valor : null, unidade: "BRL_CENTAVOS", componentes, metodologia: METODOLOGIA, situacao: situacaoDe(codigo),
    pendencias: pendencias.filter((x) => x.afeta.includes(codigo)), apuradoEm: p.apuradoEm,
    percentualDoBruto: temRegistros && bruto > 0 ? participacoes([valor], bruto)[0] : null, ...extra,
  });

  const linhas = {};
  for (const def of LINHAS) {
    const lancs = ativos.filter(def.filtro);
    const sinalDe = def.assinado ? (l) => (l.natureza === N.RECEITA ? 1 : -1) : () => def.sinal;
    const valor = lancs.reduce((s, l) => somar(s, def.assinado ? assinado(l) : def.sinal * l.valorCentavos), 0);
    linhas[def.codigo] = indicador(def.codigo, def.nome, `Soma dos lançamentos ativos da competência em ${def.nome.replace(/^\([^)]*\)\s*/, "")}.`, def.assinado ? "Σ receitas − Σ despesas da classificação" : `${def.sinal > 0 ? "+" : "−"} Σ lançamentos da classificação`, valor, arvore(lancs, sinalDe, bruto));
  }
  const v = (c) => linhas[c].valorCentavos ?? 0;
  const receitaLiquida = somar(v("FATURAMENTO_BRUTO_PROPRIO"), v("DEDUCOES_COMERCIAIS"));
  const aposCustos = somar(receitaLiquida, v("CUSTOS_OPERACIONAIS"));
  const resultado = somar(aposCustos, v("DESPESAS_OPERACIONAIS"), v("RESULTADO_FINANCEIRO"), v("DEMAIS_EFEITOS_GERENCIAIS"));
  const subtotal = (codigo, nome, formula, valor, partes) => indicador(codigo, nome, formula, formula, valor, partes.map((c) => ({ id: `LINHA:${c}`, nome: linhas[c]?.nome ?? c, valorCentavos: linhas[c]?.valorCentavos ?? 0, sinal: Math.sign(linhas[c]?.valorCentavos ?? 0), referencias: { indicador: c }, filhos: [] })));
  linhas.RECEITA_LIQUIDA_COMERCIAL = subtotal("RECEITA_LIQUIDA_COMERCIAL", "(=) Receita Líquida Comercial", "Faturamento Bruto Próprio − Deduções Comerciais", receitaLiquida, ["FATURAMENTO_BRUTO_PROPRIO", "DEDUCOES_COMERCIAIS"]);
  linhas.RESULTADO_APOS_CUSTOS = subtotal("RESULTADO_APOS_CUSTOS", "(=) Resultado Após Custos", "Receita Líquida Comercial − Custos Operacionais Gerenciais", aposCustos, ["FATURAMENTO_BRUTO_PROPRIO", "DEDUCOES_COMERCIAIS", "CUSTOS_OPERACIONAIS"]);
  linhas.RESULTADO_GERENCIAL = subtotal("RESULTADO_GERENCIAL", "(=) Resultado Gerencial — Sem Ajuste de Estoque", "Resultado Após Custos − Despesas Operacionais ± Resultado Financeiro ± Demais Efeitos", resultado, ["FATURAMENTO_BRUTO_PROPRIO", "DEDUCOES_COMERCIAIS", "CUSTOS_OPERACIONAIS", "DESPESAS_OPERACIONAIS", "RESULTADO_FINANCEIRO", "DEMAIS_EFEITOS_GERENCIAIS"]);
  linhas.RESULTADO_GERENCIAL.observacao = "Resultado gerencial sem ajuste de estoque (compras de insumos pela competência da compra). Não é lucro contábil auditado.";

  // ---------------------------------------------------------------- faturamento bruto por canal (o indicador principal da Visão Geral)
  const receitas = ativos.filter(LINHAS[0].filtro);
  const canais = [...new Set([...CANAIS_PRINCIPAIS, ...receitas.map((l) => l.canal ?? SEM_CANAL)])];
  const componentesDaReceita = (lancs) => {
    const soma = { produtos: 0, acrescimos: 0, servicos: 0, agregadoSemDetalhe: 0, semComposicao: 0 };
    for (const l of lancs) {
      const comp2 = l.origem?.tipo === TIPO.VENDA ? vendas.get(l.origem.id)?.composicao : null;
      if (comp2) { soma.produtos = somar(soma.produtos, comp2.itensCentavos); soma.acrescimos = somar(soma.acrescimos, comp2.acrescimosCentavos); soma.servicos = somar(soma.servicos, comp2.servicosCentavos); }
      else if (l.origem?.tipo === TIPO.PROPOSTA) soma.agregadoSemDetalhe = somar(soma.agregadoSemDetalhe, l.valorCentavos);
      else soma.semComposicao = somar(soma.semComposicao, l.valorCentavos);
    }
    return soma;
  };
  const porCanal = canais.map((canal) => {
    const lancs = receitas.filter((l) => (l.canal ?? SEM_CANAL) === canal);
    const valor = lancs.reduce((s, l) => somar(s, l.valorCentavos), 0);
    return {
      canal, comprovado: canal !== SEM_CANAL, valorCentavos: temRegistros ? valor : null, percentualDoBruto: temRegistros && bruto > 0 ? participacoes([valor], bruto)[0] : null,
      componentes: componentesDaReceita(lancs), registros: lancs.map((l) => l.id).sort(),
      observacao: canal === SEM_CANAL ? "Receita de relatório agregado sem canal comprovado: nunca é atribuída a Balcão ou outro canal por exclusão." : null,
    };
  });
  const faturamentoBruto = { ...linhas.FATURAMENTO_BRUTO_PROPRIO, nome: "Faturamento Bruto Próprio", porCanal, componentesDaReceita: componentesDaReceita(receitas) };

  // ---------------------------------------------------------------- líquido gerencial por canal (leitura analítica, sem novos lançamentos)
  // Atribuição a canal: lançamento com canal → aquele canal. Sem canal: só a RECEITA agregada e as deduções ligadas a
  // ela (ou a venda sem canal) vão para NAO_IDENTIFICADO; o resto (custos, despesas gerais, financeiro, demais efeitos,
  // deduções avulsas) é NÃO ATRIBUÍDO — nunca é empurrado para um canal.
  const doAgregadoOuVenda = (l) => l.origem?.tipo === TIPO.PROPOSTA || l.origem?.tipo === TIPO.VENDA;
  const canalDe = (l) => (l.canal ? l.canal : (l.natureza === N.RECEITA && l.classificacao === K.RECEITA_OPERACIONAL) || (l.natureza === N.DEDUCAO && doAgregadoOuVenda(l)) ? SEM_CANAL : null);
  const liquidoPorCanal = canais.map((canal) => {
    const doCanal = ativos.filter((l) => canalDe(l) === canal && l.natureza !== N.PATRIMONIAL && naDre(l));
    const brutoC = doCanal.filter(LINHAS[0].filtro).reduce((s, l) => somar(s, l.valorCentavos), 0);
    const deducoesC = doCanal.filter((l) => l.natureza === N.DEDUCAO).reduce((s, l) => somar(s, l.valorCentavos), 0);
    const despesasC = doCanal.filter((l) => l.natureza === N.DESPESA);
    const porNatureza = {};
    for (const l of despesasC) porNatureza[l.classificacao] = somar(porNatureza[l.classificacao] ?? 0, l.valorCentavos);
    const totalDespesas = despesasC.reduce((s, l) => somar(s, l.valorCentavos), 0);
    return {
      canal, brutoCentavos: brutoC, deducoesCentavos: deducoesC, despesasAtribuidasCentavos: totalDespesas, despesasPorClassificacao: porNatureza,
      liquidoGerencialCentavos: temRegistros ? subtrair(subtrair(brutoC, deducoesC), totalDespesas) : null,
      registros: doCanal.map((l) => l.id).sort(),
    };
  });
  const repassesPorProcessador = {};
  for (const r of d.recebiveis.filter((x) => x.competencia === comp && x.situacao !== "CANCELADA")) {
    const k = r.processador;
    const a = (repassesPorProcessador[k] ??= { brutoCentavos: 0, ajustesCentavos: 0, liquidadoCentavos: 0, saldoCentavos: 0, recebiveis: 0 });
    a.brutoCentavos = somar(a.brutoCentavos, r.valorBaseCentavos); a.ajustesCentavos = somar(a.ajustesCentavos, r.ajustesCentavos);
    a.liquidadoCentavos = somar(a.liquidadoCentavos, r.liquidadoCentavos); a.saldoCentavos = somar(a.saldoCentavos, r.saldoCentavos); a.recebiveis += 1;
  }
  // Reconciliação com a DRE: Σ líquidos por canal + componentes NÃO ATRIBUÍDOS (por linha da DRE) = resultado gerencial.
  const naoAtribuidos = {};
  for (const def of LINHAS) {
    const lancs = ativos.filter((l) => def.filtro(l) && canalDe(l) === null);
    const valor = lancs.reduce((s2, l) => somar(s2, def.assinado ? assinado(l) : def.sinal * l.valorCentavos), 0);
    if (lancs.length) naoAtribuidos[def.codigo] = { valorCentavos: valor, registros: lancs.map((l) => l.id).sort() };
  }
  const somaCanais = liquidoPorCanal.reduce((s2, x) => somar(s2, x.liquidoGerencialCentavos ?? 0), 0);
  const somaNaoAtribuidos = Object.values(naoAtribuidos).reduce((s2, x) => somar(s2, x.valorCentavos), 0);
  const reconciliacaoComDre = temRegistros ? {
    somaDosCanaisCentavos: somaCanais, naoAtribuidos, somaNaoAtribuidosCentavos: somaNaoAtribuidos,
    totalReconciliadoCentavos: somar(somaCanais, somaNaoAtribuidos), resultadoDaDreCentavos: resultado,
    reconcilia: somar(somaCanais, somaNaoAtribuidos) === resultado,
    observacao: "A DRE é a referência do resultado. A decomposição por canal reconcilia por canais identificados, sem canal e componentes não atribuídos.",
  } : null;
  const faturamentoLiquido = indicador("FATURAMENTO_LIQUIDO_GERENCIAL", "Faturamento Líquido Gerencial", "Por canal: bruto próprio − deduções do canal − despesas atribuídas ao canal. Leitura analítica: não é receita nem lançamento.",
    "Σ canal (bruto − deduções − despesas atribuídas)", liquidoPorCanal.reduce((s, c) => somar(s, c.liquidoGerencialCentavos ?? 0), 0), [], {
      porCanal: liquidoPorCanal, reconciliacaoComDre,
      reconciliacaoComRepasses: { porProcessador: repassesPorProcessador, observacao: "Recebíveis e repasses são apresentados à parte: o líquido gerencial não é o depósito bancário." },
    });

  // ---------------------------------------------------------------- cada R$ 100 faturados
  const grupos = [
    ["DEDUCOES_COMERCIAIS", -v("DEDUCOES_COMERCIAIS")], ["CUSTOS_OPERACIONAIS", -v("CUSTOS_OPERACIONAIS")], ["DESPESAS_OPERACIONAIS", -v("DESPESAS_OPERACIONAIS")],
    ["RESULTADO_FINANCEIRO", -v("RESULTADO_FINANCEIRO")], ["DEMAIS_EFEITOS_GERENCIAIS", -v("DEMAIS_EFEITOS_GERENCIAIS")], ["RESULTADO_GERENCIAL", resultado],
  ];
  const partes = temRegistros ? participacoes(grupos.map((g) => g[1]), bruto) : null;
  const cadaCem = {
    baseCentavos: temRegistros ? bruto : null,
    limitacao: !temRegistros ? "Sem registros na competência: valor desconhecido." : bruto <= 0 ? "Faturamento bruto zero: percentuais não se aplicam." : null,
    grupos: grupos.map(([codigo, valor], i) => {
      // Exato em milionésimos de ponto percentual (valor × 100.000.000 / bruto, truncado) para mostrar o arredondamento.
      const exato = partes ? Number((BigInt(valor) * 100000000n) / BigInt(bruto)) : null;
      return {
        codigo, valorCentavos: temRegistros ? valor : null, centesimosDePonto: partes ? partes[i] : null, percentual: partes ? comoPercentual(partes[i]) : null,
        exatoMilionesimosDePonto: exato, diferencaDeArredondamentoMilionesimos: partes ? partes[i] * 10000 - exato : null, acimaDeCem: partes ? Math.abs(partes[i]) > 10000 : false,
      };
    }),
    prejuizo: temRegistros && resultado < 0,
    regra: "Grupos = componentes econômicos (sem subtotais). Participação no faturamento bruto, exibida com 2 casas por maior resto (soma exatamente 100,00%); o exato e a diferença de arredondamento acompanham cada grupo. Prejuízo é parte negativa; nenhum valor é alterado para a barra fechar.",
  };

  const fora = ativos.filter((l) => l.natureza === N.PATRIMONIAL);
  const dre = {
    titulo: "DRE Gerencial — Resultado Gerencial Sem Ajuste de Estoque", competencia: comp, metodologia: METODOLOGIA, estadoDaCompetencia: estadoComp,
    linhas: ["FATURAMENTO_BRUTO_PROPRIO", "DEDUCOES_COMERCIAIS", "RECEITA_LIQUIDA_COMERCIAL", "CUSTOS_OPERACIONAIS", "RESULTADO_APOS_CUSTOS", "DESPESAS_OPERACIONAIS", "RESULTADO_FINANCEIRO", "DEMAIS_EFEITOS_GERENCIAIS", "RESULTADO_GERENCIAL"].map((c) => linhas[c]),
    foraDoResultado: {
      patrimoniais: fora.map((l) => ({ lancamentoId: l.id, categoria: l.categoria, valorCentavos: l.valorCentavos })),
      aClassificar: ativos.filter((l) => !naDre(l)).map((l) => ({ lancamentoId: l.id, categoria: l.categoria, descricao: l.descricao ?? null, valorCentavos: l.valorCentavos })),
      observacao: "Principal de empréstimo, aportes e imobilizado não entram no resultado. Despesas a classificar ficam fora até a natureza ser comprovada.",
    },
  };
  const entradas = [...ativos.map((l) => [TIPO.LANCAMENTO, l.id, l.versao, l.valorCentavos]), ...pendencias.map((x) => ["PENDENCIA", x.tipo, x.valorCentavos ?? null])].sort((a, b) => (`${a[0]}${a[1]}` < `${b[0]}${b[1]}` ? -1 : 1));
  return {
    competencia: comp, escopo: p.escopo, apuradoEm: p.apuradoEm, metodologia: METODOLOGIA,
    indicadores: { FATURAMENTO_BRUTO_PROPRIO: faturamentoBruto, FATURAMENTO_LIQUIDO_GERENCIAL: faturamentoLiquido, ...Object.fromEntries(Object.entries(linhas).filter(([k]) => k !== "FATURAMENTO_BRUTO_PROPRIO")) },
    dre, cadaCem, pendencias, entradas,
  };
}
