// Catálogo VERSIONADO de operação (conexão compartilhada, 148): regressão do conteúdo, regras da classificação estrita e do
// gerador offline. Mudar uma linha do catálogo exige gerar nova versão (scripts/foody-gerar-catalogo.mjs) e atualizar o hash
// fixado aqui — em PR, nunca em produção.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGO_OPERACAO } from "../src/modules/foody/foody.catalogo-operacao.js";
import {
  classificarPedidoCompartilhado, normalizarLinhaItem, linhasDoPedido, operacoesPorTermo, TERMOS_VALIDADOS, CATALOGO_VERSAO,
} from "../src/modules/foody/foody.classificacao.js";
import { gerarCatalogo, hashCatalogo, pareceTextoLivre, incluirValidadas, renderizarCatalogo } from "../src/modules/foody/foody.catalogo.gerador.js";
import { LINHAS_VALIDADAS } from "../src/modules/foody/foody.catalogo-validadas.js";

const MODULO = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "foody");
// 2026-11-05.1 = 2026-11-03.1 (gerado, hash 78ee2124…) + 3 linhas Subway validadas à mão após o piloto de 02/11/2026.
const VERSAO_FIXADA = "2026-11-05.1";
const HASH_FIXADO = "d471d07e713b318ada1bfc3347fd8a53dd98e6fbb919313aee79ba19f3aa7209";
const HASH_BASE_GERADA = "78ee21241de8674e9ea641d8dabb71dd067559f87ec2dcf5f6171993fa0b5f9f";

describe("catálogo versionado — regressão", () => {
  test("versão e hash fixados; o hash confere com o conteúdo", () => {
    assert.equal(CATALOGO_OPERACAO.versao, VERSAO_FIXADA);
    assert.equal(CATALOGO_VERSAO, VERSAO_FIXADA);
    assert.equal(CATALOGO_OPERACAO.hash, HASH_FIXADO);
    assert.equal(hashCatalogo(CATALOGO_OPERACAO.linhas), HASH_FIXADO, "conteúdo mudou sem nova versão");
    assert.deepEqual(Object.keys(CATALOGO_OPERACAO.linhas).sort(), ["acai_no_grau", "subway"]);
    assert.equal(CATALOGO_OPERACAO.linhas.subway.length, 332);
    assert.equal(CATALOGO_OPERACAO.linhas.acai_no_grau.length, 91);
  });
  test("congelado: não aprende em execução (nem por mutação nem pela classificação)", () => {
    assert.ok(Object.isFrozen(CATALOGO_OPERACAO) && Object.isFrozen(CATALOGO_OPERACAO.linhas));
    for (const op of Object.keys(CATALOGO_OPERACAO.linhas)) {
      assert.ok(Object.isFrozen(CATALOGO_OPERACAO.linhas[op]));
      assert.throws(() => { "use strict"; CATALOGO_OPERACAO.linhas[op].push("linha nova"); });
    }
    for (let i = 0; i < 50; i++) classificarPedidoCompartilhado(`1x Produto Inédito ${i}\n1x Sub Frango Teriyaki 15cm`);
    assert.equal(hashCatalogo(CATALOGO_OPERACAO.linhas), HASH_FIXADO);
  });
  test("o módulo não escreve arquivo nem tem caminho de aprendizado (sem fs, sem insert em catálogo)", () => {
    for (const f of readdirSync(MODULO)) {
      const s = readFileSync(join(MODULO, f), "utf8");
      assert.doesNotMatch(s, /from\s+["']node:fs["']|require\(["']fs["']\)|writeFile/, f);
    }
  });
  test("cada linha pertence a UMA operação, já normalizada, sem termo da outra e sem cara de texto livre/dado pessoal", () => {
    const { subway, acai_no_grau: acai } = CATALOGO_OPERACAO.linhas;
    const s = new Set(subway);
    assert.equal(acai.filter((l) => s.has(l)).length, 0);
    for (const [op, linhas] of Object.entries(CATALOGO_OPERACAO.linhas)) {
      assert.equal(new Set(linhas).size, linhas.length, `${op}: linha repetida`);
      for (const l of linhas) {
        assert.equal(normalizarLinhaItem(l), l, `não normalizada: ${l}`);
        assert.ok(!pareceTextoLivre(l), `texto livre: ${l}`);
        assert.ok(operacoesPorTermo(l).every((o) => o === op), `termo de outra operação: ${l}`);
        assert.doesNotMatch(l, /@|\d{5,}|\b(rua|cpf|telefone|cliente|apto)\b/);
      }
    }
  });
  test("termos validados: lista curta e com origem; paletas são só do Açaí", () => {
    assert.deepEqual(TERMOS_VALIDADOS.acai_no_grau.map((x) => x.termo), ["acai", "paleta"]);
    assert.deepEqual(TERMOS_VALIDADOS.subway.map((x) => x.termo), ["subway"]);
    assert.ok([...TERMOS_VALIDADOS.acai_no_grau, ...TERMOS_VALIDADOS.subway].every((x) => x.origem.length > 10));
  });
});

describe("classificação estrita", () => {
  const op = (d) => classificarPedidoCompartilhado(d);
  test("linha inteira, nunca palavra solta: 'gotas de chocolate' é Açaí; o cookie com gotas é Subway", () => {
    assert.equal(op("1x Gotas de chocolate").operacao, "acai_no_grau");
    assert.equal(op("1x Cookie Tradicional Gotas de Chocolate").operacao, "subway");
    assert.equal(op("Cookies Individuais 1x Tradicional Gotas de Chocolate").operacao, "subway");
    assert.equal(op("1x Creme de Cookies(Tradicional)").operacao, "acai_no_grau");
  });
  test("paleta → Açaí (catálogo ou termo); açaí por termo; subway por termo", () => {
    assert.equal(op("1x Paleta Ninho com Nutella").operacao, "acai_no_grau");
    assert.equal(op("1x Paleta de Limão Inédita").operacao, "acai_no_grau");
    assert.equal(op("1x Açaí Gigante Novo 1L").operacao, "acai_no_grau");
    assert.equal(op("1x Combo Subway Novo do Mês").operacao, "subway");
  });
  test("AJUSTE OBRIGATÓRIO: qualquer linha desconhecida manda o pedido inteiro para a triagem", () => {
    const r = op("1x Sub Frango Teriyaki 15cm\nFanta Laranja\n1x Produto Novo Misterioso");
    assert.deepEqual([r.operacao, r.motivo, r.linhas, r.desconhecidas], ["triagem", "ITEM_DESCONHECIDO", 3, 1]);
    assert.equal(op("1x Açaí Premium 500ml\n1x Topping Novo X").operacao, "triagem");
    assert.equal(op("1x Produto Novo Misterioso").motivo, "ITEM_DESCONHECIDO");
  });
  test("evidências de operações diferentes → CONFLITO; vazio → SEM_EVIDENCIA", () => {
    assert.equal(op("1x Sub Frango Teriyaki 15cm\n1x Açaí Premium 500ml").motivo, "CONFLITO");
    assert.equal(op("1x Subway Açaí").motivo, "CONFLITO", "termos das duas na mesma linha");
    assert.equal(op("").motivo, "SEM_EVIDENCIA");
    assert.equal(op(null).motivo, "SEM_EVIDENCIA");
  });
  test("normalização: quantidade, acento, caixa, tamanhos e espaços", () => {
    assert.equal(normalizarLinhaItem("  2x  SUB Frango   Teriyaki 30cm "), "sub frango teriyaki #cm");
    assert.deepEqual(linhasDoPedido("1x Alface\r\n1x Alface\n\n"), ["alface"]);
    assert.equal(op("3x Refrigerante 350ml 1x Coca Cola").operacao, "subway");
  });
  test("o resultado nunca cita produto (só contagens) e traz a versão", () => {
    const r = op("1x Sub Frango Teriyaki 15cm");
    assert.deepEqual(Object.keys(r).sort(), ["catalogoVersao", "desconhecidas", "evidencias", "linhas", "motivo", "operacao"]);
    assert.equal(r.catalogoVersao, VERSAO_FIXADA);
  });
});

describe("gerador offline", () => {
  const ped = (detalhes, dia) => ({ detalhes, dia });
  const base = [
    ped("1x Açaí Premium 500ml\n1x Granola", "2026-10-01"), ped("1x Açaí Premium 500ml\n1x Granola", "2026-10-02"),
    ped("Subway Sub Frango\n1x Alface", "2026-10-01"), ped("Subway Sub Frango\n1x Alface", "2026-10-02"),
    ped("Subway Sub Frango\n1x Banana", "2026-10-01"), ped("1x Açaí Premium 500ml\n1x Banana", "2026-10-02"), // vista nas duas
    ped("1x Açaí Premium 500ml\n1x Rua das Flores 123", "2026-10-01"), ped("1x Açaí Premium 500ml\n1x Rua das Flores 123", "2026-10-03"),
    ped("1x Granola\n1x Alface", "2026-10-04"), // sem termo: não treina
    ped("1x Açaí Premium 500ml\n1x Rara", "2026-10-01"),
  ];
  test("só treina com pedido rotulado por termo; descarta linha das duas operações, rara e texto livre", () => {
    const c = gerarCatalogo(base);
    assert.ok(c.linhas.acai_no_grau.includes("granola"));
    assert.ok(c.linhas.subway.includes("alface"));
    assert.ok(!c.linhas.subway.includes("banana") && !c.linhas.acai_no_grau.includes("banana"));
    assert.ok(!c.linhas.acai_no_grau.some((l) => l.includes("rua")));
    assert.ok(!c.linhas.acai_no_grau.includes("rara"));
    assert.equal(c.estatisticas.semTermoOuRevisao, 1);
    assert.equal(c.estatisticas.linhasVistasNasDuas, 1);
  });
  test("determinístico: mesma entrada (em qualquer ordem) → mesmo hash", () => {
    assert.equal(gerarCatalogo(base).hash, gerarCatalogo([...base].reverse()).hash);
    assert.notEqual(gerarCatalogo(base).hash, gerarCatalogo(base.slice(0, 2)).hash);
  });
});

describe("linhas validadas à mão (catálogo 2026-11-05.1)", () => {
  const op = (d) => classificarPedidoCompartilhado(d);
  const semValidadas = () => {
    const v = new Set(LINHAS_VALIDADAS.map((x) => x.linha));
    return Object.fromEntries(Object.entries(CATALOGO_OPERACAO.linhas).map(([o, l]) => [o, l.filter((x) => !v.has(x))]));
  };
  test("o catálogo é EXATAMENTE a base gerada (78ee2124…) + as validadas; refazer a junção dá o mesmo hash", () => {
    const base = semValidadas();
    assert.equal(hashCatalogo(base), HASH_BASE_GERADA);
    const r = incluirValidadas(base, LINHAS_VALIDADAS);
    assert.equal(r.incluidas, LINHAS_VALIDADAS.length);
    assert.equal(r.hash, HASH_FIXADO);
    assert.equal(CATALOGO_OPERACAO.origem.base, "2026-11-03.1");
    assert.equal(CATALOGO_OPERACAO.origem.validadasManualmente, LINHAS_VALIDADAS.length);
  });
  test("cada validada: congelada, normalizada, cardápio, com evidência e data, e só da Subway", () => {
    assert.ok(Object.isFrozen(LINHAS_VALIDADAS) && LINHAS_VALIDADAS.every(Object.isFrozen));
    assert.equal(LINHAS_VALIDADAS.length, 3);
    for (const v of LINHAS_VALIDADAS) {
      assert.equal(v.operacao, "subway");
      assert.equal(normalizarLinhaItem(v.linha), v.linha);
      assert.ok(!pareceTextoLivre(v.linha));
      assert.ok(v.evidencia.length > 40 && /^\d{4}-\d{2}-\d{2}$/.test(v.validadoEm));
      assert.ok(!CATALOGO_OPERACAO.linhas.acai_no_grau.includes(v.linha));
    }
  });
  test("as três triagens do piloto de 02/11 viram Subway (texto bruto como a Foody manda)", () => {
    assert.equal(op("Combos no Precinho 30cm 1x Frango Defumado com Cream Cheese").operacao, "subway");
    assert.equal(op("Subs 15cm 2x B.M.T.").operacao, "subway");
    assert.equal(op("Sucos 2x Suco Del Valle Uva").operacao, "subway");
    assert.equal(op("Subs 15cm 2x B.M.T.\nSucos 2x Suco Del Valle Uva\n1x Sub Frango Teriyaki 15cm").operacao, "subway");
  });
  test("sem risco para o Açaí: pedido do Açaí segue Açaí; mistura com validada continua indo para a triagem por CONFLITO", () => {
    assert.equal(op("1x Açaí Premium 500ml").operacao, "acai_no_grau");
    assert.equal(op("1x Açaí Premium 500ml\nSucos 2x Suco Del Valle Uva").motivo, "CONFLITO");
    assert.equal(op("1x Paleta Morango\nSubs 15cm 2x B.M.T.").motivo, "CONFLITO");
    assert.notEqual(op("1x Suco Nectar Maracuja 300ml - Mirador").operacao, "subway", "suco de outra marca não vira Subway");
    assert.equal(op("Sucos 3x Suco Del Valle Uva").operacao, "triagem", "variação nova continua indo para a triagem (sem curinga)");
  });
  test("incluirValidadas recusa (com erro) linha da outra operação, com termo da outra, texto livre, não normalizada ou sem evidência", () => {
    const base = { subway: ["alface"], acai_no_grau: ["granola"] };
    const v = (o) => ({ operacao: "subway", linha: "linha nova", validadoEm: "2026-11-05", evidencia: "evidência suficiente para o teste", ...o });
    assert.throws(() => incluirValidadas(base, [v({ linha: "granola" })]), /catálogo de acai_no_grau/);
    assert.throws(() => incluirValidadas(base, [v({ linha: "acai com leite" })]), /termo de outra operação/);
    assert.throws(() => incluirValidadas(base, [v({ linha: "entregar na rua x" })]), /texto livre/);
    assert.throws(() => incluirValidadas(base, [v({ linha: "Linha Nova" })]), /não normalizada/);
    assert.throws(() => incluirValidadas(base, [v({ evidencia: "curta" })]), /evidência/);
    assert.throws(() => incluirValidadas(base, [v({ operacao: "outra" })]), /operação desconhecida/);
    const r = incluirValidadas(base, [v({}), v({ linha: "alface" })]);
    assert.deepEqual([r.incluidas, r.jaPresentes, r.linhas.subway], [1, 1, ["alface", "linha nova"]]);
    assert.deepEqual(base.subway, ["alface"], "não muta a entrada");
  });
  test("renderizarCatalogo reproduz o arquivo versionado byte a byte", () => {
    const arquivo = readFileSync(join(MODULO, "foody.catalogo-operacao.js"), "utf8");
    const corpo = { versao: CATALOGO_OPERACAO.versao, hash: CATALOGO_OPERACAO.hash, origem: CATALOGO_OPERACAO.origem,
      termosValidados: Object.fromEntries(Object.entries(CATALOGO_OPERACAO.termosValidados).map(([o, l]) => [o, [...l]])), linhas: CATALOGO_OPERACAO.linhas };
    assert.equal(renderizarCatalogo(corpo), arquivo.replace(/\r\n/g, "\n"));
  });
});
