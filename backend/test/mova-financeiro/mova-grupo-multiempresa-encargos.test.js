// MOVA — GRUPO COMPARTILHADO por duas empresas + ENCARGOS COMPROVADOS no comprovante (25/11/2026). Caso de aceitação: boleto de
// energia pago com atraso, juros e multa impressos (espelho SINTÉTICO do caso real; nenhum dado real aqui). Financeiro v2 REAL em
// memória (com FV2_REPOSITORIO=postgres, no PostgreSQL isolado), banco do MOVA no PostgreSQL isolado, IA e Gateway SIMULADOS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";
import { ALFA, FIN, FINANCEIRO, GRUPO, ORG, ORG_X, SO_ALFA, XIS, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { competenciaDaResposta, composicaoComprovada } from "../../src/modules/mova-financeiro/dominio/divergencia.js";
import { validarSaidaDaIa, normalizarSentinelas } from "../../src/modules/mova-financeiro/ia/contratos.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c5";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const SERVICO = "eeeeeeee-0000-4000-8000-0000000000a2";
const fontes = { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"], anotaAiPelaSaipos: false };
const fontesXis = { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"], anotaAiPelaSaipos: false };
const CNPJ_XIS = "00.000.000/0001-91"; // sintético

/** Um grupo com as DUAS empresas (Alfa: ORG; Xis: ORG_X). FIN tem as duas; SO_ALFA só a Alfa. */
const CONFIG = ({ multiempresa = true } = {}) => ({
  modo: "OPERACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Alfa", apelidos: ["alfa"], fontes, pagadores: [{ nome: "ALFA PRODUTOS" }] },
    { organizacaoId: ORG_X, unidadeId: XIS, nome: "Loja Xis", apelidos: ["xis"], fontes: fontesXis, pagadores: [{ nome: "MP ALIMENTOS LTDA" }, { documento: CNPJ_XIS }] },
  ],
  gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA, XIS], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", ...(multiempresa === null ? {} : { multiempresa }), participantes: [
    { ids: [FIN], perfil: "FINANCEIRO", nome: "Financeiro" }, { ids: [SO_ALFA], perfil: "FINANCEIRO", unidades: [ALFA] },
  ] }],
});

const pdf = (marca) => `%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`;
let seq = 0;
/** Boleto de energia pago com atraso: original 8.671,81 + juros 5,77 + multa 173,44 = 8.851,02 (sem competência impressa). */
const BOLETO_PAGO = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 885102, valorOriginalCentavos: 867181,
  jurosCentavos: 577, multaCentavos: 17344, descontoCentavos: null, vencimento: "2026-10-12", dataPagamento: "2026-10-14", competencia: null,
  favorecido: "Energia Sintética Associação", pagador: "MP ALIMENTOS LTDA", documentoPagador: CNPJ_XIS, instituicao: "Banco Sintético",
  linhaDigitavel: "83660000001 2 88510200481 3 00000000000 0 00000000000 0", idTransacao: `AUT20261014ENERGIA${String(++seq).padStart(4, "0")}`,
  situacaoTransacao: "CONCLUIDA", categoriaSugerida: "ENERGIA_ELETRICA", ...x });

const POL = (operacao, org, u, x = {}) => ({ operacao, organizacaoId: org, unidadeId: u, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 2_000_000,
  responsavel: "Administrador Sintético", motivo: `Política sintética ${operacao} (grupo multiempresa)`, vigenteDe: "2026-10-01", ...x });
const ACOES = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_juros"];
const ESCRITAS = ["enviarEvidencia", "registrarDespesaPagaComEncargo", "registrarDespesaPagaPorComprovante", "registrarPagamentoComEncargo", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar"];

async function grupo({ responder, config = CONFIG(), concessoes = [[ORG, ALFA], [ORG_X, XIS]], politicaJuros = true, membros = [FIN] } = {}) {
  const s = await cenario({
    responder, config,
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true, criarContas: true, registrarJuros: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: SERVICO,
        concessoes: criarConcessoesMemoria(concessoes.map(([organizacaoId, unidadeId]) => ({ organizacaoId, usuarioId: OPERADOR, unidadeId, acoes: ACOES }))) }),
    }),
  });
  if (process.env.FV2_REPOSITORIO === "postgres") for (const [o, u] of concessoes) await s.m.nucleo.concederAcesso(s.c(o, u), { usuarioId: OPERADOR, acoes: ACOES, justificativa: "Identidade operacional do MOVA (sintético)." });
  for (const [o, u] of [[ORG, ALFA], [ORG_X, XIS]]) {
    for (const op of ["DESPESA_DOCUMENTAL", "BAIXA_DOCUMENTAL", ...(politicaJuros ? ["JUROS_DOCUMENTAL"] : [])]) await s.mova.armazenamento.politicas.criar(POL(op, o, u), { criadaPor: HUMANO });
  }
  // Retrato recente dos membros do grupo: valores no grupo só se TODOS forem autorizados na empresa da mensagem.
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: AGORA.toISOString() });
  const reg = (o, u, tipo) => s.m.nucleo.consultarRegistros(s.c(o, u), { tipo });
  return {
    ...s,
    contas: (o, u) => reg(o, u, "OBRIGACAO"), liquidacoes: (o, u) => reg(o, u, "LIQUIDACAO"), ajustes: (o, u) => reg(o, u, "AJUSTE"),
    saidas: async (o, u) => (await reg(o, u, "MOVIMENTACAO")).filter((m) => m.sentido === "SAIDA"),
    despesas: async (o, u) => (await reg(o, u, "LANCAMENTO")).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA"),
    documentos: (o, u) => reg(o, u, "DOCUMENTO"),
    escritas: () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome)),
    respostas: async () => (await s.saida()).map((r) => r.texto),
    fornecedorXis: () => s.m.nucleo.registrarContraparte(s.c(ORG_X, XIS), { tipo: "FORNECEDOR", nome: "Energia Sintética Associação" }),
  };
}

// ------------------------------------------------------------------ regras puras
test("GM-0 composição comprovada: soma exata centavo a centavo; sem encargo, com desconto ou soma que não fecha ⇒ null (genérico)", () => {
  assert.deepEqual(composicaoComprovada({ valorCentavos: 885102, valorOriginalCentavos: 867181, jurosCentavos: 577, multaCentavos: 17344 }),
    { principalCentavos: 867181, jurosCentavos: 577, multaCentavos: 17344, encargoCentavos: 17921 });
  assert.equal(composicaoComprovada({ valorCentavos: 885103, valorOriginalCentavos: 867181, jurosCentavos: 577, multaCentavos: 17344 }), null, "um centavo de diferença");
  assert.equal(composicaoComprovada({ valorCentavos: 867181, valorOriginalCentavos: 867181 }), null, "sem encargo");
  assert.equal(composicaoComprovada({ valorCentavos: 10500, valorOriginalCentavos: 10000, jurosCentavos: 1000, descontoCentavos: 500 }), null, "desconto: fluxo normal");
  assert.equal(composicaoComprovada({ valorCentavos: 10200, valorOriginalCentavos: null, jurosCentavos: 200 }), null, "sem valor original impresso");
  for (const [txt, comp] of [["outubro", "2026-10"], ["11/2026", "2026-11"], ["nov/26", "2026-11"], ["mês 9", "2026-09"], ["dezembro", "2025-12"], ["é de setembro", "2026-09"], ["sim", null], ["paguei ontem", null]]) {
    assert.equal(competenciaDaResposta(txt, "2026-10-14"), comp, txt);
  }
  // Leitura: os campos novos usam sentinela 0/"" e são validados (nunca negativos).
  const lida = normalizarSentinelas({ ...BOLETO_PAGO(), descontoCentavos: 0, jurosCentavos: 577 });
  const v = validarSaidaDaIa(lida);
  assert.ok(v.ok, v.erro);
  assert.deepEqual([v.saida.descontoCentavos, v.saida.jurosCentavos], [null, 577]);
  assert.equal(validarSaidaDaIa({ ...BOLETO_PAGO(), multaCentavos: -1 }).erro, "multaCentavos");
});

test("GM-1 grupo com DUAS empresas exige a marca multiempresa; com ela, a conversa privada derivada tem as duas e o restrito só a sua", () => {
  assert.throws(() => validarConfiguracao(CONFIG({ multiempresa: null })), /multiempresa/);
  assert.throws(() => validarConfiguracao(CONFIG({ multiempresa: false })), /multiempresa/);
  const cfg = validarConfiguracao(CONFIG());
  const g = cfg.gruposAutorizados.find((x) => x.grupoId === GRUPO);
  assert.deepEqual([g.multiempresa, [...g.unidades].sort()], [true, [ALFA, XIS].sort()]);
  const privFin = cfg.gruposAutorizados.find((x) => x.derivada && x.grupoId === FIN);
  const privAlfa = cfg.gruposAutorizados.find((x) => x.derivada && x.grupoId === SO_ALFA);
  assert.deepEqual([[...privFin.unidades].sort(), [...privAlfa.unidades]], [[ALFA, XIS].sort(), [ALFA]], "permissão validada por empresa");
});

// ------------------------------------------------------------------ fluxo completo (grupo → MOVA → Financeiro v2)
t("GM-2 ACEITAÇÃO: boleto pago com juros e multa impressos, sem conta cadastrada → NÃO pergunta juros; pergunta só o mês; conta nova pelo original + encargos + pagamento total, PAGO, comprovante anexado, só na empresa do titular", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO() });
  await s.enviar(gw({ texto: "MOVA energia", doc: pdf("GM2") }));
  const h1 = await s.ultima();
  assert.deepEqual([h1.decisao, h1.motivo, h1.unidadeId], ["PEDIR_INFORMACAO", "COMPETENCIA_AUSENTE", XIS], "unidade pelo titular; nenhuma pergunta de juros");
  assert.match((await s.respostas()).at(-1), /Qual é o mês de referência dessa conta\?/);
  assert.doesNotMatch((await s.respostas()).at(-1), /juros/i);
  assert.equal(s.escritas().length, 0, "a pergunta não grava nada");
  await s.enviar(gw({ texto: "outubro" }));
  const h2 = await s.ultima();
  assert.deepEqual([h2.decisao, h2.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"]);
  const [conta] = await s.contas(ORG_X, XIS);
  assert.deepEqual([conta.valorBaseCentavos, conta.saldoCentavos, conta.situacao, conta.vencimento, conta.competencia], [867181, 0, "QUITADA", "2026-10-12", "2026-10"]);
  assert.deepEqual((await s.despesas(ORG_X, XIS)).map((l) => [l.categoria, l.valorCentavos]).sort(), [["ENERGIA", 867181], ["JUROS_E_MULTAS_DE_FORNECEDORES", 17921]].sort(), "não classifica tudo como energia");
  const [aj] = await s.ajustes(ORG_X, XIS);
  assert.match(aj.motivo, /juros R\$\s?5,77, multa R\$\s?173,44/, "detalhamento de juros e multa preservado");
  const liqs = await s.liquidacoes(ORG_X, XIS);
  assert.deepEqual([liqs.length, liqs[0].valorCentavos, liqs[0].movimentacaoId, liqs[0].dataEfetiva], [1, 885102, null, "2026-10-14"], "pagamento total, sem saída fictícia");
  assert.deepEqual([(await s.saidas(ORG_X, XIS)).length, (await s.documentos(ORG_X, XIS)).length], [0, 1]);
  assert.deepEqual([(await s.contas(ORG, ALFA)).length, (await s.despesas(ORG, ALFA)).length], [0, 0], "nada na outra empresa");
  assert.ok(s.escritas().every((x) => x.organizacaoId === ORG_X && x.unidadeId === XIS));
  const w = s.escritas().find((x) => x.nome === "registrarDespesaPagaComEncargo");
  assert.ok(w, "operação estreita com encargo");
  assert.equal(w.permissoes.length, 5, "[ver + 4 ações estreitas]");
  const msg = (await s.respostas()).at(-1);
  for (const re of [/Loja Xis/, /MP ALIMENTOS LTDA/, /Energia Sintética/, /Valor original R\$\s?8\.671,81/, /Juros R\$\s?5,77/, /Multa R\$\s?173,44/, /Total pago R\$\s?8\.851,02/, /Vencimento 12\/10\/2026/, /Situação: PAGO/, /conta nova criada/, /comprovante ficou anexado/i]) assert.match(msg, re);
  // Reenvio do mesmo comprovante: nada duplica.
  await s.enviar(gw({ texto: "MOVA energia", doc: pdf("GM2") }));
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1]);
});

t("GM-3 conta EXISTENTE com o saldo igual ao original impresso: baixa com juros e multa sem pergunta; uma conta, um pagamento, um ajuste", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10" }) });
  const f = await s.fornecedorXis();
  const o = await s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: f.id, valorOriginalCentavos: 867181, categoria: "ENERGIA", descricao: "Energia sintética",
    competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-12" });
  await s.enviar(gw({ texto: "MOVA conta de energia", doc: pdf("GM3") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"], "sem pergunta de juros");
  const t1 = (await s.m.nucleo.detalharContaAPagar(s.c(ORG_X, XIS), { id: o.obrigacoes[0].id })).titulo;
  assert.deepEqual([t1.saldoCentavos, t1.pagoCentavos], [0, 885102]);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length, (await s.ajustes(ORG_X, XIS)).length, (await s.saidas(ORG_X, XIS)).length], [1, 1, 1, 0]);
  assert.match((await s.respostas()).at(-1), /juros de R\$\s?5,77 e multa de R\$\s?173,44.*Conta já cadastrada/s);
});

t("GM-4 soma que NÃO fecha: o MOVA não presume encargo (pergunta) e nada é gravado", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10", multaCentavos: 17000 }) });
  const f = await s.fornecedorXis();
  await s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: f.id, valorOriginalCentavos: 867181, categoria: "ENERGIA", descricao: "Energia sintética",
    competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-12" });
  await s.enviar(gw({ texto: "MOVA energia", doc: pdf("GM4") }));
  assert.equal((await s.ultima()).decisao, "PEDIR_INFORMACAO");
  assert.equal(s.escritas().length, 0);
});

t("GM-5 participante só da Alfa envia comprovante do titular da Xis: nada gravado em nenhuma empresa e nenhum dado da Xis revelado", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10" }) });
  await s.enviar(gw({ texto: "MOVA energia", de: SO_ALFA, doc: pdf("GM5") }));
  assert.equal(s.escritas().length, 0);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.contas(ORG, ALFA)).length], [0, 0]);
  assert.doesNotMatch((await s.respostas()).join("\n"), /8\.851,02|8\.671,81|Energia Sintética/, "nenhum valor ou fornecedor da outra empresa");
});

t("GM-7 grupo com um membro SEM acesso à empresa do comprovante: os valores não saem no grupo (vão ao privado de quem enviou)", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10" }), membros: [FIN, SO_ALFA] });
  await s.enviar(gw({ texto: "MOVA energia", doc: pdf("GM7") }));
  const saidas = await s.saida();
  assert.ok(saidas.filter((r) => r.destino === GRUPO).every((r) => !/8\.851,02/.test(r.texto)), "valores fora do grupo");
  assert.ok(saidas.some((r) => r.destino === FIN && /8\.851,02/.test(r.texto)), "no privado de quem enviou");
});

t("GM-6 sem a política de ENCARGO (JUROS_DOCUMENTAL) a compra com juros não é executada sozinha: fica proposta, nada gravado", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10" }), politicaJuros: false });
  await s.enviar(gw({ texto: "MOVA energia", doc: pdf("GM6") }));
  assert.notEqual((await s.ultima()).decisao, "EXECUTADO");
  assert.equal(s.escritas().filter((x) => x.nome !== "enviarEvidencia").length, 0);
  assert.equal((await s.contas(ORG_X, XIS)).length, 0);
  assert.doesNotMatch((await s.respostas()).at(-1), /registrada e paga/);
});

// ------------------------------------------------------------------ 25/11: período da legenda + identificação da conta + E2E recortado
import { contaCompativelComPeriodo, idTransacaoConfiavel, periodoDaLegenda } from "../../src/modules/mova-financeiro/dominio/periodo.js";

const E2E = (n) => `E00000000202611251451${String(n).padStart(11, "0")}`; // forma completa (32), sintético
/** Pix de benefício a uma funcionária SINTÉTICA (espelha o caso real sem dado real): R$ 90, sem competência impressa. */
const PIX_BENEFICIO = (x = {}) => BOLETO_PAGO({ valorCentavos: 9000, valorOriginalCentavos: null, jurosCentavos: null, multaCentavos: null, linhaDigitavel: null,
  vencimento: null, dataPagamento: "2026-10-14", favorecido: "Fulana Sintética de Sousa", categoriaSugerida: "VALE_REFEICAO", idTransacao: E2E(++seq), ...x });
const LEG = "MOVA Vale refeição entre os dias 08/10 a 14/10 Fulana loja xis";

test("PE-0 período pela legenda: inequívoco vira competência; dois meses ⇒ ambíguo; data do pagamento nunca vira competência; E2E recortado descartado", () => {
  const p = (t) => periodoDaLegenda(t, "2026-11-25");
  assert.deepEqual(p("Vale refeição entre os dias 24/11 a 30/11 Fulana"), { inicio: "2026-11-24", fim: "2026-11-30", competencia: "2026-11", ambigua: false, meses: ["2026-11"] });
  for (const [t, c] of [["Aluguel referente a novembro", "2026-11"], ["Vale-transporte da primeira semana de dezembro", "2026-12"], ["Energia referente a outubro", "2026-10"],
    ["Pagamento dos entregadores de 16/11 a 22/11", "2026-11"], ["salário 10/2026", "2026-10"]]) assert.equal(p(t).competencia, c, t);
  for (const t of ["VT de 28/11 a 04/12", "comissão outubro e novembro"]) assert.deepEqual([p(t).competencia, p(t).ambigua], [null, true], t);
  for (const t of ["pago 25/11/2026", "FIT", "", null]) assert.equal(p(t), null, String(t));
  const per = p("VR 24/11 a 30/11");
  assert.equal(contaCompativelComPeriodo({ competencia: "2026-11", descricao: "Vale-refeição Fulana 17/11 a 23/11" }, per), false, "outra semana");
  assert.equal(contaCompativelComPeriodo({ competencia: "2026-10", descricao: "Vale-refeição" }, per), false, "outra competência");
  assert.equal(contaCompativelComPeriodo({ competencia: "2026-11", descricao: "Vale-refeição Fulana 24/11 a 30/11" }, per), true);
  assert.equal(contaCompativelComPeriodo({ competencia: "2026-11", descricao: "Vale-refeição" }, per), true, "sem período na conta: decide pelos demais critérios");
  assert.equal(contaCompativelComPeriodo({ competencia: "2026-10" }, null), true, "sem período informado: regra antiga");
  assert.equal(idTransacaoConfiavel(E2E(1)), E2E(1));
  assert.equal(idTransacaoConfiavel("E0000000020261125145"), null, "E2E cortado");
  assert.equal(idTransacaoConfiavel("AUT123456"), "AUT123456");
});

t("PE-1 benefício pago sem conta: competência pela legenda (sem pergunta), conta nova + pagamento na mesma transação, categoria de benefício", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO() });
  await s.enviar(gw({ texto: LEG, doc: pdf("PE1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["EXECUTADO", XIS], h.motivo);
  const [conta] = await s.contas(ORG_X, XIS);
  assert.deepEqual([conta.valorBaseCentavos, conta.situacao, conta.competencia], [9000, "QUITADA", "2026-10"]);
  assert.deepEqual((await s.despesas(ORG_X, XIS)).map((l) => l.categoria), ["VALE_REFEICAO"]);
  assert.equal((await s.liquidacoes(ORG_X, XIS)).length, 1);
  assert.match((await s.respostas()).at(-1), /Situação: PAGO/);
});

t("PE-2 conta EM ABERTO da mesma pessoa e mesmo valor, mas de OUTRA semana: não é baixada; a semana paga ganha conta própria", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO() });
  const f = await s.m.nucleo.registrarContraparte(s.c(ORG_X, XIS), { tipo: "FORNECEDOR", nome: "Fulana Sintética de Sousa" });
  const antiga = await s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: f.id, valorOriginalCentavos: 9000, categoria: "VALE_REFEICAO",
    descricao: "Vale-refeição Fulana 01/10 a 07/10", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-08" });
  await s.enviar(gw({ texto: LEG, doc: pdf("PE2") }));
  const contas = await s.contas(ORG_X, XIS);
  void antiga; const velha = contas.find((c) => String(c.descricao).includes("01/10 a 07/10"));
  assert.deepEqual([velha.saldoCentavos, velha.situacao], [9000, "ABERTA"], "a semana anterior continua em aberto");
  assert.equal(contas.length, 2);
  assert.ok(s.escritas().every((x) => x.nome !== "registrarPagamentoPorComprovante" || x.contaId !== velha.id));
});

t("PE-3 conta em aberto da MESMA semana: baixa a existente, sem criar outra", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO() });
  const f = await s.m.nucleo.registrarContraparte(s.c(ORG_X, XIS), { tipo: "FORNECEDOR", nome: "Fulana Sintética de Sousa" });
  await s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: f.id, valorOriginalCentavos: 9000, categoria: "VALE_REFEICAO",
    descricao: "Vale-refeição Fulana 08/10 a 14/10", competencia: "2026-10", dataEmissao: "2026-10-08", vencimento: "2026-10-14" });
  await s.enviar(gw({ texto: LEG, doc: pdf("PE3") }));
  const contas = await s.contas(ORG_X, XIS);
  assert.deepEqual([contas.length, contas[0].situacao], [1, "QUITADA"], (await s.ultima()).motivo);
});

t("PE-4 período que atravessa dois meses: pergunta só o mês; nada gravado", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO() });
  await s.enviar(gw({ texto: "MOVA Vale transporte de 28/10 a 03/11 Fulana loja xis", doc: pdf("PE4") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "COMPETENCIA_AUSENTE"]);
  assert.equal(s.escritas().length, 0);
});

t("PE-5 E2E recortado: não serve de chave nem permite baixa automática; pede o comprovante completo; reenvio em outro arquivo não grava nada", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO({ idTransacao: "E0000000020261125145" }) });
  await s.enviar(gw({ texto: LEG, doc: pdf("PE5a") }));
  const h = await s.ultima();
  assert.notEqual(h.decisao, "EXECUTADO", "sem identificador confiável: não executa sozinho");
  assert.equal(s.escritas().length, 0);
  assert.match((await s.respostas()).at(-1), /comprovante completo/);
  await s.enviar(gw({ texto: LEG, doc: pdf("PE5b") }));
  assert.notEqual((await s.ultima()).motivo, "TRANSACAO_JA_RECEBIDA", "id recortado não decide duplicidade");
  assert.deepEqual([s.escritas().length, (await s.liquidacoes(ORG_X, XIS)).length], [0, 0]);
});
