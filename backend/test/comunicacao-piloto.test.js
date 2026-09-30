// FIM DO PILOTO (migration 104) — as variáveis COMUNICACAO_PILOTO_* são LEGADO: só aparecem no diagnóstico técnico como "LEGACY — sem efeito" e NUNCA
// interferem na elegibilidade. Puro (sem banco).
// Rodar: node --test test/comunicacao-piloto.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as piloto from "../src/modules/comunicacao/comunicacao.piloto.js";
import { diagnosticoPilotoLegado, ROTULO_LEGADO } from "../src/modules/comunicacao/comunicacao.piloto.js";
import { avaliarEnvio } from "../src/modules/comunicacao/comunicacao.policy.js";
import { interpretarHabilitacao } from "../src/modules/comunicacao/comunicacao.habilitacao.js";
import { MODOS } from "../src/modules/comunicacao/comunicacao.constants.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(aqui, "..", "src");

const TEL = "+5511987654321";

describe("piloto encerrado — diagnóstico LEGACY (sem efeito)", () => {
  test("sem as variáveis: nada configurado", () => {
    const d = diagnosticoPilotoLegado({});
    assert.equal(d.configurado, false);
    assert.equal(d.semEfeito, true);
    assert.equal(d.rotulo, ROTULO_LEGADO);
    assert.match(d.rotulo, /LEGACY/);
    assert.equal(d.quantidadeEntradas, 0);
  });
  test("com as variáveis: aparece como LEGACY — sem efeito, com presença e contagem, NUNCA o valor nem o telefone", () => {
    const env = { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `${TEL},+5562999998888` };
    const d = diagnosticoPilotoLegado(env);
    assert.equal(d.configurado, true);
    assert.equal(d.semEfeito, true);
    assert.equal(d.quantidadeEntradas, 2);
    assert.deepEqual(d.variaveis, { COMUNICACAO_PILOTO_ENABLED: "presente", COMUNICACAO_PILOTO_TELEFONES_E164: "presente" });
    const serializado = JSON.stringify(d);
    assert.equal(serializado.includes("5511987654321"), false, "telefone vazou no diagnóstico");
    assert.equal(serializado.includes("5562999998888"), false, "telefone vazou no diagnóstico");
  });
  test("valor malformado nunca lança", () => {
    assert.doesNotThrow(() => diagnosticoPilotoLegado({ COMUNICACAO_PILOTO_TELEFONES_E164: "lixo,,;;", COMUNICACAO_PILOTO_ENABLED: "talvez" }));
    assert.doesNotThrow(() => diagnosticoPilotoLegado(undefined));
  });
});

describe("piloto encerrado — as variáveis NÃO interferem na elegibilidade", () => {
  test("o módulo não exporta mais nenhuma função que autorize/bloqueie telefone", () => {
    assert.deepEqual(Object.keys(piloto).sort(), ["ROTULO_LEGADO", "diagnosticoPilotoLegado"]);
  });
  test("variáveis do piloto no ambiente (com OUTRO telefone) não bloqueiam nem liberam nada na política", () => {
    const antes = { ...process.env };
    process.env.COMUNICACAO_PILOTO_ENABLED = "true";
    process.env.COMUNICACAO_PILOTO_TELEFONES_E164 = "+5500000000000";
    try {
      const snapshot = {
        modo: MODOS.NORMAL, ehProativo: true, contatoExiste: true, telefoneVerificado: true, optOut: false, consentimento: true, destinatarioAtivo: true, vinculoValido: true,
        empresaHabilitada: true, tipoPermitido: true, envioAutomatico: true, categoriaPermitida: true, configHorarioValida: true, empresaPausada: false,
        pendenciaAindaExiste: true, duplicado: false, cooldownAtivo: false, dentroDaJanela: true, rateLimitExcedido: false, providerConectado: true, identidadeConfirmada: true,
      };
      assert.deepEqual(avaliarEnvio(snapshot), { allowed: true, reason: null });
      const hab = interpretarHabilitacao({ habilitado: true, envio_automatico: true, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"] }, "dashboard_ifood_d1");
      assert.equal(hab.empresaHabilitada, true);
      assert.equal(hab.envioAutomatico, true);
    } finally {
      process.env.COMUNICACAO_PILOTO_ENABLED = antes.COMUNICACAO_PILOTO_ENABLED ?? "";
      if (antes.COMUNICACAO_PILOTO_ENABLED === undefined) delete process.env.COMUNICACAO_PILOTO_ENABLED;
      if (antes.COMUNICACAO_PILOTO_TELEFONES_E164 === undefined) delete process.env.COMUNICACAO_PILOTO_TELEFONES_E164; else process.env.COMUNICACAO_PILOTO_TELEFONES_E164 = antes.COMUNICACAO_PILOTO_TELEFONES_E164;
    }
  });
  test("estático: nenhum código de produção fora de comunicacao.piloto.js lê COMUNICACAO_PILOTO_* (sem fallback para as variáveis)", () => {
    const arquivos = [];
    const varrer = (dir) => { for (const e of readdirSync(dir)) { const f = path.join(dir, e); if (statSync(f).isDirectory()) varrer(f); else if (f.endsWith(".js")) arquivos.push(f); } };
    varrer(SRC);
    const semComentarios = (c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const leem = arquivos.filter((a) => !a.endsWith("comunicacao.piloto.js") && /COMUNICACAO_PILOTO_/.test(semComentarios(readFileSync(a, "utf8"))));
    assert.deepEqual(leem, [], `arquivos que ainda leem as variáveis do piloto: ${leem.join(", ")}`);
  });
});
