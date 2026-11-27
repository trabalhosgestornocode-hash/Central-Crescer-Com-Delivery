// 27/11 — REGRESSÃO da homologação real do BEBEDOURO (Açaí): três tentativas, as três com os dois vencimentos, e o MOVA repetindo
// "falta o vencimento de cada parcela". Causa: "1ª parcela" virava "1 parcela" na normalização (o "ª" some) ⇒ quantidade 1 contra
// 2 vencimentos ⇒ a falta nunca fechava (as respostas eram guardadas certo, mas a quantidade vinha sempre da mensagem original).
// Conversa INTEIRA (recebimento → perguntas → respostas citando a mensagem do MOVA → resumo → "sim" → registro no Financeiro v2 real em
// memória), banco do MOVA no PostgreSQL local isolado, IA simulada só para a intenção. Textos REAIS (só a unidade é a sintética "Loja Alfa").
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, BETA, CONFIG, FIN, FINANCEIRO, GRUPO, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c7";
const SOCIO = "5500000000211@s.whatsapp.net";
const CFG = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO",
  participantes: [...g.participantes, { ids: [SOCIO], perfil: "FINANCEIRO" }] } : g)) };
const QUANDO = "2026-11-27T22:52:26.000Z"; // horário real da 1ª mensagem (competência = mês da compra)

const MSG1 = "MOVA, registrar a compra de um bebedouro para a Loja Alfa.\n\nCategoria: Compra de equipamentos e bens (IMOBILIZADO).\n\nCompetência: novembro/2026.\nForma de pagamento: cartão de crédito.\n\n1ª parcela: R$ 194,50 — 19/12/2026.\n2ª parcela: R$ 194,50 — 19/01/2027.\n\nTotal: R$ 389,00.\n\nRegistrar as duas parcelas em aberto, sem baixa de pagamento.";
const MSG2 = "A 1º parcela vence 19/12/2026 (19 de dezembro de 2026)\nA 2º parcela vence 19/01/2027 (19 de janeiro de 2027)";
const MSG3 = "Vencimentos: 19/12/2026 e 19/01/2027.";
const LEITURA = (req) => (/bebedouro/i.test(JSON.stringify(req.messages ?? "")) ? base({ intencao: "REGISTRAR_CONTA", valorCentavos: 38900, vencimento: "2026-12-19", competencia: "2026-11", categoriaSugerida: "COMPRA_EQUIPAMENTOS" }) : base({}));

async function conversa() {
  const s = await cenario({ responder: LEITURA, config: CFG, extras: ({ nucleo }) => ({ autonomia: true, criarContas: true,
    operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
      concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"] }]) }) }) });
  // política igual à do Açaí em produção: conta parcelada relatada com confirmação até R$ 10.000
  await s.mova.armazenamento.politicas.criar({ operacao: "CONTA_PARCELADA_RELATADA", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 1000000,
    responsavel: "Administrador Sintético", motivo: "Contas relatadas confirmadas no WhatsApp", vigenteDe: "2026-10-01" }, { criadaPor: HUMANO });
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() });
  /** Envia citando a ÚLTIMA mensagem do MOVA (como no WhatsApp real): a mensagem do MOVA recebe o id do provedor, como o Gateway faz. */
  const responderCitando = async (texto) => {
    const r = (await s.banco.pool.query("update mova.resposta set provider_message_id = 'PM' || seq, estado = 'ENVIADA' where provider_message_id is null returning seq")).rows;
    const ultima = (await s.banco.pool.query("select provider_message_id from mova.resposta order by seq desc limit 1")).rows[0].provider_message_id;
    void r;
    return s.enviar({ ...gw({ texto, respostaA: ultima }), recebidoEm: new Date(Date.parse(QUANDO) + 60_000).toISOString() });
  };
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  const ultimoTexto = async () => (await s.saida()).at(-1)?.texto ?? "";
  const contas = async (u = ALFA) => s.m.nucleo.consultarRegistros(s.c(ORG, u), { tipo: "OBRIGACAO" });
  const lancamentos = async () => s.m.nucleo.consultarRegistros(s.c(ORG, ALFA), { tipo: "LANCAMENTO" });
  return { ...s, responderCitando, decisao, ultimoTexto, contas, lancamentos };
}

async function conferirRegistro(s) {
  const cs = (await s.contas()).sort((a, b) => a.parcela.numero - b.parcela.numero);
  assert.deepEqual(cs.map((x) => [x.parcela.numero, x.parcela.total, x.vencimento, x.saldoCentavos, x.situacao, x.competencia, x.formaPagamento]),
    [[1, 2, "2026-12-19", 19450, "ABERTA", "2026-11", "CARTAO"], [2, 2, "2027-01-19", 19450, "ABERTA", "2026-11", "CARTAO"]], "2 parcelas de R$ 194,50, em aberto, 11/2026, cartão");
  const ls = await s.lancamentos();
  assert.deepEqual(ls.map((l) => [l.categoria, l.valorCentavos]), [["IMOBILIZADO", 38900]], "UMA compra: um lançamento de R$ 389,00 em IMOBILIZADO");
  assert.equal(new Set(cs.map((c) => c.grupoId)).size, 1, "as duas parcelas são da mesma compra");
  assert.equal((await s.contas(BETA)).length, 0, "nada na outra loja");
}

t("BEB-1 a MENSAGEM ORIGINAL já basta: 2 parcelas, 19/12 e 19/01, IMOBILIZADO dita ⇒ resumo direto; as respostas reais seguintes não quebram nada; 'sim' registra UMA compra", async () => {
  const s = await conversa();
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", "nada falta: não pergunta vencimento");
  const resumo = await s.ultimoTexto();
  for (const re of [/Bebedouro — fornecedor não informado/, /Categoria: Compra de equipamentos e bens/, /Competência: 11\/2026 • Forma: cartão/,
    /1\/2: vence 19\/12\/2026 — R\$\s?194,50/, /2\/2: vence 19\/01\/2027 — R\$\s?194,50/, /Total: R\$\s?389,00 — situação: A PAGAR/]) assert.match(resumo, re);
  assert.doesNotMatch(resumo, /falta/);
  // as duas respostas reais (vencimentos de novo) chegam citando o MOVA: não viram confirmação nem outra compra
  await s.responderCitando(MSG2);
  await s.responderCitando(MSG3);
  assert.equal((await s.contas()).length, 0, "nada registrado sem o 'sim'");
  await s.responderCitando("sim");
  assert.equal((await s.decisao()).decisao, "EXECUTADO", JSON.stringify(await s.decisao()));
  await conferirRegistro(s);
  await s.responderCitando("sim");
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  assert.equal((await s.contas()).length, 2, "repetir o 'sim' ou reenviar a mensagem não duplica");
});

t("BEB-2 RETOMADA da conversa de produção: pendência do jeito que ficou (vencimentos já respondidos) ⇒ 'continuar' citando o MOVA leva ao resumo; 'sim' registra; sem informar tudo de novo", async () => {
  const s = await conversa();
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  // o estado EXATO deixado pelo código anterior em produção (mova.mensagem_pendente de bly:3A9E68DAAB3FC28124B0)
  const r = await s.banco.pool.query(`update mova.mensagem_pendente set resolvida_em = null, criada_em = now(), leitura = jsonb_set(leitura, '{divergencia}', $1::jsonb)
     where evento_id like 'bly:EA2%' and leitura->'evento'->>'texto' like '%bebedouro%' returning mensagem_id`,
    [JSON.stringify({ tipo: "CONTA_RELATADA_COMPLEMENTO", faltas: ["VENCIMENTOS_DAS_PARCELAS"], tipoValor: null, unidadeId: ALFA, complemento: { vencimentos: ["2026-12-19", "2027-01-19"] }, categoriaEscolhida: null })]);
  assert.equal(r.rowCount, 1);
  await s.responderCitando("continuar");
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", JSON.stringify(await s.decisao()));
  assert.match(await s.ultimoTexto(), /1\/2: vence 19\/12\/2026[\s\S]*2\/2: vence 19\/01\/2027[\s\S]*Total: R\$\s?389,00/);
  await s.responderCitando("sim");
  await conferirRegistro(s);
});

t("BEB-3 as três mensagens reais no ESTADO ANTIGO (falta de vencimentos): cada resposta com as datas completa a conta — nunca pede o mesmo de novo", async () => {
  const s = await conversa();
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  await s.banco.pool.query(`update mova.mensagem_pendente set resolvida_em = null, criada_em = now(), leitura = jsonb_set(leitura, '{divergencia}', $1::jsonb)
     where leitura->'evento'->>'texto' like '%bebedouro%'`, [JSON.stringify({ tipo: "CONTA_RELATADA_COMPLEMENTO", faltas: ["VENCIMENTOS_DAS_PARCELAS"], tipoValor: null, unidadeId: ALFA, complemento: {}, categoriaEscolhida: null })]);
  await s.responderCitando(MSG2);
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", "a 1ª resposta real (1º/2º parcela vence…) completa");
  assert.doesNotMatch(await s.ultimoTexto(), /falta/);
  await s.responderCitando("sim");
  await conferirRegistro(s);
});
