// MOVA — Execução 12D: regressão do primeiro recebimento real. O WhatsApp identificou o contato autorizado SEM o nono dígito
// (55+DDD+8) enquanto a conversa estava cadastrada COM ele (55+DDD+9+8); o receptor descartava como "não é grupo", sem
// registro, e o consumidor do relé confirmava. Números FICTÍCIOS (DDD 99). Sem banco, sem Anthropic, sem WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { criarArmazenamentoMemoria, criarConsumidorRele, criarEvidenciasMemoria, criarFilaMemoria, criarReceptor, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { conversaAutorizada } from "../../src/modules/mova-financeiro/dominio/configuracao.js";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const BETA = "dddddddd-0000-4000-8000-0000000000b1";
const COM9 = "5599990000001@s.whatsapp.net";   // cadastrado
const SEM9 = "559990000001@s.whatsapp.net";    // como o WhatsApp entregou
const OUTRO = "559990000002@s.whatsapp.net";
const config = (modo = "HOMOLOGACAO", grupos = [{ grupoId: COM9, unidades: [ALFA] }]) => validarConfiguracao({
  modo, identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Unidade Teste Alfa", fontes: { situacao: "A_CONFIRMAR" } },
    { organizacaoId: ORG, unidadeId: BETA, nome: "Unidade Teste Beta", fontes: { situacao: "A_CONFIRMAR" } },
  ],
  gruposAutorizados: grupos,
});
let seq = 0;
const evento = (jid = SEM9, x = {}) => ({ contratoMova: 1, eventoId: `bly:D${++seq}`, mensagemId: `D${seq}`, grupoId: jid, participanteId: jid, telefoneE164: `+${jid.split("@")[0]}`,
  nomeExibicao: null, fromMe: false, tipo: "TEXTO", texto: "teste", respostaA: null, midia: null, recebidoEm: "2026-11-21T17:02:01.000Z", origemTipo: "LIVE", ...x });
function montar(cfg = config(), { ligados = { recebimento: true, processamento: false } } = {}) {
  const fila = criarFilaMemoria(); const cargas = []; const enf = fila.enfileirar.bind(fila);
  fila.enfileirar = (id, carga) => { const r = enf(id, carga); if (r.aceito) cargas.push(carga); return r; };
  const armazenamento = criarArmazenamentoMemoria(); const logs = [];
  const processados = [];
  const receptor = criarReceptor({ cfg, fila, armazenamento, evidencias: criarEvidenciasMemoria(), motor: { processar: async (e) => { processados.push(e); return { decisao: "OK" }; } },
    controle: { ligado: async (k) => ligados[k] === true }, registrar: (x) => logs.push(x) });
  return { receptor, fila, cargas, armazenamento, logs, processados };
}

test("conversaAutorizada: nono dígito equivalente só para conversa privada no modo HOMOLOGACAO", () => {
  assert.equal(conversaAutorizada(config(), SEM9).grupoId, COM9);
  assert.equal(conversaAutorizada(config(), COM9).grupoId, COM9);
  assert.equal(conversaAutorizada(config("HOMOLOGACAO", [{ grupoId: SEM9, unidades: [ALFA] }]), COM9).grupoId, SEM9);
  assert.equal(conversaAutorizada(config(), OUTRO), null);
  assert.equal(conversaAutorizada(config("HOMOLOGACAO", [{ grupoId: COM9, unidades: [ALFA] }, { grupoId: SEM9, unidades: [BETA] }]), "5599990000001@s.whatsapp.net").grupoId, COM9, "exata vence");
  // fixo (começa com 2–5) não tem nono dígito: sem equivalência
  assert.equal(conversaAutorizada(config("HOMOLOGACAO", [{ grupoId: "5599930000001@s.whatsapp.net", unidades: [ALFA] }]), "559930000001@s.whatsapp.net"), null);
});

test("01 recebimento autorizado com JID sem nono dígito: ENFILEIRADO no JID cadastrado (antes: IGNORADO sem registro)", async () => {
  const s = montar();
  const r = await s.receptor.receber(evento(SEM9));
  assert.equal(r.status, "ENFILEIRADO");
  assert.equal((await s.fila.listar()).length, 1);
  assert.equal(s.cargas[0].grupoId, COM9, "fila/unidades/participantes usam o JID cadastrado");
  assert.ok(s.logs.some((l) => l.tipo === "MOVA_CONVERSA_PRIVADA_NONO_DIGITO"));
});

test("02 contato não autorizado: IGNORADO sem nenhum registro no banco (decisão 04B), só código no log", async () => {
  const s = montar();
  assert.deepEqual(await s.receptor.receber(evento(OUTRO)), { status: "IGNORADO", motivo: "NAO_E_GRUPO" });
  assert.equal((await s.armazenamento.historico.todos()).length, 0);
  assert.equal((await s.fila.listar()).length, 0);
  assert.ok(s.logs.some((l) => l.tipo === "MOVA_CONVERSA_PRIVADA_NAO_AUTORIZADA"));
  assert.ok(!JSON.stringify(s.logs).includes("559990000002"));
});

test("03 PN/LID: JID não-telefone (@lid) em conversa privada continua recusado pelo contrato", async () => {
  const s = montar();
  assert.equal((await s.receptor.receber(evento("123456789012345@lid"))).status, "IGNORADO");
  assert.equal((await s.fila.listar()).length, 0);
});

test("04 mensagem da própria conta na conversa autorizada: IGNORADO MENSAGEM_PROPRIA", async () => {
  const s = montar();
  assert.deepEqual(await s.receptor.receber(evento(SEM9, { fromMe: true })), { status: "IGNORADO", motivo: "MENSAGEM_PROPRIA" });
  assert.equal((await s.fila.listar()).length, 0);
});

test("05 duplicidade: mesmo eventoId nas duas formas do número entra uma vez", async () => {
  const s = montar();
  const e = evento(SEM9);
  assert.equal((await s.receptor.receber(e)).status, "ENFILEIRADO");
  assert.equal((await s.receptor.receber({ ...e })).status, "DUPLICADO");
  assert.equal((await s.receptor.receber({ ...e, grupoId: COM9, participanteId: COM9, telefoneE164: "+5599990000001" })).status, "DUPLICADO");
  assert.equal((await s.fila.listar()).length, 1);
});

test("09 isolamento: fora do modo HOMOLOGACAO não há equivalência; grupo continua exigindo igualdade exata", async () => {
  const cfgSim = config("SIMULACAO", [{ grupoId: "120363000000000001@g.us", unidades: [ALFA] }]);
  assert.equal(conversaAutorizada(cfgSim, SEM9), null);
  assert.equal(conversaAutorizada(cfgSim, "120363000000000002@g.us"), null);
});

test("10 processamento desligado: receber enfileira e trabalhar não chama o motor (IA/envio nem são alcançados)", async () => {
  const s = montar();
  await s.receptor.receber(evento(SEM9));
  assert.equal(await s.receptor.trabalhar(), 0);
  assert.equal(s.processados.length, 0);
});

// ---- consumidor do relé (pool simulado com o mesmo contrato das funções mova_rele.*) ----
const SEG = "s".repeat(48);
function linhaDoRele(payload) {
  const corpo = JSON.stringify(payload); const sha = createHash("sha256").update(corpo).digest("hex");
  const ts = "1"; const nonce = "n".repeat(16); const caminho = "/internal/mova/eventos/mova-grupo";
  const assinatura = createHmac("sha256", SEG).update([ts, nonce, "POST", caminho, sha].join("\n")).digest("hex");
  return { evento_id: payload.eventoId, corpo, sha256: sha, assinatura_ts: ts, assinatura_nonce: nonce, assinatura, caminho };
}
function poolRele(linhas) {
  const chamadas = [];
  return { chamadas, query: async (sql, p) => {
    if (sql.includes("reservar")) { const r = linhas.splice(0); return { rows: r }; }
    if (sql.includes("confirmar")) { chamadas.push(["CONFIRMAR", p[0]]); return { rows: [{ ok: true }] }; }
    if (sql.includes("devolver")) { chamadas.push(["DEVOLVER", p[0], p[2], p[3]]); return { rows: [{ r: true }] }; }
    throw new Error(sql);
  } };
}

test("08 ACK: persistido ⇒ confirma; ignorado ⇒ confirma COM motivo no log; falha de gravação ⇒ devolve (sem ACK)", async () => {
  const s = montar();
  const ok = evento(SEM9); const ign = evento(OUTRO);
  const pool = poolRele([linhaDoRele(ok), linhaDoRele(ign)]); const logs = [];
  await criarConsumidorRele({ pool, receptor: s.receptor, segredo: SEG, registrar: (x) => logs.push(x) }).rodada();
  assert.deepEqual(pool.chamadas, [["CONFIRMAR", ok.eventoId], ["CONFIRMAR", ign.eventoId]]);
  assert.deepEqual(logs.filter((l) => l.tipo === "MOVA_RELE_IGNORADO").map((l) => l.motivo), ["NAO_E_GRUPO"]);

  // 06 falha de persistência: a fila lança ⇒ RECEPTOR_ERRO e nova tentativa, nunca PROCESSADO
  const falha = montar(); falha.fila.enfileirar = () => { throw new Error("disco"); };
  const e = evento(SEM9); const p2 = poolRele([linhaDoRele(e)]);
  await criarConsumidorRele({ pool: p2, receptor: falha.receptor, segredo: SEG }).rodada();
  assert.deepEqual(p2.chamadas, [["DEVOLVER", e.eventoId, "RECEPTOR_ERRO", false]]);
});

test("07 consumidor indisponível/recebimento desligado: nada é reservado; ao religar, o evento é entregue", async () => {
  const ligados = { recebimento: false };
  const s = montar(config(), { ligados: { recebimento: true } });
  const e = evento(SEM9); const linhas = [linhaDoRele(e)]; const pool = poolRele(linhas);
  const c = criarConsumidorRele({ pool, receptor: s.receptor, segredo: SEG, controle: { ligado: async (k) => ligados[k] === true } });
  assert.deepEqual(await c.rodada(), { pausado: true, entregues: 0 });
  assert.equal(linhas.length, 1, "evento continua no relé");
  ligados.recebimento = true;
  assert.equal((await c.rodada()).entregues, 1);
  assert.equal(s.cargas[0].grupoId, COM9);
});
