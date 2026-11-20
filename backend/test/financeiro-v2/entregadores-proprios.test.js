// Entregadores Próprios: ciclo semanal completo com dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no PostgreSQL isolado.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CODIGO, criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { competenciaDaSemana, compararComFechamento, consolidar, descricaoDaConta, exigirSegunda, hashDaFonte, idExternoDaConta, pendenciasDaApuracao, rotuloDaSemana, semanaDe } from "../../src/modules/financeiro-v2/dominio/entregadoresProprios.js";
import { linhasDaAnalise, criarFonteEntregadores } from "../../src/modules/fv2-integracao/fonteEntregadores.js";
import { executarCiclo, lerConfiguracaoDoAgendador } from "../../src/modules/fv2-integracao/agendadorEntregadores.js";
import { criarCofreNotasSupabase } from "../../src/modules/fv2-integracao/cofreNotasSupabase.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, TODAS, UNI_A, UNI_A2, ctx, rejeita, ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { EM_POSTGRES, comoAplicacao, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { IDENTIDADE_DE_AUTOMACAO } from "../../src/modules/financeiro-v2/dominio/entregadoresProprios.js";
import { sqlConcessaoDeAutomacao } from "../../scripts/fv2/pacoteProducao.mjs";

const SEG = "2026-11-02";
const dias = (inicio = SEG, extra = {}) => Array.from({ length: 7 }, (_, i) => ({ data: semanaDe(inicio).inicio.slice(0, 8) + String(Number(inicio.slice(8)) + i).padStart(2, "0"), fonte: "foody", provisorio: false, aberto: false, triagem: 0, ...extra }));
const entrega = (id, nome, data, centavos, extra = {}) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: nome.toLowerCase(), entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false, ...extra });
const base = () => ({ disponivel: true, dias: dias(), entregas: [entrega(1, "Mauricio", "2026-11-02", 700), entrega(2, "Mauricio", "2026-11-08", 800), entrega(3, "Rafael", "2026-11-05", 900), entrega(4, "Rafael", "2026-11-05", 500, { elegivel: false, situacao: "Cancelado" })] });
const PDF = new Uint8Array(Buffer.from("%PDF-1.4 nota sintetica"));

function montar({ apuracao = base(), agora = "2026-11-09T12:00:00.000Z", inicioDaOperacao = SEG, permissoes = TODAS } = {}) {
  const estado = { apuracao, agora };
  const repositorio = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const cofre = criarCofreMemoria();
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date(estado.agora), cofre, entregadores: { fonte: { apurar: async () => estado.apuracao }, inicioDaOperacao, cofreDeNotas: cofre } });
  return { n, estado, c: ctx(ORG_A, UNI_A, permissoes), repositorio };
}
async function preparado(o) {
  const m = montar(o);
  await m.n.implantarPlanoDeContas(m.c, { modelo: "ACAITERIA" });
  return m;
}
const nota = (extra = {}) => ({ inicio: SEG, entregador: "mauricio", tipoAnexo: "NOTA_FISCAL", numero: "101", emitente: "Mauricio ME", tomador: "Unidade Teste", valorCentavos: 1500, arquivo: { conteudo: PDF, nome: "nf.pdf", tipoMime: "application/pdf" }, ...extra });
const tudoConferido = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };
async function liberar(m) {
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  await m.n.iniciarConferenciaDaNota(m.c, { inicio: SEG, entregador: "mauricio" });
  await m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "APROVAR", conferido: tudoConferido, justificativa: "Conferida com o demonstrativo." });
  return m.n.liberarPagamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", demonstrativoConferido: true, justificativa: "Documentação conferida." });
}
const contaDe = async (m, chave = "mauricio") => (await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: chave })).obrigacaoId;

test("calendário: semana de segunda a domingo, nota na terça e vencimento na quarta", () => {
  assert.deepEqual(semanaDe("2026-11-08"), { inicio: SEG, fim: "2026-11-08", fimExclusivo: "2026-11-09", demonstrativo: "2026-11-09", prazoDaNota: "2026-11-10", vencimento: "2026-11-11" });
  assert.equal(semanaDe(SEG).inicio, SEG);
  assert.throws(() => exigirSegunda("2026-11-03"));
});
test("virada de mês e de ano: rótulo, competência pela data final e vencimento corretos", () => {
  assert.equal(rotuloDaSemana("2026-09-28"), "28/09 a 04/10/2026");
  assert.equal(competenciaDaSemana("2026-09-28"), "2026-10");
  assert.equal(rotuloDaSemana("2026-12-28"), "28/12/2026 a 03/01/2027");
  assert.equal(semanaDe("2027-01-01").vencimento, "2027-01-06");
  assert.equal(descricaoDaConta("Maurício", SEG), "Entregador Próprio — Maurício — Semana 02 a 08/11/2026");
});
test("consolidação: só entregas elegíveis, separadas por entregador e por dia", () => {
  const g = consolidar(base().entregas);
  assert.deepEqual(g.map((x) => [x.nome, x.entregas, x.valorCentavos]), [["Mauricio", 2, 1500], ["Rafael", 1, 900]]);
  assert.equal(g[0].porDia.length, 2);
});
test("ponte do parser: cancelado sem taxa fica fora e cancelamento em revisão é sinalizado", () => {
  const l = linhasDaAnalise({ pedidos: [
    { id: "a", numeroPedido: "1", dataHora: "2026-11-02T10:00:00Z", entregador: " Mauricio  Silva ", situacao: "Entregue", taxaEntregador: 7.5, statusConciliacao: "incluido" },
    { id: "b", numeroPedido: "2", dataHora: "2026-11-02T11:00:00Z", entregador: "Mauricio Silva", situacao: "Cancelado", taxaEntregador: 7, statusConciliacao: "excluido", classificacaoCancelamento: "nao_recebe_taxa" },
    { id: "c", numeroPedido: "3", dataHora: "2026-11-02T12:00:00Z", entregador: "Mauricio Silva", situacao: "Cancelado", taxaEntregador: 7, statusConciliacao: "cancelado_com_taxa", classificacaoCancelamento: "revisar" },
  ], lancamentos: [{ id: "l", origem: "taxa_adicional", entregadorChave: "mauricio silva", entregadorNome: "Mauricio Silva", data: "2026-11-03", valor: 3, excluido: false }] }, (n) => n.trim().toLowerCase().replace(/\s+/g, " "));
  assert.deepEqual(l.map((x) => [x.valorCentavos, x.elegivel, x.emRevisao]), [[750, true, false], [700, false, false], [700, true, true], [300, true, false]]);
  assert.equal(l[0].entregadorChave, "mauricio silva");
});
test("ponte do parser: unidade sem Foody habilitado fica indisponível e a leitura usa cache curto", async () => {
  let leituras = 0;
  const f = criarFonteEntregadores({ db: {}, chaveDe: (x) => x, cobertura: async () => { leituras += 1; return null; }, analisar: async () => ({}) });
  const p = { organizacaoId: ORG_A, unidadeId: UNI_A, inicio: SEG, fim: "2026-11-08" };
  assert.equal((await f.apurar(p)).disponivel, false);
  await f.apurar(p);
  assert.equal(leituras, 1);
});
test("pendências: falha do parser, dia provisório, triagem, revisão e dia sem dados impedem valor definitivo", () => {
  assert.equal(pendenciasDaApuracao({ disponivel: false, motivo: "X" }, SEG)[0].codigo, "FONTE_INDISPONIVEL");
  const a = base(); a.dias[6] = { ...a.dias[6], provisorio: true, triagem: 2 }; a.dias[0] = { ...a.dias[0], fonte: "sem_dados" }; a.entregas.push(entrega(9, "Rafael", "2026-11-06", 500, { emRevisao: true }));
  assert.deepEqual([...new Set(pendenciasDaApuracao(a, SEG).map((p) => p.codigo))].sort(), ["CANCELAMENTO_EM_REVISAO", "DIA_EM_TRIAGEM", "DIA_PROVISORIO", "DIA_SEM_DADOS"]);
});
test("semana em andamento é provisória e não gera conta", async () => {
  const m = await preparado({ agora: "2026-11-05T12:00:00.000Z" });
  const p = await m.n.consultarEntregadoresProprios(m.c, { semana: SEG });
  assert.equal(p.semana.situacao, "EM_ANDAMENTO"); assert.equal(p.semana.provisoria, true); assert.equal(p.indicadores.acumuladoSemanaCentavos, 2400);
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG }), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).quantidade, 0);
});
test("atualização automática: o acumulado reflete a mudança do parser", async () => {
  const m = await preparado({ agora: "2026-11-05T12:00:00.000Z" });
  m.estado.apuracao = { ...base(), entregas: [...base().entregas, entrega(5, "Rafael", "2026-11-05", 1000)] };
  assert.equal((await m.n.consultarEntregadoresProprios(m.c, { semana: SEG })).indicadores.acumuladoSemanaCentavos, 3400);
});
test("fechamento: uma conta por entregador, quarta-feira, categoria certa, sem valor zero, sem dinheiro e na DRE uma vez", async () => {
  const a = base(); a.entregas.push(entrega(7, "Zerado", "2026-11-04", 0));
  const m = await preparado({ apuracao: a });
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal(r.situacao, "CONSOLIDADA"); assert.equal(r.contasCriadas, 2); assert.equal(r.totalCentavos, 2400);
  const contas = await m.n.consultarContasAPagar(m.c, {});
  assert.deepEqual(contas.itens.map((t) => [t.fornecedor.nome, t.vencimento, t.saldoCentavos, t.categoria.codigo, t.competencia]), [["Mauricio", "2026-11-11", 1500, "ENTREGADORES_PROPRIOS", "2026-11"], ["Rafael", "2026-11-11", 900, "ENTREGADORES_PROPRIOS", "2026-11"]]);
  assert.equal(contas.itens[0].descricao, "Entregador Próprio — Mauricio — Semana 02 a 08/11/2026");
  const dia = (await m.n.consultarCalendarioFinanceiro(m.c, { mes: "2026-11" })).dias.find((d) => d.data === "2026-11-11");
  assert.equal(dia.titulos.length, 2);
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 0);
  const lancs = (await m.n.consultarRegistros(m.c, { tipo: "LANCAMENTO" })).filter((l) => l.categoria === "ENTREGADORES_PROPRIOS");
  assert.deepEqual([lancs.length, lancs.reduce((t, l) => t + l.valorCentavos, 0)], [2, 2400]);
});
test("reprocessar a mesma semana não cria outra conta", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal(r.repetido, true); assert.equal(r.contasCriadas, 0);
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).quantidade, 2);
});
test("falha do parser deixa a semana pendente e o reprocessamento recupera", async () => {
  const m = await preparado({ apuracao: { disponivel: false, motivo: "FALHA", dias: [], entregas: [] } });
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal(r.situacao, "PENDENTE"); assert.equal(r.contasCriadas, 0);
  m.estado.apuracao = base();
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG })).situacao, "CONSOLIDADA");
});
test("semana histórica exige reconciliação com justificativa e o ciclo automático nunca a fecha", async () => {
  const m = await preparado({ inicioDaOperacao: "2026-11-09" });
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG }), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await m.n.executarCicloDeEntregadores(m.c)).semanas.length, 0);
  assert.equal((await m.n.previaDoFechamentoSemanal(m.c, { inicio: SEG })).historica, true);
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Reconciliada com os pagamentos antigos." })).situacao, "CONSOLIDADA");
});
test("agendador: antes das 06h de segunda espera; depois fecha uma vez; sem data de início não faz nada", async () => {
  const m = await preparado({ agora: "2026-11-09T07:00:00.000Z" });
  assert.equal((await m.n.executarCicloDeEntregadores(m.c)).semanas.length, 0);
  m.estado.agora = "2026-11-09T10:00:00.000Z";
  assert.equal((await m.n.executarCicloDeEntregadores(m.c)).semanas[0].contasCriadas, 2);
  assert.equal((await m.n.executarCicloDeEntregadores(m.c)).semanas[0].contasCriadas, 0);
  const s = await preparado({ inicioDaOperacao: null });
  assert.equal((await s.n.executarCicloDeEntregadores(s.c)).motivo, "SEM_DATA_DE_INICIO");
});
test("agendador: configuração falha fechada e erro de uma unidade não para a outra", async () => {
  assert.equal(lerConfiguracaoDoAgendador({}).habilitado, false);
  assert.equal(lerConfiguracaoDoAgendador({ FV2_ENTREGADORES_AGENDADOR_HABILITADO: "1", FV2_HABILITADO: "1", FV2_ESCRITA_HABILITADA: "1", FV2_AUTORIDADE_MODO: "local", FV2_ENTREGADORES_INICIO: "2026-11-03", FV2_ENTREGADORES_UNIDADES: `${ORG_A}:${UNI_A}:${ORG_A}` }).motivo, "INICIO_INVALIDO");
  const u = [{ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: ORG_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2, usuarioId: ORG_A }];
  const r = await executarCiclo({ unidades: u, unidadeLiberada: async () => true, comAutomacao: (f) => f(), criarNucleo: (x) => ({ executarCicloDeEntregadores: async () => { if (x.unidadeId === UNI_A) throw new Error("x"); return { semanas: [] }; } }) });
  assert.equal(r[0].erro, "ERRO_INTERNO"); assert.equal(r[1].semanas, 0);
});
test("conta manual do mesmo serviço bloqueia a geração até uma pessoa decidir", async () => {
  const m = await preparado();
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Mauricio" }, valorOriginalCentavos: 1500, categoria: "ENTREGADORES_PROPRIOS", descricao: "Pagamento semanal manual", competencia: "2026-11", dataEmissao: "2026-11-09", vencimento: "2026-11-11" });
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal(r.contasCriadas, 1); assert.equal(r.duplicidades, 1);
  const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" });
  assert.equal(d.obrigacaoId, null);
  await m.n.resolverDuplicidadeDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "VINCULAR_MANUAL", obrigacaoManualId: d.duplicidade.candidatas[0].obrigacaoId, justificativa: "É o mesmo pagamento já lançado." });
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).quantidade, 2);
});
test("nomes parecidos não são tratados como a mesma pessoa", async () => {
  const m = await preparado();
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Mauricio Souza" }, valorOriginalCentavos: 1500, categoria: "ENTREGADORES_PROPRIOS", descricao: "Outra pessoa", competencia: "2026-11", dataEmissao: "2026-11-09", vencimento: "2026-11-11" });
  // Conta de outra pessoa na mesma categoria e semana: não é duplicidade de ninguém, mas uma pessoa confirma antes de gerar.
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG })).pendencias[0].codigo, "CONTA_MANUAL_SEM_ENTREGADOR");
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, aceitarContasManuais: true, justificativa: "Mauricio Souza é outro entregador, fora do Foody." })).duplicidades, 0);
});
test("conta manual ÚNICA da semana em Entregadores Próprios (sem entregador) não é gerada de novo por cima", async () => {
  const m = await preparado();
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Entregadores próprios — Unidade" }, valorOriginalCentavos: 2400, categoria: "ENTREGADORES_PROPRIOS", descricao: "ENTREGADORES ENTRE OS DIAS 02/11 A 08/11", competencia: "2026-11", dataEmissao: "2026-11-11", vencimento: "2026-11-11" });
  const p = await m.n.previaDoFechamentoSemanal(m.c, { inicio: SEG });
  assert.equal(p.comDuplicidade, 0, "a comparação por nome não enxerga a conta agregada");
  assert.deepEqual(p.pendencias.map((x) => [x.codigo, x.valorCentavos]), [["CONTA_MANUAL_SEM_ENTREGADOR", 2400]], "a prévia mostra a conta já lançada");
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.deepEqual([r.situacao, r.contasCriadas], ["PENDENTE", 0], "nada é gerado por cima da conta manual");
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).quantidade, 1);
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, aceitarContasManuais: true }), CODIGO.ENTRADA_INVALIDA);
  const ok = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, aceitarContasManuais: true, justificativa: "A conta manual é de outro serviço." });
  assert.deepEqual([ok.situacao, ok.contasCriadas], ["CONSOLIDADA", 2]);
  assert.equal(ok.semana.dados.contasManuaisAceitas.contas.length, 1, "a decisão fica registrada na semana");
});
test("conta manual já lançada: o fechamento automático nunca a aceita sozinho; outra categoria não conta", async () => {
  const m = await preparado();
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Entregadores próprios — Unidade" }, valorOriginalCentavos: 2400, categoria: "ENTREGADORES_PROPRIOS", descricao: "Semana manual", competencia: "2026-11", dataEmissao: "2026-11-11", vencimento: "2026-11-11" });
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Gráfica" }, valorOriginalCentavos: 900, categoria: "OUTRAS_DESPESAS", descricao: "Outra categoria", competencia: "2026-11", dataEmissao: "2026-11-11", vencimento: "2026-11-11" });
  assert.equal((await m.n.previaDoFechamentoSemanal(m.c, { inicio: SEG })).pendencias[0].quantidade, 1, "só a categoria Entregadores Próprios entra");
  const ciclo = await m.n.executarCicloDeEntregadores(m.c);
  assert.ok(ciclo.semanas.every((s) => !s.contasCriadas));
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).quantidade, 2);
});
test("sem nota aprovada a conta segue no calendário, sinaliza impedimento e nenhuma baixa passa", async () => {
  const m = await preparado({ agora: "2026-11-11T15:00:00.000Z" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  const p = await m.n.consultarEntregadoresProprios(m.c, { semana: SEG });
  assert.equal(p.fechamentos[0].situacaoDocumental, "AGUARDANDO_NF"); assert.equal(p.fechamentos[0].impedimentoDocumental, true);
  const conta = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  await assert.rejects(m.n.pagarContaAPagar(m.c, { obrigacaoId: await contaDe(m), contaId: conta.id, dataEfetiva: "2026-11-11", valorCentavos: 1500 }), (e) => e.detalhes?.motivo === "ENTREGADOR_SEM_LIBERACAO_DOCUMENTAL");
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 0);
});
test("nota rejeitada volta a aguardar nova nota; aprovação exige conferência e valor igual", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await m.n.anexarDocumentoDoEntregador(m.c, nota({ valorCentavos: 1400 }));
  await m.n.iniciarConferenciaDaNota(m.c, { inicio: SEG, entregador: "mauricio" });
  await rejeita(m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "APROVAR", conferido: { emitente: true }, justificativa: "Teste" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "APROVAR", conferido: tudoConferido, justificativa: "Teste" }), CODIGO.OPERACAO_INVALIDA);
  const f = await m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "REJEITAR", justificativa: "Valor errado na nota." });
  assert.equal(f.situacaoDocumental, "NF_REJEITADA");
  const nova = await m.n.anexarDocumentoDoEntregador(m.c, nota({ numero: "102", arquivo: { conteudo: new Uint8Array(Buffer.from("%PDF-1.4 segunda")), nome: "nf2.pdf", tipoMime: "application/pdf" } }));
  assert.deepEqual(nova.dados.notas.map((n) => n.vigente), [false, true]);
});
test("a mesma nota não serve para duas semanas ou entregadores", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  await rejeita(m.n.anexarDocumentoDoEntregador(m.c, nota({ entregador: "rafael", valorCentavos: 900 })), CODIGO.OPERACAO_INVALIDA);
});
test("fluxo completo: nota, aprovação, liberação e baixa pelo mecanismo existente; quitada uma só vez", async () => {
  const m = await preparado({ agora: "2026-11-11T15:00:00.000Z" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal((await liberar(m)).situacaoDocumental, "LIBERADO_PAGAMENTO");
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  const id = await contaDe(m);
  await m.n.pagarContaAPagar(m.c, { obrigacaoId: id, contaId: banco.id, dataEfetiva: "2026-11-11", valorCentavos: 1500 });
  const p = await m.n.consultarEntregadoresProprios(m.c, { semana: SEG });
  assert.equal(p.fechamentos.find((f) => f.entregador.chave === "mauricio").situacaoPagamento, "PAGO");
  assert.equal(p.indicadores.pagoCentavos, 1500);
  assert.equal((await m.n.consultarRegistros(m.c, { tipo: "LANCAMENTO" })).filter((l) => l.categoria === "ENTREGADORES_PROPRIOS").length, 2);
});
test("conciliação com extrato: saída identificada só baixa depois da liberação, sem criar outra saída", async () => {
  const m = await preparado({ agora: "2026-11-11T15:00:00.000Z" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" });
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  const { movimentacao: mov } = await m.n.registrarMovimentacao(m.c, { contaId: banco.id, dataEfetiva: "2026-11-11", sentido: "SAIDA", valorCentavos: 1500, natureza: "PAGAMENTO", descricao: "PIX extrato sintético" });
  const baixa = (versao) => m.n.vincularPagamentoDoExtrato(m.c, { movimentacaoId: mov.id, versaoMovimentacao: versao, alocacoes: [{ obrigacaoId: d.obrigacaoId, valorCentavos: 1500 }], documentoId: d.documentos[0].id, justificativa: "Saída identificada no extrato.", confirmar: true });
  await assert.rejects(baixa(mov.versao), (e) => e.detalhes?.motivo === "ENTREGADOR_SEM_LIBERACAO_DOCUMENTAL");
  await m.n.iniciarConferenciaDaNota(m.c, { inicio: SEG, entregador: "mauricio" });
  await m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "APROVAR", conferido: tudoConferido, justificativa: "Conferida." });
  await m.n.liberarPagamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", demonstrativoConferido: true, justificativa: "Conferido." });
  await baixa(mov.versao);
  assert.equal((await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" })).situacaoPagamento, "PAGO");
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 1);
});
test("DRE: a despesa entra uma vez no fechamento e o pagamento não a repete", async () => {
  const m = await preparado({ agora: "2026-11-11T15:00:00.000Z" });
  const resultado = async () => (await m.n.apurarCompetencia(m.c, { competencia: "2026-11" })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
  const antes = await resultado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  assert.equal(await resultado(), antes - 2400);
  await liberar(m);
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  await m.n.pagarContaAPagar(m.c, { obrigacaoId: await contaDe(m), contaId: banco.id, dataEfetiva: "2026-11-11", valorCentavos: 1500 });
  assert.equal(await resultado(), antes - 2400);
});
test("alteração tardia vira divergência: valor original fica e liberação espera a decisão", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  m.estado.apuracao = { ...base(), entregas: [...base().entregas, entrega(8, "Mauricio", "2026-11-07", 300)] };
  assert.equal((await m.n.verificarAlteracoesDaSemana(m.c, { inicio: SEG })).novas, 1);
  assert.equal((await m.n.verificarAlteracoesDaSemana(m.c, { inicio: SEG })).novas, 0);
  const p = await m.n.consultarEntregadoresProprios(m.c, { semana: SEG });
  const d = p.semana.divergencias[0];
  assert.equal(d.diferencaCentavos, 300);
  assert.equal(p.fechamentos.find((f) => f.entregador.chave === "mauricio").valorCentavos, 1500);
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  await m.n.iniciarConferenciaDaNota(m.c, { inicio: SEG, entregador: "mauricio" });
  await m.n.decidirNotaDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "APROVAR", conferido: tudoConferido, justificativa: "Conferida." });
  await assert.rejects(m.n.liberarPagamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", demonstrativoConferido: true, justificativa: "Teste." }), (e) => e.detalhes?.motivo === "DIVERGENCIA_ABERTA");
  await m.n.decidirDivergenciaDoEntregador(m.c, { inicio: SEG, divergencia: d.id, decisao: "CONTA_COMPLEMENTAR", justificativa: "Entrega recebida depois do fechamento." });
  const contas = await m.n.consultarContasAPagar(m.c, {});
  assert.equal(contas.quantidade, 3); assert.equal(contas.totais.saldoCentavos, 2700);
  assert.equal(hashDaFonte(`${idExternoDaConta("x")}:c12345678`), hashDaFonte(idExternoDaConta("x")));
});
test("comparação detecta correção, cancelamento e troca de entregador", () => {
  const antes = consolidar(base().entregas);
  const depois = consolidar([entrega(1, "Mauricio", "2026-11-02", 650), entrega(2, "Rafael", "2026-11-08", 800), entrega(3, "Rafael", "2026-11-05", 900)]);
  const d = compararComFechamento(antes, depois);
  assert.deepEqual(d.map((x) => [x.entregadorChave, x.diferencaCentavos]).sort(), [["mauricio", -850], ["rafael", 800]]);
});
test("isolamento: outra unidade não vê fechamento, conta nem documento", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  const outra = ctx(ORG_A, UNI_A2);
  assert.equal((await m.n.consultarContasAPagar(outra, {})).quantidade, 0);
  await rejeita(m.n.detalharFechamentoDoEntregador(outra, { inicio: SEG, entregador: "mauricio" }), CODIGO.NAO_ENCONTRADO);
});
test("permissões: sem registrar não fecha, sem conciliar não aprova, sem enviar não anexa", async () => {
  const m = await preparado();
  const so = (...p) => ctx(ORG_A, UNI_A, ["financeiro_v2.ver", ...p]);
  await rejeita(m.n.fecharSemanaDeEntregadores(so(), { inicio: SEG }), CODIGO.PERMISSAO_INSUFICIENTE);
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await rejeita(m.n.anexarDocumentoDoEntregador(so(), nota()), CODIGO.PERMISSAO_INSUFICIENTE);
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  await rejeita(m.n.iniciarConferenciaDaNota(so("financeiro_v2.enviar_documento"), { inicio: SEG, entregador: "mauricio" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const doc = (await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" })).documentos[0];
  await rejeita(m.n.abrirDocumentoDoEntregador(so(), { inicio: SEG, entregador: "mauricio", documento: doc.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.ok((await m.n.abrirDocumentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", documento: doc.id })).conteudo.byteLength > 0);
  await rejeita(m.n.abrirDocumentoDoEntregador(m.c, { inicio: SEG, entregador: "rafael", documento: doc.id }), CODIGO.NAO_ENCONTRADO);
});
test("cofre de notas recusa bucket público e confere o conteúdo", async () => {
  const guardados = new Map();
  const storage = (publico) => ({ getBucket: async () => ({ data: { public: publico } }), from: () => ({ list: async (_p, o) => ({ data: [...guardados.keys()].filter((k) => k.endsWith(o.search)).map((k) => ({ name: k.split("/").pop() })) }), upload: async (k, b) => { guardados.set(k, b); return {}; }, download: async (k) => ({ data: new Blob([guardados.get(k)]) }) }) });
  const e = { organizacaoId: ORG_A, unidadeId: UNI_A };
  await rejeita(criarCofreNotasSupabase({ supabase: { storage: storage(true) }, bucket: "b" }).guardar(e, { conteudo: PDF, tipoMime: "application/pdf" }), CODIGO.COFRE_INDISPONIVEL);
  const cofre = criarCofreNotasSupabase({ supabase: { storage: storage(false) }, bucket: "b" });
  const g = await cofre.guardar(e, { conteudo: PDF, tipoMime: "application/pdf" });
  assert.equal((await cofre.guardar(e, { conteudo: PDF, tipoMime: "application/pdf" })).repetido, true);
  assert.deepEqual(Buffer.from((await cofre.ler(e, g.arquivoId)).conteudo), Buffer.from(PDF));
});
test("rotas: as ações existem e não aceitam unidade vinda da tela", () => {
  for (const k of ["fechar", "verificar", "duplicidade", "documento", "conferir", "decidir-nota", "liberar", "divergencia"]) assert.ok(!ESCRITAS[`/entregadores/${k}`].campos.includes("unidade"), k);
});

const manual = (m, nome, valor) => m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome }, valorOriginalCentavos: valor, categoria: "OUTRAS_DESPESAS", descricao: "Entregas referente à semana", competencia: "2026-11", dataEmissao: "2026-11-09", vencimento: "2026-11-11" });
test("caso real: conta manual em Outras despesas com prefixo Entregador é detectada e gera só a diferença", async () => {
  const m = await preparado();
  await manual(m, "Entregador Mauricio", 1000);
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG })).duplicidades, 1);
  const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" });
  await m.n.resolverDuplicidadeDoEntregador(m.c, { inicio: SEG, entregador: "mauricio", decisao: "GERAR_DIFERENCA", obrigacaoManualId: d.duplicidade.candidatas[0].obrigacaoId, justificativa: "A conta manual cobre parte da semana." });
  const nova = (await m.n.consultarContasAPagar(m.c, {})).itens.find((t) => t.id === undefined || t.descricao.includes("saldo além"));
  assert.equal(nova.saldoCentavos, 500);
});
test("triagem pendente: o agendador espera; só uma pessoa, com justificativa, pode fechar", async () => {
  const a = base(); a.dias = a.dias.map((d) => ({ ...d, provisorio: true, triagem: 2 }));
  const m = await preparado({ apuracao: a });
  assert.equal((await m.n.executarCicloDeEntregadores(m.c)).semanas[0].situacao, "PENDENTE");
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, aceitarTriagem: true }), CODIGO.ENTRADA_INVALIDA);
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, aceitarTriagem: true, justificativa: "Triagem conferida pelo responsável." })).situacao, "CONSOLIDADA");
});
test("semana histórica já paga: baixa pelo extrato sem nota, sem nova saída; semana automática não usa esse caminho", async () => {
  const m = await preparado({ agora: "2026-11-18T15:00:00.000Z", inicioDaOperacao: "2026-11-23" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Reconciliada com o extrato." });
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  const { movimentacao: mov } = await m.n.registrarMovimentacao(m.c, { contaId: banco.id, dataEfetiva: "2026-11-11", sentido: "SAIDA", valorCentavos: 1500, natureza: "PAGAMENTO", descricao: "PIX sintético" });
  await m.n.reconhecerPagamentoHistorico(m.c, { inicio: SEG, entregador: "mauricio", movimentacaoId: mov.id, justificativa: "PIX de 11/11 identificado no extrato." });
  await m.n.anexarDocumentoDoEntregador(m.c, nota({ tipoAnexo: "COMPROVANTE" }));
  const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" });
  await m.n.vincularPagamentoDoExtrato(m.c, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: d.obrigacaoId, valorCentavos: 1500 }], documentoId: d.documentos[0].id, justificativa: "PIX histórico identificado no extrato.", confirmar: true });
  assert.equal((await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "mauricio" })).situacaoPagamento, "PAGO");
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 1);
  const auto = await preparado({ agora: "2026-11-11T15:00:00.000Z" });
  await auto.n.fecharSemanaDeEntregadores(auto.c, { inicio: SEG });
  await rejeita(auto.n.reconhecerPagamentoHistorico(auto.c, { inicio: SEG, entregador: "mauricio", movimentacaoId: mov.id, justificativa: "Tentativa indevida." }), CODIGO.OPERACAO_INVALIDA);
});
test("quarentena: PDF com conteúdo ativo é recusado antes de chegar ao cofre", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await rejeita(m.n.anexarDocumentoDoEntregador(m.c, nota({ arquivo: { conteudo: new Uint8Array(Buffer.from("%PDF-1.4 /JavaScript (x)")), nome: "nf.pdf", tipoMime: "application/pdf" } })), CODIGO.DOCUMENTO_INVALIDO);
});
test("agendador só aceita a identidade técnica exclusiva", () => {
  const env = { FV2_ENTREGADORES_AGENDADOR_HABILITADO: "1", FV2_HABILITADO: "1", FV2_ESCRITA_HABILITADA: "1", FV2_AUTORIDADE_MODO: "local", FV2_ENTREGADORES_INICIO: "2026-11-23" };
  assert.equal(lerConfiguracaoDoAgendador({ ...env, FV2_ENTREGADORES_UNIDADES: `${ORG_A}:${UNI_A}:${ORG_A}` }).motivo, "UNIDADES_INVALIDAS");
  assert.equal(lerConfiguracaoDoAgendador({ ...env, FV2_ENTREGADORES_UNIDADES: `${ORG_A}:${UNI_A}:${IDENTIDADE_DE_AUTOMACAO}` }).habilitado, true);
});
test("banco: a identidade técnica não movimenta dinheiro nem altera permissões", { skip: !EM_POSTGRES }, async () => {
  const m = await preparado();
  const interno = await m.repositorio.interno();
  const dono = await interno.dono();
  await dono.query(`begin; ${sqlConcessaoDeAutomacao(ORG_A, UNI_A)} commit;`);
  const escopo = { organizacaoId: ORG_A, unidadeId: UNI_A };
  const token = await interno.sessoes.emitir({ ...escopo, usuarioId: IDENTIDADE_DE_AUTOMACAO, permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] });
  for (const t of ["fv2_movimentacao", "fv2_liquidacao", "fv2_ajuste", "fv2_concessao"]) {
    await assert.rejects(comoAplicacao(interno, escopo, (cl) => cl.query(`insert into ${t} (id) values (gen_random_uuid())`), { token }), /identidade técnica|permission denied/, t);
  }
});
test("banco: o instalador sem acesso às sessões cria a concessão técnica, e a identidade segue bloqueada", { skip: !EM_POSTGRES }, async () => {
  const m = await preparado();
  const interno = await m.repositorio.interno();
  const dono = await interno.dono();
  const papel = `fv2_instalador_${process.pid}`;
  await dono.query(`create role ${papel} nologin bypassrls; grant usage on schema financeiro_v2 to ${papel};
    grant select, insert on all tables in schema financeiro_v2 to ${papel}; grant execute on all functions in schema financeiro_v2 to ${papel};
    revoke execute on function financeiro_v2.fv2__sessao_vigente() from ${papel};`);
  try {
    await dono.query(`begin; set local role ${papel}; ${sqlConcessaoDeAutomacao(ORG_A, UNI_A)} commit;`);
  } catch (e) { await dono.query("rollback"); throw e; } finally {
    await dono.query(`drop owned by ${papel}; drop role ${papel};`);
  }
  const { rows } = await dono.query("select acoes from financeiro_v2.fv2_concessao where usuario_id = $1", [IDENTIDADE_DE_AUTOMACAO]);
  assert.deepEqual(rows.map((r) => r.acoes), [["financeiro_v2.registrar", "financeiro_v2.ver"]]);
  const escopo = { organizacaoId: ORG_A, unidadeId: UNI_A };
  const token = await interno.sessoes.emitir({ ...escopo, usuarioId: IDENTIDADE_DE_AUTOMACAO, permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] });
  await assert.rejects(comoAplicacao(interno, escopo, (cl) => cl.query("insert into fv2_liquidacao (id) values (gen_random_uuid())"), { token }), /identidade técnica/);
});
test("ativação: semana 09 a 15/11 vence em 18/11 e o agendador não recria o histórico já reconciliado", async () => {
  assert.equal(semanaDe("2026-11-09").vencimento, "2026-11-18");
  const m = await preparado({ agora: "2026-11-18T15:00:00.000Z", inicioDaOperacao: "2026-11-23" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Reconciliada antes da ativação." });
  m.estado.agora = "2026-11-30T12:00:00.000Z";
  m.estado.apuracao = { ...base(), dias: dias("2026-11-23") };
  const r = await m.n.executarCicloDeEntregadores(m.c);
  assert.deepEqual(r.semanas.map((s) => s.inicio), ["2026-11-23"]);
  const contas = await m.n.consultarContasAPagar(m.c, {});
  assert.equal(contas.itens.filter((t) => t.vencimento === "2026-11-11").length, 2);
});

test("reconciliação histórica: pago, parcial e aberto ficam corretos, sem nova saída nem despesa em dobro", async () => {
  const a = { ...base(), entregas: [entrega(1, "Quitado", "2026-11-02", 1000), entrega(2, "Parcial", "2026-11-03", 1620), entrega(3, "Aberto", "2026-11-04", 800), entrega(4, "Dividido", "2026-11-05", 2250)] };
  const m = await preparado({ apuracao: a, agora: "2026-11-18T15:00:00.000Z", inicioDaOperacao: "2026-11-23" });
  const resultado = async () => (await m.n.apurarCompetencia(m.c, { competencia: "2026-11" })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
  const antes = await resultado();
  const manual = await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Entregador Dividido" }, valorOriginalCentavos: 1000, categoria: "OUTRAS_DESPESAS", descricao: "Conta manual da semana", competencia: "2026-11", dataEmissao: "2026-11-09", vencimento: "2026-11-11" });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Reconciliação sintética." });
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Reconciliação sintética." });
  await m.n.resolverDuplicidadeDoEntregador(m.c, { inicio: SEG, entregador: "dividido", decisao: "GERAR_DIFERENCA", obrigacaoManualId: manual.obrigacoes[0].id, justificativa: "A conta manual cobre parte." });
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  const baixar = async (chave, valor, valorMov = valor) => {
    const { movimentacao: mov } = await m.n.registrarMovimentacao(m.c, { contaId: banco.id, dataEfetiva: "2026-11-11", sentido: "SAIDA", valorCentavos: valorMov, natureza: "PAGAMENTO", descricao: `PIX ${chave}` });
    await m.n.reconhecerPagamentoHistorico(m.c, { inicio: SEG, entregador: chave, movimentacaoId: mov.id, justificativa: "PIX identificado no extrato." });
    await m.n.anexarDocumentoDoEntregador(m.c, nota({ entregador: chave, tipoAnexo: "COMPROVANTE", numero: undefined, arquivo: { conteudo: new Uint8Array(Buffer.from(`%PDF-1.4 ${chave}`)), nome: "c.pdf", tipoMime: "application/pdf" } }));
    const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: chave });
    await m.n.vincularPagamentoDoExtrato(m.c, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: d.obrigacaoId, valorCentavos: valor }], documentoId: d.documentos[0].id, justificativa: "PIX histórico.", confirmar: true });
  };
  await baixar("quitado", 1000);
  await baixar("parcial", 1450);
  await baixar("dividido", 1250, 2560);
  const f = Object.fromEntries((await m.n.consultarEntregadoresProprios(m.c, { semana: SEG })).fechamentos.map((x) => [x.entregador.chave, [x.situacaoPagamento, x.saldoCentavos]]));
  assert.deepEqual(f, { quitado: ["PAGO", 0], parcial: ["VENCIDO", 170], aberto: ["VENCIDO", 800], dividido: ["PAGO", 0] });
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 3);
  assert.equal(await resultado(), antes - 5670);
  const lanc = (await m.n.consultarRegistros(m.c, { tipo: "LANCAMENTO" })).filter((l) => l.categoria === "ENTREGADORES_PROPRIOS");
  assert.deepEqual([lanc.length, lanc.reduce((t, l) => t + l.valorCentavos, 0)], [4, 4670]);
});
test("bucket: script preparado é privado e limitado; cofre isola unidades e recusa caminho forjado", async () => {
  const sql = readFileSync(new URL("../../../database/financeiro-v2/producao/preparar-bucket-notas.sql", import.meta.url), "utf8");
  assert.match(sql, /'fv2-notas-entregadores', 'fv2-notas-entregadores', false, 10485760, array\['application\/pdf', 'image\/png', 'image\/jpeg'\]/);
  assert.doesNotMatch(sql, /create policy|grant /i);
  const guardados = new Map();
  const cofre = criarCofreNotasSupabase({ bucket: "b", supabase: { storage: { getBucket: async () => ({ data: { public: false } }), from: () => ({
    list: async (p, o) => ({ data: [...guardados.keys()].filter((k) => k === `${p}/${o.search}`).map((k) => ({ name: k.split("/").pop() })) }), upload: async (k, c) => { guardados.set(k, c); return {}; },
    download: async (k) => (guardados.has(k) ? { data: new Blob([guardados.get(k)]) } : { error: { message: "x" } }) }) } } });
  const g = await cofre.guardar({ organizacaoId: ORG_A, unidadeId: UNI_A }, { conteudo: PDF, tipoMime: "application/pdf" });
  assert.ok([...guardados.keys()][0].startsWith(`${ORG_A}/${UNI_A}/`));
  await rejeita(cofre.ler({ organizacaoId: ORG_A, unidadeId: UNI_A2 }, g.arquivoId), CODIGO.NAO_ENCONTRADO);
  await rejeita(cofre.ler({ organizacaoId: ORG_A, unidadeId: UNI_A }, "cofre:../../outra"), CODIGO.NAO_ENCONTRADO);
  assert.equal(Object.keys(cofre).some((k) => /remov|apag|url|delete/i.test(k)), false);
});
test("banco: o agendador fecha a semana e cria a conta, mas não paga, não baixa e não movimenta dinheiro", { skip: !EM_POSTGRES }, async () => {
  const m = await preparado();
  const interno = await m.repositorio.interno();
  await (await interno.dono()).query(`begin; ${sqlConcessaoDeAutomacao(ORG_A, UNI_A)} commit;`);
  const robo = ctx(ORG_A, UNI_A, ["financeiro_v2.ver", "financeiro_v2.registrar"], IDENTIDADE_DE_AUTOMACAO);
  const r = await m.n.executarCicloDeEntregadores(robo);
  assert.equal(r.semanas[0].contasCriadas, 2);
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  await assert.rejects(m.n.registrarMovimentacao(robo, { contaId: banco.id, dataEfetiva: "2026-11-09", sentido: "SAIDA", valorCentavos: 1500, natureza: "PAGAMENTO", descricao: "Tentativa" }));
  await assert.rejects(m.n.pagarContaAPagar(robo, { obrigacaoId: await contaDe(m), contaId: banco.id, dataEfetiva: "2026-11-09", valorCentavos: 1500 }));
  await assert.rejects(m.n.registrarAjuste(robo, { alvoTipo: "OBRIGACAO", alvoId: await contaDe(m), valorCentavos: -100, motivo: "Tentativa", categoria: "ENTREGADORES_PROPRIOS" }));
  assert.equal((await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length, 0);
  assert.equal((await m.n.consultarContasAPagar(m.c, {})).totais.saldoCentavos, 2400);
});

test("pedido adiado fica na semana da entrega, vence na quarta escolhida e não duplica valor nem despesa", async () => {
  const a = { ...base(), entregas: [entrega(10, "Normal", "2026-11-05", 45200), entrega(11, "Normal", "2026-11-05", 1300), entrega(12, "Sozinho", "2026-11-06", 800)] };
  const m = await preparado({ apuracao: a, agora: "2026-11-18T15:00:00.000Z", inicioDaOperacao: "2026-11-23" });
  const adiamentos = [{ numeroPedido: "11", vencimento: "2026-11-25" }, { numeroPedido: "12", vencimento: "2026-11-25" }];
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Teste.", adiamentos: [{ numeroPedido: "11", vencimento: "2026-11-24" }] }), CODIGO.DATA_INVALIDA);
  await rejeita(m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Teste.", adiamentos: [{ numeroPedido: "99", vencimento: "2026-11-25" }] }), CODIGO.ENTRADA_INVALIDA);
  const r = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Pagamento combinado para 25/11.", adiamentos });
  assert.deepEqual([r.contasCriadas, r.totalCentavos], [3, 47300]);
  const contas = (await m.n.consultarContasAPagar(m.c, {})).itens.map((t) => [t.fornecedor.nome, t.vencimento, t.saldoCentavos, t.competencia]).sort();
  assert.deepEqual(contas, [["Normal", "2026-11-11", 45200, "2026-11"], ["Normal", "2026-11-25", 1300, "2026-11"], ["Sozinho", "2026-11-25", 800, "2026-11"]]);
  const f = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "normal" });
  assert.equal(f.valorCentavos, 46500);
  const repetido = await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG, reconciliacao: true, justificativa: "Repetição.", adiamentos });
  assert.deepEqual([repetido.repetido, (await m.n.consultarContasAPagar(m.c, {})).quantidade], [true, 3]);
  const lanc = (await m.n.consultarRegistros(m.c, { tipo: "LANCAMENTO" })).filter((l) => l.categoria === "ENTREGADORES_PROPRIOS");
  assert.equal(lanc.reduce((t, l) => t + l.valorCentavos, 0), 47300);
  const banco = await m.n.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  const adiada = (await m.n.consultarContasAPagar(m.c, {})).itens.find((t) => t.vencimento === "2026-11-25" && t.fornecedor.nome === "Normal");
  await assert.rejects(m.n.pagarContaAPagar(m.c, { obrigacaoId: adiada.id, contaId: banco.id, dataEfetiva: "2026-11-18", valorCentavos: 1300 }), (e) => e.detalhes?.motivo === "ENTREGADOR_SEM_LIBERACAO_DOCUMENTAL");
});

test("calendário: conta de entregador mostra se a nota foi enviada (pendente até anexar)", async () => {
  const m = await preparado();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  const titulos = async () => (await m.n.consultarCalendarioFinanceiro(m.c, { mes: "2026-11" })).dias.find((d) => d.data === "2026-11-11").titulos;
  assert.deepEqual((await titulos()).map((t) => t.notaEntregador), [{ enviada: false }, { enviada: false }]);
  await m.n.anexarDocumentoDoEntregador(m.c, nota());
  const marcas = Object.fromEntries((await titulos()).map((t) => [t.fornecedor, t.notaEntregador.enviada]));
  assert.deepEqual(marcas, { Mauricio: true, Rafael: false });
});
