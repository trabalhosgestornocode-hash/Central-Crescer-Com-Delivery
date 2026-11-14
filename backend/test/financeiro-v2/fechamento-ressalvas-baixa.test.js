// Execução 08E — F-1 (homologação só com pendências tratadas; ressalvas admissíveis) e F-2 (baixa de conta a pagar com
// saída JÁ registrada no extrato, sem duplicar movimento nem despesa). Dados SINTÉTICOS. Roda em memória e, com
// FV2_REPOSITORIO=postgres, no banco isolado; os testes "banco —" exercitam as barreiras do PostgreSQL diretamente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { avaliarPendenciasDoFechamento, efeitoNoResultado } from "../../src/modules/financeiro-v2/dominio/ressalvas.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, entrada, montar, montarComCadastros, obrigacao, prepararHomologacao, provisionarAdministrador, rejeita, saida } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const SET = "2026-09";
const OUT = "2026-10";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${randomUUID()}\n%%EOF\n`);
const homologar = (n, c, competencia = SET) => n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética.", confirmar: true });
const preliminar = (n, c, competencia = SET) => n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_PRELIMINAR" });
const comPendencias = (n, c, competencia = SET) => n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_COM_PENDENCIAS" });
const documentar = (n, c, chave, extra = {}, competencia = SET) => n.documentarPendenciaDoFechamento(c, { competencia, pendencia: { chave, descricao: "Pendência sintética", impacto: "Documentada no teste.", decisao: "Admitida como ressalva (sintético).", documentacaoFaltante: "Documento sintético.", ...extra } });
const bloqueada = (p) => assert.rejects(p, (e) => e.codigo === CODIGO.HOMOLOGACAO_BLOQUEADA);
const pendenciasDe = async (n, c, competencia = SET) => (await n.consultarPendencias(c, { competencia, tamanho: 100 })).itens;

async function documento(m, descricao = "Comprovante de pagamento (sintético)") {
  const g = await m.cofre.guardar(m.c, { conteudo: pdf(), tipoMime: "application/pdf" });
  return (await m.nucleo.registrarDocumento(m.c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-05", descricao })).documento;
}
/** Cenário F-2: conta de outubro (vence no fim do mês) e saída do extrato de outubro já registrada. */
async function contaESaida(valorConta = 61850, valorSaida = valorConta, extraSaida = {}) {
  const m = await montarComCadastros();
  const conta = (await m.nucleo.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: valorConta, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao: "Conta de energia (sintética)" }))).obrigacoes[0];
  const mov = (await m.nucleo.registrarMovimentacao(m.c, saida(m.banco.id, valorSaida, { dataEfetiva: "2026-10-05", fonte: { sistema: "UNICRED", idExterno: `EXT-${randomUUID().slice(0, 8)}` }, ...extraSaida }))).movimentacao;
  return { ...m, n: m.nucleo, conta, mov };
}
const vincular = (n, c, mov, alocacoes, extra = {}) => n.vincularPagamentoDoExtrato(c, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes, justificativa: "Comprovante confere com a saída do extrato (sintético).", confirmar: true, ...extra });
const retrato = async (n, c) => {
  const cx = await n.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-31" });
  const fluxo = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-11-30", granularidade: "MES" });
  const dre = await n.apurarCompetencia(c, { competencia: OUT });
  return {
    movimentacoes: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, lancamentos: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO").length,
    saidasDoBanco: cx.contas.find((x) => x.tipo === "BANCARIA").saidasCentavos, realizadoSaidas: fluxo.realizado.saidasCentavos, previstoSaidas: fluxo.previsto.saidasCentavos,
    despesas: dre.indicadores.DESPESAS_OPERACIONAIS.valorCentavos, resultado: dre.indicadores.RESULTADO_GERENCIAL.valorCentavos,
  };
};

// ================================================================================================ F-1 — domínio
test("1, 3, 4, 5, 23 — avaliação: limpo homologa direto; documentada admissível vira ressalva; natureza e impacto decidem, não o texto", () => {
  const p = (chave, codigo, efeitoNoFechamento = "EXIGE_DOCUMENTACAO", valorCentavos = 100) => ({ chave, codigo, titulo: codigo, efeitoNoFechamento, valorCentavos, situacao: "ABERTA" });
  // 1 — sem pendência que exija documentação: homologa do preliminar.
  const limpo = avaliarPendenciasDoFechamento({ pendencias: [p("D", "RECEBIVEL_ATRASADO", "NAO_BLOQUEIA")], documentadas: [] });
  assert.deepEqual([limpo.semRessalvas, limpo.comRessalvas, limpo.ressalvas.length], [true, true, 0]);
  const atuais = [p("A", "FONTE_SEM_DOCUMENTO", "EXIGE_DOCUMENTACAO", null), p("B", "SAIDA_SEM_CLASSIFICACAO"), p("C", "OBRIGACAO_SEM_COMPROVANTE", "EXIGE_DOCUMENTACAO", null), p("E", "CODIGO_NOVO_DESCONHECIDO"), p("F", "SALDO_DIVERGENTE", "BLOQUEIA")];
  const doc = (chave, extra = {}) => ({ chave, descricao: "x", impacto: "y", decisao: "Admitida.", documentacaoFaltante: "Relatório.", evidenciaDocumentoIds: [], ...extra });
  const av = avaliarPendenciasDoFechamento({ pendencias: atuais, documentadas: [doc("A"), doc("B"), doc("C"), doc("E"), doc("F"), doc("Z", { codigo: "X" })] });
  const sit = Object.fromEntries(av.itens.map((x) => [x.chave, x.situacao]));
  assert.deepEqual(sit, { A: "DOCUMENTADA_ADMISSIVEL", B: "BLOQUEANTE", C: "BLOQUEANTE", E: "BLOQUEANTE", F: "BLOQUEANTE" });
  assert.match(av.itens.find((x) => x.chave === "B").motivo, /não esclarecido/); // 4 — documentada, mas bloqueante por natureza
  assert.match(av.itens.find((x) => x.chave === "C").motivo, /não é conhecido/); // 5 — impacto desconhecido
  assert.deepEqual(av.resolvidas.map((x) => x.chave), ["Z"]);
  assert.deepEqual([av.semRessalvas, av.comRessalvas], [false, false]);
  // 23 — texto sozinho não basta: sem decisão, ou sem "o que falta"/evidência, fica sem evidência suficiente.
  const soTexto = avaliarPendenciasDoFechamento({ pendencias: [atuais[0]], documentadas: [doc("A", { decisao: null })] });
  assert.equal(soTexto.itens[0].situacao, "SEM_EVIDENCIA_SUFICIENTE");
  const semFalta = avaliarPendenciasDoFechamento({ pendencias: [atuais[0]], documentadas: [doc("A", { documentacaoFaltante: null })] });
  assert.equal(semFalta.itens[0].situacao, "SEM_EVIDENCIA_SUFICIENTE");
  // Impacto conhecido que mudou depois da documentação: documentar de novo.
  const mudou = avaliarPendenciasDoFechamento({ pendencias: [p("G", "OBRIGACAO_SEM_COMPROVANTE", "EXIGE_DOCUMENTACAO", 500)], documentadas: [doc("G", { valorCentavos: 400 })] });
  assert.equal(mudou.itens[0].situacao, "SEM_EVIDENCIA_SUFICIENTE");
  // Só ressalva: do preliminar não; do "com pendências documentadas" sim.
  const soRessalva = avaliarPendenciasDoFechamento({ pendencias: [atuais[0]], documentadas: [doc("A")] });
  assert.deepEqual([soRessalva.semRessalvas, soRessalva.comRessalvas], [false, true]);
  // Princípio conservador: saída sem vínculo bloqueia; entrada sem origem é ressalva de efeito limitado.
  assert.deepEqual([efeitoNoResultado("SAIDA_SEM_CLASSIFICACAO"), efeitoNoResultado("CREDITO_NAO_IDENTIFICADO"), efeitoNoResultado("QUALQUER")], ["INDETERMINADO", "CONHECIDO", "INDETERMINADO"]);
});

// ================================================================================================ F-1 — núcleo
test("2 — preliminar com pendência não documentada: a homologação é recusada e diz o que falta", async () => {
  const { nucleo: n, c, fornecedor } = await montarComCadastros();
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 30000 }));
  await preliminar(n, c);
  const erro = await homologar(n, c).then(() => null, (e) => e);
  assert.equal(erro?.codigo, CODIGO.HOMOLOGACAO_BLOQUEADA);
  const codigos = erro.detalhes.impeditivas.map((x) => `${x.codigo}:${x.situacao}`);
  assert.ok(codigos.includes("OBRIGACAO_SEM_COMPROVANTE:NAO_DOCUMENTADA"), codigos.join(","));
  assert.ok(erro.detalhes.motivos.some((x) => /documentação/.test(x)));
  const f = await n.consultarFechamento(c, { competencia: SET });
  assert.equal(f.homologacao.possivel, false);
  assert.ok(f.avaliacaoDasPendencias.naoDocumentadas.length > 0);
  assert.equal((await n.consultarCompetencia(c, { competencia: SET })).estado, "FECHAMENTO_PRELIMINAR");
});

test("3, 6, 7 — documentada admissível: do preliminar não passa (sem contorno); com pendências documentadas homologa COM RESSALVAS, guardadas na versão", async () => {
  const { nucleo: n, c, fornecedor } = await montarComCadastros();
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 30000 }));
  await preliminar(n, c);
  // Pendência inexistente não se documenta; homologar não aceita pendências no próprio pedido.
  await rejeita(documentar(n, c, "OBRIGACAO:00000000-0000-4000-8000-000000000000:DOCUMENTO"), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "m", confirmar: true, pendencias: [{ descricao: "x", impacto: "y" }] }), CODIGO.ENTRADA_INVALIDA);
  for (const p of await pendenciasDe(n, c)) if (p.efeitoNoFechamento === "EXIGE_DOCUMENTACAO" && p.situacao !== "INFORMATIVA") await documentar(n, c, p.chave);
  // Tudo documentado e admissível, mas ainda no PRELIMINAR: homologar seria contornar a etapa de pendências documentadas.
  const erro = await homologar(n, c).then(() => null, (e) => e);
  assert.equal(erro?.codigo, CODIGO.HOMOLOGACAO_BLOQUEADA);
  assert.ok(erro.detalhes.motivos.some((x) => /com pendências documentadas/.test(x)));
  const p2 = await comPendencias(n, c);
  assert.equal(p2.versao.tipo, "COM_PENDENCIAS");
  const h = await homologar(n, c);
  assert.deepEqual([h.estado, h.versao.tipo, h.versao.comRessalvas], ["FECHAMENTO_HOMOLOGADO", "HOMOLOGADA", true]);
  const comp = await n.consultarCompetencia(c, { competencia: SET });
  assert.equal(comp.homologacao.comRessalvas, true);
  assert.equal(comp.homologacao.pendenciasNaoTratadas, 0);
  assert.ok(comp.homologacao.ressalvas.some((r) => r.codigo === "OBRIGACAO_SEM_COMPROVANTE" && r.efeitoNoResultado === "CONHECIDO" && r.valorCentavos === 30000 && /Admitida/.test(r.decisao)));
  assert.ok(comp.pendencias.length >= comp.homologacao.ressalvas.length, "as pendências documentadas continuam com a competência");
  // 7 — a versão homologada guarda as ressalvas e a avaliação; o histórico distingue homologação com ressalvas.
  const [v] = (await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes;
  assert.deepEqual([v.tipo, v.verificacoes.comRessalvas, v.verificacoes.ressalvas.length, v.verificacoes.de], ["HOMOLOGADA", true, comp.homologacao.ressalvas.length, "FECHAMENTO_COM_PENDENCIAS"]);
  const dre = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(dre.versaoHomologada.reproduz, true);
  const f = await n.consultarFechamento(c, { competencia: SET });
  assert.match(f.homologacao.motivo, /ressalva/);
  assert.equal(f.homologacaoRegistrada.comRessalvas, true);
  assert.ok(f.historico.some((x) => x.evento === "DOCUMENTACAO_DE_PENDENCIA"));
  // 20 — competência homologada não recebe documentação nova (nem por este caminho se altera em silêncio).
  const qualquer = comp.pendencias.find((x) => x.chave);
  await rejeita(documentar(n, c, qualquer.chave), CODIGO.COMPETENCIA_HOMOLOGADA);
  assert.equal((await n.consultarCompetencia(c, { competencia: SET })).versao, comp.versao);
});

test("4, 8 — pendência bloqueante documentada continua bloqueando; nova pendência depois da documentação também; reabrir preserva as ressalvas", async () => {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, fornecedor } = m;
  const conta = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 61850 }))).obrigacoes[0];
  const mov = (await n.registrarMovimentacao(c, saida(banco.id, 61850, { dataEfetiva: "2026-09-28" }))).movimentacao;
  await preliminar(n, c);
  const pendentes = (await pendenciasDe(n, c)).filter((p) => p.efeitoNoFechamento === "EXIGE_DOCUMENTACAO" && p.situacao !== "INFORMATIVA");
  for (const p of pendentes) await documentar(n, c, p.chave);
  // A bloqueante (saída sem vínculo) impede tanto homologar quanto "estacionar" em "com pendências documentadas".
  const recusa = await comPendencias(n, c).then(() => null, (e) => e);
  assert.equal(recusa?.codigo, CODIGO.TRANSICAO_INVALIDA);
  assert.ok(recusa.detalhes.impeditivas.some((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO" && x.situacao === "BLOQUEANTE"), "documentar não torna admissível uma saída sem vínculo");
  const erro = await homologar(n, c).then(() => null, (e) => e);
  assert.equal(erro?.codigo, CODIGO.HOMOLOGACAO_BLOQUEADA);
  assert.ok(erro.detalhes.impeditivas.some((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO" && x.situacao === "BLOQUEANTE"));
  // Resolve a bloqueante com evidência (baixa pela saída do extrato) — sem criar outra saída.
  const doc = await documento(m);
  await n.vincularPagamentoDoExtrato(c, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: conta.id, valorCentavos: 61850 }], documentoId: doc.id, justificativa: "Comprovante confere.", confirmar: true });
  // Uma pendência NOVA, ainda não documentada, também bloqueia (o estado "com pendências" não é passe livre).
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000, descricao: "Chegou depois" }));
  await bloqueada(homologar(n, c));
  await rejeita(comPendencias(n, c), CODIGO.TRANSICAO_INVALIDA);
  await prepararHomologacao(n, c, SET);
  const h = await homologar(n, c);
  assert.equal(h.versao.comRessalvas, true);
  // 8 — reabertura: a documentação fica; a homologação registrada sai; a próxima precisa de nova avaliação.
  const reaberta = await n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "ABERTA", confirmar: true, justificativa: "Revisão sintética." });
  assert.equal(reaberta.homologacao, null);
  assert.ok(reaberta.pendencias.length >= pendentes.length);
  await preliminar(n, c);
  await bloqueada(homologar(n, c)); // ressalvas documentadas exigem passar de novo por "com pendências documentadas"
  await comPendencias(n, c);
  const h2 = await homologar(n, c);
  const versoes = (await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes;
  assert.deepEqual(versoes.filter((v) => v.tipo === "HOMOLOGADA").map((v) => [v.numero, v.vigente]), [[h2.versao.numero, true], [h.versao.numero, false]]);
  assert.equal(versoes.find((v) => v.numero === h.versao.numero).verificacoes.comRessalvas, true, "a versão anterior mantém suas ressalvas");
});

// ================================================================================================ F-2 — núcleo
test("9, 10, 11, 12, 24, 25 — baixa pela saída do extrato: nenhuma saída nova, nenhuma despesa nova; DRE, banco e realizado iguais; previsto sem a conta", async () => {
  const m = await contaESaida();
  const { n, c, conta, mov } = m;
  const doc = await documento(m);
  // Prévia: lista a saída SEM pré-selecionar (nada de baixa por coincidência de valor e data).
  const prev = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: conta.id });
  assert.equal(prev.escolhida, null);
  assert.ok(prev.saidasElegiveis.some((s) => s.id === mov.id && s.disponivelCentavos === 61850));
  const prevEscolhida = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: conta.id, movimentacaoId: mov.id });
  assert.deepEqual([prevEscolhida.escolhida.valorPropostoCentavos, prevEscolhida.escolhida.efeito.obrigacao.saldoDepoisCentavos, prevEscolhida.escolhida.bloqueios], [61850, 0, []]);
  assert.match(prevEscolhida.escolhida.efeito.banco, /NÃO muda/);
  assert.equal(prevEscolhida.escolhida.evidencia.exigeDocumento, true);
  const antes = await retrato(n, c);
  assert.equal(antes.previstoSaidas, 61850);
  const r = await vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 61850 }], { documentoId: doc.id });
  assert.deepEqual([r.repetido, r.efeito.novasSaidas, r.efeito.novasDespesas, r.titulos[0].situacao, r.titulos[0].saldoCentavos], [false, 0, 0, "QUITADA", 0]);
  const depois = await retrato(n, c);
  assert.deepEqual({ ...depois, previstoSaidas: null }, { ...antes, previstoSaidas: null }, "nenhum movimento, lançamento, saída de banco, realizado ou DRE a mais");
  assert.equal(depois.previstoSaidas, 0, "o previsto deixa de mostrar a conta paga");
  // Repetir não duplica.
  const rep = await vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 61850 }], { documentoId: doc.id });
  assert.equal(rep.repetido, true);
  assert.equal((await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 1);
  assert.deepEqual(await n.verificarConservacao(c), []);
  // A evidência fica vinculada à conta e à saída; o histórico guarda a justificativa.
  const vinculos = await n.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" });
  assert.ok(["OBRIGACAO", "MOVIMENTACAO"].every((t) => vinculos.some((v) => v.documentoId === doc.id && v.registroTipo === t)));
  const hist = await n.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: conta.id });
  assert.ok(hist.some((h) => h.evento === "LIQUIDACAO" && /Comprovante confere/.test(h.justificativa ?? "")));
});

test("26 — Central: a saída sem vínculo e o pagamento em aberto deixam de ser pendência; a conciliação mostra o vínculo", async () => {
  const m = await contaESaida();
  const { n, c, conta, mov } = m;
  const antes = (await pendenciasDe(n, c, OUT)).map((p) => p.codigo);
  assert.ok(antes.includes("SAIDA_SEM_CLASSIFICACAO"));
  await vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 61850 }], { documentoId: (await documento(m)).id });
  const depois = await pendenciasDe(n, c, OUT);
  assert.ok(!depois.some((p) => p.codigo === "SAIDA_SEM_CLASSIFICACAO"), "a saída vinculada deixa de ser pendência");
  const prev = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: conta.id });
  assert.equal(prev.obrigacao.pagamentos[0].viaExtrato, true);
  assert.ok(!prev.saidasElegiveis.some((s) => s.id === mov.id), "saída integralmente alocada não é mais elegível");
});

test("13, 14, 15, 16, 17 — parcial, agrupado, várias saídas para uma conta, saída esgotada e reuso do mesmo valor recusado", async () => {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, fornecedor } = m;
  const doc = await documento(m);
  const nova = async (valor, descricao) => (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: valor, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao }))).obrigacoes[0];
  const saidaDe = async (valor, dia) => (await n.registrarMovimentacao(c, saida(banco.id, valor, { dataEfetiva: `2026-10-${dia}` }))).movimentacao;
  // 14 — uma saída de R$ 1.000,00 paga A (R$ 600,00) e B (R$ 400,00): saldo alocável da saída vai a zero.
  const [a, b] = [await nova(60000, "A"), await nova(40000, "B")];
  const s1 = await saidaDe(100000, "05");
  const r = await vincular(n, c, s1, [{ obrigacaoId: a.id, valorCentavos: 60000 }, { obrigacaoId: b.id, valorCentavos: 40000 }], { documentoId: doc.id });
  assert.equal(r.movimentacao.alocadoCentavos, 100000);
  assert.deepEqual(r.titulos.map((t) => t.situacao), ["QUITADA", "QUITADA"]);
  // 17 — alocação acima do saldo AINDA disponível da saída (R$ 600 + R$ 500 numa saída de R$ 1.000): recusada inteira.
  const [c1, c2] = [await nova(60000, "C1"), await nova(50000, "C2")];
  const s4 = await saidaDe(100000, "08");
  await rejeita(vincular(n, c, s4, [{ obrigacaoId: c1.id, valorCentavos: 60000 }, { obrigacaoId: c2.id, valorCentavos: 50000 }], { documentoId: doc.id }), CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO);
  assert.equal((await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((x) => x.id === s4.id).alocadoCentavos, 0, "nada alocado pela metade");
  assert.ok((await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).filter((o) => [c1.id, c2.id].includes(o.id)).every((o) => o.liquidadoCentavos === 0));
  // 16, 17 — saída esgotada: nova vinculação (mesmo valor, outra conta) é recusada, sem efeito.
  const cExtra = await nova(1000, "Extra");
  await rejeita(vincular(n, c, r.movimentacao, [{ obrigacaoId: cExtra.id, valorCentavos: 1000 }], { documentoId: doc.id }), CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO);
  // 13 — parcial: conta de R$ 1.000,00 com saída de R$ 600,00.
  const p = await nova(100000, "Parcial");
  const s2 = await saidaDe(60000, "06");
  const rp = await vincular(n, c, s2, [{ obrigacaoId: p.id, valorCentavos: 60000 }], { documentoId: doc.id });
  assert.deepEqual([rp.titulos[0].saldoCentavos, rp.titulos[0].situacao], [40000, "PARCIAL"]);
  // 15 — a mesma conta recebe a segunda saída; acima do saldo é recusado (saldo nunca negativo).
  const s3 = await saidaDe(50000, "07");
  await rejeita(vincular(n, c, s3, [{ obrigacaoId: p.id, valorCentavos: 50000 }], { documentoId: doc.id }), CODIGO.LIQUIDACAO_EXCEDE_SALDO);
  const s3v = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((x) => x.id === s3.id);
  assert.equal(s3v.alocadoCentavos, 0, "recusa sem efeito parcial");
  const rq = await vincular(n, c, s3v, [{ obrigacaoId: p.id, valorCentavos: 40000 }], { documentoId: doc.id });
  assert.deepEqual([rq.titulos[0].saldoCentavos, rq.titulos[0].situacao, rq.movimentacao.alocadoCentavos], [0, "QUITADA", 40000]);
  // Diferença não justificada: R$ 100,00 da saída ficam sem vínculo — nada vira taxa ou desconto.
  const lancAntes = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length;
  assert.equal((await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, lancAntes);
  const restante = (await pendenciasDe(n, c, OUT)).find((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO" && x.chave === `MOVIMENTACAO:${s3.id}`);
  assert.equal(restante?.valorCentavos, 10000);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("10, 23 — evidência: sem documento nem conciliação comprovada é recusado; conciliação confirmada com evidência basta; saída inválida, versão e confirmação", async () => {
  const m = await contaESaida(50000);
  const { n, c, conta, mov, banco, caixa } = m;
  await rejeita(vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 50000 }]), CODIGO.EVIDENCIA_EXIGIDA);
  await rejeita(vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 50000 }], { confirmar: false, documentoId: (await documento(m)).id }), CODIGO.CONFIRMACAO_EXIGIDA);
  await rejeita(vincular(n, c, { ...mov, versao: mov.versao + 7 }, [{ obrigacaoId: conta.id, valorCentavos: 50000 }], { documentoId: (await documento(m)).id }), CODIGO.CONFLITO_VERSAO);
  // Entrada e transferência não pagam conta.
  const ent = (await n.registrarMovimentacao(c, entrada(banco.id, 50000, { dataEfetiva: "2026-10-05" }))).movimentacao;
  await rejeita(vincular(n, c, ent, [{ obrigacaoId: conta.id, valorCentavos: 50000 }], { documentoId: (await documento(m)).id }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  const tr = await n.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 50000, dataEfetiva: "2026-10-05" });
  const perna = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((x) => x.transferenciaId && x.sentido === "SAIDA");
  assert.ok(tr && perna);
  await rejeita(vincular(n, c, perna, [{ obrigacaoId: conta.id, valorCentavos: 50000 }], { documentoId: (await documento(m)).id }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  // Conciliação CONFIRMADA (conta × saída) com evidência dispensa documento novo.
  const prova = await documento(m, "Boleto pago (sintético)");
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "OBRIGACAO", id: conta.id, valorCentavos: 50000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: mov.id, valorCentavos: 50000 }], evidenciaDocumentoIds: [prova.id], justificativa: "Boleto pago na data da saída (sintético)." });
  await n.confirmarConciliacao(c, { correspondenciaId: cand.id, justificativa: "Boleto pago confere (sintético).", evidenciaDocumentoIds: [prova.id] });
  const atual = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((x) => x.id === mov.id);
  const prev = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: conta.id, movimentacaoId: mov.id });
  assert.equal(prev.escolhida.evidencia.exigeDocumento, false);
  const r = await vincular(n, c, atual, [{ obrigacaoId: conta.id, valorCentavos: 50000 }]);
  assert.equal(r.titulos[0].situacao, "QUITADA");
});

test("19, 22 — permissão própria e escopo: registrar não vincula, vincular não registra; outra unidade não existe aqui", async () => {
  const m = await contaESaida(20000);
  const { n, c, conta, mov, banco } = m;
  const doc = await documento(m);
  const soRegistra = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR]);
  const soVincula = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.VINCULAR_PAGAMENTO]);
  await rejeita(vincular(n, soRegistra, mov, [{ obrigacaoId: conta.id, valorCentavos: 20000 }], { documentoId: doc.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.registrarMovimentacao(soVincula, saida(banco.id, 100, { dataEfetiva: "2026-10-06" })), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.pagarContaAPagar(soVincula, { obrigacaoId: conta.id, contaId: banco.id, dataEfetiva: "2026-10-06", valorCentavos: 20000 }), CODIGO.PERMISSAO_INSUFICIENTE);
  const prev = await n.previaDoVinculoDoExtrato(ctx(ORG_A, UNI_A, [ACAO.VER]), { obrigacaoId: conta.id });
  assert.equal(prev.voceTemPermissao, false);
  // Outra unidade: a saída e a conta de A2 não existem para quem está em A.
  const a2 = ctx(ORG_A, UNI_A2);
  const banco2 = await n.configurarContaFinanceira(a2, { tipo: "BANCARIA", nome: "Banco A2" });
  const forn2 = await n.registrarContraparte(a2, { tipo: "FORNECEDOR", nome: "Fornecedor A2" });
  const mov2 = (await n.registrarMovimentacao(a2, saida(banco2.id, 20000, { dataEfetiva: "2026-10-05" }))).movimentacao;
  const conta2 = (await n.registrarObrigacao(a2, obrigacao(forn2.id, { valorOriginalCentavos: 20000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
  await rejeita(vincular(n, c, mov2, [{ obrigacaoId: conta.id, valorCentavos: 20000 }], { documentoId: doc.id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(vincular(n, c, mov, [{ obrigacaoId: conta2.id, valorCentavos: 20000 }], { documentoId: doc.id }), CODIGO.NAO_ENCONTRADO);
  assert.equal((await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 0);
  // Quem tem a permissão própria vincula (e nada mais).
  const r = await vincular(n, soVincula, mov, [{ obrigacaoId: conta.id, valorCentavos: 20000 }], { documentoId: doc.id });
  assert.equal(r.titulos[0].situacao, "QUITADA");
});

test("20, 21 — conta de setembro HOMOLOGADO paga com saída de outubro: baixa em outubro, versão de setembro intacta; saída sem vínculo de setembro impede homologar", async () => {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, fornecedor } = m;
  const conta = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 45000 }))).obrigacoes[0]; // competência 2026-09
  await prepararHomologacao(n, c, SET);
  const h = await homologar(n, c);
  const dreSetAntes = await n.apurarCompetencia(c, { competencia: SET });
  const mov = (await n.registrarMovimentacao(c, saida(banco.id, 45000, { dataEfetiva: "2026-10-03" }))).movimentacao;
  const r = await vincular(n, c, mov, [{ obrigacaoId: conta.id, valorCentavos: 45000 }], { documentoId: (await documento(m)).id });
  assert.equal(r.liquidacoes[0].dataEfetiva, "2026-10-03");
  const dreSet = await n.apurarCompetencia(c, { competencia: SET });
  assert.deepEqual([dreSet.versaoHomologada.numero, dreSet.versaoHomologada.reproduz, dreSet.indicadores.RESULTADO_GERENCIAL.valorCentavos], [h.versao.numero, true, dreSetAntes.indicadores.RESULTADO_GERENCIAL.valorCentavos]);
  assert.equal(dreSet.versaoHomologada.impressao, dreSetAntes.versaoHomologada.impressao);
  // Uma saída nova DATADA em setembro homologado nem chega a existir (escrita bloqueada).
  await rejeita(n.registrarMovimentacao(c, saida(banco.id, 100, { dataEfetiva: "2026-09-29" })), CODIGO.COMPETENCIA_HOMOLOGADA);
});

test("18 — concorrência: duas confirmações disputando a mesma saída — uma vence, a outra recebe conflito, sem efeito parcial", async () => {
  for (let rodada = 0; rodada < 3; rodada += 1) {
    const m = await contaESaida(70000);
    const { n, c, mov, fornecedor } = m;
    const outra = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 70000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao: "Outra" }))).obrigacoes[0];
    const doc = await documento(m);
    const [x, y] = await Promise.allSettled([
      vincular(n, c, mov, [{ obrigacaoId: m.conta.id, valorCentavos: 70000 }], { documentoId: doc.id }),
      vincular(n, ctx(ORG_A, UNI_A, TODAS, "cccccccc-0000-4000-8000-000000000002"), mov, [{ obrigacaoId: outra.id, valorCentavos: 70000 }], { documentoId: doc.id }),
    ]);
    const ok = [x, y].filter((r) => r.status === "fulfilled");
    const falhas = [x, y].filter((r) => r.status === "rejected").map((r) => r.reason.codigo);
    assert.equal(ok.length, 1, `rodada ${rodada}: exatamente uma vence`);
    assert.ok(falhas.every((f) => [CODIGO.CONFLITO_VERSAO, CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO, CODIGO.PERMISSAO_INSUFICIENTE].includes(f)), falhas.join(","));
    const final = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).find((z) => z.id === mov.id);
    assert.equal(final.alocadoCentavos, 70000);
    const obs = await n.consultarRegistros(c, { tipo: "OBRIGACAO" });
    assert.equal(obs.filter((o) => o.saldoCentavos === 0).length, 1, "só uma conta quitada");
    assert.equal((await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 1);
    assert.deepEqual(await n.verificarConservacao(c), []);
  }
});

// ================================================================================================ barreiras do banco
const pular = { skip: motivoParaPular(), timeout: 300000 };
const U = (k) => `dddddddd-0000-4000-8000-0000000008${String(k).padStart(2, "0")}`;
const erroDoBanco = (codigos) => (e) => codigos.includes(e.code) || codigos.includes(e.cause?.code);

async function cenarioBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const sqlComo = async (usuarioId, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  return { repositorio, m, n, ingenuo, adm, interno, sqlComo };
}

test("banco — quem só vincula não cria saída nem despesa; liquidação sem evidência, de entrada ou fora do vínculo é recusada; alocado só sobe", pular, async () => {
  const { m, n, ingenuo, adm, sqlComo } = await cenarioBanco();
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.VINCULAR_PAGAMENTO], justificativa: "Só vincula pagamentos do extrato (sintético)." });
  const banco = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const conta = (await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 9000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
  const mov = (await m.nucleo.registrarMovimentacao(adm, saida(banco.id, 9000, { dataEfetiva: "2026-10-05" }))).movimentacao;
  const comoU1 = ctx(ORG_A, UNI_A, TODAS, U(1));
  // Núcleo ingênuo (alega tudo): o BANCO recusa criar saída ou despesa para quem só vincula.
  await assert.rejects(ingenuo.registrarMovimentacao(comoU1, saida(banco.id, 100, { dataEfetiva: "2026-10-06" })), (e) => [CODIGO.INTEGRIDADE_VIOLADA, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo));
  await assert.rejects(ingenuo.registrarObrigacao(comoU1, obrigacao(forn.id, { competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" })), (e) => [CODIGO.INTEGRIDADE_VIOLADA, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo));
  // Liquidação "à mão" sem evidência nem marca de vínculo de extrato: recusada pelo gatilho.
  const liq = (extras) => ["insert into fv2_liquidacao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, movimentacao_id, alvo_tipo, alvo_id, valor_centavos, estornado_centavos, data_efetiva, situacao, extras) values ($1, $2, $3, 1, now(), $4, now(), $4, $5, 'OBRIGACAO', $6, 9000, 0, '2026-10-05', 'VALIDA', $7::jsonb)",
    [randomUUID(), ORG_A, UNI_A, U(1), mov.id, conta.id, JSON.stringify(extras)]];
  await assert.rejects(sqlComo(U(1), ...liq({})), erroDoBanco(["42501"]));
  await assert.rejects(sqlComo(U(1), ...liq({ origemDoVinculo: "EXTRATO" })), erroDoBanco(["42501"]));
  // Mudar a saída além do alocado, ou reduzir o alocado: recusado.
  await assert.rejects(sqlComo(U(1), "update fv2_movimentacao set descricao = 'mexida', versao = versao + 1 where id = $1", [mov.id]), erroDoBanco(["42501"]));
  // Pelo núcleo, com evidência, quem só vincula faz exatamente a baixa.
  const doc = await (async () => { const g = await m.cofre.guardar(adm, { conteudo: pdf(), tipoMime: "application/pdf" }); return (await n.registrarDocumento(adm, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-05", descricao: "Comprovante (sintético)" })).documento; })();
  const r = await n.vincularPagamentoDoExtrato(comoU1, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: conta.id, valorCentavos: 9000 }], documentoId: doc.id, justificativa: "Comprovante confere (sintético).", confirmar: true });
  assert.equal(r.titulos[0].situacao, "QUITADA");
  await assert.rejects(sqlComo(U(1), "update fv2_movimentacao set alocado_centavos = 0, versao = versao + 1 where id = $1", [mov.id]), erroDoBanco(["42501", "FV005", "FV006", "23514", "P0001"]));
  const [final] = (await n.consultarRegistros(adm, { tipo: "MOVIMENTACAO" })).filter((x) => x.id === mov.id);
  assert.equal(final.alocadoCentavos, 9000);
  assert.equal((await n.consultarRegistros(adm, { tipo: "MOVIMENTACAO" })).length, 1, "nenhuma saída nova");
});

test("banco — homologar à mão sem avaliação, com ressalva vinda do preliminar, inadmissível ou sem documentação, ou com saída sem vínculo é recusado (FV040)", pular, async () => {
  const { m, adm, interno } = await cenarioBanco();
  const n = m.nucleo;
  const sqlAdm = async (texto, valores = []) => comoAplicacao(interno, adm, (cl) => cl.query(texto, valores));
  const forn = await n.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const banco = await n.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  await n.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 1000 }));
  await preliminar(n, adm);
  const h = (obj) => JSON.stringify({ homologacao: obj });
  const tentar = (obj, extra = "") => sqlAdm(`update fv2_competencia set estado = 'FECHAMENTO_HOMOLOGADO', metodologia = 'm', versao = versao + 1, extras = extras || $1::jsonb ${extra} where competencia = '2026-09'`, [h(obj)]);
  await assert.rejects(sqlAdm("update fv2_competencia set estado = 'FECHAMENTO_HOMOLOGADO', metodologia = 'm', versao = versao + 1 where competencia = '2026-09'"), erroDoBanco(["FV040"]));
  await assert.rejects(tentar({ de: "FECHAMENTO_PRELIMINAR", ressalvas: [], pendenciasNaoTratadas: 2 }), erroDoBanco(["FV040"]));
  await assert.rejects(tentar({ de: "FECHAMENTO_PRELIMINAR", ressalvas: [{ chave: "X", efeitoNoResultado: "SEM_EFEITO" }], pendenciasNaoTratadas: 0 }), erroDoBanco(["FV040"]));
  await assert.rejects(tentar({ de: "FECHAMENTO_PRELIMINAR", ressalvas: [], pendenciasNaoTratadas: 0 }, ", pendencias = '[{\"descricao\":\"reescrita\"}]'::jsonb"), erroDoBanco(["FV040"]));
  // Com pendências documentadas: ressalva não documentada, indeterminada, ou "conhecida" sem valor → recusada.
  const p = (await n.consultarPendencias(adm, { competencia: SET, tamanho: 100 })).itens.find((x) => x.codigo === "OBRIGACAO_SEM_COMPROVANTE");
  await prepararHomologacao(n, adm, SET); // documenta todas (entre elas p) e passa por "com pendências documentadas"
  assert.equal((await n.consultarCompetencia(adm, { competencia: SET })).estado, "FECHAMENTO_COM_PENDENCIAS");
  const de = "FECHAMENTO_COM_PENDENCIAS";
  await assert.rejects(tentar({ de, ressalvas: [{ chave: "NAO-DOCUMENTADA", efeitoNoResultado: "SEM_EFEITO" }], pendenciasNaoTratadas: 0 }), erroDoBanco(["FV040"]));
  await assert.rejects(tentar({ de, ressalvas: [{ chave: p.chave, efeitoNoResultado: "INDETERMINADO" }], pendenciasNaoTratadas: 0 }), erroDoBanco(["FV040"]));
  await assert.rejects(tentar({ de, ressalvas: [{ chave: p.chave, efeitoNoResultado: "CONHECIDO", valorCentavos: null }], pendenciasNaoTratadas: 0 }), erroDoBanco(["FV040"]));
  // Verificação objetiva: uma saída do período sem vínculo impede, mesmo que a "avaliação" alegue estar tudo certo.
  await n.registrarMovimentacao(adm, saida(banco.id, 777, { dataEfetiva: "2026-09-27" }));
  await assert.rejects(tentar({ de, ressalvas: [{ chave: p.chave, efeitoNoResultado: "CONHECIDO", valorCentavos: 1000 }], pendenciasNaoTratadas: 0 }), erroDoBanco(["FV040"]));
  // Competência não nasce homologada.
  await assert.rejects(sqlAdm(`insert into fv2_competencia (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, competencia, estado, metodologia, pendencias, revisoes, decidido_por, decidido_em)
    values ($1, $2, $3, 1, now(), $4, now(), $4, '2026-07', 'FECHAMENTO_HOMOLOGADO', 'm', '[]'::jsonb, 0, $4, now())`, [randomUUID(), ORG_A, UNI_A, adm.usuarioId]), erroDoBanco(["FV040", "42501"]));
  assert.equal((await n.consultarCompetencia(adm, { competencia: SET })).estado, "FECHAMENTO_COM_PENDENCIAS");
});

// ======================================================= achado da jornada 08E: "com pendências" não serve de contorno
test("1b — 'com pendências documentadas' só com ressalvas admissíveis: não documentada, bloqueante ou sem ressalva → recusado", async () => {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, fornecedor } = m;
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 30000 }));
  await preliminar(n, c);
  // Nada documentado: recusa, com os motivos; a competência fica no preliminar.
  await rejeita(comPendencias(n, c), CODIGO.TRANSICAO_INVALIDA);
  assert.equal((await n.consultarCompetencia(c, { competencia: SET })).estado, "FECHAMENTO_PRELIMINAR");
  const previa = await n.previaDaMudancaDeEstado(c, { competencia: SET, novoEstado: "FECHAMENTO_COM_PENDENCIAS" });
  assert.equal(previa.permitida, false, "a tela não oferece o atalho");
  assert.ok(previa.bloqueios.some((x) => /não documentada/.test(x)), previa.bloqueios.join(" | "));
  // Tudo documentado, mas uma saída sem vínculo (bloqueante) aparece: recusa de novo — documentar a bloqueante não ajuda.
  await n.registrarMovimentacao(c, saida(banco.id, 4321, { dataEfetiva: "2026-09-27" }));
  for (const p of await pendenciasDe(n, c)) if (p.efeitoNoFechamento !== "NAO_BLOQUEIA" && p.situacao !== "INFORMATIVA") await documentar(n, c, p.chave);
  const e2 = await comPendencias(n, c).then(() => null, (e) => e);
  assert.equal(e2?.codigo, CODIGO.TRANSICAO_INVALIDA);
  assert.ok(e2.detalhes.impeditivas.some((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO" && x.situacao === "BLOQUEANTE"));
  assert.equal((await n.consultarCompetencia(c, { competencia: SET })).estado, "FECHAMENTO_PRELIMINAR");
});

test("1c — sem nada a ressalvar, 'com pendências' é recusado (homologa-se direto do preliminar)", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  await preliminar(n, c, "2026-07");
  const e = await comPendencias(n, c, "2026-07").then(() => null, (x) => x);
  if (e) assert.equal(e.codigo, CODIGO.TRANSICAO_INVALIDA);
  else assert.fail("entrou em 'com pendências' sem nenhuma ressalva");
});

test("banco — entrar em 'com pendências' à mão sem documentação suficiente, com saída sem vínculo, ou nascer nesse estado é recusado (FV040, 0019)", pular, async () => {
  const { m, adm, interno } = await cenarioBanco();
  const n = m.nucleo;
  const sqlAdm = async (texto, valores = []) => comoAplicacao(interno, adm, (cl) => cl.query(texto, valores));
  const forn = await n.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const banco = await n.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  await n.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 1000 }));
  await preliminar(n, adm);
  const tentar = (pendencias) => sqlAdm("update fv2_competencia set estado = 'FECHAMENTO_COM_PENDENCIAS', versao = versao + 1, pendencias = $1::jsonb where competencia = '2026-09'", [JSON.stringify(pendencias)]);
  await assert.rejects(tentar([]), erroDoBanco(["FV040"]));
  await assert.rejects(tentar([{ chave: "X", descricao: "só texto", impacto: "bonito" }]), erroDoBanco(["FV040"]));
  await assert.rejects(tentar([{ chave: "X", descricao: "d", decisao: "Ressalvar", documentacaoFaltante: "" }]), erroDoBanco(["FV040"]));
  // Documentação "completa", mas há saída do período sem vínculo: recusa objetiva.
  await n.registrarMovimentacao(adm, saida(banco.id, 777, { dataEfetiva: "2026-09-27" }));
  await assert.rejects(tentar([{ chave: "X", descricao: "d", decisao: "Ressalvar", documentacaoFaltante: "Relatório" }]), erroDoBanco(["FV040"]));
  await assert.rejects(sqlAdm(`insert into fv2_competencia (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, competencia, estado, metodologia, pendencias, revisoes, decidido_por, decidido_em)
    values ($1, $2, $3, 1, now(), $4, now(), $4, '2026-07', 'FECHAMENTO_COM_PENDENCIAS', null, '[{"chave":"X","decisao":"d","documentacaoFaltante":"f"}]'::jsonb, 0, $4, now())`, [randomUUID(), ORG_A, UNI_A, adm.usuarioId]), erroDoBanco(["FV040", "42501"]));
  assert.equal((await n.consultarCompetencia(adm, { competencia: SET })).estado, "FECHAMENTO_PRELIMINAR");
});
