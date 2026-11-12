// Preparação da conciliação entre registros importados (sintéticos): candidatas com regra e força, N:1, ambiguidade,
// falta de fonte e "aguardando documento". Nenhuma correspondência real é declarada concluída.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, foodyEntregas, ifoodApuracao, stoneRecebimentos, stoneVendas, unicredExtrato } from "./helpers/arquivos.js";

const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };

async function importar(nucleo, fonte, tipoRelatorio, conteudo) {
  const r = await nucleo.receberArquivoParaImportacao(ctx(), { fonte, tipoRelatorio, tipoMime: "text/csv", conteudo, ...PERIODO_SETEMBRO });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const extra = r.previa.totalDivergencias ? ACEITE : {};
  return nucleo.confirmarImportacao(ctx(), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...extra });
}

test("repasse Stone de várias transações × um crédito Unicred: candidata N:1 (FRACA) que fecha e pode ser confirmada com evidência", async () => {
  const { nucleo, repositorio } = montar();
  await importar(nucleo, "STONE", "STONE_VENDAS", stoneVendas([
    { id: "T-1", quando: "01/09/2026 10:00", bruto: 2000, mdr: 30 },
    { id: "T-2", quando: "01/09/2026 11:00", bruto: 3000, mdr: 45 },
    { id: "T-3", quando: "01/09/2026 12:00", bruto: 1000, mdr: 15 },
  ]));
  await importar(nucleo, "STONE", "STONE_RECEBIMENTOS", stoneRecebimentos([
    { data: "02/09/2026", transacao: "T-1", liquido: 1970 }, { data: "02/09/2026", transacao: "T-2", liquido: 2955 }, { data: "02/09/2026", transacao: "T-3", liquido: 985 },
  ]));
  await importar(nucleo, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 0, lancamentos: [{ data: "02/09/2026", historico: "CRED STONE", valor: 5910 }] }));

  const tr = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "STONE_X_RECEBIMENTO", ...PERIODO_SETEMBRO });
  assert.equal(tr.criadas, 3);
  const g = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "RECEBIMENTO_STONE_X_UNICRED", ...PERIODO_SETEMBRO });
  assert.equal(g.criadas, 1);
  assert.equal(g.ambiguas, 0);
  // Gerar de novo não duplica candidatas.
  assert.deepEqual((await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "RECEBIMENTO_STONE_X_UNICRED", ...PERIODO_SETEMBRO })).criadas, 0);

  const [cand] = await repositorio.leitura((tx) => tx.listar(ctx(), "CORRESPONDENCIA", { onde: { relacao: "RECEBIMENTO_STONE_X_UNICRED" } }), { escopo: ctx() });
  assert.equal(cand.ladoA.length, 3);
  assert.equal(cand.ladoB.length, 1);
  assert.equal(cand.forca, "FRACA");
  assert.equal(cand.diferencaCentavos, 0);
  assert.ok(cand.evidenciaDocumentoIds.length >= 2); // documentos de origem dos dois lados
  const conf = await nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cand.id, justificativa: "Repasse do dia conferido no extrato e no relatório (sintético)." });
  assert.equal(conf.situacao, "CONFIRMADA");
});

test("confirmação AMBÍGUA é recusada: dois créditos iguais disputam o mesmo repasse — rejeitar o errado libera o certo", async () => {
  const { nucleo, repositorio } = montar();
  await importar(nucleo, "IFOOD", "IFOOD_APURACAO", ifoodApuracao([
    { data: "07/09/2026", tipo: "Vendas", valor: 5000 }, { data: "07/09/2026", tipo: "Repasse previsto", valor: 5000 }, { data: "08/09/2026", tipo: "Repasse pago", valor: 5000 },
  ]));
  await importar(nucleo, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 0, lancamentos: [
    { data: "08/09/2026", historico: "PIX RECEBIDO CLIENTE", valor: 5000 },
    { data: "09/09/2026", historico: "CRED IFOOD REPASSE", valor: 5000 },
  ] }));
  const g = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "IFOOD_X_UNICRED", ...PERIODO_SETEMBRO });
  assert.equal(g.criadas, 2);
  assert.equal(g.ambiguas, 2);
  const cands = await repositorio.leitura((tx) => tx.listar(ctx(), "CORRESPONDENCIA", { onde: { relacao: "IFOOD_X_UNICRED" } }), { escopo: ctx() });
  await rejeita(nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cands[0].id }), CODIGO.CONCILIACAO_INVALIDA);
  await rejeita(nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cands[1].id }), CODIGO.CONCILIACAO_INVALIDA);
  await rejeita(nucleo.rejeitarCorrespondencia(ctx(), { correspondenciaId: cands[0].id }), CODIGO.CONCILIACAO_INVALIDA); // rejeitar exige justificativa
  await nucleo.rejeitarCorrespondencia(ctx(), { correspondenciaId: cands[0].id, justificativa: "Crédito é Pix de cliente, não repasse." });
  const ok = await nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cands[1].id, justificativa: "Histórico do extrato identifica o repasse." });
  assert.equal(ok.situacao, "CONFIRMADA");
});

test("operação sem fonte suficiente: crédito sem par fica SEM candidata (nada é inventado nem confirmado)", async () => {
  const { nucleo } = montar();
  await importar(nucleo, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 0, lancamentos: [
    { data: "10/09/2026", historico: "TED RECEBIDA", valor: 77700 }, { data: "11/09/2026", historico: "TARIFA", valor: -990 },
  ] }));
  for (const relacao of ["RECEBIMENTO_STONE_X_UNICRED", "IFOOD_X_UNICRED", "FOODY_X_UNICRED"]) {
    const g = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao, ...PERIODO_SETEMBRO });
    assert.equal(g.criadas, 0, relacao);
    assert.ok(g.semCandidato >= 1, relacao);
  }
  await rejeita(nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "MANUAL", ...PERIODO_SETEMBRO }), CODIGO.CONCILIACAO_INVALIDA);
});

test("Foody × Unicred: pagamento do entregador fica AGUARDANDO DOCUMENTO até haver comprovante; depois pode ser decidido", async () => {
  const { nucleo, repositorio } = montar();
  await importar(nucleo, "FOODY", "FOODY_ENTREGAS", foodyEntregas([
    { pedido: "F-1", data: "02/09/2026", entregador: "Entregador Alfa", taxa: 700, custo: 600 },
    { pedido: "F-2", data: "03/09/2026", entregador: "Entregador Alfa", taxa: 700, custo: 650 },
  ], { subtotais: { "Entregador Alfa": 1250 }, total: 1250 }));
  await importar(nucleo, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 5000, lancamentos: [{ data: "05/09/2026", historico: "PIX ENVIADO", valor: -1250 }] }));
  const g = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "FOODY_X_UNICRED", ...PERIODO_SETEMBRO });
  assert.equal(g.criadas, 1);
  const [cand] = await repositorio.leitura((tx) => tx.listar(ctx(), "CORRESPONDENCIA", { onde: { relacao: "FOODY_X_UNICRED" } }), { escopo: ctx() });
  assert.equal(cand.forca, "FRACA");
  await rejeita(nucleo.marcarAguardandoDocumento(ctx(), { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA);
  const aguardando = await nucleo.marcarAguardandoDocumento(ctx(), { correspondenciaId: cand.id, justificativa: "Falta comprovante do Pix com o destinatário." });
  assert.equal(aguardando.situacao, "AGUARDANDO_DOCUMENTO");
  const decidida = await nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cand.id, justificativa: "Comprovante anexado (sintético)." });
  assert.equal(decidida.situacao, "CONFIRMADA");
  // Registro já conciliado não entra de novo em outra confirmação acima do próprio valor (regra herdada da 01).
  await rejeita(nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA);
});

test("registro de fonte substituído por versão corrigida não pode ser conciliado", async () => {
  const { nucleo, repositorio } = montar();
  const v1 = await nucleo.receberArquivoParaImportacao(ctx(), { fonte: "UNICRED", tipoRelatorio: "UNICRED_EXTRATO", tipoMime: "text/csv", ...PERIODO_SETEMBRO,
    conteudo: unicredExtrato({ saldoInicial: 0, lancamentos: [{ data: "02/09/2026", historico: "CRED STONE", valor: 5910 }] }) });
  await nucleo.confirmarImportacao(ctx(), { importacaoId: v1.importacao.id, impressaoPrevia: v1.importacao.impressaoPrevia });
  await importar(nucleo, "STONE", "STONE_RECEBIMENTOS", stoneRecebimentos([{ data: "02/09/2026", transacao: "T-1", liquido: 5910 }]));
  await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "RECEBIMENTO_STONE_X_UNICRED", ...PERIODO_SETEMBRO });
  const [cand] = await repositorio.leitura((tx) => tx.listar(ctx(), "CORRESPONDENCIA"), { escopo: ctx() });
  const v2 = await nucleo.receberArquivoParaImportacao(ctx(), { fonte: "UNICRED", tipoRelatorio: "UNICRED_EXTRATO", tipoMime: "text/csv", ...PERIODO_SETEMBRO, substituiImportacaoId: v1.importacao.id,
    conteudo: unicredExtrato({ saldoInicial: 0, lancamentos: [{ data: "02/09/2026", historico: "CRED STONE PAGAMENTOS", valor: 5910 }] }) });
  await nucleo.confirmarImportacao(ctx(), { importacaoId: v2.importacao.id, impressaoPrevia: v2.importacao.impressaoPrevia });
  await rejeita(nucleo.confirmarConciliacao(ctx(), { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA);
});
