// MOVA — 27/11/2026: AUDITORIA da rotina semanal dos entregadores para a segunda-feira 30/11/2026 às 10h (America/Fortaleza).
// Financeiro v2 REAL em memória + banco do MOVA isolado; Gateway SIMULADO (nada sai para o WhatsApp). Duas empresas separadas.
import assert from "node:assert/strict";
import { ALFA, BETA, t } from "./helpers/operacao.js";
import { GRUPO_ALFA, GRUPO_BETA, MAURICIO, RAFAEL, cenario, SEG } from "./helpers/cenarioEntregadores.js";
import { ORG } from "./helpers/operacao.js";
import { AUTOMACAO } from "../../src/modules/mova-financeiro/index.js";

const SEMANA = "2026-11-23"; // segunda a domingo (23/11 a 29/11)
const FECHA = [SEG, "2026-11-09", SEMANA];
const SEG_0959 = "2026-11-30T12:59:00.000Z"; // 09:59 em Fortaleza (UTC-3)
const SEG_1000 = "2026-11-30T13:00:00.000Z"; // 10:00 em Fortaleza
const TER_1000 = "2026-12-01T13:00:00.000Z";
const ADM = "eeeeeeee-0000-4000-8000-000000000001";

async function ligar(s, { semanal = true, ultima = null } = {}) {
  for (const u of [ALFA, BETA]) {
    for (const nome of [AUTOMACAO.SEMANAL, AUTOMACAO.COBRANCA, AUTOMACAO.AVISO_GRUPO]) {
      await s.mova.armazenamento.automacoes.definir({ nome, organizacaoId: ORG, unidadeId: u, ativa: nome !== AUTOMACAO.SEMANAL || semanal, horario: nome === AUTOMACAO.AVISO_GRUPO ? "00:00" : "10:00" });
    }
    if (ultima) await s.mova.armazenamento.automacoes.marcarExecucao(AUTOMACAO.SEMANAL, u, ultima);
  }
}
const privados = async (s) => (await s.saida()).filter((x) => [MAURICIO, RAFAEL].includes(x.destino));

t("RS1 segunda 30/11: 09:59 não envia; 10:00 envia o fechamento de 23/11 a 29/11 a cada entregador com telefone, por empresa; idempotente; reinício não duplica", async () => {
  const s = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(s);
  s.estado.agora = SEG_0959;
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "antes das 10h nada sai");
  s.estado.agora = SEG_1000;
  const r = await s.mova.entregadores.rotina();
  assert.equal(r.semanais, 3, "Mauricio (2 empresas) + Rafael; Zeca não tem telefone");
  const out = await privados(s);
  assert.equal(out.length, 3);
  const doMauricio = out.filter((x) => x.destino === MAURICIO).map((x) => x.texto);
  assert.equal(doMauricio.length, 2, "uma mensagem por empresa, nunca somadas");
  const alfa = doMauricio.find((x) => /Acai Alfa/.test(x)), beta = doMauricio.find((x) => /Subway Beta/.test(x));
  assert.match(alfa, /23\/11\/2026 a 29\/11\/2026/);
  assert.match(alfa, /2 entrega\(s\) — R\$ 14,00/);
  assert.match(beta, /23\/11\/2026 a 29\/11\/2026/);
  assert.match(beta, /1 entrega\(s\) — R\$ 12,00/);
  assert.doesNotMatch(alfa, /12,00|Subway/);
  assert.doesNotMatch(beta, /14,00|Acai/);
  for (const m of out.map((x) => x.texto)) {
    assert.match(m, /Envie a nota fiscal \(NFS-e em PDF\)/, "solicitação da nota");
    assert.match(m, /Previsão de pagamento: \d{2}\/\d{2}\/2026/, "previsão de pagamento");
  }
  assert.doesNotMatch(out.find((x) => x.destino === RAFAEL).texto, /14,00|12,00|Mauricio/);
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "segunda passada na mesma segunda: nada novo");
  s.reiniciar();
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "reinício do servidor não reenvia");
  assert.equal((await privados(s)).length, 3);
  // grupo financeiro: só depois do retorno do WhatsApp, e só da própria empresa
  await s.marcar(MAURICIO, "ENVIADA");
  await s.marcar(RAFAEL, "ENVIADA");
  await s.mova.entregadores.rotina();
  const gAlfa = (await s.saida(GRUPO_ALFA)).map((x) => x.texto).join("\n"), gBeta = (await s.saida(GRUPO_BETA)).map((x) => x.texto).join("\n");
  assert.match(gAlfa, /Mauricio/);
  assert.match(gAlfa, /Rafael/);
  assert.match(gBeta, /Mauricio/);
  assert.doesNotMatch(gBeta, /Rafael/);
});

t("RS2 falha do Gateway não duplica: o envio é registrado uma vez e a falha é avisada ao grupo da empresa", async () => {
  const s = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(s);
  s.estado.agora = SEG_1000;
  await s.mova.entregadores.rotina();
  await s.marcar(RAFAEL, "FALHOU");
  await s.mova.entregadores.rotina();
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0);
  assert.equal((await s.saida(RAFAEL)).length, 1, "nenhum reenvio automático duplicado");
  assert.match((await s.saida(GRUPO_ALFA)).map((x) => x.texto).join("\n"), /não entregue|não foi entregue|falh/i);
});

t("RS3 retomada: se o serviço ficou fora na segunda, terça completa o que faltou (sem duplicar); sem execução recente ou na quinta, não dispara", async () => {
  const s = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(s, { ultima: "2026-11-24T02:59:00.000Z" }); // rodou na segunda 23/11
  s.estado.agora = "2026-12-01T12:00:00.000Z"; // terça 09:00: ainda não é 10h
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0);
  s.estado.agora = TER_1000;
  assert.equal((await s.mova.entregadores.rotina()).semanais, 3, "retomada na terça às 10h");
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "e não repete");
  const nunca = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(nunca); // nunca rodou: religar na terça NÃO dispara semana antiga
  nunca.estado.agora = TER_1000;
  assert.equal((await nunca.mova.entregadores.rotina()).semanais, 0);
  const quinta = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(quinta, { ultima: "2026-11-24T02:59:00.000Z" });
  quinta.estado.agora = "2026-12-03T13:00:00.000Z";
  assert.equal((await quinta.mova.entregadores.rotina()).semanais, 0, "a janela de retomada é terça e quarta");
});

t("RS4 cobrança só de quem não mandou a nota válida: terça 01/12, nota aprovada não é cobrada; pendente é", async () => {
  const s = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(s);
  s.estado.agora = SEG_1000;
  await s.mova.entregadores.rotina();
  await s.liberar(ALFA, SEMANA, "rafael", "Rafael Sintetico", 1000); // Rafael já enviou nota válida e foi liberado
  s.estado.agora = TER_1000;
  const r = await s.mova.entregadores.rotina();
  assert.ok(r.cobrancas >= 1);
  assert.equal((await s.saida(RAFAEL)).some((x) => /Lembrete/.test(x.texto)), false, "quem já enviou nota válida não recebe cobrança");
  assert.equal((await s.saida(MAURICIO)).some((x) => /Lembrete/.test(x.texto)), true, "quem não enviou recebe");
  assert.equal((await s.mova.entregadores.rotina()).cobrancas, 0, "uma cobrança por dia");
});

t("RS5 a automação pausada de UMA empresa não afeta a outra", async () => {
  const s = await cenario({ semanas: FECHA, agora: "2026-11-30T11:00:00.000Z" });
  await ligar(s);
  await s.mova.armazenamento.automacoes.pausar({ nome: AUTOMACAO.SEMANAL, unidadeId: ALFA, por: ADM, motivo: "conferência" });
  s.estado.agora = SEG_1000;
  const r = await s.mova.entregadores.rotina();
  assert.equal(r.semanais, 1, "só a empresa Beta (Mauricio) enviou");
});
