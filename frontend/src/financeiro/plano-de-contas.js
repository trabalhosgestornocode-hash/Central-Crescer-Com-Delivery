// Plano de Contas — categorias dinâmicas por empresa. O PAPEL decide a participação nos cálculos; mudar papel de categoria
// em uso é recusado pelo banco (reclassificação histórica é explícita e auditada, nunca silenciosa).
import { fin } from "./api.js";
import { ROTULO_PAPEL, podeAcao, ACAO } from "./modelo.js";
import { garantirCss, cabecalho, tabela, badge, carregarEm, dialogo, campo, selecao, aviso, esc, estado } from "./ui.js";

const OPCOES_PAPEL = Object.entries(ROTULO_PAPEL).filter(([v]) => v !== "saldo_anterior").map(([valor, rotulo]) => ({ valor, rotulo }));

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pode = podeAcao(ctx, ACAO.CONFIGURAR);
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    titulo: "Plano de Contas", sub: "Tipo → natureza → categoria. O papel define se a categoria é receita, custo, despesa, tributo, financiamento ou transferência nos cálculos.",
    extra: pode ? `<button class="btn btn-primary btn-sm" data-nova>Nova categoria</button>` : "",
  });

  function carregar() {
    carregarEm(corpo, () => fin.get("/plano-contas"), (cats) => {
      if (!cats.length) { corpo.innerHTML = estado.vazio("Plano de contas vazio", pode ? "Crie categorias ou importe o livro-caixa para que o plano seja montado a partir dele." : "Peça a um gestor para configurar o plano de contas."); return; }
      corpo.innerHTML = `<div class="fin-card">${tabela({
        colunas: [
          { rotulo: "Tipo", render: (c) => esc(c.tipo) }, { rotulo: "Natureza", render: (c) => esc(c.natureza) }, { rotulo: "Categoria", render: (c) => esc(c.nome) },
          { rotulo: "Papel nos cálculos", render: (c) => badge(ROTULO_PAPEL[c.papel] ?? c.papel, c.papel === "receita_operacional" ? "ok" : c.papel === "transferencia" || c.papel === "financiamento" ? "info" : "muted") },
          { rotulo: "Situação", render: (c) => (c.ativo ? badge("Ativa", "ok") : badge("Inativa", "muted")) },
          { rotulo: "", render: (c) => (pode ? `<div class="fin-linha-acoes"><button class="btn btn-ghost btn-sm" data-editar="${c.id}">Editar</button><button class="btn btn-ghost btn-sm" data-ativo="${c.id}">${c.ativo ? "Desativar" : "Ativar"}</button></div>` : "") },
        ], linhas: cats,
      }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"')}</div>`;
      corpo.querySelectorAll("[data-ativo]").forEach((b) => b.addEventListener("click", async () => {
        const c = cats.find((x) => x.id === b.dataset.ativo);
        try { await fin.patch(`/plano-contas/${c.id}`, { ativo: !c.ativo }); aviso(c.ativo ? "Categoria desativada." : "Categoria ativada."); carregar(); } catch (e) { aviso(e.message, "bad"); }
      }));
      corpo.querySelectorAll("[data-editar]").forEach((b) => b.addEventListener("click", () => {
        const c = cats.find((x) => x.id === b.dataset.editar);
        dialogo({
          titulo: "Editar categoria", enviar: "Salvar",
          corpo: `${campo("Nome", "nome", { valor: c.nome, obrig: true })}${selecao("Papel nos cálculos", "papel", OPCOES_PAPEL, { valor: c.papel, obrig: true, vazio: null })}<small>Se a categoria já tem lançamentos, o papel não pode ser trocado: crie outra categoria e reclassifique os lançamentos com motivo.</small>`,
          aoEnviar: async (d) => { const o = { nome: d.get("nome") }; if (d.get("papel") !== c.papel) o.papel = d.get("papel"); await fin.patch(`/plano-contas/${c.id}`, o); aviso("Categoria atualizada."); carregar(); },
        });
      }));
    });
  }

  raiz.addEventListener("click", (e) => {
    if (!e.target.closest("[data-nova]")) return;
    dialogo({
      titulo: "Nova categoria", enviar: "Criar",
      corpo: `${campo("Tipo", "tipo", { obrig: true, dica: "Ex.: DESPESA, CUSTO, RECEITA" })}${campo("Natureza", "natureza", { obrig: true, dica: "Ex.: FIXA, VARIAVEL, PESSOAL" })}${campo("Categoria", "nome", { obrig: true })}${selecao("Papel nos cálculos", "papel", OPCOES_PAPEL, { obrig: true, vazio: "Escolha…" })}`,
      aoEnviar: async (d) => { await fin.post("/plano-contas", Object.fromEntries(d.entries())); aviso("Categoria criada."); carregar(); },
    });
  });
  carregar();
}
