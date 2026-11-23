// Execução 17 — provedor da IDENTIDADE OPERACIONAL do MOVA (fv2-integracao/operacionalMova.js), em memória e sintético.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO_AMPLA_TESTE, ESCOPO, montarProvedor } from "./helpers/operacionalTeste.js";

test("operacional — cada chamada roda no contexto de automação próprio; só a própria identidade; perfis enxutos aceitos", async () => {
  const { provedor, rodadas, IDENT } = montarProvedor({ acoes: ["financeiro_v2.ver", "financeiro_v2.enviar_documento", "financeiro_v2.baixar_por_comprovante"] });
  const { nucleo, concessoes } = await provedor({ identidade: IDENT, escopos: [ESCOPO] });
  const [c] = await concessoes.listar({ organizacaoId: ESCOPO.organizacaoId, usuarioId: IDENT });
  assert.deepEqual(c.acoes.sort(), ["financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.ver"]);
  assert.deepEqual(await concessoes.listar({ organizacaoId: ESCOPO.organizacaoId, usuarioId: "eeeeeeee-0000-4000-8000-000000000099" }), [], "outra identidade não é listada");
  const antes = rodadas.n;
  await nucleo.consultarContasAPagar({ ...ESCOPO, usuarioId: IDENT, permissoes: ["financeiro_v2.ver"] }, {}).catch(() => {});
  assert.ok(rodadas.n > antes, "a chamada ao núcleo passa pelo contexto de automação");
});

test("operacional — concessão com ação AMPLA é tratada como ausente (falha fechada)", async () => {
  const { provedor, IDENT } = montarProvedor({ acoes: ["financeiro_v2.ver", "financeiro_v2.baixar_por_comprovante", ACAO_AMPLA_TESTE] });
  const { concessoes } = await provedor({ identidade: IDENT, escopos: [ESCOPO] });
  const [c] = await concessoes.listar({ organizacaoId: ESCOPO.organizacaoId, usuarioId: IDENT });
  assert.deepEqual([c.acoes, c.recusada], [[], "ACAO_AMPLA_NA_CONCESSAO"]);
});
