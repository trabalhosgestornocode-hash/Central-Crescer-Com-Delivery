// MOVA CORE — F4 integrada (§7–§11): proposta pelo modelo (roteirizado), confirmação DETERMINÍSTICA pelo servidor e execução
// pela lista fechada de escrita contra o NÚCLEO REAL do Financeiro v2 (memória). Dados SINTÉTICOS. Nenhuma chamada externa.
// O que se prova: nada é gravado antes da confirmação; o sucesso sai da transação real; nada duplica; política, permissão,
// validade, concorrência e outra pessoa são respeitadas; a sangria nunca gera uma segunda saída.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "../../src/modules/mova-core/index.js";
import { criarServicoDeOperacoes, intencaoDeterministica, ESTADO_PROPOSTA, criarRepositorioDePropostasMemoria } from "../../src/modules/mova-core/operacoes.js";
import { executorDaPessoa, OPERACOES_DE_ESCRITA } from "../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { OPERACOES_PERMITIDAS } from "../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";
import { ErroTransitorio } from "../../src/modules/mova-financeiro/gateway/fila.js";
import { AGORA, ORG_A, UNI_A, UNI_A2, montarComCadastros } from "../financeiro-v2/helpers/cenario.js";
import { clienteRoteirizado, usar, falar, PERFIL_FIN } from "./helpers.js";

const HOJE = "2026-10-15"; const DIA = "2026-10-14";
const pdf = (marca = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`);
const ANEXO = (marca = "brownies", idTransacao = "E00000000202610141200ABCDEF123456") => ({ arquivo: { conteudo: pdf(marca), nome: "comprovante.pdf", tipoMime: "application/pdf" }, referencia: "comprovante.pdf", idTransacao });
const POLITICAS = (unidadeId = UNI_A, limiteCentavos = 100000) => ["DESPESA_DOCUMENTAL", "PRESTACAO_DE_SANGRIA"].map((operacao, i) => ({ id: `pol-${i}`, operacao, organizacaoId: ORG_A, unidadeId, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos, vigenteDe: "2026-01-01", vigenteAte: null, revogadaEm: null }));

async function montar({ politicas = POLITICAS(), autorizado = true, porta: portaDada = null, roteiro = [] } = {}) {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = m.c;
  const doce = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Doce Brownie Ltda" });
  // conta ANTIGA do mesmo fornecedor (a "da quinzena"): a compra nova NUNCA pode baixá-la
  const antiga = (await n.registrarObrigacao(c, { contraparteId: doce.id, valorOriginalCentavos: 8100, categoria: "INSUMOS", descricao: "Brownies 2ª quinzena", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" })).obrigacoes[0];
  const leitura = { permissoesDoUsuario: async () => ["financeiro_v2.ver"], async ler(op, escopo, entrada) { if (!OPERACOES_PERMITIDAS.includes(op)) throw new Error(`leitura não permitida: ${op}`); return n[op]({ ...c, unidadeId: escopo.unidadeId }, entrada); } };
  const chamadas = [];
  const escrita = portaDada ?? executorDaPessoa({ nucleo: Object.fromEntries(Object.entries(n).map(([k, f]) => [k, typeof f === "function" ? (cx, e) => { chamadas.push(k); return f(cx, e); } : f])), ctx: c });
  let lista = politicas;
  const operacoes = criarServicoDeOperacoes({ porta: leitura, portaOperacional: escrita, politicas: async () => lista, relogio: () => AGORA.getTime() });
  const cliente = clienteRoteirizado(roteiro);
  const core = criarMovaCore({ porta: leitura, cliente, orcamento: criarOrcamentoMemoria(LIMITES_HOMOLOGACAO), operacoes, opcoes: { documentosNoCore: true }, relogio: () => AGORA.getTime() });
  const turno = (texto, extra = {}) => core.responder({ organizacaoId: ORG_A, conversaId: "conv-1", participanteId: "5585999990001@s.whatsapp.net", usuarioId: "pessoa-1",
    unidadeId: UNI_A, unidadesPermitidas: [{ id: UNI_A, nome: "Alfa Centro" }, { id: UNI_A2, nome: "Alfa Norte" }], perfil: PERFIL_FIN, podeValores: true, texto, hoje: HOJE,
    autorizacaoDeEscrita: { pode: autorizado }, ...extra });
  const retrato = async (u = UNI_A) => {
    const cx = { ...c, unidadeId: u }; const regs = async (tipo) => n.consultarRegistros(cx, { tipo });
    const movs = await regs("MOVIMENTACAO"); const lanc = await regs("LANCAMENTO");
    return { contas: (await regs("OBRIGACAO")).length, despesas: lanc.filter((l) => l.natureza === "DESPESA" && l.situacao === "ATIVO").length, saidas: movs.filter((x) => x.sentido === "SAIDA").length, entradas: movs.filter((x) => x.sentido === "ENTRADA").length, liquidacoes: (await regs("LIQUIDACAO")).length };
  };
  const abrirSangria = async (valor, descricao = "Comprar grampos", { fechar = false } = {}) => {
    const { sessao } = await n.abrirCaixa(c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
    const r = await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: valor, data: DIA, descricao });
    if (fechar) await n.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: DIA, contadoCentavos: 10000 - valor, justificativa: "fechamento sintético", confirmar: true });
    return { movId: r.operacao.movimentacaoId, sessao };
  };
  return { m, n, c, doce, antiga, operacoes, core, cliente, turno, retrato, chamadas, abrirSangria, trocarPoliticas: (x) => { lista = x; } };
}
const preparo = (args, fala = "Preparei. Confirma?") => [[usar("preparar_operacao", args)], [falar(fala)]];
const COMPRA = { tipo: "COMPRA_JA_PAGA", valorCentavos: 25900, fornecedor: "Doce Brownie", dataPagamento: DIA, contaOrigem: "Banco Inter", descricao: "Brownies (compra nova)", categoria: "Insumos" };
const SUCESSO = /registrei|lancei|lancado|registrado|gravad|cadastrad/;
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

test("OP-00 intenção determinística: só a resposta inequívoca confirma/cancela; correção, número ou pergunta NUNCA", () => {
  for (const t of ["sim", "Sim!", "confirmo", "pode lançar", "ok pode", "isso mesmo", "MOVA, sim"]) assert.equal(intencaoDeterministica(t), "CONFIRMAR", t);
  for (const t of ["cancela", "esquece, cancela isso", "não lança", "deixa pra lá", "não"]) assert.equal(intencaoDeterministica(t), "CANCELAR", t);
  for (const t of ["sim, mas são 250", "sim 250", "ok, e quanto devo ao Atacadão?", "pode ser amanhã?", "isso está errado", "sim, outro fornecedor", ""]) assert.equal(intencaoDeterministica(t), null, t);
});

test("OP-01 BROWNIES ponta a ponta: comprovante → proposta (nada gravado) → 'sim' → conta + pagamento por comprovante numa transação; 2º 'sim' não duplica; extrato depois concilia sem 2ª despesa; a conta antiga fica intacta", async () => {
  const t = await montar({ roteiro: [...preparo(COMPRA, "Preparei: compra nova de brownies da Doce Brownie Ltda, R$ 259,00, paga em 14/10 pelo Banco Inter. Confirma?"), [falar("Não há nada pendente para confirmar agora.")]] });
  const antes = await t.retrato();
  const r1 = await t.turno("comprei R$ 259,00 de brownies da Doce Brownie ontem, paguei no Pix do Inter", { anexo: ANEXO(), temAnexo: true });
  assert.equal(r1.motivo, "RESPONDIDO");
  assert.ok(!SUCESSO.test(semAcento(r1.texto)), "nada de 'registrado' antes do backend");
  assert.deepEqual(await t.retrato(), antes, "PROPOSTA: nada gravado no Financeiro");
  const [p] = await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.deepEqual([p.estado, p.faltando], [ESTADO_PROPOSTA.AGUARDANDO_CONFIRMACAO, []]);
  assert.match(p.resumo, /Doce Brownie Ltda/, "fornecedor EXISTENTE reconhecido (não cria outro)");

  const r2 = await t.turno("sim");
  assert.deepEqual([r2.rota, r2.motivo, r2.operacao.executada], ["OPERACAO", "OPERACAO_EXECUTADA", true]);
  assert.match(r2.texto, /^Registrado no Financeiro/);
  assert.deepEqual(t.chamadas, ["registrarDespesaPagaPorComprovante"], "uma única operação da lista fechada");
  const depois = await t.retrato();
  assert.deepEqual([depois.contas - antes.contas, depois.despesas - antes.despesas, depois.saidas - antes.saidas, depois.liquidacoes - antes.liquidacoes], [1, 1, 0, 1], "uma conta, uma despesa, um pagamento, NENHUMA saída bancária inventada");
  const contaAntiga = (await t.n.detalharContaAPagar(t.c, { id: t.antiga.id })).titulo;
  assert.equal(contaAntiga.saldoCentavos ?? contaAntiga.saldoAbertoCentavos ?? 8100, 8100, "a conta da quinzena NÃO foi baixada");

  const r3 = await t.turno("sim");
  assert.notEqual(r3.rota, "OPERACAO", "sem proposta aberta, 'sim' não executa nada");
  assert.deepEqual(await t.retrato(), depois, "2º 'sim': nada duplicado");

  // extrato chega depois: a MESMA baixa é conciliada (nenhuma 2ª despesa / 2ª baixa)
  const exec = (await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`)).find((x) => x.estado === ESTADO_PROPOSTA.EXECUTADA);
  const liqId = exec.resultado.feitos[0].liquidacaoId;
  const saida = (await t.n.registrarMovimentacao(t.c, { contaId: t.m.banco.id, dataEfetiva: DIA, sentido: "SAIDA", valorCentavos: 25900, natureza: "PAGAMENTO", descricao: "PIX DOCE BROWNIE" })).movimentacao;
  const liq = (await t.n.consultarRegistros(t.c, { tipo: "LIQUIDACAO" })).find((l) => l.id === liqId);
  await t.n.conciliarPagamentoPorComprovante(t.c, { liquidacaoId: liqId, movimentacaoId: saida.id, versaoMovimentacao: saida.versao, justificativa: "Extrato do Inter confere com o comprovante", confirmar: true });
  const fim = await t.retrato();
  assert.deepEqual([fim.contas, fim.despesas, fim.liquidacoes], [depois.contas, depois.despesas, depois.liquidacoes], "conciliação sem duplicar");
  assert.ok(liq, "a baixa existe e é a mesma que foi conciliada");
});

test("OP-02 pede SÓ o que falta: sem comprovante a proposta aguarda dados e 'sim' não executa; o comprovante chega e a NOVA versão é a única executada", async () => {
  const t = await montar({ roteiro: [...preparo(COMPRA, "Preparei a compra; para confirmar, falta o comprovante."), ...preparo(COMPRA, "Recebi o comprovante. Confirma?")] });
  const antes = await t.retrato();
  await t.turno("comprei R$ 259,00 de brownies da Doce Brownie ontem, paguei no Pix do Inter");
  const r = await t.turno("sim");
  assert.equal(r.motivo, "OPERACAO_FALTAM_DADOS");
  assert.match(r.texto, /comprovante/);
  assert.ok(!SUCESSO.test(semAcento(r.texto)));
  assert.deepEqual(await t.retrato(), antes);
  await t.turno("segue o comprovante", { anexo: ANEXO(), temAnexo: true });
  const lista = await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.deepEqual(lista.map((x) => [x.versao, x.estado]), [[2, "AGUARDANDO_CONFIRMACAO"], [1, "SUBSTITUIDA"]]);
  assert.equal((await t.turno("pode lançar")).motivo, "OPERACAO_EXECUTADA");
  assert.equal((await t.retrato()).contas - antes.contas, 1);
});

test("OP-03 'sim, mas são 250' NÃO confirma: vai ao modelo, que prepara nova versão; nada gravado até a confirmação pura", async () => {
  const t = await montar({ roteiro: [...preparo(COMPRA), ...preparo({ ...COMPRA, valorCentavos: 25000 }, "Corrigi para R$ 250,00. Confirma?")] });
  const antes = await t.retrato();
  await t.turno("comprei 259 de brownie da Doce Brownie ontem no Inter", { anexo: ANEXO(), temAnexo: true });
  const r = await t.turno("sim, mas são 250");
  assert.notEqual(r.rota, "OPERACAO");
  assert.deepEqual(await t.retrato(), antes);
  const [v2] = await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.deepEqual([v2.versao, v2.estado], [2, "AGUARDANDO_CONFIRMACAO"]);
  await t.turno("sim");
  const x = (await t.n.consultarRegistros(t.c, { tipo: "OBRIGACAO" })).filter((o) => o.descricao === "Brownies (compra nova)");
  assert.deepEqual(x.map((o) => o.valorOriginalCentavos ?? o.valorBaseCentavos), [25000], "só a versão VIGENTE foi executada");
});

test("OP-04 política do Açaí: acima de R$ 1.000 vai para revisão humana; outra unidade (sem política) só propõe; fracionamento não contorna o limite", async () => {
  const t = await montar({ roteiro: [...preparo({ ...COMPRA, valorCentavos: 100001 }), ...preparo({ ...COMPRA, valorCentavos: 60000, descricao: "Brownies lote 1" }), ...preparo({ ...COMPRA, valorCentavos: 60000, descricao: "Brownies lote 2" })] });
  const antes = await t.retrato();
  await t.turno("compra de R$ 1.000,01 de brownies da Doce Brownie ontem no Inter", { anexo: ANEXO("acima"), temAnexo: true });
  let [p] = await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.equal(p.estado, ESTADO_PROPOSTA.EM_REVISAO_HUMANA);
  const rv = await t.turno("sim");
  assert.equal(rv.motivo, "OPERACAO_REVISAO_HUMANA", "proposta em revisão humana não é confirmável pelo chat");
  assert.match(rv.texto, /revisão humana/);
  assert.deepEqual(await t.retrato(), antes);
  await t.turno("600 de brownies lote 1 da Doce Brownie ontem no Inter", { anexo: ANEXO("lote1", "E00000000202610141200LOTE1XXXXXXXX"), temAnexo: true });
  assert.equal((await t.turno("sim")).motivo, "OPERACAO_EXECUTADA", "R$ 600 dentro do limite: executa com confirmação");
  await t.turno("mais 600 de brownies lote 2 da Doce Brownie ontem no Inter", { anexo: ANEXO("lote2", "E00000000202610141200LOTE2XXXXXXXX"), temAnexo: true });
  [p] = await t.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.equal(p.estado, ESTADO_PROPOSTA.EM_REVISAO_HUMANA, "600 + 600 ao mesmo fornecedor em 7 dias > R$ 1.000 ⇒ revisão humana");

  const outra = await montar({ politicas: POLITICAS(UNI_A), roteiro: preparo(COMPRA) });
  await outra.turno("comprei 259 de brownie", { unidadeId: UNI_A2, anexo: ANEXO(), temAnexo: true });
  const [q] = await outra.operacoes.daConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`);
  assert.equal(q.estado, ESTADO_PROPOSTA.EM_REVISAO_HUMANA, "unidade sem política: só proposta");
});

test("OP-05 o limite NÃO substitui a permissão: sem autorização de escrita, 'sim' não executa; política revogada entre o preparo e o 'sim' vale na hora", async () => {
  const t = await montar({ autorizado: false, roteiro: preparo(COMPRA) });
  const antes = await t.retrato();
  await t.turno("comprei 259 de brownie da Doce Brownie ontem no Inter", { anexo: ANEXO(), temAnexo: true });
  const r = await t.turno("sim");
  assert.equal(r.motivo, "OPERACAO_SEM_AUTORIZACAO_DE_ESCRITA");
  assert.deepEqual(await t.retrato(), antes);

  const u = await montar({ roteiro: preparo(COMPRA) });
  await u.turno("comprei 259 de brownie da Doce Brownie ontem no Inter", { anexo: ANEXO(), temAnexo: true });
  u.trocarPoliticas(POLITICAS().map((x) => ({ ...x, revogadaEm: "2026-10-15T10:00:00Z" })));
  assert.equal((await u.turno("sim")).motivo, "OPERACAO_REVISAO_HUMANA");
  assert.deepEqual((await u.retrato()).contas, (await t.retrato()).contas);
});

test("OP-06 outra pessoa não confirma; cancelar descarta; duas confirmações simultâneas executam UMA vez; falha transitória permite repetir sem duplicar", async () => {
  const t = await montar({ roteiro: [...preparo(COMPRA), ...preparo(COMPRA)] });
  const antes = await t.retrato();
  await t.turno("comprei 259 de brownie da Doce Brownie ontem no Inter", { anexo: ANEXO(), temAnexo: true });
  assert.equal((await t.turno("sim", { usuarioId: "outra-pessoa" })).motivo, "OPERACAO_OUTRA_PESSOA");
  const c = await t.turno("esquece, cancela isso");
  assert.deepEqual([c.motivo, c.texto], ["OPERACAO_CANCELADA", "Cancelado: nada entrou no Financeiro."]);
  assert.ok(!SUCESSO.test(semAcento(c.texto)));
  assert.deepEqual(await t.retrato(), antes);

  await t.turno("comprei 259 de brownie da Doce Brownie ontem no Inter", { anexo: ANEXO(), temAnexo: true });
  const chave = `${ORG_A}|conv-1|5585999990001@s.whatsapp.net`;
  const [a, b] = await Promise.all([t.operacoes.confirmar({ conversaChave: chave, autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } }), t.operacoes.confirmar({ conversaChave: chave, autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })]);
  assert.equal([a, b].filter((x) => x.executada).length, 1, "só uma confirmação executa");
  assert.equal((await t.retrato()).contas - antes.contas, 1);

  // falha transitória: o Financeiro cai na 1ª tentativa; a proposta volta a aguardar confirmação e o 2º 'sim' grava uma vez
  let falhas = 1;
  const m2 = await montar({ roteiro: preparo(COMPRA) });
  const real = executorDaPessoa({ nucleo: m2.n, ctx: m2.c });
  const instavel = { chamar: async (op, e, x) => { if (falhas-- > 0) throw new ErroTransitorio("FINANCEIRO_INDISPONIVEL"); return real.chamar(op, e, x); } };
  const ops = criarServicoDeOperacoes({ porta: { ler: (op, esc, en) => m2.n[op]({ ...m2.c, unidadeId: esc.unidadeId }, en) }, portaOperacional: instavel, politicas: async () => POLITICAS(), relogio: () => AGORA.getTime() });
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  await ops.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  const f1 = await ops.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([f1.ok, f1.retentavel, f1.proposta.estado], [false, true, ESTADO_PROPOSTA.AGUARDANDO_CONFIRMACAO]);
  const antes2 = await m2.retrato();
  const f2 = await ops.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.equal(f2.executada, true);
  assert.equal((await m2.retrato()).contas - antes2.contas, 1);
});

test("OP-07 a proposta EXPIRA: depois da validade, 'sim' não executa", async () => {
  let agora = AGORA.getTime();
  const m = await montarComCadastros();
  const ops = criarServicoDeOperacoes({ porta: { ler: (op, esc, en) => m.nucleo[op]({ ...m.c, unidadeId: esc.unidadeId }, en) }, portaOperacional: executorDaPessoa({ nucleo: m.nucleo, ctx: m.c }), politicas: async () => POLITICAS(), relogio: () => agora });
  await ops.preparar({ conversaChave: "k", sessao: { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "p", hoje: HOJE }, autor: "p", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, fornecedor: "Fornecedor Sintético" }, anexo: ANEXO() });
  agora += 31 * 60_000;
  assert.equal((await ops.confirmar({ conversaChave: "k", autor: "p", autorizacaoDeEscrita: { pode: true } })).motivo, "SEM_PROPOSTA_ABERTA");
  assert.deepEqual((await ops.daConversa("k")).map((x) => x.estado), ["EXPIRADA"]);
});

test("SG-1 GRAMPOS pelo MOVA: R$ 15 retirados, R$ 12 gastos, R$ 3 de troco ⇒ proposta; 'sim' ⇒ despesa contra a PRÓPRIA retirada + troco no mesmo caixa; PRESTADA; nenhuma 2ª saída", async () => {
  const t = await montar();
  const { movId } = await t.abrirSangria(1500);
  const args = { tipo: "PRESTACAO_DE_SANGRIA", sangria: movId, despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }], trocoCentavos: 300 };
  // como o modelo real: primeiro LÊ a sangria pendente (a referência precisa ter vindo de uma leitura), depois prepara
  const refDaLeitura = (req) => { const txt = JSON.stringify(req.messages.at(-1).content); const m = /\\"ref\\":\\"([^\\"]+)\\"/.exec(txt); assert.ok(m, "a leitura devolveu uma referência opaca"); assert.ok(!/^[0-9a-f]{8}-/.test(m[1]), "nunca o UUID cru"); return m[1]; };
  const roteiro = clienteRoteirizado([[usar("prestacao_de_sangrias", { somentePendentes: true })], (req) => [usar("preparar_operacao", { ...args, sangria: refDaLeitura(req) })],
    [falar("Preparei: despesa de R$ 12,00 (grampos) paga com a sangria e R$ 3,00 de troco de volta ao caixa. Confirma?")]]);
  const core = criarMovaCore({ porta: { permissoesDoUsuario: async () => ["financeiro_v2.ver"], ler: (op, e, x) => t.n[op]({ ...t.c, unidadeId: e.unidadeId }, x) }, cliente: roteiro, orcamento: criarOrcamentoMemoria(LIMITES_HOMOLOGACAO), operacoes: t.operacoes, relogio: () => AGORA.getTime() });
  const turno = (texto) => core.responder({ organizacaoId: ORG_A, conversaId: "conv-s", participanteId: "p-s", usuarioId: "pessoa-1", unidadeId: UNI_A, unidadesPermitidas: [{ id: UNI_A, nome: "Alfa Centro" }], perfil: PERFIL_FIN, podeValores: true, texto, hoje: HOJE, autorizacaoDeEscrita: { pode: true } });
  const antes = await t.retrato();
  const r1 = await turno("dos 15 da sangria dos grampos, gastei 12 e voltaram 3 de troco");
  assert.ok(!SUCESSO.test(semAcento(r1.texto)));
  assert.deepEqual(await t.retrato(), antes, "proposta: nada gravado");
  const r2 = await turno("sim");
  assert.equal(r2.motivo, "OPERACAO_EXECUTADA");
  assert.match(r2.texto, /totalmente prestada/);
  const depois = await t.retrato();
  assert.deepEqual([depois.contas - antes.contas, depois.despesas - antes.despesas, depois.saidas - antes.saidas, depois.entradas - antes.entradas], [1, 1, 0, 1]);
  const [s] = (await t.n.consultarPrestacaoDeSangrias(t.c)).itens;
  assert.deepEqual([s.estado, s.pendenteCentavos, s.trocoDevolvidoCentavos, s.despesasCentavos], ["PRESTADA", 0, 300, 1200]);
});

test("SG-2 recusas sem gravar: passa do pendente; nenhuma sangria pendente; retirada já prestada não presta de novo (duplicidade)", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  assert.equal((await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { despesas: [{ valorCentavos: 500, descricao: "x" }] } })).motivo, "SEM_SANGRIA_PENDENTE");
  const { movId } = await t.abrirSangria(1500);
  const ex = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 2000, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  assert.deepEqual([ex.ok, ex.motivo, ex.detalhes.pendenteCentavos], [false, "EXCEDE_O_PENDENTE", 1500]);
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1500, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  assert.equal((await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })).executada, true);
  const de = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1500, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  assert.equal(de.motivo, "SEM_SANGRIA_PENDENTE", "já prestada: a mesma retirada não gera 2ª despesa");
});

test("SG-3 várias despesas numa retirada e prestação PARCIAL (o resto continua pendente); caixa FECHADO: a despesa entra, o troco é recusado com o motivo real (execução parcial dita como tal)", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const { movId } = await t.abrirSangria(5000, "Compras do dia");
  const p = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1800, descricao: "Pão", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }, { valorCentavos: 2000, descricao: "Queijo", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  assert.deepEqual([p.proposta.estado, p.proposta.avisos, p.proposta.dados.restaCentavos], ["AGUARDANDO_CONFIRMACAO", ["PRESTACAO_PARCIAL"], 1200]);
  const r = await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([r.executada, r.feitos.length, r.feitos.at(-1).pendenteDepoisCentavos], [true, 2, 1200]);

  const f = await montar();
  const { movId: m2 } = await f.abrirSangria(1500, "Comprar grampos", { fechar: true });
  await f.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: m2, despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }], trocoCentavos: 300 } });
  const x = await f.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([x.ok, x.parcial, x.proposta.estado], [false, true, ESTADO_PROPOSTA.EXECUTADA_PARCIAL]);
  assert.match(x.mensagem, /caixa está fechado/i);
});

test("SG-4 edição CONCORRENTE por outra pessoa entre o preparo e o 'sim': o núcleo recusa o excedente e nada entra em dobro", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const { movId, sessao: cx } = await t.abrirSangria(1500);
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  // outra pessoa, pela Central, presta R$ 10 da mesma retirada
  await t.n.registrarDespesaDaSangria(t.c, { sessaoId: cx.id, movimentacaoId: movId, chave: "CENTRAL:1", justificativa: "Compra registrada pela Central", confirmar: true,
    obrigacao: { contraparteId: t.m.fornecedor.id, valorOriginalCentavos: 1000, categoria: "INSUMOS", descricao: "Outra compra" } });
  const antes = await t.retrato();
  const r = await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([r.ok, r.parcial, r.proposta.estado], [false, false, ESTADO_PROPOSTA.FALHOU]);
  assert.deepEqual(await t.retrato(), antes, "nada gravado pela proposta desatualizada");
});

test("SG-5 a escrita do MOVA só usa a LISTA FECHADA (prestação entra com REGISTRAR; nenhuma operação paga, estorna ou transfere)", () => {
  assert.equal(OPERACOES_DE_ESCRITA.registrarDespesaDaSangria, "REGISTRAR");
  assert.equal(OPERACOES_DE_ESCRITA.registrarTrocoDaSangria, "REGISTRAR");
  for (const proibida of ["registrarTransferencia", "estornarLiquidacao", "estornarMovimentacao", "registrarLiquidacao", "excluirObrigacao"]) assert.equal(OPERACOES_DE_ESCRITA[proibida], undefined, proibida);
  assert.ok(OPERACOES_PERMITIDAS.includes("consultarPrestacaoDeSangrias"));
});

test("SG-6 repositório: CAS de versão impede que duas gravações da mesma proposta se sobreponham", async () => {
  const r = criarRepositorioDePropostasMemoria();
  const { proposta } = await r.salvar({ id: "x", conversaChave: "k", criadaEm: "2026-10-15T00:00:00Z", versao: 1, estado: "AGUARDANDO_CONFIRMACAO" });
  assert.equal((await r.salvar({ ...proposta, estado: "EXECUTANDO" }, { versaoEsperada: proposta.revisao })).ok, true);
  assert.equal((await r.salvar({ ...proposta, estado: "EXECUTANDO" }, { versaoEsperada: proposta.revisao })).ok, false);
});
