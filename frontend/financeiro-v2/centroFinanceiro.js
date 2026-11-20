// Centro Financeiro (Módulo Administrativo) — Execução 01 do MOVA. PROTÓTIPO EM SIMULAÇÃO.
// Não chama o backend: lê os dados sintéticos de centroFinanceiroSimulacao.js. Contas a Pagar, Contas a Receber e Conciliação
// NÃO são reimplementadas aqui: as abas levam às telas que já existem no Financeiro (index.html), que continuam sendo a fonte.
// Aprovar/rejeitar ficam desligados: aplicar uma proposta exige financeiro_v2.aprovar + financeiro_v2.aplicar pelo serviço real
// (próxima execução). Todo texto vindo de dados é inserido com textContent (nunca innerHTML).
import { CAIXA_DE_ENTRADA, CONFIGURACAO, HISTORICO, PROPOSTAS, UNIDADES } from "./centroFinanceiroSimulacao.js";

const ABAS = [
  { id: "visao", rotulo: "Visão Operacional" },
  { id: "entrada", rotulo: "Caixa de Entrada MOVA" },
  { id: "propostas", rotulo: "Propostas e Aprovações" },
  { id: "pagar", rotulo: "Contas a Pagar", ligacao: "index.html#/contas-a-pagar" },
  { id: "receber", rotulo: "Contas a Receber", ligacao: "index.html#/contas-a-receber" },
  { id: "conciliacao", rotulo: "Conciliação", ligacao: "index.html#/conferencias" },
  { id: "historico", rotulo: "Histórico do Agente" },
  { id: "config", rotulo: "Configurações MOVA" },
];
const ROTULO_DECISAO = { PROPOSTA: "Proposta criada", PEDIR_INFORMACAO: "Aguardando informação", DUPLICADO: "Duplicado", BLOQUEADO: "Bloqueado", IGNORADO: "Ignorado", FALHA_LEITURA: "Falha de leitura", CONSULTA: "Consulta", ORIENTACAO: "Orientação" };
const TOM_DECISAO = { PROPOSTA: "info", PEDIR_INFORMACAO: "alerta", DUPLICADO: "neutro", BLOQUEADO: "erro", IGNORADO: "neutro", FALHA_LEITURA: "alerta", CONSULTA: "info", ORIENTACAO: "neutro" };
const ROTULO_PROPOSTA = { DESPESA_PAGA: "Despesa paga", NOVA_OBRIGACAO: "Nova conta a pagar", BAIXA_DE_OBRIGACAO: "Baixa de conta existente" };

const estado = { aba: "visao", unidadeId: "alfa" };

function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "classe") n.className = v; else if (k === "texto") n.textContent = v; else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return n;
}
const reais = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const horaBr = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const nomeUnidade = (id) => UNIDADES.find((u) => u.unidadeId === id)?.nome ?? "Sem unidade";
const selo = (texto, tom) => el("span", { classe: `cf-selo cf-selo--${tom}`, texto });
const daUnidade = (lista) => lista.filter((x) => x.unidadeId === estado.unidadeId);
const semUnidade = (lista) => lista.filter((x) => x.unidadeId === null);

function cartao(titulo, ...corpo) { return el("section", { classe: "cf-cartao" }, el("h2", { texto: titulo }), ...corpo); }
function vazio(texto) { return el("p", { classe: "cf-vazio", texto }); }

function tabela(cabecalhos, linhas, legenda) {
  if (linhas.length === 0) return vazio("Nada por aqui nesta unidade.");
  return el("div", { classe: "cf-tabela-rolagem" }, el("table", { classe: "cf-tabela" },
    el("caption", { classe: "cf-oculto", texto: legenda }),
    el("thead", {}, el("tr", {}, cabecalhos.map((c) => el("th", { scope: "col", texto: c })))),
    el("tbody", {}, linhas.map((l) => el("tr", {}, l.map((c) => el("td", {}, c))))),
  ));
}

// ------------------------------------------------------------------ abas
function visao() {
  const props = daUnidade(PROPOSTAS);
  const entrada = daUnidade(CAIXA_DE_ENTRADA);
  const pendentes = semUnidade(CAIXA_DE_ENTRADA).filter((e) => e.decisao === "PEDIR_INFORMACAO").length;
  const unidade = UNIDADES.find((u) => u.unidadeId === estado.unidadeId);
  const kpi = (rotulo, valor, dica) => el("div", { classe: "cf-kpi" }, el("span", { classe: "cf-kpi-rotulo", texto: rotulo }), el("strong", { classe: "cf-kpi-valor", texto: valor }), dica ? el("span", { classe: "cf-dica", texto: dica }) : null);
  return [
    el("div", { classe: "cf-kpis" },
      kpi("Propostas aguardando revisão", String(props.filter((p) => p.estado === "AGUARDANDO_REVISAO").length)),
      kpi("Valor proposto", reais(props.reduce((s, p) => s + p.valorCentavos, 0)), "Nada lançado: só proposto"),
      kpi("Mensagens recebidas", String(entrada.length)),
      kpi("Sem unidade (todas)", String(pendentes), "Aguardam esclarecimento no grupo"),
    ),
    cartao("Fontes de faturamento da unidade",
      unidade.fontes.situacao === "CONFIRMADA"
        ? el("ul", { classe: "cf-lista" }, Object.entries(unidade.fontes.canais).map(([canal, fonte]) => el("li", {}, el("strong", { texto: `${canal}: ` }), fonte)))
        : el("p", { classe: "cf-aviso" }, "Fontes ", el("strong", { texto: "a confirmar" }), ". O MOVA não presume fonte nem orienta receita para esta unidade até o cadastro no Financeiro."),
      el("p", { classe: "cf-dica", texto: "iFood e 99Food entram só pela fonte oficial da plataforma; o pedido no PDV serve apenas para conferência." }),
    ),
  ];
}

function entrada() {
  const linhas = [...daUnidade(CAIXA_DE_ENTRADA), ...semUnidade(CAIXA_DE_ENTRADA)].map((e) => [
    horaBr(e.em), e.unidadeId ? nomeUnidade(e.unidadeId) : selo("Unidade não identificada", "alerta"), e.tipo, e.resumo, selo(ROTULO_DECISAO[e.decisao] ?? e.decisao, TOM_DECISAO[e.decisao] ?? "neutro"),
  ]);
  return [cartao("Caixa de Entrada MOVA",
    el("p", { classe: "cf-dica", texto: "Mensagens do grupo autorizado desta unidade e as que ainda não têm unidade. O conteúdo das mensagens não é exibido: só o tipo e a decisão." }),
    tabela(["Quando", "Unidade", "Tipo", "Mensagem", "Decisão"], linhas, "Mensagens recebidas pelo MOVA"))];
}

function propostas() {
  const linhas = daUnidade(PROPOSTAS).map((p) => [
    el("code", { texto: p.id }), ROTULO_PROPOSTA[p.tipo] + (p.parcial ? " (parcial)" : ""), p.favorecido, el("span", { classe: "cf-num", texto: reais(p.valorCentavos) }),
    `Competência ${p.datas.competencia} · ${p.datas.caixa ? `caixa ${dataBr(p.datas.caixa)}` : `vence ${dataBr(p.datas.vencimento)}`}`,
    el("span", {}, p.categoriaSugerida ? `Sugestão: ${p.categoriaSugerida}` : "—", p.sinaisDeInjecao ? el("span", { classe: "cf-quebra" }, selo("Revisar: texto suspeito", "erro")) : null),
    el("div", { classe: "cf-acoes" },
      el("button", { classe: "botao botao--pequeno", type: "button", disabled: true, title: "Aplicação real pendente (próxima execução)", texto: "Aprovar" }),
      el("button", { classe: "botao botao--pequeno", type: "button", disabled: true, title: "Aplicação real pendente (próxima execução)", texto: "Rejeitar" })),
  ]);
  return [cartao("Propostas e Aprovações",
    el("p", { classe: "cf-aviso", texto: "O MOVA só PROPÕE. Aprovar e aplicar será feito por uma pessoa com permissão de aprovar e aplicar no Financeiro, pelo serviço real. Nesta simulação os botões ficam desligados." }),
    tabela(["Proposta", "Tipo", "Favorecido", "Valor", "Datas", "Classificação", "Ações"], linhas, "Propostas do MOVA aguardando revisão"))];
}

function ligacao(aba) {
  return [cartao(aba.rotulo,
    el("p", { texto: `${aba.rotulo} continua na tela que já existe no Financeiro — sem cópia aqui, para não haver dois lugares com números diferentes.` }),
    el("p", {}, el("a", { classe: "botao botao--primario", href: aba.ligacao, texto: `Abrir ${aba.rotulo}` })),
    el("p", { classe: "cf-dica", texto: aba.id === "pagar" ? "Comprovante de conta já cadastrada vira proposta de BAIXA dessa conta — nunca uma despesa nova." : "As propostas do MOVA aparecem aqui só depois de aprovadas e aplicadas." }))];
}

function historico() {
  const linhas = [...daUnidade(HISTORICO), ...semUnidade(HISTORICO)].map((h) => [horaBr(h.em), h.unidadeId ? nomeUnidade(h.unidadeId) : "—", selo(ROTULO_DECISAO[h.decisao] ?? h.decisao, TOM_DECISAO[h.decisao] ?? "neutro"), el("code", { texto: h.motivo })]);
  return [cartao("Histórico do Agente", el("p", { classe: "cf-dica", texto: "Toda decisão do MOVA fica registrada com código do motivo — sem o texto das mensagens nem o conteúdo dos documentos." }), tabela(["Quando", "Unidade", "Decisão", "Motivo"], linhas, "Histórico de decisões do MOVA"))];
}

function config() {
  const c = CONFIGURACAO;
  return [
    cartao("Situação",
      el("ul", { classe: "cf-lista" },
        el("li", {}, el("strong", { texto: "Modo: " }), selo("Simulação", "alerta")),
        el("li", {}, el("strong", { texto: "Canal atual: " }), c.provedor.atual),
        el("li", {}, el("strong", { texto: "Alternativa: " }), c.provedor.alternativo))),
    cartao("Grupos autorizados", tabela(["Grupo", "Unidades atendidas", "Leitura"], c.grupos.map((g) => [g.rotulo, g.unidades.map(nomeUnidade).join(", "), selo(g.leitura === "DESLIGADA" ? "Desligada" : g.leitura, "neutro")]), "Grupos autorizados")),
    cartao("Participantes vinculados",
      el("p", { classe: "cf-dica", texto: "Estar no grupo não dá acesso. Só participante vinculado a um usuário, e com as permissões que esse usuário tem em cada unidade." }),
      tabela(["Participante", "Usuário", "Permissões nesta unidade"], c.vinculos.map((v) => [v.participante, v.usuario, (v.unidades[estado.unidadeId] ?? []).join(", ") || "Nenhuma"]), "Participantes vinculados")),
  ];
}

const DESENHOS = { visao, entrada, propostas, historico, config };

function desenhar() {
  const alvo = document.getElementById("cf-conteudo");
  const aba = ABAS.find((a) => a.id === estado.aba);
  for (const b of document.querySelectorAll("[role=tab]")) b.setAttribute("aria-selected", String(b.dataset.aba === estado.aba));
  alvo.replaceChildren(el("h2", { classe: "cf-oculto", texto: aba.rotulo }), ...(aba.ligacao ? ligacao(aba) : DESENHOS[aba.id]()));
  alvo.setAttribute("aria-labelledby", `cf-aba-${aba.id}`);
}

function iniciar() {
  const sel = document.getElementById("cf-unidade");
  sel.replaceChildren(...UNIDADES.map((u) => el("option", { value: u.unidadeId, texto: u.nome })));
  sel.value = estado.unidadeId;
  sel.addEventListener("change", () => { estado.unidadeId = sel.value; desenhar(); });
  const lista = document.getElementById("cf-abas");
  lista.replaceChildren(...ABAS.map((a) => el("li", { role: "presentation" }, el("button", { type: "button", role: "tab", id: `cf-aba-${a.id}`, "data-aba": a.id, "aria-controls": "cf-conteudo", texto: a.rotulo }))));
  lista.addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) { estado.aba = b.dataset.aba; desenhar(); } });
  lista.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    const i = ABAS.findIndex((a) => a.id === estado.aba);
    estado.aba = ABAS[(i + (e.key === "ArrowRight" ? 1 : ABAS.length - 1)) % ABAS.length].id;
    desenhar(); document.getElementById(`cf-aba-${estado.aba}`).focus();
  });
  desenhar();
}

iniciar();
