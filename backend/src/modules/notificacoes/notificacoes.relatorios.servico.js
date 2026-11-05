// Relatórios operacionais → ENFILEIRAMENTO (diário e semanal). Lê os fechamentos JÁ armazenados (nada é recalculado), aplica a elegibilidade
// (módulo + integração Order + pedidos reais + dado válido), monta a mensagem com os mesmos geradores do Dashboard Operacional e grava na fila
// própria (migration 141) um item por destinatário autorizado, com chave de idempotência. NÃO envia: o envio é de `notificacoes.relatorios.envio.js`.
//
// Quando:
//   * DIÁRIO  — o fechamento de ONTEM (no fuso da unidade, pela regra única de `hojeDaUnidade`) CONSOLIDADO/REVISADO. REVISADO gera aviso de
//               "correção" só para quem marcou "avisar correções". Mesma versão nunca vai duas vezes ao mesmo destinatário (chave por fechamento).
//   * SEMANAL — na SEGUNDA-FEIRA local da unidade, a semana segunda–domingo ENCERRADA; resumo gravado e idempotente por conteúdo.
//   * JANELA  — envios só entre 08:00 e 20:00 (hora local da unidade): antes disso aguardam 08:00; passado o fim do dia o item expira (nunca "amanhã").
import { gerarMensagem, validarMensagem } from "../checklist-operacional/checklistOperacional.whatsapp.js";
import { gerarMensagemSemanal, validarMensagemSemanal, ultimaSemanaEncerrada, segundaDaSemana, diasDaSemana } from "../checklist-operacional/checklistOperacional.semanal.js";
import { hojeDaUnidade } from "../checklist-operacional/checklistOperacional.fuso.js";
import { elegibilidadeDiaria, planejarResumoSemanal, destinatariosAutorizados, CATEGORIA_DIARIA, CATEGORIA_SEMANAL, MOTIVO } from "./notificacoes.relatorios.js";
import * as repoPadrao from "./notificacoes.relatorios.repository.js";
import * as notifPadrao from "./notificacoes.repository.js";
// `recebeValores`: lista ÚNICA de papéis com acesso financeiro (principal, financeiro) — a mesma do bloco Foody. Demais papéis
// (operacional, gerente, secundário, sem papel) recebem o relatório SEM a seção INDICADORES FINANCEIROS e sem R$ (fail-closed).
import { lerFechamentosFoody, textoComLogistica, recebeValores } from "./notificacoes.relatorios.foody.js";

export const HORA_INICIO_ENVIO = 8;
export const HORA_FIM_ENVIO = 20;
const DIA_MS = 86_400_000;

/** Hora (0–23) e data local (AAAA-MM-DD) de um instante num fuso IANA. */
function partesLocais(ms, fuso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}
/** Procura (de hora em hora, até 48 h) o primeiro instante local `hora:00` a partir de `ms`. */
function proximoInstanteLocal(ms, fuso, hora) {
  const base = Math.ceil(ms / 3_600_000) * 3_600_000;
  for (let i = 0; i <= 48; i++) { const t = base + i * 3_600_000; if (partesLocais(t, fuso).hora === hora) return t; }
  return ms;
}
/** @returns {{disponivelEm: Date, expiraEm: Date}} janela de envio do item nascido em `agoraMs` */
export function janelaDeEnvio(agoraMs, fuso) {
  const { hora } = partesLocais(agoraMs, fuso);
  const disponivel = hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO ? agoraMs : proximoInstanteLocal(agoraMs, fuso, HORA_INICIO_ENVIO);
  const fim = proximoInstanteLocal(disponivel, fuso, HORA_FIM_ENVIO);
  return { disponivelEm: new Date(disponivel), expiraEm: new Date(fim) };
}

const ultimaVersaoPorDia = (rows) => { const m = new Map(); for (const r of rows ?? []) { const a = m.get(r.competencia); if (!a || r.versao > a.versao) m.set(r.competencia, r); } return m; };

/**
 * @param {{organizacaoId: string, unidadeId: string, unidadeNome?: string, fusoUnidade?: string|null, integracao: object, modulosEfetivos: string[]}} u
 * @param {{agora?: () => Date, deps?: {relatorios?: object, notificacoes?: object, auditar?: Function}}} p
 */
/** O semanal fica PREPARADO mas DESLIGADO por padrão: só NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO=true o enfileira (o diário não depende dele). */
export const semanalHabilitado = (env = process.env) => String(env?.NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO ?? "").trim().toLowerCase() === "true";

export async function enfileirarRelatoriosDaUnidade(u, { agora = () => new Date(), deps = {}, env = process.env } = {}) {
  const R = deps.relatorios ?? repoPadrao; const N = deps.notificacoes ?? notifPadrao;
  const agoraMs = agora().getTime();
  const { hoje, fuso } = hojeDaUnidade({ agoraMs, fusoUnidade: u.fusoUnidade });
  const ontem = new Date(Date.parse(`${hoje}T12:00:00Z`) - DIA_MS).toISOString().slice(0, 10);
  const { disponivelEm, expiraEm } = janelaDeEnvio(agoraMs, fuso);
  const saida = { unidadeId: u.unidadeId, diario: { enfileirados: 0, motivo: null }, semanal: { enfileirados: 0, motivo: null } };
  const dados = await N.listarDestinatarios({ organizacaoId: u.organizacaoId });
  const ledger = await N.listarConsentimentos({ organizacaoId: u.organizacaoId, contatoEmpresaIds: dados.destinatarios.map((d) => d.id) });
  // Fase D (flag FOODY_CENTRAL_RELATORIO_ENABLED, desligada por padrão): bloco logístico Foody por destinatário; null = texto original.
  const tipoDe = new Map((dados.destinatarios ?? []).map((d) => [d.id, d.tipo ?? null]));
  const lerFoody = (de, ate) => lerFechamentosFoody({ env, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, de, ate, ...(deps.lerFoody ? { ler: deps.lerFoody } : {}) });

  // ---------- diário ----------
  const fechOntem = ultimaVersaoPorDia(await R.fechamentosEntre({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, de: ontem, ate: ontem })).get(ontem) ?? null;
  const eleg = elegibilidadeDiaria({ modulosEfetivos: u.modulosEfetivos, integracao: u.integracao, fechamento: fechOntem });
  if (!eleg.elegivel) saida.diario.motivo = eleg.motivo;
  else {
    const proposito = fechOntem.status === "REVISADO" ? "correcao" : "inicial";
    const texto = gerarMensagem({ fechamento: fechOntem, unidadeNome: u.unidadeNome ?? null });
    const textoSemFinanceiro = gerarMensagem({ fechamento: fechOntem, unidadeNome: u.unidadeNome ?? null, incluirFinanceiro: false });
    const v = validarMensagem(texto, { fechamento: fechOntem });
    if (!v.ok || !validarMensagem(textoSemFinanceiro, { fechamento: fechOntem }).ok) saida.diario.motivo = "MENSAGEM_INVALIDA";
    else {
      const alvos = destinatariosAutorizados({ categoria: CATEGORIA_DIARIA, unidadeId: u.unidadeId, dados, ledger, proposito });
      if (!alvos.length) saida.diario.motivo = MOTIVO.SEM_DESTINATARIO;
      else {
        const foodyDia = await lerFoody(ontem, ontem);
        const textoDe = (e) => textoComLogistica({ texto: recebeValores(tipoDe.get(e.contato_empresa_id)) ? texto : textoSemFinanceiro, fechamentos: foodyDia, tipoDestinatario: tipoDe.get(e.contato_empresa_id), competencia: ontem,
          validar: (t) => validarMensagem(t, { fechamento: fechOntem }) });
        saida.diario.enfileirados = await R.enfileirar(alvos.map((e) => ({
          organizacao_id: u.organizacaoId, unidade_id: u.unidadeId, tipo: "diario", categoria: CATEGORIA_DIARIA, referencia: ontem, fechamento_id: fechOntem.id, proposito,
          contato_empresa_id: e.contato_empresa_id, chave_idempotencia: `wa:rel:diario:${fechOntem.id}:${e.contato_empresa_id}:${proposito}`,
          ...((m) => ({ mensagem: m, tamanho: m.length }))(textoDe(e)), disponivel_em: disponivelEm.toISOString(), expira_em: expiraEm.toISOString(),
        })), deps);
        saida.diario.adiar = eleg.adiar === true;
      }
    }
  }

  // ---------- semanal (segunda-feira local; semana encerrada) ----------
  if (!semanalHabilitado(env)) { saida.semanal.motivo = "SEMANAL_DESLIGADO"; return saida; }
  if (segundaDaSemana(hoje) !== hoje) { saida.semanal.motivo = "NAO_E_SEGUNDA"; return saida; }
  const segunda = ultimaSemanaEncerrada(hoje); const dias = diasDaSemana(segunda);
  const versoes = await R.fechamentosEntre({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, de: dias[0], ate: dias[6] });
  const plano = planejarResumoSemanal({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, unidadeNome: u.unidadeNome ?? null, modulosEfetivos: u.modulosEfetivos, integracao: u.integracao,
    versoes, hojeIso: hoje, segunda, dados, ledger, cotas: {} });
  if (!plano.elegivel) { saida.semanal.motivo = plano.motivo; return saida; }
  if (!plano.validacao?.ok) { saida.semanal.motivo = "MENSAGEM_INVALIDA"; return saida; }
  const semanalSemFinanceiro = gerarMensagemSemanal({ resumo: plano.semana, unidadeNome: u.unidadeNome ?? null, incluirFinanceiro: false });
  if (!validarMensagemSemanal(semanalSemFinanceiro, plano.semana).ok) { saida.semanal.motivo = "MENSAGEM_INVALIDA"; return saida; }
  const resumoId = await R.registrarResumoSemanal({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, resumo: plano.semana, mensagem: plano.mensagem }, deps);
  const foodySemana = await lerFoody(dias[0], dias[6]);
  const textoSemanalDe = (l) => textoComLogistica({ texto: recebeValores(tipoDe.get(l.destinatario)) ? plano.mensagem : semanalSemFinanceiro, fechamentos: foodySemana, tipoDestinatario: tipoDe.get(l.destinatario), dias,
    validar: (t) => validarMensagemSemanal(t, plano.semana) });
  saida.semanal.enfileirados = await R.enfileirar(plano.linhas.map((l) => ({
    organizacao_id: u.organizacaoId, unidade_id: u.unidadeId, tipo: "semanal", categoria: CATEGORIA_SEMANAL, referencia: segunda, resumo_semanal_id: resumoId, proposito: "inicial",
    contato_empresa_id: l.destinatario, chave_idempotencia: l.chave_idempotencia, ...((m) => ({ mensagem: m, tamanho: m.length }))(textoSemanalDe(l)),
    disponivel_em: disponivelEm.toISOString(), expira_em: expiraEm.toISOString(),
  })), deps);
  saida.semanal.adiar = plano.adiar === true;
  return saida;
}
