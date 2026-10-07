// Reconciliation — VISÃO DE EVIDÊNCIA (homologação) x tabela operacional.
// Arquivo com o mesmo formato do CSV oficial (colunas técnicas inclusas) e os
// mesmos números da tela de homologação: 271 registros, 258 com impacto,
// R$ 977,63 no repasse, R$ 1.222,92 bruto, R$ 245,29 informativos. O parse é o
// REAL do backend (ifoodFinancial.mapper.js); a projeção e o HTML são os reais
// do frontend (ifoodEstado.js / ifood.js). Sem rede, sem iFood.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsearArquivoConciliacao } from "../../backend/src/modules/ifood/ifoodFinancial.mapper.js";
import {
  projetarArquivoParaEvidencia, mascararIdsEmbutidos, normalizarNomeColunaCsv,
  COLUNAS_EVIDENCIA_RECONCILIATION, montarEvidenciaHomologacao, montarExportacaoJson, montarExportacaoHtml,
} from "../src/ifoodEstado.js";
import { corpoDetalheArquivo, previaEvidenciaArquivo } from "../src/ifood.js";

// Identificadores FICTÍCIOS (formato real, valores inventados).
const LOJA_UUID = "a1b2c3d4-0000-4000-8000-00000000abcd";
const PEDIDO_UUID = (i) => `f0e1d2c3-1111-4111-8111-${String(i).padStart(12, "0")}`;
const CNPJ = "12.345.678/0001-90";
const IDS_TECNICOS = (i) => [LOJA_UUID, PEDIDO_UUID(i), CNPJ, `LJ-EXT-${i}`, `#${9000 + i}`];

const CABECALHO = [
  "COMPETENCIA", "DATA_FATO_GERADOR", "FATO_GERADOR", "TIPO_LANCAMENTO", "DESCRICAO_LANCAMENTO",
  "VALOR", "BASE_CALCULO", "PERCENTUAL_TAXA", "IMPACTO_NO_REPASSE",
  "PEDIDO_ASSOCIADO_IFOOD", "PEDIDO_ASSOCIADO_IFOOD_CURTO", "PEDIDO_ASSOCIADO_EXTERNO",
  "LOJA_ID", "LOJA_ID_CURTO", "LOJA_ID_EXTERNO", "CNPJ", "TITULO", "VALOR_TRANSACAO", "CODIGO_TRANSACAO",
  "METODO_PAGAMENTO",
];
const OCULTAS = [
  "PEDIDO_ASSOCIADO_IFOOD", "PEDIDO_ASSOCIADO_IFOOD_CURTO", "PEDIDO_ASSOCIADO_EXTERNO",
  "LOJA_ID", "LOJA_ID_CURTO", "LOJA_ID_EXTERNO", "CNPJ", "TITULO", "VALOR_TRANSACAO", "CODIGO_TRANSACAO",
];

// 258 SIM somando 977,63 (257 x 3,80 + 1,03) e 13 NAO somando 245,29 (12 x 18,87 + 18,85).
function csvHomologacao({ competencia = "2025-08", descricaoComId = false } = {}) {
  const linhas = [CABECALHO.join(";")];
  for (let i = 0; i < 271; i += 1) {
    const sim = i < 258;
    const valor = sim ? (i === 257 ? "1.03" : "3.80") : (i === 270 ? "18.85" : "18.87");
    const descricao = descricaoComId && i === 0 ? `Ajuste do pedido ${PEDIDO_UUID(i)} loja ${CNPJ}` : sim ? "Venda" : "Promoção bancada pela loja";
    linhas.push([
      competencia, `${competencia}-15`, sim ? "VENDA" : "PROMOCAO", sim ? "CREDITO" : "DEBITO", descricao,
      valor, "10.00", "12", sim ? "SIM" : "NAO",
      PEDIDO_UUID(i), `#${9000 + i}`, `PED-EXT-${i}`,
      LOJA_UUID, "LJ1", `LJ-EXT-${i}`, CNPJ, `TIT-${i}`, "999.99", `COD-${i}`,
      "CREDITO",
    ].join(";"));
  }
  return Buffer.from(linhas.join("\n"), "utf8");
}

const arquivoDoBackend = (opts) => parsearArquivoConciliacao(csvHomologacao(opts));

describe("projetarArquivoParaEvidencia — dados", () => {
  test("271 registros presentes, na ordem original, com as colunas financeiras", () => {
    const a = arquivoDoBackend();
    const p = projetarArquivoParaEvidencia(a);
    assert.equal(a.totalLinhas, 271);
    assert.equal(p.totalLinhas, 271);
    assert.equal(p.linhas.length, 271);
    assert.deepEqual(p.colunas, [
      "COMPETENCIA", "DATA_FATO_GERADOR", "FATO_GERADOR", "TIPO_LANCAMENTO", "DESCRICAO_LANCAMENTO",
      "VALOR", "IMPACTO_NO_REPASSE", "BASE_CALCULO", "PERCENTUAL_TAXA", "METODO_PAGAMENTO",
    ]);
    assert.deepEqual(p.colunasOcultas, OCULTAS);
  });

  test("valores e impacto_no_repasse idênticos às células originais, sem renomear cabeçalhos", () => {
    const a = arquivoDoBackend();
    const p = projetarArquivoParaEvidencia(a);
    p.linhas.forEach((l, i) => {
      for (const c of p.colunas) assert.equal(l[c], a.linhas[i][c], `linha ${i} coluna ${c}`);
      assert.deepEqual(Object.keys(l), p.colunas);
    });
    assert.equal(p.valoresMascarados, 0);
  });

  test("resumo do repasse é o do backend (não recalculado) e confere com a tela", () => {
    const a = arquivoDoBackend();
    const p = projetarArquivoParaEvidencia(a);
    assert.equal(p.resumoRepasse, a.resumoRepasse, "mesmo objeto, nenhum cálculo paralelo");
    assert.equal(p.resumoRepasse.totalLinhas, 271);
    assert.equal(p.resumoRepasse.linhasComImpacto, 258);
    assert.equal(p.resumoRepasse.linhasSemImpacto, 13);
    assert.equal(p.resumoRepasse.totalComImpacto, 977.63);
    assert.equal(p.resumoRepasse.totalBruto, 1222.92);
    assert.equal(p.resumoRepasse.totalSemImpacto, 245.29);
    // E a soma das células exibidas bate com o resumo (coerência da evidência).
    const centavos = (f) => p.linhas.filter(f).reduce((s, l) => s + Math.round(Number(l.VALOR) * 100), 0);
    assert.equal(centavos((l) => l.IMPACTO_NO_REPASSE === "SIM"), 97763);
    assert.equal(centavos((l) => l.IMPACTO_NO_REPASSE === "NAO"), 24529);
  });

  test("não muta o arquivo operacional (tabela completa continua com todas as colunas)", () => {
    const a = arquivoDoBackend();
    const antes = JSON.stringify(a);
    projetarArquivoParaEvidencia(a);
    assert.equal(JSON.stringify(a), antes);
    assert.deepEqual(a.colunas, CABECALHO);
    assert.equal(a.linhas[0].LOJA_ID, LOJA_UUID);
  });

  test("nenhum identificador técnico sobra na projeção", () => {
    const p = projetarArquivoParaEvidencia(arquivoDoBackend());
    const json = JSON.stringify({ colunas: p.colunas, linhas: p.linhas });
    for (let i = 0; i < 271; i += 1) for (const id of IDS_TECNICOS(i)) assert.ok(!json.includes(id), `vazou ${id}`);
  });

  test("UUID/CNPJ embutido numa célula permitida é mascarado e contado; resto do texto intacto", () => {
    const p = projetarArquivoParaEvidencia(arquivoDoBackend({ descricaoComId: true }));
    assert.equal(p.linhas[0].DESCRICAO_LANCAMENTO, "Ajuste do pedido f0e1****0000 loja **.***.***/****-**");
    assert.equal(p.valoresMascarados, 2);
    assert.equal(p.linhas[1].DESCRICAO_LANCAMENTO, "Venda");
    assert.deepEqual(mascararIdsEmbutidos("Taxa 12,00% sobre 10.00"), { valor: "Taxa 12,00% sobre 10.00", mascarados: 0 });
    assert.deepEqual(mascararIdsEmbutidos(null), { valor: null, mascarados: 0 });
  });

  test("competência real diferente da consultada: exibida como veio, sem conversão", () => {
    for (const competencia of ["2025-08", "2026-09", "2024-12"]) {
      const p = projetarArquivoParaEvidencia(arquivoDoBackend({ competencia }));
      assert.ok(p.linhas.every((l) => l.COMPETENCIA === competencia && l.DATA_FATO_GERADOR === `${competencia}-15`));
    }
  });

  test("cabeçalho em minúsculas/acentuado (dado real) também é reconhecido", () => {
    const a = parsearArquivoConciliacao(Buffer.from("competência;Descrição Lançamento;valor;impacto_no_repasse;loja_id\n2026-09;Venda;10.00;SIM;" + LOJA_UUID + "\n", "utf8"));
    const p = projetarArquivoParaEvidencia(a);
    assert.deepEqual(p.colunas, ["competência", "Descrição Lançamento", "valor", "impacto_no_repasse"]);
    assert.deepEqual(p.colunasOcultas, ["loja_id"]);
    assert.ok(!JSON.stringify(p.linhas).includes(LOJA_UUID));
  });

  test("allowlist não contém nenhum nome de identificador técnico", () => {
    const proibidos = ["id", "cnpj", "uuid", "pedido", "loja", "externo", "curto", "codigo", "titulo"];
    for (const c of COLUNAS_EVIDENCIA_RECONCILIATION) {
      const partes = normalizarNomeColunaCsv(c).split("_");
      assert.ok(!partes.some((x) => proibidos.includes(x)), c);
    }
  });

  test("arquivo sem colunas reconhecidas ou ausente: falha fechada", () => {
    const p = projetarArquivoParaEvidencia({ colunas: ["LOJA_ID", "CNPJ"], linhas: [{ LOJA_ID: LOJA_UUID, CNPJ }], totalLinhas: 1 });
    assert.deepEqual(p.colunas, []);
    assert.deepEqual(p.linhas, [{}]);
    assert.equal(projetarArquivoParaEvidencia(null), null);
  });
});

describe("HTML da visão de evidência x tabela operacional", () => {
  const ids = Array.from({ length: 271 }, (_, i) => IDS_TECNICOS(i)).flat();

  test("modal em modo evidência: 271 linhas, campos financeiros, resumo, sem ids técnicos em lugar nenhum do HTML", () => {
    const html = corpoDetalheArquivo(arquivoDoBackend(), "evidencia", true);
    assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 271, "cabeçalho + 271 registros");
    for (const c of ["COMPETENCIA", "FATO_GERADOR", "DESCRICAO_LANCAMENTO", "VALOR", "IMPACTO_NO_REPASSE"]) assert.ok(html.includes(`<th>${c}</th>`), c);
    assert.ok(html.includes("271 registro(s)"));
    assert.ok(html.includes("258 de 271 lançamentos"));
    for (const id of new Set(ids)) assert.ok(!html.includes(id), `vazou ${id}`);
    // Nem em atributos/tooltips/data-*: o HTML não tem title= nem data-.
    assert.doesNotMatch(html, /\btitle=|\bdata-[a-z]/);
    assert.match(html, /id="ifrec-arquivo-modo"[^>]*>Ver tabela completa \(uso interno\)/);
  });

  test("modal em modo completo continua operacional: todas as colunas e valores", () => {
    const html = corpoDetalheArquivo(arquivoDoBackend(), "completa", false);
    for (const c of CABECALHO) assert.ok(html.includes(`<th>${c}</th>`), c);
    assert.ok(html.includes(LOJA_UUID) && html.includes(PEDIDO_UUID(0)));
    assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 271);
    assert.ok(!html.includes("ifrec-arquivo-modo"), "fora da homologação não há alternância");
  });

  test("prévia do card (homologação): 10 linhas, sem ids técnicos", () => {
    const html = previaEvidenciaArquivo(arquivoDoBackend(), 10);
    assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 10);
    for (const id of new Set(ids)) assert.ok(!html.includes(id), `vazou ${id}`);
  });
});

describe("exportação da evidência (JSON/HTML)", () => {
  test("exemplo da Reconciliation mensal só traz colunas financeiras", () => {
    const arquivo = arquivoDoBackend();
    const financeiro = { reconciliation: { competencia: "2026-09", resultado: { competencia: "2026-09", arquivo }, erro: null } };
    const ev = montarEvidenciaHomologacao({ status: { financialHomologacao: true }, financeiro });
    const exemplo = ev.apis.reconciliation.exemplo;
    assert.deepEqual(Object.keys(exemplo), [
      "COMPETENCIA", "DATA_FATO_GERADOR", "FATO_GERADOR", "TIPO_LANCAMENTO", "DESCRICAO_LANCAMENTO",
      "VALOR", "IMPACTO_NO_REPASSE", "BASE_CALCULO", "PERCENTUAL_TAXA", "METODO_PAGAMENTO",
    ]);
    assert.equal(exemplo.VALOR, "3.80");
    assert.equal(exemplo.IMPACTO_NO_REPASSE, "SIM");
    for (const c of OCULTAS) assert.ok(!(c in exemplo), c);
    const exportados = [JSON.stringify(ev), montarExportacaoJson(ev), montarExportacaoHtml(ev)];
    for (const texto of exportados) for (const id of IDS_TECNICOS(0)) assert.ok(!String(texto).includes(id), `vazou ${id}`);
  });
});
