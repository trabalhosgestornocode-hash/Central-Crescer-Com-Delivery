// MOVA — Agente 2 (23/11/2026): teto operacional DIÁRIO e por conversa do envio de respostas (rotina semanal dos entregadores).
// Persistente (contado no banco desde 00h de America/Fortaleza), configurável, nunca ampliado pelo código; independente da IA.
import assert from "node:assert/strict";
import { GRUPO, cenario, t } from "./helpers/operacao.js";
import { criarEnviadorDeRespostas } from "../../src/modules/mova-financeiro/index.js";

const OUTRA = "5500000000777@s.whatsapp.net";
async function enfileirar(s, destino, n, prefixo) {
  for (let i = 1; i <= n; i++) await s.mova.armazenamento.saida.enfileirar({ grupoId: destino, respostaA: `${prefixo}${i}`, texto: `${prefixo}${i}`, eventoId: null });
}
const estados = async (s) => (await s.banco.pool.query("select grupo_jid, estado, ultimo_erro from mova.resposta order by seq")).rows;

t("A2-L1 teto diário: nunca passa do máximo do dia, mesmo com enviadores novos (persistente); excedente FALHOU com auditoria", async () => {
  const s = await cenario();
  await enfileirar(s, GRUPO, 5, "d");
  const enviados = [];
  const novo = () => criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO],
    maximoPorDia: 3, limitePorRodada: 2, enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: `P${enviados.length}` }; } });
  for (let i = 0; i < 4; i++) await novo().enviarPendentes();
  assert.deepEqual(enviados, ["d1", "d2", "d3"], "texto intacto (sem aviso no texto) e só 3 no dia");
  const r = await estados(s);
  assert.deepEqual(r.filter((x) => x.estado === "FALHOU").map((x) => x.ultimo_erro), ["TETO_DIARIO_DE_ENVIOS", "TETO_DIARIO_DE_ENVIOS"]);
  const { rows } = await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'MOVA_ENVIO_BLOQUEADO_PELO_TETO_DIARIO'");
  assert.equal(rows[0].n, 2);
});

t("A2-L2 teto por conversa (anti-laço): uma conversa não passa do máximo; as outras seguem", async () => {
  const s = await cenario();
  await enfileirar(s, GRUPO, 3, "a");
  await enfileirar(s, OUTRA, 2, "b");
  const enviados = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO, OUTRA],
    maximoPorDia: 50, maximoPorConversaDia: 2, limitePorRodada: 10, enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: `P${enviados.length}` }; } });
  await e.enviarPendentes();
  assert.deepEqual(enviados.sort(), ["a1", "a2", "b1", "b2"]);
  const r = await estados(s);
  assert.deepEqual(r.filter((x) => x.estado === "FALHOU").map((x) => [x.grupo_jid, x.ultimo_erro]), [[GRUPO, "TETO_DIARIO_DA_CONVERSA"]]);
  // novo enviador (reinício): a contagem por conversa vem do banco
  await enfileirar(s, GRUPO, 1, "c");
  const e2 = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO, OUTRA],
    maximoPorDia: 50, maximoPorConversaDia: 2, enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: "PX" }; } });
  await e2.enviarPendentes();
  assert.equal(enviados.length, 4, "reiniciar não zera o teto da conversa");
});

t("A2-L3 virada do dia (00h Fortaleza): o teto do dia novo começa do zero; sem teto diário configurado, nada muda", async () => {
  const s = await cenario();
  await enfileirar(s, GRUPO, 2, "x");
  const enviados = [];
  const enviar = async (r) => { enviados.push(r.texto); return { providerMessageId: `P${enviados.length}` }; };
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], maximoPorDia: 1, enviar }).enviarPendentes();
  assert.deepEqual(enviados, ["x1"]);
  await enfileirar(s, GRUPO, 1, "y");
  const amanha = () => new Date(Date.now() + 24 * 3600_000);
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], maximoPorDia: 1, relogio: amanha, enviar }).enviarPendentes();
  assert.deepEqual(enviados, ["x1", "y1"], "no dia seguinte sai de novo (até o teto do dia)");
  await enfileirar(s, GRUPO, 3, "z");
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], enviar }).enviarPendentes();
  assert.equal(enviados.length, 5, "sem teto configurado: comportamento anterior");
});
