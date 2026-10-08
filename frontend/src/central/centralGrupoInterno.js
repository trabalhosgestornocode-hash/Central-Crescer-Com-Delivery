// GRUPO INTERNO ("Crescer Com Delivery - Central") — seção da aba Teste da Central de Comunicação.
//   1. "Listar grupos da conta": SÓ LEITURA (nome, JID, tamanho) — para achar o JID real e configurá-lo (WHATSAPP_GRUPO_INTERNO_JID).
//   2. "Preparar teste do grupo": mostra todos os bloqueios + a mensagem; o envio exige marcar a confirmação. `testeId` é gerado ao
//      preparar: duplo clique/reenvio = mesmo testeId = UMA mensagem (o backend garante pela UNIQUE).
// Construtores PUROS + uma função de ligação (sem handler inline: a CSP bloqueia).

import { escapeHtml as e } from "../utils.js";

const dt = (iso) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return "—"; }
};

const ROTULO_RESULTADO = Object.freeze({
  ENVIADO: "Enviado ao WhatsApp", JA_EXISTIA: "Este teste já tinha sido enviado — nada foi reenviado", FALHOU: "Falhou (nada foi enviado)",
  ENTREGA_INCERTA: "Entrega não confirmada — verifique o grupo antes de tentar de novo",
});

export function htmlSecaoGrupoInterno() {
  return `<section class="padm-secao" data-gi-raiz>
    <header class="padm-secao-cab"><h3>Grupo interno — Crescer Com Delivery - Central</h3>
      <p class="padm-secao-sub">Destino do alerta diário do Dashboard iFood. Só este grupo pode receber mensagens; nunca clientes ou franqueados.</p></header>
    <div class="padm-teste-acoes">
      <button type="button" class="btn btn-ghost btn-sm" data-gi-acao="listar">Listar grupos da conta</button>
      <button type="button" class="btn btn-ghost btn-sm" data-gi-acao="preparar">Preparar teste do grupo</button>
    </div>
    <div data-gi-saida></div>
  </section>`;
}

export function htmlListaGrupos(r) {
  const cfg = r?.configuracao ?? {};
  const candidatos = new Set(r?.candidatosPorNome ?? []);
  const linhas = (r?.grupos ?? []).map((g) => {
    const marcas = [candidatos.has(g.jid) ? "nome confere" : "", g.jid === cfg.backendJid ? "configurado" : ""].filter(Boolean).join(" · ");
    return `<tr><td>${e(g.nome ?? "—")}</td><td><code>${e(g.jid)}</code></td><td>${e(g.participantes ?? "—")}</td><td>${g.somenteAdminsEnviam ? "Só admins" : "Todos"}</td><td>${e(marcas)}</td></tr>`;
  }).join("");
  const situacao = !cfg.backendJid ? "Grupo ainda NÃO configurado no backend (WHATSAPP_GRUPO_INTERNO_JID)."
    : !cfg.gatewayJid ? "Configurado no backend, mas NÃO no Gateway."
      : !cfg.concordam ? "Backend e Gateway estão com grupos DIFERENTES — corrija antes de enviar."
        : cfg.encontradoNaConta ? "Backend e Gateway configurados com o mesmo grupo, e a conta participa dele." : "Configurado, mas a conta conectada não participa desse grupo.";
  const candidatosTxt = candidatos.size === 0 ? `Nenhum grupo com o nome "${e(r?.nomeEsperado ?? "")}".`
    : candidatos.size > 1 ? `Há ${candidatos.size} grupos com o nome "${e(r?.nomeEsperado ?? "")}" — confira qual é o correto antes de configurar.` : "";
  return `<p class="padm-form-nota">${e(situacao)}</p>${candidatosTxt ? `<p class="padm-form-nota">${candidatosTxt}</p>` : ""}
    <div class="padm-tabela-wrap"><table class="padm-tabela"><thead><tr><th>Grupo</th><th>ID/JID</th><th>Participantes</th><th>Quem envia</th><th></th></tr></thead>
    <tbody>${linhas || `<tr><td colspan="5">A conta não participa de nenhum grupo.</td></tr>`}</tbody></table></div>`;
}

export function htmlPreparoGrupo(p, { enviando = false } = {}) {
  const g = p?.grupo ?? {};
  const bloqueios = (p?.bloqueios ?? []).map((b) => `<li>${e(b.mensagem ?? b.codigo)}</li>`).join("");
  const ultimos = (p?.ultimosEnvios ?? []).map((u) => `<tr><td>${dt(u.criado_em)}</td><td>${e(u.status)}</td><td>${e(u.motivo ?? "—")}</td><td>${e(u.provider_message_id ?? "—")}</td></tr>`).join("");
  return `<dl class="padm-dl">
      <dt>Grupo esperado</dt><dd>${e(g.nomeEsperado ?? "—")}</dd>
      <dt>Nome no WhatsApp</dt><dd>${e(g.nomeNoWhatsApp ?? "—")}${g.nomeConfere === false ? " (nome diferente do esperado)" : ""}</dd>
      <dt>ID/JID configurado</dt><dd><code>${e(g.jid ?? "não configurado")}</code></dd>
      <dt>Participantes</dt><dd>${e(g.participantes ?? "—")}</dd>
      <dt>WhatsApp</dt><dd>${e(p?.whatsapp ?? "—")} · modo ${e(p?.modo ?? "—")}</dd>
    </dl>
    <p><strong>Mensagem que será enviada:</strong></p><pre class="padm-preview">${e(p?.previewTexto ?? "")}</pre>
    ${bloqueios ? `<p class="padm-form-nota">Envio bloqueado:</p><ul>${bloqueios}</ul>` : `
      <label class="padm-check"><input type="checkbox" data-gi-confirma ${enviando ? "disabled" : ""}> Confirmo o envio de UMA mensagem de teste para este grupo.</label>
      <div class="padm-teste-acoes"><button type="button" class="btn btn-primary btn-sm" data-gi-acao="enviar" disabled>Enviar teste ao grupo</button></div>`}
    ${ultimos ? `<p><strong>Últimos testes do grupo</strong></p><div class="padm-tabela-wrap"><table class="padm-tabela"><thead><tr><th>Data/Hora</th><th>Status</th><th>Motivo</th><th>Message ID</th></tr></thead><tbody>${ultimos}</tbody></table></div>` : ""}`;
}

export function htmlResultadoGrupo(r) {
  return `<p class="padm-form-nota"><strong>${e(ROTULO_RESULTADO[r?.resultado] ?? r?.resultado ?? "—")}</strong></p>
    <dl class="padm-dl"><dt>Status</dt><dd>${e(r?.status ?? "—")}</dd><dt>Motivo</dt><dd>${e(r?.motivo ?? "—")}</dd>
    <dt>Message ID</dt><dd>${e(r?.messageId ?? "—")}</dd><dt>Enviado em</dt><dd>${dt(r?.enviadoEm)}</dd></dl>`;
}

/**
 * Liga a seção dentro de `host`. `api` precisa de grupoInternoGrupos/grupoInternoPreparo/grupoInternoEnviarTeste.
 * @param {ParentNode} host
 */
export function ligarGrupoInterno(host, api) {
  const raiz = host?.querySelector?.("[data-gi-raiz]");
  if (!raiz || !api?.grupoInternoGrupos) return;
  const saida = raiz.querySelector("[data-gi-saida]");
  const estado = { testeId: null, preparo: null };
  const mostrar = (html) => { if (saida) saida.innerHTML = html; };
  const erro = (err) => mostrar(`<p class="padm-form-nota">${e(err?.message || "Não foi possível concluir agora.")}</p>`);

  const ligarEnvio = () => {
    const marca = saida?.querySelector("[data-gi-confirma]");
    const botao = saida?.querySelector('[data-gi-acao="enviar"]');
    if (!marca || !botao) return;
    marca.addEventListener("change", () => { botao.disabled = !marca.checked; });
    botao.addEventListener("click", async () => {
      if (!marca.checked || !estado.testeId) return;
      botao.disabled = true; marca.disabled = true;
      try {
        mostrar(htmlResultadoGrupo(await api.grupoInternoEnviarTeste({ testeId: estado.testeId })));
      } catch (err) {
        // Mesmo testeId: uma nova tentativa NUNCA gera uma segunda mensagem — o backend devolve o que já existe.
        mostrar(`${htmlPreparoGrupo(estado.preparo, { enviando: true })}<p class="padm-form-nota">${e(err?.message || "Não foi possível confirmar o envio. Nada será reenviado automaticamente.")}</p>`);
      }
    });
  };

  raiz.querySelector('[data-gi-acao="listar"]')?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try { mostrar(htmlListaGrupos(await api.grupoInternoGrupos())); } catch (err) { erro(err); } finally { b.disabled = false; }
  });
  raiz.querySelector('[data-gi-acao="preparar"]')?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    estado.testeId = globalThis.crypto?.randomUUID?.() ?? null;
    if (!estado.testeId) { mostrar(`<p class="padm-form-nota">Este navegador não suporta o envio de teste.</p>`); b.disabled = false; return; }
    try { estado.preparo = await api.grupoInternoPreparo(); mostrar(htmlPreparoGrupo(estado.preparo)); ligarEnvio(); } catch (err) { erro(err); } finally { b.disabled = false; }
  });
}
