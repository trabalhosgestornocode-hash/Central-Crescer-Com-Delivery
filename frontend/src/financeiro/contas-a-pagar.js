// Contas a Pagar (Financeiro 2.0). Obrigação ≠ pagamento: uma conta aceita vários pagamentos; a diferença (juros/acréscimo ou desconto)
// só existe quando a conta é QUITADA e é calculada sobre o TOTAL pago. Tudo vem do backend; nada é constante da tela.
import { consumirFoco } from "./busca.js";
import { fin } from "./api.js";
import { moeda, pct, dataBr, rotuloMes, podeAcao } from "./modelo.js";
import { ACAO_FIN2, SITUACAO_CP, NATUREZA, FILTROS_SITUACAO, OPCOES_ACRESCIMO, OPCOES_A_MENOR, previaDiferenca, acoesDaConta } from "./modeloContasPagar.js";
import { garantirCss, vazioComPasso, cabecalho, seletorMes, kpi, tabela, badge, carregarEm, lerMes, gravarMes, dialogo, campo, selecao, aviso, esc, estado } from "./ui.js";
import { tabelaCartao } from "./tabelaCartao.js";

const sit = (s) => SITUACAO_CP[s] ?? { rotulo: s, tom: "muted" };
const nat = (n) => NATUREZA[n] ?? null;
const campoMotivo = `<label class="fin-campo"><span>Motivo (mín. 10 caracteres) *</span><textarea name="motivo" rows="3" required minlength="10" maxlength="1000"></textarea></label>`;

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const perms = ctx?.permissoes ?? [];
  const pode = (a) => podeAcao(ctx, a);
  let mes = lerMes();
  const foco = consumirFoco();   // vindo da busca financeira: aplica o texto (e o mês) uma única vez
  const filtros = { situacao: "", fornecedorId: "", categoriaId: "", contaId: "", busca: foco?.busca ?? "" };
  raiz.innerHTML = `<div data-topo></div><div data-filtros></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    ajuda: "contas-a-pagar", titulo: "Contas a Pagar",
    sub: "Uma conta pode ter vários pagamentos. A diferença entre o valor pago e o original só é calculada quando a conta é quitada — nunca a partir de um pagamento isolado.",
    extra: `${seletorMes(mes)}${pode(ACAO_FIN2.LANCAR) ? `<button class="btn btn-primary btn-sm" data-nova>Registrar conta / pagamento</button>` : ""}`,
  });
  raiz.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  let cad = { fornecedores: [], categorias: [], contas: [] };
  async function cadastros() {
    const [fornecedores, plano, contas] = await Promise.all([fin.get("/fornecedores"), fin.get("/plano-contas"), fin.get("/contas")]);
    cad = { fornecedores, categorias: plano.filter((c) => c.ativo && !["transferencia", "saldo_anterior", "receita_operacional"].includes(c.papel)), contas: contas.filter((c) => c.ativo) };
  }
  function pintarFiltros() {
    const op = (lista, v, r) => lista.map((x) => ({ valor: x[v], rotulo: x[r] }));
    raiz.querySelector("[data-filtros]").innerHTML = `<div class="fin-filtros" role="search">
      ${selecao("Situação", "situacao", FILTROS_SITUACAO.filter(([v]) => v).map(([valor, rotulo]) => ({ valor, rotulo })), { valor: filtros.situacao, vazio: "Todas" })}
      ${selecao("Fornecedor", "fornecedorId", op(cad.fornecedores, "id", "nome"), { valor: filtros.fornecedorId, vazio: "Todos" })}
      ${selecao("Categoria", "categoriaId", op(cad.categorias, "id", "nome"), { valor: filtros.categoriaId, vazio: "Todas" })}
      ${selecao("Conta usada", "contaId", op(cad.contas, "id", "nome"), { valor: filtros.contaId, vazio: "Todas" })}
      ${campo("Buscar", "busca", { valor: filtros.busca, extra: 'placeholder="fornecedor ou descrição" maxlength="80"' })}</div>`;
    raiz.querySelector("[data-filtros]").querySelectorAll("select, input").forEach((el) => el.addEventListener(el.tagName === "INPUT" ? "change" : "input", () => { filtros[el.name] = el.value; carregar(); }));
  }

  function carregar() {
    carregarEm(corpo, async () => {
      if (!cad.contas.length && !cad.categorias.length) { await cadastros(); pintarFiltros(); }
      return fin.get("/contas-pagar", { mes, ...filtros });
    }, pintar);
  }

  function pintar(d) {
    const r = d.resumo;
    const kpis = [
      kpi({ rotulo: "Em aberto", valor: moeda(r.emAbertoCentavos), sub: `Data-base ${dataBr(d.dataBase)}`, formula: "Σ (valor original − total pago) das contas abertas", origem: "Contas a pagar e pagamentos registrados" }),
      kpi({ rotulo: "Vencido", valor: moeda(r.vencidoCentavos), sub: r.vencidoCentavos ? "Atenção: contas vencidas em aberto" : "Nenhuma conta vencida", formula: "Saldo em aberto com vencimento anterior à data-base" }),
      kpi({ rotulo: "A vencer", valor: moeda(r.aVencerCentavos), formula: "Saldo em aberto com vencimento a partir da data-base" }),
      kpi({ rotulo: "Acréscimos pagos no mês", valor: moeda(r.acrescimosCentavos), sub: r.acrescimosPresumidosCentavos ? `${moeda(r.acrescimosPresumidosCentavos)} ainda presumidos (sem classificação)` : "Todos classificados", formula: "Σ (total pago − original) das contas quitadas no mês com pagamento acima do original", origem: "Juros de empréstimos não entram aqui" }),
    ].join("");
    const alertas = [
      r.quitacaoPendente ? `<div class="fin-alerta fin-alerta--warn" role="status">${r.quitacaoPendente} conta(s) já paga(s) por inteiro aguardando a confirmação da quitação${pode(ACAO_FIN2.CONCILIAR) ? "" : " (por um gerente, a contadora ou o administrador)"}.</div>` : "",
      r.provisorias ? `<div class="fin-alerta fin-alerta--warn" role="status">${r.provisorias} registro(s) provisório(s) aguardando confirmação. Registros provisórios impedem o fechamento do mês.</div>` : "",
      r.aVerificar ? `<div class="fin-alerta fin-alerta--warn" role="status">${r.aVerificar} conta(s) paga(s) a menor: falta classificar se foi desconto (ou desfazer a quitação, se ficou saldo).</div>` : "",
    ].join("");
    const linhas = d.itens;
    const tb = tabelaCartao({
      colunas: [
        { rotulo: "Vencimento", render: (c) => `${dataBr(c.vencimento)}${c.diasAtraso && c.status !== "quitada" ? `<br><small>${c.diasAtraso} dia(s) em atraso</small>` : ""}` },
        { rotulo: "Fornecedor / descrição", render: (c) => `<strong>${esc(c.fornecedor ?? "—")}</strong>${c.provisoria ? ` ${badge("Provisória", "warn")}` : ""}<br><small>${esc(c.descricao)} · ${esc(c.categoria ?? "")} · comp. ${esc(rotuloMes(c.competencia))}</small>` },
        { rotulo: "Original", num: true, render: (c) => moeda(c.valorOriginalCentavos) },
        { rotulo: "Pago", num: true, render: (c) => `${c.pagoCentavos ? moeda(c.pagoCentavos) : "—"}${c.pagamentosAtivos > 1 ? `<br><small>${c.pagamentosAtivos} pagamentos</small>` : ""}` },
        { rotulo: "Diferença", num: true, render: (c) => (c.diferencaCentavos == null || c.diferencaCentavos === 0 ? (c.status === "aberta" && c.saldoAbertoCentavos ? `<small>saldo ${moeda(c.saldoAbertoCentavos)}</small>` : "—") : `${moeda(c.diferencaCentavos, { sinal: true })}<br><small>${pct(c.percentualBps)}</small> ${badge(nat(c.natureza)?.rotulo ?? "", nat(c.natureza)?.tom ?? "muted")}`) },
        { rotulo: "Situação", render: (c) => badge(sit(c.situacao).rotulo, sit(c.situacao).tom) },
        { rotulo: "", render: (c) => `<button class="btn btn-ghost btn-sm" data-detalhe="${c.id}" aria-label="Detalhes da conta ${esc(c.fornecedor ?? "")}">Detalhes</button>` },
      ],
      linhas, vazio: filtrosAtivos() ? "Nenhuma conta com esses filtros." : `Nenhuma conta a pagar em ${rotuloMes(mes)}.`,
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `<div class="fin-kpis">${kpis}</div>${alertas ? `<div class="fin-alertas">${alertas}</div>` : ""}
      <div class="fin-card"><h3>Contas — ${esc(rotuloMes(mes))}</h3><p class="fin-sub">Do mês: competência no mês, quitadas no mês e as abertas que vencem até o fim do mês (inclusive de meses anteriores).</p>${linhas.length ? tb : vazioContas()}</div>`;
    corpo.querySelectorAll("[data-detalhe]").forEach((b) => b.addEventListener("click", () => detalhe(b.dataset.detalhe)));
  }
  const vazioContas = () => filtrosAtivos()
    ? vazioComPasso("Nenhuma conta com esses filtros", "Tire algum filtro para ver as outras contas do mês.", { rotulo: "Limpar filtros", atributo: "data-limpar-filtros" })
    : vazioComPasso(`Nenhuma conta a pagar em ${rotuloMes(mes)}`, pode(ACAO_FIN2.LANCAR) ? "Registre os boletos e compromissos do mês para acompanhar o que falta pagar e não perder vencimentos." : "Ainda não há contas neste mês.", pode(ACAO_FIN2.LANCAR) ? { rotulo: "Registrar conta / pagamento", atributo: "data-nova" } : {});
  const filtrosAtivos = () => Object.values(filtros).some(Boolean);

  // ---------------------------------------------------------------- detalhe e ações
  async function detalhe(id) {
    const dlg = dialogo({ titulo: "Conta a pagar", enviar: "Fechar", corpo: estado.carregando(), aoEnviar: async () => {} });
    const corpoDlg = dlg.querySelector(".fin-form-corpo");
    const recarregar = async () => {
      try { pintarDetalhe(corpoDlg, await fin.get(`/contas-pagar/${id}`), recarregar); }
      catch (e) { corpoDlg.innerHTML = estado.erro(e.message); }
    };
    await recarregar();
  }

  function pintarDetalhe(alvo, c, recarregar) {
    const a = acoesDaConta(c, perms);
    const n = nat(c.natureza);
    const calc = c.status === "quitada" && c.diferencaCentavos !== 0
      ? `<div class="fin-alerta fin-alerta--${c.diferencaCentavos > 0 ? "warn" : "warn"}" role="status"><strong>${esc(n?.rotulo ?? "")}</strong><br>
          Diferença = total pago ${esc(moeda(c.pagoCentavos))} − original ${esc(moeda(c.valorOriginalCentavos))} = <strong>${esc(moeda(c.diferencaCentavos, { sinal: true }))}</strong><br>
          Percentual = diferença ÷ original × 100 = <strong>${esc(pct(c.percentualBps))}</strong>${c.diasAtraso ? ` · pago com ${c.diasAtraso} dia(s) de atraso` : ""}</div>`
      : c.status === "aberta" && c.pagoCentavos > 0
        ? `<div class="fin-alerta fin-alerta--${c.situacao === "quitacao_pendente" ? "warn" : "info"}" role="status">${c.situacao === "quitacao_pendente" ? "O total pago já cobre o valor original. Confirme a quitação para calcular a diferença." : `Pagamento parcial: saldo de ${esc(moeda(c.saldoAbertoCentavos))} em aberto. Não é desconto.`}</div>` : "";
    const pags = tabelaCartao({
      colunas: [
        { rotulo: "Data", render: (p) => dataBr(p.data) }, { rotulo: "Conta / origem", render: (p) => p.origemPagamento === "terceiro" ? `${esc(p.terceiro ?? "Terceiro")} <span class="fin-badge fin-badge--info">Pago por terceiro</span>` : p.origemPagamento === "origem_pendente" ? `<span class="fin-badge fin-badge--warn">Origem pendente</span>` : esc(p.conta ?? "—") },
        { rotulo: "Valor", num: true, render: (p) => `${p.status === "ativo" ? moeda(p.valorCentavos) : `<s>${moeda(p.valorCentavos)}</s>`}${p.provisorio && p.status === "ativo" ? `<br>${badge("Provisório", "warn")}` : ""}` },
        { rotulo: "Situação", render: (p) => (p.status !== "ativo" ? `${badge("Cancelado", "muted")}<br><small>${esc(p.motivoCancelamento ?? "")}</small>` : badge(p.conciliacao === "conciliado" ? "Conciliado com o extrato" : p.conciliacao === "em_analise" ? "Vínculo em análise" : "Sem conciliação", p.conciliacao === "conciliado" ? "ok" : p.conciliacao === "em_analise" ? "info" : "warn")) },
        { rotulo: "", render: (p) => (p.status === "ativo" && a.cancelarPagamento && p.conciliacao === "pendente" ? `<button type="button" class="btn btn-ghost btn-sm" data-cancelar-pag="${p.id}">Cancelar</button>` : "") },
      ],
      linhas: c.pagamentos, vazio: "Nenhum pagamento registrado.",
    });
    const opcoesClass = (c.diferencaCentavos ?? 0) > 0 ? OPCOES_ACRESCIMO : OPCOES_A_MENOR;
    const hist = (c.historico ?? []).slice(0, 12).map((h) => `<li><small>${esc(new Date(h.em).toLocaleString("pt-BR"))} · ${esc(rotuloAcao(h))}</small></li>`).join("");
    alvo.innerHTML = `
      <p><strong>${esc(c.fornecedor ?? "—")}</strong> — ${esc(c.descricao)} ${c.provisoria ? badge("Registro provisório", "warn") : ""} ${badge(sit(c.situacao).rotulo, sit(c.situacao).tom)}</p>
      <dl class="fin-dl">
        <dt>Categoria</dt><dd>${esc(c.categoria ?? "—")}</dd><dt>Competência</dt><dd>${esc(rotuloMes(c.competencia))}</dd>
        <dt>Vencimento</dt><dd>${esc(dataBr(c.vencimento))}</dd><dt>Valor original</dt><dd>${esc(moeda(c.valorOriginalCentavos))}</dd>
        <dt>Total pago</dt><dd>${esc(moeda(c.pagoCentavos))}</dd>${c.dataQuitacao ? `<dt>Quitada em</dt><dd>${esc(dataBr(c.dataQuitacao))}</dd>` : ""}
        ${c.observacoes ? `<dt>Observações</dt><dd>${esc(c.observacoes)}</dd>` : ""}${c.motivoCancelamento ? `<dt>Cancelamento</dt><dd>${esc(c.motivoCancelamento)}</dd>` : ""}
      </dl>${calc}
      <h4>Pagamentos</h4>${pags}
      ${a.classificar ? `<div class="fin-form" data-classificar role="group" aria-label="Classificar a diferença">${selecao("Classificar a diferença", "classificacao", opcoesClass.map(([valor, rotulo]) => ({ valor, rotulo })), { valor: c.classificacao ?? "", vazio: null })}<button class="btn btn-primary btn-sm" type="button" data-gravar-classificacao>Gravar classificação</button></div>` : ""}
      ${c.status === "quitada" && (c.diferencaCentavos ?? 0) !== 0 && !a.classificar ? `<p class="fin-sub">A classificação de juros, multas, tarifas e descontos é feita pela contadora ou pelo administrador.</p>` : ""}
      <div class="fin-linha-acoes" role="group" aria-label="Ações da conta">
        ${a.pagamento ? `<button type="button" class="btn btn-ghost btn-sm" data-pag>+ Pagamento</button>` : ""}
        ${a.quitar ? `<button type="button" class="btn btn-primary btn-sm" data-quitar>Confirmar quitação</button>` : ""}
        ${a.confirmar ? `<button type="button" class="btn btn-ghost btn-sm" data-confirmar>Confirmar registro</button>` : ""}
        ${a.desfazer ? `<button type="button" class="btn btn-ghost btn-sm" data-desfazer>Desfazer quitação</button>` : ""}
        ${a.cancelar ? `<button type="button" class="btn btn-ghost btn-sm" data-cancelar>Cancelar conta</button>` : ""}
      </div>
      ${hist ? `<details class="fin-info"><summary>Histórico de alterações</summary><ul>${hist}</ul></details>` : ""}`;
    const feito = async (msg) => { aviso(msg); await recarregar(); carregar(); };
    const falhou = (e) => aviso(e.message, "bad");
    alvo.querySelector("[data-quitar]")?.addEventListener("click", () => fin.post(`/contas-pagar/${c.id}/quitar`).then(() => feito("Quitação confirmada.")).catch(falhou));
    alvo.querySelector("[data-confirmar]")?.addEventListener("click", () => fin.post(`/contas-pagar/${c.id}/confirmar-registro`).then(() => feito("Registro confirmado.")).catch(falhou));
    alvo.querySelector("[data-desfazer]")?.addEventListener("click", () => dialogo({ titulo: "Desfazer quitação", enviar: "Desfazer", perigo: true, corpo: `<p>A conta volta a ficar aberta e a classificação da diferença é apagada. Use para registrar outro pagamento ou corrigir o valor.</p>${campoMotivo}`, aoEnviar: async (f) => { await fin.post(`/contas-pagar/${c.id}/desfazer-quitacao`, { motivo: f.get("motivo") }); await feito("Quitação desfeita."); } }));
    alvo.querySelector("[data-cancelar]")?.addEventListener("click", () => dialogo({ titulo: "Cancelar conta", enviar: "Cancelar conta", perigo: true, corpo: `<p>Nada é apagado: a conta fica cancelada, com o motivo na auditoria.</p>${campoMotivo}`, aoEnviar: async (f) => { await fin.post(`/contas-pagar/${c.id}/cancelar`, { motivo: f.get("motivo") }); await feito("Conta cancelada."); } }));
    alvo.querySelectorAll("[data-cancelar-pag]").forEach((b) => b.addEventListener("click", () => dialogo({ titulo: "Cancelar pagamento", enviar: "Cancelar pagamento", perigo: true, corpo: campoMotivo, aoEnviar: async (f) => { await fin.post(`/contas-pagar/pagamentos/${b.dataset.cancelarPag}/cancelar`, { motivo: f.get("motivo") }); await feito("Pagamento cancelado."); } })));
    // (bloco, não <form>: o corpo já está dentro do <form> do diálogo e formulário aninhado é descartado pelo navegador)
    alvo.querySelector("[data-gravar-classificacao]")?.addEventListener("click", () => { const v = alvo.querySelector('[data-classificar] select[name="classificacao"]').value; fin.post(`/contas-pagar/${c.id}/classificar`, { classificacao: v || null }).then(() => feito("Classificação gravada.")).catch(falhou); });
    alvo.querySelector("[data-pag]")?.addEventListener("click", () => formPagamento(c));
  }

  // ---------------------------------------------------------------- formulários
  const opContas = () => cad.contas.map((x) => ({ valor: x.id, rotulo: x.nome }));
  const camposPagamento = (prefixo = "") => `${campo("Data do pagamento", `${prefixo}data`, { tipo: "date", obrig: !prefixo })}
    ${campo("Valor efetivamente pago (R$)", `${prefixo}valor`, { obrig: !prefixo, extra: 'inputmode="decimal" autocomplete="off"' })}
    ${selecao("Conta utilizada", `${prefixo}contaId`, opContas(), { obrig: !prefixo, vazio: "Escolha…" })}
    ${campo("Comprovante (referência)", `${prefixo}comprovanteRef`, { extra: 'maxlength="300" placeholder="nº do documento ou nome do arquivo"' , dica: "O envio do arquivo não faz parte desta etapa: registre a referência." })}`;
  const caixaQuitar = () => (pode(ACAO_FIN2.CONCILIAR)
    ? `<label class="fin-campo fin-campo--inline"><span><input type="checkbox" name="quitar"> Esta conta está quitada com este pagamento</span></label>`
    : `<p class="fin-sub">Seu registro fica <strong>provisório</strong>. A quitação é confirmada por um gerente, a contadora ou o administrador.</p>`);
  const previa = `<div class="fin-alerta fin-alerta--info" data-previa role="status" aria-live="polite">Informe o valor original e o valor efetivamente pago para ver a diferença.</div>`;
  function ligarPrevia(dlg, original, jaPago = 0) {
    const f = dlg.querySelector("form"); const box = dlg.querySelector("[data-previa]");
    const upd = () => { const orig = original ?? f.elements.valorOriginal?.value; const pv = previaDiferenca(orig, f.elements.valor?.value ?? f.elements.pg_valor?.value, f.elements.quitar?.checked === true, jaPago); box.textContent = pv.texto; box.className = `fin-alerta fin-alerta--${pv.tipo === "acrescimo" || pv.tipo === "a_menor" ? "warn" : "info"}`; };
    f.addEventListener("input", upd); f.addEventListener("change", upd);
  }

  function formPagamento(c) {
    const origem = `<label class="fin-campo"><span>Como foi pago</span><select name="origemPagamento" data-origem>
        <option value="conta">Com uma conta da empresa (padrão)</option><option value="terceiro">Pago por terceiro (ex.: a sócia, com conta pessoal)</option><option value="origem_pendente">Pago, mas de qual conta saiu ainda não se sabe</option></select></label>
      <div data-bloco-terceiro hidden><label class="fin-campo"><span>Dívida de reembolso *</span><select name="dividaId" data-divida><option value="">Carregando…</option></select><small>O pagamento fica vinculado à dívida; não cria saída bancária da empresa nem muda o custo.</small></label>
        ${campo("Quem pagou", "terceiro", { extra: 'maxlength="120"' })}</div>
      <div data-bloco-fonte hidden><label class="fin-campo"><span>Fonte do pagamento * (documento, quem informou, quando)</span><textarea name="observacao" rows="2" maxlength="1000"></textarea><small>Sem conta de saída, a fonte fica escrita. Pagamento sem conta nasce provisório e nunca é conciliado com extrato.</small></label></div>`;
    const dlg = dialogo({
      titulo: `Pagamento — ${c.fornecedor ?? ""}`, enviar: "Registrar pagamento",
      corpo: `<p class="fin-sub">Original ${esc(moeda(c.valorOriginalCentavos))} · já pago ${esc(moeda(c.pagoCentavos))}</p>${origem}${camposPagamento()}${caixaQuitar()}${previa}`,
      aoEnviar: async (f) => {
        const o = f.get("origemPagamento") || "conta";
        const corpo = { data: f.get("data"), valor: f.get("valor"), comprovanteRef: f.get("comprovanteRef") || undefined, quitar: f.get("quitar") === "on", origemPagamento: o };
        if (o === "conta") corpo.contaId = f.get("contaId"); else corpo.observacao = f.get("observacao");
        if (o === "terceiro") { corpo.dividaId = f.get("dividaId"); corpo.terceiro = f.get("terceiro") || undefined; }
        await fin.post(`/contas-pagar/${c.id}/pagamentos`, corpo); aviso(o === "conta" ? "Pagamento registrado." : "Pagamento reconhecido sem saída bancária."); carregar();
      },
    });
    const sel = dlg.querySelector("[data-origem]"), conta = dlg.querySelector('[name="contaId"]'), quitar = dlg.querySelector('[name="quitar"]'), bt = dlg.querySelector("[data-bloco-terceiro]"), bf = dlg.querySelector("[data-bloco-fonte]");
    const aplicar = () => {
      const o = sel.value;
      bt.hidden = o !== "terceiro"; bf.hidden = o === "conta"; conta.closest("label").hidden = o !== "conta"; conta.required = o === "conta";
      dlg.querySelector('[name="observacao"]').required = o !== "conta"; dlg.querySelector("[data-divida]").required = o === "terceiro";
      if (quitar) { quitar.disabled = o === "origem_pendente"; if (o === "origem_pendente") quitar.checked = false; }
    };
    sel.addEventListener("change", aplicar);
    fin.get("/dividas", {}).then((r) => { const ativas = (r.itens ?? []).filter((d) => d.status === "ativa"); dlg.querySelector("[data-divida]").innerHTML = `<option value="">Escolha a dívida…</option>${ativas.map((d) => `<option value="${esc(d.id)}" data-credor="${esc(d.credor)}">${esc(d.credor)} — ${esc(d.naturezaRotulo ?? d.natureza)}</option>`).join("")}`; }).catch(() => {});
    dlg.querySelector("[data-divida]").addEventListener("change", (e) => { const t = dlg.querySelector('[name="terceiro"]'); if (!t.value) t.value = e.target.selectedOptions[0]?.dataset.credor ?? ""; });
    aplicar();
    ligarPrevia(dlg, (c.valorOriginalCentavos / 100).toFixed(2).replace(".", ","), c.pagoCentavos);
  }

  function formNova() {
    const forn = cad.fornecedores.map((f) => `<option value="${esc(f.nome)}"></option>`).join("");
    const dlg = dialogo({
      titulo: "Registrar conta a pagar", enviar: "Registrar",
      corpo: `<datalist id="fin-fornecedores">${forn}</datalist>
        ${campo("Fornecedor", "fornecedorNome", { obrig: true, extra: 'list="fin-fornecedores" maxlength="120" autocomplete="off"' })}
        ${campo("Descrição", "descricao", { extra: 'maxlength="300"' })}
        ${selecao("Categoria", "categoriaId", cad.categorias.map((x) => ({ valor: x.id, rotulo: x.nome })), { obrig: true, vazio: "Escolha…" })}
        ${campo("Competência", "competencia", { tipo: "month", obrig: true, valor: mes })}
        ${campo("Data de vencimento", "vencimento", { tipo: "date", obrig: true })}
        ${campo("Valor original da conta (R$)", "valorOriginal", { obrig: true, extra: 'inputmode="decimal" autocomplete="off"' })}
        <fieldset class="fin-form-corpo"><legend>Pagamento (opcional)</legend>${camposPagamento("pg_")}${caixaQuitar()}</fieldset>
        <label class="fin-campo"><span>Observações</span><textarea name="observacoes" rows="2" maxlength="1000"></textarea></label>${previa}`,
      aoEnviar: async (f) => {
        const temPag = f.get("pg_valor") || f.get("pg_data") || f.get("pg_contaId");
        if (temPag && !(f.get("pg_valor") && f.get("pg_data") && f.get("pg_contaId"))) throw new Error("Para registrar o pagamento, informe data, valor pago e conta utilizada.");
        const r = await fin.post("/contas-pagar", {
          fornecedorNome: f.get("fornecedorNome"), descricao: f.get("descricao") || undefined, categoriaId: f.get("categoriaId"), competencia: f.get("competencia"),
          vencimento: f.get("vencimento"), valorOriginal: f.get("valorOriginal"), observacoes: f.get("observacoes") || undefined, quitar: f.get("quitar") === "on",
          pagamento: temPag ? { data: f.get("pg_data"), valor: f.get("pg_valor"), contaId: f.get("pg_contaId"), comprovanteRef: f.get("pg_comprovanteRef") || undefined } : undefined,
        });
        aviso(r.provisoria ? "Conta registrada como provisória: aguarda confirmação." : "Conta registrada.");
        cad.fornecedores = await fin.get("/fornecedores");
        carregar();
      },
    });
    ligarPrevia(dlg, null);
  }

  raiz.addEventListener("click", async (e) => {
    if (e.target.closest("[data-limpar-filtros]")) { for (const k of Object.keys(filtros)) filtros[k] = ""; pintarFiltros(); carregar(); return; }
    if (!e.target.closest("[data-nova]")) return;
    try { if (!cad.categorias.length) await cadastros(); } catch (err) { aviso(err.message, "bad"); return; }
    if (!cad.categorias.length) { aviso("Cadastre uma categoria de custo ou despesa no Plano de Contas antes.", "bad"); return; }
    if (!cad.contas.length) { aviso("Cadastre uma conta financeira antes de registrar pagamentos.", "bad"); }
    formNova();
  });
  carregar();
}

function rotuloAcao(h) {
  const a = h.antes ?? {}, d = h.depois ?? {};
  if (h.acao.endsWith(".insert")) return d.provisoria ? "Registrada (provisória)" : "Registrada";
  if (a.status !== d.status) return d.status === "quitada" ? `Quitada (${dataBr(d.dataQuitacao)})` : d.status === "aberta" ? "Quitação desfeita" : d.status === "cancelada" ? "Cancelada" : `Situação: ${d.status}`;
  if (a.classificacao !== d.classificacao) return `Diferença classificada: ${d.classificacao ?? "voltou a não classificada"}`;
  if (a.provisoria !== d.provisoria) return d.provisoria ? "Voltou a provisória (dado financeiro alterado)" : "Registro confirmado";
  if (a.valorOriginalCentavos !== d.valorOriginalCentavos) return `Valor original: ${moeda(a.valorOriginalCentavos)} → ${moeda(d.valorOriginalCentavos)}`;
  return "Alterada";
}
