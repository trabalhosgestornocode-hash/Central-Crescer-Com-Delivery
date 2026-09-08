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

test('FS E × Z4: Serviços = protecao − 20,50; Total = protecao; limites e Taxas fixos', () => {
  const p = protecao(24, 35);
  const { metas, protecaoInsuficiente, metaServicosAcimaDoLimite } = fs(metasFS(), p);
  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, false);
  assert.equal(metas.taxas_comissoes.metaIdeal, 20.5);   // NÃO derivada
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  assert.equal(metas.servicos_promocoes.limite, 14.5);
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(metas.total_deducoes.limite, 35);
  perto(metas.total_deducoes.metaIdeal, p);
});

test('FS D × Z4: Serviços 12,36; Total 32,86', () => {
  const { metas } = fs(metasFS(), protecao(23.5, 35));
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '12.36');
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '32.86');
  assert.equal(metas.servicos_promocoes.limite, 14.5);
  assert.equal(metas.total_deducoes.limite, 35);
});

test('FS proteção insuficiente (< 20,50%): Serviços 0 + flag', () => {
  const p = protecao(30, 35); // 14,28% < 20,50%
  assert.ok(p < TAXAS_COMISSOES_REFERENCIA_FS);
  const { metas, protecaoInsuficiente } = fs(metasFS(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, true);
  perto(metas.total_deducoes.metaIdeal, p);
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
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '31.43');    // = protecao

  assert.equal(metas.taxas_comissoes.limite, 13);
  assert.equal(metas.servicos_promocoes.limite, 7);
  assert.equal(metas.taxas_entregadores.limite, 15);
  assert.equal(metas.total_deducoes.limite, 35);

  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, false);
});

test('MP F × Z4 (protecao 30,00): Serviços 5,00; Total 30,00', () => {
  const p = protecao(24.5, 35);
  assert.equal(p.toFixed(2), '30.00');
  const { metas } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '5.00'); // 30 − 13 − 12
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '30.00');
});

test('MP D × Z4 (protecao 32,86): bruto Serviços 7,86 > limite 7 → meta 7,00 + flag metaServicosAcimaDoLimite', () => {
  const p = protecao(23.5, 35);
  assert.equal(p.toFixed(2), '32.86');
  const { metas, protecaoInsuficiente, metaServicosAcimaDoLimite } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 7);      // clamp no limite logístico
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '32.86');
  assert.equal(protecaoInsuficiente, false);
  assert.equal(metaServicosAcimaDoLimite, true);
  // status: Serviços atual 6,9% <= meta 7 => dentro_da_meta; 7,5% > limite 7 => atencao
  assert.equal(statusIndicadorRentabilidade(6.9, metas.servicos_promocoes).chave, 'dentro_da_meta');
  assert.equal(statusIndicadorRentabilidade(7.5, metas.servicos_promocoes).chave, 'atencao');
});

test('MP proteção insuficiente (< 25%): Serviços 0 + flag', () => {
  const p = protecao(27, 35); // 22,857% < 25
  assert.ok(p < 25);
  const { metas, protecaoInsuficiente } = mp(metasMP(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);
  assert.equal(protecaoInsuficiente, true);
  perto(metas.total_deducoes.metaIdeal, p);
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
