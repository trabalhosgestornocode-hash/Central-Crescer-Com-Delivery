// MOVA (29/11/2026): limites sob falha recorrente e abuso — respostas interativas e mensagens de erro NÃO têm teto diário, mas nunca saem
// sem limite: ritmo por conversa (minuto), ritmo geral e teto de respostas por conversa/hora; as proativas mantêm 2.000/dia, 100/privado, 500/grupo.
// Simulação pura da decisão de envio (sem banco, sem relógio real): cada item decidido ENVIAR aumenta o uso do minuto/hora/dia.
import assert from "node:assert/strict";
import { CATEGORIA, LIMITES_PADRAO, PRIORIDADE, decidirEnvio } from "../../src/modules/mova-financeiro/dominio/politicaEnvio.js";
import { t } from "./helpers/operacao.js";

/** Joga `n` itens de uma conversa ao longo de `minutos`, `porMinuto` por vez; devolve quantos saíram por minuto e no total. */
function simular({ categoria, n, porMinuto, minutos, destinoTipo = "PRIVADO", prioridade = PRIORIDADE.CRITICA }) {
  const limites = LIMITES_PADRAO;
  let fila = n, enviadasHora = 0, enviadasDia = 0, maxMinuto = 0;
  const t0 = Date.parse("2026-11-30T12:00:00Z");
  for (let m = 0; m < minutos && fila > 0; m += 1) {
    let noMinuto = 0;
    for (let k = 0; k < porMinuto && fila > 0; k += 1) {
      const d = decidirEnvio({ item: { categoria, prioridade, destinoTipo }, limites, agora: new Date(t0 + m * 60_000),
        uso: { ultimoMinuto: noMinuto, ultimoMinutoDestino: noMinuto, respostasHoraDestino: enviadasHora, dia: enviadasDia, porDestino: enviadasDia } });
      if (d.acao === "ENVIAR") { noMinuto += 1; enviadasHora += 1; enviadasDia += d.contada ? 1 : 0; fila -= 1; }
      else break; // adiado: volta a tentar no próximo minuto (a fila real reprograma)
    }
    maxMinuto = Math.max(maxMinuto, noMinuto);
  }
  return { enviadas: n - fila, restantes: fila, maxMinuto, enviadasHora };
}

t("LA-1 erro recorrente (Financeiro fora): 500 respostas de erro seguidas a UMA conversa saem no máximo no ritmo por minuto e 120 por hora; o resto fica adiado, nunca descartado", () => {
  const r = simular({ categoria: CATEGORIA.ERRO, n: 500, porMinuto: 500, minutos: 60 });
  assert.ok(r.maxMinuto <= LIMITES_PADRAO.porMinutoPorConversa, `ritmo por conversa: ${r.maxMinuto}`);
  assert.ok(r.enviadas <= LIMITES_PADRAO.respostasPorConversaPorHora + 0, `teto por hora: ${r.enviadas}`);
  assert.equal(r.enviadas + r.restantes, 500, "nada se perde: o que não saiu continua na fila");
  assert.ok(r.restantes > 0);
});

t("LA-2 respostas interativas (abuso de quem pergunta): mesmo limite por hora, sem teto diário de quantidade", () => {
  const r = simular({ categoria: CATEGORIA.RESPOSTA, n: 300, porMinuto: 300, minutos: 60 });
  assert.ok(r.enviadas <= 120 && r.maxMinuto <= 6, JSON.stringify(r));
});

t("LA-3 proativas: 100 por conversa privada/dia e 500 por grupo/dia seguem valendo, com reserva para a crítica", () => {
  const priv = simular({ categoria: CATEGORIA.PROATIVA, n: 400, porMinuto: 6, minutos: 600, destinoTipo: "PRIVADO", prioridade: PRIORIDADE.NORMAL });
  assert.ok(priv.enviadas <= 100, `privado: ${priv.enviadas}`);
  const grupo = simular({ categoria: CATEGORIA.ADMINISTRATIVA, n: 900, porMinuto: 6, minutos: 1200, destinoTipo: "GRUPO", prioridade: PRIORIDADE.NORMAL });
  assert.ok(grupo.enviadas <= 500, `grupo: ${grupo.enviadas}`);
  assert.equal(LIMITES_PADRAO.proativasDia, 2000);
  assert.equal(LIMITES_PADRAO.proativasPorPrivadoDia, 100);
  assert.equal(LIMITES_PADRAO.proativasPorGrupoDia, 500);
});

t("LA-4 mensagem crítica (pagamento) tem reserva: com o teto do dia cheio de normais, a crítica ainda é decidida ENVIAR", () => {
  const d = decidirEnvio({ item: { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA, destinoTipo: "PRIVADO" }, limites: LIMITES_PADRAO, agora: new Date("2026-11-30T12:00:00Z"),
    uso: { ultimoMinuto: 0, ultimoMinutoDestino: 0, dia: Math.floor(LIMITES_PADRAO.proativasDia * 0.9), porDestino: 0 } });
  assert.equal(d.acao, "ENVIAR");
  const n = decidirEnvio({ item: { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.NORMAL, destinoTipo: "PRIVADO" }, limites: LIMITES_PADRAO, agora: new Date("2026-11-30T12:00:00Z"),
    uso: { ultimoMinuto: 0, ultimoMinutoDestino: 0, dia: Math.floor(LIMITES_PADRAO.proativasDia * 0.9), porDestino: 0 } });
  assert.equal(n.acao, "ADIAR");
});
