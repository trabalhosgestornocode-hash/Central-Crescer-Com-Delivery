// Configurações → Usuários e acesso → "WhatsApp (MOVA)" — MOVA CORE F2 (§5).
//
// Para TODOS: a pessoa gera, ela mesma, o código de vínculo e envia ao MOVA na conversa PRIVADA do WhatsApp. Sem intervenção
// do desenvolvedor. O código aparece uma vez, vale 10 minutos e é de uso único; nunca é guardado no navegador.
// Para quem administra os usuários (usuarios.gerenciar): a lista autorizada do MOVA desta empresa, quem já está vinculado,
// aprovar um vínculo (pessoa da lista → perfil) e revogar. A revogação vale na hora. O servidor revalida tudo.
// Rota desligada no servidor (404) ⇒ a seção some. Impersonação (suporte) ⇒ a seção explica que não vincula.
import { escapeHtml, toast } from "./utils.js";
import { pode } from "./sessao.js";
import { movaVinculoMeu, movaVinculoGerarCodigo, movaVinculoRevogar, movaVinculoAdmin, movaVinculoAprovar, obterUsuarios } from "./api.js";

const e = (v) => escapeHtml(v ?? "");
const painel = (titulo, corpo, sub = "") =>
  `<section class="cfg-panel"><div class="cfg-panel-head"><h3>${e(titulo)}</h3>${sub ? `<p>${e(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></section>`;
const carregando = (txt) => `<div class="estado" role="status"><div class="spinner"></div>${e(txt)}</div>`;
const quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const METODO = { CODIGO_AUTENTICADO: "pelo código", APROVACAO_ADMIN: "aprovado pela administração" };

export function montarWhatsappMova(root, { confirmarDialogo }) {
  const secao = () => root.closest?.(".cfg2-secao") ?? null;
  const st = { meu: null, codigo: null, admin: null, usuarios: [], ocupado: false };
  root.innerHTML = carregando("Carregando o vínculo do WhatsApp…");
  root.addEventListener("click", aoClicar);
  recarregar();

  async function recarregar() {
    try {
      st.meu = await movaVinculoMeu();
    } catch (err) {
      if (err?.status === 404) { const s = secao(); if (s) { s.hidden = true; root.innerHTML = ""; } else root.innerHTML = painel("WhatsApp (MOVA)", `<div class="estado-mini">O vínculo do WhatsApp ainda não está disponível.</div>`); return; }
      if (err?.status === 403) { root.innerHTML = painel("WhatsApp (MOVA)", `<div class="estado-mini">${e(err.message)}</div>`); return; }
      root.innerHTML = painel("WhatsApp (MOVA)", `<div class="estado-mini bad" role="alert">Não foi possível carregar: ${e(err?.message)}</div>`); return;
    }
    st.admin = null;
    if (pode("usuarios.gerenciar")) {
      try { [st.admin, st.usuarios] = await Promise.all([movaVinculoAdmin(), obterUsuarios().then((r) => r?.data ?? r ?? []).catch(() => [])]); } catch { st.admin = null; }
    }
    desenhar();
  }

  function desenhar() {
    const meu = st.meu?.vinculado
      ? `<p><span class="pill ok">Vinculado</span> desde ${e(quando(st.meu.criadoEm))} (${e(METODO[st.meu.metodo] ?? st.meu.metodo)}).</p>
         <p class="muted">Quando você fala com o MOVA, ele usa as permissões que você tem aqui na plataforma, calculadas na hora.</p>
         <button class="btn" data-acao="revogar-meu" data-id="${e(st.meu.vinculoId)}" ${st.ocupado ? "disabled" : ""}>Desvincular meu WhatsApp</button>`
      : `<p><span class="pill muted">Não vinculado</span></p>
         <ol class="muted"><li>Gere o código abaixo.</li><li>Abra a conversa <strong>privada</strong> com o MOVA no WhatsApp (não no grupo).</li><li>Envie <code>vincular</code> seguido do código.</li></ol>
         ${st.codigo ? `<div class="cfg-codigo" role="status" aria-live="polite"><strong style="font-size:1.6rem;letter-spacing:.2em">${e(st.codigo.codigo)}</strong>
             <p>Envie exatamente: <code>vincular ${e(st.codigo.codigo)}</code> — vale até ${e(quando(st.codigo.expiraEm))}, uma única vez.</p></div>` : ""}
         <button class="btn primario" data-acao="gerar" ${st.ocupado ? "disabled" : ""}>${st.codigo ? "Gerar outro código" : "Gerar código de vínculo"}</button>
         <p class="muted">Só pessoas que a administração colocou na lista autorizada do MOVA conseguem se vincular.</p>`;
    root.innerHTML = painel("Meu WhatsApp no MOVA", meu, "Vincule seu WhatsApp à sua conta para o MOVA saber quem você é.") + (st.admin?.ok ? desenharAdmin() : "");
  }

  function desenharAdmin() {
    const nomeDoPerfil = (id) => st.usuarios.find((u) => u.id === id)?.nome ?? st.usuarios.find((u) => u.id === id)?.email ?? "perfil";
    const opcoes = st.usuarios.filter((u) => u.ativo !== false && u.contaAtiva !== false).map((u) => `<option value="${e(u.id)}">${e(u.nome ?? u.email)}</option>`).join("");
    const linhas = (st.admin.entradas ?? []).map((x) => x.vinculoId
      ? `<tr><td>${e(x.nome ?? "Sem nome")}</td><td><span class="pill ok">Vinculado</span> a ${e(nomeDoPerfil(x.perfilId))}</td>
           <td><button class="btn pequeno perigo" data-acao="revogar" data-id="${e(x.vinculoId)}" data-nome="${e(x.nome ?? "")}">Revogar</button></td></tr>`
      : `<tr><td>${e(x.nome ?? "Sem nome")}</td><td><span class="pill muted">Sem vínculo</span></td>
           <td><select aria-label="Perfil para ${e(x.nome ?? "esta pessoa")}" data-entrada="${e(x.entradaId)}"><option value="">Escolha o perfil…</option>${opcoes}</select>
           <button class="btn pequeno" data-acao="aprovar" data-entrada="${e(x.entradaId)}">Vincular</button></td></tr>`).join("");
    const historico = (st.admin.vinculos ?? []).filter((v) => v.estado !== "ATIVO").slice(0, 20)
      .map((v) => `<li>${e(nomeDoPerfil(v.perfilId))}: revogado em ${e(quando(v.revogadoEm))}${v.motivoRevogacao ? ` (${e(v.motivoRevogacao)})` : ""}</li>`).join("");
    return painel("Vínculos do WhatsApp nesta empresa",
      linhas ? `<div class="tabela-wrap"><table class="tabela"><thead><tr><th>Pessoa da lista do MOVA</th><th>Situação</th><th>Ação</th></tr></thead><tbody>${linhas}</tbody></table></div>`
        : `<div class="estado-mini">Ninguém na lista autorizada do MOVA desta empresa.</div>`,
      "Pessoas da lista autorizada do MOVA. O vínculo não dá permissão nova: vale o que o perfil já tem aqui.")
      + (historico ? painel("Revogações recentes", `<ul>${historico}</ul>`) : "");
  }

  async function aoClicar(ev) {
    const b = ev.target.closest?.("button[data-acao]");
    if (!b || st.ocupado) return;
    const acao = b.dataset.acao;
    try {
      st.ocupado = true;
      if (acao === "gerar") { st.codigo = await movaVinculoGerarCodigo(); desenhar(); return; }
      if (acao === "aprovar") {
        const perfilId = root.querySelector(`select[data-entrada="${CSS.escape(b.dataset.entrada)}"]`)?.value;
        if (!perfilId) { toast("Escolha o perfil antes de vincular.", "warn"); return; }
        await movaVinculoAprovar(b.dataset.entrada, perfilId); toast("WhatsApp vinculado.", "ok"); st.ocupado = false; return recarregar();
      }
      if (acao === "revogar" || acao === "revogar-meu") {
        const ok = await confirmarDialogo({ titulo: acao === "revogar" ? `Revogar o vínculo de ${b.dataset.nome || "esta pessoa"}?` : "Desvincular seu WhatsApp?",
          texto: "O MOVA deixa de reconhecer esse WhatsApp na hora. Para voltar, é preciso vincular de novo.", confirmar: "Revogar", perigo: true });
        if (!ok) return;
        await movaVinculoRevogar(b.dataset.id, acao === "revogar" ? "REVOGADO_PELA_ADMINISTRACAO" : null); toast("Vínculo revogado.", "ok"); st.codigo = null; st.ocupado = false; return recarregar();
      }
    } catch (err) { toast(err?.message ?? "Não foi possível concluir.", "erro"); } finally { st.ocupado = false; if (acao === "gerar") desenhar(); }
  }
}
