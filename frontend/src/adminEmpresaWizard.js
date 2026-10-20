// Assistente de criação de empresa — 4 passos dentro do modal do painel.
//
// `abrirModal` (adminUi.js) é single-step por design: um botão de confirmar
// fixo que fecha o modal ao suceder. Um assistente de várias etapas precisa
// que "Avançar" NÃO feche o modal — então este arquivo não usa `abrirModal`,
// controla os mesmos nós do DOM diretamente (#adm-modal-titulo/body/foot) e
// só reaproveita `fecharModal` (para Cancelar/Esc/backdrop, que o listener
// global de adminUi.js já cobre via `data-fechar-modal`).
//
// Estado do assistente vive numa variável de módulo, não no DOM: trocar de
// passo reconstrói o HTML inteiro do corpo, então o que foi digitado só
// sobrevive se for lido para `estado` ANTES de render o próximo passo.

import { el, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { recarregarAdmin } from "./admin.js";
import {
  escapeHtml, fmtMoeda, campo, selecao, area, grade, valor, mostrarErroModal, fecharModal,
  STATUS_EMPRESA,
} from "./adminUi.js";

const PASSOS = ["empresa", "acessos", "modelo", "revisao"];
const ROTULO_PASSO = { empresa: "Empresa", acessos: "Acessos", modelo: "Modelo inicial", revisao: "Revisão" };

let estado = null;
let passoAtual = 0;
let catalogo = [];   // catálogo de módulos, cacheado por abertura do assistente
let modelos = [];    // empresas marcadas como Modelo Padrão (hoje, normalmente nenhuma)
let planosCache = [];

/** @param {Array<object>} planos já carregados pela view de Empresas */
export async function abrirAssistenteNovaEmpresa(planos = []) {
  estado = {
    nome: "", cnpj: "", responsavelNome: "", responsavelEmail: "", telefone: "", logoUrl: "",
    status: "teste", planoId: "", trialDias: "", unidadeNome: "", observacoes: "",
    modulos: new Set(), modeloOrigemId: "",
  };
  passoAtual = 0;
  planosCache = planos;

  el("#adm-modal-titulo").textContent = "Nova empresa";
  el("#adm-modal-body").innerHTML = `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
  el("#adm-modal-foot").innerHTML = `<button class="btn btn-ghost" data-fechar-modal>Cancelar</button>`;
  el("#adm-modal").hidden = false;

  try {
    const [catalogoRes, modelosRes] = await Promise.all([adminApi.modulos(), adminApi.empresasModelo()]);
    catalogo = catalogoRes.modulos ?? [];
    modelos = modelosRes ?? [];
  } catch (e) {
    el("#adm-modal-body").innerHTML = `<div class="estado erro"><span class="emoji">⚠️</span><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  renderPasso();
}

function renderPasso() {
  const passo = PASSOS[passoAtual];
  el("#adm-modal-titulo").textContent = `Nova empresa — ${passoAtual + 1}/${PASSOS.length} · ${ROTULO_PASSO[passo]}`;
  el("#adm-modal-body").innerHTML = CORPOS[passo]();
  el("#adm-modal-foot").innerHTML = rodape();
  ligarRodape();
}

function rodape() {
  const ultimo = passoAtual === PASSOS.length - 1;
  return `
    <button class="btn btn-ghost" data-fechar-modal>Cancelar</button>
    ${passoAtual > 0 ? `<button class="btn btn-ghost" id="wiz-voltar" type="button">← Voltar</button>` : ""}
    <button class="btn btn-primary" id="wiz-avancar" type="button">${ultimo ? "Criar e provisionar empresa" : "Avançar"}</button>`;
}

function ligarRodape() {
  el("#wiz-voltar")?.addEventListener("click", () => { passoAtual--; renderPasso(); });
  el("#wiz-avancar")?.addEventListener("click", aoAvancar);
}

async function aoAvancar() {
  try {
    lerPasso(PASSOS[passoAtual]);
  } catch (e) {
    mostrarErroModal(e.message);
    return;
  }

  if (passoAtual < PASSOS.length - 1) {
    passoAtual++;
    renderPasso();
    return;
  }

  const btn = el("#wiz-avancar");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Aguarde…";
  try {
    const criada = await adminApi.criarEmpresa({
      nome: estado.nome, cnpj: estado.cnpj || undefined,
      responsavelNome: estado.responsavelNome || undefined, responsavelEmail: estado.responsavelEmail || undefined,
      telefone: estado.telefone || undefined, logoUrl: estado.logoUrl || undefined,
      status: estado.status, planoId: estado.planoId || undefined,
      trialDias: estado.trialDias || undefined, unidadeNome: estado.unidadeNome || undefined,
      observacoes: estado.observacoes || undefined,
      modulos: [...estado.modulos], modeloOrigemId: estado.modeloOrigemId || undefined,
    });
    // A clonagem do catálogo do modelo não derruba a criação se falhar (a
    // empresa já existe nesse ponto) — mas o SuperAdmin precisa SABER que
    // faltou, em vez de só descobrir depois com um catálogo vazio sem
    // explicação. Dá pra reclonar na aba "Modelo Inicial" da empresa.
    toast(criada?.cloneErro
      ? `Empresa criada, mas a cópia do modelo falhou: ${criada.cloneErro}. Você pode tentar de novo na aba "Modelo Inicial".`
      : "Empresa criada.");
    fecharModal();
    recarregarAdmin();
  } catch (e) {
    mostrarErroModal(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** Grava no `estado` o que foi preenchido no passo atual. Lança se inválido. */
function lerPasso(passo) {
  if (passo === "empresa") {
    estado.nome = valor("e-nome");
    if (!estado.nome) throw new Error("Informe o nome da empresa.");
    estado.cnpj = valor("e-cnpj");
    estado.responsavelNome = valor("e-resp");
    estado.responsavelEmail = valor("e-email");
    estado.telefone = valor("e-tel");
    estado.logoUrl = valor("e-logo");
    estado.status = valor("e-status") || "teste";
    estado.planoId = valor("e-plano");
    estado.trialDias = valor("e-trial");
    estado.unidadeNome = valor("e-unidade");
    estado.observacoes = valor("e-obs");
  } else if (passo === "acessos") {
    estado.modulos = new Set([...document.querySelectorAll(".wiz-modulo:checked")].map((c) => c.value));
  } else if (passo === "modelo") {
    estado.modeloOrigemId = valor("e-modelo");
  }
  // "revisao" não lê nada — é só leitura do que já foi guardado.
}

// ---------------------------------------------------------------------------
// Corpo de cada passo
// ---------------------------------------------------------------------------

const CORPOS = {
  empresa: () => {
    const planos = planosCache.map((p) => ({ valor: p.id, rotulo: `${p.nome} · ${fmtMoeda(p.preco_mensal)}/mês` }));
    const status = Object.entries(STATUS_EMPRESA).map(([v, m]) => ({ valor: v, rotulo: m.rotulo }));
    return grade(
      campo({ id: "e-nome", label: "Nome da empresa", valor: estado.nome, obrigatorio: true }) +
      campo({ id: "e-cnpj", label: "CNPJ", valor: estado.cnpj, ph: "somente números" }) +
      campo({ id: "e-resp", label: "Responsável", valor: estado.responsavelNome }) +
      campo({ id: "e-email", label: "E-mail do responsável", valor: estado.responsavelEmail, tipo: "email" }) +
      campo({ id: "e-tel", label: "Telefone", valor: estado.telefone, ph: "DDD + número" }) +
      campo({ id: "e-logo", label: "URL da logo", valor: estado.logoUrl, ph: "https://…" }) +
      selecao({ id: "e-status", label: "Status inicial", opcoes: status, valor: estado.status }) +
      selecao({ id: "e-plano", label: "Plano", opcoes: planos, valor: estado.planoId, vazio: "Sem plano" }) +
      campo({ id: "e-trial", label: "Dias de teste", tipo: "number", valor: estado.trialDias, ph: "ex: 14", dica: "Deixe vazio para não definir prazo." }) +
      campo({ id: "e-unidade", label: "Nome da primeira unidade", valor: estado.unidadeNome, ph: "Matriz", dica: "Toda empresa nasce com uma unidade." }) +
      area({ id: "e-obs", label: "Observações", valor: estado.observacoes })
    );
  },

  acessos: () => {
    const grupo = (categoria, titulo) => {
      const itens = catalogo.filter((m) => m.categoria === categoria);
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
      <p class="adm-nota">Marque os módulos que esta empresa contratou. Nada aqui é definitivo — a lista pode ser
      ajustada depois na aba <b>Acessos</b> da empresa.</p>
      ${grupo("operacao", "Operação")}
      ${grupo("integracao", "Integrações")}
      ${grupo("financeiro", "Financeiro (acesso por concessão explícita)")}`;
  },

  modelo: () => {
    if (!modelos.length) {
      return `
        <p class="adm-nota">Nenhum Modelo Padrão cadastrado ainda — esta etapa fica disponível quando a
        funcionalidade de modelos for concluída. Pode avançar sem escolher nada.</p>`;
    }
    const opcoes = modelos.map((m) => ({ valor: m.id, rotulo: m.nome }));
    return grade(
      selecao({
        id: "e-modelo", label: "Modelo inicial", opcoes, valor: estado.modeloOrigemId, vazio: "Nenhum",
        dica: "Copia produtos, insumos e fichas técnicas do modelo pra dentro da empresa nova — são registros PRÓPRIOS dela, sem vínculo com o modelo depois.",
      })
    );
  },

  revisao: () => {
    const nomesModulos = catalogo.filter((m) => estado.modulos.has(m.id)).map((m) => m.nome);
    const modelo = modelos.find((m) => m.id === estado.modeloOrigemId);
    return `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Empresa</span><b>${escapeHtml(estado.nome)}</b></div>
        <div class="adm-det-linha"><span>Status inicial</span><b>${escapeHtml(STATUS_EMPRESA[estado.status]?.rotulo ?? estado.status)}</b></div>
        <div class="adm-det-linha"><span>Módulos habilitados</span><b>${nomesModulos.length}</b></div>
        <div class="adm-det-linha"><span>Modelo inicial</span><b>${escapeHtml(modelo?.nome ?? "nenhum")}</b></div>
      </div>
      ${nomesModulos.length
        ? `<ul class="adm-det-lista">${nomesModulos.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
        : `<div class="estado-mini">Nenhum módulo marcado — a empresa nasce sem acesso a nada até você liberar algo na aba Acessos.</div>`}`;
  },
};
