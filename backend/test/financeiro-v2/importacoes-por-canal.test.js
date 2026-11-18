// Fase 11 (doc 48) — importações POR CANAL (SAIPOS, iFood, 99Food): o que cada página pode importar, a prévia, a separação de canais,
// as regras de duplicidade e conflito, o demonstrativo oficial do iFood e a recusa do que ainda não tem layout validado.
// Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local. Hoje (relógio do teste) = 25/11/2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { FORMATOS_POR_CANAL } from "../../src/modules/financeiro-v2/aplicacao/importacoesPorCanal.js";
import { ESCRITAS, FONTE_DO_RELATORIO } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ORG_B, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const HOJE = () => new Date("2026-11-25T15:00:00.000Z");
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro",
  "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador",
  "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
let seq = 0;
const ficha = (quando, pagamento, itens, cancelado = "N") => ["Ficha", null, null, "F", "Dia", null, null, null, quando, "Consumidor não identificado", "N", pagamento, cancelado, null, itens, null, null, null, null, "", 0, "", 0, "", itens, 0];
const pedido = (canal, quando, pagamento, itens, entrega = 0, id = null) => [(seq += 1), "loja-sintetica", "Loja Sintética", "D", "Dia", canal, id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, String(1000 + seq), quando,
  "Cliente Sintético", "N", pagamento, "N", null, itens, entrega, 0, null, "Bairro Sintético", "00000-000", 0, null, 0, null, itens + entrega, 0];
const planilha = (linhas) => xlsx([{ nome: "Vendas por período", linhas: [CAB, ...linhas] }]);
const aBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const LINHAS = () => [
  ficha("02/11/2026 12:00", "Dinheiro", 15), ficha("02/11/2026 12:10", "Débito Master", 25), ficha("02/11/2026 12:20", "Débito Master", 40, "S"),
  pedido("Anota.ai", "02/11/2026 19:00", "Online Anotaai", 20, 5),
  pedido("iFood", "02/11/2026 19:10", "Online iFood", 80, 6), pedido("99 Food", "02/11/2026 19:20", "Pago Online", 45),
];

async function unidade(opcoes = {}) {
  const { nucleo: n } = montar({ relogio: HOJE, ...opcoes });
  const W = (k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const subir = (linhas, inicio = "2026-11-02", fim = "2026-11-02", x = c, tipo = "SAIPOS_VENDAS") => W("/importacao/receber", { tipoRelatorio: tipo, periodoInicio: inicio, periodoFim: fim, arquivoBase64: aBase64(planilha(linhas)), nomeArquivo: "Vendas por período.xlsx" }, x);
  const confirmar = async (importacao, extra = {}) => (await n.confirmarImportacao(c, { importacaoId: importacao.id, impressaoPrevia: importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas.", ...extra })).importacao;
  const aplicar = async (imp) => { await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id }); return W("/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id }); };
  const canal = (k, x = c) => CONSULTAS["/importacoes-canal"](n, x, { canal: k });
  const calendario = (k, mes = "2026-11") => CONSULTAS["/calendario-faturamento"](n, c, { canal: k, mes });
  return { n, W, caixa, subir, confirmar, aplicar, canal, calendario };
}

test("formatos por canal: SAIPOS pronto; iFood pela conciliação oficial e pelo demonstrativo; 99Food nada disponível (sem formato presumido)", async () => {
  const { canal } = await unidade();
  const s = await canal("SAIPOS");
  assert.equal(s.unidade.nome, "Unidade sintética");
  assert.deepEqual(s.formatos.map((f) => f.id), ["SAIPOS_VENDAS", "SAIPOS_FORMAS_PAGAMENTO", "SAIPOS_DESEMPENHO_POR_ATENDENTE", "SAIPOS_FATURAMENTO_POR_DIA", "SAIPOS_MOVIMENTOS_CAIXA"]);
  assert.ok(s.formatos.every((f) => f.disponivel && f.aceitaArquivo));
  const vendas = s.formatos[0];
  assert.deepEqual([vendas.principal, vendas.homologado, vendas.extensoesHomologadas], [true, true, ["xlsx"]], "o leitor real da Fase 03");
  const i = await canal("IFOOD");
  assert.deepEqual(i.formatos.map((f) => [f.id, f.disponivel, f.aceitaArquivo]), [["IFOOD_CONCILIACAO", true, true], ["IFOOD_DEMONSTRATIVO", true, false], ["IFOOD_APURACAO", false, false], ["IFOOD_PEDIDOS", false, false]]);
  assert.match(i.formatos[2].motivo, /contrato sintético/);
  assert.match(i.formatos[3].motivo, /não existe leitor/);
  const n99 = await canal("NOVENTA_E_NOVE_FOOD");
  assert.equal(n99.algumFormatoDisponivel, false);
  assert.ok(n99.formatos.every((f) => !f.disponivel && !f.aceitaArquivo));
  assert.match(n99.formatos[0].motivo, /validar o primeiro relatório oficial/);
  await rejeita(canal("OUTRO"), CODIGO.ENTRADA_INVALIDA);
  // Coerência com a camada HTTP: só o que está liberado para arquivo pode ser enviado.
  for (const f of Object.values(FORMATOS_POR_CANAL).flat()) assert.equal(Boolean(f.tipoRelatorio && FONTE_DO_RELATORIO[f.tipoRelatorio]), f.arquivo === true, f.id);
});

test("SAIPOS: o arquivo gera PRÉVIA por canal (Presencial, Anota Aí, iFood e 99Food só conferência, cancelado fora) e nada vira faturamento antes de confirmar", async () => {
  const { n, subir, calendario } = await unidade();
  const r = await subir(LINHAS());
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  const d = await n.detalharImportacao(c, { id: r.importacao.id });
  const ctl = d.previa.controles;
  assert.deepEqual(ctl.pedidosPorCanal, { BALCAO: 2, ANOTA_AI: 1, IFOOD: 1, NOVENTA_E_NOVE_FOOD: 1 }, "contagem por canal; o cancelado não entra");
  assert.deepEqual([ctl.pedidosCancelados, ctl.porCanal.BALCAO, ctl.porCanal.ANOTA_AI, ctl.porCanal.IFOOD, ctl.porCanal.NOVENTA_E_NOVE_FOOD], [1, 4000, 2500, 8600, 4500]);
  assert.deepEqual(d.conflitosDeGranularidade, []);
  assert.equal((await n.consultarComposicao(c, { competencia: "2026-11", indicador: "RECEITA_BRUTA" })).totalCentavos, 0, "a prévia não cria receita");
  assert.deepEqual((await calendario("BALCAO")).dias[1].estados, ["SEM_REGISTRO"], "o calendário só muda depois da confirmação e da aplicação");
});

test("SAIPOS: confirmar e aplicar alimenta só Presencial e Anota Aí; iFood e 99Food ficam fora da receita; os calendários atualizam sozinhos", async () => {
  const { n, subir, confirmar, aplicar, calendario } = await unidade();
  const r = await subir(LINHAS());
  const imp = await confirmar(r.importacao);
  const lote = await aplicar(imp);
  assert.equal(lote.falhas.length, 0, JSON.stringify(lote.falhas));
  const vendas = (await n.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.situacao === "ATIVA");
  assert.deepEqual([...new Set(vendas.map((v) => v.canal))].sort(), ["ANOTA_AI", "BALCAO"]);
  const vg = await n.apurarVisaoGeral(c, { competencia: "2026-11" });
  const por = (k) => vg.faturamentoBruto.porCanal.find((x) => x.canal === k)?.valorCentavos ?? 0;
  assert.deepEqual([por("BALCAO"), por("ANOTA_AI"), por("IFOOD"), por("NOVENTA_E_NOVE_FOOD")], [4000, 2500, 0, 0]);
  const pres = (await calendario("BALCAO")).dias[1];
  assert.ok(pres.estados.includes("IMPORTADO"));
  assert.equal(pres.registro.brutoCentavos, 4000);
  const anota = (await calendario("ANOTA_AI")).dias[1];
  assert.ok(anota.estados.includes("IMPORTADO"));
  assert.equal(anota.registro.brutoCentavos, 2500);
  const ifood = (await calendario("IFOOD")).dias[1];
  assert.equal(ifood.registro, null, "o pedido iFood da SAIPOS não é faturamento do iFood");
  assert.deepEqual(ifood.conferenciaSaipos, { pedidos: 1, natureza: "SO_CONFERENCIA" });
  assert.equal((await calendario("NOVENTA_E_NOVE_FOOD")).dias[1].registro, null);
});

test("SAIPOS: rejeitar (cancelar) a importação descarta o arquivo sem gravar nada; confirmar sem permissão é recusado", async () => {
  const { n, subir, confirmar, calendario } = await unidade();
  const leitor = ctx(undefined, undefined, ["financeiro_v2.ver"]);
  await rejeita(subir(LINHAS(), "2026-11-02", "2026-11-02", leitor), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await subir(LINHAS());
  await rejeita(n.confirmarImportacao(leitor, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.PERMISSAO_INSUFICIENTE);
  const rej = await n.rejeitarImportacao(c, { importacaoId: r.importacao.id, justificativa: "Arquivo do período errado (sintético)." });
  assert.equal(rej.estado, "REJEITADO");
  await rejeita(confirmar(r.importacao), CODIGO.TRANSICAO_INVALIDA);
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, 0);
  assert.deepEqual((await calendario("BALCAO")).dias[1].estados, ["SEM_REGISTRO"]);
});

test("SAIPOS: deduplicação — o mesmo arquivo é a mesma importação; período sobreposto reconhece o que já entrou e não duplica vendas", async () => {
  const { n, subir, confirmar, aplicar, canal } = await unidade();
  const L = LINHAS(); // as MESMAS linhas (os ids de pedido não podem mudar entre os envios)
  const a = await subir(L);
  const repetido = await subir(L);
  assert.equal(repetido.repetido, true);
  assert.equal(repetido.importacao.id, a.importacao.id);
  await aplicar(await confirmar(a.importacao));
  const antes = (await n.consultarRegistros(c, { tipo: "VENDA" })).length;
  // Outro arquivo, período maior, com as mesmas linhas mais um pedido novo.
  const b = await subir([...L, ficha("03/11/2026 12:00", "Dinheiro", 9)], "2026-11-02", "2026-11-03");
  const detalhe = await n.detalharImportacao(c, { id: b.importacao.id });
  assert.ok(detalhe.previa.jaExistentes >= 3, `reconhece o que já foi importado (${detalhe.previa.jaExistentes})`);
  await aplicar(await confirmar(b.importacao));
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.situacao === "ATIVA").length, antes + 1, "só o pedido novo vira venda");
  const h = await canal("SAIPOS");
  assert.equal(h.historico.length, 2);
  assert.ok(h.historico.every((x) => ["IMPORTADO", "IMPORTADO_COM_PENDENCIAS"].includes(x.estado)), h.historico.map((x) => x.estado).join());
});

test("SAIPOS: importação de outra granularidade nos mesmos dias é avisada na prévia e a aplicação é bloqueada (sem faturamento em dobro)", async () => {
  const { n, W, subir, confirmar, aplicar } = await unidade();
  const formas = xlsx([{ nome: "Vendas por forma de pagamento", linhas: [
    ["Forma de pagamento", "Valor total dos pagamentos (R$)", "Quantidade de pagamentos", "%", "Dia - 02/11/2026"],
    ["Dinheiro", "15", "1", "1,00 %", "15"], ["Débito Master", "25", "1", "1,00 %", "25"],
  ] }]);
  const rf = await W("/importacao/receber", { tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", periodoInicio: "2026-11-02", periodoFim: "2026-11-02", arquivoBase64: aBase64(formas), nomeArquivo: "Formas.xlsx" });
  const lote1 = await aplicar(await confirmar(rf.importacao));
  assert.ok(lote1.aplicadas >= 1 && lote1.falhas.length === 0);
  const por = await subir(LINHAS());
  const d = await n.detalharImportacao(c, { id: por.importacao.id });
  assert.equal(d.conflitosDeGranularidade.length, 1);
  assert.equal(d.conflitosDeGranularidade[0].tipoRelatorio, "SAIPOS_FORMAS_PAGAMENTO");
  assert.ok(d.conflitosDeGranularidade[0].propostasAplicadas >= 1);
  const imp = await confirmar(por.importacao);
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const bloqueado = await W("/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id });
  assert.equal(bloqueado.aplicadas, 0);
  assert.ok(bloqueado.falhas.every((f) => /outra granularidade|provisório/.test(f.mensagem)));
});

test("iFood: a PRÉVIA do demonstrativo oficial confere a conta e mostra período, faturamento, comissões, taxas, ajustes, repasse e pendências — sem gravar", async () => {
  const { n, canal, calendario } = await unidade();
  const dem = { periodoInicio: "2026-11-01", periodoFim: "2026-11-08", vendas: "1.000,00", comissoes: "120,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "50,00", ajustes: "0,00", liquido: "800,00", origem: "Demonstrativo sintético do iFood" };
  const p = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, dem);
  assert.deepEqual([p.valido, p.fecha, p.podeConfirmar, p.bloqueios.length], [true, true, true, 0]);
  assert.deepEqual([p.faturamentoCentavos, p.comissoesCentavos, p.taxasCentavos, p.mensalidadeCentavos, p.servicosEPromocoesCentavos, p.ajustesCentavos, p.liquidoCalculadoCentavos], [100000, 12000, 2000, 1000, 5000, 0, 80000]);
  assert.deepEqual([p.repasse.previstoCentavos, p.repasse.dataPrevista, p.periodoInicio, p.periodoFim], [80000, "2026-11-08", "2026-11-01", "2026-11-08"]);
  assert.ok(p.pendencias.some((x) => x.codigo === "SERVICOS_E_PROMOCOES_A_CLASSIFICAR"));
  assert.ok(p.pendencias.some((x) => x.codigo === "DETALHE_DIARIO_DEPENDE_DO_RELATORIO_DE_PEDIDOS"));
  assert.equal((await canal("IFOOD")).demonstrativos.length, 0, "a prévia não registrou nada");
  assert.equal((await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 0);
  // Não fecha: a prévia mostra a diferença e NÃO libera a confirmação.
  const ruim = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, { ...dem, liquido: "799,00" });
  assert.deepEqual([ruim.fecha, ruim.podeConfirmar, ruim.diferencaCentavos, ruim.bloqueios[0].codigo], [false, false, -100, "NAO_FECHA"]);
  // Dado inválido volta como erro legível, não como queda.
  const invalido = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, { ...dem, periodoFim: "2026-12-05" });
  assert.deepEqual([invalido.valido, invalido.podeConfirmar], [false, false]);
  assert.match(invalido.erro, /competência/);
  // Confirmar = o registro oficial existente; depois a prévia diz que já está registrado e o calendário cobre o período.
  const r = await ESCRITAS["/vendas/demonstrativo-ifood"].fazer(n, c, { ...dem, justificativa: "Demonstrativo sintético registrado no teste." });
  assert.equal(r.repetido, false);
  const depois = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, dem);
  assert.deepEqual([depois.jaRegistrado, depois.podeConfirmar], [true, false]);
  const h = await canal("IFOOD");
  assert.deepEqual([h.demonstrativos.length, h.demonstrativos[0].brutoCentavos, h.demonstrativos[0].repassePrevistoCentavos], [1, 100000, 80000]);
  const dia = (await calendario("IFOOD")).dias[3];
  assert.ok(dia.estados.includes("IMPORTADO") && dia.cobertura.granularidadeDiaria === false);
});

test("iFood: período que se sobrepõe a outro demonstrativo é bloqueado na prévia e no registro (receita não soma duas vezes)", async () => {
  const { n } = await unidade();
  const base = { periodoInicio: "2026-11-01", periodoFim: "2026-11-08", vendas: "1.000,00", comissoes: "120,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "50,00", ajustes: "0,00", liquido: "800,00", origem: "Demonstrativo sintético", justificativa: "Demonstrativo sintético registrado no teste." };
  await ESCRITAS["/vendas/demonstrativo-ifood"].fazer(n, c, base);
  const outro = { ...base, periodoInicio: "2026-11-06", periodoFim: "2026-11-15" };
  const p = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, outro);
  assert.deepEqual([p.podeConfirmar, p.bloqueios.map((x) => x.codigo)], [false, ["PERIODO_SOBREPOSTO"]]);
  await rejeita(ESCRITAS["/vendas/demonstrativo-ifood"].fazer(n, c, outro), CODIGO.CONFLITO_IDEMPOTENCIA);
  // Período vizinho (sem sobrepor) é aceito.
  const vizinho = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, { ...base, periodoInicio: "2026-11-09", periodoFim: "2026-11-15" });
  assert.equal(vizinho.podeConfirmar, true);
});

test("iFood e 99Food: arquivo sem layout validado é RECUSADO (apuração iFood sintética, relatório de pedidos e qualquer formato 99Food); nada é confirmável", async () => {
  const { n, W } = await unidade();
  const arq = aBase64(planilha([ficha("02/11/2026 12:00", "Dinheiro", 15)]));
  for (const tipo of ["IFOOD_APURACAO", "IFOOD_PEDIDOS", "NOVENTA_E_NOVE_FOOD_RELATORIO", "NOVENTA_E_NOVE_FOOD_VENDAS", "99FOOD"]) {
    await rejeita(async () => W("/importacao/receber", { tipoRelatorio: tipo, periodoInicio: "2026-11-02", periodoFim: "2026-11-02", arquivoBase64: arq, nomeArquivo: "relatorio.xlsx" }), CODIGO.ENTRADA_INVALIDA);
  }
  // Mesmo chamando o núcleo direto, a fonte 99Food não existe e o tipo SAIPOS não vale como 99Food.
  await rejeita(n.receberArquivoParaImportacao(c, { fonte: "NOVENTA_E_NOVE_FOOD", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: planilha([]), periodoInicio: "2026-11-02", periodoFim: "2026-11-02" }), CODIGO.ENTRADA_INVALIDA);
  assert.equal((await n.consultarDocumentosImportados(c, {})).itens.length, 0, "nenhuma importação foi criada");
});

test("permissões e isolamento: o histórico e as ações respeitam o perfil e a unidade", async () => {
  const { n, subir, confirmar, canal } = await unidade();
  await confirmar((await subir(LINHAS())).importacao);
  const leitor = await canal("SAIPOS", ctx(undefined, undefined, ["financeiro_v2.ver"]));
  assert.deepEqual([leitor.acoes.importar, leitor.acoes.registrarDemonstrativo], [false, false]);
  assert.equal(leitor.historico.length, 1, "quem só vê, vê o histórico");
  assert.equal((await canal("IFOOD", ctx(undefined, undefined, ["financeiro_v2.ver"]))).acoes.registrarDemonstrativo, false);
  assert.equal((await canal("IFOOD")).acoes.registrarDemonstrativo, true);
  await rejeita(canal("SAIPOS", ctx(undefined, undefined, [])), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(CONSULTAS["/previa-demonstrativo-ifood"](n, ctx(undefined, undefined, []), { periodoInicio: "2026-11-01", periodoFim: "2026-11-08", vendas: "10,00", liquido: "10,00", origem: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const outra = await canal("SAIPOS", ctx(ORG_B, UNI_B));
  assert.equal(outra.historico.length, 0, "outra empresa não enxerga as importações desta");
});
