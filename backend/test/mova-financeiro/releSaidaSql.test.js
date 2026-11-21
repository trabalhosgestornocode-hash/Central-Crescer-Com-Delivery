// MOVA — Execução 15C: auditoria da migração 0002 (fila de saída) no PostgreSQL LOCAL de teste. Sem Gateway, sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tratar, ROTA_SAIDA } from "../../../supabase/functions/mova-rele/nucleo.mjs";
import { assinarRequisicao } from "../../../gateway-whatsapp/src/hmac.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const SEG = "r".repeat(48);
const SQL1 = readFileSync(new URL("../../../database/mova-financeiro/rele/0001_mova_rele.sql", import.meta.url), "utf8");
const SQL2 = readFileSync(new URL("../../../database/mova-financeiro/rele/0002_mova_rele_saida.sql", import.meta.url), "utf8");

async function cenario() {
  const { pool } = await criarBancoMova();
  await pool.query(SQL1); await pool.query(SQL2);
  await pool.query("insert into mova_rele.segredo (valor) values ($1)", [SEG]);
  const gravador = async (a) => { const c = await pool.connect(); try { await c.query("begin"); await c.query("set local role mova_rele_gravador"); const r = (await c.query("select mova_rele.saida_gateway($1,$2,$3,$4,$5,$6) as r", [a.corpo, a.ts, a.nonce, a.assinatura, a.caminho, a.origem])).rows[0].r; await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
  const http = (obj) => { const corpo = JSON.stringify(obj); return tratar(new Request(`https://x/functions/v1/mova-rele${ROTA_SAIDA}`, { method: "POST", headers: { "content-type": "application/json", ...assinarRequisicao({ segredo: SEG, metodo: "POST", caminho: ROTA_SAIDA, corpo }) }, body: corpo }), { receber: async () => "INVALIDO", saida: gravador }); };
  return { pool, http };
}

t("0002: saída nasce DESLIGADA; reaplicar é recusado sem efeito; a fila de entrada (0001) não muda", async () => {
  const s = await cenario();
  assert.equal((await s.pool.query("select ligado from mova_rele.controle_saida")).rows[0].ligado, false);
  await assert.rejects(s.pool.query(SQL2), /já aplicada/);
  assert.equal((await s.pool.query("select count(*)::int n from mova_rele.evento")).rows[0].n, 0);
  const r = await s.http({ acao: "reservar", gateway: "gw" });
  assert.deepEqual([r.status, (await r.json()).desligado], [200, true]);
});

t("0002 (A-2): lote não numérico é 400 'corpo inválido' — nunca exceção/503", async () => {
  const s = await cenario();
  assert.equal((await s.http({ acao: "reservar", gateway: "gw", lote: "abc" })).status, 400);
  assert.equal((await s.http({ acao: "voar", gateway: "gw" })).status, 400);
});

t("0002 (A-1): papéis do relé só executam o que precisam; tabelas da saída sem privilégio direto", async () => {
  const s = await cenario();
  const pode = async (papel, fn) => (await s.pool.query("select has_function_privilege($1, $2, 'EXECUTE') p", [papel, fn])).rows[0].p;
  assert.equal(await pode("mova_rele_gravador", "mova_rele.saida_gateway(text,text,text,text,text,text)"), true);
  assert.equal(await pode("mova_rele_gravador", "mova_rele.publicar_saida(uuid,text,text)"), false);
  assert.equal(await pode("mova_rele_gravador", "mova_rele.definir_saida(boolean,text)"), false);
  assert.equal(await pode("mova_rele_consumidor", "mova_rele.saida_gateway(text,text,text,text,text,text)"), false);
  assert.equal(await pode("mova_rele_consumidor", "mova_rele.publicar_saida(uuid,text,text)"), true);
  for (const papel of ["mova_rele_gravador", "mova_rele_consumidor"]) {
    assert.equal(await pode(papel, "mova_rele.autenticar(text,text,text,text,text,text)"), false, `${papel} não chama autenticar direto`);
    assert.equal((await s.pool.query("select has_table_privilege($1, 'mova_rele.saida', 'SELECT') p", [papel])).rows[0].p, false);
  }
  for (const papel of ["anon", "authenticated", "service_role"]) {
    if (!(await s.pool.query("select 1 from pg_roles where rolname = $1", [papel])).rowCount) continue; // existem só no Supabase
    assert.equal(await pode(papel, "mova_rele.saida_gateway(text,text,text,text,text,text)"), false);
  }
});
