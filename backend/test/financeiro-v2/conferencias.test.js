// Execução 06C — Central de Conferências: documentos e prévias, propostas, correspondências, pendências agrupadas e
// fechamento mensal. Dados 100% SINTÉTICOS. Data-base: 15/10/2026. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, entrada, montarComCadastros, obrigacao, rejeita, saida, sha } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposFormas, saiposVendas, texto } from "./helpers/arquivos.js";
import { faturamentoSaiposPdf } from "./helpers/formatos.js";

const SET = { competencia: "2026-09" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const SO_VER = ctx(ORG_A, UNI_A, [ACAO.VER]);
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, "Credito", "Bandeira X", l.bruto, l.liquido, "0,000000", "0,000000", l.unificado ?? "0,000000", "Aprovada", l.aut ?? ""].join(";"))].join("\n"));

async function base() {
  const m = await montarComCadastros();
  const { nucleo: n, c } = m;
  const receber = (fonte, tipoRelatorio, conteudo, periodo = PERIODO_SETEMBRO) => n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
  const confirmar = async (r) => (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
  const importar = async (...a) => confirmar(await receber(...a));
  const aplicar = async (p) => { await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Revisado no teste." }); return n.aplicarProposta(c, { propostaId: p.id }); };
  const doc = async (k, tipo = "BOLETO") => (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: `arquivo-sintetico-${k}`, hashSha256: sha(k), tipo, recebidoEm: "2026-09-01", descricao: `Documento sintético ${k}` })).documento.id;
  return { ...m, n, receber, confirmar, importar, aplicar, doc };
}

/** Setembro sintético: pedidos SAIPOS (CSV), Stone com e sem pedido, faturamento do dia 05 (PDF) × formas de pagamento divergente. */
async function cenario() {
  const s = await base();
  const { n, c, importar, aplicar } = s;
  const pedidos = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
    { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2500, forma: "Crédito", autorizacao: "AUT-1" },
  ]));
  await n.gerarPropostas(c, { importacaoId: pedidos.id, contaCaixaId: s.caixa.id });
  for (const p of await n.listarPropostas(c, { operacao: "VENDA" })) await aplicar(p);
  const stone = await importar("STONE", "STONE_VENDAS", stoneCsv([
    { id: "S-1", quando: "02/09/2026 12:06", bruto: "25,000000", liquido: "24,695000", unificado: "-0,305000", aut: "AUT-1" },
    { id: "S-9", quando: "03/09/2026 18:30", bruto: "77,000000", liquido: "75,459000", unificado: "-1,541000" },
  ]));
  await n.gerarPropostas(c, { importacaoId: stone.id });
  const fat = await importar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "05/09/2026", valor: 50000, desconto: 0 }]), { periodoInicio: "2026-09-05", periodoFim: "2026-09-05" });
  await n.gerarPropostas(c, { importacaoId: fat.id });
  await importar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", saiposFormas([["Dinheiro", 1, 40000]]), { periodoInicio: "2026-09-05", periodoFim: "2026-09-05" });
  const divergencia = await n.registrarDivergenciaEntreFontes(c, { periodoInicio: "2026-09-05", periodoFim: "2026-09-05" });
  return { ...s, pedidos, stone, fat, divergencia };
}
const porCodigo = (lista, codigo) => lista.filter((x) => x.codigo === codigo);

test("1, 2, 3, 4 — documentos: lista legível, prévia real do motor, leitor homologado × não homologado", async () => {
  const { n, c, receber } = await base();
  const pdf = await receber("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "02/09/2026", valor: 185000, desconto: 7400 }]), { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  const csv = await receber("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 3000 }, { pedido: "P-1", data: "02/09/2026 12:00", itens: 3000 }]));
  const lista = await n.consultarDocumentosImportados(c, SET);
  assert.equal(lista.paginacao.total, 2);
  const docPdf = lista.itens.find((x) => x.id === pdf.importacao.id);
  const docCsv = lista.itens.find((x) => x.id === csv.importacao.id);
  assert.deepEqual([docPdf.relatorio, docPdf.fonte, docPdf.estado, docPdf.compatibilidade.homologado, docPdf.responsavel, docPdf.versao], ["Faturamento diário do SAIPOS", "SAIPOS", "PRONTO_PARA_IMPORTAR", true, "Você", 1]);
  assert.deepEqual([docCsv.compatibilidade.homologado, /não homologado|sem amostra/i.test(docCsv.compatibilidade.texto)], [false, true]);
  for (const campo of ["hashSha256", "arquivoId", "impressaoPrevia"]) assert.ok(!(campo in docPdf), `sem ${campo} na lista`);
  assert.ok(lista.compatibilidade.some((x) => x.tipoRelatorio === "STONE_VENDAS" && x.formatosHomologados.includes("xlsx")));
  // Prévia: a MESMA produzida pelo motor na recepção (não uma prévia da tela).
  const det = await n.detalharImportacao(c, { id: csv.importacao.id });
  assert.equal(det.previa.duplicadosNoArquivo, csv.previa.contagens.duplicadosNoArquivo);
  assert.equal(det.previa.duplicadosNoArquivo, 1);
  assert.equal(det.previa.validos, csv.previa.contagens.novos);
  assert.equal(det.impressaoPrevia, csv.importacao.impressaoPrevia);
  assert.ok(det.limitacoes.some((x) => /não homologado|sem amostra/i.test(x)));
  assert.deepEqual([det.acoes.confirmar, det.acoes.permissaoExigida], [true, ACAO.IMPORTAR]);
  // Filtros e paginação resolvidos no banco; os totais por estado independem da página.
  const pagina = await n.consultarDocumentosImportados(c, { ...SET, tamanho: 1, pagina: 2 });
  assert.deepEqual([pagina.itens.length, pagina.paginacao.total, pagina.porEstado.PRONTO_PARA_IMPORTAR], [1, 2, 2]);
  assert.equal((await n.consultarDocumentosImportados(c, { competencia: "2026-08" })).paginacao.total, 0);
  assert.equal((await n.consultarDocumentosImportados(c, { ...SET, estado: "IMPORTADO" })).paginacao.total, 0);
});

test("5, 6, 7 — arquivo repetido, confirmação idempotente e arquivo incompatível rejeitado", async () => {
  const { n, c, receber, confirmar } = await base();
  const conteudo = saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 3000 }]);
  const r1 = await receber("SAIPOS", "SAIPOS_VENDAS", conteudo);
  const r2 = await receber("SAIPOS", "SAIPOS_VENDAS", conteudo);
  assert.deepEqual([r2.repetido, r2.importacao.id], [true, r1.importacao.id], "mesmo arquivo devolve a mesma importação");
  const imp = await confirmar(r1);
  const deNovo = await n.confirmarImportacao(c, { importacaoId: r1.importacao.id, impressaoPrevia: r1.importacao.impressaoPrevia });
  assert.equal(deNovo.repetido, true);
  const det = await n.detalharImportacao(c, { id: imp.id });
  assert.deepEqual([det.documento.estado, det.documento.registrosAtivos, det.relatorio.inseridos], ["IMPORTADO", 1, 1]);
  assert.equal((await n.consultarDocumentosImportados(c, SET)).paginacao.total, 1);
  // Arquivo que não é do relatório declarado: rejeitado na validação, com os erros na prévia; não pode ser confirmado.
  const ruim = await receber("STONE", "STONE_VENDAS", texto("isto não é um relatório da Stone\nlinha solta"));
  assert.equal(ruim.importacao.estado, "REJEITADO");
  const dRuim = await n.detalharImportacao(c, { id: ruim.importacao.id });
  assert.ok(dRuim.previa.rejeitados > 0 && dRuim.previa.erros.length > 0);
  assert.equal(dRuim.acoes.confirmar, false);
  await rejeita(n.confirmarImportacao(c, { importacaoId: ruim.importacao.id, impressaoPrevia: ruim.importacao.impressaoPrevia ?? "x".repeat(64) }), CODIGO.TRANSICAO_INVALIDA);
});

test("8, 9, 10, 11, 12, 13 — propostas: efeito explicado antes de aprovar, dados insuficientes, permissões e aplicação transacional", async () => {
  const { n, c, fat } = await cenario();
  const lista = await n.consultarPropostasParaRevisao(c, SET);
  const agregada = lista.itens.find((p) => p.operacao === "VENDA_AGREGADA");
  assert.deepEqual([agregada.nome, agregada.estado, agregada.categoriaSugerida.codigo], ["Registrar venda agregada do dia", "PROPOSTA", "VENDAS_AGREGADAS_SEM_CANAL"]);
  assert.ok(agregada.documentos.length === 1 && agregada.documentos[0].tipo === "RELATORIO_VENDAS");
  const det = await n.detalharProposta(c, { id: agregada.id });
  assert.deepEqual(det.efeitoNaDre.map((x) => [x.linha, x.valorCentavos]), [["FATURAMENTO_BRUTO_PROPRIO", 50000]]);
  assert.deepEqual([det.efeitoEmTitulos, det.efeitoNoCaixa], [[], []]);
  assert.match(det.autorizacao.observacao, /Aprovar NÃO registra nada/);
  assert.deepEqual([det.autorizacao.aprovar.disponivel, det.autorizacao.aprovar.permissao, det.autorizacao.aplicar.disponivel], [true, ACAO.REVISAR, false]);
  // Dados insuficientes: Stone sem pedido aguarda evidência e não pode ser aprovada.
  const semPedido = lista.itens.find((p) => p.operacao === "PAGAMENTO_STONE" && p.estado === "AGUARDANDO_EVIDENCIA");
  const dsp = await n.detalharProposta(c, { id: semPedido.id });
  assert.equal(dsp.autorizacao.aprovar.disponivel, false);
  assert.ok(dsp.pendentes.some((x) => /evidência/i.test(x)));
  assert.match(dsp.oQueSeraRegistrado.texto, /Nada pode ser registrado/);
  assert.equal(dsp.efeitoNaDre[0].fracao.exatoReais, "1,541000");
  await rejeita(n.aprovarProposta(c, { propostaId: semPedido.id }), CODIGO.TRANSICAO_INVALIDA);
  // Aprovação negada sem permissão; autorizada com financeiro_v2.revisar; aprovar ≠ aplicar.
  await rejeita(n.aprovarProposta(SO_VER, { propostaId: agregada.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await n.detalharProposta(SO_VER, { id: agregada.id })).autorizacao.aprovar.voceTem, false);
  await n.aprovarProposta(c, { propostaId: agregada.id, justificativa: "Conferido com o PDF." });
  assert.equal((await n.apurarCompetencia(c, SET)).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 5500, "aprovada ainda sem efeito");
  const a1 = await n.aplicarProposta(c, { propostaId: agregada.id });
  const a2 = await n.aplicarProposta(c, { propostaId: agregada.id });
  assert.deepEqual([a1.repetido, a2.repetido, a2.efeitos], [false, true, a1.efeitos], "aplicar de novo devolve o mesmo efeito");
  assert.equal((await n.apurarCompetencia(c, SET)).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 5500 + 50000);
  const hist = (await n.detalharProposta(c, { id: agregada.id })).historico.map((h) => h.estado);
  assert.deepEqual(hist.slice(-2), ["APROVADA", "APLICADA"]);
  // Aplicação transacional: pedido do MESMO dia do agregado aplicado → recusado e nada é gravado.
  const pedido = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: saiposVendas([{ pedido: "P-50", data: "05/09/2026 13:00", itens: 1000, forma: "Dinheiro" }]), periodoInicio: "2026-09-05", periodoFim: "2026-09-05" });
  const impP = (await n.confirmarImportacao(c, { importacaoId: pedido.importacao.id, impressaoPrevia: pedido.importacao.impressaoPrevia })).importacao;
  await n.gerarPropostas(c, { importacaoId: impP.id });
  const p50 = (await n.listarPropostas(c, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-50");
  await n.aprovarProposta(c, { propostaId: p50.id });
  assert.ok((await n.detalharProposta(c, { id: p50.id })).conflitos.some((x) => x.tipo === "GRANULARIDADE"), "o conflito aparece antes de aplicar");
  const vendasAntes = (await n.consultarVendas(c, SET)).paginacao.total;
  await rejeita(n.aplicarProposta(c, { propostaId: p50.id }), CODIGO.CONFLITO_IDEMPOTENCIA);
  assert.equal((await n.consultarVendas(c, SET)).paginacao.total, vendasAntes);
  assert.equal((await n.detalharProposta(c, { id: p50.id })).proposta.estado, "APROVADA");
  void fat;
});

test("14, 15, 16 — correspondências: candidata com os dois lados, ambígua não confirma, confirmação com evidência registra histórico", async () => {
  const { n, c, banco, fornecedor, doc } = await cenario();
  await n.gerarCandidatasDeConciliacao(c, { relacao: "SAIPOS_X_STONE", ...PERIODO_SETEMBRO });
  const r = await n.consultarCorrespondencias(c, SET);
  const forte = r.itens.find((x) => x.relacao === "SAIPOS_X_STONE");
  assert.deepEqual([forte.situacao, forte.confiabilidade, forte.diferencaCentavos !== undefined, forte.competencia], ["CANDIDATA", "FORTE", true, "2026-09"]);
  assert.match(forte.criterio, /autorização/);
  assert.deepEqual([forte.ladoA.itens[0].natureza, forte.ladoB.itens[0].natureza], ["Pedido", "Transação do processador"]);
  assert.equal((await n.consultarCorrespondencias(c, { competencia: "2026-08" })).paginacao.total, 0);
  // Ambígua: duas transações de mesmo valor e horário próximo para o mesmo pedido (regra FRACA) — nenhuma confirma.
  const imp = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: saiposVendas([{ pedido: "P-7", data: "08/09/2026 10:00", itens: 4000, forma: "Débito" }]), periodoInicio: "2026-09-08", periodoFim: "2026-09-08" });
  await n.confirmarImportacao(c, { importacaoId: imp.importacao.id, impressaoPrevia: imp.importacao.impressaoPrevia });
  const st = await n.receberArquivoParaImportacao(c, { fonte: "STONE", tipoRelatorio: "STONE_VENDAS", tipoMime: "application/octet-stream", conteudo: stoneCsv([{ id: "S-71", quando: "08/09/2026 10:01", bruto: "40,000000", liquido: "40,000000" }, { id: "S-72", quando: "08/09/2026 10:03", bruto: "40,000000", liquido: "40,000000" }]), periodoInicio: "2026-09-08", periodoFim: "2026-09-08" });
  await n.confirmarImportacao(c, { importacaoId: st.importacao.id, impressaoPrevia: st.importacao.impressaoPrevia });
  await n.gerarCandidatasDeConciliacao(c, { relacao: "SAIPOS_X_STONE", periodoInicio: "2026-09-08", periodoFim: "2026-09-08" });
  const fracas = (await n.consultarCorrespondencias(c, { ...SET, situacao: "CANDIDATA", tamanho: 50 })).itens.filter((x) => x.confiabilidade === "FRACA");
  assert.equal(fracas.length, 2);
  const det = await n.detalharCorrespondencia(c, { id: fracas[0].id });
  assert.deepEqual([det.correspondencia.ambigua, det.correspondencia.podeConfirmar], [true, false]);
  assert.match(det.correspondencia.confiabilidadeTexto, /nunca prova/);
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: fracas[0].id }), CODIGO.CONCILIACAO_INVALIDA);
  // Confirmada com evidência: conta a pagar × saída bancária, com o comprovante.
  const comprovante = await doc("comp", "COMPROVANTE");
  const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 12000, documentoIds: [comprovante] }))).obrigacoes[0];
  const m = (await n.registrarMovimentacao(c, saida(banco.id, 12000, { dataEfetiva: "2026-09-21" }))).movimentacao;
  const manual = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "OBRIGACAO", id: o.id, valorCentavos: 12000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: m.id, valorCentavos: 12000 }], evidenciaDocumentoIds: [comprovante] });
  const dm = await n.detalharCorrespondencia(c, { id: manual.id });
  assert.deepEqual([dm.correspondencia.podeConfirmar, dm.correspondencia.evidencias.length, dm.correspondencia.competencia], [true, 1, "2026-09"]);
  await rejeita(n.confirmarConciliacao(SO_VER, { correspondenciaId: manual.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await n.confirmarConciliacao(c, { correspondenciaId: manual.id, justificativa: "Comprovante do boleto confere." });
  const depois = await n.detalharCorrespondencia(c, { id: manual.id });
  assert.deepEqual([depois.correspondencia.situacao, depois.historico.at(-1).situacao, depois.historico.at(-1).justificativa], ["CONFIRMADA", "CONFIRMADA", "Comprovante do boleto confere."]);
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: manual.id }), CODIGO.CONCILIACAO_INVALIDA);
  assert.equal((await n.consultarCorrespondencias(c, { ...SET, situacao: "CONFIRMADA" })).itens.length, 1);
});

test("17, 18, 19, 20 — pendências: documental, classificação, um grupo por fato e contagem (não soma)", async () => {
  const { n, c, banco, fornecedor, doc } = await cenario();
  const boleto = await doc("b1");
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { descricao: "Sem comprovante", valorOriginalCentavos: 7000 }));
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { descricao: "A classificar", categoria: "DESPESAS_A_CLASSIFICAR", valorOriginalCentavos: 3300, documentoIds: [boleto] }));
  const saidaSemVinculo = (await n.registrarMovimentacao(c, saida(banco.id, 4100, { dataEfetiva: "2026-09-12" }))).movimentacao;
  const creditoSemVinculo = (await n.registrarMovimentacao(c, entrada(banco.id, 900, { dataEfetiva: "2026-09-13", natureza: "OUTRA" }))).movimentacao;
  const r = await n.consultarPendencias(c, { ...SET, tamanho: 100 });
  const chaves = r.itens.map((x) => x.chave);
  assert.equal(new Set(chaves).size, chaves.length, "cada fato aparece uma vez");
  const doGrupo = (g) => r.itens.filter((x) => x.grupo === g);
  assert.ok(doGrupo("DOCUMENTAIS").some((x) => x.codigo === "OBRIGACAO_SEM_COMPROVANTE" && x.valorCentavos === 7000));
  assert.ok(doGrupo("DOCUMENTAIS").some((x) => x.codigo === "FONTE_SEM_DOCUMENTO" && /Unicred/.test(x.titulo)));
  assert.ok(doGrupo("CLASSIFICACOES").some((x) => x.codigo === "DESPESA_A_CLASSIFICAR" && x.valorCentavos === 3300));
  // A saída sem vínculo é vista pela apuração E pela tesouraria: UMA pendência, com os dois motivos.
  const s = r.itens.filter((x) => x.chave === `MOVIMENTACAO:${saidaSemVinculo.id}`);
  assert.deepEqual([s.length, s[0].grupo, s[0].apontadoPor], [1, "CLASSIFICACOES", 2]);
  assert.ok(doGrupo("CAIXA_E_CONCILIACAO").some((x) => x.chave === `MOVIMENTACAO:${creditoSemVinculo.id}` && x.codigo === "CREDITO_NAO_IDENTIFICADO"));
  // Stone sem pedido: proposta + divergência de vendas = UM fato, no grupo de recebimentos.
  const stone = r.itens.filter((x) => x.codigo === "TRANSACAO_SEM_PEDIDO");
  assert.deepEqual([stone.length, stone[0].grupo], [1, "RECEBIMENTOS_E_REPASSES"]);
  // Diferença comercial entre relatórios: bloqueia (aberta, sem justificativa).
  assert.ok(doGrupo("VENDAS_E_AJUSTES").some((x) => x.codigo === "TOTAIS_DE_RELATORIOS_DIFERENTES" && x.bloqueia && x.valorCentavos === 10000));
  // Contagem: número de pendências, por grupo; não existe soma monetária das pendências.
  const naoInformativas = r.itens.filter((x) => x.situacao !== "INFORMATIVA").length;
  assert.equal(r.contagem.total, naoInformativas);
  assert.equal(Object.values(r.contagem.porGrupo).reduce((a, g) => a + g.abertas + g.informativas, 0), r.itens.length);
  assert.ok(!JSON.stringify(r.contagem).includes("Centavos"), "a contagem não carrega valores");
  assert.equal(r.contagem.porGrupo.CUSTOS_E_RATEIOS.abertas, 0);
  assert.match(r.semMotor.CUSTOS_E_RATEIOS, /ainda não existem/);
  // Filtros por grupo e situação; painel Revisar com opções e documentos necessários.
  assert.ok((await n.consultarPendencias(c, { ...SET, grupo: "CLASSIFICACOES" })).itens.every((x) => x.grupo === "CLASSIFICACOES"));
  assert.ok((await n.consultarPendencias(c, { ...SET, situacao: "A_RESOLVER", tamanho: 100 })).itens.every((x) => x.situacao !== "INFORMATIVA"));
  const rev = await n.detalharPendencia(c, { ...SET, chave: `MOVIMENTACAO:${saidaSemVinculo.id}` });
  for (const campo of ["oQueAconteceu", "origem", "impacto", "motivo", "documentosExistentes", "documentosNecessarios", "opcoes", "tecnico"]) assert.ok(campo in rev.pendencia, campo);
  assert.ok(rev.historico.some((h) => h.evento === "CRIACAO"));
  await rejeita(n.detalharPendencia(c, { ...SET, chave: "MOVIMENTACAO:inexistente" }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.detalharPendencia(c, { ...SET, chave: "<script>" }), CODIGO.ENTRADA_INVALIDA);
});

test("21, 22, 23, 25 — fechamento: preliminar, com pendências, homologação bloqueada por divergência sem justificativa; histórico de revisão", async () => {
  const { n, c, divergencia } = await cenario();
  let f = await n.consultarFechamento(c, SET);
  assert.deepEqual([f.estado, f.homologacao.possivel, f.homologacao.automatica], ["ABERTA", false, false]);
  assert.match(f.materialidade.texto, /Nenhuma tolerância/);
  assert.ok(f.impedimentos.some((x) => x.codigo === "DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA" && x.valorCentavos === 10000));
  assert.equal(f.secoes.find((s) => s.codigo === "VENDAS").situacao, "BLOQUEIA");
  await n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_PRELIMINAR" });
  await n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Diferença entre faturamento e formas de 05/09 em investigação", impacto: "Pode alterar o resultado da competência (sintético)." }], justificativa: "Documentando pendências." });
  f = await n.consultarFechamento(c, SET);
  assert.deepEqual([f.estado, f.pendenciasDocumentadas.length, f.etapas.filter((e) => e.concluida).length], ["FECHAMENTO_COM_PENDENCIAS", 1, 2]);
  // O núcleo recusa a homologação (não só a tela).
  await rejeita(n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Sintética." }), CODIGO.HOMOLOGACAO_BLOQUEADA);
  // Com explicação registrada (justificativa), a divergência deixa de ser "sem justificativa"; continua documentada.
  await n.explicarDivergencia(c, { divergenciaId: divergencia.id, valorCentavos: 10000, explicacao: "Hipótese: pedidos sem forma registrada (a confirmar com o relatório por pedido)." });
  f = await n.consultarFechamento(c, SET);
  // 06D: operações importadas ainda não aplicadas nem rejeitadas deixam o resultado incompleto — também bloqueiam.
  assert.deepEqual(f.impedimentos.map((x) => x.codigo), ["OPERACOES_IMPORTADAS_PENDENTES"]);
  for (const p of (await n.listarPropostas(c, {})).filter((x) => ["PROPOSTA", "AGUARDANDO_EVIDENCIA", "AGUARDANDO_REVISAO", "APROVADA"].includes(x.estado) && x.competencia === "2026-09")) {
    await n.rejeitarProposta(c, { propostaId: p.id, justificativa: "Fora do escopo desta conferência sintética." });
  }
  f = await n.consultarFechamento(c, SET);
  assert.equal(f.impedimentos.length, 0);
  assert.ok(f.exigemDocumentacao > 0);
  assert.match(f.homologacao.motivo, /decisão humana/);
  const h = await n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Conferência sintética: relatórios e extrato." });
  assert.equal(h.estado, "FECHAMENTO_HOMOLOGADO");
  await n.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.REVISAR]), { ...SET, novoEstado: "ABERTA", confirmar: true, justificativa: "Relatório por pedido chegou: revisão." });
  f = await n.consultarFechamento(c, SET);
  assert.equal(f.revisoes, 1);
  assert.deepEqual(f.historico.map((x) => x.para), ["FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO", "ABERTA"]);
  assert.equal(f.historico.at(-1).justificativa, "Relatório por pedido chegou: revisão.");
});

test("23 — saldo de conta divergente também bloqueia a homologação; 24 — recebível não pago NÃO bloqueia", async () => {
  const { n, c, banco } = await base();
  // Recebível válido em aberto (vale-refeição) e nenhuma divergência: homologa.
  await n.registrarRecebivel(c, { processador: "OPERADORA_BENEFICIOS", brutoCentavos: 48000, competencia: "2026-09", descricao: "Vale sintético" });
  await n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_PRELIMINAR" });
  let f = await n.consultarFechamento(c, SET);
  assert.deepEqual([f.impedimentos.length, f.secoes.find((s) => s.codigo === "RECEBIVEIS").situacao], [0, "EM_ABERTO_NAO_BLOQUEIA"]);
  assert.equal((await n.alterarEstadoDaCompetencia(c, { ...SET, novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Sintética." })).estado, "FECHAMENTO_HOMOLOGADO");
  // Outubro: saldos informados que não fecham com o movimento → bloqueia.
  const OUT = { competencia: "2026-10" };
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 100000 });
  await n.registrarMovimentacao(c, entrada(banco.id, 5000, { dataEfetiva: "2026-10-02" }));
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-05", valorCentavos: 104000 });
  await n.alterarEstadoDaCompetencia(c, { ...OUT, novoEstado: "FECHAMENTO_PRELIMINAR" });
  f = await n.consultarFechamento(c, OUT);
  assert.ok(f.impedimentos.some((x) => x.codigo === "SALDO_DE_CONTA_DIVERGENTE" && x.valorCentavos === 1000));
  await rejeita(n.alterarEstadoDaCompetencia(c, { ...OUT, novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Sintética." }), CODIGO.HOMOLOGACAO_BLOQUEADA);
});

test("Central: abertura com contagens, fontes com e sem documento e o que está correto; nada de soma de pendências", async () => {
  const { n, c } = await cenario();
  const r = await n.consultarCentralDeConferencias(c, SET);
  assert.equal(r.fechamento.estado, "ABERTA");
  assert.ok(r.fontes.comDocumento.some((f) => f.tipoRelatorio === "STONE_VENDAS"));
  assert.ok(r.fontes.semDocumento.some((f) => f.tipoRelatorio === "UNICRED_EXTRATO"));
  assert.ok(r.propostas.pendentes >= 2);
  // Divergência entre relatórios + (06D) operações importadas ainda não decididas.
  assert.deepEqual(r.divergenciasRelevantes.map((x) => x.codigo).sort(), ["DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA", "OPERACOES_IMPORTADAS_PENDENTES"]);
  assert.equal(typeof r.pendencias.total, "number");
  assert.ok(!("valorTotalCentavos" in r.pendencias) && !("somaCentavos" in r.pendencias));
  assert.match(r.observacao, /contagem/);
  const apuracao = await n.apurarCompetencia(c, SET);
  assert.equal(r.faturamento.valorCentavos, apuracao.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos);
});

test("26, 27 — isolamento por organização e por unidade; leitura exige financeiro_v2.ver", async () => {
  const { n, c } = await cenario();
  const prop = (await n.consultarPropostasParaRevisao(c, SET)).itens[0];
  const doc = (await n.consultarDocumentosImportados(c, SET)).itens[0];
  for (const outro of [ctx(ORG_A, UNI_A2), ctx(ORG_B, UNI_B)]) {
    assert.equal((await n.consultarDocumentosImportados(outro, SET)).paginacao.total, 0);
    assert.equal((await n.consultarPropostasParaRevisao(outro, SET)).paginacao.total, 0);
    assert.equal((await n.consultarCorrespondencias(outro, SET)).paginacao.total, 0);
    assert.equal((await n.consultarPendencias(outro, SET)).itens.filter((x) => x.codigo !== "FONTE_SEM_DOCUMENTO").length, 0);
    await rejeita(n.detalharProposta(outro, { id: prop.id }), CODIGO.NAO_ENCONTRADO);
    await rejeita(n.detalharImportacao(outro, { id: doc.id }), CODIGO.NAO_ENCONTRADO);
  }
  await rejeita(n.consultarCentralDeConferencias(ctx(ORG_A, UNI_A, [ACAO.REGISTRAR]), SET), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.consultarCentralDeConferencias(ctx(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000ff"), SET), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(n.consultarPendencias(c, { ...SET, organizacaoId: ORG_B }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.consultarPropostasParaRevisao(c, { ...SET, tamanho: 101 }), CODIGO.ENTRADA_INVALIDA);
  void UNI_A;
});

test("28 — porta de persistência: paginar e agregar no banco, total exato e independente da página", async () => {
  const { n, c, repositorio } = await cenario();
  const todas = await repositorio.leitura((tx) => tx.listar(c, "PROPOSTA", { onde: { competencia: "2026-09" } }), { escopo: c });
  const p1 = await repositorio.leitura((tx) => tx.paginar(c, "PROPOSTA", { onde: { competencia: "2026-09" }, ordem: [{ campo: "dataOperacao", desc: true }], limite: 2, deslocamento: 0 }), { escopo: c });
  const p2 = await repositorio.leitura((tx) => tx.paginar(c, "PROPOSTA", { onde: { competencia: "2026-09" }, ordem: [{ campo: "dataOperacao", desc: true }], limite: 2, deslocamento: 2 }), { escopo: c });
  assert.deepEqual([p1.itens.length, p1.total, p2.total], [2, todas.length, todas.length]);
  assert.ok(p1.itens[0].dataOperacao >= p1.itens[1].dataOperacao);
  assert.ok(!p2.itens.some((x) => p1.itens.some((y) => y.id === x.id)));
  const ag = await repositorio.leitura((tx) => tx.agregar(c, "PROPOSTA", { onde: { competencia: "2026-09" }, agruparPor: "estado", somar: "valorCentavos" }), { escopo: c });
  assert.equal(ag.reduce((s, g) => s + g.quantidade, 0), todas.length);
  for (const g of ag) assert.equal(g.somaCentavos, todas.filter((x) => x.estado === g.grupo).reduce((s, x) => s + (x.valorCentavos ?? 0), 0), g.grupo);
  const faixa = await repositorio.leitura((tx) => tx.paginar(c, "PROPOSTA", { desde: { dataOperacao: "2026-09-03" }, ate: { dataOperacao: "2026-09-05" }, em: { estado: ["PROPOSTA", "AGUARDANDO_EVIDENCIA"] }, limite: 50 }), { escopo: c });
  assert.equal(faixa.total, todas.filter((x) => x.dataOperacao >= "2026-09-03" && x.dataOperacao <= "2026-09-05" && ["PROPOSTA", "AGUARDANDO_EVIDENCIA"].includes(x.estado)).length);
  for (const ruim of [{ limite: 0 }, { limite: 501 }, { deslocamento: -1 }, { ordem: "dataOperacao" }, { qualquer: 1 }]) {
    await rejeita(repositorio.leitura((tx) => tx.paginar(c, "PROPOSTA", ruim), { escopo: c }), CODIGO.REPOSITORIO_INVALIDO);
  }
  // Escopo também vale aqui.
  assert.equal((await repositorio.leitura((tx) => tx.paginar(ctx(ORG_B, UNI_B), "PROPOSTA", { limite: 50 }), { escopo: ctx(ORG_B, UNI_B) })).total, 0);
  void n;
});
