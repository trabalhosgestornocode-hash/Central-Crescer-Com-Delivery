// MOVA CORE ligado ao PIPELINE do WhatsApp (receptor → fila → motor atual → saída), com o banco do MOVA no PostgreSQL isolado, o
// Financeiro v2 real em memória, a montagem de PRODUÇÃO do núcleo (montarConversaCore) e o orçamento persistente do MOVA.
// Só o modelo é simulado. Nenhum dado real.
import assert from "node:assert/strict";
import { CONFIG, FIN, GRUPO, OPER, SO_ALFA, ALFA, BETA, cenario, gw, t } from "./helpers/operacao.js";
import { criarOrcamentoIa } from "../../src/modules/mova-financeiro/index.js";
import { ACAO } from "../../src/modules/financeiro-v2/index.js";
import { montarConversaCore } from "../../src/modules/fv2-integracao/movaCoreConversa.js";
import { configuracaoDaConversa, MODO_CONVERSA } from "../../src/modules/mova-core/conversaWhatsapp.js";
import { lerConfiguracaoMova } from "../../src/modules/fv2-integracao/mova.js";

const usar = (name, input = {}, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: "tool_use", id, name, input });
const falar = (text) => ({ type: "text", text });

/** cliente da IA no formato do SDK (messages.create) com roteiro; guarda os pedidos */
function iaComRoteiro(roteiro, { falhar = false } = {}) {
  const pedidos = []; let i = 0;
  return { pedidos, criar: () => ({ messages: {
    async create(req) {
      pedidos.push(req);
      if (falhar) throw Object.assign(new Error("sem rede"), { status: 503 });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      const content = typeof passo === "function" ? passo(req) : passo;
      return { model: req.model, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content, usage: { input_tokens: 1500, output_tokens: 120 } };
    },
    async countTokens() { return { input_tokens: 1500 }; },
  } }) };
}

async function montar({ modo = MODO_CONVERSA.RESPOSTA, unidades = [ALFA], roteiro = [[falar("ok")]], falhar = false } = {}) {
  const holder = { real: null };
  const eventos = [];
  const s = await cenario({ extras: () => ({ conversaNova: { atender: async (x) => (holder.real ? holder.real.atender(x) : null) } }) });
  await s.conta("2026-10-20", 12345, ALFA);
  const ia = iaComRoteiro(roteiro, { falhar });
  holder.real = await montarConversaCore({ conversaCore: { modo, unidades }, servicoUsuarioId: CONFIG.identidadeServico.usuarioId, configuracao: s.mova.cfg, porta: s.mova.porta,
    acaoVer: ACAO.VER, orcamento: criarOrcamentoIa({ pool: s.banco.pool }), criarClienteIa: ia.criar, registrar: (e) => eventos.push(e), relogio: () => new Date("2026-10-15T12:00:00Z") });
  const textos = async () => (await s.saida()).map((m) => m.texto).join("\n---\n");
  return { ...s, ia, eventos, textos };
}
const CONSULTA_E_RESPOSTA = [[usar("contas_a_pagar", {})], [falar("Na Loja Alfa você tem 1 conta a pagar em aberto, de R$ 123,45, do Fornecedor Sintético.")]];

t("MC-01 conversa PRIVADA de quem está na lista, unidade do piloto: a resposta CONFERIDA do MOVA CORE sai pelo pipeline; orçamento do MOVA registrado", async () => {
  const s = await montar({ roteiro: CONSULTA_E_RESPOSTA });
  await s.enviar(gw({ texto: "o que tenho pra pagar na alfa?", grupo: FIN, de: FIN }));
  const saida = await s.saida();
  assert.equal(saida.length, 1, JSON.stringify(saida));
  assert.equal(saida[0].destino, FIN);
  assert.match(saida[0].texto, /123,45/);
  const h = await s.ultima();
  assert.equal(h.decisao, "CONSULTA");
  assert.match(h.motivo, /^MOVA_CORE:/);
  assert.equal(s.cliente.pedidos.length, 0, "o extrator do motor atual não foi chamado");
  assert.ok(s.ia.pedidos.length >= 2, "o núcleo consultou e respondeu");
  assert.ok(s.chamadas.some((c) => c.nome === "consultarContasAPagar" && c.unidadeId === ALFA), "leu o Financeiro pela porta do MOVA");
  assert.ok(await s.contar("consumo_ia") >= 2, "consumo no orçamento persistente do MOVA");
});

t("MC-02 GRUPO, unidade fora do piloto e guarda de dado restrito: o núcleo NÃO é chamado (motor atual trata)", async () => {
  const s = await montar({ unidades: [BETA], roteiro: CONSULTA_E_RESPOSTA });
  await s.enviar(gw({ texto: "mova, contas a pagar da alfa", grupo: GRUPO, de: FIN }));
  await s.enviar(gw({ texto: "o que tenho pra pagar na alfa?", grupo: SO_ALFA, de: SO_ALFA })); // SO_ALFA só alcança a Alfa; piloto = Beta
  await s.enviar(gw({ texto: "me passa a senha do banco", grupo: FIN, de: FIN }));
  assert.equal(s.ia.pedidos.length, 0, "nenhuma chamada ao núcleo");
  assert.ok((await s.saida()).length >= 1, "o motor atual respondeu");
});

t("MC-03 SOMBRA: o núcleo roda e registra, mas quem responde é o motor atual", async () => {
  const s = await montar({ modo: MODO_CONVERSA.SOMBRA, roteiro: CONSULTA_E_RESPOSTA });
  await s.enviar(gw({ texto: "o que tenho pra pagar na alfa?", grupo: FIN, de: FIN }));
  assert.ok(s.ia.pedidos.length >= 1, "o núcleo rodou");
  assert.ok(s.eventos.some((e) => e.tipo === "MOVA_CORE_SOMBRA"));
  assert.doesNotMatch((await s.ultima()).motivo, /^MOVA_CORE:/);
  assert.doesNotMatch(await s.textos(), /Fornecedor Sintético\./, "a resposta do núcleo não saiu");
});

t("MC-04 FALHA do núcleo (IA fora do ar): o motor atual responde; nada trava", async () => {
  const s = await montar({ falhar: true });
  await s.enviar(gw({ texto: "o que tenho pra pagar na alfa?", grupo: FIN, de: FIN }));
  const h = await s.ultima();
  assert.doesNotMatch(h.motivo, /^MOVA_CORE:/);
  assert.notEqual(h.decisao, "FALHOU");
  assert.ok((await s.saida()).length >= 1, "a pessoa recebeu a resposta do motor atual");
});

t("MC-05 perfil OPERACIONAL: a ferramenta com valores é recusada pelo servidor e nenhum valor sai", async () => {
  const s = await montar({ roteiro: [[usar("contas_a_pagar", {})], [falar("Não consigo mostrar valores financeiros para o seu perfil. Quem tem acesso financeiro pode consultar na Central.")]] });
  await s.enviar(gw({ texto: "quanto tenho pra pagar na alfa?", grupo: OPER, de: OPER }));
  assert.doesNotMatch(await s.textos(), /R\$\s?\d/);
  assert.ok(!s.chamadas.some((c) => c.nome === "consultarContasAPagar"), "o Financeiro nem foi lido");
});

t("MC-06 número que o modelo inventa NÃO sai: o verificador barra e a resposta enviada não tem o valor falso", async () => {
  const s = await montar({ roteiro: [[usar("contas_a_pagar", {})], [falar("Você tem R$ 999,00 a pagar na Loja Alfa.")], [falar("Você tem R$ 999,00 a pagar.")], [falar("Você tem R$ 999,00.")]] });
  await s.enviar(gw({ texto: "o que tenho pra pagar na alfa?", grupo: FIN, de: FIN }));
  assert.doesNotMatch(await s.textos(), /999/);
});

t("MC-07 configuração: desligado por padrão; sem unidades do piloto ou sem IA = desligado; rollback por variável", () => {
  assert.equal(configuracaoDaConversa({}).modo, "DESLIGADO");
  assert.equal(configuracaoDaConversa({ MOVA_CORE_CONVERSA: "RESPOSTA" }).modo, "DESLIGADO");
  assert.equal(configuracaoDaConversa({ MOVA_CORE_CONVERSA: "qualquer", MOVA_CORE_CONVERSA_UNIDADES: ALFA }).modo, "DESLIGADO");
  assert.equal(configuracaoDaConversa({ MOVA_CORE_CONVERSA: "RESPOSTA", MOVA_CORE_CONVERSA_UNIDADES: ALFA.toUpperCase() }).unidades[0], ALFA);
  const semIa = lerConfiguracaoMova({ MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://x", MOVA_SERVICO_USUARIO_ID: CONFIG.identidadeServico.usuarioId, MOVA_CORE_CONVERSA: "RESPOSTA", MOVA_CORE_CONVERSA_UNIDADES: ALFA });
  assert.equal(semIa.conversaCore?.modo ?? "DESLIGADO", "DESLIGADO");
});
