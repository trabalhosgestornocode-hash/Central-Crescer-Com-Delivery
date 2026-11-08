// CENTRAL ÚNICA DE CONFERÊNCIAS (painel lateral). Reúne o que depende de decisão humana e compara o sistema com a apresentação oficial.
// Cada ação usa o endpoint próprio (com a permissão e a trilha dele); nada vira "confirmado" sem uma ação explícita de quem pode.
import { fin } from "./api.js";
import { moeda, rotuloMes, dataBr } from "./modelo.js";
import { abrirPainelHtml } from "./detalhe.js";
import { esc } from "./detalheHtml.js";
import { aviso, dialogo, campo } from "./ui.js";

const ROTULO_TIPO = { ajuste_vendas: "Ajuste de vendas", rateios: "Rateios", juros_presumido: "Acréscimo presumido", conta_sem_pagamento: "Conta sem pagamento", categoria_sem_regra: "Sem regra", divergencia_canais: "Divergência de canais",
  origem_pendente: "Origem pendente", transferencias_internas: "Transferências internas" };
const R = (c) => (c == null ? "—" : moeda(c));
const ROTULO_STATUS = { um_para_um: ["1 saída ⇄ 1 entrada", "ok"], um_para_varios: ["soma de várias entradas — exige decisão", "warn"], ambiguo: ["ambíguo", "bad"], sem_contrapartida: ["sem contrapartida", "muted"] };
const badge = (t, tom) => `<span class="fin-badge fin-badge--${tom}">${esc(t)}</span>`;

/** Carrega e conta as pendências (usado pelo aviso compacto das telas). */
export async function contarPendencias(mes) {
  try { const d = await fin.get("/conferencias", { mes }); return { total: d.total, geral: d.geral.length, dados: d }; } catch { return null; }
}

function htmlChecklist(c) {
  if (!c) return "";
  return `<details class="cf-check" open><summary><strong>O que o Portal do Parceiro precisa informar</strong></summary>
    <p class="fin-sub"><strong>Onde:</strong> ${esc(c.onde)}</p><ol>${c.precisaInformar.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
    <p class="fin-sub"><strong>A conta:</strong> ${esc(c.conta)}</p><p class="fin-sub"><strong>Como confirmar:</strong> ${esc(c.comoConfirmar)}</p><p class="fin-sub">Situação: ${esc(c.situacao)}</p></details>`;
}

function htmlAcao(p) {
  const a = p.acao;
  if (!a) return `<p class="fin-sub">Sem ação no sistema: depende de decisão externa.</p>`;
  if (a.metodo === "TELA") return `<button type="button" class="btn btn-primary btn-sm" data-cf-abrir="${esc(p.tipo)}">${esc(a.rotulo)}</button>`;
  let campos = "";
  if (a.exige?.includes("evidencia")) campos = `<label class="fin-campo"><span>Evidência da confirmação *</span><textarea name="evidencia" rows="2" maxlength="500" placeholder="Relatório, período e valores conferidos" required></textarea></label>`;
  else if (a.exige?.includes("natureza")) {
    const sug = p.sugestao;
    campos = `${sug ? `<p class="fin-sub"><strong>Sugestão (apresentação):</strong> ${esc(sug.natureza)}. ${esc(sug.evidencia)}</p>` : ""}
      <label class="fin-campo"><span>Natureza do acréscimo *</span><select name="classificacao" required>${["juros", "multa", "tarifa", "outro"].map((n) => `<option value="${n}"${sug?.natureza === n ? " selected" : ""}>${n[0].toUpperCase()}${n.slice(1)}</option>`).join("")}</select></label>
      <label class="fin-campo"><span>Motivo *</span><input name="motivo" maxlength="300" required value="${esc(sug?.motivo ?? "")}"></label>
      <p class="fin-sub">Exige perfil autorizado (${esc(a.permissao)}). As datas efetivas dos pagamentos são mantidas.</p>`;
  } else if (a.exige?.includes("contaId")) campos = `<label class="fin-campo"><span>Conta de onde o dinheiro saiu *</span><select name="contaId" required><option value="">Escolha…</option>${(p.contas ?? []).map((c) => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join("")}</select></label><p class="fin-sub">Só informe se tiver comprovante. Enquanto isso o pagamento segue reconhecido como despesa, sem saída bancária e sem conciliação.</p>`;
  return `<form class="cf-acao" data-cf-form data-tipo="${esc(a.tipo)}" novalidate>${campos}<button type="submit" class="btn btn-primary btn-sm">${esc(a.rotulo)}</button></form>`;
}

function htmlPendencia(p) {
  return `<li class="cf-item" data-pend="${esc(p.id)}"><div class="cf-topo">${badge(ROTULO_TIPO[p.tipo] ?? p.tipo, p.gravidade === "divergencia" ? "bad" : "warn")}${p.valorCentavos != null ? `<strong>${R(p.valorCentavos)}</strong>` : ""}</div>
    <h4>${esc(p.titulo)}</h4><p>${esc(p.descricao)}</p>
    ${(p.parcelas ?? []).length ? `<p class="fin-sub">Parcelas: ${p.parcelas.map((x) => `${esc(rotuloMes(x.competencia))} ${R(x.valorCentavos)}`).join(" · ")}</p>` : ""}
    ${(p.evidencias ?? []).length ? `<p class="fin-sub"><strong>Evidência:</strong> ${p.evidencias.map(esc).join("; ")}</p>` : ""}
    ${htmlChecklist(p.checklist)}${htmlAcao(p)}</li>`;
}

function htmlComparacao(c) {
  if (!c?.length) return `<p class="fin-sub">Nenhuma referência oficial carregada para este mês.</p>`;
  return `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th>Indicador</th><th class="fin-num">Sistema</th><th class="fin-num">Apresentação</th><th class="fin-num">Diferença</th></tr></thead><tbody>${c.map((x) => `<tr class="${x.confere ? "" : "cf-dif"}"><td data-rot="Indicador">${esc(x.rotulo)}${x.explicacao ? `<br><small>${esc(x.explicacao)}</small>` : ""}</td><td class="fin-num" data-rot="Sistema">${R(x.sistemaCentavos)}</td><td class="fin-num" data-rot="Apresentação">${R(x.apresentacaoCentavos)}</td><td class="fin-num" data-rot="Diferença">${x.confere ? "confere" : x.diferencaCentavos == null ? "—" : moeda(x.diferencaCentavos, { sinal: true })}</td></tr>`).join("")}</tbody></table></div>`;
}

function htmlPeriodos(p) {
  if (!p) return "";
  const a = p.anteriorPagaNoMes, d = p.mesPagoDepois;
  const tab = (cols, linhas) => `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="fin-num"' : ""}>${esc(c.t)}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
  return `<section><h4>Diferenças de períodos</h4>
    <p class="fin-sub"><strong>Contas de ${esc(rotuloMes(p.mesAnterior))} pagas em ${esc(rotuloMes(p.mes))}</strong> (compras e entregas, por competência; o que a sócia pagou não saiu do caixa): ${R(a.totalCentavos)}</p>
    ${tab([{ t: "Conta" }, { t: "Tipo" }, { t: "Valor", num: true }], a.itens.map((i) => `<tr><td>${esc(i.descricao)}</td><td><small>${esc(i.tipo)}</small></td><td class="fin-num">${R(i.valorCentavos)}</td></tr>`))}
    <p class="fin-sub"><strong>Contas de ${esc(rotuloMes(p.mes))} pagas em ${esc(rotuloMes(p.mesSeguinte))}:</strong> pagas ${R(d.totalPagoCentavos)}; parte que está no resultado de ${esc(rotuloMes(p.mes))}: ${R(d.totalNoResultadoCentavos)}</p>
    ${tab([{ t: "Conta" }, { t: "Pago", num: true }, { t: "No resultado", num: true }], d.itens.map((i) => `<tr><td>${esc(i.descricao)}${i.tipo !== "integral" ? ` <small>(${esc(i.tipo)})</small>` : ""}</td><td class="fin-num">${R(i.valorPagoCentavos)}</td><td class="fin-num">${R(i.noResultadoCentavos)}</td></tr>`))}
    <p class="fin-sub">Impostos e folha (despesas por pagamento) não entram aqui: seguem o mês do pagamento.</p></section>`;
}

// ------------------------------------------------------------------ telas de decisão agrupadas
function abrirRateios(item, ctx) {
  const corpo = `<section><p class="fin-sub">Cinco decisões numa tela só. Aprovar muda o rateio de “proposto” para “aprovado” (decisão da contadora, registrada com o seu usuário). Nada é aprovado sem marcar.</p>
    <div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th></th><th>Obrigação</th><th class="fin-num">Valor</th><th>Competências</th><th>Critério e evidência</th></tr></thead><tbody>
    ${item.itens.map((r) => `<tr data-rateio="${esc(r.id)}"><td><input type="checkbox" name="r" value="${esc(r.id)}" aria-label="Aprovar ${esc(r.obrigacao)}"></td>
      <td>${esc(r.obrigacao)}<br><small>${esc(r.categoria ?? "")}${r.fornecedor ? ` · ${esc(r.fornecedor)}` : ""} · competência da conta ${esc(r.competenciaObrigacao ?? "—")}</small></td><td class="fin-num">${R(r.valorElegivelCentavos)}</td>
      <td>${r.parcelas.map((p) => `${esc(rotuloMes(p.competencia))}: <strong>${R(p.valorCentavos)}</strong>`).join("<br>")}</td>
      <td><strong>${esc(r.criterio === "producao" ? "período de produção" : r.criterio === "dias_consumo" ? "dias de consumo" : r.criterio)}</strong><br><small>${esc(r.justificativa)}</small><br><small>${r.evidencia ? `Evidência: ${esc(r.evidencia)}` : "Sem documento anexado: a evidência é o critério acima."}</small></td></tr>`).join("")}
    </tbody></table></div>
    <label class="fin-campo fin-campo--inline"><span><input type="checkbox" data-ciente> Confirmo que os rateios marcados foram validados por quem tem autoridade (contadora)</span></label>
    <p><button type="button" class="btn btn-ghost btn-sm" data-marcar-todos>Marcar todos</button> <button type="button" class="btn btn-primary btn-sm" data-aprovar>Aprovar os marcados</button></p>
    <p class="fin-sub" data-resultado role="status"></p></section>`;
  const painel = abrirPainelHtml({ titulo: "Aprovação dos rateios", html: corpo, aoFechar: () => abrirCentral(ctx) });
  const raiz = document.querySelector(".fin-pn");
  raiz.querySelector("[data-marcar-todos]").addEventListener("click", () => raiz.querySelectorAll('input[name="r"]').forEach((c) => { c.checked = true; }));
  raiz.querySelector("[data-aprovar]").addEventListener("click", async () => {
    const marcados = [...raiz.querySelectorAll('input[name="r"]:checked')].map((c) => c.value), saida = raiz.querySelector("[data-resultado]");
    if (!marcados.length) { saida.textContent = "Marque ao menos um rateio."; return; }
    if (!raiz.querySelector("[data-ciente]").checked) { saida.textContent = "Confirme a validação antes de aprovar."; return; }
    let ok = 0; const falhas = [];
    for (const id of marcados) { const r = item.itens.find((x) => x.id === id); try { await fin.post(r.caminhoAprovar, {}); ok++; } catch (e) { falhas.push(`${r.obrigacao}: ${e.message}`); } }
    saida.textContent = `${ok} aprovado(s).${falhas.length ? ` Falhas: ${falhas.join(" | ")}` : ""}`;
    aviso(`${ok} rateio(s) aprovado(s).`); ctx.aoAlterar?.();
    if (!falhas.length) { painel.fechar(); }
  });
}

function abrirTransferencias(item, ctx) {
  const c = (x) => `${esc(dataBr(x.data))} · ${esc(x.conta)} · <strong>${R(x.valorCentavos)}</strong>`;
  const corpo = `<section><p><strong>${item.linhas.length} saídas · total ${R(item.valorCentavos)}</strong></p><p class="fin-sub">${esc(item.descricao)}</p>
    <div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th>Saída</th><th>Contrapartida proposta</th><th>Situação</th><th></th></tr></thead><tbody>
    ${item.linhas.map((l, i) => `<tr><td>${c(l.saida)}<br><small>${esc(l.saida.descricao ?? "")}</small></td><td>${l.contrapartidas.length ? l.contrapartidas.map(c).join("<br>") : l.alternativas.length ? `<small>${l.alternativas.length} combinações possíveis</small>` : "—"}</td>
      <td>${badge(...ROTULO_STATUS[l.status])}</td><td>${l.vincular ? `<button type="button" class="btn btn-ghost btn-sm" data-vincular="${i}">Vincular</button>` : l.vincularMultipla ? `<button type="button" class="btn btn-primary btn-sm" data-multipla="${i}">Conciliar ${l.contrapartidas.length} entradas</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="fin-sub">Vincular é uma ação humana (permissão de conciliar) e pode ser desfeita com motivo. Nos casos “soma de várias entradas”, a conciliação de 1 saída com 2–3 entradas só acontece depois que você confere a soma e escreve a justificativa; nada é confirmado sozinho e os lançamentos não são alterados.</p>
    <div data-multiplas></div>
    ${item.outras?.length ? `<details><summary>${item.outras.length} outras saídas parecidas com transferência, sem contrapartida de mesmo valor</summary><ul class="fin-lista">${item.outras.map((l) => `<li>${c(l.saida)} <small>${esc(l.saida.descricao ?? "")}</small></li>`).join("")}</ul></details>` : ""}
    <p class="fin-sub" data-resultado role="status"></p></section>`;
  const painel = abrirPainelHtml({ titulo: "Transferências internas sem vínculo", html: corpo, aoFechar: () => abrirCentral(ctx) });
  const raiz = document.querySelector(".fin-pn");
  const carregarMultiplas = async () => {
    const alvo = raiz.querySelector("[data-multiplas]"); if (!alvo) return;
    try {
      const lista = await fin.get("/transferencias/multiplas");
      alvo.innerHTML = lista.length ? `<h4>Já conciliadas com várias entradas (${lista.length})</h4><ul class="fin-lista">${lista.map((m) => `<li><strong>${R(m.valorCentavos)}</strong> · saída ${esc(dataBr(m.saida.data))} ${esc(m.saida.conta)} ⇄ ${m.entradas.map((e) => `${esc(dataBr(e.data))} ${esc(e.conta)} ${R(e.valorCentavos)}`).join(" + ")}<br><small>Justificativa: ${esc(m.justificativa)} · aprovada em ${esc(dataBr(String(m.aprovadoEm).slice(0, 10)))}</small> <button type="button" class="btn btn-ghost btn-sm" data-desfazer="${esc(m.id)}">Desfazer</button></li>`).join("")}</ul>` : "";
    } catch { alvo.innerHTML = ""; }
  };
  carregarMultiplas();
  raiz.addEventListener("click", async (e) => {
    const bm = e.target.closest("[data-multipla]");
    if (bm) {
      const l = item.linhas[Number(bm.dataset.multipla)], soma = l.contrapartidas.reduce((a, x) => a + x.valorCentavos, 0);
      dialogo({ titulo: "Conciliar 1 saída com várias entradas", enviar: "Confirmar conciliação", corpo: `
        <p class="fin-sub">Saída: ${c(l.saida)}</p><ul class="fin-lista">${l.contrapartidas.map((x) => `<li>${c(x)}</li>`).join("")}</ul>
        <p><strong>Soma das entradas ${R(soma)} = saída ${R(l.saida.valorCentavos)}</strong>${soma === l.saida.valorCentavos ? "" : " — NÃO FECHA"}</p>
        <p class="fin-sub">Os lançamentos continuam como estão (valor, data, conta e categoria ficam travados) e deixam de aparecer como pendentes. Fica registrado quem aprovou e quando. Pode ser desfeito, com motivo.</p>
        ${campo("Justificativa", "justificativa", { obrig: true, extra: 'maxlength="1000" placeholder="ex.: Stone creditou a Unicred em 3 parcelas, conferido no extrato"' })}`,
        aoEnviar: async (f) => { await fin.post(l.vincularMultipla.caminho, { ...l.vincularMultipla.corpo, justificativa: String(f.get("justificativa") ?? "").trim() }); aviso("Conciliação registrada: 1 saída com " + l.contrapartidas.length + " entradas."); ctx.aoAlterar?.(); painel.fechar(); } });
      return;
    }
    const bd = e.target.closest("[data-desfazer]");
    if (bd) {
      dialogo({ titulo: "Desfazer conciliação com várias entradas", enviar: "Desfazer", perigo: true, corpo: `<p class="fin-sub">Os lançamentos não são apagados: voltam a ficar pendentes e o motivo fica na trilha.</p>${campo("Motivo", "motivo", { obrig: true, extra: 'maxlength="1000"' })}`,
        aoEnviar: async (f) => { await fin.post(`/transferencias/multiplas/${bd.dataset.desfazer}/desvincular`, { motivo: String(f.get("motivo") ?? "").trim() }); aviso("Conciliação desfeita."); ctx.aoAlterar?.(); painel.fechar(); } });
      return;
    }
    const b = e.target.closest("[data-vincular]"); if (!b) return;
    const l = item.linhas[Number(b.dataset.vincular)]; b.disabled = true;
    try { await fin.post(l.vincular.caminho, l.vincular.corpo); aviso("Transferência vinculada."); ctx.aoAlterar?.(); painel.fechar(); }
    catch (err) { b.disabled = false; raiz.querySelector("[data-resultado]").textContent = err.message ?? "Não foi possível vincular."; }
  });
}

export async function abrirCentral(ctx) {
  const { mes, aoAlterar } = ctx;
  let d;
  try { d = await fin.get("/conferencias", { mes }); } catch (e) { aviso(e.message, "bad"); return; }
  const corpo = `<section><h4>${esc(rotuloMes(mes))}</h4>
      ${d.geral.map((g) => `<p class="fin-alerta fin-alerta--warn" role="note"><strong>${esc(g.titulo)}.</strong> ${esc(g.descricao)}</p>`).join("")}
      <p class="fin-sub">${d.total ? `${d.total} item(ns) aguardam decisão ou evidência.` : "Nenhuma conferência pendente."} Confirmar, aprovar ou classificar é uma decisão registrada com o seu usuário.</p></section>
    <section><h4>Pendências (${d.total})</h4>${d.total ? `<ul class="cf-lista">${d.pendencias.map(htmlPendencia).join("")}</ul>` : '<p class="fin-vazio-linha">Tudo conferido neste mês.</p>'}</section>
    <section><h4>Sistema × apresentação oficial</h4><p class="fin-sub">${d.resumoComparacao.conferem} de ${d.resumoComparacao.total} indicadores conferem. A apresentação é a referência documental; o sistema não é ajustado para coincidir com ela.</p>${htmlComparacao(d.comparacao)}</section>
    ${htmlPeriodos(d.periodos)}
    <section><details data-cf-hist><summary><strong>Histórico de decisões</strong></summary><div data-cf-hist-corpo><p class="fin-sub">Carregando…</p></div></details></section>`;
  const painel = abrirPainelHtml({ titulo: "Central de conferências", html: corpo });
  const raiz = document.querySelector(".fin-pn");
  raiz?.querySelector("[data-cf-hist]")?.addEventListener("toggle", async (e) => {
    if (!e.target.open) return;
    const alvo = raiz.querySelector("[data-cf-hist-corpo]");
    try { const h = await fin.get("/conferencias/historico", {}); alvo.innerHTML = h.itens.length ? `<ul class="fin-lista">${h.itens.map((i) => `<li>${esc(dataBr(String(i.em).slice(0, 10)))} · ${esc(i.entidade.replace("fin_", "").replace(/_/g, " "))} · ${esc(i.acao)}</li>`).join("")}</ul>` : "<p class=\"fin-sub\">Sem registros.</p>"; }
    catch (err) { alvo.innerHTML = `<p class="fin-sub">${esc(err.message ?? "Sem permissão para ver o histórico.")}</p>`; }
  });
  raiz?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cf-abrir]"); if (!b) return;
    const item = d.pendencias.find((p) => p.tipo === b.dataset.cfAbrir);
    painel.fechar();
    if (item?.tipo === "rateios") abrirRateios(item, ctx); else if (item?.tipo === "transferencias_internas") abrirTransferencias(item, ctx);
  });
  raiz?.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-cf-form]"); if (!f) return;
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    const li = f.closest("[data-pend]"), id = li.dataset.pend, p = d.pendencias.find((x) => x.id === id), a = p.acao, fd = new FormData(f);
    const botao = f.querySelector("button[type=submit]"); botao.disabled = true;
    try {
      const corpoPost = a.tipo === "confirmar_ajuste" ? { evidencia: fd.get("evidencia") } : a.tipo === "classificar_acrescimo" ? { classificacao: fd.get("classificacao"), motivo: fd.get("motivo") } : a.tipo === "resolver_origem" ? { contaId: fd.get("contaId") } : {};
      await fin.post(a.caminho, corpoPost);
      aviso("Decisão registrada.");
      painel.fechar(); aoAlterar?.(); abrirCentral(ctx);
    } catch (err) { botao.disabled = false; aviso(err.message || "Não foi possível registrar.", "bad"); }
  });
}
