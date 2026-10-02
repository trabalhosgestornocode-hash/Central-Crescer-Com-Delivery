// BLOQUEIO dos "Indicadores de Rentabilidade" (aba Indicadores do Dashboard
// iFood) enquanto a unidade não tiver as DUAS tabelas comerciais oficiais.
//
// Fonte ÚNICA: `protecaoPrecificacao.precos.oficiais` do payload de
// GET /dashboard-executivo/mes — o backend lê sempre
// unidades.tabela_balcao/tabela_ifood (shared/tabelaComercial.js#
// resolverTabelasComerciaisUnidade), da unidade daquele payload, e NUNCA deixa
// os parâmetros temporários `tabelaBalcao`/`tabelaIfood` (Simulador) tocarem
// nesse objeto. Por isso:
//   * o "Comparar: X" global (state.tabelaComparacao) e a tabela escolhida no
//     Simulador nunca desbloqueiam nada — nenhum dos dois entra aqui;
//   * `state.tabelasOficiais` também NÃO é usado: é da unidade da SESSÃO, e o
//     Dashboard iFood pode estar mostrando outra unidade (seletor próprio);
//   * só a TABELA de indicadores é censurada — o gráfico "Comparativo de
//     percentuais" segue o próprio estado (ver dashboardExecutivo.js);
//   * payload sem esse objeto (formato inesperado) = bloqueado (fail-closed).
//
// Bloqueado ≠ "Dados insuficientes": este estado é falta de CONFIGURAÇÃO e
// cobre a seção inteira; "Dados insuficientes" continua sendo o status por
// indicador quando as tabelas existem mas falta lançamento.
import { icon } from "./icons.js";

/** Evento global tratado em app.js: abre Configurações → Tabelas Comerciais. */
export const EVENTO_ABRIR_TABELAS_OFICIAIS = "app:abrir-tabelas-comerciais";

const preenchida = (t) => typeof t === "string" && t.trim() !== "";

/** Tabelas oficiais PERSISTIDAS da unidade do payload (nunca as da comparação). */
export function tabelasOficiaisDoMes(dadosMes) {
  const oficiais = dadosMes?.protecaoPrecificacao?.precos?.oficiais;
  return {
    balcao: preenchida(oficiais?.tabelaBalcao) ? oficiais.tabelaBalcao : null,
    ifood: preenchida(oficiais?.tabelaIfood) ? oficiais.tabelaIfood : null,
  };
}

/** podeExibirIndicadores = tabelaOficialBalcao != null && tabelaOficialIfood != null */
export function indicadoresRentabilidadeLiberados(dadosMes) {
  const { balcao, ifood } = tabelasOficiaisDoMes(dadosMes);
  return balcao != null && ifood != null;
}

const LINHAS_FICTICIAS = ["Taxas e comissões", "Serviços e promoções", "Taxas de entregadores", "Total de deduções"];

function pendencia({ balcao, ifood }) {
  if (!balcao && !ifood) return "Pendente: tabelas oficiais de Balcão e iFood.";
  return !balcao ? "Pendente: tabela oficial de Balcão." : "Pendente: tabela oficial do iFood.";
}

/**
 * Seção censurada. O fundo desfocado é só ESTRUTURA — rótulos fixos e
 * marcadores "••,••", nunca um valor real do payload (nada a esconder no DOM).
 * O fundo é `inert` + aria-hidden: não recebe foco, clique nem leitor de tela.
 */
export function indicadoresBloqueadosHtml(dadosMes) {
  const tabelas = tabelasOficiaisDoMes(dadosMes);
  const celula = '<td class="num">••,••%</td>';
  const linhas = LINHAS_FICTICIAS.map((rotulo) =>
    `<tr><td>${rotulo}</td>${celula}${celula}${celula}${celula}<td><span class="pill muted">••••••</span></td></tr>`).join("");
  return `
    <section class="dex-painel dex-bloqueio" aria-labelledby="dex-bloqueio-titulo">
      <h3>${icon("target", { size: 15 })} Indicadores de Rentabilidade</h3>
      <div class="dex-bloqueio-area">
        <div class="dex-bloqueio-fundo" aria-hidden="true" inert>
          <div class="tabela-wrap"><table class="grid">
            <thead><tr><th>Indicador</th><th class="num">Atual</th><th class="num">Meta ideal</th><th class="num">Limite</th><th class="num">Disponível</th><th>Status</th></tr></thead>
            <tbody>${linhas}</tbody>
          </table></div>
        </div>
        <div class="dex-bloqueio-overlay">
          <div class="dex-bloqueio-cartao">
            <span class="dex-bloqueio-icone" aria-hidden="true">${icon("lock", { size: 20 })}</span>
            <h4 id="dex-bloqueio-titulo">Tabelas oficiais não selecionadas</h4>
            <p>Para visualizar os Indicadores de Rentabilidade, defina as tabelas comerciais oficiais desta unidade.</p>
            <p class="dex-bloqueio-pendencia">${pendencia(tabelas)}</p>
            <button type="button" class="btn btn-primary dex-bloqueio-cta" data-abrir-tabelas-oficiais
              aria-label="Selecionar tabelas oficiais em Configurações, Tabelas Comerciais">Selecionar tabelas oficiais</button>
          </div>
        </div>
      </div>
    </section>`;
}

/**
 * Liga o CTA — navegação fica com app.js (abrirTabelasComerciais.js), sem
 * import circular. `unidadeId` = unidade ANALISADA pelo Dashboard (pode
 * diferir da unidade da sessão); o destino troca o contexto de forma
 * autorizada antes de abrir as tabelas.
 */
export function ligarBloqueioIndicadores(box, unidadeId) {
  box.querySelector("[data-abrir-tabelas-oficiais]")?.addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent(EVENTO_ABRIR_TABELAS_OFICIAIS, { detail: { unidadeId: unidadeId ?? null } })));
}
