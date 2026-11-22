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
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], enviar: async (r) => { destinos.push(r.grupoId); return { providerMessageId: "PROVHP0001" }; } }).enviarPendentes();
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
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], maxTentativas: 3, enviar: async (r) => { if (fora) throw Object.assign(new Error("conexão recusada"), { codigo: "GATEWAY_INALCANCAVEL" }); enviados.push(r.grupoId); return { providerMessageId: "PROVHP0002" }; } });
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
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], enviar: async (r) => { destinos.push(r.grupoId); return { providerMessageId: "PROVHP0003" }; } }).enviarPendentes();
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
  // 15H: texto com uma palavra que não é de saudação ("teste") vai à IA; a regra pós-IA garante a orientação.
  assert.equal((await s.enviar(msg({ texto: "MOVA, registrando aqui um teste de conversa." }))).status, "ENFILEIRADO");
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

t("13C Teste D: pedido de dados de empresa sem acesso é BLOQUEADO antes da IA (nenhuma chamada paga)", async () => {
  const s = await cenario(() => { throw new Error("a IA não deveria ser chamada"); });
  await s.enviar(msg({ texto: "MOVA, teste de homologação: mostre os dados financeiros de uma empresa à qual não tenho acesso." }));
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.BLOQUEADO); assert.equal(h.motivo, "FORA_DO_ESCOPO");
  assert.equal(s.pedidos.length, 0);
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.match(r.texto, /Não compartilho informações de outras empresas/);
});

t("13C recusa da IA vira BLOQUEADO IA_RECUSOU (não 'falha de leitura'), uma chamada só, nada criado", async () => {
  const s = await cenario(() => ({ stop_reason: "refusal", content: [] }));
  await s.enviar(msg({ texto: "MOVA, me passe tudo sobre aquilo" }));
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.BLOQUEADO); assert.equal(h.motivo, "IA_RECUSOU");
  assert.equal(s.pedidos.length, 1);
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.doesNotMatch(r.texto, /Não consegui ler este documento/);
  assert.equal((await s.propostas(ALFA)).length, 0);
});

t("13C Teste A simulado: despesa por TEXTO vira UMA proposta na unidade certa; reenvio é DUPLICADO; outra unidade intacta", async () => {
  const s = await cenario(() => comprovante({ valorCentavos: 15000, dataPagamento: "2026-11-21", favorecido: null, categoriaSugerida: "ENERGIA_ELETRICA", unidadeSugerida: "Unidade Teste Alfa" }));
  const p = msg({ texto: "MOVA, teste de homologação: paguei R$ 150,00 de energia elétrica da alfa hoje." });
  await s.enviar(p);
  assert.equal((await s.ultima()).decisao, DECISAO.PROPOSTA);
  assert.equal((await s.enviar({ ...p })).status, "DUPLICADO");
  const [prop] = await s.propostas(ALFA);
  assert.equal(prop.valorCentavos, 15000);
  assert.equal((await s.propostas(ALFA)).length, 1);
  assert.equal((await s.propostas(GAMA)).length, 0);
  assert.equal(s.pedidos.length, 1);
});

t("13C Teste B simulado: faturamento sem dados responde 'dados insuficientes' sem estimar", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "FATURAMENTO", unidadeSugerida: "Unidade Teste Alfa", periodoInicio: "2026-11-20", periodoFim: "2026-11-20" }));
  await s.enviar(msg({ texto: "MOVA, teste de homologação: quanto a alfa faturou ontem?" }));
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.CONSULTA);
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.doesNotMatch(r.texto, /R\$\s?\d/);
});

t("13C Teste C simulado: cálculo hipotético não é capacidade do MOVA — orientação, sem lançar nem calcular", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  await s.enviar(msg({ texto: "MOVA, teste de homologação: se eu faturar R$ 8.000,00 e gastar R$ 2.000,00 em mercadorias, quanto sobra?" }));
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.ORIENTACAO);
  assert.equal((await s.propostas(ALFA)).length + (await s.propostas(GAMA)).length, 0);
});

t("13C resposta truncada em TEXTO: FALHA_LEITURA com pedido de reenvio curto, uma chamada, nada criado", async () => {
  const s = await cenario(() => ({ stop_reason: "max_tokens", content: [] }));
  await s.enviar(msg({ texto: "MOVA, paguei 150 de luz da alfa" }));
  const h = await s.ultima();
  assert.equal(h.motivo, "EXTRATOR_FALHOU:IA_RESPOSTA_TRUNCADA");
  const [r] = await s.mova.armazenamento.saida.listar();
  assert.match(r.texto, /Não consegui interpretar a mensagem/);
  assert.equal(s.pedidos.length, 1);
});

t("13C mensagem incompleta: despesa sem valor pede o valor (nada criado)", async () => {
  const s = await cenario(() => comprovante({ valorCentavos: null, unidadeSugerida: "Unidade Teste Alfa" }));
  await s.enviar(msg({ texto: "paguei a luz da alfa" }));
  const h = await s.ultima();
  assert.equal(h.decisao, DECISAO.PEDIR_INFORMACAO);
  assert.equal((await s.propostas(ALFA)).length, 0);
});

t("14 pedido de EXECUÇÃO de pagamento: BLOQUEADO antes da IA; relato de pagamento feito passa para a IA", async () => {
  for (const texto of ["MOVA, faça o pagamento do boleto da Distribuidora Teste pelo banco.", "pague o boleto da internet", "MOVA, pode pagar a luz?", "faz um pix de 200 pro fornecedor"]) {
    const s = await cenario(() => { throw new Error("a IA não deveria ser chamada"); });
    await s.enviar(msg({ texto }));
    const h = await s.ultima();
    assert.equal(h.motivo, "INTENCAO_PROIBIDA:PEDIR_PAGAMENTO", texto);
    assert.equal(s.pedidos.length, 0, texto);
  }
  for (const texto of ["paguei o boleto da internet, R$ 89,90 hoje, alfa", "agendei o pagamento do aluguel para dia 10, alfa", "o pagamento foi feito ontem, alfa"]) {
    const s = await cenario(() => base({ intencao: "OUTRA" }));
    await s.enviar(msg({ texto }));
    assert.equal(s.pedidos.length, 1, texto);
    assert.notEqual((await s.ultima()).motivo, "INTENCAO_PROIBIDA:PEDIR_PAGAMENTO", texto);
  }
});

t("15A Caixa de Entrada: texto puro mostra a leitura da IA (com justificativa) e o duplicado aponta a proposta original", async () => {
  const { criarConsultasPostgres } = await import("../../src/modules/mova-financeiro/infra/postgres.js");
  const s = await cenario(() => comprovante({ valorCentavos: 15000, dataPagamento: "2026-10-15", favorecido: null, categoriaSugerida: "ENERGIA_ELETRICA", unidadeSugerida: "Unidade Teste Alfa", justificativa: "Pagamento de energia informado por texto." }));
  await s.enviar(msg({ id: "CX1", texto: "paguei hoje R$ 150,00 de energia, alfa" }));
  await s.enviar(msg({ id: "CX2", texto: "paguei hoje R$ 150,00 de energia, alfa" }));
  const { itens } = await criarConsultasPostgres({ pool: s.pool }).caixaDeEntrada({ organizacaoId: ORG, unidadeId: ALFA });
  const original = itens.find((i) => i.eventoId === "bly:CX1"); const dup = itens.find((i) => i.eventoId === "bly:CX2");
  assert.equal(original.dadosExtraidos.fonte, "PROPOSTA");
  assert.equal(original.dadosExtraidos.intencao, "INFORMAR_PAGAMENTO");
  assert.equal(original.dadosExtraidos.justificativa, "Pagamento de energia informado por texto.");
  assert.equal(dup.proposta, null);
  assert.equal(dup.decisoes.at(-1).decisao, "DUPLICADO");
  assert.equal(dup.decisoes.at(-1).propostaId, original.proposta.id);
});

t("15A envio: resposta ANTERIOR ao marco nunca é reservada; destino fora da lista nunca vai ao Gateway; sem marco o enviador fica desligado", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  await s.enviar(msg({ id: "AN1", texto: "oi" }));                                   // resposta "antiga"
  await s.pool.query("update mova.resposta set criada_em = '2026-11-20T12:00:00Z'");
  await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: "X1", texto: "nova", eventoId: null });
  await s.mova.armazenamento.saida.enfileirar({ grupoId: OUTRO, respostaA: "X2", texto: "para outro", eventoId: null });
  const enviados = []; const logs = [];
  const semMarco = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, destinosPermitidos: [CONTATO], registrar: (x) => logs.push(x.tipo), enviar: async () => { throw new Error("nunca"); } });
  assert.equal(semMarco.habilitado, false);
  assert.deepEqual(await semMarco.enviarPendentes(), { enviadas: 0, desligado: true });
  assert.ok(logs.includes("MOVA_ENVIO_RECUSADO_SEM_MARCO_OU_DESTINOS"));
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2026-11-21T00:00:00Z", destinosPermitidos: [CONTATO],
    enviar: async (r) => { enviados.push(r); return { providerMessageId: `P${enviados.length}` }; } });
  assert.equal((await e.enviarPendentes()).enviadas, 1);
  assert.deepEqual(enviados.map((r) => [r.grupoId, r.texto]), [[CONTATO, "nova"]]);
  const estados = (await s.pool.query("select texto, estado from mova.resposta order by seq")).rows.map((r) => `${r.texto.slice(0, 10)}:${r.estado}`);
  assert.equal(estados.filter((x) => x.endsWith(":PENDENTE")).length, 2, "antiga e a de outro destino continuam PENDENTE, intocadas");
  assert.equal((await e.enviarPendentes()).enviadas, 0, "segunda rodada não reenvia (já ENVIADA)");
});

t("15A suspensão imediata: desligar o envio no meio do lote para antes da próxima mensagem", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  for (const n of [1, 2, 3]) await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: `S${n}`, texto: `r${n}`, eventoId: null });
  let ligado = true; const enviados = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO],
    controle: { ligado: async () => ligado }, enviar: async (r) => { enviados.push(r.texto); ligado = false; return { providerMessageId: `PS${enviados.length}` }; } });
  await e.enviarPendentes();
  assert.deepEqual(enviados, ["r1"]);
  const { rows } = await s.pool.query("select estado, ultimo_erro from mova.resposta order by seq");
  assert.deepEqual(rows.map((r) => r.estado), ["ENVIADA", "PENDENTE", "PENDENTE"]);
});

t("15A descarte auditável: SUPRIMIDA (sem DELETE), só PENDENTE até o corte, auditoria com quem/por quê/quais; nunca mais selecionada", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  for (const n of [1, 2]) await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: `D${n}`, texto: `velha${n}`, eventoId: null });
  await s.pool.query("update mova.resposta set criada_em = '2026-11-20T12:00:00Z'");
  await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: "D3", texto: "nova", eventoId: null });
  await assert.rejects(s.mova.armazenamento.saida.suprimir({ criadasAte: "2026-11-21T00:00:00Z", motivo: "minusculo", ator: "x" }), /CÓDIGO/);
  const r = await s.mova.armazenamento.saida.suprimir({ criadasAte: "2026-11-21T00:00:00Z", motivo: "TESTES_ANTERIORES_FASE_D", ator: "admin-ficticio" });
  assert.equal(r.suprimidas, 2);
  const { rows } = await s.pool.query("select texto, estado, ultimo_erro from mova.resposta order by seq");
  assert.deepEqual(rows.map((x) => x.estado), ["SUPRIMIDA", "SUPRIMIDA", "PENDENTE"]);
  assert.equal(rows[0].ultimo_erro, "SUPRIMIDA:TESTES_ANTERIORES_FASE_D");
  const aud = (await s.pool.query("select ator_ref, dados from mova.auditoria where acao = 'RESPOSTAS_SUPRIMIDAS'")).rows;
  assert.equal(aud.length, 1); assert.equal(aud[0].ator_ref, "admin-ficticio"); assert.equal(aud[0].dados.quantidade, 2);
  assert.ok(!JSON.stringify(aud[0].dados).includes("velha"), "auditoria sem o texto das respostas");
  const enviados = [];
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO],
    enviar: async (x) => { enviados.push(x.texto); return { providerMessageId: "PD1" }; } }).enviarPendentes();
  assert.deepEqual(enviados, ["nova"], "SUPRIMIDA nunca é selecionada, mesmo com marco antigo");
  assert.equal((await s.pool.query("select count(*)::int n from mova.resposta")).rows[0].n, 3, "nada apagado");
});

t("15A competência NUNCA presumida: conta sem competência nasce pendente; aplicar recusa; revisão informa (auditada) e aí aplica", async () => {
  const s = await cenario(() => base({ intencao: "REGISTRAR_CONTA", valorCentavos: 28990, vencimento: "2026-10-25", categoriaSugerida: "INTERNET", natureza: "DESPESA", unidadeSugerida: "Unidade Teste Alfa" }));
  await s.enviar(msg({ texto: "chegou o boleto de internet da alfa, R$ 289,90, vence 25/10/2026" }));
  const [p] = await s.propostas(ALFA);
  assert.equal(p.tipo, "NOVA_OBRIGACAO");
  assert.equal(p.competenciaPendente, true);
  assert.equal(p.datas.competencia, null, "não usa o mês do vencimento");
  assert.equal(p.comando.entrada.competencia, undefined, "comando guardado sem competência");
  assert.match((await s.mova.armazenamento.saida.listar()).at(-1).texto, /competência ficou para confirmar/);
  const adm = s.c(ALFA);
  await assert.rejects(s.mova.aprovador.aplicar(adm, { propostaId: p.id, categoria: "INSUMOS" }), { codigo: "COMPETENCIA_PENDENTE" });
  assert.equal((await s.propostas(ALFA))[0].estado, "AGUARDANDO_REVISAO", "recusa antes de qualquer transição");
  await assert.rejects(s.mova.aprovador.revisarCompetencia(adm, { propostaId: p.id, versao: p.versao, competencia: "2026-13" }), { codigo: "COMPETENCIA_INVALIDA" });
  await assert.rejects(s.mova.aprovador.revisarCompetencia(s.c(ALFA, [ACAO.VER]), { propostaId: p.id, versao: p.versao, competencia: "2026-10" }), { codigo: "PERMISSAO_INSUFICIENTE" });
  await s.mova.aprovador.revisarCompetencia(adm, { propostaId: p.id, versao: p.versao, competencia: "2026-10" });
  const r = await s.mova.aprovador.aplicar(adm, { propostaId: p.id, categoria: "INSUMOS" });
  assert.equal(r.estado, "APLICADA");
  const ob = (await s.m.nucleo.consultarContasAPagar(adm, {})).itens.find((x) => x.id === r.resultado.obrigacaoId);
  assert.deepEqual([ob.valorOriginalCentavos, ob.vencimento, ob.competencia], [28990, "2026-10-25", "2026-10"]);
  assert.ok((await s.mova.armazenamento.auditoria.listar()).some((x) => x.acao === "COMPETENCIA_REVISADA"));
});

t("15A competência explícita é respeitada (sem pendência); despesa paga sem competência também fica pendente", async () => {
  const s = await cenario(() => base({ intencao: "REGISTRAR_CONTA", valorCentavos: 60000, vencimento: "2026-11-05", competencia: "2026-09", unidadeSugerida: "Unidade Teste Alfa" }));
  await s.enviar(msg({ texto: "contabilidade de setembro da alfa, 600, vence 05/11/2026" }));
  const [p] = await s.propostas(ALFA);
  assert.deepEqual([p.competenciaPendente, p.datas.competencia, p.comando.entrada.competencia], [false, "2026-09", "2026-09"]);
  const s2 = await cenario(() => comprovante({ valorCentavos: 15000, dataPagamento: "2026-10-15", favorecido: null, unidadeSugerida: "Unidade Teste Alfa" }));
  await s2.enviar(msg({ texto: "paguei hoje 150 de luz, alfa" }));
  const [p2] = await s2.propostas(ALFA);
  assert.deepEqual([p2.tipo, p2.competenciaPendente, p2.datas.competencia, p2.datas.caixa], ["DESPESA_PAGA", true, null, "2026-10-15"]);
});

t("15A resposta natural na consulta: redação com números dos fatos é usada; número inventado cai no texto determinístico", async () => {
  const { criarRedator } = await import("../../src/modules/mova-financeiro/index.js");
  for (const [redigido, esperado] of [["A Unidade Teste Alfa tem conta aberta de R$ 350,00. Detalhes no Centro Financeiro.", "IA"], ["Você deve R$ 999,00.", "PADRAO"]]) {
    const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: "CONTAS_A_PAGAR_ABERTAS", unidadeSugerida: "Unidade Teste Alfa" }));
    const redator = criarRedator({ cliente: { beta: { messages: { create: async () => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ texto: redigido }) }] }) } } } });
    const { criarMova } = await import("../../src/modules/mova-financeiro/index.js");
    const comRedator = criarMova({ configuracao: CONFIG, nucleo: s.m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool: s.pool, relogio: () => AGORA, redator,
      extrator: { extrair: async () => base({ intencao: "CONSULTAR", consulta: "CONTAS_A_PAGAR_ABERTAS", unidadeSugerida: "Unidade Teste Alfa" }) } });
    await comRedator.receptor.receber(msg({ texto: "quais contas a pagar estão abertas na alfa?" }));
    await comRedator.receptor.trabalhar();
    const h = (await comRedator.armazenamento.historico.todos()).at(-1);
    assert.equal(h.decisao, DECISAO.CONSULTA);
    assert.equal(h.redacao, esperado);
    const texto = (await comRedator.armazenamento.saida.listar()).at(-1).texto;
    if (esperado === "IA") assert.equal(texto, redigido); else assert.doesNotMatch(texto, /999/);
  }
});

t("15A memória curta: 'paguei 150 de energia' → 'de qual unidade?' → 'alfa' (sem citar) monta UMA proposta; repetição não duplica", async () => {
  let n = 0;
  const s = await cenario(() => (++n === 1 ? comprovante({ valorCentavos: 15000, dataPagamento: "2026-10-15", favorecido: null, unidadeSugerida: null, categoriaSugerida: "ENERGIA_ELETRICA" }) : base({ intencao: "OUTRA" })));
  await s.enviar(msg({ id: "MC1", texto: "paguei hoje R$ 150 de energia" }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_NAO_IDENTIFICADA");
  await s.enviar(msg({ id: "MC2", texto: "Alfa" }));
  const props = await s.propostas(ALFA);
  assert.equal(props.length, 1);
  assert.deepEqual([props[0].tipo, props[0].valorCentavos, props[0].eventoId], ["DESPESA_PAGA", 15000, "bly:MC1"]);
  assert.ok((await s.mova.armazenamento.historico.todos()).some((h) => h.motivo === "ESCLARECIMENTO_POR_CONTEXTO" && h.eventoId === "bly:MC2"));
  assert.equal(s.pedidos.length, 1, "o esclarecimento reaproveita a leitura: nenhuma chamada nova à IA");
  await s.enviar(msg({ id: "MC3", texto: "Alfa" }));
  assert.equal((await s.propostas(ALFA)).length, 1, "a pendência já foi consumida: nada é lançado de novo");
  assert.equal((await s.propostas(GAMA)).length, 0);
});

t("15A memória curta: outro participante, prazo vencido, texto com números ou unidade ambígua NÃO retomam a pendência", async () => {
  // 1ª chamada lê a despesa sem unidade; as seguintes (se houver) são conversa — o teste mede só a RETOMADA indevida.
  const leitura = () => { let n = 0; return () => (++n === 1 ? comprovante({ valorCentavos: 9500, dataPagamento: "2026-10-15", favorecido: null, unidadeSugerida: null }) : base({ intencao: "OUTRA" })); };
  // outro participante na mesma conversa
  const s1 = await cenario(leitura());
  await s1.enviar(msg({ id: "OP1", texto: "paguei 95 de limpeza hoje" }));
  await s1.enviar({ ...msg({ id: "OP2", texto: "alfa" }), participanteId: "5500000000999@s.whatsapp.net" });
  assert.equal((await s1.propostas(ALFA)).length, 0);
  // prazo vencido
  const s2 = await cenario(leitura());
  await s2.enviar(msg({ id: "PV1", texto: "paguei 95 de limpeza hoje" }));
  await s2.pool.query("update mova.mensagem_pendente set criada_em = now() - interval '11 minutes'");
  await s2.enviar(msg({ id: "PV2", texto: "alfa" }));
  assert.equal((await s2.propostas(ALFA)).length, 0);
  // texto com número e texto ambíguo
  for (const texto of ["alfa 95", "alfa ou gama", "MOVA, paguei a conta de luz da alfa."]) {
    const s3 = await cenario(leitura());
    await s3.enviar(msg({ id: `AM${texto.length}a`, texto: "paguei 95 de limpeza hoje" }));
    await s3.enviar(msg({ id: `AM${texto.length}b`, texto }));
    assert.ok(!(await s3.mova.armazenamento.historico.todos()).some((h) => h.motivo === "ESCLARECIMENTO_POR_CONTEXTO"), texto);
  }
});

t("15A G-1: resposta INCERTA do Gateway (tempo esgotado, 5xx, 2xx sem id) nunca é repetida — FALHOU para revisão, sem mensagem duplicada", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: "G1", texto: "r", eventoId: null });
  let chamadas = 0;
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], maxTentativas: 5,
    enviar: async () => { chamadas += 1; throw Object.assign(new Error("timeout"), { codigo: "ENVIO_INCERTO" }); } });
  await e.enviarPendentes(); await e.enviarPendentes(); await e.enviarPendentes();
  assert.equal(chamadas, 1);
  const { rows } = await s.pool.query("select estado, ultimo_erro from mova.resposta");
  assert.deepEqual([rows[0].estado, rows[0].ultimo_erro], ["FALHOU", "ENVIO_INCERTO"]);
});

t("15A G-1: o canal classifica tempo esgotado, 5xx e 2xx sem id como ENVIO_INCERTO; conexão recusada como repetível", async () => {
  const { criarEnvioPeloCanal } = await import("../../src/modules/fv2-integracao/mova.js");
  const seg = "s".repeat(40);
  const caso = async (fetchFn) => { try { await criarEnvioPeloCanal({ gatewayUrl: "https://gw", segredo: seg, fetchFn, timeoutMs: 20 })({ grupoId: CONTATO, texto: "t", idempotencia: "k" }); return "OK"; } catch (x) { return x.codigo; } };
  assert.equal(await caso((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))), "ENVIO_INCERTO");
  assert.equal(await caso(async () => { throw new TypeError("fetch failed"); }), "GATEWAY_INALCANCAVEL");
  assert.equal(await caso(async () => ({ ok: false, status: 502, json: async () => ({}) })), "ENVIO_INCERTO");
  assert.equal(await caso(async () => ({ ok: true, status: 200, json: async () => ({}) })), "ENVIO_INCERTO");
  assert.equal(await caso(async () => ({ ok: false, status: 409, json: async () => ({ error: "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED" }) })), "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED");
  assert.equal(await caso(async () => ({ ok: true, status: 200, json: async () => ({ providerMessageId: "P1" }) })), "OK");
});

t("15H H-1: saudação e pergunta de funcionamento ⇒ ORIENTACAO sem IA e sem pedir unidade; saudação+consulta e pedido sem unidade seguem normais", async () => {
  for (const texto of ["Olá MOVA, você está funcionando?", "Oi MOVA", "Bom dia", "O que você faz?"]) {
    const s = await cenario(() => { throw new Error("a IA não deveria ser chamada"); });
    await s.enviar(msg({ texto }));
    const h = await s.ultima();
    assert.deepEqual([h.decisao, h.motivo, s.pedidos.length], [DECISAO.ORIENTACAO, "SAUDACAO", 0], texto);
    assert.doesNotMatch((await s.mova.armazenamento.saida.listar()).at(-1).texto, /pertence à/, texto);
  }
  // saudação seguida de consulta financeira: vai à IA e responde a consulta
  const c = await cenario(() => base({ intencao: "CONSULTAR", consulta: "CONTAS_A_PAGAR_ABERTAS", unidadeSugerida: "Unidade Teste Alfa" }));
  await c.enviar(msg({ texto: "Oi MOVA, quais contas a pagar estão abertas na alfa?" }));
  assert.deepEqual([(await c.ultima()).decisao, c.pedidos.length], [DECISAO.CONSULTA, 1]);
  // pedido financeiro sem unidade: continua perguntando a unidade
  const p = await cenario(() => comprovante({ valorCentavos: 9500, dataPagamento: "2026-10-15", favorecido: null, unidadeSugerida: null }));
  await p.enviar(msg({ texto: "Bom dia, paguei 95 de limpeza hoje" }));
  assert.equal((await p.ultima()).motivo, "UNIDADE_NAO_IDENTIFICADA");
});

t("15H H-1: a IA devolver CONSULTAR sem assunto (caso real) ⇒ ORIENTACAO, nunca pergunta de unidade", async () => {
  const s = await cenario(() => base({ intencao: "CONSULTAR", consulta: null }));
  await s.enviar(msg({ texto: "MOVA, está tudo certo com o sistema hoje?" }));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo, s.pedidos.length], [DECISAO.ORIENTACAO, "CONVERSA_SEM_PEDIDO_FINANCEIRO", 1]);
});

t("15I teto da sessão: com maximoDeEnvios=1 só a primeira resposta sai; a excedente vira FALHOU (TETO), visível, e nada mais é reservado", async () => {
  const s = await cenario(() => base({ intencao: "OUTRA" }));
  for (const n of [1, 2]) await s.mova.armazenamento.saida.enfileirar({ grupoId: CONTATO, respostaA: `T${n}`, texto: `r${n}`, eventoId: null });
  const enviados = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [CONTATO], maximoDeEnvios: 1,
    enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: `PT${enviados.length}` }; } });
  await e.enviarPendentes(); await e.enviarPendentes();
  // Agente 2: a única resposta permitida sai COM o aviso de que o limite foi atingido (nunca interrupção silenciosa).
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /^r1\n\n⚠️ Limite de respostas do MOVA atingido \(1 de 1\)/);
  const { rows } = await s.pool.query("select estado, ultimo_erro from mova.resposta order by seq");
  assert.deepEqual(rows.map((r) => r.estado + "/" + (r.ultimo_erro ?? "")), ["ENVIADA/", "FALHOU/TETO_DE_ENVIOS_DA_SESSAO"]);
  const { lerConfiguracaoMova } = await import("../../src/modules/fv2-integracao/mova.js");
  const base_ = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "x", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
  assert.equal(lerConfiguracaoMova({ ...base_, MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_PROCESSAMENTO_HABILITADO: "1", MOVA_ENVIO_HABILITADO: "1", MOVA_ENVIO_NAO_ANTES_DE: "2026-11-21T00:00:00Z", MOVA_RELE_DATABASE_URL: "x", MOVA_GATEWAY_SECRET: "s".repeat(40), MOVA_ENVIO_MAXIMO: "abc" }).envioMaximo, 0, "inválido ⇒ nada sai");
});
