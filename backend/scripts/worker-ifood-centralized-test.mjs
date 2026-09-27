// Sobe o WORKER de Events do iFood no modo TEMPORÁRIO CENTRALIZED_TEST (Teste (C)),
// só com o projeto Supabase de teste. Uso: npm run worker:ifood:centralized-test
//
// Mesma trava do dev:ifood-centralized-test (Supabase de teste, fora do Render, sem
// apps reais, sem misturar com o Teste (D)) — e só então importa o worker.
// NÃO é o modelo do produto (distribuído) e NÃO é homologação.
import {
  validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste, PROJETO_TESTE_REF,
} from "./ifoodHomologGuard.mjs";

function recusar(erros) {
  console.error("\n[worker:ifood:centralized-test] AMBIENTE RECUSADO — nada foi iniciado.");
  for (const e of erros) console.error("  ✖ " + e);
  console.error("\nEsperado: Supabase 'teste-multiempresarial' (" + PROJETO_TESTE_REF + ") em .env.test-integracao,");
  console.error("e IFOOD_CENTRALIZED_TEST_* + IFOOD_EVENTS_WORKER_ENABLED=true em .env.ifood-centralized-test.\n");
  process.exit(1);
}

const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) recusar(r.erros);
if (process.env.IFOOD_EVENTS_WORKER_ENABLED !== "true") recusar(["IFOOD_EVENTS_WORKER_ENABLED precisa ser 'true' neste modo."]);

const errosProva = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (errosProva.length) recusar(errosProva);

console.log("[worker:ifood:centralized-test] ambiente validado — Supabase de TESTE (" + r.resumo.supabaseRef + "), fora do Render.");
console.log("[worker:ifood:centralized-test] MODO TEMPORÁRIO: app centralizado de teste (client_credentials).");

await import("../src/worker-ifood/index.js");
