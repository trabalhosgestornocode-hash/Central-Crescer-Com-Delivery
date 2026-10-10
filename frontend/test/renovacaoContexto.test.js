// Renovador automático do contexto (perfil de exibição): agenda, adota sem fechar nada, tenta de novo na falha de rede
// e PARA nos 401/403/409. Relógio e timers são injetados: um expediente de 17 h roda em milissegundos.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarRenovador, planejarRenovacao, esperaDaTentativa, ANTECEDENCIA_MS, MINIMO_ENTRE_PEDIDOS_MS } from "../src/renovacaoContexto.js";

const H = 3_600_000; const MIN = 60_000;
const EXIB = (extra = {}) => ({ papel: "display_operator", permissoes: ["checklist.visualizar"], expiraEm: null, relogioOffsetMs: 0, ...extra });

/** Relógio/timers falsos: `avancar(ms)` dispara os timers vencidos em ordem, esperando as promessas assentarem. */
function mundo() {
  let t = Date.UTC(2026, 9, 10, 6, 0, 0); let seq = 0; const timers = new Map();
  return {
    agora: () => t,
    setT: (fn, ms) => { const id = ++seq; timers.set(id, { em: t + ms, fn }); return id; },
    clearT: (id) => timers.delete(id),
    pendentes: () => timers.size,
    async avancar(ms) {
      const alvo = t + ms;
      for (;;) {
        const prox = [...timers.entries()].filter(([, v]) => v.em <= alvo).sort((a, b) => a[1].em - b[1].em)[0];
        if (!prox) break;
        t = Math.max(t, prox[1].em); timers.delete(prox[0]); prox[1].fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      t = alvo;
    },
  };
}

describe("planejarRenovacao / esperas", () => {
  test("espera até (vencimento − antecedência − espalhamento), no relógio do SERVIDOR; nunca negativo; sem prazo = null", () => {
    const exp = 1_000_000_000;
    assert.equal(planejarRenovacao({ expiraEmMs: exp, agoraLocalMs: exp - 8 * H }), 8 * H - ANTECEDENCIA_MS);
    assert.equal(planejarRenovacao({ expiraEmMs: exp, agoraLocalMs: exp - 8 * H, offsetMs: 10 * MIN }), 8 * H - ANTECEDENCIA_MS - 10 * MIN, "aparelho 10 min atrasado");
    assert.equal(planejarRenovacao({ expiraEmMs: exp, agoraLocalMs: exp - 8 * H, espalhamentoMs: 4 * MIN }), 8 * H - ANTECEDENCIA_MS - 4 * MIN);
    assert.equal(planejarRenovacao({ expiraEmMs: exp, agoraLocalMs: exp - 10 * MIN }), 0);
    assert.equal(planejarRenovacao({ expiraEmMs: NaN, agoraLocalMs: 0 }), null);
  });
  test("esperas crescem e o último valor se repete", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(esperaDaTentativa), [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
  });
});

describe("criarRenovador — jornada e falhas", () => {
  function montar({ falhaNaRede = () => false, resposta, perfil = EXIB } = {}) {
    const m = mundo(); const sessao = perfil({ expiraEm: new Date(m.agora() + 8 * H).toISOString() });
    const pedidos = []; const tokens = [];
    const r = criarRenovador({
      sessao: () => sessao, agora: m.agora, setT: m.setT, clearT: m.clearT, aleatorio: () => 0,
      renovar: async () => {
        pedidos.push(m.agora());
        if (falhaNaRede(pedidos.length)) throw Object.assign(new Error("rede"), { status: undefined });
        if (resposta) return resposta(m, sessao, pedidos.length);
        return { renovado: true, contextToken: `t${pedidos.length}`, expiraEm: new Date(m.agora() + 8 * H).toISOString(), servidorEm: new Date(m.agora()).toISOString() };
      },
      aplicar: (d) => { tokens.push(d.contextToken); sessao.expiraEm = d.expiraEm; },
    });
    return { m, r, sessao, pedidos, tokens };
  }

  test("17 h: renova ~1 h antes de cada vencimento (aos ~7 h e ~14 h), sem pedido nenhum fora disso", async () => {
    const { m, r, pedidos, tokens } = montar();
    const t0 = m.agora(); r.iniciar();
    await m.avancar(17 * H);
    assert.equal(pedidos.length, 2, "duas renovações em 17 h");
    assert.deepEqual(pedidos.map((p) => (p - t0) / H), [7, 14]);
    assert.deepEqual(tokens, ["t1", "t2"]); assert.deepEqual(r.contagem, { pedidos: 2, renovacoes: 2, cedo: 0, falhas: 0 });
  });

  test("não renova se NÃO for perfil de exibição (gestor/admin): nada agendado", async () => {
    const { m, r, pedidos } = montar({ perfil: (e) => ({ papel: "unit_manager", permissoes: ["dashboard.ver"], ...e }) });
    r.iniciar(); await m.avancar(10 * H);
    assert.equal(pedidos.length, 0); assert.equal(m.pendentes(), 0);
  });

  test("falha de REDE na renovação: tenta de novo com espera crescente e acaba renovando", async () => {
    const { m, r, pedidos, tokens } = montar({ falhaNaRede: (n) => n <= 3 });
    const t0 = m.agora(); r.iniciar(); await m.avancar(7 * H + 10 * MIN);
    assert.equal(pedidos.length, 4);
    assert.deepEqual(pedidos.slice(1).map((p, i) => p - pedidos[i]), [30_000, 60_000, 120_000]);
    assert.deepEqual(tokens, ["t4"]); assert.ok(pedidos[0] - t0 === 7 * H);
    assert.equal(r.falhas, 0, "sucesso zera as falhas");
  });

  test("rede fora até o vencimento: PARA de tentar (fluxo normal da Central assume), sem laço", async () => {
    const { m, r, pedidos } = montar({ falhaNaRede: () => true });
    r.iniciar(); await m.avancar(9 * H);
    assert.ok(pedidos.length >= 5 && pedidos.length <= 20, `tentativas limitadas: ${pedidos.length}`);
    assert.equal(r.ativo, false); assert.equal(m.pendentes(), 0);
  });

  for (const status of [401, 403, 409]) {
    test(`resposta ${status}: PARA de agendar e não repete`, async () => {
      const { m, r, pedidos } = montar({ resposta: () => { throw Object.assign(new Error("x"), { status }); } });
      r.iniciar(); await m.avancar(12 * H);
      assert.equal(pedidos.length, 1); assert.equal(r.ativo, false); assert.equal(m.pendentes(), 0);
    });
  }

  test("'cedo' (renovado:false): guarda o relógio do servidor e só volta a pedir depois do mínimo", async () => {
    const { m, r, pedidos, sessao } = montar({ resposta: (mm, s, n) => n === 1
      ? { renovado: false, expiraEm: s.expiraEm, servidorEm: new Date(mm.agora() + 30 * MIN).toISOString() }
      : { renovado: true, contextToken: "ok", expiraEm: new Date(mm.agora() + 8 * H).toISOString() } });
    r.iniciar(); await m.avancar(7 * H + 1);
    assert.equal(pedidos.length, 1); assert.equal(sessao.relogioOffsetMs, 30 * MIN, "offset do servidor aprendido");
    await m.avancar(MINIMO_ENTRE_PEDIDOS_MS - 2); assert.equal(pedidos.length, 1, "não insiste antes do mínimo");
    await m.avancar(MIN); assert.equal(pedidos.length, 2);
  });

  test("identidade diferente na resposta (aplicar lança): NÃO adota e para", async () => {
    const m = mundo(); const sessao = EXIB({ expiraEm: new Date(m.agora() + 8 * H).toISOString() });
    const r = criarRenovador({ sessao: () => sessao, agora: m.agora, setT: m.setT, clearT: m.clearT, aleatorio: () => 0,
      renovar: async () => ({ renovado: true }), aplicar: () => { throw new Error("identidade diferente"); } });
    r.iniciar(); await m.avancar(8 * H);
    assert.equal(r.ativo, false); assert.equal(r.contagem.renovacoes, 0);
  });

  test("parar() cancela o que estava agendado (logout/contexto inválido); verificar() pede já quando passou da hora", async () => {
    const { m, r, pedidos, sessao } = montar();
    r.iniciar(); r.parar(); await m.avancar(9 * H); assert.equal(pedidos.length, 0);
    r.iniciar(); sessao.expiraEm = new Date(m.agora() + 20 * MIN).toISOString(); r.verificar();
    await m.avancar(1); assert.equal(pedidos.length, 1);
  });
});
