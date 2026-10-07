// Homologação Financial — ajustes para o pacote de evidências (prints):
//   A1  JSON técnico de Sales/Events com merchant mascarado (cópia, original intacto);
//   A2  aviso de dados de exemplo no card da Reconciliation mensal;
//   A3  On Demand histórico (expirada/erro) só exibido — sem GET de status e sem POST;
//   B1/B2 textos de Settlements/Anticipation (estado vazio não é erro).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  itemParaJsonTecnico, derivarHistoricoOnDemand, montarEvidenciaOnDemand, FASE_ON_DEMAND_ROTULO, MENSAGEM_ERRO_OD_SEM_MOTIVO,
} from "../src/ifoodEstado.js";

const SRC = (f) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", f), "utf8");
const IFOOD = SRC("ifood.js").replace(/\r\n/g, "\n");
// Corpo de uma função de topo: da assinatura até o primeiro "}" em coluna 0.
const corpo = (nome) => {
  const i = IFOOD.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `função ${nome} existe`);
  const fim = IFOOD.indexOf("\n}\n", i);
  assert.ok(fim > i, `fim da função ${nome}`);
  return IFOOD.slice(i, fim + 2);
};

const MERCHANT = "55c80000-0000-4000-8000-000000007040";
const MASCARADO = "55c8****7040";

describe("A1 — JSON técnico com merchant mascarado", () => {
  test("venda: merchant.id mascarado, original intacto, valores financeiros preservados", () => {
    const venda = { id: "ped-1", merchant: { id: MERCHANT, shortId: "123", nome: "Loja Teste" }, valorBruto: { total: 52.9 }, resumoFinanceiro: { saldo: 40.1 } };
    const seguro = itemParaJsonTecnico(venda);
    assert.equal(seguro.merchant.id, MASCARADO);
    assert.equal(venda.merchant.id, MERCHANT, "não muta o original");
    assert.equal(seguro.valorBruto.total, 52.9);
    assert.equal(seguro.resumoFinanceiro.saldo, 40.1);
    assert.equal(seguro.merchant.nome, "Loja Teste");
    assert.equal(JSON.stringify(seguro).includes(MERCHANT), false);
  });

  test("evento: comerciante.id mascarado; outra ocorrência do mesmo id também", () => {
    const evento = { nome: "ORDER", valor: -3.5, comerciante: { id: MERCHANT, tipo: "MERCHANT" }, referencia: { tipo: "MERCHANT", id: MERCHANT } };
    const seguro = itemParaJsonTecnico(evento);
    assert.equal(seguro.comerciante.id, MASCARADO);
    assert.equal(seguro.referencia.id, MASCARADO);
    assert.equal(seguro.valor, -3.5);
    assert.equal(JSON.stringify(seguro).includes(MERCHANT), false);
  });

  test("ids que não são do merchant ficam como estão; item sem merchant volta igual", () => {
    const evento = { comerciante: { id: MERCHANT }, referencia: { id: "pedido-abc-123" } };
    assert.equal(itemParaJsonTecnico(evento).referencia.id, "pedido-abc-123");
    assert.deepEqual(itemParaJsonTecnico({ a: 1 }), { a: 1 });
    assert.equal(itemParaJsonTecnico(null), null);
  });

  test("o modal usa a cópia segura no bloco JSON", () => {
    assert.match(corpo("abrirDetalheItem"), /JSON\.stringify\(itemParaJsonTecnico\(itemBruto\), null, 2\)/);
    assert.doesNotMatch(IFOOD, /JSON\.stringify\(itemBruto,/);
  });
});

describe("A2 — Reconciliation mensal identifica a fixture", () => {
  test("aviso só com financialHomologacao === true, dentro do card mensal", () => {
    const f = corpo("avisoAmostraReconciliation");
    assert.match(f, /statusApi\?\.financialHomologacao !== true\) return ""/);
    assert.match(f, /Dados de exemplo do ambiente de homologação do iFood/);
    assert.match(f, /não representam movimentação financeira real/);
    const rec = corpo("conteudoAbaReconciliation");
    assert.ok(rec.indexOf("avisoAmostraReconciliation()") > rec.indexOf("Reconciliation — mês fechado"));
    assert.ok(rec.indexOf("avisoAmostraReconciliation()") < rec.indexOf("Reconciliation On Demand"));
  });
});

describe("A3 — On Demand histórico", () => {
  const hist = (over = {}) => ({
    historico: true, requestId: null, requestIdMascarado: "988e****f836", competencia: "2026-09", status: "error",
    mensagemErro: `File generation failed: No financial entries exist for merchant ${MASCARADO} in the requested time frame.`,
    solicitadoEm: "2026-10-06T12:00:00.000Z", expiraEm: "2026-10-07T12:00:00.000Z", finalizado: true, expirado: true, ...over,
  });

  test("erro histórico: situação 'falhou', status Erro, mensagem oficial mascarada", () => {
    const d = derivarHistoricoOnDemand(hist());
    assert.equal(d.situacao.rotulo, FASE_ON_DEMAND_ROTULO.falhou);
    assert.equal(d.statusRotulo, "Erro");
    assert.match(d.erro, /55c8\*\*\*\*7040/);
    assert.match(d.validade, /Expirada/);
  });

  test("sem motivo gravado -> mensagem padrão; não histórico -> null", () => {
    assert.equal(derivarHistoricoOnDemand(hist({ mensagemErro: null })).erro, MENSAGEM_ERRO_OD_SEM_MOTIVO);
    assert.equal(derivarHistoricoOnDemand({ requestId: "x", historico: false }), null);
    assert.equal(derivarHistoricoOnDemand(null), null);
  });

  test("retomada: histórico só é exibido — nunca vira acompanhamento (GET de status)", () => {
    const f = corpo("retomarReconciliationOnDemand");
    assert.match(f, /api\.ifoodFinancialReconciliationOnDemandAtual\(od\.competencia\)/);
    assert.match(f, /if \(data\?\.historico === true\) \{ od\.historico = data; pintarFinanceiro\(\); return; \}/);
    assert.ok(f.indexOf("data?.historico === true") < f.indexOf("acompanharReconciliationOnDemand("), "histórico decide antes de acompanhar");
    assert.doesNotMatch(f, /OnDemandSolicitar|OnDemandStatus/, "retomada nunca cria solicitação nem consulta status");
  });

  test("bloco histórico: rotulado como evidência, sem botões, requestId só mascarado", () => {
    const f = corpo("blocoHistoricoOnDemand");
    assert.match(f, /Última solicitação registrada/);
    assert.match(f, /Histórico \/ evidência/);
    assert.match(f, /exibida apenas como evidência\/histórico/);
    assert.match(f, /h\.requestIdMascarado/);
    assert.doesNotMatch(f, /<button/);
    assert.doesNotMatch(f, /h\.requestId\b(?!Mascarado)/);
  });

  test("histórico separado da nova solicitação; Solicitar geração não reaproveita o histórico", () => {
    const rec = corpo("conteudoAbaReconciliation");
    assert.ok(rec.indexOf("blocoHistoricoOnDemand(od.historico)") < rec.indexOf("Nova solicitação"));
    assert.ok(rec.indexOf("Nova solicitação") < rec.indexOf('id="ifrec-od-solicitar"'));
    assert.match(corpo("solicitarReconciliationOnDemand"), /od\.historico = null;/);
  });

  test("Solicitar geração só por clique (nenhuma chamada automática de POST)", () => {
    const usos = IFOOD.match(/solicitarReconciliationOnDemand\b/g) ?? [];
    assert.equal(usos.length, 2, "definição + addEventListener do botão");
    assert.match(IFOOD, /el\("#ifrec-od-solicitar"\)\?\.addEventListener\("click", solicitarReconciliationOnDemand\)/);
  });

  test("evidência (aba Evidências) usa o histórico persistido, requestId mascarado", () => {
    const ev = montarEvidenciaOnDemand({ competencia: "2026-09", requestId: null, resultado: null, historico: hist() }, { ambiente: "homologacao" });
    assert.equal(ev.historico, true);
    assert.equal(ev.solicitado, true);
    assert.equal(ev.status, "error");
    assert.equal(ev.requestId, "988e****f836");
    assert.match(ev.erro, /55c8\*\*\*\*7040/);
    assert.equal(JSON.stringify(ev).includes(MERCHANT), false);
  });

  test("solicitação acompanhada na sessão tem prioridade sobre o histórico", () => {
    const ev = montarEvidenciaOnDemand({ competencia: "2026-09", requestId: "aaaa1111-0000-0000-0000-00000000bbbb", resultado: null, historico: hist() }, { ambiente: "homologacao" });
    assert.equal(ev.historico, false);
    assert.equal(ev.requestId, "aaaa****bbbb");
  });
});

describe("B1/B2 — Settlements e Anticipation", () => {
  test("texto desatualizado removido de Settlements", () => {
    assert.doesNotMatch(IFOOD, /incremento futuro \(Conciliação\)/);
    assert.match(corpo("conteudoAbaSettlements"), /a comparação automática fica na aba Conciliação/);
  });

  test("vazio = 'Consulta concluída', em aviso ok (não erro)", () => {
    for (const nome of ["conteudoAbaSettlements", "conteudoAbaAnticipation"]) {
      const f = corpo(nome);
      assert.match(f, /<div class="ifood-aviso ok"[^>]*>Consulta concluída — o iFood não retornou registros para o período\.<\/div>/);
    }
  });
});
