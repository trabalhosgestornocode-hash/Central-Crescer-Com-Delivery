// MOVA — Agente 2 (23/11/2026): rotina dos entregadores PONTA A PONTA sem rede e sem banco — segunda 10h (fechamento + frase da
// nota fiscal, por empresa e unidade), leitura/conferência da NFS-e (nunca libera sozinha), aviso de liberação no grupo da
// unidade (1ª passada só registra o que já estava liberado) e relatório de quarta 8h; cadastro pelo gestor (rota da Central).
// Financeiro SIMULADO (porta de leitura), armazenamento em memória, IA simulada. Tudo sintético; nada sai para o WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarEntregadoresMova, AUTOMACAO } from "../../src/modules/mova-financeiro/aplicacao/entregadoresMova.js";
import { criarArmazenamentoMemoria } from "../../src/modules/mova-financeiro/infra/memoria.js";
import { FRASE_NOTA_FISCAL, conferirNotaDoEntregador, normalizarTelefoneBr, relatorioDeQuarta } from "../../src/modules/mova-financeiro/dominio/entregadores.js";
import { ACOES_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { base } from "./helpers/operacao.js";

const ORG = "eeeeeeee-0000-4000-8000-0000000000f1";
const ALFA = "eeeeeeee-0000-4000-8000-0000000000a1";
const BETA = "eeeeeeee-0000-4000-8000-0000000000b1";
const GRUPO_ALFA = "120363000000000001@g.us";
const GRUPO_MISTO = "120363000000000002@g.us";
const PRIV = "5585999990011@s.whatsapp.net";
const ENT = { organizacaoId: ORG, unidadeId: ALFA, chave: "ent-sint-1", telefoneE164: "+5585999990011", privado: PRIV, nome: "Entregador Sintético Um", ativo: true, ids: [] };
const CFG = Object.freeze({
  identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [{ organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Alfa Sintética", empresa: "Empresa Alfa Sintética", documentos: ["11222333000181"] },
    { organizacaoId: ORG, unidadeId: BETA, nome: "Loja Beta Sintética", empresa: null, documentos: [] }],
  gruposAutorizados: [
    { grupoId: GRUPO_ALFA, unidades: [ALFA], privada: false, politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ telefones: ["+5585999990001"] }] },
    { grupoId: GRUPO_MISTO, unidades: [ALFA, BETA], privada: false, politicaResposta: "GRUPO_FINANCEIRO", participantes: [] },
    { grupoId: PRIV, unidades: [ALFA], privada: true, entregador: { chave: ENT.chave, unidadeId: ALFA, nome: ENT.nome }, participantes: [] },
  ],
  entregadores: [ENT],
});
const F = (x = {}) => ({ semanaInicio: "2026-11-16", semanaFim: "2026-11-22", prazoDaNota: "2026-11-24", vencimento: "2026-11-25", entregas: 30, valorCentavos: 45000,
  ajustesCentavos: 0, situacaoDocumental: "AGUARDANDO_NF", situacaoPagamento: "A_VENCER", duplicidade: null, entregador: { chave: ENT.chave, nome: ENT.nome }, ...x });

function montar({ fechamentos = [F()], extrator = null, agora = "2026-11-23T13:00:00Z", cfg = CFG } = {}) {
  const relogio = { t: new Date(agora) };
  const a = criarArmazenamentoMemoria({ relogio: () => relogio.t });
  const enviados = [];
  const armazenamento = { ...a, saida: { ...a.saida, async enfileirar(r) { enviados.push(r); return a.saida.enfileirar(r); } } };
  const dados = { fechamentos };
  const porta = { async ler(nome, escopo, args) {
    const daUnidade = dados.fechamentos.filter(() => escopo.unidadeId === ALFA);
    if (nome === "detalharFechamentoDoEntregador") { const f = daUnidade.find((x) => x.semanaInicio === args.inicio && x.entregador.chave === args.entregador); if (!f) throw Object.assign(new Error("x"), { codigo: "FV2_NAO_ENCONTRADO" }); return f; }
    if (nome === "consultarEntregador") return { fechamentos: daUnidade.filter((x) => x.entregador.chave === args.entregador) };
    if (nome === "consultarEntregadoresProprios") return { fechamentos: daUnidade };
    throw new Error(`leitura inesperada ${nome}`);
  } };
  const e = criarEntregadoresMova({ cfg, porta, armazenamento, extrator, obterEvidencia: async () => new Uint8Array([37, 80, 68, 70]), relogio: () => relogio.t });
  const ligar = async (nome, horario) => a.automacoes.definir({ nome, organizacaoId: ORG, unidadeId: ALFA, ativa: true, horario });
  return { e, a, enviados, dados, relogio, ligar };
}

test("E1 segunda 10h (Fortaleza): fechamento da semana anterior com empresa, unidade e a FRASE obrigatória; uma vez só; antes das 10h nada", async () => {
  const s = montar({ agora: "2026-11-23T12:59:00Z" }); // 09:59 em Fortaleza
  await s.ligar(AUTOMACAO.SEMANAL, "10:00");
  assert.equal((await s.e.rotina()).semanais, 0);
  s.relogio.t = new Date("2026-11-23T13:00:00Z"); // 10:00
  assert.equal((await s.e.rotina()).semanais, 1);
  const [m] = s.enviados;
  assert.equal(m.grupoId, PRIV, "só no privado do próprio entregador");
  assert.match(m.texto, /semana 16\/11\/2026 a 22\/11\/2026/);
  assert.match(m.texto, /Empresa: Empresa Alfa Sintética — Unidade: Loja Alfa Sintética/);
  assert.ok(m.texto.includes(FRASE_NOTA_FISCAL));
  assert.equal((await s.e.rotina()).semanais, 0, "não repete");
  s.relogio.t = new Date("2026-11-24T13:00:00Z"); // terça
  assert.equal((await s.e.rotina()).semanais, 0);
  assert.equal(s.enviados.length, 1);
});

test("E2 sem fechamento oficial da semana: nada é enviado (não inventa valor)", async () => {
  const s = montar({ fechamentos: [F({ semanaInicio: "2026-11-09", semanaFim: "2026-11-15" })] });
  await s.ligar(AUTOMACAO.SEMANAL, "10:00");
  const r = await s.e.rotina();
  assert.deepEqual([r.semanais, r.pulados], [0, ["SEM_FECHAMENTO"]]);
  assert.equal(s.enviados.length, 0);
});

test("E3 nota do entregador: IA lê, confere com o fechamento e responde; NUNCA libera; divergência e falha de leitura ficam para revisão", async () => {
  const NOTA = (x = {}) => base({ tipoDocumento: "NOTA_FISCAL", intencao: "OUTRA", valorCentavos: 45000, competencia: "2026-11", dataEmissao: "2026-11-23", favorecido: "Entregador Sintético Um",
    pagador: "Empresa Alfa Sintética", documentoDestinatario: "11.222.333/0001-81", identificadorDocumento: "123", confianca: "ALTA", ...x });
  const evento = (sha) => ({ eventoId: `ev-${sha}`, texto: "nota", tipo: "documento", midia: { mime: "application/pdf", referencia: "mova/evidencias/sint", sha256: sha.repeat(64) } });
  const grupo = CFG.gruposAutorizados[2];
  const ok = montar({ extrator: { async extrair() { return NOTA(); } } });
  const r1 = await ok.e.atender(evento("a"), grupo);
  assert.equal(r1.decisao, "PROPOSTA", "sem identidade operacional: fica pendente de anexo (nada escrito no Financeiro)");
  assert.match(r1.resposta, /os dados conferem com o fechamento/);
  const [n1] = await ok.a.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.equal(n1.conferencia, "CONFERE");
  assert.equal(ok.dados.fechamentos[0].situacaoDocumental, "AGUARDANDO_NF", "a liberação continua sendo do Financeiro");

  const div = montar({ extrator: { async extrair() { return NOTA({ valorCentavos: 40000 }); } } });
  const r2 = await div.e.atender(evento("b"), grupo);
  assert.match(r2.resposta, /divergência: valor diferente do fechamento/);
  assert.ok(r2.resposta.includes(FRASE_NOTA_FISCAL));
  assert.equal((await div.a.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA }))[0].conferencia, "DIVERGENTE");

  let chamadas = 0;
  const sem = montar({ extrator: { async extrair() { chamadas++; throw Object.assign(new Error("x"), { codigo: "ORCAMENTO_ESGOTADO" }); } } });
  const r3 = await sem.e.atender(evento("c"), grupo);
  assert.match(r3.resposta, /ficou em análise/);
  assert.equal((await sem.a.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA }))[0].conferencia, "INCONCLUSIVA");
  await sem.e.atender(evento("c"), grupo); // mesma nota de novo: não lê de novo (não gasta orçamento)
  assert.equal(chamadas, 1);
});

test("E4 aviso no grupo: 1ª passada só registra o já liberado; nova liberação → um aviso, só no grupo EXCLUSIVO da unidade; sem repetição", async () => {
  const s = montar({ fechamentos: [F({ semanaInicio: "2026-11-09", semanaFim: "2026-11-15", situacaoDocumental: "LIBERADO_PAGAMENTO" }), F()] });
  await s.ligar(AUTOMACAO.AVISO_GRUPO, "00:00");
  assert.equal((await s.e.rotina()).avisos, 0, "linha de base: nada retroativo");
  assert.equal(s.enviados.length, 0);
  s.dados.fechamentos[1] = F({ situacaoDocumental: "LIBERADO_PAGAMENTO" });
  assert.equal((await s.e.rotina()).avisos, 1);
  const [m] = s.enviados;
  assert.equal(m.grupoId, GRUPO_ALFA, "nunca no grupo de várias unidades");
  assert.match(m.texto, /Entregador Sintético Um — semana 16\/11\/2026 a 22\/11\/2026 — R\$ 450,00/);
  assert.match(m.texto, /Pagamento bancário ainda não registrado/);
  assert.equal((await s.e.rotina()).avisos, 0);
});

test("E5 unidade SEM grupo exclusivo (só grupo misto): aviso e relatório não saem", async () => {
  const cfg = { ...CFG, gruposAutorizados: CFG.gruposAutorizados.filter((g) => g.grupoId !== GRUPO_ALFA) };
  const s = montar({ cfg, agora: "2026-11-25T11:00:00Z" });
  await s.ligar(AUTOMACAO.RELATORIO, "08:00");
  const r = await s.e.rotina();
  assert.deepEqual([r.relatorios, s.enviados.length], [0, 0]);
  assert.ok(r.pulados.includes("SEM_GRUPO_DA_UNIDADE"));
});

test("E6 quarta 8h: relatório por empresa/unidade (liberados, sem nota, em análise, divergência, pagos e totais), uma vez por dia", async () => {
  const fechamentos = [
    F({ entregador: { chave: "a", nome: "Ana Sintética" }, situacaoDocumental: "LIBERADO_PAGAMENTO", valorCentavos: 10000 }),
    F({ entregador: { chave: "b", nome: "Bia Sintética" }, valorCentavos: 20000 }),
    F({ entregador: { chave: "c", nome: "Caio Sintético" }, situacaoDocumental: "NF_EM_CONFERENCIA", valorCentavos: 30000 }),
    F({ entregador: { chave: "d", nome: "Davi Sintético" }, situacaoDocumental: "NF_REJEITADA", valorCentavos: 40000 }),
    F({ entregador: { chave: "e", nome: "Eva Sintética" }, situacaoDocumental: "LIBERADO_PAGAMENTO", situacaoPagamento: "PAGO", valorCentavos: 50000 }),
  ];
  const s = montar({ fechamentos, agora: "2026-11-25T10:59:00Z" });
  await s.ligar(AUTOMACAO.RELATORIO, "08:00");
  assert.equal((await s.e.rotina()).relatorios, 0, "07:59");
  s.relogio.t = new Date("2026-11-25T11:00:00Z");
  assert.equal((await s.e.rotina()).relatorios, 1);
  const t = s.enviados[0].texto;
  assert.equal(s.enviados[0].grupoId, GRUPO_ALFA);
  for (const re of [/Empresa: Empresa Alfa Sintética — Unidade: Loja Alfa Sintética/, /Liberados: 1/, /Sem nota: 1/, /Notas em análise: 1/, /Notas com divergência: 1/, /Pagamentos realizados: 1/,
    /Total liberado \(a pagar\): R\$ 100,00/, /Total pendente: R\$ 900,00/, /Total pago: R\$ 500,00/]) assert.match(t, re);
  assert.equal((await s.e.rotina()).relatorios, 0, "uma vez por dia");
});

test("E7 conferência pura: CNPJ do tomador diferente = divergente; sem CNPJ cadastrado e tomador por nome = confere; emitente outro = divergente", () => {
  const f = F();
  const l = { tipoDocumento: "NOTA_FISCAL", legivel: true, valorCentavos: 45000, competencia: "2026-11", favorecido: "Entregador Sintetico Um", pagador: "Empresa Alfa Sintética", documentoDestinatario: "99.999.999/0001-99", confianca: "ALTA" };
  assert.deepEqual(conferirNotaDoEntregador({ leitura: l, fechamento: f, cnpjTomador: "11222333000181" }).motivos, ["TOMADOR_DIFERENTE"]);
  assert.equal(conferirNotaDoEntregador({ leitura: l, fechamento: f, empresa: "Empresa Alfa Sintética" }).resultado, "CONFERE");
  assert.equal(conferirNotaDoEntregador({ leitura: { ...l, favorecido: "Outra Pessoa Qualquer" }, fechamento: f, empresa: "Empresa Alfa Sintética" }).resultado, "DIVERGENTE");
  assert.equal(conferirNotaDoEntregador({ leitura: { ...l, tipoDocumento: "RECIBO" }, fechamento: f }).resultado, "INCONCLUSIVA");
  assert.equal(conferirNotaDoEntregador({ leitura: l, fechamento: f, empresa: "Empresa Alfa Sintética" }).situacaoFiscal, "NAO_CONSULTADA");
  assert.equal(relatorioDeQuarta({ unidade: "U", fechamentos: [], hoje: "2026-11-25" }).includes("Total pendente: R$ 0,00"), true);
});

test("E8 cadastro pelo gestor: exige configurar, entregador OFICIAL da unidade, número válido e fora da equipe; sem duplicar; auditado", async () => {
  assert.deepEqual(normalizarTelefoneBr("(85) 99999-0011"), { telefoneE164: "+5585999990011", privado: "5585999990011@s.whatsapp.net" });
  assert.equal(normalizarTelefoneBr("85 8999-0011 1"), null);
  const a = criarArmazenamentoMemoria();
  const mova = { armazenamento: a, cfg: CFG };
  const nucleo = { async consultarEntregador(_c, { entregador }) { if (entregador !== "ent-sint-2") throw Object.assign(new Error("x"), { codigo: "FV2_NAO_ENCONTRADO" }); return { fechamentos: [F({ entregador: { chave: "ent-sint-2", nome: "Entregador Dois" } })] }; } };
  const ctx = { organizacaoId: ORG, unidadeId: ALFA, usuarioId: "eeeeeeee-0000-4000-8000-000000000001", permissoes: ["financeiro_v2.ver", "financeiro_v2.configurar"] };
  const acao = ACOES_MOVA["/mova/entregador"];
  const tenta = (b, c = ctx) => executarAcaoMova(acao, { ctx: c, mova, nucleo, b });
  await assert.rejects(tenta({ entregador: "ent-sint-2", telefone: "85999990022" }, { ...ctx, permissoes: ["financeiro_v2.ver"] }), (e) => e.codigo === "PERMISSAO_INSUFICIENTE");
  await assert.rejects(tenta({ entregador: "inventado", telefone: "85999990022" }), (e) => e.codigo === "ENTREGADOR_NAO_ENCONTRADO");
  await assert.rejects(tenta({ entregador: "ent-sint-2", telefone: "123" }), (e) => e.codigo === "PARAMETRO_INVALIDO");
  await assert.rejects(tenta({ entregador: "ent-sint-2", telefone: "85 99999-0001" }), (e) => e.codigo === "NUMERO_DA_EQUIPE");
  const r = await tenta({ entregador: "ent-sint-2", telefone: "(85) 99999-0022" });
  assert.deepEqual([r.entregador, r.nome, r.telefone, r.vigencia], ["ent-sint-2", "Entregador Dois", "…0022", "APOS_REINICIO_DO_MOVA"]);
  await assert.rejects(tenta({ entregador: "ent-sint-2", telefone: "(85) 99999-0033" }), (e) => e.codigo === "ENTREGADOR_OU_NUMERO_JA_CADASTRADO");
  assert.ok((await a.auditoria.listar()).some((x) => x.acao === "ENTREGADOR_CADASTRADO" && x.alvo === "ent-sint-2"));
  const rv = await executarAcaoMova(ACOES_MOVA["/mova/entregador-revogar"], { ctx, mova, b: { entregador: "ent-sint-2" } });
  assert.equal(rv.revogado, true);
  assert.equal((await tenta({ entregador: "ent-sint-2", telefone: "(85) 99999-0033" })).telefone, "…0033", "depois de revogar, pode cadastrar outro número");
});
