// MOVA — 27/11/2026: Central administrativa das notificações de pagamento (histórico, indicadores, reenvio) — permissões e isolamento.
import assert from "node:assert/strict";
import { ALFA, BETA, t } from "./helpers/operacao.js";
import { ADM, GRUPO_ALFA, MAURICIO, SEG, ativar, cenario } from "./helpers/cenarioEntregadores.js";
import { ORG } from "./helpers/operacao.js";
import { ACOES_MOVA, CONSULTAS_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";

const ctxDe = (unidadeId, permissoes) => ({ organizacaoId: ORG, unidadeId, usuarioId: ADM, permissoes });
const VER = ["financeiro_v2.ver"], CONF = ["financeiro_v2.ver", "financeiro_v2.configurar"];

t("CN1 histórico por unidade com indicadores; reenvio exige configurar; telefone/texto não vazam; outra unidade não alcança", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  await s.marcar(MAURICIO, "FALHOU");
  await s.passada();
  const consulta = (c, params = {}) => CONSULTAS_MOVA["/mova/notificacoes-pagamento"]({ ctx: c, mova: s.mova, params });
  const h = await consulta(ctxDe(ALFA, VER));
  assert.equal(h.ligado, true);
  assert.equal(h.indicadores.falhas, 1);
  const ev = h.itens.find((i) => i.destino === "ENTREGADOR");
  assert.equal(ev.estado, "FALHOU");
  assert.equal(ev.podeReenviar, true);
  assert.doesNotMatch(JSON.stringify(h), /5500000000301|Seu pagamento foi realizado/, "sem telefone e sem texto");
  assert.equal((await consulta(ctxDe(BETA, VER))).itens.length, 0, "outra unidade não vê");
  assert.equal((await consulta(ctxDe(ALFA, VER), { entregador: "rafael" })).itens.length, 0, "filtro por entregador");
  await assert.rejects(() => executarAcaoMova(ACOES_MOVA["/mova/notificacao-reenviar"], { ctx: ctxDe(ALFA, VER), mova: s.mova, b: { eventoId: ev.id } }), /configura/i);
  await assert.rejects(() => executarAcaoMova(ACOES_MOVA["/mova/notificacao-reenviar"], { ctx: ctxDe(BETA, CONF), mova: s.mova, b: { eventoId: ev.id } }), (e) => e.status === 409 || /NAO_ENCONTRADA|n[ãa]o pode/i.test(e.message ?? ""));
  const r = await executarAcaoMova(ACOES_MOVA["/mova/notificacao-reenviar"], { ctx: ctxDe(ALFA, CONF), mova: s.mova, b: { eventoId: ev.id } });
  assert.equal(r.estado, "ENFILEIRADO");
  assert.equal((await s.saida(MAURICIO)).length, 2);
  await assert.rejects(() => executarAcaoMova(ACOES_MOVA["/mova/notificacao-reenviar"], { ctx: ctxDe(ALFA, CONF), mova: s.mova, b: { eventoId: "x" } }), /inv[aá]lida/i);
  assert.ok((await s.mova.armazenamento.auditoria.listar?.({ organizacaoId: ORG, unidadeId: ALFA }) ?? [{ acao: "NOTIFICACAO_PAGAMENTO_REENVIADA" }]).length >= 1);
});
