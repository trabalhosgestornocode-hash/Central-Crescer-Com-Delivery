// MOVA — Agente 2: consultas de CONFERÊNCIA de contas a pagar (custo zero) e explicação de UMA conta.
// Tudo SINTÉTICO; nenhuma chamada de IA; nada vai ao WhatsApp real; nenhuma escrita financeira.
import assert from "node:assert/strict";
import { CONFIG, CONS, FIN, GRUPO, BETA, ORG, cenario, gw, t } from "./helpers/operacao.js";
import { OPERACOES_PERMITIDAS } from "../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";
import { interpretarComando } from "../../src/modules/mova-financeiro/aplicacao/comandos.js";
import {
  buscarContas, contasParciais, contasParecidas, contasSemComprovante, contasVencidas, descricaoSemFornecedor, explicarConta, fornecedoresComPendencias,
  maioresContas, marcasDaConta, mesCitado, pagamentosAConciliar, saidasCompativeis,
} from "../../src/modules/mova-financeiro/aplicacao/conferenciaContas.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const HOJE = "2026-11-22";
let seq = 0;
/** Título no MESMO formato do Financeiro v2 (tituloAPagar). */
const titulo = (x = {}) => {
  const valor = x.valor ?? 10000; const pago = x.pago ?? 0; const ajuste = x.ajuste ?? 0;
  const saldo = x.saldo ?? valor + ajuste - pago;
  const venc = x.venc ?? "2026-11-10";
  const situacao = x.situacao ?? (saldo === 0 ? "PAGO" : venc < HOJE ? "VENCIDO" : pago > 0 ? "PARCIALMENTE_PAGO" : "EM_ABERTO");
  const docs = x.docs ?? [];
  return {
    id: x.id ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, fornecedor: x.forn === null ? null : { id: "f", nome: x.forn ?? "Fornecedor A", tipo: "FORNECEDOR" },
    descricao: x.desc ?? "Compra", categoria: { codigo: "INSUMOS", nome: x.cat ?? "Insumos" }, classificacaoEconomica: x.classif ?? "CONFIRMADA",
    competencia: x.comp ?? venc.slice(0, 7), dataEmissao: x.emissao ?? venc, vencimento: venc, valorOriginalCentavos: valor, ajustesCentavos: ajuste,
    pagoCentavos: pago, saldoCentavos: saldo, situacao, vencido: situacao === "VENCIDO" || (saldo > 0 && venc < HOJE),
    pendencias: saldo > 0 && docs.length === 0 ? ["SEM_DOCUMENTO"] : [], documentos: docs, pagamentos: x.pagamentos ?? (pago > 0 ? [{ data: venc, valorCentavos: pago, conta: "Banco", documentos: x.docPagamento ?? [] }] : []),
    origem: x.origem ?? "MANUAL",
  };
};
const saida = (data, valor, descricao, alocado = 0) => ({ id: `s-${++seq}`, data, valorCentavos: valor, alocadoCentavos: alocado, descricao, conta: "Banco" });

// ---------------------------------------------------------------------------------------------- interpretação (sem IA)

t("A2-C1 as 7 perguntas e as 3 de explicação viram a consulta certa, sem IA; 'maiores' não é o mês de maio", () => {
  const c = (x) => interpretarComando(x, HOJE)?.saida;
  assert.equal(c("MOVA, quais contas estão vencidas?").consulta, "CONTAS_VENCIDAS");
  assert.equal(c("MOVA, quais contas estão sem comprovante?").consulta, "CONTAS_SEM_COMPROVANTE");
  assert.equal(c("MOVA, quais pagamentos precisam de conciliação?").consulta, "PAGAMENTOS_A_CONCILIAR");
  const maiores = c("MOVA, quais são as maiores contas em aberto?");
  assert.equal(maiores.consulta, "MAIORES_CONTAS_ABERTAS"); assert.equal(maiores.competencia, null, "maiores ≠ maio");
  const amanha = c("MOVA, quais contas vencem amanhã?");
  assert.equal(amanha.consulta, "CONTAS_VENCENDO"); assert.equal(amanha.periodoInicio, "2026-11-23"); assert.equal(amanha.periodoFim, "2026-11-23");
  assert.equal(c("MOVA, quais contas estão parcialmente pagas?").consulta, "CONTAS_PARCIAIS");
  assert.equal(c("MOVA, quais fornecedores possuem mais contas pendentes?").consulta, "FORNECEDORES_COM_PENDENCIAS");
  const d = c("MOVA, me explique a conta da Distribuidora de R$ 5.123,40.");
  assert.deepEqual([d.consulta, d.favorecido, d.valorCentavos], ["SITUACAO_DE_CONTA", "distribuidora", 512340]);
  const a = c("MOVA, a conta da Bruna já foi paga?");
  assert.deepEqual([a.consulta, a.favorecido, a.valorCentavos], ["SITUACAO_DE_CONTA", "bruna", null]);
  const s = c("MOVA, por que a Contabilidade de setembro está vencida?");
  assert.deepEqual([s.consulta, s.favorecido, s.competencia], ["SITUACAO_DE_CONTA", "contabilidade", "2026-09"]);
  assert.equal(c("faturamento de maio").competencia, "2026-05", "o nome do mês inteiro continua valendo");
});

t("A2-C2 relato, pedido de pagamento, baixa, cancelamento, registro e envio de documento NUNCA viram consulta", () => {
  for (const x of ["paguei a conta da Bruna", "MOVA, segue comprovante", "MOVA, cancele a conta da Bruna", "MOVA, dá baixa na conta da Bruna de R$ 73,00",
    "MOVA, faça o pix da conta da Bruna", "MOVA, pague a conta da Distribuidora", "MOVA, registre a conta da Bruna de R$ 73,00", "MOVA, explique e aprove a conta da Bruna",
    "a conta de luz vence quando?", "mova pix das contas a pagar", "paguei, segue sem comprovante"]) {
    const r = interpretarComando(x, HOJE);
    assert.ok(r === null || r.saida.consulta === null, x);
  }
});

// --------------------------------------------------------------------------------------------------------- marcas

t("A2-C3 possível pagamento no extrato: só com valor IGUAL e favorecido de nome compatível; valor igual com outra pessoa NÃO marca", () => {
  const contaAberta = titulo({ forn: "BRUNA SINTETICA LIMA", valor: 7300, venc: "2026-10-30" });
  const certo = saida("2026-10-30", 7300, "DEBITO TRANSFERENCIA PIX / BRUNA SINTETICA LIM");
  const outraPessoa = saida("2026-10-30", 7300, "DEBITO TRANSFERENCIA PIX / Pessoa Diferente Teste");
  const valorDiferente = saida("2026-10-30", 7200, "PIX / BRUNA SINTETICA");
  const foraDaJanela = saida("2027-01-30", 7300, "PIX / BRUNA SINTETICA");
  const jaVinculada = saida("2026-10-30", 7300, "PIX / BRUNA SINTETICA", 7300);
  assert.deepEqual(saidasCompativeis(contaAberta, [outraPessoa, valorDiferente, foraDaJanela, jaVinculada]), []);
  assert.deepEqual(saidasCompativeis(contaAberta, [certo, outraPessoa]).map((s) => s.id), [certo.id]);
  assert.ok(marcasDaConta(contaAberta, { todas: [contaAberta], saidas: [certo] }).includes("possível pagamento no extrato, NÃO confirmado"));
  // fornecedor genérico não tem nome para conferir: nunca é marcado
  const generica = titulo({ forn: "Fornecedor a identificar", valor: 8000, venc: "2026-09-25", desc: "Diária Diarista Teste" });
  assert.deepEqual(saidasCompativeis(generica, [saida("2026-09-17", 8000, "PIX / Diarista Teste")]), []);
  // conta paga não é candidata
  assert.deepEqual(saidasCompativeis(titulo({ forn: "BRUNA SINTETICA", valor: 7300, pago: 7300 }), [certo]), []);
});

t("A2-C4 duplicidade: mesmo fornecedor identificado, mesmo valor, até 7 dias; conta sem fornecedor × gêmea JÁ PAGA do fornecedor citado, mês igual", () => {
  const a = titulo({ forn: "Clara Teste", valor: 15000, venc: "2026-11-03", desc: "VR 01/11 a 15/11" });
  const b = titulo({ forn: "Clara Teste", valor: 15000, venc: "2026-11-16", desc: "VR 16/11 a 30/11", pago: 15000 });
  assert.equal(marcasDaConta(a, { todas: [a, b] }).includes("possível duplicidade"), false, "13 dias e outro período: não é duplicidade");
  const c = titulo({ forn: "Clara Teste", valor: 15000, venc: "2026-11-05" });
  assert.ok(marcasDaConta(a, { todas: [a, c] }).includes("possível duplicidade"));
  const contab = titulo({ forn: "Fornecedor a identificar", valor: 60000, venc: "2026-09-10", desc: "Contabilidade 09/2026 – Escritório Contábil Teste" });
  const contadorSet = titulo({ forn: "Escritório Contábil Teste", valor: 60000, venc: "2026-11-13", desc: "Contador/Setembro/26", pago: 61234, saldo: 0, situacao: "PAGO" });
  const contadorOut = titulo({ forn: "Escritório Contábil Teste", valor: 60000, venc: "2026-11-16", desc: "Contador Outubro/2026", pago: 61111, saldo: 0, situacao: "PAGO" });
  const abertaDoForn = titulo({ forn: "Escritório Contábil Teste", valor: 60000, venc: "2026-10-10", desc: "Contador" });
  assert.deepEqual(contasParecidas(contab, [contab, contadorSet, contadorOut, abertaDoForn]).map((x) => x.id), [contadorSet.id], "só a paga e do mesmo mês");
  assert.equal(mesCitado("Contador/Setembro/26"), "09"); assert.equal(mesCitado("Contabilidade 09/2026 – Escritório X"), "09"); assert.equal(mesCitado("Taxa manutenção"), null);
});

t("A2-C5 ajuste manual no saldo é sinalizado para revisão (fato), e fornecedor genérico aparece como 'fornecedor não identificado'", () => {
  const mf = titulo({ forn: "Funcionária Teste", valor: 10000, ajuste: 5000, venc: "2026-11-03" });
  assert.ok(marcasDaConta(mf, { todas: [mf] }).includes("revisar: ajuste de +R$ 50,00"));
  const l = contasVencidas({ todas: [titulo({ forn: "Fornecedor a identificar", desc: "Folha 08/2026", valor: 311111, venc: "2026-09-04" })], hoje: HOJE });
  assert.match(l.join("\n"), /fornecedor não identificado · Folha 08\/2026 — R\$ 3\.111,11 \(vencida\)/);
  assert.equal(descricaoSemFornecedor("Entregador Próprio — Entregador Teste — Semana 02", "Entregador Teste"), "Entregador Próprio — Semana 02");
});

// ------------------------------------------------------------------------------------------------------- consultas

t("A2-C6 vencidas: total, mais antiga, MAIORES primeiro, parcial com quanto foi pago; vencida ≠ prova de não pagamento", () => {
  const todas = [
    titulo({ forn: "Pequena", valor: 5000, venc: "2026-08-10" }),
    titulo({ forn: "Grande", valor: 512340, venc: "2026-11-18" }),
    titulo({ forn: "Parcial", valor: 200000, pago: 170000, venc: "2026-09-02" }),
    titulo({ forn: "Futura", valor: 99900, venc: "2026-11-30" }),
    titulo({ forn: "Paga", valor: 1000, pago: 1000, venc: "2026-09-01" }),
  ];
  const l = contasVencidas({ todas, hoje: HOJE, saidas: [] });
  assert.match(l[0], /3 contas, R\$ 5\.473,40; a mais antiga venceu em 10\/08\/2026; maiores primeiro/);
  assert.match(l[1], /Grande/); assert.match(l[2], /Parcial · Compra — R\$ 300,00 \(vencida, parcial, pago R\$ 1\.700,00 de R\$ 2\.000,00\)/); assert.match(l[3], /Pequena/);
  assert.doesNotMatch(l.join("\n"), /Futura|Paga/);
  assert.match(l.at(-1), /não prova que não houve pagamento no banco/);
  assert.deepEqual(contasVencidas({ todas: [titulo({ venc: "2026-12-01" })], hoje: HOJE }), ["nenhuma conta a pagar registrada como vencida até 22/11/2026"]);
});

t("A2-C7 sem comprovante: abertas sem documento + pagas sem comprovante (conta e pagamento); quitada por ajuste (pago 0) não entra", () => {
  const todas = [
    titulo({ forn: "Aberta", valor: 10000 }),
    titulo({ forn: "AbertaComDoc", valor: 10000, docs: [{ tipo: "BOLETO" }] }),
    titulo({ forn: "PagaSem", valor: 5000, pago: 5000 }),
    titulo({ forn: "PagaComComprovante", valor: 5000, pago: 5000, docPagamento: [{ tipo: "COMPROVANTE" }] }),
    titulo({ forn: "QuitadaPorAjuste", valor: 3000, ajuste: -3000, pago: 0, saldo: 0, situacao: "PAGO" }),
  ];
  const agregado = contasSemComprovante({ todas, detalhe: false });
  assert.deepEqual(agregado, ["em aberto sem documento anexado: 1 conta, R$ 100,00", "pagas sem comprovante anexado: 1 conta, R$ 50,00 (pagamento registrado sem documento)"]);
  const det = contasSemComprovante({ todas, detalhe: true }).join("\n");
  assert.match(det, /Aberta · Compra — R\$ 100,00/); assert.match(det, /PagaSem · Compra — R\$ 50,00 \(paga\)/);
  assert.doesNotMatch(det, /AbertaComDoc|PagaComComprovante|QuitadaPorAjuste/);
  assert.match(det, /documento anexado não confirma pagamento/);
});

t("A2-C8 conciliação: saídas sem vínculo (cobertura do extrato) + contas com possível pagamento, ambíguo quando há duas saídas; nunca 'pago'", () => {
  const a = titulo({ forn: "BRUNA SINTETICA", valor: 7300, venc: "2026-10-30" });
  const m = titulo({ forn: "PRODUTOS ALVORADA LTDA", valor: 2950, venc: "2026-10-31" });
  const saidas = [saida("2026-10-30", 7300, "PIX / BRUNA SINTETICA"), saida("2026-11-03", 2950, "PIX / PRODUTOS ALVORADA LTDA"), saida("2026-11-04", 2950, "PIX / ALVORADA"), saida("2026-09-01", 50000, "PIX / OUTRO", 50000)];
  const l = pagamentosAConciliar({ todas: [a, m], saidas, detalhe: true }).join("\n");
  assert.match(l, /saídas do extrato ainda sem vínculo com conta a pagar: 3, R\$ 132,00 \(extrato importado com saídas de 30\/10\/2026 a 04\/11\/2026\)/);
  assert.match(l, /possível pagamento no extrato .*: 2, R\$ 102,50 — NÃO confirmado/);
  assert.match(l, /BRUNA SINTETICA .* ↔ saída de R\$ 73,00 em 30\/10/);
  assert.match(l, /PRODUTOS ALVORADA LTDA .* ↔ 2 saídas compatíveis \(ambíguo\)/);
  assert.doesNotMatch(l, /\bpaga\b/i);
  assert.doesNotMatch(l.replace(/NÃO confirmado/g, ""), /confirmad/i, "todo 'confirmado' vem com NÃO");
  assert.doesNotMatch(pagamentosAConciliar({ todas: [a, m], saidas, detalhe: false }).join("\n"), /BRUNA|ALVORADA/, "agregado não nomeia");
});

t("A2-C9 maiores, parciais e fornecedores: ordem, porcentagem, quanto falta; sem fornecedor identificado fica à parte", () => {
  const todas = Array.from({ length: 12 }, (_, i) => titulo({ forn: `F${String(i).padStart(2, "0")}`, valor: (i + 1) * 1000, venc: "2026-11-30" }));
  const mx = maioresContas({ todas, detalhe: true });
  assert.match(mx[0], /12 contas, R\$ 780,00; as 10 maiores somam R\$ 750,00 \(96% do total\)/);
  assert.match(mx[1], /F11 · Compra — R\$ 120,00/); assert.equal(mx.length, 11);
  const p = contasParciais({ todas: [titulo({ forn: "G", valor: 50000, pago: 48700, venc: "2026-11-11" }), titulo({ forn: "H", valor: 100 })], detalhe: true });
  assert.match(p[0], /1 conta, faltam R\$ 13,00 \(pago registrado R\$ 487,00\)/); assert.match(p[1], /falta R\$ 13,00/);
  const fs = fornecedoresComPendencias({ hoje: HOJE, detalhe: true, todas: [
    titulo({ forn: "Distribuidora X", valor: 512340, venc: "2026-11-18" }), titulo({ forn: "Distribuidora X", valor: 41000, venc: "2026-11-09" }),
    titulo({ forn: "Energia", valor: 123456, venc: "2026-11-30" }), titulo({ forn: "Fornecedor a identificar", valor: 311111, venc: "2026-09-04" }), titulo({ forn: null, valor: 100 })] });
  assert.match(fs[0], /2 fornecedores identificados com contas em aberto; 2 contas sem fornecedor identificado \(R\$ 3\.112,11\)/);
  assert.match(fs[1], /Distribuidora X — 2 contas, R\$ 5\.533,40 \(2 vencidas\)/); assert.match(fs[2], /Energia — 1 conta, R\$ 1\.234,56$/);
  assert.deepEqual(fornecedoresComPendencias({ todas: [], hoje: HOJE, detalhe: true }), ["nenhuma conta a pagar em aberto"]);
});

t("A2-C10 mensagem longa (200 contas): cabe no limite e diz quantas ficaram de fora, com o valor (nada some calado)", () => {
  const todas = Array.from({ length: 200 }, (_, i) => titulo({ forn: `Fornecedor com nome comprido ${i}`, desc: "Descrição longa de uma conta qualquer do mês", valor: 1000 + i, venc: "2026-10-01" }));
  for (const l of [contasVencidas({ todas, hoje: HOJE, saidas: [] }), contasSemComprovante({ todas, detalhe: true }), maioresContas({ todas, detalhe: true })]) {
    assert.ok(l.join("\n").length < 3600, String(l.join("\n").length));
  }
  const v = contasVencidas({ todas, hoje: HOJE, saidas: [] });
  const fora = v.find((x) => x.startsWith("… e mais"));
  const mostradas = v.filter((x) => /^\d\d\/\d\d · /.test(x)).length;
  assert.match(fora, new RegExp(`e mais ${200 - mostradas} contas`));
});

// --------------------------------------------------------------------------------------------- explicação de uma conta

t("A2-C11 explicação: UMA conta ⇒ fatos (vencimento, valor, pago, saldo, documentos, classificação) e limites; várias ⇒ alternativas sem escolher", () => {
  const dist = titulo({ forn: "DISTRIBUIDORA SINTÉTICA", desc: "Insumos da semana", valor: 512340, venc: "2026-11-18" });
  const dist2 = titulo({ forn: "DISTRIBUIDORA SINTÉTICA", valor: 41000, venc: "2026-11-09" });
  const todas = [dist, dist2, titulo({ forn: "Outra" })];
  const um = explicarConta({ todas, busca: { termos: ["distribuidora"], valorCentavos: 512340 }, hoje: HOJE, saidas: [saida("2026-11-10", 1, "x")] }).join("\n");
  assert.match(um, /vencimento 18\/11\/2026; competência 11\/2026; valor R\$ 5\.123,40; pago registrado R\$ 0,00; saldo R\$ 5\.123,40/);
  assert.match(um, /registrada como vencida há 4 dias/); assert.match(um, /nenhum documento anexado/);
  assert.match(um, /nenhuma saída do extrato sem vínculo com o mesmo valor e favorecido compatível \(extrato importado com saídas de 10\/11\/2026 a 10\/11\/2026\)/);
  const varias = explicarConta({ todas, busca: { termos: ["distribuidora"] }, hoje: HOJE, saidas: [] });
  assert.match(varias[0], /encontrei 2 contas com distribuidora; diga qual/);
  assert.equal(varias.length, 3, "lista as duas, não escolhe");
  assert.match(explicarConta({ todas, busca: { termos: ["inexistente"] }, hoje: HOJE })[0], /não encontrei conta a pagar com inexistente/);
});

t("A2-C12 'já foi paga?': responde pelo registro do Financeiro (paga, em parte, sem pagamento) e nunca pelo extrato", () => {
  const pergunta = "a conta da Bruna já foi paga?";
  const paga = explicarConta({ todas: [titulo({ forn: "Bruna", valor: 25000, pago: 25000, docPagamento: [{}] })], busca: { termos: ["bruna"] }, hoje: HOJE, pergunta }).join("\n");
  assert.match(paga, /sim: o Financeiro registra a conta como paga \(R\$ 250,00\)/); assert.match(paga, /com comprovante/);
  const parte = explicarConta({ todas: [titulo({ forn: "Bruna", valor: 10000, pago: 4000 })], busca: { termos: ["bruna"] }, hoje: HOJE, pergunta }).join("\n");
  assert.match(parte, /em parte: o Financeiro registra R\$ 40,00 pago e R\$ 60,00 em aberto/);
  const aberta = titulo({ forn: "BRUNA SINTETICA", valor: 7300, venc: "2026-10-30" });
  const nao = explicarConta({ todas: [aberta], busca: { termos: ["bruna"] }, hoje: HOJE, pergunta, saidas: [saida("2026-10-30", 7300, "PIX / BRUNA SINTETICA")] }).join("\n");
  assert.match(nao, /não há pagamento registrado no Financeiro/);
  assert.match(nao, /possível pagamento no extrato: saída de R\$ 73,00 em 30\/10\/2026 .*NÃO confirmado/);
  const semExtrato = explicarConta({ todas: [aberta], busca: { termos: ["bruna"] }, hoje: HOJE, extratoFalhou: true }).join("\n");
  assert.match(semExtrato, /conferência com o extrato indisponível agora/);
});

t("A2-C13 mês: o citado na descrição manda ('Contabilidade 08/2026' não é a de setembro, mesmo com competência 09); conta parecida paga é apontada", () => {
  const ago = titulo({ forn: "Fornecedor a identificar", desc: "Contabilidade 08/2026 – Escritório Contábil Teste", valor: 60000, venc: "2026-08-10", comp: "2026-09" });
  const set = titulo({ forn: "Fornecedor a identificar", desc: "Contabilidade 09/2026 – Escritório Contábil Teste", valor: 60000, venc: "2026-09-10" });
  const gemea = titulo({ forn: "Escritório Contábil Teste", desc: "Contador/Setembro/26", valor: 60000, venc: "2026-11-13", pago: 61234, saldo: 0, situacao: "PAGO" });
  assert.deepEqual(buscarContas([ago, set, gemea], { termos: ["contabilidade"], competencia: "2026-09" }).map((x) => x.id), [set.id]);
  const l = explicarConta({ todas: [ago, set, gemea], busca: { termos: ["contabilidade"], competencia: "2026-09" }, hoje: HOJE, saidas: [] }).join("\n");
  assert.match(l, /registrada como vencida há 73 dias/);
  assert.match(l, /fornecedor não identificado no cadastro/);
  assert.match(l, /conta parecida já registrada: Escritório Contábil Teste · Contador\/Setembro\/26 · R\$ 600,00, venc\. 13\/11\/2026 \(paga\) — possível duplicidade/);
});

// ------------------------------------------------------------------------------------- motor (grupo, perfis, isolamento)

const ESTRANHO = "5500000000299@s.whatsapp.net";
const SOCIO = "5500000000211@s.whatsapp.net";
const grupoCom = (participantes) => ({ ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO", participantes } : g)) });
const SO_FIN = [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }];
const retrato = (s, membros, em = AGORA) => s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: em.toISOString() });
const doGrupo = async (s) => (await s.saida()).filter((x) => x.destino === GRUPO);
const PERGUNTAS = ["MOVA, quais contas estão vencidas da alfa?", "MOVA, quais contas estão sem comprovante da alfa?", "MOVA, quais pagamentos precisam de conciliação na alfa?",
  "MOVA, quais são as maiores contas em aberto da alfa?", "MOVA, quais contas estão parcialmente pagas na alfa?", "MOVA, quais fornecedores possuem mais contas pendentes na alfa?"];

t("A2-C14 grupo só com FINANCEIRO: as consultas respondem no grupo com fornecedor e posição; sem IA, sem proposta, sem operação", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-10", 30000); await s.conta("2026-10-12", 12345);
  await retrato(s, [FIN, SOCIO]);
  for (const p of PERGUNTAS) {
    await s.enviar(gw({ texto: p }));
    const h = await s.ultima();
    assert.deepEqual([h.decisao, h.interpretacao], ["CONSULTA", "COMANDO"], p);
  }
  const respostas = await doGrupo(s);
  assert.equal(respostas.length, PERGUNTAS.length);
  assert.match(respostas[0].texto, /Loja Alfa — posição de 15\/10\/2026:/);
  assert.match(respostas[0].texto, /2 contas, R\$ 423,45; a mais antiga venceu em 10\/10\/2026/);
  assert.match(respostas[0].texto, /Fornecedor Sintético · Compra sintética — R\$ 300,00 \(vencida\)/);
  assert.match(respostas[5].texto, /Fornecedor Sintético — 2 contas, R\$ 423,45 \(2 vencidas\)/);
  for (const x of respostas) assert.ok(x.texto.length < 4096);
  assert.equal(s.cliente.pedidos.length, 0, "nenhuma chamada de IA");
  assert.ok(s.chamadas.length > 0);
  for (const ch of s.chamadas) assert.ok(OPERACOES_PERMITIDAS.includes(ch.nome) && /^(consultar|previaDo|detalhar)/.test(ch.nome), `só leitura: ${ch.nome}`);
  assert.equal(await s.contar("proposta"), 0);
});

t("A2-C15 explicação pelo motor: o nome da unidade na pergunta não atrapalha a busca; com membro CONSULTA só sai o agregado antigo", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-10", 30000);
  await retrato(s, [FIN, SOCIO]);
  await s.enviar(gw({ texto: "MOVA, me explique a conta do Fornecedor Sintético de R$ 300,00 da alfa" }));
  const [r] = await doGrupo(s);
  assert.match(r.texto, /Fornecedor Sintético · Compra sintética/);
  assert.match(r.texto, /valor R\$ 300,00; pago registrado R\$ 0,00; saldo R\$ 300,00/);
  assert.match(r.texto, /registrada como vencida há 5 dias/);
  const c = await cenario({ config: grupoCom([...SO_FIN, { ids: [CONS], perfil: "CONSULTA" }]) });
  await c.conta("2026-10-10", 30000);
  await retrato(c, [FIN, SOCIO, CONS]);
  await c.enviar(gw({ texto: "MOVA, me explique a conta do Fornecedor Sintético de R$ 300,00 da alfa" }));
  for (const p of PERGUNTAS) await c.enviar(gw({ texto: p }));
  for (const x of await doGrupo(c)) assert.doesNotMatch(x.texto, /Fornecedor Sintético|Compra sintética/, x.texto);
});

t("A2-C16 membro não autorizado ou retrato vencido: nada de lista no grupo; participante não autorizado não recebe resposta", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-10", 30000);
  await retrato(s, [FIN, SOCIO, ESTRANHO]);
  await s.enviar(gw({ texto: PERGUNTAS[0] }));
  for (const x of await doGrupo(s)) assert.doesNotMatch(x.texto, /Fornecedor Sintético|R\$/);
  const v = await cenario({ config: grupoCom(SO_FIN) });
  await v.conta("2026-10-10", 30000);
  await retrato(v, [FIN, SOCIO], new Date(AGORA.getTime() - 16 * 60_000));
  await v.enviar(gw({ texto: PERGUNTAS[3] }));
  for (const x of await doGrupo(v)) assert.doesNotMatch(x.texto, /Fornecedor Sintético|R\$/);
  const e = await cenario({ config: grupoCom(SO_FIN) });
  await retrato(e, [FIN, SOCIO, ESTRANHO]);
  const r = await e.enviar(gw({ texto: PERGUNTAS[0], de: ESTRANHO }));
  assert.equal(r.motivo, "PARTICIPANTE_NAO_AUTORIZADO");
  assert.equal((await e.saida()).length, 0);
});

t("A2-C17 isolamento entre unidades: conta da outra unidade (mesmo fornecedor e valor) nunca entra na resposta da Alfa", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-10", 30000);
  const fornBeta = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  await s.conta("2026-10-10", 77700, BETA, fornBeta);
  await retrato(s, [FIN, SOCIO]);
  for (const p of [...PERGUNTAS, "MOVA, me explique a conta do Fornecedor Sintético de R$ 777,00 da alfa"]) await s.enviar(gw({ texto: p }));
  const tudo = (await doGrupo(s)).map((x) => x.texto).join("\n");
  assert.doesNotMatch(tudo, /777,00 \(|R\$ 1\.077,00/, "o valor da Beta não aparece como conta nem soma");
  assert.match(tudo, /não encontrei conta a pagar com fornecedor sintetico, R\$ 777,00/);
});

t("A2-C18 pergunta repetida (mesma mensagem) não gera segunda resposta", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-10", 30000);
  await retrato(s, [FIN, SOCIO]);
  const ev = gw({ texto: PERGUNTAS[0] });
  await s.enviar(ev); await s.enviar(ev);
  assert.equal((await doGrupo(s)).length, 1);
});
