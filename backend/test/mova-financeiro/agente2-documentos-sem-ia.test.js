// Agente 2 — RECEBIMENTO DE DOCUMENTOS SEM IA e CENTRAL DE PENDÊNCIAS. Tudo SINTÉTICO: arquivos fabricados aqui, grupos e números
// fictícios, nenhum valor real. Nenhuma chamada de IA, nenhuma escrita no Financeiro, nenhuma resposta real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ALFA, BETA, CONS, ESTRANHO, FIN, GRUPO, ORG, OPER, cenario, gw, t } from "./helpers/operacao.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";
import { ACAO } from "../../src/modules/financeiro-v2/index.js";
import { CONSULTAS_MOVA, ACOES_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { conferirArquivo, formatoConfere, legendaDoDocumento, pdfComConteudoAtivo, RESPOSTA_DOCUMENTO } from "../../src/modules/mova-financeiro/aplicacao/recebimentoDocumental.js";
import { MOTIVO, MOTIVO_SAIDA, classificarSaidas, contasRelacionadas, favorecidoDaSaida, mesmaPessoa, montarConferencia, pendenciaDaConta } from "../../src/modules/mova-financeiro/aplicacao/centralConferencia.js";

const PDF = (s = "comprovante sintético") => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${s}\n%%EOF\n`, "latin1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR sintético png")]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(40, 1)]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const midia = (bytes, mime) => ({ mime, nomeArquivo: null, tamanhoBytes: bytes.length, base64: Buffer.from(bytes).toString("base64") });
const doc = (bytes, { texto = "MOVA, comprovante da alfa", mime = "application/pdf", de = FIN, respostaA = null } = {}) =>
  ({ ...gw({ texto, de, respostaA }), tipo: mime.startsWith("image/") ? "IMAGEM" : mime.startsWith("audio/") ? "AUDIO" : "DOCUMENTO", midia: midia(bytes, mime) });
const SEM_IA = { recebimentoDocumental: true, somenteConsultas: true };
const recebidos = (s, unidadeId = ALFA) => s.mova.armazenamento.documentosRecebidos.listar({ organizacaoId: ORG, unidadeId });

// ---------------------------------------------------------------------------------------------------------- arquivo
t("A2-R1 arquivo: assinatura confere com o tipo; .exe renomeado e PDF com script são recusados; hash do guardado é conferido", () => {
  assert.equal(formatoConfere(PDF(), "application/pdf"), true);
  assert.equal(formatoConfere(PNG, "image/png"), true);
  assert.equal(formatoConfere(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg"), true);
  assert.equal(formatoConfere(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp"), true);
  assert.equal(formatoConfere(EXE, "application/pdf"), false);
  assert.equal(formatoConfere(PDF(), "image/png"), false);
  assert.equal(pdfComConteudoAtivo(PDF("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>")), true);
  assert.equal(pdfComConteudoAtivo(PDF("/EmbeddedFiles")), true);
  assert.equal(pdfComConteudoAtivo(PDF()), false);
  assert.deepEqual(conferirArquivo({ bytes: PDF(), sha256: sha(PDF()), mime: "application/pdf" }), { ok: true });
  assert.equal(conferirArquivo({ bytes: PDF(), sha256: "0".repeat(64), mime: "application/pdf" }).motivo, "ARQUIVO_NAO_CONFERE");
  assert.equal(conferirArquivo({ bytes: null, sha256: sha(PDF()), mime: "application/pdf" }).motivo, "ARQUIVO_NAO_GUARDADO");
  assert.equal(conferirArquivo({ bytes: PDF(), sha256: sha(PDF()), mime: "audio/ogg" }).motivo, "FORMATO_NAO_ACEITO");
  assert.equal(legendaDoDocumento("MOVA,  comprovante   da alfa"), "comprovante da alfa");
  assert.equal(legendaDoDocumento("MOVA"), null);
});

// ---------------------------------------------------------------------------------------------------------- motor
t("A2-R2 PDF de quem é FINANCEIRO: guardado, registrado AGUARDANDO_CONFERENCIA e confirmado só depois do registro — sem IA, sem Financeiro", async () => {
  const s = await cenario({ extras: SEM_IA });
  const bytes = PDF("r2");
  await s.enviar(doc(bytes));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo, h.unidadeId], ["DOCUMENTO_RECEBIDO", "AGUARDANDO_CONFERENCIA", ALFA]);
  const [r] = await s.saida();
  assert.equal(r.texto, RESPOSTA_DOCUMENTO.recebido("Loja Alfa"));
  assert.match(r.texto, /Ainda não foi identificado nem conciliado automaticamente/);
  assert.doesNotMatch(r.texto, /R\$|\d{2}\/\d{2}/, "a confirmação não tem valor nem data (pode sair no grupo)");
  const [d] = await recebidos(s);
  assert.equal(d.sha256, sha(bytes));
  assert.equal(d.conferencia.estado, "AGUARDANDO_CONFERENCIA");
  assert.equal(d.legenda, "comprovante da alfa");
  assert.equal(d.participanteId, FIN);
  const ev = (await s.banco.pool.query("select unidade_id, conteudo from mova.evidencia where sha256 = $1", [sha(bytes)])).rows[0];
  assert.equal(ev.unidade_id, ALFA, "o original fica privado e preso à unidade");
  assert.equal(Buffer.compare(ev.conteudo, bytes), 0);
  assert.equal(s.cliente.pedidos.length, 0, "nenhuma chamada de IA");
  assert.equal(s.chamadas.length, 0, "nenhuma chamada ao Financeiro");
  assert.equal(await s.contar("proposta"), 0);
  assert.ok((await s.mova.armazenamento.auditoria.listar()).some((a) => a.acao === "DOCUMENTO_RECEBIDO_SEM_LEITURA" && a.alvo === sha(bytes)));
});

t("A2-R3 deduplicação: o MESMO arquivo em outra mensagem não é registrado de novo; foto PNG é aceita", async () => {
  const s = await cenario({ extras: SEM_IA });
  await s.enviar(doc(PDF("r3")));
  await s.enviar(doc(PDF("r3"), { texto: "MOVA, de novo o comprovante da alfa" }));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["DUPLICADO", "DOCUMENTO_JA_RECEBIDO"]);
  assert.equal((await s.saida()).at(-1).texto, RESPOSTA_DOCUMENTO.jaRecebido());
  await s.enviar(doc(PNG, { mime: "image/png", texto: "MOVA, foto do recibo da alfa" }));
  assert.equal((await s.ultima()).decisao, "DOCUMENTO_RECEBIDO");
  assert.equal(await s.contar("documento"), 2);
  assert.equal(await s.contar("evidencia"), 2);
});

t("A2-R4 grupo de duas unidades sem unidade no texto: pergunta a unidade; a resposta registra na unidade certa", async () => {
  const s = await cenario({ extras: SEM_IA });
  const p = doc(PDF("r4"), { texto: "MOVA, segue o comprovante" });
  await s.enviar(p);
  assert.equal((await s.ultima()).decisao, "PEDIR_INFORMACAO");
  assert.match((await s.saida()).at(-1).texto, /Loja Alfa ou Loja Beta\?/);
  assert.equal(await s.contar("documento"), 0, "nada registrado antes de saber a unidade");
  await s.enviar(gw({ texto: "beta", respostaA: p.mensagemId }));
  assert.equal((await recebidos(s, BETA)).length, 1);
  assert.equal((await recebidos(s, ALFA)).length, 0);
  assert.equal((await s.saida()).at(-1).texto, RESPOSTA_DOCUMENTO.recebido("Loja Beta"));
});

t("A2-R5 permissões: CONSULTA não envia documento; estranho é descartado antes de guardar qualquer coisa", async () => {
  const s = await cenario({ extras: SEM_IA });
  await s.enviar(doc(PDF("r5a"), { de: CONS }));
  assert.equal((await s.ultima()).motivo, "PERFIL_SEM_DOCUMENTOS");
  await s.enviar(doc(PDF("r5b"), { de: ESTRANHO }));
  assert.equal(await s.contar("documento"), 0);
  const ev = (await s.banco.pool.query("select sha256 from mova.evidencia")).rows.map((x) => x.sha256);
  assert.ok(!ev.includes(sha(PDF("r5b"))), "arquivo de quem não está na lista nem chega ao banco");
  await s.enviar(doc(PDF("r5c"), { de: OPER }));
  assert.equal((await s.ultima()).decisao, "DOCUMENTO_RECEBIDO", "OPERACIONAL envia documentos (sem valores)");
});

t("A2-R6 arquivo hostil: .exe com nome de PDF e PDF com script são recusados sem registro; áudio fica de fora", async () => {
  const s = await cenario({ extras: SEM_IA });
  await s.enviar(doc(EXE));
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["BLOQUEADO", "FORMATO_NAO_CONFERE"]);
  assert.equal((await s.saida()).at(-1).texto, RESPOSTA_DOCUMENTO.naoConfere());
  await s.enviar(doc(PDF("/OpenAction << /S /JavaScript /JS (x) >>")));
  assert.equal((await s.ultima()).motivo, "PDF_COM_CONTEUDO_ATIVO");
  await s.enviar(doc(Buffer.from("OggS sintético de áudio"), { mime: "audio/ogg" }));
  assert.equal((await s.ultima()).motivo, "FORMATO_NAO_ACEITO_SEM_LEITURA");
  assert.equal(await s.contar("documento"), 0);
  assert.equal(s.cliente.pedidos.length, 0);
});

t("A2-R7 chave desligada: só consultas continua recusando documento (nada guardado como documento)", async () => {
  const s = await cenario({ extras: { somenteConsultas: true } });
  await s.enviar(doc(PDF("r7")));
  assert.equal((await s.ultima()).motivo, "PILOTO_SOMENTE_CONSULTAS");
  assert.equal(await s.contar("documento"), 0);
});

// ---------------------------------------------------------------------------------------------------------- revisão humana
t("A2-R8 conferência: revisado/encaminhado com versão; concorrência recusa; outra unidade não vê; nada no Financeiro", async () => {
  const s = await cenario({ extras: SEM_IA });
  await s.enviar(doc(PDF("r8")));
  const alvo = sha(PDF("r8"));
  const repo = s.mova.armazenamento.documentosRecebidos;
  assert.equal(await repo.conferir({ organizacaoId: ORG, unidadeId: BETA, sha256: alvo, versao: 0, por: "u1", estado: "REVISADO" }), null, "outra unidade");
  const r = await repo.conferir({ organizacaoId: ORG, unidadeId: ALFA, sha256: alvo, versao: 0, por: "u1", estado: "REVISADO", tipo: "COMPROVANTE", observacao: "conferido" });
  assert.deepEqual([r.conferencia.estado, r.conferencia.versao, r.conferencia.tipo], ["REVISADO", 1, "COMPROVANTE"]);
  await assert.rejects(repo.conferir({ organizacaoId: ORG, unidadeId: ALFA, sha256: alvo, versao: 0, por: "u2", estado: "ENCAMINHADO" }), (e) => e.codigo === "CONFLITO_VERSAO");
  const e = await repo.conferir({ organizacaoId: ORG, unidadeId: ALFA, sha256: alvo, versao: 1, por: "u2", estado: "ENCAMINHADO" });
  assert.deepEqual(e.historico.map((x) => x.estado), ["REVISADO", "ENCAMINHADO"]);
  assert.equal((await recebidos(s, BETA)).length, 0);
  assert.equal(s.chamadas.length, 0);
});

t("A2-R9 rotas: lista com remetente mascarado; conferir exige permissão de documentos; conta citada precisa ser da unidade", async () => {
  const s = await cenario({ extras: SEM_IA });
  const contaAlfa = (await s.conta("2026-10-20", 15000)).obrigacoes[0];
  const fornBeta = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const contaBeta = (await s.conta("2026-10-20", 15000, BETA, fornBeta)).obrigacoes[0];
  await s.enviar(doc(PDF("r9"), { texto: "MOVA, comprovante Fornecedor Sintético R$ 150,00 da alfa" }));
  const alvo = sha(PDF("r9"));
  const ver = ctx(ORG, ALFA, [ACAO.VER], "eeeeeeee-0000-4000-8000-000000000009");
  const lista = await CONSULTAS_MOVA["/mova/documentos-recebidos"]({ ctx: ver, mova: s.mova });
  assert.equal(lista.recebimentoDocumental, true);
  assert.equal(lista.podeConferir, false);
  assert.deepEqual(lista.itens[0].remetente, { id: "…0201", nome: "Financeiro", perfil: "FINANCEIRO" });
  assert.ok(!("participanteId" in lista.itens[0]), "o identificador inteiro não vai à tela");
  await assert.rejects(CONSULTAS_MOVA["/mova/documentos-recebidos"]({ ctx: ctx(ORG, ALFA, []), mova: s.mova }), (e) => e.codigoHttp === 403);
  const rel = await CONSULTAS_MOVA["/mova/documento-relacionadas"]({ ctx: ver, mova: s.mova, nucleo: s.m.nucleo, params: { sha: alvo } });
  assert.deepEqual(rel.itens.map((x) => x.id), [contaAlfa.id], "pela legenda, só contas DESTA unidade");
  const conferir = (c, b) => executarAcaoMova(ACOES_MOVA["/mova/documento-conferir"], { ctx: c, mova: s.mova, nucleo: s.m.nucleo, b });
  await assert.rejects(conferir(ver, { sha256: alvo, versao: 0, estado: "REVISADO" }), (e) => e.codigoHttp === 403);
  const docs = ctx(ORG, ALFA, TODAS, "eeeeeeee-0000-4000-8000-000000000009");
  await assert.rejects(conferir(docs, { sha256: alvo, versao: 0, estado: "REVISADO", obrigacaoId: contaBeta.id }), (e) => e.codigo === "CONTA_NAO_ENCONTRADA");
  await assert.rejects(conferir(docs, { sha256: alvo, versao: 0, estado: "PAGO" }), (e) => e.codigoHttp === 400);
  const ok = await conferir(docs, { sha256: alvo, versao: 0, estado: "ENCAMINHADO", obrigacaoId: contaAlfa.id, tipo: "COMPROVANTE" });
  assert.deepEqual([ok.conferencia.estado, ok.conferencia.obrigacaoId], ["ENCAMINHADO", contaAlfa.id]);
  const depois = (await s.m.nucleo.consultarContasAPagar(docs, { pagina: 1, tamanho: 100 })).itens.find((x) => x.id === contaAlfa.id);
  assert.equal(depois.pagoCentavos, 0, "encaminhar NÃO baixa a conta");
  assert.equal(ACOES_MOVA["/mova/documento-conferir"].escreveNoFinanceiro, false);
});

t("A2-R10 rota da Central: indicadores e pendências reais pela sessão; sem a permissão de ver, nada", async () => {
  const s = await cenario({ extras: SEM_IA });
  await s.conta("2026-10-01", 50000);
  await s.enviar(doc(PDF("r10")));
  const v = await CONSULTAS_MOVA["/mova/conferencia"]({ ctx: ctx(ORG, ALFA, [ACAO.VER]), mova: s.mova, nucleo: s.m.nucleo, nomes: { empresa: "Empresa Sintética", unidade: "Loja Alfa" } });
  assert.equal(v.indicadores.contasVencidas, 1);
  assert.equal(v.indicadores.saldoVencidoCentavos, 50000);
  assert.equal(v.indicadores.documentosRecebidosMova, 1);
  assert.equal(v.indicadores.documentosAguardandoConferencia, 1);
  assert.deepEqual([v.pendencias[0].empresa, v.pendencias[0].unidade], ["Empresa Sintética", "Loja Alfa"]);
  assert.ok(v.pendencias[0].motivos.includes("VENCIDA"));
  await assert.rejects(CONSULTAS_MOVA["/mova/conferencia"]({ ctx: ctx(ORG, ALFA, []), mova: s.mova, nucleo: s.m.nucleo }), (e) => e.codigoHttp === 403);
});

// ---------------------------------------------------------------------------------------------------------- conferência (pura)
const HOJE = "2026-11-22";
const conta = (id, o = {}) => ({ id, fornecedor: { id: `f-${id}`, nome: "Produtos Alvorada Ltda", tipo: "FORNECEDOR" }, descricao: "Compra sintética", categoria: { codigo: "INSUMOS", nome: "Insumos" },
  competencia: "2026-11", vencimento: "2026-11-10", valorOriginalCentavos: 10000, ajustesCentavos: 0, pagoCentavos: 0, saldoCentavos: 10000, situacao: "VENCIDO", vencido: true,
  pendencias: ["SEM_DOCUMENTO"], documentos: [], pagamentos: [], origem: "MANUAL", ...o });
const saida = (id, valor, descricao, data = "2026-11-11") => ({ id, data, conta: { nome: "Conta Sintética" }, descricao, valorCentavos: valor, alocadoCentavos: 0 });

t("A2-R11 pendências: motivos e próxima ação vêm dos fatos; possível pagamento é só aviso; conta em dia sem motivo não aparece", () => {
  const todas = [
    conta("a"),
    conta("b", { fornecedor: { nome: "Fornecedor a identificar" }, valorOriginalCentavos: 7000, saldoCentavos: 7000 }),
    conta("c", { situacao: "PAGO", vencido: false, pagoCentavos: 3000, saldoCentavos: 0, valorOriginalCentavos: 3000, fornecedor: { nome: "Clara Teste" }, pagamentos: [{ liquidacaoId: "l1", movimentacaoId: null, data: "2026-11-05", valorCentavos: 3000, documentos: [] }] }),
    conta("d", { situacao: "EM_ABERTO", vencido: false, vencimento: "2026-12-10", documentos: [{ id: "x" }], pendencias: [], fornecedor: { nome: "Escritório Contábil Teste" }, valorOriginalCentavos: 81000, saldoCentavos: 81000 }),
    conta("e", { situacao: "PARCIALMENTE_PAGO", pagoCentavos: 2000, saldoCentavos: 8000, fornecedor: { nome: "Diarista Teste" }, ajustesCentavos: -500, pagamentos: [{ movimentacaoId: "m1", documentos: [] }] }),
  ];
  const saidas = [saida("s1", 10000, "DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / PRODUTOS ALVORADA LTDA )"), saida("s2", 10000, "DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / OUTRA EMPRESA QUALQUER )")];
  const v = montarConferencia({ todas, saidas, hoje: HOJE, empresa: "Empresa Sintética", unidade: "Loja Alfa" });
  const p = Object.fromEntries(v.pendencias.map((x) => [x.id, x]));
  assert.ok(!p.d, "em dia, com documento e sem aviso: não é pendência");
  assert.deepEqual(p.a.motivos, [MOTIVO.VENCIDA, MOTIVO.SEM_DOCUMENTO, MOTIVO.POSSIVEL_PAGAMENTO_NO_EXTRATO]);
  assert.equal(p.a.conciliacao, "POSSIVEL_PAGAMENTO_NO_EXTRATO_NAO_CONFIRMADO");
  assert.match(p.a.proximaAcao, /Conferir a saída do extrato de R\$ 100,00 em 11\/11\/2026 com o comprovante/);
  assert.deepEqual(p.a.candidatas.map((x) => x.id), ["s1"], "valor igual sozinho (s2) não conta");
  assert.ok(p.b.motivos.includes(MOTIVO.FORNECEDOR_NAO_IDENTIFICADO));
  assert.deepEqual(p.c.motivos, [MOTIVO.PAGA_SEM_COMPROVANTE, MOTIVO.PAGAMENTO_SEM_EXTRATO]);
  assert.equal(p.c.conciliacao, "PAGAMENTO_REGISTRADO_SEM_EXTRATO");
  assert.deepEqual(p.e.motivos, [MOTIVO.VENCIDA, MOTIVO.PARCIAL, MOTIVO.SEM_DOCUMENTO, MOTIVO.AJUSTE_MANUAL]);
  assert.equal(v.indicadores.contasVencidas, 3);
  assert.equal(v.indicadores.saldoVencidoCentavos, 25000);
  assert.equal(v.indicadores.possiveisPagamentosNoExtrato, 1);
  assert.equal(v.indicadores.pagamentosAguardandoConciliacao, 1);
  assert.equal(v.indicadores.documentosFaltantes, 4);
  assert.equal(v.pendencias[0].id, "a", "o que pede decisão humana vem primeiro");
  for (const x of v.pendencias) assert.equal(x.empresa, "Empresa Sintética");
});

t("A2-R12 duplicidade e extrato indisponível: aviso nas duas contas; sem extrato não há zero inventado", () => {
  const todas = [conta("a"), conta("b", { vencimento: "2026-11-12" })];
  const v = montarConferencia({ todas, saidas: null, hoje: HOJE });
  assert.ok(v.pendencias.every((x) => x.motivos.includes(MOTIVO.POSSIVEL_DUPLICIDADE)));
  assert.match(v.pendencias[0].proximaAcao, /não cancelar sem confirmar/);
  assert.equal(v.extratoDisponivel, false);
  assert.equal(v.indicadores.saidasSemVinculo, null);
  assert.equal(v.indicadores.possiveisPagamentosNoExtrato, null);
  assert.equal(v.saidas, null);
  assert.equal(v.pendencias[0].conciliacao, "EXTRATO_INDISPONIVEL");
  assert.equal(pendenciaDaConta(conta("z", { situacao: "CANCELADO" }), { todas, saidas: [], hoje: HOJE }), null);
});

t("A2-R13 saídas sem vínculo: cada regra com evidência; nome comum sozinho não identifica pessoa", () => {
  const todas = [
    conta("a"),
    conta("p1", { situacao: "PAGO", saldoCentavos: 0, pagoCentavos: 5000, fornecedor: { nome: "Bruna Sintetica" }, categoria: { codigo: "FOLHA", nome: "Folha de pagamento" } }),
    conta("p2", { situacao: "PAGO", saldoCentavos: 0, pagoCentavos: 5000, fornecedor: { nome: "Maria Fictícia" }, categoria: { nome: "Diarista" } }),
  ];
  const saidas = [
    saida("s1", 10000, "DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / PRODUTOS ALVORADA LTDA )"),
    saida("s2", 50000, "TRANSFERENCIA ENTRE CONTAS ( Doc.: 123 )"),
    saida("s3", 5550, "PJ CONTA PJ"),
    saida("s4", 150000, "LIQUIDACAO DE PARCELA ( Contrato 0001 )"),
    saida("s5", 2000, "SEGURO PRESTAMISTA (Contrato 0001)"),
    saida("s6", 4000, "DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / 12345678 Bruna Sintetica Souza )"),
    saida("s7", 4000, "DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / Maria Outra Pessoa )"),
    saida("s8", 9000, "LIQUIDACAO DE TITULO ( Doc.: 9 )"),
    saida("s9", 7000, "ARRECADACAO DE CONVENIOS ( Doc.: 7 )"),
    saida("s10", 3000, "DEBITO PAGAMENTO PIX ( Doc.: DEB PIX / LOJA DESCONHECIDA )"),
    { ...saida("s11", 1000, "JÁ VINCULADA"), alocadoCentavos: 1000 },
  ];
  const c = classificarSaidas(saidas, todas);
  const m = Object.fromEntries(c.itens.map((x) => [x.id, x.motivo]));
  assert.deepEqual(m, { s1: MOTIVO_SAIDA.POSSIVEL_PAGAMENTO_DE_OBRIGACAO, s2: MOTIVO_SAIDA.TRANSFERENCIA_ENTRE_CONTAS, s3: MOTIVO_SAIDA.TARIFA_BANCARIA, s4: MOTIVO_SAIDA.EMPRESTIMO_OU_PARCELA,
    s5: MOTIVO_SAIDA.EMPRESTIMO_OU_PARCELA, s6: MOTIVO_SAIDA.PAGAMENTO_DE_PESSOAL, s7: MOTIVO_SAIDA.SEM_ORIGEM_IDENTIFICADA, s8: MOTIVO_SAIDA.BOLETO_PAGO,
    s9: MOTIVO_SAIDA.ARRECADACAO_OU_CONVENIO, s10: MOTIVO_SAIDA.SEM_ORIGEM_IDENTIFICADA });
  assert.equal(c.quantidade, 10, "saída já vinculada fica de fora");
  assert.ok(c.itens.every((x) => x.evidencia));
  assert.equal(c.grupos.reduce((s, g) => s + g.quantidade, 0), 10);
  assert.equal(favorecidoDaSaida("DEBITO TRANSFERENCIA PIX ( Doc.: DEB PIX / 12345678 Bruna Sintetica )"), "Bruna Sintetica");
  assert.equal(mesmaPessoa("Maria Fictícia", "Maria Outra Pessoa"), false);
  assert.equal(mesmaPessoa("Clara", "Clara Teste da Silva"), true);
  assert.equal(mesmaPessoa("Maria", "Maria Teste"), false);
});

t("A2-R14 contas relacionadas a um documento: só pelo que foi escrito (nome/valor); nada escrito ⇒ nenhuma sugestão", () => {
  const todas = [conta("a"), conta("b", { fornecedor: { nome: "Clara Teste" }, valorOriginalCentavos: 4500, saldoCentavos: 4500 }), conta("c", { situacao: "CANCELADO" })];
  assert.deepEqual(contasRelacionadas(todas, "MOVA, comprovante Produtos Alvorada").map((x) => x.id), ["a"]);
  assert.deepEqual(contasRelacionadas(todas, "pix de R$ 45,00").map((x) => x.id), ["b"]);
  assert.deepEqual(contasRelacionadas(todas, "MOVA, comprovante"), []);
  assert.deepEqual(contasRelacionadas(todas, null), []);
});
