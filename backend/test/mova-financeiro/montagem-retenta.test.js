// 24/11 (produção, deploy 03:04Z): a montagem do MOVA falhou no boot com 53300 (excesso de conexões durante a troca de instância)
// e o MOVA ficou parado até o deploy seguinte. Agora: máquina de estados única, nova tentativa com jitter só para falha TRANSITÓRIA,
// sem montagem simultânea nem worker duplicado, desligamento cancela tudo e /health/mova reflete o estado real.
// Sem banco, sem rede: a montagem e o agendador são injetados.
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CODIGOS_TRANSITORIOS_DE_MONTAGEM, categoriaDaFalhaDeMontagem, esperaDaTentativa, estadoMova, iniciarMovaEmbutido, pararMovaEmbutido } from "../../src/modules/fv2-integracao/mova.js";

const ENV = { MOVA_HABILITADO: "1", MOVA_PROCESSAMENTO_HABILITADO: "1", MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_GATEWAY_SECRET: "m".repeat(40), MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01", MOVA_DATABASE_URL: "postgres://homolog", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
const MEIO = () => 0.5; // jitter neutro: espera = base
const falha = (codigo) => async ({ registrar }) => { registrar({ tipo: "MOVA_MONTAGEM_FALHOU", codigo }); return null; };
const montado = () => { const m = { iniciado: 0, parado: 0, worker: { iniciar() { m.iniciado++; }, parar() { m.parado++; } }, enviador: { habilitado: false }, mova: { receptor: {} }, controle: null }; return m; };
function agendadorManual() {
  const fila = [];
  return { fila, agendar: (fn, ms) => { const h = { fn, ms }; fila.push(h); return h; }, async rodar() { const h = fila.shift(); await h.fn(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); } };
}
afterEach(() => pararMovaEmbutido({ env: ENV }));

test("MR-01 53300 no boot: RETENTANDO, nova tentativa agendada; quando o banco volta, ATIVO e o worker inicia uma vez", async () => {
  const ag = agendadorManual(); const eventos = []; const m = montado();
  let chamadas = 0;
  const montar = async (o) => (++chamadas === 1 ? falha("53300")(o) : m);
  const r = await iniciarMovaEmbutido({ env: ENV, log: (_n, _e, d) => eventos.push(d), montar, agendar: ag.agendar, aleatorio: MEIO });
  assert.deepEqual([r.habilitado, r.retentando, r.codigo, r.emMs], [false, true, "53300", 15000]);
  assert.deepEqual([estadoMova().estado, estadoMova().categoria, estadoMova().ultimaFalha], ["RETENTANDO", "TRANSITORIA", "53300"]);
  await ag.rodar();
  assert.equal(m.iniciado, 1);
  assert.equal(estadoMova().estado, "ATIVO");
  assert.ok(eventos.some((e) => e?.tipo === "MOVA_MONTADO_APOS_NOVA_TENTATIVA"));
});

test("MR-02 espera exponencial (15 s, 30 s … 5 min) com JITTER de ±20%; sem limite de tentativas", async () => {
  const ag = agendadorManual();
  const r = await iniciarMovaEmbutido({ env: ENV, montar: falha("ECONNREFUSED"), agendar: ag.agendar, aleatorio: MEIO });
  const esperas = [r.emMs];
  for (let i = 0; i < 7; i++) { await ag.rodar(); esperas.push(ag.fila[0]?.ms); }
  assert.deepEqual(esperas, [15000, 30000, 60000, 120000, 240000, 300000, 300000, 300000]);
  assert.equal(esperaDaTentativa(0, () => 0), 12000);
  assert.equal(esperaDaTentativa(0, () => 1), 18000);
  assert.equal(esperaDaTentativa(10, () => 1), 360000, "o teto de 5 min também recebe jitter (instâncias não sincronizam)");
});

test("MR-03 falha de SEGURANÇA (banco errado, senha, permissão) e de CONFIGURAÇÃO: FALHOU, sem nova tentativa", async () => {
  for (const [codigo, categoria] of [["BANCO_NAO_E_DE_HOMOLOGACAO", "SEGURANCA"], ["28P01", "SEGURANCA"], ["42501", "SEGURANCA"], ["ERRO", "CONFIGURACAO"], ["CONFIGURACAO_INVALIDA", "CONFIGURACAO"]]) {
    const ag = agendadorManual();
    const r = await iniciarMovaEmbutido({ env: ENV, montar: falha(codigo), agendar: ag.agendar });
    assert.deepEqual([r.habilitado, r.categoria, ag.fila.length, estadoMova().estado], [false, categoria, 0, "FALHOU"], codigo);
    await pararMovaEmbutido({ env: ENV });
  }
});

test("MR-04 MOVA desligado: estado DESLIGADO, nada montado, nada agendado", async () => {
  const ag = agendadorManual(); let chamou = false;
  const r = await iniciarMovaEmbutido({ env: {}, montar: async () => { chamou = true; return null; }, agendar: ag.agendar });
  assert.deepEqual([r, chamou, ag.fila.length, estadoMova().estado], [{ habilitado: false, motivo: "DESLIGADO" }, false, 0, "DESLIGADO"]);
});

test("MR-05 categorias: transitórias (conexão, excesso, reinício do banco) × segurança × configuração", () => {
  for (const c of ["53300", "57P01", "57P03", "08006", "ECONNREFUSED", "ETIMEDOUT"]) assert.equal(categoriaDaFalhaDeMontagem(c), "TRANSITORIA", c);
  for (const c of ["BANCO_NAO_E_DE_HOMOLOGACAO", "42501", "28P01", "3D000"]) assert.equal(categoriaDaFalhaDeMontagem(c), "SEGURANCA", c);
  for (const c of ["ERRO", null, ""]) assert.equal(categoriaDaFalhaDeMontagem(c), "CONFIGURACAO", String(c));
  assert.ok(!CODIGOS_TRANSITORIOS_DE_MONTAGEM.includes("42501"));
});

test("MR-06 chamadas SIMULTÂNEAS: uma única montagem e um único worker", async () => {
  const m = montado(); let montagens = 0;
  const montar = async () => { montagens++; await new Promise((r) => setTimeout(r, 20)); return m; };
  const rs = await Promise.all([1, 2, 3].map(() => iniciarMovaEmbutido({ env: ENV, montar })));
  assert.deepEqual([montagens, m.iniciado], [1, 1]);
  assert.ok(rs.every((r) => r.habilitado));
  const de_novo = await iniciarMovaEmbutido({ env: ENV, montar });
  assert.deepEqual([de_novo.jaAtivo, montagens, m.iniciado], [true, 1, 1], "já ativo: não monta nem inicia outro worker");
});

test("MR-07 desligamento CANCELA a nova tentativa pendente e impede que a montagem em andamento ligue algo", async () => {
  const ag = agendadorManual();
  await iniciarMovaEmbutido({ env: ENV, montar: falha("53300"), agendar: ag.agendar, aleatorio: MEIO });
  await pararMovaEmbutido({ env: ENV });
  assert.equal(estadoMova().estado, "PARADO");
  // a tentativa já agendada dispara depois do desligamento: não faz nada
  const m = montado();
  ag.fila[0].fn = ag.fila[0].fn; // mesmo callback agendado antes do desligamento
  await ag.rodar();
  assert.equal(m.iniciado, 0);
  assert.equal(estadoMova().estado, "PARADO");
  // montagem EM ANDAMENTO quando o desligamento chega
  let liberar; const m2 = montado();
  const p = iniciarMovaEmbutido({ env: ENV, montar: () => new Promise((r) => { liberar = () => r(m2); }) });
  await new Promise((r) => setImmediate(r));
  await pararMovaEmbutido({ env: ENV });
  liberar();
  const r = await p;
  assert.deepEqual([r.motivo, m2.iniciado], ["DESLIGADO_DURANTE_A_MONTAGEM", 0]);
});

test("MR-08 rotas reais: /health/mova 503 re-tentando, 200 ativo; /health geral 200 e só informa o estado (sem segredo)", async () => {
  const { createApp } = await import("../../src/app.js");
  const app = createApp();
  const servidor = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = (c) => `http://127.0.0.1:${servidor.address().port}${c}`;
  try {
    const ag = agendadorManual();
    await iniciarMovaEmbutido({ env: ENV, montar: falha("53300"), agendar: ag.agendar, aleatorio: MEIO });
    let r = await fetch(url("/health/mova"));
    const corpo = await r.json();
    assert.deepEqual([r.status, corpo.ok, corpo.estado, corpo.ultimaFalha], [503, false, "RETENTANDO", "53300"]);
    assert.doesNotMatch(JSON.stringify(corpo), /postgres:\/\/|secret|senha|m{40}/i);
    r = await fetch(url("/health"));
    assert.deepEqual([r.status, (await r.json()).mova], [200, "RETENTANDO"]);
    await pararMovaEmbutido({ env: ENV });
    await iniciarMovaEmbutido({ env: ENV, montar: async () => montado() });
    r = await fetch(url("/health/mova"));
    assert.deepEqual([r.status, (await r.json()).worker], [200, true]);
  } finally { await new Promise((r) => servidor.close(r)); }
});

test("MR-09 tentativa que falha FECHA os pools que abriu (cada nova tentativa não vaza conexões)", async () => {
  const { movaDaPlataforma, registrarDependenciasFv2 } = await import("../../src/modules/fv2-integracao/mova.js");
  registrarDependenciasFv2(() => ({ repositorio: {} }));
  const eventos = [];
  const env = { ...ENV, MOVA_DATABASE_URL: "postgres://x:y@127.0.0.1:1/homolog", FV2_APP_DATABASE_URL: "postgres://x:y@127.0.0.1:1/fv2" };
  for (let i = 0; i < 3; i++) assert.equal(await movaDaPlataforma({ env, registrar: (e) => eventos.push(e) }), null);
  const falhas = eventos.filter((e) => e.tipo === "MOVA_MONTAGEM_FALHOU");
  assert.equal(falhas.length, 3);
  assert.ok(falhas.every((e) => e.codigo === "ECONNREFUSED" && e.conexoesFechadas === 1), JSON.stringify(falhas));
});
