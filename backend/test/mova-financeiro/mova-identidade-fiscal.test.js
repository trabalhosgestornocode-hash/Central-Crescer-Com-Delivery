// MOVA (28/11/2026): identidade fiscal APRENDIDA das notas do Financeiro + conferência da nota nova pelo WhatsApp.
// Financeiro v2 REAL em memória (notas DANFSe em PDF de verdade, lidas pelo leitor determinístico), banco do MOVA isolado, Gateway simulado.
// A IA é um dublê que FALHA se chamada: tudo aqui precisa funcionar sem tokens. Dados sintéticos (nomes, documentos e valores inventados).
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

t("IF-1 aprende do Financeiro: identidades consolidadas por entregador e unidade, evidências com origem, auditoria, idempotente e sem IA", async () => {
  const s = await comHistorico();
  const r = await s.mova.entregadores.aprenderIdentidadesFiscais();
  assert.equal(r.disponivel, true);
  assert.deepEqual([r.documentosAnalisados, r.comLeituraEstruturada, r.emRevisao], [3, 3, 0]);
  // Mauricio atua nas duas empresas: UM prestador reconhecido nas duas; cada nota continua na empresa dela
  assert.deepEqual((await vinculo(s, ALFA, "mauricio")), { situacao: "CONSOLIDADA", motivo: "EVIDENCIA_INEQUIVOCA", origem: "HISTORICO", documento: PREST_MAURICIO });
  assert.equal((await vinculo(s, BETA, "mauricio")).documento, PREST_MAURICIO);
  assert.equal((await vinculo(s, ALFA, "rafael")).documento, PREST_RAFAEL);
  assert.equal(await vinculo(s, BETA, "rafael"), undefined, "Rafael não é entregador da BETA: nada é criado para ele lá");
  const ev = (await s.banco.pool.query("select unidade_id, entregador, fonte, forca, tomador_documento, documento_id is not null tem_doc from mova.identidade_fiscal_evidencia order by entregador, unidade_id")).rows;
  assert.equal(ev.length, 3);
  assert.ok(ev.every((e) => e.fonte === "FINANCEIRO" && e.forca === "FORTE" && e.tem_doc), "cada evidência guarda o documento que a fundamentou");
  assert.equal(ev.find((e) => e.unidade_id === BETA).tomador_documento, TOM_BETA, "a nota da BETA é da empresa tomadora da BETA");
  const novamente = await s.mova.entregadores.aprenderIdentidadesFiscais();
  assert.equal(novamente.evidenciasNovas, 0, "segunda passada não duplica");
  assert.equal((await s.banco.pool.query("select count(*)::int c from mova.identidade_fiscal")).rows[0].c, 2);
  assert.ok((await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = 'IDENTIDADE_FISCAL_CONSOLIDADA'")).rows[0].c >= 2);
  const c = await s.mova.armazenamento.identidadesFiscais.contagens({ organizacaoId: ORG, unidadeId: ALFA });
  assert.deepEqual([c.consolidadas, c.emRevisao, c.evidenciasFortes, c.leituras.chamadasIa], [2, 0, 2, 0]);
});

t("IF-2 nota nova com RAZÃO SOCIAL diferente do nome do entregador, mesmo CNPJ do histórico: CONFERE; lida do PDF sem IA; reaproveitada por hash; documento só mascarado", async () => {
  const s = await comHistorico();
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  const bytes = arquivo({ prestador: PREST_MAURICIO, nome: "MJ SERVICOS DE LOGISTICA LTDA", tomador: TOM_ALFA, valor: 600, periodo: "09/11/2026 a 15/11/2026", competencia: "15/11/2026", emissao: "16/11/2026" });
  await nota(s, MAURICIO, bytes);
  const n1 = await ultima(s);
  assert.equal(n1.conferencia, "CONFERE", JSON.stringify(n1.leitura));
  assert.equal(n1.leitura.fonteDaLeitura, "PDF_TEXTO");
  assert.equal(n1.leitura.prestadorDocumento, undefined, "o CPF/CNPJ completo não fica na leitura da nota");
  assert.match(n1.leitura.prestadorDocumentoFinal, /\*/);
  assert.ok(!JSON.stringify(n1).includes(PREST_MAURICIO));
  const cache = await s.mova.armazenamento.leiturasFiscais.obter(n1.sha256);
  assert.equal(cache.fonte, "PDF_TEXTO", "leitura guardada por hash: o mesmo arquivo nunca é lido de novo");
  assert.equal((await s.banco.pool.query("select coalesce(sum(chamadas_ia),0)::int c from mova.nota_leitura_fiscal")).rows[0].c, 0);
  const ev = (await s.banco.pool.query("select forca, fonte from mova.identidade_fiscal_evidencia where sha256 = $1", [n1.sha256])).rows;
  assert.deepEqual(ev, [{ forca: "FORTE", fonte: "PDF_TEXTO" }], "a nota nova vira evidência da identidade");
  const m = (await s.banco.pool.query("select via, intencao, respostas, chamadas_ia from mova.atendimento_metrica where intencao like 'NOTA_%'")).rows;
  assert.ok(m.every((x) => x.via === "DETERMINISTICA" && Number(x.chamadas_ia) === 0));
});

t("IF-3 CNPJ DIFERENTE do histórico diverge (mesmo com o nome igual); a identidade NÃO muda sozinha; evidência fica FRACA", async () => {
  const s = await comHistorico();
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  await nota(s, MAURICIO, arquivo({ prestador: PREST_OUTRO, nome: "MAURICIO SINTETICO", tomador: TOM_ALFA, valor: 600, periodo: "09/11/2026 a 15/11/2026", competencia: "15/11/2026" }));
  const n1 = await ultima(s);
  assert.equal(n1.conferencia, "DIVERGENTE");
  assert.ok(n1.leitura.motivos.includes("PRESTADOR_DIFERENTE_DO_HISTORICO"));
  assert.equal((await vinculo(s, ALFA, "mauricio")).documento, PREST_MAURICIO, "mudança de identidade fiscal nunca é aceita sozinha");
  assert.equal((await s.banco.pool.query("select forca from mova.identidade_fiscal_evidencia where sha256 = $1", [n1.sha256])).rows[0].forca, "FRACA");
});

t("IF-4 nota emitida para a OUTRA empresa não serve para esta obrigação (isolamento entre empresas), nem com o CNPJ certo do prestador", async () => {
  const s = await comHistorico();
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  await nota(s, MAURICIO, arquivo({ prestador: PREST_MAURICIO, tomador: TOM_BETA, valor: 600, periodo: "09/11/2026 a 15/11/2026", competencia: "15/11/2026" }));
  const n1 = await ultima(s);
  assert.equal(n1.unidade_id, ALFA, "a obrigação aguardando nota é da ALFA");
  assert.equal(n1.conferencia, "DIVERGENTE");
  assert.ok(n1.leitura.motivos.includes("TOMADOR_DIFERENTE"));
});

t("IF-5 entregador NOVO (sem histórico): a 1ª nota é candidata e consolida sozinha com valor + período + tomador + telefone cadastrado; nome diferente não atrapalha", async () => {
  const ZECA = "5500000000333@s.whatsapp.net";
  const entregadores = [{ unidadeId: ALFA, chave: "zeca", telefoneE164: "+5500000000333", privado: ZECA, nome: "Zeca Sintetico" }];
  const s = await cenario({ leitorDeNota, documentos: DOCS, entregadores });
  await nota(s, ZECA, arquivo({ prestador: PREST_ZECA, nome: "ZE DAS ENTREGAS MEI", tomador: TOM_ALFA, valor: 400 }));
  const n1 = await ultima(s);
  assert.equal(n1.conferencia, "CONFERE", JSON.stringify(n1.leitura));
  assert.deepEqual(await vinculo(s, ALFA, "zeca"), { situacao: "CONSOLIDADA", motivo: "EVIDENCIA_INEQUIVOCA_DA_PRIMEIRA_NOTA", origem: "PRIMEIRA_NOTA", documento: PREST_ZECA });
  assert.equal((await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = 'IDENTIDADE_FISCAL_CONSOLIDADA'")).rows[0].c, 1);
});

t("IF-6 documento que JÁ é de outro entregador: o caso excepcional vai a revisão (só ele), a nota não confere e o resto segue", async () => {
  const s = await comHistorico({ entregadores: [
    { unidadeId: ALFA, chave: "mauricio", telefoneE164: "+5500000000301", privado: MAURICIO, nome: "Mauricio Sintetico" },
    { unidadeId: ALFA, chave: "rafael", telefoneE164: "+5500000000302", privado: RAFAEL, nome: "Rafael Sintetico" },
    { unidadeId: ALFA, chave: "zeca", telefoneE164: "+5500000000333", privado: "5500000000333@s.whatsapp.net", nome: "Zeca Sintetico" }] });
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  await nota(s, "5500000000333@s.whatsapp.net", arquivo({ prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 400 }));
  const n1 = await ultima(s);
  assert.notEqual(n1.conferencia, "CONFERE");
  assert.deepEqual(await vinculo(s, ALFA, "zeca"), { situacao: "EM_REVISAO", motivo: "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR", origem: "PRIMEIRA_NOTA", documento: null });
  assert.equal((await vinculo(s, ALFA, "rafael")).situacao, "CONSOLIDADA", "o conflito de um não contamina os outros");
  assert.equal((await vinculo(s, ALFA, "mauricio")).situacao, "CONSOLIDADA");
});

t("IF-7 a MESMA nota fiscal (chave de acesso) já usada numa semana anterior e reenviada em outro arquivo é duplicidade fiscal", async () => {
  const CHAVE = "99887766554433221100998877665544332211009988776655";
  const s = await cenario({ leitorDeNota, documentos: DOCS });
  await historico(s, ALFA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1500, chave: CHAVE });
  await historico(s, ALFA, SEG, "rafael", { prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 900 });
  await s.mova.entregadores.aprenderIdentidadesFiscais();
  await nota(s, MAURICIO, arquivo({ prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 600, periodo: "09/11/2026 a 15/11/2026", competencia: "15/11/2026", chave: CHAVE, nome: "MJ ENTREGAS ME (2a via)" }));
  const n1 = await ultima(s);
  assert.equal(n1.conferencia, "DIVERGENTE");
  assert.ok(n1.leitura.motivos.includes("NOTA_FISCAL_JA_RECEBIDA"), JSON.stringify(n1.leitura.motivos));
  assert.equal((await s.banco.pool.query("select forca from mova.identidade_fiscal_evidencia where sha256 = $1", [n1.sha256])).rows[0].forca, "FRACA", "duplicada nunca reforça a identidade");
});

t("IF-8 sem a migração da identidade fiscal o MOVA se comporta como antes (conferência pelo nome), sem erro", async () => {
  const s = await comHistorico();
  await s.banco.pool.query("alter table mova.identidade_fiscal_vinculo rename to identidade_fiscal_vinculo_x");
  const { criarArmazenamentoPostgres } = await import("../../src/modules/mova-financeiro/infra/postgres.js");
  const a = criarArmazenamentoPostgres({ pool: s.banco.pool });
  assert.equal(await a.identidadesFiscais.disponivel(), false);
  assert.equal(await a.identidadesFiscais.doEntregador({ unidadeId: ALFA, entregador: "mauricio" }), null);
  assert.equal(await a.leiturasFiscais.obter("0".repeat(64)), null);
  await s.banco.pool.query("alter table mova.identidade_fiscal_vinculo_x rename to identidade_fiscal_vinculo");
});

t("IF-9 painel e ação administrativa: só leitura do que foi aprendido, documentos mascarados, escopo da unidade da sessão e permissão para reaprender", async () => {
  const { ACOES_MOVA, CONSULTAS_MOVA, executarAcaoMova } = await import("../../src/modules/fv2-integracao/movaRotas.js");
  const ctxDe = (unidadeId, permissoes) => ({ organizacaoId: ORG, unidadeId, usuarioId: ADM, permissoes });
  const VER = ["financeiro_v2.ver"], CONF = ["financeiro_v2.ver", "financeiro_v2.configurar"];
  const s = await comHistorico();
  const consulta = (ctx) => CONSULTAS_MOVA["/mova/identidade-fiscal"]({ ctx, mova: s.mova, params: {} });
  await assert.rejects(() => executarAcaoMova(ACOES_MOVA["/mova/identidade-fiscal-aprender"], { ctx: ctxDe(ALFA, VER), mova: s.mova, b: {} }), (e) => e.status === 403 || e.codigo === "PERMISSAO_INSUFICIENTE");
  const r = await executarAcaoMova(ACOES_MOVA["/mova/identidade-fiscal-aprender"], { ctx: ctxDe(ALFA, CONF), mova: s.mova, b: {} });
  assert.deepEqual([r.documentosAnalisados, r.consolidadas, r.emRevisao], [2, 2, 0], "só as notas da unidade da sessão (a BETA é de outra empresa)");
  const p = await consulta(ctxDe(ALFA, VER));
  assert.equal(p.disponivel, true);
  assert.equal(p.itens.length, 2);
  assert.equal(p.podeAprender, false);
  assert.ok(!JSON.stringify(p).includes(PREST_MAURICIO) && !JSON.stringify(p).includes(PREST_RAFAEL) && !JSON.stringify(p).includes(TOM_ALFA), "documentos só mascarados");
  const pb = await consulta(ctxDe(BETA, VER));
  assert.equal(pb.itens.length, 0, "a unidade BETA ainda não aprendeu nada: não enxerga a identidade da ALFA");
});
