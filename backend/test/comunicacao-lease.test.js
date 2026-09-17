// Integração — lease do claim (worker que morre) e a barreira dura entre
// PROCESSING (seguro reivindicar de novo) e SENDING (nunca reivindicado
// automaticamente — vira DELIVERY_UNKNOWN). Contra o Supabase REAL.
//
// ⚠️ Ainda NÃO EXECUTADO neste ambiente — motivoPularIntegracao() pula por
// padrão a menos que rodado com --env-file=.env.test-integracao (projeto
// de teste descartável já usado pelo restante da suíte de integração do
// projeto). Ver a seção "banco usado para integração" do relatório do
// Checkpoint B.1.
// Rodar: node --env-file=.env.test-integracao --test test/comunicacao-lease.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as tentativasRepo from "../src/modules/comunicacao/comunicacao.tentativas.repo.js";
import { STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgId = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  orgId = await criarOrganizacao("TESTE comunicacao-lease — descartável");
});

after(async () => { await apagarOrganizacao(orgId); });

async function novoJob(chave) {
  return filaRepo.agendarMensagem({
    organizacaoId: orgId, contatoId: null, tipo: "teste_lease",
    conteudo: "x", idempotencyKey: chave, disponivelEm: new Date(Date.now() - 60_000),
  });
}

describe("comunicacao.fila — lease e recuperação de worker abandonado", { skip: PULAR_INTEGRACAO }, () => {
  test("teste D — claim concede um lease (claim_expira_em no futuro)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 (com claim_expira_em) ainda não aplicada — pulando.");
    const job = await novoJob(`lease-d-${Date.now()}`);
    const [claimado] = await filaRepo.claimJobs({ limite: 1, worker: "worker-d", leaseSegundos: 5 });
    assert.equal(claimado.id, job.id);
    assert.ok(new Date(claimado.claim_expira_em).getTime() > Date.now());
    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });

  test("teste F — job ainda DENTRO do lease não pode ser roubado por outro worker", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const job = await novoJob(`lease-f-${Date.now()}`);
    const [a] = await filaRepo.claimJobs({ limite: 1, worker: "worker-a", leaseSegundos: 60 });
    assert.equal(a.id, job.id);

    // worker-b tenta imediatamente, MESMO lote — o lease de worker-a ainda vale.
    const loteB = await filaRepo.claimJobs({ limite: 10, worker: "worker-b", leaseSegundos: 60 });
    assert.ok(!loteB.some((j) => j.id === job.id), "worker-b conseguiu roubar um job com lease ainda válido");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });

  test("teste E — job PROCESSING com lease EXPIRADO (worker morreu antes de tentar o envio) é recuperado com segurança", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const job = await novoJob(`lease-e-${Date.now()}`);
    const [a] = await filaRepo.claimJobs({ limite: 1, worker: "worker-morto", leaseSegundos: 1 });
    assert.equal(a.id, job.id);

    await new Promise((r) => setTimeout(r, 1200)); // deixa o lease de 1s expirar de verdade

    const [b] = await filaRepo.claimJobs({ limite: 1, worker: "worker-vivo", leaseSegundos: 60 });
    assert.ok(b, "job abandonado (PROCESSING, lease expirado) deveria ter sido recuperado");
    assert.equal(b.id, job.id);
    assert.equal(b.claimed_by, "worker-vivo");
    assert.equal(b.tentativas, 2, "cada claim (inclusive o de recuperação) conta como uma tentativa");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });

  test("teste G — job SENDING com lease expirado NUNCA é reivindicado pelo claim normal (vira DELIVERY_UNKNOWN só pela varredura dedicada)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const job = await novoJob(`lease-g-${Date.now()}`);
    await filaRepo.claimJobs({ limite: 1, worker: "worker-x", leaseSegundos: 1 });
    // simula "estava chamando o provider quando morreu": PROCESSING -> SENDING.
    await filaRepo.marcarEnviando(job.id);
    await new Promise((r) => setTimeout(r, 1200)); // lease expira

    const reivindicado = await filaRepo.claimJobs({ limite: 10, worker: "worker-y", leaseSegundos: 60 });
    assert.ok(!reivindicado.some((j) => j.id === job.id), "um job SENDING NUNCA deveria ser reivindicado pelo claim normal — risco de reenvio duplicado");

    const [expirado] = await filaRepo.expirarEntregasIncertas({ worker: "worker-y" });
    assert.ok(expirado, "a varredura dedicada deveria ter encontrado o SENDING expirado");
    assert.equal(expirado.id, job.id);
    assert.equal(expirado.status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);

    // e mesmo DEPOIS de virar DELIVERY_UNKNOWN, o claim normal continua nunca pegando.
    const reivindicadoDeNovo = await filaRepo.claimJobs({ limite: 10, worker: "worker-z", leaseSegundos: 60 });
    assert.ok(!reivindicadoDeNovo.some((j) => j.id === job.id), "DELIVERY_UNKNOWN nunca deveria ser reivindicado automaticamente — exige reconciliação explícita");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });

  test("teste I — a função de claim não é executável por anon/authenticated", async (t) => {
    // NOTA HONESTA: este teste precisa de um client Supabase autenticado
    // como `anon`/`authenticated` (o `supabase` importado acima é
    // service_role — chamar a RPC com ele NUNCA provaria nada sobre
    // permissão negada). Depende de TEST_SUPABASE_ANON_KEY (ver
    // .env.test.example), ainda não usado por nenhuma suíte deste arquivo.
    // Fica explicitamente pendente — não marcar como "passou" sem a
    // verificação real feita com o role certo.
    t.skip("requer um client Supabase autenticado como anon/authenticated (TEST_SUPABASE_ANON_KEY) — não implementado ainda; ver nota no código.");
  });

  test("tentativas: uma linha ABANDONADA é registrada quando um job é recuperado de um worker morto", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const job = await novoJob(`lease-tentativas-${Date.now()}`);
    const [a] = await filaRepo.claimJobs({ limite: 1, worker: "worker-morto-2", leaseSegundos: 1 });
    await tentativasRepo.registrarTentativaIniciada({ mensagemId: a.id, tentativaNumero: a.tentativas, workerId: "worker-morto-2", iniciadoEm: a.claimed_at });

    await new Promise((r) => setTimeout(r, 1200));
    const [b] = await filaRepo.claimJobs({ limite: 1, worker: "worker-vivo-2", leaseSegundos: 60 });
    assert.equal(b.id, job.id);

    const abandonadas = await tentativasRepo.abandonarTentativasEmAberto(job.id);
    assert.equal(abandonadas.length, 1);
    const historico = await tentativasRepo.listarTentativas(job.id);
    assert.equal(historico.find((h) => h.tentativa_numero === a.tentativas)?.resultado, "ABANDONADA");

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
  });
});
