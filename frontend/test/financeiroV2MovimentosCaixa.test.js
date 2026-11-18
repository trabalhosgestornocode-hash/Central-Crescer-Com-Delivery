// Retiradas e reforços de caixa da SAIPOS na interface: prévia da importação (conferência das classificações), dia do calendário SAIPOS
// e conferência do dinheiro no fechamento manual. Só apresentação: tudo vem pronto do servidor. Usa o PAYLOAD REAL do backend em memória
// com dados SINTÉTICOS (mesma forma do export "Financeiro"; valores inventados).
// Rodar: node --test frontend/test/financeiroV2MovimentosCaixa.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as conf from "../financeiro-v2/telasConferencias.js";
import * as cal from "../financeiro-v2/telasCalendarioCanais.js";
import * as can from "../financeiro-v2/telasCanais.js";
import { conferenciaDoDinheiro, movimentosDoDia, previaDeMovimentos } from "../financeiro-v2/telasMovimentosCaixa.js";
import { CONSULTAS } from "../../backend/src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";
import { ctx as ctxBackend, montar } from "../../backend/test/financeiro-v2/helpers/cenario.js";
import { xlsx } from "../../backend/test/financeiro-v2/helpers/formatos.js";
import { auditarHtml } from "./acessibilidade/auditoria.js";

const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const linha = (dia, valor, descricao = "Retirada de Frente de Caixa") => { const d = `${dia}/11/2026`; return [d, d, d, "Cofre", null, "Frente de Caixa", valor, "Sim", null, descricao]; };
const aBase64 = (linhas) => Buffer.from(xlsx([{ nome: "Financeiro", linhas: [CAB, ...linhas] }])).toString("base64");
const PERMISSOES = ["financeiro_v2.ver", "financeiro_v2.importar", "financeiro_v2.registrar"];

async function cenario() {
  const c = ctxBackend();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const r = await ESCRITAS["/importacao/receber"].fazer(n, c, { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", nomeArquivo: "financeiro.xlsx",
    arquivoBase64: aBase64([linha("08", 100), linha("08", 40), linha("08", -30, "Reforço de Frente de Caixa"), linha("08", -5, "Algo sem classificação"), linha("12", 25)]) });
  return { c, n, importacao: r.importacao };
}

test("prévia: totais por tipo e conferência das classificações linha a linha, com o caixa pendente e o desconhecido fora dos totais", async () => {
  const { c, n, importacao } = await cenario();
  const html = conf.detalheDocumento(await CONSULTAS["/conferencias/documento"](n, c, { id: importacao.id }), { permissoes: PERMISSOES });
  assert.match(html, /Movimentações de Frente de Caixa/);
  assert.match(html, /Importar não lança nada: a retirada só vira despesa quando você a lança/);
  assert.match(html, /Retiradas \(sangrias\)/);
  assert.match(html, /Conferir as classificações/);
  assert.match(html, /Retirada \(sangria\)/);
  assert.match(html, /Reforço/);
  assert.match(html, /Sem classificação/);
  assert.match(html, /fica fora dos totais/, "o desconhecido não entra nos totais");
  assert.match(html, /<span class="nota">pendente<\/span>/, "o caixa de cada linha fica pendente");
  assert.match(html, /Confirmar importação/);
  assert.deepEqual(auditarHtml(html), []);
  assert.equal(previaDeMovimentos({ porCanal: {} }), "", "sem movimentos na prévia: nada é desenhado");
});

test("calendário SAIPOS: o dia abre retiradas, total, reforços, pendência de caixa, avisos e a lista que compõe o total", async () => {
  const { c, n, importacao } = await cenario();
  await n.confirmarImportacao(c, { importacaoId: importacao.id, impressaoPrevia: importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético." });
  const calendario = await CONSULTAS["/calendario-faturamento"](n, c, { canal: "BALCAO", mes: "2026-11" });
  const dia = calendario.dias.find((d) => d.data === "2026-11-08");
  const html = cal.diaDoCanal(dia, calendario);
  assert.match(html, /Retiradas e reforços de caixa/);
  assert.match(html, /Retiradas \(sangrias\)<\/dt><dd>2 · <span class="valor">R\$\s?140,00/);
  assert.match(html, /Reforços<\/dt><dd>1 · <span class="valor">R\$\s?30,00/);
  assert.match(html, /Caixa não identificado<\/dt><dd>3 movimentação/);
  assert.match(html, /não informa o caixa/);
  assert.match(html, /sem classificação segura/);
  assert.match(html, /Ver as 4 movimentação\(ões\) deste dia/);
  assert.match(html, /Retirada de Frente de Caixa/, "a descrição original aparece na lista");
  assert.deepEqual(auditarHtml(html), []);
  const semMovimento = cal.diaDoCanal(calendario.dias.find((d) => d.data === "2026-11-03"), calendario);
  assert.doesNotMatch(semMovimento, /Retiradas e reforços de caixa/, "ausência não vira zero");
  assert.equal(movimentosDoDia(null), "");
});

test("fechamento manual: mostra o dinheiro do dia (abertura, vendas, sangrias, reforços, esperado, informado, diferença) e a duplicidade possível", async () => {
  const { c, n, importacao } = await cenario();
  await n.confirmarImportacao(c, { importacaoId: importacao.id, impressaoPrevia: importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético." });
  await n.registrarFechamentoManual(c, { data: "2026-11-08", caixa: "Caixa 1", dinheiro: { aberturaCentavos: 5000, vendasCentavos: 30000, retiradasCentavos: 14000, informadoCentavos: 21000 }, formas: [] });
  const d = await CONSULTAS["/fechamento-manual"](n, c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  const html = can.fechamentoManual(d, { permissoes: PERMISSOES });
  assert.match(html, /Conferência do dinheiro/);
  for (const rotulo of ["Abertura", "Vendas em dinheiro", "Sangrias", "Reforços", "Transferências", "Dinheiro esperado", "Dinheiro informado", "Diferença"]) assert.ok(html.includes(`<dt>${rotulo}</dt>`), rotulo);
  assert.match(html, /relatório e fechamento iguais \(contado uma vez\)/);
  assert.match(html, /possível duplicidade/);
  assert.match(html, /uma vez só/);
  assert.match(html, /Dia 08\/11\/2026|08\/11\/2026/);
  assert.deepEqual(auditarHtml(html), []);
  // Dia com valores diferentes: não calcula, manda revisar.
  const dia = d.dias.find((x) => x.data === "2026-11-08");
  const conflito = conferenciaDoDinheiro({ ...dia.dinheiroDoDia, esperadoCentavos: null, diferencaCentavos: null, situacao: "REVISAR_MOVIMENTOS", origem: { ...dia.dinheiroDoDia.origem, retiradas: "CONFLITO" } });
  assert.match(conflito, /Revisar movimentações antes de conferir/);
  assert.match(conflito, /valores diferentes: revisar/);
  assert.equal(conferenciaDoDinheiro(null), "");
});

test("textos escapados: descrição vinda do arquivo nunca vira HTML", () => {
  const html = movimentosDoDia({ data: "2026-11-08", retiradas: { quantidade: 1, totalCentavos: 100 }, reforcos: { quantidade: 0, totalCentavos: 0 }, transferencias: { quantidade: 0, totalCentavos: 0 }, desconhecidas: { quantidade: 0, totalCentavos: 0 },
    pendenciasDeCaixa: { quantidade: 1, mensagem: null }, conferenciaComFechamento: {}, alertas: [], divergencias: [],
    itens: [{ id: "x", linha: 2, data: "2026-11-08", natureza: "SANGRIA", valorCentavos: 100, descricao: "<img src=x onerror=alert(1)>", conta: "Cofre", categoria: "Frente de Caixa", considerar: true, pago: true, motivo: "", caixa: null, vinculoComCaixa: "PENDENTE" }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("dica de onde achar o relatório na SAIPOS aparece só no formato das movimentações de caixa, em uma linha", async () => {
  const c = ctxBackend();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const imp = await import("../financeiro-v2/telasImportacoesCanais.js");
  const html = imp.importacoesDoCanal(await CONSULTAS["/importacoes-canal"](n, c, { canal: "SAIPOS" }));
  assert.match(html, /Na SAIPOS: Lançamentos financeiros, categoria Frente de Caixa, descrição Retirada/);
  assert.equal((html.match(/imp-dica/g) ?? []).length, 1, "só um formato tem dica");
  assert.deepEqual(auditarHtml(html), []);
});

test("transferência aparece 'a confirmar, fora da conta' e a divergência de versão corrigida é legível na prévia", () => {
  const zero = { quantidade: 0, totalCentavos: 0 };
  const html = movimentosDoDia({ data: "2026-11-16", retiradas: zero, reforcos: zero, transferencias: zero, transferenciasAConfirmar: { quantidade: 1, totalCentavos: 5000 }, desconhecidas: zero, pendenciasDeCaixa: { quantidade: 0, mensagem: null },
    conferenciaComFechamento: {}, alertas: [], divergencias: [{ codigo: "TRANSFERENCIA_A_CONFIRMAR", mensagem: "1 transferência(s) a confirmar: ficam fora do dinheiro esperado." }], itens: [] });
  assert.match(html, /Transferências a confirmar \(fora da conta\)<\/dt><dd>1 · <span class="valor">R\$\s?50,00/);
  assert.match(html, /ficam fora do dinheiro esperado/);
  const previa = previaDeMovimentos({ sangrias: 0, sangriasCentavos: 0, reforcos: 0, reforcosCentavos: 0, desconhecidas: 0, naoPagas: 0, transferenciasAConfirmar: 2, diasComMovimento: 1, movimentos: [] });
  assert.match(previa, /Transferências a confirmar \(fora do dinheiro esperado\)/);
});

test("importação confirmada: bloco para lançar as retiradas como despesa paga — novas × já lançadas à mão, botão e confirmação; sem nada novo ou sem permissão, só explica", async () => {
  const c = ctxBackend();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const sangrias = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "SANGRIAS" });
  const o = (await n.registrarObrigacao(c, { contraparteId: sangrias.id, valorOriginalCentavos: 10000, categoria: "OUTRAS_DESPESAS", descricao: "compra de espátula", competencia: "2026-11", dataEmissao: "2026-11-08", vencimento: "2026-11-08" })).obrigacoes[0];
  await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: caixa.id, dataEfetiva: "2026-11-08", valorCentavos: 10000 });
  // Diária lançada em OUTRO fornecedor e OUTRA categoria, somando duas retiradas do dia 12 (25 + 26 = 51,00).
  const maria = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Maria" });
  const diaria = (await n.registrarObrigacao(c, { contraparteId: maria.id, valorOriginalCentavos: 5100, categoria: "SALARIOS_E_ENCARGOS", descricao: "Diária evento", competencia: "2026-11", dataEmissao: "2026-11-12", vencimento: "2026-11-12" })).obrigacoes[0];
  await n.pagarContaAPagar(c, { obrigacaoId: diaria.id, contaId: caixa.id, dataEfetiva: "2026-11-12", valorCentavos: 5100 });
  const r = await ESCRITAS["/importacao/receber"].fazer(n, c, { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", nomeArquivo: "financeiro.xlsx",
    arquivoBase64: aBase64([linha("08", 100), linha("08", 40), linha("12", 25), linha("12", 26)]) });
  // Antes de confirmar a importação não há o que lançar.
  assert.doesNotMatch(conf.detalheDocumento(await CONSULTAS["/conferencias/documento"](n, c, { id: r.importacao.id }), { permissoes: PERMISSOES }), /Lançar as retiradas como despesas/);
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético." });
  const d = await CONSULTAS["/conferencias/documento"](n, c, { id: r.importacao.id });
  const html = conf.detalheDocumento(d, { permissoes: PERMISSOES });
  assert.match(html, /Lançar as retiradas como despesas pagas em dinheiro/);
  assert.match(html, /Novas \(serão lançadas\)<\/span><span>1 · R\$\s?40,00/);
  assert.match(html, /Já lançadas à mão \(não serão repetidas\)<\/span><span>3 · R\$\s?151,00/);
  assert.match(html, /Já lançada \(somada em uma conta\)/);
  assert.match(html, /<strong>Maria<\/strong> · Diária evento · <span class="nota">Salários e encargos<\/span>/, "mostra fornecedor, descrição e a CATEGORIA da conta já lançada");
  assert.match(html, /conta de R\$\s?51,00 cobre 2 retiradas/);
  assert.match(html, /compra de espátula/, "mostra a conta que já existia, para a pessoa reconhecer");
  assert.match(html, /Já lançada à mão/);
  assert.match(html, /data-acao="\/api\/fv2\/acoes\/movimentos-caixa\/lancar-despesas"/);
  assert.match(html, /Lançar 1 retirada\(s\) como despesa paga/);
  assert.match(html, /viram conta paga em dinheiro pelo Caixa da loja \(fornecedor Sangrias, Outras despesas\)\. Isso entra na DRE/);
  assert.deepEqual(auditarHtml(html), []);
  // Sem permissão de registrar: só explica.
  assert.match(conf.detalheDocumento(d, { permissoes: ["financeiro_v2.ver", "financeiro_v2.importar"] }), /Lançar exige a permissão "registrar"/);
  // Lança pelo núcleo real e relê: nada novo.
  const feito = await ESCRITAS["/movimentos-caixa/lancar-despesas"].fazer(n, c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-17" });
  assert.match(conf.resultadoDaAcao({ ok: true, dados: feito }), /1 retirada\(s\) lançada\(s\) como despesa paga em dinheiro; 3 já estava\(m\) lançada\(s\)/);
  const depois = conf.detalheDocumento(await CONSULTAS["/conferencias/documento"](n, c, { id: r.importacao.id }), { permissoes: PERMISSOES });
  assert.match(depois, /Nada novo a lançar/);
  assert.doesNotMatch(depois, /data-acao="\/api\/fv2\/acoes\/movimentos-caixa\/lancar-despesas"/);
  assert.deepEqual(auditarHtml(depois), []);
});
