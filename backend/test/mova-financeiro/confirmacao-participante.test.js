// 24/11 — bloqueador do PR #203: cada CONFIRMAÇÃO (resposta a uma pergunta do MOVA) fica vinculada à operação certa, ao estado da
// conta na pergunta (versão), à conversa e à MESMA PESSOA autorizada que enviou o documento. Uma pessoa não confirma a operação de
// outra por acidente. Delegação formal ainda não existe no sistema (recusada até existir). Dados 100% sintéticos.
import assert from "node:assert/strict";
import { ALFA, ESTRANHO, FINANCEIRO, FIN, GRUPO, LID, LID_PRIVADO, ORG, SO_ALFA, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { podeConfirmarPendencia } from "../../src/modules/mova-financeiro/dominio/confirmacao.js";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { CONFIG } from "./helpers/operacao.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c2";
const CONCESSAO = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento"];
let n = 0;
const pdf = (m) => new TextEncoder().encode(`%PDF-1.4 confirmacao ${m} ${++n}`);
const PIX = (x) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 25000, dataPagamento: "2026-10-15", favorecido: "Fornecedor Sintético", natureza: "DESPESA", ...x });

async function cena() {
  const s = await cenario({
    responder: (req) => ((req.messages?.[0]?.content ?? []).some((b) => b.type === "document") ? PIX() : base({})),
    extras: ({ nucleo }) => ({
      autonomia: true, pagamentoPorComprovante: true, criarDespesas: true,
      operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: CONCESSAO }]) }),
    }),
  });
  const conta = await s.conta("2026-10-20", 23000);
  const propostas = () => s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA });
  const abertas = async () => Number((await s.banco.pool.query("select count(*)::int n from mova.mensagem_pendente where resolvida_em is null")).rows[0].n);
  /** Documento que gera a pergunta de juros (R$ 250 contra R$ 230 pendentes). Devolve o id da mensagem do documento. */
  const documento = async (de = FIN) => { const d = gw({ texto: "MOVA descartáveis para a alfa", doc: pdf(de), de }); await s.enviar(d); return d.mensagemId; };
  return { ...s, conta, propostas, abertas, documento };
}
const motivo = async (s) => (await s.ultima()).motivo;

t("CP-01 DOIS participantes na mesma conversa: outra pessoa citando o documento não confirma; a pendência fica para quem enviou", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  assert.equal(await motivo(s), "VALOR_MAIOR_QUE_SALDO");
  // no grupo, citar uma mensagem humana só aciona o MOVA com a menção ("MOVA ..."): é o caminho que chega à pendência
  await s.enviar(gw({ texto: "MOVA sim", de: SO_ALFA, respostaA: doc }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length, await s.abertas()], ["CONFIRMACAO_DE_OUTRO_PARTICIPANTE", 0, 1]);
  await s.enviar(gw({ texto: "sim", de: FIN, grupo: FIN, respostaA: doc }));
  const [p] = await s.propostas();
  assert.deepEqual([p?.comando?.juros?.valorCentavos, await s.abertas()], [2000, 0]);
});

t("CP-02 participante SEM autorização citando a pergunta: ignorado (nada lido nem respondido) e a pendência continua aberta", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  const antes = (await s.mova.armazenamento.historico.todos()).length;
  await s.enviar(gw({ texto: "MOVA sim", de: ESTRANHO, respostaA: doc }));
  const novas = (await s.mova.armazenamento.historico.todos()).slice(antes);
  assert.ok(novas.every((h) => h.motivo === "PARTICIPANTE_NAO_AUTORIZADO"), JSON.stringify(novas.map((h) => h.motivo)));
  assert.deepEqual([(await s.propostas()).length, await s.abertas()], [0, 1]);
});

t("CP-03 citação da PERGUNTA do MOVA (resposta no grupo) por participante incorreto: recusada; a certa funciona", async () => {
  const s = await cena();
  await s.documento(FIN);
  // política de resposta no GRUPO: a pergunta e a pendência ficam na conversa do grupo
  await s.banco.pool.query("update mova.mensagem_pendente set grupo_jid = $1 where resolvida_em is null", [GRUPO]);
  await s.banco.pool.query("update mova.resposta set grupo_jid = $1, estado = 'ENVIADA', provider_message_id = 'PERGUNTA_NO_GRUPO_01' where seq = (select max(seq) from mova.resposta)", [GRUPO]);
  await s.enviar(gw({ texto: "sim", de: SO_ALFA, respostaA: "PERGUNTA_NO_GRUPO_01" }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length, await s.abertas()], ["CONFIRMACAO_DE_OUTRO_PARTICIPANTE", 0, 1]);
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: "PERGUNTA_NO_GRUPO_01" }));
  assert.equal((await s.propostas()).length, 1);
});

t("CP-04 a MESMA pessoa com outro identificador (LID no grupo × número no privado) confirma a própria pergunta", async () => {
  const s = await cena();
  const doc = await s.documento(LID);
  assert.equal(await motivo(s), "VALOR_MAIOR_QUE_SALDO");
  await s.enviar(gw({ texto: "sim", de: LID_PRIVADO, grupo: LID_PRIVADO, respostaA: doc }));
  assert.equal((await s.propostas()).length, 1);
});

t("CP-05 DUAS pendências de pessoas diferentes: cada uma só responde a sua", async () => {
  const s = await cena();
  const docFin = await s.documento(FIN);
  const docLid = await s.documento(LID);
  assert.equal(await s.abertas(), 2);
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: docLid }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length, await s.abertas()], ["CONFIRMACAO_DE_OUTRO_PARTICIPANTE", 0, 2]);
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: docFin }));
  assert.deepEqual([(await s.propostas()).length, await s.abertas()], [1, 1]);
});

t("CP-06 PROPOSTA ALTERADA: a conta mudou entre a pergunta e o 'sim' → nada é executado (pergunta desatualizada)", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  // o saldo guardado na pergunta (R$ 230) difere do atual — equivale a outra baixa/correção ter acontecido no meio
  await s.banco.pool.query("update mova.mensagem_pendente set leitura = jsonb_set(leitura, '{divergencia,candidatas,0,saldoCentavos}', '22000') where resolvida_em is null");
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: doc }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length], ["PERGUNTA_DESATUALIZADA", 0]);
  assert.match((await s.saida()).at(-1).texto, /A conta mudou desde a minha pergunta/);
});

t("CP-07 CONCORRÊNCIA: a dona e outra pessoa respondem ao mesmo tempo → só a da dona vale, uma proposta", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  await Promise.all([s.enviar(gw({ texto: "sim", de: SO_ALFA, respostaA: doc })), s.enviar(gw({ texto: "sim", de: FIN, respostaA: doc })), s.enviar(gw({ texto: "sim", de: SO_ALFA, respostaA: doc }))]);
  const ps = await s.propostas();
  assert.equal(ps.length, 1);
  assert.equal(await s.abertas(), 0);
});

t("CP-08 MENSAGEM DUPLICADA (o mesmo evento entregue duas vezes): uma única retomada", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  const resposta = gw({ texto: "sim", de: FIN, respostaA: doc });
  await Promise.all([s.enviar(resposta), s.enviar({ ...resposta })]);
  await s.enviar({ ...resposta });
  assert.equal((await s.propostas()).length, 1);
});

t("CP-09 regra pura: mesma pessoa (id, celular com/sem 9, entrada da lista) pode; outra pessoa e delegação inexistente não", () => {
  const cfg = validarConfiguracao(CONFIG);
  const de = (participanteId, grupoId = GRUPO) => ({ participanteId, grupoId, telefoneE164: null });
  assert.equal(podeConfirmarPendencia(cfg, de(FIN), de(FIN, FIN)).pode, true);
  assert.equal(podeConfirmarPendencia(cfg, de(LID), de(LID_PRIVADO, LID_PRIVADO)).motivo, "MESMA_PESSOA_AUTORIZADA");
  // celular com/sem o nono dígito: vale só quando o número está NA LISTA da conversa (identidade canônica = entrada da configuração)
  const cfgCel = validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ ...CONFIG.gruposAutorizados[0], participantes: [...CONFIG.gruposAutorizados[0].participantes, { ids: ["5585988887777@s.whatsapp.net"], perfil: "FINANCEIRO" }] }, CONFIG.gruposAutorizados[1]] });
  assert.equal(podeConfirmarPendencia(cfgCel, de("5585988887777@s.whatsapp.net"), de("558588887777@s.whatsapp.net")).motivo, "MESMO_CELULAR");
  // revisão 24/11: o MESMO número fora da lista não confirma (coincidência de telefone sozinha não é identidade)
  assert.equal(podeConfirmarPendencia(cfg, de("5585988887777@s.whatsapp.net"), de("558588887777@s.whatsapp.net")).motivo, "NAO_AUTORIZADO_NESTA_CONVERSA");
  assert.equal(podeConfirmarPendencia(cfg, de(FIN), de(SO_ALFA)).pode, false);
  assert.equal(podeConfirmarPendencia(cfg, de(FIN), de(LID)).pode, false);
  assert.equal(podeConfirmarPendencia(cfg, de(null), de(FIN)).pode, false);
});

t("CP-10 TELEFONE informado no evento não é identidade: JID desconhecido com o telefoneE164 do financeiro não confirma", () => {
  const cfg = validarConfiguracao(CONFIG);
  const r = podeConfirmarPendencia(cfg, { participanteId: FIN, grupoId: GRUPO }, { participanteId: ESTRANHO, grupoId: GRUPO, telefoneE164: "+5500000000201" });
  assert.deepEqual([r.pode, r.motivo], [false, "NAO_AUTORIZADO_NESTA_CONVERSA"]);
});

t("CP-11 UNIDADE: quem responde precisa alcançar a unidade da pendência (financeiro só da Alfa não confirma pendência da Beta)", () => {
  const cfg = validarConfiguracao(CONFIG);
  const de = (participanteId) => ({ participanteId, grupoId: GRUPO });
  assert.equal(podeConfirmarPendencia(cfg, de(SO_ALFA), de(SO_ALFA), { unidadeId: ALFA }).pode, true);
  assert.equal(podeConfirmarPendencia(cfg, de(SO_ALFA), de(SO_ALFA), { unidadeId: "ffffffff-0000-4000-8000-00000000beef" }).motivo, "UNIDADE_FORA_DA_CONVERSA");
});

t("CP-12 VERSÃO COMPLETA: categoria/fornecedor/vencimento alterados (saldo igual) invalidam a confirmação", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  // a versão guardada na pergunta difere em outro campo que não o saldo (equivale a reclassificar ou trocar o fornecedor no meio)
  const { rows: [pd] } = await s.banco.pool.query("select mensagem_id, leitura from mova.mensagem_pendente where resolvida_em is null");
  const partes = pd.leitura.divergencia.candidatas[0].versao.split("|"); partes[3] = "fornecedor-trocado"; pd.leitura.divergencia.candidatas[0].versao = partes.join("|");
  await s.banco.pool.query("update mova.mensagem_pendente set leitura = $2 where mensagem_id = $1", [pd.mensagem_id, JSON.stringify(pd.leitura)]);
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: doc }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length], ["PERGUNTA_DESATUALIZADA", 0]);
  assert.match((await s.saida()).at(-1).texto, /mudou: fornecedor/);
});

t("CP-13 EXPIRADA também citando o DOCUMENTO: pendência além da validade não é retomada e continua aberta", async () => {
  const s = await cena();
  const doc = await s.documento(FIN);
  await s.banco.pool.query("update mova.mensagem_pendente set criada_em = now() - interval '73 hours' where resolvida_em is null");
  await s.enviar(gw({ texto: "sim", de: FIN, respostaA: doc }));
  assert.deepEqual([await motivo(s), (await s.propostas()).length, await s.abertas()], ["PENDENCIA_EXPIRADA", 0, 1]);
});
