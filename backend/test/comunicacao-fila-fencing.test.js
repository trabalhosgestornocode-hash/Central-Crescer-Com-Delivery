// D.3-B/R — CLAIM × ATTEMPT + FENCING (migration 087) contra o Supabase de TESTE real.
//
//   CLAIM   = quem pode processar a linha agora     -> token `claim_geracao`
//   ATTEMPT = qual execução chegou à fronteira de envio -> `tentativas`
//             (só sobe em iniciar_envio; um adiamento = claims sem attempt)
//
// Prova que toda transição depois do claim exige o token; que worker antigo,
// lease vencido e callback atrasado devolvem `null` ("perdeu a posse") e NADA
// é sobrescrito; que SENDING nunca é reivindicado; que DELIVERY_UNKNOWN nunca
// volta a retry; e que os tokens nunca diminuem (trigger).
//
// Só roda com banco descartável (motivoPularIntegracao). Rodar:
//   node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-fila-fencing.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import { STATUS_MENSAGEM as S } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgId = null;
const criados = [];

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  // migration 087 (claim × attempt) aplicada? coluna nova + RPC nova (chamar com uuid inexistente não escreve nada)
  const col = await supabase.from("comunicacao_mensagens").select("claim_geracao").limit(0);
  const rpc = await supabase.rpc("comunicacao_iniciar_envio", { p_id: "00000000-0000-0000-0000-000000000000", p_worker: "probe", p_claim_geracao: 1 });
  if (col.error || rpc.error) { migracaoOk = false; return; }
  orgId = await criarOrganizacao("TESTE comunicacao-fencing — descartável");
});

after(async () => {
  if (criados.length) await supabase.from("comunicacao_mensagens").delete().in("id", criados);
  await apagarOrganizacao(orgId);
});

let seq = 0;
async function novoJob(extra = {}) {
  const job = await filaRepo.agendarMensagem({
    organizacaoId: orgId, contatoId: null, tipo: "teste_fencing", conteudo: "x",
    idempotencyKey: `fencing-${Date.now()}-${++seq}`, disponivelEm: new Date(Date.now() - 60_000), ...extra,
  });
  criados.push(job.id);
  return job;
}
/** Reivindica e devolve a MINHA linha (o claim é global; outras linhas de teste podem vir junto). */
async function claimarMeu(id, worker, leaseSegundos = 120) {
  const lote = await filaRepo.claimJobs({ limite: 100, worker, leaseSegundos });
  const meu = lote.find((j) => j.id === id);
  assert.ok(meu, `o claim de ${worker} não devolveu a linha ${id}`);
  return meu;
}
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const vencerLease = (id) => supabase.from("comunicacao_mensagens")
  .update({ claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", id);
const liberarParaClaim = (id) => supabase.from("comunicacao_mensagens")
  .update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", id);

/** Token do CLAIM (fase PROCESSING). */
const claimTok = (c) => ({ id: c.id, worker: c.claimed_by, claimGeracao: c.claim_geracao });
/** Token do ATTEMPT (fase SENDING) — vem da linha devolvida por iniciarEnvio. */
const attemptTok = (r) => ({ ...claimTok(r), tentativa: r.tentativas });

const pular = (t) => { if (!migracaoOk) { t.skip("migrations 082/087 não aplicadas no banco de teste — pulando."); return true; } return false; };

describe("D.3-R — CLAIM não consome attempt; o attempt nasce em iniciar_envio", { skip: PULAR_INTEGRACAO }, () => {
  test("o claim NÃO incrementa `tentativas`; incrementa só `claim_geracao` (inclusive no reclaim após lease vencido)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    assert.equal(j.tentativas, 0);
    const c1 = await claimarMeu(j.id, "w");
    assert.equal(c1.tentativas, 0, "o claim consumiu uma tentativa");
    assert.equal(c1.claim_geracao, 1);
    await vencerLease(j.id);
    const c2 = await claimarMeu(j.id, "w");
    assert.equal(c2.tentativas, 0);
    assert.equal(c2.claim_geracao, 2, "cada claim gera um token novo");
  });

  test("iniciar_envio cria o attempt: tentativas 0 -> 1, status SENDING, lease novo; repetir devolve null e NÃO cria outro attempt", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-a", 5);
    const r = await filaRepo.iniciarEnvio({ ...claimTok(c), leaseSegundos: 90 });
    assert.equal(r.status, S.SENDING);
    assert.equal(r.tentativas, 1, "o attempt nasce aqui");
    assert.equal(r.claim_geracao, c.claim_geracao);
    assert.ok(new Date(r.claim_expira_em).getTime() > new Date(c.claim_expira_em).getTime() + 60_000, "lease de envio (90s) substitui o do claim");
    assert.equal(await filaRepo.iniciarEnvio(claimTok(c)), null, "a mesma reivindicação não pode criar um segundo attempt");
    assert.equal((await linha(j.id)).tentativas, 1);
  });

  test("DEFERIMENTOS: vários claims, ZERO attempts — `tentativas` fica 0, nunca BLOCKED/FAILED, mesmo com max_tentativas=1", async (t) => {
    if (pular(t)) return;
    const j = await novoJob({ maxTentativas: 1 });
    for (let i = 1; i <= 6; i++) {
      const c = await claimarMeu(j.id, `w-${i}`);
      assert.equal(c.tentativas, 0);
      assert.equal(c.claim_geracao, i);
      const r = await filaRepo.encerrarProcessamento({ ...claimTok(c), destino: "SCHEDULED", motivo: "OUTSIDE_ALLOWED_WINDOW" });
      assert.equal(r.status, S.SCHEDULED, `deferimento ${i} virou ${r.status}`);
      assert.equal(r.tentativas, 0, "um deferimento consumiu tentativa");
      await liberarParaClaim(j.id);
    }
    const fim = await linha(j.id);
    assert.equal(fim.tentativas, 0);
    assert.equal(fim.claim_geracao, 6);
    assert.equal(fim.status, S.SCHEDULED);
    // e o primeiro attempt REAL ainda é possível (a mensagem nunca foi "gasta")
    const c = await claimarMeu(j.id, "w-real");
    assert.equal((await filaRepo.iniciarEnvio(claimTok(c))).tentativas, 1);
  });

  test("cada motivo transitório (janela, cooldown, rate limit, modo, provider offline) adia sem tocar `tentativas`", async (t) => {
    if (pular(t)) return;
    for (const motivo of ["OUTSIDE_ALLOWED_WINDOW", "COOLDOWN", "RATE_LIMIT", "DISABLED", "PROVIDER_OFFLINE"]) {
      const j = await novoJob();
      const c = await claimarMeu(j.id, "w-motivo");
      const r = await filaRepo.encerrarProcessamento({ ...claimTok(c), destino: "SCHEDULED", motivo });
      assert.equal(r.tentativas, 0, motivo);
      assert.equal(r.erro, motivo);
    }
  });
});

describe("D.3-R — worker stale (claim × attempt)", { skip: PULAR_INTEGRACAO }, () => {
  test("A obtém claim -> deferimento -> B obtém OUTRO claim (nenhum attempt ainda) -> B inicia (attempt criado) -> A tenta iniciar: REJEITADO", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const a = await claimarMeu(j.id, "manual"); // MESMO nome nos dois — só o token do claim os distingue
    await filaRepo.encerrarProcessamento({ ...claimTok(a), destino: "SCHEDULED", motivo: "COOLDOWN" });
    await liberarParaClaim(j.id);

    const b = await claimarMeu(j.id, "manual");
    assert.equal(b.claim_geracao, 2);
    assert.equal(b.tentativas, 0, "nenhum attempt foi criado até aqui");
    assert.equal((await linha(j.id)).tentativas, 0);

    const bEnviando = await filaRepo.iniciarEnvio(claimTok(b));
    assert.equal(bEnviando.tentativas, 1, "attempt de B criado");

    assert.equal(await filaRepo.iniciarEnvio(claimTok(a)), null, "A (claim antigo) não pode iniciar");
    assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(a), destino: "BLOCKED", motivo: "atrasado" }), null, "nem encerrar");
    assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(a), tentativa: 1, resultado: "SENT", providerMessageId: "id-de-A" }), null, "nem finalizar o attempt de B");
    const atual = await linha(j.id);
    assert.equal(atual.status, S.SENDING);
    assert.equal(atual.tentativas, 1, "A não criou nenhum attempt");
    assert.equal(atual.provider_message_id, null);
  });

  test("A lento (lease vencido em PROCESSING), B reivindica: A não inicia nem finaliza; só B envia", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const a = await claimarMeu(j.id, "manual");
    await vencerLease(j.id);
    const b = await claimarMeu(j.id, "manual");
    assert.equal(b.claim_geracao, a.claim_geracao + 1);

    assert.equal(await filaRepo.iniciarEnvio(claimTok(a)), null);
    const bEnviando = await filaRepo.iniciarEnvio(claimTok(b));
    assert.equal(bEnviando.status, S.SENDING);
    for (const resultado of ["SENT", "FAILED", "DELIVERY_UNKNOWN", "RETRY"]) {
      assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(a), tentativa: 1, resultado, providerMessageId: "de-A", erro: "A", retryAposSegundos: 30 }), null, resultado);
    }
    assert.equal((await linha(j.id)).status, S.SENDING, "o estado é de B");
    const fim = await filaRepo.finalizarEnvio({ ...attemptTok(bEnviando), resultado: "SENT", providerMessageId: "id-de-B" });
    assert.equal(fim.status, S.SENT);
    assert.equal(fim.provider_message_id, "id-de-B");
  });

  test("A inicia o attempt (SENDING) e o lease vence: B NÃO cria novo attempt; a linha fica sem reenvio automático", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const a = await claimarMeu(j.id, "w-A");
    const aEnviando = await filaRepo.iniciarEnvio({ ...claimTok(a), leaseSegundos: 90 });
    assert.equal(aEnviando.tentativas, 1);
    await vencerLease(j.id); // o lease vence ENQUANTO o provider é chamado

    const lote = await filaRepo.claimJobs({ limite: 100, worker: "w-B" });
    assert.ok(!lote.some((x) => x.id === j.id), "B reivindicou uma mensagem em SENDING -> reenvio duplicado");
    assert.equal((await linha(j.id)).tentativas, 1, "nenhum attempt novo");

    const varridas = await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.ok(varridas.some((x) => x.id === j.id));
    assert.equal((await linha(j.id)).status, S.DELIVERY_UNKNOWN);
    const lote2 = await filaRepo.claimJobs({ limite: 100, worker: "w-C" });
    assert.ok(!lote2.some((x) => x.id === j.id), "DELIVERY_UNKNOWN foi reivindicado");
    assert.equal((await linha(j.id)).tentativas, 1);
  });

  test("callback ATRASADO de attempt antigo (que virou retry) não sobrescreve o attempt novo — nem com token MISTO", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const a = await claimarMeu(j.id, "w-antigo");
    const aEnviando = await filaRepo.iniciarEnvio(claimTok(a));
    const retry = await filaRepo.finalizarEnvio({ ...attemptTok(aEnviando), resultado: "RETRY", erro: "pre-envio", retryAposSegundos: 30 });
    assert.equal(retry.status, S.SCHEDULED);

    await liberarParaClaim(j.id);
    const b = await claimarMeu(j.id, "w-novo");
    const bEnviando = await filaRepo.iniciarEnvio(claimTok(b));
    assert.equal(bEnviando.tentativas, 2);

    // callback duplicado/atrasado de A (claim 1, attempt 1)
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(aEnviando), resultado: "FAILED", erro: "atrasado" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(aEnviando), resultado: "SENT", providerMessageId: "atrasado" }), null);
    // token MISTO: claim de B com o número de attempt de A, e vice-versa
    assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(b), tentativa: 1, resultado: "SENT", providerMessageId: "misto" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(a), tentativa: 2, resultado: "SENT", providerMessageId: "misto" }), null);
    const atual = await linha(j.id);
    assert.equal(atual.status, S.SENDING);
    assert.equal(atual.claimed_by, "w-novo");
    assert.equal(atual.provider_message_id, null);
  });
});

describe("D.3-R — comunicacao_iniciar_envio (a fronteira antes do provider)", { skip: PULAR_INTEGRACAO }, () => {
  test("worker com NOME errado -> null; sem attempt criado; linha continua PROCESSING", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-dono");
    assert.equal(await filaRepo.iniciarEnvio({ id: j.id, worker: "w-impostor", claimGeracao: c.claim_geracao }), null);
    const l = await linha(j.id);
    assert.equal(l.status, S.PROCESSING);
    assert.equal(l.tentativas, 0);
  });

  test("claim_geracao errado (anterior, futuro, 0, inventado) -> null; `tentativas` intacto", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-tok");
    for (const claimGeracao of [c.claim_geracao - 1, c.claim_geracao + 1, 0, 999]) {
      assert.equal(await filaRepo.iniciarEnvio({ id: j.id, worker: "w-tok", claimGeracao }), null, `claimGeracao=${claimGeracao}`);
    }
    assert.equal((await linha(j.id)).tentativas, 0);
    assert.equal((await filaRepo.iniciarEnvio(claimTok(c))).status, S.SENDING, "o token certo ainda funciona");
  });

  test("lease VENCIDO no relógio do banco -> null, nenhum attempt criado; continua PROCESSING (recuperável)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-lento");
    await vencerLease(j.id);
    assert.equal(await filaRepo.iniciarEnvio(claimTok(c)), null);
    const l = await linha(j.id);
    assert.equal(l.status, S.PROCESSING);
    assert.equal(l.tentativas, 0);
  });

  test("estado diferente de PROCESSING (SCHEDULED, CANCELLED, BLOCKED, FAILED, SENT) -> null", async (t) => {
    if (pular(t)) return;
    for (const estado of [S.SCHEDULED, S.CANCELLED, S.BLOCKED, S.FAILED, S.SENT]) {
      const j = await novoJob();
      const c = await claimarMeu(j.id, "w-estado");
      await supabase.from("comunicacao_mensagens").update({ status: estado }).eq("id", j.id);
      assert.equal(await filaRepo.iniciarEnvio(claimTok(c)), null, `estado ${estado}`);
    }
  });

  test("attempts já esgotados (tentativas >= max_tentativas) -> null (nunca envia além do limite)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob({ maxTentativas: 1 });
    const c = await claimarMeu(j.id, "w-esgotado");
    await supabase.from("comunicacao_mensagens").update({ tentativas: 1 }).eq("id", j.id); // já consumiu o único attempt
    assert.equal(await filaRepo.iniciarEnvio(claimTok(c)), null);
  });

  test("CONCORRÊNCIA: 10 chamadas simultâneas com o MESMO claim -> exatamente UMA passa E o attempt é criado UMA vez", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-corrida");
    const resultados = await Promise.all(Array.from({ length: 10 }, () => filaRepo.iniciarEnvio(claimTok(c))));
    assert.equal(resultados.filter(Boolean).length, 1, "mais de uma chamada 'ganhou' a fronteira: o provider seria chamado duas vezes");
    assert.equal((await linha(j.id)).tentativas, 1, "o contador de attempts subiu mais de uma vez");
  });
});

describe("D.3-R — finalização (SENT / UNKNOWN / FAILED / RETRY)", { skip: PULAR_INTEGRACAO }, () => {
  test("token do attempt errado (worker, claim ou número) -> null; certo -> finaliza", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-fin");
    const e = await filaRepo.iniciarEnvio(claimTok(c));
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), worker: "outro", resultado: "SENT" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), claimGeracao: e.claim_geracao + 1, resultado: "SENT" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), tentativa: e.tentativas + 1, resultado: "SENT" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), tentativa: 0, resultado: "SENT" }), null);
    assert.equal((await linha(j.id)).status, S.SENDING);
    assert.equal((await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "SENT", providerMessageId: "ok" })).status, S.SENT);
  });

  test("finalizar fora de SENDING (ainda PROCESSING): null — ninguém finaliza um envio que não começou", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-cedo");
    assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(c), tentativa: 1, resultado: "SENT", providerMessageId: "x" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...claimTok(c), tentativa: 0, resultado: "SENT", providerMessageId: "x" }), null);
    assert.equal((await linha(j.id)).status, S.PROCESSING);
  });

  test("DELIVERY_UNKNOWN NUNCA volta a retry: RETRY, FAILED, novo UNKNOWN, adiamento e novo attempt devolvem null; o claim não o vê", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-unk");
    const e = await filaRepo.iniciarEnvio(claimTok(c));
    const unk = await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "DELIVERY_UNKNOWN", erro: "timeout" });
    assert.equal(unk.status, S.DELIVERY_UNKNOWN);
    assert.ok(unk.entrega_incerta_em);

    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "RETRY", retryAposSegundos: 1 }), null, "UNKNOWN -> SCHEDULED é reenvio cego");
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "FAILED" }), null, "UNKNOWN -> FAILED diria 'não chegou', que não sabemos");
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "DELIVERY_UNKNOWN" }), null);
    assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(e), destino: "SCHEDULED" }), null);
    assert.equal(await filaRepo.iniciarEnvio(claimTok(e)), null, "nenhum attempt novo a partir de UNKNOWN");

    // mesmo com o tempo passando e o lease "vencido" por qualquer motivo:
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 3600_000).toISOString(), claim_expira_em: new Date(Date.now() - 3600_000).toISOString() }).eq("id", j.id);
    const lote = await filaRepo.claimJobs({ limite: 100, worker: "w-outro" });
    assert.ok(!lote.some((x) => x.id === j.id), "DELIVERY_UNKNOWN foi reivindicado");
    const l = await linha(j.id);
    assert.equal(l.status, S.DELIVERY_UNKNOWN);
    assert.equal(l.tentativas, 1);
  });

  test("confirmação TARDIA: o MESMO attempt confirma SENT depois de a varredura marcar UNKNOWN -> SENT (única saída de UNKNOWN); attempt errado não", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-tardio");
    const e = await filaRepo.iniciarEnvio(claimTok(c));
    await vencerLease(j.id);
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.equal((await linha(j.id)).status, S.DELIVERY_UNKNOWN);

    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), tentativa: e.tentativas + 1, resultado: "SENT", providerMessageId: "outro-attempt" }), null);
    assert.equal(await filaRepo.finalizarEnvio({ ...attemptTok(e), claimGeracao: e.claim_geracao + 1, resultado: "SENT", providerMessageId: "outro-claim" }), null);
    assert.equal((await linha(j.id)).status, S.DELIVERY_UNKNOWN);

    const r = await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "SENT", providerMessageId: "confirmado-depois" });
    assert.equal(r.status, S.SENT);
    assert.equal(r.provider_message_id, "confirmado-depois");
  });

  test("RETRY dentro do limite -> SCHEDULED com disponivel_em futuro, erro registrado e `tentativas` = attempts reais", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-retry");
    const e = await filaRepo.iniciarEnvio(claimTok(c));
    const r = await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "RETRY", erro: "conexao recusada", retryAposSegundos: 120 });
    assert.equal(r.status, S.SCHEDULED);
    assert.equal(r.tentativas, 1);
    assert.ok(new Date(r.disponivel_em).getTime() > Date.now() + 60_000);
    assert.equal(r.erro, "conexao recusada");
  });

  test("RETRY esgotando a política de retries (attempts reais = max) -> FAILED (não BLOCKED)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob({ maxTentativas: 2 });
    let ultimo;
    for (let i = 1; i <= 2; i++) {
      const c = await claimarMeu(j.id, `w-esgota-${i}`);
      const e = await filaRepo.iniciarEnvio(claimTok(c));
      assert.equal(e.tentativas, i);
      ultimo = await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "RETRY", erro: "x", retryAposSegundos: 30 });
      if (i === 1) { assert.equal(ultimo.status, S.SCHEDULED); await liberarParaClaim(j.id); }
    }
    assert.equal(ultimo.status, S.FAILED);
    assert.equal(ultimo.erro_permanente, true);
  });

  test("SENT limpa o erro de attempts anteriores e registra enviado_em", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c1 = await claimarMeu(j.id, "w-limpa");
    const e1 = await filaRepo.iniciarEnvio(claimTok(c1));
    await filaRepo.finalizarEnvio({ ...attemptTok(e1), resultado: "RETRY", erro: "erro velho", retryAposSegundos: 30 });
    await liberarParaClaim(j.id);
    const c2 = await claimarMeu(j.id, "w-limpa-2");
    const e2 = await filaRepo.iniciarEnvio(claimTok(c2));
    const r = await filaRepo.finalizarEnvio({ ...attemptTok(e2), resultado: "SENT", providerMessageId: "ok" });
    assert.equal(r.erro, null);
    assert.ok(r.enviado_em);
    assert.equal(r.tentativas, 2);
  });

  test("resultado/destino inválidos são rejeitados no repositório (nunca chegam ao banco)", async (t) => {
    if (pular(t)) return;
    await assert.rejects(() => filaRepo.finalizarEnvio({ id: "x", worker: "w", claimGeracao: 1, tentativa: 1, resultado: "QUALQUER" }), /resultado inválido/);
    await assert.rejects(() => filaRepo.encerrarProcessamento({ id: "x", worker: "w", claimGeracao: 1, destino: "SENT" }), /destino inválido/);
  });
});

describe("D.3-R — comunicacao_encerrar_processamento (saída de PROCESSING SEM attempt)", { skip: PULAR_INTEGRACAO }, () => {
  test("BLOCKED / CANCELLED / FAILED pelo dono do claim; motivo em `erro`; `tentativas` intacto", async (t) => {
    if (pular(t)) return;
    for (const [destino, esperado] of [["BLOCKED", S.BLOCKED], ["CANCELLED", S.CANCELLED], ["FAILED", S.FAILED]]) {
      const j = await novoJob();
      const c = await claimarMeu(j.id, `w-${destino}`);
      const r = await filaRepo.encerrarProcessamento({ ...claimTok(c), destino, motivo: `MOTIVO_${destino}` });
      assert.equal(r.status, esperado);
      assert.equal(r.erro, `MOTIVO_${destino}`);
      assert.equal(r.tentativas, 0);
    }
  });

  test("claim antigo não encerra a linha que já é de outro claim -> null", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const a = await claimarMeu(j.id, "manual");
    await vencerLease(j.id);
    const b = await claimarMeu(j.id, "manual");
    assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(a), destino: "BLOCKED", motivo: "atrasado" }), null);
    assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(a), destino: "CANCELLED", motivo: "atrasado" }), null);
    assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(a), destino: "SCHEDULED", motivo: "atrasado" }), null);
    assert.equal((await linha(j.id)).status, S.PROCESSING);
    assert.equal((await filaRepo.encerrarProcessamento({ ...claimTok(b), destino: "CANCELLED", motivo: "certo" })).status, S.CANCELLED);
  });

  test("ADIAMENTO: SCHEDULED com disponivel_em nunca no passado (mínimo +1min) e NÃO reivindicável agora", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-adia");
    const r = await filaRepo.encerrarProcessamento({ ...claimTok(c), destino: "SCHEDULED", motivo: "OUTSIDE_ALLOWED_WINDOW", disponivelEm: new Date(Date.now() - 3600_000) });
    assert.equal(r.status, S.SCHEDULED);
    assert.ok(new Date(r.disponivel_em).getTime() > Date.now() + 30_000, "um adiamento para o passado viraria um loop apertado");
    const lote = await filaRepo.claimJobs({ limite: 100, worker: "w-logo-depois" });
    assert.ok(!lote.some((x) => x.id === j.id));
  });

  test("não é possível encerrar (adiar/bloquear) uma mensagem já em SENDING", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-sending");
    const e = await filaRepo.iniciarEnvio(claimTok(c));
    for (const destino of ["SCHEDULED", "BLOCKED", "CANCELLED", "FAILED"]) {
      assert.equal(await filaRepo.encerrarProcessamento({ ...claimTok(e), destino }), null, destino);
    }
    assert.equal((await linha(j.id)).status, S.SENDING);
  });
});

describe("D.3-R — invariante do token no BANCO (trigger de monotonicidade)", { skip: PULAR_INTEGRACAO }, () => {
  test("nenhum UPDATE consegue diminuir `claim_geracao` nem `tentativas` (o token nunca é reutilizado)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const c = await claimarMeu(j.id, "w-trig");
    await filaRepo.iniciarEnvio(claimTok(c)); // claim_geracao=1, tentativas=1
    const antes = await linha(j.id);

    const r1 = await supabase.from("comunicacao_mensagens").update({ claim_geracao: 0 }).eq("id", j.id);
    assert.ok(r1.error, "diminuir claim_geracao deveria falhar");
    assert.match(r1.error.message, /claim_geracao nao pode diminuir/);
    const r2 = await supabase.from("comunicacao_mensagens").update({ tentativas: 0 }).eq("id", j.id);
    assert.ok(r2.error, "diminuir tentativas deveria falhar");
    assert.match(r2.error.message, /tentativas nao pode diminuir/);

    const depois = await linha(j.id);
    assert.equal(depois.claim_geracao, antes.claim_geracao);
    assert.equal(depois.tentativas, antes.tentativas);
    // manter ou aumentar continua permitido
    assert.equal((await supabase.from("comunicacao_mensagens").update({ tentativas: 3 }).eq("id", j.id)).error, null);
  });

  test("claim_geracao é estritamente crescente em toda a vida da mensagem (claim, deferimento, retry, reclaim)", async (t) => {
    if (pular(t)) return;
    const j = await novoJob();
    const vistos = [];
    const c1 = await claimarMeu(j.id, "w"); vistos.push(c1.claim_geracao);
    await vencerLease(j.id);
    const c2 = await claimarMeu(j.id, "w"); vistos.push(c2.claim_geracao);
    await filaRepo.encerrarProcessamento({ ...claimTok(c2), destino: "SCHEDULED", motivo: "COOLDOWN" });
    await liberarParaClaim(j.id);
    const c3 = await claimarMeu(j.id, "w"); vistos.push(c3.claim_geracao);
    const e = await filaRepo.iniciarEnvio(claimTok(c3));
    await filaRepo.finalizarEnvio({ ...attemptTok(e), resultado: "RETRY", retryAposSegundos: 30 });
    await liberarParaClaim(j.id);
    const c4 = await claimarMeu(j.id, "w"); vistos.push(c4.claim_geracao);
    assert.deepEqual(vistos, [1, 2, 3, 4]);
    assert.equal(c4.tentativas, 1, "só o attempt do passo 3 contou");
  });
});
