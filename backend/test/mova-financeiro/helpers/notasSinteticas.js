// Notas fiscais SINTÉTICAS (DANFSe em PDF de verdade e XML nacional) + histórico aprovado no Financeiro. Documentos com dígitos válidos, nunca de pessoa real.
import { ALFA, BETA, gw } from "./operacao.js";
import { SEG, cenario } from "./cenarioEntregadores.js";
import { lerPdf } from "../../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { lerNotaDeServico } from "../../../src/modules/financeiro-v2/dominio/notaFiscalServico.js";
import { pdf } from "../../financeiro-v2/helpers/formatos.js";
import { cnpj } from "./documentosFiscais.js";

export const TOM_ALFA = cnpj(700000000001), TOM_BETA = cnpj(800000000001);
export const PREST_MAURICIO = cnpj(111100000001), PREST_RAFAEL = cnpj(222200000001);
export const mascara = (d) => `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}- ${d.slice(12)}`;
export const reais = (c) => `R$ ${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;
export const CHAVE = "55".repeat(25);
export const danfse = ({ prestador, tomador, valor, chave = CHAVE, numero = "321", competencia = "15/11/2026", emissao = "16/11/2026", periodo = "09/11/2026 a 15/11/2026" }) => [
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
export const arquivoPdf = (p) => Buffer.from(pdf([danfse(p)], { semCompressao: true }));
export const dec = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
/** NFS-e nacional em XML (leiaute simplificado com os campos que importam). */
export const xmlNota = ({ prestador, tomador, valor, chave = CHAVE, numero = "321", nome = "MJ ENTREGAS ME", competencia = "2026-11-15" }) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${chave}"><xLocEmi>Cidade Teste</xLocEmi><nNFS>${numero}</nNFS><dhProc>2026-11-16T10:30:15-03:00</dhProc>`
    + `<emit><CNPJ>${prestador}</CNPJ><xNome>${nome}</xNome></emit><valores><vLiq>${dec(valor)}</vLiq></valores>`
    + `<DPS versao="1.00"><infDPS><dCompet>${competencia}</dCompet><toma><CNPJ>${tomador}</CNPJ><xNome>EMPRESA TOMADORA TESTE LTDA</xNome></toma>`
    + `<serv><cServ><xDescServ>Referente aos serviços de entrega dos dias 09/11/2026 a 15/11/2026</xDescServ></cServ></serv><valores><vServPrest><vServ>${dec(valor)}</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`);
export const leitorDeNota = (bytes) => lerNotaDeServico(lerPdf(new Uint8Array(bytes)).paginas.flatMap((p) => p.linhas));
export const DOCS = { [ALFA]: [TOM_ALFA], [BETA]: [TOM_BETA] };
export const TUDO = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };

let seqHist = 0;
export async function historico(s, unidadeId, inicio, chave, p) {
  const c = s.adm(unidadeId);
  await s.real.anexarDocumentoDoEntregador(c, { inicio, entregador: chave, tipoAnexo: "NOTA_FISCAL", arquivo: { conteudo: new Uint8Array(arquivoPdf({ ...p, chave: p.chave ?? "11".repeat(25), numero: String(500 + ++seqHist) })), nome: "nf.pdf", tipoMime: "application/pdf" } });
  await s.real.iniciarConferenciaDaNota(c, { inicio, entregador: chave });
  await s.real.decidirNotaDoEntregador(c, { inicio, entregador: chave, decisao: "APROVAR", conferido: TUDO, justificativa: "Conferida." });
}
export async function base(opcoes = {}) {
  const s = await cenario({ leitorDeNota, documentos: DOCS, operacional: true, ...opcoes });
  await historico(s, ALFA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1500 });
  await historico(s, ALFA, SEG, "rafael", { prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 900, chave: "22".repeat(25) });
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  return s;
}
export const enviar = async (s, de, bytes, opcoes = {}) => { await s.mova.receptor.receber(gw({ texto: null, de, grupo: de, doc: bytes, ...opcoes })); await s.mova.receptor.trabalhar(); };
export const notas = async (s) => (await s.banco.pool.query("select * from mova.nota_entregador order by criada_em")).rows;
export const auditoria = async (s, acao) => (await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = $1", [acao])).rows[0].c;
export const detalhe = (s, chave = "mauricio") => s.real.detalharFechamentoDoEntregador(s.adm(ALFA), { inicio: "2026-11-09", entregador: chave });
export const dadosXml = { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 600 };

