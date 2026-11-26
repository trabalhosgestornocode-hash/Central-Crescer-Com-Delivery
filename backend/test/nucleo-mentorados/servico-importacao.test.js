// Núcleo Mentorados — leitor da planilha, importação idempotente, isolamento entre empresas e apresentações.
// Sem banco real e sem rede (Supabase em memória; auditoria injetada). Rodar: node --test test/nucleo-mentorados/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lerPlanilhaHistorico } from "../../src/modules/nucleo-mentorados/leitorPlanilha.js";
import * as S from "../../src/modules/nucleo-mentorados/service.js";
import { planilhaReferencia } from "./fixtures.js";
import { fakeSupabase, rpcImportar } from "./fakeSupabase.js";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // cadastrada na plataforma, NÃO mentorada
const UNI_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const UNI_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const HOJE = "2026-11-26";
const AUTOR = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", nome: "Mentor Teste", email: "mentor@teste.invalid" };

function cenario() {
  const auditorias = [];
  const sb = fakeSupabase({
    organizacoes: [
      { id: ORG_A, nome: "Loja Exemplo - Cidade - UF", status: "ativa", eh_modelo: false },
      { id: ORG_B, nome: "Empresa B", status: "ativa", eh_modelo: false },
      { id: ORG_X, nome: "Empresa X", status: "ativa", eh_modelo: false },
    ],
    mentoria_participantes: [
      { organizacao_id: ORG_A, status: "ativa", data_entrada: "2025-10-01", data_renovacao: null, fonte_preferencial: "importacao", mentor_nome: "Mentor Teste", cidade: "Cidade Exemplo", uf: "BA" },
      { organizacao_id: ORG_B, status: "ativa", data_entrada: "2026-07-01", data_renovacao: "2027-07-01", fonte_preferencial: "dashboard_ifood" },
    ],
    lancamentos_financeiros_diarios: [
      // A: mai/26 por distribuição mensal (2 fatias) e set/26 por snapshot acumulado (o mais recente vence).
      { organizacao_id: ORG_A, unidade_id: UNI_A, data_lancamento: "2026-05-01", situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 49240, taxas_comissoes: 6281.25, servicos_promocoes: 3015, taxas_entregadores: 6532.5, qtd_vendas: 1000, valor_vendas_bruto: 50000, novos_clientes: 250 },
      { organizacao_id: ORG_A, unidade_id: UNI_A, data_lancamento: "2026-05-02", situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 49240, taxas_comissoes: 6281.25, servicos_promocoes: 3015, taxas_entregadores: 6532.5, qtd_vendas: 1000, valor_vendas_bruto: 50000, novos_clientes: 250 },
      { organizacao_id: ORG_A, unidade_id: UNI_A, data_lancamento: "2026-09-15", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 50000, taxas_comissoes: 7000, servicos_promocoes: 8000, taxas_entregadores: 0, qtd_vendas: 1200, valor_vendas_bruto: 52000, novos_clientes: 400 },
      { organizacao_id: ORG_A, unidade_id: UNI_A, data_lancamento: "2026-09-30", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 106510, taxas_comissoes: 13312.5, servicos_promocoes: 6390, taxas_entregadores: 0, qtd_vendas: 2300, valor_vendas_bruto: 103500, novos_clientes: 600 },
      // B: dados próprios que NUNCA podem aparecer no perfil de A.
      { organizacao_id: ORG_B, unidade_id: UNI_B, data_lancamento: "2026-09-30", situacao: "normal", origem_lancamento: "diario", valor_vendas_ifood: 999999.99, taxas_comissoes: 1, servicos_promocoes: 1, taxas_entregadores: 1, qtd_vendas: 1, valor_vendas_bruto: 1, novos_clientes: 1 },
    ],
    mentoria_registros: [
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", organizacao_id: ORG_B, tipo: "observacao", data_registro: "2026-08-01", titulo: "Nota de B", privado: true, indicadores: [] },
    ],
  }, { rpc: { mentoria_importar_historico: rpcImportar } });
  const deps = { supabase: sb, auditar: async (e) => { auditorias.push(e); } };
  return { sb, deps, auditorias };
}

const corpoArquivo = (buf, extra = {}) => ({ arquivoNome: "Histórico Loja Exemplo.xlsx", conteudoBase64: buf.toString("base64"), ...extra });

describe("leitor da planilha", () => {
  const lido = lerPlanilhaHistorico(planilhaReferencia(), { arquivoNome: "x.xlsx" });
  test("24 meses, out/24–set/26, valores de origem em reais", () => {
    assert.equal(lido.meses.length, 24);
    assert.equal(lido.meses[0].mes, "2024-10-01");
    assert.equal(lido.meses.at(-1).mes, "2026-09-01");
    assert.equal(lido.meses[0].valor_vendas, 60000);
    assert.equal(lido.meses[23].servicos_promocoes, 6390);
  });
  test("célula vazia = null (pedidos antes de jul/26, entregadores ago–set/26)", () => {
    assert.equal(lido.meses[0].qtd_pedidos, null);
    assert.equal(lido.meses[21].qtd_pedidos, 2000);
    assert.equal(lido.meses[22].taxas_entregadores, null);
    assert.equal(lido.meses[23].taxas_entregadores, null);
  });
  test("0% com R$ vazio é sinalizado como zero artificial", () => {
    const zeros = lido.avisos.filter((a) => a.codigo === "ZERO_ARTIFICIAL").map((a) => a.mes);
    assert.ok(zeros.includes("2026-08") && zeros.includes("2026-09"));
  });
  test("metas vêm dos rótulos; nota do mentor preservada; quadro de produto não sobrescreve", () => {
    assert.deepEqual(lido.metas.taxasComissoes, { maximo: 13, ideal: null });
    assert.deepEqual(lido.metas.custosIfoodTotal, { maximo: 33, ideal: 30 });
    assert.deepEqual(lido.metas.ticketMedio, { minimo: 45, ideal: 50 });
    assert.ok(lido.notas.some((n) => /Ago\/26 Fullservice/.test(n)));
    assert.equal(lido.meses[0].precificacao_pct, 30);
    assert.ok(lido.avisos.some((a) => a.codigo === "ROTULO_REPETIDO"));
  });
  test("mesmo arquivo -> mesmo hash; arquivo diferente -> hash diferente", () => {
    assert.equal(lerPlanilhaHistorico(planilhaReferencia()).sha256, lido.sha256);
    const outro = planilhaReferencia((l) => { l[8][2] = 60000.01; return l; });
    assert.notEqual(lerPlanilhaHistorico(outro).sha256, lido.sha256);
  });
  test("arquivo inválido / sem vendas / extensão errada", () => {
    assert.throws(() => lerPlanilhaHistorico(Buffer.from("não é xlsx")), /abrir|Nenhum/);
    assert.throws(() => lerPlanilhaHistorico(planilhaReferencia(), { arquivoNome: "a.csv" }), /xlsx/);
    const semVendas = planilhaReferencia((l) => l.filter((x) => !/VALOR DAS VENDAS/.test(String(x?.[1] ?? ""))));
    assert.throws(() => lerPlanilhaHistorico(semVendas), /Valor das vendas/);
  });
});

describe("importação: prévia, confirmação idempotente e divergências", () => {
  test("prévia não grava nada e mostra a sobreposição com o Dashboard iFood", async () => {
    const { sb, deps } = cenario();
    const d = await S.previaImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(planilhaReferencia()) }, deps);
    assert.equal(d.intervalo.meses, 24);
    assert.equal(d.jaImportada, null);
    assert.equal(d.mesesNovos, 24);
    assert.deepEqual(d.sobreposicaoDashboard, ["2026-05", "2026-09"]);
    const mai = d.divergenciasDashboard.find((x) => x.mes === "2026-05" && x.campo === "valorVendas");
    assert.equal(mai.diferenca, 202000); // R$ 100.500,00 (planilha) − R$ 98.480,00 (Dashboard)
    assert.equal((sb.db.mentoria_importacoes ?? []).length, 0);
    assert.ok(!sb.log.some((l) => l.rpc));
  });
  test("confirmação exige o hash da prévia; repetir o mesmo arquivo não duplica", async () => {
    const { sb, deps, auditorias } = cenario();
    const buf = planilhaReferencia();
    await assert.rejects(S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: "0".repeat(64) }), autor: AUTOR }, deps), /mudou/);
    const sha = lerPlanilhaHistorico(buf).sha256;
    const r1 = await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: sha }), autor: AUTOR }, deps);
    const r2 = await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: sha }), autor: AUTOR }, deps);
    assert.equal(r1.jaExistia, false);
    assert.equal(r1.mesesGravados, 24);
    assert.equal(r2.jaExistia, true);
    assert.equal(r2.importacaoId, r1.importacaoId);
    assert.equal(sb.db.mentoria_importacoes.length, 1);
    assert.equal(sb.db.mentoria_historico_mensal.length, 24);
    assert.equal(auditorias.filter((a) => a.acao === S.ACOES_NUCLEO.IMPORTACAO_CONFIRMADA).length, 1);
    // Nenhuma escrita em tabela oficial.
    assert.ok(!sb.log.some((l) => l.tabela === "lancamentos_financeiros_diarios" && l.op !== "select"));
    const prevDepois = await S.previaImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf) }, deps);
    assert.equal(prevDepois.jaImportada.id, r1.importacaoId);
    assert.equal(prevDepois.mesesIguais, 24);
  });
  test("planilha corrigida: prévia aponta os meses substituídos", async () => {
    const { deps } = cenario();
    const buf = planilhaReferencia();
    await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: lerPlanilhaHistorico(buf).sha256 }), autor: AUTOR }, deps);
    const corrigida = planilhaReferencia((l) => { l[8][2] = 61000; return l; });
    const d = await S.previaImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(corrigida) }, deps);
    assert.deepEqual(d.mesesSubstituidos, [{ mes: "2024-10", campos: ["valorVendas"] }]);
  });
  test("empresa não mentorada: 404 antes de ler o arquivo", async () => {
    const { deps } = cenario();
    await assert.rejects(S.previaImportacao({ organizacaoId: ORG_X, corpo: corpoArquivo(planilhaReferencia()) }, deps), (e) => e.statusCode === 404);
  });
});

describe("listagem, perfil e isolamento entre empresas", () => {
  async function comImportacao() {
    const c = cenario();
    const buf = planilhaReferencia();
    await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: lerPlanilhaHistorico(buf).sha256 }), autor: AUTOR }, c.deps);
    return c;
  }
  test("lista só as empresas CADASTRADAS como mentoradas", async () => {
    const { deps } = await comImportacao();
    const l = await S.listar({ hojeIso: HOJE }, deps);
    assert.deepEqual(l.mentorados.map((m) => m.organizacaoId).sort(), [ORG_A, ORG_B]);
    const a = l.mentorados.find((m) => m.organizacaoId === ORG_A);
    assert.equal(a.variacaoVendas.percentual, 50);
    assert.equal(a.custosIfood.pontosPercentuais, -6.5);
    assert.equal(a.divergencias, 2);
  });
  test("perfil de A nunca carrega linhas de B", async () => {
    const { sb, deps } = await comImportacao();
    sb.log.length = 0;
    const p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    assert.ok(p.serie.every((m) => m.valorVendas !== 99999999));
    assert.equal(p.registros.length, 0);
    for (const l of sb.log.filter((x) => x.tabela)) {
      const filtroOrg = l.filtros.find(([, c]) => c === "organizacao_id" || c === "id");
      assert.ok(filtroOrg, `consulta sem filtro de empresa em ${l.tabela}`);
      const valores = [].concat(filtroOrg[2]);
      assert.deepEqual(valores, [ORG_A], `${l.tabela} filtrou por ${valores}`);
    }
  });
  test("set/26 do Dashboard usa o snapshot mais recente (não soma os dias)", async () => {
    const { deps } = cenario();
    const p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    const set = p.serie.find((m) => m.mes === "2026-09");
    assert.equal(set.valorVendas, 10651000);
    assert.equal(set.qtdPedidos, 2300);
    const mai = p.serie.find((m) => m.mes === "2026-05");
    assert.equal(mai.valorVendas, 9848000); // soma das fatias da distribuição mensal
  });
  test("registro de B não é alterado nem removido pela rota de A", async () => {
    const { sb, deps } = cenario();
    const idB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await assert.rejects(S.alterarRegistro({ organizacaoId: ORG_A, registroId: idB, corpo: { tipo: "observacao", data: "2026-08-02", titulo: "x" }, autor: AUTOR }, deps), (e) => e.statusCode === 404);
    await assert.rejects(S.removerRegistro({ organizacaoId: ORG_A, registroId: idB, autor: AUTOR }, deps), (e) => e.statusCode === 404);
    assert.equal(sb.db.mentoria_registros[0].titulo, "Nota de B");
  });
  test("ids inválidos e módulo não instalado", async () => {
    const { deps } = cenario();
    await assert.rejects(S.perfil({ organizacaoId: "1 or 1=1" }, deps), (e) => e.statusCode === 400);
    const sb = fakeSupabase({}, { ausentes: ["mentoria_participantes"] });
    await assert.rejects(S.listar({ hojeIso: HOJE }, { supabase: sb }), (e) => e.statusCode === 503 && e.details.codigo === "NUCLEO_NAO_INSTALADO");
  });
});

describe("cadastro, registros e apresentações", () => {
  test("cadastro valida datas e UF; renovação antes da entrada é recusada", async () => {
    const { deps } = cenario();
    await assert.rejects(S.salvarParticipante({ organizacaoId: ORG_X, corpo: { dataEntrada: "2026-13-01" }, autor: AUTOR }, deps), (e) => e.statusCode === 400);
    await assert.rejects(S.salvarParticipante({ organizacaoId: ORG_X, corpo: { dataEntrada: "2026-01-01", dataRenovacao: "2025-12-01" }, autor: AUTOR }, deps), /posterior/);
    const r = await S.salvarParticipante({ organizacaoId: ORG_X, corpo: { dataEntrada: "2026-01-01", uf: "ba", mentor: "Ana" }, autor: AUTOR }, deps);
    assert.equal(r.participante.uf, "BA");
    assert.equal((await S.candidatas({ hojeIso: HOJE }, deps)).empresas.length, 0);
  });
  test("registro de meta valida o indicador", async () => {
    const { deps } = cenario();
    await assert.rejects(S.criarRegistro({ organizacaoId: ORG_A, corpo: { tipo: "meta", data: "2026-01-01", titulo: "x", metaIndicador: "lucro" }, autor: AUTOR }, deps), /inválido/);
    const r = await S.criarRegistro({ organizacaoId: ORG_A, corpo: { tipo: "meta", data: "2026-01-01", titulo: "Promoções até 5%", metaIndicador: "servicosPromocoes", metaValor: 5, metaUnidade: "percentual" }, autor: AUTOR }, deps);
    assert.equal(r.registro.privado, false, "meta aparece na apresentação por padrão");
  });
  test("apresentação guarda snapshot com hash e versões crescentes; reabrir devolve os mesmos números", async () => {
    const { deps, auditorias } = cenario();
    const a1 = await S.gerarApresentacao({ organizacaoId: ORG_A, corpo: { configuracao: { slidesOcultos: ["clientes", "inexistente"], notas: { capa: "Abrir com o crescimento" } } }, autor: AUTOR, hojeIso: HOJE }, deps);
    const a2 = await S.gerarApresentacao({ organizacaoId: ORG_A, corpo: {}, autor: AUTOR, hojeIso: HOJE }, deps);
    assert.equal(a1.apresentacao.versao, 1);
    assert.equal(a2.apresentacao.versao, 2);
    const lida = await S.obterApresentacao({ organizacaoId: ORG_A, apresentacaoId: a1.apresentacao.id }, deps);
    assert.deepEqual(lida.apresentacao.configuracao.slidesOcultos, ["clientes"]);
    assert.equal(lida.apresentacao.snapshot.empresa.id, ORG_A);
    assert.match(lida.apresentacao.snapshot_sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(S.obterApresentacao({ organizacaoId: ORG_B, apresentacaoId: a1.apresentacao.id }, deps), (e) => e.statusCode === 404);
    await S.registrarExportacao({ organizacaoId: ORG_A, apresentacaoId: a1.apresentacao.id, formato: "pdf", autor: AUTOR }, deps);
    assert.ok(auditorias.some((x) => x.acao === S.ACOES_NUCLEO.APRESENTACAO_EXPORTADA));
  });
});

describe("vínculo em massa, escolha de fonte e mudança operacional", () => {
  test("candidatas indicam uso do Dashboard iFood; vínculo exige confirmação e não duplica", async () => {
    const { sb, deps, auditorias } = cenario();
    sb.db.organizacoes.push({ id: "dddddddd-0000-4000-8000-00000000000d", nome: "Empresa D", status: "ativa", eh_modelo: false });
    sb.db.lancamentos_financeiros_diarios.push({ organizacao_id: ORG_X, unidade_id: "x", data_lancamento: "2026-11-20", situacao: "normal" });
    const c = await S.candidatas({ hojeIso: HOJE }, deps);
    assert.deepEqual(c.empresas.map((e) => [e.nome, e.usaDashboardIfood]), [["Empresa X", true], ["Empresa D", false]].sort());
    const itens = [{ organizacaoId: ORG_X, dataEntrada: "2026-02-01", mentor: "Ana" }, { organizacaoId: "dddddddd-0000-4000-8000-00000000000d" }, { organizacaoId: ORG_A }];
    await assert.rejects(S.vincularEmMassa({ corpo: { itens } , autor: AUTOR }, deps), /Confirme/);
    const r = await S.vincularEmMassa({ corpo: { itens, confirmacao: true, mentorPadrao: "Mentor Padrão" }, autor: AUTOR }, deps);
    assert.equal(r.vinculadas, 2);
    assert.deepEqual(r.jaVinculadas, [ORG_A]);
    assert.deepEqual(r.pendentes.sort(), [ORG_X, "dddddddd-0000-4000-8000-00000000000d"].sort(), "sem renovação/entrada = pendente");
    const d = sb.db.mentoria_participantes.find((p) => p.organizacao_id === "dddddddd-0000-4000-8000-00000000000d");
    assert.equal(d.data_entrada, null, "data nunca presumida");
    assert.equal(d.mentor_nome, "Mentor Padrão");
    assert.equal(d.fonte_preferencial, "dashboard_ifood");
    assert.equal(sb.db.mentoria_participantes.filter((p) => p.organizacao_id === ORG_A).length, 1);
    assert.ok(auditorias.some((x) => x.acao === S.ACOES_NUCLEO.VINCULO_EM_MASSA));
    const l = await S.listar({ hojeIso: HOJE }, deps);
    const pend = l.mentorados.find((m) => m.organizacaoId === "dddddddd-0000-4000-8000-00000000000d");
    assert.deepEqual(pend.pendencias, ["data de entrada", "data de renovação"]);
    assert.equal(pend.alertas[0].codigo, "ENTRADA_PENDENTE");
  });
  test("vínculo recusa empresa inexistente ou repetida", async () => {
    const { deps } = cenario();
    await assert.rejects(S.vincularEmMassa({ corpo: { confirmacao: true, itens: [{ organizacaoId: "eeeeeeee-0000-4000-8000-00000000000e" }] } }, deps), /inexistentes/);
    await assert.rejects(S.vincularEmMassa({ corpo: { confirmacao: true, itens: [{ organizacaoId: ORG_X }, { organizacaoId: ORG_X }] } }, deps), /repetida/);
  });
  test("escolha de fonte exige justificativa, vale no período, é auditada e revogável só na própria empresa", async () => {
    const { sb, deps, auditorias } = cenario();
    const buf = planilhaReferencia();
    await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: lerPlanilhaHistorico(buf).sha256 }), autor: AUTOR }, deps);
    sb.db.mentoria_participantes.find((p) => p.organizacao_id === ORG_A).fonte_preferencial = "dashboard_ifood";
    let p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    assert.equal(p.serie.find((m) => m.mes === "2026-05").valorVendas, 9848000, "padrão: Dashboard");
    await assert.rejects(S.escolherFonte({ organizacaoId: ORG_A, corpo: { inicio: "2026-05", fim: "2026-05", grupo: "financeiro", fonte: "importacao", justificativa: "curta" }, autor: AUTOR }, deps), /10 caracteres/);
    const { escolha } = await S.escolherFonte({ organizacaoId: ORG_A, corpo: { inicio: "2026-05", fim: "2026-05", grupo: "financeiro", fonte: "importacao", justificativa: "Extrato conferido com o mentor em reunião" }, autor: AUTOR }, deps);
    p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    assert.equal(p.serie.find((m) => m.mes === "2026-05").valorVendas, 10050000);
    assert.equal(p.divergencias.find((d) => d.mes === "2026-05" && d.campo === "valorVendas").resolvidaPor, escolha.id);
    await assert.rejects(S.revogarEscolhaFonte({ organizacaoId: ORG_B, escolhaId: escolha.id, corpo: { motivo: "tentativa de outra empresa" } }, deps), (e) => e.statusCode === 404);
    await S.revogarEscolhaFonte({ organizacaoId: ORG_A, escolhaId: escolha.id, corpo: { motivo: "Divergência explicada pelo suporte" }, autor: AUTOR }, deps);
    p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    assert.equal(p.serie.find((m) => m.mes === "2026-05").valorVendas, 9848000);
    assert.equal(p.escolhasFonte.length, 1, "revogar não apaga");
    assert.ok(auditorias.some((x) => x.acao === S.ACOES_NUCLEO.FONTE_REVOGADA));
    assert.ok(!sb.log.some((l) => l.tabela === "lancamentos_financeiros_diarios" && l.op !== "select"));
  });
  test("confirmar importação pode preservar a planilha nos meses sobrepostos (homologação)", async () => {
    const { deps } = cenario();
    const buf = planilhaReferencia();
    const r = await S.confirmarImportacao({ organizacaoId: ORG_A, autor: AUTOR, corpo: corpoArquivo(buf, { arquivoSha256: lerPlanilhaHistorico(buf).sha256,
      preservarPlanilhaNaSobreposicao: { justificativa: "Números homologados; divergências em análise" } }) }, deps);
    assert.ok(r.escolhaId);
    const p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    assert.deepEqual([p.escolhasFonte[0].mes_inicio, p.escolhasFonte[0].mes_fim], ["2026-05-01", "2026-09-01"]);
  });
  test("mudança operacional exige novo modelo e bloqueia comparação de entregadores", async () => {
    const { deps } = cenario();
    await assert.rejects(S.criarRegistro({ organizacaoId: ORG_A, corpo: { tipo: "mudanca_operacional", data: "2026-08-01", titulo: "x" }, autor: AUTOR }, deps), /novo modelo/);
    const buf = planilhaReferencia();
    await S.confirmarImportacao({ organizacaoId: ORG_A, corpo: corpoArquivo(buf, { arquivoSha256: lerPlanilhaHistorico(buf).sha256 }), autor: AUTOR }, deps);
    const r = await S.criarRegistro({ organizacaoId: ORG_A, corpo: { tipo: "mudanca_operacional", data: "2026-08-01", titulo: "Passou a Full Service", modeloAnterior: "marketplace", modeloNovo: "full_service" }, autor: AUTOR }, deps);
    assert.equal(r.registro.privado, false);
    const p = await S.perfil({ organizacaoId: ORG_A, hojeIso: HOJE }, deps);
    const c = p.analise.comparativos[p.analise.comparativoPrincipal];
    assert.equal(c.indicadores.find((i) => i.chave === "pctCustosIfoodTotal").estruturaMudou, true);
    assert.equal(p.analise.mudancas[0].texto, "Marketplace → Full Service em ago/26");
  });
});
