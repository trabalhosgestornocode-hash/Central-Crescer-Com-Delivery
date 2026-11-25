// MOVA — Agente 2: POLÍTICAS DE RESPOSTA por grupo (PRIVADO_RESTRITO padrão, GRUPO_FINANCEIRO com retrato dos membros,
// OPERACIONAL). Tudo SINTÉTICO (helpers/operacao.js); comandos sem IA; nada é enviado ao WhatsApp.
import assert from "node:assert/strict";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, BETA, CONFIG, FIN, GRUPO, OPER, ORG, SO_ALFA, cenario, gw, t } from "./helpers/operacao.js";
import { decidirSaidaNoGrupo, RETRATO_VALIDADE_MS } from "../../src/modules/mova-financeiro/dominio/participantes.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const comPolitica = (politicaResposta, participantes = null) => ({
  ...CONFIG,
  gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta, ...(participantes ? { participantes } : {}) } : g)),
});
// Grupo financeiro pequeno: só duas pessoas FINANCEIRO, ambas nas duas unidades.
const SOCIO = "5500000000211@s.whatsapp.net";
const DOIS = [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }, { ids: [SO_ALFA], perfil: "FINANCEIRO", unidades: [ALFA] }];
const destinos = async (s) => (await s.saida()).map((r) => r.destino);

t("A2-P1 padrão PRIVADO_RESTRITO: sem política declarada, valores só no privado (aviso no grupo)", async () => {
  assert.equal(validarConfiguracao(CONFIG).gruposAutorizados.find((g) => g.grupoId === GRUPO).politicaResposta, "PRIVADO_RESTRITO");
  const s = await cenario();
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  assert.deepEqual(await destinos(s), [FIN, GRUPO]);
  assert.equal((await s.ultima()).politicaResposta, "PRIVADO_RESTRITO");
});

t("A2-P2 GRUPO_FINANCEIRO com retrato recente e TODOS autorizados: o valor sai no próprio grupo", async () => {
  const s = await cenario({ config: comPolitica("GRUPO_FINANCEIRO", DOIS) });
  await s.conta("2026-10-16", 30000);
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() });
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  const r = await s.saida();
  assert.deepEqual(r.map((x) => x.destino), [GRUPO]);
  assert.match(r[0].texto, /R\$ 300,00/);
  assert.equal((await s.ultima()).politicaResposta, "TODOS_OS_MEMBROS_AUTORIZADOS");
});

t("A2-P3 GRUPO_FINANCEIRO sem comprovação: sem retrato, retrato velho ou membro não autorizado ⇒ valor volta ao privado", async () => {
  const s = await cenario({ config: comPolitica("GRUPO_FINANCEIRO", DOIS) });
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  assert.equal((await s.ultima()).politicaResposta, "MEMBROS_NAO_COMPROVADOS");
  const velho = new Date(AGORA.getTime() - RETRATO_VALIDADE_MS - 1000).toISOString();
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: velho });
  await s.enviar(gw({ texto: "MOVA, contas vencidas da alfa" }));
  assert.equal((await s.ultima()).politicaResposta, "RETRATO_DESATUALIZADO");
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO, "5500000000299@s.whatsapp.net"], verificadoEm: AGORA.toISOString() });
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  assert.equal((await s.ultima()).politicaResposta, "MEMBRO_SEM_AUTORIZACAO");
  // Nenhuma resposta com valor saiu no grupo em nenhum dos três casos.
  for (const x of await s.saida()) if (x.destino === GRUPO) assert.doesNotMatch(x.texto, /R\$/);
});

t("A2-P4 GRUPO_FINANCEIRO: membro autorizado só na Alfa impede valores da Beta no grupo (mas não os da Alfa)", async () => {
  const s = await cenario({ config: comPolitica("GRUPO_FINANCEIRO", DOIS) });
  await s.conta("2026-10-16", 30000);
  const fornBeta = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético Beta" });
  await s.conta("2026-10-16", 40000, BETA, fornBeta);
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO, SO_ALFA], verificadoEm: AGORA.toISOString() });
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da beta" }));
  assert.equal((await s.ultima()).politicaResposta, "MEMBRO_SEM_AUTORIZACAO");
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  assert.equal((await s.ultima()).politicaResposta, "TODOS_OS_MEMBROS_AUTORIZADOS");
});

t("A2-P5 OPERACIONAL: consulta com valores recusada (nem no grupo, nem no privado); contagens e comandos continuam", async () => {
  const s = await cenario({ config: comPolitica("OPERACIONAL") });
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "GRUPO_OPERACIONAL"]);
  const r = await s.saida();
  assert.deepEqual(r.map((x) => x.destino), [GRUPO]);
  assert.doesNotMatch(r[0].texto, /R\$/);
  await s.enviar(gw({ texto: "MOVA, pendências da alfa", de: OPER }));
  assert.equal((await s.ultima()).decisao, "CONSULTA");
});

t("A2-P6 regras puras: política só com LISTA; consulta fora da lista do grupo vai ao privado; retrato do futuro não vale", () => {
  assert.throws(() => validarConfiguracao({ ...CONFIG, modo: "HOMOLOGACAO", gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], acesso: "ABERTO", politicaResposta: "GRUPO_FINANCEIRO" }] }), /politicaResposta/);
  const grupo = validarConfiguracao(comPolitica("GRUPO_FINANCEIRO", DOIS)).gruposAutorizados.find((g) => g.grupoId === GRUPO);
  const so = { ...grupo, consultasNoGrupo: ["FATURAMENTO"] };
  const ok = { membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() };
  assert.equal(decidirSaidaNoGrupo({ grupo: so, consulta: "CONTAS_A_PAGAR_ABERTAS", unidades: [ALFA], retrato: ok, agora: AGORA }).motivo, "CONSULTA_FORA_DO_GRUPO");
  assert.equal(decidirSaidaNoGrupo({ grupo: so, consulta: "FATURAMENTO", unidades: [ALFA], retrato: ok, agora: AGORA }).saida, "GRUPO");
  const futuro = { ...ok, verificadoEm: new Date(AGORA.getTime() + 60000).toISOString() };
  assert.equal(decidirSaidaNoGrupo({ grupo, consulta: "FATURAMENTO", unidades: [ALFA], retrato: futuro, agora: AGORA }).motivo, "RETRATO_DESATUALIZADO");
  assert.equal(decidirSaidaNoGrupo({ grupo, consulta: "PENDENCIAS", unidades: [ALFA], retrato: null, agora: AGORA }).saida, "GRUPO");
});
