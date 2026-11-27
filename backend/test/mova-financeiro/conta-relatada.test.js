// 26/11 — CONTA A PAGAR RELATADA POR TEXTO (sem documento). Caso real (dados SINTÉTICOS): "Compra de bebedouro para o açaí, 2 parcelas
// no cartão, Dia 19/12 e 19/01 valor de R$194,50." Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL local isolado (com a
// migração 0025), IA SIMULADA (só a leitura da intenção — as parcelas são lidas sem IA). Nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, CONFIG, FIN, FINANCEIRO, GRUPO, OPER, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { interpretarContaRelatada, observacoesPorData, valoresCitados } from "../../src/modules/mova-financeiro/dominio/contaRelatada.js";
import { AGORA, TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c7";
const SOCIO = "5500000000211@s.whatsapp.net"; // segundo FINANCEIRO do grupo (papel do João Pedro / Jailton no caso real)
// Grupo do caso real: todos os membros verificados são FINANCEIRO ⇒ valores podem sair no grupo (política GRUPO_FINANCEIRO).
// OPER (operacional) é participante autorizado a falar, mas não é membro verificado do retrato.
const CONFIG_GRUPO = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO",
  participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }, { ids: [OPER], perfil: "OPERACIONAL" }] } : g)) };
const TEXTO = "MOVA, compra de bebedouro para a alfa, 2 parcelas no cartão, Dia 19/12 e 19/01 valor de R$194,50.";
const POR_PARCELA = TEXTO.replace("valor de", "parcelas de");
// conta ÚNICA (sem documento) com categoria do plano dita no texto; e com categoria que NÃO existe no plano
const UNICA = "MOVA, compra de polpa para a alfa, fornecedor Polpa Norte, R$ 300,00, vence 10/12, categoria outras despesas";
const FORA_DO_PLANO = "MOVA, compra de polpa para a alfa, fornecedor Polpa Norte, R$ 300,00, vence 10/12, categoria brinquedos";
const LEGENDA_DA_FOTO = "bebedouro para a alfa, 2 parcelas no cartão, dia 19/12 e 19/01, parcelas de R$ 194,50";
// IA simulada realista: só o relato é conta; "sim", "não", "cada parcela", "1" sozinhos seriam OUTRA (nunca chegam à IA no fluxo certo).
const LEITURA = (req) => (/bebedouro|Polpa Norte|BNB/i.test(JSON.stringify(req.messages ?? "")) ? base({ intencao: "REGISTRAR_CONTA", valorCentavos: 19450, vencimento: "2026-12-19", categoriaSugerida: "INSUMOS" }) : base({}));

async function relatada({ politica = null, concessao = null, criarContas = false } = {}) {
  const s = await cenario({
    responder: LEITURA, config: CONFIG_GRUPO,
    extras: ({ nucleo }) => ({
      autonomia: true, criarContas,
      ...(concessao ? { operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }]) }) } : {}),
    }),
  });
  // 27/11: conta ÚNICA ⇒ CONTA_A_PAGAR_RELATADA; 2+ parcelas ⇒ CONTA_PARCELADA_RELATADA (cada uma com a SUA política)
  if (politica) await s.mova.armazenamento.politicas.criar({ operacao: "CONTA_PARCELADA_RELATADA", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 100000,
    responsavel: "Administrador Sintético", motivo: "Contas relatadas por texto confirmadas no WhatsApp", vigenteDe: "2026-10-01", ...politica }, { criadaPor: HUMANO });
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() });
  const cx = s.c(ORG, ALFA);
  const propostas = () => s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA });
  const contas = async () => (await s.m.nucleo.consultarRegistros(cx, { tipo: "OBRIGACAO" }));
  const textos = async () => (await s.saida()).map((r) => r.texto);
  const ultimoTexto = async () => (await textos()).at(-1) ?? "";
  // decisão da operação (a resposta que a retomou fica registrada depois como RELACIONADA, só após o sucesso)
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  const relatadas = async () => (await propostas()).filter((p) => p.tipo === "CONTA_RELATADA");
  /** Bebedouro (equipamento): o MOVA PERGUNTA a categoria; a pessoa escolhe `escolha` ("1" = a 1ª opção listada). */
  const ateOResumo = async (evento, escolha = "1") => {
    await s.enviar(evento);
    if ((await decisao()).motivo === "CONTA_RELATADA_PERGUNTA_CATEGORIA") await s.enviar(gw({ texto: escolha }));
  };
  /** Categoria de cada conta (fica no LANÇAMENTO da conta). */
  const categoriasDas = async (cs) => { const ls = await s.m.nucleo.consultarRegistros(cx, { tipo: "LANCAMENTO" }); return cs.map((o) => ls.find((l) => l.id === o.lancamentoId)?.categoria ?? null); };
  return { ...s, cx, propostas: relatadas, contas, textos, ultimoTexto, decisao, ateOResumo, categoriasDas };
}

t("CR-0 leitura pura: ano vira (19/12 → 2026, 19/01 → 2027), competência = mês da compra, fornecedor nunca inventado, 'total' ⇒ rateio sem centavo perdido", () => {
  const c = interpretarContaRelatada({ texto: TEXTO, dataMensagem: "2026-11-26", unidades: [{ apelidos: ["alfa"] }], tipoValor: "PARCELA" });
  assert.deepEqual(c.parcelas.map((p) => [p.vencimento, p.valorCentavos]), [["2026-12-19", 19450], ["2027-01-19", 19450]]);
  assert.deepEqual([c.totalCentavos, c.competencia, c.fornecedor, c.descricao, c.forma], [38900, "2026-11", null, "Bebedouro", "CARTAO"]);
  const tot = interpretarContaRelatada({ texto: "Freezer R$ 1.000,01 em 3 parcelas 10/12, 10/01 e 10/02 total", dataMensagem: "2026-11-26" });
  assert.deepEqual([tot.parcelas.map((p) => p.valorCentavos), tot.totalCentavos], [[33333, 33333, 33335], 100001]);
  assert.ok(interpretarContaRelatada({ texto: "Bebedouro 2 parcelas 19/12 R$ 50,00 cada", dataMensagem: "2026-11-26" }).faltas.includes("VENCIMENTOS_DAS_PARCELAS"), "não inventa o 2º vencimento");
  const u = interpretarContaRelatada({ texto: UNICA, dataMensagem: "2026-11-26", unidades: [{ apelidos: ["alfa"] }] });
  assert.deepEqual([u.ehConta, u.parcelas.map((p) => [p.vencimento, p.valorCentavos]), u.ambiguo, u.fornecedor], [true, [["2026-12-10", 30000]], false, "Polpa Norte"], "conta ÚNICA: 1 parcela, sem pergunta de total × parcela");
  // aviso de conta que CHEGOU não é compra: fica no fluxo comum (a competência nunca é presumida pelo mês da mensagem)
  for (const texto of ["MOVA, chegou o boleto de internet da alfa, R$ 289,90, vence 25/10/2026", "MOVA, boleto da contabilidade de setembro da alfa, R$ 600,00, vencimento 05/11/2026"]) {
    assert.equal(interpretarContaRelatada({ texto, dataMensagem: "2026-10-15", unidades: [{ apelidos: ["alfa"] }] }).ehConta, false, texto);
  }
  assert.equal(interpretarContaRelatada({ texto: "bebedouro, R$ 194,50, vence 19/12", dataMensagem: "2026-11-26", porFoto: true }).ehConta, true, "foto do produto: a legenda é o relato da compra");
});

t("CR-1 caso do bebedouro: pergunta o valor (total × cada parcela) e a CATEGORIA (nunca IMOBILIZADO sozinho), mostra o resumo e só depois do 'sim' cria a proposta — nunca como paga", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: TEXTO }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_VALOR_AMBIGUO");
  assert.match(await s.ultimoTexto(), /CADA parcela .* ou é o TOTAL/);
  await s.enviar(gw({ texto: "cada parcela" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_CATEGORIA", "equipamento: a classificação (despesa × imobilizado) é de vocês");
  const pergunta = await s.ultimoTexto();
  for (const re of [/"Bebedouro" parece compra de equipamento/, /Em qual categoria registro\?/, /\n1 — Compra de equipamentos e bens\n/, /\n0 — deixar para classificar no Centro Financeiro/, /Nada foi registrado ainda/]) assert.match(pergunta, re);
  await s.enviar(gw({ texto: "talvez" }));
  assert.equal((await s.decisao()).motivo, "CONVERSA_SEM_PEDIDO_FINANCEIRO_SILENCIOSA", "conversa do grupo fora das opções: o MOVA não responde nem consome a pergunta");
  await s.enviar(gw({ texto: "1" }));
  const resumo = await s.ultimoTexto();
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", "o valor já respondido não é perguntado de novo");
  for (const re of [/Bebedouro — fornecedor não informado/, /Categoria: Compra de equipamentos e bens/, /1\/2: vence 19\/12\/2026 — R\$\s?194,50/, /2\/2: vence 19\/01\/2027 — R\$\s?194,50/, /Total: R\$\s?389,00 — situação: A PAGAR/, /cartão/]) assert.match(resumo, re);
  assert.equal((await s.propostas()).length, 0, "nada antes da confirmação");
  await s.enviar(gw({ texto: "sim" }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.valorCentavos, p.comando.operacao, p.comando.entrada.parcelas.length, p.comando.entrada.categoria, p.comando.entrada.contraparteNova.nome, p.esclarecidoPor],
    ["CONTA_RELATADA", 38900, "registrarContaParcelada", 2, "IMOBILIZADO", "Fornecedor não informado", FIN], "IMOBILIZADO só porque a pessoa ESCOLHEU");
  assert.equal((await s.contas()).length, 0, "sem política: só proposta, nada no Financeiro");
  assert.equal(s.cliente.pedidos.length, 2, "leitura do relato + a do 'talvez' (conversa comum); 'cada parcela', '1' e 'sim' não chamam a IA");
  // Central: quem aprova registra as DUAS parcelas, em aberto
  const aplicada = await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id });
  assert.equal(aplicada.estado, "APLICADA");
  const cs = (await s.contas()).sort((a, b) => a.parcela.numero - b.parcela.numero);
  assert.deepEqual(cs.map((x) => [x.vencimento, x.saldoCentavos, x.competencia]), [["2026-12-19", 19450, "2026-10"], ["2027-01-19", 19450, "2026-10"]], "competência = mês da mensagem (15/10), nunca do vencimento");
  assert.ok(cs.every((x) => x.saldoCentavos === 19450 && x.situacao !== "QUITADA"), "nunca registrada como paga");
  // repetir a aplicação não duplica
  await assert.rejects(s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id }), /PROPOSTA_JA_DECIDIDA/);
  assert.equal((await s.contas()).length, 2);
});

t("CR-2 'não' cancela (nada é criado); resposta que não é sim/não repete o resumo sem consumir", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: POR_PARCELA }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_CATEGORIA", "'parcelas de' já diz que é por parcela: sem a pergunta do valor");
  await s.enviar(gw({ texto: "1" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  await s.enviar(gw({ texto: "talvez" }));
  assert.equal((await s.decisao()).motivo, "CONVERSA_SEM_PEDIDO_FINANCEIRO_SILENCIOSA", "não é sim/não: a pendência continua");
  await s.enviar(gw({ texto: "não" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_CANCELADA");
  assert.equal((await s.propostas()).length, 0);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.propostas()).length, 0, "o 'sim' depois do cancelamento não ressuscita a pendência");
});

t("CR-3 colaboração: outro FINANCEIRO da unidade confirma sem citar (auditoria individual); perfil OPERACIONAL não confirma e a pendência continua", async () => {
  const s = await relatada();
  await s.ateOResumo(gw({ texto: POR_PARCELA }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  await s.enviar(gw({ texto: "sim", de: OPER }));
  assert.equal((await s.propostas()).length, 0, "OPERACIONAL não confirma efeito financeiro");
  assert.equal((await s.decisao()).motivo, "CONFIRMACAO_SEM_PERMISSAO_FINANCEIRA", "recusa explícita, sem consumir a pendência");
  await s.enviar(gw({ texto: "sim", de: SOCIO }));
  const [p] = await s.propostas();
  assert.equal(p.esclarecidoPor, SOCIO, "quem confirmou fica na proposta");
  assert.equal(p.participanteId, FIN, "quem relatou também");
});

t("CR-4 reinício entre as perguntas e o 'sim': a pendência está no banco — a conversa continua (sem perguntar de novo, sem IA)", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: POR_PARCELA }));
  s.reiniciar();
  await s.enviar(gw({ texto: "1" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  s.reiniciar();
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.propostas()).length, 1);
  assert.equal(s.cliente.pedidos.length, 1);
});

t("CR-5 cartão: fatura já registrada no mesmo mês ⇒ o resumo AVISA (pode já estar na fatura); mesma parcela já registrada ⇒ DUPLICADO", async () => {
  const s = await relatada();
  const f = await s.m.nucleo.registrarContraparte(s.cx, { tipo: "FORNECEDOR", nome: "Cartão Sintético" });
  await s.m.nucleo.registrarObrigacao(s.cx, { contraparteId: f.id, valorOriginalCentavos: 250000, categoria: "INSUMOS", descricao: "Fatura do cartão", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-12-10" });
  await s.ateOResumo(gw({ texto: POR_PARCELA }));
  assert.match(await s.ultimoTexto(), /Já existe fatura do cartão em aberto com vencimento 10\/12\/2026/);
  const s2 = await relatada();
  await s2.m.nucleo.registrarObrigacao(s2.cx, { contraparteId: s2.forn.id, valorOriginalCentavos: 19450, categoria: "INSUMOS", descricao: "Bebedouro", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-12-19" });
  await s2.enviar(gw({ texto: POR_PARCELA }));
  assert.equal((await s2.decisao()).decisao, "DUPLICADO");
});

t("CR-6 parcelada: com a política CONTA_PARCELADA_RELATADA e a concessão estreita o 'sim' REGISTRA as parcelas em aberto; a política de conta ÚNICA (ou por documento) NÃO serve", async () => {
  const CONC = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];
  for (const operacao of ["CONTA_A_PAGAR", "CONTA_A_PAGAR_RELATADA"]) {
    const sem = await relatada({ politica: { operacao }, concessao: CONC, criarContas: true });
    await sem.ateOResumo(gw({ texto: POR_PARCELA }));
    await sem.enviar(gw({ texto: "sim" }));
    assert.equal((await sem.contas()).length, 0, `a política ${operacao} não autoriza conta PARCELADA`);
    assert.equal((await sem.propostas()).length, 1, "fica a proposta para a Central");
  }
  const s = await relatada({ politica: {}, concessao: CONC, criarContas: true });
  await s.ateOResumo(gw({ texto: POR_PARCELA }));
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO");
  assert.match(await s.ultimoTexto(), /Conta a pagar registrada \(em aberto\): Bebedouro, 2 parcelas, total R\$\s?389,00/);
  const cs = await s.contas();
  assert.deepEqual([cs.length, cs.every((x) => x.saldoCentavos === 19450), cs.every((x) => (x.documentoIds ?? []).length === 0), await s.categoriasDas(cs)], [2, true, true, ["IMOBILIZADO", "IMOBILIZADO"]], "IMOBILIZADO porque a pessoa escolheu a opção 1");
  assert.ok(cs.every((x) => x.situacao !== "QUITADA"), "nunca registrada como paga");
  const sc = await relatada({ politica: {}, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"], criarContas: true });
  await sc.ateOResumo(gw({ texto: POR_PARCELA }));
  await sc.enviar(gw({ texto: "sim" }));
  assert.equal((await sc.contas()).length, 0, "sem a concessão própria: fica a proposta");
  assert.match(await sc.ultimoTexto(), /permissão operacional do MOVA nesta unidade não cobre/);
  // acima do limite da política: fica a proposta
  const acima = await relatada({ politica: { limiteCentavos: 30000 }, concessao: CONC, criarContas: true });
  await acima.ateOResumo(gw({ texto: POR_PARCELA }));
  await acima.enviar(gw({ texto: "sim" }));
  assert.equal((await acima.contas()).length, 0, "total R$ 389,00 acima do limite de R$ 300,00: nada lançado");
});

t("CR-7 conta ÚNICA relatada: categoria do plano dita no texto ⇒ sem pergunta; com CONTA_A_PAGAR_RELATADA registra 1 conta em aberto; a política PARCELADA não serve", async () => {
  const CONC = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];
  const sem = await relatada({ politica: {}, concessao: CONC, criarContas: true }); // só CONTA_PARCELADA_RELATADA
  await sem.enviar(gw({ texto: UNICA }));
  assert.equal((await sem.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", "valor único + categoria do plano: direto ao resumo");
  assert.match(await sem.ultimoTexto(), /Categoria: Outras despesas/);
  await sem.enviar(gw({ texto: "sim" }));
  assert.equal((await sem.contas()).length, 0, "a política de conta PARCELADA não autoriza conta única");
  const s = await relatada({ politica: { operacao: "CONTA_A_PAGAR_RELATADA" }, concessao: CONC, criarContas: true });
  await s.enviar(gw({ texto: UNICA }));
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO");
  const cs = await s.contas();
  assert.deepEqual(cs.map((x) => [x.vencimento, x.saldoCentavos, x.parcela?.total, x.situacao !== "QUITADA"]), [["2026-12-10", 30000, 1, true]]);
  assert.deepEqual(await s.categoriasDas(cs), ["OUTRAS_DESPESAS"], "a categoria DITA, do plano");
});

t("CR-8 categoria dita FORA do plano: nada é inventado — pergunta com as opções e, com '0', fica A CLASSIFICAR (com a sugestão de criar) e nunca executa sozinha", async () => {
  const s = await relatada({ politica: { operacao: "CONTA_A_PAGAR_RELATADA" }, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"], criarContas: true });
  await s.enviar(gw({ texto: FORA_DO_PLANO }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_CATEGORIA");
  const pergunta = await s.ultimoTexto();
  assert.match(pergunta, /A categoria "brinquedos" não existe no plano de contas desta unidade/);
  assert.match(pergunta, /0 — deixar para classificar no Centro Financeiro \(com a sugestão de criar "brinquedos"\)/);
  await s.enviar(gw({ texto: "0" }));
  assert.match(await s.ultimoTexto(), /Categoria: a classificar no Centro Financeiro \(sugestão: criar "brinquedos"\)/);
  await s.enviar(gw({ texto: "sim" }));
  const [p] = await s.propostas();
  assert.deepEqual([p.categoriaDefinida, p.classificacao?.pendente, p.classificacao?.sugestaoDeCriacao], [false, true, "brinquedos"]);
  assert.equal((await s.contas()).length, 0, "a classificar: mesmo com política e concessão, nada é lançado sem categoria");
});

t("CR-9 FOTO do produto com legenda: a legenda é o relato; a foto fica como evidência NÃO fiscal; segue o mesmo fluxo (categoria → resumo → 'sim')", async () => {
  const s = await relatada();
  await s.ateOResumo(gw({ texto: LEGENDA_DA_FOTO, imagem: "jpeg-sintetico-do-bebedouro" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  assert.match(await s.ultimoTexto(), /Total: R\$\s?389,00 — situação: A PAGAR/);
  await s.enviar(gw({ texto: "sim" }));
  const [p] = await s.propostas();
  assert.deepEqual([p.evidenciaNaoFiscal, p.comando.entrada.parcelas.length, p.valorCentavos], ["FOTO_DO_PRODUTO", 2, 38900]);
  assert.equal((await s.contas()).length, 0, "foto não é comprovante: nunca vira pagamento");
});

// ------------------------------------------------------------------ 27/11: valor SEM "R$" e observações individuais por parcela (empréstimo BNB)
const BNB = "MOVA, empréstimo BNB para a alfa, total 2.911,08, 3 parcelas: 10/12 (carência), 10/01 (reajuste IPCA), 10/02";

t("CR-10 empréstimo BNB: 'total 2.911,08' (sem R$) é dinheiro; 18.000/400 sem vírgula decimal não; as observações vêm junto de cada data; nada é inventado", () => {
  const r = interpretarContaRelatada({ texto: BNB, dataMensagem: "2026-11-27", unidades: [{ apelidos: ["alfa"] }] });
  assert.deepEqual([r.ehConta, r.faltas, r.descricao, r.totalCentavos, r.tipoValor], [true, [], "Empréstimo BNB", 291108, "TOTAL"]);
  assert.deepEqual(r.parcelas.map((p) => [p.vencimento, p.valorCentavos, p.observacao]), [["2026-12-10", 97036, "carência"], ["2027-01-10", 97036, "reajuste IPCA"], ["2027-02-10", 97036, null]]);
  assert.equal(r.parcelas.reduce((s, p) => s + p.valorCentavos, 0), 291108, "sem centavo perdido");
  assert.deepEqual(valoresCitados("ar condicionado 18.000 pago 260,00"), [26000]);
  assert.deepEqual(valoresCitados("freezer 400 litros, reajuste de 10,50%, vence 10/12"), []);
  assert.deepEqual(valoresCitados("Pagamento de R$ 500 referente ao aluguel"), [50000]);
  assert.deepEqual(observacoesPorData("vence 10/12: carência, 10/01"), ["carência", null]);
});

t("CR-11 empréstimo BNB ponta a ponta: resumo com as observações individuais, 'sim' registra 3 parcelas EM ABERTO (nunca paga) uma só vez; repetir o 'sim' não duplica", async () => {
  const CONC = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];
  const s = await relatada({ politica: { limiteCentavos: 500000 }, concessao: CONC, criarContas: true });
  await s.ateOResumo(gw({ texto: BNB }));
  const resumo = await s.ultimoTexto();
  assert.match(resumo, /1\/3: vence 10\/12\/2026 — R\$\s?970,36 \(carência\)/);
  assert.match(resumo, /2\/3: vence 10\/01\/2027 — R\$\s?970,36 \(reajuste IPCA\)/);
  assert.match(resumo, /Total: R\$\s?2\.911,08/);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO", JSON.stringify(await s.decisao()));
  const cs = await s.contas();
  assert.deepEqual([cs.length, cs.reduce((x, c) => x + c.saldoCentavos, 0), cs.every((c) => c.situacao !== "QUITADA")], [3, 291108, true]);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.contas()).length, 3, "repetir o 'sim' não duplica");
});
