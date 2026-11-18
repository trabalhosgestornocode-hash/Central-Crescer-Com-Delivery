// Relatório oficial da 99Food. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { analisarArquivo } from "../../src/modules/financeiro-v2/importacao/motor.js";
import { NOVENTA_E_NOVE_FOOD_RELATORIO as ADAPTADOR } from "../../src/modules/financeiro-v2/importacao/fontes/noventaENoveFood.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, ORG_B, UNI_A2, UNI_B, ctx, montar, prepararHomologacao, rejeita } from "./helpers/cenario.js";
import { saiposVendas, texto } from "./helpers/arquivos.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const JUST = "Conferido com o relatório sintético.";
const CAB = ["Data", "Nome do estabelecimento", "ID do loja", "Cidade", "Nome do signatário", "ID do signatário", "Vendas de itens", "Taxas de processamento de pagamento", "Despesas de comissão", "Total de vendas realizadas", "Valor médio dos pedidos", "Recompensas da plataforma", "Pedidos de oferta finalizados", "Valor do repasse", "Receita de pedidos em oferta", "Despesas de marketing"];
const LOJA = "1000000000000000001";
const linha = (data, { itens = "100,00", proc = "2,00", com = "10,00", qtd = 2, medio = "50,00", rec = "30,00", repasse = "70,00", oferta = "80,00", mkt = "5,00", loja = LOJA, nome = "Loja Sintética" } = {}) => [data, nome, loja, "Cidade Sintética", "Pessoa Sintética", "SIG-1", itens, proc, com, String(qtd), medio, rec, String(qtd), repasse, oferta, mkt];
const D1 = linha("2026-11-01");
const D2 = linha("2026-11-02", { itens: "50,5", proc: "1,00", com: "5,00", qtd: 1, medio: "50,5", rec: "10,00", repasse: "40,00", oferta: "40,00", mkt: "0" });
const csv = (linhas) => texto([CAB, ...linhas].map((l) => l.join(";")).join(String.fromCharCode(10)));
const PERIODO = { inicio: "2026-11-01", fim: "2026-11-17" };
const analisar = (bytes) => analisarArquivo({ bytes, adaptador: ADAPTADOR, periodo: PERIODO });

/** ZIP mínimo (sem compressão) com as entradas informadas. */
function zip(entradas) {
  const partes = []; const central = []; let pos = 0;
  for (const [nome, dados] of entradas) {
    const n = Buffer.from(nome); const b = Buffer.from(dados);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(b.length, 18); local.writeUInt32LE(b.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(b.length, 20); cen.writeUInt32LE(b.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(pos, 42);
    partes.push(local, n, b); central.push(cen, n); pos += 30 + n.length + b.length;
  }
  const dir = Buffer.concat(central);
  const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10); fim.writeUInt32LE(dir.length, 12); fim.writeUInt32LE(pos, 16);
  return new Uint8Array(Buffer.concat([...partes, dir, fim]));
}

const novo = () => montar({ relogio: () => AGORA }).nucleo;
async function receber(n, linhas, { contexto = c, inicio = "2026-11-01", fim = "2026-11-17", substitui } = {}) {
  return n.receberArquivoParaImportacao(contexto, { fonte: "OUTRO", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", tipoMime: "text/csv", conteudo: csv(linhas), periodoInicio: inicio, periodoFim: fim, ...(substitui ? { substituiImportacaoId: substitui } : {}) });
}
async function importar(n, linhas, o = {}) {
  const r = await receber(n, linhas, o);
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const conf = await n.confirmarImportacao(o.contexto ?? c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  return { imp: conf.importacao, previa: r.previa, relatorio: conf.relatorio };
}
const aplicar = (n, imp, contexto = c) => n.aplicarRelatorio99Food(contexto, { importacaoId: imp.id, justificativa: JUST, aceitarDiferencaDeRepasse: true });
const previa = (n, imp) => n.previaDoRelatorio99Food(c, { importacaoId: imp.id });
const ativos = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "LANCAMENTO" })).filter((l) => l.relatorio99Food && l.situacao === "ATIVO");
const soma = (l, comp) => l.filter((x) => x.relatorio99Food.componente === comp).reduce((s, x) => s + x.valorCentavos, 0);
const configurar = (n, contexto = c) => ESCRITAS["/configuracoes/unidade"].fazer(n, contexto, { nomeExibicao: "Unidade sintética", justificativa: JUST });
const diaDe = async (n, data = "2026-11-01") => (await n.consultarCalendarioDeFaturamento(c, { canal: "NOVENTA_E_NOVE_FOOD", mes: "2026-11" })).dias.find((d) => d.data === data);
const area = (n) => n.consultarCanalPlataforma(c, { canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-11" });

test("leitura: colunas reais, vírgula decimal, totais calculados e dados do signatário fora da cópia", () => {
  const a = analisar(csv([D1, D2]));
  assert.deepEqual([a.reconhecido, a.erros.length, a.registros.length], [true, 0, 2]);
  const t = a.controles.relatorio99Food.total;
  assert.deepEqual([t.dias, t.quantidade, t.itensCentavos, t.processamentoCentavos, t.comissaoCentavos, t.marketingCentavos, t.recompensasCentavos, t.receitaOfertaCentavos, t.repasseCentavos], [2, 3, 15050, 300, 1500, 500, 4000, 12000, 11000]);
  assert.equal(a.registros[0].original["Nome do signatário"], "[omitido]");
  assert.equal(a.registros[0].original["ID do signatário"], "[omitido]");
  assert.ok(!JSON.stringify(a.registros[0].dados).includes("Pessoa Sintética"));
  assert.ok(a.divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), "o repasse que não fecha aparece na prévia");
  assert.equal(analisar(texto("Data;Valor\n2026-11-01;10,00")).reconhecido, false);
  assert.ok(analisar(csv([linha("2026-11-01", { itens: "abc" })])).erros.some((e) => e.campo === "itens"));
  assert.ok(analisar(csv([D1, linha("2026-11-01", { itens: "90,00", medio: "45,00" })])).erros.some((e) => e.codigo === "CONFLITO_NO_ARQUIVO"), "dia repetido com outros valores não soma");
});

test("XLSX direto e ZIP original dão o mesmo resultado; ZIP inesperado é recusado", () => {
  const planilha = xlsx([{ nome: "Sheet1", linhas: [CAB, D1, D2] }]);
  const direto = analisar(planilha);
  const noZip = analisar(zip([["Dados da loja.xlsx", planilha]]));
  assert.deepEqual([direto.compatibilidade, direto.registros.length, direto.erros.length], ["AMOSTRA_REAL", 2, 0]);
  assert.deepEqual(noZip.registros.map((r) => r.chave), direto.registros.map((r) => r.chave));
  assert.equal(analisar(zip([["a.xlsx", planilha], ["b.xlsx", planilha]])).reconhecido, false);
  assert.equal(analisar(zip([["../a.xlsx", planilha]])).reconhecido, false);
});

test("DRE: vendas, taxas, comissões e marketing entram uma vez; recompensas e receita de ofertas ficam fora", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  assert.equal((await ativos(n)).length, 0, "importar não lança");
  const p = await previa(n, imp);
  assert.deepEqual([p.valores.vendasCentavos, p.valores.resultadoCentavos, p.valores.repasseInformadoCentavos, p.valores.diferencaRepasseCentavos, p.exigeAceiteDaDiferenca, p.lancamentos.criar], [15050, 12750, 11000, 1750, true, 7]);
  assert.equal((await ativos(n)).length, 0, "a prévia não grava");
  await rejeita(n.aplicarRelatorio99Food(c, { importacaoId: imp.id, justificativa: JUST }), CODIGO.CONFIRMACAO_EXIGIDA);
  await aplicar(n, imp);
  const l = await ativos(n);
  assert.deepEqual(["VENDAS", "PROCESSAMENTO", "COMISSOES", "MARKETING"].map((k) => soma(l, k)), [15050, 300, 1500, 500]);
  assert.deepEqual([...new Set(l.map((x) => x.categoria))].sort(), ["ANUNCIOS_E_DIVULGACAO", "COMISSOES_DE_PLATAFORMA", "TAXAS_DE_PROCESSAMENTO", "VENDA_NOVENTA_E_NOVE_FOOD"]);
  const a = await n.apurarCompetencia(c, { competencia: "2026-11" });
  assert.equal(a.indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.find((x) => x.canal === "NOVENTA_E_NOVE_FOOD").valorCentavos, 15050);
  assert.equal(a.indicadores.RESULTADO_GERENCIAL.valorCentavos, 12750, "composição demonstrável");
});

test("repasse informado não vira recebível, crédito, venda nem baixa", async () => {
  const n = novo();
  await aplicar(n, (await importar(n, [D1, D2])).imp);
  for (const tipo of ["RECEBIVEL", "MOVIMENTACAO", "LIQUIDACAO", "VENDA"]) assert.equal((await n.consultarRegistros(c, { tipo })).length, 0, tipo);
  const d = await diaDe(n);
  assert.ok(d.pendencias.some((x) => x.codigo === "REPASSE_SEM_CICLO"));
  assert.equal(d.noventaOficial.repasseCentavos, 7000);
});

test("reenvio e reaplicação não duplicam; relatório novo acrescenta só as datas novas", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  await aplicar(n, imp);
  const antes = (await ativos(n)).map((l) => l.id).sort();
  assert.equal((await aplicar(n, imp)).repetido, true);
  assert.equal((await receber(n, [D1, D2])).repetido, true);
  assert.deepEqual((await ativos(n)).map((l) => l.id).sort(), antes);
  const D3 = linha("2026-11-03");
  const seg = await importar(n, [D1, D2, D3]);
  assert.deepEqual([seg.relatorio.inseridos, seg.relatorio.jaImportados, seg.relatorio.conflitosNaoGravados], [1, 2, 0]);
  await aplicar(n, seg.imp);
  assert.equal(soma(await ativos(n), "VENDAS"), 25050);
});

test("dia corrigido sem substituição é barrado; versão corrigida troca o dia e cancela a anterior", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  await aplicar(n, imp);
  const corrigido = linha("2026-11-01", { itens: "120,00", medio: "60,00" });
  const r = await receber(n, [corrigido, D2]);
  assert.deepEqual([r.previa.contagens.novos, r.previa.contagens.jaImportados, r.previa.contagens.conflitos], [0, 1, 1], "distingue iguais e corrigidos");
  const conf = await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  assert.ok((await previa(n, conf.importacao)).bloqueios.some((x) => x.codigo === "DADOS_CORRIGIDOS_SEM_SUBSTITUICAO"));
  await rejeita(aplicar(n, conf.importacao), CODIGO.OPERACAO_INVALIDA);
  assert.equal(soma(await ativos(n), "VENDAS"), 15050, "nada mudou nem somou");

  const m = novo();
  const a = await importar(m, [D1, D2]);
  await aplicar(m, a.imp);
  const b = await importar(m, [corrigido, D2], { substitui: a.imp.id });
  await aplicar(m, b.imp);
  assert.equal(soma(await ativos(m), "VENDAS"), 17050);
  const todos = (await m.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.relatorio99Food?.dia === "2026-11-01" && l.relatorio99Food.componente === "VENDAS");
  assert.deepEqual(todos.map((l) => [l.relatorio99Food.versao, l.situacao]).sort(), [[1, "CANCELADO"], [2, "ATIVO"]]);
});

test("correção parcial e competência homologada não alteram dados sem revisão", async () => {
  const n = novo();
  const a = await importar(n, [D1, D2], { fim: "2026-11-02" });
  await aplicar(n, a.imp);
  const parcial = await importar(n, [D1], { fim: "2026-11-01", substitui: a.imp.id });
  assert.ok((await previa(n, parcial.imp)).bloqueios.some((x) => x.codigo === "SUBSTITUICAO_PARCIAL"));
  await rejeita(aplicar(n, parcial.imp), CODIGO.OPERACAO_INVALIDA);

  const m = montar({ relogio: () => new Date("2026-12-20T15:00:00.000Z") }).nucleo;
  const b = await importar(m, [D1, D2]);
  await aplicar(m, b.imp);
  await prepararHomologacao(m, c, "2026-11");
  await m.alterarEstadoDaCompetencia(c, { competencia: "2026-11", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  assert.equal((await aplicar(m, b.imp)).repetido, true, "sem alteração, nada bloqueia");
});

test("identidade da loja: vincula na primeira aplicação e recusa outra loja", async () => {
  const n = novo();
  await configurar(n);
  const a = await importar(n, [D1]);
  assert.ok((await previa(n, a.imp)).avisos.some((x) => x.codigo === "VINCULAR_LOJA"));
  await aplicar(n, a.imp);
  const [config] = await n.consultarRegistros(c, { tipo: "CONFIGURACAO_UNIDADE" });
  assert.deepEqual([config.identidade99Food.id, config.identidade99Food.nome], [LOJA, "Loja Sintética"]);
  const outra = await importar(n, [linha("2026-11-05", { loja: "2000000000000000002", nome: "Outra Loja" })]);
  const p = await previa(n, outra.imp);
  assert.ok(p.bloqueios.some((x) => x.codigo === "LOJA_DIFERENTE"));
  await rejeita(aplicar(n, outra.imp), CODIGO.OPERACAO_INVALIDA);
});

const saipos = async (n, pedidos) => {
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo: saiposVendas(pedidos), periodoInicio: "2026-11-01", periodoFim: "2026-11-02" });
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
};
const ped = (pedido, itens, data = "01/11/2026 12:00") => ({ pedido, data, canal: "99Food", forma: "Online", itens, total: itens });

test("calendário: dias do arquivo preenchidos, demais sem registro, importado nunca vira conciliado", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  assert.equal((await diaDe(n)).noventaOficial.situacaoConferencia, "IMPORTADO");
  await aplicar(n, imp);
  const cal = await n.consultarCalendarioDeFaturamento(c, { canal: "NOVENTA_E_NOVE_FOOD", mes: "2026-11" });
  assert.deepEqual([cal.granularidadeDiaria, cal.semFonteOficial, cal.dias.filter((d) => d.noventaOficial).length], [true, false, 2]);
  const d = cal.dias.find((x) => x.data === "2026-11-01");
  assert.deepEqual([d.noventaOficial.quantidade, d.noventaOficial.itensCentavos, d.noventaOficial.comissaoCentavos, d.noventaOficial.processamentoCentavos, d.noventaOficial.marketingCentavos, d.noventaOficial.recompensasCentavos, d.noventaOficial.repasseCentavos], [2, 10000, 1000, 200, 500, 3000, 7000]);
  assert.deepEqual([d.estados.includes("IMPORTADO"), d.estados.includes("CONFERENCIA_PENDENTE"), d.estados.includes("CONCILIADO")], [true, true, false]);
  const fora = cal.dias.find((x) => x.data === "2026-11-05");
  assert.equal(fora.noventaOficial, undefined);
  assert.ok(fora.estados.includes("SEM_REGISTRO") || fora.antesDoControle);
  await rejeita(n.registrarDiaSemOperacao(c, { canal: "NOVENTA_E_NOVE_FOOD", data: "2026-11-01", situacao: "SEM_OPERACAO", justificativa: JUST }), CODIGO.OPERACAO_INVALIDA);
});

test("SAIPOS só confere por dia: igual fica pendente, diferente fica divergente e nenhuma venda é criada", async () => {
  const n = novo();
  await saipos(n, [ped("1", 6000), ped("2", 4000), ped("3", 5000, "02/11/2026 12:00")]);
  await aplicar(n, (await importar(n, [D1, D2])).imp);
  const igual = await diaDe(n);
  assert.deepEqual([igual.noventaOficial.saipos.diferencaPedidos, igual.noventaOficial.saipos.diferencaItensCentavos, igual.noventaOficial.situacaoConferencia], [0, 0, "AGUARDANDO_CONFERENCIA"]);
  const dif = await diaDe(n, "2026-11-02");
  assert.deepEqual([dif.noventaOficial.saipos.diferencaItensCentavos, dif.noventaOficial.situacaoConferencia, dif.estados.includes("DIVERGENCIA")], [-50, "DIVERGENTE", true]);
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, 0);
  assert.equal((await area(n)).situacao, "DIVERGENTE");
});

test("venda 99Food já registrada no dia bloqueia a aplicação", async () => {
  const n = novo();
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  await n.registrarVenda(c, { canal: "NOVENTA_E_NOVE_FOOD", dataVenda: "2026-11-01", brutoCentavos: 1000, fonte: { sistema: "MANUAL", idExterno: "M-1" }, pagamentos: [{ valorCentavos: 1000, forma: "DINHEIRO", contaId: caixa.id }] });
  const { imp } = await importar(n, [D1]);
  assert.ok((await previa(n, imp)).bloqueios.some((x) => x.codigo === "VENDAS_99FOOD_APLICADAS"));
  await rejeita(aplicar(n, imp), CODIGO.OPERACAO_INVALIDA);
});

test("área da 99Food: totais só do que foi aplicado e histórico no canal certo", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  const antes = await area(n);
  assert.deepEqual([antes.situacao, antes.totais, antes.dependeDeRelatorioOficial], ["IMPORTADO", null, false]);
  await aplicar(n, imp);
  const t = (await area(n)).totais;
  assert.deepEqual([t.brutoCentavos, t.taxasCentavos, t.comissoesCentavos, t.marketingCentavos, t.resultadoCentavos, t.recompensasCentavos, t.repassePrevistoCentavos, t.repasseRecebidoCentavos, t.pedidos], [15050, 300, 1500, 500, 12750, 4000, 11000, 0, 3]);
  const canal = await n.consultarImportacoesDoCanal(c, { canal: "NOVENTA_E_NOVE_FOOD" });
  assert.deepEqual([canal.algumFormatoDisponivel, canal.historico.length, canal.historico[0].relatorio], [true, 1, "Relatório oficial da 99Food"]);
});

test("isolamento e permissão: outra unidade não vê nada e quem só consulta não aplica", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  await rejeita(aplicar(n, imp, ctx(undefined, undefined, ["financeiro_v2.ver"])), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await ESCRITAS["/importacao/99food/aplicar"].fazer(n, c, { importacao: imp.id, justificativa: JUST, aceitarDiferencaDeRepasse: "on" });
  assert.equal(r.lancamentos.criar, 7);
  for (const outra of [ctx(ORG_A, UNI_A2), ctx(ORG_B, UNI_B)]) {
    assert.equal((await ativos(n, outra)).length, 0);
    await rejeita(CONSULTAS["/previa-relatorio-99food"](n, outra, { importacao: imp.id }), CODIGO.NAO_ENCONTRADO);
    await rejeita(aplicar(n, imp, outra), CODIGO.NAO_ENCONTRADO);
  }
});
