// iFood (frontend) — estados explícitos da tela e ações coerentes.
//
// Cobre os bugs achados no QA da consolidação:
//   1. apps autorizados + merchant não vinculado NÃO tinha caminho (só "Desconectar");
//   2. erro de GET /status aparecia como "Não conectado" (e oferecia Conectar);
//   3. em reauth_required apareciam "Continuar conexão" e "Reconectar" juntos.
//
// Testes puros (ifoodEstado.js) + prova estrutural de que ifood.js está
// ligado a eles. Sem DOM.
//
// Rodar: node --test test/ifood-estados-ui.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivarEstadoIntegracao, acoesDoPainel, MENSAGEM_ERRO_STATUS,
} from "../src/ifoodEstado.js";

const app = (conectado, status = conectado ? "ativa" : null) => ({ conectado, status, expiraEm: null });
const MERCHANT = { idMascarado: "550e****0000", nome: "Loja Teste", razaoSocial: "Loja Teste LTDA" };
const status = ({ a = app(false), f = app(false), merchant = null, s = "nao_conectado" } = {}) => ({
  conectado: !!merchant && f.conectado, status: s, merchant, apps: { analytics: a, financial: f },
  conectadaEm: merchant ? "2026-09-26T12:00:00Z" : null,
});
const ids = (st, opts) => acoesDoPainel(derivarEstadoIntegracao(st, opts)).map((a) => a.id);
const rotulos = (st, opts) => acoesDoPainel(derivarEstadoIntegracao(st, opts)).map((a) => a.rotulo);

describe("merchant pendente (apps autorizados, loja ainda não vinculada)", () => {
  const st = status({ a: app(true), f: app(true), merchant: null, s: "pendente" });

  test("estado próprio 'merchant_pendente' — não é 'conectado' nem 'parcial' genérico", () => {
    const e = derivarEstadoIntegracao(st);
    assert.equal(e.chave, "merchant_pendente");
    assert.equal(e.rotulo, "Loja pendente");
    assert.equal(e.podeVincularMerchant, true);
    assert.match(e.aviso, /qual loja do iFood/i);
  });

  test("oferece 'Vincular loja' como ação PRIMÁRIA (além de Desconectar) — sem refazer OAuth", () => {
    const acoes = acoesDoPainel(derivarEstadoIntegracao(st));
    assert.deepEqual(acoes.map((a) => a.id), ["vincular", "desconectar"]);
    assert.equal(acoes[0].rotulo, "Vincular loja");
    assert.equal(acoes[0].primaria, true);
    assert.ok(!ids(st).includes("conectar") && !ids(st).includes("continuar"), "não manda refazer o OAuth");
  });

  test("só Financial autorizado (Analytics pulado): vincula a loja e ainda pode autorizar Analytics depois", () => {
    const so = status({ f: app(true), s: "pendente" });
    assert.deepEqual(ids(so), ["vincular", "autorizar_analytics", "desconectar"]);
  });
});

describe("recarregar a tela com OAuth concluído e merchant ainda pendente", () => {
  test("1) OAuth conclui  2) página fecha  3) página reabre  4) a vinculação continua possível", () => {
    // 1) fim do OAuth: o backend passa a devolver os dois apps 'ativa', sem merchant
    const aposOAuth = status({ a: app(true), f: app(true), s: "pendente" });
    assert.equal(derivarEstadoIntegracao(aposOAuth).podeVincularMerchant, true);

    // 2)+3) o estado do wizard vive só em memória (perdido no reload); o painel é
    // reconstruído SOMENTE a partir de GET /status — aqui, o mesmo payload de novo.
    const reaberta = JSON.parse(JSON.stringify(aposOAuth));

    // 4) continua exibindo "Vincular loja"
    const e = derivarEstadoIntegracao(reaberta);
    assert.equal(e.chave, "merchant_pendente");
    assert.deepEqual(ids(reaberta), ["vincular", "desconectar"]);
  });

  test("depois de vincular, some 'Vincular loja' e a integração fica ativa", () => {
    const vinculada = status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" });
    assert.equal(derivarEstadoIntegracao(vinculada).chave, "conectado");
    assert.ok(!ids(vinculada).includes("vincular"));
  });
});

describe("integração conectada", () => {
  const st = status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" });
  test("estado 'conectado' — só Desconectar, nada de conectar/vincular/reconectar", () => {
    const e = derivarEstadoIntegracao(st);
    assert.equal(e.chave, "conectado");
    assert.equal(e.rotulo, "Conectado");
    assert.deepEqual(ids(st), ["desconectar"]);
  });
});

describe("erro ao consultar GET /status", () => {
  test("estado 'erro_status' — NUNCA 'Não conectado'", () => {
    const e = derivarEstadoIntegracao(null, { erro: true });
    assert.equal(e.chave, "erro_status");
    assert.notEqual(e.rotulo, "Não conectado");
    assert.equal(e.rotulo, "Status indisponível");
    assert.equal(e.aviso, "Não foi possível consultar o status da integração.");
    assert.equal(e.aviso, MENSAGEM_ERRO_STATUS);
  });

  test("a única ação é 'Tentar novamente' — não oferece Conectar, Vincular nem Desconectar", () => {
    assert.deepEqual(ids(null, { erro: true }), ["tentar_novamente"]);
    assert.deepEqual(rotulos(null, { erro: true }), ["Tentar novamente"]);
  });

  test("o erro prevalece mesmo se ainda houver um status antigo em memória", () => {
    const antigo = status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" });
    assert.equal(derivarEstadoIntegracao(antigo, { erro: true }).chave, "erro_status");
  });

  test("sem erro, status nulo continua sendo 'nao_conectado' (contrato antigo preservado)", () => {
    assert.equal(derivarEstadoIntegracao(null).chave, "nao_conectado");
    assert.deepEqual(ids(null), ["conectar"]);
  });
});

describe("reauth_required", () => {
  const cenarios = {
    "financial expirou": status({ a: app(true), f: { conectado: false, status: "reauth_required" }, merchant: MERCHANT, s: "reauth_required" }),
    "analytics expirou": status({ a: { conectado: false, status: "reauth_required" }, f: app(true), merchant: MERCHANT, s: "reauth_required" }),
    "conexão em reauth, apps sem detalhe": status({ a: app(true), f: app(true), merchant: MERCHANT, s: "reauth_required" }),
    "reauth sem merchant": status({ a: app(true), f: { conectado: false, status: "reauth_required" }, s: "reauth_required" }),
  };
  for (const [nome, st] of Object.entries(cenarios)) {
    test(`${nome}: uma única ação de reconexão ('Reconectar iFood'), sem 'Continuar conexão'`, () => {
      const e = derivarEstadoIntegracao(st);
      assert.equal(e.chave, "reauth");
      const acoes = acoesDoPainel(e);
      const reconectar = acoes.filter((a) => a.id === "reconectar");
      assert.equal(reconectar.length, 1);
      assert.equal(reconectar[0].rotulo, "Reconectar iFood");
      assert.deepEqual(ids(st).filter((i) => i !== "desconectar"), ["reconectar"]);
      assert.ok(!ids(st).includes("continuar") && !ids(st).includes("conectar") && !ids(st).includes("vincular"));
    });
  }
});

describe("acoesDoPainel — invariantes em TODOS os estados", () => {
  const todos = [
    ["nao_conectado", derivarEstadoIntegracao(status())],
    ["parcial", derivarEstadoIntegracao(status({ a: app(true), s: "pendente" }))],
    ["merchant_pendente", derivarEstadoIntegracao(status({ a: app(true), f: app(true), s: "pendente" }))],
    ["conectado", derivarEstadoIntegracao(status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" }))],
    ["reauth", derivarEstadoIntegracao(status({ f: { conectado: false, status: "reauth_required" }, s: "reauth_required" }))],
    ["erro_status", derivarEstadoIntegracao(null, { erro: true })],
  ];
  for (const [nome, e] of todos) {
    test(`${nome}: ações sem duplicidade e no máximo UMA primária`, () => {
      const acoes = acoesDoPainel(e);
      assert.equal(new Set(acoes.map((a) => a.id)).size, acoes.length, "id repetido");
      assert.ok(acoes.filter((a) => a.primaria).length <= 1, "mais de uma ação primária");
    });
  }
  test("'Conectar iFood' só existe no estado 'nao_conectado'", () => {
    for (const [nome, e] of todos) {
      assert.equal(acoesDoPainel(e).some((a) => a.id === "conectar"), nome === "nao_conectado", nome);
    }
  });
});

describe("ifood.js está ligado a esses estados (prova estrutural)", () => {
  const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8");
  const codigo = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  test("usa acoesDoPainel e passa { erro } para derivarEstadoIntegracao", () => {
    assert.match(codigo, /acoesDoPainel\(e\)/);
    assert.match(codigo, /derivarEstadoIntegracao\(estado\.status,\s*\{\s*erro:\s*!!estado\.statusErro\s*\}\)/);
  });

  test("'vincular' abre direto a etapa de merchant (GET /merchants), sem OAuth", () => {
    assert.match(codigo, /vincular:\s*\(\)\s*=>\s*abrirWizard\("merchant"\)/);
    assert.match(codigo, /if \(modo === "merchant"\) return "merchant"/);
  });

  test("falha de GET /status guarda statusErro e não zera o estado como se fosse 'não conectado'", () => {
    const bloco = codigo.slice(codigo.indexOf("async function carregarStatus()"), codigo.indexOf("function linhaApp"));
    assert.match(bloco, /estado\.statusErro\s*=/);
    assert.doesNotMatch(bloco, /toast\(/);
  });

  test("'Tentar novamente' reconsulta o status", () => {
    assert.match(codigo, /tentar_novamente:\s*\(\)\s*=>\s*\{\s*pintarCarregando\(\);\s*carregarStatus\(\);\s*\}/);
  });

  test("a troca de contexto limpa também o erro de status", () => {
    assert.match(codigo, /estado\.statusErro\s*=\s*null;\s*\n\s*estado\.wizard\s*=\s*null;\s*\n\s*estado\.financeiro\s*=\s*null/);
  });
});
