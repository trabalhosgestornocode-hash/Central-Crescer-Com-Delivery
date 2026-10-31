// D-1 — adiamento além do VENCIMENTO (expira_em). Função PURA, relógio fixo, sem banco: reproduz o caso real de sábado 31/10/2026
// (4 mensagens barradas por RATE_LIMIT_DIA foram reagendadas para segunda 02/11, mas venciam em 01/11 → viravam EXPIRADA sem nunca sair).
// A correção NÃO muda a política de envio (cotas, janelas, cooldown, destinatários): só encerra, no ato, a mensagem que de qualquer forma
// seria cancelada (o worker e o banco cancelam toda mensagem vencida), em vez de deixá-la "agendada" para um dia em que já estará vencida.
// Rodar: node --test test/comunicacao-adiamento-vencimento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calcularDisponivelEm, chaveDeJitter, decidirDestinoDoAdiamento, DESTINO_DO_ADIAMENTO as D } from "../src/modules/comunicacao/comunicacao.adiamento.js";
import { MOTIVOS_BLOQUEIO } from "../src/modules/comunicacao/comunicacao.constants.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN = 60_000, H = 3_600_000;
const JANELAS = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };
const FORTALEZA = "America/Fortaleza";   // UTC-3 sem DST (mesmo deslocamento de São Paulo hoje)
const z = (iso) => new Date(iso);
const chave = (n = "a") => chaveDeJitter({ idempotencyKey: `wa:alerta:${n}:v1`, dataLogica: "2026-10-30", organizacaoId: "org-1" });
const adiar = (over) => calcularDisponivelEm({ adiamentoMs: 15 * MIN, timezone: FORTALEZA, janelas: JANELAS, chave: chave(), ...over });

describe("decidirDestinoDoAdiamento (tabela de decisão)", () => {
  const t = (p) => decidirDestinoDoAdiamento(p);
  test("bloqueio PERMANENTE nunca é adiado nem expirado: BLOQUEAR", () => {
    assert.equal(t({ transitorio: false, disponivelEm: null, expiraEm: z("2026-11-01T00:00:00Z") }), D.BLOQUEAR);
  });
  test("D-1 normal: próximo instante ANTES do vencimento → ADIAR; no vencimento exato ou depois → EXPIRAR", () => {
    const exp = z("2026-11-01T14:44:00Z");
    assert.equal(t({ transitorio: true, disponivelEm: new Date(exp.getTime() - 1), expiraEm: exp }), D.ADIAR);
    assert.equal(t({ transitorio: true, disponivelEm: new Date(exp.getTime()), expiraEm: exp }), D.EXPIRAR, "fronteira: >= vence");
    assert.equal(t({ transitorio: true, disponivelEm: new Date(exp.getTime() + 24 * H), expiraEm: exp }), D.EXPIRAR);
  });
  test("sem expira_em (mensagem sem prazo) → ADIAR como antes; expira_em string ISO também vale", () => {
    assert.equal(t({ transitorio: true, disponivelEm: z("2026-11-02T14:44:00Z"), expiraEm: null }), D.ADIAR);
    assert.equal(t({ transitorio: true, disponivelEm: z("2026-11-02T14:44:00Z"), expiraEm: "2026-11-01T14:44:00Z" }), D.EXPIRAR);
  });
  test("reforço/tardio mantém a regra anterior: sem próximo instante também EXPIRA; dentro do cutoff ADIA", () => {
    assert.equal(t({ transitorio: true, disponivelEm: null, expiraEm: z("2026-10-31T01:30:00Z"), reforcoOuTardio: true }), D.EXPIRAR);
    assert.equal(t({ transitorio: true, disponivelEm: z("2026-10-31T00:10:00Z"), expiraEm: z("2026-10-31T01:30:00Z"), reforcoOuTardio: true }), D.ADIAR);
    assert.equal(t({ transitorio: true, disponivelEm: z("2026-10-31T01:30:00Z"), expiraEm: z("2026-10-31T01:30:00Z"), reforcoOuTardio: true }), D.EXPIRAR);
  });
});

describe("caso real de sábado 31/10/2026 (RATE_LIMIT_DIA às 11:44 locais, vencimento em 24 h)", () => {
  const AGORA = z("2026-10-31T14:44:00Z");              // sábado 11:44 locais
  const EXPIRA = z("2026-11-01T14:44:00Z");             // criada com ttl de 24 h → vence no domingo 11:44
  test("RATE_LIMIT por DIA cai na próxima janela (segunda) e passa do vencimento → EXPIRAR (antes: ficava 'agendada' até expirar)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: AGORA });
    assert.ok(r.getTime() >= z("2026-11-02T11:00:00Z").getTime() && r.getTime() < z("2026-11-02T22:00:00Z").getTime(), `segunda 02/11 (janela), obtido ${r.toISOString()}`);
    assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: EXPIRA }), D.EXPIRAR);
  });
  test("RATE_LIMIT por MINUTO (+2 min) continua ADIANDO normalmente", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: false, agora: AGORA });
    assert.equal(r.getTime() - AGORA.getTime(), 2 * MIN);
    assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: EXPIRA }), D.ADIAR);
  });
  test("fora da janela na sexta 18:30 com vencimento sábado 12:00 → ADIAR (sábado abre 08:00); vencimento sábado 06:00 → EXPIRAR", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-10-30T21:30:00Z") });
    assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: z("2026-10-31T15:00:00Z") }), D.ADIAR);
    assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: z("2026-10-31T09:00:00Z") }), D.EXPIRAR);
  });
  test("IDEMPOTENTE: reavaliar a mesma mensagem (mesma chave) mais tarde dá o MESMO instante e a MESMA decisão", () => {
    const base = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: AGORA });
    for (let i = 1; i <= 50; i++) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: new Date(AGORA.getTime() + i * MIN) });
      assert.equal(r.getTime(), base.getTime());
      assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: EXPIRA }), D.EXPIRAR);
    }
  });
  test("mensagens de empresas diferentes no MESMO telefone: cada uma decide pela PRÓPRIA chave/vencimento (sem dependência entre elas)", () => {
    const chaves = ["org-A", "org-B", "org-C", "org-D"].map((o) => chaveDeJitter({ idempotencyKey: `wa:alerta:${o}:v1`, dataLogica: "2026-10-30", organizacaoId: o }));
    const instantes = chaves.map((c) => calcularDisponivelEm({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: AGORA, adiamentoMs: 15 * MIN, timezone: FORTALEZA, janelas: JANELAS, chave: c }));
    for (const r of instantes) assert.equal(decidirDestinoDoAdiamento({ transitorio: true, disponivelEm: r, expiraEm: EXPIRA }), D.EXPIRAR);
    assert.ok(new Set(instantes.map((r) => r.getTime())).size > 1, "o jitter por chave distribui os instantes (não é um valor único)");
  });
});

describe("integração estática: o serviço usa a decisão e preserva o resultado do reforço", () => {
  const src = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.alertas.service.js"), "utf8");
  test("usa decidirDestinoDoAdiamento; encerra como CANCELLED/EXPIRADA sem novo horário; audita o motivo original", () => {
    assert.match(src, /decidirDestinoDoAdiamento\(\{ transitorio, disponivelEm, expiraEm: job\.expira_em, reforcoOuTardio: ehReforco \|\| ehTardio \}\)/);
    assert.match(src, /motivo: expiraReforco \? MOTIVO_EXPIRADA : motivo, disponivelEm: expiraReforco \? null : disponivelEm/);
    assert.match(src, /expirouNoAdiamento: true/);
    assert.match(src, /"CANCELADO_REFORCO_EXPIRADO" : "CANCELADO_EXPIRADO_NO_ADIAMENTO"/);
  });
  test("não alterou cotas, cooldown, janelas nem a reserva: nenhuma migration nesta correção", () => {
    assert.doesNotMatch(src, /max_por_contato_dia\s*=\s*\d/);
  });
});
