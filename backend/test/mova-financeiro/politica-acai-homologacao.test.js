// F4 (MOVA CORE §13) — POLÍTICA DE R$ 1.000,00 DA UNIDADE AÇAÍ, PREPARADA E TESTADA SÓ NA HOMOLOGAÇÃO ISOLADA.
// NÃO é criada nem habilitada em produção nesta execução: este teste grava a política no PostgreSQL ISOLADO de teste (banco
// descartável fv2_teste_mova_*) e confere a decisão de autonomia exatamente como o MOVA a tomaria. A unidade "Açaí" aqui é uma
// unidade SINTÉTICA (o identificador real só entra no dia da ativação, por quem aprovar).
// Proposta (aguardando aprovação do proprietário): compra/despesa já paga por comprovante Pix CONCLUÍDO, até R$ 1.000,00 por
// pagamento, com CONFIRMAÇÃO de uma pessoa autorizada antes de gravar; acima disso, só proposta; sem política, só proposta.
import assert from "node:assert/strict";
import { ALFA, BETA, ORG, cenario, t } from "./helpers/operacao.js";
import { NIVEL, decidirAutonomia, validarPolitica } from "../../src/modules/mova-financeiro/dominio/autonomia.js";

const ACAI = ALFA; // unidade sintética no papel da Açaí
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
export const POLITICA_ACAI_PROPOSTA = Object.freeze({
  operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ACAI, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 100000,
  responsavel: "Proprietário (a confirmar)", motivo: "Açaí: despesa já paga por comprovante Pix concluído até R$ 1.000,00, com confirmação antes de gravar (homologação)", vigenteDe: "2026-11-01",
});
// formato de avaliarComprovante(): concluído, legível, consistente, não duplicado, com ID da transação
const PIX_OK = Object.freeze({ situacao: "PIX_CONCLUIDO", apto: true, comIdentificador: true, motivos: [] });

t("PA-1 política da Açaí de R$ 1.000 no banco ISOLADO: até o limite pede confirmação; acima só propõe; outra unidade sem política só propõe", async () => {
  const s = await cenario({ responder: () => ({}) });
  assert.doesNotThrow(() => validarPolitica(POLITICA_ACAI_PROPOSTA));
  const id = await s.mova.armazenamento.politicas.criar(POLITICA_ACAI_PROPOSTA, { criadaPor: HUMANO });
  const politicas = await s.mova.armazenamento.politicas.listar(ORG);
  assert.equal(politicas.length, 1);
  const decidir = (valorCentavos, unidadeId = ACAI, extra = {}) => decidirAutonomia({ politicas, operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId, valorCentavos, hoje: "2026-11-24", comprovante: PIX_OK, ...extra });
  assert.equal(decidir(100000).nivel, NIVEL.APLICAR_COM_CONFIRMACAO, "R$ 1.000,00 exatos: dentro do limite");
  const acima = decidir(100001);
  assert.deepEqual([acima.nivel, acima.motivos.includes("ACIMA_DO_LIMITE")], [NIVEL.SOMENTE_PROPOR, true], "R$ 1.000,01: cai um nível");
  assert.deepEqual([decidir(5000, BETA).nivel, decidir(5000, BETA).motivos], [NIVEL.SOMENTE_PROPOR, ["SEM_POLITICA"]], "a política é da Açaí, não da empresa");
  assert.equal(decidirAutonomia({ politicas, operacao: "PAGAMENTO_BANCARIO", organizacaoId: ORG, unidadeId: ACAI, valorCentavos: 100, hoje: "2026-11-24" }).nivel, NIVEL.PROIBIDO, "pagar nunca");
  assert.equal(decidir(5000, ACAI, { hoje: "2026-10-31" }).nivel, NIVEL.SOMENTE_PROPOR, "antes da vigência");
  // Desligar = revogar, vale na hora e o histórico fica.
  assert.equal(await s.mova.armazenamento.politicas.revogar({ id, organizacaoId: ORG, por: HUMANO }), true);
  const depois = await s.mova.armazenamento.politicas.listar(ORG);
  assert.equal(decidirAutonomia({ politicas: depois, operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ACAI, valorCentavos: 5000, hoje: "2026-11-24", comprovante: PIX_OK }).nivel, NIVEL.SOMENTE_PROPOR);
  assert.ok(depois[0].revogadaEm, "revogada, não apagada");
});

t("PA-2 a política nunca afrouxa as regras fixas: comprovante não concluído ou sem ID da transação não aplica sozinho", async () => {
  const politicas = [{ ...POLITICA_ACAI_PROPOSTA, id: "p", revogadaEm: null, vigenteAte: null, nivel: "APLICAR_AUTOMATICO" }];
  const d = (comprovante) => decidirAutonomia({ politicas, operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ACAI, valorCentavos: 5000, hoje: "2026-11-24", comprovante }).nivel;
  assert.equal(d({ situacao: "PIX_AGENDADO", apto: false, comIdentificador: true, motivos: ["NAO_CONCLUIDO"] }), NIVEL.SOMENTE_PROPOR);
  assert.equal(d({ situacao: "PIX_CONCLUIDO", apto: true, comIdentificador: false, motivos: [] }), NIVEL.APLICAR_COM_CONFIRMACAO, "sem ID da transação: no máximo com confirmação");
  assert.equal(d(PIX_OK), NIVEL.APLICAR_AUTOMATICO, "a regra fixa só desce, nunca sobe além da política");
});
