import { ApiError } from "../../shared/ApiError.js";

// O Parser legado grava a hora de parede do relatório em timestamptz UTC,
// sem converter de Brasília. Preservamos essa representação: aplicar -03:00
// apenas nas consultas deslocaria os pedidos históricos em três horas.
export function normalizarPeriodo(dataInicio, dataFim) {
  for (const [nome, valor] of [["Data inicial", dataInicio], ["Data final", dataFim]]) {
    if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)
      || !Number.isFinite(Date.parse(`${valor}T00:00:00Z`))
      || new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) !== valor) {
      throw ApiError.badRequest(`${nome} inválida. Informe ambas as datas no formato AAAA-MM-DD.`);
    }
  }
  if (dataFim < dataInicio) throw ApiError.badRequest("Data final não pode ser anterior à inicial.");
  const seguinte = new Date(`${dataFim}T00:00:00Z`);
  seguinte.setUTCDate(seguinte.getUTCDate() + 1);
  return { dataInicio, dataFim, inicio: `${dataInicio}T00:00:00.000Z`, fimExclusivo: seguinte.toISOString() };
}

/** Hora operacional legada para apresentação, sem conversão pelo navegador. */
export function horaOperacional(valor) {
  if (!valor) return null;
  const comFuso = /(?:Z|[+-]\d{2}:\d{2})$/i.test(valor);
  return comFuso ? new Date(valor).toISOString().slice(0, 23) : valor;
}

/**
 * Número não é único (migration 040). Uma ocorrência é identificada por
 * número + instante operacional + origem. Só sobrepomos ENTRE importações;
 * todas as linhas dessa chave na importação mais recente são preservadas.
 * Sem data/número, não há identidade segura: nunca fundimos essas linhas.
 * Não altera o histórico nem reclassifica pedidos. Empates têm ordem estável.
 */
export function consolidarPedidosPeriodo(linhas) {
  const grupos = new Map();
  for (const linha of linhas) {
    const chave = linha.numero_pedido && linha.data_hora
      ? JSON.stringify([linha.organizacao_id, linha.unidade_id, linha.numero_pedido,
        horaOperacional(linha.data_hora), linha.origem || ""])
      : `linha:${linha.id}`;
    const fonte = linha.fonte;
    const ordem = `${fonte.criado_em}|${linha.importacao_id}`;
    const grupo = grupos.get(chave);
    if (!grupo || ordem > grupo.ordem) grupos.set(chave, { ordem, linhas: [linha] });
    else if (ordem === grupo.ordem) grupo.linhas.push(linha);
  }
  return [...grupos.values()].flatMap((g) => g.linhas)
    .sort((a, b) => (a.data_hora || "").localeCompare(b.data_hora || "") || a.id.localeCompare(b.id));
}
