// Aceite do convite de USUÁRIO (D-14): a pessoa convidada chega pelo e-mail do Supabase Auth, define a PRÓPRIA senha e
// o convite é consumido no servidor (uso único, só para o e-mail convidado). Ninguém escolhe senha por ela.
//
// O fragmento da URL traz o token do convite (t=…) e, vindo do e-mail do Supabase, a sessão (access_token/refresh_token).
// Tudo isso sai da barra de endereço assim que é lido. Nada é escrito no console.
import { getSupabase } from "./supabaseClient.js";

const raiz = document.querySelector("#tt-conteudo");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const aviso = (txt, tom = "info") => `<p class="tt-aviso tt-aviso--${tom}" role="${tom === "erro" ? "alert" : "status"}">${esc(txt)}</p>`;

/** O Supabase anexa os próprios parâmetros com outro "#": junta tudo antes de ler. */
export function lerFragmento(hash) {
  return new URLSearchParams(String(hash ?? "").replace(/^#/, "").replace(/#/g, "&"));
}

async function iniciar() {
  const p = lerFragmento(location.hash);
  const token = p.get("t");
  history.replaceState(null, "", location.pathname);
  if (!token) { raiz.innerHTML = aviso("Link de convite incompleto. Abra novamente o link do e-mail.", "erro"); return; }
  const sb = await getSupabase();
  if (p.get("access_token") && p.get("refresh_token")) {
    const { error } = await sb.auth.setSession({ access_token: p.get("access_token"), refresh_token: p.get("refresh_token") });
    if (error) { raiz.innerHTML = aviso("O link do e-mail expirou. Peça um novo convite a quem enviou.", "erro"); return; }
  }
  const { data } = await sb.auth.getSession();
  if (!data?.session) { raiz.innerHTML = aviso("Abra este convite pelo link do e-mail que você recebeu.", "erro"); return; }
  telaSenha(sb, token, data.session.user?.email ?? "");
}

function telaSenha(sb, token, email) {
  raiz.innerHTML = `<section class="tt-cartao">
    <h2>Crie sua senha</h2>
    <p>Conta: <b>${esc(email)}</b></p>
    <form id="cu-form" novalidate>
      <label class="tt-campo" for="cu-s1"><span>Nova senha</span><input id="cu-s1" type="password" autocomplete="new-password" minlength="8" required aria-describedby="cu-erro" /><small>Mínimo de 8 caracteres.</small></label>
      <label class="tt-campo" for="cu-s2"><span>Repita a senha</span><input id="cu-s2" type="password" autocomplete="new-password" required aria-describedby="cu-erro" /></label>
      <small class="tt-erro" id="cu-erro" role="alert"></small>
      <div class="tt-acoes"><button type="submit" class="tt-btn">Aceitar convite</button></div>
    </form></section>`;
  raiz.querySelector("#cu-s1").focus();
  raiz.querySelector("#cu-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const erro = raiz.querySelector("#cu-erro");
    erro.textContent = "";
    const s1 = raiz.querySelector("#cu-s1").value;
    if (s1.length < 8) { erro.textContent = "A senha precisa de ao menos 8 caracteres."; return; }
    if (s1 !== raiz.querySelector("#cu-s2").value) { erro.textContent = "As senhas não conferem."; return; }
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      const { error } = await sb.auth.updateUser({ password: s1 });
      if (error) throw new Error("Não foi possível salvar a senha. Tente outra.");
      const { data } = await sb.auth.getSession();
      const r = await fetch("/api/v1/convites-usuario/aceitar", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Não foi possível aceitar o convite.");
      raiz.innerHTML = `<section class="tt-cartao">${aviso("Convite aceito. Seu acesso está pronto.", "ok")}<p><a href="/">Entrar na Crescer com Delivery</a></p></section>`;
    } catch (e) { erro.textContent = e.message; btn.disabled = false; }
  });
}

if (document.querySelector("[data-pagina]")?.dataset?.pagina === "convite-usuario") iniciar();
