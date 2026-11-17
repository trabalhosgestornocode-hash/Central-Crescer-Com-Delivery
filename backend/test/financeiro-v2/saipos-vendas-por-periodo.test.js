// Fase 03 (doc 41) — leitor do relatório REAL "Vendas por período" da SAIPOS (layout de 26 colunas, doc 39 §2).
// Planilha SINTÉTICA no mesmo layout: nenhum pedido, cliente, endereço ou valor real (o repositório é público).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_B, UNI_B, ctx, montar } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const NOVEMBRO = () => new Date("2026-11-25T15:00:00.000Z");
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro",
  "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador",
  "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
let uuid = 0;
const idParceiro = () => `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, "0")}`;
/** Ficha presencial: canal vazio, tipo F, "Ficha", sem loja nem identificador (como no arquivo real). */
const ficha = (quando, pagamento, itens, { cancelado = "N", desconto = 0 } = {}) => ["Ficha", null, null, "F", "Dia", null, null, null, quando, "Consumidor não identificado", "N", pagamento, cancelado, null,
  itens, null, null, null, null, "", 0, "", desconto, "", Number((itens - desconto).toFixed(2)), 0];
/** Pedido de integração (iFood, Anota.ai, 99 Food): tem o id do pedido no parceiro. */
const integracao = (n, canal, quando, pagamento, itens, entrega, desconto, { cancelado = "N", id = idParceiro() } = {}) => [n, "loja-sintetica", "Loja Sintética", "D", "Dia", canal, id, String(1000 + n), quando,
  "Cliente Sintético", "N", pagamento, cancelado, null, itens, entrega, 0, null, "Bairro Sintético", "00000-000", 0, null, desconto, null, Number((itens + entrega - desconto).toFixed(2)), 0];
const planilha = (linhas) => xlsx([{ nome: "Vendas por período", linhas: [CAB, ...linhas] }]);

const LINHAS = [
  ficha("01/11/2026 12:00", "Débito Master", 20),
  ficha("01/11/2026 12:00", "Débito Master", 20), // idêntica à anterior: são DUAS vendas (nunca se fundem)
  ficha("01/11/2026 12:10", "Crédito Visa", 30),
  ficha("01/11/2026 12:20", "Pago Online via Pix", 100),
  ficha("01/11/2026 12:30", "Dinheiro", 15),
  ficha("01/11/2026 12:40", "Vale", 12),
  ficha("01/11/2026 12:50", "Online iFood", 9), // forma estranha numa ficha → conferência
  ficha("01/11/2026 13:00", "Débito Visa", 50, { cancelado: "S" }),
  integracao(1, "Anota.ai", "01/11/2026 19:00", "Online Anotaai", 40, 5, 0),
  integracao(2, "Anota.ai", "01/11/2026 19:10", "Dinheiro", 30, 0, 0),
  integracao(3, "iFood", "01/11/2026 19:20", "Online iFood, Voucher Parceiro Desconto", 50, 6, 8),
  integracao(4, "99 Food", "01/11/2026 19:30", "Pago Online, Pago Online", 45, 0, 0),
  ficha("02/11/2026 12:00", "Pix na Entrega", 25),
  ficha("02/11/2026 12:10", "Débito Elo, Dinheiro", 18), // múltiplas formas sem valor de cada
];

async function importar(n, linhas, periodo = { periodoInicio: "2026-11-01", periodoFim: "2026-11-02" }, x = c) {
  const r = await n.receberArquivoParaImportacao(x, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: planilha(linhas), ...periodo });
  if (r.repetido) return { importacao: r.importacao, previa: r.previa, repetido: true };
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const conf = await n.confirmarImportacao(x, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) });
  return { importacao: conf.importacao, previa: r.previa };
}
async function cenario({ operadoras = [], tabelas = [] } = {}) {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = (k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  for (const o of operadoras) await W("/configuracoes/operadoras", { nome: o.codigo, modalidades: "DEBITO,CREDITO_A_VISTA,PIX,VOUCHER", justificativa: "Sintético.", ...o });
  for (const t of tabelas) await W("/configuracoes/taxas-contratadas", { fonte: "Contrato sintético", justificativa: "Sintético.", ...t });
  return { n, W, caixa };
}
const gerarEAplicar = async (n, W, imp, caixa) => {
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  return W("/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id });
};
const receita = async (n) => (await n.consultarComposicao(c, { competencia: "2026-11", indicador: "RECEITA_BRUTA" })).totalCentavos;

test("layout real: lê fichas (canal vazio = Presencial), integrações pelo id do parceiro, cancelados e duplicatas exatas", async () => {
  const { n } = await cenario();
  const { previa, importacao } = await importar(n, LINHAS);
  assert.deepEqual(previa.erros, []);
  const regs = await n.listarRegistrosImportados(c, { importacaoId: importacao.id });
  assert.equal(regs.length, LINHAS.length, "as duas fichas idênticas continuam sendo duas");
  const fichas = regs.filter((r) => r.dados.tipoPedido === "F");
  assert.ok(fichas.every((r) => r.dados.canal === "BALCAO" && r.idExterno === null && r.identificacao === "IMPRESSAO_DIGITAL"));
  const ifood = regs.find((r) => r.dados.canalOriginal === "iFood");
  assert.match(ifood.idExterno, /^IFOOD:0{8}-/);
  assert.equal(regs.find((r) => r.dados.canalOriginal === "99 Food").dados.canal, "NOVENTA_E_NOVE_FOOD");
  assert.equal(regs.filter((r) => r.dados.cancelado).length, 1);
  assert.deepEqual(regs.find((r) => r.dados.formaOriginal === "Débito Elo, Dinheiro").dados.pagamentosOriginais, ["Débito Elo", "Dinheiro"]);
});

test("formação: Presencial e Anota Aí viram vendas; iFood e 99Food ficam só para conferência; cancelado não entra", async () => {
  const { n, W, caixa } = await cenario();
  const { importacao } = await importar(n, LINHAS);
  const lote = await gerarEAplicar(n, W, importacao, caixa);
  assert.equal(lote.falhas.length, 0, JSON.stringify(lote.falhas));
  const ps = await n.listarPropostas(c, { importacaoId: importacao.id });
  assert.ok(ps.every((p) => ["BALCAO", "ANOTA_AI"].includes(p.comando.canal)), "nenhuma venda iFood ou 99Food vinda da SAIPOS");
  // Presencial: 20+20+30+100+15+12+9+25+18 = 249; Anota Aí: 45 + 30 = 75 (cancelada fica fora).
  assert.equal(await receita(n), 24900 + 7500);
  const vg = await n.apurarVisaoGeral(c, { competencia: "2026-11" });
  const canal = (k) => vg.faturamentoBruto.porCanal.find((x) => x.canal === k)?.valorCentavos ?? 0;
  assert.deepEqual([canal("BALCAO"), canal("ANOTA_AI"), canal("IFOOD"), canal("NOVENTA_E_NOVE_FOOD")], [24900, 7500, 0, 0]);
});

test("pagamentos: bandeira, maquininha do iFood, Pix na Entrega, múltiplas formas e forma estranha (sem divisão por suposição)", async () => {
  const { n, W, caixa } = await cenario({
    operadoras: [{ codigo: "STONE", processador: "STONE", inicio: "2026-01-01" }, { codigo: "MAQUININHA_IFOOD", processador: "MAQUININHA_IFOOD", inicio: "2026-01-01", modalidades: "PIX" }],
    tabelas: [{ operadora: "STONE", vigenciaInicio: "2026-01-01", taxas: "DEBITO;MASTERCARD;1,00\nCREDITO_A_VISTA;VISA;3,00" }, { operadora: "MAQUININHA_IFOOD", vigenciaInicio: "2026-01-01", taxas: "PIX;PIX;0,80" }],
  });
  const { importacao } = await importar(n, LINHAS);
  await gerarEAplicar(n, W, importacao, caixa);
  const ps = await n.listarPropostas(c, { importacaoId: importacao.id });
  const pag = (desc) => ps.find((p) => p.comando.pagamentos[0]?.descricaoOriginal === desc)?.comando.pagamentos[0];
  assert.deepEqual([pag("Débito Master").processador, pag("Débito Master").bandeira, pag("Débito Master").operadora], ["STONE", "master", "STONE"]);
  assert.deepEqual([pag("Pago Online via Pix").forma, pag("Pago Online via Pix").processador], ["PIX", "MAQUININHA_IFOOD"]);
  assert.equal(pag("Pix na Entrega").processador, "STONE");
  const semPagamento = (desc) => ps.find((p) => p.comando.descricao && p.registroIds && p.comando.pagamentos.length === 0 && p.divergencias.some((d) => d.mensagem.includes(desc)));
  assert.ok(semPagamento("Débito Elo, Dinheiro"), "múltiplas formas: nada dividido");
  assert.ok(semPagamento("Online iFood"), "Online iFood numa ficha: conferência");
  // Líquido esperado (estimativa): Pix da maquininha 0,80% de 100,00 = 0,80; débito Master 1% de 40,00 = 0,40; crédito Visa 3% de 30,00 = 0,90.
  const r = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-02", canal: "BALCAO" });
  const m = (k) => r.modalidades.find((x) => x.modalidade === k);
  assert.deepEqual([m("PIX").bandeiras.find((b) => b.bandeira === "PIX").taxaCentavos, m("DEBITO").taxaCentavos, m("CREDITO_A_VISTA").taxaCentavos], [80, 40, 90]);
  assert.equal(m("PIX").situacao, "PARCIAL", "o Pix na Entrega (Stone, sem taxa Pix na tabela) não herda a taxa da maquininha");
});

test("operadora pela data da venda: Stone até o dia 1, PagBank a partir do dia 2; as duas ativas → conferência", async () => {
  const { n, W, caixa } = await cenario({
    operadoras: [{ codigo: "STONE", processador: "STONE", inicio: "2026-01-01", encerramento: "2026-11-01" }, { codigo: "PAGBANK", processador: "PAGBANK", inicio: "2026-11-02" }],
  });
  const linhas = [ficha("01/11/2026 10:00", "Débito Visa", 10), ficha("02/11/2026 10:00", "Débito Visa", 11)];
  const { importacao } = await importar(n, linhas);
  await gerarEAplicar(n, W, importacao, caixa);
  const ps = await n.listarPropostas(c, { importacaoId: importacao.id });
  assert.deepEqual(ps.map((p) => [p.dataOperacao, p.comando.pagamentos[0].operadora]).sort(), [["2026-11-01", "STONE"], ["2026-11-02", "PAGBANK"]]);
  // Reabrir a Stone (sem encerramento): no dia 2 as duas estão ativas → o pagamento fica a conferir, sem escolha arbitrária.
  await W("/configuracoes/operadoras/situacao", { codigo: "STONE", encerramento: "", justificativa: "Teste de simultâneas." });
  const outra = await importar(n, [ficha("02/11/2026 11:00", "Débito Visa", 12)]);
  await n.gerarPropostas(c, { importacaoId: outra.importacao.id, contaCaixaId: caixa.id });
  const [p] = await n.listarPropostas(c, { importacaoId: outra.importacao.id });
  assert.deepEqual([p.comando.pagamentos.length, p.divergencias.some((d) => d.codigo === "OPERADORA_AMBIGUA")], [0, true]);
});

test("reimportação: o mesmo arquivo é a mesma importação; período sobreposto não duplica vendas", async () => {
  const { n, W, caixa } = await cenario();
  const primeiro = await importar(n, LINHAS);
  await gerarEAplicar(n, W, primeiro.importacao, caixa);
  const antes = await receita(n);
  assert.equal((await importar(n, LINHAS)).repetido, true);
  // Novo arquivo de 02 a 03/11: as fichas do dia 02 já importadas são reconhecidas; só a do dia 03 é nova.
  const dia2 = LINHAS.filter((l) => String(l[8]).startsWith("02/11"));
  const novo = await importar(n, [...dia2, ficha("03/11/2026 12:00", "Dinheiro", 7)], { periodoInicio: "2026-11-02", periodoFim: "2026-11-03" });
  await gerarEAplicar(n, W, novo.importacao, caixa);
  assert.equal(await receita(n), antes + 700);
});

test("isolamento: a importação de uma unidade não aparece em outra empresa", async () => {
  const { n } = await cenario();
  await importar(n, LINHAS);
  const outra = ctx(ORG_B, UNI_B);
  assert.equal((await n.consultarComposicao(outra, { competencia: "2026-11", indicador: "RECEITA_BRUTA" })).totalCentavos, 0);
  assert.equal((await n.listarPropostas(outra, {})).length, 0);
});
