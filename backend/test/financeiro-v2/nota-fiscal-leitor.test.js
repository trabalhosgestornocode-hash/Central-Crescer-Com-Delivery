// Leitor da NFS-e nacional (DANFSe) ao anexar a nota do entregador. Dados 100% SINTÉTICOS (nomes, CNPJs e chaves inventados).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODIGO, criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { lerNotaDeServico, centavosDeTexto } from "../../src/modules/financeiro-v2/dominio/notaFiscalServico.js";
import { lerPdf } from "../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { semanaDe } from "../../src/modules/financeiro-v2/dominio/entregadoresProprios.js";
import { ORG_A, TODAS, UNI_A, ctx, rejeita, ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { EM_POSTGRES, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { pdf } from "./helpers/formatos.js";

const CHAVE = "22110012200000000000100000000000012326110000000001";
/** Linhas no mesmo layout do DANFSe v2.0 (rótulo numa linha, valor na seguinte; CNPJ com espaço como o PDF entrega). */
const danfse = ({ chave = CHAVE, numero = "123", valor = "R$ 1.234,50", tomador = true, descricao = "Referente aos serviços de entrega dos dias 02/11/2026 a 08/11/2026" } = {}) => [
  "Município: Cidade Teste - PI", "DANFSe v2.0", "Documento Auxiliar da NFS- e Tipo de Ambiente: 1",
  "CHAVE DE ACESSO DA NFS- e", chave,
  "NÚMERO DA NFS- e COMPETÊNCIA DA NFS- e DATA E HORA DA EMISSÃO DA NFS- e", `${numero} 08/11/2026 09/11/2026 10:30:15`,
  "EMITENTE DA NFS- e SITUAÇÃO DA NFS- e FINALIDADE", "Prestador NFS- e MEI -",
  "PRESTADOR / FORNECEDOR CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", "11.222.333/0001- 81 - (00) 90000- 0000",
  "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", "11.222.333 FULANO ENTREGADOR DE TESTE Cidade Teste / PI 22.11001 / 64.000- 000",
  ...(tomador
    ? ["TOMADOR / ADQUIRENTE CNPJ / CPF / NIF Indicador Municipal (Inscrição) Telefone", "44.555.666/0001- 99 - -",
      "Nome / Nome Empresarial Município / Sigla UF Código IBGE / CEP", "EMPRESA TOMADORA TESTE LTDA Cidade Teste / PI 22.11001 / 64.000- 001"]
    : ["TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS- e"]),
  "Descrição do Serviço", descricao,
  "VALOR TOTAL DA NFS- e VALOR DA OPERAÇÃO / SERVIÇO Desconto Incondicionado Desconto Condicionado", `${valor} - -`,
  "Total das Retenções (ISSQN / Federais) VALOR LÍQUIDO DA NFS- e Total do IBS/CBS VALOR LÍQUIDO DA NFS- e + IBS/CBS", `- ${valor} R$ 0,00 R$ 0,00`,
];

test("leitor: número, chave, competência, emissão, prestador, tomador, valor e período", () => {
  const n = lerNotaDeServico(danfse());
  assert.deepEqual(n, {
    modelo: "DANFSE_NACIONAL", chaveAcesso: CHAVE, numero: "123", competencia: "2026-11-08", emissao: "2026-11-09",
    prestador: { documento: "11.222.333/0001-81", nome: "FULANO ENTREGADOR DE TESTE" },
    tomador: { documento: "44.555.666/0001-99", nome: "EMPRESA TOMADORA TESTE LTDA" },
    valorCentavos: 123450, valorLiquidoCentavos: 123450, periodo: { inicio: "2026-11-02", fim: "2026-11-08" },
    descricao: "Referente aos serviços de entrega dos dias 02/11/2026 a 08/11/2026",
  });
  assert.deepEqual(lerNotaDeServico(danfse({ tomador: false })).tomador, { documento: null, nome: null, naoIdentificado: true });
  assert.deepEqual(lerNotaDeServico(danfse({ descricao: "entregas no período de 02/11 a 08/11" })).periodo, { inicio: "2026-11-02", fim: "2026-11-08" }, "ano ausente vem da competência");
  assert.equal(lerNotaDeServico(danfse({ descricao: "Serviço de entrega" })).periodo, null, "sem datas: não inventa período");
  assert.equal(lerNotaDeServico(["Nota de outro modelo", "Valor R$ 10,00"]), null, "layout desconhecido: nada é inventado");
  assert.deepEqual([centavosDeTexto("R$ 0,05"), centavosDeTexto("R$ 12.345,67"), centavosDeTexto("-")], [5, 1234567, null]);
});

test("PDF: stream com 'endobj' no meio e zlib sem fecho válido são lidos (geradores como o do emissor nacional)", () => {
  const linhas = ["CHAVE endobj DE TESTE", "segunda linha"];
  for (const opcoes of [{ semCompressao: true }, { fechoZlibInvalido: true }]) {
    const r = lerPdf(pdf([linhas], opcoes));
    assert.deepEqual([r.incompleto, r.paginas[0].linhas], [false, linhas], JSON.stringify(opcoes));
  }
});

// ---------------------------------------------------------------- anexo no fechamento semanal
const SEG = "2026-11-02";
const dias = () => Array.from({ length: 7 }, (_, i) => ({ data: `2026-11-0${2 + i}`, fonte: "foody", provisorio: false, aberto: false, triagem: 0 }));
const entrega = (id, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: "fulano", entregadorNome: "Fulano", data: "2026-11-03", numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
async function montar(valores = [100000, 23450]) {
  const repositorio = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const cofre = criarCofreMemoria();
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date("2026-11-09T12:00:00.000Z"), cofre, entregadores: { fonte: { apurar: async ({ inicio }) => ({ disponivel: true, dias: inicio === SEG ? dias() : dias().map((d, i) => ({ ...d, data: semanaDe("2026-11-09").inicio.slice(0, 8) + String(9 + i).padStart(2, "0") })), entregas: valores.map((v, i) => entrega(i + 1, v)) }) }, inicioDaOperacao: SEG, cofreDeNotas: cofre } });
  const c = ctx(ORG_A, UNI_A, TODAS);
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  await n.fecharSemanaDeEntregadores(c, { inicio: SEG });
  return { n, c };
}
const arquivo = (linhas, nome = "nota.pdf") => ({ conteudo: pdf([linhas]), nome, tipoMime: "application/pdf" });
const conferido = { emitente: true, tomador: true, periodo: true, valor: true, numero: true, duplicidade: true };

test("anexar a nota em PDF que confere tudo já aprova e LIBERA o pagamento no mesmo ato", async () => {
  const { n, c } = await montar();
  const r = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse()) });
  assert.deepEqual([r.leituraDaNota.lida, r.leituraDaNota.liberadaAutomaticamente, r.leituraDaNota.motivos, r.situacaoDocumental], [true, true, [], "LIBERADO_PAGAMENTO"]);
  const d = await n.detalharFechamentoDoEntregador(c, { inicio: SEG, entregador: "fulano" });
  assert.deepEqual([d.notaVigente.numero, d.notaVigente.emitente, d.notaVigente.tomador, d.notaVigente.valorCentavos, d.notaVigente.leitura.chaveAcesso, d.notaVigente.situacao],
    ["123", "FULANO ENTREGADOR DE TESTE (11.222.333/0001-81)", "EMPRESA TOMADORA TESTE LTDA (44.555.666/0001-99)", 123450, CHAVE, "NF_APROVADA"]);
  assert.equal(d.impedimentoDocumental, false, "sem impedimento: a baixa pelo extrato fica liberada");
  assert.ok(d.conferencias.at(-1).automatica && d.historico.some((h) => /automaticamente/.test(h.justificativa ?? "")), "o histórico registra que foi automático");
  await rejeita(n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse({ numero: "321" }), "x.pdf") }), CODIGO.OPERACAO_INVALIDA);
});

test("liberação automática NÃO acontece se algo não confere: fica para a conferência manual, com o motivo", async () => {
  const casos = [
    [{ valor: "R$ 1.000,00" }, /valor da nota é diferente/],
    [{ tomador: false }, /não identifica o tomador/],
    [{ descricao: "Entregas de 09/11/2026 a 15/11/2026" }, /período escrito/],
  ];
  for (const [opcoes, motivo] of casos) {
    const { n, c } = await montar();
    const r = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse(opcoes)) });
    assert.equal(r.situacaoDocumental, "NF_RECEBIDA", JSON.stringify(opcoes));
    assert.ok(r.leituraDaNota.motivos.some((m) => motivo.test(m)), r.leituraDaNota.motivos.join(" | "));
  }
  // sem a permissão de conferir, quem anexa não libera
  const { n, c } = await montar();
  const semConferir = { ...c, permissoes: c.permissoes.filter((p) => p !== "financeiro_v2.conciliar") };
  const r = await n.anexarDocumentoDoEntregador(semConferir, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse()) });
  assert.equal(r.situacaoDocumental, "NF_RECEBIDA");
});

test("emitente diferente do entregador: 1ª vez manual; aprovado uma vez, passa a ser reconhecido", async () => {
  const { n, c } = await montarDois();
  const outro = (numero, chave) => danfse({ numero, chave, valor: "R$ 50,00" }).map((l) => l.replace("FULANO ENTREGADOR DE TESTE", "PAGADOR DIFERENTE"));
  const r1 = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "beltrano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(outro("7", "2".repeat(50))) });
  assert.equal(r1.situacaoDocumental, "NF_RECEBIDA");
  assert.ok(r1.leituraDaNota.motivos.some((m) => /emitente/.test(m)));
  await n.iniciarConferenciaDaNota(c, { inicio: SEG, entregador: "beltrano" });
  await n.decidirNotaDoEntregador(c, { inicio: SEG, entregador: "beltrano", decisao: "APROVAR", conferido, justificativa: "Pagador combinado." });
  const learn = await n.consultarEntregadoresProprios(c, { semana: SEG });
  assert.ok(learn.fechamentos.some((f) => f.entregador.chave === "beltrano" && f.situacaoDocumental === "NF_APROVADA"));
});

test("o que a pessoa digita prevalece; valor diferente e tomador ausente viram avisos (nada é aprovado sozinho)", async () => {
  const { n, c } = await montar();
  const r = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", numero: "999", arquivo: arquivo(danfse({ valor: "R$ 1.000,00", tomador: false })) });
  assert.equal(r.leituraDaNota.liberadaAutomaticamente, false);
  assert.equal(r.leituraDaNota.numero, "999");
  assert.deepEqual(r.leituraDaNota.avisos.map((a) => a.codigo), ["VALOR_DIFERENTE", "TOMADOR_NAO_IDENTIFICADO"]);
  assert.equal(r.situacaoDocumental, "NF_RECEBIDA");
  await n.iniciarConferenciaDaNota(c, { inicio: SEG, entregador: "fulano" });
  await rejeita(n.decidirNotaDoEntregador(c, { inicio: SEG, entregador: "fulano", decisao: "APROVAR", conferido, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
});

test("PDF que não é DANFSe (ou ilegível) é aceito como antes, sem dados inventados; sem valor, a mensagem é clara", async () => {
  const { n, c } = await montar();
  const r = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(["Recibo simples", "Valor R$ 1.234,50"]) });
  assert.deepEqual([r.leituraDaNota.lida, r.leituraDaNota.liberadaAutomaticamente, r.situacaoDocumental], [false, false, "NF_RECEBIDA"]);
  await n.iniciarConferenciaDaNota(c, { inicio: SEG, entregador: "fulano" });
  await assert.rejects(n.decidirNotaDoEntregador(c, { inicio: SEG, entregador: "fulano", decisao: "APROVAR", conferido, justificativa: "x" }), (e) => e.detalhes?.motivo === "VALOR_DA_NOTA_AUSENTE");
});

test("a mesma chave de acesso não serve para dois entregadores ou semanas", async () => {
  const { n, c } = await montar();
  // segundo entregador na mesma semana (montar() já fechou só com "fulano"; aqui a regra é a do anexo, por chave de acesso)
  const r1 = await n.anexarDocumentoDoEntregador(c, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse()) });
  assert.equal(r1.leituraDaNota.lida, true);
  const { n: n2, c: c2 } = await montarDois();
  await n2.anexarDocumentoDoEntregador(c2, { inicio: SEG, entregador: "fulano", tipoAnexo: "NOTA_FISCAL", arquivo: arquivo(danfse()) });
  await rejeita(n2.anexarDocumentoDoEntregador(c2, { inicio: SEG, entregador: "beltrano", tipoAnexo: "NOTA_FISCAL", numero: "124", emitente: "Outro", arquivo: arquivo(danfse({ numero: "124" }), "outra.pdf") }), CODIGO.OPERACAO_INVALIDA);
});
async function montarDois() {
  const repositorio = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const cofre = criarCofreMemoria();
  const entregas = [entrega(1, 123450), { ...entrega(2, 5000), entregadorChave: "beltrano", entregadorNome: "Beltrano" }];
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date("2026-11-09T12:00:00.000Z"), cofre, entregadores: { fonte: { apurar: async () => ({ disponivel: true, dias: dias(), entregas }) }, inicioDaOperacao: SEG, cofreDeNotas: cofre } });
  const c = ctx(ORG_A, UNI_A, TODAS);
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  await n.fecharSemanaDeEntregadores(c, { inicio: SEG });
  return { n, c };
}
