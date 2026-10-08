// Relatório diário do Dashboard iFood no grupo interno (Fase 4) — fluxo INDEPENDENTE do dashboard_ifood_d1.
// SEM banco real, SEM rede: supabase falso com UNIQUE(chave_idempotencia) e um WhatsAppService falso que conta envios.
//
// Rodar: node --env-file-if-exists=.env --test test/relatorio-dashboard-grupo.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  avaliarHorarioDoRelatorio, chaveRelatorio, montarRelatorio, executarPassoRelatorio, unidadesAvisadasHoje, MODOS_RELATORIO,
} from "../src/modules/comunicacao/relatorioDashboardGrupo.js";
import { modoRelatorio } from "../src/modules/comunicacao/relatorioDashboardGrupo.config.js";
import { criarLoopWorker } from "../src/worker-comunicacao/loop.js";

const GRUPO = "120363000000000001@g.us";
// 2026-10-08 é quinta; America/Sao_Paulo = UTC-3 (sem horário de verão).
const QUI_1630 = new Date("2026-10-08T19:30:00Z");
const QUI_1629 = new Date("2026-10-08T19:29:00Z");
const QUI_1700 = new Date("2026-10-08T20:00:00Z");
const QUI_2000 = new Date("2026-10-08T23:00:00Z");
const SAB_1630 = new Date("2026-10-10T19:30:00Z");
const DOM_1630 = new Date("2026-10-11T19:30:00Z");

const SNAP_PEND = {
  d1: "2026-10-07",
  organizacoesMonitoradas: ["org-a", "org-b", "org-c"],
  unidades: [
    { organizacaoId: "org-a", unidadeId: "u-1", unidadeNome: "Subway Centro", criticidade: "critico", d1Status: "nao_realizado", pendenciaMaisAntiga: "2026-10-05", diasPendentes: 3 },
    { organizacaoId: "org-b", unidadeId: "u-2", unidadeNome: "Subway Norte", criticidade: "atencao", d1Status: "nao_realizado", pendenciaMaisAntiga: "2026-10-07", diasPendentes: 0 },
    { organizacaoId: "org-c", unidadeId: "u-3", unidadeNome: "Subway Sul", criticidade: "atencao", d1Status: "em_preenchimento", pendenciaMaisAntiga: "2026-10-07", diasPendentes: 0 },
  ],
};
const SNAP_VAZIO = { d1: "2026-10-07", organizacoesMonitoradas: ["org-a", "org-b"], unidades: [] };

function fakeDb() {
  const tabelas = { comunicacao_envios_grupo: [], comunicacao_mensagens: [] };
  const escritas = [];
  let seq = 0;
  function from(nome) {
    const linhas = (tabelas[nome] ??= []);
    const filtros = [];
    let op = "select", payload = null;
    const casa = (r) => filtros.every((f) => f(r));
    const exec = (single) => {
      if (op === "insert") {
        escritas.push({ tabela: nome, op });
        const nova = { id: `env-${++seq}`, tentativas: 0, resumo: {}, criado_em: new Date().toISOString(), ...payload };
        if (nome === "comunicacao_envios_grupo" && linhas.some((r) => r.chave_idempotencia === nova.chave_idempotencia)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
        }
        linhas.push(nova);
        return Promise.resolve({ data: { ...nova }, error: null });
      }
      if (op === "update") {
        escritas.push({ tabela: nome, op });
        const alvo = linhas.filter(casa);
        alvo.forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: alvo[0] ? { ...alvo[0] } : null, error: null });
      }
      const res = linhas.filter(casa).map((r) => ({ ...r }));
      return Promise.resolve({ data: single ? (res[0] ?? null) : res, error: null });
    };
    const b = {
      select: () => b, order: () => b, limit: () => b,
      eq: (c, v) => (filtros.push((r) => r[c] === v), b),
      in: (c, vs) => (filtros.push((r) => vs.includes(r[c])), b),
      gte: (c, v) => (filtros.push((r) => r[c] != null && r[c] >= v), b),
      insert: (obj) => (op = "insert", payload = obj, b), update: (obj) => (op = "update", payload = obj, b),
      single: () => exec(true), maybeSingle: () => exec(true), then: (ok, ko) => exec(false).then(ok, ko),
    };
    return b;
  }
  return { from, tabelas, escritas };
}

function whatsFalso({ conectado = true } = {}) {
  const s = {
    envios: [], conectado,
    getStatus: async () => ({ conectado: s.conectado }),
    enviarTextoGrupoInterno: async ({ grupoJid, texto, idempotencyKey }) => {
      s.envios.push({ grupoJid, texto, idempotencyKey });
      return { providerMessageId: `wa-${s.envios.length}`, enviadoEm: new Date().toISOString(), grupo: { jid: grupoJid, nome: "Crescer Com Delivery - Central" } };
    },
    enviarTexto: async () => { throw new Error("o relatório NUNCA usa o envio individual"); },
  };
  return s;
}

const passo = (over = {}, deps) => executarPassoRelatorio({
  agora: QUI_1630, modo: MODOS_RELATORIO.ATIVO, grupoJid: GRUPO, estado: {},
  lerPendencias: async () => SNAP_PEND, lerAvisadas: async () => new Set(["u-1"]), ...over,
}, deps);

describe("horário, dias e chave", () => {
  test("16:30 de Brasília, segunda a sábado; domingo não; data LOCAL (não UTC)", () => {
    assert.equal(avaliarHorarioDoRelatorio(QUI_1629).situacao, "ANTES_DO_HORARIO");
    assert.equal(avaliarHorarioDoRelatorio(QUI_1630).situacao, "NO_HORARIO");
    assert.equal(avaliarHorarioDoRelatorio(SAB_1630).situacao, "NO_HORARIO");
    assert.equal(avaliarHorarioDoRelatorio(DOM_1630).situacao, "DOMINGO");
    assert.equal(avaliarHorarioDoRelatorio(QUI_2000).situacao, "APOS_LIMITE");
    // 22:00 de 08/10 em Brasília já é 09/10 em UTC: a chave usa 08/10.
    assert.equal(avaliarHorarioDoRelatorio(new Date("2026-10-09T01:00:00Z")).dataLocal, "2026-10-08");
  });

  test("chave = ifood_dashboard_alert:<data local>:<JID>", () => {
    assert.equal(chaveRelatorio("2026-10-08", GRUPO), `ifood_dashboard_alert:2026-10-08:${GRUPO}`);
  });

  test("modo: ausente/inválido = DESLIGADO; só ATIVO e SIMULACAO ligam", () => {
    assert.equal(modoRelatorio({}), "DESLIGADO");
    assert.equal(modoRelatorio({ IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO: "true" }), "DESLIGADO");
    assert.equal(modoRelatorio({ IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO: "simulacao" }), "SIMULACAO");
    assert.equal(modoRelatorio({ IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO: "ATIVO" }), "ATIVO");
  });
});

describe("texto do relatório", () => {
  test("com pendências: 🔴 no topo, seções separadas, data e 'loja avisada hoje' por unidade", () => {
    const { texto, resumo } = montarRelatorio({ snapshot: SNAP_PEND, avisadasHoje: new Set(["u-1"]), dataLocal: "2026-10-08", horaLocal: "16:30" });
    assert.match(texto, /^🔴 RELATÓRIO DIÁRIO — DASHBOARD iFOOD/);
    assert.match(texto, /D-1 de referência: 07\/10\/2026/);
    assert.match(texto, /🔴 1 crítica\(s\) · 🟡 2 em atenção/);
    assert.match(texto, /Lojas já avisadas hoje \(alerta individual\): 1 de 3/);
    assert.ok(texto.indexOf("🔴 CRÍTICO (1)") < texto.indexOf("🟡 ATENÇÃO (2)"));
    assert.match(texto, /• Subway Centro\n  D-1 não lançado · 3 dia\(s\) pendente\(s\) no período · pendência desde 05\/10\/2026 · loja avisada hoje: SIM/);
    assert.match(texto, /• Subway Norte\n  D-1 não lançado · pendência desde 07\/10\/2026 · loja avisada hoje: NÃO/);
    assert.match(texto, /• Subway Sul\n  D-1 em preenchimento · pendência desde 07\/10\/2026 · loja avisada hoje: NÃO/);
    assert.deepEqual([resumo.criticas, resumo.atencao, resumo.avisadas_hoje], [1, 2, 1]);
  });

  test("só atenção: cabeçalho 🟡", () => {
    const snap = { ...SNAP_PEND, unidades: SNAP_PEND.unidades.filter((u) => u.criticidade === "atencao") };
    assert.match(montarRelatorio({ snapshot: snap, avisadasHoje: new Set(), dataLocal: "2026-10-08", horaLocal: "16:30" }).texto, /^🟡 RELATÓRIO DIÁRIO/);
  });

  test("sem pendências: 🟢 TUDO CERTO deixando explícito que a consulta foi feita", () => {
    const { texto, resumo } = montarRelatorio({ snapshot: SNAP_VAZIO, avisadasHoje: new Set(), dataLocal: "2026-10-08", horaLocal: "16:30" });
    assert.match(texto, /^🟢 TUDO CERTO — DASHBOARD iFOOD/);
    assert.match(texto, /Consulta realizada às 16:30: nenhuma unidade com pendência 🔴 Crítico ou 🟡 Atenção no momento\./);
    assert.equal(resumo.situacao, "TUDO_CERTO");
  });

  test("falha ao ler os avisos individuais: 'não verificado' (nunca SIM/NÃO inventado)", () => {
    const { texto } = montarRelatorio({ snapshot: SNAP_PEND, avisadasHoje: null, dataLocal: "2026-10-08", horaLocal: "16:30" });
    assert.match(texto, /loja avisada hoje: não verificado/);
    assert.doesNotMatch(texto, /loja avisada hoje: (SIM|NÃO)/);
  });

  test("frota grande: texto nunca passa do limite do Gateway (4096) e avisa quantas ficaram de fora", () => {
    const unidades = Array.from({ length: 120 }, (_, i) => ({ unidadeId: `u-${i}`, unidadeNome: `Subway Unidade Número ${i}`, criticidade: i % 3 ? "atencao" : "critico", d1Status: "nao_realizado", pendenciaMaisAntiga: "2026-10-01", diasPendentes: 6 }));
    const { texto, resumo } = montarRelatorio({ snapshot: { d1: "2026-10-07", unidades }, avisadasHoje: new Set(), dataLocal: "2026-10-08", horaLocal: "16:30" });
    assert.ok(texto.length <= 4096, `texto com ${texto.length} caracteres`);
    assert.ok(resumo.omitidas > 0);
    assert.match(texto, new RegExp(`… e mais ${resumo.omitidas} unidade\\(s\\)`));
  });
});

describe("execução (modo ATIVO) — idempotência por data local + JID", () => {
  test("com pendências: envia UMA vez com a chave do dia e registra SENT", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const r = await passo({ whatsAppService: wa }, { supabase: db });
    assert.equal(r.acao, "ENVIADO");
    assert.equal(wa.envios.length, 1);
    assert.equal(wa.envios[0].idempotencyKey, `ifood_dashboard_alert:2026-10-08:${GRUPO}`);
    assert.equal(wa.envios[0].grupoJid, GRUPO);
    const linha = db.tabelas.comunicacao_envios_grupo[0];
    assert.equal(linha.tipo, "RELATORIO_DASHBOARD_IFOOD");
    assert.equal(linha.status, "SENT");
    assert.equal(linha.data_referencia, "2026-10-08");
    assert.equal(linha.resumo.criticas, 1);
  });

  test("sem pendências: envia o 🟢 Tudo certo (não fica silencioso)", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const r = await passo({ whatsAppService: wa, lerPendencias: async () => SNAP_VAZIO }, { supabase: db });
    assert.equal(r.acao, "ENVIADO");
    assert.match(wa.envios[0].texto, /^🟢 TUDO CERTO/);
  });

  test("segunda execução no mesmo dia: NÃO envia de novo e nem relê pendencias()", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const estado = {};
    await passo({ whatsAppService: wa, estado }, { supabase: db });
    let leituras = 0;
    const r2 = await passo({ whatsAppService: wa, estado, agora: QUI_1700, lerPendencias: async () => { leituras += 1; return SNAP_PEND; } }, { supabase: db });
    assert.equal(r2.acao, "JA_EXISTIA");
    assert.equal(wa.envios.length, 1);
    assert.equal(leituras, 0);
    assert.equal(db.tabelas.comunicacao_envios_grupo.length, 1);
  });

  test("após reinício do worker (memória do processo zerada): o banco impede o 2º envio", async () => {
    const db = fakeDb(), wa1 = whatsFalso();
    await passo({ whatsAppService: wa1, estado: {} }, { supabase: db });
    const wa2 = whatsFalso(); // processo novo: estado e serviço novos, MESMO banco
    const r = await passo({ whatsAppService: wa2, estado: {}, agora: QUI_1700 }, { supabase: db });
    assert.equal(r.acao, "JA_EXISTIA");
    assert.equal(wa1.envios.length + wa2.envios.length, 1);
  });

  test("duas instâncias ao mesmo tempo: só a que vence a UNIQUE envia", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const rs = await Promise.all([passo({ whatsAppService: wa, estado: {} }, { supabase: db }), passo({ whatsAppService: wa, estado: {} }, { supabase: db })]);
    assert.equal(wa.envios.length, 1);
    assert.deepEqual(rs.map((r) => r.acao).sort(), ["ENVIADO", "JA_EXISTIA"]);
  });

  test("dia seguinte: chave nova, envia de novo (uma vez)", async () => {
    const db = fakeDb(), wa = whatsFalso();
    await passo({ whatsAppService: wa }, { supabase: db });
    await passo({ whatsAppService: wa, agora: new Date("2026-10-09T19:31:00Z") }, { supabase: db });
    assert.equal(wa.envios.length, 2);
    assert.notEqual(wa.envios[0].idempotencyKey, wa.envios[1].idempotencyKey);
  });

  test("domingo e antes das 16:30: nada é lido, reservado ou enviado", async () => {
    for (const agora of [DOM_1630, QUI_1629]) {
      const db = fakeDb(), wa = whatsFalso();
      let leituras = 0;
      const r = await passo({ whatsAppService: wa, agora, lerPendencias: async () => { leituras += 1; return SNAP_PEND; } }, { supabase: db });
      assert.ok(["DOMINGO", "ANTES_DO_HORARIO"].includes(r.acao));
      assert.equal(wa.envios.length + leituras + db.escritas.length, 0);
    }
  });

  test("Gateway desconectado: não reserva (tenta no próximo tick); depois do limite registra FAILED whatsapp_gateway_unavailable sem enviar", async () => {
    const db = fakeDb(), wa = whatsFalso({ conectado: false });
    const estado = {};
    const r1 = await passo({ whatsAppService: wa, estado }, { supabase: db });
    assert.equal(r1.acao, "AGUARDANDO_GATEWAY");
    assert.equal(db.tabelas.comunicacao_envios_grupo.length, 0);
    const r2 = await passo({ whatsAppService: wa, estado, agora: QUI_2000 }, { supabase: db });
    assert.equal(r2.acao, "NAO_ENVIADO");
    assert.equal(r2.motivo, "whatsapp_gateway_unavailable");
    const linha = db.tabelas.comunicacao_envios_grupo[0];
    assert.equal(linha.status, "FAILED");
    assert.equal(wa.envios.length, 0);
    // e não tenta mais naquele dia
    assert.equal((await passo({ whatsAppService: whatsFalso(), estado, agora: QUI_2000 }, { supabase: db })).acao, "JA_EXISTIA");
  });

  test("Gateway volta antes do limite: envia normalmente", async () => {
    const db = fakeDb(), wa = whatsFalso({ conectado: false });
    const estado = {};
    await passo({ whatsAppService: wa, estado }, { supabase: db });
    wa.conectado = true;
    assert.equal((await passo({ whatsAppService: wa, estado, agora: QUI_1700 }, { supabase: db })).acao, "ENVIADO");
    assert.equal(wa.envios.length, 1);
  });

  test("falha ao ler pendencias(): devolve ERRO sem lançar e sem reservar", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const r = await passo({ whatsAppService: wa, lerPendencias: async () => { throw new Error("banco fora"); } }, { supabase: db });
    assert.equal(r.acao, "ERRO");
    assert.equal(db.tabelas.comunicacao_envios_grupo.length + wa.envios.length, 0);
  });

  test("grupo não configurado: nada é enviado", async () => {
    const wa = whatsFalso();
    const r = await passo({ whatsAppService: wa, grupoJid: null }, { supabase: fakeDb() });
    assert.equal(r.acao, "GRUPO_NAO_CONFIGURADO");
    assert.equal(wa.envios.length, 0);
  });
});

describe("modo seguro", () => {
  test("DESLIGADO: nada acontece", async () => {
    const db = fakeDb(), wa = whatsFalso();
    assert.equal((await passo({ whatsAppService: wa, modo: "DESLIGADO" }, { supabase: db })).acao, "DESLIGADO");
    assert.equal(wa.envios.length + db.escritas.length, 0);
  });

  test("SIMULACAO: monta o relatório uma vez por dia, sem reservar nem enviar", async () => {
    const db = fakeDb(), wa = whatsFalso();
    const estado = {};
    const r = await passo({ whatsAppService: wa, modo: MODOS_RELATORIO.SIMULACAO, estado }, { supabase: db });
    assert.equal(r.acao, "SIMULADO");
    assert.match(r.texto, /^🔴 RELATÓRIO DIÁRIO/);
    assert.equal((await passo({ whatsAppService: wa, modo: MODOS_RELATORIO.SIMULACAO, estado, agora: QUI_1700 }, { supabase: db })).acao, "SIMULACAO_JA_FEITA");
    assert.equal(wa.envios.length + db.escritas.length, 0);
  });
});

describe("independência do dashboard_ifood_d1", () => {
  test("'loja avisada hoje' = só SELECT em comunicacao_mensagens (tipo dashboard_ifood_d1, saiu hoje em Brasília)", async () => {
    const db = fakeDb();
    db.tabelas.comunicacao_mensagens.push(
      { unidade_id: "u-1", tipo: "dashboard_ifood_d1", status: "DELIVERED", enviado_em: "2026-10-08T14:00:00.000Z" },
      { unidade_id: "u-2", tipo: "dashboard_ifood_d1", status: "CANCELLED", enviado_em: null },
      { unidade_id: "u-3", tipo: "dashboard_ifood_d1", status: "SENT", enviado_em: "2026-10-08T02:00:00.000Z" }, // 07/10 23:00 em Brasília
      { unidade_id: "u-4", tipo: "outro_tipo", status: "SENT", enviado_em: "2026-10-08T14:00:00.000Z" },
    );
    const s = await unidadesAvisadasHoje({ agora: QUI_1630 }, { supabase: db });
    assert.deepEqual([...s], ["u-1"]);
    assert.equal(db.escritas.length, 0);
  });

  test("o envio do relatório nunca escreve em comunicacao_mensagens nem em comunicacao_alertas", async () => {
    const db = fakeDb(), wa = whatsFalso();
    await passo({ whatsAppService: wa, lerAvisadas: (p) => unidadesAvisadasHoje(p, { supabase: db }) }, { supabase: db });
    assert.ok(db.escritas.every((e) => e.tabela === "comunicacao_envios_grupo"), JSON.stringify(db.escritas));
  });

  test("código: o módulo do relatório não importa o pipeline individual nem escreve nas tabelas dele", () => {
    const raiz = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(raiz, "../src/modules/comunicacao/relatorioDashboardGrupo.js"), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*comunicacao\.alertas\.service/);
    assert.doesNotMatch(src, /from\s+["'][^"']*comunicacao\.fila\.repo/);
    assert.doesNotMatch(src, /from\(["']comunicacao_alertas["']\)/);
    assert.doesNotMatch(src, /from\("comunicacao_mensagens"\)[^;]*\.(insert|update|delete|upsert)\(/s);
  });
});

describe("laço do worker: os dois fluxos não se derrubam", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test("ciclo individual falhando: o passo do relatório continua rodando", async () => {
    let relatorios = 0;
    const loop = criarLoopWorker({
      executarCiclo: async () => { throw new Error("ciclo quebrou"); }, modoAtual: async () => "NORMAL", whatsAppService: {}, intervalMs: 10,
      executarRelatorio: async () => { relatorios += 1; return { acao: "JA_EXISTIA" }; },
    });
    loop.iniciar(); await sleep(60); await loop.encerrar("TESTE");
    assert.ok(relatorios >= 2);
  });

  test("relatório lançando: o ciclo individual continua rodando a cada tick", async () => {
    let ciclos = 0;
    const loop = criarLoopWorker({
      executarCiclo: async () => { ciclos += 1; return { lote: [] }; }, modoAtual: async () => "NORMAL", whatsAppService: {}, intervalMs: 10,
      executarRelatorio: async () => { throw new Error("relatório quebrou"); },
    });
    loop.iniciar(); await sleep(60); await loop.encerrar("TESTE");
    assert.ok(ciclos >= 2);
    assert.equal(loop.obterEstado().lastCycleStatus, "completed");
  });

  test("kill switch (modo != NORMAL): nem o ciclo nem o relatório rodam", async () => {
    let chamadas = 0;
    const loop = criarLoopWorker({
      executarCiclo: async () => { chamadas += 1; }, modoAtual: async () => "DISABLED", whatsAppService: {}, intervalMs: 10,
      executarRelatorio: async () => { chamadas += 1; },
    });
    loop.iniciar(); await sleep(40); await loop.encerrar("TESTE");
    assert.equal(chamadas, 0);
  });
});
