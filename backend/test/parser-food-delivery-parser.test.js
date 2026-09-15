import { test } from "node:test";
import assert from "node:assert/strict";
import { lerRelatorio, decodificarArquivo } from "../src/modules/parser-food-delivery/parserFoodDelivery.parser.js";

// Constrói um .xlsx sintético em memória — nunca commitamos o relatório real
// do usuário (tem nome/telefone/endereço de clientes reais).
async function bufferDeMatriz(matriz) {
  const { utils, write } = await import("xlsx");
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(matriz), "Pedidos");
  return write(wb, { type: "buffer", bookType: "xlsx" });
}

const CABECALHO = ["N Pedido", "Data e hora", "Situação", "Entregador", "Taxa do entregador", "Valor total do pedido", "Forma de pagamento", "Razão do cancelamento", "Detalhes do pedido"];

test("lerRelatorio lê pedidos finalizados e cancelados, detecta período", async () => {
  const buf = await bufferDeMatriz([
    CABECALHO,
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", "", "1x Sub Frango 15cm"],
    ["1002", "02/08/2026 11:30:00", "Cancelado", "Bruno", 12, 30, "Dinheiro", "Cliente desistiu", "1x Sub Steak 15cm"],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos.length, 2);
  assert.equal(r.periodoInicio, "2026-08-01");
  assert.equal(r.periodoFim, "2026-08-02");
  assert.equal(r.periodoDetectado, true);
  assert.equal(r.pedidos[0].numeroPedido, "1001");
  assert.equal(r.pedidos[0].situacao, "Finalizado");
  assert.equal(r.pedidos[1].taxaEntregador, 12);
  assert.equal(r.pedidos[1].razaoCancelamento, "Cliente desistiu");
  assert.equal(r.pedidos[0].dadosBrutos["N Pedido"], "1001");
  assert.equal(r.pedidos[0].detalhesPedido, "1x Sub Frango 15cm");
  assert.equal(r.colunaDetalhesEncontrada, true);
});

test("lerRelatorio: sem a coluna 'Detalhes do pedido', colunaDetalhesEncontrada vem false (não trava o arquivo)", async () => {
  const buf = await bufferDeMatriz([
    ["N Pedido", "Data e hora", "Situação", "Entregador", "Taxa do entregador"],
    ["1", "01/08/2026 10:00:00", "Finalizado", "Ana", 10],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.colunaDetalhesEncontrada, false);
  assert.equal(r.pedidos[0].detalhesPedido, null);
});

test("lerRelatorio recusa arquivo sem coluna obrigatória, nomeando qual falta", async () => {
  const buf = await bufferDeMatriz([
    ["N Pedido", "Data e hora", "Entregador", "Taxa do entregador"], // falta "Situação"
    ["1", "01/08/2026 10:00:00", "Ana", 10],
  ]);
  await assert.rejects(() => lerRelatorio(buf, "teste.xlsx"), (err) => {
    assert.match(err.message, /Situação/);
    return true;
  });
});

test("lerRelatorio tolera cabeçalho com acentuação/maiúsculas diferentes", async () => {
  const buf = await bufferDeMatriz([
    ["n pedido", "DATA E HORA", "situação", "ENTREGADOR", "taxa do ENTREGADOR"],
    ["55", "03/08/2026 09:00:00", "Finalizado", "Carla", 8],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos.length, 1);
  assert.equal(r.pedidos[0].entregador, "Carla");
});

test("lerRelatorio reconhece a coluna real 'Prazo de entrega' e normaliza para prazoEntrega", async () => {
  const buf = await bufferDeMatriz([
    [...CABECALHO, "Prazo de entrega"],
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", "", "1x Sub Frango 15cm", "01/08/2026 10:36:19"],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos[0].prazoEntrega, "2026-08-01T10:36:19");
  assert.ok(r.colunasEncontradas.includes("Prazo de entrega"));
});

test("lerRelatorio: prazoEntrega vazio/ausente vem null, nunca zero/data artificial", async () => {
  const buf = await bufferDeMatriz([
    [...CABECALHO, "Prazo de entrega"],
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", "", "1x Sub Frango 15cm", ""],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos[0].prazoEntrega, null);
});

test("lerRelatorio: sem a coluna 'Prazo de entrega' no relatório, prazoEntrega vem null (relatório antigo continua funcionando)", async () => {
  const buf = await bufferDeMatriz([
    CABECALHO,
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", "", "1x Sub Frango 15cm"],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos[0].prazoEntrega, null);
});

test("lerRelatorio: prazoEntrega com texto inválido vem null, nunca lança nem inventa data", async () => {
  const buf = await bufferDeMatriz([
    [...CABECALHO, "Prazo de entrega"],
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", "", "1x Sub Frango 15cm", "não informado"],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos[0].prazoEntrega, null);
});

test("lerRelatorio converte datas seriais nativas do Excel em todos os timestamps", async () => {
  const cabecalho = [
    "N Pedido", "Data e hora", "Situação", "Entregador", "Taxa do entregador",
    "Data e horario (despachado)", "Data e horario (aceito)", "Data e horario (coletado)",
    "Data da chegada para entrega", "Data e horario (cancelado)",
  ];
  const buf = await bufferDeMatriz([
    cabecalho,
    ["0012", 46000.5, "Cancelado", "Ana", 10, 46000.51, 46000.52, 46000.53, 46000.54, 46000.55],
  ]);
  const { pedidos: [pedido] } = await lerRelatorio(buf, "serial.xlsx");
  assert.equal(pedido.dataHora, "2025-12-09T12:00:00");
  assert.equal(pedido.dataDespachado, "2025-12-09T12:14:24");
  assert.equal(pedido.dataAceito, "2025-12-09T12:28:48");
  assert.equal(pedido.dataColetado, "2025-12-09T12:43:12");
  assert.equal(pedido.dataChegadaEntrega, "2025-12-09T12:57:36");
  assert.equal(pedido.dataCancelado, "2025-12-09T13:12:00");
});

test("lerRelatorio ignora linhas totalmente vazias e sem número de pedido", async () => {
  const buf = await bufferDeMatriz([
    CABECALHO,
    ["1001", "01/08/2026 10:00:00", "Finalizado", "Ana", 10, 45.9, "Cartão", ""],
    ["", "", "", "", "", "", "", ""],
    ["", "01/08/2026 12:00:00", "Finalizado", "Bruno", 9, 20, "Cartão", ""],
  ]);
  const r = await lerRelatorio(buf, "teste.xlsx");
  assert.equal(r.pedidos.length, 1);
});

test("decodificarArquivo recusa extensão fora de .xls/.xlsx", () => {
  const b64 = Buffer.from("a").toString("base64");
  assert.throws(() => decodificarArquivo({ nomeArquivo: "relatorio.csv", conteudoBase64: b64 }));
});

test("decodificarArquivo recusa arquivo sem conteúdo", () => {
  assert.throws(() => decodificarArquivo({ nomeArquivo: "relatorio.xlsx" }));
});
