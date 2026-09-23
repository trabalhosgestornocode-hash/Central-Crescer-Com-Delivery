// Modelo logístico TEMPORAL do Dashboard iFood — helpers PUROS (sem DOM, sem API).
//
// O backend devolve, em `dadosMes.modeloPeriodo`, o estado do mês consultado:
//   { tipo: 'marketplace'|'full_service'|'misto', misto, segmentos: [{modelo, rotulo, inicio, fim, emAberto}],
//     divisaoDisponivel, divisaoMotivo, divisaoDetalhe }
// "misto" é só o estado derivado do período (nunca um modelo persistido). Ver
// backend/src/modules/dashboard-executivo/dashboardExecutivo.modeloTemporal.js.

export const ROTULO_MODELO = { marketplace: "Marketplace", full_service: "Full Service" };

/** "2026-09-13" -> "13/09" */
export function fmtDiaMes(iso) {
  const [, m, d] = String(iso ?? "").split("-");
  return m && d ? `${d}/${m}` : "—";
}

/** "2026-09-13" -> "13/09/2026" */
export function fmtDataCompleta(iso) {
  const [a, m, d] = String(iso ?? "").split("-");
  return a && m && d ? `${d}/${m}/${a}` : "—";
}

/**
 * Uma linha por regime do período: "Marketplace: 01/09 a 12/09", "Full Service: desde 13/09".
 * @returns {string[]}
 */
export function linhasSegmentos(modeloPeriodo) {
  return (modeloPeriodo?.segmentos ?? []).map((s) => {
    const rotulo = s.rotulo ?? ROTULO_MODELO[s.modelo] ?? s.modelo;
    return s.emAberto ? `${rotulo}: desde ${fmtDiaMes(s.inicio)}` : `${rotulo}: ${fmtDiaMes(s.inicio)} a ${fmtDiaMes(s.fim)}`;
  });
}

/**
 * Por que Taxas de Entregadores / Total de Deduções / Receita Líquida / metas
 * não puderam ser conciliados neste período misto (ou `null` se puderam / mês
 * simples). NUNCA é "o mês inteiro sem dados" — os campos que NÃO dependem
 * da fronteira entre os modelos (Faturamento, Taxas e Comissões, Serviços e
 * Promoções, Ticket Médio, Novos Clientes) continuam disponíveis mesmo
 * quando este aviso aparece — ver dashboardExecutivo.confiabilidade.js.
 * @returns {string|null}
 */
export function avisoDivisaoIndisponivel(modeloPeriodo) {
  if (!modeloPeriodo?.misto || modeloPeriodo.divisaoDisponivel !== false) return null;
  const uvv = modeloPeriodo.divisaoDetalhe?.ultimoValorValido;
  const contexto = uvv != null
    ? ` Último valor confiável: R$ ${Number(uvv.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} em ${fmtDataCompleta(uvv.data)}.`
    : "";
  const base = "Taxas de Entregadores, Total de Deduções, Receita Líquida e as metas deste período ainda não foram conciliados entre Marketplace e Full Service; os demais indicadores continuam disponíveis normalmente.";
  switch (modeloPeriodo.divisaoMotivo) {
    case "suspeito":
      return `Foi detectado um valor suspeito no acumulado financeiro deste período (parece ter zerado ou caído de forma inesperada).${contexto} ${base}`;
    case "nao_conciliavel":
      return `O acumulado financeiro deste período apresentou uma queda que não pôde ser conciliada automaticamente — verifique o lançamento correspondente.${contexto} ${base}`;
    case "sem_dado":
      return `Ainda não há dados suficientes para separar Marketplace e Full Service neste período.${contexto} ${base}`;
    default:
      return base;
  }
}

/**
 * Modelo vigente numa data dentro do mês exibido (para o formulário do dia).
 * Sem `modeloPeriodo` (ou data fora dos segmentos) devolve `fallback`.
 */
export function modeloDaData(modeloPeriodo, dataIso, fallback) {
  const seg = (modeloPeriodo?.segmentos ?? []).find((s) => s.inicio <= dataIso && dataIso <= s.fim);
  return seg ? seg.modelo : fallback;
}

/** Texto obrigatório do modal de troca: a alteração NUNCA é silenciosamente retroativa. */
export function textoAplicacaoVigencia(vigenciaIso, hojeIso) {
  if (!vigenciaIso) return "Informe a data a partir da qual o novo modelo passa a valer.";
  const retro = hojeIso && vigenciaIso < hojeIso
    ? " A data é anterior a hoje: os lançamentos já feitos a partir dela passarão a ser interpretados pelo novo modelo."
    : "";
  return `Esta alteração será aplicada aos dados a partir de ${fmtDataCompleta(vigenciaIso)}. Os dados anteriores permanecerão vinculados ao modelo logístico vigente naquele período.${retro}`;
}

/** Modelo oposto ao informado. */
export const modeloOposto = (modelo) => (modelo === "marketplace" ? "full_service" : "marketplace");

/**
 * Mensagem de bloqueio PREVENTIVO do lançamento mensal (distribuição em fatias
 * uniformes) quando o mês tem troca de modelo logístico no meio — só faz
 * sentido para CRIAR um lote novo (`loteExiste` falso): um lote já existente
 * só pôde ter sido criado dentro de um único regime (o backend já garante
 * isso), então visualizar/editar/excluir continua liberado mesmo se o mês,
 * hoje, aparecer como misto. É só UX: o backend (409 em
 * dashboardExecutivo.service.js#lancamentoMensal) continua sendo a proteção
 * real — isto aqui só evita abrir o formulário para nada.
 * @param {{misto?: boolean}|null} modeloPeriodo
 * @param {boolean} loteExiste
 * @returns {string|null}
 */
export function avisoLancamentoMensalBloqueado(modeloPeriodo, loteExiste) {
  if (loteExiste || !modeloPeriodo?.misto) return null;
  return "Lançamento mensal indisponível para este período: este mês tem mudança de modelo logístico entre "
    + "Marketplace e Full Service. Para preservar a precisão dos indicadores, lance os dias individualmente.";
}

/** Véspera de uma data ISO (AAAA-MM-DD), em calendário (sem fuso). */
export function vesperaIso(iso) {
  const [a, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Texto do modal ao DECLARAR desde quando o modelo atual vale (unidade que já
 * trocou no passado sem data registrada). Deixa explícito o que muda e o que não.
 */
export function textoDeclaracaoHistorica(modeloAtual, vigenciaIso) {
  if (!vigenciaIso) return "Informe a data a partir da qual o modelo atual passou a valer.";
  const antes = ROTULO_MODELO[modeloOposto(modeloAtual)];
  const agora = ROTULO_MODELO[modeloAtual];
  return `Os dados até ${fmtDataCompleta(vesperaIso(vigenciaIso))} passarão a ser interpretados como ${antes}, e a partir de ${fmtDataCompleta(vigenciaIso)} como ${agora}. Os lançamentos não são alterados; só a forma como cada período é lido.`;
}
