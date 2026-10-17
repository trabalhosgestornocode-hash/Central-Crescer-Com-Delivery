// Conciliação financeira — núcleo PURO (regime de caixa). Compara REFERÊNCIAS externas (vendas realizadas, taxas, sangrias, caixa em
// espécie) com os RECEBIMENTOS/PAGAMENTOS efetivos do livro-caixa. Princípios:
//  • venda realizada ≠ recebimento efetivo (a diferença é explicada por taxas, prazos, ajustes… — nunca presumida);
//  • sem referência = "sem_referencia" (jamais zero); ausência de taxas informadas impede calcular o residual;
//  • o residual NUNCA vira "prazo" sozinho: fica `pendente_identificacao` até uma classificação manual autorizada;
//  • exceções de sangria são dados aprovados (categoria + motivo), não nomes fixos no código.
import { PAPEL, SENTIDO, STATUS } from "./planoContas.js";

export const ESTADO = Object.freeze({
  SEM_REFERENCIA: "sem_referencia", CONCILIADO: "conciliado", PENDENTE: "pendente_identificacao",
  PARCIAL: "parcialmente_resolvido", RESOLVIDO: "resolvido", SEM_VINCULO: "sem_vinculo_canal",
});
export const CLASSIFICACOES = Object.freeze(["prazo", "taxa", "ajuste", "estorno", "divergencia", "outros"]);
export const ESCOPO = Object.freeze({ PONTE: "ponte_mensal", CAIXA: "caixa_dia", SANGRIA: "sangria_dia" });

const norm = (s) => (s == null || String(s).trim() === "" ? null : String(s).trim().toUpperCase());
const soma = (xs) => xs.reduce((s, x) => s + x, 0);
const noMes = (data, mes) => String(data).slice(0, 7) === mes;

/** Estado de um item a partir da diferença (null = sem referência) e das resoluções vigentes dele. */
export function estadoDe(diferenca, resolucoes = []) {
  if (diferenca === null || diferenca === undefined) return ESTADO.SEM_REFERENCIA;
  if (diferenca === 0) return ESTADO.CONCILIADO;
  if (!resolucoes.length) return ESTADO.PENDENTE;
  return diferenca - soma(resolucoes.map((r) => r.valorCentavos)) === 0 ? ESTADO.RESOLVIDO : ESTADO.PARCIAL;
}
const aberto = (e) => e === ESTADO.PENDENTE || e === ESTADO.PARCIAL;

/**
 * mes: "AAAA-MM". lancamentos: { contaId, sentido, valorCentavos, papel, categoriaId, data, status }.
 * contas: [{ id, nome, tipo_conta, canal_referencia }]. referencias (ativas): { id, data, tipo, canal, valorCentavos }.
 * excecoesSangria: Set de categoriaId aprovadas. resolucoes (vigentes): { id, escopo, chave, classificacao, valorCentavos, nota }.
 */
export function conciliar({ mes, lancamentos, contas, referencias, excecoesSangria = new Set(), resolucoes = [] }) {
  const ls = lancamentos.filter((l) => noMes(l.data, mes) && (l.status === undefined || l.status === STATUS.REALIZADO) && l.papel !== PAPEL.SALDO_ANTERIOR);
  const refs = referencias.filter((r) => noMes(r.data, mes));
  const contaPorId = new Map(contas.map((c) => [c.id, c]));
  const resDe = (escopo, chave) => resolucoes.filter((r) => r.escopo === escopo && r.chave === chave);
  const liq = (xs) => soma(xs.map((l) => (l.sentido === SENTIDO.ENTRADA ? l.valorCentavos : -l.valorCentavos)));
  const receita = ls.filter((l) => l.papel === PAPEL.RECEITA_OPERACIONAL);

  // ---- ponte mensal: vendas realizadas → recebimentos efetivos ----
  const vendasRefs = refs.filter((r) => r.tipo === "venda");
  const taxasRefs = refs.filter((r) => r.tipo === "taxa");
  const vendas = vendasRefs.length ? soma(vendasRefs.map((r) => r.valorCentavos)) : null;
  const recebido = liq(receita);
  const diferencaAExplicar = vendas === null ? null : vendas - recebido;
  const taxasPorCanal = new Map();
  for (const r of taxasRefs) taxasPorCanal.set(norm(r.canal) ?? "SEM CANAL", (taxasPorCanal.get(norm(r.canal) ?? "SEM CANAL") ?? 0) + r.valorCentavos);
  const taxasTotal = taxasRefs.length ? soma(taxasRefs.map((r) => r.valorCentavos)) : null;
  const residual = diferencaAExplicar === null || taxasTotal === null ? null : diferencaAExplicar - taxasTotal;
  const chaveMes = `${mes}-01`;
  const resPonte = resDe(ESCOPO.PONTE, chaveMes);
  const ponte = {
    mes, vendasCentavos: vendas, recebidoCentavos: recebido, diferencaAExplicarCentavos: diferencaAExplicar,
    taxas: [...taxasPorCanal].map(([canal, centavos]) => ({ canal, centavos })).sort((a, b) => b.centavos - a.centavos), taxasTotalCentavos: taxasTotal,
    residualCentavos: residual, chave: chaveMes, resolucoes: resPonte, estado: estadoDe(residual, resPonte),
    faltando: [...(vendas === null ? ["vendas"] : []), ...(taxasTotal === null ? ["taxas"] : [])],
    nota: "Residual nunca é presumido como diferença de prazo: só uma classificação manual autorizada o explica.",
  };

  // ---- caixa em espécie por dia: recebido em contas de caixa físico x referência 'dinheiro' ----
  const emCaixa = (l) => contaPorId.get(l.contaId)?.tipo_conta === "caixa_fisico";
  const dias = (...conj) => [...new Set(conj.flat())].sort();
  const diasCaixa = dias(receita.filter(emCaixa).map((l) => l.data), refs.filter((r) => r.tipo === "dinheiro").map((r) => r.data));
  const caixaDias = diasCaixa.map((data) => {
    const rs = refs.filter((r) => r.tipo === "dinheiro" && r.data === data);
    const referencia = rs.length ? soma(rs.map((r) => r.valorCentavos)) : null;
    const fluxo = liq(receita.filter((l) => emCaixa(l) && l.data === data));
    const diferenca = referencia === null ? null : fluxo - referencia;
    const rr = resDe(ESCOPO.CAIXA, data);
    return { data, referenciaCentavos: referencia, fluxoCentavos: fluxo, diferencaCentavos: diferenca, chave: data, resolucoes: rr, estado: estadoDe(diferenca, rr) };
  });

  // ---- sangrias por dia: saídas do caixa físico (exceto exceções aprovadas) x referência 'sangria' ----
  const saidasCaixa = ls.filter((l) => l.sentido === SENTIDO.SAIDA && emCaixa(l));
  const diasSangria = dias(saidasCaixa.map((l) => l.data), refs.filter((r) => r.tipo === "sangria").map((r) => r.data));
  const sangriaDias = diasSangria.map((data) => {
    const rs = refs.filter((r) => r.tipo === "sangria" && r.data === data);
    const referencia = rs.length ? soma(rs.map((r) => r.valorCentavos)) : null;
    const doDia = saidasCaixa.filter((l) => l.data === data);
    const consideradas = doDia.filter((l) => !(l.categoriaId && excecoesSangria.has(l.categoriaId)));
    const excluidas = doDia.filter((l) => l.categoriaId && excecoesSangria.has(l.categoriaId));
    const fluxo = soma(consideradas.map((l) => l.valorCentavos));
    const diferenca = referencia === null ? null : fluxo - referencia;
    const rr = resDe(ESCOPO.SANGRIA, data);
    const porPapel = {};
    for (const l of consideradas) porPapel[l.papel ?? "sem_papel"] = (porPapel[l.papel ?? "sem_papel"] ?? 0) + l.valorCentavos;
    return { data, referenciaCentavos: referencia, fluxoCentavos: fluxo, excluidasCentavos: soma(excluidas.map((l) => l.valorCentavos)), diferencaCentavos: diferenca, porPapel, chave: data, resolucoes: rr, estado: estadoDe(diferenca, rr) };
  });
  const comRefSangria = sangriaDias.filter((d) => d.referenciaCentavos !== null);
  const totalSangria = {
    referenciaCentavos: comRefSangria.length ? soma(comRefSangria.map((d) => d.referenciaCentavos)) : null,
    fluxoCentavos: comRefSangria.length ? soma(comRefSangria.map((d) => d.fluxoCentavos)) : null,
    diferencaCentavos: comRefSangria.length ? soma(comRefSangria.map((d) => d.diferencaCentavos)) : null,
    diasSemReferencia: sangriaDias.filter((d) => d.referenciaCentavos === null && d.fluxoCentavos > 0).length,
    excecoesAplicadasCentavos: soma(sangriaDias.map((d) => d.excluidasCentavos)),
  };

  // ---- por conta: recebido (receita líquida) x vendas e taxas do canal vinculado (informativo; sem classificação por conta) ----
  const porConta = contas.map((c) => {
    const canal = norm(c.canal_referencia);
    const recebidoConta = liq(receita.filter((l) => l.contaId === c.id));
    if (!canal) return { contaId: c.id, nome: c.nome, canal: null, recebidoCentavos: recebidoConta, estado: ESTADO.SEM_VINCULO, diferencaCentavos: null };
    const v = vendasRefs.filter((r) => norm(r.canal) === canal);
    const t = taxasRefs.filter((r) => norm(r.canal) === canal);
    const vendasCanal = v.length ? soma(v.map((r) => r.valorCentavos)) : null;
    const taxasCanal = t.length ? soma(t.map((r) => r.valorCentavos)) : null;
    const diferenca = vendasCanal === null || taxasCanal === null ? null : vendasCanal - recebidoConta - taxasCanal;
    return { contaId: c.id, nome: c.nome, canal, recebidoCentavos: recebidoConta, vendasCentavos: vendasCanal, taxasCentavos: taxasCanal, diferencaCentavos: diferenca, estado: estadoDe(diferenca, []) };
  });

  const itens = [ponte, ...caixaDias, ...sangriaDias];
  const contagem = {};
  for (const i of itens) contagem[i.estado] = (contagem[i.estado] ?? 0) + 1;
  return {
    mes, regime: "caixa", ponte, caixaDias, sangriaDias, totalSangria, porConta,
    resumo: {
      contagemPorEstado: contagem,
      pendenciasAbertas: itens.filter((i) => aberto(i.estado)).length,
      // identidade ESTÁVEL de cada pendência aberta ("escopo:chave"), usada pela exceção de fechamento para comparar CONJUNTOS, não quantidades
      pendenciasAbertasIds: [
        ...(aberto(ponte.estado) ? [`${ESCOPO.PONTE}:${ponte.chave}`] : []),
        ...caixaDias.filter((d) => aberto(d.estado)).map((d) => `${ESCOPO.CAIXA}:${d.chave}`),
        ...sangriaDias.filter((d) => aberto(d.estado)).map((d) => `${ESCOPO.SANGRIA}:${d.chave}`),
      ].sort(),
      semReferencia: ponte.estado === ESTADO.SEM_REFERENCIA && !refs.length,
      referenciasNoMes: refs.length,
    },
  };
}

/** Valida uma classificação manual contra o item atual. Retorna lista de erros (vazia = ok). */
export function validarResolucao(resultado, { escopo, chave, classificacao, valorCentavos, nota }) {
  const erros = [];
  if (!Object.values(ESCOPO).includes(escopo)) return ["escopo inválido"];
  if (!CLASSIFICACOES.includes(classificacao)) erros.push("classificação inválida");
  if (!Number.isSafeInteger(valorCentavos) || valorCentavos === 0) erros.push("valor deve ser um inteiro diferente de zero (em centavos)");
  if (typeof nota !== "string" || nota.trim().length < 5) erros.push("a nota (justificativa) é obrigatória (mín. 5 caracteres)");
  const item = escopo === ESCOPO.PONTE ? (resultado.ponte.chave === chave ? resultado.ponte : null)
    : (escopo === ESCOPO.CAIXA ? resultado.caixaDias : resultado.sangriaDias).find((d) => d.chave === chave);
  if (!item) return [...erros, "item da conciliação não encontrado no período"];
  const dif = escopo === ESCOPO.PONTE ? item.residualCentavos : item.diferencaCentavos;
  if (dif === null || dif === undefined) return [...erros, "o item não tem diferença calculada (sem referência)"];
  if (dif === 0) erros.push("não há diferença a classificar");
  else if (Math.sign(valorCentavos) !== Math.sign(dif)) erros.push("o valor classificado deve ter o mesmo sinal da diferença");
  else {
    const jaExplicado = soma(item.resolucoes.map((r) => r.valorCentavos));
    if (Math.abs(jaExplicado + valorCentavos) > Math.abs(dif)) erros.push("a soma das classificações excede a diferença");
  }
  return erros;
}

/** Pendências de identificação a partir dos lançamentos já gravados (motivos de revisão preservados da importação). */
export function agruparPendencias(lancamentos) {
  const ativos = lancamentos.filter((l) => l.status !== STATUS.CANCELADO);
  const porMotivo = {};
  for (const l of ativos) {
    const motivos = l.revisao_motivos ?? [];
    for (const m of motivos) {
      const g = (porMotivo[m] ??= { quantidade: 0, valorCentavos: 0, pendentes: 0, ids: [] });
      g.quantidade++; g.valorCentavos += Number(l.valor_centavos); if (l.classificacao_pendente) g.pendentes++; g.ids.push(l.id);
    }
  }
  const grupos = new Map();
  for (const l of ativos) {
    const k = [l.data_movimento, l.conta_id, String(l.descricao).trim().toUpperCase(), l.sentido, l.valor_centavos].join("|");
    grupos.set(k, [...(grupos.get(k) ?? []), l.id]);
  }
  const duplicatas = [...grupos.values()].filter((g) => g.length > 1).map((ids) => ({ ids, quantidade: ids.length }));
  const pendentes = ativos.filter((l) => l.classificacao_pendente);
  const terceiros = pendentes.filter((l) => (l.revisao_motivos ?? []).includes("transferencia_sem_contraparte"));
  const liquidoTerceiros = terceiros.reduce((s, l) => s + (l.sentido === SENTIDO.SAIDA ? Number(l.valor_centavos) : -Number(l.valor_centavos)), 0);
  return {
    totalPendentes: pendentes.length, valorPendenteCentavos: pendentes.reduce((s, l) => s + Number(l.valor_centavos), 0),
    porMotivo, possiveisDuplicatas: duplicatas,
    movimentosComTerceiros: { quantidade: terceiros.length, liquidoSaindoCentavos: liquidoTerceiros },
    pendentes: pendentes.map((l) => ({ id: l.id, data: l.data_movimento, descricao: l.descricao, sentido: l.sentido, valorCentavos: Number(l.valor_centavos), contaId: l.conta_id, categoriaId: l.categoria_id, motivos: l.revisao_motivos ?? [], nota: l.nota_revisao ?? null })),
  };
}
