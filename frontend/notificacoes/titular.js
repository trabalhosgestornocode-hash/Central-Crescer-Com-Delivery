// Páginas públicas do TITULAR (sem conta): aceitar um convite (código + consentimento) e gerenciar os próprios avisos.
//
// O token do convite chega no FRAGMENTO (#t=…): o navegador não o envia ao servidor nem a logs. Ele é tirado da barra de
// endereço logo ao abrir e guardado só nesta aba (sessionStorage), para sobreviver a um recarregar da página.
// Nada aqui escreve número completo, código ou token no console. Os códigos nunca voltam pela API.
const API = "/api/publico/notificacoes";
const SS = "cd.titular";
const raiz = document.querySelector("#tt-conteudo");
const pagina = document.querySelector("[data-pagina]")?.dataset.pagina;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ler = () => { try { return JSON.parse(sessionStorage.getItem(SS) ?? "{}"); } catch { return {}; } };
const gravar = (o) => { try { sessionStorage.setItem(SS, JSON.stringify({ ...ler(), ...o })); } catch { /* aba sem storage: segue em memória */ } };
const memoria = {};
const estado = () => ({ ...ler(), ...memoria });
const guardar = (o) => { Object.assign(memoria, o); gravar(o); };

async function chamar(caminho, corpo) {
  const r = await fetch(`${API}${caminho}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo ?? {}), credentials: "omit" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status === 429 ? "Muitas tentativas. Aguarde alguns minutos e tente de novo." : (j.error || "Não foi possível concluir agora."));
    e.status = r.status;
    throw e;
  }
  return j.data;
}

const aviso = (txt, tom = "info") => `<p class="tt-aviso tt-aviso--${tom}" role="${tom === "erro" ? "alert" : "status"}">${esc(txt)}</p>`;
const erroNa = (alvo, txt) => { const el = raiz.querySelector(alvo); if (el) el.textContent = txt; };

function bannerSimulacao(simulado) {
  return simulado ? aviso("Ambiente de simulação: nenhum código é enviado por WhatsApp e nada deste fluxo vale como verificação real.", "simulacao") : "";
}

// Campo de código: 6 dígitos, teclado numérico, autocompletar do SMS/WhatsApp quando o aparelho oferecer.
const campoCodigo = () => `
  <label class="tt-campo" for="tt-codigo"><span>Código de 6 dígitos</span>
    <input id="tt-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-describedby="tt-codigo-erro" required />
    <small class="tt-erro" id="tt-codigo-erro" role="alert"></small></label>`;

function contagemReenvio(botao, segundos) {
  botao.disabled = true;
  const rotulo = botao.dataset.rotulo ?? botao.textContent;
  botao.dataset.rotulo = rotulo;
  let s = segundos;
  const tick = () => {
    if (s <= 0) { botao.disabled = false; botao.textContent = rotulo; return; }
    botao.textContent = `${rotulo} (${s}s)`; s -= 1; setTimeout(tick, 1000);
  };
  tick();
}

const MOTIVO_CODIGO = {
  AGUARDE: (r) => `Aguarde ${r.segundos ?? 60} segundos para pedir outro código.`,
  LIMITE: () => "Limite de códigos atingido para este número. Tente novamente mais tarde.",
  INDISPONIVEL: () => "Não foi possível enviar o código agora. Tente novamente em instantes.",
};
const MOTIVO_VERIFICACAO = {
  INCORRETO: (r) => `Código incorreto.${r.restantes != null ? ` Restam ${r.restantes} tentativa(s).` : ""}`,
  EXPIRADO: () => "Este código expirou. Peça um novo.",
  BLOQUEADO: () => "Muitas tentativas erradas. Peça um novo código.",
  INVALIDO: () => "Código inválido. Peça um novo.",
};

// =========================================================================================================================
// CONVITE
// =========================================================================================================================
async function iniciarConvite() {
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get("t")) {
    guardar({ token: frag.get("t"), desafio: null, provisorio: null });
    history.replaceState(null, "", location.pathname);   // tira o token da barra de endereço/histórico
  }
  const { token } = estado();
  if (!token) { raiz.innerHTML = aviso("Link de convite incompleto. Abra novamente o link que você recebeu.", "erro"); return; }
  try {
    const c = await chamar("/convite/abrir", { token });
    guardar({ convite: c });
    if (c.etapa === "consentimento" && estado().desafio) telaConsentimento(c);
    else telaVerificacao(c);
  } catch (e) {
    raiz.innerHTML = aviso(e.status === 404 ? "Este convite é inválido, já foi usado ou expirou. Peça um novo convite a quem enviou." : e.message, "erro");
  }
}

function resumoConvite(c) {
  return `<section class="tt-cartao">
    <p><b>${esc(c.empresa)}</b> convidou <b>${esc(c.nome)}</b> para receber avisos por WhatsApp.</p>
    <dl class="tt-dl"><dt>Unidades</dt><dd>${c.unidades.map(esc).join(", ")}</dd>
      <dt>Avisos propostos</dt><dd><ul>${c.categorias.map((k) => `<li>${esc(k.rotulo)}${k.descricao ? ` — <small>${esc(k.descricao)}</small>` : ""}</li>`).join("")}</ul></dd>
      <dt>Válido até</dt><dd>${esc(new Date(c.expiraEm).toLocaleString("pt-BR"))}</dd></dl>
  </section>`;
}

function telaVerificacao(c) {
  const pode = c.verificacaoDisponivel;
  raiz.innerHTML = `${bannerSimulacao(c.simulacao)}${resumoConvite(c)}
    <section class="tt-cartao">
      <h2>1. Confirme que este WhatsApp é seu</h2>
      <p>Enviaremos um código de 6 dígitos para o número convidado. Ninguém da empresa vê esse código.</p>
      ${pode ? `<button type="button" class="tt-btn" id="tt-pedir">Receber código</button>` : aviso("A verificação por WhatsApp está indisponível no momento. Tente mais tarde.", "erro")}
      <small class="tt-erro" id="tt-pedir-erro" role="alert"></small>
      <form id="tt-form-codigo" hidden novalidate>${campoCodigo()}
        <div class="tt-acoes"><button type="submit" class="tt-btn">Confirmar código</button></div></form>
    </section>`;
  const pedir = raiz.querySelector("#tt-pedir");
  pedir?.addEventListener("click", async () => {
    erroNa("#tt-pedir-erro", "");
    pedir.disabled = true;
    try {
      const r = await chamar("/convite/codigo", { token: estado().token });
      if (r.etapa === "consentimento") { if (estado().desafio) return telaConsentimento(c); }
      if (!r.ok) { erroNa("#tt-pedir-erro", (MOTIVO_CODIGO[r.motivo] ?? MOTIVO_CODIGO.INDISPONIVEL)(r)); pedir.disabled = r.motivo === "LIMITE"; if (r.motivo === "AGUARDE") contagemReenvio(pedir, r.segundos ?? 60); return; }
      guardar({ desafio: r.desafio, provisorio: r.provisorio });
      raiz.querySelector("#tt-form-codigo").hidden = false;
      pedir.textContent = "Reenviar código";
      contagemReenvio(pedir, r.reenvioEmSegundos ?? 60);
      raiz.querySelector("#tt-codigo").focus();
    } catch (e) { erroNa("#tt-pedir-erro", e.message); pedir.disabled = false; }
  });
  raiz.querySelector("#tt-form-codigo")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const codigo = raiz.querySelector("#tt-codigo").value.trim();
    if (!/^\d{6}$/.test(codigo)) return erroNa("#tt-codigo-erro", "Digite os 6 números do código.");
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const s = estado();
      const r = await chamar("/convite/verificar", { token: s.token, desafio: s.desafio, provisorio: s.provisorio, codigo });
      if (r.resultado === "VERIFICADO") return telaConsentimento(c);
      erroNa("#tt-codigo-erro", (MOTIVO_VERIFICACAO[r.resultado] ?? MOTIVO_VERIFICACAO.INVALIDO)(r));
    } catch (e) { erroNa("#tt-codigo-erro", e.message); }
    btn.disabled = false;
  });
}

function telaConsentimento(c) {
  const termo = c.termo;
  raiz.innerHTML = `${bannerSimulacao(c.simulacao)}
    <section class="tt-cartao">
      <h2>2. Escolha o que deseja receber</h2>
      <p>Número confirmado. Marque só os avisos que você quer. Nenhum vem marcado.</p>
      <form id="tt-form-consentimento" novalidate>
        <fieldset class="tt-opcoes"><legend>Avisos de ${esc(c.empresa)} (${c.unidades.map(esc).join(", ")})</legend>
          ${c.categorias.map((k) => `<label class="tt-check"><input type="checkbox" name="cat" value="${esc(k.codigo)}" />
            <span><b>${esc(k.rotulo)}</b>${k.simulacao ? " <em>(em simulação)</em>" : ""}${k.descricao ? `<small>${esc(k.descricao)}</small>` : ""}</span></label>`).join("")}
        </fieldset>
        ${termo ? `<details class="tt-termo" open><summary>Termo de autorização (versão ${esc(termo.versao)})</summary>
          ${termo.rascunho ? aviso("Texto em revisão jurídica — usado só em simulação.", "simulacao") : ""}
          <div class="tt-termo-texto">${esc(termo.texto).replace(/\n/g, "<br>")}</div></details>` : aviso("Termo indisponível no momento.", "erro")}
        <small class="tt-erro" id="tt-consent-erro" role="alert"></small>
        <div class="tt-acoes">
          <button type="submit" class="tt-btn" ${termo ? "" : "disabled"}>Autorizar os avisos marcados</button>
          <button type="button" class="tt-btn tt-btn--sec" id="tt-recusar" ${termo ? "" : "disabled"}>Não quero receber</button>
        </div>
      </form>
    </section>`;
  const enviar = async (categorias) => {
    erroNa("#tt-consent-erro", "");
    raiz.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const s = estado();
      const r = await chamar("/convite/consentir", { token: s.token, desafio: s.desafio, categorias, termoVersao: termo.versao });
      const fim = {
        CONSENTIDO: ["ok", "Pronto! Os avisos marcados foram autorizados. Você pode parar de receber quando quiser."],
        RECUSADO_PELO_TITULAR: ["ok", "Tudo certo: você não receberá esses avisos."],
        VERIFICACAO_EXPIRADA: ["erro", "A confirmação do número expirou. Abra o link de novo e peça outro código."],
        TERMO_DESATUALIZADO: ["erro", "O termo foi atualizado. Recarregue a página para ler a versão nova."],
      }[r.resultado] ?? ["erro", "Não foi possível registrar agora. Abra o link de novo."];
      if (fim[0] === "ok") { sessionStorage.removeItem(SS); for (const k of Object.keys(memoria)) delete memoria[k]; }
      raiz.innerHTML = `${bannerSimulacao(c.simulacao)}<section class="tt-cartao">${aviso(fim[1], fim[0])}
        <p><a href="/notificacoes/gerenciar.html">Gerenciar meus avisos</a></p></section>`;
    } catch (e) {
      erroNa("#tt-consent-erro", e.message);
      raiz.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  };
  raiz.querySelector("#tt-form-consentimento").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const marcadas = [...raiz.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
    if (!marcadas.length) return erroNa("#tt-consent-erro", "Marque ao menos um aviso, ou use “Não quero receber”.");
    enviar(marcadas);
  });
  raiz.querySelector("#tt-recusar").addEventListener("click", () => enviar([]));
  raiz.querySelectorAll('input[name="cat"]').forEach((i) => i.addEventListener("change", () => erroNa("#tt-consent-erro", "")));
  raiz.querySelector('input[name="cat"]')?.focus();
}

// =========================================================================================================================
// GESTÃO (ver e parar de receber)
// =========================================================================================================================
function telaNumero(msg = "") {
  raiz.innerHTML = `<section class="tt-cartao">
      <h2>Qual é o seu WhatsApp?</h2>
      <p>Enviaremos um código para confirmar que o número é seu. Depois você vê e desliga os avisos que recebe.</p>
      ${msg ? aviso(msg, "erro") : ""}
      <form id="tt-form-numero" novalidate>
        <label class="tt-campo" for="tt-tel"><span>WhatsApp com DDD</span>
          <input id="tt-tel" inputmode="tel" autocomplete="tel" placeholder="(00) 00000-0000" aria-describedby="tt-tel-ajuda tt-tel-erro" required />
          <small id="tt-tel-ajuda">De fora do Brasil, comece com + e o código do país.</small>
          <small class="tt-erro" id="tt-tel-erro" role="alert"></small></label>
        <div class="tt-acoes"><button type="submit" class="tt-btn">Receber código</button></div>
      </form></section>`;
  raiz.querySelector("#tt-tel").focus();
  raiz.querySelector("#tt-form-numero").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const telefone = raiz.querySelector("#tt-tel").value.trim();
    if (telefone.replace(/\D/g, "").length < 10) return erroNa("#tt-tel-erro", "Informe o número com DDD.");
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      const r = await chamar("/gestao/codigo", { telefone });
      memoria.telefone = telefone;   // só em memória: o número nunca vai para o storage
      guardar({ desafioGestao: r.desafio, provisorioGestao: r.provisorio });
      telaCodigoGestao(r.mensagem);
    } catch (e) { erroNa("#tt-tel-erro", e.message); btn.disabled = false; }
  });
}

function telaCodigoGestao(mensagem) {
  raiz.innerHTML = `<section class="tt-cartao">${aviso(mensagem)}
    <form id="tt-form-codigo" novalidate>${campoCodigo()}
      <div class="tt-acoes"><button type="submit" class="tt-btn">Confirmar</button>
        <button type="button" class="tt-btn tt-btn--sec" id="tt-outro">Usar outro número</button></div></form></section>`;
  raiz.querySelector("#tt-codigo").focus();
  raiz.querySelector("#tt-outro").addEventListener("click", () => telaNumero());
  raiz.querySelector("#tt-form-codigo").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const codigo = raiz.querySelector("#tt-codigo").value.trim();
    if (!/^\d{6}$/.test(codigo)) return erroNa("#tt-codigo-erro", "Digite os 6 números do código.");
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const s = estado();
      const r = await chamar("/gestao/verificar", { desafio: s.desafioGestao, provisorio: s.provisorioGestao, codigo });
      if (r.resultado !== "VERIFICADO") { erroNa("#tt-codigo-erro", "O código não confere ou expirou. Confira e tente de novo, ou peça outro código."); btn.disabled = false; return; }
      memoria.sessao = r.sessao;    // sessão curta (15 min), só em memória
      telaInscricoes();
    } catch (e) { erroNa("#tt-codigo-erro", e.message); btn.disabled = false; }
  });
}

async function telaInscricoes(msg = null) {
  raiz.innerHTML = `<p class="tt-carregando">Carregando seus avisos…</p>`;
  let lista;
  try { lista = await chamar("/gestao/inscricoes", { sessao: memoria.sessao, telefone: memoria.telefone }); }
  catch (e) { return telaNumero(e.status === 401 ? "Sua sessão expirou. Peça um novo código." : e.message); }
  const empresas = lista.filter((x) => x.categorias.length);
  raiz.innerHTML = `${msg ? aviso(msg, "ok") : ""}
    <section class="tt-cartao"><h2>Avisos que você recebe</h2>
      ${empresas.length ? empresas.map((x) => `<form class="tt-empresa" data-org="${esc(x.organizacaoId)}" novalidate>
          <fieldset class="tt-opcoes"><legend>${esc(x.empresa)}</legend>
            ${x.categorias.map((k) => `<label class="tt-check"><input type="checkbox" name="cat" value="${esc(k.codigo)}" /> <span>${esc(k.rotulo)}</span></label>`).join("")}</fieldset>
          <div class="tt-acoes"><button type="submit" class="tt-btn tt-btn--sec">Parar de receber os marcados</button>
            <button type="button" class="tt-btn tt-btn--sec" data-sair-empresa>Parar tudo desta empresa</button></div>
        </form>`).join("") : `<p>Você não recebe nenhum aviso no momento.</p>`}
    </section>
    <section class="tt-cartao tt-cartao--perigo"><h2>Não quero receber mais nada</h2>
      <p>Para todos os avisos de todas as empresas. Só um novo convite, confirmado por você, volta a autorizar.</p>
      <div class="tt-acoes"><button type="button" class="tt-btn tt-btn--perigo" id="tt-sair-tudo">Parar todos os avisos</button></div></section>`;
  const revogar = async (corpo, texto) => {
    raiz.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const r = await chamar("/gestao/revogar", { sessao: memoria.sessao, telefone: memoria.telefone, ...corpo });
      telaInscricoes(r.resultado === "REVOGADO" ? texto : "Nada a alterar.");
    } catch (e) { telaNumero(e.status === 401 ? "Sua sessão expirou. Peça um novo código." : e.message); }
  };
  raiz.querySelectorAll("form.tt-empresa").forEach((f) => {
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const categorias = [...f.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
      if (!categorias.length) return;
      revogar({ organizacaoId: f.dataset.org, categorias }, "Pronto: esses avisos foram desligados agora.");
    });
    f.querySelector("[data-sair-empresa]").addEventListener("click", () => revogar({ organizacaoId: f.dataset.org }, "Pronto: você não recebe mais avisos desta empresa."));
  });
  const tudo = raiz.querySelector("#tt-sair-tudo");
  tudo.addEventListener("click", () => {
    if (tudo.dataset.confirmar !== "1") { tudo.dataset.confirmar = "1"; tudo.textContent = "Confirmar: parar todos os avisos"; return; }
    revogar({ sairDeTudo: true }, "Pronto: você não recebe mais nenhum aviso.");
  });
}

if (pagina === "convite") iniciarConvite();
else if (pagina === "gerenciar") telaNumero();
