// MOVA DENTRO DO FINANCEIRO (28/11): o agente financeiro do WhatsApp como uma seção do próprio dashboard (#/mova/<seção>), com a
// MESMA sessão, unidade e permissões da plataforma — nada de janela à parte nem de dados sintéticos. Substitui centro-financeiro.html.
//
// Organização (uma pergunta por tela):
//   Visão geral    — o MOVA está funcionando? o que precisa de mim agora?
//   Caixa de entrada — mensagens e propostas: revisar, aprovar, rejeitar (detalhe numa gaveta lateral)
//   Operações      — o que o MOVA já lançou: conciliar comprovante, linha do tempo, reverter
//   Conferência    — pendências das contas a pagar (vencidas, sem documento, possível pagamento no extrato…)
//   Documentos     — arquivos recebidos pelo WhatsApp: conferir e encaminhar
//   Configurações  — funcionamento, autonomia, automações, grupos, entregadores, privacidade e histórico
//
// Regras herdadas do Centro Financeiro: só números que o servidor devolve; o servidor confere permissão, unidade e estado em cada
// ação; todo texto vindo de dados entra por textContent (a mensagem original é entrada não confiável). Atributos de interação usam
// o prefixo data-mova-* (o dashboard tem tratadores globais para data-acao, data-aba, data-secao…).

export const SECOES = Object.freeze([
  { id: "visao", rotulo: "Visão geral" },
  { id: "entrada", rotulo: "Caixa de entrada" },
  { id: "operacoes", rotulo: "Operações" },
  { id: "conferencia", rotulo: "Conferência" },
  { id: "documentos", rotulo: "Documentos" },
  { id: "configuracoes", rotulo: "Configurações" },
]);
const SUBSECOES_CONFIG = Object.freeze([
  { id: "funcionamento", rotulo: "Funcionamento" },
  { id: "autonomia", rotulo: "Autonomia" },
  { id: "automacoes", rotulo: "Automações" },
  { id: "grupos", rotulo: "Grupos e participantes" },
  { id: "entregadores", rotulo: "Entregadores" },
  { id: "privacidade", rotulo: "Privacidade e histórico" },
]);
export const secaoValida = (s) => (SECOES.some((x) => x.id === s) ? s : "visao");

// ------------------------------------------------------------------ vocabulário (códigos do servidor → texto)
const DECISAO = { PROPOSTA: ["Proposta criada", "info"], PEDIR_INFORMACAO: ["Aguardando informação", "alerta"], DUPLICADO: ["Duplicado", "neutro"], BLOQUEADO: ["Bloqueado", "erro"],
  IGNORADO: ["Ignorado", "neutro"], FALHA_LEITURA: ["Falha de leitura", "alerta"], CONSULTA: ["Consulta", "info"], ORIENTACAO: ["Orientação", "neutro"], RELACIONADA: ["Esclarecimento", "info"],
  EXECUTADO: ["Lançado", "ok"] };
const ESTADO_PROPOSTA = { AGUARDANDO_REVISAO: ["Aguardando revisão", "alerta"], APLICANDO: ["Aplicando", "info"], APLICADA: ["Aplicada", "ok"], REJEITADA: ["Rejeitada", "neutro"] };
const TIPO_PROPOSTA = { DESPESA_PAGA: "Compra já paga", NOVA_OBRIGACAO: "Nova conta a pagar", BAIXA_DE_OBRIGACAO: "Pagamento de conta existente", SOLICITACAO_DE_REVISAO: "Pedido de revisão",
  VINCULO_DE_DOCUMENTO: "Nota de conta já registrada", CONTA_RELATADA: "Conta relatada por texto" };
const TIPO_DOC = { COMPROVANTE_PAGAMENTO: "Comprovante", BOLETO: "Boleto", NOTA_FISCAL: "Nota fiscal", RECIBO: "Recibo", EXTRATO: "Extrato", RELATORIO_VENDAS: "Relatório de vendas", OUTRO: "Outro", DESCONHECIDO: "Não identificado" };
const INTENCAO = { INFORMAR_PAGAMENTO: "Pagamento feito", REGISTRAR_CONTA: "Conta a pagar", CONSULTAR: "Consulta", INFORMAR_TRANSFERENCIA: "Transferência", PEDIR_CORRECAO: "Pedido de correção",
  PEDIR_CLASSIFICACAO: "Pedido de classificação", OUTRA: "Outra", DESCONHECIDA: "Não identificada" };
const NIVEL = { SOMENTE_PROPOR: ["Só propor", "neutro"], APLICAR_COM_CONFIRMACAO: ["Com confirmação", "alerta"], APLICAR_AUTOMATICO: ["Automático", "info"] };
const OPERACAO = { BAIXA_POR_EXTRATO: "Baixa pelo extrato", BAIXA_DOCUMENTAL: "Pagamento por comprovante", CONTA_A_PAGAR: "Conta a pagar de boleto/nota", ANEXAR_DOCUMENTO: "Anexar nota",
  DESPESA_DOCUMENTAL: "Compra já paga", JUROS_DOCUMENTAL: "Juros e multas", PRESTACAO_DE_SANGRIA: "Prestação de sangria" };
const ESTADO_OP = { EXECUTANDO: ["Executando", "info"], EXECUTADA: ["Executada", "ok"], FALHOU: ["Falhou", "erro"], REVERTIDA: ["Revertida", "neutro"] };
const POLITICA_RESPOSTA = { PRIVADO_RESTRITO: "Privado restrito", GRUPO_FINANCEIRO: "Grupo financeiro", OPERACIONAL: "Operacional (sem valores)" };
const AUTOMACOES = { ENTREGADORES_SEMANAL: "Mensagem de segunda aos entregadores", ENTREGADORES_COBRANCA: "Lembrete de terça (nota pendente)",
  ENTREGADORES_RELATORIO: "Relatório de quarta no grupo da unidade", ENTREGADORES_AVISO_GRUPO: "Aviso de liberação no grupo da unidade" };
const HORARIO_PADRAO = { ENTREGADORES_SEMANAL: "10:00", ENTREGADORES_RELATORIO: "08:00", ENTREGADORES_COBRANCA: "09:00", ENTREGADORES_AVISO_GRUPO: "00:00" };
const CONFERENCIA_NOTA = { CONFERE: ["Confere", "ok"], DIVERGENTE: ["Divergente", "erro"], INCONCLUSIVA: ["Em análise", "alerta"] };
const MOTIVOS = { POSSIVEL_DUPLICIDADE: ["Possível duplicidade", "erro"], POSSIVEL_PAGAMENTO_NO_EXTRATO: ["Possível pagamento no extrato", "alerta"],
  SAIDAS_COMPATIVEIS_AMBIGUAS: ["Várias saídas compatíveis", "alerta"], AJUSTE_MANUAL: ["Ajuste manual", "alerta"], VENCIDA: ["Vencida", "erro"],
  FORNECEDOR_NAO_IDENTIFICADO: ["Sem fornecedor", "alerta"], PARCIAL: ["Parcial", "info"], PAGAMENTO_SEM_EXTRATO: ["Pagamento sem extrato", "info"],
  PAGA_SEM_COMPROVANTE: ["Paga sem comprovante", "neutro"], SEM_DOCUMENTO: ["Sem documento", "neutro"] };
const CONCILIACAO = { SEM_PAGAMENTO_REGISTRADO: "Sem pagamento registrado", POSSIVEL_PAGAMENTO_NO_EXTRATO_NAO_CONFIRMADO: "Possível pagamento no extrato (não confirmado)",
  SAIDAS_COMPATIVEIS_AMBIGUAS: "Várias saídas compatíveis", EXTRATO_INDISPONIVEL: "Extrato indisponível", PAGAMENTO_REGISTRADO_SEM_EXTRATO: "Pagamento sem vínculo com o extrato",
  PAGAMENTO_CONCILIADO: "Pagamento vinculado ao extrato" };
const ESTADO_DOC = { AGUARDANDO_CONFERENCIA: ["Aguardando conferência", "alerta"], REVISADO: ["Revisado", "ok"], ENCAMINHADO: ["Encaminhado ao Financeiro", "info"] };
const TIPO_DOC_CONF = { COMPROVANTE: "Comprovante", BOLETO: "Boleto", NOTA_FISCAL: "Nota fiscal", RECIBO: "Recibo", OUTRO: "Outro" };
const ETAPA = { RECEBIMENTO: "Recebimento", EXTRACAO: "Leitura", IDENTIFICACAO: "Identificação", CLASSIFICACAO: "Classificação", OBRIGACAO: "Conta", PAGAMENTO: "Pagamento",
  EXTRATO: "Extrato", CONCILIACAO: "Conciliação", RESULTADO: "Resultado" };
const SIT_ETAPA = { FEITO: ["Feito", "ok"], PENDENTE: ["Pendente", "alerta"], BLOQUEADO: ["Bloqueado", "erro"], NAO_SE_APLICA: ["Não se aplica", "neutro"] };
const SIT_A_CONCILIAR = { SEM_EXTRATO: ["Aguardando o extrato", "neutro"], CANDIDATA_UNICA: ["Saída do extrato encontrada", "info"], AMBIGUA: ["Várias saídas: escolha humana", "alerta"] };
const PENDENCIA = { REQUISITOS_FINANCEIROS_INCOMPLETOS: "Cadastro financeiro da unidade incompleto: aplicação bloqueada" };
const NIVEIS_DE_ACESSO = [
  ["Participante do grupo", "Conversa, consulta informações compartilháveis, envia documentos e cria propostas. Sem cadastro nem login."],
  ["Administrador financeiro", "Revisa, aprova, corrige e aplica — só aqui, no Financeiro, com as permissões do Financeiro."],
];
const PRIVACIDADE = {
  compartilhavel: ["Totais a pagar, vencendo e a receber por unidade", "Faturamento por período e caixa realizado", "Resumo da DRE (indicadores com a situação de cada um)",
    "Total de uma categoria na competência", "Comparativo entre as unidades", "Situação das propostas"],
  restrito: ["Dados bancários e saldos de conta", "Documentos pessoais (CPF, RG)", "Dados individuais de funcionários e entregadores", "Senhas, tokens e códigos", "DRE linha a linha e por fornecedor"],
};
const FILTROS_ENTRADA = [
  { id: "revisar", rotulo: "Para revisar" },
  { id: "informacao", rotulo: "Aguardando informação" },
  { id: "concluidas", rotulo: "Concluídas" },
  { id: "todas", rotulo: "Todas" },
];
const NIVEL2 = ["financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.registrar"];
const LIMITE_LINHAS = 80;

// ------------------------------------------------------------------ utilidades de desenho (DOM; texto sempre por textContent)
function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "classe") n.className = v;
    else if (k === "texto") n.textContent = v;
    else if (k === "estilo") n.setAttribute("style", v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return n;
}
const reais = (c) => (typeof c === "number" ? (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—");
const dataBr = (d) => (typeof d === "string" && d.length >= 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const horaBr = (iso) => { if (!iso) return "—"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const relativo = (iso) => {
  const t = Date.parse(iso ?? ""); if (Number.isNaN(t)) return "—";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "agora"; if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60); if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24); return d === 1 ? "ontem" : `há ${d} dias`;
};
const texto = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
const curto = (id) => String(id ?? "").slice(0, 8);
const selo = ([t, tom]) => el("span", { classe: `selo selo--${tom}`, texto: t });
const seloDe = (mapa, codigo) => selo(mapa[codigo] ?? [texto(codigo), "neutro"]);
const botao = (t, attrs = {}, tipo = "") => el("button", { type: "button", classe: `botao botao--pequeno${tipo ? ` botao--${tipo}` : ""}`, ...attrs, texto: t });
const vazio = (t, dica = null) => el("div", { classe: "mova-vazio" }, el("p", { texto: t }), dica ? el("p", { classe: "nota", texto: dica }) : null);
const nota = (t) => el("p", { classe: "nota", texto: t });
const ficha = (pares) => el("dl", { classe: "ficha mova-ficha" }, pares.filter(([, v]) => v !== undefined).map(([k, v]) => [el("dt", { texto: k }), el("dd", {}, v ?? "—")]));
function cartao(titulo, { sub = null, acoes = null, classe = "" } = {}, ...corpo) {
  return el("section", { classe: `card mova-cartao ${classe}`.trim() },
    titulo ? el("div", { classe: "card-topo" }, el("h2", { texto: titulo }), acoes) : null,
    sub ? el("p", { classe: "nota mova-sub", texto: sub }) : null,
    ...corpo);
}
function tabela(cabecalhos, linhas, legenda, { clicavel = false, selecionado = null, classe = null } = {}) {
  if (!linhas.length) return vazio("Nada por aqui nesta unidade.");
  return el("div", { classe: "tabela-rolavel" }, el("table", { classe: `tabela mova-tabela${classe ? ` ${classe}` : ""}` },
    el("caption", { classe: "sr", texto: legenda }),
    el("thead", {}, el("tr", {}, cabecalhos.map((c) => el("th", { scope: "col", classe: c.startsWith("=") ? "num" : null, texto: c.replace(/^=/, "") })))),
    el("tbody", {}, linhas.map(({ id, celulas, classe = null }) => el("tr", clicavel
      ? { classe: `mova-linha${selecionado === id ? " mova-linha--sel" : ""}${classe ? ` ${classe}` : ""}`, tabindex: "0", "data-mova-linha": id, "aria-selected": String(selecionado === id) }
      : { classe }, celulas.map((c, i) => el("td", { classe: cabecalhos[i]?.startsWith("=") ? "num" : null }, c)))))));
}
/** Indicador numérico: o valor sobe até o número (só inteiros; respeita "reduzir movimento"). */
function kpi(rotulo, valor, dica = null, { tom = null, href = null } = {}) {
  const v = el("strong", { classe: "mova-kpi-valor", texto: String(valor ?? "—"), ...(Number.isSafeInteger(valor) ? { "data-mova-contar": String(valor) } : {}) });
  const corpo = [el("span", { classe: "mova-kpi-rotulo", texto: rotulo }), v, dica ? el("span", { classe: "nota", texto: dica }) : null];
  return href ? el("a", { classe: `card mova-kpi${tom ? ` mova-kpi--${tom}` : ""}`, href }, corpo) : el("div", { classe: `card mova-kpi${tom ? ` mova-kpi--${tom}` : ""}` }, corpo);
}
const esqueleto = () => el("div", { classe: "mova-esqueleto", "aria-hidden": "true" }, el("div", { classe: "mova-esq-kpis" }, el("i"), el("i"), el("i"), el("i")), el("div", { classe: "mova-esq-bloco" }), el("div", { classe: "mova-esq-bloco mova-esq-bloco--baixo" }));
const reduzirMovimento = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
function contarNumeros(raiz) {
  if (reduzirMovimento()) return;
  for (const n of raiz.querySelectorAll("[data-mova-contar]")) {
    const alvo = Number(n.dataset.movaContar);
    if (!(alvo > 0) || alvo > 100000) continue;
    const inicio = performance.now(); const dur = 650;
    const passo = (t) => { const p = Math.min(1, (t - inicio) / dur); n.textContent = String(Math.round(alvo * (1 - (1 - p) ** 3))); if (p < 1) requestAnimationFrame(passo); };
    n.textContent = "0"; requestAnimationFrame(passo);
  }
}

// ------------------------------------------------------------------ montagem
/**
 * @param {HTMLElement} alvo  o <main> do dashboard
 * @param {{secao:string, ler:(url:string)=>Promise<object>, enviar:(url:string, corpo:object)=>Promise<object>,
 *          sessao:{permissoes:string[], escritaHabilitada:boolean, unidadeNome:string}, aoContador?:(n:number)=>void}} deps
 */
export function montarMova(alvo, { secao, ler, enviar, sessao, aoContador = () => {} }) {
  const perm = sessao.permissoes ?? [];
  const escrita = sessao.escritaHabilitada === true;
  const pode = {
    decidir: NIVEL2.every((p) => perm.includes(p)) && escrita,
    configurar: perm.includes("financeiro_v2.configurar") && escrita,
    cancelar: perm.includes("financeiro_v2.cancelar") && escrita,
    documentos: perm.includes("financeiro_v2.documentos"),
  };
  const st = { secao: secaoValida(secao), sub: "funcionamento", filtro: "revisar", busca: "", conf: { motivo: null, saida: null }, relacionadas: new Map(), gaveta: null, animar: true };
  const cache = new Map(); // chave → { carregando:Promise } | { ok, dados } | { erro }

  // ---------- leitura
  // Caixa e Bancos exige um período (inicio/fim): o mês corrente até hoje, em São Paulo. Só a lista de contas é usada.
  const hojeSp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const ROTA = { estado: "/api/fv2/mova/estado", caixa: "/api/fv2/mova/caixa", contas: `/api/fv2/caixa-e-bancos?inicio=${hojeSp.slice(0, 8)}01&fim=${hojeSp}`,
    erros: "/api/fv2/mova/erros", "falhas-gerais": "/api/fv2/mova/falhas-gerais" };
  const urlDe = (k) => ROTA[k] ?? `/api/fv2/mova/${k}`;
  const OPCIONAIS = new Set(["entregadores-oficiais", "contas", "erros", "falhas-gerais", "pagamentos-a-conciliar"]);
  function obter(k) {
    const c = cache.get(k);
    if (c && !c.carregando) return Promise.resolve(c);
    if (c?.carregando) return c.carregando;
    const p = ler(urlDe(k)).then((r) => {
      const v = r.ok ? { ok: true, dados: r.dados } : { ok: false, status: r.status, codigo: r.dados?.codigo ?? r.erro, erro: r.mensagem ?? r.dados?.mensagem ?? "Não foi possível carregar." };
      cache.set(k, v); return v;
    });
    cache.set(k, { carregando: p });
    return p;
  }
  const dado = (k) => { const c = cache.get(k); return c && c.ok ? c.dados : null; };
  const CHAVES = {
    visao: ["visao-geral", "caixa", "estado"],
    entrada: ["caixa", ...(pode.decidir ? ["contas"] : [])],
    operacoes: ["operacoes", "politicas", "pagamentos-a-conciliar"],
    conferencia: ["conferencia"],
    documentos: ["documentos-recebidos"],
    configuracoes: { funcionamento: ["estado", "erros", ...(perm.includes("financeiro_v2.configurar") ? ["falhas-gerais"] : [])], autonomia: ["politicas"], automacoes: ["automacoes"],
      grupos: ["grupos"], entregadores: ["entregadores", "entregadores-oficiais"], privacidade: ["caixa"] },
  };
  const chavesDaTela = () => (st.secao === "configuracoes" ? CHAVES.configuracoes[st.sub] : CHAVES[st.secao]);
  function recarregar(...chaves) { for (const k of chaves.length ? chaves : [...cache.keys()]) cache.delete(k); }

  // ---------- estrutura fixa (cabeçalho, abas, corpo, gaveta, diálogo, avisos)
  const raiz = el("div", { classe: "mova", "data-mova-secao": st.secao });
  const statusEl = el("div", { classe: "mova-status", "aria-live": "polite" });
  const faixa = el("div", { classe: "mova-faixa", hidden: true, role: "note" });
  const abas = el("nav", { classe: "mova-abas", "aria-label": "Seções do MOVA" });
  const corpo = el("div", { classe: "mova-corpo", id: "mova-corpo", tabindex: "-1" });
  const avisos = el("div", { classe: "mova-avisos", role: "status", "aria-live": "polite" });
  const gavetaFundo = el("div", { classe: "mova-gaveta-fundo", hidden: true, "data-mova": "fechar-gaveta" });
  const gaveta = el("aside", { classe: "mova-gaveta", role: "dialog", "aria-modal": "true", "aria-labelledby": "mova-gaveta-titulo", hidden: true, tabindex: "-1" });
  const dialogo = el("dialog", { classe: "mova-dialogo", "aria-labelledby": "mova-dialogo-titulo" });
  raiz.append(
    el("header", { classe: "cabecalho mova-cabecalho" },
      el("div", {}, el("p", { classe: "mova-sobretitulo", texto: "Agente financeiro no WhatsApp" }), el("h1", { texto: "MOVA" }),
        el("p", { classe: "subtitulo", texto: `${sessao.unidadeNome ?? "Unidade"} · tudo o que o MOVA recebeu, propôs e lançou nesta unidade` })),
      statusEl),
    faixa, abas, corpo, gavetaFundo, gaveta, dialogo, avisos);
  alvo.replaceChildren(raiz);

  function desenharAbas() {
    abas.replaceChildren(el("ul", {}, SECOES.map((s) => el("li", {}, el("a", { href: s.id === "visao" ? "#/mova" : `#/mova/${s.id}`, "aria-current": st.secao === s.id ? "page" : "false" },
      s.rotulo, s.id === "entrada" ? el("span", { classe: "mova-contador", "data-mova-contador": "", hidden: true }) : null)))));
    atualizarContador();
  }
  function pendentesDeRevisao() { return (dado("caixa")?.itens ?? []).filter((i) => i.proposta?.estado === "AGUARDANDO_REVISAO").length; }
  function atualizarContador() {
    const n = dado("caixa") ? pendentesDeRevisao() : 0;
    for (const c of document.querySelectorAll("[data-mova-contador]")) { c.textContent = String(n); c.hidden = n === 0; }
    aoContador(n);
  }
  function desenharStatus() {
    const e = dado("estado");
    if (!e) { statusEl.replaceChildren(); return; }
    const ctl = e.controle ?? {};
    const operando = !ctl.suspenso && ctl.recebimento !== false && ctl.processamento !== false;
    const pilula = (rotulo, ligado, titulo) => el("span", { classe: `mova-pilula mova-pilula--${ligado ? "on" : "off"}`, title: titulo, texto: rotulo });
    statusEl.replaceChildren(
      el("span", { classe: `mova-estado mova-estado--${ctl.suspenso ? "erro" : operando ? "ok" : "alerta"}` }, el("span", { classe: "mova-pulso", "aria-hidden": "true" }),
        ctl.suspenso ? "Suspenso" : operando ? "Operando" : "Parcialmente desligado"),
      el("span", { classe: "mova-pilulas" }, pilula("Recebimento", ctl.recebimento !== false && !ctl.suspenso, "Leitura das mensagens do WhatsApp"),
        pilula("IA", ctl.ia !== false && e.chaves?.ia !== false && !ctl.suspenso, "Leitura de documentos por IA"),
        pilula("Respostas", ctl.envio !== false && e.envioHabilitado !== false && !ctl.suspenso, "Envio de respostas no WhatsApp")));
    if (e.chaves?.modo === "HOMOLOGACAO") { faixa.hidden = false; faixa.replaceChildren(el("strong", { texto: "Homologação" }), " · registros de teste do MOVA, não são lançamentos financeiros oficiais"); }
    else faixa.hidden = true;
  }

  // ---------- avisos (toasts)
  function avisar(t, ok = true) {
    const n = el("div", { classe: `mova-toast mova-toast--${ok ? "ok" : "erro"}` }, el("span", { classe: "mova-toast-icone", "aria-hidden": "true", texto: ok ? "✓" : "!" }), el("span", { texto: t }));
    avisos.append(n);
    setTimeout(() => { n.classList.add("mova-toast--saindo"); setTimeout(() => n.remove(), 260); }, ok ? 4200 : 7000);
  }

  // ---------- diálogo (no lugar de prompt/confirm do navegador)
  /** @returns {Promise<object|null>} valores do formulário, ou null se cancelado */
  function perguntar({ titulo, texto: explicacao = null, campos = [], confirmar = "Confirmar", perigo = false }) {
    return new Promise((ok) => {
      const form = el("form", { method: "dialog", classe: "mova-dialogo-form" },
        el("h2", { id: "mova-dialogo-titulo", texto: titulo }),
        explicacao ? el("p", { classe: "mova-dialogo-texto", texto: explicacao }) : null,
        campos.map((c) => el("label", { classe: "mova-campo" }, el("span", { texto: c.rotulo }),
          c.tipo === "textarea" ? el("textarea", { name: c.nome, required: c.obrigatorio, minlength: c.min ?? null, maxlength: c.max ?? 500, rows: "3", placeholder: c.dica ?? null }, c.valor ?? "")
            : c.tipo === "select" ? el("select", { name: c.nome, required: c.obrigatorio }, c.opcoes.map(([v, r]) => el("option", { value: v, texto: r, selected: v === c.valor })))
              : el("input", { name: c.nome, type: c.tipo ?? "text", required: c.obrigatorio, minlength: c.min ?? null, maxlength: c.max ?? null, value: c.valor ?? null, placeholder: c.dica ?? null, inputmode: c.inputmode ?? null, autocomplete: "off" }),
          c.ajuda ? el("small", { classe: "nota", texto: c.ajuda }) : null)),
        el("div", { classe: "mova-dialogo-acoes" },
          el("button", { type: "button", classe: "botao", value: "cancelar", "data-mova-dialogo": "cancelar", texto: "Cancelar" }),
          el("button", { type: "submit", classe: `botao ${perigo ? "botao--perigo-cheio" : "botao--primario"}`, value: "ok", texto: confirmar })));
      dialogo.replaceChildren(form);
      let feito = false;
      const fim = (v) => { if (feito) return; feito = true; dialogo.classList.add("mova-dialogo--saindo"); setTimeout(() => { dialogo.classList.remove("mova-dialogo--saindo"); if (dialogo.open) dialogo.close(); }, 160); ok(v); };
      form.addEventListener("submit", (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!form.reportValidity()) return; fim(Object.fromEntries(new FormData(form).entries())); });
      form.querySelector("[data-mova-dialogo=cancelar]").addEventListener("click", () => fim(null));
      dialogo.addEventListener("cancel", (ev) => { ev.preventDefault(); fim(null); }, { once: true });
      if (typeof dialogo.showModal === "function") dialogo.showModal(); else dialogo.setAttribute("open", "");
      (form.querySelector("input, textarea, select") ?? form.querySelector("[type=submit]"))?.focus();
    });
  }

  // ---------- gaveta lateral (detalhe)
  let focoAntes = null;
  function abrirGaveta(g) {
    const nova = !st.gaveta;
    st.gaveta = g;
    if (nova) focoAntes = document.activeElement;
    desenharGaveta();
    gavetaFundo.hidden = false; gaveta.hidden = false;
    document.documentElement.classList.add("mova-sem-rolagem");
    if (nova) requestAnimationFrame(() => { gavetaFundo.classList.add("aberta"); gaveta.classList.add("aberta"); gaveta.focus(); });
  }
  function fecharGaveta() {
    if (!st.gaveta) return;
    st.gaveta = null;
    gavetaFundo.classList.remove("aberta"); gaveta.classList.remove("aberta");
    document.documentElement.classList.remove("mova-sem-rolagem");
    setTimeout(() => { if (!st.gaveta) { gavetaFundo.hidden = true; gaveta.hidden = true; gaveta.replaceChildren(); } }, 240);
    for (const tr of corpo.querySelectorAll(".mova-linha--sel")) { tr.classList.remove("mova-linha--sel"); tr.setAttribute("aria-selected", "false"); }
    focoAntes?.focus?.();
  }
  function desenharGaveta() {
    if (!st.gaveta) return;
    const { tipo, id } = st.gaveta;
    const [titulo, conteudo] = tipo === "item" ? gavetaItem(id) : tipo === "pendencia" ? gavetaPendencia(id) : tipo === "linha-do-tempo" ? gavetaLinhaDoTempo(id) : ["Detalhe", [vazio("Indisponível.")]];
    gaveta.replaceChildren(
      el("div", { classe: "mova-gaveta-cabeca" }, el("h2", { id: "mova-gaveta-titulo", texto: titulo }), el("button", { type: "button", classe: "botao-fechar", "data-mova": "fechar-gaveta", "aria-label": "Fechar", texto: "×" })),
      el("div", { classe: "mova-gaveta-corpo" }, conteudo));
  }

  // ================================================================== SEÇÕES
  // ---------- Visão geral
  function telaVisao() {
    const v = dado("visao-geral");
    const caixa = dado("caixa") ?? { itens: [], aguardandoUnidade: [] };
    const itens = [...caixa.itens, ...caixa.aguardandoUnidade];
    const revisar = itens.filter((i) => i.proposta?.estado === "AGUARDANDO_REVISAO");
    const informacao = itens.filter((i) => i.decisoes?.at(-1)?.decisao === "PEDIR_INFORMACAO" && !i.proposta);
    const bloqueadas = revisar.filter((i) => i.proposta?.bloqueioDeAplicacao);
    const prop = v?.propostas ?? {}; const ops = v?.operacoes ?? {}; const ia = v?.orcamentoIa;
    const acao = (n, titulo, dica, href, tom) => el("a", { classe: `mova-tarefa mova-tarefa--${n ? tom : "ok"}`, href },
      el("span", { classe: "mova-tarefa-n", texto: String(n) }), el("span", { classe: "mova-tarefa-texto" }, el("strong", { texto: titulo }), el("span", { classe: "nota", texto: n ? dica : "Nada pendente." })),
      el("span", { classe: "mova-seta", "aria-hidden": "true" }));
    const recentes = itens.flatMap((i) => (i.decisoes ?? []).map((d) => ({ ...d, i }))).sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 8);
    return [
      v ? el("div", { classe: "mova-kpis" },
        kpi("Mensagens recebidas", v.mensagens?.recebidas ?? 0, `últimos ${v.periodoDias ?? 7} dias`),
        kpi("Respostas enviadas", v.respostas?.ENVIADA ?? 0, v.respostas?.PENDENTE ? `${v.respostas.PENDENTE} aguardando envio` : "nenhuma pendente"),
        kpi("Aguardando revisão", prop.AGUARDANDO_REVISAO?.quantidade ?? 0, reais(prop.AGUARDANDO_REVISAO?.valorCentavos ?? 0), { tom: prop.AGUARDANDO_REVISAO?.quantidade ? "alerta" : null, href: "#/mova/entrada" }),
        kpi("Lançado pelo MOVA", ops.EXECUTADA?.quantidade ?? 0, reais(ops.EXECUTADA?.valorCentavos ?? 0), { href: "#/mova/operacoes" })) : null,
      el("div", { classe: "mova-duas" },
        cartao("Precisa de você", { sub: "O que só uma pessoa pode resolver." },
          el("div", { classe: "mova-tarefas" },
            acao(revisar.length, `${revisar.length === 1 ? "Proposta aguardando" : "Propostas aguardando"} revisão`, `${reais(revisar.reduce((s, i) => s + (i.proposta?.valorCentavos ?? 0), 0))} propostos, nada lançado ainda.`, "#/mova/entrada", "alerta"),
            acao(informacao.length + caixa.aguardandoUnidade.length, "Aguardando resposta no WhatsApp", "O MOVA perguntou algo (unidade, valor, competência) e ainda não teve resposta.", "#/mova/entrada?filtro=informacao", "info"),
            acao(bloqueadas.length, "Bloqueadas pelo cadastro", "Cadastro financeiro da unidade incompleto: confirme as fontes em Configurações.", "#/configuracoes", "erro"))),
        cartao("Atividade recente", { sub: "Últimas decisões do MOVA nesta unidade." },
          recentes.length ? el("ol", { classe: "mova-linha-tempo" }, recentes.map((d) => el("li", {},
            el("span", { classe: `mova-ponto mova-ponto--${(DECISAO[d.decisao] ?? [0, "neutro"])[1]}`, "aria-hidden": "true" }),
            el("div", {}, el("div", { classe: "mova-lt-topo" }, seloDe(DECISAO, d.decisao), el("time", { classe: "nota", datetime: d.em, title: horaBr(d.em), texto: relativo(d.em) })),
              el("p", { classe: "mova-lt-texto", texto: `${d.i.participante?.nomeExibicao ?? "Participante"}: ${String(d.i.texto ?? TIPO_DOC[d.i.dadosExtraidos?.tipoDocumento] ?? "mensagem").slice(0, 90)}` })))))
            : vazio("Nenhuma mensagem recebida ainda."))),
      v ? cartao("Funcionamento", { sub: `Contagens do banco do MOVA desta unidade, atualizadas ${relativo(v.geradoEm)}. Nenhum número é estimado.`, acoes: el("a", { classe: "botao botao--pequeno", href: "#/mova/configuracoes", texto: "Configurar" }) },
        el("div", { classe: "mova-grade-ficha" },
          ficha([["Modo", texto(v.modo)], ["Autonomia (conferência com o extrato)", ligado(v.autonomiaLigada)], ["Identidade operacional", ligado(v.identidadeOperacional, "Implantada", "Não implantada")]]),
          ficha([["Entregadores no WhatsApp", ligado(v.entregadoresLigado)], ["Automações", `${v.automacoes?.ativas ?? 0} ativa(s), ${v.automacoes?.pausadas ?? 0} pausada(s)`],
            ["Consumo de IA", ia ? medidor(ia.custoUsd, ia.limiteUsd, `US$ ${ia.custoUsd.toFixed(2)} de US$ ${ia.limiteUsd.toFixed(2)}`) : "sem orçamento registrado"]]))) : null,
    ];
  }
  const ligado = (v, sim = "Ligado", nao = "Desligado") => selo(v ? [sim, "ok"] : [nao, "neutro"]);
  function medidor(valor, limite, rotulo) {
    const p = limite > 0 ? Math.min(100, Math.round((valor / limite) * 100)) : 0;
    return el("span", { classe: "mova-medidor" }, el("span", { classe: "mova-medidor-barra", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(limite), "aria-valuenow": String(valor), "aria-label": rotulo },
      el("span", { classe: `mova-medidor-cheio${p >= 85 ? " mova-medidor-cheio--alto" : ""}`, estilo: `--p:${p}%` })), el("span", { classe: "nota", texto: rotulo }));
  }

  // ---------- Caixa de entrada
  const todosDaCaixa = () => { const c = dado("caixa") ?? { itens: [], aguardandoUnidade: [] }; return [...c.itens, ...c.aguardandoUnidade.map((i) => ({ ...i, semUnidade: true }))]; };
  const competenciaAConfirmar = (p) => Boolean(p?.competenciaPendente && !p?.competenciaRevisada && p?.estado === "AGUARDANDO_REVISAO");
  const competenciaDe = (p) => p?.competenciaRevisada ?? p?.datas?.competencia ?? null;
  function classeDoItem(i) {
    const ult = i.decisoes?.at(-1)?.decisao;
    if (i.proposta?.estado === "AGUARDANDO_REVISAO") return "revisar";
    if (i.semUnidade || (ult === "PEDIR_INFORMACAO" && !i.proposta)) return "informacao";
    return "concluidas";
  }
  function telaEntrada() {
    const itens = todosDaCaixa().sort((a, b) => String(b.recebidoEm).localeCompare(String(a.recebidoEm)));
    const contagem = { revisar: 0, informacao: 0, concluidas: 0, todas: itens.length };
    for (const i of itens) contagem[classeDoItem(i)] += 1;
    const busca = st.busca.trim().toLowerCase();
    const lista = itens.filter((i) => (st.filtro === "todas" || classeDoItem(i) === st.filtro)
      && (!busca || [i.texto, i.participante?.nomeExibicao, i.dadosExtraidos?.favorecido, reais(i.dadosExtraidos?.valorCentavos ?? i.proposta?.valorCentavos ?? null)].some((x) => String(x ?? "").toLowerCase().includes(busca))));
    const linhas = lista.map((i) => {
      const x = i.dadosExtraidos; const p = i.proposta;
      return { id: i.eventoId, classe: p?.sinaisDeInjecao ? "mova-linha--suspeita" : null, celulas: [
        el("span", { classe: "mova-quando" }, el("strong", { texto: relativo(i.recebidoEm) }), el("span", { classe: "nota", texto: horaBr(i.recebidoEm) })),
        el("span", { classe: "mova-quem" }, el("strong", { texto: i.participante?.nomeExibicao ?? i.participante?.referencia ?? "—" }), el("span", { classe: "nota mova-trecho", texto: texto(i.texto) })),
        el("span", {}, x ? TIPO_DOC[x.tipoDocumento] ?? x.tipoDocumento : i.tipo === "TEXTO" ? "Texto" : texto(i.tipo), p ? el("span", { classe: "nota", texto: TIPO_PROPOSTA[p.tipo] ?? p.tipo }) : null),
        el("span", { classe: "valor", texto: reais(x?.valorCentavos ?? p?.valorCentavos ?? null) }),
        p ? seloDe(ESTADO_PROPOSTA, p.estado) : i.semUnidade ? selo(["Unidade a confirmar", "alerta"]) : seloDe(DECISAO, i.decisoes?.at(-1)?.decisao),
      ] };
    });
    return [
      cartao(null, { classe: "mova-cartao--lista" },
        el("div", { classe: "mova-barra" },
          el("div", { classe: "mova-segmentos", role: "tablist", "aria-label": "Filtrar mensagens" }, FILTROS_ENTRADA.map((f) => el("button", { type: "button", role: "tab", classe: "mova-segmento", "aria-selected": String(st.filtro === f.id), "data-mova": "filtro", "data-filtro": f.id },
            f.rotulo, el("span", { classe: "mova-segmento-n", texto: String(contagem[f.id]) })))),
          el("label", { classe: "mova-busca" }, el("span", { classe: "sr", texto: "Buscar" }), el("input", { type: "search", placeholder: "Buscar por pessoa, texto, favorecido ou valor", value: st.busca, "data-mova-busca": "" }))),
        lista.length ? tabela(["Recebida", "Mensagem", "Documento", "=Valor", "Situação"], linhas, "Mensagens recebidas pelo MOVA", { clicavel: true, classe: "mova-tabela--entrada", selecionado: st.gaveta?.tipo === "item" ? st.gaveta.id : null })
          : vazio(st.filtro === "revisar" ? "Nenhuma proposta aguardando revisão." : "Nenhuma mensagem neste filtro.", st.filtro === "revisar" ? "Quando o MOVA preparar uma proposta, ela aparece aqui para você aprovar ou rejeitar." : null)),
      el("p", { classe: "nota mova-rodape", texto: "O MOVA só propõe. Aprovar aplica no Financeiro pelos serviços oficiais, revalidando competência, saldo e duplicidade na hora. Comprovante não concilia extrato." }),
    ];
  }
  function motivoParaNaoAprovar(p) {
    if (p.bloqueioDeAplicacao) return PENDENCIA[p.bloqueioDeAplicacao] ?? p.bloqueioDeAplicacao;
    if (!pode.decidir) return escrita ? "Sua sessão não tem permissão para aprovar e aplicar." : "A escrita no Financeiro está desligada.";
    if (p.estado !== "AGUARDANDO_REVISAO") return "Proposta já decidida.";
    if (competenciaAConfirmar(p)) return "Informe a competência antes de aprovar.";
    return null;
  }
  function gavetaItem(id) {
    const i = todosDaCaixa().find((x) => x.eventoId === id);
    if (!i) return ["Mensagem", [vazio("Esta mensagem não está mais na caixa de entrada.")]];
    const x = i.dadosExtraidos; const p = i.proposta;
    const motivo = p ? motivoParaNaoAprovar(p) : null;
    const pagamento = p && ["BAIXA_DE_OBRIGACAO", "DESPESA_PAGA"].includes(p.tipo);
    const contas = (dado("contas")?.contas ?? []).filter((c) => c.ativa !== false);
    const pend = [];
    const ult = i.decisoes?.at(-1);
    if (ult?.decisao === "PEDIR_INFORMACAO") pend.push(ult.motivo === "UNIDADE_NAO_IDENTIFICADA" || ult.motivo === "UNIDADE_CONFLITANTE" ? "Aguardando o participante informar a loja no grupo." : "Aguardando informação do participante.");
    if (p?.bloqueioDeAplicacao) pend.push(PENDENCIA[p.bloqueioDeAplicacao] ?? p.bloqueioDeAplicacao);
    if (p?.sinaisDeInjecao) pend.push("Mensagem com texto suspeito (parece tentar dar ordens ao MOVA): revise com atenção.");
    if (competenciaAConfirmar(p)) pend.push("Competência não informada na mensagem: confirme antes de aprovar.");
    const confirmarBaixa = p?.tipo === "BAIXA_DE_OBRIGACAO" && p.conciliacao?.situacao === "CONFERIDA" && p.estado === "AGUARDANDO_REVISAO";
    const decisao = p && p.estado === "AGUARDANDO_REVISAO" ? el("section", { classe: "mova-decisao" },
      el("h3", { texto: "Decisão" }),
      motivo ? el("p", { classe: "mova-alerta mova-alerta--info", texto: motivo }) : null,
      pode.decidir && p.tipo !== "BAIXA_DE_OBRIGACAO" ? el("div", { classe: "mova-campo-linha" },
        el("label", { classe: "mova-campo" }, el("span", { texto: "Categoria definitiva" }), el("input", { "data-mova-categoria": p.id, value: p.categoriaRevisada ?? p.categoriaSugerida ?? "", placeholder: "CODIGO_DA_CATEGORIA", "aria-describedby": "mova-dica-cat" })),
        botao("Salvar categoria", { "data-mova": "classificar", "data-proposta": p.id })) : null,
      pode.decidir && p.tipo !== "BAIXA_DE_OBRIGACAO" ? el("small", { id: "mova-dica-cat", classe: "nota", texto: p.categoriaSugerida ? `Sugestão do MOVA: ${p.categoriaSugerida}. A sugestão nunca é aplicada sozinha.` : "O MOVA não sugeriu categoria." }) : null,
      pagamento && !confirmarBaixa && !motivo ? (contas.length
        ? el("label", { classe: "mova-campo" }, el("span", { texto: "Conta de onde saiu o pagamento" }),
          el("select", { "data-mova-conta": p.id }, el("option", { value: "", texto: "Escolha a conta…" }), contas.map((c) => el("option", { value: c.id, texto: c.nome }))))
        : el("p", { classe: "mova-alerta mova-alerta--alerta" }, cache.get("contas")?.ok
          ? ["Nenhuma conta ativa nesta unidade. Cadastre a conta em ", el("a", { href: "#/caixa-e-bancos", texto: "Caixa e Bancos" }), " para aprovar."]
          : ["Não foi possível carregar as contas da unidade. ", el("button", { type: "button", classe: "botao-link", "data-mova": "recarregar-contas", texto: "Tentar de novo" })])) : null,
      el("div", { classe: "mova-acoes" },
        competenciaAConfirmar(p) && pode.decidir ? botao("Informar competência", { "data-mova": "competencia", "data-proposta": p.id }, "primario") : null,
        confirmarBaixa ? botao("Confirmar baixa pelo extrato", { "data-mova": "confirmar-baixa", "data-proposta": p.id, disabled: !pode.decidir, title: "Vincula o pagamento à saída do extrato já conferida" }, "primario")
          : botao("Aprovar e lançar", { "data-mova": "aplicar", "data-proposta": p.id, disabled: Boolean(motivo), title: motivo ?? "Aplica no Financeiro pelos serviços oficiais" }, motivo ? "" : "primario"),
        botao("Rejeitar", { "data-mova": "rejeitar", "data-proposta": p.id, disabled: !pode.decidir }))) : null;
    return [p ? `${TIPO_PROPOSTA[p.tipo] ?? "Proposta"} · ${reais(p.valorCentavos)}` : "Mensagem recebida", [
      p ? el("div", { classe: "mova-gaveta-resumo" }, seloDe(ESTADO_PROPOSTA, p.estado), el("span", { classe: "nota", texto: `Proposta ${curto(p.id)}` })) : null,
      pend.length ? el("ul", { classe: "mova-pendencias" }, pend.map((t) => el("li", { texto: t }))) : null,
      decisao,
      el("h3", { texto: "Mensagem original" }),
      el("blockquote", { classe: "mova-mensagem" }, el("p", { texto: i.texto ?? "(sem texto)" }), el("footer", { classe: "nota" },
        `${i.participante?.nomeExibicao ?? "Sem nome"} (${i.participante?.referencia ?? "—"}) · ${horaBr(i.recebidoEm)} · `, el("span", { title: "O nome exibido no WhatsApp não é prova de identidade.", texto: "nome exibido" }))),
      i.documento ? el("div", { classe: "mova-arquivo" }, el("span", { classe: "mova-arquivo-icone", "aria-hidden": "true", texto: i.documento.mime === "application/pdf" ? "PDF" : "IMG" }),
        el("span", {}, el("strong", { texto: i.documento.nomeArquivo ?? (i.documento.mime === "application/pdf" ? "Documento PDF" : "Imagem") }), el("span", { classe: "nota", texto: ` · ${curto(i.documento.sha256)}…` })),
        pode.documentos ? botao("Abrir", { "data-mova": "arquivo", "data-sha": i.documento.sha256 }) : el("span", { classe: "nota", texto: "abrir exige permissão de documentos" })) : null,
      x ? [el("h3", { texto: "O que o MOVA leu" }), ficha([["Documento", TIPO_DOC[x.tipoDocumento] ?? x.tipoDocumento], ["Intenção", x.intencao ? INTENCAO[x.intencao] ?? x.intencao : undefined],
        ["Valor", x.valorCentavos != null ? reais(x.valorCentavos) : undefined], ["Pago em", x.dataPagamento ? dataBr(x.dataPagamento) : undefined], ["Emissão", x.dataEmissao ? dataBr(x.dataEmissao) : undefined],
        ["Vencimento", x.vencimento ? dataBr(x.vencimento) : undefined], ["Favorecido", x.favorecido ?? undefined], ["Confiança", x.confianca ?? undefined],
        ["Campos ausentes", x.camposAusentes?.length ? x.camposAusentes.join(", ") : undefined], ["Justificativa", x.justificativa ?? undefined]])] : null,
      p ? [el("h3", { texto: "Proposta" }), ficha([["Tipo", TIPO_PROPOSTA[p.tipo] ?? p.tipo], ["Valor", reais(p.valorCentavos)], ["Competência", competenciaDe(p) ?? selo(["A confirmar", "alerta"])],
        ["Caixa", p.datas?.caixa ? dataBr(p.datas.caixa) : undefined], ["Vencimento", p.datas?.vencimento ? dataBr(p.datas.vencimento) : undefined], ["Categoria sugerida", p.categoriaSugerida ?? "—"]])] : null,
      el("h3", { texto: "Histórico" }),
      el("ol", { classe: "mova-linha-tempo mova-linha-tempo--compacta" }, (i.decisoes ?? []).map((d) => el("li", {}, el("span", { classe: `mova-ponto mova-ponto--${(DECISAO[d.decisao] ?? [0, "neutro"])[1]}`, "aria-hidden": "true" }),
        el("div", {}, el("div", { classe: "mova-lt-topo" }, seloDe(DECISAO, d.decisao), el("time", { classe: "nota", datetime: d.em, texto: horaBr(d.em) })), el("code", { classe: "mova-codigo", texto: d.motivo }))))),
    ]];
  }

  // ---------- Operações
  function telaOperacoes() {
    const o = dado("operacoes") ?? { itens: [] }; const p = dado("politicas") ?? {}; const pc = dado("pagamentos-a-conciliar");
    const executadas = o.itens.filter((x) => x.estado === "EXECUTADA");
    return [
      el("div", { classe: "mova-kpis mova-kpis--3" },
        kpi("Operações executadas", executadas.length, reais(executadas.reduce((s, x) => s + (x.valorCentavos ?? 0), 0))),
        kpi("Aguardando conciliação", pc?.itens?.length ?? 0, "pagos por comprovante, sem o extrato ligado", { tom: pc?.itens?.length ? "info" : null }),
        kpi("Autonomia", p.autonomiaLigada ? "Ligada" : "Desligada", p.identidadeOperacional ? "identidade operacional implantada" : "sem identidade: tudo fica como proposta")),
      cartao("Lançado pelo MOVA", { sub: "Cada operação foi feita pelo serviço oficial do Financeiro. Se algo saiu errado, reverta: o pagamento é estornado e fica registrado na auditoria. Nenhum pagamento bancário é feito pelo MOVA." },
        o.itens.length ? tabela(["Quando", "Operação", "Nível", "=Valor", "Situação", ""], o.itens.map((x) => ({ id: x.id, celulas: [
          el("span", { classe: "mova-quando" }, el("strong", { texto: relativo(x.criadaEm ?? x.executadaEm) }), el("span", { classe: "nota", texto: horaBr(x.criadaEm ?? x.executadaEm) })),
          el("span", {}, OPERACAO[x.operacao] ?? x.operacao, x.resultado?.favorecido ? el("span", { classe: "nota", texto: x.resultado.favorecido }) : x.motivo ? el("code", { classe: "mova-codigo", texto: x.motivo }) : null),
          seloDe(NIVEL, x.nivel), el("span", { classe: "valor", texto: reais(x.valorCentavos) }), seloDe(ESTADO_OP, x.estado),
          el("span", { classe: "mova-acoes mova-acoes--fim" }, botao("Linha do tempo", { "data-mova": "linha-do-tempo", "data-proposta": x.propostaId }),
            x.estado === "EXECUTADA" && pode.cancelar ? botao("Reverter", { "data-mova": "reverter", "data-operacao": x.id, "data-valor": String(x.valorCentavos ?? ""), "data-rotulo": OPERACAO[x.operacao] ?? x.operacao }, "perigo") : null)] })), "Operações executadas")
          : vazio("Nenhuma operação executada nesta unidade.", "Com uma política de autonomia, o MOVA lança sozinho o que estiver dentro do limite.")),
      cartao("Pagos por comprovante — falta o extrato", { sub: "A conta já está paga pelo comprovante; falta ligar a saída do extrato à mesma baixa. Conciliar não cria outra saída, despesa ou baixa." },
        pc?.itens?.length ? tabela(["Pago em", "=Valor", "Situação", "Saída do extrato", ""], pc.itens.map((x) => ({ id: x.liquidacaoId, celulas: [
          dataBr(x.dataPagamento), el("span", { classe: "valor", texto: reais(x.valorCentavos) }), seloDe(SIT_A_CONCILIAR, x.situacao),
          x.candidatas.length === 1 ? `${dataBr(x.candidatas[0].data)} · ${reais(x.candidatas[0].valorCentavos)}` : x.candidatas.length ? `${x.candidatas.length} candidatas` : "—",
          x.situacao === "CANDIDATA_UNICA" && pc.podeConciliar ? botao("Conciliar", { "data-mova": "conciliar", "data-liquidacao": x.liquidacaoId, "data-movimentacao": x.candidatas[0].movimentacaoId, "data-versao": String(x.candidatas[0].versao) }, "primario") : "—"] })), "Pagos por comprovante")
          : vazio(pc?.disponivel === false ? "Indisponível nesta versão do Financeiro." : "Nenhum pagamento por comprovante aguardando conciliação.")),
    ];
  }
  function gavetaLinhaDoTempo(propostaId) {
    const lt = st.linhaDoTempo?.[propostaId];
    if (!lt) return ["Linha do tempo", [esqueleto()]];
    return ["Linha do tempo do documento", [
      el("p", { classe: "nota", texto: "Do recebimento no WhatsApp ao resultado no Financeiro." }),
      el("ol", { classe: "mova-etapas" }, lt.etapas.map((e) => el("li", { classe: `mova-etapa mova-etapa--${(SIT_ETAPA[e.situacao] ?? [0, "neutro"])[1]}` },
        el("span", { classe: "mova-etapa-marca", "aria-hidden": "true" }),
        el("div", {}, el("div", { classe: "mova-lt-topo" }, el("strong", { texto: ETAPA[e.etapa] ?? e.etapa }), seloDe(SIT_ETAPA, e.situacao)), e.detalhe ? el("p", { classe: "nota", texto: e.detalhe }) : null)))),
    ]];
  }

  // ---------- Conferência
  function telaConferencia() {
    const v = dado("conferencia");
    if (!v) return [vazio("Conferência indisponível.")];
    const i = v.indicadores; const ext = v.extratoDisponivel;
    const contagem = {};
    for (const p of v.pendencias) for (const m of p.motivos) contagem[m] = (contagem[m] ?? 0) + 1;
    const lista = st.conf.motivo ? v.pendencias.filter((p) => p.motivos.includes(st.conf.motivo)) : v.pendencias;
    const s = v.saidas;
    return [
      el("div", { classe: "mova-kpis" },
        kpi("Contas vencidas", i.contasVencidas, `saldo vencido ${reais(i.saldoVencidoCentavos)}`, { tom: i.contasVencidas ? "erro" : null }),
        kpi("Documentos faltando", i.documentosFaltantes, `${i.abertasSemDocumento} em aberto · ${i.pagasSemComprovante} pagas sem comprovante`),
        kpi("Possível pagamento no extrato", ext ? i.possiveisPagamentosNoExtrato : "—", ext ? `${reais(i.possiveisPagamentosCentavos)} · não confirmado` : "extrato indisponível", { tom: ext && i.possiveisPagamentosNoExtrato ? "alerta" : null }),
        kpi("Possíveis duplicidades", i.possiveisDuplicidades, "conferir antes de qualquer ajuste", { tom: i.possiveisDuplicidades ? "erro" : null })),
      el("details", { classe: "mova-mais" }, el("summary", { texto: "Mais indicadores" }), el("div", { classe: "mova-kpis" },
        kpi("Parcialmente pagas", i.contasParciais, `faltam ${reais(i.faltaParciaisCentavos)}`),
        kpi("Pagamentos aguardando conciliação", i.pagamentosAguardandoConciliacao, `${reais(i.pagamentosSemExtratoCentavos)} sem vínculo com o extrato`),
        kpi("Saídas do banco sem vínculo", ext ? i.saidasSemVinculo : "—", ext ? reais(i.saidasSemVinculoCentavos) : "extrato indisponível"),
        kpi("Sem fornecedor identificado", i.fornecedoresNaoIdentificados, reais(i.semFornecedorCentavos)),
        kpi("Documentos recebidos pelo MOVA", i.documentosRecebidosMova, `${i.documentosAguardandoConferencia} aguardando conferência`))),
      cartao("Pendências das contas a pagar", { classe: "mova-cartao--lista", sub: `Posição de ${dataBr(v.posicao)}. O que pede decisão humana vem primeiro, depois vencidas e maiores. Nada aqui baixa, cancela ou altera contas.` },
        el("div", { classe: "mova-chips", role: "group", "aria-label": "Filtrar por motivo" },
          el("button", { type: "button", classe: "mova-chip", "aria-pressed": String(!st.conf.motivo), "data-mova": "conf-motivo", "data-motivo": "" }, "Todas ", el("span", { texto: String(v.pendencias.length) })),
          Object.entries(MOTIVOS).filter(([m]) => contagem[m]).map(([m, [r, tom]]) => el("button", { type: "button", classe: `mova-chip mova-chip--${tom}`, "aria-pressed": String(st.conf.motivo === m), "data-mova": "conf-motivo", "data-motivo": m }, `${r} `, el("span", { texto: String(contagem[m]) })))),
        tabela(["Vencimento", "Fornecedor", "=Saldo", "Motivos", "Próxima ação"], lista.slice(0, LIMITE_LINHAS).map((p) => ({ id: p.id, celulas: [
          el("span", { classe: "mova-quando" }, el("strong", { texto: dataBr(p.vencimento) }), p.diasVencida ? el("span", { classe: "nota mova-atraso", texto: `vencida há ${p.diasVencida} ${p.diasVencida === 1 ? "dia" : "dias"}` }) : null),
          el("span", { classe: "mova-quem" }, el("strong", { texto: p.fornecedor ?? "Fornecedor não identificado" }), el("span", { classe: "nota mova-trecho", texto: texto(p.descricao) })),
          el("span", { classe: "valor", texto: reais(p.saldoCentavos) }),
          el("span", { classe: "mova-selos" }, p.motivos.map((m) => seloDe(MOTIVOS, m))), el("span", { classe: "nota", texto: p.proximaAcao })] })), "Pendências", { clicavel: true, classe: "mova-tabela--pendencias", selecionado: st.gaveta?.tipo === "pendencia" ? st.gaveta.id : null }),
        lista.length > LIMITE_LINHAS ? nota(`Mostrando ${LIMITE_LINHAS} de ${lista.length}. Use os filtros.`) : null),
      s ? cartao("Saídas do banco sem vínculo com conta a pagar", { sub: `${s.quantidade} saídas, ${reais(s.totalCentavos)}, de ${dataBr(s.de)} a ${dataBr(s.ate)}. Classificadas só pelo que os registros mostram; não são despesas nem pagamentos confirmados.` },
        tabela(["Motivo", "=Saídas", "=Total", ""], s.grupos.map((g) => ({ id: g.motivo, celulas: [g.rotulo, String(g.quantidade), el("span", { classe: "valor", texto: reais(g.totalCentavos) }),
          botao(st.conf.saida === g.motivo ? "Ocultar" : "Ver saídas", { "data-mova": "conf-saidas", "data-motivo": g.motivo, "aria-expanded": String(st.conf.saida === g.motivo) })] })), "Saídas por motivo"),
        st.conf.saida ? el("div", { classe: "mova-revelar" }, tabela(["Data", "Conta", "Descrição no extrato", "=Valor livre", "Evidência"], s.itens.filter((x) => x.motivo === st.conf.saida).slice(0, LIMITE_LINHAS)
          .map((x) => ({ id: x.id, celulas: [dataBr(x.data), texto(x.conta), texto(x.descricao), el("span", { classe: "valor", texto: reais(x.livreCentavos) }), x.evidencia] })), "Saídas do motivo")) : null)
        : cartao("Saídas do banco sem vínculo", {}, vazio("Extrato indisponível agora: nenhuma marca de pagamento no extrato foi calculada.")),
    ];
  }
  function gavetaPendencia(id) {
    const p = dado("conferencia")?.pendencias.find((x) => x.id === id);
    if (!p) return ["Pendência", [vazio("Esta pendência não está mais na lista.")]];
    return [p.fornecedor ?? "Fornecedor não identificado", [
      el("div", { classe: "mova-gaveta-resumo" }, el("span", { classe: "mova-selos" }, p.motivos.map((m) => seloDe(MOTIVOS, m)))),
      el("p", { classe: "mova-alerta mova-alerta--info" }, el("strong", { texto: "Próxima ação: " }), p.proximaAcao),
      ficha([["Descrição", texto(p.descricao)], ["Categoria", texto(p.categoria)], ["Competência", texto(p.competencia)], ["Vencimento", dataBr(p.vencimento)], ["Situação no Financeiro", texto(p.situacao)],
        ["Valor original", reais(p.valorCentavos)], ["Pago registrado", reais(p.pagoCentavos)], ["Saldo", reais(p.saldoCentavos)], ["Ajuste manual", p.ajustesCentavos ? reais(p.ajustesCentavos) : "nenhum"],
        ["Documento", texto(p.documental)], ["Conciliação", CONCILIACAO[p.conciliacao] ?? texto(p.conciliacao)]]),
      p.candidatas?.length ? [el("h3", { texto: "Saídas do extrato compatíveis" }), tabela(["Data", "Conta", "=Valor", "=Livre"], p.candidatas.map((s) => ({ id: s.id, celulas: [dataBr(s.data), texto(s.conta), reais(s.valorCentavos), reais(s.livreCentavos)] })), "Saídas compatíveis")] : null,
      p.duplicadas?.length ? [el("h3", { texto: "Contas parecidas" }), tabela(["Fornecedor", "Vencimento", "=Valor", "Situação"], p.duplicadas.map((d) => ({ id: d.id, celulas: [texto(d.fornecedor), dataBr(d.vencimento), reais(d.valorCentavos), texto(d.situacao)] })), "Contas parecidas")] : null,
      nota("Saída compatível e conta parecida são avisos para conferir com o documento. Nada foi baixado, vinculado ou cancelado."),
      el("p", {}, el("a", { classe: "botao botao--pequeno", href: "#/contas-a-pagar", texto: "Abrir Contas a Pagar" })),
    ]];
  }

  // ---------- Documentos
  function telaDocumentos() {
    const d = dado("documentos-recebidos");
    if (!d?.itens?.length) return [cartao("Documentos recebidos pelo WhatsApp", {}, vazio(d?.recebimentoDocumental === false ? "Recebimento de documentos desligado: nenhum documento é guardado." : "Nenhum documento recebido nesta unidade."))];
    const aguardando = d.itens.filter((x) => x.conferencia?.estado === "AGUARDANDO_CONFERENCIA").length;
    return [
      el("p", { classe: "nota mova-rodape", texto: `${d.itens.length} documento(s), ${aguardando} aguardando conferência. Revisado ou encaminhado não é pagamento, baixa nem conciliação: o vínculo com a conta continua em Contas a Pagar e Conciliação.` }),
      el("div", { classe: "mova-docs" }, d.itens.map((x) => {
        const rel = st.relacionadas.get(x.sha256);
        return el("article", { classe: "card mova-doc" },
          el("div", { classe: "mova-doc-topo" }, el("span", { classe: "mova-arquivo-icone", "aria-hidden": "true", texto: x.mime === "application/pdf" ? "PDF" : "IMG" }),
            el("div", { classe: "mova-doc-titulo" }, el("strong", { texto: TIPO_DOC_CONF[x.conferencia.tipo] ?? (x.mime === "application/pdf" ? "Documento PDF" : "Imagem") }), el("span", { classe: "nota", title: horaBr(x.recebidoEm), texto: `recebido ${relativo(x.recebidoEm)}` })),
            seloDe(ESTADO_DOC, x.conferencia.estado)),
          x.legenda ? el("blockquote", { classe: "mova-mensagem mova-mensagem--curta" }, el("p", { texto: x.legenda })) : null,
          ficha([["Remetente", `${x.remetente?.nome ?? "participante"} (${x.remetente?.id ?? "—"})`], ["Protocolo", texto(x.protocolo)], ["Arquivo", [x.nomeArquivo, `${Math.ceil((x.tamanhoBytes ?? 0) / 1024)} KB`].filter(Boolean).join(" · ")],
            ["Última conferência", x.conferencia.em ? `${horaBr(x.conferencia.em)}${x.conferencia.observacao ? ` — ${x.conferencia.observacao}` : ""}` : "—"]]),
          rel ? el("div", { classe: "mova-relacionadas" }, nota(rel.itens.length ? `Contas que podem se relacionar (busca: "${rel.busca || "legenda"}"). Sugestão: nada é vinculado.` : `Nenhuma conta encontrada para "${rel.busca || "a legenda"}".`),
            rel.itens.length ? el("label", { classe: "mova-campo" }, el("span", { texto: "Conta citada na conferência (opcional)" }), el("select", { "data-mova-conta-doc": x.sha256 }, el("option", { value: "", texto: "nenhuma" }),
              rel.itens.map((c) => el("option", { value: c.id, texto: `${dataBr(c.vencimento)} · ${c.fornecedor ?? "sem fornecedor"} · ${reais(c.saldoCentavos || c.valorCentavos)} · ${c.situacao}` })))) : null) : null,
          el("div", { classe: "mova-acoes" },
            x.arquivoRemovido ? el("span", { classe: "nota", texto: "arquivo removido pela retenção" }) : pode.documentos ? botao("Abrir original", { "data-mova": "arquivo", "data-sha": x.sha256 }) : null,
            botao("Contas relacionadas", { "data-mova": "doc-relacionadas", "data-sha": x.sha256 }),
            d.podeConferir ? botao("Marcar revisado", { "data-mova": "doc-conferir", "data-sha": x.sha256, "data-versao": String(x.conferencia.versao), "data-estado": "REVISADO", "data-tipo": x.conferencia.tipo ?? "" }) : null,
            d.podeConferir ? botao("Encaminhar ao Financeiro", { "data-mova": "doc-conferir", "data-sha": x.sha256, "data-versao": String(x.conferencia.versao), "data-estado": "ENCAMINHADO", "data-tipo": x.conferencia.tipo ?? "" }, "primario") : null));
      })),
    ];
  }

  // ---------- Configurações
  const subAbas = () => el("div", { classe: "mova-segmentos mova-segmentos--sub", role: "tablist", "aria-label": "Configurações do MOVA" },
    SUBSECOES_CONFIG.map((s) => el("button", { type: "button", role: "tab", classe: "mova-segmento", "aria-selected": String(st.sub === s.id), "data-mova": "sub", "data-sub": s.id, texto: s.rotulo })));
  function telaConfiguracoes() {
    const corpoSub = { funcionamento: cfgFuncionamento, autonomia: cfgAutonomia, automacoes: cfgAutomacoes, grupos: cfgGrupos, entregadores: cfgEntregadores, privacidade: cfgPrivacidade }[st.sub]();
    return [subAbas(), el("div", { classe: "mova-sub-corpo" }, corpoSub)];
  }
  function interruptor(rotulo, descricao, chave, ativo, { perigo = false, desabilitado = false } = {}) {
    return el("div", { classe: "mova-interruptor-linha" },
      el("div", {}, el("strong", { texto: rotulo }), el("p", { classe: "nota", texto: descricao })),
      el("button", { type: "button", role: "switch", classe: `mova-interruptor${perigo ? " mova-interruptor--perigo" : ""}`, "aria-checked": String(Boolean(ativo)), "aria-label": rotulo, disabled: desabilitado || !pode.configurar,
        title: pode.configurar ? (ativo ? "Desligar" : "Ligar") : "Exige permissão de configurar", "data-mova": "controle", "data-chave": chave, "data-valor": String(!ativo) }, el("span", { classe: "mova-interruptor-bola" })));
  }
  function cfgFuncionamento() {
    const e = dado("estado") ?? {}; const ctl = e.controle; const o = e.orcamentoIa; const erros = dado("erros")?.itens ?? []; const gerais = dado("falhas-gerais");
    const porEstado = (x) => Object.entries(x ?? {}).map(([k, n]) => `${k.toLowerCase()}: ${n}`).join(" · ") || "vazia";
    return [
      cartao("Interruptores", { sub: "Efeito imediato, sem reiniciar o WhatsApp. Cada etapa também precisa estar ligada no servidor; aqui só se desliga ou religa o que o servidor permite." },
        ctl ? el("div", { classe: "mova-interruptores" },
          interruptor("Recebimento", "Ler as mensagens dos grupos e conversas autorizados.", "recebimento", ctl.recebimento && !ctl.suspenso, { desabilitado: ctl.suspenso }),
          interruptor("Processamento", "Entender as mensagens e preparar propostas.", "processamento", ctl.processamento && !ctl.suspenso, { desabilitado: ctl.suspenso }),
          interruptor("Leitura por IA", "Ler comprovantes, boletos e notas.", "ia", ctl.ia && !ctl.suspenso, { desabilitado: ctl.suspenso }),
          interruptor("Envio de respostas", "Responder no WhatsApp.", "envio", ctl.envio && !ctl.suspenso, { desabilitado: ctl.suspenso }),
          el("div", { classe: `mova-interruptor-linha mova-interruptor-linha--geral${ctl.suspenso ? " suspenso" : ""}` },
            el("div", {}, el("strong", { texto: ctl.suspenso ? "MOVA suspenso" : "Suspensão geral" }), el("p", { classe: "nota", texto: ctl.suspenso ? "Nada é lido, processado ou respondido até retomar." : "Para tudo de uma vez, numa emergência." })),
            pode.configurar ? botao(ctl.suspenso ? "Retomar o MOVA" : "Suspender tudo agora", { "data-mova": "suspender", "data-valor": String(!ctl.suspenso) }, ctl.suspenso ? "primario" : "perigo") : null))
          : vazio("Controle indisponível.")),
      el("div", { classe: "mova-duas" },
        cartao("Orçamento da IA", {}, o ? [medidor(o.custoUsd, o.limiteUsd, `US$ ${o.custoUsd.toFixed(2)} de US$ ${o.limiteUsd.toFixed(2)}`), medidor(o.chamadas, o.limiteChamadas, `${o.chamadas} de ${o.limiteChamadas} chamadas`),
          nota(`Tokens: ${o.tokensEntrada} de entrada · ${o.tokensSaida} de saída.`)] : vazio("Sem dados de orçamento.")),
        cartao("Fila de mensagens", {}, ficha([["Por estado", porEstado(e.fila?.porEstado)], ["Pendente mais antigo", e.fila?.pendenteMaisAntigo ? horaBr(e.fila.pendenteMaisAntigo) : "—"],
          ["Respostas", porEstado(e.respostas)], ["Processador", e.worker ? `${e.worker.rodando ? "rodando" : "parado"}${e.worker.ultimaFalha ? ` · última falha: ${e.worker.ultimaFalha}` : ""}` : "não iniciado"]]))),
      cartao("Mensagens com falha", { sub: "Mensagens que o MOVA não conseguiu processar. Reprocessar tenta de novo sem duplicar nada." },
        erros.length ? tabela(["Evento", "=Tentativas", "Último erro", ""], erros.map((x) => ({ id: x.eventoId, celulas: [el("code", { classe: "mova-codigo", texto: x.eventoId }), String(x.tentativas), el("code", { classe: "mova-codigo", texto: x.ultimoErro ?? "—" }),
          pode.decidir ? botao("Reprocessar", { "data-mova": "reprocessar", "data-evento": x.eventoId }) : "—"] })), "Eventos com falha") : vazio("Nenhuma mensagem com falha.")),
      gerais ? cartao("Falhas sem unidade identificada", { sub: `${gerais.total} falha(s) · ${gerais.pendentes} pendente(s). Só identificadores técnicos: o conteúdo não é exibido.` },
        tabela(["Evento", "Tipo", "Código", "Quando", ""], gerais.itens.map((x) => ({ id: x.eventoId, celulas: [el("code", { classe: "mova-codigo", texto: x.eventoId }), x.tipo, el("code", { classe: "mova-codigo", texto: x.motivo }), horaBr(x.em),
          x.reprocessavel ? botao("Reprocessar", { "data-mova": "reprocessar", "data-evento": x.eventoId }) : "—"] })), "Falhas gerais")) : null,
    ];
  }
  function cfgAutonomia() {
    const p = dado("politicas") ?? { itens: [] };
    const vigentes = p.itens.filter((x) => !x.revogadaEm);
    return [
      cartao("Políticas de autonomia", { sub: "Sem política, o MOVA só propõe. Cada operação tem sua política e seu limite nesta unidade; acima do limite, pede confirmação. Juros e multas: além do limite, nunca mais de 10% da conta.",
        acoes: pode.configurar ? botao("Nova política", { "data-mova": "politica-nova" }, "primario") : null },
        el("div", { classe: "mova-grade-ficha" }, ficha([["Autonomia", ligado(p.autonomiaLigada, "Ligada", "Desligada")]]), ficha([["Identidade operacional", ligado(p.identidadeOperacional, "Implantada", "Não implantada")]])),
        p.itens.length ? tabela(["Operação", "Nível", "=Limite", "Vigência", "Responsável", ""], p.itens.map((x) => ({ id: x.id, classe: x.revogadaEm ? "estornada" : null, celulas: [
          el("span", {}, OPERACAO[x.operacao] ?? x.operacao, el("span", { classe: "nota", texto: x.unidadeId ? "esta unidade" : "todas da empresa" })),
          seloDe(NIVEL, x.nivel), el("span", { classe: "valor", texto: reais(x.limiteCentavos) }), `${dataBr(x.vigenteDe)}${x.vigenteAte ? ` a ${dataBr(x.vigenteAte)}` : ""}`, texto(x.responsavel),
          x.revogadaEm ? selo(["Revogada", "neutro"]) : pode.configurar ? botao("Revogar", { "data-mova": "politica-revogar", "data-politica": x.id, "data-rotulo": OPERACAO[x.operacao] ?? x.operacao }, "perigo") : "—"] })), "Políticas")
          : vazio("Nenhuma política: o MOVA só propõe."),
        nota(`${vigentes.length} política(s) vigente(s).`)),
    ];
  }
  function cfgAutomacoes() {
    const a = dado("automacoes") ?? { itens: [] };
    const porNome = new Map(a.itens.map((x) => [x.nome, x]));
    return [cartao("Automações da unidade", { sub: "Desligada ou pausada não envia nada. A pausa fica registrada na auditoria. O envio também depende do interruptor de respostas." },
      el("div", { classe: "mova-interruptores" }, Object.entries(AUTOMACOES).map(([nome, rotulo]) => {
        const x = porNome.get(nome);
        const situacao = !x || !x.ativa ? ["Desligada", "neutro"] : x.pausadaEm ? ["Pausada", "alerta"] : ["Ativa", "ok"];
        return el("div", { classe: "mova-interruptor-linha" },
          el("div", {}, el("strong", { texto: rotulo }), el("p", { classe: "nota" }, `${x?.horario ?? HORARIO_PADRAO[nome] ?? "09:00"} · última execução ${x?.ultimaExecucao ? relativo(x.ultimaExecucao) : "nunca"} · `, selo(situacao))),
          el("span", { classe: "mova-acoes" },
            x?.ativa && pode.configurar ? botao(x.pausadaEm ? "Retomar" : "Pausar", { "data-mova": "automacao-pausa", "data-nome": nome, "data-pausar": String(!x.pausadaEm) }) : null,
            el("button", { type: "button", role: "switch", classe: "mova-interruptor", "aria-checked": String(Boolean(x?.ativa)), "aria-label": rotulo, disabled: !pode.configurar,
              "data-mova": "automacao", "data-nome": nome, "data-ativa": String(!x?.ativa), "data-horario": x?.horario ?? HORARIO_PADRAO[nome] ?? "09:00" }, el("span", { classe: "mova-interruptor-bola" }))));
      })))];
  }
  function cfgGrupos() {
    const g = dado("grupos") ?? { itens: [] };
    if (!g.itens.length) return [cartao("Grupos e participantes", {}, vazio("Nenhuma conversa autorizada atende esta unidade."))];
    return g.itens.map((x) => cartao(`${x.tipo === "GRUPO" ? "Grupo" : x.tipo === "ENTREGADOR" ? "Privado de entregador" : "Conversa privada"} ${x.grupo}`, {},
      el("div", { classe: "mova-grade-ficha" }, ficha([["Acesso", texto(x.acesso)], ["Resposta com valores", x.politicaResposta ? POLITICA_RESPOSTA[x.politicaResposta] ?? x.politicaResposta : "nesta conversa"]]),
        ficha([["Unidades atendidas", String(x.unidades)], ["Membros conferidos", x.membros ? `${x.membros.total} · ${relativo(x.membros.verificadoEm)}` : x.tipo === "GRUPO" ? "sem retrato (valores nunca saem no grupo)" : "—"]])),
      x.membros?.naoAutorizados?.length ? el("p", { classe: "mova-alerta mova-alerta--alerta" }, el("strong", { texto: "Membros sem autorização: " }), x.membros.naoAutorizados.join(", "), ". O MOVA não responde a eles e valores não saem neste grupo.") : null,
      tabela(["Participante", "Nome", "Perfil", "Privado"], x.participantes.map((p, i) => ({ id: `${x.grupo}#${i}`, celulas: [el("code", { classe: "mova-codigo", texto: p.id }), texto(p.nome), p.perfil ?? "por unidade", p.privado ? "sim" : "—"] })), "Participantes autorizados")));
  }
  function cfgEntregadores() {
    const e = dado("entregadores") ?? { itens: [], notas: [], envios: [], cadastros: [] }; const of = dado("entregadores-oficiais");
    const ativos = new Set((e.cadastros ?? []).filter((x) => x.ativo).map((x) => x.chave));
    const livres = (of?.itens ?? []).filter((x) => !ativos.has(x.chave));
    return [
      cartao("Entregadores no WhatsApp", { sub: `Fluxo ${e.ligado ? "ligado" : "desligado"}. Fechamento, nota e liberação ficam em Entregadores Próprios; aqui só o que passou pelo WhatsApp.`,
        acoes: pode.configurar && livres.length ? botao("Cadastrar entregador", { "data-mova": "entregador-novo" }, "primario") : null },
        (e.cadastros ?? []).length ? tabela(["Entregador", "Telefone", "Situação", ""], e.cadastros.map((x) => ({ id: `${x.chave}|${x.criadoEm}`, classe: x.ativo ? null : "estornada", celulas: [texto(x.nome ?? x.chave), el("code", { classe: "mova-codigo", texto: x.telefone }),
          selo(x.ativo ? ["Ativo", "ok"] : ["Revogado", "neutro"]), x.ativo && pode.configurar ? botao("Revogar", { "data-mova": "entregador-revogar", "data-entregador": x.chave, "data-nome": x.nome ?? x.chave }, "perigo") : "—"] })), "Cadastros")
          : e.itens.length ? tabela(["Entregador", "Telefone", "Conversa"], e.itens.map((x) => ({ id: x.chave, celulas: [texto(x.nome ?? x.chave), el("code", { classe: "mova-codigo", texto: x.telefone }), x.conversa === "ATIVA" ? selo(["Ativa", "ok"]) : selo(["Número da equipe", "alerta"])] })), "Entregadores")
            : vazio("Nenhum entregador cadastrado para o WhatsApp nesta unidade.")),
      el("div", { classe: "mova-duas" },
        cartao("Notas recebidas", {}, e.notas.length ? tabela(["Recebida", "Entregador", "Semana", "Situação"], e.notas.map((n) => ({ id: n.id, celulas: [relativo(n.criadaEm), texto(n.entregador), dataBr(n.semanaInicio),
          el("span", { classe: "mova-selos" }, n.conferencia ? seloDe(CONFERENCIA_NOTA, n.conferencia) : null, selo(n.estado === "ANEXADA" ? ["Anexada", "ok"] : n.estado === "RECUSADA" ? ["Recusada", "erro"] : ["Pendente de anexo", "alerta"]))] })), "Notas") : vazio("Nenhuma nota recebida.")),
        cartao("Mensagens da rotina", {}, e.envios.length ? tabela(["Quando", "Entregador", "Tipo"], e.envios.map((x) => ({ id: `${x.chave}|${x.criadoEm}`, celulas: [relativo(x.criadoEm), texto(x.entregador), x.tipo === "SEMANAL" ? "Fechamento da semana" : x.tipo === "COBRANCA_NOTA" ? "Cobrança da nota" : texto(x.tipo)] })), "Envios") : vazio("Nenhuma mensagem enviada."))),
    ];
  }
  function cfgPrivacidade() {
    const itens = todosDaCaixa();
    const linhas = itens.flatMap((i) => (i.decisoes ?? []).map((d, k) => ({ id: `${i.eventoId}#${k}`, em: d.em, celulas: [horaBr(d.em), texto(i.participante?.nomeExibicao), seloDe(DECISAO, d.decisao), el("code", { classe: "mova-codigo", texto: d.motivo })] })))
      .sort((a, b) => String(b.em).localeCompare(String(a.em)));
    return [
      el("div", { classe: "mova-duas" },
        cartao("Quem pode o quê", {}, el("ul", { classe: "mova-lista" }, NIVEIS_DE_ACESSO.map(([n, t]) => el("li", {}, el("strong", { texto: n }), el("span", { classe: "nota", texto: t }))))),
        cartao("O que pode ser respondido no grupo", {}, el("div", { classe: "mova-privacidade" },
          el("div", {}, el("h3", { classe: "mova-h3-ok", texto: "Compartilhável" }), el("ul", { classe: "mova-lista mova-lista--ok" }, PRIVACIDADE.compartilhavel.map((t) => el("li", { texto: t })))),
          el("div", {}, el("h3", { classe: "mova-h3-erro", texto: "Só aqui no Financeiro" }), el("ul", { classe: "mova-lista mova-lista--erro" }, PRIVACIDADE.restrito.map((t) => el("li", { texto: t }))))))),
      cartao("Histórico de decisões do agente", { sub: "Cada decisão do MOVA fica gravada com o código do motivo (trilha só de inserção)." },
        tabela(["Quando", "Participante", "Decisão", "Motivo"], linhas.slice(0, 200), "Histórico de decisões")),
    ];
  }

  // ================================================================== desenho
  const TELAS = { visao: telaVisao, entrada: telaEntrada, operacoes: telaOperacoes, conferencia: telaConferencia, documentos: telaDocumentos, configuracoes: telaConfiguracoes };
  let geracao = 0;
  async function desenhar({ animar = false } = {}) {
    const minha = ++geracao;
    raiz.dataset.movaSecao = st.secao;
    desenharAbas();
    const chaves = chavesDaTela();
    const faltam = chaves.filter((k) => { const c = cache.get(k); return !c || c.carregando; });
    if (faltam.length) {
      if (!corpo.querySelector(".mova-esqueleto") || animar) corpo.replaceChildren(...(st.secao === "configuracoes" ? [subAbas()] : []), esqueleto());
      await Promise.all(chaves.map(obter));
      if (minha !== geracao) return;
      animar = true;
    }
    const falha = chaves.map((k) => [k, cache.get(k)]).find(([k, c]) => c && !c.ok && !OPCIONAIS.has(k));
    let conteudo;
    if (falha) {
      const [, c] = falha;
      conteudo = [el("div", { classe: "estado estado--erro" }, el("p", { texto: c.codigo === "MOVA_DESLIGADO" ? "O MOVA está desligado neste ambiente." : "Não foi possível carregar esta seção." }),
        el("p", { classe: "estado-detalhe", texto: c.codigo === "MOVA_DESLIGADO" ? "Nenhuma mensagem do WhatsApp é lida e nenhuma proposta é criada." : c.erro }),
        el("div", { classe: "estado-acoes" }, botao("Tentar novamente", { "data-mova": "tentar" }, "primario")))];
    } else conteudo = TELAS[st.secao]().flat(Infinity).filter(Boolean);
    const rolagem = window.scrollY;
    corpo.replaceChildren(...conteudo);
    if (animar && !reduzirMovimento()) {
      corpo.classList.remove("mova-entrar"); void corpo.offsetWidth; corpo.classList.add("mova-entrar");
      [...corpo.children].forEach((c, i) => c.style.setProperty("--i", String(Math.min(i, 8))));
      contarNumeros(corpo);
    } else window.scrollTo({ top: rolagem });
    desenharStatus(); atualizarContador(); desenharGaveta();
  }

  // ================================================================== ações
  const corpoErro = (r) => r?.mensagem ?? r?.dados?.mensagem ?? "A ação não foi concluída.";
  async function acaoNoServidor(b, chamada, { sucesso, recarregar: chaves = [] } = {}) {
    const rot = b?.textContent; if (b) { b.disabled = true; b.classList.add("botao--ocupado"); }
    const r = await chamada();
    if (b?.isConnected) { b.disabled = false; b.classList.remove("botao--ocupado"); b.textContent = rot; }
    if (r.ok) { avisar(sucesso ?? "Feito."); recarregar(...chaves); await desenhar(); } else avisar(`Não foi possível: ${corpoErro(r)}`, false);
    return r;
  }
  async function lerVersao(propostaId) {
    const d = await ler(`/api/fv2/mova/proposta?id=${encodeURIComponent(propostaId)}`);
    return d.ok ? d.dados.versao : null;
  }
  async function agir(b) {
    const a = b.dataset.mova;
    switch (a) {
      case "fechar-gaveta": return fecharGaveta();
      case "tentar": recarregar(); return desenhar({ animar: true });
      case "recarregar-contas": recarregar("contas"); await obter("contas"); return desenharGaveta();
      case "filtro": st.filtro = b.dataset.filtro; fecharGaveta(); return desenhar();
      case "sub": st.sub = b.dataset.sub; return desenhar({ animar: true });
      case "conf-motivo": st.conf.motivo = b.dataset.motivo || null; return desenhar();
      case "conf-saidas": st.conf.saida = st.conf.saida === b.dataset.motivo ? null : b.dataset.motivo; return desenhar();
      case "arquivo": {
        const d = await ler(`/api/fv2/mova/arquivo?sha=${encodeURIComponent(b.dataset.sha)}`);
        if (!d.ok) return avisar(`Documento indisponível: ${corpoErro(d)}`, false);
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(d.dados.base64), (c) => c.charCodeAt(0))], { type: d.dados.mime }));
        globalThis.open?.(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      case "aplicar": {
        const id = b.dataset.proposta;
        const conta = gaveta.querySelector(`[data-mova-conta="${id}"]`);
        const p = todosDaCaixa().find((x) => x.proposta?.id === id)?.proposta;
        if (!conta && p && ["BAIXA_DE_OBRIGACAO", "DESPESA_PAGA"].includes(p.tipo)) return avisar("Sem a conta do pagamento não dá para aprovar.", false);
        if (conta && !conta.value) { conta.focus(); conta.setAttribute("aria-invalid", "true"); return avisar("Escolha a conta de onde saiu o pagamento.", false); }
        const r = await acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/aplicar", { propostaId: id, ...(conta?.value ? { contaId: conta.value } : {}) }), { sucesso: "Proposta aprovada e lançada no Financeiro.", recarregar: ["caixa", "visao-geral", "operacoes"] });
        if (r.ok) fecharGaveta();
        return;
      }
      case "rejeitar": {
        const v = await perguntar({ titulo: "Rejeitar a proposta?", texto: "Nada é lançado no Financeiro. O motivo fica no histórico da proposta.", campos: [{ nome: "motivo", rotulo: "Motivo da rejeição", tipo: "textarea", obrigatorio: true, min: 3 }], confirmar: "Rejeitar", perigo: true });
        if (!v) return;
        const r = await acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/rejeitar", { propostaId: b.dataset.proposta, motivo: v.motivo.trim() }), { sucesso: "Proposta rejeitada.", recarregar: ["caixa", "visao-geral"] });
        if (r.ok) fecharGaveta();
        return;
      }
      case "classificar": {
        const id = b.dataset.proposta;
        const cat = gaveta.querySelector(`[data-mova-categoria="${id}"]`)?.value?.trim().toUpperCase();
        if (!cat) return avisar("Informe o código da categoria.", false);
        return acaoNoServidor(b, async () => { const versao = await lerVersao(id); return versao === null ? { ok: false, mensagem: "Proposta indisponível." } : enviar("/api/fv2/acoes/mova/classificar", { propostaId: id, versao, categoria: cat }); },
          { sucesso: "Categoria salva: será usada ao aprovar.", recarregar: ["caixa"] });
      }
      case "competencia": {
        const v = await perguntar({ titulo: "Competência da despesa", texto: "O mês a que a despesa pertence (não a data do pagamento).", campos: [{ nome: "competencia", rotulo: "Competência", tipo: "month", obrigatorio: true }], confirmar: "Salvar" });
        if (!v) return;
        const id = b.dataset.proposta;
        return acaoNoServidor(b, async () => { const versao = await lerVersao(id); return versao === null ? { ok: false, mensagem: "Proposta indisponível." } : enviar("/api/fv2/acoes/mova/competencia", { propostaId: id, versao, competencia: v.competencia }); },
          { sucesso: "Competência informada: será usada ao aprovar.", recarregar: ["caixa"] });
      }
      case "confirmar-baixa": {
        const r = await acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/confirmar-baixa-extrato", { propostaId: b.dataset.proposta }), { sucesso: "Baixa confirmada pelo extrato.", recarregar: ["caixa", "operacoes", "visao-geral"] });
        if (r.ok) fecharGaveta();
        return;
      }
      case "linha-do-tempo": {
        const id = b.dataset.proposta;
        st.linhaDoTempo = { ...(st.linhaDoTempo ?? {}) };
        delete st.linhaDoTempo[id];
        abrirGaveta({ tipo: "linha-do-tempo", id });
        const x = await ler(`/api/fv2/mova/linha-do-tempo?proposta=${encodeURIComponent(id)}`);
        if (!x.ok) { fecharGaveta(); return avisar(`Linha do tempo indisponível: ${corpoErro(x)}`, false); }
        st.linhaDoTempo[id] = x.dados;
        return desenharGaveta();
      }
      case "reverter": {
        const v = await perguntar({ titulo: "Reverter esta operação?",
          texto: `${b.dataset.rotulo ?? "Operação"} de ${reais(Number(b.dataset.valor) || null)}. O pagamento é estornado pelo serviço oficial do Financeiro e a reversão fica na auditoria. A conta continua no Contas a Pagar — cancele-a lá se ela também não deveria existir.`,
          campos: [{ nome: "justificativa", rotulo: "Justificativa", tipo: "textarea", obrigatorio: true, min: 10, dica: "Ex.: compra de outra loja, lançada por engano nesta unidade." }], confirmar: "Reverter", perigo: true });
        if (!v) return;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/reverter-operacao", { operacaoId: b.dataset.operacao, justificativa: v.justificativa.trim() }),
          { sucesso: "Operação revertida: pagamento estornado.", recarregar: ["operacoes", "visao-geral", "pagamentos-a-conciliar"] });
      }
      case "conciliar":
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/conciliar-comprovante", { liquidacaoId: b.dataset.liquidacao, movimentacaoId: b.dataset.movimentacao, versaoMovimentacao: Number(b.dataset.versao) }),
          { sucesso: "Conciliado com o extrato (mesma baixa; nada novo foi lançado).", recarregar: ["pagamentos-a-conciliar", "operacoes"] });
      case "doc-relacionadas": {
        const v = await perguntar({ titulo: "Contas relacionadas", texto: "Busque por fornecedor ou valor. Vazio usa a legenda do documento. É só sugestão: nada é vinculado.", campos: [{ nome: "busca", rotulo: "Buscar", dica: "fornecedor ou valor" }], confirmar: "Buscar" });
        if (!v) return;
        const sha = b.dataset.sha; const busca = (v.busca ?? "").trim();
        const x = await ler(`/api/fv2/mova/documento-relacionadas?sha=${encodeURIComponent(sha)}${busca ? `&busca=${encodeURIComponent(busca)}` : ""}`);
        if (!x.ok) return avisar(`Busca indisponível: ${corpoErro(x)}`, false);
        st.relacionadas.set(sha, x.dados);
        avisar(`${x.dados.itens.length} conta(s) que podem se relacionar.`);
        return desenhar();
      }
      case "doc-conferir": {
        const encaminhar = b.dataset.estado === "ENCAMINHADO";
        const v = await perguntar({ titulo: encaminhar ? "Encaminhar ao Financeiro" : "Marcar como revisado", texto: "Não é baixa nem conciliação: o vínculo com a conta continua no fluxo oficial.",
          campos: [{ nome: "tipo", rotulo: "Tipo do documento", tipo: "select", valor: b.dataset.tipo || "", opcoes: [["", "não informado"], ...Object.entries(TIPO_DOC_CONF)] },
            { nome: "observacao", rotulo: encaminhar ? "Observação para o Financeiro (opcional)" : "Observação (opcional)", tipo: "textarea" }], confirmar: encaminhar ? "Encaminhar" : "Marcar revisado" });
        if (!v) return;
        const sha = b.dataset.sha;
        const obrigacaoId = corpo.querySelector(`[data-mova-conta-doc="${sha}"]`)?.value || null;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/documento-conferir", { sha256: sha, versao: Number(b.dataset.versao), estado: b.dataset.estado, ...(v.tipo ? { tipo: v.tipo } : {}),
          ...(obrigacaoId ? { obrigacaoId } : {}), ...(v.observacao?.trim() ? { observacao: v.observacao.trim().slice(0, 500) } : {}) }),
        { sucesso: encaminhar ? "Encaminhado ao Financeiro." : "Marcado como revisado.", recarregar: ["documentos-recebidos"] });
      }
      case "reprocessar":
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/reprocessar", { eventoId: b.dataset.evento }), { sucesso: "Mensagem enviada para reprocessar.", recarregar: ["erros", "falhas-gerais", "estado"] });
      case "controle":
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/controle", { [b.dataset.chave]: b.dataset.valor === "true", motivo: "Financeiro — MOVA" }), { sucesso: "Interruptor atualizado.", recarregar: ["estado"] });
      case "suspender": {
        const suspender = b.dataset.valor === "true";
        if (suspender) {
          const v = await perguntar({ titulo: "Suspender o MOVA agora?", texto: "Nada será lido, processado ou respondido no WhatsApp até alguém retomar. As mensagens que chegarem ficam guardadas na fila.", confirmar: "Suspender tudo", perigo: true });
          if (!v) return;
        }
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/controle", { suspenso: suspender, motivo: "Financeiro — MOVA" }), { sucesso: suspender ? "MOVA suspenso." : "MOVA retomado.", recarregar: ["estado"] });
      }
      case "politica-nova": {
        const v = await perguntar({ titulo: "Nova política de autonomia", texto: "Vale só para esta unidade. Acima do limite, o MOVA pede confirmação.",
          campos: [{ nome: "operacao", rotulo: "Operação", tipo: "select", obrigatorio: true, opcoes: Object.entries(OPERACAO).filter(([k]) => k !== "PRESTACAO_DE_SANGRIA") },
            { nome: "nivel", rotulo: "Nível", tipo: "select", obrigatorio: true, opcoes: Object.entries(NIVEL).map(([k, [r]]) => [k, r]) },
            { nome: "limite", rotulo: "Limite (R$)", obrigatorio: true, inputmode: "decimal", dica: "20.000,00" },
            { nome: "responsavel", rotulo: "Responsável", obrigatorio: true, max: 120 },
            { nome: "motivo", rotulo: "Motivo", tipo: "textarea", obrigatorio: true, min: 10 },
            { nome: "vigenteDe", rotulo: "Vigente a partir de", tipo: "date", obrigatorio: true, valor: new Date().toISOString().slice(0, 10) }], confirmar: "Criar política" });
        if (!v) return;
        const limite = Math.round(Number(String(v.limite).replace(/\./g, "").replace(",", ".")) * 100);
        if (!Number.isSafeInteger(limite) || limite < 0) return avisar("Limite inválido.", false);
        if (!sessao.unidadeId) return avisar("Unidade da sessão indisponível.", false);
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/politica", { operacao: v.operacao, unidadeId: sessao.unidadeId, nivel: v.nivel, limiteCentavos: limite, responsavel: v.responsavel, motivo: v.motivo, vigenteDe: v.vigenteDe }),
          { sucesso: "Política criada.", recarregar: ["politicas"] });
      }
      case "politica-revogar": {
        const v = await perguntar({ titulo: "Revogar a política?", texto: `${b.dataset.rotulo}: o MOVA volta a só propor essa operação nesta unidade.`, confirmar: "Revogar", perigo: true });
        if (!v) return;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/politica-revogar", { politicaId: b.dataset.politica }), { sucesso: "Política revogada.", recarregar: ["politicas"] });
      }
      case "automacao":
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/automacao", { nome: b.dataset.nome, ativa: b.dataset.ativa === "true", horario: b.dataset.horario }), { sucesso: "Automação atualizada.", recarregar: ["automacoes"] });
      case "automacao-pausa": {
        const pausar = b.dataset.pausar === "true";
        const v = pausar ? await perguntar({ titulo: "Pausar a automação?", campos: [{ nome: "motivo", rotulo: "Motivo (opcional)", tipo: "textarea" }], confirmar: "Pausar" }) : {};
        if (!v) return;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/automacao-pausa", { nome: b.dataset.nome, pausar, ...(v.motivo?.trim() ? { motivo: v.motivo.trim() } : {}) }), { sucesso: pausar ? "Automação pausada." : "Automação retomada.", recarregar: ["automacoes"] });
      }
      case "entregador-novo": {
        const ativos = new Set((dado("entregadores")?.cadastros ?? []).filter((x) => x.ativo).map((x) => x.chave));
        const livres = (dado("entregadores-oficiais")?.itens ?? []).filter((x) => !ativos.has(x.chave));
        const v = await perguntar({ titulo: "Cadastrar entregador", texto: "Passa a valer quando o MOVA reiniciar; antes do primeiro envio o número é conferido no próprio WhatsApp.",
          campos: [{ nome: "entregador", rotulo: "Entregador", tipo: "select", obrigatorio: true, opcoes: livres.map((x) => [x.chave, x.nome]) }, { nome: "telefone", rotulo: "WhatsApp", tipo: "tel", obrigatorio: true, dica: "(85) 9XXXX-XXXX" }], confirmar: "Cadastrar" });
        if (!v) return;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/entregador", { entregador: v.entregador, telefone: v.telefone }), { sucesso: "Entregador cadastrado.", recarregar: ["entregadores"] });
      }
      case "entregador-revogar": {
        const v = await perguntar({ titulo: `Revogar ${b.dataset.nome}?`, texto: "O entregador deixa de receber mensagens do MOVA. O histórico fica.", confirmar: "Revogar", perigo: true });
        if (!v) return;
        return acaoNoServidor(b, () => enviar("/api/fv2/acoes/mova/entregador-revogar", { entregador: b.dataset.entregador }), { sucesso: "Cadastro revogado.", recarregar: ["entregadores"] });
      }
      default: return undefined;
    }
  }

  // ---------- eventos (todos presos à raiz: somem junto com ela)
  raiz.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mova]");
    if (b && raiz.contains(b) && !b.disabled) { e.preventDefault(); agir(b); return; }
    const tr = e.target.closest("tr[data-mova-linha]");
    if (tr) abrirGaveta({ tipo: st.secao === "conferencia" ? "pendencia" : "item", id: tr.dataset.movaLinha });
  });
  raiz.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.gaveta && !dialogo.open) { e.stopPropagation(); fecharGaveta(); return; }
    const tr = e.target.closest?.("tr[data-mova-linha]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); abrirGaveta({ tipo: st.secao === "conferencia" ? "pendencia" : "item", id: tr.dataset.movaLinha }); return; }
    if (tr && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); (e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
  });
  let tempoBusca = null;
  raiz.addEventListener("input", (e) => {
    if (!e.target.matches?.("[data-mova-busca]")) return;
    st.busca = e.target.value;
    clearTimeout(tempoBusca);
    tempoBusca = setTimeout(async () => { await desenhar(); const i = corpo.querySelector("[data-mova-busca]"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 180);
  });
  raiz.addEventListener("submit", (e) => { if (raiz.contains(e.target) && !dialogo.contains(e.target)) e.preventDefault(); });

  // ---------- início
  const inicial = new URLSearchParams(String(location.hash.split("?")[1] ?? ""));
  if (FILTROS_ENTRADA.some((f) => f.id === inicial.get("filtro"))) st.filtro = inicial.get("filtro");
  if (SUBSECOES_CONFIG.some((s) => s.id === inicial.get("aba"))) st.sub = inicial.get("aba");
  Promise.all([obter("estado"), obter("caixa")]).then(() => { desenharStatus(); atualizarContador(); });
  desenhar({ animar: true });

  return Object.freeze({
    /** Troca de seção sem refazer a estrutura (as leituras já feitas são reaproveitadas). */
    irPara(secaoNova, busca = "") {
      const s = secaoValida(secaoNova);
      const p = new URLSearchParams(busca);
      if (FILTROS_ENTRADA.some((f) => f.id === p.get("filtro"))) st.filtro = p.get("filtro");
      if (SUBSECOES_CONFIG.some((x) => x.id === p.get("aba"))) st.sub = p.get("aba");
      if (s === st.secao) return desenhar();
      fecharGaveta();
      st.secao = s;
      corpo.focus({ preventScroll: true });
      return desenhar({ animar: true });
    },
    atualizar() { recarregar(); return desenhar({ animar: true }); },
    get raiz() { return raiz; },
  });
}
