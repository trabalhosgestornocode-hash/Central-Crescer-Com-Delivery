// Relatório de Conciliação Financeira do iFood. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analisarArquivo } from "../../src/modules/financeiro-v2/importacao/motor.js";
import { IFOOD_CONCILIACAO } from "../../src/modules/financeiro-v2/importacao/fontes/ifoodConciliacao.js";

const COLUNAS = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const PERIODO = { inicio: "2026-11-01", fim: "2026-11-30" };
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const D = "dddddddd-0000-4000-8000-000000000004";
const X = "cccccccc-0000-4000-8000-000000000003";

function linha({ fato = "Venda", tipo = "Cobrança", desc, valor, pedido = A, cesta = 50, impacto = "SIM", saldo = "S1", valorSaldo, dia = "2026-11-03", repasse = "2026-12-02", ini = "2026-11-02", fim = "2026-11-08", metodo = "Pix", loja = "LOJA-1" }) {
  const v = { competencia: "2026-11", fato_gerador: fato, tipo_lancamento: tipo, descricao_lancamento: desc, valor, base_calculo: 0, percentual_taxa: 0, pedido_associado_ifood: pedido ?? "", pedido_associado_ifood_curto: pedido ? pedido.slice(0, 4) : "", motivo_cancelamento: "", data_criacao_pedido_associado: pedido ? `${dia}T12:00:00.000Z` : "", data_repasse_esperada: repasse, valor_transacao: valorSaldo, loja_id: loja, cnpj: "00000000000000", data_faturamento: `${dia}T12:30:00.000Z`, data_apuracao_inicio: ini, data_apuracao_fim: fim, valor_cesta_final: cesta, responsavel_transacao: "IFOOD", impacto_no_repasse: impacto, id_saldo: saldo, metodo_pagamento: metodo };
  return COLUNAS.map((c) => v[c]).join(";");
}
const arquivo = (linhas) => new TextEncoder().encode([COLUNAS.join(";"), ...linhas].join("\n"));
const analisar = (linhas, extra = {}) => analisarArquivo({ bytes: arquivo(linhas), adaptador: IFOOD_CONCILIACAO, periodo: PERIODO, estabelecimentosDaUnidade: ["LOJA-1"], ...extra });

// Pedido A: itens 50,00 + entrega 7,00 + taxa do cliente 1,00 − loja 5,00 − iFood 4,00 = cliente pagou 49,00.
const pedidoA = (valorSaldo = 41.5) => [
  linha({ tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 49, valorSaldo }),
  linha({ tipo: "Subsídio", desc: "Promoção custeada pela loja", valor: -5, impacto: "NÃO", valorSaldo }),
  linha({ tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: 2, valorSaldo }),
  linha({ tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: 2, valorSaldo }),
  linha({ tipo: "Retenção", desc: "Taxa de serviço iFood cobrada do cliente", valor: -1, valorSaldo }),
  linha({ desc: "Comissão do iFood (entrega própria da loja)", valor: -8, valorSaldo }),
  linha({ desc: "Taxa de transação", valor: -2.5, valorSaldo }),
];

test("várias linhas viram um pedido: cesta uma vez, entrega derivada e líquido igual ao repasse", () => {
  const a = analisar(pedidoA());
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  const r = a.controles.conciliacaoIfood;
  assert.equal(r.situacoes.VENDA, 1);
  assert.deepEqual([r.total.itensCentavos, r.total.entregaLojaCentavos, r.total.promocaoLojaCentavos, r.total.comissaoCentavos, r.total.transacaoCentavos, r.total.liquidoCentavos], [5000, 700, -500, -800, -250, 4150]);
  assert.equal(r.repassePrevistoCentavos, 4150);
  assert.equal(r.repasses[0].situacao, "PREVISTO");
});

test("linhas idênticas continuam distintas e a reimportação gera as mesmas chaves", () => {
  const a = analisar(pedidoA());
  const b = analisar(pedidoA());
  assert.equal(a.registros.length, 7);
  assert.equal(new Set(a.registros.map((r) => r.chave)).size, 7);
  assert.deepEqual(a.duplicadosNoArquivo, []);
  assert.deepEqual(a.registros.map((r) => r.chave), b.registros.map((r) => r.chave));
});

test("arquivo complementar reconhece o que já veio e só o novo tem chave nova", () => {
  const novo = linha({ pedido: B, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 30, cesta: 30, dia: "2026-11-04", saldo: "S2", valorSaldo: 30 });
  const primeiro = new Set(analisar(pedidoA()).registros.map((r) => r.chave));
  const segundo = analisar([...pedidoA(), novo]).registros.filter((r) => !primeiro.has(r.chave));
  assert.equal(segundo.length, 1);
  assert.equal(segundo[0].dados.pedido, B);
});

test("cancelamento total zera o pedido; cancelamento parcial reduz os itens", () => {
  const total = [
    linha({ pedido: B, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 30, cesta: 30, saldo: "S2", valorSaldo: 0 }),
    linha({ pedido: B, fato: "Cancelamento Total", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: -30, cesta: 30, saldo: "S2", valorSaldo: 0 }),
  ];
  const parcial = [
    linha({ pedido: X, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 40, cesta: 40, saldo: "S3", valorSaldo: 30 }),
    linha({ pedido: X, fato: "Cancelamento Parcial", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: -10, cesta: 40, saldo: "S3", valorSaldo: 30 }),
  ];
  const r = analisar([...total, ...parcial]).controles.conciliacaoIfood;
  assert.deepEqual([r.situacoes.CANCELADO_TOTAL, r.situacoes.CANCELADO_PARCIAL], [1, 1]);
  assert.equal(r.total.itensCentavos, 3000);
  assert.equal(r.total.liquidoCentavos, 3000);
  assert.equal(r.cestaInformadaCentavos, 7000);
});

test("pagamento direto à loja fica fora do repasse e anúncio sem pedido reduz o líquido", () => {
  const r = analisar([
    linha({ pedido: D, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 20, cesta: 20, impacto: "NÃO", metodo: "Dinheiro", saldo: "S4", valorSaldo: -3 }),
    linha({ pedido: D, desc: "Comissão do iFood (entrega própria da loja)", valor: -3, cesta: 20, saldo: "S4", valorSaldo: -3 }),
    linha({ pedido: null, fato: "Ocorrência Avulsa", tipo: "Ocorrência", desc: "ocorrência de débito para contratação do pacote de anúncios por parte do parceiro.", valor: -10, cesta: 0, saldo: "S5", valorSaldo: -10 }),
  ]).controles.conciliacaoIfood;
  assert.deepEqual([r.recebidoDiretoCentavos, r.pedidosRecebidosDireto, r.repassePrevistoCentavos, r.total.anunciosCentavos, r.total.liquidoCentavos], [2000, 1, -1300, -1000, 700]);
});

test("repasses agrupam por ciclo e nunca nascem recebidos", () => {
  const r = analisar([
    ...pedidoA(),
    linha({ pedido: B, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 30, cesta: 30, dia: "2026-11-10", ini: "2026-11-09", fim: "2026-11-15", repasse: "2026-12-09", saldo: "S2", valorSaldo: 30 }),
  ]).controles.conciliacaoIfood;
  assert.deepEqual(r.repasses.map((x) => [x.dataPrevista, x.previstoCentavos, x.situacao]), [["2026-12-02", 4150, "PREVISTO"], ["2026-12-09", 3000, "PREVISTO"]]);
});

test("saldo que não fecha e lançamento desconhecido viram divergência; nada é descartado", () => {
  const a = analisar([...pedidoA(99), linha({ desc: "Lançamento novo", valor: -1, valorSaldo: 99 })]);
  assert.equal(a.registros.length, 8);
  assert.ok(a.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"));
  assert.ok(a.divergencias.some((d) => d.codigo === "VALOR_A_CLASSIFICAR"));
});

test("arquivo de outra loja é recusado e layout antigo não é interpretado", () => {
  const outra = analisar(pedidoA(), { estabelecimentosDaUnidade: ["LOJA-2"] });
  assert.ok(outra.erros.some((e) => e.codigo === "UNIDADE_INCOMPATIVEL"));
  const antigo = analisarArquivo({ bytes: new TextEncoder().encode("Data;Tipo;Valor\n2026-11-03;Venda;10,00"), adaptador: IFOOD_CONCILIACAO, periodo: PERIODO });
  assert.equal(antigo.reconhecido, false);
});
