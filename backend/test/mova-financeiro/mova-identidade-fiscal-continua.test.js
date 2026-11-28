// MOVA (29/11/2026): identidade fiscal CONTÍNUA e endurecimento da primeira nota. Notas fracas nunca consolidam identidade; documento
// de outro entregador (inclusive só com evidência forte) nunca cria vínculo; revisão por falta de evidência é reavaliada sozinha numa
// nota posterior inequívoca; revisão por conflito (documento alheio / documentos diferentes) só sai por decisão administrativa.
// Financeiro v2 real em memória, notas DANFSe em PDF, banco isolado, IA proibida, dados sintéticos.
import assert from "node:assert/strict";
import { ALFA, BETA, ORG, gw, t } from "./helpers/operacao.js";
import { ADM, MAURICIO, RAFAEL, S2, SEG, cenario } from "./helpers/cenarioEntregadores.js";
import { lerPdf } from "../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { lerNotaDeServico } from "../../src/modules/financeiro-v2/dominio/notaFiscalServico.js";
import { pdf } from "../financeiro-v2/helpers/formatos.js";
import { cnpj } from "./helpers/documentosFiscais.js";

const TOM_ALFA = cnpj(700000000001), TOM_BETA = cnpj(800000000001);
const PREST_MAURICIO = cnpj(111100000001), PREST_RAFAEL = cnpj(222200000001), PREST_ZECA = cnpj(333300000001), PREST_OUTRO = cnpj(999900000001);
const mascara = (d) => `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}- ${d.slice(12)}`;
const reais = (c) => `R$ ${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;
let n = 0;
/** DANFSe no layout nacional (rótulo numa linha, valor na seguinte), como o leitor do Financeiro espera. */
const danfse = ({ prestador, nome = "MJ ENTREGAS ME", tomador, valor, competencia = "08/11/2026", emissao = "09/11/2026", numero = String(100 + ++n), chave = null, periodo = "02/11/2026 a 08/11/2026" }) => [
  "Município: Cidade Teste - PI", "DANFSe v2.0", "Documento Auxiliar da NFS- e Tipo de Ambiente: 1",
  "CHAVE DE ACESSO DA NFS- e", chave ?? `2211001220000000000010000000000001232611${String(n).padStart(10, "0")}`,
  "NÚMERO DA NFS- e COMPETÊNCIA DA NFS- e DATA E HORA DA EMISSÃO DA NFS- e", `${numero} ${competencia} ${emissao} 10:30:15`,
  "EMITENTE DA NFS- e SITUAÇÃO DA NFS- e FINALIDADE", "Prestador NFS- e MEI -",
  "PRESTADOR / FORNECEDOR CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", `${mascara(prestador)} - (00) 90000- 0000`,
  "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", `${prestador.slice(0, 8).replace(/(\d{2})(\d{3})(\d{3})/, "$1.$2.$3")} ${nome} Cidade Teste / PI 22.11001 / 64.000- 000`,
  "TOMADOR / ADQUIRENTE CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", `${mascara(tomador)} - -`,
  "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", "EMPRESA TOMADORA TESTE LTDA Cidade Teste / PI 22.11001 / 64.000- 001",
  "Descrição do Serviço", `Referente aos serviços de entrega dos dias ${periodo}`,
  "VALOR TOTAL DA NFS- e VALOR DA OPERAÇÃO / SERVIÇO Desconto Incondicionado Desconto Condicionado", `${reais(valor)} - -`,
  "Total das Retenções (ISSQN / Federais) VALOR LÍQUIDO DA NFS- e Total do IBS/CBS VALOR LÍQUIDO DA NFS- e + IBS/CBS", `- ${reais(valor)} R$ 0,00 R$ 0,00`,
];
const arquivo = (p) => Buffer.from(pdf([danfse(p)], { semCompressao: true }));
const leitorDeNota = (bytes) => lerNotaDeServico(lerPdf(new Uint8Array(bytes)).paginas.flatMap((p) => p.linhas));
const DOCS = { [ALFA]: [TOM_ALFA], [BETA]: [TOM_BETA] };
const TUDO = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };

/** Anexa e aprova no Financeiro uma nota DANFSe de verdade (o histórico que o MOVA vai aprender). */
async function historico(s, unidadeId, inicio, chave, p) {
  const c = s.adm(unidadeId);
  await s.real.anexarDocumentoDoEntregador(c, { inicio, entregador: chave, tipoAnexo: "NOTA_FISCAL", arquivo: { conteudo: new Uint8Array(arquivo(p)), nome: "nf.pdf", tipoMime: "application/pdf" } });
  const d = await s.real.detalharFechamentoDoEntregador(c, { inicio, entregador: chave });
  if (!["NF_APROVADA", "LIBERADO_PAGAMENTO"].includes(d.situacaoDocumental)) {
    await s.real.iniciarConferenciaDaNota(c, { inicio, entregador: chave });
    await s.real.decidirNotaDoEntregador(c, { inicio, entregador: chave, decisao: "APROVAR", conferido: TUDO, justificativa: "Conferida." });
  }
}
async function comHistorico(extra = {}) {
  const s = await cenario({ leitorDeNota, documentos: DOCS, ...extra });
  await historico(s, ALFA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1500 });
  await historico(s, ALFA, SEG, "rafael", { prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 900, nome: "RAFAEL TRANSPORTES MEI", periodo: "02/11/2026 a 08/11/2026" });
  await historico(s, BETA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_BETA, valor: 500 });
  return s;
}
const nota = async (s, de, bytes) => { await s.mova.receptor.receber(gw({ texto: null, de, grupo: de, doc: bytes })); await s.mova.receptor.trabalhar(); return (await s.mova.armazenamento.notasEntregador.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.entregador); };
const ultima = async (s) => (await s.banco.pool.query("select * from mova.nota_entregador order by criada_em desc limit 1")).rows[0];
const vinculo = async (s, unidadeId, entregador) => (await s.banco.pool.query("select v.situacao, v.motivo, v.origem, i.documento from mova.identidade_fiscal_vinculo v left join mova.identidade_fiscal i on i.id = v.identidade_id where v.unidade_id = $1 and v.entregador = $2", [unidadeId, entregador])).rows[0];

const ZECA = "5500000000333@s.whatsapp.net";
const ZE = [{ unidadeId: ALFA, chave: "zeca", telefoneE164: "+5500000000333", privado: ZECA, nome: "Zeca Sintetico" }];

t("IC-1 nota FRACA (valor diferente da obrigação) nunca consolida identidade: nenhum vínculo é criado e a evidência é FRACA", async () => {
  const s = await cenario({ leitorDeNota, documentos: DOCS, entregadores: ZE });
  await nota(s, ZECA, arquivo({ prestador: PREST_ZECA, tomador: TOM_ALFA, valor: 777 }));
  assert.notEqual((await ultima(s)).conferencia, "CONFERE");
  assert.equal(await vinculo(s, ALFA, "zeca"), undefined, "sem vínculo: nota fraca não vira identidade");
  const ev = (await s.banco.pool.query("select forca from mova.identidade_fiscal_evidencia where entregador = 'zeca'")).rows;
  assert.ok(ev.every((e) => e.forca === "FRACA"));
});

t("IC-2 terceiro: evidência FORTE de outro entregador para o mesmo CNPJ (mesmo sem vínculo consolidado) conta como documento alheio", async () => {
  const s = await cenario({ leitorDeNota, documentos: DOCS, entregadores: ZE });
  const f = s.mova.armazenamento.identidadesFiscais;
  assert.equal(await f.documentoUsadoPorOutro({ documento: PREST_RAFAEL, entregador: "zeca" }), false);
  await f.registrarEvidencia({ organizacaoId: ORG, unidadeId: ALFA, entregador: "rafael", semanaInicio: SEG, sha256: "a".repeat(64), documentoId: null, numero: "9", chaveAcesso: null, prestadorDocumento: PREST_RAFAEL,
    tomadorDocumento: TOM_ALFA, valorCentavos: 900, competencia: null, fonte: "FINANCEIRO", forca: "FORTE", motivos: [] });
  assert.equal(await f.documentoUsadoPorOutro({ documento: PREST_RAFAEL, entregador: "zeca" }), true);
  assert.equal(await f.documentoUsadoPorOutro({ documento: PREST_RAFAEL, entregador: "rafael" }), false, "o próprio dono não conflita consigo");
  await nota(s, ZECA, arquivo({ prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 400 }));
  assert.notEqual((await ultima(s)).conferencia, "CONFERE");
  assert.equal((await vinculo(s, ALFA, "zeca")).situacao, "EM_REVISAO");
});

t("IC-3 contínua: revisão por TOMADOR_NAO_CONFIRMADO é reavaliada sozinha quando a nota seguinte é inequívoca (sem 'Reaprender' nem cadastro)", async () => {
  const s = await cenario({ leitorDeNota, documentos: {}, entregadores: ZE });
  await nota(s, ZECA, arquivo({ prestador: PREST_ZECA, tomador: TOM_ALFA, valor: 400 }));
  assert.deepEqual([(await vinculo(s, ALFA, "zeca")).situacao, (await vinculo(s, ALFA, "zeca")).motivo], ["EM_REVISAO", "TOMADOR_NAO_CONFIRMADO"]);
  await s.mova.armazenamento.identidadesFiscais.definirTomador({ organizacaoId: ORG, unidadeId: ALFA, documento: TOM_ALFA, situacao: "CONFIGURADO" });
  await nota(s, ZECA, arquivo({ prestador: PREST_ZECA, tomador: TOM_ALFA, valor: 400, emissao: "10/11/2026" }));
  const v = await vinculo(s, ALFA, "zeca");
  assert.deepEqual([v.situacao, v.documento, v.origem], ["CONSOLIDADA", PREST_ZECA, "NOTA_RECEBIDA"]);
});

t("IC-4 revisão por CONFLITO (documento alheio) NÃO se resolve sozinha: uma nota posterior com o CNPJ do próprio entregador não desfaz a revisão", async () => {
  const s = await comHistorico({ entregadores: [
    { unidadeId: ALFA, chave: "mauricio", telefoneE164: "+5500000000301", privado: MAURICIO, nome: "Mauricio Sintetico" },
    { unidadeId: ALFA, chave: "rafael", telefoneE164: "+5500000000302", privado: RAFAEL, nome: "Rafael Sintetico" },
    { unidadeId: ALFA, chave: "zeca", telefoneE164: "+5500000000333", privado: ZECA, nome: "Zeca Sintetico" }] });
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  await nota(s, ZECA, arquivo({ prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 400 }));
  assert.equal((await vinculo(s, ALFA, "zeca")).motivo, "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR");
  await nota(s, ZECA, arquivo({ prestador: PREST_ZECA, tomador: TOM_ALFA, valor: 400, emissao: "10/11/2026" }));
  assert.equal((await vinculo(s, ALFA, "zeca")).situacao, "EM_REVISAO", "só a administração resolve conflito");
  assert.equal((await vinculo(s, ALFA, "rafael")).documento, PREST_RAFAEL);
});
