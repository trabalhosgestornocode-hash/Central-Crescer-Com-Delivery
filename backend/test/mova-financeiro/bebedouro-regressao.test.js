// 27/11 — REGRESSÃO da homologação real do BEBEDOURO (Açaí): três tentativas, as três com os dois vencimentos, e o MOVA repetindo
// "falta o vencimento de cada parcela". Causa: "1ª parcela" virava "1 parcela" na normalização (o "ª" some) ⇒ quantidade 1 contra
// 2 vencimentos ⇒ a falta nunca fechava (as respostas eram guardadas certo, mas a quantidade vinha sempre da mensagem original).
// Conversa INTEIRA (recebimento → perguntas → respostas citando a mensagem do MOVA → resumo → "sim" → registro no Financeiro v2 real em
// memória), banco do MOVA no PostgreSQL local isolado, IA simulada só para a intenção. Textos REAIS (só a unidade é a sintética "Loja Alfa").
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarConcessoesMemoria, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, BETA, CONFIG, ESCOPOS, FIN, FINANCEIRO, GRUPO, ORG, PULAR, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { AGORA, USUARIO, provisionarAdministrador } from "../financeiro-v2/helpers/cenario.js";
import { motivoParaPular as motivoParaPularFv2, repositorioPostgresDeTeste } from "../financeiro-v2/helpers/postgres.js";
import { IDENTIDADE_DO_MOVA, sqlConcessaoDoMova, sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";

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

// ------------------------------------------------------------------ 27/11 (2ª falha): "Sim" de um LID ⇒ proposta f8f15a27 parada na Central
// Causa: a lista do grupo é por TELEFONE e o WhatsApp manda o LID; a confirmação da conta relatada procurava quem confirmou SÓ pelo
// identificador ⇒ "não FINANCEIRO" ⇒ a execução nem era tentada (nenhuma política, concessão ou categoria chegou a ser avaliada).
const LID_DO_FIN = "88000000000999@lid"; // LID que não está na lista; o Gateway manda junto o telefone do FIN
const TEL_DO_FIN = "+5500000000201";
const CFG_TEL = { ...CFG, gruposAutorizados: CFG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, participantes: g.participantes.map((p) => (p.ids.includes(FIN) ? { ...p, telefones: [TEL_DO_FIN] } : p)) } : g)) };
const CONC_BEB = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];

async function conversaPorTelefone({ comPolitica = true, repositorio = null, nucleoOperacional = null } = {}) {
  // no banco real a LEITURA do MOVA usa a identidade de leitura de produção, com a concessão do kit oficial (sqlConcessaoDoMova)
  const config = repositorio ? { ...CFG_TEL, identidadeServico: { usuarioId: IDENTIDADE_DO_MOVA } } : CFG_TEL;
  const leitura = repositorio ? IDENTIDADE_DO_MOVA : "eeeeeeee-0000-4000-8000-0000000000a2";
  const s = await cenario({ responder: LEITURA, config, repositorio, ...(repositorio ? { humano: USUARIO } : {}), extras: ({ nucleo }) => ({ autonomia: true, criarContas: true,
    operacional: criarPortaOperacional({ nucleo: nucleoOperacional ?? nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: leitura,
      concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: CONC_BEB }]) }) }) });
  const politica = () => s.mova.armazenamento.politicas.criar({ operacao: "CONTA_PARCELADA_RELATADA", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 1000000,
    responsavel: "Administrador Sintético", motivo: "Contas relatadas confirmadas no WhatsApp", vigenteDe: "2026-10-01" }, { criadaPor: HUMANO });
  if (comPolitica) await politica();
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() });
  const citarUltima = async () => {
    await s.banco.pool.query("update mova.resposta set provider_message_id = 'PM' || seq, estado = 'ENVIADA' where provider_message_id is null");
    return (await s.banco.pool.query("select provider_message_id from mova.resposta order by seq desc limit 1")).rows[0].provider_message_id;
  };
  /** Resposta do celular do FIN chegando com o LID (como no WhatsApp real), citando a última mensagem do MOVA. */
  const doLid = async (texto) => s.enviar({ ...gw({ texto, de: LID_DO_FIN, telefone: TEL_DO_FIN, respostaA: await citarUltima() }), recebidoEm: new Date(Date.parse(QUANDO) + 60_000).toISOString() });
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  const contas = async (u = ALFA) => s.m.nucleo.consultarRegistros(s.c(ORG, u), { tipo: "OBRIGACAO" });
  const lancamentos = async () => s.m.nucleo.consultarRegistros(s.c(ORG, ALFA), { tipo: "LANCAMENTO" });
  const relatadas = async () => (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((p) => p.tipo === "CONTA_RELATADA");
  return { ...s, politica, doLid, decisao, contas, lancamentos, relatadas };
}

t("BEB-4 'Sim' vindo de um LID (reconhecido pelo TELEFONE) ⇒ a execução é TENTADA e registra a compra (criar a proposta não é sucesso)", async () => {
  const s = await conversaPorTelefone();
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  await s.doLid("Sim");
  const d = await s.decisao();
  assert.equal(d.decisao, "EXECUTADO", `a confirmação do LID tem de executar: ${JSON.stringify(d)}`);
  await conferirRegistro(s);
  const [p] = await s.relatadas();
  assert.deepEqual([p.estado, p.esclarecidoPor], ["APLICADA", LID_DO_FIN]);
});

t("BEB-5 RECUPERAÇÃO da proposta parada (estado de f8f15a27): citar a resposta do MOVA com 'registrar' executa a MESMA proposta, revalidada; nada perguntado de novo, nada duplicado", async () => {
  const s = await conversaPorTelefone({ comPolitica: false }); // sem política no "Sim" ⇒ proposta parada na Central (mesmo estado de produção)
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  await s.doLid("Sim");
  const [parada] = await s.relatadas();
  assert.deepEqual([parada.estado, (await s.contas()).length], ["AGUARDANDO_REVISAO", 0], "proposta criada, nada lançado");
  await s.politica(); // a política vigente passa a valer; a proposta continua a mesma
  await s.doLid("registrar");
  assert.equal((await s.decisao()).decisao, "EXECUTADO", JSON.stringify(await s.decisao()));
  const todas = await s.relatadas();
  assert.deepEqual([todas.length, todas[0].id, todas[0].estado], [1, parada.id, "APLICADA"], "a MESMA proposta, sem outra");
  await conferirRegistro(s);
  await s.doLid("registrar");
  assert.equal((await s.contas()).length, 2, "retomar de novo não duplica");
  assert.ok((await s.banco.pool.query("select 1 from mova.auditoria where acao = 'PROPOSTA_RETOMADA'")).rowCount >= 1, "retomada auditada");
});

test("BEB-PG conversa real até o REGISTRO PERSISTIDO no PostgreSQL isolado do Financeiro v2: identidade estreita (kit oficial), 'Sim' do LID ⇒ 2 obrigações + 1 lançamento IMOBILIZADO, sem baixa", { skip: PULAR || motivoParaPularFv2(), timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG, unidadeId: ALFA, escopos: ESCOPOS, usuarioId: USUARIO });
  const dono = await (await repositorio.interno()).dono();
  const cl = await dono.connect();
  try {
    await cl.query("begin");
    await cl.query(sqlConcessaoDoMova(ORG, ALFA));
    await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: ORG, unidadeId: ALFA, acoes: CONC_BEB, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional do MOVA — bebedouro (teste)" }));
    await cl.query("commit");
  } finally { cl.release(); }
  const nucleoOperacional = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const s = await conversaPorTelefone({ repositorio, nucleoOperacional });
  await s.enviar({ ...gw({ texto: MSG1 }), recebidoEm: QUANDO });
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", JSON.stringify([await s.decisao(), (await s.saida()).at(-1)?.texto]));
  await s.doLid("Sim");
  assert.equal((await s.decisao()).decisao, "EXECUTADO", JSON.stringify(await s.decisao()));
  const ob = (await dono.query(`select (parcela->>'numero')::int n, (parcela->>'total')::int t, vencimento::text v, valor_base_centavos vb, saldo_centavos sd, situacao, competencia,
      extras->>'formaPagamento' forma, criado_por from fv2_obrigacao where organizacao_id = $1 and unidade_id = $2 order by 1`, [ORG, ALFA])).rows;
  assert.deepEqual(ob.map((o) => [o.n, o.t, o.v, Number(o.vb), Number(o.sd), o.situacao, o.competencia, o.forma]),
    [[1, 2, "2026-12-19", 19450, 19450, "ABERTA", "2026-11", "CARTAO"], [2, 2, "2027-01-19", 19450, 19450, "ABERTA", "2026-11", "CARTAO"]], "persistido no banco");
  assert.ok(ob.every((o) => o.criado_por === OPERADOR), "gravado pela identidade ESTREITA do MOVA");
  const la = (await dono.query("select categoria_codigo, natureza, valor_centavos from fv2_lancamento where organizacao_id = $1 and unidade_id = $2", [ORG, ALFA])).rows;
  assert.deepEqual(la.map((l) => [l.categoria_codigo, l.natureza, Number(l.valor_centavos)]), [["IMOBILIZADO", "PATRIMONIAL", 38900]], "UMA compra em IMOBILIZADO");
  assert.equal(Number((await dono.query("select count(*) n from fv2_liquidacao where organizacao_id = $1 and unidade_id = $2", [ORG, ALFA])).rows[0].n), 0, "nenhuma baixa de pagamento");
  await s.doLid("Sim");
  assert.equal(Number((await dono.query("select count(*) n from fv2_obrigacao where organizacao_id = $1 and unidade_id = $2", [ORG, ALFA])).rows[0].n), 2, "sem duplicidade");
});
