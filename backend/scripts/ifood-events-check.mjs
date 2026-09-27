// CHECKPOINT B — validação técnica real de Events com o Teste (C) (centralizado).
//
//   npm run ifood:events-check              (polling real, SEM ACK, SEM banco)
//   npm run ifood:events-check -- --ack     (também envia o ACK real dos eventos recebidos)
//
// "VALIDAÇÃO TÉCNICA CENTRALIZADA" — NÃO é homologação.
//
// O que faz: token client_credentials -> GET /merchants -> exige EXATAMENTE 1 loja
// (se houver mais de uma ou nenhuma, PARA) -> 2 ciclos reais de polling
// (GET /events:polling com x-polling-merchants) -> persiste num repositório EM
// MEMÓRIA -> processa -> (opcional) ACK. O 2º ciclo prova a deduplicação: sem ACK,
// o iFood reenvia os mesmos eventos e nada é duplicado.
// NÃO toca em banco. Sem --ack não escreve nada no iFood (o ACK é o único POST).
// Nunca imprime client secret nem token.
import {
  validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste,
} from "./ifoodHomologGuard.mjs";

const ackReal = process.argv.includes("--ack");
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

const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const eventsClient = await import("../src/modules/ifood/ifoodEvents.client.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { mascararId } = await import("../src/modules/ifood/ifood.logsafe.js");
const { criarRepoEmMemoria } = await import("../test/helpers/ifood-events-fakes.js");   // repo em memória (dev-only)

console.log(`✔ modo de autenticação: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

let pedidosDeToken = 0;
const http = { ...httpClient, postForm: (...a) => { pedidosDeToken += 1; return httpClient.postForm(...a); } };

// 1) Descoberta de merchants (mesma função da tela)
let lojas;
try {
  lojas = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps: { http } });
} catch (e) {
  falhar(`FALHA NA DESCOBERTA DE MERCHANTS [${e?.codigo ?? e?.name}]`, [e?.message ?? String(e)]);
}
if (lojas.total !== 1) {
  falhar(`ESPERAVA EXATAMENTE 1 LOJA e vieram ${lojas.total} — PARANDO sem fazer polling`,
    lojas.merchants.map((m) => `${m.nome ?? "(sem nome)"} | ${m.id}`));
}
const loja = lojas.merchants[0];
console.log(`✔ loja sandbox: ${loja.nome ?? "(sem nome)"} | id ${loja.id}`);

// 2) Polling real com repositório em memória (o tenant é FICTÍCIO e só existe neste processo)
const repo = criarRepoEmMemoria({
  conexoes: [{ id: "mem-conexao", organizacao_id: "mem-org", unidade_id: "mem-unidade", merchant_id: loja.id }],
});
let acksEnviados = 0;
const client = {
  ...eventsClient,
  confirmarEventos: async (args) => {
    if (!ackReal) return { enviados: 0, simulado: true };            // SEM ACK real por padrão
    const r2 = await eventsClient.confirmarEventos({ ...args, http });
    acksEnviados += r2.enviados;
    return r2;
  },
};
const poller = criarPoller({ repo, token: tokenService, http, client, holder: `check-${process.pid}`, log: () => {} });

const resumir = () => {
  const porCodigo = {};
  for (const e of repo.eventos.values()) porCodigo[`${e.event_code}/${e.processing_status}`] = (porCodigo[`${e.event_code}/${e.processing_status}`] ?? 0) + 1;
  return porCodigo;
};

for (const n of [1, 2]) {
  let res;
  try {
    res = await poller.executarCiclo();
  } catch (e) {
    falhar(`FALHA NO CICLO ${n} [${e?.codigo ?? e?.name}]`, [e?.message ?? String(e), JSON.stringify(e?.details ?? {})]);
  }
  console.log(`\n— ciclo ${n}: estado=${res.estado} polls=${res.polls ?? 0} eventos=${res.eventos ?? 0} novos=${res.novos ?? 0} reentregas=${res.reentregas ?? 0} acks=${res.acks ?? 0}`);
}

console.log(`\nemulação: pedidos de token ao iFood = ${pedidosDeToken} (esperado: 1, cache)`);
console.log(`eventos guardados (memória): ${repo.eventos.size} ${JSON.stringify(resumir())}`);
for (const p of repo.pedidos.values()) console.log(`  pedido ${mascararId(p.order_id)} -> estado oficial: ${p.status_oficial ?? "(sem evento de status)"}`);
console.log(`ACK real enviado: ${ackReal ? `SIM (${acksEnviados} eventos)` : "NÃO (rode com --ack para enviar)"}`);
if (repo.eventos.size === 0) console.log("\n(nenhum evento pendente na loja sandbox — crie um pedido de teste para exercitar o fluxo completo)");
if (pedidosDeToken !== 1) falhar("CACHE DE TOKEN NÃO FUNCIONOU", [`pedidos de token: ${pedidosDeToken}`]);
