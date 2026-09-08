// Simulação local: não grava tabelas oficiais. Toda matemática vem do mês no
// backend. Bloco recolhível — padrão RECOLHIDO; `expandido` no nível do módulo
// persiste a escolha durante a sessão (sem localStorage), igual ao simulador
// anterior. Recolher/expandir só troca `hidden`, nunca reconstrói o DOM, então
// os selects e seus eventos nunca quebram.
import { escapeHtml, fmtMoeda } from "./utils.js";
import { state } from "./state.js";
import { dashExecMes } from "./api.js";
import { contextoMudou, geracaoContexto } from "./contextoEscopo.js";
import { fmtPctRentabilidade as pct, resultadoSimulacaoHtml, tipMargem, tipReceitaAposDeducoes } from "./dashboardExecutivoRentabilidade.js";

const montagens = new WeakMap();
let expandido = false; // padrão recolhido; persiste na sessão (módulo singleton)

// `deps` permite injetar dashExecMes em teste sem depender de --experimental-vm-modules.
export function montarSimuladorPreco(containerId, unidadeId, mes, ano, dadosMes, deps = {}) {
  const pedirMes = deps.dashExecMes ?? dashExecMes;
  const container = document.getElementById(containerId);
  if (!container || !unidadeId || !dadosMes?.protecaoPrecificacao) return;
  const montagem = {};
  montagens.set(container, montagem);
  const inicial = dadosMes.protecaoPrecificacao;
  let atual = inicial, sequencia = 0;
  const contexto = geracaoContexto();
  const tabelas = { ...inicial.precos.tabelas };
  const obsoleto = (pedido) => pedido !== sequencia || contextoMudou(contexto) || !container.isConnected || montagens.get(container) !== montagem;

  const painel = (canal) => {
    const d = atual.comparacao[canal];
    const linha = (label, valor, info = '') => '<div class="dex-sim-linha"><span>' + label + info + '</span><b>' + valor + '</b></div>';
    const opcoes = [...new Set([tabelas[canal], ...(state.tabelasDisponiveis?.[canal] ?? [])].filter(Boolean))];
    return '<div class="dex-sim-lado"><div class="dex-sim-lado-topo"><h4>' + (canal === 'balcao' ? 'Balcão' : 'iFood') + '</h4><label class="dex-sim-lado-tabela">Tabela da simulação <select data-canal="' + canal + '"><option value="">Não configurada</option>'
      + opcoes.map(t => '<option ' + (t === tabelas[canal] ? 'selected' : '') + ' value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('') + '</select></label></div>'
      + linha('Preço', fmtMoeda(d.preco)) + linha('Custo', fmtMoeda(d.custo)) + linha('CMV', pct(d.cmvPct))
      + (canal === 'ifood' ? linha('Taxas e Comissões', pct(d.taxasComissoesPct)) + linha('Serviços e Promoções', pct(d.servicosPromocoesPct)) + linha('Receita após deduções', fmtMoeda(d.receitaAposDeducoesConsideradas), tipReceitaAposDeducoes(d)) : '')
      + linha('Margem estimada', fmtMoeda(d.margemEstimada) + ' · ' + pct(d.margemEstimadaPct), tipMargem(d, canal))
      + (d.indisponivel ? '<p class="dex-sim-indisp">' + escapeHtml(d.indisponivel) + '</p>' : '') + '</div>';
  };

  // Faixa recolhível: título + combinação atual + proteção + controle. Todo o
  // botão é a área clicável.
  const faixaHtml = () => {
    const t = atual.precos.tabelas;
    return '<button type="button" class="dex-sim-faixa" data-toggle aria-expanded="' + expandido + '" aria-controls="dex-sim-corpo">'
      + '<span class="dex-sim-faixa-info"><strong>Simulador de preço</strong>'
      + '<span class="dex-sim-faixa-meta">' + escapeHtml(t.balcao ?? '—') + ' × ' + escapeHtml(t.ifood ?? '—')
      + ' · Proteção ' + pct(atual.protecaoPrecificacaoPct) + '</span></span>'
      + '<span class="dex-sim-faixa-acao"><span class="dex-sim-faixa-label">' + (expandido ? 'Recolher' : 'Expandir') + '</span><span class="dex-sim-faixa-chevron" aria-hidden="true"></span></span></button>';
  };

  const corpoHtml = () =>
    '<div id="dex-sim-corpo" class="dex-sim-corpo"' + (expandido ? '' : ' hidden') + '>'
    + '<div class="dex-sim-corpo-topo"><p>A seleção inicial usa a Tabela Oficial atual ou a comparação selecionada. Alterações abaixo são apenas simulações. Produto: Churrasco 15cm.</p>'
    + '<button class="btn btn-ghost btn-sm" data-reset type="button">Restaurar seleção inicial</button></div>'
    + '<div class="dex-sim-duplo">' + painel('balcao') + painel('ifood') + '</div>'
    + resultadoSimulacaoHtml(atual, inicial)
    + '<p class="dex-sim-aviso">Margem estimada antes de demais despesas; não é lucro líquido. Entregadores, ajustes, aluguel e folha não entram nesta simulação. Os valores de proteção em reais são por Ticket Médio.</p></div>';

  function aplicarExpandido() {
    const corpo = container.querySelector('#dex-sim-corpo');
    const btn = container.querySelector('[data-toggle]');
    if (corpo) corpo.hidden = !expandido;
    if (btn) {
      btn.setAttribute('aria-expanded', String(expandido));
      const label = btn.querySelector('.dex-sim-faixa-label');
      if (label) label.textContent = expandido ? 'Recolher' : 'Expandir';
    }
  }

  function ligarSelects() {
    container.querySelectorAll('[data-canal]').forEach(select => select.onchange = async () => {
      tabelas[select.dataset.canal] = select.value || inicial.precos.oficiais[select.dataset.canal === 'balcao' ? 'tabelaBalcao' : 'tabelaIfood'];
      const pedido = ++sequencia;
      const corpo = container.querySelector('#dex-sim-corpo');
      if (corpo) corpo.innerHTML = '<div class="estado-mini">Recalculando simulação…</div>';
      try {
        const { data } = await pedirMes({ unidadeId, mes, ano, tabelaBalcao: tabelas.balcao, tabelaIfood: tabelas.ifood });
        if (obsoleto(pedido)) return;
        atual = data.protecaoPrecificacao; render();
      } catch (e) {
        if (obsoleto(pedido)) return;
        const c = container.querySelector('#dex-sim-corpo');
        if (c) c.innerHTML = '<p class="dex-sim-indisp">Simulação indisponível: ' + escapeHtml(e.message) + '</p><button class="btn btn-ghost btn-sm" data-retry type="button">Tentar novamente</button>';
        container.querySelector('[data-retry]')?.addEventListener('click', () => { atual = inicial; Object.assign(tabelas, inicial.precos.tabelas); render(); });
      }
    });
  }

  function render() {
    container.innerHTML = '<section class="dex-painel dex-simulador dex-rent-simulador">' + faixaHtml() + corpoHtml() + '</section>';
    container.querySelector('[data-toggle]').addEventListener('click', () => { expandido = !expandido; aplicarExpandido(); });
    container.querySelector('[data-reset]')?.addEventListener('click', () => { ++sequencia; Object.assign(tabelas, inicial.precos.tabelas); atual = inicial; render(); });
    ligarSelects();
  }
  render();
}
