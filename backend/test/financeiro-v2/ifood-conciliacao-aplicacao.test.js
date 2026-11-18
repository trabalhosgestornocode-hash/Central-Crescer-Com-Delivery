// Aplicação do Relatório de Conciliação do iFood: DRE, calendário, repasses, idempotência e isolamento. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_B, UNI_A2, UNI_B, ORG_A, ctx, montar, rejeita } from "./helpers/cenario.js";
import { saiposVendas, texto } from "./helpers/arquivos.js";

const c = ctx();
const AGORA = new Date("2026-11-18T15:00:00.000Z");
const NOV = "2026-11";
const JUST = "Conferido com o relatório sintético.";
const COLUNAS = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const P1 = "a1a1a1a1-0000-4000-8000-000000000001";
const P2 = "a2a2a2a2-0000-4000-8000-000000000002";
const P3 = "a3a3a3a3-0000-4000-8000-000000000003";

function linha(o) {
  const dia = o.dia ?? "2026-11-03";
  const v = { competencia: NOV, fato_gerador: o.fato ?? "Venda", tipo_lancamento: o.tipo ?? "Cobrança", descricao_lancamento: o.desc, valor: o.valor, base_calculo: 0, percentual_taxa: 0, pedido_associado_ifood: o.pedido ?? "", pedido_associado_ifood_curto: o.pedido ? o.pedido.slice(0, 4) : "", motivo_cancelamento: "", data_criacao_pedido_associado: o.pedido ? `${dia}T12:00:00.000Z` : "", data_repasse_esperada: o.repasse ?? "2026-12-02", valor_transacao: o.saldo, loja_id: "LOJA-SINTETICA", cnpj: "00000000000000", data_faturamento: `${dia}T12:30:00.000Z`, data_apuracao_inicio: o.ini ?? "2026-11-02", data_apuracao_fim: o.fim ?? "2026-11-08", valor_cesta_final: o.cesta ?? 0, responsavel_transacao: "IFOOD", impacto_no_repasse: o.impacto ?? "SIM", id_saldo: o.idSaldo ?? "S1", metodo_pagamento: o.metodo ?? "Pix" };
  return COLUNAS.map((k) => v[k]).join(";");
}
const arquivo = (linhas) => texto([COLUNAS.join(";"), ...linhas].join(String.fromCharCode(10)));

// P1: itens 50 + entrega 7 + taxa do cliente 1 − loja 5 − iFood 4 = cliente pagou 49. Repasse = 49 + 4 − 1 − 8 − 2,50 = 41,50.
const pedido1 = (saldo = 41.5) => [
  linha({ pedido: P1, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 49, cesta: 50, saldo }),
  linha({ pedido: P1, tipo: "Subsídio", desc: "Promoção custeada pela loja", valor: -5, cesta: 50, impacto: "NÃO", saldo }),
  linha({ pedido: P1, tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: 4, cesta: 50, saldo }),
  linha({ pedido: P1, tipo: "Retenção", desc: "Taxa de serviço iFood cobrada do cliente", valor: -1, cesta: 50, saldo }),
  linha({ pedido: P1, desc: "Comissão do iFood (entrega própria da loja)", valor: -8, cesta: 50, saldo }),
  linha({ pedido: P1, desc: "Taxa de transação", valor: -2.5, cesta: 50, saldo }),
];
// P2: pago direto à loja (dinheiro): 30 de produtos, fora do repasse; a comissão sai do repasse.
const pedido2 = [
  linha({ pedido: P2, dia: "2026-11-04", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 30, cesta: 30, impacto: "NÃO", metodo: "Dinheiro", idSaldo: "S2", saldo: -13.6 }),
  linha({ pedido: P2, dia: "2026-11-04", desc: "Comissão do iFood (entrega própria da loja)", valor: -3.6, cesta: 30, idSaldo: "S2", saldo: -13.6 }),
  linha({ dia: "2026-11-04", fato: "Ocorrência Avulsa", tipo: "Ocorrência", desc: "ocorrência de débito para contratação do pacote de anúncios por parte do parceiro.", valor: -10, idSaldo: "S2", saldo: -13.6 }),
];
const base = () => [...pedido1(), ...pedido2];

async function importar(n, linhas, { contexto = c, fim = "2026-11-17", substitui } = {}) {
  const r = await n.receberArquivoParaImportacao(contexto, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo: arquivo(linhas), periodoInicio: "2026-11-01", periodoFim: fim, ...(substitui ? { substituiImportacaoId: substitui } : {}) });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const conf = await n.confirmarImportacao(contexto, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  return { imp: conf.importacao, previa: r.previa, relatorio: conf.relatorio };
}
const novo = () => montar({ relogio: () => AGORA }).nucleo;
const aplicar = (n, imp, contexto = c) => n.aplicarConciliacaoIfood(contexto, { importacaoId: imp.id, justificativa: JUST });
const ativos = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "LANCAMENTO" })).filter((l) => l.conciliacaoIfood && l.situacao === "ATIVO");
const valorDe = (lista, comp) => lista.filter((l) => l.conciliacaoIfood.componente === comp).reduce((s, l) => s + l.valorCentavos, 0);
const repasses = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "RECEBIVEL" })).filter((r) => r.situacao !== "CANCELADA");

test("prévia não grava; aplicação separa produtos e entregas e preserva cada despesa na sua categoria", async () => {
  const n = novo();
  const { imp, relatorio } = await importar(n, base());
  assert.equal(relatorio.inseridos, 9, "todas as linhas ficam preservadas");
  assert.equal((await ativos(n)).length, 0, "importar não lança");
  const p = await n.previaDaConciliacaoIfood(c, { importacaoId: imp.id });
  assert.deepEqual([p.podeAplicar, p.lancamentos.criar, p.repasses.criar], [true, 8, 1]);
  assert.deepEqual([p.valores.produtosCentavos, p.valores.entregasCentavos, p.valores.faturamentoCentavos, p.valores.liquidoCentavos], [8000, 700, 8700, 5790]);
  assert.equal((await ativos(n)).length, 0, "a prévia não grava");
  await aplicar(n, imp);
  const l = await ativos(n);
  assert.deepEqual(["PRODUTOS", "ENTREGAS", "PROMOCOES_LOJA", "COMISSOES", "TAXA_TRANSACAO", "ANUNCIOS"].map((k) => valorDe(l, k)), [8000, 700, 500, 1160, 250, 1000]);
  const cat = (k) => l.find((x) => x.conciliacaoIfood.componente === k).categoria;
  assert.deepEqual([cat("PRODUTOS"), cat("ENTREGAS"), cat("PROMOCOES_LOJA"), cat("COMISSOES"), cat("TAXA_TRANSACAO"), cat("ANUNCIOS")], ["VENDA_IFOOD", "ENTREGAS_IFOOD", "PROMOCOES_SUBSIDIADAS", "COMISSOES_IFOOD", "TAXAS_DE_PROCESSAMENTO", "ANUNCIOS_IFOOD"]);
  assert.ok(l.every((x) => x.origem.tipo === "IMPORTACAO" && x.origem.id === imp.id && x.canal === "IFOOD"), "cada lançamento aponta para a importação");
  const mov = await CONSULTAS["/movimentos-conciliacao-ifood"](n, c, { data: "2026-11-03" });
  assert.equal(mov.length, 6, "o dia abre nas linhas originais do relatório");
});

test("DRE: faturamento discriminado, resultado igual ao líquido e pagamento direto sem receita adicional", async () => {
  const n = novo();
  const { imp } = await importar(n, base());
  await aplicar(n, imp);
  const a = await n.apurarCompetencia(c, { competencia: NOV });
  const fat = a.indicadores.FATURAMENTO_BRUTO_PROPRIO;
  assert.equal(fat.valorCentavos, 8700, "os R$ 30,00 pagos direto à loja já estão nos produtos");
  assert.equal(fat.porCanal.find((x) => x.canal === "IFOOD").valorCentavos, 8700);
  const nomes = JSON.stringify(a.dre ?? a.indicadores);
  assert.match(nomes, /Vendas pelo iFood/);
  assert.match(nomes, /Entregas da loja pelo iFood/);
  assert.equal(a.indicadores.RESULTADO_GERENCIAL.valorCentavos, 5790);
});

test("repasse é previsão por ciclo; pagamento direto não vira recebível nem movimentação", async () => {
  const n = novo();
  const linhas = [...pedido1(), linha({ pedido: P3, dia: "2026-11-10", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 20, cesta: 20, ini: "2026-11-09", fim: "2026-11-15", repasse: "2026-12-09", idSaldo: "S3", saldo: 20 })];
  const { imp } = await importar(n, linhas);
  await aplicar(n, imp);
  const r = (await repasses(n)).sort((a, x) => a.dataPrevista.localeCompare(x.dataPrevista));
  assert.deepEqual(r.map((x) => [x.dataPrevista, x.saldoCentavos, x.liquidadoCentavos, x.processador]), [["2026-12-02", 4150, 0, "IFOOD"], ["2026-12-09", 2000, 0, "IFOOD"]]);
  assert.equal((await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 0, "data prevista não é recebimento");
  const { nucleo: m } = montar({ relogio: () => AGORA });
  const so = await importar(m, pedido2);
  const prev = await m.previaDaConciliacaoIfood(c, { importacaoId: so.imp.id });
  assert.equal(prev.valores.recebidoDiretoCentavos, 3000);
  await aplicar(m, so.imp);
  assert.equal((await repasses(m)).length, 0, "ciclo só com débito não gera valor a receber");
});

test("aplicar de novo e reenviar o mesmo arquivo não duplicam nada", async () => {
  const n = novo();
  const { imp } = await importar(n, base());
  await aplicar(n, imp);
  const antes = (await ativos(n)).map((l) => l.id).sort();
  const r = await aplicar(n, imp);
  assert.equal(r.repetido, true);
  assert.deepEqual((await ativos(n)).map((l) => l.id).sort(), antes);
  const reenvio = await n.receberArquivoParaImportacao(c, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo: arquivo(base()), periodoInicio: "2026-11-01", periodoFim: "2026-11-17" });
  assert.equal(reenvio.repetido, true);
  assert.equal((await repasses(n)).length, 1);
});

test("relatório complementar: só o novo entra, o dia que mudou ganha nova versão e o anterior fica cancelado", async () => {
  const n = novo();
  const { imp } = await importar(n, pedido1());
  await aplicar(n, imp);
  const extra = linha({ pedido: P3, dia: "2026-11-05", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 20, cesta: 20, saldo: 61.5 });
  const seg = await importar(n, [...pedido1(61.5), extra]);
  assert.deepEqual([seg.relatorio.inseridos, seg.relatorio.jaImportados, seg.relatorio.conflitosNaoGravados], [1, 6, 0], "o saldo do ciclo aberto mudou e isso não é conflito");
  await aplicar(n, seg.imp);
  assert.equal(valorDe(await ativos(n), "PRODUTOS"), 7000);
  const r = await repasses(n);
  assert.deepEqual(r.map((x) => x.saldoCentavos), [6150], "o repasse do ciclo é atualizado, sem somar duas vezes");
  const todos = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" }));
  assert.deepEqual(todos.map((x) => x.situacao).sort(), ["ABERTA", "CANCELADA"].sort());
});

test("calendário: dia importado tem valores próprios; dia fora do arquivo fica sem registro; diferença com a SAIPOS fica pendente", async () => {
  const n = novo();
  const s = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo: saiposVendas([{ pedido: "1", data: "03/11/2026 12:00", canal: "iFood", forma: "Online", itens: 4800, total: 4800, parceiro: P1 }]), periodoInicio: "2026-11-03", periodoFim: "2026-11-03" });
  await n.confirmarImportacao(c, { importacaoId: s.importacao.id, impressaoPrevia: s.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  const { imp } = await importar(n, base());
  const antes = await n.consultarCalendarioDeFaturamento(c, { canal: "IFOOD", mes: NOV });
  assert.ok(antes.dias.find((d) => d.data === "2026-11-03").pendencias.some((p) => p.codigo === "CONCILIACAO_NAO_APLICADA"));
  await aplicar(n, imp);
  const cal = await n.consultarCalendarioDeFaturamento(c, { canal: "IFOOD", mes: NOV });
  assert.equal(cal.granularidadeDiaria, true);
  const dia = cal.dias.find((d) => d.data === "2026-11-03");
  assert.deepEqual([dia.ifoodOficial.pedidos, dia.ifoodOficial.faturamentoCentavos, dia.ifoodOficial.produtosCentavos, dia.ifoodOficial.entregasCentavos, dia.ifoodOficial.comissoesCentavos, dia.ifoodOficial.taxasCentavos, dia.ifoodOficial.liquidoCentavos], [1, 5700, 5000, 700, 800, 250, 4150]);
  assert.ok(dia.estados.includes("IMPORTADO"));
  assert.ok(dia.estados.includes("DIVERGENCIA"), "SAIPOS 48,00 × produtos 50,00");
  assert.equal(dia.divergencias.find((x) => x.codigo === "DIFERENCA_SAIPOS_IFOOD").diferencaCentavos, -200);
  assert.ok(dia.pendencias.some((p) => p.codigo === "REPASSE_PREVISTO"), "repasse continua previsto");
  assert.ok(!dia.estados.includes("CONCILIADO"));
  const vazio = cal.dias.find((d) => d.data === "2026-11-06");
  assert.equal(vazio.ifoodOficial, undefined);
  assert.ok(vazio.estados.includes("SEM_REGISTRO") || vazio.antesDoControle, "mês parcial não aparece como completo");
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, 0, "nenhuma venda criada a partir da SAIPOS");
  await rejeita(n.registrarDiaSemOperacao(c, { canal: "IFOOD", data: "2026-11-03", situacao: "SEM_OPERACAO", justificativa: JUST }), CODIGO.OPERACAO_INVALIDA);
});

test("uma fonte por canal: venda iFood ou demonstrativo no período bloqueiam, e o demonstrativo não entra depois", async () => {
  const n = novo();
  const dem = { periodoInicio: "2026-11-01", periodoFim: "2026-11-08", vendas: "100,00", comissoes: "0,00", taxaPagamento: "0,00", mensalidade: "0,00", servicosEPromocoes: "0,00", ajustes: "0,00", liquido: "100,00", origem: "Sintético", justificativa: JUST };
  await ESCRITAS["/vendas/demonstrativo-ifood"].fazer(n, c, dem);
  const { imp } = await importar(n, base());
  const p = await n.previaDaConciliacaoIfood(c, { importacaoId: imp.id });
  assert.equal(p.podeAplicar, false);
  assert.ok(p.bloqueios.some((b) => b.codigo === "DEMONSTRATIVO_NO_PERIODO"));
  await rejeita(aplicar(n, imp), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await ativos(n)).length, 0, "a recusa não deixa nada pela metade");

  const m = novo();
  const seg = await importar(m, base());
  await aplicar(m, seg.imp);
  await rejeita(ESCRITAS["/vendas/demonstrativo-ifood"].fazer(m, c, dem), CODIGO.CONFLITO_IDEMPOTENCIA);
});

test("isolamento: outra unidade e outra empresa não veem nem recebem os lançamentos", async () => {
  const n = novo();
  const irma = ctx(ORG_A, UNI_A2);
  const fora = ctx(ORG_B, UNI_B);
  const { imp } = await importar(n, base());
  await aplicar(n, imp);
  assert.equal((await ativos(n, irma)).length, 0);
  assert.equal((await ativos(n, fora)).length, 0);
  assert.equal((await repasses(n, irma)).length, 0);
  await rejeita(n.previaDaConciliacaoIfood(irma, { importacaoId: imp.id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(aplicar(n, imp, fora), CODIGO.NAO_ENCONTRADO);
  const cal = await n.consultarCalendarioDeFaturamento(irma, { canal: "IFOOD", mes: NOV });
  assert.ok(cal.dias.every((d) => !d.ifoodOficial));
});

test("permissão: quem só vê não aplica; rota de escrita e de prévia usam o mesmo núcleo", async () => {
  const n = novo();
  const { imp } = await importar(n, base());
  await rejeita(aplicar(n, imp, ctx(undefined, undefined, ["financeiro_v2.ver"])), CODIGO.PERMISSAO_INSUFICIENTE);
  const p = await CONSULTAS["/previa-conciliacao-ifood"](n, c, { importacao: imp.id });
  assert.equal(p.podeAplicar, true);
  const r = await ESCRITAS["/importacao/ifood-conciliacao/aplicar"].fazer(n, c, { importacao: imp.id, justificativa: JUST });
  assert.equal(r.lancamentos.criar, 8);
});
