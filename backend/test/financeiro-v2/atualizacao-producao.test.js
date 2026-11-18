// Ensaio LOCAL da atualização de produção (atualizar.sql): parte de um banco no estado de produção de 17/11/2026
// (migrações 0001–0023), com dados sintéticos de venda, e aplica o PACOTE como ele seria aplicado: sem superusuário, numa só
// transação. Confere que nenhum dado muda, que as restrições antigas que não deviam mudar continuam, que o que é novo
// funciona e que repetir o pacote é recusado sem alterar nada. Só roda no PostgreSQL local isolado (pulado sem ele).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aplicarMigracoes, listarMigracoes, urlDoBanco } from "../../scripts/fv2/ambiente.mjs";
import { abrirPool, ambiente, motivoParaPular } from "./helpers/postgres.js";

const PULAR = motivoParaPular();
const raiz = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const BASE = "0026"; // última migração já aplicada em produção (conferida por nome e hash contra o Git)

test("atualizar.sql: de 0026 para 0027 sem mexer em dado, sem perder restrição e sem repetir", { skip: PULAR, timeout: 180000 }, async () => {
  const a = ambiente();
  const controle = await abrirPool(a.urlAdmin, { max: 1 });
  const banco = `fv2_teste_ensaio_${randomBytes(4).toString("hex")}`;
  await controle.query(`create database ${banco} owner fv2_teste_migrador template template0`);
  await controle.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 2 });
  const temp = mkdtempSync(join(tmpdir(), "fv2-ensaio-"));
  try {
    // 1) Banco no estado de produção: só as migrações até a BASE.
    for (const m of listarMigracoes().filter((x) => x.nome.slice(0, 4) <= BASE)) copyFileSync(join(raiz, "database", "financeiro-v2", "migracoes", m.nome), join(temp, m.nome));
    const aplicadas = await aplicarMigracoes(pool, { pasta: temp, papel: "fv2_teste_migrador" });
    assert.equal(aplicadas.length, 26);

    // 2) Dados sintéticos "de produção" (sem gatilhos de histórico; as restrições CHECK continuam valendo).
    const ORG = randomUUID(); const UNI = randomUUID(); const AUTOR = randomUUID();
    const cl = await pool.connect();
    try {
      await cl.query("set session_replication_role = replica");
      await cl.query("insert into financeiro_v2.fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, 'Escopo sintético do ensaio')", [ORG, UNI]);
      const molde = (id) => [id, ORG, UNI, AUTOR];
      for (const [canal, fonte] of [["BALCAO", "SAIPOS"], ["ANOTA_AI", "SAIPOS"], ["IFOOD", "SAIPOS"], ["BALCAO", "MANUAL"]]) {
        const venda = randomUUID();
        await cl.query(`insert into financeiro_v2.fv2_venda (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
            canal, data_venda, competencia, bruto_centavos, pago_centavos, devolvido_centavos, moeda, fonte_sistema, lancamento_id, situacao, pagamento_parcial, pagamentos, pagamento_ids)
          values ($1, $2, $3, 1, now(), $4, now(), $4, $5, '2026-11-05', '2026-11', 10000, 10000, 0, 'BRL', $6, $7, 'ATIVA', false, '[]'::jsonb, '{}')`, [...molde(venda), canal, fonte, randomUUID()]);
        await cl.query(`insert into financeiro_v2.fv2_lancamento (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
            situacao, natureza, valor_centavos, moeda, categoria_id, categoria_codigo, classificacao, competencia, canal, retido_no_repasse, origem)
          values ($1, $2, $3, 1, now(), $4, now(), $4, 'ATIVO', 'RECEITA', 10000, 'BRL', $5, 'RECEITA_BRUTA', 'RECEITA', '2026-11', $6, false, jsonb_build_object('tipo', 'VENDA', 'id', $7::text))`,
        [randomUUID(), ORG, UNI, AUTOR, randomUUID(), canal, venda]);
        const recebivel = randomUUID();
        await cl.query(`insert into financeiro_v2.fv2_recebivel (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
            processador, canal, venda_id, bruto_centavos, moeda, retencoes, competencia, documento_ids, valor_base_centavos, liquidado_centavos, ajustes_centavos, saldo_centavos, situacao)
          values ($1, $2, $3, 1, now(), $4, now(), $4, 'STONE', $5, $6, 10000, 'BRL', '[]'::jsonb, '2026-11', '{}', 10000, 0, 0, 10000, 'ABERTA')`, [recebivel, ORG, UNI, AUTOR, canal, venda]);
        await cl.query(`insert into financeiro_v2.fv2_pagamento_venda (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
            venda_id, indice, forma, valor_centavos, estornado_centavos, moeda, data_pagamento, situacao, processador, recebivel_id)
          values ($1, $2, $3, 1, now(), $4, now(), $4, $5, 0, 'CREDITO', 10000, 0, 'BRL', '2026-11-05', 'VALIDO', 'STONE', $6)`, [randomUUID(), ORG, UNI, AUTOR, venda, recebivel]);
      }
    } finally { cl.release(); }
    const fotografia = async () => (await pool.query(`select
        (select count(*) from financeiro_v2.fv2_venda)::int vendas, (select coalesce(sum(bruto_centavos), 0) from financeiro_v2.fv2_venda)::int bruto,
        (select count(*) from financeiro_v2.fv2_lancamento)::int lancamentos, (select count(*) from financeiro_v2.fv2_pagamento_venda)::int pagamentos,
        (select count(*) from financeiro_v2.fv2_migracao)::int migracoes`)).rows[0];
    const antes = await fotografia();
    assert.deepEqual([antes.vendas, antes.bruto, antes.migracoes], [4, 40000, 26]);
    const checksAntes = (await pool.query("select conname from pg_constraint where conrelid = 'financeiro_v2.fv2_venda'::regclass and contype = 'c' and conname !~ '^fv2_venda_canal' order by 1")).rows.map((r) => r.conname);
    assert.ok(checksAntes.includes("fv2_venda_fonte_sistema_check"));

    // 3) O PACOTE, como seria aplicado: papel sem superusuário, uma transação (consulta de várias instruções).
    const pacote = readFileSync(join(raiz, "database", "financeiro-v2", "producao", "atualizar.sql"), "utf8");
    const aplicar = async () => {
      const c = await pool.connect();
      try { await c.query("set role fv2_teste_migrador"); await c.query(pacote); } finally { try { await c.query("reset role"); } catch { /* conexão descartada */ } c.release(); }
    };
    await aplicar();

    // 4) Nenhum dado mudou; nenhuma restrição que não devia mudar sumiu.
    const depois = await fotografia();
    assert.deepEqual({ ...depois, migracoes: antes.migracoes }, antes, "vendas, valores, lançamentos e pagamentos idênticos");
    assert.equal(depois.migracoes, 27);
    const checksDepois = (await pool.query("select conname from pg_constraint where conrelid = 'financeiro_v2.fv2_venda'::regclass and contype = 'c' and conname !~ '^fv2_venda_canal' order by 1")).rows.map((r) => r.conname);
    assert.deepEqual(checksDepois, checksAntes, "a CHECK de origem da venda (fonte_sistema) continua");

    // 5) O que é novo funciona; o que é inválido continua inválido.
    const cl2 = await pool.connect();
    try {
      await cl2.query("set session_replication_role = replica");
      const inserir = (canal, fonte) => cl2.query(`insert into financeiro_v2.fv2_venda (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
          canal, data_venda, competencia, bruto_centavos, pago_centavos, devolvido_centavos, moeda, fonte_sistema, lancamento_id, situacao, pagamento_parcial, pagamentos, pagamento_ids)
        values ($1, $2, $3, 1, now(), $4, now(), $4, $5, '2026-11-06', '2026-11', 100, 0, 0, 'BRL', $6, $7, 'ATIVA', false, '[]'::jsonb, '{}')`, [randomUUID(), ORG, UNI, AUTOR, canal, fonte, randomUUID()]);
      await inserir("NOVENTA_E_NOVE_FOOD", "SAIPOS"); // canal da 0024 continua aceito
      await assert.rejects(inserir("CANAL_INEXISTENTE", "SAIPOS"), /check|violates/i);
      await assert.rejects(inserir("BALCAO", "FONTE_INEXISTENTE"), /fonte_sistema_check/i);
    } finally { cl2.release(); }
    const tabela = (await pool.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'financeiro_v2.fv2_fechamento_entregador'::regclass")).rows[0];
    assert.deepEqual(tabela, { relrowsecurity: true, relforcerowsecurity: true }, "fechamento de entregadores nasce com RLS forçada");
    const semPublic = (await pool.query(`select count(*)::int n from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where c.oid = 'financeiro_v2.fv2_fechamento_entregador'::regclass and x.grantee = 0`)).rows[0].n;
    assert.equal(semPublic, 0, "nenhum privilégio para PUBLIC na tabela nova");

    // 6) Repetir o pacote é recusado antes de mudar qualquer coisa.
    const antesDeRepetir = await fotografia();
    await assert.rejects(aplicar(), /esperado 26/);
    assert.deepEqual(await fotografia(), antesDeRepetir, "repetir o pacote não altera nada");
  } finally {
    await pool.end().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
    await controle.query(`drop database if exists ${banco} with (force)`).catch(() => {});
  }
});
