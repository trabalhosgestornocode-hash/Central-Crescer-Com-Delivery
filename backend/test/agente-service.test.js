// Testes do loop de tool use + contexto conversacional + medição de custo do
// Agente Crescer — unit, com `provider`, `executarFerramentaFn`, `conversas`
// e `uso` INJETADOS (ver processarMensagem). Nenhuma chamada real à
// Anthropic e nenhuma leitura/escrita real em agente_conversas/
// agente_mensagens/agente_uso acontece aqui — os fakes abaixo reproduzem o
// MESMO contrato das versões reais (agente.conversas.service.js /
// agente.uso.service.js).
//
// Só o `auditar()` final grava uma linha real (inofensiva, sem FK) em
// plataforma_auditoria, mesmo padrão de outras suítes deste repo.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-service.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { processarMensagem, obterHistoricoConversa, MAX_TOOL_ITERATIONS } from "../src/modules/agente/agente.service.js";
import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG_ID = "77777777-7777-4777-8777-777777777777";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";
const OUTRA_UNIDADE_ID = "99999999-9999-4999-8999-999999999999";
const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "teste-agente@exemplo.invalido", nome: "Teste Automatizado" };
const OUTRO_USUARIO = { id: "55555555-5555-4555-8555-555555555555", email: "outro@exemplo.invalido", nome: "Outro Usuário" };
const ACESSO = { modulos: [], permissoes: [], impersonando: false, empresa: { nome: "Empresa Teste" }, unidade: null };

const respostaTexto = (texto, stop_reason = "end_turn", model = "claude-opus-5") =>
  ({ stop_reason, model, content: [{ type: "text", text: texto }], usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 } });
const respostaToolUse = (chamadas, model = "claude-opus-5") => ({
  stop_reason: "tool_use",
  model,
  content: chamadas.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} })),
  usage: { inputTokens: 80, outputTokens: 15, cacheCreationTokens: 0, cacheReadTokens: 0 },
});

function providerDeRespostas(respostas) {
  let i = 0;
  return {
    chamadas: [],
    async enviarMensagem(params) {
      this.chamadas.push(params);
      const r = respostas[Math.min(i, respostas.length - 1)];
      i++;
      return r;
    },
  };
}

/**
 * Fake em memória de agente.conversas.service.js — reproduz o MESMO contrato
 * de isolamento (usuario+organizacao+unidade juntos) da versão real em SQL.
 */
function conversasFake({ historicoMax = 12 } = {}) {
  const conversas = new Map(); // id -> {perfilId, organizacaoId, unidadeId}
  const mensagens = new Map(); // id -> [{papel, conteudo, toolsUtilizadas}]
  let seq = 0;
  return {
    HISTORICO_MAX_MENSAGENS: historicoMax,
    _conversas: conversas,
    _mensagens: mensagens,
    // Fase D: isolamento por PERFIL (era usuario_id/conta).
    async buscarConversa({ conversaId, perfilId, organizacaoId, unidadeId }) {
      if (!conversaId) return null;
      const c = conversas.get(conversaId);
      if (!c) return null;
      if (c.perfilId !== (perfilId ?? null) || c.organizacaoId !== organizacaoId || c.unidadeId !== (unidadeId ?? null)) return null;
      return { id: conversaId };
    },
    async criarConversa({ perfilId, organizacaoId, unidadeId }) {
      // Formato UUID de verdade (não "conv-1") — processarMensagem/
      // obterHistoricoConversa validam o formato via shared/validar.js#uuid,
      // igual fariam com um id real vindo do Supabase.
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      conversas.set(id, { perfilId: perfilId ?? null, organizacaoId, unidadeId: unidadeId ?? null });
      mensagens.set(id, []);
      return id;
    },
    async buscarMensagens(conversaId, limite = 100) {
      const lista = mensagens.get(conversaId) ?? [];
      return lista.slice(-limite);
    },
    async salvarMensagem({ conversaId, papel, conteudo, toolsUtilizadas = [], acoes = [] }) {
      const lista = mensagens.get(conversaId) ?? [];
      lista.push({ papel, conteudo, toolsUtilizadas, acoes, criadoEm: new Date().toISOString() });
      mensagens.set(conversaId, lista);
    },
  };
}

/** Fake em memória de agente.uso.service.js — só captura o que seria persistido. */
function usoFake() {
  const registros = [];
  return { registros, async registrarUso(params) { registros.push(params); } };
}

describe("processarMensagem — validação de entrada", () => {
  test("rejeita mensagem vazia sem chamar o provider", async () => {
    const provider = providerDeRespostas([respostaTexto("não deveria chegar aqui")]);
    await assert.rejects(
      () => processarMensagem({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO, mensagem: "", provider, conversas: conversasFake(), uso: usoFake() }),
    );
    assert.equal(provider.chamadas.length, 0);
  });

  test("rejeita conversationId em formato inválido", async () => {
    const provider = providerDeRespostas([respostaTexto("x")]);
    await assert.rejects(
      () => processarMensagem({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO, mensagem: "oi", conversationId: "não-é-uuid", provider, conversas: conversasFake(), uso: usoFake() }),
    );
    assert.equal(provider.chamadas.length, 0);
  });
});

describe("processarMensagem — loop de tool use", () => {
  test("resposta sem tool call: 1 chamada ao provider, sem tools utilizadas", async () => {
    const provider = providerDeRespostas([respostaTexto("Você está bem este mês.")]);
    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Como estou este mês?", provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.equal(r.resposta, "Você está bem este mês.");
    assert.deepEqual(r.metadata.toolsUtilizadas, []);
    assert.equal(provider.chamadas.length, 1);
    assert.ok(r.conversationId);
  });

  test("uma tool call: executa a tool, devolve o resultado e conclui com o texto final", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "consultar_dashboard_executivo", input: { mes: 8, ano: 2026 } }]),
      respostaTexto("Seu faturamento foi de R$ 10.000."),
    ]);
    const chamadasFerramenta = [];
    const executarFerramentaFn = async (nome, input, contexto) => {
      chamadasFerramenta.push({ nome, input, contexto });
      return { faturamento: 10000 };
    };

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Como estou este mês?", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.equal(r.resposta, "Seu faturamento foi de R$ 10.000.");
    assert.deepEqual(r.metadata.toolsUtilizadas, ["consultar_dashboard_executivo"]);
    assert.equal(provider.chamadas.length, 2);
    assert.equal(chamadasFerramenta.length, 1);
    assert.equal(chamadasFerramenta[0].contexto.organizacaoId, ORG_ID);
    assert.equal(chamadasFerramenta[0].contexto.unidadeId, UNIDADE_ID);

    const segundaChamada = provider.chamadas[1];
    const ultimaMensagem = segundaChamada.messages[segundaChamada.messages.length - 1];
    assert.equal(ultimaMensagem.role, "user");
    assert.equal(ultimaMensagem.content[0].type, "tool_result");
    assert.equal(ultimaMensagem.content[0].tool_use_id, "call_1");
  });

  test("múltiplas tool calls no mesmo turno: todas executadas, resultados agrupados numa única mensagem", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([
        { id: "call_1", name: "consultar_dashboard_executivo" },
        { id: "call_2", name: "consultar_diagnostico" },
      ]),
      respostaTexto("Resumo final."),
    ]);
    const nomesExecutados = [];
    const executarFerramentaFn = async (nome) => { nomesExecutados.push(nome); return { ok: true }; };

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Como estou e o que fazer?", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.deepEqual(r.metadata.toolsUtilizadas.sort(), ["consultar_dashboard_executivo", "consultar_diagnostico"].sort());
    assert.deepEqual(nomesExecutados.sort(), ["consultar_dashboard_executivo", "consultar_diagnostico"].sort());

    const segundaChamada = provider.chamadas[1];
    const ultimaMensagem = segundaChamada.messages[segundaChamada.messages.length - 1];
    assert.equal(ultimaMensagem.content.length, 2);
  });

  test("sem tool de navegação chamada: actions vem [] (nunca ausente do contrato)", async () => {
    const provider = providerDeRespostas([respostaTexto("Você gastou R$ 500 com entregadores.")]);
    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Quanto gastei com entregadores?", provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.deepEqual(r.actions, []);
  });

  test("sugerir_navegacao chamada: a action resolvida aparece em actions, mas NUNCA em toolsUtilizadas ('Consultou')", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([
        { id: "call_1", name: "consultar_parser_resumo" },
        { id: "call_2", name: "sugerir_navegacao", input: { target: "parser_cancelamentos" } },
      ]),
      respostaTexto("Existem 8 cancelamentos que precisam de revisão."),
    ]);
    const acaoResolvida = { type: "navigate", target: "parser_cancelamentos", label: "Abrir Cancelamentos", params: {} };
    const executarFerramentaFn = async (nome) => (nome === "sugerir_navegacao" ? { sugerida: true, action: acaoResolvida } : { ok: true });

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Quais cancelamentos precisam de atenção?", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.deepEqual(r.actions, [acaoResolvida]);
    assert.deepEqual(r.metadata.toolsUtilizadas, ["consultar_parser_resumo"]); // sugerir_navegacao NUNCA aparece aqui
  });

  test("tool de navegação recusa a sugestão (sugerida: false): actions continua vazio, sem erro", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "sugerir_navegacao", input: { target: "ingredients" } }]),
      respostaTexto("Ok."),
    ]);
    const executarFerramentaFn = async () => ({ sugerida: false });

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.metadata.toolsUtilizadas, []);
  });

  test("máximo de MAX_ACOES_SUGERIDAS (3) actions, mesmo se o modelo tentar sugerir mais", async () => {
    const chamadasNavegacao = Array.from({ length: 5 }, (_, i) => ({ id: `call_${i}`, name: "sugerir_navegacao", input: { target: "dashboard_executivo" } }));
    const provider = providerDeRespostas([
      respostaToolUse(chamadasNavegacao),
      respostaTexto("Ok."),
    ]);
    const executarFerramentaFn = async () => ({ sugerida: true, action: { type: "navigate", target: "dashboard_executivo", label: "Abrir Dashboard Executivo", params: {} } });

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.equal(r.actions.length, 3);
  });

  test("actions são persistidas junto da mensagem 'assistant' (pra reaparecer ao reidratar)", async () => {
    const conversas = conversasFake();
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "sugerir_navegacao", input: { target: "products_cmv" } }]),
      respostaTexto("Veja os produtos com maior CMV."),
    ]);
    const acao = { type: "navigate", target: "products_cmv", label: "Abrir Produtos / CMV", params: {} };
    const executarFerramentaFn = async () => ({ sugerida: true, action: acao });

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Meu CMV está alto?", provider, executarFerramentaFn, conversas, uso: usoFake(),
    });

    const salvas = await conversas.buscarMensagens(r.conversationId, 100);
    const mensagemAgente = salvas.find((m) => m.papel === "assistant");
    assert.deepEqual(mensagemAgente.acoes, [acao]);
    const mensagemUsuario = salvas.find((m) => m.papel === "user");
    assert.deepEqual(mensagemUsuario.acoes, []); // nunca em mensagens do usuário
  });

  test("erro de tool não derruba a resposta — volta como tool_result com is_error", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "consultar_dashboard_executivo" }]),
      respostaTexto("Não consegui consultar os dados agora."),
    ]);
    const executarFerramentaFn = async () => { throw new Error("falha simulada na tool"); };

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Como estou este mês?", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.equal(r.resposta, "Não consegui consultar os dados agora.");
    const segundaChamada = provider.chamadas[1];
    const toolResult = segundaChamada.messages[segundaChamada.messages.length - 1].content[0];
    assert.equal(toolResult.is_error, true);
  });

  test("limite de iterações: interrompe de forma controlada e lança erro apropriado", async () => {
    const sempreToolUse = { stop_reason: "tool_use", model: "claude-opus-5", content: [{ type: "tool_use", id: "loop", name: "consultar_dashboard_executivo", input: {} }], usage: {} };
    const provider = providerDeRespostas([sempreToolUse]);
    const executarFerramentaFn = async () => ({ ok: true });

    await assert.rejects(
      () => processarMensagem({
        organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
        mensagem: "Pergunta qualquer", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
      }),
      /limite de consultas/,
    );
    assert.equal(provider.chamadas.length, MAX_TOOL_ITERATIONS);
  });

  test("read-only continua obrigatório mesmo com histórico presente", async () => {
    const conversas = conversasFake();
    const provider = providerDeRespostas([respostaTexto("Esta versão não tem permissão para alterar metas.")]);
    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Aumente minha meta para R$ 180 mil.", provider, conversas, uso: usoFake(),
    });
    assert.match(r.resposta, /não tem permissão|não altera|não pode/i);
    assert.deepEqual(r.metadata.toolsUtilizadas, []);
  });
});

describe("processarMensagem — medição de uso/custo (Fase 1.6)", () => {
  test("registra tenant/usuário corretos, sempre do CONTEXTO — nunca influenciáveis pelo usuário", async () => {
    const uso = usoFake();
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso,
    });
    assert.equal(uso.registros.length, 1);
    assert.equal(uso.registros[0].organizacaoId, ORG_ID);
    assert.equal(uso.registros[0].unidadeId, UNIDADE_ID);
    assert.equal(uso.registros[0].usuarioId, USUARIO.id);
  });

  test("soma o usage de TODAS as chamadas da interação (não só a última) e persiste modelo/tools/duração", async () => {
    const uso = usoFake();
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "consultar_dashboard_executivo" }]),
      respostaToolUse([{ id: "call_2", name: "consultar_diagnostico" }]),
      respostaTexto("Resumo final."),
    ]);
    const executarFerramentaFn = async () => ({ ok: true });

    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "pergunta com 2 tools", provider, executarFerramentaFn, conversas: conversasFake(), uso,
    });

    const r = uso.registros[0];
    // 2 chamadas de tool_use (80/15 cada) + 1 final (100/20) = 260 input, 50 output.
    assert.equal(r.inputTokens, 80 + 80 + 100);
    assert.equal(r.outputTokens, 15 + 15 + 20);
    assert.equal(r.model, "claude-opus-5");
    assert.deepEqual(r.toolsUsed.sort(), ["consultar_dashboard_executivo", "consultar_diagnostico"].sort());
    assert.equal(r.toolCallsCount, 2);
    assert.equal(r.success, true);
    assert.ok(r.durationMs >= 0);
    assert.ok(Number.isFinite(r.estimatedCostUsd));
  });

  test("erro APÓS a primeira chamada (já com tokens consumidos) ainda registra o usage real, com success: false", async () => {
    const uso = usoFake();
    // Sempre pede tool_use e nunca conclui -> estoura MAX_TOOL_ITERATIONS,
    // mas cada chamada consumiu tokens de verdade antes do erro final.
    const sempreToolUse = { stop_reason: "tool_use", model: "claude-opus-5", content: [{ type: "tool_use", id: "loop", name: "consultar_dashboard_executivo", input: {} }], usage: { inputTokens: 50, outputTokens: 10 } };
    const provider = providerDeRespostas([sempreToolUse]);
    const executarFerramentaFn = async () => ({ ok: true });

    await assert.rejects(() => processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "pergunta", provider, executarFerramentaFn, conversas: conversasFake(), uso,
    }));

    assert.equal(uso.registros.length, 1);
    const r = uso.registros[0];
    assert.equal(r.success, false);
    assert.ok(r.errorCode);
    // MAX_TOOL_ITERATIONS chamadas de 50 tokens cada, não zero.
    assert.equal(r.inputTokens, 50 * MAX_TOOL_ITERATIONS);
    assert.ok(r.inputTokens > 0);
  });

  test("modelo desconhecido não derruba o registro — custo vem null, resto da métrica intacto", async () => {
    const uso = usoFake();
    const provider = providerDeRespostas([respostaTexto("ok", "end_turn", "modelo-futuro-desconhecido")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso,
    });
    assert.equal(uso.registros[0].model, "modelo-futuro-desconhecido");
    assert.equal(uso.registros[0].estimatedCostUsd, null);
    assert.equal(uso.registros[0].inputTokens, 100); // usage continua medido normalmente
  });

  test("uma pergunta sem tool call registra toolCallsCount 0 e toolsUsed vazio", async () => {
    const uso = usoFake();
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso,
    });
    assert.equal(uso.registros[0].toolCallsCount, 0);
    assert.deepEqual(uso.registros[0].toolsUsed, []);
  });
});

describe("processarMensagem — contexto conversacional (Fase 1.5)", () => {
  test("primeira mensagem cria uma conversa nova", async () => {
    const conversas = conversasFake();
    const provider = providerDeRespostas([respostaTexto("Em agosto você gastou R$ 500 com entregadores.")]);
    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Quanto gastei com entregadores em agosto?", provider, conversas, uso: usoFake(),
    });
    assert.ok(conversas._conversas.has(r.conversationId));
  });

  test("segunda mensagem com o mesmo conversationId recupera o histórico — resolve 'e no dia 4?'", async () => {
    const conversas = conversasFake();
    const provider1 = providerDeRespostas([respostaTexto("Em agosto de 2026 você gastou R$ 500 com taxas de entregadores.")]);
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Quanto gastei com entregadores em agosto?", provider: provider1, conversas, uso: usoFake(),
    });

    const provider2 = providerDeRespostas([respostaTexto("No dia 04/08/2026 você gastou R$ 20 com entregadores.")]);
    const r2 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "E no dia 4?", conversationId: r1.conversationId, provider: provider2, conversas, uso: usoFake(),
    });

    assert.equal(r2.conversationId, r1.conversationId);
    // A 2ª chamada ao provider precisa carregar o histórico do 1º turno —
    // é isso que permite Claude resolver "taxas de entregadores"/"agosto"/
    // "2026" sem o usuário repetir tudo.
    const mensagensEnviadas = provider2.chamadas[0].messages;
    const textoHistorico = JSON.stringify(mensagensEnviadas);
    assert.ok(textoHistorico.includes("entregadores em agosto"), "histórico do usuário deveria estar presente");
    assert.ok(textoHistorico.includes("agosto de 2026"), "resposta anterior do agente deveria estar presente (carrega o período)");
    // Nunca reenvia blocos de tool_use/tool_result de turnos ANTERIORES —
    // só o texto final de cada lado.
    assert.ok(mensagensEnviadas.every((m) => typeof m.content === "string"));
  });

  test("conversa NÃO pode ser acessada por outro usuário — vira uma conversa nova, nunca um erro que revele a diferença", async () => {
    const conversas = conversasFake();
    const provider1 = providerDeRespostas([respostaTexto("resposta 1")]);
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "primeira pergunta", provider: provider1, conversas, uso: usoFake(),
    });

    const provider2 = providerDeRespostas([respostaTexto("resposta 2")]);
    const r2 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: OUTRO_USUARIO,
      mensagem: "tentando usar a conversa de outro usuário", conversationId: r1.conversationId, provider: provider2, conversas, uso: usoFake(),
    });

    assert.notEqual(r2.conversationId, r1.conversationId);
    // O histórico enviado ao provider não deve conter a pergunta do outro usuário.
    const mensagensEnviadas = provider2.chamadas[0].messages;
    assert.equal(mensagensEnviadas.length, 1);
    assert.equal(mensagensEnviadas[0].content, "tentando usar a conversa de outro usuário");
  });

  test("conversa NÃO atravessa organização", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "primeira pergunta", provider: providerDeRespostas([respostaTexto("r1")]), conversas, uso: usoFake(),
    });
    const r2 = await processarMensagem({
      organizacaoId: OUTRA_ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "outra organização", conversationId: r1.conversationId, provider: providerDeRespostas([respostaTexto("r2")]), conversas, uso: usoFake(),
    });
    assert.notEqual(r2.conversationId, r1.conversationId);
  });

  test("conversa NÃO atravessa unidade", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "primeira pergunta", provider: providerDeRespostas([respostaTexto("r1")]), conversas, uso: usoFake(),
    });
    const r2 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: OUTRA_UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "outra unidade", conversationId: r1.conversationId, provider: providerDeRespostas([respostaTexto("r2")]), conversas, uso: usoFake(),
    });
    assert.notEqual(r2.conversationId, r1.conversationId);
  });

  test("'limpar conversa' (conversationId ausente) gera um novo contexto, mesmo tenant", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "primeira conversa", provider: providerDeRespostas([respostaTexto("r1")]), conversas, uso: usoFake(),
    });
    const r2 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "nova conversa depois de limpar", conversationId: null, provider: providerDeRespostas([respostaTexto("r2")]), conversas, uso: usoFake(),
    });
    assert.notEqual(r2.conversationId, r1.conversationId);
    // A conversa nova não carrega nada da anterior.
    const mensagensEnviadas = (await conversas.buscarMensagens(r2.conversationId, 100));
    assert.equal(mensagensEnviadas.length, 2); // só o par (user, assistant) desta própria conversa
  });

  test("histórico respeita o limite configurado (HISTORICO_MAX_MENSAGENS)", async () => {
    const conversas = conversasFake({ historicoMax: 2 }); // só a última pergunta+resposta
    // Semeia 3 turnos completos direto no fake (6 mensagens).
    const conversaId = await conversas.criarConversa({ perfilId: USUARIO.id, organizacaoId: ORG_ID, unidadeId: UNIDADE_ID });
    for (let i = 1; i <= 3; i++) {
      await conversas.salvarMensagem({ conversaId, papel: "user", conteudo: `pergunta ${i}` });
      await conversas.salvarMensagem({ conversaId, papel: "assistant", conteudo: `resposta ${i}` });
    }

    const provider = providerDeRespostas([respostaTexto("resposta 4")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "pergunta 4", conversationId: conversaId, provider, conversas, uso: usoFake(),
    });

    const mensagensEnviadas = provider.chamadas[0].messages;
    // limite=2 (histórico) + a mensagem nova desta requisição = 3.
    assert.equal(mensagensEnviadas.length, 3);
    assert.equal(mensagensEnviadas[0].content, "pergunta 3");
    assert.equal(mensagensEnviadas[1].content, "resposta 3");
    assert.equal(mensagensEnviadas[2].content, "pergunta 4");
  });

  test("Fase 2A: 'Qual o CMV do BMT?' / 'E do Frango Teriyaki?' / 'Qual dos dois é maior?' — contexto de produto continua funcionando", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Qual o CMV do BMT?",
      provider: providerDeRespostas([respostaTexto("O BMT 15cm tem CMV de 29,16%.")]),
      conversas, uso: usoFake(),
    });
    const r2 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "E do Frango Teriyaki?", conversationId: r1.conversationId,
      provider: providerDeRespostas([respostaTexto("O Frango Teriyaki tem CMV de 24,50%.")]),
      conversas, uso: usoFake(),
    });
    const provider3 = providerDeRespostas([respostaTexto("O BMT está com CMV pior (29,16% contra 24,50%).")]);
    const r3 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Qual dos dois é maior?", conversationId: r2.conversationId, provider: provider3, conversas, uso: usoFake(),
    });

    assert.equal(r3.conversationId, r1.conversationId);
    // A 3ª chamada precisa carregar as DUAS respostas anteriores — é isso
    // que permite Claude comparar sem o usuário repetir os nomes/valores.
    const textoHistorico = JSON.stringify(provider3.chamadas[0].messages);
    assert.ok(textoHistorico.includes("CMV de 29,16%"), "resposta do BMT deveria estar no histórico");
    assert.ok(textoHistorico.includes("CMV de 24,50%"), "resposta do Frango Teriyaki deveria estar no histórico");
  });

  test("Fase 2A: cruzamento Dashboard + Produtos/CMV numa mesma pergunta — loop suporta tools de módulos diferentes juntas", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([
        { id: "call_1", name: "consultar_dashboard_executivo" },
        { id: "call_2", name: "listar_produtos_cmv", input: { ordenarPor: "cmv_percentual", ordem: "desc", limite: 5 } },
      ]),
      respostaTexto("Entre os produtos cadastrados, alguns têm CMV mais alto — mas não dá pra afirmar que causam o CMV total sem saber o volume vendido."),
    ]);
    const nomesExecutados = [];
    const executarFerramentaFn = async (nome) => { nomesExecutados.push(nome); return { ok: true }; };

    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Meu CMV está alto. Quais produtos devo observar?", provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    assert.deepEqual(nomesExecutados.sort(), ["consultar_dashboard_executivo", "listar_produtos_cmv"].sort());
    assert.deepEqual(r.metadata.toolsUtilizadas.sort(), ["consultar_dashboard_executivo", "listar_produtos_cmv"].sort());
    // A afirmação de causalidade em si é comportamento do modelo (prompt) —
    // validado manualmente; aqui garantimos só que o mecanismo (2 tools de
    // módulos diferentes na mesma pergunta) funciona de ponta a ponta.
  });
});

describe("processarMensagem — catálogo de tools filtrado por acesso (Etapa B)", () => {
  test("acesso sem nenhum módulo -> Claude recebe catálogo de tools VAZIO", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO /* modulos: [] */, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.deepEqual(provider.chamadas[0].tools, []);
  });

  test("acesso só com Produtos/CMV -> Claude só recebe as tools desse módulo, nunca as do Dashboard iFood", async () => {
    const acesso = { ...ACESSO, modulos: [MODULOS.PRODUTOS_CMV], permissoes: [PERMISSOES.CMV_VER] };
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    const nomes = provider.chamadas[0].tools.map((t) => t.name).sort();
    assert.deepEqual(nomes, ["consultar_produto_cmv", "listar_produtos_cmv"]);
  });

  test("impersonando -> catálogo completo mesmo com acesso.modulos vazio", async () => {
    const acesso = { ...ACESSO, modulos: [], permissoes: [], impersonando: true };
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.equal(provider.chamadas[0].tools.length, 13); // + consultar_checklist_operacional (Checklist 2.0)
  });

  test("acesso só com Insumos -> Claude só recebe as tools desse módulo (Etapa C)", async () => {
    const acesso = { ...ACESSO, modulos: [MODULOS.INGREDIENTS], permissoes: [PERMISSOES.INSUMOS_VER] };
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    const nomes = provider.chamadas[0].tools.map((t) => t.name).sort();
    assert.deepEqual(nomes, ["consultar_insumo", "listar_insumos"]);
  });

  test("acesso só com Parser Food Delivery -> Claude só recebe as tools desse módulo (Etapa D)", async () => {
    const acesso = { ...ACESSO, modulos: [MODULOS.PARSER_FOOD_DELIVERY], permissoes: [PERMISSOES.PARSER_FD_VER] };
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    const nomes = provider.chamadas[0].tools.map((t) => t.name).sort();
    assert.deepEqual(nomes, ["consultar_cancelamento", "consultar_parser_resumo", "listar_cancelamentos"]);
  });
});

describe("processarMensagem — pageContext (Etapa B/F: fundação + frontend conectado)", () => {
  test("pageContext válido aparece no system prompt como texto informativo", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", pageContext: { module: "dashboard_executivo", year: 2026, month: 8 },
      provider, conversas: conversasFake(), uso: usoFake(),
    });
    const system = provider.chamadas[0].system;
    assert.ok(system.includes("Página atual: Dashboard Executivo."), "prompt deveria descrever a página atual");
    assert.ok(system.includes("08/2026"));
    assert.ok(/informativo/i.test(system), "prompt deveria deixar claro que não é fonte de dado");
  });

  test("pageContext ausente -> prompt não menciona 'Página atual'", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.equal(provider.chamadas[0].system.includes("Página atual"), false);
  });

  test("pageContext malformado (module desconhecido) -> ignorado silenciosamente, mensagem funciona normalmente", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    const r = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", pageContext: { module: "modulo-inventado" },
      provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.equal(r.resposta, "ok");
    assert.equal(provider.chamadas[0].system.includes("Página atual"), false);
  });

  test("pageContext malicioso (tenta forjar organizacaoId/unidadeId de outro tenant) NUNCA influencia o tenant real", async () => {
    const provider = providerDeRespostas([
      respostaToolUse([{ id: "call_1", name: "consultar_dashboard_executivo" }]),
      respostaTexto("ok"),
    ]);
    const chamadasFerramenta = [];
    const executarFerramentaFn = async (nome, input, contexto) => { chamadasFerramenta.push(contexto); return { ok: true }; };

    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi",
      pageContext: {
        module: "dashboard_executivo",
        organizacaoId: OUTRA_ORG_ID, unidadeId: OUTRA_UNIDADE_ID, userId: OUTRO_USUARIO.id,
        role: "organization_admin", permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_EXCLUIR],
      },
      provider, executarFerramentaFn, conversas: conversasFake(), uso: usoFake(),
    });

    // O tenant/acesso usado pela tool continua sendo o REAL (do backend), nunca o forjado.
    assert.equal(chamadasFerramenta[0].organizacaoId, ORG_ID);
    assert.equal(chamadasFerramenta[0].unidadeId, UNIDADE_ID);
    // E nada do que foi forjado vaza pro texto que Claude recebe.
    const system = provider.chamadas[0].system;
    assert.equal(system.includes(OUTRA_ORG_ID), false);
    assert.equal(system.includes(OUTRA_UNIDADE_ID), false);
    assert.equal(system.includes("organization_admin"), false);
  });

  test("pageContext com productName -> aparece no prompt como texto entre aspas, nunca tratado como id/prova de dado", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "o que pesa mais no custo dele?", pageContext: { module: "products_cmv", productName: "BMT 15cm" },
      provider, conversas: conversasFake(), uso: usoFake(),
    });
    assert.ok(provider.chamadas[0].system.includes('"BMT 15cm"'));
  });

  test("pageContext com orderNumber (Parser) -> aparece no prompt e orienta o campo da tool", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "por que recebe taxa?", pageContext: { module: "parser_food_delivery", orderNumber: "5912" },
      provider, conversas: conversasFake(), uso: usoFake(),
    });
    const system = provider.chamadas[0].system;
    assert.ok(system.includes('"5912"'));
    assert.ok(/numeroPedido/.test(system));
  });
});

describe("processarMensagem — limites do agente / módulos não elegíveis (Etapa E)", () => {
  test("o prompt orienta transparência sobre módulos ainda não habilitados, nunca 'o Crescer não possui'", async () => {
    const provider = providerDeRespostas([respostaTexto("ok")]);
    await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "como está minha bonificação este mês?", provider, conversas: conversasFake(), uso: usoFake(),
    });
    const system = provider.chamadas[0].system;
    assert.ok(/fonte confiável/i.test(system));
    assert.ok(/Bonifica..o Mensal/.test(system));
    assert.ok(/NUNCA diga que o Crescer "não possui"/.test(system));
  });
});

describe("obterHistoricoConversa", () => {
  test("devolve as mensagens para o dono da conversa", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider: providerDeRespostas([respostaTexto("olá!")]), conversas, uso: usoFake(),
    });

    const historico = await obterHistoricoConversa({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, usuario: USUARIO, conversationId: r1.conversationId, conversas,
    });

    assert.equal(historico.conversationId, r1.conversationId);
    assert.equal(historico.mensagens.length, 2);
    assert.equal(historico.mensagens[0].papel, "user");
    assert.equal(historico.mensagens[1].papel, "assistant");
  });

  test("reidratação (Etapa F.1): actions da mensagem 'assistant' reaparecem no histórico", async () => {
    const conversas = conversasFake();
    const acao = { type: "navigate", target: "parser_cancelamentos", label: "Abrir Cancelamentos", params: {} };
    const executarFerramentaFn = async () => ({ sugerida: true, action: acao });
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "Quais cancelamentos precisam de atenção?",
      provider: providerDeRespostas([
        respostaToolUse([{ id: "call_1", name: "sugerir_navegacao", input: { target: "parser_cancelamentos" } }]),
        respostaTexto("Existem 8 cancelamentos em revisão."),
      ]),
      executarFerramentaFn, conversas, uso: usoFake(),
    });

    const historico = await obterHistoricoConversa({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, usuario: USUARIO, conversationId: r1.conversationId, conversas,
    });
    const mensagemAgente = historico.mensagens.find((m) => m.papel === "assistant");
    assert.deepEqual(mensagemAgente.actions, [acao]);
  });

  test("404 (não encontrada) para usuário diferente do dono", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider: providerDeRespostas([respostaTexto("olá!")]), conversas, uso: usoFake(),
    });
    await assert.rejects(
      () => obterHistoricoConversa({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, usuario: OUTRO_USUARIO, conversationId: r1.conversationId, conversas }),
      /não encontrada/i,
    );
  });

  test("404 (não encontrada) para organização diferente", async () => {
    const conversas = conversasFake();
    const r1 = await processarMensagem({
      organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO, usuario: USUARIO,
      mensagem: "oi", provider: providerDeRespostas([respostaTexto("olá!")]), conversas, uso: usoFake(),
    });
    await assert.rejects(
      () => obterHistoricoConversa({ organizacaoId: OUTRA_ORG_ID, unidadeId: UNIDADE_ID, usuario: USUARIO, conversationId: r1.conversationId, conversas }),
      /não encontrada/i,
    );
  });

  test("rejeita conversationId em formato inválido", async () => {
    await assert.rejects(
      () => obterHistoricoConversa({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, usuario: USUARIO, conversationId: "abc", conversas: conversasFake() }),
    );
  });
});
