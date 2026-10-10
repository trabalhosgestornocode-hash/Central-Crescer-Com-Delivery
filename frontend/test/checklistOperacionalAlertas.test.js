// Checklist Operacional — alerta PREVENTIVO (etapa em andamento) x resultado FINAL (etapa concluída).
//
// Regra: o amarelo "Próximo da meta" só existe enquanto o pedido ainda está na etapa. Etapa concluída é
// classificada pelo tempo efetivamente registrado: até a meta = "Dentro da meta"; depois = "Acima da meta".
// Exemplo (meta de preparo 12 min, aviso em 80%): em preparo há 10 min = amarelo; preparo CONCLUÍDO em 10 min = verde.
//
// Sem DOM e sem rede: funções puras do modelo + o HTML real dos cards.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classificar, classificarFinal, ROTULO_NIVEL, ROTULO_NIVEL_FINAL, METAS_EXEMPLO,
  derivarPedidoAtivo, derivarIndicador, estadoDoCard, derivarStatusOperacao, emAcompanhamento,
} from "../src/checklistOperacionalModelo.js";
import { cardTempo, cardStatus, painelUltimosPedidos, linhaPedidoAtivo, dialogoMetas } from "../src/checklistOperacionalVisual.js";

const AGORA = Date.parse("2026-10-10T17:30:00Z");
const ha = (min) => new Date(AGORA - min * 60000).toISOString();
const PREPARO = METAS_EXEMPLO.preparo;   // 12 min, aviso 80% (9,6 min)
const ENTREGA = METAS_EXEMPLO.entrega;   // 35 min, aviso 80% (28 min)
const VIDA = METAS_EXEMPLO.vida;         // 45 min, aviso 80% (36 min)

const indicador = (media, ultimo = media, amostras = 5) => ({
  disponivel: true, mediaDia: media, amostras, ultimo: ultimo == null ? null : { min: ultimo, displayId: "1000", em: ha(5) },
});
const semDados = { disponivel: true, mediaDia: null, amostras: 0, ultimo: null };
/** Resumo mínimo no contrato do backend. */
const resumo = ({ ativos = [], preparo = semDados, entrega = semDados, vida = semDados, ultimos = [], alertas = [], concluidos = 0 } = {}) => ({
  origem: "api", metas: METAS_EXEMPLO, indicadores: { preparo, entrega, vida }, pedidosAtivos: ativos, ultimosPedidos: ultimos,
  contagemDia: { concluidos, cancelados: 0 }, alertas,
});
/** Pedido em preparo há `min` minutos (recebido 1 min antes de ser confirmado). */
const emPreparo = (min, id = "p1") => ({ id, displayId: id.toUpperCase(), status: "CONFIRMED", recebidoEm: ha(min + 1), confirmadoEm: ha(min) });
/** Pedido que saiu para entrega há `min` minutos; o preparo terminou antes disso. */
const emEntrega = (min, { vidaMin = min + 12, id = "e1" } = {}) => ({
  id, displayId: id.toUpperCase(), status: "DISPATCHED", recebidoEm: ha(vidaMin), confirmadoEm: ha(vidaMin - 1), despachadoEm: ha(min),
});
const rotuloDoCard = (html) => html.match(/data-estado-rot>([^<]*)</)?.[1];
const nivelDoCard = (html) => html.match(/data-nivel="([a-z]+)"/)?.[1];

// ---------------------------------------------------------------------------
// As duas classificações
// ---------------------------------------------------------------------------
describe("duas classificações: preventiva e final", () => {
  test("preventiva (em andamento) continua com a faixa de aviso existente — nenhum percentual novo", () => {
    assert.deepEqual([classificar(9.5, PREPARO), classificar(9.6, PREPARO), classificar(12, PREPARO), classificar(12.01, PREPARO)], ["ok", "atencao", "atencao", "critico"]);
    assert.equal(classificar(10, { meta: 12, avisoPct: 90 }), "ok", "o aviso configurado pela unidade continua valendo");
    assert.deepEqual(METAS_EXEMPLO, { preparo: { meta: 12, avisoPct: 80 }, entrega: { meta: 35, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } });
  });

  test("final (concluída): só dentro ou acima da meta — a faixa de aviso não entra", () => {
    assert.equal(classificarFinal(5, PREPARO), "ok");
    assert.equal(classificarFinal(10, PREPARO), "ok", "10 de 12 min: dentro — não 'próximo'");
    assert.equal(classificarFinal(11.99, PREPARO), "ok");
    assert.equal(classificarFinal(12, PREPARO), "ok", "exatamente na meta ainda é dentro");
    assert.equal(classificarFinal(12.01, PREPARO), "critico");
    assert.equal(classificarFinal(13, PREPARO), "critico");
    for (const aviso of [50, 80, 99]) assert.equal(classificarFinal(10, { meta: 12, avisoPct: aviso }), "ok", `aviso ${aviso}% não muda o resultado final`);
    for (let v = 0; v <= 30; v += 0.25) assert.notEqual(classificarFinal(v, PREPARO), "atencao", `${v} min: resultado final nunca é amarelo`);
  });

  test("falta de dado não é resultado positivo, em nenhuma das duas", () => {
    for (const f of [classificar, classificarFinal]) {
      assert.equal(f(null, PREPARO), "neutro");
      assert.equal(f(undefined, PREPARO), "neutro");
      assert.equal(f(NaN, PREPARO), "neutro");
      assert.equal(f(10, null), "neutro");
      assert.equal(f(10, { meta: 0, avisoPct: 80 }), "neutro");
    }
  });

  test("vocabulário próprio de cada uma", () => {
    assert.deepEqual(ROTULO_NIVEL, { ok: "Dentro da meta", atencao: "Próximo da meta", critico: "Atrasado", neutro: "Sem medição" });
    assert.deepEqual(ROTULO_NIVEL_FINAL, { ok: "Dentro da meta", critico: "Acima da meta", neutro: "Sem medição" });
    assert.equal(ROTULO_NIVEL_FINAL.atencao, undefined, "não existe 'próximo da meta' para etapa concluída");
  });
});

// ---------------------------------------------------------------------------
// 1–3. Pedido em preparo (alerta preventivo)
// ---------------------------------------------------------------------------
describe("pedido em preparo", () => {
  test("1. distante da meta: verde — 'Dentro da meta'", () => {
    const r = resumo({ ativos: [emPreparo(5)] });
    const p = derivarPedidoAtivo(r.pedidosAtivos[0], r.metas, AGORA);
    assert.deepEqual([p.indicador, p.daEtapa.nivel, p.nivel], ["preparo", "ok", "ok"]);
    const html = cardTempo("preparo", r, AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["ok", "Dentro da meta"]);
    assert.match(html, /data-origem="agora"/);
  });

  test("2. aproximando-se da meta: amarelo — 'Próximo da meta'", () => {
    const r = resumo({ ativos: [emPreparo(10)] });
    const p = derivarPedidoAtivo(r.pedidosAtivos[0], r.metas, AGORA);
    assert.deepEqual([p.daEtapa.nivel, p.nivel], ["atencao", "atencao"]);
    const html = cardTempo("preparo", r, AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["atencao", "Próximo da meta"]);
    assert.match(linhaPedidoAtivo(p), /data-nivel="atencao"/);
  });

  test("3. ultrapassou a meta: vermelho — 'Atrasado'", () => {
    const r = resumo({ ativos: [emPreparo(13)] });
    const p = derivarPedidoAtivo(r.pedidosAtivos[0], r.metas, AGORA);
    assert.deepEqual([p.daEtapa.nivel, p.nivel], ["critico", "critico"]);
    const html = cardTempo("preparo", r, AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["critico", "Atrasado"]);
    assert.doesNotMatch(html, /Fora da meta|Acima da meta/, "em andamento é 'Atrasado', não o vocabulário de etapa concluída");
    assert.match(linhaPedidoAtivo(p), /cko-crono--critico/);
  });
});

// ---------------------------------------------------------------------------
// 4–6. Preparo concluído e passagem para a entrega
// ---------------------------------------------------------------------------
describe("preparo concluído", () => {
  test("4. estava amarelo e concluiu o preparo em 10 min: verde — 'Dentro da meta' (o amarelo não fica)", () => {
    // Antes: em preparo há 10 min -> amarelo.
    const antes = resumo({ ativos: [emPreparo(10)] });
    assert.equal(rotuloDoCard(cardTempo("preparo", antes, AGORA)), "Próximo da meta");
    // Depois: o pedido saiu para entrega; o preparo dele (10 min) é agora a última medição e a média.
    const depois = resumo({ ativos: [emEntrega(1, { vidaMin: 12 })], preparo: indicador(10, 10, 1) });
    const h = derivarIndicador(depois.indicadores.preparo, PREPARO);
    assert.deepEqual([h.ultimoNivel, h.mediaNivel], ["ok", "ok"]);
    const card = estadoDoCard("preparo", depois, AGORA);
    assert.deepEqual([card.vivo, card.origemNivel, card.nivel, card.rotulo], [null, "media", "ok", "Dentro da meta"]);
    const html = cardTempo("preparo", depois, AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["ok", "Dentro da meta"]);
    assert.doesNotMatch(html, /Próximo da meta|cko-nivel-txt--atencao|cko-nivel--atencao/, "nenhum amarelo no card de uma etapa concluída dentro da meta");
    assert.match(html, /cko-nivel-txt--ok" title="Dentro da meta">10,0 min/);
  });

  test("5. concluiu o preparo em 13 min: vermelho — 'Acima da meta'", () => {
    const r = resumo({ ativos: [emEntrega(1, { vidaMin: 15 })], preparo: indicador(13, 13, 1) });
    const card = estadoDoCard("preparo", r, AGORA);
    assert.deepEqual([card.nivel, card.rotulo, card.hoje.ultimoNivel], ["critico", "Acima da meta", "critico"]);
    const html = cardTempo("preparo", r, AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["critico", "Acima da meta"]);
    assert.match(html, /cko-nivel-txt--critico" title="Acima da meta">13,0 min/);
    assert.doesNotMatch(html, />Atrasado</, "'Atrasado' é só para quem ainda está em andamento");
  });

  test("6. passou para entrega: o preparo fica finalizado e o que passa a ser monitorado é a entrega", () => {
    const pedido = emEntrega(5, { vidaMin: 16 });
    const r = resumo({ ativos: [pedido], preparo: indicador(10, 10, 1) });
    const p = derivarPedidoAtivo(pedido, r.metas, AGORA);
    assert.deepEqual([p.indicador, p.daEtapa.meta, p.daEtapa.nivel], ["entrega", ENTREGA.meta, "ok"], "o contador da etapa é o da entrega, desde a saída");
    assert.ok(Math.abs(p.daEtapa.decorridoMin - 5) < 1e-9);
    assert.equal(emAcompanhamento("preparo", r, AGORA), null, "o pedido não é mais acompanhado no card de preparo");
    assert.equal(emAcompanhamento("entrega", r, AGORA).pedido.id, pedido.id);
    assert.deepEqual([rotuloDoCard(cardTempo("entrega", r, AGORA)), nivelDoCard(cardTempo("entrega", r, AGORA))], ["Dentro da meta", "ok"]);
    // A vida continua acompanhando o tempo total do pedido enquanto ele está em andamento.
    assert.ok(Math.abs(p.vida.decorridoMin - 16) < 1e-9);
    assert.equal(emAcompanhamento("vida", r, AGORA).pedido.id, pedido.id);
  });

  test("6. entrega em andamento também tem o seu alerta preventivo (próximo e atrasado)", () => {
    const proximo = resumo({ ativos: [emEntrega(30, { vidaMin: 33 })] });
    assert.deepEqual([rotuloDoCard(cardTempo("entrega", proximo, AGORA)), nivelDoCard(cardTempo("entrega", proximo, AGORA))], ["Próximo da meta", "atencao"]);
    const atrasado = resumo({ ativos: [emEntrega(36, { vidaMin: 40 })] });
    assert.deepEqual([rotuloDoCard(cardTempo("entrega", atrasado, AGORA)), nivelDoCard(cardTempo("entrega", atrasado, AGORA))], ["Atrasado", "critico"]);
  });

  test("tabela de últimos pedidos: tempos encerrados só em verde ou vermelho", () => {
    const r = resumo({ ultimos: [
      { id: "a", displayId: "0001", recebidoEm: ha(60), status: "CONCLUDED", preparoMin: 10, entregaMin: 30, vidaMin: 44 },   // todos entre 80% e 100% da meta
      { id: "b", displayId: "0002", recebidoEm: ha(70), status: "CONCLUDED", preparoMin: 13, entregaMin: 36, vidaMin: 50 },
      { id: "c", displayId: "0003", recebidoEm: ha(10), status: "DISPATCHED", preparoMin: 11.5, entregaMin: null, vidaMin: null },
    ] });
    const html = painelUltimosPedidos(r);
    assert.doesNotMatch(html, /cko-nivel-txt--atencao|Próximo da meta/, "nenhuma célula amarela em tempo encerrado");
    assert.equal((html.match(/cko-nivel-txt--ok" title="Dentro da meta"/g) ?? []).length, 4, "10 / 30 / 44 e o preparo 11,5 do pedido já despachado");
    assert.equal((html.match(/cko-nivel-txt--critico" title="Acima da meta"/g) ?? []).length, 3);
    assert.match(html, /em curso/, "etapa ainda em andamento não recebe resultado");
  });
});

// ---------------------------------------------------------------------------
// 7. Vida do pedido
// ---------------------------------------------------------------------------
describe("vida do pedido", () => {
  test("7. pedido concluído com vida total abaixo da meta: verde — mesmo na faixa de 80% a 100%", () => {
    for (const vidaMin of [20, 36, 40, 45]) {
      const r = resumo({ vida: indicador(vidaMin, vidaMin, 1), concluidos: 1 });
      const html = cardTempo("vida", r, AGORA);
      assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["ok", "Dentro da meta"], `${vidaMin} min`);
      assert.doesNotMatch(html, /cko-nivel-txt--atencao|Próximo da meta/);
    }
    const acima = cardTempo("vida", resumo({ vida: indicador(47, 47, 1) }), AGORA);
    assert.deepEqual([nivelDoCard(acima), rotuloDoCard(acima)], ["critico", "Acima da meta"]);
  });

  test("em andamento, a vida continua sendo um alerta preventivo do tempo total", () => {
    // Em preparo há 5 min (preparo verde), mas recebido há 40 min: a vida (45) está próxima.
    const pedido = { id: "v1", displayId: "V1", status: "CONFIRMED", recebidoEm: ha(40), confirmadoEm: ha(5) };
    const p = derivarPedidoAtivo(pedido, METAS_EXEMPLO, AGORA);
    assert.deepEqual([p.daEtapa.nivel, p.vida.nivel, p.nivel, p.governadoPelaVida], ["ok", "atencao", "atencao", true]);
    const r = resumo({ ativos: [pedido] });
    assert.deepEqual([rotuloDoCard(cardTempo("vida", r, AGORA)), rotuloDoCard(cardTempo("preparo", r, AGORA))], ["Próximo da meta", "Dentro da meta"]);
    const estourou = derivarPedidoAtivo({ ...pedido, recebidoEm: ha(46) }, METAS_EXEMPLO, AGORA);
    assert.deepEqual([estourou.vida.nivel, ROTULO_NIVEL[estourou.vida.nivel]], ["critico", "Atrasado"]);
  });

  test("sem medição: neutro — nunca verde", () => {
    const html = cardTempo("vida", resumo(), AGORA);
    assert.deepEqual([nivelDoCard(html), rotuloDoCard(html)], ["neutro", "Sem medição"]);
    const indisponivel = estadoDoCard("preparo", resumo({ preparo: { disponivel: false, motivo: "sem carimbos", mediaDia: null, ultimo: null, amostras: 0 } }), AGORA);
    assert.deepEqual([indisponivel.nivel, indisponivel.rotulo], ["neutro", "Sem medição"]);
  });
});

// ---------------------------------------------------------------------------
// 8–9. Status da operação
// ---------------------------------------------------------------------------
describe("status da operação", () => {
  test("8. sem pedidos ativos e médias concluídas dentro da meta: verde, sem 'próximo da meta'", () => {
    // Médias todas entre 80% e 100% da meta — antes isto deixava o status amarelo.
    const r = resumo({ preparo: indicador(10), entrega: indicador(30), vida: indicador(44), concluidos: 5 });
    const s = derivarStatusOperacao(r, AGORA);
    assert.deepEqual([s.nivel, s.rotulo, s.nivelMedias, s.nivelAtivos, s.proximos, s.fora], ["ok", "Dentro da meta", "ok", "neutro", 0, 0]);
    assert.deepEqual(s.motivos, []);
    assert.deepEqual(s.medias.map(([, n]) => n), ["ok", "ok", "ok"]);
    const html = cardStatus(r, AGORA);
    assert.match(html, /data-nivel="ok"/);
    assert.match(html, /cko-status-veredito">Dentro da meta</);
    assert.doesNotMatch(html, /Próximo da meta|próxim|cko-nivel-txt--atencao/i);
    assert.match(html, /Pedidos e médias do dia dentro das metas da unidade/);
  });

  test("9. um pedido em alerta preventivo: amarelo por causa DELE — as médias concluídas seguem verdes", () => {
    const r = resumo({ ativos: [emPreparo(10)], preparo: indicador(10), entrega: indicador(30), vida: indicador(44), concluidos: 5 });
    const s = derivarStatusOperacao(r, AGORA);
    assert.deepEqual([s.nivel, s.rotulo, s.nivelAtivos, s.nivelMedias, s.proximos], ["atencao", "Próximo da meta", "atencao", "ok", 1]);
    assert.deepEqual(s.motivos, ["1 pedido em andamento próximo da meta"]);
    const html = cardStatus(r, AGORA);
    assert.match(html, /cko-status-veredito">Próximo da meta</);
    assert.match(html, /1 pedido em andamento próximo da meta/);
    assert.equal((html.match(/<span>Dentro da meta<\/span>/g) ?? []).length, 3, "as três médias aparecem como 'Dentro da meta'");
  });

  test("pedido atrasado x média acima da meta: motivos diferentes, escritos", () => {
    const atrasado = derivarStatusOperacao(resumo({ ativos: [emPreparo(13)], preparo: indicador(10) }), AGORA);
    assert.deepEqual([atrasado.nivel, atrasado.rotulo, atrasado.nivelAtivos, atrasado.nivelMedias, atrasado.fora], ["critico", "Fora da meta", "critico", "ok", 1]);
    assert.deepEqual(atrasado.motivos, ["1 pedido em andamento atrasado"]);

    const media = derivarStatusOperacao(resumo({ preparo: indicador(13), entrega: indicador(30), vida: indicador(40) }), AGORA);
    assert.deepEqual([media.nivel, media.rotulo, media.nivelAtivos, media.nivelMedias], ["critico", "Fora da meta", "neutro", "critico"]);
    assert.deepEqual(media.motivos, ["Preparo: média do dia acima da meta"]);
    const html = cardStatus(resumo({ preparo: indicador(13), entrega: indicador(30), vida: indicador(40) }), AGORA);
    assert.match(html, /<span>Acima da meta<\/span>/);
    assert.match(html, /<dt>Atrasados agora<\/dt><dd>0<\/dd>/, "média acima da meta não conta como pedido atrasado");

    const plural = derivarStatusOperacao(resumo({ ativos: [emPreparo(13, "a"), emPreparo(14, "b"), emPreparo(10, "c"), emPreparo(11, "d")] }), AGORA);
    assert.deepEqual(plural.motivos, ["2 pedidos em andamento atrasados", "2 pedidos em andamento próximos da meta"]);
  });

  test("amarelo vindo de aviso do servidor (não de pedido) é 'Atenção', não 'Próximo da meta'", () => {
    const r = resumo({ preparo: indicador(8), alertas: [{ codigo: "detalhes_ausentes", nivel: "atencao", texto: "1 pedido sem detalhes" }] });
    const s = derivarStatusOperacao(r, AGORA);
    assert.deepEqual([s.nivel, s.rotulo, s.proximos], ["atencao", "Atenção", 0]);
    assert.deepEqual(s.motivos, ["1 pedido sem detalhes"]);
  });

  test("sem medições e sem pedidos: neutro — falta de dado não vira 'dentro da meta'", () => {
    const s = derivarStatusOperacao(resumo(), AGORA);
    assert.deepEqual([s.nivel, s.rotulo, s.nivelMedias, s.nivelAtivos], ["neutro", "Sem medições hoje", "neutro", "neutro"]);
  });
});

// ---------------------------------------------------------------------------
// 10. Mudanças de estado vindas do iFood
// ---------------------------------------------------------------------------
describe("10. mudanças de estado recebidas do iFood", () => {
  test("o mesmo pedido, de recebido a concluído: cada etapa com a classificação certa", () => {
    const base = { id: "x", displayId: "7756" };
    // PLACED: ainda sem etapa própria — acompanha a vida.
    let p = derivarPedidoAtivo({ ...base, status: "PLACED", recebidoEm: ha(1) }, METAS_EXEMPLO, AGORA);
    assert.deepEqual([p.indicador, p.nivel], ["vida", "ok"]);
    // CONFIRMED há 10 min: preparo em andamento, alerta preventivo.
    p = derivarPedidoAtivo({ ...base, status: "CONFIRMED", recebidoEm: ha(11), confirmadoEm: ha(10) }, METAS_EXEMPLO, AGORA);
    assert.deepEqual([p.indicador, p.daEtapa.nivel, ROTULO_NIVEL[p.daEtapa.nivel]], ["preparo", "atencao", "Próximo da meta"]);
    // READY_TO_PICKUP: espera do entregador não tem meta própria — volta a ser a vida.
    p = derivarPedidoAtivo({ ...base, status: "READY_TO_PICKUP", recebidoEm: ha(13), confirmadoEm: ha(12) }, METAS_EXEMPLO, AGORA);
    assert.deepEqual([p.indicador, p.nivel], ["vida", "ok"]);
    // DISPATCHED há 2 min: entrega em andamento; o preparo (11 min) virou resultado final verde.
    const despachado = { ...base, status: "DISPATCHED", recebidoEm: ha(14), confirmadoEm: ha(13), despachadoEm: ha(2) };
    p = derivarPedidoAtivo(despachado, METAS_EXEMPLO, AGORA);
    assert.deepEqual([p.indicador, p.daEtapa.nivel], ["entrega", "ok"]);
    const r = resumo({ ativos: [despachado], preparo: indicador(11, 11, 1) });
    assert.deepEqual([rotuloDoCard(cardTempo("preparo", r, AGORA)), rotuloDoCard(cardTempo("entrega", r, AGORA))], ["Dentro da meta", "Dentro da meta"]);
    // CONCLUDED: sai dos pedidos ativos; tudo vira resultado final.
    const fim = resumo({ preparo: indicador(11, 11, 1), entrega: indicador(30, 30, 1), vida: indicador(44, 44, 1), concluidos: 1 });
    for (const c of ["preparo", "entrega", "vida"]) assert.deepEqual([nivelDoCard(cardTempo(c, fim, AGORA)), rotuloDoCard(cardTempo(c, fim, AGORA))], ["ok", "Dentro da meta"], c);
    assert.equal(derivarStatusOperacao(fim, AGORA).rotulo, "Dentro da meta");
  });

  test("retirada (sem entrega): preparo concluído é classificado pelo final; não ganha alerta de entrega", () => {
    const pronto = { id: "t", displayId: "1034", status: "READY_TO_PICKUP", recebidoEm: ha(12), confirmadoEm: ha(11) };
    const r = resumo({ ativos: [pronto], preparo: indicador(10, 10, 1) });
    assert.equal(emAcompanhamento("entrega", r, AGORA), null);
    assert.equal(emAcompanhamento("preparo", r, AGORA), null);
    assert.equal(rotuloDoCard(cardTempo("preparo", r, AGORA)), "Dentro da meta");
  });
});

// ---------------------------------------------------------------------------
// Coerência geral e o que NÃO mudou
// ---------------------------------------------------------------------------
describe("coerência", () => {
  test("card, cor e rótulo sempre combinam (varredura de tempos em andamento e concluídos)", () => {
    const esperadoVivo = { ok: "Dentro da meta", atencao: "Próximo da meta", critico: "Atrasado" };
    const esperadoFinal = { ok: "Dentro da meta", critico: "Acima da meta" };
    for (let min = 1; min <= 16; min += 0.5) {
      const vivo = cardTempo("preparo", resumo({ ativos: [emPreparo(min)] }), AGORA);
      assert.equal(rotuloDoCard(vivo), esperadoVivo[nivelDoCard(vivo)], `em andamento ${min}`);
      const final = cardTempo("preparo", resumo({ preparo: indicador(min) }), AGORA);
      assert.equal(rotuloDoCard(final), esperadoFinal[nivelDoCard(final)], `concluído ${min}`);
      assert.notEqual(nivelDoCard(final), "atencao", `concluído ${min}: nunca amarelo`);
    }
  });

  test("o texto das metas explica as duas regras; os percentuais e os campos são os mesmos", () => {
    const html = dialogoMetas(METAS_EXEMPLO);
    assert.match(html, /Pedido em andamento: abaixo do aviso, dentro da meta; do aviso até a meta, próximo da meta; depois da meta, atrasado\./);
    assert.match(html, /Etapa concluída: dentro da meta até a meta, acima da meta depois dela\./);
    assert.match(html, /Próximo da meta a partir de/);
  });
});

// ---------------------------------------------------------------------------
// Ícone do Checklist — emblema circular da Crescer com Delivery
// ---------------------------------------------------------------------------
describe("ícone do Checklist Operacional", async () => {
  const { readFileSync, existsSync, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const caminho = (rel) => fileURLToPath(new URL(rel, import.meta.url));
  const ICONE = "/assets/menu-checklist-operacional.png";

  test("o arquivo existe, é PNG com transparência (recorte circular) e é leve", () => {
    const arq = caminho("../assets/menu-checklist-operacional.png");
    assert.ok(existsSync(arq));
    const b = readFileSync(arq);
    assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "assinatura PNG");
    assert.equal(b.readUInt32BE(16), b.readUInt32BE(20), "quadrado");
    assert.equal(b[25], 6, "RGBA: fundo transparente fora do círculo");
    assert.ok(statSync(arq).size < 60_000, "ícone de menu, não a arte original");
  });

  test("menu, cabeçalho da tela e seleção de modo usam o mesmo ícone; o SVG antigo saiu", async () => {
    const { MENU } = await import("../src/config.js");
    assert.equal(MENU.find((m) => m.id === "checklist-operacional").logo, ICONE);
    const visual = readFileSync(caminho("../src/checklistOperacionalVisual.js"), "utf8");
    assert.equal((visual.match(/src="\/assets\/menu-checklist-operacional\.png"/g) ?? []).length, 2);
    for (const f of ["../src/config.js", "../src/checklistOperacionalVisual.js"]) assert.doesNotMatch(readFileSync(caminho(f), "utf8"), /menu-checklist-operacional\.svg/);
    assert.equal(existsSync(caminho("../assets/menu-checklist-operacional.svg")), false);
  });
});
