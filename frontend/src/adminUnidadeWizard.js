// Assistente de criação de unidade — 4 passos: Informações → Empresa
// responsável → Acessos → Revisão. Mesmo padrão de adminEmpresaWizard.js
// (ver lá o porquê de não usar `abrirModal`: "Avançar" não pode fechar o
// modal, e este controla os nós do DOM diretamente).
//
// FORA DE ESCOPO: passo "Modelo Inicial" — decisão registrada em conversa
// com o cliente (ver migration 034). Não existe hoje catálogo isolado por
// unidade pra esse passo clonar.
//
// Diferença-chave do passo "Acessos": só aparecem os módulos que a EMPRESA
// escolhida no passo anterior já tem contratado — a herança (item 4 do
// pedido) já nasce visível na criação, imposta também no backend
// (criarUnidade recusa qualquer módulo fora do que a empresa possui).

import { el, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { recarregarAdmin } from "./admin.js";
import { escapeHtml, campo, selecao, grade, valor, mostrarErroModal, fecharModal } from "./adminUi.js";

const PASSOS = ["informacoes", "empresa", "acessos", "revisao"];
const ROTULO_PASSO = { informacoes: "Informações", empresa: "Empresa responsável", acessos: "Acessos", revisao: "Revisão" };

let estado = null;
let passoAtual = 0;
let empresasCache = [];                // todas as empresas, pro seletor
let catalogoGeral = [];                // catálogo completo de módulos (rótulos/categorias)
let modulosDaEmpresaSelecionada = [];  // ids habilitados na empresa escolhida — recarregado ao trocar de empresa

/**
 * @param {Array<object>} empresas já carregadas pela view de Unidades
 * @param {string} [organizacaoIdInicial] pré-seleciona a empresa (ex: "+ Nova unidade" a partir da página da empresa)
 */
export async function abrirAssistenteNovaUnidade(empresas = [], organizacaoIdInicial = "") {
  estado = {
    nome: "", cnpj: "", cidade: "", estado: "", endereco: "", telefone: "",
    tabelaBalcao: "", tabelaIfood: "",
    organizacaoId: organizacaoIdInicial, modulos: new Set(),
  };
  passoAtual = 0;
  empresasCache = empresas;

  el("#adm-modal-titulo").textContent = "Nova unidade";
  el("#adm-modal-body").innerHTML = `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
  el("#adm-modal-foot").innerHTML = `<button class="btn btn-ghost" data-fechar-modal>Cancelar</button>`;
  el("#adm-modal").hidden = false;

  try {
    const catalogoRes = await adminApi.modulos();
    catalogoGeral = catalogoRes.modulos ?? [];
    if (estado.organizacaoId) await carregarModulosDaEmpresa(estado.organizacaoId);
  } catch (e) {
    el("#adm-modal-body").innerHTML = `<div class="estado erro"><span class="emoji">⚠️</span><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  renderPasso();
}

async function carregarModulosDaEmpresa(organizacaoId) {
  const resp = await adminApi.modulosDaEmpresa(organizacaoId);
  modulosDaEmpresaSelecionada = (resp.modulos ?? []).filter((m) => m.habilitado).map((m) => m.id);
  // "Herdar acessos da empresa" LIGADO por padrão: a unidade nova nasce com
  // todos os módulos que a empresa tem — o SuperAdmin só desmarca o que não
  // quiser antes de criar (mesmo espírito da Matriz, que herda automaticamente
  // na criação da empresa). Trocar de empresa redefine para o conjunto da
  // empresa nova, sem sobrar seleção "fantasma" da anterior.
  // O financeiro NUNCA é herdado por padrão: habilitá-lo numa unidade é escolha explícita (e só vale com concessão ao perfil).
  estado.modulos = new Set(modulosDaEmpresaSelecionada.filter((id) => id !== "gestao_financeira"));
}

function renderPasso() {
  const passo = PASSOS[passoAtual];
  el("#adm-modal-titulo").textContent = `Nova unidade — ${passoAtual + 1}/${PASSOS.length} · ${ROTULO_PASSO[passo]}`;
  el("#adm-modal-body").innerHTML = CORPOS[passo]();
  el("#adm-modal-foot").innerHTML = rodape();
  ligarRodape();
  ligarCorpo(passo);
}

/** Liga os controles que vivem no CORPO de um passo (o rodapé é `ligarRodape`). */
function ligarCorpo(passo) {
  if (passo !== "acessos") return;
  const marcar = (ligado) => {
    for (const c of document.querySelectorAll(".wiz-modulo")) c.checked = ligado && c.value !== "gestao_financeira";
    estado.modulos = new Set(ligado ? modulosDaEmpresaSelecionada.filter((id) => id !== "gestao_financeira") : []);
  };
  el("#wiz-modulos-todos")?.addEventListener("click", () => marcar(true));
  el("#wiz-modulos-nenhum")?.addEventListener("click", () => marcar(false));
}

function rodape() {
  const ultimo = passoAtual === PASSOS.length - 1;
  return `
    <button class="btn btn-ghost" data-fechar-modal>Cancelar</button>
    ${passoAtual > 0 ? `<button class="btn btn-ghost" id="wiz-voltar" type="button">← Voltar</button>` : ""}
    <button class="btn btn-primary" id="wiz-avancar" type="button">${ultimo ? "Criar e provisionar unidade" : "Avançar"}</button>`;
}

function ligarRodape() {
  el("#wiz-voltar")?.addEventListener("click", () => { passoAtual--; renderPasso(); });
  el("#wiz-avancar")?.addEventListener("click", aoAvancar);
}

async function aoAvancar() {
  const btn = el("#wiz-avancar");
  const original = btn.textContent;
  btn.disabled = true;

  try {
    await lerPasso(PASSOS[passoAtual]);
  } catch (e) {
    mostrarErroModal(e.message);
    btn.disabled = false;
    return;
  }

  if (passoAtual < PASSOS.length - 1) {
    passoAtual++;
    renderPasso(); // reconstrói o rodapé inteiro — o botão novo já nasce habilitado
    return;
  }

  btn.textContent = "Aguarde…";
  try {
    await adminApi.criarUnidade({
      nome: estado.nome, organizacaoId: estado.organizacaoId,
      cnpj: estado.cnpj || undefined, cidade: estado.cidade || undefined, estado: estado.estado || undefined,
      endereco: estado.endereco || undefined, telefone: estado.telefone || undefined,
      tabelaBalcao: estado.tabelaBalcao || undefined, tabelaIfood: estado.tabelaIfood || undefined,
      modulos: [...estado.modulos],
    });
    toast("Unidade criada.");
    fecharModal();
    recarregarAdmin();
  } catch (e) {
    mostrarErroModal(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** Grava no `estado` o que foi preenchido no passo atual. Lança se inválido. */
async function lerPasso(passo) {
  if (passo === "informacoes") {
    estado.nome = valor("u-nome");
    if (!estado.nome) throw new Error("Informe o nome da unidade.");
    estado.cnpj = valor("u-cnpj");
    estado.cidade = valor("u-cidade");
    estado.estado = valor("u-estado");
    estado.endereco = valor("u-endereco");
    estado.telefone = valor("u-tel");
    estado.tabelaBalcao = valor("u-tbalcao");
    estado.tabelaIfood = valor("u-tifood");
  } else if (passo === "empresa") {
    const organizacaoId = valor("u-empresa");
    if (!organizacaoId) throw new Error("Selecione a empresa responsável pela unidade.");
    if (organizacaoId !== estado.organizacaoId) {
      estado.organizacaoId = organizacaoId;
      await carregarModulosDaEmpresa(organizacaoId);
    }
  } else if (passo === "acessos") {
    estado.modulos = new Set([...document.querySelectorAll(".wiz-modulo:checked")].map((c) => c.value));
  }
  // "revisao" não lê nada — é só leitura do que já foi guardado.
}

// ---------------------------------------------------------------------------
// Corpo de cada passo
// ---------------------------------------------------------------------------

const CORPOS = {
  informacoes: () => grade(
    campo({ id: "u-nome", label: "Nome da unidade", valor: estado.nome, ph: "ex: Subway Timon-MA", obrigatorio: true }) +
    campo({ id: "u-cnpj", label: "CNPJ", valor: estado.cnpj, ph: "somente números" }) +
    campo({ id: "u-cidade", label: "Cidade", valor: estado.cidade, ph: "ex: Timon" }) +
    campo({ id: "u-estado", label: "Estado (UF)", valor: estado.estado, ph: "ex: MA" }) +
    campo({ id: "u-endereco", label: "Endereço", valor: estado.endereco }) +
    campo({ id: "u-tel", label: "Telefone", valor: estado.telefone, ph: "DDD + número" }) +
    campo({ id: "u-tbalcao", label: "Tabela de preço (balcão)", valor: estado.tabelaBalcao, ph: "ex: A" }) +
    campo({ id: "u-tifood", label: "Tabela de preço (iFood)", valor: estado.tabelaIfood, ph: "ex: Z1" })
  ),

  empresa: () => {
    if (!empresasCache.length) {
      return `<div class="estado-mini">Nenhuma empresa cadastrada ainda — crie uma empresa primeiro em Empresas → Nova empresa.</div>`;
    }
    const opcoes = empresasCache.map((e) => ({ valor: e.id, rotulo: e.nome }));
    return grade(
      selecao({
        id: "u-empresa", label: "Empresa responsável", opcoes, valor: estado.organizacaoId, vazio: "Selecione",
        dica: "Toda unidade pertence a exatamente uma empresa.",
      })
    );
  },

  acessos: () => {
    if (!modulosDaEmpresaSelecionada.length) {
      return `<div class="estado-mini">A empresa selecionada ainda não tem nenhum módulo contratado — não há o que
        habilitar para a unidade agora. Libere módulos na aba Acessos da empresa e volte aqui, ou avance sem marcar nada
        (dá pra habilitar depois na aba Acessos da unidade).</div>`;
    }
    const disponiveis = catalogoGeral.filter((m) => modulosDaEmpresaSelecionada.includes(m.id));
    const grupo = (categoria, titulo) => {
      const itens = disponiveis.filter((m) => m.categoria === categoria);
      if (!itens.length) return "";
      return `
        <fieldset class="adm-modulos-grupo">
          <legend>${escapeHtml(titulo)}</legend>
          ${itens.map((m) => `
            <label class="adm-assoc adm-assoc--check">
              <input type="checkbox" class="wiz-modulo" value="${escapeHtml(m.id)}" ${estado.modulos.has(m.id) ? "checked" : ""} />
              <span class="adm-assoc-nome">${escapeHtml(m.nome)}</span>
            </label>`).join("")}
        </fieldset>`;
    };
    return `
      <p class="adm-nota">A unidade <b>herda por padrão todos os módulos da empresa</b> — desmarque só o que esta
      unidade não deve ter. Só aparecem os módulos que a empresa já contratou (a unidade nunca pode ter mais que a
      própria empresa). Nada aqui é definitivo — ajustável depois na aba <b>Acessos</b> da unidade.</p>
      <div class="adm-modulos-acoes">
        <button type="button" class="btn btn-ghost btn-sm" id="wiz-modulos-todos">Herdar todos</button>
        <button type="button" class="btn btn-ghost btn-sm" id="wiz-modulos-nenhum">Limpar</button>
      </div>
      ${grupo("operacao", "Operação")}
      ${grupo("integracao", "Integrações")}
      ${grupo("financeiro", "Financeiro (acesso por concessão explícita)")}`;
  },

  revisao: () => {
    const empresa = empresasCache.find((e) => e.id === estado.organizacaoId);
    const nomesModulos = catalogoGeral.filter((m) => estado.modulos.has(m.id)).map((m) => m.nome);
    return `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Unidade</span><b>${escapeHtml(estado.nome)}</b></div>
        <div class="adm-det-linha"><span>Empresa</span><b>${escapeHtml(empresa?.nome ?? "—")}</b></div>
        <div class="adm-det-linha"><span>Cidade/UF</span><b>${escapeHtml([estado.cidade, estado.estado].filter(Boolean).join(" / ") || "—")}</b></div>
        <div class="adm-det-linha"><span>Módulos habilitados</span><b>${nomesModulos.length}</b></div>
      </div>
      ${nomesModulos.length
        ? `<ul class="adm-det-lista">${nomesModulos.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
        : `<div class="estado-mini">Nenhum módulo marcado — a unidade nasce sem acesso a nada até você liberar algo na aba Acessos.</div>`}`;
  },
};
