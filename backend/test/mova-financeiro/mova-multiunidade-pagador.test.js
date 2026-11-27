// MOVA MULTIUNIDADE (24/11/2026): a unidade sai do TITULAR da conta pagadora do comprovante (cadastro `pagadores`, 0015);
// duas EMPRESAS na mesma conversa privada só com acesso multiempresa explícito; boleto/nota → Contas a Pagar e calendário
// oficiais. Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL isolado, IA SIMULADA, Gateway simulado. Tudo sintético:
// "ALFA PRODUTOS" e "MP" aqui são titulares fictícios das lojas Alfa (empresa ORG) e Xis (empresa ORG_X).
import assert from "node:assert/strict";
import { test } from "node:test";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, FIN, FINANCEIRO, GRUPO, ORG, ORG_X, SO_ALFA, XIS, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { RESULTADO_PAGADOR, documentoUtil, nomeCorresponde, nomeDoPagador, unidadePeloPagador } from "../../src/modules/mova-financeiro/dominio/pagador.js";
import { RESULTADO_UNIDADE, resolverUnidade } from "../../src/modules/mova-financeiro/dominio/unidade.js";
import { sqlAcessoDaUnidade } from "../../scripts/mova/acessoDaUnidade.mjs";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c4";
const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const SERVICO = "eeeeeeee-0000-4000-8000-0000000000a2";
const CNPJ_XIS = "00.000.000/0001-91"; // sintético (dígitos válidos de formato; não é de ninguém)
const fontes = { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"], anotaAiPelaSaipos: false };
const fontesXis = { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"], anotaAiPelaSaipos: false };

/** Alfa (empresa ORG) no grupo, pagador "ALFA PRODUTOS"; Xis (empresa ORG_X) SEM grupo, pagador "MP", FIN autorizado com acesso multiempresa. */
const CONFIG = ({ multiempresa = true, participantesXis = [{ ids: [FIN], perfil: "FINANCEIRO", nome: "Financeiro" }] } = {}) => ({
  modo: "OPERACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Alfa", apelidos: ["alfa"], fontes, pagadores: [{ nome: "ALFA PRODUTOS" }] },
    { organizacaoId: ORG_X, unidadeId: XIS, nome: "Loja Xis", apelidos: ["xis"], fontes: fontesXis, semGrupo: true, pagadores: [{ nome: "MP" }, { documento: CNPJ_XIS }],
      participantes: participantesXis, acessoMultiempresa: multiempresa },
  ],
  gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], acesso: "LISTA", participantes: [
    { ids: [FIN], perfil: "FINANCEIRO", nome: "Financeiro" }, { ids: [SO_ALFA], perfil: "FINANCEIRO" },
  ] }],
});

const pdf = (marca) => `%PDF-1.4\n% documento sintetico ${marca}\n%%EOF\n`;
let seq = 0;
const PIX = (x = {}) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 10800, dataPagamento: "2026-10-10", competencia: "2026-10",
  favorecido: "Fornecedor Sintético", pagador: "ALFA PRODUTOS LTDA", instituicao: "Banco Sintético", instituicaoDestino: "Banco Destino Sintético",
  idTransacao: `E0000000020261010MULTI${String(++seq).padStart(10, "0")}`, situacaoTransacao: "CONCLUIDA", categoriaSugerida: "INSUMOS", ...x });
const BOLETO = (x = {}) => base({ tipoDocumento: "BOLETO", intencao: "REGISTRAR_CONTA", valorCentavos: 45000, vencimento: "2026-10-28", dataEmissao: "2026-10-05",
  competencia: "2026-10", favorecido: "Distribuidora Sintética", pagador: "MP", categoriaSugerida: "INSUMOS", identificadorDocumento: `BOL-${++seq}`, ...x });
const NOTA = (x = {}) => base({ tipoDocumento: "NOTA_FISCAL", intencao: "OUTRA", valorCentavos: 12345, dataEmissao: "2026-10-02", competencia: "2026-10",
  favorecido: "Fornecedor Sintético", pagador: "ALFA PRODUTOS", identificadorDocumento: `NF-${++seq}`, ...x });

const POL = (operacao, organizacaoId, unidadeId, x = {}) => ({ operacao, organizacaoId, unidadeId, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 2_000_000,
  responsavel: "Administrador Sintético", motivo: `Política sintética ${operacao} para o teste multiunidade`, vigenteDe: "2026-10-01", ...x });
const TODAS_ACOES = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
const ESCRITAS = ["enviarEvidencia", "registrarObrigacaoDocumental", "registrarPagamentoPorComprovante", "registrarObrigacao", "registrarMovimentacao", "pagarContaAPagar", "registrarTransferencia"];

/**
 * @param {{responder:Function, concessoes?:{org:string, unidade:string}[], config?:object, politicas?:boolean, falharEnvioUmaVez?:boolean}} o
 */
async function multi({ responder, concessoes = [{ org: ORG, unidade: ALFA }, { org: ORG_X, unidade: XIS }], config = CONFIG(), politicas = true, falharEnvioUmaVez = false, acoes = TODAS_ACOES } = {}) {
  let falhou = false;
  const s = await cenario({
    responder, config,
    extras: ({ nucleo }) => {
      const comFalha = falharEnvioUmaVez ? { ...nucleo, async enviarEvidencia(cx, ...a) { if (!falhou) { falhou = true; throw Object.assign(new Error("cofre"), { codigo: "COFRE_INDISPONIVEL" }); } return nucleo.enviarEvidencia(cx, ...a); } } : nucleo;
      return {
        autonomia: true, pagamentoPorComprovante: true, criarDespesas: true, criarContas: true,
        operacional: criarPortaOperacional({ nucleo: comFalha, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: SERVICO,
          concessoes: criarConcessoesMemoria(concessoes.map((c) => ({ organizacaoId: c.org, usuarioId: OPERADOR, unidadeId: c.unidade, acoes: c.acoes ?? acoes }))) }),
      };
    },
  });
  if (process.env.FV2_REPOSITORIO === "postgres") for (const c of concessoes) await s.m.nucleo.concederAcesso(s.c(c.org, c.unidade), { usuarioId: OPERADOR, acoes: c.acoes ?? acoes, justificativa: "Identidade operacional do MOVA (sintético)." });
  if (politicas) {
    for (const [org, u] of [[ORG, ALFA], [ORG_X, XIS]]) {
      for (const op of ["DESPESA_DOCUMENTAL", "BAIXA_DOCUMENTAL", "CONTA_A_PAGAR", "ANEXAR_DOCUMENTO"]) await s.mova.armazenamento.politicas.criar(POL(op, org, u), { criadaPor: HUMANO });
    }
  }
  const registros = (org, u, tipo) => s.m.nucleo.consultarRegistros(s.c(org, u), { tipo });
  const contas = (org, u) => registros(org, u, "OBRIGACAO");
  const liquidacoes = (org, u) => registros(org, u, "LIQUIDACAO");
  const saidas = async (org, u) => (await registros(org, u, "MOVIMENTACAO")).filter((m) => m.sentido === "SAIDA");
  const despesas = async (org, u) => (await registros(org, u, "LANCAMENTO")).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA");
  const propostas = (org, u) => s.mova.armazenamento.propostas.listar({ organizacaoId: org, unidadeId: u });
  const escritas = () => s.chamadas.filter((x) => ESCRITAS.includes(x.nome));
  const resposta = async () => (await s.saida()).filter((r) => r.destino === FIN).map((r) => r.texto).at(-1) ?? "";
  // Conta da Xis (outra empresa) com fornecedor próprio.
  const fornX = await s.m.nucleo.registrarContraparte(s.c(ORG_X, XIS), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const contaXis = (vencimento, valor) => s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: fornX.id, valorOriginalCentavos: valor, categoria: "INSUMOS", descricao: "Compra sintética Xis", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento });
  const privado = (x) => gw({ grupo: FIN, ...x }); // a conversa privada DERIVADA do FIN (Alfa pelo grupo + Xis pelo cadastro multiempresa)
  return { ...s, contas, liquidacoes, saidas, despesas, propostas, escritas, resposta, contaXis, privado };
}

// ------------------------------------------------------------------ regra pura (dominio/pagador.js)
test("MU-0 nome do pagador: normalizado; sufixo societário só para nome de 4+ letras; 'MP' só exato; documento mascarado não identifica", () => {
  assert.equal(nomeDoPagador("  Alfa-Produtos.  "), "alfa produtos");
  assert.ok(nomeCorresponde(nomeDoPagador("ALFA PRODUTOS LTDA"), nomeDoPagador("ALFA PRODUTOS")));
  assert.ok(nomeCorresponde(nomeDoPagador("Alfa Produtos - ME"), nomeDoPagador("ALFA PRODUTOS")));
  assert.ok(!nomeCorresponde(nomeDoPagador("ALFA PRODUTOS ALIMENTICIOS"), nomeDoPagador("ALFA PRODUTOS")), "nome maior não é o mesmo titular");
  assert.ok(nomeCorresponde(nomeDoPagador("mp"), nomeDoPagador("MP")));
  for (const outro of ["MP LTDA", "MERCADO PAGO", "MP PAGAMENTOS", "AMP", "MPX", "M P", "Mercado Pago Instituição de Pagamento"]) assert.ok(!nomeCorresponde(nomeDoPagador(outro), nomeDoPagador("MP")), outro);
  assert.equal(documentoUtil("***.123.456-**"), "");
  assert.equal(documentoUtil("00.000.000/0001-91"), "00000000000191");
  const cfg = validarConfiguracao(CONFIG());
  assert.equal(unidadePeloPagador({ unidades: cfg.unidades, pagador: "MP", documentoPagador: "11.111.111/0001-11" }).unidade.unidadeId, XIS, "documento não cadastrado não atrapalha");
  assert.equal(unidadePeloPagador({ unidades: cfg.unidades, pagador: "ALFA PRODUTOS", documentoPagador: CNPJ_XIS }).resultado, RESULTADO_PAGADOR.CONFLITO, "nome de uma, documento de outra");
});

test("MU-0b cadastro: o mesmo pagador em duas unidades é recusado; kit gera SQL revisável com auditoria e recusa participante em unidade de grupo", () => {
  const c = CONFIG();
  c.unidades[1].pagadores = [{ nome: "ALFA PRODUTOS LTDA" }];
  assert.throws(() => validarConfiguracao(c), /pagador_ambiguo/);
  assert.throws(() => validarConfiguracao({ ...CONFIG(), unidades: [{ ...CONFIG().unidades[0], pagadores: [{ nome: "AF", banco: "x" }] }, CONFIG().unidades[1]] }), /pagadores\[0\]\.banco/);
  const sql = sqlAcessoDaUnidade({ unidadeId: XIS, semGrupo: true, pagadores: [{ nome: "MP" }], participantes: [{ ids: [FIN], perfil: "FINANCEIRO", privado: FIN }], multiempresa: true, motivo: "Titular confirmado pelo proprietário (sintético)" });
  assert.match(sql, /update mova\.unidade_sem_grupo set pagadores = '\[\{"nome":"MP"\}\]'::jsonb/);
  assert.match(sql, /CADASTRO_ACESSO_UNIDADE/);
  assert.match(sql, /0015_mova_pagadores_multiunidade\.sql/);
  assert.throws(() => sqlAcessoDaUnidade({ unidadeId: ALFA, participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }], motivo: "motivo sintético longo" }), /SEM grupo/);
});

test("MU-0c resolverUnidade: pagador fora da conversa bloqueia; texto × pagador conflita; IA sozinha não decide", () => {
  const cfg = validarConfiguracao(CONFIG());
  const soAlfa = { unidades: [ALFA] };
  const ambas = { unidades: [ALFA, XIS] };
  assert.deepEqual([resolverUnidade({ cfg, grupo: soAlfa, textos: [], pagador: "MP" }).resultado, resolverUnidade({ cfg, grupo: soAlfa, textos: [], pagador: "MP" }).evidencia],
    [RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, "PAGADOR_FORA_DA_CONVERSA"]);
  assert.equal(resolverUnidade({ cfg, grupo: ambas, textos: ["brownies"], pagador: "MP" }).unidade.unidadeId, XIS);
  // 26/11: texto × pagador com as DUAS unidades na conversa ⇒ possível operação entre empresas (o motor pergunta; nada é presumido)
  const ic = resolverUnidade({ cfg, grupo: ambas, textos: ["brownies da alfa"], pagador: "MP" });
  assert.deepEqual([ic.resultado, ic.unidade.unidadeId, ic.pagadora.unidadeId], [RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, ALFA, XIS]);
  assert.equal(resolverUnidade({ cfg, grupo: ambas, textos: ["brownies"], pagador: "MP", sugestaoIa: "alfa" }).resultado, RESULTADO_UNIDADE.CONFLITANTE);
  assert.equal(resolverUnidade({ cfg, grupo: ambas, textos: ["brownies"], sugestaoIa: "xis" }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
});

// ------------------------------------------------------------------ fluxo completo (WhatsApp simulado → MOVA → Financeiro v2)
t("MU-1/11 comprovante ALFA PRODUTOS → Alfa: compra nova registrada e paga por comprovante na Alfa; nada na Xis; unidade identificada pelo titular", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "ALFA PRODUTOS LTDA", favorecido: "Doceria Sintética" }) });
  await s.enviar(s.privado({ texto: "MOVA brownies", doc: pdf("1") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.conciliacao, h.unidadeId], ["EXECUTADO", "PAGO_POR_COMPROVANTE", ALFA]);
  const [p] = await s.propostas(ORG, ALFA);
  assert.equal(p.leitura.evidenciaUnidade, "TITULAR_DO_PAGADOR");
  assert.deepEqual([(await s.contas(ORG, ALFA)).length, (await s.liquidacoes(ORG, ALFA)).length, (await s.saidas(ORG, ALFA)).length], [1, 1, 0]);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.propostas(ORG_X, XIS)).length], [0, 0], "nada na outra empresa");
  assert.ok(s.escritas().every((x) => x.organizacaoId === ORG && x.unidadeId === ALFA));
});

t("MU-2 comprovante MP → Xis (outra empresa), sem a unidade na legenda; nada na Alfa", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP", favorecido: "Descartáveis Sintéticos", valorCentavos: 23456 }) });
  await s.enviar(s.privado({ texto: "MOVA descartáveis", doc: pdf("2") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["EXECUTADO", XIS]);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length, (await s.saidas(ORG_X, XIS)).length], [1, 1, 0]);
  assert.deepEqual([(await s.propostas(ORG, ALFA)).length, (await s.despesas(ORG, ALFA)).length], [0, 0]);
  assert.ok(s.escritas().every((x) => x.organizacaoId === ORG_X && x.unidadeId === XIS));
});

for (const [rotulo, leitura, legenda] of [
  ["MU-3 'MP' só na descrição/legenda", { pagador: null }, "MOVA pagamento MP descartáveis"],
  ["MU-4 'Mercado Pago' como pagador/instituição", { pagador: "MERCADO PAGO", instituicao: "Mercado Pago" }, "MOVA descartáveis"],
  ["MU-5 'MP' no FAVORECIDO, não no pagador", { pagador: null, favorecido: "MP" }, "MOVA descartáveis"],
  ["MU-6 documento sem identificação", { pagador: null }, "MOVA descartáveis"],
]) {
  t(`${rotulo} → NÃO atribui sozinho: pergunta a unidade, nada gravado`, async () => {
    const s = await multi({ responder: () => PIX(leitura) });
    await s.enviar(s.privado({ texto: legenda, doc: pdf(rotulo) }));
    const h = await s.ultima();
    assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "UNIDADE_NAO_IDENTIFICADA"]);
    assert.match(await s.resposta(), /Loja Alfa ou Loja Xis\?/);
    assert.deepEqual([s.escritas().length, (await s.propostas(ORG, ALFA)).length, (await s.propostas(ORG_X, XIS)).length], [0, 0, 0]);
  });
}

t("MU-6b resposta curta 'xis' à pergunta da unidade continua a operação na Xis (sem pedir de novo)", async () => {
  const s = await multi({ responder: () => PIX({ pagador: null, favorecido: "Descartáveis Sintéticos" }) });
  await s.enviar(s.privado({ texto: "MOVA descartáveis", doc: pdf("6b") }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_NAO_IDENTIFICADA");
  await s.enviar(s.privado({ texto: "xis" }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["EXECUTADO", XIS]);
  assert.equal((await s.propostas(ORG, ALFA)).length, 0);
});

t("MU-7 legenda 'alfa' com pagador MP (Xis): pergunta se é operação ENTRE EMPRESAS; não grava; resposta que não é sim/não repete a pergunta", async () => {
  // 26/11: antes era só "conflito de unidade". Agora é o caso da Subway pagando pelo Açaí: pergunta, e nada é gravado sem o "sim".
  const s = await multi({ responder: () => PIX({ pagador: "MP" }) });
  await s.enviar(s.privado({ texto: "MOVA brownies da alfa", doc: pdf("7") }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["PEDIR_INFORMACAO", "ENTRE_EMPRESAS_AGUARDANDO_CONFIRMACAO"]);
  assert.match(await s.resposta(), /realizou um pagamento de R\$ [\d.,]+ referente ao Loja Alfa\. Confirma que devo registrar a despesa no Loja Alfa e o valor como uma dívida do Loja Alfa com a Loja Xis\?/);
  await s.enviar(s.privado({ texto: "alfa" }));
  assert.equal((await s.ultima()).motivo, "ENTRE_EMPRESAS_RESPOSTA_NAO_ENTENDIDA");
  assert.deepEqual([s.escritas().length, (await s.propostas(ORG, ALFA)).length, (await s.propostas(ORG_X, XIS)).length], [0, 0, 0]);
});

// ------------------------------------------------------------------ 26/11: OPERAÇÃO ENTRE EMPRESAS pelo WhatsApp (caso R$ 6.495,60)
// Xis (pagador "MP") = papel da Subway Saci; Alfa = papel do Açaí no Grau Saci. A Xis pagou a distribuidora pela Alfa.
const VALOR_IC = 649560;
const comprovanteIC = (x = {}) => PIX({ pagador: "MP", valorCentavos: VALOR_IC, favorecido: "Fornecedor Sintético", dataPagamento: "2026-10-14", ...x });
const aprovar = (s, p, ctxC, extra = {}) => s.mova.aprovador.aplicar(s.c(ORG, ALFA), { propostaId: p.id, ...extra }, { nucleo: s.m.nucleo, ...(ctxC === undefined ? {} : { ctxContraparte: ctxC }) });
const entre = async (s, org, u) => (await s.m.nucleo.consultarContasEntreEmpresas(s.c(org, u))).totais;

t("EC-1 caso real: conta EXISTENTE da Alfa paga pela Xis — pergunta exata; 'sim' cria a proposta (nada lançado); aplicação exige as DUAS empresas e liquida sem despesa na Xis", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  const conta = (await s.conta("2026-10-14", VALOR_IC)).obrigacoes[0];
  const doc = s.privado({ texto: "MOVA comprovante, distribuidora alfa", doc: pdf("ic-1") });
  await s.enviar(doc);
  assert.equal((await s.ultima()).motivo, "ENTRE_EMPRESAS_AGUARDANDO_CONFIRMACAO");
  const pergunta = await s.resposta();
  assert.match(pergunta, /^Identifiquei que a Loja Xis realizou um pagamento de R\$ 6\.495,60 referente ao Loja Alfa\. Confirma que devo registrar a despesa no Loja Alfa e o valor como uma dívida do Loja Alfa com a Loja Xis\?/);
  assert.match(pergunta, /Conta encontrada no Loja Alfa: Fornecedor Sintético/);
  await s.enviar(s.privado({ texto: "sim", respostaA: doc.mensagemId }));
  const [p] = await s.propostas(ORG, ALFA);
  assert.deepEqual([p?.tipo, p?.comando?.entrada?.obrigacaoId, p?.comando?.credora?.unidadeId, s.escritas().length], ["INTERCOMPANY", conta.id, XIS, 0], "só proposta: nada escrito no Financeiro");
  assert.equal((await s.propostas(ORG_X, XIS)).length, 0, "a proposta fica na devedora (uma só)");
  // sessão de UMA unidade (rota atual): recusada, nada muda
  await assert.rejects(aprovar(s, p, null), (e) => e.codigo === "CONTRAPARTE_SEM_SESSAO");
  // outra pessoa na contraparte, ou sem permissão nela: recusada
  const { ctx } = await import("../financeiro-v2/helpers/cenario.js");
  await assert.rejects(aprovar(s, p, ctx(ORG_X, XIS, undefined, "eeeeeeee-0000-4000-8000-000000000099")), (e) => e.codigo === "CONTRAPARTE_INVALIDA");
  await assert.rejects(aprovar(s, p, ctx(ORG_X, XIS, ["financeiro_v2.ver"], "eeeeeeee-0000-4000-8000-000000000001")), (e) => e.codigo === "PERMISSAO_INSUFICIENTE");
  assert.equal((await s.propostas(ORG, ALFA))[0].estado, "AGUARDANDO_REVISAO");
  // com o contexto verificado das DUAS: aplica (atômico no Financeiro)
  const aplicada = await aprovar(s, p, s.c(ORG_X, XIS));
  assert.equal(aplicada.estado, "APLICADA");
  const [c] = (await s.contas(ORG, ALFA)).filter((x) => x.id === conta.id);
  assert.equal(c.saldoCentavos, 0, "a conta do fornecedor fica paga (pela outra empresa)");
  assert.deepEqual([(await entre(s, ORG, ALFA)).aPagarCentavos, (await entre(s, ORG_X, XIS)).aReceberCentavos], [VALOR_IC, VALOR_IC], "passivo na Alfa × ativo na Xis");
  assert.deepEqual([(await s.despesas(ORG_X, XIS)).length, (await s.contas(ORG_X, XIS)).length, (await s.saidas(ORG, ALFA)).length], [0, 0, 0], "nada de despesa na Xis; nenhuma saída inventada na Alfa");
  await assert.rejects(aprovar(s, p, s.c(ORG_X, XIS)), (e) => e.codigo === "PROPOSTA_JA_DECIDIDA");
});

t("EC-2 SEM conta prévia na Alfa: a proposta traz a conta NOVA (já paga pela Xis); despesa reconhecida UMA vez, só na Alfa", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  const doc = s.privado({ texto: "MOVA comprovante, distribuidora alfa", doc: pdf("ic-2") });
  await s.enviar(doc);
  assert.match(await s.resposta(), /Não encontrei conta em aberto com esse valor no Loja Alfa/);
  await s.enviar(s.privado({ texto: "sim", respostaA: doc.mensagemId }));
  const [p] = await s.propostas(ORG, ALFA);
  assert.deepEqual([p.comando.entrada.obrigacaoId ?? null, p.comando.entrada.obrigacaoNova?.competencia, p.comando.entrada.obrigacaoNova?.contraparteNova?.nome], [null, "2026-10", "Fornecedor Sintético"]);
  await aprovar(s, p, s.c(ORG_X, XIS));
  const contasA = await s.contas(ORG, ALFA);
  assert.deepEqual([contasA.length, contasA[0].saldoCentavos, (await s.liquidacoes(ORG, ALFA)).length, (await s.saidas(ORG, ALFA)).length], [1, 0, 1, 0]);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.despesas(ORG_X, XIS)).length], [0, 0]);
});

t("EC-3 'não' encerra sem registrar nada; boleto (não é pagamento) com o mesmo conflito continua como conflito de unidade", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  const doc = s.privado({ texto: "MOVA comprovante, distribuidora alfa", doc: pdf("ic-3") });
  await s.enviar(doc);
  await s.enviar(s.privado({ texto: "não", respostaA: doc.mensagemId }));
  assert.equal((await s.ultima()).motivo, "ENTRE_EMPRESAS_RECUSADA");
  assert.deepEqual([(await s.propostas(ORG, ALFA)).length, (await s.propostas(ORG_X, XIS)).length, s.escritas().length], [0, 0, 0]);
  const b = await multi({ responder: () => BOLETO({ pagador: "MP" }) });
  await b.enviar(b.privado({ texto: "MOVA boleto da alfa", doc: pdf("ic-3b") }));
  assert.equal((await b.ultima()).motivo, "UNIDADE_CONFLITANTE");
});

t("EC-4 várias contas compatíveis na Alfa: o MOVA não escolhe — a revisão escolhe UMA (sem ela, a aplicação é recusada)", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  const c1 = (await s.conta("2026-10-14", VALOR_IC)).obrigacoes[0];
  const c2 = (await s.conta("2026-10-20", VALOR_IC)).obrigacoes[0];
  const doc = s.privado({ texto: "MOVA comprovante, distribuidora alfa", doc: pdf("ic-4") });
  await s.enviar(doc);
  assert.match(await s.resposta(), /mais de uma conta em aberto com esse valor/);
  await s.enviar(s.privado({ texto: "sim", respostaA: doc.mensagemId }));
  const [p] = await s.propostas(ORG, ALFA);
  assert.deepEqual([...p.comando.escolherConta].sort(), [c1.id, c2.id].sort());
  await assert.rejects(aprovar(s, p, s.c(ORG_X, XIS)), (e) => e.codigo === "CONTA_A_ESCOLHER");
  await aprovar(s, p, s.c(ORG_X, XIS), { obrigacaoId: c2.id });
  const contas = await s.contas(ORG, ALFA);
  assert.deepEqual([contas.find((x) => x.id === c1.id).saldoCentavos, contas.find((x) => x.id === c2.id).saldoCentavos], [VALOR_IC, 0], "só a escolhida");
});

t("MU-8 identidade operacional SÓ da Alfa: comprovante MP vira proposta na Xis (sem concessão), nada é escrito em nenhuma empresa", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP" }), concessoes: [{ org: ORG, unidade: ALFA }] });
  await s.enviar(s.privado({ texto: "MOVA descartáveis", doc: pdf("8") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["PROPOSTA", XIS]);
  assert.ok((h.motivoExecucao ?? JSON.stringify(h)).includes("SEM_CONCESSAO_OPERACIONAL") || (await s.propostas(ORG_X, XIS))[0].estado === "AGUARDANDO_REVISAO");
  assert.deepEqual([s.escritas().length, (await s.contas(ORG_X, XIS)).length, (await s.contas(ORG, ALFA)).length], [0, 0, 0]);
});

t("MU-8b conversa que atende SÓ a Alfa recebe comprovante MP: orienta o canal da Xis; nada registrado (o 'MP' não dá acesso)", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP" }) });
  await s.enviar(gw({ grupo: SO_ALFA, de: SO_ALFA, texto: "MOVA descartáveis", doc: pdf("8b") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "DOCUMENTO_DE_OUTRA_UNIDADE"]);
  const r = (await s.saida()).filter((x) => x.destino === SO_ALFA).at(-1)?.texto ?? "";
  assert.match(r, /pago pela conta da Loja Xis, que esta conversa não atende/);
  assert.deepEqual([s.escritas().length, (await s.propostas(ORG, ALFA)).length, (await s.propostas(ORG_X, XIS)).length], [0, 0, 0]);
});

t("MU-9 identidade operacional SÓ da Xis: comprovante ALFA PRODUTOS fica como proposta na Alfa; nada escrito", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "ALFA PRODUTOS" }), concessoes: [{ org: ORG_X, unidade: XIS }] });
  await s.enviar(s.privado({ texto: "MOVA brownies", doc: pdf("9") }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).unidadeId], ["PROPOSTA", ALFA]);
  assert.deepEqual([s.escritas().length, (await s.contas(ORG, ALFA)).length, (await s.contas(ORG_X, XIS)).length], [0, 0, 0]);
});

t("MU-10 sem acesso multiempresa explícito, a conversa NÃO junta as duas empresas (a Xis não entra na conversa do FIN)", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP" }), config: CONFIG({ multiempresa: false }) });
  const conv = s.cfg.gruposAutorizados.find((g) => g.grupoId === FIN);
  assert.equal(conv, undefined, "conversa com duas empresas sem autorização é descartada");
  const comAcesso = validarConfiguracao(CONFIG()).gruposAutorizados.find((g) => g.grupoId === FIN);
  assert.deepEqual([...comAcesso.unidades].sort(), [ALFA, XIS].sort());
});

t("MU-10b identidade das duas empresas: dois comprovantes na mesma conversa, cada um na sua empresa; faturamento nunca somado entre empresas", async () => {
  let n = 0;
  const s = await multi({ responder: () => (++n === 1 ? PIX({ pagador: "ALFA PRODUTOS", favorecido: "Doceria Sintética" }) : PIX({ pagador: "MP", favorecido: "Descartáveis Sintéticos", valorCentavos: 5000 })) });
  await s.enviar(s.privado({ texto: "MOVA brownies", doc: pdf("10a") }));
  await s.enviar(s.privado({ texto: "MOVA descartáveis", doc: pdf("10b") }));
  assert.deepEqual([(await s.liquidacoes(ORG, ALFA)).length, (await s.liquidacoes(ORG_X, XIS)).length], [1, 1]);
  const [pa] = await s.propostas(ORG, ALFA);
  const [px] = await s.propostas(ORG_X, XIS);
  assert.deepEqual([pa.valorCentavos, px.valorCentavos], [10800, 5000]);
  for (const x of s.escritas()) assert.ok((x.organizacaoId === ORG && x.unidadeId === ALFA) || (x.organizacaoId === ORG_X && x.unidadeId === XIS));
});

t("MU-12 obrigação existente na Xis com saldo igual: baixa da conta existente (sem conta nova)", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP", valorCentavos: 30000 }) });
  const o = await s.contaXis("2026-10-20", 30000);
  await s.enviar(s.privado({ texto: "MOVA pagamento", doc: pdf("12") }));
  const [p] = await s.propostas(ORG_X, XIS);
  assert.deepEqual([p.tipo, p.comando.entrada.obrigacaoId], ["BAIXA_DE_OBRIGACAO", o.obrigacoes[0].id]);
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.saidas(ORG_X, XIS)).length], [1, 0]);
});

t("MU-13 pagamento parcial indicado na legenda: baixa parcial, saldo restante preservado", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP", valorCentavos: 10000 }) });
  const o = await s.contaXis("2026-10-20", 30000);
  await s.enviar(s.privado({ texto: "MOVA pagamento parcial", doc: pdf("13") }));
  const [p] = await s.propostas(ORG_X, XIS);
  assert.deepEqual([p.tipo, p.parcial, p.comando.entrada.obrigacaoId], ["BAIXA_DE_OBRIGACAO", true, o.obrigacoes[0].id]);
});

t("MU-14 valor maior que o saldo (juros?): pergunta objetiva, nada gravado", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP", valorCentavos: 32000 }) });
  await s.contaXis("2026-10-20", 30000);
  await s.enviar(s.privado({ texto: "MOVA pagamento", doc: pdf("14") }));
  assert.equal((await s.ultima()).motivo, "VALOR_MAIOR_QUE_SALDO");
  assert.match(await s.resposta(), /juros dessa conta\?/);
  assert.equal(s.escritas().length, 0);
});

t("MU-15/18 duplicidade: o mesmo comprovante reenviado (e a MESMA mensagem repetida) não cria segunda conta, baixa ou despesa", async () => {
  const fixo = PIX({ pagador: "MP", favorecido: "Descartáveis Sintéticos" });
  const s = await multi({ responder: () => fixo });
  const msg = s.privado({ texto: "MOVA descartáveis", doc: pdf("15") });
  await s.enviar(msg);
  await s.enviar(msg); // reenvio da MESMA mensagem (mesmo eventoId)
  await s.enviar(s.privado({ texto: "MOVA descartáveis de novo", doc: pdf("15") })); // mesmo arquivo em outra mensagem
  assert.deepEqual([(await s.contas(ORG_X, XIS)).length, (await s.liquidacoes(ORG_X, XIS)).length, (await s.despesas(ORG_X, XIS)).length], [1, 1, 1]);
  assert.equal((await s.ultima()).decisao, "DUPLICADO");
});

t("MU-16 boleto da Xis → conta a pagar EM ABERTO no Contas a Pagar e no calendário oficial, com o boleto anexado; nenhuma baixa", async () => {
  const s = await multi({ responder: () => BOLETO() });
  await s.enviar(s.privado({ texto: "MOVA boleto da distribuidora", doc: pdf("16") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["EXECUTADO", XIS]);
  const [conta] = await s.contas(ORG_X, XIS);
  assert.deepEqual([conta.vencimento, conta.valorBaseCentavos, conta.situacao, conta.competencia], ["2026-10-28", 45000, "ABERTA", "2026-10"]);
  assert.deepEqual([(await s.liquidacoes(ORG_X, XIS)).length, (await s.saidas(ORG_X, XIS)).length], [0, 0], "boleto não é pagamento");
  const dia = (await s.m.nucleo.consultarCalendarioFinanceiro(s.c(ORG_X, XIS), { mes: "2026-10" })).dias.find((d) => d.data === "2026-10-28");
  assert.deepEqual([dia.aVencer.quantidade, dia.aVencer.saldoCentavos], [1, 45000], "aparece a vencer no calendário oficial");
  assert.equal(dia.titulos[0].fornecedor, "Distribuidora Sintética");
  const docs = await s.m.nucleo.consultarRegistros(s.c(ORG_X, XIS), { tipo: "DOCUMENTO" });
  assert.deepEqual(docs.map((d) => d.tipo), ["BOLETO"]);
  assert.match(await s.resposta(), /Conta a pagar registrada: R\$ 450,00 para Distribuidora Sintética, vencimento 28\/10\/2026/);
  assert.deepEqual((await s.propostas(ORG, ALFA)).length, 0);
});

t("MU-16b boleto sem política CONTA_A_PAGAR automática: fica como PROPOSTA (encaminhado), nada gravado", async () => {
  const s = await multi({ responder: () => BOLETO(), politicas: false });
  await s.enviar(s.privado({ texto: "MOVA boleto", doc: pdf("16b") }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.contas(ORG_X, XIS)).length, s.escritas().length], ["PROPOSTA", 0, 0]);
});

t("MU-17 nota fiscal de conta JÁ registrada na Alfa: anexada à conta existente, sem conta ou despesa nova", async () => {
  const s = await multi({ responder: () => NOTA({ pagador: "ALFA PRODUTOS", valorCentavos: 12345 }) });
  const o = await s.conta("2026-10-25", 12345);
  const antes = (await s.despesas(ORG, ALFA)).length;
  await s.enviar(s.privado({ texto: "MOVA nota do fornecedor", doc: pdf("17") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["EXECUTADO", ALFA]);
  const [p] = await s.propostas(ORG, ALFA);
  assert.deepEqual([p.tipo, p.comando.entrada.obrigacaoId], ["VINCULO_DE_DOCUMENTO", o.obrigacoes[0].id]);
  assert.deepEqual([(await s.contas(ORG, ALFA)).length, (await s.despesas(ORG, ALFA)).length], [1, antes]);
  const docs = await s.m.nucleo.consultarRegistros(s.c(ORG, ALFA), { tipo: "DOCUMENTO" });
  assert.deepEqual(docs.map((d) => d.tipo), ["NOTA_FISCAL"]);
  assert.deepEqual(s.escritas().map((x) => x.nome), ["enviarEvidencia"]);
});

t("MU-19 falha intermediária (cofre fora no anexo): proposta volta para revisão; nova tentativa reaproveita a MESMA conta (sem duplicar)", async () => {
  const s = await multi({ responder: () => BOLETO(), falharEnvioUmaVez: true });
  await s.enviar(s.privado({ texto: "MOVA boleto", doc: pdf("19") }));
  const [p] = await s.propostas(ORG_X, XIS);
  assert.equal(p.estado, "AGUARDANDO_REVISAO", "a falha devolve a proposta");
  assert.equal((await s.contas(ORG_X, XIS)).length, 1, "a conta registrada antes da falha fica (fonte MOVA:<proposta>)");
  const r = await s.mova.execucao.aposContaNova(p, { organizacaoId: ORG_X, unidadeId: XIS });
  assert.deepEqual([r.situacao, r.resultado.contaCriada], ["CONTA_REGISTRADA", false]);
  assert.equal((await s.contas(ORG_X, XIS)).length, 1, "nenhuma segunda conta");
  assert.equal((await s.m.nucleo.consultarRegistros(s.c(ORG_X, XIS), { tipo: "DOCUMENTO" })).length, 1);
});

t("MU-20 nenhuma transferência ou pagamento bancário real: o MOVA só usa as ações estreitas (conta, comprovante, documento)", async () => {
  let n = 0;
  const s = await multi({ responder: () => [PIX({ pagador: "ALFA PRODUTOS" }), BOLETO(), PIX({ pagador: "MP", favorecido: "Distribuidora Sintética", valorCentavos: 45000 })][n++] });
  await s.enviar(s.privado({ texto: "MOVA brownies", doc: pdf("20a") }));
  await s.enviar(s.privado({ texto: "MOVA boleto", doc: pdf("20b") }));
  await s.enviar(s.privado({ texto: "MOVA pagamento do boleto", doc: pdf("20c") }));
  const nomes = new Set(s.escritas().map((x) => x.nome));
  for (const proibida of ["registrarMovimentacao", "pagarContaAPagar", "registrarTransferencia", "registrarObrigacao"]) assert.ok(!nomes.has(proibida), proibida);
  assert.deepEqual([(await s.saidas(ORG, ALFA)).length, (await s.saidas(ORG_X, XIS)).length], [0, 0], "nenhuma saída bancária");
  assert.equal(await (async () => (await s.m.nucleo.detalharContaAPagar(s.c(ORG_X, XIS), { id: (await s.contas(ORG_X, XIS))[0].id })).titulo.saldoCentavos)(), 0, "o boleto foi baixado pelo comprovante, sem saída");
});

// ------------------------------------------------------------------ homologação: casos complementares (24/11, missão final)
t("H-3 boleto do ALFA (empresa ORG): conta em aberto na Alfa, no Contas a Pagar oficial (fornecedor, valor, vencimento, documento) e nada na Xis", async () => {
  const s = await multi({ responder: () => BOLETO({ pagador: "ALFA PRODUTOS", favorecido: "Laticínios Sintéticos", valorCentavos: 78900 }) });
  await s.enviar(s.privado({ texto: "MOVA boleto do leite", doc: pdf("H3") }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).unidadeId], ["EXECUTADO", ALFA]);
  const cap = await s.m.nucleo.consultarContasAPagar(s.c(ORG, ALFA), {});
  const item = cap.itens.find((x) => x.fornecedor?.nome === "Laticínios Sintéticos");
  assert.deepEqual([item.valorOriginalCentavos, item.saldoCentavos, item.vencimento, item.situacao !== "PAGO", item.pendencias.includes("SEM_DOCUMENTO")], [78900, 78900, "2026-10-28", true, false]);
  assert.equal((await s.contas(ORG_X, XIS)).length, 0);
});

t("H-11 despesa de valor ELEVADO acima da política: vira proposta (encaminhada), nada registrado; dentro da política: executa", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP", favorecido: "Equipamentos Sintéticos", valorCentavos: 2_500_000 }) });
  await s.enviar(s.privado({ texto: "MOVA forno novo", doc: pdf("H11") }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.unidadeId], ["PROPOSTA", XIS], "R$ 25.000 > limite sintético de R$ 20.000: confirmação humana");
  assert.deepEqual([s.escritas().length, (await s.contas(ORG_X, XIS)).length], [0, 0]);
  const [p] = await s.propostas(ORG_X, XIS);
  assert.ok((p.autonomiaDocumental?.motivos ?? []).includes("ACIMA_DO_LIMITE"));
});

t("H-17 conciliação PENDENTE registrada: o pagamento por comprovante aparece nos 'a conciliar' do Financeiro, sem saída bancária", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "ALFA PRODUTOS", favorecido: "Doceria Sintética" }) });
  await s.enviar(s.privado({ texto: "MOVA brownies", doc: pdf("H17") }));
  const r = await s.m.nucleo.consultarPagamentosPorComprovanteAConciliar(s.c(ORG, ALFA));
  assert.equal(r.itens.length, 1);
  assert.deepEqual([r.itens[0].valorCentavos, r.itens[0].dataPagamento, Boolean(r.itens[0].documentoId), Boolean(r.itens[0].idTransacao)], [10800, "2026-10-10", true, true]);
  assert.equal((await s.saidas(ORG, ALFA)).length, 0);
});

// ------------------------------------------------------------------ kit de políticas (no banco real do MOVA)
import { MIGRACOES, criarBancoMova, descartarBancoMova } from "./helpers/banco.js";
import { sqlPoliticasDaUnidade, sqlRevogarPoliticasDaUnidade } from "../../scripts/mova/politicasDaUnidade.mjs";
import { validarPolitica } from "../../src/modules/mova-financeiro/dominio/autonomia.js";

test("POL-0 kit de políticas: limite explícito obrigatório (sem padrão nem ilimitado), operação desconhecida recusada", () => {
  const base = { organizacaoId: ORG_X, unidadeId: XIS, criadaPor: HUMANO, responsavel: "Proprietário Sintético", motivo: "Política sintética aprovada para o teste", vigenteDe: "2026-11-24" };
  assert.throws(() => sqlPoliticasDaUnidade({ ...base, politicas: [{ operacao: "CONTA_A_PAGAR", nivel: "APLICAR_AUTOMATICO", limiteCentavos: NaN }] }), /Limite explícito/);
  assert.throws(() => sqlPoliticasDaUnidade({ ...base, politicas: [{ operacao: "PAGAMENTO_BANCARIO", nivel: "APLICAR_AUTOMATICO", limiteCentavos: 100 }] }), /operacao/);
  assert.throws(() => sqlPoliticasDaUnidade({ ...base, politicas: [] }), /ao menos uma/);
  assert.match(sqlPoliticasDaUnidade({ ...base, politicas: [{ operacao: "CONTA_A_PAGAR", nivel: "APLICAR_AUTOMATICO", limiteCentavos: 2_000_000 }] }), /0015_mova_pagadores_multiunidade\.sql/);
});

t("POL-1 kit aplicado no banco do MOVA: seis políticas (com a sangria, 0023) por operação; reaplicar troca (revoga a anterior, uma vigente por operação); revogar todas", async () => {
  const banco = await criarBancoMova();
  try {
    // como em produção: o instalador registra as migrações aplicadas (o helper de teste só executa os arquivos)
    await banco.pool.query("create table if not exists mova.mova_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
    for (const m of MIGRACOES) await banco.pool.query("insert into mova.mova_migracao (nome, sha256) values ($1, 'teste') on conflict do nothing", [m]);
    await banco.pool.query(`insert into mova.unidade_sem_grupo (unidade_id, organizacao_id, nome, motivo, ativo) values ($1, $2, 'Loja Xis', 'Cadastro sintético para o teste de políticas', true)`, [XIS, ORG_X]);
    const politicas = [["CONTA_A_PAGAR", 2_000_000], ["DESPESA_DOCUMENTAL", 300_000], ["BAIXA_DOCUMENTAL", 2_000_000], ["ANEXAR_DOCUMENTO", 2_000_000], ["JUROS_DOCUMENTAL", 5_000], ["PRESTACAO_DE_SANGRIA", 100_000]] // sangria: 0023
      .map(([operacao, limiteCentavos]) => ({ operacao, nivel: "APLICAR_AUTOMATICO", limiteCentavos }));
    const base = { organizacaoId: ORG_X, unidadeId: XIS, criadaPor: HUMANO, responsavel: "Proprietário Sintético", motivo: "Política sintética aprovada para o teste", vigenteDe: "2026-11-24" };
    await banco.pool.query(sqlPoliticasDaUnidade({ ...base, politicas }));
    await banco.pool.query(sqlPoliticasDaUnidade({ ...base, politicas: [{ operacao: "DESPESA_DOCUMENTAL", nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 500_000 }] }));
    const { rows } = await banco.pool.query("select operacao, nivel, limite_centavos::int l, revogada_em is null vigente from mova.politica_autonomia order by operacao, criada_em");
    const vigentes = rows.filter((r) => r.vigente);
    assert.equal(vigentes.length, 6, "uma vigente por operação");
    assert.deepEqual(vigentes.find((r) => r.operacao === "DESPESA_DOCUMENTAL"), { operacao: "DESPESA_DOCUMENTAL", nivel: "APLICAR_COM_CONFIRMACAO", l: 500_000, vigente: true });
    assert.equal(rows.length, 7, "a anterior ficou no histórico (revogada)");
    // a reversão da 0023 recusa sem mudar nada enquanto existir política de sangria
    const { readFileSync } = await import("node:fs");
    await assert.rejects(banco.pool.query(readFileSync(new URL("../../../database/mova-financeiro/recuperacao/reverter-0023.sql", import.meta.url), "utf8")), /PRESTACAO_DE_SANGRIA/);
    // o armazenamento do MOVA lê e o domínio aceita cada política
    const { criarArmazenamentoPostgres } = await import("../../src/modules/mova-financeiro/index.js");
    for (const p of await criarArmazenamentoPostgres({ pool: banco.pool }).politicas.listar(ORG_X)) validarPolitica(p);
    await banco.pool.query(sqlRevogarPoliticasDaUnidade({ organizacaoId: ORG_X, unidadeId: XIS, revogadaPor: HUMANO }));
    assert.equal(Number((await banco.pool.query("select count(*) n from mova.politica_autonomia where revogada_em is null")).rows[0].n), 0);
    assert.equal(Number((await banco.pool.query("select count(*) n from mova.auditoria where acao in ('POLITICAS_DA_UNIDADE','POLITICAS_REVOGADAS')")).rows[0].n), 3);
  } finally { await descartarBancoMova(banco); }
});

// ------------------------------------------------------------------ 27/11 (PR #236): operação entre empresas EXECUTADA pelo WhatsApp
// Só com: conta EXISTENTE na devedora, "sim" de quem é FINANCEIRO nas duas, política OPERACAO_ENTRE_EMPRESAS nas DUAS unidades
// (vale o MENOR limite) e a ação estreita `registrar_intercompany` da identidade operacional nas DUAS. Senão: proposta.
const ACOES_IC = [...TODAS_ACOES, "financeiro_v2.registrar_intercompany"];
const POL_IC = (s, org, u, limiteCentavos) => s.mova.armazenamento.politicas.criar(POL("OPERACAO_ENTRE_EMPRESAS", org, u, { limiteCentavos, nivel: "APLICAR_COM_CONFIRMACAO" }), { criadaPor: HUMANO });
/** comprovante da credora citando a devedora, e o "sim" de quem é FINANCEIRO nas duas */
async function confirmarIC(s, { marca, legenda = "MOVA comprovante, distribuidora alfa" }) {
  const doc = s.privado({ texto: legenda, doc: pdf(marca) });
  await s.enviar(doc);
  assert.equal((await s.ultima()).motivo, "ENTRE_EMPRESAS_AGUARDANDO_CONFIRMACAO");
  await s.enviar(s.privado({ texto: "sim", respostaA: doc.mensagemId }));
  return doc;
}

t("EC-5 conta EXISTENTE + política nas DUAS + concessão estreita nas DUAS: o 'sim' REGISTRA (atômico) — passivo na Alfa, ativo na Xis, nenhuma saída nem despesa nova", async () => {
  const s = await multi({ responder: () => comprovanteIC(), acoes: ACOES_IC });
  await POL_IC(s, ORG, ALFA, 1_000_000); await POL_IC(s, ORG_X, XIS, 3_000_000);
  const conta = (await s.conta("2026-10-14", VALOR_IC)).obrigacoes[0];
  await confirmarIC(s, { marca: "ic-5" });
  const [p] = await s.propostas(ORG, ALFA);
  assert.equal(p.estado, "APLICADA", "executada pela identidade operacional");
  assert.equal(p.autonomia?.nivel, "APLICAR_COM_CONFIRMACAO");
  assert.match(await s.resposta(), /Registrado: a conta do Loja Alfa \(R\$\s?6\.495,60\) ficou paga pela Loja Xis/);
  assert.equal((await s.contas(ORG, ALFA)).find((x) => x.id === conta.id).saldoCentavos, 0);
  assert.deepEqual([(await entre(s, ORG, ALFA)).aPagarCentavos, (await entre(s, ORG_X, XIS)).aReceberCentavos], [VALOR_IC, VALOR_IC]);
  assert.deepEqual([(await s.despesas(ORG_X, XIS)).length, (await s.saidas(ORG, ALFA)).length, (await s.saidas(ORG_X, XIS)).length], [0, 0, 0]);
  // a identidade operacional usou SÓ [ver, registrar_intercompany] — nos dois lados, nunca a ampla `registrar`
  const ic = s.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa");
  assert.equal(ic.length, 1);
  assert.deepEqual(ic[0].permissoes, ["financeiro_v2.ver", "financeiro_v2.registrar_intercompany"]);
  // o mesmo comprovante de novo não registra duas vezes
  await s.enviar(s.privado({ texto: "MOVA comprovante, distribuidora alfa", doc: pdf("ic-5") }));
  assert.deepEqual([(await entre(s, ORG, ALFA)).aPagarCentavos, s.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa").length], [VALOR_IC, 1], "idempotente");
});

t("EC-6 vale o MENOR limite das duas unidades: acima do limite da credora (ou sem política nela) fica a PROPOSTA; nada escrito em nenhuma empresa", async () => {
  for (const [limA, limX, motivo] of [[1_000_000, 600_000, /CREDORA:/], [600_000, 3_000_000, /ACIMA|LIMITE/], [1_000_000, null, /CREDORA:/]]) {
    const s = await multi({ responder: () => comprovanteIC(), acoes: ACOES_IC });
    await POL_IC(s, ORG, ALFA, limA); if (limX) await POL_IC(s, ORG_X, XIS, limX);
    await s.conta("2026-10-14", VALOR_IC);
    await confirmarIC(s, { marca: `ic-6-${limA}-${limX}` });
    const [p] = await s.propostas(ORG, ALFA);
    assert.equal(p.estado, "AGUARDANDO_REVISAO", `limites ${limA}/${limX}: fica para a Central`);
    assert.match(p.autonomia.motivos.join(","), motivo);
    assert.deepEqual([s.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa").length, (await entre(s, ORG, ALFA)).aPagarCentavos ?? 0], [0, 0]);
    assert.match(await s.resposta(), /Nada foi lançado ainda/);
  }
});

t("EC-7 sem `registrar_intercompany` numa das duas (ou só com a ampla), conta NOVA ou várias contas: nunca executa sozinho", async () => {
  // concessão estreita só na Alfa
  const s = await multi({ responder: () => comprovanteIC(), concessoes: [{ org: ORG, unidade: ALFA, acoes: ACOES_IC }, { org: ORG_X, unidade: XIS, acoes: TODAS_ACOES }] });
  await POL_IC(s, ORG, ALFA, 1_000_000); await POL_IC(s, ORG_X, XIS, 3_000_000);
  await s.conta("2026-10-14", VALOR_IC);
  await confirmarIC(s, { marca: "ic-7a" });
  const [p] = await s.propostas(ORG, ALFA);
  assert.deepEqual([p.estado, p.autonomia.nivel], ["AGUARDANDO_REVISAO", "APLICAR_COM_CONFIRMACAO"]);
  assert.equal(s.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa").length, 0, "SEM_CONCESSAO_OPERACIONAL na Xis: nada escrito");
  // conta NOVA (nenhuma conta prévia na Alfa): exige a aprovação humana, mesmo com tudo concedido
  const n = await multi({ responder: () => comprovanteIC(), acoes: ACOES_IC });
  await POL_IC(n, ORG, ALFA, 1_000_000); await POL_IC(n, ORG_X, XIS, 3_000_000);
  await confirmarIC(n, { marca: "ic-7b" });
  const [pn] = await n.propostas(ORG, ALFA);
  assert.equal(pn.estado, "AGUARDANDO_REVISAO");
  assert.deepEqual([(await n.contas(ORG, ALFA)).length, n.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa").length], [0, 0]);
  // várias contas compatíveis: quem revisa escolhe (nunca o MOVA)
  const v = await multi({ responder: () => comprovanteIC(), acoes: ACOES_IC });
  await POL_IC(v, ORG, ALFA, 1_000_000); await POL_IC(v, ORG_X, XIS, 3_000_000);
  await v.conta("2026-10-14", VALOR_IC); await v.conta("2026-10-20", VALOR_IC);
  await confirmarIC(v, { marca: "ic-7c" });
  assert.equal((await v.propostas(ORG, ALFA))[0].estado, "AGUARDANDO_REVISAO");
  assert.equal(v.chamadas.filter((x) => x.nome === "registrarPagamentoPorOutraEmpresa").length, 0);
});

t("EC-8 sentido INVERSO: conta da Xis paga pela Alfa — mesmo fluxo e mesmas travas (passivo na Xis, ativo na Alfa)", async () => {
  const s = await multi({ responder: () => comprovanteIC({ pagador: "ALFA PRODUTOS" }), acoes: ACOES_IC });
  await POL_IC(s, ORG, ALFA, 3_000_000); await POL_IC(s, ORG_X, XIS, 1_000_000);
  const conta = (await s.contaXis("2026-10-14", VALOR_IC)).obrigacoes[0];
  await confirmarIC(s, { marca: "ic-8", legenda: "MOVA comprovante, loja xis" });
  const [p] = await s.propostas(ORG_X, XIS);
  assert.deepEqual([p?.tipo, p?.estado, p?.comando?.credora?.unidadeId], ["INTERCOMPANY", "APLICADA", ALFA]);
  assert.equal((await s.propostas(ORG, ALFA)).length, 0, "a proposta fica na devedora (Xis)");
  assert.equal((await s.contas(ORG_X, XIS)).find((x) => x.id === conta.id).saldoCentavos, 0);
  assert.deepEqual([(await entre(s, ORG_X, XIS)).aPagarCentavos, (await entre(s, ORG, ALFA)).aReceberCentavos], [VALOR_IC, VALOR_IC]);
  assert.deepEqual([(await s.despesas(ORG, ALFA)).length, (await s.saidas(ORG, ALFA)).length], [0, 0], "nada de despesa nem saída nova na pagadora");
});

t("EC-9 Central com AUTORIZAÇÃO VINCULADA (fábrica da rota): aplica com o contexto da credora; fábrica que recusa ⇒ CONTRAPARTE_NAO_AUTORIZADA, auditado, nada muda", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  await s.conta("2026-10-14", VALOR_IC);
  await confirmarIC(s, { marca: "ic-9" });
  const [p] = await s.propostas(ORG, ALFA);
  const pedidos = [];
  const recusa = async (pedido) => { pedidos.push(pedido); throw Object.assign(new Error("MFA_AUSENTE"), { codigo: "MFA_AUSENTE" }); };
  await assert.rejects(s.mova.aprovador.aplicar(s.c(ORG, ALFA), { propostaId: p.id }, { nucleo: s.m.nucleo, entreEmpresas: recusa }), (e) => e.codigo === "CONTRAPARTE_NAO_AUTORIZADA" && e.detalhes?.motivo === "MFA_AUSENTE");
  assert.deepEqual([pedidos[0].organizacaoId, pedidos[0].unidadeId, pedidos[0].propostaId, typeof pedidos[0].chave], [ORG_X, XIS, p.id, "string"], "a autorização pedida é a da credora, presa à operação");
  const aud = (await s.mova.armazenamento.auditoria.listar()).find((x) => x.acao === "AUTORIZACAO_VINCULADA_RECUSADA");
  assert.deepEqual([aud?.alvo, aud?.dados?.motivo, aud?.dados?.credora], [p.id, "MFA_AUSENTE", XIS], "a recusa fica auditada");
  assert.deepEqual([(await s.propostas(ORG, ALFA))[0].estado, (await entre(s, ORG, ALFA)).aPagarCentavos ?? 0], ["AGUARDANDO_REVISAO", 0]);
  // fábrica que devolve o contexto de OUTRA pessoa na credora: recusada antes de qualquer escrita
  const { ctx } = await import("../financeiro-v2/helpers/cenario.js");
  const outra = async () => ({ ctx: ctx(ORG_X, XIS, undefined, "eeeeeeee-0000-4000-8000-000000000099"), nucleo: s.m.nucleo, executar: (fn) => fn() });
  await assert.rejects(s.mova.aprovador.aplicar(s.c(ORG, ALFA), { propostaId: p.id }, { nucleo: s.m.nucleo, entreEmpresas: outra }), (e) => e.codigo === "CONTRAPARTE_INVALIDA");
  // fábrica válida: o núcleo roda DENTRO do `executar` da autorização (a sessão vinculada só vale ali)
  let dentro = 0;
  const valida = async () => ({ ctx: s.c(ORG_X, XIS), nucleo: s.m.nucleo, executar: async (fn) => { dentro++; return fn(); } });
  const aplicada = await s.mova.aprovador.aplicar(s.c(ORG, ALFA), { propostaId: p.id }, { nucleo: s.m.nucleo, entreEmpresas: valida });
  assert.deepEqual([aplicada.estado, dentro], ["APLICADA", 1]);
  assert.deepEqual([(await entre(s, ORG, ALFA)).aPagarCentavos, (await entre(s, ORG_X, XIS)).aReceberCentavos], [VALOR_IC, VALOR_IC]);
});

// ------------------------------------------------------------------ 27/11 — homologação REAL (R$ 6.495,60): regressão
// Defeito 1: "<devedora>, pago pela <credora>" cita as DUAS lojas e virava "de qual unidade?" (TEXTO_CITA_VARIAS).
// Defeito 2: o favorecido do Pix era a instituição de pagamento (não o fornecedor) ⇒ a conta aberta de mesmo valor não era achada
//            e o MOVA propunha uma conta NOVA (duplicidade). Nos dois sentidos (Xis→Alfa e Alfa→Xis).
t("EC-R0 regra pura: as duas lojas citadas + pagadora entre elas ⇒ a outra é a devedora; sem pagadora, ou a pagadora fora das citadas, continua perguntando", () => {
  const cfg = validarConfiguracao(CONFIG());
  const ambas = { unidades: [ALFA, XIS] };
  const a = resolverUnidade({ cfg, grupo: ambas, textos: ["Loja Alfa, pago pela Loja Xis (MP)"], pagador: "MP" });
  assert.deepEqual([a.resultado, a.unidade.unidadeId, a.pagadora.unidadeId], [RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, ALFA, XIS]);
  const b = resolverUnidade({ cfg, grupo: ambas, textos: ["Loja Xis, pago pela Loja Alfa"], pagador: "ALFA PRODUTOS" });
  assert.deepEqual([b.resultado, b.unidade.unidadeId, b.pagadora.unidadeId], [RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, XIS, ALFA]);
  const c = resolverUnidade({ cfg, grupo: ambas, textos: ["Loja Alfa e Loja Xis"] });
  assert.deepEqual([c.resultado, c.evidencia], [RESULTADO_UNIDADE.CONFLITANTE, "TEXTO_CITA_VARIAS"], "sem pagadora: pergunta");
  const d = resolverUnidade({ cfg, grupo: ambas, textos: ["Loja Alfa e Loja Xis"], pagador: "Fulano de Tal" });
  assert.equal(d.resultado, RESULTADO_UNIDADE.CONFLITANTE, "pagador desconhecido: pergunta");
});

for (const [rotulo, pagador, legenda, org, unidade, nomeDev, nomeCred, abrirConta] of [
  ["Xis pagou pela Alfa", "MP", "Loja Alfa, pago pela Loja Xis (MP)", ORG, ALFA, "Loja Alfa", "Loja Xis", (s) => s.conta("2026-10-14", VALOR_IC)],
  ["Alfa pagou pela Xis", "ALFA PRODUTOS", "Loja Xis, pago pela Loja Alfa (ALFA PRODUTOS)", ORG_X, XIS, "Loja Xis", "Loja Alfa", (s) => s.contaXis("2026-10-14", VALOR_IC)],
]) {
  t(`EC-R1 ${rotulo}: favorecido = instituição de pagamento ⇒ NÃO pergunta a unidade, reconhece a conta EXISTENTE (única por valor), nada duplicado; o 'sim' leva à proposta sobre ela`, async () => {
    const s = await multi({ responder: () => comprovanteIC({ pagador, favorecido: "PIXPAG PAGAMENTOS LTDA" }) });
    const conta = (await abrirConta(s)).obrigacoes[0];
    const doc = s.privado({ texto: legenda, doc: pdf(`ic-r1-${pagador}`) });
    await s.enviar(doc);
    const h = await s.ultima();
    assert.deepEqual([h.decisao, h.motivo], ["PEDIR_INFORMACAO", "ENTRE_EMPRESAS_AGUARDANDO_CONFIRMACAO"], "uma só pergunta, a de confirmação");
    const texto = await s.resposta();
    assert.doesNotMatch(texto, /ou Loja \w+\?/, "não pergunta a unidade");
    assert.match(texto, new RegExp(`Conta encontrada no ${nomeDev}: Fornecedor Sintético`));
    assert.match(texto, new RegExp(`paga pela ${nomeCred}, sem criar conta nova`));
    assert.match(texto, /PIXPAG PAGAMENTOS LTDA.*ÚNICA em aberto/s);
    assert.doesNotMatch(texto, /será proposta uma conta nova/);
    assert.deepEqual([s.escritas().length, (await s.propostas(org, unidade)).length], [0, 0], "nada gravado antes do sim");
    await s.enviar(s.privado({ texto: "sim", respostaA: doc.mensagemId }));
    const [p] = await s.propostas(org, unidade);
    assert.equal(p.tipo, "INTERCOMPANY");
    assert.equal(p.comando.entrada.obrigacaoId, conta.id, "a proposta é sobre a conta existente");
    assert.equal(p.comando.entrada.obrigacaoNova, undefined, "nenhuma obrigação nova");
    assert.equal((await s.contas(org, unidade)).length, 1, "nenhuma conta duplicada");
  });
}

t("EC-R2 duas contas abertas com o mesmo valor ⇒ não escolhe: a revisão escolhe; nenhuma ⇒ conta nova (como antes); valor diferente não é candidata", async () => {
  const dois = await multi({ responder: () => comprovanteIC({ favorecido: "PIXPAG PAGAMENTOS LTDA" }) });
  await dois.conta("2026-10-14", VALOR_IC); await dois.conta("2026-10-20", VALOR_IC);
  await dois.enviar(dois.privado({ texto: "Loja Alfa, pago pela Loja Xis (MP)", doc: pdf("ic-r2a") }));
  assert.match(await dois.resposta(), /mais de uma conta em aberto com esse valor/);
  const nenhuma = await multi({ responder: () => comprovanteIC({ favorecido: "PIXPAG PAGAMENTOS LTDA" }) });
  await nenhuma.conta("2026-10-14", VALOR_IC + 1);
  await nenhuma.enviar(nenhuma.privado({ texto: "Loja Alfa, pago pela Loja Xis (MP)", doc: pdf("ic-r2b") }));
  assert.match(await nenhuma.resposta(), /será proposta uma conta nova/);
});

t("EC-R3 favorecido que BATE com o fornecedor continua sendo o critério forte (sem a ressalva 'por valor')", async () => {
  const s = await multi({ responder: () => comprovanteIC() });
  await s.conta("2026-10-14", VALOR_IC);
  await s.enviar(s.privado({ texto: "Loja Alfa, pago pela Loja Xis (MP)", doc: pdf("ic-r3") }));
  const texto = await s.resposta();
  assert.match(texto, /Conta encontrada no Loja Alfa: Fornecedor Sintético/);
  assert.doesNotMatch(texto, /ÚNICA em aberto/);
});
