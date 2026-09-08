import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import {
  statusIndicadorRentabilidade, metasComProtecaoFullService, TAXAS_COMISSOES_REFERENCIA_FS,
} from '../src/modules/dashboard-executivo/dashboardExecutivo.calc.js';
import { calcularProtecaoPrecificacao } from '../src/modules/dashboard-executivo/dashboardExecutivo.rentabilidade.js';

const perto = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);

// ---------------------------------------------------------------------------
// STATUS — só da tabela de Indicadores de Rentabilidade
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

test('statusIndicadorRentabilidade: Total de Deduções (meta 31,43 / limite 35)', () => {
  const meta = { metaIdeal: 31.43, limite: 35 };
  const chave = (a) => statusIndicadorRentabilidade(a, meta).chave;
  assert.equal(chave(28.4), 'dentro_da_meta');
  assert.equal(chave(32), 'dentro_do_limite');
  assert.equal(chave(34.9), 'dentro_do_limite');
  assert.equal(chave(35), 'dentro_do_limite');
  assert.equal(chave(35.1), 'atencao');
});

test('statusIndicadorRentabilidade: sem dados / sem meta ideal', () => {
  assert.equal(statusIndicadorRentabilidade(null, { metaIdeal: 10, limite: 14 }).chave, 'sem_dados');
  assert.equal(statusIndicadorRentabilidade(10, null).chave, 'sem_dados');
  assert.equal(statusIndicadorRentabilidade(10, { limite: null }).chave, 'sem_dados');
  // sem metaIdeal: <= limite é "dentro do limite", acima é "atenção"
  assert.equal(statusIndicadorRentabilidade(9, { metaIdeal: null, limite: 14 }).chave, 'dentro_do_limite');
  assert.equal(statusIndicadorRentabilidade(15, { metaIdeal: null, limite: 14 }).chave, 'atencao');
});

// ---------------------------------------------------------------------------
// META IDEAL DINÂMICA — Full Service
// ---------------------------------------------------------------------------
const metasFS = () => ({
  taxas_comissoes: { metaIdeal: 20.5, limite: 20.5 },
  servicos_promocoes: { metaIdeal: 9.5, limite: 14.5 },
  total_deducoes: { metaIdeal: 30, limite: 35 },
});
const protecao = (b, i) => calcularProtecaoPrecificacao({ precoBalcao: b, precoIfood: i, ticketMedioIfood: 47.33 }).protecaoPrecificacaoPct;

test('E × Z4: meta Serviços = protecao − 20,50; meta Total = protecao; limites e Taxas fixos', () => {
  const p = protecao(24, 35);
  const { metas, protecaoInsuficiente } = metasComProtecaoFullService(metasFS(), p);
  assert.equal(protecaoInsuficiente, false);

  assert.equal(metas.taxas_comissoes.metaIdeal, 20.5);   // NÃO derivada
  assert.equal(metas.taxas_comissoes.limite, 20.5);

  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  assert.equal(metas.servicos_promocoes.limite, 14.5);   // limite intacto

  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(metas.total_deducoes.limite, 35);          // limite intacto
  perto(metas.total_deducoes.metaIdeal, p);
});

test('D × Z4: meta Serviços 12,36; meta Total 32,86', () => {
  const { metas } = metasComProtecaoFullService(metasFS(), protecao(23.5, 35));
  assert.equal(metas.servicos_promocoes.metaIdeal.toFixed(2), '12.36');
  assert.equal(metas.total_deducoes.metaIdeal.toFixed(2), '32.86');
  assert.equal(metas.servicos_promocoes.limite, 14.5);
  assert.equal(metas.total_deducoes.limite, 35);
});

test('troca E → D só muda as metas dinâmicas; nunca os limites nem Taxas', () => {
  const e = metasComProtecaoFullService(metasFS(), protecao(24, 35)).metas;
  const d = metasComProtecaoFullService(metasFS(), protecao(23.5, 35)).metas;
  assert.notEqual(e.servicos_promocoes.metaIdeal, d.servicos_promocoes.metaIdeal);
  assert.notEqual(e.total_deducoes.metaIdeal, d.total_deducoes.metaIdeal);
  assert.equal(e.taxas_comissoes.metaIdeal, d.taxas_comissoes.metaIdeal);
  assert.equal(e.servicos_promocoes.limite, d.servicos_promocoes.limite);
  assert.equal(e.total_deducoes.limite, d.total_deducoes.limite);
});

test('proteção insuficiente (<= 20,50%): meta Serviços = 0 e flag sinalizada', () => {
  // Balcão 30 / iFood 35 → proteção 14,28% < 20,50%
  const p = protecao(30, 35);
  assert.ok(p < TAXAS_COMISSOES_REFERENCIA_FS);
  const { metas, protecaoInsuficiente } = metasComProtecaoFullService(metasFS(), p);
  assert.equal(metas.servicos_promocoes.metaIdeal, 0);      // nunca negativa
  assert.equal(protecaoInsuficiente, true);
  perto(metas.total_deducoes.metaIdeal, p);                 // Total ainda acompanha a proteção
});

test('proteção indisponível (sem preço): metas ficam estáticas, sem flag', () => {
  const original = metasFS();
  const { metas, protecaoInsuficiente } = metasComProtecaoFullService(original, null);
  assert.equal(metas, original);                            // mesmo objeto, sem cópia
  assert.equal(protecaoInsuficiente, false);
});

test('fallback: sem meta de Taxas configurada usa a referência 20,50', () => {
  const metas = { servicos_promocoes: { metaIdeal: 9.5, limite: 14.5 }, total_deducoes: { metaIdeal: 30, limite: 35 } };
  const { metas: r } = metasComProtecaoFullService(metas, protecao(24, 35));
  assert.equal(r.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
});

test('não muta o objeto de metas recebido', () => {
  const original = metasFS();
  const antes = JSON.stringify(original);
  metasComProtecaoFullService(original, protecao(24, 35));
  assert.equal(JSON.stringify(original), antes);
});

// ---------------------------------------------------------------------------
// Integração no serviço mensal — Full Service
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
function banco() {
  return { from(tabela) {
    const filtros = {}; let unico = false;
    const resposta = () => {
      if (tabela === 'unidades') return { data: { id: filtros.id, organizacao_id: 'org' } };
      if (tabela !== 'lancamentos_financeiros_diarios' || unico) return { data: unico ? null : [] };
      return { data: [{ id: 'l', unidade_id: filtros.unidade_id, data_lancamento: '2026-09-05', situacao: 'normal', status: 'finalizado', qtd_vendas: 100, valor_vendas_bruto: 4733, valor_vendas_ifood: 10000, taxas_comissoes: 1900, servicos_promocoes: 1100, taxas_entregadores: 0 }] };
    };
    const q = { select() { return q }, eq(k, v) { filtros[k] = v; return q }, gte(k, v) { filtros.inicio = v; return q }, lte() { return q }, order() { return q }, limit() { return q },
      maybeSingle() { unico = true; return Promise.resolve(resposta()) }, then(a, b) { return Promise.resolve(resposta()).then(a, b) } };
    return q;
  } };
}
test('serviço FS: tabela usa metas derivadas + status próprio; cards seguem a régua histórica', async () => {
  const svc = await carregar('dashboardExecutivo.service.js', {
    '../../config/supabase.js': { supabase: banco() },
    '../../shared/desbloqueiosIfood.js': { carregarDatasLiberadas: async () => new Set() },
    './dashboardExecutivo.metas.service.js': {
      resolverMetas: async () => metasFS(),
      obterModeloLogistico: async () => ({ modeloLogistico: 'full_service' }),
      definirModeloLogistico() {}, historicoModeloLogistico() {},
    },
    './dashboardExecutivo.precos.service.js': {
      carregarPrecosRentabilidade: async () => ({
        oficiais: { tabelaBalcao: 'E', tabelaIfood: 'Z4' }, tabelas: { balcao: 'E', ifood: 'Z4' },
        produto: { id: 'p', nome: 'Churrasco 15cm' }, balcao: { preco: 24, custo: 6 }, ifood: { preco: 35, custo: 6 },
      }),
    },
  });
  const d = await svc.obterMes({ organizacaoId: 'org', unidadeIdSessao: null, unidadeIdSolicitado: 'a', mes: 9, ano: 2026 });
  const ind = d.indicadoresRentabilidade;

  // proteção E × Z4 = 31,43%
  assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2), '31.43');

  // Tabela: metas dinâmicas, limites fixos
  assert.equal(ind.taxas_comissoes.metaIdeal, 20.5);
  assert.equal(ind.taxas_comissoes.limite, 20.5);
  assert.equal(ind.servicos_promocoes.metaIdeal.toFixed(2), '10.93');
  assert.equal(ind.servicos_promocoes.limite, 14.5);
  assert.equal(ind.total_deducoes.metaIdeal.toFixed(2), '31.43');
  assert.equal(ind.total_deducoes.limite, 35);
  assert.equal(ind.taxas_entregadores.naoAplicavel, true);

  // Status da tabela: atual Taxas 19% (>meta 20,5? não) — 19 <= 20,5 => dentro_da_meta
  assert.equal(ind.taxas_comissoes.status.chave, 'dentro_da_meta');
  // Serviços 11% : meta 10,93 < 11 <= limite 14,5 => dentro_do_limite (não "Atenção")
  assert.equal(ind.servicos_promocoes.status.chave, 'dentro_do_limite');
  // Total 30% (1900+1100+0)/10000 : <= meta 31,43 => dentro_da_meta
  assert.equal(ind.total_deducoes.status.chave, 'dentro_da_meta');

  // Cards da Visão Geral: meta ESTÁTICA e régua histórica (statusIndicador)
  assert.equal(d.cards.servicosPromocoes.meta.metaIdeal, 9.5);   // não derivada
  assert.equal(d.cards.servicosPromocoes.status.chave, 'atencao'); // 11% > meta 9,5, <= limite 14,5 (régua antiga)
});
