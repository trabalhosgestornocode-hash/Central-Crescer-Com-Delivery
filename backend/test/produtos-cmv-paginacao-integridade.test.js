// Paginação (teto REAL do PostgREST: no máximo 1.000 linhas por resposta) + critério ÚNICO de integridade na homologação
// antiga + isolamento/segurança das rotas novas. Código REAL dos serviços sobre banco em memória; nenhum banco real.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import express from "express";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const TETO = 1000;
/** Banco em memória que se comporta como o PostgREST: sem range => no máximo 1.000 linhas; ordem multi-coluna estável. */
function criarBanco(tabelas) {
  const log = [];
  const db = {
    tabelas, log, rpcs: [],
    rpc(nome, args) { db.rpcs.push({ nome, args }); return Promise.resolve({ data: { lote_id: "l", corrigidos: args.p_itens?.length ?? 0, alterado: true }, error: null }); },
    from(nome) {
      const f = []; let op = "select"; let payload = null; const ords = []; let faixa = null; let lim = null;
      const ok = (r) => f.every((x) => (x.op === "eq" ? r[x.col] === x.val : x.op === "neq" ? JSON.stringify(r[x.col]) !== JSON.stringify(x.val) && r[x.col] !== x.val : x.op === "in" ? x.val.includes(r[x.col]) : true));
      const exec = () => {
        const base = db.tabelas[nome] ?? [];
        log.push({ tabela: nome, op, faixa, filtros: f.map((x) => `${x.op}:${x.col}`), inTam: f.find((x) => x.op === "in")?.val.length ?? 0 });
        if (op === "select") {
          let r = base.filter(ok).map((x) => ({ ...x }));
          if (ords.length) r.sort((a, b) => { for (const c of ords) { const d = String(a[c] ?? "").localeCompare(String(b[c] ?? "")); if (d) return d; } return 0; });
          if (lim) r = r.slice(0, lim);
          r = faixa ? r.slice(faixa[0], Math.min(faixa[1] + 1, faixa[0] + TETO)) : r.slice(0, TETO);
          return { data: r, error: null };
        }
        if (op === "update") { const alvo = base.filter(ok); alvo.forEach((r) => Object.assign(r, payload)); return { data: alvo, error: null }; }
        if (op === "insert") { const l = (Array.isArray(payload) ? payload : [payload]).map((x) => ({ id: x.id ?? `gen-${Math.random()}`, ...x })); (db.tabelas[nome] ??= []).push(...l); return { data: l, error: null }; }
        if (op === "delete") { db.tabelas[nome] = base.filter((r) => !ok(r)); return { data: null, error: null }; }
        return { data: null, error: null };
      };
      const q = {
        select() { return q; }, eq(c, v) { f.push({ op: "eq", col: c, val: v }); return q; }, neq(c, v) { f.push({ op: "neq", col: c, val: v }); return q; },
        in(c, v) { f.push({ op: "in", col: c, val: v }); return q; }, order(c) { ords.push(c); return q; }, range(a, b) { faixa = [a, b]; return q; }, limit(n) { lim = n; return q; },
        update(p) { op = "update"; payload = p; return q; }, insert(p) { op = "insert"; payload = p; return q; }, delete() { op = "delete"; return q; }, upsert(p) { op = "insert"; payload = p; return q; },
        single() { const r = exec(); return Promise.resolve(r.data?.[0] ? { data: r.data[0], error: null } : { data: null, error: { message: "not found" } }); },
        maybeSingle() { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(a, b) { return Promise.resolve(exec()).then(a, b); },
      };
      return q;
    },
  };
  return db;
}

register("./helpers/supabase-falso.hooks.mjs", import.meta.url);
const custo = await import("../src/modules/produtos/custo.js");
const svc = await import("../src/modules/produtos/produtos.service.js");
const cmv2 = await import("../src/modules/produtos/produtosCmv.service.js");
const insumosSvc = await import("../src/modules/insumos/insumos.service.js");
const cmvSvc = await import("../src/modules/cmv/cmv.service.js");
const integ = await import("../src/modules/produtos/integridade.js");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = { id: "u1", nome: "Admin", email: "a@x.test" };
const vazio = () => ({ insumos: [], produtos: [], ficha_tecnica: [], catalogo_origem: [], produto_historico: [], produto_precos: [], canais_venda: [], ficha_mao_de_obra: [], vw_produto_margem: [], produto_rascunhos: [], catalogo_correcoes: [] });

// ------------------------------------------------------------------ paginação
for (const linhas of [999, 1000, 1001, 2000, 2501]) {
  test(`carregarGrafo lê TODAS as ${linhas} linhas de ficha (várias páginas, limite exato) sem duplicar`, async () => {
    const t = vazio();
    t.insumos.push({ id: id(9000001), organizacao_id: A, nome: "Farinha", unidade_medida: "g", preco_unitario: 0.01, ativo: true });
    const nProd = 400; // > 150: força vários blocos de ids no `.in()`
    for (let p = 0; p < nProd; p += 1) t.produtos.push({ id: id(p + 1), organizacao_id: A, nome: `P${p}`, tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" });
    for (let i = 0; i < linhas; i += 1) t.ficha_tecnica.push({ id: id(5000000 + i), produto_id: id((i % nProd) + 1), insumo_id: id(9000001), quantidade: 1, ativo: true });
    globalThis.__supabaseFalso = criarBanco(t);
    const g = await custo.carregarGrafo(A);
    const todas = [...g.fichaByProd.values()].flat();
    assert.equal(todas.length, linhas);
    assert.equal(new Set(todas.map((x) => x.id)).size, linhas, "sem duplicidade");
    const soma = [...g.fichaByProd.keys()].reduce((s, pid) => s + custo.custoTotalProduto(pid, g), 0);
    assert.ok(Math.abs(soma - linhas * 0.01) < 1e-9, "custo total confere com todas as linhas");
    assert.ok(globalThis.__supabaseFalso.log.every((l) => l.inTam <= 150), "nenhum .in() com mais de 150 ids");
  });
}

test("sem paginação o teto truncaria: prova de que o banco falso imita o PostgREST", async () => {
  const t = vazio(); for (let i = 0; i < 1500; i += 1) t.insumos.push({ id: id(i + 1), organizacao_id: A, nome: `I${i}` });
  globalThis.__supabaseFalso = criarBanco(t);
  const { data } = await globalThis.__supabaseFalso.from("insumos").select("*").eq("organizacao_id", A);
  assert.equal(data.length, 1000);
});

test("listarInsumos, listarProdutos, listarMargens e listarPendenciasCatalogo leem além de 1.000, em ordem determinística", async () => {
  const t = vazio();
  for (let i = 0; i < 1500; i += 1) t.insumos.push({ id: id(i + 1), organizacao_id: A, nome: `Insumo ${String(i % 700).padStart(4, "0")}`, tipo: "outro", unidade_medida: "g", preco_unitario: 1, ativo: true });
  for (let i = 0; i < 1201; i += 1) t.produtos.push({ id: id(20000 + i), organizacao_id: A, nome: `Prod ${String(i % 500).padStart(4, "0")}`, tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" });
  for (let i = 0; i < 1001; i += 1) t.vw_produto_margem.push({ organizacao_id: A, produto_id: id(20000 + (i % 1201)), nome: `Prod ${i}`, canal: i % 2 ? "ifood" : "balcao", tabela: "A", preco: 10, custo: 3 });
  for (let i = 0; i < 1100; i += 1) t.catalogo_origem.push({ id: id(70000 + i), organizacao_id: A, entidade: "produto", entidade_id: id(20000 + i), referencia: {}, pendencias: [{ codigo: "linha_sem_quantidade" }] });
  globalThis.__supabaseFalso = criarBanco(t);
  const ins = await insumosSvc.listarInsumos({ organizacaoId: A });
  assert.equal((ins.itens ?? ins).length, 1500);
  const prods = await svc.listarProdutos({ organizacaoId: A });
  assert.equal(prods.length, 1201); assert.equal(new Set(prods.map((p) => p.id)).size, 1201);
  assert.equal((await cmvSvc.listarMargens({ organizacaoId: A })).length, 1001);
  assert.equal((await svc.listarPendenciasCatalogo({ organizacaoId: A })).total, 1100);
});

// ------------------------------------------------------------------ integridade na homologação ANTIGA
function cenarioIntegridade() {
  const t = vazio();
  t.insumos.push({ id: id(901), organizacao_id: A, nome: "Insumo A", unidade_medida: "g", preco_unitario: 0.0149, ativo: true });
  t.produtos.push(
    { id: id(1), organizacao_id: A, nome: "CREME BASE", tipo: "submontagem", vendavel: false, ativo: true, rendimento: 2.6, unidade_rendimento: "g", homologacao: "pendente" },
    { id: id(2), organizacao_id: A, nome: "BOLO", tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" },
    { id: id(3), organizacao_id: A, nome: "COOKIE", tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" },
    { id: id(4), organizacao_id: A, nome: "TORTA ANTIGA", tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "homologada", homologado_custo: 40 },
    { id: id(5), organizacao_id: A, nome: "SUB PADRAO", tipo: "sanduiche", vendavel: true, ativo: true, rendimento: 1, homologacao: "nao_aplicavel" },
    { id: id(6), organizacao_id: B, nome: "OUTRA EMPRESA", tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" },
  );
  t.ficha_tecnica.push(
    { id: id(801), produto_id: id(1), insumo_id: id(901), quantidade: 2700, ativo: true },
    { id: id(802), produto_id: id(2), subproduto_id: id(1), quantidade: 400, ativo: true },    // usa a preparação suspeita (1º nível OK!)
    { id: id(803), produto_id: id(3), insumo_id: id(901), quantidade: 100, ativo: true },       // íntegro
    { id: id(804), produto_id: id(4), subproduto_id: id(1), quantidade: 2, ativo: true },       // já homologada, hoje inconsistente
    { id: id(805), produto_id: id(5), insumo_id: id(901), quantidade: 10, ativo: true },
  );
  globalThis.__supabaseFalso = criarBanco(t);
  return t;
}

test("homologação ANTIGA (individual): preparação com rendimento suspeito bloqueia a ficha que a usa (antes passava)", async () => {
  const t = cenarioIntegridade();
  await assert.rejects(() => svc.definirHomologacao({ organizacaoId: A, produtoId: id(2), acao: "homologar", usuario: ADMIN }), (e) => e.statusCode === 409 && e.details?.codigo === "FICHA_SEM_INTEGRIDADE");
  await assert.rejects(() => svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN }), /integridade/);
  assert.equal(t.produtos.find((p) => p.id === id(2)).homologacao, "pendente", "nada gravado");
  const ok = await svc.definirHomologacao({ organizacaoId: A, produtoId: id(3), acao: "homologar", usuario: ADMIN });
  assert.equal(ok.homologacao, "homologada");
});

test("homologação ANTIGA em lote usa o MESMO critério; isolamento e franquia preservados", async () => {
  cenarioIntegridade();
  const r = await svc.homologarLote({ organizacaoId: A, ids: [id(1), id(2), id(3), id(5), id(6)], usuario: ADMIN });
  assert.deepEqual(r.homologadas, [id(3)]);
  const rec = Object.fromEntries(r.recusadas.map((x) => [x.id, x.motivo]));
  assert.match(rec[id(2)], /integridade/); assert.match(rec[id(1)], /integridade/);
  assert.match(rec[id(5)], /não tem controle de homologação/, "Subway mantém a regra dela");
  assert.match(rec[id(6)], /não encontrado/i, "outra empresa");
});

test("lista antiga (catálogo de fichas): pode_homologar segue a integridade e expõe os motivos", async () => {
  cenarioIntegridade();
  const { itens } = await svc.listarFichasCatalogo({ organizacaoId: A });
  const by = Object.fromEntries(itens.map((i) => [i.nome, i]));
  assert.equal(by.BOLO.pode_homologar, false); assert.ok(by.BOLO.motivos_integridade.length);
  assert.equal(by.COOKIE.pode_homologar, true);
  assert.deepEqual(by["SUB PADRAO"].motivos_integridade, [], "padronizada fora do critério");
});

test("fichas JÁ homologadas que hoje seriam inconsistentes são listadas, NUNCA revogadas", async () => {
  const t = cenarioIntegridade();
  const d = await integ.diagnosticoIntegridade(A);
  const lista = integ.homologadasComInconsistencia(d);
  assert.deepEqual(lista.map((x) => x.nome), ["TORTA ANTIGA"]);
  assert.ok(lista[0].motivos.length);
  assert.equal(t.produtos.find((p) => p.id === id(4)).homologacao, "homologada", "continua homologada");
  assert.equal(globalThis.__supabaseFalso.log.filter((l) => l.op === "update").length, 0);
});

// ------------------------------------------------------------------ segurança dos serviços novos (isolamento)
test("serviços novos recusam alvo de OUTRA empresa sem escrever nada", async () => {
  cenarioIntegridade();
  const db = globalThis.__supabaseFalso;
  await assert.rejects(() => cmv2.definirCustoZero({ organizacaoId: B, insumoId: id(901), declarar: true, motivo: "x", usuario: ADMIN }), /não encontrado/i);
  await assert.rejects(() => cmv2.aplicarRendimentos({ organizacaoId: B, itens: [{ produto_id: id(1), rendimento_atual: 2.6, rendimento_novo: 2600, justificativa: "x" }], usuario: ADMIN }), (e) => e.statusCode === 422);
  await assert.rejects(() => cmv2.salvarRascunho({ organizacaoId: B, body: { natureza: "preparacao", produto_id: id(1) }, usuario: ADMIN }), /não encontrado/i);
  await assert.rejects(() => cmv2.definirPrecoOficial({ organizacaoId: B, produtoId: id(3), body: { canal: "ifood", preco: 10 }, usuario: ADMIN }), /não encontrado/i);
  await assert.rejects(() => cmv2.recuperarFicha({ organizacaoId: B, produtoId: id(1) }), /não encontrado/i);
  assert.equal(db.rpcs.length, 0, "nenhuma função de escrita chamada");
  assert.equal(db.log.filter((l) => ["update", "insert", "delete"].includes(l.op)).length, 0);
  const m = await cmv2.indicadoresMentoria({ organizacaoId: B });
  assert.equal(m.total_fichas, 1, "mentoria só enxerga a própria empresa");
});

test("preço oficial: recusa média/promoção, preparação e valor inválido; registra origem e histórico", async () => {
  const t = cenarioIntegridade();
  await assert.rejects(() => cmv2.definirPrecoOficial({ organizacaoId: A, produtoId: id(3), body: { canal: "ifood", preco: 10, origem: "média dos pedidos" } }), /não é preço oficial/);
  await assert.rejects(() => cmv2.definirPrecoOficial({ organizacaoId: A, produtoId: id(1), body: { canal: "ifood", preco: 10 } }), /Preparação/);
  await assert.rejects(() => cmv2.definirPrecoOficial({ organizacaoId: A, produtoId: id(3), body: { canal: "ifood", preco: 0 } }), /maior que zero/);
  await cmv2.definirPrecoOficial({ organizacaoId: A, produtoId: id(3), body: { canal: "ifood", preco: 12.9, origem: "cardápio vigente" }, usuario: ADMIN });
  assert.equal(t.produto_precos[0].origem, "cardápio vigente");
  assert.equal(t.produto_precos_historico?.[0]?.preco_novo, 12.9);
});

// ------------------------------------------------------------------ rotas: módulo piloto + permissões
const { produtosRouter } = await import("../src/modules/produtos/produtos.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { MODULOS } = await import("../src/shared/modulos.js");
async function chamar(papel, modulos, metodo, caminho, corpo) {
  const a = express(); a.use(express.json());
  a.use((req, _r, next) => { req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos, impersonando: false }; req.tenant = { organizacaoId: A, unidadeId: "u" }; next(); });
  a.use("/produtos", requireModulo(MODULOS.PRODUTOS_CMV), produtosRouter);
  a.use((err, _q, res, _n) => res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message }));
  const srv = a.listen(0);
  try { return (await fetch(`http://127.0.0.1:${srv.address().port}${caminho}`, { method: metodo, headers: { "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined })).status; }
  finally { await new Promise((ok) => srv.close(ok)); }
}
const P = id(3); const I = id(901);
const ROTAS = [["GET", "/produtos/cmv/saude"], ["GET", "/produtos/cmv/pendencias"], ["GET", "/produtos/cmv/mentoria"], ["POST", "/produtos/cmv/rendimentos/previa", {}],
  ["POST", "/produtos/cmv/rendimentos/aplicar", { itens: [] }], ["GET", `/produtos/cmv/custo-zero/${I}/previa`], ["POST", `/produtos/cmv/custo-zero/${I}`, { motivo: "x" }],
  ["GET", "/produtos/cmv/rascunhos"], ["POST", "/produtos/cmv/rascunhos", { natureza: "preparacao" }], ["GET", "/produtos/cmv/homologacao/previa"], ["POST", "/produtos/cmv/homologacao/lote", { ids: [P] }],
  ["POST", "/produtos/cmv/fichas", { nome: "x", natureza: "produto_final" }], ["GET", `/produtos/cmv/fichas/${P}/recuperacao`], ["POST", `/produtos/cmv/fichas/${P}/simular`, {}], ["PUT", `/produtos/cmv/fichas/${P}/preco`, { canal: "ifood", preco: 1 }]];

test("SEM products_cmv_v2 todas as rotas novas respondem 403, mesmo para administrador (chamada direta)", async () => {
  cenarioIntegridade();
  for (const [m, c, b] of ROTAS) assert.equal(await chamar("organization_admin", [MODULOS.PRODUTOS_CMV], m, c, b), 403, `${m} ${c}`);
});
test("COM o módulo: escritas críticas só para administrador; edição para quem edita produtos; consulta só lê", async () => {
  cenarioIntegridade();
  const MOD = [MODULOS.PRODUTOS_CMV, MODULOS.PRODUTOS_CMV_2];
  for (const [m, c, b] of [["POST", "/produtos/cmv/rendimentos/aplicar", { itens: [] }], ["POST", `/produtos/cmv/custo-zero/${I}`, { motivo: "x" }], ["POST", "/produtos/cmv/homologacao/lote", { ids: [P] }]]) {
    for (const papel of ["viewer", "finance", "operations"]) assert.equal(await chamar(papel, MOD, m, c, b), 403, `${papel} ${c}`);
  }
  for (const [m, c, b] of [["POST", "/produtos/cmv/rascunhos", { natureza: "preparacao" }], ["PUT", `/produtos/cmv/fichas/${P}/preco`, { canal: "ifood", preco: 1 }], ["POST", "/produtos/cmv/fichas", { nome: "x", natureza: "produto_final" }]]) {
    for (const papel of ["viewer", "finance"]) assert.equal(await chamar(papel, MOD, m, c, b), 403, `${papel} ${c}`);
  }
  for (const [m, c] of [["GET", "/produtos/cmv/saude"], ["GET", "/produtos/cmv/pendencias"], ["GET", "/produtos/cmv/mentoria"]]) assert.equal(await chamar("viewer", MOD, m, c), 200, c);
});
test("homologação ANTIGA continua disponível SEM o módulo piloto e aplica a integridade (não depende da flag)", async () => {
  cenarioIntegridade();
  assert.equal(await chamar("organization_admin", [MODULOS.PRODUTOS_CMV], "PATCH", `/produtos/${id(2)}/homologacao`, { acao: "homologar" }), 409);
  assert.equal(await chamar("organization_admin", [MODULOS.PRODUTOS_CMV], "PATCH", `/produtos/${id(3)}/homologacao`, { acao: "homologar" }), 200);
});
