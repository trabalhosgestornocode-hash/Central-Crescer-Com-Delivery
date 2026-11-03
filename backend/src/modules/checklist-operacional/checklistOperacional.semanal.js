// Dashboard Operacional — RESUMO SEMANAL (agregação dos fechamentos DIÁRIOS armazenados). Módulo PURO: sem banco, sem rede, sem provider.
//
// Regras (mesmo espírito do fechamento diário):
//   * a semana operacional é segunda a domingo; o resumo só nasce de uma semana ENCERRADA (nunca da semana em curso);
//   * usa SÓ fechamentos já armazenados e válidos (CONSOLIDADO/REVISADO, a versão mais recente de cada dia) — nada é recalculado a partir
//     de eventos, nada é preenchido: dia sem fechamento válido fica de fora e é declarado;
//   * exige cobertura mínima (MIN_DIAS_VALIDOS de 7); abaixo disso a semana é INCOMPLETA e NÃO gera mensagem (nunca vira "sem problema");
//   * médias de tempo são PONDERADAS pelo número de pedidos de cada dia (nunca média de médias); razões somam numeradores e denominadores;
//   * nenhum responsável é atribuído e nenhum dado pessoal entra (os fechamentos não têm nenhum).
import { createHash } from "node:crypto";
import { validarMensagem, LIMITE_CARACTERES, nomeSeguro, RODAPE, RECOMENDACAO_CHAMADOS, pontoChamadosExpirados, PONTO_SEM_METAS } from "./checklistOperacional.whatsapp.js";
import { LIMIARES_DIAGNOSTICO } from "./checklistOperacional.diagnostico.js";

export const MIN_DIAS_VALIDOS = 5;
export const STATUS_SEMANA = Object.freeze({ COMPLETA: "COMPLETA", PARCIAL: "PARCIAL", INCOMPLETA: "INCOMPLETA" });
const STATUS_VALIDOS = new Set(["CONSOLIDADO", "REVISADO"]);
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;
const paraMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const paraIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmt = (v, casas = 1) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const ND = "não disponível";
const brl = (v) => Number(v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hh = (h) => `${String(h).padStart(2, "0")}h`;
const NOMES_DIA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** Segunda-feira da semana que contém a data (ISO yyyy-mm-dd). */
export function segundaDaSemana(iso) {
  if (!RE_DATA.test(String(iso))) throw new Error("data inválida");
  const ms = paraMs(iso); const dow = new Date(ms).getUTCDay();   // 0 = domingo
  return paraIso(ms - ((dow + 6) % 7) * DIA_MS);
}
/** Os 7 dias (segunda a domingo) da semana que começa em `segunda`. */
export const diasDaSemana = (segunda) => Array.from({ length: 7 }, (_, i) => paraIso(paraMs(segunda) + i * DIA_MS));
/** Última semana ENCERRADA em relação a `hojeIso` (a semana em curso nunca é resumida). */
export const ultimaSemanaEncerrada = (hojeIso) => paraIso(paraMs(segundaDaSemana(hojeIso)) - 7 * DIA_MS);

/** Do conjunto de versões armazenadas, a MAIS RECENTE VÁLIDA de cada dia da semana. */
export function fechamentosValidosDaSemana(segunda, versoes) {
  const dias = diasDaSemana(segunda); const porDia = new Map();
  for (const f of versoes ?? []) {
    if (!f || !dias.includes(f.competencia) || !STATUS_VALIDOS.has(f.status) || !f.indicadores) continue;
    const atual = porDia.get(f.competencia);
    if (!atual || Number(f.versao) > Number(atual.versao)) porDia.set(f.competencia, f);
  }
  return dias.map((d) => ({ dia: d, fechamento: porDia.get(d) ?? null }));
}

const soma = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
function tempoPonderado(dias, chave) {
  const ok = dias.map((d) => d.fechamento.indicadores[chave]).filter((t) => t?.estado === "calculado" && Number(t.amostras) > 0 && Number.isFinite(Number(t.media)));
  const n = soma(ok.map((t) => t.amostras));
  if (!n) return { estado: "indisponivel", amostras: 0, media: null };
  return { estado: "calculado", amostras: n, media: soma(ok.map((t) => Number(t.media) * Number(t.amostras))) / n, diasComDado: ok.length };
}

/**
 * @param {string} segunda  segunda-feira da semana
 * @param {Array<object>} versoes  versões armazenadas dos fechamentos diários da unidade (qualquer ordem)
 * @param {{minimoDias?: number}} [opcoes]
 */
export function resumirSemana(segunda, versoes, { minimoDias = MIN_DIAS_VALIDOS } = {}) {
  const porDia = fechamentosValidosDaSemana(segunda, versoes);
  const validos = porDia.filter((d) => d.fechamento);
  const ausentes = porDia.filter((d) => !d.fechamento).map((d) => d.dia);
  const status = validos.length < minimoDias ? STATUS_SEMANA.INCOMPLETA : validos.length === 7 ? STATUS_SEMANA.COMPLETA : STATUS_SEMANA.PARCIAL;
  const base = { semanaInicio: segunda, semanaFim: diasDaSemana(segunda)[6], status, diasValidos: validos.length, diasAusentes: ausentes, minimoDias };
  if (status === STATUS_SEMANA.INCOMPLETA) return { ...base, indicadores: null, hash: hashDe(base, []) };

  const I = (d) => d.fechamento.indicadores;
  const avaliados = soma(validos.map((d) => I(d).atrasos?.pedidosAvaliados));
  const atrasados = soma(validos.map((d) => I(d).atrasos?.pedidosAtrasados));
  const motivos = new Map();
  for (const d of validos) for (const m of I(d).cancelamentos?.motivos ?? []) { const k = m.descricao ?? m.codigo; motivos.set(k, (motivos.get(k) ?? 0) + (Number(m.quantidade) || 0)); }
  const recebidosPorDia = validos.map((d) => ({ dia: d.dia, recebidos: Number(I(d).pedidos?.recebidos) || 0 }));
  const maior = [...recebidosPorDia].sort((a, b) => b.recebidos - a.recebidos || a.dia.localeCompare(b.dia))[0];
  // horário de pico: a faixa que mais vezes foi o MAIOR pico do dia (os fechamentos guardam só os picos de cada dia, não a curva inteira —
  // somar faixas entre dias subestimaria; contar em quantos dias cada faixa liderou é exato)
  const lideres = new Map(); let diasComPico = 0;
  for (const d of validos) {
    const top = I(d).movimento?.picos?.[0]; if (!top || !(top.pedidos > 0)) continue;
    diasComPico++; const l = lideres.get(top.hora) ?? { hora: top.hora, dias: 0, pedidos: 0 }; l.dias++; l.pedidos += top.pedidos; lideres.set(top.hora, l);
  }
  const pico = [...lideres.values()].sort((a, b) => b.dias - a.dias || b.pedidos - a.pedidos || a.hora - b.hora)[0];
  // clientes: a contagem do fechamento é POR PEDIDO (cada pedido pertence a um único dia), então a soma não conta nenhum pedido duas vezes
  const comClientes = validos.filter((d) => I(d).clientes?.base);
  const indicadores = {
    pedidos: { recebidos: soma(validos.map((d) => I(d).pedidos?.recebidos)), concluidos: soma(validos.map((d) => I(d).pedidos?.concluidosNoDia)), cancelados: soma(validos.map((d) => I(d).pedidos?.canceladosNoDia)) },
    preparo: tempoPonderado(validos, "preparo"), entrega: tempoPonderado(validos, "entrega"), vida: tempoPonderado(validos, "vida"),
    atrasos: { pedidosAvaliados: avaliados, pedidosAtrasados: atrasados, pct: avaliados ? (atrasados / avaliados) * 100 : null },
    cancelamentos: { total: soma(validos.map((d) => I(d).cancelamentos?.total)), motivos: [...motivos].map(([descricao, quantidade]) => ({ descricao, quantidade })).sort((a, b) => b.quantidade - a.quantidade || a.descricao.localeCompare(b.descricao)).slice(0, 3) },
    disputas: { abertas: soma(validos.map((d) => I(d).disputas?.abertasNoDia)), expiradas: soma(validos.map((d) => I(d).disputas?.expiradasNoDia)) },
    descontosLoja: { valor: soma(validos.map((d) => I(d).descontos?.loja)), pedidos: soma(validos.map((d) => I(d).descontos?.pedidosComDescontoLoja)) },
    diaDeMaiorMovimento: maior && maior.recebidos > 0 ? { dia: maior.dia, recebidos: maior.recebidos } : null,
    horarioDePico: pico ? { hora: pico.hora, dias: pico.dias, diasComDado: diasComPico } : null,
    clientes: comClientes.length ? { novos: soma(comClientes.map((d) => I(d).clientes.novos)), recorrentes: soma(comClientes.map((d) => I(d).clientes.recorrentes)), semInformacao: soma(comClientes.map((d) => I(d).clientes.semInformacao)), diasComDado: comClientes.length, unidadeDeContagem: "pedidos" } : null,
    semMetas: validos.every((d) => ["preparo", "entrega", "vida"].every((k) => I(d)[k]?.meta == null)),
  };
  return { ...base, indicadores, hash: hashDe(base, validos) };
}
// o hash muda se mudar qualquer versão de qualquer dia usada (uma correção diária gera um resumo REVISADO, nunca silencioso)
const hashDe = (base, validos) => createHash("sha256").update(JSON.stringify([base.semanaInicio, base.status, validos.map((d) => [d.dia, d.fechamento.id ?? null, d.fechamento.versao ?? null, d.fechamento.hash_conteudo ?? null])])).digest("hex").slice(0, 32);

/** Mensagem do resumo semanal (mesma identidade visual do diário, ≤ 1500). Semana INCOMPLETA NÃO gera mensagem. */
export function gerarMensagemSemanal({ resumo, unidadeNome = null }) {
  if (!resumo || resumo.status === STATUS_SEMANA.INCOMPLETA || !resumo.indicadores) return null;
  const i = resumo.indicadores;
  const nome = nomeSeguro(unidadeNome);
  const diaBr = (d) => `${NOMES_DIA[new Date(paraMs(d)).getUTCDay()]} ${dataBr(d)}`;
  const tempo = (rotulo, t) => `• ${rotulo}: ${t.estado === "calculado" ? `${fmt(t.media)} min` : ND}`;
  const situacao = resumo.status === STATUS_SEMANA.COMPLETA ? "Semana completa" : "Semana parcial";
  const cobertura = `Cobertura: ${resumo.diasValidos} de 7 dias com fechamento válido${resumo.diasAusentes.length ? ` (sem fechamento: ${resumo.diasAusentes.map(diaBr).join(", ")})` : ""}`;
  const cl = i.clientes;
  const pico = i.horarioDePico;
  const analise = analiseSemanal(resumo);
  // Os NÚMEROS nunca são cortados. Se a semana tiver muitos alertas e o texto passar do limite, encolhem nesta ordem: motivos de
  // cancelamento (o principal já está nos pontos de atenção), recomendações e, por último, pontos de atenção.
  const variantes = [[2, 3, 5], [0, 3, 5], [0, 2, 5], [0, 1, 4], [0, 1, 3]];
  let texto = null;
  for (const [nMotivos, nRec, nPontos] of variantes) {
    texto = montarSemanal({ resumo, i, nome, diaBr, tempo, situacao, cobertura, cl, pico, motivos: i.cancelamentos.motivos.slice(0, nMotivos).map((m) => `${m.descricao}: ${m.quantidade}`), pontos: analise.pontos.slice(0, nPontos), recomendacoes: analise.recomendacoes.slice(0, nRec) });
    if (texto.length <= LIMITE_CARACTERES) break;
  }
  return texto;
}

function montarSemanal({ resumo, i, nome, diaBr, tempo, situacao, cobertura, cl, pico, motivos, pontos, recomendacoes }) {
  const linhas = [
    "*CRESCER COM DELIVERY*", "*RESUMO OPERACIONAL SEMANAL*", "",
    ...(nome ? [`*${nome}*`] : []),
    `${dataBr(resumo.semanaInicio)} a ${dataBr(resumo.semanaFim)}/${resumo.semanaFim.slice(0, 4)} | ${situacao}`,
    cobertura, "",
    "*RESUMO DA SEMANA*",
    `• Pedidos recebidos: ${i.pedidos.recebidos}`, `• Pedidos concluídos: ${i.pedidos.concluidos}`,
    `• Cancelamentos: ${i.pedidos.cancelados}${i.pedidos.cancelados && motivos.length ? ` (${motivos.join("; ")})` : ""}`, "",
    "*DESEMPENHO OPERACIONAL*", "_Médias ponderadas pelo número de pedidos_",
    tempo("Tempo médio de preparo", i.preparo), tempo("Tempo médio de entrega", i.entrega), tempo("Tempo total do pedido", i.vida),
    ...(i.atrasos.pedidosAvaliados ? [`• Pedidos acima da meta: ${i.atrasos.pedidosAtrasados} de ${i.atrasos.pedidosAvaliados} (${fmt(i.atrasos.pct)}%)`] : []), "",
    "*MOVIMENTO*",
    i.diaDeMaiorMovimento ? `• Dia de maior movimento: ${diaBr(i.diaDeMaiorMovimento.dia)} — ${i.diaDeMaiorMovimento.recebidos} pedidos` : "• Sem pedidos na semana.",
    ...(pico ? [`• Horário de pico mais frequente: ${hh(pico.hora)} às ${hh((pico.hora + 1) % 24)} (maior pico em ${pico.dias} de ${pico.diasComDado} dias)`] : []), "",
    "*CLIENTES*",
    ...(cl && cl.novos + cl.recorrentes ? [`• Pedidos de clientes novos: ${cl.novos}`, `• Pedidos de clientes recorrentes: ${cl.recorrentes}`] : [`• ${ND}`]), "",
    "*INDICADORES FINANCEIROS*",
    `• Descontos financiados pela loja: ${brl(i.descontosLoja.valor)}`, `• Pedidos com desconto: ${i.descontosLoja.pedidos}`, "",
    "*CHAMADOS*", `• Abertos na semana: ${i.disputas.abertas}`, `• Com prazo expirado: ${i.disputas.expiradas}`, "",
    "*PONTOS DE ATENÇÃO*", ...pontos.map((t) => `• ${t}`), "",
    "*RECOMENDAÇÕES*", ...recomendacoes.map((t) => `• ${t}`), "",
    RODAPE,
  ];
  return linhas.join("\n");
}

/**
 * Pontos de atenção e recomendações da semana — DETERMINÍSTICOS, com os mesmos limiares aprovados do diagnóstico diário
 * (LIMIARES_DIAGNOSTICO) aplicados aos totais da semana. Nada é inferido além dos indicadores.
 */
export function analiseSemanal(resumo) {
  const i = resumo.indicadores; const L = LIMIARES_DIAGNOSTICO;
  const pontos = []; const rec = [];
  if (i.disputas.expiradas > 0) { pontos.push(pontoChamadosExpirados(i.disputas.expiradas)); rec.push(RECOMENDACAO_CHAMADOS.DISPUTAS_EXPIRADAS); }
  const a = i.atrasos;
  if (a.pedidosAvaliados >= L.atrasoMinAvaliados && a.pct != null && a.pct >= L.atrasoPctAtencao) {
    pontos.push(`${fmt(a.pct)}% dos pedidos avaliados ficaram acima da meta de tempo.`);
    rec.push("Abra a lista de atrasos no Dashboard e confira os horários e etapas com maior excedente.");
  }
  const p = i.pedidos;
  const taxa = p.recebidos ? (p.cancelados / p.recebidos) * 100 : null;
  if (p.recebidos >= L.cancelMinRecebidos && taxa != null && taxa >= L.cancelTaxaAtencaoPct) {
    const top = i.cancelamentos.motivos[0];
    pontos.push(`Taxa de cancelamento de ${fmt(taxa)}% na semana${top ? `; motivo oficial mais frequente: ${top.descricao}` : ""}.`);
    rec.push("Revise os cancelamentos da semana pelos motivos oficiais do iFood e trate o motivo mais frequente.");
  }
  if (i.semMetas) { pontos.push(PONTO_SEM_METAS); rec.push("Configure as metas de tempo no Dashboard Operacional para acompanhar os atrasos."); }
  if (resumo.status === STATUS_SEMANA.PARCIAL) pontos.push(`${7 - resumo.diasValidos} dia(s) sem fechamento válido: os totais cobrem ${resumo.diasValidos} de 7 dias.`);
  if (!pontos.length) pontos.push("Nenhum desvio relevante identificado nos indicadores da semana.");
  if (!rec.length) rec.push("Mantenha a rotina atual e acompanhe o próximo resumo.");
  return { pontos, recomendacoes: rec.slice(0, 3) };
}

/** Validação da mensagem semanal: mesmos bloqueios do diário (dados pessoais, tamanho, termo interno) + exige a cobertura da semana. */
export function validarMensagemSemanal(texto, resumo) {
  const v = validarMensagem(texto);
  const problemas = [...v.problemas];
  if (resumo && !/Cobertura: \d de 7 dias/.test(String(texto ?? ""))) problemas.push({ codigo: "SEM_STATUS", mensagem: "A mensagem precisa informar a cobertura da semana." });
  return { ok: problemas.length === 0, problemas, tamanho: v.tamanho, limite: LIMITE_CARACTERES };
}

/** Chave de idempotência por unidade + semana + destinatário + conteúdo: a mesma semana/versão nunca vai duas vezes ao mesmo destinatário. */
export const chaveSemanal = (unidadeId, semanaInicio, destinatarioId, resumoHash) => `wa:sem:${unidadeId}:${semanaInicio}:${destinatarioId}:${resumoHash}`;
