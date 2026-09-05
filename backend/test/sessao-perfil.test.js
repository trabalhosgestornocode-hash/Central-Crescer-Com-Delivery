// Fase C — perfil operacional no backend (perfil.service.js + acessos por perfil).
//
// Unit test, SEM rede/Supabase: as buscas são injetadas (mesmo padrão de
// sessao-heranca-empresa-unidade.test.js). A migration 060 NÃO está aplicada
// em nenhum ambiente acessível, então NÃO há teste de integração real — só
// contrato + segurança das funções puras. Ver docs/multi-perfil-fase-c-backend-perfil.md.
//
// Rodar: node --env-file-if-exists=.env --test test/sessao-perfil.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  listarPerfisDaConta,
  obterPerfilDaConta,
  validarPerfilDaConta,
  selecionarPerfil,
  listarAcessosDoPerfil,
} from "../src/modules/sessao/perfil.service.js";
import { ApiError } from "../src/shared/ApiError.js";

// UUIDs válidos (v.uuid exige o formato).
const CONTA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FULANA_1 = CONTA_A;                                   // perfil inicial legado: id == conta
const FULANA_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";    // 2º perfil da Conta A (UUID novo)
const PERFIL_B = CONTA_B;
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const UNI_A = "u-a", UNI_B = "u-b";

const org = (id, nome, status = "ativa") => ({ id, nome, logo_url: null, status });

// "Banco" fake de perfis_operacionais.
const PERFIS = {
  [FULANA_1]: { id: FULANA_1, nome: "Fulana 1", ativo: true, conta_id: CONTA_A, pin_hash: null },
  [FULANA_2]: { id: FULANA_2, nome: "Fulana 2", ativo: true, conta_id: CONTA_A, pin_hash: "$argon2-fake" },
  [PERFIL_B]: { id: PERFIL_B, nome: "Beltrano", ativo: true, conta_id: CONTA_B, pin_hash: null },
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd": { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", nome: "Inativa", ativo: false, conta_id: CONTA_A, pin_hash: null },
};
const PERFIL_INATIVO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// Modela `.eq("conta_id", contaId).eq("ativo", true)`.
const buscarPerfisAtivosDaConta = async (contaId) =>
  Object.values(PERFIS).filter((p) => p.conta_id === contaId && p.ativo);

// Modela `.eq("id", perfilId)` + o gate de posse (conta_id === contaId -> senão null).
const buscarPerfilDaConta = async ({ contaId, perfilId }) => {
  const p = PERFIS[perfilId];
  return p && p.conta_id === contaId ? p : null;
};

// Vínculos por perfil: Fulana 1 -> Org A (finance, unidade UNI_A);
//                      Fulana 2 -> Org B (operations, unidade UNI_B).
const buscarVinculosPorPerfil = async ({ contaId, perfilId }) => {
  const base = { superadmin: false, vinculosOrg: [], vinculosUni: [] };
  if (perfilId === FULANA_1) {
    return {
      ...base,
      vinculosOrg: [{ papel: "finance", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }],
      vinculosUni: [{ papel: "finance", unidade_id: UNI_A, unidades: { id: UNI_A, nome: "Loja A", organizacao_id: ORG_A, cidade: null, cnpj: null, ativo: true } }],
    };
  }
  if (perfilId === FULANA_2) {
    return {
      ...base,
      vinculosOrg: [{ papel: "operations", organizacao_id: ORG_B, organizacoes: org(ORG_B, "Empresa B") }],
      vinculosUni: [{ papel: "operations", unidade_id: UNI_B, unidades: { id: UNI_B, nome: "Loja B", organizacao_id: ORG_B, cidade: null, cnpj: null, ativo: true } }],
    };
  }
  return base; // perfil sem vínculo
};

// Herança Empresa -> Unidade: as unidades ativas de cada org (Loja A em ORG_A,
// Loja B em ORG_B). `listarAcessos` chama isto com os ids das orgs que a
// pessoa tem vínculo de EMPRESA — o isolamento já veio de `buscarVinculosPorPerfil`.
const buscarUnidadesAtivas = async (orgIds) => {
  const todas = [
    { id: UNI_A, nome: "Loja A", organizacao_id: ORG_A, cidade: null, cnpj: null },
    { id: UNI_B, nome: "Loja B", organizacao_id: ORG_B, cidade: null, cnpj: null },
  ];
  return todas.filter((u) => orgIds.includes(u.organizacao_id));
};
const buscarInfoOrganizacoes = async (ids) => ids.map((id) => org(id, id === ORG_A ? "Empresa A" : "Empresa B"));

const depsAcessos = () => ({
  buscarPerfilDaConta,
  buscarVinculosPorPerfil,
  buscarUnidadesAtivas,
  buscarInfoOrganizacoes,
});

async function esperaErro(fn, statusEsperado) {
  try {
    await fn();
    assert.fail("esperava ApiError, não lançou");
  } catch (e) {
    assert.ok(e instanceof ApiError, `esperava ApiError, veio ${e}`);
    assert.equal(e.statusCode, statusEsperado);
    return e;
  }
}

// ---------------------------------------------------------------------------

describe("listarPerfisDaConta", () => {
  test("1) conta A lista SOMENTE perfis da conta A", async () => {
    const r = await listarPerfisDaConta(CONTA_A, { buscarPerfisAtivosDaConta });
    assert.deepEqual(r.map((p) => p.id).sort(), [FULANA_1, FULANA_2].sort());
  });

  test("2) conta B não vê perfis da conta A", async () => {
    const r = await listarPerfisDaConta(CONTA_B, { buscarPerfisAtivosDaConta });
    assert.deepEqual(r.map((p) => p.id), [PERFIL_B]);
    assert.ok(!r.some((p) => p.id === FULANA_1 || p.id === FULANA_2));
  });

  test("3) perfil ativo aparece / 4) perfil inativo NÃO aparece", async () => {
    const r = await listarPerfisDaConta(CONTA_A, { buscarPerfisAtivosDaConta });
    assert.ok(r.some((p) => p.id === FULANA_1));
    assert.ok(!r.some((p) => p.id === PERFIL_INATIVO));
  });

  test("5) conta com 1 perfil retorna exatamente 1", async () => {
    const r = await listarPerfisDaConta(CONTA_B, { buscarPerfisAtivosDaConta });
    assert.equal(r.length, 1);
  });

  test("14) conta sem perfil ativo -> lista vazia (estado tratado, sem erro)", async () => {
    const r = await listarPerfisDaConta("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { buscarPerfisAtivosDaConta });
    assert.deepEqual(r, []);
  });

  test("19) resposta NUNCA expõe pin_hash — só o booleano temPin", async () => {
    const r = await listarPerfisDaConta(CONTA_A, { buscarPerfisAtivosDaConta });
    for (const p of r) {
      assert.deepEqual(Object.keys(p).sort(), ["ativo", "id", "nome", "temPin"]);
      assert.equal(typeof p.temPin, "boolean");
      assert.ok(!("pin_hash" in p) && !("pin_tentativas" in p) && !("pin_bloqueado_ate" in p));
    }
    assert.equal(r.find((p) => p.id === FULANA_1).temPin, false);
    assert.equal(r.find((p) => p.id === FULANA_2).temPin, true);
  });

  test("18/D) só usa o contaId passado — perfis de outra conta nunca vazam mesmo com o 'banco' cheio", async () => {
    // buscarPerfisAtivosDaConta real faz `.eq("conta_id", contaId)`; o fake idem.
    const a = await listarPerfisDaConta(CONTA_A, { buscarPerfisAtivosDaConta });
    assert.ok(a.every((p) => PERFIS[p.id].conta_id === CONTA_A));
  });

  test("conta_id inválido -> 400 (v.uuid)", async () => {
    await esperaErro(() => listarPerfisDaConta("não-uuid", { buscarPerfisAtivosDaConta }), 400);
  });
});

describe("validarPerfilDaConta / obterPerfilDaConta", () => {
  test("6/20) perfil inicial legado (id == conta) valida OK", async () => {
    const r = await validarPerfilDaConta({ contaId: CONTA_A, perfilId: FULANA_1 }, { buscarPerfilDaConta });
    assert.equal(r.id, FULANA_1);
    assert.equal(r.nome, "Fulana 1");
  });

  test("7) perfil da própria conta -> validado", async () => {
    const r = await validarPerfilDaConta({ contaId: CONTA_A, perfilId: FULANA_2 }, { buscarPerfilDaConta });
    assert.equal(r.id, FULANA_2);
    assert.equal(r.temPin, true);
  });

  test("8/A) perfil de OUTRA conta -> 404 (mesma resposta de 'não existe')", async () => {
    const eOutra = await esperaErro(
      () => validarPerfilDaConta({ contaId: CONTA_A, perfilId: PERFIL_B }, { buscarPerfilDaConta }), 404);
    const eInexist = await esperaErro(
      () => validarPerfilDaConta({ contaId: CONTA_A, perfilId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, { buscarPerfilDaConta }), 404);
    assert.equal(eOutra.message, eInexist.message); // não vaza existência
  });

  test("C) perfil da conta mas INATIVO -> 403 (bloqueado)", async () => {
    await esperaErro(
      () => validarPerfilDaConta({ contaId: CONTA_A, perfilId: PERFIL_INATIVO }, { buscarPerfilDaConta }), 403);
  });

  test("obterPerfilDaConta devolve null (não lança) para perfil de outra conta", async () => {
    const r = await obterPerfilDaConta({ contaId: CONTA_A, perfilId: PERFIL_B }, { buscarPerfilDaConta });
    assert.equal(r, null);
  });

  test("D) perfilId inválido -> 400", async () => {
    await esperaErro(() => validarPerfilDaConta({ contaId: CONTA_A, perfilId: 123 }, { buscarPerfilDaConta }), 400);
  });
});

describe("selecionarPerfil (Fase C: só valida + contrato)", () => {
  test("7) perfil da conta -> { perfil, temPin, precisaPin:false, proximoPasso }", async () => {
    const r = await selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, {
      buscarPerfilDaConta, buscarPerfisAtivosDaConta: async () => [{ id: FULANA_1 }], emitirProva: () => 'prova-local-teste',
    });
    assert.deepEqual(r.perfil, { id: FULANA_1, nome: "Fulana 1" });
    assert.equal(r.temPin, false);
    assert.equal(r.precisaPin, false);          // PIN só na Fase H
    assert.equal(r.proximoPasso, "selecionar_contexto");
    assert.ok(!JSON.stringify(r).includes("pin_hash"));
  });

  test("8/A) perfil de outra conta -> 404, sem token, sem estado", async () => {
    await esperaErro(() => selecionarPerfil({ contaId: CONTA_A, perfilId: PERFIL_B }, { buscarPerfilDaConta }), 404);
  });

  test("C) perfil inativo -> 403", async () => {
    await esperaErro(() => selecionarPerfil({ contaId: CONTA_A, perfilId: PERFIL_INATIVO }, { buscarPerfilDaConta }), 403);
  });

  test("NÃO emite Context Token nesta fase (resposta não tem contextToken/pid)", async () => {
    const r = await selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, {
      buscarPerfilDaConta, buscarPerfisAtivosDaConta: async () => [{ id: FULANA_2 }], emitirProva: () => 'prova-local-teste',
    });
    assert.ok(!("contextToken" in r) && !("token" in r) && !("pid" in r));
  });
});

describe("listarAcessosDoPerfil — ISOLAMENTO por perfil (item 9-13, sec. B)", () => {
  test("9) acessos da Fulana 1 -> SOMENTE Empresa A", async () => {
    const { opcoes } = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, depsAcessos());
    assert.ok(opcoes.length >= 1);
    assert.ok(opcoes.every((o) => o.organizacaoId === ORG_A));
    assert.ok(!opcoes.some((o) => o.organizacaoId === ORG_B));
  });

  test("10) acessos da Fulana 2 -> SOMENTE Empresa B", async () => {
    const { opcoes } = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, depsAcessos());
    assert.ok(opcoes.every((o) => o.organizacaoId === ORG_B));
    assert.ok(!opcoes.some((o) => o.organizacaoId === ORG_A));
  });

  test("11) dois perfis da MESMA conta com organizações diferentes — sem interseção", async () => {
    const a = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, depsAcessos());
    const b = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, depsAcessos());
    const orgsA = new Set(a.opcoes.map((o) => o.organizacaoId));
    const orgsB = new Set(b.opcoes.map((o) => o.organizacaoId));
    assert.equal([...orgsA].filter((x) => orgsB.has(x)).length, 0);
  });

  test("12) cargo da Fulana 1 (finance) não aparece nos acessos da Fulana 2", async () => {
    const b = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, depsAcessos());
    assert.ok(b.opcoes.every((o) => o.papel === "operations"));
    assert.ok(!b.opcoes.some((o) => o.papel === "finance"));
  });

  test("13) unidade da Fulana 1 (Loja A) não aparece nos acessos da Fulana 2", async () => {
    const b = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, depsAcessos());
    assert.ok(!b.opcoes.some((o) => o.unidadeId === UNI_A));
    assert.ok(b.opcoes.some((o) => o.unidadeId === UNI_B));
  });

  test("15) perfil SEM vínculo -> opcoes vazio (estado tratado)", async () => {
    // FULANA_1 mas com buscarVinculosPorPerfil devolvendo vazio
    const deps = { ...depsAcessos(), buscarVinculosPorPerfil: async () => ({ superadmin: false, vinculosOrg: [], vinculosUni: [] }) };
    const { opcoes } = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, deps);
    assert.deepEqual(opcoes, []);
  });

  test("A) acessos de um perfil de OUTRA conta -> 404 antes de qualquer query de vínculo", async () => {
    let tocouVinculos = false;
    const deps = { ...depsAcessos(), buscarVinculosPorPerfil: async () => { tocouVinculos = true; return { superadmin: false, vinculosOrg: [], vinculosUni: [] }; } };
    await esperaErro(() => listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: PERFIL_B }, deps), 404);
    assert.equal(tocouVinculos, false); // validou posse ANTES
  });

  test("C) acessos de perfil inativo -> 403 antes dos vínculos", async () => {
    await esperaErro(() => listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: PERFIL_INATIVO }, depsAcessos()), 403);
  });

  test("B) org da Fulana 2 nunca é selecionável ao listar acessos da Fulana 1", async () => {
    // Mesmo que o cliente 'saiba' o ORG_B, ele não aparece nas opções da Fulana 1.
    const { opcoes } = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, depsAcessos());
    assert.ok(!opcoes.map((o) => o.organizacaoId).includes(ORG_B));
  });

  test("17) superadmin COM vínculo: flag propaga (checada por conta, não por perfil)", async () => {
    const deps = {
      ...depsAcessos(),
      buscarVinculosPorPerfil: async ({ contaId }) => {
        assert.equal(contaId, CONTA_A); // superadmin é atributo da CONTA
        return { superadmin: true, vinculosOrg: [{ papel: "finance", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }], vinculosUni: [] };
      },
    };
    const r = await listarAcessosDoPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, deps);
    assert.equal(r.superadmin, true);
  });
});

// ---------------------------------------------------------------------------
// Contrato dos ENDPOINTS / controllers — scan de fonte (item 18):
// nenhum handler lê conta_id/perfil da CONTA do corpo/query; usa req.user.id.
// ---------------------------------------------------------------------------
describe("controllers — a conta vem SEMPRE de req.user.id (item 18)", () => {
  const CTRL = readFileSync(
    fileURLToPath(new URL("../src/modules/sessao/sessao.controller.js", import.meta.url)), "utf8");

  test("`perfis` e `selecionarPerfil` usam req.user.id como contaId", () => {
    assert.match(CTRL, /listarPerfisDaConta\(req\.user\.id\)/);
    assert.match(CTRL, /selecionarPerfil\(\{\s*contaId:\s*req\.user\.id/s);
  });

  test("`acessos` com perfilId usa req.user.id como contaId (perfilId vem da query)", () => {
    assert.match(CTRL, /listarAcessosDoPerfil\(\{\s*contaId:\s*req\.user\.id,\s*perfilId\s*\}\)/s);
  });

  test("NENHUM handler lê contaId/conta_id do body ou da query", () => {
    assert.doesNotMatch(CTRL, /req\.(body|query)\.(contaId|conta_id|usuarioId|usuario_id)/);
  });

  test("legacy: `acessos` sem perfilId continua usando service.listarAcessos({ usuarioId: req.user.id })", () => {
    assert.match(CTRL, /service\.listarAcessos\(\{\s*usuarioId:\s*req\.user\.id\s*\}\)/);
  });
});

describe("rotas — /perfis e /selecionar-perfil exigem auth+senha mas NÃO contexto", () => {
  const ROUTES = readFileSync(
    fileURLToPath(new URL("../src/modules/sessao/sessao.routes.js", import.meta.url)), "utf8");

  test("GET /perfis e POST /selecionar-perfil registrados com exigirSenhaDefinitiva, sem requireContexto", () => {
    assert.match(ROUTES, /get\("\/perfis",\s*exigirSenhaDefinitiva,\s*controller\.perfis\)/);
    // /selecionar-perfil: exigirSenhaDefinitiva presente, controller ao final; um
    // rate limiter (limitePin) pode vir no meio — Fase P0.3/P0.4.
    assert.match(ROUTES, /post\("\/selecionar-perfil",\s*exigirSenhaDefinitiva,.*controller\.selecionarPerfil\)/);
    // nem /perfis nem /selecionar-perfil podem conter requireContexto
    for (const rota of ['"/perfis"', '"/selecionar-perfil"']) {
      const linha = ROUTES.split("\n").find((l) => l.includes(rota));
      assert.ok(linha && !linha.includes("requireContexto"), `${rota} não deve exigir contexto`);
    }
  });

  test("POST /selecionar-perfil tem rate limit (P0.4 — anti brute-force de PIN por conta + IP)", () => {
    assert.match(ROUTES, /post\("\/selecionar-perfil",[^)]*limitePin/);
    assert.match(ROUTES, /sessao:pin:conta/);
    assert.match(ROUTES, /sessao:pin:ip/);
  });
});

// ---------------------------------------------------------------------------
// item 20 — usuário legado não é invalidado: o caminho `{ usuarioId }` de
// `listarAcessos` continua intacto (coberto pelos testes de herança
// existentes; aqui só a garantia de que a assinatura antiga ainda funciona).
// ---------------------------------------------------------------------------
describe("compat legado (item 20)", () => {
  test("listarAcessos({ usuarioId }) segue funcionando sem tocar no caminho de perfil", async () => {
    const { listarAcessos } = await import("../src/modules/sessao/sessao.service.js");
    let usouPerfil = false;
    const { opcoes } = await listarAcessos(
      { usuarioId: CONTA_A },
      {
        buscarVinculos: async (uid) => {
          assert.equal(uid, CONTA_A);
          return { superadmin: false, vinculosOrg: [{ papel: "operations", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }], vinculosUni: [] };
        },
        buscarVinculosPorPerfil: async () => { usouPerfil = true; return { superadmin: false, vinculosOrg: [], vinculosUni: [] }; },
        buscarUnidadesAtivas: async () => [],
        buscarInfoOrganizacoes: async () => [],
      },
    );
    assert.equal(usouPerfil, false);
    assert.equal(opcoes[0].organizacaoId, ORG_A);
  });
});
