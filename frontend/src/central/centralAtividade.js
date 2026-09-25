// CENTRAL DE COMUNICAÇÃO — atividade recente (linha do tempo leve) e empresas/unidades. Módulo PURO e FOLHA (não importa centralUi).
//
// DADOS: usa só o que o contrato atual já entrega (`conversasRecentes`, `proximosEnvios`, `empresasHabilitadas`). Quando o backend passar a mandar `atividade` e `empresas[].unidades`
// (campos OPCIONAIS), a tela usa esses no lugar da dedução — sem mudar nenhuma outra linha. Nada é inventado: sem dado, o bloco some ou explica.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";
import { badge, statusDaMensagem } from "./centralStatus.js";
import { horarioCurto, dataHoraCurta, ROTULO_ORIGEM } from "./centralModelo.js";

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const vazio = (titulo, texto, ic) => `<div class="cc-vazio cc-vazio--leve">${icon(ic, { size: 22 })}<strong>${e(titulo)}</strong>${texto ? `<p>${e(texto)}</p>` : ""}</div>`;

/** Tipo da atividade → visual (ícone + tom). O texto sempre existe; a cor só reforça. */
export const VISUAL_ATIVIDADE = Object.freeze({
  programado: { icone: "calendar", tom: "info" },
  enviado: { icone: "send", tom: "ok" },
  recebido: { icone: "message-circle", tom: "neutro" },
  manual: { icone: "user", tom: "neutro" },
  falha: { icone: "alert-octagon", tom: "critico" },
  alerta: { icone: "alert-triangle", tom: "atencao" },
  pausado: { icone: "pause", tom: "neutro" },
});

const primeira = (l) => (Array.isArray(l) && l.length ? l[0] : null);

/**
 * Itens de atividade, do mais recente para o mais antigo (passado) e do mais próximo para o mais distante (futuro).
 * @returns {{programadas: Array<object>, recentes: Array<object>}}
 */
export function atividadeDaVisao(d, agora = new Date()) {
  const t0 = agora instanceof Date ? agora.getTime() : Number(agora);
  let itens;
  if (Array.isArray(d?.atividade)) {
    itens = d.atividade.filter((i) => i && i.em).map((i) => ({ em: i.em, tipo: VISUAL_ATIVIDADE[i.tipo] ? i.tipo : "alerta", titulo: String(i.titulo ?? ""), detalhe: String(i.detalhe ?? "") }));
  } else {
    itens = [];
    for (const p of d?.proximosEnvios ?? []) itens.push({ em: p.em, tipo: "programado", titulo: `${ROTULO_ORIGEM[p.origem] ?? "Aviso automático"} programado`, detalhe: p.empresa ?? "" });
    for (const c of d?.conversasRecentes ?? []) {
      const m = c.ultimaMensagem; if (!m?.em) continue;
      const local = primeira(c.unidades)?.nome ?? primeira(c.empresas)?.nome ?? "";
      const quem = c.nome ? (local ? `${local}, ${c.nome}` : c.nome) : local;
      if (m.direcao === "entrada") itens.push({ em: m.em, tipo: "recebido", titulo: "Resposta recebida", detalhe: quem });
      else if (!["SENT", "DELIVERED", "READ"].includes(m.status)) {
        const s = statusDaMensagem(m.status);
        itens.push({ em: m.em, tipo: s.status === "atencao" ? "alerta" : s.status, titulo: `Mensagem: ${s.texto.toLowerCase()}`, detalhe: quem });
      }
      else if (m.categoria === "manual") itens.push({ em: m.em, tipo: "manual", titulo: "Mensagem enviada por operador", detalhe: quem });
      else if (m.categoria === "teste") itens.push({ em: m.em, tipo: "enviado", titulo: "Mensagem de teste enviada", detalhe: quem });
      else itens.push({ em: m.em, tipo: "enviado", titulo: "Aviso automático enviado", detalhe: quem });
    }
  }
  itens = itens.filter((i) => Number.isFinite(Date.parse(i.em)));
  const futuros = itens.filter((i) => ms(i.em) > t0).sort((a, b) => ms(a.em) - ms(b.em));
  const passados = itens.filter((i) => ms(i.em) <= t0).sort((a, b) => ms(b.em) - ms(a.em));
  return { programadas: futuros, recentes: passados };
}

function itemLinha(i, agora, futuro) {
  const v = VISUAL_ATIVIDADE[i.tipo] ?? VISUAL_ATIVIDADE.alerta;
  return `<li class="cc-ativ cc-ativ--${e(i.tipo)}${futuro ? " is-futuro" : ""}" data-tipo="${e(i.tipo)}">
    <time class="cc-ativ-hora" datetime="${e(i.em)}">${e(futuro ? dataHoraCurta(i.em, agora).replace(/^Hoje, /, "") : horarioCurto(i.em, agora))}</time>
    <span class="cc-ativ-no cc-ativ-no--${v.tom}" aria-hidden="true">${icon(v.icone, { size: 13 })}</span>
    <div class="cc-ativ-corpo"><strong>${e(i.titulo)}</strong>${i.detalhe ? `<span>${e(i.detalhe)}</span>` : ""}</div>
  </li>`;
}

/** Linha do tempo leve: programadas (tracejado) e depois o que já aconteceu. `limite`: itens por grupo. */
export function htmlLinhaDoTempoAtividade(d, { agora = new Date(), limite = 5 } = {}) {
  const { programadas, recentes } = atividadeDaVisao(d, agora);
  if (!programadas.length && !recentes.length) return vazio("Nenhuma atividade ainda", "Avisos enviados, respostas e envios programados aparecem aqui.", "activity");
  const grupo = (titulo, lista, futuro) => (lista.length ? `<div class="cc-ativ-grupo"><h3>${e(titulo)}<span>${lista.length}</span></h3><ol class="cc-ativ-lista">${lista.slice(0, limite).map((i) => itemLinha(i, agora, futuro)).join("")}</ol></div>` : "");
  return `<div class="cc-atividade">${grupo("Programadas", programadas, true)}${grupo("Recentes", recentes, false)}</div>`;
}

// ---------------------------------------------------------------------------
// Empresas e unidades
// ---------------------------------------------------------------------------

const STATUS_UNIDADE = Object.freeze({ ativo: "ativo", atencao: "atencao", pausado: "pausado", sem_pendencia: "sem_pendencia", falha: "falha" });
const TEXTO_EMPRESA = Object.freeze({ ativo: "Recebendo automações", atencao: "Com pendência", pausado: "Pausada", sem_pendencia: "Sem pendência", falha: "Com falha" });

/**
 * Empresas para exibir. Preferência: `d.empresas` (com `unidades` e situação de cada uma), quando o backend as fornecer.
 * Sem isso, deduz das conversas (responsável → empresas/unidades): a situação da empresa vem das pendências; as unidades entram SEM situação inventada.
 */
export function empresasDaVisao(d) {
  if (Array.isArray(d?.empresas)) return d.empresas;
  const mapa = new Map();
  for (const c of d?.conversasRecentes ?? []) {
    for (const emp of c.empresas ?? []) {
      const x = mapa.get(emp.organizacaoId) ?? { organizacaoId: emp.organizacaoId, nome: emp.nome, pendencias: null, unidades: new Map() };
      if (Number.isFinite(emp.pendenciasAtuais)) x.pendencias = Math.max(x.pendencias ?? 0, emp.pendenciasAtuais);
      mapa.set(emp.organizacaoId, x);
    }
    for (const u of c.unidades ?? []) { const x = mapa.get(u.organizacaoId); if (x) x.unidades.set(u.unidadeId ?? u.nome, { nome: u.nome, situacao: null }); }
  }
  return [...mapa.values()].map((x) => ({ organizacaoId: x.organizacaoId, nome: x.nome, situacao: x.pendencias == null ? null : x.pendencias > 0 ? "atencao" : "sem_pendencia", pendencias: x.pendencias, unidades: [...x.unidades.values()] }));
}

function linhaUnidade(u) {
  const s = STATUS_UNIDADE[u.situacao];
  return `<li class="cc-un">${s ? badge(s, { tam: "p" }) : `<span class="cc-un-ponto" aria-hidden="true"></span>`}<span class="cc-un-nome">${e(u.nome)}</span></li>`;
}

/** Empresas com suas unidades em cartões compactos (sem tabela). */
export function htmlEmpresasUnidades(empresas, { limite = 4, verTodas = "" } = {}) {
  if (!empresas?.length) return vazio("Nenhuma empresa por aqui ainda", "As empresas aparecem quando um responsável é vinculado ou a comunicação é habilitada.", "building");
  const cards = empresas.slice(0, limite).map((o) => {
    const s = STATUS_UNIDADE[o.situacao];
    const un = Array.isArray(o.unidades) ? o.unidades : [];
    return `<li class="cc-emp cc-emp--${e(s ?? "neutro")}" data-cc-empresa="${e(o.organizacaoId ?? "")}">
      <div class="cc-emp-topo"><span class="cc-emp-ic" aria-hidden="true">${icon("building", { size: 16 })}</span><div><strong>${e(o.nome)}</strong><span class="cc-nota">${e(o.pendencias ? plural(o.pendencias, "pendência", "pendências") : (TEXTO_EMPRESA[s] ?? "Situação não informada"))}</span></div>${s ? badge(s, { tam: "p" }) : ""}</div>
      ${un.length ? `<ul class="cc-emp-un">${un.map(linhaUnidade).join("")}</ul>` : ""}
    </li>`;
  }).join("");
  const resto = empresas.length - limite;
  return `<ul class="cc-empresas">${cards}</ul>${resto > 0 ? `<p class="cc-nota cc-emp-resto">${e(plural(resto, "empresa a mais", "empresas a mais"))}${verTodas ? ` <button type="button" class="cc-link" data-cc-ir="${e(verTodas)}">Ver todas</button>` : ""}</p>` : ""}`;
}
