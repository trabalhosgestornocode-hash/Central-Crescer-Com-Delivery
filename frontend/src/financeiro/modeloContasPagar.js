// Modelo PURO (sem DOM/rede) das telas do Financeiro 2.0: Contas a Pagar, Conciliação de Saídas e Juros e Encargos.
// Só formata e descreve. A regra de verdade (e a recusa) é do servidor e do banco (migration 151).
import { moeda, pct } from "./modelo.js";

/** Ações do Financeiro 2.0 (strings iguais às do backend). */
export const ACAO_FIN2 = Object.freeze({
  VER: "gestao_financeira.ver", LANCAR: "gestao_financeira.lancar", EDITAR: "gestao_financeira.editar", CONCILIAR: "gestao_financeira.conciliar",
  CANCELAR: "gestao_financeira.cancelar", CLASSIFICAR: "gestao_financeira.classificar", FECHAR: "gestao_financeira.fechar",
});

/** Situação da conta → rótulo e tom. Despesa NÃO é vermelha por ser despesa: vermelho só para atraso/divergência. */
export const SITUACAO_CP = Object.freeze({
  a_vencer: { rotulo: "A vencer", tom: "muted" }, vencida: { rotulo: "Vencida", tom: "bad" },
  parcial: { rotulo: "Parcialmente paga", tom: "warn" }, parcial_vencida: { rotulo: "Parcial vencida", tom: "bad" },
  quitacao_pendente: { rotulo: "Paga — confirmar quitação", tom: "warn" }, paga: { rotulo: "Paga", tom: "ok" },
  paga_com_acrescimo: { rotulo: "Paga com acréscimo", tom: "info" }, paga_a_menor: { rotulo: "Paga a menor", tom: "warn" },
  cancelada: { rotulo: "Cancelada", tom: "muted" },
});
export const FILTROS_SITUACAO = Object.freeze([
  ["", "Todas"], ["a_vencer", "A vencer"], ["vencida", "Vencidas"], ["parcial", "Parcialmente pagas"], ["parcial_vencida", "Parciais vencidas"],
  ["quitacao_pendente", "Pagas — confirmar quitação"], ["paga", "Pagas"], ["paga_com_acrescimo", "Pagas com acréscimo"], ["paga_a_menor", "Pagas a menor"],
  ["provisoria", "Provisórias"], ["cancelada", "Canceladas"],
]);

/** Natureza da diferença (só existe na conta quitada). */
export const NATUREZA = Object.freeze({
  presumido: { rotulo: "Juros/acréscimo presumido", tom: "warn" }, juros: { rotulo: "Juros", tom: "info" }, multa: { rotulo: "Multa", tom: "info" },
  tarifa: { rotulo: "Tarifa", tom: "info" }, outro: { rotulo: "Outro acréscimo", tom: "info" },
  a_verificar: { rotulo: "A verificar: desconto ou saldo?", tom: "warn" }, desconto: { rotulo: "Desconto", tom: "ok" },
});
export const OPCOES_ACRESCIMO = Object.freeze([["", "Juros/acréscimo presumido (não classificado)"], ["juros", "Juros"], ["multa", "Multa"], ["tarifa", "Tarifa"], ["outro", "Outro acréscimo"]]);
export const OPCOES_A_MENOR = Object.freeze([["", "A verificar (não classificado)"], ["desconto", "Desconto"]]);

export const STATUS_SAIDA = Object.freeze({
  conciliado: { rotulo: "Conciliado", tom: "ok" }, sugerido: { rotulo: "Sugerido", tom: "info" }, divergente: { rotulo: "Divergente", tom: "bad" },
  pendente: { rotulo: "Pendente", tom: "warn" }, a_identificar: { rotulo: "A identificar", tom: "muted" }, revogado: { rotulo: "Revogado", tom: "muted" },
});
export const REGRA_SUGESTAO = Object.freeze({ exato: "Valor e data iguais", data_proxima: "Até 1 dia / R$ 0,01 de diferença", agrupado: "Uma saída para vários pagamentos", manual: "Vínculo manual" });
export const TIPO_BLOQUEIO = Object.freeze({
  divergencia_conciliacao: "Conciliação divergente sem justificativa", pago_a_menor_a_verificar: "Conta paga a menor sem classificação (desconto ou saldo?)",
  quitacao_pendente: "Conta paga por inteiro e ainda não quitada", registro_provisorio: "Registro provisório não confirmado",
  pagamento_provisorio: "Pagamento registrado por operador ainda não confirmado",
});

/** Texto digitado (pt-BR: "1.234,56" ou "832,41"; aceita "832.41") → centavos. Vazio/ inválido → null (ausente nunca vira zero). */
export function centavosDigitados(v) {
  const s = String(v ?? "").trim().replace(/\s|R\$/g, "");
  if (!s) return null;
  const norm = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  const [i, d = ""] = norm.split(".");
  return Number(i) * 100 + Number((d + "00").slice(0, 2));
}

/**
 * Prévia do cálculo no formulário (mesma regra do servidor): sem "quitada", nada é classificado.
 * @returns {{tipo:'vazio'|'parcial'|'igual'|'acrescimo'|'a_menor', difCentavos?:number, bps?:number, texto:string}}
 */
export function previaDiferenca(originalTxt, pagoTxt, quitar, jaPagoCentavos = 0) {
  const orig = centavosDigitados(originalTxt), pagoAgora = centavosDigitados(pagoTxt);
  if (orig == null || orig <= 0 || pagoAgora == null) return { tipo: "vazio", texto: "Informe o valor original e o valor efetivamente pago para ver a diferença." };
  const total = jaPagoCentavos + pagoAgora;
  const dif = total - orig;
  if (!quitar) return { tipo: "parcial", difCentavos: dif, texto: `Total pago ${moeda(total)} de ${moeda(orig)}. Sem confirmar a quitação nada é classificado${dif < 0 ? `: fica um saldo de ${moeda(-dif)} em aberto (pagamento parcial, não desconto)` : ""}.` };
  if (dif === 0) return { tipo: "igual", difCentavos: 0, bps: 0, texto: "Pago exatamente o valor original: sem diferença." };
  const bps = Math.round((Math.abs(dif) * 10000) / orig) * Math.sign(dif);
  if (dif > 0) return { tipo: "acrescimo", difCentavos: dif, bps, texto: `Diferença = ${moeda(total)} − ${moeda(orig)} = ${moeda(dif)} · Percentual = ${pct(bps)} → juros/acréscimo presumido (a contadora ou o administrador classifica depois como juros, multa, tarifa ou outro).` };
  return { tipo: "a_menor", difCentavos: dif, bps, texto: `Pago ${moeda(-dif)} a menos (${pct(bps)}). Não é tratado como desconto automaticamente: fica "a verificar" até alguém classificar.` };
}

/** Quais ações aparecem para a conta, por permissão E por estado (o servidor repete tudo). */
export function acoesDaConta(c, permissoes = []) {
  const p = (a) => permissoes.includes(a);
  const aberta = c.status === "aberta", quitada = c.status === "quitada";
  return {
    pagamento: aberta && p(ACAO_FIN2.LANCAR),
    quitar: aberta && c.pagamentosAtivos > 0 && p(ACAO_FIN2.CONCILIAR),
    desfazer: quitada && p(ACAO_FIN2.CONCILIAR),
    classificar: quitada && (c.diferencaCentavos ?? 0) !== 0 && p(ACAO_FIN2.CLASSIFICAR),
    confirmar: c.provisoria && c.status !== "cancelada" && p(ACAO_FIN2.CONCILIAR),
    cancelar: aberta && c.pagamentosAtivos === 0 && p(ACAO_FIN2.CANCELAR),
    cancelarPagamento: aberta && p(ACAO_FIN2.CANCELAR),
    editar: c.status !== "cancelada" && p(ACAO_FIN2.EDITAR),
  };
}
