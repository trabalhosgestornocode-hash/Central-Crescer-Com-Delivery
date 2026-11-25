// Metodologia de 25/11/2026 (dono): toda sangria/retirada importada do PDV (SAIPOS ou SWF) aparece PAGA no Contas a Pagar, com
// vencimento e pagamento no dia da retirada, pelo caixa físico, saldo zero, sem confirmação individual. Finalidade não identificada
// ⇒ categoria PROVISÓRIA das sangrias (classificação pendente ≠ pagamento pendente). Nada duplica. Dados SINTÉTICOS, em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCRITAS, lancarRetiradasImportadas } from "../../src/modules/fv2-integracao/escritas.js";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";
import { ORG_A, UNI_A2, ctx, montar } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const JUST = "Teste sintético.";
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// ------------------------------------------------------------------ SAIPOS
const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const ret = (dia, valor) => [`${dia}/11/2026`, `${dia}/11/2026`, `${dia}/11/2026`, "Cofre", null, "Frente de Caixa", valor, "Sim", null, "Retirada de Frente de Caixa"];
async function saipos(x = c, n0 = null) {
  const n = n0 ?? montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") }).nucleo;
  const W = (k, b) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Açaí sintético", justificativa: JUST });
  const caixa = await n.configurarContaFinanceira(x, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const importar = async (linhas) => {
    const r = await W("/importacao/receber", { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-24", arquivoBase64: b64(xlsx([{ nome: "Financeiro", linhas: [CAB, ...linhas] }])), nomeArquivo: "retiradas.xlsx" });
    return W("/importacao/confirmar", { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  };
  const contas = async () => (await n.consultarRegistros(x, { tipo: "OBRIGACAO" })).filter((o) => o.situacao !== "CANCELADA");
  const saidas = async () => (await n.consultarRegistros(x, { tipo: "MOVIMENTACAO" })).filter((m) => m.situacao !== "ESTORNADA" && m.sentido === "SAIDA");
  return { n, W, caixa, importar, contas, saidas };
}

test("RP-1 SAIPOS: confirmar a importação lança cada retirada PAGA no dia (vencimento = pagamento = data, caixa físico, saldo zero), sem confirmação individual", async () => {
  const u = await saipos();
  const r = await u.importar([ret("19", 15), ret("19", 150), ret("21", 40)]);
  assert.deepEqual([r.retiradasLancadasComoPagas.situacao, r.retiradasLancadasComoPagas.lancadas], ["FEITO", 3]);
  const contas = await u.contas();
  assert.equal(contas.length, 3);
  for (const o of contas) {
    assert.equal(o.situacao, "QUITADA"); assert.equal(o.saldoCentavos, 0);
    assert.ok(["2026-11-19", "2026-11-21"].includes(o.vencimento));
  }
  const saidas = await u.saidas();
  assert.deepEqual(saidas.map((m) => [m.dataEfetiva, m.valorCentavos, m.contaId === u.caixa.id]).sort(), [["2026-11-19", 1500, true], ["2026-11-19", 15000, true], ["2026-11-21", 4000, true]]);
});

test("RP-2 SAIPOS: reimportar não duplica; retirada já lançada à mão (mesmo dia e valor, paga pelo caixa) não ganha segunda conta", async () => {
  const u = await saipos();
  // lançamento manual pré-existente: R$ 86,00 em 06/11 pago pelo caixa (como a equipe fazia)
  const forn = await u.n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Sangrias" });
  const manual = await u.n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 8600, categoria: "OUTRAS_DESPESAS", descricao: "espátula + chaves", competencia: "2026-11", dataEmissao: "2026-11-06", vencimento: "2026-11-06" });
  await u.n.pagarContaAPagar(c, { obrigacaoId: manual.obrigacoes[0].id, contaId: u.caixa.id, dataEfetiva: "2026-11-06", valorCentavos: 8600 });
  await u.importar([ret("06", 86), ret("19", 15)]);
  await u.importar([ret("06", 86), ret("19", 15)]).catch(() => null); // mesmo arquivo de novo
  assert.equal((await u.contas()).length, 2, "a manual + só a de 19/11");
  assert.equal((await u.saidas()).length, 2, "nenhuma segunda saída de caixa");
});

test("RP-3 sem a permissão de registrar: a importação é confirmada e as retiradas ficam para lançar (nada é escondido)", async () => {
  const sem = ctx(undefined, undefined, Object.values(ACAO).filter((a) => a !== ACAO.REGISTRAR));
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "U", justificativa: JUST });
  await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const r = await ESCRITAS["/importacao/receber"].fazer(n, sem, { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-24", arquivoBase64: b64(xlsx([{ nome: "F", linhas: [CAB, ret("19", 15)] }])), nomeArquivo: "r.xlsx" });
  const conf = await ESCRITAS["/importacao/confirmar"].fazer(n, sem, { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  assert.equal(conf.importacao.estado.startsWith("IMPORTADO"), true);
  assert.equal(conf.retiradasLancadasComoPagas.situacao, "NAO_LANCADAS");
  assert.equal((await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 0);
  assert.equal(await lancarRetiradasImportadas(n, c, { tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-11-01", periodoFim: "2026-11-24" }), null, "outros relatórios não lançam nada");
});

test("RP-4 isolamento: retiradas da unidade A não aparecem nem são lançadas na unidade A2", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  const a = await saipos(c, n);
  await a.importar([ret("19", 15)]);
  const a2 = ctx(ORG_A, UNI_A2);
  await ESCRITAS["/configuracoes/unidade"].fazer(n, a2, { nomeExibicao: "Outra", justificativa: JUST });
  assert.equal((await n.consultarRegistros(a2, { tipo: "OBRIGACAO" })).length, 0);
  assert.equal((await n.consultarRegistros(a2, { tipo: "MOVIMENTACAO" })).length, 0);
});

// ------------------------------------------------------------------ SWF
const LOJA = "SUBWAY LOJA SINTETICA";
const CABS = ["", "  Data/Hora", "", "    Motivo", "", "", "", "    Operador", "", "Valor "];
const mov = (dh, motivo, valor) => ["", "", dh, motivo, "", "", "", " OPERADORA SINTETICA", "", valor];
const sub = (q, v) => ["", "", ` (${q})`, "", "", "", "", "", "", `R$ ${v}`];
const arquivoSwf = () => xlsx([{ nome: "sangrias", linhas: [
  ["", "", "", "", "SANGRIAS"], ["", "", "", "", LOJA], ["", "  02/11/2026 a 02/11/2026"], CABS,
  ["", "  Seg, 02/11/2026"], mov("02/11/2026 16:28:15", "SEGURANCA", "60,00"), mov("02/11/2026 17:00:00", "XPTO QUALQUER COISA", "15,00"), mov("02/11/2026 18:00:00", "ADIANTAMENTO PESSOA A", "50,00"), sub(3, "125,00"),
  ["", " (3)", "", "", "", "", "", "", "", "R$ 125,00"],
] }]);

test("RP-5 SWF: confirmar lança PAGAS a despesa reconhecida e a sem finalidade (categoria PROVISÓRIA das sangrias); adiantamento NÃO vira despesa", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00.000Z") });
  const W = (k, b) => ESCRITAS[k].fazer(n, c, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Subway sintética", justificativa: JUST });
  await n.configurarFontesDeFaturamento(c, { fontes: ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], lojasSwf: [LOJA], justificativa: JUST });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const r = await n.receberArquivoParaImportacao(c, { fonte: "OUTRO", tipoRelatorio: "SWF_SANGRIAS", tipoMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", conteudo: arquivoSwf(), periodoInicio: "2026-11-02", periodoFim: "2026-11-02" });
  const conf = await W("/importacao/confirmar", { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
  assert.equal(conf.retiradasLancadasComoPagas.lancadas, 2, JSON.stringify(conf.retiradasLancadasComoPagas));
  assert.equal(conf.retiradasLancadasComoPagas.pendentes.length, 1, "o adiantamento fica de fora, com motivo");
  const contas = (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).filter((o) => o.situacao !== "CANCELADA");
  assert.deepEqual(contas.map((o) => [o.valorBaseCentavos ?? o.valorOriginalCentavos, o.situacao, o.vencimento]).sort(), [[1500, "QUITADA", "2026-11-02"], [6000, "QUITADA", "2026-11-02"]]);
  const lanc = await n.consultarRegistros(c, { tipo: "LANCAMENTO" });
  const doProvisorio = lanc.find((l) => l.valorCentavos === 1500);
  assert.equal(doProvisorio.categoria ?? doProvisorio.categoriaCodigo, "OUTRAS_DESPESAS", "categoria provisória das sangrias");
  const saidas = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((m) => m.sentido === "SAIDA");
  assert.ok(saidas.every((m) => m.contaId === caixa.id && m.dataEfetiva === "2026-11-02"));
  const prev = await n.previaSangriasSwf(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-20" });
  assert.equal(prev.itens.find((i) => i.valorCentavos === 1500).classificacaoProvisoria, true);
});

test("RP-6 MOVA (sangrias_registradas): localiza a retirada paga no dia com valor e categoria; provisória sinalizada; outra fonte ignorada", async () => {
  const u = await saipos();
  await u.importar([ret("19", 15)]);
  const porta = { ler: (op, _e, a) => (op === "consultarSangriasSwf" ? Promise.reject(new Error("unidade sem SWF")) : u.n.previaSangriasComoDespesa(c, a)) };
  const r = await CATALOGO.sangrias_registradas.executar({ porta, escopo: {}, args: { inicio: "2026-11-01", fim: "2026-11-24" } });
  assert.equal(r.dados.pdv, "SAIPOS");
  const it = r.dados.itens.find((x) => x.valorCentavos === 1500);
  assert.deepEqual([it.data, it.paga, it.classificacaoProvisoria], ["2026-11-19", true, true]);
  assert.ok(r.fatos.some((f) => f.valorCentavos === 1500 && f.significado === "PAGO" && f.periodo === "2026-11-19"));
});
