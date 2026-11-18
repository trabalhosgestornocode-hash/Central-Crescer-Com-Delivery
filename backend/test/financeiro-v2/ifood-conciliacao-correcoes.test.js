// Conciliação do iFood: cancelamentos posteriores, lançamentos desconhecidos, ciclos corrigidos, estados e extrato. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, UNI_A2, ctx, montar, prepararHomologacao, rejeita } from "./helpers/cenario.js";
import { saiposVendas, texto } from "./helpers/arquivos.js";

const c = ctx();
const AGORA = new Date("2026-12-20T15:00:00.000Z");
const JUST = "Conferido com o relatório sintético.";
const COLUNAS = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const P1 = "a1a1a1a1-0000-4000-8000-000000000001";
const P2 = "a2a2a2a2-0000-4000-8000-000000000002";
const C1 = { ini: "2026-11-02", fim: "2026-11-08", repasse: "2026-12-02" };
const C2 = { ini: "2026-11-09", fim: "2026-11-15", repasse: "2026-12-09" };

function linha(o) {
  const dia = o.dia ?? "2026-11-03";
  const fat = o.fat ?? dia;
  const v = { competencia: fat.slice(0, 7), fato_gerador: o.fato ?? "Venda", tipo_lancamento: o.tipo ?? "Cobrança", descricao_lancamento: o.desc, valor: o.valor, base_calculo: 0, percentual_taxa: 0, pedido_associado_ifood: o.pedido ?? "", pedido_associado_ifood_curto: o.pedido ? o.pedido.slice(0, 4) : "", motivo_cancelamento: "", data_criacao_pedido_associado: o.pedido ? `${dia}T12:00:00.000Z` : "", data_repasse_esperada: o.repasse ?? C1.repasse, valor_transacao: o.saldo, loja_id: "LOJA-SINTETICA", cnpj: "00000000000000", data_faturamento: `${fat}T12:30:00.000Z`, data_apuracao_inicio: o.ini ?? C1.ini, data_apuracao_fim: o.fim ?? C1.fim, valor_cesta_final: o.cesta ?? 0, responsavel_transacao: "IFOOD", impacto_no_repasse: o.impacto ?? "SIM", id_saldo: o.idSaldo ?? "S1", metodo_pagamento: "Pix" };
  return COLUNAS.map((k) => v[k]).join(";");
}
const arquivo = (linhas) => texto([COLUNAS.join(";"), ...linhas].join(String.fromCharCode(10)));

// Itens 50 + entrega 7 + taxa do cliente 1 − loja 5 − iFood 4 = cliente pagou 49. Repasse = 41,50.
const venda = ({ pedido = P1, dia = "2026-11-03", ciclo = C1, idSaldo = "S1", saldo = 41.5 } = {}) => {
  const o = { pedido, dia, cesta: 50, idSaldo, saldo, ...ciclo };
  return [
    linha({ ...o, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 49 }),
    linha({ ...o, tipo: "Subsídio", desc: "Promoção custeada pela loja", valor: -5, impacto: "NÃO" }),
    linha({ ...o, tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: 4 }),
    linha({ ...o, tipo: "Retenção", desc: "Taxa de serviço iFood cobrada do cliente", valor: -1 }),
    linha({ ...o, desc: "Comissão do iFood (entrega própria da loja)", valor: -8 }),
    linha({ ...o, desc: "Taxa de transação", valor: -2.5 }),
  ];
};
const cancelamento = ({ pedido = P1, dia = "2026-11-03", fat = "2026-11-05", ciclo = C1, idSaldo = "S9", saldo = -41.5 } = {}) => {
  const o = { pedido, dia, fat, cesta: 50, idSaldo, saldo, fato: "Cancelamento Total", ...ciclo };
  return [
    linha({ ...o, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: -49 }),
    linha({ ...o, tipo: "Subsídio", desc: "Promoção custeada pela loja", valor: 5, impacto: "NÃO" }),
    linha({ ...o, tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: -4 }),
    linha({ ...o, tipo: "Retenção", desc: "Taxa de serviço iFood cobrada do cliente", valor: 1 }),
    linha({ ...o, desc: "Comissão do iFood (entrega própria da loja)", valor: 8 }),
    linha({ ...o, desc: "Taxa de transação", valor: 2.5 }),
  ];
};

async function importar(n, linhas, { contexto = c, inicio = "2026-11-01", fim = "2026-11-30", substitui } = {}) {
  const r = await n.receberArquivoParaImportacao(contexto, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo: arquivo(linhas), periodoInicio: inicio, periodoFim: fim, ...(substitui ? { substituiImportacaoId: substitui } : {}) });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  return (await n.confirmarImportacao(contexto, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST })).importacao;
}
const novo = () => montar({ relogio: () => AGORA }).nucleo;
const aplicar = (n, imp, contexto = c) => n.aplicarConciliacaoIfood(contexto, { importacaoId: imp.id, justificativa: JUST });
const previa = (n, imp) => n.previaDaConciliacaoIfood(c, { importacaoId: imp.id });
const lancs = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "LANCAMENTO" })).filter((l) => l.conciliacaoIfood);
const ativos = async (n) => (await lancs(n)).filter((l) => l.situacao === "ATIVO");
const repasses = async (n, contexto = c) => (await n.consultarRegistros(contexto, { tipo: "RECEBIVEL" })).filter((r) => r.situacao !== "CANCELADA");
const banco = (n, contexto = c) => n.configurarContaFinanceira(contexto, { tipo: "BANCARIA", nome: "Banco Sintético" });
const credito = (n, conta, valorCentavos, { data = "2026-12-03", descricao = "Repasse iFood (sintético)", contexto = c } = {}) => n.registrarMovimentacao(contexto, { contaId: conta.id, dataEfetiva: data, sentido: "ENTRADA", valorCentavos, natureza: "RECEBIMENTO", descricao });
const correspondencias = (n, contexto = c) => n.consultarRegistros(contexto, { tipo: "CORRESPONDENCIA" });
const configurar = (n) => ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: JUST });
const receberPeloExtrato = async (n, valor = 4150) => {
  await credito(n, await banco(n), valor);
  await n.gerarCandidatasDeRepasseIfood(c, {});
  const [corr] = await correspondencias(n);
  return n.confirmarConciliacao(c, { correspondenciaId: corr.id, justificativa: JUST });
};

// ------------------------------------------------------------------------------------------- 1. cancelamentos posteriores
test("cancelamento em relatório posterior estorna a venda original, preserva a auditoria e não duplica ao reaplicar", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda()));
  const seg = await importar(n, cancelamento());
  const p = await previa(n, seg);
  assert.equal(p.podeAplicar, true);
  assert.deepEqual([p.valores.produtosCentavos, p.valores.liquidoCentavos, p.pedidosCancelados], [0, 0, 1]);
  await aplicar(n, seg);
  assert.equal((await ativos(n)).length, 0, "a venda deixa de contar");
  assert.ok((await lancs(n)).every((l) => l.situacao === "CANCELADO"), "a versão anterior fica cancelada, nunca apagada");
  assert.equal((await repasses(n)).length, 0, "o repasse previsto zerado sai de contas a receber");
  assert.equal((await n.listarRegistrosImportados(c, { importacaoId: seg.id })).length, 6, "as linhas do estorno continuam guardadas");
  assert.equal((await aplicar(n, seg)).repetido, true);
  assert.equal((await n.apurarCompetencia(c, { competencia: "2026-11" })).indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.find((x) => x.canal === "IFOOD").valorCentavos ?? 0, 0);
});

test("competência fechada não muda sem aviso; relatório que não a altera continua aplicando", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda()));
  await prepararHomologacao(n, c, "2026-11");
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-11", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  const dez = { dia: "2026-12-02", ciclo: { ini: "2026-12-01", fim: "2026-12-07", repasse: "2027-01-05" }, idSaldo: "S5", pedido: P2 };
  const semTocar = await importar(n, venda(dez), { inicio: "2026-12-01", fim: "2026-12-10" });
  assert.equal((await previa(n, semTocar)).podeAplicar, true, "novembro não muda: nada bloqueia");
  await aplicar(n, semTocar);
  const antes = (await ativos(n)).map((l) => l.id).sort();
  const tardio = await importar(n, cancelamento({ fat: "2026-12-05", ciclo: dez.ciclo, idSaldo: "S6" }), { inicio: "2026-12-01", fim: "2026-12-10" });
  const p = await previa(n, tardio);
  assert.ok(p.bloqueios.some((x) => x.codigo === "COMPETENCIA_FECHADA_COM_ALTERACAO" && x.competencia === "2026-11"));
  await rejeita(aplicar(n, tardio), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual((await ativos(n)).map((l) => l.id).sort(), antes, "nada foi alterado");
});

test("cancelamento sem a venda original não vira receita: fica pendente até importar a venda ou classificar", async () => {
  const n = novo();
  await configurar(n);
  const so = await importar(n, cancelamento());
  const p = await previa(n, so);
  assert.equal(p.podeAplicar, false);
  assert.deepEqual([p.valores.produtosCentavos, p.valores.entregasCentavos], [0, 0]);
  const [pend] = p.pendenciasDeClassificacao;
  assert.deepEqual([pend.tipo, pend.valorCentavos], ["PEDIDO_SEM_VENDA_ORIGINAL", -4150]);
  await rejeita(aplicar(n, so), CODIGO.OPERACAO_INVALIDA);
  await importar(n, venda());
  const depois = await previa(n, so);
  assert.deepEqual([depois.podeAplicar, depois.pendenciasDeClassificacao.length, depois.valores.produtosCentavos, depois.pedidosCancelados], [true, 0, 0, 1], "com a venda importada o pedido se resolve sozinho");

  const m = novo();
  await configurar(m);
  const orfao = await importar(m, cancelamento());
  await m.classificarLancamentoIfood(c, { chave: pend.chave, categoria: "DEVOLUCOES_E_ESTORNOS", justificativa: JUST });
  await aplicar(m, orfao);
  const [l] = await ativos(m);
  assert.deepEqual([l.categoria, l.valorCentavos, l.dataOperacao], ["DEVOLUCOES_E_ESTORNOS", 4150, "2026-11-05"]);
});

// ------------------------------------------------------------------------------------------- 2. lançamentos desconhecidos
const comDesconhecido = () => [...venda({ saldo: 31.5 }), linha({ desc: "Mensalidade do plano novo", valor: -10, saldo: 31.5 })];

test("lançamento desconhecido fica visível, bloqueia a aplicação e é preservado", async () => {
  const n = novo();
  const imp = await importar(n, comDesconhecido());
  const p = await previa(n, imp);
  assert.equal(p.podeAplicar, false);
  assert.deepEqual([p.pendenciasDeClassificacao[0].descricao, p.pendenciasDeClassificacao[0].valorCentavos, p.valores.semClassificacaoCentavos], ["Mensalidade do plano novo", -1000, -1000]);
  assert.ok(p.bloqueios.some((x) => x.codigo === "LANCAMENTO_DESCONHECIDO"));
  assert.ok(p.categoriasPermitidas.some((x) => x.codigo === "MENSALIDADE_IFOOD"));
  await rejeita(aplicar(n, imp), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await ativos(n)).length, 0);
  assert.equal((await n.listarRegistrosImportados(c, { importacaoId: imp.id })).length, 7);
});

test("classificação é autorizada, auditável, sem categoria arbitrária, e leva o valor à DRE", async () => {
  const n = novo();
  await configurar(n);
  const imp = await importar(n, comDesconhecido());
  const chave = (await previa(n, imp)).pendenciasDeClassificacao[0].chave;
  const decidir = (categoria, contexto = c) => n.classificarLancamentoIfood(contexto, { chave, categoria, justificativa: JUST });
  await rejeita(decidir("MENSALIDADE_IFOOD", ctx(undefined, undefined, ["financeiro_v2.ver"])), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(decidir("VENDA_IFOOD"), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(decidir("DESPESAS_A_CLASSIFICAR"), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(n.classificarLancamentoIfood(c, { chave: "descricao:inexistente", categoria: "MENSALIDADE_IFOOD", justificativa: JUST }), CODIGO.NAO_ENCONTRADO);
  await decidir("OUTRAS_DESPESAS");
  await decidir("MENSALIDADE_IFOOD");
  const [config] = await n.consultarRegistros(c, { tipo: "CONFIGURACAO_UNIDADE" });
  const [dec] = config.classificacoesIfood;
  assert.deepEqual([dec.categoria, dec.por, dec.anteriores[0].categoria], ["MENSALIDADE_IFOOD", c.usuarioId, "OUTRAS_DESPESAS"]);
  await aplicar(n, imp);
  const l = (await ativos(n)).find((x) => x.categoria === "MENSALIDADE_IFOOD");
  assert.equal(l.valorCentavos, 1000);
  const a = await n.apurarCompetencia(c, { competencia: "2026-11" });
  assert.equal(a.indicadores.RESULTADO_GERENCIAL.valorCentavos, 3150, "a DRE fecha com o líquido do relatório");
  assert.equal((await aplicar(n, imp)).repetido, true);
});

// ------------------------------------------------------------------------------------------- 3. ciclos corrigidos
const doisCiclos = () => [...venda(), ...venda({ pedido: P2, dia: "2026-11-10", ciclo: C2, idSaldo: "S2" })];

test("substituição completa retira o ciclo ausente e mantém o que continua", async () => {
  const n = novo();
  const imp = await importar(n, doisCiclos());
  await aplicar(n, imp);
  const manteve = (await repasses(n)).find((r) => r.dataPrevista === C1.repasse);
  const corrigida = await importar(n, venda(), { substitui: imp.id });
  assert.equal((await previa(n, corrigida)).repasses.cancelar, 1);
  await aplicar(n, corrigida);
  const r = await repasses(n);
  assert.deepEqual(r.map((x) => [x.id, x.dataPrevista]), [[manteve.id, C1.repasse]], "sem duplicar nem recriar a previsão que não mudou");
});

test("ciclo retirado ou alterado com recebimento vinculado é preservado e gera pendência de revisão", async () => {
  const n = novo();
  const imp = await importar(n, venda());
  await aplicar(n, imp);
  await receberPeloExtrato(n);
  const antes = (await repasses(n))[0];
  assert.equal(antes.saldoCentavos, 0);
  const sem = await importar(n, venda({ pedido: P2, dia: "2026-11-10", ciclo: C2, idSaldo: "S2" }), { substitui: imp.id });
  const p = await previa(n, sem);
  assert.ok(p.bloqueios.some((x) => x.codigo === "CICLO_RETIRADO_COM_RECEBIMENTO"));
  await rejeita(aplicar(n, sem), CODIGO.OPERACAO_INVALIDA);
  const depois = (await repasses(n)).find((x) => x.id === antes.id);
  assert.deepEqual([depois.situacao === "CANCELADA", depois.liquidadoCentavos], [false, 4150]);

  const m = novo();
  await aplicar(m, await importar(m, venda()));
  await receberPeloExtrato(m);
  const extra = linha({ pedido: P2, dia: "2026-11-04", tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 20, cesta: 20, idSaldo: "S3", saldo: 20 });
  const q = await previa(m, await importar(m, [extra]));
  assert.ok(q.bloqueios.some((x) => x.codigo === "REPASSE_JA_RECEBIDO_MUDOU"));
});

test("relatório parcial: complementar não cancela ciclos anteriores e correção que não cobre o período é barrada", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda(), { fim: "2026-11-08" }));
  const comp = await importar(n, venda({ pedido: P2, dia: "2026-11-10", ciclo: C2, idSaldo: "S2" }), { inicio: "2026-11-09", fim: "2026-11-15" });
  const p = await previa(n, comp);
  assert.deepEqual([p.repasses.manter, p.repasses.criar, p.repasses.cancelar, p.lancamentos.cancelar], [1, 1, 0, 0], "ausência em arquivo complementar não é cancelamento");
  await aplicar(n, comp);
  assert.equal((await repasses(n)).length, 2);

  const m = novo();
  const inteira = await importar(m, doisCiclos(), { fim: "2026-11-15" });
  await aplicar(m, inteira);
  const parcial = await importar(m, venda(), { fim: "2026-11-08", substitui: inteira.id });
  const q = await previa(m, parcial);
  assert.ok(q.bloqueios.some((x) => x.codigo === "SUBSTITUICAO_PARCIAL"));
  await rejeita(aplicar(m, parcial), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await repasses(m)).length, 2, "o ciclo fora da correção parcial não foi cancelado");
});

// ------------------------------------------------------------------------------------------- 4. estados e totais
const saipos = async (n, total) => {
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo: saiposVendas([{ pedido: "1", data: "03/11/2026 12:00", canal: "iFood", forma: "Online", itens: total, total }]), periodoInicio: "2026-11-03", periodoFim: "2026-11-03" });
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
};
const diaDe = async (n, data = "2026-11-03") => (await n.consultarCalendarioDeFaturamento(c, { canal: "IFOOD", mes: "2026-11" })).dias.find((d) => d.data === data);
const area = (n) => n.consultarCanalPlataforma(c, { canal: "IFOOD", competencia: "2026-11" });

test("estados: importado, aguardando conferência e conciliado só com SAIPOS e extrato", async () => {
  const n = novo();
  const imp = await importar(n, venda());
  assert.deepEqual([(await area(n)).situacao, (await area(n)).totais, (await diaDe(n)).ifoodOficial.situacaoConferencia], ["IMPORTADO", null, "IMPORTADO"], "importar não confirma valor nenhum");
  await aplicar(n, imp);
  assert.equal((await area(n)).situacao, "AGUARDANDO_CONFERENCIA", "aplicar o arquivo não concilia");
  assert.ok(!(await diaDe(n)).estados.includes("CONCILIADO"));
  await saipos(n, 5000);
  assert.equal((await diaDe(n)).ifoodOficial.situacaoConferencia, "AGUARDANDO_CONFERENCIA", "falta o extrato");
  await receberPeloExtrato(n);
  const d = await diaDe(n);
  assert.deepEqual([d.ifoodOficial.situacaoConferencia, d.estados.includes("CONCILIADO"), (await area(n)).situacao], ["CONCILIADO", true, "CONCILIADO"]);
});

test("estado divergente com a SAIPOS e totais somam demonstrativos válidos sem repetir versões", async () => {
  const n = novo();
  const imp = await importar(n, venda(), { fim: "2026-11-08" });
  await aplicar(n, imp);
  await saipos(n, 4800);
  assert.equal((await area(n)).situacao, "DIVERGENTE");
  assert.ok((await diaDe(n)).estados.includes("DIVERGENCIA"));
  await ESCRITAS["/vendas/demonstrativo-ifood"].fazer(n, c, { periodoInicio: "2026-11-20", periodoFim: "2026-11-25", vendas: "100,00", comissoes: "10,00", taxaPagamento: "0,00", mensalidade: "0,00", servicosEPromocoes: "0,00", ajustes: "0,00", liquido: "90,00", origem: "Sintético", justificativa: JUST });
  const t = (await area(n)).totais;
  assert.deepEqual([t.brutoCentavos, t.comissoesCentavos, t.repassePrevistoCentavos], [5700 + 10000, 800 + 1000, 4150 + 9000]);
  const corrigida = await importar(n, [...venda(), linha({ pedido: P1, desc: "Taxa de transação", valor: -1, cesta: 50, saldo: 40.5 })].map((l) => l.replace(";41.5;", ";40.5;")), { fim: "2026-11-08", substitui: imp.id });
  await aplicar(n, corrigida);
  const t2 = (await area(n)).totais;
  assert.deepEqual([t2.brutoCentavos, t2.taxasCentavos, t2.repassePrevistoCentavos], [15700, 350, 4050 + 9000], "a versão substituída sai dos totais");
});

// ------------------------------------------------------------------------------------------- 5. extrato
test("candidata identifica o ciclo; só a confirmação autorizada baixa, sem criar outra movimentação", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda()));
  const conta = await banco(n);
  const mov = await credito(n, conta, 4150);
  const r = await ESCRITAS["/conciliacoes/gerar-repasses-ifood"].fazer(n, c, {});
  assert.deepEqual([r.criadas, r.repassesEmAberto, r.semCredito.length], [1, 1, 0]);
  const [corr] = await correspondencias(n);
  assert.deepEqual([corr.relacao, corr.forca, corr.diferencaCentavos, corr.repasseIfood.dataPrevista, corr.repasseIfood.apuracaoInicio, corr.repasseIfood.valorEsperadoCentavos, corr.repasseIfood.instituicao], ["IFOOD_X_UNICRED", "FORTE", 0, C1.repasse, C1.ini, 4150, "Banco Sintético"]);
  assert.equal((await repasses(n))[0].liquidadoCentavos, 0, "candidata não baixa");
  assert.equal((await n.gerarCandidatasDeRepasseIfood(c, {})).existentes, 1, "procurar de novo não duplica");
  await rejeita(n.confirmarConciliacao(ctx(undefined, undefined, ["financeiro_v2.conciliar"]), { correspondenciaId: corr.id, justificativa: JUST }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await repasses(n))[0].liquidadoCentavos, 0);
  await n.confirmarConciliacao(c, { correspondenciaId: corr.id, justificativa: JUST });
  const [rec] = await repasses(n);
  assert.deepEqual([rec.liquidadoCentavos, rec.saldoCentavos], [4150, 0]);
  const movs = await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" });
  assert.deepEqual([movs.length, movs[0].id, movs[0].alocadoCentavos], [1, mov.movimentacao.id, 4150], "usa o crédito existente");
  assert.equal((await n.gerarCandidatasDeRepasseIfood(c, {})).criadas, 0);
});

test("crédito com diferença não baixa e deixa o repasse divergente", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda()));
  await credito(n, await banco(n), 4000);
  await n.gerarCandidatasDeRepasseIfood(c, {});
  const [corr] = await correspondencias(n);
  assert.deepEqual([corr.diferencaCentavos, corr.forca], [150, "FRACA"]);
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: corr.id, justificativa: JUST }), CODIGO.CONCILIACAO_INVALIDA);
  await n.registrarDivergencia(c, { correspondenciaId: corr.id, justificativa: "Crédito menor que o previsto (sintético)." });
  assert.equal((await repasses(n))[0].liquidadoCentavos, 0);
  const d = await diaDe(n);
  assert.deepEqual([d.ifoodOficial.situacaoConferencia, d.ifoodOficial.repasses[0].situacao, d.estados.includes("DIVERGENCIA")], ["DIVERGENTE", "DIVERGENTE", true]);
});

test("sem evidência não há baixa: só valor igual é candidata fraca; crédito fora da janela ou de outra unidade é ignorado", async () => {
  const n = novo();
  await aplicar(n, await importar(n, venda()));
  await credito(n, await banco(n), 4150, { descricao: "Crédito sem identificação" });
  await n.gerarCandidatasDeRepasseIfood(c, {});
  const [fraca] = await correspondencias(n);
  assert.equal(fraca.forca, "FRACA");
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: fraca.id, justificativa: JUST }), CODIGO.CONCILIACAO_INVALIDA);
  assert.equal((await repasses(n))[0].liquidadoCentavos, 0);

  const m = novo();
  await aplicar(m, await importar(m, venda()));
  await credito(m, await banco(m), 4150, { data: "2026-12-15" });
  const irma = ctx(ORG_A, UNI_A2);
  await credito(m, await banco(m, irma), 4150, { contexto: irma });
  const r = await m.gerarCandidatasDeRepasseIfood(c, {});
  assert.deepEqual([r.criadas, r.semCredito.length], [0, 1]);
  assert.equal((await m.gerarCandidatasDeRepasseIfood(irma, {})).repassesEmAberto, 0);
  await rejeita(CONSULTAS["/previa-conciliacao-ifood"](m, irma, { importacao: (await m.consultarRegistros(c, { tipo: "IMPORTACAO" }))[0].id }), CODIGO.NAO_ENCONTRADO);
});
