// Dashboard Operacional 2.0 — FECHAMENTO OPERACIONAL DIÁRIO (funções puras).
//
// Uma competência = um DIA OPERACIONAL da unidade: [00:00, 24:00) no fuso da operação (a mesma régua do Checklist e do
// Dashboard: checklistOperacional.calc.js#VIRADA_HORA). Cada indicador declara a sua COMPETÊNCIA — nunca misturadas:
//
//   ENTRADA       pedido pertence ao dia em que CHEGOU (PLACED). Tempos, atrasos, horários de movimento, descontos e
//                 clientes usam esta coorte — é a mesma população do Dashboard Operacional, que é chamado aqui (montarDashboard)
//                 para que o fechamento e a tela NUNCA divirjam.
//   CONCLUSÃO     "concluídos no dia" = conclusão oficial (CONCLUDED) dentro do dia, qualquer que seja o dia da chegada.
//   CANCELAMENTO  "cancelados no dia" e motivos = cancelamento oficial (CANCELLED) dentro do dia.
//
// Por isso recebidos ≠ concluídos + cancelados (competências diferentes). A identidade só vale DENTRO da coorte de entrada,
// que também é publicada: recebidos = concluídos + cancelados + em aberto (dos que chegaram no dia).
//
// Nenhum número é estimado. Indicador sem dado = `estado: "indisponivel"` com o motivo; nunca zero.

import { createHash } from "node:crypto";
import { jsonEstavel } from "../ifood/ifoodEvents.parser.js";
import { ETAPAS, NOME_ETAPA } from "./checklistOperacional.indicadores.js";
import { inicioDoDia, somarDias } from "./checklistOperacional.periodos.js";

export const REGRA_FECHAMENTO = 1;
export const STATUS_FECHAMENTO = Object.freeze({
  PRELIMINAR: "PRELIMINAR", CONSOLIDADO: "CONSOLIDADO", REVISADO: "REVISADO", INCOMPLETO: "INCOMPLETO",
});
/** Depois do fim do dia, espera eventos atrasados (pedidos que atravessam a meia-noite, conclusões tardias) antes de consolidar. */
export const JANELA_CONSOLIDACAO_MS = 6 * 3_600_000;
/** Acima desta fração de pedidos sem detalhes do iFood, valores/descontos/clientes não são confiáveis: INCOMPLETO. */
export const LIMITE_SEM_DETALHES = 0.05;
export const MAX_MOTIVOS = 5;
export const MAX_PICOS = 3;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const arred = (v, casas = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** casas) / 10 ** casas);
const pct = (n, d) => (d > 0 ? arred((n / d) * 100) : null);
const soma = (xs) => Math.round(xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0) * 100) / 100;
const dentroDe = (iso, a, b) => { const t = ms(iso); return Number.isFinite(t) && t >= a && t < b; };

/** Janela [início, fim) do dia operacional, em ms, no fuso. */
export function janelaDaCompetencia(competencia, fuso) {
  return { inicioMs: inicioDoDia(competencia, fuso), fimMs: inicioDoDia(somarDias(competencia, 1), fuso) };
}

/** Meta vigente no FIM da competência (a usada na comparação "média × meta"; cada pedido continua avaliado pela sua). */
function metaDoDia(dashboard, etapa) {
  const versoes = dashboard?.metasAplicaveis?.versoes ?? [];
  const v = versoes[versoes.length - 1];
  return v ? { meta: v.valores?.[etapa]?.meta ?? null, versao: v.versao } : { meta: null, versao: null };
}

const DEF_TEMPO = Object.freeze({
  preparo: { inicio: "chegada (PLACED)", fim: "despacho (DISPATCHED)", populacao: "pedidos de entrega recebidos no dia, não cancelados e não agendados, com os dois carimbos válidos" },
  entrega: { inicio: "despacho (DISPATCHED)", fim: "conclusão registrada pelo iFood (CONCLUDED)", populacao: "pedidos de entrega recebidos no dia e concluídos, com os dois carimbos válidos" },
  vida: { inicio: "chegada (PLACED)", fim: "conclusão registrada pelo iFood (CONCLUDED)", populacao: "pedidos de entrega recebidos no dia, concluídos e não agendados, com os dois carimbos válidos" },
});

function indicadorTempo(dashboard, etapa) {
  const x = dashboard.resumo.porEtapa[etapa];
  const { meta, versao } = metaDoDia(dashboard, etapa);
  const base = {
    etapa, nome: NOME_ETAPA[etapa], fonte: "eventos oficiais do iFood (Events)", ...DEF_TEMPO[etapa],
    amostras: x.amostras, meta, metaVersao: versao, avaliadas: x.avaliadas, atrasos: x.atrasos, pctDentro: x.pctDentro,
    descartados: x.descartados, semCarimbo: x.semCarimbo,
  };
  if (!x.amostras) return { ...base, estado: "indisponivel", media: null, desvioDaMetaMin: null, motivo: "nenhuma medição válida no dia" };
  return { ...base, estado: "calculado", media: x.media, desvioDaMetaMin: meta == null ? null : arred(x.media - meta) };
}

/** Etapa com mais atrasos (empate: maior excedente). Nunca atribui responsável: só diz ONDE a meta foi excedida. */
function principalEtapaComDesvio(dashboard) {
  const cands = ETAPAS.map((e) => ({ etapa: e, ...dashboard.resumo.porEtapa[e] })).filter((x) => x.atrasos > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => b.atrasos - a.atrasos || (b.maiorAtraso?.excedenteMin ?? 0) - (a.maiorAtraso?.excedenteMin ?? 0));
  const c = cands[0];
  return { etapa: c.etapa, nome: NOME_ETAPA[c.etapa], atrasos: c.atrasos, avaliadas: c.avaliadas, pctAtraso: c.pctAtraso, maiorExcedenteMin: c.maiorAtraso?.excedenteMin ?? null };
}

function agrupar(itens, chave) {
  const m = new Map();
  for (const i of itens) { const k = chave(i); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([k, n]) => ({ chave: k, quantidade: n })).sort((a, b) => b.quantidade - a.quantidade || String(a.chave).localeCompare(String(b.chave)));
}

function indicadorCancelamentos(projecoes, janela, coorte) {
  const doDia = projecoes.filter((p) => p.is_test !== true && p.status_oficial === "CANCELLED" && dentroDe(p.can_em, janela.inicioMs, janela.fimMs));
  const motivos = agrupar(doDia, (p) => (p.cancel_codigo ? `${p.cancel_codigo}|${p.cancel_descricao ?? ""}` : "SEM_MOTIVO"))
    .map((g) => {
      const [codigo, descricao] = g.chave === "SEM_MOTIVO" ? [null, null] : g.chave.split("|");
      return { codigo, descricao: descricao || (codigo ? null : "motivo não informado pelo iFood"), quantidade: g.quantidade, pct: pct(g.quantidade, doDia.length) };
    });
  return {
    competencia: "cancelamento",
    total: doDia.length,
    taxaDaCoortePct: pct(coorte.cancelados, coorte.recebidos),
    motivos: motivos.slice(0, MAX_MOTIVOS),
    outrosMotivos: Math.max(0, motivos.length - MAX_MOTIVOS),
    porOrigem: agrupar(doDia, (p) => p.cancel_origem ?? "NÃO INFORMADA").map((g) => ({ origem: g.chave, quantidade: g.quantidade })),
    porEstagio: agrupar(doDia, (p) => p.cancel_estagio ?? "NÃO INFORMADO").map((g) => ({ estagio: g.chave, quantidade: g.quantidade })),
    semMotivo: doDia.filter((p) => !p.cancel_codigo).length,
    valorOperacional: soma(doDia.map((p) => p.valor_total)),
    observacao: "Motivo, origem e estágio são os oficiais do iFood (evento CANCELLED). A origem indica quem cancelou, não a causa.",
  };
}

function indicadorDisputas(disputas, janela, agoraMs) {
  const abertas = disputas.filter((d) => dentroDe(d.dispute_created_at ?? d.criado_em, janela.inicioMs, janela.fimMs));
  const desfechoNoDia = disputas.filter((d) => dentroDe(d.settlement_at, janela.inicioMs, janela.fimMs));
  const pendentes = disputas.filter((d) => !["ACCEPTED", "REJECTED", "EXPIRED"].includes(d.settlement_status) && Number.isFinite(ms(d.expires_at)) && ms(d.expires_at) > agoraMs);
  return {
    abertasNoDia: abertas.length,
    expiradasNoDia: desfechoNoDia.filter((d) => d.settlement_status === "EXPIRED").length,
    aceitasNoDia: desfechoNoDia.filter((d) => d.settlement_status === "ACCEPTED").length,
    recusadasNoDia: desfechoNoDia.filter((d) => d.settlement_status === "REJECTED").length,
    alternativaNoDia: desfechoNoDia.filter((d) => d.settlement_status === "ALTERNATIVE_REPLIED").length,
    pendentesAgora: pendentes.length,
    venceEmAte10Min: pendentes.filter((d) => ms(d.expires_at) - agoraMs <= 10 * 60_000).length,
    porTipo: agrupar(abertas, (d) => d.handshake_type ?? "NÃO INFORMADO").map((g) => ({ tipo: g.chave, quantidade: g.quantidade })),
    semDadosDaAbertura: abertas.filter((d) => !d.handshake_type).length,
    observacao: "Abertas pela data de abertura; expiradas/aceitas/recusadas pela data do desfecho (HANDSHAKE_SETTLEMENT).",
  };
}

function indicadorDescontos(entrada) {
  const validos = entrada.filter((p) => p.status_oficial !== "CANCELLED");
  const comDados = validos.filter((p) => p.desconto_loja != null);
  const itens = soma(comDados.map((p) => p.valor_itens));
  const loja = soma(comDados.map((p) => p.desconto_loja));
  return {
    competencia: "entrada",
    natureza: "operacional (Order Details) — o valor efetivamente cobrado/repassado está no Financial",
    base: "pedidos recebidos no dia e não cancelados",
    pedidosNaBase: validos.length,
    pedidosSemDetalhes: validos.length - comDados.length,
    loja,
    pedidosComDescontoLoja: comDados.filter((p) => p.desconto_loja > 0).length,
    pctLojaSobreItens: itens > 0 ? arred((loja / itens) * 100) : null,
    ifood: soma(comDados.map((p) => p.desconto_ifood)),
    rede: soma(comDados.map((p) => p.desconto_rede)),
    externo: soma(comDados.map((p) => p.desconto_externo)),
    valorItens: itens,
  };
}

function indicadorClientes(entrada) {
  const com = entrada.filter((p) => p.cliente_pedidos_anteriores != null);
  const novos = com.filter((p) => p.cliente_pedidos_anteriores === 0).length;
  return {
    competencia: "entrada",
    definicao: "Novo = sem pedido anterior NESTA loja nos registros do iFood (customer.ordersCountOnMerchant = 0); recorrente = 1 ou mais.",
    unidadeDeContagem: "pedidos (o mesmo cliente com dois pedidos no dia conta duas vezes; nenhum dado do cliente é guardado)",
    base: entrada.length,
    novos,
    recorrentes: com.length - novos,
    semInformacao: entrada.length - com.length,
    pctNovos: pct(novos, com.length),
  };
}

/**
 * Situação do fechamento a partir da cobertura. INCOMPLETO nunca é "sem problemas": lista o que faltou.
 * @returns {{status: string, motivo: string, pendencias: {codigo: string, mensagem: string}[]}}
 */
export function decidirStatus({ competencia, hoje, agoraMs, janela, cobertura, coorte }) {
  const pendencias = [];
  if (cobertura.semCobertura) pendencias.push({ codigo: "SEM_COBERTURA", mensagem: "A unidade não recebia pedidos pela integração neste dia (anterior ao primeiro pedido registrado)." });
  if (cobertura.semSinalDeRecebimento) pendencias.push({ codigo: "SEM_SINAL_DE_RECEBIMENTO", mensagem: "Nenhum evento do iFood registrado no dia: não é possível afirmar que o dia não teve pedidos." });
  if (cobertura.fracaoSemDetalhes > LIMITE_SEM_DETALHES) pendencias.push({ codigo: "DETALHES_INSUFICIENTES", mensagem: `${cobertura.pedidosSemDetalhes} pedido(s) sem detalhes do iFood (${arred(cobertura.fracaoSemDetalhes * 100)}%): valores, descontos e clientes não são confiáveis.` });
  if (cobertura.projecaoComFalha) pendencias.push({ codigo: "PROJECAO_COM_FALHA", mensagem: "A camada analítica não foi atualizada para todos os pedidos do dia." });
  const incompleto = pendencias.length > 0;
  if (cobertura.pedidosSemChegada) pendencias.push({ codigo: "PEDIDOS_SEM_CHEGADA", mensagem: `${cobertura.pedidosSemChegada} pedido(s) sem o carimbo oficial de chegada: fora dos tempos.` });
  if (cobertura.detalhesDesatualizados) pendencias.push({ codigo: "DETALHES_DESATUALIZADOS", mensagem: `${cobertura.detalhesDesatualizados} pedido(s) alterado(s) depois da leitura dos detalhes.` });
  if (coorte.emAberto) pendencias.push({ codigo: "PEDIDOS_EM_ABERTO", mensagem: `${coorte.emAberto} pedido(s) recebido(s) no dia ainda sem conclusão ou cancelamento registrado.` });

  if (competencia === hoje) return { status: STATUS_FECHAMENTO.PRELIMINAR, motivo: "O dia ainda não terminou: números parciais.", pendencias };
  if (incompleto) return { status: STATUS_FECHAMENTO.INCOMPLETO, motivo: "Não há dados confiáveis suficientes para fechar o dia.", pendencias };
  if (agoraMs < janela.fimMs + JANELA_CONSOLIDACAO_MS) {
    return { status: STATUS_FECHAMENTO.PRELIMINAR, motivo: `Aguardando eventos atrasados até ${new Date(janela.fimMs + JANELA_CONSOLIDACAO_MS).toISOString()} antes de consolidar.`, pendencias };
  }
  return { status: STATUS_FECHAMENTO.CONSOLIDADO, motivo: "Janela de eventos atrasados encerrada; dados com cobertura.", pendencias };
}

/**
 * Fechamento de UMA competência.
 * @param {{competencia: string, hoje: string, agoraMs: number, fuso: string, fusoOrigem: string,
 *          dashboard: object, projecoes: object[], disputas: object[], cobertura: object}} p
 *   `dashboard` = montarDashboard do dia (MESMO cálculo da tela); `projecoes` = operacional_pedidos com chegada, conclusão ou
 *   cancelamento no dia; `disputas` = ifood_disputas abertas ou com desfecho no dia (ou ainda pendentes).
 */
export function calcularFechamento({ competencia, hoje, agoraMs, fuso, fusoOrigem, dashboard, projecoes, disputas, cobertura: cob }) {
  const janela = janelaDaCompetencia(competencia, fuso);
  const reais = projecoes.filter((p) => p.is_test !== true);
  const entrada = reais.filter((p) => dentroDe(p.plc_em ?? p.pedido_criado_em, janela.inicioMs, janela.fimMs));
  const r = dashboard.resumo;
  const coorte = { recebidos: r.pedidos, concluidos: r.concluidos, cancelados: r.cancelados, emAberto: r.emAndamento };

  const semDetalhes = entrada.filter((p) => p.itens_qtd == null).length;
  const cobertura = {
    ...cob,
    pedidosSemDetalhes: semDetalhes,
    fracaoSemDetalhes: entrada.length ? semDetalhes / entrada.length : 0,
    pedidosSemChegada: entrada.filter((p) => !p.plc_em).length,
    detalhesDesatualizados: entrada.filter((p) => p.detalhes_desatualizados).length,
    pedidosProjetados: entrada.length,
  };
  const situacao = decidirStatus({ competencia, hoje, agoraMs, janela, cobertura, coorte });

  const indicadores = {
    pedidos: {
      recebidos: r.pedidos,
      concluidosNoDia: reais.filter((p) => p.status_oficial === "CONCLUDED" && dentroDe(p.con_em, janela.inicioMs, janela.fimMs)).length,
      canceladosNoDia: reais.filter((p) => p.status_oficial === "CANCELLED" && dentroDe(p.can_em, janela.inicioMs, janela.fimMs)).length,
      coorte,
      pedidosTeste: dashboard.qualidade.pedidosTeste,
      observacao: "Recebidos pela chegada; concluídos e cancelados pela data da conclusão/cancelamento. A coorte mostra o destino dos recebidos no dia.",
    },
    preparo: indicadorTempo(dashboard, "preparo"),
    entrega: indicadorTempo(dashboard, "entrega"),
    vida: indicadorTempo(dashboard, "vida"),
    atrasos: {
      competencia: "entrada",
      pedidosAtrasados: r.pedidosAtrasados,
      pedidosAvaliados: r.pedidosAvaliados,
      pct: r.pctPedidosAtrasados,
      principalEtapa: principalEtapaComDesvio(dashboard),
      causaAtribuida: false,
      observacao: "Atraso = etapa acima da meta vigente no recebimento. Os eventos mostram ONDE o tempo passou da meta, não QUEM causou.",
    },
    cancelamentos: indicadorCancelamentos(reais, janela, coorte),
    movimento: {
      competencia: "entrada",
      picos: [...dashboard.demandaPorHora].filter((h) => h.pedidos > 0).sort((a, b) => b.pedidos - a.pedidos || a.hora - b.hora)
        .slice(0, MAX_PICOS).map((h) => ({ hora: h.hora, pedidos: h.pedidos, atrasados: h.atrasados })),
      horasComPedido: dashboard.demandaPorHora.filter((h) => h.pedidos > 0).length,
    },
    disputas: indicadorDisputas(disputas, janela, agoraMs),
    descontos: indicadorDescontos(entrada),
    clientes: indicadorClientes(entrada),
    comparacao: {
      referencia: dashboard.periodo.anterior,
      pedidos: dashboard.comparacao.pedidos,
      pctPedidosAtrasados: dashboard.comparacao.pctPedidosAtrasados,
      porEtapa: Object.fromEntries(ETAPAS.map((e) => [e, { media: dashboard.comparacao.porEtapa[e].media, pctDentro: dashboard.comparacao.porEtapa[e].pctDentro, amostras: dashboard.comparacao.porEtapa[e].amostras }])),
      canceladosAnterior: dashboard.anterior.cancelados,
      recebidosAnterior: dashboard.anterior.pedidos,
    },
  };

  return {
    regraVersao: REGRA_FECHAMENTO,
    competencia,
    fuso,
    fusoOrigem,
    janela: { inicio: new Date(janela.inicioMs).toISOString(), fim: new Date(janela.fimMs).toISOString() },
    status: situacao.status,
    statusMotivo: situacao.motivo,
    pendencias: situacao.pendencias,
    cobertura,
    indicadores,
    avisosDeQualidade: dashboard.qualidade.avisos,
    metasAplicaveis: dashboard.metasAplicaveis,
  };
}

/**
 * Hash do CONTEÚDO (o que muda o fechamento). Não entra o instante da geração nem o motivo textual do status
 * (que cita horários): duas gerações com os mesmos números e o mesmo status têm o mesmo hash.
 */
export function hashDoConteudo({ status, indicadores, pendencias, diagnostico, cobertura }) {
  const { ultimoEventoRecebidoEm: _u, ...coberturaEstavel } = cobertura ?? {};
  const pend = (pendencias ?? []).map((p) => p.codigo);
  const diag = { achados: (diagnostico?.achados ?? []).map((a) => ({ codigo: a.codigo, fato: a.fato })) };
  const ind = { ...indicadores, disputas: { ...indicadores.disputas, pendentesAgora: undefined, venceEmAte10Min: undefined } };
  return createHash("sha256").update(jsonEstavel({ status, indicadores: ind, pendencias: pend, diagnostico: diag, cobertura: coberturaEstavel })).digest("hex");
}
