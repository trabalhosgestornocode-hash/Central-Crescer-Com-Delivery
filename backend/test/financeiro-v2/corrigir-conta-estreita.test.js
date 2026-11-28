// 28/11 — ação ESTREITA `corrigir_conta_a_pagar` (migração 0036, MOVA Operador Financeiro fase 1): fornecedor, vencimento,
// descrição, observação e forma de pagamento de conta a pagar ABERTA, sem pagamento, de despesa/equipamento e de período editável.
// Inclui o ACHADO da auditoria: quem só baixa por comprovante não reescreve observação/forma de pagamento. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, homologarComRessalvas, montar, montarComCadastros, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const SO_CORRIGE = [ACAO.VER, ACAO.CORRIGIR_CONTA_A_PAGAR];
const SO_BAIXA = [ACAO.VER, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO];
const compra = (x = {}) => ({ contraparteNova: { tipo: "FORNECEDOR", nome: "Loja Sintética de Equipamentos" }, categoria: "IMOBILIZADO", descricao: "Bebedouro sintético",
  competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-19", valorCentavos: 19450 }, { vencimento: "2026-12-19", valorCentavos: 19450 }],
  formaPagamento: "CARTAO", fonte: { sistema: "MANUAL", idExterno: `MOVA:cc-${randomUUID()}` }, ...x });
const corrigir = (o, mudancas, x = {}) => ({ obrigacaoId: o.id, versaoEsperada: o.versao, mudancas, justificativa: "Correção confirmada no WhatsApp (sintético).", ...x });
const pagarPorComprovante = (n, c, o) => n.registrarPagamentoPorComprovante(c, { obrigacaoId: o.id, valorCentavos: o.saldoCentavos, dataPagamento: "2026-10-15",
  idTransacao: `E${randomUUID().replace(/-/g, "").slice(0, 26)}`, justificativa: "Pago conforme comprovante (sintético).", confirmar: true,
  comprovanteSemArquivo: { hashSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), tipoMime: "application/pdf", tamanhoBytes: 1234 } });

test("CC-1 só a parcela pedida: fornecedor novo, vencimento, observação e forma; a outra parcela e o lançamento ficam intactos; histórico com antes/depois", async () => {
  const m = await montarComCadastros();
  const conta = await m.nucleo.registrarContaParcelada(m.c, compra());
  const [p1, p2] = conta.obrigacoes;
  const c = { ...m.c, permissoes: SO_CORRIGE };
  const r = await m.nucleo.corrigirContaAPagar(c, corrigir(p2, { contraparteNova: { tipo: "FORNECEDOR", nome: "Fornecedor Novo Sintético" }, vencimento: "2026-12-20", observacao: "Troca de loja (sintético)", formaPagamento: "PIX" }));
  assert.equal(r.obrigacoes.length, 1);
  const [depois] = r.obrigacoes;
  assert.notEqual(depois.contraparteId, p2.contraparteId);
  assert.deepEqual([depois.vencimento, depois.observacao, depois.formaPagamento, depois.valorBaseCentavos, depois.competencia], ["2026-12-20", "Troca de loja (sintético)", "PIX", 19450, "2026-10"]);
  const p1Agora = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).find((o) => o.id === p1.id);
  assert.deepEqual([p1Agora.contraparteId, p1Agora.vencimento, p1Agora.versao], [p1.contraparteId, p1.vencimento, p1.versao], "a outra parcela não muda");
  assert.equal(r.lancamento, null, "a descrição do lançamento é da compra inteira");
  const hist = await m.nucleo.consultarHistorico(m.c, { registroTipo: "OBRIGACAO", registroId: p2.id });
  const corr = hist.find((h) => h.evento === "CORRECAO");
  assert.ok(corr && corr.antes.vencimento === "2026-12-19" && corr.depois.vencimento === "2026-12-20", "antes/depois no histórico");
  // fornecedor novo com o MESMO nome: reaproveita o cadastro (sem duplicar)
  const forn = (await m.nucleo.consultarRegistros(m.c, { tipo: "CONTRAPARTE" })).filter((x) => x.nome === "Fornecedor Novo Sintético");
  assert.equal(forn.length, 1);
});

test("CC-2 todas as parcelas (GRUPO): fornecedor e descrição em todas + descrição do lançamento; vencimento em grupo é recusado", async () => {
  const m = await montarComCadastros();
  const conta = await m.nucleo.registrarContaParcelada(m.c, compra());
  const c = { ...m.c, permissoes: SO_CORRIGE };
  const r = await m.nucleo.corrigirContaAPagar(c, corrigir(conta.obrigacoes[0], { contraparteId: m.fornecedor.id, descricao: "Bebedouro industrial sintético" }, { abrangencia: "GRUPO" }));
  assert.equal(r.obrigacoes.length, 2);
  assert.ok(r.obrigacoes.every((o) => o.contraparteId === m.fornecedor.id && o.descricao === "Bebedouro industrial sintético"));
  assert.equal(r.lancamento.descricao, "Bebedouro industrial sintético");
  await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(r.obrigacoes[0], { vencimento: "2026-12-30" }, { abrangencia: "GRUPO" })), CODIGO.ENTRADA_INVALIDA);
});

test("CC-3 recusas: versão antiga (concorrência), conta paga, empréstimo/patrimonial, sem a ação, período homologado; repetir sem mudança não grava", async () => {
  const m = await montarComCadastros();
  const conta = await m.nucleo.registrarContaParcelada(m.c, compra());
  const c = { ...m.c, permissoes: SO_CORRIGE };
  const [p1, p2] = conta.obrigacoes;
  const r = await m.nucleo.corrigirContaAPagar(c, corrigir(p1, { observacao: "Primeira (sintético)" }));
  await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(p1, { observacao: "Com versão antiga" })), CODIGO.CONFLITO_VERSAO);
  const igual = await m.nucleo.corrigirContaAPagar(c, corrigir(r.obrigacoes[0], { observacao: "Primeira (sintético)" }));
  assert.equal(igual.semMudanca, true, "sem mudança efetiva nada é gravado");
  // paga: recusa
  await pagarPorComprovante(m.nucleo, { ...m.c, permissoes: SO_BAIXA }, p2);
  const p2Paga = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).find((o) => o.id === p2.id);
  await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(p2Paga, { observacao: "x" })), CODIGO.OPERACAO_INVALIDA);
  // GRUPO com uma parcela paga: recusa inteira (nada muda)
  const p1Agora = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).find((o) => o.id === p1.id);
  await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(p1Agora, { descricao: "Grupo com paga" }, { abrangencia: "GRUPO" })), CODIGO.OPERACAO_INVALIDA);
  // empréstimo (patrimonial) e parcelamento tributário: proteção própria
  for (const categoria of ["EMPRESTIMOS_E_FINANCIAMENTOS", "PARCELAMENTO_TRIBUTARIO"]) {
    const reg = categoria === "EMPRESTIMOS_E_FINANCIAMENTOS" ? (x) => m.nucleo.registrarContaParceladaDeEmprestimo(m.c, x) : (x) => m.nucleo.registrarObrigacao(m.c, { contraparteId: m.fornecedor.id, valorOriginalCentavos: 50000, categoria, descricao: "Parcelamento sintético", competencia: "2026-10", dataEmissao: "2026-10-15", vencimento: "2026-11-30" });
    const outra = await reg(compra({ categoria, parcelas: [{ vencimento: "2026-11-30", valorCentavos: 50000 }] }));
    await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(outra.obrigacoes[0], { observacao: "x" })), CODIGO.OPERACAO_INVALIDA);
  }
  // sem a ação: nada
  await rejeita(m.nucleo.corrigirContaAPagar({ ...m.c, permissoes: [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO, ACAO.BAIXAR_POR_COMPROVANTE] }, corrigir(p1Agora, { observacao: "x" })), CODIGO.PERMISSAO_INSUFICIENTE);
  // período homologado: recusa
  const set = await m.nucleo.registrarContaParcelada(m.c, compra({ competencia: "2026-09", dataEmissao: "2026-09-10", parcelas: [{ vencimento: "2026-12-10", valorCentavos: 1000 }] }));
  await homologarComRessalvas(m.nucleo, m.c, "2026-09");
  await rejeita(m.nucleo.corrigirContaAPagar(c, corrigir(set.obrigacoes[0], { observacao: "x" })), CODIGO.COMPETENCIA_HOMOLOGADA);
});

const pular = motivoParaPular();
const U = (i) => `cccccccc-0000-4000-8000-00000000036${i}`;

test("CC-4 (banco) a 0036 num PostgreSQL REAL: a identidade estreita corrige só o cadastral; SQL cru indevido é recusado pelo banco; quem só baixa não reescreve observação/forma", { skip: pular, timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A2 });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const dono = await interno.dono();
  assert.equal((await dono.query("select count(*)::int n from financeiro_v2.fv2_migracao where nome = '0036_corrigir_conta_a_pagar.sql'")).rows[0].n, 1, "0036 aplicada no banco de teste");
  const sqlComo = async (usuarioId, texto, valores = [], unidadeId = UNI_A) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId, usuarioId }) });
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: SO_CORRIGE, justificativa: "Só corrige conta a pagar (sintético)." });
  await n.concederAcesso(adm, { usuarioId: U(2), acoes: SO_BAIXA, justificativa: "Só baixa por comprovante (sintético)." });
  const comoU1 = ctx(ORG_A, UNI_A, SO_CORRIGE, U(1));

  const conta = await m.nucleo.registrarContaParcelada(adm, compra());
  const [p1, p2] = conta.obrigacoes;
  // caminho oficial: a 2ª parcela muda de fornecedor; a 1ª fica igual
  const r = await n.corrigirContaAPagar(comoU1, corrigir(p2, { contraparteNova: { tipo: "FORNECEDOR", nome: "Fornecedor Novo Sintético" }, observacao: "Troca (sintético)", formaPagamento: "BOLETO" }));
  assert.equal(r.obrigacoes[0].formaPagamento, "BOLETO");
  const grupo = await n.corrigirContaAPagar(comoU1, corrigir(p1, { descricao: "Bebedouro corrigido (sintético)" }, { abrangencia: "GRUPO" }));
  assert.equal(grupo.lancamento.descricao, "Bebedouro corrigido (sintético)", "descrição do lançamento com o grupo inteiro elegível");

  // SQL cru como a APLICAÇÃO grava (versão + 1 e histórico na mesma transação): só a REGRA da 0036 pode recusar.
  const alterarCru = async (usuarioId, tabela, tipo, id, set) => comoAplicacao(interno, null, async (cl) => {
    const antes = (await cl.query(`select to_jsonb(x) j from financeiro_v2.${tabela} x where id = $1`, [id])).rows[0]?.j;
    const r = await cl.query(`update financeiro_v2.${tabela} x set ${set}, versao = x.versao + 1, atualizado_em = now(), atualizado_por = $2 where id = $1 returning to_jsonb(x) j`, [id, usuarioId]);
    if (!r.rowCount) return 0;
    await cl.query("insert into financeiro_v2.fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em) values (gen_random_uuid(), $1, $2, $3, $4, 'CORRECAO', $5, $6, 'Teste sintético', $7, now())",
      [r.rows[0].j.organizacao_id, r.rows[0].j.unidade_id, tipo, id, antes, r.rows[0].j, usuarioId]);
    return r.rowCount;
  }, { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  const pelaRegra = (re) => (e) => re.test(e.message) || (assert.fail(`recusa por outro motivo: ${e.code} ${e.message}`), false);
  const SO_CADASTRAL = /correção estreita muda só|forma de pagamento inválida|só muda a posição/;
  const o = (id) => ["fv2_obrigacao", "OBRIGACAO", id];
  // o cadastral passa por SQL cru (a mesma forma que o núcleo grava) — prova que as recusas abaixo são da REGRA, não do histórico
  assert.equal(await alterarCru(U(1), ...o(p1.id), "vencimento = '2026-11-20'"), 1);
  for (const [nome, set] of [["valor", "valor_base_centavos = 100, saldo_centavos = 100"], ["competência", "competencia = '2026-11'"], ["cancelar", "situacao = 'CANCELADA'"],
    ["quitar", "liquidado_centavos = valor_base_centavos, saldo_centavos = 0, situacao = 'QUITADA'"], ["emissão", "data_emissao = '2026-10-01'"], ["parcela", "parcela = '{\"numero\":1,\"total\":3}'"],
    ["outra chave de extras", "extras = coalesce(extras, '{}'::jsonb) || '{\"origemDoVinculo\":\"COMPROVANTE\"}'"], ["forma inválida", "extras = coalesce(extras, '{}'::jsonb) || '{\"formaPagamento\":\"CHEQUE\"}'"]]) {
    await assert.rejects(alterarCru(U(1), ...o(p1.id), set), pelaRegra(SO_CADASTRAL), `U1 não altera ${nome}`);
  }
  const l = ["fv2_lancamento", "LANCAMENTO", conta.lancamento.id];
  await assert.rejects(alterarCru(U(1), ...l, "valor_centavos = 1"), pelaRegra(/no lançamento só a descrição/), "lançamento: valor");
  await assert.rejects(alterarCru(U(1), ...l, "competencia = '2026-11'"), pelaRegra(/no lançamento só a descrição/), "lançamento: competência");
  await assert.rejects(alterarCru(U(1), ...l, "situacao = 'CANCELADO'"), pelaRegra(/no lançamento só a descrição/), "lançamento: cancelar");
  await assert.rejects(alterarCru(U(1), ...l, "categoria_codigo = 'INSUMOS'"), pelaRegra(/exige reclassificar/), "lançamento: categoria");
  assert.equal(await sqlComo(U(1), "delete from financeiro_v2.fv2_obrigacao where id = $1", [p1.id]).then((x) => x.rowCount, () => 0), 0, "nunca apaga");

  // conta PAGA e conta de EMPRÉSTIMO: nem o cadastral
  await pagarPorComprovante(n, ctx(ORG_A, UNI_A, SO_BAIXA, U(2)), (await m.nucleo.consultarRegistros(adm, { tipo: "OBRIGACAO" })).find((x) => x.id === p1.id));
  await assert.rejects(alterarCru(U(1), ...o(p1.id), "descricao = 'x'"), pelaRegra(/só se corrige conta a pagar aberta/), "conta paga");
  await assert.rejects(alterarCru(U(1), ...l, "descricao = 'x'"), pelaRegra(/todas as parcelas da conta abertas/), "lançamento com parcela paga");
  const emp = await m.nucleo.registrarContaParceladaDeEmprestimo(adm, compra({ categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", parcelas: [{ vencimento: "2026-11-30", valorCentavos: 50000 }] }));
  await assert.rejects(alterarCru(U(1), ...o(emp.obrigacoes[0].id), "descricao = 'x'"), pelaRegra(/só se corrige conta a pagar aberta/), "empréstimo tem proteção própria");

  // ACHADO da auditoria: quem SÓ BAIXA não reescreve observação/forma (antes da 0036 o banco deixava)
  const outra = await m.nucleo.registrarContaParcelada(adm, compra());
  await assert.rejects(alterarCru(U(2), ...o(outra.obrigacoes[0].id), "extras = coalesce(extras, '{}'::jsonb) || '{\"observacao\":\"reescrita\"}'"), pelaRegra(/baixa não altera a observação/), "baixa não reescreve observação");
  await assert.rejects(alterarCru(U(2), ...o(outra.obrigacoes[0].id), "extras = coalesce(extras, '{}'::jsonb) || '{\"formaPagamento\":\"PIX\"}'"), pelaRegra(/baixa não altera a observação/), "baixa não reescreve forma");
  // U2 também não usa a correção estreita (descrição)
  await assert.rejects(alterarCru(U(2), ...o(outra.obrigacoes[1].id), "descricao = 'x'"), pelaRegra(/só muda a posição/));
  // e a baixa legítima continua funcionando
  assert.ok(await pagarPorComprovante(n, ctx(ORG_A, UNI_A, SO_BAIXA, U(2)), outra.obrigacoes[0]));

  // ISOLAMENTO: U1 não tem concessão na outra unidade — nem sessão, nem linha alcançada
  const adm2 = ctx(ORG_A, UNI_A2, TODAS);
  const daOutra = await m.nucleo.registrarContaParcelada(adm2, compra());
  await assert.rejects(n.corrigirContaAPagar(ctx(ORG_A, UNI_A2, SO_CORRIGE, U(1)), corrigir(daOutra.obrigacoes[0], { observacao: "x" })));
  const alcancadas = await sqlComo(U(1), "update financeiro_v2.fv2_obrigacao set descricao = 'x' where id = $1", [daOutra.obrigacoes[0].id]).then((x) => x.rowCount, () => 0);
  assert.equal(alcancadas, 0, "outra unidade fora do alcance");
});
