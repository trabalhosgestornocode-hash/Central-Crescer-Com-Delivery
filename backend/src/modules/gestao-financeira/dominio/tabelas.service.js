// Relatórios TABULARES (tela Relatórios) e exportações CSV/XLSX. NÃO há segundo motor de indicadores: tudo reaproveita os mesmos cálculos e fontes
// do domínio homologado (motor.apurar, montarDre, rankingCategorias, serieMovimento, movimentoPorConta, saldosPorConta, conciliação, períodos).
// Contexto (organização/unidade) vem só do gate; filtro de unidade só aceita a unidade do próprio contexto.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { periodo, uuid, enumerado, bad } from "./validacao.js";
import { ApiError } from "../../../shared/ApiError.js";
import { saldosPorConta } from "../../../financeiro-calculos/motor.js";
import { paraEntradaMotor, montarDre, rankingCategorias, serieMovimento, movimentoPorConta } from "../../../financeiro-calculos/relatorios.js";
import { montarCsv, montarXlsx, nomeArquivo, LIMITE_LINHAS_EXPORTACAO } from "../../../financeiro-calculos/exportacao.js";
import { carregarBase, aposAbertura, abrirMapa } from "./relatorios.service.js";

const padrao = { repo: repositorio, db: undefined, agora: () => new Date().toISOString() };
export const LIMITE_LINHAS_TELA = 2000;

const ROTULO_PAPEL = { receita_operacional: "Receita operacional", custo_variavel: "Custo variável", despesa_variavel: "Despesa variável", tributo: "Tributo", despesa_fixa: "Despesa fixa", despesa_pessoal: "Despesa com pessoal", despesa_financeira: "Despesa financeira", financiamento: "Financiamento", transferencia: "Transferência", saldo_anterior: "Saldo anterior" };
const ROTULO_TIPO_CONTA = { banco: "Banco", adquirente: "Adquirente", caixa_fisico: "Caixa físico", carteira_plataforma: "Carteira de plataforma", outra: "Outra" };
const ROTULO_STATUS = { realizado: "Realizado", previsto: "Previsto", cancelado: "Cancelado" };
const ROTULO_ESCOPO = { ponte_mensal: "Ponte do mês", caixa_dia: "Caixa em espécie (dia)", sangria_dia: "Sangria (dia)" };
const ROTULO_CLASSIFICACAO = { prazo: "Diferença de prazo", taxa: "Taxa", ajuste: "Ajuste", estorno: "Estorno", divergencia: "Divergência", outros: "Outros motivos" };

export const CATALOGO = Object.freeze([
  { id: "movimentacoes", titulo: "Histórico de movimentações", descricao: "Todos os lançamentos do período com conta, categoria, situação e pendências.", filtros: ["periodo", "conta", "categoria", "tipo", "status"] },
  { id: "dre", titulo: "Demonstrativo de resultados", descricao: "DRE gerencial em regime de caixa (mesmas fórmulas do dashboard).", filtros: ["periodo", "conta", "categoria"] },
  { id: "fluxo-caixa", titulo: "Fluxo de caixa", descricao: "Entradas, saídas e saldo por dia ou mês (sem saldo anterior).", filtros: ["periodo", "conta", "categoria", "tipo", "agrupar", "transferencias"] },
  { id: "movimentacao-conta", titulo: "Movimentação por conta", descricao: "Entradas, saídas, transferências e saldo calculado por conta.", filtros: ["periodo", "conta", "categoria"] },
  { id: "categorias", titulo: "Análise de categorias", descricao: "Ranking de custos, despesas e tributos.", filtros: ["periodo", "conta"] },
  { id: "conciliacoes", titulo: "Histórico de conciliações", descricao: "Classificações manuais de diferenças (inclusive revogadas).", filtros: ["periodo"] },
  { id: "periodos", titulo: "Situação dos períodos", descricao: "Meses abertos, fechados e reabertos, com o resultado congelado no fechamento.", filtros: ["periodo"] },
]);

const col = (id, rotulo, tipo = "texto") => ({ id, rotulo, tipo });
const soma = (xs) => xs.reduce((s, x) => s + x, 0);

function lerFiltros(c, q, base) {
  if (q?.unidadeId !== undefined && q.unidadeId !== "" && q.unidadeId !== c.unidadeId) {
    throw ApiError.forbidden("Só é possível consultar a unidade do contexto atual.", { codigo: "UNIDADE_FORA_DO_CONTEXTO" });
  }
  const { de, ate } = periodo(q);
  const contaId = uuid(q?.contaId, "contaId", { obrigatorio: false });
  const categoriaId = uuid(q?.categoriaId, "categoriaId", { obrigatorio: false });
  if (contaId && !base.contas.some((x) => x.id === contaId)) throw bad("Conta não encontrada.", "CONTA_INEXISTENTE");
  if (categoriaId && !base.cats.some((x) => x.id === categoriaId)) throw bad("Categoria não encontrada.", "CATEGORIA_INEXISTENTE");
  return {
    de, ate, contaId, categoriaId,
    tipo: enumerado(q?.tipo, "tipo", ["entrada", "saida"], { obrigatorio: false }),
    status: enumerado(q?.status, "status", ["realizado", "previsto", "cancelado"], { obrigatorio: false }),
    agrupar: enumerado(q?.agrupar ?? "dia", "agrupar", ["dia", "mes"]),
    transferencias: q?.transferencias === "true" || q?.transferencias === true,
  };
}

const aplicar = (lancs, f, { usaTipo = true, usaStatus = false, usaCategoria = true } = {}) => lancs.filter((l) =>
  (!f.contaId || l.conta_id === f.contaId) && (!usaCategoria || !f.categoriaId || l.categoria_id === f.categoriaId)
  && (!usaTipo || !f.tipo || l.sentido === f.tipo) && (!usaStatus || !f.status || l.status === f.status));

function metaDe(f, base, { parcial = false, avisos = [], geradoEm, filtradoParcial = false, extra = [] }) {
  const nomeConta = f.contaId ? base.contas.find((x) => x.id === f.contaId)?.nome : "";
  const nomeCat = f.categoriaId ? base.cats.find((x) => x.id === f.categoriaId)?.nome : "";
  const filtros = [
    { rotulo: "Conta", valor: nomeConta ?? "" }, { rotulo: "Categoria", valor: nomeCat ?? "" },
    { rotulo: "Tipo", valor: f.tipo ? (f.tipo === "entrada" ? "Entradas" : "Saídas") : "" }, { rotulo: "Situação", valor: f.status ? ROTULO_STATUS[f.status] : "" }, ...extra,
  ];
  const av = [...avisos];
  if (filtradoParcial) av.push("Relatório filtrado: os números cobrem apenas o recorte pedido e não representam o resultado completo da unidade.");
  return { regime: "caixa", periodo: { de: f.de ?? null, ate: f.ate ?? null }, filtros, parcial: parcial || filtradoParcial, avisos: av, geradoEm };
}

async function gerarRelatorio(c, id, q, deps) {
  const def = CATALOGO.find((x) => x.id === id);
  if (!def) throw ApiError.notFound("Relatório não encontrado.");
  const agora = (deps.agora ?? padrao.agora)();
  const [contasL, catsL] = await Promise.all([deps.repo.listarContas(c, deps.db), deps.repo.listarPlanoContas(c, deps.db)]);
  const listas = { contas: contasL, cats: catsL };
  const f = lerFiltros(c, q, listas);
  const per = { de: f.de ?? undefined, ate: f.ate ?? undefined };
  const filtrado = Boolean(f.contaId || f.categoriaId);
  const nomes = { conta: new Map(listas.contas.map((x) => [x.id, x.nome])), cat: new Map(listas.cats.map((x) => [x.id, x])) };

  if (id === "conciliacoes") {
    const rs = await deps.repo.listarResolucoes(c, { de: f.de, ate: f.ate, incluirRevogadas: true }, deps.db);
    const linhas = rs.map((r) => ({ data: r.chave, escopo: ROTULO_ESCOPO[r.escopo] ?? r.escopo, classificacao: ROTULO_CLASSIFICACAO[r.classificacao] ?? r.classificacao, valor: Number(r.valor_centavos), diferenca: Number(r.diferenca_no_momento_centavos), nota: r.nota, situacao: r.status === "vigente" ? "Vigente" : "Revogada", motivoRevogacao: r.motivo_revogacao ?? "", registradaEm: String(r.created_at ?? "").slice(0, 10) }));
    return { ...def, colunas: [col("data", "Referência", "data"), col("escopo", "Escopo"), col("classificacao", "Classificação"), col("valor", "Valor classificado (R$)", "moeda"), col("diferenca", "Diferença no momento (R$)", "moeda"), col("nota", "Justificativa"), col("situacao", "Situação"), col("motivoRevogacao", "Motivo da revogação"), col("registradaEm", "Registrada em", "data")], linhas, meta: metaDe(f, listas, { geradoEm: agora, avisos: linhas.length ? [] : ["Nenhuma classificação registrada no período."] }) };
  }
  if (id === "periodos") {
    const ps = (await deps.repo.listarPeriodos(c, deps.db)).filter((p) => (!f.de || String(p.mes).slice(0, 7) >= f.de.slice(0, 7)) && (!f.ate || String(p.mes).slice(0, 7) <= f.ate.slice(0, 7))).sort((a, b) => String(a.mes).localeCompare(String(b.mes)));
    const linhas = ps.map((p) => ({ mes: String(p.mes).slice(0, 7), situacao: { aberto: "Aberto", fechado: "Fechado", reaberto: "Reaberto" }[p.status] ?? p.status, versao: p.versao, fechadoEm: p.fechado_em ? String(p.fechado_em).slice(0, 10) : null, reabertoEm: p.reaberto_em ? String(p.reaberto_em).slice(0, 10) : null, motivoReabertura: p.motivo_reabertura ?? "", resultado: p.snapshot?.indicadores?.resultadoGerencial ?? null, pendencias: p.snapshot?.pendenciasNoFechamento ?? null }));
    return { ...def, colunas: [col("mes", "Mês"), col("situacao", "Situação"), col("versao", "Versão", "inteiro"), col("fechadoEm", "Fechado em", "data"), col("reabertoEm", "Reaberto em", "data"), col("motivoReabertura", "Motivo da reabertura"), col("resultado", "Resultado gerencial no fechamento (R$)", "moeda"), col("pendencias", "Pendências no fechamento", "inteiro")], linhas, meta: metaDe(f, listas, { geradoEm: agora, avisos: linhas.length ? [] : ["Nenhum período registrado no intervalo."] }) };
  }

  const base = await carregarBase(c, per, { repo: deps.repo, db: deps.db });
  const lancs = aplicar(base.lancs, f, { usaTipo: id === "movimentacoes" || id === "fluxo-caixa", usaStatus: id === "movimentacoes", usaCategoria: id !== "categorias" });
  const avisosPend = lancs.filter((l) => l.status !== "cancelado" && (!l.categoria_id || l.classificacao_pendente)).length
    ? [`${lancs.filter((l) => l.status !== "cancelado" && (!l.categoria_id || l.classificacao_pendente)).length} lançamento(s) pendentes de classificação neste relatório.`] : [];

  if (id === "movimentacoes") {
    const ord = [...lancs].sort((a, b) => String(a.data_movimento).localeCompare(String(b.data_movimento)) || String(a.id).localeCompare(String(b.id)));
    const linhas = ord.map((l) => { const cat = nomes.cat.get(l.categoria_id); return { data: l.data_movimento, descricao: l.descricao, conta: nomes.conta.get(l.conta_id) ?? "", categoria: cat?.nome ?? "", grupo: cat ? (ROTULO_PAPEL[cat.papel] ?? cat.papel) : "Sem classificação", entrada: l.sentido === "entrada" ? Number(l.valor_centavos) : null, saida: l.sentido === "saida" ? Number(l.valor_centavos) : null, situacao: ROTULO_STATUS[l.status] ?? l.status, pendente: Boolean(l.classificacao_pendente || !l.categoria_id), origem: l.origem === "importacao" ? "Importado" : "Manual", nota: l.nota_revisao ?? "" }; });
    const real = ord.filter((l) => l.status === "realizado");
    return { ...def, colunas: [col("data", "Data", "data"), col("descricao", "Descrição"), col("conta", "Conta"), col("categoria", "Categoria"), col("grupo", "Grupo"), col("entrada", "Entrada (R$)", "moeda"), col("saida", "Saída (R$)", "moeda"), col("situacao", "Situação"), col("pendente", "Pendente", "booleano"), col("origem", "Origem"), col("nota", "Nota de revisão")], linhas, totais: { entrada: soma(real.filter((l) => l.sentido === "entrada").map((l) => Number(l.valor_centavos))), saida: soma(real.filter((l) => l.sentido === "saida").map((l) => Number(l.valor_centavos))) }, meta: metaDe(f, listas, { geradoEm: agora, parcial: avisosPend.length > 0, avisos: [...avisosPend, "Totais consideram apenas lançamentos realizados (previstos e cancelados não entram)."], filtradoParcial: false }) };
  }

  const mov = paraEntradaMotor(lancs, base.categoriasPorId);
  if (id === "dre") {
    const dre = montarDre(mov, base.categoriasPorId);
    const linhas = [];
    for (const l of dre.linhas) {
      if (l.tipo === "percentual") { linhas.push({ linha: l.rotulo, natureza: "Percentual", valor: null, pctReceita: l.bps }); continue; }
      linhas.push({ linha: l.rotulo, natureza: "Total", valor: l.centavos, pctReceita: l.percentualReceitaBps });
      for (const d of l.detalhes ?? []) linhas.push({ linha: `  · ${d.nome}`, natureza: "Detalhe (já incluído na linha acima)", valor: d.centavos, pctReceita: dre.apuracao.receitaOperacional > 0 ? Math.round((d.centavos * 10000) / dre.apuracao.receitaOperacional) : null });
    }
    return { ...def, colunas: [col("linha", "Linha"), col("natureza", "Natureza"), col("valor", "Valor (R$)", "moeda"), col("pctReceita", "% da receita (%)", "pct")], linhas, meta: metaDe(f, listas, { geradoEm: agora, parcial: dre.parcial, avisos: dre.avisos, filtradoParcial: filtrado }) };
  }
  if (id === "fluxo-caixa") {
    const serie = serieMovimento(mov, { agrupar: f.agrupar, excluirTransferencias: !f.transferencias });
    let acum = 0;
    const linhas = serie.map((s) => { acum += s.saldo; return { periodo: s.periodo, entradas: s.entradas, saidas: s.saidas, saldo: s.saldo, acumulado: acum }; });
    return { ...def, colunas: [col("periodo", f.agrupar === "mes" ? "Mês" : "Dia", f.agrupar === "mes" ? "texto" : "data"), col("entradas", "Entradas (R$)", "moeda"), col("saidas", "Saídas (R$)", "moeda"), col("saldo", "Saldo do período (R$)", "moeda"), col("acumulado", "Acumulado (R$)", "moeda")], linhas, totais: { entradas: soma(serie.map((s) => s.entradas)), saidas: soma(serie.map((s) => s.saidas)), saldo: soma(serie.map((s) => s.saldo)) }, meta: metaDe(f, listas, { geradoEm: agora, avisos: ["Variação do caixa no período: não inclui o saldo anterior das contas.", f.transferencias ? "Transferências entre contas INCLUÍDAS (entradas e saídas internas aparecem)." : "Transferências entre contas excluídas (efeito consolidado zero)."], extra: [{ rotulo: "Agrupamento", valor: f.agrupar === "mes" ? "Mensal" : "Diário" }] }) };
  }
  if (id === "categorias") {
    const r = rankingCategorias(mov, base.categoriasPorId);
    const linhas = r.itens.map((i, k) => ({ posicao: k + 1, categoria: i.nome, grupo: ROTULO_PAPEL[i.papel] ?? i.papel, valor: i.centavos, participacao: i.participacaoBps, acumulada: i.acumuladaBps }));
    return { ...def, colunas: [col("posicao", "#", "inteiro"), col("categoria", "Categoria"), col("grupo", "Grupo"), col("valor", "Valor (R$)", "moeda"), col("participacao", "% do total (%)", "pct"), col("acumulada", "% acumulado (%)", "pct")], linhas, totais: { valor: r.totalCentavos }, meta: metaDe(f, listas, { geradoEm: agora, avisos: [...avisosPend, "Fora desta análise: transferências, saldo anterior e principal de financiamentos."], filtradoParcial: Boolean(f.contaId) }) };
  }
  if (id === "movimentacao-conta") {
    const contasAlvo = listas.contas.filter((x) => x.ativo && (!f.contaId || x.id === f.contaId));
    const mp = movimentoPorConta(mov, contasAlvo);
    const ateBase = await carregarBase(c, { de: undefined, ate: per.ate }, { repo: deps.repo, db: deps.db });
    const movAte = paraEntradaMotor(aplicar(ateBase.lancs, f, { usaTipo: false, usaCategoria: true }), ateBase.categoriasPorId);
    const sal = saldosPorConta(contasAlvo, abrirMapa(base.aberturas), aposAbertura(movAte, base.aberturas));
    const porId = new Map(sal.contas.map((s) => [s.contaId, s]));
    const semSaldo = Boolean(f.categoriaId);
    const linhas = mp.map((m) => { const s = porId.get(m.contaId); const ct = listas.contas.find((x) => x.id === m.contaId); return { conta: m.nome, tipoConta: ROTULO_TIPO_CONTA[ct?.tipo_conta] ?? ct?.tipo_conta ?? "", abertura: s?.aberturaCentavos ?? null, entradas: m.entradas, saidas: m.saidas, transfEntrada: m.transferenciasEntrada, transfSaida: m.transferenciasSaida, variacao: m.variacao, saldo: semSaldo ? null : (s?.saldoCentavos ?? null), situacao: semSaldo ? "Saldo indisponível com filtro de categoria" : (s?.parcial ? "Saldo parcial: abertura desconhecida" : "Saldo calculado (não conciliado com extrato)") }; });
    const todasConhecidas = linhas.length > 0 && linhas.every((l) => l.saldo !== null);
    return { ...def, colunas: [col("conta", "Conta"), col("tipoConta", "Tipo"), col("abertura", "Abertura (R$)", "moeda"), col("entradas", "Entradas (R$)", "moeda"), col("saidas", "Saídas (R$)", "moeda"), col("transfEntrada", "Transferências recebidas (R$)", "moeda"), col("transfSaida", "Transferências enviadas (R$)", "moeda"), col("variacao", "Variação (R$)", "moeda"), col("saldo", "Saldo calculado (R$)", "moeda"), col("situacao", "Situação do saldo")], linhas, totais: { entradas: soma(linhas.map((l) => l.entradas)), saidas: soma(linhas.map((l) => l.saidas)), variacao: soma(linhas.map((l) => l.variacao)), saldo: todasConhecidas ? soma(linhas.map((l) => l.saldo)) : null }, meta: metaDe(f, listas, { geradoEm: agora, parcial: linhas.some((l) => l.saldo === null), avisos: ["Saldos são calculados a partir dos lançamentos; só são saldos conciliados após conferência com extrato externo.", ...(todasConhecidas ? [] : ["Total de saldos indisponível: há contas com abertura desconhecida (ou filtro de categoria)."])] }) };
  }
  throw ApiError.notFound("Relatório não encontrado.");
}

export async function catalogo(ctx) { exigirContexto(ctx); return CATALOGO; }

/** JSON para a tela (limitado) — mesma estrutura usada na exportação. */
export async function gerar(ctx, id, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await gerarRelatorio(c, id, q, deps);
  const total = r.linhas.length;
  const truncado = total > LIMITE_LINHAS_TELA;
  return { ...r, linhas: truncado ? r.linhas.slice(0, LIMITE_LINHAS_TELA) : r.linhas, total, truncado };
}

/** Arquivo (CSV/XLSX) com os MESMOS dados da tela, completos. Recusa volumes acima do limite. */
export async function exportar(ctx, id, formato, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const fmt = enumerado(formato, "formato", ["csv", "xlsx"]);
  const r = await gerarRelatorio(c, id, q, deps);
  if (r.linhas.length > LIMITE_LINHAS_EXPORTACAO) throw bad(`O relatório tem ${r.linhas.length} linhas (limite ${LIMITE_LINHAS_EXPORTACAO}). Reduza o período ou use filtros.`, "EXPORTACAO_GRANDE");
  const conteudo = fmt === "csv" ? montarCsv(r) : montarXlsx(r);
  return { conteudo, tipo: fmt === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", nome: nomeArquivo(r, fmt), linhas: r.linhas.length };
}
