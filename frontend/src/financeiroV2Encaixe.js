// ENCAIXE FUTURO do Financeiro v2 no Dashboard Financeiro da plataforma (Execução 09) — PREPARADO, NÃO ATIVADO.
//
// Nenhum arquivo da aplicação importa este módulo (há teste que garante): o menu publicado continua idêntico. Ele
// estende a máquina de estados de financeiroAcesso.js com um estado a mais, sem mudar os existentes:
//   - o servidor (no futuro) devolve em GET /gestao-financeira/status o bloco `financeiroV2: { liberado, disponivel, operavel, motivo }`,
//     calculado pelo adaptador do v2 a partir da sessão verificada (liberação por empresa/unidade + pessoa + concessão);
//   - sem esse bloco, ou com `liberado: false`, TUDO segue como hoje (legado / 2.0 / negado / erro);
//   - com `liberado: true`, o Dashboard Financeiro mostra SÓ o v2 (substitui o menu, nunca soma: não há dois
//     financeiros para a mesma unidade); sem pessoa válida ou concessão é tela de acesso negado, nunca o legado;
//   - o mesmo item "Dashboard Financeiro" do menu principal; nenhum login novo; a unidade é a da plataforma.
import { ESTADO_FINANCEIRO, estadoDoStatus, menuDoEstado } from "./financeiroAcesso.js";

export const ESTADO_FINANCEIRO_V2 = "financeiro_v2";
export const ESTADO_FINANCEIRO_V2_NEGADO = "financeiro_v2_sem_concessao";

/** As sete áreas do Financeiro v2 (rotas da interface própria, frontend/financeiro-v2). */
export const AREAS_FINANCEIRO_V2 = Object.freeze([
  { secao: "Visão Geral", itens: [{ id: "fv2-visao-geral", label: "Visão Geral", icon: "bar-chart", rota: "visao-geral" }] },
  { secao: "DRE", itens: [{ id: "fv2-dre", label: "DRE Gerencial", icon: "pie-chart", rota: "dre" }] },
  { secao: "Vendas e Recebimentos", itens: [{ id: "fv2-vendas", label: "Vendas e Recebimentos", icon: "trending-up", rota: "vendas-e-recebimentos" }] },
  { secao: "Contas", itens: [
    { id: "fv2-contas-a-pagar", label: "Contas a Pagar", icon: "wallet", rota: "contas-a-pagar" },
    { id: "fv2-contas-a-receber", label: "Contas a Receber", icon: "wallet", rota: "contas-a-receber" },
    { id: "fv2-calendario", label: "Calendário", icon: "calendar", rota: "calendario" },
  ] },
  { secao: "Caixa", itens: [
    { id: "fv2-caixa-e-bancos", label: "Caixa e Bancos", icon: "credit-card", rota: "caixa-e-bancos" },
    { id: "fv2-fluxo-de-caixa", label: "Fluxo de Caixa", icon: "trending-up", rota: "fluxo-de-caixa" },
  ] },
  { secao: "Importações e Conferências", itens: [{ id: "fv2-conferencias", label: "Importações e Conferências", icon: "list-checks", rota: "conferencias" }] },
  { secao: "Documentos e Configurações", itens: [
    { id: "fv2-documentos", label: "Documentos", icon: "package", rota: "documentos" },
    { id: "fv2-configuracoes", label: "Configurações", icon: "settings", rota: "configuracoes" },
  ] },
]);

/**
 * Estado do Dashboard Financeiro considerando o v2. Resposta malformada continua sendo ERRO (nunca legado nem v2).
 * @param {any} status corpo de GET /gestao-financeira/status
 */
export function estadoComFinanceiroV2(status) {
  const base = estadoDoStatus(status);
  if (base === ESTADO_FINANCEIRO.ERRO) return base;
  const v2 = status?.financeiroV2;
  if (v2 === undefined || v2 === null) return base; // servidor sem o v2: comportamento de hoje, intacto
  if (typeof v2 !== "object" || typeof v2.liberado !== "boolean") return ESTADO_FINANCEIRO.ERRO;
  if (!v2.liberado) return base; // v2 não liberado nesta empresa/unidade: segue exatamente o financeiro de hoje
  // Unidade LIBERADA: só o v2 (nunca os dois). Sem pessoa válida ou sem concessão = acesso negado ao v2.
  return v2.disponivel === true && v2.operavel === true ? ESTADO_FINANCEIRO_V2 : ESTADO_FINANCEIRO_V2_NEGADO;
}

/** Menu do estado: o v2 SUBSTITUI o menu financeiro; os demais estados delegam ao comportamento atual. */
export function menuComFinanceiroV2(estado) {
  if (estado === ESTADO_FINANCEIRO_V2) return AREAS_FINANCEIRO_V2.map((g) => ({ secao: g.secao, itens: g.itens.map((i) => ({ ...i })) }));
  if (estado === ESTADO_FINANCEIRO_V2_NEGADO) return [];
  return menuDoEstado(estado);
}

/**
 * Chave do contexto da plataforma para descartar respostas atrasadas: muda a cada troca de empresa, unidade ou sessão
 * (a plataforma revoga a sessão anterior na troca). Resposta pedida com outra chave é ignorada.
 */
export function chaveDoContexto(sessao) {
  return [sessao?.empresa?.id ?? "", sessao?.unidade?.id ?? "", sessao?.sessionId ?? sessao?.expiraEm ?? ""].join("|");
}
export const respostaVale = (chaveAoPedir, chaveAtual) => Boolean(chaveAoPedir) && chaveAoPedir === chaveAtual;

/** Endereço de uma área do v2 dentro da plataforma (mesma origem; sem novo login). */
export const enderecoDaArea = (rota) => `#/financeiro-v2/${encodeURIComponent(rota)}`;
