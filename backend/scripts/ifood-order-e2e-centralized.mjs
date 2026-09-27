// CHECKPOINT C — E2E técnico de Order Details + Confirm no BANCO DE TESTE com o Teste (C) (centralizado).
//
//   npm run ifood:order-e2e -- --merchant <merchantId> --order <orderId> --ack-real              (prepara e PARA antes do confirm)
//   npm run ifood:order-e2e -- --merchant <merchantId> --order <orderId> --ack-real --confirm-real  (envia o confirm REAL)
//   … --d1                                                                                          (Checkpoint D1 — PRÉ-READY: confirm pelo Crescer + preparação; PARA antes do readyToPickup)
//
// --d1 exige --confirm-real e a migration 103. Faz TUDO num único fluxo (sem dry-run anterior): guard -> polling -> PLACED -> detalhes ->
// salvaguardas -> confirm (1 POST) -> CFM -> detalhes OK -> elegibilidade do ready -> imprime o bloco "CHECKPOINT D1 — PRÉ-READY".
// Este script NUNCA envia readyToPickup (não importa o service de ações): o ready real é um passo separado e só com autorização.
//
// "VALIDAÇÃO TÉCNICA CENTRALIZADA" — NÃO é homologação.
//
// REQUISITOS: migration 102 aplicada no banco de TESTE e um pedido de teste NOVO (PLACED) criado no Portal do
// Parceiro sandbox. O script RECUSA confirmar qualquer pedido que não seja: do merchant/tenant do binding,
// `isTest = true`, estado oficial PLACED, detalhes já gravados e sem confirm anterior.
//
// Usa o repositório REAL, o poller REAL (com o passo de detalhes) e o service REAL — o mesmo código do worker.
// O confirm é enviado UMA vez; o estado oficial só muda quando o EVENTO CONFIRMED chegar pelo polling.
// Nunca imprime client secret, token nem dados pessoais do cliente. NUNCA apaga nada.
import { validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste } from "./ifoodHomologGuard.mjs";

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > -1 ? process.argv[i + 1] : null; };
const merchantEsperado = arg("--merchant");
const orderId = arg("--order");
const ackReal = process.argv.includes("--ack-real");
const confirmReal = process.argv.includes("--confirm-real");
const d1 = process.argv.includes("--d1");
const maxCiclos = Number(arg("--ciclos") ?? 8);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhar = (titulo, itens = []) => {
  console.error(`\n✖ ${titulo}`);
  for (const i of itens) console.error("  - " + i);
  process.exit(1);
};

if (!merchantEsperado || !orderId) falhar("informe --merchant <merchantId> --order <orderId>");
if (d1 && !confirmReal) falhar("--d1 exige --confirm-real (o confirm pelo Crescer faz parte do fluxo do D1)");
if (!ackReal) falhar("o ciclo de eventos envia o ACK REAL (consome eventos no iFood). Confirme com --ack-real");

const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) falhar("AMBIENTE RECUSADO (trava)", r.erros);
const prova = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (prova.length) falhar("CHAVES SUPABASE NÃO COMPROVADAS COMO DE TESTE", prova);
console.log(`✔ trava: Supabase ${r.resumo.supabaseRef} (teste), Render=${process.env.RENDER ? "SIM" : "NÃO"}, NODE_ENV=${process.env.NODE_ENV ?? "(vazio)"}, apps reais no ambiente=NÃO`);

const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const repoEvents = await import("../src/modules/ifood/ifoodEvents.repository.js");
const repoOrder = await import("../src/modules/ifood/ifoodOrder.repository.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { confirmarPedido, calcularSla } = await import("../src/modules/ifood/ifoodOrder.service.js");
const { avaliarElegibilidadeReady } = await import("../src/modules/ifood/ifoodOrderElegibilidade.js");
const { IFOOD_EVENTS } = await import("../src/modules/ifood/ifood.constants.js");
const { mascararId } = await import("../src/modules/ifood/ifood.logsafe.js");
const { supabase } = await import("../src/config/supabase.js");

console.log(`✔ modo de autenticação: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

// Pré-requisito: migration 102 aplicada?
const pre = await supabase.from("ifood_pedidos").select("action_state, details_status").limit(1);
if (pre.error) falhar("MIGRATION 102 NÃO ESTÁ APLICADA NO BANCO DE TESTE", [pre.error.message, "aplique database/migrations/102_ifood_pedidos_detalhes_confirm.sql (com autorização) e rode de novo"]);
console.log("✔ migration 102 presente (colunas de detalhes/ação existem)");
let migration103 = false;
if (d1) {
  const p103 = await supabase.from("ifood_pedidos").select("action_uncertain, ready_event_at").limit(1);
  const d103 = await supabase.from("ifood_disputas").select("id").limit(1);
  if (p103.error || d103.error) falhar("MIGRATION 103 NÃO ESTÁ APLICADA NO BANCO DE TESTE (necessária para o D1)", [p103.error?.message ?? d103.error?.message]);
  migration103 = true;
  console.log("✔ migration 103 presente (ações + disputas)");
}

const lojas = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps: { http: httpClient } })
  .catch((e) => falhar(`FALHA NA DESCOBERTA DE MERCHANTS [${e?.codigo ?? e?.name}]`, [e?.message]));
if (lojas.total !== 1 || lojas.merchants[0].id !== merchantEsperado) {
  falhar("MERCHANT DIVERGENTE — PARANDO", [`esperado: ${merchantEsperado}`, `API: ${lojas.merchants.map((m) => m.id).join(", ") || "(nenhum)"}`]);
}
const bindings = (await repoEvents.listarConexoesComMerchant()).filter((c) => c.merchant_id === merchantEsperado);
if (bindings.length !== 1) falhar("BINDING merchant -> unidade ausente ou ambíguo em ifood_conexoes", [`encontrados: ${bindings.length}`]);
const b = bindings[0];
console.log(`✔ binding: conexão ${mascararId(b.id)} -> unidade do tenant de homologação`);

const repo = { ...repoEvents, ...repoOrder, listarConexoesComMerchant: async () => [b] };
const holder = `order-e2e-${process.pid}`;
const poller = criarPoller({ repo, token: tokenService, http: httpClient, holder, detalhes: {} });
const tenant = { organizacaoId: b.organizacao_id, unidadeId: b.unidade_id };
const lerPedido = () => repo.obterPedidoDoTenant({ ...tenant, orderId });
const resumo = (p) => ({
  status_oficial: p.status_oficial, action_state: p.action_state, details_status: p.details_status, is_test: p.is_test,
  confirm_attempts: p.confirm_attempts, confirm_http_status: p.confirm_http_status,
});

try {
  const l = await repoEvents.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder, ttlS: IFOOD_EVENTS.leaseTtlS });
  console.log(`✔ lease REAL: adquirido=${l.adquirido} geração=${l.geracao}`);
  if (!l.adquirido) falhar("LEASE ocupado por outro poller — PARANDO", [`titular: ${l.holder}`]);

  // Ciclo 1: recebe o PLACED (se ainda não chegou), persiste, ACK e busca os detalhes.
  let c = await poller.executarCiclo();
  console.log(`\n— ciclo 1: ${c.estado} eventos=${c.eventos ?? 0} novos=${c.novos ?? 0} acks=${c.acks ?? 0} detalhes=${JSON.stringify(c.detalhes ?? null)}`);
  if (c.estado !== "OK") falhar(`CICLO 1 NÃO TERMINOU OK (${c.estado})`);

  let p = await lerPedido();
  if (!p) falhar("PEDIDO NÃO ENCONTRADO NESTE TENANT", ["o pedido não chegou por evento (crie um pedido de teste novo no Portal sandbox) ou é de outro merchant", "NADA foi confirmado"]);
  console.log(`✔ pedido ${mascararId(orderId)} no tenant: ${JSON.stringify(resumo(p))}`);

  // Um segundo ciclo cobre o caso "PLACED antes dos detalhes" (404 -> backoff).
  if (p.details_status !== "OK") {
    console.log("… detalhes ainda indisponíveis; aguardando o intervalo mínimo e tentando de novo");
    await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
    c = await poller.executarCiclo();
    p = await lerPedido();
    console.log(`— ciclo 2: ${c.estado} detalhes=${JSON.stringify(c.detalhes ?? null)} -> ${JSON.stringify(resumo(p))}`);
  }

  // Salvaguardas: só confirma pedido de TESTE, PLACED, com detalhes e sem confirm anterior.
  const problemas = [];
  if (p.is_test !== true) problemas.push(`is_test = ${p.is_test} (só confirmo pedido marcado como teste pelo iFood)`);
  if (p.status_oficial !== "PLACED") problemas.push(`estado oficial = ${p.status_oficial} (precisa ser PLACED)`);
  if (p.details_status !== "OK") problemas.push(`detalhes = ${p.details_status}`);
  if (p.action_state !== "none") problemas.push(`action_state = ${p.action_state} (já houve pedido de confirm)`);
  if (p.merchant_id !== merchantEsperado) problemas.push("merchant do pedido diferente do esperado");
  if (p.organizacao_id !== tenant.organizacaoId || p.unidade_id !== tenant.unidadeId) problemas.push("tenant do pedido diferente do binding");
  if ((p.confirm_attempts ?? 0) !== 0) problemas.push(`confirm_attempts = ${p.confirm_attempts}`);
  const prev = await supabase.from("ifood_pedido_acoes").select("id").eq("order_id", orderId).eq("acao", "confirm");
  if (prev.error || (prev.data ?? []).length) problemas.push(`ação confirm anterior registrada (${prev.error ? "erro ao consultar" : prev.data.length})`);
  const idadeMs = Date.now() - Date.parse(p.order_created_at ?? "");
  if (!Number.isFinite(idadeMs) || idadeMs > 7.5 * 60_000) problemas.push(`SLA: pedido com ${Number.isFinite(idadeMs) ? Math.round(idadeMs / 1000) + " s" : "idade desconhecida"} (limite seguro 7,5 min de 8)`);
  console.log(`  idade do pedido antes do POST: ${Number.isFinite(idadeMs) ? Math.round(idadeMs / 1000) + " s" : "?"}`);
  if (problemas.length) falhar("PEDIDO NÃO É ELEGÍVEL PARA O CONFIRM REAL — NADA FOI CONFIRMADO", problemas);
  console.log("✔ pedido elegível: teste, PLACED, detalhes gravados, sem confirm anterior");

  if (!confirmReal) {
    console.log("\nDRY-RUN: tudo pronto. Rode de novo com --confirm-real para enviar o POST /confirm (uma única vez).");
  } else {
    const tAntes = new Date().toISOString();
    console.log(`⏱ imediatamente ANTES do POST: ${tAntes}`);
    const rc = await confirmarPedido({ ...tenant, orderId, repo, token: tokenService, http: httpClient });
    const tDepois = new Date().toISOString();
    console.log(`⏱ resposta recebida: ${tDepois} (${Date.parse(tDepois) - Date.parse(tAntes)} ms)`);
    p = await lerPedido();
    globalThis.__tempos = { tAntes, tDepois };
    console.log(`\n▶ CONFIRM: resultado=${rc.resultado} HTTP=${rc.httpStatus ?? "-"} oficial=${rc.oficial}`);
    console.log(`  imediatamente após o 202: ${JSON.stringify(resumo(p))}   (esperado: PLACED + confirm_requested — 202 não é estado oficial)`);

    // Aguarda o EVENTO oficial CONFIRMED (só ele muda o estado).
    for (let i = 1; i <= maxCiclos && p.status_oficial === "PLACED"; i += 1) {
      await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
      c = await poller.executarCiclo();
      p = await lerPedido();
      console.log(`— espera ${i}/${maxCiclos}: ${c.estado} eventos=${c.eventos ?? 0} -> ${JSON.stringify(resumo(p))}`);
    }
    console.log(p.status_oficial === "CONFIRMED"
      ? "\n✔ EVENTO CONFIRMED recebido — estado oficial = CONFIRMED (veio do evento, não do 202)"
      : `\n✖ evento CONFIRMED NÃO chegou nas ${maxCiclos} esperas — estado oficial segue ${p.status_oficial} (NÃO foi marcado como confirmado)`);
    const sla = calcularSla(p);
    console.log("\nSLA:", JSON.stringify(sla, null, 2));

    if (d1) {
      // ---- PRÉ-READY: detalhes OK + elegibilidade do ready. NÃO envia ready. ----
      if (p.details_status !== "OK") {
        await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
        c = await poller.executarCiclo();
        p = await lerPedido();
      }
      const evs = await supabase.from("ifood_eventos").select("event_code, event_created_at, acknowledged_at, payload").eq("order_id", orderId).order("event_created_at");
      const cfm = (evs.data ?? []).find((e) => e.event_code === "CFM");
      const origemCfm = cfm?.payload?.metadata?.appName ?? null;
      const cfmPosterior = !!cfm && !!p.confirm_requested_at && Date.parse(cfm.event_created_at) >= Date.parse(p.confirm_requested_at);
      const aud = await supabase.from("ifood_pedido_acoes").select("acao, resultado, http_status").eq("order_id", orderId);
      const confirmPeloCrescer = rc.resultado === "SOLICITADO" && (aud.data ?? []).some((x) => x.acao === "confirm" && x.resultado === "ACEITA_202");
      const eleg = avaliarElegibilidadeReady(p);
      const entrega = p.delivery_by === "MERCHANT" ? "merchant" : p.delivery_by === "IFOOD" ? "iFood" : `outro (${p.delivery_by ?? "?"})`;
      const cfmOk = p.status_oficial === "CONFIRMED" && !!p.confirmed_event_at && !!cfm?.acknowledged_at && cfmPosterior;
      console.log(`
CHECKPOINT D1 — PRÉ-READY

Migration 103:
${migration103 ? "PASS" : "FAIL"}

Pedido:
${orderId} (displayId ${p.display_id ?? "?"})

isTest:
${p.is_test === true ? "true" : String(p.is_test)}

Tipo:
${p.order_type ?? "?"}

Entrega:
${entrega}

Confirm enviado pelo Crescer:
${confirmPeloCrescer ? "SIM" : "NÃO"}   (HTTP ${rc.httpStatus ?? "-"}, POST ${tAntes} → resposta ${tDepois})

CFM:
${cfmOk ? "PASS" : "FAIL"}   (evento criado ${cfm?.event_created_at ?? "-"}, ACK ${cfm?.acknowledged_at ? "SIM" : "NÃO"}, posterior ao nosso POST: ${cfmPosterior ? "SIM" : "NÃO"}, origem: ${origemCfm ?? "?"})

Estado oficial:
${p.status_oficial} (action_state=${p.action_state}, detalhes=${p.details_status})

Ready elegível:
${eleg.elegivel ? "SIM" : "NÃO"}${eleg.elegivel ? "" : `   (${eleg.motivo})`}

POST ready enviado:
NÃO

Produção tocada:
NÃO`);
    }
  }
} finally {
  const liberado = await poller.encerrar();
  console.log(`\n✔ lease liberado: ${liberado}`);
}
