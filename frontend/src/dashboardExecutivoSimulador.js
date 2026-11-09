// Simulação local: não grava tabelas oficiais. Toda matemática vem do mês no
// backend. Bloco recolhível — padrão RECOLHIDO; `expandido` no nível do módulo
// persiste a escolha durante a sessão (sem localStorage), igual ao simulador
// anterior. Recolher/expandir só troca `hidden`, nunca reconstrói o DOM, então
// os selects e seus eventos nunca quebram.
import { escapeHtml, fmtMoeda } from "./utils.js";
import { state } from "./state.js";
import { dashExecMes, listarProdutosSistema } from "./api.js";
import { contextoMudou, geracaoContexto } from "./contextoEscopo.js";
import { fmtPctRentabilidade as pct, resultadoSimulacaoHtml, tipMargem, tipReceitaAposDeducoes } from "./dashboardExecutivoRentabilidade.js";

const montagens = new WeakMap();
let expandido = false; // padrão recolhido; persiste na sessão (módulo singleton)

// `deps` permite injetar dashExecMes em teste sem depender de --experimental-vm-modules.
export function montarSimuladorPreco(containerId, unidadeId, mes, ano, dadosMes, deps = {}) {
  const pedirMes = deps.dashExecMes ?? dashExecMes;
  // Lista de produtos para escolher o produto da simulação. Em teste (deps injetado) só carrega se for fornecida.
  const carregarProdutos = deps.listarProdutos ?? (deps.dashExecMes ? null : listarProdutosSistema);
  const container = document.getElementById(containerId);
  if (!container || !unidadeId || !dadosMes?.protecaoPrecificacao) return;
  const montagem = {};
  montagens.set(container, montagem);
  const inicial = dadosMes.protecaoPrecificacao;
  let atual = inicial, sequencia = 0;
  const contexto = geracaoContexto();
  const tabelas = { ...inicial.precos.tabelas };
  let produtoId; // undefined = produto de referência padrão (legado das Subways); com valor = produto escolhido pelo usuário
  let produtos = [];
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

  // Produto da simulação: o escolhido (ou o de referência padrão), com seletor quando há lista de produtos.
  const produtoHtml = () => {
    const nome = atual.precos.produto?.nome;
    const opcoes = produtos.map((p) => '<option value="' + escapeHtml(p.id) + '" ' + (p.id === (produtoId ?? atual.precos.produto?.id) ? 'selected' : '') + '>' + escapeHtml(p.nome) + '</option>').join('');
    return '<div class="dex-sim-produto"><span>Produto da simulação: <b>' + escapeHtml(nome ?? 'nenhum selecionado') + '</b></span>'
      + (produtos.length ? '<label>Trocar produto <select data-produto><option value="">' + (produtoId ? 'Voltar ao padrão' : 'Selecione…') + '</option>' + opcoes + '</select></label>' : '') + '</div>';
  };
  // Origem das deduções da margem do iFood: apuradas no mês (conciliadas) × estimativa pelas condições configuradas pela empresa.
  const origemHtml = () => {
    if (atual.origemDeducoes === 'configuradas') return '<p class="dex-sim-aviso">Margem do iFood <b>estimada</b> com as condições comerciais configuradas pela empresa — o mês ainda não tem Taxas e Comissões e Serviços e Promoções apurados. Não é resultado financeiro conciliado.</p>';
    if (atual.origemDeducoes === 'indisponivel' && atual.motivoDeducoesIndisponiveis && atual.motivoDeducoesIndisponiveis !== 'sem_deducoes_apuradas') {
      const txt = { canal_sem_condicoes: 'configure as condições do iFood em Configurações › Metas e operação › Condições comerciais', informe_taxas_e_promocoes: 'informe taxas e promoções (0 se não houver) nas condições comerciais do iFood' }[atual.motivoDeducoesIndisponiveis];
      return txt ? '<p class="dex-sim-aviso">Margem do iFood indisponível: ' + txt + '.</p>' : '';
    }
    return '';
  };

  const corpoHtml = () =>
    '<div id="dex-sim-corpo" class="dex-sim-corpo"' + (expandido ? '' : ' hidden') + '>'
    + '<div class="dex-sim-corpo-topo"><p>A seleção inicial usa a Tabela Oficial atual ou a comparação selecionada. Alterações abaixo são apenas simulações.</p>'
    + produtoHtml() + origemHtml()
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

  async function recalcular() {
    const pedido = ++sequencia;
    const corpo = container.querySelector('#dex-sim-corpo');
    if (corpo) corpo.innerHTML = '<div class="estado-mini">Recalculando simulação…</div>';
    try {
      const { data } = await pedirMes({ unidadeId, mes, ano, tabelaBalcao: tabelas.balcao, tabelaIfood: tabelas.ifood, ...(produtoId ? { produtoId } : {}) });
      if (obsoleto(pedido)) return;
      atual = data.protecaoPrecificacao; render();
    } catch (e) {
      if (obsoleto(pedido)) return;
      const c = container.querySelector('#dex-sim-corpo');
      if (c) c.innerHTML = '<p class="dex-sim-indisp">Simulação indisponível: ' + escapeHtml(e.message) + '</p>';
    }
  }

  function ligarSelects() {
    container.querySelector?.('[data-produto]')?.addEventListener('change', (ev) => { produtoId = ev.target.value || undefined; recalcular(); });
    container.querySelectorAll('[data-canal]').forEach(select => select.onchange = async () => {
      tabelas[select.dataset.canal] = select.value || inicial.precos.oficiais[select.dataset.canal === 'balcao' ? 'tabelaBalcao' : 'tabelaIfood'];
      const pedido = ++sequencia;
      const corpo = container.querySelector('#dex-sim-corpo');
      if (corpo) corpo.innerHTML = '<div class="estado-mini">Recalculando simulação…</div>';
      try {
        const { data } = await pedirMes({ unidadeId, mes, ano, tabelaBalcao: tabelas.balcao, tabelaIfood: tabelas.ifood, ...(produtoId ? { produtoId } : {}) });
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
    container.querySelector('[data-reset]')?.addEventListener('click', () => { ++sequencia; Object.assign(tabelas, inicial.precos.tabelas); produtoId = undefined; atual = inicial; render(); });
    ligarSelects();
  }
  render();
  if (carregarProdutos) {
    carregarProdutos().then((r) => {
      if (!container.isConnected || montagens.get(container) !== montagem) return;
      produtos = (r.data ?? []).filter((p) => p.vendavel !== false).map((p) => ({ id: p.id, nome: p.nome }));
      if (produtos.length) render();
    }).catch(() => { /* seletor é complementar: sem lista, a simulação segue com o produto padrão */ });
  }
}
