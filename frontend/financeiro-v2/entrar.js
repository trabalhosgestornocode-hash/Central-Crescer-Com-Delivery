// Login da HOMOLOGAÇÃO SINTÉTICA: envia ao serviço local, que autentica no gateway de teste. A sessão fica num cookie
// HttpOnly do servidor — o navegador nunca recebe o token do gateway nem credencial de banco.
const form = document.querySelector("#form-entrar");
const mensagem = document.querySelector("#mensagem");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  mensagem.textContent = "";
  const dados = Object.fromEntries(new FormData(form));
  const r = await fetch("/api/fv2/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dados), credentials: "same-origin" });
  if (r.ok) { window.location.assign("/"); return; }
  mensagem.textContent = "Usuário ou senha inválidos.";
  form.querySelector("[name=senha]").value = "";
  form.querySelector("[name=senha]").focus();
});
