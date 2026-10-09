// Checklist Operacional — adaptador dos dados reais e estados da tela.
//
// A compatibilidade com o backend é provada com o CÁLCULO REAL do backend (puro, sem I/O): as linhas de
// `ifood_pedidos` passam por `montarResumo`, viram a resposta do endpoint e entram nos componentes da tela.
//
// Rodar: node --test frontend/test/checklistOperacionalDados.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { montarResumo } from "../../backend/src/modules/checklist-operacional/checklistOperacional.calc.js";
import {
  adaptarResumo, avisoDe, resumoCarregando, marcarFalha, envelhecido, marcarEnvelhecido, assinaturaDados,
} from "../src/checklistOperacionalDados.js";
import { METAS_EXEMPLO, estadoDoCard, derivarStatusOperacao, derivarPedidoAtivo } from "../src/checklistOperacionalModelo.js";
import { montarTela, cardTempo, cardStatus, painelPedidosAtivos } from "../src/checklistOperacionalVisual.js";

const AGORA = Date.parse("2026-10-09T15:00:00.000Z");
const iso = (min) => new Date(AGORA - min * 60_000).toISOString();
const UNIDADE = { id: "u-1", nome: "Subway Saci" };

const linha = (over = {}) => ({
  order_id: `o-${Math.random()}`, display_id: "4521", status_oficial: "CONCLUDED", status_oficial_em: iso(20),
  order_type: "DELIVERY", delivery_by: "IFOOD", order_timing: "IMMEDIATE", is_test: false,
  order_created_at: iso(60), placed_event_created_at: iso(60), confirmed_event_at: iso(59), ready_event_at: iso(49),
  dispatch_event_at: iso(45), cancel_event_at: null, primeiro_evento_em: iso(60), criado_em: iso(60), ...over,
});

/** Resposta do endpoint montada com o cálculo REAL do backend. */
function resposta({ pedidos = [], integracao = { estado: "ao_vivo", motivo: null, mensagem: null, ultimaSincronizacao: iso(0.2) }, alertasExtra = [] } = {}) {
  const r = montarResumo({ pedidos, agoraMs: AGORA });
  return {
    versao: 1, origem: "api", servidorEm: new Date(AGORA).toISOString(), atualizarEmS: 30, integracao,
    semPedidosNoDia: r.contagemDia.recebidos === 0 && r.pedidosAtivos.length === 0,
    ...r, alertas: [...r.alertas, ...alertasExtra],
    avaliacoes: { disponivel: false, motivo: "As avaliações do iFood ainda não estão conectadas à Central." },
    tempoReal: { disponivel: false, topico: "unidade:u-1", evento: "ifood_pedido.estado_atualizado" },
  };
}
const adaptar = (dados, recebidoEmMs = AGORA) => adaptarResumo(dados, { unidade: UNIDADE, metas: METAS_EXEMPLO, recebidoEmMs });

describe("estados exigidos da tela", () => {
  test("integração desativada: 'Integração não ativada', selo correspondente, sem número", () => {
    const r = adaptar(resposta({ integracao: { estado: "nao_ativada", motivo: "recebimento_desligado", mensagem: "O recebimento ainda não foi ativado." } }));
    const html = montarTela(r, AGORA);
    assert.match(html, /Integração não ativada\./);
    assert.match(html, /cko-selo--neutro[^>]*><i><\/i>Integração não ativada/);
    assert.doesNotMatch(html, /cko-faixa-demo"[^>]*>.*Modo demonstração/);
    assert.doesNotMatch(html, /cko-nivel-txt--\w+" title="[^"]*">(<span[^>]*>≈<\/span>)?\d+,\d min/);
  });

  test("integração ativa sem pedidos: 'Nenhum pedido registrado no período' e selo Ao vivo", () => {
    const html = montarTela(adaptar(resposta()), AGORA);
    assert.match(html, /Nenhum pedido registrado no período\./);
    assert.match(html, />Ao vivo</);
  });

  test("dados desatualizados (servidor): faixa 'Dados desatualizados' e os números continuam visíveis", () => {
    const r = adaptar(resposta({ pedidos: [linha()], integracao: { estado: "desatualizado", motivo: "recebimento_parado", mensagem: "O recebimento parou.", ultimaSincronizacao: iso(9) } }));
    const html = montarTela(r, AGORA);
    assert.match(html, /Dados desatualizados\./);
    assert.match(html, /cko-selo--atencao/);
    assert.match(html, /10,0 min/);
  });

  test("timestamps insuficientes: 'Indicador indisponível' com o motivo, nunca zero", () => {
    const r = adaptar(resposta({ pedidos: [linha({ order_type: null, display_id: null })] }));
    const html = cardTempo("entrega", r, AGORA);
    assert.match(html, /Indicador indisponível/);
    assert.match(html, /detalhes do pedido/);
    assert.doesNotMatch(html, /0,0 min/);
  });

  test("falha de rede: mantém o último retrato, marca 'Sem conexão' e explica", () => {
    const r = marcarFalha(adaptar(resposta({ pedidos: [linha()] })), new Error("rede"));
    assert.equal(r.conexao.estado, "indisponivel");
    assert.equal(r.aviso.titulo, "Dados desatualizados");
    assert.equal(r.indicadores.preparo.mediaDia, 10);
    assert.equal(marcarFalha(resumoCarregando({ unidade: UNIDADE, metas: METAS_EXEMPLO }), new Error("x")).aviso.titulo, "Sem conexão");
  });

  test("403 vira 'Sem acesso', não 'sem conexão'", () => {
    const e = Object.assign(new Error("proibido"), { status: 403 });
    assert.equal(marcarFalha(adaptar(resposta()), e).aviso.titulo, "Sem acesso");
  });

  test("sem resposta por 3 intervalos: a tela se declara desatualizada sozinha", () => {
    const r = adaptar(resposta());
    assert.equal(envelhecido(r, AGORA + 60_000), false);
    assert.equal(envelhecido(r, AGORA + 91_000), true);
    assert.equal(marcarEnvelhecido(r).aviso.titulo, "Dados desatualizados");
  });

  test("carregando: nenhum número, selo 'Conectando'", () => {
    const html = montarTela(resumoCarregando({ unidade: UNIDADE, metas: METAS_EXEMPLO }), AGORA);
    assert.match(html, />Conectando</);
    assert.doesNotMatch(html, /cko-nivel-txt--\w+" title="[^"]*">(<span[^>]*>≈<\/span>)?\d+,\d min/);
  });
});

describe("compatibilidade com o contrato do backend", () => {
  const pedidos = [
    linha({ display_id: "4517" }),
    linha({ display_id: "4520", ready_event_at: null }),                                                     // preparo aproximado
    linha({ display_id: "4530", status_oficial: "CONFIRMED", placed_event_created_at: iso(6), confirmed_event_at: iso(5), ready_event_at: null, dispatch_event_at: null }),
    linha({ display_id: "4400", status_oficial: "DISPATCHED", placed_event_created_at: iso(300) }),            // preso → alerta
  ];
  const r = adaptar(resposta({ pedidos }));

  test("o adaptador entrega exatamente o formato que os componentes leem", () => {
    assert.equal(r.origem, "api");
    assert.equal(r.unidade.nome, "Subway Saci");
    assert.equal(r.conexao.estado, "ao_vivo");
    // O aberto há 5 h CONTINUA ativo (estado oficial DISPATCHED), marcado `semConclusao`.
    assert.equal(r.pedidosAtivos.length, 2);
    assert.equal(r.pedidosAtivos.find((p) => p.displayId === "4530").confirmadoEm, iso(5));
    assert.equal(r.pedidosAtivos.find((p) => p.displayId === "4400").semConclusao, true);
    assert.equal(r.avaliacoes.disponivel, false);
  });

  test("o aberto há mais de 4 h aparece na lista (no topo, marcado), mas não congela o contador dos cards", () => {
    const html = painelPedidosAtivos(r, AGORA);
    assert.match(html, /#4400[\s\S]*Aberto há mais de 4 h sem conclusão/);
    assert.ok(html.indexOf("#4400") < html.indexOf("#4530"), "o mais urgente vem primeiro");
    assert.equal(estadoDoCard("vida", r, AGORA).vivo.pedido.displayId, "4530");
    assert.equal(estadoDoCard("entrega", r, AGORA).vivo, null);
    assert.equal(derivarStatusOperacao(r, AGORA).ativos, 2);
  });

  test("agendado: na lista como 'Agendado', sem cronômetro de preparo/vida nem cor de atraso", () => {
    const ag = adaptar(resposta({ pedidos: [linha({ display_id: "4600", status_oficial: "CONFIRMED", order_timing: "SCHEDULED", placed_event_created_at: iso(200), confirmed_event_at: iso(199), ready_event_at: null, dispatch_event_at: null })] }));
    const p = derivarPedidoAtivo(ag.pedidosAtivos[0], ag.metas, AGORA);
    assert.equal(p.nivel, "neutro");
    assert.equal(p.daEtapa.cronometro, "—");
    const html = painelPedidosAtivos(ag, AGORA);
    assert.match(html, /Agendado<\/span>/);
    assert.match(html, /Agendado: sem meta de preparo/);
    assert.doesNotMatch(html, /undefined/);
    assert.equal(estadoDoCard("preparo", ag, AGORA).vivo, null);
    assert.equal(estadoDoCard("vida", ag, AGORA).vivo, null);
  });

  test("agendado já despachado é cronometrado na ENTREGA (saída → agora)", () => {
    const ag = adaptar(resposta({ pedidos: [linha({ status_oficial: "DISPATCHED", order_timing: "SCHEDULED", dispatch_event_at: iso(7) })] }));
    assert.equal(estadoDoCard("entrega", ag, AGORA).vivo.cronometro, "07:00");
  });

  test("abertos de antes da janela entram no total 'Em andamento' do card de status", () => {
    const comAntigos = { ...r, contagemDia: { ...r.contagemDia, abertosForaDaJanela: 3 } };
    assert.equal(derivarStatusOperacao(comAntigos, AGORA).ativos, 5);
  });

  test("entrega não se apresenta como 'concluída ao cliente': rótulo neutro de medição", () => {
    const html = cardTempo("entrega", r, AGORA);
    assert.match(html, /Última medição/);
    assert.doesNotMatch(html, /Último concluído|entregue/i);
  });

  test("o pedido em preparo vira contador vivo no card de preparo", () => {
    const e = estadoDoCard("preparo", r, AGORA);
    assert.equal(e.vivo.pedido.displayId, "4530");
    assert.equal(e.vivo.cronometro, "05:00");
  });

  test("média com aproximação mostra '≈' e a quantidade de pedidos", () => {
    const html = cardTempo("preparo", r, AGORA);
    // 3 pedidos: o "preso" (sem conclusão) foi preparado de verdade (CFM→RTP), então conta no preparo.
    assert.match(html, /Média hoje <small class="cko-hoje-amostras">3 pedidos<\/small>/);
    assert.match(html, /≈<\/span>11,3 min/);
  });

  test("entrega é sempre marcada como aproximada, com a causa", () => {
    assert.match(cardTempo("entrega", r, AGORA), /conclusão do iFood ainda não foi validada/);
  });

  test("pedido sem conclusão aparece no card de status (crítico), nunca escondido", () => {
    const s = derivarStatusOperacao(r, AGORA);
    assert.equal(s.nivel, "critico");
    assert.ok(s.motivos.some((m) => /sem conclusão/.test(m)));
    assert.match(cardStatus(r, AGORA), /1 pedido aberto há mais de 4 h sem conclusão/);
  });

  test("avaliações: estado honesto de 'não conectadas', sem nota fictícia", () => {
    const html = montarTela(r, AGORA);
    assert.match(html, /Avaliações ainda não conectadas/);
    assert.doesNotMatch(html, /cko-estrelas/);
  });

  test("relógio do aparelho atrasado é corrigido pelo horário do servidor", () => {
    const atrasado = adaptar(resposta(), AGORA - 5 * 60_000); // TV 5 min atrasada
    assert.equal(atrasado.relogioOffsetMs, 5 * 60_000);
  });

  test("resposta igual (só horários de ciclo mudaram) não pede redesenho", () => {
    const a = resposta({ pedidos });
    const b = { ...a, servidorEm: iso(-0.5), integracao: { ...a.integracao, ultimaSincronizacao: iso(-0.4) } };
    assert.equal(assinaturaDados(a), assinaturaDados(b));
    assert.notEqual(assinaturaDados(a), assinaturaDados(resposta()));
  });

  test("aviso: só quando há algo a dizer", () => {
    assert.equal(avisoDe(resposta({ pedidos })), null);
    assert.equal(avisoDe(resposta()).titulo, "Nenhum pedido registrado no período");
  });
});
