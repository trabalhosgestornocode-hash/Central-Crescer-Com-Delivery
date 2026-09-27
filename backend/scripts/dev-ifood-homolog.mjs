// Sobe o backend em modo HOMOLOGAÇÃO iFood usando SOMENTE o projeto Supabase de
// teste. Uso (via npm): npm run dev:ifood-homolog
//
// As variáveis vêm de `--env-file=.env.test-integracao --env-file=.env.ifood-homolog`
// (ver package.json) — o `.env` de produção NÃO é carregado. Mesmo assim este
// script recusa subir se qualquer credencial Supabase não for comprovadamente
// do projeto de teste (ver ifoodHomologGuard.mjs): protege contra variável
// exportada no shell, arquivo trocado por engano e mistura parcial de arquivos.
import { validarAmbienteHomologIfood, provarChavesNoProjetoTeste, PROJETO_TESTE_REF } from "./ifoodHomologGuard.mjs";

function recusar(erros) {
  console.error("\n[dev:ifood-homolog] AMBIENTE RECUSADO — nada foi iniciado.");
  for (const e of erros) console.error("  ✖ " + e);
  console.error("\nEsperado: Supabase 'teste-multiempresarial' (" + PROJETO_TESTE_REF + ") em .env.test-integracao,");
  console.error("e IFOOD_HOMOLOGATION_MODE / IFOOD_TEST_CLIENT_* / IFOOD_TOKEN_SECRET em .env.ifood-homolog.");
  console.error("Se SUPABASE_* estiver exportada no seu terminal, ela vence os arquivos: remova-a e tente de novo.\n");
  process.exit(1);
}

const r = validarAmbienteHomologIfood(process.env);
if (!r.ok) recusar(r.erros);

const errosProva = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (errosProva.length) recusar(errosProva);

console.log("[dev:ifood-homolog] ambiente validado — Supabase de TESTE (" + r.resumo.supabaseRef + "): URL conferida e chaves aceitas pelo projeto de teste.");
console.log("[dev:ifood-homolog] IFOOD_HOMOLOGATION_MODE=true (app de teste). Porta: " + (process.env.PORT || "3001"));

await import("../src/server.js");
