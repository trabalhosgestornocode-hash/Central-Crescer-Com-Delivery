// Ensaio do PLANO DE CORREÇÃO da importação por forma de pagamento (doc 45 §7): o estado "antes" (uma venda por dia × forma,
// com iFood vindo da SAIPOS e dinheiro no caixa) vira o estado "depois" (vendas por pedido, só Presencial e Anota Aí),
// sem apagar nada, sem somar duas vezes e sem deixar dinheiro órfão. Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const PERIODO = { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const centavos = (t) => (t ? Math.round(Number(t) * 100) : 0);

const FORMAS = [["Online iFood", "100.5", "50"], ["Pago Online via Pix", "30", ""], ["Débito Master", "20", "10"], ["Crédito Visa", "", "40"],
  ["Dinheiro", "15", "5"], ["Vale", "12", ""], ["Online Anotaai", "", "25"], ["Pix na Entrega", "", "7"]];
const planilhaFormas = () => xlsx([{ nome: "Vendas por forma de pagamento", linhas: [
  ["Forma de pagamento", "Valor total dos pagamentos (R$)", "Quantidade de pagamentos", "%", "Dia - 01/09/2026", "Dia - 02/09/2026"],
  ...FORMAS.map(([f, a, b]) => [f, String((centavos(a) + centavos(b)) / 100), "1", "1,00 %", a, b]),
] }]);

const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro",
  "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador",
  "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const ficha = (quando, pagamento, itens) => ["Ficha", null, null, "F", "Dia", null, null, null, quando, "Consumidor não identificado", "N", pagamento, "N", null, itens, null, null, null, null, "", 0, "", 0, "", itens, 0];
let n = 0;
const pedido = (canal, quando, pagamento, itens, entrega) => [(n += 1), "loja-sintetica", "Loja Sintética", "D", "Dia", canal, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, String(1000 + n), quando,
  "Cliente Sintético", "N", pagamento, "N", null, itens, entrega, 0, null, "Bairro Sintético", "00000-000", 0, null, 0, null, itens + entrega, 0];
const planilhaPedidos = () => xlsx([{ nome: "Vendas por período", linhas: [CAB,
  ficha("01/09/2026 12:00", "Dinheiro", 15), ficha("01/09/2026 12:10", "Débito Master", 20), ficha("01/09/2026 12:20", "Pago Online via Pix", 30), ficha("01/09/2026 12:30", "Vale", 12),
  pedido("iFood", "01/09/2026 19:00", "Online iFood", 100.5, 0),
  ficha("02/09/2026 12:00", "Dinheiro", 5), ficha("02/09/2026 12:10", "Débito Master", 10), ficha("02/09/2026 12:20", "Crédito Visa", 40), ficha("02/09/2026 12:30", "Pix na Entrega", 7),
  pedido("Anota.ai", "02/09/2026 19:00", "Online Anotaai", 20, 5),
] }]);
// Esperado pelo relatório por pedido: Presencial 77 + 62 = 139,00; Anota Aí 25,00; iFood 0 (não vem da SAIPOS).
const ESPERADO = { BALCAO: 13900, ANOTA_AI: 2500, IFOOD: 0, NOVENTA_E_NOVE_FOOD: 0 };

async function importar(nucleo, tipoRelatorio, conteudo) {
  const r = await nucleo.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...PERIODO });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  return (await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
}
const aplicarTudo = async (nucleo, imp, caixa) => {
  await nucleo.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  let r;
  do { r = await ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(nucleo, c, { importacao: imp.id }); assert.equal(r.falhas.length, 0, JSON.stringify(r.falhas)); } while ((r.restantes ?? 0) > 0);
};
const porCanal = async (nucleo) => {
  const vg = await nucleo.apurarVisaoGeral(c, { competencia: "2026-09" });
  const x = (k) => vg.faturamentoBruto.porCanal.find((y) => y.canal === k)?.valorCentavos ?? 0;
  return { BALCAO: x("BALCAO"), ANOTA_AI: x("ANOTA_AI"), IFOOD: x("IFOOD"), NOVENTA_E_NOVE_FOOD: x("NOVENTA_E_NOVE_FOOD") };
};
const registros = (nucleo, tipo) => nucleo.consultarRegistros(c, { tipo });

test("correção da importação por forma: estornar o dinheiro, cancelar, reimportar por pedido — sem apagar, sem duplicar, sem dinheiro órfão", async () => {
  const { nucleo } = montar({ relogio: () => new Date("2026-11-17T15:00:00.000Z") });
  const caixa = await nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });

  // ANTES: o que a importação por forma de pagamento deixou.
  await aplicarTudo(nucleo, await importar(nucleo, "SAIPOS_FORMAS_PAGAMENTO", planilhaFormas()), caixa);
  const antes = await porCanal(nucleo);
  assert.ok(antes.IFOOD > 0, "o estado de partida tem iFood vindo da SAIPOS (o problema a corrigir)");
  const vendasAntes = (await registros(nucleo, "VENDA")).filter((v) => v.situacao === "ATIVA");
  const entradasEmDinheiro = (await registros(nucleo, "MOVIMENTACAO")).filter((m) => m.situacao === "VALIDA");
  assert.ok(entradasEmDinheiro.length >= 1, "há dinheiro no caixa ligado às vendas");

  // O por pedido do mesmo período é recusado enquanto as vendas por forma existirem (conflito de granularidade).
  const imp2 = await importar(nucleo, "SAIPOS_VENDAS", planilhaPedidos());
  await nucleo.gerarPropostas(c, { importacaoId: imp2.id, contaCaixaId: caixa.id });
  const bloqueado = await ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(nucleo, c, { importacao: imp2.id });
  assert.equal(bloqueado.aplicadas, 0, "nada entra por cima das vendas por forma");

  // Cancelar uma venda com dinheiro no caixa é RECUSADO até estornar o pagamento (por isso o passo 2 do plano).
  const comDinheiro = vendasAntes.find((v) => v.pagamentos?.some((p) => p.forma === "DINHEIRO"));
  await rejeita(nucleo.cancelarVenda(c, { vendaId: comDinheiro.id, justificativa: "Tentativa sem estornar o dinheiro (sintético)." }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);

  // PASSOS 2 e 3: estornar as entradas em dinheiro (correção de pagamento) e cancelar cada venda por forma.
  for (const v of vendasAntes) {
    for (const p of (await registros(nucleo, "PAGAMENTO_VENDA")).filter((x) => x.vendaId === v.id && x.movimentacaoId && x.situacao === "VALIDO")) {
      await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: p.id, motivo: "CORRECAO_DE_PAGAMENTO", justificativa: "Importação por forma de pagamento substituída pela por pedido (sintético)." });
    }
    await nucleo.cancelarVenda(c, { vendaId: v.id, justificativa: "Importação por forma de pagamento substituída pela por pedido (sintético)." });
  }
  assert.deepEqual(await porCanal(nucleo), { BALCAO: 0, ANOTA_AI: 0, IFOOD: 0, NOVENTA_E_NOVE_FOOD: 0 }, "a receita por forma saiu por inteiro");
  assert.equal((await registros(nucleo, "MOVIMENTACAO")).filter((m) => m.situacao === "VALIDA").length, 0, "nenhuma entrada em dinheiro ficou ativa");
  assert.ok((await registros(nucleo, "RECEBIVEL")).every((r) => r.situacao === "CANCELADA"), "nenhum recebível por forma continua aberto");
  assert.equal((await registros(nucleo, "VENDA")).length, vendasAntes.length, "nada foi apagado: as vendas continuam gravadas, canceladas");

  // PASSO 4: o por pedido entra.
  await aplicarTudo(nucleo, imp2, caixa);
  assert.deepEqual(await porCanal(nucleo), ESPERADO, "depois: só Presencial e Anota Aí, iFood e 99Food fora da SAIPOS");
  const ativas = (await registros(nucleo, "VENDA")).filter((v) => v.situacao === "ATIVA");
  assert.ok(ativas.every((v) => ["BALCAO", "ANOTA_AI"].includes(v.canal)));
  const entradasDepois = (await registros(nucleo, "MOVIMENTACAO")).filter((m) => m.situacao === "VALIDA");
  assert.equal(entradasDepois.reduce((s, m) => s + m.valorCentavos, 0), 2000, "dinheiro no caixa: só os 20,00 em dinheiro do por pedido (15 + 5)");

  // Reaplicar tudo não duplica.
  await aplicarTudo(nucleo, imp2, caixa).catch(() => {});
  assert.deepEqual(await porCanal(nucleo), ESPERADO);
  assert.equal((await registros(nucleo, "VENDA")).filter((v) => v.situacao === "ATIVA").length, ativas.length);
});
