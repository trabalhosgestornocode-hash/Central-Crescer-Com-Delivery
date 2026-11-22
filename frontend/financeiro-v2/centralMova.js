// Central de Operações MOVA (Agente 2 — Frente E): abas que evoluem o Centro Financeiro sobre as APIs REAIS do MOVA.
// Regras: só números que o servidor devolve (contagens do banco do MOVA da unidade da sessão) — nenhum indicador estimado
// ou simulado; sem a API real a aba diz isso. Identificadores chegam mascarados. Todo texto entra por textContent.
// As ações só ENVIAM ao servidor, que confere permissão, unidade e estado de novo.

export const ABAS_CENTRAL = Object.freeze([
  { id: "central", rotulo: "Visão Geral MOVA" },
  { id: "grupos", rotulo: "Grupos e Participantes" },
  { id: "operacoes", rotulo: "Operações Financeiras" },
  { id: "entregadores", rotulo: "Entregadores" },
  { id: "automacoes", rotulo: "Automações" },
  { id: "seguranca", rotulo: "Segurança e Autonomia" },
]);
const ROTAS = { central: ["visao-geral"], grupos: ["grupos"], operacoes: ["operacoes", "politicas"], entregadores: ["entregadores"], automacoes: ["automacoes"], seguranca: ["politicas"] };
const AUTOMACOES = { ENTREGADORES_SEMANAL: "Mensagem de segunda aos entregadores", ENTREGADORES_COBRANCA: "Cobrança da nota fiscal" };
const NIVEL = { SOMENTE_PROPOR: ["Só propor", "neutro"], APLICAR_COM_CONFIRMACAO: ["Com confirmação", "alerta"], APLICAR_AUTOMATICO: ["Automático", "info"] };
const ESTADO_OP = { EXECUTANDO: ["Executando", "info"], EXECUTADA: ["Executada", "ok"], FALHOU: ["Falhou", "erro"], REVERTIDA: ["Revertida", "neutro"] };
const POLITICA = { PRIVADO_RESTRITO: "Privado restrito", GRUPO_FINANCEIRO: "Grupo financeiro", OPERACIONAL: "Operacional (sem valores)" };

/**
 * @param {{ui:object, ler:(url:string)=>Promise<{ok:boolean,status:number,dados:any}>, enviar:(url:string, corpo:object)=>Promise<object>}} deps
 */
export function criarCentral({ ui, ler, enviar }) {
  const { el, cartao, tabela, selo, reais, horaBr, dataBr, vazio, dl } = ui;
  const cache = new Map(); // aba → { carregando, dados, erro }

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

  function operacoes({ operacoes: o, politicas: p }, pode) {
    return [
      cartao("Operações executadas pelo MOVA",
        el("p", { classe: "cf-dica", texto: "Baixas feitas pelo serviço oficial a partir de um comprovante conferido com o extrato. Nenhum pagamento bancário é feito pelo MOVA." }),
        o.itens.length ? tabela(["Quando", "Operação", "Nível", "Valor", "Situação", "Evidência", ""], o.itens.map((x) => ({ id: x.id, celulas: [
          horaBr(x.criadaEm ?? x.executadaEm ?? new Date().toISOString()), x.operacao, selo(NIVEL[x.nivel] ?? [x.nivel, "neutro"]), reais(x.valorCentavos), selo(ESTADO_OP[x.estado] ?? [x.estado, "neutro"]),
          x.resultado?.documentoId ? "comprovante anexado" : x.motivo ? el("code", { texto: x.motivo }) : "—",
          x.estado === "EXECUTADA" && pode.cancelar ? botao("Reverter", { "data-acao": "central-reverter", "data-operacao": x.id }, true) : "—"] })), "Operações") : vazio("Nenhuma operação executada nesta unidade.")),
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

  const DESENHOS = { central: visaoGeral, grupos, operacoes, entregadores, automacoes, seguranca };

  /** Desenho da aba: sem API real ⇒ diz isso (nada simulado); carregando ⇒ aviso; erro ⇒ mensagem do servidor. */
  function desenhar(aba, { fonte, permissoes, unidadeId, redesenhar }) {
    if (fonte !== "API") return [cartao(ABAS_CENTRAL.find((a) => a.id === aba).rotulo, el("p", { texto: "Disponível só com a API real do MOVA. Esta aba não mostra números simulados." }))];
    const c = cache.get(aba);
    if (!c) { carregar(aba).then(redesenhar); return [vazio("Carregando…")]; }
    if (c.carregando) return [vazio("Carregando…")];
    if (c.erro) return [cartao("Indisponível", el("p", { texto: c.erro }))];
    const pode = { configurar: permissoes.includes("financeiro_v2.configurar"), cancelar: permissoes.includes("financeiro_v2.cancelar"), unidadeId };
    return DESENHOS[aba](c.dados, pode);
  }

  /** Ações da Central (o servidor confere tudo). Devolve { ok, texto }. */
  async function agir(b) {
    const acao = b.dataset.acao;
    let r;
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
