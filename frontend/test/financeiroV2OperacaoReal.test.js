// Requisitos da operação real na interface (doc 33): card "Dinheiro em espécie recebido" na Visão Geral e confirmação de
// conciliação conta × saída com "dar baixa". Dados SINTÉTICOS; contrato conferido com as ações do servidor.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";

const saldo = (v) => ({ valorCentavos: v, situacao: "CALCULADO", contas: [] });
const fin = (dinheiro) => ({
  dataBase: "2026-11-16", saldoBancario: saldo(100000), saldoCaixaFisico: saldo(5000),
  contasAPagar: { registros: 0, situacao: "SEM_REGISTROS" }, contasAReceber: { registros: 0, situacao: "SEM_REGISTROS" },
  fluxoDeCaixa: { realizadoNaCompetencia: { movimentacoes: false, ate: "2026-09-30" }, saldoProjetado30DiasCentavos: 0, parcial: false },
  dinheiroEmEspecie: dinheiro,
});

test("Visão Geral: card de dinheiro em espécie separa vendas em dinheiro, entrada no caixa, depósito e sangria", () => {
  const html = tes.cardsFinanceirosDaVisaoGeral(fin({
    situacao: "CALCULADO", vendasEmDinheiroCentavos: 6500, recebidoNoCaixaCentavos: 5500, depositosNoBancoCentavos: 4000, sangriasERetiradasCentavos: 500,
    pagamentosEmEspecieCentavos: 0, suprimentosCentavos: 0, outrasEntradasCentavos: 0, semEntradaNoCaixa: { quantidade: 1, valorCentavos: 1000 }, porDia: [],
  }));
  assert.match(html, /data-financeiro="dinheiro-em-especie"/);
  assert.match(html, /Dinheiro em espécie recebido/);
  for (const t of ["Vendas pagas em dinheiro", "Depositado no banco", "Sangrias e retiradas", "sem entrada no caixa", "não é canal a mais"]) assert.ok(html.includes(t), t);
  assert.match(html, /R\$\s?55,00/);
});

test("Visão Geral: sem registros em dinheiro nunca vira R$ 0,00", () => {
  const html = tes.cardsFinanceirosDaVisaoGeral(fin({ situacao: "SEM_REGISTROS", semEntradaNoCaixa: { quantidade: 0, valorCentavos: 0 }, porDia: [] }));
  assert.match(html, /Sem registros em dinheiro/);
});

test("conciliação conta × saída: confirmar oferece 'dar baixa' (marcado) só com a permissão própria; contrato com o servidor", () => {
  const lado = { total: 1, valorCentavos: 50000, itens: [] };
  const c = { id: "11111111-1111-4111-8111-111111111111", nome: "Conta a pagar × saída", situacao: "CANDIDATA", relacao: "OBRIGACAO_X_MOVIMENTACAO", ladoA: lado, ladoB: lado, criterio: "x", confiabilidadeTexto: "forte", confiabilidade: "FORTE", diferencaCentavos: 0, evidencias: [], podeConfirmar: true, voceTemPermissao: true, competencia: "2026-09" };
  const com = conf.detalheCorrespondencia({ correspondencia: c, historico: [] }, { permissoes: ["financeiro_v2.conciliar", "financeiro_v2.vincular_pagamento"] });
  assert.match(com, /name="baixar" value="1" checked/);
  const sem = conf.detalheCorrespondencia({ correspondencia: c, historico: [] }, { permissoes: ["financeiro_v2.conciliar"] });
  assert.doesNotMatch(sem, /name="baixar"/);
  const outra = conf.detalheCorrespondencia({ correspondencia: { ...c, relacao: "SAIPOS_X_STONE" }, historico: [] }, { permissoes: ["financeiro_v2.conciliar", "financeiro_v2.vincular_pagamento"] });
  assert.doesNotMatch(outra, /name="baixar"/);
  assert.ok(ESCRITAS["/conciliacoes/confirmar"].campos.includes("baixar"));
  assert.ok(ESCRITAS["/conciliacoes/gerar-contas-a-pagar"]);
  assert.ok(ESCRITAS["/obrigacoes/registrar"].campos.includes("identificador"));
});
