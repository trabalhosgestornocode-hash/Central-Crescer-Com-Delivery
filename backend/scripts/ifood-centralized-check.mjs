// CHECKPOINT A — verificação real do modo CENTRALIZED_TEST (Teste (C)).
//
//   npm run ifood:centralized-check
//
// Faz, SOMENTE LEITURA e SEM tocar em banco:
//   1. trava de ambiente (Supabase de teste, fora do Render, sem apps reais);
//   2. token via client_credentials (o mesmo caminho das APIs de negócio);
//   3. GET /merchants pela MESMA função usada pela tela (listarMerchantsAutorizados);
//   4. prova o cache: uma 2ª descoberta NÃO pede token novo.
// Nunca imprime client secret nem token. Sai com código 1 em qualquer falha.
import {
  validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste,
} from "./ifoodHomologGuard.mjs";

const falhar = (titulo, itens = []) => {
  console.error(`\n✖ ${titulo}`);
  for (const i of itens) console.error("  - " + i);
  process.exit(1);
};

const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) falhar("AMBIENTE RECUSADO (trava)", r.erros);
const prova = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (prova.length) falhar("CHAVES SUPABASE NÃO COMPROVADAS COMO DE TESTE", prova);
console.log(`✔ trava de ambiente: Supabase de TESTE (${r.resumo.supabaseRef}), fora do Render, sem apps reais.`);

// Importa só DEPOIS da trava (config/env.js lê process.env).
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");

console.log(`✔ modo de autenticação ativo: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

let pedidosDeToken = 0;
const http = { ...httpClient, postForm: (...a) => { pedidosDeToken += 1; return httpClient.postForm(...a); } };

async function descobrir() {
  return merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps: { http } });
}

let resultado;
try {
  resultado = await descobrir();
} catch (e) {
  falhar(`FALHA NA DESCOBERTA DE MERCHANTS [${e?.codigo ?? e?.name}]`, [e?.message ?? String(e), JSON.stringify(e?.details ?? {})]);
}
console.log(`✔ token centralizado obtido (client_credentials) — pedidos ao endpoint de token: ${pedidosDeToken}`);

await descobrir().catch((e) => falhar("2ª DESCOBERTA FALHOU", [e?.codigo ?? e?.message]));
console.log(`✔ cache de token: pedidos ao endpoint de token após 2 descobertas = ${pedidosDeToken} (esperado: 1)`);
if (pedidosDeToken !== 1) falhar("CACHE NÃO FUNCIONOU", [`pedidos de token: ${pedidosDeToken}`]);

console.log(`\nGET /merchants → ${resultado.total} loja(s)${resultado.truncado ? " (LISTA TRUNCADA)" : ""}:`);
for (const m of resultado.merchants) {
  console.log(`  • ${m.nome ?? "(sem nome)"} | razão: ${m.razaoSocial ?? "—"} | tipo: ${m.tipo ?? "—"} | status: ${m.status ?? "—"} | id: ${m.id}`);
}
if (resultado.total === 0) falhar("NENHUMA LOJA RETORNADA", ["O app centralizado não tem loja autorizada."]);
