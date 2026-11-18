// Relatório oficial da 99Food. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { analisarArquivo } from "../../src/modules/financeiro-v2/importacao/motor.js";
import { NOVENTA_E_NOVE_FOOD_RELATORIO as ADAPTADOR } from "../../src/modules/financeiro-v2/importacao/fontes/noventaENoveFood.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, ORG_B, UNI_A2, UNI_B, ctx, montar, prepararHomologacao, rejeita } from "./helpers/cenario.js";
import { EM_POSTGRES } from "./helpers/postgres.js";
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
const aplicarDireto = (n, imp, contexto = c) => n.aplicarRelatorio99Food(contexto, { importacaoId: imp.id, justificativa: JUST, aceitarDiferencaDeRepasse: true });
const configurar = (n, contexto = c) => ESCRITAS["/configuracoes/unidade"].fazer(n, contexto, { nomeExibicao: "Unidade sintética", justificativa: JUST });
const vincular = async (n, imp, lojaId = LOJA) => { await configurar(n); return n.vincularLoja99Food(c, { importacaoId: imp.id, lojaId, justificativa: JUST }); };
const aplicar = async (n, imp) => { await vincular(n, imp); return aplicarDireto(n, imp); };
const previa = (n, imp) => n.previaDoRelatorio99Food(c, { importacaoId: imp.id });
const ativos = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "LANCAMENTO" })).filter((l) => l.relatorio99Food && l.situacao === "ATIVO");
const soma = (l, comp) => l.filter((x) => x.relatorio99Food.componente === comp).reduce((s, x) => s + x.valorCentavos, 0);
const diaDe = async (n, data = "2026-11-01") => (await n.consultarCalendarioDeFaturamento(c, { canal: "NOVENTA_E_NOVE_FOOD", mes: "2026-11" })).dias.find((d) => d.data === data);
const area = (n) => n.consultarCanalPlataforma(c, { canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-11" });
const fat99 = async (n) => (await n.apurarCompetencia(c, { competencia: "2026-11" })).indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.find((x) => x.canal === "NOVENTA_E_NOVE_FOOD").valorCentavos ?? 0;
// Dias que fecham: resultado preliminar igual ao repasse informado.
const F1 = linha("2026-11-01", { repasse: "83,00" });
const F2 = linha("2026-11-02", { itens: "50,5", proc: "1,00", com: "5,00", qtd: 1, medio: "50,5", rec: "10,00", repasse: "44,50", oferta: "40,00", mkt: "0" });

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

test("DRE: lançamentos uma vez, recompensas fora e pendência explícita da 99Food sem lançamento compensatório", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  assert.equal((await ativos(n)).length, 0, "importar não lança");
  await vincular(n, imp);
  const p = await previa(n, imp);
  assert.deepEqual([p.valores.vendasCentavos, p.valores.resultadoPreliminarCentavos, p.valores.repasseInformadoCentavos, p.valores.diferencaRepasseCentavos, p.exigeAceiteDaDiferenca, p.lancamentos.criar], [15050, 12750, 11000, 1750, true, 7]);
  assert.equal((await ativos(n)).length, 0, "a prévia não grava");
  await rejeita(n.aplicarRelatorio99Food(c, { importacaoId: imp.id, justificativa: JUST }), CODIGO.CONFIRMACAO_EXIGIDA);
  await aplicarDireto(n, imp);
  const l = await ativos(n);
  assert.deepEqual(["VENDAS", "PROCESSAMENTO", "COMISSOES", "MARKETING"].map((k) => soma(l, k)), [15050, 300, 1500, 500]);
  assert.equal(l.length, 7, "nenhum lançamento cobre a diferença");
  assert.deepEqual([...new Set(l.map((x) => x.categoria))].sort(), ["ANUNCIOS_E_DIVULGACAO", "COMISSOES_DE_PLATAFORMA", "TAXAS_DE_PROCESSAMENTO", "VENDA_NOVENTA_E_NOVE_FOOD"]);
  const a = await n.apurarCompetencia(c, { competencia: "2026-11" });
  assert.equal(a.indicadores.RESULTADO_GERENCIAL.valorCentavos, 12750, "a diferença não altera o resultado");
  const pend = a.pendencias.find((x) => x.tipo === "REPASSE_99FOOD_EM_CONFERENCIA");
  assert.deepEqual([pend.canal, pend.resultadoPreliminarCentavos, pend.repasseInformadoCentavos, pend.valorCentavos, pend.diasDivergentes, pend.somaAbsolutaCentavos], ["NOVENTA_E_NOVE_FOOD", 12750, 11000, 1750, 2, 1750]);
  assert.match(pend.mensagem, /99Food: resultado gerencial preliminar .* pendente de conferência/);
  assert.ok(a.indicadores.RESULTADO_GERENCIAL.pendencias.some((x) => x.tipo === pend.tipo), "aparece junto do resultado");
  assert.notEqual(a.indicadores.RESULTADO_GERENCIAL.situacao, "CONFIRMADO");
});

test("divergências por dia não se anulam: soma zero continua pendente e exige aceite", async () => {
  const n = novo();
  const mais = linha("2026-11-01", { repasse: "73,00" }); // +10,00
  const menos = linha("2026-11-02", { itens: "50,5", proc: "1,00", com: "5,00", qtd: 1, medio: "50,5", rec: "10,00", repasse: "54,50", oferta: "40,00", mkt: "0" }); // −10,00
  assert.ok(analisar(csv([mais, menos])).divergencias.some((d) => d.diasDivergentes === 2));
  const { imp } = await importar(n, [mais, menos]);
  await vincular(n, imp);
  const p = await previa(n, imp);
  assert.deepEqual([p.divergencias.diasDivergentes, p.divergencias.somaAlgebricaCentavos, p.divergencias.somaAbsolutaCentavos, p.divergencias.situacao, p.exigeAceiteDaDiferenca], [2, 0, 2000, "PENDENTE_DE_CONFERENCIA", true]);
  assert.deepEqual(p.valoresDiarios.map((d) => d.diferencaRepasseCentavos), [1000, -1000]);
  await rejeita(n.aplicarRelatorio99Food(c, { importacaoId: imp.id, justificativa: JUST }), CODIGO.CONFIRMACAO_EXIGIDA);
  await aplicarDireto(n, imp);
  assert.deepEqual([(await diaDe(n)).noventaOficial.situacaoConferencia, (await diaDe(n, "2026-11-02")).noventaOficial.situacaoConferencia, (await area(n)).situacao], ["DIVERGENTE", "DIVERGENTE", "DIVERGENTE"]);
  assert.equal((await diaDe(n)).divergencias.find((x) => x.codigo === "REPASSE_99FOOD_DIVERGENTE").diferencaCentavos, 1000);
  const pend = (await n.apurarCompetencia(c, { competencia: "2026-11" })).pendencias.find((x) => x.tipo === "REPASSE_99FOOD_EM_CONFERENCIA");
  assert.deepEqual([pend.valorCentavos, pend.diasDivergentes, pend.somaAbsolutaCentavos], [0, 2, 2000]);
});

test("mês sem diferença não dispensa conferência nem aparece como conciliado", async () => {
  const n = novo();
  const { imp } = await importar(n, [F1, F2]);
  await vincular(n, imp);
  const p = await previa(n, imp);
  assert.deepEqual([p.divergencias.diasDivergentes, p.exigeAceiteDaDiferenca], [0, false]);
  await n.aplicarRelatorio99Food(c, { importacaoId: imp.id, justificativa: JUST });
  assert.equal((await n.apurarCompetencia(c, { competencia: "2026-11" })).pendencias.some((x) => x.tipo === "REPASSE_99FOOD_EM_CONFERENCIA"), false);
  assert.equal((await area(n)).situacao, "AGUARDANDO_CONFERENCIA");
  assert.ok(!(await diaDe(n)).estados.includes("CONCILIADO"));
});

test("repasse informado não vira recebível, crédito, venda nem baixa", async () => {
  const n = novo();
  await aplicar(n, (await importar(n, [D1, D2])).imp);
  for (const tipo of ["RECEBIVEL", "MOVIMENTACAO", "LIQUIDACAO", "VENDA"]) assert.equal((await n.consultarRegistros(c, { tipo })).length, 0, tipo);
  const d = await diaDe(n);
  assert.ok(d.pendencias.some((x) => x.codigo === "REPASSE_SEM_CICLO"));
  assert.equal(d.noventaOficial.repasseCentavos, 7000);
});

test("identidade: sem vínculo administrativo nada é aplicado; ID errado, sem permissão ou outra loja são recusados", async () => {
  const n = novo();
  await configurar(n);
  const { imp } = await importar(n, [D1]);
  const p = await previa(n, imp);
  assert.ok(p.bloqueios.some((x) => x.codigo === "LOJA_NAO_VINCULADA"));
  await rejeita(aplicarDireto(n, imp), CODIGO.OPERACAO_INVALIDA);
  await rejeita(n.vincularLoja99Food(c, { importacaoId: imp.id, lojaId: "999", justificativa: JUST }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.vincularLoja99Food(ctx(undefined, undefined, ["financeiro_v2.ver"]), { importacaoId: imp.id, lojaId: LOJA, justificativa: JUST }), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await ESCRITAS["/importacao/99food/vincular-loja"].fazer(n, c, { importacao: imp.id, lojaId: LOJA, justificativa: JUST });
  assert.deepEqual([r.identidade.id, r.identidade.nome, r.identidade.por, r.identidade.importacaoId, r.identidade.justificativa], [LOJA, "Loja Sintética", c.usuarioId, imp.id, JUST]);
  assert.equal((await n.vincularLoja99Food(c, { importacaoId: imp.id, lojaId: LOJA, justificativa: JUST })).repetido, true);
  await aplicarDireto(n, imp);
  const outra = await importar(n, [linha("2026-11-05", { loja: "2000000000000000002", nome: "Outra Loja" })]);
  assert.ok((await previa(n, outra.imp)).bloqueios.some((x) => x.codigo === "LOJA_DIFERENTE"));
  await rejeita(aplicarDireto(n, outra.imp), CODIGO.OPERACAO_INVALIDA);
  await rejeita(n.vincularLoja99Food(c, { importacaoId: outra.imp.id, lojaId: "2000000000000000002", justificativa: JUST }), CODIGO.OPERACAO_INVALIDA);
});

test("reenvio e reaplicação não duplicam; relatório novo acrescenta só as datas novas", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  await aplicar(n, imp);
  const antes = (await ativos(n)).map((l) => l.id).sort();
  assert.equal((await aplicarDireto(n, imp)).repetido, true);
  assert.equal((await receber(n, [D1, D2])).repetido, true);
  assert.deepEqual((await ativos(n)).map((l) => l.id).sort(), antes);
  const D3 = linha("2026-11-03");
  const seg = await importar(n, [D1, D2, D3]);
  assert.deepEqual([seg.relatorio.inseridos, seg.relatorio.jaImportados, seg.relatorio.conflitosNaoGravados], [1, 2, 0]);
  await aplicarDireto(n, seg.imp);
  assert.equal(soma(await ativos(n), "VENDAS"), 25050);
});

const corrigido = linha("2026-11-01", { itens: "120,00", medio: "60,00" });
test("dia corrigido por outra importação não é ignorado: bloqueia em qualquer importação até a decisão", async () => {
  const n = novo();
  const a = await importar(n, [D1, D2]);
  await aplicar(n, a.imp);
  const novoDia = linha("2026-11-03");
  const b = await importar(n, [corrigido, D2, novoDia]);
  assert.deepEqual([b.previa.contagens.novos, b.previa.contagens.jaImportados, b.previa.contagens.conflitos], [1, 1, 1], "distingue novos, iguais e corrigidos");
  for (const imp of [a.imp, b.imp]) {
    const p = await previa(n, imp);
    assert.ok(p.bloqueios.some((x) => x.codigo === "DADOS_CORRIGIDOS_SEM_DECISAO"));
    assert.deepEqual([p.correcoesPendentes[0].data, p.correcoesPendentes[0].vigente.itensCentavos, p.correcoesPendentes[0].informado.itensCentavos], ["2026-11-01", 10000, 12000]);
    await rejeita(aplicarDireto(n, imp), CODIGO.OPERACAO_INVALIDA);
  }
  assert.equal(soma(await ativos(n), "VENDAS"), 15050, "nada mudou nem somou");
  await n.decidirCorrecao99Food(c, { importacaoId: b.imp.id, data: "2026-11-01", decisao: "ADOTAR", justificativa: JUST });
  await aplicarDireto(n, a.imp);
  assert.equal(soma(await ativos(n), "VENDAS"), 27050, "correção e dia novo entram uma vez");
  assert.equal((await aplicarDireto(n, b.imp)).repetido, true);
  const v = await CONSULTAS["/versoes-relatorio-99food"](n, c, { data: "2026-11-01" });
  assert.deepEqual(v.versoes.map((x) => [x.situacao, x.valores.itensCentavos]).sort(), [["ATIVO", 12000], ["SUBSTITUIDO", 10000]]);
  const vendas = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.relatorio99Food?.dia === "2026-11-01" && l.relatorio99Food.componente === "VENDAS");
  assert.deepEqual(vendas.map((l) => [l.relatorio99Food.versao, l.situacao]).sort(), [[1, "CANCELADO"], [2, "ATIVO"]]);
});

test("manter a versão efetiva registra a decisão e libera a aplicação sem mudar o dia", async () => {
  const n = novo();
  const a = await importar(n, [D1]);
  await aplicar(n, a.imp);
  const b = await importar(n, [corrigido]);
  await rejeita(n.decidirCorrecao99Food(c, { importacaoId: b.imp.id, data: "2026-11-09", decisao: "MANTER", justificativa: JUST }), CODIGO.NAO_ENCONTRADO);
  await n.decidirCorrecao99Food(c, { importacaoId: b.imp.id, data: "2026-11-01", decisao: "MANTER", justificativa: JUST });
  const p = await previa(n, b.imp);
  assert.deepEqual([p.correcoesPendentes.length, p.podeAplicar], [0, true]);
  assert.equal((await aplicarDireto(n, b.imp)).repetido, true);
  assert.equal(soma(await ativos(n), "VENDAS"), 10000);
  const [config] = await n.consultarRegistros(c, { tipo: "CONFIGURACAO_UNIDADE" });
  assert.deepEqual([config.correcoes99FoodDescartadas[0].data, config.correcoes99FoodDescartadas[0].por], ["2026-11-01", c.usuarioId]);
});

test("versão corrigida completa troca o dia; versão parcial é recusada sem apagar dias válidos", async () => {
  const n = novo();
  const a = await importar(n, [D1, D2]);
  await aplicar(n, a.imp);
  const parcial = await receber(n, [corrigido], { substitui: a.imp.id });
  await rejeita(n.confirmarImportacao(c, { importacaoId: parcial.importacao.id, impressaoPrevia: parcial.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST }), CODIGO.IMPORTACAO_INVALIDA);
  assert.equal((await diaDe(n, "2026-11-02")).noventaOficial.itensCentavos, 5050, "o dia ausente continua valendo");
  assert.equal(soma(await ativos(n), "VENDAS"), 15050);
  const completa = await importar(n, [corrigido, D2], { substitui: a.imp.id });
  await aplicarDireto(n, completa.imp);
  assert.equal(soma(await ativos(n), "VENDAS"), 17050);
});

test("competência homologada: correção é recusada e reaplicar sem mudança não altera nada", async () => {
  const m = montar({ relogio: () => new Date("2026-12-20T15:00:00.000Z") }).nucleo;
  const b = await importar(m, [D1, D2]);
  await aplicar(m, b.imp);
  await prepararHomologacao(m, c, "2026-11");
  await m.alterarEstadoDaCompetencia(c, { competencia: "2026-11", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  assert.equal((await aplicarDireto(m, b.imp)).repetido, true);
  const r = await receber(m, [corrigido, D2], { substitui: b.imp.id });
  await rejeita(m.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST }), CODIGO.COMPETENCIA_HOMOLOGADA);
  assert.equal(soma(await ativos(m), "VENDAS"), 15050);
});

const saipos = async (n, pedidos, fim = "2026-11-03") => {
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo: saiposVendas(pedidos), periodoInicio: "2026-11-01", periodoFim: fim });
  return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST })).importacao;
};
const ped = (pedido, itens, data = "01/11/2026 12:00", canal = "99Food") => ({ pedido, data, canal, forma: "Online", itens, total: itens });

test("calendário: dias do arquivo preenchidos, demais sem registro, importado nunca vira conciliado", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  assert.equal((await diaDe(n)).noventaOficial.situacaoConferencia, "IMPORTADO");
  await aplicar(n, imp);
  const cal = await n.consultarCalendarioDeFaturamento(c, { canal: "NOVENTA_E_NOVE_FOOD", mes: "2026-11" });
  assert.deepEqual([cal.granularidadeDiaria, cal.semFonteOficial, cal.dias.filter((d) => d.noventaOficial).length], [true, false, 2]);
  const d = cal.dias.find((x) => x.data === "2026-11-01");
  assert.deepEqual([d.noventaOficial.quantidade, d.noventaOficial.itensCentavos, d.noventaOficial.comissaoCentavos, d.noventaOficial.processamentoCentavos, d.noventaOficial.marketingCentavos, d.noventaOficial.recompensasCentavos, d.noventaOficial.repasseCentavos, d.noventaOficial.diferencaRepasseCentavos], [2, 10000, 1000, 200, 500, 3000, 7000, 1300]);
  assert.deepEqual([d.estados.includes("IMPORTADO"), d.estados.includes("DIVERGENCIA"), d.estados.includes("CONCILIADO")], [true, true, false]);
  const fora = cal.dias.find((x) => x.data === "2026-11-05");
  assert.equal(fora.noventaOficial, undefined);
  assert.ok(fora.estados.includes("SEM_REGISTRO") || fora.antesDoControle);
  await rejeita(n.registrarDiaSemOperacao(c, { canal: "NOVENTA_E_NOVE_FOOD", data: "2026-11-01", situacao: "SEM_OPERACAO", justificativa: JUST }), CODIGO.OPERACAO_INVALIDA);
});

test("SAIPOS só confere por dia: compara itens e quantidade, aponta dia só na SAIPOS e não cria venda", async () => {
  const n = novo();
  await saipos(n, [ped("1", 6000), ped("2", 4000), ped("3", 5000, "02/11/2026 12:00"), ped("4", 3000, "03/11/2026 12:00")]);
  const F4 = linha("2026-11-04", { repasse: "83,00" });
  const { imp } = await importar(n, [F1, F2, F4]);
  await vincular(n, imp);
  const p = await previa(n, imp);
  assert.deepEqual([p.conferenciaSaipos.diasSoNaSaipos, p.conferenciaSaipos.diasSemSaipos], [["2026-11-03"], ["2026-11-04"]]);
  await aplicarDireto(n, imp);
  const igual = await diaDe(n);
  assert.deepEqual([igual.noventaOficial.saipos.diferencaPedidos, igual.noventaOficial.saipos.diferencaItensCentavos, igual.noventaOficial.situacaoConferencia], [0, 0, "AGUARDANDO_CONFERENCIA"]);
  const dif = await diaDe(n, "2026-11-02");
  assert.deepEqual([dif.noventaOficial.saipos.diferencaItensCentavos, dif.noventaOficial.situacaoConferencia, dif.estados.includes("DIVERGENCIA")], [-50, "DIVERGENTE", true]);
  assert.ok((await diaDe(n, "2026-11-03")).pendencias.some((x) => x.codigo === "PEDIDOS_99FOOD_SO_NA_SAIPOS"));
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, 0);
});

test("sequências SAIPOS → 99Food e 99Food → SAIPOS não duplicam o faturamento", async () => {
  const pedidos = [ped("1", 6000), ped("2", 4000), ped("5", 2500, "01/11/2026 13:00", "Balcão")];
  const antes = novo();
  const s1 = await saipos(antes, pedidos);
  await antes.gerarPropostas(c, { importacaoId: s1.id });
  assert.equal((await antes.listarPropostas(c, {})).filter((x) => x.comando?.canal === "NOVENTA_E_NOVE_FOOD").length, 0);
  await aplicar(antes, (await importar(antes, [F1])).imp);
  assert.equal(await fat99(antes), 10000);

  const depois = novo();
  await aplicar(depois, (await importar(depois, [F1])).imp);
  const s2 = await saipos(depois, pedidos);
  await depois.gerarPropostas(c, { importacaoId: s2.id });
  assert.equal((await depois.listarPropostas(c, {})).filter((x) => x.comando?.canal === "NOVENTA_E_NOVE_FOOD").length, 0);
  assert.equal(await fat99(depois), 10000);
  assert.equal((await depois.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.canal === "NOVENTA_E_NOVE_FOOD").length, 0);
});

test("proposta antiga da SAIPOS para a 99Food é recusada antes e depois do relatório; outros canais seguem normais", { skip: EM_POSTGRES ? "ajuste direto do cenário só em memória" : false }, async () => {
  const m = montar({ relogio: () => AGORA });
  const n = m.nucleo;
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const s = await saipos(n, [{ pedido: "7", data: "01/11/2026 12:00", canal: "Balcão", forma: "Dinheiro", itens: 1000, total: 1000 }, { pedido: "8", data: "01/11/2026 13:00", canal: "Balcão", forma: "Dinheiro", itens: 2000, total: 2000 }]);
  await n.gerarPropostas(c, { importacaoId: s.id, contaCaixaId: caixa.id });
  const [antiga, legitima] = await n.listarPropostas(c, { operacao: "VENDA" });
  for (const p of [antiga, legitima]) await n.aprovarProposta(c, { propostaId: p.id, justificativa: JUST });
  await m.repositorio.transacao(async (tx) => { const p = await tx.obter(c, "PROPOSTA", antiga.id); await tx.atualizar("PROPOSTA", { ...p, comando: { ...p.comando, canal: "NOVENTA_E_NOVE_FOOD" }, versao: p.versao + 1 }, p.versao); });
  await rejeita(n.aplicarProposta(c, { propostaId: antiga.id }), CODIGO.OPERACAO_INVALIDA);
  await aplicar(n, (await importar(n, [F1])).imp);
  await rejeita(n.aplicarProposta(c, { propostaId: antiga.id }), CODIGO.OPERACAO_INVALIDA);
  await n.aplicarProposta(c, { propostaId: legitima.id });
  assert.equal(await fat99(n), 10000);
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.situacao === "ATIVA").length, 1, "a venda legítima de outro canal entra");
});

test("venda 99Food já registrada no dia bloqueia a aplicação", async () => {
  const n = novo();
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  await n.registrarVenda(c, { canal: "NOVENTA_E_NOVE_FOOD", dataVenda: "2026-11-01", brutoCentavos: 1000, fonte: { sistema: "MANUAL", idExterno: "M-1" }, pagamentos: [{ valorCentavos: 1000, forma: "DINHEIRO", contaId: caixa.id }] });
  const { imp } = await importar(n, [D1]);
  assert.ok((await previa(n, imp)).bloqueios.some((x) => x.codigo === "VENDAS_99FOOD_APLICADAS"));
  await vincular(n, imp);
  await rejeita(aplicarDireto(n, imp), CODIGO.OPERACAO_INVALIDA);
});

test("área da 99Food: totais só do que foi aplicado, campos ausentes como não informados e histórico no canal certo", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  const antes = await area(n);
  assert.deepEqual([antes.situacao, antes.totais, antes.dependeDeRelatorioOficial], ["IMPORTADO", null, false]);
  await aplicar(n, imp);
  const r = await area(n);
  const t = r.totais;
  assert.deepEqual([r.situacao, t.brutoCentavos, t.taxasCentavos, t.comissoesCentavos, t.marketingCentavos, t.resultadoPreliminarCentavos, t.recompensasCentavos, t.repassePrevistoCentavos, t.repasseRecebidoCentavos, t.pedidos, t.diasDivergentes], ["DIVERGENTE", 15050, 300, 1500, 500, 12750, 4000, 11000, 0, 3, 2]);
  assert.deepEqual([t.mensalidadesCentavos, t.descontosEPromocoesCentavos, t.ajustesCentavos], [null, null, null]);
  const canal = await n.consultarImportacoesDoCanal(c, { canal: "NOVENTA_E_NOVE_FOOD" });
  assert.deepEqual([canal.algumFormatoDisponivel, canal.historico.length, canal.historico[0].relatorio], [true, 1, "Relatório oficial da 99Food"]);
});

test("isolamento e permissão: outra unidade não vê nada e quem só consulta não aplica", async () => {
  const n = novo();
  const { imp } = await importar(n, [D1, D2]);
  await vincular(n, imp);
  await rejeita(aplicarDireto(n, imp, ctx(undefined, undefined, ["financeiro_v2.ver"])), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await ESCRITAS["/importacao/99food/aplicar"].fazer(n, c, { importacao: imp.id, justificativa: JUST, aceitarDiferencaDeRepasse: "on" });
  assert.equal(r.lancamentos.criar, 7);
  for (const outra of [ctx(ORG_A, UNI_A2), ctx(ORG_B, UNI_B)]) {
    assert.equal((await ativos(n, outra)).length, 0);
    await rejeita(CONSULTAS["/previa-relatorio-99food"](n, outra, { importacao: imp.id }), CODIGO.NAO_ENCONTRADO);
    await rejeita(aplicarDireto(n, imp, outra), CODIGO.NAO_ENCONTRADO);
    await rejeita(n.vincularLoja99Food(outra, { importacaoId: imp.id, lojaId: LOJA, justificativa: JUST }), CODIGO.NAO_ENCONTRADO);
  }
});
