// MOVA — Execução 16C: correções achadas no ENSAIO COM DADOS REAIS (credencial de leitura, sem WhatsApp e sem IA).
//  1) a manchete do faturamento da competência vinha só das vendas venda a venda e OMITIA iFood/99Food (menor que o total da DRE);
//  2) contas a pagar varriam as contas duas vezes (o dobro do tempo).
// Tudo sintético, sem banco e sem rede: a porta financeira é simulada e conta as chamadas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarFerramentas, periodoDaConsulta } from "../../src/modules/mova-financeiro/aplicacao/ferramentas.js";

const ESC = { organizacaoId: "dddddddd-0000-4000-8000-000000000016", unidadeId: "dddddddd-0000-4000-8000-0000000016a1", usuarioId: "00000000-0000-4000-8000-00000000a0a0" };
const HOJE = "2026-11-22";

function portaSimulada({ dre, vendas, calendario, contas = [] } = {}) {
  const chamadas = { apurar: 0, vendas: 0, calendario: [], todas: 0, abertas: 0 };
  return {
    chamadas,
    ehErroDeRegra: () => false,
    async ler(op, _e, entrada) {
      if (op === "apurarCompetencia") { chamadas.apurar += 1; return dre; }
      if (op === "consultarVendas") { chamadas.vendas += 1; return vendas; }
      if (op === "consultarCalendarioDeFaturamento") { chamadas.calendario.push(entrada.canal); return calendario?.[entrada.canal] ?? { dias: [], resumo: {}, granularidadeDiaria: true }; }
      throw new Error(`leitura inesperada: ${op}`);
    },
    async contasAPagarTodas() { chamadas.todas += 1; return contas; },
    async contasAPagarAbertas() { chamadas.abertas += 1; return contas.filter((t) => ["EM_ABERTO", "PARCIALMENTE_PAGO", "VENCIDO"].includes(t.situacao)); },
  };
}
const dreComCanais = (canais, situacao = "PRELIMINAR", valor = null) => ({
  indicadores: { FATURAMENTO_BRUTO_PROPRIO: { situacao, valorCentavos: valor ?? canais.reduce((s, c) => s + c.valorCentavos, 0), porCanal: canais } },
});
const calCom = (ate, extra = {}) => ({ dias: [{ data: ate, estados: ["IMPORTADO"] }], resumo: { semRegistro: 2, comPendencias: 3, comDivergencias: 0, ...extra }, granularidadeDiaria: true });
const nov = () => periodoDaConsulta({ competencia: "2026-11" }, HOJE);

test("16C-01 competência inteira: a MANCHETE vem da DRE e bate com a soma dos canais (o defeito: vendas venda a venda omitiam iFood/99Food)", async () => {
  const porta = portaSimulada({
    dre: dreComCanais([{ canal: "BALCAO", valorCentavos: 123450, comprovado: true }, { canal: "ANOTA_AI", valorCentavos: 10000, comprovado: true }, { canal: "IFOOD", valorCentavos: 80000, comprovado: true }, { canal: "NOVENTA_E_NOVE_FOOD", valorCentavos: 20000, comprovado: true }]),
    vendas: { resumo: { operacoes: 42, brutoProprioCentavos: 133450, recebidoComprovadoCentavos: 0, dre: null } }, // só as vendas venda a venda: o valor ERRADO que a manchete mostrava
    calendario: { BALCAO: calCom("2026-11-16"), ANOTA_AI: calCom("2026-11-16"), IFOOD: calCom("2026-11-17"), NOVENTA_E_NOVE_FOOD: calCom("2026-11-17") },
  });
  const r = await criarFerramentas({ porta, armazenamento: {} }).FATURAMENTO(ESC, { periodo: nov(), hoje: HOJE });
  assert.equal(r.valorCentavos, 233450);
  assert.match(r.linhas[0], /faturamento bruto próprio: R\$\s?2\.334,50 — na DRE: preliminar/);
  assert.ok(!r.linhas.join("\n").includes("1.334,50"), "o valor parcial das vendas não aparece como faturamento");
  const reaisDe = (l) => Number(l.match(/R\$\s?([\d.]+,\d{2})/)[1].replace(/\./g, "").replace(",", "."));
  const canais = r.linhas.slice(1).filter((l) => /^(Balcão|Anota AI|iFood|99Food):/.test(l));
  assert.equal(canais.length, 4);
  assert.equal(Math.round(canais.reduce((s, l) => s + reaisDe(l), 0) * 100), 233450, "a soma dos canais é o total");
  assert.ok(!r.linhas.some((l) => /atenção/.test(l)));
  assert.equal(porta.chamadas.vendas, 0, "não varre as vendas quando a DRE responde (mais rápido)");
  assert.equal(porta.chamadas.apurar, 1);
  assert.deepEqual([...porta.chamadas.calendario].sort(), ["ANOTA_AI", "BALCAO", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.match(r.linhas.find((l) => l.startsWith("iFood")), /dados até 17\/11\/2026, 2 dia\(s\) sem registro, 3 dia\(s\) com pendência/);
});

test("16C-02 soma dos canais diferente do total da DRE ⇒ a resposta avisa (nunca esconde a divergência)", async () => {
  const porta = portaSimulada({ dre: dreComCanais([{ canal: "BALCAO", valorCentavos: 10000, comprovado: true }, { canal: "IFOOD", valorCentavos: 5000, comprovado: true }], "CALCULADO_AGUARDANDO_CONFERENCIA", 20000), calendario: { BALCAO: calCom("2026-11-20"), IFOOD: calCom("2026-11-20") } });
  const r = await criarFerramentas({ porta, armazenamento: {} }).FATURAMENTO(ESC, { periodo: nov(), hoje: HOJE });
  assert.match(r.linhas[0], /R\$\s?200,00 — na DRE: aguardando conferência/);
  assert.ok(r.linhas.some((l) => /atenção: a soma dos canais difere do total da DRE/.test(l)));
});

test("16C-03 DRE sem faturamento apurado ⇒ cai nas vendas venda a venda e DIZ que é só isso; período parcial também diz que é parcial", async () => {
  const vendas = { resumo: { operacoes: 3, brutoProprioCentavos: 50000, recebidoComprovadoCentavos: null, dre: null } };
  const semDre = portaSimulada({ dre: { indicadores: { FATURAMENTO_BRUTO_PROPRIO: { situacao: "BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE", valorCentavos: null, porCanal: [] } } }, vendas });
  const a = await criarFerramentas({ porta: semDre, armazenamento: {} }).FATURAMENTO(ESC, { periodo: nov(), hoje: HOJE });
  assert.match(a.linhas[0], /faturamento bruto próprio: R\$\s?500,00 \(3 registros\)/);
  assert.ok(a.linhas.some((l) => /DRE desta competência ainda não tem faturamento apurado/.test(l)));
  const parcial = portaSimulada({ vendas });
  const p = periodoDaConsulta({ periodoInicio: "2026-11-10", periodoFim: "2026-11-12" }, HOJE);
  const b = await criarFerramentas({ porta: parcial, armazenamento: {} }).FATURAMENTO(ESC, { periodo: p, hoje: HOJE });
  assert.equal(parcial.chamadas.apurar, 0, "período parcial não consulta a DRE");
  assert.ok(b.linhas.some((l) => /valor parcial: só as vendas registradas venda a venda; os relatórios oficiais de iFood e 99Food entram apenas na consulta da competência inteira/.test(l)));
});

test("16C-04 sem vendas e sem DRE ⇒ dados insuficientes (nunca zero nem estimativa)", async () => {
  const porta = portaSimulada({ dre: { indicadores: {} }, vendas: { resumo: { operacoes: 0, brutoProprioCentavos: null } } });
  const r = await criarFerramentas({ porta, armazenamento: {} }).FATURAMENTO(ESC, { periodo: nov(), hoje: HOJE });
  assert.equal(r.dadosInsuficientes, true);
  assert.equal(r.motivo, "SEM_VENDAS_REGISTRADAS");
});

test("16C-05 contas a pagar: UMA varredura (não duas) e o mesmo resultado; vencendo também", async () => {
  const contas = [
    { situacao: "EM_ABERTO", saldoCentavos: 10000, vencido: false, vencimento: "2026-11-25" },
    { situacao: "VENCIDO", saldoCentavos: 20000, vencido: true, vencimento: "2026-11-10" },
    { situacao: "PARCIALMENTE_PAGO", saldoCentavos: 5000, vencido: false, vencimento: "2026-11-27" },
    { situacao: "PAGO", saldoCentavos: 0, vencido: false, vencimento: "2026-11-24" },
    { situacao: "CANCELADO", saldoCentavos: 0, vencido: false, vencimento: "2026-11-24" },
  ];
  const porta = portaSimulada({ contas });
  const f = criarFerramentas({ porta, armazenamento: {} });
  const r = await f.CONTAS_A_PAGAR_ABERTAS(ESC, {});
  assert.match(r.linhas[0], /a pagar em aberto: 3 contas, R\$\s?350,00 \(vencido: R\$\s?200,00\)/);
  assert.equal(porta.chamadas.todas, 1); assert.equal(porta.chamadas.abertas, 0);
  const v = await f.CONTAS_VENCENDO(ESC, { periodo: { explicito: false }, hoje: HOJE });
  assert.match(v.linhas[0], /vencendo de 22\/11\/2026 a 29\/11\/2026: 2 contas, R\$\s?150,00/);
  assert.equal(porta.chamadas.todas, 2); assert.equal(porta.chamadas.abertas, 0);
  const vazio = await criarFerramentas({ porta: portaSimulada({ contas: [] }), armazenamento: {} }).CONTAS_A_PAGAR_ABERTAS(ESC, {});
  assert.equal(vazio.dadosInsuficientes, true);
});
