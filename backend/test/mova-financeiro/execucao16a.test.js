// MOVA — Execução 16A: PILOTO de consultas (uma unidade, conversa privada, só leitura). Tudo SINTÉTICO: Financeiro v2 real em
// memória com dados fictícios, banco do MOVA no PostgreSQL local isolado, IA SIMULADA (sem rede, sem chave, sem custo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, TODAS, ctx, montar } from "../financeiro-v2/helpers/cenario.js";
import { DECISAO, ErroDeIa, clienteComOrcamento, criarControle, criarExtratorAnthropic, criarMova, instalarConfiguracao, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { exigirEscopoDoPiloto, lerConfiguracaoMova, montarMova } from "../../src/modules/fv2-integracao/mova.js";
import { IDENTIDADE_MOVA } from "../../src/modules/fv2-integracao/leitorMova.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);

const ORG = "dddddddd-0000-4000-8000-000000000016";
const PILOTO = "dddddddd-0000-4000-8000-0000000016a1"; // unidade do piloto (sintética)
const ORG_OUTRA = "dddddddd-0000-4000-8000-000000000099"; // outra EMPRESA, com dados, fora do piloto
const OUTRA = "dddddddd-0000-4000-8000-0000000099b1";
const CONVERSA = "5500000000016@s.whatsapp.net"; // conversa privada sintética (DDD 00 não existe)
const ESCOPOS = [{ organizacaoId: ORG, unidadeId: PILOTO }, { organizacaoId: ORG_OUTRA, unidadeId: OUTRA }];
const CONFIG = {
  modo: "PILOTO", identidadeServico: { usuarioId: IDENTIDADE_MOVA },
  unidades: [{ organizacaoId: ORG, unidadeId: PILOTO, nome: "Unidade Piloto", apelidos: ["piloto"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"], anotaAiPelaSaipos: true } }],
  gruposAutorizados: [{ grupoId: CONVERSA, unidades: [PILOTO] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
const base = (extra) => ({
  legivel: true, tipoDocumento: "OUTRO", intencao: "OUTRA", unidadeSugerida: null, documentoDestinatario: null, valorCentavos: null, dataPagamento: null, dataEmissao: null,
  vencimento: null, competencia: null, favorecido: null, identificadorDocumento: null, categoriaSugerida: null, natureza: null, consulta: null, confianca: "ALTA",
  camposAusentes: [], incertezas: [], justificativa: "sintético", referenciasDocumentais: [], periodoInicio: null, periodoFim: null, todasUnidades: false, transcricao: null, ...extra,
});
const consulta = (c, extra = {}) => base({ intencao: "CONSULTAR", consulta: c, ...extra });

let seq = 0;
const gw = ({ id = `E16A${String(++seq).padStart(6, "0")}`, texto = null, doc = null, conversa = CONVERSA } = {}) => ({
  contratoMova: 1, eventoId: `bly:${id}`, mensagemId: id, grupoId: conversa, participanteId: conversa, telefoneE164: null, nomeExibicao: "Pessoa Sintética", fromMe: false,
  tipo: doc ? "DOCUMENTO" : "TEXTO", texto, respostaA: null, midia: doc ? { mime: "application/pdf", nomeArquivo: null, tamanhoBytes: doc.length, base64: Buffer.from(doc).toString("base64") } : null,
  recebidoEm: AGORA.toISOString(), origemTipo: "LIVE",
});
function clienteSimulado(responder) {
  const pedidos = [];
  return { pedidos, beta: { messages: { async create(req) { pedidos.push(req); const r = await responder(req, pedidos.length); return { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }] }; } } } };
}

async function cenario({ responder = () => base({}), falharFinanceiro = false, cliente: clienteDado = null } = {}) {
  const m = montar({ escopos: ESCOPOS });
  const c = (org, u) => ctx(org, u, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  const venda = async (org, u, valor, n) => {
    const caixa = await m.nucleo.configurarContaFinanceira(c(org, u), { tipo: "CAIXA_FISICO", nome: `Caixa ${n}` });
    return m.nucleo.registrarVenda(c(org, u), { canal: "BALCAO", dataVenda: "2026-10-14", brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: `V-16A-${n}` }, composicao: { itensCentavos: valor }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: valor, contaId: caixa.id }] });
  };
  const banco = await criarBancoMova();
  await instalarConfiguracao(banco.pool, validarConfiguracao(CONFIG));
  const cliente = clienteDado ?? clienteSimulado(responder);
  const chamadas = []; // cada leitura que o MOVA fez no Financeiro: operação + escopo
  const nucleo = Object.fromEntries(Object.entries(m.nucleo).map(([nome, op]) => [nome, async (cx, ...a) => {
    chamadas.push({ nome, organizacaoId: cx?.organizacaoId, unidadeId: cx?.unidadeId, usuarioId: cx?.usuarioId, permissoes: cx?.permissoes });
    if (falharFinanceiro) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return op(cx, ...a);
  }]));
  const ref = {};
  const controle = criarControle({ pool: banco.pool, cacheMs: 0 });
  const extrator = criarExtratorAnthropic({ cliente, obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio: () => AGORA });
  ref.mova = criarMova({ configuracao: CONFIG, nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, extrator, pool: banco.pool, relogio: () => AGORA, controle, somenteConsultas: true });
  const mova = ref.mova;
  const enviar = async (p) => { const r = await mova.receptor.receber(p); await mova.receptor.trabalhar(); return r; };
  const ultima = async () => (await mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1); // 26/11: a decisão da operação (a resposta que a retomou vem depois, como RELACIONADA)
  const respostas = async () => (await mova.armazenamento.saida.listar()).map((r) => r.texto);
  return { m, venda, banco, cliente, chamadas, mova, enviar, ultima, respostas, controle };
}
const ligarTudo = (pool) => pool.query("update mova.controle set processamento = true, ia = true, recebimento = true, envio = false, suspenso = false where id");

t("16A-01 consulta autorizada: faturamento da competência com composição por canal, situação, fonte e posição do Financeiro", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO", { competencia: "2026-10" }) });
  await ligarTudo(s.banco.pool);
  await s.venda(ORG, PILOTO, 25000, 1);
  await s.enviar(gw({ texto: "quanto a unidade faturou em outubro?" }));
  const [txt] = await s.respostas();
  assert.match(txt, /Unidade Piloto/);
  assert.match(txt, /R\$\s?250,00/);
  assert.match(txt, /Balcão: R\$\s?250,00 \(/, "linha do canal com fonte/situação entre parênteses");
  assert.match(txt, /comprovado|sem comprovação/);
  // Canal sem nenhum registro nunca aparece como "R$ 0,00 comprovado": é ausência de dado.
  assert.match(txt, /iFood: sem dados registrados \(relatório oficial do iFood\) — não é zero confirmado/);
  assert.doesNotMatch(txt, /iFood: R\$/);
  assert.match(txt, /Posição do Financeiro em \d{2}\/\d{2}/);
  assert.equal((await s.ultima()).decisao, DECISAO.CONSULTA);
});

t("16A-02 conversa NÃO autorizada: nada é lido, guardado nem respondido; Financeiro intocado", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO") });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "quanto faturou?", conversa: "5500000000777@s.whatsapp.net" }));
  assert.deepEqual(await s.respostas(), []);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.cliente.pedidos.length, 0, "nem a IA é chamada");
});

t("16A-03 dados ausentes: sem vendas registradas ⇒ informa a limitação e NÃO estima", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO", { competencia: "2026-10" }) });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "faturamento de outubro?" }));
  const [txt] = await s.respostas();
  assert.match(txt, /não há dados suficientes/i);
  assert.match(txt, /Não vou estimar/);
  assert.doesNotMatch(txt, /R\$/);
});

t("16A-04 valores não conciliados: conta a pagar aberta aparece como aberta (pagamento registrado ≠ conciliado)", async () => {
  const s = await cenario({ responder: () => consulta("CONTAS_A_PAGAR_ABERTAS") });
  await ligarTudo(s.banco.pool);
  const c = ctx(ORG, PILOTO, TODAS, "eeeeeeee-0000-4000-8000-000000000001");
  const f = await s.m.nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  await s.m.nucleo.registrarObrigacao(c, { contraparteId: f.id, valorOriginalCentavos: 48000, categoria: "INSUMOS", descricao: "Compra sintética", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30" });
  await s.enviar(gw({ texto: "quanto tenho a pagar?" }));
  const [txt] = await s.respostas();
  assert.match(txt, /a pagar em aberto: 1 conta, R\$\s?480,00/);
});

t("16A-05 unidade/empresa erradas: todas as leituras usam SÓ a unidade do piloto, identidade do MOVA e só 'ver'; dado da outra empresa nunca aparece", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO", { competencia: "2026-10", todasUnidades: true, unidadeSugerida: OUTRA }) });
  await ligarTudo(s.banco.pool);
  await s.venda(ORG, PILOTO, 25000, 1);
  await s.venda(ORG_OUTRA, OUTRA, 777700, 2); // outra empresa: R$ 7.777,00
  await s.enviar(gw({ texto: "quanto faturaram todas as unidades em outubro?" }));
  const [txt] = await s.respostas();
  assert.doesNotMatch(txt, /7\.777/);
  assert.ok(s.chamadas.length > 0);
  for (const ch of s.chamadas) {
    assert.equal(ch.unidadeId, PILOTO, `${ch.nome} leu outra unidade`);
    assert.equal(ch.organizacaoId, ORG);
    assert.equal(ch.usuarioId, IDENTIDADE_MOVA);
    assert.deepEqual(ch.permissoes, [ACAO.VER], "o MOVA nunca leva mais que 'ver'");
  }
});

t("16A-06 rastreabilidade: todo valor em R$ da resposta existe no que o Financeiro devolveu (nada inventado)", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO", { competencia: "2026-10" }) });
  await ligarTudo(s.banco.pool);
  await s.venda(ORG, PILOTO, 12345, 1);
  await s.venda(ORG, PILOTO, 10000, 2);
  await s.enviar(gw({ texto: "faturamento de outubro" }));
  const [txt] = await s.respostas();
  const valores = [...txt.matchAll(/R\$\s?([\d.]+,\d{2})/g)].map((x) => x[1]);
  assert.ok(valores.length >= 2);
  const vendas = await s.m.nucleo.consultarVendas(ctx(ORG, PILOTO, [ACAO.VER], IDENTIDADE_MOVA), { inicio: "2026-10-01", fim: "2026-10-15" });
  const permitidos = new Set([vendas.resumo.brutoProprioCentavos, ...(vendas.resumo.dre?.porCanal ?? []).map((x) => x.valorCentavos), vendas.resumo.recebidoComprovadoCentavos]
    .filter((v) => typeof v === "number").map((v) => (v / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })));
  for (const v of valores) assert.ok(permitidos.has(v), `valor ${v} não veio do Financeiro`);
});

t("16A-07 falha na conexão financeira: nenhuma resposta com número; o evento volta para nova tentativa (transitório)", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO", { competencia: "2026-10" }), falharFinanceiro: true });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "faturamento de outubro" }));
  const rs = await s.respostas();
  assert.ok(rs.every((x) => !/R\$/.test(x)), "nenhum valor sai sem o Financeiro");
  const { rows: [f] } = await s.banco.pool.query("select estado, tentativas from mova.fila order by criado_em desc limit 1");
  assert.ok(["PENDENTE", "FALHOU"].includes(f.estado));
  assert.ok(f.tentativas >= 1);
});

t("16A-08 sem orçamento de IA: nada é chamado no provedor, nenhuma estimativa; resposta pede nova tentativa", async () => {
  const provedor = clienteSimulado(() => consulta("FATURAMENTO"));
  const semOrcamento = clienteComOrcamento(provedor, { orcamento: { async reservar() { throw new ErroDeIa("ORCAMENTO_ESGOTADO"); } } });
  const s = await cenario({ cliente: semOrcamento });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "quanto faturei em outubro?" }));
  assert.equal(provedor.pedidos.length, 0, "o provedor nunca recebe a chamada");
  const [txt] = await s.respostas();
  assert.doesNotMatch(txt, /R\$/);
  assert.match(txt, /pausadas/); assert.doesNotMatch(txt, /Reenvie/, "não pede para reenviar (não é erro de quem escreveu)");
  assert.equal(s.chamadas.length, 0, "sem interpretação, o Financeiro nem é consultado");
});

t("16A-09 suspensão: com o processamento desligado nada é lido nem respondido; religado, processa uma vez", async () => {
  const s = await cenario({ responder: () => consulta("CONTAS_A_PAGAR_ABERTAS") });
  await s.banco.pool.query("update mova.controle set processamento = false, ia = true, recebimento = true, suspenso = false where id");
  await s.enviar(gw({ id: "E16ASUSP01", texto: "contas a pagar?" }));
  assert.deepEqual(await s.respostas(), []);
  assert.equal(s.cliente.pedidos.length, 0);
  await s.banco.pool.query("update mova.controle set processamento = true where id");
  await s.mova.receptor.trabalhar();
  assert.equal((await s.respostas()).length, 1);
});

t("16A-10 deduplicação: o mesmo evento entregue duas vezes gera UMA leitura, UMA chamada de IA e UMA resposta", async () => {
  const s = await cenario({ responder: () => consulta("CONTAS_A_PAGAR_ABERTAS") });
  await ligarTudo(s.banco.pool);
  const ev = gw({ id: "E16ADUP001", texto: "contas a pagar?" });
  await s.enviar(ev);
  await s.enviar(ev);
  assert.equal(s.cliente.pedidos.length, 1);
  assert.equal((await s.respostas()).length, 1);
});

t("16A-11 piloto só consulta: relato de pagamento NÃO vira proposta; documento NEM vai à IA", async () => {
  const s = await cenario({ responder: () => base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 12345, dataPagamento: "2026-10-10", favorecido: "Fornecedor Sintético" }) });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "paguei R$ 123,45 ao fornecedor hoje" }));
  assert.equal((await s.ultima()).motivo, "PILOTO_SOMENTE_CONSULTAS");
  assert.equal(s.cliente.pedidos.length, 1);
  await s.enviar(gw({ doc: new Uint8Array(Buffer.from("sintetico boleto")) }));
  assert.equal((await s.ultima()).motivo, "PILOTO_SOMENTE_CONSULTAS");
  assert.equal(s.cliente.pedidos.length, 1, "o documento não foi enviado à IA");
  assert.deepEqual(await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: PILOTO }), []);
  const rs = await s.respostas();
  assert.ok(rs.every((x) => /só respondo consultas/.test(x)));
});

t("16A-12 saudação no piloto: orientação de consultas, sem IA e sem oferecer lançamentos", async () => {
  const s = await cenario({ responder: () => consulta("FATURAMENTO") });
  await ligarTudo(s.banco.pool);
  await s.enviar(gw({ texto: "Olá MOVA, você está funcionando?" }));
  const [txt] = await s.respostas();
  assert.match(txt, /Neste piloto eu respondo consultas/);
  assert.doesNotMatch(txt, /proposta/);
  assert.equal(s.cliente.pedidos.length, 0);
});

// ------------------------------------------------------------------------------------------------ configuração do piloto
const ENV = {
  MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://mova@h/db", MOVA_SERVICO_USUARIO_ID: IDENTIDADE_MOVA, MOVA_MODO: "PILOTO", MOVA_AMBIENTE: "piloto",
  MOVA_HOMOLOGACAO_MARCADOR: "mova-homolog-teste-01", MOVA_FINANCEIRO_LEITURA_URL: "postgres://leitor@h/db", MOVA_PILOTO_UNIDADE_ID: PILOTO,
  FV2_APP_DATABASE_URL: "postgres://app@h/db",
};
test("16A-13 configuração PILOTO: completa liga só consultas; qualquer peça faltando ou trocada ⇒ desligado com o motivo", () => {
  const ok = lerConfiguracaoMova(ENV);
  assert.equal(ok.habilitado, true); assert.equal(ok.modo, "PILOTO"); assert.equal(ok.somenteConsultas, true); assert.equal(ok.pilotoUnidadeId, PILOTO);
  const motivo = (extra) => lerConfiguracaoMova({ ...ENV, ...extra }).contradicoes ?? [];
  assert.ok(motivo({ MOVA_FINANCEIRO_LEITURA_URL: "" }).includes("PILOTO_SEM_LEITOR"));
  assert.ok(motivo({ MOVA_FINANCEIRO_LEITURA_URL: ENV.FV2_APP_DATABASE_URL }).includes("PILOTO_LEITOR_COM_OUTRA_CREDENCIAL"), "nunca a credencial da aplicação");
  assert.ok(motivo({ MOVA_FINANCEIRO_LEITURA_URL: ENV.MOVA_DATABASE_URL }).includes("PILOTO_LEITOR_COM_OUTRA_CREDENCIAL"), "nem a do banco do MOVA");
  assert.ok(motivo({ OUTRO_DATABASE_URL: ENV.MOVA_FINANCEIRO_LEITURA_URL }).includes("PILOTO_LEITOR_COM_OUTRA_CREDENCIAL"), "nem a de qualquer outro banco");
  assert.ok(motivo({ MOVA_PILOTO_UNIDADE_ID: "" }).includes("PILOTO_SEM_UNIDADE"));
  assert.ok(motivo({ MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" }).includes("PILOTO_IDENTIDADE_DIFERENTE_DO_LEITOR"));
  assert.ok(motivo({ MOVA_AMBIENTE: "homologacao" }).includes("PILOTO_INCOMPLETO"));
  assert.ok(motivo({ MOVA_HOMOLOGACAO_MARCADOR: "" }).includes("MARCADOR_INVALIDO"), "o estado do MOVA continua exigindo o banco de homologação");
  assert.equal(lerConfiguracaoMova({ ...ENV, MOVA_MODO: "HOMOLOGACAO" }).habilitado, false, "sinais misturados não caem em outro modo");
});

test("16A-14 escopo do piloto: duas unidades, grupo, unidade diferente ou nenhuma conversa ⇒ recusa", () => {
  const cfg = validarConfiguracao(CONFIG);
  assert.doesNotThrow(() => exigirEscopoDoPiloto(cfg, PILOTO));
  const motivos = (c, u = PILOTO) => { try { exigirEscopoDoPiloto(c, u); return []; } catch (e) { return e.motivos; } };
  assert.deepEqual(motivos(cfg, OUTRA), ["PILOTO_UNIDADE_DIFERENTE"]);
  const duas = validarConfiguracao({ ...CONFIG, unidades: [...CONFIG.unidades, { ...CONFIG.unidades[0], unidadeId: OUTRA, organizacaoId: ORG_OUTRA, nome: "Outra", apelidos: ["outra"] }], gruposAutorizados: [{ grupoId: CONVERSA, unidades: [PILOTO, OUTRA] }] });
  assert.ok(motivos(duas).includes("PILOTO_EXIGE_UMA_UNIDADE"));
  const comGrupo = validarConfiguracao({ ...CONFIG, gruposAutorizados: [...CONFIG.gruposAutorizados, { grupoId: "120363000000000016@g.us", unidades: [PILOTO] }] });
  assert.ok(motivos(comGrupo).includes("PILOTO_COM_GRUPO"));
});

t("16A-15 montagem do piloto: banco do MOVA sem o marcador de homologação, ou leitor com escrita ⇒ não monta", async () => {
  const cfg = lerConfiguracaoMova(ENV);
  const { pool } = await criarBancoMova(); // banco local SEM o comentário MOVA_HOMOLOGACAO
  await assert.rejects(montarMova({ cfg, pool, repositorio: {}, verificarBancoFinanceiro: async () => {} }), (e) => e.codigo === "BANCO_NAO_E_DE_HOMOLOGACAO");
  const marcado = { query: async (sql, ...r) => (/shobj_description/.test(sql) ? { rows: [{ c: "MOVA_HOMOLOGACAO:mova-homolog-teste-01" }] } : pool.query(sql, ...r)) };
  const leitorComEscrita = async () => { throw Object.assign(new Error("x"), { codigo: "LEITOR_NAO_E_SOMENTE_LEITURA" }); };
  await assert.rejects(montarMova({ cfg, pool: marcado, repositorio: {}, verificarBancoFinanceiro: leitorComEscrita }), (e) => e.codigo === "LEITOR_NAO_E_SOMENTE_LEITURA");
});

test("16B zero sem cobertura conhecida (calendário do canal recusado por regra) também NÃO vira zero confirmado", async () => {
  const { criarFerramentas } = await import("../../src/modules/mova-financeiro/aplicacao/ferramentas.js");
  const regra = new Error("canal fora da unidade");
  const porta = {
    ehErroDeRegra: (e) => e === regra,
    ler: async (op) => {
      if (op === "consultarCalendarioDeFaturamento") throw regra;
      // 16C: a competência inteira responde pela DRE (apurarCompetencia); a lista de vendas fica para período parcial.
      if (op === "apurarCompetencia") return { indicadores: { FATURAMENTO_BRUTO_PROPRIO: { situacao: "PRELIMINAR", valorCentavos: 50000, porCanal: [{ canal: "BALCAO", valorCentavos: 50000, comprovado: false }, { canal: "IFOOD", valorCentavos: 0, comprovado: true }] } } };
      return { resumo: { operacoes: 3, brutoProprioCentavos: 50000, recebidoComprovadoCentavos: null, conferenciaComDre: null,
        dre: { situacao: "PRELIMINAR", porCanal: [{ canal: "BALCAO", valorCentavos: 50000, comprovado: false }, { canal: "IFOOD", valorCentavos: 0, comprovado: true }] } } };
    },
  };
  const f = criarFerramentas({ porta, armazenamento: {} });
  const r = await f.FATURAMENTO({}, { periodo: { inicio: "2026-10-01", fim: "2026-10-31", competencia: "2026-10" }, hoje: "2026-11-21" });
  const ifood = r.linhas.find((l) => l.startsWith("iFood"));
  assert.match(ifood, /sem dados registrados .*não é zero confirmado/);
  assert.doesNotMatch(ifood, /R\$|comprovado\)/);
  assert.match(r.linhas.find((l) => l.startsWith("Balcão")), /R\$\s?500,00 \(sem comprovação\)/);
  // Falha que NÃO é de regra (Financeiro fora) não é engolida: a consulta falha e nada é respondido com número.
  const fora = { ...porta, ehErroDeRegra: () => false };
  await assert.rejects(criarFerramentas({ porta: fora, armazenamento: {} }).FATURAMENTO({}, { periodo: { inicio: "2026-10-01", fim: "2026-10-31", competencia: "2026-10" }, hoje: "2026-11-21" }));
});
