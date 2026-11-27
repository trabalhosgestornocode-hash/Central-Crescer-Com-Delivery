// 26/11 — tela "Contas entre Empresas" e o marcador no calendário (dados SINTÉTICOS; a tela só exibe o que o backend calcula).
// Rodar: node --test frontend/test/financeiroV2EntreEmpresas.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

const ITENS = {
  itens: [
    { id: "a", vinculoId: "v1", papel: "DEVEDORA", devedora: { organizacaoId: "o1", unidadeId: "u1" }, credora: { organizacaoId: "o2", unidadeId: "u2", nome: "Subway Sintética" },
      contraparteNome: "Subway Sintética", descricao: "Distribuidora paga pela Subway", dataPagamento: "2026-11-20", valorCentavos: 649560, reembolsadoCentavos: 100000,
      saldoCentavos: 549560, vencimento: null, situacao: "PARCIAL", liquidacoes: [{ data: "2026-11-25", valorCentavos: 100000, observacao: "Pix parcial" }] },
    { id: "b", vinculoId: "v2", papel: "CREDORA", devedora: { organizacaoId: "o2", unidadeId: "u2", nome: "Subway Sintética" }, credora: { organizacaoId: "o1", unidadeId: "u1" },
      contraparteNome: "Subway Sintética", descricao: "Gás pago pelo Açaí", dataPagamento: "2026-11-21", valorCentavos: 20000, reembolsadoCentavos: 0,
      saldoCentavos: 20000, vencimento: "2026-11-30", situacao: "ABERTO", liquidacoes: [] },
  ],
  totais: { aPagarCentavos: 549560, aReceberCentavos: 20000 },
};

test("EE-1 tela: devedora, credora, saldo, reembolso, vencimento nunca inventado, totais por direção e líquido só INDICATIVO", () => {
  const html = tes.contasEntreEmpresas(ITENS, { unidadeNome: "Açaí Sintético" });
  assert.match(html, /<h1>Contas entre empresas<\/h1>/);
  assert.match(html, /aria-current="page">Entre empresas</, "aba própria ao lado de Lista e Calendário");
  assert.match(html, /Açaí Sintético[\s\S]*Subway Sintética[\s\S]*Distribuidora paga pela Subway/);
  assert.match(html, /R\$ 6\.495,60[\s\S]*R\$ 1\.000,00[\s\S]*R\$ 5\.495,60/, "valor, reembolsado e saldo");
  assert.match(html, /não informado/, "sem vencimento registrado: não inventa data");
  assert.match(html, /2026-11-25|25\/11\/2026/, "histórico do reembolso");
  assert.match(html, /Reembolso parcial/);
  assert.match(html, /A pagar a outras empresas[\s\S]*R\$ 5\.495,60/);
  assert.match(html, /A receber de outras empresas[\s\S]*R\$ 200,00/);
  assert.match(html, /Líquido indicativo[\s\S]*-R\$ 5\.295,60|Líquido indicativo[\s\S]*R\$ -5\.295,60|Líquido indicativo[\s\S]*−R\$ 5\.295,60/);
  assert.match(html, /Não é despesa operacional nem entra nos totais por fornecedor/);
  assert.match(html, /Nada é compensado automaticamente/);
  assert.doesNotMatch(html, /<script/i);
});

test("EE-2 tela vazia e escape de texto livre", () => {
  assert.match(tes.contasEntreEmpresas({ itens: [], totais: { aPagarCentavos: 0, aReceberCentavos: 0 } }), /Nenhuma conta entre empresas registrada/);
  const html = tes.contasEntreEmpresas({ itens: [{ ...ITENS.itens[1], descricao: "<img src=x onerror=alert(1)>" }], totais: ITENS.totais });
  assert.doesNotMatch(html, /<img src=x/);
});

test("EE-3 calendário: marcador próprio 'entre empresas' no dia do vencimento registrado (sem mudar os totais do mês)", async () => {
  const demo = await criarDemo();
  const r = await demo.responder("/api/fv2/calendario", { unidade: UNIDADES[0].id, mes: "2026-11" }, "gestor");
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const cal = r.corpo;
  const dia = cal.dias[3].data;
  const comMarca = { ...cal, dias: cal.dias.map((d) => (d.data === dia ? { ...d, entreEmpresas: { quantidade: 2, saldoCentavos: 30000 } } : d)) };
  const html = tes.calendario(comMarca);
  assert.match(html, /cal-chip--entre" title="2 conta\(s\) entre empresas \(reembolso\)"/);
  assert.match(html, /entre empresas \(reembolso\)<\/li>/, "legenda só aparece quando há marcador");
  assert.doesNotMatch(tes.calendario(cal), /cal-chip--entre/);
  assert.equal(tes.calendario(comMarca).match(/A vencer[\s\S]*?<\/article>/)[0], tes.calendario(cal).match(/A vencer[\s\S]*?<\/article>/)[0], "totais do mês intactos");
});
