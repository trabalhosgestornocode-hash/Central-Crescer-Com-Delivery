// Sobe o backend no modo TEMPORÁRIO CENTRALIZED_TEST (app centralizado "Teste (C)")
// usando SOMENTE o projeto Supabase de teste. Uso: npm run dev:ifood-centralized-test
//
// NÃO é o modelo do produto (o produto é DISTRIBUÍDO) e NÃO é a homologação do
// Teste (D). É um ambiente técnico para desenvolver Events/Order/etc.
//
// Variáveis: `--env-file=.env.test-integracao --env-file=.env.ifood-centralized-test`
// (ver package.json). O `.env` de produção NÃO é carregado — e este script
// recusa subir se qualquer sinal de produção/Render/app real estiver no
// ambiente (ver ifoodHomologGuard.mjs#validarAmbienteCentralizadoTesteIfood).
import {
  validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste, PROJETO_TESTE_REF,
} from "./ifoodHomologGuard.mjs";

function recusar(erros) {
  console.error("\n[dev:ifood-centralized-test] AMBIENTE RECUSADO — nada foi iniciado.");
  for (const e of erros) console.error("  ✖ " + e);
  console.error("\nEsperado: Supabase 'teste-multiempresarial' (" + PROJETO_TESTE_REF + ") em .env.test-integracao,");
  console.error("e IFOOD_CENTRALIZED_TEST_MODE / IFOOD_CENTRALIZED_TEST_CLIENT_ID / _SECRET em .env.ifood-centralized-test.");
  console.error("Se SUPABASE_* ou IFOOD_* estiverem exportadas no seu terminal, elas vencem os arquivos: remova-as.\n");
  process.exit(1);
}

const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) recusar(r.erros);

const errosProva = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (errosProva.length) recusar(errosProva);

console.log("[dev:ifood-centralized-test] ambiente validado — Supabase de TESTE (" + r.resumo.supabaseRef + "), fora do Render.");
console.log("[dev:ifood-centralized-test] MODO TEMPORÁRIO: app centralizado de teste (client_credentials). Porta: " + (process.env.PORT || "3001"));

await import("../src/server.js");
