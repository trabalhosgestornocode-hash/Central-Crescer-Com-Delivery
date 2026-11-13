// Homologação sobre uma CARGA REAL simulada: roda o código real (produtos.service + custo.js) num banco em memória
// montado a partir do payload/relatório do importador. Prova que o botão "Homologar em lote" (com TODOS os ids) só
// homologa as fichas completas e recusa toda ficha com custo incompleto — inclusive as que tiveram linha descartada.
//
// Os dados do cliente ficam FORA do repositório: informe CATALOGO_PAYLOAD=<payload.json> e CATALOGO_RELATORIO=<relatorio.json>.
// Sem as variáveis, o teste é PULADO (não falha). A parte final (payload com homologação) roda sempre, com dado sintético.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, existsSync } from "node:fs";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const PAYLOAD = process.env.CATALOGO_PAYLOAD; const RELATORIO = process.env.CATALOGO_RELATORIO;
const PULAR = !(PAYLOAD && RELATORIO && existsSync(PAYLOAD) && existsSync(RELATORIO)) && "defina CATALOGO_PAYLOAD e CATALOGO_RELATORIO (arquivos fora do repositório)";

function criarBanco(tabelas) {
  const db = {
    tabelas,
    from(nome) {
      const f = []; let op = "select"; let payload = null;
      const aplica = (rows) => rows.filter((r) => f.every((x) => (x.op === "eq" ? r[x.col] === x.val : x.op === "in" ? x.val.includes(r[x.col]) : x.op === "neq" ? r[x.col] !== x.val : true)));
      const exec = () => {
        const base = db.tabelas[nome] ?? [];
        if (op === "select") return { data: aplica(base).map((x) => structuredClone(x)), error: null };
        if (op === "update") { const alvo = aplica(base); alvo.forEach((r) => Object.assign(r, payload)); return { data: alvo, error: null }; }
        if (op === "insert") { (db.tabelas[nome] ??= []).push(...[].concat(payload).map((l) => ({ ...l }))); return { data: payload, error: null }; }
        return { data: null, error: null };
      };
      const q = {
        select() { return q; }, eq(c, v) { f.push({ op: "eq", col: c, val: v }); return q; }, neq(c, v) { f.push({ op: "neq", col: c, val: v }); return q; },
        in(c, v) { f.push({ op: "in", col: c, val: v }); return q; }, order() { return q; }, limit() { return q; },
        update(p) { op = "update"; payload = p; return q; }, insert(p) { op = "insert"; payload = p; return q; },
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
const svc = await import("../src/modules/produtos/produtos.service.js");
const { validarPayload } = await import("../src/modules/catalogo-importacao/catalogo.planejar.js");

const ORG = "c0ffee00-0000-4000-8000-000000000001";
const OUTRA = "c0ffee00-0000-4000-8000-000000000002";
const ADMIN = { id: "u1", nome: "Admin", email: "a@x.test" };

/** Monta as tabelas como fn_catalogo_importar gravaria (mesma regra de preço unitário). */
function bancoDaCarga(payload) {
  const idDe = new Map(); let n = 0;
  const novo = (chave) => { const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`; idDe.set(chave, id); return id; };
  const insumos = payload.insumos.map((i) => ({ id: novo(i.chave), organizacao_id: ORG, nome: i.nome, tipo: i.tipo, unidade_medida: i.unidade_medida, ativo: true,
    preco_unitario: i.preco_caixa != null && i.rendimento > 0 ? i.preco_caixa / i.rendimento : 0, categoria_id: null }));
  const produtos = payload.produtos.map((p) => ({ id: novo(p.chave), organizacao_id: ORG, nome: p.nome, tipo: p.tipo, vendavel: p.vendavel, ativo: true,
    rendimento: p.rendimento, unidade_rendimento: p.unidade_rendimento ?? null, homologacao: "pendente", homologacao_motivo: null, homologado_custo: null, custo_manual: null }));
  const ficha_tecnica = payload.produtos.flatMap((p) => p.linhas.map((l, k) => ({ id: `f-${idDe.get(p.chave)}-${k}`, produto_id: idDe.get(p.chave), ativo: true, quantidade: l.quantidade,
    ...(l.ref === "insumo" ? { insumo_id: idDe.get(l.chave) } : { subproduto_id: idDe.get(l.chave) }) })));
  const catalogo_origem = [
    ...payload.produtos.map((p) => ({ id: `o-${idDe.get(p.chave)}`, organizacao_id: ORG, entidade: "produto", entidade_id: idDe.get(p.chave), referencia: p.referencia, pendencias: p.pendencias })),
  ];
  // outra empresa com um produto completo: nunca pode ser homologado a partir do contexto de ORG
  insumos.push({ id: "00000000-0000-4000-9999-000000000001", organizacao_id: OUTRA, nome: "X", tipo: "outro", unidade_medida: "g", ativo: true, preco_unitario: 1 });
  produtos.push({ id: "00000000-0000-4000-9999-000000000002", organizacao_id: OUTRA, nome: "Y", tipo: "outro", vendavel: true, ativo: true, rendimento: 1, homologacao: "pendente" });
  ficha_tecnica.push({ id: "f-outra", produto_id: "00000000-0000-4000-9999-000000000002", insumo_id: "00000000-0000-4000-9999-000000000001", quantidade: 1, ativo: true });
  return { db: criarBanco({ insumos, produtos, ficha_tecnica, catalogo_origem, produto_historico: [], produto_precos: [], ficha_mao_de_obra: [] }), idDe };
}

test("CARGA REAL: o lote com TODOS os ids homologa exatamente as fichas completas e recusa todas as incompletas", { skip: PULAR }, async () => {
  const payload = JSON.parse(readFileSync(PAYLOAD, "utf8"));
  const rel = JSON.parse(readFileSync(RELATORIO, "utf8"));
  const { db, idDe } = bancoDaCarga(payload);
  globalThis.__supabaseFalso = db;
  const incompletas = new Set(rel.fichas_pendentes.map((f) => idDe.get(f.chave)));
  const completas = new Set(payload.produtos.map((p) => idDe.get(p.chave)).filter((id) => !incompletas.has(id)));

  const lista = await svc.listarFichasCatalogo({ organizacaoId: ORG });
  const prontas = new Set(lista.itens.filter((i) => i.pode_homologar).map((i) => i.id));
  assert.deepEqual([...prontas].sort(), [...completas].sort(), "'prontas para homologar' = completas do importador");
  for (const i of lista.itens.filter((x) => incompletas.has(x.id))) assert.equal(i.custo_unitario, null, `${i.nome}: custo incompleto não pode aparecer`);

  const todos = [...idDe.values()].filter((id) => lista.itens.some((i) => i.id === id)).concat("00000000-0000-4000-9999-000000000002");
  const r = await svc.homologarLote({ organizacaoId: ORG, ids: todos, usuario: ADMIN });
  assert.deepEqual(new Set(r.homologadas), completas, "homologou só as completas");
  assert.equal(r.recusadas.length, incompletas.size + 1, "recusou as incompletas e o produto de outra empresa");
  for (const id of incompletas) assert.equal(db.tabelas.produtos.find((p) => p.id === id).homologacao, "pendente");
  assert.equal(db.tabelas.produtos.find((p) => p.organizacao_id === OUTRA).homologacao, "pendente");

  // e um a um (botão individual): nenhuma incompleta passa
  for (const id of incompletas) await assert.rejects(svc.definirHomologacao({ organizacaoId: ORG, produtoId: id, acao: "homologar", usuario: ADMIN }), (e) => e.statusCode === 409);
});

test("a CARGA nunca homologa: payload com homologacao diferente de 'pendente' é recusado antes do banco", () => {
  const base = { insumos: [{ chave: "ing:A", unidade_medida: "g" }], produtos: [{ chave: "fin:x", rendimento: 1, homologacao: "pendente", linhas: [{ ref: "insumo", chave: "ing:A", quantidade: 1 }] }] };
  assert.deepEqual(validarPayload(base), []);
  const ruim = structuredClone(base); ruim.produtos[0].homologacao = "homologada";
  assert.match(validarPayload(ruim).join(";"), /homologação não permitida na carga/);
  const semCampo = structuredClone(base); delete semCampo.produtos[0].homologacao;
  assert.deepEqual(validarPayload(semCampo), []);
});
