// CENTRAL ÚNICA DE CONFERÊNCIAS: reúne, num lugar só, o que depende de decisão humana (ajustes estimados, rateios propostos, juros presumidos,
// contas vencidas sem pagamento, categorias sem regra) e compara os indicadores do sistema com a apresentação oficial, sem esconder diferença.
// Este serviço só LÊ e organiza: cada ação (confirmar, aprovar, classificar) usa o endpoint próprio, com a sua permissão, justificativa e trilha.
// Nada vira "confirmado" aqui.
import * as repositorio from "./repositorio.js";
import * as vendas from "./vendasCanal.service.js";
import * as obr from "./obrigacoes.service.js";
import * as f152 from "./f152.service.js";
import { linhaPendenciaDocumental } from "./pendenciasDocumentais.service.js";
import * as painelSvc from "./painel.service.js";
import { exigirContexto } from "./contexto.js";
import { mesAno } from "./validacao.js";
import { sugerirTransferencias, ehTransferenciaProvavel } from "../../../financeiro-calculos/transferenciasInternas.js";
import { regrasPadrao } from "../../../financeiro-calculos/regrasReferencia.js";
import { brl } from "../../../financeiro-calculos/composicao.js";

const padrao = { repo: repositorio, db: undefined };
/** O que o Portal do Parceiro precisa informar para confirmar o ajuste ESTIMADO do iFood. Texto de coleta: não afirma o que o portal mostra. */
export const checklistIfood = (a, { mes, canal } = {}) => {
  const [ano, m] = (mes ?? "").split("-").map(Number), dd = ano ? String(new Date(Date.UTC(ano, m, 0)).getUTCDate()).padStart(2, "0") : null;
  const br = (c) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  const periodo = ano ? `01/${String(m).padStart(2, "0")}/${ano} a ${dd}/${String(m).padStart(2, "0")}/${ano}` : "o mês da competência";
  const painel = canal?.painelCentavos, base = canal?.gerencialCentavos;
  return {
    onde: `Portal do Parceiro iFood → relatórios de pedidos/financeiro de ${periodo} (pedidos concluídos)`,
    precisaInformar: [
      `Quantidade de pedidos concluídos no mês${canal?.vendasQtd != null ? ` (conferir com os ${canal.vendasQtd} do relatório de vendas)` : ""}.`,
      `Valor bruto dos itens vendidos (sem taxa de entrega e sem descontos).${base != null ? ` Para a base da DRE fechar, deve ser ${br(base)}.` : ""}`,
      "Total da taxa de entrega cobrada nos pedidos do mês.",
      "Total de descontos/cupons dos pedidos do mês, separando o que a loja custeou do que o iFood custeou.",
    ],
    conta: `${painel != null && base != null ? `Painel (${br(painel)}) − base da DRE (${br(base)}) = ` : "Diferença a explicar: "}${brl(a.valorCentavos)}. O ajuste só se confirma se taxa de entrega + descontos do Portal, para o mesmo conjunto de pedidos, somarem exatamente esse valor.`,
    comoConfirmar: "Em “Confirmar com evidência”, escreva o nome do relatório, o período e os valores acima. Se a soma não fechar, NÃO confirme: registre a diferença como divergência.",
    situacao: "estimado, a confirmar no Portal do Parceiro",
  };
};
/** Campos que TODA pendência mostra: motivo, documento/evidência necessária, responsável pela conferência e status. Só descreve; nunca confirma nada. */
export const COMPLEMENTO_PENDENCIA = {
  ajuste_vendas: { responsavel: "Contadora (iFood: com o Portal do Parceiro)", evidenciaNecessaria: "Relatório do canal com taxa de entrega e descontos do mesmo período e dos mesmos pedidos; a soma deve fechar com o ajuste.", status: "pendente" },
  rateios: { responsavel: "Contadora", evidenciaNecessaria: "Critério e documento de cada rateio (período de produção ou dias de consumo) e as competências afetadas.", status: "pendente" },
  juros_presumido: { responsavel: "Contadora", evidenciaNecessaria: "Boleto, extrato ou nota que mostre juros/multa sobre o valor original da conta.", status: "pendente" },
  conta_sem_pagamento: { responsavel: "Proprietário ou operador financeiro", evidenciaNecessaria: "Comprovante do pagamento com a conta de saída, ou confirmação de que a conta segue em aberto.", status: "aguardando_comprovacao" },
  categoria_sem_regra: { responsavel: "Contadora", evidenciaNecessaria: "Definição da regra gerencial (critério e grupo da DRE) de cada categoria.", status: "pendente" },
  divergencia_canais: { responsavel: "Contadora", evidenciaNecessaria: "Relatório de vendas por canal e vendas diárias do mês, para localizar a diferença.", status: "pendente" },
  origem_pendente: { responsavel: "Proprietário", evidenciaNecessaria: "Comprovante bancário do pagamento (de qual conta o dinheiro saiu).", status: "aguardando_comprovacao" },
  transferencias_internas: { responsavel: "Contadora ou operador de conciliação", evidenciaNecessaria: "Extrato das duas contas mostrando a saída e a entrada correspondente.", status: "pendente" },
  classificacao_pendente: { responsavel: "Contadora", evidenciaNecessaria: "Documento que identifique a natureza e a categoria de cada lançamento.", status: "pendente" },
  pagamento_terceiro: { responsavel: "Proprietário e contadora", evidenciaNecessaria: "Recibo ou comprovante do pagamento feito pelo terceiro e o combinado de reembolso.", status: "aguardando_comprovacao" },
};
const STATUS_ROTULO = { pendente: "Pendente", estimado: "Estimado", aguardando_comprovacao: "Aguardando comprovação" };
/** Completa a pendência sem sobrescrever o que ela já traz (checklist próprio, evidências etc.). Ajuste ainda 'estimado' fica com status ESTIMADO. */
export function completarPendencia(i) {
  const base = COMPLEMENTO_PENDENCIA[i.tipo];
  if (!base) return i;
  const status = i.tipo === "ajuste_vendas" ? "estimado" : base.status;
  return { motivo: i.descricao, ...base, status, statusRotulo: STATUS_ROTULO[status], ...i, ...(i.tipo === "ajuste_vendas" ? { status, statusRotulo: STATUS_ROTULO[status] } : {}) };
}
const fim = (ym) => { const [a, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };

/** Explica uma diferença só quando ela bate EXATAMENTE com um item (ou a soma de dois) conhecido; senão diz que não há explicação automática. */
export function explicarDiferenca(diferencaCentavos, candidatos) {
  const alvo = Math.abs(diferencaCentavos);
  if (!alvo) return null;
  const um = candidatos.find((c) => c.valorCentavos === alvo);
  if (um) return { tipo: "item", texto: `${um.descricao} (R$ ${(um.valorCentavos / 100).toFixed(2).replace(".", ",")}) — ${um.motivo}` };
  for (let i = 0; i < candidatos.length; i++) for (let j = i + 1; j < candidatos.length; j++) if (candidatos[i].valorCentavos + candidatos[j].valorCentavos === alvo) return { tipo: "soma", texto: `${candidatos[i].descricao} + ${candidatos[j].descricao}` };
  return null;
}

export async function listar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const [pontes, rateios, juros, dre, obrs, pags, forn, plano] = await Promise.all([
    deps.repo.listarVendasCanal ? vendas.listar(c, { mes }, deps) : null, deps.repo.listarRateios ? f152.listarRateios(c, { mes }, deps) : { itens: [] }, obr.jurosDoMes(c, { mes }, deps),
    painelSvc.dreReferencia(c, { mes }, deps), deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarPagamentos(c, deps.db), deps.repo.listarFornecedores(c, deps.db), deps.repo.listarPlanoContas(c, deps.db)]);
  const itens = [];
  const add = (i) => itens.push({ gravidade: "atencao", ...i });

  if (!dre.regrasAprovadas) add({ id: "metodologia", tipo: "metodologia", titulo: "Metodologia gerencial ainda não aprovada pela contadora", descricao: `Regras na versão ${dre.versaoRegras}. Os valores são calculados dos registros e nada foi ajustado para coincidir com a apresentação.`, geral: true, acao: null });
  for (const a of pontes?.pendentes ?? []) add({ id: `ajuste:${a.id}`, tipo: "ajuste_vendas", titulo: `Ajuste de vendas estimado — ${a.canal}`, descricao: `${a.descricao}. Leva o total do painel à base da DRE; ainda não foi confirmado.`, valorCentavos: a.valorCentavos, canal: a.canal,
    evidencias: a.evidencia ? [a.evidencia] : [], checklist: /ifood/i.test(a.canal) && a.tipo === "estimativa" ? checklistIfood(a, { mes, canal: (pontes?.canais ?? []).find((x) => x.canal === a.canal) }) : null, acao: { tipo: "confirmar_ajuste", rotulo: "Confirmar com evidência", metodo: "POST", caminho: `/vendas-ajustes/${a.id}/confirmar`, exige: ["evidencia"], permissao: "classificar" } });
  const propostos = (rateios.itens ?? []).filter((x) => x.status === "proposto");
  if (propostos.length) add({ id: "rateios", tipo: "rateios", titulo: `Rateios propostos (${propostos.length}) — aprovação da contadora`, descricao: "Distribuem o custo de compras e entregas entre competências. Revise valores, competências, critérios e evidências numa tela única.",
    valorCentavos: propostos.reduce((x, r) => x + r.valorElegivelCentavos, 0), acao: { tipo: "aprovar_rateios", rotulo: "Revisar e aprovar", metodo: "TELA", permissao: "classificar" },
    itens: propostos.map((r) => ({ id: r.id, obrigacao: r.obrigacao?.descricao ?? "obrigação", fornecedor: r.obrigacao?.fornecedor ?? null, categoria: r.obrigacao?.categoria ?? null, competenciaObrigacao: r.obrigacao?.competencia ?? null, valorOriginalCentavos: r.obrigacao?.valorOriginalCentavos ?? null,
      valorElegivelCentavos: r.valorElegivelCentavos, criterio: r.criterio, justificativa: r.justificativa, evidencia: r.origemDocumental ?? null, parcelas: r.parcelas, caminhoAprovar: `/rateios/${r.id}/aprovar` })) });
  for (const j of juros.relacionadas.filter((x) => x.natureza === "presumido")) {
    const pct = (j.percentualBps / 100).toFixed(2).replace(".", ",");
    add({ id: `juros:${j.obrigacaoId}`, tipo: "juros_presumido", titulo: `Acréscimo presumido — ${j.descricao}`, descricao: `Pago ${brl(j.pagoCentavos)} sobre original ${brl(j.valorOriginalCentavos)} (+${pct}%), em ${j.pagoEm.map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`).join(", ")}. Presumido até alguém classificar.${j.quitada ? "" : " A conta ainda não está quitada: quitar e classificar são a mesma decisão."}`,
      valorCentavos: j.acrescimoTotalCentavos, sugestao: { natureza: "juros", evidencia: "Apresentação da contadora 09/2026, slide 6 (juros por pagamento em atraso).", motivo: `Juros por pagamento em atraso (venc. ${j.vencimento.slice(8, 10)}/${j.vencimento.slice(5, 7)}): pago ${brl(j.pagoCentavos)} sobre ${brl(j.valorOriginalCentavos)}. Apresentação 09/2026, slide 6.` },
      acao: { tipo: "classificar_acrescimo", rotulo: j.quitada ? "Aprovar classificação como juros" : "Aprovar: quitar e classificar como juros", metodo: "POST", caminho: j.quitada ? `/contas-pagar/${j.obrigacaoId}/classificar` : `/contas-pagar/${j.obrigacaoId}/quitar-e-classificar`, exige: ["natureza", "motivo"], permissao: j.quitada ? "classificar" : "classificar + conciliar" } });
  }
  const fornNome = new Map(forn.map((f) => [f.id, f.nome])), catPor = new Map(plano.map((p) => [p.id, p]));
  const comPagamento = new Set(pags.filter((p) => p.status !== "cancelado").map((p) => p.obrigacao_id));
  const vencidasSemPagamento = obrs.filter((o) => o.status === "aberta" && !comPagamento.has(o.id) && String(o.vencimento).slice(0, 10) <= fim(mes) && String(o.vencimento).slice(0, 7) >= mes);
  for (const o of vencidasSemPagamento) add({ id: `vencida:${o.id}`, tipo: "conta_sem_pagamento", titulo: `Conta vencida sem pagamento registrado — ${o.descricao}`, descricao: `Venceu em ${String(o.vencimento).slice(8, 10)}/${String(o.vencimento).slice(5, 7)}. Se foi paga, é preciso registrar o pagamento com a conta de saída; o sistema não presume a origem bancária.`,
    valorCentavos: Number(o.valor_original_centavos), categoria: catPor.get(o.categoria_id)?.nome ?? null, fornecedor: fornNome.get(o.fornecedor_id) ?? null, acao: { tipo: "registrar_pagamento", rotulo: "Registrar pagamento", metodo: "IR", rota: "fin-contas-a-pagar", exige: [], permissao: "lancar" } });
  if ((dre.pendencias.categoriasSemRegraNoPlano ?? []).length) add({ id: "sem_regra", tipo: "categoria_sem_regra", titulo: "Categorias sem regra gerencial", descricao: dre.pendencias.categoriasSemRegraNoPlano.join(", "), acao: null });
  if (pontes && !pontes.baseConfere && pontes.canais.length) add({ id: "base_canais", tipo: "divergencia_canais", gravidade: "divergencia", titulo: "Base por canal difere do faturamento bruto oficial", descricao: `A base gerencial por canal (R$ ${pontes.gerencialCentavos / 100}) difere do bruto oficial.`, valorCentavos: pontes.diferencaBaseCentavos, acao: null });

  // pagamento reconhecido no resultado, com a conta de saída ainda desconhecida
  const contasLista = await deps.repo.listarContas(c, deps.db);
  for (const p of pags.filter((x) => x.status !== "cancelado" && x.origem_pagamento === "origem_pendente")) {
    const o = obrs.find((x) => x.id === p.obrigacao_id);
    add({ id: `origem:${p.id}`, tipo: "origem_pendente", titulo: `Origem do pagamento pendente — ${o?.descricao ?? "pagamento"}`, descricao: `Pago em ${String(p.data_pagamento).slice(8, 10)}/${String(p.data_pagamento).slice(5, 7)} e reconhecido na despesa. Falta informar de qual conta saiu; até lá não há saída bancária registrada nem conciliação. ${p.observacao ?? ""}`,
      valorCentavos: Number(p.valor_centavos), evidencias: p.observacao ? [p.observacao] : [], contas: contasLista.filter((x) => x.ativo !== false).map((x) => ({ id: x.id, nome: x.nome })),
      acao: { tipo: "resolver_origem", rotulo: "Informar a conta de saída", metodo: "POST", caminho: `/contas-pagar/pagamentos/${p.id}/origem`, exige: ["contaId"], permissao: "conciliar" } });
  }
  // transferências internas sem vínculo (ex.: Stone → Unicred): proposta com evidência, sem confirmação automática
  const idsProposta = new Set();   // lançamentos que já aparecem numa proposta de transferência (não duplicar a pendência)
  if (deps.repo.listarTransferencias) {
    const ini = `${mes}-01`, fimM = fim(mes);
    const lancs = await deps.repo.listarTodosLancamentos(c, { de: ini, ate: `${new Date(Date.parse(fimM) + 5 * 86400000).toISOString().slice(0, 10)}` }, deps.db);
    const multiplas = deps.repo.listarTransferenciasMultiplas ? await deps.repo.listarTransferenciasMultiplas(c, deps.db) : [];   // 155: saída ⇄ 2–3 entradas já conciliadas
    const ligadas = new Set([...(await deps.repo.listarTransferencias(c, deps.db)).filter((t) => t.status !== "cancelada").flatMap((t) => [t.lancamento_saida_id, t.lancamento_entrada_id]),
      ...multiplas.flatMap((m) => [m.lancamento_saida_id, ...m.entradas.map((e) => e.lancamento_entrada_id)])]);
    const papel = new Map(plano.map((x) => [x.id, x.papel])), contaNome = new Map(contasLista.map((x) => [x.id, x.nome]));
    const livres = lancs.filter((l) => l.status === "realizado" && !ligadas.has(l.id) && ehTransferenciaProvavel(l, papel));
    const saidas = livres.filter((l) => l.sentido === "saida" && String(l.data_movimento).slice(0, 7) === mes), entradas = livres.filter((l) => l.sentido === "entrada");
    if (saidas.length) {
      const props = sugerirTransferencias(saidas, entradas);
      const desc = (l) => ({ id: l.id, data: String(l.data_movimento).slice(0, 10), conta: contaNome.get(l.conta_id) ?? "—", valorCentavos: Number(l.valor_centavos), descricao: l.descricao });
      const linhas = props.map((x) => ({ saida: desc(x.saida), status: x.status, contrapartidas: x.contrapartidas.map(desc), alternativas: x.alternativas.map((g) => g.map(desc)),
        vincular: x.status === "um_para_um" ? { caminho: "/transferencias/vincular", corpo: { saidaId: x.saida.id, entradaId: x.contrapartidas[0].id } } : null,
        vincularMultipla: x.status === "um_para_varios" ? { caminho: "/transferencias/vincular-multipla", corpo: { saidaId: x.saida.id, entradaIds: x.contrapartidas.map((e) => e.id) }, exigeJustificativa: true } : null }));
      for (const l of linhas) { idsProposta.add(l.saida.id); l.contrapartidas.forEach((x) => idsProposta.add(x.id)); }
      const cont = (st) => linhas.filter((l) => l.status === st).length;
      const comPar = linhas.filter((l) => l.status !== "sem_contrapartida"), sem = linhas.filter((l) => l.status === "sem_contrapartida");
      const total = comPar.reduce((a, l) => a + l.saida.valorCentavos, 0);
      if (comPar.length) add({ id: "transferencias", tipo: "transferencias_internas", titulo: `${comPar.length} saída(s) de transferência com contrapartida proposta (${brl(total)})`,
        descricao: `Proposta de pareamento, nada confirmado: ${cont("um_para_um")} com uma entrada de mesmo valor (vinculável), ${cont("um_para_varios")} em que a soma de 2 a 3 entradas fecha exatamente (vincula-se 1 saída a 2–3 entradas só com decisão humana e justificativa: exige decisão antes de vincular), ${cont("ambiguo")} ambíguas.${sem.length ? ` Outras ${sem.length} saídas parecidas com transferência não têm contrapartida de mesmo valor e ficam fora desta proposta.` : ""}`,
        valorCentavos: total, linhas: comPar, outras: sem, acao: { tipo: "vincular_transferencias", rotulo: "Revisar vínculos", metodo: "TELA", permissao: "conciliar" } });
    }
  }
  // pagamento feito por terceiro (ex.: sócia): reconhecido como despesa e dívida, mas sem saída do caixa da empresa; precisa de comprovante e combinado de reembolso
  for (const p of pags.filter((x) => x.status !== "cancelado" && x.origem_pagamento === "terceiro" && String(x.data_pagamento).slice(0, 7) === mes)) {
    const o = obrs.find((x) => x.id === p.obrigacao_id);
    add({ id: `terceiro:${p.id}`, tipo: "pagamento_terceiro", titulo: `Pagamento feito por terceiro — ${o?.descricao ?? "pagamento"}`, descricao: `Pago em ${String(p.data_pagamento).slice(8, 10)}/${String(p.data_pagamento).slice(5, 7)} por ${p.terceiro_nome ?? "terceiro"}. Não saiu do caixa da empresa; o valor segue como dívida até haver comprovante e acordo de reembolso. ${p.observacao ?? ""}`.trim(),
      valorCentavos: Number(p.valor_centavos), evidencias: p.observacao ? [p.observacao] : [], acao: null });
  }
  // lançamentos que o sistema não consegue classificar sozinho (ex.: Pix com parte a identificar): uma pendência só, com a lista; nada é reclassificado aqui
  if (deps.repo.listarTodosLancamentos) {
    const doMes = (await deps.repo.listarTodosLancamentos(c, { de: `${mes}-01`, ate: fim(mes) }, deps.db)).filter((l) => l.status !== "cancelado" && l.classificacao_pendente && !idsProposta.has(l.id));
    const nomeConta = new Map((await deps.repo.listarContas(c, deps.db)).map((x) => [x.id, x.nome]));
    if (doMes.length) add({ id: "classificacao_pendente", tipo: "classificacao_pendente", titulo: `${doMes.length} lançamento(s) com classificação pendente`, descricao: "Lançamentos marcados como pendentes de classificação ou de identificação de parte do valor. Nenhum foi reclassificado ou conciliado para eliminar a diferença.",
      valorCentavos: doMes.reduce((a, l) => a + Number(l.valor_centavos), 0), itens: doMes.map((l) => ({ id: l.id, data: String(l.data_movimento).slice(0, 10), conta: nomeConta.get(l.conta_id) ?? "—", sentido: l.sentido, valorCentavos: Number(l.valor_centavos), descricao: l.descricao, nota: l.nota_revisao ?? null })), acao: null });
  }
  // períodos: contas do mês anterior pagas neste mês, e contas deste mês pagas no seguinte (só categorias por COMPETÊNCIA: compras e entregas)
  const regras = regrasPadrao(plano);
  const porCompetencia = new Set(plano.filter((p) => regras.porCategoria[p.nome]?.criterio === "competencia").map((p) => p.id));
  const mesAntes = (() => { const [a, m] = mes.split("-").map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; })();
  const mesDepois = (() => { const [a, m] = mes.split("-").map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`; })();
  const obrPor = new Map(obrs.map((o) => [o.id, o])), rat = deps.repo.listarRateios ? await f152.rateiosParaDre(c, deps) : [];
  const pagsEmpresa = pags.filter((p) => p.status !== "cancelado" && (p.origem_pagamento ?? "conta") !== "terceiro");   // pago por terceiro não saiu do caixa da empresa
  const noMes = (d, m) => String(d).slice(0, 7) === m;
  const parcela = (oid, m) => rat.filter((r) => r.obrigacaoChave === oid && r.competencia === m).reduce((a, r) => a + r.valorCentavos, 0);
  const anterior = [];
  for (const o of obrs.filter((x) => porCompetencia.has(x.categoria_id) && x.status !== "cancelada")) {
    const pagoNoMes = pagsEmpresa.filter((p) => p.obrigacao_id === o.id && noMes(p.data_pagamento, mes)).reduce((a, p) => a + Number(p.valor_centavos), 0);
    if (!pagoNoMes) continue;
    const temRateio = rat.some((r) => r.obrigacaoChave === o.id);
    const valor = temRateio ? Math.min(pagoNoMes, parcela(o.id, mesAntes)) : (noMes(o.competencia, mesAntes) ? pagoNoMes : 0);
    if (valor) anterior.push({ descricao: o.descricao, valorCentavos: valor, tipo: temRateio ? "parcela de rateio proposto" : "integral", pagoEm: pagsEmpresa.filter((p) => p.obrigacao_id === o.id && noMes(p.data_pagamento, mes)).map((p) => String(p.data_pagamento).slice(0, 10))[0] });
  }
  const depois = [];
  for (const o of obrs.filter((x) => porCompetencia.has(x.categoria_id) && x.status !== "cancelada" && noMes(x.competencia, mes) || (porCompetencia.has(x.categoria_id) && rat.some((r) => r.obrigacaoChave === x.id && r.competencia === mes)))) {
    const pago = pagsEmpresa.filter((p) => p.obrigacao_id === o.id && noMes(p.data_pagamento, mesDepois)).reduce((a, p) => a + Number(p.valor_centavos), 0);
    if (!pago) continue;
    const noResultado = rat.some((r) => r.obrigacaoChave === o.id) ? parcela(o.id, mes) : Number(o.valor_original_centavos);
    depois.push({ descricao: o.descricao, valorPagoCentavos: pago, noResultadoCentavos: noResultado, tipo: rat.some((r) => r.obrigacaoChave === o.id) ? "parcela de rateio proposto" : "integral" });
  }
  const periodos = { mes, mesAnterior: mesAntes, mesSeguinte: mesDepois, anteriorPagaNoMes: { totalCentavos: anterior.reduce((a, x) => a + x.valorCentavos, 0), itens: anterior },
    mesPagoDepois: { totalPagoCentavos: depois.reduce((a, x) => a + x.valorPagoCentavos, 0), totalNoResultadoCentavos: depois.reduce((a, x) => a + x.noResultadoCentavos, 0), itens: depois } };

  // comparação com a apresentação oficial (referência documental; o sistema não é alterado por ela)
  const refs = deps.repo.listarReferenciasOficiais ? await deps.repo.listarReferenciasOficiais(c, { mes }, deps.db) : [];
  const I = dre.indicadores;
  const sistema = { faturamentoBruto: I.faturamentoBruto, deducoes: I.deducoes, faturamentoLiquido: I.faturamentoLiquido, cmv: I.cmv, entregas: I.entregas, custos: I.custosTotais, despesas: I.despesasVariaveis + I.despesasFixas, margemContribuicao: I.margemContribuicao, resultadoGerencial: I.resultadoGerencial, pontoEquilibrio: I.pontoEquilibrio, pontoEquilibrioFinanceiro: I.pontoEquilibrioFinanceiro,
    contasAnteriorPagasNoMes: periodos.anteriorPagaNoMes.totalCentavos, contasMesPagasDepois: periodos.mesPagoDepois.totalPagoCentavos, contasMesPagasDepoisNoResultado: periodos.mesPagoDepois.totalNoResultadoCentavos };
  const candidatos = vencidasSemPagamento.map((o) => ({ descricao: o.descricao, valorCentavos: Number(o.valor_original_centavos), motivo: "conta a pagar em aberto, sem pagamento registrado (não entra nas despesas, que são por pagamento)" }));
  const comparacao = refs.map((r) => {
    const s = sistema[r.indicador] ?? null, dif = s == null ? null : s - r.valorCentavos;
    return { indicador: r.indicador, rotulo: r.rotulo, apresentacaoCentavos: r.valorCentavos, sistemaCentavos: s, diferencaCentavos: dif, confere: dif === 0, fonte: r.fonte ?? null,
      explicacao: dif ? (explicarDiferenca(dif, candidatos)?.texto ?? (s == null ? "O sistema não calcula este indicador para o mês (falta cadastro)." : "Sem explicação automática: conferir os lançamentos.")) : null };
  });
  // efeito DERIVADO: o ponto de equilíbrio = fixas ÷ (MC ÷ bruto); uma diferença de despesas já explicada propaga-se por essa fórmula
  const dd = comparacao.find((x) => x.indicador === "despesas");
  if (dd?.diferencaCentavos && I.margemContribuicao > 0 && I.faturamentoBruto) {
    const derivado = Math.round(Math.abs(dd.diferencaCentavos) * I.faturamentoBruto / I.margemContribuicao);
    for (const x of comparacao) if (x.indicador.startsWith("pontoEquilibrio") && x.diferencaCentavos && Math.abs(x.diferencaCentavos) === derivado && dd.explicacao && !/Sem explicação/.test(dd.explicacao))
      x.explicacao = `Efeito derivado da diferença de despesas (R$ ${(Math.abs(dd.diferencaCentavos) / 100).toFixed(2).replace(".", ",")} ÷ margem de contribuição % = R$ ${(derivado / 100).toFixed(2).replace(".", ",")}).`;
  }
  // pendências documentais cadastradas à mão (sem movimentação financeira): entram na mesma lista; as confirmadas ficam à parte
  const docs = deps.repo.listarPendenciasDocumentais ? (await deps.repo.listarPendenciasDocumentais(c, { competencia: `${mes}-01` }, deps.db)).map(linhaPendenciaDocumental) : [];
  const automaticas = itens.filter((i) => !i.geral && i.valorCentavos != null);
  for (const x of docs.filter((d) => d.estado !== "confirmado")) {
    const coincide = x.valorCentavos != null ? automaticas.find((a) => Math.abs(a.valorCentavos) === x.valorCentavos) : null;
    itens.push({ id: `doc:${x.id}`, tipo: "pendencia_documental", gravidade: "atencao", titulo: x.descricao, descricao: x.motivo, motivo: x.motivo, valorCentavos: x.valorCentavos, evidenciaNecessaria: x.evidenciaNecessaria, responsavel: x.responsavel,
      status: x.estado, statusRotulo: x.estadoRotulo, observacoes: x.observacoes, documentoReferencia: x.documentoReferencia, relacionadaChave: x.relacionadaChave, docId: x.id, dataReferencia: x.dataReferencia,
      aviso: coincide ? `Mesmo valor da pendência automática «${coincide.titulo}»: confira se não é o mesmo assunto.` : null,
      acao: { tipo: "concluir_documental", rotulo: "Concluir com evidência", metodo: "POST", caminho: `/pendencias-documentais/${x.id}/confirmar`, exige: ["evidencia"], permissao: "classificar" } });
  }
  const concluidasDocumentais = docs.filter((d) => d.estado === "confirmado");
  const completos = itens.map(completarPendencia);
  return { mes, periodos, geral: completos.filter((i) => i.geral), pendencias: completos.filter((i) => !i.geral), total: completos.filter((i) => !i.geral).length, concluidasDocumentais, comparacao,
    resumoComparacao: { total: comparacao.length, conferem: comparacao.filter((x) => x.confere).length, divergentes: comparacao.filter((x) => x.confere === false).length } };
}

/** Histórico de decisões (trilha imutável) das entidades que a central decide. */
export async function historico(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const ent = ["fin_vendas_ajustes", "fin_vendas_canal", "fin_rateios", "fin_obrigacoes"];
  const todas = await deps.repo.listarAuditoria(c, { limite: 300 }, deps.db);
  return { itens: (todas ?? []).filter((a) => ent.includes(a.entidade)).slice(0, 50).map((a) => ({ id: a.id, entidade: a.entidade, entidadeId: a.entidade_id, acao: a.acao, em: a.created_at, ator: a.ator_id })) };
}
