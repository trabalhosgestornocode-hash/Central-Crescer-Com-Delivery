// Modelo do lançamento rápido — puro, sem DOM nem rede. Rodar: node --test frontend/test/lancamentoRapidoModelo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/financeiro/lancamentoRapidoModelo.js";

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CATS = [
  { id: U(1), nome: "RECEBIMENTO", papel: "receita_operacional", ativo: true }, { id: U(2), nome: "INSUMOS - FRUTAS", papel: "custo_variavel", ativo: true },
  { id: U(3), nome: "ALUGUEL", papel: "despesa_fixa", ativo: true }, { id: U(4), nome: "ENTRE CONTAS", papel: "transferencia", ativo: true },
  { id: U(5), nome: "SALDO MÊS ANTERIOR", papel: "saldo_anterior", ativo: true }, { id: U(6), nome: "ANTIGA", papel: "despesa_fixa", ativo: false },
  { id: U(7), nome: "EMPRÉSTIMO", papel: "financiamento", ativo: true },
];
const CONTAS = [{ id: U(11), nome: "UNICRED", ativo: true }, { id: U(12), nome: "STONE", ativo: true }, { id: U(13), nome: "VELHA", ativo: false }];
const lanc = (descricao, categoria, extra = {}) => ({ descricao, categoria_id: categoria, conta_id: U(11), sentido: "saida", status: "realizado", data_movimento: "2026-11-01", ...extra });

describe("valor digitado", () => {
  test("aceita formatos comuns e converte para centavos", () => {
    for (const [t, c] of [["120", 12000], ["120,50", 12050], ["1.234,56", 123456], ["R$ 8,00", 800], ["12,5", 1250], ["788.15", 78815], ["0,01", 1]]) assert.equal(M.valorEmCentavos(t), c, t);
  });
  test("recusa vazio, zero, negativo e texto", () => {
    for (const t of ["", "0", "0,00", "-5", "abc", "1,234,56", "12,345", null, undefined]) assert.equal(M.valorEmCentavos(t), null, String(t));
  });
  test("para o servidor: texto com ponto e duas casas", () => { assert.equal(M.valorParaServidor(12050), "120.50"); assert.equal(M.valorParaServidor(5), "0.05"); assert.equal(M.valorParaServidor(100000), "1000.00"); });
});

describe("datas", () => {
  test("hoje e ontem no relógio local (sem UTC)", () => {
    const d = new Date(2026, 10, 1, 23, 30);   // 01/11 às 23h30 local: UTC já seria 02/11
    assert.equal(M.hojeIso(d), "2026-11-01"); assert.equal(M.ontemIso(d), "2026-10-31");
    assert.equal(M.ontemIso(new Date(2026, 2, 1)), "2026-02-28");
  });
  test("data válida", () => { assert.equal(M.dataValida("2026-02-29"), false); assert.equal(M.dataValida("2026-11-10"), true); assert.equal(M.dataValida(""), false); });
});

describe("categorias oferecidas", () => {
  test("saída: sem receita, transferência, saldo anterior nem inativas", () => {
    assert.deepEqual(M.categoriasPara("saiu", CATS).map((c) => c.nome), ["INSUMOS - FRUTAS", "ALUGUEL", "EMPRÉSTIMO"]);
  });
  test("conta a pagar: também sem financiamento (empréstimo tem tela própria)", () => {
    assert.deepEqual(M.categoriasPara("saiu", CATS, { aPagar: true }).map((c) => c.nome), ["INSUMOS - FRUTAS", "ALUGUEL"]);
  });
  test("entrada: só receitas; se não houver, todas as válidas", () => {
    assert.deepEqual(M.categoriasPara("entrou", CATS).map((c) => c.nome), ["RECEBIMENTO"]);
    assert.ok(M.categoriasPara("entrou", CATS.filter((c) => c.papel !== "receita_operacional")).length > 0);
  });
});

describe("sugestão de categoria (só com base no histórico)", () => {
  const permitidas = M.categoriasPara("saiu", CATS);
  const hist = [lanc("Polpa de açaí", U(2)), lanc("Polpa de açaí", U(2)), lanc("Polpa de açaí", U(3)), lanc("Aluguel novembro", U(3)), lanc("Frutas Distribuidora Sul", U(2)), lanc("Venda do dia", U(1), { sentido: "entrada" })];
  test("descrição igual → categoria mais usada, com o motivo escrito", () => {
    const s = M.sugerirCategoria("polpa de acai", hist, permitidas, "saiu");
    assert.equal(s.categoriaId, U(2)); assert.match(s.motivo, /usaram esta categoria: 2 de 3/);
  });
  test("palavra forte em comum (nome do fornecedor) → categoria dos parecidos", () => {
    const s = M.sugerirCategoria("Distribuidora Sul - boleto", hist, permitidas, "saiu");
    assert.equal(s.categoriaId, U(2)); assert.match(s.motivo, /“distribuidora”|“frutas”|“sul”/i);
  });
  test("sem base real: NÃO chuta", () => {
    assert.equal(M.sugerirCategoria("Coisa nunca vista", hist, permitidas, "saiu"), null);
    assert.equal(M.sugerirCategoria("ab", hist, permitidas, "saiu"), null);
    assert.equal(M.sugerirCategoria("Polpa", [], permitidas, "saiu"), null);
  });
  test("palavras fracas (pagamento, compra, boleto…) sozinhas não bastam", () => {
    assert.equal(M.sugerirCategoria("pagamento compra boleto", [lanc("Pagamento compra boleto X", U(2))].map((l) => ({ ...l, descricao: "pagamento de outra compra" })), permitidas, "saiu"), null);
  });
  test("respeita o sentido e ignora cancelados e categorias não permitidas", () => {
    assert.equal(M.sugerirCategoria("Venda do dia", hist, M.categoriasPara("entrou", CATS), "entrou").categoriaId, U(1));
    assert.equal(M.sugerirCategoria("Venda do dia", hist, permitidas, "saiu"), null);
    assert.equal(M.sugerirCategoria("Polpa de açaí", hist.map((l) => ({ ...l, status: "cancelado" })), permitidas, "saiu"), null);
  });
});

describe("conta sugerida", () => {
  test("a do lançamento mais recente do mesmo sentido", () => {
    const h = [lanc("a", U(2), { conta_id: U(11), data_movimento: "2026-10-01" }), lanc("b", U(2), { conta_id: U(12), data_movimento: "2026-11-05" })];
    assert.equal(M.sugerirConta(h, CONTAS, "saiu"), U(12));
  });
  test("sem histórico: a única conta ativa; com várias, nenhuma (a pessoa escolhe)", () => {
    assert.equal(M.sugerirConta([], [CONTAS[0], CONTAS[2]], "saiu"), U(11));
    assert.equal(M.sugerirConta([], CONTAS, "saiu"), null);
  });
  test("ignora conta inativa", () => assert.equal(M.sugerirConta([lanc("a", U(2), { conta_id: U(13) })], CONTAS, "saiu"), null));
});

describe("montarPedido", () => {
  const base = { acao: "saiu", quando: "agora", descricao: "Polpa de açaí", valor: "120,50", data: "2026-11-10", contaId: U(11), categoriaId: U(2) };
  const ctx = { contas: CONTAS, categorias: CATS };
  test("saiu, já paguei → POST /lancamentos com os campos mínimos", () => {
    const p = M.montarPedido(base, ctx);
    assert.equal(p.rota, "/lancamentos");
    assert.deepEqual(p.corpo, { contaId: U(11), sentido: "saida", descricao: "Polpa de açaí", valor: "120.50", dataMovimento: "2026-11-10", categoriaId: U(2) });
    assert.match(p.resumo, /Saída de R\$\s120,50 em 10\/11\/2026 · UNICRED · categoria INSUMOS - FRUTAS/);
  });
  test("sem categoria: registra, avisa que fica para classificar e NÃO envia categoria", () => {
    const p = M.montarPedido({ ...base, categoriaId: "" }, ctx);
    assert.equal("categoriaId" in p.corpo, false); assert.match(p.resumo, /sem categoria \(fica para classificar depois\)/); assert.match(p.ondeAparece, /classificação pendente/);
  });
  test("entrou → sentido entrada", () => assert.equal(M.montarPedido({ ...base, acao: "entrou" }, ctx).corpo.sentido, "entrada"));
  test("vou pagar depois → conta a pagar: exige fornecedor e categoria; competência = mês do vencimento", () => {
    const e = M.montarPedido({ ...base, quando: "depois" }, ctx).erros;
    assert.ok(e.fornecedor && !e.categoriaId);
    assert.ok(M.montarPedido({ ...base, quando: "depois", fornecedor: "X", categoriaId: "" }, ctx).erros.categoriaId);
    const p = M.montarPedido({ ...base, quando: "depois", fornecedor: " Distribuidora ", data: "2026-12-05" }, ctx);
    assert.equal(p.rota, "/contas-pagar");
    assert.deepEqual(p.corpo, { categoriaId: U(2), fornecedorNome: "Distribuidora", descricao: "Polpa de açaí", competencia: "2026-12", vencimento: "2026-12-05", valorOriginal: "120.50" });
    assert.match(p.resumo, /vence em 05\/12\/2026\. Entra no resultado de dezembro\/2026/); assert.match(p.ondeAparece, /Ainda não saiu dinheiro/);
    assert.equal(M.montarPedido({ ...base, quando: "depois", fornecedor: "X", competencia: "2026-11" }, ctx).corpo.competencia, "2026-11");
  });
  test("transferência → POST /transferencias; contas diferentes e sem categoria", () => {
    const t = { acao: "transferi", valor: "500", data: "2026-11-10", contaId: U(11), contaDestinoId: U(12), descricao: "" };
    const p = M.montarPedido(t, ctx);
    assert.equal(p.rota, "/transferencias"); assert.deepEqual(p.corpo, { contaOrigemId: U(11), contaDestinoId: U(12), valor: "500.00", data: "2026-11-10" });
    assert.match(p.ondeAparece, /não entra na DRE/);
    assert.ok(M.montarPedido({ ...t, contaDestinoId: U(11) }, ctx).erros.contaDestinoId);
    assert.ok(M.montarPedido({ ...t, contaDestinoId: "" }, ctx).erros.contaDestinoId);
  });
  test("erros em português simples, por campo", () => {
    const e = M.montarPedido({ acao: "saiu", quando: "agora", descricao: "", valor: "0", data: "2026-02-31", contaId: "" }, ctx).erros;
    assert.deepEqual(Object.keys(e).sort(), ["contaId", "data", "descricao", "valor"]);
    assert.match(e.valor, /maior que zero/); assert.match(e.descricao, /poucas palavras/);
  });
});
