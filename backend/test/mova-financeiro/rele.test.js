// MOVA — relé de homologação (Execução 11): Edge Function (núcleo), fila mova_rele (funções e papéis reais) e consumidor local.
// PostgreSQL LOCAL de teste; dados fictícios; sem Anthropic, sem WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, montar } from "../financeiro-v2/helpers/cenario.js";
import { conferirEventoDoRele, criarConsumidorRele, criarControle, criarMova, instalarConfiguracao, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { tratar, ROTA } from "../../../supabase/functions/mova-rele/nucleo.mjs";
import { assinarRequisicao } from "../../../gateway-whatsapp/src/hmac.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const SEGREDO = "r".repeat(48);
const SQL_RELE = readFileSync(new URL("../../../database/mova-financeiro/rele/0001_mova_rele.sql", import.meta.url), "utf8");
const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const JID = "5500000000777@s.whatsapp.net";
const CONFIG = {
  modo: "HOMOLOGACAO", identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [{ organizacaoId: ORG, unidadeId: ALFA, nome: "Unidade Teste Alfa", apelidos: ["alfa"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] } }],
  gruposAutorizados: [{ grupoId: JID, unidades: [ALFA] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
let seq = 0;
const evento = (x = {}) => ({ contratoMova: 1, eventoId: `bly:RL${++seq}`, mensagemId: `RL${seq}`, grupoId: JID, participanteId: JID, telefoneE164: "+5500000000777", nomeExibicao: null, fromMe: false, tipo: "TEXTO", texto: "paguei 12 reais, alfa", respostaA: null, midia: null, recebidoEm: AGORA.toISOString(), origemTipo: "LIVE", ...x });

async function cenario() {
  const { pool } = await criarBancoMova();
  await pool.query(SQL_RELE);
  await pool.query("insert into mova_rele.segredo (valor) values ($1)", [SEGREDO]);
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  // adaptador do banco igual ao da Edge Function: SET LOCAL ROLE mova_rele_gravador e só a função receber
  const receber = async (a, limite = 60) => {
    const c = await pool.connect();
    try { await c.query("begin"); await c.query("set local role mova_rele_gravador"); const r = (await c.query("select mova_rele.receber($1,$2,$3,$4,$5,$6,$7) r", [a.corpo, a.ts, a.nonce, a.assinatura, a.caminho, a.origem, limite])).rows[0].r; await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  // pool do consumidor "como" mova_rele_consumidor
  const comoConsumidor = { query: async (sql, p) => { const c = await pool.connect(); try { await c.query("begin"); await c.query("set local role mova_rele_consumidor"); const r = await c.query(sql, p); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } } };
  const m = montar({ escopos: [{ organizacaoId: ORG, unidadeId: ALFA }] });
  const controle = criarControle({ pool, cacheMs: 0 });
  const mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool, relogio: () => AGORA, controle,
    extrator: { async extrair() { throw Object.assign(new Error("x"), { codigo: "IA_DESLIGADA" }); } } });
  const http = (corpo, { segredo = SEGREDO, cab = null, metodo = "POST", url = `https://x.supabase.co/functions/v1/mova-rele${ROTA}`, limite } = {}) => {
    const h = cab ?? assinarRequisicao({ segredo, metodo, caminho: ROTA, corpo });
    return tratar(new Request(url, { method: metodo, headers: { "content-type": "application/json", ...h }, body: metodo === "POST" ? corpo : undefined }), { receber: (a) => receber(a, limite), ...(limite ? {} : {}) });
  };
  const estado = async (id) => (await pool.query("select estado, tentativas, entregas, falha_codigo from mova_rele.evento where evento_id = $1", [id])).rows[0];
  const contar = async (sql) => (await pool.query(sql)).rows[0].n;
  return { pool, receber, comoConsumidor, mova, controle, http, estado, contar };
}

// ------------------------------------------------------------------------------------------------ Edge Function + receber
t("R1 assinatura correta ⇒ 202 e gravado RECEBIDO (com bytes, hash e assinatura originais)", async () => {
  const s = await cenario(); const e = evento(); const corpo = JSON.stringify(e);
  const r = await s.http(corpo);
  assert.equal(r.status, 202);
  const row = (await s.pool.query("select * from mova_rele.evento")).rows[0];
  assert.deepEqual([row.evento_id, row.estado, row.corpo === corpo], [e.eventoId, "RECEBIDO", true]);
});

t("R2–R7 sem assinatura, assinatura/segredo incorretos, timestamp expirado, nonce repetido, payload alterado ⇒ 401 e nada gravado", async () => {
  const s = await cenario(); const corpo = JSON.stringify(evento());
  const semCab = await tratar(new Request(`https://x/functions/v1/mova-rele${ROTA}`, { method: "POST", body: corpo }), { receber: s.receber });
  assert.equal(semCab.status, 401);
  const h = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: ROTA, corpo });
  assert.equal((await s.http(corpo, { cab: { ...h, "X-Gateway-Signature": "0".repeat(64) } })).status, 401, "assinatura incorreta");
  assert.equal((await s.http(corpo, { segredo: "x".repeat(48) })).status, 401, "segredo incorreto");
  const velho = { ...h, "X-Gateway-Timestamp": String(Date.now() - 10 * 60_000) };
  assert.equal((await s.http(corpo, { cab: velho })).status, 401, "timestamp expirado");
  assert.equal((await s.http(corpo.replace("12 reais", "99 reais"), { cab: h })).status, 401, "payload alterado depois de assinar");
  assert.equal(await s.contar("select count(*)::int n from mova_rele.evento"), 0);
  assert.equal((await s.http(corpo, { cab: h })).status, 202, "o original passa");
  assert.equal((await s.http(corpo, { cab: h })).status, 401, "o mesmo nonce de novo ⇒ replay");
  assert.equal(await s.contar("select count(*)::int n from mova_rele.evento"), 1);
  const aud = (await s.pool.query("select codigo, count(*)::int n from mova_rele.auditoria where acao = 'RECUSADO' group by codigo order by codigo")).rows.map((x) => x.codigo);
  assert.deepEqual(aud, ["ASSINATURA", "JANELA", "REPLAY"]);
  const textoAud = JSON.stringify((await s.pool.query("select * from mova_rele.auditoria")).rows);
  assert.doesNotMatch(textoAud, /paguei|5500000000777/, "auditoria sem conteúdo nem telefone");
});

t("R8 mesmo evento entregue de novo (assinatura nova) ⇒ 200 DUPLICADO, uma linha, entregas=2", async () => {
  const s = await cenario(); const corpo = JSON.stringify(evento());
  assert.equal((await s.http(corpo)).status, 202);
  const r = await s.http(corpo);
  assert.equal(r.status, 200); assert.equal((await r.json()).status, "DUPLICADO");
  assert.equal(await s.contar("select count(*)::int n from mova_rele.evento"), 1);
  assert.equal((await s.pool.query("select entregas from mova_rele.evento")).rows[0].entregas, 2);
});

t("R9–R11 acima do limite ⇒ 413; rota/método/consulta errados ⇒ 404/405; limite de taxa ⇒ 429; corpo inválido ⇒ 400", async () => {
  const s = await cenario();
  const grande = JSON.stringify(evento({ texto: "x".repeat(5000) }));
  const h = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: ROTA, corpo: grande });
  assert.equal((await tratar(new Request(`https://x/mova-rele${ROTA}`, { method: "POST", headers: h, body: grande }), { receber: s.receber, limiteBytes: 1000 })).status, 413);
  assert.equal((await tratar(new Request("https://x/mova-rele/outra", { method: "POST", headers: h, body: grande }), { receber: s.receber })).status, 404);
  assert.equal((await tratar(new Request(`https://x/mova-rele${ROTA}?a=1`, { method: "POST", headers: h, body: grande }), { receber: s.receber })).status, 404);
  assert.equal((await tratar(new Request(`https://x/mova-rele${ROTA}`, { method: "GET", headers: h }), { receber: s.receber })).status, 405);
  for (let i = 0; i < 2; i++) assert.equal((await s.http(JSON.stringify(evento()), { limite: 2 })).status, 202);
  assert.equal((await s.http(JSON.stringify(evento()), { limite: 2 })).status, 429);
  const semId = JSON.stringify({ contratoMova: 1 });
  assert.equal((await s.http(semId)).status, 400);
});

t("R17 banco indisponível ⇒ 503 (o Gateway tenta de novo) e nada é confirmado ao Gateway", async () => {
  const corpo = JSON.stringify(evento());
  const r = await tratar(new Request(`https://x/mova-rele${ROTA}`, { method: "POST", headers: assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: ROTA, corpo }), body: corpo }), { receber: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.status, 503);
});

// ------------------------------------------------------------------------------------------------ consumidor
t("R12/R8 consumidor desligado: eventos ficam no relé; religado ⇒ entregues ao receptor; reentrega não duplica no MOVA", async () => {
  const s = await cenario(); const e1 = evento(); const e2 = evento();
  await s.http(JSON.stringify(e1)); await s.http(JSON.stringify(e2));
  assert.deepEqual((await s.pool.query("select estado from mova_rele.evento order by evento_id")).rows.map((x) => x.estado), ["RECEBIDO", "RECEBIDO"], "computador desligado: tudo esperando");
  const c = criarConsumidorRele({ pool: s.comoConsumidor, receptor: s.mova.receptor, segredo: SEGREDO, controle: s.controle, consumidor: "c1" });
  assert.equal((await c.rodada()).entregues, 2);
  await s.http(JSON.stringify(e1)); // Gateway reentrega e1
  assert.equal((await c.rodada()).entregues, 0, "duplicado no relé não volta à fila do relé");
  assert.equal(await s.contar("select count(*)::int n from mova.fila"), 2, "uma entrada por evento no MOVA");
  assert.deepEqual((await s.estado(e1.eventoId)).estado, "PROCESSADO");
});

t("R14 dois consumidores concorrentes nunca reservam o mesmo evento", async () => {
  const s = await cenario();
  for (let i = 0; i < 6; i++) await s.http(JSON.stringify(evento()));
  const [a, b] = await Promise.all(["ca", "cb"].map((n) => s.comoConsumidor.query("select evento_id from mova_rele.reservar($1, 4, 60)", [n])));
  const ids = [...a.rows, ...b.rows].map((x) => x.evento_id);
  assert.equal(ids.length, 6); assert.equal(new Set(ids).size, 6);
});

t("R13/R16 lease expirado (consumidor caiu ou confirmação perdida): outro retoma; o antigo não confirma; MOVA não duplica", async () => {
  const s = await cenario(); const e = evento();
  await s.http(JSON.stringify(e));
  const [r] = (await s.comoConsumidor.query("select * from mova_rele.reservar('velho', 1, 60)")).rows;
  assert.equal((await s.mova.receptor.receber(JSON.parse(r.corpo))).status, "ENFILEIRADO"); // processou, mas caiu antes de confirmar
  await s.pool.query("update mova_rele.evento set lease_ate = now() - interval '1 second'");
  const novo = criarConsumidorRele({ pool: s.comoConsumidor, receptor: s.mova.receptor, segredo: SEGREDO, consumidor: "novo" });
  assert.equal((await novo.rodada()).entregues, 1, "retomado e confirmado (receptor: DUPLICADO)");
  assert.equal((await s.comoConsumidor.query("select mova_rele.confirmar($1, 'velho') ok", [e.eventoId])).rows[0].ok, false);
  assert.equal(await s.contar("select count(*)::int n from mova.fila"), 1);
  assert.equal((await s.estado(e.eventoId)).tentativas, 2);
});

t("R15 falha durante o processamento ⇒ NOVA_TENTATIVA com espera; depois entrega; 8 falhas ⇒ FALHA_DEFINITIVA", async () => {
  const s = await cenario(); const e = evento();
  await s.http(JSON.stringify(e));
  let falhar = true;
  const receptor = { receber: async (p) => { if (falhar) throw new Error("caiu"); return s.mova.receptor.receber(p); } };
  const c = criarConsumidorRele({ pool: s.comoConsumidor, receptor, segredo: SEGREDO, consumidor: "c1" });
  await c.rodada();
  assert.deepEqual([(await s.estado(e.eventoId)).estado, (await s.estado(e.eventoId)).falha_codigo], ["NOVA_TENTATIVA", "RECEPTOR_ERRO"]);
  assert.equal((await c.rodada()).reservados, 0, "respeita a espera");
  falhar = false; await s.pool.query("update mova_rele.evento set proxima_em = now()");
  assert.equal((await c.rodada()).entregues, 1);
  const e2 = evento(); await s.http(JSON.stringify(e2)); falhar = true;
  for (let i = 0; i < 8; i++) { await s.pool.query("update mova_rele.evento set proxima_em = now() where evento_id = $1", [e2.eventoId]); await c.rodada(); }
  assert.equal((await s.estado(e2.eventoId)).estado, "FALHA_DEFINITIVA");
});

t("R18 eventos fora de ordem: todos entregues uma vez cada (a ordem não é regra financeira)", async () => {
  const s = await cenario();
  const tardio = evento({ recebidoEm: "2026-10-15T15:10:00.000Z" }); const cedo = evento({ recebidoEm: "2026-10-15T15:00:00.000Z" });
  await s.http(JSON.stringify(tardio)); await s.http(JSON.stringify(cedo));
  const c = criarConsumidorRele({ pool: s.comoConsumidor, receptor: s.mova.receptor, segredo: SEGREDO, consumidor: "c1" });
  assert.equal((await c.rodada()).entregues, 2);
  assert.equal(await s.contar("select count(*)::int n from mova.fila"), 2);
});

t("R19 suspensão geral: consumidor não reserva; eventos esperam intactos; retomada entrega", async () => {
  const s = await cenario(); const e = evento();
  await s.http(JSON.stringify(e));
  await s.controle.alterar({ suspenso: true }, { autor: "teste" });
  const c = criarConsumidorRele({ pool: s.comoConsumidor, receptor: s.mova.receptor, segredo: SEGREDO, controle: s.controle, consumidor: "c1" });
  assert.deepEqual(await c.rodada(), { pausado: true, entregues: 0 });
  assert.equal((await s.estado(e.eventoId)).estado, "RECEBIDO");
  await s.controle.alterar({ suspenso: false }, { autor: "teste" });
  assert.equal((await c.rodada()).entregues, 1);
});

t("R22 conteúdo adulterado no banco do relé ⇒ consumidor rejeita (integridade/assinatura) e nada chega ao MOVA", async () => {
  const s = await cenario(); const e = evento();
  await s.http(JSON.stringify(e));
  const adult = JSON.stringify(e).replace("12 reais", "99 reais");
  await s.pool.query("update mova_rele.evento set corpo = $1, sha256 = $2", [adult, (await import("node:crypto")).createHash("sha256").update(adult).digest("hex")]);
  const c = criarConsumidorRele({ pool: s.comoConsumidor, receptor: s.mova.receptor, segredo: SEGREDO, consumidor: "c1" });
  await c.rodada();
  assert.deepEqual([(await s.estado(e.eventoId)).estado, (await s.estado(e.eventoId)).falha_codigo], ["FALHA_DEFINITIVA", "REJEITADO_ASSINATURA"]);
  assert.equal(await s.contar("select count(*)::int n from mova.fila"), 0);
  assert.equal(conferirEventoDoRele({ corpo: "a", sha256: "0".repeat(64) }, SEGREDO), "INTEGRIDADE");
});

// ------------------------------------------------------------------------------------------------ permissões
t("R20/R21 leitura por não autorizado e acesso ao Financeiro: papéis do relé não leem tabelas; não cruzam funções; sem acesso a mova/financeiro", async () => {
  const s = await cenario();
  await s.http(JSON.stringify(evento()));
  const como = async (papel, sql) => { const c = await s.pool.connect(); try { await c.query("begin"); await c.query(`set local role ${papel}`); await c.query(sql); return "OK"; } catch (e) { return e.code; } finally { await c.query("rollback").catch(() => {}); c.release(); } };
  await s.pool.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'usuario_comum_teste') then create role usuario_comum_teste nologin; end if; end $$");
  for (const p of ["mova_rele_consumidor", "mova_rele_gravador", "usuario_comum_teste"]) {
    assert.equal(await como(p, "select * from mova_rele.evento"), "42501", `${p} lê a fila?`);
    assert.equal(await como(p, "select * from mova_rele.segredo"), "42501", `${p} lê o segredo?`);
    assert.equal(await como(p, "select * from mova.proposta"), "42501", `${p} lê o MOVA?`);
    assert.equal(await como(p, "update mova_rele.evento set estado = 'PROCESSADO'"), "42501");
  }
  assert.equal(await como("usuario_comum_teste", "select * from mova_rele.resumo()"), "42501");
  assert.equal(await como("usuario_comum_teste", "select mova_rele.receber('a','1','b','c','d','e')"), "42501");
  assert.equal(await como("mova_rele_gravador", "select * from mova_rele.reservar('x', 1, 60)"), "42501", "gravador não consome");
  assert.equal(await como("mova_rele_consumidor", "select mova_rele.receber('a','1','b','c','d','e')"), "42501", "consumidor não grava");
  assert.equal(await como("mova_rele_consumidor", "select mova_rele.expurgar(7)"), "42501", "expurgo só do dono");
  const rls = (await s.pool.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mova_rele' and c.relkind = 'r' and not c.relrowsecurity")).rows[0].n;
  assert.equal(rls, 0, "RLS ligada em todas as tabelas do relé");
  assert.equal((await s.pool.query("select count(*)::int n from pg_policies where schemaname = 'mova_rele'")).rows[0].n, 0, "nenhuma política (nada público)");
});
