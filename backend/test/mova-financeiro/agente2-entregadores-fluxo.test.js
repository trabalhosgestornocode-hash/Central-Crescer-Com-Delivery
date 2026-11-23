// MOVA — Agente 2, Frente D INTEGRADA: rotina semanal do entregador ⇄ fechamento OFICIAL do Financeiro (entregadoresProprios).
// Financeiro v2 REAL em memória (fechamento, nota, conta a pagar), banco do MOVA no PostgreSQL local isolado. Sem IA (o cliente
// falha se for chamado). Tudo sintético: nomes, números (DDD 00) e valores. Nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { after } from "node:test";
import { ACAO, criarCofreMemoria, criarConcessoesMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";
import { AUTOMACAO, criarExtratorAnthropic, criarMova, criarPortaOperacional, instalarConfiguracao, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, CONFIG, ESCOPOS, FIN, FINANCEIRO, ORG, gw, t } from "./helpers/operacao.js";
import { criarBancoMova, descartarBancoMova } from "./helpers/banco.js";

const SEG = "2026-11-02";
const SEGUNDA_9H = "2026-11-09T12:00:00.000Z"; // 09:00 em Brasília
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c2";
const MAURICIO = "5500000000301@s.whatsapp.net", MAURICIO_LID = "88000000000301@lid";
const RAFAEL = "5500000000302@s.whatsapp.net";
const PDF = "%PDF-1.4\n% nota sintetica do entregador\n%%EOF\n";
const ENTREGADORES = [
  { unidadeId: ALFA, chave: "mauricio", telefoneE164: "+5500000000301", privado: MAURICIO, ids: [MAURICIO_LID], nome: "Mauricio" },
  { unidadeId: ALFA, chave: "rafael", telefoneE164: "+5500000000302", privado: RAFAEL, nome: "Rafael" },
  // número que já é da EQUIPE (conversa privada derivada do grupo): não vira conversa de entregador.
  { unidadeId: ALFA, chave: "zeca", telefoneE164: "+5500000000201", privado: FIN, nome: "Zeca" },
];
const dias = () => Array.from({ length: 7 }, (_, i) => ({ data: `2026-11-0${2 + i}`, fonte: "foody", provisorio: false, aberto: false, triagem: 0 }));
const entrega = (id, nome, data, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: nome.toLowerCase(), entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
const APURACAO = { disponivel: true, dias: dias(), entregas: [entrega(1, "Mauricio", "2026-11-02", 700), entrega(2, "Mauricio", "2026-11-08", 800), entrega(3, "Rafael", "2026-11-05", 900), entrega(4, "Zeca", "2026-11-05", 400)] };

const criados = [];
after(async () => { for (const b of criados.splice(0)) await descartarBancoMova(b).catch(() => {}); });

async function cenario({ concessao = [ACAO.VER, ACAO.ENVIAR_DOCUMENTO] } = {}) {
  const estado = { agora: SEGUNDA_9H };
  const relogio = () => new Date(estado.agora);
  const cofre = criarCofreMemoria();
  const real = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS, relogio, cofre,
    entregadores: { fonte: { apurar: async () => APURACAO }, inicioDaOperacao: SEG, cofreDeNotas: cofre } });
  const adm = ctx(ORG, ALFA, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  await real.implantarPlanoDeContas(adm, { modelo: "ACAITERIA" });
  await real.fecharSemanaDeEntregadores(adm, { inicio: SEG });
  const chamadas = [];
  const nucleo = Object.fromEntries(Object.entries(real).map(([nome, op]) => [nome, typeof op !== "function" ? op : async (cx, ...a) => { chamadas.push({ nome, usuarioId: cx?.usuarioId, permissoes: cx?.permissoes }); return op(cx, ...a); }]));
  const banco = await criarBancoMova();
  criados.push(banco);
  const config = { ...CONFIG, entregadores: ENTREGADORES };
  await instalarConfiguracao(banco.pool, validarConfiguracao(config));
  const ref = {};
  const ia = { beta: { messages: { async create() { throw new Error("IA não pode ser chamada no fluxo do entregador"); } } } };
  const porta = criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: CONFIG.identidadeServico.usuarioId,
    concessoes: criarConcessoesMemoria(concessao ? [{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }] : []) });
  ref.mova = criarMova({ configuracao: config, nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool: banco.pool, relogio, comandosDeterministicos: true,
    extrator: criarExtratorAnthropic({ cliente: ia, obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio }), entregadores: true, operacional: porta });
  const mova = ref.mova;
  const enviar = async (p) => { const r = await mova.receptor.receber(p); await mova.receptor.trabalhar(); return r; };
  const saida = async () => (await banco.pool.query("select grupo_jid as destino, texto from mova.resposta order by seq")).rows;
  const ultima = async () => (await mova.armazenamento.historico.todos()).at(-1);
  const fechamento = async (chave) => real.detalharFechamentoDoEntregador(adm, { inicio: SEG, entregador: chave });
  const escritas = () => chamadas.filter((c) => c.nome === "anexarDocumentoDoEntregador");
  const ligar = (nome, extra = {}) => mova.armazenamento.automacoes.definir({ nome, organizacaoId: ORG, unidadeId: ALFA, ativa: true, horario: "09:00", ...extra });
  return { estado, real, adm, mova, enviar, saida, ultima, fechamento, escritas, ligar, chamadas, banco };
}

t("A2-E1 segunda 09:00: cada entregador recebe SÓ o próprio fechamento no privado; uma vez só; pausada não envia", async () => {
  const s = await cenario();
  assert.deepEqual(await s.mova.entregadores.rotina(), { semanais: 0, cobrancas: 0, pulados: [], avisos: 0, relatorios: 0 }, "sem automação ligada nada sai");
  await s.ligar(AUTOMACAO.SEMANAL);
  const r = await s.mova.entregadores.rotina();
  assert.equal(r.semanais, 2);
  assert.ok(r.pulados.includes("SEM_CONVERSA"), "o número da equipe não recebe mensagem de entregador");
  const out = await s.saida();
  assert.deepEqual(out.map((x) => x.destino).sort(), [MAURICIO, RAFAEL]);
  const m = out.find((x) => x.destino === MAURICIO).texto;
  assert.match(m, /Mauricio.*02\/11\/2026 a 08\/11\/2026/s);
  assert.match(m, /2 entrega\(s\) — R\$ 15,00/);
  assert.match(m, /nota fiscal.*até 10\/11\/2026/);
  assert.doesNotMatch(m, /9,00|Rafael|Zeca/, "nada de outro entregador");
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "idempotente");
  assert.equal((await s.saida()).length, 2);
  s.estado.agora = "2026-11-10T12:00:00.000Z"; // terça: não é dia da mensagem semanal
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0);
  const s2 = await cenario();
  await s2.ligar(AUTOMACAO.SEMANAL);
  await s2.mova.armazenamento.automacoes.pausar({ nome: AUTOMACAO.SEMANAL, unidadeId: ALFA, por: "eeeeeeee-0000-4000-8000-000000000001", motivo: "conferência manual" });
  assert.equal((await s2.mova.entregadores.rotina()).semanais, 0, "pausa individual");
  const s3 = await cenario();
  s3.estado.agora = "2026-11-09T11:00:00.000Z"; // 08:00 em Brasília
  await s3.ligar(AUTOMACAO.SEMANAL);
  assert.equal((await s3.mova.entregadores.rotina()).semanais, 0, "antes do horário");
});

t("A2-E2 entregador pergunta no privado (PN ou LID): vê o próprio fechamento, sem IA; número desconhecido é ignorado", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "quanto deu minha semana?", de: MAURICIO, grupo: MAURICIO }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["CONSULTA", "FECHAMENTO_DO_ENTREGADOR"]);
  const [r] = await s.saida();
  assert.equal(r.destino, MAURICIO);
  assert.match(r.texto, /R\$ 15,00/);
  await s.enviar(gw({ texto: "e agora?", de: MAURICIO_LID, grupo: MAURICIO }));
  assert.equal((await s.ultima()).motivo, "FECHAMENTO_DO_ENTREGADOR");
  await s.enviar(gw({ texto: "quero ver o do rafael", de: "5500000000399@s.whatsapp.net", grupo: MAURICIO }));
  assert.equal((await s.saida()).length, 2, "outro número na conversa do entregador não recebe nada");
  await s.enviar(gw({ texto: "oi", de: "5500000000398@s.whatsapp.net", grupo: "5500000000398@s.whatsapp.net" }));
  assert.equal((await s.saida()).length, 2, "conversa desconhecida não recebe nada");
});

t("A2-E3 NFS-e em PDF no privado: anexo OFICIAL pela identidade operacional (só ver+enviar documento); reenvio não duplica; cobrança para", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: null, de: MAURICIO, grupo: MAURICIO, doc: PDF }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["EXECUTADO", "NOTA_ANEXADA"]);
  const [w] = s.escritas();
  assert.equal(w.usuarioId, OPERADOR);
  assert.deepEqual([...w.permissoes].sort(), [ACAO.ENVIAR_DOCUMENTO, ACAO.VER].sort());
  const f = await s.fechamento("mauricio");
  assert.equal(f.situacaoDocumental, "NF_RECEBIDA", "a conferência continua no Financeiro (sem 'conciliar' não libera sozinho)");
  assert.match((await s.saida()).at(-1).texto, /anexei ao seu fechamento/);
  await s.enviar(gw({ texto: null, de: MAURICIO, grupo: MAURICIO, doc: PDF }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["DUPLICADO", "NOTA_JA_RECEBIDA"]);
  assert.equal(s.escritas().length, 1);
  await s.ligar(AUTOMACAO.COBRANCA);
  assert.equal((await s.mova.entregadores.rotina()).cobrancas, 0, "23/11: segunda-feira não cobra (lembrete só na terça)");
  s.estado.agora = "2026-11-10T13:00:00.000Z"; // terça 10h em Fortaleza: só quem ainda não mandou (Rafael)
  assert.equal((await s.mova.entregadores.rotina()).cobrancas, 1);
  assert.deepEqual((await s.saida()).filter((x) => /Lembrete/.test(x.texto)).map((x) => x.destino), [RAFAEL]);
  assert.equal((await s.mova.entregadores.rotina()).cobrancas, 0, "uma cobrança por dia");
  const [nota] = await s.mova.armazenamento.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.equal(nota.estado, "ANEXADA");
});

t("A2-E4 sem concessão operacional: nota fica PENDENTE para o Centro Financeiro (nada escrito); foto não vale como nota", async () => {
  const s = await cenario({ concessao: null });
  await s.enviar(gw({ texto: null, de: RAFAEL, grupo: RAFAEL, doc: PDF }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["PROPOSTA", "NOTA_PENDENTE_ANEXO"]);
  assert.equal(s.escritas().length, 0);
  assert.equal((await s.fechamento("rafael")).situacaoDocumental, "AGUARDANDO_NF");
  const [n] = await s.mova.armazenamento.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.equal(n.estado, "PENDENTE_ANEXO");
  const foto = gw({ texto: null, de: RAFAEL, grupo: RAFAEL, doc: "\xff\xd8\xff\xe0 foto sintetica" });
  foto.midia.mime = "image/jpeg";
  foto.tipo = "IMAGEM";
  await s.enviar(foto);
  assert.equal((await s.ultima()).motivo, "NOTA_PRECISA_SER_PDF");
});

t("A2-E5 configuração: entregador fora das unidades do MOVA é recusado; o número da equipe não vira conversa de entregador", () => {
  assert.throws(() => validarConfiguracao({ ...CONFIG, entregadores: [{ ...ENTREGADORES[0], unidadeId: "dddddddd-0000-4000-8000-0000000a2c99" }] }), /entregadores\[0\]\.unidade/);
  assert.throws(() => validarConfiguracao({ ...CONFIG, entregadores: [{ ...ENTREGADORES[0], ids: ["5500000000301@s.whatsapp.net"] }] }), /entregadores/);
  const cfg = validarConfiguracao({ ...CONFIG, entregadores: ENTREGADORES });
  assert.deepEqual(cfg.gruposAutorizados.filter((g) => g.entregador).map((g) => g.grupoId).sort(), [MAURICIO, RAFAEL]);
  assert.equal(cfg.gruposAutorizados.find((g) => g.grupoId === FIN).entregador, undefined);
});
