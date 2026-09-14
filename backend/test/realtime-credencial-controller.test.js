// Controller da credencial Realtime (POST /api/v1/realtime/credencial) —
// arquitetura final: JWT normal do Supabase Auth + grants efêmeros
// (Legacy JWT Secret / signing key customizada descartados, ver a decisão
// registrada em database/migrations/080_realtime_channel_grants.sql).
//
// O que este teste protege especificamente: os parâmetros do grant só podem
// vir de `req.tenant`/`req.acesso`/`req.user` (o que `requireContexto` já
// validou) — NUNCA de `req.body`/`req.query`. É essa disciplina que impede
// um cliente de "escolher" outro tenant/sessão só porque mandou algo
// diferente no corpo da requisição (Fase H da auditoria).
//
// Não testa aqui revogação/expiração de `sessoes_contexto` (responsabilidade
// do próprio `requireContexto`, montado antes desta rota — ver
// realtime-routes-wiring.test.js) nem a escrita em
// `realtime_channel_grants` (ver realtime-grants-service.test.js, que
// injeta um banco fake — a tabela ainda não existe em produção, a migration
// 080 está pendente de aprovação).
//
// Rodar: node --test test/realtime-credencial-controller.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parametrosGrantDoRequest, credencial } from "../src/modules/realtime/realtime.controller.js";

const REQ_BASE = () => ({
  user: { id: "usuario-conta-1" },
  tenant: { organizacaoId: "empresa-1", unidadeId: "unidade-1" },
  acesso: { sessionId: "sessao-1", perfilId: "perfil-1" },
  // Um cliente malicioso tentando fabricar outro tenant/sessão pelo
  // corpo/query — o controller NUNCA deve ler daqui.
  body: { organizacaoId: "empresa-invasora", unidadeId: "unidade-invasora", sessaoContextoId: "sessao-invasora" },
  query: { organizacaoId: "empresa-invasora-2" },
});

function fakeRes() {
  const res = { statusCode: 200, corpo: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (c) => { res.corpo = c; return res; };
  return res;
}

describe("parametrosGrantDoRequest — deriva só de req.tenant/acesso/user", () => {
  test("ignora completamente body e query, mesmo tentando forjar outro tenant", () => {
    const p = parametrosGrantDoRequest(REQ_BASE());
    assert.deepEqual(p, {
      usuarioId: "usuario-conta-1",
      sessaoContextoId: "sessao-1",
      organizacaoId: "empresa-1",
      unidadeId: "unidade-1",
    });
  });

  test("'Todas as unidades' (unidadeId nulo) é preservado, não confundido com ausente", () => {
    const req = REQ_BASE();
    req.tenant.unidadeId = null;
    assert.equal(parametrosGrantDoRequest(req).unidadeId, null);
  });

  test("perfil nulo (impersonação) — parâmetros do grant não dependem de perfilId (a policy não distingue por perfil, ver realtime.topicos.js)", () => {
    const req = REQ_BASE();
    req.acesso.perfilId = null;
    const p = parametrosGrantDoRequest(req);
    assert.equal(p.sessaoContextoId, "sessao-1", "a sessão continua sendo a identidade do grant, não o perfil");
  });
});

describe("realtime.controller#credencial — validação sem tocar banco", () => {
  test("sem req.tenant.organizacaoId (não deveria ser alcançável — requireContexto já teria barrado), recusa com 403 antes de qualquer escrita", async () => {
    const req = REQ_BASE();
    req.tenant = {};
    const res = fakeRes();
    let erro = null;
    await credencial(req, res, (e) => { erro = e; });
    assert.ok(erro, "asyncHandler deveria encaminhar o erro pro next()");
    assert.equal(erro.statusCode, 403);
    assert.equal(res.corpo, null, "nada deveria ter sido respondido");
  });
});
