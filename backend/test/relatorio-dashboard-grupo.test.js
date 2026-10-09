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
  avaliarHorarioDoRelatorio, chaveRelatorio, montarRelatorio, nomesDeExibicao, executarPassoRelatorio, unidadesAvisadasHoje, MODOS_RELATORIO,
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

describe("boletim de pendências — formato", () => {
  const gerar = (snapshot, avisadas, extra = {}) => montarRelatorio({ snapshot, avisadasHoje: avisadas, dataLocal: "2026-10-08", horaLocal: "16:30", ...extra });
  const u = (id, criticidade, over = {}) => ({ organizacaoId: `org-${id}`, unidadeId: id, unidadeNome: `Loja ${id}`, criticidade, d1Status: "nao_realizado", pendenciaMaisAntiga: "2026-10-07", diasPendentes: 0, ...over });

  test("estrutura completa: cabeçalho institucional, panorama, prioridade máxima, pendências D-1, orientação e rodapé", () => {
    const { texto } = gerar(SNAP_PEND, new Set(["u-1"]));
    assert.ok(texto.startsWith("📊 *CENTRAL CRESCER COM DELIVERY*\n*BOLETIM DE PENDÊNCIAS | iFood*\n\n📅 Quinta-feira, 08/10/2026\n🕔 Atualizado às 16:30\n📆 Lançamentos referentes a 07/10\n"));
    assert.match(texto, /📍 \*PANORAMA GERAL\*\n━+\n\n\*3 unidades com pendências\*\n\n🔴 01 em situação crítica\n🟡 02 exigem atenção\n\n📨 \*1 de 3\* unidades já receberam alerta individual hoje\./);
    assert.match(texto, /🚨 \*PRIORIDADE MÁXIMA\*\n━+\n\n🔴 \*Subway Centro\*\n   3 dias pendentes \(desde 05\/10\)\n   D-1 não lançado\n   Avisada hoje: SIM/);
    assert.match(texto, /🟡 \*PENDÊNCIAS D-1\*\n━+\n\n\*SEM ALERTA HOJE \(2\)\*\n\n○ Subway Norte\n○ Subway Sul/);
    assert.match(texto, /📌 \*ORIENTAÇÃO OPERACIONAL\*\n━+\n\nPriorizar a análise das unidades críticas e acompanhar a regularização das pendências D-1\.\n\nA indicação de alerta considera apenas os envios realizados hoje\.\n\n🔎 Consulte o Painel Administrativo para informações detalhadas\./);
    assert.ok(texto.endsWith("\n\n_Central Crescer com Delivery_\n_Monitoramento automático · iFood_"));
    assert.ok(texto.indexOf("PRIORIDADE MÁXIMA") < texto.indexOf("PENDÊNCIAS D-1"));
  });

  test("contagens: total = críticas + atenção; avisadas (geral) = críticas avisadas + atenção com alerta; subtotais só de atenção; cada unidade UMA vez", () => {
    const unidades = Array.from({ length: 23 }, (_, i) => u(`x${i}`, i % 5 === 0 ? "critico" : "atencao"));
    const avisadas = new Set(unidades.filter((_, i) => i % 2 === 0).map((x) => x.unidadeId));
    const { texto, resumo } = gerar({ d1: "2026-10-07", unidades }, avisadas);
    const crit = unidades.filter((x) => x.criticidade === "critico"), aten = unidades.filter((x) => x.criticidade === "atencao");
    assert.equal(resumo.total, crit.length + aten.length);
    assert.equal(resumo.avisadas_hoje, unidades.filter((x) => avisadas.has(x.unidadeId)).length);
    assert.equal(resumo.avisadas_hoje, resumo.criticas_avisadas + resumo.atencao_com_alerta);
    assert.equal(resumo.atencao_com_alerta + resumo.atencao_sem_alerta, aten.length);
    assert.match(texto, new RegExp(`\\*${resumo.avisadas_hoje} de ${resumo.total}\\* unidades`));
    assert.match(texto, new RegExp(`\\*ALERTA ENVIADO HOJE \\(${resumo.atencao_com_alerta}\\)\\*`));
    assert.match(texto, new RegExp(`\\*SEM ALERTA HOJE \\(${resumo.atencao_sem_alerta}\\)\\*`));
    for (const x of unidades) {
      const ocorrencias = texto.split("\n").filter((l) => l === `🔴 *${x.unidadeNome}*` || l === `✓ ${x.unidadeNome}` || l === `○ ${x.unidadeNome}`);
      assert.equal(ocorrencias.length, 1, `${x.unidadeNome} deveria aparecer exatamente 1 vez`);
      const esperado = x.criticidade === "critico" ? `🔴 *${x.unidadeNome}*` : `${avisadas.has(x.unidadeId) ? "✓" : "○"} ${x.unidadeNome}`;
      assert.equal(ocorrencias[0], esperado);
    }
  });

  test("sem críticas: nenhuma seção de prioridade máxima vazia", () => {
    const { texto } = gerar({ d1: "2026-10-07", unidades: [u("a", "atencao")] }, new Set());
    assert.doesNotMatch(texto, /PRIORIDADE MÁXIMA/);
    assert.match(texto, /🔴 00 em situação crítica/);
    assert.match(texto, /\nAcompanhar a regularização das pendências D-1\./);
  });

  test("sem atenção: nenhuma lista de pendências D-1 vazia", () => {
    const { texto } = gerar({ d1: "2026-10-07", unidades: [u("a", "critico", { diasPendentes: 2 })] }, new Set());
    assert.doesNotMatch(texto, /PENDÊNCIAS D-1|ALERTA ENVIADO HOJE|SEM ALERTA HOJE/);
    assert.match(texto, /\nPriorizar a análise das unidades críticas\.\n/);
  });

  test("todas avisadas hoje: só 'ALERTA ENVIADO HOJE'; nenhuma avisada: só 'SEM ALERTA HOJE'", () => {
    const unidades = [u("a", "atencao"), u("b", "atencao"), u("c", "critico", { diasPendentes: 1 })];
    const todas = gerar({ d1: "2026-10-07", unidades }, new Set(["a", "b", "c"])).texto;
    assert.match(todas, /\*ALERTA ENVIADO HOJE \(2\)\*/);
    assert.doesNotMatch(todas, /SEM ALERTA HOJE/);
    assert.match(todas, /📨 \*3 de 3\* unidades/);
    assert.match(todas, /\n   1 dia pendente \(desde 07\/10\)\n/);
    const nenhuma = gerar({ d1: "2026-10-07", unidades }, new Set()).texto;
    assert.match(nenhuma, /\*SEM ALERTA HOJE \(2\)\*/);
    assert.doesNotMatch(nenhuma, /ALERTA ENVIADO HOJE/);
    assert.match(nenhuma, /📨 \*0 de 3\* unidades/);
  });

  test("motivo crítico: sequência bloqueada (rótulo do D-1 ou indicador) e pendência herdada", () => {
    const unidades = [
      u("s", "critico", { unidadeNome: "Loja Sequencia", d1Status: "sequencia_bloqueada", diasPendentes: 6, pendenciaMaisAntiga: "2026-10-01", pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-09-16" }),
      u("f", "critico", { unidadeNome: "Loja Flag", d1Status: "nao_realizado", sequenciaBloqueada: true, diasPendentes: 2, pendenciaMaisAntiga: "2026-10-05" }),
      u("h", "atencao", { unidadeNome: "Loja Herdada", pendenciaMaisAntiga: "2026-10-01", pendenciaHerdada: true }),
    ];
    const { texto } = gerar({ d1: "2026-10-07", unidades }, new Set());
    assert.match(texto, /🔴 \*Loja Sequencia\*\n   6 dias pendentes \(desde 01\/10\)\n   Sequência de lançamentos bloqueada\n   Pendência herdada desde 16\/09\/2026\n   Avisada hoje: NÃO/);
    assert.match(texto, /🔴 \*Loja Flag\*\n   2 dias pendentes \(desde 05\/10\)\n   D-1 não lançado\n   Sequência de lançamentos bloqueada\n   Avisada hoje: NÃO/);
    assert.match(texto, /○ Loja Herdada _\(desde 01\/10, herdada\)_/);
  });

  test("singular: 1 unidade", () => {
    const { texto } = gerar({ d1: "2026-10-07", unidades: [u("a", "atencao")] }, new Set(["a"]));
    assert.match(texto, /\*1 unidade com pendência\*/);
    assert.match(texto, /🟡 01 exige atenção/);
    assert.match(texto, /📨 \*1 de 1\* unidade já recebeu alerta individual hoje\./);
  });

  test("avisos individuais não verificados: nunca SIM/NÃO inventado nem listas por alerta", () => {
    const { texto, resumo } = gerar(SNAP_PEND, null);
    assert.match(texto, /📨 Alerta individual de hoje: _não verificado_\./);
    assert.match(texto, /Avisada hoje: não verificado/);
    assert.match(texto, /\*UNIDADES EM ATENÇÃO \(2\)\*\n\n• Subway Norte\n• Subway Sul/);
    assert.doesNotMatch(texto, /Avisada hoje: (SIM|NÃO)|ALERTA ENVIADO HOJE|SEM ALERTA HOJE/);
    assert.equal(resumo.avisadas_hoje, null);
  });

  test("sem pendências: 🟢 TUDO CERTO com a mesma identidade visual e a consulta explícita", () => {
    const { texto, resumo } = gerar(SNAP_VAZIO, new Set());
    assert.ok(texto.startsWith("📊 *CENTRAL CRESCER COM DELIVERY*\n*BOLETIM DE PENDÊNCIAS | iFood*"));
    assert.match(texto, /🟢 \*TUDO CERTO\*\n━+\n\nConsulta realizada às 16:30: nenhuma unidade com pendência 🔴 crítica ou 🟡 em atenção no momento\.\n\n🏢 2 empresas monitoradas/);
    assert.doesNotMatch(texto, /PANORAMA|PRIORIDADE|PENDÊNCIAS D-1/);
    assert.equal(resumo.situacao, "TUDO_CERTO");
  });

  test("nomes: tira 'Matriz', abrevia 'Avenida', remove UF final — e volta ao oficial se a simplificação gerar nomes iguais", () => {
    const nomes = nomesDeExibicao([
      { unidadeId: "1", unidadeNome: "Matriz  Subway Avenida Piracicaba Limeira SP" },
      { unidadeId: "2", unidadeNome: "Matriz Subway Centro - Mogi Mirim - SP" },
      { unidadeId: "3", unidadeNome: "Subway Saci — Matriz" },
      { unidadeId: "4", unidadeNome: "Matriz Subway Shopping" },
      { unidadeId: "5", unidadeNome: "Subway Shopping" },
    ]);
    assert.equal(nomes.get("1"), "Subway Av. Piracicaba Limeira");
    assert.equal(nomes.get("2"), "Subway Centro — Mogi Mirim");
    assert.equal(nomes.get("3"), "Subway Saci — Matriz");
    assert.equal(nomes.get("4"), "Matriz Subway Shopping");
    assert.equal(nomes.get("5"), "Subway Shopping");
  });

  test("texto puro de WhatsApp: sem HTML, entidades ou escapes literais; quebras de linha reais", () => {
    const casos = [gerar(SNAP_PEND, new Set(["u-1"])), gerar(SNAP_PEND, null), gerar(SNAP_VAZIO, new Set()),
      gerar({ d1: "2026-10-07", unidades: [u("a", "atencao", { unidadeNome: "Loja <b>&amp; Cia</b>" })] }, new Set())];
    for (const { texto } of casos.slice(0, 3)) {
      assert.doesNotMatch(texto, /&#|&[a-z]+;|<\/?[a-z]|\\n|\\u|\\"/i);
      assert.ok(texto.includes("\n"));
      assert.doesNotMatch(texto, /\r/);
    }
    // nome vindo do banco é exibido como está (texto puro; o WhatsApp não interpreta HTML) — nada é "escapado" para entidade
    assert.match(casos[3].texto, /○ Loja <b>&amp; Cia<\/b>/);
  });

  test("frota grande: nunca passa do limite do transporte (4096) e nunca omite em silêncio — críticas têm prioridade", () => {
    const unidades = [
      ...Array.from({ length: 10 }, (_, i) => u(`c${i}`, "critico", { unidadeNome: `Subway Unidade Crítica Número ${i}`, diasPendentes: 6 })),
      ...Array.from({ length: 200 }, (_, i) => u(`a${i}`, "atencao", { unidadeNome: `Subway Unidade em Atenção Número ${i}` })),
    ];
    const { texto, resumo } = gerar({ d1: "2026-10-07", unidades }, new Set());
    assert.ok(texto.length <= 4096, `texto com ${texto.length} caracteres`);
    assert.equal(resumo.omitidas_criticas, 0);
    for (let i = 0; i < 10; i += 1) assert.match(texto, new RegExp(`Subway Unidade Crítica Número ${i}\\*`));
    assert.ok(resumo.omitidas > 0);
    assert.match(texto, new RegExp(`… e mais ${resumo.omitidas} unidades em atenção — lista completa no Painel Administrativo\\.`));
    assert.match(texto, /\*200 unidades|\*210 unidades/);
  });

  test("críticas demais para caber: encurta também as críticas, com aviso explícito", () => {
    const unidades = Array.from({ length: 150 }, (_, i) => u(`c${i}`, "critico", { unidadeNome: `Subway Unidade Crítica Número ${i}`, diasPendentes: 6 }));
    const { texto, resumo } = gerar({ d1: "2026-10-07", unidades }, new Set());
    assert.ok(texto.length <= 4096, `texto com ${texto.length} caracteres`);
    assert.ok(resumo.omitidas_criticas > 0);
    assert.match(texto, new RegExp(`… e mais ${resumo.omitidas_criticas} unidades críticas — lista completa no Painel Administrativo\\.`));
    assert.match(texto, /\*150 unidades com pendências\*/);
  });

  test("nenhum dado do exemplo está fixo no código", () => {
    const raiz = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(raiz, "../src/modules/comunicacao/relatorioDashboardGrupo.js"), "utf8");
    for (const fixo of ["Stellato", "Caramelle", "Piracicaba", "Limeira", "08/10", "07/10", "17:02", "22 unidades", "13 de 22", "Quinta-feira, "]) {
      assert.ok(!src.includes(fixo), `"${fixo}" não pode estar no código`);
    }
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
    assert.match(wa.envios[0].texto, /🟢 \*TUDO CERTO\*/);
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
    assert.match(r.texto, /BOLETIM DE PENDÊNCIAS/);
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
