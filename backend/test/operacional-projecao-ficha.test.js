// Dashboard Operacional 2.0 — projeção por pedido (camada analítica) e Ficha 360°. Funções puras + dados sintéticos.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { projetarPedido, eventosOrdenados, somarPatrocinios, sanearItens, limparEstagio, CARIMBOS } from "../src/modules/checklist-operacional/checklistOperacional.projecao.js";
import { montarFicha, itemDaLista } from "../src/modules/checklist-operacional/checklistOperacional.ficha.js";
import { linhaDoTempoDasMetas } from "../src/modules/checklist-operacional/checklistOperacional.metas.js";
import { pedido, local, PII, cenarioPrincipal } from "./helpers/operacional-sintetico.js";

const semPII = (obj) => {
  const s = JSON.stringify(obj);
  for (const v of Object.values(PII)) assert.equal(s.includes(v), false, `dado pessoal fictício vazou: ${v}`);
  for (const proibido of ["4321", "AUT123", "cli-", "localizer", "documentNumber", "deliveryAddress", "workerName", "workerPhone"]) assert.equal(s.includes(proibido), false, `campo/valor proibido na saída: ${proibido}`);
};

describe("projeção — carimbos e linha do tempo", () => {
  test("carimbo = MENOR createdAt de cada código, mesmo com eventos fora de ordem e duplicados", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "1" });
    const embaralhados = [...eventos].reverse();
    const dup = [...embaralhados, ...embaralhados.map((e) => ({ ...e }))];   // mesmo event_id repetido
    const p = projetarPedido({ pedido: linha, eventos: dup });
    assert.equal(p.plc_em, local("2026-10-27", "12:00"));
    assert.equal(p.eventos_qtd, eventos.length, "duplicatas por event_id não contam");
    assert.deepEqual(p.linha_do_tempo.map((e) => e.codigo), eventosOrdenados(eventos).map((e) => e.event_code), "linha do tempo em ordem de createdAt");
    const ordem = p.linha_do_tempo.map((e) => Date.parse(e.em));
    assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b));
  });

  test("evento atrasado com createdAt anterior corrige o carimbo (menor vence)", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "2" });
    const plcTardio = { ...eventos[0], event_id: "ev-tardio", event_created_at: local("2026-10-27", "11:59"), received_at: local("2026-10-27", "14:00") };
    assert.equal(projetarPedido({ pedido: linha, eventos: [...eventos, plcTardio] }).plc_em, local("2026-10-27", "11:59"));
  });

  test("sem a linha do evento, usa a coluna que o Events gravou; sem nenhum, fica nulo e vira problema de integridade", () => {
    const { linha } = pedido({ data: "2026-10-27", hora: "12:00", display: "3" });
    const p = projetarPedido({ pedido: linha, eventos: [] });
    assert.equal(p.plc_em, linha.placed_event_created_at);
    assert.equal(p.dsp_em, linha.dispatch_event_at);
    assert.equal(p.con_em, linha.status_oficial_em, "CONCLUDED sem evento: status_oficial_em");
    assert.equal(p.aao_em, null, "sem coluna de origem: nunca estimado");
    const vazio = projetarPedido({ pedido: { ...linha, placed_event_created_at: null }, eventos: [] });
    assert.equal(vazio.plc_em, null);
    assert.ok(vazio.integridade.some((i) => i.codigo === "SEM_CHEGADA"));
  });

  test("evento sem data é contado em integridade e fica fora da linha do tempo", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "4" });
    const p = projetarPedido({ pedido: linha, eventos: [...eventos, { ...eventos[1], event_id: "sem-data", event_created_at: null }] });
    assert.ok(p.integridade.some((i) => i.codigo === "EVENTO_SEM_DATA"));
    assert.equal(p.linha_do_tempo.length, eventos.length);
  });

  test("cancelamento oficial: código, descrição, origem e estágio copiados (estágio sem colchetes)", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "5", status: "CANCELLED", min: { cfm: 0.2 }, cancel: { codigo: "502", descricao: "O pedido está duplicado", origem: "RESTAURANT", estagio: "PREPARATION_TIME", min: 3 } });
    const p = projetarPedido({ pedido: linha, eventos });
    assert.deepEqual([p.cancel_codigo, p.cancel_descricao, p.cancel_origem, p.cancel_estagio], ["502", "O pedido está duplicado", "RESTAURANT", "PREPARATION_TIME"]);
    assert.equal(limparEstagio("[DISPATCHED]"), "DISPATCHED");
  });

  test("cancelado depois de concluído: estado CANCELLED, mas o horário do CON é preservado", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "6", status: "CANCELLED", conAntesDoCancel: true, cancel: { codigo: "410", descricao: "O pedido não foi entregue", origem: "CONSUMER", estagio: "CONCLUDED", min: 60 } });
    const p = projetarPedido({ pedido: linha, eventos });
    assert.equal(p.status_oficial, "CANCELLED");
    assert.ok(p.con_em && p.can_em && Date.parse(p.can_em) > Date.parse(p.con_em));
    assert.ok(p.integridade.some((i) => i.codigo === "CANCELADO_APOS_CONCLUSAO"));
  });

  test("ORDER_PATCHED depois da leitura dos detalhes → detalhes_desatualizados; antes → não", () => {
    const a = pedido({ data: "2026-10-27", hora: "12:00", display: "7", opaApos: 5 });
    const p = projetarPedido({ pedido: a.linha, eventos: a.eventos });
    assert.equal(p.alteracoes, 1);
    assert.equal(p.detalhes_desatualizados, true);
    assert.ok(p.integridade.some((i) => i.codigo === "DETALHES_DESATUALIZADOS"));
    const relido = projetarPedido({ pedido: { ...a.linha, details_atualizado_em: local("2026-10-27", "12:30") }, eventos: a.eventos });
    assert.equal(relido.detalhes_desatualizados, false, "detalhes lidos depois da alteração");
  });

  test("ordem invertida de horários é problema de integridade (nunca corrigida)", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "8" });
    const dsp = eventos.find((e) => e.event_code === "DSP");
    const con = eventos.find((e) => e.event_code === "CON");
    const p = projetarPedido({ pedido: linha, eventos: eventos.map((e) => (e === con ? { ...e, event_created_at: new Date(Date.parse(dsp.event_created_at) - 60_000).toISOString() } : e)) });
    assert.ok(p.integridade.some((i) => i.codigo === "ORDEM_INVERTIDA"));
  });

  test("sem detalhes do iFood: valores/itens nulos e problema SEM_DETALHES", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "9", semDetalhes: true });
    const p = projetarPedido({ pedido: linha, eventos });
    assert.equal(p.itens, null);
    assert.equal(p.valor_total, null);
    assert.equal(p.desconto_loja, null);
    assert.ok(p.integridade.some((i) => i.codigo === "SEM_DETALHES"));
  });

  test("patrocínio: soma VALORES por patrocinador (nunca conta entradas)", () => {
    assert.deepEqual(somarPatrocinios([
      { value: 10, sponsorshipValues: [{ name: "MERCHANT", value: 10 }, { name: "IFOOD", value: 0 }, { name: "CHAIN", value: 0 }, { name: "EXTERNAL", value: 0 }] },
      { value: 4.99, sponsorshipValues: [{ name: "IFOOD", value: 4.99 }, { name: "MERCHANT", value: 0 }] },
    ]), { loja: 10, ifood: 4.99, rede: 0, externo: 0 });
    assert.equal(somarPatrocinios([]), null);
  });

  test("itens saneados: nome, código, valores e adicionais; observação só como existência", () => {
    const itens = sanearItens([{ name: "X", externalCode: "C1", quantity: 2, unitPrice: 5, totalPrice: 12, observations: `ligar para ${PII.telefone}`, options: [{ name: "Bacon", groupName: "Extras", quantity: 1, price: 2 }] }]);
    assert.equal(itens[0].temObservacao, true);
    assert.equal(JSON.stringify(itens).includes(PII.telefone), false);
    assert.equal(itens[0].adicionais[0].nome, "Bacon");
  });

  test("NENHUM dado pessoal entra na projeção (cliente, entregador, endereço, códigos, transação)", () => {
    for (const p of cenarioPrincipal().pedidos) {
      const evs = cenarioPrincipal().eventos;   // eventos de todos; a projeção só usa os do pedido
      semPII(projetarPedido({ pedido: p, eventos: evs.filter((e) => e.order_id === p.order_id) }));
    }
  });

  test("idempotência: mesma entrada → mesmo fonte_hash; mudança na fonte → hash novo", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "10" });
    const a = projetarPedido({ pedido: linha, eventos });
    const b = projetarPedido({ pedido: structuredClone(linha), eventos: [...eventos].reverse() });
    assert.equal(a.fonte_hash, b.fonte_hash);
    const c = projetarPedido({ pedido: { ...linha, status_oficial: "CANCELLED" }, eventos });
    assert.notEqual(a.fonte_hash, c.fonte_hash);
  });

  test("todo código mapeado em CARIMBOS vira coluna própria", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:00", display: "11" });
    const p = projetarPedido({ pedido: linha, eventos });
    for (const col of Object.values(CARIMBOS)) assert.ok(col in p, col);
  });
});

describe("Ficha 360°", () => {
  const metas = linhaDoTempoDasMetas([{ alterado_em: "2026-10-01T03:00:00Z", versao: 1, novo: { preparo: { meta: 20, avisoPct: 80 }, entrega: { meta: 15, avisoPct: 80 }, vida: { meta: 35, avisoPct: 80 } } }]);

  test("indicadores com a mesma régua do Checklist; atraso contra a meta vigente no recebimento", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "19:25", display: "20", min: { cfm: 0.2, prs: 0.5, rtp: 22, adr: 5, aao: 25, clt: 30, dsp: 30, aad: 48, con: 50 } });
    const f = montarFicha({ projecao: projetarPedido({ pedido: linha, eventos }), linhaDoTempoMetas: metas, unidadeNome: "U" });
    assert.equal(f.indicadores.preparo.min, 30);
    assert.equal(f.indicadores.preparo.atraso, true);
    assert.equal(f.indicadores.preparo.excedenteMin, 10);
    assert.equal(f.indicadores.entrega.min, 20);
    assert.equal(f.indicadores.vida.min, 50);
    assert.equal(f.indicadores.esperaEntregador.min, 5);
    assert.equal(f.indicadores.prontoAteColeta.min, 8);
    assert.equal(f.indicadores.confirmacao.estado, "calculado");
    assert.equal(f.indicadores.atrasos.length, 3);
    assert.match(f.indicadores.nota, /não indicam quem causou/);
  });

  test("etapas sem carimbo ficam 'indisponível' com motivo (nada estimado)", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:05", display: "21", entregaPor: "MERCHANT", min: { cfm: 0.1, prs: 0.4, dsp: 11, aad: 20, con: 21 } });
    const f = montarFicha({ projecao: projetarPedido({ pedido: linha, eventos }), linhaDoTempoMetas: metas });
    assert.equal(f.indicadores.esperaEntregador.estado, "indisponivel");
    assert.equal(f.indicadores.ateOPronto.estado, "indisponivel");
    assert.match(f.indicadores.ateOPronto.motivo, /pronto/);
    assert.deepEqual(f.historico.etapasSemRegistro.map((e) => e.codigo), ["RTP"]);
  });

  test("retirada: tempos de entrega fora (motivo explicado)", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "12:50", display: "22", tipo: "TAKEOUT", min: { cfm: 0.1, prs: 0.3, rtp: 8, con: 15 } });
    const f = montarFicha({ projecao: projetarPedido({ pedido: linha, eventos }), linhaDoTempoMetas: metas });
    assert.equal(f.indicadores.preparo.estado, "indisponivel");
    assert.match(f.indicadores.preparo.motivo, /retirada/);
  });

  test("valores marcados como operacionais (não repasse); identificador só parcial; sem dado pessoal", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "13:40", display: "23", descontoLoja: 8, descontoIfood: 5, observacao: `para ${PII.nome}` });
    const f = montarFicha({ projecao: projetarPedido({ pedido: linha, eventos }), linhaDoTempoMetas: metas, disputas: [{ handshake_type: "DELAY", settlement_status: "EXPIRED" }] });
    assert.match(f.financeiro.natureza, /Não são repasse/);
    assert.deepEqual(f.financeiro.patrocinioDescontos, { loja: 8, ifood: 5, rede: 0, externo: 0 });
    assert.ok(f.identificacao.idParcial.endsWith("…") && f.identificacao.idParcial.length === 9);
    assert.equal(f.ocorrencias.disputas[0].desfecho, "EXPIRED");
    semPII(f);
  });

  test("item da lista: atraso marcado e nenhum dado pessoal", () => {
    const { linha, eventos } = pedido({ data: "2026-10-27", hora: "19:25", display: "24", min: { cfm: 0.2, prs: 0.5, rtp: 22, adr: 5, aao: 25, clt: 30, dsp: 30, aad: 48, con: 50 } });
    const i = itemDaLista(projetarPedido({ pedido: linha, eventos }), metas);
    assert.equal(i.atrasado, true);
    assert.equal(i.numero, "24");
    semPII(i);
  });
});
