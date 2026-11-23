// 23/11/2026 — PR C: acesso do MOVA a uma unidade SEM grupo (Subway Saci) com consulta ampla e escrita controlada.
// Subway NÃO usa SAIPOS: balcão = SWF; iFood e 99Food só pelos relatórios oficiais. Regras do Açaí (SAIPOS) preservadas.
// Sem grupo ⇒ nenhum envio em grupo. Concessão no Financeiro só "ver", pelo gerador oficial, com a lista exata das já autorizadas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/dominio/configuracao.js";
import { receitaPodeVirDe, fontesOficiais } from "../../src/modules/mova-financeiro/dominio/fontesDeReceita.js";
import { carregarConfiguracao } from "../../src/modules/mova-financeiro/infra/postgres.js";
import { sqlDesativarUnidadeSemGrupo, sqlUnidadeSemGrupo } from "../../scripts/mova/unidadeSemGrupo.mjs";
import { sqlConcessaoDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { ALFA, CONFIG, ORG, cenario, t } from "./helpers/operacao.js";

const SUBWAY = "dddddddd-0000-4000-8000-0000000a2c01";
const SERVICO = "00000000-0000-4000-8000-000000000000";
const FONTES_SUBWAY = { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"] };
const FONTES_ACAI = { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"], anotaAiPelaSaipos: true };
const GRUPO_ACAI = "120363000000000777@g.us";
const cfgCom = (extra = {}) => ({
  modo: "OPERACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [{ organizacaoId: ORG, unidadeId: ALFA, nome: "Açaí Sintético", fontes: FONTES_ACAI }, { organizacaoId: ORG, unidadeId: SUBWAY, nome: "Subway Sintético", fontes: FONTES_SUBWAY, semGrupo: true }],
  gruposAutorizados: [{ grupoId: GRUPO_ACAI, unidades: [ALFA], acesso: "LISTA", participantes: [{ ids: ["5585999990001@s.whatsapp.net"], telefones: ["+5585999990001"], perfil: "FINANCEIRO" }] }],
  ...extra,
});

test("S1 fontes: Subway = SWF no balcão + iFood/99Food só pela plataforma; nada de SAIPOS nem Anota AI; Açaí (SAIPOS) preservado", () => {
  const cfg = validarConfiguracao(cfgCom());
  const sub = cfg.unidades.find((u) => u.unidadeId === SUBWAY);
  const acai = cfg.unidades.find((u) => u.unidadeId === ALFA);
  assert.deepEqual(fontesOficiais(sub).canais, { BALCAO: "SWF", IFOOD: "IFOOD", NOVENTA_E_NOVE_FOOD: "NOVENTA_E_NOVE_FOOD" });
  assert.equal(receitaPodeVirDe(sub, "BALCAO", "SWF"), true);
  for (const [canal, fonte] of [["BALCAO", "SAIPOS"], ["IFOOD", "SWF"], ["NOVENTA_E_NOVE_FOOD", "SWF"], ["ANOTA_AI", "SAIPOS"], ["IFOOD", "SAIPOS"]]) assert.equal(receitaPodeVirDe(sub, canal, fonte), false, `${canal}/${fonte}`);
  assert.equal(receitaPodeVirDe(acai, "BALCAO", "SAIPOS"), true);
  assert.equal(receitaPodeVirDe(acai, "ANOTA_AI", "SAIPOS"), true);
  assert.equal(receitaPodeVirDe(acai, "IFOOD", "SAIPOS"), false, "iFood nunca pela SAIPOS (não duplica marketplace)");
  assert.throws(() => validarConfiguracao(cfgCom({ unidades: [cfgCom().unidades[0], { ...cfgCom().unidades[1], fontes: { ...FONTES_SUBWAY, anotaAiPelaSaipos: true } }] })), /anotaAiPelaSaipos/);
});

test("S2 unidade sem grupo: só na OPERACAO, nunca dentro de grupo, sem conversa; participante do grupo do Açaí não alcança a Subway", () => {
  const cfg = validarConfiguracao(cfgCom());
  assert.equal(cfg.unidades.find((u) => u.unidadeId === SUBWAY).semGrupo, true);
  assert.ok(cfg.gruposAutorizados.every((g) => !g.unidades.includes(SUBWAY)), "nenhuma conversa (nem derivada) com a Subway");
  assert.throws(() => validarConfiguracao({ ...cfgCom(), modo: "PILOTO" }), /unidades\.semGrupo/);
  const noGrupo = cfgCom();
  noGrupo.gruposAutorizados[0].unidades = [ALFA, SUBWAY];
  assert.throws(() => validarConfiguracao(noGrupo), /unidades\.semGrupo/, "não usar o grupo do Açaí para a Subway");
  const participante = cfgCom();
  participante.gruposAutorizados[0].participantes[0].unidades = [SUBWAY];
  assert.throws(() => validarConfiguracao(participante), /participantes/);
});

test("S3 kit da unidade sem grupo: valida pelas regras do MOVA, nasce desligada, recusa sem 0014 ou com grupo ativo; desativar não apaga", () => {
  const sql = sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "Subway Sintético", fontes: FONTES_SUBWAY, motivo: "Rotina dos entregadores autorizada (teste)" });
  assert.match(sql, /0014 não foi aplicada/);
  assert.match(sql, /já está num grupo ativo/);
  assert.match(sql, /"sistemaDeLoja":"SWF"/);
  assert.match(sql, /, false, 'Rotina/, "nasce desligada");
  assert.ok(!/grupo_autorizado \(|insert into mova\.grupo/.test(sql), "não cria grupo");
  assert.match(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "S", fontes: FONTES_SUBWAY, motivo: "motivo com dez", ativar: true }), /, true, 'motivo/);
  assert.throws(() => sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "S", fontes: { ...FONTES_SUBWAY, sistemaDeLoja: "OUTRO" }, motivo: "motivo com dez" }), /sistemaDeLoja/);
  assert.throws(() => sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "S", fontes: FONTES_SUBWAY, motivo: "curto" }), /motivo/);
  assert.match(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "O'Brien", fontes: FONTES_SUBWAY, motivo: "motivo com dez" }), /'O''Brien'/, "literal escapado");
  const des = sqlDesativarUnidadeSemGrupo({ unidadeId: SUBWAY, motivo: "Encerrado pelo proprietário" });
  assert.match(des, /^update mova\.unidade_sem_grupo set ativo = false/);
  assert.ok(!/delete/i.test(des));
});

test("S4 concessão oficial: unidade adicional só com a lista EXATA das já autorizadas; continua só 'ver'", () => {
  const OUTRA = "dddddddd-0000-4000-8000-0000000a2d01";
  const piloto = sqlConcessaoDoMova(ORG, ALFA);
  assert.match(piloto, /já tem concessão ativa em outra unidade/, "sem --alem-de: regra antiga (uma unidade)");
  const adicional = sqlConcessaoDoMova(ORG, SUBWAY, { alemDe: [ALFA] });
  assert.match(adicional, new RegExp(`array\\['${ALFA}'\\]::text\\[\\]`));
  assert.match(adicional, /não são exatamente as unidades informadas/);
  assert.match(adicional, /ação além de ver/);
  assert.match(adicional, /'\["financeiro_v2\.ver"\]'::jsonb, 'ATIVA'/);
  assert.match(sqlConcessaoDoMova(ORG, SUBWAY, { alemDe: [OUTRA, ALFA, SUBWAY] }), new RegExp(`array\\['${ALFA}', '${OUTRA}'\\]`), "ordenada, sem a própria");
  assert.throws(() => sqlConcessaoDoMova(ORG, SUBWAY, { alemDe: ["x"] }), /inválida/);
});

t("S5 PostgreSQL: carga junta a unidade sem grupo (ativa, só OPERACAO), a do grupo prevalece e o app não grava na tabela", async () => {
  const s = await cenario({ config: CONFIG });
  const pool = s.banco.pool;
  const identidadeServico = { usuarioId: SERVICO };
  const exec = async (sql) => { const c = await pool.connect(); try { await c.query(sql); } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); } };
  // sem a 0014 no registro, o kit recusa; com ela registrada (como em produção), segue
  await exec("create table if not exists mova.mova_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
  await assert.rejects(exec(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "Subway Sintético", fontes: FONTES_SUBWAY, motivo: "Rotina dos entregadores autorizada (teste)" })), /0014 não foi aplicada/);
  await exec(`insert into mova.mova_migracao (nome, sha256) values ('0014_mova_unidade_sem_grupo.sql', '${"0".repeat(64)}')`);
  await exec(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "Subway Sintético", fontes: FONTES_SUBWAY, motivo: "Rotina dos entregadores autorizada (teste)" }));
  let c = await carregarConfiguracao(pool, { identidadeServico, modo: "OPERACAO" });
  assert.ok(!c.unidades.some((u) => u.unidadeId === SUBWAY), "desligada não entra");
  await exec(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: SUBWAY, nome: "Subway Sintético", fontes: FONTES_SUBWAY, motivo: "Rotina dos entregadores autorizada (teste)", ativar: true }));
  c = await carregarConfiguracao(pool, { identidadeServico, modo: "OPERACAO" });
  const sub = c.unidades.find((u) => u.unidadeId === SUBWAY);
  assert.equal(sub?.semGrupo, true);
  assert.equal(sub.fontes.sistemaDeLoja, "SWF");
  assert.ok(c.gruposAutorizados.every((g) => !g.unidades.includes(SUBWAY)));
  const v = validarConfiguracao(c);
  assert.ok(v.unidades.some((u) => u.unidadeId === SUBWAY), "monta sem erro");
  assert.ok(!(await carregarConfiguracao(pool, { identidadeServico, modo: "PILOTO" })).unidades.some((u) => u.unidadeId === SUBWAY), "fora da OPERACAO não entra");
  // a do grupo prevalece: cadastrar ALFA (que já é de grupo) como sem grupo é recusado pelo próprio SQL
  await assert.rejects(exec(sqlUnidadeSemGrupo({ organizacaoId: ORG, unidadeId: ALFA, nome: "Alfa", fontes: FONTES_SUBWAY, motivo: "tentativa indevida (teste)", ativar: true })), /já está num grupo ativo/);
  // o app só lê
  const cl = await pool.connect();
  try {
    await cl.query("begin"); await cl.query("set local role mova_app");
    assert.equal((await cl.query("select count(*)::int n from mova.unidade_sem_grupo")).rows[0].n, 1);
    await assert.rejects(cl.query(`update mova.unidade_sem_grupo set ativo = false`), /permission denied|permissão negada/);
  } finally { await cl.query("rollback").catch(() => {}); cl.release(); }
  await exec(sqlDesativarUnidadeSemGrupo({ unidadeId: SUBWAY, motivo: "Encerrado no teste sintético" }));
  assert.ok(!(await carregarConfiguracao(pool, { identidadeServico, modo: "OPERACAO" })).unidades.some((u) => u.unidadeId === SUBWAY));
});
