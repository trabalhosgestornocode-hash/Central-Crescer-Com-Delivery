// Serviços extras dos entregadores: separados das taxas Foody, sem cobrança, saída ou despesa em dobro. Dados SINTÉTICOS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODIGO, criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { resumoDaSemana } from "../../src/modules/financeiro-v2/aplicacao/extrasEntregadores.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, montar as montarNucleo, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";
import { EM_POSTGRES, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const SEG = "2026-11-09";
const dias = Array.from({ length: 7 }, (_, i) => ({ data: `2026-11-${String(9 + i).padStart(2, "0")}`, fonte: "foody", provisorio: false, aberto: false, triagem: 0 }));
const taxa = (id, valor) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: "alfa", entregadorNome: "Alfa", data: "2026-11-10", numeroPedido: String(id), situacao: "Finalizado", valorCentavos: valor, elegivel: true, emRevisao: false });
async function montar(agora = "2026-11-16T15:00:00.000Z") {
  const repositorio = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const cofre = criarCofreMemoria();
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date(agora), cofre, entregadores: { fonte: { apurar: async () => ({ disponivel: true, dias, entregas: [taxa(1, 20000)] }) }, inicioDaOperacao: SEG, cofreDeNotas: cofre } });
  const c = ctx(ORG_A, UNI_A, TODAS);
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Teste", instituicao: "Teste" });
  return { n, c, caixa, banco };
}
const extra = (o = {}) => ({ entregador: "alfa", entregadorNome: "Alfa", data: "2026-11-12", descricao: "Serviço extra de entregas", valorCentavos: 3100, situacao: "PAGO", meioPagamento: "DINHEIRO", justificativa: "Confirmado pelo responsável.", ...o });
const saida = (m, conta, valor = 3100) => m.n.registrarMovimentacao(m.c, { contaId: conta.id, dataEfetiva: "2026-11-12", sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO", descricao: "Saída sintética" });
const resumo = async (m) => (await m.n.consultarEntregadoresProprios(m.c, { semana: SEG })).resumoSemana;
const resultado = async (m) => (await m.n.apurarCompetencia(m.c, { competencia: "2026-11" })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
const movimentos = async (m) => (await m.n.consultarCaixaEBancos(m.c, { inicio: "2026-11-01", fim: "2026-11-30" })).movimentos.length;
const contas = async (m) => (await m.n.consultarContasAPagar(m.c, {})).itens;

test("1. extra ainda não pago entra no saldo e vira conta a pagar", async () => {
  const m = await montar();
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra({ situacao: "PENDENTE", meioPagamento: undefined }));
  assert.equal(x.situacao, "PENDENTE");
  assert.deepEqual([(await contas(m)).length, (await contas(m))[0].saldoCentavos], [1, 3100]);
  const r = await resumo(m);
  assert.deepEqual([r.extrasCentavos, r.saldoAbertoCentavos], [3100, 23100]);
});
test("2 e 5. extra pago em dinheiro não abate as taxas normais", async () => {
  const m = await montar();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await m.n.registrarExtraDoEntregador(m.c, extra());
  const r = await resumo(m);
  assert.deepEqual([r.taxasFoodyCentavos, r.extrasCentavos, r.totalDevidoCentavos, r.totalPagoCentavos, r.saldoAbertoCentavos, r.aguardandoVinculoCentavos], [20000, 3100, 23100, 3100, 20000, 3100]);
  assert.equal((await contas(m))[0].saldoCentavos, 20000);
});
test("3. extra pago por Pix reutiliza a saída do extrato, sem nova saída", async () => {
  const m = await montar();
  const { movimentacao: mov } = await saida(m, m.banco);
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra({ meioPagamento: "PIX", movimentacaoId: mov.id }));
  assert.deepEqual([x.situacao, x.movimentacaoId, await movimentos(m)], ["PAGO", mov.id, 1]);
  assert.equal((await contas(m))[0].saldoCentavos, 0);
});
test("4 e 13. semana com taxas e extras mostra os componentes separados", () => {
  const r = resumoDaSemana([{ chave: "a", nome: "A", valorCentavos: 20000, pagoCentavos: 0 }], [{ entregador: { chave: "a", nome: "A" }, situacao: "PAGO", valorCentavos: 3100, pagoCentavos: 3100 }, { entregador: { chave: "a", nome: "A" }, situacao: "PENDENTE", valorCentavos: 500, pagoCentavos: 0 }]);
  assert.deepEqual([r.taxasFoodyCentavos, r.extrasCentavos, r.totalDevidoCentavos, r.totalPagoCentavos, r.saldoAbertoCentavos], [20000, 3600, 23600, 3100, 20500]);
});
test("6, 9 e 10. conta quitada existente é reutilizada: sem nova cobrança, despesa ou saída", async () => {
  const m = await montar();
  const r = await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Apelido do entregador" }, valorOriginalCentavos: 3100, categoria: "OUTRAS_DESPESAS", descricao: "Taxas do entregador", competencia: "2026-11", dataEmissao: "2026-11-12", vencimento: "2026-11-12" });
  await m.n.pagarContaAPagar(m.c, { obrigacaoId: r.obrigacoes[0].id, contaId: m.caixa.id, dataEfetiva: "2026-11-12", valorCentavos: 3100 });
  const [dre, mov, qtd] = [await resultado(m), await movimentos(m), (await contas(m)).length];
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra({ obrigacaoExistenteId: r.obrigacoes[0].id }));
  assert.deepEqual([x.situacao, await resultado(m), await movimentos(m), (await contas(m)).length], ["PAGO", dre, mov, qtd]);
  assert.equal((await resumo(m)).aguardandoVinculoCentavos, 0);
});
test("7. saída de caixa já existente é vinculada depois, com rastreabilidade e sem segunda saída", async () => {
  const m = await montar();
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra());
  const { movimentacao: mov } = await saida(m, m.caixa);
  const v = await m.n.vincularExtraAoCaixa(m.c, { extraId: x.id, movimentacaoId: mov.id, justificativa: "Saída conferida pelo responsável." });
  assert.deepEqual([v.situacao, v.movimentacaoId, await movimentos(m)], ["PAGO", mov.id, 1]);
  await rejeita(m.n.registrarExtraDoEntregador(m.c, extra({ descricao: "Outro serviço", movimentacaoId: mov.id })), CODIGO.OPERACAO_INVALIDA);
});
test("8. saída com o mesmo valor e data nunca é vinculada sozinha", async () => {
  const m = await montar();
  await saida(m, m.caixa);
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra());
  assert.deepEqual([x.situacao, x.movimentacaoId, x.obrigacaoId], ["PAGO_AGUARDANDO_VINCULO", null, null]);
});
test("conta parecida exige decisão antes de registrar outro extra", async () => {
  const m = await montar();
  await m.n.registrarObrigacao(m.c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Outro nome" }, valorOriginalCentavos: 3100, categoria: "OUTRAS_DESPESAS", descricao: "Conta parecida", competencia: "2026-11", dataEmissao: "2026-11-12", vencimento: "2026-11-12" });
  await assert.rejects(m.n.registrarExtraDoEntregador(m.c, extra()), (e) => e.detalhes?.motivo === "POSSIVEL_DUPLICIDADE");
  assert.equal((await m.n.registrarExtraDoEntregador(m.c, extra({ confirmarSemDuplicidade: true }))).extra.situacao, "PAGO_AGUARDANDO_VINCULO");
});
test("11. reprocessar o mesmo extra não duplica", async () => {
  const m = await montar();
  const a = await m.n.registrarExtraDoEntregador(m.c, extra({ situacao: "PENDENTE", meioPagamento: undefined }));
  const b = await m.n.registrarExtraDoEntregador(m.c, extra({ situacao: "PENDENTE", meioPagamento: undefined }));
  assert.deepEqual([b.repetido, b.extra.id, (await contas(m)).length], [true, a.extra.id, 1]);
});
test("12. extra depois do fechamento não muda o valor fechado da semana", async () => {
  const m = await montar();
  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG });
  await m.n.registrarExtraDoEntregador(m.c, extra({ situacao: "PENDENTE", meioPagamento: undefined }));
  const d = await m.n.detalharFechamentoDoEntregador(m.c, { inicio: SEG, entregador: "alfa" });
  assert.deepEqual([d.valorCentavos, d.extras.length, (await contas(m)).length], [20000, 1, 2]);
});
test("14. outra unidade não vê nem vincula o extra", async () => {
  const m = await montar();
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra());
  const outra = ctx(ORG_A, UNI_A2, TODAS);
  await rejeita(m.n.cancelarExtraDoEntregador(outra, { extraId: x.id, justificativa: "Tentativa indevida." }), CODIGO.NAO_ENCONTRADO);
  assert.equal((await m.n.consultarEntregadoresProprios(outra, { semana: SEG })).extras.length, 0);
});
test("15. permissões: sem registrar não cria; sem corrigir não cancela", async () => {
  const m = await montar();
  const so = ctx(ORG_A, UNI_A, ["financeiro_v2.ver"]);
  await rejeita(m.n.registrarExtraDoEntregador(so, extra()), CODIGO.PERMISSAO_INSUFICIENTE);
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra());
  await rejeita(m.n.cancelarExtraDoEntregador(ctx(ORG_A, UNI_A, ["financeiro_v2.ver", "financeiro_v2.registrar"]), { extraId: x.id, justificativa: "Sem permissão." }), CODIGO.PERMISSAO_INSUFICIENTE);
});
test("16. auditoria guarda responsável, justificativa e vínculo", async () => {
  const m = await montar();
  const { extra: x } = await m.n.registrarExtraDoEntregador(m.c, extra());
  assert.deepEqual([x.dados.responsavel, x.dados.justificativa, x.versao], [m.c.usuarioId, "Confirmado pelo responsável.", 1]);
  const { movimentacao: mov } = await saida(m, m.caixa);
  assert.equal((await m.n.vincularExtraAoCaixa(m.c, { extraId: x.id, movimentacaoId: mov.id, justificativa: "Conferido." })).versao, 2);
});
test("7b. sangria da SAIPOS confirmada é associada à conta já paga, sem segunda despesa nem nova retirada", async () => {
  const { nucleo: n } = montarNucleo({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  const c = ctx();
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const d = "12/11/2026";
  const arquivo = Buffer.from(xlsx([{ nome: "Financeiro", linhas: [["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"], [d, d, d, "Cofre", null, "Frente de Caixa", 31, "Sim", null, "Retirada de Frente de Caixa"]] }])).toString("base64");
  const r = await ESCRITAS["/importacao/receber"].fazer(n, c, { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", arquivoBase64: arquivo, nomeArquivo: "financeiro.xlsx" });
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Importação sintética." });
  const [sangria] = (await n.consultarRegistros(c, { tipo: "REGISTRO_FONTE" })).filter((x) => x.tipoRelatorio === "SAIPOS_MOVIMENTOS_CAIXA");
  const o = (await n.registrarObrigacao(c, { contraparteNova: { tipo: "FORNECEDOR", nome: "Apelido do entregador" }, valorOriginalCentavos: 3100, categoria: "OUTRAS_DESPESAS", descricao: "Taxas do entregador", competencia: "2026-11", dataEmissao: "2026-11-12", vencimento: "2026-11-12" })).obrigacoes[0];
  await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: caixa.id, dataEfetiva: "2026-11-12", valorCentavos: 3100 });
  await rejeita(n.registrarExtraDoEntregador(c, extra({ valorCentavos: 3000, obrigacaoExistenteId: o.id, registroFonteId: sangria.id })), CODIGO.OPERACAO_INVALIDA);
  const { extra: x } = await n.registrarExtraDoEntregador(c, extra({ obrigacaoExistenteId: o.id, registroFonteId: sangria.id }));
  assert.deepEqual([x.situacao, x.dados.registroFonteId], ["PAGO", sangria.id]);
  const previa = await CONSULTAS["/sangrias-despesa"](n, c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.deepEqual([previa.resumo.novas.quantidade, previa.resumo.jaLancadasManualmente.quantidade], [0, 1]);
  assert.equal((await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 1);
});
test("extra reconhecido de quem não tem taxa na semana não vira 'conta manual já lançada' na prévia nem no fechamento", async () => {
  const m = await montar();
  await m.n.registrarExtraDoEntregador(m.c, extra({ entregador: "beta", entregadorNome: "Beta", situacao: "PENDENTE", meioPagamento: undefined }));
  assert.ok(!(await m.n.previaDoFechamentoSemanal(m.c, { inicio: SEG })).pendencias.some((p) => p.codigo === "CONTA_MANUAL_SEM_ENTREGADOR"));
  assert.equal((await m.n.fecharSemanaDeEntregadores(m.c, { inicio: SEG })).situacao, "CONSOLIDADA");
});
