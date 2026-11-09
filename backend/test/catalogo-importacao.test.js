// Importação de catálogo (planilhas de ficha técnica) — planejador, parser e travas de escrita.
// Tudo sintético e puro: nenhum dado real da Caramelle, nenhuma conexão com banco.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const { planejarCatalogo, validarPayload, inferirUnidade, normalizarNome } = await import("../src/modules/catalogo-importacao/catalogo.planejar.js");
const { extrairFichas } = await import("../src/modules/catalogo-importacao/fichasPlanilha.parser.js");
const { aplicarCatalogo, avaliarTravasDeEscrita, ImportacaoRecusada } = await import("../src/modules/catalogo-importacao/catalogo.importar.service.js");
const XLSX = createRequire(import.meta.url)("xlsx");

// ---- fixture: um "arquivo extraído" mínimo -------------------------------------------------
const comp = (nome, qtd, extra = {}) => ({ linha: 6, nome, un: "GR", qtd_emb: 1000, qtd, valor_emb: 10, unit: 0.01, total: qtd * 0.01, ...extra });
function arquivo(categoria, over = {}) {
  return {
    categoria, arquivo: `${categoria}.xlsx`,
    ingredientes: [
      { linha: 2, nome: "LEITE", unidade: "GR", qtd_embalagem: 1000, valor: 5 },
      { linha: 3, nome: "CAFÉ", unidade: "GR", qtd_embalagem: 1000, valor: 40 },
    ],
    embalagens: [{ linha: 2, nome: "COPO", unidade: "UM", qtd_embalagem: 100, valor: 20 }],
    mod: [], bases: [], fichas: [], ...over,
  };
}
const ficha = (nome, over = {}) => ({
  aba: "P1", ficha_no: 1, nome, rendimento: 2, custo_total: 0, custo_unit: 0, preco_venda: 12, margem_desejada: 0.7,
  desp_mat: 0, desp_emb: 0, ingredientes: [], bases: [], embalagens: [], mod: [], ...over,
});
const base = (nome, over = {}) => ({
  aba: "B1", nome, rendimento: 500, unidade_rend: "Gramas", custo_total: 0, custo_unit: 0, desperdicio: 0, desp_emb: 0,
  linhas: [], embalagens: [], mod: [], ...over,
});
const fonte = "teste-v1";
const prod = (res, nome) => res.payload.produtos.find((p) => p.nome === nome);

// ---- unidades --------------------------------------------------------------------------------
test("inferirUnidade: rótulos inequívocos não geram pendência", () => {
  assert.deepEqual(inferirUnidade("GR", 1000), { unidade: "g", pendencia: null, detalhe: null });
  assert.equal(inferirUnidade("ML", 1000).unidade, "ml");
  assert.equal(inferirUnidade("UM.", 360).unidade, "un");
  assert.equal(inferirUnidade("U", 12).pendencia, null);
});
test("inferirUnidade: 'L' com 1000 = ml e 'KG' com 1800 = g, SEMPRE com pendência registrada", () => {
  const l = inferirUnidade("L", 1000); assert.equal(l.unidade, "ml"); assert.equal(l.pendencia, "unidade_inferida");
  const k = inferirUnidade("KG", 1800); assert.equal(k.unidade, "g"); assert.equal(k.pendencia, "unidade_inferida");
  const pequeno = inferirUnidade("KG", 1); assert.equal(pequeno.unidade, "kg"); assert.equal(pequeno.pendencia, "unidade_ambigua");
  assert.equal(inferirUnidade("", 1).pendencia, "unidade_ausente");
});
test("normalizarNome: acento, caixa e espaços", () => {
  assert.equal(normalizarNome("  Pão  de   Queijo "), "PAO DE QUEIJO");
});

// ---- insumos ---------------------------------------------------------------------------------
test("NUNCA inventa preço: preço zero/ausente vira insumo sem custo + pendência", () => {
  const A = arquivo("DOCES", { ingredientes: [{ linha: 2, nome: "AGUA", unidade: "GR", qtd_embalagem: 1000, valor: 0 }, { linha: 3, nome: "OREGANO", unidade: "", qtd_embalagem: null, valor: null }] });
  const r = planejarCatalogo([A], { fonte });
  for (const nome of ["AGUA", "OREGANO"]) {
    const i = r.payload.insumos.find((x) => x.nome === nome);
    assert.equal(i.preco_caixa, null); assert.equal(i.rendimento, null);
    assert.ok(i.pendencias.some((p) => p.codigo === "preco_ausente_ou_zero"));
  }
});
test("insumo IGUAL em várias planilhas = cadastro único (histórico das origens preservado)", () => {
  const r = planejarCatalogo([arquivo("SALGADOS"), arquivo("DOCES")], { fonte });
  const cafe = r.payload.insumos.filter((i) => normalizarNome(i.nome) === "CAFE");
  assert.equal(cafe.length, 1); assert.equal(cafe[0].referencia.fontes.length, 2);
  assert.equal(r.relatorio.totais.duplicatas_identicas_de_mestre, 3); // LEITE, CAFÉ e COPO
});
test("valor DIFERENTE entre planilhas NÃO é unificado em silêncio: uma variante por arquivo e cada ficha usa o custo da sua planilha", () => {
  const a = arquivo("SALGADOS", { fichas: [ficha("FS", { ingredientes: [comp("LEITE", 100)] })] });
  const b = arquivo("DOCES", { fichas: [ficha("FD", { ingredientes: [comp("LEITE", 100)] })] });
  b.ingredientes[0] = { linha: 2, nome: "Leite", unidade: "GR", qtd_embalagem: 1000, valor: 7 }; // mesmo nome, outro preço
  const r = planejarCatalogo([a, b], { fonte });
  const leite = r.payload.insumos.filter((i) => normalizarNome(i.nome).startsWith("LEITE"));
  assert.equal(leite.length, 2);
  const base = leite.find((i) => i.chave === "ing:LEITE"); const variante = leite.find((i) => i.chave === "ing:LEITE@DOCES");
  assert.equal(base.preco_caixa, 5); assert.equal(variante.preco_caixa, 7); assert.equal(variante.nome, "Leite (DOCES)");
  for (const i of leite) assert.ok(i.pendencias.some((p) => p.codigo === "valores_divergentes"));
  assert.equal(prod(r, "FS").linhas[0].chave, "ing:LEITE");
  assert.equal(prod(r, "FD").linhas[0].chave, "ing:LEITE@DOCES");
  const custo = (n) => r.relatorio.custos_planejados.find((c) => c.chave === prod(r, n).chave).custo_unit_ingredientes_embalagens;
  assert.ok(custo("FD") > custo("FS")); // 100 g × 0,007 × (1/2 rendimento) × ... cada uma com o seu preço
});
test("repetido no MESMO mestre: vale a 1ª ocorrência (regra do VLOOKUP) e a divergência é registrada", () => {
  const A = arquivo("SALGADOS");
  A.ingredientes.push({ linha: 9, nome: "LEITE", unidade: "GR", qtd_embalagem: 1000, valor: 99 });
  const r = planejarCatalogo([A], { fonte });
  const leite = r.payload.insumos.filter((i) => normalizarNome(i.nome) === "LEITE");
  assert.equal(leite.length, 1); assert.equal(leite[0].preco_caixa, 5);
  assert.ok(leite[0].pendencias.some((p) => p.codigo === "valores_divergentes"));
});
test("embalagem entra como insumo tipo 'embalagem' com chave própria (não colide com ingrediente)", () => {
  const A = arquivo("SALGADOS", { embalagens: [{ linha: 2, nome: "LEITE", unidade: "UM", qtd_embalagem: 10, valor: 3 }] });
  const r = planejarCatalogo([A], { fonte });
  assert.ok(r.payload.insumos.some((i) => i.chave === "emb:LEITE" && i.tipo === "embalagem" && i.unidade_medida === "un"));
  assert.ok(r.payload.insumos.some((i) => i.chave === "ing:LEITE"));
});

// ---- fichas, rendimento e preparações --------------------------------------------------------
test("rendimento da receita vem da planilha e o custo unitário o considera", () => {
  const A = arquivo("SALGADOS", { fichas: [ficha("EMPADÃO", { rendimento: 8, custo_total: 1, custo_unit: 0.125, ingredientes: [comp("LEITE", 200)] })] });
  const r = planejarCatalogo([A], { fonte });
  const p = prod(r, "EMPADÃO");
  assert.equal(p.rendimento, 8);
  const c = r.relatorio.custos_planejados.find((x) => x.chave === p.chave);
  assert.equal(c.custo_unit_ingredientes_embalagens, 0.125); // 200 g × R$0,005 / 8
});
test("preparação aninhada: ficha usa 700 g de uma base que rende 500 g", () => {
  const A = arquivo("SALGADOS", {
    bases: [base("BECHAMEL", { rendimento: 500, linhas: [comp("LEITE", 500)], custo_total: 2.5 })],
    fichas: [ficha("TORTA", { rendimento: 4, bases: [comp("BECHAMEL", 700, { linha: 26 })], custo_total: 0.7 * 2.5 * 1 })],
  });
  const r = planejarCatalogo([A], { fonte });
  const torta = prod(r, "TORTA");
  assert.deepEqual(torta.linhas.map((l) => [l.ref, l.chave, l.quantidade]), [["produto", "prep:BECHAMEL", 700]]);
  const c = r.relatorio.custos_planejados.find((x) => x.chave === torta.chave);
  assert.ok(Math.abs(c.custo_unit_ingredientes_embalagens - (700 * (2.5 / 500)) / 4) < 1e-4);
  assert.equal(prod(r, "BECHAMEL").vendavel, false); assert.equal(prod(r, "BECHAMEL").tipo, "submontagem");
  assert.equal(prod(r, "BECHAMEL").unidade_rendimento, "g");
});
test("produto final NÃO se confunde com ingrediente/preparação: mesmo nome nos dois mundos gera dois registros", () => {
  const A = arquivo("SALGADOS", {
    bases: [base("PAO DE MANTEIGA", { linhas: [comp("LEITE", 100)] })],
    fichas: [ficha("PAO DE MANTEIGA", { ingredientes: [comp("LEITE", 100)] })],
  });
  const r = planejarCatalogo([A], { fonte });
  assert.equal(r.payload.produtos.filter((p) => p.nome === "PAO DE MANTEIGA").length, 2);
});
test("nomes repetidos com receitas diferentes são PRESERVADOS (chave #n) e sinalizados", () => {
  const A = arquivo("SALGADOS", { fichas: [
    ficha("TAPIOCA", { aba: "P1", ingredientes: [comp("LEITE", 10)] }),
    ficha("TAPIOCA", { aba: "P2", ingredientes: [comp("CAFÉ", 20)] }),
  ] });
  const r = planejarCatalogo([A], { fonte });
  const t = r.payload.produtos.filter((p) => p.nome === "TAPIOCA");
  assert.equal(t.length, 2); assert.notEqual(t[0].chave, t[1].chave);
  assert.ok(t[1].pendencias.some((p) => p.codigo === "nome_repetido_na_categoria"));
});
test("preparação idêntica em duas planilhas é mesclada; com receita diferente, preservada à parte", () => {
  const mk = (qtd) => arquivo("X", { bases: [base("MIX", { linhas: [comp("LEITE", qtd)] })] });
  const igual = planejarCatalogo([{ ...mk(100), categoria: "SALGADOS" }, { ...mk(100), categoria: "DOCES" }], { fonte });
  assert.equal(igual.payload.produtos.filter((p) => p.nome === "MIX").length, 1);
  const dif = planejarCatalogo([{ ...mk(100), categoria: "SALGADOS" }, { ...mk(250), categoria: "DOCES" }], { fonte });
  assert.equal(dif.payload.produtos.filter((p) => p.nome === "MIX").length, 2);
});
test("ficha incompleta: linha sem quantidade, componente inexistente, rendimento ausente e erro de planilha bloqueiam", () => {
  const A = arquivo("DOCES", { fichas: [
    ficha("A", { ingredientes: [comp("LEITE", null)] }),
    ficha("B", { ingredientes: [comp("INEXISTENTE", 10)] }),
    ficha("C", { rendimento: null, ingredientes: [comp("LEITE", 10)] }),
    ficha("D", { ingredientes: [comp("LEITE", 10, { valor_emb: "#N/A" })] }),
    ficha("OK", { ingredientes: [comp("LEITE", 10)], custo_total: 0.05, custo_unit: 0.025 }),
  ] });
  const r = planejarCatalogo([A], { fonte });
  const bloqueios = (n) => prod(r, n).pendencias.map((p) => p.codigo);
  assert.ok(bloqueios("A").includes("linha_sem_quantidade"));
  assert.ok(bloqueios("B").includes("componente_nao_encontrado"));
  assert.ok(bloqueios("C").includes("sem_rendimento"));
  assert.ok(bloqueios("D").includes("linha_com_erro_na_planilha"));
  const pend = new Set(r.relatorio.fichas_pendentes.map((f) => f.nome));
  for (const n of ["A", "B", "C", "D"]) assert.ok(pend.has(n), `${n} deve estar pendente`);
  assert.ok(!pend.has("OK"));
});
test("insumo sem custo contamina a ficha E quem usa a preparação (cascata)", () => {
  const A = arquivo("DOCES", {
    ingredientes: [{ linha: 2, nome: "AGUA", unidade: "GR", qtd_embalagem: 1000, valor: 0 }, { linha: 3, nome: "LEITE", unidade: "GR", qtd_embalagem: 1000, valor: 5 }],
    bases: [base("CALDA", { linhas: [comp("AGUA", 100)] })],
    fichas: [ficha("BOLO", { bases: [comp("CALDA", 50, { linha: 26 })], ingredientes: [comp("LEITE", 10)] })],
  });
  const r = planejarCatalogo([A], { fonte });
  assert.ok(prod(r, "CALDA").pendencias.some((p) => p.codigo === "insumo_sem_custo"));
  assert.ok(prod(r, "BOLO").pendencias.some((p) => p.codigo === "preparacao_incompleta"));
});
test("mão de obra fica FORA do custo de ingredientes e é registrada à parte", () => {
  const A = arquivo("SALGADOS", { fichas: [ficha("X", { rendimento: 2, ingredientes: [comp("LEITE", 200)], mod: [{ linha: 50, nome: "confeiteira", salario: 3220, min_mes: 11520, min_rec: 10, unit: 0.2795, total: 2.795 }] })] });
  const r = planejarCatalogo([A], { fonte });
  const x = prod(r, "X");
  assert.deepEqual(x.mao_de_obra, [{ funcao: "confeiteira", minutos: 10, custo_minuto: 0.2795 }]);
  const c = r.relatorio.custos_planejados.find((k) => k.chave === x.chave);
  assert.equal(c.custo_unit_ingredientes_embalagens, 0.5);        // 200 g × 0,005 / 2 (sem MOD)
  assert.equal(c.custo_unit_mao_de_obra, 1.3975);                 // 10 min × 0,2795 / 2
  assert.ok(!x.linhas.some((l) => /confeiteira/i.test(l.chave)));
});
test("mesmo ingrediente duas vezes na mesma ficha: somado (constraint única do banco) e sinalizado", () => {
  const A = arquivo("SALGADOS", { fichas: [ficha("Y", { ingredientes: [comp("LEITE", 100), comp("LEITE", 50, { linha: 7 })] })] });
  const r = planejarCatalogo([A], { fonte });
  const y = prod(r, "Y");
  assert.equal(y.linhas.length, 1); assert.equal(y.linhas[0].quantidade, 150);
  assert.ok(y.pendencias.some((p) => p.codigo === "linha_duplicada_somada"));
});
test("ciclo entre preparações é detectado", () => {
  const A = arquivo("DOCES", { bases: [
    base("P1", { aba: "B1", linhas: [comp("P2", 10)] }),
    base("P2", { aba: "B2", linhas: [comp("P1", 10)] }),
  ] });
  const r = planejarCatalogo([A], { fonte });
  assert.ok(r.relatorio.inconsistencias.some((i) => i.codigo === "ciclo_na_receita"));
  assert.ok(r.relatorio.fichas_pendentes.length >= 1);
});
test("todos os produtos entram como 'pendente' de homologação (nada nasce homologado)", () => {
  const A = arquivo("SALGADOS", { fichas: [ficha("Z", { ingredientes: [comp("LEITE", 10)], custo_total: 0.05, custo_unit: 0.025 })] });
  const r = planejarCatalogo([A], { fonte });
  assert.ok(r.payload.produtos.every((p) => p.homologacao === "pendente"));
});

// ---- idempotência / determinismo e validação do payload --------------------------------------
test("planejar duas vezes produz payload IDÊNTICO (chaves estáveis => reimportar não duplica)", () => {
  const mk = () => arquivo("SALGADOS", {
    bases: [base("B", { linhas: [comp("LEITE", 5)] })],
    fichas: [ficha("F", { bases: [comp("B", 10, { linha: 26 })], ingredientes: [comp("CAFÉ", 3)] }), ficha("F", { aba: "P2", ingredientes: [comp("CAFÉ", 4)] })],
  });
  assert.deepEqual(planejarCatalogo([mk()], { fonte }).payload, planejarCatalogo([mk()], { fonte }).payload);
});
test("validarPayload aceita o planejado e recusa referência quebrada / quantidade inválida", () => {
  const A = arquivo("SALGADOS", { fichas: [ficha("F", { ingredientes: [comp("LEITE", 10)] })] });
  const { payload } = planejarCatalogo([A], { fonte });
  assert.deepEqual(validarPayload(payload), []);
  const ruim = structuredClone(payload);
  ruim.produtos[0].linhas.push({ ref: "insumo", chave: "ing:NAO_EXISTE", quantidade: 1, ordem: 9 });
  ruim.produtos[0].linhas.push({ ref: "insumo", chave: "ing:LEITE", quantidade: -1, ordem: 10 });
  const erros = validarPayload(ruim);
  assert.ok(erros.some((e) => e.includes("referência quebrada")));
  assert.ok(erros.some((e) => e.includes("quantidade inválida")));
});

// ---- travas de escrita (nada grava sem autorização explícita) --------------------------------
test("avaliarTravasDeEscrita: exige confirmação, org e host de destino confirmado", () => {
  const base = { confirmoEscrita: true, orgId: "11111111-1111-4111-8111-111111111111", supabaseUrl: "https://abc.supabase.co", hostConfirmado: "abc.supabase.co" };
  assert.equal(avaliarTravasDeEscrita(base).ok, true);
  assert.equal(avaliarTravasDeEscrita({ ...base, confirmoEscrita: false }).ok, false);
  assert.equal(avaliarTravasDeEscrita({ ...base, orgId: null }).ok, false);
  assert.equal(avaliarTravasDeEscrita({ ...base, hostConfirmado: undefined }).ok, false);
  assert.equal(avaliarTravasDeEscrita({ ...base, hostConfirmado: "outro.supabase.co" }).ok, false);
  assert.equal(avaliarTravasDeEscrita({ ...base, supabaseUrl: "lixo" }).ok, false);
});
test("aplicarCatalogo: recusa org inválida/payload inválido ANTES de falar com o banco; erro do banco vira ImportacaoRecusada", async () => {
  let chamadas = 0;
  const db = { rpc: async () => { chamadas++; return { data: { ok: true }, error: null }; } };
  const { payload } = planejarCatalogo([arquivo("SALGADOS", { fichas: [ficha("F", { ingredientes: [comp("LEITE", 1)] })] })], { fonte });
  await assert.rejects(() => aplicarCatalogo(db, { orgId: "nao-uuid", fonte, payload }), ImportacaoRecusada);
  const quebrado = structuredClone(payload); quebrado.produtos[0].linhas[0].chave = "ing:XYZ";
  await assert.rejects(() => aplicarCatalogo(db, { orgId: "11111111-1111-4111-8111-111111111111", fonte, payload: quebrado }), ImportacaoRecusada);
  assert.equal(chamadas, 0);
  const ok = await aplicarCatalogo(db, { orgId: "11111111-1111-4111-8111-111111111111", fonte, payload });
  assert.deepEqual(ok, { ok: true }); assert.equal(chamadas, 1);
  const dbRuim = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
  await assert.rejects(() => aplicarCatalogo(dbRuim, { orgId: "11111111-1111-4111-8111-111111111111", fonte, payload }), /boom/);
});

// ---- parser: layout do modelo "Ficha Técnica 3.2" --------------------------------------------
test("extrairFichas lê o layout do modelo (P*, B*, mestres) e preserva erro de fórmula como texto", () => {
  const wb = XLSX.utils.book_new();
  const aba = (nome, cel) => { const ws = {}; for (const [ref, v] of Object.entries(cel)) ws[ref] = typeof v === "object" ? v : { t: typeof v === "number" ? "n" : "s", v }; ws["!ref"] = "A1:Q60"; XLSX.utils.book_append_sheet(wb, ws, nome); };
  aba("Ingredientes", { A2: "LEITE", B2: "GR", C2: 1000, D2: 5 });
  aba("Embalagem", { A2: "COPO", B2: "UM", C2: 100, D2: 20 });
  aba("MOD", { A2: "barista", B2: 2000, C2: 800, D2: 2800 });
  aba("P1", { D3: "CAPPUCCINO", B3: 1, M6: 3.2, M7: 2, M8: 1.6, M18: 15, B31: "Desperdício de Material", B45: "Desperdício de Embalagem", B57: "CUSTO TOTAL DO PRODUTO",
    B6: "LEITE", D6: "GR", E6: 1000, F6: 200, G6: 5, H6: 0.005, I6: 1, B26: "BASE X", G26: { t: "e", v: 42, w: "#N/A" }, F26: 10,
    B35: "COPO", F35: 1, B50: "barista", F50: 4, H50: 0.17, I50: 0.7 });
  aba("B1", { D3: "BASE X", M6: 3, M7: 500, K11: "Gramas", B26: "Desperdício", B34: "Desperdício", B46: "CUSTO TOTAL", B6: "LEITE", F6: 100 });
  const x = extrairFichas(wb, "BEBIDAS", { arquivo: "b.xlsx" });
  assert.equal(x.ingredientes.length, 1); assert.equal(x.embalagens[0].nome, "COPO"); assert.equal(x.mod[0].nome, "barista");
  assert.equal(x.fichas.length, 1); const f = x.fichas[0];
  assert.equal(f.nome, "CAPPUCCINO"); assert.equal(f.rendimento, 2); assert.equal(f.preco_venda, 15);
  assert.equal(f.ingredientes[0].qtd, 200); assert.equal(f.bases[0].nome, "BASE X"); assert.equal(f.bases[0].valor_emb, "#N/A");
  assert.equal(f.embalagens[0].nome, "COPO"); assert.equal(f.mod[0].min_rec, 4); assert.deepEqual(f.layout_fora_do_padrao, []);
  assert.equal(x.bases[0].unidade_rend, "Gramas"); assert.deepEqual(x.bases[0].layout_fora_do_padrao, []);
});
test("extrairFichas sinaliza aba fora do padrão (rótulos deslocados)", () => {
  const wb = XLSX.utils.book_new(); const ws = { D3: { t: "s", v: "Z" }, B31: { t: "s", v: "outra coisa" }, "!ref": "A1:Q60" };
  XLSX.utils.book_append_sheet(wb, ws, "P1");
  assert.ok(extrairFichas(wb, "DOCES").fichas[0].layout_fora_do_padrao.length > 0);
});

// ---- conciliação: nenhuma receita/linha some sem explicação ----------------------------------------
test("CONCILIAÇÃO: todo registro de origem vira (ou é mesclado em) um produto; linhas fecham; descartes são listados", () => {
  const mk = (cat) => arquivo(cat, {
    bases: [base("MIX", { aba: "B1", linhas: [comp("LEITE", 100)] }), base("CALDA", { aba: "B2", linhas: [comp("LEITE", 5), comp("FANTASMA", 3), comp("CAFÉ", null)] })],
    fichas: [ficha("BOLO", { aba: "P1", ingredientes: [comp("LEITE", 10), comp("LEITE", 5, { linha: 7 })], bases: [comp("CALDA", 20, { linha: 26 })] })],
  });
  const r = planejarCatalogo([mk("SALGADOS"), mk("DOCES")], { fonte });
  const c = r.relatorio.conferencia;
  assert.equal(c.registros_origem, 6);                        // 2 × (2 preparações + 1 ficha)
  assert.equal(c.fontes_mapeadas, 6); assert.equal(c.todos_os_registros_mapeados, true);
  assert.equal(c.preparacoes_mescladas.length, 2);            // MIX e CALDA idênticas nos dois arquivos
  assert.equal(c.produtos_planejados, 4); assert.equal(c.diferenca_explicada, true);
  assert.equal(c.linhas.fecha, true); assert.equal(c.linhas.fecha_processadas, true);
  assert.equal(c.linhas.descartadas_componente_nao_encontrado, 1); assert.equal(c.linhas.descartadas_sem_quantidade, 1); // a CALDA repetida foi mesclada: suas linhas contam em "de_preparacoes_mescladas"
  assert.equal(c.linhas.somadas_em_linha_existente, 2);
  assert.ok(r.relatorio.fichas_pendentes.some((f) => f.nome === "CALDA"));  // as linhas descartadas bloqueiam a ficha
});
test("CONCILIAÇÃO: insumo sem custo continua pendente e variantes de preço são preservadas (nunca unificadas)", () => {
  const a = arquivo("SALGADOS"); const b = arquivo("DOCES");
  a.ingredientes.push({ linha: 9, nome: "AGUA", unidade: "GR", qtd_embalagem: 1000, valor: 0 });
  b.ingredientes[1] = { linha: 3, nome: "CAFÉ", unidade: "GR", qtd_embalagem: 1000, valor: 55 };   // outro preço
  const r = planejarCatalogo([a, b], { fonte });
  const c = r.relatorio.conferencia;
  assert.deepEqual(c.insumos_sem_custo, ["AGUA"]);
  assert.equal(c.variantes_de_preco, 1); assert.equal(c.preservadas_sem_unificar, true);
  const cafes = r.payload.insumos.filter((i) => normalizarNome(i.nome).startsWith("CAFE"));
  assert.deepEqual(cafes.map((i) => i.preco_caixa).sort(), [40, 55]);
});
