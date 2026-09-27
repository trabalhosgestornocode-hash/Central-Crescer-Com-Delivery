// CHECKPOINT D — E2E técnico das ações de pedido no BANCO DE TESTE com o Teste (C) (centralizado).
//
//   npm run ifood:order-action -- --acao <acao> --merchant <merchantId> --order <orderId> --ack-real [opções] [--enviar-real]
//
//   --acao cancel-reasons             GET /cancellationReasons (somente leitura; não exige --enviar-real)
//   --acao ready                      D1 — POST /readyToPickup
//   --acao dispatch                   D2 — POST /dispatch (só DELIVERY própria, depois do evento READY_TO_PICKUP)
//   --acao cancel --motivo <code>     D3 — POST /requestCancellation (code vindo de cancellationReasons)
//   --acao dispute-status             D4 — lista as negociações (Handshake) do pedido/tenant
//   --acao dispute-accept|dispute-reject|dispute-alternative --dispute <id> [--reason X] [--tipo REFUND --valor 200 | --tipo ADDITIONAL_TIME --minutos 30 --motivo-atraso X]
//
// "VALIDAÇÃO TÉCNICA CENTRALIZADA" — NÃO é homologação. SEM `--enviar-real` o script é um DRY-RUN: prepara, valida e PARA
// antes de qualquer POST. Cada execução com `--enviar-real` envia a ação UMA vez (nunca repete) e depois espera o EVENTO oficial.
//
// Salvaguardas obrigatórias antes de qualquer POST (qualquer falha => exit 1, nada enviado):
//   ambiente = teste-multiempresarial (Supabase de TESTE), Render = NÃO, NODE_ENV != production, sem apps reais,
//   isTest = true, merchant = o informado (única loja do app), tenant = o do binding, detalhes OK,
//   migration 103 presente, elegibilidade local da ação (estado oficial + tipo), sem ação pendente do mesmo pedido.
// Usa o repositório REAL, o poller REAL e os services REAIS (o mesmo código do worker). Nunca imprime segredo, token
// nem dados pessoais. NUNCA apaga nada.
import { validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste } from "./ifoodHomologGuard.mjs";

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > -1 ? process.argv[i + 1] : null; };
const acao = arg("--acao");
const merchantEsperado = arg("--merchant");
const orderId = arg("--order");
const motivo = arg("--motivo");
const disputeId = arg("--dispute");
const ackReal = process.argv.includes("--ack-real");
const enviarReal = process.argv.includes("--enviar-real");
const maxCiclos = Number(arg("--ciclos") ?? 6);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhar = (titulo, itens = []) => {
  console.error(`\n✖ ${titulo}`);
  for (const i of itens) console.error("  - " + i);
  process.exit(1);
};

const ACOES = ["cancel-reasons", "ready", "dispatch", "cancel", "dispute-status", "dispute-accept", "dispute-reject", "dispute-alternative"];
if (!ACOES.includes(acao)) falhar(`informe --acao (${ACOES.join(" | ")})`);
if (!merchantEsperado) falhar("informe --merchant <merchantId>");
if (!orderId && !acao.startsWith("dispute")) falhar("informe --order <orderId>");
if (acao.startsWith("dispute-") && acao !== "dispute-status" && !disputeId) falhar("informe --dispute <disputeId>");
if (acao === "cancel" && !motivo) falhar("informe --motivo <code> (use antes --acao cancel-reasons)");
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
const acoes = await import("../src/modules/ifood/ifoodOrderActions.service.js");
const handshake = await import("../src/modules/ifood/ifoodHandshake.service.js");
const { IFOOD_EVENTS } = await import("../src/modules/ifood/ifood.constants.js");
const { mascararId } = await import("../src/modules/ifood/ifood.logsafe.js");
const { supabase } = await import("../src/config/supabase.js");

console.log(`✔ modo de autenticação: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

const pre = await supabase.from("ifood_pedidos").select("action_uncertain, action_state").limit(1);
if (pre.error) falhar("MIGRATION 103 NÃO ESTÁ APLICADA NO BANCO DE TESTE", [pre.error.message, "aplique database/migrations/103_ifood_order_actions.sql (com autorização) e rode de novo"]);
const pre2 = await supabase.from("ifood_disputas").select("id").limit(1);
if (pre2.error) falhar("TABELA ifood_disputas AUSENTE (migration 103)", [pre2.error.message]);
console.log("✔ migration 103 presente (ações + disputas)");

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
const holder = `order-action-${process.pid}`;
const poller = criarPoller({ repo, token: tokenService, http: httpClient, holder, detalhes: {} });
const tenant = { organizacaoId: b.organizacao_id, unidadeId: b.unidade_id };
const lerPedido = () => repo.obterPedidoDoTenant({ ...tenant, orderId });
const resumo = (p) => ({
  tipo: p.order_type, entrega: p.delivery_by, status_oficial: p.status_oficial, action_state: p.action_state, uncertain: p.action_uncertain,
  attempts: p.action_attempts, ready_at: p.ready_event_at, dispatch_at: p.dispatch_event_at, cancel_at: p.cancel_event_at,
});
const ciclo = async (n) => {
  const c = await poller.executarCiclo();
  console.log(`— ciclo ${n}: ${c.estado} eventos=${c.eventos ?? 0} novos=${c.novos ?? 0} acks=${c.acks ?? 0} detalhes=${JSON.stringify(c.detalhes ?? null)}`);
  if (c.estado !== "OK") falhar(`CICLO ${n} NÃO TERMINOU OK (${c.estado})`);
};

try {
  const l = await repoEvents.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder, ttlS: IFOOD_EVENTS.leaseTtlS });
  console.log(`✔ lease REAL: adquirido=${l.adquirido} geração=${l.geracao}`);
  if (!l.adquirido) falhar("LEASE ocupado por outro poller — PARANDO", [`titular: ${l.holder}`]);
  await ciclo(1);

  // ---------------- Handshake: só leitura / resposta ----------------
  if (acao === "dispute-status") {
    const ds = await repo.listarDisputasDoTenant({ ...tenant });
    console.log(`\nnegociações do tenant: ${ds.length}`);
    for (const d of ds) console.log(`  ${mascararId(d.dispute_id)} pedido=${mascararId(d.order_id)} tipo=${d.handshake_type} ação=${d.action} status=${d.status} expira=${d.expires_at} timeout=${d.timeout_action} alternativas=${(d.alternatives ?? []).map((x) => x.type).join(",") || "-"} settlement=${d.settlement_status ?? "-"}`);
  } else if (acao.startsWith("dispute-")) {
    let d = await repo.obterDisputaDoTenant({ ...tenant, disputeId });
    if (!d) falhar("NEGOCIAÇÃO NÃO ENCONTRADA NESTE TENANT", ["nada foi enviado"]);
    const pedido = await repo.obterPedidoDoTenant({ ...tenant, orderId: d.order_id });
    const prob = [];
    if (pedido?.is_test !== true) prob.push(`is_test = ${pedido?.is_test}`);
    if (pedido?.merchant_id !== merchantEsperado) prob.push("merchant do pedido diferente do esperado");
    if (d.status !== "ABERTA" && d.status !== "RESPOSTA_FALHOU") prob.push(`status da negociação = ${d.status} (precisa estar ABERTA)`);
    if (prob.length) falhar("NEGOCIAÇÃO NÃO ELEGÍVEL — NADA FOI ENVIADO", prob);
    console.log(`✔ negociação elegível: tipo=${d.handshake_type} expira=${d.expires_at} timeoutAction=${d.timeout_action}`);
    if (!enviarReal) console.log("\nDRY-RUN: rode de novo com --enviar-real para responder (uma única vez).");
    else {
      const decisao = acao === "dispute-accept" ? "ACCEPT" : acao === "dispute-reject" ? "REJECT" : "ALTERNATIVE";
      const alt = decisao === "ALTERNATIVE"
        ? (arg("--tipo") === "ADDITIONAL_TIME"
          ? { type: "ADDITIONAL_TIME", metadata: { additionalTimeInMinutes: Number(arg("--minutos")), additionalTimeReason: arg("--motivo-atraso") } }
          : { type: arg("--tipo"), metadata: { amount: { value: String(arg("--valor")), currency: "BRL" } } })
        : null;
      console.log(`⏱ ANTES do POST: ${new Date().toISOString()}`);
      const rr = await handshake.responderDisputa({ ...tenant, disputeId, decisao, reason: arg("--reason"), alternativa: alt, repo, token: tokenService, http: httpClient });
      console.log(`⏱ resposta: ${new Date().toISOString()}  ▶ ${JSON.stringify(rr)}`);
      for (let i = 1; i <= maxCiclos; i += 1) {
        d = await repo.obterDisputaDoTenant({ ...tenant, disputeId });
        if (d.status === "ENCERRADA") break;
        await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
        await ciclo(i + 1);
      }
      d = await repo.obterDisputaDoTenant({ ...tenant, disputeId });
      console.log(`\nnegociação: status=${d.status} decisão=${d.decision} http=${d.decision_http_status} settlement=${d.settlement_status ?? "(ainda não recebido)"}`);
    }
  } else {
    // ---------------- ações de pedido ----------------
    let p = await lerPedido();
    if (!p) falhar("PEDIDO NÃO ENCONTRADO NESTE TENANT", ["o pedido não chegou por evento (crie um pedido de teste no Portal sandbox) ou é de outro merchant", "NADA foi enviado"]);
    if (p.details_status !== "OK") { await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000); await ciclo(2); p = await lerPedido(); }
    console.log(`✔ pedido ${mascararId(orderId)} no tenant: ${JSON.stringify(resumo(p))}`);

    const problemas = [];
    if (p.is_test !== true) problemas.push(`is_test = ${p.is_test} (só ajo em pedido marcado como teste pelo iFood)`);
    if (p.merchant_id !== merchantEsperado) problemas.push("merchant do pedido diferente do esperado");
    if (p.organizacao_id !== tenant.organizacaoId || p.unidade_id !== tenant.unidadeId) problemas.push("tenant do pedido diferente do binding");
    if (p.details_status !== "OK") problemas.push(`detalhes = ${p.details_status}`);
    if (problemas.length) falhar("PEDIDO NÃO É ELEGÍVEL — NADA FOI ENVIADO", problemas);

    if (acao === "cancel-reasons") {
      const lista = await acoes.listarMotivosCancelamento({ ...tenant, orderId, repo, token: tokenService, http: httpClient });
      console.log(`\nmotivos OFICIAIS (${lista.length}):`);
      for (const m of lista) console.log(`  ${m.code} — ${m.description ?? "(sem descrição)"}`);
    } else {
      // elegibilidade LOCAL (estado oficial + tipo) — a mesma regra que o service aplica antes de qualquer POST
      const nome = acao === "ready" ? "ready" : acao === "dispatch" ? "dispatch" : "cancel";
      let eleg;
      try { eleg = acoes.avaliarElegibilidade(nome, p); } catch (e) { falhar("AÇÃO NÃO ELEGÍVEL — NADA FOI ENVIADO", [`${e.codigo}: ${JSON.stringify(e.details ?? {})}`]); }
      if (eleg.tipo !== "OK") falhar(`AÇÃO NÃO EXECUTÁVEL AGORA (${eleg.tipo}) — NADA FOI ENVIADO`, [eleg.motivo ?? ""]);
      if (!["none", `${nome}_failed`].includes(p.action_state)) falhar("HÁ AÇÃO PENDENTE NESTE PEDIDO — NADA FOI ENVIADO", [`action_state = ${p.action_state}`]);
      console.log(`✔ elegível para ${nome}: estado oficial ${p.status_oficial}, tipo ${p.order_type}, entrega ${p.delivery_by}`);

      if (!enviarReal) {
        console.log(`\nDRY-RUN: tudo pronto. Rode de novo com --enviar-real para enviar ${nome} (uma única vez).`);
      } else {
        const fn = nome === "ready" ? acoes.notificarPronto : nome === "dispatch" ? acoes.despachar : acoes.cancelar;
        const tAntes = new Date().toISOString();
        console.log(`⏱ imediatamente ANTES do POST: ${tAntes}`);
        const res = await fn({ ...tenant, orderId, repo, token: tokenService, http: httpClient, motivo });
        console.log(`⏱ resposta: ${new Date().toISOString()}`);
        p = await lerPedido();
        console.log(`\n▶ ${nome.toUpperCase()}: resultado=${res.resultado} HTTP=${res.httpStatus ?? "-"} incerto=${!!res.incerto}`);
        console.log(`  imediatamente após: ${JSON.stringify(resumo(p))}   (esperado: estado oficial INALTERADO + ${nome}_requested — o HTTP não é o estado oficial)`);

        const inicial = p.status_oficial;
        for (let i = 1; i <= maxCiclos && p.action_state !== "none" && p.action_state !== `${nome}_failed`; i += 1) {
          await dormir(IFOOD_EVENTS.intervaloMinimoMs + 1000);
          await ciclo(i + 1);
          p = await lerPedido();
          console.log(`  espera ${i}/${maxCiclos}: ${JSON.stringify(resumo(p))}`);
        }
        const evs = await supabase.from("ifood_eventos").select("event_code, event_created_at, acknowledged_at, processing_status").eq("order_id", orderId).order("event_created_at");
        console.log("\neventos do pedido:");
        for (const e of evs.data ?? []) console.log(`  ${e.event_code} ${e.event_created_at} ack=${e.acknowledged_at ? "SIM" : "NÃO"} ${e.processing_status}`);
        console.log(p.status_oficial !== inicial || p.action_state === "none"
          ? `\n✔ evento oficial recebido — estado oficial agora = ${p.status_oficial} (veio do evento, não do HTTP)`
          : `\n✖ nenhum evento resolveu a ação nas ${maxCiclos} esperas — estado oficial segue ${p.status_oficial}; action_state=${p.action_state} (NADA foi inventado)`);
      }
    }
  }
} finally {
  const liberado = await poller.encerrar();
  console.log(`\n✔ lease liberado: ${liberado}`);
}
