// Conciliação financeira — venda realizada ≠ recebimento efetivo. Referências são dados EXTERNOS (manual, arquivo, PDV futuro): nada é inventado.
// Diferenças só são explicadas por classificação MANUAL autorizada (nunca "prazo" automático). Estados: sem referência / conciliado /
// pendente de identificação / parcialmente classificado / classificado.
import { fin } from "./api.js";
import { moeda, dataBr, periodoDoMes, rotuloMes, podeAcao, ACAO, ESTADO_CONCILIACAO, ROTULO_CLASSIFICACAO, ROTULO_TIPO_REFERENCIA, ROTULO_MOTIVO, primeiroDiaDoMes, arquivoParaBase64 } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, dialogo, campo, selecao, aviso, esc, estado } from "./ui.js";

const estadoBadge = (e) => { const x = ESTADO_CONCILIACAO[e] ?? { rotulo: e, tom: "muted" }; return badge(x.rotulo, x.tom); };

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pConciliar = podeAcao(ctx, ACAO.CONCILIAR), pConfigurar = podeAcao(ctx, ACAO.CONFIGURAR);
  let mes = lerMes();
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), corpo = raiz.querySelector("[data-corpo]");
  topo.innerHTML = cabecalho({
    titulo: "Conciliação", sub: "Vendas realizadas (referência externa) × recebimentos efetivos do livro-caixa. Sem referência informada, nada é calculado nem presumido.",
    extra: `${seletorMes(mes)}${pConciliar ? `<button class="btn btn-primary btn-sm" data-ref>Informar referências</button><button class="btn btn-ghost btn-sm" data-arq>Importar arquivo</button>` : ""}`,
  });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  function carregar() {
    carregarEm(corpo, async () => {
      const p = periodoDoMes(mes);
      const [r, pend] = await Promise.all([fin.get("/conciliacao/resumo", { mes }), fin.get("/conciliacao/pendencias", p)]);
      return { r, pend };
    }, ({ r, pend }) => pintar(r, pend));
  }

  const classificar = (escopo, chave, diferenca, rotulo) => (pConciliar && diferenca ? `<button class="btn btn-ghost btn-sm" data-classificar="${esc(escopo)}|${esc(chave)}|${diferenca}" aria-label="Classificar diferença: ${esc(rotulo)}">Classificar</button>` : "");

  function pintar(r, pend) {
    const sem = r.resumo.semReferencia;
    const pt = r.ponte;
    const banner = sem
      ? `<div class="fin-alerta fin-alerta--warn" role="status"><strong>Nenhuma referência informada para ${esc(rotuloMes(mes))}.</strong> Informe vendas, taxas, sangrias e caixa em espécie (manualmente ou por arquivo) para conciliar. Não inventamos dados ausentes.</div>` : "";
    const faltando = pt.faltando?.length ? `<p class="fin-sub">Para calcular o residual falta informar: <strong>${pt.faltando.map(esc).join(" e ")}</strong> (um valor zero explícito vale como “zero informado”).</p>` : "";
    const taxas = pt.taxas.map((t) => `<tr><th scope="row">&nbsp;&nbsp;(−) Taxas ${esc(t.canal)}</th><td class="fin-num">${moeda(t.centavos)}</td></tr>`).join("");
    const resolucoes = pt.resolucoes.length ? `<ul>${pt.resolucoes.map((x) => `<li>${badge(ROTULO_CLASSIFICACAO[x.classificacao] ?? x.classificacao, "info")} ${moeda(x.valorCentavos, { sinal: true })} — ${esc(x.nota)} ${pConciliar ? `<button class="btn btn-ghost btn-sm" data-revogar="${x.id}">Revogar</button>` : ""}</li>`).join("")}</ul>` : "";
    const ponte = `<div class="fin-card"><h3>Ponte do mês: vendas → recebimentos ${estadoBadge(pt.estado)}</h3>
      <div class="fin-tabela-wrap"><table class="fin-tabela"><tbody>
        <tr><th scope="row">Vendas realizadas (referência)</th><td class="fin-num">${moeda(pt.vendasCentavos)}</td></tr>
        <tr><th scope="row">(−) Recebido no livro-caixa como receita</th><td class="fin-num">${moeda(pt.recebidoCentavos)}</td></tr>
        <tr class="fin-tot"><th scope="row">(=) Diferença a explicar</th><td class="fin-num">${moeda(pt.diferencaAExplicarCentavos)}</td></tr>
        ${taxas}
        <tr class="fin-tot"><th scope="row">(=) Residual ${pt.residualCentavos ? "— pendente de identificação, NÃO presumido como prazo" : ""}</th><td class="fin-num">${moeda(pt.residualCentavos)}</td></tr>
      </tbody></table></div>${faltando}
      <p>${classificar("ponte_mensal", pt.chave, pt.residualCentavos, "ponte do mês")}</p>${resolucoes}
      <p class="fin-sub">${esc(pt.nota)}</p></div>`;

    const caixa = tabela({ colunas: [
      { rotulo: "Dia", render: (d) => dataBr(d.data) }, { rotulo: "Referência (Saci/PDV)", num: true, render: (d) => moeda(d.referenciaCentavos) },
      { rotulo: "No livro-caixa", num: true, render: (d) => moeda(d.fluxoCentavos) }, { rotulo: "Diferença", num: true, render: (d) => moeda(d.diferencaCentavos, { sinal: true }) },
      { rotulo: "Estado", render: (d) => estadoBadge(d.estado) }, { rotulo: "", render: (d) => classificar("caixa_dia", d.chave, d.diferencaCentavos, `caixa em ${dataBr(d.data)}`) },
    ], linhas: r.caixaDias, vazio: "Sem movimento em caixa físico nem referência de espécie no mês." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const sang = tabela({ colunas: [
      { rotulo: "Dia", render: (d) => dataBr(d.data) }, { rotulo: "Sangria (referência)", num: true, render: (d) => moeda(d.referenciaCentavos) },
      { rotulo: "Saídas do caixa", num: true, render: (d) => `${moeda(d.fluxoCentavos)}${d.excluidasCentavos ? `<br><small>exceções aprovadas: ${moeda(d.excluidasCentavos)}</small>` : ""}` },
      { rotulo: "Diferença", num: true, render: (d) => moeda(d.diferencaCentavos, { sinal: true }) }, { rotulo: "Estado", render: (d) => estadoBadge(d.estado) },
      { rotulo: "", render: (d) => classificar("sangria_dia", d.chave, d.diferencaCentavos, `sangria em ${dataBr(d.data)}`) },
    ], linhas: r.sangriaDias, vazio: "Sem saídas de caixa físico nem sangrias de referência no mês." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const ts = r.totalSangria;
    const porConta = tabela({ colunas: [
      { rotulo: "Conta", render: (c) => esc(c.nome) }, { rotulo: "Canal", render: (c) => esc(c.canal ?? "—") }, { rotulo: "Recebido", num: true, render: (c) => moeda(c.recebidoCentavos) },
      { rotulo: "Vendas do canal", num: true, render: (c) => moeda(c.vendasCentavos) }, { rotulo: "Taxas do canal", num: true, render: (c) => moeda(c.taxasCentavos) },
      { rotulo: "Diferença", num: true, render: (c) => moeda(c.diferencaCentavos, { sinal: true }) }, { rotulo: "Estado", render: (c) => estadoBadge(c.estado) },
    ], linhas: r.porConta, vazio: "Nenhuma conta." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');

    const motivos = Object.entries(pend.porMotivo);
    const pendHtml = `<div class="fin-card"><h3>Pendências de identificação</h3>
      <div class="fin-kpis">
        <article class="fin-kpi"><span class="fin-kpi-rot">Lançamentos pendentes</span><strong class="fin-kpi-val">${pend.totalPendentes}</strong><span class="fin-kpi-sub">${moeda(pend.valorPendenteCentavos)}</span></article>
        <article class="fin-kpi"><span class="fin-kpi-rot">Movimentos com terceiros</span><strong class="fin-kpi-val">${pend.movimentosComTerceiros.quantidade}</strong><span class="fin-kpi-sub">líquido saindo ${moeda(pend.movimentosComTerceiros.liquidoSaindoCentavos)} — não são despesa nem empréstimo</span></article>
        <article class="fin-kpi"><span class="fin-kpi-rot">Possíveis duplicidades</span><strong class="fin-kpi-val">${pend.possiveisDuplicatas.length}</strong><span class="fin-kpi-sub">preservadas, para revisão</span></article>
      </div>
      ${motivos.length ? `<p>${motivos.map(([m, g]) => `${badge(ROTULO_MOTIVO[m] ?? m, "muted")} ${g.quantidade} (${moeda(g.valorCentavos)})`).join(" · ")}</p>` : ""}
      ${tabela({ colunas: [
        { rotulo: "Data", render: (l) => dataBr(l.data) }, { rotulo: "Descrição", render: (l) => `${esc(l.descricao)}${l.nota ? `<br><small>${esc(String(l.nota).slice(0, 120))}</small>` : ""}` },
        { rotulo: "Valor", num: true, render: (l) => moeda(l.sentido === "entrada" ? l.valorCentavos : -l.valorCentavos, { sinal: true }) },
        { rotulo: "Motivos", render: (l) => l.motivos.map((m) => badge(ROTULO_MOTIVO[m] ?? m, "warn")).join(" ") },
        { rotulo: "", render: (l) => (pConciliar ? `<button class="btn btn-ghost btn-sm" data-resolver="${l.id}">Classificar</button>` : "") },
      ], linhas: pend.pendentes.slice(0, 100), vazio: "Nenhum lançamento pendente." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"')}
      <p class="fin-sub">Pendências não são reclassificadas sozinhas: cada resolução exige nota e fica na auditoria do lançamento.</p></div>`;

    const refs = tabela({ colunas: [
      { rotulo: "Data", render: (x) => dataBr(x.data) }, { rotulo: "Tipo", render: (x) => esc(ROTULO_TIPO_REFERENCIA[x.tipo] ?? x.tipo) }, { rotulo: "Canal", render: (x) => esc(x.canal ?? "—") },
      { rotulo: "Valor", num: true, render: (x) => moeda(x.valorCentavos) }, { rotulo: "Fonte", render: (x) => esc(x.fonte) },
      { rotulo: "", render: (x) => (pConciliar ? `<button class="btn btn-ghost btn-sm" data-cancelar-ref="${x.id}">Cancelar</button>` : "") },
    ], linhas: r.referencias, vazio: "Nenhuma referência informada neste mês." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const exc = tabela({ colunas: [
      { rotulo: "Categoria excluída da conferência de sangrias", render: (x) => esc(x.categoria ?? x.categoriaId) }, { rotulo: "Motivo aprovado", render: (x) => esc(x.motivo) },
      { rotulo: "", render: (x) => (pConfigurar ? `<button class="btn btn-ghost btn-sm" data-desativar-exc="${x.id}">Desativar</button>` : "") },
    ], linhas: r.excecoesSangria, vazio: "Nenhuma exceção aprovada: todas as saídas de caixa físico entram no confronto de sangrias." });

    corpo.innerHTML = `<p class="fin-regime">Regime de caixa · ${esc(rotuloMes(mes))} · ${r.resumo.referenciasNoMes} referência(s) · ${r.resumo.pendenciasAbertas} diferença(s) em aberto</p>
      ${banner}${ponte}
      <div class="fin-card"><h3>Caixa em espécie por dia</h3>${caixa}</div>
      <div class="fin-card"><h3>Sangrias por dia</h3>${sang}
        ${ts.referenciaCentavos != null ? `<p class="fin-sub">Total: referência ${moeda(ts.referenciaCentavos)} · livro-caixa ${moeda(ts.fluxoCentavos)} · diferença ${moeda(ts.diferencaCentavos, { sinal: true })}${ts.diasSemReferencia ? ` · ${ts.diasSemReferencia} dia(s) com saída de caixa e sem referência` : ""}</p>` : ""}</div>
      <div class="fin-card"><h3>Diferenças por conta (informativo)</h3>${porConta}<p class="fin-sub">Cadastre o canal de cada conta (ex.: STONE) em Contas Financeiras para comparar vendas do canal × recebido + taxas.</p></div>
      ${pendHtml}
      <div class="fin-grade2"><div class="fin-card"><h3>Referências do mês</h3>${refs}</div><div class="fin-card"><h3>Exceções de sangria (aprovadas)</h3>${exc}${pConfigurar ? `<p><button class="btn btn-ghost btn-sm" data-nova-exc>Aprovar exceção</button></p>` : ""}</div></div>
      <div class="fin-card"><h3>Histórico</h3><p><button class="btn btn-ghost btn-sm" data-historico>Ver auditoria das classificações</button></p></div>`;
    ligar(r, pend);
  }

  function ligar(r, pend) {
    corpo.querySelectorAll("[data-classificar]").forEach((b) => b.addEventListener("click", () => {
      const [escopo, chave, dif] = b.dataset.classificar.split("|");
      const cents = Number(dif);
      dialogo({
        titulo: "Classificar diferença", enviar: "Registrar classificação",
        corpo: `<p>Diferença a explicar: <strong>${esc(moeda(cents, { sinal: true }))}</strong>. A classificação é manual, fica auditada e pode ser revogada com motivo.</p>
          ${selecao("Classificação", "classificacao", Object.entries(ROTULO_CLASSIFICACAO).map(([valor, rotulo]) => ({ valor, rotulo })), { obrig: true, vazio: "Escolha…" })}
          ${campo("Valor explicado (R$)", "valor", { obrig: true, valor: (cents / 100).toFixed(2).replace(".", ","), extra: 'inputmode="decimal"', dica: "Mesmo sinal da diferença; pode ser parcial." })}
          <label class="fin-campo"><span>Justificativa *</span><textarea name="nota" rows="3" required minlength="5" maxlength="500"></textarea></label>`,
        aoEnviar: async (d) => { await fin.post("/conciliacao/resolucoes", { escopo, chave, classificacao: d.get("classificacao"), valor: d.get("valor"), nota: d.get("nota") }); aviso("Classificação registrada."); carregar(); },
      });
    }));
    corpo.querySelectorAll("[data-revogar]").forEach((b) => b.addEventListener("click", () => dialogo({
      titulo: "Revogar classificação", enviar: "Revogar", perigo: true, corpo: `<label class="fin-campo"><span>Motivo *</span><textarea name="motivo" rows="3" required maxlength="500"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post(`/conciliacao/resolucoes/${b.dataset.revogar}/revogar`, { motivo: d.get("motivo") }); aviso("Classificação revogada."); carregar(); },
    })));
    corpo.querySelectorAll("[data-cancelar-ref]").forEach((b) => b.addEventListener("click", () => dialogo({
      titulo: "Cancelar referência", enviar: "Cancelar referência", perigo: true, corpo: `<p>A referência não é apagada: fica cancelada, com motivo.</p><label class="fin-campo"><span>Motivo *</span><textarea name="motivo" rows="3" required maxlength="500"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post(`/conciliacao/referencias/${b.dataset.cancelarRef}/cancelar`, { motivo: d.get("motivo") }); aviso("Referência cancelada."); carregar(); },
    })));
    corpo.querySelectorAll("[data-resolver]").forEach((b) => b.addEventListener("click", () => {
      const l = pend.pendentes.find((x) => x.id === b.dataset.resolver);
      dialogo({
        titulo: "Classificar pendência", enviar: "Confirmar classificação",
        corpo: `<p>“${esc(l.descricao)}” — ${esc(moeda(l.valorCentavos))}. Só marque como resolvida após confirmar a origem/destino.</p>
          <label class="fin-campo"><span>Justificativa *</span><textarea name="nota" rows="3" required minlength="5" maxlength="1000"></textarea></label>`,
        aoEnviar: async (d) => { await fin.post(`/conciliacao/pendencias/${l.id}/resolver`, { nota: d.get("nota") }); aviso("Pendência classificada."); carregar(); },
      });
    }));
    corpo.querySelectorAll("[data-desativar-exc]").forEach((b) => b.addEventListener("click", () => dialogo({
      titulo: "Desativar exceção", enviar: "Desativar", perigo: true, corpo: `<label class="fin-campo"><span>Motivo *</span><textarea name="motivo" rows="3" required maxlength="500"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post(`/conciliacao/excecoes-sangria/${b.dataset.desativarExc}/desativar`, { motivo: d.get("motivo") }); aviso("Exceção desativada."); carregar(); },
    })));
    corpo.querySelector("[data-nova-exc]")?.addEventListener("click", async () => {
      const cats = await fin.get("/plano-contas");
      dialogo({
        titulo: "Aprovar exceção de sangria", enviar: "Aprovar",
        corpo: `<p class="fin-sub">Categorias aprovadas aqui saem do confronto de sangrias (ex.: uma despesa paga em espécie que não é sangria). Fica registrada com autor e data.</p>
          ${selecao("Categoria", "categoriaId", cats.filter((c) => c.ativo).map((c) => ({ valor: c.id, rotulo: c.nome })), { obrig: true, vazio: "Escolha…" })}
          <label class="fin-campo"><span>Motivo da aprovação *</span><textarea name="motivo" rows="3" required minlength="5" maxlength="500"></textarea></label>`,
        aoEnviar: async (d) => { await fin.post("/conciliacao/excecoes-sangria", { categoriaId: d.get("categoriaId"), motivo: d.get("motivo") }); aviso("Exceção aprovada."); carregar(); },
      });
    });
    corpo.querySelector("[data-historico]")?.addEventListener("click", async () => {
      const dlg = dialogo({ titulo: "Auditoria das classificações", enviar: "Fechar", corpo: estado.carregando(), aoEnviar: async () => {} });
      try {
        const h = await fin.get("/auditoria", { entidade: "fin_conciliacao_resolucoes" });
        dlg.querySelector(".fin-form-corpo").innerHTML = h.length ? tabela({ colunas: [
          { rotulo: "Quando", render: (a) => esc(new Date(a.created_at).toLocaleString("pt-BR")) }, { rotulo: "Ação", render: (a) => esc(a.acao.replace("fin_conciliacao_resolucoes.", "")) },
          { rotulo: "Situação", render: (a) => esc(`${a.antes?.status ?? "—"} → ${a.depois?.status ?? "—"}`) }, { rotulo: "Valor", num: true, render: (a) => moeda(Number(a.depois?.valor_centavos)) },
        ], linhas: h }) : "<p>Nenhuma classificação registrada.</p>";
      } catch (e) { dlg.querySelector(".fin-form-corpo").innerHTML = estado.erro(e.message); }
    });
  }

  topo.querySelector("[data-ref]")?.addEventListener("click", () => dialogo({
    titulo: "Informar referência", enviar: "Registrar",
    corpo: `<p class="fin-sub">Dados de fonte externa (PDV, relatório de vendas). Valor zero é permitido e significa “zero informado”.</p>
      ${selecao("Tipo", "tipo", Object.entries(ROTULO_TIPO_REFERENCIA).map(([valor, rotulo]) => ({ valor, rotulo })), { obrig: true, vazio: "Escolha…" })}
      ${campo("Data", "data", { tipo: "date", obrig: true, valor: periodoDoMes(mes).ate })}${campo("Valor (R$)", "valor", { obrig: true, extra: 'inputmode="decimal"' })}
      ${campo("Canal (opcional)", "canal", { dica: "Ex.: STONE, IFOOD — para taxas e vendas por canal." })}${campo("Nota (opcional)", "nota")}`,
    aoEnviar: async (d) => { await fin.post("/conciliacao/referencias", { itens: [Object.fromEntries([...d.entries()].filter(([, v]) => String(v).trim() !== ""))] }); aviso("Referência registrada."); carregar(); },
  }));
  topo.querySelector("[data-arq]")?.addEventListener("click", () => {
    const dlg = dialogo({
      titulo: "Importar referências (CSV ou XLSX)", enviar: "Gravar", aoEnviar: async () => { await dlg._gravar(); },
      corpo: `<p class="fin-sub">Colunas: DATA, TIPO (venda, taxa, sangria, dinheiro), VALOR e, opcionais, CANAL e NOTA. Reenviar o mesmo arquivo não duplica.</p>
        <label class="fin-campo"><span>Arquivo</span><input type="file" name="arq" accept=".csv,.xlsx" required></label><div data-resultado></div>`,
    });
    const arq = dlg.querySelector('input[type="file"]');
    arq.addEventListener("change", async () => {
      const f = arq.files[0]; if (!f) return;
      const res = dlg.querySelector("[data-resultado]"); res.innerHTML = estado.carregando("Validando…");
      try {
        dlg._b64 = await arquivoParaBase64(f);
        const s = await fin.post("/conciliacao/referencias/importar", { conteudoBase64: dlg._b64, simular: true });
        dlg._ok = s.erros.length === 0;
        res.innerHTML = `<p>${s.lidos} linha(s) válida(s).${s.erros.length ? ` <strong>${s.erros.length} erro(s)</strong> — corrija o arquivo:` : " Nada foi gravado ainda."}</p>${s.erros.length ? tabela({ colunas: [{ rotulo: "Linha", render: (x) => x.linha }, { rotulo: "Problema", render: (x) => esc(x.motivo) }], linhas: s.erros }) : ""}`;
      } catch (e) { res.innerHTML = estado.erro(e.message); dlg._ok = false; }
    });
    dlg._gravar = async () => {
      if (!dlg._ok) throw new Error("Corrija os erros do arquivo antes de gravar.");
      const r = await fin.post("/conciliacao/referencias/importar", { conteudoBase64: dlg._b64 });
      aviso(`${r.gravados} gravada(s), ${r.ignorados} já existente(s).`); carregar();
    };
  });
  carregar();
}
