// Quantidade de entregas nas linhas de entrega da DRE (Entregadores Próprios, Entregas terceirizadas, Entrega Sob Demanda).
// Dados SINTÉTICOS. Nada muda nos valores da DRE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contarEntregasProprias, contarEntregasSobDemanda, contarEntregasTerceirizadas, quantidadeNaDescricao, SITUACAO_QUANTIDADE as S } from "../../src/modules/financeiro-v2/aplicacao/quantidadesDeEntregas.js";
import { GRUPOS_DE_APRESENTACAO } from "../../src/modules/financeiro-v2/dominio/apuracao.js";
import { ESCOPOS_PADRAO, ORG_A, UNI_A2, ctx, montar } from "./helpers/cenario.js";
import { criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";

const P = { inicio: "2026-11-01", fim: "2026-11-30" };
const e = (id, extra = {}) => ({ id, tipo: "ENTREGA", entregadorChave: "ana", entregadorNome: "Ana", data: "2026-11-03", valorCentavos: 700, elegivel: true, ...extra });

test("entregas próprias: só ENTREGA elegível com entregador; pagamentos/ajustes/manuais não contam; repetidas contam uma vez", () => {
  const apuracao = { disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody" }], entregas: [
    e("p1"), e("p1"), e("p2", { motivo: "Cancelado com direito à taxa" }), e("p3", { elegivel: false }), e("p4", { entregadorChave: null }),
    e("l1", { tipo: "TAXA_ADICIONAL" }), e("l2", { tipo: "ENTREGA_MANUAL" }), e("l3", { tipo: "AJUSTE" }), e("fora", { data: "2026-10-31" }),
  ] };
  const r = contarEntregasProprias(apuracao, P);
  assert.deepEqual([r.situacao, r.quantidade, r.provisorio], [S.COM_DADOS, 2, false]);
});

test("entregas próprias: zero com dados ≠ sem dados ≠ fonte fora do ar", () => {
  assert.deepEqual([contarEntregasProprias({ disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody" }], entregas: [] }, P).situacao, contarEntregasProprias({ disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody" }], entregas: [] }, P).quantidade], [S.COM_DADOS, 0]);
  assert.equal(contarEntregasProprias({ disponivel: true, dias: [{ data: "2026-11-03", fonte: null }], entregas: [] }, P).situacao, S.SEM_DADOS);
  assert.equal(contarEntregasProprias({ disponivel: false, motivo: "FALHA_NA_LEITURA" }, P).situacao, S.INDISPONIVEL);
  assert.equal(contarEntregasProprias({ disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody", aberto: true }], entregas: [e("p1")] }, P).provisorio, true);
});

test("sob demanda: pedidos distintos com cobrança líquida; estorno integral não conta; sem importação = SEM_DADOS", () => {
  const m = (pedido, v, componente = "ENTREGA_SOB_DEMANDA") => ({ valorCentavos: v, dados: { pedido, componente } });
  const r = contarEntregasSobDemanda([m("a", -1199), m("a", -1199), m("b", -1299), m("b", 1299), m("c", -1099), m("d", -500, "COMISSAO")]);
  assert.deepEqual([r.situacao, r.quantidade, r.valorCentavos], [S.COM_DADOS, 2, 3497]);
  assert.equal(contarEntregasSobDemanda([]).situacao, S.SEM_DADOS);
});

test("terceirizadas: quantidade da descrição de cada lançamento; sem quantidade = parcial; ajuste negativo não conta", () => {
  assert.deepEqual(["HASTAG ENTREGAS DE 02/11 A 08/11 (159 ENTREGAS)", "Entregas 09/11 a 15/11 - 151 entregas", "1 entrega avulsa", "ENTREGAS DE 02/11 A 08/11", "Pagamento R$ 1.712,50"].map(quantidadeNaDescricao), [159, 151, 1, null, null]);
  const l = (descricao, valorCentavos = 100, situacao = "ATIVO") => ({ descricao, valorCentavos, situacao });
  const r = contarEntregasTerceirizadas([l("A (159 ENTREGAS)"), l("B (151 ENTREGAS)"), l("C (40 ENTREGAS)", 100, "CANCELADO"), l("Correção de valor", -50)]);
  assert.deepEqual([r.situacao, r.quantidade, r.parcial, r.lancamentos], [S.COM_DADOS, 310, false, 2]);
  const p = contarEntregasTerceirizadas([l("A (159 ENTREGAS)"), l("Nota da empresa de entregas")]);
  assert.deepEqual([p.quantidade, p.parcial, p.semQuantidade], [159, true, 1]);
  assert.equal(contarEntregasTerceirizadas([]).situacao, S.SEM_DADOS);
  assert.equal(contarEntregasTerceirizadas([l("Nota da empresa de entregas")]).situacao, S.SEM_DADOS);
});

test("núcleo: terceirizadas pela descrição dos lançamentos da competência; sem porta do parser = sem fonte; unidade isolada", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00Z"), plano: "SUBWAY" });
  const vazio = await n.quantidadesDeEntregas(ctx(), { competencia: "2026-11" });
  assert.deepEqual([vazio.linhas.ENTREGAS_TERCEIRIZADAS.situacao, vazio.linhas.ENTREGAS_TERCEIRIZADAS.quantidade], [S.SEM_DADOS, null]);
  const forn = await n.registrarContraparte(ctx(), { tipo: "FORNECEDOR", nome: "Empresa de entregas (sintética)" });
  for (const [d, q] of [["02/11 A 08/11", 159], ["09/11 A 15/11", 151]]) await n.registrarObrigacao(ctx(), { contraparteId: forn.id, valorOriginalCentavos: q * 1000, categoria: "ENTREGAS_TERCEIRIZADAS", descricao: `ENTREGAS DE ${d} (${q} ENTREGAS)`, competencia: "2026-11", dataEmissao: "2026-11-11", vencimento: "2026-11-11" });
  await n.registrarObrigacao(ctx(), { contraparteId: forn.id, valorOriginalCentavos: 5000, categoria: "ENTREGAS_TERCEIRIZADAS", descricao: "ENTREGAS DE OUTUBRO (99 ENTREGAS)", competencia: "2026-10", dataEmissao: "2026-10-30", vencimento: "2026-10-30" });
  const r = await n.quantidadesDeEntregas(ctx(), { competencia: "2026-11" });
  assert.deepEqual([r.linhas.ENTREGAS_TERCEIRIZADAS.situacao, r.linhas.ENTREGAS_TERCEIRIZADAS.quantidade, r.linhas.ENTREGAS_TERCEIRIZADAS.parcial], [S.COM_DADOS, 310, false]);
  assert.equal((await n.quantidadesDeEntregas(ctx(ORG_A, UNI_A2), { competencia: "2026-11" })).linhas.ENTREGAS_TERCEIRIZADAS.situacao, S.SEM_DADOS);

  assert.equal(r.linhas.ENTREGADORES_PROPRIOS.situacao, S.SEM_FONTE);
  assert.equal(r.linhas.ENTREGA_SOB_DEMANDA.situacao, S.SEM_DADOS);
  const fonte = { apurar: async (p) => ({ disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody" }], entregas: p.unidadeId === ctx().unidadeId ? [e("p1"), e("p2")] : [] }) };
  const n2 = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date("2026-11-20T15:00:00Z"), entregadores: { fonte } });
  assert.equal((await n2.quantidadesDeEntregas(ctx(), { competencia: "2026-11" })).linhas.ENTREGADORES_PROPRIOS.quantidade, 2);
});

test("DRE: as cobranças diárias de sob demanda do iFood viram um nó próprio (apresentação), sem mudar valores", () => {
  const [g] = GRUPOS_DE_APRESENTACAO;
  assert.equal(g.codigo, "ENTREGA_SOB_DEMANDA");
  assert.equal(g.casa({ fonte: { idExterno: "ifood-conciliacao:2026-11-02:ENTREGA_SOB_DEMANDA:v1" } }), true);
  assert.equal(g.casa({ fonte: { idExterno: "ifood-conciliacao:2026-11-02:COMISSOES:v1" } }), false);
  assert.equal(g.casa({ fonte: null }), false);
});

test("DRE: Entrega Sob Demanda fica junto das outras linhas de entrega (irmã de Comissões), com o mesmo total da linha", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00Z"), plano: "SUBWAY" });
  const c = ctx();
  const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Plataforma (sintética)" });
  const conta = (categoria, valor, descricao, extra = {}) => n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: valor, categoria, descricao, competencia: "2026-11", dataEmissao: "2026-11-05", vencimento: "2026-11-05", ...extra });
  await conta("COMISSOES_DE_PLATAFORMA", 50000, "Comissões da plataforma (sintético)");
  await conta("ENTREGAS_TERCEIRIZADAS", 30000, "Empresa de entregas (10 ENTREGAS)");
  await conta("COMISSOES_DE_PLATAFORMA", 1199, "Entrega sob demanda contratada no iFood de 2026-11-02", { fonte: { sistema: "IFOOD", idExterno: "ifood-conciliacao:2026-11-02:ENTREGA_SOB_DEMANDA:v1" } });
  const dre = (await n.apurarCompetencia(c, { competencia: "2026-11" })).dre;
  const linha = dre.linhas.find((l) => l.codigo === "DESPESAS_OPERACIONAIS");
  const achar = (nos, pred, pai = null) => { for (const no of nos) { if (pred(no)) return { no, pai }; const r = achar(no.filhos ?? [], pred, no); if (r) return r; } return null; };
  const sob = achar(linha.componentes, (x) => x.referencias?.grupo === "ENTREGA_SOB_DEMANDA");
  const comissoes = achar(linha.componentes, (x) => x.referencias?.categoria === "COMISSOES_DE_PLATAFORMA");
  const terceirizadas = achar(linha.componentes, (x) => x.referencias?.categoria === "ENTREGAS_TERCEIRIZADAS");
  assert.equal(sob.pai.id, terceirizadas.pai.id, "mesmo pai das Entregas terceirizadas");
  assert.equal(sob.pai.id, comissoes.pai.id, "irmã de Comissões, não dentro dela");
  assert.equal(Math.abs(sob.no.valorCentavos), 1199);
  assert.equal(Math.abs(comissoes.no.valorCentavos), 50000, "Comissões sem a sob demanda");
  assert.equal(Math.abs(linha.valorCentavos), 50000 + 30000 + 1199, "total da linha inalterado");
});

test("entregadores próprios: quantidade das semanas fechadas que formam a linha (sem provisório); conta sem fechamento = parcial", async () => {
  const { contarEntregasDasSemanasFechadas } = await import("../../src/modules/financeiro-v2/aplicacao/quantidadesDeEntregas.js");
  const l = (id, valorCentavos = 1000, situacao = "ATIVO") => ({ id, valorCentavos, situacao });
  const o = (id, lancamentoId) => ({ id, lancamentoId });
  const f = (obrigacaoId, entregas) => ({ obrigacaoId, entregas });
  assert.equal(contarEntregasDasSemanasFechadas([], [], []), null);
  const r = contarEntregasDasSemanasFechadas([l("l1"), l("l2"), l("l3", 1000, "CANCELADO")], [o("o1", "l1"), o("o2", "l2"), o("o3", "l3")], [f("o1", 120), f("o2", 80), f("o3", 999)]);
  assert.deepEqual([r.situacao, r.quantidade, r.provisorio, r.parcial, r.fonte], [S.COM_DADOS, 200, false, false, "SEMANAS_FECHADAS"]);
  const p = contarEntregasDasSemanasFechadas([l("l1"), l("l4")], [o("o1", "l1"), o("o4", "l4")], [f("o1", 120)]);
  assert.deepEqual([p.quantidade, p.parcial, p.semQuantidade], [120, true, 1]);
});
