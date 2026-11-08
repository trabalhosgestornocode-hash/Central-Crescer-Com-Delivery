// Conciliação de UMA saída com 2–3 entradas (service): validações da aplicação, nada gravado em caso de erro, trilha de quem aprovou. Dados 100% SINTÉTICOS.
// As travas de verdade (soma exata, tenant, período, exclusividade, imutabilidade) são do banco e estão no ensaio-155.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lanc from "../../src/modules/gestao-financeira/dominio/lancamentos.service.js";
import { MENSAGENS } from "../../src/modules/gestao-financeira/dominio/repositorio.util.js";
import { sugerirTransferencias } from "../../src/financeiro-calculos/transferenciasInternas.js";

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
const L = { [U(10)]: { id: U(10), sentido: "saida", valor_centavos: 100000, conta_id: U(50) }, [U(11)]: { id: U(11), sentido: "entrada", valor_centavos: 60000, conta_id: U(51) },
  [U(12)]: { id: U(12), sentido: "entrada", valor_centavos: 25000, conta_id: U(51) }, [U(13)]: { id: U(13), sentido: "entrada", valor_centavos: 15000, conta_id: U(51) },
  [U(14)]: { id: U(14), sentido: "entrada", valor_centavos: 9000, conta_id: U(51) } };
function deps() {
  const chamadas = [];
  return { chamadas, repo: {
    obterLancamento: async (_c, id) => L[id] ?? null,
    vincularTransferenciaMultiplaRpc: async (c, saida, entradas, just) => { chamadas.push({ saida, entradas, just, usuario: c.usuarioId }); return U(900); },
    desvincularTransferenciaMultiplaRpc: async (_c, id, motivo) => { chamadas.push({ desfazer: id, motivo }); return id === U(900); },
  } };
}
const rejeita = (p, codigo) => assert.rejects(p, (e) => e.details?.codigo === codigo || e.codigo === codigo);
const JUST = "Stone creditou a Unicred em tres parcelas, conferido no extrato";

test("soma exata com 3 entradas: grava uma vez, com quem aprovou", async () => {
  const d = deps();
  const r = await lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(12), U(13)], justificativa: JUST }, d);
  assert.equal(r.id, U(900)); assert.equal(r.valorCentavos, 100000); assert.equal(r.aprovadoPor, ctx.usuarioId);
  assert.deepEqual(d.chamadas, [{ saida: U(10), entradas: [U(11), U(12), U(13)], just: JUST, usuario: ctx.usuarioId }]);
});
test("soma diferente é recusada antes de gravar (nada chega ao banco)", async () => {
  const d = deps();
  await rejeita(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(14)], justificativa: JUST }, d), "SOMA_DIFERENTE");
  assert.equal(d.chamadas.length, 0);
});
test("uma entrada, quatro entradas e repetidas são recusadas", async () => {
  const d = deps();
  await rejeita(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11)], justificativa: JUST }, d), "QUANTIDADE_ENTRADAS");
  await rejeita(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(12), U(13), U(14)], justificativa: JUST }, d), "QUANTIDADE_ENTRADAS");
  await rejeita(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(11), U(12)], justificativa: JUST }, d), "ENTRADAS_REPETIDAS");
  assert.equal(d.chamadas.length, 0);
});
test("justificativa curta ou ausente é recusada; lançamento de outra unidade (inexistente aqui) é recusado", async () => {
  const d = deps();
  await rejeita(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(12), U(13)], justificativa: "curta" }, d), "JUSTIFICATIVA_OBRIGATORIA");
  await assert.rejects(lanc.vincularTransferenciaMultipla(ctx, { saidaId: U(10), entradaIds: [U(11), U(12), U(99)], justificativa: JUST }, d), /não encontrado/i);
  await assert.rejects(lanc.vincularTransferenciaMultipla(ctx, { saidaId: "x", entradaIds: [U(11), U(12)], justificativa: JUST }, d));
  assert.equal(d.chamadas.length, 0);
});
test("desfazer exige motivo (≥ 10) e a conciliação precisa existir", async () => {
  const d = deps();
  await rejeita(lanc.desvincularTransferenciaMultipla(ctx, U(900), { motivo: "curto" }, d), "MOTIVO_OBRIGATORIO");
  assert.deepEqual(await lanc.desvincularTransferenciaMultipla(ctx, U(900), { motivo: "Entradas erradas, refazer a conciliacao" }, d), { desfeita: true });
  await assert.rejects(lanc.desvincularTransferenciaMultipla(ctx, U(901), { motivo: "Entradas erradas, refazer a conciliacao" }, d), /não encontrada/i);
});
test("mensagens do banco viram texto humano (soma, conflito, justificativa)", () => {
  assert.match(MENSAGENS.FIN_MULTIPLA_SOMA("fin_multipla_soma: a soma das entradas (85000) difere da saida (100000)"), /R\$\s850,00 × R\$\s1\.000,00/);
  assert.match(MENSAGENS.FIN_MULTIPLA_CONFLITO, /já está vinculado/);
  assert.match(MENSAGENS.FIN_MULTIPLA_JUSTIFICATIVA_OBRIGATORIA, /10 caracteres/);
});
test("a sugestão automática continua só PROPONDO: 1 saída ⇄ 2–3 entradas vira um_para_varios, sem vínculo", () => {
  const s = [{ id: "s", conta_id: "A", data_movimento: "2026-09-04", valor_centavos: 99392, descricao: "TRANSFERENCIA" }];
  const e = [{ id: "e1", conta_id: "B", data_movimento: "2026-09-04", valor_centavos: 81850 }, { id: "e2", conta_id: "B", data_movimento: "2026-09-04", valor_centavos: 17542 }];
  const [p] = sugerirTransferencias(s, e);
  assert.equal(p.status, "um_para_varios"); assert.deepEqual(p.contrapartidas.map((x) => x.id), ["e1", "e2"]);
});
