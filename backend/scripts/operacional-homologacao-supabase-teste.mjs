// Homologação do Dashboard Operacional 2.0 no Supabase de TESTE (PostgREST + RLS reais), com o CÓDIGO REAL do backend.
//
// SÓ roda contra o projeto de teste `wiqqsxnysbzhcrzrrean` (recusa qualquer outro, inclusive a produção) e com as migrations
// 129/130 já aplicadas lá. Lê as chaves do arquivo de ambiente de TESTE informado (nunca as imprime). Não chama iFood, WhatsApp,
// IA nem nenhum serviço além do PostgREST do projeto de teste.
//
// Dados: duas empresas SINTÉTICAS "[OP2] …" com unidades de teste e pedidos/eventos/disputas sintéticos (helper dos testes;
// dados pessoais fictícios). Fechamentos e simulações são imutáveis por desenho e ficam no banco de teste como evidência; os
// pedidos/eventos/projeções sintéticos são removidos no fim (--manter para não remover).
//
// Uso: node scripts/operacional-homologacao-supabase-teste.mjs <caminho do .env.test-integracao> [--manter]
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

const PROJETO_TESTE = "wiqqsxnysbzhcrzrrean";
const PRODUCAO = "uqybgauuxcrqzquultfu";
const [arquivoEnv, ...flags] = process.argv.slice(2);
if (!arquivoEnv) { console.error("informe o arquivo de ambiente de TESTE"); process.exit(2); }
const env = Object.fromEntries(readFileSync(arquivoEnv, "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const url = env.SUPABASE_URL ?? "";
const ref = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1];
if (ref !== PROJETO_TESTE || url.includes(PRODUCAO)) { console.error(`RECUSADO: o arquivo aponta para "${ref ?? "?"}", não para o projeto de teste ${PROJETO_TESTE}.`); process.exit(2); }
if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) { console.error("RECUSADO: chaves ausentes no arquivo de teste"); process.exit(2); }
Object.assign(process.env, { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY });
for (const k of ["OPERACIONAL_DIAGNOSTICO_IA_ENABLED", "ANTHROPIC_API_KEY", "OPERACIONAL_RELATORIO_URL_BASE", "OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED"]) delete process.env[k];

const { createClient } = await import("@supabase/supabase-js");
const { supabase: svc } = await import("../src/config/supabase.js");
const operacional = await import("../src/modules/checklist-operacional/checklistOperacional.operacional.service.js");
const { gerarExcelFechamento } = await import("../src/modules/checklist-operacional/checklistOperacional.exportar.js");
const sint = await import("../test/helpers/operacional-sintetico.js");
const anon = createClient(url, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const resultados = [];
let falhas = 0;
const ok = (cond, rotulo, detalhe = "") => { resultados.push({ ok: !!cond, rotulo, detalhe: String(detalhe).slice(0, 300) }); if (!cond) falhas += 1; console.log(`${cond ? "OK   " : "FALHA"} ${rotulo}${detalhe ? ` — ${String(detalhe).slice(0, 160)}` : ""}`); };
const exigir = (r, oque) => { if (r.error) throw new Error(`${oque}: ${r.error.message}`); return r.data; };

// ---------- fixtures sintéticas ----------
const ORG_A = randomUUID(); const ORG_B = randomUUID();
const UN_A1 = randomUUID(); const UN_A2 = randomUUID(); const UN_B1 = randomUUID();
const prefixo = `op2-${Date.now().toString(36)}`;
exigir(await svc.from("organizacoes").insert([{ id: ORG_A, nome: `[OP2] Homologação A ${prefixo}` }, { id: ORG_B, nome: `[OP2] Homologação B ${prefixo}` }]).select("id"), "organizações");
exigir(await svc.from("unidades").insert([
  { id: UN_A1, organizacao_id: ORG_A, nome: "[OP2] A1", eh_teste: true }, { id: UN_A2, organizacao_id: ORG_A, nome: "[OP2] A2", eh_teste: true },
  { id: UN_B1, organizacao_id: ORG_B, nome: "[OP2] B1", eh_teste: true },
]).select("id"), "unidades");
const mapaTenant = { [`${sint.ORG_A}|${sint.UN_A1}`]: [ORG_A, UN_A1], [`${sint.ORG_A}|${sint.UN_A2}`]: [ORG_A, UN_A2], [`${sint.ORG_B}|${sint.UN_B1}`]: [ORG_B, UN_B1] };
const c = sint.cenarioPrincipal();
const novoOrder = new Map(c.pedidos.map((p) => [p.order_id, `${prefixo}-${p.order_id}`]));
const FULL = { PLC: "PLACED", CFM: "CONFIRMED", PRS: "PREPARATION_STARTED", RTP: "READY_TO_PICKUP", ADR: "ASSIGN_DRIVER", AAO: "ARRIVED_AT_ORIGIN", CLT: "COLLECTED", DSP: "DISPATCHED", AAD: "ARRIVED_AT_DESTINATION", CON: "CONCLUDED", CAN: "CANCELLED", OPA: "ORDER_PATCHED" };
const pedidos = c.pedidos.map((p) => {
  const [o, u] = mapaTenant[`${p.organizacao_id}|${p.unidade_id}`];
  const { atualizado_em: _a, ...resto } = p;
  return { ...resto, id: randomUUID(), order_id: novoOrder.get(p.order_id), organizacao_id: o, unidade_id: u, merchant_id: `${prefixo}-${p.merchant_id}`,
    details_payload: p.details_payload ? { ...p.details_payload, id: novoOrder.get(p.order_id), merchant: { ...p.details_payload.merchant, id: `${prefixo}-${p.merchant_id}` } } : null };
});
const eventosVistos = new Set();
const eventos = c.eventos.filter((e) => { if (eventosVistos.has(e.event_id)) return false; eventosVistos.add(e.event_id); return true; }).map((e) => {
  const [o, u] = mapaTenant[`${e.organizacao_id}|${e.unidade_id}`];
  const payload = { id: `${prefixo}-${e.event_id}`, code: e.event_code, fullCode: FULL[e.event_code], orderId: novoOrder.get(e.order_id), merchantId: "sintetico", createdAt: e.event_created_at, ...(e.metadata ? { metadata: e.metadata } : {}) };
  return { event_id: payload.id, merchant_id: pedidos.find((p) => p.order_id === novoOrder.get(e.order_id)).merchant_id, order_id: payload.orderId, event_code: e.event_code,
    event_full_code: FULL[e.event_code], event_created_at: e.event_created_at, organizacao_id: o, unidade_id: u, received_at: e.received_at, processing_status: "PROCESSADO",
    payload, payload_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
});
for (let i = 0; i < pedidos.length; i += 50) exigir(await svc.from("ifood_pedidos").insert(pedidos.slice(i, i + 50)).select("id"), "ifood_pedidos");
for (let i = 0; i < eventos.length; i += 100) exigir(await svc.from("ifood_eventos").insert(eventos.slice(i, i + 100)).select("event_id"), "ifood_eventos");
const disputas = c.disputas.filter((d) => mapaTenant[`${d.organizacao_id}|${d.unidade_id}`] && novoOrder.has(d.order_id)).map((d) => {
  const [o, u] = mapaTenant[`${d.organizacao_id}|${d.unidade_id}`];
  const p = pedidos.find((x) => x.order_id === novoOrder.get(d.order_id));
  const { message: _m, ...resto } = d;
  return { ...resto, dispute_id: `${prefixo}-${randomUUID()}`, order_id: p.order_id, pedido_id: p.id, organizacao_id: o, unidade_id: u, merchant_id: p.merchant_id };
});
exigir(await svc.from("ifood_disputas").insert(disputas).select("id"), "ifood_disputas");
ok(true, `fixtures sintéticas no projeto de teste: 2 empresas, 3 unidades, ${pedidos.length} pedidos, ${eventos.length} eventos, ${disputas.length} disputas`);

const T_A1 = { organizacaoId: ORG_A, unidadeId: UN_A1 };
const AGORA = () => new Date("2026-10-28T12:00:00.000Z");

// ---------- fluxo real pelo PostgREST (service_role) ----------
const f1 = await operacional.gerarFechamento({ ...T_A1, competencia: "2026-10-27", agora: AGORA, geradoPor: "homologacao-op2" });
const i = f1.fechamento.indicadores;
ok(f1.resultado === "REGISTRADO" && f1.fechamento.versao === 1, "fechamento gerado e registrado pela RPC real (v1)", `${f1.resultado} v${f1.fechamento.versao} ${f1.fechamento.status}`);
ok(i.pedidos.recebidos === 35 && i.pedidos.concluidosNoDia === 32 && i.pedidos.canceladosNoDia === 3, "pedidos 35/32/3 (mesmos números da homologação local)", JSON.stringify(i.pedidos.coorte));
ok(i.preparo.media === 16 && i.entrega.media === 13.9 && i.vida.media === 29.9 && i.preparo.amostras === 29, "tempos médios 16 / 13,9 / 29,9 com 29 amostras");
ok(i.cancelamentos.motivos[0]?.codigo === "502" && i.disputas.abertasNoDia === 2 && i.disputas.expiradasNoDia === 1 && i.descontos.loja === 32 && i.clientes.novos === 9, "cancelamentos, disputas, descontos e clientes iguais à homologação local");
ok(i.preparo.meta === null && i.atrasos.pedidosAvaliados === 0, "sem a 127 neste banco: nenhuma meta vigente — atrasos não avaliados (dito, não inventado)", f1.fechamento.fonte?.avisosDeQualidade?.[0]);
ok(f1.fechamento.fuso === "America/Sao_Paulo" && f1.fechamento.fuso_origem === "padrao_plataforma", "fuso da plataforma com origem registrada");
const f2 = await operacional.gerarFechamento({ ...T_A1, competencia: "2026-10-27", agora: AGORA, geradoPor: "homologacao-op2" });
ok(f2.resultado === "SEM_MUDANCA" && f2.fechamento.id === f1.fechamento.id, "idempotência: gerar de novo sem mudança = SEM_MUDANCA");
const [ca, cb] = await Promise.all([
  operacional.gerarFechamento({ ...T_A1, competencia: "2026-10-26", agora: AGORA, execucaoId: randomUUID() }),
  operacional.gerarFechamento({ ...T_A1, competencia: "2026-10-26", agora: AGORA, execucaoId: randomUUID() }),
]);
ok([ca.resultado, cb.resultado].sort().join(",") === "REGISTRADO,SEM_MUDANCA", "concorrência pelo PostgREST: duas gerações simultâneas do mesmo dia = uma versão", `${ca.resultado}/${cb.resultado}`);
const versoes26 = exigir(await svc.from("operacional_fechamentos").select("versao").eq("unidade_id", UN_A1).eq("competencia", "2026-10-26"), "versões 26/10");
ok(versoes26.length === 1, "uma única versão gravada para 26/10", `${versoes26.length} versão(ões)`);

const lista = await operacional.listarPedidos({ ...T_A1, filtro: { periodo: "personalizado", inicio: "2026-10-27", fim: "2026-10-27" }, agora: AGORA });
ok(lista.total === 36 && lista.projecao.falhas === 0, "lista de pedidos pela camada analítica (35 reais + 1 teste)", JSON.stringify(lista.projecao));
const s = JSON.stringify(lista);
ok(!Object.values(sint.PII).some((v) => s.includes(v)), "lista sem nenhum dado pessoal (fictício plantado)");
const alvo = lista.itens.find((x) => x.numero === "1100");
const ficha = await operacional.obterFicha({ ...T_A1, chave: alvo.chave, agora: AGORA });
ok(ficha.ficha.identificacao.numero === "1100" && ficha.ficha.historico.linhaDoTempo.length >= 9, "Ficha 360° pelo PostgREST", `${ficha.ficha.historico.linhaDoTempo.length} eventos`);
for (const [nome, t] of [["outra unidade da mesma empresa", { organizacaoId: ORG_A, unidadeId: UN_A2 }], ["outra empresa", { organizacaoId: ORG_B, unidadeId: UN_B1 }]]) {
  const r = await operacional.obterFicha({ ...t, chave: alvo.chave, agora: AGORA }).then(() => "abriu", (e) => `${e.statusCode ?? ""} ${e.message}`);
  ok(/404/.test(r), `isolamento: a ficha NÃO abre para ${nome}`, r);
  const fx = await operacional.obterFechamento({ ...t, id: f1.fechamento.id }).then(() => "abriu", (e) => `${e.statusCode ?? ""} ${e.message}`);
  ok(/404/.test(fx), `isolamento: o fechamento NÃO abre para ${nome}`, fx);
}
const outraUnidade = await operacional.gerarFechamento({ organizacaoId: ORG_A, unidadeId: UN_A2, competencia: "2026-10-27", agora: AGORA });
ok(outraUnidade.fechamento.indicadores.pedidos.recebidos === 1, "fechamento da outra unidade só enxerga o pedido dela (1)");
const proj = exigir(await svc.from("operacional_pedidos").select("order_id, unidade_id, itens").in("unidade_id", [UN_A1, UN_A2, UN_B1]), "projeções");
ok(proj.every((p) => pedidos.find((x) => x.order_id === p.order_id)?.unidade_id === p.unidade_id), "projeção gravada com o tenant correto em todas as linhas", `${proj.length} linhas`);
ok(!Object.values(sint.PII).some((v) => JSON.stringify(proj).includes(v)), "projeção gravada no banco sem dado pessoal");

// ---------- WhatsApp: somente simulação ----------
const pv = await operacional.previaWhatsapp({ ...T_A1, id: f1.fechamento.id });
ok(pv.status === "READY_FOR_REVIEW" && pv.envioReal === false && pv.transporte === "noop", "prévia pronta, transporte noop, envioReal=false", `${pv.mensagem.length} caracteres`);
const s1 = await operacional.simularWhatsapp({ ...T_A1, id: f1.fechamento.id, criadoPor: "homologacao-op2" });
const s2 = await operacional.simularWhatsapp({ ...T_A1, id: f1.fechamento.id, criadoPor: "homologacao-op2" });
ok(s1.simulacao.status === "SIMULATED" && s1.simulacao.transporte === "noop" && s2.duplicada === true, "simulação registrada uma vez; repetir não duplica");
const ins = await svc.from("operacional_mensagens_simuladas").insert({ organizacao_id: ORG_A, unidade_id: UN_A1, fechamento_id: f1.fechamento.id, fechamento_versao: 1, transporte: "baileys", status: "SIMULATED", chave_idempotencia: `${prefixo}-real` });
ok(ins.error && /check/i.test(ins.error.message), "o banco RECUSA transporte diferente de noop (mesmo para service_role)", ins.error?.message);

// ---------- imutabilidade pelo PostgREST ----------
const upd = await svc.from("operacional_fechamentos").update({ indicadores: {} }).eq("id", f1.fechamento.id);
ok(upd.error, "service_role não reescreve o conteúdo do fechamento", upd.error?.message);
const del = await svc.from("operacional_fechamentos").delete().eq("id", f1.fechamento.id);
ok(del.error, "service_role não apaga fechamento", del.error?.message);
const mov = await svc.from("operacional_fechamentos").update({ organizacao_id: ORG_B }).eq("id", f1.fechamento.id);
ok(mov.error && /não pertence/.test(mov.error.message), "service_role não move fechamento para empresa que não é a da unidade", mov.error?.message);

// ---------- Excel da versão armazenada ----------
const xlsx = gerarExcelFechamento({ fechamento: (await operacional.obterFechamento({ ...T_A1, id: f1.fechamento.id })), unidadeNome: "[OP2] A1" });
ok(xlsx.length > 5000, "Excel gerado a partir do fechamento lido pelo PostgREST", `${xlsx.length} bytes`);

// ---------- anon pelo PostgREST (HTTP real) ----------
for (const t of ["operacional_pedidos", "operacional_fechamentos", "operacional_mensagens_simuladas", "operacional_projecao_cursor", "ifood_pedidos", "ifood_eventos", "ifood_disputas", "ifood_conexoes", "ifood_credenciais"]) {
  const r = await anon.from(t).select("*").limit(1);
  ok(r.error && /permission denied|42501/i.test(`${r.error.message} ${r.error.code}`), `anon: SELECT em ${t} negado`, `${r.error?.code ?? ""} ${r.error?.message ?? `veio ${r.data?.length} linha(s)`}`);
}
const ra = await anon.rpc("operacional_fechamento_registrar", { p_organizacao_id: ORG_A, p_unidade_id: UN_A1, p_competencia: "2026-10-20", p_status: "PRELIMINAR", p_execucao_id: randomUUID(), p_regra_versao: 1, p_fuso: "x", p_fuso_origem: "x", p_origem: "manual", p_gerado_por: null, p_motivo: null, p_fonte: {}, p_cobertura: {}, p_indicadores: {}, p_diagnostico: {}, p_pendencias: [], p_hash: "h" });
ok(ra.error, "anon: RPC de fechamento negada", `${ra.error?.code ?? ""} ${ra.error?.message ?? ""}`);
const ia = await anon.from("operacional_mensagens_simuladas").insert({ organizacao_id: ORG_A, unidade_id: UN_A1, fechamento_id: f1.fechamento.id, fechamento_versao: 1, status: "SIMULATED", chave_idempotencia: `${prefixo}-anon` });
ok(ia.error, "anon: INSERT em simulações negado", ia.error?.message);
const ta = await anon.from("ifood_pedidos").delete().eq("order_id", pedidos[0].order_id);
ok(ta.error, "anon: DELETE em ifood_pedidos negado", ta.error?.message);

// ---------- limpeza dos dados mutáveis ----------
if (!flags.includes("--manter")) {
  exigir(await svc.from("operacional_pedidos").delete().in("unidade_id", [UN_A1, UN_A2, UN_B1]), "limpar projeções");
  exigir(await svc.from("ifood_eventos").delete().in("unidade_id", [UN_A1, UN_A2, UN_B1]), "limpar eventos");
  exigir(await svc.from("ifood_pedidos").delete().in("unidade_id", [UN_A1, UN_A2, UN_B1]), "limpar pedidos (disputas em cascata)");
  ok(true, "dados sintéticos mutáveis removidos; fechamentos e simulações (imutáveis) ficam como evidência nas empresas [OP2]");
}
const saida = { executadoEm: new Date().toISOString(), projeto: PROJETO_TESTE, prefixo, empresas: { ORG_A, ORG_B }, unidades: { UN_A1, UN_A2, UN_B1 }, fechamentoV1: f1.fechamento.id, total: resultados.length, falhas, resultados };
if (process.env.OPERACIONAL_HOMOLOG_SAIDA) writeFileSync(process.env.OPERACIONAL_HOMOLOG_SAIDA, JSON.stringify(saida, null, 2));
console.log(`\nTOTAL: ${resultados.length} verificações, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
