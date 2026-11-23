// Central de Operações MOVA (Agente 2 — Frente E): abas que evoluem o Centro Financeiro sobre as APIs REAIS do MOVA.
// Regras: só números que o servidor devolve (contagens do banco do MOVA da unidade da sessão) — nenhum indicador estimado
// ou simulado; sem a API real a aba diz isso. Identificadores chegam mascarados. Todo texto entra por textContent.
// As ações só ENVIAM ao servidor, que confere permissão, unidade e estado de novo.

export const ABAS_CENTRAL = Object.freeze([
  { id: "central", rotulo: "Visão Geral MOVA" },
  { id: "conferencia", rotulo: "Conferência Financeira" },
  { id: "documentos", rotulo: "Documentos Recebidos" },
  { id: "grupos", rotulo: "Grupos e Participantes" },
  { id: "operacoes", rotulo: "Operações Financeiras" },
  { id: "entregadores", rotulo: "Entregadores" },
  { id: "automacoes", rotulo: "Automações" },
  { id: "seguranca", rotulo: "Segurança e Autonomia" },
]);
const ROTAS = { central: ["visao-geral"], conferencia: ["conferencia"], documentos: ["documentos-recebidos"], grupos: ["grupos"], operacoes: ["operacoes", "politicas", "pagamentos-a-conciliar"], entregadores: ["entregadores"], automacoes: ["automacoes"], seguranca: ["politicas"] };
const AUTOMACOES = { ENTREGADORES_SEMANAL: "Mensagem de segunda aos entregadores", ENTREGADORES_COBRANCA: "Cobrança da nota fiscal" };
const NIVEL = { SOMENTE_PROPOR: ["Só propor", "neutro"], APLICAR_COM_CONFIRMACAO: ["Com confirmação", "alerta"], APLICAR_AUTOMATICO: ["Automático", "info"] };
const ESTADO_OP = { EXECUTANDO: ["Executando", "info"], EXECUTADA: ["Executada", "ok"], FALHOU: ["Falhou", "erro"], REVERTIDA: ["Revertida", "neutro"] };
const POLITICA = { PRIVADO_RESTRITO: "Privado restrito", GRUPO_FINANCEIRO: "Grupo financeiro", OPERACIONAL: "Operacional (sem valores)" };
// Conferência financeira: rótulos fixos (o servidor manda os códigos). "Possível" é sempre aviso para conferir, nunca confirmação.
const MOTIVOS = { POSSIVEL_DUPLICIDADE: ["Possível duplicidade", "erro"], POSSIVEL_PAGAMENTO_NO_EXTRATO: ["Possível pagamento no extrato (não confirmado)", "alerta"],
  SAIDAS_COMPATIVEIS_AMBIGUAS: ["Várias saídas compatíveis", "alerta"], AJUSTE_MANUAL: ["Ajuste manual", "alerta"], VENCIDA: ["Vencida", "erro"],
  FORNECEDOR_NAO_IDENTIFICADO: ["Sem fornecedor", "alerta"], PARCIAL: ["Parcial", "info"], PAGAMENTO_SEM_EXTRATO: ["Pagamento sem extrato", "info"],
  PAGA_SEM_COMPROVANTE: ["Paga sem comprovante", "neutro"], SEM_DOCUMENTO: ["Sem documento", "neutro"] };
const CONCILIACAO = { SEM_PAGAMENTO_REGISTRADO: "Sem pagamento registrado", POSSIVEL_PAGAMENTO_NO_EXTRATO_NAO_CONFIRMADO: "Possível pagamento no extrato (NÃO confirmado)",
  SAIDAS_COMPATIVEIS_AMBIGUAS: "Várias saídas compatíveis", EXTRATO_INDISPONIVEL: "Extrato indisponível", PAGAMENTO_REGISTRADO_SEM_EXTRATO: "Pagamento sem vínculo com o extrato",
  PAGAMENTO_CONCILIADO: "Pagamento vinculado ao extrato" };
const DOCUMENTAL = { COM_DOCUMENTO: "Com documento", SEM_DOCUMENTO: "Sem documento", PAGA_SEM_COMPROVANTE: "Paga sem comprovante" };
const ORIGEM = { MANUAL: "Lançamento manual", IMPORTACAO: "Importação", PLANILHA: "Planilha" };
const ESTADO_DOC = { AGUARDANDO_CONFERENCIA: ["Aguardando conferência", "alerta"], REVISADO: ["Revisado", "ok"], ENCAMINHADO: ["Encaminhado ao Financeiro", "info"] };
const TIPO_DOC = { COMPROVANTE: "Comprovante", BOLETO: "Boleto", NOTA_FISCAL: "Nota fiscal", RECIBO: "Recibo", OUTRO: "Outro" };
const LIMITE_LINHAS = 80;
const ETAPA = { RECEBIMENTO: "Recebimento", EXTRACAO: "Extração", IDENTIFICACAO: "Identificação", CLASSIFICACAO: "Classificação", OBRIGACAO: "Obrigação",
  PAGAMENTO: "Pagamento", EXTRATO: "Extrato", CONCILIACAO: "Conciliação", RESULTADO: "Resultado" };
const SIT_ETAPA = { FEITO: ["Feito", "ok"], PENDENTE: ["Pendente", "alerta"], BLOQUEADO: ["Bloqueado", "erro"], NAO_SE_APLICA: ["Não se aplica", "neutro"] };

/**
 * @param {{ui:object, ler:(url:string)=>Promise<{ok:boolean,status:number,dados:any}>, enviar:(url:string, corpo:object)=>Promise<object>}} deps
 */
export function criarCentral({ ui, ler, enviar }) {
  const { el, cartao, tabela, selo, reais, horaBr, dataBr, vazio, dl } = ui;
  const cache = new Map(); // aba → { carregando, dados, erro }
  const filtro = { motivo: null, saida: null, aberta: null }; // conferência: motivo escolhido, grupo de saídas, pendência aberta
  const relacionadas = new Map(); // sha256 → { busca, itens } (sugestões pela legenda/busca; não é vínculo)
  const linhas = new Map(); // Execução 17: linha do tempo aberta (proposta → etapas)

  async function carregar(aba) {
    const rotas = ROTAS[aba] ?? [];
    cache.set(aba, { carregando: true });
    const r = await Promise.all(rotas.map((x) => ler(`/api/fv2/mova/${x}`)));
    const erro = r.find((x) => !x.ok);
    cache.set(aba, erro ? { erro: erro.dados?.mensagem ?? "Não foi possível carregar." } : { dados: Object.fromEntries(rotas.map((x, i) => [x, r[i].dados])) });
  }
  const invalidar = () => cache.clear();

  const kpi = (rotulo, valor, dica) => el("div", { classe: "cf-kpi" }, el("span", { classe: "cf-kpi-rotulo", texto: rotulo }), el("strong", { classe: "cf-kpi-valor", texto: String(valor) }), dica ? el("span", { classe: "cf-dica", texto: dica }) : null);
  const contar = (o) => Object.values(o ?? {}).reduce((s, x) => s + (typeof x === "number" ? x : x?.quantidade ?? 0), 0);
  const ligado = (v, sim = "Ligado", nao = "Desligado") => selo(v ? [sim, "ok"] : [nao, "neutro"]);
  const botao = (texto, attrs, perigo = false) => el("button", { classe: `botao botao--pequeno${perigo ? " botao--perigo" : ""}`, type: "button", ...attrs, texto });

  function visaoGeral({ "visao-geral": v }) {
    const prop = v.propostas ?? {}, ops = v.operacoes ?? {};
    const ia = v.orcamentoIa;
    return [
      el("div", { classe: "cf-kpis" },
        kpi("Mensagens recebidas", v.mensagens.recebidas, `últimos ${v.periodoDias} dias`),
        kpi("Respondidas", v.respostas?.ENVIADA ?? 0, `${v.respostas?.PENDENTE ?? 0} pendente(s) de envio`),
        kpi("Consultas", v.mensagens.consultas),
        kpi("Documentos", v.mensagens.documentos),
        kpi("Aguardando revisão", prop.AGUARDANDO_REVISAO?.quantidade ?? 0, reais(prop.AGUARDANDO_REVISAO?.valorCentavos ?? 0)),
        kpi("Operações executadas", ops.EXECUTADA?.quantidade ?? 0, reais(ops.EXECUTADA?.valorCentavos ?? 0)),
        kpi("Automações ativas", v.automacoes?.ativas ?? 0, `${v.automacoes?.pausadas ?? 0} pausada(s)`),
        kpi("Consumo de IA", ia ? `${ia.chamadas}/${ia.limiteChamadas}` : "—", ia ? `US$ ${ia.custoUsd.toFixed(2)} de US$ ${ia.limiteUsd.toFixed(2)}` : "sem orçamento registrado"),
      ),
      cartao("Estado do MOVA", dl([
        ["Modo", v.modo],
        ["Suspensão geral", v.controle ? selo(v.controle.suspenso ? ["SUSPENSO", "erro"] : ["Não", "neutro"]) : "—"],
        ["Autonomia (conferência com o extrato)", ligado(v.autonomiaLigada)],
        ["Identidade operacional (escrita)", ligado(v.identidadeOperacional, "Implantada", "Não implantada")],
        ["Entregadores no WhatsApp", ligado(v.entregadoresLigado)],
        ["Bloqueadas / ignoradas", `${v.mensagens.bloqueadas} / ${v.mensagens.ignoradas}`],
        ["Propostas por situação", Object.entries(prop).map(([k, x]) => `${k}: ${x.quantidade}`).join(" · ") || "nenhuma"],
        ["Operações por situação", Object.entries(ops).map(([k, x]) => `${k}: ${x.quantidade}`).join(" · ") || "nenhuma"],
        ["Notas de entregadores", Object.entries(v.notasEntregadores ?? {}).map(([k, n]) => `${k}: ${n}`).join(" · ") || "nenhuma"],
      ]), el("p", { classe: "cf-dica", texto: `Contagens do banco do MOVA desta unidade, geradas em ${horaBr(v.geradoEm)}. Nenhum número aqui é estimado.` })),
    ];
  }

  function grupos({ grupos: g }) {
    if (!g.itens.length) return [cartao("Grupos e participantes", vazio("Nenhuma conversa autorizada atende esta unidade."))];
    return g.itens.map((x) => cartao(`${x.tipo === "GRUPO" ? "Grupo" : x.tipo === "ENTREGADOR" ? "Privado de entregador" : "Conversa privada"} ${x.grupo}`,
      dl([["Acesso", x.acesso], ["Resposta com valores", x.politicaResposta ? POLITICA[x.politicaResposta] ?? x.politicaResposta : "nesta conversa"], ["Unidades", String(x.unidades)],
        ["Membros conferidos", x.membros ? `${x.membros.total} em ${horaBr(x.membros.verificadoEm)}` : x.tipo === "GRUPO" ? "sem retrato (valores nunca saem no grupo)" : "—"]]),
      x.membros?.naoAutorizados?.length ? el("p", { classe: "cf-aviso cf-aviso--alerta" }, el("strong", { texto: "Membros sem autorização: " }), x.membros.naoAutorizados.join(", "), ". O MOVA não responde a eles e valores não saem neste grupo.") : null,
      tabela(["Participante", "Nome", "Perfil", "Privado"], x.participantes.map((p, i) => ({ id: `${x.grupo}#${i}`, celulas: [el("code", { texto: p.id }), p.nome ?? "—", p.perfil ?? "por unidade", p.privado ? "sim" : "—"] })), "Participantes autorizados")));
  }

  function operacoes({ operacoes: o, politicas: p, "pagamentos-a-conciliar": pc }, pode) {
    const SIT_PC = { SEM_EXTRATO: ["Aguardando o extrato", "neutro"], CANDIDATA_UNICA: ["Saída do extrato encontrada", "info"], AMBIGUA: ["Várias saídas: escolha humana", "alerta"] };
    return [
      // Execução 17: PAGO POR COMPROVANTE ≠ CONCILIADO. Só a saída do extrato ligada à mesma baixa concilia (nunca 2ª baixa).
      cartao("Pagos por comprovante — conciliação bancária pendente",
        el("p", { classe: "cf-dica", texto: "A conta já está paga pelo comprovante; falta ligar a saída do extrato à mesma baixa. Conciliar não cria outra saída, outra despesa nem outra baixa." }),
        pc?.itens?.length ? tabela(["Pago em", "Valor", "Situação", "Saída do extrato", ""], pc.itens.map((x) => ({ id: x.liquidacaoId, celulas: [
          dataBr(x.dataPagamento), reais(x.valorCentavos), selo(SIT_PC[x.situacao] ?? [x.situacao, "neutro"]),
          x.candidatas.length === 1 ? `${dataBr(x.candidatas[0].data)} · ${reais(x.candidatas[0].valorCentavos)}` : x.candidatas.length ? `${x.candidatas.length} candidatas` : "—",
          x.situacao === "CANDIDATA_UNICA" && pc.podeConciliar ? botao("Conciliar", { "data-acao": "central-conciliar-comprovante", "data-liquidacao": x.liquidacaoId, "data-movimentacao": x.candidatas[0].movimentacaoId, "data-versao": String(x.candidatas[0].versao) }) : "—"] })), "Pagos por comprovante")
          : vazio(pc?.disponivel === false ? "Indisponível nesta versão do Financeiro." : "Nenhum pagamento por comprovante aguardando conciliação.")),
      ...(linhas.size ? [cartao("Linha do tempo do documento", ...[...linhas.values()].map((lt) => tabela(["Etapa", "Situação", "Detalhe"], lt.etapas.map((e) => ({ id: e.etapa, celulas: [
        ETAPA[e.etapa] ?? e.etapa, selo(SIT_ETAPA[e.situacao] ?? [e.situacao, "neutro"]), e.detalhe] })), "Etapas")))] : []),
      cartao("Operações executadas pelo MOVA",
        el("p", { classe: "cf-dica", texto: "Baixas feitas pelo serviço oficial a partir de um comprovante conferido com o extrato. Nenhum pagamento bancário é feito pelo MOVA." }),
        o.itens.length ? tabela(["Quando", "Operação", "Nível", "Valor", "Situação", "Evidência", ""], o.itens.map((x) => ({ id: x.id, celulas: [
          horaBr(x.criadaEm ?? x.executadaEm ?? new Date().toISOString()), x.operacao, selo(NIVEL[x.nivel] ?? [x.nivel, "neutro"]), reais(x.valorCentavos), selo(ESTADO_OP[x.estado] ?? [x.estado, "neutro"]),
          x.resultado?.documentoId ? "comprovante anexado" : x.motivo ? el("code", { texto: x.motivo }) : "—",
          el("span", {}, botao("Linha do tempo", { "data-acao": "central-linha-do-tempo", "data-proposta": x.propostaId }), x.estado === "EXECUTADA" && pode.cancelar ? botao("Reverter", { "data-acao": "central-reverter", "data-operacao": x.id }, true) : null)] })), "Operações") : vazio("Nenhuma operação executada nesta unidade.")),
      cartao("Aguardando confirmação", el("p", { texto: "Baixas conferidas com o extrato acima do limite da política aparecem em Propostas e Aprovações com o botão de confirmação." }),
        el("p", { classe: "cf-dica", texto: `Autonomia ${p.autonomiaLigada ? "ligada" : "desligada"} · identidade operacional ${p.identidadeOperacional ? "implantada" : "não implantada (tudo fica como proposta)"}.` })),
    ];
  }

  function entregadores({ entregadores: e }) {
    return [
      cartao("Entregadores autorizados no WhatsApp",
        el("p", { classe: "cf-dica", texto: `Fluxo ${e.ligado ? "ligado" : "desligado"}. O fechamento, a nota e a liberação são os da tela de Entregadores do Financeiro; aqui só o que passou pelo WhatsApp.` }),
        e.itens.length ? tabela(["Entregador", "Telefone", "Conversa"], e.itens.map((x) => ({ id: x.chave, celulas: [x.nome ?? x.chave, el("code", { texto: x.telefone }), x.conversa === "ATIVA" ? selo(["Ativa", "ok"]) : selo(["Número da equipe", "alerta"])] })), "Entregadores") : vazio("Nenhum entregador cadastrado para o WhatsApp nesta unidade.")),
      cartao("Notas recebidas", e.notas.length ? tabela(["Recebida", "Entregador", "Semana", "Situação", "Motivo"], e.notas.map((n) => ({ id: n.id, celulas: [horaBr(n.criadaEm), n.entregador, dataBr(n.semanaInicio),
        selo(n.estado === "ANEXADA" ? ["Anexada", "ok"] : n.estado === "RECUSADA" ? ["Recusada", "erro"] : ["Pendente de anexo", "alerta"]), n.motivo ? el("code", { texto: n.motivo }) : "—"] })), "Notas") : vazio("Nenhuma nota recebida.")),
      cartao("Mensagens enviadas pela rotina", e.envios.length ? tabela(["Quando", "Entregador", "Tipo", "Semana"], e.envios.map((x) => ({ id: x.chave, celulas: [horaBr(x.criadoEm), x.entregador, x.tipo === "SEMANAL" ? "Fechamento da semana" : x.tipo === "COBRANCA_NOTA" ? "Cobrança da nota" : x.tipo, dataBr(x.semanaInicio)] })), "Envios") : vazio("Nenhuma mensagem enviada.")),
    ];
  }

  function automacoes({ automacoes: a }, pode) {
    const porNome = new Map(a.itens.map((x) => [x.nome, x]));
    return [cartao("Automações da unidade",
      el("p", { classe: "cf-dica", texto: "Desligada ou pausada não envia nada. A pausa é individual e fica registrada na auditoria. O envio também depende do interruptor geral (Processamento)." }),
      tabela(["Automação", "Situação", "Horário", "Última execução", ""], Object.entries(AUTOMACOES).map(([nome, rotulo]) => {
        const x = porNome.get(nome);
        const situacao = !x || !x.ativa ? ["Desligada", "neutro"] : x.pausadaEm ? ["Pausada", "alerta"] : ["Ativa", "ok"];
        const acoes = pode.configurar ? el("span", {},
          botao(x?.ativa ? "Desligar" : "Ligar", { "data-acao": "central-automacao", "data-nome": nome, "data-ativa": String(!x?.ativa), "data-horario": x?.horario ?? "09:00" }),
          x?.ativa ? botao(x.pausadaEm ? "Retomar" : "Pausar", { "data-acao": "central-pausa", "data-nome": nome, "data-pausar": String(!x.pausadaEm) }) : null) : "—";
        return { id: nome, celulas: [rotulo, selo(situacao), x?.horario ?? "09:00", x?.ultimaExecucao ? horaBr(x.ultimaExecucao) : "—", acoes] };
      }), "Automações"))];
  }

  function seguranca({ politicas: p }, pode) {
    return [
      cartao("Políticas de autonomia",
        el("p", { classe: "cf-dica", texto: "Sem política, o MOVA só propõe. Acima do limite, pede confirmação. Automático só com a saída do extrato conferida e a identidade operacional implantada. Conta a pagar nova nunca é automática." }),
        p.itens.length ? tabela(["Operação", "Unidade", "Nível", "Limite", "Vigência", "Responsável", ""], p.itens.map((x) => ({ id: x.id, celulas: [x.operacao, x.unidadeId ? "esta" : "todas da empresa",
          selo(NIVEL[x.nivel] ?? [x.nivel, "neutro"]), reais(x.limiteCentavos), `${dataBr(x.vigenteDe)}${x.vigenteAte ? ` a ${dataBr(x.vigenteAte)}` : ""}`, x.responsavel,
          x.revogadaEm ? selo(["Revogada", "neutro"]) : pode.configurar ? botao("Revogar", { "data-acao": "central-revogar", "data-politica": x.id }, true) : "—"] })), "Políticas") : vazio("Nenhuma política: o MOVA só propõe."),
        pode.configurar ? el("form", { classe: "cf-form", "data-form": "politica", "data-unidade": pode.unidadeId },
          el("label", {}, "Nível ", el("select", { name: "nivel" }, Object.entries(NIVEL).map(([k, [r]]) => el("option", { value: k, texto: r })))),
          el("label", {}, "Limite (R$) ", el("input", { name: "limite", inputmode: "decimal", required: "" })),
          el("label", {}, "Responsável ", el("input", { name: "responsavel", maxlength: "120", required: "" })),
          el("label", {}, "Motivo ", el("input", { name: "motivo", minlength: "10", maxlength: "500", required: "" })),
          el("label", {}, "Vigente a partir de ", el("input", { name: "vigenteDe", type: "date", required: "" })),
          botao("Criar política desta unidade (baixa pelo extrato)", { "data-acao": "central-politica" })) : null),
      cartao("Interruptores e orçamento de IA", el("p", { texto: "Desligar recebimento, processamento, IA ou envio — e a suspensão geral — fica na aba Processamento, com efeito imediato." })),
    ];
  }

  const filtroBotao = (texto, attrs, ativo) => el("button", { classe: `botao botao--pequeno${ativo ? " botao--primario" : ""}`, type: "button", "aria-pressed": String(Boolean(ativo)), ...attrs, texto });
  const texto = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

  function conferencia({ conferencia: v }) {
    const i = v.indicadores;
    const ext = v.extratoDisponivel;
    const kpis = el("div", { classe: "cf-kpis" },
      kpi("Contas vencidas", i.contasVencidas, `saldo vencido ${reais(i.saldoVencidoCentavos)}`),
      kpi("Parcialmente pagas", i.contasParciais, `faltam ${reais(i.faltaParciaisCentavos)}`),
      kpi("Documentos faltantes", i.documentosFaltantes, `${i.abertasSemDocumento} em aberto · ${i.pagasSemComprovante} pagas sem comprovante`),
      kpi("Pagamentos aguardando conciliação", i.pagamentosAguardandoConciliacao, `${reais(i.pagamentosSemExtratoCentavos)} sem vínculo com o extrato`),
      kpi("Possível pagamento no extrato", ext ? i.possiveisPagamentosNoExtrato : "—", ext ? `${reais(i.possiveisPagamentosCentavos)} · NÃO confirmado` : "extrato indisponível"),
      kpi("Saídas do banco sem vínculo", ext ? i.saidasSemVinculo : "—", ext ? reais(i.saidasSemVinculoCentavos) : "extrato indisponível"),
      kpi("Sem fornecedor identificado", i.fornecedoresNaoIdentificados, reais(i.semFornecedorCentavos)),
      kpi("Possíveis duplicidades", i.possiveisDuplicidades, "conferir antes de qualquer ajuste"),
      kpi("Documentos recebidos pelo MOVA", i.documentosRecebidosMova, `${i.documentosAguardandoConferencia} aguardando conferência`));
    const contagem = {};
    for (const p of v.pendencias) for (const m of p.motivos) contagem[m] = (contagem[m] ?? 0) + 1;
    const lista = filtro.motivo ? v.pendencias.filter((p) => p.motivos.includes(filtro.motivo)) : v.pendencias;
    const filtros = el("div", { classe: "cf-filtros", role: "group", "aria-label": "Filtrar pendências por motivo" },
      filtroBotao(`Todas (${v.pendencias.length})`, { "data-acao": "central-filtro", "data-motivo": "" }, !filtro.motivo),
      Object.entries(MOTIVOS).filter(([m]) => contagem[m]).map(([m, [r]]) => filtroBotao(`${r} (${contagem[m]})`, { "data-acao": "central-filtro", "data-motivo": m }, filtro.motivo === m)));
    const linhas = lista.slice(0, LIMITE_LINHAS).map((p) => ({ id: p.id, celulas: [
      texto([v.empresa, p.unidade].filter(Boolean).join(" · ")), dataBr(p.vencimento), p.fornecedor ?? el("em", { texto: "não identificado" }), texto(p.descricao),
      reais(p.valorCentavos), reais(p.saldoCentavos), ORIGEM[p.origem] ?? texto(p.origem), DOCUMENTAL[p.documental] ?? p.documental, CONCILIACAO[p.conciliacao] ?? p.conciliacao,
      el("span", {}, p.motivos.map((m) => selo(MOTIVOS[m] ?? [m, "neutro"]))), p.proximaAcao,
      botao(filtro.aberta === p.id ? "Fechar" : "Detalhes", { "data-acao": "central-detalhe", "data-id": p.id, "aria-expanded": String(filtro.aberta === p.id) })] }));
    const aberta = v.pendencias.find((p) => p.id === filtro.aberta);
    const detalhe = aberta ? cartao(`Detalhes: ${aberta.fornecedor ?? "fornecedor não identificado"} · ${dataBr(aberta.vencimento)}`, dl([
      ["Descrição", texto(aberta.descricao)], ["Categoria", texto(aberta.categoria)], ["Competência", texto(aberta.competencia)], ["Situação no Financeiro", aberta.situacao],
      ["Valor original", reais(aberta.valorCentavos)], ["Pago registrado", reais(aberta.pagoCentavos)], ["Saldo", reais(aberta.saldoCentavos)],
      ["Ajuste manual", aberta.ajustesCentavos ? reais(aberta.ajustesCentavos) : "nenhum"], ["Dias vencida", aberta.diasVencida ? String(aberta.diasVencida) : "—"],
      ["Motivos", aberta.rotulos.join("; ")], ["Próxima ação recomendada", aberta.proximaAcao]]),
      aberta.candidatas.length ? tabela(["Saída do extrato", "Conta", "Valor", "Livre"], aberta.candidatas.map((s) => ({ id: s.id, celulas: [dataBr(s.data), texto(s.conta), reais(s.valorCentavos), reais(s.livreCentavos)] })), "Saídas compatíveis") : null,
      aberta.duplicadas.length ? tabela(["Conta parecida", "Vencimento", "Valor", "Situação"], aberta.duplicadas.map((d) => ({ id: d.id, celulas: [texto(d.fornecedor), dataBr(d.vencimento), reais(d.valorCentavos), d.situacao] })), "Contas parecidas") : null,
      el("p", { classe: "cf-dica", texto: "Saída compatível e conta parecida são avisos para conferir com o documento. Nada foi baixado, vinculado ou cancelado." })) : null;
    const s = v.saidas;
    const saidas = s ? cartao("Saídas do banco sem vínculo com conta a pagar",
      el("p", { classe: "cf-dica", texto: `${s.quantidade} saídas, ${reais(s.totalCentavos)}, de ${dataBr(s.de)} a ${dataBr(s.ate)}. Classificadas só pelo que os registros mostram; não são despesas nem pagamentos confirmados.` }),
      (() => { const g = s.grupos.find((x) => x.motivo === "SEM_ORIGEM_IDENTIFICADA"); return g ? el("p", { classe: "cf-alerta", texto: `${g.quantidade} lançamentos (${reais(g.totalCentavos)}) aguardam CLASSIFICAÇÃO: sem documento, conta ou descrição que indique a origem. Não presumir pagamento nem despesa; proposta só com evidência (nunca só pelo valor).` }) : null; })(),
      tabela(["Motivo", "Saídas", "Total", ""], s.grupos.map((g) => ({ id: g.motivo, celulas: [g.rotulo, String(g.quantidade), reais(g.totalCentavos),
        filtroBotao(filtro.saida === g.motivo ? "Ocultar" : "Ver", { "data-acao": "central-saidas", "data-motivo": g.motivo }, filtro.saida === g.motivo)] })), "Saídas por motivo"),
      filtro.saida ? tabela(["Data", "Conta", "Descrição no extrato", "Valor livre", "Evidência"], s.itens.filter((x) => x.motivo === filtro.saida).slice(0, LIMITE_LINHAS)
        .map((x) => ({ id: x.id, celulas: [dataBr(x.data), texto(x.conta), texto(x.descricao), reais(x.livreCentavos), x.evidencia] })), "Saídas do motivo") : null)
      : cartao("Saídas do banco sem vínculo", el("p", { texto: "Extrato indisponível agora: nenhuma marca de pagamento no extrato foi calculada." }));
    return [kpis,
      cartao("Pendências financeiras", el("p", { classe: "cf-dica", texto: `Posição de ${dataBr(v.posicao)} (Financeiro v2, leitura). Ordem: o que pede decisão humana primeiro, depois vencidas e maiores. Nada aqui baixa, cancela ou altera contas.` }),
        filtros, tabela(["Empresa · unidade", "Vencimento", "Fornecedor", "Descrição", "Valor", "Saldo", "Origem", "Documento", "Conciliação", "Motivo", "Próxima ação", ""], linhas, "Pendências"),
        lista.length > LIMITE_LINHAS ? el("p", { classe: "cf-dica", texto: `Mostrando ${LIMITE_LINHAS} de ${lista.length}. Use os filtros.` }) : null),
      detalhe, saidas];
  }

  function documentos({ "documentos-recebidos": d }, pode) {
    if (!d.itens.length) return [cartao("Documentos recebidos pelo WhatsApp", vazio(d.recebimentoDocumental ? "Nenhum documento recebido nesta unidade." : "Recebimento de documentos desligado: nenhum documento é guardado."))];
    const relLinhas = (x) => {
      const r = relacionadas.get(x.sha256);
      if (!r) return null;
      return el("div", { classe: "cf-relacionadas" },
        el("p", { classe: "cf-dica", texto: r.itens.length ? `Contas que podem se relacionar (busca: "${r.busca || "legenda"}"). É só sugestão: nada é vinculado.` : `Nenhuma conta encontrada para "${r.busca || "a legenda"}".` }),
        r.itens.length ? el("label", {}, "Conta citada na conferência (opcional) ", el("select", { "data-conta-doc": x.sha256 }, el("option", { value: "", texto: "nenhuma" }),
          r.itens.map((c) => el("option", { value: c.id, texto: `${dataBr(c.vencimento)} · ${c.fornecedor ?? "sem fornecedor"} · ${reais(c.saldoCentavos || c.valorCentavos)} · ${c.situacao}` })))) : null);
    };
    return [cartao("Documentos recebidos pelo WhatsApp",
      el("p", { classe: "cf-dica", texto: "Arquivos guardados em privado, sem leitura por IA. Revisado ou encaminhado NÃO é pagamento, baixa nem conciliação: o vínculo com a conta continua no fluxo oficial do Financeiro (Contas a Pagar e Conciliação)." }),
      ...d.itens.map((x) => el("article", { classe: "cf-cartao cf-documento" },
        el("h3", { texto: `${TIPO_DOC[x.conferencia.tipo] ?? (x.mime === "application/pdf" ? "PDF" : "Imagem")} · recebido ${x.recebidoEm ? horaBr(x.recebidoEm) : "—"}` }),
        dl([["Acompanhamento", texto(x.protocolo)], ["Remetente", `${x.remetente.nome ?? "participante"} (${x.remetente.id})`], ["Legenda", texto(x.legenda)], ["Arquivo", `${texto(x.nomeArquivo)} · ${x.mime} · ${Math.ceil((x.tamanhoBytes ?? 0) / 1024)} KB`],
          ["Situação", selo(ESTADO_DOC[x.conferencia.estado] ?? [x.conferencia.estado, "neutro"])], ["Última conferência", x.conferencia.em ? `${horaBr(x.conferencia.em)}${x.conferencia.observacao ? ` — ${x.conferencia.observacao}` : ""}` : "—"]]),
        el("p", {},
          x.arquivoRemovido ? el("em", { texto: "arquivo removido pela retenção" }) : pode.documentos ? botao("Abrir original", { "data-acao": "arquivo", "data-sha": x.sha256 }) : el("em", { texto: "abrir exige permissão de documentos" }),
          botao("Contas relacionadas", { "data-acao": "central-doc-relacionadas", "data-sha": x.sha256 })),
        relLinhas(x),
        d.podeConferir ? el("p", {},
          el("label", {}, "Tipo ", el("select", { "data-tipo-doc": x.sha256 }, el("option", { value: "", texto: "não informado" }), Object.entries(TIPO_DOC).map(([k, r]) => el("option", { value: k, texto: r, selected: x.conferencia.tipo === k }))), " "),
          botao("Marcar revisado", { "data-acao": "central-doc-conferir", "data-sha": x.sha256, "data-versao": String(x.conferencia.versao), "data-estado": "REVISADO" }),
          botao("Encaminhar ao Financeiro", { "data-acao": "central-doc-conferir", "data-sha": x.sha256, "data-versao": String(x.conferencia.versao), "data-estado": "ENCAMINHADO" })) : el("p", { classe: "cf-dica", texto: "Conferir exige permissão de documentos." }))))];
  }

  const DESENHOS = { central: visaoGeral, conferencia, documentos, grupos, operacoes, entregadores, automacoes, seguranca };

  /** Desenho da aba: sem API real ⇒ diz isso (nada simulado); carregando ⇒ aviso; erro ⇒ mensagem do servidor. */
  function desenhar(aba, { fonte, permissoes, unidadeId, redesenhar }) {
    if (fonte !== "API") return [cartao(ABAS_CENTRAL.find((a) => a.id === aba).rotulo, el("p", { texto: "Disponível só com a API real do MOVA. Esta aba não mostra números simulados." }))];
    const c = cache.get(aba);
    if (!c) { carregar(aba).then(redesenhar); return [vazio("Carregando…")]; }
    if (c.carregando) return [vazio("Carregando…")];
    if (c.erro) return [cartao("Indisponível", el("p", { texto: c.erro }))];
    const pode = { configurar: permissoes.includes("financeiro_v2.configurar"), cancelar: permissoes.includes("financeiro_v2.cancelar"), documentos: permissoes.includes("financeiro_v2.documentos"), unidadeId };
    return DESENHOS[aba](c.dados, pode);
  }

  /** Ações da Central (o servidor confere tudo). Devolve { ok, texto }. */
  async function agir(b) {
    const acao = b.dataset.acao;
    let r;
    // Filtros e detalhes da conferência: só redesenham (nada vai ao servidor).
    if (acao === "central-filtro") { filtro.motivo = b.dataset.motivo || null; return { ok: true, texto: filtro.motivo ? `Filtro: ${MOTIVOS[filtro.motivo]?.[0] ?? filtro.motivo}.` : "Todas as pendências." }; }
    if (acao === "central-saidas") { filtro.saida = filtro.saida === b.dataset.motivo ? null : b.dataset.motivo; return { ok: true, texto: filtro.saida ? "Saídas do motivo abertas abaixo." : "Lista de saídas fechada." }; }
    if (acao === "central-detalhe") { filtro.aberta = filtro.aberta === b.dataset.id ? null : b.dataset.id; return { ok: true, texto: filtro.aberta ? "Detalhes abertos abaixo da lista." : "Detalhes fechados." }; }
    if (acao === "central-doc-relacionadas") {
      const busca = globalThis.prompt?.("Buscar conta por fornecedor ou valor (vazio = usar a legenda do documento):")?.trim();
      if (busca === undefined) return null;
      const x = await ler(`/api/fv2/mova/documento-relacionadas?sha=${encodeURIComponent(b.dataset.sha)}${busca ? `&busca=${encodeURIComponent(busca)}` : ""}`);
      if (!x.ok) return { ok: false, texto: `Não foi possível: ${x.dados?.mensagem ?? "busca indisponível"}` };
      relacionadas.set(b.dataset.sha, x.dados);
      return { ok: true, texto: `${x.dados.itens.length} conta(s) que podem se relacionar. Sugestão, não vínculo.` };
    }
    if (acao === "central-doc-conferir") {
      const sha = b.dataset.sha;
      const observacao = globalThis.prompt?.(b.dataset.estado === "ENCAMINHADO" ? "Observação para o Financeiro (opcional):" : "Observação da revisão (opcional):");
      if (observacao === null || observacao === undefined) return null;
      const tipo = globalThis.document?.querySelector(`[data-tipo-doc="${sha}"]`)?.value || null;
      const obrigacaoId = globalThis.document?.querySelector(`[data-conta-doc="${sha}"]`)?.value || null;
      r = await enviar("/api/fv2/acoes/mova/documento-conferir", { sha256: sha, versao: Number(b.dataset.versao), estado: b.dataset.estado, ...(tipo ? { tipo } : {}), ...(obrigacaoId ? { obrigacaoId } : {}), ...(observacao.trim() ? { observacao: observacao.trim().slice(0, 500) } : {}) });
      invalidar();
      return r.ok ? { ok: true, texto: b.dataset.estado === "ENCAMINHADO" ? "Encaminhado ao Financeiro (não é baixa nem conciliação)." : "Marcado como revisado (não é baixa nem conciliação)." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
    }
    if (acao === "central-linha-do-tempo") {
      const x = await ler(`/api/fv2/mova/linha-do-tempo?proposta=${encodeURIComponent(b.dataset.proposta)}`);
      if (!x.ok) return { ok: false, texto: `Não foi possível: ${x.dados?.mensagem ?? "linha do tempo indisponível"}` };
      linhas.clear();
      linhas.set(b.dataset.proposta, x.dados);
      return { ok: true, texto: "Linha do tempo aberta acima das operações." };
    }
    if (acao === "central-conciliar-comprovante") {
      r = await enviar("/api/fv2/acoes/mova/conciliar-comprovante", { liquidacaoId: b.dataset.liquidacao, movimentacaoId: b.dataset.movimentacao, versaoMovimentacao: Number(b.dataset.versao) });
      invalidar();
      return r.ok ? { ok: true, texto: "Conciliado com o extrato (mesma baixa; nenhuma saída ou despesa nova)." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
    }
    if (acao === "central-reverter") {
      const justificativa = globalThis.prompt?.("Justificativa da reversão (mínimo 10 caracteres; fica na auditoria):")?.trim() ?? "";
      if (!justificativa) return null;
      r = await enviar("/api/fv2/acoes/mova/reverter-operacao", { operacaoId: b.dataset.operacao, justificativa });
    } else if (acao === "central-automacao") {
      r = await enviar("/api/fv2/acoes/mova/automacao", { nome: b.dataset.nome, ativa: b.dataset.ativa === "true", horario: b.dataset.horario });
    } else if (acao === "central-pausa") {
      const motivo = b.dataset.pausar === "true" ? (globalThis.prompt?.("Motivo da pausa (opcional):") ?? "") : "";
      r = await enviar("/api/fv2/acoes/mova/automacao-pausa", { nome: b.dataset.nome, pausar: b.dataset.pausar === "true", ...(motivo ? { motivo } : {}) });
    } else if (acao === "central-revogar") {
      r = await enviar("/api/fv2/acoes/mova/politica-revogar", { politicaId: b.dataset.politica });
    } else if (acao === "central-politica") {
      const f = b.closest("form");
      const v = Object.fromEntries(new FormData(f).entries());
      const limite = Math.round(Number(String(v.limite).replace(/\./g, "").replace(",", ".")) * 100);
      if (!Number.isSafeInteger(limite) || limite < 0) return { ok: false, texto: "Limite inválido." };
      if (!f.dataset.unidade) return { ok: false, texto: "Unidade da sessão indisponível." };
      r = await enviar("/api/fv2/acoes/mova/politica", { operacao: "BAIXA_POR_EXTRATO", unidadeId: f.dataset.unidade, nivel: v.nivel, limiteCentavos: limite, responsavel: v.responsavel, motivo: v.motivo, vigenteDe: v.vigenteDe });
    } else if (acao === "central-confirmar-baixa") {
      r = await enviar("/api/fv2/acoes/mova/confirmar-baixa-extrato", { propostaId: b.dataset.proposta });
    } else return null;
    invalidar();
    return r.ok ? { ok: true, texto: "Feito." } : { ok: false, texto: `Não foi possível: ${r.mensagem}` };
  }

  return Object.freeze({ desenhar, agir, invalidar });
}
