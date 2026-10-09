// Checklist Operacional — MODELO (funções puras, sem DOM/estado/fetch).
//
// Este arquivo é o CONTRATO entre quem fornece os dados (hoje a amostra de
// demonstração; depois o provedor real do backend — B3) e os componentes
// visuais (checklistOperacionalVisual.js). Os componentes só conhecem o
// formato `ResumoChecklist` abaixo: trocar a origem dos dados não exige
// reescrever a tela.
//
// Definições de tempo (auditoria do Checkpoint A — nunca somar preparo +
// entrega para obter a vida: há trechos de espera entre eles):
//   preparo  = confirmação (CFM) → pronto (RTP); sem RTP, até a saída (DSP),
//              marcado como APROXIMADO
//   entrega  = saída (DSP) → conclusão (CON)   — a validar no piloto
//   vida     = recebimento (PLC) → conclusão (CON), medida DIRETA
//   decomposição da vida = confirmação + preparo + espera + entrega
//
// Estados de um TEMPO (menor é melhor), proporcionais à meta da unidade:
//   dentro da meta   razão < aviso            (ex.: < 80% da meta)
//   próximo da meta  aviso ≤ razão ≤ 1        (a meta exata ainda é "limite atingido")
//   fora da meta     razão > 1
// Não existe faixa oficial de atenção para tempos na Central (o Parser só tem
// "no prazo / fora do prazo" contra o prazo prometido): os 80% são o valor
// inicial demonstrativo, configurável por indicador.
//
// Avaliações (maior é melhor) têm critério PRÓPRIO — ver CRITERIOS_AVALIACAO.

/**
 * @typedef {'ok'|'atencao'|'critico'|'neutro'} Nivel
 * @typedef {{meta: number, avisoPct: number}} LimiteIndicador  meta em minutos; aviso em % da meta
 * @typedef {{preparo: LimiteIndicador, entrega: LimiteIndicador, vida: LimiteIndicador}} Metas
 * @typedef {{min: number, displayId: string|null, em: string, aproximado?: boolean}} UltimaMedicao
 * @typedef {{ultimo: UltimaMedicao|null, mediaDia: number|null, amostras: number}} Indicador
 * @typedef {{confirmacao: number|null, preparo: number|null, espera: number|null, entrega: number|null}} Decomposicao
 * @typedef {{id: string, displayId: string|null, recebidoEm: string, status: string,
 *            confirmadoEm?: string|null, despachadoEm?: string|null}} PedidoAtivo
 *   `confirmadoEm`/`despachadoEm`: carimbos oficiais (CFM/DSP) que iniciam o preparo e a entrega
 * @typedef {{id: string, displayId: string|null, recebidoEm: string, status: string,
 *            preparoMin: number|null, preparoAproximado?: boolean, entregaMin: number|null, vidaMin: number|null}} PedidoRecente
 * @typedef {{nota: number, em: string, comentario: string|null, displayId: string|null}} Avaliacao
 * @typedef {{disponivel: boolean, motivo?: string, ultima?: Avaliacao|null, recentes?: Avaliacao[], mediaDia?: number|null,
 *            total?: number, mediaOntem?: number|null, distribuicao?: Record<1|2|3|4|5, number>}} Avaliacoes
 * @typedef {'demonstracao'|'ao_vivo'|'desatualizado'|'indisponivel'|'sem_dados'} EstadoConexao
 * @typedef {{
 *   origem: 'demonstracao'|'api',
 *   unidade: {id: string|null, nome: string},
 *   conexao: {estado: EstadoConexao, ultimaSincronizacao: string|null},
 *   metas: Metas,
 *   indicadores: {preparo: Indicador, entrega: Indicador, vida: Indicador & {decomposicao?: Decomposicao|null}},
 *   pedidosAtivos: PedidoAtivo[],
 *   ultimosPedidos: PedidoRecente[],
 *   avaliacoes: Avaliacoes,
 *   contagemDia: {concluidos: number, cancelados: number},
 * }} ResumoChecklist
 */

/** Exemplos de partida (nunca metas universais — cada unidade configura as suas). */
export const METAS_EXEMPLO = Object.freeze({
  preparo: Object.freeze({ meta: 12, avisoPct: 80 }),
  entrega: Object.freeze({ meta: 35, avisoPct: 80 }),
  vida: Object.freeze({ meta: 45, avisoPct: 80 }),
});

export const ROTULO_NIVEL = Object.freeze({
  ok: "Dentro da meta",
  atencao: "Próximo da meta",
  critico: "Fora da meta",
  neutro: "Sem medição",
});

const ORDEM_NIVEL = { neutro: 0, ok: 1, atencao: 2, critico: 3 };

const finito = (v) => typeof v === "number" && Number.isFinite(v);
const avisoDe = (limite) => (finito(limite?.avisoPct) ? limite.avisoPct : 80) / 100;
/** Tolerância de ponto flutuante nas fronteiras (9,6 / 12 = 0,7999…: exatamente 80% É atenção). */
const EPS = 1e-9;

/** Valor / meta (1 = exatamente na meta). Sem meta válida → null. */
export function razaoMeta(valorMin, limite) {
  if (!finito(valorMin) || !finito(limite?.meta) || limite.meta <= 0) return null;
  return valorMin / limite.meta;
}

/** Tempo (menor é melhor) contra a meta do indicador. */
export function classificar(valorMin, limite) {
  const r = razaoMeta(valorMin, limite);
  if (r == null) return "neutro";
  if (r > 1 + EPS) return "critico";
  return r >= avisoDe(limite) - EPS ? "atencao" : "ok";
}

export const piorNivel = (...niveis) =>
  niveis.reduce((pior, n) => (ORDEM_NIVEL[n] > ORDEM_NIVEL[pior] ? n : pior), "neutro");

const interpolar = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

/** Pulsação mais rápida permitida (s). ~0,8 Hz: urgência sem piscar. */
export const PERIODO_MINIMO_S = 1.2;

/**
 * Ritmo da pulsação de um CONTADOR VIVO, proporcional à razão tempo/meta.
 *   verde:   6,0 s → 3,2 s e intensidade 0,15 → 0,40 conforme se aproxima do aviso
 *   amarelo: 2,6 s → 1,2 s e intensidade 0,50 → 0,85 conforme se aproxima da meta
 *   vermelho / sem medição: null — o estado fica ESTÁVEL (sem pulsar)
 * @returns {{periodoS: number, intensidade: number}|null}
 */
export function ritmoPulso(razao, avisoPct = 80) {
  if (!finito(razao) || razao < 0 || razao > 1 + EPS) return null;
  const aviso = avisoPct / 100;
  if (razao < aviso - EPS) {
    const t = razao / aviso;
    return { periodoS: Math.round(interpolar(6, 3.2, t) * 10) / 10, intensidade: Math.round(interpolar(0.15, 0.4, t) * 100) / 100 };
  }
  const t = (razao - aviso) / (1 - aviso || 1);
  return { periodoS: Math.max(PERIODO_MINIMO_S, Math.round(interpolar(2.6, PERIODO_MINIMO_S, t) * 10) / 10), intensidade: Math.round(interpolar(0.5, 0.85, t) * 100) / 100 };
}

/** Minutos decorridos entre um ISO e `agora` (ms). Timestamp inválido → null; futuro → 0. */
export function minutosDesde(iso, agora) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (agora - t) / 60000);
}

const um = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 12.4 → "12,4" (sem unidade). null → "—". */
export const fmtMin = (v) => (finito(v) ? um.format(v) : "—");

/** Diferença assinada contra a meta: "−0,2 min" / "+1,4 min" / "0,0 min". */
export function fmtDiferenca(valor, meta) {
  if (!finito(valor) || !finito(meta)) return "—";
  const d = Math.round((valor - meta) * 10) / 10;
  if (d === 0) return "0,0 min";
  return `${d > 0 ? "+" : "−"}${um.format(Math.abs(d))} min`;
}

/** Cronômetro: "07:42", "1h05". */
export function fmtCronometro(min) {
  if (!finito(min)) return "—";
  const totalS = Math.floor(min * 60);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Quanto falta para a meta ou quanto passou dela: "faltam 03:18" / "passou 00:54". */
export function fmtRestante(decorridoMin, metaMin) {
  if (!finito(decorridoMin) || !finito(metaMin)) return { texto: "—", excedido: false };
  const d = metaMin - decorridoMin;
  if (Math.abs(d) < 1 / 60) return { texto: "na meta", excedido: false };
  return d > 0 ? { texto: `faltam ${fmtCronometro(d)}`, excedido: false } : { texto: `passou ${fmtCronometro(-d)}`, excedido: true };
}

/** "19:42" no fuso do navegador (a tela fica dentro do restaurante). */
export function fmtHoraCurta(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** "há 12 s", "há 3 min", "há 2 h" — idade da última sincronização. */
export function fmtIdade(iso, agora) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((agora - t) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return `há ${Math.floor(s / 3600)} h`;
}

/** Referência visível do pedido: só o número curto do iFood (nunca dado do cliente). */
export const rotuloPedido = (displayId) => (displayId ? `#${displayId}` : "Pedido sem número");

// ---------------------------------------------------------------------------
// Etapas — só os estados que a integração oficial realmente entrega.
// ---------------------------------------------------------------------------

/** Passos do trilho visual de um pedido em andamento. */
export const PASSOS = Object.freeze(["Recebido", "Confirmado", "Pronto", "Saiu para entrega"]);

const ETAPA_POR_STATUS = {
  PLACED: { passo: 0, rotulo: "Recebido" },
  CONFIRMED: { passo: 1, rotulo: "Confirmado" },
  SEPARATION_STARTED: { passo: 1, rotulo: "Em preparo" },
  SEPARATION_ENDED: { passo: 1, rotulo: "Preparo finalizado" },
  READY_TO_PICKUP: { passo: 2, rotulo: "Pronto" },
  DISPATCHED: { passo: 3, rotulo: "Saiu para entrega" },
  CONCLUDED: { passo: 4, rotulo: "Concluído" },
  CANCELLED: { passo: -1, rotulo: "Cancelado" },
};

export function etapaDoStatus(status) {
  return ETAPA_POR_STATUS[status] ?? { passo: 0, rotulo: "Status desconhecido" };
}

const EM_PREPARO = new Set(["CONFIRMED", "SEPARATION_STARTED", "SEPARATION_ENDED"]);

export const NOME_INDICADOR = Object.freeze({ preparo: "Preparo", entrega: "Entrega", vida: "Vida do pedido" });

// ---------------------------------------------------------------------------
// Pedidos em andamento — contador VIVO por etapa
// ---------------------------------------------------------------------------

/** Um contador vivo contra um indicador: decorrido, razão, nível, restante, ritmo. */
function contador(desde, limite, agora) {
  const decorridoMin = minutosDesde(desde, agora);
  const razao = razaoMeta(decorridoMin, limite);
  return {
    desde,
    decorridoMin,
    cronometro: fmtCronometro(decorridoMin),
    meta: limite?.meta ?? null,
    avisoPct: limite?.avisoPct ?? 80,
    razao,
    nivel: classificar(decorridoMin, limite),
    restante: fmtRestante(decorridoMin, limite?.meta),
    pulso: ritmoPulso(razao, limite?.avisoPct ?? 80),
  };
}

/**
 * Qual meta acompanha o pedido AGORA: preparo (desde a confirmação) enquanto
 * está em preparo, entrega (desde a saída) depois de despachado; nas esperas
 * sem meta própria (aguardando confirmação, pronto aguardando entregador) ou
 * sem o carimbo oficial, a vida do pedido (desde o recebimento).
 */
export function indicadorDaEtapa(pedido) {
  if (pedido.status === "DISPATCHED" && pedido.despachadoEm) return { chave: "entrega", desde: pedido.despachadoEm };
  // Agendado: confirmação e recebimento acontecem horas antes do preparo — preparo e vida não são cronometrados
  // (as médias do servidor também o excluem). Só a entrega, depois da saída, tem meta.
  if (pedido.agendado) return { chave: null, desde: null };
  if (EM_PREPARO.has(pedido.status) && pedido.confirmadoEm) return { chave: "preparo", desde: pedido.confirmadoEm };
  return { chave: "vida", desde: pedido.recebidoEm };
}

/** Escala da régua: até 120% da meta, para o excedente aparecer. */
export const TETO_REGUA = 1.2;

export function derivarPedidoAtivo(pedido, metas, agora) {
  const etapa = etapaDoStatus(pedido.status);
  const { chave, desde } = indicadorDaEtapa(pedido);
  const daEtapa = contador(desde, chave ? metas?.[chave] : null, agora);
  const vida = chave === "vida" ? daEtapa
    : pedido.agendado ? contador(null, null, agora)
      : contador(pedido.recebidoEm, metas?.vida, agora);
  // O pedido assume o PIOR entre a meta da etapa e a vida total (um pedido pode
  // estar dentro do preparo e já fora da vida, se esperou muito para ser confirmado).
  const governa = ORDEM_NIVEL[vida.nivel] > ORDEM_NIVEL[daEtapa.nivel] ? vida : daEtapa;
  return {
    ...pedido,
    etapa,
    indicador: chave,
    daEtapa,
    vida,
    governadoPelaVida: governa === vida && chave !== "vida",
    nivel: governa.nivel,
    razao: governa.razao,
    pulso: governa.pulso,
    progresso: daEtapa.razao == null ? 0 : Math.min(1, daEtapa.razao / TETO_REGUA),
  };
}

/**
 * Pedidos em andamento por urgência: fora da meta, depois próximos, depois
 * dentro; no mesmo estado, o recebido há mais tempo primeiro. O desempate pelo
 * recebimento é ESTÁVEL no tempo — a lista só se reorganiza quando um pedido
 * muda de estado, nunca a cada segundo.
 */
export function ordenarPorUrgencia(derivados) {
  // Sem carimbo de recebimento (dado real incompleto) vai para o fim do grupo, sem quebrar a ordenação.
  const t = (p) => { const v = Date.parse(p.recebidoEm); return Number.isNaN(v) ? Infinity : v; };
  return [...derivados].sort((a, b) => ORDEM_NIVEL[b.nivel] - ORDEM_NIVEL[a.nivel] || t(a) - t(b));
}

/**
 * O pedido que um card acompanha agora: o que está há MAIS tempo na etapa do
 * indicador (preparo: em preparo; entrega: despachados; vida: todos os ativos).
 * @returns {null | {pedido: object, quantidade: number} & ReturnType<typeof contador>}
 */
export function emAcompanhamento(chave, resumo, agora) {
  const metas = resumo.metas;
  // Pedido aberto há tempo demais (`semConclusao`) continua na lista e no alerta crítico, mas não ocupa o
  // contador "Agora" dos cards — senão um pedido sem conclusão congelaria o card o dia inteiro.
  const candidatos = (resumo.pedidosAtivos ?? [])
    .filter((p) => !p.semConclusao)
    .map((p) => ({ p, alvo: chave === "vida" ? (p.agendado ? { chave: null } : { chave: "vida", desde: p.recebidoEm }) : indicadorDaEtapa(p) }))
    .filter(({ alvo }) => alvo.chave === chave)
    .map(({ p, alvo }) => ({ p, c: contador(alvo.desde, metas?.[chave], agora) }))
    .filter(({ c }) => c.decorridoMin != null);
  if (!candidatos.length) return null;
  const mais = candidatos.reduce((a, b) => (b.c.decorridoMin > a.c.decorridoMin ? b : a));
  return { ...mais.c, pedido: mais.p, quantidade: candidatos.length };
}

// ---------------------------------------------------------------------------
// Cards de tempo
// ---------------------------------------------------------------------------

/** Números CONCLUÍDOS do dia (estáticos): último pedido e média. */
export function derivarIndicador(indicador, limite) {
  const ultimo = indicador?.ultimo ?? null;
  const media = finito(indicador?.mediaDia) ? indicador.mediaDia : null;
  return {
    // Indicador sem os carimbos necessários (dado real): "indisponível" com o motivo — nunca um zero.
    disponivel: indicador?.disponivel !== false,
    motivo: indicador?.motivo ?? null,
    mediaAproximada: indicador?.mediaAproximada === true,
    ultimoMin: ultimo && finito(ultimo.min) ? ultimo.min : null,
    ultimoNivel: classificar(ultimo?.min, limite),
    ultimoAproximado: ultimo?.aproximado === true,
    ultimoPedido: ultimo?.displayId ?? null,
    ultimoEm: ultimo?.em ?? null,
    mediaMin: media,
    mediaNivel: classificar(media, limite),
    amostras: finito(indicador?.amostras) ? indicador.amostras : 0,
    meta: limite?.meta ?? null,
    avisoPct: limite?.avisoPct ?? 80,
    diferenca: fmtDiferenca(media, limite?.meta),
  };
}

/**
 * Estado do card: com pedido em acompanhamento, é o contador VIVO que manda
 * (é o que o gerente ainda pode salvar) e o card pulsa; sem pedido na etapa,
 * vale a média do dia — estática, porque um tempo encerrado não cresce.
 */
export function estadoDoCard(chave, resumo, agora) {
  const vivo = emAcompanhamento(chave, resumo, agora);
  const hoje = derivarIndicador(resumo.indicadores?.[chave], resumo.metas?.[chave]);
  return {
    chave,
    vivo,
    hoje,
    nivel: vivo ? vivo.nivel : hoje.mediaNivel,
    pulso: vivo ? vivo.pulso : null,
    origemNivel: vivo ? "agora" : "media",
  };
}

/**
 * Trechos da vida do último pedido, em proporção. Só soma os trechos medidos;
 * `lacunaMin` é a diferença entre a vida medida direto e a soma (dado faltante),
 * nunca preenchida com estimativa.
 */
export function derivarDecomposicao(decomposicao, vidaMin) {
  const chaves = [
    ["confirmacao", "Confirmação"], ["preparo", "Preparo"], ["espera", "Espera do entregador"], ["entrega", "Entrega"],
  ];
  if (!decomposicao) return null;
  const trechos = chaves.map(([chave, rotulo]) => ({ chave, rotulo, min: finito(decomposicao[chave]) ? decomposicao[chave] : null }));
  const soma = trechos.reduce((s, t) => s + (t.min ?? 0), 0);
  const base = finito(vidaMin) && vidaMin > 0 ? Math.max(vidaMin, soma) : soma;
  if (!(base > 0)) return null;
  const lacunaMin = finito(vidaMin) ? Math.max(0, Math.round((vidaMin - soma) * 10) / 10) : null;
  return {
    trechos: trechos.map((t) => ({ ...t, pct: t.min == null ? 0 : (t.min / base) * 100 })),
    lacunaMin: lacunaMin && lacunaMin >= 0.1 ? lacunaMin : 0,
    incompleta: trechos.some((t) => t.min == null),
  };
}

// ---------------------------------------------------------------------------
// Status da operação
// ---------------------------------------------------------------------------

/**
 * Situação geral da unidade: o PIOR entre as médias do dia e os pedidos em
 * andamento. Cada motivo é escrito — o gerente vê por que, não só a cor.
 */
export function derivarStatusOperacao(resumo, agora) {
  const metas = resumo.metas;
  const ind = resumo.indicadores;
  const medias = ["preparo", "entrega", "vida"].map((c) => [NOME_INDICADOR[c], classificar(ind?.[c]?.mediaDia, metas?.[c])]);
  const ativos = (resumo.pedidosAtivos ?? []).map((p) => derivarPedidoAtivo(p, metas, agora));
  // Os abertos há tempo demais já têm alerta crítico próprio (do servidor): não são contados de novo aqui.
  const acompanhados = ativos.filter((p) => !p.semConclusao);
  const fora = acompanhados.filter((p) => p.nivel === "critico").length;
  const proximos = acompanhados.filter((p) => p.nivel === "atencao").length;
  // Total em andamento: a lista + os abertos de antes da janela consultada (contados pelo servidor).
  const emAndamento = ativos.length + (resumo.contagemDia?.abertosForaDaJanela ?? 0);
  const nivelAtivos = fora ? "critico" : proximos ? "atencao" : emAndamento ? "ok" : "neutro";
  // Alertas do servidor (pedido sem conclusão, eventos com falha...): entram no nível e nos motivos — uma
  // inconsistência operacional nunca fica escondida atrás de um card verde.
  const alertas = (resumo.alertas ?? []).filter((a) => a?.texto);
  const nivelAlertas = alertas.map((a) => (a.nivel === "critico" || a.nivel === "atencao" ? a.nivel : "neutro"));
  const nivel = piorNivel(...medias.map(([, n]) => n), nivelAtivos, ...nivelAlertas);

  const motivos = [];
  if (fora) motivos.push(`${fora} ${fora === 1 ? "pedido fora da meta" : "pedidos fora da meta"}`);
  if (proximos) motivos.push(`${proximos} ${proximos === 1 ? "pedido próximo da meta" : "pedidos próximos da meta"}`);
  for (const [nome, n] of medias) if (n === "critico" || n === "atencao") motivos.push(`${nome}: média ${n === "critico" ? "fora da meta" : "próxima da meta"}`);
  for (const a of alertas) motivos.push(a.texto);

  return {
    nivel,
    rotulo: nivel === "neutro" ? "Sem medições hoje" : ROTULO_NIVEL[nivel],
    motivos,
    medias,
    ativos: emAndamento,
    fora,
    proximos,
    concluidos: resumo.contagemDia?.concluidos ?? 0,
    cancelados: resumo.contagemDia?.cancelados ?? 0,
    alertas: alertas.map((a) => a.texto),
  };
}

// ---------------------------------------------------------------------------
// Avaliações — critério próprio (maior é melhor), nunca os limites de tempo
// ---------------------------------------------------------------------------

/** Valores iniciais demonstrativos; serão configuráveis por unidade. */
export const CRITERIOS_AVALIACAO = Object.freeze({
  satisfeitaDesde: 4.5,   // média ≥ 4,5: satisfação alta
  atencaoDesde: 4.0,      // 4,0 ≤ média < 4,5: atenção; abaixo: baixa
  negativaAte: 2,         // nota ≤ 2: avaliação negativa (destacada)
});

export const ROTULO_SATISFACAO = Object.freeze({
  ok: "Satisfação alta",
  atencao: "Satisfação em atenção",
  critico: "Satisfação baixa",
  neutro: "Sem avaliações hoje",
});

export function classificarSatisfacao(media, criterios = CRITERIOS_AVALIACAO) {
  if (!finito(media)) return "neutro";
  if (media >= criterios.satisfeitaDesde) return "ok";
  return media >= criterios.atencaoDesde ? "atencao" : "critico";
}

export const ehNegativa = (nota, criterios = CRITERIOS_AVALIACAO) => finito(nota) && nota <= criterios.negativaAte;

/** Avaliações: classificação, variação contra ontem, distribuição e recentes (sem inventar nada quando indisponível). */
export function derivarAvaliacoes(av, criterios = CRITERIOS_AVALIACAO) {
  if (!av?.disponivel) return { disponivel: false, motivo: av?.motivo ?? null };
  const dist = av.distribuicao ?? {};
  const total = [1, 2, 3, 4, 5].reduce((s, n) => s + (finito(dist[n]) ? dist[n] : 0), 0);
  const media = finito(av.mediaDia) ? av.mediaDia : null;
  const variacao = media != null && finito(av.mediaOntem) ? Math.round((media - av.mediaOntem) * 10) / 10 : null;
  const recentes = (av.recentes?.length ? av.recentes : av.ultima ? [av.ultima] : [])
    .map((a) => ({ ...a, negativa: ehNegativa(a.nota, criterios) }));
  return {
    disponivel: true,
    nivel: classificarSatisfacao(media, criterios),
    ultima: av.ultima ?? recentes[0] ?? null,
    recentes,
    negativasHoje: (finito(dist[1]) ? dist[1] : 0) + (finito(dist[2]) ? dist[2] : 0),
    mediaDia: media,
    total: finito(av.total) ? av.total : total,
    variacao,
    distribuicao: [5, 4, 3, 2, 1].map((n) => ({
      nota: n, qtd: finito(dist[n]) ? dist[n] : 0, pct: total ? ((dist[n] ?? 0) / total) * 100 : 0, negativa: n <= criterios.negativaAte,
    })),
  };
}

// ---------------------------------------------------------------------------
// Metas — formulário
// ---------------------------------------------------------------------------

/**
 * Valida metas digitadas (strings do formulário, vírgula decimal aceita).
 * @returns {{ok: true, metas: Metas} | {ok: false, erros: Record<string, string>}}
 */
export function validarMetas(campos) {
  const num = (v) => {
    const n = Number(String(v ?? "").trim().replace(",", "."));
    return String(v ?? "").trim() === "" || !Number.isFinite(n) ? null : n;
  };
  const erros = {};
  const metas = {};
  for (const chave of ["preparo", "entrega", "vida"]) {
    const meta = num(campos[`${chave}Meta`]);
    const avisoPct = num(campos[`${chave}Aviso`]);
    if (meta == null || meta <= 0 || meta > 240) erros[`${chave}Meta`] = "Informe uma meta entre 1 e 240 minutos.";
    if (avisoPct == null || avisoPct < 50 || avisoPct > 99) erros[`${chave}Aviso`] = "Use um valor entre 50% e 99% da meta.";
    metas[chave] = { meta, avisoPct };
  }
  return Object.keys(erros).length ? { ok: false, erros } : { ok: true, metas };
}

/** Rótulo e tom do selo de conexão — demonstração NUNCA aparece como "ao vivo". */
export const SELO_CONEXAO = Object.freeze({
  demonstracao: { rotulo: "Modo demonstração", tom: "demo", dica: "Dados simulados. Nada aqui vem do iFood nem é gravado." },
  ao_vivo: { rotulo: "Ao vivo", tom: "ok", dica: "Recebendo eventos do iFood (atualização a cada ~30 s)." },
  desatualizado: { rotulo: "Desatualizado", tom: "atencao", dica: "A última sincronização está atrasada. Os números podem não refletir a operação atual." },
  indisponivel: { rotulo: "Sem conexão", tom: "critico", dica: "Não foi possível falar com o servidor. Tentando reconectar." },
  sem_dados: { rotulo: "Integração não ativada", tom: "neutro", dica: "Esta unidade ainda não recebe pedidos do iFood pela Central." },
  carregando: { rotulo: "Conectando", tom: "neutro", dica: "Buscando o resumo da unidade na Central." },
});
