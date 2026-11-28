// MOVA (28/11/2026): identidade fiscal — regras PURAS (sem banco): CPF/CNPJ, evidências fortes/fracas, consolidação, conflitos, tomador
// aprendido, comparação de prestador e leitura de XML. Dados 100% sintéticos (documentos gerados com dígitos verificadores válidos).
import assert from "node:assert/strict";
import { test } from "node:test";
import { aprenderTomadores, avaliarNota, avaliarPrimeiraNota, compararPrestador, consolidarIdentidades, documentoValido, mascararDocumento, normalizarLeitura, SITUACAO_IDENTIDADE } from "../../src/modules/mova-financeiro/dominio/identidadeFiscal.js";
import { lerNotaSemIa, lerNotaXml, leituraParaConferencia } from "../../src/modules/mova-financeiro/dominio/leituraNotaFiscal.js";
import { cnpj, cpf } from "./helpers/documentosFiscais.js";
import { conferirNotaDoEntregador } from "../../src/modules/mova-financeiro/dominio/entregadores.js";

const PRESTADOR_A = cnpj(111111110001), PRESTADOR_B = cnpj(222222220001), TOMADOR_1 = cnpj(333333330001), TOMADOR_2 = cnpj(444444440001);
const OBRIG = { valorCentavos: 15000, semanaInicio: "2026-11-02", semanaFim: "2026-11-08" };
const leitura = (o = {}) => ({ prestador: { documento: PRESTADOR_A, nome: "MJ ENTREGAS ME" }, tomador: { documento: TOMADOR_1, nome: "EMPRESA UM" }, valorCentavos: 15000, competencia: "2026-11-08", numero: "10", ...o });
const nota = (o = {}) => ({ organizacaoId: "o1", unidadeId: "u1", entregador: "mauricio", semanaInicio: "2026-11-02", leitura: leitura(), situacao: "NF_APROVADA", vigente: true, obrigacao: OBRIG, ...o });

test("FD-1 CPF/CNPJ só valem com dígitos verificadores corretos; máscara nunca mostra o documento inteiro", () => {
  assert.equal(documentoValido(PRESTADOR_A), true);
  assert.equal(documentoValido(cpf(123456789)), true);
  assert.equal(documentoValido("11111111111111"), false);
  assert.equal(documentoValido("12345678901234"), false);
  assert.equal(documentoValido(PRESTADOR_A.slice(0, 13) + "0"), PRESTADOR_A.endsWith("0") ? true : false);
  assert.ok(!mascararDocumento(PRESTADOR_A).includes(PRESTADOR_A.slice(0, 8)));
  assert.match(mascararDocumento(cpf(123456789)), /^\*\*\*\.\d{3}\.\*\*\*-\d{2}$/);
  assert.equal(normalizarLeitura(leitura({ prestador: { documento: "123", nome: "X" } })).prestadorDocumento, null, "documento inválido não vira identidade");
});

test("FD-2 uma nota só é evidência FORTE quando vigente, sem sinal contrário e aprovada por pessoa (ou conferida sozinha)", () => {
  const forte = avaliarNota({ nota: nota(), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 });
  assert.equal(forte.forca, "FORTE");
  const outraEmpresa = avaliarNota({ nota: nota(), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_2 });
  assert.deepEqual([outraEmpresa.forca, outraEmpresa.motivos], ["FRACA", ["TOMADOR_DE_OUTRA_EMPRESA"]], "nota emitida a outra empresa nunca vale para esta");
  assert.ok(avaliarNota({ nota: nota({ leitura: leitura({ valorCentavos: 9999 }) }), obrigacao: OBRIG }).motivos.includes("VALOR_DIFERENTE_DA_OBRIGACAO"));
  assert.equal(avaliarNota({ nota: nota({ vigente: false }), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 }).forca, "FRACA");
  assert.equal(avaliarNota({ nota: nota({ situacao: "NF_REJEITADA" }), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 }).forca, "FRACA");
  assert.equal(avaliarNota({ nota: nota({ leitura: leitura({ prestador: { documento: null, nome: "X" } }) }), obrigacao: OBRIG }).forca, "FRACA", "sem CPF/CNPJ não há identidade");
  const semAprovacao = avaliarNota({ nota: nota({ situacao: "NF_RECEBIDA" }), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 });
  assert.equal(semAprovacao.forca, "FORTE", "valor + tomador + período conferem sozinhos");
  assert.equal(avaliarNota({ nota: nota({ situacao: "NF_RECEBIDA" }), obrigacao: OBRIG, tomadorDaUnidade: null }).forca, "FRACA", "sem aprovação e sem tomador confirmado não basta");
  const periodoErrado = avaliarNota({ nota: nota({ leitura: leitura({ periodo: { inicio: "2026-11-09", fim: "2026-11-15" } }) }), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 });
  assert.ok(periodoErrado.motivos.includes("PERIODO_DIFERENTE_DA_SEMANA"));
});

test("FD-3 consolidação: um documento ⇒ CONSOLIDADA; nota fraca de outro documento NÃO contamina; dois fortes diferentes ⇒ só aquele em revisão", () => {
  const tom = new Map([["u1", TOMADOR_1], ["u2", TOMADOR_2]]);
  const ok = consolidarIdentidades([nota(), nota({ semanaInicio: "2026-11-09", obrigacao: { ...OBRIG, semanaInicio: "2026-11-09", semanaFim: "2026-11-15" } }),
    nota({ unidadeId: "u2", leitura: leitura({ tomador: { documento: TOMADOR_2, nome: "EMPRESA DOIS" } }) })], tom);
  const m = ok.identidades.get("mauricio");
  assert.deepEqual([m.situacao, m.documento, m.unidades.sort(), m.notasFortes], [SITUACAO_IDENTIDADE.CONSOLIDADA, PRESTADOR_A, ["u1", "u2"], 3]);
  // nota anexada errada (rejeitada, outro CNPJ): vira divergência registrada, mas a identidade continua
  const comErro = consolidarIdentidades([nota(), nota({ semanaInicio: "2026-11-09", situacao: "NF_REJEITADA", leitura: leitura({ prestador: { documento: PRESTADOR_B, nome: "OUTRO" } }) })], tom).identidades.get("mauricio");
  assert.deepEqual([comErro.situacao, comErro.documento, comErro.divergencias.length], ["CONSOLIDADA", PRESTADOR_A, 1]);
  // dois documentos fortes diferentes para o MESMO entregador: revisão, sem escolher um
  const conflito = consolidarIdentidades([nota(), nota({ semanaInicio: "2026-11-09", leitura: leitura({ prestador: { documento: PRESTADOR_B, nome: "OUTRO" } }), obrigacao: { ...OBRIG, semanaInicio: "2026-11-09", semanaFim: "2026-11-15" } }),
    nota({ entregador: "rafael", leitura: leitura({ prestador: { documento: cnpj(555555550001), nome: "R" } }) })], tom);
  assert.equal(conflito.identidades.get("mauricio").situacao, "EM_REVISAO");
  assert.equal(conflito.identidades.get("rafael").situacao, "CONSOLIDADA", "o conflito de um não bloqueia os outros");
  // o MESMO documento em dois entregadores diferentes: ambos em revisão
  const dividido = consolidarIdentidades([nota(), nota({ entregador: "rafael" })], tom);
  assert.deepEqual([dividido.identidades.get("mauricio").situacao, dividido.identidades.get("rafael").motivo], ["EM_REVISAO", "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR"]);
  // sem nenhuma nota forte
  assert.equal(consolidarIdentidades([nota({ vigente: false })], tom).identidades.get("mauricio").situacao, "SEM_HISTORICO");
});

test("FD-4 tomador da unidade é aprendido só com evidência suficiente e sem conflito", () => {
  const n = (e, doc, i = 0) => nota({ entregador: e, semanaInicio: `2026-11-0${i + 1}`, leitura: leitura({ tomador: { documento: doc, nome: "T" } }) });
  const aprendido = aprenderTomadores([n("a", TOMADOR_1), n("b", TOMADOR_1, 1), n("a", TOMADOR_1, 2)]).get("u1");
  assert.deepEqual([aprendido.documento, aprendido.situacao], [TOMADOR_1, "APRENDIDO"]);
  assert.equal(aprenderTomadores([n("a", TOMADOR_1), n("b", TOMADOR_1, 1)]).get("u1").documento, null, "poucas notas: não aprende");
  const conflito = aprenderTomadores([n("a", TOMADOR_1), n("b", TOMADOR_1, 1), n("c", TOMADOR_2, 2)]).get("u1");
  assert.deepEqual([conflito.documento, conflito.situacao], [null, "CONFLITO"]);
  assert.equal(aprenderTomadores([nota({ situacao: "NF_REJEITADA" }), nota(), nota()]).get("u1")?.documento ?? null, null, "rejeitada não conta");
});

test("FD-5 compararPrestador: o CPF/CNPJ é a evidência principal; razão social diferente do nome operacional NÃO diverge", () => {
  const id = { situacao: "CONSOLIDADA", documento: PRESTADOR_A, nome: "MJ ENTREGAS ME" };
  const l = normalizarLeitura(leitura({ prestador: { documento: PRESTADOR_A, nome: "NOME QUE NADA TEM A VER LTDA" } }));
  assert.deepEqual(compararPrestador(id, l), { resultado: "CONFERE", motivo: "MESMO_CPF_CNPJ_DO_HISTORICO" });
  assert.equal(compararPrestador(id, normalizarLeitura(leitura({ prestador: { documento: PRESTADOR_B, nome: "MJ ENTREGAS ME" } }))).resultado, "DIFERENTE", "mesmo nome com outro CNPJ não passa");
  assert.equal(compararPrestador(id, normalizarLeitura(leitura({ prestador: { documento: null, nome: "X" } }))).resultado, "DOCUMENTO_NAO_LIDO");
  assert.equal(compararPrestador(null, l).resultado, "SEM_IDENTIDADE");
  assert.equal(compararPrestador({ situacao: "EM_REVISAO" }, l).resultado, "EM_REVISAO");
});

test("FD-6 conferência da nota com identidade: documento igual confere mesmo com nome diferente; documento diferente diverge; sem identidade e com documento lido, nome diferente fica pendente (não divergente)", () => {
  const fechamento = { valorCentavos: 15000, semanaInicio: "2026-11-02", semanaFim: "2026-11-08", entregador: { nome: "Mauricio Sintetico" } };
  const leit = { tipoDocumento: "NOTA_FISCAL", legivel: true, confianca: "ALTA", valorCentavos: 15000, competencia: "2026-11", favorecido: "MJ ENTREGAS ME", pagador: "EMPRESA UM", documentoDestinatario: TOMADOR_1, prestadorDocumento: PRESTADOR_A };
  const id = { situacao: "CONSOLIDADA", documento: PRESTADOR_A };
  assert.equal(conferirNotaDoEntregador({ leitura: leit, fechamento, identidade: id, tomadorAprendido: TOMADOR_1 }).resultado, "CONFERE");
  const outro = conferirNotaDoEntregador({ leitura: { ...leit, prestadorDocumento: PRESTADOR_B }, fechamento, identidade: id, tomadorAprendido: TOMADOR_1 });
  assert.deepEqual([outro.resultado, outro.motivos], ["DIVERGENTE", ["PRESTADOR_DIFERENTE_DO_HISTORICO"]]);
  assert.deepEqual(conferirNotaDoEntregador({ leitura: leit, fechamento, tomadorAprendido: TOMADOR_1 }).motivos, ["EMITENTE_PENDENTE_DE_VALIDACAO"]);
  assert.equal(conferirNotaDoEntregador({ leitura: { ...leit, prestadorDocumento: null }, fechamento, tomadorAprendido: TOMADOR_1 }).motivos[0], "EMITENTE_NAO_E_O_ENTREGADOR", "comportamento antigo preservado quando não há documento lido");
  assert.ok(conferirNotaDoEntregador({ leitura: leit, fechamento, identidade: id, tomadorAprendido: TOMADOR_2 }).motivos.includes("TOMADOR_DIFERENTE"), "tomador de outra empresa");
  assert.ok(conferirNotaDoEntregador({ leitura: leit, fechamento, identidade: id, tomadorAprendido: TOMADOR_1, chaveDuplicada: true }).motivos.includes("NOTA_FISCAL_JA_RECEBIDA"));
  assert.deepEqual(conferirNotaDoEntregador({ leitura: leit, fechamento, identidade: { situacao: "EM_REVISAO" }, tomadorAprendido: TOMADOR_1 }).motivos, ["IDENTIDADE_FISCAL_EM_REVISAO"]);
  assert.ok(conferirNotaDoEntregador({ leitura: { ...leit, periodo: { inicio: "2026-11-09", fim: "2026-11-15" } }, fechamento, identidade: id, tomadorAprendido: TOMADOR_1 }).motivos.includes("PERIODO_DIFERENTE"));
});

test("FD-7 primeira nota: consolida sozinha só com evidência inequívoca; documento de outro entregador ou tomador desconhecido vai a revisão", () => {
  const base = { leitura: leitura(), obrigacao: OBRIG, tomadorDaUnidade: TOMADOR_1 };
  assert.deepEqual([avaliarPrimeiraNota(base).consolidar, avaliarPrimeiraNota(base).motivo], [true, "EVIDENCIA_INEQUIVOCA_DA_PRIMEIRA_NOTA"]);
  assert.equal(avaliarPrimeiraNota({ ...base, documentoJaUsadoPorOutro: true }).motivo, "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR");
  assert.equal(avaliarPrimeiraNota({ ...base, tomadorDaUnidade: null }).motivo, "TOMADOR_NAO_CONFIRMADO");
  assert.equal(avaliarPrimeiraNota({ ...base, tomadorDaUnidade: TOMADOR_2 }).consolidar, false);
  assert.equal(avaliarPrimeiraNota({ ...base, leitura: leitura({ valorCentavos: 1 }) }).consolidar, false);
  assert.equal(avaliarPrimeiraNota({ ...base, leitura: leitura({ prestador: { documento: null, nome: "X" } }) }).motivo, "NOTA_SEM_CPF_CNPJ_LEGIVEL");
});

const XML = (o = {}) => `<?xml version="1.0"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${"1".repeat(50)}"><xLocEmi>Cidade Teste</xLocEmi><nNFS>77</nNFS>
<emit><CNPJ>${o.emit ?? PRESTADOR_A}</CNPJ><xNome>MJ ENTREGAS ME</xNome><xFant>MJ Fantasia</xFant></emit>
<valores><vLiq>150.00</vLiq></valores><DPS><infDPS><dCompet>2026-11-08</dCompet><dhEmi>2026-11-09T10:00:00-03:00</dhEmi><toma><CNPJ>${TOMADOR_1}</CNPJ><xNome>EMPRESA UM</xNome></toma><serv><xDescServ>entregas</xDescServ></serv><valores><vServ>150.00</vServ></valores></infDPS></DPS></infNFSe></NFSe>`;

test("FD-8 leitura de XML da NFS-e: prestador, tomador, chave, valor e datas sem IA; XML estranho ⇒ null; PDF usa o leitor injetado", () => {
  const b = lerNotaXml(XML());
  assert.deepEqual([b.prestador.documento, b.prestador.nomeFantasia, b.tomador.documento, b.numero, b.valorCentavos, b.competencia, b.emissao, b.chaveAcesso], [PRESTADOR_A, "MJ Fantasia", TOMADOR_1, "77", 15000, "2026-11-08", "2026-11-09", "1".repeat(50)]);
  const l = leituraParaConferencia(b, "XML");
  assert.deepEqual([l.tipoDocumento, l.valorCentavos, l.competencia, l.documentoDestinatario, l.prestadorDocumento, l.confianca], ["NOTA_FISCAL", 15000, "2026-11", TOMADOR_1, PRESTADOR_A, "ALTA"]);
  assert.equal(lerNotaXml("<html>não é nota</html>"), null);
  assert.equal(lerNotaXml(`<NFSe><infNFSe>${"x".repeat(10)}</infNFSe></NFSe>`), null, "sem emitente não inventa");
  assert.equal(lerNotaSemIa({ bytes: Buffer.from(XML()), mime: "application/xml" }).fonte, "XML");
  assert.equal(lerNotaSemIa({ bytes: Buffer.from("%PDF"), mime: "application/pdf", leitorPdf: () => leitura() }).fonte, "PDF_TEXTO");
  assert.equal(lerNotaSemIa({ bytes: Buffer.from("%PDF"), mime: "application/pdf", leitorPdf: () => { throw new Error("pdf quebrado"); } }), null, "falha do leitor ⇒ cai para a IA");
  assert.equal(lerNotaSemIa({ bytes: Buffer.from("x"), mime: "image/jpeg", leitorPdf: () => leitura() }), null, "foto não é lida sem IA");
});
