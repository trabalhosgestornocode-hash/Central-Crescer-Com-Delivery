// Configurações Financeiras — só o que o domínio REALMENTE suporta configurar. O que depende de decisão empresarial ou de homologação de
// segurança aparece como "Indisponível/Pendente", sem controle de enfeite. Regras históricas ficam protegidas: papel de categoria em uso e
// tipo/canal de conta com movimento em mês fechado não podem ser alterados (a tela explica e o servidor garante).
import { fin } from "./api.js";
import { moeda, dataBr, ROTULO_PAPEL, ROTULO_TIPO_CONTA, podeAcao, ACAO } from "./modelo.js";
import { garantirCss, cabecalho, tabela, badge, carregarEm, dialogo, campo, selecao, aviso, esc } from "./ui.js";

const OPCOES_PAPEL = Object.entries(ROTULO_PAPEL).filter(([v]) => v !== "saldo_anterior").map(([valor, rotulo]) => ({ valor, rotulo }));
const OPCOES_TIPO = Object.entries(ROTULO_TIPO_CONTA).map(([valor, rotulo]) => ({ valor, rotulo }));

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pode = podeAcao(ctx, ACAO.CONFIGURAR);
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    titulo: "Configurações Financeiras", sub: pode ? "Contas, categorias e regras de conciliação desta unidade. Mudanças ficam auditadas; regras históricas e meses fechados são protegidos." : "Somente leitura: alterar configurações exige a permissão de configuração financeira.",
  });
  const corpo = raiz.querySelector("[data-corpo]");

  const carregar = () => carregarEm(corpo, async () => {
    const [r, exc] = await Promise.all([fin.get("/configuracoes"), fin.get("/conciliacao/excecoes-sangria")]);
    return { r, exc };
  }, ({ r, exc }) => pintar(r, exc));

  function pintar(r, exc) {
    const nomeCat = new Map(r.categorias.map((c) => [c.id, c.nome]));
    const alertaAbertura = r.saldosAberturaDesconhecidos.length
      ? `<div class="fin-alerta fin-alerta--warn" role="status"><div><strong>Saldo de abertura desconhecido em ${r.saldosAberturaDesconhecidos.length} conta(s):</strong> ${r.saldosAberturaDesconhecidos.map((c) => esc(c.nome)).join(", ")}. Os saldos dessas contas aparecem como <em>parciais</em>; nunca assumimos zero. Informe a abertura quando houver extrato ou contagem.</div></div>` : `<div class="fin-alerta" role="status">Todas as contas ativas têm saldo de abertura informado.</div>`;
    const contas = tabela({ colunas: [
      { rotulo: "Conta", render: (c) => `${esc(c.nome)}${c.ativo ? "" : ` ${badge("Inativa", "muted")}`}` },
      { rotulo: "Tipo", render: (c) => `${esc(ROTULO_TIPO_CONTA[c.tipoConta] ?? c.tipoConta)}${c.tipoConta === "outra" && c.podeAlterarTipoCanal ? ` ${badge("Defina o tipo", "warn")}` : ""}` },
      { rotulo: "Canal de venda", render: (c) => esc(c.canalReferencia ?? "—") },
      { rotulo: "Abertura", num: true, render: (c) => (c.aberturaConhecida ? `${moeda(c.aberturaCentavos)}<br><small>${esc(dataBr(c.aberturaData))}</small>` : badge("Desconhecida", "warn")) },
      { rotulo: "Lançamentos", num: true, render: (c) => `${c.lancamentos}${c.lancamentosEmMesFechado ? `<br><small>${c.lancamentosEmMesFechado} em mês fechado</small>` : ""}` },
      { rotulo: "", render: (c) => (pode ? `<div class="fin-linha-acoes"><button class="btn btn-ghost btn-sm" data-conta="${c.id}">Editar</button><button class="btn btn-ghost btn-sm" data-abertura="${c.id}">${c.aberturaConhecida ? "Abertura" : "Informar abertura"}</button></div>` : "") },
    ], linhas: r.contas, vazio: "Nenhuma conta cadastrada." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const cats = tabela({ colunas: [
      { rotulo: "Tipo", render: (c) => esc(c.tipo) }, { rotulo: "Natureza", render: (c) => esc(c.natureza) }, { rotulo: "Categoria", render: (c) => `${esc(c.nome)}${c.ativo ? "" : ` ${badge("Inativa", "muted")}`}` },
      { rotulo: "Papel nos cálculos", render: (c) => `${badge(ROTULO_PAPEL[c.papel] ?? c.papel, "info")}${c.podeTrocarPapel ? "" : `<br><small>fixo: ${c.lancamentos} lançamento(s)</small>`}` },
      { rotulo: "", render: (c) => (pode ? `<button class="btn btn-ghost btn-sm" data-cat="${c.id}">Editar</button>` : "") },
    ], linhas: r.categorias, vazio: "Plano de contas vazio." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const excl = tabela({ colunas: [
      { rotulo: "Categoria excluída do confronto de sangrias", render: (x) => esc(nomeCat.get(x.categoria_id) ?? "—") }, { rotulo: "Motivo aprovado", render: (x) => esc(x.motivo) },
      { rotulo: "Situação", render: (x) => (x.ativa ? badge("Ativa", "ok") : badge("Desativada", "muted")) },
      { rotulo: "", render: (x) => (pode && x.ativa ? `<button class="btn btn-ghost btn-sm" data-exc-off="${x.id}">Desativar</button>` : "") },
    ], linhas: exc, vazio: "Nenhuma exceção aprovada: todas as saídas de caixa físico entram no confronto de sangrias." });
    const fc = r.fechamentoComPendencias;
    corpo.innerHTML = `
      ${alertaAbertura}
      <div class="fin-card"><h3>Contas financeiras</h3>${contas}${pode ? `<p><button class="btn btn-primary btn-sm" data-nova-conta>Nova conta</button></p>` : ""}
        <p class="fin-sub">Tipo e canal da conta influenciam a conciliação: ficam travados quando a conta tem movimento em mês fechado.</p></div>
      <div class="fin-card"><h3>Plano de contas</h3>${cats}${pode ? `<p><button class="btn btn-primary btn-sm" data-nova-cat>Nova categoria</button></p>` : ""}
        <p class="fin-sub">O papel decide a participação nos cálculos e não muda enquanto a categoria tiver lançamentos (reclassifique com motivo em outra categoria).</p></div>
      <div class="fin-card"><h3>Conciliação</h3>
        <p>${badge(`${r.conciliacao.contasComCanal} conta(s) com canal vinculado`, "info")} ${r.conciliacao.contasSemCanal ? badge(`${r.conciliacao.contasSemCanal} sem canal`, "muted") : ""}</p>
        <h4>Exceções de sangria (aprovadas)</h4>${excl}${pode ? `<p><button class="btn btn-ghost btn-sm" data-exc-nova>Aprovar exceção</button></p>` : ""}</div>
      <div class="fin-card"><h3>Fechamento com pendências</h3>
        <p>Fechar período com pendências: ${badge("Bloqueado", "ok")} · Exceções ativas: <strong>${fc.excecoesAtivas}</strong>
        · Lançamentos pendentes de classificação agora: <strong>${r.pendencias.classificacao}</strong></p>
        <p class="fin-sub">Não há política geral. A única via é uma exceção por unidade e competência, aprovada por SuperAdmin (justificada, auditada, de uso único); indisponível até a validação do MFA. As exceções existentes aparecem na tela Períodos.</p></div>
      <div class="fin-card"><h3>Indisponível ou pendente de decisão</h3>
        ${r.indisponiveis.map((x) => `<div class="fin-alerta" role="status"><div>${badge(x.somenteInformativo ? "Informativo" : "Indisponível", "muted")} <strong>${esc(x.titulo)}</strong><br>${esc(x.motivo)}</div></div>`).join("")}</div>`;
    ligar(r, exc);
  }

  function ligar(r, exc) {
    const conta = (id) => r.contas.find((c) => c.id === id);
    corpo.querySelector("[data-nova-conta]")?.addEventListener("click", () => dialogo({
      titulo: "Nova conta", enviar: "Criar",
      corpo: `${campo("Nome", "nome", { obrig: true, extra: 'maxlength="80"' })}${selecao("Tipo", "tipoConta", OPCOES_TIPO, { valor: "outra", obrig: true, vazio: null })}${campo("Canal de venda (opcional)", "canalReferencia", { dica: "Ex.: STONE, IFOOD" })}`,
      aoEnviar: async (d) => { await fin.post("/contas", { nome: d.get("nome"), tipoConta: d.get("tipoConta"), canalReferencia: d.get("canalReferencia") || undefined }); aviso("Conta criada."); carregar(); },
    }));
    corpo.querySelectorAll("[data-conta]").forEach((b) => b.addEventListener("click", () => {
      const c = conta(b.dataset.conta);
      dialogo({
        titulo: `Editar ${c.nome}`, enviar: "Salvar",
        corpo: `${campo("Nome", "nome", { valor: c.nome, obrig: true })}
          ${c.podeAlterarTipoCanal ? `${selecao("Tipo", "tipoConta", OPCOES_TIPO, { valor: c.tipoConta, obrig: true, vazio: null })}${campo("Canal de venda", "canalReferencia", { valor: c.canalReferencia ?? "" })}`
            : `<p class="fin-sub"><strong>Tipo e canal travados:</strong> a conta tem ${c.lancamentosEmMesFechado} lançamento(s) em mês fechado e alterá-los mudaria a conciliação já fechada.</p>`}
          ${selecao("Situação", "ativo", [{ valor: "true", rotulo: "Ativa" }, { valor: "false", rotulo: "Inativa" }], { valor: String(c.ativo), obrig: true, vazio: null })}`,
        aoEnviar: async (d) => {
          const corpoReq = { nome: d.get("nome"), ativo: d.get("ativo") === "true" };
          if (c.podeAlterarTipoCanal) { corpoReq.tipoConta = d.get("tipoConta"); corpoReq.canalReferencia = d.get("canalReferencia") ?? ""; }
          await fin.patch(`/contas/${c.id}`, corpoReq); aviso("Conta atualizada."); carregar();
        },
      });
    }));
    corpo.querySelectorAll("[data-abertura]").forEach((b) => b.addEventListener("click", () => {
      const c = conta(b.dataset.abertura);
      dialogo({
        titulo: `Saldo de abertura de ${c.nome}`, enviar: "Gravar",
        corpo: `<p class="fin-sub">Informe só se o valor for conhecido (extrato ou contagem). Sem abertura, o saldo da conta fica <strong>parcial</strong>.</p>
          ${campo("Data de referência", "dataReferencia", { tipo: "date", obrig: true, valor: c.aberturaData ?? "" })}
          ${campo("Valor (R$)", "valor", { obrig: true, valor: c.aberturaConhecida ? (c.aberturaCentavos / 100).toFixed(2).replace(".", ",") : "", extra: 'inputmode="decimal"' })}${campo("Nota (fonte do valor)", "nota")}`,
        aoEnviar: async (d) => { await fin.put("/aberturas", { contaId: c.id, dataReferencia: d.get("dataReferencia"), valor: d.get("valor"), nota: d.get("nota") || undefined }); aviso("Abertura gravada."); carregar(); },
      });
    }));
    corpo.querySelector("[data-nova-cat]")?.addEventListener("click", () => dialogo({
      titulo: "Nova categoria", enviar: "Criar",
      corpo: `${campo("Tipo", "tipo", { obrig: true, dica: "Ex.: DESPESA, CUSTO, RECEITA" })}${campo("Natureza", "natureza", { obrig: true, dica: "Ex.: FIXA, VARIAVEL, PESSOAL" })}${campo("Categoria", "nome", { obrig: true })}${selecao("Papel nos cálculos", "papel", OPCOES_PAPEL, { obrig: true, vazio: "Escolha…" })}`,
      aoEnviar: async (d) => { await fin.post("/plano-contas", Object.fromEntries(d.entries())); aviso("Categoria criada."); carregar(); },
    }));
    corpo.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      const c = r.categorias.find((x) => x.id === b.dataset.cat);
      dialogo({
        titulo: `Editar ${c.nome}`, enviar: "Salvar",
        corpo: `${campo("Nome", "nome", { valor: c.nome, obrig: true })}
          ${c.podeTrocarPapel ? selecao("Papel nos cálculos", "papel", OPCOES_PAPEL, { valor: c.papel, obrig: true, vazio: null }) : `<p class="fin-sub"><strong>Papel fixo (${esc(ROTULO_PAPEL[c.papel] ?? c.papel)}):</strong> a categoria tem ${c.lancamentos} lançamento(s). Para mudar o tratamento, crie outra categoria e reclassifique os lançamentos com motivo.</p>`}
          ${selecao("Situação", "ativo", [{ valor: "true", rotulo: "Ativa" }, { valor: "false", rotulo: "Inativa (não aceita novos lançamentos)" }], { valor: String(c.ativo), obrig: true, vazio: null })}`,
        aoEnviar: async (d) => { const o = { nome: d.get("nome"), ativo: d.get("ativo") === "true" }; if (c.podeTrocarPapel && d.get("papel") !== c.papel) o.papel = d.get("papel"); await fin.patch(`/plano-contas/${c.id}`, o); aviso("Categoria atualizada."); carregar(); },
      });
    }));
    corpo.querySelector("[data-exc-nova]")?.addEventListener("click", () => dialogo({
      titulo: "Aprovar exceção de sangria", enviar: "Aprovar",
      corpo: `<p class="fin-sub">Categorias aprovadas aqui saem do confronto de sangrias (ex.: despesa paga em espécie que não é sangria). Fica registrada com autor e data.</p>
        ${selecao("Categoria", "categoriaId", r.categorias.filter((c) => c.ativo).map((c) => ({ valor: c.id, rotulo: c.nome })), { obrig: true, vazio: "Escolha…" })}
        <label class="fin-campo"><span>Motivo da aprovação *</span><textarea name="motivo" rows="3" required minlength="5" maxlength="500"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post("/conciliacao/excecoes-sangria", { categoriaId: d.get("categoriaId"), motivo: d.get("motivo") }); aviso("Exceção aprovada."); carregar(); },
    }));
    corpo.querySelectorAll("[data-exc-off]").forEach((b) => b.addEventListener("click", () => dialogo({
      titulo: "Desativar exceção", enviar: "Desativar", perigo: true, corpo: `<label class="fin-campo"><span>Motivo *</span><textarea name="motivo" rows="3" required maxlength="500"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post(`/conciliacao/excecoes-sangria/${b.dataset.excOff}/desativar`, { motivo: d.get("motivo") }); aviso("Exceção desativada."); carregar(); },
    })));
    void exc;
  }
  carregar();
}
