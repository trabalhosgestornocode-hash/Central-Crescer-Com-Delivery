// Importação de contas a pagar por planilha — núcleo puro + serviço com repositório em memória. Dados 100% sintéticos.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const req = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"));
const XLSX = req("xlsx");
process.env.SUPABASE_URL ??= "http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste-local"; process.env.SUPABASE_ANON_KEY ??= "teste-local";
const N = await import("../../src/financeiro-calculos/importacaoContasPagar.js");
const S = await import("../../src/modules/gestao-financeira/dominio/importacaoContasPagar.service.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CTX = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
const CONCILIAR = ["gestao_financeira.conciliar", "gestao_financeira.lancar"];
const bruta = (linha, extra = {}) => ({ linha, vencimento: "2026-09-05", previsto: 100, realizado: 100, descricao: "Aluguel – Imobiliária Sol", classificacao: "Despesa", categoria: "Administrativa", natureza: "Fixa",
  formaPagamento: "Unicred MP", dataPagamento: "2026-09-05", origem: "Sistema + extrato", ...extra });

describe("núcleo puro", () => {
  test("só títulos do sistema entram; 'só extrato' fica de fora, contado", () => {
    const r = N.normalizarContasPagar([bruta(5), bruta(6, { origem: "Só extrato (sem título no sistema)", realizado: 50, previsto: 50 }), bruta(7, { origem: "Extrato – títulos do sistema pagos agrupados (MOTOBOYS)" })]);
    assert.equal(r.itens.length, 2); assert.deepEqual(r.fora, { quantidade: 1, valorCentavos: 5000 }); assert.equal(r.erros.length, 0);
  });
  test("fornecedor vem depois do travessão; sem travessão é a descrição", () => {
    assert.equal(N.fornecedorDe("Serviços advocatícios – Glauber Benício"), "Glauber Benício");
    assert.equal(N.fornecedorDe("Anúncios no iFood"), "Anúncios no iFood");
  });
  test("chave é estável e linhas idênticas recebem chaves diferentes", () => {
    const a = N.normalizarContasPagar([bruta(5), bruta(6)]).itens, b = N.normalizarContasPagar([bruta(5), bruta(6)]).itens;
    assert.equal(a[0].chave, b[0].chave); assert.notEqual(a[0].chave, a[1].chave); assert.match(a[0].chave, /^[0-9a-f]{16}$/);
  });
  test("erros por linha, em português: vencimento, valor, pago sem data/conta", () => {
    const r = N.normalizarContasPagar([bruta(5, { vencimento: "xx" }), bruta(6, { previsto: 0 }), bruta(7, { dataPagamento: null }), bruta(8, { formaPagamento: "" })]);
    assert.deepEqual(r.erros.map((e) => e.linha), [5, 6, 7, 8]); assert.match(r.erros[0].motivo, /vencimento inválido/); assert.match(r.erros[2].motivo, /data de pagamento/);
  });
  test("não pago: sem pagamento e sem conta a mapear; datas do Excel (Date e serial) funcionam", () => {
    const r = N.normalizarContasPagar([bruta(5, { realizado: 0, dataPagamento: null, formaPagamento: null, vencimento: new Date("2026-09-10T00:00:00Z") }), bruta(6, { vencimento: 46266 })]);
    assert.equal(r.erros.length, 0); assert.equal(r.itens[0].contaChave, null); assert.equal(r.itens[0].dataPagamento, null); assert.equal(r.itens[0].vencimento, "2026-09-10"); assert.match(r.itens[1].vencimento, /^2026-/);
  });
  const plano = [{ id: "c1", nome: "ADMINISTRATIVA", papel: "despesa_fixa", ativo: true }, { id: "c2", nome: "TARIFAS E JUROS", papel: "despesa_financeira", ativo: true }, { id: "c3", nome: "ENTRE CONTAS", papel: "transferencia", ativo: true }, { id: "c4", nome: "FRETE", papel: "custo_variavel", ativo: false }];
  test("categoria sugerida: nome igual ou apelido; nunca transferência nem inativa", () => {
    assert.equal(N.sugerirCategoriaPlano("DESPESA|ADMINISTRATIVA|FIXA", plano).id, "c1");
    assert.equal(N.sugerirCategoriaPlano("DESPESA|FINANCEIRA|FINANCEIRA", plano).id, "c2");
    assert.equal(N.sugerirCategoriaPlano("CUSTO|FRETE|VARIAVEL", plano), null);
    assert.equal(N.sugerirCategoriaPlano("TRANSFERENCIA|ENTRE CONTAS|", plano), null);
  });
  test("nome repetido em dois papéis: decide pela natureza; sem como decidir, não chuta", () => {
    const dup = [{ id: "f", nome: "COMERCIAL", papel: "despesa_fixa", ativo: true }, { id: "v", nome: "COMERCIAL", papel: "despesa_variavel", ativo: true }];
    assert.equal(N.sugerirCategoriaPlano("DESPESA|COMERCIAL|FIXA", dup).id, "f"); assert.equal(N.sugerirCategoriaPlano("DESPESA|COMERCIAL|VARIAVEL", dup).id, "v");
    assert.equal(N.sugerirCategoriaPlano("DESPESA|COMERCIAL|", dup), null);
  });
  test("conta sugerida pela primeira palavra; ambígua ou ausente → nenhuma", () => {
    const contas = [{ id: "a", nome: "UNICRED MP ALIMENTOS", ativo: true }, { id: "b", nome: "CAIXA DA LOJA", ativo: true }, { id: "d", nome: "STONE X", ativo: true }, { id: "e", nome: "STONE Y", ativo: true }];
    assert.equal(N.sugerirContaFinanceira("UNICRED MP", contas).id, "a"); assert.equal(N.sugerirContaFinanceira("CAIXA (ESPECIE)", contas).id, "b");
    assert.equal(N.sugerirContaFinanceira("STONE MP", contas), null); assert.equal(N.sugerirContaFinanceira("BANCO DO BRASIL", contas), null);
  });
});

function planilha(linhas) {
  const ws = XLSX.utils.aoa_to_sheet([["Legenda qualquer"], [], ["VENCIMENTO", "VALOR PREVISTO", "VALOR REALIZADO", "JUROS / DIFERENÇA", "Descrição", "CLASSIFICAÇÃO", "CATEGORIA", "Natureza", "Conta", "BANCO / FORMA", "DATA PAGAMENTO", "ORIGEM"],
    ...linhas.map((l) => [l.vencimento, l.previsto, l.realizado, 0, l.descricao, l.classificacao, l.categoria, l.natureza, "x", l.formaPagamento, l.dataPagamento, l.origem])]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "FLUXO DE CAIXA 09.2026");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");
}
function repoFalso() {
  const st = { obrigacoes: [], pagamentos: [], fornecedores: [], quitadas: [] };
  const repo = {
    listarPlanoContas: async () => [{ id: U(11), nome: "ADMINISTRATIVA", papel: "despesa_fixa", ativo: true }, { id: U(12), nome: "ENTRE CONTAS", papel: "transferencia", ativo: true }],
    listarContas: async () => [{ id: U(21), nome: "UNICRED MP ALIMENTOS", ativo: true }, { id: U(22), nome: "CAIXA DA LOJA", ativo: true }],
    listarObrigacoes: async () => st.obrigacoes, listarFornecedores: async () => st.fornecedores,
    inserirFornecedor: async (_c, f) => { const n = { id: U(100 + st.fornecedores.length), nome: f.nome }; st.fornecedores.push(n); return n; },
    inserirObrigacao: async (_c, o) => { const n = { id: U(200 + st.obrigacoes.length), ...o }; st.obrigacoes.push(n); return n; },
    inserirPagamento: async (_c, p) => { st.pagamentos.push(p); return p; }, quitarObrigacaoRpc: async (_c, id) => { st.quitadas.push(id); },
  };
  return { st, deps: { repo, db: undefined } };
}
const linhas = [bruta(1), bruta(2, { descricao: "Gás – Distribuidora Azul", vencimento: "2026-09-10", previsto: 250.5, realizado: 250.5, formaPagamento: "Caixa (espécie)", dataPagamento: "2026-09-10" }),
  bruta(3, { descricao: "Internet – Provedor Y", realizado: 0, dataPagamento: null, formaPagamento: null, origem: "Sistema – não pago em setembro" }), bruta(4, { origem: "Só extrato (sem título no sistema)", descricao: "Pix avulso" })];

describe("serviço", () => {
  test("prévia: conta, soma e sugere; NÃO grava nada", async () => {
    const { st, deps } = repoFalso();
    const p = await S.previaImportacao(CTX, { conteudoBase64: planilha(linhas) }, deps);
    assert.equal(p.resumo.novos, 3); assert.equal(p.resumo.pagos, 2); assert.equal(p.resumo.abertos, 1); assert.equal(p.resumo.foraDoEscopo.quantidade, 1);
    assert.equal(p.resumo.valorPrevistoCentavos, 10000 + 25050 + 10000); assert.equal(p.resumo.valorPagoCentavos, 35050);
    assert.equal(p.mapeamento.categorias[0].sugestaoId, U(11)); assert.deepEqual(p.mapeamento.contas.map((g) => g.sugestaoId).sort(), [U(21), U(22)].sort());
    assert.deepEqual([st.obrigacoes.length, st.pagamentos.length, st.fornecedores.length], [0, 0, 0]);
  });
  test("importar sem escolher categoria/conta: recusa e não grava", async () => {
    const { st, deps } = repoFalso();
    await assert.rejects(() => S.importar(CTX, { conteudoBase64: planilha(linhas) }, deps, { permissoes: CONCILIAR }), /Faltam escolhas/);
    assert.equal(st.obrigacoes.length, 0);
  });
  const escolhas = (p) => ({ mapeamentoCategorias: Object.fromEntries(p.mapeamento.categorias.map((g) => [g.chave, g.sugestaoId])), mapeamentoContas: Object.fromEntries(p.mapeamento.contas.map((g) => [g.chave, g.sugestaoId])) });
  test("importar: cria contas, pagamentos na conta certa, quita as pagas por inteiro; idempotente ao reenviar", async () => {
    const { st, deps } = repoFalso();
    const arq = planilha(linhas);
    const p = await S.previaImportacao(CTX, { conteudoBase64: arq }, deps);
    const r = await S.importar(CTX, { conteudoBase64: arq, ...escolhas(p) }, deps, { permissoes: CONCILIAR });
    assert.deepEqual([r.contasCriadas, r.pagamentosRegistrados, r.quitadas, r.falhas.length], [3, 2, 2, 0]);
    assert.equal(st.obrigacoes.length, 3); assert.equal(st.pagamentos.length, 2); assert.equal(st.quitadas.length, 2);
    assert.equal(st.obrigacoes[0].valor_original_centavos, 10000); assert.equal(st.obrigacoes[1].valor_original_centavos, 25050);
    assert.ok(st.obrigacoes.every((o) => /\[imp-cp:[0-9a-f]{16}\]/.test(o.observacoes)));
    assert.deepEqual(st.pagamentos.map((x) => x.conta_id).sort(), [U(21), U(22)].sort());
    assert.deepEqual(st.fornecedores.map((f) => f.nome).sort(), ["Distribuidora Azul", "Imobiliária Sol", "Provedor Y"]);
    const outra = await S.importar(CTX, { conteudoBase64: arq, ...escolhas(p) }, deps, { permissoes: CONCILIAR });
    assert.deepEqual([outra.contasCriadas, outra.jaImportadasIgnoradas], [0, 3]); assert.equal(st.obrigacoes.length, 3);
  });
  test("grupo marcado como 'ignorar' não vira conta a pagar", async () => {
    const { st, deps } = repoFalso();
    const arq = planilha([...linhas.slice(0, 3), bruta(9, { descricao: "Estorno – Cliente", classificacao: "Receita", categoria: "Outras Receitas", natureza: "Outras Receitas" })]);
    const p = await S.previaImportacao(CTX, { conteudoBase64: arq }, deps);
    const e = escolhas(p); e.mapeamentoCategorias[p.mapeamento.categorias.find((g) => g.sugestaoId == null).chave] = S.IGNORAR;
    const r = await S.importar(CTX, { conteudoBase64: arq, ...e }, deps, { permissoes: CONCILIAR });
    assert.deepEqual([r.contasCriadas, r.ignoradasPorEscolha], [3, 1]); assert.equal(st.obrigacoes.length, 3);
  });
  test("sem permissão de conciliar: cria e registra o pagamento, mas NÃO quita", async () => {
    const { st, deps } = repoFalso();
    const arq = planilha(linhas), p = await S.previaImportacao(CTX, { conteudoBase64: arq }, deps);
    const r = await S.importar(CTX, { conteudoBase64: arq, ...escolhas(p) }, deps, { permissoes: ["gestao_financeira.lancar"] });
    assert.deepEqual([r.contasCriadas, r.quitadas], [3, 0]); assert.equal(st.quitadas.length, 0); assert.ok(st.obrigacoes.every((o) => o.provisoria === true));
  });
  test("arquivo com erro: nada é importado", async () => {
    const { st, deps } = repoFalso();
    const arq = planilha([bruta(1, { previsto: 0 })]);
    await assert.rejects(() => S.importar(CTX, { conteudoBase64: arq }, deps, { permissoes: CONCILIAR }), /linha\(s\) com erro/);
    assert.equal(st.obrigacoes.length, 0);
  });
  test("arquivo que não é a planilha esperada: mensagem clara", async () => {
    const ws = XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "X");
    const { deps } = repoFalso();
    await assert.rejects(() => S.previaImportacao(CTX, { conteudoBase64: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64") }, deps), /Não encontrei a aba de contas a pagar/);
  });
});
