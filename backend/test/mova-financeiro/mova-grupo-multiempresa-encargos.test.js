// MOVA — GRUPO COMPARTILHADO por duas empresas + ENCARGOS COMPROVADOS no comprovante (25/11/2026). Caso de aceitação: boleto de
// energia pago com atraso, juros e multa impressos (espelho SINTÉTICO do caso real; nenhum dado real aqui). Financeiro v2 REAL em
// memória (com FV2_REPOSITORIO=postgres, no PostgreSQL isolado), banco do MOVA no PostgreSQL isolado, IA e Gateway SIMULADOS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";
import { ALFA, CONS, ESTRANHO, FIN, FINANCEIRO, GRUPO, ORG, ORG_X, SO_ALFA, XIS, base, cenario, gw, t } from "./helpers/operacao.js";
import { podeConfirmarPendencia } from "../../src/modules/mova-financeiro/dominio/confirmacao.js";
import { criarPortaOperacional, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { competenciaDaResposta, composicaoComprovada, extracaoDaRespostaIA } from "../../src/modules/mova-financeiro/dominio/divergencia.js";
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
    // 25/11: como em produção — cadastrado pelo NÚMERO; no grupo o WhatsApp entrega o LID e o telefone (participantPn) junto.
    { ids: [GERENTE_TEL], telefones: [GERENTE_E164], perfil: "FINANCEIRO", nome: "Gerente Sintético" },
    { ids: [CONS], perfil: "CONSULTA", nome: "Só consulta" },
  ] }],
});

const GERENTE_TEL = "5500000000301@s.whatsapp.net";
const GERENTE_E164 = "+5500000000301";
const GERENTE_LID = "88000000000301@lid";
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

async function grupo({ responder, config = CONFIG(), concessoes = [[ORG, ALFA], [ORG_X, XIS]], politicaJuros = true, membros = [FIN], controle = null } = {}) {
  const s = await cenario({
    responder, config,
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true, criarContas: true, registrarJuros: true,
      operacional: ((real) => (controle ? { identidade: real.identidade, pode: async (...x) => (controle.ligada ? real.pode(...x) : false), chamar: (...x) => real.chamar(...x) } : real))(criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: SERVICO,
        concessoes: criarConcessoesMemoria(concessoes.map(([organizacaoId, unidadeId]) => ({ organizacaoId, usuarioId: OPERADOR, unidadeId, acoes: ACOES }))) })),
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
  for (const [txt, comp] of [["outubro", "2026-10"], ["11/2026", "2026-11"], ["nov/26", "2026-11"], ["mês 9", "2026-09"], ["dezembro", "2025-12"], ["é de setembro", "2026-09"], ["sim", null], ["paguei ontem", null], ["Mês de novembro, dia 25", "2026-11"], ["outubro dia 14", "2026-10"], ["novembro de 26", "2026-11"]]) {
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
const LEG = "Vale refeição entre os dias 08/10 a 14/10 Fulana loja xis";

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
  await s.enviar(gw({ texto: "Vale transporte de 28/10 a 03/11 Fulana loja xis", doc: pdf("PE4") }));
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

// ------------------------------------------------------------------ 25/11: comprovante no grupo SEM o nome "MOVA" (caso real do Açaí)
t("DOC-1 comprovante com legenda simples, sem 'MOVA', de participante da lista: processado e respondido; sem legenda, texto comum e pessoa fora da lista: ignorados", async () => {
  const s = await grupo({ responder: () => PIX_BENEFICIO({ favorecido: "Prestador Sintético de Ar", pagador: "ALFA PRODUTOS", documentoPagador: null, valorCentavos: 26000, categoriaSugerida: null }) });
  const r = await s.enviar(gw({ texto: "Serviço de manutenção e limpeza ar condicionado loja alfa", doc: pdf("DOC1") }));
  assert.notEqual(r.status, "IGNORADO", JSON.stringify(r));
  const h = await s.ultima();
  assert.equal(h.unidadeId, ALFA, "unidade pelo titular");
  assert.ok((await s.respostas()).length >= 1, "o participante recebe resposta");
  // Casos negativos numa sessão NOVA (na mesma sessão a conversa aberta aciona por continuidade, como já era).
  const n = await grupo({ responder: () => { throw new Error("IA não deve ser chamada"); } });
  assert.equal((await n.enviar(gw({ doc: pdf("DOC1-sem-legenda") }))).motivo, "NAO_ACIONADO", "arquivo sem legenda");
  assert.equal((await n.enviar(gw({ texto: "bom dia, pessoal" }))).motivo, "NAO_ACIONADO", "conversa comum continua exigindo o nome");
  assert.equal((await n.enviar(gw({ texto: "Serviço de manutenção", doc: pdf("DOC1-x"), de: "5500000009999@s.whatsapp.net" }))).motivo, "PARTICIPANTE_NAO_AUTORIZADO");
});

// ------------------------------------------------------------------ 25/11: continuidade e colaboração no grupo (homologação real do R$ 260)
const entregar = (s, providerMessageId) => s.banco.pool.query("update mova.resposta set estado = 'ENVIADA', provider_message_id = $1 where seq = (select max(seq) from mova.resposta where grupo_jid = $2)", [providerMessageId, GRUPO]);
const doGerente = (x) => gw({ de: GERENTE_LID, telefone: GERENTE_E164, ...x });
const relacoes = async (s) => (await s.mova.armazenamento.historico.todos()).filter((x) => x.decisao === "RELACIONADA");
const abertas = async (s) => Number((await s.banco.pool.query("select count(*)::int n from mova.mensagem_pendente where resolvida_em is null")).rows[0].n);
async function perguntaDoMes(s, marca, x = {}) {
  await s.enviar(doGerente({ texto: "Energia da loja xis", doc: pdf(marca), ...x }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "COMPETENCIA_AUSENTE"], JSON.stringify(h));
  await entregar(s, `3EB0PERGUNTA${marca}`);
  return `3EB0PERGUNTA${marca}`;
}

test("CO-0 regra pura: complemento (competência/descrição/unidade) por outro FINANCEIRO da unidade no MESMO grupo; confirmação de efeito só por quem enviou; LID reconhecido pelo telefone", () => {
  const cfg = validarConfiguracao(CONFIG());
  const origem = { participanteId: GERENTE_LID, telefoneE164: GERENTE_E164, grupoId: GRUPO };
  const p = (quem, pend) => podeConfirmarPendencia(cfg, origem, { grupoId: GRUPO, telefoneE164: null, ...quem }, { unidadeId: XIS, ...pend }).motivo;
  assert.equal(p({ participanteId: GERENTE_LID, telefoneE164: GERENTE_E164 }, { tipo: "MAIOR" }), "MESMO_IDENTIFICADOR");
  assert.equal(p({ participanteId: GERENTE_TEL }, { tipo: "MAIOR" }), "MESMA_PESSOA_AUTORIZADA", "a mesma pessoa pelo número (privado × LID)");
  assert.equal(p({ participanteId: FIN }, { tipo: "COMPETENCIA" }), "COMPLEMENTO_DE_FINANCEIRO_AUTORIZADO");
  assert.equal(p({ participanteId: FIN }, { tipo: "DESCRICAO" }), "COMPLEMENTO_DE_FINANCEIRO_AUTORIZADO");
  assert.equal(p({ participanteId: FIN }, { tipo: null }), "COMPLEMENTO_DE_FINANCEIRO_AUTORIZADO", "pergunta de unidade");
  for (const tipo of ["MAIOR", "MENOR", "VARIAS", "SEMELHANTE", "NOVA_OU_CONTA"]) assert.equal(p({ participanteId: FIN }, { tipo }), "OUTRO_PARTICIPANTE", `confirmação de efeito ${tipo}`);
  assert.equal(p({ participanteId: CONS }, { tipo: "COMPETENCIA" }), "SEM_PERMISSAO_FINANCEIRA_NA_UNIDADE", "perfil só de consulta");
  assert.equal(p({ participanteId: SO_ALFA }, { tipo: "COMPETENCIA" }), "UNIDADE_FORA_DA_CONVERSA", "financeiro só de outra empresa");
  assert.equal(p({ participanteId: ESTRANHO }, { tipo: "COMPETENCIA" }), "NAO_AUTORIZADO_NESTA_CONVERSA");
  assert.equal(podeConfirmarPendencia(cfg, origem, { participanteId: FIN, grupoId: FIN }, { unidadeId: XIS, tipo: "COMPETENCIA" }).pode, false, "na conversa privada de outra pessoa: nunca");
});

t("CO-1 caso real: quem enviou aparece no grupo pelo LID e responde CITANDO a pergunta com mês e dia ('Mês de outubro, dia 14') → continua e paga; reenvio não duplica", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO() });
  const q = await perguntaDoMes(s, "CO1");
  await s.enviar(doGerente({ texto: "Mês de outubro, dia 14", respostaA: q }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"], JSON.stringify(h));
  assert.doesNotMatch((await s.respostas()).join("\n"), /outra pessoa/);
  const [conta] = await s.contas(ORG_X, XIS);
  assert.equal(conta.competencia, "2026-10");
  assert.deepEqual((await relacoes(s)).map((x) => x.motivo), ["RESPOSTA_CITANDO_PERGUNTA"]);
  await s.enviar(doGerente({ texto: "Energia da loja xis", doc: pdf("CO1") }));
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1], "sem duplicidade");
});

t("CO-2 OUTRO integrante FINANCEIRO da empresa completa a competência citando a pergunta → continua; a auditoria guarda quem enviou e quem completou", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO() });
  const q = await perguntaDoMes(s, "CO2");
  await s.enviar(gw({ de: FIN, texto: "outubro", respostaA: q }));
  const h = await s.ultima();
  assert.equal(h.decisao, "EXECUTADO", JSON.stringify(h));
  const [rel] = await relacoes(s);
  assert.equal(rel.participanteId, FIN, "quem completou");
  const ev = (await s.banco.pool.query("select participante_jid from mova.evento where evento_id = $1", [rel.retomou])).rows[0];
  assert.equal(ev.participante_jid, GERENTE_LID, "quem enviou o documento");
  assert.equal((await s.contas(ORG_X, XIS)).length, 1);
});

t("CO-3 fora da lista é descartado; perfil só de consulta e financeiro só da OUTRA empresa são recusados SEM consumir a pendência; depois o autorizado completa", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO() });
  const q = await perguntaDoMes(s, "CO3");
  assert.equal((await s.enviar(gw({ de: ESTRANHO, texto: "outubro", respostaA: q }))).motivo, "PARTICIPANTE_NAO_AUTORIZADO");
  await s.enviar(gw({ de: CONS, texto: "outubro", respostaA: q }));
  let h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "RESPOSTA_RECUSADA:SEM_PERMISSAO_FINANCEIRA_NA_UNIDADE"]);
  await s.enviar(gw({ de: SO_ALFA, texto: "outubro", respostaA: q }));
  h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "RESPOSTA_RECUSADA:UNIDADE_FORA_DA_CONVERSA"]);
  assert.equal(s.escritas().length, 0, "nada gravado pelas recusas");
  assert.equal(await abertas(s), 1, "a pendência continua aberta");
  await s.enviar(doGerente({ texto: "outubro", respostaA: q }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
});

t("CO-4 duas pendências ao mesmo tempo: a resposta citando a SEGUNDA pergunta só continua a segunda; a primeira segue aberta", async () => {
  let n = 0;
  const s = await grupo({ responder: () => (++n === 1 ? BOLETO_PAGO() : BOLETO_PAGO({ valorCentavos: 50000, valorOriginalCentavos: null, jurosCentavos: null, multaCentavos: null, favorecido: "Outro Fornecedor Sintético", linhaDigitavel: null })) });
  await perguntaDoMes(s, "CO4A");
  const q2 = await perguntaDoMes(s, "CO4B");
  await s.enviar(gw({ de: FIN, texto: "outubro", respostaA: q2 }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO", JSON.stringify(await s.ultima()));
  assert.deepEqual((await s.contas(ORG_X, XIS)).map((x) => x.valorBaseCentavos), [50000], "só a segunda");
  assert.equal(await abertas(s), 1);
});

t("CO-5 figurinha, só emoji e conversa ('kkkk valeu') durante uma pendência: nenhuma resposta, nenhuma apresentação; depois continua", async () => {
  let n = 0; // a leitura real de "kkkk valeu" é conversa (OUTRA), não um boleto
  const s = await grupo({ responder: () => (++n === 1 ? BOLETO_PAGO() : base({})) });
  const q = await perguntaDoMes(s, "CO5");
  const antes = (await s.respostas()).length;
  assert.equal((await s.enviar({ ...doGerente({}), tipo: "OUTRO", texto: null })).motivo, "NAO_ACIONADO", "figurinha");
  assert.equal((await s.enviar(doGerente({ texto: "👍😂" }))).motivo, "NAO_ACIONADO", "só emoji");
  await s.enviar(doGerente({ texto: "kkkk valeu" }));
  assert.equal((await s.respostas()).length, antes, "nada respondido: " + (await s.respostas()).at(-1) + " | " + JSON.stringify(await s.ultima()));
  assert.doesNotMatch((await s.respostas()).join("\n"), /Sou o MOVA/);
  await s.enviar(doGerente({ texto: "outubro", respostaA: q }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
});

t("CO-6 REINÍCIO entre a pergunta e a resposta: a pendência está no banco e a resposta citando a pergunta continua uma única vez", async () => {
  const s = await grupo({ responder: () => BOLETO_PAGO() });
  const q = await perguntaDoMes(s, "CO6");
  s.reiniciar();
  await s.enviar(gw({ de: FIN, texto: "outubro", respostaA: q }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  await s.enviar(gw({ de: FIN, texto: "outubro", respostaA: q }));
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1], "a segunda resposta não paga de novo");
});

// ------------------------------------------------------------------ 25/11: resposta NATURAL (IA só quando as regras curtas não entendem; o backend valida)
const LEITURA = (x) => base({ tipoDocumento: "OUTRO", intencao: "INFORMAR_PAGAMENTO", ...x });
const comIa = (leituras) => { let n = 0; const chamadas = []; const responder = () => { n += 1; if (n === 1) return BOLETO_PAGO(); chamadas.push(n); const l = leituras.shift(); if (l instanceof Error) throw l; return l; }; return { responder, chamadas }; };

test("RN-0 extração da IA é VALIDADA: ano só se escrito com 4 dígitos; o dia nunca vira ano; mês fora da janela ou formato inválido ⇒ null", () => {
  const ex = (competencia, texto, pag = "2026-11-25") => extracaoDaRespostaIA({ competencia }, { texto, dataPagamento: pag }).competencia;
  assert.equal(ex("2025-11", "Novembro de 2026. dia 25"), "2026-11", "o ano escrito prevalece sobre o do modelo");
  assert.equal(ex("2025-11", "referente a novembro, dia 25"), "2026-11", "sem ano escrito: o do pagamento (o modelo não escolhe ano)");
  assert.equal(ex("2026-11", "mês de novembro"), "2026-11");
  assert.equal(ex("2026-13", "mês 13"), null, "formato inválido");
  assert.equal(ex("2019-11", "novembro de 2019"), null, "fora da janela de sanidade");
  assert.equal(ex("2026-11", "novembro", null), null, "sem data de pagamento não há como validar");
  const t2 = extracaoDaRespostaIA({ finalidadePagamento: "QUALQUER", categoriaSugerida: "manutencao; drop", jurosCentavos: -5, multaCentavos: 1.5, descricaoCompra: "" }, { dataPagamento: "2026-11-25" });
  assert.deepEqual([t2.finalidade, t2.categoria, t2.jurosCentavos, t2.multaCentavos, t2.descricao], [null, null, null, null, null], "nada fora do contrato passa");
});

t("RN-1 caso real: resposta natural que as regras curtas não entendem ('foi o serviço de outubro lá da loja xis') citando a pergunta → a IA lê, o backend valida, a operação ORIGINAL continua uma única vez", async () => {
  const { responder, chamadas } = comIa([LEITURA({ competencia: "2026-10" })]);
  const s = await grupo({ responder });
  const q = await perguntaDoMes(s, "RN1");
  await s.enviar(doGerente({ texto: "foi o serviço de outubro lá da loja xis", respostaA: q }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao], ["EXECUTADO", "PAGO_POR_COMPROVANTE"], JSON.stringify(h));
  assert.equal(chamadas.length, 1, "uma leitura por IA");
  const [conta] = await s.contas(ORG_X, XIS);
  assert.deepEqual([conta.competencia, conta.valorBaseCentavos], ["2026-10", 867181], "competência validada; valor/fornecedor do comprovante original");
  await s.enviar(doGerente({ texto: "foi o serviço de outubro lá da loja xis", respostaA: q }));
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1], "sem duplicidade");
});

t("RN-2 respostas simples NÃO chamam a IA (custo zero): 'outubro', 'Mês de outubro, dia 14', '10/2026', 'mês 10'", async () => {
  for (const [i, txt] of ["outubro", "Mês de outubro, dia 14", "10/2026", "mês 10", "Referente a outubro"].entries()) {
    const { responder, chamadas } = comIa([]);
    const s = await grupo({ responder });
    const q = await perguntaDoMes(s, `RN2${i}`);
    await s.enviar(doGerente({ texto: txt, respostaA: q }));
    assert.equal((await s.ultima()).decisao, "EXECUTADO", txt);
    assert.equal(chamadas.length, 0, `sem IA: ${txt}`);
    assert.equal((await s.contas(ORG_X, XIS))[0].competencia, "2026-10", txt);
  }
});

t("RN-3 o modelo erra o ano ('dia 25' virando 2025): o backend mantém o ano do pagamento; formato inválido ⇒ pergunta de novo e nada é gravado", async () => {
  const { responder } = comIa([LEITURA({ competencia: "2025-10" }), LEITURA({ competencia: "2026-13" })]);
  const s = await grupo({ responder });
  const q = await perguntaDoMes(s, "RN3");
  await s.enviar(doGerente({ texto: "foi lá pra outubro mesmo, dia 25 eu paguei, né", respostaA: q }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO");
  assert.equal((await s.contas(ORG_X, XIS))[0].competencia, "2026-10", "ano do pagamento, não 2025");
  const r = comIa([LEITURA({ competencia: "2026-13" })]);
  const s2 = await grupo({ responder: r.responder });
  const q2 = await perguntaDoMes(s2, "RN3B");
  await s2.enviar(doGerente({ texto: "sei lá, a conta do ar", respostaA: q2 }));
  const h = await s2.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "COMPETENCIA_NAO_ENTENDIDA"]);
  assert.equal(s2.escritas().length, 0, "nada gravado");
});

t("RN-4 IA indisponível não derruba nem registra: pergunta de novo, e a NOVA pergunta também pode ser citada para continuar a mesma operação", async () => {
  const { responder } = comIa([new Error("fora do ar")]);
  const s = await grupo({ responder });
  const q = await perguntaDoMes(s, "RN4");
  await s.enviar(doGerente({ texto: "foi o serviço de outubro lá da loja xis", respostaA: q }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "COMPETENCIA_NAO_ENTENDIDA"], JSON.stringify(h));
  assert.equal(s.escritas().length, 0);
  await entregar(s, "3EB0PERGUNTARN4-2");
  await s.enviar(doGerente({ texto: "Novembro de 2026. dia 25", respostaA: "3EB0PERGUNTARN4-2" }));
  assert.equal((await s.ultima()).decisao, "EXECUTADO", JSON.stringify(await s.ultima()));
  assert.equal((await s.contas(ORG_X, XIS)).length, 1);
});

// ------------------------------------------------------------------ 25/11: retomar a proposta pelo WhatsApp (execução automática antes indisponível)
t("RT-1 política autoriza mas a execução está indisponível: o MOVA DIZ o motivo e a proposta fica guardada; depois de resolvido, citar a resposta com 'registrar' conclui UMA vez, sem novo comprovante", async () => {
  const controle = { ligada: false };
  const s = await grupo({ responder: () => BOLETO_PAGO({ competencia: "2026-10" }), controle });
  await s.enviar(doGerente({ texto: "Energia da loja xis", doc: pdf("RT1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["PROPOSTA", "DESPESA_PAGA"], JSON.stringify(h));
  const msg = (await s.respostas()).at(-1);
  assert.match(msg, /Não registrei automaticamente/);
  assert.match(msg, /citando esta mensagem/);
  assert.deepEqual((await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG_X, unidadeId: XIS }))[0].semExecucao?.motivos, ["SEM_CONCESSAO_OPERACIONAL"], "o motivo fica registrado na proposta");
  assert.deepEqual([s.escritas().length, (await s.contas(ORG_X, XIS)).length], [0, 0]);
  await entregar(s, "3EB0PROPOSTART1");
  // sem permissão (perfil só de consulta): recusado; nada executado; segue possível depois
  await s.enviar(gw({ de: CONS, texto: "registrar", respostaA: "3EB0PROPOSTART1" }));
  assert.equal((await s.ultima()).decisao, "BLOQUEADO");
  // retomada com a execução AINDA indisponível: explica de novo, não grava
  await s.enviar(doGerente({ texto: "registrar", respostaA: "3EB0PROPOSTART1" }));
  assert.equal((await s.ultima()).motivo, "RETOMADA_NAO_EXECUTADA");
  assert.equal((await s.contas(ORG_X, XIS)).length, 0);
  // resolvido: a mesma frase conclui
  controle.ligada = true;
  await s.enviar(doGerente({ texto: "tenta de novo", respostaA: "3EB0PROPOSTART1" }));
  const r = await s.ultima();
  assert.deepEqual([r.decisao, r.motivo], ["EXECUTADO", "DESPESA_PAGA_RETOMADA"], JSON.stringify(r));
  const [conta] = await s.contas(ORG_X, XIS);
  assert.deepEqual([conta.valorBaseCentavos, conta.saldoCentavos, conta.situacao], [867181, 0, "QUITADA"]);
  assert.equal((await s.documentos(ORG_X, XIS)).length, 1, "o comprovante original, sem novo envio");
  // repetir não duplica
  await s.enviar(doGerente({ texto: "registrar", respostaA: "3EB0PROPOSTART1" }));
  assert.notEqual((await s.ultima()).decisao, "EXECUTADO", "repetir não executa de novo");
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1]);
});

test("RN-5 virada do ano e relativos: 'deste mês' e 'mês passado' contam a partir de HOJE; dezembro/janeiro escolhem o ano certo; o dia nunca é ano", () => {
  const c = (txt, pag, hoje = pag) => competenciaDaResposta(txt, pag, hoje);
  assert.equal(c("dezembro", "2027-01-05"), "2026-12", "dezembro respondido em janeiro é do ano anterior");
  assert.equal(c("janeiro", "2026-12-28"), "2027-01", "janeiro respondido em dezembro é do ano seguinte");
  assert.equal(c("é deste mês", "2026-12-31", "2027-01-02"), "2027-01", "deste mês = mês de hoje, não o do pagamento");
  assert.equal(c("mês passado", "2026-12-31", "2027-01-02"), "2026-12", "mês passado em janeiro = dezembro do ano anterior");
  assert.equal(c("do mês passado", "2026-11-25"), "2026-10");
  for (const txt of ["Novembro de 2026. dia 25.", "Mês de novembro, dia 25.", "Referente a novembro.", "Mês 11", "11/2026", "Novembro"]) assert.equal(c(txt, "2026-11-25"), "2026-11", txt);
  assert.equal(extracaoDaRespostaIA({ competencia: "2027-01" }, { texto: "janeiro", dataPagamento: "2026-12-28" }).competencia, "2027-01");
  assert.equal(extracaoDaRespostaIA({ competencia: "2026-01" }, { texto: "janeiro", dataPagamento: "2026-12-28" }).competencia, "2027-01", "o modelo não escolhe o ano");
});
