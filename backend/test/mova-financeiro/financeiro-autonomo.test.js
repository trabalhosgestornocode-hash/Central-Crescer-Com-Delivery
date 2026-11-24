// MOVA FINANCEIRO AUTÔNOMO (23/11/2026): comprovante + legenda → o MOVA resolve sozinho quando os dados são consistentes e pergunta
// só quando há dúvida concreta (valor maior, menor, várias contas), continuando a operação com a resposta.
// Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL isolado, IA SIMULADA, Gateway simulado. Tudo sintético.
import assert from "node:assert/strict";
import { test } from "node:test";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, BETA, ESTRANHO, FINANCEIRO, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { DESFECHO, TIPO_DIVERGENCIA, classificarCasamento, escolherCategoria, interpretarResposta, legendaIndicaParcial, parecerRespostaDeDivergencia } from "../../src/modules/mova-financeiro/dominio/divergencia.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
/** Pix concluído sintético; favorecido padrão = o fornecedor das contas do cenário. */
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 10800, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: "Fornecedor Sintético", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", instituicaoDestino: "Banco Destino Sintético",
  idTransacao: `E0000000020261010AUTON${String(++seq).padStart(5, "0")}`, situacaoTransacao: "CONCLUIDA", categoriaSugerida: "INSUMOS", ...x });
const POLITICA = (x = {}) => ({ operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100000,
  responsavel: "Administrador Sintético", motivo: "Despesa paga por comprovante Pix concluído até R$ 1.000,00 (sintético)", vigenteDe: "2026-10-01", ...x });
const CONCESSAO = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
const ESCRITAS = ["enviarEvidencia", "registrarObrigacaoDocumental", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar"];

async function autonomo({ responder, politica = {}, concessao = CONCESSAO } = {}) {
  const s = await cenario({
    responder,
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) }),
    }),
  });
  // Com o Financeiro v2 no PostgreSQL (FV2_REPOSITORIO=postgres), o BANCO confere a sessão: a identidade operacional precisa da concessão gravada.
  if (process.env.FV2_REPOSITORIO === "postgres" && concessao) await s.m.nucleo.concederAcesso(s.c(ORG, ALFA), { usuarioId: OPERADOR, acoes: concessao, justificativa: "Identidade operacional do MOVA (sintético)." });
  if (politica) await s.mova.armazenamento.politicas.criar(POLITICA(politica), { criadaPor: HUMANO });
  const cx = s.c(ORG, ALFA);
  const registros = (unidade, tipo) => s.m.nucleo.consultarRegistros(s.c(ORG, unidade), { tipo });
  const contas = (u = ALFA) => registros(u, "OBRIGACAO");
  const liquidacoes = () => registros(ALFA, "LIQUIDACAO");
  const saidas = async () => (await registros(ALFA, "MOVIMENTACAO")).filter((m) => m.sentido === "SAIDA");
  const despesas = async () => (await registros(ALFA, "LANCAMENTO")).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA");
  const escritas = () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome));
  const respostas = async () => (await s.saida()).filter((r) => r.destino === FIN).map((r) => r.texto);
  const resposta = async () => (await respostas()).at(-1) ?? "";
  const escopo = { organizacaoId: ORG, unidadeId: ALFA };
  const propostas = () => s.mova.armazenamento.propostas.listar(escopo);
  const saldo = async (id) => (await s.m.nucleo.detalharContaAPagar(cx, { id })).titulo.saldoCentavos;
  return { ...s, cx, contas, liquidacoes, saidas, despesas, escritas, respostas, resposta, escopo, propostas, saldo };
}

t("AUT-A compra NOVA (brownies): sem conta do favorecido → cria a conta com a descrição da legenda, anexa, paga por comprovante (sem saída) e responde o que fez", async () => {
  const s = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética", categoriaSugerida: "INSUMOS" }) });
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("A") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"]);
  const [conta] = await s.contas();
  assert.match(conta.descricao, /brownies/i, "descrição vem da legenda");
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length, (await s.despesas()).length, (await s.saidas()).length], [1, 1, 1, 0]);
  assert.equal(await s.saldo(conta.id), 0);
  assert.deepEqual(s.escritas().map((x) => x.nome), ["registrarObrigacaoDocumental", "enviarEvidencia", "registrarPagamentoPorComprovante"]);
  assert.equal((await s.respostas()).length, 1, "uma resposta, sem 'posso cadastrar?'");
  assert.doesNotMatch(await s.resposta(), /posso|confirma/i);
  assert.match(await s.resposta(), /Despesa registrada e paga por comprovante: R\$ 108,00/);
});

t("AUT-B conta existente com valor IGUAL ao saldo: não cria despesa nova; a baixa é da conta existente", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }), politica: null });
  const o = await s.conta("2026-10-20", 10800);
  await s.enviar(gw({ texto: "MOVA pagamento da alfa", doc: pdf("B") }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.comando.entrada.obrigacaoId, p.parcial], ["BAIXA_DE_OBRIGACAO", o.obrigacoes[0].id, false]);
  assert.equal((await s.contas()).length, 1, "nenhuma conta nova");
  assert.equal((await s.respostas()).filter((x) => /\?/.test(x)).length, 0, "sem pergunta");
});

t("AUT-C valor MAIOR que o saldo: pergunta objetiva (juros?), nada gravado; 'sim' (sem citar) continua → UMA proposta com juros, sem segunda conta", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 25000 }) });
  const o = await s.conta("2026-10-20", 23000);
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa, com juros", doc: pdf("C") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  assert.match(await s.resposta(), /Encontrei a conta de .* com R\$ 230,00 pendentes\. O comprovante é de R\$ 250,00\. Os R\$ 20,00 de diferença são juros dessa conta\?/);
  assert.deepEqual([s.escritas().length, (await s.propostas()).length, (await s.contas()).length], [0, 0, 1]);
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.valorCentavos, p.comando.entrada.obrigacaoId, p.comando.juros.valorCentavos, p.comando.juros.principalCentavos], ["BAIXA_DE_OBRIGACAO", 25000, o.obrigacoes[0].id, 2000, 23000]);
  assert.equal((await s.contas()).length, 1, "NÃO cria segunda obrigação de R$ 250,00");
  assert.equal(await s.saldo(o.obrigacoes[0].id), 23000, "nada foi baixado pelo MOVA (o pagamento com juros é do Financeiro)");
  assert.equal(s.escritas().length, 0);
  assert.match(await s.resposta(), /juros de R\$ 20,00 = R\$ 250,00/);
  const h = await s.mova.armazenamento.historico.todos();
  assert.ok(h.some((x) => x.motivo === "RESPOSTA_DE_DIVERGENCIA_POR_CONTEXTO"), "a resposta foi relacionada à pergunta");
});

t("AUT-C2 valor maior e a resposta é 'outra compra': NÃO presume juros; cria a despesa nova e não toca na conta existente", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  const o = await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C2") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN }));
  const h = await s.ultima();
  assert.equal(h.decisao, "EXECUTADO");
  assert.equal((await s.contas()).length, 2, "a conta nova entrou ao lado da existente");
  assert.equal(await s.saldo(o.obrigacoes[0].id), 5000, "a conta existente ficou intacta");
  assert.deepEqual([(await s.liquidacoes()).length, (await s.saidas()).length], [1, 0]);
});

/** Simula o Gateway/relé confirmando a ÚLTIMA resposta do MOVA para `destino` com o id do provedor (o que a pessoa cita no WhatsApp). */
async function entregar(s, providerMessageId, destino = FIN) {
  await s.banco.pool.query("update mova.resposta set estado = 'ENVIADA', provider_message_id = $1 where seq = (select max(seq) from mova.resposta where grupo_jid = $2)", [providerMessageId, destino]);
}
const envelhecerPendencias = (s, intervalo) => s.banco.pool.query("update mova.mensagem_pendente set criada_em = now() - $1::interval where resolvida_em is null", [intervalo]);
const relacoes = async (s) => (await s.mova.armazenamento.historico.todos()).filter((x) => x.decisao === "RELACIONADA");
const abertas = async (s) => Number((await s.banco.pool.query("select count(*)::int n from mova.mensagem_pendente where resolvida_em is null")).rows[0].n);

t("AUT-C3 (produção 23/11) 'Outra compra' CITANDO a pergunta do MOVA (não o comprovante): resolução EXATA pela resposta citada → continua a operação", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  const o = await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C3") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  await entregar(s, "3EB0PERGUNTADOMOVA0001");
  await s.enviar(gw({ texto: "Outra compra", grupo: FIN, respostaA: "3EB0PERGUNTADOMOVA0001" }));
  const h = await s.ultima();
  assert.notEqual(h.motivo, "CONVERSA_SEM_PEDIDO_FINANCEIRO");
  assert.equal(h.decisao, "EXECUTADO");
  assert.equal((await s.contas()).length, 2, "a conta nova entrou ao lado da existente");
  assert.equal(await s.saldo(o.obrigacoes[0].id), 5000, "a conta existente ficou intacta");
  assert.deepEqual((await relacoes(s)).map((x) => x.motivo), ["RESPOSTA_CITANDO_PERGUNTA"]);
});

t("AUT-C4 citação sem pendência e texto que não é resposta curta: segue o fluxo normal (não retoma pergunta alheia)", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C4") }));
  await s.enviar(gw({ texto: "vou ver com a gerência amanhã e te falo", grupo: FIN, respostaA: "3EB0OUTRAMENSAGEM0001" }));
  assert.equal((await relacoes(s)).length, 0);
  assert.equal((await s.contas()).length, 1, "nada criado");
});

t("AUT-C5 'outra compra' citando uma mensagem QUALQUER (não é pergunta do MOVA) não confirma por aproximação a pendência recente", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C5") }));
  await entregar(s, "3EB0PERGUNTA00C5");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0MENSAGEMHUMANA00C5" }));
  assert.equal((await relacoes(s)).length, 0, "citação que não resolve nunca usa a memória curta");
  assert.equal((await s.contas()).length, 1, "nada criado");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA00C5" }));
  assert.equal((await s.contas()).length, 2, "a pendência continuava aberta e a citação certa a retoma");
});

t("AUT-C6 'sim' citando uma RESPOSTA do MOVA sem pendência (pergunta já resolvida) não confirma outra operação", async () => {
  // IA simulada lê comprovante SÓ quando há documento; texto solto ("sim") vira conversa (como o Haiku real).
  const temDocumento = (req) => (req.messages?.[0]?.content ?? []).some((b) => b.type === "document");
  const s = await autonomo({ responder: (req) => (temDocumento(req) ? PIX({ valorCentavos: 25000 }) : base({})) });
  const o = await s.conta("2026-10-20", 23000);
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa", doc: pdf("C6a") }));
  await entregar(s, "3EB0PERGUNTA00C6");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA00C6" })); // resolve a 1ª (despesa nova)
  await entregar(s, "3EB0CONFIRMACAO00C6");
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa (segundo)", doc: pdf("C6b") })); // nova pergunta (mesma conta, valor maior)
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  const antes = (await s.propostas()).length;
  await s.enviar(gw({ texto: "sim", grupo: FIN, respostaA: "3EB0CONFIRMACAO00C6" })); // cita a confirmação da 1ª, que não tem pendência
  assert.equal((await s.propostas()).length, antes, "nenhuma proposta nova (não virou juros da 2ª)");
  assert.equal(await s.saldo(o.obrigacoes[0].id), 23000);
  assert.equal((await relacoes(s)).length, 1, "só a 1ª citação foi relacionada");
  assert.equal(await abertas(s), 1, "a 2ª pergunta continua aberta");
});

t("AUT-C7 DUAS pendências na mesma conversa: a citação escolhe a certa (não a mais recente) e a outra continua aberta", async () => {
  let n = 0;
  const s = await autonomo({ responder: () => (++n === 1 ? PIX({ valorCentavos: 25000 }) : PIX({ valorCentavos: 10800, favorecido: "Doceria Sintética" })) });
  const doceria = await s.m.nucleo.registrarContraparte(s.c(ORG, ALFA), { tipo: "FORNECEDOR", nome: "Doceria Sintética" });
  const c1 = await s.conta("2026-10-20", 23000);
  const c2 = await s.conta("2026-10-21", 5000, ALFA, doceria);
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa", doc: pdf("C7a") }));
  await entregar(s, "3EB0PERGUNTA00C7A");
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C7b") }));
  await entregar(s, "3EB0PERGUNTA00C7B");
  assert.equal(await abertas(s), 2);
  await s.enviar(gw({ texto: "sim", grupo: FIN, respostaA: "3EB0PERGUNTA00C7A" })); // juros da 1ª (a mais ANTIGA)
  const [p] = await s.propostas();
  assert.deepEqual([p.comando.entrada.obrigacaoId, p.comando.juros.valorCentavos], [c1.obrigacoes[0].id, 2000]);
  assert.equal(await abertas(s), 1, "a pergunta dos brownies continua aberta");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA00C7B" }));
  assert.equal(await s.saldo(c2.obrigacoes[0].id), 5000, "a conta da doceria ficou intacta");
  assert.equal((await s.contas()).length, 3, "só a compra nova dos brownies entrou");
  assert.equal(await abertas(s), 0);
});

t("AUT-C8 mensagem ATRASADA: citação 30 min depois ainda retoma (pendência financeira não some em 10 min); sem citação, não", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C8") }));
  await entregar(s, "3EB0PERGUNTA00C8");
  await envelhecerPendencias(s, "30 minutes");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN }));
  assert.equal((await relacoes(s)).length, 0, "sem citação, a memória curta (10 min) não alcança");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA00C8" }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.contas()).length], ["EXECUTADO", 2]);
});

t("AUT-C9 pendência citada FORA da validade (73 h): nada é executado, pede reenvio e a pendência fica para a revisão", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C9") }));
  await entregar(s, "3EB0PERGUNTA00C9");
  await envelhecerPendencias(s, "73 hours");
  await s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA00C9" }));
  assert.deepEqual([(await s.ultima()).motivo, (await s.contas()).length, s.escritas().length], ["PENDENCIA_EXPIRADA", 1, 0]);
  assert.match(await s.resposta(), /não continuo operações antigas/);
  assert.equal(await abertas(s), 1);
});

t("AUT-C10 a MESMA resposta citada chega duas vezes (reenvio simultâneo): só UMA operação", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }) });
  await s.conta("2026-10-20", 5000);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("C10") }));
  await entregar(s, "3EB0PERGUNTA0C10");
  await Promise.all([s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA0C10" })), s.enviar(gw({ texto: "outra compra", grupo: FIN, respostaA: "3EB0PERGUNTA0C10" }))]);
  assert.equal((await s.contas()).length, 2, "uma conta nova, não duas");
  assert.equal((await relacoes(s)).length, 1);
});

t("AUT-D valor MENOR sem evidência de parcial: pergunta; 'sim' → baixa parcial preservando o saldo restante e o valor original", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 15000 }), politica: null });
  const o = await s.conta("2026-10-20", 25000);
  await s.enviar(gw({ texto: "MOVA pagamento da alfa", doc: pdf("D") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MENOR_QUE_SALDO");
  assert.match(await s.resposta(), /pagamento parcial \(restam R\$ 100,00 em aberto\)/);
  assert.equal((await s.propostas()).length, 0);
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.parcial, p.valorCentavos, p.comando.entrada.valorCentavos], ["BAIXA_DE_OBRIGACAO", true, 15000, 15000]);
  assert.equal((await s.contas()).length, 1);
  assert.equal((await s.m.nucleo.detalharContaAPagar(s.cx, { id: o.obrigacoes[0].id })).titulo.valorOriginalCentavos, 25000, "valor original preservado");
});

t("AUT-E várias contas candidatas: lista objetiva e numerada; o número escolhido continua a operação", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 20000 }), politica: null });
  const a1 = await s.conta("2026-10-20", 30000);
  const a2 = await s.conta("2026-10-25", 40000);
  await s.enviar(gw({ texto: "MOVA pagamento da alfa", doc: pdf("E") }));
  assert.equal((await s.ultima()).motivo, "VARIAS_OBRIGACOES_COMPATIVEIS");
  const q = await s.resposta();
  assert.match(q, /Encontrei 2 contas que podem ser esta:\n1\) .*R\$ 300,00 pendentes.*\n2\) .*R\$ 400,00 pendentes/);
  assert.equal((await s.propostas()).length, 0);
  await s.enviar(gw({ texto: "1", grupo: FIN })); // escolhe a conta de R$ 300 (valor menor que o saldo) → nova pergunta objetiva (parcial?)
  assert.equal((await s.ultima()).motivo, "VALOR_MENOR_QUE_SALDO");
  await s.enviar(gw({ texto: "parcial", grupo: FIN }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.parcial, p.comando.entrada.obrigacaoId], ["BAIXA_DE_OBRIGACAO", true, a1.obrigacoes[0].id]);
  assert.notEqual(p.comando.entrada.obrigacaoId, a2.obrigacoes[0].id);
});

t("AUT-E2 a legenda indica parcial ('entrada'): sem pergunta, baixa parcial direta", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 15000 }), politica: null });
  await s.conta("2026-10-20", 25000);
  await s.enviar(gw({ texto: "MOVA entrada do pagamento da alfa", doc: pdf("E2") }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.parcial], ["BAIXA_DE_OBRIGACAO", true]);
});

t("AUT-F duplicidade: o MESMO comprovante (outro arquivo, mesma transação) não cria segunda despesa, pagamento ou saída", async () => {
  const s = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética", idTransacao: "E0000000020261010AUTONDUP0001" }) });
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("F1") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("F2-outro-arquivo") }));
  assert.equal((await s.ultima()).decisao, "DUPLICADO");
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length, (await s.despesas()).length, (await s.saidas()).length], [1, 1, 1, 0]);
});

t("AUT-G sem autorização: remetente fora da lista é ignorado (nenhuma leitura, escrita ou resposta); sem concessão operacional só propõe", async () => {
  const s = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética" }) });
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("G1"), de: ESTRANHO }));
  assert.equal((await s.ultima())?.decisao ?? "IGNORADO", "IGNORADO");
  assert.deepEqual([s.escritas().length, (await s.contas()).length, (await s.respostas()).length], [0, 0, 0]);
  const sem = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética" }), concessao: null });
  await sem.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("G2") }));
  assert.equal((await sem.ultima()).decisao, "PROPOSTA");
  assert.deepEqual([sem.escritas().length, (await sem.contas()).length], [0, 0]);
});

t("AUT-H isolamento: conta de OUTRA unidade com o mesmo favorecido nunca é considerada", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800 }), politica: null });
  const fornBeta = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const naBeta = await s.conta("2026-10-20", 10800, BETA, fornBeta);
  await s.enviar(gw({ texto: "MOVA pagamento da alfa", doc: pdf("H") }));
  const [p] = await s.propostas();
  assert.equal(p.tipo, "DESPESA_PAGA", "na Alfa não há conta: despesa nova (nunca baixa a conta da Beta)");
  assert.equal(await (async () => (await s.m.nucleo.detalharContaAPagar(s.c(ORG, BETA), { id: naBeta.obrigacoes[0].id })).titulo.saldoCentavos)(), 10800);
});

test("divergência (regras puras): classificação, respostas, parcial por legenda e categoria", () => {
  const c = (id, saldo) => ({ id, saldoCentavos: saldo });
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [] }).caso, "NENHUMA");
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [c("a", 100)] }).caso, "EXATA");
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [c("a", 50)] }).caso, "MAIOR");
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [c("a", 150)] }).caso, "MENOR");
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [c("a", 150), c("b", 100)] }).caso, "EXATA", "uma exata entre várias");
  assert.equal(classificarCasamento({ valorCentavos: 100, candidatas: [c("a", 150), c("b", 300)] }).caso, "VARIAS");
  const maior = { tipo: TIPO_DIVERGENCIA.MAIOR, candidatas: [{ id: "a" }] };
  const menor = { tipo: TIPO_DIVERGENCIA.MENOR, candidatas: [{ id: "a" }] };
  const varias = { tipo: TIPO_DIVERGENCIA.VARIAS, candidatas: [{ id: "a" }, { id: "b" }] };
  assert.equal(interpretarResposta("Sim", maior).desfecho, DESFECHO.JUROS);
  assert.equal(interpretarResposta("são juros", maior).desfecho, DESFECHO.JUROS);
  assert.equal(interpretarResposta("não, é outra compra", maior).desfecho, DESFECHO.NOVA);
  assert.equal(interpretarResposta("não", maior).desfecho, DESFECHO.NOVA);
  assert.equal(interpretarResposta("talvez", maior).desfecho, DESFECHO.NAO_ENTENDI);
  assert.equal(interpretarResposta("sim", menor).desfecho, DESFECHO.PARCIAL);
  assert.equal(interpretarResposta("é a entrada", menor).desfecho, DESFECHO.PARCIAL);
  assert.deepEqual(interpretarResposta("2", varias), { desfecho: DESFECHO.ESCOLHER, indice: 1 });
  assert.equal(interpretarResposta("3", varias).desfecho, DESFECHO.NAO_ENTENDI, "número fora da lista");
  assert.equal(interpretarResposta("nenhuma, é compra nova", varias).desfecho, DESFECHO.NOVA);
  assert.equal(legendaIndicaParcial("MOVA entrada do fornecedor"), true);
  assert.equal(legendaIndicaParcial("brownies para o açaí"), false);
  assert.equal(parecerRespostaDeDivergencia("sim"), true);
  assert.equal(parecerRespostaDeDivergencia("qual o faturamento de hoje?"), false);
  const plano = [{ codigo: "INSUMOS", nome: "Insumos e mercadorias", aceitaLancamento: true, natureza: "CUSTO" }, { codigo: "ENERGIA", nome: "Energia elétrica", aceitaLancamento: true, natureza: "DESPESA" },
    { codigo: "EMB", nome: "Embalagens e descartáveis", aceitaLancamento: true, natureza: "CUSTO" }, { codigo: "RECEITA", nome: "Insumos de receita", aceitaLancamento: true, natureza: "RECEITA" }];
  assert.equal(escolherCategoria({ categorias: plano, categoriaSugerida: null, legenda: "brownies para o açaí" }), "INSUMOS");
  assert.equal(escolherCategoria({ categorias: plano, categoriaSugerida: null, legenda: "descartáveis" }), "EMB");
  assert.equal(escolherCategoria({ categorias: plano, categoriaSugerida: null, legenda: "algo qualquer" }), null, "sem correspondência: provisória");
  assert.equal(escolherCategoria({ categorias: [...plano, { codigo: "INS2", nome: "Insumos extras", aceitaLancamento: true, natureza: "CUSTO" }], categoriaSugerida: null, legenda: "brownies" }), null, "ambígua: não escolhe");
});
