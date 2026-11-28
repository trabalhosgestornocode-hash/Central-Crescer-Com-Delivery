// MOVA (28/11/2026): painel administrativo do envio — uso, limites efetivos, represamento, alertas, IA × determinístico; alteração de limites
// com permissão, escopo da sessão, justificativa, histórico e auditoria; isolamento entre empresas/unidades.
import assert from "node:assert/strict";
import { ALFA, BETA, ORG, t } from "./helpers/operacao.js";
import { ADM, cenario } from "./helpers/cenarioEntregadores.js";
import { ACOES_MOVA, CONSULTAS_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";

const ctxDe = (unidadeId, permissoes) => ({ organizacaoId: ORG, unidadeId, usuarioId: ADM, permissoes });
const VER = ["financeiro_v2.ver"], CONF = ["financeiro_v2.ver", "financeiro_v2.configurar"];
const alterar = (s, ctx, b) => executarAcaoMova(ACOES_MOVA["/mova/limite-envio"], { ctx, mova: s.mova, b });
const painel = (s, ctx) => CONSULTAS_MOVA["/mova/envio-painel"]({ ctx, mova: s.mova, params: {} });

t("EP-1 painel: padrão 2.000/100/500; só quem configura vê o geral; quem só vê enxerga a própria unidade, sem alertas nem histórico", async () => {
  const s = await cenario();
  const p = await painel(s, ctxDe(ALFA, CONF));
  assert.equal(p.disponivel, true);
  assert.deepEqual([p.limites.proativasDia, p.limites.proativasPorPrivadoDia, p.limites.proativasPorGrupoDia], [2000, 100, 500]);
  assert.equal(p.podeConfigurar, true);
  assert.ok("total" in p.uso && "porUnidade" in p.uso);
  const so = await painel(s, ctxDe(ALFA, VER));
  assert.equal(so.podeConfigurar, false);
  assert.ok(!("total" in so.uso) && !("porUnidade" in so.uso), "totais gerais (todas as empresas) só com configurar");
  assert.deepEqual(so.alertas, []);
  assert.deepEqual(so.historicoDeLimites, []);
  assert.ok(!JSON.stringify(p).includes("@s.whatsapp.net"), "telefone/JID nunca sai inteiro");
});

t("EP-2 alterar limite: exige configurar, justificativa e valor válido; escopo só da própria sessão; histórico e auditoria; efeito no painel", async () => {
  const s = await cenario();
  const base = { escopo: "UNIDADE", chave: ALFA, campo: "proativasDia", valor: 300, justificativa: "Teto menor para a primeira semana de uso." };
  await assert.rejects(() => alterar(s, ctxDe(ALFA, VER), base), (e) => e.codigo === "PERMISSAO_INSUFICIENTE" || e.status === 403);
  await assert.rejects(() => alterar(s, ctxDe(ALFA, CONF), { ...base, justificativa: "curta" }), (e) => e.codigo === "JUSTIFICATIVA_OBRIGATORIA" || e.status === 400);
  await assert.rejects(() => alterar(s, ctxDe(ALFA, CONF), { ...base, valor: -5 }), (e) => e.codigo === "VALOR_FORA_DA_FAIXA" || e.status === 400);
  await assert.rejects(() => alterar(s, ctxDe(ALFA, CONF), { ...base, campo: "inventado" }), (e) => e.codigo === "CAMPO_INVALIDO" || e.status === 400);
  await assert.rejects(() => alterar(s, ctxDe(ALFA, CONF), { ...base, chave: BETA }), (e) => e.codigo === "ESCOPO_FORA_DA_SESSAO" || e.status === 403, "uma unidade não altera a regra de outra");
  await assert.rejects(() => alterar(s, ctxDe(ALFA, CONF), { ...base, escopo: "EMPRESA", chave: "outra-empresa" }), (e) => e.codigo === "ESCOPO_FORA_DA_SESSAO" || e.status === 403);
  const r = await alterar(s, ctxDe(ALFA, CONF), base);
  assert.equal(r.valor, 300);
  const p = await painel(s, ctxDe(ALFA, CONF));
  assert.equal(p.limites.proativasDia, 300, "limite efetivo da unidade muda sem deploy");
  assert.equal(p.historicoDeLimites.length, 1);
  assert.equal(p.historicoDeLimites[0].justificativa, base.justificativa);
  // a regra da unidade A não vale para a unidade B
  const pb = await painel(s, ctxDe(BETA, CONF));
  assert.equal(pb.limites.proativasDia, 2000, "isolamento entre unidades");
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'LIMITE_DE_ENVIO_ALTERADO'")).rows[0].n, 1);
});

t("EP-3 painel mostra o uso por categoria e a separação IA × determinístico (métricas de atendimento)", async () => {
  const s = await cenario();
  const a = s.mova.armazenamento;
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  await a.metricas.registrar({ dia: hoje, unidadeId: ALFA, via: "DETERMINISTICA", intencao: "VALOR_SEMANA" });
  await a.metricas.registrar({ dia: hoje, unidadeId: ALFA, via: "DETERMINISTICA", intencao: "PREVISAO" });
  await a.metricas.registrar({ dia: hoje, unidadeId: ALFA, via: "IA", intencao: "OUTRA", chamadasIa: 1, tokensEntrada: 300, tokensSaida: 40 });
  const p = await painel(s, ctxDe(ALFA, CONF));
  assert.deepEqual(p.ia, { respostas: 3, deterministicas: 2, chamadasIa: 1, tokensEntrada: 300, tokensSaida: 40 });
  assert.equal(p.filaPrioritariaLigada, false, "a flag da fila priorizada vem desligada por padrão");
});
