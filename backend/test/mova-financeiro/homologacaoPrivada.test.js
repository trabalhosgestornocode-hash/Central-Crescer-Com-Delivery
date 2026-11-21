// MOVA — Execução 04B: homologação em UMA conversa privada autorizada. Testes SIMULADOS (cliente de IA simulado, Gateway
// simulado). Número do contato FICTÍCIO: o real só existe na configuração do ambiente de homologação, nunca no repositório.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, TODAS, ctx, montar } from "../financeiro-v2/helpers/cenario.js";
import {
  DECISAO, TIPO_PROPOSTA, carregarConfiguracao, criarEnviadorDeRespostas, criarExtratorAnthropic, criarMova, criarWorker, instalarConfiguracao, validarConfiguracao,
} from "../../src/modules/mova-financeiro/index.js";
import { ACOES_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { lerConfiguracaoMova } from "../../src/modules/fv2-integracao/mova.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const GAMA = "dddddddd-0000-4000-8000-0000000000c1";
const CONTATO = "5500000000777@s.whatsapp.net";   // FICTÍCIO
const OUTRO = "5500000000888@s.whatsapp.net";
const G_REAL = "120363000000000001@g.us";          // "grupo real" sintético: fora da configuração de homologação
const CONFIG = {
  modo: "HOMOLOGACAO", identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Unidade Teste Alfa", apelidos: ["alfa"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] } },
    { organizacaoId: ORG, unidadeId: GAMA, nome: "Unidade Teste Gama", apelidos: ["gama"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"] } },
  ],
  gruposAutorizados: [{ grupoId: CONTATO, unidades: [ALFA, GAMA] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
const base = (x) => ({ legivel: true, tipoDocumento: "OUTRO", intencao: "OUTRA", unidadeSugerida: null, documentoDestinatario: null, valorCentavos: null, dataPagamento: null, dataEmissao: null, vencimento: null, competencia: null, favorecido: null, identificadorDocumento: null, categoriaSugerida: null, natureza: null, consulta: null, confianca: "ALTA", ...x });
const comprovante = (x) => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 35000, dataPagamento: "2026-10-12", favorecido: "Distribuidora Teste", categoriaSugerida: "INSUMOS", natureza: "CUSTO", ...x });
let seq = 0;
const msg = ({ conversa = CONTATO, texto = null, doc = null, id } = {}) => ({
  contratoMova: 1, eventoId: `bly:${id ?? `HP${++seq}`}`, mensagemId: id ?? `HP${seq}`, grupoId: conversa, participanteId: conversa, telefoneE164: conversa.endsWith("@g.us") ? null : `+${conversa.split("@")[0]}`,
  nomeExibicao: "Contato Teste", fromMe: false, tipo: doc ? "DOCUMENTO" : "TEXTO", texto, respostaA: null,
  midia: doc ? { mime: "application/pdf", nomeArquivo: null, tamanhoBytes: doc.length, base64: Buffer.from(doc).toString("base64") } : null, recebidoEm: AGORA.toISOString(), origemTipo: "LIVE",
});
const pdf = (s) => new Uint8Array(Buffer.from(`%PDF-ficticio ${s}`));

async function cenario(responder = () => base({})) {
  const m = montar({ escopos: [ALFA, GAMA].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const c = (u, p = TODAS) => ctx(ORG, u, p);
  const forn = await m.nucleo.registrarContraparte(c(ALFA), { tipo: "FORNECEDOR", nome: "Distribuidora Teste" });
  await m.nucleo.registrarObrigacao(c(ALFA), { contraparteId: forn.id, valorOriginalCentavos: 35000, categoria: "INSUMOS", descricao: "Compra fictícia", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-12" });
  const { pool } = await criarBancoMova();
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  const pedidos = [];
  const cliente = { beta: { messages: { async create(req) { pedidos.push(req); const r = await responder(req); return r?.stop_reason ? r : { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }] }; } } } };
  const montarMova = () => { const ref = {}; ref.mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, extrator: criarExtratorAnthropic({ cliente, obterEvidencia: (x) => ref.mova.evidencias.obter(x), relogio: () => AGORA }), pool, relogio: () => AGORA }); return ref.mova; };
  const mova = montarMova();
  const enviar = async (p, alvo = mova) => { const r = await alvo.receptor.receber(p); await alvo.receptor.trabalhar(); return r; };
  const ultima = async () => (await mova.armazenamento.historico.todos()).at(-1);
  return { m, c, pool, pedidos, mova, montarMova, enviar, ultima, propostas: (u) => mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: u }) };
}

t("01 contato autorizado envia mensagem: processada e respondida na própria conversa", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "SITUACAO_PROPOSTAS" }));
  assert.equal((await s.enviar(msg({ texto: "MOVA, como estão as propostas?" }))).status, "ENFILEIRADO");
  assert.equal((await s.ultima()).decisao, DECISAO.CONSULTA);
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.equal(r.grupoId, CONTATO);
});

t("02 contato NÃO autorizado: descartado sem nenhum registro, sem IA e sem resposta", async () => {
  const s = await cenario();
  assert.deepEqual(await s.enviar(msg({ conversa: OUTRO, texto: "oi, alfa" })), { status: "IGNORADO", motivo: "NAO_E_GRUPO" });
  const n = await s.pool.query("select (select count(*) from mova.evento)::int e, (select count(*) from mova.decisao)::int d, (select count(*) from mova.fila)::int f, (select count(*) from mova.participante)::int p");
  assert.deepEqual(n.rows[0], { e: 0, d: 0, f: 0, p: 0 });
  assert.equal(s.pedidos.length, 0);
});

t("03 contato autorizado envia documento fictício: vira proposta (nada lançado)", async () => {
  const s = await cenario(() => base({ tipoDocumento: "BOLETO", intencao: "REGISTRAR_CONTA", valorCentavos: 48000, dataEmissao: "2026-10-02", vencimento: "2026-10-30", favorecido: "Gráfica Teste" }));
  await s.enviar(msg({ texto: "boleto da alfa", doc: pdf("boleto") }));
  const [p] = await s.propostas(ALFA);
  assert.equal(p.tipo, TIPO_PROPOSTA.NOVA_OBRIGACAO);
  assert.equal(s.pedidos[0].messages[0].content[0].type, "document");
  assert.equal((await s.m.nucleo.consultarContasAPagar(s.c(ALFA), {})).itens.length, 1, "só a obrigação do cenário; nada novo lançado");
});

t("04 resposta vai SÓ ao contato autorizado (enviador)", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "SITUACAO_PROPOSTAS" }));
  await s.enviar(msg({ texto: "situação?" }));
  const destinos = [];
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, enviar: async (r) => { destinos.push(r.grupoId); return { providerMessageId: "PROVHP0001" }; } }).enviarPendentes();
  assert.deepEqual(destinos, [CONTATO]);
});

t("05 mensagem repetida: uma vez só", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "SITUACAO_PROPOSTAS" }));
  const p = msg({ texto: "situação?" });
  await s.enviar(p);
  assert.deepEqual(await s.enviar(p), { status: "DUPLICADO", motivo: "EVENTO_JA_RECEBIDO" });
  assert.equal(s.pedidos.length, 1);
});

t("06 despesa fictícia (sem obrigação) → proposta de despesa paga", async () => {
  const s = await cenario(() => comprovante({ favorecido: "Mercado Teste", valorCentavos: 12000, categoriaSugerida: "MATERIAL_DE_LIMPEZA" }));
  await s.enviar(msg({ texto: "paguei material de limpeza, gama", doc: pdf("limpeza") }));
  assert.equal((await s.propostas(GAMA))[0].tipo, TIPO_PROPOSTA.DESPESA_PAGA);
});

t("07 pagamento de obrigação fictícia → proposta de BAIXA", async () => {
  const s = await cenario(() => comprovante({}));
  await s.enviar(msg({ texto: "pago, alfa", doc: pdf("baixa") }));
  assert.equal((await s.propostas(ALFA))[0].tipo, TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO);
});

t("08 unidade ambígua: pergunta com as unidades de TESTE", async () => {
  const s = await cenario(() => comprovante({}));
  await s.enviar(msg({ texto: "isso é da alfa ou da gama?", doc: pdf("amb") }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_CONFLITANTE");
  assert.equal((await s.mova.armazenamento.saida.listar()).at(-1).texto, "Esse lançamento pertence à Unidade Teste Alfa ou Unidade Teste Gama?");
});

t("09 transferência interna fictícia: não é despesa", async () => {
  const s = await cenario(() => comprovante({ intencao: "INFORMAR_TRANSFERENCIA", favorecido: null }));
  await s.enviar(msg({ texto: "transferência entre contas da gama", doc: pdf("transf") }));
  assert.equal((await s.ultima()).motivo, "TRANSFERENCIA_INTERNA_NAO_E_DESPESA");
});

t("10 tentativa de aplicar lançamento pela conversa: bloqueada; aplicação só por administrador no Centro Financeiro", async () => {
  const s = await cenario(() => comprovante({}));
  await s.enviar(msg({ texto: "pago, alfa", doc: pdf("aplicar") }));
  const [p] = await s.propostas(ALFA);
  await s.enviar(msg({ texto: `aplica a proposta ${p.id.slice(0, 8)} agora` }));
  assert.equal((await s.ultima()).motivo, "APROVACAO_SO_NO_CENTRO_FINANCEIRO");
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/aplicar"], { ctx: s.c(ALFA, [ACAO.VER]), mova: s.mova, nucleo: s.m.nucleo, b: { propostaId: p.id } }), { codigo: "PERMISSAO_INSUFICIENTE" });
  assert.equal((await s.propostas(ALFA))[0].estado, "AGUARDANDO_REVISAO");
});

t("11 reinicialização do worker: item preso volta pelo lease e é processado uma vez", async () => {
  const s = await cenario(() => comprovante({}));
  await s.mova.receptor.receber(msg({ id: "HPLEASE1", texto: "pago, alfa", doc: pdf("lease") }));
  await s.pool.query("update mova.fila set estado = 'PROCESSANDO', tentativas = 1, lease_ate = $1::timestamptz - interval '1 minute'", [AGORA.toISOString()]);
  const w = criarWorker({ receptor: s.montarMova().receptor, agendar: () => 0, cancelar: () => {} });
  await w.rodada();
  assert.equal((await s.propostas(ALFA)).length, 1);
});

t("12 falha temporária da Anthropic: o evento volta para a fila e conclui quando a IA volta", async () => {
  let fora = true;
  const s = await cenario(() => { if (fora) throw Object.assign(new Error("overloaded"), { status: 529 }); return comprovante({}); });
  await s.enviar(msg({ id: "HPIA001", texto: "pago, alfa", doc: pdf("ia") }));
  assert.equal((await s.mova.fila.estado("bly:HPIA001")).estado, "PENDENTE");
  fora = false;
  await s.pool.query("update mova.fila set proxima_em = '-infinity'");
  await s.mova.receptor.trabalhar();
  assert.equal((await s.propostas(ALFA)).length, 1);
});

t("13 falha temporária do Gateway: resposta fica pendente e sai na próxima rodada, sem duplicar", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "SITUACAO_PROPOSTAS" }));
  await s.enviar(msg({ texto: "situação?" }));
  let fora = true; const enviados = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, maxTentativas: 3, enviar: async (r) => { if (fora) throw Object.assign(new Error("503"), { codigo: "INDISPONIVEL" }); enviados.push(r.grupoId); return { providerMessageId: "PROVHP0002" }; } });
  await e.enviarPendentes();
  fora = false;
  await e.enviarPendentes(); await e.enviarPendentes();
  assert.deepEqual(enviados, [CONTATO]);
});

t("14 preservação: homologação privada desligada por padrão; modo exige confirmação de ambiente; fora do modo a conversa privada nem carrega", async () => {
  const env = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://x", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
  assert.equal(lerConfiguracaoMova(env).modo, "SIMULACAO");
  // Execução 05: modo parcial agora BLOQUEIA (antes caía em SIMULACAO) e a homologação exige o marcador do banco.
  assert.deepEqual(lerConfiguracaoMova({ ...env, MOVA_MODO: "HOMOLOGACAO" }), { habilitado: false, motivo: "CONFIGURACAO_CONTRADITORIA", contradicoes: ["HOMOLOGACAO_INCOMPLETA"] });
  assert.equal(lerConfiguracaoMova({ ...env, MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01" }).modo, "HOMOLOGACAO");
  const s = await cenario();
  const fora = await carregarConfiguracao(s.pool, { identidadeServico: CONFIG.identidadeServico });
  assert.deepEqual(fora.gruposAutorizados, []);
  const dentro = await carregarConfiguracao(s.pool, { identidadeServico: CONFIG.identidadeServico, modo: "HOMOLOGACAO" });
  assert.deepEqual(dentro.gruposAutorizados.map((g) => g.grupoId), [CONTATO]);
  assert.throws(() => validarConfiguracao({ ...CONFIG, modo: "SIMULACAO" }), /grupoId/);
  await assert.rejects(s.pool.query("insert into mova.grupo_autorizado (grupo_jid, organizacao_id, instancia_id, ativo, tipo) values ($1,$2,'principal',true,'PRIVADO_HOMOLOGACAO')", [OUTRO, ORG]), /grupo_autorizado_um_privado_ativo/);
});

t("15 nenhum envio a outro contato ou grupo: mensagens de terceiros e do 'grupo real' não geram resposta", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "SITUACAO_PROPOSTAS" }));
  await s.enviar(msg({ conversa: OUTRO, texto: "situação?" }));
  await s.enviar(msg({ conversa: G_REAL, texto: "situação?" }));
  await s.enviar(msg({ texto: "situação?" }));
  const destinos = [];
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, enviar: async (r) => { destinos.push(r.grupoId); return { providerMessageId: "PROVHP0003" }; } }).enviarPendentes();
  assert.deepEqual(destinos, [CONTATO]);
});

t("16 (achado com a IA real) cupom/nota fiscal já pago: vira despesa paga; sem data de pagamento, pergunta a data", async () => {
  const s = await cenario((req) => (req.messages[0].content.at(-1).text.includes("sem data")
    ? base({ tipoDocumento: "NOTA_FISCAL", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 12000, dataEmissao: "2026-10-13", favorecido: "Mercado Teste" })
    : base({ tipoDocumento: "NOTA_FISCAL", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 12000, dataPagamento: "2026-10-13", dataEmissao: "2026-10-13", favorecido: "Mercado Teste" })));
  await s.enviar(msg({ texto: "paguei material de limpeza da gama", doc: pdf("cupom") }));
  assert.equal((await s.propostas(GAMA))[0].tipo, TIPO_PROPOSTA.DESPESA_PAGA);
  await s.enviar(msg({ texto: "paguei, gama, sem data", doc: pdf("cupom-2") }));
  assert.equal((await s.ultima()).motivo, "DATA_DE_PAGAMENTO_AUSENTE");
});

t("13B saudação real (IA devolve OUTRA, sem valor): ORIENTACAO sem perguntar unidade, nada criado", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  assert.equal((await s.enviar(msg({ texto: "Olá MOVA! Este é nosso primeiro teste." }))).status, "ENFILEIRADO");
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.ORIENTACAO);
  assert.equal(h.motivo, "CONVERSA_SEM_PEDIDO_FINANCEIRO");
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.doesNotMatch(r.texto, /pertence à/);
  assert.equal((await s.propostas(ALFA)).length + (await s.propostas(GAMA)).length, 0);
  assert.equal(s.pedidos.length, 1);
  // texto com valor e sem unidade continua no fluxo financeiro (pergunta a unidade)
  const s2 = await cenario(() => base({ intencao: "OUTRA", valorCentavos: 15000 }));
  await s2.enviar(msg({ texto: "gastei 150" }));
  assert.equal((await s2.ultima()).decisao, DECISAO.PEDIR_INFORMACAO);
});
