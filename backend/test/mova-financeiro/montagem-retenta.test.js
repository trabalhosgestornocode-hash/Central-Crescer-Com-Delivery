// 24/11 (produção, deploy 03:04Z): a montagem do MOVA falhou no boot com 53300 (excesso de conexões durante a troca de instância)
// e o MOVA ficou parado até o deploy seguinte. Falha TRANSITÓRIA agora agenda nova tentativa; falha de configuração/segurança não.
// Sem banco, sem rede: a montagem e o agendador são injetados.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODIGOS_TRANSITORIOS_DE_MONTAGEM, iniciarMovaEmbutido, pararMovaEmbutido } from "../../src/modules/fv2-integracao/mova.js";

const ENV = { MOVA_HABILITADO: "1", MOVA_PROCESSAMENTO_HABILITADO: "1", MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_GATEWAY_SECRET: "m".repeat(40), MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01", MOVA_DATABASE_URL: "postgres://homolog", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
const falha = (codigo) => async ({ registrar }) => { registrar({ tipo: "MOVA_MONTAGEM_FALHOU", codigo }); return null; };
const montado = () => { const m = { iniciado: 0, worker: { iniciar() { m.iniciado++; }, parar() {} }, enviador: { habilitado: false }, mova: { receptor: {} }, controle: null }; return m; };
function agendadorManual() {
  const fila = [];
  return { fila, agendar: (fn, ms) => { const h = { fn, ms, cancelado: false }; fila.push(h); return h; }, async rodar() { const h = fila.shift(); await h.fn(); await new Promise((r) => setImmediate(r)); } };
}

test("MR-01 53300 no boot (excesso de conexões): agenda nova tentativa e, quando o banco volta, o worker inicia", async () => {
  const ag = agendadorManual(); const eventos = []; const m = montado();
  let chamadas = 0;
  const montar = async (o) => (++chamadas === 1 ? falha("53300")(o) : m);
  const r = await iniciarMovaEmbutido({ env: ENV, log: (_n, _e, d) => eventos.push(d), montar, agendar: ag.agendar });
  assert.deepEqual([r.habilitado, r.retentando, r.codigo, r.emMs], [false, true, "53300", 15000]);
  assert.equal(ag.fila.length, 1);
  await ag.rodar();
  assert.equal(m.iniciado, 1, "o worker iniciou na nova tentativa");
  assert.ok(eventos.some((e) => e?.tipo === "MOVA_MONTADO_APOS_NOVA_TENTATIVA"));
  await pararMovaEmbutido({ env: ENV });
});

test("MR-02 espera cresce (15 s, 30 s, 60 s…) e para em 5 min; sem limite de tentativas", async () => {
  const ag = agendadorManual();
  const r = await iniciarMovaEmbutido({ env: ENV, montar: falha("ECONNREFUSED"), agendar: ag.agendar });
  const esperas = [r.emMs];
  for (let i = 0; i < 6; i++) { const h = ag.fila[0]; await ag.rodar(); esperas.push(ag.fila[0]?.ms); void h; }
  assert.deepEqual(esperas, [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
  await pararMovaEmbutido({ env: ENV });
});

test("MR-03 falha de CONFIGURAÇÃO/SEGURANÇA (banco que não é o esperado) não é repetida: o MOVA fica parado", async () => {
  const ag = agendadorManual();
  const r = await iniciarMovaEmbutido({ env: ENV, montar: falha("BANCO_NAO_E_DE_HOMOLOGACAO"), agendar: ag.agendar });
  assert.deepEqual(r, { habilitado: false, motivo: "MOVA_NAO_MONTADO" });
  assert.equal(ag.fila.length, 0);
});

test("MR-04 MOVA desligado continua sem montar e sem agendar nada", async () => {
  const ag = agendadorManual(); let chamou = false;
  const r = await iniciarMovaEmbutido({ env: {}, montar: async () => { chamou = true; return null; }, agendar: ag.agendar });
  assert.deepEqual([r, chamou, ag.fila.length], [{ habilitado: false, motivo: "DESLIGADO" }, false, 0]);
});

test("MR-05 os códigos transitórios cobrem conexão recusada, excesso de conexões e reinício do banco", () => {
  for (const c of ["53300", "57P01", "57P03", "08006", "ECONNREFUSED", "ETIMEDOUT"]) assert.ok(CODIGOS_TRANSITORIOS_DE_MONTAGEM.includes(c), c);
  for (const c of ["BANCO_NAO_E_DE_HOMOLOGACAO", "42501", "28P01", "ERRO"]) assert.ok(!CODIGOS_TRANSITORIOS_DE_MONTAGEM.includes(c), c);
});
