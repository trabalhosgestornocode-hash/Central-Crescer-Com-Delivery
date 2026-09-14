// Emissor central de eventos (backend/src/modules/realtime/emitirEvento.js).
//
// O que este teste protege especificamente (Fase W/"Falha na emissão do
// evento" da aprovação da Etapa 1): uma gravação de negócio já confirmada
// NUNCA pode virar erro pro chamador só porque o Broadcast falhou depois —
// `emitirEventoRealtime` precisa engolir qualquer falha de rede/HTTP e nunca
// lançar. Etapa 1: função existe e está testada, mas nenhum service ainda a
// chama de verdade (ligação real é a Etapa 2).
//
// CONTRATO REST: usa o endpoint de UMA mensagem
// (POST /realtime/v1/api/broadcast/{topic}/events/{event}?private=true,
// corpo = o payload cru) — confirmado contra a doc oficial do Supabase antes
// da Etapa 2 (ver o comentário no topo de emitirEvento.js). Não usa o
// endpoint de lote porque a doc oficial não mostra, em nenhum exemplo, como
// marcar uma mensagem do lote como privada.
//
// Rodar: node --test test/realtime-emitir-evento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config/env.js";
import { emitirEventoRealtime } from "../src/modules/realtime/emitirEvento.js";

function fetchFake({ ok = true, status = 200 } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, opts) => {
    chamadas.push({ url, opts, corpo: JSON.parse(opts.body) });
    return { ok, status };
  };
  return { fetchImpl, chamadas };
}

describe("emitirEventoRealtime — contrato REST (endpoint de uma mensagem)", () => {
  test("publica um POST por tópico autorizado (unidade + empresa), cada um pro seu path", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime(
      { tipo: "dashboard_ifood.lancamento_atualizado", organizacaoId: "org-1", unidadeId: "uni-1", entidadeId: "lanc-1" },
      { fetchImpl },
    );
    assert.equal(chamadas.length, 2);
    const urls = chamadas.map((c) => c.url).sort();
    assert.ok(urls[0].includes(`${config.supabaseUrl}/realtime/v1/api/broadcast/`));
    const topicosNaUrl = urls.map((u) => decodeURIComponent(u.split("/broadcast/")[1].split("/events/")[0])).sort();
    assert.deepEqual(topicosNaUrl, ["empresa:org-1", "unidade:uni-1"]);
  });

  test("marca a mensagem como privada via query string ?private=true (não como campo no corpo)", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1" }, { fetchImpl });
    assert.match(chamadas[0].url, /[?&]private=true(&|$)/);
    assert.equal(chamadas[0].corpo.private, undefined, "o payload não deve carregar 'private' — é da URL, não do corpo");
  });

  test("o corpo da requisição é o payload cru (não envelopado em {messages:[...]})", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1", entidadeId: "e1" }, { fetchImpl });
    assert.equal(chamadas[0].corpo.tipo, "x.y");
    assert.equal(chamadas[0].corpo.entidadeId, "e1");
    assert.equal(chamadas[0].corpo.messages, undefined);
  });

  test("header: só 'apikey' com a service_role key — sem Authorization (não documentado pra este endpoint)", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1" }, { fetchImpl });
    assert.equal(chamadas[0].opts.headers.apikey, config.supabaseServiceKey);
    assert.equal(chamadas[0].opts.headers["Content-Type"], "application/json");
  });

  test("o tópico vai codificado na URL (contém ':')", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1" }, { fetchImpl });
    assert.ok(chamadas[0].url.includes(encodeURIComponent("empresa:org-1")));
  });

  test("'Todas as unidades' (unidadeId nulo) publica só no tópico de empresa", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1", unidadeId: null }, { fetchImpl });
    assert.equal(chamadas.length, 1);
    assert.ok(chamadas[0].url.includes(encodeURIComponent("empresa:org-1")));
  });

  test("inclui um carimbo de emissão no payload", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    await emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1" }, { fetchImpl });
    assert.ok(chamadas[0].corpo.emitidoEm);
  });
});

describe("emitirEventoRealtime — nunca vira falha de negócio", () => {
  test("HTTP não-OK (Supabase recusou) não lança — só é logado", async () => {
    const { fetchImpl } = fetchFake({ ok: false, status: 500 });
    const logs = [];
    await assert.doesNotReject(() =>
      emitirEventoRealtime(
        { tipo: "dashboard_ifood.lancamento_criado", organizacaoId: "org-1", unidadeId: "uni-1" },
        { fetchImpl, log: (msg, err) => logs.push({ msg, err }) },
      ),
    );
    assert.ok(logs.length >= 1, "a falha tem que ser logada, não silenciada por completo");
  });

  test("fetch rejeitando (rede fora do ar) não lança", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const logs = [];
    await assert.doesNotReject(() =>
      emitirEventoRealtime({ tipo: "x.y", organizacaoId: "org-1" }, { fetchImpl, log: (m, e) => logs.push({ m, e }) }),
    );
    assert.ok(logs.length >= 1);
  });

  test("uma falha num tópico não impede a tentativa nos outros (Promise.allSettled, não Promise.all)", async () => {
    let chamada = 0;
    const fetchImpl = async () => {
      chamada += 1;
      if (chamada === 1) throw new Error("falhou só o primeiro");
      return { ok: true, status: 200 };
    };
    const logs = [];
    await emitirEventoRealtime(
      { tipo: "x.y", organizacaoId: "org-1", unidadeId: "uni-1" },
      { fetchImpl, log: (m, e) => logs.push({ m, e }) },
    );
    assert.equal(chamada, 2, "os dois tópicos foram tentados mesmo com o primeiro falhando");
    assert.equal(logs.length, 1, "só o tópico que falhou gera log");
  });
});

describe("emitirEventoRealtime — validação de entrada", () => {
  test("sem 'tipo' ou sem 'organizacaoId', não tenta publicar nada (evento genérico/sem dono é descartado, não mascarado)", async () => {
    const { fetchImpl, chamadas } = fetchFake();
    const logs = [];
    await emitirEventoRealtime({ organizacaoId: "org-1" }, { fetchImpl, log: (m, e) => logs.push({ m, e }) });
    await emitirEventoRealtime({ tipo: "x.y" }, { fetchImpl, log: (m, e) => logs.push({ m, e }) });
    assert.equal(chamadas.length, 0);
  });
});
