// MOVA FINANCEIRO AUTÔNOMO — juros/multa automáticos, "ausência de conta ≠ compra nova" e dados bancários preservados (23/11/2026).
// Financeiro v2 REAL (em memória; com FV2_REPOSITORIO=postgres, no PostgreSQL isolado), banco do MOVA no PostgreSQL isolado, IA e Gateway
// SIMULADOS. Tudo sintético.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, FINANCEIRO, FIN, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c3";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 10800, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: "Fornecedor Sintético", pagador: "Loja Alfa Sintética", instituicao: "Banco Sintético", instituicaoDestino: "Banco Destino Sintético",
  idTransacao: `E0000000020261010JUROS${String(++seq).padStart(10, "0")}`, situacaoTransacao: "CONCLUIDA", categoriaSugerida: "INSUMOS", ...x });
const POLITICA = (x = {}) => ({ operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100000,
  responsavel: "Administrador Sintético", motivo: "Política sintética de teste", vigenteDe: "2026-10-01", ...x });
const CONCESSAO = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
const CONCESSAO_JUROS = [...CONCESSAO, "financeiro_v2.registrar_juros"];
const ESCRITAS = ["enviarEvidencia", "registrarPagamentoComEncargo", "registrarObrigacaoDocumental", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar"];

async function autonomo({ responder, concessao = CONCESSAO, juros = false, despesa = {}, politicaJuros = null, politicaBaixa = null } = {}) {
  const s = await cenario({
    responder,
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true, registrarJuros: juros,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) }),
    }),
  });
  // Com o Financeiro v2 no PostgreSQL (FV2_REPOSITORIO=postgres), o BANCO confere a sessão: a identidade operacional precisa da concessão gravada.
  if (process.env.FV2_REPOSITORIO === "postgres" && concessao) await s.m.nucleo.concederAcesso(s.c(ORG, ALFA), { usuarioId: OPERADOR, acoes: concessao, justificativa: "Identidade operacional do MOVA (sintético)." });
  const politicas = s.mova.armazenamento.politicas;
  if (despesa) await politicas.criar(POLITICA(despesa), { criadaPor: HUMANO });
  if (politicaJuros) await politicas.criar(POLITICA({ operacao: "JUROS_DOCUMENTAL", limiteCentavos: 3000, motivo: "Encargo de até R$ 30,00 por pagamento (sintético)", ...politicaJuros }), { criadaPor: HUMANO });
  if (politicaBaixa) await politicas.criar(POLITICA({ operacao: "BAIXA_DOCUMENTAL", motivo: "Pagamento por comprovante até R$ 1.000,00 (sintético)", ...politicaBaixa }), { criadaPor: HUMANO });
  const cx = s.c(ORG, ALFA);
  const registros = (tipo) => s.m.nucleo.consultarRegistros(cx, { tipo });
  const escopo = { organizacaoId: ORG, unidadeId: ALFA };
  return {
    ...s, cx, escopo,
    contas: () => registros("OBRIGACAO"), liquidacoes: () => registros("LIQUIDACAO"), ajustes: () => registros("AJUSTE"),
    saidas: async () => (await registros("MOVIMENTACAO")).filter((m) => m.sentido === "SAIDA"),
    despesas: async () => (await registros("LANCAMENTO")).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA"),
    escritas: () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome)),
    resposta: async () => (await s.saida()).filter((r) => r.destino === FIN).at(-1)?.texto ?? "",
    propostas: () => s.mova.armazenamento.propostas.listar(escopo),
    saldo: async (id) => (await s.m.nucleo.detalharContaAPagar(cx, { id })).titulo.saldoCentavos,
  };
}

t("AUT-J1 juros CONFIRMADOS (política JUROS_DOCUMENTAL + chave + ação registrar_juros): principal R$ 230 + encargo R$ 20, conta quitada, comprovante vinculado, sem saída, sem 2ª despesa de compra, conciliação pendente, resposta com o resultado", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 25000 }), concessao: CONCESSAO_JUROS, juros: true, despesa: null, politicaJuros: {}, politicaBaixa: {} });
  const o = await s.conta("2026-10-20", 23000);
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa, com juros", doc: pdf("J1") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  assert.equal(s.escritas().length, 0, "a pergunta não grava nada");
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"]);
  const id = o.obrigacoes[0].id;
  const t1 = (await s.m.nucleo.detalharContaAPagar(s.cx, { id })).titulo;
  assert.deepEqual([t1.situacaoPagamento, t1.situacaoConciliacao, t1.saldoCentavos, t1.pagoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 0, 25000]);
  assert.equal((await s.contas()).length, 1, "nenhuma 2ª conta de R$ 250,00");
  assert.deepEqual([(await s.liquidacoes()).length, (await s.saidas()).length, (await s.ajustes()).length], [1, 0, 1], "uma baixa, nenhuma saída, um ajuste de encargo");
  assert.deepEqual((await s.despesas()).map((l) => [l.categoria, l.valorCentavos]).sort(), [["INSUMOS", 23000], ["JUROS_E_MULTAS_DE_FORNECEDORES", 2000]], "a compra uma vez; o encargo como despesa financeira");
  assert.deepEqual(s.escritas().map((x) => x.nome), ["registrarPagamentoComEncargo"]);
  for (const x of s.escritas()) assert.equal(x.permissoes.length, x.nome === "registrarPagamentoComEncargo" ? 3 : 2, "identidade operacional só com [ver, ação(ões) da operação]");
  const [op] = await s.mova.armazenamento.operacoes.listar(s.escopo);
  assert.deepEqual([op.operacao, op.estado, op.executadaPor], ["JUROS_DOCUMENTAL", "EXECUTADA", OPERADOR]);
  assert.match(await s.resposta(), /Pagamento registrado por comprovante: R\$ 250,00 = conta de R\$ 230,00 \+ juros de R\$ 20,00/);
  assert.match(await s.resposta(), /Conciliação bancária: pendente/);
  // Idempotência: reexecutar a mesma proposta não grava nada de novo.
  const [p] = await s.propostas();
  const r2 = await s.mova.execucao.aposJuros(p, s.escopo);
  assert.ok(r2.situacao === "PAGO_POR_COMPROVANTE" || r2.motivo, "a repetição não executa de novo");
  assert.deepEqual([(await s.liquidacoes()).length, (await s.ajustes()).length, (await s.saidas()).length], [1, 1, 0]);
  // Conciliação posterior: a saída do extrato de R$ 250,00 liga à MESMA baixa (sem 2ª baixa, 2ª saída ou despesa).
  const banco = await s.m.nucleo.configurarContaFinanceira(s.cx, { tipo: "BANCARIA", nome: "Banco extra", instituicao: "Banco" });
  const mov = (await s.m.nucleo.registrarMovimentacao(s.cx, { contaId: banco.id, dataEfetiva: "2026-10-10", sentido: "SAIDA", valorCentavos: 25000, natureza: "PAGAMENTO", fonte: { sistema: "UNICRED", idExterno: "EXT-J1-250" } })).movimentacao;
  const [liq] = await s.liquidacoes();
  const k = await s.m.nucleo.conciliarPagamentoPorComprovante(s.cx, { liquidacaoId: liq.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "Extrato confere (sintético).", confirmar: true });
  assert.deepEqual([k.conciliacao, k.efeito.novasBaixas], ["CONCILIADO_COM_EXTRATO", 0]);
  assert.equal((await s.liquidacoes()).length, 1);
});

t("AUT-J2 juros: chave desligada, sem concessão registrar_juros, sem política, encargo ou pagamento acima do limite → só PROPOSTA, nada gravado", async () => {
  const casos = [
    ["chave desligada", { concessao: CONCESSAO_JUROS, juros: false, politicaJuros: {}, politicaBaixa: {} }],
    ["sem concessão", { concessao: CONCESSAO, juros: true, politicaJuros: {}, politicaBaixa: {} }],
    ["sem política de juros", { concessao: CONCESSAO_JUROS, juros: true, politicaJuros: null, politicaBaixa: {} }],
    ["encargo acima do limite", { concessao: CONCESSAO_JUROS, juros: true, politicaJuros: { limiteCentavos: 1000 }, politicaBaixa: {} }],
    ["pagamento acima do limite", { concessao: CONCESSAO_JUROS, juros: true, politicaJuros: {}, politicaBaixa: { limiteCentavos: 20000 } }],
  ];
  for (const [nome, cfg] of casos) {
    const s = await autonomo({ responder: () => PIX({ valorCentavos: 25000 }), despesa: null, ...cfg });
    const o = await s.conta("2026-10-20", 23000);
    await s.enviar(gw({ texto: "MOVA descartáveis para a alfa", doc: pdf(`J2-${nome}`) }));
    await s.enviar(gw({ texto: "sim", grupo: FIN }));
    assert.equal((await s.ultima()).decisao, "PROPOSTA", nome);
    assert.deepEqual([s.escritas().length, (await s.liquidacoes()).length, (await s.ajustes()).length], [0, 0, 0], nome);
    assert.equal(await s.saldo(o.obrigacoes[0].id), 23000, nome);
  }
});

t("AUT-J3 encargo acima de 10% da conta nunca é automático (limite do Financeiro, mesmo com política generosa): volta para revisão e nada fica gravado", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 12000 }), concessao: CONCESSAO_JUROS, juros: true, despesa: null, politicaJuros: { limiteCentavos: 50000 }, politicaBaixa: {} });
  const o = await s.conta("2026-10-20", 10000); // encargo de R$ 20,00 = 20% da conta
  await s.enviar(gw({ texto: "MOVA descartáveis para a alfa", doc: pdf("J3") }));
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  assert.deepEqual([(await s.liquidacoes()).length, (await s.ajustes()).length], [0, 0]);
  assert.equal(await s.saldo(o.obrigacoes[0].id), 10000);
  const [op] = await s.mova.armazenamento.operacoes.listar(s.escopo);
  assert.equal(op.estado, "FALHOU", "a tentativa ficou registrada como falha (nova tentativa possível após revisão)");
});

// ================================================================================================ ausência de conta ≠ compra nova
const pagarAntes = async (s, valor, venc = "2026-10-10") => {
  const o = await s.conta(venc, valor);
  const g = await s.m.cofre.guardar(s.cx, { conteudo: new TextEncoder().encode(`%PDF-1.4\n% comprovante anterior ${Math.random()}\n%%EOF\n`), tipoMime: "application/pdf" });
  const d = (await s.m.nucleo.registrarDocumento(s.cx, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-09", descricao: "Comprovante anterior (sintético)" })).documento;
  await s.m.nucleo.registrarPagamentoPorComprovante(s.cx, { obrigacaoId: o.obrigacoes[0].id, valorCentavos: valor, dataPagamento: "2026-10-09", documentoId: d.id,
    idTransacao: `E0000000020261009ANTES${String(Math.floor(Math.random() * 1e6)).padStart(10, "0")}`, justificativa: "Pagamento anterior (sintético).", confirmar: true });
  return o;
};

t("AUT-S1 mesmo pagamento já REGISTRADO (conta paga, mesmo fornecedor/valor/data próxima): pergunta antes de criar; 'sim' → nada novo; 'outra compra' → cria a despesa", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800, idTransacao: "E0000000020261010AUTONSEM0000001" }) });
  await pagarAntes(s, 10800);
  const antes = [(await s.contas()).length, (await s.liquidacoes()).length, (await s.despesas()).length];
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("S1") }));
  assert.equal((await s.ultima()).motivo, "POSSIVEL_COMPRA_JA_REGISTRADA");
  assert.match(await s.resposta(), /Já existe um pagamento de R\$ 108,00 para .* registrado/);
  assert.equal(s.escritas().length, 0, "nada foi gravado pelo MOVA");
  await s.enviar(gw({ texto: "sim", grupo: FIN }));
  assert.equal((await s.ultima()).decisao, "DUPLICADO");
  assert.match((await s.saida()).at(-1).texto, /Este pagamento já está registrado/);
  assert.deepEqual([(await s.contas()).length, (await s.liquidacoes()).length, (await s.despesas()).length], antes, "nenhuma despesa, baixa ou saída nova");
  const s2 = await autonomo({ responder: () => PIX({ valorCentavos: 10800, idTransacao: "E0000000020261010AUTONSEM0000002" }) });
  await pagarAntes(s2, 10800);
  await s2.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("S1b") }));
  await s2.enviar(gw({ texto: "outra compra", grupo: FIN }));
  assert.equal((await s2.ultima()).decisao, "EXECUTADO");
  assert.equal((await s2.contas()).length, 2);
});

t("AUT-S2 conta ABERTA de OUTRO fornecedor com o mesmo valor e data próxima: pergunta; 'sim' → baixa DESSA conta (proposta), sem despesa nova", async () => {
  const s = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética", valorCentavos: 10800 }), despesa: null });
  const forn2 = await s.m.nucleo.registrarContraparte(s.c(ORG, ALFA), { tipo: "FORNECEDOR", nome: "Confeitaria Sintética" });
  const o = await s.conta("2026-10-12", 10800, ALFA, forn2);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("S2") }));
  assert.equal((await s.ultima()).motivo, "POSSIVEL_COMPRA_JA_REGISTRADA");
  assert.match(await s.resposta(), /conta de .* com R\$ 108,00 pendentes, de outro fornecedor/);
  await s.enviar(gw({ texto: "sim, é a mesma compra", grupo: FIN })); // "compra" aqui NÃO significa compra nova
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.comando.entrada.obrigacaoId], ["BAIXA_DE_OBRIGACAO", o.obrigacoes[0].id]);
  assert.equal((await s.contas()).length, 1);
});

t("AUT-S3 sem nenhuma evidência parecida: a compra nova segue SEM pergunta (autonomia preservada)", async () => {
  const s = await autonomo({ responder: () => PIX({ favorecido: "Andressa Sintética", valorCentavos: 10800 }) });
  const outroValor = await s.conta("2026-10-12", 77700);
  await s.enviar(gw({ texto: "MOVA brownies para a alfa", doc: pdf("S3") }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.equal((await s.contas()).length, 2);
  assert.equal(await s.saldo(outroValor.obrigacoes[0].id), 77700);
});

t("AUT-B dados bancários do comprovante preservados na proposta (bancos, favorecido, valor, data/hora, ID), sem criar saída nem presumir a compensação", async () => {
  const s = await autonomo({ responder: () => PIX({ valorCentavos: 10800, horaTransacao: "11:06:57", idTransacao: "E0000000020261010AUTONBANCO00001" }), despesa: null });
  await s.conta("2026-10-20", 10800);
  await s.enviar(gw({ texto: "MOVA pagamento da alfa", doc: pdf("B1") }));
  const [p] = await s.propostas();
  assert.deepEqual([p.leitura.instituicao, p.leitura.instituicaoDestino, p.leitura.favorecido, p.leitura.valorCentavos, p.leitura.dataPagamento, p.leitura.horaTransacao, p.leitura.idTransacao],
    ["Banco Sintético", "Banco Destino Sintético", "Fornecedor Sintético", 10800, "2026-10-10", "11:06:57", "E0000000020261010AUTONBANCO00001"]);
  assert.equal(p.conciliacao.situacao, "AGUARDANDO_EXTRATO", "o extrato não foi presumido");
  assert.equal((await s.saidas()).length, 0);
});
