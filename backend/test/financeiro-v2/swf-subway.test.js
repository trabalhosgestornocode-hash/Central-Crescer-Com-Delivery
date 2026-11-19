// SWF (Subway): leitores 03/45/76, fontes de faturamento por unidade, Balcão só pelo 76, iFood/99Food só conferência,
// calendário sem valor inventado por dia, conferência 76 × 03 × 45, idempotência e isolamento. Dados 100% SINTÉTICOS
// (o layout imita a exportação real do SWF; nenhum valor real da loja).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { analisarArquivo } from "../../src/modules/financeiro-v2/importacao/motor.js";
import { SWF_ANALISE_FATURAMENTO_ADAPTADOR as A45, SWF_CANAIS_ADAPTADOR as A76, SWF_PAGAMENTOS_ADAPTADOR as A03, canalSwf, grupoDaFormaSwf } from "../../src/modules/financeiro-v2/importacao/fontes/swf.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS, FONTE_DO_RELATORIO } from "../../src/modules/fv2-integracao/escritas.js";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { saiposVendas } from "./helpers/arquivos.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const JUST = "Conferido com os relatórios sintéticos do SWF.";
const PER = { inicio: "2026-11-01", fim: "2026-11-02" };
const LOJA = "SUBWAY LOJA SINTETICA";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// 76: três níveis de cabeçalho, linha em branco no meio, sem período impresso (como no arquivo real).
const r76 = ({ b = ["5", "200,00"], i = ["8", "400,00"], n = ["10", "500,00"], loja = `9999 - ${LOJA}`, totalBalcao = "200,00" } = {}) => xlsx([{ nome: "Vendas_Canais_Lojas_XLS", linhas: [
  ["", "Delivery", "", "", "", "", "", "", "", "Salão", "", "", "", "", "Total", ""],
  ["", "99Food", "", "iFood", "", "Total Canal", "", "", "", "Balcão", "", "Total Canal", "", "", "", ""],
  [],
  ["", "Qtd", "Total", "Qtd", "Total", "Qtd", "", "Total", "", "Qtd", "Total", "Qtd", "Total", "", "Qtd", "Total"],
  [loja, n[0], n[1], i[0], i[1], "18", "", "900,00", "", b[0], b[1], b[0], totalBalcao, "", "23", "1.100,00"],
  [],
  ["Totais", n[0], n[1], i[0], i[1], "18", "", "900,00", "", b[0], b[1], b[0], totalBalcao, "", "23", "1.100,00"],
] }]);
// 03: rótulo e valores em colunas diferentes (células mescladas), total só com "R$" e rodapé de impressão.
const r03 = ({ periodo = "  01/11/2026  a 02/11/2026", loja = LOJA, dinheiro = "120,00" } = {}) => xlsx([{ nome: "faturamentoPagamento", linhas: [
  [], ["", "", "", "FATURAMENTO POR TIPO DE PAGAMENTO"], ["", "", "", loja], [], ["", periodo],
  ["", "Forma de pagamento", "", "", "", "", "Valor"],
  ["", "", "99 ONLINE", "", "", "", "300,00"], ["", "", "99 VOUCHER", "", "", "", "200,00"], ["", "", "IFOOD ONLINE", "", "", "", "350,00"],
  ["", "", "DINHEIRO", "", "", "", dinheiro], ["", "", "VISA DEBITO TEF", "", "", "", "100,00"], ["", "", "MASTERCARD CRED TEF", "", "", "", "30,00"],
  ["", "", "", "", "", "", "R$ 1.100,00"], ["", "Sex, 20 nov 2026 10:00:00 ", "", "", "", "", "", "Página 1 de", " 1"],
] }]);
// 45: um dia por linha, com a composição; total "(2)" e rodapé.
const r45 = ({ periodo = "  01/11/2026  a 02/11/2026", dia2 = "500,00" } = {}) => xlsx([{ nome: "Analise_Faturamento", linhas: [
  ["", "ANÁLISE DE FATURAMENTO"], ["", LOJA], ["", periodo, "", "", "Hora Inicial:00:00 a Hora Final:23:59"],
  ["", "Data", "Produtos    +", "", "Repiques    +", "Serviços    +", "Tx. Entregas +", "", "Créditos   -", "Descontos   -", "Combos    -", "Especiais    -", "Cortesias    -", "Assinadas   =", "Total        -", "Faturamento =", "", "Diferença"],
  ["", "01/11/2026", "600,00", "", "0,00", "0,00", "20,00", "", "0,00", "15,00", "5,00", "0,00", "0,00", "0,00", "600,00", "600,00", "", "0,00"],
  ["", "02/11/2026", "510,00", "", "0,00", "0,00", "0,00", "", "0,00", "10,00", "0,00", "0,00", "0,00", "0,00", dia2, dia2, "", "0,00"],
  ["", " (2)", "R$ 1.110,00", "", "R$ 0,00", "R$ 0,00", "R$ 20,00", "", "R$ 0,00", "R$ 25,00", "R$ 5,00", "R$ 0,00", "R$ 0,00", "R$ 0,00", "R$ 1.100,00", "R$ 1.100,00", "", "R$ 0,00"],
  ["", "Sex, 20 nov 2026 10:00:00 ", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Página 1 de", "", " 1"],
] }]);

const novo = () => montar({ relogio: () => AGORA }).nucleo;
const configurarUnidade = (n, contexto = c) => ESCRITAS["/configuracoes/unidade"].fazer(n, contexto, { nomeExibicao: "Subway sintética", justificativa: JUST });
const usarSwf = async (n, contexto = c, lojasSwf = [LOJA]) => { await configurarUnidade(n, contexto); return n.configurarFontesDeFaturamento(contexto, { fontes: ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], lojasSwf, justificativa: JUST }); };
const receber = (n, tipoRelatorio, conteudo, { contexto = c, inicio = PER.inicio, fim = PER.fim, fonte = "OUTRO" } = {}) => n.receberArquivoParaImportacao(contexto, { fonte, tipoRelatorio, tipoMime: XLSX, conteudo, periodoInicio: inicio, periodoFim: fim });
async function importar(n, tipo, conteudo, o = {}) {
  const r = await receber(n, tipo, conteudo, o);
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const conf = await n.confirmarImportacao(o.contexto ?? c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  return conf.importacao;
}
const aprovarEAplicar = async (n, p, contexto = c) => { await n.aprovarProposta(contexto, { propostaId: p.id, justificativa: JUST }); return n.aplicarProposta(contexto, { propostaId: p.id }); };
const faturamentoPorCanal = async (n, contexto = c) => Object.fromEntries((await n.apurarCompetencia(contexto, { competencia: "2026-11" })).indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.map((x) => [x.canal, x.valorCentavos ?? 0]));
const analisar = (adaptador, bytes, periodo = PER) => analisarArquivo({ bytes, adaptador, periodo });

test("leitor 76: tabela de três níveis vira um registro por canal; só o Balcão é receita; subtotais conferidos", () => {
  const a = analisar(A76, r76());
  assert.deepEqual([a.reconhecido, a.erros.length, a.registros.length], [true, 0, 3]);
  assert.deepEqual(a.registros.map((r) => [r.dados.canal, r.dados.quantidade, r.valorCentavos, r.dados.papel]), [
    ["NOVENTA_E_NOVE_FOOD", 10, 50000, "CONFERENCIA"], ["IFOOD", 8, 40000, "CONFERENCIA"], ["BALCAO", 5, 20000, "RECEITA"],
  ]);
  assert.equal(a.registros[2].dados.estabelecimento, LOJA);
  assert.equal(a.registros[2].dados.lojaCodigo, "9999");
  assert.ok(!a.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), JSON.stringify(a.divergencias));
  assert.ok(a.divergencias.some((d) => d.codigo === "PERIODO_DO_DOCUMENTO"), "o 76 não imprime período: fica divergência para conferir");
  assert.ok(analisar(A76, r76({ totalBalcao: "210,00" })).divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), "subtotal do grupo que não fecha aparece");
  assert.equal(analisar(A76, r76({ b: ["5", "abc"] })).erros[0].campo, "valor");
  assert.deepEqual([canalSwf("Balcão"), canalSwf("iFood"), canalSwf("99Food"), canalSwf("Totem")], ["BALCAO", "IFOOD", "NOVENTA_E_NOVE_FOOD", null]);
});

test("leitor 03: células mescladas, total com R$ e rodapé; formas separadas em app × recebidas pela loja", () => {
  const a = analisar(A03, r03());
  assert.deepEqual([a.reconhecido, a.erros.length, a.registros.length], [true, 0, 6], JSON.stringify(a.erros));
  assert.deepEqual(a.controles.swf.porGrupo, { PLATAFORMA_99FOOD: 50000, PLATAFORMA_IFOOD: 35000, RECEBIDO_PELA_LOJA: 25000 });
  assert.ok(!a.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"));
  assert.ok(analisar(A03, r03({ dinheiro: "130,00" })).divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), "soma das formas × total do relatório");
  assert.ok(analisar(A03, r03(), { inicio: "2026-11-01", fim: "2026-11-03" }).erros.some((e) => e.codigo === "PERIODO_INCORRETO"), "período impresso × declarado");
  assert.deepEqual([grupoDaFormaSwf("MASTERCARD CRED TEF").forma, grupoDaFormaSwf("PIX P.O.S").forma, grupoDaFormaSwf("IFOOD VOUCHER").grupo, grupoDaFormaSwf("99 VOUCHER").grupo, grupoDaFormaSwf("XPTO").grupo],
    ["CREDITO", "PIX", "PLATAFORMA_IFOOD", "PLATAFORMA_99FOOD", "NAO_RECONHECIDA"]);
});

test("leitor 45: um registro por dia (todos os canais), composição e total conferidos", () => {
  const a = analisar(A45, r45());
  assert.deepEqual([a.reconhecido, a.erros.length, a.registros.length], [true, 0, 2], JSON.stringify(a.erros));
  assert.deepEqual(a.registros.map((r) => [r.data, r.valorCentavos, r.dados.fecha, r.tipoRegistro]), [["2026-11-01", 60000, true, "TOTAL_DIA_TODOS_CANAIS"], ["2026-11-02", 50000, true, "TOTAL_DIA_TODOS_CANAIS"]]);
  const torto = analisar(A45, r45({ dia2: "490,00" }));
  assert.ok(torto.divergencias.some((d) => d.codigo === "LINHA_NAO_FECHA") && torto.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"));
  assert.ok(analisar(A45, r45({ periodo: "  01/11/2026  a 03/11/2026" })).erros.some((e) => e.codigo === "PERIODO_INCORRETO"));
});

test("fontes por unidade: padrão SAIPOS; SWF só com permissão de configurar, justificativa e histórico; repetir não altera", async () => {
  const n = novo();
  assert.deepEqual((await n.consultarFontesDeFaturamento(c)).fontes, ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await configurarUnidade(n);
  await rejeita(n.configurarFontesDeFaturamento(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.IMPORTAR]), { fontes: ["SWF", "IFOOD"], justificativa: JUST }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.configurarFontesDeFaturamento(c, { fontes: ["SWF", "SAIPOS"], justificativa: JUST }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.configurarFontesDeFaturamento(c, { fontes: ["SWF"] }), CODIGO.ENTRADA_INVALIDA);
  const r = await usarSwf(n);
  assert.deepEqual([r.sistemaDeLoja, r.fontes, r.lojasSwf, r.repetido], ["SWF", ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], [LOJA], false]);
  assert.equal((await n.configurarFontesDeFaturamento(c, { fontes: ["NOVENTA_E_NOVE_FOOD", "IFOOD", "SWF"], lojasSwf: [LOJA.toLowerCase()], justificativa: JUST })).repetido, true);
  const hist = await n.consultarHistorico(c, { registroTipo: "CONFIGURACAO_UNIDADE" }).catch(() => null);
  if (hist) assert.ok(JSON.stringify(hist).includes("fontesDeFaturamento"));
  // Outra unidade da mesma organização continua no padrão (configuração é por unidade).
  assert.deepEqual((await n.consultarFontesDeFaturamento(ctx(ORG_A, UNI_A2))).fontes, ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
});

test("travas: SWF em unidade SAIPOS e SAIPOS em unidade SWF são recusados; loja SWF de outra unidade também", async () => {
  const n = novo();
  await rejeita(receber(n, "SWF_CANAIS", r76()), CODIGO.OPERACAO_INVALIDA);
  await usarSwf(n);
  await rejeita(receber(n, "SAIPOS_VENDAS", saiposVendas([]), { fonte: "SAIPOS" }), CODIGO.OPERACAO_INVALIDA);
  const alheia = await receber(n, "SWF_CANAIS", r76({ loja: "1234 - SUBWAY OUTRA LOJA" }));
  assert.equal(alheia.importacao.estado, "REJEITADO");
  assert.ok(alheia.previa.erros.some((e) => e.codigo === "UNIDADE_INCOMPATIVEL"));
  // A unidade padrão (Açaí) segue aceitando SAIPOS e recusando SWF.
  const acai = ctx(ORG_A, UNI_A2);
  await rejeita(receber(n, "SWF_PAGAMENTOS", r03(), { contexto: acai }), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(["SWF_CANAIS", "SWF_PAGAMENTOS", "SWF_ANALISE_FATURAMENTO"].map((t) => FONTE_DO_RELATORIO[t]), ["OUTRO", "OUTRO", "OUTRO"]);
});

test("76 aplicado: só o Balcão vira receita (uma vez); iFood e 99Food do SWF não geram faturamento; reenvio é idempotente", async () => {
  const n = novo();
  await usarSwf(n);
  const imp = await importar(n, "SWF_CANAIS", r76());
  const g = await n.gerarPropostas(c, { importacaoId: imp.id });
  assert.equal(g.criadas, 1, "uma proposta: Balcão");
  const [p] = await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" });
  assert.deepEqual([p.comando.canal, p.comando.receitaBrutaCentavos, p.comando.periodoInicio, p.comando.periodoFim, p.comando.quantidadeVendas], ["BALCAO", 20000, "2026-11-01", "2026-11-02", 5]);
  await aprovarEAplicar(n, p);
  const fat = await faturamentoPorCanal(n);
  assert.equal(fat.BALCAO, 20000);
  assert.equal(fat.IFOOD ?? 0, 0, "iFood do SWF não é receita");
  assert.equal(fat.NOVENTA_E_NOVE_FOOD ?? 0, 0, "99Food do SWF não é receita");
  const receitas = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO" && l.canal === "BALCAO");
  assert.equal(receitas.length, 1);
  assert.equal(receitas[0].fonte.sistema, "SWF");
  // Mesmo arquivo de novo: a importação existente volta; gerar de novo não cria nada.
  assert.equal((await receber(n, "SWF_CANAIS", r76())).repetido, true);
  assert.equal((await n.gerarPropostas(c, { importacaoId: imp.id })).criadas, 0);
  // 03 e 45 não geram proposta (controle).
  const i03 = await importar(n, "SWF_PAGAMENTOS", r03());
  const i45 = await importar(n, "SWF_ANALISE_FATURAMENTO", r45());
  assert.equal((await n.gerarPropostas(c, { importacaoId: i03.id })).criadas, 0);
  assert.equal((await n.gerarPropostas(c, { importacaoId: i45.id })).criadas, 0);
  assert.equal((await faturamentoPorCanal(n)).BALCAO, 20000, "controle não soma faturamento");
});

test("conferência 76 × 03 × 45: diferença entre formas da loja e Balcão fica pendente, sem presumir", async () => {
  const n = novo();
  await usarSwf(n);
  await importar(n, "SWF_CANAIS", r76());
  await importar(n, "SWF_PAGAMENTOS", r03());
  await importar(n, "SWF_ANALISE_FATURAMENTO", r45());
  const conf = await CONSULTAS["/conferencia-swf"](n, c, { mes: "2026-11" });
  assert.equal(conf.usaSwf, true);
  const [p] = conf.periodos;
  const cmp = Object.fromEntries(p.comparacoes.map((x) => [x.codigo, [x.diferencaCentavos, x.situacao]]));
  assert.deepEqual(cmp, {
    TOTAL_76_X_03: [0, "CONFERE"], RECEBIDO_PELA_LOJA_X_BALCAO: [5000, "PENDENTE_DE_INVESTIGACAO"], IFOOD_76_X_03: [5000, "PENDENTE_DE_INVESTIGACAO"],
    NOVENTA_E_NOVE_76_X_03: [0, "CONFERE"], TOTAL_76_X_45: [0, "CONFERE"],
  });
  assert.equal(p.balcao.situacao, "SEM_PROPOSTA");
  assert.deepEqual(conf.dias.map((d) => [d.data, d.faturamentoTodosCanaisCentavos, d.natureza]), [["2026-11-01", 60000, "CONTROLE_TODOS_OS_CANAIS"], ["2026-11-02", 50000, "CONTROLE_TODOS_OS_CANAIS"]]);
  assert.equal((await CONSULTAS["/conferencia-swf"](n, ctx(ORG_A, UNI_A2), { mes: "2026-11" })).importado, false, "outra unidade não enxerga");
});

test("calendário do Balcão (SWF): 30 dias, cobertura do período sem valor por dia, dia sem documento sem registro, Anota Aí fora", async () => {
  const n = novo();
  await usarSwf(n);
  await importar(n, "SWF_CANAIS", r76());
  await importar(n, "SWF_ANALISE_FATURAMENTO", r45());
  const cal = await n.consultarCalendarioDeFaturamento(c, { canal: "BALCAO", mes: "2026-11" });
  assert.equal(cal.dias.length, 30);
  assert.equal(cal.swf, true);
  const d1 = cal.dias.find((d) => d.data === "2026-11-01");
  assert.ok(d1.estados.includes("IMPORTADO"));
  assert.equal(d1.registro, null, "nenhum valor do Balcão inventado para o dia");
  assert.equal(d1.cobertura.granularidadeDiaria, false);
  assert.equal(d1.cobertura.periodos[0].balcaoCentavos, 20000);
  assert.equal(d1.swfControleDoDia.faturamentoTodosCanaisCentavos, 60000);
  assert.ok(d1.pendencias.some((p) => p.codigo === "BALCAO_SWF_NAO_APLICADO"));
  const d5 = cal.dias.find((d) => d.data === "2026-11-05");
  assert.deepEqual(d5.estados, ["SEM_REGISTRO"]);
  assert.equal(d5.registro, null);
  assert.ok(cal.dias.find((d) => d.data === "2026-11-25").futuro);
  await rejeita(n.registrarDiaSemOperacao(c, { canal: "BALCAO", data: "2026-11-01", justificativa: JUST }), CODIGO.OPERACAO_INVALIDA);
  const anota = await n.consultarCalendarioDeFaturamento(c, { canal: "ANOTA_AI", mes: "2026-11" });
  assert.equal(anota.canalNaUnidade, false);
  assert.ok(anota.dias.every((d) => !d.estados.includes("SEM_REGISTRO")), "canal fora da unidade não acusa atraso");
  // iFood e 99Food continuam pela fonte oficial: sem relatório, sem dados.
  const ifood = await n.consultarCalendarioDeFaturamento(c, { canal: "IFOOD", mes: "2026-11" });
  assert.equal(ifood.dias.length, 30);
  assert.ok(ifood.dias.every((d) => !d.estados.includes("IMPORTADO")));
});

test("área de importações: SWF só habilitado na unidade SWF; SAIPOS desabilitado nela; isolamento entre organizações", async () => {
  const n = novo();
  await usarSwf(n);
  const swf = await n.consultarImportacoesDoCanal(c, { canal: "SWF" });
  assert.deepEqual([swf.habilitadoNaUnidade, swf.formatos.map((f) => [f.id, f.aceitaArquivo])], [true, [["SWF_CANAIS", true], ["SWF_PAGAMENTOS", true], ["SWF_ANALISE_FATURAMENTO", true], ["SWF_SANGRIAS", true]]]);
  const saipos = await n.consultarImportacoesDoCanal(c, { canal: "SAIPOS" });
  assert.equal(saipos.habilitadoNaUnidade, false);
  assert.ok(saipos.formatos.every((f) => !f.aceitaArquivo));
  await importar(n, "SWF_CANAIS", r76());
  assert.equal((await n.consultarImportacoesDoCanal(c, { canal: "SWF" })).historico.length, 1);
  assert.equal((await n.consultarImportacoesDoCanal(ctx(ORG_B, UNI_B), { canal: "SWF" })).historico.length, 0, "outra organização não vê");
  assert.equal((await n.consultarImportacoesDoCanal(ctx(ORG_A, UNI_A2), { canal: "SWF" })).habilitadoNaUnidade, false);
  assert.equal((await n.consultarImportacoesDoCanal(ctx(ORG_A, UNI_A2), { canal: "SAIPOS" })).habilitadoNaUnidade, true, "Açaí segue com SAIPOS");
  assert.ok(UNI_A !== UNI_A2);
});
