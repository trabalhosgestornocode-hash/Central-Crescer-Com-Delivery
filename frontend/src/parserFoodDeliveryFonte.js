// Bloco "Fonte logística por dia" do Parser (ponte Foody, Fase C). PURO: só formata o `fonteLogistica` que o backend já
// calculou (foody.fonte.js) — nada é somado ou recalculado aqui.
//
// Regra exibida: um dia, uma fonte. Excel quando importado (oficial: pagamento, conciliação, distância); senão o fechamento
// Foody DEFINITIVO; Foody com pendência/incompleto aparece mas fica FORA do total. As quatro grandezas ficam separadas:
// taxa bruta, taxa válida, custo atribuído a entregador próprio (só Foody) e custo real conciliado (só período 100% Excel).

const ROTULO = Object.freeze({
  EXCEL: { txt: "Excel", tom: "pos", dica: "relatório importado (fonte oficial)" },
  FOODY: { txt: "Foody", tom: "neutro", dica: "fechamento Foody consolidado (dia sem Excel)" },
  FOODY_PENDENTE: { txt: "Foody · pendente", tom: "warn", dica: "fechamento com pendência: fora do total" },
  FOODY_INCOMPLETO: { txt: "Foody · incompleto", tom: "neg", dica: "coleta incompleta: fora do total" },
});

const diaCurto = (ymd) => { const [a, m, d] = String(ymd).split("-"); return `${d}/${m}/${a}`; };
const PENDENCIA = Object.freeze({
  TRIAGEM_PENDENTE: "pedido em triagem", COBERTURA_INCOMPLETA: "coleta incompleta", PONTO_COLETA_DIVERGENTE: "ponto de coleta divergente",
});

/** true quando o bloco tem algum dia com fechamento Foody (há o que mostrar). */
export function temFonteFoody(fl) {
  return !!fl && Array.isArray(fl.dias) && fl.dias.some((d) => d.fonte !== "SEM_DADOS" && d.fonte !== "EXCEL");
}

/** true quando há Foody consolidado em algum dia SEM Excel (os cards do Excel não contam esses dias). */
export function temDiaSoFoody(fl) {
  return !!fl && Array.isArray(fl.dias) && fl.dias.some((d) => d.fonte === "FOODY");
}

/**
 * @param {object} fl  resposta.fonteLogistica do backend
 * @param {{fmtMoeda:(n:number)=>string, escapeHtml:(s:string)=>string}} fmt
 */
export function fonteLogisticaHtml(fl, { fmtMoeda, escapeHtml }) {
  if (!fl) return "";
  if (fl.erro) {
    return `<p class="pfd-secao-texto">Os fechamentos Foody não puderam ser lidos agora (${escapeHtml(String(fl.erro))}). Os números do Excel acima não mudam.</p>`;
  }
  const dias = (fl.dias ?? []).filter((d) => d.fonte !== "SEM_DADOS");
  if (!dias.length) return "";
  const m = (v) => (v == null ? "—" : fmtMoeda(v));
  const linha = (d) => {
    const r = ROTULO[d.fonte] ?? { txt: d.fonte, tom: "neutro", dica: "" };
    const pend = (d.pendencias ?? []).map((p) => PENDENCIA[p] ?? p).join(", ");
    const obs = d.fonte === "EXCEL" ? (d.foodyIgnorado ? "Foody só como conferência" : "")
      : d.fonte === "FOODY" ? `versão ${d.versao}` : (pend ? `fora do total: ${escapeHtml(pend)}` : "fora do total");
    return `<tr data-fonte="${escapeHtml(d.fonte)}">
      <td>${diaCurto(d.competencia)}</td>
      <td><span class="pfd-status-item pfd-status--${r.tom}" title="${escapeHtml(r.dica)}"><span class="pfd-status-val">${escapeHtml(r.txt)}</span></span></td>
      <td class="num">${d.pedidos ?? 0}</td><td class="num">${d.entregues ?? 0}</td>
      <td class="num">${m(d.taxaBruta)}</td><td class="num">${m(d.taxaValida)}</td>
      <td class="num">${d.fonte === "EXCEL" ? "—" : m(d.custoLogisticoAtribuido)}</td>
      <td>${obs}</td></tr>`;
  };
  const t = fl.totais ?? {};
  const fora = t.diasForaDoTotal ?? 0;
  return `
    <p class="pfd-secao-texto">Um dia, uma fonte: o Excel importado é a fonte oficial; nos dias sem Excel entra o fechamento Foody
      consolidado. As duas fontes nunca são somadas. Dias Foody não têm nome de entregador nem distância e não entram em pagamento.</p>
    <div class="tabela-wrap"><table class="grid" id="pfd-fonte-logistica">
      <thead><tr><th>Dia</th><th>Fonte</th><th class="num">Pedidos</th><th class="num">Entregues</th><th class="num">Taxa bruta</th>
        <th class="num">Taxa válida</th><th class="num">Custo entregador próprio</th><th>Observação</th></tr></thead>
      <tbody>${dias.map(linha).join("")}</tbody>
      <tfoot><tr><th>Total</th><th>${t.dias?.excel ?? 0} Excel · ${t.dias?.foody ?? 0} Foody</th>
        <th class="num">${t.pedidos ?? 0}</th><th class="num">${t.entregues ?? 0}</th><th class="num">${m(t.taxaBruta)}</th>
        <th class="num">${m(t.taxaValida)}</th><th class="num">${m(t.custoLogisticoAtribuido)}</th>
        <th>${t.custoRealConciliado != null ? `custo real conciliado ${m(t.custoRealConciliado)}` : ""}</th></tr></tfoot>
    </table></div>
    ${fora ? `<p class="pfd-secao-texto">${fora} ${fora === 1 ? "dia ficou" : "dias ficaram"} fora do total por pendência no fechamento Foody: o período ainda não está fechado.</p>` : ""}`;
}
