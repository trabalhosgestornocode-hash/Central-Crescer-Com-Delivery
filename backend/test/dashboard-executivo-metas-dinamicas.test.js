import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import {
  statusIndicadorRentabilidade, metasComProtecaoPrecificacao, TAXAS_COMISSOES_REFERENCIA_FS,
} from '../src/modules/dashboard-executivo/dashboardExecutivo.calc.js';
import { calcularProtecaoPrecificacao } from '../src/modules/dashboard-executivo/dashboardExecutivo.rentabilidade.js';

const perto = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
const protecao = (b, i) => calcularProtecaoPrecificacao({ precoBalcao: b, precoIfood: i, ticketMedioIfood: 47.33 }).protecaoPrecificacaoPct;

// ---------------------------------------------------------------------------
// STATUS — tabela de Indicadores + cards de rentabilidade da Visão Geral
// ---------------------------------------------------------------------------
test('statusIndicadorRentabilidade: Meta não gera alerta; Atenção só acima do limite; sem Crítico', () => {
  const meta = { metaIdeal: 10.93, limite: 14.5 };
  const chave = (a) => statusIndicadorRentabilidade(a, meta).chave;

  assert.equal(chave(9.8), 'dentro_da_meta');
  assert.equal(chave(10.93), 'dentro_da_meta');       // igual à meta ainda é "dentro da meta"
  assert.equal(chave(11.5), 'dentro_do_limite');
  assert.equal(chave(14.4), 'dentro_do_limite');
  assert.equal(chave(14.5), 'dentro_do_limite');      // igual ao limite ainda é "dentro do limite"
  assert.equal(chave(14.51), 'atencao');
  assert.equal(chave(20), 'atencao');                 // muito acima continua só "Atenção" (sem Crítico)

  assert.equal(statusIndicadorRentabilidade(9, meta).label, 'Dentro da Meta');
  assert.equal(statusIndicadorRentabilidade(12, meta).label, 'Dentro do Limite');
  assert.equal(statusIndicadorRentabilidade(15, meta).label, 'Atenção');

  // meta < atual <= limite NUNCA é Atenção
  for (let a = 10.94; a <= 14.5; a += 0.13) assert.notEqual(chave(a), 'atencao');
});

test('statusIndicadorRentabilidade: limite tem precedência — metaIdeal acima do limite não vira "Dentro da Meta"', () => {
  const meta = { metaIdeal: 36, limite: 35 }; // cenário defensivo (não deve acontecer com o clamp)
  assert.equal(statusIndicadorRentabilidade(34, meta).chave, 'dentro_da_meta');
  assert.equal(statusIndicadorRentabilidade(35, meta).chave, 'dentro_da_meta');
  assert.equal(statusIndicadorRentabilidade(35.5, meta).chave, 'atencao'); // acima do limite, apesar de <= metaIdeal
});

test('statusIndicadorRentabilidade: Total de Deduções (meta 31,43 / limite 35)', () => {
  const meta = { metaIdeal: 31.43, limite: 35 };
  const chave = (a) => statusIndicadorRentabilidade(a, meta).chave;
  assert.equal(chave(28.4), 'dentro_da_meta');
  assert.equal(chave(32), 'dentro_do_limite');
  assert.equal(chave(35), 'dentro_do_limite');
  assert.equal(chave(35.1), 'atencao');
});

test('statusIndicadorRentabilidade: sem dados / sem meta ideal', () => {
  assert.equal(statusIndicadorRentabilidade(null, { metaIdeal: 10, limite: 14 }).chave, 'sem_dados');
  assert.equal(statusIndicadorRentabilidade(10, null).chave, 'sem_dados');
  assert.equal(statusIndicadorRentabilidade(10, { limite: null }).chave, 'sem_dados');
  assert.equal(statusIndicadorRentabilidade(9, { metaIdeal: null, limite: 14 }).chave, 'dentro_do_limite');
  assert.equal(statusIndicadorRentabilidade(15, { metaIdeal: null, limite: 14 }).chave, 'atencao');
});

// ---------------------------------------------------------------------------
// META IDEAL DINÂMICA — Full Service (reserva = Taxas e Comissões)
// ---------------------------------------------------------------------------
const metasFS = () => ({
  taxas_comissoes: { metaIdeal: 20.5, limite: 20.5 },
  servicos_promocoes: { metaIdeal: 9.5, limite: 14.5 },
  total_deducoes: { metaIdeal: 30, limite: 35 },
});
const fs = (m, p) => metasComProtecaoPrecificacao(m, p, 'full_service');

// Invariante única desta suíte: o Total é SEMPRE a soma das metas ideais dos
// componentes aplicáveis ao modelo (FS = Taxas + Serviços; MP = + Entregadores),
// nunca a Proteção da Precificação crua.
const invarianteTotal = (metas, modelo) => {
  const comps = modelo === 'marketplace'
    ? ['taxas_comissoes', 'servicos_promocoes', 'taxas_entregadores']
    : ['taxas_comissoes', 'servicos_promocoes'];
  const soma = comps.reduce((s, c) => s + metas[c].metaIdeal, 0);
  perto(metas.total_deducoes.metaIdeal, soma);
};

test('FS E × Z4 (normal, sem clamp): Serviços = protecao − 20,50; Total = Σ componentes (coincide com protecao)', () => {
  const p = protecao(24, 35);
  const { metas, protecaoInsuficiente, metaServicosAcimaDoLimite } = fs(metasFS(), p);
  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, false);
  assert.equal(metas.taxas_comissoes.metaIdeal, 20.5);   // NÃO derivada
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  assert.equal(metas.servicos_promocoes.limite, 14.5);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(metas.total_deducoes.limite, 35);
  invarianteTotal(metas, 'full_service');
  perto(metas.total_deducoes.metaIdeal, p); // sem clamp, a soma coincide com a proteção
});

test('FS D × Z4 (normal, sem clamp): Serviços 12,36; Total 32,86 = Σ componentes', () => {
  const p = protecao(23.5, 35);
  const { metas } = fs(metasFS(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '12.36');
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '32.86');
  assert.equal(metas.servicos_promocoes.limite, 14.5);
  assert.equal(metas.total_deducoes.limite, 35);
  invarianteTotal(metas, 'full_service');
  perto(metas.total_deducoes.metaIdeal, p);
});

test('FS proteção insuficiente (< 20,50%): Serviços 0; Total = Σ componentes = 20,50 (NUNCA a proteção)', () => {
  const p = protecao(30, 35); // 14,28% < 20,50%
  assert.ok(p < TAXAS_COMISSOES_REFERENCIA_FS);
  const { metas, protecaoInsuficiente } = fs(metasFS(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, true);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '20.50'); // 20,50 + 0 — não os ~14,28% da proteção
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2));
  invarianteTotal(metas, 'full_service');
});

test('FS proteção acima da capacidade de Serviços (> 35%): Serviços no limite 14,50; Total 35,00 = Σ componentes', () => {
  const p = protecao(20, 35); // (35−20)/35 = 42,857% > 20,50 + 14,50
  const { metas, metaServicosAcimaDoLimite } = fs(metasFS(), p);
  assert.equal(metaServicosAcimaDoLimite, true);
  assert.equal(metas.servicos_promocoes.metaIdeal, 14.5);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '35.00'); // 20,50 + 14,50 — não os ~42,86% da proteção
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2));
  invarianteTotal(metas, 'full_service');
});

test('FS proteção exatamente na reserva (20,50%): Serviços 0; Total 20,50', () => {
  const { metas, protecaoInsuficiente } = fs(metasFS(), 20.5);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, false); // servicosBruto === 0, não < 0
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '20.50');
  invarianteTotal(metas, 'full_service');
});

test('FS proteção = 0%: Serviços 0; Total = reserva 20,50', () => {
  const { metas, protecaoInsuficiente } = fs(metasFS(), 0);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, true);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '20.50');
  invarianteTotal(metas, 'full_service');
});

// ---------------------------------------------------------------------------
// META IDEAL DINÂMICA — Marketplace (reserva = Taxas e Comissões + Entregadores)
// ---------------------------------------------------------------------------
const metasMP = () => ({
  taxas_comissoes: { metaIdeal: 13, limite: 13 },
  servicos_promocoes: { metaIdeal: 5, limite: 7 },
  taxas_entregadores: { metaIdeal: 12, limite: 15 },
  total_deducoes: { metaIdeal: 30, limite: 35 },
});
const mp = (m, p) => metasComProtecaoPrecificacao(m, p, 'marketplace');

test('MP E × Z4 (protecao 31,43): Serviços 6,43; Total 31,43; Taxas 13 e Entregadores 12 fixos; limites 13/7/15/35', () => {
  const p = protecao(24, 35);
  assert.equal(p.toFixed(2), '31.43');
  const { metas, protecaoInsuficiente, metaServicosAcimaDoLimite } = mp(metasMP(), p);

  assert.equal(metas.taxas_comissoes.metaIdeal, 13);        // fixo
  assert.equal(metas.taxas_entregadores.metaIdeal, 12);     // fixo
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '6.43'); // 31,43 − 13 − 12
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '31.43');    // 13 + 6,43 + 12 (coincide c/ protecao, sem clamp)

  assert.equal(metas.taxas_comissoes.limite, 13);
  assert.equal(metas.servicos_promocoes.limite, 7);
  assert.equal(metas.taxas_entregadores.limite, 15);
  assert.equal(metas.total_deducoes.limite, 35);

  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, false);
  invarianteTotal(metas, 'marketplace');
});

test('MP F × Z4 (protecao 30,00): Serviços 5,00; Total 30,00 = 13 + 5 + 12', () => {
  const p = protecao(24.5, 35);
  assert.equal(p.toFixed(2), '30.00');
  const { metas } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '5.00'); // 30 − 13 − 12
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '30.00');
  invarianteTotal(metas, 'marketplace');
});

test('MP D × Z4 (protecao 32,86): bruto Serviços 7,86 > limite 7 → Serviços 7,00; Total = Σ componentes = 32,00 (NÃO 32,86)', () => {
  const p = protecao(23.5, 35);
  assert.equal(p.toFixed(2), '32.86');
  const { metas, protecaoInsuficiente, metaServicosAcimaDoLimite } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 7);      // clamp no limite logístico
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '32.00'); // 13 + 7 + 12 — não os 32,86% da proteção
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2));
  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, true);
  invarianteTotal(metas, 'marketplace');
  // status: Serviços atual 6,9% <= meta 7 => dentro_da_meta; 7,5% > limite 7 => atencao
  assert.equal(statusIndicadorRentabilidade(6.9, metas.servicos_promocoes).chave, 'dentro_da_meta');
  assert.equal(statusIndicadorRentabilidade(7.5, metas.servicos_promocoes).chave, 'atencao');
});

test('MP proteção insuficiente (< 25%): Serviços 0; Total = Σ componentes = 25,00 (NUNCA a proteção)', () => {
  const p = protecao(27, 35); // 22,857% < 25
  assert.ok(p < 25);
  const { metas, protecaoInsuficiente } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, true);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '25.00'); // 13 + 0 + 12
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2));
  invarianteTotal(metas, 'marketplace');
});

test('MP proteção exatamente na reserva (25%): Serviços 0; Total 25,00', () => {
  const { metas, protecaoInsuficiente } = mp(metasMP(), 25);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, false); // servicosBruto === 0
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '25.00');
  invarianteTotal(metas, 'marketplace');
});

// -------------------------------------------------------------------------
// CASO REPORTADO — Balcão 22,00 / iFood 24,50 · proteção 10,204082%
// Marketplace: Serviços clampa em 0 (proteção << reserva 25); o Total NÃO
// pode ser 10,20% (a proteção) — tem de ser 13 + 0 + 12 = 25,00%.
// -------------------------------------------------------------------------
test('CASO REPORTADO — MP · Balcão 22,00 / iFood 24,50 · proteção 10,20% → Total Meta Ideal = 25,00%', () => {
  const p = protecao(22, 24.5);
  assert.equal(p.toFixed(6), '10.204082');
  assert.equal(p.toFixed(2), '10.20');

  const { metas, protecaoInsuficiente } = mp(metasMP(), p);

  assert.equal(metas.taxas_comissoes.metaIdeal.toFixed(2), '13.00');
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '0.00'); // inalterado: min(7, max(0, 10,20 − 25)) = 0
  assert.equal(metas.taxas_entregadores.metaIdeal.toFixed(2), '12.00');
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '25.00');    // era 10,20 (bug)

  assert.equal(protecaoInsuficiente, true);
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2)); // proteção !== metaIdeal(total)
  invarianteTotal(metas, 'marketplace');
  // 13,00 + 0,00 + 12,00 === 25,00
  perto(
    metas.total_deducoes.metaIdeal,
    metas.taxas_comissoes.metaIdeal + metas.servicos_promocoes.metaIdeal + metas.taxas_entregadores.metaIdeal,
  );
});

test('CASO REPORTADO — mesma proteção 10,20% em Full Service → Total 20,50% (Taxas + 0)', () => {
  const p = protecao(22, 24.5);
  const { metas, protecaoInsuficiente } = fs(metasFS(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '0.00');
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '20.50');
  assert.equal(protecaoInsuficiente, true);
  assert.notEqual(metas.total_deducoes.metaIdeal.toFixed(2), p.toFixed(2));
  invarianteTotal(metas, 'full_service');
});

// Varredura de proteção nos dois modelos — a invariante Total == Σ componentes
// vale SEMPRE, e a Meta Ideal do Total NUNCA é a proteção crua quando há clamp.
test('varredura de proteção (0 · abaixo · na reserva · normal · acima da capacidade) — invariante nos 2 modelos', () => {
  for (const [modelo, mk, aplic] of [['full_service', metasFS, fs], ['marketplace', metasMP, mp]]) {
    for (const pct of [0, 5, 10.204082, 20.5, 25, 28, 31.43, 34, 45, 80]) {
      const { metas } = aplic(mk(), pct);
      invarianteTotal(metas, modelo);
      // servicos sempre dentro de [0, limite]
      assert.ok(metas.servicos_promocoes.metaIdeal >= 0);
      assert.ok(metas.servicos_promocoes.metaIdeal <= metas.servicos_promocoes.limite + 1e-9);
      // Total nunca ultrapassa o limite logístico do Total
      assert.ok(metas.total_deducoes.metaIdeal <= metas.total_deducoes.limite + 1e-9);
    }
  }
});

// ---------------------------------------------------------------------------
// Comportamento comum aos dois modelos
// ---------------------------------------------------------------------------
test('troca de tabela só mexe nas metas dinâmicas; nunca limites nem Taxas/Entregadores', () => {
  for (const [modelo, mk] of [['full_service', metasFS], ['marketplace', metasMP]]) {
    const e = metasComProtecaoPrecificacao(mk(), protecao(24, 35), modelo).metas;
    const d = metasComProtecaoPrecificacao(mk(), protecao(23.5, 35), modelo).metas;
    assert.notEqual(e.total_deducoes.metaIdeal, d.total_deducoes.metaIdeal);
    assert.equal(e.taxas_comissoes.metaIdeal, d.taxas_comissoes.metaIdeal);
    assert.equal(e.servicos_promocoes.limite, d.servicos_promocoes.limite);
    assert.equal(e.total_deducoes.limite, d.total_deducoes.limite);
    if (modelo === 'marketplace') assert.equal(e.taxas_entregadores.metaIdeal, d.taxas_entregadores.metaIdeal);
  }
});

test('proteção indisponível (sem preço): metas estáticas, sem flags, mesmo objeto', () => {
  const original = metasMP();
  const r = metasComProtecaoPrecificacao(original, null, 'marketplace');
  assert.equal(r.metas, original);
  assert.equal(r.protecaoInsuficiente, false);
  assert.equal(r.metaServicosAcimaDoLimite, false);
});

test('fallback: sem meta de Taxas usa a referência do modelo (20,50 FS / 13 MP)', () => {
  const semTaxasFS = { servicos_promocoes: { metaIdeal: 9.5, limite: 14.5 }, total_deducoes: { metaIdeal: 30, limite: 35 } };
  assert.equal(fs(semTaxasFS, protecao(24, 35)).metas.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  const semTaxasMP = { servicos_promocoes: { metaIdeal: 5, limite: 7 }, taxas_entregadores: { metaIdeal: 12, limite: 15 }, total_deducoes: { metaIdeal: 30, limite: 35 } };
  assert.equal(mp(semTaxasMP, protecao(24, 35)).metas.servicos_promocoes.metaIdeal.toFixed(2), '6.43');
});

test('não muta o objeto de metas recebido', () => {
  const original = metasMP();
  const antes = JSON.stringify(original);
  mp(original, protecao(24, 35));
  assert.equal(JSON.stringify(original), antes);
});

// ---------------------------------------------------------------------------
// Integração no serviço mensal
// ---------------------------------------------------------------------------
const dir = new URL('../src/modules/dashboard-executivo/', import.meta.url);
async function carregar(nome, mocks) {
  const url = new URL(nome, dir);
  const m = new SourceTextModule(readFileSync(url, 'utf8'), { identifier: url.href });
  await m.link(async (spec) => {
    const ns = mocks[spec] ?? await import(new URL(spec, url));
    return new SyntheticModule(Object.keys(ns), function () { for (const [k, v] of Object.entries(ns)) this.setExport(k, v); });
  });
  await m.evaluate();
  return m.namespace;
}
function banco(row) {
  return { from(tabela) {
    const filtros = {}; let unico = false;
    const resposta = () => {
      if (tabela === 'unidades') return { data: { id: filtros.id, organizacao_id: 'org' } };
      if (tabela !== 'lancamentos_financeiros_diarios' || unico) return { data: unico ? null : [] };
      return { data: [{ id: 'l', unidade_id: filtros.unidade_id, data_lancamento: '2026-09-05', situacao: 'normal', status: 'finalizado', qtd_vendas: 100, valor_vendas_bruto: 4733, valor_vendas_ifood: 10000, ...row }] };
    };
    const q = { select() { return q }, eq(k, v) { filtros[k] = v; return q }, gte(k, v) { filtros.inicio = v; return q }, lte() { return q }, order() { return q }, limit() { return q },
      maybeSingle() { unico = true; return Promise.resolve(resposta()) }, then(a, b) { return Promise.resolve(resposta()).then(a, b) } };
    return q;
  } };
}
async function servico(modelo, metas, row) {
  return carregar('dashboardExecutivo.service.js', {
    '../../config/supabase.js': { supabase: banco(row) },
    '../../shared/desbloqueiosIfood.js': { carregarDatasLiberadas: async () => new Set() },
    './dashboardExecutivo.metas.service.js': {
      resolverMetas: async () => metas, obterModeloLogistico: async () => ({ modeloLogistico: modelo }),
      definirModeloLogistico() {}, historicoModeloLogistico() {},
    },
    './dashboardExecutivo.precos.service.js': {
      carregarPrecosRentabilidade: async () => ({
        oficiais: { tabelaBalcao: 'E', tabelaIfood: 'Z4' }, tabelas: { balcao: 'E', ifood: 'Z4' },
        produto: { id: 'p', nome: 'Churrasco 15cm' }, balcao: { preco: 24, custo: 6 }, ifood: { preco: 35, custo: 6 },
      }),
    },
  });
}
const PEDIDO = { organizacaoId: 'org', unidadeIdSessao: null, unidadeIdSolicitado: 'a', mes: 9, ano: 2026 };

test('serviço FS E×Z4: tabela e cards com meta derivada + statusIndicadorRentabilidade', async () => {
  const svc = await servico('full_service', metasFS(), { taxas_comissoes: 1900, servicos_promocoes: 1100, taxas_entregadores: 0 });
  const d = await svc.obterMes(PEDIDO);
  const ind = d.indicadoresRentabilidade;
  assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2), '31.43');
  assert.equal(ind.taxas_comissoes.metaIdeal, 20.5);
  assert.equal(ind.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  assert.equal(ind.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(ind.servicos_promocoes.limite, 14.5);
  assert.equal(ind.total_deducoes.limite, 35);
  assert.equal(ind.taxas_entregadores.naoAplicavel, true);
  assert.equal(ind.servicos_promocoes.status.chave, 'dentro_do_limite'); // 11% entre 10,93 e 14,5
  assert.equal(d.cards.servicosPromocoes.meta.metaIdeal.toFixed(2), '10.93');
  assert.equal(d.cards.servicosPromocoes.status.chave, 'dentro_do_limite');
  assert.equal(d.cards.servicosPromocoes.saldo.disponivelPp.toFixed(2), '3.50'); // 14,5 − 11 (LIMITE)
});

test('serviço MP E×Z4: Serviços meta 6,43 / Total 31,43; Taxas 13 e Entregadores 12 fixos', async () => {
  const svc = await servico('marketplace', metasMP(), { taxas_comissoes: 620, servicos_promocoes: 500, taxas_entregadores: 1300 });
  const d = await svc.obterMes(PEDIDO);
  const ind = d.indicadoresRentabilidade;
  assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2), '31.43');
  assert.equal(ind.taxas_comissoes.metaIdeal, 13);
  assert.equal(ind.taxas_entregadores.metaIdeal, 12);
  assert.equal(ind.servicos_promocoes.metaIdeal.toFixed(2), '6.43');
  assert.equal(ind.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(ind.servicos_promocoes.limite, 7);
  assert.equal(ind.total_deducoes.limite, 35);
  assert.equal(d.protecaoPrecificacao.metaServicosAcimaDoLimite, false);

  // Serviços atual 5% (500/10000): 5 <= meta 6,43 => dentro_da_meta
  assert.equal(ind.servicos_promocoes.status.chave, 'dentro_da_meta');
  assert.equal(d.cards.servicosPromocoes.status.chave, 'dentro_da_meta');
  assert.equal(d.cards.servicosPromocoes.meta.metaIdeal.toFixed(2), '6.43');
  // Entregadores atual 13% (1300/10000): meta 12 < 13 <= limite 15 => dentro_do_limite
  assert.equal(ind.taxas_entregadores.status.chave, 'dentro_do_limite');
});

// ---------------------------------------------------------------------------
// Total de Deduções (INDICADOR) = soma EXATA das parcelas aplicáveis ao modelo
// Bug reportado: Full Service com Taxas de Entregadores lançadas no snapshot
// somava os 3,13 p.p. de entregadores (que "não se aplica") no Total.
// ---------------------------------------------------------------------------
test('CASO REPORTADO — FS: Total = Taxas + Serviços (20,23 + 8,68 = 28,91), entregadores fora', async () => {
  // base 10.000 · Taxas 2.023 (20,23%) · Serviços 868 (8,68%) · Entregadores 313 (3,13%)
  const svc = await servico('full_service', metasFS(), { taxas_comissoes: 2023, servicos_promocoes: 868, taxas_entregadores: 313 });
  const d = await svc.obterMes(PEDIDO);
  const td = d.indicadoresRentabilidade.total_deducoes;

  assert.equal(d.indicadoresRentabilidade.taxas_comissoes.atual.toFixed(2), '20.23');
  assert.equal(d.indicadoresRentabilidade.servicos_promocoes.atual.toFixed(2), '8.68');
  assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, true);

  assert.equal(td.atual.toFixed(2), '28.91');            // era 32,04 (bug)
  assert.equal(td.metaIdeal.toFixed(2), '31.43');
  assert.equal(td.limite, 35);
  assert.equal(td.status.chave, 'dentro_da_meta');        // era 'dentro_do_limite'
  assert.equal(td.status.label, 'Dentro da Meta');
  assert.equal(td.saldo.disponivelPp.toFixed(2), '6.09'); // 35 − 28,91 (era 2,96)
  assert.equal(td.saldo.disponivelReais.toFixed(2), '609.00'); // 3.500 − 2.891, base oficial (não % arredondado)

  // O card da Visão Geral usa a MESMA regra.
  assert.equal(d.cards.totalDeducoes.percentual.toFixed(2), '28.91');
  assert.equal(d.cards.totalDeducoes.valor, 2891);
  assert.equal(d.cards.totalDeducoes.status.chave, 'dentro_da_meta');

  // Receita líquida CONTINUA financeira: 10.000 − (2.023+868+313) − 0 ajustes = 6.796.
  assert.equal(d.cards.receitaLiquida.valor, 6796);

  // Critério de aceite: Total bate à vírgula com a soma das linhas exibidas.
  assert.equal(
    (d.indicadoresRentabilidade.taxas_comissoes.atual + d.indicadoresRentabilidade.servicos_promocoes.atual).toFixed(2),
    td.atual.toFixed(2),
  );
});

test('FS — Total no ponto da meta / entre meta e limite / no limite / acima', async () => {
  const casos = [
    // metaIdeal ≈ 31,4286 · limite 35 (protecao E×Z4). Serviços = Total − Taxas.
    { taxas_comissoes: 2000, servicos_promocoes: 1100, esperado: '31.00', status: 'dentro_da_meta' },  // abaixo da meta
    { taxas_comissoes: 2000, servicos_promocoes: 1142, esperado: '31.42', status: 'dentro_da_meta' },  // a um passo da meta (≤ 31,4286)
    { taxas_comissoes: 2000, servicos_promocoes: 1300, esperado: '33.00', status: 'dentro_do_limite' }, // entre meta e limite
    { taxas_comissoes: 2000, servicos_promocoes: 1500, esperado: '35.00', status: 'dentro_do_limite' }, // exatamente no limite
    { taxas_comissoes: 2000, servicos_promocoes: 1600, esperado: '36.00', status: 'atencao' },          // acima do limite
  ];
  for (const c of casos) {
    const svc = await servico('full_service', metasFS(), { taxas_comissoes: c.taxas_comissoes, servicos_promocoes: c.servicos_promocoes, taxas_entregadores: 500 });
    const td = (await svc.obterMes(PEDIDO)).indicadoresRentabilidade.total_deducoes;
    assert.equal(td.atual.toFixed(2), c.esperado, JSON.stringify(c));
    assert.equal(td.status.chave, c.status, JSON.stringify(c));
  }
});

test('FS — uma parcela zero: Total = a outra parcela; entregadores segue ignorado', async () => {
  const svc = await servico('full_service', metasFS(), { taxas_comissoes: 2000, servicos_promocoes: 0, taxas_entregadores: 400 });
  const td = (await svc.obterMes(PEDIDO)).indicadoresRentabilidade.total_deducoes;
  assert.equal(td.atual.toFixed(2), '20.00');
});

test('MP — SEM REGRESSÃO: Total inclui Taxas de Entregadores (11,52 + 12,63 + 14,90 = 39,05)', async () => {
  const svc = await servico('marketplace', metasMP(), { taxas_comissoes: 1152, servicos_promocoes: 1263, taxas_entregadores: 1490 });
  const d = await svc.obterMes(PEDIDO);
  const td = d.indicadoresRentabilidade.total_deducoes;
  assert.equal(td.atual.toFixed(2), '39.05');
  assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, false);
  assert.equal(td.status.chave, 'atencao'); // 39,05 > limite 35
  // Bate com a soma das 3 linhas aplicáveis.
  const ind = d.indicadoresRentabilidade;
  assert.equal(
    (ind.taxas_comissoes.atual + ind.servicos_promocoes.atual + ind.taxas_entregadores.atual).toFixed(2),
    td.atual.toFixed(2),
  );
});

test('MP — alterar Serviços e Promoções reflete no Total (recalculado dos componentes)', async () => {
  const base = { taxas_comissoes: 1152, taxas_entregadores: 1490 };
  const totalCom = async (servicos_promocoes) =>
    (await (await servico('marketplace', metasMP(), { ...base, servicos_promocoes })).obterMes(PEDIDO))
      .indicadoresRentabilidade.total_deducoes.atual;
  assert.equal((await totalCom(1263)).toFixed(2), '39.05');
  assert.equal((await totalCom(500)).toFixed(2), '31.42');  // 11,52 + 5,00 + 14,90
  assert.equal((await totalCom(0)).toFixed(2), '26.42');
});

test('MP — Taxas de Entregadores lançada mas modelo trocado p/ FS: entregadores sai do Total', async () => {
  const row = { taxas_comissoes: 2023, servicos_promocoes: 868, taxas_entregadores: 313 };
  const mpTd = (await (await servico('marketplace', metasMP(), row)).obterMes(PEDIDO)).indicadoresRentabilidade.total_deducoes.atual;
  const fsTd = (await (await servico('full_service', metasFS(), row)).obterMes(PEDIDO)).indicadoresRentabilidade.total_deducoes.atual;
  assert.equal(mpTd.toFixed(2), '32.04'); // MP: soma os 3
  assert.equal(fsTd.toFixed(2), '28.91'); // FS: ignora entregadores
});
