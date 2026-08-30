// Página de detalhe da unidade — Informações · Acessos · Usuários ·
// Dados/Configurações · Auditoria. Espelha adminEmpresaDetalhe.js de propósito.
//
// Não é uma TELA_ADMIN do menu lateral — abre a partir da lista de Unidades
// (ou da aba "Unidades" da página de uma empresa) e desenha direto em
// `#adm-view`. "← Unidades" volta pela navegação normal (`irParaAdmin`).
//
// FORA DE ESCOPO: aba "Modelo Inicial" — decisão registrada em conversa com
// o cliente (ver migration 034): o catálogo (produtos/insumos/ficha técnica)
// ainda não é isolado por unidade, é só por empresa.

import { el, escapeHtml, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { irParaAdmin } from "./admin.js";
import {
  campo, grade, valor, fmtDataHora, fmtRelativo, num, carregando, erro,
  tabela, abrirModal, mostrarErroModal,
} from "./adminUi.js";

const ABAS = [
  { id: "informacoes", label: "Informações" },
  { id: "acessos", label: "Acessos" },
  { id: "usuarios", label: "Usuários" },
  { id: "dados", label: "Dados/Configurações" },
  { id: "auditoria", label: "Auditoria" },
];

const ROTULO_METRICA = {
  usuarios: "Usuários vinculados", vendas: "Vendas", estoque: "Itens em estoque",
  lancamentosDashboardIfood: "Lançamentos — Dashboard iFood",
  bonificacaoLancamentos: "Lançamentos — Bonificação Mensal",
  martinBrowerIntegracoes: "Integrações Martin Brower", martinBrowerSincronizacoes: "Sincronizações Martin Brower",
};

let unidadeId = null;
let abaAtual = "informacoes";
/** Resultado de GET /plataforma/unidades/:id — recarregado a cada `renderPagina`. */
let unidadeCache = null;
/** Catálogo cru da aba Acessos — precisa sobreviver até o "Salvar acessos" pra reconstituir módulos "adormecidos" (ver `ligarAba`). */
let modulosAcessosCache = [];

/** @param {string} id @param {string} [aba] aba inicial (ex: "acessos", vindo do botão "Acessos" da listagem). */
export async function abrirPaginaUnidade(id, aba = "informacoes") {
  unidadeId = id;
  abaAtual = ABAS.some((a) => a.id === aba) ? aba : "informacoes";
  await renderPagina();
}

async function renderPagina() {
  const view = el("#adm-view");
  view.innerHTML = carregando();
  try {
    unidadeCache = await adminApi.unidade(unidadeId);
  } catch (e) {
    view.innerHTML = erro(e.message);
    return;
  }
  desenhar();
}

function desenhar() {
  const view = el("#adm-view");
  const u = unidadeCache;
  view.innerHTML = `
    <div class="adm-empresa-topo">
      <button class="btn btn-ghost btn-sm" id="ud-voltar" type="button">← Unidades</button>
      <h2 class="adm-empresa-nome">${escapeHtml(u.nome)} ${u.ativo ? '<span class="pill ok">Ativa</span>' : '<span class="pill muted">Inativa</span>'}</h2>
      ${u.empresa ? `<span class="adm-unidade-empresa-tag">🏢 ${escapeHtml(u.empresa.nome)}</span>` : ""}
    </div>
    <div class="adm-abas" role="tablist">
      ${ABAS.map((a) => `<button class="adm-aba ${a.id === abaAtual ? "ativo" : ""}" data-aba="${a.id}" type="button">${escapeHtml(a.label)}</button>`).join("")}
    </div>
    <div id="ud-corpo">${carregando()}</div>`;

  el("#ud-voltar").addEventListener("click", () => irParaAdmin("unidades"));
  view.querySelectorAll(".adm-aba").forEach((btn) =>
    btn.addEventListener("click", () => { abaAtual = btn.dataset.aba; desenhar(); }));

  renderAba();
}

async function renderAba() {
  const corpo = el("#ud-corpo");
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
    el("#ud-salvar-info")?.addEventListener("click", () => salvar(() => adminApi.atualizarUnidade(unidadeId, {
      nome: valor("ud-nome"), cnpj: valor("ud-cnpj"), cidade: valor("ud-cidade"), estado: valor("ud-estado"),
      endereco: valor("ud-endereco"), responsavel: valor("ud-resp"), email: valor("ud-email"), telefone: valor("ud-tel"),
      tabelaBalcao: valor("ud-tbalcao"), tabelaIfood: valor("ud-tifood"),
    }), "Informações atualizadas."));
  } else if (aba === "acessos") {
    el("#ud-salvar-acessos")?.addEventListener("click", () => {
      // Só os checkboxes VISÍVEIS E HABILITADOS (a empresa tem o módulo)
      // refletem a decisão do SuperAdmin agora. Módulos "adormecidos" —
      // habilitados na unidade num passado em que a empresa também os tinha,
      // mas que a empresa perdeu depois — aparecem desabilitados na tela
      // (nunca escondidos, por transparência) e por isso NUNCA entram no
      // :checked:not(:disabled); precisam ser somados de volta manualmente,
      // senão "Salvar" (mesmo sem tocar em nada) os apagaria de vez —
      // exatamente o "adormecido, não descartado" documentado em
      // backend/src/shared/modulos.js#definirModulosUnidade.
      const marcados = [...document.querySelectorAll(".ud-modulo:checked:not(:disabled)")].map((c) => c.value);
      const adormecidos = modulosAcessosCache.filter((m) => m.habilitado && !m.disponivelNaEmpresa).map((m) => m.id);
      const ids = [...new Set([...marcados, ...adormecidos])];
      return salvar(
        () => adminApi.definirModulosUnidade(unidadeId, ids),
        "Acessos atualizados — as sessões ativas desta unidade foram encerradas."
      );
    });
  } else if (aba === "dados") {
    el("#ud-status-toggle")?.addEventListener("click", () => {
      const ativo = unidadeCache.ativo;
      if (ativo && !confirm(`Desativar "${unidadeCache.nome}"? Isso encerra na hora todas as sessões abertas desta unidade.`)) return;
      const motivo = ativo ? (prompt("Motivo da desativação (opcional):") ?? "") : "";
      return salvar(
        () => adminApi.alterarStatusUnidade(unidadeId, !ativo, motivo || undefined),
        ativo ? "Unidade desativada." : "Unidade ativada."
      );
    });
    el("#ud-excluir")?.addEventListener("click", abrirExclusao);
  }
}

/** Item 8 do pedido: mostra o impacto ANTES de qualquer coisa. Recusa exclusão física se houver histórico operacional. */
async function abrirExclusao() {
  let impacto;
  try {
    impacto = await adminApi.impactoExclusaoUnidade(unidadeId);
  } catch (e) {
    toast("Erro: " + e.message);
    return;
  }

  const linhasImpacto = Object.entries(impacto.metricas)
    .map(([chave, valorMetrica]) => `<div class="adm-det-linha"><span>${escapeHtml(ROTULO_METRICA[chave] ?? chave)}</span><b>${num(valorMetrica)}</b></div>`)
    .join("");

  if (!impacto.exclusaoFisicaSegura) {
    abrirModal({
      titulo: `Excluir ${impacto.nome}`,
      corpo: `
        <div class="adm-aviso adm-aviso--perigo">
          Esta unidade tem histórico operacional — excluir apagaria tudo isso definitivamente.
          Use <b>"Desativar unidade"</b> (logo acima) para encerrar o acesso sem perder o histórico.
        </div>
        <div class="adm-det">${linhasImpacto}</div>`,
    });
    return;
  }

  abrirModal({
    titulo: `Excluir ${impacto.nome}`,
    perigo: true,
    corpo: `
      <div class="adm-aviso adm-aviso--perigo">
        Esta ação apaga a unidade permanentemente. <b>Não há como desfazer.</b>
      </div>
      <div class="adm-det">${linhasImpacto}</div>
      ${grade(campo({ id: "ud-ex-conf", label: "Digite o nome exato da unidade para confirmar", ph: impacto.nome, obrigatorio: true }))}`,
    confirmar: "Excluir definitivamente",
    aoConfirmar: async () => {
      // Validado TAMBÉM no servidor — este campo é só o aviso na frente disso.
      if (valor("ud-ex-conf") !== impacto.nome) {
        mostrarErroModal("O nome digitado não confere.");
        throw new Error("confirmação inválida");
      }
      await adminApi.excluirUnidade(unidadeId, impacto.nome);
      toast("Unidade excluída.");
      irParaAdmin("unidades");
    },
  });
}

// ---------------------------------------------------------------------------
// Corpo de cada aba
// ---------------------------------------------------------------------------

const CORPOS = {
  informacoes: async () => {
    const u = unidadeCache;
    return grade(
      campo({ id: "ud-nome", label: "Nome da unidade", valor: u.nome, obrigatorio: true }) +
      campo({ id: "ud-cnpj", label: "CNPJ", valor: u.cnpj, ph: "somente números" }) +
      campo({ id: "ud-cidade", label: "Cidade", valor: u.cidade }) +
      campo({ id: "ud-estado", label: "Estado (UF)", valor: u.estado, ph: "ex: MA" }) +
      campo({ id: "ud-endereco", label: "Endereço", valor: u.endereco }) +
      campo({ id: "ud-resp", label: "Responsável", valor: u.responsavel }) +
      campo({ id: "ud-email", label: "E-mail da loja", valor: u.email, tipo: "email" }) +
      campo({ id: "ud-tel", label: "Telefone", valor: u.telefone, ph: "DDD + número" }) +
      campo({ id: "ud-tbalcao", label: "Tabela de preço (balcão)", valor: u.tabelaBalcao, ph: "ex: A" }) +
      campo({ id: "ud-tifood", label: "Tabela de preço (iFood)", valor: u.tabelaIfood, ph: "ex: Z1" })
    ) + `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Empresa</span><b>${escapeHtml(u.empresa?.nome ?? "—")}</b></div>
        <div class="adm-det-linha"><span>Criada em</span><b>${escapeHtml(fmtDataHora(u.criadoEm))}</b></div>
        <div class="adm-det-linha"><span>Última atividade</span><b>${u.ultimaAtividade ? escapeHtml(fmtRelativo(u.ultimaAtividade)) : "sem registro"}</b></div>
      </div>
      <p class="adm-nota">Ativar/desativar e excluir ficam na aba "Dados/Configurações".</p>
      <div class="adm-secao-acoes adm-secao-acoes--fim">
        <button class="btn btn-primary btn-sm" id="ud-salvar-info" type="button">Salvar informações</button>
      </div>`;
  },

  acessos: async () => {
    const { modulos } = await adminApi.modulosDaUnidade(unidadeId);
    modulosAcessosCache = modulos;
    const adormecidos = modulos.filter((m) => m.habilitado && !m.disponivelNaEmpresa);

    const grupo = (categoria, titulo) => {
      const itens = modulos.filter((m) => m.categoria === categoria);
      if (!itens.length) return "";
      return `
        <fieldset class="adm-modulos-grupo">
          <legend>${escapeHtml(titulo)}</legend>
          ${itens.map((m) => `
            <label class="adm-assoc adm-assoc--check">
              <input type="checkbox" class="ud-modulo" value="${escapeHtml(m.id)}"
                ${m.habilitado ? "checked" : ""} ${!m.disponivelNaEmpresa ? "disabled" : ""} />
              <span class="adm-assoc-nome">${escapeHtml(m.nome)}</span>
              ${!m.disponivelNaEmpresa ? '<span class="pill muted">empresa não tem</span>' : ""}
            </label>`).join("")}
        </fieldset>`;
    };
    return `
      <p class="adm-nota">O acesso efetivo é sempre a interseção entre o que a empresa tem e o que a unidade tem —
      um módulo que a empresa não contratou não pode ser marcado aqui (libere na aba Acessos da empresa primeiro).
      Alterar aqui encerra as sessões ativas desta unidade — o próximo acesso já entra com os módulos novos.</p>
      ${adormecidos.length ? `<div class="adm-aviso">${adormecidos.length} módulo(s) ficaram indisponíveis porque a empresa não os tem mais — a preferência da unidade continua guardada e volta sozinha se a empresa reganhar o módulo.</div>` : ""}
      ${grupo("operacao", "Operação")}
      ${grupo("integracao", "Integrações")}
      <div class="adm-secao-acoes adm-secao-acoes--fim">
        <button class="btn btn-primary btn-sm" id="ud-salvar-acessos" type="button">Salvar acessos</button>
      </div>`;
  },

  usuarios: async () => {
    const usuarios = await adminApi.usuariosDaUnidade(unidadeId);
    const lista = usuarios.length
      ? usuarios.map((u) => `<li><b>${escapeHtml(u.nome ?? u.email ?? "—")}</b> — ${escapeHtml(u.papelRotulo)}
          ${u.vinculoAtivo ? "" : '<span class="pill bad">acesso bloqueado</span>'}</li>`).join("")
      : "<li>Nenhum usuário vinculado diretamente a esta unidade (pode haver usuários com acesso pela empresa toda).</li>";
    return `<ul class="adm-det-lista">${lista}</ul>`;
  },

  dados: async () => {
    const u = unidadeCache;
    const m = u.metricas;
    const rotuloModelo = { full_service: "Full Service", marketplace: "Marketplace" }[u.modeloLogisticoIfood] ?? "—";
    return `
      <div class="adm-det">
        <div class="adm-det-linha"><span>Status</span><b>${u.ativo ? "Ativa" : "Inativa"}</b></div>
        <div class="adm-det-linha"><span>Unidade de teste</span><b>${u.ehTeste ? "Sim" : "Não"}</b></div>
        <div class="adm-det-linha"><span>Modelo logístico iFood</span><b>${escapeHtml(rotuloModelo)}</b></div>
        <div class="adm-det-linha"><span>Vendas registradas</span><b>${num(m.vendas)}</b></div>
        <div class="adm-det-linha"><span>Lançamentos — Dashboard iFood</span><b>${num(m.lancamentosDashboardIfood)}</b></div>
        <div class="adm-det-linha"><span>Lançamentos — Bonificação Mensal</span><b>${num(m.bonificacaoLancamentos)}</b></div>
        <div class="adm-det-linha"><span>Sincronizações Martin Brower</span><b>${num(m.martinBrowerSincronizacoes)}</b></div>
      </div>
      <div class="adm-secao-acoes">
        <button class="btn btn-ghost btn-sm" id="ud-status-toggle" type="button">${u.ativo ? "Desativar unidade" : "Ativar unidade"}</button>
      </div>
      <div class="adm-zona-perigo">
        <b>Excluir permanentemente</b>
        <p>Só é permitido quando a unidade não tem histórico operacional (vendas, estoque, lançamentos, integrações).
        Havendo histórico, use "Desativar unidade" acima — preserva os dados e encerra o acesso.</p>
        <button class="btn btn-perigo btn-sm" id="ud-excluir" type="button">Excluir unidade</button>
      </div>`;
  },

  auditoria: async () => {
    const logs = await adminApi.logsDaUnidade(unidadeId, 100);
    return tabela({
      colunas: ["Quando", "Ator", "Ação", "IP"],
      linhas: logs.map((l) => [
        escapeHtml(fmtDataHora(l.em)), escapeHtml(l.atorEmail ?? "—"),
        escapeHtml(l.acao) + (l.impersonado ? ' <span class="pill warn">suporte</span>' : ""),
        escapeHtml(l.ip ?? "—"),
      ]),
      vazio: "Nenhum registro para esta unidade.",
    });
  },
};
