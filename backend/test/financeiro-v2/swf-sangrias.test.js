// Sangrias do SWF (Subway): leitura do layout impresso (dias, quebra de página, subtotais, total, rodapé), data operacional × data/hora
// real (madrugada), sugestão por regras auditáveis, lançamento como despesa PAGA em dinheiro sem duplicar, pendências para VR/VT e
// adiantamentos, correção de arquivo, idempotência e isolamento. Dados 100% SINTÉTICOS (o layout imita o arquivo real do SWF).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { analisarArquivo } from "../../src/modules/financeiro-v2/importacao/motor.js";
import { SWF_SANGRIAS_ADAPTADOR as AD, sugerirSangriaSwf } from "../../src/modules/financeiro-v2/importacao/fontes/swfSangrias.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";
import { ORG_A, ORG_B, UNI_A2, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const JUST = "Conferido com o relatório sintético de sangrias.";
const LOJA = "SUBWAY LOJA SINTETICA";
const CAB = ["", "  Data/Hora", "", "    Motivo", "", "", "", "    Operador", "", "Valor "];
const mov = (dh, motivo, valor) => ["", "", dh, motivo, "", "", "", " OPERADORA SINTETICA", "", valor];
const sub = (n, v) => ["", "", ` (${n})`, "", "", "", "", "", "", `R$ ${v}`];
/**
 * 2 dias operacionais, 6 retiradas, total R$ 485,50. O dia 03/11 traz uma retirada de 04/11 00:04 (fechamento anterior) e o
 * relatório quebra a página no MEIO do dia 03 (cabeçalho repetido + rodapé), como no arquivo real.
 */
const arquivo = ({ periodo = "  02/11/2026 a 03/11/2026", total = "485,50", qtdTotal = 6, dia2 = "120,00", extra = [] } = {}) => xlsx([{ nome: "sangrias", linhas: [
  ["", "", "", "", "SANGRIAS"], ["", "", "", "", LOJA], ["", periodo], CAB,
  ["", "  Seg, 02/11/2026"], mov("02/11/2026 16:28:15", "SEGURANCA", "60,00"), mov("02/11/2026 23:26:12", "DIARIA PESSOA A", "140,00"), sub(2, "200,00"),
  ["", "  Ter, 03/11/2026"], mov("03/11/2026 17:30:57", "COPO DESC.", "18,50"), mov("03/11/2026 23:37:56", "VR PESSOA B", "70,00"),
  ["", "Qui, 19 nov 2026 13:56:08 ", "", "", "", "", "", "", "Página 1 de", "", " 2"], CAB,
  mov("03/11/2026 23:38:11", "VT PESSOA B", "77,00"), mov("04/11/2026 00:04:41", "DIARIA PESSOA B", dia2), ...extra, sub(4 + extra.length, "285,50"),
  ["", ` (${qtdTotal})`, "", "", "", "", "", "", "", `R$ ${total}`], ["", "Qui, 19 nov 2026 13:56:08 ", "", "", "", "", "", "", "Página 2 de", "", " 2"],
] }]);
const PER = { inicio: "2026-11-02", fim: "2026-11-03" };
const analisar = (bytes, periodo = PER) => analisarArquivo({ bytes, adaptador: AD, periodo });

async function unidade({ swf = true, comCaixa = true, contexto = c } = {}) {
  const { nucleo: n } = montar({ relogio: () => AGORA });
  const W = (k, b, x = contexto) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Subway sintética", justificativa: JUST });
  if (swf) await n.configurarFontesDeFaturamento(contexto, { fontes: ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], lojasSwf: [LOJA], justificativa: JUST });
  const caixa = comCaixa ? await n.configurarContaFinanceira(contexto, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" }) : null;
  const receber = (bytes, x = contexto, o = {}) => n.receberArquivoParaImportacao(x, { fonte: "OUTRO", tipoRelatorio: "SWF_SANGRIAS", tipoMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", conteudo: bytes, periodoInicio: PER.inicio, periodoFim: PER.fim, ...o });
  const importar = async (bytes, o = {}) => {
    const r = await receber(bytes, contexto, o);
    assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
    return (await n.confirmarImportacao(contexto, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST, ...(o.aceitar ?? {}) })).importacao;
  };
  const previa = (x = contexto) => CONSULTAS["/sangrias-swf"](n, x, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  const lancar = (registros, x = contexto) => W("/sangrias-swf/lancar", { periodoInicio: "2026-11-01", periodoFim: "2026-11-30", registros: registros.join(","), justificativa: JUST }, x);
  const contar = async (x = contexto) => ({
    obrigacoes: (await n.consultarRegistros(x, { tipo: "OBRIGACAO" })).filter((o) => o.situacao !== "CANCELADA"),
    movimentacoes: (await n.consultarRegistros(x, { tipo: "MOVIMENTACAO" })).filter((m) => m.situacao !== "ESTORNADA"),
  });
  return { n, W, caixa, receber, importar, previa, lancar, contar };
}

test("leitura: dias, quebra de página, subtotais e total conferidos; cabeçalho, rodapé e totais não viram retirada", () => {
  const a = analisar(arquivo());
  assert.deepEqual([a.reconhecido, a.erros.length, a.registros.length], [true, 0, 6], JSON.stringify(a.erros));
  assert.equal(a.controles.sangriasSwf.totalCentavos, 48550);
  assert.deepEqual(a.controles.sangriasSwf.porDia, [{ data: "2026-11-02", quantidade: 2, valorCentavos: 20000 }, { data: "2026-11-03", quantidade: 4, valorCentavos: 28550 }]);
  assert.ok(!a.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), JSON.stringify(a.divergencias));
  const madrugada = a.registros.find((r) => r.dados.motivoOriginal === "DIARIA PESSOA B");
  assert.deepEqual([madrugada.data, madrugada.dados.dataHoraReal, madrugada.dados.madrugada, madrugada.dados.doFechamentoAnterior], ["2026-11-03", "2026-11-04T00:04:41", true, true]);
  assert.equal(madrugada.dados.formaPagamento, "DINHEIRO");
  // subtotal ou total que não fecham aparecem; período impresso diferente é erro; arquivo de outro relatório não é reconhecido.
  assert.ok(analisar(arquivo({ dia2: "130,00" })).divergencias.filter((d) => d.codigo === "TOTAL_NAO_CONFERE").length >= 2);
  assert.ok(analisar(arquivo({ qtdTotal: 7 })).divergencias.some((d) => /conta 7/.test(d.mensagem)));
  assert.ok(analisar(arquivo(), { inicio: "2026-11-01", fim: "2026-11-03" }).erros.some((e) => e.codigo === "PERIODO_INCORRETO"));
  assert.equal(analisar(xlsx([{ nome: "x", linhas: [["Forma de pagamento", "Valor"], ["DINHEIRO", "10,00"]] }])).reconhecido, false);
  assert.ok(analisar(arquivo({ extra: [["", "", "linha estranha", "", "", "", "", "", "", ""]] })).erros.some((e) => e.codigo === "FORMATO_NAO_RECONHECIDO"), "linha não reconhecida não some");
});

test("regras de sugestão: pendências antes de despesa; cada sugestão tem código de regra", () => {
  const s = (m) => [sugerirSangriaSwf(m).natureza, sugerirSangriaSwf(m).regra, sugerirSangriaSwf(m).categoria];
  assert.deepEqual(s("DIARIA PESSOA C"), ["DESPESA", "DIARIA", "DIARIAS_EXTRAS"]);
  assert.deepEqual(s("SEGURANCA"), ["DESPESA", "SEGURANCA", "SERVICOS_DE_TERCEIROS"]);
  assert.deepEqual(s("COPO DESC."), ["DESPESA", "DESCARTAVEIS", "EMBALAGENS"]);
  assert.deepEqual(s("VR PESSOA B"), ["BENEFICIO", "VR", "VALE_REFEICAO"]);
  assert.deepEqual(s("VT PESSOA B"), ["BENEFICIO", "VT", "VALE_TRANSPORTE"]);
  assert.deepEqual(s("VALE REFEICAO E ALIMENTACA FULANA"), ["BENEFICIO", "VR", "VALE_REFEICAO"]);
  assert.deepEqual(s("ADIANTAMENTO FULANO"), ["ADIANTAMENTO", "ADIANTAMENTO", null]);
  assert.deepEqual(s("DEPOSITO NO COFRE"), ["TRANSFERENCIA", "TRANSFERENCIA", null]);
  assert.deepEqual(s("XPTO 123"), ["A_CLASSIFICAR", null, null]);
});

test("lançar: só o escolhido vira conta PAGA — conta no dia operacional, pagamento na data real; pendência não lançável é recusada", async () => {
  const u = await unidade();
  await u.importar(arquivo());
  assert.equal((await u.contar()).obrigacoes.length, 0, "importar não lança nada");
  const p = await u.previa();
  assert.deepEqual([p.resumo.total.quantidade, p.resumo.aLancar.quantidade, p.resumo.pendentes.quantidade, p.resumo.beneficios.quantidade], [6, 6, 0, 2]);
  const diaria = p.itens.find((i) => i.descricao === "DIARIA PESSOA B");
  const r = await u.lancar([diaria.registroId, "00000000-0000-4000-8000-000000000000"]);
  assert.equal(r.lancadas.length, 1);
  assert.equal(r.recusadas.length, 1, "id desconhecido é recusado, nunca ignorado em silêncio");
  const { obrigacoes, movimentacoes } = await u.contar();
  assert.equal(obrigacoes.length, 1);
  const o = obrigacoes[0];
  assert.deepEqual([o.saldoCentavos, o.vencimento, o.valorBaseCentavos, o.fonte.sistema], [0, "2026-11-03", 12000, "SWF"], "conta quitada, na data operacional");
  assert.match(o.descricao, /^DIARIA PESSOA B — sangria do caixa SWF \(04\/11\/2026 00:04\)/, "descrição original + hora real");
  const saidas = movimentacoes.filter((m) => m.contaId === u.caixa.id && m.sentido === "SAIDA");
  assert.deepEqual(saidas.map((m) => m.dataEfetiva), ["2026-11-04"], "um desembolso do caixa, na data REAL (madrugada de 04/11)");
  // Repetir não duplica.
  const de_novo = await u.lancar([diaria.registroId]);
  assert.deepEqual([de_novo.lancadas.length, de_novo.recusadas.length], [0, 1]);
  assert.equal((await u.contar()).obrigacoes.length, 1);
  // Calendário do Balcão SWF: a sangria aparece no DIA OPERACIONAL como paga em dinheiro, com categoria e origem; VR/VT como pendência.
  const cal = await u.n.consultarCalendarioDeFaturamento(c, { canal: "BALCAO", mes: "2026-11" });
  const d3 = cal.dias.find((d) => d.data === "2026-11-03");
  const it = d3.sangriasSwf.itens.find((i) => i.descricao === "DIARIA PESSOA B");
  assert.deepEqual([it.situacao, it.formaPagamento, it.origem, it.dataHoraReal, it.obrigacaoId], ["PAGO", "DINHEIRO", "Caixa SWF", "2026-11-04T00:04:41", o.id]);
  assert.ok(d3.pendencias.some((x) => x.codigo === "SANGRIAS_SWF_A_LANCAR"), "VR/VT ainda não lançados aparecem como pendência do dia");
  assert.equal(cal.dias.find((d) => d.data === "2026-11-04").sangriasSwf, undefined, "a retirada de 04/11 00:04 não aparece no dia 04");
});

test("conta já lançada à mão (paga em dinheiro pelo caixa na data) é reconhecida: nada duplicado", async () => {
  const u = await unidade();
  await u.importar(arquivo());
  const f = await u.n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Segurança do bairro" });
  const o = (await u.n.registrarObrigacao(c, { contraparteId: f.id, valorOriginalCentavos: 6000, categoria: "SERVICOS_DE_TERCEIROS", descricao: "segurança (à mão)", competencia: "2026-11", dataEmissao: "2026-11-02", vencimento: "2026-11-02" })).obrigacoes[0];
  await u.n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: u.caixa.id, dataEfetiva: "2026-11-02", valorCentavos: 6000 });
  const seg = (await u.previa()).itens.find((i) => i.descricao === "SEGURANCA");
  assert.deepEqual([seg.situacao, seg.situacaoPagamento, seg.podeLancar], ["JA_LANCADA_MANUALMENTE", "PAGO", false]);
  const r = await u.lancar([seg.registroId]);
  assert.equal(r.lancadas.length, 0);
  assert.equal((await u.contar()).obrigacoes.length, 1);
});

test("reimportação idêntica é idempotente; arquivo corrigido só substitui com aceite; madrugada fica no fechamento anterior", async () => {
  const u = await unidade();
  await u.importar(arquivo());
  assert.equal((await u.receber(arquivo())).repetido, true);
  // Versão corrigida: a diária de 04/11 00:04 passou de 120 para 110 (total e subtotal corrigidos no arquivo).
  const corrigido = xlsx([{ nome: "sangrias", linhas: [
    ["", "", "", "", "SANGRIAS"], ["", "", "", "", LOJA], ["", "  02/11/2026 a 03/11/2026"], CAB,
    ["", "  Seg, 02/11/2026"], mov("02/11/2026 16:28:15", "SEGURANCA", "60,00"), mov("02/11/2026 23:26:12", "DIARIA PESSOA A", "140,00"), sub(2, "200,00"),
    ["", "  Ter, 03/11/2026"], mov("03/11/2026 17:30:57", "COPO DESC.", "18,50"), mov("03/11/2026 23:37:56", "VR PESSOA B", "70,00"), mov("03/11/2026 23:38:11", "VT PESSOA B", "77,00"), mov("04/11/2026 00:04:41", "DIARIA PESSOA B", "110,00"), sub(4, "275,50"),
    ["", " (6)", "", "", "", "", "", "", "", "R$ 475,50"],
  ] }]);
  // Antes da correção, a diária original (120) já tinha sido lançada como despesa paga.
  await u.lancar([(await u.previa()).itens.find((i) => i.descricao === "DIARIA PESSOA B").registroId]);
  const r = await u.receber(corrigido);
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  assert.ok(r.previa.divergencias.some((d) => d.codigo === "CONFLITO_COM_IMPORTADO"), "a diferença aparece antes de confirmar");
  await rejeita(u.n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.IMPORTACAO_INVALIDA);
  assert.equal((await u.previa()).resumo.total.quantidade, 6, "sem aceite nada muda nem é somado em dobro");
  await u.n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Arquivo corrigido pelo SWF." });
  const p = await u.previa();
  assert.equal(p.resumo.total.quantidade, 6, "a linha antiga sai (substituída), a corrigida entra: 6, não 7");
  const nova = p.itens.find((i) => i.descricao === "DIARIA PESSOA B");
  assert.deepEqual([nova.valorCentavos, nova.podeLancar, Boolean(nova.despesaDeRetiradaSubstituida)], [11000, false, true], "a despesa antiga trava a versão corrigida");
  assert.equal(p.despesasDeRetiradasSubstituidas[0].valorCentavos, 12000);
  assert.equal((await u.lancar([nova.registroId])).lancadas.length, 0);
  assert.equal((await u.contar()).obrigacoes.length, 1, "nenhuma despesa em dobro");
});

test("isolamento e permissões: unidade sem SWF recusa; outra organização não vê; lançar exige registrar", async () => {
  const u = await unidade();
  await u.importar(arquivo());
  await rejeita(CONSULTAS["/sangrias-swf"](u.n, ctx(ORG_A, UNI_A2), { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(u.receber(arquivo(), ctx(ORG_A, UNI_A2)), CODIGO.OPERACAO_INVALIDA);
  const b = await unidade({ contexto: ctx(ORG_B, UNI_B) });
  assert.equal((await b.previa()).itens.length, 0, "outra organização não enxerga");
  const soLeitura = ctx(ORG_A, undefined, [ACAO.VER]);
  const id = (await u.previa()).itens.find((i) => i.podeLancar).registroId;
  await rejeita(u.lancar([id], { ...c, permissoes: [ACAO.VER, ACAO.IMPORTAR] }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.ok(soLeitura);
  const semCaixa = await unidade({ comCaixa: false });
  await semCaixa.importar(arquivo());
  const id2 = (await semCaixa.previa()).itens.find((i) => i.podeLancar).registroId;
  await rejeita(semCaixa.lancar([id2]), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await semCaixa.contar()).obrigacoes.length, 0, "sem caixa físico nada é lançado (nunca conta aberta)");
});
