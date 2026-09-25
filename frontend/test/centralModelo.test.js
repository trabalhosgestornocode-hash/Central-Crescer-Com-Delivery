// Central de Comunicação — modelo PURO (sem DOM): trilha de entrega (SENT ≠ DELIVERED ≠ READ), datas, agrupamento por voz, mesclagem, envio otimista, fases do assistente
// de conexão e contagem do QR.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  trilhaDe, rotuloStatus, dicaStatus, ROTULO_STATUS, horaLocal, rotuloDia, horarioCurto, dataHoraCurta, blocosDaConversa, mesclarMensagens, mensagemOtimista,
  comoFalhaLocal, novoEnvioId, textoEnviavel, caracteres, matizDe, resumirLista, situacaoDoContato, ABAS, TEXTO_MAX,
  passosDoAssistente, proximaFase, progressoQr, PASSOS_ASSISTENTE, ROTULO_ESTADO_CONEXAO, TOM_ESTADO_CONEXAO, FASES_EM_ANDAMENTO,
} from "../src/central/centralModelo.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);            // horário LOCAL do teste, para as datas não dependerem do fuso da máquina
const local = (dias, h, m = 0) => new Date(2026, 8, 24 + dias, h, m, 0).toISOString();

describe("trilha de entrega", () => {
  const estados = (s) => trilhaDe(s).map((m) => m.estado);
  test("SENT acende SÓ a 1ª marca: 'enviada' nunca vira 'entregue'", () => {
    assert.deepEqual(estados("SENT"), ["feito", "pendente", "pendente"]);
    assert.match(trilhaDe("SENT")[1].dica, /ainda não foi confirmada/);
  });
  test("DELIVERED acende as duas primeiras; READ as três", () => {
    assert.deepEqual(estados("DELIVERED"), ["feito", "feito", "pendente"]);
    assert.deepEqual(estados("READ"), ["feito", "feito", "feito"]);
  });
  test("estados de atenção: enviando, não confirmada, falhou, cancelada, bloqueada e agendada", () => {
    assert.deepEqual(estados("SENDING"), ["andamento", "pendente", "pendente"]);
    assert.deepEqual(estados("PROCESSING"), ["andamento", "pendente", "pendente"]);
    assert.deepEqual(estados("DELIVERY_UNKNOWN"), ["atencao", "pendente", "pendente"]);
    assert.deepEqual(estados("FAILED"), ["falha", "pendente", "pendente"]);
    assert.deepEqual(estados("CANCELLED"), ["cancelado", "pendente", "pendente"]);
    assert.deepEqual(estados("BLOCKED"), ["cancelado", "pendente", "pendente"]);
    assert.deepEqual(estados("SCHEDULED"), ["pendente", "pendente", "pendente"]);
    assert.deepEqual(estados("QUALQUER"), ["pendente", "pendente", "pendente"], "desconhecido ⇒ nada acende");
  });
  test("rótulos amigáveis: SENT = 'Enviada ao WhatsApp' (nunca 'Entregue'); vocabulário completo", () => {
    assert.equal(rotuloStatus("SENT"), "Enviada ao WhatsApp");
    assert.notEqual(rotuloStatus("SENT"), rotuloStatus("DELIVERED"));
    assert.deepEqual(
      [rotuloStatus("SCHEDULED"), rotuloStatus("SENDING"), rotuloStatus("DELIVERED"), rotuloStatus("READ"), rotuloStatus("FAILED"), rotuloStatus("DELIVERY_UNKNOWN"), rotuloStatus("CANCELLED")],
      ["Agendada", "Enviando", "Entregue", "Lida", "Falhou", "Entrega não confirmada", "Cancelada"]);
    for (const s of Object.keys(ROTULO_STATUS)) assert.ok(dicaStatus(s).length > 10, `tooltip de ${s}`);
    assert.equal(rotuloStatus("X"), "X"); assert.equal(dicaStatus("X"), "");
  });
  test("nenhum rótulo/dica usa vocabulário de engenharia", () => {
    const txt = JSON.stringify([ROTULO_STATUS, ...Object.keys(ROTULO_STATUS).map((s) => trilhaDe(s))]);
    assert.ok(!/DELIVERY_UNKNOWN"|SENT"|provider|gateway|baileys|hmac/i.test(txt.replace(/"(DELIVERY_UNKNOWN|SCHEDULED|PROCESSING|SENDING|SENT|DELIVERED|READ|FAILED|CANCELLED|BLOCKED)":/g, "")));
  });
});

describe("datas", () => {
  test("rotuloDia: Hoje, Ontem e data por extenso (com ano quando é outro)", () => {
    assert.equal(rotuloDia(local(0, 9), AGORA), "Hoje");
    assert.equal(rotuloDia(local(-1, 23), AGORA), "Ontem");
    assert.equal(rotuloDia(local(-3, 10), AGORA), "21 de setembro");
    assert.equal(rotuloDia(new Date(2025, 11, 5, 10).toISOString(), AGORA), "5 de dezembro de 2025");
    assert.equal(rotuloDia("lixo", AGORA), "");
  });
  test("horaLocal, horarioCurto e dataHoraCurta", () => {
    assert.equal(horaLocal(local(0, 9, 5)), "09:05");
    assert.equal(horarioCurto(local(0, 9, 5), AGORA), "09:05");
    assert.equal(horarioCurto(local(-1, 9, 5), AGORA), "Ontem");
    assert.equal(horarioCurto(local(-5, 9, 5), AGORA), "19/09");
    assert.equal(dataHoraCurta(local(0, 14, 30), AGORA), "Hoje, 14:30");
    assert.equal(dataHoraCurta(local(-1, 8, 0), AGORA), "Ontem, 08:00");
    assert.equal(dataHoraCurta(local(-9, 8, 0), AGORA), "15/09, 08:00");
    assert.equal(horaLocal(null), ""); assert.equal(horarioCurto(undefined), "");
  });
});

describe("agrupamento da conversa por voz", () => {
  const m = (id, direcao, categoria, iso, operador = null) => ({ id, direcao, categoria, em: iso, operador });
  test("separador de dia + agrupa consecutivas da MESMA voz em até 5 min; muda a voz ou o intervalo ⇒ novo grupo", () => {
    const blocos = blocosDaConversa([
      m("a", "entrada", "recebida", local(-1, 22, 0)), m("b", "entrada", "recebida", local(-1, 22, 2)),
      m("c", "saida", "manual", local(-1, 22, 3), "Camila"), m("d", "saida", "manual", local(-1, 22, 4), "Camila"), m("e", "saida", "manual", local(-1, 22, 4), "Bruno"),
      m("f", "saida", "manual", local(0, 9, 0), "Bruno"), m("g", "saida", "manual", local(0, 9, 10), "Bruno"),
    ], AGORA);
    assert.deepEqual(blocos.map((b) => (b.tipo === "dia" ? `dia:${b.rotulo}` : `${b.direcao}/${b.categoria}/${b.operador ?? "-"}:${b.itens.map((i) => i.id).join("")}`)),
      ["dia:Ontem", "entrada/recebida/-:ab", "saida/manual/Camila:cd", "saida/manual/Bruno:e", "dia:Hoje", "saida/manual/Bruno:f", "saida/manual/Bruno:g"]);
  });
  test("lista vazia/lixo ⇒ sem blocos; automática e teste não se misturam com a equipe", () => {
    assert.deepEqual(blocosDaConversa([], AGORA), []); assert.deepEqual(blocosDaConversa(null, AGORA), []);
    const b = blocosDaConversa([m("a", "saida", "automatica", local(0, 9)), m("b", "saida", "teste", local(0, 9)), m("c", "saida", "manual", local(0, 9))], AGORA).filter((x) => x.tipo === "grupo");
    assert.equal(b.length, 3);
  });
});

describe("mesclagem e envio otimista", () => {
  test("mescla páginas empatadas por direção/ID e preserva microssegundos do PostgreSQL", () => {
    const em = "2026-09-24T15:00:00.000001Z";
    const r = mesclarMensagens([{ id: "z", direcao: "saida", em }], [
      { id: "b", direcao: "entrada", em }, { id: "a", direcao: "entrada", em },
      { id: "0", direcao: "entrada", em: "2026-09-24T15:00:00.000002Z" },
    ]);
    assert.deepEqual(r.map((m) => m.id), ["a", "b", "z", "0"]);
  });
  test("mesclar por id: o status avança sem duplicar e a ordem é cronológica", () => {
    const antes = [{ id: "1", em: local(0, 9), status: "SENT" }, { id: "2", em: local(0, 10), status: "SENT" }];
    const r = mesclarMensagens(antes, [{ id: "1", em: local(0, 9), status: "READ" }, { id: "0", em: local(0, 8), status: "READ" }]);
    assert.deepEqual(r.map((x) => [x.id, x.status]), [["0", "READ"], ["1", "READ"], ["2", "SENT"]]);
  });
  test("a bolha otimista some quando chega a definitiva com o MESMO envioId (sem duplicar)", () => {
    const otim = mensagemOtimista({ envioId: "E1", texto: "oi", operador: "Camila", agora: AGORA });
    assert.deepEqual([otim.id, otim.status, otim.local, otim.categoria, otim.direcao], ["local:E1", "SENDING", true, "manual", "saida"]);
    const r = mesclarMensagens([otim], [{ id: "srv-1", envioId: "E1", em: local(0, 15, 0), status: "SENT", texto: "oi" }]);
    assert.deepEqual(r.map((x) => x.id), ["srv-1"]);
  });
  test("falha local: vira FAILED com marca de reenvio; texto de erro sem detalhe técnico", () => {
    const f = comoFalhaLocal(mensagemOtimista({ envioId: "E2", texto: "x", agora: AGORA }), "Não foi possível confirmar");
    assert.deepEqual([f.status, f.falhaLocal, f.envioId], ["FAILED", true, "E2"]);
  });
  test("envioId é um UUID novo a cada chamada; textoEnviavel e limite", () => {
    const a = novoEnvioId(); const b = novoEnvioId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); assert.notEqual(a, b);
    for (const t of ["", "   \n", null, undefined, 5, "x".repeat(TEXTO_MAX + 1)]) assert.equal(textoEnviavel(t), false, String(t));
    assert.equal(textoEnviavel("oi"), true); assert.equal(textoEnviavel("y".repeat(TEXTO_MAX)), true);
    assert.equal(caracteres("😀😀"), 2);
  });
});

describe("apoio de tela", () => {
  test("matizDe é estável e fica em 0..359; resumirLista; situação do contato mostra só fatos do cadastro", () => {
    assert.equal(matizDe("abc"), matizDe("abc")); assert.ok(matizDe("x") >= 0 && matizDe("x") < 360);
    assert.deepEqual(resumirLista([1, 2, 3, 4, 5], 3), { visiveis: [1, 2, 3], resto: 2 });
    const s = situacaoDoContato({ consentimento: true, verificado: false, optOut: true });
    assert.deepEqual(s.map((x) => [x.id, x.ok]), [["consentimento", true], ["verificado", false], ["optout", false]]);
  });
  test("abas: as 7 seções, com Conexão antes de Configurações", () => {
    assert.deepEqual(ABAS.map(([id]) => id), ["visao-geral", "conversas", "automacoes", "historico", "destinatarios", "conexao", "configuracoes"]);
  });
});

describe("assistente de conexão: fases, etapas e QR", () => {
  test("5 etapas com os nomes pedidos", () => {
    assert.deepEqual(PASSOS_ASSISTENTE.map(([, r]) => r), ["Iniciar conexão", "Escanear QR Code", "Conta identificada", "Confirmar identidade", "Conexão concluída"]);
  });
  test("estados da sessão em linguagem amigável", () => {
    assert.deepEqual(ROTULO_ESTADO_CONEXAO, { CONNECTED: "Conectado", DISCONNECTED: "Desconectado", CONNECTING: "Conectando", WAITING_QR: "Aguardando leitura do QR Code", RECONNECTING: "Reconectando", AUTH_ERROR: "Sessão inválida" });
    assert.equal(TOM_ESTADO_CONEXAO.AUTH_ERROR, "critico"); assert.equal(TOM_ESTADO_CONEXAO.CONNECTED, "ok");
  });
  test("passosDoAssistente: feito/ativo/pendente, erro e concluída", () => {
    const e = (f, o) => passosDoAssistente(f, o).map((p) => p.estado).join(",");
    assert.equal(e("iniciando"), "ativo,pendente,pendente,pendente,pendente");
    assert.equal(e("aguardando"), "feito,ativo,pendente,pendente,pendente");
    assert.equal(e("expirado"), "feito,ativo,pendente,pendente,pendente");
    assert.equal(e("validando"), "feito,feito,ativo,pendente,pendente");
    assert.equal(e("identificado"), "feito,feito,feito,ativo,pendente");
    assert.equal(e("concluida"), "feito,feito,feito,feito,feito");
    assert.equal(e("erro", { falhouEm: 2 }), "feito,feito,erro,pendente,pendente");
  });
  test("proximaFase: gerando → aguardando (QR) → validando (conectou); expira sem QR; nunca volta de identificado/concluída/erro", () => {
    const t0 = 1_000_000;
    assert.equal(proximaFase("iniciando", { estado: "CONNECTING", disponivel: false }, { agora: t0 + 100, desde: t0 }), "gerando");
    assert.equal(proximaFase("gerando", { estado: "WAITING_QR", disponivel: true, svg: "<svg/>" }, { agora: t0 + 3000, desde: t0 }), "aguardando");
    assert.equal(proximaFase("aguardando", { estado: "WAITING_QR", disponivel: true }, { agora: t0 + 9000, desde: t0 }), "aguardando");
    assert.equal(proximaFase("aguardando", { estado: "CONNECTED", identificada: true }, { agora: t0 + 9000, desde: t0 }), "validando");
    assert.equal(proximaFase("gerando", { estado: "CONNECTED", identificada: true }, { agora: t0 + 100, desde: t0 }), "validando");
    assert.equal(proximaFase("perfil", { estado: "CONNECTED", identificada: true }, { agora: t0, desde: t0 }), "perfil");
    // o QR acabou e o Gateway fechou o pareamento: expirado (o operador pede outro)
    assert.equal(proximaFase("aguardando", { estado: "DISCONNECTED", disponivel: false }, { agora: t0 + 9000, desde: t0 }), "expirado");
    assert.equal(proximaFase("expirado", { estado: "CONNECTING", disponivel: false }, { agora: t0 + 9000, desde: t0 }), "expirado");
    assert.equal(proximaFase("expirado", { estado: "WAITING_QR", disponivel: true }, { agora: t0 + 9000, desde: t0 }), "aguardando", "chegou QR novo: volta a aguardar");
    // não abriu o pareamento a tempo
    assert.equal(proximaFase("gerando", { estado: "DISCONNECTED", disponivel: false }, { agora: t0 + 13_000, desde: t0 }), "expirado");
    assert.equal(proximaFase("gerando", { estado: "DISCONNECTED", disponivel: false }, { agora: t0 + 2_000, desde: t0 }), "gerando", "no começo ainda é normal");
    for (const f of ["identificado", "concluida", "erro"]) assert.equal(proximaFase(f, { estado: "DISCONNECTED", disponivel: true }, { agora: t0 + 99_000, desde: t0 }), f);
    assert.ok(FASES_EM_ANDAMENTO.includes("aguardando") && !FASES_EM_ANDAMENTO.includes("identificado"));
  });
  test("progressoQr: 1º QR vive 60 s, os seguintes 20 s; a fração desce de 1 a 0 e nunca sai da faixa", () => {
    const agora = Date.parse("2026-09-24T12:00:00Z");
    assert.deepEqual(progressoQr("2026-09-24T12:00:30Z", 1, agora), { restante: 30, fracao: 0.5 });
    assert.deepEqual(progressoQr("2026-09-24T12:00:10Z", 2, agora), { restante: 10, fracao: 0.5 });
    assert.deepEqual(progressoQr("2026-09-24T12:00:20Z", 2, agora), { restante: 20, fracao: 1 });
    assert.deepEqual(progressoQr("2026-09-24T11:59:00Z", 1, agora), { restante: 0, fracao: 0 });
    assert.deepEqual(progressoQr("2026-09-24T12:05:00Z", 2, agora), { restante: 300, fracao: 1 }, "fração limitada a 1");
    assert.deepEqual(progressoQr("lixo", 1, agora), { restante: 0, fracao: 0 });
  });
});

import { avancarCursor } from "../src/central/centralModelo.js";
describe("avancarCursor — polling por cursor (monotônico)", () => {
  const A = "2026-09-24T15:00:00.000Z|2026-09-24T15:00:05.000Z";
  test("avança cada metade independente e NUNCA recua", () => {
    assert.equal(avancarCursor(A, "2026-09-24T15:01:00.000Z|2026-09-24T15:00:05.000Z"), "2026-09-24T15:01:00.000Z|2026-09-24T15:00:05.000Z");
    assert.equal(avancarCursor(A, "2026-09-24T14:00:00.000Z|2026-09-24T15:09:00.000Z"), "2026-09-24T15:00:00.000Z|2026-09-24T15:09:00.000Z", "inbox ficou, saída avançou");
    assert.equal(avancarCursor(A, "2026-09-24T10:00:00.000Z|2026-09-24T10:00:00.000Z"), A, "resposta atrasada/fora de ordem é ignorada");
  });
  test("uma purga que baixou o máximo (ou esvaziou) NÃO leva o cursor para trás", () => {
    assert.equal(avancarCursor(A, "|"), A);
  });
  test("primeira leitura adota o cursor recebido; entrada inválida mantém o atual", () => {
    assert.equal(avancarCursor(null, A), A);
    assert.equal(avancarCursor(undefined, "|"), "|");
    assert.equal(avancarCursor(A, "lixo"), A);
    assert.equal(avancarCursor(A, null), A);
    assert.equal(avancarCursor(null, "lixo"), null);
  });
  test("idempotente e sem efeito colateral (mesma resposta duas vezes = mesmo cursor)", () => {
    const n = "2026-09-24T15:02:00.000Z|2026-09-24T15:02:00.000Z";
    assert.equal(avancarCursor(avancarCursor(A, n), n), n);
  });
});
