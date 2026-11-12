// Fase E — 12 (integridade de referências documentais) + estrutura de conciliação (1:1, 1:N, N:M, divergência).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_B, UNI_B, USUARIO, ctx, entrada, montarComCadastros, obrigacao, rejeita, saida, sha } from "./helpers/cenario.js";

const doc = (semente, extra = {}) => ({ origem: "UNICRED", arquivoId: `cofre://sintetico/${semente}`, hashSha256: sha(semente), tipo: "EXTRATO_BANCARIO", competencia: "2026-09", recebidoEm: "2026-10-02", ...extra });

test("documento guarda origem, hash, tipo, competência, responsável e versão", async () => {
  const { nucleo, c } = await montarComCadastros();
  const { documento } = await nucleo.registrarDocumento(c, doc("a1"));
  assert.deepEqual(
    [documento.origem, documento.hashSha256, documento.tipo, documento.competencia, documento.recebidoEm, documento.responsavelId, documento.versaoDocumento],
    ["UNICRED", sha("a1"), "EXTRATO_BANCARIO", "2026-09", "2026-10-02", USUARIO, 1],
  );
  // O mesmo arquivo (mesmo hash) não é registrado duas vezes.
  const de_novo = await nucleo.registrarDocumento(c, doc("a1"));
  assert.ok(de_novo.repetido && de_novo.documento.id === documento.id);
  await rejeita(nucleo.registrarDocumento(c, doc("a1", { tipo: "BOLETO" })), CODIGO.CONFLITO_IDEMPOTENCIA); // mesmo arquivo, ficha diferente
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "DOCUMENTO" })).length, 1);

  for (const hashSha256 of ["abc", sha("a1").slice(1), `${sha("a1")}0`, "z".repeat(64), null, 123]) await rejeita(nucleo.registrarDocumento(c, doc("b2", { hashSha256 })), CODIGO.DOCUMENTO_INVALIDO);
  await rejeita(nucleo.registrarDocumento(c, doc("b2", { tipo: "PLANILHA_QUALQUER" })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarDocumento(c, doc("b2", { arquivoId: "" })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarDocumento(c, doc("b2", { recebidoEm: "ontem" })), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.registrarDocumento(c, doc("b2", { conteudo: "bytes do arquivo" })), CODIGO.ENTRADA_INVALIDA); // o núcleo nunca recebe o arquivo
});

test("nova versão preserva a anterior e a cadeia de substituição", async () => {
  const { nucleo, c } = await montarComCadastros();
  const v1 = (await nucleo.registrarDocumento(c, doc("c1"))).documento;
  const v2 = (await nucleo.registrarDocumento(c, doc("c2", { substituiId: v1.id }))).documento;
  assert.deepEqual([v2.versaoDocumento, v2.substituiId], [2, v1.id]);
  const docs = await nucleo.consultarRegistros(c, { tipo: "DOCUMENTO" });
  assert.equal(docs.length, 2);
  assert.equal(docs.find((d) => d.id === v1.id).substituidoPorId, v2.id);
  assert.equal(docs.find((d) => d.id === v1.id).hashSha256, sha("c1")); // original intacto
  await rejeita(nucleo.registrarDocumento(c, doc("c3", { substituiId: v1.id })), CODIGO.DOCUMENTO_INVALIDO); // v1 já tem sucessora
  await rejeita(nucleo.registrarDocumento(c, doc("c4", { substituiId: "dddddddd-0000-4000-8000-000000000001" })), CODIGO.NAO_ENCONTRADO);
});

test("vínculo documental só existe entre documento e registro reais do mesmo escopo", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { documento } = await nucleo.registrarDocumento(c, doc("d1"));
  const { movimentacao } = await nucleo.registrarMovimentacao(c, saida(banco.id, 5000, { documentoId: documento.id }));
  assert.equal(movimentacao.documentoId, documento.id);
  const { vinculo } = await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "MOVIMENTACAO", registroId: movimentacao.id });
  assert.deepEqual([vinculo.documentoId, vinculo.registroTipo, vinculo.registroId], [documento.id, "MOVIMENTACAO", movimentacao.id]);
  assert.ok((await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "MOVIMENTACAO", registroId: movimentacao.id })).repetido);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" })).length, 1);

  const fantasma = "dddddddd-0000-4000-8000-000000000001";
  await rejeita(nucleo.vincularDocumento(c, { documentoId: fantasma, registroTipo: "MOVIMENTACAO", registroId: movimentacao.id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "MOVIMENTACAO", registroId: fantasma }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "OBRIGACAO", registroId: movimentacao.id }), CODIGO.NAO_ENCONTRADO); // tipo errado
  await rejeita(nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "CONTA", registroId: banco.id }), CODIGO.ENTRADA_INVALIDA);
  // Referência a documento inexistente é recusada em qualquer operação que a aceite.
  await rejeita(nucleo.registrarMovimentacao(c, saida(banco.id, 1, { documentoId: fantasma })), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { documentoIds: [fantasma] })), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: fantasma, valorCentavos: 1, motivo: "m", categoria: "c", documentoId: documento.id }), CODIGO.NAO_ENCONTRADO);
  // Documento de outra organização não serve de evidência aqui.
  const b = ctx(ORG_B, UNI_B);
  const docB = (await nucleo.registrarDocumento(b, doc("d1"))).documento; // mesmo hash, outro escopo: registro próprio
  assert.notEqual(docB.id, documento.id);
  await rejeita(nucleo.vincularDocumento(c, { documentoId: docB.id, registroTipo: "MOVIMENTACAO", registroId: movimentacao.id }), CODIGO.NAO_ENCONTRADO);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 0);
});

async function cenarioDeRepasse() {
  const m = await montarComCadastros();
  const recebiveis = [];
  for (const [i, valor] of [10000, 7000, 3000].entries()) {
    recebiveis.push((await m.nucleo.registrarRecebivel(m.c, { processador: "STONE", brutoCentavos: valor, competencia: "2026-09", fonte: { sistema: "STONE", idExterno: `RC-${i}` } })).recebivel);
  }
  const repasse = (await m.nucleo.registrarMovimentacao(m.c, entrada(m.banco.id, 20000))).movimentacao;
  const evidencia = (await m.nucleo.registrarDocumento(m.c, doc("e1", { origem: "STONE", tipo: "RELATORIO_PROCESSADOR" }))).documento;
  const ref = (tipo, r, valorCentavos) => ({ tipo, id: r.id, valorCentavos });
  return { ...m, recebiveis, repasse, evidencia, ref };
}

test("correspondência um-para-muitos: candidata → confirmada, com evidência, responsável e data", async () => {
  const { nucleo, c, recebiveis, repasse, evidencia, ref } = await cenarioDeRepasse();
  const cand = await nucleo.criarCorrespondenciaCandidata(c, {
    ladoA: [ref("MOVIMENTACAO", repasse, 20000)],
    ladoB: [ref("RECEBIVEL", recebiveis[0], 10000), ref("RECEBIVEL", recebiveis[1], 7000), ref("RECEBIVEL", recebiveis[2], 3000)],
    evidenciaDocumentoIds: [evidencia.id],
  });
  assert.deepEqual([cand.situacao, cand.diferencaCentavos, cand.responsavelId, cand.decididoEm], ["CANDIDATA", 0, null, null]);
  // Candidata não muda nada nos registros: é só uma proposta.
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0].situacaoConciliacao, "NAO_CONCILIADA");

  const conf = await nucleo.confirmarConciliacao(c, { correspondenciaId: cand.id });
  assert.deepEqual([conf.situacao, conf.responsavelId, conf.evidenciaDocumentoIds], ["CONFIRMADA", USUARIO, [evidencia.id]]);
  assert.ok(conf.decididoEm);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0].situacaoConciliacao, "CONCILIADA");
  await rejeita(nucleo.confirmarConciliacao(c, { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA); // decisão é única
  // Conciliar não liquida nem cria resultado: são conceitos separados.
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 0);
});

test("o mesmo valor não é conciliado duas vezes", async () => {
  const { nucleo, c, recebiveis, repasse, ref } = await cenarioDeRepasse();
  const primeira = await nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 10000)], ladoB: [ref("RECEBIVEL", recebiveis[0], 10000)] });
  const duplicada = await nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 10000)], ladoB: [ref("RECEBIVEL", recebiveis[0], 10000)] });
  await nucleo.confirmarConciliacao(c, { correspondenciaId: primeira.id });
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0].situacaoConciliacao, "PARCIAL"); // 100 de 200
  await rejeita(nucleo.confirmarConciliacao(c, { correspondenciaId: duplicada.id }), CODIGO.CONCILIACAO_INVALIDA); // recebível 0 já está todo conciliado
  const rej = await nucleo.rejeitarCorrespondencia(c, { correspondenciaId: duplicada.id, justificativa: "Duplicada da anterior" });
  assert.equal(rej.situacao, "REJEITADA");
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 20001)], ladoB: [ref("RECEBIVEL", recebiveis[0], 10000)] }), CODIGO.CONCILIACAO_INVALIDA); // acima do valor do registro
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 100)], ladoB: [ref("MOVIMENTACAO", repasse, 100)] }), CODIGO.CONCILIACAO_INVALIDA); // registro com ele mesmo
});

test("lados que não fecham viram divergência documentada, nunca confirmação", async () => {
  const { nucleo, c, recebiveis, repasse, ref } = await cenarioDeRepasse();
  const cand = await nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 20000)], ladoB: [ref("RECEBIVEL", recebiveis[0], 10000), ref("RECEBIVEL", recebiveis[1], 7000)] });
  assert.equal(cand.diferencaCentavos, 3000);
  await rejeita(nucleo.confirmarConciliacao(c, { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA);
  await rejeita(nucleo.registrarDivergencia(c, { correspondenciaId: cand.id }), CODIGO.CONCILIACAO_INVALIDA); // sem justificativa
  const div = await nucleo.registrarDivergencia(c, { correspondenciaId: cand.id, justificativa: "Repasse R$ 30,00 acima dos recebíveis identificados" });
  assert.deepEqual([div.situacao, div.diferencaCentavos, div.justificativaDecisao], ["DIVERGENTE", 3000, "Repasse R$ 30,00 acima dos recebíveis identificados"]);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0].situacaoConciliacao, "NAO_CONCILIADA");
  const h = await nucleo.consultarHistorico(c, { registroTipo: "CORRESPONDENCIA", registroId: cand.id });
  assert.deepEqual(h.map((e) => [e.evento, e.depois.situacao]), [["CRIACAO", "CANDIDATA"], ["CONCILIACAO", "DIVERGENTE"]]);
});

test("muitos-para-muitos exige justificativa; referências precisam existir no escopo", async () => {
  const { nucleo, c, banco, recebiveis, repasse, ref } = await cenarioDeRepasse();
  const repasse2 = (await nucleo.registrarMovimentacao(c, entrada(banco.id, 5000, { dataEfetiva: "2026-09-23" }))).movimentacao;
  const nm = { ladoA: [ref("MOVIMENTACAO", repasse, 12000), ref("MOVIMENTACAO", repasse2, 5000)], ladoB: [ref("RECEBIVEL", recebiveis[0], 10000), ref("RECEBIVEL", recebiveis[1], 7000)] };
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, nm), CODIGO.CONCILIACAO_INVALIDA);
  const cand = await nucleo.criarCorrespondenciaCandidata(c, { ...nm, justificativa: "Lote de dois dias pago em dois créditos" });
  assert.equal(cand.diferencaCentavos, 0);
  assert.equal((await nucleo.confirmarConciliacao(c, { correspondenciaId: cand.id })).situacao, "CONFIRMADA");

  const fantasma = { tipo: "RECEBIVEL", id: "dddddddd-0000-4000-8000-000000000001", valorCentavos: 100 };
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 100)], ladoB: [fantasma] }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 100)], ladoB: [] }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("LANCAMENTO", repasse, 100)], ladoB: [ref("RECEBIVEL", recebiveis[2], 100)] }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.criarCorrespondenciaCandidata(c, { ladoA: [ref("MOVIMENTACAO", repasse, 100)], ladoB: [ref("RECEBIVEL", recebiveis[2], 100)], evidenciaDocumentoIds: [fantasma.id] }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.criarCorrespondenciaCandidata(ctx(ORG_B, UNI_B), { ladoA: [ref("MOVIMENTACAO", repasse, 100)], ladoB: [ref("RECEBIVEL", recebiveis[2], 100)] }), CODIGO.NAO_ENCONTRADO);
});
