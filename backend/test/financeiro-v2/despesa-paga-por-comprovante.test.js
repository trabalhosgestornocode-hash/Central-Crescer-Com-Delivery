// 24/11 — DESPESA JÁ PAGA POR COMPROVANTE numa operação ATÔMICA (caso real: compra de brownies paga por Pix no mesmo dia).
// Uma compra já paga = UMA despesa (na competência) + a SUA liquidação (na data do pagamento), com o comprovante anexado; nada de
// saída bancária inventada; o extrato concilia depois a MESMA liquidação. Dados SINTÉTICOS. Roda em memória e, com
// FV2_REPOSITORIO=postgres, no banco isolado; o teste "banco —" usa a identidade operacional ESTREITA num PostgreSQL real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const ESTREITAS = [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_OBRIGACAO];
const pdf = (marca = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`);
const ID_TX = "E0000000020261023BROWNIES259";
/** Brownies R$ 259,00: competência outubro, pago por Pix em 09/10 (sintético). */
const entrada = (fornecedorId, x = {}) => ({
  obrigacao: { ...obrigacao(fornecedorId, { valorOriginalCentavos: 25900, competencia: "2026-10", dataEmissao: "2026-10-09", vencimento: "2026-10-09", descricao: "Compra de brownies (sintético)" }), fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-1" }, ...(x.obrigacao ?? {}) },
  comprovante: { arquivo: { conteudo: x.arquivo ?? pdf("brownies"), nome: "comprovante.pdf", tipoMime: "application/pdf" }, descricao: "Comprovante Pix da compra de brownies (sintético)", competencia: "2026-10" },
  pagamento: { dataPagamento: "2026-10-09", idTransacao: x.idTransacao === undefined ? ID_TX : x.idTransacao, justificativa: "Pago por Pix conforme comprovante (sintético).", confirmar: true, ...(x.pagamento ?? {}) },
});
const retrato = async (n, c) => ({
  contas: (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length,
  despesas: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA").length,
  liquidacoes: (await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length,
  saidas: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((x) => x.sentido === "SAIDA").length,
  documentos: (await n.consultarRegistros(c, { tipo: "DOCUMENTO" })).length,
});
const estreito = (c) => ({ ...c, permissoes: ESTREITAS });

test("DP-1 compra nova JÁ PAGA (brownies R$ 259): UMA despesa na competência + UMA liquidação na data do pagamento, comprovante anexado, sem saída; repetir não duplica", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = estreito(m.c);
  const antes = await retrato(n, m.c);
  const r = await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id));
  assert.deepEqual([r.repetido, r.conciliacao, r.obrigacao.situacao, r.obrigacao.saldoCentavos, r.efeito.novasDespesas, r.efeito.novasSaidas], [false, "CONCILIACAO_PENDENTE", "QUITADA", 0, 1, 0]);
  assert.deepEqual([r.lancamento.natureza, r.lancamento.competencia, r.lancamento.valorCentavos], ["DESPESA", "2026-10", 25900], "DRE: despesa na COMPETÊNCIA");
  assert.deepEqual([r.liquidacao.dataEfetiva, r.liquidacao.movimentacaoId, r.liquidacao.origemDoVinculo, r.liquidacao.documentoId], ["2026-10-09", null, "COMPROVANTE", r.documento.id], "pagamento na data do PAGAMENTO, sem saída inventada");
  const t = (await n.detalharContaAPagar(m.c, { id: r.obrigacao.id })).titulo;
  assert.deepEqual([t.situacaoPagamento, t.situacaoConciliacao, t.pagoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 25900]);
  const depois = await retrato(n, m.c);
  assert.deepEqual([depois.contas - antes.contas, depois.despesas - antes.despesas, depois.liquidacoes - antes.liquidacoes, depois.saidas - antes.saidas, depois.documentos - antes.documentos], [1, 1, 1, 0, 1]);
  // Reenvio idêntico (mesma fonte, mesmo arquivo): devolve o que existe — nenhuma segunda despesa, baixa ou documento.
  const de = entrada(m.fornecedor.id); de.comprovante.arquivo.conteudo = pdf("brownies");
  const r2 = await n.registrarDespesaPagaPorComprovante(c, de);
  assert.deepEqual([r2.repetido, r2.obrigacao.id, r2.liquidacao.id], [true, r.obrigacao.id, r.liquidacao.id]);
  assert.deepEqual(await retrato(n, m.c), depois);
});

test("DP-2 ATOMICIDADE: comprovante já usado em outra despesa ⇒ recusa e NADA fica gravado (nem conta em aberto, nem lançamento)", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = estreito(m.c);
  await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id));
  const meio = await retrato(n, m.c);
  // Outra "compra" (outra fonte), mas o MESMO comprovante (mesmo arquivo): o pagamento falha DENTRO da transação.
  const outra = entrada(m.fornecedor.id, { obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-2" } } });
  await assert.rejects(n.registrarDespesaPagaPorComprovante(c, outra), (e) => e.codigo === CODIGO.CONFLITO_IDEMPOTENCIA);
  // A MESMA transação (ID do Pix) num arquivo diferente: também recusada, também sem resto.
  const outroArquivo = entrada(m.fornecedor.id, { arquivo: pdf("foto-do-mesmo-pix"), obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-3" } } });
  await assert.rejects(n.registrarDespesaPagaPorComprovante(c, outroArquivo), (e) => e.codigo === CODIGO.CONFLITO_IDEMPOTENCIA);
  const fim = await retrato(n, m.c);
  assert.deepEqual([fim.contas, fim.despesas, fim.liquidacoes], [meio.contas, meio.despesas, meio.liquidacoes], "nenhuma conta em aberto sobrou");
});

test("DP-3 valores IGUAIS não são a mesma despesa: duas compras de R$ 259 com comprovantes diferentes = duas despesas pagas", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = estreito(m.c);
  await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id));
  await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id, { arquivo: pdf("segunda-compra"), idTransacao: "E0000000020261023BROWNIES260", obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-4" } } }));
  const r = await retrato(n, m.c);
  assert.deepEqual([r.contas, r.liquidacoes, r.saidas], [2, 2, 0]);
});

test("DP-4 extrato importado DEPOIS: concilia a MESMA liquidação (sem 2ª despesa, 2ª baixa nem 2ª saída)", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = estreito(m.c);
  const r = await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id));
  const antes = await retrato(n, m.c);
  const mov = (await n.registrarMovimentacao(m.c, saida(m.banco.id, 25900, { dataEfetiva: "2026-10-09", fonte: { sistema: "UNICRED", idExterno: "EXT-SINT-259" } }))).movimentacao;
  const pend = await n.consultarPagamentosPorComprovanteAConciliar(m.c);
  assert.deepEqual(pend.itens.map((x) => [x.liquidacaoId, x.situacao]), [[r.liquidacao.id, "CANDIDATA_UNICA"]]);
  const k = await n.conciliarPagamentoPorComprovante(m.c, { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "Saída do extrato confere com o comprovante (sintético).", confirmar: true });
  assert.equal(k.conciliacao, "CONCILIADO_COM_EXTRATO");
  const fim = await retrato(n, m.c);
  assert.deepEqual([fim.contas, fim.despesas, fim.liquidacoes, fim.saidas], [antes.contas, antes.despesas, antes.liquidacoes, antes.saidas + 1]);
});

test("DP-5 permissões e entrada: sem enviar_documento / baixar_por_comprovante / conta, sem confirmação ou com parcelas ⇒ recusa ANTES de gravar", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo;
  const sem = (acao) => ({ ...m.c, permissoes: ESTREITAS.filter((a) => a !== acao) });
  for (const acao of [ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE]) await assert.rejects(n.registrarDespesaPagaPorComprovante(sem(acao), entrada(m.fornecedor.id)), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  await assert.rejects(n.registrarDespesaPagaPorComprovante({ ...m.c, permissoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE] }, entrada(m.fornecedor.id)), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  await assert.rejects(n.registrarDespesaPagaPorComprovante(estreito(m.c), entrada(m.fornecedor.id, { pagamento: { confirmar: false } })), (e) => e.codigo === CODIGO.CONFIRMACAO_EXIGIDA);
  await assert.rejects(n.registrarDespesaPagaPorComprovante(estreito(m.c), entrada(m.fornecedor.id, { obrigacao: { parcelas: 2 } })), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA);
  assert.equal((await retrato(n, m.c)).contas, 0);
});

test("DP-6 pessoa que aprova na Central (registrar, sem a ação estreita) usa o mesmo serviço atômico", async () => {
  const m = await montarComCadastros();
  const r = await m.nucleo.registrarDespesaPagaPorComprovante(m.c, entrada(m.fornecedor.id));
  assert.deepEqual([r.obrigacao.situacao, r.efeito.novasSaidas], ["QUITADA", 0]);
});

test("DP-7 banco — identidade operacional ESTREITA do MOVA num PostgreSQL real: grava conta+documento+pagamento juntos; falha não deixa resto", { skip: motivoParaPular(), timeout: 300000 }, async () => {
  const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000ca";
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const f = await m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS), { tipo: "FORNECEDOR", nome: "Andressa Sintética" });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const dono = await (await repositorio.interno()).dono();
  const cl = await dono.connect();
  try {
    await cl.query("begin");
    await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: ORG_A, unidadeId: UNI_A, acoes: ESTREITAS, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional do MOVA autorizada pelo proprietário (sintético)" }));
    await cl.query("commit");
  } finally { cl.release(); }
  const op = ctx(ORG_A, UNI_A, ESTREITAS, OPERADOR);
  const r = await n.registrarDespesaPagaPorComprovante(op, entrada(f.id));
  assert.deepEqual([r.obrigacao.situacao, r.liquidacao.movimentacaoId], ["QUITADA", null]);
  const conta = async () => (await dono.query("select count(*)::int n from fv2_obrigacao where organizacao_id = $1", [ORG_A])).rows[0].n;
  const antes = await conta();
  await assert.rejects(n.registrarDespesaPagaPorComprovante(op, entrada(f.id, { obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-db-2" } } })));
  assert.equal(await conta(), antes, "a transação inteira voltou: nenhuma conta em aberto no banco");
});

test("DP-F4 COMPROVANTE FOTOGRAFADO DE NOVO (outro arquivo, sem ID de transação): mesmo valor+data+fornecedor ⇒ POSSIVEL_DUPLICIDADE e nada gravado; confirmação explícita segue", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = estreito(m.c);
  await n.registrarDespesaPagaPorComprovante(c, entrada(m.fornecedor.id, { idTransacao: null }));
  const meio = await retrato(n, m.c);
  const foto2 = entrada(m.fornecedor.id, { idTransacao: null, arquivo: pdf("mesmo-comprovante-foto-2"), obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-foto-2" } } });
  await assert.rejects(n.registrarDespesaPagaPorComprovante(c, foto2), (e) => e.codigo === CODIGO.POSSIVEL_DUPLICIDADE && e.detalhes?.valorCentavos === 25900);
  assert.deepEqual(await retrato(n, m.c), meio, "atômico: nenhuma conta em aberto sobrou");
  const confirmada = entrada(m.fornecedor.id, { idTransacao: null, arquivo: pdf("outra-compra-de-verdade"), obrigacao: { fonte: { sistema: "MANUAL", idExterno: "MOVA:brownies-outra" } }, pagamento: { naoEDuplicado: true, justificativa: "Segunda compra no mesmo dia, confirmada pelo gestor (sintético)." } });
  const r = await n.registrarDespesaPagaPorComprovante(c, confirmada);
  assert.equal(r.repetido, false);
  assert.equal((await retrato(n, m.c)).contas, meio.contas + 1);
});
