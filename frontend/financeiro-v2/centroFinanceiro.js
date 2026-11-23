// Centro Financeiro (Módulo Administrativo) — MOVA, Execuções 02 e 03. Fora do menu de produção.
// Execução 03: lê a API REAL do MOVA quando ela existe (centroFinanceiroDados.js); sem API, cai nos dados sintéticos com a faixa
// "Simulação"; com o MOVA desligado no servidor, mostra esse estado. Aprovar/Rejeitar chamam a API (o servidor confere tudo).
// Os dados vêm de centroFinanceiroSimulacao.js, no MESMO formato de criarConsultasPostgres().caixaDeEntrada() do backend
// ({ itens, aguardandoUnidade }, cada item com participante, documento, dadosExtraidos, proposta e decisoes). A rota autenticada
// que serviria esses dados ainda NÃO existe (Execução 03): por isso a faixa "Simulação" é permanente e Aprovar/Rejeitar ficam
// desligados com o motivo exposto. Contas a Pagar/Receber e Conciliação levam às telas existentes (nada duplicado).
// Todo texto vindo de dados entra por textContent (nunca innerHTML): a mensagem original é entrada não confiável.
import { acoes, carregarDados, lerApi } from "./centroFinanceiroDados.js";
import { enviar } from "./consulta.js";
import { ABAS_CENTRAL, criarCentral } from "./centralMova.js";

const ABAS = [
  ABAS_CENTRAL[0],
  { id: "processamento", rotulo: "Processamento" },
  { id: "visao", rotulo: "Visão Operacional" },
  { id: "entrada", rotulo: "Caixa de Entrada MOVA" },
  { id: "propostas", rotulo: "Propostas e Aprovações" },
  { id: "pagar", rotulo: "Contas a Pagar", ligacao: "index.html#/contas-a-pagar" },
  { id: "receber", rotulo: "Contas a Receber", ligacao: "index.html#/contas-a-receber" },
  { id: "conciliacao", rotulo: "Conciliação", ligacao: "index.html#/conferencias" },
  ...ABAS_CENTRAL.slice(1),
  { id: "historico", rotulo: "Histórico do Agente" },
  { id: "config", rotulo: "Configurações MOVA" },
];
const DECISAO = { PROPOSTA: ["Proposta criada", "info"], PEDIR_INFORMACAO: ["Aguardando informação", "alerta"], DUPLICADO: ["Duplicado", "neutro"], BLOQUEADO: ["Bloqueado", "erro"], IGNORADO: ["Ignorado", "neutro"], FALHA_LEITURA: ["Falha de leitura", "alerta"], CONSULTA: ["Consulta", "info"], ORIENTACAO: ["Orientação", "neutro"], RELACIONADA: ["Esclarecimento", "info"] };
const ESTADO = { AGUARDANDO_REVISAO: ["Aguardando revisão", "alerta"], APLICANDO: ["Aplicando", "info"], APLICADA: ["Aplicada", "ok"], REJEITADA: ["Rejeitada", "neutro"] };
const TIPO_PROPOSTA = { DESPESA_PAGA: "Despesa paga", NOVA_OBRIGACAO: "Nova conta a pagar", BAIXA_DE_OBRIGACAO: "Baixa de conta existente", SOLICITACAO_DE_REVISAO: "Pedido de revisão", VINCULO_DE_DOCUMENTO: "Nota de conta já registrada" };
const INTENCAO_LIDA = { INFORMAR_PAGAMENTO: "Pagamento feito", REGISTRAR_CONTA: "Conta a pagar", CONSULTAR: "Consulta", INFORMAR_TRANSFERENCIA: "Transferência", PEDIR_CORRECAO: "Pedido de correção", PEDIR_CLASSIFICACAO: "Pedido de classificação", OUTRA: "Outra", DESCONHECIDA: "Não identificada" };
/** 15A (V-3): decisão de duplicidade aponta a proposta original (só o id; mesma unidade, filtrado no servidor). */
/** 15A: competência nunca presumida — sem ela (e sem revisão), não dá para aplicar. */
const competenciaAConfirmar = (p) => Boolean(p?.competenciaPendente && !p?.competenciaRevisada && p?.estado === "AGUARDANDO_REVISAO");
const competenciaDe = (p) => p?.competenciaRevisada ?? p?.datas?.competencia ?? null;
const duplicadoDe = (i) => [...(i.decisoes ?? [])].reverse().find((d) => d.decisao === "DUPLICADO" && d.propostaId)?.propostaId ?? null;
const TIPO_DOC = { COMPROVANTE_PAGAMENTO: "Comprovante", BOLETO: "Boleto", NOTA_FISCAL: "Nota fiscal", RECIBO: "Recibo", EXTRATO: "Extrato", RELATORIO_VENDAS: "Relatório de vendas", OUTRO: "Outro", DESCONHECIDO: "Não identificado" };
const PENDENCIA = { REQUISITOS_FINANCEIROS_INCOMPLETOS: "Cadastro financeiro da unidade incompleto: aplicação bloqueada" };

const estado = { aba: "entrada", unidadeId: null, selecionado: null, aviso: null };
let dados = null;

function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "classe") n.className = v; else if (k === "texto") n.textContent = v; else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return n;
}
const reais = (c) => (typeof c === "number" ? (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—");
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const horaBr = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const selo = ([texto, tom]) => el("span", { classe: `cf-selo cf-selo--${tom}`, texto });
const seloDecisao = (d) => selo(DECISAO[d] ?? [d, "neutro"]);
const unidade = () => dados.unidades.find((u) => u.unidadeId === estado.unidadeId);
const caixa = () => dados.caixaPorUnidade[estado.unidadeId] ?? { itens: [], aguardandoUnidade: [] };
const PAGAMENTO = ["BAIXA_DE_OBRIGACAO", "DESPESA_PAGA"];
const todosItens = () => [...caixa().itens, ...caixa().aguardandoUnidade];
const ultimaDecisao = (i) => i.decisoes.at(-1) ?? null;

const cartao = (titulo, ...corpo) => el("section", { classe: "cf-cartao" }, el("h2", { texto: titulo }), ...corpo);
const vazio = (texto) => el("p", { classe: "cf-vazio", texto });
const dl = (pares) => el("dl", { classe: "cf-dl" }, pares.filter(([, v]) => v !== undefined).map(([k, v]) => [el("dt", { texto: k }), el("dd", {}, v ?? "—")]));

function tabela(cabecalhos, linhas, legenda, aoSelecionar) {
  if (linhas.length === 0) return vazio("Nada por aqui nesta unidade.");
  return el("div", { classe: "cf-tabela-rolagem" }, el("table", { classe: "cf-tabela" },
    el("caption", { classe: "cf-oculto", texto: legenda }),
    el("thead", {}, el("tr", {}, cabecalhos.map((c) => el("th", { scope: "col", texto: c })))),
    el("tbody", {}, linhas.map(({ id, celulas }) => {
      const tr = el("tr", aoSelecionar ? { classe: estado.selecionado === id ? "cf-linha cf-linha--sel" : "cf-linha", tabindex: "0", "data-id": id, "aria-selected": String(estado.selecionado === id) } : {}, celulas.map((c) => el("td", {}, c)));
      return tr;
    })),
  ));
}

function pendenciasDe(i) {
  const p = [];
  const u = ultimaDecisao(i);
  if (u?.decisao === "PEDIR_INFORMACAO") p.push(u.motivo === "UNIDADE_NAO_IDENTIFICADA" || u.motivo === "UNIDADE_CONFLITANTE" ? "Aguardando o participante informar a unidade no grupo" : "Aguardando informação do participante");
  if (i.proposta?.bloqueioDeAplicacao) p.push(PENDENCIA[i.proposta.bloqueioDeAplicacao] ?? i.proposta.bloqueioDeAplicacao);
  if (i.proposta?.sinaisDeInjecao) p.push("Mensagem com texto suspeito: revisar com atenção");
  if (competenciaAConfirmar(i.proposta)) p.push("Competência a confirmar na revisão (não foi informada na mensagem)");
  return p;
}

// ------------------------------------------------------------------ detalhe do item (documento + proposta)
function detalhe(i) {
  if (!i) return cartao("Detalhe", vazio("Selecione uma mensagem para ver o documento, os dados extraídos e a proposta."));
  const x = i.dadosExtraidos;
  const p = i.proposta;
  const pend = pendenciasDe(i);
  return el("aside", { classe: "cf-cartao cf-detalhe", "aria-label": "Detalhe da mensagem" },
    el("h2", { texto: "Detalhe" }),
    el("h3", { texto: "Mensagem original" }),
    el("blockquote", { classe: "cf-mensagem", texto: i.texto ?? "(sem texto)" }),
    dl([
      ["Recebida", horaBr(i.recebidoEm)], ["Origem", "WhatsApp · MOVA"], ["Tipo", i.tipo],
      ["Participante", el("span", {}, `${i.participante.nomeExibicao ?? "Sem nome"} (${i.participante.referencia ?? "—"})`, el("span", { classe: "cf-dica cf-quebra", texto: "Nome exibido no WhatsApp: não é prova de identidade." }))],
      ["Unidade", i.proposta || ultimaDecisao(i)?.decisao !== "PEDIR_INFORMACAO" ? unidade().nome : selo(["Não identificada", "alerta"])],
    ]),
    el("h3", { texto: "Documento" }),
    i.documento ? dl([["Formato", i.documento.mime], ["Arquivo", i.documento.nomeArquivo ?? "—"], ["Impressão (sha256)", el("code", { texto: `${i.documento.sha256.slice(0, 16)}…` })]]) : vazio("Mensagem sem documento."),
    i.documento ? (dados.fonte === "API" && dados.podeAbrirDocumentos
      ? el("p", {}, el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "arquivo", "data-sha": i.documento.sha256, texto: "Abrir documento" }))
      : el("p", { classe: "cf-dica", texto: dados.fonte === "API" ? "Abrir o arquivo exige a permissão de documentos." : "Abrir o arquivo: só no ambiente com a API do MOVA." })) : null,
    el("h3", { texto: "Dados extraídos" }),
    x ? dl([["Tipo documental", TIPO_DOC[x.tipoDocumento] ?? x.tipoDocumento], ["Intenção lida", x.intencao ? (INTENCAO_LIDA[x.intencao] ?? x.intencao) : undefined], ["Valor", x.valorCentavos != null ? reais(x.valorCentavos) : undefined], ["Pagamento", x.dataPagamento ? dataBr(x.dataPagamento) : undefined], ["Emissão", x.dataEmissao ? dataBr(x.dataEmissao) : undefined], ["Vencimento", x.vencimento ? dataBr(x.vencimento) : undefined], ["Favorecido", x.favorecido], ["Confiança da leitura", x.confianca],
      ["Justificativa da IA", x.justificativa ?? undefined], ["Campos ausentes", x.camposAusentes?.length ? x.camposAusentes.join(", ") : undefined]])
      : vazio("Sem dados extraídos (texto puro, ou ainda aguardando esclarecimento)."),
    x?.fonte === "PROPOSTA" ? el("p", { classe: "cf-dica", texto: "Mensagem só de texto: leitura registrada junto da proposta." }) : null,
    el("h3", { texto: "Proposta" }),
    !p && duplicadoDe(i) ? el("p", {}, "Duplicado da proposta ", el("code", { texto: duplicadoDe(i).slice(0, 8) }), " (nenhuma proposta nova foi criada).") : null,
    p ? dl([["Proposta", el("code", { texto: p.id.slice(0, 8) })], ["Tipo", TIPO_PROPOSTA[p.tipo] ?? p.tipo], ["Situação", selo(ESTADO[p.estado] ?? [p.estado, "neutro"])], ["Valor", reais(p.valorCentavos)],
      ["Competência", competenciaDe(p) ?? selo(["A confirmar", "alerta"])], ["Caixa", p.datas?.caixa ? dataBr(p.datas.caixa) : undefined], ["Vencimento", p.datas?.vencimento ? dataBr(p.datas.vencimento) : undefined],
      ["Categoria sugerida", p.categoriaSugerida ?? "—"]]) : duplicadoDe(i) ? null : vazio("Nenhuma proposta vinculada."),
    p ? el("p", { classe: "cf-dica", texto: "A categoria sugerida não é aplicada sozinha: quem aprova escolhe a categoria definitiva." }) : null,
    el("h3", { texto: "Pendências" }),
    pend.length ? el("ul", { classe: "cf-lista" }, pend.map((t) => el("li", { texto: t }))) : vazio("Nenhuma."),
    el("h3", { texto: "Histórico de decisões" }),
    el("ol", { classe: "cf-lista" }, i.decisoes.map((d) => el("li", {}, horaBr(d.em), " · ", seloDecisao(d.decisao), " ", el("code", { texto: d.motivo })))),
  );
}

// ------------------------------------------------------------------ abas
function visao() {
  const itens = caixa().itens;
  const props = itens.map((i) => i.proposta).filter(Boolean);
  const u = unidade();
  const kpi = (rotulo, valor, dica) => el("div", { classe: "cf-kpi" }, el("span", { classe: "cf-kpi-rotulo", texto: rotulo }), el("strong", { classe: "cf-kpi-valor", texto: valor }), dica ? el("span", { classe: "cf-dica", texto: dica }) : null);
  return [
    el("div", { classe: "cf-kpis" },
      kpi("Propostas aguardando revisão", String(props.filter((p) => p.estado === "AGUARDANDO_REVISAO").length)),
      kpi("Valor aguardando revisão", reais(props.filter((p) => p.estado === "AGUARDANDO_REVISAO").reduce((s, p) => s + (p.valorCentavos ?? 0), 0)), "Nada lançado: só proposto"),
      kpi("Mensagens recebidas", String(itens.length)),
      kpi("Aguardando unidade", String(caixa().aguardandoUnidade.length), "Perguntas feitas no grupo"),
    ),
    !u.requisitosCompletos ? el("p", { classe: "cf-aviso cf-aviso--alerta" }, el("strong", { texto: "Cadastro financeiro incompleto. " }), "O MOVA recebe documentos e prepara propostas desta unidade, mas nenhuma pode ser aplicada até as fontes de faturamento serem confirmadas no Financeiro.") : null,
    cartao("Fontes de faturamento da unidade",
      !u.fontes ? el("p", {}, "Fontes de faturamento: ver Configurações do Financeiro (cadastro da unidade).")
      : u.fontes.situacao === "CONFIRMADA"
        ? el("ul", { classe: "cf-lista" }, Object.entries(u.fontes.canais).map(([canal, fonte]) => el("li", {}, el("strong", { texto: `${canal}: ` }), fonte)))
        : el("p", {}, "Fontes ", el("strong", { texto: "a confirmar" }), ". Nenhuma fonte é presumida."),
      el("p", { classe: "cf-dica", texto: "iFood e 99Food entram só pela fonte oficial da plataforma; o pedido no PDV serve apenas para conferência." })),
  ];
}

function entrada() {
  const linhas = todosItens().map((i) => {
    const u = ultimaDecisao(i);
    const x = i.dadosExtraidos;
    return { id: i.eventoId, celulas: [
      horaBr(i.recebidoEm),
      caixa().aguardandoUnidade.includes(i) ? selo(["Unidade não identificada", "alerta"]) : unidade().nome,
      i.participante.nomeExibicao ?? i.participante.referencia ?? "—",
      x ? TIPO_DOC[x.tipoDocumento] ?? x.tipoDocumento : i.tipo,
      el("span", { classe: "cf-num", texto: reais(x?.valorCentavos ?? i.proposta?.valorCentavos ?? null) }),
      u ? seloDecisao(u.decisao) : "—",
      i.proposta ? selo(ESTADO[i.proposta.estado] ?? [i.proposta.estado, "neutro"]) : "—",
    ] };
  });
  const sel = todosItens().find((i) => i.eventoId === estado.selecionado) ?? null;
  return [el("div", { classe: "cf-dupla" },
    cartao("Caixa de Entrada MOVA",
      el("p", { classe: "cf-dica", texto: "Mensagens do grupo atribuídas a esta unidade e as que ainda aguardam a unidade. Selecione uma linha para ver o detalhe." }),
      tabela(["Quando", "Unidade", "Participante", "Documento", "Valor", "Processamento", "Proposta"], linhas, "Mensagens recebidas pelo MOVA", true)),
    detalhe(sel))];
}

function propostas() {
  const linhas = caixa().itens.filter((i) => i.proposta).map((i) => {
    const p = i.proposta;
    const motivo = p.bloqueioDeAplicacao ? PENDENCIA[p.bloqueioDeAplicacao]
      : dados.fonte !== "API" ? "Simulação: aprovação só no ambiente com a API do MOVA"
      : !dados.podeDecidir ? "Sua sessão não tem permissão para aprovar e aplicar (ou a escrita está desligada)"
      : p.estado !== "AGUARDANDO_REVISAO" ? "Proposta já decidida"
      : competenciaAConfirmar(p) ? "Informe a competência antes de aprovar" : null;
    const precisaConta = PAGAMENTO.includes(p.tipo) && !motivo;
    return { id: i.eventoId, celulas: [
      el("code", { texto: p.id.slice(0, 8) }), TIPO_PROPOSTA[p.tipo] ?? p.tipo, el("span", { classe: "cf-num", texto: reais(p.valorCentavos) }),
      `Competência ${competenciaDe(p) ?? "a confirmar"}${p.datas?.caixa ? ` · caixa ${dataBr(p.datas.caixa)}` : p.datas?.vencimento ? ` · vence ${dataBr(p.datas.vencimento)}` : ""}`,
      el("span", {}, p.categoriaSugerida ? `Sugestão: ${p.categoriaSugerida}` : "—",
        dados.podeDecidir && p.estado === "AGUARDANDO_REVISAO" && p.tipo !== "BAIXA_DE_OBRIGACAO"
          ? el("span", { classe: "cf-quebra" }, el("input", { classe: "cf-categoria", "data-categoria": p.id, "aria-label": "Categoria (código)", placeholder: "CODIGO_DA_CATEGORIA", value: p.categoriaSugerida ?? "" }),
            el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "classificar", "data-proposta": p.id, texto: "Revisar categoria" }))
          : null),
      selo(ESTADO[p.estado] ?? [p.estado, "neutro"]),
      el("div", { classe: "cf-acoes" },
        competenciaAConfirmar(p) && dados.podeDecidir && dados.fonte === "API"
          ? el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "competencia", "data-proposta": p.id, texto: "Informar competência" }) : null,
        precisaConta ? el("select", { classe: "cf-conta", "data-conta": p.id, "aria-label": "Conta de onde saiu o pagamento" }, el("option", { value: "", texto: "Conta do pagamento…" }), dados.contas.map((c) => el("option", { value: c.id, texto: c.nome }))) : null,
        // Frente C: baixa conferida com o extrato ⇒ confirma a saída que JÁ existe (nunca "Aprovar", que criaria outra saída).
        p.tipo === "BAIXA_DE_OBRIGACAO" && p.conciliacao?.situacao === "CONFERIDA" && p.estado === "AGUARDANDO_REVISAO"
          ? el("button", { classe: "botao botao--pequeno botao--primario", type: "button", disabled: dados.fonte !== "API" || !dados.podeDecidir, title: "Vincular o pagamento à saída do extrato já conferida", "data-acao": "central-confirmar-baixa", "data-proposta": p.id, texto: "Confirmar baixa pelo extrato" }) :
        el("button", { classe: "botao botao--pequeno botao--primario", type: "button", disabled: Boolean(motivo), title: motivo ?? "Aprovar e aplicar no Financeiro", "data-acao": "aplicar", "data-proposta": p.id, "aria-label": motivo ? `Aprovar (indisponível: ${motivo})` : "Aprovar e aplicar", texto: "Aprovar" }),
        el("button", { classe: "botao botao--pequeno", type: "button", disabled: Boolean(motivo && p.estado !== "AGUARDANDO_REVISAO") || dados.fonte !== "API" || !dados.podeDecidir, title: "Rejeitar a proposta", "data-acao": "rejeitar", "data-proposta": p.id, texto: "Rejeitar" })),
    ] };
  });
  return [cartao("Propostas e Aprovações",
    el("p", { classe: "cf-aviso", texto: "O MOVA só PROPÕE. Aprovar aplica no Financeiro pelos serviços oficiais (permissões aprovar + aplicar + registrar), revalidando competência, saldo e duplicidade na hora. Comprovante não concilia extrato: a conciliação continua na Conciliação." }),
    estado.aviso ? el("p", { classe: `cf-aviso${estado.aviso.ok ? "" : " cf-aviso--alerta"}`, role: "status", texto: estado.aviso.texto }) : null,
    tabela(["Proposta", "Tipo", "Valor", "Datas", "Classificação", "Situação", "Ações"], linhas, "Propostas do MOVA"))];
}

function ligacao(aba) {
  return [cartao(aba.rotulo,
    el("p", { texto: `${aba.rotulo} continua na tela que já existe no Financeiro — sem cópia aqui, para não haver dois lugares com números diferentes.` }),
    el("p", {}, el("a", { classe: "botao botao--primario", href: aba.ligacao, texto: `Abrir ${aba.rotulo}` })),
    el("p", { classe: "cf-dica", texto: aba.id === "pagar" ? "Comprovante de conta já cadastrada vira proposta de BAIXA dessa conta — nunca uma despesa nova." : aba.id === "conciliacao" ? "O comprovante enviado no grupo não concilia o extrato: a conciliação continua sendo feita aqui." : "As propostas do MOVA só aparecem aqui depois de aplicadas." }))];
}

function historico() {
  const linhas = todosItens().flatMap((i) => i.decisoes.map((d, k) => ({ id: `${i.eventoId}#${k}`, celulas: [horaBr(d.em), i.participante.nomeExibicao ?? "—", seloDecisao(d.decisao), el("code", { texto: d.motivo })] })))
    .sort((a, b) => String(b.celulas[0]).localeCompare(String(a.celulas[0])));
  return [cartao("Histórico do Agente", el("p", { classe: "cf-dica", texto: "Cada decisão do MOVA fica gravada com o código do motivo (trilha só de inserção no banco)." }), tabela(["Quando", "Participante", "Decisão", "Motivo"], linhas, "Histórico de decisões do MOVA"))];
}

function config() {
  const c = dados.configuracao;
  return [
    cartao("Situação", el("ul", { classe: "cf-lista" }, el("li", {}, el("strong", { texto: "Fonte dos dados: " }), selo(dados.fonte === "API" ? ["Financeiro (API)", "ok"] : ["Simulação", "alerta"])), el("li", {}, el("strong", { texto: "Canal: " }), c.canal))),
    c.grupos ? cartao("Grupos autorizados", tabela(["Grupo", "Unidades atendidas", "Leitura"], c.grupos.map((g) => ({ id: g.rotulo, celulas: [g.rotulo, g.unidades.map((id) => dados.unidades.find((u) => u.unidadeId === id).nome).join(", "), selo(["Desligada", "neutro"])] })), "Grupos autorizados")) : null,
    dados.estadoMova ? cartao("Processamento", dl([
      ["Recebimento do grupo", selo(dados.estadoMova.chaves?.recebimento ? ["Ligado", "ok"] : ["Desligado", "neutro"])],
      ["IA", selo(dados.estadoMova.chaves?.ia ? ["Ligada", "ok"] : ["Desligada", "neutro"])],
      ["Envio de respostas", selo(dados.estadoMova.envioHabilitado ? ["Ligado", "ok"] : ["Desligado", "neutro"])],
      ["Fila", Object.entries(dados.estadoMova.fila?.porEstado ?? {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "vazia"],
      ["Respostas", Object.entries(dados.estadoMova.respostas ?? {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "nenhuma"],
    ])) : null,
    cartao("Quem pode o quê", el("ul", { classe: "cf-lista" }, c.niveis.map((n) => el("li", {}, el("strong", { texto: `${n.nivel}: ` }), n.pode)))),
    cartao("O que pode ser respondido no grupo",
      el("div", { classe: "cf-dupla cf-dupla--igual" },
        el("div", {}, el("h3", { texto: "Compartilhável" }), el("ul", { classe: "cf-lista" }, c.privacidade.compartilhavel.map((t) => el("li", { texto: t })))),
        el("div", {}, el("h3", { texto: "Só no Centro Financeiro" }), el("ul", { classe: "cf-lista" }, c.privacidade.restrito.map((t) => el("li", { texto: t })))))),
  ];
}

function processamento() {
  if (dados.fonte !== "API") return [cartao("Processamento", el("p", { texto: "Disponível só no ambiente com a API do MOVA." }))];
  const e = dados.estadoMova ?? {};
  const o = e.orcamentoIa;
  const ctl = e.controle;
  const chave = (k, rotulo) => el("li", {}, el("strong", { texto: `${rotulo}: ` }), selo(ctl && !ctl.suspenso && ctl[k] ? ["Ligado", "ok"] : ["Desligado", "neutro"]),
    dados.podeConfigurar && ctl ? el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "controle", "data-chave": k, "data-valor": String(!(ctl[k])), texto: ctl[k] ? "Desligar" : "Ligar" }) : null);
  return [
    estado.aviso ? el("p", { classe: `cf-aviso${estado.aviso.ok ? "" : " cf-aviso--alerta"}`, role: "status", texto: estado.aviso.texto }) : null,
    cartao("Interruptores (efeito imediato, sem reiniciar o WhatsApp)",
      ctl ? el("ul", { classe: "cf-lista" }, chave("recebimento", "Recebimento"), chave("processamento", "Processamento"), chave("ia", "IA"), chave("envio", "Envio de respostas"),
        el("li", {}, el("strong", { texto: "Suspensão geral: " }), selo(ctl.suspenso ? ["SUSPENSO", "erro"] : ["Não", "neutro"]),
          dados.podeConfigurar ? el("button", { classe: `botao botao--pequeno${ctl.suspenso ? "" : " botao--perigo"}`, type: "button", "data-acao": "controle", "data-chave": "suspenso", "data-valor": String(!ctl.suspenso), texto: ctl.suspenso ? "Retomar" : "Suspender tudo agora" }) : null))
        : el("p", { texto: "Controle indisponível." }),
      el("p", { classe: "cf-dica", texto: "Cada etapa também precisa estar ligada na configuração do servidor; aqui só se desliga ou religa o que o servidor permite." })),
    cartao("Orçamento da IA", o ? dl([["Chamadas", `${o.chamadas} de ${o.limiteChamadas}`], ["Custo estimado", `US$ ${o.custoUsd.toFixed(2)} de US$ ${o.limiteUsd.toFixed(2)}`], ["Tokens", `${o.tokensEntrada} entrada · ${o.tokensSaida} saída`]]) : el("p", { texto: "Sem dados de orçamento." })),
    cartao("Fila", dl([["Por estado", Object.entries(e.fila?.porEstado ?? {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "vazia"], ["Pendente mais antigo", e.fila?.pendenteMaisAntigo ? horaBr(e.fila.pendenteMaisAntigo) : "—"], ["Respostas", Object.entries(e.respostas ?? {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "nenhuma"], ["Worker", e.worker ? `${e.worker.rodando ? "rodando" : "parado"}; última falha: ${e.worker.ultimaFalha ?? "nenhuma"}` : "não iniciado"]])),
    dados.falhasGerais ? cartao("Falhas gerais (sem unidade identificada)",
      el("p", { classe: "cf-dica", texto: `${dados.falhasGerais.total} falha(s) · ${Object.entries(dados.falhasGerais.porTipo).map(([k, n]) => `${k}: ${n}`).join(" · ") || "nenhuma"} · ${dados.falhasGerais.pendentes} pendente(s) de processamento. Só identificadores técnicos: o conteúdo não é exibido.` }),
      tabela(["Evento", "Tipo", "Código", "Quando", "Estado", ""], dados.falhasGerais.itens.map((x) => ({ id: x.eventoId, celulas: [el("code", { texto: x.eventoId }), x.tipo, el("code", { texto: x.motivo }), horaBr(x.em), `${x.estado} (${x.tentativas})`,
        x.reprocessavel ? el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "reprocessar", "data-evento": x.eventoId, texto: "Reprocessar" }) : "—"] })), "Falhas gerais")) : null,
    cartao("Erros", tabela(["Evento", "Tentativas", "Último erro", ""], dados.erros.map((x) => ({ id: x.eventoId, celulas: [el("code", { texto: x.eventoId }), String(x.tentativas), el("code", { texto: x.ultimoErro ?? "—" }),
      dados.podeDecidir ? el("button", { classe: "botao botao--pequeno", type: "button", "data-acao": "reprocessar", "data-evento": x.eventoId, texto: "Reprocessar" }) : "—"] })), "Eventos com falha")),
  ];
}

const DESENHOS = { visao, entrada, propostas, historico, config, processamento };
const ui = { el: (...a) => el(...a), cartao: (...a) => cartao(...a), tabela: (...a) => tabela(...a), selo: (x) => selo(x), reais: (c) => reais(c), horaBr: (d) => horaBr(d), dataBr: (d) => dataBr(d), vazio: (t) => vazio(t), dl: (p) => dl(p) };
const central = criarCentral({ ui, ler: (u) => lerApi(u), enviar });

function desenharIndisponivel(alvo) {
  const texto = dados.fonte === "MOVA_DESLIGADO" ? "O MOVA está desligado neste ambiente. Nenhuma mensagem do WhatsApp é lida e nenhuma proposta é criada." : dados.mensagem ?? "Não foi possível carregar o Centro Financeiro.";
  alvo.replaceChildren(cartao(dados.fonte === "MOVA_DESLIGADO" ? "MOVA desligado" : "Indisponível", el("p", { texto })));
}

function desenhar() {
  const alvo = document.getElementById("cf-conteudo");
  if (!["API", "SIMULACAO"].includes(dados.fonte)) return desenharIndisponivel(alvo);
  const aba = ABAS.find((a) => a.id === estado.aba);
  for (const b of document.querySelectorAll("[role=tab]")) b.setAttribute("aria-selected", String(b.dataset.aba === estado.aba));
  const corpo = aba.ligacao ? ligacao(aba)
    : ABAS_CENTRAL.some((x) => x.id === aba.id) ? [estado.aviso ? el("p", { classe: `cf-aviso${estado.aviso.ok ? "" : " cf-aviso--alerta"}`, role: "status", texto: estado.aviso.texto }) : null,
      ...central.desenhar(aba.id, { fonte: dados.fonte, permissoes: dados.permissoes ?? [], unidadeId: estado.unidadeId, redesenhar: () => { if (estado.aba === aba.id) desenhar(); } })]
    : DESENHOS[aba.id]();
  alvo.replaceChildren(el("h2", { classe: "cf-oculto", texto: aba.rotulo }), ...corpo.filter(Boolean));
  alvo.setAttribute("aria-labelledby", `cf-aba-${aba.id}`);
}

function selecionar(id) { estado.selecionado = id; desenhar(); document.querySelector(`.cf-detalhe`)?.scrollIntoView?.({ block: "nearest" }); }

async function decidir(botao) {
  const id = botao.dataset.proposta;
  let r;
  if (botao.dataset.acao?.startsWith("central-")) {
    botao.disabled = true;
    const a = await central.agir(botao);
    botao.disabled = false;
    if (!a) return;
    estado.aviso = a;
    if (botao.dataset.acao === "central-confirmar-baixa") dados = await carregarDados();
    return desenhar();
  }
  if (botao.dataset.acao === "arquivo") {
    const a = await acoes.arquivo(botao.dataset.sha);
    if (!a.ok) { estado.aviso = { ok: false, texto: a.mensagem }; return desenhar(); }
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0))], { type: a.mime }));
    globalThis.open?.(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  if (botao.dataset.acao === "competencia") {
    const c = globalThis.prompt?.("Competência (AAAA-MM) — o mês a que a despesa pertence:")?.trim() ?? "";
    if (!c) return;
    r = await acoes.competencia(id, c);
    estado.aviso = r.ok ? { ok: true, texto: "Competência informada (será usada na aplicação)." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
    dados = await carregarDados(); return desenhar();
  }
  if (botao.dataset.acao === "classificar") {
    const cat = document.querySelector(`[data-categoria="${id}"]`)?.value?.trim().toUpperCase();
    r = await acoes.classificar(id, cat);
    estado.aviso = r.ok ? { ok: true, texto: "Categoria revisada (será usada na aplicação)." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
    dados = await carregarDados(); return desenhar();
  }
  if (botao.dataset.acao === "reprocessar" || botao.dataset.acao === "controle") {
    r = botao.dataset.acao === "reprocessar" ? await acoes.reprocessar(botao.dataset.evento) : await acoes.controle({ [botao.dataset.chave]: botao.dataset.valor === "true", motivo: "Centro Financeiro" });
    estado.aviso = r.ok ? { ok: true, texto: "Feito." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
    dados = await carregarDados(); return desenhar();
  }
  if (botao.dataset.acao === "aplicar") {
    const conta = document.querySelector(`[data-conta="${id}"]`);
    if (conta && !conta.value) { estado.aviso = { ok: false, texto: "Escolha a conta de onde saiu o pagamento." }; return desenhar(); }
    botao.disabled = true;
    r = await acoes.aplicar(id, conta?.value || null);
  } else {
    const motivo = globalThis.prompt?.("Motivo da rejeição (fica no histórico):") ?? null;
    if (!motivo) return;
    r = await acoes.rejeitar(id, motivo);
  }
  estado.aviso = r.ok ? { ok: true, texto: botao.dataset.acao === "aplicar" ? "Proposta aplicada no Financeiro." : "Proposta rejeitada." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
  dados = await carregarDados();
  desenhar();
}

async function iniciar() {
  dados = await carregarDados();
  const faixa = document.querySelector(".cf-simulacao");
  if (dados.homologacao) {
    // Ambiente de HOMOLOGAÇÃO: faixa permanente — nada aqui é registro financeiro oficial.
    faixa.hidden = false; faixa.classList.add("cf-homologacao");
    faixa.replaceChildren(el("strong", { texto: "HOMOLOGAÇÃO" }), " · registros de teste do MOVA · não são lançamentos financeiros oficiais");
  } else if (dados.fonte !== "SIMULACAO") faixa.hidden = true;
  if (!dados.unidades) { desenhar(); return; }
  estado.unidadeId = dados.unidades[0].unidadeId;
  const sel = document.getElementById("cf-unidade");
  sel.replaceChildren(...dados.unidades.map((u) => el("option", { value: u.unidadeId, texto: u.requisitosCompletos ? u.nome : `${u.nome} (cadastro incompleto)` })));
  sel.value = estado.unidadeId;
  if (dados.fonte === "API") sel.disabled = true; // a unidade é a da sessão da plataforma
  sel.addEventListener("change", () => { estado.unidadeId = sel.value; estado.selecionado = null; desenhar(); });
  const lista = document.getElementById("cf-abas");
  lista.replaceChildren(...ABAS.map((a) => el("li", { role: "presentation" }, el("button", { type: "button", role: "tab", id: `cf-aba-${a.id}`, "data-aba": a.id, "aria-controls": "cf-conteudo", texto: a.rotulo }))));
  lista.addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) { estado.aba = b.dataset.aba; desenhar(); } });
  lista.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    const i = ABAS.findIndex((a) => a.id === estado.aba);
    estado.aba = ABAS[(i + (e.key === "ArrowRight" ? 1 : ABAS.length - 1)) % ABAS.length].id;
    desenhar(); document.getElementById(`cf-aba-${estado.aba}`).focus();
  });
  const conteudo = document.getElementById("cf-conteudo");
  conteudo.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-acao]");
    if (b && !b.disabled) { decidir(b); return; }
    const tr = e.target.closest("tr[data-id]"); if (tr && estado.aba === "entrada") selecionar(tr.dataset.id);
  });
  conteudo.addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && estado.aba === "entrada" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selecionar(tr.dataset.id); } });
  desenhar();
}

iniciar();
