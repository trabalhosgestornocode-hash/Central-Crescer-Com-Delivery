// RELATÓRIO DIÁRIO DO DASHBOARD iFOOD NO GRUPO INTERNO ("Crescer Com Delivery - Central") — Fase 4.
//
// FLUXO INDEPENDENTE do alerta individual `dashboard_ifood_d1` (comunicacao.alertas.service.js). Por construção:
//   * NÃO importa comunicacao.alertas.service.js e NÃO escreve em comunicacao_alertas nem em comunicacao_mensagens;
//   * a ÚNICA leitura do fluxo individual é informativa ("loja já avisada hoje": SIM/NÃO, SELECT em comunicacao_mensagens) —
//     ela nunca cria, altera, cancela, adia ou bloqueia uma mensagem individual;
//   * registro e idempotência próprios: comunicacao_envios_grupo (migration 109), UNIQUE(chave_idempotencia);
//   * envio pelo mecanismo de grupo JÁ HOMOLOGADO (comunicacao.grupoInterno.js#enviarAoGrupoInterno → WhatsAppService).
//
// QUANDO: segunda a sábado, a partir das 16:30 de America/Sao_Paulo (domingo não roda). Quem chama é o worker de comunicação
// embutido (worker-comunicacao/loop.js), a cada tick, num passo SEPARADO do ciclo individual — nenhum cron/serviço novo.
// Depois do envio do dia, cada tick só faz UMA leitura pela chave e sai.
//
// FONTE ÚNICA: administrativo.service.pendencias() — lida como está (sem alterar pendencias/avaliarFrota/rollupUnidade, a
// classificação 🔴/🟡 nem a regra D-1).
//
// MODO SEGURO (env IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO):
//   DESLIGADO (padrão/ausente/valor inválido) — o passo nem é instalado no worker;
//   SIMULACAO — no horário, monta o relatório e só LOGA contagens (uma vez por dia por processo): nada reservado, nada enviado;
//   ATIVO     — reserva a chave do dia e envia ao grupo.

import { pendencias as pendenciasDoPainel } from "../administrativo/administrativo.service.js";
import { supabase } from "../../config/supabase.js";
import { partesLocais, inicioDoDiaLocal } from "./comunicacao.horario.js";
import { TIPOS_ALERTA } from "./comunicacao.constants.js";
import {
  TABELA, TIPO_ENVIO_GRUPO, STATUS_ENVIO_GRUPO, enviarAoGrupoInterno, obterPorChave, logGrupo, mascararJidGrupo,
} from "./comunicacao.grupoInterno.js";

import {
  TIMEZONE_RELATORIO, HORARIO_RELATORIO, LIMITE_RELATORIO, DIAS_RELATORIO, MODOS_RELATORIO, modoRelatorio,
} from "./relatorioDashboardGrupo.config.js";

export { TIMEZONE_RELATORIO, HORARIO_RELATORIO, LIMITE_RELATORIO, DIAS_RELATORIO, MODOS_RELATORIO, modoRelatorio };
/** Teto do Gateway é 4096; folga para o rodapé de truncamento. */
const LIMITE_TEXTO = 3800;
const STATUS_AVISO_SAIU = ["SENT", "DELIVERED", "READ"];

/** Chave de idempotência do dia: data LOCAL (America/Sao_Paulo) + JID. */
export const chaveRelatorio = (dataLocal, grupoJid) => `ifood_dashboard_alert:${dataLocal}:${grupoJid}`;

const pad2 = (n) => String(n).padStart(2, "0");
const isoLocal = (p) => `${p.ano}-${pad2(p.mes)}-${pad2(p.dia)}`;
const emMin = (h) => h.hora * 60 + h.minuto;
const dataBr = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split("-").reverse().join("/") : null);

/**
 * Situação do relógio para o relatório. Função PURA.
 * @param {Date} agora
 * @returns {{dataLocal: string, horaLocal: string, situacao: 'DOMINGO'|'ANTES_DO_HORARIO'|'NO_HORARIO'|'APOS_LIMITE'}}
 */
export function avaliarHorarioDoRelatorio(agora) {
  const p = partesLocais(agora, TIMEZONE_RELATORIO);
  const base = { dataLocal: isoLocal(p), horaLocal: `${pad2(p.hora)}:${pad2(p.minuto)}` };
  if (!DIAS_RELATORIO.includes(p.diaSemana)) return { ...base, situacao: "DOMINGO" };
  const m = p.hora * 60 + p.minuto;
  if (m < emMin(HORARIO_RELATORIO)) return { ...base, situacao: "ANTES_DO_HORARIO" };
  if (m >= emMin(LIMITE_RELATORIO)) return { ...base, situacao: "APOS_LIMITE" };
  return { ...base, situacao: "NO_HORARIO" };
}

// ---------------------------------------------------------------------------
// FORMATADOR — "Boletim de Pendências | iFood". Só APRESENTAÇÃO: toda contagem/classificação vem de pendencias() como está.
// Formatação de texto do WhatsApp apenas (*negrito*, _itálico_, quebras de linha reais) — nunca HTML/entidades/Markdown.
// ---------------------------------------------------------------------------

const SEPARADOR = "━━━━━━━━━━━━━━━━━━";
const DIAS_SEMANA = Object.freeze(["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"]);
const UFS = "AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO";
const RE_UF_FINAL = new RegExp(`\\s*(?:-|—)?\\s*\\b(?:${UFS})$`);

/** Motivo da classificação crítica, só com o que pendencias() já informa (nunca recalcula). */
const MOTIVO_D1 = Object.freeze({
  nao_realizado: "D-1 não lançado",
  em_preenchimento: "D-1 em preenchimento",
  sequencia_bloqueada: "Sequência de lançamentos bloqueada",
});

const dataCurta = (iso) => (dataBr(iso) ?? "—").slice(0, 5);
const diaDaSemana = (iso) => DIAS_SEMANA[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const plural = (n, um, varios) => (n === 1 ? um : varios);

/**
 * Nome para EXIBIÇÃO: tira o prefixo "Matriz", abrevia "Avenida", troca " - " por " — " e remove a UF final. O dado oficial não muda.
 * Se dois nomes simplificados coincidirem, os envolvidos voltam ao nome oficial (só com espaços normalizados) para não gerar ambiguidade.
 * @param {object[]} unidades
 * @returns {Map<string, string>} unidadeId -> nome exibido
 */
export function nomesDeExibicao(unidades) {
  const oficial = (u) => String(u.unidadeNome ?? u.empresaNome ?? "Unidade sem nome").replace(/\s+/g, " ").trim();
  const simplificar = (nome) => {
    let s = nome.replace(/^matriz\s+/i, "").replace(/\bAvenida\b/g, "Av.").replace(/\s+-\s+/g, " — ");
    s = s.replace(RE_UF_FINAL, "").replace(/\s*—\s*$/, "").trim();
    return s || nome;
  };
  const curtos = new Map(unidades.map((u) => [u.unidadeId, simplificar(oficial(u))]));
  const contagem = new Map();
  for (const n of curtos.values()) contagem.set(n, (contagem.get(n) ?? 0) + 1);
  return new Map(unidades.map((u) => [u.unidadeId, contagem.get(curtos.get(u.unidadeId)) > 1 ? oficial(u) : curtos.get(u.unidadeId)]));
}

/** Linhas de detalhe de UMA unidade crítica (dias pendentes, motivo, herança, aviso de hoje). */
function blocoCritica(u, nome, avisada) {
  const dias = Number(u.diasPendentes) || 0;
  const desde = u.pendenciaMaisAntiga ? ` (desde ${dataCurta(u.pendenciaMaisAntiga)})` : "";
  const linhas = [`🔴 *${nome}*`];
  linhas.push(dias > 0 ? `   ${dias} ${plural(dias, "dia pendente", "dias pendentes")}${desde}` : `   Pendente${desde}`);
  const motivos = [];
  if (MOTIVO_D1[u.d1Status]) motivos.push(MOTIVO_D1[u.d1Status]);
  if (u.sequenciaBloqueada && u.d1Status !== "sequencia_bloqueada") motivos.push(MOTIVO_D1.sequencia_bloqueada);
  for (const m of motivos) linhas.push(`   ${m}`);
  if (u.pendenciaHerdada) linhas.push(`   Pendência herdada${u.pendenciaHerdadaDesde ? ` desde ${dataBr(u.pendenciaHerdadaDesde)}` : " de período anterior"}`);
  linhas.push(`   Avisada hoje: ${avisada}`);
  return linhas;
}

/** Uma linha de unidade em atenção. Só acrescenta data/herança quando fogem do caso comum (pendência do próprio D-1). */
function linhaAtencao(u, nome, marcador, d1) {
  const notas = [];
  if (u.pendenciaMaisAntiga && u.pendenciaMaisAntiga !== d1) notas.push(`desde ${dataCurta(u.pendenciaMaisAntiga)}`);
  if (u.pendenciaHerdada) notas.push("herdada");
  return `${marcador} ${nome}${notas.length ? ` _(${notas.join(", ")})_` : ""}`;
}

/**
 * Monta o boletim. Função PURA.
 * @param {{snapshot: {d1?: string|null, unidades?: object[], organizacoesMonitoradas?: string[]}, avisadasHoje: Set<string>|null,
 *   dataLocal: string, horaLocal: string}} p  `avisadasHoje = null` ⇒ não foi possível verificar ("não verificado").
 * @returns {{texto: string, resumo: object}}
 */
export function montarRelatorio({ snapshot, avisadasHoje, dataLocal, horaLocal }) {
  const unidades = snapshot?.unidades ?? [];
  const criticas = unidades.filter((u) => u.criticidade === "critico");
  const atencao = unidades.filter((u) => u.criticidade === "atencao");
  const d1 = snapshot?.d1 ?? null;
  const empresas = (snapshot?.organizacoesMonitoradas ?? []).length;
  const nomes = nomesDeExibicao([...criticas, ...atencao]);
  const verificado = avisadasHoje !== null;
  const foiAvisada = (u) => verificado && avisadasHoje.has(u.unidadeId);

  const cabecalho = [
    "📊 *CENTRAL CRESCER COM DELIVERY*",
    "*BOLETIM DE PENDÊNCIAS | iFood*",
    "",
    `📅 ${diaDaSemana(dataLocal)}, ${dataBr(dataLocal)}`,
    `🕔 Atualizado às ${horaLocal}`,
    `📆 Lançamentos referentes a ${d1 ? dataCurta(d1) : "—"}`,
  ];
  const secao = (titulo) => ["", SEPARADOR, titulo, SEPARADOR, ""];
  const rodape = ["", "_Central Crescer com Delivery_", "_Monitoramento automático · iFood_"];

  if (!criticas.length && !atencao.length) {
    const linhas = [
      ...cabecalho,
      ...secao("🟢 *TUDO CERTO*"),
      `Consulta realizada às ${horaLocal}: nenhuma unidade com pendência 🔴 crítica ou 🟡 em atenção no momento.`,
      "",
      `🏢 ${empresas} ${plural(empresas, "empresa monitorada", "empresas monitoradas")}`,
      ...rodape,
    ];
    return { texto: linhas.join("\n"), resumo: { situacao: "TUDO_CERTO", criticas: 0, atencao: 0, total: 0, empresas_monitoradas: empresas, d1 } };
  }

  const total = criticas.length + atencao.length;
  const avisadasCriticas = criticas.filter(foiAvisada).length;
  const atencaoAvisadas = atencao.filter(foiAvisada);
  const atencaoSemAlerta = atencao.filter((u) => !foiAvisada(u));
  const avisadas = verificado ? avisadasCriticas + atencaoAvisadas.length : null;

  const panorama = [
    ...secao("📍 *PANORAMA GERAL*"),
    `*${total} ${plural(total, "unidade com pendência", "unidades com pendências")}*`,
    "",
    `🔴 ${pad2(criticas.length)} em situação crítica`,
    `🟡 ${pad2(atencao.length)} ${plural(atencao.length, "exige", "exigem")} atenção`,
    "",
    verificado
      ? `📨 *${avisadas} de ${total}* ${plural(total, "unidade já recebeu", "unidades já receberam")} alerta individual hoje.`
      : "📨 Alerta individual de hoje: _não verificado_.",
  ];

  const blocoPrioridade = (limite = Infinity) => {
    if (!criticas.length) return { linhas: [], omitidas: 0 };
    const mostradas = criticas.slice(0, limite);
    const linhas = [...secao("🚨 *PRIORIDADE MÁXIMA*"), ...mostradas.flatMap((u, i) => [...(i ? [""] : []), ...blocoCritica(u, nomes.get(u.unidadeId), verificado ? (foiAvisada(u) ? "SIM" : "NÃO") : "não verificado")])];
    const resto = criticas.length - mostradas.length;
    if (resto) linhas.push("", `_… e mais ${resto} ${plural(resto, "unidade crítica", "unidades críticas")} — lista completa no Painel Administrativo._`);
    return { linhas, omitidas: resto };
  };

  // Atenção: listas por situação do alerta de hoje. Cada unidade aparece UMA vez. Listas vazias não são exibidas.
  const listas = verificado
    ? [["*ALERTA ENVIADO HOJE", "✓", atencaoAvisadas], ["*SEM ALERTA HOJE", "○", atencaoSemAlerta]]
    : [["*UNIDADES EM ATENÇÃO", "•", atencao]];
  const blocoAtencao = (limite = Infinity) => {
    const linhas = [...secao("🟡 *PENDÊNCIAS D-1*")];
    let mostradas = 0;
    for (const [titulo, marcador, grupo] of listas.filter(([, , g]) => g.length)) {
      if (linhas.length > 5) linhas.push("");
      linhas.push(`${titulo} (${grupo.length})*`, "");
      for (const u of grupo) {
        if (mostradas >= limite) break;
        linhas.push(linhaAtencao(u, nomes.get(u.unidadeId), marcador, d1));
        mostradas += 1;
      }
    }
    if (mostradas < atencao.length) linhas.push("", `_… e mais ${atencao.length - mostradas} ${plural(atencao.length - mostradas, "unidade", "unidades")} em atenção — lista completa no Painel Administrativo._`);
    return { linhas, omitidas: atencao.length - mostradas };
  };

  const orientacao = [
    ...secao("📌 *ORIENTAÇÃO OPERACIONAL*"),
    criticas.length && atencao.length ? "Priorizar a análise das unidades críticas e acompanhar a regularização das pendências D-1."
      : criticas.length ? "Priorizar a análise das unidades críticas."
        : "Acompanhar a regularização das pendências D-1.",
    "",
    "A indicação de alerta considera apenas os envios realizados hoje.",
    "",
    "🔎 Consulte o Painel Administrativo para informações detalhadas.",
  ];

  // Limite REAL do transporte: o Gateway recusa texto > 4096 (LIMITE_TEXTO deixa folga). Encurta primeiro a lista de atenção e, só se
  // ainda não couber, a de críticas — sempre com aviso explícito de quantas ficaram de fora (nunca omissão silenciosa).
  const montar = (limA, limC) => {
    const a = atencao.length ? blocoAtencao(limA) : { linhas: [], omitidas: 0 };
    const c = blocoPrioridade(limC);
    return { texto: [...cabecalho, ...panorama, ...c.linhas, ...a.linhas, ...orientacao, ...rodape].join("\n"), omitidas: a.omitidas + c.omitidas, omitidasCriticas: c.omitidas };
  };
  let limA = atencao.length, limC = criticas.length;
  let r = montar(limA, limC);
  while (r.texto.length > LIMITE_TEXTO && (limA > 0 || limC > 0)) {
    if (limA > 0) limA -= 1; else limC -= 1;
    r = montar(limA, limC);
  }

  return {
    texto: r.texto,
    resumo: {
      situacao: criticas.length ? "CRITICO" : "ATENCAO", criticas: criticas.length, atencao: atencao.length, total,
      avisadas_hoje: avisadas, criticas_avisadas: verificado ? avisadasCriticas : null,
      atencao_com_alerta: verificado ? atencaoAvisadas.length : null, atencao_sem_alerta: verificado ? atencaoSemAlerta.length : null,
      omitidas: r.omitidas, omitidas_criticas: r.omitidasCriticas, empresas_monitoradas: empresas, d1,
    },
  };
}

/**
 * Unidades cujo alerta individual `dashboard_ifood_d1` SAIU hoje (dia local de Brasília). SÓ LEITURA — informativo.
 * @returns {Promise<Set<string>>}
 */
export async function unidadesAvisadasHoje({ agora }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("unidade_id")
    .eq("tipo", TIPOS_ALERTA.DASHBOARD_IFOOD_D1).in("status", STATUS_AVISO_SAIU)
    .gte("enviado_em", inicioDoDiaLocal(agora, TIMEZONE_RELATORIO).toISOString());
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.unidade_id).filter(Boolean));
}

/** Registra (idempotente, sem enviar nada) que o relatório do dia NÃO saiu. 23505 = já existe registro do dia: nada a fazer. */
async function registrarNaoEnviado({ chave, grupoJid, dataLocal, motivo }, deps) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from(TABELA).insert({
    tipo: TIPO_ENVIO_GRUPO.RELATORIO_DASHBOARD_IFOOD, chave_idempotencia: chave, grupo_jid: grupoJid, data_referencia: dataLocal,
    status: STATUS_ENVIO_GRUPO.FAILED, motivo, conteudo: `Relatório de ${dataBr(dataLocal)} não enviado: ${motivo}`,
    resumo: { situacao: "NAO_ENVIADO" }, falhou_em: new Date().toISOString(),
  });
  if (error && String(error.code) !== "23505") throw new Error(error.message);
  return !error;
}

/**
 * Um passo do relatório. NUNCA lança: qualquer erro vira `{acao: "ERRO"}` + log — o ciclo individual não é afetado.
 * @param {{agora?: Date, modo: string, grupoJid: string|null, whatsAppService: object, estado?: object,
 *   lerPendencias?: Function, lerAvisadas?: Function}} p
 *   `estado` é memória do PROCESSO (só para não repetir log/simulação) — a garantia de UM envio é a UNIQUE do banco.
 */
export async function executarPassoRelatorio({
  agora = new Date(), modo, grupoJid, whatsAppService, estado = {},
  lerPendencias = pendenciasDoPainel, lerAvisadas = unidadesAvisadasHoje,
}, deps = {}) {
  try {
    if (modo !== MODOS_RELATORIO.ATIVO && modo !== MODOS_RELATORIO.SIMULACAO) return { acao: "DESLIGADO" };
    const h = avaliarHorarioDoRelatorio(agora);
    if (h.situacao === "DOMINGO" || h.situacao === "ANTES_DO_HORARIO") return { acao: h.situacao, dataLocal: h.dataLocal };
    if (!grupoJid) {
      if (estado.avisoSemJid !== h.dataLocal) { estado.avisoSemJid = h.dataLocal; logGrupo("warn", "relatorio_sem_grupo_configurado", { dataLocal: h.dataLocal }); }
      return { acao: "GRUPO_NAO_CONFIGURADO", dataLocal: h.dataLocal };
    }
    const chave = chaveRelatorio(h.dataLocal, grupoJid);

    if (modo === MODOS_RELATORIO.SIMULACAO) {
      if (h.situacao !== "NO_HORARIO" || estado.simulado === h.dataLocal) return { acao: "SIMULACAO_JA_FEITA", dataLocal: h.dataLocal };
      estado.simulado = h.dataLocal;
      const snapshot = await lerPendencias({ hojeIso: h.dataLocal }, deps);
      const avisadas = await lerAvisadas({ agora }, deps).catch(() => null);
      const { texto, resumo } = montarRelatorio({ snapshot, avisadasHoje: avisadas, dataLocal: h.dataLocal, horaLocal: h.horaLocal });
      logGrupo("info", "relatorio_simulado", { dataLocal: h.dataLocal, grupo: mascararJidGrupo(grupoJid), caracteres: texto.length, ...resumo });
      return { acao: "SIMULADO", dataLocal: h.dataLocal, chave, texto, resumo };
    }

    // ATIVO — 1) já existe registro do dia (qualquer status)? Então NADA a fazer: nunca reenvio automático.
    const existente = await obterPorChave(chave, deps);
    if (existente) return { acao: "JA_EXISTIA", dataLocal: h.dataLocal, status: existente.status };

    // 2) passou do limite sem registro (worker parado / Gateway fora a tarde toda): registra o NÃO envio, não manda nada.
    if (h.situacao === "APOS_LIMITE") {
      const motivo = estado.ultimoGatewayIndisponivel === h.dataLocal ? "whatsapp_gateway_unavailable" : "janela_perdida";
      const registrado = await registrarNaoEnviado({ chave, grupoJid, dataLocal: h.dataLocal, motivo }, deps);
      if (registrado) logGrupo("error", "relatorio_nao_enviado", { dataLocal: h.dataLocal, motivo, grupo: mascararJidGrupo(grupoJid) });
      return { acao: "NAO_ENVIADO", dataLocal: h.dataLocal, motivo };
    }

    // 3) Gateway desconectado: NÃO reserva (nada sairia) — tenta de novo no próximo tick, até o limite.
    const st = await Promise.resolve().then(() => whatsAppService.getStatus()).catch(() => ({ conectado: false }));
    if (st?.conectado !== true) {
      if (estado.ultimoGatewayIndisponivel !== h.dataLocal) logGrupo("warn", "relatorio_aguardando_gateway", { dataLocal: h.dataLocal, motivo: "whatsapp_gateway_unavailable" });
      estado.ultimoGatewayIndisponivel = h.dataLocal;
      return { acao: "AGUARDANDO_GATEWAY", dataLocal: h.dataLocal };
    }

    // 4) UMA leitura de pendencias() → texto → reserva atômica (UNIQUE) + envio pelo mecanismo homologado.
    const snapshot = await lerPendencias({ hojeIso: h.dataLocal }, deps);
    let avisadas = null;
    try { avisadas = await lerAvisadas({ agora }, deps); }
    catch (e) { logGrupo("warn", "relatorio_avisadas_nao_verificado", { erro: String(e?.message ?? e).slice(0, 200) }); }
    const { texto, resumo } = montarRelatorio({ snapshot, avisadasHoje: avisadas, dataLocal: h.dataLocal, horaLocal: h.horaLocal });
    logGrupo("info", "relatorio_iniciando", { dataLocal: h.dataLocal, grupo: mascararJidGrupo(grupoJid), ...resumo });
    const r = await enviarAoGrupoInterno({
      tipo: TIPO_ENVIO_GRUPO.RELATORIO_DASHBOARD_IFOOD, chave, grupoJid, conteudo: texto, dataReferencia: h.dataLocal, resumo, whatsAppService,
    }, deps);
    return { acao: r.resultado, dataLocal: h.dataLocal, chave, status: r.envio?.status ?? null, motivo: r.motivo ?? null, resumo };
  } catch (e) {
    logGrupo("error", "relatorio_erro", { erro: String(e?.message ?? e).slice(0, 300) });
    return { acao: "ERRO" };
  }
}
