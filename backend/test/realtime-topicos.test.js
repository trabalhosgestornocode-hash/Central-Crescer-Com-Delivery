// Tópicos do Realtime (backend/src/modules/realtime/realtime.topicos.js) —
// função pura que decide quais canais um contexto pode assinar. Espelha
// exatamente a policy SQL proposta para `realtime.messages` (ainda não
// aplicada — ver a entrega da Etapa 1): as duas nunca podem divergir.
//
// Rodar: node --test test/realtime-topicos.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { topicoEmpresa, topicoUnidade, topicosAutorizados } from "../src/modules/realtime/realtime.topicos.js";

describe("realtime.topicos", () => {
  test("nomeia os tópicos com o prefixo de domínio, não um id cru", () => {
    assert.equal(topicoEmpresa("org-1"), "empresa:org-1");
    assert.equal(topicoUnidade("uni-1"), "unidade:uni-1");
  });

  test("contexto com unidade selecionada: autoriza unidade + empresa (Fase O — agregado também precisa saber)", () => {
    const t = topicosAutorizados({ organizacaoId: "org-1", unidadeId: "uni-1" });
    assert.deepEqual(t.sort(), ["empresa:org-1", "unidade:uni-1"].sort());
  });

  test("'Todas as unidades' (unidadeId nulo): só o tópico de empresa — não é acesso indiscriminado a unidades", () => {
    const t = topicosAutorizados({ organizacaoId: "org-1", unidadeId: null });
    assert.deepEqual(t, ["empresa:org-1"]);
  });

  test("unidadeId omitido tem o mesmo efeito que null", () => {
    const t = topicosAutorizados({ organizacaoId: "org-1" });
    assert.deepEqual(t, ["empresa:org-1"]);
  });

  test("sem organizacaoId, nenhum tópico é autorizado — nunca um canal 'órfão'", () => {
    assert.deepEqual(topicosAutorizados({ organizacaoId: null, unidadeId: "uni-1" }), []);
    assert.deepEqual(topicosAutorizados({}), []);
  });

  test("duas organizações diferentes nunca produzem o mesmo tópico de empresa", () => {
    const a = topicosAutorizados({ organizacaoId: "org-A" });
    const b = topicosAutorizados({ organizacaoId: "org-B" });
    assert.notDeepEqual(a, b);
  });

  test("o tópico de unidade nunca aparece sem o de empresa correspondente (agregado sempre coberto)", () => {
    const t = topicosAutorizados({ organizacaoId: "org-1", unidadeId: "uni-1" });
    assert.ok(t.includes(topicoEmpresa("org-1")));
    assert.ok(t.includes(topicoUnidade("uni-1")));
  });
});
