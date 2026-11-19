// VR/VT pagos em dinheiro pelo caixa SWF (regra confirmada em 19/11/2026): Benefícios de pessoal > Vale-refeição / Vale-transporte.
// Antes de lançar: obrigação provisionada → BAIXA (sem despesa nova); benefício já pago (conta quitada ou saída do banco) → BLOQUEIO;
// nada → despesa nova já paga. DRE uma vez na competência; fluxo de caixa uma vez na data REAL. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const JUST = "Conferido com o relatório sintético de sangrias.";
const LOJA = "SUBWAY LOJA SINTETICA";
const CAB = ["", "  Data/Hora", "", "    Motivo", "", "", "", "    Operador", "", "Valor "];
const mov = (dh, motivo, valor) => ["", "", dh, motivo, "", "", "", " OPERADORA SINTETICA", "", valor];
const sub = (n, v) => ["", "", ` (${n})`, "", "", "", "", "", "", `R$ ${v}`];
/** 01/11 (madrugada, "referente a 31") + 13/11 (VR e VT de uma pessoa, um deles de madrugada do dia 14). Total R$ 126,00. */
const arquivo = () => xlsx([{ nome: "sangrias", linhas: [
  ["", "", "", "", "SANGRIAS"], ["", "", "", "", LOJA], ["", "  01/11/2026 a 17/11/2026"], CAB,
  ["", "  Dom, 01/11/2026"], mov("01/11/2026 03:06:20", "VALE REFEICAO E ALIMENTACA LAMBDA REFERENTE A 31", "21,00"), sub(1, "21,00"),
  ["", "  Sex, 13/11/2026"], mov("13/11/2026 23:37:56", "VR KAPPA", "70,00"), mov("14/11/2026 00:01:11", "VT KAPPA", "35,00"), sub(2, "105,00"),
  ["", " (3)", "", "", "", "", "", "", "", "R$ 126,00"],
] }]);

async function unidade() {
  const { nucleo: n } = montar({ relogio: () => AGORA });
  const W = (k, b) => ESCRITAS[k].fazer(n, c, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Subway sintética", justificativa: JUST });
  await n.configurarFontesDeFaturamento(c, { fontes: ["SWF", "IFOOD"], lojasSwf: [LOJA], justificativa: JUST });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Unicred (sintética)", instituicao: "Banco sintético" });
  const r = await n.receberArquivoParaImportacao(c, { fonte: "OUTRO", tipoRelatorio: "SWF_SANGRIAS", tipoMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", conteudo: arquivo(), periodoInicio: "2026-11-01", periodoFim: "2026-11-17" });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  const previa = () => CONSULTAS["/sangrias-swf"](n, c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  const item = async (motivo) => (await previa()).itens.find((i) => i.descricao === motivo);
  const lancar = (ids, competencias) => W("/sangrias-swf/lancar", { periodoInicio: "2026-11-01", periodoFim: "2026-11-30", registros: ids.join(","), ...(competencias ? { competencias } : {}), justificativa: JUST });
  const provisionar = async ({ descricao, categoria = "VALE_REFEICAO", valor = 7000, competencia = "2026-11", pagarPeloBanco = false, fornecedor = "Folha (benefícios)" }) => {
    const f = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: fornecedor });
    const o = (await n.registrarObrigacao(c, { contraparteId: f.id, valorOriginalCentavos: valor, categoria, descricao, competencia, dataEmissao: `${competencia}-05`, vencimento: `${competencia}-20` })).obrigacoes[0];
    if (pagarPeloBanco) await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: banco.id, dataEfetiva: `${competencia}-10`, valorCentavos: valor });
    return o;
  };
  const registros = async (tipo) => n.consultarRegistros(c, { tipo });
  return { n, caixa, banco, previa, item, lancar, provisionar, registros };
}

test("sem provisão nem pagamento anterior: VR e VT viram despesa de benefício PAGA (subcategoria), DRE uma vez, caixa na data real", async () => {
  const u = await unidade();
  const vr = await u.item("VR KAPPA");
  const vt = await u.item("VT KAPPA");
  assert.deepEqual([vr.naturezaSugerida, vr.categoriaSugerida, vr.destino, vr.competencia], ["BENEFICIO", "VALE_REFEICAO", "CRIAR_DESPESA_PAGA", "2026-11"]);
  assert.deepEqual([vt.categoriaSugerida, vt.data, vt.dataReal], ["VALE_TRANSPORTE", "2026-11-13", "2026-11-14"]);
  const r = await u.lancar([vr.registroId, vt.registroId]);
  assert.equal(r.lancadas.length, 2, JSON.stringify(r));
  const obr = (await u.registros("OBRIGACAO")).filter((o) => o.fonte?.sistema === "SWF");
  assert.deepEqual(obr.map((o) => [o.vencimento, o.competencia, o.saldoCentavos]).sort(), [["2026-11-13", "2026-11", 0], ["2026-11-13", "2026-11", 0]], "conta no dia operacional, quitada");
  const lancs = (await u.registros("LANCAMENTO")).filter((l) => l.situacao === "ATIVO" && ["VALE_REFEICAO", "VALE_TRANSPORTE"].includes(l.categoria));
  assert.deepEqual(lancs.map((l) => [l.categoria, l.valorCentavos, l.competencia]).sort(), [["VALE_REFEICAO", 7000, "2026-11"], ["VALE_TRANSPORTE", 3500, "2026-11"]], "DRE: uma despesa por retirada");
  const saidas = (await u.registros("MOVIMENTACAO")).filter((m) => m.contaId === u.caixa.id && m.sentido === "SAIDA");
  assert.deepEqual(saidas.map((m) => [m.dataEfetiva, m.valorCentavos]).sort(), [["2026-11-13", 7000], ["2026-11-14", 3500]], "fluxo de caixa: uma saída por retirada, na data REAL");
  // Repetir não lança de novo (nem DRE nem caixa).
  const de_novo = await u.lancar([vr.registroId, vt.registroId]);
  assert.equal(de_novo.lancadas.length, 0);
  assert.equal((await u.registros("MOVIMENTACAO")).filter((m) => m.contaId === u.caixa.id).length, 2);
  // Calendário do Balcão SWF: os dois no dia operacional 13/11, pagos, com categoria e hora real.
  const d13 = (await u.n.consultarCalendarioDeFaturamento(c, { canal: "BALCAO", mes: "2026-11" })).dias.find((d) => d.data === "2026-11-13");
  assert.deepEqual(d13.sangriasSwf.itens.map((i) => [i.descricao, i.situacao, i.formaPagamento, i.origem]).sort(), [["VR KAPPA", "PAGO", "DINHEIRO", "Caixa SWF"], ["VT KAPPA", "PAGO", "DINHEIRO", "Caixa SWF"]]);
});

test("obrigação de benefício provisionada (aberta) é BAIXADA pelo caixa: nenhuma despesa nova", async () => {
  const u = await unidade();
  const prov = await u.provisionar({ descricao: "VR KAPPA — novembro (folha)" });
  const lancsAntes = (await u.registros("LANCAMENTO")).filter((l) => l.situacao === "ATIVO").length;
  const vr = await u.item("VR KAPPA");
  assert.deepEqual([vr.destino, vr.correspondencia.obrigacao.obrigacaoId], ["BAIXAR_OBRIGACAO_EXISTENTE", prov.id]);
  const r = await u.lancar([vr.registroId]);
  assert.equal(r.lancadas[0].destino, "BAIXAR_OBRIGACAO_EXISTENTE");
  assert.equal((await u.registros("LANCAMENTO")).filter((l) => l.situacao === "ATIVO").length, lancsAntes, "a DRE já tinha a despesa provisionada: nada novo");
  const p = (await u.registros("OBRIGACAO")).find((o) => o.id === prov.id);
  assert.equal(p.saldoCentavos, 0);
  assert.equal((await u.registros("OBRIGACAO")).filter((o) => o.fonte?.sistema === "SWF").length, 0, "nenhuma conta nova");
  assert.deepEqual((await u.registros("MOVIMENTACAO")).filter((m) => m.contaId === u.caixa.id).map((m) => m.dataEfetiva), ["2026-11-13"]);
  assert.equal((await u.item("VR KAPPA")).situacaoPagamento, "PAGO", "depois da baixa a retirada aparece como paga");
  assert.equal((await u.lancar([vr.registroId])).lancadas.length, 0, "repetir não baixa de novo");
});

test("benefício já pago pelo banco (conta quitada ou saída sem conta) BLOQUEIA a retirada como possível duplicidade", async () => {
  const u = await unidade();
  await u.provisionar({ descricao: "VR KAPPA — novembro", pagarPeloBanco: true });
  const vr = await u.item("VR KAPPA");
  assert.deepEqual([vr.podeLancar, vr.situacaoPagamento, vr.correspondencia.situacao], [false, "BLOQUEADA", "DUPLICIDADE_POSSIVEL"]);
  assert.equal((await u.lancar([vr.registroId])).lancadas.length, 0);
  // Saída do banco com cara de VT, sem conta vinculada.
  await u.n.registrarMovimentacao(c, { contaId: u.banco.id, dataEfetiva: "2026-11-12", sentido: "SAIDA", valorCentavos: 3500, natureza: "PAGAMENTO", descricao: "PIX VT KAPPA" });
  const vt = await u.item("VT KAPPA");
  assert.deepEqual([vt.podeLancar, vt.correspondencia.situacao], [false, "DUPLICIDADE_POSSIVEL"]);
  assert.match(vt.pendencia, /Saída do banco/);
});

test("duas provisões abertas compatíveis: escolha manual (bloqueada); nome no motivo desempata", async () => {
  const u = await unidade();
  await u.provisionar({ descricao: "VR SIGMA — novembro", fornecedor: "Folha A" });
  await u.provisionar({ descricao: "VR OMEGA — novembro", fornecedor: "Folha B" });
  const vr = await u.item("VR KAPPA");
  assert.equal(vr.correspondencia.situacao, "AMBIGUA");
  assert.equal(vr.podeLancar, false);
  const u2 = await unidade();
  const certa = await u2.provisionar({ descricao: "VR KAPPA — novembro", fornecedor: "Folha A" });
  await u2.provisionar({ descricao: "VR SIGMA — novembro", fornecedor: "Folha B" });
  assert.equal((await u2.item("VR KAPPA")).correspondencia.obrigacao.obrigacaoId, certa.id);
});

test("\"referente a 31\" num fechamento de 01/11: competência escolhida na confirmação; pagamento continua na data real", async () => {
  const u = await unidade();
  const v = await u.item("VALE REFEICAO E ALIMENTACA LAMBDA REFERENTE A 31");
  assert.deepEqual([v.competenciaAConfirmar, v.competenciaOpcoes, v.madrugada], [true, ["2026-10", "2026-11"], true]);
  assert.match(v.pendencia, /referente a 31/);
  const sem = await u.lancar([v.registroId]);
  assert.deepEqual([sem.lancadas.length, sem.recusadas.length], [0, 1], "sem escolher a competência não lança");
  const fora = await u.lancar([v.registroId], `${v.registroId}=2026-09`);
  assert.equal(fora.lancadas.length, 0, "competência fora das opções é recusada");
  const ok = await u.lancar([v.registroId], `${v.registroId}=2026-10`);
  assert.equal(ok.lancadas.length, 1, JSON.stringify(ok));
  const o = (await u.registros("OBRIGACAO")).find((x) => x.fonte?.sistema === "SWF");
  assert.deepEqual([o.competencia, o.vencimento], ["2026-10", "2026-11-01"]);
  const l = (await u.registros("LANCAMENTO")).find((x) => x.situacao === "ATIVO" && x.categoria === "VALE_REFEICAO");
  assert.equal(l.competencia, "2026-10", "DRE de outubro, uma vez");
  assert.deepEqual((await u.registros("MOVIMENTACAO")).filter((m) => m.contaId === u.caixa.id).map((m) => m.dataEfetiva), ["2026-11-01"], "caixa na data real");
});
