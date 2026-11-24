// MOVA CORE — F0 (24/11/2026): orçamento RENOVÁVEL da homologação (mensal US$ 10, diário US$ 1, por requisição US$ 0,10;
// alertas 50/80/100%). Produção continua no acumulado: estes testes também provam que nada muda sem a chave e fora da homologação.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clienteComOrcamento, criarOrcamentoIa, criarOrcamentoRenovavel, custoMicrousd, regimeDeOrcamento, TETOS_RENOVAVEIS_MICROUSD } from "../../src/modules/mova-financeiro/index.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const BETA = "dddddddd-0000-4000-8000-0000000000b1";

async function cenario(politica = {}) {
  const { pool } = await criarBancoMova();
  const campos = { ativo: true, ...politica };
  const sets = Object.keys(campos).map((k, i) => `${k} = $${i + 1}`).join(", ");
  await pool.query(`update mova.orcamento_ia_politica set ${sets} where id`, Object.values(campos));
  const eventos = [];
  const o = criarOrcamentoRenovavel({ pool, registrar: (e) => eventos.push(e) });
  /** Uma chamada completa (reserva + acerto) com o custo real em µUS$ via tokens de saída do Haiku (US$ 0,50/MTok → 2 tokens = 1 µUS$). */
  const gastar = async (microusd, extra = {}) => { const id = await o.reservar({ modelo: "claude-haiku-5-5", ...extra }); await o.concluir(id, { modelo: "claude-haiku-5-5", saida: microusd * 2 }); return id; };
  const envelhecer = (intervalo) => pool.query("update mova.consumo_ia set em = em - $1::interval", [intervalo]);
  return { pool, o, eventos, gastar, envelhecer };
}
const recusa = (codigo) => ({ name: "ErroDeIa", codigo });

test("OR-01 custo com cache: leitura 0,1× e escrita 1,25× do preço de entrada (preços oficiais 5.5)", () => {
  assert.equal(custoMicrousd({ modelo: "claude-haiku-5-5", entrada: 1_000_000 }), 100_000);
  assert.equal(custoMicrousd({ modelo: "claude-haiku-5-5", cacheLeitura: 1_000_000 }), 10_000);
  assert.equal(custoMicrousd({ modelo: "claude-haiku-5-5", cacheEscrita: 1_000_000 }), 125_000);
  assert.equal(custoMicrousd({ modelo: "claude-sonnet-5-5", entrada: 1000, saida: 500, cacheLeitura: 4000 }), 2000 + 5000 + 800);
  assert.equal(custoMicrousd({ modelo: "modelo-desconhecido", entrada: 1000 }), 4000, "desconhecido = maior preço (conservador)");
});

test("OR-02 regime: renovável SÓ com a chave E em homologação; produção (OPERACAO/PILOTO) e sem chave seguem no acumulado", () => {
  assert.equal(regimeDeOrcamento({ ligado: true, modo: "HOMOLOGACAO" }), "RENOVAVEL");
  for (const [ligado, modo] of [[false, "HOMOLOGACAO"], [true, "OPERACAO"], [true, "PILOTO"], [true, "SIMULACAO"], [undefined, "HOMOLOGACAO"]]) assert.equal(regimeDeOrcamento({ ligado, modo }), "ACUMULADO");
  assert.deepEqual(TETOS_RENOVAVEIS_MICROUSD, { mensal: 10_000_000, diario: 1_000_000, requisicao: 100_000 });
});

t("OR-03 política desligada (padrão da migração): nenhuma reserva, ORCAMENTO_INDISPONIVEL (fail-closed)", async () => {
  const { pool } = await criarBancoMova();
  const o = criarOrcamentoRenovavel({ pool });
  await assert.rejects(o.reservar(), recusa("ORCAMENTO_INDISPONIVEL"));
  assert.equal((await pool.query("select count(*)::int n from mova.consumo_ia")).rows[0].n, 0);
});

t("OR-04 limite DIÁRIO: US$ 1 no dia; no dia seguinte renova sem apagar o histórico", async () => {
  const s = await cenario({ reserva_microusd: 20_000 });
  for (let i = 0; i < 10; i++) await s.gastar(99_000); // US$ 0,99 (+ reserva de 0,02 passaria de 1)
  await assert.rejects(s.o.reservar(), recusa("ORCAMENTO_DIARIO_ESGOTADO"));
  await s.envelhecer("1 day 1 hour");
  await s.gastar(10_000);
  const r = await s.o.resumo();
  assert.equal(r.diario.custoUsd, 0.01);
  assert.equal((await s.pool.query("select count(*)::int n from mova.consumo_ia")).rows[0].n, 11, "histórico preservado");
});

t("OR-05 limite MENSAL: US$ 10 no mês (somando vários dias); no mês seguinte renova sem apagar o histórico", async () => {
  const s = await cenario({ reserva_microusd: 20_000 });
  for (let d = 0; d < 10; d++) { await s.gastar(999_000); await s.envelhecer("1 day"); } // cada dia abaixo de US$ 1
  // Todo o gasto no 1º dia do mês corrente (antes de hoje, salvo se hoje FOR o dia 1: aí o diário também recusaria).
  const { rows: [{ dia1 }] } = await s.pool.query("select extract(day from now() at time zone 'America/Fortaleza') = 1 as dia1");
  if (dia1) return;
  await s.pool.query("update mova.consumo_ia set em = (date_trunc('month', now() at time zone 'America/Fortaleza') at time zone 'America/Fortaleza') + interval '1 hour'");
  await assert.rejects(s.o.reservar(), recusa("ORCAMENTO_MENSAL_ESGOTADO"));
  await s.envelhecer("40 days");
  await s.gastar(10_000);
  assert.equal((await s.o.resumo()).mensal.custoUsd, 0.01);
  assert.equal((await s.pool.query("select count(*)::int n from mova.consumo_ia")).rows[0].n, 11);
});

t("OR-06 limite POR REQUISIÇÃO (US$ 0,10) e número máximo de etapas por mensagem; outra requisição segue", async () => {
  const s = await cenario({ reserva_microusd: 20_000, max_passos_requisicao: 3 });
  await s.gastar(45_000, { requisicaoId: "R1" });
  await s.gastar(45_000, { requisicaoId: "R1" });
  await assert.rejects(s.o.reservar({ requisicaoId: "R1" }), recusa("ORCAMENTO_REQUISICAO_ESGOTADO"));
  for (let i = 0; i < 3; i++) await s.gastar(1_000, { requisicaoId: "R2" });
  await assert.rejects(s.o.reservar({ requisicaoId: "R2" }), recusa("PASSOS_ESGOTADOS"));
  await s.gastar(1_000, { requisicaoId: "R3" });
  assert.ok(s.eventos.some((e) => e.tipo === "MOVA_ORCAMENTO_RECUSOU" && e.codigo === "PASSOS_ESGOTADOS"));
});

t("OR-07 banco nunca amplia o teto do código (mensal 50, diário 5, requisição 1 → valem 10 / 1 / 0,10)", async () => {
  const s = await cenario({ limite_mensal_microusd: 50_000_000, limite_diario_microusd: 5_000_000, limite_requisicao_microusd: 1_000_000 });
  const r = await s.o.resumo();
  assert.deepEqual([r.mensal.limiteUsd, r.diario.limiteUsd, r.porRequisicaoUsd], [10, 1, 0.1]);
});

t("OR-08 reserva ATÔMICA sob concorrência: 30 reservas simultâneas nunca passam do limite diário", async () => {
  const s = await cenario({ reserva_microusd: 100_000 }); // 10 cabem em US$ 1
  const r = await Promise.allSettled(Array.from({ length: 30 }, () => s.o.reservar()));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 10);
  assert.ok(r.filter((x) => x.status === "rejected").every((x) => x.reason.codigo === "ORCAMENTO_DIARIO_ESGOTADO"));
});

t("OR-09 alertas 50/80/100% disparam UMA vez por período (diário e mensal)", async () => {
  const s = await cenario({ reserva_microusd: 10_000 });
  await s.gastar(490_000);
  assert.equal(s.eventos.filter((e) => e.tipo === "MOVA_ORCAMENTO_ALERTA").length, 0);
  await s.gastar(20_000); // 51% do dia
  await s.gastar(1_000);
  await s.gastar(300_000); // 81,1%
  const alertas = s.eventos.filter((e) => e.tipo === "MOVA_ORCAMENTO_ALERTA").map((e) => `${e.periodo[0]}${e.percentual}`);
  assert.deepEqual(alertas, ["D50", "D80"]);
  assert.deepEqual((await s.o.resumo()).alertas.map((a) => a.percentual), [50, 80]);
});

t("OR-10 painel: consumo por modelo e por unidade no mês; dimensões gravadas em cada chamada", async () => {
  const s = await cenario();
  await s.gastar(5_000, { organizacaoId: ORG, unidadeId: ALFA, requisicaoId: "R1" });
  await s.gastar(7_000, { organizacaoId: ORG, unidadeId: BETA, requisicaoId: "R2" });
  const id = await s.o.reservar({ modelo: "claude-sonnet-5-5", organizacaoId: ORG, unidadeId: ALFA });
  await s.o.concluir(id, { modelo: "claude-sonnet-5-5", entrada: 1000, cacheLeitura: 2000, cacheEscrita: 1000 });
  const r = await s.o.resumo();
  assert.deepEqual(r.porModelo.map((x) => [x.modelo, x.chamadas]).sort(), [["claude-haiku-5-5", 2], ["claude-sonnet-5-5", 1]]);
  assert.equal(r.porUnidade.find((x) => x.unidadeId === ALFA).custoUsd, 0.0099, "5000 + 2000 + 400 + 2500 µUS$");
  const linha = (await s.pool.query("select organizacao_id, cache_leitura, cache_escrita, regime from mova.consumo_ia where id = $1", [id])).rows[0];
  assert.deepEqual(linha, { organizacao_id: ORG, cache_leitura: 2000, cache_escrita: 1000, regime: "RENOVAVEL" });
});

t("OR-11 clienteComOrcamento passa modelo, contexto e cache ao renovável; falha da API libera a reserva", async () => {
  const s = await cenario();
  const api = { beta: { messages: { create: async (req) => {
    if (req.falhar) throw Object.assign(new Error("x"), { status: 500 });
    return { model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } };
  } } } };
  const c = clienteComOrcamento(api, { orcamento: s.o, contexto: () => ({ organizacaoId: ORG, unidadeId: ALFA, requisicaoId: "M1" }) });
  await c.beta.messages.create({ model: "claude-haiku-5-5", messages: [] });
  await assert.rejects(c.beta.messages.create({ model: "claude-haiku-5-5", messages: [], falhar: true }));
  const rows = (await s.pool.query("select estado, custo_microusd::int c, requisicao_id, unidade_id from mova.consumo_ia order by seq")).rows;
  assert.deepEqual(rows, [{ estado: "CONCLUIDA", c: 100 + 50 + 50, requisicao_id: "M1", unidade_id: ALFA }, { estado: "FALHOU", c: 0, requisicao_id: "M1", unidade_id: ALFA }]);
});

t("OR-12 o acumulado (produção) não muda: ignora o contexto, segue com o mesmo limite e não lê a política", async () => {
  const { pool } = await criarBancoMova();
  const o = criarOrcamentoIa({ pool });
  const id = await o.reservar({ modelo: "claude-haiku-5-5", requisicaoId: "X" });
  await o.concluir(id, { modelo: "claude-haiku-5-5", entrada: 1000, saida: 100, cacheLeitura: 999 });
  const r = (await pool.query("select custo_microusd::int c, requisicao_id, regime from mova.consumo_ia")).rows[0];
  assert.deepEqual(r, { c: 150, requisicao_id: null, regime: null });
  assert.equal((await o.resumo()).limiteUsd, 10);
});

t("OR-13 rollback: a reversão oficial da 0018 recusa com a política ATIVA e, desligada, remove só o que a 0018 criou (consumo fica)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro", "recuperacao", "reverter-0018.sql"), "utf8");
  const s = await cenario();
  // o banco de teste aplica as migrações sem o registro da instalação de produção: registra a 0018 como o instalar.sql faria
  await s.pool.query("create table mova.mova_migracao (nome text primary key, sha256 text not null)");
  await s.pool.query("insert into mova.mova_migracao values ('0018_mova_orcamento_renovavel.sql', 'x')");
  await s.gastar(1_000);
  await assert.rejects(s.pool.query(sql), /política renovável está ATIVA/);
  await s.pool.query("update mova.orcamento_ia_politica set ativo = false");
  await s.pool.query(sql);
  const r = await s.pool.query("select to_regclass('mova.orcamento_ia_politica') p, to_regclass('mova.orcamento_ia_alerta') a, (select count(*)::int from mova.consumo_ia) n");
  assert.deepEqual(r.rows[0], { p: null, a: null, n: 1 });
  assert.equal((await criarOrcamentoIa({ pool: s.pool }).resumo()).chamadas, 1, "o acumulado continua funcionando depois da reversão");
});
