// Checklist Operacional 2.0 — metas persistidas, períodos, indicadores históricos, análises, Excel e rotas.
//
// Sem banco e sem rede: repositórios falsos injetados (o SQL da migration 127 tem teste próprio em Postgres local:
// checklist-metas-migration-pg.test.js). Relógio fixo: quarta-feira 21/10/2026, 15:00 em São Paulo (UTC−3).
//
// Rodar: node --experimental-vm-modules --test test/checklist-operacional-2.test.js

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const XLSX = await import("xlsx");
const { default: express } = await import("express");
const metas = await import("../src/modules/checklist-operacional/checklistOperacional.metas.js");
const periodos = await import("../src/modules/checklist-operacional/checklistOperacional.periodos.js");
const ind = await import("../src/modules/checklist-operacional/checklistOperacional.indicadores.js");
const { gerarAnalises, LIMIARES } = await import("../src/modules/checklist-operacional/checklistOperacional.analises.js");
const exportar = await import("../src/modules/checklist-operacional/checklistOperacional.exportar.js");
const service = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
const { checklistOperacionalRouter } = await import("../src/modules/checklist-operacional/checklistOperacional.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { rotaPermitidaAoPerfilExibicao } = await import("../src/middlewares/perfilExibicao.js");

const AGORA = Date.parse("2026-10-21T18:00:00.000Z"); // qua 21/10, 15:00 em SP
const ORG = "11111111-1111-4111-8111-111111111111";
const UN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MIN = 60_000;

/** Instante em SP: dia (YYYY-MM-DD) e hora local → ISO UTC. */
const sp = (dia, hh, mm = 0) => new Date(Date.parse(`${dia}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-03:00`)).toISOString();
const mais = (iso, min) => (iso ? new Date(Date.parse(iso) + min * MIN).toISOString() : null);

let seq = 0;
/** Pedido entregue com preparo/entrega/vida em minutos a partir do recebimento. */
function pedido({ recebido, confirma = 1, preparo = 10, espera = 2, entrega = 20, status = "CONCLUDED", tipo = "DELIVERY", agendado = false, teste = false, semRtp = false, id } = {}) {
  seq += 1;
  const cfm = mais(recebido, confirma);
  const rtp = semRtp ? null : mais(cfm, preparo);
  const dsp = mais(cfm, preparo + espera);
  const con = mais(dsp, entrega);
  return {
    order_id: id ?? `o-${seq}`, display_id: String(1000 + seq), status_oficial: status,
    status_oficial_em: status === "CONCLUDED" ? con : status === "CANCELLED" ? mais(recebido, 5) : dsp,
    order_type: tipo, delivery_by: "IFOOD", order_timing: agendado ? "SCHEDULED" : "IMMEDIATE", is_test: teste,
    order_created_at: recebido, placed_event_created_at: recebido, confirmed_event_at: cfm, ready_event_at: rtp,
    dispatch_event_at: status === "CANCELLED" ? null : dsp, cancel_event_at: null,
    primeiro_evento_em: recebido, criado_em: recebido, merchant_id: "m-1",
  };
}

const META_V1 = { preparo: { meta: 12, avisoPct: 80 }, entrega: { meta: 30, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } };
const META_V2 = { preparo: { meta: 8, avisoPct: 80 }, entrega: { meta: 30, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } };
const historico = (...versoes) => versoes.map(([versao, alterado_em, novo]) => ({ versao, alterado_em, novo }));

// =====================================================================
describe("metas — validação e meta vigente (puro)", () => {
  test("mesma régua do formulário: 0 < meta ≤ 240; 50 ≤ aviso ≤ 99; vírgula aceita; uma casa decimal", () => {
    const ok = metas.validarMetasEntrada({ preparo: { meta: "12,25", avisoPct: 80 }, entrega: { meta: 35, avisoPct: "75" }, vida: { meta: 45, avisoPct: 99 } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.metas.preparo, { meta: 12.3, avisoPct: 80 });
    const ruim = metas.validarMetasEntrada({ preparo: { meta: 0, avisoPct: 49 }, entrega: { meta: 241, avisoPct: 100 }, vida: {} });
    assert.equal(ruim.ok, false);
    assert.deepEqual(Object.keys(ruim.erros).sort(), ["entrega.avisoPct", "entrega.meta", "preparo.avisoPct", "preparo.meta", "vida.avisoPct", "vida.meta"]);
    assert.equal(metas.validarMetasEntrada({ ...META_V1, preparo: { meta: 0.04, avisoPct: 80 } }).ok, false, "arredondar para 0 é recusado");
  });

  test("sem linha salva: exemplo marcado como 'padrao' (versão 0) — nunca vira meta da unidade", () => {
    const m = metas.metasDaLinha(null);
    assert.equal(m.origem, "padrao");
    assert.equal(m.versao, 0);
    assert.deepEqual(m.valores, { preparo: { meta: 12, avisoPct: 80 }, entrega: { meta: 35, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } });
  });

  test("meta vigente = última versão salva até o instante; antes da primeira, nenhuma", () => {
    const lt = metas.linhaDoTempoDasMetas(historico([2, sp("2026-10-20", 12), META_V2], [1, sp("2026-10-10", 9), META_V1], [3, "lixo", META_V1]));
    assert.deepEqual(lt.map((v) => v.versao), [1, 2], "inválidas ignoradas e ordem cronológica");
    assert.equal(metas.metaVigenteEm(lt, Date.parse(sp("2026-10-09", 23))), null);
    assert.equal(metas.metaVigenteEm(lt, Date.parse(sp("2026-10-10", 9))).versao, 1, "o instante exato já vale");
    assert.equal(metas.metaVigenteEm(lt, Date.parse(sp("2026-10-20", 11, 59))).versao, 1);
    assert.equal(metas.metaVigenteEm(lt, Date.parse(sp("2026-10-21", 1))).versao, 2);
  });
});

// =====================================================================
/** Repositório de metas em memória com a MESMA semântica da função do banco (versão esperada, histórico). */
function repoMetasEmMemoria() {
  const linhas = new Map();
  const hist = [];
  const chamadas = [];
  return {
    chamadas, hist,
    async obterMetas({ organizacaoId, unidadeId }) { chamadas.push(["obter", organizacaoId, unidadeId]); return linhas.get(`${organizacaoId}|${unidadeId}`) ?? null; },
    async salvarMetas({ organizacaoId, unidadeId, versaoEsperada, metas: m, origem, autor }) {
      chamadas.push(["salvar", organizacaoId, unidadeId, versaoEsperada]);
      const k = `${organizacaoId}|${unidadeId}`;
      const atual = linhas.get(k);
      const json = (l) => ({ preparo: { meta: l.preparo_meta_min, avisoPct: l.preparo_aviso_pct }, entrega: { meta: l.entrega_meta_min, avisoPct: l.entrega_aviso_pct }, vida: { meta: l.vida_meta_min, avisoPct: l.vida_aviso_pct } });
      const resp = (resultado, l) => ({ resultado, versao_atual: l?.versao ?? 0, metas_atual: l ? json(l) : null, atualizado_em_atual: l?.atualizado_em ?? null, atualizado_por_atual: l?.atualizado_por_nome ?? null });
      if ((atual?.versao ?? 0) !== versaoEsperada) return resp("conflito", atual);
      const nova = {
        versao: (atual?.versao ?? 0) + 1, atualizado_em: new Date(AGORA + hist.length * 1000).toISOString(), atualizado_por_nome: autor?.nome ?? null,
        preparo_meta_min: m.preparo.meta, preparo_aviso_pct: m.preparo.avisoPct, entrega_meta_min: m.entrega.meta, entrega_aviso_pct: m.entrega.avisoPct,
        vida_meta_min: m.vida.meta, vida_aviso_pct: m.vida.avisoPct,
      };
      if (atual && JSON.stringify(json(atual)) === JSON.stringify(json(nova))) return resp("sem_alteracao", atual);
      linhas.set(k, nova);
      hist.push({ organizacaoId, unidadeId, versao: nova.versao, anterior: atual ? json(atual) : null, novo: json(nova), origem, alterado_por_nome: autor?.nome });
      return resp("salvo", nova);
    },
  };
}

describe("metas — service (persistência, concorrência, isolamento, aviso em tempo real)", () => {
  const autor = { perfilId: "p-1", usuarioId: "u-1", nome: "Gestora", impersonadoPor: null };

  test("primeiro salvamento (versão 0 → 1), leitura depois de 'recarregar' e histórico com antes/depois", async () => {
    const repo = repoMetasEmMemoria();
    const emitidos = [];
    const emitir = async (e, o) => { emitidos.push([e, o]); };
    const r1 = await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V1 }, autor, deps: { repo, emitir } });
    assert.equal(r1.resultado, "salvo");
    assert.equal(r1.metas.versao, 1);
    const lido = await service.obterMetas({ organizacaoId: ORG, unidadeId: UN_A, deps: { repo } });
    assert.equal(lido.origem, "unidade");
    assert.deepEqual(lido.valores, META_V1, "outro aparelho/recarga lê o mesmo valor do servidor");
    const r2 = await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: META_V2 }, autor, deps: { repo, emitir } });
    assert.equal(r2.metas.versao, 2);
    assert.deepEqual(repo.hist.map((h) => [h.versao, h.anterior?.preparo.meta ?? null, h.novo.preparo.meta, h.alterado_por_nome]), [[1, null, 12, "Gestora"], [2, 12, 8, "Gestora"]]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(emitidos.map(([e, o]) => [e.tipo, e.unidadeId, e.versao, o.somenteUnidade]), [
      ["checklist_metas.atualizadas", UN_A, 1, true], ["checklist_metas.atualizadas", UN_A, 2, true],
    ], "aviso só no tópico da unidade, com a versão (sem valores)");
    assert.ok(emitidos.every(([e]) => !("metas" in e) && !("valores" in e)), "o aviso não leva as metas");
  });

  test("edição simultânea: dois aparelhos com a versão 1 — um salva, o outro recebe 409 METAS_CONFLITO com o valor atual", async () => {
    const repo = repoMetasEmMemoria();
    const emitir = async () => {};
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V1 }, autor, deps: { repo, emitir } });
    const [a, b] = await Promise.allSettled([
      service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: META_V2 }, autor, deps: { repo, emitir } }),
      service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: { ...META_V1, vida: { meta: 50, avisoPct: 80 } } }, autor, deps: { repo, emitir } }),
    ]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected");
    assert.equal(b.reason.statusCode, 409);
    assert.equal(b.reason.codigo, "METAS_CONFLITO");
    assert.equal(b.reason.details.metas.versao, 2);
    assert.deepEqual(b.reason.details.metas.valores, META_V2, "o conflito devolve o que está valendo para a tela reconciliar");
    assert.equal(repo.hist.length, 2, "o perdedor não gravou nada");
  });

  test("migração de configuração local NUNCA sobrescreve meta já persistida", async () => {
    const repo = repoMetasEmMemoria();
    const emitir = async () => {};
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V1 }, autor, deps: { repo, emitir } });
    await assert.rejects(
      service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V2, origem: "migracao_local" }, autor, deps: { repo, emitir } }),
      (e) => e.statusCode === 409,
    );
    await assert.rejects(
      service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: META_V2, origem: "migracao_local" }, autor, deps: { repo, emitir } }),
      (e) => e.statusCode === 400,
    );
    assert.deepEqual((await service.obterMetas({ organizacaoId: ORG, unidadeId: UN_A, deps: { repo } })).valores, META_V1);
  });

  test("mesmos valores: 'sem_alteracao' (nenhuma versão nova, nenhum aviso)", async () => {
    const repo = repoMetasEmMemoria();
    const emitidos = [];
    const emitir = async (e) => { emitidos.push(e); };
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V1 }, autor, deps: { repo, emitir } });
    const r = await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: META_V1 }, autor, deps: { repo, emitir } });
    assert.equal(r.resultado, "sem_alteracao");
    await new Promise((res) => setImmediate(res));
    assert.equal(emitidos.length, 1);
  });

  test("isolamento: metas da unidade A não aparecem na B, e o tenant vem só dos argumentos (contexto)", async () => {
    const repo = repoMetasEmMemoria();
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V2, unidadeId: UN_B, organizacaoId: "outra" }, autor, deps: { repo, emitir: async () => {} } });
    assert.equal((await service.obterMetas({ organizacaoId: ORG, unidadeId: UN_B, deps: { repo } })).origem, "padrao");
    assert.ok(repo.chamadas.every(([, org]) => org === ORG), "ids do corpo são ignorados");
    assert.deepEqual(repo.chamadas.find(([op]) => op === "salvar").slice(1, 3), [ORG, UN_A]);
  });

  test("entrada inválida: 400 com os erros por campo; versão ausente/negativa: 400", async () => {
    const repo = repoMetasEmMemoria();
    await assert.rejects(service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: { preparo: { meta: 999 } } }, autor, deps: { repo } }),
      (e) => e.statusCode === 400 && Boolean(e.details.erros["preparo.meta"]));
    await assert.rejects(service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { metas: META_V1 }, autor, deps: { repo } }), (e) => e.statusCode === 400);
    await assert.rejects(service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: -1, metas: META_V1 }, autor, deps: { repo } }), (e) => e.statusCode === 400);
    assert.equal(repo.hist.length, 0);
  });

  test("falha de gravação NÃO apaga a última configuração válida", async () => {
    const repo = repoMetasEmMemoria();
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V1 }, autor, deps: { repo, emitir: async () => {} } });
    const quebrado = { ...repo, salvarMetas: async () => { throw new Error("rede caiu"); } };
    await assert.rejects(service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 1, metas: META_V2 }, autor, deps: { repo: quebrado } }));
    assert.deepEqual((await service.obterMetas({ organizacaoId: ORG, unidadeId: UN_A, deps: { repo } })).valores, META_V1);
  });

  test("resumo da tela: metas embutidas; sem a migration (ou falha de leitura) o resumo NÃO cai — exemplo marcado 'indisponivel'", async () => {
    const repo = repoMetasEmMemoria();
    await service.salvarMetas({ organizacaoId: ORG, unidadeId: UN_A, corpo: { versao: 0, metas: META_V2 }, autor, deps: { repo, emitir: async () => {} } });
    assert.deepEqual((await service.carregarMetasParaTela({ repo, organizacaoId: ORG, unidadeId: UN_A })).valores, META_V2);
    const semMigration = { obterMetas: async () => { const e = new Error("x"); e.codigo = "METAS_INDISPONIVEIS"; throw e; } };
    const m = await service.carregarMetasParaTela({ repo: semMigration, organizacaoId: ORG, unidadeId: UN_A });
    assert.equal(m.origem, "indisponivel");
    assert.equal(m.motivo, "migration_pendente");
    assert.equal((await service.carregarMetasParaTela({ repo: { obterMetas: async () => { throw new Error("rede"); } }, organizacaoId: ORG, unidadeId: UN_A })).motivo, "falha_leitura");
  });
});

// =====================================================================
describe("períodos — limites no fuso da operação e comparativo equivalente", () => {
  const r = (p) => periodos.resolverPeriodo({ agoraMs: AGORA, ...p });

  test("hoje: dia local inteiro, parcial; o comparativo (ontem) é cortado no MESMO horário", () => {
    const p = r({ periodo: "hoje" });
    assert.equal(p.atual.inicio, "2026-10-21");
    assert.equal(new Date(p.atual.inicioMs).toISOString(), "2026-10-21T03:00:00.000Z", "00:00 em SP = 03:00 UTC");
    assert.equal(p.parcial, true);
    assert.equal(p.anterior.inicio, "2026-10-20");
    assert.equal(new Date(p.anterior.corteMs).toISOString(), "2026-10-20T18:00:00.000Z", "ontem até as 15:00");
  });

  test("ontem → anteontem (dia inteiro, sem corte)", () => {
    const p = r({ periodo: "ontem" });
    assert.deepEqual([p.atual.inicio, p.atual.fim, p.anterior.inicio, p.anterior.corteMs, p.parcial], ["2026-10-20", "2026-10-20", "2026-10-19", null, false]);
  });

  test("semana: segunda até hoje; comparativo = mesmos dias da semana anterior", () => {
    const p = r({ periodo: "semana" });
    assert.deepEqual([p.atual.inicio, p.atual.fim, p.anterior.inicio, p.anterior.fim], ["2026-10-19", "2026-10-21", "2026-10-12", "2026-10-14"]);
  });

  test("mês: dia 1 até hoje; comparativo = mês anterior do dia 1 ao mesmo dia (limitado ao fim do mês)", () => {
    const p = r({ periodo: "mes" });
    assert.deepEqual([p.atual.inicio, p.atual.fim, p.anterior.inicio, p.anterior.fim], ["2026-10-01", "2026-10-21", "2026-09-01", "2026-09-21"]);
    const fimDeMes = periodos.resolverPeriodo({ periodo: "mes", agoraMs: Date.parse("2026-03-31T15:00:00Z") });
    assert.equal(fimDeMes.anterior.fim, "2026-02-28");
  });

  test("personalizado: inclusivo, comparativo de mesma duração imediatamente antes; erros claros", () => {
    const p = r({ periodo: "personalizado", inicio: "2026-10-01", fim: "2026-10-10" });
    assert.deepEqual([p.atual.dias, p.anterior.inicio, p.anterior.fim, p.parcial], [10, "2026-09-21", "2026-09-30", false]);
    assert.equal(r({ periodo: "personalizado", inicio: "2026-02-30", fim: "2026-03-01" }).codigo, "DATA_INVALIDA");
    assert.equal(r({ periodo: "personalizado", inicio: "2026-10-10", fim: "2026-10-01" }).codigo, "DATA_INVALIDA");
    assert.equal(r({ periodo: "personalizado", inicio: "2026-10-20", fim: "2026-10-22" }).codigo, "DATA_FUTURA");
    assert.equal(r({ periodo: "personalizado", inicio: "2026-01-01", fim: "2026-10-01" }).codigo, "PERIODO_GRANDE_DEMAIS");
    assert.equal(r({ periodo: "ano" }).codigo, "PERIODO_INVALIDO");
  });
});

// =====================================================================
describe("indicadores — cálculo, meta vigente, ausências e deduplicação", () => {
  const lt = metas.linhaDoTempoDasMetas(historico([1, sp("2026-10-01", 0), META_V1], [2, sp("2026-10-20", 12), META_V2]));
  const periodo = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-20", fim: "2026-10-20", agoraMs: AGORA });

  test("média, mediana e P90 (interpolação linear = PERCENTIL.INC)", () => {
    assert.deepEqual(ind.estatisticas([10, 20, 30, 40]), { amostras: 4, media: 25, mediana: 25, p90: 37, minimo: 10, maximo: 40 });
    assert.deepEqual(ind.estatisticas([]), { amostras: 0, media: null, mediana: null, p90: null, minimo: null, maximo: null }, "vazio é ausente, nunca zero");
    assert.equal(ind.percentil([5], 0.9), 5);
  });

  test("cada pedido é avaliado pela meta vigente NO RECEBIMENTO: mudar a meta não reescreve o passado", () => {
    // Preparo de 10 min: dentro da meta v1 (12) de manhã; fora da v2 (8) depois das 12:00.
    const pedidos = [pedido({ recebido: sp("2026-10-20", 10) }), pedido({ recebido: sp("2026-10-20", 13) })];
    const d = ind.montarDashboard({ pedidos, periodo, linhaDoTempo: lt, etapa: "preparo" });
    const pr = d.resumo.porEtapa.preparo;
    assert.deepEqual([pr.amostras, pr.avaliadas, pr.dentro, pr.atrasos, pr.pctDentro], [2, 2, 1, 1, 50]);
    assert.equal(pr.maiorAtraso.excedenteMin, 2);
    assert.equal(pr.maiorAtraso.metaMin, 8);
    assert.deepEqual(d.metasAplicaveis.versoes.map((v) => v.versao), [1, 2]);
    assert.equal(d.atrasos.itens[0].versaoMeta, 2);
  });

  test("sem meta vigente: entra nos tempos, fica FORA do % dentro da meta e é contado à parte", () => {
    const semHist = ind.montarDashboard({ pedidos: [pedido({ recebido: sp("2026-10-20", 10) })], periodo, linhaDoTempo: [], etapa: "todas" });
    const pr = semHist.resumo.porEtapa.preparo;
    assert.deepEqual([pr.amostras, pr.avaliadas, pr.pctDentro, pr.semMetaVigente], [1, 0, null, 1]);
    assert.equal(semHist.metasAplicaveis.inicioSemMeta, true);
    assert.ok(semHist.qualidade.avisos.some((a) => /não tinha meta salva/.test(a)));
  });

  test("elegibilidade: teste fora de tudo; cancelado fora das durações; agendado fora de preparo e vida; retirada fora da entrega", () => {
    const pedidos = [
      pedido({ recebido: sp("2026-10-20", 10) }),
      pedido({ recebido: sp("2026-10-20", 10, 5), teste: true }),
      pedido({ recebido: sp("2026-10-20", 10, 10), status: "CANCELLED" }),
      pedido({ recebido: sp("2026-10-20", 10, 15), agendado: true }),
      pedido({ recebido: sp("2026-10-20", 10, 20), tipo: "TAKEOUT" }),
    ];
    const d = ind.montarDashboard({ pedidos, periodo, linhaDoTempo: lt });
    assert.equal(d.resumo.pedidos, 4, "teste não conta");
    assert.equal(d.qualidade.pedidosTeste, 1);
    assert.equal(d.resumo.cancelados, 1);
    assert.equal(d.resumo.porEtapa.preparo.amostras, 2, "normal + retirada (agendado e cancelado fora)");
    assert.equal(d.resumo.porEtapa.vida.amostras, 2);
    assert.equal(d.resumo.porEtapa.entrega.amostras, 2, "normal + agendado (retirada e cancelado fora)");
  });

  test("dia do pedido = recebimento oficial (não o registro); duplicata por order_id não conta duas vezes", () => {
    const tardio = { ...pedido({ recebido: sp("2026-10-20", 23, 50) }), criado_em: sp("2026-10-21", 0, 30) };
    const dup = pedido({ recebido: sp("2026-10-20", 11), id: "repetido" });
    const d = ind.montarDashboard({ pedidos: [tardio, dup, { ...dup }], periodo, linhaDoTempo: lt });
    assert.equal(d.resumo.pedidos, 2);
    assert.equal(d.demandaPorHora[23].pedidos, 1, "23h em SP (não 02h UTC)");
  });

  test("duração inconsistente é descartada e CONTADA; preparo sem 'pronto' é aproximado e avisado", () => {
    const negativo = { ...pedido({ recebido: sp("2026-10-20", 9) }), ready_event_at: sp("2026-10-20", 8) };
    const d = ind.montarDashboard({ pedidos: [negativo, pedido({ recebido: sp("2026-10-20", 9, 30), semRtp: true })], periodo, linhaDoTempo: lt, etapa: "preparo" });
    assert.equal(d.resumo.porEtapa.preparo.descartados, 1);
    assert.equal(d.resumo.porEtapa.preparo.aproximadas, 1);
    assert.ok(d.qualidade.avisos.some((a) => /sem o evento "pronto"/.test(a)));
  });

  test("cobertura: dias antes do primeiro pedido da unidade ficam marcados e fora do denominador por dia da semana", () => {
    const sem = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-20", agoraMs: AGORA });
    const d = ind.montarDashboard({ pedidos: [pedido({ recebido: sp("2026-10-19", 12) })], periodo: sem, linhaDoTempo: lt, primeiroPedidoEm: sp("2026-10-19", 12) });
    assert.equal(d.qualidade.diasSemCobertura, 7);
    assert.equal(d.evolucaoDiaria.filter((x) => x.semCobertura).length, 7);
    const segunda = d.volumePorDiaDaSemana.find((s) => s.dia === 1);
    assert.deepEqual([segunda.pedidos, segunda.diasObservados, segunda.mediaPorDia], [1, 1, 1], "a segunda 12/10 (sem cobertura) não entra");
    assert.equal(d.evolucaoDiaria.length, 9, "todos os dias aparecem, inclusive sem pedido");
  });

  test("comparativo cortado no mesmo horário (hoje até 15:00 × ontem até 15:00)", () => {
    const hoje = periodos.resolverPeriodo({ periodo: "hoje", agoraMs: AGORA });
    const pedidos = [pedido({ recebido: sp("2026-10-21", 12) }), pedido({ recebido: sp("2026-10-20", 12) }), pedido({ recebido: sp("2026-10-20", 16) })];
    const d = ind.montarDashboard({ pedidos, periodo: hoje, linhaDoTempo: lt });
    assert.deepEqual([d.comparacao.pedidos.atual, d.comparacao.pedidos.anterior], [1, 1], "o pedido de ontem às 16:00 fica fora do comparativo");
    assert.ok(d.qualidade.avisos.some((a) => /parciais/.test(a)));
  });

  test("filtro de etapa e indicadores sem registros (itens do checklist) indisponíveis com motivo", () => {
    const d = ind.montarDashboard({ pedidos: [pedido({ recebido: sp("2026-10-20", 10) })], periodo, linhaDoTempo: lt, etapa: "entrega" });
    assert.deepEqual(d.etapas, ["entrega"]);
    assert.deepEqual(Object.keys(d.resumo.porEtapa), ["entrega"]);
    assert.equal(d.checklistItens.disponivel, false);
    assert.match(d.checklistItens.motivo, /não registra itens de checklist/);
    for (const def of Object.values(d.definicoes)) for (const k of ["nome", "definicao", "formula", "unidade", "denominador", "ausentes"]) assert.ok(def[k], `${def.nome}: ${k}`);
  });

  test("resposta não carrega campos internos nem dado de cliente/merchant/orderId", () => {
    const d = ind.paraResposta(ind.montarDashboard({ pedidos: [{ ...pedido({ recebido: sp("2026-10-20", 10), preparo: 30, id: "ORDER-SECRETO" }), customer: { name: "Cliente" } }], periodo, linhaDoTempo: lt }));
    const json = JSON.stringify(d);
    assert.ok(!("_itens" in d));
    assert.doesNotMatch(json, /ORDER-SECRETO|Cliente|m-1|merchant/);
  });
});

// =====================================================================
/** Semana com atrasos concentrados às 20h em três dias (reincidência) e um dia ruim. */
function cenarioAnalises() {
  const lista = [];
  const dias = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  for (const dia of dias) {
    for (let h = 11; h <= 21; h += 1) {
      for (let k = 0; k < 2; k += 1) {
        const ruim = h === 20 && ["2026-10-13", "2026-10-15", "2026-10-17"].includes(dia);
        const diaRuim = dia === "2026-10-16" && h >= 12 && h <= 19;
        lista.push(pedido({ recebido: sp(dia, h, k * 20), preparo: ruim || diaRuim ? 25 : 9 }));
      }
    }
  }
  return lista;
}

describe("análises — determinísticas, com evidência, sem causa inventada", () => {
  const lt = metas.linhaDoTempoDasMetas(historico([1, sp("2026-09-01", 0), META_V1]));
  const periodo = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-18", agoraMs: AGORA });

  test("detecta reincidência no mesmo horário, dia crítico e preparo anormal — cada uma com fato, referência, ocorrências e evidências", () => {
    const d = ind.montarDashboard({ pedidos: cenarioAnalises(), periodo, linhaDoTempo: lt, etapa: "preparo" });
    const a = gerarAnalises(d);
    const tipos = a.itens.map((x) => x.tipo);
    assert.ok(tipos.includes("reincidencia"), tipos.join(","));
    assert.ok(tipos.includes("dias_criticos"), tipos.join(","));
    assert.ok(tipos.includes("preparo_anormal"), tipos.join(","));
    const reinc = a.itens.find((x) => x.tipo === "reincidencia");
    assert.match(reinc.constatacao, /20h–21h/);
    assert.equal(reinc.evidencias.ocorrencias.length, 3);
    assert.ok(reinc.evidencias.pedidos.itens.every((p) => p.hora === 20));
    const critico = a.itens.find((x) => x.tipo === "dias_criticos");
    assert.ok(critico.evidencias.dias.some((x) => x.data === "2026-10-16"));
    for (const x of a.itens) {
      for (const k of ["constatacao", "indicador", "referencia", "evidencias", "periodo"]) assert.ok(x[k] != null, `${x.tipo}: ${k}`);
      assert.equal(typeof x.ocorrencias, "number");
      assert.equal(x.natureza.constatacao, "fato");
      assert.equal(x.natureza.hipotese, x.hipotese ? "hipotese" : null);
      if (x.hipotese) assert.match(x.hipotese, /Não comprovado/i, "hipótese sempre se declara não comprovada");
    }
    assert.ok(a.itens.findIndex((x) => x.severidade === "alta") <= a.itens.findIndex((x) => x.severidade === "informativa"), "mais grave primeiro");
  });

  test("dados insuficientes: as regras não rodam e dizem por quê (nada é estimado)", () => {
    const um = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-12", agoraMs: AGORA });
    const d = ind.montarDashboard({ pedidos: [pedido({ recebido: sp("2026-10-12", 12) })], periodo: um, linhaDoTempo: lt });
    const a = gerarAnalises(d);
    assert.ok(a.naoAvaliadas.length >= 4, JSON.stringify(a.naoAvaliadas));
    assert.ok(!a.itens.some((x) => ["concentracao_horario", "dias_criticos", "reincidencia", "preparo_anormal"].includes(x.tipo)));
  });

  test("piora entre períodos só com amostra mínima nos dois lados", () => {
    const sem = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-19", fim: "2026-10-20", agoraMs: AGORA });
    const pedidos = [];
    for (let k = 0; k < LIMIARES.compMinAmostras; k += 1) {
      pedidos.push(pedido({ recebido: sp("2026-10-17", 12, k), preparo: 8 }), pedido({ recebido: sp("2026-10-19", 12, k), preparo: 14 }));
    }
    const a = gerarAnalises(ind.montarDashboard({ pedidos, periodo: sem, linhaDoTempo: lt, etapa: "preparo" }));
    const piora = a.itens.find((x) => x.tipo === "piora_preparo");
    assert.ok(piora, a.itens.map((x) => x.tipo).join(","));
    assert.match(piora.constatacao, /mediana de 8 para 14 min/);
  });
});

// =====================================================================
describe("relatório Excel — mesmo payload da tela, seções escolhidas", () => {
  test("uma aba por seção pedida, números como números e metadados de unidade/período", () => {
    const lt = metas.linhaDoTempoDasMetas(historico([1, sp("2026-09-01", 0), META_V1]));
    const periodo = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-18", agoraMs: AGORA });
    const d = ind.montarDashboard({ pedidos: cenarioAnalises(), periodo, linhaDoTempo: lt });
    const analises = gerarAnalises(d);
    const dashboard = ind.paraResposta(d);
    const buf = exportar.gerarExcel({ dashboard, analises, unidadeNome: "Subway Saci", geradoEm: new Date(AGORA).toISOString(), secoes: exportar.secoesPedidas("etapas,analises,xpto") });
    const wb = XLSX.read(buf, { type: "buffer" });
    assert.deepEqual(wb.SheetNames, ["Etapas", "Análises"]);
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets.Etapas, { header: 1 });
    assert.deepEqual(linhas[1], ["Unidade", "Subway Saci"]);
    const preparo = linhas.find((l) => l[0] === "Preparo");
    assert.equal(preparo[1], dashboard.resumo.porEtapa.preparo.amostras);
    assert.equal(preparo[3], dashboard.resumo.porEtapa.preparo.mediana);
    const an = XLSX.utils.sheet_to_json(wb.Sheets["Análises"], { header: 1 }).flat().join(" ");
    assert.match(an, /Hipótese \(não comprovada\)/);
    assert.deepEqual(exportar.secoesPedidas(""), exportar.IDS_SECOES, "vazio = todas");
  });
});

// =====================================================================
describe("dashboard — service (isolamento e janela)", () => {
  test("toda leitura usa o tenant do contexto; sem a migration de metas, avisa e não avalia contra meta", async () => {
    const chamadas = [];
    const repo = {
      listarVersoesMetas: async (a) => { chamadas.push(a); const e = new Error("x"); e.codigo = "METAS_INDISPONIVEIS"; throw e; },
      listarPedidosDoPeriodo: async (a) => { chamadas.push(a); return [pedido({ recebido: sp("2026-10-20", 10) })]; },
      obterPrimeiroPedidoEm: async (a) => { chamadas.push(a); return sp("2026-10-01", 9); },
    };
    const d = await service.obterDashboard({ organizacaoId: ORG, unidadeId: UN_A, filtro: { periodo: "ontem", unidadeId: UN_B }, agora: () => new Date(AGORA), deps: { repo } });
    assert.ok(chamadas.every((c) => c.organizacaoId === ORG && c.unidadeId === UN_A));
    assert.equal(d.resumo.pedidos, 1);
    assert.equal(d.resumo.porEtapa.preparo.avaliadas, 0);
    assert.match(d.qualidade.avisos[0], /migration 127 pendente/);
    assert.ok(Array.isArray(d.analises.itens));
    const janela = chamadas.find((c) => c.desdeIso);
    assert.ok(Date.parse(janela.desdeIso) <= Date.parse(sp("2026-10-19", 0)), "janela cobre o comparativo (anteontem)");
  });

  test("filtro inválido: 400 (período, datas, etapa)", async () => {
    const repo = { listarVersoesMetas: async () => [], listarPedidosDoPeriodo: async () => [], obterPrimeiroPedidoEm: async () => null };
    const chamar = (filtro) => service.obterDashboard({ organizacaoId: ORG, unidadeId: UN_A, filtro, agora: () => new Date(AGORA), deps: { repo } });
    await assert.rejects(chamar({ periodo: "ano" }), (e) => e.statusCode === 400);
    await assert.rejects(chamar({ periodo: "personalizado", inicio: "2026-13-01", fim: "2026-10-01" }), (e) => e.statusCode === 400);
    await assert.rejects(chamar({ etapa: "cozinha" }), (e) => e.statusCode === 400);
  });
});

// =====================================================================
describe("HTTP — permissões das rotas novas", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    const papel = req.headers["x-teste-papel"];
    req.user = { id: `u-${papel}` };
    req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { organizacaoId: ORG, unidadeId: null }; // sem unidade: o controller para ANTES do banco (400)
    next();
  }, requireModulo(MODULOS.IFOOD), checklistOperacionalRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  after(() => server.close());

  const chamar = (metodo, url, papel, corpo) => new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: `/api/v1${url}`, method: metodo,
      headers: { "x-teste-papel": papel, ...(dados ? { "content-type": "application/json", "content-length": Buffer.byteLength(dados) } : {}) } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(dados);
  });

  test("PUT /metas e histórico: só organization_admin e unit_manager (finance/operations/viewer/exibição: 403)", async () => {
    for (const [papel, esperado] of [["organization_admin", 400], ["unit_manager", 400], ["finance", 403], ["operations", 403], ["viewer", 403], ["display_operator", 403]]) {
      assert.equal(await chamar("PUT", "/metas", papel, { versao: 0, metas: META_V1 }), esperado, `PUT ${papel}`);
      assert.equal(await chamar("GET", "/metas/historico", papel), esperado, `historico ${papel}`);
    }
  });

  test("GET /dashboard, /dashboard/exportar.xlsx e /metas: quem já vê o Checklist", async () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      for (const url of ["/dashboard?periodo=hoje", "/dashboard/exportar.xlsx", "/metas"]) assert.equal(await chamar("GET", url, papel), 400, `${papel} ${url}`);
    }
  });

  test("perfil de exibição: o bloqueio por lista exata continua permitindo SÓ o resumo (metas chegam pelo resumo)", () => {
    assert.equal(rotaPermitidaAoPerfilExibicao("GET", "/checklist-operacional/resumo"), true);
    for (const [m, c] of [["GET", "/checklist-operacional/metas"], ["PUT", "/checklist-operacional/metas"], ["GET", "/checklist-operacional/metas/historico"],
      ["GET", "/checklist-operacional/dashboard"], ["GET", "/checklist-operacional/dashboard/exportar.xlsx"]]) {
      assert.equal(rotaPermitidaAoPerfilExibicao(m, c), false, `${m} ${c}`);
    }
  });
});

// =====================================================================
describe("Agente Crescer — tool só-leitura sobre o MESMO cálculo", async () => {
  const tool = await import("../src/modules/agente/tools/checklistOperacional.tool.js");
  const acesso = { modulos: [MODULOS.IFOOD], permissoes: ["checklist.visualizar"], impersonando: false };

  test("tenant do contexto (nunca do modelo); sem unidade: indisponível; separa fato/hipótese/recomendação", async () => {
    const lt = metas.linhaDoTempoDasMetas(historico([1, sp("2026-09-01", 0), META_V1]));
    const periodo = periodos.resolverPeriodo({ periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-18", agoraMs: AGORA });
    const d = ind.montarDashboard({ pedidos: cenarioAnalises(), periodo, linhaDoTempo: lt });
    const pronto = { ...ind.paraResposta(d), analises: gerarAnalises(d) };
    const chamadas = [];
    const r = await tool.executar({ periodo: "semana", unidadeId: UN_B }, { organizacaoId: ORG, unidadeId: UN_A, acesso }, { obterDashboard: async (a) => { chamadas.push(a); return pronto; } });
    assert.equal(chamadas[0].unidadeId, UN_A);
    assert.equal(r.porEtapa.preparo.medianaMin, pronto.resumo.porEtapa.preparo.mediana, "número repassado, não recalculado");
    assert.ok(r.analises.length && r.analises.every((a) => "constatacao" in a && "hipotese" in a && "recomendacao" in a));
    assert.equal((await tool.executar({ periodo: "hoje" }, { organizacaoId: ORG, unidadeId: null, acesso })).disponivel, false);
    await assert.rejects(tool.executar({ periodo: "hoje" }, { organizacaoId: ORG, unidadeId: UN_A, acesso: { ...acesso, permissoes: [] } }));
    // Módulo próprio (migration 123) ou ifood (sessões anteriores a ela) — a mesma régua do gate da API; sem nenhum dos dois, 403.
    const proprio = { ...acesso, modulos: [MODULOS.CHECKLIST_OPERACIONAL] };
    assert.equal((await tool.executar({ periodo: "semana" }, { organizacaoId: ORG, unidadeId: UN_A, acesso: proprio }, { obterDashboard: async () => pronto })).disponivel, true);
    await assert.rejects(tool.executar({ periodo: "hoje" }, { organizacaoId: ORG, unidadeId: UN_A, acesso: { ...acesso, modulos: [MODULOS.IFOOD_DASHBOARD] } }), (e) => e.statusCode === 403);
  });
});
