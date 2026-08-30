// As dez telas do Painel SuperAdmin.
//
// Padrão de cada view: renderiza "carregando", busca, e desenha ou mostra o
// erro. Nenhuma view guarda estado próprio além de um cache leve de listas
// auxiliares (empresas e planos, usados pelos seletores) — o resto vem do
// servidor a cada abertura, para o painel nunca mostrar um número velho.
//
// Ações vivem no mapa ACOES no fim do arquivo e são disparadas por delegação
// (`data-adm-acao`), o que mantém os listeners válidos depois de qualquer
// re-render.

import { el, toast, normalizarBusca } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { entrarComoEmpresa, recarregarAdmin, irParaAdmin } from "./admin.js";
import { abrirAssistenteNovaEmpresa } from "./adminEmpresaWizard.js";
import { abrirPaginaEmpresa } from "./adminEmpresaDetalhe.js";
import { abrirAssistenteNovaUnidade } from "./adminUnidadeWizard.js";
import { abrirPaginaUnidade } from "./adminUnidadeDetalhe.js";
import {
  num, pct, escapeHtml, fmtMoeda, fmtDataHora, fmtRelativo,
  STATUS_EMPRESA, STATUS_ASSINATURA, STATUS_COBRANCA, SITUACAO, pill,
  kpi, kpiGrade, secao, tabela, carregando, erro, vazio, barras,
  campo, selecao, area, grade, abrirModal, fecharModal, valor, mostrarErroModal,
} from "./adminUi.js";

/** Menu do painel. A ordem é a da especificação. */
export const TELAS_ADMIN = [
  { id: "dashboard",     label: "Dashboard Global",       icone: "📊", secao: "VISÃO GERAL" },
  { id: "estrutura",     label: "Estrutura Organizacional", icone: "🌳", secao: "GESTÃO" },
  { id: "empresas",      label: "Empresas",               icone: "🏢", secao: "GESTÃO" },
  { id: "unidades",      label: "Unidades",               icone: "🏬", secao: "GESTÃO" },
  { id: "usuarios",      label: "Usuários",               icone: "👥", secao: "GESTÃO" },
  { id: "financeiro",    label: "Financeiro do SaaS",     icone: "💰", secao: "GESTÃO" },
  { id: "monitoramento", label: "Monitoramento",          icone: "📡", secao: "OPERAÇÃO" },
  { id: "logs",          label: "Logs",                   icone: "📜", secao: "OPERAÇÃO" },
  { id: "auditoria",     label: "Auditoria",              icone: "🔎", secao: "OPERAÇÃO" },
  { id: "atualizacoes",  label: "Atualizações",           icone: "🚀", secao: "PLATAFORMA" },
  { id: "ia",            label: "IA",                     icone: "🤖", secao: "PLATAFORMA" },
  { id: "configuracoes", label: "Configurações Globais",  icone: "⚙️", secao: "PLATAFORMA" },
];

const view = () => el("#adm-view");

/** Caches de listas auxiliares — só o que alimenta seletores. */
const cache = { empresas: [], planos: [], papeis: [] };

/**
 * Rótulos do preview de impacto de exclusão de empresa — mesmo espírito do
 * ROTULO_METRICA de adminUnidadeDetalhe.js. [singular, plural]: "1 unidade"
 * lê melhor que "1 unidades" numa lista que é sempre lida em voz alta antes
 * de um clique destrutivo.
 */
const ROTULO_METRICA_EMPRESA = {
  unidades: ["Unidade", "Unidades"], usuarios: ["Usuário vinculado", "Usuários vinculados"],
  categorias: ["Categoria", "Categorias"], insumos: ["Insumo", "Insumos"], produtos: ["Produto", "Produtos"],
  lancamentosDashboardIfood: ["Lançamento — Dashboard Executivo", "Lançamentos — Dashboard Executivo"],
  bonificacaoLancamentos: ["Lançamento — Bonificação Mensal", "Lançamentos — Bonificação Mensal"],
  parserFdImportacoes: ["Importação — Parser Food Delivery", "Importações — Parser Food Delivery"],
  martinBrowerIntegracoes: ["Integração Martin Brower", "Integrações Martin Brower"],
  agenteConversas: ["Conversa — Agente Crescer", "Conversas — Agente Crescer"],
};
/** @param {string} chave @param {number} qtd */
const rotuloMetricaEmpresa = (chave, qtd) => {
  const par = ROTULO_METRICA_EMPRESA[chave];
  return par ? par[qtd === 1 ? 0 : 1] : chave;
};

/** @param {string} telaId */
export async function renderView(telaId) {
  const render = VIEWS[telaId] ?? VIEWS.dashboard;
  view().innerHTML = carregando();
  try {
    await render();
  } catch (e) {
    view().innerHTML = erro(e.message);
  }
}

// ===========================================================================
// 1. DASHBOARD GLOBAL
// ===========================================================================

async function viewDashboard() {
  const d = await adminApi.dashboard();

  const cartoes = [
    kpi({ label: "Empresas cadastradas", valor: num(d.empresas.total), sub: `${num(d.empresas.ativas)} ativas` }),
    kpi({ label: "Em teste", valor: num(d.empresas.teste), tom: "info" }),
    kpi({ label: "Bloqueadas", valor: num(d.empresas.bloqueadas), tom: d.empresas.bloqueadas > 0 ? "bad" : "" }),
    kpi({ label: "Suspensas", valor: num(d.empresas.suspensas) }),
    kpi({ label: "Usuários totais", valor: num(d.usuarios.total), sub: `${num(d.usuarios.ativos)} ativos` }),
    kpi({ label: "Usuários online", valor: num(d.usuarios.online), sub: `janela de ${d.operacao.janelaOnlineMin} min`, tom: "ok" }),
    kpi({ label: "Receita mensal (MRR)", valor: fmtMoeda(d.financeiro.mrr), sub: `ARR ${fmtMoeda(d.financeiro.arr)}` }),
    kpi({ label: "Inadimplentes", valor: num(d.empresas.inadimplentes), sub: `${fmtMoeda(d.financeiro.aReceber)} em atraso`, tom: d.empresas.inadimplentes > 0 ? "bad" : "" }),
    kpi({ label: "Integrações ativas", valor: num(d.operacao.integracoesAtivas) }),
    kpi({ label: "Unidades", valor: num(d.operacao.unidades) }),
    kpi({ label: "Churn (30 dias)", valor: pct(d.financeiro.churnPct) }),
    kpi({ label: "Acessos negados", valor: num(d.errosCriticos.acessosNegados), tom: d.errosCriticos.acessosNegados > 0 ? "warn" : "" }),
    kpi({ label: "Uso do banco", valor: "—", indisponivel: d.recursos.banco }),
    kpi({ label: "Uso do Storage", valor: "—", indisponivel: d.recursos.storage }),
    kpi({ label: "Uso da API", valor: "—", indisponivel: d.recursos.api }),
  ].join("");

  const logins = tabela({
    colunas: ["Usuário", "Evento", "Quando", "IP"],
    linhas: d.ultimosLogins.map((l) => [
      escapeHtml(l.email ?? "—"),
      escapeHtml(rotuloEvento(l.acao)),
      `<span title="${escapeHtml(fmtDataHora(l.em))}">${escapeHtml(fmtRelativo(l.em))}</span>`,
      escapeHtml(l.ip ?? "—"),
    ]),
    vazio: "Nenhum acesso registrado ainda.",
  });

  const erros = d.errosCriticos.itens.length
    ? tabela({
        colunas: ["Usuário", "Motivo", "Quando"],
        linhas: d.errosCriticos.itens.map((i) => [
          escapeHtml(i.email ?? "—"),
          escapeHtml(i.detalhes?.motivo ?? "—"),
          escapeHtml(fmtRelativo(i.em)),
        ]),
      })
    : `<div class="estado-mini">Nenhum acesso negado registrado. ${escapeHtml(d.errosCriticos.observacao)}</div>`;

  view().innerHTML =
    kpiGrade(cartoes) +
    secao({
      titulo: "Crescimento",
      corpo: `<div class="adm-graficos">
        ${barras(d.crescimento.empresas, "Empresas criadas por mês")}
        ${barras(d.crescimento.usuarios, "Usuários criados por mês")}
      </div>`,
    }) +
    secao({ titulo: "Últimos acessos", corpo: logins }) +
    secao({
      titulo: "Erros críticos",
      nota: d.errosCriticos.observacao,
      corpo: erros,
    });
}

function rotuloEvento(acao) {
  return {
    "sessao.contexto_selecionado": "Entrou na empresa",
    "sessao.contexto_trocado": "Trocou de unidade",
    "impersonacao.iniciada": "SuperAdmin entrou como empresa",
  }[acao] ?? acao;
}

// ===========================================================================
// 2. EMPRESAS
// ===========================================================================

async function viewEmpresas() {
  const [empresas, planos] = await Promise.all([adminApi.empresas(), adminApi.planos()]);
  cache.empresas = empresas;
  cache.planos = planos;

  const linhas = empresas.map((e) => [
    `<div class="adm-cel-empresa">
       ${e.logoUrl ? `<img src="${escapeHtml(e.logoUrl)}" alt="" class="adm-logo" />`
                   : `<span class="adm-logo adm-logo--txt">${escapeHtml((e.nome[0] || "?").toUpperCase())}</span>`}
       <span><b>${escapeHtml(e.nome)}</b><small>${escapeHtml(e.responsavelEmail ?? e.cnpj ?? "—")}</small></span>
     </div>`,
    pill(STATUS_EMPRESA, e.status),
    escapeHtml(e.plano?.nome ?? "—"),
    num(e.unidades),
    num(e.usuarios),
    `<span title="${escapeHtml(fmtDataHora(e.criadoEm))}">${escapeHtml(fmtRelativo(e.criadoEm))}</span>`,
    acoesEmpresa(e),
  ]);

  view().innerHTML = secao({
    titulo: `Empresas (${empresas.length})`,
    acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="empresa-nova">+ Nova empresa</button>`,
    corpo: tabela({
      colunas: ["Empresa", "Status", "Plano", "Unidades", "Usuários", "Criada", "Ações"],
      linhas,
      vazio: "Nenhuma empresa cadastrada.",
    }),
  });
}

/** @param {object} e */
function acoesEmpresa(e) {
  const d = `data-id="${escapeHtml(e.id)}" data-nome="${escapeHtml(e.nome)}"`;
  return `<div class="adm-acoes-cel">
    <button class="btn btn-ghost btn-sm" data-adm-acao="empresa-ver" ${d}>Detalhes</button>
    <button class="btn btn-primary btn-sm" data-adm-acao="empresa-entrar" ${d}>Entrar</button>
    <button class="btn btn-ghost btn-sm" data-adm-acao="empresa-menu" ${d} data-status="${escapeHtml(e.status)}">⋯</button>
  </div>`;
}

// Detalhe de empresa (Informações/Acessos/Unidades/Usuários/Modelo/Auditoria)
// virou uma página própria — ver adminEmpresaDetalhe.js — em vez do modal
// único que existia aqui. O formulário de criação de empresa também saiu
// daqui (assistente de 4 passos, ver adminEmpresaWizard.js).

// ===========================================================================
// 2b. UNIDADES — gerenciamento completo (item 1 do pedido). Antes, uma
// unidade era só um registro filho mostrado numa lista morta dentro da
// página da empresa; agora tem área própria, com o mesmo nível de
// gerenciamento que Empresa já tinha (ver adminUnidadeWizard.js/
// adminUnidadeDetalhe.js).
// ===========================================================================

let filtrosUnidades = { busca: "", status: "", organizacaoId: "" };

async function viewUnidades() {
  const [unidades, empresas] = await Promise.all([
    adminApi.unidades(filtrosUnidades), adminApi.empresas(),
  ]);
  cache.empresas = empresas;

  const barraFiltros = `
    <div class="adm-filtros">
      ${campo({ id: "un-busca", label: "Buscar", valor: filtrosUnidades.busca, ph: "nome, CNPJ, cidade…" })}
      ${selecao({ id: "un-empresa", label: "Empresa", valor: filtrosUnidades.organizacaoId, vazio: "Todas",
        opcoes: empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) })}
      ${selecao({ id: "un-status", label: "Status", valor: filtrosUnidades.status, vazio: "Todos",
        opcoes: [{ valor: "ativa", rotulo: "Ativa" }, { valor: "inativa", rotulo: "Inativa" }] })}
      <div class="adm-filtros-acoes">
        <button class="btn btn-primary btn-sm" data-adm-acao="unidades-filtrar">Filtrar</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="unidades-limpar">Limpar</button>
      </div>
    </div>`;

  const linhas = unidades.map((u) => [
    `<div class="adm-cel-empresa">
       <span class="adm-logo adm-logo--txt">${escapeHtml((u.nome[0] || "?").toUpperCase())}</span>
       <span><b>${escapeHtml(u.nome)}</b><small>${escapeHtml([u.cidade, u.estado].filter(Boolean).join("/") || u.cnpj || "—")}</small></span>
     </div>`,
    escapeHtml(u.empresa?.nome ?? "—"),
    u.ativo ? '<span class="pill ok">Ativa</span>' : '<span class="pill muted">Inativa</span>',
    num(u.modulosAtivos),
    num(u.usuarios),
    u.ultimaAtividade
      ? `<span title="${escapeHtml(fmtDataHora(u.ultimaAtividade))}">${escapeHtml(fmtRelativo(u.ultimaAtividade))}</span>`
      : '<span class="estado-mini">sem registro</span>',
    acoesUnidade(u),
  ]);

  view().innerHTML = secao({
    titulo: `Unidades (${unidades.length})`,
    acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="unidade-nova">+ Nova unidade</button>`,
    corpo: barraFiltros + tabela({
      colunas: ["Unidade", "Empresa", "Status", "Módulos ativos", "Usuários", "Última atividade", "Ações"],
      linhas,
      vazio: "Nenhuma unidade encontrada para os filtros escolhidos.",
    }),
  });
}

/** @param {object} u */
function acoesUnidade(u) {
  const d = `data-id="${escapeHtml(u.id)}" data-nome="${escapeHtml(u.nome)}"`;
  return `<div class="adm-acoes-cel">
    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-ver" ${d}>Visualizar</button>
    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-editar" ${d} data-cnpj="${escapeHtml(u.cnpj ?? "")}" data-cidade="${escapeHtml(u.cidade ?? "")}" data-estado="${escapeHtml(u.estado ?? "")}" data-endereco="${escapeHtml(u.endereco ?? "")}" data-telefone="${escapeHtml(u.telefone ?? "")}">Editar</button>
    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-acessos" ${d}>Acessos</button>
    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-status" ${d} data-ativo="${u.ativo ? "1" : ""}">${u.ativo ? "Desativar" : "Ativar"}</button>
  </div>`;
}

// ===========================================================================
// 2c. ESTRUTURA ORGANIZACIONAL — mesmos dados de Empresas/Unidades (nenhum
// endpoint novo), só numa árvore: Empresa > Unidades, com busca instantânea.
// As telas "Empresas" e "Unidades" continuam existindo (listas filtráveis,
// úteis pra outra tarefa) — esta é a visão de hierarquia que faltava.
// ===========================================================================

async function viewEstrutura() {
  const [empresas, unidades] = await Promise.all([adminApi.empresas(), adminApi.unidades({})]);
  cache.empresas = empresas;

  const unidadesPorEmpresa = new Map();
  for (const u of unidades) {
    const orgId = u.empresa?.id ?? u.organizacaoId;
    if (!unidadesPorEmpresa.has(orgId)) unidadesPorEmpresa.set(orgId, []);
    unidadesPorEmpresa.get(orgId).push(u);
  }
  const grupos = empresas.map((e) => ({ empresa: e, unidades: unidadesPorEmpresa.get(e.id) ?? [] }));

  // Só uma empresa no total: abrir ela de cara não custa nada e poupa um clique.
  const expandido = new Set(grupos.length === 1 ? grupos.map((g) => g.empresa.id) : []);

  view().innerHTML = secao({
    titulo: "Estrutura Organizacional",
    acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="empresa-nova">+ Nova empresa</button>`,
    corpo: `
      <div class="sel-busca-wrap adm-estr-busca" ${empresas.length > 4 ? "" : "hidden"}>
        <span class="sel-busca-ic">🔎</span>
        <input id="est-busca" type="search" class="sel-busca" autocomplete="off"
               placeholder="Pesquisar empresa ou unidade..." aria-label="Pesquisar empresa ou unidade" />
      </div>
      <div id="est-arvore" class="adm-arvore"></div>`,
  });

  function corresponde(nomeEmpresa, u, termo) {
    if (!termo) return true;
    const alvo = [nomeEmpresa, u?.nome, u?.cidade, u?.cnpj].filter(Boolean).map(normalizarBusca).join(" | ");
    return alvo.includes(termo);
  }

  function render() {
    const termo = normalizarBusca(el("#est-busca")?.value.trim() ?? "");
    const filtrados = grupos
      .map((g) => ({
        empresa: g.empresa,
        unidades: termo ? g.unidades.filter((u) => corresponde(g.empresa.nome, u, termo)) : g.unidades,
        empresaCasa: corresponde(g.empresa.nome, null, termo),
      }))
      .filter((g) => g.empresaCasa || g.unidades.length);

    const arvore = el("#est-arvore");
    if (!filtrados.length) {
      arvore.innerHTML = vazio(`Nenhuma empresa ou unidade encontrada para "${el("#est-busca").value.trim()}".`);
      return;
    }

    arvore.innerHTML = filtrados.map((g) => {
      const e = g.empresa;
      const logo = e.logoUrl
        ? `<img src="${escapeHtml(e.logoUrl)}" alt="" class="adm-logo" />`
        : `<span class="adm-logo adm-logo--txt">${escapeHtml((e.nome[0] || "?").toUpperCase())}</span>`;
      const aberto = termo ? true : expandido.has(e.id);
      const d = `data-id="${escapeHtml(e.id)}" data-nome="${escapeHtml(e.nome)}"`;

      return `
        <div class="adm-arvore-emp ${aberto ? "adm-arvore-emp--aberta" : ""}">
          <div class="adm-arvore-emp-cab">
            <button type="button" class="adm-arvore-toggle" data-toggle-est="${escapeHtml(e.id)}"
                    aria-expanded="${aberto}" ${g.unidades.length ? "" : "disabled"}>
              <span class="adm-arvore-seta" aria-hidden="true">▾</span>
            </button>
            <div class="adm-cel-empresa">
              ${logo}
              <span><b>${escapeHtml(e.nome)}</b><small>${g.unidades.length} unidade${g.unidades.length === 1 ? "" : "s"}</small></span>
            </div>
            ${pill(STATUS_EMPRESA, e.status)}
            <div class="adm-acoes-cel adm-arvore-emp-acoes">
              <button class="btn btn-ghost btn-sm" data-adm-acao="empresa-ver" ${d}>Detalhes</button>
              <button class="btn btn-primary btn-sm" data-adm-acao="empresa-entrar" ${d}>Entrar</button>
              <button class="btn btn-ghost btn-sm" data-adm-acao="empresa-menu" ${d} data-status="${escapeHtml(e.status)}">⋯</button>
            </div>
          </div>
          <div class="adm-arvore-uni-lista" ${aberto ? "" : "hidden"}>
            ${g.unidades.length ? g.unidades.map((u) => {
              const du = `data-id="${escapeHtml(u.id)}" data-nome="${escapeHtml(u.nome)}" data-org="${escapeHtml(e.id)}" data-empresa="${escapeHtml(e.nome)}"`;
              return `
                <div class="adm-arvore-uni">
                  <span class="adm-logo adm-logo--txt adm-arvore-uni-logo">${escapeHtml((u.nome[0] || "?").toUpperCase())}</span>
                  <span class="adm-arvore-uni-info">
                    <b>${escapeHtml(u.nome)}</b>
                    <small>${escapeHtml([u.cidade, u.estado].filter(Boolean).join("/") || u.cnpj || "—")}</small>
                  </span>
                  ${u.ativo ? '<span class="pill ok">Ativa</span>' : '<span class="pill muted">Inativa</span>'}
                  <div class="adm-acoes-cel">
                    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-ver" ${du}>Visualizar</button>
                    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-acessos" ${du}>Acessos</button>
                    <button class="btn btn-ghost btn-sm" data-adm-acao="unidade-estrutura-menu" ${du}>⋮</button>
                  </div>
                </div>`;
            }).join("") : `<div class="estado-mini adm-arvore-uni-vazia">Nenhuma unidade cadastrada nesta empresa ainda.</div>`}
          </div>
        </div>`;
    }).join("");
  }

  el("#est-arvore").onclick = (e) => {
    const toggle = e.target.closest("[data-toggle-est]");
    if (!toggle || toggle.disabled) return;
    const id = toggle.dataset.toggleEst;
    if (expandido.has(id)) expandido.delete(id); else expandido.add(id);
    render();
  };
  const busca = el("#est-busca");
  if (busca) busca.oninput = render;

  render();
}

// ===========================================================================
// 3. USUÁRIOS GLOBAIS + ASSOCIAÇÃO
// ===========================================================================

async function viewUsuarios() {
  const [usuarios, empresas, papeis] = await Promise.all([
    adminApi.usuarios(), adminApi.empresas(), adminApi.papeis(),
  ]);
  cache.empresas = empresas;
  cache.papeis = papeis;

  const semEmpresa = usuarios.filter((u) => !u.empresas.some((x) => x.ativo) && !u.superadmin);

  const linhas = usuarios.map((u) => [
    `<div class="adm-cel-empresa">
       <span class="adm-logo adm-logo--txt">${escapeHtml(((u.nome || u.email || "?")[0]).toUpperCase())}</span>
       <span><b>${escapeHtml(u.nome ?? "—")}</b><small>${escapeHtml(u.email ?? "—")}</small></span>
     </div>`,
    u.superadmin ? '<span class="pill warn">SuperAdmin</span>' : (u.ativo ? '<span class="pill ok">Ativo</span>' : '<span class="pill bad">Bloqueado</span>'),
    u.online ? '<span class="pill ok">Online</span>' : '<span class="pill muted">Offline</span>',
    u.empresas.length
      ? u.empresas.map((x) => `<span class="adm-tag ${x.ativo ? "" : "adm-tag--off"}" title="${escapeHtml(x.papelRotulo)}">${escapeHtml(x.empresaNome)}</span>`).join(" ")
      : '<span class="pill muted">nenhuma</span>',
    `<div class="adm-acoes-cel">
       <button class="btn btn-primary btn-sm" data-adm-acao="usuario-associar" data-id="${escapeHtml(u.id)}" data-nome="${escapeHtml(u.nome ?? u.email ?? "")}">Associar</button>
       <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-ver" data-id="${escapeHtml(u.id)}">Detalhes</button>
     </div>`,
  ]);

  const aviso = semEmpresa.length
    ? `<div class="adm-aviso">
        <b>${semEmpresa.length} usuário(s) sem empresa associada.</b>
        Após a virada da arquitetura multiempresa, todos os vínculos antigos foram zerados —
        estes acessos precisam ser recriados aqui.
       </div>`
    : "";

  view().innerHTML = aviso + secao({
    titulo: `Usuários (${usuarios.length})`,
    acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="usuario-novo">+ Novo usuário</button>`,
    nota: "O login pertence ao usuário; as empresas são associadas a ele. O cargo pertence a cada associação — o mesmo usuário pode ser Administrador em uma empresa e Financeiro em outra.",
    corpo: tabela({
      colunas: ["Usuário", "Conta", "Sessão", "Empresas", "Ações"],
      linhas,
      vazio: "Nenhum usuário cadastrado.",
    }),
  });
}

function formUsuario() {
  const papeis = cache.papeis.map((p) => ({ valor: p.valor, rotulo: p.rotulo }));
  const empresas = cache.empresas.map((e) => `
    <label class="adm-assoc">
      <input type="checkbox" class="u-emp-chk" data-org="${escapeHtml(e.id)}" />
      <span class="adm-assoc-nome">${escapeHtml(e.nome)} ${pill(STATUS_EMPRESA, e.status)}</span>
      <select class="u-emp-papel" data-org="${escapeHtml(e.id)}">
        ${papeis.map((p) => `<option value="${escapeHtml(p.valor)}" ${p.valor === "operations" ? "selected" : ""}>${escapeHtml(p.rotulo)}</option>`).join("")}
      </select>
    </label>`).join("");

  return grade(
    campo({ id: "u-nome", label: "Nome", obrigatorio: true }) +
    campo({ id: "u-email", label: "E-mail", tipo: "email", obrigatorio: true }) +
    campo({ id: "u-senha", label: "Senha", tipo: "text", ph: "mínimo 8 caracteres", obrigatorio: true, dica: "Anote e repasse — a conta já pode fazer login." })
  ) + `
    <h3 class="adm-det-tit">Empresas e cargos</h3>
    <p class="adm-nota">Marque as empresas que este usuário poderá acessar e o cargo em cada uma.</p>
    <div class="adm-assoc-lista">${empresas || '<div class="estado-mini">Nenhuma empresa cadastrada ainda.</div>'}</div>`;
}

/** Lê as empresas marcadas no formulário de usuário. */
function lerEmpresasMarcadas() {
  return [...document.querySelectorAll(".u-emp-chk")]
    .filter((c) => c.checked)
    .map((c) => ({
      organizacaoId: c.dataset.org,
      papel: document.querySelector(`.u-emp-papel[data-org="${c.dataset.org}"]`)?.value,
    }));
}

async function abrirDetalheUsuario(id) {
  const u = await adminApi.usuario(id);
  const papeis = cache.papeis.length ? cache.papeis : await adminApi.papeis();
  cache.papeis = papeis;
  if (!cache.empresas.length) cache.empresas = await adminApi.empresas();

  const vinculos = u.empresas.length
    ? u.empresas.map((x) => `
      <div class="adm-vinculo">
        <span class="adm-vinculo-nome"><b>${escapeHtml(x.empresaNome)}</b>${pill(STATUS_EMPRESA, x.empresaStatus ?? "ativa")}</span>
        <select class="adm-vinculo-papel" data-adm-acao="vinculo-papel" data-usuario="${escapeHtml(u.id)}" data-org="${escapeHtml(x.organizacaoId)}">
          ${papeis.map((p) => `<option value="${escapeHtml(p.valor)}" ${p.valor === x.papel ? "selected" : ""}>${escapeHtml(p.rotulo)}</option>`).join("")}
        </select>
        <button class="btn btn-ghost btn-sm" data-adm-acao="vinculo-toggle"
                data-usuario="${escapeHtml(u.id)}" data-org="${escapeHtml(x.organizacaoId)}" data-ativo="${x.ativo}">
          ${x.ativo ? "Bloquear" : "Liberar"}
        </button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="vinculo-remover"
                data-usuario="${escapeHtml(u.id)}" data-org="${escapeHtml(x.organizacaoId)}" data-nome="${escapeHtml(x.empresaNome)}">Remover</button>
      </div>`).join("")
    : '<div class="estado-mini">Nenhuma empresa associada.</div>';

  const vinculosUnidade = u.unidades.length
    ? u.unidades.map((x) => `
      <div class="adm-vinculo">
        <span class="adm-vinculo-nome"><b>${escapeHtml(x.unidadeNome)}</b>${x.ativo ? "" : '<span class="pill bad">bloqueado</span>'}</span>
        <select class="adm-vinculo-papel" data-adm-acao="vinculo-unidade-papel" data-usuario="${escapeHtml(u.id)}" data-unidade="${escapeHtml(x.unidadeId)}">
          <option value="">Herdar da empresa</option>
          ${papeis.map((p) => `<option value="${escapeHtml(p.valor)}" ${p.valor === x.papel ? "selected" : ""}>${escapeHtml(p.rotulo)}</option>`).join("")}
        </select>
        <button class="btn btn-ghost btn-sm" data-adm-acao="vinculo-unidade-toggle"
                data-usuario="${escapeHtml(u.id)}" data-unidade="${escapeHtml(x.unidadeId)}" data-ativo="${x.ativo}">
          ${x.ativo ? "Bloquear" : "Liberar"}
        </button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="vinculo-unidade-remover"
                data-usuario="${escapeHtml(u.id)}" data-unidade="${escapeHtml(x.unidadeId)}" data-nome="${escapeHtml(x.unidadeNome)}">Remover</button>
      </div>`).join("")
    : '<div class="estado-mini">Nenhuma unidade associada — sem isso, o usuário só entra na visão agregada "todas as unidades" da empresa, nunca numa unidade específica.</div>';

  const sessoes = tabela({
    colunas: ["Empresa", "Cargo", "Início", "Último uso", "Situação"],
    linhas: u.sessoes.map((s) => [
      escapeHtml(s.empresa ?? "—"), escapeHtml(s.papel),
      escapeHtml(fmtDataHora(s.criadaEm)), escapeHtml(fmtRelativo(s.ultimoUso)),
      s.viva ? '<span class="pill ok">viva</span>' : '<span class="pill muted">encerrada</span>',
    ]),
    vazio: "Nenhuma sessão registrada.",
  });

  const historico = tabela({
    colunas: ["Ação", "Quando", "IP"],
    linhas: u.historico.map((h) => [escapeHtml(h.acao), escapeHtml(fmtRelativo(h.em)), escapeHtml(h.ip ?? "—")]),
    vazio: "Nenhuma ação registrada.",
  });

  const dId = `data-id="${escapeHtml(u.id)}" data-nome="${escapeHtml(u.nome ?? u.email ?? "")}"`;

  abrirModal({
    titulo: u.nome ?? u.email ?? "Usuário",
    corpo: `
      ${u.emailDivergente ? `
        <div class="adm-aviso">
          <b>E-mail de login diferente do cadastro.</b>
          O login desta conta é <b>${escapeHtml(u.emailLogin)}</b>, mas o cadastro exibe
          <b>${escapeHtml(u.email ?? "—")}</b>. Só o e-mail de login funciona para entrar.
          Use “Alterar e-mail” para sincronizar os dois.
        </div>` : ""}
      <div class="adm-det">
        <div class="adm-det-linha"><span>E-mail de login</span><b>${escapeHtml(u.emailLogin ?? u.email ?? "—")}</b></div>
        ${u.emailDivergente ? `<div class="adm-det-linha"><span>E-mail no cadastro</span><b>${escapeHtml(u.email ?? "—")}</b></div>` : ""}
        <div class="adm-det-linha"><span>Conta</span>${u.ativo ? '<span class="pill ok">Ativa</span>' : '<span class="pill bad">Bloqueada</span>'}</div>
        <div class="adm-det-linha"><span>SuperAdmin</span>${u.superadmin ? '<span class="pill warn">Sim</span>' : '<span class="pill muted">Não</span>'}</div>
        <div class="adm-det-linha"><span>Último login</span><b>${u.ultimoLogin ? escapeHtml(fmtDataHora(u.ultimoLogin)) : "nunca"}</b></div>
        <div class="adm-det-linha"><span>Criado em</span><b>${escapeHtml(fmtDataHora(u.criadoEm))}</b></div>
      </div>

      <div class="adm-det-acoes">
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-associar" ${dId}>+ Associar empresa</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-associar-unidade" ${dId}>+ Associar unidade</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-senha" ${dId}>Redefinir senha</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-email" ${dId} data-email="${escapeHtml(u.emailLogin ?? u.email ?? "")}">Alterar e-mail</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-logout" ${dId}>Forçar logout</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-toggle" ${dId} data-ativo="${u.ativo}">${u.ativo ? "Bloquear conta" : "Reativar conta"}</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="usuario-super" ${dId} data-super="${u.superadmin}">${u.superadmin ? "Revogar SuperAdmin" : "Tornar SuperAdmin"}</button>
        <button class="btn btn-perigo btn-sm" data-adm-acao="usuario-excluir" ${dId}>Excluir conta</button>
      </div>

      <h3 class="adm-det-tit">Empresas associadas</h3>
      <div class="adm-vinculos">${vinculos}</div>

      <h3 class="adm-det-tit">Unidades associadas</h3>
      <div class="adm-vinculos">${vinculosUnidade}</div>

      <h3 class="adm-det-tit">Sessões</h3>${sessoes}
      <h3 class="adm-det-tit">Histórico</h3>${historico}`,
  });
}

// ---------------------------------------------------------------------------
// Modal "Associar empresas" — visão completa dos vínculos do usuário:
//   * Vínculos atuais  -> editar cargo (explícito, via atualizarVinculo);
//   * Adicionar acesso -> selecionar N empresas NÃO associadas de uma vez,
//     com "mesmo cargo em todas" ou cargo individual (via lote, atômico).
// Nunca remove vínculo. Nunca altera cargo existente sem o usuário mexer no
// seletor daquele vínculo.
// ---------------------------------------------------------------------------
async function abrirModalAssociarEmpresas(id, nome) {
  const [detalhe, empresas, papeis] = await Promise.all([
    adminApi.usuario(id),
    cache.empresas.length ? cache.empresas : adminApi.empresas().then((r) => (cache.empresas = r)),
    cache.papeis.length ? cache.papeis : adminApi.papeis().then((r) => (cache.papeis = r)),
  ]);

  const papelPorOrg = new Map((detalhe.empresas || []).map((v) => [v.organizacaoId, v]));
  const associadas = (detalhe.empresas || []).slice()
    .sort((a, b) => a.empresaNome.localeCompare(b.empresaNome, "pt-BR"));
  const disponiveis = empresas
    .filter((e) => !papelPorOrg.has(e.id))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const opcoesPapel = (sel) => papeis
    .map((p) => `<option value="${escapeHtml(p.valor)}" ${p.valor === sel ? "selected" : ""}>${escapeHtml(p.rotulo)}</option>`).join("");

  const linhaAtual = (v) => `
    <div class="adm-assoc adm-assoc--atual" data-nome="${escapeHtml(v.empresaNome.toLowerCase())}">
      <span class="adm-assoc-nome">✓ <b>${escapeHtml(v.empresaNome)}</b>
        <span class="pill ok">Associado</span>${v.ativo ? "" : '<span class="pill bad">bloqueado</span>'}</span>
      <select class="assoc-cargo-atual" data-org="${escapeHtml(v.organizacaoId)}" data-original="${escapeHtml(v.papel)}">
        ${opcoesPapel(v.papel)}
      </select>
      <small class="assoc-flag-alterado" hidden>cargo alterado</small>
    </div>`;

  const linhaNova = (e) => `
    <label class="adm-assoc adm-assoc--nova" data-nome="${escapeHtml(e.nome.toLowerCase())}">
      <input type="checkbox" class="assoc-chk" data-org="${escapeHtml(e.id)}" />
      <span class="adm-assoc-nome">${escapeHtml(e.nome)} ${pill(STATUS_EMPRESA, e.status)}</span>
      <select class="assoc-cargo-nova" data-org="${escapeHtml(e.id)}">${opcoesPapel("operations")}</select>
    </label>`;

  const buscaHtml = (associadas.length + disponiveis.length) > 8
    ? `<label class="adm-campo adm-campo--full"><span>🔎 Buscar empresa</span>
        <input id="assoc-busca" type="text" placeholder="Filtrar por nome…" /></label>`
    : "";

  const atuaisHtml = associadas.length
    ? `<h3 class="adm-det-tit">Vínculos atuais</h3>
       <p class="adm-nota">Trocar o cargo aqui altera o vínculo que já existe (encerra as sessões daquele usuário nessa empresa). Não cria associação nova.</p>
       <div class="adm-assoc-lista" id="assoc-atuais">${associadas.map(linhaAtual).join("")}</div>`
    : "";

  const novasHtml = disponiveis.length
    ? `<h3 class="adm-det-tit">Adicionar acesso a empresas</h3>
       <p class="adm-nota">Marque as empresas que este usuário passará a acessar e o cargo em cada uma.</p>
       <div class="adm-assoc-lista" id="assoc-novas">${disponiveis.map(linhaNova).join("")}</div>
       <div id="assoc-cargo-modo" hidden>
         <p class="adm-nota"><b>Este usuário terá o mesmo cargo em todas as empresas selecionadas?</b></p>
         <label class="adm-radio"><input type="radio" name="assoc-modo" value="mesmo" checked /> Sim — mesmo cargo em todas</label>
         <label class="adm-radio"><input type="radio" name="assoc-modo" value="individual" /> Não — definir individualmente</label>
         <div id="assoc-cargo-todas" class="adm-campo">
           <span>Cargo para todas as selecionadas</span>
           <select id="assoc-cargo-unico">${opcoesPapel("operations")}</select>
         </div>
       </div>`
    : `<h3 class="adm-det-tit">Adicionar acesso a empresas</h3>
       <p class="adm-nota">Este usuário já está associado a todas as empresas.</p>`;

  abrirModal({
    titulo: `Associar empresas — ${nome}`,
    corpo: `<div class="adm-assoc-modal">${buscaHtml}${atuaisHtml}${novasHtml}</div>`,
    confirmar: "Associar selecionadas",
    aoConfirmar: async () => {
      const body = el("#adm-modal-body");
      const alteracoes = [...body.querySelectorAll(".assoc-cargo-atual")]
        .filter((s) => s.value !== s.dataset.original)
        .map((s) => ({ organizacaoId: s.dataset.org, papel: s.value }));

      const modo = body.querySelector('input[name="assoc-modo"]:checked')?.value || "individual";
      const cargoUnico = valor("assoc-cargo-unico");
      const novas = [...body.querySelectorAll(".assoc-chk")]
        .filter((c) => c.checked)
        .map((c) => {
          const org = c.dataset.org;
          const rowSel = body.querySelector(`.assoc-cargo-nova[data-org="${org}"]`);
          const papel = modo === "mesmo" && cargoUnico ? cargoUnico : rowSel?.value;
          return { organizacaoId: org, papel };
        });

      if (!alteracoes.length && !novas.length) {
        throw new Error("Marque ao menos uma empresa nova, ou altere o cargo de um vínculo atual.");
      }

      const resumo = [];
      // Novas primeiro: operação atômica (ou entra tudo, ou nada).
      if (novas.length) {
        const r = await adminApi.associarEmpresasLote(id, novas);
        resumo.push(`${r.criadas.length} empresa(s) associada(s)`);
      }
      // Alterações de cargo em vínculos já existentes (uma a uma, explícitas).
      for (const a of alteracoes) {
        await adminApi.atualizarVinculo(id, a.organizacaoId, { papel: a.papel });
      }
      if (alteracoes.length) resumo.push(`${alteracoes.length} cargo(s) alterado(s)`);

      toast(resumo.join(" · "));
      recarregarAdmin();
    },
  });

  // --- comportamento dinâmico (mesmo padrão de usuario-associar-unidade) ---
  const body = el("#adm-modal-body");

  const busca = el("#assoc-busca");
  busca?.addEventListener("input", () => {
    const termo = busca.value.trim().toLowerCase();
    body.querySelectorAll(".adm-assoc").forEach((row) => {
      row.hidden = !!termo && !(row.dataset.nome || "").includes(termo);
    });
  });

  const modoBox = el("#assoc-cargo-modo");
  const todasBox = el("#assoc-cargo-todas");
  function sincronizar() {
    const marcadas = [...body.querySelectorAll(".assoc-chk")].filter((c) => c.checked);
    if (modoBox) modoBox.hidden = marcadas.length < 2;
    const modo = body.querySelector('input[name="assoc-modo"]:checked')?.value || "mesmo";
    if (todasBox) todasBox.hidden = modo !== "mesmo" || marcadas.length < 2;
    // Cargo por linha: some/desabilita quando "mesmo cargo" está no comando.
    body.querySelectorAll(".assoc-cargo-nova").forEach((sel) => {
      const linhaMarcada = sel.closest(".adm-assoc")?.querySelector(".assoc-chk")?.checked;
      const mandaOUnico = modo === "mesmo" && marcadas.length >= 2 && linhaMarcada;
      sel.disabled = !!mandaOUnico;
      sel.classList.toggle("adm-assoc-cargo--off", !!mandaOUnico);
    });
  }
  body.querySelectorAll(".assoc-chk").forEach((c) => c.addEventListener("change", sincronizar));
  body.querySelectorAll('input[name="assoc-modo"]').forEach((r) => r.addEventListener("change", sincronizar));

  body.querySelectorAll(".assoc-cargo-atual").forEach((sel) => {
    sel.addEventListener("change", () => {
      const flag = sel.parentElement.querySelector(".assoc-flag-alterado");
      if (flag) flag.hidden = sel.value === sel.dataset.original;
    });
  });

  sincronizar();
}

// ===========================================================================
// 4. FINANCEIRO DO SAAS
// ===========================================================================

async function viewFinanceiro() {
  const f = await adminApi.financeiro();
  cache.planos = f.planos;
  if (!cache.empresas.length) cache.empresas = await adminApi.empresas();
  const m = f.metricas;

  const cartoes = [
    kpi({ label: "MRR", valor: fmtMoeda(m.mrr), sub: "receita mensal recorrente" }),
    kpi({ label: "ARR", valor: fmtMoeda(m.arr), sub: "MRR × 12" }),
    kpi({ label: "Ticket médio", valor: fmtMoeda(m.ticketMedio) }),
    kpi({ label: "Churn (30 dias)", valor: pct(m.churnPct), sub: `${m.canceladas30d} cancelamento(s)` }),
    kpi({ label: "Assinaturas ativas", valor: num(m.assinaturasAtivas), sub: `${num(m.assinaturasTrial)} em teste` }),
    kpi({ label: "Inadimplentes", valor: num(m.inadimplentes), tom: m.inadimplentes > 0 ? "bad" : "" }),
    kpi({ label: "A receber (atrasado)", valor: fmtMoeda(m.aReceber), tom: m.aReceber > 0 ? "warn" : "" }),
    kpi({ label: "Recebido no mês", valor: fmtMoeda(m.recebidoNoMes), tom: "ok" }),
  ].join("");

  const planos = tabela({
    colunas: ["Plano", "Mensal", "Anual", "Limites", "Empresas", "Status", ""],
    linhas: f.planos.map((p) => [
      `<b>${escapeHtml(p.nome)}</b><br><small>${escapeHtml(p.codigo)}</small>`,
      fmtMoeda(p.preco_mensal), fmtMoeda(p.preco_anual),
      `${p.limite_unidades ?? "∞"} un. · ${p.limite_usuarios ?? "∞"} usuários`,
      num(p.empresas),
      p.ativo ? '<span class="pill ok">Ativo</span>' : '<span class="pill muted">Inativo</span>',
      `<button class="btn btn-ghost btn-sm" data-adm-acao="plano-editar" data-id="${escapeHtml(p.id)}">Editar</button>`,
    ]),
  });

  const assinaturas = tabela({
    colunas: ["Empresa", "Plano", "Ciclo", "Valor", "Mensalizado", "Status", "Próxima cobrança", ""],
    linhas: f.assinaturas.map((a) => [
      escapeHtml(a.empresa?.nome ?? "—"),
      escapeHtml(a.plano?.nome ?? "—"),
      escapeHtml(a.ciclo),
      fmtMoeda(a.valor),
      fmtMoeda(a.valorMensalizado),
      pill(STATUS_ASSINATURA, a.status),
      escapeHtml(a.proximaCobrancaEm ?? "—"),
      `<button class="btn btn-ghost btn-sm" data-adm-acao="assinatura-editar" data-id="${escapeHtml(a.id)}" data-status="${escapeHtml(a.status)}">Editar</button>`,
    ]),
    vazio: "Nenhuma assinatura registrada.",
  });

  const cobrancas = tabela({
    colunas: ["Empresa", "Competência", "Valor", "Vencimento", "Status", ""],
    linhas: f.cobrancas.map((c) => [
      escapeHtml(c.empresa?.nome ?? "—"),
      escapeHtml(String(c.competencia).slice(0, 7)),
      fmtMoeda(c.valor),
      escapeHtml(c.vencimento),
      c.atrasada ? '<span class="pill bad">Atrasada</span>' : pill(STATUS_COBRANCA, c.status),
      c.status === "paga" ? "" :
        `<button class="btn btn-ghost btn-sm" data-adm-acao="cobranca-pagar" data-id="${escapeHtml(c.id)}">Marcar paga</button>`,
    ]),
    vazio: "Nenhuma cobrança registrada.",
  });

  view().innerHTML =
    kpiGrade(cartoes) +
    secao({
      titulo: "Planos",
      acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="plano-novo">+ Novo plano</button>`,
      corpo: planos,
    }) +
    secao({
      titulo: "Assinaturas",
      acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="assinatura-nova">+ Nova assinatura</button>`,
      nota: "MRR considera assinaturas ativas e inadimplentes (a receita está contratada). Assinaturas em teste não entram.",
      corpo: assinaturas,
    }) +
    secao({
      titulo: "Cobranças",
      acoes: `<button class="btn btn-primary btn-sm" data-adm-acao="cobranca-nova">+ Nova cobrança</button>`,
      nota: "Emissão e conciliação automáticas dependem de um gateway de pagamento — o modelo já reserva método e referência externa para isso.",
      corpo: cobrancas,
    });
}

// ===========================================================================
// 5. MONITORAMENTO
// ===========================================================================

async function viewMonitoramento() {
  const m = await adminApi.monitoramento();

  const cartoes = m.itens.map((i) => `
    <div class="adm-mon adm-mon--${i.situacao}">
      <header>
        <b>${escapeHtml(i.nome)}</b>
        ${pill(SITUACAO, i.situacao)}
      </header>
      <p>${escapeHtml(i.detalhe)}</p>
      <footer>
        <span class="adm-mon-tipo">${escapeHtml({ sonda: "verificado agora", estado: "estado do sistema", reservado: "sem sonda" }[i.verificacao] ?? i.verificacao)}</span>
        ${i.latenciaMs != null ? `<span class="adm-mon-lat">${i.latenciaMs} ms</span>` : ""}
      </footer>
    </div>`).join("");

  const amb = m.ambiente;
  view().innerHTML =
    kpiGrade([
      kpi({ label: "Operacional", valor: num(m.resumo.operacional), tom: "ok" }),
      kpi({ label: "Degradado", valor: num(m.resumo.degradado), tom: m.resumo.degradado ? "warn" : "" }),
      kpi({ label: "Falha", valor: num(m.resumo.falha), tom: m.resumo.falha ? "bad" : "" }),
      kpi({ label: "Sem sonda", valor: num(m.resumo.semSonda), tom: "info" }),
      kpi({ label: "Desligado", valor: num(m.resumo.desligado) }),
    ].join("")) +
    secao({
      titulo: "Subsistemas",
      nota: "Cada item declara COMO foi verificado: “verificado agora” é uma sonda real; “estado do sistema” é leitura de configuração; “sem sonda” significa que ainda não há medição — não que esteja tudo bem.",
      corpo: `<div class="adm-mon-grade">${cartoes}</div>`,
    }) +
    secao({
      titulo: "Ambiente",
      corpo: `<div class="adm-det">
        <div class="adm-det-linha"><span>Ambiente</span><b>${escapeHtml(amb.nodeEnv)}</b></div>
        <div class="adm-det-linha"><span>Node</span><b>${escapeHtml(amb.versaoNode)}</b></div>
        <div class="adm-det-linha"><span>No ar há</span><b>${Math.floor(amb.uptimeS / 60)} min</b></div>
        <div class="adm-det-linha"><span>Memória (RSS)</span><b>${num(amb.memoriaMb)} MB</b></div>
        <div class="adm-det-linha"><span>Supabase</span><b>${escapeHtml(amb.supabaseHost)}</b></div>
      </div>`,
    });
}

// ===========================================================================
// 6. LOGS (sessões e acessos)
// ===========================================================================

async function viewLogs() {
  const [sessoes, acessos] = await Promise.all([
    adminApi.sessoes(),
    adminApi.auditoria({ limite: 200 }),
  ]);

  const eventosSessao = new Set([
    "sessao.login", "sessao.logout", "sessao.contexto_selecionado",
    "sessao.contexto_trocado", "sessao.login_negado",
    "impersonacao.iniciada", "impersonacao.encerrada",
  ]);

  const online = tabela({
    colunas: ["Usuário", "Empresa", "Unidade", "Cargo", "Desde", "Último uso", "IP", ""],
    linhas: sessoes.map((s) => [
      `<b>${escapeHtml(s.nome ?? "—")}</b><br><small>${escapeHtml(s.email ?? "—")}</small>`,
      escapeHtml(s.empresa?.nome ?? "—"),
      escapeHtml(s.unidade?.nome ?? "todas"),
      escapeHtml(s.papel) + (s.impersonando ? ' <span class="pill warn">suporte</span>' : ""),
      escapeHtml(fmtDataHora(s.desde)),
      escapeHtml(fmtRelativo(s.ultimoUso)),
      escapeHtml(s.ip ?? "—"),
      `<button class="btn btn-ghost btn-sm" data-adm-acao="usuario-logout" data-id="${escapeHtml(s.usuarioId)}" data-nome="${escapeHtml(s.nome ?? s.email ?? "")}">Encerrar</button>`,
    ]),
    vazio: "Nenhuma sessão ativa no momento.",
  });

  const eventos = acessos.filter((a) => eventosSessao.has(a.acao));
  const historico = tabela({
    colunas: ["Quando", "Usuário", "Evento", "Empresa", "IP"],
    linhas: eventos.map((a) => [
      `<span title="${escapeHtml(fmtDataHora(a.em))}">${escapeHtml(fmtRelativo(a.em))}</span>`,
      escapeHtml(a.atorEmail ?? "—"),
      escapeHtml(a.acaoRotulo) + (a.impersonado ? ' <span class="pill warn">suporte</span>' : ""),
      escapeHtml(a.empresaNome ?? "—"),
      escapeHtml(a.ip ?? "—"),
    ]),
    vazio: "Nenhum evento de sessão registrado.",
  });

  view().innerHTML =
    secao({
      titulo: `Sessões ativas (${sessoes.length})`,
      nota: "Uma sessão ativa é um Context Token com lastro vivo. “Encerrar” revoga a sessão e as credenciais do provedor de autenticação — o efeito é imediato.",
      corpo: online,
    }) +
    secao({ titulo: `Eventos de acesso (${eventos.length})`, corpo: historico });
}

// ===========================================================================
// 7. AUDITORIA
// ===========================================================================

let filtrosAuditoria = { acao: "", organizacaoId: "", busca: "", desde: "", ate: "", soImpersonacao: false };

async function viewAuditoria() {
  const [registros, opcoes] = await Promise.all([
    adminApi.auditoria({ ...filtrosAuditoria, limite: 200 }),
    adminApi.filtrosAuditoria(),
  ]);

  const barraFiltros = `
    <div class="adm-filtros">
      ${selecao({ id: "au-acao", label: "Ação", valor: filtrosAuditoria.acao, vazio: "Todas",
        opcoes: opcoes.acoes.map((a) => ({ valor: a.valor, rotulo: `${a.rotulo} (${a.total})` })) })}
      ${selecao({ id: "au-org", label: "Empresa", valor: filtrosAuditoria.organizacaoId, vazio: "Todas",
        opcoes: opcoes.empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) })}
      ${campo({ id: "au-busca", label: "Buscar", valor: filtrosAuditoria.busca, ph: "e-mail, ação, id…" })}
      ${campo({ id: "au-desde", label: "De", valor: filtrosAuditoria.desde, tipo: "date" })}
      ${campo({ id: "au-ate", label: "Até", valor: filtrosAuditoria.ate, tipo: "date" })}
      <label class="adm-campo adm-campo--check">
        <span>&nbsp;</span>
        <span><input type="checkbox" id="au-imp" ${filtrosAuditoria.soImpersonacao ? "checked" : ""} /> Só acessos de suporte</span>
      </label>
      <div class="adm-filtros-acoes">
        <button class="btn btn-primary btn-sm" data-adm-acao="auditoria-filtrar">Filtrar</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="auditoria-limpar">Limpar</button>
      </div>
    </div>`;

  const linhas = registros.map((r) => [
    `<span title="${escapeHtml(fmtDataHora(r.em))}">${escapeHtml(fmtRelativo(r.em))}</span>`,
    `${escapeHtml(r.atorEmail ?? "—")}${r.atorTipo === "superadmin" ? ' <span class="pill warn">SA</span>' : ""}`,
    escapeHtml(r.acaoRotulo),
    escapeHtml(r.empresaNome ?? "—"),
    r.entidade ? `${escapeHtml(r.entidade)}${r.entidadeId ? `<br><small>${escapeHtml(String(r.entidadeId).slice(0, 20))}</small>` : ""}` : "—",
    r.detalhes && Object.keys(r.detalhes).length
      ? `<details><summary>ver</summary><pre class="adm-json">${escapeHtml(JSON.stringify(r.detalhes, null, 2))}</pre></details>`
      : "—",
    escapeHtml(r.ip ?? "—"),
  ]);

  view().innerHTML = secao({
    titulo: `Auditoria (${registros.length} registros)`,
    nota: "Registros imutáveis: o banco recusa alteração e exclusão nesta tabela, inclusive para o backend. Toda ação administrativa e todo acesso de suporte a empresa cliente ficam aqui.",
    corpo: barraFiltros + tabela({
      colunas: ["Quando", "Ator", "Ação", "Empresa", "Entidade", "Detalhes", "IP"],
      linhas,
      vazio: "Nenhum registro para os filtros escolhidos.",
    }),
  });
}

// ===========================================================================
// 8. ATUALIZAÇÕES
// ===========================================================================

async function viewAtualizacoes() {
  const d = await adminApi.atualizacoes();
  view().innerHTML =
    kpiGrade([
      kpi({ label: "Versão publicada", valor: d.versaoAtual ?? "—" }),
      kpi({ label: "Ambiente", valor: d.ambiente }),
      kpi({ label: "Node", valor: d.versaoNode }),
      kpi({ label: "Última reinicialização", valor: fmtRelativo(d.iniciadoEm) }),
    ].join("")) +
    secao({
      titulo: "Histórico de versões",
      corpo: d.historico.length
        ? tabela({ colunas: ["Versão", "Data", "Notas"], linhas: d.historico.map((h) => [escapeHtml(h.versao), escapeHtml(h.data), escapeHtml(h.notas)]) })
        : reservado("Histórico ainda não disponível", d.fonteHistorico.comoHabilitar),
    }) +
    secao({
      titulo: "Como publicar uma versão",
      corpo: `<ol class="adm-passos">
        <li>Atualize a chave <code>saas.versao</code> em Configurações Globais.</li>
        <li>Incremente o <code>?v=</code> do <code>styles.css</code> no <code>index.html</code> para invalidar o cache do CSS.</li>
        <li>Faça o deploy — o Render publica automaticamente a partir do branch principal.</li>
      </ol>`,
    });
}

// ===========================================================================
// 9. IA — Agente Crescer: provedores + consumo real (tokens/custo)
// ===========================================================================

/** Custo em USD, padrão pt-BR (vírgula decimal) — nunca fmtMoeda (BRL). */
function fmtUsd(v, casasMin = 2, casasMax = 4) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: casasMin, maximumFractionDigits: casasMax })}`;
}

const ROTULOS_PERIODO_AGENTE = [
  { valor: "hoje", rotulo: "Hoje" },
  { valor: "este_mes", rotulo: "Este mês" },
  { valor: "mes_anterior", rotulo: "Mês anterior" },
  { valor: "personalizado", rotulo: "Período personalizado" },
];

let filtrosConsumoAgente = { periodo: "este_mes", desde: "", ate: "" };
let paginaConsumoAgente = 1;

async function viewIa() {
  const [d, resumo, porOrg, porModelo] = await Promise.all([
    adminApi.ia(),
    adminApi.consumoAgente(filtrosConsumoAgente),
    adminApi.consumoAgentePorOrganizacao({ ...filtrosConsumoAgente, pagina: paginaConsumoAgente }),
    adminApi.consumoAgentePorModelo(filtrosConsumoAgente),
  ]);

  const provedores = d.provedores.map((p) => `
    <div class="adm-mon ${p.configurado ? "adm-mon--operacional" : "adm-mon--desligado"}">
      <header>
        <b>${escapeHtml(p.nome)}</b>
        <span class="pill ${p.configurado ? "ok" : "muted"}">${p.configurado ? "Chave configurada" : "Sem chave"}</span>
      </header>
      <p>Modelo sugerido: <code>${escapeHtml(p.modeloSugerido)}</code></p>
      <footer><span class="adm-mon-tipo">Configure a chave em Configurações Globais → APIs</span></footer>
    </div>`).join("");

  const barraFiltros = `
    <div class="adm-filtros">
      ${selecao({ id: "ia-periodo", label: "Período", valor: filtrosConsumoAgente.periodo, opcoes: ROTULOS_PERIODO_AGENTE.map((p) => ({ valor: p.valor, rotulo: p.rotulo })) })}
      ${campo({ id: "ia-desde", label: "De (só p/ período personalizado)", valor: filtrosConsumoAgente.desde, tipo: "date" })}
      ${campo({ id: "ia-ate", label: "Até (só p/ período personalizado)", valor: filtrosConsumoAgente.ate, tipo: "date" })}
      <div class="adm-filtros-acoes">
        <button class="btn btn-primary btn-sm" data-adm-acao="agente-uso-filtrar">Filtrar</button>
        <button class="btn btn-ghost btn-sm" data-adm-acao="agente-uso-limpar">Limpar</button>
      </div>
    </div>`;

  const kpis = kpiGrade([
    kpi({ label: "Interações", valor: num(resumo.interacoes) }),
    kpi({ label: "Custo estimado", valor: fmtUsd(resumo.custoEstimadoUsd) }),
    kpi({ label: "Custo médio por interação", valor: fmtUsd(resumo.custoMedioUsd, 4, 6) }),
    kpi({ label: "Input tokens", valor: num(resumo.inputTokens) }),
    kpi({ label: "Output tokens", valor: num(resumo.outputTokens) }),
    kpi({ label: "Falhas", valor: num(resumo.falhas), tom: resumo.falhas ? "warn" : "" }),
  ].join(""));

  const tabelaOrg = tabela({
    colunas: ["Organização", "Interações", "Usuários ativos", "Unidades", "Input tokens", "Output tokens", "Custo estimado"],
    linhas: porOrg.itens.map((o) => [
      escapeHtml(o.organizacaoNome),
      num(o.interacoes),
      num(o.usuariosAtivos),
      num(o.unidadesAtivas),
      num(o.inputTokens),
      num(o.outputTokens),
      `<b>${fmtUsd(o.custoEstimadoUsd)}</b>`,
    ]),
    vazio: "Nenhuma interação com o Agente Crescer no período.",
  });

  const totalPaginasOrg = Math.max(1, Math.ceil(porOrg.total / porOrg.porPagina));
  const paginacaoOrg = porOrg.total > porOrg.porPagina ? `
    <div class="adm-paginacao">
      <button class="btn btn-ghost btn-sm" data-adm-acao="agente-uso-pagina" data-pagina="${porOrg.pagina - 1}" ${porOrg.pagina <= 1 ? "disabled" : ""}>← Anterior</button>
      <span>Página ${porOrg.pagina} de ${totalPaginasOrg}</span>
      <button class="btn btn-ghost btn-sm" data-adm-acao="agente-uso-pagina" data-pagina="${porOrg.pagina + 1}" ${porOrg.pagina >= totalPaginasOrg ? "disabled" : ""}>Próxima →</button>
    </div>` : "";

  const tabelaModelo = tabela({
    colunas: ["Modelo", "Interações", "Input tokens", "Output tokens", "Custo estimado"],
    linhas: porModelo.itens.map((m) => [
      `<code>${escapeHtml(m.model)}</code>`, num(m.interacoes), num(m.inputTokens), num(m.outputTokens), `<b>${fmtUsd(m.custoEstimadoUsd)}</b>`,
    ]),
    vazio: "Nenhuma interação no período.",
  });

  view().innerHTML =
    secao({
      titulo: "Provedores",
      nota: d.observacao,
      corpo: `<div class="adm-mon-grade">${provedores}</div>`,
    }) +
    secao({
      titulo: "Recursos previstos",
      corpo: `<ul class="adm-det-lista">${d.recursosPrevistos.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`,
    }) +
    secao({
      titulo: "Consumo do Agente Crescer",
      nota: "Medido por interação real (tokens da própria resposta da Anthropic) — nunca estimado. Só observação: nenhum limite é aplicado nesta fase.",
      corpo: barraFiltros + kpis,
    }) +
    secao({ titulo: "Por organização", corpo: tabelaOrg + paginacaoOrg }) +
    secao({ titulo: "Por modelo", corpo: tabelaModelo });
}

// ===========================================================================
// 10. CONFIGURAÇÕES GLOBAIS
// ===========================================================================

async function viewConfiguracoes() {
  const c = await adminApi.configuracoes();

  const bloco = (grupo) => secao({
    titulo: grupo.titulo,
    corpo: grade(grupo.itens.map(itemConfig).join("")) +
      `<div class="adm-secao-acoes adm-secao-acoes--fim">
         <button class="btn btn-primary btn-sm" data-adm-acao="config-salvar" data-grupo="${escapeHtml(grupo.chave)}">Salvar ${escapeHtml(grupo.titulo)}</button>
       </div>`,
  });

  view().innerHTML =
    `<div class="adm-aviso adm-aviso--info">
      Chaves marcadas como <b>secretas</b> nunca são exibidas — o painel mostra apenas se estão preenchidas.
      Deixe o campo em branco para manter o valor atual.
     </div>` +
    c.grupos.map(bloco).join("") +
    (c.outros.length ? bloco({ chave: "outros", titulo: "Outras configurações", itens: c.outros }) : "");
}

/** @param {{chave: string, secreto: boolean, valor?: unknown, preenchido?: boolean, descricao: string|null}} i */
function itemConfig(i) {
  const id = `cfg-${i.chave.replace(/\./g, "-")}`;
  const rotulo = i.descricao ?? i.chave;

  if (i.secreto) {
    return `
      <label class="adm-campo">
        <span>${escapeHtml(rotulo)} <em class="adm-secreto">secreto</em></span>
        <input id="${id}" data-chave="${escapeHtml(i.chave)}" data-secreto="1" type="password"
               placeholder="${i.preenchido ? "•••••••• (preenchido)" : "não configurado"}" />
        <small>${i.preenchido ? "Já existe um valor gravado. Preencha só para substituir." : "Nenhum valor gravado."}</small>
      </label>`;
  }

  if (typeof i.valor === "boolean") {
    return `
      <label class="adm-campo adm-campo--check">
        <span>${escapeHtml(rotulo)}</span>
        <span><input id="${id}" data-chave="${escapeHtml(i.chave)}" data-tipo="bool" type="checkbox" ${i.valor ? "checked" : ""} /> ${escapeHtml(i.chave)}</span>
      </label>`;
  }

  const tipo = typeof i.valor === "number" ? "number" : "text";
  return `
    <label class="adm-campo">
      <span>${escapeHtml(rotulo)}</span>
      <input id="${id}" data-chave="${escapeHtml(i.chave)}" data-tipo="${tipo}" type="${tipo}"
             value="${escapeHtml(i.valor ?? "")}" />
      <small>${escapeHtml(i.chave)}</small>
    </label>`;
}

// ===========================================================================
// Mapa de views
// ===========================================================================

const VIEWS = {
  dashboard: viewDashboard,
  estrutura: viewEstrutura,
  empresas: viewEmpresas,
  unidades: viewUnidades,
  usuarios: viewUsuarios,
  financeiro: viewFinanceiro,
  monitoramento: viewMonitoramento,
  logs: viewLogs,
  auditoria: viewAuditoria,
  atualizacoes: viewAtualizacoes,
  ia: viewIa,
  configuracoes: viewConfiguracoes,
};

// ===========================================================================
// Ações (delegação a partir de data-adm-acao)
// ===========================================================================

/** Executa uma ação e, no sucesso, recarrega a view + avisa. */
async function agir(fn, mensagem) {
  try {
    await fn();
    if (mensagem) toast(mensagem);
    recarregarAdmin();
  } catch (e) {
    toast("Erro: " + e.message);
  }
}

const ACOES = {
  // ---- Empresas
  // A criação vira um assistente de 4 passos (empresa/acessos/modelo/revisão)
  // — não cabe no modal single-step de abrirModal(), ver adminEmpresaWizard.js.
  "empresa-nova": () => abrirAssistenteNovaEmpresa(cache.planos),

  // Detalhes deixou de ser modal: é uma página com abas (Informações, Acessos,
  // Unidades, Usuários, Modelo Inicial, Auditoria) — ver adminEmpresaDetalhe.js.
  "empresa-ver": ({ id }) => abrirPaginaEmpresa(id),

  "empresa-entrar": async ({ id, nome }) => {
    if (!confirm(`Entrar em "${nome}" como SuperAdmin?\n\nEste acesso é registrado na auditoria e uma barra de aviso ficará visível durante toda a sessão.`)) return;
    await entrarComoEmpresa(id, nome);
  },

  "empresa-menu": ({ id, nome, status }) => abrirModal({
    titulo: nome,
    corpo: `
      ${grade(
        selecao({
          id: "es-status", label: "Status da empresa", valor: status,
          opcoes: Object.entries(STATUS_EMPRESA).map(([valor, m]) => ({ valor, rotulo: m.rotulo })),
          dica: "Bloquear, suspender ou cancelar derruba na hora todas as sessões ativas da empresa.",
        }) +
        campo({ id: "es-motivo", label: "Motivo (fica na auditoria)", ph: "ex: inadimplência 60 dias" }) +
        selecao({
          id: "es-plano", label: "Plano", vazio: "não alterar",
          opcoes: cache.planos.map((p) => ({ valor: p.id, rotulo: `${p.nome} · ${fmtMoeda(p.preco_mensal)}/mês` })),
        })
      )}
      <div class="adm-secao-estrutura">
        <b>Converter em unidade</b>
        <p>Transforma esta empresa numa unidade dentro de outra — só funciona quando ela não tem nenhuma
        unidade própria cadastrada (transfira/promova as unidades dela antes, se houver).</p>
        <button class="btn btn-ghost btn-sm" data-adm-acao="empresa-converter-form" data-id="${escapeHtml(id)}" data-nome="${escapeHtml(nome)}">Converter em unidade…</button>
      </div>
      <div class="adm-zona-perigo">
        <b>Excluir permanentemente</b>
        <p>Apaga a empresa e TODOS os dados dela (unidades, produtos, vendas, vínculos). Não há como desfazer.
        Para apenas encerrar preservando os dados, use o status <b>Cancelada</b>.</p>
        <button class="btn btn-perigo btn-sm" data-adm-acao="empresa-excluir" data-id="${escapeHtml(id)}" data-nome="${escapeHtml(nome)}">Excluir empresa</button>
      </div>`,
    confirmar: "Aplicar",
    aoConfirmar: async () => {
      const novoStatus = valor("es-status");
      const plano = valor("es-plano");
      if (novoStatus && novoStatus !== status) {
        await adminApi.alterarStatusEmpresa(id, novoStatus, valor("es-motivo") || undefined);
      }
      if (plano) await adminApi.alterarPlanoEmpresa(id, plano);
      toast("Empresa atualizada.");
      recarregarAdmin();
    },
  }),

  // Mostra o impacto ANTES de qualquer coisa (mesmo padrão de
  // adminUnidadeDetalhe.js#abrirExclusao). Achado da investigação:
  // excluirEmpresa() fazia DELETE cru confiando no cascade — mas catálogo
  // (ficha_tecnica é ON DELETE RESTRICT) batia num erro 23503 cru do banco.
  // A correção real está em excluir_organizacao_definitivamente (migration
  // 055): limpa as dependências travadas ANTES do delete em cascata, numa
  // transação só. Por isso o botão "Excluir definitivamente" continua
  // disponível MESMO havendo catálogo/histórico — a trava daqui é só um
  // aviso pra guiar pra "Arquivar" como alternativa mais segura, nunca um
  // impeditivo sem saída.
  "empresa-excluir": async ({ id, nome }) => {
    let impacto;
    try {
      impacto = await adminApi.impactoExclusaoEmpresa(id);
    } catch (e) {
      toast("Erro: " + e.message);
      return;
    }

    // Só o que existe de fato — uma lista de zeros não ajuda ninguém a
    // avaliar o tamanho real do impacto.
    const itensImpacto = Object.entries(impacto.metricas)
      .filter(([, valorMetrica]) => Number(valorMetrica) > 0)
      .map(([chave, valorMetrica]) => {
        const rotulo = rotuloMetricaEmpresa(chave, Number(valorMetrica));
        // Nomes de módulo (após " — ") ficam com a capitalização própria
        // deles ("Dashboard Executivo", "Parser Food Delivery"...) — só a
        // primeira parte (a entidade contada) vira minúscula.
        const rotuloExibido = rotulo.includes(" — ")
          ? rotulo.replace(/^(.*?) — /, (m, entidade) => `${entidade.toLowerCase()} — `)
          : rotulo.toLowerCase();
        return `<li>${num(valorMetrica)} ${escapeHtml(rotuloExibido)}</li>`;
      })
      .join("");
    const blocoImpacto = itensImpacto ? `<p>Esta empresa possui:</p><ul class="adm-det-lista">${itensImpacto}</ul>` : "";

    const abrirConfirmacaoExclusao = () => abrirModal({
      titulo: `Excluir definitivamente "${impacto.nome}"?`,
      perigo: true,
      corpo: `
        ${blocoImpacto}
        <div class="adm-aviso adm-aviso--perigo">
          A exclusão removerá permanentemente a empresa e todos os dados relacionados que fizerem parte de sua estrutura.
          <b>Esta ação não poderá ser desfeita.</b>
        </div>
        ${grade(campo({ id: "ex-conf", label: `Digite ${impacto.nome} para confirmar`, ph: impacto.nome, obrigatorio: true }))}`,
      confirmar: "Excluir definitivamente",
      aoConfirmar: async () => {
        // A confirmação é validada TAMBÉM no servidor — este campo não é a
        // única barreira, é só o aviso na frente dela.
        if (valor("ex-conf") !== impacto.nome) {
          mostrarErroModal("O nome digitado não confere.");
          throw new Error("confirmação inválida");
        }
        await adminApi.excluirEmpresa(id, impacto.nome);
        toast("Empresa excluída.");
        irParaAdmin("empresas");
      },
    });

    if (!impacto.exclusaoFisicaSegura) {
      // Sem `aoConfirmar` de propósito: as duas ações que importam aqui já
      // são os botões no corpo. Um `aoConfirmar` chamando
      // `abrirConfirmacaoExclusao()` colidiria com o próprio `abrirModal` —
      // ele reabriria #adm-modal com o segundo passo, e o `fecharModal()`
      // automático que o rodapé dispara na sequência fecharia tudo por
      // baixo dele. Rodapé aqui é só "Fechar".
      abrirModal({
        titulo: `Excluir ${impacto.nome}`,
        corpo: `
          <div class="adm-aviso adm-aviso--perigo">
            <b>Atenção:</b> esta empresa possui histórico operacional. Recomendamos <b>arquivá-la</b> para preservar
            os dados. Como SuperAdmin, você ainda pode realizar a exclusão definitiva.
          </div>
          ${blocoImpacto}
          <div class="adm-det-acoes">
            <button type="button" class="btn btn-ghost" data-adm-acao="empresa-arquivar"
                    data-id="${escapeHtml(id)}" data-nome="${escapeHtml(impacto.nome)}">Arquivar empresa</button>
            <button type="button" class="btn btn-perigo" id="btn-ir-exclusao-definitiva">Excluir definitivamente</button>
          </div>`,
      });
      el("#btn-ir-exclusao-definitiva")?.addEventListener("click", abrirConfirmacaoExclusao);
      return;
    }

    abrirConfirmacaoExclusao();
  },

  // Atalho a partir do aviso de exclusão — mesma operação que "Status" no
  // menu "⋯" da empresa (adminApi.alterarStatusEmpresa), só que direto pra
  // "cancelada" sem abrir aquele formulário inteiro.
  "empresa-arquivar": async ({ id, nome }) => {
    if (!confirm(`Arquivar "${nome}"?\n\nO status muda para "Cancelada": o acesso é encerrado, mas nenhum dado é perdido.`)) return;
    try {
      await adminApi.alterarStatusEmpresa(id, "cancelada");
    } catch (e) {
      toast("Erro: " + e.message);
      return;
    }
    fecharModal();
    toast("Empresa arquivada (status: Cancelada).");
    recarregarAdmin();
  },

  // ---- Estrutura organizacional (promover/converter/transferir) — cada
  // uma abre um modal explicativo + confirmação (nunca executa direto), e
  // roda como transação única no banco (ver plataforma.estrutura.service.js).
  "empresa-converter-form": ({ id, nome }) => abrirModal({
    titulo: `Converter ${nome} em unidade`,
    corpo: `
      <div class="adm-aviso adm-aviso--info">
        <b>${escapeHtml(nome)}</b> deixará de ser uma empresa independente e passará a ser uma unidade dentro
        da empresa escolhida abaixo. Todos os dados são preservados — nada é apagado. O catálogo próprio desta
        empresa (produtos, insumos, fichas técnicas), se existir, NÃO é mesclado automaticamente ao catálogo
        da empresa-mãe: fica preservado, só fica desvinculado.
      </div>
      ${grade(selecao({
        id: "conv-mae", label: "Empresa-mãe", vazio: "Selecione…",
        opcoes: cache.empresas.filter((e) => e.id !== id).map((e) => ({ valor: e.id, rotulo: e.nome })),
      }))}`,
    confirmar: "Confirmar conversão",
    aoConfirmar: async () => {
      const maeId = valor("conv-mae");
      if (!maeId) { mostrarErroModal("Escolha a empresa-mãe."); throw new Error("empresa-mãe não escolhida"); }
      await adminApi.converterEmpresaParaUnidade(id, maeId);
      toast(`"${nome}" agora é uma unidade.`);
      irParaAdmin("estrutura");
    },
  }),

  // Picker: as duas ações estruturais de unidade num só menu — cada botão
  // fecha este modal e abre o de confirmação real (mesmo encadeamento de
  // empresa-menu -> empresa-excluir).
  "unidade-estrutura-menu": ({ id, nome, org, empresa }) => abrirModal({
    titulo: nome,
    corpo: `
      <div class="adm-estrutura-acoes">
        <button type="button" class="adm-estrutura-op" data-adm-acao="unidade-promover-form"
                data-id="${escapeHtml(id)}" data-nome="${escapeHtml(nome)}" data-org="${escapeHtml(org)}" data-empresa="${escapeHtml(empresa)}">
          <b>Promover para empresa</b>
          <small>${escapeHtml(nome)} vira uma empresa independente, com o próprio catálogo.</small>
        </button>
        <button type="button" class="adm-estrutura-op" data-adm-acao="unidade-transferir-form"
                data-id="${escapeHtml(id)}" data-nome="${escapeHtml(nome)}" data-org="${escapeHtml(org)}" data-empresa="${escapeHtml(empresa)}">
          <b>Transferir unidade</b>
          <small>Move ${escapeHtml(nome)} para outra empresa já existente.</small>
        </button>
      </div>`,
  }),

  "unidade-promover-form": ({ id, nome, empresa }) => abrirModal({
    titulo: `Promover ${nome} para empresa?`,
    corpo: `
      <div class="adm-aviso adm-aviso--info">
        <b>${escapeHtml(nome)}</b> deixará de fazer parte de <b>${escapeHtml(empresa)}</b> e passará a
        funcionar como uma empresa independente. Todos os dados operacionais (vendas, estoque, Dashboard
        Executivo, Bonificação, Parser Food Delivery, histórico, usuários) são preservados — o ID da unidade
        não muda. Só o catálogo (produtos, insumos, fichas técnicas), que hoje pertence a ${escapeHtml(empresa)},
        é copiado para a empresa nova.
      </div>
      ${grade(campo({ id: "prom-nome", label: "Nome da nova empresa", valor: nome, obrigatorio: true }))}`,
    confirmar: "Confirmar promoção",
    aoConfirmar: async () => {
      const nomeEmpresa = valor("prom-nome");
      await adminApi.promoverUnidade(id, nomeEmpresa || undefined);
      toast(`"${nome}" agora é uma empresa independente.`);
      irParaAdmin("estrutura");
    },
  }),

  "unidade-transferir-form": ({ id, nome, org, empresa }) => abrirModal({
    titulo: `Transferir ${nome}`,
    corpo: `
      <div class="adm-aviso adm-aviso--info">
        A unidade sai de <b>${escapeHtml(empresa)}</b> e passa a pertencer à empresa escolhida abaixo.
        Histórico, lançamentos e vínculos da unidade são preservados integralmente. O catálogo (produtos/
        insumos) NÃO é remapeado automaticamente — a unidade passa a usar o catálogo da empresa nova a
        partir de agora; o histórico continua legível porque nada é apagado da empresa anterior.
      </div>
      ${grade(selecao({
        id: "transf-empresa", label: "Empresa de destino", vazio: "Selecione…",
        opcoes: cache.empresas.filter((e) => e.id !== org).map((e) => ({ valor: e.id, rotulo: e.nome })),
      }))}`,
    confirmar: "Confirmar transferência",
    aoConfirmar: async () => {
      const novaOrgId = valor("transf-empresa");
      if (!novaOrgId) { mostrarErroModal("Escolha a empresa de destino."); throw new Error("empresa não escolhida"); }
      await adminApi.transferirUnidade(id, novaOrgId);
      toast(`"${nome}" transferida.`);
      irParaAdmin("estrutura");
    },
  }),

  // ---- Unidades
  "unidade-nova": () => abrirAssistenteNovaUnidade(cache.empresas),

  // Detalhe também virou página própria (Informações/Acessos/Usuários/
  // Dados-Configurações/Auditoria) — ver adminUnidadeDetalhe.js.
  "unidade-ver": ({ id }) => abrirPaginaUnidade(id),
  "unidade-acessos": ({ id }) => abrirPaginaUnidade(id, "acessos"),

  // Edição rápida sem sair da lista — os mesmos campos da aba Informações da
  // página da unidade, pra quando só um detalhe pequeno precisa mudar.
  "unidade-editar": (d) => abrirModal({
    titulo: `Editar ${d.nome}`,
    corpo: grade(
      campo({ id: "ue-nome", label: "Nome da unidade", valor: d.nome, obrigatorio: true }) +
      campo({ id: "ue-cnpj", label: "CNPJ", valor: d.cnpj, ph: "somente números" }) +
      campo({ id: "ue-cidade", label: "Cidade", valor: d.cidade }) +
      campo({ id: "ue-estado", label: "Estado (UF)", valor: d.estado, ph: "ex: MA" }) +
      campo({ id: "ue-endereco", label: "Endereço", valor: d.endereco }) +
      campo({ id: "ue-resp", label: "Responsável", valor: d.responsavel }) +
      campo({ id: "ue-email", label: "E-mail da loja", valor: d.email, tipo: "email" }) +
      campo({ id: "ue-tel", label: "Telefone", valor: d.telefone, ph: "DDD + número" })
    ),
    confirmar: "Salvar",
    aoConfirmar: async () => {
      await adminApi.atualizarUnidade(d.id, {
        nome: valor("ue-nome"), cnpj: valor("ue-cnpj"), cidade: valor("ue-cidade"),
        estado: valor("ue-estado"), endereco: valor("ue-endereco"),
        responsavel: valor("ue-resp"), email: valor("ue-email"), telefone: valor("ue-tel"),
      });
      toast("Unidade atualizada.");
      recarregarAdmin();
    },
  }),

  "unidade-status": ({ id, nome, ativo }) => {
    const estaAtiva = !!ativo;
    if (estaAtiva && !confirm(`Desativar "${nome}"? Isso encerra na hora todas as sessões abertas desta unidade.`)) return;
    return agir(
      () => adminApi.alterarStatusUnidade(id, !estaAtiva),
      estaAtiva ? "Unidade desativada." : "Unidade ativada."
    );
  },

  "unidades-filtrar": () => {
    filtrosUnidades = { busca: valor("un-busca"), organizacaoId: valor("un-empresa"), status: valor("un-status") };
    recarregarAdmin();
  },

  "unidades-limpar": () => {
    filtrosUnidades = { busca: "", status: "", organizacaoId: "" };
    recarregarAdmin();
  },

  // ---- Usuários
  "usuario-novo": () => abrirModal({
    titulo: "Novo usuário",
    corpo: formUsuario(),
    confirmar: "Criar usuário",
    aoConfirmar: async () => {
      await adminApi.criarUsuario({
        nome: valor("u-nome"), email: valor("u-email"), senha: valor("u-senha"),
        empresas: lerEmpresasMarcadas(),
      });
      toast("Usuário criado.");
      recarregarAdmin();
    },
  }),

  "usuario-ver": ({ id }) => abrirDetalheUsuario(id),

  "usuario-associar": ({ id, nome }) => abrirModalAssociarEmpresas(id, nome),

  // Associar uma UNIDADE específica — só oferece empresas às quais o usuário
  // já tem acesso (associarUnidade recusa no backend se não tiver). Cargo em
  // branco = herda o da empresa (mesma regra de usuarios_unidades.papel null).
  "usuario-associar-unidade": async ({ id, nome }) => {
    if (!cache.papeis.length) cache.papeis = await adminApi.papeis();
    const detalhe = await adminApi.usuario(id);
    const empresasDoUsuario = detalhe.empresas.filter((e) => e.ativo);
    if (!empresasDoUsuario.length) {
      toast(`Associe "${nome}" a uma empresa primeiro.`);
      return;
    }
    const primeiraEmpresa = empresasDoUsuario[0].organizacaoId;
    const unidadesIniciais = await adminApi.unidadesDaEmpresa(primeiraEmpresa);

    abrirModal({
      titulo: `Associar unidade — ${nome}`,
      corpo: grade(
        selecao({
          id: "ua-empresa", label: "Empresa", valor: primeiraEmpresa,
          opcoes: empresasDoUsuario.map((e) => ({ valor: e.organizacaoId, rotulo: e.empresaNome })),
        }) +
        selecao({
          id: "ua-unidade", label: "Unidade",
          opcoes: unidadesIniciais.map((un) => ({ valor: un.id, rotulo: un.nome + (un.ativo ? "" : " (inativa)") })),
          vazio: unidadesIniciais.length ? "" : "Nenhuma unidade nesta empresa",
        }) +
        selecao({
          id: "ua-papel", label: "Cargo nesta unidade", vazio: "Herdar o cargo da empresa",
          opcoes: cache.papeis.map((p) => ({ valor: p.valor, rotulo: p.rotulo })),
          dica: "Deixe em branco pra usar o mesmo cargo que o usuário já tem na empresa.",
        })
      ),
      confirmar: "Associar",
      aoConfirmar: async () => {
        const unidadeId = valor("ua-unidade");
        if (!unidadeId) throw new Error("Selecione uma unidade.");
        await adminApi.associarUnidade(id, unidadeId, valor("ua-papel") || undefined);
        toast("Unidade associada.");
        recarregarAdmin();
      },
    });

    // Trocar de empresa recarrega as unidades — nunca deixa marcado um id de
    // unidade de outra empresa (o que causaria o 404 "Unidade não encontrada"
    // ou, pior, associar a unidade errada).
    el("#ua-empresa").addEventListener("change", async (e) => {
      const unidades = await adminApi.unidadesDaEmpresa(e.target.value);
      el("#ua-unidade").innerHTML = unidades.length
        ? unidades.map((un) => `<option value="${escapeHtml(un.id)}">${escapeHtml(un.nome)}${un.ativo ? "" : " (inativa)"}</option>`).join("")
        : `<option value="">Nenhuma unidade nesta empresa</option>`;
    });
  },

  "usuario-senha": ({ id, nome }) => abrirModal({
    titulo: `Redefinir senha — ${nome}`,
    corpo: `<div class="adm-aviso">Todas as sessões deste usuário serão encerradas.</div>` +
      grade(campo({ id: "sn-senha", label: "Nova senha", tipo: "text", ph: "mínimo 8 caracteres", obrigatorio: true })),
    confirmar: "Redefinir",
    aoConfirmar: async () => {
      await adminApi.redefinirSenha(id, valor("sn-senha"));
      toast("Senha redefinida e sessões encerradas.");
    },
  }),

  "usuario-email": ({ id, nome, email }) => abrirModal({
    titulo: `Alterar e-mail — ${nome}`,
    corpo: grade(campo({ id: "em-email", label: "Novo e-mail", valor: email, tipo: "email", obrigatorio: true })),
    confirmar: "Alterar",
    aoConfirmar: async () => {
      await adminApi.alterarEmail(id, valor("em-email"));
      toast("E-mail alterado.");
      recarregarAdmin();
    },
  }),

  "usuario-logout": ({ id, nome }) => {
    if (!confirm(`Forçar logout de "${nome}"? As sessões ativas serão encerradas imediatamente.`)) return;
    return agir(() => adminApi.forcarLogout(id), "Sessões encerradas.");
  },

  "usuario-toggle": ({ id, nome, ativo }) => {
    const bloquear = ativo === "true";
    if (!confirm(`${bloquear ? "Bloquear" : "Reativar"} a conta de "${nome}"?`)) return;
    return agir(() => adminApi.atualizarUsuario(id, { ativo: !bloquear }),
      bloquear ? "Conta bloqueada." : "Conta reativada.");
  },

  "usuario-super": ({ id, nome, super: ehSuper }) => {
    const conceder = ehSuper !== "true";
    if (!confirm(`${conceder ? "Conceder" : "Revogar"} o papel de SuperAdmin da Plataforma para "${nome}"?\n\nSuperAdmin administra TODAS as empresas.`)) return;
    return agir(() => adminApi.definirSuperadmin(id, conceder),
      conceder ? "SuperAdmin concedido." : "SuperAdmin revogado.");
  },

  "usuario-excluir": ({ id, nome }) => {
    if (!confirm(`Excluir DEFINITIVAMENTE a conta de "${nome}"?\n\nA conta é removida do provedor de autenticação e perde acesso a todas as empresas. Não há como desfazer.`)) return;
    return agir(async () => { await adminApi.excluirUsuario(id); }, "Conta excluída.");
  },

  // ---- Vínculos
  "vinculo-papel": ({ usuario, org }, alvo) =>
    agir(() => adminApi.atualizarVinculo(usuario, org, { papel: alvo.value }), "Cargo atualizado."),

  "vinculo-toggle": ({ usuario, org, ativo }) =>
    agir(() => adminApi.atualizarVinculo(usuario, org, { ativo: ativo !== "true" }),
      ativo === "true" ? "Acesso bloqueado nesta empresa." : "Acesso liberado."),

  "vinculo-remover": ({ usuario, org, nome }) => {
    if (!confirm(`Remover o acesso a "${nome}"?\n\nA conta continua existindo e mantém o acesso às outras empresas.`)) return;
    return agir(() => adminApi.removerVinculo(usuario, org), "Acesso removido.");
  },

  "vinculo-unidade-papel": ({ usuario, unidade }, alvo) =>
    agir(() => adminApi.atualizarVinculoUnidade(usuario, unidade, { papel: alvo.value || null }), "Cargo atualizado."),

  "vinculo-unidade-toggle": ({ usuario, unidade, ativo }) =>
    agir(() => adminApi.atualizarVinculoUnidade(usuario, unidade, { ativo: ativo !== "true" }),
      ativo === "true" ? "Acesso bloqueado nesta unidade." : "Acesso liberado."),

  "vinculo-unidade-remover": ({ usuario, unidade, nome }) => {
    if (!confirm(`Remover o acesso à unidade "${nome}"?\n\nA conta continua existindo e mantém o acesso ao resto da empresa.`)) return;
    return agir(() => adminApi.removerVinculoUnidade(usuario, unidade), "Acesso à unidade removido.");
  },

  // ---- Financeiro
  "plano-novo": () => abrirModal({
    titulo: "Novo plano",
    corpo: grade(
      campo({ id: "p-codigo", label: "Código", ph: "ex: pro", obrigatorio: true, dica: "Identificador técnico, sem espaços." }) +
      campo({ id: "p-nome", label: "Nome", obrigatorio: true }) +
      campo({ id: "p-mensal", label: "Preço mensal", tipo: "number" }) +
      campo({ id: "p-anual", label: "Preço anual", tipo: "number" }) +
      campo({ id: "p-un", label: "Limite de unidades", tipo: "number", ph: "vazio = ilimitado" }) +
      campo({ id: "p-us", label: "Limite de usuários", tipo: "number", ph: "vazio = ilimitado" }) +
      area({ id: "p-desc", label: "Descrição" })
    ),
    confirmar: "Criar plano",
    aoConfirmar: async () => {
      await adminApi.criarPlano({
        codigo: valor("p-codigo"), nome: valor("p-nome"), descricao: valor("p-desc") || undefined,
        precoMensal: valor("p-mensal") || 0, precoAnual: valor("p-anual") || 0,
        limiteUnidades: valor("p-un") || null, limiteUsuarios: valor("p-us") || null,
      });
      toast("Plano criado.");
      recarregarAdmin();
    },
  }),

  "plano-editar": ({ id }) => {
    const p = cache.planos.find((x) => x.id === id);
    if (!p) return toast("Plano não encontrado. Atualize a página.");
    abrirModal({
      titulo: `Editar ${p.nome}`,
      corpo: grade(
        campo({ id: "p-nome", label: "Nome", valor: p.nome, obrigatorio: true }) +
        campo({ id: "p-mensal", label: "Preço mensal", valor: p.preco_mensal, tipo: "number" }) +
        campo({ id: "p-anual", label: "Preço anual", valor: p.preco_anual, tipo: "number" }) +
        campo({ id: "p-un", label: "Limite de unidades", valor: p.limite_unidades ?? "", tipo: "number", ph: "vazio = ilimitado" }) +
        campo({ id: "p-us", label: "Limite de usuários", valor: p.limite_usuarios ?? "", tipo: "number", ph: "vazio = ilimitado" }) +
        selecao({ id: "p-ativo", label: "Situação", valor: String(p.ativo),
          opcoes: [{ valor: "true", rotulo: "Ativo" }, { valor: "false", rotulo: "Inativo" }] }) +
        area({ id: "p-desc", label: "Descrição", valor: p.descricao ?? "" })
      ),
      aoConfirmar: async () => {
        await adminApi.atualizarPlano(id, {
          nome: valor("p-nome"), descricao: valor("p-desc"),
          precoMensal: valor("p-mensal") || 0, precoAnual: valor("p-anual") || 0,
          limiteUnidades: valor("p-un") === "" ? null : valor("p-un"),
          limiteUsuarios: valor("p-us") === "" ? null : valor("p-us"),
          ativo: valor("p-ativo") === "true",
        });
        toast("Plano atualizado.");
        recarregarAdmin();
      },
    });
  },

  "assinatura-nova": () => abrirModal({
    titulo: "Nova assinatura",
    corpo: `<div class="adm-aviso">A assinatura viva anterior da empresa, se houver, será cancelada e substituída.</div>` +
      grade(
        selecao({ id: "a-org", label: "Empresa", opcoes: cache.empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) }) +
        selecao({ id: "a-plano", label: "Plano", opcoes: cache.planos.map((p) => ({ valor: p.id, rotulo: p.nome })) }) +
        selecao({ id: "a-ciclo", label: "Ciclo", valor: "mensal",
          opcoes: [{ valor: "mensal", rotulo: "Mensal" }, { valor: "anual", rotulo: "Anual" }] }) +
        selecao({ id: "a-status", label: "Status", valor: "ativa",
          opcoes: Object.entries(STATUS_ASSINATURA).map(([valor, m]) => ({ valor, rotulo: m.rotulo })) }) +
        campo({ id: "a-valor", label: "Valor negociado", tipo: "number", ph: "vazio = preço do plano" }) +
        campo({ id: "a-prox", label: "Próxima cobrança", tipo: "date" })
      ),
    confirmar: "Criar assinatura",
    aoConfirmar: async () => {
      await adminApi.criarAssinatura({
        organizacaoId: valor("a-org"), planoId: valor("a-plano"),
        ciclo: valor("a-ciclo"), status: valor("a-status"),
        valor: valor("a-valor") === "" ? undefined : valor("a-valor"),
        proximaCobrancaEm: valor("a-prox") || undefined,
      });
      toast("Assinatura criada.");
      recarregarAdmin();
    },
  }),

  "assinatura-editar": ({ id, status }) => abrirModal({
    titulo: "Editar assinatura",
    corpo: grade(
      selecao({ id: "ae-status", label: "Status", valor: status,
        opcoes: Object.entries(STATUS_ASSINATURA).map(([valor, m]) => ({ valor, rotulo: m.rotulo })) }) +
      campo({ id: "ae-valor", label: "Valor", tipo: "number", ph: "deixe vazio para manter" }) +
      campo({ id: "ae-prox", label: "Próxima cobrança", tipo: "date" })
    ),
    aoConfirmar: async () => {
      const dados = { status: valor("ae-status") };
      if (valor("ae-valor")) dados.valor = valor("ae-valor");
      if (valor("ae-prox")) dados.proximaCobrancaEm = valor("ae-prox");
      await adminApi.atualizarAssinatura(id, dados);
      toast("Assinatura atualizada.");
      recarregarAdmin();
    },
  }),

  "cobranca-nova": () => abrirModal({
    titulo: "Nova cobrança",
    corpo: grade(
      selecao({ id: "c-org", label: "Empresa", opcoes: cache.empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) }) +
      campo({ id: "c-comp", label: "Competência", tipo: "date", dica: "Mês de referência (use o dia 1)." }) +
      campo({ id: "c-valor", label: "Valor", tipo: "number", obrigatorio: true }) +
      campo({ id: "c-venc", label: "Vencimento", tipo: "date" }) +
      campo({ id: "c-metodo", label: "Método", ph: "pix, boleto, cartão…" })
    ),
    confirmar: "Criar cobrança",
    aoConfirmar: async () => {
      await adminApi.criarCobranca({
        organizacaoId: valor("c-org"), competencia: valor("c-comp") || undefined,
        valor: valor("c-valor"), vencimento: valor("c-venc") || undefined,
        metodo: valor("c-metodo") || undefined,
      });
      toast("Cobrança criada.");
      recarregarAdmin();
    },
  }),

  "cobranca-pagar": ({ id }) =>
    agir(() => adminApi.atualizarCobranca(id, { status: "paga" }), "Cobrança marcada como paga."),

  // ---- Auditoria
  "auditoria-filtrar": () => {
    filtrosAuditoria = {
      acao: valor("au-acao"), organizacaoId: valor("au-org"), busca: valor("au-busca"),
      desde: valor("au-desde"), ate: valor("au-ate"),
      soImpersonacao: !!el("#au-imp")?.checked,
    };
    recarregarAdmin();
  },

  "auditoria-limpar": () => {
    filtrosAuditoria = { acao: "", organizacaoId: "", busca: "", desde: "", ate: "", soImpersonacao: false };
    recarregarAdmin();
  },

  // ---- Consumo do Agente Crescer (tela IA)
  "agente-uso-filtrar": () => {
    filtrosConsumoAgente = { periodo: valor("ia-periodo") || "este_mes", desde: valor("ia-desde"), ate: valor("ia-ate") };
    paginaConsumoAgente = 1;
    recarregarAdmin();
  },
  "agente-uso-limpar": () => {
    filtrosConsumoAgente = { periodo: "este_mes", desde: "", ate: "" };
    paginaConsumoAgente = 1;
    recarregarAdmin();
  },
  "agente-uso-pagina": (dados) => {
    paginaConsumoAgente = Math.max(1, Number(dados.pagina) || 1);
    recarregarAdmin();
  },

  // ---- Configurações
  "config-salvar": (_dados, alvo) => {
    // Junta os campos da MESMA seção do botão. Salvar tudo de uma vez enviaria
    // chaves de grupos que o operador não abriu.
    const secaoEl = alvo.closest(".adm-secao");
    const payload = {};
    for (const inp of secaoEl.querySelectorAll("[data-chave]")) {
      const chave = inp.dataset.chave;
      if (inp.dataset.secreto) {
        // Vazio = "não mexer". O backend interpreta igual, mas nem enviar já
        // deixa a intenção explícita.
        if (inp.value) payload[chave] = inp.value;
        continue;
      }
      if (inp.dataset.tipo === "bool") payload[chave] = inp.checked;
      else if (inp.dataset.tipo === "number") payload[chave] = Number(inp.value);
      else payload[chave] = inp.value;
    }
    if (!Object.keys(payload).length) return toast("Nada para salvar.");
    return agir(() => adminApi.salvarConfiguracoes(payload), "Configurações salvas.");
  },
};

// Um único listener para todas as ações de todas as views.
document.addEventListener("admin:acao", (e) => {
  const { acao, dados, alvo } = e.detail;
  const fn = ACOES[acao];
  if (!fn) return;
  Promise.resolve(fn(dados, alvo)).catch((err) => toast("Erro: " + err.message));
});
