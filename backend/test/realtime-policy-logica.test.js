// Espelho em JS da policy SQL "crescer_realtime_receber_broadcast_via_grant"
// + da função public.tem_grant_realtime() (database/migrations/080_realtime_channel_grants.sql).
//
// Esta migration JÁ FOI validada ponta a ponta contra um Supabase de teste
// real — ver backend/test/realtime-migration-080-e2e.test.js (subscribe de
// verdade, Broadcast real, Presence recusado, INSERT recusado, multi-aba,
// revogação). Este arquivo aqui é o complemento rápido/offline: prova a
// LÓGICA booleana isoladamente, sem rede — útil pra iterar na regra sem
// pagar o custo de uma conexão Realtime real a cada mudança. A autoridade
// de produção continua sendo a policy/função em si, nunca este JS. Se a
// regra SQL mudar, este espelho tem que mudar junto.
//
// Cobre os itens da aprovação: "grant expirado não autoriza subscribe",
// "tópico sem grant → acesso negado" e "grant de Broadcast não autoriza
// Presence".
//
// Rodar: node --test test/realtime-policy-logica.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Espelha exatamente:
 *   realtime.messages.extension = 'broadcast'
 *   and public.tem_grant_realtime(realtime.topic())
 * onde tem_grant_realtime() (SECURITY DEFINER) faz:
 *   select exists (
 *     select 1 from realtime_channel_grants g
 *     where g.usuario_id = auth.uid()
 *       and g.topico = p_topico
 *       and g.expira_em > now()
 *   )
 * (a função existe pra poder checar o grant sem dar SELECT direto na
 * tabela para `authenticated` — ver o comentário na migration).
 */
function autorizaReceberMensagem({ grants, usuarioId, topico, extensao, agora = new Date() }) {
  if (extensao !== "broadcast") return false;
  return grants.some((g) => g.usuario_id === usuarioId && g.topico === topico && new Date(g.expira_em) > agora);
}

const AGORA = new Date("2026-09-14T12:00:00Z");
const GRANT_VIVO = { usuario_id: "u1", topico: "unidade:uni-1", expira_em: "2026-09-14T12:03:00Z" };
const GRANT_EXPIRADO = { usuario_id: "u1", topico: "unidade:uni-2", expira_em: "2026-09-14T11:59:00Z" };
const GRANT_DE_OUTRO_USUARIO = { usuario_id: "u2", topico: "unidade:uni-1", expira_em: "2026-09-14T12:03:00Z" };

describe("policy (espelho) — grant vivo autoriza", () => {
  test("mesmo usuário, mesmo tópico, ainda não expirou: autoriza", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_VIVO], usuarioId: "u1", topico: "unidade:uni-1", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, true);
  });
});

describe("policy (espelho) — grant expirado NÃO autoriza", () => {
  test("mesmo usuário, mesmo tópico, mas expira_em já passou: recusa", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_EXPIRADO], usuarioId: "u1", topico: "unidade:uni-2", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, false);
  });

  test("expira_em igual a 'agora' (não estritamente >) também recusa — sem folga a favor do cliente", () => {
    const grant = { usuario_id: "u1", topico: "unidade:uni-3", expira_em: AGORA.toISOString() };
    const ok = autorizaReceberMensagem({ grants: [grant], usuarioId: "u1", topico: "unidade:uni-3", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, false);
  });
});

describe("policy (espelho) — tentativa manual de tópico sem grant é negada", () => {
  test("nenhum grant pra esse tópico: recusa, mesmo com grants de OUTROS tópicos vivos", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_VIVO], usuarioId: "u1", topico: "empresa:org-inexistente", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, false);
  });

  test("grant existe, mas é de OUTRO usuário — auth.uid() não bate: recusa (nunca vaza entre contas)", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_DE_OUTRO_USUARIO], usuarioId: "u1", topico: "unidade:uni-1", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, false);
  });

  test("lista de grants vazia: sempre recusa", () => {
    const ok = autorizaReceberMensagem({ grants: [], usuarioId: "u1", topico: "unidade:uni-1", extensao: "broadcast", agora: AGORA });
    assert.equal(ok, false);
  });
});

describe("policy (espelho) — Broadcast nunca autoriza Presence (extension restrito)", () => {
  test("mesmo grant vivo pro mesmo tópico: extension='presence' é recusado", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_VIVO], usuarioId: "u1", topico: "unidade:uni-1", extensao: "presence", agora: AGORA });
    assert.equal(ok, false, "um grant de Broadcast não pode autorizar Presence — a policy restringe extension='broadcast'");
  });

  test("extension='postgres_changes' também é recusado", () => {
    const ok = autorizaReceberMensagem({ grants: [GRANT_VIVO], usuarioId: "u1", topico: "unidade:uni-1", extensao: "postgres_changes", agora: AGORA });
    assert.equal(ok, false);
  });
});
