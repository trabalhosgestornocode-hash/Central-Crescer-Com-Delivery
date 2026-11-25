// Sangrias, reforços e transferências em dinheiro importados da SAIPOS: peças de tela compartilhadas (prévia da importação, dia do
// calendário SAIPOS e fechamento manual). Funções PURAS: dados já calculados pelo servidor → HTML escapado. Nenhuma conta aqui.
// Nada aqui é faturamento. A retirada é despesa paga em dinheiro, mas só vira conta quando a pessoa a lança (bloco próprio na importação); a tela mostra o vínculo com o caixa como pendente.
import { dataBR, esc, moeda } from "./formatar.js";

const NATUREZA = Object.freeze({
  SANGRIA: ["Retirada (sangria)", "info"], REFORCO: ["Reforço", "ok"], TRANSFERENCIA: ["Transferência", "neutro"], DESCONHECIDA: ["Sem classificação", "alerta"],
});
const CONFERENCIA = Object.freeze({
  SO_IMPORTADO: ["só no relatório", "info"], SO_MANUAL: ["só no fechamento manual", "neutro"], POSSIVEL_DUPLICIDADE: ["possível duplicidade", "alerta"], DIVERGENTE: ["valores diferentes", "erro"],
});
const ORIGEM = Object.freeze({
  IMPORTADO: "relatório importado", MANUAL: "fechamento manual", IMPORTADO_E_MANUAL_IGUAIS: "relatório e fechamento iguais (contado uma vez)", CONFLITO: "valores diferentes: revisar",
});
const selo = (texto, classe) => `<span class="selo selo--${classe}">${esc(texto)}</span>`;
const valor = (c) => `<span class="valor">${esc(moeda(c))}</span>`;

/** Linha da lista de movimentações (abre o que compõe o total do dia). */
const itemDaLista = (i) => {
  const [rotulo, classe] = NATUREZA[i.natureza] ?? [i.natureza, "neutro"];
  return `<li><span><strong>${esc(i.descricao)}</strong><br><span class="nota">${esc(i.conta ?? "")} · ${esc(i.categoria ?? "")} · ${i.vinculoComCaixa === "PENDENTE" ? "caixa não identificado (pendente)" : `caixa ${esc(i.caixa ?? "")}`}${i.considerar ? "" : " · fora dos totais"}${i.motivo && !i.considerar ? ` · ${esc(i.motivo)}` : ""}</span></span><span>${selo(rotulo, classe)} ${valor(i.valorCentavos)}</span></li>`;
};

/**
 * Bloco do DIA: quantidade e total de retiradas, reforços, transferências, pendências de associação ao caixa, divergências e a lista.
 * `m` = resumo do dia vindo do servidor (movimentosDeCaixa). Sem movimento no dia: nada é mostrado (ausência ≠ zero).
 */
export function movimentosDoDia(m) {
  if (!m) return "";
  const linha = (rotulo, b) => (b.quantidade ? `<dt>${esc(rotulo)}</dt><dd>${b.quantidade} · ${valor(b.totalCentavos)}</dd>` : "");
  const conf = ["retiradas", "reforcos", "transferencias"].filter((k) => m.conferenciaComFechamento?.[k]).map((k) => {
    const [t, c] = CONFERENCIA[m.conferenciaComFechamento[k]];
    return `<li>${esc({ retiradas: "Retiradas", reforcos: "Reforços", transferencias: "Transferências" }[k])} × fechamento manual: ${selo(t, c)}</li>`;
  });
  const avisos = [...m.alertas, ...m.divergencias];
  return `<section class="mov-caixa" aria-label="Movimentações de dinheiro do dia ${esc(dataBR(m.data))}">
<h3>Retiradas e reforços de caixa</h3>
<p class="nota">Retirada é despesa paga em dinheiro (lançada na importação); reforço e transferência não são despesa. Nada aqui é faturamento.</p>
<dl class="ficha ficha--compacta">${linha("Retiradas (sangrias)", m.retiradas)}${linha("Reforços", m.reforcos)}${linha("Transferências", m.transferencias)}${linha("Transferências a confirmar (fora da conta)", m.transferenciasAConfirmar ?? { quantidade: 0 })}${linha("Sem classificação", m.desconhecidas)}
${m.pendenciasDeCaixa.quantidade ? `<dt>Caixa não identificado</dt><dd>${m.pendenciasDeCaixa.quantidade} movimentação(ões)</dd>` : ""}</dl>
${m.pendenciasDeCaixa.mensagem ? `<p class="nota">${esc(m.pendenciasDeCaixa.mensagem)}</p>` : ""}
${conf.length ? `<ul class="mini">${conf.join("")}</ul>` : ""}
${avisos.length ? `<ul class="mini mov-caixa__avisos">${avisos.map((a) => `<li>${esc(a.mensagem)}</li>`).join("")}</ul>` : ""}
<details class="mov-caixa__lista"><summary>Ver as ${m.itens.length} movimentação(ões) deste dia</summary><ul class="lista-simples">${m.itens.map(itemDaLista).join("")}</ul></details>
</section>`;
}

const SITUACAO_COFRE = { PREVISTO_PELA_CONTAGEM: "Previsto pela contagem física", ESTIMATIVA_SEM_CONTAGEM: "Estimativa: sem contagem física",
  RECOMPOR_FUNDO: "O dinheiro contado não cobre o fundo fixo: recompor o fundo", RECOMPOR_FUNDO_ESTIMADO: "Pela estimativa, o fundo fixo precisa ser recomposto" };
/** Frente de caixa → cofre: esperado, pela contagem e recebido ficam SEPARADOS; previsão nunca é entrega confirmada. */
function destinoAoCofre(k, fundo) {
  if (!k || k.situacao === "SEM_FUNDO_FIXO_CONFIGURADO" || k.situacao === "SEM_CALCULO") return "";
  const v = (x) => (x === null || x === undefined ? '<span class="valor valor--desconhecido">—</span>' : valor(x));
  return `<h4>Para o cofre</h4>
<dl class="ficha ficha--compacta">
  <dt>Fundo fixo mantido</dt><dd>${v(fundo)}</dd>
  <dt>Esperado para o cofre</dt><dd>${v(k.esperadoCentavos)}</dd>
  <dt>Pela contagem física</dt><dd>${v(k.pelaContagemCentavos)}</dd>
  ${k.recomposicaoCentavos ? `<dt>Recompor o fundo</dt><dd>${v(k.recomposicaoCentavos)}</dd>` : ""}
  <dt>Recebido pela gerência</dt><dd>${k.confirmado ? v(k.recebidoCentavos) : '<span class="valor valor--desconhecido">não confirmado</span>'}</dd>
</dl>
<p class="nota">${esc(SITUACAO_COFRE[k.situacao] ?? k.situacao)}. Valor previsto não comprova que o dinheiro chegou ao cofre.</p>`;
}

/** Conferência do dinheiro do dia no fechamento: abertura + vendas + reforços − sangrias − transferências = esperado × informado. */
export function conferenciaDoDinheiro(c) {
  if (!c) return "";
  const v = (x) => (x === null || x === undefined ? '<span class="valor valor--desconhecido">não informado</span>' : valor(x));
  const origem = (k) => (c.origem?.[k] ? `<br><span class="nota">${esc(ORIGEM[c.origem[k]] ?? c.origem[k])}</span>` : "");
  const situacao = { CONFERE: ["Confere", "ok"], DIFERENTE: ["Diferença no caixa", "alerta"], SOBRA: ["Sobra de caixa", "alerta"], FALTA: ["Falta de caixa", "alerta"], REVISAR_MOVIMENTOS: ["Revisar movimentações antes de conferir", "erro"], SEM_VALOR_INFORMADO: ["Sem valor informado no fechamento", "neutro"] }[c.situacao];
  return `<section class="mov-caixa" aria-label="Conferência do dinheiro do dia">
<h3>Conferência do dinheiro</h3>
<dl class="ficha ficha--compacta">
  <dt>Abertura</dt><dd>${v(c.aberturaCentavos)}${c.aberturaInformada ? "" : c.origemDaAbertura === "FUNDO_FIXO_CONFIGURADO" ? '<br><span class="nota">fundo fixo da unidade (abertura presumida, não comprovada)</span>' : '<br><span class="nota">sem abertura informada: considerada zero</span>'}</dd>
  <dt>Vendas em dinheiro</dt><dd>${v(c.vendasEmDinheiroCentavos)}${c.origemDasVendas ? `<br><span class="nota">${c.origemDasVendas === "IMPORTADO" ? "vendas importadas" : "informado no fechamento"}</span>` : ""}</dd>
  <dt>Sangrias</dt><dd>${v(c.retiradasCentavos)}${origem("retiradas")}</dd>
  <dt>Reforços</dt><dd>${v(c.reforcosCentavos)}${origem("reforcos")}</dd>
  <dt>Transferências</dt><dd>${v(c.transferenciasCentavos)}${origem("transferencias")}</dd>
  <dt>Dinheiro esperado</dt><dd>${v(c.esperadoCentavos)}</dd>
  <dt>Dinheiro informado</dt><dd>${v(c.informadoCentavos)}</dd>
  <dt>Diferença</dt><dd>${v(c.diferencaCentavos)}</dd>
</dl>
${situacao ? `<p>${selo(situacao[0], situacao[1])}</p>` : ""}${destinoAoCofre(c.cofre, c.fundoFixoCentavos)}
</section>`;
}

/** Prévia da importação: totais por tipo e a conferência das classificações, linha a linha, ANTES de confirmar. */
export function previaDeMovimentos(c) {
  if (!c?.movimentos) return "";
  const t = (rotulo, n, centavos) => (n ? `<li><span>${esc(rotulo)}</span><span>${n} · ${valor(centavos)}</span></li>` : "");
  const linhas = c.movimentos.map((x) => {
    const [rotulo, classe] = NATUREZA[x.natureza] ?? [x.natureza, "neutro"];
    return `<tr><td data-rotulo="Data">${esc(dataBR(x.data))}</td><td data-rotulo="Descrição" class="esquerda">${esc(x.descricao)}${x.considerar ? "" : `<br><span class="nota">${esc(x.motivo ?? "")}${x.pago === false ? " · não pago" : ""} · fica fora dos totais</span>`}</td><td data-rotulo="Classificação">${selo(rotulo, classe)}</td><td data-rotulo="Valor">${valor(x.valorCentavos)}</td><td data-rotulo="Caixa"><span class="nota">pendente</span></td></tr>`;
  }).join("");
  return `<h3>Movimentações de Frente de Caixa</h3>
<p class="nota">Importar não lança nada: a retirada só vira despesa quando você a lança, abaixo. Reforço e transferência não são despesa. O relatório não informa o caixa: o vínculo fica pendente.</p>
<ul class="lista-simples">${t("Retiradas (sangrias)", c.sangrias, c.sangriasCentavos)}${t("Reforços", c.reforcos, c.reforcosCentavos)}${c.desconhecidas ? `<li><span>Sem classificação (fora dos totais)</span><span>${c.desconhecidas}</span></li>` : ""}${c.naoPagas ? `<li><span>Não pagas (fora dos totais)</span><span>${c.naoPagas}</span></li>` : ""}${c.transferenciasAConfirmar ? `<li><span>Transferências a confirmar (fora do dinheiro esperado)</span><span>${c.transferenciasAConfirmar}</span></li>` : ""}<li><span>Dias com movimento</span><span>${c.diasComMovimento}</span></li></ul>
<details open><summary><strong>Conferir as classificações</strong> (${c.movimentos.length} linha(s))</summary><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Classificação de cada movimentação</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Descrição</th><th scope="col">Classificação</th><th scope="col">Valor</th><th scope="col">Caixa</th></tr></thead><tbody>${linhas}</tbody></table></div></details>`;
}
