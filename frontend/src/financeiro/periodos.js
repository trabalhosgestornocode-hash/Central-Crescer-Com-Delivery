// Períodos — abertura, pré-fechamento, fechamento (snapshot imutável) (a reabertura está desabilitada).
// Fechar com pendências NÃO é uma política que o gestor liga: só por EXCEÇÃO por unidade e competência, aprovada por SuperAdmin (uso único), e com
// reconhecimento explícito. Esta tela apenas MOSTRA a exceção — não há botão para pedir/conceder.
// A reabertura NÃO existe nesta versão (nem botão nem rota): fica desabilitada até a política de autorização ser aprovada.
import { fin } from "./api.js";
import { moeda, pct, rotuloMes, podeAcao, ACAO_FECHAMENTO, ROTULO_STATUS_PERIODO } from "./modelo.js";
import { garantirCss, cabecalho, tabela, badge, carregarEm, dialogo, campo, aviso, esc, estado } from "./ui.js";

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pFechar = podeAcao(ctx, ACAO_FECHAMENTO.FECHAR);
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
      </div>` },
    ], linhas: periodos, vazio: "Nenhum período ainda. Os meses aparecem ao registrar lançamentos ou ao abrir um período." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `${pol}<div class="fin-card"><h3>Meses</h3>${tb}</div>
      <p class="fin-sub">A reabertura de períodos fechados está desabilitada: não há botão nem rota até a política de autorização ser aprovada.</p>`;

    corpo.querySelectorAll("[data-pre]").forEach((b) => b.addEventListener("click", () => preFechamento(b.dataset.pre)));
    corpo.querySelectorAll("[data-snap]").forEach((b) => b.addEventListener("click", () => snapshot(periodos.find((p) => p.mes === b.dataset.snap))));
  }

  async function preFechamento(mes) {
    const dlg = dialogo({ titulo: `Pré-fechamento de ${rotuloMes(mes)}`, enviar: "Fechar período", corpo: estado.carregando(), aoEnviar: async () => { await dlg._fechar(); } });
    const botao = () => dlg.querySelector('[type="submit"]');
    const corpoEl = () => dlg.querySelector(".fin-form-corpo");
    /** F-2: conflitos em que os DADOS mudaram (impressão digital/versão) ou o banco recalculou a conciliação de forma diferente. */
    const DADOS_MUDARAM = new Set(["FIN_PERIODO_CONFLITO_DADOS", "FIN_PERIODO_CONFLITO_VERSAO", "FIN_CONCILIACAO_DIVERGENTE"]);
    /** (Re)carrega a prévia. A impressão digital anterior é DESCARTADA antes de qualquer nova leitura; só depois da leitura nova a confirmação pode voltar. */
    async function atualizar() {
      dlg._previa = null; botao().disabled = true; dlg.querySelector(".fin-form-erro").hidden = true; corpoEl().innerHTML = estado.carregando();
    try {
      const x = await fin.get(`/periodos/${mes}/pre-fechamento`);
      const i = x.resumo.indicadores;
      const podeFechar = x.avaliacao.pode && pFechar && !x.vazio;
      botao().disabled = !podeFechar;
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
      dlg._previa = x;   // impressão digital e versão DESTA leitura (a única que pode ser enviada)
    } catch (e) { corpoEl().innerHTML = estado.erro(e.message); botao().disabled = true; }
    }

    /** 409 por mudança de dados: invalida a prévia, desabilita a confirmação e oferece "Atualizar pré-fechamento". */
    function invalidar() {
      dlg._previa = null; botao().disabled = true;
      corpoEl().querySelector("[data-mudou]")?.remove();
      corpoEl().insertAdjacentHTML("afterbegin", `<div class="fin-alerta fin-alerta--bad fin-alerta--acao" role="alert" data-mudou>
        <span><strong>Os dados financeiros deste mês mudaram</strong> desde a pré-visualização (lançamentos, contas, referências ou regras da conciliação). Nada foi fechado. Atualize o pré-fechamento, confira os números e confirme de novo.</span>
        <button type="button" class="btn btn-primary btn-sm" data-atualizar>Atualizar pré-fechamento</button></div>`);
      const b = corpoEl().querySelector("[data-atualizar]");
      b.addEventListener("click", atualizar);
      b.focus();
    }

    dlg._fechar = async () => {
      const x = dlg._previa;
      if (!x) throw Object.assign(new Error("Atualize o pré-fechamento antes de confirmar."), { bloquearReenvio: true });
      const f = dlg.querySelector("form");
      try {
        await fin.post(`/periodos/${mes}/fechar`, { confirmo: f.confirmo.checked, versao: x.periodo.versao, fingerprint: x.fingerprint, reconhecoPendencias: f.reconheco?.checked === true });
      } catch (e) {
        if (e?.status === 409 && DADOS_MUDARAM.has(e.codigo)) { invalidar(); throw Object.assign(new Error("Fechamento recusado: os dados mudaram. Nada foi fechado."), { bloquearReenvio: true }); }
        throw e;
      }
      aviso("Período fechado."); carregar();
    };
    atualizar();
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
