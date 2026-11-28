// 27/11 — quadro "Notificações de pagamento" (Informações dos entregadores): estados, reenvio só para quem configura, sem telefone/texto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quadroNotificacoes, abaInformacoes } from "../financeiro-v2/telasEntregadores.js";

const dados = {
  ligado: true, desde: "2026-10-28",
  indicadores: { total: 2, porEstado: { FALHOU: 1, ENVIADO: 1 }, falhas: 1, entregadoresNotificados: 1 },
  atendimentoResumo: { respostas: 5, deterministicas: 4, ia: 1, bloqueadas: 1, tokens: 120 },
  itens: [
    { id: "11111111-1111-4111-8111-111111111111", entregador: "mauricio", destino: "ENTREGADOR", tipo: "PAGAMENTO", estado: "FALHOU", erro: "GATEWAY_RECUSOU", reenvios: 0, criadoEm: "2026-11-18T15:00:00.000Z", enviadoEm: null, valorCentavos: 1500, podeReenviar: true },
    { id: "22222222-2222-4222-8222-222222222222", entregador: "rafael", destino: "ENTREGADOR", tipo: "PAGAMENTO_PARCIAL", estado: "ENVIADO", reenvios: 1, criadoEm: "2026-11-18T16:00:00.000Z", enviadoEm: "2026-11-18T16:01:00.000Z", valorCentavos: 400, podeReenviar: false },
  ],
};

test("NP1 quadro mostra indicadores, estados em português e reenvio só quando pode e há permissão", () => {
  const html = quadroNotificacoes(dados, { permissoes: ["financeiro_v2.ver", "financeiro_v2.configurar"] });
  assert.match(html, /Notificações de pagamento/);
  assert.match(html, /Falhou/);
  assert.match(html, /Pagamento parcial/);
  assert.match(html, /5<\/strong> respostas no privado \(4 sem IA, 1 com IA, 1 recusadas\)/);
  assert.equal((html.match(/data-acao-mova="\/api\/fv2\/acoes\/mova\/notificacao-reenviar"/g) ?? []).length, 1, "só a que falhou");
  assert.doesNotMatch(quadroNotificacoes(dados, { permissoes: ["financeiro_v2.ver"] }), /notificacao-reenviar/, "sem configurar não há botão");
  assert.doesNotMatch(html, /\+55|WhatsApp:\s*\d/);
});

test("NP2 sem dados não quebra; desligado explica; aba Informações inclui o quadro", () => {
  assert.equal(quadroNotificacoes(null), "");
  assert.match(quadroNotificacoes({ ligado: false }), /ainda não estão ativas/);
  assert.match(abaInformacoes({ dados: { cadastros: [], itens: [], notas: [], envios: [], unidadeAtendida: true }, oficiais: null, notificacoes: dados }, { permissoes: ["financeiro_v2.ver"] }), /Notificações de pagamento/);
});
