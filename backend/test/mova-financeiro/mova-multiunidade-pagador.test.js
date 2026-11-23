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
  idTransacao: `E0000000020261010MULTI${String(++seq).padStart(5, "0")}`, situacaoTransacao: "CONCLUIDA", categoriaSugerida: "INSUMOS", ...x });
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
async function multi({ responder, concessoes = [{ org: ORG, unidade: ALFA }, { org: ORG_X, unidade: XIS }], config = CONFIG(), politicas = true, falharEnvioUmaVez = false } = {}) {
  let falhou = false;
  const s = await cenario({
    responder, config,
    extras: ({ nucleo }) => {
      const comFalha = falharEnvioUmaVez ? { ...nucleo, async enviarEvidencia(cx, ...a) { if (!falhou) { falhou = true; throw Object.assign(new Error("cofre"), { codigo: "COFRE_INDISPONIVEL" }); } return nucleo.enviarEvidencia(cx, ...a); } } : nucleo;
      return {
        autonomia: true, pagamentoPorComprovante: true, criarDespesas: true, criarContas: true,
        operacional: criarPortaOperacional({ nucleo: comFalha, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: SERVICO,
          concessoes: criarConcessoesMemoria(concessoes.map((c) => ({ organizacaoId: c.org, usuarioId: OPERADOR, unidadeId: c.unidade, acoes: TODAS_ACOES }))) }),
      };
    },
  });
  if (process.env.FV2_REPOSITORIO === "postgres") for (const c of concessoes) await s.m.nucleo.concederAcesso(s.c(c.org, c.unidade), { usuarioId: OPERADOR, acoes: TODAS_ACOES, justificativa: "Identidade operacional do MOVA (sintético)." });
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
  assert.equal(resolverUnidade({ cfg, grupo: ambas, textos: ["brownies da alfa"], pagador: "MP" }).resultado, RESULTADO_UNIDADE.CONFLITANTE);
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

t("MU-7 conflito (legenda 'alfa', pagador MP): não grava; pergunta; insistir em 'alfa' continua bloqueado", async () => {
  const s = await multi({ responder: () => PIX({ pagador: "MP" }) });
  await s.enviar(s.privado({ texto: "MOVA brownies da alfa", doc: pdf("7") }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["PEDIR_INFORMACAO", "UNIDADE_CONFLITANTE"]);
  await s.enviar(s.privado({ texto: "alfa" }));
  assert.equal((await s.ultima()).decisao, "BLOQUEADO");
  assert.deepEqual([s.escritas().length, (await s.propostas(ORG, ALFA)).length, (await s.propostas(ORG_X, XIS)).length], [0, 0, 0]);
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
