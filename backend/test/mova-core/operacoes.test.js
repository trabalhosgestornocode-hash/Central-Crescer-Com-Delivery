// MOVA CORE — F4 integrada (§7–§11): proposta pelo modelo (roteirizado), confirmação DETERMINÍSTICA pelo servidor e execução
// pela lista fechada de escrita contra o NÚCLEO REAL do Financeiro v2 (memória). Dados SINTÉTICOS. Nenhuma chamada externa.
// O que se prova: nada é gravado antes da confirmação; o sucesso sai da transação real; nada duplica; política, permissão,
// validade, concorrência e outra pessoa são respeitadas; a sangria nunca gera uma segunda saída.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "../../src/modules/mova-core/index.js";
import { criarServicoDeOperacoes, intencaoDeterministica, ESTADO_PROPOSTA, criarRepositorioDePropostasMemoria, textoDoDesfecho, chaveCanonicaDoFavorecido, validadeDaConfiguracao } from "../../src/modules/mova-core/operacoes.js";
import { executorDaPessoa, OPERACOES_DE_ESCRITA } from "../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { OPERACOES_PERMITIDAS } from "../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";
import { ErroTransitorio } from "../../src/modules/mova-financeiro/gateway/fila.js";
import { AGORA, ORG_A, UNI_A, UNI_A2, montarComCadastros } from "../financeiro-v2/helpers/cenario.js";
import { clienteRoteirizado, usar, falar, PERFIL_FIN } from "./helpers.js";

const HOJE = "2026-10-15"; const DIA = "2026-10-14";
const pdf = (marca = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${marca}\n%%EOF\n`);
const ANEXO = (marca = "brownies", idTransacao = "E00000000202610141200ABCDEF123456") => ({ arquivo: { conteudo: pdf(marca), nome: "comprovante.pdf", tipoMime: "application/pdf" }, referencia: "comprovante.pdf", idTransacao });
const POLITICAS = (unidadeId = UNI_A, limiteCentavos = 100000) => ["DESPESA_DOCUMENTAL", "PRESTACAO_DE_SANGRIA"].map((operacao, i) => ({ id: `pol-${i}`, operacao, organizacaoId: ORG_A, unidadeId, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos, vigenteDe: "2026-01-01", vigenteAte: null, revogadaEm: null }));

async function montar({ politicas = POLITICAS(), autorizado = true, porta: portaDada = null, roteiro = [], repositorio = undefined, relogio = () => AGORA.getTime(), validadeMs = undefined } = {}) {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = m.c;
  const doce = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Doce Brownie Ltda" });
  // conta ANTIGA do mesmo fornecedor (a "da quinzena"): a compra nova NUNCA pode baixá-la
  const antiga = (await n.registrarObrigacao(c, { contraparteId: doce.id, valorOriginalCentavos: 8100, categoria: "INSUMOS", descricao: "Brownies 2ª quinzena", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" })).obrigacoes[0];
  const leitura = { permissoesDoUsuario: async () => ["financeiro_v2.ver"], async ler(op, escopo, entrada) { if (!OPERACOES_PERMITIDAS.includes(op)) throw new Error(`leitura não permitida: ${op}`); return n[op]({ ...c, unidadeId: escopo.unidadeId }, entrada); } };
  const chamadas = [];
  const escrita = portaDada ?? executorDaPessoa({ nucleo: Object.fromEntries(Object.entries(n).map(([k, f]) => [k, typeof f === "function" ? (cx, e) => { chamadas.push(k); return f(cx, e); } : f])), ctx: c });
  let lista = politicas;
  const operacoes = criarServicoDeOperacoes({ porta: leitura, portaOperacional: escrita, politicas: async () => lista, relogio, ...(repositorio ? { repositorio } : {}), ...(validadeMs ? { validadeMs } : {}) });
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
  return { m, n, c, doce, antiga, operacoes, leitura, escrita, core, cliente, turno, retrato, chamadas, abrirSangria, trocarPoliticas: (x) => { lista = x; } };
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
  // o SERVIDOR anexa o comprovante à proposta aberta (v2) e o modelo ainda prepara de novo (v3): só a mais nova vale
  assert.deepEqual(lista.map((x) => [x.versao, x.estado]), [[3, "AGUARDANDO_CONFIRMACAO"], [2, "SUBSTITUIDA"], [1, "SUBSTITUIDA"]]);
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

test("SG-3 várias despesas numa retirada e prestação PARCIAL (o resto continua pendente); caixa da retirada FECHADO: sem caixa aberto o troco espera (nunca reabre); com o caixa do dia aberto, o troco volta NELE", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const { movId } = await t.abrirSangria(5000, "Compras do dia");
  const p = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1800, descricao: "Pão", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }, { valorCentavos: 2000, descricao: "Queijo", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  // 25/11: "Fornecedor Sintético" não tem conta no Financeiro ⇒ cadastro novo ⇒ aviso (impede a execução automática; o "sim" segue valendo)
  assert.deepEqual([p.proposta.estado, p.proposta.avisos, p.proposta.dados.restaCentavos], ["AGUARDANDO_CONFIRMACAO", ["FORNECEDOR_NOVO", "PRESTACAO_PARCIAL"], 1200]);
  const r = await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([r.executada, r.feitos.length, r.feitos.at(-1).pendenteDepoisCentavos], [true, 2, 1200]);

  const f = await montar();
  const { movId: m2, sessao: caixaAntigo } = await f.abrirSangria(1500, "Comprar grampos", { fechar: true });
  const args = { sangria: m2, despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }], trocoCentavos: 300 };
  const semCaixa = await f.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args });
  assert.deepEqual([semCaixa.proposta.estado, semCaixa.proposta.requisitos], ["AGUARDANDO_DADOS", ["CAIXA_ABERTO"]], "sem caixa aberto: nada reabre, o troco espera");
  assert.equal((await f.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })).motivo, "FALTAM_DADOS");
  // a Central abre o caixa de HOJE (procedimento normal da tesouraria); o troco volta nele, com a data de hoje
  const { sessao: caixaHoje } = await f.n.abrirCaixa(f.c, { contaId: f.m.caixa.id, dataAbertura: HOJE, saldoContadoCentavos: 8500 });
  const comCaixa = await f.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args });
  assert.deepEqual([comCaixa.proposta.estado, comCaixa.proposta.avisos.includes("TROCO_NO_CAIXA_ATUAL"), comCaixa.proposta.dados.sessaoDaDevolucaoId], ["AGUARDANDO_CONFIRMACAO", true, caixaHoje.id]);
  assert.match(comCaixa.proposta.resumo, /caixa aberto hoje/);
  const x = await f.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.equal(x.executada, true);
  const [s] = (await f.n.consultarPrestacaoDeSangrias(f.c)).itens;
  assert.deepEqual([s.estado, s.pendenteCentavos, s.caixaDaRetirada], ["PRESTADA", 0, "FECHADA"]);
  const antigo = (await f.n.consultarRegistros(f.c, { tipo: "SESSAO_CAIXA" })).find((z) => z.id === caixaAntigo.id);
  assert.equal(antigo.situacao, "FECHADA", "o caixa antigo continua fechado (nenhuma reabertura, nada retroativo)");
});

test("SG-4 edição CONCORRENTE (Central/Dashboard) entre o preparo e o 'sim': a proposta fica DESATUALIZADA antes de qualquer gravação; o texto diz o novo pendente", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const { movId, sessao: cx } = await t.abrirSangria(1500);
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "PRESTACAO_DE_SANGRIA", args: { sangria: movId, despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }] } });
  await t.n.registrarDespesaDaSangria(t.c, { sessaoId: cx.id, movimentacaoId: movId, chave: "CENTRAL:1", justificativa: "Compra registrada pela Central", confirmar: true,
    obrigacao: { contraparteId: t.m.fornecedor.id, valorOriginalCentavos: 1000, categoria: "INSUMOS", descricao: "Outra compra" } });
  const antes = await t.retrato();
  const chamadasAntes = t.chamadas.length;
  const r = await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([r.ok, r.motivo, r.recusa], [false, "PROPOSTA_DESATUALIZADA", "EXCEDE_O_PENDENTE"]);
  assert.equal(t.chamadas.length, chamadasAntes, "nenhuma escrita foi sequer tentada");
  assert.deepEqual(await t.retrato(), antes);
  assert.match(textoDoDesfecho(r), /agora faltam só R\$ 5,00/);
  assert.equal((await t.operacoes.daConversa("k"))[0].estado, "DESATUALIZADA");
});

test("OP-08 categoria trocada na conversa: nova versão com a categoria nova; só ela é executada", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  const v2 = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, categoria: "Embalagens" } });
  assert.deepEqual([v2.proposta.versao, v2.proposta.dados.categoria, Boolean(v2.proposta.anexo)], [2, "EMBALAGENS", true], "o comprovante do turno anterior continua valendo");
  assert.equal((await t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })).executada, true);
  const nova = (await t.n.consultarRegistros(t.c, { tipo: "OBRIGACAO" })).find((o) => o.descricao === "Brownies (compra nova)");
  assert.equal((await t.n.detalharContaAPagar(t.c, { id: nova.id })).titulo.categoria.codigo, "EMBALAGENS");
});

test("OP-09 documentos DIFERENTES para a MESMA transação (mesmo ID do Pix) e o MESMO arquivo em outra compra: o 2º é recusado pelo Financeiro e nada fica gravado", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const ok = async (chave, args, anexo) => { await t.operacoes.preparar({ conversaChave: chave, sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args, anexo }); return t.operacoes.confirmar({ conversaChave: chave, autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } }); };
  assert.equal((await ok("k1", COMPRA, ANEXO("foto-1", "E0000000020261014TRANSACAOUNICA0001"))).executada, true);
  const depois = await t.retrato();
  const outraFoto = await ok("k2", { ...COMPRA, descricao: "Brownies (outra foto)" }, ANEXO("foto-2", "E0000000020261014TRANSACAOUNICA0001"));
  assert.deepEqual([outraFoto.ok, outraFoto.parcial, outraFoto.proposta.estado], [false, false, "FALHOU"]);
  const mesmoArquivo = await ok("k3", { ...COMPRA, descricao: "Brownies (mesmo arquivo)" }, ANEXO("foto-1", "E0000000020261014OUTRATRANSACAO02"));
  assert.equal(mesmoArquivo.ok, false);
  assert.deepEqual(await t.retrato(), depois, "nenhuma conta, despesa ou baixa a mais");
});

test("OP-10 fornecedor AMBÍGUO: a proposta pede qual (com os candidatos) e não escolhe sozinha; com o nome exato, resolve", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  for (const nome of ["Atacadão Centro", "Atacadão Norte"]) {
    const f = await t.n.registrarContraparte(t.c, { tipo: "FORNECEDOR", nome });
    await t.n.registrarObrigacao(t.c, { contraparteId: f.id, valorOriginalCentavos: 5000, categoria: "INSUMOS", descricao: "x", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30" });
  }
  const a = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, fornecedor: "Atacadão" }, anexo: ANEXO() });
  assert.deepEqual([a.proposta.estado, a.proposta.requisitos.includes("FORNECEDOR_AMBIGUO")], ["AGUARDANDO_DADOS", true]);
  assert.deepEqual((a.detalhes.candidatosFornecedor ?? []).map((x) => x.nome ?? x).sort(), ["Atacadão Centro", "Atacadão Norte"]);
  const b = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, fornecedor: "Atacadão Norte" } });
  assert.deepEqual([b.proposta.estado, b.proposta.dados.fornecedor], ["AGUARDANDO_CONFIRMACAO", "Atacadão Norte"]);
});

test("OP-11 anti-fracionamento pela identidade CANÔNICA: 'Padaria Pão Quente' e 'PADARIA PAO QUENTE LTDA.' somam no mesmo favorecido", async () => {
  assert.equal(chaveCanonicaDoFavorecido("Padaria Pão Quente"), chaveCanonicaDoFavorecido("PADARIA PAO QUENTE LTDA."));
  assert.equal(chaveCanonicaDoFavorecido("Doce Brownie ME"), chaveCanonicaDoFavorecido("doce  brownie"));
  assert.notEqual(chaveCanonicaDoFavorecido("Padaria Pão Quente"), chaveCanonicaDoFavorecido("Padaria Pão Doce"));
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  await t.operacoes.preparar({ conversaChave: "k1", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, fornecedor: "Padaria Pão Quente", valorCentavos: 60000, descricao: "Pães lote 1" }, anexo: ANEXO("p1", "E0000000020261014PADARIA00000001") });
  assert.equal((await t.operacoes.confirmar({ conversaChave: "k1", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })).executada, true);
  const b = await t.operacoes.preparar({ conversaChave: "k2", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, fornecedor: "PADARIA PAO QUENTE LTDA.", valorCentavos: 60000, descricao: "Pães lote 2" }, anexo: ANEXO("p2", "E0000000020261014PADARIA00000002") });
  assert.deepEqual([b.proposta.estado, b.proposta.decisao.motivos.includes("POSSIVEL_FRACIONAMENTO")], ["EM_REVISAO_HUMANA", true]);
  const forn = (await t.n.consultarRegistros(t.c, { tipo: "CONTRAPARTE" })).filter((x) => /padaria/i.test(x.nome));
  assert.equal(forn.length, 1, "o 2º pedido reconhece o fornecedor criado pelo 1º (não duplica o cadastro)");
});

test("OP-12 validade configurável (5–120 min, padrão 30) e retomada de execução INTERROMPIDA entre a transação e a gravação do desfecho, sem duplicar", async () => {
  assert.equal(validadeDaConfiguracao({ MOVA_CORE_PROPOSTA_VALIDADE_MIN: "10" }), 600_000);
  for (const v of [undefined, "1", "500", "abc"]) assert.equal(validadeDaConfiguracao({ MOVA_CORE_PROPOSTA_VALIDADE_MIN: v }), 30 * 60_000, String(v));
  let agora = AGORA.getTime();
  const repo = criarRepositorioDePropostasMemoria();
  let quebrado = false;
  const instavel = { ...repo, salvar: async (p, o) => { if (quebrado) throw new Error("conexão perdida"); if (p.estado === "EXECUTANDO") quebrado = true; return repo.salvar(p, o); } };
  const t = await montar({ repositorio: instavel, relogio: () => agora, validadeMs: 10 * 60_000 });
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  assert.equal(Date.parse((await repo.daConversa("k"))[0].expiraEm) - agora, 10 * 60_000);
  await assert.rejects(t.operacoes.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } }), /conexão perdida/);
  const meio = await t.retrato();
  assert.equal((await repo.daConversa("k"))[0].estado, "EXECUTANDO", "a transação aconteceu; o desfecho não foi gravado");
  // outra instância (processo reiniciado), sobre o mesmo repositório
  const t2 = criarServicoDeOperacoes({ porta: t.leitura, portaOperacional: t.escrita, politicas: async () => POLITICAS(), relogio: () => agora, repositorio: repo });
  assert.equal((await t2.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } })).motivo, "EM_EXECUCAO", "antes do intervalo: não retoma");
  agora += 3 * 60_000;
  assert.equal((await t2.confirmar({ conversaChave: "k", autor: "outra", autorizacaoDeEscrita: { pode: true } })).motivo, "EM_EXECUCAO", "outra pessoa não retoma");
  const r = await t2.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: { pode: true } });
  assert.deepEqual([r.executada, r.feitos.every((f) => f.repetido)], [true, true]);
  assert.match(textoDoDesfecho(r), /já estava registrado/);
  assert.deepEqual(await t.retrato(), meio, "a retomada não duplicou nada");
});

test("OP-13 cache: preparo nunca vem do cache; a leitura é isolada por identidade e permissão e não atravessa mensagens", async () => {
  const { criarExecutor, novaSessao } = await import("../../src/modules/mova-core/executor.js");
  const { criarReferencias } = await import("../../src/modules/mova-core/referencias.js");
  let leituras = 0;
  const catalogo = { ler_algo: { nome: "ler_algo", valores: true, ops: ["consultarContasAPagar"], esquema: { type: "object", properties: {} }, async executar() { leituras++; return { dados: { n: leituras }, fatos: [] }; } },
    preparar_algo: { nome: "preparar_algo", valores: true, ops: [], escrita: "PROPOSTA", esquema: { type: "object", properties: {} }, async executar() { leituras++; return { dados: { n: leituras }, fatos: [] }; } } };
  const ex = criarExecutor({ catalogo, porta: { ler: async () => ({}), permissoesDoUsuario: async () => ["financeiro_v2.ver"] } });
  const conversa = { referencias: criarReferencias(), fatos: [] };
  const sessao = (usuarioId, podeValores = true) => novaSessao({ conversa: { ...conversa }, organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId, unidadesPermitidas: [{ id: UNI_A, nome: "A" }], perfil: PERFIL_FIN, podeValores, requisicaoId: "r", hoje: HOJE });
  const s1 = sessao("pessoa-1");
  await ex.executar(s1, { name: "ler_algo", input: {} }); await ex.executar(s1, { name: "ler_algo", input: {} });
  assert.equal(leituras, 1, "na MESMA mensagem, a mesma leitura vem do cache");
  await ex.executar(s1, { name: "preparar_algo", input: {} }); await ex.executar(s1, { name: "preparar_algo", input: {} });
  assert.equal(leituras, 3, "preparar nunca usa resultado anterior");
  await ex.executar(sessao("pessoa-1"), { name: "ler_algo", input: {} });
  assert.equal(leituras, 4, "mensagem nova ⇒ leitura nova (dado atual)");
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

test("OP-14 TROCO só com menção da pessoa: 'o resto ainda tá comigo' NÃO vira troco (fica pendente); 'voltaram 3 de troco' vira", async () => {
  const t = await montar();
  const { movId } = await t.abrirSangria(5000, "Compra de material de limpeza");
  const base = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const args = { tipo: "PRESTACAO_DE_SANGRIA", sangria: movId, despesas: [{ valorCentavos: 3200, descricao: "Detergente", fornecedor: "Fornecedor Sintético", categoria: "Insumos" }], trocoCentavos: 1800 };
  const r1 = await t.operacoes.preparar({ conversaChave: "k1", sessao: { ...base, textoDaPessoa: "gastei 32 em detergente, o resto ainda tá comigo" }, autor: "pessoa-1", tipo: args.tipo, args });
  assert.deepEqual([r1.proposta.dados.trocoCentavos, r1.proposta.avisos.includes("TROCO_NAO_INFORMADO_PELA_PESSOA")], [0, true]);
  const r2 = await t.operacoes.preparar({ conversaChave: "k2", sessao: { ...base, textoDaPessoa: "gastei 32 e voltaram 18 de troco" }, autor: "pessoa-1", tipo: args.tipo, args });
  assert.equal(r2.proposta.dados.trocoCentavos, 1800);
});

test("OP-15 correção parcial: nova versão sem o valor HERDA o valor da anterior (só a categoria muda)", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  const { valorCentavos: _v, ...semValor } = COMPRA; void _v;
  const v2 = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...semValor, categoria: "Embalagens", fornecedor: undefined } });
  assert.deepEqual([v2.proposta.versao, v2.proposta.dados.valorCentavos, v2.proposta.dados.categoria, v2.proposta.requisitos], [2, 25900, "EMBALAGENS", []]);
});

test("OP-16 comprovante chega num turno em que o modelo NÃO chama a ferramenta: o SERVIDOR anexa à proposta aberta e o 'sim' executa", async () => {
  const semAnexo = { ...COMPRA };
  const t = await montar({ roteiro: [...preparo(semAnexo, "Preparei; falta o comprovante."), [[falar("Recebi o comprovante. Confirma com 'sim'?")]]] });
  await t.turno("comprei 259 de brownies da Doce Brownie ontem no Inter, insumos");
  assert.ok((await t.operacoes.abertaDaConversa(`${ORG_A}|conv-1|5585999990001@s.whatsapp.net`)).requisitos.includes("COMPROVANTE"));
  await t.turno("segue o comprovante", { anexo: ANEXO(), temAnexo: true });
  const r = await t.turno("sim");
  assert.equal(r.operacao?.executada, true, r.texto);
  assert.equal((await t.retrato()).contas, 2);
});

test("OP-17 categoria no singular ('insumo') resolve para 'Insumos' mesmo com 'Outros insumos' e 'Açaí e insumos…' no plano", async () => {
  const t = await montar();
  const sessao = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
  const r = await t.operacoes.preparar({ conversaChave: "k", sessao, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, categoria: "insumo" }, anexo: ANEXO() });
  assert.equal(r.proposta.dados.categoria, "INSUMOS");
  assert.ok(!r.proposta.requisitos.includes("CATEGORIA_AMBIGUA"));
});
