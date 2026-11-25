// 24/11 — COMPRA NOVA JÁ PAGA POR COMPROVANTE (caso real que originou o PR #203): o comprovante dos brownies (R$ 259,00) era para
// CADASTRAR uma compra nova e registrá-la como paga no mesmo dia — não para conciliar a conta antiga de R$ 81,00 do mesmo
// favorecido nem agrupar pagamentos. O MOVA precisa entender a INTENÇÃO (legenda, mensagem posterior ou resposta à pergunta) pelo
// sentido, com a pergunta pendente como contexto da leitura, e registrar UMA despesa + a SUA liquidação numa operação atômica.
// Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL isolado, IA SIMULADA atrás do provedor real. Tudo sintético.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, FINANCEIRO, FIN, ORG, SO_ALFA, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { DESFECHO, TIPO_DIVERGENCIA, descricaoDireta, desfechoPorFinalidade, diferencaPlausivelComoJuros } from "../../src/modules/mova-financeiro/dominio/divergencia.js";
import { validarSaidaDaIa } from "../../src/modules/mova-financeiro/ia/contratos.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const ANDRESSA = "Andressa Rodrigues Sintética";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 25900, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: ANDRESSA, pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", instituicaoDestino: "Banco Destino Sintético",
  idTransacao: `E0000000020261010BROWN${String(++seq).padStart(10, "0")}`, situacaoTransacao: "CONCLUIDA", categoriaSugerida: null, ...x });
const POLITICA = { operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100000,
  responsavel: "Administrador Sintético", motivo: "Despesa paga por comprovante Pix concluído até R$ 1.000,00 (sintético)", vigenteDe: "2026-10-01" };
const CONCESSAO = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];

/** Texto da mensagem e linha de sistema que chegaram ao modelo (o provedor real monta a requisição). */
const daRequisicao = (req) => ({ sistema: String(req.system ?? ""), dados: JSON.stringify(req.messages ?? []), documento: /"type":"(document|image)"/.test(JSON.stringify(req.messages ?? [])) });

/**
 * @param {{documento?:object|Function, textos?:(dados:string, sistema:string) => object|null}} ia  leitura simulada do comprovante e dos textos
 */
async function compra({ documento = PIX(), textos = () => null, contaAntiga = 8100 } = {}) {
  const pedidos = [];
  const s = await cenario({
    responder: (req) => { const r = daRequisicao(req); pedidos.push(r); return r.documento ? (typeof documento === "function" ? documento() : documento) : (textos(r.dados, r.sistema) ?? base({ intencao: "OUTRA" })); },
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: CONCESSAO }]) }),
    }),
  });
  if (process.env.FV2_REPOSITORIO === "postgres") await s.m.nucleo.concederAcesso(s.c(ORG, ALFA), { usuarioId: OPERADOR, acoes: CONCESSAO, justificativa: "Identidade operacional do MOVA (sintético)." });
  await s.mova.armazenamento.politicas.criar(POLITICA, { criadaPor: HUMANO });
  const cx = s.c(ORG, ALFA);
  // A conta ANTIGA do mesmo favorecido (o caso real: "BROWNIE ANDRESSA", R$ 81,00 pendentes).
  let antiga = null;
  if (contaAntiga) {
    const f = await s.m.nucleo.registrarContraparte(cx, { tipo: "FORNECEDOR", nome: ANDRESSA });
    antiga = (await s.m.nucleo.registrarObrigacao(cx, { contraparteId: f.id, valorOriginalCentavos: contaAntiga, categoria: "INSUMOS", descricao: "BROWNIE ANDRESSA", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" })).obrigacoes[0];
  }
  const registros = (tipo) => s.m.nucleo.consultarRegistros(cx, { tipo });
  const contas = () => registros("OBRIGACAO");
  const liquidacoes = () => registros("LIQUIDACAO");
  const saidas = async () => (await registros("MOVIMENTACAO")).filter((m) => m.sentido === "SAIDA");
  const saldo = async (id) => (await s.m.nucleo.detalharContaAPagar(cx, { id })).titulo.saldoCentavos;
  const resposta = async (quem = FIN) => ((await s.saida()).filter((r) => r.destino === quem).at(-1)?.texto) ?? "";
  const motivos = async () => (await s.mova.armazenamento.historico.todos()).map((h) => h.motivo);
  const nova = async () => (await contas()).find((o) => o.id !== antiga?.id);
  return { ...s, pedidos, antiga, contas, liquidacoes, saidas, saldo, resposta, motivos, nova };
}

/** A compra nova paga entrou como UMA despesa + UMA baixa, sem saída bancária, e a conta antiga ficou intacta. */
async function conferirCompraNovaPaga(s, { descricao = null } = {}) {
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.equal((await s.contas()).length, 2, "a compra nova entrou AO LADO da conta antiga");
  assert.equal(await s.saldo(s.antiga.id), 8100, "a conta antiga de R$ 81,00 não foi baixada");
  const n = await s.nova();
  assert.deepEqual([n.valorOriginalCentavos ?? n.valorBaseCentavos, await s.saldo(n.id)], [25900, 0], "a compra nova está quitada");
  assert.deepEqual([(await s.liquidacoes()).length, (await s.saidas()).length], [1, 0], "uma baixa (a da compra nova), nenhuma saída inventada");
  if (descricao) assert.match(n.descricao, descricao);
}

// ============================================================================================== o caso real (brownies, 23/11)
t("BR-1 caso real: legenda neutra, conta antiga de R$ 81 × comprovante de R$ 259 ⇒ pergunta 'é compra nova?' (não 'são juros?'); 'Outra compra' citando a pergunta registra a compra paga", async () => {
  const s = await compra();
  await s.enviar(gw({ texto: "Mova, comprovante de pagamento de brownies, alfa.", doc: pdf("BR1") }));
  assert.equal((await s.ultima()).motivo, "DIFERENCA_GRANDE_DEMAIS_PARA_JUROS");
  assert.match(await s.resposta(), /grande demais para ser juros\. É uma compra nova, já paga\?/);
  assert.doesNotMatch(await s.resposta(), /são juros dessa conta\?/);
  assert.equal((await s.contas()).length, 1, "nada gravado ainda");
  // a pessoa CITA a pergunta do MOVA (id confirmado pelo Gateway/relé) — retomada exata pela resposta citada (PR #203)
  await s.banco.pool.query("update mova.resposta set estado = 'ENVIADA', provider_message_id = $1 where seq = (select max(seq) from mova.resposta where grupo_jid = $2)", ["3EB0A89EE281B08950E4B1", FIN]);
  await s.enviar(gw({ texto: "Outra compra", grupo: FIN, respostaA: "3EB0A89EE281B08950E4B1" }));
  await conferirCompraNovaPaga(s);
  assert.match(await s.resposta(), /Despesa registrada e paga por comprovante: R\$ 259,00/);
  assert.match(await s.resposta(), /Não mexi na conta em aberto de BROWNIE ANDRESSA .* \(R\$ 81,00\)/);
  assert.match(await s.resposta(), /Conciliação bancária: pendente/);
});

t("BR-2 caso real com 'sim' à pergunta 'é compra nova?' ⇒ compra nova paga; 'é dessa conta' ⇒ NÃO cria compra (segue como juros, para o Financeiro)", async () => {
  const s = await compra();
  await s.enviar(gw({ texto: "Mova, comprovante de pagamento de brownies da alfa", doc: pdf("BR2") }));
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  await conferirCompraNovaPaga(s);
  const s2 = await compra();
  await s2.enviar(gw({ texto: "Mova, comprovante de pagamento de brownies da alfa", doc: pdf("BR2b") }));
  await s2.enviar(gw({ texto: "é dessa conta", grupo: FIN }));
  assert.equal((await s2.contas()).length, 1, "nenhuma compra nova");
  assert.equal(await s2.saldo(s2.antiga.id), 8100, "nada baixado pelo MOVA (juros acima do limite vão para o Financeiro)");
});

t("BR-3 a legenda JÁ diz a intenção ('Comprei brownies e já paguei'): sem pergunta, registra a compra paga com a descrição dita pela pessoa", async () => {
  const s = await compra({ documento: PIX({ finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) });
  await s.enviar(gw({ texto: "MOVA comprei brownies e já paguei, alfa", doc: pdf("BR3") }));
  await conferirCompraNovaPaga(s, { descricao: /Compra de brownies/ });
  assert.equal(s.pedidos.length, 1, "uma leitura de IA (a do comprovante), nenhuma pergunta");
  assert.match(await s.resposta(), /• Descrição: Compra de brownies/);
  assert.match(await s.resposta(), /• Favorecido: Andressa/);
  assert.match(await s.resposta(), /banco de origem: Banco Sintético/);
});

// ============================================================================ as modalidades de linguagem (sentido, não lista)
const FRASES = ["Compra de brownies.", "Comprei brownies e já paguei.", "Lança como pago hoje.", "Cadastra essa despesa.", "É uma compra nova.",
  "Outra compra de brownies.", "Não tem conta cadastrada ainda.", "Pode criar a conta e dar baixa.", "Já foi pago pelo Pix."];

for (const [i, frase] of FRASES.entries()) {
  t(`BR-4.${i + 1} resposta livre à pergunta pendente — "${frase}" ⇒ compra nova paga (leitura com a pergunta como contexto, no máximo uma chamada de IA)`, async () => {
    // A IA simulada só reconhece a frase como COMPRA_NOVA quando a pergunta pendente chegou como contexto (o motor a envia).
    const s = await compra({ textos: (dados, sistema) => (/PERGUNTA PENDENTE DO MOVA/.test(sistema) ? base({ intencao: "INFORMAR_PAGAMENTO", finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) : null) });
    await s.enviar(gw({ texto: "Mova, comprovante de pagamento da alfa", doc: pdf(`BR4-${i}`) }));
    assert.equal((await s.ultima()).motivo, "DIFERENCA_GRANDE_DEMAIS_PARA_JUROS");
    const antes = s.pedidos.length;
    await s.enviar(gw({ texto: frase, grupo: FIN }));
    await conferirCompraNovaPaga(s);
    assert.ok(s.pedidos.length - antes <= 1, "no máximo UMA leitura de IA pela resposta (limite de consumo preservado)");
    const usouIa = s.pedidos.length > antes;
    if (usouIa) assert.match(s.pedidos.at(-1).sistema, /PERGUNTA PENDENTE DO MOVA .*compra NOVA/, "a pergunta pendente foi o contexto da leitura");
    assert.ok((await s.motivos()).some((m) => ["RESPOSTA_DE_DIVERGENCIA_POR_CONTEXTO", "RESPOSTA_DE_DIVERGENCIA_POR_INTERPRETACAO"].includes(m)));
  });
  t(`BR-5.${i + 1} a mesma intenção na LEGENDA — "${frase}" ⇒ compra nova paga direto, mesmo com a conta antiga do favorecido`, async () => {
    const s = await compra({ documento: PIX({ finalidadePagamento: "COMPRA_NOVA" }) });
    await s.enviar(gw({ texto: `MOVA ${frase} Alfa.`, doc: pdf(`BR5-${i}`) }));
    await conferirCompraNovaPaga(s);
  });
}

// ========================================================================== descrição em mensagem POSTERIOR ao documento
t("BR-6 comprovante SEM descrição nem categoria ⇒ pergunta só o que foi comprado; 'brownies' (sem IA) completa e registra", async () => {
  const s = await compra({ contaAntiga: null, documento: PIX({ favorecido: "Doceria Sintética" }) });
  await s.enviar(gw({ texto: "MOVA", de: SO_ALFA, doc: pdf("BR6") }));
  assert.equal((await s.ultima()).motivo, "DESCRICAO_DA_COMPRA_AUSENTE");
  assert.match(await s.resposta(SO_ALFA), /O que foi comprado\?/);
  const antes = s.pedidos.length;
  await s.enviar(gw({ texto: "brownies", de: SO_ALFA, grupo: SO_ALFA }));
  assert.equal(s.pedidos.length, antes, "descrição curta não gasta IA");
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  const [conta] = await s.contas();
  assert.match(conta.descricao, /brownies/);
  assert.deepEqual([(await s.liquidacoes()).length, (await s.saidas()).length], [1, 0]);
});

t("BR-7 descrição LIVRE e longa depois do documento ⇒ a leitura (com a pergunta como contexto) extrai a descrição e continua", async () => {
  const s = await compra({ contaAntiga: null, documento: PIX({ favorecido: "Doceria Sintética" }),
    textos: (dados, sistema) => (/PERGUNTA PENDENTE DO MOVA .*o que foi comprado/.test(sistema) ? base({ intencao: "INFORMAR_PAGAMENTO", finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) : null) });
  await s.enviar(gw({ texto: "MOVA", de: SO_ALFA, doc: pdf("BR7") }));
  await s.enviar(gw({ texto: "foram uns brownies que eu comprei pra loja hoje cedo e já paguei no pix", de: SO_ALFA, grupo: SO_ALFA }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.match((await s.contas())[0].descricao, /Compra de brownies/);
});

// ====================================================================================== duplicidade × coincidência de valores
t("BR-8 valor IGUAL ao da conta antiga não prova que é ela: com 'compra nova' declarada, cria a compra paga e NÃO baixa a antiga", async () => {
  const s = await compra({ contaAntiga: 25900, documento: PIX({ finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) });
  await s.enviar(gw({ texto: "MOVA outra compra de brownies, já paga, alfa", doc: pdf("BR8") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.equal((await s.contas()).length, 2);
  assert.equal(await s.saldo(s.antiga.id), 25900, "a conta antiga de mesmo valor ficou intacta");
  assert.match(await s.resposta(), /Não mexi na conta em aberto de BROWNIE ANDRESSA/);
});

t("BR-9 sem intenção declarada e valor IGUAL ao da conta antiga: segue a baixa da conta existente (comportamento anterior preservado)", async () => {
  const s = await compra({ contaAntiga: 25900 });
  await s.enviar(gw({ texto: "MOVA pagamento da Andressa, alfa", doc: pdf("BR9") }));
  assert.equal((await s.contas()).length, 1, "nenhuma conta nova");
});

t("BR-10 'compra nova' declarada, mas o MESMO pagamento já está registrado (mesmo favorecido, valor e data): pergunta antes de duplicar", async () => {
  // cada leitura com OUTRO identificador de transação (a mesma transação já é barrada antes: TRANSACAO_JA_RECEBIDA, ver BR-10b)
  const s = await compra({ contaAntiga: null, documento: () => PIX({ finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) });
  await s.enviar(gw({ texto: "MOVA comprei brownies e já paguei, alfa", doc: pdf("BR10a") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  await s.enviar(gw({ texto: "MOVA comprei brownies e já paguei, alfa", doc: pdf("BR10b") })); // outro arquivo, mesmo valor/favorecido/data
  assert.equal((await s.ultima()).motivo, "POSSIVEL_COMPRA_JA_REGISTRADA");
  assert.equal((await s.contas()).length, 1, "nada duplicado sem confirmação");
});

t("BR-10b o MESMO Pix (mesmo identificador de transação) num outro arquivo: barrado como transação já recebida, sem segunda despesa", async () => {
  const s = await compra({ contaAntiga: null, documento: PIX({ finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }) });
  await s.enviar(gw({ texto: "MOVA comprei brownies e já paguei, alfa", doc: pdf("BR10c") }));
  await s.enviar(gw({ texto: "MOVA comprei brownies e já paguei, alfa", doc: pdf("BR10d") }));
  assert.equal((await s.ultima()).motivo, "TRANSACAO_JA_RECEBIDA");
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length], [1, 1]);
});

t("BR-11 mensagem que NÃO responde à pergunta pendente ('quanto devo este mês?') não retoma nada nem cria compra", async () => {
  const s = await compra({ textos: () => base({ intencao: "CONSULTAR", consulta: "CONTAS_A_PAGAR_ABERTAS" }) });
  await s.enviar(gw({ texto: "Mova, comprovante de pagamento da alfa", doc: pdf("BR11") }));
  await s.enviar(gw({ texto: "quanto devo este mês?", grupo: FIN }));
  assert.equal((await s.contas()).length, 1);
  assert.ok(!(await s.motivos()).includes("RESPOSTA_DE_DIVERGENCIA_POR_INTERPRETACAO"));
});

// ================================================================================================== regras puras e contrato
t("BR-12 regras puras: finalidade só vale onde faz sentido; juros plausíveis; descrição direta; contrato estrito", async () => {
  assert.equal(desfechoPorFinalidade("COMPRA_NOVA", { tipo: TIPO_DIVERGENCIA.MAIOR }).desfecho, DESFECHO.NOVA);
  assert.equal(desfechoPorFinalidade("JUROS", { tipo: TIPO_DIVERGENCIA.MAIOR }).desfecho, DESFECHO.JUROS);
  assert.equal(desfechoPorFinalidade("JUROS", { tipo: TIPO_DIVERGENCIA.MENOR }).desfecho, DESFECHO.NAO_ENTENDI, "juros não faz sentido em valor menor");
  assert.equal(desfechoPorFinalidade("CONTA_EXISTENTE", { tipo: TIPO_DIVERGENCIA.VARIAS }).desfecho, DESFECHO.NAO_ENTENDI, "a IA nunca escolhe a conta");
  assert.equal(desfechoPorFinalidade("CONTA_EXISTENTE", { tipo: TIPO_DIVERGENCIA.SEMELHANTE }).desfecho, DESFECHO.MESMA);
  assert.equal(diferencaPlausivelComoJuros({ valorCentavos: 25900, saldoCentavos: 8100 }), false, "R$ 178 sobre R$ 81 não é juros plausível");
  assert.equal(diferencaPlausivelComoJuros({ valorCentavos: 12000, saldoCentavos: 10000 }), true);
  assert.equal(descricaoDireta("brownies"), "brownies");
  for (const x of ["sim", "não", "quanto devo?", "2", "foram uns brownies que eu comprei pra loja hoje cedo"]) assert.equal(descricaoDireta(x), null, x);
  assert.equal(validarSaidaDaIa({ ...base({}), finalidadePagamento: "PAGAR_AGORA" }).ok, false, "finalidade fora do catálogo invalida a saída");
  assert.equal(validarSaidaDaIa({ ...base({}), finalidadePagamento: "COMPRA_NOVA", descricaoCompra: "Compra de brownies" }).ok, true);
});
