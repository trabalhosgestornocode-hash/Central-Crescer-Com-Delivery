// Página de Configurações — cards clicáveis + painéis internos de edição.
//
// MULTI-TENANT DE VERDADE: toda seção parte da EMPRESA e da UNIDADE do
// contexto atual (state.sessao.empresa / state.sessao.unidade), nunca de
// nome, id fixo ou fallback de um tenant específico. As seções que gravam
// dados (Dados da Unidade, Metas de CMV, Tabelas Comerciais, Usuários) falam
// com o backend, que resolve o tenant pelo Context Token (req.tenant) — o
// frontend nunca envia organizacao_id/unidade_id.
//
// O que continua sendo LOCAL (localStorage), e por quê:
//   * Aparência (tema claro/escuro) — preferência do dispositivo/usuário,
//     não faz sentido gravar como config da loja.
//   * "Exportar configurações locais" (Backup) — dump do que está no
//     navegador, rotulado honestamente como tal.
// Nada mais é salvo em localStorage. A antiga chave global de configuração
// da tela (que misturava dados de todos os tenants no mesmo navegador) foi
// removida por completo.
import { el, escapeHtml, toast } from "./utils.js";
import { state } from "./state.js";
import { TABELAS } from "./config.js";
import {
  obterUsuarios, criarUsuario, atualizarUsuario, excluirUsuario,
  obterTabelasComerciaisUnidade, alterarTabelaComercialUnidade,
  obterDadosUnidade, atualizarDadosUnidade,
  obterMetasCmvUnidade, salvarMetasCmvUnidade,
} from "./api.js";
import { pode } from "./sessao.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";

// Perfis da UI <-> enum papel_acesso do banco (migration 015). O cargo
// pertence ao VÍNCULO usuário<->empresa, não ao usuário: o mesmo login pode
// ser Administrador aqui e Financeiro em outra unidade do grupo.
const PAPEL_LABEL = {
  organization_admin: "Administrador",
  unit_manager: "Gestor de Unidade",
  finance: "Financeiro",
  operations: "Operação",
  viewer: "Consulta",
};
const PAPEL_ENUM = Object.fromEntries(Object.entries(PAPEL_LABEL).map(([k, v]) => [v, k]));
const PERFIS = Object.values(PAPEL_LABEL);

function gerarSenha() {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#!$";
  const arr = crypto.getRandomValues(new Uint32Array(14));
  return [...arr].map((n) => cs[n % cs.length]).join("");
}

// ---------- contexto atual (empresa + unidade) ----------
const empresaAtual = () => state.sessao.empresa || null;
const unidadeAtual = () => state.sessao.unidade || null;
const nomeEmpresa = () => empresaAtual()?.nome || "—";
const nomeUnidade = () => unidadeAtual()?.nome || null;
const temUnidade = () => !!unidadeAtual()?.id;

const slug = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "config";

// ---------- tema (individual, por dispositivo) ----------
// Chave nova; lê a antiga uma vez para não perder a preferência de quem já
// tinha escolhido tema antes desta mudança.
const LS_TEMA = "cd.tema";
const LS_TEMA_LEGADO = "saci-tema"; // chave antiga; lida uma vez p/ migrar a preferência de tema
function lerTema() {
  const t = localStorage.getItem(LS_TEMA) ?? localStorage.getItem(LS_TEMA_LEGADO);
  return t === "dark" ? "dark" : "light";
}
export function aplicarTemaSalvo() {
  const t = lerTema();
  document.documentElement.setAttribute("data-theme", t);
  return t;
}
function definirTema(t) {
  localStorage.setItem(LS_TEMA, t);
  localStorage.removeItem(LS_TEMA_LEGADO);
  document.documentElement.setAttribute("data-theme", t);
}
const temaAtual = () => lerTema();

// ---------- helpers de UI ----------
const campo = (label, id, valor = "", { tipo = "text", ph = "", extra = "" } = {}) => `
  <label class="cfg-campo">
    <span>${label}</span>
    <input id="${id}" type="${tipo}" value="${escapeHtml(valor)}" placeholder="${escapeHtml(ph)}" ${extra} />
  </label>`;

const campoFixo = (label, valor) => `
  <label class="cfg-campo">
    <span>${label}</span>
    <b class="cfg-campo-fixo">${escapeHtml(valor ?? "—")}</b>
  </label>`;

const select = (label, id, opcoes, valorAtual = "") => `
  <label class="cfg-campo">
    <span>${label}</span>
    <select id="${id}">${opcoes.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${escapeHtml(v)}" ${v === valorAtual ? "selected" : ""}>${escapeHtml(l)}</option>`;
    }).join("")}</select>
  </label>`;

const painel = (titulo, corpo, sub = "") =>
  `<div class="cfg-panel"><div class="cfg-panel-head"><h3>${escapeHtml(titulo)}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></div>`;

const barraSalvar = (label = "Salvar alterações") =>
  `<div class="cfg-acoes"><button class="btn btn-primary" data-salvar>${escapeHtml(label)}</button></div>`;

const val = (root, id) => root.querySelector("#" + id)?.value ?? "";
const chk = (root, id) => !!root.querySelector("#" + id)?.checked;

const estadoCarregando = (txt = "Carregando…") =>
  `<div class="cfg-panel"><div class="cfg-panel-body"><div class="estado"><div class="spinner"></div>${escapeHtml(txt)}</div></div></div>`;

const avisoSemUnidade = () => painel(
  "Selecione uma unidade",
  `<div class="estado-mini">Esta configuração é por unidade. Você está na visão consolidada
   (<b>todas as unidades</b> de ${escapeHtml(nomeEmpresa())}). Escolha uma unidade no seletor do topo para ver e editar.</div>`,
);

// Chama fn() só se o contexto não mudou no meio do await (evita render de
// dado da unidade anterior — mesmo mecanismo das outras views).
async function carregarProtegido(fn) {
  const g = geracaoContexto();
  try {
    const dados = await fn();
    if (contextoMudou(g)) return null;
    return dados;
  } catch (e) {
    if (contextoMudou(g)) return null;
    throw e;
  }
}

// ======================= SEÇÕES =======================
const SECOES = [
  { id: "unidade",      icon: "🏪", titulo: "Dados da Unidade",        desc: "Nome, CNPJ, endereço, responsável e contato da loja." },
  { id: "cmv",          icon: "🎯", titulo: "Metas e Limites de CMV",  desc: "Faixas de CMV, metas de faturamento e margem mínima." },
  { id: "precos",       icon: "🏷️", titulo: "Tabelas Comerciais",      desc: "Tabela oficial de Balcão e iFood desta unidade." },
  { id: "usuarios",     icon: "👥", titulo: "Usuários e Permissões",   desc: "Equipe, cargos por empresa, último acesso e status." },
  { id: "seguranca",    icon: "🔒", titulo: "Segurança",               desc: "Proteções de acesso aplicadas pela plataforma." },
  { id: "notificacoes", icon: "🔔", titulo: "Notificações",            desc: "Alertas de operação (em preparação)." },
  { id: "aparencia",    icon: "🎨", titulo: "Aparência",               desc: "Tema claro ou escuro — preferência deste dispositivo." },
  { id: "backup",       icon: "💾", titulo: "Backup e Manutenção",     desc: "Exportar configurações locais deste navegador." },
];

export function renderConfiguracoes() {
  const view = el("#view");
  if (!view) return;
  const empresa = nomeEmpresa();
  const unidade = nomeUnidade();
  const subtitulo = unidade ? `${empresa} · ${unidade}` : `${empresa} · todas as unidades`;
  view.innerHTML = `
    <p class="secao-titulo">⚙️ Configurações <small>${escapeHtml(subtitulo)}</small></p>
    <div class="cfg-grid">
      ${SECOES.map((s) => `
        <button class="cfg-card" data-sec="${s.id}">
          <span class="cfg-card-ico">${s.icon}</span>
          <span class="cfg-card-txt">
            <span class="cfg-card-titulo">${s.titulo}</span>
            <span class="cfg-card-desc">${s.desc}</span>
          </span>
          <span class="cfg-card-seta" aria-hidden="true">→</span>
        </button>`).join("")}
    </div>`;
  view.querySelectorAll(".cfg-card").forEach((b) => b.addEventListener("click", () => abrirSecao(b.dataset.sec)));
}

function abrirSecao(id) {
  const s = SECOES.find((x) => x.id === id);
  if (!s) return renderConfiguracoes();
  const view = el("#view");
  view.innerHTML = `
    <div class="cfg-detalhe-head">
      <button class="btn btn-ghost btn-sm" id="cfg-voltar">← Configurações</button>
      <h2 class="cfg-detalhe-titulo"><span>${s.icon}</span> ${s.titulo}</h2>
    </div>
    <div class="cfg-detalhe" id="cfg-detalhe"></div>`;
  el("#cfg-voltar").addEventListener("click", renderConfiguracoes);
  (DETALHES[id] || (() => {}))(el("#cfg-detalhe"));
}

// ======================= 1. DADOS DA UNIDADE (real) =======================
async function carregarDadosUnidade(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando dados da unidade…");
  let dados;
  try {
    const resp = await carregarProtegido(obterDadosUnidade);
    if (resp === null) return; // contexto mudou
    dados = resp.data;
  } catch (e) {
    root.innerHTML = painel("Dados da Unidade", `<div class="estado-mini">Não foi possível carregar: ${escapeHtml(e.message)}</div>`);
    return;
  }
  desenharDadosUnidade(root, dados);
}

function desenharDadosUnidade(root, d) {
  const podeEditar = pode("configuracoes.gerenciar");
  const ro = podeEditar ? "" : "disabled";
  root.innerHTML = painel("Identificação da loja", `
    <div class="cfg-form-grid">
      ${campo("Nome da unidade", "u-nome", d.nome ?? "", { extra: ro })}
      ${campo("CNPJ", "u-cnpj", d.cnpj ?? "", { ph: "00.000.000/0000-00", extra: ro })}
      ${campo("Endereço", "u-end", d.endereco ?? "", { ph: "Rua, nº — bairro, cidade", extra: ro })}
      ${campo("Cidade", "u-cidade", d.cidade ?? "", { extra: ro })}
      ${campo("Estado (UF)", "u-uf", d.estado ?? "", { ph: "ex.: MG", extra: `maxlength="2" ${ro}` })}
      ${campo("Responsável", "u-resp", d.responsavel ?? "", { extra: ro })}
      ${campo("E-mail da loja", "u-email", d.email ?? "", { tipo: "email", ph: "contato@sualoja.com.br", extra: ro })}
      ${campo("Telefone", "u-tel", d.telefone ?? "", { ph: "(00) 00000-0000", extra: ro })}
      ${campoFixo("Status da unidade", d.status === "ativa" ? "🟢 Ativa" : "⚪ Inativa")}
    </div>
    <p class="cfg-meta">O status (ativar/desativar a unidade) é alterado apenas por um Administrador da plataforma.</p>
  `) + (podeEditar ? barraSalvar() : `<p class="cfg-meta">Você tem permissão para visualizar, não para editar os dados da loja.</p>`);

  const btn = root.querySelector("[data-salvar]");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { data } = await atualizarDadosUnidade({
        nome: val(root, "u-nome"), cnpj: val(root, "u-cnpj"), endereco: val(root, "u-end"),
        cidade: val(root, "u-cidade"), estado: val(root, "u-uf"),
        responsavel: val(root, "u-resp"), email: val(root, "u-email"), telefone: val(root, "u-tel"),
      });
      toast("Dados da unidade salvos.");
      // O nome pode ter mudado — avisa o shell para repintar topbar/seletor
      // (sem novo login). Manda a unidade já atualizada no detalhe.
      document.dispatchEvent(new CustomEvent("app:contexto-atualizado", {
        detail: { unidade: { id: data.id, nome: data.nome } },
      }));
      desenharDadosUnidade(root, data);
    } catch (e) {
      toast("Erro ao salvar: " + e.message);
      btn.disabled = false;
    }
  });
}

// ======================= 2. METAS E LIMITES DE CMV (real) =======================
async function carregarMetasCmv(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando metas…");
  let m;
  try {
    const resp = await carregarProtegido(obterMetasCmvUnidade);
    if (resp === null) return;
    m = resp.data;
  } catch (e) {
    root.innerHTML = painel("Metas e Limites de CMV", `<div class="estado-mini">Não foi possível carregar: ${escapeHtml(e.message)}</div>`);
    return;
  }
  desenharMetasCmv(root, m);
}

function desenharMetasCmv(root, m) {
  const podeEditar = pode("configuracoes.gerenciar");
  const ro = podeEditar ? "" : "disabled";
  const origem = m.persistido
    ? "Valores configurados para esta unidade."
    : "Ainda usando os valores padrão do sistema — ao salvar, eles passam a valer só para esta unidade.";
  root.innerHTML = painel("Faixas de CMV (%)", `
    <div class="cfg-form-grid">
      ${campo("CMV saudável (até)", "c-sau", m.cmvSaudavel ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" ${ro}` })}
      ${campo("CMV de atenção (até)", "c-ate", m.cmvAtencao ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" ${ro}` })}
    </div>
    <p class="cfg-meta">Classificam cada produto como saudável, atenção ou crítico. Acima do limite de atenção = crítico.</p>`, origem)
    + painel("Metas da operação", `
    <div class="cfg-form-grid">
      ${campo("Meta de faturamento diário (R$)", "c-fatd", m.metaFatDia ?? "", { tipo: "number", extra: `min="0" step="1" ${ro}` })}
      ${campo("Meta de faturamento mensal (R$)", "c-fatm", m.metaFatMes ?? "", { tipo: "number", extra: `min="0" step="1" ${ro}` })}
      ${campo("Margem mínima desejada (%)", "c-mar", m.margemMinima ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" ${ro}` })}
    </div>`)
    + (podeEditar ? barraSalvar() : `<p class="cfg-meta">Você tem permissão para visualizar, não para editar as metas.</p>`);

  const num = (id) => { const s = val(root, id).trim(); return s === "" ? null : Number(s); };
  const btn = root.querySelector("[data-salvar]");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { data } = await salvarMetasCmvUnidade({
        cmvSaudavel: num("c-sau"), cmvAtencao: num("c-ate"),
        metaFatDia: num("c-fatd"), metaFatMes: num("c-fatm"), margemMinima: num("c-mar"),
      });
      toast("Metas salvas para esta unidade.");
      desenharMetasCmv(root, data);
    } catch (e) {
      toast("Erro ao salvar: " + e.message);
      btn.disabled = false;
    }
  });
}

// ======================= 3. TABELAS COMERCIAIS (real) =======================
const CANAL_LABEL_TC = { balcao: "Balcão", ifood: "iFood" };

async function carregarTabelasComerciais(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando tabelas comerciais…");
  try {
    const resp = await carregarProtegido(obterTabelasComerciaisUnidade);
    if (resp === null) return;
    desenharTabelasComerciais(root, resp.data);
  } catch (e) {
    root.innerHTML = painel("Tabelas Comerciais",
      `<div class="estado-mini">Não foi possível carregar: ${escapeHtml(e.message)}</div>`);
  }
}

function linhaTabelaComercial(canalKey, tabelaAtual) {
  const podeAlterar = pode("configuracoes.gerenciar");
  return `
    <div class="cfg-user cfg-tabela-linha">
      <div class="cfg-user-info">
        <b>${CANAL_LABEL_TC[canalKey]}</b>
        <small>${tabelaAtual ? `Tabela atual: ${escapeHtml(tabelaAtual)}` : "Não configurada"}</small>
      </div>
      ${tabelaAtual
        ? `<span class="pill ok">Tabela atual: ${escapeHtml(tabelaAtual)}</span>`
        : `<span class="pill warn">Precisa configurar</span>`}
      ${podeAlterar ? `<button class="btn btn-ghost btn-sm" data-alterar-canal="${canalKey}">Alterar</button>` : ""}
    </div>`;
}

function desenharTabelasComerciais(root, data) {
  root.innerHTML = painel(
    "Tabelas comerciais da unidade",
    `<p class="cfg-tabela-explicacao">
      Define qual preço/CMV o Dashboard e Produtos/CMV usam por padrão para esta unidade. Trocar aqui muda a
      configuração real, para todo mundo, imediatamente. Só para <b>comparar</b> outra tabela sem alterar nada,
      use o seletor no topo do Dashboard/Produtos-CMV ("Comparar: X") — isso nunca grava aqui.
    </p>`
    + linhaTabelaComercial("balcao", data.tabelaBalcao)
    + linhaTabelaComercial("ifood", data.tabelaIfood)
    + (pode("configuracoes.gerenciar")
      ? ""
      : `<p class="cfg-meta">Você tem permissão para visualizar, não para alterar a tabela oficial — fale com um Administrador da empresa.</p>`),
  );
  root.querySelectorAll("[data-alterar-canal]").forEach((b) =>
    b.addEventListener("click", () => abrirAlteracaoTabelaComercial(root, b.dataset.alterarCanal, data)));
}

function abrirAlteracaoTabelaComercial(root, canalKey, dadosAtuais) {
  const tabelaAtual = canalKey === "ifood" ? dadosAtuais.tabelaIfood : dadosAtuais.tabelaBalcao;
  const opcoes = TABELAS[canalKey] || [];
  root.innerHTML = painel(`Alterar tabela — ${CANAL_LABEL_TC[canalKey]}`, `
    <div class="cfg-form-grid">
      ${campoFixo("Canal", CANAL_LABEL_TC[canalKey])}
      ${campoFixo("Tabela atual", tabelaAtual ? tabelaAtual : "não configurada")}
      ${select("Nova tabela", "tc-nova", opcoes, tabelaAtual ?? opcoes[0] ?? "")}
      ${campo("Motivo (opcional)", "tc-motivo", "", { ph: "ex.: renegociação com a marca" })}
    </div>
    <p class="cfg-aviso-alteracao">⚠️ Essa alteração modifica a tabela OFICIAL da unidade — Dashboard e Produtos/CMV passam a usar a nova tabela por padrão, para todo mundo, imediatamente. Fica registrada com seu usuário e horário.</p>
  `) + `
    <div class="cfg-acoes">
      <button class="btn btn-ghost" id="tc-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="tc-confirmar">Confirmar alteração</button>
    </div>`;

  root.querySelector("#tc-cancelar").addEventListener("click", () => carregarTabelasComerciais(root));
  root.querySelector("#tc-confirmar").addEventListener("click", async () => {
    const novaTabela = val(root, "tc-nova");
    const motivo = val(root, "tc-motivo");
    const btn = root.querySelector("#tc-confirmar");
    btn.disabled = true;
    try {
      await alterarTabelaComercialUnidade({ canal: canalKey, novaTabela, motivo });
      toast(`Tabela ${CANAL_LABEL_TC[canalKey]} alterada para ${novaTabela}.`);
      carregarTabelasComerciais(root);
    } catch (e) {
      toast("Erro ao alterar: " + e.message);
      btn.disabled = false;
    }
  });
}

// ======================= DETALHES DE CADA SEÇÃO =======================
const DETALHES = {
  unidade: (root) => carregarDadosUnidade(root),

  cmv: (root) => carregarMetasCmv(root),

  precos: (root) => carregarTabelasComerciais(root),

  // 4. Usuários e Permissões (real — Supabase Auth via backend, escopo por
  // req.tenant.organizacaoId). O cargo pertence ao vínculo usuário<->empresa.
  usuarios(root) {
    root.innerHTML = estadoCarregando("Carregando usuários…");
    carregar();

    async function carregar() {
      try {
        const resp = await carregarProtegido(obterUsuarios);
        if (resp === null) return;
        desenhar(resp.data || []);
      } catch (e) {
        root.innerHTML = painel("Usuários e Permissões",
          `<div class="estado-mini">Não foi possível carregar os usuários: ${escapeHtml(e.message)}<br>Apenas Administrador da empresa tem acesso a esta seção.</div>`);
      }
    }

    function linhaUsuario(u) {
      const label = PAPEL_LABEL[u.papel] || u.papel || "—";
      const nome = u.nome || u.email || "—";
      return `
        <div class="cfg-user" data-id="${escapeHtml(u.id)}">
          <span class="cfg-user-av">${escapeHtml((nome[0] || "?").toUpperCase())}</span>
          <div class="cfg-user-info"><b>${escapeHtml(nome)}</b><small>${escapeHtml(u.email || "")}</small></div>
          <select class="cfg-user-perfil" data-id="${escapeHtml(u.id)}">${PERFIS.map((p) => `<option ${p === label ? "selected" : ""}>${p}</option>`).join("")}</select>
          <span class="pill ${u.ativo ? "ok" : "muted"}">${u.ativo ? "Ativo" : "Inativo"}</span>
          <button class="cfg-user-del" data-del="${escapeHtml(u.id)}" title="Remover acesso" aria-label="Remover acesso de ${escapeHtml(nome)}">🗑️</button>
        </div>`;
    }

    function desenhar(lista) {
      root.innerHTML = painel("Equipe desta empresa", `
          <div class="cfg-users">
            ${lista.length ? lista.map(linhaUsuario).join("") : `<div class="estado-mini">Nenhum usuário com acesso a esta empresa ainda.</div>`}
          </div>
          <div class="cfg-legenda">Cargos: ${PERFIS.map((p) => `<span class="cfg-chip">${p}</span>`).join("")}</div>
        `, "O cargo vale apenas nesta empresa. O mesmo usuário pode ter outro cargo em outra unidade do grupo.")
        + painel("Conceder acesso a esta empresa", `
          <div class="cfg-form-grid">
            ${campo("Nome", "nu-nome")}
            ${campo("E-mail", "nu-email", "", { tipo: "email", ph: "nome@empresa.com" })}
            <label class="cfg-campo"><span>Senha</span>
              <span class="cfg-senha-wrap"><input id="nu-senha" type="text" placeholder="mínimo 8 caracteres"><button type="button" class="btn btn-ghost btn-sm" id="nu-gerar">Gerar</button></span>
            </label>
            ${select("Cargo", "nu-perfil", PERFIS, "Operação")}
          </div>
          <div class="cfg-acoes cfg-acoes--start"><button class="btn btn-primary" id="nu-add">+ Conceder acesso</button></div>
        `, "Se o e-mail já tiver conta na plataforma, o acesso a esta empresa é apenas concedido e a senha atual é mantida. Caso contrário, a conta é criada e já pode fazer login com a senha definida — anote e repasse.");

      root.querySelector("#nu-gerar").addEventListener("click", () => { root.querySelector("#nu-senha").value = gerarSenha(); });
      root.querySelector("#nu-add").addEventListener("click", criar);
      root.querySelectorAll(".cfg-user-del").forEach((b) => b.addEventListener("click", () => excluir(b.dataset.del, lista)));
      root.querySelectorAll(".cfg-user-perfil").forEach((s) => s.addEventListener("change", () => trocarPerfil(s.dataset.id, PAPEL_ENUM[s.value])));
    }

    async function criar() {
      const nome = val(root, "nu-nome");
      const email = val(root, "nu-email").trim();
      const senha = val(root, "nu-senha");
      const papel = PAPEL_ENUM[val(root, "nu-perfil")];
      if (!email) return toast("Informe o e-mail do usuário.");
      if (!senha || senha.length < 8) return toast("A senha precisa de ao menos 8 caracteres.");
      const btn = root.querySelector("#nu-add");
      btn.disabled = true; btn.textContent = "Concedendo…";
      try {
        await criarUsuario({ nome, email, senha, papel });
        toast("Acesso concedido — o usuário já pode entrar nesta empresa.");
        carregar();
      } catch (e) {
        toast("Erro: " + e.message);
        btn.disabled = false; btn.textContent = "+ Conceder acesso";
      }
    }

    async function excluir(id, lista) {
      const u = (lista || []).find((x) => x.id === id);
      if (!confirm(`Remover o acesso de "${u?.nome || u?.email || id}" a esta empresa?\n\nA conta continua existindo e mantém o acesso às outras empresas em que estiver vinculada.`)) return;
      try { await excluirUsuario(id); toast("Acesso removido desta empresa."); carregar(); }
      catch (e) { toast("Erro: " + e.message); }
    }

    async function trocarPerfil(id, papel) {
      try { await atualizarUsuario(id, { papel }); toast("Cargo atualizado."); }
      catch (e) { toast("Erro: " + e.message); carregar(); }
    }
  },

  // 5. Segurança — só o que a plataforma REALMENTE aplica. Sem toggles que
  // aparentam funcionar sem enforcement.
  seguranca(root) {
    root.innerHTML = painel("Proteções de acesso (aplicadas pela plataforma)", `
      <ul class="cfg-lista-check">
        <li>✅ <b>Senha mínima de 8 caracteres</b> — exigida na criação e na redefinição de qualquer conta.</li>
        <li>✅ <b>Troca de senha no primeiro acesso</b> — contas criadas com senha provisória só operam o sistema depois de definir uma senha própria.</li>
        <li>✅ <b>Sessão com expiração e revogação imediata</b> — trocar o cargo ou remover o acesso encerra as sessões abertas daquele usuário nesta empresa na hora.</li>
        <li>✅ <b>Registro de acessos e ações</b> — logins e operações sensíveis ficam na auditoria da plataforma (imutável).</li>
        <li>✅ <b>Isolamento por empresa/unidade</b> — cada requisição é validada contra o contexto assinado; uma empresa nunca lê dado de outra.</li>
      </ul>
      <p class="cfg-meta">Políticas configuráveis por empresa (nº de tentativas, tempo de sessão personalizado) ainda não estão disponíveis — quando estiverem, aparecem aqui.</p>
    `, "Estas proteções estão sempre ativas e não são desligáveis pela loja.");
  },

  // 6. Notificações — ainda não há mecanismo de envio. Estado informativo,
  // nada é persistido.
  notificacoes(root) {
    root.innerHTML = painel("Alertas de operação", `
      <div class="estado-mini">
        <b>Recurso ainda não configurado.</b><br>
        O envio de alertas (estoque crítico, CMV alto, faturamento abaixo da meta) por sistema, e-mail ou WhatsApp
        está em preparação. Nenhuma preferência é salva por enquanto — quando o envio existir, as opções aparecem aqui
        e serão preferências por usuário.
      </div>
    `);
  },

  // 7. Aparência — preferência do dispositivo/usuário (localStorage).
  aparencia(root) {
    const desenhar = () => {
      const atual = temaAtual();
      root.innerHTML = painel("Tema desta conta neste dispositivo", `
        <div class="cfg-tema-grid">
          <button class="cfg-tema-op ${atual === "light" ? "ativo" : ""}" data-tema="light">
            <span class="cfg-tema-prev cfg-tema-prev--light"><i></i><i></i><i></i></span>
            <b>Claro</b>
          </button>
          <button class="cfg-tema-op ${atual === "dark" ? "ativo" : ""}" data-tema="dark">
            <span class="cfg-tema-prev cfg-tema-prev--dark"><i></i><i></i><i></i></span>
            <b>Escuro</b>
          </button>
        </div>
        <div class="cfg-meta">🔒 Esta escolha é <b>individual</b>: fica salva só neste navegador/dispositivo e não muda o tema dos outros usuários.</div>
      `);
      root.querySelectorAll(".cfg-tema-op").forEach((b) => b.addEventListener("click", () => {
        definirTema(b.dataset.tema);
        toast(`Tema ${b.dataset.tema === "dark" ? "escuro" : "claro"} aplicado neste dispositivo.`);
        desenhar();
      }));
    };
    desenhar();
  },

  // 8. Backup e Manutenção — exportação HONESTA: só o que está no navegador.
  // Backup real dos dados do tenant é do backend, não desta tela.
  backup(root) {
    const empresa = nomeEmpresa();
    const unidade = nomeUnidade() ?? "todas-as-unidades";
    root.innerHTML = painel("Configurações locais deste navegador", `
      <p class="cfg-meta">
        Estas ações só afetam o que está salvo <b>neste navegador</b> (hoje: o tema). Não exportam nem apagam
        nada do banco de dados — os dados da empresa ${escapeHtml(empresa)} ficam sempre no servidor.
      </p>
      <div class="cfg-botoes">
        <button class="btn btn-ghost" id="b-export">⬇️ Exportar configurações locais (JSON)</button>
        <button class="btn btn-ghost cfg-btn-perigo" id="b-limpar">🧹 Limpar configurações locais</button>
      </div>`);

    root.querySelector("#b-export").addEventListener("click", () => {
      const dump = {
        exportadoEm: new Date().toISOString(),
        empresa, unidade,
        local: { tema: temaAtual() },
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(empresa)}-${slug(unidade)}-config-local-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast("Exportação local gerada.");
    });
    root.querySelector("#b-limpar").addEventListener("click", () => {
      if (confirm("Limpar as configurações salvas neste dispositivo? O tema volta ao padrão.")) {
        localStorage.removeItem(LS_TEMA);
        localStorage.removeItem(LS_TEMA_LEGADO);
        aplicarTemaSalvo();
        toast("Configurações locais limpas.");
        abrirSecao("backup");
      }
    });
  },
};

// Trocar de empresa/unidade com a tela de Configurações aberta: o próprio
// funil de troca (app.js#mostrarApp) já re-renderiza a rota. Este reset é a
// defesa a mais — garante que nada de módulo sobrevive à troca.
registrarResetDeContexto(() => {
  const view = el("#view");
  if (view && state.rota === "configuracoes") {
    // Deixa app.js#mostrarApp decidir a rota; só evita manter um painel
    // antigo pintado durante a transição.
    view.innerHTML = "";
  }
});
