// Fase G — CRUD administrativo de múltiplos perfis operacionais por conta.
//
// Unit (injeção de dependência) + scans de fonte + verificação da migration
// gate (063). SEM banco. Cobre os 24 testes numerados do pedido + o caso real
// (Operacional X → Fulana 1 / Fulana 2).
//
// Rodar: node --env-file-if-exists=.env --test test/perfis-crud-multi.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  criarPerfilOperacional, definirAtivoDoPerfil,
} from "../src/modules/sessao/perfil.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PERFIL_SVC = src("../src/modules/sessao/perfil.service.js");
const PLAT_USUARIOS = src("../src/modules/plataforma/plataforma.usuarios.service.js");
const PLAT_ROUTES = src("../src/modules/plataforma/plataforma.routes.js");
const MIG_063 = src("../../database/migrations/063_vinculos_perfil_id_not_null.sql");

const CONTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FULANA_1 = CONTA; // perfil legado: id == conta
const FULANA_2 = "22222222-2222-4222-8222-222222222222";

async function erro(fn, status, codigo) {
  try { await fn(); assert.fail("esperava ApiError"); }
  catch (e) {
    assert.ok(e instanceof ApiError, `veio ${e?.stack || e}`);
    if (status) assert.equal(e.statusCode, status);
    if (codigo) assert.equal(e.details?.codigo, codigo);
    return e;
  }
}

// ===========================================================================
describe("criarPerfilOperacional — UUID novo, mesma conta (testes 2/3/9)", () => {
  test("2/3) o id NÃO reaproveita contaId; conta_id aponta para a conta", () => {
    // scan: o insert NÃO passa `id`, deixa o default gen_random_uuid()
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("export async function criarPerfilOperacional"), PERFIL_SVC.indexOf("export async function definirAtivoDoPerfil"));
    assert.match(fn, /\.insert\(\{ conta_id: cId, nome: nomeOk, ativo \}\)/);
    assert.doesNotMatch(fn, /\.insert\(\{ id:/);
    assert.match(fn, /id: default gen_random_uuid/);
  });

  test("conta inexistente -> 404", async () => {
    await erro(() => criarPerfilOperacional({ contaId: CONTA, nome: "Fulana 2" }, { buscarConta: async () => null }), 404);
  });

  test("nome inválido -> 400 antes de qualquer escrita", async () => {
    await erro(() => criarPerfilOperacional({ contaId: CONTA, nome: "" }, { buscarConta: async () => ({ id: CONTA }) }), 400);
  });
});

// ===========================================================================
describe("definirAtivoDoPerfil — nunca DELETE, revoga só o perfil (testes 15–19)", () => {
  const perfil = (id, ativo = true, pin = "s1:h") => ({ id, nome: `P ${id.slice(0, 4)}`, ativo, pin_hash: pin });

  test("15/17) DESATIVAR revoga as sessões DAQUELE perfil (escopo perfilId), não os irmãos", async () => {
    let escopo = null;
    const r = await definirAtivoDoPerfil({ contaId: CONTA, perfilId: FULANA_2, ativo: false }, {
      buscarPerfisDaConta: async () => [perfil(FULANA_1), perfil(FULANA_2)],
      revogar: async (f) => { escopo = f; return 3; },
      aplicar: async () => {},
    });
    assert.equal(r.ativo, false);
    assert.equal(r.sessoesRevogadas, 3);
    assert.deepEqual(escopo, { perfilId: FULANA_2, motivo: "perfil_desativado" });
  });

  test("18) REATIVAR que deixaria a conta multi-perfil sem PIN em todos -> 403", async () => {
    await erro(() => definirAtivoDoPerfil({ contaId: CONTA, perfilId: FULANA_2, ativo: true }, {
      buscarPerfisDaConta: async () => [perfil(FULANA_1, true, "s1:h"), perfil(FULANA_2, false, null)],
      revogar: async () => 0,
    }), 403, "CONFIGURACAO_PIN_INCOMPLETA");
  });

  test("REATIVAR com PIN em todos -> ok", async () => {
    const r = await definirAtivoDoPerfil({ contaId: CONTA, perfilId: FULANA_2, ativo: true }, {
      buscarPerfisDaConta: async () => [perfil(FULANA_1, true, "s1:h"), perfil(FULANA_2, false, "s1:h")],
      revogar: async () => 0,
      aplicar: async () => {},
    });
    assert.equal(r.ativo, true);
    assert.equal(r.sessoesRevogadas, 0); // ativar não revoga
  });

  test("desativar o único perfil ativo -> a conta volta a single-profile (permitido)", async () => {
    const r = await definirAtivoDoPerfil({ contaId: CONTA, perfilId: FULANA_2, ativo: false }, {
      buscarPerfisDaConta: async () => [perfil(FULANA_1, false, null), perfil(FULANA_2, true, "s1:h")],
      revogar: async () => 1,
      aplicar: async () => {},
    });
    assert.equal(r.ativo, false);
  });

  test("perfil inexistente -> 404", async () => {
    await erro(() => definirAtivoDoPerfil({ contaId: CONTA, perfilId: FULANA_2, ativo: false }, {
      buscarPerfisDaConta: async () => [perfil(FULANA_1)],
    }), 404);
  });

  test("17) não há DELETE físico de perfil no service (só update ativo)", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("export async function definirAtivoDoPerfil"), PERFIL_SVC.indexOf("export async function definirAtivoDoPerfil") + 1800);
    assert.match(fn, /\.update\(\{ ativo: alvoAtivo \}\)/);
    assert.doesNotMatch(fn, /perfis_operacionais"\)\.delete/);
  });
});

// ===========================================================================
describe("segurança de posse — perfil pertence à conta da URL (teste 15/29)", () => {
  test("resolverPerfilAlvo: perfil de outra conta -> 404 (não vaza)", () => {
    const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("async function resolverPerfilAlvo"), PLAT_USUARIOS.indexOf("async function resolverPerfilAlvo") + 700);
    assert.match(fn, /data\.conta_id !== contaId\) throw ApiError\.notFound/);
  });
  test("H1 — as funções de vínculo escopam SEMPRE por perfil_id (o perfil inicial também)", () => {
    for (const nome of ["atualizarVinculo", "removerVinculo", "associarUnidade", "atualizarVinculoUnidade", "removerVinculoUnidade"]) {
      const i = PLAT_USUARIOS.indexOf(`export async function ${nome}`);
      const fn = PLAT_USUARIOS.slice(i, i + 1600);
      assert.match(fn, /resolverPerfilAlvo\(/, `${nome} não resolve o perfil-alvo`);
      assert.match(fn, /rodarEscopadoPorPerfil\(perfilAlvo/, `${nome} não roda escopado por perfil`);
      // a sentinela antiga ("perfil inicial => não escopar") não pode mais existir
      assert.doesNotMatch(fn, /perfilAlvo !== usuarioId/, `${nome} ainda tem a sentinela perfilAlvo !== usuarioId`);
    }
    // o helper garante o fallback pré-060 (sem a coluna) e nada mais
    assert.match(PLAT_USUARIOS, /async function rodarEscopadoPorPerfil\(perfilAlvo, montar\)/);
    assert.match(PLAT_USUARIOS, /montar\(\(q\) => q\.eq\("perfil_id", perfilAlvo\)\)/);
    assert.match(PLAT_USUARIOS, /RE_PERFIL_ID_AUSENTE\.test\(r\.error\.message[\s\S]{0,60}montar\(\(q\) => q\)/);
  });
});

// ===========================================================================
describe("criarPerfilNaConta — fluxo transacional (testes 1/6/7/8/22 + caso real 34)", () => {
  const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function criarPerfilNaConta"), PLAT_USUARIOS.indexOf("export async function renomearPerfil"));

  test("22/1) NÃO cria auth.users nem e-mail — é linha em perfis_operacionais da MESMA conta", () => {
    assert.doesNotMatch(fn, /auth\.admin\.createUser|createUser|email_confirm/);
    assert.match(fn, /criarPerfilOperacional\(\{ contaId, nome, ativo \}\)/);
  });

  test("6) PIN do novo perfil é OBRIGATÓRIO (validarFormatoPin antes de tudo)", () => {
    assert.match(fn, /const pinNovo = validarFormatoPin\(body\?\.pin\)/);
  });

  test("7) se um perfil existente não tem PIN e não veio no corpo -> 409 PIN_PENDENTE_PERFIS_EXISTENTES", () => {
    assert.match(fn, /PIN_PENDENTE_PERFIS_EXISTENTES/);
    assert.match(fn, /perfis: semPin\.map/);
    assert.match(fn, /pinsPerfisExistentes/); // aceita configurar tudo no mesmo request
  });

  test("8) grava o PIN do novo E dos existentes pendentes -> ambos com PIN ao final", () => {
    assert.match(fn, /definirPinDoPerfil\(\{ contaId, perfilId: perfil\.id, pin: pinNovo/);
    assert.match(fn, /for \(const \[pid, pin\] of pinsPendentes\)[\s\S]{0,120}definirPinDoPerfil\(\{ contaId, perfilId: pid, pin/);
  });

  test("3) compensação: qualquer falha em 3/4 apaga o perfil novo (CASCADE nos vínculos)", () => {
    assert.match(fn, /catch \(erro\) \{[\s\S]{0,200}perfis_operacionais"\)\.delete\(\)\.eq\("id", perfil\.id\)/);
    assert.match(fn, /throw erro;/);
  });

  test("14) vínculos gravam perfil_id do NOVO perfil, nunca só usuario_id", () => {
    assert.match(fn, /inserirVinculoOrgComPerfil\(\{ usuarioId: contaId, perfilId: perfil\.id/);
    assert.match(fn, /inserirVinculoUnidadeComPerfil\(\{ usuarioId: contaId, perfilId: perfil\.id/);
  });

  test("PIN do novo perfil não revoga sessões (o perfil ainda não tem nenhuma)", () => {
    assert.match(fn, /pin: pinNovo, motivo: "pin_definido", revogarSessoesDoPerfil: false/);
  });

  test("24) auditoria do perfil criado — sem PIN, com o perfil afetado", () => {
    assert.match(fn, /acao: ACOES\.PERFIL_CRIADO/);
    assert.doesNotMatch(fn, /detalhes:\s*\{[^}]*\bpin\b/i);
  });

  test("valida orgs ANTES de escrever (fail fast)", () => {
    assert.ok(fn.indexOf("Uma das empresas informadas não existe") < fn.indexOf("criarPerfilOperacional"), "validação de org vem antes da criação");
  });
});

// ===========================================================================
describe("MIGRATION GATE (063) — dois perfis da mesma conta na mesma org (testes 12/35)", () => {
  test("063 troca UNIQUE(usuario_id, org) por UNIQUE(perfil_id, org)", () => {
    assert.match(MIG_063, /drop constraint if exists usuarios_organizacoes_usuario_id_organizacao_id_key/);
    assert.match(MIG_063, /add constraint uo_perfil_org_unico unique \(perfil_id, organizacao_id\)/);
  });
  test("063 idem para usuarios_unidades", () => {
    assert.match(MIG_063, /drop constraint if exists usuarios_unidades_usuario_id_unidade_id_key/);
    assert.match(MIG_063, /add constraint uu_perfil_uni_unico unique \(perfil_id, unidade_id\)/);
  });
  test("063 mantém usuario_id (LEGACY) — não o remove", () => {
    assert.doesNotMatch(MIG_063, /drop column .*usuario_id/i);
    assert.match(MIG_063, /usuario_id = LEGACY/);
  });
  test("063 é pré-requisito declarado da Fase G", () => {
    assert.match(MIG_063, /Pré-requisito para a Fase G/);
  });
  test("o backend usa a UNIQUE canônica (perfil_id,X) e NÃO sobrescreve perfil irmão pré-063", () => {
    assert.match(PERFIL_SVC, /RE_ONCONFLICT_AUSENTE = /);
    assert.match(PERFIL_SVC, /const onConflict = `perfil_id,\$\{alvoCol\}`/); // 063
    // pré-063: em vez de upsert(usuario_id,X) — que apagaria o vínculo do irmão —
    // busca (perfil_id,X) e faz UPDATE se existir, senão INSERT (a UNIQUE legada
    // recusa 2 perfis no mesmo alvo -> erro de negócio, sensível a empresa/unidade).
    assert.match(PERFIL_SVC, /VINCULO_PERFIL_IRMAO_MESMO_ALVO/);
    assert.match(PERFIL_SVC, /outro perfil associado a esta unidade/);
    assert.match(PERFIL_SVC, /outro perfil associado a esta empresa/);
    assert.doesNotMatch(PERFIL_SVC, /aplique a migration 063/); // nunca em msg de usuário
    // O fallback pré-060 NUNCA pode fazer upsert de um payload que contém
    // `perfil_id` chaveado por `onConflict: usuario_id,X` — isso sobrescreveria
    // o vínculo de um perfil IRMÃO. (Regex ancorada nos DOIS args do upsert —
    // objeto-payload com perfil_id, depois `{ onConflict: usuario_id... }` —
    // sem `.*` varrendo o arquivo.) O fallback correto faz `upsert(base, …)`,
    // e `base` não tem perfil_id.
    assert.doesNotMatch(PERFIL_SVC, /upsert\(\s*\{[^{}]*perfil_id[^{}]*\}\s*,\s*\{[^{}]*onConflict:\s*`usuario_id/);
  });
  test("M2/B8 — INSERT puro que colide vira erro de negócio, nunca 500", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("async function gravarVinculo"), PERFIL_SVC.indexOf("export async function inserirVinculoOrgComPerfil"));
    assert.match(fn, /!upsert && RE_DUPLICATA\.test/);
    assert.match(fn, /VINCULO_JA_EXISTE/);            // mesmo perfil já vinculado
    assert.match(fn, /VINCULO_PERFIL_IRMAO_MESMO_ALVO/); // perfil irmão ocupa o alvo
  });
  test("colNula removido — gravarVinculo não tem mais o parâmetro nem o if redundante", () => {
    assert.doesNotMatch(PERFIL_SVC, /colNula/);
    assert.doesNotMatch(PERFIL_SVC, /inserirVinculoUnidadeComPerfil[\s\S]{0,220}colNula/);
  });
});

// ===========================================================================
describe("endpoints (teste 28) + compat (21)", () => {
  test("rotas de perfis da conta existem sob /usuarios/:id/perfis", () => {
    assert.match(PLAT_ROUTES, /get\("\/usuarios\/:id\/perfis", c\.perfisDaConta\)/);
    assert.match(PLAT_ROUTES, /post\("\/usuarios\/:id\/perfis", c\.criarPerfil\)/);
    assert.match(PLAT_ROUTES, /patch\("\/usuarios\/:id\/perfis\/:perfilId", c\.renomearPerfil\)/);
    assert.match(PLAT_ROUTES, /patch\("\/usuarios\/:id\/perfis\/:perfilId\/ativo", c\.alternarAtivoPerfil\)/);
  });

  test("21) conta com 1 perfil: vínculo sem perfilId continua no fluxo antigo (garantirPerfilOperacionalInicial)", () => {
    const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function associarEmpresa"), PLAT_USUARIOS.indexOf("export async function associarEmpresa") + 1400);
    assert.match(fn, /body\.perfilId && String\(body\.perfilId\) !== String\(usuarioId\)[\s\S]{0,120}garantirPerfilOperacionalInicial/);
  });

  test("31) renomear perfil NÃO toca e-mail/senha da conta", () => {
    const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function renomearPerfil"), PLAT_USUARIOS.indexOf("export async function alternarAtivoPerfil"));
    assert.match(fn, /\.update\(\{ nome \}\)/);
    assert.doesNotMatch(fn, /\.from\("perfis"\)|auth\.admin|password|\.update\([^)]*email/i); // só toca perfis_operacionais.nome
  });

  test("23) pin_hash NUNCA é retornado por perfisDaConta", () => {
    const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function perfisDaConta"), PLAT_USUARIOS.indexOf("export async function criarPerfilNaConta"));
    assert.match(fn, /temPin: !!p\.pin_hash/);
    assert.doesNotMatch(fn, /pin_hash: p\.pin_hash|pinHash/);
  });
});

// ===========================================================================
describe("auditoria (teste 32) — ações de perfil registradas", () => {
  test("ACOES tem PERFIL_CRIADO / EDITADO / ATIVADO / DESATIVADO", () => {
    const AUD = src("../src/shared/auditoria.js");
    for (const a of ["PERFIL_CRIADO", "PERFIL_EDITADO", "PERFIL_ATIVADO", "PERFIL_DESATIVADO"]) {
      assert.match(AUD, new RegExp(`${a}:`));
    }
  });
  test("nenhuma auditoria de perfil grava PIN/hash", () => {
    const trecho = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("FASE G"), PLAT_USUARIOS.indexOf("export async function definirPinPerfil"));
    const audits = trecho.match(/auditar\(\{[\s\S]*?\}\);/g) ?? [];
    for (const a of audits) assert.ok(!/\bpin\b|pin_hash|hash/i.test(a), `auditoria vaza PIN:\n${a}`);
  });
});
