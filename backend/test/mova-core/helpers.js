// MOVA CORE — ajudantes de teste: Financeiro v2 REAL em memória + porta de leitura do MOVA + núcleo do MOVA CORE.
// Dados 100% sintéticos (organizações aaaa…/bbbb… do cenário do Financeiro v2).
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, USUARIO, ctx, montar } from "../financeiro-v2/helpers/cenario.js";
import { criarPortaFinanceira } from "../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";

export { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, USUARIO, ctx };
export const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
export const UNIDADES = [{ id: UNI_A, nome: "Alfa Centro" }, { id: UNI_A2, nome: "Alfa Norte" }];
export const PERFIL_FIN = Object.freeze({ nome: "FINANCEIRO", consultas: "TODAS" });
export const PERFIL_OPER = Object.freeze({ nome: "OPERACIONAL", consultas: "SEM_VALORES" });

/** Financeiro real (memória) + concessões mutáveis (para revogar no meio da conversa). */
export async function financeiroReal({ concedidas = [UNI_A, UNI_A2] } = {}) {
  const m = montar();
  const concessoesLista = concedidas.map((u) => ({ organizacaoId: ORG_A, usuarioId: USUARIO, unidadeId: u, acoes: ["financeiro_v2.ver"] }));
  const concessoes = { async listar(f) { return concessoesLista.filter((c) => c.organizacaoId === f.organizacaoId && c.usuarioId === f.usuarioId); } };
  const chamadas = [];
  const nucleo = Object.fromEntries(Object.entries(m.nucleo).map(([nome, op]) => [nome, async (cx, ...a) => { chamadas.push({ nome, unidadeId: cx?.unidadeId, organizacaoId: cx?.organizacaoId, permissoes: cx?.permissoes }); return op(cx, ...a); }]));
  const porta = criarPortaFinanceira({ nucleo, concessoes, financeiro: FINANCEIRO });
  const forn = await m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A), { tipo: "FORNECEDOR", nome: "Doce Brownie Ltda" });
  const conta = (valor, vencimento, descricao = "Brownies", competencia = vencimento.slice(0, 7), u = UNI_A, f = forn) =>
    m.nucleo.registrarObrigacao(ctx(ORG_A, u), { contraparteId: f.id, valorOriginalCentavos: valor, categoria: "INSUMOS", descricao, competencia, vencimento, dataEmissao: `${competencia}-01` });
  return { m, porta, concessoesLista, chamadas, forn, conta, criarConcessoesMemoria };
}

/** Cliente SIMULADO da API: recebe um roteiro de respostas (cada uma: lista de blocos ou função do pedido). */
export function clienteRoteirizado(roteiro, { modelo = "claude-haiku-5-5", uso = { input_tokens: 1800, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } = {}) {
  const pedidos = [];
  let i = 0;
  return {
    pedidos,
    messages: {
      async create(req) {
        pedidos.push(structuredClone(req));
        const passo = roteiro[Math.min(i++, roteiro.length - 1)];
        const conteudo = typeof passo === "function" ? passo(req) : passo;
        const temFerramenta = conteudo.some((b) => b.type === "tool_use");
        return { model: modelo, stop_reason: temFerramenta ? "tool_use" : "end_turn", content: conteudo, usage: uso };
      },
    },
  };
}
export const usar = (name, input = {}, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: "tool_use", id, name, input });
export const falar = (text) => ({ type: "text", text });
