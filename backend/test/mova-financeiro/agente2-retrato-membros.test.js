// MOVA — Agente 2: RETRATO DOS MEMBROS vindo do Gateway (`membrosGrupo` no evento) como base da política GRUPO_FINANCEIRO.
// Tudo SINTÉTICO (helpers/operacao.js); comandos sem IA; nada é enviado ao WhatsApp.
import assert from "node:assert/strict";
import { CONFIG, FIN, GRUPO, cenario, gw, t } from "./helpers/operacao.js";
import { normalizarGatewayMova } from "../../src/modules/mova-financeiro/adaptadores/gatewayBaileys.js";
import { RETRATO_VALIDADE_MS } from "../../src/modules/mova-financeiro/dominio/participantes.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const SOCIO = "5500000000211@s.whatsapp.net";
const ESTRANHO = "5500000000299@s.whatsapp.net";
const DOIS = [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }];
const financeiro = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO", participantes: DOIS } : g)) };
const comRetrato = (p, membros, verificadoEm = AGORA.toISOString()) => ({ ...p, membrosGrupo: { membros, verificadoEm } });
const PERGUNTA = "MOVA, contas a pagar da semana da alfa";

t("A2-R1 retrato do Gateway com TODOS autorizados ⇒ valor no grupo; a lista de membros não fica na fila", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  await s.enviar(comRetrato(gw({ texto: PERGUNTA }), [FIN, SOCIO]));
  const r = await s.saida();
  assert.deepEqual(r.map((x) => x.destino), [GRUPO]);
  assert.match(r[0].texto, /R\$ 300,00/);
  assert.equal((await s.ultima()).politicaResposta, "TODOS_OS_MEMBROS_AUTORIZADOS");
  const carga = (await s.banco.pool.query("select carga from mova.fila")).rows.map((x) => x.carga);
  assert.ok(carga.length > 0 && carga.every((c) => !("membrosGrupo" in c)), "retrato não vai para a fila");
  const g = (await s.banco.pool.query("select membros, fonte from mova.grupo_membros where grupo_jid = $1", [GRUPO])).rows[0];
  assert.deepEqual([...g.membros].sort(), [FIN, SOCIO].sort());
  assert.equal(g.fonte, "GATEWAY");
});

t("A2-R2 novo membro NÃO autorizado entra no grupo ⇒ a próxima resposta com valores volta ao privado", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  await s.enviar(comRetrato(gw({ texto: PERGUNTA }), [FIN, SOCIO]));
  await s.enviar(comRetrato(gw({ texto: "MOVA, contas vencidas da alfa" }), [FIN, SOCIO, ESTRANHO]));
  assert.equal((await s.ultima()).politicaResposta, "MEMBRO_SEM_AUTORIZACAO");
  const doGrupo = (await s.saida()).filter((x) => x.destino === GRUPO);
  assert.equal(doGrupo.filter((x) => /R\$/.test(x.texto)).length, 1, "só a primeira (todos autorizados) mostrou valor no grupo");
});

t("A2-R3 retrato VENCIDO ou do FUTURO é descartado (nada comprovado ⇒ privado)", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  const velho = new Date(AGORA.getTime() - RETRATO_VALIDADE_MS - 1000).toISOString();
  await s.enviar(comRetrato(gw({ texto: PERGUNTA }), [FIN, SOCIO], velho));
  assert.equal((await s.ultima()).politicaResposta, "MEMBROS_NAO_COMPROVADOS");
  const futuro = new Date(AGORA.getTime() + 5 * 60 * 1000).toISOString();
  await s.enviar(comRetrato(gw({ texto: "MOVA, contas vencidas da alfa" }), [FIN, SOCIO], futuro));
  assert.equal((await s.ultima()).politicaResposta, "MEMBROS_NAO_COMPROVADOS");
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.grupo_membros")).rows[0].n, 0);
  for (const x of await s.saida()) if (x.destino === GRUPO) assert.doesNotMatch(x.texto, /R\$/);
});

t("A2-R4 mensagem duplicada (reenvio do Gateway) ⇒ uma única resposta no grupo", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  const p = comRetrato(gw({ texto: PERGUNTA }), [FIN, SOCIO]);
  await s.enviar(p);
  const r2 = await s.enviar({ ...p, membrosGrupo: { ...p.membrosGrupo } });
  assert.equal(r2.status, "DUPLICADO");
  assert.equal((await s.saida()).filter((x) => x.destino === GRUPO).length, 1);
});

t("A2-R5 participante NÃO autorizado pergunta ⇒ nada é respondido (mesmo com todos os outros autorizados)", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  const r = await s.enviar(comRetrato(gw({ texto: PERGUNTA, de: ESTRANHO }), [FIN, SOCIO, ESTRANHO]));
  assert.equal(r.status, "IGNORADO");
  assert.equal(r.motivo, "PARTICIPANTE_NAO_AUTORIZADO");
  assert.equal((await s.saida()).length, 0);
});

t("A2-R6 contrato fechado do retrato: formato inválido recusa o evento; ausente continua aceito (Gateway antigo)", () => {
  const base = gw({ texto: PERGUNTA });
  assert.equal(normalizarGatewayMova(base).ok, true, "sem retrato: compatível");
  assert.equal(normalizarGatewayMova({ ...base, membrosGrupo: null }).ok, true);
  const ruins = [
    { membros: ["nao-e-jid"], verificadoEm: AGORA.toISOString() },
    { membros: [], verificadoEm: AGORA.toISOString() },
    { membros: [FIN, FIN], verificadoEm: AGORA.toISOString() },
    { membros: [FIN], verificadoEm: "ontem" },
    { membros: [FIN], verificadoEm: AGORA.toISOString(), extra: 1 },
    { membros: Array.from({ length: 1025 }, (_, i) => `55000000${String(i).padStart(5, "0")}@s.whatsapp.net`), verificadoEm: AGORA.toISOString() },
  ];
  for (const membrosGrupo of ruins) assert.deepEqual(normalizarGatewayMova({ ...base, membrosGrupo }), { ok: false, motivo: "membrosGrupo" });
  const privado = { ...base, grupoId: "5500000000201@s.whatsapp.net", membrosGrupo: { membros: [FIN], verificadoEm: AGORA.toISOString() } };
  assert.deepEqual(normalizarGatewayMova(privado), { ok: false, motivo: "membrosGrupo" }, "retrato só vale em grupo");
  const lid = normalizarGatewayMova({ ...base, membrosGrupo: { membros: [FIN, "123456789012345@lid"], verificadoEm: AGORA.toISOString() } });
  assert.equal(lid.ok, true);
});

t("A2-R7 membro só-LID desconhecido no retrato ⇒ privado (identidade não comprovada nunca libera valores)", async () => {
  const s = await cenario({ config: financeiro });
  await s.conta("2026-10-16", 30000);
  await s.enviar(comRetrato(gw({ texto: PERGUNTA }), [FIN, SOCIO, "123456789012345@lid"]));
  assert.equal((await s.ultima()).politicaResposta, "MEMBRO_SEM_AUTORIZACAO");
});
