// Decisões PURAS da tela de integração iFood — sem DOM, sem browser, sem
// imports de rede. Mesmo padrão de agentePageContext.js / contextoEscopo.js:
// a view (ifood.js) coleta o retrato do estado real e passa para cá; estas
// funções só decidem. É isto que os testes exercitam.

/** Rótulos amigáveis dos dois aplicativos distribuídos. */
export const APP_ROTULO = Object.freeze({
  analytics: "Desempenho / Analytics",
  financial: "Financeiro",
});

// Estados explícitos da integração (a `chave` é o contrato com os testes/view):
//   erro_status      -> GET /status falhou: NÃO sabemos o estado (nunca "Não conectado")
//   nao_conectado    -> nenhuma autorização
//   parcial          -> OAuth parcial (falta autorizar o app Financial, ou o Analytics)
//   merchant_pendente-> Financial autorizado, loja iFood AINDA não vinculada
//   conectado        -> apps autorizados + loja vinculada
//   reauth           -> algum token exige reconexão
const META_ESTADO = Object.freeze({
  erro_status: { rotulo: "Status indisponível", classe: "bad" },
  nao_conectado: { rotulo: "Não conectado", classe: "muted" },
  parcial: { rotulo: "Parcialmente conectado", classe: "warn" },
  merchant_pendente: {
    rotulo: "Loja pendente", classe: "warn",
    aviso: "Aplicativo autorizado. Falta escolher qual loja do iFood pertence a esta unidade.",
  },
  conectado: { rotulo: "Conectado", classe: "ok" },
  reauth: { rotulo: "Reconexão necessária", classe: "bad" },
});

export const MENSAGEM_ERRO_STATUS = "Não foi possível consultar o status da integração.";

function estadoDeApp(app = {}) {
  if (app.status === "reauth_required") return { conectado: false, rotulo: "Reconexão necessária", classe: "bad" };
  if (app.conectado) return { conectado: true, rotulo: "Conectado", classe: "ok", expiraEm: app.expiraEm ?? null };
  return { conectado: false, rotulo: "Não conectado", classe: "muted" };
}

/**
 * Traduz a resposta de GET /status para o estado visual da tela.
 * @param {object|null} status resposta sanitizada do backend
 * @param {{erro?: boolean}} [opts] `erro: true` quando GET /status FALHOU — o
 *   estado real é desconhecido e NUNCA deve virar "Não conectado".
 * @returns {{
 *   chave: 'erro_status'|'nao_conectado'|'parcial'|'merchant_pendente'|'conectado'|'reauth',
 *   rotulo: string, classe: string, aviso?: string,
 *   apps: { analytics: object, financial: object },
 *   merchant: {idMascarado, nome, razaoSocial}|null,
 *   podeConectarAnalytics: boolean, podeConectarFinancial: boolean,
 *   podeVincularMerchant: boolean, podeTentarNovamente: boolean,
 *   precisaReconectar: boolean, podeDesconectar: boolean,
 *   conectadaEm: string|null,
 * }}
 */
export function derivarEstadoIntegracao(status, { erro = false } = {}) {
  if (erro) {
    const desconhecido = { conectado: false, rotulo: "—", classe: "muted" };
    return {
      chave: "erro_status",
      ...META_ESTADO.erro_status,
      aviso: MENSAGEM_ERRO_STATUS,
      apps: { analytics: desconhecido, financial: desconhecido },
      merchant: null,
      podeConectarAnalytics: false, podeConectarFinancial: false,
      podeVincularMerchant: false, podeTentarNovamente: true,
      precisaReconectar: false, podeDesconectar: false,
      conectadaEm: null,
    };
  }
  const s = status ?? {};
  const apps = s.apps ?? {};
  const analytics = estadoDeApp(apps.analytics);
  const financial = estadoDeApp(apps.financial);
  const merchant = s.merchant ?? null;

  const algumReauth = s.status === "reauth_required"
    || apps.analytics?.status === "reauth_required"
    || apps.financial?.status === "reauth_required";

  const nada = !analytics.conectado && !financial.conectado && !merchant && !algumReauth
    && (!s.status || s.status === "nao_conectado" || s.status === "revogada");

  let chave;
  if (algumReauth) chave = "reauth";
  else if (nada) chave = "nao_conectado";
  // O token Financial basta para listar/vincular lojas: já autorizado e sem
  // merchant = falta só escolher a loja (NÃO exige refazer o OAuth).
  else if (financial.conectado && !merchant) chave = "merchant_pendente";
  else if (analytics.conectado && financial.conectado && merchant) chave = "conectado";
  else chave = "parcial";

  return {
    chave,
    ...META_ESTADO[chave],
    apps: { analytics, financial },
    merchant,
    podeConectarAnalytics: !analytics.conectado || apps.analytics?.status === "reauth_required",
    podeConectarFinancial: !financial.conectado || apps.financial?.status === "reauth_required",
    podeVincularMerchant: chave === "merchant_pendente",
    podeTentarNovamente: false,
    precisaReconectar: chave === "reauth",
    podeDesconectar: chave !== "nao_conectado",
    conectadaEm: s.conectadaEm ?? null,
  };
}

/**
 * Ações do painel para o estado derivado — UMA lista, sem comandos duplicados
 * ou conflitantes (ex.: "Continuar conexão" + "Reconectar" juntos em reauth).
 * `id` é o contrato com o handler em ifood.js.
 * @param {ReturnType<typeof derivarEstadoIntegracao>} e
 * @returns {Array<{id: 'tentar_novamente'|'conectar'|'continuar'|'vincular'|'autorizar_analytics'|'reconectar'|'desconectar', rotulo: string, primaria: boolean}>}
 */
export function acoesDoPainel(e) {
  const acao = (id, rotulo, primaria = false) => ({ id, rotulo, primaria });
  const desconectar = e.podeDesconectar ? [acao("desconectar", "Desconectar")] : [];

  switch (e.chave) {
    case "erro_status":
      return [acao("tentar_novamente", "Tentar novamente", true)];
    case "nao_conectado":
      return [acao("conectar", "Conectar iFood", true)];
    case "reauth":
      return [acao("reconectar", "Reconectar iFood", true), ...desconectar];
    case "merchant_pendente":
      return [
        acao("vincular", "Vincular loja", true),
        ...(e.podeConectarAnalytics ? [acao("autorizar_analytics", "Autorizar Analytics")] : []),
        ...desconectar,
      ];
    case "parcial":
      return [acao("continuar", "Continuar conexão", true), ...desconectar];
    default: // conectado
      return desconectar;
  }
}

/**
 * Prepara a etapa de seleção de merchant a partir da lista de GET /merchants.
 * NUNCA vincula sozinho — até com 1 loja pede confirmação.
 * @param {Array<{id, idMascarado, nome, razaoSocial}>} merchants
 * @returns {{modo: 'vazio'|'unico'|'lista', merchants: object[], mensagem: string}}
 */
export function prepararSelecaoMerchant(merchants) {
  const lista = Array.isArray(merchants) ? merchants.filter((m) => m && m.id) : [];
  if (lista.length === 0) {
    return {
      modo: "vazio", merchants: [],
      mensagem: "Esta conta iFood não possui acesso a nenhuma loja. Confira no Portal do Parceiro se o aplicativo foi autorizado para alguma loja e tente de novo.",
    };
  }
  if (lista.length === 1) {
    return { modo: "unico", merchants: lista, mensagem: "Encontramos uma loja. Confirme que é a loja desta unidade antes de vincular." };
  }
  return { modo: "lista", merchants: lista, mensagem: "Selecione a loja do iFood correspondente a esta unidade." };
}

/**
 * Contador de expiração do userCode (10 min). Puro — recebe o "agora".
 * @param {string} expiraEmIso
 * @param {number} [agoraMs]
 * @returns {{expirado: boolean, restanteMs: number, rotulo: string}}
 */
export function contadorExpiracao(expiraEmIso, agoraMs = Date.now()) {
  const alvo = new Date(expiraEmIso).getTime();
  if (!Number.isFinite(alvo)) return { expirado: true, restanteMs: 0, rotulo: "—" };
  const restanteMs = alvo - agoraMs;
  if (restanteMs <= 0) return { expirado: true, restanteMs: 0, rotulo: "expirado" };
  const totalSeg = Math.floor(restanteMs / 1000);
  const mm = String(Math.floor(totalSeg / 60)).padStart(2, "0");
  const ss = String(totalSeg % 60).padStart(2, "0");
  return { expirado: false, restanteMs, rotulo: `${mm}:${ss}` };
}

/**
 * Troca de merchant na mesma unidade: precisa de confirmação explícita
 * quando já há um merchant vinculado E o escolhido é OUTRO. Mesmo merchant
 * (idempotente) ou nenhum vinculado -> sem confirmação.
 *
 * Compara pelo idMascarado — é o único identificador que o /status expõe;
 * uma colisão de máscara só causaria uma confirmação a mais, nunca um vínculo
 * errado (o backend revalida na API de qualquer forma).
 * @param {object|null} status resposta de GET /status
 * @param {{idMascarado?: string}} merchantEscolhido
 * @returns {boolean}
 */
export function precisaConfirmarTrocaMerchant(status, merchantEscolhido) {
  const atual = status?.merchant?.idMascarado;
  if (!atual) return false;
  return atual !== (merchantEscolhido?.idMascarado ?? null);
}

/** Texto da confirmação de troca de merchant. */
export function textoConfirmacaoTroca(status, merchantEscolhido) {
  const de = status?.merchant?.nome || status?.merchant?.idMascarado || "a loja atual";
  const para = merchantEscolhido?.nome || merchantEscolhido?.idMascarado || "a nova loja";
  return `Esta unidade já está vinculada a "${de}". Deseja substituir pelo vínculo com "${para}"? O vínculo anterior deixará de valer.`;
}

/** Mensagem amigável para uma falha no fluxo de autorização. */
export function mensagemErroAutorizacao(err) {
  switch (err?.codigo) {
    case "IFOOD_OAUTH_SESSAO_EXPIRADA":
      return "O código de vínculo expirou. Gere outro código e tente novamente.";
    case "IFOOD_OAUTH_SESSAO_JA_USADA":
      return "Essa autorização já foi concluída ou cancelada. Gere um novo código se precisar reconectar.";
    case "IFOOD_OAUTH_CODIGO_INVALIDO":
      return "Não foi possível concluir a autorização. Confira o código de autorização fornecido pelo iFood e tente novamente, ou gere um novo código.";
    case "IFOOD_APP_SEM_CREDENCIAL":
      return "Este aplicativo iFood ainda não está configurado no sistema. Fale com o suporte da plataforma.";
    case "IFOOD_ORDER_PILOTO_NAO_HABILITADO":
      return "Pedidos e eventos do iFood ainda não estão disponíveis para esta unidade.";
    default:
      return err?.message || "Não foi possível concluir a autorização. Gere um novo código e tente novamente.";
  }
}

/** Aviso exibido ao desconectar — remoção local ≠ revogação no iFood. */
export function avisoDesconexao() {
  return "A desconexão remove o acesso apenas aqui no Crescer com Delivery: os tokens locais são descartados e a integração é desativada. "
    + "Isso não revoga necessariamente o acesso no iFood. Para revogação total, remova também o aplicativo no Portal do Parceiro iFood "
    + "(apenas quem autorizou pode revogar por lá).";
}

// ---------------------------------------------------------------------------
// Homologação Financeira — Visão Geral (aba "overview")
//
// As duas funções abaixo são PURA APRESENTAÇÃO sobre o resultado que
// ifoodFinancial.service.js#obterConciliacaoFinanceira() já devolve —
// nenhuma soma/comparação nova é feita aqui, só leitura de campos que o
// backend já calculou (fontesComErro, conciliacao.*). "rotulo" duplica
// ifood.js#FONTE_ROTULO de propósito: este módulo não importa de ifood.js
// (mantém a separação DOM x decisão pura já estabelecida no arquivo).
// ---------------------------------------------------------------------------
const FONTE_ROTULO_CONCILIACAO = Object.freeze({
  sales: "Sales", events: "Financial Events", settlements: "Settlements",
  reconciliation: "Reconciliation", anticipations: "Anticipation",
});
const ORDEM_FONTES_CONCILIACAO = ["sales", "events", "settlements", "reconciliation", "anticipations"];

/**
 * Quais das 5 fontes do Bloco H estão disponíveis no resultado. Indisponível
 * quando (a) a busca falhou (`fontesComErro`) ou (b) é a Reconciliation e o
 * arquivo da competência ainda não chegou a ser disponibilizado pelo iFood
 * (`reconciliation.disponivel === false`, sem ter sido um erro de busca) —
 * único caso assim porque é a única fonte mensal, que pode não ter fechado.
 * @param {object|null} resultado retorno de obterConciliacaoFinanceira()
 * @returns {{fonte:string, rotulo:string, disponivel:boolean, motivo:string|null}[]}
 */
export function derivarFontesConciliacao(resultado) {
  const errosPorFonte = new Map((resultado?.fontesComErro ?? []).map((f) => [f.fonte, f.mensagem ?? null]));
  return ORDEM_FONTES_CONCILIACAO.map((fonte) => {
    const rotulo = FONTE_ROTULO_CONCILIACAO[fonte];
    if (errosPorFonte.has(fonte)) return { fonte, rotulo, disponivel: false, motivo: errosPorFonte.get(fonte) };
    if (fonte === "reconciliation" && resultado && !resultado.reconciliation?.disponivel) {
      return { fonte, rotulo, disponivel: false, motivo: "Arquivo de conciliação ainda não disponível para a competência." };
    }
    return { fonte, rotulo, disponivel: !!resultado, motivo: null };
  });
}

/**
 * Pendências de homologação — geradas SÓ a partir de campos que o resultado
 * já contém, nunca inventadas. Cada regra lê um sinal que
 * ifoodFinancial.reconciliation.js já calculou:
 *  - fonte que falhou ao buscar (`fontesComErro`);
 *  - Settlements × Reconciliation NAO_COMPARAVEL ou INCOMPLETO com motivo;
 *  - qualquer divergência encontrada (`conciliacao.divergencias`);
 *  - statusGeral SEM_DADOS (nada no período — nenhuma validação real ainda).
 * @param {object|null} resultado retorno de obterConciliacaoFinanceira()
 * @returns {{codigo:string, mensagem:string}[]}
 */
export function derivarPendenciasHomologacao(resultado) {
  if (!resultado) return [];
  const c = resultado.conciliacao ?? {};
  const pendencias = [];

  for (const f of resultado.fontesComErro ?? []) {
    pendencias.push({
      codigo: "FONTE_SEM_DADOS",
      mensagem: `A fonte "${FONTE_ROTULO_CONCILIACAO[f.fonte] ?? f.fonte}" não retornou dados no período consultado (${f.mensagem ?? "falha desconhecida"}).`,
    });
  }

  if (c.settlementsVsReconciliation?.status === "NAO_COMPARAVEL") {
    pendencias.push({
      codigo: "RECONCILIATION_NAO_COMPARAVEL",
      mensagem: c.settlementsVsReconciliation.motivo || "Reconciliation ainda não é comparável automaticamente para este período.",
    });
  } else if (c.settlementsVsReconciliation?.status === "INCOMPLETO" && c.settlementsVsReconciliation.motivo) {
    pendencias.push({ codigo: "RECONCILIATION_INCOMPLETA", mensagem: c.settlementsVsReconciliation.motivo });
  }

  if ((c.divergencias?.length ?? 0) > 0) {
    pendencias.push({
      codigo: "DIVERGENCIA_ENCONTRADA",
      mensagem: `${c.divergencias.length} divergência(s) encontrada(s) na conciliação — revisar antes de considerar o período homologado.`,
    });
  }

  if (c.statusGeral === "SEM_DADOS") {
    pendencias.push({
      codigo: "SEM_VALIDACAO_REAL",
      mensagem: "Nenhum dado disponível no período consultado — a primeira validação real da conciliação ainda não foi realizada.",
    });
  }

  return pendencias;
}

// ---------------------------------------------------------------------------
// Homologação Financeira — Evidências (aba "evidencia")
//
// Camada de EVIDÊNCIA/AUDITORIA, não de cálculo: monta um retrato do que já
// foi consultado nesta sessão (Sales/Events/Settlements/Reconciliation/
// Anticipation, cada um na aba própria) + o resultado já validado do Bloco H
// (aba Conciliação/Visão Geral — obterConciliacaoFinanceira()). Nenhuma soma
// nova: os números de cada API vêm do resumo que o Bloco H já calculou (a
// única fonte com os 5 períodos comparáveis entre si); só "exemplo
// sanitizado" e "período consultado" de cada bloco vêm do resultado bruto da
// aba individual, porque o Bloco H não devolve o item cru, só o agregado.
// ---------------------------------------------------------------------------

// Termos que tornam uma CHAVE sensível (nunca o valor) — comparação por
// substring, case-insensitive, com o nome da chave normalizado (só
// [a-z0-9], sem _/-/espaço) pra pegar "access_token", "Access-Token",
// "accessToken" etc. com a mesma regra. Os 9 primeiros são os exigidos
// explicitamente (Bloco: Modo Técnico); os últimos 3 são rede de segurança
// extra, mesmo raciocínio.
const TERMOS_CHAVE_SENSIVEL = [
  "accesstoken", "refreshtoken", "clientsecret", "authorization", "token", "verifier",
  "downloadpath", "downloadurl", "signedurl",
  "secret", "password", "senha",
].map((t) => t.toLowerCase());

function normalizarNomeChave(chave) {
  return String(chave ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function chaveSensivel(chave) {
  const normalizada = normalizarNomeChave(chave);
  return normalizada.length > 0 && TERMOS_CHAVE_SENSIVEL.some((t) => normalizada.includes(t));
}

/**
 * Sanitização recursiva defensiva por NOME de chave (case-insensitive) — vê
 * qualquer estrutura (objeto, array, aninhado a qualquer profundidade) e
 * troca o VALOR de toda chave sensível por "[REDACTED]", preservando a
 * estrutura em volta (pra evidência continuar legível). Nunca lança: valor
 * circular vira "[circular]"; primitivos passam direto (number/string/
 * boolean/null preservam tipo e valor — dinheiro e timestamp não são
 * tocados). Usada tanto nos "exemplos sanitizados" de cada API quanto no
 * JSON completo do Modo Técnico e na exportação.
 * @param {*} valor
 * @returns {*}
 */
export function sanitizarProfundo(valor, _vistos = new WeakSet()) {
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) return valor.map((v) => sanitizarProfundo(v, _vistos));
  if (typeof valor === "object") {
    if (_vistos.has(valor)) return "[circular]";
    _vistos.add(valor);
    const saida = {};
    for (const [k, v] of Object.entries(valor)) {
      saida[k] = chaveSensivel(k) ? "[REDACTED]" : sanitizarProfundo(v, _vistos);
    }
    return saida;
  }
  return valor; // string / number / boolean já são o valor final
}

/** true se a aba já tentou consultar (sucesso ou erro) — distinto de
 * "disponível" (só sucesso). Mesmo shape em sales/events/settlements/
 * anticipation: {resultado, erro}. */
function jaConsultou(sub) {
  return !!(sub?.resultado || sub?.erro);
}

/**
 * Bloco de evidência de uma API "simples" (Sales/Events/Settlements/
 * Anticipation — todas com {periodo, <lista>} no resultado bruto). Números
 * agregados vêm do resumo já calculado pelo Bloco H (`resumoConciliacao`);
 * período e exemplo vêm do resultado bruto da aba (`subEstado`), que é a
 * única fonte com o item cru.
 * @param {{resultado, erro}} subEstado estado.financeiro.<fonte>
 * @param {object|null} resumoConciliacao ex.: resultadoConciliacao?.vendas
 * @param {string} chaveLista nome do array na resposta bruta (ex.: "vendas")
 * @param {object} extras campos numéricos já prontos, lidos de resumoConciliacao pelo chamador
 */
function blocoApiSimples(subEstado, resumoConciliacao, chaveLista, extras) {
  const bruto = subEstado?.resultado ?? null;
  const primeiroItem = Array.isArray(bruto?.[chaveLista]) ? bruto[chaveLista][0] ?? null : null;
  return {
    consultada: jaConsultou(subEstado),
    disponivel: !!resumoConciliacao,
    erro: subEstado?.erro ?? null,
    periodo: bruto?.periodo ?? null,
    ...extras,
    exemplo: primeiroItem ? sanitizarProfundo(primeiroItem) : null,
  };
}

// Formatador de dinheiro PRÓPRIO deste módulo (não importa fmtMoeda de
// utils.js de propósito — ifoodEstado.js não tem NENHUM import, nem de
// outro arquivo do próprio frontend, pra continuar 100% testável em Node
// sem DOM). Usado só nos 4 transformadores "saude*" abaixo e na exportação.
const fmtMoedaPura = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function dinheiroOuTraco(v) {
  return typeof v === "number" && Number.isFinite(v) ? fmtMoedaPura.format(v) : "—";
}

// ---------------------------------------------------------------------------
// "Saúde da Conciliação" / "Validações Financeiras" — 4 transformadores
// puros que reformatam os 4 pares já validados pelo Bloco H em
// {status, esperado, encontrado, diferenca, explicacao}, um formato uniforme
// pronto pra UI (Visão Geral, Evidências) e para a exportação. NENHUMA conta
// nova — só leitura de campos que ifoodFinancial.reconciliation.js já
// calculou (conciliarSalesComEvents/conciliarEventsComSettlements/
// conciliarSettlementsComReconciliation/resumirAnticipation).
// ---------------------------------------------------------------------------

/** hasTransferImpact: true/false vêm do iFood; qualquer outra coisa é desconhecido, nunca "Não". */
export function rotuloImpactoRepasse(v) {
  return v === true ? "Sim" : v === false ? "Não" : "Não informado";
}

// --- Pedidos iFood — rótulos do estado OFICIAL (status_oficial, vindo dos eventos) ---
export const STATUS_PEDIDO_UI = Object.freeze({
  PLACED: { rotulo: "Novo", classe: "warn" },
  CONFIRMED: { rotulo: "Confirmado", classe: "info" },
  SEPARATION_STARTED: { rotulo: "Em preparo", classe: "info" },
  SEPARATION_ENDED: { rotulo: "Preparo finalizado", classe: "info" },
  READY_TO_PICKUP: { rotulo: "Pronto para retirada", classe: "info" },
  DISPATCHED: { rotulo: "Despachado", classe: "info" },
  CONCLUDED: { rotulo: "Concluído", classe: "ok" },
  CANCELLED: { rotulo: "Cancelado", classe: "bad" },
});

/** Status oficial -> {rotulo, classe}. Sem status (evento ainda não processado) ou desconhecido: nunca inventa um estado. */
export function rotuloStatusPedido(status) {
  if (!status) return { rotulo: "Aguardando status", classe: "muted" };
  return STATUS_PEDIDO_UI[status] ?? { rotulo: String(status), classe: "muted" };
}

const TIPO_PEDIDO_UI = Object.freeze({ DELIVERY: "Entrega", TAKEOUT: "Retirada", DINE_IN: "Consumo no local", INDOOR: "Indoor" });

/** Tipo + quem entrega (entrega própria x entrega iFood). */
export function rotuloTipoPedido(tipo, entregaPor) {
  if (!tipo) return "—";
  const base = TIPO_PEDIDO_UI[tipo] ?? String(tipo);
  if (tipo !== "DELIVERY") return base;
  return entregaPor === "MERCHANT" ? `${base} própria` : entregaPor === "IFOOD" ? `${base} iFood` : base;
}

// --- Operação: Pedidos (app Order) e Eventos — estados PRÓPRIOS, separados de analytics/financial ---
//
// Linguagem operacional para o cliente: nada de lease/TTL/holder/estado técnico do supervisor. Nunca se
// trata falta de dado como problema de schema — falta de dado é "nenhum evento recebido ainda".
export const ORDER_ROTULO = "Pedidos / Order";
export const EVENTS_ROTULO = "Eventos";

// Erros do bloco `order` que dizem respeito ao RECEBIMENTO de eventos — aparecem no card Eventos, não no Order.
const ERROS_DE_EVENTOS = new Set(["WORKER_INATIVO", "EVENTOS_COM_FALHA"]);

/**
 * Bloco `order` do GET /status -> card "Pedidos / Order".
 *   order null      -> "Ainda não disponível para esta unidade" (fora do piloto; não é erro, sem ação)
 *   reauth_required -> "Reautenticação necessária"
 *   sem credencial  -> "Não conectado" (unidade piloto: pode conectar)
 *   ativa           -> "Conectado"
 * @returns {{ disponivel: boolean, chave: 'indisponivel'|'reauth'|'nao_conectado'|'conectado', rotulo: string,
 *   classe: string, linhas: Array<[string, string|null, 'texto'|'data']>, erro: {codigo, mensagem}|null,
 *   podeConectar: boolean }}
 */
export function derivarEstadoOrder(order) {
  if (!order) {
    return { disponivel: false, chave: "indisponivel", rotulo: "Ainda não disponível para esta unidade", classe: "muted", linhas: [], erro: null, podeConectar: false };
  }
  const erroOrder = order.erroAtual && !ERROS_DE_EVENTOS.has(order.erroAtual.codigo) ? order.erroAtual : null;
  if (order.status === "reauth_required") {
    return { disponivel: true, chave: "reauth", rotulo: "Reautenticação necessária", classe: "bad", linhas: [], erro: erroOrder, podeConectar: order.configurado === true };
  }
  if (!order.conectado) {
    return { disponivel: true, chave: "nao_conectado", rotulo: "Não conectado", classe: "muted", linhas: [], erro: null, podeConectar: order.configurado === true };
  }
  return {
    disponivel: true, chave: "conectado", rotulo: "Conectado", classe: "ok", erro: erroOrder, podeConectar: false,
    linhas: [
      ["Última autenticação", order.ultimaAutenticacao ?? null, "data"],
      ["Último pedido recebido", order.ultimoPedido ?? null, "data"],
    ],
  };
}

/**
 * Card "Eventos" — estado de alto nível do recebimento de eventos para ESTA unidade.
 * @param {{estado?: string, ultimoCicloOkEm?: string|null}|null|undefined} recebimento `eventosRecebimento` do GET /status
 * @param {object|null|undefined} order bloco `order` do GET /status
 *   Desativado                -> recebimento automático desligado neste ambiente
 *   Aguardando conexão Order  -> ligado, mas a unidade não tem o Order conectado
 *   Ativo                     -> recebendo
 *   Aguardando processamento  -> iniciando / outra instância processando (troca de versão, deploy)
 *   Atenção                   -> recebimento com problema
 * @returns {{ chave: string, rotulo: string, classe: string, linhas: Array<[string, string|null, 'texto'|'data']>, aviso: string|null }}
 */
export function derivarEstadoEvents(recebimento, order) {
  const tecnico = recebimento?.estado ?? "disabled";
  const conectado = order?.conectado === true;
  const erroEventos = order?.erroAtual && ERROS_DE_EVENTOS.has(order.erroAtual.codigo) ? order.erroAtual.mensagem : null;
  const linhas = conectado ? [
    ["Último evento recebido", order.ultimoEvento ?? null, "data"],
    ["Última sincronização", recebimento?.ultimoCicloOkEm ?? null, "data"],
  ] : [];

  if (tecnico === "disabled") {
    return { chave: "desativado", rotulo: "Desativado", classe: "muted", linhas, aviso: null };
  }
  if (!conectado) {
    return { chave: "aguardando_order", rotulo: "Aguardando conexão Order", classe: "muted", linhas: [], aviso: null };
  }
  if (tecnico === "active" && !erroEventos) {
    return { chave: "ativo", rotulo: "Ativo", classe: "ok", linhas, aviso: null };
  }
  if (tecnico === "starting" || tecnico === "waiting_lease") {
    return { chave: "aguardando", rotulo: "Aguardando processamento", classe: "info", linhas, aviso: null };
  }
  return { chave: "atencao", rotulo: "Atenção", classe: "warn", linhas, aviso: erroEventos ?? "O recebimento de eventos está com instabilidade no momento." };
}

/** Resumo agregado: "Atenção em N integração(ões)". Cada app continua com o seu próprio estado. */
export function textoAtencao(atencao) {
  const n = Number(atencao?.total) || 0;
  if (n <= 0) return null;
  return `Atenção em ${n} ${n === 1 ? "integração" : "integrações"}`;
}

/** @param {{status,quantidadeVendas,quantidadeConciliadas,quantidadeDivergentes,quantidadeIncompletas}} sv */
export function saudeSalesVsEvents(sv) {
  return {
    status: sv.status,
    esperado: `${sv.quantidadeVendas} venda(s) no período`,
    encontrado: `${sv.quantidadeConciliadas} conciliada(s) · ${sv.quantidadeIncompletas} incompleta(s)`,
    diferenca: `${sv.quantidadeDivergentes} divergente(s)`,
    explicacao: "Cada venda (Sales) é comparada com a soma dos eventos financeiros com impacto no repasse daquele pedido — comparação por pedido, não por total do período.",
  };
}
/** @param {{status,settlementBalance,somaEventosImpactantes,divergencia}} es */
export function saudeEventsVsSettlements(es) {
  return {
    status: es.status,
    esperado: dinheiroOuTraco(es.settlementBalance),
    encontrado: dinheiroOuTraco(es.somaEventosImpactantes),
    diferenca: es.divergencia != null ? dinheiroOuTraco(es.divergencia) : "—",
    explicacao: "Soma dos eventos financeiros com impacto no repasse do período comparada ao saldo (balance) devolvido pela API Settlements.",
  };
}
/** @param {{status,settlementBalance,totalReconciliationIdentificado,divergencia,motivo}} sr */
export function saudeSettlementsVsReconciliation(sr) {
  return {
    status: sr.status,
    esperado: dinheiroOuTraco(sr.settlementBalance),
    encontrado: sr.totalReconciliationIdentificado != null ? dinheiroOuTraco(sr.totalReconciliationIdentificado) : "—",
    diferenca: sr.divergencia != null ? dinheiroOuTraco(sr.divergencia) : "—",
    explicacao: sr.motivo || "Total identificado no arquivo de conciliação (Reconciliation) comparado ao saldo do Settlements.",
  };
}
/** @param {{consistente: boolean|null, itensAvaliados: number, itensInconsistentes: object[]}} a */
export function saudeAnticipation(a) {
  const status = a.itensAvaliados === 0 ? "SEM_DADOS" : a.consistente ? "CONCILIADO" : "DIVERGENTE";
  return {
    status,
    esperado: `${a.itensAvaliados} avaliado(s)`,
    encontrado: `${a.itensInconsistentes.length} inconsistente(s)`,
    diferenca: `${a.itensInconsistentes.length} inconsistente(s)`,
    explicacao: "valorOriginal - taxa.valor comparado a valorAntecipado (tolerância de 1 centavo) — só quando os 3 campos vêm preenchidos pela API Anticipation.",
  };
}

/**
 * Monta a evidência de homologação inteira — SÓ leitura do que já existe em
 * `financeiro` (mesmo objeto que vive em estado.financeiro em ifood.js) e em
 * `status` (estado.status). Pura: mesma entrada -> mesma saída, sem rede,
 * sem Date.now() interno (o chamador stampa `geradoEm`).
 * @param {{geradoEm: string, status: object|null, financeiro: object}} p
 */
export function montarEvidenciaHomologacao({ geradoEm, status, financeiro }) {
  const fin = financeiro ?? {};
  const rc = fin.conciliation?.resultado ?? null; // resultado de obterConciliacaoFinanceira()
  const fontes = derivarFontesConciliacao(rc);

  const resumo = {
    periodoConsultado: rc?.periodo ?? null,
    competencia: rc?.reconciliation?.competencia ?? fin.reconciliation?.competencia ?? null,
    // As 5 fontes do Bloco H só existem como conceito quando o Bloco H
    // rodou (Promise.allSettled tenta as 5 sempre juntas) — sem `rc`, nada
    // foi consultado ainda por esse caminho.
    fontesConsultadas: rc ? fontes.map((f) => f.fonte) : [],
    fontesDisponiveis: rc ? fontes.filter((f) => f.disponivel).map((f) => f.fonte) : [],
    fontesComErro: rc?.fontesComErro ?? [],
    statusGeralConciliacao: rc?.conciliacao?.statusGeral ?? null,
  };

  const apis = {
    sales: blocoApiSimples(fin.sales, rc?.vendas, "vendas", {
      quantidade: rc?.vendas?.quantidade ?? null,
      valorBruto: rc?.vendas?.bruto ?? null,
      saldo: rc?.vendas?.saldoVendas ?? null,
    }),
    events: blocoApiSimples(fin.events, rc?.eventos, "eventos", {
      quantidade: rc?.eventos?.quantidade ?? null,
      creditos: rc?.eventos?.creditos ?? null,
      debitos: rc?.eventos?.debitos ?? null,
      comImpactoTransferencia: rc?.eventos?.comImpactoTransferencia ?? null,
      semImpactoTransferencia: rc?.eventos?.semImpactoTransferencia ?? null,
      saldoImpactante: rc?.eventos?.saldoImpactante ?? null,
    }),
    settlements: blocoApiSimples(fin.settlements, rc?.settlements, "titulos", {
      quantidade: rc?.settlements?.quantidade ?? null,
      balance: rc?.settlements?.balance ?? null,
      closingItemsTotal: rc?.settlements?.closingItemsTotal ?? null,
    }),
    anticipation: blocoApiSimples(fin.anticipation, rc?.anticipation, "antecipacoes", {
      quantidade: rc?.anticipation?.quantidade ?? null,
      valorOriginal: rc?.anticipation?.valorOriginal ?? null,
      taxas: rc?.anticipation?.taxas ?? null,
      valorAntecipado: rc?.anticipation?.valorAntecipado ?? null,
    }),
    // Reconciliation MENSAL — só o resultado da consulta mensal. O On Demand
    // tem bloco próprio (`reconciliationOnDemand`, abaixo): as duas fontes
    // nunca se completam uma com a outra.
    reconciliation: (() => {
      const subEstado = fin.reconciliation ?? {};
      const arquivo = subEstado.resultado?.arquivo ?? null;
      const primeiraLinha = Array.isArray(arquivo?.linhas) ? arquivo.linhas[0] ?? null : null;
      return {
        consultada: jaConsultou(subEstado),
        disponivel: !!rc?.reconciliation?.disponivel,
        erro: subEstado.erro ?? null,
        competencia: rc?.reconciliation?.competencia ?? subEstado.competencia ?? null,
        quantidadeRegistros: rc?.reconciliation?.quantidadeRegistros ?? null,
        hashVerificado: arquivo?.integridadeVerificada ?? null, // true/false/null (null = iFood não mandou sha256)
        formatoDetectado: arquivo ? (arquivo.eraGzip ? "csv_gzip" : "csv") : null,
        delimitadorDetectado: arquivo?.delimitador ?? null,
        exemplo: primeiraLinha ? sanitizarProfundo(primeiraLinha) : null,
      };
    })(),
  };

  const ambiente = status?.homologacao || status?.financialHomologacao ? "homologacao" : "producao";

  // Forma UNIFORME {status,esperado,encontrado,diferenca,explicacao} nos 4
  // pares — mesmos transformadores puros "saude*" usados na Visão Geral, só
  // reformatação do que o Bloco H já calculou (ver comentário deles acima).
  const validacoes = rc ? {
    disponivel: true,
    salesVsEvents: saudeSalesVsEvents(rc.conciliacao.salesVsEvents),
    eventsVsSettlements: saudeEventsVsSettlements(rc.conciliacao.eventsVsSettlements),
    settlementsVsReconciliation: saudeSettlementsVsReconciliation(rc.conciliacao.settlementsVsReconciliation),
    anticipation: saudeAnticipation({
      consistente: rc.anticipation?.consistente ?? null,
      itensAvaliados: rc.anticipation?.itensAvaliados ?? 0,
      itensInconsistentes: rc.anticipation?.itensInconsistentes ?? [],
    }),
    divergencias: rc.conciliacao.divergencias ?? [],
    statusGeral: rc.conciliacao.statusGeral ?? null,
  } : {
    disponivel: false, salesVsEvents: null, eventsVsSettlements: null, settlementsVsReconciliation: null,
    anticipation: null, divergencias: [], statusGeral: null,
  };

  return {
    geradoEm: geradoEm ?? null,
    ambiente,
    merchant: status?.merchant ?? null,
    resumo,
    apis,
    reconciliationOnDemand: montarEvidenciaOnDemand(fin.reconciliation?.onDemand, { ambiente }),
    validacoes,
  };
}

/** requestId para evidência/tela: `abcd****wxyz`. O valor persistido não muda. */
export function mascararRequestId(id) {
  const s = typeof id === "string" ? id.trim() : "";
  if (!s) return null;
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/**
 * Cópia do item (venda/evento) para o bloco "Detalhe técnico (JSON
 * sanitizado)": `merchant.id` (Sales) e `comerciante.id` (Events) saem
 * mascarados (`abcd****wxyz`), e qualquer outra ocorrência do MESMO id no
 * JSON também. Nunca muta o original (a tela e os cálculos seguem usando
 * ele). Valores financeiros e demais campos ficam intactos. PURA.
 */
export function itemParaJsonTecnico(item) {
  if (!item || typeof item !== "object") return item;
  const copia = JSON.parse(JSON.stringify(item));
  const ids = new Set([copia.merchant?.id, copia.comerciante?.id].filter((v) => typeof v === "string" && v.trim()));
  if (!ids.size) return copia;
  const mascarar = (v) => {
    if (typeof v === "string") return ids.has(v) ? mascararRequestId(v) : v;
    if (Array.isArray(v)) return v.map(mascarar);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mascarar(x)]));
    return v;
  };
  return mascarar(copia);
}

/**
 * Solicitação On Demand HISTÓRICA (expirada, > 24h) — vem do
 * banco via GET .../on-demand?competencia= com `historico: true`. Só rótulos
 * para exibição/evidência; nada aqui retoma acompanhamento. PURA.
 */
export function derivarHistoricoOnDemand(h) {
  if (!h || h.historico !== true) return null;
  const situacao = h.status === "error" ? { rotulo: FASE_ON_DEMAND_ROTULO.falhou, classe: "bad" }
    : h.status === "processed" ? { rotulo: "Concluída", classe: "ok" }
    : { rotulo: "Encerrada sem status final (validade expirada)", classe: "muted" };
  return {
    situacao,
    statusRotulo: STATUS_OD_HISTORICO_ROTULO[h.status] ?? h.status ?? "—",
    erro: h.status === "error" ? (h.mensagemErro || MENSAGEM_ERRO_OD_SEM_MOTIVO) : null,
    validade: h.expirado ? "Expirada (janela de 24h do iFood encerrada)" : "Dentro da janela de 24h",
  };
}
const STATUS_OD_HISTORICO_ROTULO = Object.freeze({ solicitado: "Solicitada", created: "Criada", enqueue: "Na fila", enqueued: "Na fila", processed: "Concluída", error: "Erro" });

/**
 * Evidência da Reconciliation ON DEMAND — lê SÓ o sub-estado do On Demand
 * (`financeiro.reconciliation.onDemand`): requestId da solicitação e o
 * resultado do GET de status desse requestId (arquivo já parseado pelo
 * backend). Nunca recebe nem consulta o Reconciliation mensal — campo que o
 * On Demand ainda não tem fica null, sem herdar valor de outra fonte. PURA.
 * @param {object|undefined} od estado.financeiro.reconciliation.onDemand
 * @param {{ambiente: string}} opts
 */
export function montarEvidenciaOnDemand(od, { ambiente } = {}) {
  const sub = od ?? {};
  const resultado = sub.resultado ?? null;
  const requestId = sub.requestId ?? resultado?.requestId ?? null;
  // Sem solicitação acompanhada nesta sessão, mas com histórico gravado no
  // banco (expirada): evidência do estado PERSISTIDO, requestId já mascarado.
  const hist = !requestId && sub.historico?.historico === true ? sub.historico : null;
  if (hist) {
    return {
      tipo: "reconciliation_on_demand", ambiente: ambiente ?? null, amostraHomologacao: ambiente === "homologacao",
      solicitado: true, historico: true, competencia: hist.competencia ?? sub.competencia ?? null,
      requestId: hist.requestIdMascarado ?? null, status: hist.status ?? null, reutilizado: null,
      solicitadoEm: hist.solicitadoEm ?? null, expirado: hist.expirado === true,
      csvProcessado: false, quantidadeLinhas: null, totalBruto: null, impactoRepasseSim: null, impactoRepasseNao: null,
      linhasImpactoSim: null, linhasImpactoNao: null, linhasImpactoNaoInformado: null, valorLiquidoConsiderado: null,
      formatoDetectado: null, delimitadorDetectado: null, arquivo: null, tamanhoArquivo: null,
      erro: hist.status === "error" ? (hist.mensagemErro ?? MENSAGEM_ERRO_OD_SEM_MOTIVO) : null,
    };
  }
  // Só o resultado do MESMO requestId conta (troca de solicitação = resultado antigo descartado).
  const doRequest = resultado && (!resultado.requestId || !requestId || resultado.requestId === requestId) ? resultado : null;
  const arquivo = doRequest?.arquivo ?? null;
  const resumo = arquivo?.resumoRepasse ?? null;
  const baixado = sub.arquivoBaixado && sub.arquivoBaixado.requestId === requestId ? sub.arquivoBaixado : null;
  return {
    tipo: "reconciliation_on_demand",
    ambiente: ambiente ?? null,
    amostraHomologacao: ambiente === "homologacao",
    solicitado: !!requestId,
    historico: false,
    competencia: doRequest?.competencia ?? sub.competencia ?? null,
    requestId: mascararRequestId(requestId),
    status: doRequest?.status ?? (requestId ? "solicitado" : null),
    reutilizado: requestId ? sub.reutilizado === true : null,
    csvProcessado: !!arquivo,
    quantidadeLinhas: arquivo?.totalLinhas ?? null,
    totalBruto: resumo?.totalBruto ?? null,
    impactoRepasseSim: resumo?.totalComImpacto ?? null,
    impactoRepasseNao: resumo?.totalSemImpacto ?? null,
    linhasImpactoSim: resumo?.linhasComImpacto ?? null,
    linhasImpactoNao: resumo?.linhasSemImpacto ?? null,
    linhasImpactoNaoInformado: resumo?.linhasImpactoNaoInformado ?? null,
    // Regra de homologação: só impacto_no_repasse = SIM compõe o líquido.
    valorLiquidoConsiderado: resumo?.totalComImpacto ?? null,
    formatoDetectado: arquivo ? (arquivo.eraGzip ? "csv_gzip" : "csv") : null,
    delimitadorDetectado: arquivo?.delimitador ?? null,
    arquivo: baixado?.nome ?? null,
    tamanhoArquivo: typeof baixado?.bytes === "number" ? baixado.bytes : null,
    erro: doRequest?.status === "error" ? (doRequest.mensagemErro ?? MENSAGEM_ERRO_OD_SEM_MOTIVO) : (sub.erro ?? sub.erroDownload ?? null),
  };
}

// ---------------------------------------------------------------------------
// Exportação da evidência (JSON / HTML) — conteúdo puro, sem tocar em disco
// nem em `document`. Quem efetivamente baixa o arquivo é ifood.js (Blob +
// link temporário), pra manter este módulo sem DOM.
// ---------------------------------------------------------------------------

/** JSON sanitizado da evidência inteira — a MESMA sanitização usada nos
 * exemplos por API e no Modo Técnico, aplicada de novo aqui em cima do
 * objeto completo como última rede de segurança antes de sair do sistema. */
export function montarExportacaoJson(evidencia) {
  return JSON.stringify(sanitizarProfundo(evidencia), null, 2);
}

function escHtmlExport(v) {
  return String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const ROTULO_FONTE_EXPORT = Object.freeze({
  sales: "Sales", events: "Financial Events", settlements: "Settlements",
  reconciliation: "Reconciliation", anticipations: "Anticipation",
});

/**
 * Documento HTML autocontido (sem CSS/JS externo) com o resumo da evidência
 * — pensado pra ser aberto offline e anexado a um e-mail/ticket de
 * homologação. Mesma sanitização do JSON (nenhum segredo pode aparecer).
 */
export const TEXTO_FONTE_ON_DEMAND = "Dados obtidos a partir do arquivo gerado para esta solicitação.";
export const TEXTO_AMOSTRA_HOMOLOGACAO = "Dados de exemplo do ambiente de homologação do iFood";

const dinheiroExport = (v) => (typeof v === "number" ? `R$ ${v.toFixed(2).replace(".", ",")}` : "—");

/** Seção "Conciliação sob demanda" do HTML exportado — só o bloco do On Demand. */
function blocoOnDemandHtml(od) {
  if (!od) return "";
  const linha = (rotulo, valor) => `<dt>${escHtmlExport(rotulo)}</dt><dd>${escHtmlExport(valor)}</dd>`;
  return `
  <h2>Conciliação sob demanda</h2>
  <p>${escHtmlExport(TEXTO_FONTE_ON_DEMAND)}</p>
  ${od.amostraHomologacao ? `<p><strong>${escHtmlExport(TEXTO_AMOSTRA_HOMOLOGACAO)}</strong></p>` : ""}
  ${!od.solicitado ? "<p><em>Nenhuma solicitação On Demand nesta sessão.</em></p>" : `
  <dl>
    ${linha("Tipo", od.tipo)}
    ${linha("Competência", od.competencia)}
    ${linha("Identificador (requestId)", od.requestId)}
    ${linha("Status", od.status)}
    ${linha("Solicitação reaproveitada", od.reutilizado ? "sim" : "não")}
    ${linha("CSV processado", od.csvProcessado ? "sim" : "não processado")}
    ${linha("Quantidade de linhas", od.quantidadeLinhas ?? "indisponível")}
    ${linha("Total bruto", dinheiroExport(od.totalBruto))}
    ${linha("Impacto no repasse = SIM", `${dinheiroExport(od.impactoRepasseSim)} (${od.linhasImpactoSim ?? "—"} linha(s))`)}
    ${linha("Impacto no repasse = NÃO", `${dinheiroExport(od.impactoRepasseNao)} (${od.linhasImpactoNao ?? "—"} linha(s))`)}
    ${linha("Valor líquido considerado", dinheiroExport(od.valorLiquidoConsiderado))}
    ${linha("Arquivo", od.arquivo ?? "—")}
    ${linha("Tamanho do arquivo (bytes)", od.tamanhoArquivo ?? "—")}
    ${od.erro ? linha("Erro", od.erro) : ""}
  </dl>`}`;
}

export function montarExportacaoHtml(evidencia) {
  const e = sanitizarProfundo(evidencia);
  const r = e.resumo;
  const v = e.validacoes;

  const linhaValidacao = (rotulo, info) => !info ? "" : `
    <tr><td>${escHtmlExport(rotulo)}</td><td>${escHtmlExport(info.status)}</td>
        <td>${escHtmlExport(info.esperado)}</td>
        <td>${escHtmlExport(info.encontrado)}</td>
        <td>${escHtmlExport(info.diferenca)}</td></tr>`;

  const linhasDivergencias = (v.divergencias ?? []).map((d) => `
    <tr><td>${escHtmlExport(d.codigo)}</td><td>${escHtmlExport(d.origem)}</td>
        <td>${escHtmlExport(d.esperado)}</td><td>${escHtmlExport(d.encontrado)}</td>
        <td>${escHtmlExport(d.diferenca)}</td><td>${escHtmlExport(d.explicacao)}</td></tr>`).join("");

  const blocosExemplo = Object.entries(e.apis).map(([fonte, bloco]) => `
    <h3>${escHtmlExport(ROTULO_FONTE_EXPORT[fonte === "anticipation" ? "anticipations" : fonte] ?? fonte)}</h3>
    <p>Consultada: ${bloco.consultada ? "sim" : "não"} · Disponível: ${bloco.disponivel ? "sim" : "não"}${bloco.erro ? ` · Erro: ${escHtmlExport(bloco.erro)}` : ""}</p>
    ${bloco.exemplo ? `<pre>${escHtmlExport(JSON.stringify(bloco.exemplo, null, 2))}</pre>` : "<p><em>Sem exemplo consultado nesta sessão.</em></p>"}`).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Evidência de Homologação Financeira — iFood</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#1a1a1a;max-width:900px;margin:32px auto;padding:0 20px}
  h1{font-size:20px} h2{font-size:16px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px} h3{font-size:14px;margin-top:20px}
  table{border-collapse:collapse;width:100%;margin:8px 0} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:13px}
  th{background:#f4f4f4} dl{display:grid;grid-template-columns:200px 1fr;gap:4px 12px;margin:8px 0}
  dt{color:#666} dd{margin:0} pre{background:#f7f7f7;border:1px solid #eee;padding:10px;overflow:auto;font-size:12px}
</style></head><body>
  <h1>Evidência de Homologação Financeira — iFood</h1>
  <dl>
    <dt>Merchant</dt><dd>${escHtmlExport(e.merchant?.nome || e.merchant?.idMascarado || "—")}</dd>
    <dt>Ambiente</dt><dd>${e.ambiente === "homologacao" ? "Homologação" : "Produção"}</dd>
    <dt>Período consultado</dt><dd>${escHtmlExport(r.periodoConsultado?.inicio)} a ${escHtmlExport(r.periodoConsultado?.fim)}</dd>
    <dt>Competência</dt><dd>${escHtmlExport(r.competencia)}</dd>
    <dt>Gerado em</dt><dd>${escHtmlExport(e.geradoEm)}</dd>
    <dt>Status geral da conciliação</dt><dd>${escHtmlExport(r.statusGeralConciliacao)}</dd>
  </dl>

  <h2>Fontes</h2>
  <dl>
    <dt>Consultadas</dt><dd>${r.fontesConsultadas.map((f) => escHtmlExport(ROTULO_FONTE_EXPORT[f] ?? f)).join(", ") || "—"}</dd>
    <dt>Disponíveis</dt><dd>${r.fontesDisponiveis.map((f) => escHtmlExport(ROTULO_FONTE_EXPORT[f] ?? f)).join(", ") || "—"}</dd>
    <dt>Com erro</dt><dd>${r.fontesComErro.map((f) => `${escHtmlExport(ROTULO_FONTE_EXPORT[f.fonte] ?? f.fonte)} (${escHtmlExport(f.mensagem)})`).join("; ") || "Nenhuma"}</dd>
  </dl>

  <h2>Resultados resumidos por API</h2>
  ${blocosExemplo}

  ${blocoOnDemandHtml(e.reconciliationOnDemand)}

  <h2>Validações financeiras</h2>
  ${v.disponivel ? `
  <table>
    <thead><tr><th>Validação</th><th>Status</th><th>Esperado</th><th>Encontrado</th><th>Diferença</th></tr></thead>
    <tbody>
      ${linhaValidacao("Sales × Events", v.salesVsEvents)}
      ${linhaValidacao("Events × Settlements", v.eventsVsSettlements)}
      ${linhaValidacao("Settlements × Reconciliation", v.settlementsVsReconciliation)}
      ${linhaValidacao("Anticipation (matemática)", v.anticipation)}
    </tbody>
  </table>
  <h3>Divergências (${v.divergencias.length})</h3>
  ${v.divergencias.length ? `<table><thead><tr><th>Código</th><th>Origem</th><th>Esperado</th><th>Encontrado</th><th>Diferença</th><th>Explicação</th></tr></thead><tbody>${linhasDivergencias}</tbody></table>` : "<p>Nenhuma divergência encontrada.</p>"}
  ` : "<p><em>Conciliação (Bloco H) ainda não foi consultada nesta sessão — sem validações para mostrar.</em></p>"}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Sales — dados mínimos exigidos pela homologação Financial ("Método de
// pagamento e responsável", "Comissões e taxas aplicadas"). PURO: só lê o
// que ifoodFinancial.mapper.js#mapearVenda já entrega (`pagamentos[]`,
// `resumoFinanceiro.lancamentos[]`). Valores de enum desconhecidos aparecem
// como vieram — nunca um significado inventado.
// ---------------------------------------------------------------------------

const METODO_PAGAMENTO_ROTULO = Object.freeze({
  CREDIT: "Cartão de crédito",
  DEBIT: "Cartão de débito",
  CASH: "Dinheiro",
  PIX: "Pix",
  MEAL_VOUCHER: "Vale-refeição",
  FOOD_VOUCHER: "Vale-alimentação",
  DIGITAL_WALLET: "Carteira digital",
});

/** Método de pagamento (CREDIT, CASH, PIX...) -> rótulo em português. */
export function rotuloMetodoPagamento(metodo) {
  if (!metodo) return "Não informado";
  return METODO_PAGAMENTO_ROTULO[String(metodo).toUpperCase()] ?? String(metodo);
}

/** `liability` do método: quem recebe/responde pelo pagamento. */
export function rotuloResponsavelPagamento(liability) {
  const v = String(liability ?? "").toUpperCase();
  if (v === "IFOOD") return "iFood";
  if (v === "MERCHANT") return "Loja";
  return liability ? String(liability) : "Não informado";
}

/** ONLINE (pago no app) x OFFLINE (pago na entrega). */
export function rotuloTipoPagamento(tipo) {
  const v = String(tipo ?? "").toUpperCase();
  if (v === "ONLINE") return "Online (no app)";
  if (v === "OFFLINE") return "Na entrega";
  return tipo ? String(tipo) : "Não informado";
}

/** Resumo curto dos pagamentos de uma venda para a coluna da tabela. */
export function resumirPagamentosVenda(pagamentos) {
  const lista = Array.isArray(pagamentos) ? pagamentos : [];
  if (!lista.length) return { metodo: "Não informado", responsavel: "Não informado" };
  const metodos = [...new Set(lista.map((p) => rotuloMetodoPagamento(p?.metodo)))];
  const responsaveis = [...new Set(lista.map((p) => rotuloResponsavelPagamento(p?.responsavel)))];
  return { metodo: metodos.join(" + "), responsavel: responsaveis.join(" + ") };
}

// Nomes de `billingSummary.billingEntries[].name` vistos na documentação oficial
// (API Sales / Mapeamento de APIs). Nome fora daqui aparece cru.
const LANCAMENTO_VENDA_ROTULO = Object.freeze({
  ORDER_PAYMENT: "Pagamento do pedido",
  ORDER_COMMISSION: "Comissão do iFood",
  SERVICE_FEE: "Taxa de serviço",
  DELIVERY_FEE_IFOOD: "Taxa de entrega (iFood)",
  PAYMENT_TRANSACTION_FEE: "Taxa de transação do pagamento",
  IFOOD_SUBSIDY: "Subsídio do iFood",
  CHAIN_SUBSIDY: "Subsídio da rede",
  STORE_SUBSIDY: "Subsídio da loja",
});

export function rotuloLancamentoVenda(nome) {
  if (!nome) return "Lançamento sem nome";
  return LANCAMENTO_VENDA_ROTULO[nome] ?? String(nome);
}

const somaCentavos = (itens) => Math.round(itens.reduce((s, i) => s + Math.round((i.valor ?? 0) * 100), 0)) / 100;

/**
 * Separa os lançamentos da venda em comissões (nome com COMMISSION), taxas
 * (nome com FEE) e demais lançamentos — classificação pelo NOME oficial, sem
 * recalcular nada. Totais em reais (soma em centavos).
 */
export function classificarLancamentosVenda(resumoFinanceiro) {
  const lancamentos = Array.isArray(resumoFinanceiro?.lancamentos) ? resumoFinanceiro.lancamentos : [];
  const comRotulo = lancamentos.map((l) => ({ nome: l?.nome ?? null, rotulo: rotuloLancamentoVenda(l?.nome), valor: typeof l?.valor === "number" ? l.valor : null }));
  const ehComissao = (l) => /COMMISSION/i.test(l.nome ?? "");
  const ehTaxa = (l) => !ehComissao(l) && /FEE/i.test(l.nome ?? "");
  const comissoes = comRotulo.filter(ehComissao);
  const taxas = comRotulo.filter(ehTaxa);
  const outros = comRotulo.filter((l) => !ehComissao(l) && !ehTaxa(l));
  return {
    informado: lancamentos.length > 0,
    comissoes, taxas, outros,
    totalComissoes: comissoes.length ? somaCentavos(comissoes) : null,
    totalTaxas: taxas.length ? somaCentavos(taxas) : null,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation On Demand — rótulos da fase do acompanhamento automático.
// ---------------------------------------------------------------------------
/** Status "error" do On Demand sem o campo oficial `message`. */
export const MENSAGEM_ERRO_OD_SEM_MOTIVO = "O iFood informou erro na geração do arquivo, sem detalhar o motivo.";

export const FASE_ON_DEMAND_ROTULO = Object.freeze({
  solicitando: "Enviando solicitação ao iFood…",
  processando: "Processando no iFood — acompanhando automaticamente",
  instavel: "iFood instável — tentando de novo automaticamente",
  concluido: "Concluída — arquivo disponível",
  falhou: "A geração do arquivo falhou no iFood",
  erro: "Não foi possível acompanhar a solicitação",
  tempo_esgotado: "Ainda processando — acompanhamento automático pausado",
  cancelado: "Acompanhamento interrompido",
});

// ---------------------------------------------------------------------------
// Reconciliation mensal: competência CONSULTADA x competência DOS REGISTROS.
// O backend devolve a consultada (`resultado.competencia`, eco do parâmetro
// enviado ao iFood) e as competências contadas na coluna `competencia` do CSV
// (`arquivo.competenciasArquivo`). No ambiente de homologação o iFood devolve
// um arquivo de exemplo com competência própria (ex.: consulta 2026-09 ->
// registros 2025-08). A interface NUNCA apresenta a competência dos registros
// como se fosse a consultada, e nunca converte uma na outra.
// ---------------------------------------------------------------------------

/** "2026-09" -> "09/2026"; qualquer outro formato volta como veio. */
export function fmtCompetencia(c) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(c ?? "").trim());
  return m ? `${m[2]}/${m[1]}` : String(c ?? "");
}

/**
 * PURA. Compara a competência consultada com as competências do arquivo.
 * `situacao`:
 *   - null           — sem resultado/arquivo, ou o CSV não tem a coluna `competencia`;
 *   - "confere"      — todos os registros com competência são da consultada;
 *   - "amostra"      — divergem, e a unidade está em homologação (fixture do iFood);
 *   - "divergente"   — divergem FORA da homologação (dado real inconsistente: alerta).
 * @param {object|null} resultado resposta de GET /financial/reconciliation
 * @param {{homologacao?: boolean}} [opts] decisão do backend (/status.financialHomologacao)
 */
export function derivarCompetenciaReconciliation(resultado, { homologacao = false } = {}) {
  const consultada = resultado?.competencia ?? null;
  const ca = resultado?.arquivo?.competenciasArquivo;
  const noArquivo = ca?.colunaEncontrada ? ca.competencias ?? [] : [];
  const base = { consultada, noArquivo, situacao: null };
  if (!consultada || !ca?.colunaEncontrada || noArquivo.length === 0) return base;
  const confere = noArquivo.every((x) => x.competencia === consultada);
  if (confere) return { ...base, situacao: "confere" };
  return { ...base, situacao: homologacao === true ? "amostra" : "divergente" };
}
