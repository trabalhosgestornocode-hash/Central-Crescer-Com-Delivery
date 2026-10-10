// Checklist Operacional — modelo (estados proporcionais à meta, ritmo do pulso,
// contadores vivos x tempos encerrados), componentes visuais (HTML gerado) e
// encaixe no menu/rota. Sem DOM: os componentes são funções puras.
//
// Rodar: node --test frontend/test/checklistOperacional.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  METAS_EXEMPLO, ROTULO_NIVEL, PERIODO_MINIMO_S, classificar, razaoMeta, ritmoPulso, piorNivel, minutosDesde,
  fmtMin, fmtDiferenca, fmtCronometro, fmtRestante, fmtIdade, etapaDoStatus, indicadorDaEtapa,
  derivarIndicador, derivarDecomposicao, derivarPedidoAtivo, ordenarPorUrgencia, emAcompanhamento, estadoDoCard,
  derivarStatusOperacao, derivarAvaliacoes, classificarSatisfacao, CRITERIOS_AVALIACAO, validarMetas, SELO_CONEXAO,
} from "../src/checklistOperacionalModelo.js";
import { amostraDemonstracao } from "../src/checklistOperacionalAmostra.js";
import {
  montarTela, cardTempo, cardStatus, painelPedidosAtivos, painelUltimosPedidos, painelAvaliacoes,
  cabecalho, dialogoMetas, telaSemUnidade, linhaPedidoAtivo,
} from "../src/checklistOperacionalVisual.js";
import { MENU } from "../src/config.js";

const AGORA = Date.parse("2026-10-06T22:00:00Z");
const ha = (min) => new Date(AGORA - min * 60000).toISOString();
const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PREPARO = { meta: 12, avisoPct: 80 };

describe("estados proporcionais à meta (tempo: menor é melhor)", () => {
  test("abaixo de 80% dentro; de 80% até a meta próximo; acima da meta fora", () => {
    assert.equal(classificar(9.5, PREPARO), "ok");        // 79%
    assert.equal(classificar(9.6, PREPARO), "atencao");   // 80%
    assert.equal(classificar(12, PREPARO), "atencao");    // 100%: limite atingido, ainda não fora
    assert.equal(classificar(12.01, PREPARO), "critico");
  });
  test("o aviso é configurável por indicador", () => {
    assert.equal(classificar(10, { meta: 12, avisoPct: 90 }), "ok");
    assert.equal(classificar(10, { meta: 12, avisoPct: 75 }), "atencao");
  });
  test("sem valor ou sem meta não vira classificação inventada", () => {
    assert.equal(classificar(null, PREPARO), "neutro");
    assert.equal(classificar(10, null), "neutro");
    assert.equal(razaoMeta(10, { meta: 0 }), null);
  });
  test("rótulos escritos — nunca só cor", () => {
    // Vocabulário da etapa EM ANDAMENTO (o de etapa concluída está em checklistOperacionalAlertas.test.js).
    assert.deepEqual([ROTULO_NIVEL.ok, ROTULO_NIVEL.atencao, ROTULO_NIVEL.critico], ["Dentro da meta", "Próximo da meta", "Atrasado"]);
  });
  test("piorNivel escolhe o mais grave", () => {
    assert.equal(piorNivel("ok", "neutro", "atencao"), "atencao");
    assert.equal(piorNivel("ok", "critico", "atencao"), "critico");
  });
});

describe("ritmo do pulso (urgência progressiva)", () => {
  test("verde lento e fraco, acelerando até o aviso", () => {
    const longe = ritmoPulso(0.1);
    const perto = ritmoPulso(0.79);
    assert.ok(longe.periodoS >= 5.5 && longe.intensidade <= 0.2);
    assert.ok(perto.periodoS < longe.periodoS && perto.intensidade > longe.intensidade);
  });
  test("amarelo mais rápido que qualquer verde e acelerando até a meta", () => {
    const entrada = ritmoPulso(0.8);
    const limite = ritmoPulso(1);
    assert.ok(entrada.periodoS < ritmoPulso(0.79).periodoS);
    assert.ok(limite.periodoS < entrada.periodoS && limite.intensidade > entrada.intensidade);
  });
  test("nunca abaixo do período mínimo seguro, em toda a faixa", () => {
    for (let r = 0; r <= 1; r += 0.01) assert.ok(ritmoPulso(r).periodoS >= PERIODO_MINIMO_S);
  });
  test("período nunca aumenta conforme a razão cresce (urgência só sobe)", () => {
    let anterior = Infinity;
    for (let r = 0; r <= 1; r += 0.02) { const p = ritmoPulso(r).periodoS; assert.ok(p <= anterior + 1e-9); anterior = p; }
  });
  test("fora da meta e sem medição: estável, sem pulsar", () => {
    assert.equal(ritmoPulso(1.01), null);
    assert.equal(ritmoPulso(null), null);
  });
  test("respeita aviso configurado", () => {
    assert.ok(ritmoPulso(0.85, 90).periodoS > ritmoPulso(0.85, 80).periodoS); // com aviso 90%, 85% ainda é verde
  });
});

describe("formatação", () => {
  test("minutos, diferença, cronômetro e restante", () => {
    assert.equal(fmtMin(12.44), "12,4");
    assert.equal(fmtDiferenca(11.8, 12), "−0,2 min");
    assert.equal(fmtCronometro(7.7), "07:42");
    assert.equal(fmtCronometro(65.2), "1h05");
    assert.deepEqual(fmtRestante(8.7, 12), { texto: "faltam 03:18", excedido: false });
    assert.deepEqual(fmtRestante(12.9, 12), { texto: "passou 00:54", excedido: true });
    assert.equal(fmtRestante(12, 12).texto, "na meta");
    assert.equal(fmtIdade(new Date(AGORA - 12000).toISOString(), AGORA), "há 12 s");
  });
  test("minutosDesde: inválido é null, futuro é zero", () => {
    assert.equal(minutosDesde("x", AGORA), null);
    assert.equal(minutosDesde(new Date(AGORA + 60000).toISOString(), AGORA), 0);
  });
});

describe("contadores vivos por etapa", () => {
  test("cada etapa acompanha sua própria meta, a partir do carimbo oficial", () => {
    assert.deepEqual(indicadorDaEtapa({ status: "SEPARATION_STARTED", confirmadoEm: "c", recebidoEm: "r" }), { chave: "preparo", desde: "c" });
    assert.deepEqual(indicadorDaEtapa({ status: "DISPATCHED", despachadoEm: "d", recebidoEm: "r" }), { chave: "entrega", desde: "d" });
    assert.deepEqual(indicadorDaEtapa({ status: "PLACED", recebidoEm: "r" }), { chave: "vida", desde: "r" });
    assert.deepEqual(indicadorDaEtapa({ status: "READY_TO_PICKUP", confirmadoEm: "c", recebidoEm: "r" }), { chave: "vida", desde: "r" });
    // sem o carimbo, nunca inventa o início da etapa: cai para a vida
    assert.deepEqual(indicadorDaEtapa({ status: "CONFIRMED", recebidoEm: "r" }), { chave: "vida", desde: "r" });
  });
  test("pedido assume o pior entre a etapa e a vida, e avisa quando é pela vida", () => {
    const p = derivarPedidoAtivo({ id: "a", displayId: "1", recebidoEm: ha(40), status: "DISPATCHED", despachadoEm: ha(10) }, METAS_EXEMPLO, AGORA);
    assert.equal(p.indicador, "entrega");
    assert.equal(p.daEtapa.nivel, "ok");      // 10/35
    assert.equal(p.vida.nivel, "atencao");    // 40/45
    assert.equal(p.nivel, "atencao");
    assert.equal(p.governadoPelaVida, true);
    assert.equal(p.daEtapa.cronometro, "10:00");
  });
  test("fora da meta não pulsa; dentro pulsa no ritmo da razão", () => {
    const fora = derivarPedidoAtivo({ id: "b", recebidoEm: ha(13), status: "CONFIRMED", confirmadoEm: ha(12.5) }, METAS_EXEMPLO, AGORA);
    assert.equal(fora.nivel, "critico");
    assert.equal(fora.pulso, null);
    const dentro = derivarPedidoAtivo({ id: "c", recebidoEm: ha(5), status: "CONFIRMED", confirmadoEm: ha(4) }, METAS_EXEMPLO, AGORA);
    assert.deepEqual(dentro.pulso, ritmoPulso(4 / 12));
  });
  test("urgência: fora, depois próximo, depois dentro; no mesmo estado, o mais antigo — ordem estável no tempo", () => {
    const base = [
      { id: "novo-ok", recebidoEm: ha(2), status: "PLACED" },
      { id: "fora", recebidoEm: ha(50), status: "PLACED" },
      { id: "antigo-ok", recebidoEm: ha(10), status: "PLACED" },
      { id: "perto", recebidoEm: ha(38), status: "PLACED" },
    ];
    const ordem = (agora) => ordenarPorUrgencia(base.map((p) => derivarPedidoAtivo(p, METAS_EXEMPLO, agora))).map((p) => p.id);
    assert.deepEqual(ordem(AGORA), ["fora", "perto", "antigo-ok", "novo-ok"]);
    assert.deepEqual(ordem(AGORA + 20000), ordem(AGORA)); // segundos depois, sem mudar de estado: mesma ordem
  });
});

describe("cards: 'agora' (vivo) x 'hoje' (encerrado)", () => {
  const r = amostraDemonstracao({ agora: AGORA });
  test("cada card acompanha o pedido há mais tempo na sua etapa", () => {
    const prep = emAcompanhamento("preparo", r, AGORA);
    assert.equal(prep.pedido.displayId, "4528");
    assert.equal(prep.quantidade, 3);
    assert.equal(emAcompanhamento("entrega", r, AGORA).pedido.displayId, "4522");
    assert.equal(emAcompanhamento("vida", r, AGORA).quantidade, 6);
  });
  test("a amostra abre com os três estados visíveis", () => {
    assert.equal(estadoDoCard("preparo", r, AGORA).nivel, "critico");
    assert.equal(estadoDoCard("entrega", r, AGORA).nivel, "ok");
    assert.equal(estadoDoCard("vida", r, AGORA).nivel, "atencao");
  });
  test("sem pedido na etapa vale a média do dia, ESTÁTICA (tempo encerrado não pulsa)", () => {
    const semEntrega = { ...r, pedidosAtivos: r.pedidosAtivos.filter((p) => p.status !== "DISPATCHED") };
    const e = estadoDoCard("entrega", semEntrega, AGORA);
    assert.equal(e.vivo, null);
    assert.equal(e.origemNivel, "media");
    assert.equal(e.pulso, null);
    assert.equal(e.nivel, classificar(r.indicadores.entrega.mediaDia, r.metas.entrega));
  });
  test("números do dia mantêm seu próprio estado", () => {
    const h = derivarIndicador(r.indicadores.preparo, r.metas.preparo);
    assert.equal(h.mediaNivel, "ok");      // 9,1 / 12
    assert.equal(h.ultimoNivel, "critico"); // 12,4 / 12
  });
  test("vida = medida direta; trechos faltantes viram lacuna, nunca estimativa", () => {
    const parcial = derivarDecomposicao({ confirmacao: 1, preparo: 10, espera: null, entrega: 25 }, 41);
    assert.equal(parcial.incompleta, true);
    assert.equal(parcial.lacunaMin, 5);
  });
});

describe("status da operação", () => {
  test("o pior entre médias e pedidos, com o motivo escrito", () => {
    const s = derivarStatusOperacao(amostraDemonstracao({ agora: AGORA }), AGORA);
    assert.equal(s.nivel, "critico");
    assert.equal(s.fora, 1);
    assert.ok(s.motivos.includes("1 pedido em andamento atrasado"));
    // Média CONCLUÍDA abaixo da meta é "dentro" — nunca "próxima": o amarelo é só de pedido em andamento.
    assert.ok(!s.motivos.some((m) => /média.*próxim/i.test(m)), s.motivos.join(" | "));
    assert.ok(s.medias.every(([, n]) => n !== "atencao"));
  });
  test("sem pedidos nem medições: neutro", () => {
    const r = { ...amostraDemonstracao({ agora: AGORA }), pedidosAtivos: [], indicadores: { preparo: {}, entrega: {}, vida: {} } };
    assert.equal(derivarStatusOperacao(r, AGORA).rotulo, "Sem medições hoje");
  });
});

describe("avaliações — critério próprio (maior é melhor)", () => {
  test("satisfação não usa os limites de tempo", () => {
    assert.equal(classificarSatisfacao(4.6), "ok");
    assert.equal(classificarSatisfacao(4.2), "atencao");
    assert.equal(classificarSatisfacao(3.9), "critico");
    assert.equal(classificarSatisfacao(null), "neutro");
    assert.equal(classificarSatisfacao(4.2, { ...CRITERIOS_AVALIACAO, satisfeitaDesde: 4 }), "ok");
  });
  test("negativas destacadas e contadas", () => {
    const a = derivarAvaliacoes(amostraDemonstracao({ agora: AGORA }).avaliacoes);
    assert.equal(a.negativasHoje, 1);
    assert.deepEqual(a.recentes.map((x) => x.negativa), [false, true, false]);
    const html = painelAvaliacoes(amostraDemonstracao({ agora: AGORA }));
    assert.equal((html.match(/cko-aval-item--negativa/g) ?? []).length, 1);
    assert.match(html, /Avaliação negativa/);
    assert.doesNotMatch(html, /data-pulso/); // avaliação nunca pulsa
  });
  test("indisponível não gera média nem distribuição", () => {
    const html = painelAvaliacoes({ avaliacoes: { disponivel: false } });
    assert.match(html, /Avaliações ainda não conectadas/);
    assert.doesNotMatch(html, /cko-aval-num|cko-estrelas/);
  });
});

describe("validação das metas", () => {
  const base = { preparoMeta: "12", preparoAviso: "80", entregaMeta: "35", entregaAviso: "80", vidaMeta: "45", vidaAviso: "80" };
  test("aceita vírgula decimal", () => {
    const r = validarMetas({ ...base, preparoMeta: "11,5" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.metas.preparo, { meta: 11.5, avisoPct: 80 });
  });
  test("aviso entre 50% e 99%; meta obrigatória", () => {
    const r = validarMetas({ ...base, vidaAviso: "100", entregaMeta: "", preparoAviso: "30" });
    assert.equal(r.ok, false);
    assert.ok(r.erros.vidaAviso && r.erros.entregaMeta && r.erros.preparoAviso);
  });
});

describe("componentes visuais", () => {
  const r = amostraDemonstracao({ agora: AGORA, unidadeNome: "Unidade <script>x</script>" });

  test("demonstração tem faixa e selo, nunca 'Ao vivo'; nome escapado", () => {
    const html = montarTela(r, AGORA, { podeEditarMetas: true });
    assert.match(html, /cko-faixa-demo/);
    assert.doesNotMatch(html, new RegExp(`>${SELO_CONEXAO.ao_vivo.rotulo}<`));
    assert.doesNotMatch(html, /<script>x<\/script>/);
  });
  test("dados da API não ganham a faixa de demonstração", () => {
    const html = montarTela({ ...r, origem: "api", conexao: { estado: "ao_vivo", ultimaSincronizacao: ha(0.2) } }, AGORA);
    assert.doesNotMatch(html, /cko-faixa-demo/);
    assert.match(html, /Ao vivo/);
  });
  test("card com pedido vivo tem anel de pulso e contador; sem pedido, nem um nem outro", () => {
    const vivo = cardTempo("preparo", r, AGORA);
    assert.match(vivo, /data-pulso/);
    assert.match(vivo, /data-agora-crono>12:54</);
    assert.match(vivo, /data-estado-rot>Atrasado</);
    const parado = cardTempo("entrega", { ...r, pedidosAtivos: [] }, AGORA);
    assert.doesNotMatch(parado, /data-pulso|data-agora-crono/);
    assert.match(parado, /Nenhum pedido em entrega agora/);
  });
  test("linha do pedido mostra meta da etapa e quanto falta ou passou", () => {
    const p = derivarPedidoAtivo(r.pedidosAtivos.find((x) => x.id === "d-4528"), r.metas, AGORA);
    const html = linhaPedidoAtivo(p);
    assert.match(html, /Meta do preparo 12:00/);
    assert.match(html, /passou 00:54/);
    assert.match(html, /cko-crono--critico/);
  });
  test("tempos encerrados não pulsam (tabela e 'hoje')", () => {
    assert.doesNotMatch(painelUltimosPedidos(r), /data-pulso/);
    assert.match(painelUltimosPedidos(r), /cko-nivel-txt--critico[^>]*>12,4/);
  });
  test("cancelado fica fora das médias", () => {
    assert.match(painelUltimosPedidos(r), /cko-tr-cancelado[\s\S]*?Fora das médias/);
  });
  test("botão de metas só com permissão", () => {
    assert.doesNotMatch(cabecalho(r, AGORA, { podeEditarMetas: false }), /data-acao="metas"/);
    assert.match(cabecalho(r, AGORA, { podeEditarMetas: true }), /data-acao="metas"/);
  });
  test("estados vazios orientam", () => {
    assert.match(painelPedidosAtivos({ ...r, pedidosAtivos: [] }, AGORA), /Nenhum pedido em andamento agora/);
    assert.match(telaSemUnidade(), /Escolha uma unidade/);
  });
  test("card de status expõe assinatura para o tique não redesenhar à toa", () => {
    assert.match(cardStatus(r, AGORA), /data-assinatura="critico\|6\|1\|/);
  });
  test("diálogo de metas pede meta e aviso por indicador", () => {
    const html = dialogoMetas(METAS_EXEMPLO, { erros: { vidaAviso: "Use um valor entre 50% e 99% da meta." } });
    assert.match(html, /name="preparoAviso"/);
    assert.match(html, /name="vidaAviso"[^>]*aria-invalid="true"/);
    assert.match(html, /não são salvas/);
  });
});

describe("menu, rota e ciclo de vida", () => {
  test("Checklist Operacional fica entre Vendas e Dashboard iFood", () => {
    const ids = MENU.map((m) => m.id);
    const i = ids.indexOf("checklist-operacional");
    assert.equal(ids[i - 1], "vendas");
    assert.equal(ids[i + 1], "dashboard-executivo");
    assert.ok(MENU[i].modulo);
  });
  test("router despacha o tipo para a tela e o index carrega o CSS", () => {
    assert.match(ler("../src/router.js"), /case "checklist-operacional":\s*\n\s*renderChecklistOperacional\(\);/);
    assert.match(ler("../index.html"), /checklistOperacional\.css/);
  });
  test("o controlador só LÊ o resumo do backend: nada de escrita, storage ou fetch direto", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /import \{ obterResumoChecklist \} from "\.\/api\.js"/);
    assert.doesNotMatch(fonte, /\bhttp\.|fetch\(|localStorage|sessionStorage|post\w*\(|delJson|putJson/);
    assert.match(ler("../src/api.js"), /obterResumoChecklist = \(\) => getJson\("\/api\/v1\/checklist-operacional\/resumo"\)/);
  });
  test("demonstração só por pedido explícito na URL; o padrão é o dado real", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /get\("checklist"\) === "demonstracao"/);
    assert.match(fonte, /resumoCarregando\(/);
    // A amostra é usada num ÚNICO lugar, dentro do ramo da demonstração explícita — nunca como fallback de
    // falha, de dado vazio ou de integração desligada (falha usa marcarFalha, que mantém o retrato real).
    const usos = fonte.match(/amostraDemonstracao\(/g) ?? [];
    assert.equal(usos.length, 1);
    assert.match(fonte, /if \(demonstracaoPedida\(\)\) \{\s*\n\s*estado\.resumo = amostraDemonstracao\(/);
    assert.doesNotMatch(ler("../src/checklistOperacionalDados.js"), /amostraDemonstracao|checklistOperacionalAmostra/);
  });
  test("menu segue a régua do backend: módulo ifood (não o do Dashboard iFood)", () => {
    assert.equal(MENU.find((m) => m.id === "checklist-operacional").modulo, "ifood");
  });
  test("contadores usam o relógio do servidor; resposta antiga de outro contexto é descartada", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /relogioOffsetMs/);
    assert.match(fonte, /contextoMudou\(g\)/);
    assert.doesNotMatch(fonte.slice(fonte.indexOf("function tique()")), /const agora = Date\.now\(\)/);
  });
  test("pulso respeita movimento reduzido e troca o ritmo sem reiniciar a animação", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /prefers-reduced-motion: reduce/);
    assert.match(fonte, /updatePlaybackRate/);
    assert.match(ler("../src/checklistOperacional.css"), /@media \(prefers-reduced-motion: reduce\)/);
  });
});
