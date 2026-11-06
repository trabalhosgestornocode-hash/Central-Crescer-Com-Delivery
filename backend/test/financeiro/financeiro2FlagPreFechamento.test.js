// Feature flag × financeiro ANTERIOR: com o Financeiro 2.0 desligado para a empresa, o pré-fechamento NÃO chama a função da migration 151.
// Simula o pior caso de implantação: código publicado ANTES da migration (a função não existe e a chamada falharia).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local-nao-e-segredo";
process.env.SUPABASE_ANON_KEY = "teste-local-nao-e-segredo";
const { criarRepoMemoria } = await import("./helpers/repoMemoria.js");
const per = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CTX = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
function deps(financeiro2) {
  const repo = criarRepoMemoria();
  let chamadas = 0;
  repo.bloqueiosFechamentoRpc = async () => { chamadas += 1; throw Object.assign(new Error("function fin2_bloqueios_fechamento(uuid, uuid, date) does not exist"), { statusCode: 500 }); };
  return { d: { repo, db: undefined, financeiro2, agora: () => "2026-10-01T12:00:00.000Z" }, chamadas: () => chamadas };
}

test("flag DESLIGADO: pré-fechamento funciona mesmo sem a migration 151 (a função nem é chamada)", async () => {
  const x = deps(() => false);
  const r = await per.preFechamento(CTX, "2026-09", x.d);
  assert.equal(x.chamadas(), 0);
  assert.equal(r.mes, "2026-09");
  assert.ok(!r.avaliacao.bloqueios.some((b) => b.codigo === "DIVERGENCIAS_CONTAS_PAGAR"));
});

test("flag LIGADO: pré-fechamento consulta os bloqueios da 151 (e a falha aparece, não é engolida)", async () => {
  const x = deps(() => true);
  await assert.rejects(() => per.preFechamento(CTX, "2026-09", x.d), /does not exist/);
  assert.equal(x.chamadas(), 1);
});

test("sem injeção, vale a variável de ambiente (ausente = desligado)", async () => {
  delete process.env.FINANCEIRO_2_ORGANIZACOES;
  const x = deps(undefined);
  await per.preFechamento(CTX, "2026-09", x.d);
  assert.equal(x.chamadas(), 0);
});
