// Financeiro v2 — PRESTAÇÃO DE CONTAS DA SANGRIA com a ação ESTREITA `prestar_sangria` (MOVA CORE, 25/11/2026; 0032).
// Dados SINTÉTICOS. Memória (regras do serviço) e PostgreSQL ISOLADO (o banco confere de novo tudo o que quem só tem a ação grava).
// A estreita permite SÓ: despesa paga com o dinheiro de uma sangria EXISTENTE (liquidada contra a própria retirada), prestação
// parcial, troco devolvido ao mesmo caixa e a atualização do pendente. Nunca a ação ampla `registrar`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const DIA = "2026-10-14";
const rejeita = (p, codigos) => assert.rejects(p, (e) => [].concat(codigos).includes(e.codigo));
const despesa = (n, c, sessaoId, movId, valor, chave, fornId) => n.registrarDespesaDaSangria(c, {
  sessaoId, movimentacaoId: movId, chave, justificativa: "Compra de grampos para a cozinha (sintético)", confirmar: true,
  obrigacao: obrigacao(fornId, { valorOriginalCentavos: valor, categoria: "INSUMOS", descricao: "Grampos (sintético)", competencia: "2026-10", dataEmissao: DIA, vencimento: DIA }),
});
const troco = (n, c, sessaoId, movId, valor, chave) => n.registrarTrocoDaSangria(c, { sessaoId, movimentacaoId: movId, chave, valorCentavos: valor, data: DIA, confirmar: true });

test("PS-1 (memória) a estreita presta contas: despesa parcial, segunda despesa, troco e pendente zerado; repetir é idempotente", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo;
  const { sessao } = await n.abrirCaixa(m.c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
  const mov = (await n.registrarOperacaoDeCaixa(m.c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 5000, data: DIA, descricao: "Compras do dia" })).operacao.movimentacaoId;
  const so = { ...m.c, permissoes: [ACAO.VER, ACAO.PRESTAR_SANGRIA] };
  const d1 = await despesa(n, so, sessao.id, mov, 1800, "MOVA:ps1-despesa-1", m.fornecedor.id);
  assert.deepEqual([d1.repetido, d1.obrigacao.situacao, d1.prestacao.estado, d1.prestacao.pendenteCentavos, d1.efeito.novasSaidas], [false, "QUITADA", "PARCIAL", 3200, 0]);
  assert.equal((await despesa(n, so, sessao.id, mov, 1800, "MOVA:ps1-despesa-1", m.fornecedor.id)).repetido, true, "mesma chave: nada novo");
  await despesa(n, so, sessao.id, mov, 2000, "MOVA:ps1-despesa-2", m.fornecedor.id);
  await rejeita(despesa(n, so, sessao.id, mov, 1300, "MOVA:ps1-excede", m.fornecedor.id), CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO);
  const t = await troco(n, so, sessao.id, mov, 1200, "MOVA:ps1-troco-1");
  assert.deepEqual([t.prestacao.estado, t.prestacao.pendenteCentavos], ["PRESTADA", 0]);
});

test("PS-2 (memória) a estreita NÃO abre o resto: conta avulsa, movimentação, sangria nova, pagamento, outra unidade, sem a ação", async () => {
  const m = await montarComCadastros();
  const n = m.nucleo;
  const { sessao } = await n.abrirCaixa(m.c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
  const mov = (await n.registrarOperacaoDeCaixa(m.c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 1500, data: DIA, descricao: "Grampos" })).operacao.movimentacaoId;
  const so = { ...m.c, permissoes: [ACAO.VER, ACAO.PRESTAR_SANGRIA] };
  await rejeita(n.registrarObrigacao(so, obrigacao(m.fornecedor.id)), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.registrarMovimentacao(so, saida(m.banco.id, 1000, { dataEfetiva: DIA })), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.registrarOperacaoDeCaixa(so, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 500, data: DIA, descricao: "nova retirada" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const conta = (await n.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: 1000 }))).obrigacoes[0];
  await rejeita(n.registrarLiquidacao(so, { movimentacaoId: mov, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: conta.id, valorCentavos: 1000 }] }), CODIGO.PERMISSAO_INSUFICIENTE);
  // saída que não é sangria não presta contas, nem com a estreita
  const outraSaida = (await n.registrarMovimentacao(m.c, { contaId: m.caixa.id, dataEfetiva: DIA, sentido: "SAIDA", valorCentavos: 900, natureza: "OUTRA", descricao: "outra saída" })).movimentacao;
  await assert.rejects(despesa(n, so, sessao.id, outraSaida.id, 500, "MOVA:ps2-nao-sangria", m.fornecedor.id), (e) => e.codigo === CODIGO.OPERACAO_INVALIDA && e.detalhes?.motivo === "NAO_E_SANGRIA");
  // outra unidade e sem a ação
  const outraUni = { ...ctx(m.c.organizacaoId, "aaaaaaaa-0000-4000-8000-0000000000a2"), permissoes: [ACAO.VER, ACAO.PRESTAR_SANGRIA] };
  await assert.rejects(despesa(n, outraUni, sessao.id, mov, 1200, "MOVA:ps2-outra-uni", m.fornecedor.id));
  await rejeita(despesa(n, { ...m.c, permissoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_OBRIGACAO] }, sessao.id, mov, 1200, "MOVA:ps2-sem-acao", m.fornecedor.id), CODIGO.PERMISSAO_INSUFICIENTE);
});

const pular = motivoParaPular();
const U = (i) => `cccccccc-0000-4000-8000-00000000032${i}`;
const erroDoBanco = (codigos) => (e) => codigos.includes(e.code) || codigos.includes(e.causa?.code) || e.codigo === CODIGO.PERMISSAO_INSUFICIENTE || (e.codigo === CODIGO.INTEGRIDADE_VIOLADA && codigos.includes(e.detalhes?.sqlstate ?? e.causa?.code ?? "42501"));

test("PS-3 (banco) quem só tem prestar_sangria grava só a prestação da sangria existente; o banco recusa o resto", { skip: pular }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const sqlComo = async (usuarioId, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
  const caixa = await m.nucleo.configurarContaFinanceira(adm, { tipo: "CAIXA_FISICO", nome: "Caixa sintético" });
  const banco = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco sintético" });
  const { sessao } = await m.nucleo.abrirCaixa(adm, { contaId: caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
  const mov = (await m.nucleo.registrarOperacaoDeCaixa(adm, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 5000, data: DIA, descricao: "Compras do dia" })).operacao.movimentacaoId;
  const existente = (await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 1000, competencia: "2026-10", dataEmissao: DIA, vencimento: DIA }))).obrigacoes[0];
  const outraSaida = (await m.nucleo.registrarMovimentacao(adm, { contaId: caixa.id, dataEfetiva: DIA, sentido: "SAIDA", valorCentavos: 900, natureza: "OUTRA", descricao: "outra saída" })).movimentacao;
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.PRESTAR_SANGRIA], justificativa: "Só presta contas de sangria (sintético)." });
  const comoU1 = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.PRESTAR_SANGRIA], U(1)); // como a porta operacional monta

  // O fluxo inteiro passa pelo banco com a estreita.
  const d1 = await despesa(n, comoU1, sessao.id, mov, 1800, "MOVA:ps3-despesa-1", forn.id);
  assert.deepEqual([d1.obrigacao.situacao, d1.prestacao.estado, d1.prestacao.pendenteCentavos], ["QUITADA", "PARCIAL", 3200]);
  const d2 = await despesa(n, comoU1, sessao.id, mov, 2000, "MOVA:ps3-despesa-2", forn.id);
  assert.equal(d2.prestacao.pendenteCentavos, 1200);
  const t = await troco(n, comoU1, sessao.id, mov, 1200, "MOVA:ps3-troco-1");
  assert.deepEqual([t.prestacao.estado, t.prestacao.pendenteCentavos], ["PRESTADA", 0]);

  // Pelo serviço amplo: recusado (contexto já recusa; o banco também).
  await assert.rejects(n.registrarObrigacao(comoU1, obrigacao(forn.id)), erroDoBanco(["42501"]));
  await assert.rejects(n.registrarMovimentacao(comoU1, saida(banco.id, 1000, { dataEfetiva: DIA })), erroDoBanco(["42501"]));
  await assert.rejects(despesa(n, comoU1, sessao.id, outraSaida.id, 500, "MOVA:ps3-nao-sangria", forn.id), (e) => e.codigo === CODIGO.OPERACAO_INVALIDA);

  // SQL cru como U1 (sem passar pelo serviço): saída nova, entrada no banco, liquidação de conta EXISTENTE, alteração de outra
  // movimentação e da sessão além do troco: recusados pelo banco.
  const base = "id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por";
  const vals = (id) => [id, ORG_A, UNI_A, 1, AGORA.toISOString(), U(1), AGORA.toISOString(), U(1)];
  const movSql = (conta, sentido) => sqlComo(U(1), `insert into fv2_movimentacao (${base}, conta_id, data_efetiva, sentido, valor_centavos, moeda, natureza, descricao, alocado_centavos, situacao, situacao_conciliacao)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'${DIA}','${sentido}',100,'BRL','OUTRA','x',0,'VALIDA','NAO_CONCILIADA')`, [...vals(randomUUID()), conta]);
  await assert.rejects(movSql(caixa.id, "SAIDA"), erroDoBanco(["42501"]), "saída nova do caixa");
  await assert.rejects(movSql(banco.id, "ENTRADA"), erroDoBanco(["42501"]), "entrada em conta bancária");
  await assert.rejects(sqlComo(U(1), `insert into fv2_liquidacao (${base}, movimentacao_id, alvo_tipo, alvo_id, valor_centavos, data_efetiva, estornado_centavos, situacao)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OBRIGACAO',$10,100,'${DIA}',0,'ATIVA')`, [...vals(randomUUID()), mov, existente.id]), erroDoBanco(["42501"]), "pagar conta existente com a sangria");
  const alt = await sqlComo(U(1), "update fv2_movimentacao set descricao = 'mudou', versao = versao + 1 where id = $1", [outraSaida.id]).catch((e) => e);
  assert.ok(alt instanceof Error || alt?.rowCount === 0, "não altera outra movimentação");
  const altSangria = await sqlComo(U(1), "update fv2_movimentacao set valor_centavos = 1, versao = versao + 1 where id = $1", [mov]).catch((e) => e);
  assert.ok(altSangria instanceof Error || altSangria?.rowCount === 0, "não muda o valor da sangria");
  const altSessao = await sqlComo(U(1), "update fv2_sessao_caixa set observacao = 'mudou', versao = versao + 1 where id = $1", [sessao.id]).catch((e) => e);
  assert.ok(altSessao instanceof Error || altSessao?.rowCount === 0, "não altera a sessão além do troco");
  const amplia = await sqlComo(U(1), "update fv2_concessao set acoes = acoes || '[\"financeiro_v2.registrar\"]'::jsonb where usuario_id = $1", [U(1)]).catch((e) => e);
  assert.ok(amplia instanceof Error || amplia?.rowCount === 0, "não amplia a própria concessão");

  // Quem só baixa por comprovante continua SEM gravar liquidação com saída (0029 preservada).
  await n.concederAcesso(adm, { usuarioId: U(2), acoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE], justificativa: "Só baixa por comprovante (sintético)." });
  await assert.rejects(sqlComo(U(2), `insert into fv2_liquidacao (${base}, movimentacao_id, alvo_tipo, alvo_id, valor_centavos, data_efetiva, estornado_centavos, situacao)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OBRIGACAO',$10,100,'${DIA}',0,'ATIVA')`, [...vals(randomUUID()).map((v, i) => (i === 5 || i === 7 ? U(2) : v)), mov, existente.id]), erroDoBanco(["42501"]));

  // Revogar vale na hora.
  await n.revogarAcesso?.(adm, { usuarioId: U(1), justificativa: "Fim do teste sintético de sangria." });
  if (n.revogarAcesso) await assert.rejects(despesa(n, comoU1, sessao.id, mov, 100, "MOVA:ps3-revogada", forn.id), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE || erroDoBanco(["42501"])(e));
});
