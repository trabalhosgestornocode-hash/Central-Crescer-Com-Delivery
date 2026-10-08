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

const ROTULO_D1 = Object.freeze({
  nao_realizado: "D-1 não lançado",
  em_preenchimento: "D-1 em preenchimento",
  sequencia_bloqueada: "sequência bloqueada",
  concluido: "D-1 concluído",
});

/**
 * Texto curto da situação de UMA unidade, só com dados de pendencias() (nunca recalcula nada). `sequenciaBloqueada` sozinho não
 * entra: acompanha quase todo D-1 não lançado e só repetiria a informação; o rótulo do D-1 já diz "sequência bloqueada" quando é o caso.
 */
export function situacaoDaUnidade(u) {
  const partes = [];
  if (ROTULO_D1[u.d1Status]) partes.push(ROTULO_D1[u.d1Status]);
  if (Number(u.diasPendentes) > 0) partes.push(`${u.diasPendentes} dia(s) pendente(s) no período`);
  return partes.length ? partes.join(" · ") : "pendente";
}

const nomeDaUnidade = (u) => String(u.unidadeNome ?? u.empresaNome ?? "Unidade sem nome").replace(/\s+/g, " ").trim();
const notaHerdada = (u) => (u.pendenciaHerdada ? ` · herdada de antes do período${u.pendenciaHerdadaDesde ? ` (desde ${dataBr(u.pendenciaHerdadaDesde)})` : ""}` : "");

/**
 * Monta o texto do relatório. Função PURA.
 * @param {{snapshot: {d1?: string|null, unidades?: object[], organizacoesMonitoradas?: string[]}, avisadasHoje: Set<string>|null,
 *   dataLocal: string, horaLocal: string}} p  `avisadasHoje = null` ⇒ não foi possível verificar ("não verificado").
 * @returns {{texto: string, resumo: object}}
 */
export function montarRelatorio({ snapshot, avisadasHoje, dataLocal, horaLocal }) {
  const unidades = snapshot?.unidades ?? [];
  const criticas = unidades.filter((u) => u.criticidade === "critico");
  const atencao = unidades.filter((u) => u.criticidade === "atencao");
  const d1 = dataBr(snapshot?.d1) ?? "—";
  const cab = (emoji, titulo) => [`${emoji} ${titulo} — DASHBOARD iFOOD`, `Crescer com Delivery · ${dataBr(dataLocal)} ${horaLocal} (Brasília)`, `D-1 de referência: ${d1}`, ""];
  const avisada = (u) => (avisadasHoje === null ? "não verificado" : avisadasHoje.has(u.unidadeId) ? "SIM" : "NÃO");
  const empresas = (snapshot?.organizacoesMonitoradas ?? []).length;

  if (!criticas.length && !atencao.length) {
    const linhas = [
      ...cab("🟢", "TUDO CERTO"),
      `Consulta realizada às ${horaLocal}: nenhuma unidade com pendência 🔴 Crítico ou 🟡 Atenção no momento.`,
      `Empresas monitoradas: ${empresas}`,
    ];
    return { texto: linhas.join("\n"), resumo: { situacao: "TUDO_CERTO", criticas: 0, atencao: 0, total: 0, empresas_monitoradas: empresas, d1: snapshot?.d1 ?? null } };
  }

  const total = criticas.length + atencao.length;
  const avisadas = avisadasHoje === null ? null : [...criticas, ...atencao].filter((u) => avisadasHoje.has(u.unidadeId)).length;
  const linhas = [
    ...cab(criticas.length ? "🔴" : "🟡", "RELATÓRIO DIÁRIO"),
    `Resumo: ${total} unidade(s) com pendência — 🔴 ${criticas.length} crítica(s) · 🟡 ${atencao.length} em atenção`,
    `Lojas já avisadas hoje (alerta individual): ${avisadas === null ? "não verificado" : `${avisadas} de ${total}`}`,
  ];
  const rodape = ["", "Detalhes no Painel Administrativo."];
  let omitidas = 0;
  const caber = (bloco) => {
    const prox = [...linhas, ...bloco].join("\n").length + rodape.join("\n").length + 80;
    if (prox > LIMITE_TEXTO) return false;
    linhas.push(...bloco);
    return true;
  };
  for (const [titulo, grupo] of [["🔴 CRÍTICO", criticas], ["🟡 ATENÇÃO", atencao]]) {
    if (!grupo.length) continue;
    if (!caber(["", `${titulo} (${grupo.length})`])) { omitidas += grupo.length; continue; }
    for (const u of grupo) {
      const data = dataBr(u.pendenciaMaisAntiga ?? u.pendenciaHerdadaDesde) ?? "—";
      const ok = caber([`• ${nomeDaUnidade(u)}`, `  ${situacaoDaUnidade(u)} · pendência desde ${data} · loja avisada hoje: ${avisada(u)}${notaHerdada(u)}`]);
      if (!ok) omitidas += 1;
    }
  }
  if (omitidas) linhas.push("", `… e mais ${omitidas} unidade(s) — lista completa no Painel Administrativo.`);
  linhas.push(...rodape);
  return {
    texto: linhas.join("\n"),
    resumo: { situacao: criticas.length ? "CRITICO" : "ATENCAO", criticas: criticas.length, atencao: atencao.length, total, avisadas_hoje: avisadas, omitidas, empresas_monitoradas: empresas, d1: snapshot?.d1 ?? null },
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
