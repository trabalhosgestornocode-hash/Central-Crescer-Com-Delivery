// Importador da Central Financeira Unificada — núcleo puro. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planejarImportacaoCentral, chaveObrigacao, chavePagamento, impressaoObrigacao, impressaoPagamento } from "../../src/financeiro-calculos/importacaoCentral.js";

const obr = (id, o = {}) => ({ id, linha: 2, fornecedor: "Fornecedor X", descricao: `Conta ${id}`, categoria: "Insumos A", competencia: "2026-09", vencimento: "2026-09-10",
  valorPrevistoCentavos: 10000, jurosCentavos: 0, multaCentavos: 0, descontoCentavos: 0, valorPagoCentavos: 0, status: "Pago", cancelado: false, tipoRegistro: "Obrigação", ...o });
const pag = (id, obrigacaoId, o = {}) => ({ id, linha: 2, obrigacaoId, data: "2026-09-10", conta: "Banco Central", valorCentavos: 10000, idMovimento: `MOV-${id}`, cancelado: false, tipoRegistro: "Obrigação", situacaoVinculo: "Com extrato", ...o });
const mov = (id, fx) => ({ id, conta: "Banco Central", data: "2026-09-10", entradaCentavos: 0, saidaCentavos: 10000, refFluxo: fx });
const fx = (id, o = {}) => ({ id, conta: "Banco Central", data: "2026-09-10", descricao: "PAGAMENTO FORNECEDOR", entradaCentavos: 0, saidaCentavos: 10000, ...o });
const lanc = (id, o = {}) => ({ id, conta: "BANCO", data: "2026-09-10", sentido: "saida", valorCentavos: 10000, descricao: "PAGAMENTO FORNECEDOR", status: "realizado", transferencia: false, ...o });
const sistemaBase = (o = {}) => ({ contas: [{ id: "c1", nome: "BANCO" }], categorias: [{ id: "k1", nome: "INSUMOS", tipo: "CUSTO" }, { id: "k2", nome: "RECEITA", tipo: "RECEITA" }],
  fornecedores: [], lancamentos: [lanc("L1")], obrigacoes: [], pagamentos: [], vinculos: [], mesesFechados: [], aberturas: [], ...o });
const dePara = { contas: { "Banco Central": "BANCO" }, categorias: { "Insumos A": "INSUMOS" } };
const central = (o = {}) => ({ obrigacoes: [obr("CP-1")], pagamentos: [pag("PG-1", "CP-1")], movimentos: [mov("MOV-PG-1", "FX-1")], fluxo: [fx("FX-1")], saldos: [], ...o });

test("caminho feliz: obrigação nova, pagamento novo e vínculo SUGERIDO (nunca conciliado)", () => {
  const p = planejarImportacaoCentral({ central: central(), sistema: sistemaBase(), dePara });
  assert.equal(p.obrigacoes[0].situacao, "nova"); assert.equal(p.obrigacoes[0].chave, "central:CP:CP-1");
  assert.equal(p.pagamentos[0].situacao, "novo"); assert.equal(p.pagamentos[0].chave, "central:PAG:PG-1");
  assert.deepEqual(p.vinculos.map((v) => [v.lancamentoId, v.status, v.regra]), [["L1", "sugerido", "exato"]]);
  assert.match(p.obrigacoes[0].referencia, /03_BD_OBRIGACOES linha 2 \(ID CP-1\)/);
});

test("reexecução: mesma chave e mesmo conteúdo → existente (nada a gravar); vínculo já existente não é sugerido de novo", () => {
  const p0 = planejarImportacaoCentral({ central: central(), sistema: sistemaBase(), dePara });
  const s = sistemaBase({ fornecedores: [{ id: "f1", nome: "Fornecedor X" }],
    obrigacoes: [{ id: "o1", chave: chaveObrigacao("CP-1"), impressao: impressaoObrigacao(p0.obrigacoes[0]) }],
    pagamentos: [{ id: "p1", chave: chavePagamento("PG-1"), impressao: impressaoPagamento(p0.pagamentos[0]) }],
    vinculos: [{ pagamentoChave: chavePagamento("PG-1"), lancamentoId: "L1" }] });
  const p = planejarImportacaoCentral({ central: central(), sistema: s, dePara });
  assert.equal(p.obrigacoes[0].situacao, "existente"); assert.equal(p.pagamentos[0].situacao, "existente");
  assert.equal(p.vinculos.length, 0); assert.equal(p.novosFornecedores.length, 0); assert.equal(p.resumo.bloqueiaGravacao, false);
});

test("mesma chave com conteúdo DIFERENTE → divergente e a gravação é bloqueada (nunca sobrescreve)", () => {
  const s = sistemaBase({ obrigacoes: [{ id: "o1", chave: chaveObrigacao("CP-1"), impressao: "OUTRO|CONTEUDO" }] });
  const p = planejarImportacaoCentral({ central: central(), sistema: s, dePara });
  assert.equal(p.obrigacoes[0].situacao, "divergente"); assert.equal(p.resumo.bloqueiaGravacao, true);
});

test("de-para nunca é adivinhado: categoria ou conta sem correspondência bloqueia com motivo", () => {
  const p = planejarImportacaoCentral({ central: central({ obrigacoes: [obr("CP-1", { categoria: "Sem par" })] }), sistema: sistemaBase(), dePara });
  assert.equal(p.obrigacoes[0].situacao, "bloqueada"); assert.match(p.obrigacoes[0].motivos[0], /categoria sem de-para/);
  assert.equal(p.pagamentos[0].situacao, "bloqueado");
  const q = planejarImportacaoCentral({ central: central({ pagamentos: [pag("PG-1", "CP-1", { conta: "Conta PF" })] }), sistema: sistemaBase(), dePara });
  assert.match(q.pagamentos[0].motivos.join(), /conta sem de-para/);
});

test("categoria de RECEITA não aceita conta a pagar", () => {
  const p = planejarImportacaoCentral({ central: central(), sistema: sistemaBase(), dePara: { ...dePara, categorias: { "Insumos A": "RECEITA" } } });
  assert.match(p.obrigacoes[0].motivos.join(), /não é de saída/);
});

test("transferência interna, entre empresas e terceiros ficam FORA de contas a pagar (com seus pagamentos)", () => {
  const c = central({ obrigacoes: [obr("CP-1", { tipoRegistro: "Transferência interna" }), obr("CP-2", { tipoRegistro: "Entre empresas" }), obr("CP-3", { tipoRegistro: "Obrigação de terceiros" })] });
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara });
  assert.equal(p.obrigacoes.length, 0); assert.equal(p.excluidas.length, 3); assert.equal(p.pagamentosExcluidos.length, 1);
});

test("perna de transferência interna nunca recebe vínculo de pagamento", () => {
  const p = planejarImportacaoCentral({ central: central(), sistema: sistemaBase({ lancamentos: [lanc("L1", { transferencia: true })] }), dePara });
  assert.equal(p.vinculos.length, 0); assert.match(p.semVinculo[0].motivo, /sem lançamento correspondente/);
});

test("pagamento parcial preservado; pagamentos agrupados numa saída; teto da saída respeitado", () => {
  const c = central({ obrigacoes: [obr("CP-1", { valorPrevistoCentavos: 20000 })], pagamentos: [pag("PG-1", "CP-1", { valorCentavos: 6000, idMovimento: "M1" }), pag("PG-2", "CP-1", { valorCentavos: 4000, idMovimento: "M2" })],
    movimentos: [mov("M1", "FX-1"), mov("M2", "FX-1")] });
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara });
  assert.equal(p.obrigacoes[0].situacaoPagamento, "parcial"); assert.equal(p.obrigacoes[0].saldoCentavos, 10000);
  assert.deepEqual(p.vinculos.map((v) => [v.regra, v.status, v.somaCentavos]), [["agrupado", "sugerido", 10000]]);
  const acima = central({ pagamentos: [pag("PG-1", "CP-1", { valorCentavos: 10002 })] });
  const q = planejarImportacaoCentral({ central: acima, sistema: sistemaBase(), dePara });
  assert.equal(q.vinculos.length, 0); assert.match(q.semVinculo[0].motivo, /excede a saída/);
});

test("pago acima do original: acréscimo PRESUMIDO separado e sem classificação automática", () => {
  const c = central({ pagamentos: [pag("PG-1", "CP-1", { valorCentavos: 10150 })], fluxo: [fx("FX-1", { saidaCentavos: 10150 })], movimentos: [mov("MOV-PG-1", "FX-1")] });
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase({ lancamentos: [lanc("L1", { valorCentavos: 10150 })] }), dePara });
  assert.equal(p.obrigacoes[0].valorCentavos, 10000); assert.equal(p.obrigacoes[0].pagoCentavos, 10150);
  assert.equal(p.obrigacoes[0].diferencaPresumidaCentavos, 150); assert.equal(p.obrigacoes[0].classificacao, undefined);
});

test("soma menor que a saída fora da tolerância → DIVERGENTE (pendência de conciliação preservada)", () => {
  const c = central({ pagamentos: [pag("PG-1", "CP-1", { valorCentavos: 9000 })] });
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara });
  assert.equal(p.vinculos[0].status, "divergente"); assert.equal(p.vinculos[0].diferencaCentavos, 1000);
});

test("pagamento sem extrato fica sem vínculo (pendente), mas é importado", () => {
  const c = central({ pagamentos: [pag("PG-1", "CP-1", { idMovimento: "", situacaoVinculo: "Sem extrato (a conciliar)" })] });
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara });
  assert.equal(p.pagamentos[0].situacao, "novo"); assert.match(p.semVinculo[0].motivo, /a conciliar/);
});

test("mês FECHADO no sistema bloqueia obrigação e pagamento", () => {
  const p = planejarImportacaoCentral({ central: central(), sistema: sistemaBase({ mesesFechados: ["2026-09"] }), dePara });
  assert.equal(p.obrigacoes[0].situacao, "bloqueada"); assert.equal(p.pagamentos[0].situacao, "bloqueado");
});

test("sem fornecedor: bloqueia por padrão; com opção explícita, importa e registra a pendência", () => {
  const c = central({ obrigacoes: [obr("CP-1", { fornecedor: "" })] });
  assert.equal(planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara }).obrigacoes[0].situacao, "bloqueada");
  const p = planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara: { ...dePara, fornecedorAusente: "(Não informado)" } });
  assert.equal(p.obrigacoes[0].situacao, "nova"); assert.equal(p.obrigacoes[0].fornecedor, "(Não informado)"); assert.match(p.obrigacoes[0].pendencias[0], /identificar/);
});

test("saldos de abertura: igual → existente, diferente → divergente (bloqueia), ausente → novo", () => {
  const c = central({ saldos: [{ conta: "Banco Central", data: "2026-09-01", inicialInformadoCentavos: -500, fonte: "x" }] });
  assert.equal(planejarImportacaoCentral({ central: c, sistema: sistemaBase(), dePara }).saldos[0].situacao, "novo");
  assert.equal(planejarImportacaoCentral({ central: c, sistema: sistemaBase({ aberturas: [{ conta: "BANCO", data: "2026-09-01", valorCentavos: -500 }] }), dePara }).saldos[0].situacao, "existente");
  const d = planejarImportacaoCentral({ central: c, sistema: sistemaBase({ aberturas: [{ conta: "BANCO", data: "2026-09-01", valorCentavos: 1 }] }), dePara });
  assert.equal(d.saldos[0].situacao, "divergente"); assert.equal(d.resumo.bloqueiaGravacao, true);
});
