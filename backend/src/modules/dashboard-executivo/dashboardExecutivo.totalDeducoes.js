// Leitura compartilhada do indicador: não confundir com o total financeiro de caixa.
import { snapshotFinanceiroMaisRecente, totalDeducoesIndicador, percentual } from "./dashboardExecutivo.calc.js";
import { piorStatus, STATUS_CONCILIACAO as S } from "./dashboardExecutivo.confiabilidade.js";

export function lerTotalDeducoesRentabilidade(linhas, modelo, consolidado = null) {
  const snapshot = snapshotFinanceiroMaisRecente(linhas);
  const numero = (v) => v == null ? null : Number(v);
  const valor = consolidado ? consolidado.totalDeducoes.valor : totalDeducoesIndicador(modelo, {
    taxas_comissoes: numero(snapshot?.taxas_comissoes),
    servicos_promocoes: numero(snapshot?.servicos_promocoes),
    taxas_entregadores: numero(snapshot?.taxas_entregadores),
  });
  const base = consolidado ? consolidado.campos.valorVendasIfood.valor : numero(snapshot?.valor_vendas_ifood);
  const status = consolidado ? piorStatus(consolidado.totalDeducoes.status, consolidado.campos.valorVendasIfood.status)
    : (valor == null || base == null ? S.SEM_DADO : S.CONCILIADO);
  return { valor, percentual: status === S.CONCILIADO ? percentual(valor, base) : null };
}
