// Fase 10 (doc 47) — calendário de controle de faturamento por canal. Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local.
// Hoje (relógio do teste) = 25/11/2026. Cada teste monta a unidade do zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ORG_B, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const HOJE = () => new Date("2026-11-25T15:00:00.000Z");
const MES = "2026-11";
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro",
  "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador",
  "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const ficha = (quando, pagamento, itens) => ["Ficha", null, null, "F", "Dia", null, null, null, quando, "Consumidor não identificado", "N", pagamento, "N", null, itens, null, null, null, null, "", 0, "", 0, "", itens, 0];
let seq = 0;
const pedido = (canal, quando, pagamento, itens, entrega = 0) => [(seq += 1), "loja-sintetica", "Loja Sintética", "D", "Dia", canal, `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, String(1000 + seq), quando,
  "Cliente Sintético", "N", pagamento, "N", null, itens, entrega, 0, null, "Bairro Sintético", "00000-000", 0, null, 0, null, itens + entrega, 0];

async function unidade() {
  const { nucleo: n } = montar({ relogio: HOJE });
  const W = (k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const cal = async (canal, mes = MES, x = c) => CONSULTAS["/calendario-faturamento"](n, x, { canal, mes });
  const dia = (calendario, data) => calendario.dias.find((d) => d.data === data);
  const importar = async (linhas, inicio, fim, { aplicar = true } = {}) => {
    const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: xlsx([{ nome: "Vendas por período", linhas: [CAB, ...linhas] }]), periodoInicio: inicio, periodoFim: fim });
    assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
    const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas." } : {}) })).importacao;
    await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
    if (aplicar) await W("/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id });
    return imp;
  };
  return { n, W, cal, dia, importar, caixa };
}
const fechamento = (extra = {}) => ({
  data: "2026-11-05", caixa: "1", responsavelAbertura: "Pessoa A", responsavelFechamento: "Pessoa B", din_abertura: "100,00", din_vendas: "50,00", din_retiradas: "30,00", din_reforcos: "10,00",
  din_informado: "128,00", ...extra,
});

test("1 e 12 — dia sem registro: só o dia ELEGÍVEL (passado, após o início do controle) fica 'sem registro'; futuro e hoje nunca são atrasados", async () => {
  const { cal, dia } = await unidade();
  const k = await cal("BALCAO");
  assert.deepEqual(dia(k, "2026-11-10").estados, ["SEM_REGISTRO"]);
  assert.equal(dia(k, "2026-11-10").elegivel, true);
  assert.deepEqual(dia(k, "2026-11-25").estados, [], "hoje ainda está em andamento");
  assert.equal(dia(k, "2026-11-25").hoje, true);
  assert.deepEqual(dia(k, "2026-11-28").estados, [], "dia futuro nunca é atrasado");
  assert.equal(dia(k, "2026-11-28").futuro, true);
  // 24 dias passados elegíveis (1 a 24/11), nenhum registro.
  assert.deepEqual([k.resumo.diasElegiveis, k.resumo.semRegistro, k.resumo.comInformacao, k.resumo.futuros], [24, 24, 0, 5]);
  assert.equal(k.dias.length, 30);
});

test("11 — meses diferentes: antes do início do controle nada é cobrado; mês futuro é todo futuro", async () => {
  const { cal } = await unidade();
  const antes = await cal("BALCAO", "2026-10");
  assert.equal(antes.resumo.semRegistro, 0);
  assert.ok(antes.dias.every((d) => d.antesDoControle && !d.elegivel && d.estados.length === 0));
  const depois = await cal("BALCAO", "2026-12");
  assert.ok(depois.dias.every((d) => d.futuro && d.estados.length === 0));
  assert.equal(depois.resumo.futuros, 31);
});

test("2, 8 e 16 — importação cobre vários dias; cada canal mostra só os seus registros; dia coberto sem venda é 'sem movimento confirmado' pelo relatório", async () => {
  const { cal, dia, importar } = await unidade();
  await importar([
    ficha("02/11/2026 12:00", "Dinheiro", 15), ficha("02/11/2026 12:10", "Débito Master", 25),
    pedido("Anota.ai", "03/11/2026 19:00", "Online Anotaai", 20, 5),
  ], "2026-11-02", "2026-11-04");
  const p = await cal("BALCAO");
  assert.deepEqual([dia(p, "2026-11-02").registro.vendas, dia(p, "2026-11-02").registro.brutoCentavos], [2, 4000]);
  assert.ok(dia(p, "2026-11-02").estados.includes("IMPORTADO"));
  assert.equal(dia(p, "2026-11-02").importacoes.length, 1);
  assert.deepEqual(dia(p, "2026-11-03").estados, ["SEM_MOVIMENTO_CONFIRMADO"], "o relatório cobre 03/11 e não traz venda do Presencial");
  assert.equal(dia(p, "2026-11-03").registro, null);
  assert.deepEqual(dia(p, "2026-11-05").estados, ["SEM_REGISTRO"], "05/11 está fora do período do relatório");
  const a = await cal("ANOTA_AI");
  assert.equal(dia(a, "2026-11-03").registro.brutoCentavos, 2500, "Anota Aí: itens 20 + entrega 5; só o canal dele");
  assert.ok(dia(a, "2026-11-03").estados.includes("IMPORTADO"));
  assert.deepEqual(dia(a, "2026-11-02").estados, ["SEM_MOVIMENTO_CONFIRMADO"], "o Presencial de 02/11 não aparece no Anota Aí");
});

test("3 e 7 — fechamento manual (vários caixas no mesmo dia) fica registrado sem criar receita e o dia pede o relatório", async () => {
  const { n, W, cal, dia } = await unidade();
  await W("/fechamento-manual/registrar", fechamento({ caixa: "1" }));
  await W("/fechamento-manual/registrar", fechamento({ caixa: "2", din_vendas: "20,00", din_informado: "98,00" }));
  const k = await cal("BALCAO");
  const d = dia(k, "2026-11-05");
  assert.deepEqual(d.estados, ["FECHAMENTO_MANUAL", "CONFERENCIA_PENDENTE"]);
  assert.equal(d.fechamento.caixas, 2);
  assert.equal(d.registro, null, "o fechamento não cria faturamento");
  assert.ok(d.pendencias.some((x) => x.codigo === "FECHAMENTO_SEM_RELATORIO"));
  assert.equal((await n.consultarComposicao(c, { competencia: MES, indicador: "RECEITA_BRUTA" })).totalCentavos, 0);
  // Anota Aí só considera o caixa que informou Anota Aí.
  assert.equal(dia(await cal("ANOTA_AI"), "2026-11-05").fechamento, null);
});

test("4 — faturamento manual provisório aparece como PROVISÓRIO e com a pendência de substituição", async () => {
  const { W, cal, dia } = await unidade();
  await W("/faturamento-manual/registrar", { data: "2026-11-06", caixa: "1", canal: "BALCAO", justificativa: "Sem relatório da SAIPOS ainda (sintético)", din_vendas: "50,00" });
  const d = dia(await cal("BALCAO"), "2026-11-06");
  assert.ok(d.estados.includes("PROVISORIO") && d.estados.includes("CONFERENCIA_PENDENTE"));
  assert.equal(d.registro.provisorias.vendas, 1);
  assert.equal(d.registro.brutoCentavos, 5000);
  assert.ok(d.pendencias.some((x) => x.codigo === "FATURAMENTO_PROVISORIO"));
  assert.ok(!d.estados.includes("IMPORTADO") && !d.estados.includes("CONCILIADO"));
});

test("5 — divergência: o fechamento diverge das vendas importadas e o dia soma vários estados sem esconder nenhum", async () => {
  const { W, cal, dia, importar } = await unidade();
  await importar([ficha("09/11/2026 12:00", "Dinheiro", 50), ficha("09/11/2026 12:10", "Débito Master", 40)], "2026-11-09", "2026-11-09");
  await W("/fechamento-manual/registrar", fechamento({ data: "2026-11-09", din_vendas: "60,00", din_informado: "138,00" })); // 60 informado × 50 vendido
  const d = dia(await cal("BALCAO"), "2026-11-09");
  assert.ok(["IMPORTADO", "FECHAMENTO_MANUAL", "CONFERENCIA_PENDENTE", "DIVERGENCIA"].every((e) => d.estados.includes(e)), d.estados.join());
  assert.ok(d.divergencias.some((x) => x.codigo === "FECHAMENTO_DIVERGE_DAS_VENDAS"));
  assert.ok(!d.estados.includes("CONCILIADO"));
});

test("6 e 15 — dia conciliado (recebimento confirmado = esperado) e pendências de taxa, operadora e bandeira ficam explícitas", async () => {
  const { cal, dia, importar } = await unidade();
  await importar([ficha("10/11/2026 12:00", "Dinheiro", 30)], "2026-11-10", "2026-11-10");
  const conciliado = dia(await cal("BALCAO"), "2026-11-10");
  assert.deepEqual(conciliado.estados, ["IMPORTADO", "CONCILIADO"]);
  assert.equal(conciliado.registro.recebidoCentavos, 3000);
  await importar([ficha("11/11/2026 12:00", "Débito Master", 40), ficha("11/11/2026 12:10", "Vale", 12)], "2026-11-11", "2026-11-11");
  const d = dia(await cal("BALCAO"), "2026-11-11");
  assert.ok(d.estados.includes("CONFERENCIA_PENDENTE") && !d.estados.includes("CONCILIADO"));
  assert.ok(d.pendencias.some((x) => x.codigo === "TAXA_NAO_CONFIGURADA" || x.codigo === "OPERADORA_PENDENTE"));
  assert.ok(d.pendencias.some((x) => x.codigo === "BANDEIRA_PENDENTE"), "o vale vem sem bandeira");
  assert.equal(d.registro.taxaEstimadaCentavos, null, "taxa não calculada nunca vira zero");
  assert.equal(d.registro.liquidoEsperadoCentavos, null);
});

test("9 — iFood: demonstrativo oficial cobre um PERÍODO; nenhum valor é repartido por dia", async () => {
  const { W, cal, dia } = await unidade();
  const dem = { periodoInicio: "2026-11-01", periodoFim: "2026-11-15", vendas: "1.000,00", comissoes: "100,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "200,00", ajustes: "0,50", liquido: "670,50", origem: "Demonstrativo sintético do iFood", justificativa: "Demonstrativo sintético registrado no teste." };
  await W("/vendas/demonstrativo-ifood", dem);
  const k = await cal("IFOOD");
  for (const data of ["2026-11-01", "2026-11-08", "2026-11-15"]) {
    const d = dia(k, data);
    assert.ok(d.estados.includes("IMPORTADO"), data);
    assert.equal(d.registro, null, "sem valor diário");
    assert.equal(d.cobertura.granularidadeDiaria, false);
    assert.equal(d.cobertura.periodos.length, 1);
    assert.match(d.cobertura.mensagem, /depende do relatório oficial de pedidos/);
  }
  assert.deepEqual(dia(k, "2026-11-16").estados, ["SEM_REGISTRO"], "fora do período coberto");
  assert.ok(dia(k, "2026-11-10").pendencias.some((p) => /^REPASSE_/.test(p.codigo)), "repasse ainda não recebido");
  assert.equal(k.cobertura.length, 1);
  assert.equal(k.cobertura[0].brutoCentavos, 100000, "o valor existe no PERÍODO");
  assert.equal(k.granularidadeDiaria, false);
});

test("9 — iFood: receita iFood lançada fora do demonstrativo oficial vira divergência; pedido iFood só na SAIPOS não é fonte", async () => {
  const { cal, dia, importar } = await unidade();
  await importar([pedido("iFood", "12/11/2026 19:00", "Online iFood", 80, 6)], "2026-11-12", "2026-11-12");
  const d = dia(await cal("IFOOD"), "2026-11-12");
  assert.deepEqual(d.estados.filter((e) => e !== "CONFERENCIA_PENDENTE"), ["SEM_REGISTRO"], "a SAIPOS não vira faturamento do iFood");
  assert.equal(d.registro, null);
  assert.deepEqual(d.conferenciaSaipos, { pedidos: 1, natureza: "SO_CONFERENCIA" }, "só a contagem, como conferência");
  assert.ok(d.pendencias.some((p) => p.codigo === "PEDIDOS_SEM_FONTE_OFICIAL"));
});

test("10 — 99Food: sem relatório oficial os dias ficam sem dados, nunca zero confirmado", async () => {
  const { cal, dia } = await unidade();
  const k = await cal("NOVENTA_E_NOVE_FOOD");
  assert.equal(k.semFonteOficial, true);
  assert.deepEqual(dia(k, "2026-11-10").estados, ["SEM_REGISTRO"]);
  assert.equal(dia(k, "2026-11-10").registro, null);
  assert.match(dia(k, "2026-11-10").observacoes.join(" "), /não é zero confirmado/);
  assert.ok(k.dias.every((d) => !d.estados.includes("SEM_MOVIMENTO_CONFIRMADO")), "sem evidência, nada é 'confirmado'");
  assert.deepEqual([k.resumo.comInformacao, k.resumo.confirmados], [0, 0]);
});

test("13 — dias sem operação: por data e por dia da semana, com justificativa; saem da cobrança; registro existente nunca é escondido", async () => {
  const { W, cal, dia, importar } = await unidade();
  await rejeita(W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", justificativa: "" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", diaDaSemana: 0, justificativa: "Duas formas ao mesmo tempo." }), CODIGO.ENTRADA_INVALIDA);
  const r = await W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", justificativa: "Loja fechada por manutenção (sintético)." });
  assert.equal(r.repetido, false);
  assert.equal((await W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", justificativa: "Loja fechada por manutenção (sintético)." })).repetido, true);
  await W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", diaDaSemana: 0, justificativa: "A loja não abre aos domingos (sintético)." });
  const k = await cal("BALCAO");
  assert.deepEqual(dia(k, "2026-11-04").estados, ["SEM_MOVIMENTO_CONFIRMADO"]);
  assert.equal(dia(k, "2026-11-04").elegivel, false);
  assert.equal(dia(k, "2026-11-04").semOperacao.origem, "DATA");
  assert.equal(dia(k, "2026-11-08").semOperacao.origem, "DIA_DA_SEMANA", "08/11/2026 é domingo");
  const domingos = k.dias.filter((d) => d.diaDaSemana === 0).length;
  assert.equal(k.resumo.semOperacao, 1 + domingos, "a data avulsa mais todos os domingos do mês (inclusive o futuro, que só está marcado)");
  // O que não foi marcado continua cobrado; o Anota Aí não herda a marcação do Presencial.
  assert.deepEqual(dia(k, "2026-11-10").estados, ["SEM_REGISTRO"]);
  assert.deepEqual(dia(await cal("ANOTA_AI"), "2026-11-04").estados, ["SEM_REGISTRO"]);
  // Registro existente não pode ser escondido.
  await importar([ficha("09/11/2026 12:00", "Dinheiro", 10)], "2026-11-09", "2026-11-09");
  await rejeita(W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-09", justificativa: "Tentativa de esconder venda (sintético)." }), CODIGO.OPERACAO_INVALIDA);
  // Dia da semana marcado mas com registro: o registro prevalece.
  await importar([ficha("15/11/2026 12:00", "Dinheiro", 10)], "2026-11-15", "2026-11-15");
  const domingo = dia(await cal("BALCAO"), "2026-11-15");
  assert.ok(domingo.estados.includes("IMPORTADO") && !domingo.estados.includes("SEM_MOVIMENTO_CONFIRMADO"));
  assert.equal(domingo.semOperacao, null);
  assert.match(domingo.observacoes.join(" "), /o registro prevalece/);
  // Desmarcar volta a cobrar.
  await W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", situacao: "OPERA", justificativa: "Voltou a operar nesse dia (sintético)." });
  assert.deepEqual(dia(await cal("BALCAO"), "2026-11-04").estados, ["SEM_REGISTRO"]);
});

test("14 — permissões e isolamento: sem 'ver' recusa; sem 'configurar' não marca dia; ações só para quem pode; outra unidade não enxerga", async () => {
  const { n, W, cal, dia, importar } = await unidade();
  await importar([ficha("02/11/2026 12:00", "Dinheiro", 15)], "2026-11-02", "2026-11-02");
  const leitor = ctx(undefined, undefined, ["financeiro_v2.ver"]);
  const kLeitor = await cal("BALCAO", MES, leitor);
  assert.deepEqual(kLeitor.acoes, { abrirImportacoes: true, importar: false, registrarFechamento: false, registrarFaturamentoProvisorio: false, substituirProvisorio: false, abrirConferencias: true, configurarDiasSemOperacao: false },
    "leitor: só abrir importações e conferências");
  const admin = await cal("BALCAO");
  assert.equal(admin.acoes.configurarDiasSemOperacao, true);
  assert.equal(admin.acoes.registrarFaturamentoProvisorio, true);
  assert.equal((await cal("IFOOD")).acoes.registrarFaturamentoProvisorio, false, "iFood não tem faturamento manual");
  await rejeita(cal("BALCAO", MES, ctx(undefined, undefined, [])), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(W("/calendario-faturamento/sem-operacao", { canal: "BALCAO", data: "2026-11-04", justificativa: "Sem permissão de configurar (sintético)." }, leitor), CODIGO.PERMISSAO_INSUFICIENTE);
  // Outra empresa/unidade não vê nada desta unidade.
  const outra = await CONSULTAS["/calendario-faturamento"](n, ctx(ORG_B, UNI_B), { canal: "BALCAO", mes: MES });
  assert.equal(dia(outra, "2026-11-02").registro, null);
  assert.equal(outra.resumo.comInformacao, 0);
});

test("entrada inválida: canal, mês e campos desconhecidos são recusados", async () => {
  const { n } = await unidade();
  await rejeita(CONSULTAS["/calendario-faturamento"](n, c, { canal: "IFOOD_X", mes: MES }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(CONSULTAS["/calendario-faturamento"](n, c, { canal: "BALCAO", mes: "2026-13" }), CODIGO.DATA_INVALIDA);
  await rejeita(n.consultarCalendarioDeFaturamento(c, { canal: "BALCAO", mes: MES, extra: "x" }), CODIGO.ENTRADA_INVALIDA);
});

test("o calendário é só leitura: consultar não cria receita, venda nem lançamento", async () => {
  const { n, cal } = await unidade();
  const antes = JSON.stringify([(await n.consultarRegistros(c, { tipo: "VENDA" })).length, (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length]);
  for (const canal of ["BALCAO", "ANOTA_AI", "IFOOD", "NOVENTA_E_NOVE_FOOD"]) await cal(canal);
  assert.equal(JSON.stringify([(await n.consultarRegistros(c, { tipo: "VENDA" })).length, (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length]), antes);
});
