// MOVA (28/11/2026): suporte a XML da NFS-e de ponta a ponta — Gateway (tipo efetivo), receptor, validação segura, leitura sem IA,
// anexo ao Financeiro e duplicidade PDF × XML. Financeiro v2 real em memória, banco do MOVA isolado, Gateway simulado, dados sintéticos.
import assert from "node:assert/strict";
import { ALFA, BETA, gw, t } from "./helpers/operacao.js";
import { MAURICIO, SEG, cenario } from "./helpers/cenarioEntregadores.js";
import { lerPdf } from "../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { lerNotaDeServico, lerNotaDeXml, validarXmlDeNota } from "../../src/modules/financeiro-v2/dominio/notaFiscalServico.js";
import { validarXmlSeguro } from "../../src/modules/mova-financeiro/dominio/xmlSeguro.js";
import { mimeEfetivo } from "../../src/modules/mova-financeiro/contratos/evento.js";
import { pdf } from "../financeiro-v2/helpers/formatos.js";
import { cnpj } from "./helpers/documentosFiscais.js";

const TOM_ALFA = cnpj(700000000001), TOM_BETA = cnpj(800000000001);
const PREST_MAURICIO = cnpj(111100000001), PREST_RAFAEL = cnpj(222200000001);
const mascara = (d) => `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}- ${d.slice(12)}`;
const reais = (c) => `R$ ${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;
const CHAVE = "55".repeat(25);
const danfse = ({ prestador, tomador, valor, chave = CHAVE, numero = "321", competencia = "15/11/2026", emissao = "16/11/2026", periodo = "09/11/2026 a 15/11/2026" }) => [
  "Município: Cidade Teste - PI", "DANFSe v2.0", "Documento Auxiliar da NFS- e Tipo de Ambiente: 1", "CHAVE DE ACESSO DA NFS- e", chave,
  "NÚMERO DA NFS- e COMPETÊNCIA DA NFS- e DATA E HORA DA EMISSÃO DA NFS- e", `${numero} ${competencia} ${emissao} 10:30:15`,
  "EMITENTE DA NFS- e SITUAÇÃO DA NFS- e FINALIDADE", "Prestador NFS- e MEI -",
  "PRESTADOR / FORNECEDOR CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", `${mascara(prestador)} - (00) 90000- 0000`,
  "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", `${prestador.slice(0, 8).replace(/(\d{2})(\d{3})(\d{3})/, "$1.$2.$3")} MJ ENTREGAS ME Cidade Teste / PI 22.11001 / 64.000- 000`,
  "TOMADOR / ADQUIRENTE CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", `${mascara(tomador)} - -`,
  "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", "EMPRESA TOMADORA TESTE LTDA Cidade Teste / PI 22.11001 / 64.000- 001",
  "Descrição do Serviço", `Referente aos serviços de entrega dos dias ${periodo}`,
  "VALOR TOTAL DA NFS- e VALOR DA OPERAÇÃO / SERVIÇO Desconto Incondicionado Desconto Condicionado", `${reais(valor)} - -`,
  "Total das Retenções (ISSQN / Federais) VALOR LÍQUIDO DA NFS- e Total do IBS/CBS VALOR LÍQUIDO DA NFS- e + IBS/CBS", `- ${reais(valor)} R$ 0,00 R$ 0,00`,
];
const arquivoPdf = (p) => Buffer.from(pdf([danfse(p)], { semCompressao: true }));
const dec = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
/** NFS-e nacional em XML (leiaute simplificado com os campos que importam). */
const xmlNota = ({ prestador, tomador, valor, chave = CHAVE, numero = "321", nome = "MJ ENTREGAS ME", competencia = "2026-11-15" }) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${chave}"><xLocEmi>Cidade Teste</xLocEmi><nNFS>${numero}</nNFS><dhProc>2026-11-16T10:30:15-03:00</dhProc>`
    + `<emit><CNPJ>${prestador}</CNPJ><xNome>${nome}</xNome></emit><valores><vLiq>${dec(valor)}</vLiq></valores>`
    + `<DPS versao="1.00"><infDPS><dCompet>${competencia}</dCompet><toma><CNPJ>${tomador}</CNPJ><xNome>EMPRESA TOMADORA TESTE LTDA</xNome></toma>`
    + `<serv><cServ><xDescServ>Referente aos serviços de entrega dos dias 09/11/2026 a 15/11/2026</xDescServ></cServ></serv><valores><vServPrest><vServ>${dec(valor)}</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`);
const leitorDeNota = (bytes) => lerNotaDeServico(lerPdf(new Uint8Array(bytes)).paginas.flatMap((p) => p.linhas));
const DOCS = { [ALFA]: [TOM_ALFA], [BETA]: [TOM_BETA] };
const TUDO = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };

let seqHist = 0;
async function historico(s, unidadeId, inicio, chave, p) {
  const c = s.adm(unidadeId);
  await s.real.anexarDocumentoDoEntregador(c, { inicio, entregador: chave, tipoAnexo: "NOTA_FISCAL", arquivo: { conteudo: new Uint8Array(arquivoPdf({ ...p, chave: p.chave ?? "11".repeat(25), numero: String(500 + ++seqHist) })), nome: "nf.pdf", tipoMime: "application/pdf" } });
  await s.real.iniciarConferenciaDaNota(c, { inicio, entregador: chave });
  await s.real.decidirNotaDoEntregador(c, { inicio, entregador: chave, decisao: "APROVAR", conferido: TUDO, justificativa: "Conferida." });
}
async function base() {
  const s = await cenario({ leitorDeNota, documentos: DOCS, operacional: true });
  await historico(s, ALFA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1500 });
  await historico(s, ALFA, SEG, "rafael", { prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 900, chave: "22".repeat(25) });
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  return s;
}
const enviar = async (s, de, bytes, opcoes = {}) => { await s.mova.receptor.receber(gw({ texto: null, de, grupo: de, doc: bytes, ...opcoes })); await s.mova.receptor.trabalhar(); };
const notas = async (s) => (await s.banco.pool.query("select * from mova.nota_entregador order by criada_em")).rows;
const auditoria = async (s, acao) => (await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = $1", [acao])).rows[0].c;
const detalhe = (s, chave = "mauricio") => s.real.detalharFechamentoDoEntregador(s.adm(ALFA), { inicio: "2026-11-09", entregador: chave });
const dadosXml = { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 600 };

t("X-1 tipo efetivo: text/xml, application/xml e octet-stream/text/plain com nome .xml viram application/xml; o resto não muda", () => {
  assert.equal(mimeEfetivo("text/xml; charset=utf-8"), "application/xml");
  assert.equal(mimeEfetivo("application/octet-stream", "NFSe-321.XML"), "application/xml");
  assert.equal(mimeEfetivo("text/plain", "nota.xml"), "application/xml");
  assert.equal(mimeEfetivo("application/octet-stream", "nota.exe"), "application/octet-stream");
  assert.equal(mimeEfetivo("application/pdf", "nota.xml"), "application/pdf", "o tipo declarado do PDF não é reinterpretado");
});

t("X-2 validação segura (MOVA e Financeiro iguais): DTD, entidade externa, expansão, CDATA, instrução, binário, incompleto e grande são recusados", () => {
  const ok = xmlNota(dadosXml);
  assert.equal(validarXmlSeguro(ok).ok, true);
  assert.equal(validarXmlDeNota(ok).ok, true);
  const ruins = {
    XML_COM_DTD: Buffer.from('<?xml version="1.0"?><!DOCTYPE NFSe SYSTEM "http://malicioso.invalid/x.dtd"><NFSe></NFSe>'),
    XML_COM_ENTIDADE: Buffer.from('<NFSe><!ENTITY x "y"></NFSe>'),
    XML_COM_ENTIDADE_DESCONHECIDA: Buffer.from("<NFSe>&lol9;</NFSe>"),
    XML_COM_CDATA: Buffer.from("<NFSe><![CDATA[x]]></NFSe>"),
    XML_COM_FOLHA_DE_ESTILO: Buffer.from('<?xml version="1.0"?><?xml-stylesheet href="x.xsl"?><NFSe></NFSe>'),
    XML_NAO_E_TEXTO: Buffer.from([0x3c, 0x4e, 0x00, 0x3e]),
    XML_INCOMPLETO: Buffer.from("<NFSe><emit>"),
    XML_NAO_CONFERE: Buffer.from("%PDF-1.4 não é xml"),
    XML_GRANDE: Buffer.from(`<NFSe>${"a".repeat(2_000_001)}</NFSe>`),
  };
  for (const [motivo, bytes] of Object.entries(ruins)) {
    assert.equal(validarXmlSeguro(bytes).motivo, motivo, `MOVA ${motivo}`);
    assert.equal(validarXmlDeNota(bytes).motivo, motivo, `Financeiro ${motivo}`);
    assert.equal(lerNotaDeXml(bytes), null);
  }
  assert.equal(validarXmlSeguro(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ok])).ok, true, "BOM UTF-8 é aceito");
  const l = lerNotaDeXml(ok);
  assert.deepEqual([l.chaveAcesso, l.numero, l.valorCentavos, l.prestador.documento.replace(/\D/g, ""), l.tomador.documento.replace(/\D/g, "")], [CHAVE, "321", 600, PREST_MAURICIO, TOM_ALFA]);
});

t("X-3 XML da NFS-e pelo WhatsApp (text/xml): lido SEM IA, confere pela identidade, anexado ao Financeiro com a chave de acesso", async () => {
  const s = await base();
  await enviar(s, MAURICIO, xmlNota(dadosXml), { mime: "text/xml", nomeArquivo: "NFSe-321.xml" });
  const [n] = await notas(s);
  assert.equal(n.conferencia, "CONFERE", JSON.stringify(n.leitura));
  assert.equal(n.leitura.fonteDaLeitura, "XML");
  assert.equal(n.estado, "ANEXADA");
  assert.ok(((await detalhe(s)).notas ?? []).some((x) => x.vigente && x.leitura?.chaveAcesso === CHAVE), "o Financeiro leu o mesmo XML (chave de acesso)");
  assert.ok(!JSON.stringify(n).includes(PREST_MAURICIO), "CPF/CNPJ completo não fica na leitura do MOVA");
});

t("X-4 Gateway que manda o XML como application/octet-stream com nome .xml também é aceito", async () => {
  const s = await base();
  await enviar(s, MAURICIO, xmlNota(dadosXml), { mime: "application/octet-stream", nomeArquivo: "nota.xml" });
  const todas = await notas(s);
  assert.equal(todas.length, 1);
  assert.equal(todas[0].conferencia, "CONFERE");
});

t("X-5 XML malicioso do entregador: recusado antes de gravar (nenhuma nota, nada no Financeiro), com auditoria", async () => {
  const s = await base();
  const antes = ((await detalhe(s)).notas ?? []).length;
  const bomba = Buffer.from('<?xml version="1.0"?><!DOCTYPE NFSe [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><NFSe><emit>&b;</emit></NFSe>');
  await enviar(s, MAURICIO, bomba, { mime: "text/xml", nomeArquivo: "nota.xml" });
  await enviar(s, MAURICIO, Buffer.from("%PDF-1.4 disfarçado"), { mime: "application/octet-stream", nomeArquivo: "nota.xml" });
  assert.equal((await notas(s)).length, 0);
  assert.equal(await auditoria(s, "NOTA_XML_RECUSADA"), 2);
  assert.equal(((await detalhe(s)).notas ?? []).length, antes);
});

t("X-6 XML grande (> 2 MB, ainda < 15 MB) é recusado, sem leitura", async () => {
  const s = await base();
  await enviar(s, MAURICIO, Buffer.from(`<NFSe>${"a".repeat(2_100_000)}</NFSe>`), { mime: "text/xml", nomeArquivo: "nota.xml" });
  assert.equal((await notas(s)).length, 0);
  assert.equal(await auditoria(s, "NOTA_XML_RECUSADA"), 1);
});

t("X-7 XML enviado por quem NÃO é entregador (participante de grupo financeiro) não é aceito", async () => {
  const s = await base();
  await s.mova.receptor.receber(gw({ texto: null, doc: xmlNota(dadosXml), mime: "text/xml", nomeArquivo: "nota.xml" }));
  await s.mova.receptor.trabalhar();
  assert.equal((await notas(s)).length, 0);
});

t("X-8 a MESMA nota em PDF e depois em XML: um só registro anexado, um só anexo vigente, nenhuma obrigação nova", async () => {
  const s = await base();
  await enviar(s, MAURICIO, arquivoPdf(dadosXml));
  assert.equal((await notas(s))[0].estado, "ANEXADA");
  const obrigacoes = async () => (await s.real.consultarEntregador(s.adm(ALFA), { entregador: "mauricio" })).fechamentos.length;
  const antes = await obrigacoes();
  await enviar(s, MAURICIO, xmlNota(dadosXml), { mime: "text/xml", nomeArquivo: "nota.xml" });
  assert.equal((await notas(s)).filter((x) => x.estado === "ANEXADA").length, 1, "só uma nota anexada");
  assert.equal(await obrigacoes(), antes, "nenhuma obrigação nova");
  assert.equal(((await detalhe(s)).notas ?? []).filter((x) => x.vigente && x.leitura?.chaveAcesso === CHAVE).length, 1, "um único anexo vigente com essa chave");
});

t("X-9 XML direto no Financeiro: aceito como NFS-e; com DTD ou binário recusado; a mesma chave em outra semana é duplicada", async () => {
  const s = await base();
  const c = s.adm(ALFA);
  const anexar = (entregador, conteudo, inicio = "2026-11-09") => s.real.anexarDocumentoDoEntregador(c, { inicio, entregador, tipoAnexo: "NOTA_FISCAL", arquivo: { conteudo: new Uint8Array(conteudo), nome: "n.xml", tipoMime: "application/xml" } });
  await assert.rejects(() => anexar("mauricio", Buffer.from('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><NFSe></NFSe>')), (e) => /XML recusado|DOCUMENTO_INVALIDO/.test(`${e.message}${e.codigo}`));
  await assert.rejects(() => anexar("mauricio", Buffer.from("MZ executavel")), (e) => /XML recusado|DOCUMENTO_INVALIDO/.test(`${e.message}${e.codigo}`));
  await anexar("mauricio", xmlNota(dadosXml));
  await assert.rejects(() => anexar("mauricio", xmlNota({ ...dadosXml, numero: "999" }), SEG), (e) => /vinculada|NOTA_DUPLICADA|OPERACAO_INVALIDA/.test(`${e.message}${e.codigo}${JSON.stringify(e.detalhes ?? {})}`));
});
