// Contas Financeiras — saldos (parciais quando a abertura é desconhecida), extrato interno, aberturas e transferências.
import { fin } from "./api.js";
import { moeda, dataBr, periodoDoMes, rotuloMes, descreverSaldo, ROTULO_TIPO_CONTA, podeAcao, ACAO } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, dialogo, campo, selecao, aviso, esc, estado } from "./ui.js";

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  let mes = lerMes();
  const pode = (a) => podeAcao(ctx, a);
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  const topo = raiz.querySelector("[data-topo]");
  topo.innerHTML = cabecalho({
    titulo: "Contas Financeiras", sub: "Conta é ONDE o dinheiro está. Meio de pagamento e canal de venda são dimensões à parte.",
    extra: `${seletorMes(mes)}${pode(ACAO.CONFIGURAR) ? `<button class="btn btn-ghost btn-sm" data-nova-conta>Nova conta</button>` : ""}${pode(ACAO.LANCAR) ? `<button class="btn btn-primary btn-sm" data-transf>Transferir</button>` : ""}`,
  });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  let contas = [], cats = [];
  function carregar() {
    const p = periodoDoMes(mes);
    carregarEm(corpo, async () => {
      const [geral, cs, plano, ab, transf] = await Promise.all([fin.get("/relatorios/visao-geral", p), fin.get("/contas"), fin.get("/plano-contas"), fin.get("/aberturas"), fin.get("/transferencias")]);
      contas = cs; cats = plano;
      return { geral, ab, transf };
    }, ({ geral, ab, transf }) => pintar(geral, ab, transf));
  }

  function pintar(g, aberturas, transf) {
    if (!contas.length) { corpo.innerHTML = estado.vazio("Nenhuma conta cadastrada", pode(ACAO.CONFIGURAR) ? "Crie as contas (banco, adquirente, caixa…) para começar." : "Peça a um gestor para cadastrar as contas."); return; }
    const saldoDe = (id) => g.saldosPorConta.contas.find((c) => c.contaId === id);
    const tb = tabela({
      colunas: [
        { rotulo: "Conta", render: (c) => `${esc(c.nome)}<br><small>${esc(ROTULO_TIPO_CONTA[c.tipo_conta] ?? c.tipo_conta)}${c.canal_referencia ? ` · canal ${esc(c.canal_referencia)}` : ""}${c.ativo ? "" : " · inativa"}</small>` },
        { rotulo: "Abertura", num: true, render: (c) => { const s = saldoDe(c.id); return s?.aberturaCentavos != null ? moeda(s.aberturaCentavos) : badge("Desconhecida", "warn"); } },
        { rotulo: "Variação", num: true, render: (c) => moeda(saldoDe(c.id)?.variacao ?? 0, { sinal: true }) },
        { rotulo: "Saldo calculado", num: true, render: (c) => { const s = saldoDe(c.id); if (!s) return "—"; const d = descreverSaldo(s); return d.parcial ? `${badge("Parcial", "warn")}<br><small>${moeda(s.saldoSemAberturaCentavos)} de movimento</small>` : moeda(s.saldoCentavos); } },
        { rotulo: "", render: (c) => `<div class="fin-linha-acoes"><button class="btn btn-ghost btn-sm" data-extrato="${c.id}">Extrato</button>${pode(ACAO.CONFIGURAR) ? `<button class="btn btn-ghost btn-sm" data-abertura="${c.id}">Abertura</button><button class="btn btn-ghost btn-sm" data-canal="${c.id}">Canal</button>` : ""}</div>` },
      ],
      linhas: contas,
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const total = g.saldosPorConta.totalCentavos;
    const trTabela = tabela({
      colunas: [
        { rotulo: "Data", render: (t) => dataBr(t.data) },
        { rotulo: "Transferência", render: (t) => `${esc(t.contaOrigem ?? "?")} → ${esc(t.contaDestino ?? "?")}<br><small>${esc(t.descricao ?? "")}</small>` },
        { rotulo: "Valor", num: true, render: (t) => moeda(t.valorCentavos) },
        { rotulo: "Situação", render: (t) => (t.status === "cancelada" ? `${badge("Cancelada", "bad")}<br><small>${esc(t.motivo_cancelamento ?? "")}</small>` : badge(t.origem === "importacao" ? "Vinculada (importada)" : "Vinculada", "ok")) },
        { rotulo: "", render: (t) => (t.status === "vinculada" ? `<div class="fin-linha-acoes">
          ${pode(ACAO.CANCELAR) ? `<button class="btn btn-ghost btn-sm" data-cancelar-par="${t.id}">Cancelar transferência</button>` : ""}
          ${pode(ACAO.CONCILIAR) ? `<button class="btn btn-ghost btn-sm" data-desvincular="${t.id}">Desvincular</button>` : ""}</div>` : "") },
      ],
      linhas: transf.slice(0, 30), vazio: "Nenhuma transferência vinculada ainda.",
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `
      <div class="fin-card"><h3>Saldos — ${esc(rotuloMes(mes))}</h3>${tb}
        <p class="fin-sub">${total == null ? "Total consolidado indisponível: há contas com abertura desconhecida. " : `Total consolidado calculado: ${esc(moeda(total))}. `}${esc(g.saldosPorConta.rotulo)}</p></div>
      <div class="fin-card"><h3>Transferências vinculadas (últimas ${Math.min(30, transf.length)})</h3>${trTabela}</div>`;
    corpo.querySelectorAll("[data-extrato]").forEach((b) => b.addEventListener("click", () => extrato(b.dataset.extrato)));
    corpo.querySelectorAll("[data-canal]").forEach((b) => b.addEventListener("click", () => {
      const conta = contas.find((x) => x.id === b.dataset.canal);
      dialogo({
        titulo: `Canal de venda de ${conta.nome}`, enviar: "Gravar",
        corpo: `<p class="fin-sub">Vínculo explícito (ex.: STONE) usado na Conciliação para comparar vendas do canal com o recebido da conta. Deixe vazio para desvincular.</p>${campo("Canal", "canalReferencia", { valor: conta.canal_referencia ?? "" })}`,
        aoEnviar: async (d) => { await fin.patch(`/contas/${conta.id}`, { canalReferencia: d.get("canalReferencia") ?? "" }); aviso("Canal atualizado."); carregar(); },
      });
    }));
    corpo.querySelectorAll("[data-abertura]").forEach((b) => b.addEventListener("click", () => abertura(b.dataset.abertura, aberturas)));
    corpo.querySelectorAll("[data-cancelar-par]").forEach((b) => b.addEventListener("click", () => cancelarPar(b.dataset.cancelarPar)));
    corpo.querySelectorAll("[data-desvincular]").forEach((b) => b.addEventListener("click", () => desvincular(b.dataset.desvincular)));
  }

  async function extrato(id) {
    const p = periodoDoMes(mes);
    const dlg = dialogo({ titulo: "Extrato interno", enviar: "Fechar", corpo: estado.carregando(), aoEnviar: async () => {} });
    try {
      const e = await fin.get(`/contas/${id}/extrato`, p);
      dlg.querySelector(".fin-form-corpo").innerHTML = `<p><strong>${esc(e.conta.nome)}</strong> — ${e.parcial ? badge("Abertura desconhecida: saldo corrente parte de zero apenas para exibição", "warn") : `abertura ${esc(moeda(e.aberturaCentavos))} em ${esc(dataBr(e.aberturaData))}`}</p>
        ${tabela({ colunas: [
          { rotulo: "Data", render: (l) => dataBr(l.data_movimento) }, { rotulo: "Descrição", render: (l) => esc(l.descricao) },
          { rotulo: "Valor", num: true, render: (l) => moeda(l.sentido === "entrada" ? Number(l.valor_centavos) : -Number(l.valor_centavos), { sinal: true }) },
          { rotulo: "Saldo", num: true, render: (l) => moeda(l.saldoCorrenteCentavos) },
        ], linhas: e.linhas, vazio: "Sem lançamentos no período." })}<small>Extrato interno calculado dos lançamentos; não é extrato bancário.</small>`;
    } catch (err) { dlg.querySelector(".fin-form-corpo").innerHTML = estado.erro(err.message); }
  }

  function abertura(contaId, aberturas) {
    const atual = aberturas.find((a) => a.conta_id === contaId);
    dialogo({
      titulo: "Saldo de abertura", enviar: "Gravar",
      corpo: `<p class="fin-sub">Informe só se o valor for conhecido (extrato/contagem). Sem abertura, o saldo da conta fica <strong>parcial</strong> — nunca assumimos zero.</p>
        ${campo("Data de referência", "dataReferencia", { tipo: "date", obrig: true, valor: atual?.data_referencia ?? periodoDoMes(mes).de })}
        ${campo("Valor (R$)", "valor", { obrig: true, valor: atual ? (Number(atual.valor_centavos) / 100).toFixed(2).replace(".", ",") : "", extra: 'inputmode="decimal"' })}${campo("Nota (fonte do valor)", "nota")}`,
      aoEnviar: async (d) => { await fin.put("/aberturas", { contaId, dataReferencia: d.get("dataReferencia"), valor: d.get("valor"), nota: d.get("nota") || undefined }); aviso("Abertura gravada."); carregar(); },
    });
  }

  const campoMotivo = `<label class="fin-campo"><span>Motivo (mín. 10 caracteres) *</span><textarea name="motivo" rows="3" required minlength="10" maxlength="1000"></textarea></label>`;
  /** Desvincular = pareamento INCORRETO. As duas pernas continuam ATIVAS e voltam a pendentes. Não cancela nada. */
  function desvincular(id) {
    dialogo({
      titulo: "Desvincular transferência", enviar: "Desvincular", perigo: true,
      corpo: `<p>Use quando o <strong>pareamento</strong> está errado. As duas pernas continuam como lançamentos <strong>ativos</strong> e voltam a ficar pendentes. Para anular a transferência, use «Cancelar transferência».</p>${campoMotivo}`,
      aoEnviar: async (d) => { await fin.post(`/transferencias/${id}/desvincular`, { motivo: d.get("motivo") }); aviso("Transferência desvinculada."); carregar(); },
    });
  }
  /** Cancelar a transferência INTEIRA: as duas pernas e o par, juntos (ou nenhum). Nada é excluído. */
  function cancelarPar(id) {
    dialogo({
      titulo: "Cancelar transferência", enviar: "Cancelar transferência", perigo: true,
      corpo: `<p>As <strong>duas pernas</strong> e o par serão cancelados juntos, na mesma operação; nada é apagado e o motivo fica na auditoria. Se algum dos meses estiver fechado, nada será alterado.</p>${campoMotivo}`,
      aoEnviar: async (d) => { const r = await fin.post(`/transferencias/${id}/cancelar`, { motivo: d.get("motivo") }); aviso(r.jaCancelada ? "A transferência já estava cancelada." : "Transferência cancelada."); carregar(); },
    });
  }

  raiz.addEventListener("click", (e) => {
    if (e.target.closest("[data-nova-conta]")) {
      dialogo({
        titulo: "Nova conta", enviar: "Criar",
        corpo: `${campo("Nome", "nome", { obrig: true, extra: 'maxlength="80"' })}${selecao("Tipo", "tipoConta", Object.entries(ROTULO_TIPO_CONTA).map(([valor, rotulo]) => ({ valor, rotulo })), { valor: "outra", obrig: true, vazio: null })}`,
        aoEnviar: async (d) => { await fin.post("/contas", { nome: d.get("nome"), tipoConta: d.get("tipoConta") }); aviso("Conta criada."); carregar(); },
      });
    }
    if (e.target.closest("[data-transf]")) {
      const op = contas.filter((c) => c.ativo).map((c) => ({ valor: c.id, rotulo: c.nome }));
      const catT = cats.filter((c) => c.ativo && c.papel === "transferencia");
      dialogo({
        titulo: "Transferência entre contas", enviar: "Transferir",
        corpo: `${selecao("Origem", "contaOrigemId", op, { obrig: true, vazio: "Escolha…" })}${selecao("Destino", "contaDestinoId", op, { obrig: true, vazio: "Escolha…" })}${campo("Valor (R$)", "valor", { obrig: true, extra: 'inputmode="decimal"' })}${campo("Data", "data", { tipo: "date", obrig: true })}
          ${catT.length > 1 ? selecao("Categoria", "categoriaId", catT.map((c) => ({ valor: c.id, rotulo: c.nome })), { obrig: true, vazio: "Escolha…" }) : ""}`,
        aoEnviar: async (d) => { await fin.post("/transferencias", Object.fromEntries([...d.entries()].filter(([, v]) => v))); aviso("Transferência registrada."); carregar(); },
      });
    }
  });
  carregar();
}
