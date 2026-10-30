// Dashboard Operacional 2.0 — DIAGNÓSTICO DETERMINÍSTICO do fechamento (função pura).
//
// Lê SÓ os indicadores já calculados do fechamento (checklistOperacional.fechamento.js) e aplica regras fixas com limiares e
// amostra mínima. Cada achado traz: o FATO (com os números que o sustentam), a REFERÊNCIA (meta, limiar ou período anterior),
// a AMOSTRA, a CONFIANÇA e uma AÇÃO da biblioteca aprovada. Nunca:
//   * atribui responsável ou causa (os eventos mostram onde o tempo passou da meta, não por quê);
//   * inventa motivo de cancelamento (usa só o código/descrição oficiais);
//   * estima impacto financeiro (descontos e valores são operacionais e citados como tal).
// Sem amostra mínima a regra NÃO dispara e isso é dito em `naoAvaliadas`. Sem achado, o diagnóstico é INFORMATIVO.
//
// A camada de IA (checklistOperacional.redacao.js) só reescreve estes achados em linguagem gerencial — não cria nenhum.

import { NOME_ETAPA } from "./checklistOperacional.indicadores.js";

export const LIMIARES_DIAGNOSTICO = Object.freeze({
  tempoMinAmostras: 5,          // média de etapa só é comparada com a meta com pelo menos 5 medições
  tempoAltaPctAcimaMeta: 20,    // média ≥ 20% acima da meta = prioridade alta
  atrasoMinAvaliados: 10, atrasoPctAtencao: 30, atrasoPctAlta: 50,
  cancelMinRecebidos: 10, cancelTaxaAtencaoPct: 5, cancelAumentoPP: 3,
  horarioMinPedidos: 5, horarioPctAtrasados: 50,
  quedaMinAmostras: 10, quedaPP: 10,
  descontoLojaPctAtencao: 20, descontoMinPedidos: 10,
});
const L = LIMIARES_DIAGNOSTICO;

/** Biblioteca de ações (texto fixo e revisável). A IA só pode escolher entre estas — nunca criar outra. */
export const ACOES = Object.freeze({
  DADOS_INCOMPLETOS: "Verificar a integração com o iFood (status em Integrações) antes de usar os números deste dia.",
  DISPUTAS_PENDENTES: "Responder as disputas abertas no Gestor de Pedidos antes do vencimento.",
  DISPUTAS_EXPIRADAS: "Revisar quem acompanha a Plataforma de Negociação nos horários de pico e como é avisado.",
  PREPARO_ACIMA_META: "Revisar a escala da cozinha e a marcação de \"pronto\"/\"despachado\" no PDV nos horários de maior volume.",
  ENTREGA_ACIMA_META: "Conferir os pedidos com entrega mais longa (lista no Dashboard) e a previsão informada pelo iFood.",
  VIDA_ACIMA_META: "Comparar preparo e entrega dos pedidos atrasados para ver em qual etapa o tempo se concentrou.",
  ATRASOS_ELEVADOS: "Abrir a lista de atrasos no Dashboard e conferir os pedidos com maior excedente.",
  CONCENTRACAO_HORARIO: "Reforçar a operação na faixa de horário com mais atrasos.",
  CANCELAMENTO_ELEVADO: "Revisar os cancelamentos do dia pelos motivos oficiais do iFood e tratar o motivo mais frequente.",
  CANCELAMENTO_EM_ALTA: "Comparar os motivos de cancelamento com os do dia anterior.",
  QUEDA_EFICIENCIA: "Comparar os horários e as etapas com mais atrasos com os do período anterior.",
  DESCONTO_LOJA_ELEVADO: "Conferir as campanhas com desconto financiado pela loja ativas no dia.",
  SEM_DESVIO: "Manter a rotina atual e acompanhar o próximo fechamento.",
});

const SEV = { alta: 3, media: 2, informativa: 1 };
const fmt = (v, casas = 1) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const brl = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const hh = (h) => `${String(h).padStart(2, "0")}h`;

function achado(codigo, { severidade, titulo, fato, referencia, amostra, evidencias = {}, confianca = "alta" }) {
  return { codigo, severidade, titulo, fato, referencia, amostra, evidencias, confianca, acao: ACOES[codigo] ?? null };
}

/**
 * @param {object} f  resultado de calcularFechamento (sem diagnóstico)
 * @returns {{achados: object[], principal: object, naoAvaliadas: string[], informativo: boolean, regra: string}}
 */
export function gerarDiagnostico(f) {
  const i = f.indicadores;
  const achados = [];
  const nao = [];

  if (f.status === "INCOMPLETO") {
    achados.push(achado("DADOS_INCOMPLETOS", {
      severidade: "alta", titulo: "Dados insuficientes para fechar o dia",
      fato: f.pendencias.filter((p) => ["SEM_COBERTURA", "SEM_SINAL_DE_RECEBIMENTO", "DETALHES_INSUFICIENTES", "PROJECAO_COM_FALHA"].includes(p.codigo)).map((p) => p.mensagem).join(" "),
      referencia: "cobertura da integração", amostra: i.pedidos.recebidos,
    }));
  }

  // Disputas
  if (i.disputas.pendentesAgora > 0) {
    achados.push(achado("DISPUTAS_PENDENTES", {
      severidade: "alta", titulo: "Disputas aguardando resposta",
      fato: `${i.disputas.pendentesAgora} disputa(s) sem desfecho e dentro do prazo${i.disputas.venceEmAte10Min ? `, ${i.disputas.venceEmAte10Min} vencendo em até 10 min` : ""}.`,
      referencia: "prazo informado pelo iFood (expiresAt)", amostra: i.disputas.pendentesAgora,
    }));
  }
  if (i.disputas.expiradasNoDia > 0) {
    achados.push(achado("DISPUTAS_EXPIRADAS", {
      severidade: "media", titulo: "Disputas expiradas sem resposta",
      fato: `${i.disputas.expiradasNoDia} disputa(s) expiraram no dia (desfecho EXPIRED do iFood).`,
      referencia: "desfecho oficial da negociação", amostra: i.disputas.expiradasNoDia,
    }));
  }

  // Tempos contra a meta
  for (const etapa of ["preparo", "entrega", "vida"]) {
    const t = i[etapa];
    if (t.estado !== "calculado" || t.meta == null) { nao.push(`${NOME_ETAPA[etapa]}: sem média ou sem meta vigente.`); continue; }
    if (t.amostras < L.tempoMinAmostras) { nao.push(`${NOME_ETAPA[etapa]}: ${t.amostras} medição(ões), mínimo ${L.tempoMinAmostras}.`); continue; }
    if (t.media > t.meta) {
      const acimaPct = ((t.media - t.meta) / t.meta) * 100;
      achados.push(achado(`${etapa.toUpperCase()}_ACIMA_META`, {
        severidade: acimaPct >= L.tempoAltaPctAcimaMeta ? "alta" : "media",
        titulo: `${NOME_ETAPA[etapa]} acima da meta`,
        fato: `${NOME_ETAPA[etapa]} médio de ${fmt(t.media)} min contra meta de ${fmt(t.meta)} min (+${fmt(t.desvioDaMetaMin)} min), em ${t.amostras} pedidos.`,
        referencia: `meta vigente (versão ${t.metaVersao ?? "—"})`, amostra: t.amostras,
      }));
    }
  }

  // Atrasos
  const a = i.atrasos;
  if (a.pedidosAvaliados >= L.atrasoMinAvaliados && a.pct != null && a.pct >= L.atrasoPctAtencao) {
    achados.push(achado("ATRASOS_ELEVADOS", {
      severidade: a.pct >= L.atrasoPctAlta ? "alta" : "media", titulo: "Muitos pedidos atrasados",
      fato: `${a.pedidosAtrasados} de ${a.pedidosAvaliados} pedidos avaliados (${fmt(a.pct)}%) passaram da meta${a.principalEtapa ? `; a etapa com mais atrasos foi ${a.principalEtapa.nome.toLowerCase()} (${a.principalEtapa.atrasos})` : ""}.`,
      referencia: `limiar de ${L.atrasoPctAtencao}% dos pedidos avaliados`, amostra: a.pedidosAvaliados,
    }));
  } else if (a.pedidosAvaliados < L.atrasoMinAvaliados) nao.push(`Atrasos: ${a.pedidosAvaliados} pedido(s) avaliado(s), mínimo ${L.atrasoMinAvaliados}.`);

  // Concentração de atrasos num horário
  const pico = (i.movimento.picos ?? []).find((h) => h.pedidos >= L.horarioMinPedidos && h.atrasados / h.pedidos * 100 >= L.horarioPctAtrasados);
  if (pico) {
    achados.push(achado("CONCENTRACAO_HORARIO", {
      severidade: "media", titulo: "Atrasos concentrados em um horário",
      fato: `Entre ${hh(pico.hora)} e ${hh((pico.hora + 1) % 24)}: ${pico.atrasados} de ${pico.pedidos} pedidos atrasados.`,
      referencia: `faixa com pelo menos ${L.horarioMinPedidos} pedidos e ${L.horarioPctAtrasados}% atrasados`, amostra: pico.pedidos,
      evidencias: { hora: pico.hora },
    }));
  }

  // Cancelamentos
  const c = i.cancelamentos;
  const coorte = i.pedidos.coorte;
  if (coorte.recebidos >= L.cancelMinRecebidos) {
    if (c.taxaDaCoortePct != null && c.taxaDaCoortePct >= L.cancelTaxaAtencaoPct) {
      const top = c.motivos[0];
      achados.push(achado("CANCELAMENTO_ELEVADO", {
        severidade: "media", titulo: "Taxa de cancelamento elevada",
        fato: `${coorte.cancelados} de ${coorte.recebidos} pedidos recebidos no dia foram cancelados (${fmt(c.taxaDaCoortePct)}%)${top?.codigo ? `; motivo oficial mais frequente no dia: ${top.descricao ?? top.codigo} (${top.quantidade})` : ""}.`,
        referencia: `limiar de ${L.cancelTaxaAtencaoPct}%`, amostra: coorte.recebidos,
      }));
    }
    const ant = i.comparacao;
    const taxaAnt = ant.recebidosAnterior >= L.cancelMinRecebidos ? (ant.canceladosAnterior / ant.recebidosAnterior) * 100 : null;
    if (taxaAnt != null && c.taxaDaCoortePct != null && c.taxaDaCoortePct - taxaAnt >= L.cancelAumentoPP) {
      achados.push(achado("CANCELAMENTO_EM_ALTA", {
        severidade: "media", titulo: "Cancelamentos em alta frente ao dia anterior",
        fato: `Taxa de cancelamento de ${fmt(c.taxaDaCoortePct)}% contra ${fmt(taxaAnt)}% no dia anterior (+${fmt(c.taxaDaCoortePct - taxaAnt)} p.p.).`,
        referencia: "dia anterior (mesma régua)", amostra: coorte.recebidos,
      }));
    }
  } else nao.push(`Cancelamentos: ${coorte.recebidos} pedido(s) recebido(s), mínimo ${L.cancelMinRecebidos}.`);

  // Queda de eficiência (pedidos dentro da meta) frente ao período anterior
  const pa = i.comparacao.pctPedidosAtrasados;
  if (pa?.atual != null && pa?.anterior != null && a.pedidosAvaliados >= L.quedaMinAmostras && pa.diferencaPP != null && pa.diferencaPP >= L.quedaPP) {
    achados.push(achado("QUEDA_EFICIENCIA", {
      severidade: "media", titulo: "Mais atrasos que no dia anterior",
      fato: `Pedidos atrasados subiram de ${fmt(pa.anterior)}% para ${fmt(pa.atual)}% (+${fmt(pa.diferencaPP)} p.p.).`,
      referencia: "dia anterior (mesma régua)", amostra: a.pedidosAvaliados,
    }));
  }

  // Descontos financiados pela loja
  const d = i.descontos;
  if (d.pedidosNaBase >= L.descontoMinPedidos && d.pctLojaSobreItens != null && d.pctLojaSobreItens >= L.descontoLojaPctAtencao) {
    achados.push(achado("DESCONTO_LOJA_ELEVADO", {
      severidade: "informativa", titulo: "Descontos financiados pela loja elevados",
      fato: `Descontos pagos pela loja somaram ${brl(d.loja)} (${fmt(d.pctLojaSobreItens)}% do valor dos itens) em ${d.pedidosNaBase} pedidos.`,
      referencia: `limiar de ${L.descontoLojaPctAtencao}% (valor operacional; o cobrado está no Financial)`, amostra: d.pedidosNaBase,
    }));
  }

  achados.sort((x, y) => SEV[y.severidade] - SEV[x.severidade]);
  const informativo = achados.length === 0;
  const principal = achados[0] ?? achado("SEM_DESVIO", {
    severidade: "informativa", titulo: "Nenhum desvio relevante",
    fato: i.pedidos.recebidos ? "Com os dados disponíveis, nenhuma regra de desvio disparou no dia." : "Nenhum pedido recebido no dia: não há o que diagnosticar.",
    referencia: "regras determinísticas do fechamento", amostra: i.pedidos.recebidos, confianca: "alta",
  });
  return { regra: "deterministica-v1", achados, principal, naoAvaliadas: nao, informativo };
}

/** Texto determinístico (fallback da IA e base da prévia): achado principal + ação. */
export function textoDeterministico(diag) {
  const p = diag.principal;
  return { diagnostico: `${p.titulo}: ${p.fato}`, acao: p.acao ?? ACOES.SEM_DESVIO, origem: "deterministico" };
}
