// SUGESTÃO de vínculos de transferência interna (saída de uma conta ⇄ entrada em outra). PURO. Nunca confirma nada: só propõe, com a evidência
// (valor, datas, contas). Regras: valor IGUAL, janela de dias curta, contas diferentes. Quando há dúvida (mais de uma combinação possível, ou a mesma
// entrada serve a duas saídas), o status é "ambiguo" e nenhuma ação automática é oferecida.
//   um_para_um     → 1 saída ⇄ 1 entrada de mesmo valor (vinculável pelo fluxo existente, ação humana)
//   um_para_varios → 1 saída ⇄ 2..N entradas cuja SOMA é exatamente a saída (o modelo atual vincula 1:1: exige decisão antes de vincular)
//   ambiguo        → mais de uma combinação possível
//   sem_contrapartida → nada fecha
const PARECE_TRANSFERENCIA = /transfer|entre contas|pix.*(af|unicred|acai)/i;
export const ehTransferenciaProvavel = (l, papelPorCategoria) => PARECE_TRANSFERENCIA.test(l.descricao ?? "") || papelPorCategoria?.get(l.categoria_id) === "transferencia";

function combinacoes(lista, k, ini = 0, atual = [], out = []) {
  if (atual.length === k) { out.push([...atual]); return out; }
  for (let i = ini; i < lista.length; i++) { atual.push(lista[i]); combinacoes(lista, k, i + 1, atual, out); atual.pop(); }
  return out;
}
const dias = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);

/**
 * @param saidas   [{id, conta_id, data_movimento, valor_centavos, descricao}] saídas realizadas, sem vínculo
 * @param entradas [{id, conta_id, data_movimento, valor_centavos, descricao}] entradas realizadas, sem vínculo
 */
export function sugerirTransferencias(saidas, entradas, { janelaDias = 3, maxGrupo = 3 } = {}) {
  const propostas = saidas.map((s) => {
    const cand = entradas.filter((e) => e.conta_id !== s.conta_id && e.data_movimento >= s.data_movimento && dias(s.data_movimento, e.data_movimento) <= janelaDias);
    const exatas = cand.filter((e) => Number(e.valor_centavos) === Number(s.valor_centavos));
    let achados = exatas.map((e) => [e]);
    if (!achados.length) for (let k = 2; k <= maxGrupo && !achados.length; k++) achados = combinacoes(cand.slice(0, 14), k).filter((g) => g.reduce((a, e) => a + Number(e.valor_centavos), 0) === Number(s.valor_centavos));
    const status = achados.length === 0 ? "sem_contrapartida" : achados.length > 1 ? "ambiguo" : achados[0].length === 1 ? "um_para_um" : "um_para_varios";
    return { saida: s, status, contrapartidas: achados.length === 1 ? achados[0] : [], alternativas: achados.length > 1 ? achados : [] };
  });
  // a mesma entrada proposta para duas saídas distintas → dúvida (nenhuma das duas é vinculável sem decisão)
  const uso = new Map();
  for (const p of propostas) for (const e of p.contrapartidas) uso.set(e.id, (uso.get(e.id) ?? 0) + 1);
  for (const p of propostas) if (p.contrapartidas.some((e) => uso.get(e.id) > 1)) { p.alternativas = [p.contrapartidas]; p.contrapartidas = []; p.status = "ambiguo"; }
  return propostas;
}
