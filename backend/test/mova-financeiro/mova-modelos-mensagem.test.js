// MOVA (28/11/2026): modelos obrigatórios das mensagens ao entregador (nota conferida e pagamento) — texto exato, sem afirmar validação fiscal oficial.
import assert from "node:assert/strict";
import { t } from "./helpers/operacao.js";
import { mensagemNotaConferida } from "../../src/modules/mova-financeiro/dominio/entregadores.js";
import { mensagemDePagamento } from "../../src/modules/mova-financeiro/dominio/notificacaoPagamento.js";

const F = { entregador: { chave: "m", nome: "Mauricio Sintetico" }, semanaInicio: "2026-11-23", semanaFim: "2026-11-29", entregas: 14, valorCentavos: 38950, vencimento: "2026-12-03" };

t("MM-1 nota recebida, conferida e anexada: modelo do proprietário, com previsão quando existe e sem afirmar validação fiscal oficial", () => {
  assert.equal(mensagemNotaConferida(F, { empresa: "Açaí no Grau Saci" }), [
    "Olá, Mauricio! 👋", "✅ Sua nota fiscal foi recebida e conferida com sucesso!", "🏢 Empresa: Açaí no Grau Saci", "📅 Período: 23/11/2026 a 29/11/2026",
    "🛵 Quantidade de entregas: 14", "💰 Valor: R$ 389,50", "📄 Nota fiscal: Conferida e anexada", "🗓️ Previsão de pagamento: 03/12/2026",
    "As informações estão de acordo com o fechamento. Agora, basta aguardar o pagamento.", "Assim que ele for registrado, você receberá uma notificação por aqui.", "MOVA | Crescer com Delivery"].join("\n"));
  const sem = mensagemNotaConferida({ ...F, vencimento: null }, { empresa: "Subway Saci" });
  assert.ok(!sem.includes("Previsão de pagamento"), "sem data real, sem previsão inventada");
  assert.ok(!/aut[eê]ntic|validad[ao] (fiscal|oficial)|SEFAZ|prefeitura/i.test(sem), "não afirma autenticidade fiscal oficial");
});

t("MM-2 pagamento realizado: modelo do proprietário (com 'dedicação'); parcial informa pago e saldo", () => {
  const dados = { periodos: [{ semanaInicio: "2026-11-23", semanaFim: "2026-11-29", entregas: 14, valorCentavos: 38950 }], entregas: 14, totalCentavos: 38950, saldoRestanteCentavos: 0, dataEfetiva: "2026-12-03", entregador: { nome: "Mauricio" } };
  const m = mensagemDePagamento(dados, { empresa: "Subway Saci" });
  assert.match(m, /Agradecemos pela parceria, dedicação e pelo trabalho realizado durante a semana!/);
  assert.match(m, /🏢 Empresa: Subway Saci/);
  const p = mensagemDePagamento({ ...dados, totalCentavos: 20000, saldoRestanteCentavos: 18950 }, { empresa: "Subway Saci" });
  assert.match(p, /Valor pago agora: R\$ 200,00/); assert.match(p, /Saldo restante: R\$ 189,50/);
});
