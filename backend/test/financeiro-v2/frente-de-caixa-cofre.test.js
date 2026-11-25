// Frente de caixa → cofre (25/11/2026): fundo fixo POR UNIDADE (configuração, nada no código), saldo esperado × contado, sobra/falta
// e o dinheiro para o cofre em três valores separados (esperado, pela contagem, recebido). Referência real: fechamento SAIPOS
// 15991061 de 01/11/2026 (fundo 106,00; dinheiro 183,19; sem retiradas; contado 289,50). Demais dados SINTÉTICOS. Roda em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { destinoAoCofre, dinheiroDoDia, fundoFixoDe, resumirMovimentosDoDia } from "../../src/modules/financeiro-v2/aplicacao/movimentosDeCaixa.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";
import { ORG_A, UNI_A, UNI_A2, ctx, montar } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const FUNDO = 10600;
const fechamento = (dinheiro) => [{ dados: { dinheiro } }];

test("FC-1 fechamento SAIPOS de 01/11/2026: esperado 289,19; contado 289,50; sobra 0,31; cofre esperado 183,19 e pela contagem 183,50, sem entrega confirmada", () => {
  const d = dinheiroDoDia({ resumo: null, fechamentos: fechamento({ informadoCentavos: 28950 }), vendasEmDinheiroCentavos: 18319, fundoFixoCentavos: FUNDO });
  assert.deepEqual([d.aberturaCentavos, d.origemDaAbertura, d.aberturaInformada], [FUNDO, "FUNDO_FIXO_CONFIGURADO", false], "sem abertura no dia, o fundo é a abertura PRESUMIDA");
  assert.deepEqual([d.retiradasCentavos, d.reforcosCentavos, d.transferenciasCentavos], [0, 0, 0]);
  assert.deepEqual([d.esperadoCentavos, d.informadoCentavos, d.diferencaCentavos, d.situacao], [28919, 28950, 31, "SOBRA"]);
  assert.deepEqual(d.cofre, { situacao: "PREVISTO_PELA_CONTAGEM", esperadoCentavos: 18319, pelaContagemCentavos: 18350, recomposicaoCentavos: 0, recebidoCentavos: null, confirmado: false });
});

test("FC-2 sem contagem física: só ESTIMATIVA (nunca entrega); contado abaixo do fundo: RECOMPOSIÇÃO, não transferência negativa", () => {
  const sem = dinheiroDoDia({ resumo: null, fechamentos: [], vendasEmDinheiroCentavos: 18319, fundoFixoCentavos: FUNDO });
  assert.deepEqual([sem.informadoCentavos, sem.situacao, sem.cofre.situacao, sem.cofre.esperadoCentavos, sem.cofre.pelaContagemCentavos], [null, "SEM_VALOR_INFORMADO", "ESTIMATIVA_SEM_CONTAGEM", 18319, null]);
  const falta = destinoAoCofre({ esperadoCentavos: 12000, informadoCentavos: 9000, fundoFixoCentavos: FUNDO });
  assert.deepEqual([falta.situacao, falta.pelaContagemCentavos, falta.recomposicaoCentavos, falta.confirmado], ["RECOMPOR_FUNDO", 0, 1600, false]);
  const d = dinheiroDoDia({ resumo: null, fechamentos: fechamento({ informadoCentavos: 9000 }), vendasEmDinheiroCentavos: 1400, fundoFixoCentavos: FUNDO });
  assert.deepEqual([d.esperadoCentavos, d.diferencaCentavos, d.situacao, d.cofre.situacao], [12000, -3000, "FALTA", "RECOMPOR_FUNDO"]);
});

test("FC-3 fundo: configurável e validado; sem configuração NÃO há valor presumido; abertura informada no dia prevalece", () => {
  assert.equal(fundoFixoDe({ fundoFixoCaixaCentavos: 10600 }), 10600);
  for (const v of [undefined, null, -1, 10.5, "10600", 10_000_001]) assert.equal(fundoFixoDe({ fundoFixoCaixaCentavos: v }), null, String(v));
  const semFundo = dinheiroDoDia({ resumo: null, fechamentos: fechamento({ informadoCentavos: 28950 }), vendasEmDinheiroCentavos: 18319 });
  assert.deepEqual([semFundo.aberturaCentavos, semFundo.origemDaAbertura, semFundo.cofre.situacao], [null, null, "SEM_FUNDO_FIXO_CONFIGURADO"], "comportamento anterior preservado");
  const informada = dinheiroDoDia({ resumo: null, fechamentos: fechamento({ aberturaCentavos: 8000, informadoCentavos: 26319 }), vendasEmDinheiroCentavos: 18319, fundoFixoCentavos: FUNDO });
  assert.deepEqual([informada.aberturaCentavos, informada.origemDaAbertura, informada.esperadoCentavos, informada.situacao], [8000, "INFORMADA", 26319, "CONFERE"]);
});

test("FC-4 sangria importada entra UMA vez no esperado (importado e manual iguais = mesmo dinheiro) e reforço soma", () => {
  const mov = (natureza, valor) => ({ dataReferencia: "2026-11-19", linha: 1, valorCentavos: valor, dados: { natureza, considerar: true, pago: true, valorAbsolutoCentavos: valor } });
  const movimentos = [mov("SANGRIA", 15000), mov("SANGRIA", 1500), mov("REFORCO", 2000)];
  const fech = fechamento({ retiradasCentavos: 16500, informadoCentavos: 21000 });
  const resumo = resumirMovimentosDoDia({ data: "2026-11-19", movimentos, fechamentos: fech, vendasEmDinheiroCentavos: 30000 });
  const d = dinheiroDoDia({ resumo, fechamentos: fech, vendasEmDinheiroCentavos: 30000, fundoFixoCentavos: FUNDO });
  assert.equal(d.origem.retiradas, "IMPORTADO_E_MANUAL_IGUAIS");
  assert.deepEqual([d.retiradasCentavos, d.reforcosCentavos, d.esperadoCentavos], [16500, 2000, FUNDO + 30000 + 2000 - 16500]);
  assert.equal(d.cofre.pelaContagemCentavos, 21000 - FUNDO);
});

// ------------------------------------------------------------------ núcleo: configuração por unidade e isolamento
const HOJE = () => new Date("2026-11-25T15:00:00.000Z");
const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const planilha = (linhas) => Buffer.from(xlsx([{ nome: "Financeiro 01Nov-30Nov", linhas: [CAB, ...linhas] }])).toString("base64");
const retirada = (dia, valor) => [`${dia}/11/2026`, `${dia}/11/2026`, `${dia}/11/2026`, "Cofre", null, "Frente de Caixa", valor, "Sim", null, "Retirada de Frente de Caixa"];

test("FC-5 núcleo: fundo por unidade (omitido mantém), inválido recusado, importação repetida não duplica e a outra unidade não enxerga o fundo nem as retiradas", async () => {
  const { nucleo: n } = montar({ relogio: HOJE });
  const a = ctx(); const a2 = ctx(ORG_A, UNI_A2);
  const W = (k, b, x = a) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Loja A", fundoFixoCaixa: "106,00", justificativa: "Fundo informado pela gerência." });
  await W("/configuracoes/unidade", { nomeExibicao: "Loja A (renomeada)", justificativa: "Só o nome." });
  await assert.rejects(W("/configuracoes/unidade", { nomeExibicao: "Loja A", fundoFixoCaixa: "-5", justificativa: "x" }), /Fundo fixo/);
  await W("/configuracoes/unidade", { nomeExibicao: "Loja A2", justificativa: "Sem fundo." }, a2);
  const subir = async () => {
    const r = await W("/importacao/receber", { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-24", arquivoBase64: planilha([retirada("19", 150), retirada("19", 15)]), nomeArquivo: "retiradas.xlsx" });
    return r.importacao;
  };
  const imp = await subir();
  await n.confirmarImportacao(a, { importacaoId: imp.id, impressaoPrevia: imp.impressaoPrevia, aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas." });
  await subir().then((i) => n.confirmarImportacao(a, { importacaoId: i.id, impressaoPrevia: i.impressaoPrevia, aceitarPendencias: true, justificativa: "Mesmo arquivo de novo." })).catch(() => null);
  const mov = await CONSULTAS["/movimentos-caixa"](n, a, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.equal(mov.fundoFixoCentavos, FUNDO, "o fundo continua depois de salvar sem ele");
  assert.equal(mov.totais.retiradas.totalCentavos, 16500, "reimportar o mesmo arquivo não duplica as retiradas");
  const d19 = mov.dinheiroPorDia.find((d) => d.data === "2026-11-19");
  assert.deepEqual([d19.aberturaCentavos, d19.origemDaAbertura, d19.retiradasCentavos, d19.esperadoCentavos, d19.informadoCentavos, d19.cofre.situacao, d19.cofre.recomposicaoCentavos], [FUNDO, "FUNDO_FIXO_CONFIGURADO", 16500, FUNDO - 16500, null, "RECOMPOR_FUNDO_ESTIMADO", 16500], "saldo esperado −59: repor R$ 165 para o caixa voltar ao fundo; nunca cofre negativo");
  const outra = await CONSULTAS["/movimentos-caixa"](n, a2, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.deepEqual([outra.fundoFixoCentavos, outra.totais.retiradas.totalCentavos, outra.dinheiroPorDia.length], [null, 0, 0], "isolamento entre unidades");
});

test("FC-6 MOVA (movimentos_do_caixa_fisico): valores do Financeiro como fatos; contado desconhecido fica null e nunca vira fato", async () => {
  const f = CATALOGO.movimentos_do_caixa_fisico;
  const dia = dinheiroDoDia({ resumo: null, fechamentos: fechamento({ informadoCentavos: 28950 }), vendasEmDinheiroCentavos: 18319, fundoFixoCentavos: FUNDO });
  const semContagem = dinheiroDoDia({ resumo: null, fechamentos: [], vendasEmDinheiroCentavos: 37688, fundoFixoCentavos: FUNDO });
  const porta = { ler: async () => ({ totais: { retiradas: { quantidade: 0, totalCentavos: 0 } }, dias: [], dinheiroPorDia: [{ data: "2026-11-01", ...dia }, { data: "2026-11-02", ...semContagem }] }) };
  const r = await f.executar({ porta, escopo: {}, args: { inicio: "2026-11-01", fim: "2026-11-02" } });
  const de = (sig, periodo) => r.fatos.filter((x) => x.significado === sig && x.periodo === periodo).map((x) => x.valorCentavos);
  assert.deepEqual(de("VENDAS:dinheiro", "2026-11-01"), [18319], "faturamento em dinheiro");
  assert.deepEqual(de("SALDO_CONTADO_DO_CAIXA", "2026-11-01"), [28950]);
  assert.deepEqual(de("SALDO_ESPERADO_DO_CAIXA", "2026-11-01"), [28919]);
  assert.deepEqual(de("DIFERENCA_DE_SALDO", "2026-11-01"), [31]);
  assert.deepEqual(de("MOVIMENTO_DE_CAIXA:cofre_pelaContagemCentavos", "2026-11-01"), [18350]);
  assert.deepEqual(de("SALDO_CONTADO_DO_CAIXA", "2026-11-02"), [], "sem contagem: nenhum fato de saldo contado");
  const d2 = r.dados.dinheiroPorDia.find((x) => x.data === "2026-11-02");
  assert.deepEqual([d2.contadoCentavos, d2.cofre.confirmado, d2.cofre.recebidoCentavos], [null, false, null]);
  assert.match(r.dados.nota, /NÃO informado/);
});
