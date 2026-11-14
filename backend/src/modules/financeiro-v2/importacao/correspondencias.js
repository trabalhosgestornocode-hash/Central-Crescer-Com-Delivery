// Regras PURAS que propõem candidatas de conciliação entre registros importados de fontes diferentes.
// Uma candidata NUNCA é prova: é uma hipótese com regra e força declaradas, decidida depois por uma pessoa.
//   FORTE → os dois lados compartilham um identificador da fonte (transação Stone, autorização);
//   FRACA → só valor e data coincidem — nunca suficiente sozinha (pode haver dois pagamentos iguais no mesmo dia).
// Quando um registro aparece em mais de uma candidata, TODAS ficam marcadas como ambíguas e não podem ser confirmadas
// até que as concorrentes sejam rejeitadas.
import { somar } from "../dominio/dinheiro.js";

const ref = (r, valorCentavos = r.valorCentavos) => ({ tipo: "REGISTRO_FONTE", id: r.id, valorCentavos });
const diasEntre = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const segundos = (r) => Date.parse(`${r.dataReferencia}T${r.dados.hora ?? "00:00:00"}Z`) / 1000;
const ativo = (r) => r.situacao === "ATIVO";

/** Agrupa candidatas que disputam o mesmo registro. */
function marcarAmbiguas(candidatas) {
  const uso = new Map();
  for (const c of candidatas) for (const r of [...c.ladoA, ...c.ladoB]) uso.set(r.id, (uso.get(r.id) ?? 0) + 1);
  return candidatas.map((c) => ({ ...c, ambigua: [...c.ladoA, ...c.ladoB].some((r) => uso.get(r.id) > 1) }));
}

function semPar(lista, candidatas) {
  const usados = new Set(candidatas.flatMap((c) => [...c.ladoA, ...c.ladoB].map((r) => r.id)));
  return lista.filter((r) => !usados.has(r.id)).map((r) => r.id);
}

const REGRAS = {
  /** Pedido SAIPOS pago com cartão/Pix × transação Stone aprovada. A Stone não cria venda: só evidencia o pagamento. */
  SAIPOS_X_STONE({ registros }) {
    const pedidos = registros.filter((r) => ativo(r) && r.tipoRegistro === "PEDIDO" && !r.dados.cancelado && ["DEBITO", "CREDITO", "PIX", "VALE"].includes(r.dados.formaPagamento));
    const transacoes = registros.filter((r) => ativo(r) && r.tipoRegistro === "TRANSACAO" && r.dados.situacao === "APROVADA");
    const candidatas = [];
    for (const p of pedidos) {
      const fortes = transacoes.filter((t) => p.dados.autorizacao && (t.dados.autorizacao === p.dados.autorizacao || t.idExterno === p.dados.autorizacao));
      const pares = fortes.length ? fortes : transacoes.filter((t) => t.valorCentavos === p.valorCentavos && Math.abs(segundos(t) - segundos(p)) <= 600);
      for (const t of pares) {
        candidatas.push({ ladoA: [ref(p)], ladoB: [ref(t)], regra: fortes.length ? "AUTORIZACAO_EM_COMUM" : "VALOR_IGUAL_E_HORARIO_ATE_10_MIN", forca: fortes.length ? "FORTE" : "FRACA" });
      }
    }
    return { candidatas, semCandidato: semPar([...pedidos, ...transacoes], candidatas) };
  },

  /** Transação Stone × parcela recebida (identificador da transação em comum). Lado do valor: o LÍQUIDO. */
  STONE_X_RECEBIMENTO({ registros }) {
    const transacoes = registros.filter((r) => ativo(r) && r.tipoRegistro === "TRANSACAO" && r.dados.situacao === "APROVADA");
    const recebimentos = registros.filter((r) => ativo(r) && r.tipoRegistro === "RECEBIMENTO");
    const candidatas = [];
    for (const t of transacoes) {
      const parcelas = recebimentos.filter((r) => r.dados.transacaoId === t.idExterno);
      if (!parcelas.length) continue;
      candidatas.push({ ladoA: [ref(t, t.dados.liquidoCentavos)], ladoB: parcelas.map((p) => ref(p)), regra: "TRANSACAO_EM_COMUM", forca: "FORTE" });
    }
    return { candidatas, semCandidato: semPar([...transacoes, ...recebimentos], candidatas) };
  },

  /** Recebimentos Stone de um mesmo dia (um repasse = várias transações) × crédito no extrato. */
  RECEBIMENTO_STONE_X_UNICRED({ registros }) {
    const recebimentos = registros.filter((r) => ativo(r) && r.tipoRegistro === "RECEBIMENTO");
    const creditos = registros.filter((r) => ativo(r) && r.tipoRegistro === "LANCAMENTO_BANCARIO" && r.dados.sentido === "ENTRADA");
    const porDia = new Map();
    for (const r of recebimentos) porDia.set(r.dataReferencia, [...(porDia.get(r.dataReferencia) ?? []), r]);
    const candidatas = [];
    for (const [dia, itens] of porDia) {
      const total = itens.reduce((s, r) => somar(s, r.valorCentavos), 0);
      for (const c of creditos.filter((x) => x.valorCentavos === total && diasEntre(x.dataReferencia, dia) <= 1)) {
        candidatas.push({ ladoA: itens.map((i) => ref(i)), ladoB: [ref(c)], regra: "SOMA_DO_DIA_IGUAL_AO_CREDITO_ATE_1_DIA", forca: "FRACA" });
      }
    }
    return { candidatas, semCandidato: semPar([...recebimentos, ...creditos], candidatas) };
  },

  /** Repasse pago da apuração iFood × crédito no extrato (até 3 dias). */
  IFOOD_X_UNICRED({ registros }) {
    const repasses = registros.filter((r) => ativo(r) && r.tipoRegistro === "COMPONENTE_APURACAO" && r.dados.componente === "REPASSE_PAGO" && r.valorCentavos > 0);
    const creditos = registros.filter((r) => ativo(r) && r.tipoRegistro === "LANCAMENTO_BANCARIO" && r.dados.sentido === "ENTRADA");
    const candidatas = [];
    for (const p of repasses) {
      for (const c of creditos.filter((x) => x.valorCentavos === p.valorCentavos && diasEntre(x.dataReferencia, p.dataReferencia) <= 3)) {
        candidatas.push({ ladoA: [ref(p)], ladoB: [ref(c)], regra: "VALOR_IGUAL_ATE_3_DIAS", forca: "FRACA" });
      }
    }
    return { candidatas, semCandidato: semPar([...repasses, ...creditos], candidatas) };
  },

  /** Entregas devidas de um entregador × débito no extrato com o mesmo total (sempre FRACA: o extrato não diz o destinatário com segurança). */
  FOODY_X_UNICRED({ registros }) {
    const entregas = registros.filter((r) => ativo(r) && r.tipoRegistro === "ENTREGA" && r.dados.devido);
    const debitos = registros.filter((r) => ativo(r) && r.tipoRegistro === "LANCAMENTO_BANCARIO" && r.dados.sentido === "SAIDA");
    const porEntregador = new Map();
    for (const e of entregas) porEntregador.set(e.dados.entregador, [...(porEntregador.get(e.dados.entregador) ?? []), e]);
    const candidatas = [];
    for (const itens of porEntregador.values()) {
      const total = itens.reduce((s, r) => somar(s, r.valorCentavos), 0);
      const ultima = itens.map((i) => i.dataReferencia).sort().at(-1);
      for (const d of debitos.filter((x) => x.valorCentavos === total && x.dataReferencia >= ultima && diasEntre(x.dataReferencia, ultima) <= 10)) {
        candidatas.push({ ladoA: itens.map((i) => ref(i)), ladoB: [ref(d)], regra: "TOTAL_DO_ENTREGADOR_IGUAL_AO_DEBITO_ATE_10_DIAS", forca: "FRACA" });
      }
    }
    return { candidatas, semCandidato: semPar([...entregas, ...debitos], candidatas) };
  },
};

export const RELACOES_AUTOMATICAS = Object.freeze(Object.keys(REGRAS));

/** @returns {{candidatas: Array<{ladoA, ladoB, regra, forca, ambigua}>, semCandidato: string[]}} */
export function proporCandidatas(relacao, registros) {
  const { candidatas, semCandidato } = REGRAS[relacao]({ registros });
  return { candidatas: marcarAmbiguas(candidatas), semCandidato };
}
