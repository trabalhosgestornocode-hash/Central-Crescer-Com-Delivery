// MOVA (29/11/2026): notificação financeira CRÍTICA (pagamento, parcial, estorno) nunca expira por tempo. Esgotadas as tentativas, vira
// "falha pendente de resolução administrativa", com reenvio controlado que RELÊ o estado financeiro atual antes de reenviar.
// Lembretes e avisos comuns continuam com validade. Financeiro v2 real em memória, banco do MOVA isolado, Gateway simulado, dados sintéticos.
import assert from "node:assert/strict";
import { enfileiramentoDoTipo } from "../../src/modules/mova-financeiro/dominio/politicaEnvio.js";
import { ALFA, t } from "./helpers/operacao.js";
import { ADM, MAURICIO, SEG, ativar, cenario } from "./helpers/cenarioEntregadores.js";
import { ORG } from "./helpers/operacao.js";

const mais = (s, ms) => { s.estado.agora = new Date(Date.parse(s.estado.agora) + ms).toISOString(); };
const DIA = 86_400_000;

t("NC-1 classe: pagamento, parcial e estorno não têm validade; lembrete, demonstrativo e aviso comum têm", () => {
  const agora = new Date("2026-11-30T12:00:00Z");
  for (const tipo of ["PAGAMENTO", "PAGAMENTO_PARCIAL", "ESTORNO"]) assert.equal(enfileiramentoDoTipo(tipo, { agora }).validaAte, null, tipo);
  assert.equal(enfileiramentoDoTipo("PAGAMENTO", { agora, reenvio: true }).validaAte, null, "o reenvio da crítica também não expira");
  for (const tipo of ["COBRANCA_NOTA", "SEMANAL", "AVISO_DEMONSTRATIVO", "AVISO_NOTA_RECEBIDA", "AVISO_GRUPO"]) assert.ok(enfileiramentoDoTipo(tipo, { agora }).validaAte, tipo);
});

t("NC-2 falha do Gateway por dias: a notificação de pagamento NÃO expira, fica pendente de resolução administrativa e o reenvio (10 dias depois) entrega com o mesmo conteúdo", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  const antes = (await s.saida(MAURICIO))[0];
  assert.equal((await s.banco.pool.query("select valida_ate from mova.resposta where id = $1", [antes.id])).rows[0].valida_ate, null, "pagamento ao entregador sem validade");
  await s.marcar(MAURICIO, "FALHOU");
  await s.passada();
  mais(s, 10 * DIA);
  assert.equal((await s.mova.armazenamento.saida.expirarVencidas(new Date(s.estado.agora))).filter((x) => x.categoria === "TRANSACIONAL").length, 0, "nada crítico expira");
  const pend = await s.mova.pagamentos.pendentesDeResolucao({ organizacaoId: ORG, unidadeId: ALFA });
  assert.equal(pend.length, 1);
  assert.deepEqual([pend[0].situacao, pend[0].tipo, pend[0].reenviavel], ["FALHA_PENDENTE_DE_RESOLUCAO_ADMINISTRATIVA", "PAGAMENTO", true]);
  const [ev] = (await s.eventos()).filter((e) => e.destino === "ENTREGADOR");
  const re = await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM });
  assert.equal(re.ok, true);
  const textos = (await s.saida(MAURICIO)).map((x) => x.texto);
  assert.equal(textos.length, 2);
  assert.equal(textos[0], textos[1], "estado inalterado: mesmo conteúdo");
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  assert.equal((await s.mova.pagamentos.pendentesDeResolucao({ organizacaoId: ORG, unidadeId: ALFA })).length, 0, "resolvida: sai da lista");
});

t("NC-3 lembrete comum continua expirando (24 h) e fica visível como EXPIRADA, nunca enviado velho", async () => {
  const s = await cenario();
  const e = enfileiramentoDoTipo("COBRANCA_NOTA", { agora: new Date(s.estado.agora), organizacaoId: ORG, unidadeId: ALFA });
  const id = await s.mova.armazenamento.saida.enfileirar({ grupoId: MAURICIO, respostaA: null, eventoId: null, texto: "Lembrete de teste", simulada: true, ...e });
  mais(s, 2 * DIA);
  const exp = await s.mova.armazenamento.saida.expirarVencidas(new Date(s.estado.agora));
  assert.ok(exp.some((x) => x.id === id));
  assert.equal((await s.banco.pool.query("select estado from mova.resposta where id = $1", [id])).rows[0].estado, "EXPIRADA");
});

t("NC-4 reenvio relê o estado ATUAL: pagamento depois ESTORNADO não é reenviado; a tentativa é auditada e nada entra na fila", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  await s.marcar(MAURICIO, "FALHOU");
  await s.passada();
  const baixas = await s.real.consultarBaixasDeEntregadores(s.adm(ALFA), {});
  await s.real.estornarLiquidacao(s.adm(ALFA), { liquidacaoId: baixas.itens[0].liquidacaoId, valorCentavos: 1500, justificativa: "Estorno total de teste." });
  const [ev] = (await s.eventos()).filter((e) => e.destino === "ENTREGADOR");
  const filaAntes = (await s.saida(MAURICIO)).length;
  const re = await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM });
  assert.deepEqual([re.ok, re.motivo], [false, "ESTADO_FINANCEIRO_MUDOU"]);
  assert.equal((await s.saida(MAURICIO)).length, filaAntes, "nenhuma mensagem velha na fila");
  assert.equal((await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = 'NOTIFICACAO_PAGAMENTO_REENVIO_BARRADO'")).rows[0].c, 1);
});

t("NC-5 reenvio com o Financeiro indisponível não reenvia às cegas", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  await s.marcar(MAURICIO, "FALHOU");
  await s.passada();
  const [ev] = (await s.eventos()).filter((e) => e.destino === "ENTREGADOR");
  s.estado.financeiroFora = true;
  const re = await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM });
  assert.deepEqual([re.ok, re.motivo], [false, "FINANCEIRO_INDISPONIVEL"]);
  s.estado.financeiroFora = false;
  assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM })).ok, true, "com o Financeiro de volta, reenvia");
});
