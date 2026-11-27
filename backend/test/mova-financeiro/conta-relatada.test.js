// 26/11 — CONTA A PAGAR RELATADA POR TEXTO (sem documento). Caso real (dados SINTÉTICOS): "Compra de bebedouro para o açaí, 2 parcelas
// no cartão, Dia 19/12 e 19/01 valor de R$194,50." Financeiro v2 REAL em memória, banco do MOVA no PostgreSQL local isolado (com a
// migração 0025), IA SIMULADA (só a leitura da intenção — as parcelas são lidas sem IA). Nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, CONFIG, FIN, FINANCEIRO, GRUPO, OPER, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { interpretarContaRelatada } from "../../src/modules/mova-financeiro/dominio/contaRelatada.js";
import { AGORA, TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c7";
const SOCIO = "5500000000211@s.whatsapp.net"; // segundo FINANCEIRO do grupo (papel do João Pedro / Jailton no caso real)
// Grupo do caso real: todos os membros verificados são FINANCEIRO ⇒ valores podem sair no grupo (política GRUPO_FINANCEIRO).
// OPER (operacional) é participante autorizado a falar, mas não é membro verificado do retrato.
const CONFIG_GRUPO = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO",
  participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }, { ids: [OPER], perfil: "OPERACIONAL" }] } : g)) };
const TEXTO = "MOVA, compra de bebedouro para a alfa, 2 parcelas no cartão, Dia 19/12 e 19/01 valor de R$194,50.";
// IA simulada realista: só o relato é conta; "sim", "não", "cada parcela" sozinhos seriam OUTRA (nunca chegam à IA no fluxo certo).
const LEITURA = (req) => (/bebedouro/i.test(JSON.stringify(req.messages ?? "")) ? base({ intencao: "REGISTRAR_CONTA", valorCentavos: 19450, vencimento: "2026-12-19", categoriaSugerida: "INSUMOS" }) : base({}));

async function relatada({ politica = null, concessao = null, criarContas = false } = {}) {
  const s = await cenario({
    responder: LEITURA, config: CONFIG_GRUPO,
    extras: ({ nucleo }) => ({
      autonomia: true, criarContas,
      ...(concessao ? { operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }]) }) } : {}),
    }),
  });
  if (politica) await s.mova.armazenamento.politicas.criar({ operacao: "CONTA_A_PAGAR_RELATADA", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 100000,
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
  return { ...s, cx, propostas: relatadas, contas, textos, ultimoTexto, decisao };
}

t("CR-0 leitura pura: ano vira (19/12 → 2026, 19/01 → 2027), competência = mês da compra, fornecedor nunca inventado, 'total' ⇒ rateio sem centavo perdido", () => {
  const c = interpretarContaRelatada({ texto: TEXTO, dataMensagem: "2026-11-26", unidades: [{ apelidos: ["alfa"] }], tipoValor: "PARCELA" });
  assert.deepEqual(c.parcelas.map((p) => [p.vencimento, p.valorCentavos]), [["2026-12-19", 19450], ["2027-01-19", 19450]]);
  assert.deepEqual([c.totalCentavos, c.competencia, c.fornecedor, c.descricao, c.forma], [38900, "2026-11", null, "Bebedouro", "CARTAO"]);
  const tot = interpretarContaRelatada({ texto: "Freezer R$ 1.000,01 em 3 parcelas 10/12, 10/01 e 10/02 total", dataMensagem: "2026-11-26" });
  assert.deepEqual([tot.parcelas.map((p) => p.valorCentavos), tot.totalCentavos], [[33333, 33333, 33335], 100001]);
  assert.ok(interpretarContaRelatada({ texto: "Bebedouro 2 parcelas 19/12 R$ 50,00 cada", dataMensagem: "2026-11-26" }).faltas.includes("VENCIMENTOS_DAS_PARCELAS"), "não inventa o 2º vencimento");
});

t("CR-1 caso do bebedouro: pergunta UMA vez (total × cada parcela), mostra o resumo e só depois do 'sim' cria a proposta — nunca como paga, nada lançado sem política", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: TEXTO }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_VALOR_AMBIGUO");
  assert.match(await s.ultimoTexto(), /CADA parcela .* ou é o TOTAL/);
  await s.enviar(gw({ texto: "cada parcela" }));
  const resumo = await s.ultimoTexto();
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  for (const re of [/Bebedouro — fornecedor não informado/, /Compra de equipamentos e bens/, /1\/2: vence 19\/12\/2026 — R\$\s?194,50/, /2\/2: vence 19\/01\/2027 — R\$\s?194,50/, /Total: R\$\s?389,00 — situação: A PAGAR/, /cartão/]) assert.match(resumo, re);
  assert.equal((await s.propostas()).length, 0, "nada antes da confirmação");
  await s.enviar(gw({ texto: "sim" }));
  const [p] = await s.propostas();
  assert.deepEqual([p.tipo, p.valorCentavos, p.comando.operacao, p.comando.entrada.parcelas.length, p.comando.entrada.categoria, p.comando.entrada.contraparteNova.nome, p.esclarecidoPor],
    ["CONTA_RELATADA", 38900, "registrarContaParcelada", 2, "IMOBILIZADO", "Fornecedor não informado", FIN]);
  assert.equal((await s.contas()).length, 0, "sem política: só proposta, nada no Financeiro");
  assert.equal(s.cliente.pedidos.length, 1, "uma única leitura de IA (as respostas 'cada parcela' e 'sim' não chamam a IA)");
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
  await s.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", "'parcelas de' já diz que é por parcela: sem pergunta");
  await s.enviar(gw({ texto: "não" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_CANCELADA");
  assert.equal((await s.propostas()).length, 0);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.propostas()).length, 0, "o 'sim' depois do cancelamento não ressuscita a pendência");
});

t("CR-3 colaboração: outro FINANCEIRO da unidade confirma sem citar (auditoria individual); perfil OPERACIONAL não confirma e a pendência continua", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  await s.enviar(gw({ texto: "sim", de: OPER }));
  assert.equal((await s.propostas()).length, 0, "OPERACIONAL não confirma efeito financeiro");
  assert.equal((await s.decisao()).motivo, "CONFIRMACAO_SEM_PERMISSAO_FINANCEIRA", "recusa explícita, sem consumir a pendência");
  await s.enviar(gw({ texto: "sim", de: SOCIO }));
  const [p] = await s.propostas();
  assert.equal(p.esclarecidoPor, SOCIO, "quem confirmou fica na proposta");
  assert.equal(p.participanteId, FIN, "quem relatou também");
});

t("CR-4 reinício entre o resumo e o 'sim': a pendência está no banco — a confirmação continua (sem perguntar de novo, sem IA)", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  s.reiniciar();
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.propostas()).length, 1);
  assert.equal(s.cliente.pedidos.length, 1);
});

t("CR-5 cartão: fatura já registrada no mesmo mês ⇒ o resumo AVISA (pode já estar na fatura); mesma parcela já registrada ⇒ DUPLICADO", async () => {
  const s = await relatada();
  const f = await s.m.nucleo.registrarContraparte(s.cx, { tipo: "FORNECEDOR", nome: "Cartão Sintético" });
  await s.m.nucleo.registrarObrigacao(s.cx, { contraparteId: f.id, valorOriginalCentavos: 250000, categoria: "INSUMOS", descricao: "Fatura do cartão", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-12-10" });
  await s.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  assert.match(await s.ultimoTexto(), /Já existe fatura do cartão em aberto com vencimento 10\/12\/2026/);
  const s2 = await relatada();
  await s2.m.nucleo.registrarObrigacao(s2.cx, { contraparteId: s2.forn.id, valorOriginalCentavos: 19450, categoria: "INSUMOS", descricao: "Bebedouro", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-12-19" });
  await s2.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  assert.equal((await s2.decisao()).decisao, "DUPLICADO");
});

t("CR-6 com a política CONTA_A_PAGAR_RELATADA e a concessão estreita: o 'sim' REGISTRA as parcelas em aberto (sem documento); a política de conta por documento NÃO serve", async () => {
  const sem = await relatada({ politica: { operacao: "CONTA_A_PAGAR" }, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"], criarContas: true });
  await sem.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  await sem.enviar(gw({ texto: "sim" }));
  assert.equal((await sem.contas()).length, 0, "a política de outra modalidade não autoriza esta");
  const s = await relatada({ politica: {}, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"], criarContas: true });
  await s.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO");
  assert.match(await s.ultimoTexto(), /Conta a pagar registrada \(em aberto\): Bebedouro, 2 parcelas, total R\$\s?389,00/);
  const cs = await s.contas();
  assert.deepEqual([cs.length, cs.every((x) => x.saldoCentavos === 19450), cs.every((x) => (x.documentoIds ?? []).length === 0)], [2, true, true]);
  const sc = await relatada({ politica: {}, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"], criarContas: true });
  await sc.enviar(gw({ texto: TEXTO.replace("valor de", "parcelas de") }));
  await sc.enviar(gw({ texto: "sim" }));
  assert.equal((await sc.contas()).length, 0, "sem a concessão própria: fica a proposta");
  assert.match(await sc.ultimoTexto(), /permissão operacional do MOVA nesta unidade não cobre/);
});
