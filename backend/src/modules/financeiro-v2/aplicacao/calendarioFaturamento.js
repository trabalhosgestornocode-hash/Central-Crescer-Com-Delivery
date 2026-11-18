// Fase 10 (doc 47) — CALENDÁRIO DE CONTROLE DE FATURAMENTO: para um canal e um mês, a situação REAL de cada dia, numa única
// consulta consolidada (nunca uma por dia). Só leitura e sem fonte nova: tudo vem das mesmas fontes das áreas dos canais
// (vendas, pagamentos com taxa estimada, fechamentos manuais, importações, propostas, demonstrativos oficiais do iFood).
// O calendário NÃO cria receita, não soma nada fora daqui e não presume que a empresa opera todos os dias.
//
// Um dia pode ter VÁRIOS estados ao mesmo tempo (ex.: relatório importado + fechamento manual + conferência pendente).
// Regras que valem para todos os canais:
//   - SEM_REGISTRO só existe para dia ELEGÍVEL: passado (antes de hoje), depois do início do controle e não marcado sem operação.
//     Dia futuro, o dia de hoje (ainda em andamento) e dias antes do início do controle nunca são "atrasados";
//   - SEM_MOVIMENTO_CONFIRMADO exige EVIDÊNCIA: dia marcado "sem operação" (com justificativa e autoria) ou relatório importado
//     que cobre o dia e não traz venda do canal. Ausência de dado nunca vira zero confirmado;
//   - iFood e 99Food só pela fonte oficial. Um demonstrativo cobre um PERÍODO e nunca é repartido por dia.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_IMPORTACAO, ESTADO_PROPOSTA, EVENTO_HISTORICO, SITUACAO_REGISTRO_FONTE, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { SITUACAO_TAXA_ESTIMADA, resumoPorModalidade } from "../dominio/operadoras.js";
import { diaDaSemana, diasEntre, exigirCompetencia, exigirData, primeiroDiaDe, somarDias, ultimoDiaDe } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { aberturaDaUnidade } from "./abertura.js";
import { demonstrativosDoIfood } from "./canalPlataforma.js";
import { leituraDaConciliacaoIfood } from "./conciliacaoIfood.js";
import { leituraDoRelatorio99Food } from "./relatorio99Food.js";
import { diasDeFechamento, ehProvisoria } from "./fechamentoManual.js";
import { itensDoLiquidoEsperado } from "./vendas.js";

export const CANAIS_DO_CALENDARIO = Object.freeze(["BALCAO", "ANOTA_AI", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
const CANAIS_SAIPOS = ["BALCAO", "ANOTA_AI"];
export const ESTADO_DIA = Object.freeze({
  SEM_REGISTRO: "SEM_REGISTRO", PROVISORIO: "PROVISORIO", FECHAMENTO_MANUAL: "FECHAMENTO_MANUAL", IMPORTADO: "IMPORTADO",
  CONFERENCIA_PENDENTE: "CONFERENCIA_PENDENTE", DIVERGENCIA: "DIVERGENCIA", CONCILIADO: "CONCILIADO", SEM_MOVIMENTO_CONFIRMADO: "SEM_MOVIMENTO_CONFIRMADO",
});
const ORDEM_DOS_ESTADOS = Object.values(ESTADO_DIA);
/** Estados que significam "há informação registrada neste dia" (pendência e divergência sozinhas não são informação). */
const COM_INFORMACAO = [ESTADO_DIA.PROVISORIO, ESTADO_DIA.FECHAMENTO_MANUAL, ESTADO_DIA.IMPORTADO, ESTADO_DIA.CONCILIADO, ESTADO_DIA.SEM_MOVIMENTO_CONFIRMADO];
const PROPOSTA_ABERTA = [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO, ESTADO_PROPOSTA.APROVADA];
const IMPORTACAO_VALIDA = [ESTADO_IMPORTACAO.IMPORTADO, ESTADO_IMPORTACAO.IMPORTADO_COM_PENDENCIAS];
const TAXA_PENDENTE = [SITUACAO_TAXA_ESTIMADA.TAXA_NAO_CONFIGURADA, SITUACAO_TAXA_ESTIMADA.SEM_TABELA_VIGENTE];
const OPERADORA_PENDENTE = [SITUACAO_TAXA_ESTIMADA.OPERADORA_AMBIGUA, SITUACAO_TAXA_ESTIMADA.SEM_OPERADORA, SITUACAO_TAXA_ESTIMADA.OPERADORA_INATIVA_NA_DATA];
const MODALIDADES_COM_BANDEIRA = ["DEBITO", "CREDITO_A_VISTA", "VOUCHER"];
const CONFERENCIA_EM_ABERTO = ["PENDENTE", "AGUARDANDO_EXTRATO", "PARCIAL"];

const soma = (lista, f) => lista.reduce((s, x) => s + (f(x) ?? 0), 0);
const agrupar = (lista, chave) => { const m = new Map(); for (const x of lista) { const k = chave(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const diasDoMes = (inicio, fim) => Array.from({ length: diasEntre(inicio, fim) + 1 }, (_, i) => somarDias(inicio, i));
const exigirCanal = (v) => {
  const canal = String(v ?? "").toUpperCase();
  if (!CANAIS_DO_CALENDARIO.includes(canal)) falhar(CODIGO.ENTRADA_INVALIDA, `canal: ${CANAIS_DO_CALENDARIO.join(", ")}.`, { campo: "canal" });
  return canal;
};

/** Dias sem operação configurados da unidade para o canal: datas avulsas e dias da semana fixos. Nada é presumido. */
export function semOperacaoDe(config, canal) {
  const c = config?.diasSemOperacao?.[canal];
  return { datas: Array.isArray(c?.datas) ? c.datas : [], diasDaSemana: Array.isArray(c?.diasDaSemana) ? c.diasDaSemana : [] };
}
const marcacaoDoDia = (semOp, data) => {
  const avulsa = semOp.datas.find((x) => x.data === data);
  if (avulsa) return { origem: "DATA", justificativa: avulsa.justificativa ?? null, em: avulsa.em ?? null };
  const fixa = semOp.diasDaSemana.find((x) => x.dia === diaDaSemana(data));
  return fixa ? { origem: "DIA_DA_SEMANA", justificativa: fixa.justificativa ?? null, em: fixa.em ?? null } : null;
};

const vazio = () => ({ estados: new Set(), registro: null, fechamento: null, movimentosDeCaixa: null, importacoes: [], pendencias: [], divergencias: [], observacoes: [], cobertura: null, temEvidenciaDeSemMovimento: false });

// ------------------------------------------------------------------------------------------------------ SAIPOS (Presencial e Anota Aí)
async function fonteSaipos(tx, cx, { canal, inicio, fim, hoje }) {
  const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, canal } })).filter((v) => v.dataVenda >= inicio && v.dataVenda <= fim);
  const itens = await itensDoLiquidoEsperado(tx, cx, { inicio, fim, canal });
  const fechamentos = new Map((await diasDeFechamento(tx, cx, inicio, fim)).map((d) => [d.data, d]));
  const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "SAIPOS" } }))
    .filter((i) => IMPORTACAO_VALIDA.includes(i.estado) && i.periodoInicio <= fim && inicio <= i.periodoFim);
  const idsImportacao = new Set(importacoes.map((i) => i.id));
  const propostas = (await tx.listar(cx, TIPO.PROPOSTA, { onde: { fonte: "SAIPOS" } }))
    .filter((p) => idsImportacao.has(p.importacaoId) && p.dataOperacao >= inicio && p.dataOperacao <= fim && p.comando?.canal === canal
      && p.estado !== ESTADO_PROPOSTA.REJEITADA && p.estado !== ESTADO_PROPOSTA.SUBSTITUIDA);
  const vendasPorDia = agrupar(vendas, (v) => v.dataVenda);
  const itensPorDia = agrupar(itens, (i) => i.venda.data);
  const propostasPorDia = agrupar(propostas, (p) => p.dataOperacao);

  return (data) => {
    const dia = vazio();
    const lista = vendasPorDia.get(data) ?? [];
    const its = itensPorDia.get(data) ?? [];
    const props = propostasPorDia.get(data) ?? [];
    const total = its.length ? resumoPorModalidade(its.map((x) => ({ ...x, modalidade: "TOTAL", bandeira: "TOTAL" })))[0] : null;
    const provisorias = lista.filter(ehProvisoria);
    const daSaipos = lista.filter((v) => v.fonte?.sistema === "SAIPOS");
    // Só RELATÓRIOS DE VENDAS são evidência de "dia sem venda": o relatório de movimentações de caixa (sangrias) cobre o dia sem dizer nada sobre vendas.
    const cobremTodas = importacoes.filter((i) => i.periodoInicio <= data && data <= i.periodoFim);
    const cobrem = cobremTodas.filter((i) => i.tipoRelatorio !== "SAIPOS_MOVIMENTOS_CAIXA");
    dia.importacoes = cobremTodas.map((i) => ({ id: i.id, tipoRelatorio: i.tipoRelatorio, periodoInicio: i.periodoInicio, periodoFim: i.periodoFim, estado: i.estado }));

    if (lista.length) {
      const calculado = total && total.brutoCalculadoCentavos > 0;
      dia.registro = {
        vendas: lista.length, brutoCentavos: soma(lista, (v) => v.brutoCentavos), descontosCentavos: soma(lista, (v) => v.descontosCentavos),
        origem: { SAIPOS: daSaipos.length, MANUAL: lista.length - daSaipos.length }, provisorias: { vendas: provisorias.length, valorCentavos: soma(provisorias, (v) => v.brutoCentavos) },
        semPagamento: { vendas: lista.filter((v) => !v.pagamentoIds?.length).length, valorCentavos: soma(lista.filter((v) => !v.pagamentoIds?.length), (v) => v.brutoCentavos) },
        pagamentos: its.length, taxaEstimadaCentavos: calculado ? total.taxaCentavos : null, liquidoEsperadoCentavos: calculado ? total.liquidoEsperadoCentavos : null,
        brutoSemCalculoCentavos: total?.brutoSemCalculoCentavos ?? 0, recebidoCentavos: total?.recebidoCentavos ?? null, conferencia: total?.situacaoConferencia ?? null,
      };
    }

    // Fechamento manual: no Presencial vale qualquer caixa; no Anota Aí só o caixa que informou valor do Anota Aí.
    const fd = fechamentos.get(data);
    const caixas = (fd?.fechamentos ?? []).filter((f) => canal === "BALCAO" || (f.dados?.totais?.anotaAiCentavos ?? 0) > 0);
    const linhas = (fd?.comparacao ?? []).filter((l) => (canal === "ANOTA_AI" ? l.grupo === "ANOTA_AI" : l.grupo !== "ANOTA_AI"));
    if (caixas.length) {
      dia.fechamento = { caixas: caixas.length, situacao: fd.situacao, linhasDivergentes: linhas.filter((l) => l.situacao === "DIVERGENTE").length, linhasSoDeUmLado: linhas.filter((l) => l.situacao === "SO_MANUAL" || l.situacao === "SO_IMPORTADO").length };
    }

    // Sangrias, reforços e transferências importados (só no Presencial: são do caixa físico). Informação do dia; NÃO é faturamento.
    // Duplicidade possível, retirada acima do dinheiro do dia, divergência com o fechamento e movimento sem classificação entram como pendência/divergência.
    const mov = canal === "BALCAO" ? fd?.movimentosDeCaixa ?? null : null;
    if (mov) {
      dia.movimentosDeCaixa = mov;
      for (const a of mov.alertas) dia.pendencias.push({ codigo: a.codigo, quantidade: 1, mensagem: a.mensagem });
      for (const d of mov.divergencias) dia.divergencias.push({ codigo: d.codigo, quantidade: d.quantidade ?? 1, mensagem: d.mensagem });
    }

    // Pendências (o que ainda precisa de alguém).
    const quantos = (lst, f) => lst.filter(f).length;
    const semTaxa = quantos(its, (i) => TAXA_PENDENTE.includes(i.situacao));
    const semOperadora = quantos(its, (i) => OPERADORA_PENDENTE.includes(i.situacao));
    const semBandeira = quantos(its, (i) => MODALIDADES_COM_BANDEIRA.includes(i.modalidade) && !i.bandeira);
    if (semTaxa) dia.pendencias.push({ codigo: "TAXA_NAO_CONFIGURADA", quantidade: semTaxa, mensagem: `${semTaxa} pagamento(s) sem taxa configurada: taxa e líquido não calculados (nunca considerados zero).` });
    if (semOperadora) dia.pendencias.push({ codigo: "OPERADORA_PENDENTE", quantidade: semOperadora, mensagem: `${semOperadora} pagamento(s) sem operadora definida na data (ausente, ambígua ou inativa).` });
    if (semBandeira) dia.pendencias.push({ codigo: "BANDEIRA_PENDENTE", quantidade: semBandeira, mensagem: `${semBandeira} pagamento(s) de cartão ou voucher sem bandeira informada.` });
    const abertas = props.filter((p) => PROPOSTA_ABERTA.includes(p.estado));
    if (abertas.length) dia.pendencias.push({ codigo: "PROPOSTAS_ABERTAS", quantidade: abertas.length, mensagem: `${abertas.length} proposta(s) da importação ainda não aplicada(s).` });
    const porCodigo = new Map();
    for (const p of props) for (const d of p.divergencias ?? []) { const x = porCodigo.get(d.codigo) ?? { codigo: d.codigo, quantidade: 0, mensagem: d.mensagem }; x.quantidade += 1; porCodigo.set(d.codigo, x); }
    for (const x of porCodigo.values()) dia.pendencias.push(x);
    if (provisorias.length) dia.pendencias.push({ codigo: "FATURAMENTO_PROVISORIO", quantidade: provisorias.length, mensagem: "Faturamento manual provisório: precisa ser substituído pela importação oficial." });
    if (total && CONFERENCIA_EM_ABERTO.includes(total.situacaoConferencia)) dia.pendencias.push({ codigo: "RECEBIMENTO_NAO_CONFIRMADO", quantidade: 1, mensagem: "Recebimento ainda não confirmado integralmente (extrato ou repasse pendente)." });
    if (dia.fechamento && !lista.length) dia.pendencias.push({ codigo: "FECHAMENTO_SEM_RELATORIO", quantidade: 1, mensagem: "Fechamento manual sem relatório importado: ele só confere, não vira faturamento." });
    if (dia.fechamento?.linhasSoDeUmLado) dia.pendencias.push({ codigo: "FECHAMENTO_PARCIAL", quantidade: dia.fechamento.linhasSoDeUmLado, mensagem: "Há forma de pagamento só no fechamento ou só nas vendas." });

    // Divergências (duas fontes que discordam).
    if (total?.situacaoConferencia === "DIVERGENTE") dia.divergencias.push({ codigo: "RECEBIDO_DIFERENTE_DO_ESPERADO", diferencaCentavos: total.diferencaCentavos, mensagem: "O recebido confirmado é diferente do líquido esperado." });
    if (dia.fechamento?.linhasDivergentes) dia.divergencias.push({ codigo: "FECHAMENTO_DIVERGE_DAS_VENDAS", quantidade: dia.fechamento.linhasDivergentes, mensagem: "O fechamento manual diverge das vendas importadas em pelo menos uma forma de pagamento." });

    // Estados.
    if (provisorias.length) dia.estados.add(ESTADO_DIA.PROVISORIO);
    if (caixas.length) dia.estados.add(ESTADO_DIA.FECHAMENTO_MANUAL);
    if (daSaipos.length) dia.estados.add(ESTADO_DIA.IMPORTADO);
    dia.temEvidenciaDeSemMovimento = !lista.length && !caixas.length && cobrem.length > 0 && data < hoje;
    if (dia.pendencias.length) dia.estados.add(ESTADO_DIA.CONFERENCIA_PENDENTE);
    if (dia.divergencias.length) dia.estados.add(ESTADO_DIA.DIVERGENCIA);
    if (lista.length && !provisorias.length && total?.situacaoConferencia === "CONCILIADO" && !dia.pendencias.length && !dia.divergencias.length) dia.estados.add(ESTADO_DIA.CONCILIADO);
    if (dia.temEvidenciaDeSemMovimento) dia.observacoes.push("Relatório importado cobre o dia e não traz venda deste canal.");
    return dia;
  };
}

// ------------------------------------------------------------------------------------------------------ iFood (fonte oficial)
async function fonteIfood(tx, cx, { inicio, fim, hoje }) {
  const demonstrativos = (await demonstrativosDoIfood(tx, cx, hoje)).filter((d) => d.periodoInicio <= fim && inicio <= d.periodoFim);
  const foraDaFonte = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } }))
    .filter((l) => l.situacao === "ATIVO" && l.categoria === "VENDA_IFOOD" && !l.demonstrativoIfood && !l.conciliacaoIfood && l.dataOperacao >= inicio && l.dataOperacao <= fim);
  const pedidos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === "IFOOD" && !r.dados.cancelado && r.dataReferencia >= inicio && r.dataReferencia <= fim);
  const periodo = (d) => ({ id: d.id, periodoInicio: d.periodoInicio, periodoFim: d.periodoFim, brutoCentavos: d.brutoCentavos, comissoesCentavos: d.comissoesCentavos, taxasCentavos: d.taxasCentavos,
    repassePrevistoCentavos: d.repassePrevistoCentavos, repasseRecebidoCentavos: d.repasseRecebidoCentavos, saldoAReceberCentavos: d.saldoAReceberCentavos, dataPrevista: d.dataPrevista, situacaoRepasse: d.situacaoRepasse });
  const cobertura = demonstrativos.map(periodo);
  const conciliacao = await leituraDaConciliacaoIfood(tx, cx, { inicio, fim, hoje });
  const base = (data) => {
    const dia = vazio();
    const cobrem = demonstrativos.filter((d) => d.periodoInicio <= data && data <= d.periodoFim);
    const fora = foraDaFonte.filter((l) => l.dataOperacao === data);
    const peds = pedidos.filter((r) => r.dataReferencia === data).length;
    if (cobrem.length) {
      dia.estados.add(ESTADO_DIA.IMPORTADO);
      // O demonstrativo cobre um PERÍODO: valores por dia não existem aqui e nunca são inventados.
      dia.cobertura = { granularidadeDiaria: false, periodos: cobrem.map(periodo), mensagem: "Período coberto por demonstrativo oficial do iFood. O detalhamento diário depende do relatório oficial de pedidos: nenhum valor é repartido por dia." };
      dia.observacoes.push(dia.cobertura.mensagem);
      for (const d of cobrem.filter((x) => x.situacaoRepasse !== "RECEBIDO")) {
        const rotulo = { PREVISTO: "previsto", PARCIAL: "recebido em parte", ATRASADO: "atrasado", SEM_RECEBIVEL: "sem recebível" }[d.situacaoRepasse] ?? d.situacaoRepasse;
        dia.pendencias.push({ codigo: `REPASSE_${d.situacaoRepasse}`, quantidade: 1, mensagem: `Repasse do período ${d.periodoInicio} a ${d.periodoFim}: ${rotulo}.` });
      }
      if (cobrem.length > 1) dia.divergencias.push({ codigo: "DEMONSTRATIVOS_SOBREPOSTOS", quantidade: cobrem.length, mensagem: "Mais de um demonstrativo oficial cobre este dia." });
    }
    if (fora.length) dia.divergencias.push({ codigo: "RECEITA_IFOOD_FORA_DA_FONTE_OFICIAL", quantidade: fora.length, valorCentavos: soma(fora, (l) => l.valorCentavos), mensagem: "Receita iFood lançada por outra origem que não o demonstrativo oficial." });
    const oficial = conciliacao?.porDia.get(data) ?? null;
    if (oficial) {
      // Relatório oficial por pedido: o dia tem valores próprios. Dia sem linha no arquivo continua sem registro.
      dia.ifoodOficial = oficial;
      dia.estados.add(ESTADO_DIA.IMPORTADO);
      if (!oficial.aplicado) dia.pendencias.push({ codigo: "CONCILIACAO_NAO_APLICADA", quantidade: 1, mensagem: "Relatório oficial importado, ainda não aplicado ao Financeiro." });
      if (oficial.saipos && oficial.saipos.diferencaCentavos) dia.divergencias.push({ codigo: "DIFERENCA_SAIPOS_IFOOD", diferencaCentavos: oficial.saipos.diferencaCentavos, mensagem: "Produtos na SAIPOS diferentes do relatório oficial do iFood: pendente de conferência." });
      if (oficial.saipos && (oficial.saipos.soNoIfood || oficial.saipos.soNaSaipos)) dia.divergencias.push({ codigo: "PEDIDOS_DIFERENTES_SAIPOS_IFOOD", quantidade: oficial.saipos.soNoIfood + oficial.saipos.soNaSaipos, mensagem: "Há pedidos em só uma das fontes." });
      if (!oficial.saipos) dia.pendencias.push({ codigo: "SAIPOS_NAO_IMPORTADA", quantidade: 1, mensagem: "Relatório da SAIPOS deste dia ainda não importado para conferência." });
      for (const r of oficial.repasses.filter((x) => x.situacao === "DIVERGENTE")) dia.divergencias.push({ codigo: "REPASSE_DIVERGENTE", quantidade: 1, mensagem: `Repasse previsto para ${r.dataPrevista.split("-").reverse().join("/")}: crédito do extrato com valor diferente.` });
      for (const r of oficial.repasses.filter((x) => !["RECEBIDO", "SEM_SALDO", "DIVERGENTE"].includes(x.situacao))) dia.pendencias.push({ codigo: `REPASSE_${r.situacao}`, quantidade: 1, mensagem: `Repasse previsto para ${r.dataPrevista.split("-").reverse().join("/")}: aguardando confirmação pelo extrato.` });
    }
    if (peds) {
      dia.conferenciaSaipos = { pedidos: peds, natureza: "SO_CONFERENCIA" };
      if (!cobrem.length && !oficial) dia.pendencias.push({ codigo: "PEDIDOS_SEM_FONTE_OFICIAL", quantidade: peds, mensagem: `${peds} pedido(s) iFood no relatório SAIPOS sem demonstrativo oficial correspondente (a SAIPOS não é a fonte do iFood).` });
    }
    if (dia.pendencias.length) dia.estados.add(ESTADO_DIA.CONFERENCIA_PENDENTE);
    if (dia.divergencias.length) dia.estados.add(ESTADO_DIA.DIVERGENCIA);
    if (cobrem.length === 1 && cobrem[0].situacaoRepasse === "RECEBIDO" && !fora.length) dia.estados.add(ESTADO_DIA.CONCILIADO);
    if (oficial?.situacaoConferencia === "CONCILIADO" && !dia.pendencias.length && !dia.divergencias.length) dia.estados.add(ESTADO_DIA.CONCILIADO);
    return dia;
  };
  return { base, cobertura, diaria: Boolean(conciliacao) };
}

// ------------------------------------------------------------------------------------------------------ 99Food (fonte oficial)
async function fonte99Food(tx, cx, { inicio, fim }) {
  const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, canal: "NOVENTA_E_NOVE_FOOD" } })).filter((v) => v.dataVenda >= inicio && v.dataVenda <= fim);
  const porDia = agrupar(vendas, (v) => v.dataVenda);
  const relatorio = await leituraDoRelatorio99Food(tx, cx, { inicio, fim });
  const base = (data) => {
    const dia = vazio();
    const lista = porDia.get(data) ?? [];
    const oficial = relatorio?.porDia.get(data) ?? null;
    if (oficial) {
      dia.noventaOficial = oficial;
      dia.estados.add(ESTADO_DIA.IMPORTADO);
      if (!oficial.aplicado) dia.pendencias.push({ codigo: "RELATORIO_NAO_APLICADO", quantidade: 1, mensagem: "Relatório oficial importado, ainda não aplicado ao Financeiro." });
      if (oficial.saipos && (oficial.saipos.diferencaPedidos || oficial.saipos.diferencaItensCentavos)) dia.divergencias.push({ codigo: "DIFERENCA_SAIPOS_99FOOD", diferencaCentavos: oficial.saipos.diferencaItensCentavos, mensagem: `SAIPOS com ${oficial.saipos.pedidos} pedido(s) e relatório oficial com ${oficial.quantidade}: pendente de conferência.` });
      if (!oficial.saipos) dia.pendencias.push({ codigo: "SAIPOS_SEM_PEDIDOS_99FOOD", quantidade: 1, mensagem: "A SAIPOS não tem pedidos 99Food neste dia para comparar." });
      if (oficial.diferencaRepasseCentavos) dia.pendencias.push({ codigo: "REPASSE_EM_CONFERENCIA", quantidade: 1, mensagem: "O repasse informado não fecha com os lançamentos do dia: em conferência." });
      dia.pendencias.push({ codigo: "REPASSE_SEM_CICLO", quantidade: 1, mensagem: "Repasse informado sem data e sem ciclo oficial: aguardando identificação no extrato." });
    } else dia.observacoes.push("Nenhum relatório oficial da 99Food importado: o dia aparece sem dados (não é zero confirmado).");
    if (!lista.length) { if (dia.pendencias.length) dia.estados.add(ESTADO_DIA.CONFERENCIA_PENDENTE); if (dia.divergencias.length) dia.estados.add(ESTADO_DIA.DIVERGENCIA); return dia; }
    const provisorias = lista.filter(ehProvisoria);
    const daSaipos = lista.filter((v) => v.fonte?.sistema === "SAIPOS");
    dia.registro = { vendas: lista.length, brutoCentavos: soma(lista, (v) => v.brutoCentavos), origem: { SAIPOS: daSaipos.length, MANUAL: lista.length - daSaipos.length }, provisorias: { vendas: provisorias.length, valorCentavos: soma(provisorias, (v) => v.brutoCentavos) } };
    if (provisorias.length) dia.estados.add(ESTADO_DIA.PROVISORIO);
    if (daSaipos.length) dia.divergencias.push({ codigo: "SAIPOS_NAO_E_FONTE_DA_99FOOD", quantidade: daSaipos.length, mensagem: "Venda 99Food vinda da SAIPOS: a SAIPOS não é fonte oficial da 99Food." });
    const outras = lista.length - provisorias.length - daSaipos.length;
    if (outras) dia.pendencias.push({ codigo: "ORIGEM_NAO_OFICIAL", quantidade: outras, mensagem: "Venda 99Food sem relatório oficial correspondente." });
    if (dia.pendencias.length) dia.estados.add(ESTADO_DIA.CONFERENCIA_PENDENTE);
    if (dia.divergencias.length) dia.estados.add(ESTADO_DIA.DIVERGENCIA);
    return dia;
  };
  return { base, diaria: Boolean(relatorio) };
}

// ---------------------------------------------------------------------------------------------------------------- operações
export function operacoesDoCalendarioFaturamento(b) {
  return {
    /** Calendário mensal de UM canal. Uma consulta consolidada: cada dia traz seus estados, valores, pendências e ações. */
    consultarCalendarioDeFaturamento(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["canal", "mes"], "consulta");
      const canal = exigirCanal(entrada.canal);
      const mes = exigirCompetencia(entrada.mes, "mes");
      const inicio = primeiroDiaDe(mes);
      const fim = ultimoDiaDe(mes);
      return b.consultar(ctx, async (cx, tx) => {
        const hoje = b.hoje();
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const semOp = semOperacaoDe(config, canal);
        const abertura = await aberturaDaUnidade(tx, cx);
        // Início do controle: o dia seguinte ao corte da abertura da unidade; sem abertura, o primeiro dia do mês corrente.
        const inicioDoControle = abertura?.dataDeCorte ? somarDias(abertura.dataDeCorte, 1) : primeiroDiaDe(hoje.slice(0, 7));
        let diaDe; let cobertura = null; let ifoodDiario = false; let noventaDiario = false;
        if (CANAIS_SAIPOS.includes(canal)) diaDe = await fonteSaipos(tx, cx, { canal, inicio, fim, hoje });
        else if (canal === "IFOOD") { const f = await fonteIfood(tx, cx, { inicio, fim, hoje }); diaDe = f.base; cobertura = f.cobertura; ifoodDiario = f.diaria; }
        else { const f = await fonte99Food(tx, cx, { inicio, fim }); diaDe = f.base; noventaDiario = f.diaria; }

        const dias = diasDoMes(inicio, fim).map((data) => {
          const d = diaDe(data);
          const marcado = marcacaoDoDia(semOp, data);
          const futuro = data > hoje;
          const ehHoje = data === hoje;
          const temInformacao = [...d.estados].some((e) => COM_INFORMACAO.includes(e)) || d.registro !== null;
          // Sem operação (marcado) só vale como "sem movimento" quando nada foi registrado: o que existe nunca é escondido.
          if (marcado && !temInformacao && !futuro) d.estados.add(ESTADO_DIA.SEM_MOVIMENTO_CONFIRMADO);
          else if (marcado && temInformacao) d.observacoes.push("Dia marcado como sem operação, mas há registro: o registro prevalece.");
          if (d.temEvidenciaDeSemMovimento && !marcado) d.estados.add(ESTADO_DIA.SEM_MOVIMENTO_CONFIRMADO);
          const semOperacao = marcado && !temInformacao ? marcado : null;
          const antesDoControle = data < inicioDoControle;
          const elegivel = !futuro && !ehHoje && !antesDoControle && !semOperacao;
          // Sem registro = nada registrado no dia. Pendência ou observação sozinhas (ex.: pedido iFood só na SAIPOS) não são registro.
          const temInformacaoFinal = [...d.estados].some((e) => COM_INFORMACAO.includes(e)) || d.registro !== null;
          if (elegivel && !temInformacaoFinal) d.estados.add(ESTADO_DIA.SEM_REGISTRO);
          const estados = ORDEM_DOS_ESTADOS.filter((e) => d.estados.has(e));
          const { temEvidenciaDeSemMovimento, ...resto } = d;
          return { data, diaDaSemana: diaDaSemana(data), hoje: ehHoje, futuro, antesDoControle, elegivel, semOperacao, ...resto, estados };
        });

        const conta = (f) => dias.filter(f).length;
        const resumo = {
          diasNoMes: dias.length, diasElegiveis: conta((d) => d.elegivel),
          comInformacao: conta((d) => d.estados.some((e) => COM_INFORMACAO.includes(e))),
          confirmados: conta((d) => d.estados.includes(ESTADO_DIA.IMPORTADO) || d.estados.includes(ESTADO_DIA.CONCILIADO)),
          provisorios: conta((d) => d.estados.includes(ESTADO_DIA.PROVISORIO)),
          comPendencias: conta((d) => d.estados.includes(ESTADO_DIA.CONFERENCIA_PENDENTE)),
          comDivergencias: conta((d) => d.estados.includes(ESTADO_DIA.DIVERGENCIA)),
          semRegistro: conta((d) => d.estados.includes(ESTADO_DIA.SEM_REGISTRO)),
          semOperacao: conta((d) => d.semOperacao !== null), futuros: conta((d) => d.futuro),
        };
        const tem = (a) => (ctx.permissoes ?? []).includes(a);
        const saipos = CANAIS_SAIPOS.includes(canal);
        const observacoes = canal === "IFOOD"
          ? [ifoodDiario ? "Dias com relatório oficial de conciliação do iFood têm valores próprios. Dias fora do arquivo continuam sem registro." : "Somente o demonstrativo oficial do iFood. Ele cobre períodos: os valores não são repartidos por dia."]
          : canal === "NOVENTA_E_NOVE_FOOD" ? [noventaDiario ? "Dias com relatório oficial da 99Food têm valores próprios. Dias fora do arquivo continuam sem registro." : "Somente relatórios oficiais da 99Food. Sem relatório importado, os dias aparecem sem dados (nunca zero confirmado)."]
          : ["Uma importação da SAIPOS pode alimentar os dois canais; cada calendário mostra só os registros do seu canal."];
        return {
          canal, mes, hoje, controle: { inicio: inicioDoControle, origem: abertura?.dataDeCorte ? "ABERTURA" : "MES_CORRENTE" }, observacoes,
          semFonteOficial: canal === "NOVENTA_E_NOVE_FOOD" && !noventaDiario, granularidadeDiaria: saipos || ifoodDiario || noventaDiario,
          acoes: {
            abrirImportacoes: saipos && tem(ACAO.VER), importar: saipos && tem(ACAO.IMPORTAR), registrarFechamento: saipos && tem(ACAO.REGISTRAR),
            registrarFaturamentoProvisorio: saipos && tem(ACAO.REGISTRAR), substituirProvisorio: saipos && tem(ACAO.CANCELAR), abrirConferencias: tem(ACAO.VER),
            configurarDiasSemOperacao: tem(ACAO.CONFIGURAR),
          },
          diasSemOperacao: semOp, cobertura, resumo, dias,
        };
      });
    },

    /**
     * Marca (ou desmarca) um dia, ou um dia da semana, como SEM OPERAÇÃO para um canal. Exige justificativa; fica no histórico
     * da configuração da unidade. Recusa marcar um dia que já tem registro do canal (o registro não pode ser escondido).
     */
    registrarDiaSemOperacao(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["canal", "data", "diaDaSemana", "situacao", "justificativa"], "diaSemOperacao");
      const canal = exigirCanal(entrada.canal);
      const situacao = String(entrada.situacao ?? "SEM_OPERACAO").toUpperCase();
      if (!["SEM_OPERACAO", "OPERA"].includes(situacao)) falhar(CODIGO.ENTRADA_INVALIDA, "situacao: SEM_OPERACAO ou OPERA.", { campo: "situacao" });
      const informou = (v) => v !== undefined && v !== null && v !== "";
      if (informou(entrada.data) === informou(entrada.diaDaSemana)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a data OU o dia da semana (um dos dois).");
      const data = informou(entrada.data) ? exigirData(entrada.data, "data") : null;
      const dia = informou(entrada.diaDaSemana) ? Number(entrada.diaDaSemana) : null;
      if (dia !== null && !(Number.isInteger(dia) && dia >= 0 && dia <= 6)) falhar(CODIGO.ENTRADA_INVALIDA, "diaDaSemana: 0 (domingo) a 6 (sábado).", { campo: "diaDaSemana" });
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 300 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade (nome de exibição) antes de marcar dias sem operação.");
        const todos = atual.diasSemOperacao ?? {};
        const doCanal = semOperacaoDe(atual, canal);
        const registro = { justificativa, por: cx.usuarioId, em: b.agora() };
        let datas = doCanal.datas;
        let dias = doCanal.diasDaSemana;
        if (situacao === "SEM_OPERACAO") {
          if (data !== null) {
            if (datas.some((x) => x.data === data)) return { canal, ...doCanal, repetido: true };
            if (CANAIS_SAIPOS.includes(canal) || canal === "NOVENTA_E_NOVE_FOOD") {
              const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, canal } })).filter((v) => v.dataVenda === data);
              if (vendas.length) falhar(CODIGO.OPERACAO_INVALIDA, "Este dia já tem venda registrada neste canal: não pode ser marcado como sem operação.", { motivo: "DIA_COM_REGISTRO" });
              if (canal === "NOVENTA_E_NOVE_FOOD" && (await leituraDoRelatorio99Food(tx, cx, { inicio: data, fim: data }))?.porDia.has(data)) falhar(CODIGO.OPERACAO_INVALIDA, "Este dia tem dados no relatório oficial da 99Food: não pode ser marcado como sem operação.", { motivo: "DIA_COM_REGISTRO" });
            } else {
              const cobre = (await demonstrativosDoIfood(tx, cx, b.hoje())).some((d) => d.periodoInicio <= data && data <= d.periodoFim);
              if (cobre) falhar(CODIGO.OPERACAO_INVALIDA, "Este dia está dentro de um demonstrativo oficial do iFood: não pode ser marcado como sem operação.", { motivo: "DIA_COM_REGISTRO" });
              const oficial = await leituraDaConciliacaoIfood(tx, cx, { inicio: data, fim: data, hoje: b.hoje() });
              if (oficial?.porDia.has(data)) falhar(CODIGO.OPERACAO_INVALIDA, "Este dia tem movimentos no relatório oficial do iFood: não pode ser marcado como sem operação.", { motivo: "DIA_COM_REGISTRO" });
            }
            datas = [...datas, { data, ...registro }].sort((x, y) => x.data.localeCompare(y.data));
          } else {
            if (dias.some((x) => x.dia === dia)) return { canal, ...doCanal, repetido: true };
            dias = [...dias, { dia, ...registro }].sort((x, y) => x.dia - y.dia);
          }
        } else if (data !== null) {
          if (!datas.some((x) => x.data === data)) return { canal, ...doCanal, repetido: true };
          datas = datas.filter((x) => x.data !== data);
        } else {
          if (!dias.some((x) => x.dia === dia)) return { canal, ...doCanal, repetido: true };
          dias = dias.filter((x) => x.dia !== dia);
        }
        const novo = { datas, diasDaSemana: dias };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { diasSemOperacao: { ...todos, [canal]: novo } }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { canal, ...novo, repetido: false };
      });
    },
  };
}
