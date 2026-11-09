import { state, linhasFiltradas, tabelaAtiva, emComparacao } from "./state.js";
import { INTEGRACOES_LOGOS, STATUS_INTEGRACAO } from "./config.js";
import { acoesTabela } from "./actions.js";
import { el, fmtMoeda, fmtPct, fmtTexto, fmtHora, fmtRelativo, escapeHtml, temValor, statusCmv } from "./utils.js";
import { renderGraficos } from "./charts.js";
import { obterHistoricoRecente, obterCatalogoIntegracoes } from "./api.js";
import { abrirHistoricoModal, fmtValor } from "./historicoModal.js";
import { icon } from "./icons.js";
import { botaoContextualHtml, ligarBotoesContextuais } from "./agentePainel.js";
import { linhasCatalogoSemPreco, linhaCatalogoHtml, carregarCatalogoProdutos } from "./produtosCatalogo.js";

// ---------- rótulos ----------
const CAT_LABEL = {
  sanduiche: "Sanduíche", salada: "Salada", bebida: "Bebida", sobremesa: "Sobremesa",
  chips: "Chips", adicional: "Adicional", acompanhamento: "Acompanhamento",
  combo: "Combo", submontagem: "Submontagem", outro: "Outro",
};
const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const catLabel = (t) => (temValor(t) ? (CAT_LABEL[t] || t[0].toUpperCase() + t.slice(1)) : "—");
const canalLabel = (c) => CANAL_LABEL[c] || fmtTexto(c);

// ---------- componentes reutilizáveis ----------
const card = (label, valor, classe = "", sub = "") =>
  `<div class="card ${classe}"><div class="card-label">${label}</div><div class="card-valor">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;

const cardDestaque = (label, valor, sub = "") =>
  `<div class="card destaque"><div class="card-label">${label}</div><div class="card-valor pequeno">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;

const estadoVazio = (nomeIcone, titulo, msg) =>
  `<div class="estado"><span class="estado-ic">${icon(nomeIcone, { size: 24 })}</span><h3>${titulo}</h3><p>${escapeHtml(msg)}</p></div>`;

// `state.erroCodigo` distingue uma FALHA real (rede, servidor) de uma
// RESTRIÇÃO de contexto esperada (ex.: "Todas as unidades" olhando um módulo
// por unidade) — a segunda não é erro, é um estado normal, e por isso nunca
// usa o vermelho de `.banner-erro` (item 12/13 do pedido: reservar vermelho
// pra erro real).
const bannerErro = () => {
  if (!state.erro) return "";
  if (state.erroCodigo) return `<div class="banner-aviso">${escapeHtml(state.erro)}</div>`;
  return `<div class="banner-erro">Erro ao carregar: ${escapeHtml(state.erro)}</div>`;
};

// Estado dedicado para "esta área precisa de uma unidade" (código
// UNIDADE_NAO_SELECIONADA, ver cmv.service.js#listarMargensOficialOuComparacao).
// Substitui a tela INTEIRA — nunca ao lado de cards/tabela zerados (item 13/14:
// "CMV geral —, Total de produtos 0, ✓ Tabela da unidade" com contexto
// consolidado parecia um dashboard real vazio, não uma restrição de contexto).
// O botão reabre o MESMO seletor global do topbar (item 10/11: nenhum fluxo
// paralelo) via o evento que app.js escuta.
const estadoUnidadeObrigatoria = () => `
  <div class="estado estado-unidade-obrigatoria">
    <span class="estado-ic">${icon("building", { size: 24 })}</span>
    <h3>Esta área precisa de uma unidade específica</h3>
    <p>Você está visualizando todas as unidades de ${escapeHtml(state.sessao?.empresa?.nome ?? "sua empresa")}. Selecione uma unidade para continuar.</p>
    <button type="button" class="btn btn-primary btn-sm" id="btn-selecionar-unidade">${icon("building", { size: 14 })} Selecionar unidade</button>
  </div>`;

function ligarEstadoUnidadeObrigatoria(root) {
  root.querySelector("#btn-selecionar-unidade")?.addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent("app:abrir-seletor-unidade")));
}

// ---------- banner Canal · Tabela (Dashboard comum + Produtos/CMV) ----------
// Distinção visual EXPLÍCITA, não só cor: modo de comparação tem rótulo
// próprio + a tabela oficial escrita ao lado (nunca escondida) + botão de
// volta. Comparar aqui NUNCA altera unidades.tabela_balcao/tabela_ifood —
// isso só acontece em Configurações → Tabelas Comerciais (ver
// configuracoes.js), com permissão própria.
function bannerTabela() {
  const canal = state.canal;
  const rotuloCanal = canalLabel(canal);
  const oficial = state.tabelasOficiais[canal];
  const tabelaMostrada = tabelaAtiva();

  if (emComparacao()) {
    return `
      <div class="banner-tabela banner-tabela--comparacao">
        <div class="banner-tabela-txt">
          <span class="banner-tabela-canal">${rotuloCanal} · Tabela ${fmtTexto(tabelaMostrada)}</span>
          <span class="pill warn banner-tabela-badge">Modo de comparação</span>
          <span class="banner-tabela-oficial">Tabela oficial da unidade: <b>${oficial ? escapeHtml(oficial) : "não configurada"}</b></span>
        </div>
        <button class="btn btn-ghost btn-sm" id="btn-tabela-usar-oficial">${icon("undo", { size: 14 })} Usar tabela oficial</button>
      </div>`;
  }

  return `
    <div class="banner-tabela banner-tabela--oficial">
      <div class="banner-tabela-txt">
        <span class="banner-tabela-canal">${rotuloCanal} · Tabela ${tabelaMostrada ? escapeHtml(tabelaMostrada) : "—"}</span>
        <span class="pill ok banner-tabela-badge">✓ Tabela da unidade</span>
      </div>
    </div>`;
}

function ligarBannerTabela(root) {
  root.querySelector("#btn-tabela-usar-oficial")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("app:voltar-tabela-oficial")));
}

// ======================= DASHBOARD =======================
function statsDashboard(rows) {
  const comCmv = rows.filter((r) => temValor(r.cmv_pct));
  const cmvMedio = comCmv.length ? comCmv.reduce((s, r) => s + Number(r.cmv_pct), 0) / comCmv.length : null;
  const best = rows.reduce((a, b) => (Number(b.lucro_liquido ?? -Infinity) > Number(a?.lucro_liquido ?? -Infinity) ? b : a), null);
  const cmvAlto = rows.filter((r) => r._status?.chave === "critico").length;
  const semCusto = rows.filter((r) => !temValor(r.custo) || Number(r.custo) === 0).length;
  const desatualizados = rows.filter((r) => r.desatualizado).length;
  return { total: rows.length, cmvMedio, best, cmvAlto, semCusto, desatualizados };
}

// Alertas contam para o sino de notificações da topbar
export function contarAlertas(rows) {
  const s = statsDashboard(rows);
  return s.semCusto + s.cmvAlto + s.desatualizados;
}

const alertaItem = (label, valor, classe, nota = "") =>
  `<li class="alerta-item">
    <span class="alerta-dot ${classe}"></span>
    <span class="alerta-label">${label}${nota ? `<small>${nota}</small>` : ""}</span>
    <span class="alerta-valor pill ${classe}">${valor}</span>
  </li>`;

export function renderDashboard() {
  if (state.erroCodigo === "UNIDADE_NAO_SELECIONADA") {
    el("#view").innerHTML = estadoUnidadeObrigatoria();
    ligarEstadoUnidadeObrigatoria(el("#view"));
    return;
  }

  const rows = state.linhas;
  const carregando = state.carregando;
  const s = statsDashboard(rows);
  const v = (x) => (carregando ? "…" : x);

  const stMedio = statusCmv(s.cmvMedio);

  el("#view").innerHTML = `
    ${bannerErro()}
    ${bannerTabela()}

    <!-- Indicadores -->
    <p class="secao-titulo">${icon("target", { size: 16 })} Indicadores</p>
    <div class="cards">
      ${card("CMV geral", v(s.cmvMedio != null ? s.cmvMedio.toFixed(1) + "%" : "—"), stMedio.classe === "bad" ? "alerta" : "", "média do catálogo")}
      ${card("Total de produtos", v(s.total), "", "com preço nesta tabela")}
      ${cardDestaque("Mais lucrativo", carregando ? "…" : (s.best ? escapeHtml(s.best.nome) : "—"), carregando || !s.best ? "" : fmtMoeda(s.best.lucro_liquido))}
    </div>

    <!-- Alertas + Últimas alterações -->
    <div class="dash-2col">
      <div class="painel">
        <div class="painel-head"><h4>${icon("alert-triangle", { size: 15 })} Alertas Operacionais</h4></div>
        <ul class="alerta-lista">
          ${alertaItem("Produtos sem custo", v(s.semCusto), s.semCusto > 0 ? "bad" : "ok")}
          ${alertaItem("Produtos com CMV alto", v(s.cmvAlto), s.cmvAlto > 0 ? "warn" : "ok")}
          ${alertaItem("Preços desatualizados", v(s.desatualizados), s.desatualizados > 0 ? "warn" : "ok")}
          ${alertaItem("Itens sem estoque", "—", "muted", "aguardando módulo de Estoque")}
          ${alertaItem("Custo desatualizado", "—", "muted", "aguardando Martin Brower")}
        </ul>
      </div>
      <div class="painel">
        <div class="painel-head"><h4>${icon("clock", { size: 15 })} Últimas alterações</h4></div>
        <div class="ultimas">
          <div id="dash-ultimas" class="ultimas-lista">
            <div class="ultima-skel"></div><div class="ultima-skel"></div><div class="ultima-skel"></div>
          </div>
          <div class="ultimas-rodape">
            <span class="alerta-dot ok"></span> Sincronizado <b>${fmtHora(state.atualizadoEm)}</b> · ${s.total} produto(s)
          </div>
        </div>
      </div>
    </div>

    <!-- Gráficos -->
    <p class="secao-titulo">${icon("bar-chart", { size: 16 })} Análise Visual</p>
    <div class="charts-grid">
      <div class="painel chart-box"><div class="painel-head"><h4>Top mais lucrativos</h4></div><div class="chart-wrap"><canvas id="chart-top"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Menos lucrativos</h4></div><div class="chart-wrap"><canvas id="chart-bottom"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Custo por categoria</h4></div><div class="chart-wrap"><canvas id="chart-custo"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Status de CMV</h4></div><div class="chart-wrap"><canvas id="chart-status"></canvas></div></div>
    </div>

    ${!carregando && !state.erro && !rows.length ? estadoVazio("inbox", "Sem dados", "Não há produtos com preço para este canal/tabela.") : ""}
  `;

  if (!carregando && rows.length) renderGraficos(rows);
  ligarBannerTabela(el("#view"));
  carregarUltimasAlteracoes();
}

// ---- Painel "Últimas alterações": alimenta com o histórico real de auditoria ----
function resumoMudancas(mudancas) {
  const m0 = mudancas[0];
  const de = m0.valor_anterior == null ? "" : `<s>${escapeHtml(fmtValor(m0.campo, m0.valor_anterior))}</s> → `;
  const principal = `<span class="um-campo">${escapeHtml(m0.rotulo)}</span> ${de}<b>${escapeHtml(fmtValor(m0.campo, m0.valor_novo))}</b>`;
  const extra = mudancas.length > 1 ? ` <span class="um-mais">+${mudancas.length - 1}</span>` : "";
  return principal + extra;
}

async function carregarUltimasAlteracoes() {
  const box = el("#dash-ultimas");
  if (!box) return;
  try {
    const { data } = await obterHistoricoRecente(6);
    if (el("#dash-ultimas") !== box) return; // dashboard já foi re-renderizado

    if (data.pendente) {
      box.innerHTML = `<div class="estado-mini">O histórico de alterações começa a ser registrado assim que o módulo de auditoria for ativado no banco (migration <code>002_produto_historico.sql</code>).</div>`;
      return;
    }
    if (!data.eventos.length) {
      box.innerHTML = `<div class="estado-mini">Nenhuma alteração registrada ainda. Edições de produtos (nome, categoria, status e preços) aparecerão aqui, com autor e horário.</div>`;
      return;
    }

    box.innerHTML = data.eventos.map((e) => {
      const autor = e.usuario_nome || e.usuario_email || "Usuário";
      return `
        <button class="ultima-mudanca" data-produto="${e.produto_id}" data-nome="${escapeHtml(e.produto_nome)}" title="Ver histórico de ${escapeHtml(e.produto_nome)}">
          <span class="alerta-dot ok"></span>
          <span class="um-corpo">
            <span class="um-topo"><b class="um-produto">${escapeHtml(e.produto_nome)}</b><span class="um-quando">${fmtRelativo(e.created_at)}</span></span>
            <span class="um-detalhe">${resumoMudancas(e.mudancas)}</span>
            <span class="um-autor">por ${escapeHtml(autor)}</span>
          </span>
        </button>`;
    }).join("");

    box.querySelectorAll(".ultima-mudanca").forEach((btn) =>
      btn.addEventListener("click", () => abrirHistoricoModal(btn.dataset.produto, btn.dataset.nome)));
  } catch {
    box.innerHTML = `<div class="estado-mini">Não foi possível carregar as últimas alterações agora.</div>`;
  }
}

// ======================= PRODUTOS / CMV =======================
let _linhas = []; // linhas renderizadas (para as ações)
export function getLinha(idx) { return _linhas[Number(idx)]; }

const skeleton = (n) =>
  Array.from({ length: n }).map(() => `<tr class="skeleton-row"><td colspan="11"><span class="sk"></span></td></tr>`).join("");

const linhaEstado = (classe, nomeIcone, titulo, msg) =>
  `<tr><td colspan="11"><div class="estado ${classe}"><span class="estado-ic">${icon(nomeIcone, { size: 24 })}</span><h3>${titulo}</h3><p>${escapeHtml(msg || "")}</p></div></td></tr>`;

const linhaProduto = (r, i) => `
  <tr>
    <td>${catLabel(r.categoria)}</td>
    <td>${canalLabel(r.canal)}</td>
    <td>${fmtTexto(r.tabela)}</td>
    <td class="prod-nome"><button class="prod-link" data-idx="${i}">${escapeHtml(r.nome)}</button>${r.desatualizado ? '<span class="badge">2024</span>' : ""}</td>
    <td>${fmtTexto(r.tamanho)}</td>
    <td class="num">${fmtMoeda(r.preco)}</td>
    <td class="num">${fmtMoeda(r.custo)}</td>
    <td class="num"><span class="pill ${r._status.classe}">${fmtPct(r.cmv_pct)}</span></td>
    <td class="num">${fmtMoeda(r.lucro_liquido)}</td>
    <td><span class="pill ${r._status.classe}">${r._status.label}</span></td>
    <td><div class="acoes">${acoesTabela().map((a) => `<button class="acao-btn${a.chave === "remover" ? " acao-perigo" : ""}" data-acao="${a.chave}" data-idx="${i}" title="${a.titulo}" aria-label="${a.titulo}">${a.icon}</button>`).join("")}</div></td>
  </tr>`;

export function renderTabela() {
  const tb = el("#tbody");
  if (!tb) return;
  const rc = el("#result-count");

  if (state.carregando) { tb.innerHTML = skeleton(6); if (rc) rc.textContent = ""; return; }
  // Catálogo de empresa independente (produtos importados sem preço): vazio para as Subways, então nada muda para elas.
  const extra = linhasCatalogoSemPreco();
  // Unidade sem tabela comercial é um estado esperado: quem tem catálogo ainda vê seus produtos (o banner explica a tabela).
  const erroBloqueia = state.erro && !(extra.length && state.erroCodigo === "TABELA_NAO_CONFIGURADA");
  if (erroBloqueia) { tb.innerHTML = linhaEstado("erro", "alert-triangle", "Falha ao carregar", state.erro); if (rc) rc.textContent = ""; return; }

  const rows = state.erro ? [] : linhasFiltradas();
  _linhas = [...rows, ...extra];
  if (rc) rc.textContent = `${_linhas.length} de ${state.linhas.length + extra.length} produtos`;

  if (!_linhas.length) {
    tb.innerHTML = linhaEstado("", "inbox", "Nada encontrado",
      state.linhas.length ? "Ajuste a busca ou os filtros." : "Sem produtos para este canal/tabela.");
    return;
  }
  tb.innerHTML = rows.map((r, i) => linhaProduto(r, i)).join("") + extra.map((r, j) => linhaCatalogoHtml(r, rows.length + j)).join("");
}

export function renderProdutos() {
  if (state.erroCodigo === "UNIDADE_NAO_SELECIONADA") {
    el("#view").innerHTML = estadoUnidadeObrigatoria();
    ligarEstadoUnidadeObrigatoria(el("#view"));
    return;
  }

  el("#view").innerHTML = `
    ${bannerErro()}
    ${bannerTabela()}
    <div class="toolbar">
      <div class="busca"><input id="f-busca" type="search" placeholder="Buscar produto..." value="${escapeHtml(state.busca)}" /></div>
      <select id="f-status">
        <option value="todos">Todos os CMV</option>
        <option value="saudavel">Saudável</option>
        <option value="atencao">Atenção</option>
        <option value="critico">Crítico</option>
      </select>
      <span id="pc-filtros" class="pc-filtros"></span>
      <button id="f-atualizar" class="btn btn-ghost btn-sm">${icon("refresh", { size: 14 })} Atualizar</button>
      <span class="result-count" id="result-count"></span>
      ${botaoContextualHtml("products_cmv_lista")}
    </div>
    <div class="tabela-wrap">
      <table class="grid">
        <thead><tr>
          <th>Categoria</th><th>Canal</th><th>Tabela</th><th>Produto</th><th>Tamanho</th>
          <th class="num">Preço</th><th class="num">Custo</th><th class="num">CMV</th>
          <th class="num">Lucro líq.</th><th>Status</th><th>Ações</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <p class="rodape">CMV = custo ÷ preço · Lucro líquido já desconta a comissão do canal · dados do seu Supabase</p>
  `;
  el("#f-status").value = state.filtroStatus;
  el("#f-busca").addEventListener("input", (e) => { state.busca = e.target.value; renderTabela(); });
  el("#f-status").addEventListener("change", (e) => { state.filtroStatus = e.target.value; renderTabela(); });
  el("#f-atualizar").addEventListener("click", () => document.dispatchEvent(new CustomEvent("app:reload")));
  ligarBotoesContextuais(el("#view"));
  ligarBannerTabela(el("#view"));
  renderTabela();
  carregarCatalogoProdutos(renderTabela); // catálogo de empresa independente (no-op visual para as Subways)
}

// ======================= INTEGRAÇÕES =======================
// O catálogo (descrições/features/status) vem do backend, atrás do módulo
// `inteligencia` — GET /api/v1/inteligencia/integracoes. Nada disso mora mais
// no bundle: sem o módulo a chamada dá 403 e a página mostra o aviso de acesso.
function integraCard(ig) {
  const st = STATUS_INTEGRACAO[ig.status] || STATUS_INTEGRACAO.nao_conectado;
  const features = Array.isArray(ig.features) ? ig.features : [];
  return `<div class="integra-card">
    <div class="integra-head">
      <div class="integra-icon">${ig.logo ? `<img src="${escapeHtml(ig.logo)}" alt="${escapeHtml(ig.nome)}" class="integra-logo" />` : icon(ig.icon, { size: 22 })}</div>
      <div><div class="integra-nome">${escapeHtml(ig.nome)}</div><span class="pill ${st.classe}">${st.label}</span></div>
    </div>
    <div class="integra-desc">${escapeHtml(ig.desc || "")}</div>
    <ul class="integra-features">${features.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
  </div>`;
}

/** Aviso quando o catálogo recusa (403 — empresa sem o módulo `inteligencia`). */
function integracoesSemAcesso() {
  el("#view").innerHTML = estadoVazio("link", "Integrações", "Esta área é restrita — fale com a administração da plataforma.");
}

export async function renderIntegracoes() {
  el("#view").innerHTML = `
    <p class="secao-titulo">${icon("link", { size: 16 })} Integrações do sistema</p>
    <p style="color:var(--cinza);font-size:14px;margin:-6px 0 16px">Conforme cada integração for conectada, os dados fluem automaticamente para o painel.</p>
    <div class="integra-grid" id="integra-grid"><p style="color:var(--cinza)">Carregando…</p></div>`;
  try {
    const { data } = await obterCatalogoIntegracoes();
    const cards = (data?.integracoes ?? []).map(integraCard).join("");
    const grid = el("#integra-grid");
    if (grid) grid.innerHTML = cards;
  } catch {
    integracoesSemAcesso();
  }
}

export async function renderIntegracaoDetalhe(key, rotulo) {
  try {
    const { data } = await obterCatalogoIntegracoes();
    const ig = (data?.integracoes ?? []).find((i) => i.chave === key);
    if (!ig) { el("#view").innerHTML = estadoVazio("link", "Integração", "Não encontrada."); return; }
    el("#view").innerHTML = `<div class="integra-grid" style="grid-template-columns:minmax(0,560px)">${integraCard(ig)}</div>`;
  } catch {
    // Sem o módulo `inteligencia`: mostra um card mínimo com o pouco que o
    // menu já expõe (rótulo + logo), sem detalhes do catálogo.
    const logo = INTEGRACOES_LOGOS[key];
    el("#view").innerHTML = `<div class="integra-grid" style="grid-template-columns:minmax(0,560px)">
      <div class="integra-card">
        <div class="integra-head">
          <div class="integra-icon">${logo ? `<img src="${escapeHtml(logo)}" alt="" class="integra-logo" />` : icon("link", { size: 22 })}</div>
          <div><div class="integra-nome">${escapeHtml(rotulo || "Integração")}</div></div>
        </div>
        <div class="integra-desc">Integração operacional do sistema.</div>
      </div></div>`;
  }
}

// ======================= PÁGINAS EM CONSTRUÇÃO =======================
const CONSTRUCAO = {
  estoque: { icone: "package", desc: "Entrada, saída, perdas, vencimentos, transferências e inventário — com baixa automática por venda (o trigger já existe no banco).", planejado: ["Entrada por fornecedor", "Saída automática por venda", "Perdas e vencimentos", "Inventário"] },
  distribuidoras: { icone: "truck", desc: "Pedidos, entregas, notas fiscais, divergências e histórico de compras por fornecedor.", planejado: ["Pedidos de compra", "Conferência de entrega", "Notas fiscais", "Divergências"] },
  vendas: { icone: "receipt", desc: "Consolida os fechamentos de caixa diários (SWFast) — o que vendeu e como vendeu — alimentando o CMV real e a baixa de estoque. Não registra vendas nem faz fechamento; apenas recebe e agrega.", planejado: ["Importar fechamento diário", "Mix de produtos vendidos", "CMV real x teórico", "Formas de pagamento"] },
  relatorios: { icone: "pie-chart", desc: "Relatórios de faturamento, CMV, margem, desperdício e comparativo entre canais.", planejado: ["Faturamento diário / mensal", "CMV por período", "Comparativo balcão x iFood"] },
  configuracoes: { icone: "settings", desc: "Parâmetros da unidade: metas, tabela de preço ativa, limites de CMV e usuários.", planejado: ["Metas e limites", "Tabela ativa", "Usuários e permissões"] },
};

export function renderConstrucao(id, titulo) {
  const c = CONSTRUCAO[id] || { icone: "hammer", desc: "Em breve.", planejado: [] };
  el("#view").innerHTML = `
    <div class="construcao">
      <span class="estado-ic">${icon(c.icone, { size: 28 })}</span>
      <h2>${titulo}</h2>
      <p>${c.desc}</p>
      <div class="planejado">${c.planejado.map((p) => `<span>→ ${p}</span>`).join("")}</div>
    </div>`;
}
