// Modal de edição de produto: nome, categoria, status e preços.
import { obterProduto, atualizarProduto } from "./api.js";
import { fmtMoeda, fmtTexto, escapeHtml, toast } from "./utils.js";
import { state } from "./state.js";

const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const TIPOS = [
  ["sanduiche", "Sanduíche"], ["salada", "Salada"], ["bebida", "Bebida"], ["sobremesa", "Sobremesa"],
  ["chips", "Chips"], ["adicional", "Adicional"], ["acompanhamento", "Acompanhamento"],
  ["combo", "Combo"], ["outro", "Outro"],
];

let overlay = null;
function fechar() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}
function onKey(e) { if (e.key === "Escape") fechar(); }

export async function abrirEditarModal(produtoId) {
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="estado"><div class="spinner"></div>Carregando…</div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  try {
    const { data } = await obterProduto(produtoId);
    render(data);
  } catch (e) {
    overlay.querySelector(".modal").innerHTML =
      `<button class="modal-close">×</button><div class="estado erro"><span class="emoji">⚠️</span><h3>Erro</h3><p>${escapeHtml(e.message)}</p></div>`;
    overlay.querySelector(".modal-close").addEventListener("click", fechar);
  }
}

function render(p) {
  // Empresa própria (sem tabela comercial): sempre Balcão (primeiro) e iFood, um preço por canal, sem coluna Tabela.
  // Preparação intermediária (vendavel === false) não tem preço de venda.
  const propria = !state.exigeTabela;
  const vendavel = p.vendavel !== false;
  let precos = p.precos ?? [];
  if (propria && vendavel) {
    const sem = (c) => precos.find((x) => x.canal === c && !x.tabela) ?? { canal: c, tabela: null, preco: null, desatualizado: false };
    precos = [sem("balcao"), sem("ifood"), ...precos.filter((x) => x.tabela || !["balcao", "ifood"].includes(x.canal))];
  }
  const precoRows = precos.length
    ? precos.map((pr, i) => `
        <tr>
          <td>${CANAL_LABEL[pr.canal] || pr.canal}</td>
          ${propria ? "" : `<td>${fmtTexto(pr.tabela)}</td>`}
          <td class="num">
            <input class="ed-preco" type="number" min="0" step="0.01" placeholder="0,00" value="${pr.preco ?? ""}"
              data-canal="${pr.canal}" data-tabela="${escapeHtml(pr.tabela ?? "")}" data-desat="${pr.desatualizado ? 1 : 0}" />
          </td>
        </tr>`).join("")
    : `<tr><td colspan="3"><div class="estado"><p>${propria && !vendavel ? "Preparação intermediária: não tem preço de venda." : "Sem preços cadastrados."}</p></div></td></tr>`;

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>✏️ Editar produto</h2></div>

    <div class="ed-grid">
      <label class="ed-campo">
        <span>Nome</span>
        <input id="ed-nome" type="text" value="${escapeHtml(p.nome ?? "")}" />
      </label>
      <label class="ed-campo">
        <span>Categoria</span>
        <select id="ed-tipo">${TIPOS.map(([v, l]) => `<option value="${v}" ${v === p.tipo ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
      <label class="ed-campo">
        <span>Custo (R$)</span>
        <input id="ed-custo" type="number" min="0" step="0.01" value="${p.custo_manual ?? ""}" placeholder="auto: ${fmtMoeda(p.custo_calculado ?? p.custo)}" />
        <small class="ed-hint">Vazio = custo calculado pela ficha técnica</small>
      </label>
      <label class="ed-campo ed-check">
        <input id="ed-ativo" type="checkbox" ${p.ativo ? "checked" : ""} />
        <span>Produto ativo</span>
      </label>
    </div>

    <div class="modal-sec-titulo">💵 Preços</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Canal</th>${propria ? "" : "<th>Tabela</th>"}<th class="num">Preço</th></tr></thead>
        <tbody>${precoRows}</tbody>
      </table>
    </div>

    <div class="ed-erro" id="ed-erro" hidden></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="ed-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="ed-salvar">Salvar alterações</button>
    </div>
  `;

  const m = overlay.querySelector(".modal");
  m.querySelector(".modal-close").addEventListener("click", fechar);
  m.querySelector("#ed-cancelar").addEventListener("click", fechar);
  m.querySelector("#ed-salvar").addEventListener("click", () => salvar(p.id, m));
}

async function salvar(id, m) {
  const erroBox = m.querySelector("#ed-erro");
  const btn = m.querySelector("#ed-salvar");
  const nome = m.querySelector("#ed-nome").value.trim();
  if (!nome) { erroBox.textContent = "O nome não pode ficar vazio."; erroBox.hidden = false; return; }

  const precos = [...m.querySelectorAll(".ed-preco")].map((inp) => ({
    canal: inp.dataset.canal,
    tabela: inp.dataset.tabela || null,
    preco: inp.value,
    desatualizado: inp.dataset.desat === "1",
  }));

  const dados = {
    nome,
    tipo: m.querySelector("#ed-tipo").value,
    ativo: m.querySelector("#ed-ativo").checked,
    custo: m.querySelector("#ed-custo").value,
    precos,
  };

  btn.disabled = true;
  btn.textContent = "Salvando…";
  erroBox.hidden = true;
  try {
    await atualizarProduto(id, dados);
    toast(`"${nome}" atualizado com sucesso.`);
    fechar();
    document.dispatchEvent(new CustomEvent("app:reload")); // atualiza a tabela
  } catch (e) {
    erroBox.textContent = "Erro ao salvar: " + e.message;
    erroBox.hidden = false;
    btn.disabled = false;
    btn.textContent = "Salvar alterações";
  }
}
