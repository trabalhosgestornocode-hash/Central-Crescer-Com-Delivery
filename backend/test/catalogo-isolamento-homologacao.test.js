// Isolamento entre organizações + fluxo de homologação, rodando o CÓDIGO REAL dos serviços (produtos.service.js,
// custo.js, cmv.condicoes.js) sobre um banco em memória que REGISTRA toda consulta. Nenhum acesso a banco de verdade.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

// ---------------------------------------------------------------- banco em memória (query builder mínimo)
function criarBanco(tabelas) {
  const log = [];
  const db = {
    tabelas, log,
    from(nome) {
      const f = []; let op = "select"; let payload = null; let lim = null; let ord = null;
      const aplica = (rows) => rows.filter((r) => f.every((x) => x.op === "eq" ? r[x.col] === x.val : x.op === "neq" ? r[x.col] !== x.val : x.op === "in" ? x.val.includes(r[x.col]) : true));
      const exec = () => {
        const base = db.tabelas[nome] ?? [];
        log.push({ tabela: nome, op, filtros: f.map((x) => `${x.op}:${x.col}`), payload });
        if (op === "select") { let r = aplica(base).map((x) => structuredClone(x)); if (ord) r = [...r].sort((a, b) => String(a[ord]).localeCompare(String(b[ord]))); if (lim) r = r.slice(0, lim); return { data: r, error: null }; }
        if (op === "update") { const alvo = aplica(base); alvo.forEach((r) => Object.assign(r, payload)); return { data: alvo, error: null }; }
        if (op === "insert") { const linhas = Array.isArray(payload) ? payload : [payload]; (db.tabelas[nome] ??= []).push(...linhas.map((l) => ({ ...l }))); return { data: linhas, error: null }; }
        if (op === "upsert") { const chave = payload.__onConflict; const l = { ...payload }; delete l.__onConflict; const t = (db.tabelas[nome] ??= []); const i = t.findIndex((r) => chave.every((c) => r[c] === l[c])); if (i >= 0) Object.assign(t[i], l); else t.push(l); return { data: l, error: null }; }
        return { data: null, error: null };
      };
      const q = {
        select() { return q; }, eq(col, val) { f.push({ op: "eq", col, val }); return q; }, neq(col, val) { f.push({ op: "neq", col, val }); return q; },
        in(col, val) { f.push({ op: "in", col, val }); return q; }, order(col) { ord = col; return q; }, limit(n) { lim = n; return q; }, ilike() { return q; },
        update(p) { op = "update"; payload = p; return q; }, insert(p) { op = "insert"; payload = p; return q; },
        upsert(p, o) { op = "upsert"; payload = { ...p, __onConflict: String(o?.onConflict ?? "id").split(",") }; return q; },
        single() { const r = exec(); return Promise.resolve(r.data?.[0] ? { data: r.data[0], error: null } : { data: null, error: { message: "not found" } }); },
        maybeSingle() { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(a, b) { return Promise.resolve(exec()).then(a, b); },
      };
      return q;
    },
  };
  return db;
}

// ---------------------------------------------------------------- serviços reais sobre o banco em memória
// O hook redireciona só config/supabase.js para `globalThis.__supabaseFalso` (ver helpers/supabase-falso.hooks.mjs).
register("./helpers/supabase-falso.hooks.mjs", import.meta.url);
const svcReal = await import("../src/modules/produtos/produtos.service.js");
const condReal = await import("../src/modules/cmv/cmv.condicoes.js");

// ---------------------------------------------------------------- dados: duas empresas
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = (n, org, o = {}) => ({ id: id(n), organizacao_id: org, nome: `Produto ${n}`, vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente", homologacao_motivo: null, homologado_custo: null, homologado_em: null, homologado_por_nome: null, custo_manual: null, ...o });
function dados() {
  return {
    insumos: [
      { id: id(901), organizacao_id: A, nome: "Cenoura", tipo: "outro", unidade_medida: "g", preco_unitario: 0.01, ativo: true },
      { id: id(902), organizacao_id: A, nome: "Agua", tipo: "outro", unidade_medida: "ml", preco_unitario: 0, ativo: true },
      { id: id(903), organizacao_id: B, nome: "Farinha", tipo: "outro", unidade_medida: "g", preco_unitario: 0.02, ativo: true },
    ],
    produtos: [P(1, A, { rendimento: 4 }), P(2, A), P(3, B), P(4, A, { homologacao: "nao_aplicavel" })],
    ficha_tecnica: [
      { id: id(801), produto_id: id(1), insumo_id: id(901), quantidade: 400, ativo: true },   // A: lote 4,00 / 4 = 1,00
      { id: id(802), produto_id: id(2), insumo_id: id(902), quantidade: 50, ativo: true },    // A: insumo sem custo => incompleta
      { id: id(803), produto_id: id(3), insumo_id: id(903), quantidade: 100, ativo: true },   // B
      { id: id(804), produto_id: id(4), insumo_id: id(901), quantidade: 100, ativo: true },
    ],
    catalogo_origem: [
      { organizacao_id: A, entidade: "produto", entidade_id: id(1), referencia: { fontes: [{ categoria: "DOCES", arquivo: "d.xlsx", aba: "P1" }] }, pendencias: [] },
      { organizacao_id: A, entidade: "produto", entidade_id: id(2), referencia: { fontes: [{ categoria: "BEBIDAS" }] }, pendencias: [{ codigo: "insumo_sem_custo" }] },
      { organizacao_id: B, entidade: "produto", entidade_id: id(3), referencia: { fontes: [{ categoria: "SALGADOS" }] }, pendencias: [] },
    ],
    produto_historico: [], canais_venda: [], canais_venda_historico: [], ficha_mao_de_obra: [],
  };
}
async function ambiente() {
  const db = criarBanco(dados());
  globalThis.__supabaseFalso = db;
  return { db, svc: svcReal, cond: condReal };
}
const T = (db, n) => db.tabelas.produtos.find((p) => p.id === id(n));
const ADMIN = { id: "u1", nome: "Admin Teste", email: "admin@x.test" };

test("homologar produto de OUTRA empresa => 404 e NENHUMA escrita (isolamento)", async () => {
  const { db, svc } = await ambiente();
  await assert.rejects(() => svc.definirHomologacao({ organizacaoId: A, produtoId: id(3), acao: "homologar", usuario: ADMIN }), /não encontrado/i);
  assert.equal(T(db, 3).homologacao, "pendente");
  assert.equal(db.log.filter((l) => l.op === "update").length, 0);
});
test("homologar ficha completa: grava custo homologado, responsável (nome) e histórico — sempre filtrando pela organização", async () => {
  const { db, svc } = await ambiente();
  const r = await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  assert.deepEqual(r, { id: id(1), homologacao: "homologada", alterado: true });
  const p = T(db, 1);
  assert.equal(p.homologacao, "homologada"); assert.equal(p.homologado_por_nome, "Admin Teste"); assert.ok(p.homologado_em);
  assert.ok(Math.abs(p.homologado_custo - 1) < 1e-9); // custo unitário com rendimento 4
  assert.equal(db.tabelas.produto_historico.length, 1);
  for (const l of db.log.filter((x) => x.tabela === "produtos" && x.op === "update")) assert.ok(l.filtros.includes("eq:organizacao_id"), "update de produtos sem filtro de organização");
  assert.equal(T(db, 3).homologacao, "pendente"); // produto da outra empresa intocado
});
test("ficha INCOMPLETA não homologa (409) e produto sem controle (Subway/manual) é recusado", async () => {
  const { db, svc } = await ambiente();
  await assert.rejects(() => svc.definirHomologacao({ organizacaoId: A, produtoId: id(2), acao: "homologar", usuario: ADMIN }), (e) => e.statusCode === 409 && /incompleta/i.test(e.message));
  await assert.rejects(() => svc.definirHomologacao({ organizacaoId: A, produtoId: id(4), acao: "homologar", usuario: ADMIN }), (e) => e.statusCode === 409 && /não tem controle/i.test(e.message));
  assert.equal(T(db, 2).homologacao, "pendente"); assert.equal(T(db, 4).homologacao, "nao_aplicavel");
});
test("homologar em LOTE: homologa as íntegras, recusa incompleta e id de outra empresa (sem tocar nela)", async () => {
  const { db, svc } = await ambiente();
  const r = await svc.homologarLote({ organizacaoId: A, ids: [id(1), id(2), id(3)], usuario: ADMIN });
  assert.deepEqual(r.homologadas, [id(1)]);
  assert.deepEqual(r.recusadas.map((x) => x.id).sort(), [id(2), id(3)].sort());
  assert.equal(T(db, 3).homologacao, "pendente");
  await assert.rejects(() => svc.homologarLote({ organizacaoId: A, ids: [], usuario: ADMIN }), /ao menos uma/i);
  await assert.rejects(() => svc.homologarLote({ organizacaoId: A, ids: Array.from({ length: 501 }, (_, i) => id(i + 1)), usuario: ADMIN }), /500/);
});
test("repetir a homologação de uma ficha ainda válida não altera nada (idempotente)", async () => {
  const { svc } = await ambiente();
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  const r = await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  assert.equal(r.alterado, false);
});
test("INVALIDAÇÃO por custo: reajuste de insumo > 0,5% invalida; a lista mostra 'pendente/custo_alterado'; rehomologar renova o custo base", async () => {
  const { db, svc } = await ambiente();
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  let lista = (await svc.listarFichasCatalogo({ organizacaoId: A })).itens.find((i) => i.id === id(1));
  assert.equal(lista.homologacao, "homologada"); assert.equal(lista.homologado_por_nome, "Admin Teste");
  db.tabelas.insumos.find((i) => i.id === id(901)).preco_unitario = 0.0102; // +2%
  lista = (await svc.listarFichasCatalogo({ organizacaoId: A })).itens.find((i) => i.id === id(1));
  assert.equal(lista.homologacao, "pendente"); assert.equal(lista.homologacao_motivo, "custo_alterado");
  assert.equal(lista.homologado_por_nome, null); assert.equal(lista.pode_homologar, true);
  const r = await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  assert.equal(r.alterado, true);
  assert.ok(Math.abs(T(db, 1).homologado_custo - 1.02) < 1e-9);
});
test("reabrir homologação registra motivo e limpa responsável", async () => {
  const { db, svc } = await ambiente();
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "reabrir", usuario: ADMIN });
  const p = T(db, 1);
  assert.deepEqual([p.homologacao, p.homologacao_motivo, p.homologado_por_nome, p.homologado_custo], ["pendente", "reaberta_manualmente", null, null]);
});
test("catálogo de fichas: SÓ da empresa do contexto, com categoria, natureza, custo por porção e pendências", async () => {
  const { svc } = await ambiente();
  const r = await svc.listarFichasCatalogo({ organizacaoId: A });
  assert.deepEqual(r.itens.map((i) => i.id).sort(), [id(1), id(2), id(4)].sort()); // nenhum produto da empresa B
  const p1 = r.itens.find((i) => i.id === id(1)); const p2 = r.itens.find((i) => i.id === id(2));
  assert.equal(p1.categoria, "DOCES"); assert.equal(p1.rendimento, 4); assert.ok(Math.abs(p1.custo_unitario - 1) < 1e-9); assert.equal(p1.pode_homologar, true);
  assert.equal(p2.ficha_completa, false); assert.equal(p2.custo_unitario, null); assert.equal(p2.pode_homologar, false); assert.deepEqual(p2.pendencias, [{ codigo: "insumo_sem_custo" }]);
  assert.equal(r.resumo.incompletas, 1); assert.equal(r.resumo.prontas_para_homologar, 1);
  const rb = await svc.listarFichasCatalogo({ organizacaoId: B });
  assert.deepEqual(rb.itens.map((i) => i.id), [id(3)]);
});
test("editar rendimento: valida, filtra por organização e recusa produto de outra empresa", async () => {
  const { db, svc } = await ambiente();
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(3), dados: { rendimento: 5 }, usuario: ADMIN }), /não encontrado/i);
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { rendimento: 0 }, usuario: ADMIN }), /maior que zero/);
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { rendimento: "abc" }, usuario: ADMIN }), /maior que zero/);
  assert.equal(T(db, 1).rendimento, 4); assert.equal(T(db, 3).rendimento, 1);
  await svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { rendimento: 8 }, usuario: ADMIN });
  assert.equal(T(db, 1).rendimento, 8);
  assert.equal(db.tabelas.produto_historico.some((h) => h.campo === "rendimento" && h.valor_anterior === "4" && h.valor_novo === "8"), true);
});
test("condições comerciais: grava SEMPRE na organização do contexto (ignora organizacao_id do corpo), com histórico antes/depois", async () => {
  const { db, cond } = await ambiente();
  const r = await cond.salvarCondicao({ organizacaoId: A, body: { canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, organizacao_id: B }, usuario: ADMIN });
  assert.equal(db.tabelas.canais_venda.length, 1);
  assert.equal(db.tabelas.canais_venda[0].organizacao_id, A);
  assert.deepEqual(r.canais.map((c) => [c.canal, c.comissao]), [["ifood", 0.23]]);
  await cond.salvarCondicao({ organizacaoId: A, body: { canal: "ifood", comissao: 0.25, taxas: 0.015, promocao: 0.05 }, usuario: ADMIN });
  assert.equal(db.tabelas.canais_venda.length, 1); // upsert, sem duplicar
  const h = db.tabelas.canais_venda_historico;
  assert.equal(h.length, 2); assert.equal(h[1].antes.comissao, 0.23); assert.equal(h[1].depois.comissao, 0.25); assert.equal(h[1].usuario_nome, "Admin Teste");
  assert.deepEqual((await cond.condicoesComerciais({ organizacaoId: B })).canais, []); // a outra empresa não enxerga nada
  await assert.rejects(() => cond.salvarCondicao({ organizacaoId: A, body: { canal: "ifood" }, usuario: ADMIN }), /comissão/i);
});

test("código do PDV: grava, é ÚNICO por empresa (sem diferenciar caixa), pode repetir em OUTRA empresa e vazio remove o vínculo", async () => {
  const { db, svc } = await ambiente();
  db.tabelas.produtos.find((p) => p.id === id(3)).codigo_pdv = "CAP-001"; // empresa B já usa este código
  await svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { codigo_pdv: " CAP-001 " }, usuario: ADMIN });
  assert.equal(T(db, 1).codigo_pdv, "CAP-001");                      // o mesmo código é livre na empresa A
  assert.equal(db.tabelas.produto_historico.some((h) => h.campo === "codigo_pdv" && h.valor_novo === "CAP-001"), true);
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(2), dados: { codigo_pdv: "cap-001" }, usuario: ADMIN }), (e) => e.statusCode === 409 && /já está em uso por "Produto 1"/.test(e.message));
  assert.equal(T(db, 2).codigo_pdv, undefined);
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { codigo_pdv: "x".repeat(61) }, usuario: ADMIN }), /60 caracteres/);
  await assert.rejects(() => svc.atualizarProduto({ organizacaoId: A, id: id(3), dados: { codigo_pdv: "Z9" }, usuario: ADMIN }), /não encontrado/i); // produto da B, via contexto A
  await svc.atualizarProduto({ organizacaoId: A, id: id(1), dados: { codigo_pdv: "" }, usuario: ADMIN });
  assert.equal(T(db, 1).codigo_pdv, null);
  assert.equal(T(db, 3).codigo_pdv, "CAP-001"); // B intocada
  const lista = await svc.listarFichasCatalogo({ organizacaoId: A });
  assert.ok(lista.itens.every((i) => "codigo_pdv" in i));
});

// ---------------------------------------------------------------- detalhe do produto (o mesmo obterProduto das Subways)
async function ambienteDetalhe() {
  const e = await ambiente();
  const t = e.db.tabelas;
  t.insumos.push({ id: id(910), organizacao_id: A, nome: "Caixa", tipo: "embalagem", unidade_medida: "un", preco_unitario: 1.2, ativo: true });
  t.produtos.push(P(5, A, { nome: "Calda", vendavel: false, rendimento: 500, unidade_rendimento: "g" })); // preparação
  t.ficha_tecnica.push(
    { id: id(810), produto_id: id(5), insumo_id: id(901), quantidade: 50, ativo: true },    // calda: lote 0,50 => 0,001/g
    { id: id(811), produto_id: id(1), subproduto_id: id(5), quantidade: 100, ativo: true }, // 100 g de calda => 0,10
    { id: id(812), produto_id: id(1), insumo_id: id(910), quantidade: 1, ativo: true });    // embalagem 1,20
  t.ficha_mao_de_obra.push(
    { organizacao_id: A, produto_id: id(1), funcao: "confeiteira", minutos: 10, custo_minuto: 0.3 },   // própria: 3,00 no lote
    { organizacao_id: A, produto_id: id(5), funcao: "confeiteira", minutos: 25, custo_minuto: 0.2 },   // calda: 5,00 no lote de 500 g
    { organizacao_id: B, produto_id: id(3), funcao: "outra", minutos: 99, custo_minuto: 9 });
  t.produto_precos = [{ produto_id: id(1), canal: "ifood", tabela: "A", preco: 20, desatualizado: false }];
  return e;
}
const detalheDe = (svc, org, n) => svc.obterProduto({ organizacaoId: org, id: id(n) });

test("DETALHE Subway (nao_aplicavel): sem campos de catálogo e com o MESMO custo/ficha de sempre", async () => {
  const { svc } = await ambienteDetalhe();
  const d = await detalheDe(svc, A, 4);
  assert.equal(d.controlado, false); assert.equal(d.catalogo, null);
  assert.ok(Math.abs(d.custo - 1) < 1e-9);               // 100 g × 0,01 — rendimento 1
  assert.equal(d.ficha.length, 1); assert.equal(d.ficha[0].nome, "Cenoura");
  assert.equal(d.homologacao_info.estado, "nao_aplicavel");
});
test("DETALHE Caramelle: formação do custo por grupo, rendimento, custo unitário e mão de obra SEPARADA (própria + herdada)", async () => {
  const { svc } = await ambienteDetalhe();
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "reabrir", usuario: ADMIN }).catch(() => {});
  const d = await detalheDe(svc, A, 1);
  assert.equal(d.controlado, true);
  const f = d.catalogo.formacao_custo;
  assert.ok(Math.abs(f.lote.ingredientes.total - 4) < 1e-9);       // 400 g × 0,01
  assert.ok(Math.abs(f.lote.preparacoes.total - 0.1) < 1e-9);      // 100 g × (0,50/500)
  assert.ok(Math.abs(f.lote.embalagens.total - 1.2) < 1e-9);
  assert.ok(Math.abs(f.lote.total - 5.3) < 1e-9);
  assert.equal(f.rendimento, 4);
  assert.ok(Math.abs(f.custo_unitario_materiais - 1.325) < 1e-9);  // 5,30 / 4
  assert.ok(Math.abs(d.custo - 1.325) < 1e-9);                     // o custo do produto É o unitário (base do CMV)
  const m = d.catalogo.mao_de_obra;
  assert.ok(Math.abs(m.proprio_lote - 3) < 1e-9); assert.ok(Math.abs(m.herdado_lote - 100 * (5 / 500)) < 1e-9); // 1,00 herdado da calda
  assert.ok(Math.abs(m.custo_unitario - 1) < 1e-9);                // (3 + 1) / 4
  assert.equal(m.linhas.length, 1);
  assert.ok(!("mao_de_obra" in f) && Math.abs(d.custo - f.custo_unitario_materiais) < 1e-9, "MOD não pode entrar no custo/CMV");
  assert.equal(d.rendimento, 4); assert.equal(d.catalogo.categoria, "DOCES"); assert.equal(d.catalogo.natureza, "produto_final");
  assert.equal(d.precos.length, 1);
});
test("DETALHE: preparação mostra a unidade do rendimento; produto com insumo sem custo: grupo e unitário null (nada inventado)", async () => {
  const { svc } = await ambienteDetalhe();
  const calda = await detalheDe(svc, A, 5);
  assert.equal(calda.catalogo.natureza, "preparacao"); assert.equal(calda.catalogo.formacao_custo.unidade_rendimento, "g");
  const inc = await detalheDe(svc, A, 2); // usa insumo sem custo
  assert.equal(inc.catalogo.formacao_custo.lote.total, null); assert.equal(inc.catalogo.formacao_custo.custo_unitario_materiais, null);
  assert.equal(inc.catalogo.pendencias[0].codigo, "insumo_sem_custo");
});
test("DETALHE: preparação na ficha do pai traz a unidade da preparação (g), nas Subways (sem unidade) segue 'un'", async () => {
  const { svc } = await ambienteDetalhe();
  const d = await detalheDe(svc, A, 1);
  const sub = d.ficha.find((c) => c.tipo === "submontagem");
  assert.equal(sub.unidade, "g"); assert.equal(sub.unidade_base, "g");
});
test("DETALHE ISOLADO: produto/MOD de outra empresa nunca aparecem (404 e nenhum vazamento)", async () => {
  const { svc } = await ambienteDetalhe();
  await assert.rejects(() => detalheDe(svc, A, 3), /não encontrado/i);
  const b = await detalheDe(svc, B, 3);
  assert.equal(b.catalogo.mao_de_obra.linhas[0].funcao, "outra");
  const a = await detalheDe(svc, A, 1);
  assert.ok(!JSON.stringify(a).includes("outra"));
});

// ---------------------------------------------------------------- adicionar PREPARAÇÃO intermediária à receita
async function ambientePrep() {
  const e = await ambiente();
  const t = e.db.tabelas;
  t.produtos.push(
    P(5, A, { nome: "Calda", vendavel: false, rendimento: 500, unidade_rendimento: "g" }),
    P(6, A, { nome: "Cobertura", vendavel: false, rendimento: 100, unidade_rendimento: "g" }),
    P(7, B, { nome: "Prep da B", vendavel: false, rendimento: 1 }),
    P(8, A, { nome: "Prep inativa", vendavel: false, ativo: false }));
  t.ficha_tecnica.push(
    { id: id(810), produto_id: id(5), insumo_id: id(901), quantidade: 50, ativo: true },     // Calda: lote 0,50 => 0,001/g
    { id: id(811), produto_id: id(6), subproduto_id: id(5), quantidade: 100, ativo: true }); // Cobertura usa 100 g de Calda
  return e;
}
const addPrep = (svc, org, pid, dados) => svc.adicionarComponente({ organizacaoId: org, produtoId: id(pid), dados, usuario: ADMIN });

test("PREPARAÇÃO: adiciona à receita, custo = qtd × (lote ÷ rendimento) ÷ rendimento do produto, e registra histórico", async () => {
  const { db, svc } = await ambientePrep();
  const antes = (await svc.obterProduto({ organizacaoId: A, id: id(1) })).custo;
  const r = await addPrep(svc, A, 1, { subproduto_id: id(5), quantidade: 200, unidade: "g" });
  assert.ok(Math.abs(r.produto.custo - (antes + (200 * 0.001) / 4)) < 1e-9);          // +0,05 por unidade (rendimento 4)
  const linha = db.tabelas.ficha_tecnica.find((l) => l.produto_id === id(1) && l.subproduto_id === id(5));
  assert.equal(linha.quantidade, 200); assert.equal(linha.unidade_uso, "g");
  assert.ok(db.tabelas.produto_historico.some((h) => h.campo === "ficha_preparacao" && /Calda — 200 g/.test(h.valor_novo)));
  assert.ok(r.produto.ficha.some((c) => c.tipo === "submontagem" && c.unidade === "g"));
});
test("PREPARAÇÃO: converte unidade compatível para a do rendimento (0,2 kg => 200 g); recusa incompatível, zero e negativa", async () => {
  const { db, svc } = await ambientePrep();
  await addPrep(svc, A, 1, { subproduto_id: id(5), quantidade: 0.2, unidade: "kg" });
  assert.equal(db.tabelas.ficha_tecnica.find((l) => l.produto_id === id(1) && l.subproduto_id === id(5)).quantidade, 200);
  await assert.rejects(() => addPrep(svc, A, 2, { subproduto_id: id(5), quantidade: 10, unidade: "ml" }), /incompat/i);
  await assert.rejects(() => addPrep(svc, A, 2, { subproduto_id: id(5), quantidade: 0, unidade: "g" }), /maior que zero/i);
  await assert.rejects(() => addPrep(svc, A, 2, { subproduto_id: id(5), quantidade: -3, unidade: "g" }));
});
test("PREPARAÇÃO: recusa ciclo (direto, indireto e auto-referência)", async () => {
  const { db, svc } = await ambientePrep();
  await assert.rejects(() => addPrep(svc, A, 5, { subproduto_id: id(6), quantidade: 10, unidade: "g" }), /circular/i); // Calda usa Cobertura, que usa Calda
  await assert.rejects(() => addPrep(svc, A, 5, { subproduto_id: id(5), quantidade: 10, unidade: "g" }), /a si mesma/i);
  assert.equal(db.tabelas.ficha_tecnica.filter((l) => l.produto_id === id(5) && l.subproduto_id).length, 0);
});
test("PREPARAÇÃO ISOLADA: preparação de OUTRA empresa não é encontrada; produto vendido e preparação inativa são recusados", async () => {
  const { db, svc } = await ambientePrep();
  const n = db.tabelas.ficha_tecnica.length;
  await assert.rejects(() => addPrep(svc, A, 1, { subproduto_id: id(7), quantidade: 1 }), /não encontrada nesta empresa/i);
  await assert.rejects(() => addPrep(svc, A, 1, { subproduto_id: id(2), quantidade: 1 }), /produto vendido/i);
  await assert.rejects(() => addPrep(svc, A, 1, { subproduto_id: id(8), quantidade: 1 }), /inativa/i);
  await assert.rejects(() => addPrep(svc, A, 3, { subproduto_id: id(5), quantidade: 1 }), /não encontrado/i); // produto da B pelo contexto A
  assert.equal(db.tabelas.ficha_tecnica.length, n);
});
test("PREPARAÇÃO + HOMOLOGAÇÃO: adicionar muda o custo além da tolerância => a ficha homologada deixa de valer (custo_alterado)", async () => {
  const { svc } = await ambientePrep();
  await svc.definirHomologacao({ organizacaoId: A, produtoId: id(1), acao: "homologar", usuario: ADMIN });
  await addPrep(svc, A, 1, { subproduto_id: id(5), quantidade: 200, unidade: "g" });
  const it = (await svc.listarFichasCatalogo({ organizacaoId: A })).itens.find((i) => i.id === id(1));
  assert.equal(it.homologacao, "pendente"); assert.equal(it.homologacao_motivo, "custo_alterado");
});
test("PREPARAÇÃO: a lista de produtos expõe rendimento e unidade (para o seletor) e só as da própria empresa", async () => {
  const { svc } = await ambientePrep();
  const l = await svc.listarProdutos({ organizacaoId: A, vendavel: false });
  assert.deepEqual(l.map((p) => p.id).sort(), [id(5), id(6), id(8)].sort());
  const calda = l.find((p) => p.id === id(5));
  assert.equal(calda.rendimento, 500); assert.equal(calda.unidade_rendimento, "g");
});
test("dependeDe: alcança descendentes, ignora linhas inativas e tolera ciclos pré-existentes", async () => {
  const { dependeDe } = await import("../src/modules/produtos/custo.js");
  const g = { fichaByProd: new Map([["a", [{ subproduto_id: "b", ativo: true }]], ["b", [{ subproduto_id: "c", ativo: true }, { subproduto_id: "z", ativo: false }]], ["c", [{ subproduto_id: "a", ativo: true }]]]) };
  assert.equal(dependeDe("a", "c", g), true); assert.equal(dependeDe("a", "z", g), false); assert.equal(dependeDe("c", "b", g), true);
});
