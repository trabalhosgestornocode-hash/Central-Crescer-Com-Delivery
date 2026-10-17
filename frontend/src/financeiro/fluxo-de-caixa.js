// Fluxo de Caixa — lançamentos (fonte única), filtros, formulário, reclassificação com motivo, cancelamento e histórico.
import { fin } from "./api.js";
import { moeda, dataBr, periodoDoMes, rotuloMes, ROTULO_PAPEL, podeAcao, ACAO } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, dialogo, campo, selecao, aviso, esc, estado } from "./ui.js";

const POR_PAGINA = 100;

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const f = { mes: lerMes(), contaId: "", sentido: "", busca: "", pendente: false, deslocamento: 0 };
  let contas = [], cats = [];
  const quemPode = (a) => podeAcao(ctx, a);

  raiz.innerHTML = `<div data-topo></div><div data-filtros></div><div data-lista class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), filtros = raiz.querySelector("[data-filtros]"), lista = raiz.querySelector("[data-lista]");

  topo.innerHTML = cabecalho({
    titulo: "Fluxo de Caixa", sub: "Livro-caixa único. Nada é excluído: lançamentos incorretos são cancelados com motivo e toda mudança fica no histórico.",
    extra: `${quemPode(ACAO.LANCAR) ? `<button class="btn btn-primary btn-sm" data-novo>Novo lançamento</button><button class="btn btn-ghost btn-sm" data-transf>Nova transferência</button>` : ""}`,
  });

  const nomeConta = (id) => contas.find((c) => c.id === id)?.nome ?? "—";
  const catDe = (id) => cats.find((c) => c.id === id);

  function pintarFiltros() {
    filtros.innerHTML = `<form class="fin-filtros" data-form-filtros>
      ${seletorMes(f.mes)}
      ${selecao("Conta", "contaId", contas.map((c) => ({ valor: c.id, rotulo: c.nome })), { valor: f.contaId, vazio: "Todas" })}
      ${selecao("Tipo", "sentido", [{ valor: "entrada", rotulo: "Entradas" }, { valor: "saida", rotulo: "Saídas" }], { valor: f.sentido, vazio: "Todos" })}
      ${campo("Buscar descrição", "busca", { valor: f.busca })}
      <label class="fin-campo"><span>Pendências</span><select name="pendente"><option value="">Todos</option><option value="true"${f.pendente ? " selected" : ""}>Somente pendentes</option></select></label>
      <button class="btn btn-ghost btn-sm" type="submit">Filtrar</button></form>`;
    filtros.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const d = new FormData(e.target);
      f.mes = d.get("mes") || f.mes; f.contaId = d.get("contaId") || ""; f.sentido = d.get("sentido") || ""; f.busca = String(d.get("busca") || "").trim(); f.pendente = d.get("pendente") === "true"; f.deslocamento = 0;
      gravarMes(f.mes); carregar();
    });
    filtros.querySelector("#fin-mes").name = "mes";
  }

  function carregar() {
    const p = periodoDoMes(f.mes);
    carregarEm(lista, () => fin.get("/lancamentos", { ...p, contaId: f.contaId, sentido: f.sentido, busca: f.busca, pendente: f.pendente ? "true" : "", limite: POR_PAGINA, deslocamento: f.deslocamento }), pintarLista);
  }

  function pintarLista({ itens, total }) {
    if (!total) { lista.innerHTML = estado.vazio(`Nenhum lançamento em ${rotuloMes(f.mes)}`, "Ajuste os filtros ou registre o primeiro lançamento."); return; }
    const ent = itens.filter((l) => l.sentido === "entrada" && l.status === "realizado").reduce((s, l) => s + Number(l.valor_centavos), 0);
    const sai = itens.filter((l) => l.sentido === "saida" && l.status === "realizado").reduce((s, l) => s + Number(l.valor_centavos), 0);
    const acoes = (l) => `<div class="fin-linha-acoes">
      ${quemPode(ACAO.EDITAR) && l.status !== "cancelado" ? `<button class="btn btn-ghost btn-sm" data-editar="${l.id}">Editar</button>` : ""}
      ${quemPode(ACAO.EDITAR) ? `<button class="btn btn-ghost btn-sm" data-hist="${l.id}">Histórico</button>` : ""}
      ${quemPode(ACAO.EXCLUIR) && l.status !== "cancelado" ? `<button class="btn btn-ghost btn-sm" data-cancelar="${l.id}">Cancelar</button>` : ""}</div>`;
    const t = tabela({
      colunas: [
        { rotulo: "Data", render: (l) => dataBr(l.data_movimento) },
        { rotulo: "Descrição", render: (l) => `${esc(l.descricao)}${l.nota_revisao ? `<br><small title="${esc(l.nota_revisao)}">📝 ${esc(l.nota_revisao.slice(0, 90))}${l.nota_revisao.length > 90 ? "…" : ""}</small>` : ""}` },
        { rotulo: "Conta", render: (l) => esc(nomeConta(l.conta_id)) },
        { rotulo: "Categoria", render: (l) => { const c = catDe(l.categoria_id); return c ? `${esc(c.nome)}<br><small>${esc(ROTULO_PAPEL[c.papel] ?? c.papel)}</small>` : badge("Sem categoria", "warn"); } },
        { rotulo: "Entrada", num: true, render: (l) => (l.sentido === "entrada" ? `<span class="fin-pos">${moeda(Number(l.valor_centavos))}</span>` : "") },
        { rotulo: "Saída", num: true, render: (l) => (l.sentido === "saida" ? `<span class="fin-neg">${moeda(Number(l.valor_centavos))}</span>` : "") },
        { rotulo: "Situação", render: (l) => [l.status === "cancelado" ? badge("Cancelado", "bad") : l.status === "previsto" ? badge("Previsto", "info") : "", l.classificacao_pendente ? badge("Pendente", "warn") : "", l.origem === "importacao" ? badge("Importado", "muted") : ""].join(" ") },
        { rotulo: "", render: acoes },
      ],
      linhas: itens,
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    const fim = f.deslocamento + itens.length;
    lista.innerHTML = `<div class="fin-card">${t}
      <div class="fin-paginacao"><span>Mostrando ${f.deslocamento + 1}–${fim} de ${total}. Soma desta página (realizados): entradas ${moeda(ent)} · saídas ${moeda(sai)}</span>
      <span><button class="btn btn-ghost btn-sm" data-ant ${f.deslocamento ? "" : "disabled"}>Anterior</button> <button class="btn btn-ghost btn-sm" data-prox ${fim < total ? "" : "disabled"}>Próxima</button></span></div></div>`;
    lista.querySelector("[data-ant]")?.addEventListener("click", () => { f.deslocamento = Math.max(0, f.deslocamento - POR_PAGINA); carregar(); });
    lista.querySelector("[data-prox]")?.addEventListener("click", () => { f.deslocamento += POR_PAGINA; carregar(); });
    lista.querySelectorAll("[data-editar]").forEach((b) => b.addEventListener("click", () => editar(itens.find((l) => l.id === b.dataset.editar))));
    lista.querySelectorAll("[data-cancelar]").forEach((b) => b.addEventListener("click", () => cancelar(itens.find((l) => l.id === b.dataset.cancelar))));
    lista.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => historico(b.dataset.hist)));
  }

  const opcCats = (filtro = () => true) => cats.filter((c) => c.ativo && c.papel !== "saldo_anterior" && filtro(c)).map((c) => ({ valor: c.id, rotulo: `${c.nome} · ${ROTULO_PAPEL[c.papel] ?? c.papel}` }));
  const opcContas = () => contas.filter((c) => c.ativo).map((c) => ({ valor: c.id, rotulo: c.nome }));

  function novo() {
    dialogo({
      titulo: "Novo lançamento", enviar: "Registrar",
      corpo: `${selecao("Conta", "contaId", opcContas(), { obrig: true, vazio: "Escolha…" })}${selecao("Categoria", "categoriaId", opcCats(), { vazio: "Sem categoria (ficará pendente)" })}
        ${selecao("Tipo", "sentido", [{ valor: "entrada", rotulo: "Entrada" }, { valor: "saida", rotulo: "Saída" }], { obrig: true, vazio: "Escolha…" })}
        ${campo("Descrição", "descricao", { obrig: true, extra: 'maxlength="300"' })}${campo("Valor (R$)", "valor", { obrig: true, extra: 'inputmode="decimal" placeholder="0,00"', dica: "Até 2 casas decimais." })}
        ${campo("Data do movimento", "dataMovimento", { tipo: "date", obrig: true })}
        <details><summary>Datas opcionais</summary>${campo("Competência", "dataCompetencia", { tipo: "date" })}${campo("Vencimento", "dataVencimento", { tipo: "date" })}</details>
        ${selecao("Situação", "status", [{ valor: "realizado", rotulo: "Realizado (entra no caixa)" }, { valor: "previsto", rotulo: "Previsto (fora do caixa)" }], { valor: "realizado", obrig: true, vazio: null })}`,
      aoEnviar: async (d) => { await fin.post("/lancamentos", limpar(d)); aviso("Lançamento registrado."); carregar(); },
    });
  }

  function editar(l) {
    const cat = catDe(l.categoria_id);
    dialogo({
      titulo: "Editar lançamento", enviar: "Salvar alterações",
      corpo: `${campo("Descrição", "descricao", { valor: l.descricao, obrig: true })}${campo("Valor (R$)", "valor", { valor: (Number(l.valor_centavos) / 100).toFixed(2).replace(".", ","), obrig: true, extra: 'inputmode="decimal"' })}
        ${campo("Data do movimento", "dataMovimento", { tipo: "date", valor: l.data_movimento, obrig: true })}
        ${selecao("Categoria", "categoriaId", opcCats(), { valor: l.categoria_id ?? "", vazio: l.categoria_id ? null : "Sem categoria" })}
        ${l.classificacao_pendente ? `<label class="fin-campo"><span>Resolver pendência</span><select name="classificacaoPendente"><option value="">Manter pendente</option><option value="false">Classificação confirmada</option></select></label>` : ""}
        <label class="fin-campo"><span>Motivo / nota de revisão${cat ? " (obrigatório ao trocar a categoria ou resolver pendência)" : ""}</span><textarea name="notaRevisao" rows="3" maxlength="1000"></textarea></label>
        <small>A mudança fica registrada com autor, data e valores antes/depois.</small>`,
      aoEnviar: async (d) => {
        const corpo = limpar(d);
        if (corpo.categoriaId === (l.categoria_id ?? "")) delete corpo.categoriaId;
        if (corpo.classificacaoPendente === "false") corpo.classificacaoPendente = false; else delete corpo.classificacaoPendente;
        await fin.patch(`/lancamentos/${l.id}`, corpo); aviso("Lançamento atualizado."); carregar();
      },
    });
  }

  function cancelar(l) {
    dialogo({
      titulo: "Cancelar lançamento", enviar: "Cancelar lançamento", perigo: true,
      corpo: `<p>“${esc(l.descricao)}” — ${moeda(Number(l.valor_centavos))}. O lançamento não é excluído: fica como <strong>cancelado</strong> e sai dos cálculos.</p>
        <label class="fin-campo"><span>Motivo *</span><textarea name="motivo" rows="3" required maxlength="1000"></textarea></label>`,
      aoEnviar: async (d) => { await fin.post(`/lancamentos/${l.id}/cancelar`, { motivo: d.get("motivo") }); aviso("Lançamento cancelado."); carregar(); },
    });
  }

  async function historico(id) {
    const dlg = dialogo({ titulo: "Histórico de alterações", enviar: "Fechar", corpo: estado.carregando(), aoEnviar: async () => {} });
    try {
      const h = await fin.get("/auditoria", { entidade: "fin_lancamentos", entidadeId: id });
      const corpo = dlg.querySelector(".fin-form-corpo");
      corpo.innerHTML = h.length ? tabela({ colunas: [
        { rotulo: "Quando", render: (a) => esc(new Date(a.created_at).toLocaleString("pt-BR")) },
        { rotulo: "Ação", render: (a) => esc(a.acao.replace("fin_lancamentos.", "")) },
        { rotulo: "Mudou", render: (a) => esc(Object.keys(a.depois ?? {}).filter((k) => a.antes && JSON.stringify(a.antes[k]) !== JSON.stringify(a.depois[k]) && k !== "updated_at").join(", ") || "—") },
      ], linhas: h }) : "<p>Sem alterações registradas.</p>";
    } catch (e) { dlg.querySelector(".fin-form-corpo").innerHTML = estado.erro(e.message); }
  }

  function transferencia() {
    const transf = cats.filter((c) => c.ativo && c.papel === "transferencia");
    dialogo({
      titulo: "Nova transferência entre contas", enviar: "Transferir",
      corpo: `<p class="fin-sub">Cria um par vinculado (saída + entrada) na mesma operação. O resultado consolidado é zero.</p>
        ${selecao("Conta de origem", "contaOrigemId", opcContas(), { obrig: true, vazio: "Escolha…" })}${selecao("Conta de destino", "contaDestinoId", opcContas(), { obrig: true, vazio: "Escolha…" })}
        ${campo("Valor (R$)", "valor", { obrig: true, extra: 'inputmode="decimal"' })}${campo("Data", "data", { tipo: "date", obrig: true })}${campo("Descrição", "descricao", { valor: "Transferência entre contas" })}
        ${transf.length > 1 ? selecao("Categoria", "categoriaId", transf.map((c) => ({ valor: c.id, rotulo: c.nome })), { obrig: true, vazio: "Escolha…" }) : ""}`,
      aoEnviar: async (d) => { await fin.post("/transferencias", limpar(d)); aviso("Transferência registrada."); carregar(); },
    });
  }

  raiz.addEventListener("click", (e) => {
    if (e.target.closest("[data-novo]")) novo();
    if (e.target.closest("[data-transf]")) transferencia();
  });

  await carregarEm(lista, async () => {
    [contas, cats] = await Promise.all([fin.get("/contas"), fin.get("/plano-contas")]);
    return null;
  }, () => { pintarFiltros(); carregar(); });
}

/** FormData → objeto, descartando campos vazios (o servidor valida e normaliza valor/data). */
function limpar(d) {
  const o = {};
  for (const [k, v] of d.entries()) if (String(v).trim() !== "") o[k] = typeof v === "string" ? v.trim() : v;
  return o;
}
