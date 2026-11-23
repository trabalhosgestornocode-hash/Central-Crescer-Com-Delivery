// 24/11 — SQL de PROVISIONAMENTO da identidade OPERACIONAL do MOVA (escrita estreita), executado num PostgreSQL REAL isolado
// exatamente como seria em produção (como dono do banco): concessão por unidade, idempotência, histórico, privilégio mínimo
// (escrita estreita funciona; ação ampla e outra unidade são recusadas pelo banco), alteração e revogação independentes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ACOES_OPERACIONAIS_DO_MOVA, EXECUTOR_BOOTSTRAP, IDENTIDADE_DO_MOVA, sqlConcessaoOperacionalDoMova, sqlRevogarConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c9";
const PROPRIETARIO = "eeeeeeee-0000-4000-8000-0000000000d1";
const ESTREITAS = [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_OBRIGACAO, ACAO.REGISTRAR_JUROS];

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_B, unidadeId: UNI_B });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const f = await m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const fb = await m.nucleo.registrarContraparte(ctx(ORG_B, UNI_B, TODAS), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético B" });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const dono = await (await repositorio.interno()).dono();
  return { n, dono, f, fb, m };
}
const executar = async (dono, sql) => { const cl = await dono.connect(); try { await cl.query("begin"); const r = await cl.query(sql); await cl.query("commit"); return r; } catch (e) { await cl.query("rollback").catch(() => {}); throw e; } finally { cl.release(); } };
const conceder = (o, u, acoes, j = "Identidade operacional do MOVA autorizada pelo proprietário (sintético)") => sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: o, unidadeId: u, acoes, concedidoPor: PROPRIETARIO, justificativa: j });
const revogar = (o, u) => sqlRevogarConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: o, unidadeId: u, revogadoPor: PROPRIETARIO, justificativa: "Revogação sintética por unidade" });
const doOperador = (o, u) => ctx(o, u, ESTREITAS, OPERADOR);
const documental = (fornecedorId) => obrigacao(fornecedorId, { valorOriginalCentavos: 45000, competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-28" });

test("OP-0 gerador: recusa identidade de leitura/técnica, ação ampla, lista sem 'ver' ou só 'ver', autor = identidade e justificativa curta", () => {
  const base = { identidade: OPERADOR, organizacaoId: ORG_A, unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO], concedidoPor: PROPRIETARIO, justificativa: "Justificativa sintética válida" };
  for (const id of [IDENTIDADE_DO_MOVA, EXECUTOR_BOOTSTRAP, "00000000-0000-4000-8000-00000000e7e9"]) assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, identidade: id }), /PRÓPRIA/);
  for (const ampla of [ACAO.REGISTRAR, ACAO.CORRIGIR, ACAO.CANCELAR, ACAO.APLICAR, ACAO.CONCEDER, ACAO.CONFIGURAR]) assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, acoes: [ACAO.VER, ampla] }), /fora da lista estreita/);
  assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, acoes: [ACAO.ENVIAR_DOCUMENTO] }), /inclui financeiro_v2\.ver/);
  assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, acoes: [ACAO.VER] }), /LEITURA/);
  assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, concedidoPor: OPERADOR }), /própria identidade/);
  assert.throws(() => sqlConcessaoOperacionalDoMova({ ...base, justificativa: "curta" }), /Justificativa/);
  assert.deepEqual([...ACOES_OPERACIONAIS_DO_MOVA].sort(), [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_OBRIGACAO, ACAO.REGISTRAR_JUROS, ACAO.VINCULAR_PAGAMENTO].sort());
  const sql = sqlConcessaoOperacionalDoMova({ ...base, acoes: [...ESTREITAS] });
  assert.match(sql, /0030_registrar_obrigacao_documental\.sql/);
  assert.match(sql, /0031_registrar_juros_no_pagamento\.sql/);
});

test("OP-1 concessão por unidade no banco real: idempotente com histórico; escrita estreita funciona; ação ampla e a outra unidade são recusadas", pular, async () => {
  const { n, dono, f, fb } = await cenario();
  await executar(dono, conceder(ORG_A, UNI_A, ESTREITAS));
  await executar(dono, conceder(ORG_A, UNI_A, ESTREITAS)); // repetir não muda nada
  const { rows: cs } = await dono.query("select organizacao_id, unidade_id, acoes, situacao, versao, concedido_por from fv2_concessao where usuario_id = $1", [OPERADOR]);
  assert.deepEqual(cs.map((c) => [c.unidade_id, [...c.acoes].sort(), c.situacao, c.versao, c.concedido_por]), [[UNI_A, [...ESTREITAS].sort(), "ATIVA", 1, PROPRIETARIO]]);
  const { rows: [h] } = await dono.query("select count(*)::int n from fv2_historico where registro_tipo = 'CONCESSAO' and registro_id = (select id from fv2_concessao where usuario_id = $1)", [OPERADOR]);
  assert.equal(h.n, 1, "um histórico de criação");

  // escrita ESTREITA: conta a pagar por documento (registrar_obrigacao) — o banco aceita
  const r = await n.registrarObrigacaoDocumental(doOperador(ORG_A, UNI_A), { ...documental(f.id), fonte: { sistema: "MANUAL", idExterno: "MOVA:op-1" } });
  assert.equal(r.obrigacoes.length, 1);
  // ação AMPLA (registrar): recusada, mesmo pedindo todas as permissões no contexto
  await assert.rejects(n.registrarObrigacao(ctx(ORG_A, UNI_A, TODAS, OPERADOR), documental(f.id)));
  // a OUTRA unidade/empresa: sem concessão, nada passa
  await assert.rejects(n.registrarObrigacaoDocumental(doOperador(ORG_B, UNI_B), { ...documental(fb.id), fonte: { sistema: "MANUAL", idExterno: "MOVA:op-1b" } }));
});

test("OP-2 alteração e revogação INDEPENDENTES por unidade, com histórico; revogar vale na hora e é idempotente", pular, async () => {
  const { n, dono, f, fb } = await cenario();
  await executar(dono, conceder(ORG_A, UNI_A, ESTREITAS));
  await executar(dono, conceder(ORG_B, UNI_B, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.REGISTRAR_OBRIGACAO]));
  // reduzir a unidade A para só anexar: deixa de registrar conta
  await executar(dono, conceder(ORG_A, UNI_A, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO]));
  await assert.rejects(n.registrarObrigacaoDocumental(doOperador(ORG_A, UNI_A), { ...documental(f.id), fonte: { sistema: "MANUAL", idExterno: "MOVA:op-2a" } }));
  // a unidade B continua como estava
  assert.equal((await n.registrarObrigacaoDocumental(ctx(ORG_B, UNI_B, [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO], OPERADOR), { ...documental(fb.id), fonte: { sistema: "MANUAL", idExterno: "MOVA:op-2b" } })).obrigacoes.length, 1);
  // revogar só a B
  await executar(dono, revogar(ORG_B, UNI_B));
  await executar(dono, revogar(ORG_B, UNI_B)); // idempotente
  await assert.rejects(n.registrarObrigacaoDocumental(ctx(ORG_B, UNI_B, [ACAO.VER, ACAO.REGISTRAR_OBRIGACAO], OPERADOR), { ...documental(fb.id), fonte: { sistema: "MANUAL", idExterno: "MOVA:op-2c" } }));
  const { rows } = await dono.query("select unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = $1 order by unidade_id", [OPERADOR]);
  const porUnidade = Object.fromEntries(rows.map((x) => [x.unidade_id, [[...x.acoes].sort(), x.situacao, x.versao]]));
  assert.deepEqual(porUnidade[UNI_A], [[ACAO.ENVIAR_DOCUMENTO, ACAO.VER].sort(), "ATIVA", 2]);
  assert.deepEqual(porUnidade[UNI_B], [[], "REVOGADA", 2]);
  const { rows: hs } = await dono.query("select evento, count(*)::int n from fv2_historico where registro_tipo = 'CONCESSAO' and registro_id in (select id from fv2_concessao where usuario_id = $1) group by 1 order by 1", [OPERADOR]);
  assert.deepEqual(hs.map((x) => [x.evento, x.n]), [["ALTERACAO", 2], ["CRIACAO", 2]]);
  // reconceder depois de revogada: volta ATIVA (nova versão), com histórico
  await executar(dono, conceder(ORG_B, UNI_B, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO]));
  assert.equal((await dono.query("select situacao, versao from fv2_concessao where usuario_id = $1 and unidade_id = $2", [OPERADOR, UNI_B])).rows[0].versao, 3);
});

test("OP-3 identidade que já tenha ação AMPLA em qualquer unidade: o SQL recusa e nada muda", pular, async () => {
  const { dono, m } = await cenario();
  await m.nucleo.concederAcesso(ctx(ORG_B, UNI_B, TODAS), { usuarioId: OPERADOR, acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Concessão ampla sintética (não deveria existir)" });
  await assert.rejects(executar(dono, conceder(ORG_A, UNI_A, ESTREITAS)), /ação AMPLA/);
  assert.equal((await dono.query("select count(*)::int n from fv2_concessao where usuario_id = $1 and unidade_id = $2", [OPERADOR, UNI_A])).rows[0].n, 0);
});
