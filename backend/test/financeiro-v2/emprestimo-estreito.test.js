// 27/11 — ação ESTREITA `registrar_emprestimo` (migração 0035): principal de empréstimo/financiamento, fora da DRE. Complemento das
// estreitas de conta (relatada em aberto; paga por comprovante; baixa de conta existente). Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const EMP = "EMPRESTIMOS_E_FINANCIAMENTOS";
const PROIBIDAS = ["DISTRIBUICAO_DE_LUCROS", "APORTES_E_RETIRADAS", "OPERACOES_ENTRE_EMPRESAS", "VALORES_DE_TERCEIROS", "PARCELAMENTO_TRIBUTARIO", "TITULOS_ANTERIORES_A_ABERTURA"];
const CONTA = [ACAO.VER, ACAO.REGISTRAR_CONTA_PARCELADA, ACAO.REGISTRAR_EMPRESTIMO];
const PAGAMENTO = [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO, ACAO.REGISTRAR_EMPRESTIMO];
const pdf = (m = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% boleto sintetico ${m}\n%%EOF\n`);
const relatada = (categoria = EMP, x = {}) => ({ contraparteNova: { tipo: "FORNECEDOR", nome: "Banco Sintético" }, categoria, descricao: "Empréstimo sintético",
  competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 50000 }, { vencimento: "2026-12-15", valorCentavos: 50000 }],
  observacao: "Pessoa Um R$ 400,00 + Pessoa Dois R$ 600,00", fonte: { sistema: "MANUAL", idExterno: `MOVA:emp-${randomUUID()}` }, ...x });
const paga = (fornecedorId, categoria = EMP, x = {}) => ({
  obrigacao: { ...obrigacao(fornecedorId, { valorOriginalCentavos: 291108, competencia: "2026-10", dataEmissao: "2026-10-15", vencimento: "2026-10-15", descricao: "Parcela de empréstimo — original R$ 2.971,69, desconto R$ 60,61, pago R$ 2.911,08" }), categoria, observacao: "Pessoa Um R$ 395,34 + Pessoa Dois R$ 2.515,74 = R$ 2.911,08", fonte: { sistema: "MANUAL", idExterno: `MOVA:emp-pago-${randomUUID()}` } },
  comprovante: { arquivo: { conteudo: pdf(), nome: "boleto.pdf", tipoMime: "application/pdf" }, descricao: "Comprovante do boleto do empréstimo (sintético)", competencia: "2026-10" },
  pagamento: { dataPagamento: "2026-10-15", idTransacao: `E${randomUUID().replace(/-/g, "").slice(0, 26)}`, justificativa: "Pago conforme comprovante (sintético).", confirmar: true }, ...x,
});

test("EM-1 conta de EMPRÉSTIMO a pagar (2 parcelas): a estreita + registrar_emprestimo registra em aberto, PATRIMONIAL (fora da DRE), com a observação; nenhuma outra patrimonial", async () => {
  const m = await montarComCadastros();
  const c = { ...m.c, permissoes: CONTA };
  const r = await m.nucleo.registrarContaParceladaDeEmprestimo(c, relatada());
  assert.deepEqual([r.lancamento.natureza, r.lancamento.categoria, r.obrigacoes.length, r.obrigacoes.every((o) => o.situacao === "ABERTA")], ["PATRIMONIAL", EMP, 2, true]);
  assert.equal(r.obrigacoes[0].observacao, "Pessoa Um R$ 400,00 + Pessoa Dois R$ 600,00");
  for (const cat of PROIBIDAS) {
    await assert.rejects(m.nucleo.registrarContaParceladaDeEmprestimo(c, relatada(cat)), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA, `operação de empréstimo recusa ${cat}`);
    await assert.rejects(m.nucleo.registrarContaParcelada(c, relatada(cat)), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA, `estreita com registrar_emprestimo ainda recusa ${cat}`);
  }
  // sem a ação nova: nada de empréstimo (nem pela operação própria, nem pela conta relatada comum)
  const sem = { ...m.c, permissoes: [ACAO.VER, ACAO.REGISTRAR_CONTA_PARCELADA] };
  await assert.rejects(m.nucleo.registrarContaParceladaDeEmprestimo(sem, relatada()), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  await assert.rejects(m.nucleo.registrarContaParcelada(sem, relatada()), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA);
  // só a ação nova, sem a estreita de base: não grava nada
  await assert.rejects(m.nucleo.registrarContaParceladaDeEmprestimo({ ...m.c, permissoes: [ACAO.VER, ACAO.REGISTRAR_EMPRESTIMO] }, relatada()), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
});

test("EM-2 pagamento de EMPRÉSTIMO comprovado: conta + pagamento juntos, QUITADA, patrimonial; com juros/multa ou outra categoria, recusa (juros desconhecidos nunca viram principal)", async () => {
  const m = await montarComCadastros();
  const c = { ...m.c, permissoes: PAGAMENTO };
  const r = await m.nucleo.registrarPagamentoDeEmprestimoPorComprovante(c, paga(m.fornecedor.id));
  assert.deepEqual([r.obrigacao.situacao, r.obrigacao.saldoCentavos, r.lancamento.natureza, r.lancamento.categoria, r.liquidacao.movimentacaoId], ["QUITADA", 0, "PATRIMONIAL", EMP, null], "sem transferência nem saída bancária");
  assert.match(r.obrigacao.observacao, /Pessoa Dois R\$ 2\.515,74/);
  await assert.rejects(m.nucleo.registrarPagamentoDeEmprestimoPorComprovante(c, paga(m.fornecedor.id, EMP, { encargos: { jurosCentavos: 1000, multaCentavos: 0 } })), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA);
  for (const cat of PROIBIDAS.slice(0, 3)) await assert.rejects(m.nucleo.registrarPagamentoDeEmprestimoPorComprovante(c, paga(m.fornecedor.id, cat)), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA);
  // repetir o mesmo pagamento (mesma chave) não duplica
  const p = paga(m.fornecedor.id);
  await m.nucleo.registrarPagamentoDeEmprestimoPorComprovante(c, p);
  const antes = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).length;
  const de_novo = await m.nucleo.registrarPagamentoDeEmprestimoPorComprovante(c, p);
  assert.equal(de_novo.repetido, true);
  assert.equal((await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).length, antes);
});

test("EM-3 baixa de conta de EMPRÉSTIMO EXISTENTE por comprovante: a estreita de baixa quita, sem categoria nova nem saída", async () => {
  const m = await montarComCadastros();
  const conta = await m.nucleo.registrarContaParceladaDeEmprestimo({ ...m.c, permissoes: CONTA }, relatada(EMP, { parcelas: [{ vencimento: "2026-11-15", valorCentavos: 50000 }] }));
  const baixa = await m.nucleo.registrarPagamentoPorComprovante({ ...m.c, permissoes: [ACAO.VER, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO] }, {
    obrigacaoId: conta.obrigacoes[0].id, valorCentavos: 50000, dataPagamento: "2026-10-15", idTransacao: `E${randomUUID().replace(/-/g, "").slice(0, 26)}`, justificativa: "Pago conforme comprovante (sintético).", confirmar: true,
    comprovanteSemArquivo: { hashSha256: "a".repeat(64), tipoMime: "application/pdf", tamanhoBytes: 1234 } }).catch((e) => e);
  if (baixa instanceof Error) assert.fail(`baixa por comprovante recusada: ${baixa.codigo} ${baixa.message}`);
  const [o] = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).filter((x) => x.id === conta.obrigacoes[0].id);
  assert.deepEqual([o.situacao, o.saldoCentavos], ["QUITADA", 0]);
});

test("EM-4 banco — 0035 num PostgreSQL REAL com a identidade ESTREITA do MOVA (concessão pelo kit oficial): conta e pagamento de empréstimo gravam; lucros/aportes/entre empresas não", { skip: motivoParaPular(), timeout: 300000 }, async () => {
  const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000cb";
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const f = await m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS), { tipo: "FORNECEDOR", nome: "Banco Sintético do Sertão" });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const dono = await (await repositorio.interno()).dono();
  const todas = [...new Set([...CONTA, ...PAGAMENTO])];
  const cl = await dono.connect();
  try {
    await cl.query("begin");
    await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: ORG_A, unidadeId: UNI_A, acoes: todas, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional do MOVA — empréstimos (teste)" }));
    await cl.query("commit");
  } finally { cl.release(); }
  const migr = (await dono.query("select count(*)::int n from fv2_migracao where nome = '0035_registrar_emprestimo.sql'")).rows[0].n;
  assert.equal(migr, 1, "0035 aplicada no banco de teste");
  const op = ctx(ORG_A, UNI_A, todas, OPERADOR);
  const conta = await n.registrarContaParceladaDeEmprestimo(op, relatada());
  assert.deepEqual([conta.lancamento.natureza, conta.obrigacoes.length], ["PATRIMONIAL", 2], "o gatilho da 0035 aceita o principal de empréstimo");
  const pago = await n.registrarPagamentoDeEmprestimoPorComprovante(op, paga(f.id));
  assert.equal(pago.obrigacao.situacao, "QUITADA");
  for (const cat of ["DISTRIBUICAO_DE_LUCROS", "APORTES_E_RETIRADAS", "OPERACOES_ENTRE_EMPRESAS"]) {
    await assert.rejects(n.registrarContaParcelada(op, relatada(cat)), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA, `${cat} recusada`);
  }
  // identidade estreita SEM registrar_emprestimo (concessão sem a ação nova) não grava empréstimo
  const OUTRO = "eeeeeeee-0000-4000-8000-0000000000cc";
  const c2 = await dono.connect();
  try { await c2.query("begin"); await c2.query(sqlConcessaoOperacionalDoMova({ identidade: OUTRO, organizacaoId: ORG_A, unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.REGISTRAR_CONTA_PARCELADA], concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional sem empréstimo (teste)" })); await c2.query("commit"); } finally { c2.release(); }
  await assert.rejects(n.registrarContaParcelada(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR_CONTA_PARCELADA], OUTRO), relatada()), (e) => e.codigo === CODIGO.CATEGORIA_INVALIDA);
  await assert.rejects(n.registrarContaParcelada(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR_CONTA_PARCELADA, ACAO.REGISTRAR_EMPRESTIMO], OUTRO), relatada()), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE, "contexto que diz ter a ação mas a concessão gravada não tem");
});
