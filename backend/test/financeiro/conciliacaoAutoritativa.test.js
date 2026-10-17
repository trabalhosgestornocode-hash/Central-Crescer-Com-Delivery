// M1 (LD-011/LD-012): contrato JS da conciliação AUTORITATIVA no banco. A prova da regra em si está em SQL (parity_m1.mjs, adversarial122*.sql, 20_periodos_conciliacao.test.sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import { falha, MENSAGENS } from "../../src/modules/gestao-financeira/dominio/repositorio.util.js";

test("divergência de conciliação apontada pelo banco vira 409 FIN_CONCILIACAO_DIVERGENTE (recarregar), sem vazar o texto interno", () => {
  let erro;
  try { falha({ code: "23514", message: "fin_conciliacao_divergente: a lista de pendencias de conciliacao informada difere da calculada pelo banco (informada=0, banco=1)" }); } catch (e) { erro = e; }
  assert.ok(erro, "deveria lançar");
  assert.equal(erro.status ?? erro.statusCode, 409);
  assert.equal(erro.details?.codigo, "FIN_CONCILIACAO_DIVERGENTE");
  assert.equal(erro.message, MENSAGENS.FIN_CONCILIACAO_DIVERGENTE);
  assert.ok(!/informada=|banco=/.test(erro.message), "mensagem amigável não expõe contagens internas");
});

test("fechamento: o serviço entrega ao banco os ids de conciliação que ELE calculou (só conferência) e aceita a recusa do banco", async () => {
  const { criarRepoMemoria } = await import("./helpers/repoMemoria.js");
  const per = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");
  const repo = criarRepoMemoria();
  const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000006" };
  let recebido;
  repo.fecharPeriodoRpc = async (_c, args) => { recebido = args; return falha({ code: "23514", message: "fin_conciliacao_divergente: x" }); };
  const pre = await per.preFechamento(ctx, "2026-08", { repo, db: undefined });
  await assert.rejects(
    () => per.fechar(ctx, "2026-08", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint }, { repo, db: undefined }),
    (e) => (e.status ?? e.statusCode) === 409 && e.details?.codigo === "FIN_CONCILIACAO_DIVERGENTE",
  );
  assert.ok(Array.isArray(recebido.pendenciasConciliacaoIds), "ids calculados pela aplicação seguem como conferência");
});
