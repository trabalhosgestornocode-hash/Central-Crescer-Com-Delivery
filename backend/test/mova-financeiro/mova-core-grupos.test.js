// MOVA CORE nos GRUPOS autorizados (25/11) pelo PIPELINE real (receptor → fila → motor atual → saída), banco do MOVA no
// PostgreSQL isolado e Financeiro v2 em memória. Só o modelo é simulado. Nenhum dado real.
// Prova: o núcleo só atende o grupo da LISTA do núcleo e só mensagem que chamou o MOVA; valores no grupo só pela regra do motor
// atual (membros comprovados); unidade citada de OUTRA conversa nunca vira resposta de outra unidade em silêncio; o motor atual
// continua com o resto (e é o rollback).
import assert from "node:assert/strict";
import { CONFIG, FIN, GRUPO, OPER, SO_ALFA, ALFA, BETA, cenario, gw, t } from "./helpers/operacao.js";
import { criarOrcamentoIa } from "../../src/modules/mova-financeiro/index.js";
import { ACAO } from "../../src/modules/financeiro-v2/index.js";
import { montarConversaCore, montarOperacoesDaConversa } from "../../src/modules/fv2-integracao/movaCoreConversa.js";
import { configuracaoDaConversa, MODO_CONVERSA, MODO_OPERACOES } from "../../src/modules/mova-core/conversaWhatsapp.js";

const usar = (name, input = {}, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: "tool_use", id, name, input });
const falar = (text) => ({ type: "text", text });
function iaComRoteiro(roteiro) {
  const pedidos = []; let i = 0;
  return { pedidos, criar: () => ({ messages: {
    async create(req) {
      pedidos.push(req);
      const content = roteiro[Math.min(i++, roteiro.length - 1)];
      return { model: req.model, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content, usage: { input_tokens: 1500, output_tokens: 120 } };
    },
    async countTokens() { return { input_tokens: 1500 }; },
  } }) };
}
async function montar({ grupos = [], roteiro = [[falar("ok")]] } = {}) {
  const holder = { real: null };
  const eventos = [];
  const s = await cenario({ extras: () => ({ conversaNova: { atender: async (x) => (holder.real ? holder.real.atender(x) : null) } }) });
  await s.conta("2026-10-20", 12345, ALFA);
  const ia = iaComRoteiro(roteiro);
  holder.real = await montarConversaCore({ conversaCore: { modo: MODO_CONVERSA.RESPOSTA, unidades: [ALFA, BETA], grupos }, servicoUsuarioId: CONFIG.identidadeServico.usuarioId,
    configuracao: s.mova.cfg, porta: s.mova.porta, acaoVer: ACAO.VER, orcamento: criarOrcamentoIa({ pool: s.banco.pool }), criarClienteIa: ia.criar, registrar: (e) => eventos.push(e),
    relogio: () => new Date("2026-10-15T12:00:00Z"), armazenamento: s.mova.armazenamento });
  return { ...s, ia, eventos };
}
const ferramentasPedidas = (req) => (req.tools ?? []).map((x) => x.name);

t("MCG-01 grupo FORA da lista do núcleo: o núcleo não é chamado (o motor atual responde como antes)", async () => {
  const s = await montar({ grupos: [], roteiro: [[usar("contas_a_pagar", {})], [falar("Você tem 1 conta.")]] });
  await s.enviar(gw({ texto: "mova, contas a pagar da alfa", grupo: GRUPO, de: FIN }));
  assert.equal(s.ia.pedidos.length, 0);
  assert.ok((await s.saida()).length >= 1, "o motor atual respondeu");
});

t("MCG-02 grupo DA lista: só mensagem que chama o MOVA chega ao núcleo; sem membros comprovados, valor NÃO sai no grupo (BLOQUEADO)", async () => {
  const s = await montar({ grupos: [GRUPO], roteiro: [[usar("contas_a_pagar", {})], [falar("Os valores eu te mando no privado; aqui no grupo não mostro valores.")]] });
  await s.enviar(gw({ texto: "bom dia pessoal, alguém viu o boleto?", grupo: GRUPO, de: FIN })); // não chamou o MOVA
  assert.equal(s.ia.pedidos.length, 0, "conversa do grupo que não chamou o MOVA não vai ao núcleo");
  await s.enviar(gw({ texto: "mova, quanto temos a pagar na alfa?", grupo: GRUPO, de: FIN }));
  assert.ok(s.ia.pedidos.length >= 1, "chamou o MOVA: o núcleo atende");
  const resultado = JSON.stringify(s.ia.pedidos.at(-1).messages);
  assert.match(resultado, /SEM_PERMISSAO_PARA_VALORES/, "o executor recusou valores no grupo sem membros comprovados");
  assert.doesNotMatch(resultado, /123,45|12345/, "nenhum valor chegou ao modelo");
  const saida = await s.saida();
  assert.ok(saida.every((m) => !/123,45/.test(m.texto)), "nenhum valor no grupo");
});

t("MCG-03 isolamento entre conversas: a memória do núcleo é por conversa e pessoa (o grupo não vê o histórico do privado)", async () => {
  const s = await montar({ grupos: [GRUPO], roteiro: [[falar("Certo.")]] });
  await s.enviar(gw({ texto: "anota: o fornecedor preferido é a Doce Brownie", grupo: FIN, de: FIN }));
  await s.enviar(gw({ texto: "mova, qual é o fornecedor preferido?", grupo: GRUPO, de: FIN }));
  const ultimo = JSON.stringify(s.ia.pedidos.at(-1).messages);
  assert.doesNotMatch(ultimo, /Doce Brownie/, "o turno do privado não aparece no grupo");
});

t("MCG-04 mensagem no grupo/conversa ERRADO: unidade citada que a pessoa não alcança aqui ⇒ o núcleo não responde por outra unidade", async () => {
  const s = await montar({ grupos: [GRUPO], roteiro: [[usar("contas_a_pagar", {})], [falar("Na Loja Alfa: 1 conta.")]] });
  await s.enviar(gw({ texto: "quanto tenho a pagar na beta?", grupo: SO_ALFA, de: SO_ALFA })); // SO_ALFA só alcança a Alfa
  assert.equal(s.ia.pedidos.length, 0, "não respondeu sobre a Alfa quando a pergunta era da Beta");
  assert.ok(s.eventos.some((e) => e.tipo === "MOVA_CORE_CONVERSA_FORA" && e.motivo === "UNIDADE_DE_OUTRA_CONVERSA"));
  assert.ok((await s.saida()).length >= 1, "o motor atual respondeu");
});

t("MCG-05 participante sem valores (OPERACIONAL) no grupo da lista: o núcleo atende só sem valores e sem escrita", async () => {
  const s = await montar({ grupos: [GRUPO], roteiro: [[usar("contas_a_pagar", {})], [falar("Não consigo mostrar valores para o seu perfil.")]] });
  await s.enviar(gw({ texto: "mova, quanto temos a pagar?", grupo: GRUPO, de: OPER }));
  if (s.ia.pedidos.length) {
    assert.match(JSON.stringify(s.ia.pedidos.at(-1).messages), /SEM_PERMISSAO_PARA_VALORES/);
    assert.ok(!ferramentasPedidas(s.ia.pedidos[0]).includes("preparar_operacao"), "sem operações montadas, nenhuma ferramenta de escrita");
  }
  assert.ok((await s.saida()).every((m) => !/123,45/.test(m.texto)));
});

t("MCG-06 configuração: grupos e operações pelo ambiente; inválido ⇒ desligado; operações sem a migração 0020 ⇒ só consulta", () => {
  const c = configuracaoDaConversa({ MOVA_CORE_CONVERSA: "RESPOSTA", MOVA_CORE_CONVERSA_UNIDADES: ALFA, MOVA_CORE_CONVERSA_GRUPOS: `${GRUPO}, nao-e-grupo`, MOVA_CORE_OPERACOES: "EXECUTAR" });
  assert.deepEqual([c.grupos, c.operacoes], [[GRUPO], MODO_OPERACOES.EXECUTAR]);
  assert.equal(configuracaoDaConversa({ MOVA_CORE_CONVERSA: "RESPOSTA", MOVA_CORE_CONVERSA_UNIDADES: ALFA, MOVA_CORE_OPERACOES: "sim" }).operacoes, MODO_OPERACOES.DESLIGADO);
  assert.equal(configuracaoDaConversa({ MOVA_CORE_CONVERSA: "RESPOSTA", MOVA_CORE_CONVERSA_UNIDADES: ALFA }).operacoes, MODO_OPERACOES.DESLIGADO, "padrão: desligado");
  const ev = [];
  assert.equal(montarOperacoesDaConversa({ modo: MODO_OPERACOES.DESLIGADO, repositorio: {}, porta: {} }), null);
  assert.equal(montarOperacoesDaConversa({ modo: MODO_OPERACOES.EXECUTAR, repositorio: null, porta: {}, registrar: (e) => ev.push(e) }), null);
  assert.ok(ev.some((e) => e.tipo === "MOVA_CORE_OPERACOES_SEM_REPOSITORIO"));
});
