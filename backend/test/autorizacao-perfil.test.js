// Fase E — autorização, vínculos e permissões POR PERFIL.
//
// Unit/estático, SEM banco (060/063 não aplicadas). Cobre:
//   * filtrosDeRevogacao (escopos AND — cenários 45 A-H);
//   * guarda de auto-rebaixamento por PERFIL (tenant) — cenário 24/28;
//   * scans: selecionarContexto autoriza por perfil_id (nunca usuario_id);
//     vínculo-edit/remove revoga por { perfilId, org|unidade } (Model Y);
//     criação de vínculo grava perfil_id + garante perfis_operacionais.
//
// O núcleo do ISOLAMENTO entre perfis irmãos (Fulana 1 vs Fulana 2, mesma
// conta) já está provado em sessao-perfil.test.js via listarAcessosDoPerfil
// (deps-injetável). Aqui são os pontos que a Fase E adiciona.
//
// Rodar: node --env-file-if-exists=.env --test test/autorizacao-perfil.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { filtrosDeRevogacao } from "../src/modules/sessao/sessao.service.js";
import { atualizarUsuario, excluirUsuario } from "../src/modules/usuarios/usuarios.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SESSAO = src("../src/modules/sessao/sessao.service.js");
const PLAT_USUARIOS = src("../src/modules/plataforma/plataforma.usuarios.service.js");
const TENANT_USUARIOS = src("../src/modules/usuarios/usuarios.service.js");
const PERFIL_SVC = src("../src/modules/sessao/perfil.service.js");

const U = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const UNI = "44444444-4444-4444-8444-444444444444";
const SID = "55555555-5555-4555-8555-555555555555";

async function esperaErro(fn, status) {
  try { await fn(); assert.fail("esperava ApiError"); }
  catch (e) { assert.ok(e instanceof ApiError, `veio ${e}`); if (status) assert.equal(e.statusCode, status); return e; }
}

// ---------------------------------------------------------------------------
describe("filtrosDeRevogacao — escopos AND (cenário 45)", () => {
  test("A) { perfilId, organizacaoId } -> AND das duas colunas", () => {
    assert.deepEqual(filtrosDeRevogacao({ perfilId: P2, organizacaoId: ORG }),
      [["perfil_id", P2], ["organizacao_id", ORG]]);
  });
  test("B) { perfilId, unidadeId } -> AND", () => {
    assert.deepEqual(filtrosDeRevogacao({ perfilId: P2, unidadeId: UNI }),
      [["perfil_id", P2], ["unidade_id", UNI]]);
  });
  test("C) { organizacaoId } sozinho -> só a org (evento organizacional)", () => {
    assert.deepEqual(filtrosDeRevogacao({ organizacaoId: ORG }), [["organizacao_id", ORG]]);
  });
  test("D) { perfilId } sozinho -> todas do perfil", () => {
    assert.deepEqual(filtrosDeRevogacao({ perfilId: P2 }), [["perfil_id", P2]]);
  });
  test("E) { contaId } (e alias usuarioId) -> coluna usuario_id", () => {
    assert.deepEqual(filtrosDeRevogacao({ contaId: U }), [["usuario_id", U]]);
    assert.deepEqual(filtrosDeRevogacao({ usuarioId: U }), [["usuario_id", U]]);
  });
  test("F) { sessionId } -> id", () => {
    assert.deepEqual(filtrosDeRevogacao({ sessionId: SID }), [["id", SID]]);
  });
  test("G) sem escopo -> LANÇA (nunca revoga tudo)", () => {
    assert.throws(() => filtrosDeRevogacao({}), (e) => e instanceof ApiError);
    assert.throws(() => filtrosDeRevogacao(), (e) => e instanceof ApiError);
    assert.throws(() => filtrosDeRevogacao({ motivo: "x" }), (e) => e instanceof ApiError);
  });
  test("H) combinação de 3 -> AND de todas, ordem estável", () => {
    assert.deepEqual(
      filtrosDeRevogacao({ perfilId: P2, organizacaoId: ORG, sessionId: SID }),
      [["id", SID], ["perfil_id", P2], ["usuario_id", undefined]].filter(([, v]) => v !== undefined).concat([["organizacao_id", ORG]]),
    );
    // forma direta:
    assert.deepEqual(filtrosDeRevogacao({ sessionId: SID, perfilId: P2, organizacaoId: ORG }),
      [["id", SID], ["perfil_id", P2], ["organizacao_id", ORG]]);
  });
});

// ---------------------------------------------------------------------------
describe("guarda de auto-rebaixamento — por PERFIL (tenant — cenário 24/28)", () => {
  test("editar o PRÓPRIO acesso (perfil == solicitante) -> 400", async () => {
    await esperaErro(() => atualizarUsuario({
      organizacaoId: ORG, id: U, papel: "viewer",
      solicitanteId: U, solicitantePerfilId: U,
    }), 400);
  });

  test("remover o PRÓPRIO acesso -> 400", async () => {
    await esperaErro(() => excluirUsuario({
      organizacaoId: ORG, id: U, solicitanteId: U, solicitantePerfilId: U,
    }), 400);
  });

  test("a guarda usa solicitantePerfilId (não só a conta)", () => {
    assert.match(TENANT_USUARIOS, /const solicitante = solicitantePerfilId \?\? solicitanteId/);
    assert.match(TENANT_USUARIOS, /usuarioId === \(solicitantePerfilId \?\? solicitanteId\)/); // excluirUsuario
  });

  test("controller passa req.perfil.id como solicitantePerfilId", () => {
    const CTRL = src("../src/modules/usuarios/usuarios.controller.js");
    assert.match(CTRL, /solicitantePerfilId:\s*req\.perfil\?\.id/);
  });
});

// ---------------------------------------------------------------------------
describe("selecionarContexto — autoriza SÓ por perfil_id (cenários 3-13, 32-34)", () => {
  const body = SESSAO.slice(SESSAO.indexOf("export async function selecionarContexto"), SESSAO.indexOf("export async function trocarUnidadeDoContexto"));

  test("resolve/valida o perfil ANTES de qualquer vínculo", () => {
    assert.match(body, /const perfil = await resolver\(\{ contaId: usuario\.id, perfilId, provaSelecao \}\)/);
  });
  test("vínculo de EMPRESA: buscarVinculoOrgDoPerfil({ perfilId: perfil.id, ... })", () => {
    assert.match(body, /buscarVinculoOrg\(\{ perfilId: perfil\.id, organizacaoId: orgId \}\)/);
  });
  test("vínculo de UNIDADE: checarUnidade({ perfilId: perfil.id, ... })", () => {
    assert.match(body, /checarUnidade\(\{ perfilId: perfil\.id, unidadeId: uniId/);
  });
  test("NUNCA autoriza por usuario_id / conta", () => {
    assert.doesNotMatch(body, /\.eq\("usuario_id",\s*usuario\.id\)/);
    assert.doesNotMatch(body, /usuarios_organizacoes[\s\S]{0,120}usuario_id/);
  });
  test("papel/permissoes/modulos derivam do vínculo do perfil resolvido", () => {
    assert.match(body, /const permissoes = permissoesDoPapel\(papel\)/);
    assert.match(body, /perfilId: perfil\.id/); // criarSessao + auditar
  });

  test("buscarVinculoOrgDoPerfil e buscarVinculoDiretoDaUnidade filtram por perfil_id", () => {
    assert.match(SESSAO, /buscarVinculoOrgDoPerfil\(\{ perfilId, organizacaoId \}\)[\s\S]{0,200}\.eq\("perfil_id", perfilId\)/);
    assert.match(SESSAO, /buscarVinculoDiretoDaUnidade\(\{ perfilId, unidadeId \}\)[\s\S]{0,200}\.eq\("perfil_id", perfilId\)/);
  });
});

// ---------------------------------------------------------------------------
describe("edição/remoção de vínculo — revogação por { perfilId, org|unidade } (Model Y — cenários 13-15, 17-19, 35)", () => {
  test("plataforma: atualizarVinculo revoga { perfilId, organizacaoId } (não { usuarioId })", () => {
    const f = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function atualizarVinculo"), PLAT_USUARIOS.indexOf("export async function removerVinculo"));
    assert.match(f, /revogar\(\{\s*perfilId: data\.perfil_id \?\? perfilAlvo, organizacaoId/s);
    assert.doesNotMatch(f, /revogar\w*\(\{\s*usuarioId, organizacaoId/);
  });
  test("plataforma: removerVinculo pega perfil_id ANTES de apagar e revoga { perfilId, org }", () => {
    const f = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function removerVinculo"), PLAT_USUARIOS.indexOf("export async function associarUnidade"));
    assert.match(f, /const perfilId = vinculo\?\.perfil_id \?\? perfilAlvo/);
    assert.match(f, /revogar\(\{ perfilId, organizacaoId/);
  });
  test("plataforma: atualizarVinculoUnidade / removerVinculoUnidade -> { perfilId, unidadeId }", () => {
    assert.match(PLAT_USUARIOS, /revogar\(\{\s*perfilId: data\.perfil_id \?\? perfilAlvo, unidadeId/s);
    assert.match(PLAT_USUARIOS, /revogar\(\{ perfilId, unidadeId, motivo: "vinculo_unidade_removido"/);
  });
  test("tenant: atualizarUsuario / excluirUsuario -> { perfilId, organizacaoId } (L2/H1)", () => {
    // UPDATE/DELETE pela PK da linha resolvida, nunca por (usuario_id, org)
    assert.match(TENANT_USUARIOS, /resolverVinculoUnicoDaEmpresa\(db, usuarioId, organizacaoId\)/);
    assert.match(TENANT_USUARIOS, /\.update\(patch\)\.eq\("id", alvo\.id\)/);
    assert.match(TENANT_USUARIOS, /\.delete\(\)\.eq\("id", alvo\.id\)/);
    assert.doesNotMatch(TENANT_USUARIOS, /\.delete\(\)\.eq\("usuario_id", usuarioId\)\.eq\("organizacao_id"/);
    // 2+ perfis na mesma empresa -> recusa, nenhuma escrita
    assert.match(TENANT_USUARIOS, /VINCULO_AMBIGUO_MULTIPERFIL/);
    assert.match(TENANT_USUARIOS, /linhas\.length > 1/);
    // sessões: só do perfil da linha resolvida
    assert.match(TENANT_USUARIOS, /perfilId: data\.perfil_id \?\? alvo\.perfil_id \?\? usuarioId, organizacaoId/);
    assert.match(TENANT_USUARIOS, /revogar\(\{ perfilId, organizacaoId, motivo: "acesso_removido"/);
  });
  test("NENHUMA revogação de vínculo usa mais o escopo de CONTA { usuarioId } / { contaId }", () => {
    for (const F of [PLAT_USUARIOS, TENANT_USUARIOS]) {
      const trechos = F.match(/(?:revogarSessoes|revogar)\(\{[^}]*\}/g) ?? [];
      for (const t of trechos) {
        if (/vinculo|acesso_removido|papel_alterado|acesso_bloqueado/.test(t)) {
          assert.ok(!/usuarioId[,\s}]/.test(t) || /perfilId/.test(t), `revogação de vínculo por conta: ${t}`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("eventos ORGANIZACIONAIS mantêm escopo amplo (cenários 16, 21, 36)", () => {
  test("mudança de módulo/status da empresa -> revogarSessoes({ organizacaoId }) (todos os perfis)", () => {
    const EMP = src("../src/modules/plataforma/plataforma.empresas.service.js");
    assert.match(EMP, /revogarSessoes\(\{ organizacaoId: id, motivo: `empresa_/);
    assert.match(EMP, /revogarSessoes\(\{ organizacaoId: id, motivo: "modulos_alterados"/);
  });
  test("mudança de módulo/status da unidade -> revogarSessoes({ unidadeId }) (todos os perfis)", () => {
    const UNID = src("../src/modules/plataforma/plataforma.unidades.service.js");
    assert.match(UNID, /revogarSessoes\(\{ unidadeId: id/);
  });
  test("desativar conta / redefinir senha / forçar logout -> escopo de CONTA (amplo, correto)", () => {
    assert.match(PLAT_USUARIOS, /revogarSessoes\(\{ usuarioId: id, motivo: "usuario_desativado"/);
    assert.match(PLAT_USUARIOS, /revogarSessoes\(\{ usuarioId: id, motivo: "senha_redefinida"/);
    assert.match(PLAT_USUARIOS, /revogarSessoes\(\{ usuarioId: id, motivo: "logout_forcado"/);
  });
});

// ---------------------------------------------------------------------------
describe("criação de vínculo — grava perfil_id + garante perfis_operacionais (cenário 16, 30)", () => {
  test("perfil.service exporta os helpers de vínculo com perfil", () => {
    for (const fn of ["garantirPerfilOperacionalInicial", "inserirVinculoOrgComPerfil", "inserirVinculoUnidadeComPerfil"]) {
      assert.match(PERFIL_SVC, new RegExp(`export async function ${fn}`));
    }
  });
  test("helper de vínculo grava perfil_id e degrada sem ele (pré-060) + onConflict canônico (pré-063)", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("async function gravarVinculo"), PERFIL_SVC.indexOf("export async function inserirVinculoOrgComPerfil"));
    assert.match(fn, /\.\.\.base, perfil_id: perfilId/);
    assert.match(fn, /const onConflict = `perfil_id,\$\{alvoCol\}`/); // canônico (063)
    // pré-063: NÃO degrada para upsert(usuario_id,X) — busca (perfil_id,X) e UPDATE/INSERT
    assert.match(fn, /\.eq\("perfil_id", perfilId\)\.eq\(alvoCol, alvoId\)/);
    assert.match(fn, /VINCULO_PERFIL_IRMAO_MESMO_ALVO/);
    // pré-060: sem a coluna
    assert.match(fn, /RE_COLUNA_AUSENTE\.test\(error\.message[\s\S]{0,120}usuario_id,\$\{alvoCol\}/);
  });
  test("garantirPerfilOperacionalInicial: id == conta_id (UUID reaproveitado), idempotente", () => {
    assert.match(PERFIL_SVC, /id: cId, conta_id: cId/);
    assert.match(PERFIL_SVC, /duplicate key|already exists|23505/);
  });
  test("tenant criarUsuario: garante perfil ANTES do vínculo (FK)", () => {
    const f = TENANT_USUARIOS.slice(TENANT_USUARIOS.indexOf("export async function criarUsuario"), TENANT_USUARIOS.indexOf("export async function atualizarUsuario"));
    assert.ok(f.indexOf("garantirPerfilOperacionalInicial") < f.indexOf("inserirVinculoOrg"), "perfil antes do vínculo");
  });
  test("plataforma criarUsuario / associarEmpresa: idem", () => {
    assert.match(PLAT_USUARIOS, /garantirPerfilOperacionalInicial\(\{ contaId: usuarioId/);
    assert.match(PLAT_USUARIOS, /inserirVinculoOrgComPerfil\(\{ usuarioId, perfilId/);
  });
  test("obterUsuario expõe perfilId por sessão (dados p/ 'online por perfil' — Fase I/G)", () => {
    assert.match(PLAT_USUARIOS, /perfil_id, organizacao_id, papel/);
    assert.match(PLAT_USUARIOS, /perfilId: s\.perfil_id \?\? null/);
  });
});

// ---------------------------------------------------------------------------
describe("janela de transição pré-060 — autorização degrada para usuario_id (cenário N — backward compat)", () => {
  test("sessao.service: RE_PERFIL_ID_AUSENTE + fallback usuario_id nas buscas de vínculo", () => {
    assert.match(SESSAO, /const RE_PERFIL_ID_AUSENTE = /);
    assert.match(SESSAO, /colunaPerfilAusente\(vinculosOrgRes\.error\)[\s\S]{0,160}\.eq\("usuario_id", contaId\)/);
    assert.match(SESSAO, /colunaPerfilAusente\(error\)[\s\S]{0,200}\.eq\("usuario_id", perfilId\)/); // org do perfil
  });
  test("sessao.service: criarSessao abre a sessão sem perfil_id se a coluna não existe", () => {
    assert.match(SESSAO, /if \(colunaPerfilAusente\(error\)\) \(\{ data: linha, error \} = await abrir\(base\)\)/);
  });
  test("sessao.service: revogarSessoes remapeia perfil_id -> usuario_id pré-060", () => {
    assert.match(SESSAO, /coluna === "perfil_id" \? "usuario_id" : coluna/);
    assert.match(SESSAO, /colunaPerfilAusente\(error\) && filtros\.some\(\(\[c\]\) => c === "perfil_id"\)/);
  });
  test("auth.js: requireContexto relê sem perfil_id e PULA a regra do pid pré-060", () => {
    const AUTH = src("../src/middlewares/auth.js");
    assert.match(AUTH, /let semColunaPerfil = false/);
    assert.match(AUTH, /semColunaPerfil = true/);
    assert.match(AUTH, /if \(!semColunaPerfil\) \{[\s\S]{0,200}validarPidContraSessao/);
  });
  test("perfil.service: resolverPerfilParaContexto trata a conta como seu próprio perfil pré-060", () => {
    // pré-060: buscarPerfisAtivosDaConta lança RE_COLUNA_AUSENTE -> conta = seu próprio perfil
    assert.match(PERFIL_SVC, /if \(!RE_COLUNA_AUSENTE\.test\(e\?\.message \|\| ""\)\) throw e;/);
    assert.match(PERFIL_SVC, /return \{ id: cId, nome: null, selecaoNonce: null \}/);
    assert.match(PERFIL_SVC, /String\(perfilId\) !== cId[\s\S]{0,80}Perfil não encontrado/);
  });
});

// ---------------------------------------------------------------------------
describe("permissoes.js — inalterado (Fase A confirmou)", () => {
  test("permissoesDoPapel continua sendo a fonte, sem merge entre perfis", async () => {
    const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
    const viewer = permissoesDoPapel("viewer");
    const admin = permissoesDoPapel("organization_admin");
    // viewer NÃO recebe nada de admin
    assert.ok(!viewer.includes("usuarios.gerenciar"));
    assert.ok(admin.includes("usuarios.gerenciar"));
    // a função é 1:1 papel->permissões, nunca "o maior papel da conta"
    assert.deepEqual(permissoesDoPapel("viewer"), viewer);
  });
});
