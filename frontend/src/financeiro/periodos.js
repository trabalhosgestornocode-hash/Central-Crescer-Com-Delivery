// Períodos — abertura, pré-fechamento, fechamento (snapshot imutável) e reabertura controlada.
// Fechar com pendências NÃO é uma política que o gestor liga: só por EXCEÇÃO por unidade e competência, aprovada por SuperAdmin (uso único), e com
// reconhecimento explícito. Esta tela apenas MOSTRA a exceção — não há botão para pedir/conceder. A reabertura depende de uma
// autorização que nenhum nível possui nesta versão: a tela só oferece o botão a quem tiver `reabrir`, e o servidor decide (fail-closed).
import { fin } from "./api.js";
import { moeda, pct, rotuloMes, podeAcao, ACAO_FECHAMENTO, ROTULO_STATUS_PERIODO } from "./modelo.js";
import { garantirCss, cabecalho, tabela, badge, carregarEm, dialogo, campo, aviso, esc, estado } from "./ui.js";

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pFechar = podeAcao(ctx, ACAO_FECHAMENTO.FECHAR), pReabrir = podeAcao(ctx, ACAO_FECHAMENTO.REABRIR);
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    titulo: "Períodos", sub: "Fechar um mês congela o snapshot dos resultados e bloqueia lançamentos, referências e classificações naquele mês.",
    extra: pFechar ? `<button class="btn btn-ghost btn-sm" data-abrir>Abrir período</button>` : "",
  });

  function carregar() {
    carregarEm(corpo, () => fin.get("/periodos"), pintar);
  }

  const ROTULO_EXCECAO = { ativa: ["Ativa", "warn"], consumida: ["Usada", "muted"], revogada: ["Revogada", "muted"] };
  function pintar({ periodos, excecoes = [] }) {
    const exc = excecoes.length ? tabela({ colunas: [
      { rotulo: "Mês", render: (e) => esc(rotuloMes(e.mes)) },
      { rotulo: "Situação", render: (e) => { const [r, t] = ROTULO_EXCECAO[e.status] ?? [e.status, "muted"]; return badge(r, t); } },
      { rotulo: "Pendências cobertas", num: true, render: (e) => String(e.quantidade + e.pendenciasConciliacao) },
      { rotulo: "Validade", render: (e) => esc(new Date(e.expiraEm).toLocaleDateString("pt-BR")) },
      { rotulo: "Justificativa", render: (e) => `<small>${esc(e.justificativa)}</small>` },
    ], linhas: excecoes, vazio: "" }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"') : "";
    const pol = `<div class="fin-card"><h3>Fechamento com pendências</h3>
      <p>${badge("Bloqueado", "ok")} O gestor fecha períodos sem pendências impeditivas. Fechar com pendências só é possível por uma <strong>exceção por unidade e competência</strong>,
      aprovada excepcionalmente por SuperAdmin: justificada, auditada, de uso único e nunca permanente. Esse fluxo está indisponível até a validação do MFA.</p>${exc}</div>`;
    const tb = tabela({ colunas: [
      { rotulo: "Mês", render: (p) => `${esc(rotuloMes(p.mes))}` },
      { rotulo: "Situação", render: (p) => { const s = ROTULO_STATUS_PERIODO[p.status] ?? { rotulo: p.status, tom: "muted" }; return badge(s.rotulo, s.tom); } },
      { rotulo: "Resultado no fechamento", num: true, render: (p) => (p.snapshot ? moeda(p.snapshot.resultadoGerencial) : "—") },
      { rotulo: "Fechado", render: (p) => (p.fechadoEm ? esc(new Date(p.fechadoEm).toLocaleString("pt-BR")) : "—") },
      { rotulo: "Reabertura", render: (p) => (p.motivoReabertura ? `<small>${esc(p.motivoReabertura)}</small>` : "—") },
      { rotulo: "", render: (p) => `<div class="fin-linha-acoes">
        ${p.status !== "fechado" ? `<button class="btn btn-ghost btn-sm" data-pre="${esc(p.mes)}">Pré-fechamento</button>` : ""}
        ${p.status === "fechado" ? `<button class="btn btn-ghost btn-sm" data-snap="${esc(p.mes)}">Ver snapshot</button>` : ""}
        ${p.status === "fechado" && pReabrir ? `<button class="btn btn-ghost btn-sm" data-reabrir="${esc(p.mes)}|${p.versao}">Reabrir</button>` : ""}</div>` },
    ], linhas: periodos, vazio: "Nenhum período ainda. Os meses aparecem ao registrar lançamentos ou ao abrir um período." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `${pol}<div class="fin-card"><h3>Meses</h3>${tb}</div>
      <p class="fin-sub">Reabrir exige autorização específica que ainda não foi concedida a nenhum nível; sem ela a operação é recusada pelo servidor.</p>`;

    corpo.querySelectorAll("[data-pre]").forEach((b) => b.addEventListener("click", () => preFechamento(b.dataset.pre)));
    corpo.querySelectorAll("[data-snap]").forEach((b) => b.addEventListener("click", () => snapshot(periodos.find((p) => p.mes === b.dataset.snap))));
    corpo.querySelectorAll("[data-reabrir]").forEach((b) => b.addEventListener("click", () => {
      const [mes, versao] = b.dataset.reabrir.split("|");
      dialogo({
        titulo: `Reabrir ${rotuloMes(mes)}`, enviar: "Reabrir período", perigo: true,
        corpo: `<p>O mês volta a aceitar alterações. A reabertura fica na auditoria e o snapshot anterior é preservado no histórico.</p>
          <label class="fin-campo"><span>Motivo (mín. 10 caracteres) *</span><textarea name="motivo" rows="3" required minlength="10" maxlength="1000"></textarea></label>`,
        aoEnviar: async (d) => { await fin.post(`/periodos/${mes}/reabrir`, { motivo: d.get("motivo"), versao: Number(versao) }); aviso("Período reaberto."); carregar(); },
      });
    }));
  }

  async function preFechamento(mes) {
    const dlg = dialogo({ titulo: `Pré-fechamento de ${rotuloMes(mes)}`, enviar: "Fechar período", corpo: estado.carregando(), aoEnviar: async () => { await dlg._fechar(); } });
    try {
      const x = await fin.get(`/periodos/${mes}/pre-fechamento`);
      const i = x.resumo.indicadores;
      const botao = dlg.querySelector('[type="submit"]');
      const podeFechar = x.avaliacao.pode && pFechar && !x.vazio;
      botao.disabled = !podeFechar;
      dlg.querySelector(".fin-form-corpo").innerHTML = `
        ${x.vazio ? `<div class="fin-alerta fin-alerta--warn">Sem lançamentos neste mês.</div>` : ""}
        <div class="fin-kpis"><article class="fin-kpi"><span class="fin-kpi-rot">Receita recebida</span><strong class="fin-kpi-val">${moeda(i.receitaOperacional)}</strong></article>
          <article class="fin-kpi"><span class="fin-kpi-rot">Resultado gerencial</span><strong class="fin-kpi-val">${moeda(i.resultadoGerencial)}</strong><span class="fin-kpi-sub">margem ${pct(i.margemLiquidaBps)}</span></article>
          <article class="fin-kpi"><span class="fin-kpi-rot">Variação do caixa</span><strong class="fin-kpi-val">${moeda(i.variacaoCaixa, { sinal: true })}</strong></article></div>
        <p>Pendências: <strong>${x.pendencias.lancamentos}</strong> de classificação · <strong>${x.pendencias.conciliacao}</strong> de conciliação. ${i.parcial ? badge("Indicadores parciais", "warn") : ""} ${x.resumo.saldoFinalParcial ? badge("Saldos parciais", "warn") : ""}</p>
        ${x.avaliacao.bloqueios.map((b) => `<div class="fin-alerta fin-alerta--bad" role="alert">${esc(b.texto)}</div>`).join("")}
        ${x.avaliacao.exigeReconhecimento ? `<label><input type="checkbox" name="reconheco"> Reconheço as ${x.pendencias.total} pendência(s) e quero fechar assim mesmo (exceção aprovada).</label>` : ""}
        <label><input type="checkbox" name="confirmo" required> Confirmo o fechamento de ${esc(rotuloMes(mes))}: o snapshot ficará imutável.</label>
        <p class="fin-sub">Se algo mudar no mês enquanto esta janela estiver aberta, o fechamento será recusado e você precisará recarregar.</p>`;
      dlg._fechar = async () => {
        const f = dlg.querySelector("form");
        await fin.post(`/periodos/${mes}/fechar`, { confirmo: f.confirmo.checked, versao: x.periodo.versao, fingerprint: x.fingerprint, reconhecoPendencias: f.reconheco?.checked === true });
        aviso("Período fechado."); carregar();
      };
    } catch (e) { dlg.querySelector(".fin-form-corpo").innerHTML = estado.erro(e.message); dlg.querySelector('[type="submit"]').disabled = true; }
  }

  async function snapshot(p) {
    dialogo({
      titulo: `Snapshot de ${rotuloMes(p.mes)}`, enviar: "Fechar", aoEnviar: async () => {},
      corpo: `<p>Fechado em ${esc(p.fechadoEm ? new Date(p.fechadoEm).toLocaleString("pt-BR") : "—")}. ${p.snapshot?.pendenciasNoFechamento ? badge(`${p.snapshot.pendenciasNoFechamento} pendência(s) no fechamento`, "warn") : badge("Sem pendências no fechamento", "ok")}</p>
        <div class="fin-kpis"><article class="fin-kpi"><span class="fin-kpi-rot">Receita recebida</span><strong class="fin-kpi-val">${moeda(p.snapshot?.receitaOperacional)}</strong></article>
        <article class="fin-kpi"><span class="fin-kpi-rot">Resultado gerencial</span><strong class="fin-kpi-val">${moeda(p.snapshot?.resultadoGerencial)}</strong></article>
        <article class="fin-kpi"><span class="fin-kpi-rot">Variação do caixa</span><strong class="fin-kpi-val">${moeda(p.snapshot?.variacaoCaixa, { sinal: true })}</strong></article></div>
        <p class="fin-sub">Valores congelados no instante do fechamento (regime de caixa). Não são recalculados.</p>`,
    });
  }

  raiz.querySelector("[data-abrir]")?.addEventListener("click", () => dialogo({
    titulo: "Abrir período", enviar: "Abrir",
    corpo: `<label class="fin-campo"><span>Mês *</span><input type="month" name="mes" required></label><p class="fin-sub">Abrir é idempotente; os meses também surgem sozinhos ao lançar.</p>`,
    aoEnviar: async (d) => { await fin.post("/periodos/abrir", { mes: d.get("mes") }); aviso("Período aberto."); carregar(); },
  }));
  carregar();
}
