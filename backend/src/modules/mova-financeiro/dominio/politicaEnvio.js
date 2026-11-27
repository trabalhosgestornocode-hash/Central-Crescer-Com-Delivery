// MOVA — política de ENVIO do WhatsApp: categorias, prioridades, limites configuráveis, capacidade reservada, alertas de uso e
// retentativa. É puro (sem banco, sem relógio): o enviador (gateway/worker.js) e o painel só o consultam.
//
// Princípios (decisão do proprietário, 28/11):
//   * categorias NÃO são equivalentes: resposta pedida por pessoa e mensagem de erro não consomem o teto de mensagens
//     PROATIVAS; notificação transacional, aviso administrativo, acompanhamento e reenvio consomem;
//   * prioridade reserva capacidade: a CRÍTICA pode usar o que as demais não podem, então avisos de menor importância nunca
//     consomem toda a disponibilidade do dia;
//   * atingir um limite NUNCA descarta: o item é ADIADO (continua na fila persistente, com validade) e o represamento é alertado;
//   * os limites internos são piso de proteção, não autorização para disparo indiscriminado: o ritmo (por minuto) e o
//     circuit breaker respeitam as restrições do Gateway/provedor e valem para TODAS as categorias.

export const CATEGORIA = Object.freeze({
  RESPOSTA: "RESPOSTA",             // pedida diretamente por uma pessoa (sem teto diário de quantidade)
  ERRO: "ERRO",                     // mensagem de erro/recusa a uma pessoa (sem teto diário; ritmo controlado)
  TRANSACIONAL: "TRANSACIONAL",     // consequência de um fato financeiro persistido (pagamento, nota conferida, estorno)
  PROATIVA: "PROATIVA",             // iniciativa do MOVA (demonstrativo semanal, solicitação de nota)
  ADMINISTRATIVA: "ADMINISTRATIVA", // aviso à gestão (fechamento, falhas, represamento)
  ACOMPANHAMENTO: "ACOMPANHAMENTO", // lembrete/cobrança
  REENVIO: "REENVIO",               // nova tentativa deliberada de algo já enviado
});
export const CATEGORIAS = Object.freeze(Object.values(CATEGORIA));
/** Só estas categorias consomem o teto de mensagens PROATIVAS. */
export const CATEGORIAS_CONTADAS = Object.freeze([CATEGORIA.TRANSACIONAL, CATEGORIA.PROATIVA, CATEGORIA.ADMINISTRATIVA, CATEGORIA.ACOMPANHAMENTO, CATEGORIA.REENVIO]);

export const PRIORIDADE = Object.freeze({ CRITICA: 0, ALTA: 1, NORMAL: 2 });
export const NOME_DA_PRIORIDADE = Object.freeze(["CRITICA", "ALTA", "NORMAL"]);

/** Limites iniciais (autorização do proprietário, 28/11/2026). Tudo configurável sem deploy (tabela mova.limite_envio). */
export const LIMITES_PADRAO = Object.freeze({
  proativasDia: 2000,            // mensagens automáticas proativas por dia (todas as conversas)
  proativasPorPrivadoDia: 100,   // por conversa privada por dia
  proativasPorGrupoDia: 500,     // por grupo financeiro por dia
  reservaCriticaPct: 10,         // parte de cada teto reservada só à prioridade CRÍTICA
  reservaAltaPct: 10,            // parte seguinte reservada à ALTA (a NORMAL usa o que sobra)
  porMinutoTotal: 20,            // ritmo geral (provedor): qualquer categoria
  porMinutoPorConversa: 6,       // ritmo por conversa: qualquer categoria (barra laço e rajada)
  respostasPorConversaPorHora: 120, // controle de abuso de quem pergunta (resposta sem teto diário)
  circuitoFalhasSeguidas: 5,     // falhas seguidas do Gateway que abrem o circuito
  circuitoPausaSegundos: 120,    // pausa com o circuito aberto
  validadeHorasCritica: 72,
  validadeHorasAlta: 48,
  validadeHorasNormal: 24,
  alertaFaixas: "70,85,95",
});
export const CAMPOS_DE_LIMITE = Object.freeze(Object.keys(LIMITES_PADRAO));
/** Faixas mínimas/máximas aceitas na configuração (proteção contra valor absurdo; o provedor segue mandando). */
export const FAIXA_DO_CAMPO = Object.freeze({
  proativasDia: [0, 100000], proativasPorPrivadoDia: [0, 5000], proativasPorGrupoDia: [0, 20000],
  reservaCriticaPct: [0, 50], reservaAltaPct: [0, 50], porMinutoTotal: [1, 600], porMinutoPorConversa: [1, 60], respostasPorConversaPorHora: [1, 2000],
  circuitoFalhasSeguidas: [1, 100], circuitoPausaSegundos: [5, 3600], validadeHorasCritica: [1, 720], validadeHorasAlta: [1, 720], validadeHorasNormal: [1, 720],
});

export const ESCOPO = Object.freeze({ GLOBAL: "GLOBAL", EMPRESA: "EMPRESA", UNIDADE: "UNIDADE", GRUPO: "GRUPO", FINALIDADE: "FINALIDADE" });
const PRECEDENCIA = [ESCOPO.GLOBAL, ESCOPO.EMPRESA, ESCOPO.UNIDADE, ESCOPO.FINALIDADE, ESCOPO.GRUPO]; // o último vence

/** Valida UMA regra de limite vinda do painel. Devolve { ok, erro? }. */
export function validarRegra({ escopo, chave, campo, valor }) {
  if (!Object.values(ESCOPO).includes(escopo)) return { ok: false, erro: "ESCOPO_INVALIDO" };
  if (escopo === ESCOPO.GLOBAL ? chave !== "*" : !/^[A-Za-z0-9@._:-]{1,120}$/.test(String(chave ?? ""))) return { ok: false, erro: "CHAVE_INVALIDA" };
  if (escopo === ESCOPO.FINALIDADE && !CATEGORIAS.includes(chave)) return { ok: false, erro: "FINALIDADE_INVALIDA" };
  if (!CAMPOS_DE_LIMITE.includes(campo)) return { ok: false, erro: "CAMPO_INVALIDO" };
  if (campo === "alertaFaixas") return /^\d{1,2}(,\d{1,2}){0,4}$/.test(String(valor)) ? { ok: true } : { ok: false, erro: "VALOR_INVALIDO" };
  const faixa = FAIXA_DO_CAMPO[campo];
  if (!Number.isInteger(valor) || valor < faixa[0] || valor > faixa[1]) return { ok: false, erro: "VALOR_FORA_DA_FAIXA" };
  return { ok: true };
}

/**
 * Resolve os limites efetivos de UM envio. A regra mais específica vence (GLOBAL < EMPRESA < UNIDADE < FINALIDADE < GRUPO/destino).
 * `regras` = linhas { escopo, chave, campo, valor }. Regra de outra empresa/unidade/grupo nunca se aplica.
 */
export function resolverLimites({ regras = [], empresaId = null, unidadeId = null, destino = null, categoria = null, padrao = LIMITES_PADRAO } = {}) {
  const efetivo = { ...padrao };
  const aplicaveis = regras.filter((r) =>
    r.escopo === ESCOPO.GLOBAL || (r.escopo === ESCOPO.EMPRESA && r.chave === empresaId) || (r.escopo === ESCOPO.UNIDADE && r.chave === unidadeId)
    || (r.escopo === ESCOPO.GRUPO && r.chave === destino) || (r.escopo === ESCOPO.FINALIDADE && r.chave === categoria));
  for (const nivel of PRECEDENCIA) for (const r of aplicaveis) if (r.escopo === nivel && CAMPOS_DE_LIMITE.includes(r.campo)) efetivo[r.campo] = r.valor;
  return efetivo;
}

/** Fração máxima do teto que cada prioridade pode usar: a CRÍTICA usa tudo; ALTA deixa a reserva crítica; NORMAL deixa as duas. */
export function fracaoPermitida(prioridade, limites) {
  const crit = limites.reservaCriticaPct / 100, alta = limites.reservaAltaPct / 100;
  if (prioridade === PRIORIDADE.CRITICA) return 1;
  if (prioridade === PRIORIDADE.ALTA) return 1 - crit;
  return 1 - crit - alta;
}

/** Quanto do limite foi usado (0–100+) e em qual faixa de alerta (70/85/95) está; null abaixo da primeira faixa. */
export function faixaDeUso(usado, limite, faixas = LIMITES_PADRAO.alertaFaixas) {
  if (!(limite > 0)) return { pct: 0, faixa: null };
  const pct = Math.floor((usado / limite) * 100);
  const lista = String(faixas).split(",").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return { pct, faixa: [...lista].reverse().find((f) => pct >= f) ?? null };
}

/** Atraso (ms) antes da próxima tentativa: progressivo, com teto, e determinístico (sem aleatório) para ser testável. */
export function esperaDaTentativa(tentativas) {
  const n = Math.max(1, Number(tentativas) || 1);
  return Math.min(30 * 60_000, 15_000 * 2 ** (n - 1)); // 15 s, 30 s, 1 min, 2 min, … até 30 min
}

export const validadeEmMs = (prioridade, limites) =>
  3600_000 * (prioridade === PRIORIDADE.CRITICA ? limites.validadeHorasCritica : prioridade === PRIORIDADE.ALTA ? limites.validadeHorasAlta : limites.validadeHorasNormal);

/** Categoria e prioridade padrão de uma saída que não as declarou (compatível com o que já existia: resposta a um evento é RESPOSTA/CRÍTICA). */
export function classificarPadrao({ eventoId = null, respostaA = null, categoria = null, prioridade = null } = {}) {
  const cat = CATEGORIAS.includes(categoria) ? categoria : (eventoId || respostaA ? CATEGORIA.RESPOSTA : CATEGORIA.PROATIVA);
  const pri = Number.isInteger(prioridade) && prioridade >= 0 && prioridade <= 2 ? prioridade
    : cat === CATEGORIA.RESPOSTA || cat === CATEGORIA.ERRO ? PRIORIDADE.CRITICA : cat === CATEGORIA.TRANSACIONAL ? PRIORIDADE.CRITICA : cat === CATEGORIA.ACOMPANHAMENTO ? PRIORIDADE.NORMAL : PRIORIDADE.ALTA;
  return { categoria: cat, prioridade: pri };
}

/**
 * Decide o destino de UM item na fila. Nunca descarta: ou ENVIAR, ou ADIAR com o motivo e quando tentar de novo.
 * @param item  { categoria, prioridade, destinoTipo: "PRIVADO"|"GRUPO" }
 * @param uso   { dia, porDestino, porCategoria, ultimoMinuto, ultimoMinutoDestino, respostasHoraDestino } (contagens atuais)
 * @param limites resultado de resolverLimites
 * @param agora Date
 */
export function decidirEnvio({ item, uso, limites, agora, circuitoAbertoAte = null }) {
  const adiar = (motivo, ms) => ({ acao: "ADIAR", motivo, liberarEm: new Date(agora.getTime() + ms).toISOString() });
  if (circuitoAbertoAte && agora.getTime() < circuitoAbertoAte) return { acao: "ADIAR", motivo: "CIRCUITO_ABERTO", liberarEm: new Date(circuitoAbertoAte).toISOString() };
  // Ritmo (provedor/abuso): vale para TODAS as categorias.
  if ((uso.ultimoMinuto ?? 0) >= limites.porMinutoTotal) return adiar("RITMO_GERAL", 20_000);
  if ((uso.ultimoMinutoDestino ?? 0) >= limites.porMinutoPorConversa) return adiar("RITMO_DA_CONVERSA", 20_000);
  const contada = CATEGORIAS_CONTADAS.includes(item.categoria);
  if (!contada) {
    if (item.categoria === CATEGORIA.RESPOSTA && (uso.respostasHoraDestino ?? 0) >= limites.respostasPorConversaPorHora) return adiar("ABUSO_DE_RESPOSTAS_DA_CONVERSA", 5 * 60_000);
    return { acao: "ENVIAR", contada: false };
  }
  const f = fracaoPermitida(item.prioridade, limites);
  const tetoDestino = item.destinoTipo === "GRUPO" ? limites.proativasPorGrupoDia : limites.proativasPorPrivadoDia;
  if ((uso.dia ?? 0) >= Math.floor(limites.proativasDia * f)) return adiar("LIMITE_DIARIO", 15 * 60_000);
  if ((uso.porDestino ?? 0) >= Math.floor(tetoDestino * f)) return adiar("LIMITE_DA_CONVERSA", 15 * 60_000);
  return { acao: "ENVIAR", contada: true };
}

/** Circuit breaker mínimo e puro: registra o resultado de cada envio e diz até quando fica aberto. */
export function criarCircuito({ falhasSeguidas, pausaSegundos }) {
  let seguidas = 0, abertoAte = 0;
  return {
    sucesso() { seguidas = 0; abertoAte = 0; },
    falha(agora) { seguidas += 1; if (seguidas >= falhasSeguidas) { abertoAte = agora.getTime() + pausaSegundos * 1000; seguidas = 0; } return abertoAte; },
    get abertoAte() { return abertoAte; },
  };
}

/**
 * Classe (categoria + prioridade) de cada tipo de mensagem AUTOMÁTICA já existente no MOVA. Pedido do proprietário (28/11):
 * crítica = pagamento efetivado, nota conferida, divergência, estorno e respostas diretas; alta = demonstrativo semanal, solicitação
 * de nota, avisos de fechamento e avisos financeiros administrativos; normal = lembretes, acompanhamentos e resumos consolidados.
 */
export const CLASSE_POR_TIPO = Object.freeze({
  PAGAMENTO: { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA },
  PAGAMENTO_PARCIAL: { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA },
  ESTORNO: { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA },
  AVISO_GRUPO: { categoria: CATEGORIA.ADMINISTRATIVA, prioridade: PRIORIDADE.ALTA },
  SEMANAL: { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.ALTA },
  AVISO_DEMONSTRATIVO: { categoria: CATEGORIA.ADMINISTRATIVA, prioridade: PRIORIDADE.ALTA },
  AVISO_LIBERACAO: { categoria: CATEGORIA.ADMINISTRATIVA, prioridade: PRIORIDADE.ALTA },
  AVISO_NOTA_RECEBIDA: { categoria: CATEGORIA.ADMINISTRATIVA, prioridade: PRIORIDADE.ALTA },
  COBRANCA_NOTA: { categoria: CATEGORIA.ACOMPANHAMENTO, prioridade: PRIORIDADE.NORMAL },
  RELATORIO_QUARTA: { categoria: CATEGORIA.ADMINISTRATIVA, prioridade: PRIORIDADE.NORMAL },
});

/** Campos de enfileiramento de uma mensagem automática: classe do tipo, validade pela prioridade e escopo (empresa/unidade). */
export function enfileiramentoDoTipo(tipo, { agora = new Date(), organizacaoId = null, unidadeId = null, reenvio = false, limites = LIMITES_PADRAO } = {}) {
  const base = CLASSE_POR_TIPO[tipo] ?? { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.ALTA };
  const categoria = reenvio ? CATEGORIA.REENVIO : base.categoria;
  return { categoria, prioridade: base.prioridade, validaAte: new Date(agora.getTime() + validadeEmMs(base.prioridade, limites)).toISOString(), organizacaoId, unidadeId };
}
