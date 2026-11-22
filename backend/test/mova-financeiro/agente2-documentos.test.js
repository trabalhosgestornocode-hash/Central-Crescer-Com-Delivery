// MOVA — Agente 2, Frente B: DOCUMENTOS no grupo real (comprovantes). Tudo SINTÉTICO (helpers/operacao.js); IA simulada.
import assert from "node:assert/strict";
import { validarSaidaDaIa } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, DUAS_EMPRESAS, FIN, GRUPO, GRUPO_X, ORG, ORG_X, base, cenario, gw, t } from "./helpers/operacao.js";

const PIX = (extra = {}) => base({
  tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 30000, dataPagamento: "2026-10-14", favorecido: "Fornecedor Sintético",
  pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", idTransacao: "E00000000202610141200SINTETICO01", ...extra,
});

t("A2-B1 comprovante Pix: baixa PROPOSTA (nunca lançada), com pagador/banco/ID da transação e aguardando extrato", async () => {
  const s = await cenario({ responder: () => PIX() });
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: "%PDF comprovante sintético B1" }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PROPOSTA", "BAIXA_DE_OBRIGACAO"]);
  const [p] = await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.deepEqual([p.estado, p.leitura.idTransacao, p.leitura.instituicao, p.leitura.pagador], ["AGUARDANDO_REVISAO", "E00000000202610141200SINTETICO01", "Banco Sintético", "Loja Alfa Sintética"]);
  assert.deepEqual(p.conciliacao, { situacao: "AGUARDANDO_EXTRATO", idTransacao: "E00000000202610141200SINTETICO01" });
  // Nada foi escrito no Financeiro: só leituras, todas com "ver".
  assert.ok(s.chamadas.every((x) => x.permissoes.length === 1));
  assert.equal((await s.m.nucleo.consultarContasAPagar(s.c(ORG, ALFA), {})).itens[0].situacao, "EM_ABERTO");
});

t("A2-B2 a MESMA transação em outro arquivo (foto × PDF): duplicidade pelo ID, sem segunda proposta", async () => {
  const s = await cenario({ responder: () => PIX() });
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: "%PDF comprovante sintético B2" }));
  await s.enviar(gw({ texto: "MOVA comprovante da alfa (print)", doc: "PNG-sintético-outro-arquivo-B2" }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["DUPLICADO", "TRANSACAO_JA_RECEBIDA"]);
  assert.equal((await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).length, 1);
});

t("A2-B3 o ID da transação não cruza empresas: o mesmo ID em outra organização não é tratado como duplicado", async () => {
  const s = await cenario({ responder: () => PIX() });
  await s.conta("2026-10-16", 30000);
  await s.enviar(gw({ texto: "MOVA comprovante da alfa", doc: "%PDF comprovante sintético B3" }));
  await s.enviar(gw({ texto: "MOVA comprovante", grupo: GRUPO_X, de: DUAS_EMPRESAS, doc: "%PDF outro arquivo B3" }));
  const h = await s.ultima();
  assert.notEqual(h.motivo, "TRANSACAO_JA_RECEBIDA");
  assert.equal(h.organizacaoId, ORG_X);
  void FIN; void GRUPO;
});

t("A2-B4 contrato: ID da transação com espaço/controle invalida a leitura inteira; campos ausentes ficam null", () => {
  assert.equal(validarSaidaDaIa(PIX({ idTransacao: "E000 0000" })).ok, false);
  assert.equal(validarSaidaDaIa(PIX({ idTransacao: "ab" })).ok, false);
  assert.equal(validarSaidaDaIa(PIX({ instituicao: "x".repeat(61) })).ok, false);
  const { pagador, instituicao, idTransacao, ...antigo } = PIX();
  const v = validarSaidaDaIa(antigo); // saída sem os campos novos (contrato anterior) continua válida
  assert.deepEqual([v.ok, v.saida.idTransacao, v.saida.pagador, v.saida.instituicao], [true, null, null, null]);
  void pagador; void instituicao; void idTransacao;
});
