// Página de detalhe da empresa — Informações · Acessos · Unidades ·
// Usuários · Modelo Inicial · Auditoria.
//
// Substitui o antigo modal único de detalhe (`abrirDetalheEmpresa`, removido
// de adminViews.js): a quantidade de conteúdo (6 seções, uma delas um
// formulário de módulos) não cabe bem num modal, e o pedido original descreve
// justamente uma "página da empresa" com essas abas.
//
// Não é uma TELA_ADMIN do menu lateral — é aberta a partir do botão
// "Detalhes" da lista de Empresas (`abrirPaginaEmpresa`) e desenha direto em
// `#adm-view`, o mesmo container que `renderView` usa. "← Empresas" volta
// pela navegação normal (`irParaAdmin`).

import { el, escapeHtml, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { irParaAdmin } from "./admin.js";
import { abrirAssistenteNovaUnidade } from "./adminUnidadeWizard.js";
import { abrirPaginaUnidade } from "./adminUnidadeDetalhe.js";
import {
  campo, area, grade, valor,
  STATUS_EMPRESA, fmtDataHora, fmtMoeda, num, carregando, erro, reservado, pill, tabela,
} from "./adminUi.js";

const ABAS = [
  { id: "informacoes", label: "Informações" },
  { id: "acessos", label: "Acessos" },
  { id: "unidades", label: "Unidades" },
  { id: "usuarios", label: "Usuários" },
  { id: "modelo", label: "Modelo Inicial" },
  { id: "auditoria", label: "Auditoria" },
];

let empresaId = null;
let abaAtual = "informacoes";
/** Resultado de GET /plataforma/empresas/:id — recarregado a cada `renderPagina`. */
let empresaCache = null;

/** @param {string} id */
export async function abrirPaginaEmpresa(id) {
  empresaId = id;
  abaAtual = "informacoes";
  await renderPagina();
}

async function renderPagina() {
  const view = el("#adm-view");
  view.innerHTML = carregando();
  try {
    empresaCache = await adminApi.empresa(empresaId);
  } catch (e) {
    view.innerHTML = erro(e.message);
    return;
  }
  desenhar();
}

function desenhar() {
  const view = el("#adm-view");
  const e = empresaCache;
  view.innerHTML = `
    <div class="adm-empresa-topo">
      <button class="btn btn-ghost btn-sm" id="ed-voltar" type="button">← Empresas</button>
      <h2 class="adm-empresa-nome">${escapeHtml(e.nome)} ${pill(STATUS_EMPRESA, e.status)}</h2>
    </div>
    <div class="adm-abas" role="tablist">
      ${ABAS.map((a) => `<button class="adm-aba ${a.id === abaAtual ? "ativo" : ""}" data-aba="${a.id}" type="button">${escapeHtml(a.label)}</button>`).join("")}
    </div>
    <div id="ed-corpo">${carregando()}</div>`;

  el("#ed-voltar").addEventListener("click", () => irParaAdmin("empresas"));
  view.querySelectorAll(".adm-aba").forEach((btn) =>
    btn.addEventListener("click", () => { abaAtual = btn.dataset.aba; desenhar(); }));

  renderAba();
}

async function renderAba() {
  const corpo = el("#ed-corpo");
  try {
    corpo.innerHTML = await CORPOS[abaAtual]();
    ligarAba(abaAtual);
  } catch (e) {
    corpo.innerHTML = erro(e.message);
  }
}

/** Executa uma escrita, avisa e recarrega a página inteira (mesma aba). */
async function salvar(fn, mensagem) {
  try {
    await fn();
    toast(mensagem);
    await renderPagina();
  } catch (e) {
    toast("Erro: " + e.message);
  }
}

function ligarAba(aba) {
  if (aba === "informacoes") {
    el("#ed-salvar-info")?.addEventListener("click", () => salvar(() => adminApi.atualizarEmpresa(empresaId, {
      nome: valor("ed-nome"), cnpj: valor("ed-cnpj"),
      responsavelNome: valor("ed-resp"), responsavelEmail: valor("ed-email"),
      telefone: valor("ed-tel"), logoUrl: valor("ed-logo"), observacoes: valor("ed-obs"),
    }), "Informações atualizadas."));
  } else if (aba === "acessos") {
    el("#ed-salvar-acessos")?.addEventListener("click", () => {
      const ids = [...document.querySelectorAll(".ed-modulo:checked")].map((c) => c.value);
      return salvar(
        () => adminApi.definirModulosEmpresa(empresaId, ids),
        "Acessos atualizados — as sessões ativas desta empresa foram encerradas."
      );
    });
  } else if (aba === "modelo") {
    el("#ed-clonar-modelo")?.addEventListener("click", () =>
      salvar(() => adminApi.clonarModeloEmpresa(empresaId), "Catálogo do modelo clonado."));
  } else if (aba === "unidades") {
    el("#ed-nova-unidade")?.addEventListener("click", async () => {
      const empresas = await adminApi.empresas();
      abrirAssistenteNovaUnidade(empresas, empresaId);
    });
    document.querySelectorAll("[data-un-ver]").forEach((btn) =>
      btn.addEventListener("click", () => abrirPaginaUnidade(btn.dataset.unVer)));
  }
}

// ---------------------------------------------------------------------------
// Corpo de cada aba
// ---------------------------------------------------------------------------

const CORPOS = {
  informacoes: async () => {
    const e = empresaCache;
    return grade(
      campo({ id: "ed-nome", label: "Nome da empresa", valor: e.nome, obrigatorio: true }) +
      campo({ id: "ed-cnpj", label: "CNPJ", valor: e.cnpj, ph: "somente números" }) +
      campo({ id: "ed-resp", label: "Responsável", valor: e.responsavelNome }) +
      campo({ id: "ed-email", label: "E-mail do responsável", valor: e.responsavelEmail, tipo: "email" }) +
      campo({ id: "ed-tel", label: "Telefone", valor: e.telefone, ph: "DDD + número" }) +
      campo({ id: "ed-logo", label: "URL da logo", valor: e.logoUrl, ph: "https://…" }) +
      area({ id: "ed-obs", label: "Observações", valor: e.observacoes })
    ) + `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Plano</span><b>${escapeHtml(e.plano?.nome ?? "—")}</b></div>
        <div class="adm-det-linha"><span>Criada em</span><b>${escapeHtml(fmtDataHora(e.criadoEm))}</b></div>
        <div class="adm-det-linha"><span>Assinatura</span><b>${e.assinatura
          ? `${escapeHtml(e.assinatura.planos?.nome ?? "—")} · ${escapeHtml(e.assinatura.ciclo)} · ${fmtMoeda(e.assinatura.valor)}`
          : "sem assinatura"}</b></div>
        <div class="adm-det-linha"><span>Produtos / Insumos</span><b>${num(e.metricas.produtos)} / ${num(e.metricas.insumos)}</b></div>
        <div class="adm-det-linha"><span>Sessões vivas</span><b>${num(e.metricas.sessoesVivas)}</b></div>
      </div>
      <p class="adm-nota">Status, plano e exclusão continuam no menu "⋯" da lista de Empresas.</p>
      <div class="adm-secao-acoes adm-secao-acoes--fim">
        <button class="btn btn-primary btn-sm" id="ed-salvar-info" type="button">Salvar informações</button>
      </div>`;
  },

  acessos: async () => {
    const { modulos } = await adminApi.modulosDaEmpresa(empresaId);
    const grupo = (categoria, titulo) => {
      const itens = modulos.filter((m) => m.categoria === categoria);
      if (!itens.length) return "";
      return `
        <fieldset class="adm-modulos-grupo">
          <legend>${escapeHtml(titulo)}</legend>
          ${itens.map((m) => `
            <label class="adm-assoc adm-assoc--check">
              <input type="checkbox" class="ed-modulo" value="${escapeHtml(m.id)}" ${m.habilitado ? "checked" : ""} />
              <span class="adm-assoc-nome">${escapeHtml(m.nome)}</span>
            </label>`).join("")}
        </fieldset>`;
    };
    return `
      <p class="adm-nota">Alterar os módulos aqui encerra as sessões ativas desta empresa — o próximo acesso já
      entra com os módulos novos.</p>
      ${grupo("operacao", "Operação")}
      ${grupo("integracao", "Integrações")}
      ${grupo("financeiro", "Financeiro (acesso por concessão explícita)")}
      <div class="adm-secao-acoes adm-secao-acoes--fim">
        <button class="btn btn-primary btn-sm" id="ed-salvar-acessos" type="button">Salvar acessos</button>
      </div>`;
  },

  unidades: async () => {
    const linhas = empresaCache.unidades.map((u) => [
      `<b>${escapeHtml(u.nome)}</b>`,
      u.ativo ? '<span class="pill ok">Ativa</span>' : '<span class="pill muted">Inativa</span>',
      `<button class="btn btn-ghost btn-sm" data-un-ver="${escapeHtml(u.id)}" type="button">Abrir</button>`,
    ]);
    return tabela({
      colunas: ["Unidade", "Status", ""],
      linhas,
      vazio: "Nenhuma unidade cadastrada ainda.",
    }) + `
      <div class="adm-secao-acoes adm-secao-acoes--fim">
        <button class="btn btn-primary btn-sm" id="ed-nova-unidade" type="button">+ Nova unidade</button>
      </div>
      <p class="adm-nota">Gerenciamento completo (acessos, usuários, exclusão) fica na página própria da unidade —
      esta aba é só um atalho. Ver também a área <b>Unidades</b> no menu lateral.</p>`;
  },

  usuarios: async () => {
    const lista = empresaCache.usuarios.length
      ? empresaCache.usuarios.map((u) => `<li><b>${escapeHtml(u.nome ?? u.email ?? "—")}</b> — ${escapeHtml(u.papelRotulo)}
          ${u.vinculoAtivo ? "" : '<span class="pill bad">acesso bloqueado</span>'}</li>`).join("")
      : "<li>Nenhum usuário vinculado.</li>";
    return `<ul class="adm-det-lista">${lista}</ul>`;
  },

  modelo: async () => {
    const e = empresaCache;
    if (!e.modeloOrigemId) {
      return reservado(
        "Nenhum modelo inicial",
        "Esta empresa não foi provisionada a partir de um Modelo Padrão — porque não havia modelo disponível na criação, ou porque a empresa é anterior a esta funcionalidade."
      );
    }
    let nomeModelo = e.modeloOrigemId;
    try {
      const modelos = await adminApi.empresasModelo();
      nomeModelo = modelos.find((m) => m.id === e.modeloOrigemId)?.nome ?? nomeModelo;
    } catch { /* mantém o id como rótulo — não é crítico */ }
    const catalogoVazio = !e.metricas.produtos && !e.metricas.insumos;
    const acaoClonar = catalogoVazio
      ? `<div class="adm-secao-acoes adm-secao-acoes--fim">
           <button class="btn btn-primary btn-sm" id="ed-clonar-modelo" type="button">📋 Clonar catálogo do modelo agora</button>
         </div>`
      : `<p class="adm-nota">Esta empresa já tem produtos/insumos cadastrados — clonar de novo duplicaria os dados,
         então o botão só aparece com o catálogo vazio.</p>`;
    return `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Modelo de origem</span><b>${escapeHtml(nomeModelo)}</b></div>
        <div class="adm-det-linha"><span>Produtos / Insumos hoje</span><b>${num(e.metricas.produtos)} / ${num(e.metricas.insumos)}</b></div>
      </div>
      ${catalogoVazio ? `<div class="adm-aviso">O catálogo desta empresa está vazio. Se a clonagem do modelo falhou
        na criação (ou a empresa é de antes desta correção), use o botão abaixo para copiar produtos, insumos e
        fichas técnicas do modelo agora.</div>` : ""}
      <p class="adm-nota">Atualizar empresas já provisionadas quando o Modelo Padrão mudar é uma funcionalidade
      futura e controlada — nada aqui muda automaticamente.</p>
      ${acaoClonar}`;
  },

  auditoria: async () => {
    const logs = await adminApi.logsDaEmpresa(empresaId, 100);
    return tabela({
      colunas: ["Quando", "Ator", "Ação", "IP"],
      linhas: logs.map((l) => [
        escapeHtml(fmtDataHora(l.em)), escapeHtml(l.atorEmail ?? "—"),
        escapeHtml(l.acao) + (l.impersonado ? ' <span class="pill warn">suporte</span>' : ""),
        escapeHtml(l.ip ?? "—"),
      ]),
      vazio: "Nenhum registro para esta empresa.",
    });
  },
};
