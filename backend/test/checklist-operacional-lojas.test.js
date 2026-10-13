// Checklist Operacional — ORIGEM por loja iFood (Sanduíches + Saladas na mesma unidade). Sem banco e sem rede.
//
// Prova: com UMA loja a resposta é IDÊNTICA à de antes (nenhum campo novo); com duas, os pedidos aparecem juntos e consolidados
// (sem duplicar), cada um com a origem, e a contagem por loja soma exatamente o total da unidade; loja cadastrada mas ainda não
// recebida gera aviso; falha ao ler as lojas nunca derruba o Checklist; nenhum merchant_id vaza na resposta.
//
// Rodar: node --experimental-vm-modules --test test/checklist-operacional-lojas.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const service = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
const { rotuloCurtoDaLoja, montarLojas } = await import("../src/modules/checklist-operacional/checklistOperacional.lojas.js");
const { COLUNAS_PEDIDO_CHECKLIST } = await import("../src/modules/checklist-operacional/checklistOperacional.repository.js");

const AGORA = new Date("2026-10-09T15:00:00.000Z");
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const ORG = "11111111-1111-4111-8111-111111111111";
const UN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CON = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M_SAND = "a6e54f00-0000-4000-8000-0000000039b9";
const M_SAL = "04a17bf5-b9e6-4693-a862-a5715e9f9374";

let seq = 0;
const pedido = (merchant, over = {}) => ({
  merchant_id: merchant, order_id: `ord-${(seq += 1)}`, display_id: String(1000 + seq),
  status_oficial: "CONCLUDED", status_oficial_em: iso(20), order_type: "DELIVERY", delivery_by: "MERCHANT", order_timing: "IMMEDIATE",
  is_test: false, order_created_at: iso(60), placed_event_created_at: iso(60), confirmed_event_at: iso(59), ready_event_at: iso(49),
  dispatch_event_at: iso(45), cancel_event_at: null, primeiro_evento_em: iso(60), criado_em: iso(60), ...over,
});
const ativo = (merchant, status = "CONFIRMED") => pedido(merchant, { status_oficial: status, status_oficial_em: iso(5), ready_event_at: null, dispatch_event_at: null });

const CONEXAO = { id: CON, organizacao_id: ORG, unidade_id: UN, merchant_id: M_SAND, merchant_nome: null, status: "ativa" };

function repos({ pedidos, extras = [], nomes = new Map(), semFuncoesDeLojas = false, falhaLojas = false }) {
  const chamadas = [];
  const repo = {
    LIMITE_LINHAS: 2000,
    listarPedidosDaJanela: async () => pedidos.map((p) => ({ ...p })),
    contarAbertosAntesDe: async () => 0,
  };
  if (!semFuncoesDeLojas) {
    repo.listarLojasExtras = async (args) => { chamadas.push(["extras", args]); if (falhaLojas) throw new Error('relation "ifood_conexao_lojas" does not exist'); return extras.map((x) => ({ ...x })); };
    repo.obterNomesDasLojas = async (args) => { chamadas.push(["nomes", args]); if (falhaLojas) throw new Error("falha"); return nomes; };
  }
  const ifoodRepo = {
    obterConexaoViva: async () => ({ ...CONEXAO }),
    listarCredenciaisDaConexao: async () => [{ app_type: "order", status: "ativa" }],
    obterObservabilidadeOrder: async () => ({ disponivel: true, ultimoEvento: iso(1), eventosComFalha: 0, lease: { atualizadoEm: iso(0.2), leaseAte: new Date(AGORA.getTime() + 60_000).toISOString() } }),
  };
  return { repo, ifoodRepo, chamadas };
}
const resumo = (r) => service.obterResumo({ organizacaoId: ORG, unidadeId: UN, agora: () => AGORA, deps: { repo: r.repo, ifoodRepo: r.ifoodRepo, pilotoOrder: () => true, env: {} } });

test("rotuloCurtoDaLoja: nome curto a partir do nome que o iFood informa", () => {
  assert.equal(rotuloCurtoDaLoja("Subway Sanduíches - Saci"), "Sanduíches");
  assert.equal(rotuloCurtoDaLoja("Subway Saladas - Saci"), "Saladas");
  assert.equal(rotuloCurtoDaLoja("  Subway   Saladas  –  Saci  Matriz "), "Saladas");
  assert.equal(rotuloCurtoDaLoja("Loja do Zé"), "Loja do Zé");
  assert.equal(rotuloCurtoDaLoja("Subway"), "Subway");
  assert.equal(rotuloCurtoDaLoja(""), null);
  assert.equal(rotuloCurtoDaLoja(null), null);
  assert.equal(rotuloCurtoDaLoja("x".repeat(80)).length, 40);
});

test("a coluna merchant_id entra na lista positiva do Checklist (só para agrupar no servidor); PII continua fora", () => {
  assert.match(COLUNAS_PEDIDO_CHECKLIST, /\bmerchant_id\b/);
  assert.doesNotMatch(COLUNAS_PEDIDO_CHECKLIST, /customer|payments|items|delivery\b|details_payload|pickup_code/);
});

test("UMA loja: a resposta é IDÊNTICA à de antes — sem `lojas`, sem `loja` nos pedidos, sem aviso novo", async () => {
  const pedidos = [pedido(M_SAND), pedido(M_SAND), ativo(M_SAND), ativo(M_SAND, "DISPATCHED")];
  const com = await resumo(repos({ pedidos }));
  const sem = await resumo(repos({ pedidos, semFuncoesDeLojas: true }));        // repositório da versão anterior
  assert.deepEqual(com, sem, "com ou sem as funções de lojas, a resposta é a mesma");
  assert.equal("lojas" in com, false);
  assert.ok([...com.pedidosAtivos, ...com.ultimosPedidos].every((p) => !("loja" in p)));
  assert.equal(com.alertas.some((a) => a.codigo === "loja_sem_recebimento"), false);
  assert.equal(com.contagemDia.recebidos, 4);
});

test("DUAS lojas: pedidos juntos, consolidados e SEM duplicar; cada um com a origem; a contagem por loja soma o total", async () => {
  const pedidos = [pedido(M_SAND), pedido(M_SAND), ativo(M_SAND), pedido(M_SAL), ativo(M_SAL), ativo(M_SAL, "DISPATCHED"), pedido(M_SAL, { status_oficial: "CANCELLED", status_oficial_em: iso(30), cancel_event_at: iso(30) })];
  const r = repos({
    pedidos,
    extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "ativa" }],
    nomes: new Map([[M_SAND, "Subway Sanduíches - Saci"], [M_SAL, "Subway Saladas - Saci"]]),
  });
  const res = await resumo(r);

  assert.equal(res.contagemDia.recebidos, 7);
  assert.equal(res.contagemDia.emAndamento, 3);
  assert.equal(res.contagemDia.cancelados, 1);
  assert.equal(res.pedidosAtivos.length, 3);

  const rot = (p) => p.loja?.rotulo;
  assert.deepEqual([...new Set(res.pedidosAtivos.map(rot))].sort(), ["Saladas", "Sanduíches"]);
  assert.equal(res.pedidosAtivos.filter((p) => rot(p) === "Saladas").length, 2);
  assert.ok([...res.pedidosAtivos, ...res.ultimosPedidos].every((p) => rot(p)), "todo pedido tem origem");

  assert.deepEqual(res.lojas.map((l) => [l.rotulo, l.principal, l.estado, l.contagemDia.recebidos, l.contagemDia.emAndamento]),
    [["Sanduíches", true, "ativa", 3, 1], ["Saladas", false, "ativa", 4, 2]]);
  assert.equal(res.lojas.reduce((s, l) => s + l.contagemDia.recebidos, 0), res.contagemDia.recebidos, "as lojas somam exatamente o total");
  assert.equal(res.lojas.reduce((s, l) => s + l.contagemDia.emAndamento, 0), res.contagemDia.emAndamento);
  assert.equal(res.alertas.some((a) => a.codigo === "loja_sem_recebimento"), false, "loja ativa: sem aviso");

  // Nenhum identificador de merchant nem nome inteiro do iFood na resposta.
  const texto = JSON.stringify(res);
  assert.ok(!texto.includes(M_SAND) && !texto.includes(M_SAL) && !texto.includes("Saci"));
  assert.ok(!("merchant_id" in res.pedidosAtivos[0]));
});

test("isolamento: as lojas são lidas com organização + unidade + conexão DO CONTEXTO (nunca de fora)", async () => {
  const r = repos({ pedidos: [pedido(M_SAND)], extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "ativa" }] });
  await resumo(r);
  const extras = r.chamadas.find(([nome]) => nome === "extras")[1];
  assert.deepEqual(extras, { organizacaoId: ORG, unidadeId: UN, conexaoId: CON });
});

test("rótulos: o configurado vence; sem ele usa o nome curto que o iFood informa; repetidos ganham número; sem nada, genérico", () => {
  const pedidos = [pedido(M_SAND), pedido(M_SAL)];
  const a = montarLojas({ pedidos, conexao: CONEXAO, extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "ativa" }], nomes: new Map([[M_SAND, "Subway Sanduíches - Saci"]]), agoraMs: AGORA.getTime() });
  assert.deepEqual(a.lojas.map((l) => l.rotulo), ["Sanduíches", "Saladas"]);
  const b = montarLojas({ pedidos, conexao: CONEXAO, extras: [{ merchant_id: M_SAL, rotulo: null, estado: "ativa" }], nomes: new Map([[M_SAND, "Subway Loja - A"], [M_SAL, "Subway Loja - B"]]), agoraMs: AGORA.getTime() });
  assert.deepEqual(b.lojas.map((l) => l.rotulo), ["Loja", "Loja 2"]);
  const c = montarLojas({ pedidos, conexao: CONEXAO, extras: [{ merchant_id: M_SAL, rotulo: null, estado: "ativa" }], nomes: new Map(), agoraMs: AGORA.getTime() });
  assert.deepEqual(c.lojas.map((l) => l.rotulo), ["Loja principal", "Loja adicional"]);
  const d = montarLojas({ pedidos, conexao: { ...CONEXAO, merchant_nome: "Sanduíches da Matriz" }, extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "ativa" }], agoraMs: AGORA.getTime() });
  assert.equal(d.lojas[0].rotulo, "Sanduíches da Matriz");
});

test("loja cadastrada mas AINDA NÃO recebida (pendente / em verificação / bloqueada) gera aviso — a equipe não pode achar que a lista está completa", async () => {
  for (const [estado, trecho] of [["pendente", "aguardando liberação"], ["liberada", "em verificação"], ["bloqueada", "autorização do iFood não confirmada"]]) {
    const res = await resumo(repos({ pedidos: [pedido(M_SAND), ativo(M_SAND)], extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado }] }));
    const aviso = res.alertas.find((a) => a.codigo === "loja_sem_recebimento");
    assert.ok(aviso, estado);
    assert.equal(aviso.nivel, "atencao");
    assert.match(aviso.texto, /Saladas/);
    assert.match(aviso.texto, /NÃO estão chegando/);
    assert.ok(aviso.texto.includes(trecho), aviso.texto);
    assert.equal(res.lojas.find((l) => l.rotulo === "Saladas").contagemDia.recebidos, 0);
    assert.equal(res.contagemDia.recebidos, 2, "o total da unidade não muda");
  }
});

test("loja desativada não aparece nem avisa; pedidos antigos dela, já gravados, seguem contados (nada some)", async () => {
  const res = await resumo(repos({ pedidos: [pedido(M_SAND), pedido(M_SAL)], extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "desativada" }] }));
  assert.equal(res.contagemDia.recebidos, 2);
  assert.equal(res.alertas.some((a) => a.codigo === "loja_sem_recebimento"), false);
  assert.equal(res.lojas.find((l) => l.contagemDia.recebidos === 1 && !l.principal).estado, "encerrada");
});

test("falha ao ler as lojas (tabela inexistente) NUNCA derruba o Checklist: resposta como a de uma loja só", async () => {
  const pedidos = [pedido(M_SAND), ativo(M_SAND)];
  const res = await resumo(repos({ pedidos, falhaLojas: true }));
  const base = await resumo(repos({ pedidos, semFuncoesDeLojas: true }));
  assert.deepEqual(res, base);
});

test("indicadores consolidados: as médias de preparo/entrega consideram os pedidos das duas lojas", async () => {
  const so = await resumo(repos({ pedidos: [pedido(M_SAND), pedido(M_SAND)] }));
  const dois = await resumo(repos({ pedidos: [pedido(M_SAND), pedido(M_SAND), pedido(M_SAL), pedido(M_SAL)], extras: [{ merchant_id: M_SAL, rotulo: "Saladas", estado: "ativa" }] }));
  assert.equal(dois.indicadores.preparo.amostras, 4);
  assert.equal(so.indicadores.preparo.amostras, 2);
  assert.equal(dois.indicadores.preparo.mediaDia, so.indicadores.preparo.mediaDia, "mesmos tempos => mesma média");
});
