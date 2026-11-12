// Leitor OFX (1.x SGML e 2.x XML). Extrai período, transações (FITID, data, valor, nome/memo, documento) e saldos
// quando presentes. Não presume campos de um banco específico: o que faltar fica nulo e a conferência registra a falta.
// Saldo do OFX (LEDGERBAL) é o saldo NA DATA DTASOF — só vale como saldo final do período se DTASOF for o fim do período.
import { CODIGO, falhar } from "../../dominio/erros.js";
import { desescapar } from "./xlsx.js";

const invalido = (mensagem) => falhar(CODIGO.IMPORTACAO_INVALIDA, `OFX inválido: ${mensagem}`);
const campo = (bloco, tag) => {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(bloco);
  return m ? desescapar(m[1].trim()) : null;
};

/** "20260930120000[-3:BRT]" → "2026-09-30". */
export function dataOfx(texto) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(texto ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function lerOfx(texto) {
  if (!/<OFX>/i.test(texto)) invalido("marcação <OFX> ausente");
  const corpo = texto.slice(texto.search(/<OFX>/i));
  const lista = /<BANKTRANLIST>([\s\S]*?)(<\/BANKTRANLIST>|<LEDGERBAL>|$)/i.exec(corpo)?.[1] ?? "";
  if (!lista && !/<STMTTRN>/i.test(corpo)) invalido("lista de transações (BANKTRANLIST/STMTTRN) ausente");
  const transacoes = [...lista.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|$)/gi)].map((m) => ({
    tipo: campo(m[1], "TRNTYPE"), data: dataOfx(campo(m[1], "DTPOSTED")), valor: campo(m[1], "TRNAMT"), fitid: campo(m[1], "FITID"),
    documento: campo(m[1], "CHECKNUM") ?? campo(m[1], "REFNUM"), nome: campo(m[1], "NAME"), memo: campo(m[1], "MEMO"),
  }));
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(corpo)?.[1] ?? "";
  return {
    inicio: dataOfx(campo(lista, "DTSTART")), fim: dataOfx(campo(lista, "DTEND")), transacoes,
    saldo: ledger ? { valor: campo(ledger, "BALAMT"), em: dataOfx(campo(ledger, "DTASOF")) } : null,
    banco: campo(corpo, "BANKID"),
  };
}
