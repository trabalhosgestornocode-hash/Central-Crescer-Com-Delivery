// MOVA — Execução 15B: FILA DE SAÍDA pelo relé, ponta a ponta SEM WhatsApp e SEM rede.
// Peças REAIS: SQL 0001 + 0002 do relé (PostgreSQL local de teste, papéis mínimos), núcleo da Edge Function, módulo
// movaSaida.js do Gateway e enviador do MOVA. Simulados: o transporte HTTP (em processo) e a sessão Baileys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { criarArmazenamentoPostgres, criarEnviadorDeRespostas, criarSaidaPeloRele } from "../../src/modules/mova-financeiro/index.js";
import { tratar } from "../../../supabase/functions/mova-rele/nucleo.mjs";
import { assinarRequisicao } from "../../../gateway-whatsapp/src/hmac.js";
// O módulo do Gateway vem no PR próprio do Gateway (15B); sem ele na árvore, este teste é PULADO com motivo (não quebra).
const moduloSaida = await import("../../../gateway-whatsapp/src/movaSaida.js").catch(() => null);
const { criarSaidaMova, lerSaidaMova } = moduloSaida ?? {};
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova() || (moduloSaida ? false : "módulo gateway-whatsapp/src/movaSaida.js ausente (PR do Gateway 15B ainda não incorporado)");
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const SEGREDO = "r".repeat(48);
const SQL1 = readFileSync(new URL("../../../database/mova-financeiro/rele/0001_mova_rele.sql", import.meta.url), "utf8");
const SQL2 = readFileSync(new URL("../../../database/mova-financeiro/rele/0002_mova_rele_saida.sql", import.meta.url), "utf8");
const CONTATO = "5500000000777@s.whatsapp.net";
const BASE = "https://x.supabase.co/functions/v1/mova-rele";

async function cenario() {
  const { pool } = await criarBancoMova();
  await pool.query(SQL1); await pool.query(SQL2);
  await pool.query("insert into mova_rele.segredo (valor) values ($1)", [SEGREDO]);
  const como = (papel) => ({ query: async (sql, p) => { const c = await pool.connect(); try { await c.query("begin"); await c.query(`set local role ${papel}`); const r = await c.query(sql, p); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } } });
  const gravador = como("mova_rele_gravador");
  // Edge Function em processo: rota de saída chama mova_rele.saida_gateway COMO mova_rele_gravador (igual ao index.ts).
  const saidaDb = async (a) => (await gravador.query("select mova_rele.saida_gateway($1,$2,$3,$4,$5,$6) as r", [a.corpo, a.ts, a.nonce, a.assinatura, a.caminho, a.origem])).rows[0].r;
  let redeFalhaEm = null; // (acao) => true para simular perda de resposta HTTP
  const fetchFn = async (url, o) => {
    const acao = JSON.parse(o.body).acao;
    if (redeFalhaEm?.(acao)) throw new Error("rede"); // a requisição se perdeu antes de chegar ao relé
    return tratar(new Request(url, { method: o.method, headers: o.headers, body: o.body }), { receber: async () => "INVALIDO", saida: saidaDb });
  };
  const envios = [];
  let comportamento = async () => ({ providerMessageId: `P${envios.length}` });
  const sessao = { async enviarGrupoMova(x) { const r = await comportamento(x); envios.push(x); return r; } };
  const gateway = (o = {}) => criarSaidaMova({ url: BASE, segredo: SEGREDO, sessao, gatewayId: o.id ?? "gw-a", fetchFn, agendar: () => 0, cancelar: () => {}, ...o });
  const armazenamento = criarArmazenamentoPostgres({ pool });
  const rele = criarSaidaPeloRele({ pool: como("mova_rele_consumidor") });
  let envioLigado = true;
  const enviador = (o = {}) => criarEnviadorDeRespostas({ armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], rele,
    controle: { ligado: async () => envioLigado }, enviar: async () => { throw new Error("nunca: transporte é o relé"); }, ...o });
  const resposta = async (texto, grupoId = CONTATO) => { await armazenamento.saida.enfileirar({ grupoId, respostaA: null, texto, eventoId: null }); return (await pool.query("select id from mova.resposta order by seq desc limit 1")).rows[0].id; };
  const saida = async (id) => (await pool.query("select estado, tentativas, codigo, provider_message_id from mova_rele.saida where id = $1", [id])).rows[0];
  const resp = async (id) => (await pool.query("select estado, ultimo_erro, provider_message_id from mova.resposta where id = $1", [id])).rows[0];
  return { pool, saidaDb, rele, gateway, enviador, resposta, saida, resp, envios, set comportamento(f) { comportamento = f; }, set redeFalhaEm(f) { redeFalhaEm = f; }, set envioLigado(v) { envioLigado = v; } };
}

t("S1 envio único: publica → Gateway reserva, envia UMA vez e confirma → MOVA sincroniza ENVIADA com o id do provedor", async () => {
  const s = await cenario();
  const id = await s.resposta("olá");
  await s.enviador().enviarPendentes();
  assert.equal((await s.saida(id)).estado, "PENDENTE");
  assert.equal((await s.resp(id)).ultimo_erro, "AGUARDANDO_RELE");
  assert.equal((await s.gateway().rodada()).enviadas, 1);
  assert.deepEqual(s.envios.map((e) => [e.grupoJid, e.texto, e.correlationId]), [[CONTATO, "olá", `mova-saida:${id}`]]);
  assert.equal((await s.saida(id)).estado, "ENVIADA");
  await s.enviador().enviarPendentes();
  assert.deepEqual(await s.resp(id), { estado: "ENVIADA", ultimo_erro: "AGUARDANDO_RELE", provider_message_id: "P0" });
});

t("S2 duas instâncias/requisições simultâneas: a reserva é atômica — um único envio", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  const [a, b] = await Promise.all([s.gateway({ id: "gw-a" }).rodada(), s.gateway({ id: "gw-b" }).rodada()]);
  assert.equal(a.enviadas + b.enviadas, 1);
  assert.equal(s.envios.length, 1);
  assert.equal((await s.saida(id)).estado, "ENVIADA");
});

t("S3 repetição após sucesso: nova rodada e nova publicação do MESMO id não enviam de novo", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  await s.gateway().rodada();
  assert.equal(await s.rele.publicar({ id, destino: CONTATO, texto: "x" }), "ENVIADA");
  await s.gateway().rodada(); await s.gateway({ id: "gw-b" }).rodada();
  assert.equal(s.envios.length, 1);
});

t("S4 falha ANTES do envio (desconectado): volta à fila e sai uma vez na próxima rodada", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  let fora = true;
  s.comportamento = async () => { if (fora) throw Object.assign(new Error("nc"), { codigo: "WHATSAPP_GATEWAY_NOT_CONNECTED", preEnvio: true }); return { providerMessageId: "PX" }; };
  await s.gateway().rodada();
  assert.deepEqual([(await s.saida(id)).estado, (await s.saida(id)).codigo], ["PENDENTE", "WHATSAPP_GATEWAY_NOT_CONNECTED"]);
  fora = false;
  await s.pool.query("update mova_rele.saida set proxima_em = now()");
  await s.gateway().rodada();
  assert.equal((await s.saida(id)).estado, "ENVIADA");
  assert.equal(s.envios.length, 1);
});

t("S5 falha DEPOIS de tentar enviar (timeout no provedor): INCERTA, nunca reenviada; MOVA vira FALHOU/ENVIO_INCERTO", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  let chamadas = 0;
  s.comportamento = async () => { chamadas += 1; throw Object.assign(new Error("timeout"), { codigo: "WHATSAPP_GATEWAY_TIMEOUT" }); };
  await s.gateway().rodada(); await s.gateway().rodada(); await s.gateway({ id: "gw-b" }).rodada();
  assert.equal(chamadas, 1);
  assert.equal((await s.saida(id)).estado, "INCERTA");
  await s.enviador().enviarPendentes();
  assert.deepEqual([(await s.resp(id)).estado, (await s.resp(id)).ultimo_erro], ["FALHOU", "ENVIO_INCERTO"]);
});

t("S6/S7 confirmação HTTP perdida + reinício do Gateway: lease vence ⇒ INCERTA, sem segundo envio; confirmação tardia ainda vale", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  s.redeFalhaEm = (acao) => acao === "confirmar";
  await s.gateway().rodada();                                     // enviou, mas as 3 confirmações se perderam
  assert.equal((await s.saida(id)).estado, "RESERVADA");
  await s.pool.query("update mova_rele.saida set lease_ate = now() - interval '1 second'");
  s.redeFalhaEm = null;
  await s.gateway({ id: "gw-novo" }).rodada();                    // "reiniciado": memória vazia, outro id
  assert.equal((await s.saida(id)).estado, "INCERTA");
  assert.equal(s.envios.length, 1, "nunca um segundo envio");
  // Confirmação ATRASADA, assinada, do processo original: é evidência de envio ⇒ ENVIADA (sem novo envio).
  const corpo = JSON.stringify({ acao: "confirmar", gateway: "gw-a", id, providerMessageId: "P0" });
  const r = await tratar(new Request(`${BASE}/internal/mova/saida`, { method: "POST", headers: { "content-type": "application/json", ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: "/internal/mova/saida", corpo }) }, body: corpo }),
    { receber: async () => "INVALIDO", saida: s.saidaDb });
  assert.equal(r.status, 200);
  assert.deepEqual([(await s.saida(id)).estado, (await s.saida(id)).provider_message_id, s.envios.length], ["ENVIADA", "P0", 1]);
});

t("S8 resposta anterior ao marco: nunca é publicada no relé", async () => {
  const s = await cenario();
  const id = await s.resposta("antiga");
  await s.pool.query("update mova.resposta set criada_em = '2026-11-20T00:00:00Z'");
  await s.enviador({ naoAntesDe: "2026-11-21T00:00:00Z" }).enviarPendentes();
  assert.equal(await s.saida(id), undefined);
  assert.equal((await s.pool.query("select count(*)::int n from mova_rele.saida")).rows[0].n, 0);
});

t("S9/S10 contato não autorizado e grupo: não saem do MOVA; o relé recusa destino que não é conversa privada", async () => {
  const s = await cenario();
  const outro = await s.resposta("p/ outro", "5500000000888@s.whatsapp.net");
  const grupo = await s.resposta("p/ grupo", "120363000000000001@g.us");
  await s.enviador().enviarPendentes();
  assert.equal(await s.saida(outro), undefined); assert.equal(await s.saida(grupo), undefined);
  await assert.rejects(s.rele.publicar({ id: randomUUID(), destino: "120363000000000001@g.us", texto: "x" }), /check|saida_destino/i);
  // O Gateway recusa (pré-envio) quem não é o contato verificado: 3 tentativas e FALHOU, sem envio.
  const id = randomUUID(); await s.rele.publicar({ id, destino: "5500000000888@s.whatsapp.net", texto: "x" }); await s.rele.definir(true, "teste");
  s.comportamento = async () => { throw Object.assign(new Error("n"), { codigo: "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED", preEnvio: true }); };
  for (let i = 0; i < 3; i++) { await s.gateway().rodada(); await s.pool.query("update mova_rele.saida set proxima_em = now()"); }
  assert.deepEqual([(await s.saida(id)).estado, s.envios.length], ["FALHOU", 0]);
});

t("S11 assinatura inválida: 401 genérico, nada reservado, recusa auditada", async () => {
  const s = await cenario();
  const id = await s.resposta("x"); await s.enviador().enviarPendentes();
  assert.equal((await s.gateway({ segredo: "y".repeat(48) }).rodada()).enviadas, 0);
  assert.equal((await s.saida(id)).estado, "PENDENTE");
  assert.ok((await s.pool.query("select 1 from mova_rele.auditoria where acao = 'RECUSADO' and codigo = 'ASSINATURA'")).rowCount >= 1);
});

t("S12/S13 suspensão do MOVA: desligar o envio desliga a saída no relé, cancela as pendentes e o Gateway não reserva mais nada", async () => {
  const s = await cenario();
  const a = await s.resposta("a"); const b = await s.resposta("b");
  await s.enviador({ limitePorRodada: 5 }).enviarPendentes();
  const g = s.gateway({ lote: 1 });
  await g.rodada();                                               // 1 sai (lote 1)
  s.envioLigado = false;
  await s.enviador().enviarPendentes();                           // suspensão chega ao relé
  await g.rodada(); await s.gateway({ id: "gw-b" }).rodada();
  assert.equal(s.envios.length, 1);
  assert.deepEqual([(await s.saida(a)).estado, (await s.saida(b)).estado], ["ENVIADA", "CANCELADA"]);
  assert.equal((await s.pool.query("select ligado from mova_rele.controle_saida")).rows[0].ligado, false);
});

t("S14 ordenação: as respostas saem na ordem em que foram criadas", async () => {
  const s = await cenario();
  for (const x of ["1", "2", "3"]) await s.resposta(x);
  await s.enviador({ limitePorRodada: 5 }).enviarPendentes();
  await s.gateway({ lote: 5 }).rodada();
  assert.deepEqual(s.envios.map((e) => e.texto), ["1", "2", "3"]);
});

t("S15 Gateway inerte por padrão: sem envio habilitado, sem contato verificado ou sem canal, a saída nem existe; fora da liderança não reserva", async () => {
  assert.deepEqual(lerSaidaMova({ canalAtivo: true, envioHabilitado: false, contatoHomologacao: {} }), { ativo: false, motivo: "ENVIO_DESLIGADO" });
  assert.deepEqual(lerSaidaMova({ canalAtivo: true, envioHabilitado: true, contatoHomologacao: null }), { ativo: false, motivo: "SEM_CONTATO_VERIFICADO" });
  assert.deepEqual(lerSaidaMova({ canalAtivo: false, envioHabilitado: true, contatoHomologacao: {} }), { ativo: false, motivo: "SEM_CANAL" });
  const s = await cenario();
  await s.resposta("x"); await s.enviador().enviarPendentes();
  assert.deepEqual(await s.gateway({ souLider: () => false }).rodada(), { enviadas: 0, pulada: true });
  assert.equal(s.envios.length, 0);
});
