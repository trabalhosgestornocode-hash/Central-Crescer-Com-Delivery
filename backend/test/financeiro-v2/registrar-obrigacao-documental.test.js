// Financeiro v2 — conta a pagar a partir de DOCUMENTO com a ação ESTREITA `registrar_obrigacao` (Agente 2, 23/11/2026; 0030).
// Dados sintéticos. Memória (regras do serviço) e PostgreSQL ISOLADO (o banco confere de novo o que quem só tem a ação grava).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const OUT = "2026-10";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% nota sintetica ${randomUUID()}\n%%EOF\n`);
async function documento(m, c) {
  const g = await m.cofre.guardar(c, { conteudo: pdf(), tipoMime: "application/pdf" });
  return (await m.nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Comprovante (sintético)" })).documento;
}
const entradaDoc = (fornId, doc, extra = {}) => obrigacao(fornId, { valorOriginalCentavos: 35000, competencia: OUT, dataEmissao: "2026-10-10", vencimento: "2026-10-10",
  descricao: "Gás de cozinha (sintético)", documentoIds: [doc.id], fonte: { sistema: "MANUAL", idExterno: `MOVA:sint-${randomUUID()}` }, ...extra });
const rejeita = (p, codigos) => assert.rejects(p, (e) => [].concat(codigos).includes(e.codigo));

test("documental (memória) — cria UMA conta e UM lançamento de despesa; repetir é idempotente; regras estreitas recusam o resto", async () => {
  const m = await montarComCadastros();
  const doc = await documento(m, m.c);
  const so = { ...m.c, permissoes: [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO] };
  const e = entradaDoc(m.fornecedor.id, doc);
  const r = await m.nucleo.registrarObrigacaoDocumental(so, e);
  assert.equal(r.obrigacoes.length, 1);
  assert.equal(r.lancamento.natureza, "DESPESA");
  assert.equal((await m.nucleo.registrarObrigacaoDocumental(so, e)).repetido, true, "mesma fonte: nada novo");
  await rejeita(m.nucleo.registrarObrigacaoDocumental(so, { ...entradaDoc(m.fornecedor.id, doc), parcelas: 2 }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(m.nucleo.registrarObrigacaoDocumental(so, { ...entradaDoc(m.fornecedor.id, doc), recorrencia: { meses: 3 } }), [CODIGO.ENTRADA_INVALIDA]);
  // a ação estreita NÃO abre o serviço amplo, nem movimentação
  await rejeita(m.nucleo.registrarObrigacao(so, entradaDoc(m.fornecedor.id, doc)), CODIGO.PERMISSAO_INSUFICIENTE);
  const banco = await m.nucleo.configurarContaFinanceira(m.c, { tipo: "BANCARIA", nome: `Banco sintético ${randomUUID().slice(0, 6)}` });
  await rejeita(m.nucleo.registrarMovimentacao(so, saida(banco.id, 35000, { dataEfetiva: "2026-10-10" })), CODIGO.PERMISSAO_INSUFICIENTE);
  // sem a ação: recusado
  await rejeita(m.nucleo.registrarObrigacaoDocumental({ ...m.c, permissoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO] }, entradaDoc(m.fornecedor.id, doc)), CODIGO.PERMISSAO_INSUFICIENTE);
});

const pular = motivoParaPular();
const U = (i) => `cccccccc-0000-4000-8000-00000000030${i}`;
const erroDoBanco = (codigos) => (e) => codigos.includes(e.code) || codigos.includes(e.causa?.code) || [CODIGO.INTEGRIDADE_VIOLADA, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo);

test("documental (banco) — quem só tem registrar_obrigacao grava só a conta e o lançamento de despesa criados juntos", { skip: pular }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const sqlComo = async (usuarioId, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
  const banco = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  const doc = await documento(m, adm);
  const existente = await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 10000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }));
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO, ACAO.ENVIAR_DOCUMENTO], justificativa: "Só registra conta a pagar por documento (sintético)." });
  const comoU1 = ctx(ORG_A, UNI_A, TODAS, U(1));

  const r = await n.registrarObrigacaoDocumental(comoU1, entradaDoc(forn.id, doc));
  assert.deepEqual([r.obrigacoes.length, r.lancamento.natureza, r.obrigacoes[0].situacao], [1, "DESPESA", "ABERTA"]);
  // Fornecedor novo na mesma operação também passa.
  const r2 = await n.registrarObrigacaoDocumental(comoU1, { ...entradaDoc(forn.id, doc), contraparteId: undefined, contraparteNova: { tipo: "FORNECEDOR", nome: "Distribuidora sintética" } });
  assert.equal(r2.obrigacoes.length, 1);
  // Pelo serviço amplo ou por outras escritas: recusado.
  await assert.rejects(n.registrarObrigacao(comoU1, entradaDoc(forn.id, doc)), erroDoBanco(["42501"]));
  await assert.rejects(n.registrarMovimentacao(comoU1, saida(banco.id, 35000, { dataEfetiva: "2026-10-10" })), erroDoBanco(["42501"]));
  // SQL cru como U1: lançamento de RECEITA, obrigação apontando para lançamento ANTIGO, movimentação e alteração: recusados.
  const base = "id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por";
  const vals = (id) => [id, ORG_A, UNI_A, 1, AGORA.toISOString(), U(1), AGORA.toISOString(), U(1)];
  await assert.rejects(sqlComo(U(1), `insert into fv2_lancamento (${base}, situacao, natureza, valor_centavos, moeda, categoria_id, categoria_codigo, classificacao, competencia, retido_no_repasse, origem)
    values ($1,$2,$3,$4,$5,$6,$7,$8,'ATIVO','RECEITA',100,'BRL',$9,'X','RECEITA_OPERACIONAL','2026-10',false,'{"tipo":"OBRIGACAO","id":"x"}')`, [...vals(randomUUID()), randomUUID()]), erroDoBanco(["42501", "23503", "23514"]));
  const antigo = existente.obrigacoes[0];
  await assert.rejects(sqlComo(U(1), `insert into fv2_obrigacao (${base}, grupo_id, lancamento_id, contraparte_id, descricao, moeda, competencia, data_emissao, vencimento, parcela, documento_ids, valor_base_centavos, liquidado_centavos, ajustes_centavos, saldo_centavos, situacao)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'x','BRL','2026-10','2026-10-10','2026-10-10','{"numero":1,"total":1}',$12,10000,0,0,10000,'ABERTA')`,
    [...vals(randomUUID()), randomUUID(), antigo.lancamentoId, forn.id, [doc.id]]), erroDoBanco(["42501"]), "lançamento de outra transação");
  await assert.rejects(sqlComo(U(1), "insert into fv2_movimentacao (id) values ($1)", [randomUUID()]), erroDoBanco(["42501", "23502"]));
  // A identidade NÃO amplia as próprias permissões (conceder é outra ação; nem pelo serviço, nem por SQL).
  await assert.rejects(n.concederAcesso(comoU1, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Tentativa de ampliar a própria permissão (sintético)." }), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE || erroDoBanco(["42501"])(e));
  const amplia = await sqlComo(U(1), "update fv2_concessao set acoes = acoes || '[\"financeiro_v2.registrar\"]'::jsonb where usuario_id = $1", [U(1)]).catch((e) => e);
  assert.ok(amplia instanceof Error || amplia?.rowCount === 0, "não altera a própria concessão");
  const alt = await sqlComo(U(1), "update fv2_obrigacao set descricao = 'mudou', versao = versao + 1 where id = $1", [antigo.id]).catch((e) => e);
  assert.ok(alt instanceof Error || alt?.rowCount === 0, "não altera conta existente");
});
