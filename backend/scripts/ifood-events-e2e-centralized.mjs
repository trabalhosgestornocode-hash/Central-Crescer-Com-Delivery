// CHECKPOINT B — E2E técnico de Events no BANCO DE TESTE com o Teste (C) (centralizado).
//
//   npm run ifood:events-e2e -- --merchant <merchantId> --ack-real
//
// "VALIDAÇÃO TÉCNICA CENTRALIZADA" — NÃO é homologação.
//
// Faz, na ordem (usa o repositório REAL e o poller REAL — o mesmo código do worker):
//   1. trava de ambiente (Supabase de TESTE, fora do Render, NODE_ENV != production, sem apps reais);
//   2. confirma que o merchant do argumento é a ÚNICA loja do app centralizado e tem
//      binding em ifood_conexoes (o tenant vem SEMPRE dali);
//   3. lease REAL (ifood_lease_adquirir) -> polling REAL -> persiste em ifood_eventos ->
//      processa (ifood_pedidos) -> renova o lease -> ACK REAL (só depois de persistir);
//   4. espera o intervalo mínimo permitido (30 s) e faz NOVO polling: o que foi
//      reconhecido NÃO pode voltar;
//   5. libera o lease. NUNCA apaga nada.
// Exige --ack-real (o ACK consome os eventos no iFood: não há volta).
// Nunca imprime client secret nem token.
import {
  validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste,
} from "./ifoodHomologGuard.mjs";

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > -1 ? process.argv[i + 1] : null; };
const merchantEsperado = arg("--merchant");
const ackReal = process.argv.includes("--ack-real");
const esperas = Number(arg("--ciclos-extras") ?? 1);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhar = (titulo, itens = []) => {
  console.error(`\n✖ ${titulo}`);
  for (const i of itens) console.error("  - " + i);
  process.exit(1);
};

if (!merchantEsperado) falhar("informe --merchant <merchantId>");
if (!ackReal) falhar("este E2E envia o ACK REAL (consome os eventos no iFood). Confirme com --ack-real");

// 1) trava de ambiente
const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) falhar("AMBIENTE RECUSADO (trava)", r.erros);
const prova = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (prova.length) falhar("CHAVES SUPABASE NÃO COMPROVADAS COMO DE TESTE", prova);
console.log(`✔ trava: Supabase ${r.resumo.supabaseRef} (teste), Render=${process.env.RENDER ? "SIM" : "NÃO"}, NODE_ENV=${process.env.NODE_ENV ?? "(vazio)"}, apps reais no ambiente=NÃO`);

const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const repoReal = await import("../src/modules/ifood/ifoodEvents.repository.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { IFOOD_EVENTS } = await import("../src/modules/ifood/ifood.constants.js");

console.log(`✔ modo de autenticação: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

let pedidosDeToken = 0;
const http = { ...httpClient, postForm: (...a) => { pedidosDeToken += 1; return httpClient.postForm(...a); } };

// 2) o merchant do argumento é a única loja do app?
const lojas = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps: { http } })
  .catch((e) => falhar(`FALHA NA DESCOBERTA DE MERCHANTS [${e?.codigo ?? e?.name}]`, [e?.message]));
if (lojas.total !== 1 || lojas.merchants[0].id !== merchantEsperado) {
  falhar("MERCHANT DIVERGENTE — PARANDO", [`esperado: ${merchantEsperado}`, `API: ${lojas.merchants.map((m) => m.id).join(", ") || "(nenhum)"}`]);
}
console.log(`✔ merchant: ${merchantEsperado} é a ÚNICA loja do app centralizado`);

// binding (ifood_conexoes) -> tenant
const todas = await repoReal.listarConexoesComMerchant();
const bindings = todas.filter((c) => c.merchant_id === merchantEsperado);
if (bindings.length !== 1) falhar("BINDING merchant -> unidade ausente ou ambíguo em ifood_conexoes", [`encontrados: ${bindings.length}`]);
const b = bindings[0];
console.log(`✔ binding: conexão ${b.id} -> organização ${b.organizacao_id} / unidade ${b.unidade_id}`);

// Só ESTE merchant participa (outras conexões, se existirem, ficam de fora do teste).
const repo = { ...repoReal, listarConexoesComMerchant: async () => [b] };

const holder = `e2e-${process.pid}`;
const poller = criarPoller({ repo, token: tokenService, http, holder });

const mostrar = (n, res) => console.log(`\n— ciclo ${n}: estado=${res.estado} polls=${res.polls ?? 0} eventos=${res.eventos ?? 0} novos=${res.novos ?? 0} reentregas=${res.reentregas ?? 0} acks=${res.acks ?? 0}`);

try {
  // 3) lease real + polling real + persistência + ACK real
  const l = await repoReal.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder, ttlS: IFOOD_EVENTS.leaseTtlS });
  console.log(`✔ lease REAL: adquirido=${l.adquirido} holder=${l.holder} geração=${l.geracao} até ${l.leaseAte}`);
  if (!l.adquirido) falhar("LEASE ocupado por outro poller — PARANDO", [`titular: ${l.holder}`]);

  const c1 = await poller.executarCiclo();
  mostrar(1, c1);
  if (c1.estado !== "OK") falhar(`CICLO 1 NÃO TERMINOU OK (${c1.estado})`);

  // 4) espera o próximo ciclo permitido e faz NOVO polling
  for (let i = 1; i <= esperas; i += 1) {
    console.log(`\n… aguardando ${IFOOD_EVENTS.intervaloMinimoMs / 1000 + 1}s (intervalo mínimo entre pollings)…`);
    await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
    const cn = await poller.executarCiclo();
    mostrar(1 + i, cn);
    if (cn.estado !== "OK") falhar(`CICLO ${1 + i} NÃO TERMINOU OK (${cn.estado})`);
  }
} finally {
  const liberado = await poller.encerrar();
  console.log(`\n✔ lease liberado: ${liberado}`);
}
console.log(`pedidos de token ao iFood (total do script): ${pedidosDeToken} (esperado 1: cache do token em memória)`);
