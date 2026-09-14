// Grants efêmeros de canal Realtime (backend/src/modules/realtime/realtime.grants.service.js).
//
// Usa um banco FAKE em memória (a tabela public.realtime_channel_grants
// ainda não existe em produção — migration 080 pendente de aprovação; ver a
// entrega da validação). O fake espelha só o suficiente do PostgREST/
// supabase-js (from().upsert()/.delete().eq()/.in()/.not()) pra exercitar a
// lógica real do service.
//
// Cobertura pedida explicitamente na aprovação: duas abas/contextos da MESMA
// conta nunca se destroem; troca de unidade numa aba não afeta a outra;
// logout local (revogação de UMA sessão) não revoga sessões irmãs.
//
// Rodar: node --test test/realtime-grants-service.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { renovarGrantsRealtime, removerGrantsDeSessoes } from "../src/modules/realtime/realtime.grants.service.js";

function criarDbFake() {
  let linhas = [];
  function from(_tabela) {
    return {
      upsert(novasLinhas) {
        for (const nova of novasLinhas) {
          const i = linhas.findIndex((l) => l.sessao_contexto_id === nova.sessao_contexto_id && l.topico === nova.topico);
          if (i > -1) linhas[i] = { ...linhas[i], ...nova };
          else linhas.push({ ...nova });
        }
        return Promise.resolve({ error: null });
      },
      delete() {
        let filtroSessao = null;
        let filtroInSessoes = null;
        let manterTopicos = null;
        const del = {
          eq(col, val) { if (col === "sessao_contexto_id") filtroSessao = val; return del; },
          in(col, vals) { if (col === "sessao_contexto_id") filtroInSessoes = vals; return del; },
          not(col, _op, val) {
            if (col === "topico") manterTopicos = val.slice(1, -1).split(",").filter(Boolean);
            return del;
          },
          then(resolve) {
            linhas = linhas.filter((l) => {
              if (filtroSessao != null && l.sessao_contexto_id !== filtroSessao) return true;
              if (filtroInSessoes != null && !filtroInSessoes.includes(l.sessao_contexto_id)) return true;
              if (manterTopicos != null && manterTopicos.includes(l.topico)) return true;
              return false;
            });
            resolve({ error: null });
          },
        };
        return del;
      },
    };
  }
  return { db: { from }, linhas: () => linhas.map((l) => ({ ...l })) };
}

describe("renovarGrantsRealtime — caminho feliz", () => {
  test("cria um grant por tópico autorizado (unidade + empresa)", async () => {
    const { db, linhas } = criarDbFake();
    const r = await renovarGrantsRealtime(
      { usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: "uni-1" },
      { db },
    );
    assert.deepEqual(r.topicos.sort(), ["empresa:org-1", "unidade:uni-1"]);
    const grava = linhas().map((l) => l.topico).sort();
    assert.deepEqual(grava, ["empresa:org-1", "unidade:uni-1"]);
    assert.ok(linhas().every((l) => l.sessao_contexto_id === "sid-A" && l.usuario_id === "u1"));
  });

  test("'Todas as unidades' (unidadeId nulo) grava só o grant de empresa", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: null }, { db });
    assert.deepEqual(linhas().map((l) => l.topico), ["empresa:org-1"]);
  });

  test("renovar a MESMA sessão de novo estende o grant (upsert), não duplica linha", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: "uni-1" }, { db });
    const antes = linhas().find((l) => l.topico === "unidade:uni-1").expira_em;
    await new Promise((r) => setTimeout(r, 5));
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: "uni-1" }, { db });
    const depois = linhas().filter((l) => l.topico === "unidade:uni-1");
    assert.equal(depois.length, 1, "não deve duplicar linha pro mesmo (sessao, tópico)");
    assert.ok(new Date(depois[0].expira_em).getTime() >= new Date(antes).getTime(), "a expiração deve avançar, nunca voltar");
  });
});

describe("isolamento entre abas/contextos simultâneos da MESMA conta (aprovação item 7)", () => {
  test("contexto A e contexto B (mesma conta, empresas diferentes): renovar A nunca apaga o grant de B", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-X", unidadeId: null }, { db });
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-B", organizacaoId: "org-Y", unidadeId: null }, { db });

    // Renova A de novo (ex.: o RealtimeManager da aba A rodando seu timer).
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-X", unidadeId: null }, { db });

    const topicosB = linhas().filter((l) => l.sessao_contexto_id === "sid-B").map((l) => l.topico);
    assert.deepEqual(topicosB, ["empresa:org-Y"], "o grant da aba B tem que continuar intacto");
  });

  test("MESMO tópico, duas sessões diferentes (2 abas na mesma empresa): cada uma tem sua própria linha", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: null }, { db });
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-B", organizacaoId: "org-1", unidadeId: null }, { db });

    const paraOTopico = linhas().filter((l) => l.topico === "empresa:org-1");
    assert.equal(paraOTopico.length, 2, "duas sessões, duas linhas — nunca colidem (PK é sessao_contexto_id+topico)");
  });

  test("troca de unidade na aba A (nova sessao_contexto_id) não afeta os grants da aba B, que continua na unidade 1", async () => {
    const { db, linhas } = criarDbFake();
    // Aba A entra na unidade 1 (sid-A1) e aba B também, na mesma unidade (sid-B).
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A1", organizacaoId: "org-1", unidadeId: "uni-1" }, { db });
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-B", organizacaoId: "org-1", unidadeId: "uni-1" }, { db });

    // Aba A troca para a unidade 2 — isso SEMPRE emite uma sessao_contexto_id
    // NOVA no backend real (ver sessao.service.js#criarSessao); a aba nunca
    // reaproveita sid-A1. A antiga (sid-A1) seria revogada por
    // removerGrantsDeSessoes, testado separadamente abaixo.
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A2", organizacaoId: "org-1", unidadeId: "uni-2" }, { db });

    const daB = linhas().filter((l) => l.sessao_contexto_id === "sid-B").map((l) => l.topico).sort();
    assert.deepEqual(daB, ["empresa:org-1", "unidade:uni-1"], "a aba B continua com os grants da unidade 1, intactos");
  });
});

describe("removerGrantsDeSessoes — revogação imediata (logout / troca de contexto)", () => {
  test("remove só os grants das sessões informadas", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A1", organizacaoId: "org-1", unidadeId: "uni-1" }, { db });
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A2", organizacaoId: "org-1", unidadeId: "uni-2" }, { db });

    await removerGrantsDeSessoes(["sid-A1"], { db });

    assert.deepEqual(linhas().filter((l) => l.sessao_contexto_id === "sid-A1"), []);
    assert.ok(linhas().some((l) => l.sessao_contexto_id === "sid-A2"), "a sessão não revogada continua com seus grants");
  });

  test("logout local (revogar 1 sessão) nunca remove os grants de uma sessão IRMÃ da MESMA conta", async () => {
    const { db, linhas } = criarDbFake();
    // Mesma conta (u1), duas abas: sid-A (vai deslogar) e sid-B (continua logada).
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1", unidadeId: null }, { db });
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-B", organizacaoId: "org-1", unidadeId: null }, { db });

    await removerGrantsDeSessoes(["sid-A"], { db }); // logout só da aba A

    const daB = linhas().filter((l) => l.sessao_contexto_id === "sid-B");
    assert.equal(daB.length, 1, "a sessão irmã (aba B, mesma conta) continua com seu grant — logout é local à sessão, não à conta");
  });

  test("lista vazia não toca o banco (no-op seguro)", async () => {
    const { db, linhas } = criarDbFake();
    await renovarGrantsRealtime({ usuarioId: "u1", sessaoContextoId: "sid-A", organizacaoId: "org-1" }, { db });
    await removerGrantsDeSessoes([], { db });
    assert.equal(linhas().length, 1, "nada deveria ter sido removido");
  });
});
