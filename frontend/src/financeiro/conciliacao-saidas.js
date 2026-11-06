// Conciliação de Saídas (Financeiro 2.0): pagamento registrado ⇄ saída do extrato. O sistema SUGERE; uma pessoa CONFIRMA.
// Nenhuma sugestão vira conciliação sozinha, nem quando valor e data coincidem. Toda confirmação guarda a evidência (ids e origem do extrato).
import { fin } from "./api.js";
import { moeda, dataBr, rotuloMes, podeAcao } from "./modelo.js";
import { ACAO_FIN2, STATUS_SAIDA, REGRA_SUGESTAO } from "./modeloContasPagar.js";
import { garantirCss, cabecalho, seletorMes, kpi, tabela, badge, carregarEm, lerMes, gravarMes, dialogo, aviso, esc, estado } from "./ui.js";
import { tabelaCartao } from "./tabelaCartao.js";

const st = (s) => STATUS_SAIDA[s] ?? { rotulo: s, tom: "muted" };
const pagsTxt = (g) => g.pagamentos.map((p) => `${esc(p.fornecedor ?? "—")} · ${esc(dataBr(p.data))} · ${esc(moeda(p.valorCentavos))}`).join("<br>");
const saidaTxt = (s) => (s ? `${esc(dataBr(s.data))} · ${esc(s.conta ?? "")}<br><small>${esc(s.descricao ?? "")}</small>` : "—");

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pode = (a) => podeAcao(ctx, a);
  let mes = lerMes();
  let painel = null;
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    titulo: "Conciliação de Saídas",
    sub: "Cada pagamento registrado é comparado com a saída do extrato da conta usada. O sistema só sugere; a confirmação é sempre de uma pessoa.",
    extra: `${seletorMes(mes)}${pode(ACAO_FIN2.CONCILIAR) ? `<button class="btn btn-ghost btn-sm" data-manual>Vincular manualmente</button><button class="btn btn-primary btn-sm" data-sugerir>Gerar sugestões</button>` : ""}`,
  });
  raiz.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  const carregar = () => carregarEm(corpo, () => fin.get("/conciliacao-saidas", { mes }), (p) => { painel = p; pintar(p); });

  function pintar(p) {
    const c = p.contagem;
    const kpis = ["conciliado", "sugerido", "divergente", "pendente", "a_identificar"].map((k) => kpi({
      rotulo: st(k).rotulo, valor: String(k === "a_identificar" ? c.aIdentificar : c[k]),
      sub: { conciliado: "Confirmados por uma pessoa", sugerido: "Aguardando confirmação", divergente: "Fora da tolerância: exigem justificativa", pendente: "Pagamentos sem saída no extrato", a_identificar: "Saídas sem pagamento nem classificação" }[k],
    })).join("");
    const abertos = p.grupos.filter((g) => g.status === "sugerido" || g.status === "divergente");
    const conc = p.grupos.filter((g) => g.status === "conciliado");
    const tbAbertos = tabelaCartao({
      colunas: [
        { rotulo: "Situação", render: (g) => `${badge(st(g.status).rotulo, st(g.status).tom)}${g.agrupado ? `<br>${badge("Agrupado", "info")}` : ""}` },
        { rotulo: "Saída do extrato", render: (g) => saidaTxt(g.saida) },
        { rotulo: "Valor no extrato", num: true, render: (g) => moeda(g.saida?.valorCentavos) },
        { rotulo: "Pagamento(s)", render: pagsTxt },
        { rotulo: "Diferença", num: true, render: (g) => `${moeda(g.diferencaCentavos, { sinal: true })}<br><small>${g.diasDiferenca} dia(s)</small>` },
        { rotulo: "Regra", render: (g) => `<small>${esc(REGRA_SUGESTAO[g.regra] ?? g.regra)}</small>` },
        { rotulo: "", render: (g) => (pode(ACAO_FIN2.CONCILIAR) ? `<div class="fin-linha-acoes"><button class="btn btn-primary btn-sm" data-confirmar="${g.grupo}">Confirmar</button><button class="btn btn-ghost btn-sm" data-rejeitar="${g.grupo}">Rejeitar</button></div>` : "") },
      ],
      linhas: abertos, vazio: "Nenhuma sugestão ou divergência aguardando decisão.",
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const tbConc = tabelaCartao({
      colunas: [
        { rotulo: "Saída do extrato", render: (g) => saidaTxt(g.saida) },
        { rotulo: "Valor", num: true, render: (g) => moeda(g.saida?.valorCentavos) },
        { rotulo: "Pagamento(s)", render: pagsTxt },
        { rotulo: "Confirmação", render: (g) => `<small>${esc(g.confirmadoEm ? new Date(g.confirmadoEm).toLocaleString("pt-BR") : "")}</small>${g.justificativa ? `<br><small>Justificativa: ${esc(g.justificativa)}</small>` : ""}` },
        { rotulo: "", render: (g) => `<div class="fin-linha-acoes"><button class="btn btn-ghost btn-sm" data-evidencia="${g.grupo}">Evidência</button>${pode(ACAO_FIN2.CONCILIAR) ? `<button class="btn btn-ghost btn-sm" data-revogar="${g.grupo}">Desfazer</button>` : ""}</div>` },
      ],
      linhas: conc, vazio: "Nenhuma saída conciliada neste mês.",
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const tbPend = tabelaCartao({
      colunas: [
        { rotulo: "Data", render: (x) => dataBr(x.data) }, { rotulo: "Fornecedor", render: (x) => `${esc(x.fornecedor ?? "—")}<br><small>${esc(x.descricao ?? "")}</small>` },
        { rotulo: "Conta", render: (x) => esc(x.conta ?? "—") }, { rotulo: "Valor", num: true, render: (x) => moeda(x.valorCentavos) },
        { rotulo: "", render: (x) => (pode(ACAO_FIN2.CONCILIAR) ? `<button class="btn btn-ghost btn-sm" data-vincular-pag="${x.id}">Vincular</button>` : "") },
      ],
      linhas: p.pendentes, vazio: "Todos os pagamentos do mês têm saída vinculada.",
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const tbIdent = tabelaCartao({
      colunas: [
        { rotulo: "Data", render: (x) => dataBr(x.data) }, { rotulo: "Descrição no extrato", render: (x) => esc(x.descricao ?? "") },
        { rotulo: "Conta", render: (x) => esc(x.conta ?? "—") }, { rotulo: "Valor", num: true, render: (x) => moeda(x.valorCentavos) },
      ],
      linhas: p.aIdentificar, vazio: "Nenhuma saída sem identificação.",
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `<div class="fin-kpis">${kpis}</div>
      <div class="fin-alerta fin-alerta--info" role="note">Tolerância das sugestões: até ${esc(moeda(p.tolerancia.centavos))} e ${p.tolerancia.dias} dia. Fora dela, a confirmação exige justificativa. Divergência sem justificativa impede o fechamento do mês.</div>
      <div class="fin-card"><h3>Aguardando decisão</h3>${tbAbertos}</div>
      <div class="fin-card"><h3>Pagamentos sem saída no extrato (pendentes)</h3>${tbPend}</div>
      <div class="fin-card"><h3>Saídas a identificar</h3><p class="fin-sub">Saídas do extrato sem pagamento vinculado e sem categoria. Registre a conta a pagar correspondente ou classifique o lançamento no Fluxo de Caixa.</p>${tbIdent}</div>
      <div class="fin-card"><h3>Conciliadas — ${esc(rotuloMes(mes))}</h3>${tbConc}</div>`;
  }

  const grupo = (id) => painel?.grupos.find((g) => g.grupo === id);
  function confirmar(id) {
    const g = grupo(id);
    const fora = g && !g.dentroTolerancia;
    dialogo({
      titulo: "Confirmar conciliação", enviar: "Confirmar",
      corpo: `<p>Saída de <strong>${esc(moeda(g?.saida?.valorCentavos))}</strong> em ${esc(dataBr(g?.saida?.data))} ⇄ ${g?.pagamentos.length} pagamento(s) somando <strong>${esc(moeda((g?.saida?.valorCentavos ?? 0) - (g?.diferencaCentavos ?? 0)))}</strong>.</p>
        ${fora ? `<div class="fin-alerta fin-alerta--warn">${g.contaDiferente ? "O pagamento foi registrado em outra conta, diferente da conta da saída do extrato. " : ""}Diferença de ${esc(moeda(g.diferencaCentavos, { sinal: true }))} e/ou ${g.diasDiferenca} dia(s): fora da tolerância. Explique a diferença.</div>
        <label class="fin-campo"><span>Justificativa (mín. 10 caracteres) *</span><textarea name="justificativa" rows="3" required minlength="10" maxlength="1000"></textarea></label>` : `<p class="fin-sub">Ao confirmar, os identificadores do extrato e dos pagamentos ficam gravados como evidência.</p>`}`,
      aoEnviar: async (f) => { await fin.post(`/conciliacao-saidas/${id}/confirmar`, { justificativa: f.get("justificativa") || undefined }); aviso("Conciliação confirmada."); carregar(); },
    });
  }
  function evidencia(id) {
    const e = grupo(id)?.evidencia;
    dialogo({ titulo: "Evidência da conciliação", enviar: "Fechar", aoEnviar: async () => {}, corpo: e ? `<dl class="fin-dl">
      <dt>Saída (extrato)</dt><dd>${esc(dataBr(e.lancamento?.data))} · ${esc(moeda(e.lancamento?.valorCentavos))}<br><small>id ${esc(e.lancamento?.id)}</small></dd>
      <dt>Origem</dt><dd>${esc(e.lancamento?.origem ?? "—")}${e.lancamento?.referenciaOrigem ? ` · ${esc(e.lancamento.referenciaOrigem)}` : ""}${e.lancamento?.importacaoId ? `<br><small>importação ${esc(e.lancamento.importacaoId)}</small>` : ""}</dd>
      <dt>Pagamentos</dt><dd>${(e.pagamentos ?? []).map((p) => `${esc(dataBr(p.data))} · ${esc(moeda(p.valorCentavos))}<br><small>id ${esc(p.id)}</small>`).join("<br>")}</dd>
      <dt>Diferença</dt><dd>${esc(moeda(e.diferencaCentavos, { sinal: true }))} · ${e.diasDiferenca} dia(s)</dd>
      <dt>Confirmado em</dt><dd>${esc(new Date(e.confirmadoEm).toLocaleString("pt-BR"))}</dd></dl>` : estado.vazio("Sem evidência", "") });
  }
  function manual(pagamentoPre) {
    const saidas = [...(painel?.aIdentificar ?? []), ...(painel?.saidasSemVinculo ?? [])];
    const pend = painel?.pendentes ?? [];
    if (!saidas.length || !pend.length) { aviso(!saidas.length ? "Não há saídas do extrato sem vínculo neste mês." : "Não há pagamentos pendentes neste mês.", "bad"); return; }
    const dlg = dialogo({
      titulo: "Vincular manualmente", enviar: "Vincular",
      corpo: `<label class="fin-campo"><span>Saída do extrato *</span><select name="lancamentoId" required><option value="">Escolha…</option>${saidas.map((s) => `<option value="${esc(s.id)}" data-v="${s.valorCentavos}" data-d="${esc(s.data)}">${esc(dataBr(s.data))} · ${esc(moeda(s.valorCentavos))} · ${esc(s.descricao ?? "")}</option>`).join("")}</select></label>
        <fieldset class="fin-form-corpo"><legend>Pagamento(s) *</legend>${pend.map((x) => `<label class="fin-campo fin-campo--inline"><span><input type="checkbox" name="pagamentoIds" value="${esc(x.id)}" data-v="${x.valorCentavos}" ${x.id === pagamentoPre ? "checked" : ""}> ${esc(dataBr(x.data))} · ${esc(x.fornecedor ?? "—")} · ${esc(moeda(x.valorCentavos))}</span></label>`).join("")}</fieldset>
        <div class="fin-alerta fin-alerta--info" data-previa role="status" aria-live="polite">Escolha a saída e os pagamentos.</div>
        <label class="fin-campo"><span>Justificativa (obrigatória fora da tolerância)</span><textarea name="justificativa" rows="2" maxlength="1000"></textarea></label>`,
      aoEnviar: async (f) => {
        const ids = f.getAll("pagamentoIds");
        if (!ids.length) throw new Error("Escolha ao menos um pagamento.");
        const r = await fin.post("/conciliacao-saidas/vincular", { lancamentoId: f.get("lancamentoId"), pagamentoIds: ids, justificativa: f.get("justificativa") || undefined });
        aviso(r.status === "conciliado" ? "Vínculo confirmado." : "Vínculo registrado como DIVERGENTE: confirme com justificativa.", r.status === "conciliado" ? "ok" : "bad");
        carregar();
      },
    });
    const f = dlg.querySelector("form"), box = dlg.querySelector("[data-previa]");
    const upd = () => {
      const o = f.elements.lancamentoId.selectedOptions[0]; const marcados = [...f.querySelectorAll('[name="pagamentoIds"]:checked')];
      if (!o?.value || !marcados.length) { box.textContent = "Escolha a saída e os pagamentos."; return; }
      const dif = Number(o.dataset.v) - marcados.reduce((a, x) => a + Number(x.dataset.v), 0);
      box.textContent = Math.abs(dif) <= painel.tolerancia.centavos ? `Diferença ${moeda(dif, { sinal: true })}: dentro da tolerância (confira também as datas).` : `Diferença ${moeda(dif, { sinal: true })}: fora da tolerância — o vínculo ficará DIVERGENTE se não houver justificativa.`;
      box.className = `fin-alerta fin-alerta--${Math.abs(dif) <= painel.tolerancia.centavos ? "info" : "warn"}`;
    };
    f.addEventListener("change", upd); upd();
  }

  raiz.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.matches("[data-sugerir]")) {
      b.disabled = true;
      try { const r = await fin.post("/conciliacao-saidas/sugerir", { mes }); aviso(`${r.sugestoesCriadas} sugestão(ões) nova(s)${r.ambiguos ? ` · ${r.ambiguos} caso(s) ambíguo(s) para vínculo manual` : ""}. Confirme uma a uma.`); carregar(); }
      catch (err) { aviso(err.message, "bad"); } finally { b.disabled = false; }
    }
    if (b.matches("[data-manual]")) manual(null);
    if (b.dataset.vincularPag) manual(b.dataset.vincularPag);
    if (b.dataset.confirmar) confirmar(b.dataset.confirmar);
    if (b.dataset.evidencia) evidencia(b.dataset.evidencia);
    if (b.dataset.rejeitar) { try { await fin.post(`/conciliacao-saidas/${b.dataset.rejeitar}/rejeitar`); aviso("Sugestão rejeitada."); carregar(); } catch (err) { aviso(err.message, "bad"); } }
    if (b.dataset.revogar) dialogo({ titulo: "Desfazer conciliação", enviar: "Desfazer", perigo: true, corpo: `<p>O registro não é apagado: fica como revogado, com o motivo e a evidência original.</p><label class="fin-campo"><span>Motivo (mín. 10 caracteres) *</span><textarea name="motivo" rows="3" required minlength="10" maxlength="1000"></textarea></label>`, aoEnviar: async (f) => { await fin.post(`/conciliacao-saidas/${b.dataset.revogar}/revogar`, { motivo: f.get("motivo") }); aviso("Conciliação desfeita."); carregar(); } });
  });
  carregar();
}
