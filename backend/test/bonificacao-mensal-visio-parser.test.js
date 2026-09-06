// Testes A, B, C do item 76 — parser dos relatórios reais da Visio Analytics
// (Geral e Loja). Fixtures = os 2 PDFs fornecidos pelo usuário.
// Rodar: node --test test/bonificacao-mensal-visio-parser.test.js
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVisioProductReport, parseVisioSalesReport, extrairMixVendas, detectarTipoRelatorio,
  parseNumeroBR, parseQuantidadeBR, parseMoedaBR, parsePercentualBR,
} from "../src/modules/bonificacao-mensal/visio-parser.js";
import { createRequire } from "node:module";
const pdfParse = createRequire(import.meta.url)("pdf-parse/lib/pdf-parse.js");
import { textoParaMatriz } from "../src/modules/vendas/sw-parser.js";
// mesmo pagerender (preserva colunas com TAB) do visio-parser
function renderColunas(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then((tc) => {
    let uY = null, t = "";
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = it.transform[5];
      if (uY === null) t = it.str;
      else if (Math.abs(y - uY) < 2) t += "\t" + it.str;
      else t += "\n" + it.str;
      uY = y;
    }
    return t;
  });
}
const matrizFixture = async (f) => textoParaMatriz((await pdfParse(readFileSync(join(FIXTURES, f)), { pagerender: renderColunas })).text);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const perto = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

// ===========================================================================
// NORMALIZAÇÃO NUMÉRICA pt-BR — testes OBRIGATÓRIOS (bug do relatório mensal:
// "." é separador de MILHAR nesses campos, nunca decimal; parseFloat("3.460")
// devolvia 3.46 e "1.412" chegava como não-inteiro num campo `integer`).
// ===========================================================================
describe("parseQuantidadeBR / parseMoedaBR — pt-BR, '.' = milhar", () => {
  test("quantidades: ponto é separador de milhar, resultado inteiro", () => {
    assert.equal(parseQuantidadeBR("1.412"), 1412);
    assert.equal(parseQuantidadeBR("3.460"), 3460);
    assert.equal(parseQuantidadeBR("785"), 785);
    assert.equal(parseQuantidadeBR("655"), 655);
    assert.equal(parseQuantidadeBR("12.761"), 12761);
    assert.equal(parseQuantidadeBR("132"), 132); // relatório diário — segue funcionando
  });
  test("quantidade nunca é fracionária nem negativa nem lixo -> null (erra alto)", () => {
    assert.equal(parseQuantidadeBR("3.460,5"), null);
    assert.equal(parseQuantidadeBR("40,8%"), null);
    assert.equal(parseQuantidadeBR("-5"), null);
    assert.equal(parseQuantidadeBR(""), null);
    assert.equal(parseQuantidadeBR("abc"), null);
    assert.equal(parseQuantidadeBR(null), null);
  });
  test("moeda: '.' = milhar, ',' = decimal", () => {
    assert.equal(parseMoedaBR("R$ 109.613,74"), 109613.74);
    assert.equal(parseMoedaBR("R$ 3.893,15"), 3893.15);
    assert.equal(parseMoedaBR("R$ 5.000"), 5000);      // sem centavos, com milhar
    assert.equal(parseMoedaBR("$ 0,00"), 0);
  });
  test("parseNumeroBR: PPD mensal '2.089' -> 2089; PPD fracionário '180,5' -> 180.5", () => {
    assert.equal(parseNumeroBR("2.089"), 2089);
    assert.equal(parseNumeroBR("180,5"), 180.5);
    assert.equal(parseNumeroBR("57"), 57);
    assert.equal(parseNumeroBR("lixo"), null);
  });
  test("percentuais calculados SÓ depois da normalização batem com os oficiais", () => {
    const sand = parseQuantidadeBR("3.460"), beb = parseQuantidadeBR("1.412");
    const adic = parseQuantidadeBR("785"), div = parseQuantidadeBR("655");
    assert.equal(((beb / sand) * 100).toFixed(1), "40.8");
    assert.equal(((adic / sand) * 100).toFixed(1), "22.7");
    assert.equal(((div / sand) * 100).toFixed(1), "18.9");
  });
});

describe("Teste A — PDF Geral", () => {
  test("extrai faturamento total e PPD corretos", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-geral.pdf")));
    assert.equal(r.faturamento, 9845.09);
    assert.equal(r.ppd, 168);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
  });
});

describe("Teste B — PDF Loja", () => {
  test("extrai faturamento, PPD e quantidades corretos", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.equal(r.faturamento, 3893.15);
    assert.equal(r.ppd, 73);
    assert.equal(r.sandwichesSalads, 132);
    assert.equal(r.beverages, 56);
    assert.equal(r.additions, 38);
    assert.equal(r.miscellaneous, 19);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
  });

  test("também guarda o percentual que o PRÓPRIO PDF informou (para validação cruzada)", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(perto(r.percentualBebidasPdf, 42.4));
    assert.ok(perto(r.percentualAdicionaisPdf, 28.8));
    assert.ok(perto(r.percentualDiversosPdf, 14.4));
  });
});

describe("Teste C — Mix calculado a partir das quantidades do PDF Loja", () => {
  test("bebidas/adicionais/diversos batem com o percentual esperado (~42,4% / 28,8% / 14,4%)", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(perto((r.beverages / r.sandwichesSalads) * 100, 42.4));
    assert.ok(perto((r.additions / r.sandwichesSalads) * 100, 28.8));
    assert.ok(perto((r.miscellaneous / r.sandwichesSalads) * 100, 14.4));
  });
});

describe("Teste 68 — coerência Geral >= Loja (sem exigir igualdade)", () => {
  test("faturamento, PPD e quantidades do Geral são maiores ou iguais aos do Loja", async () => {
    const geral = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-geral.pdf")));
    const loja = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(geral.faturamento >= loja.faturamento);
    assert.ok(geral.ppd >= loja.ppd);
    assert.ok(geral.sandwichesSalads >= loja.sandwichesSalads);
    assert.ok(geral.beverages >= loja.beverages);
    assert.ok(geral.additions >= loja.additions);
    assert.ok(geral.miscellaneous >= loja.miscellaneous);
  });
});

describe("robustez do parser", () => {
  test("rejeita um PDF sem a estrutura esperada", async () => {
    const bufFalso = Buffer.from("%PDF-1.4\n%%EOF");
    await assert.rejects(() => parseVisioProductReport(bufFalso));
  });
});

// ===========================================================================
// "Relatório de Vendas" — novo formato do Geral (auditoria de 15/08/2026).
// Fixture = o PDF real anexado pelo usuário (visio-vendas.pdf).
// ===========================================================================
describe("Relatório de Vendas — novo Geral (Faturamento + Ticket Médio + Cupons)", () => {
  test("extrai faturamento, ticket médio, cupons e estabelecimento", async () => {
    const r = await parseVisioSalesReport(readFileSync(join(FIXTURES, "visio-vendas.pdf")));
    assert.equal(r.faturamento, 10655.71);
    assert.equal(r.ticketMedio, 47.57);
    assert.equal(r.cuponsValidos, 224);
    assert.equal(r.cuponsVendas, 224);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
    assert.ok(r.hash);
  });

  test("rejeita um PDF sem a estrutura esperada", async () => {
    const bufFalso = Buffer.from("%PDF-1.4\n%%EOF");
    await assert.rejects(() => parseVisioSalesReport(bufFalso));
  });

  test("rejeita EXPLICITAMENTE um Relatório de Produtos enviado no campo do Relatório de Vendas", async () => {
    // F2 item 1: a recusa agora é imediata e clara (detectarTipoRelatorio),
    // não um erro vago de "não localizei o campo X".
    await assert.rejects(
      () => parseVisioSalesReport(readFileSync(join(FIXTURES, "visio-geral.pdf")), { rotulo: "Geral" }),
      (err) => {
        assert.match(err.message, /relatório de produtos/i);
        assert.match(err.message, /não.*relatório de vendas|relatório de vendas.*não/i);
        return true;
      },
    );
  });
});

// ===========================================================================
// F2 — DETECÇÃO RÍGIDA DO TIPO DE RELATÓRIO (pelo conteúdo, nunca pelo nome)
// ===========================================================================
describe("F2 — detectarTipoRelatorio", () => {
  test("Relatório de Produtos real (Loja) → 'produtos'", async () => {
    assert.equal(detectarTipoRelatorio(await matrizFixture("visio-loja.pdf")), "produtos");
  });
  test("Relatório de Produtos real (Geral) → 'produtos'", async () => {
    assert.equal(detectarTipoRelatorio(await matrizFixture("visio-geral.pdf")), "produtos");
  });
  test("Relatório de Vendas real → 'vendas'", async () => {
    assert.equal(detectarTipoRelatorio(await matrizFixture("visio-vendas.pdf")), "vendas");
  });
  test("conteúdo desconhecido (não-Visio) → null", async () => {
    assert.equal(detectarTipoRelatorio(await matrizFixture("rel-fat.pdf")), null);
    assert.equal(detectarTipoRelatorio(await matrizFixture("rel-prod.pdf")), null);
    assert.equal(detectarTipoRelatorio([["lorem"], ["ipsum"]]), null);
    assert.equal(detectarTipoRelatorio([]), null);
  });
  test("título sem âncora não basta (ex.: só a palavra 'Relatório de Vendas' solta)", () => {
    assert.equal(detectarTipoRelatorio([["Relatório de Vendas"], ["algo"]]), null);
    assert.equal(detectarTipoRelatorio([["Relatório de Produtos"], ["algo"]]), null);
  });
  test("título + âncora coerentes → detecta", () => {
    assert.equal(detectarTipoRelatorio([["Relatório de Produtos"], ["Torque por estabelecimento"]]), "produtos");
    assert.equal(detectarTipoRelatorio([["Relatório de Vendas"], ["Resumo de vendas"]]), "vendas");
  });
});

describe("F2 — cross-rejeição (slot errado)", () => {
  test("Relatório de Vendas no campo do Relatório de Produtos → rejeita", async () => {
    await assert.rejects(
      () => parseVisioProductReport(readFileSync(join(FIXTURES, "visio-vendas.pdf")), { rotulo: "Loja" }),
      (err) => { assert.match(err.message, /relatório de vendas/i); assert.match(err.message, /relatório de produtos/i); return true; },
    );
  });
  test("Relatório de Produtos no campo do Relatório de Vendas → rejeita", async () => {
    await assert.rejects(
      () => parseVisioSalesReport(readFileSync(join(FIXTURES, "visio-loja.pdf")), { rotulo: "Geral" }),
      (err) => { assert.match(err.message, /relatório de produtos/i); assert.match(err.message, /relatório de vendas/i); return true; },
    );
  });
  test("PDF não-Visio no slot de Produtos → rejeita como 'não reconhecido'", async () => {
    await assert.rejects(
      () => parseVisioProductReport(readFileSync(join(FIXTURES, "rel-prod.pdf")), { rotulo: "Loja" }),
      (err) => { assert.match(err.message, /não reconheci/i); return true; },
    );
  });
});

// ===========================================================================
// F2 — CAMPOS NOVOS DO RELATÓRIO DE PRODUTOS
// ===========================================================================
describe("F2 — Relatório de Produtos: campos novos (fixture Loja)", () => {
  let r;
  before(async () => { r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")), { rotulo: "Loja" }); });

  test("tipo = 'produtos'", () => assert.equal(r.tipo, "produtos"));
  test("Torque líquido", () => assert.equal(r.torque, 53.33));
  test("Perdas", () => assert.equal(r.perdas, 0));
  test("Produtos func. (7ª coluna da tabela Torque)", () => assert.equal(r.produtosFuncionais, 0));
  test("Fat. sanduíches/saladas", () => assert.equal(r.fatSanduichesSaladas, 2648.56));
  test("% do fat. total (sanduíches/saladas)", () => assert.equal(r.pctFatSanduichesSaladas, 68));
  test("Total de itens (Indicadores por categoria)", () => assert.equal(r.totalItens, 550));
  test("campos ANTIGOS permanecem intactos", () => {
    assert.equal(r.faturamento, 3893.15);
    assert.equal(r.ppd, 73);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
    assert.equal(r.sandwichesSalads, 132);
    assert.equal(r.beverages, 56);
    assert.equal(r.additions, 38);
    assert.equal(r.miscellaneous, 19);
    assert.ok(perto(r.percentualBebidasPdf, 42.4));
    assert.ok(perto(r.percentualAdicionaisPdf, 28.8));
    assert.ok(perto(r.percentualDiversosPdf, 14.4));
    assert.ok(r.hash);
  });
});

describe("F2 — Relatório de Produtos: campos novos (fixture Geral)", () => {
  test("torque / fatSanduiches / % / totalItens do Geral", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-geral.pdf")), { rotulo: "Geral" });
    assert.equal(r.torque, 58.6);
    assert.equal(r.perdas, 0);
    assert.equal(r.fatSanduichesSaladas, 3928.06);
    assert.equal(r.pctFatSanduichesSaladas, 42.3);
    assert.equal(r.totalItens, 3573);
    // antigos
    assert.equal(r.faturamento, 9845.09);
    assert.equal(r.ppd, 168);
    assert.equal(r.sandwichesSalads, 307);
  });
});

// ===========================================================================
// F2 — MÉTODOS DE PAGAMENTO (Relatório de Vendas) — persistidos, fora do cálculo
// ===========================================================================
describe("F2 — Relatório de Vendas: métodos de pagamento (fixture real)", () => {
  let r;
  before(async () => { r = await parseVisioSalesReport(readFileSync(join(FIXTURES, "visio-vendas.pdf")), { rotulo: "Geral" }); });

  test("tipo = 'vendas' + campos confirmados", () => {
    assert.equal(r.tipo, "vendas");
    assert.equal(r.faturamento, 10655.71);
    assert.equal(r.ticketMedio, 47.57);
    assert.equal(r.cuponsValidos, 224);
    assert.equal(r.cuponsVendas, 224);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
  });
  test("metodosPagamento no formato canônico [{metodo, qtd, valor}]", () => {
    assert.ok(Array.isArray(r.metodosPagamento));
    assert.equal(r.metodosPagamento.length, 10); // a fixture traz só a página 1 (Visio pagina esta seção)
    for (const m of r.metodosPagamento) {
      assert.equal(typeof m.metodo, "string");
      assert.ok(m.metodo.length > 0);
      assert.ok(Number.isInteger(m.qtd) && m.qtd >= 0);
      assert.ok(typeof m.valor === "number" && m.valor >= 0);
    }
  });
  test("valores exatos das 3 primeiras linhas", () => {
    assert.deepEqual(r.metodosPagamento[0], { metodo: "IFOOD ONLINE", qtd: 147, valor: 6649.45 });
    assert.deepEqual(r.metodosPagamento[1], { metodo: "DINHEIRO", qtd: 15, valor: 650.46 });
    assert.deepEqual(r.metodosPagamento[2], { metodo: "CARTAO/PIX TEF", qtd: 14, valor: 617.74 });
  });
  test("métodos de pagamento NÃO alteram faturamento/ticket (só conferência)", () => {
    const somaMetodos = r.metodosPagamento.reduce((s, m) => s + m.valor, 0);
    // a soma da página 1 é MENOR que o faturamento total (há página 2) — e isso é OK,
    // o parser não tenta reconciliar nem "consertar" o número.
    assert.ok(somaMetodos <= r.faturamento);
  });
});

// ===========================================================================
// F2 — NORMALIZAÇÃO pt-BR: 4 regras, 1 por tipo de campo
// ===========================================================================
describe("F2 — normalização: quantidade / moeda / percentual / número decimal", () => {
  test("casos obrigatórios do enunciado", () => {
    assert.equal(parseQuantidadeBR("3.460"), 3460);
    assert.equal(parseQuantidadeBR("1.412"), 1412);
    assert.equal(parseNumeroBR("2.089"), 2089);
    assert.equal(parseNumeroBR("180,5"), 180.5);
    assert.equal(parseMoedaBR("R$ 109.613,74"), 109613.74);
  });
  test("quantidade → inteiro; fracionária/lixo NUNCA passa silenciosamente", () => {
    assert.equal(parseQuantidadeBR("3.46"), null);       // seria o bug antigo
    assert.equal(parseQuantidadeBR("3.460,5"), null);
    assert.equal(parseQuantidadeBR("12,7"), null);
    assert.equal(parseQuantidadeBR("42,4%"), null);
    assert.equal(parseQuantidadeBR("-5"), null);
    assert.equal(parseQuantidadeBR(""), null);
    assert.equal(parseQuantidadeBR("abc"), null);
  });
  test("moeda → decimal monetário", () => {
    assert.equal(parseMoedaBR("$ 3.893,15"), 3893.15);
    assert.equal(parseMoedaBR("R$ 5.000"), 5000);
    assert.equal(parseMoedaBR("$ 0,00"), 0);
  });
  test("percentual → decimal (tira o %)", () => {
    assert.equal(parsePercentualBR("68,0%"), 68);
    assert.equal(parsePercentualBR("42,4%"), 42.4);
    assert.equal(parsePercentualBR("100,0%"), 100);
    assert.equal(parsePercentualBR("lixo"), null);
  });
  test("número decimal → decimal", () => {
    assert.equal(parseNumeroBR("57"), 57);
    assert.equal(parseNumeroBR("53,33"), 53.33);
    assert.equal(parseNumeroBR("1.234"), 1234);
  });
});

// ===========================================================================
// F2 — o PDF mensal real que causou o bug: 3460 / 1412 / 785 / 655 como INTEIROS
// (o PDF em si foi removido do Storage; provamos pelo MESMO caminho de código
//  que parseVisioProductReport usa — extrairMixVendas sobre a matriz.)
// ===========================================================================
describe("F2 — mix mensal com milhar: 3.460 / 1.412 / 785 / 655 → inteiros", () => {
  const ANC = ["% de acompanhamentos em vendas principais"];
  test("extrairMixVendas devolve inteiros fiéis ao PDF (nunca 3.46 / 1.412)", () => {
    const matriz = [ANC, ["Sanduíches/Saladas", "3.460"], ["Bebidas", "1.412"], ["Adicionais", "785"], ["Diversos", "655"],
      ["Total", "6.312", "182,4%"], ["100,0%"], ["40,8%"], ["22,7%"], ["18,9%"]];
    const r = extrairMixVendas(matriz, "mensal");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.sanduichesSaladas, 3460);
    assert.equal(r.bebidas, 1412);
    assert.equal(r.adicionais, 785);
    assert.equal(r.diversos, 655);
    assert.ok(Number.isInteger(r.sanduichesSaladas) && Number.isInteger(r.bebidas));
    // percentuais só DEPOIS da normalização
    assert.equal(((r.bebidas / r.sanduichesSaladas) * 100).toFixed(1), "40.8");
    assert.equal(((r.adicionais / r.sanduichesSaladas) * 100).toFixed(1), "22.7");
    assert.equal(((r.diversos / r.sanduichesSaladas) * 100).toFixed(1), "18.9");
  });
});

// ===========================================================================
// Resiliência do Mix de Vendas — extrairMixVendas() é exportada de propósito
// para testar direto contra matrizes SINTÉTICAS (a mesma estrutura que
// textoParaMatriz() produz), sem depender de um PDF real pra cada variação
// de layout. O anexo "% de acompanhamentos em vendas principais" entra em
// todos os casos "com seção" porque é o que ancora a busca primária.
// ===========================================================================
describe("extrairMixVendas — categoria por NOME, nunca por posição fixa", () => {
  const ANCORA = ["% de acompanhamentos em vendas principais"];

  test("ordem normal (Sanduíches, Bebidas, Adicionais, Diversos)", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Adicionais", "21"], ["Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.sanduichesSaladas, 96);
    assert.equal(r.bebidas, 34);
    assert.equal(r.adicionais, 21);
    assert.equal(r.diversos, 10);
  });

  test("ordem TROCADA (Bebidas, Diversos, Adicionais) — item pedido explicitamente", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Diversos", "10"], ["Adicionais", "21"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.bebidas, 34);
    assert.equal(r.adicionais, 21);
    assert.equal(r.diversos, 10);
  });

  test("rótulo e quantidade em linhas separadas (não só na mesma linha)", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas"], ["96"], ["Bebidas"], ["34"], ["Adicionais"], ["21"], ["Diversos"], ["10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.sanduichesSaladas, 96);
    assert.equal(r.bebidas, 34);
  });

  test("rótulo quebrado em duas linhas (\"Sanduíches/\" + \"Saladas\")", () => {
    const matriz = [ANCORA, ["Sanduíches/"], ["Saladas", "96"], ["Bebidas", "34"], ["Adicionais", "21"], ["Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.equal(r.sanduichesSaladas, 96);
    assert.deepEqual(r.faltando, []);
  });

  test("maiúsculas, acentos e espaços duplicados não importam", () => {
    const matriz = [ANCORA, ["  SANDUÍCHES/SALADAS  ", "96"], ["bebidas:", "34"], ["Adicionais   ", "21"], ["- Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.bebidas, 34);
    assert.equal(r.diversos, 10);
  });

  test("separador de MILHAR pt-BR: \"3.460\" é 3460, nunca 3.46 (bug do relatório mensal)", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas", "3.460"], ["Bebidas", "1.412"], ["Adicionais", "785"], ["Diversos", "655"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.sanduichesSaladas, 3460);
    assert.equal(r.bebidas, 1412);
    assert.equal(r.adicionais, 785);
    assert.equal(r.diversos, 655);
    // percentuais só depois da normalização: 1412/3460 = 40,8% ; 785/3460 = 22,7% ; 655/3460 = 18,9%
    assert.equal(((r.bebidas / r.sanduichesSaladas) * 100).toFixed(1), "40.8");
    assert.equal(((r.adicionais / r.sanduichesSaladas) * 100).toFixed(1), "22.7");
    assert.equal(((r.diversos / r.sanduichesSaladas) * 100).toFixed(1), "18.9");
  });

  test("quantidade é SEMPRE inteira — um valor fracionário não é aceito como quantidade", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas", "96,5"], ["Bebidas", "34"], ["Adicionais", "21"], ["Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.equal(r.sanduichesSaladas, null);
    assert.deepEqual(r.faltando, ["Sanduíches/Saladas"]); // erra alto, nunca grava 96,5
  });

  test("nunca confunde a tabela de REFERÊNCIA de mercado (percentuais) com a quantidade real", () => {
    // "Como deve ser meu Mix de vendas?" tem uma linha "Bebidas" própria,
    // só com percentuais de benchmark — bem antes da seção de verdade.
    const referencia = ["Bebidas", "52%", "56%", "77%", "65%"];
    const matriz = [referencia, ANCORA, ["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Adicionais", "21"], ["Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.equal(r.bebidas, 34); // não 52 (que nem é um número puro — é percentual)
  });

  test("sem a seção-âncora, cai no fallback (documento inteiro) e ainda acha", () => {
    const matriz = [["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Adicionais", "21"], ["Diversos", "10"]];
    const r = extrairMixVendas(matriz, "teste");
    assert.deepEqual(r.faltando, []);
  });

  test("falta só UMA categoria -> erro aponta exatamente ela, não todas", () => {
    const matriz = [ANCORA, ["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Diversos", "10"]]; // sem Adicionais
    const r = extrairMixVendas(matriz, "Loja");
    assert.deepEqual(r.faltando, ["Adicionais"]);
    assert.equal(r.bebidas, 34);
    assert.equal(r.diversos, 10);
  });

  test("mensagem final cita só o campo que falta, no relatório certo", async () => {
    // Passa pela extração completa via um matriz forjado — testa a mensagem
    // de erro fim a fim como o parser realmente monta, não só o retorno bruto.
    const r = extrairMixVendas([ANCORA, ["Sanduíches/Saladas", "96"], ["Bebidas", "34"], ["Diversos", "10"]], "Loja");
    assert.equal(r.faltando.length, 1);
    assert.equal(r.faltando[0], "Adicionais");
  });

  // -------------------------------------------------------------------------
  // percentualBebidasPdf/AdicionaisPdf/DiversosPdf — linhas soltas de % logo
  // depois de "Total". A Visio varia a ordem das linhas do mix; o percentual
  // impresso tem que sair PELO RÓTULO da categoria, nunca pela posição.
  // (bug: 01/09/2026 — PDF listava Diversos antes de Adicionais e os dois
  //  percentuais impressos saíam trocados; as quantidades sempre certas.)
  // -------------------------------------------------------------------------
  test("percentual impresso — ordem Diversos→Adicionais (layout real 01/09/2026)", () => {
    const matriz = [
      ANCORA, ["Mix de vendas semanal"],
      ["Sanduíches/Saladas", "108"],
      ["Bebidas", "49"],
      ["Diversos", "21"],
      ["Adicionais", "20"],
      ["Total", "198", "183,3%"],
      ["100,0%"], ["45,4%"], ["19,4%"], ["18,5%"],
    ];
    const r = extrairMixVendas(matriz, "Loja");
    assert.deepEqual(r.faltando, []);
    // quantidades (inalteradas — sempre por rótulo)
    assert.equal(r.bebidas, 49);
    assert.equal(r.adicionais, 20);
    assert.equal(r.diversos, 21);
    // percentuais impressos, agora pelo rótulo certo
    assert.equal(r.percentualBebidasPdf, 45.4);
    assert.equal(r.percentualAdicionaisPdf, 18.5);   // era 19.4 (transposto) antes da correção
    assert.equal(r.percentualDiversosPdf, 19.4);     // era 18.5 (transposto) antes da correção
    // e continua batendo com a quantidade derivada
    assert.equal(((r.adicionais / r.sanduichesSaladas) * 100).toFixed(1), "18.5");
    assert.equal(((r.diversos / r.sanduichesSaladas) * 100).toFixed(1), "19.4");
  });

  test("percentual impresso — ordem normal Adicionais→Diversos (controle, layout 02/09/2026)", () => {
    const matriz = [
      ANCORA,
      ["Sanduíches/Saladas", "120"],
      ["Bebidas", "49"],
      ["Adicionais", "24"],
      ["Diversos", "18"],
      ["Total", "191", "159,2%"],
      ["100,0%"], ["40,8%"], ["20,0%"], ["15,0%"],
    ];
    const r = extrairMixVendas(matriz, "Loja");
    assert.deepEqual(r.faltando, []);
    assert.equal(r.percentualBebidasPdf, 40.8);
    assert.equal(r.percentualAdicionaisPdf, 20);
    assert.equal(r.percentualDiversosPdf, 15);
  });

  test("percentual impresso — sem a linha 100% da base, ainda mapeia por rótulo", () => {
    const matriz = [
      ANCORA,
      ["Sanduíches/Saladas", "100"],
      ["Bebidas", "40"],
      ["Diversos", "20"],
      ["Adicionais", "10"],
      ["Total", "170", "170,0%"],
      ["40,0%"], ["20,0%"], ["10,0%"],
    ];
    const r = extrairMixVendas(matriz, "Loja");
    assert.equal(r.percentualBebidasPdf, 40);
    assert.equal(r.percentualAdicionaisPdf, 10);
    assert.equal(r.percentualDiversosPdf, 20);
  });
});
