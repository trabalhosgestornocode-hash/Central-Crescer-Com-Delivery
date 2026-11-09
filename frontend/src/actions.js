import { toast } from "./utils.js";
import { state } from "./state.js";
import { abrirProdutoModal } from "./produtoModal.js";
import { abrirSimulador } from "./simuladorModal.js";
import { abrirEditarModal } from "./editarModal.js";
import { abrirHistoricoModal } from "./historicoModal.js";
import { excluirProduto, atualizarProduto, obterCondicoesComerciais } from "./api.js";

// Ações da tabela de produtos. Cada função recebe a linha (produto) correspondente.
export const acoes = {
  ver: (row) => {
    if (row.produto_id) abrirProdutoModal(row.produto_id);
    else toast(`Produto "${row.nome}" sem identificador.`);
  },
  editar: (row) => {
    if (row.produto_id) abrirEditarModal(row.produto_id);
    else toast(`Produto "${row.nome}" sem identificador.`);
  },
  historico: (row) => {
    if (row.produto_id) abrirHistoricoModal(row.produto_id, row.nome);
    else toast(`Produto "${row.nome}" sem identificador.`);
  },
  simular: async (row) => {
    // Condições comerciais DA EMPRESA. Falha de rede/permissão => simulador abre em modo PARCIAL (sem comissão assumida).
    const condicoes = await obterCondicoesComerciais().then((r) => r.data ?? null).catch(() => null);
    abrirSimulador(row, condicoes);
  },
  remover: (row) => {
    if (!row.produto_id) return toast(`Produto "${row.nome}" sem identificador.`);
    removerProduto(row.produto_id, row.nome);
  },
};

/**
 * Exclui o produto. O servidor recusa (409) quando há venda registrada ou
 * quando o produto é componente da ficha de outro — nesses casos oferecemos
 * INATIVAR, que tira o produto de circulação sem apagar o histórico.
 * @param {string} id @param {string} nome
 */
async function removerProduto(id, nome) {
  if (!confirm(`Excluir o produto "${nome}"?\n\nA ficha técnica e os preços dele serão removidos junto. Esta ação não pode ser desfeita.`)) return;
  try {
    await excluirProduto(id);
    toast(`"${nome}" foi excluído.`);
    document.dispatchEvent(new CustomEvent("app:reload"));
  } catch (e) {
    const msg = e.message || "Não foi possível excluir.";
    // Bloqueado por vínculo histórico: oferece a alternativa segura.
    if (/não pode ser excluído/i.test(msg) && /inative/i.test(msg)) {
      if (confirm(`${msg}\n\nDeseja INATIVAR "${nome}" agora?`)) {
        try {
          await atualizarProduto(id, { ativo: false });
          toast(`"${nome}" foi inativado.`);
          document.dispatchEvent(new CustomEvent("app:reload"));
        } catch (e2) { alert("Erro ao inativar: " + e2.message); }
      }
      return;
    }
    alert(msg);
  }
}

export const ACOES_TABELA = [
  { chave: "ver", icon: "👁️", titulo: "Ver detalhes" },
  { chave: "editar", icon: "✏️", titulo: "Editar", permissao: "produtos.editar" },
  { chave: "historico", icon: "🕑", titulo: "Histórico" },
  { chave: "simular", icon: "🧮", titulo: "Simular preço" },
  { chave: "remover", icon: "🗑️", titulo: "Remover produto", permissao: "produtos.editar" },
];

/** Ações visíveis para o papel do usuário atual (quem só consulta não edita). */
export function acoesTabela() {
  const perms = state.sessao?.permissoes ?? [];
  return ACOES_TABELA.filter((a) => !a.permissao || perms.includes(a.permissao));
}
