// CMV teórico iFood — núcleo puro: vínculo por evidência, cobertura, indisponibilidade e isolamento por grafo.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
const { calcularCmvTeorico, vincularItem, indexarProdutos } = await import("../src/modules/dashboard-executivo/cmvTeorico.calc.js");
const { validarPeriodo } = await import("../src/modules/dashboard-executivo/cmvTeorico.service.js");

const ins = (id, preco) => [id, { id, nome: id, tipo: "outro", unidade_medida: "g", preco_unitario: preco, ativo: true }];
function grafo(insumos, fichas, rend = {}, homo = {}) {
  const fichaByProd = new Map();
  for (const f of fichas) { const l = fichaByProd.get(f.produto_id) ?? []; l.push({ ativo: true, ...f }); fichaByProd.set(f.produto_id, l); }
  return { insumoById: new Map(insumos), fichaByProd, nomeProdById: new Map(), produtos: [], rendimentoById: new Map(Object.entries(rend)), homologacaoById: new Map(Object.entries(homo)) };
}
const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
const ped = (...items) => ({ order_id: Math.random().toString(36), items });
const it = (name, quantity, price, extra = {}) => ({ name, quantity, price, ...extra });

const produtos = [
  { id: "cap", nome: "Cappuccino", codigo_pdv: "CAP01", vendavel: true, ativo: true },
  { id: "bolo", nome: "Bolo de Cenoura", codigo_pdv: null, vendavel: true, ativo: true },
  { id: "tap1", nome: "Crepe Simples", codigo_pdv: null, vendavel: true, ativo: true },
  { id: "tap2", nome: "Crepe Simples", codigo_pdv: null, vendavel: true, ativo: true },
  { id: "inativo", nome: "Antigo", codigo_pdv: "OLD", vendavel: true, ativo: false },
  { id: "prep", nome: "Calda", codigo_pdv: "CALDA", vendavel: false, ativo: true },
];
const G = () => grafo([ins("cafe", 0.04), ins("farinha", 0.01)], [
  { produto_id: "cap", insumo_id: "cafe", quantidade: 20 },      // R$ 0,80
  { produto_id: "bolo", insumo_id: "farinha", quantidade: 300 }, // R$ 3,00
]);

test("vínculo por evidência: código PDV, nome único; nome repetido => ambíguo; inativo/preparação não vinculam", () => {
  const idx = indexarProdutos(produtos);
  assert.equal(vincularItem({ codigo: "cap01", nome: "qualquer" }, idx).produto.id, "cap");
  assert.equal(vincularItem({ codigo: null, nome: "BOLO DE CENOURA" }, idx).produto.id, "bolo");
  assert.equal(vincularItem({ codigo: null, nome: "crepe simples" }, idx).motivo, "nome_ambiguo");
  assert.equal(vincularItem({ codigo: "OLD", nome: "Antigo" }, idx).produto, null);
  assert.equal(vincularItem({ codigo: "CALDA", nome: "Calda" }, idx).produto, null);
  assert.equal(vincularItem({ codigo: "XYZ", nome: "Nada" }, idx).motivo, "codigo_nao_cadastrado");
});
test("CMV teórico = Σ(qtd × custo) ÷ Σ receita dos itens vinculados", () => {
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 2, 20, { externalCode: "CAP01" })), ped(it("Bolo de Cenoura", 1, 12))], produtos, grafo: G() });
  assert.equal(r.indisponivel, false);
  perto(r.cmv_teorico_pct, ((2 * 0.8 + 3.0) / (20 + 12)) * 100);
  assert.equal(r.produtos.length, 2);
  const cap = r.produtos.find((p) => p.produto_id === "cap");
  perto(cap.preco_medio_praticado, 10); perto(cap.cmv_pct, (1.6 / 20) * 100);
});
test("NÃO inventa: itens sem correspondência são listados com quantidade e receita; entram na cobertura, não no CMV", () => {
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }), it("Item Misterioso", 3, 30, { externalCode: "ZZZ" }), it("Crepe Simples", 1, 8))], produtos, grafo: G() });
  assert.deepEqual(r.sem_correspondencia.map((s) => [s.nome, s.quantidade, s.receita, s.motivo]), [["Item Misterioso", 3, 30, "codigo_nao_cadastrado"], ["Crepe Simples", 1, 8, "nome_ambiguo"]]);
  perto(r.cobertura.pct_receita_vinculada, (10 / 48) * 100);
  assert.equal(r.parcial, true); // cobertura < 50%
  perto(r.cmv_teorico_pct, 8); // só o vinculado
});
test("INDISPONÍVEL com motivo: sem pedidos / pedidos sem itens / nenhum vínculo / só fichas incompletas", () => {
  assert.deepEqual(calcularCmvTeorico({ pedidos: [], produtos, grafo: G() }).motivos_indisponivel, ["sem_pedidos_no_periodo"]);
  assert.deepEqual(calcularCmvTeorico({ pedidos: [{ order_id: "1", items: null }], produtos, grafo: G() }).motivos_indisponivel, ["pedidos_sem_detalhe_de_itens"]);
  assert.ok(calcularCmvTeorico({ pedidos: [ped(it("Desconhecido", 1, 5))], produtos, grafo: G() }).motivos_indisponivel.includes("nenhum_item_vinculado_a_produto"));
  const gSemCusto = grafo([ins("cafe", 0)], [{ produto_id: "cap", insumo_id: "cafe", quantidade: 20 }]);
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }))], produtos, grafo: gSemCusto });
  assert.equal(r.indisponivel, true); assert.equal(r.cmv_teorico_pct, null);
  assert.ok(r.motivos_indisponivel.includes("nenhuma_ficha_completa_entre_os_vinculados"));
});
test("ficha incompleta fica FORA do CMV (nem numerador nem denominador) e marca parcial", () => {
  const g = grafo([ins("cafe", 0.04), ins("farinha", 0)], [
    { produto_id: "cap", insumo_id: "cafe", quantidade: 20 },
    { produto_id: "bolo", insumo_id: "farinha", quantidade: 300 }, // sem custo
  ]);
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }), it("Bolo de Cenoura", 1, 90))], produtos, grafo: g });
  perto(r.cmv_teorico_pct, 8); assert.equal(r.parcial, true); assert.equal(r.cobertura.produtos_ficha_incompleta, 1);
  assert.equal(r.produtos.find((p) => p.produto_id === "bolo").cmv_pct, null);
});
test("CMV HOMOLOGADO só considera fichas homologadas; pendentes entram só no CMV técnico", () => {
  const g = grafo([ins("cafe", 0.04), ins("farinha", 0.01)], [
    { produto_id: "cap", insumo_id: "cafe", quantidade: 20 }, { produto_id: "bolo", insumo_id: "farinha", quantidade: 300 },
  ], {}, { cap: "homologada", bolo: "pendente" });
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }), it("Bolo de Cenoura", 1, 12))], produtos, grafo: g });
  perto(r.cmv_teorico_pct, ((0.8 + 3) / 22) * 100);
  perto(r.cmv_teorico_homologado_pct, 8);
  assert.equal(r.produtos.find((p) => p.produto_id === "bolo").custo_homologado, false);
});
test("rendimento da ficha é considerado no custo unitário vendido", () => {
  const g = grafo([ins("farinha", 0.01)], [{ produto_id: "bolo", insumo_id: "farinha", quantidade: 800 }], { bolo: 8 }); // lote 8,00 / 8 = 1,00
  const r = calcularCmvTeorico({ pedidos: [ped(it("Bolo de Cenoura", 4, 40))], produtos, grafo: g });
  perto(r.produtos[0].custo_unitario, 1); perto(r.cmv_teorico_pct, 10);
});
test("margem após comissão: só existe se a empresa configurou a comissão; senão null (sem assumir)", () => {
  const base = { pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }))], produtos, grafo: G() };
  const sem = calcularCmvTeorico(base);
  assert.equal(sem.margem_apos_comissao_disponivel, false); assert.equal(sem.produtos[0].margem_apos_comissao_pct, null);
  const com = calcularCmvTeorico({ ...base, comissaoCanal: 0.25 });
  perto(com.produtos[0].margem_apos_comissao_pct, 100 - 8 - 25);
});
test("precificação desfavorável: CMV acima do limite informado e margem negativa após comissão", () => {
  const g = grafo([ins("farinha", 0.05)], [{ produto_id: "bolo", insumo_id: "farinha", quantidade: 300 }]); // R$ 15 por bolo
  const r = calcularCmvTeorico({ pedidos: [ped(it("Bolo de Cenoura", 1, 18))], produtos, grafo: g, comissaoCanal: 0.3, limiteCmvPct: 40 });
  assert.deepEqual(r.desfavoraveis[0].sinais.sort(), ["cmv_acima_do_limite", "margem_negativa_apos_comissao"]);
});
test("adicionais: casam por código e somam ao produto; sem correspondência apenas contados", () => {
  const r = calcularCmvTeorico({ pedidos: [ped(it("Bolo de Cenoura", 2, 24, { options: [{ name: "Café extra", externalCode: "CAP01", quantity: 1, price: 4 }, { name: "Cobertura", quantity: 1, price: 2 }] }))], produtos, grafo: G() });
  const cap = r.produtos.find((p) => p.produto_id === "cap");
  assert.equal(cap.quantidade, 2); // 1 por unidade × 2 bolos
  assert.deepEqual(r.adicionais_sem_correspondencia, { itens: 1, quantidade: 2, receita: 2 });
});
test("itens com quantidade inválida são ignorados e contados", () => {
  const r = calcularCmvTeorico({ pedidos: [ped({ name: "Bolo de Cenoura", quantity: 0, price: 9 }, { name: "Bolo de Cenoura", price: 9 }, it("Bolo de Cenoura", 1, 12))], produtos, grafo: G() });
  assert.equal(r.cobertura.itens_invalidos, 2); assert.equal(r.cobertura.itens_total, 1);
});
test("ISOLAMENTO: produtos de outra organização no grafo errado não geram custo (produto sem ficha no grafo => ficha incompleta)", () => {
  const outraOrg = grafo([ins("cafe", 0.04)], []); // grafo da OUTRA empresa: não conhece "cap"
  const r = calcularCmvTeorico({ pedidos: [ped(it("Cappuccino", 1, 10, { externalCode: "CAP01" }))], produtos, grafo: outraOrg });
  assert.equal(r.indisponivel, true);
});
test("validarPeriodo: formato, ordem e limite de 92 dias", () => {
  assert.ok(validarPeriodo("2026-10-01", "2026-10-31").inicio);
  assert.throws(() => validarPeriodo("01/10/2026", "2026-10-31"), /AAAA-MM-DD/);
  assert.throws(() => validarPeriodo("2026-10-31", "2026-10-01"), /inválido/);
  assert.throws(() => validarPeriodo("2026-01-01", "2026-06-01"), /máximo/);
});
