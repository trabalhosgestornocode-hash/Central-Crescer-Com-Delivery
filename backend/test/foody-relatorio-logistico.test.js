// Fase D — bloco logístico Foody nos relatórios diário/semanal do Checklist. Só enfileiramento em memória: nada é enviado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "ficticio_service_role_key_0123456789abcdef";
process.env.SUPABASE_ANON_KEY ??= "ficticio_anon_key_0123456789abcdef0123";

const { enfileirarRelatoriosDaUnidade } = await import("../src/modules/notificacoes/notificacoes.relatorios.servico.js");
const { linhasLogisticaDiaria, linhasLogisticaSemanal, recebeValores } = await import("../src/modules/foody/foody.mensagem.js");
const { lerFechamentosFoody, textoComLogistica, logisticaFoodyPermitida } = await import("../src/modules/notificacoes/notificacoes.relatorios.foody.js");
const { validarMensagem, LIMITE_CARACTERES } = await import("../src/modules/checklist-operacional/checklistOperacional.whatsapp.js");

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "11111111-1111-4111-8111-111111111111", UNI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ACAI = "22222222-2222-4222-8222-222222222222", UNI_ACAI = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ON = { FOODY_CENTRAL_RELATORIO_ENABLED: "true", FOODY_CENTRAL_RELATORIO_UNIDADES: `${UNI},${UNI_ACAI}`, NOTIFICACOES_RELATORIOS_SEMANAL_HABILITADO: "true" };
const VIVA = { estado: "ao_vivo", motivo: null };

const fechChecklist = (competencia, over = {}) => ({ id: `f-${competencia}`, competencia, versao: 1, status: "CONSOLIDADO", hash_conteudo: "h", cobertura: {}, diagnostico: { principal: { fato: "x", acao: "y" } },
  indicadores: { pedidos: { recebidos: 40, concluidosNoDia: 38, canceladosNoDia: 2 }, preparo: { estado: "calculado", nome: "Preparo", media: 12, amostras: 30, meta: 15 }, entrega: { estado: "indisponivel", nome: "Entrega" }, vida: { estado: "indisponivel", nome: "Vida" },
    atrasos: { pedidosAvaliados: 30, pedidosAtrasados: 3, pct: 10 }, movimento: { picos: [{ hora: 19, pedidos: 9 }] }, cancelamentos: { total: 2, motivos: [] }, disputas: { abertasNoDia: 0, expiradasNoDia: 0, pendentesAgora: 0 },
    descontos: { pedidosNaBase: 0 }, clientes: { base: 0, novos: 0, recorrentes: 0 } }, ...over });
const fechFoody = (competencia, versao = 1, over = {}, org = ORG, uni = UNI) => ({ organizacao_id: org, unidade_id: uni, competencia, versao, status: "CONSOLIDADO", estado_valores: "SINCRONIZADO",
  indicadores: { subway: { total: { pedidos: 30, entregues: 28, cancelados: 2, taxasBrutas: 260, taxasValidas: 240.5 }, custoLogisticoProprio: 1234.5 } }, ...over });

function repoMemoria(fechamentos) {
  const itens = [];
  return { itens, fechamentosEntre: async ({ de, ate }) => fechamentos.filter((f) => f.competencia >= de && f.competencia <= ate),
    registrarResumoSemanal: async () => "r1",
    enfileirar: async (linhas) => { let n = 0; for (const l of linhas) if (!itens.some((i) => i.chave_idempotencia === l.chave_idempotencia)) { itens.push(l); n++; } return n; } };
}
const destinatarios = [{ id: "dFin", ativo: true, tipo: "financeiro" }, { id: "dOp", ativo: true, tipo: "operacional" }];
const notif = (unidadeId = UNI) => ({
  listarDestinatarios: async () => ({ destinatarios, escopos: destinatarios.flatMap((d) => ["fechamento_operacional_diario", "resumo_semanal"].map((categoria) => ({
    contato_empresa_id: d.id, unidade_escopo_id: unidadeId, categoria, origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: true }))) }),
  listarConsentimentos: async () => destinatarios.flatMap((d) => ["fechamento_operacional_diario", "resumo_semanal"].map((categoria) => ({ contato_empresa_id: d.id, categoria, acao: "CONCEDIDO" }))),
});
const unidade = (over = {}) => ({ organizacaoId: ORG, unidadeId: UNI, unidadeNome: "Subway Teste", fusoUnidade: null, integracao: VIVA, modulosEfetivos: ["checklist_operacional"], ...over });
const AGORA_TER = () => new Date("2026-10-28T12:00:00.000Z");   // ontem = 27/10
const AGORA_SEG = () => new Date("2026-11-02T12:00:00.000Z");   // segunda: semana 26/10–01/11

async function rodar({ env, agora = AGORA_TER, foody = [], lerFoody, u = unidade(), checklist } = {}) {
  const R = repoMemoria(checklist ?? [fechChecklist("2026-10-27"), ...["2026-10-26", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"].map((d) => fechChecklist(d))]);
  let leituras = 0;
  const saida = await enfileirarRelatoriosDaUnidade(u, { agora, env, deps: { relatorios: R, notificacoes: notif(u.unidadeId),
    lerFoody: lerFoody ?? (async ({ organizacaoId, unidadeId, de, ate }) => { leituras++; return foody.filter((f) => f.organizacao_id === organizacaoId && f.unidade_id === unidadeId && f.competencia >= de && f.competencia <= ate); }) } });
  return { saida, itens: R.itens, leituras: () => leituras };
}

describe("relatório diário com bloco logístico", () => {
  test("flag desligada: mensagem idêntica e NENHUMA leitura Foody", async () => {
    const base = await rodar({ env: {} });
    const comFoodySemFlag = await rodar({ env: { FOODY_CENTRAL_RELATORIO_UNIDADES: UNI }, foody: [fechFoody("2026-10-27")] });
    assert.equal(base.itens.length, 2);
    assert.deepEqual(comFoodySemFlag.itens.map((i) => i.mensagem), base.itens.map((i) => i.mensagem));
    assert.equal(comFoodySemFlag.leituras(), 0);
    assert.doesNotMatch(base.itens[0].mensagem, /Logística/);
  });
  test("ligada: financeiro recebe R$; operacional só contagens; chave de idempotência inalterada", async () => {
    const base = await rodar({ env: {} });
    const r = await rodar({ env: ON, foody: [fechFoody("2026-10-27")] });
    const fin = r.itens.find((i) => i.contato_empresa_id === "dFin"), op = r.itens.find((i) => i.contato_empresa_id === "dOp");
    assert.match(fin.mensagem, /\*Logística \(Foody\)\* — fechamento logístico v1, valores sincronizados/);
    assert.match(fin.mensagem, /Entregas: 28 de 30 pedidos/);
    assert.match(fin.mensagem, /Taxa válida: R\$ 240,50 \(bruta R\$ 260,00\)/);
    assert.match(fin.mensagem, /Custo atribuído a entregadores próprios: R\$ 1\.234,50/);
    assert.match(op.mensagem, /Entregas: 28 de 30 pedidos/);
    assert.doesNotMatch(op.mensagem, /R\$/, "sem permissão financeira, sem valores");
    assert.equal(fin.tamanho, fin.mensagem.length);
    assert.deepEqual(r.itens.map((i) => i.chave_idempotencia).sort(), base.itens.map((i) => i.chave_idempotencia).sort());
    for (const i of r.itens) assert.equal(validarMensagem(i.mensagem, { fechamento: fechChecklist("2026-10-27") }).ok, true);
  });
  test("versão nova do fechamento Foody DEPOIS do enfileiramento não gera mensagem corretiva", async () => {
    const foody = [fechFoody("2026-10-27")];
    const R = repoMemoria([fechChecklist("2026-10-27")]);
    const deps = { relatorios: R, notificacoes: notif(), lerFoody: async () => foody };
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA_TER, env: ON, deps });
    foody.push(fechFoody("2026-10-27", 2, { status: "CORRIGIDO", indicadores: { subway: { total: { pedidos: 31, entregues: 29, cancelados: 2, taxasBrutas: 270, taxasValidas: 250 }, custoLogisticoProprio: 1300 } } }));
    const segunda = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA_TER, env: ON, deps });
    assert.equal(segunda.diario.enfileirados, 0, "mesma chave do fechamento do Checklist");
    assert.equal(R.itens.length, 2);
    assert.match(R.itens[0].mensagem, /v1/, "fotografia preservada");
  });
  test("cada empresa vê só o próprio: linhas de outro tenant descartam o bloco inteiro", async () => {
    const r = await rodar({ env: ON, foody: [], lerFoody: async () => [fechFoody("2026-10-27", 1, {}, ORG_ACAI, UNI_ACAI)] });
    for (const i of r.itens) assert.doesNotMatch(i.mensagem, /Logística/);
    const acai = await rodar({ env: ON, u: unidade({ organizacaoId: ORG_ACAI, unidadeId: UNI_ACAI, unidadeNome: "Açaí Teste" }), foody: [
      fechFoody("2026-10-27", 1, {}, ORG), fechFoody("2026-10-27", 1, { indicadores: { operacao: "acai_no_grau", acai_no_grau: { total: { pedidos: 5, entregues: 5, cancelados: 0, taxasBrutas: 35, taxasValidas: 35 }, custoLogisticoProprio: 35 },
        subway: { total: { pedidos: 999 } } } }, ORG_ACAI, UNI_ACAI)] });
    const fin = acai.itens.find((i) => i.contato_empresa_id === "dFin");
    assert.match(fin.mensagem, /Entregas: 5 de 5 pedidos/);
    assert.doesNotMatch(fin.mensagem, /999|28 de 30/);
  });
  test("falha de leitura ou bloco que estouraria o limite: mensagem original (relatório nunca bloqueado)", async () => {
    const base = await rodar({ env: {} });
    const falha = await rodar({ env: ON, lerFoody: async () => { throw new Error("banco fora"); } });
    assert.deepEqual(falha.itens.map((i) => i.mensagem), base.itens.map((i) => i.mensagem));
    const longo = "x".repeat(LIMITE_CARACTERES - 20);
    assert.equal(textoComLogistica({ texto: longo, fechamentos: [fechFoody("2026-10-27")], tipoDestinatario: "financeiro", competencia: "2026-10-27", validar: (t) => validarMensagem(t) }), longo);
  });
  test("fechamento INCOMPLETO aparece como dados incompletos; PROVISORIO sinalizado; sem fechamento do dia = sem bloco", () => {
    assert.match(linhasLogisticaDiaria({ fechamentos: [fechFoody("2026-10-27", 1, { status: "INCOMPLETO" })], competencia: "2026-10-27" })[0], /dados incompletos/);
    assert.match(linhasLogisticaDiaria({ fechamentos: [fechFoody("2026-10-27", 1, { estado_valores: "PROVISORIO" })], competencia: "2026-10-27" })[0], /valores provisórios/);
    assert.equal(linhasLogisticaDiaria({ fechamentos: [fechFoody("2026-10-26")], competencia: "2026-10-27" }), null);
    assert.equal(linhasLogisticaDiaria({ fechamentos: [fechFoody("2026-10-27", 1, { status: "PRELIMINAR" })], competencia: "2026-10-27" }), null);
  });
});

describe("relatório semanal com bloco logístico", () => {
  test("soma só a última versão de cada dia, declara a cobertura; R$ só para o financeiro", async () => {
    const r = await rodar({ env: ON, agora: AGORA_SEG, checklist: ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"].map((d) => fechChecklist(d)),
      foody: [fechFoody("2026-10-26"), fechFoody("2026-10-27"), fechFoody("2026-10-27", 2, { status: "CORRIGIDO" }), fechFoody("2026-10-28", 1, { status: "INCOMPLETO" })] });
    const sem = r.itens.filter((i) => i.tipo === "semanal");
    assert.equal(sem.length, 2, JSON.stringify(r.saida.semanal));
    const fin = sem.find((i) => i.contato_empresa_id === "dFin"), op = sem.find((i) => i.contato_empresa_id === "dOp");
    assert.match(fin.mensagem, /\*Logística \(Foody\)\* — 2 de 7 dias/);
    assert.match(fin.mensagem, /Entregas: 56 de 60 pedidos/, "v2 do dia 27 substitui a v1; INCOMPLETO fora");
    assert.match(fin.mensagem, /Taxa válida: R\$ 481,00/);
    const blocoOp = op.mensagem.slice(op.mensagem.indexOf("*Logística (Foody)*"));
    assert.match(blocoOp, /Entregas: 56 de 60 pedidos/);
    assert.doesNotMatch(blocoOp, /R\$/, "sem permissão financeira, o bloco logístico não traz valores");
  });
  test("puro: semana sem fechamento usável = sem bloco", () => {
    assert.equal(linhasLogisticaSemanal({ fechamentos: [], dias: ["2026-10-26"] }), null);
  });
});

describe("ponte e permissões", () => {
  test("flag: só 'true' exato e unidade na lista (uuid)", () => {
    assert.equal(logisticaFoodyPermitida({ FOODY_CENTRAL_RELATORIO_ENABLED: "true", FOODY_CENTRAL_RELATORIO_UNIDADES: UNI }, UNI), true);
    for (const env of [{}, { FOODY_CENTRAL_RELATORIO_ENABLED: "1", FOODY_CENTRAL_RELATORIO_UNIDADES: UNI }, { FOODY_CENTRAL_RELATORIO_ENABLED: "true" }])
      assert.equal(logisticaFoodyPermitida(env, UNI), false);
  });
  test("lerFechamentosFoody desligada não chama a leitura", async () => {
    let chamou = false;
    assert.equal(await lerFechamentosFoody({ env: {}, organizacaoId: ORG, unidadeId: UNI, de: "2026-10-27", ate: "2026-10-27", ler: async () => { chamou = true; return []; } }), null);
    assert.equal(chamou, false);
  });
  test("papéis com valores: principal e financeiro; nunca operacional/secundário/desconhecido", () => {
    assert.deepEqual(["principal", "financeiro", "operacional", "secundario", null].map(recebeValores), [true, true, false, false, false]);
  });
  test("estrutural: ponte só lê foody_fechamentos_logisticos e só importa o gerador puro; nenhum envio", () => {
    const s = readFileSync(join(RAIZ, "src", "modules", "notificacoes", "notificacoes.relatorios.foody.js"), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete|rpc)\(|enviar|gateway|whatsapp\.service/i);
    assert.deepEqual([...s.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]/g)].map((m) => m[1]), ["foody_fechamentos_logisticos"]);
    assert.deepEqual([...s.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]), ["../foody/foody.mensagem.js"]);
    const gerador = readFileSync(join(RAIZ, "src", "modules", "foody", "foody.mensagem.js"), "utf8");
    assert.doesNotMatch(gerador, /^import /m, "gerador puro");
  });
});
