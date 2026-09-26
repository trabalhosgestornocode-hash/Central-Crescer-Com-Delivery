// Integração — prova, contra o Supabase REAL, o claim ATÔMICO
// (comunicacao_claim_mensagens, migration 082: FOR UPDATE SKIP LOCKED numa
// função só) e a preservação de idempotência num retry.
// Rodar: node --env-file=.env --test test/comunicacao-claim-concorrencia.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { agendarMensagemT, responsavelDoContato } from "./helpers/comunicacao-fixtures.js";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import { STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgId = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  orgId = await criarOrganizacao("TESTE comunicacao-claim — descartável");
});

after(async () => { await apagarOrganizacao(orgId); });

async function agendarJobsDePasse(qtd, prefixo) {
  const passado = new Date(Date.now() - 60_000);
  const jobs = [];
  for (let i = 0; i < qtd; i++) {
    jobs.push(await agendarMensagemT({
      organizacaoId: orgId, contatoId: null, tipo: "teste_claim",
      conteudo: "conteúdo de teste", idempotencyKey: `${prefixo}-${i}`, disponivelEm: passado,
    }));
  }
  return jobs;
}

describe("comunicacao.fila — claim atômico e idempotência", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 1 — duas execuções concorrentes nunca reivindicam o mesmo job", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const criados = await agendarJobsDePasse(10, `concorrencia-${Date.now()}`);

    const [loteA, loteB] = await Promise.all([
      filaRepo.claimJobs({ limite: 6, worker: "worker-A" }),
      filaRepo.claimJobs({ limite: 6, worker: "worker-B" }),
    ]);

    const idsA = new Set(loteA.map((j) => j.id));
    const idsB = new Set(loteB.map((j) => j.id));
    const intersecao = [...idsA].filter((id) => idsB.has(id));
    assert.deepEqual(intersecao, [], "os dois lotes reivindicaram o mesmo job");
    assert.equal(idsA.size + idsB.size, Math.min(10, idsA.size + idsB.size)); // sem contagem duplicada
    assert.ok(idsA.size + idsB.size <= 10);

    // todos os 10 criados neste teste foram reivindicados por exatamente um dos dois workers.
    const todosOsIds = new Set(criados.map((j) => j.id));
    const reivindicados = new Set([...idsA, ...idsB]);
    for (const id of todosOsIds) assert.ok(reivindicados.has(id), `job ${id} não foi reivindicado por ninguém`);

    await supabase.from("comunicacao_mensagens").delete().in("id", [...todosOsIds]);
  });

  test("teste 2 — retry (reagendar com a MESMA idempotency_key) não cria um segundo envio lógico", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const chave = `retry-${Date.now()}`;
    const disponivelEm = new Date(Date.now() - 60_000);

    const primeiro = await agendarMensagemT({ organizacaoId: orgId, contatoId: null, tipo: "teste_retry", conteudo: "x", idempotencyKey: chave, disponivelEm });
    // simula um "retry" do mesmo agendamento — MESMA chave.
    const segundo = await agendarMensagemT({ organizacaoId: orgId, contatoId: null, tipo: "teste_retry", conteudo: "x (retry)", idempotencyKey: chave, disponivelEm });

    assert.equal(primeiro.id, segundo.id, "um retry com a mesma idempotency_key criou uma SEGUNDA linha");
    const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("idempotency_key", chave);
    assert.equal(count, 1);

    await supabase.from("comunicacao_mensagens").delete().eq("id", primeiro.id);
  });

  test("teste 15 — falha permanente termina em FAILED e não volta a ser reivindicável", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const chave = `falha-permanente-${Date.now()}`;
    const job = await agendarMensagemT({ organizacaoId: orgId, contatoId: null, tipo: "teste_falha", conteudo: "x", idempotencyKey: chave, disponivelEm: new Date(Date.now() - 60_000) });
    const [c] = await filaRepo.claimJobs({ limite: 1, worker: "w" }); // marca PROCESSING
    const e = await filaRepo.iniciarEnvio({ id: job.id, worker: "w", claimGeracao: c.claim_geracao });
    const r = await filaRepo.finalizarEnvio({ id: job.id, worker: "w", claimGeracao: c.claim_geracao, tentativa: e.tentativas, resultado: "FAILED", erro: "erro definitivo" });
    assert.equal(r.status, STATUS_MENSAGEM.FAILED);
    assert.equal(r.erro_permanente, true);

    const reivindicado = await filaRepo.claimJobs({ limite: 10, worker: "w2" });
    assert.ok(!reivindicado.some((j) => j.id === job.id), "job FAILED foi reivindicado de novo — loop infinito");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });

  test("teste 14 — falha transitória volta para SCHEDULED com disponivel_em no futuro (backoff), não imediato", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const chave = `falha-transitoria-${Date.now()}`;
    const job = await agendarMensagemT({ organizacaoId: orgId, contatoId: null, tipo: "teste_falha", conteudo: "x", idempotencyKey: chave, disponivelEm: new Date(Date.now() - 60_000) });
    const [c] = await filaRepo.claimJobs({ limite: 1, worker: "w" });
    const e = await filaRepo.iniciarEnvio({ id: job.id, worker: "w", claimGeracao: c.claim_geracao });
    const r = await filaRepo.finalizarEnvio({ id: job.id, worker: "w", claimGeracao: c.claim_geracao, tentativa: e.tentativas, resultado: "RETRY", erro: "pre-envio", retryAposSegundos: 30 });
    assert.equal(r.status, STATUS_MENSAGEM.SCHEDULED);
    assert.ok(new Date(r.disponivel_em).getTime() > Date.now(), "o retry precisa ficar no FUTURO (backoff)");

    // não reivindicável IMEDIATAMENTE (claim só pega disponivel_em <= now()).
    const reivindicadoAgora = await filaRepo.claimJobs({ limite: 10, worker: "w2" });
    assert.ok(!reivindicadoAgora.some((j) => j.id === job.id), "job com backoff foi reivindicado antes da hora");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });
});
