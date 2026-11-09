// CENTRAL ÚNICA DE CONFERÊNCIAS (painel lateral). Reúne o que depende de decisão humana e compara o sistema com a apresentação oficial.
// Cada ação usa o endpoint próprio (com a permissão e a trilha dele); nada vira "confirmado" sem uma ação explícita de quem pode.
import { fin } from "./api.js";
import { moeda, rotuloMes, dataBr } from "./modelo.js";
import { abrirPainelHtml } from "./detalhe.js";
import { esc } from "./detalheHtml.js";
import { aviso, dialogo, campo, selecao } from "./ui.js";

const ROTULO_TIPO = { ajuste_vendas: "Ajuste de vendas", rateios: "Rateios", juros_presumido: "Acréscimo presumido", conta_sem_pagamento: "Conta sem pagamento", categoria_sem_regra: "Sem regra", divergencia_canais: "Divergência de canais",
  origem_pendente: "Origem pendente", transferencias_internas: "Transferências internas", classificacao_pendente: "Classificação pendente", pagamento_terceiro: "Pago por terceiro", pendencia_documental: "Pendência documental" };
const TOM_STATUS = { pendente: "warn", estimado: "warn", aguardando_comprovacao: "muted" };
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

const ESTADOS_DOC = [{ valor: "pendente", rotulo: "Pendente" }, { valor: "estimado", rotulo: "Estimado" }, { valor: "aguardando_comprovacao", rotulo: "Aguardando comprovação" }];
const paraReais = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

/** Detalhes e ações de uma pendência documental (cadastro manual). Concluir (confirmar) usa o formulário padrão da pendência, com evidência. */
function extrasDoc(p) {
  if (p.tipo !== "pendencia_documental") return "";
  return `${p.aviso ? `<p class="fin-alerta fin-alerta--warn" role="note">${esc(p.aviso)}</p>` : ""}
    ${p.observacoes ? `<p class="fin-sub"><strong>Observações:</strong> ${esc(p.observacoes)}</p>` : ""}
    ${p.documentoReferencia ? `<p class="fin-sub"><strong>Documento:</strong> ${esc(p.documentoReferencia)}</p>` : ""}
    ${p.relacionadaChave ? `<p class="fin-sub">Possivelmente relacionada a outra pendência documental: valide antes de tratar como itens independentes.</p>` : ""}
    <p class="fin-sub">Não cria lançamento, pagamento nem conciliação.
      <button type="button" class="btn btn-ghost btn-sm" data-doc-editar="${esc(p.docId)}">Editar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-doc-hist="${esc(p.docId)}">Histórico</button>
      <button type="button" class="btn btn-ghost btn-sm" data-doc-cancelar="${esc(p.docId)}">Cancelar registro</button></p><div data-doc-hist-corpo="${esc(p.docId)}"></div>`;
}

function corpoFormDoc(v = {}) {
  return `${campo("Descrição da pendência", "descricao", { obrig: true, valor: v.descricao ?? "", extra: 'maxlength="300"' })}
    ${campo("Valor envolvido (se conhecido)", "valor", { valor: paraReais(v.valorCentavos), extra: 'inputmode="decimal" placeholder="ex.: 190,53"' })}
    ${campo("Competência", "competencia", { tipo: "month", obrig: true, valor: v.competencia ?? "" })}
    ${campo("Data de referência (opcional)", "dataReferencia", { tipo: "date", valor: v.dataReferencia ?? "" })}
    ${campo("Motivo da conferência", "motivo", { obrig: true, valor: v.motivo ?? "", extra: 'maxlength="500"' })}
    ${campo("Evidência necessária", "evidenciaNecessaria", { obrig: true, valor: v.evidenciaNecessaria ?? "", extra: 'maxlength="500"' })}
    ${campo("Responsável pela conferência", "responsavel", { obrig: true, valor: v.responsavel ?? "", extra: 'maxlength="120"' })}
    ${selecao("Status", "estado", ESTADOS_DOC, { valor: v.estado ?? "pendente", obrig: true })}
    ${campo("Documento (nome ou local)", "documentoReferencia", { valor: v.documentoReferencia ?? "", extra: 'maxlength="300"' })}
    ${campo("Observações", "observacoes", { valor: v.observacoes ?? "", extra: 'maxlength="1000"' })}
    <p class="fin-sub">Registrar uma pendência não cria movimentação financeira. Para marcar como Confirmado, use “Concluir com evidência” na própria pendência.</p>`;
}
const corpoDoc = (f) => ({ descricao: f.get("descricao"), valor: String(f.get("valor") ?? "").trim() || null, competencia: f.get("competencia"), dataReferencia: f.get("dataReferencia") || null, motivo: f.get("motivo"),
  evidenciaNecessaria: f.get("evidenciaNecessaria"), responsavel: f.get("responsavel"), estado: f.get("estado"), documentoReferencia: String(f.get("documentoReferencia") ?? "").trim() || null, observacoes: String(f.get("observacoes") ?? "").trim() || null });

function htmlDocumentais(pd, concluidas) {
  const modelos = (pd?.modelos ?? []).filter((m) => !m.cadastrada);
  return `<section><h4>Pendências documentais</h4>
    <p class="fin-sub">O que depende de comprovação ou decisão e não é um registro financeiro do sistema. Cada pendência é cadastrada, editada e concluída individualmente, com trilha de auditoria.
      <button type="button" class="btn btn-primary btn-sm" data-doc-novo>Registrar pendência</button></p>
    ${modelos.length ? `<details open><summary><strong>Preparadas, ainda não cadastradas (${modelos.length})</strong></summary><ul class="fin-lista">${modelos.map((m) => `<li><strong>${esc(m.descricao)}</strong>${m.valorCentavos != null ? ` · ${R(m.valorCentavos)}` : ""}<br><small>${esc(m.motivo)}</small>${m.relacionadaChave ? "<br><small>Possivelmente relacionada a outra pendência: validar antes de tratar como independente.</small>" : ""}<br><button type="button" class="btn btn-ghost btn-sm" data-doc-modelo="${esc(m.chave)}">Cadastrar esta pendência</button></li>`).join("")}</ul></details>` : ""}
    ${concluidas?.length ? `<details><summary><strong>Concluídas (${concluidas.length})</strong></summary><ul class="fin-lista">${concluidas.map((x) => `<li>${esc(x.descricao)}${x.valorCentavos != null ? ` · ${R(x.valorCentavos)}` : ""}<br><small>Confirmada em ${esc(dataBr(String(x.confirmacao.em).slice(0, 10)))} · evidência: ${esc(x.confirmacao.evidencia)}${x.documentoReferencia ? ` · documento: ${esc(x.documentoReferencia)}` : ""}</small></li>`).join("")}</ul></details>` : ""}</section>`;
}

function htmlPendencia(p) {
  const itens = p.tipo === "classificacao_pendente" && (p.itens ?? []).length ? `<ul class="fin-lista">${p.itens.map((x) => `<li>${esc(dataBr(x.data))} · ${esc(x.conta)} · ${x.sentido === "entrada" ? "entrada" : "saída"} <strong>${R(x.valorCentavos)}</strong> — ${esc(x.descricao ?? "")}${x.nota ? `<br><small>${esc(x.nota)}</small>` : ""}</li>`).join("")}</ul>` : "";
  const ficha = p.responsavel ? `<dl class="cf-ficha"><dt>Motivo</dt><dd>${esc(p.motivo ?? p.descricao)}</dd><dt>Evidência necessária</dt><dd>${esc(p.evidenciaNecessaria ?? "")}</dd><dt>Responsável pela conferência</dt><dd>${esc(p.responsavel)}</dd></dl>` : "";
  return `<li class="cf-item" data-pend="${esc(p.id)}"><div class="cf-topo">${badge(ROTULO_TIPO[p.tipo] ?? p.tipo, p.gravidade === "divergencia" ? "bad" : "warn")}${p.status ? badge(p.statusRotulo ?? p.status, TOM_STATUS[p.status] ?? "warn") : ""}${p.valorCentavos != null ? `<strong>${R(p.valorCentavos)}</strong>` : ""}</div>
    <h4>${esc(p.titulo)}</h4>${p.responsavel ? "" : `<p>${esc(p.descricao)}</p>`}${ficha}${itens}${extrasDoc(p)}
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
  const corpo = `<section><p class="fin-sub">Aprovar muda o rateio de “proposto” para “aprovado” (decisão da contadora, registrada com o seu usuário e o horário). A aprovação é feita um rateio por vez, depois de conferir o documento: não há aprovação em massa.</p>
    <div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th>Aprovação</th><th>Obrigação</th><th class="fin-num">Valor</th><th>Competências</th><th>Critério e evidência</th></tr></thead><tbody>
    ${item.itens.map((r) => `<tr data-rateio="${esc(r.id)}"><td><label class="fin-campo fin-campo--inline"><span><input type="checkbox" name="r" value="${esc(r.id)}" data-validado> Conferi o documento</span></label><button type="button" class="btn btn-primary btn-sm" data-aprovar-um="${esc(r.id)}" aria-label="Aprovar ${esc(r.obrigacao)}">Aprovar este</button></td>
      <td>${esc(r.obrigacao)}<br><small>${esc(r.categoria ?? "")}${r.fornecedor ? ` · ${esc(r.fornecedor)}` : ""} · competência da conta ${esc(r.competenciaObrigacao ?? "—")}</small></td><td class="fin-num">${R(r.valorElegivelCentavos)}</td>
      <td>${r.parcelas.map((p) => `${esc(rotuloMes(p.competencia))}: <strong>${R(p.valorCentavos)}</strong>`).join("<br>")}</td>
      <td><strong>${esc(r.criterio === "producao" ? "período de produção" : r.criterio === "dias_consumo" ? "dias de consumo" : r.criterio)}</strong><br><small>${esc(r.justificativa)}</small><br><small>${r.evidencia ? `Evidência: ${esc(r.evidencia)}` : "Sem documento anexado: a evidência é o critério acima."}</small></td></tr>`).join("")}
    </tbody></table></div>
    <p class="fin-sub" data-resultado role="status"></p></section>`;
  const painel = abrirPainelHtml({ titulo: "Aprovação dos rateios", html: corpo, aoFechar: () => abrirCentral(ctx) });
  const raiz = document.querySelector(".fin-pn");
  raiz.addEventListener("click", async (e) => {
    const bt = e.target.closest("[data-aprovar-um]"); if (!bt) return;
    const linha = bt.closest("tr"), saida = raiz.querySelector("[data-resultado]"), r = item.itens.find((x) => x.id === bt.dataset.aprovarUm);
    if (!linha.querySelector("[data-validado]").checked) { saida.textContent = "Marque \"Conferi o documento\" neste rateio antes de aprovar."; return; }
    bt.disabled = true;
    try { await fin.post(r.caminhoAprovar, {}); aviso("Rateio aprovado."); ctx.aoAlterar?.(); painel.fechar(); }
    catch (err) { bt.disabled = false; saida.textContent = `${r.obrigacao}: ${err.message ?? "não foi possível aprovar"}`; }
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
  let pd = null;
  try { pd = await fin.get("/pendencias-documentais", { mes }); } catch { pd = null; }
  const corpo = `<section><h4>${esc(rotuloMes(mes))}</h4>
      ${d.geral.map((g) => `<p class="fin-alerta fin-alerta--warn" role="note"><strong>${esc(g.titulo)}.</strong> ${esc(g.descricao)}</p>`).join("")}
      <p class="fin-sub">${d.total ? `${d.total} item(ns) aguardam decisão ou evidência.` : "Nenhuma conferência pendente."} Confirmar, aprovar ou classificar é uma decisão registrada com o seu usuário.</p></section>
    ${htmlDocumentais(pd, d.concluidasDocumentais)}
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
  const recarregar = () => { painel.fechar(); aoAlterar?.(); abrirCentral(ctx); };
  raiz?.addEventListener("click", async (e) => {
    const modelo = e.target.closest("[data-doc-modelo]");
    if (modelo) { modelo.disabled = true; try { await fin.post(`/pendencias-documentais/modelos/${encodeURIComponent(modelo.dataset.docModelo)}`, {}); aviso("Pendência cadastrada (sem movimentação financeira)."); recarregar(); } catch (err) { modelo.disabled = false; aviso(err.message || "Não foi possível cadastrar.", "bad"); } return; }
    if (e.target.closest("[data-doc-novo]")) {
      dialogo({ titulo: "Registrar pendência documental", enviar: "Registrar", corpo: corpoFormDoc({ competencia: mes }), aoEnviar: async (f) => { await fin.post("/pendencias-documentais", corpoDoc(f)); aviso("Pendência registrada."); recarregar(); } });
      return;
    }
    const ed = e.target.closest("[data-doc-editar]");
    if (ed) {
      const x = (pd?.itens ?? []).find((i) => i.id === ed.dataset.docEditar); if (!x) return;
      dialogo({ titulo: "Editar pendência documental", enviar: "Salvar", corpo: corpoFormDoc(x), aoEnviar: async (f) => { await fin.patch(`/pendencias-documentais/${x.id}`, corpoDoc(f)); aviso("Pendência atualizada."); recarregar(); } });
      return;
    }
    const ca = e.target.closest("[data-doc-cancelar]");
    if (ca) {
      dialogo({ titulo: "Cancelar registro da pendência", enviar: "Cancelar registro", perigo: true, corpo: `<p class="fin-sub">O registro não é apagado: sai da lista e o motivo fica na trilha.</p>${campo("Motivo", "motivo", { obrig: true, extra: 'maxlength="500"' })}`,
        aoEnviar: async (f) => { await fin.post(`/pendencias-documentais/${ca.dataset.docCancelar}/cancelar`, { motivo: String(f.get("motivo") ?? "").trim() }); aviso("Registro cancelado."); recarregar(); } });
      return;
    }
    const hi = e.target.closest("[data-doc-hist]");
    if (hi) {
      const alvo = raiz.querySelector(`[data-doc-hist-corpo="${hi.dataset.docHist}"]`);
      try { const h = await fin.get(`/pendencias-documentais/${hi.dataset.docHist}/historico`, {}); alvo.innerHTML = h.itens.length ? `<ul class="fin-lista">${h.itens.map((i) => `<li>${esc(dataBr(String(i.em).slice(0, 10)))} · ${esc(i.acao)}</li>`).join("")}</ul>` : '<p class="fin-sub">Sem registros.</p>'; }
      catch (err) { alvo.innerHTML = `<p class="fin-sub">${esc(err.message ?? "Sem permissão para ver o histórico.")}</p>`; }
    }
  });
  raiz?.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-cf-form]"); if (!f) return;
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    const li = f.closest("[data-pend]"), id = li.dataset.pend, p = d.pendencias.find((x) => x.id === id), a = p.acao, fd = new FormData(f);
    const botao = f.querySelector("button[type=submit]"); botao.disabled = true;
    try {
      const corpoPost = a.tipo === "confirmar_ajuste" || a.tipo === "concluir_documental" ? { evidencia: fd.get("evidencia") } : a.tipo === "classificar_acrescimo" ? { classificacao: fd.get("classificacao"), motivo: fd.get("motivo") } : a.tipo === "resolver_origem" ? { contaId: fd.get("contaId") } : {};
      await fin.post(a.caminho, corpoPost);
      aviso("Decisão registrada.");
      painel.fechar(); aoAlterar?.(); abrirCentral(ctx);
    } catch (err) { botao.disabled = false; aviso(err.message || "Não foi possível registrar.", "bad"); }
  });
}
