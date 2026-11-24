// MOVA CORE — §4: escalonamento Haiku → Sonnet decidido pelo SERVIDOR, só em homologação. Cliente SIMULADO (sem API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORG_A, UNI_A, USUARIO, UNIDADES, PERFIL_FIN, financeiroReal, usar, falar } from "./helpers.js";
import { criarMovaCore, criarOrcamentoMemoria } from "../../src/modules/mova-core/index.js";
import { configuracaoDeEscalonamento, decidirEscalonamento, mensagensParaEscalonar } from "../../src/modules/mova-core/escalonamento.js";

const HOJE = "2026-10-15";
const LIGADO = Object.freeze({ habilitado: true, modelo: "claude-sonnet-5-5", esforco: "medium", maxPassos: 4 });
/** cliente que responde por MODELO: cada modelo tem o seu roteiro; guarda os pedidos */
function clientePorModelo(roteiros) {
  const pedidos = []; const i = {};
  return { pedidos, messages: { async create(req) {
    pedidos.push(structuredClone(req));
    const chave = /sonnet/.test(req.model) ? "sonnet" : "haiku";
    const lista = roteiros[chave] ?? [[falar("ok")]];
    const passo = lista[Math.min(i[chave] = (i[chave] ?? -1) + 1, lista.length - 1)];
    const conteudo = typeof passo === "function" ? passo(req) : passo;
    return { model: req.model, stop_reason: conteudo.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content: conteudo,
      usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  } } };
}
async function montar(roteiros, escalonamento = LIGADO) {
  const f = await financeiroReal();
  await f.conta(23000, "2026-10-20", "Brownies outubro", "2026-10");
  const cliente = clientePorModelo(roteiros);
  const auditoria = [];
  const c = criarMovaCore({ porta: f.porta, cliente, orcamento: criarOrcamentoMemoria(), auditoria: { registrar: (x) => auditoria.push(x) }, escalonamento });
  const perguntar = (texto) => c.responder({ organizacaoId: ORG_A, conversaId: "g1", participanteId: "p1", usuarioId: USUARIO, unidadeId: UNI_A, unidadesPermitidas: UNIDADES, perfil: PERFIL_FIN, podeValores: true, texto, hoje: HOJE });
  return { cliente, auditoria, perguntar };
}
const CONSULTA = [usar("contas_a_pagar", { termo: "brownie", competencia: "2026-10" }, "a")];

test("ES-01 Haiku erra o número duas vezes ⇒ o servidor escala; o Sonnet recebe as consultas JÁ feitas (não repete) e a resposta conferida é a dele; custos somados", async () => {
  const k = await montar({ haiku: [CONSULTA, [falar("As contas de brownies somam R$ 320,00.")], [falar("São R$ 320,00 de brownies.")]], sonnet: [[falar("As contas de brownies de outubro somam R$ 230,00.")]] });
  const r = await k.perguntar("quanto deu brownie em outubro?");
  assert.equal(r.motivo, "RESPONDIDO", r.texto);
  assert.match(r.texto, /230,00/);
  assert.deepEqual([r.escalonamento.escalou, r.escalonamento.motivo, r.escalonamento.usouResposta, r.escalonamento.para], [true, "VERIFICADOR_REPROVOU", "ESCALONADA", "claude-sonnet-5-5"]);
  const pedidoSonnet = k.cliente.pedidos.find((p) => /sonnet/.test(p.model));
  const tudo = JSON.stringify(pedidoSonnet.messages);
  assert.ok(tudo.includes("tool_result") && !tudo.includes("320,00"), "o Sonnet vê a consulta, não as respostas reprovadas");
  assert.equal(k.cliente.pedidos.filter((p) => /sonnet/.test(p.model)).length, 1, "nenhuma leitura repetida");
  assert.ok(r.uso.custoMicrousd > r.escalonamento.custoPrincipalMicrousd);
  assert.ok(k.auditoria.some((x) => x.tipo === "MOVA_CORE_ESCALONAMENTO"));
});

test("ES-02 NUNCA escala: resposta boa; falta de dados (sem registros); desligado; escrita/proposta; Opus", async () => {
  const boa = await montar({ haiku: [CONSULTA, [falar("As contas de brownies de outubro somam R$ 230,00.")]] });
  const r1 = await boa.perguntar("quanto deu brownie em outubro?");
  assert.deepEqual([r1.motivo, r1.escalonamento.escalou, r1.escalonamento.motivo], ["RESPONDIDO", false, "RESPOSTA_SUFICIENTE"]);
  assert.equal(boa.cliente.pedidos.filter((p) => /sonnet/.test(p.model)).length, 0);

  const semDados = await montar({ haiku: [[usar("contas_a_pagar", { termo: "pastel", competencia: "2026-10" }, "z")], [falar("Gastamos R$ 999,00 com pastel.")], [falar("Foram R$ 999,00.")]] });
  const r2 = await semDados.perguntar("quanto gastamos com pastel em outubro?");
  assert.equal(r2.escalonamento.escalou, false, r2.escalonamento.motivo);
  assert.equal(r2.escalonamento.motivo, "FALTA_DE_DADOS");

  const desligado = await montar({ haiku: [CONSULTA, [falar("R$ 320,00")], [falar("R$ 320,00")]] }, null);
  const r3 = await desligado.perguntar("quanto deu brownie em outubro?");
  assert.equal(r3.escalonamento, undefined);
  assert.equal(desligado.cliente.pedidos.filter((p) => /sonnet/.test(p.model)).length, 0);

  assert.equal(decidirEscalonamento({ r: { motivo: "VERIFICADOR_REPROVOU", ferramentas: [{ nome: "preparar_operacao", ok: true }] }, sessao: {}, config: LIGADO }).motivo, "ESCRITA_OU_PROPOSTA");
  assert.equal(decidirEscalonamento({ r: { motivo: "VERIFICADOR_REPROVOU", ferramentas: [{ nome: "contas_a_pagar", ok: false, codigo: "FORA_DO_ESCOPO" }] }, sessao: {}, config: LIGADO }).motivo, "PERMISSAO_OU_REGRA");
  assert.equal(decidirEscalonamento({ r: { motivo: "VERIFICADOR_REPROVOU", ferramentas: [] }, sessao: {}, config: { ...LIGADO, modelo: "claude-opus-5-5" } }).motivo, "MODELO_NAO_PERMITIDO");
  assert.equal(decidirEscalonamento({ r: { motivo: "ORCAMENTO_ESGOTADO", ferramentas: [] }, sessao: {}, config: LIGADO }).escalar, false);
  assert.equal(decidirEscalonamento({ r: { motivo: "RESPONDIDO", ferramentas: [{ nome: "x", codigo: "ARGUMENTO_INVALIDO" }, { nome: "y", codigo: "REFERENCIA_INVALIDA" }] }, sessao: {}, config: LIGADO }).motivo, "ERROS_DE_ARGUMENTO");
});

test("ES-03 configuração: desligado por padrão; só Sonnet; NUNCA em produção", () => {
  assert.equal(configuracaoDeEscalonamento({}).habilitado, false);
  assert.equal(configuracaoDeEscalonamento({ MOVA_CORE_ESCALONAMENTO: "1" }).habilitado, true);
  assert.equal(configuracaoDeEscalonamento({ MOVA_CORE_ESCALONAMENTO: "1", MOVA_CORE_ESCALONAMENTO_MODELO: "claude-opus-5-5" }).habilitado, false);
  assert.equal(configuracaoDeEscalonamento({ MOVA_CORE_ESCALONAMENTO: "1", MOVA_AMBIENTE: "PRODUCAO" }).habilitado, false);
});

test("ES-04 o Sonnet também reprovado: fica a melhor resposta CONFERIDA (nunca uma não conferida), dentro do teto da requisição", async () => {
  const k = await montar({ haiku: [CONSULTA, [falar("R$ 320,00")], [falar("R$ 320,00")]], sonnet: [[falar("R$ 410,00")], [falar("R$ 410,00")]] });
  const r = await k.perguntar("quanto deu brownie em outubro?");
  assert.ok(!/320|410/.test(r.texto), r.texto);
  assert.equal(r.escalonamento.usouResposta, "PRINCIPAL");
  const msgs = mensagensParaEscalonar([{ role: "user", content: "pergunta" }, { role: "assistant", content: [{ type: "text", text: "errado" }] }, { role: "user", content: "[conferência automática] x" }], "VERIFICADOR_REPROVOU");
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0].content), /servidor/);
});
