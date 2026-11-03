// Catálogo VERSIONADO de operação (conexão compartilhada, 145): regressão do conteúdo, regras da classificação estrita e do
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
import { gerarCatalogo, hashCatalogo, pareceTextoLivre } from "../src/modules/foody/foody.catalogo.gerador.js";

const MODULO = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "foody");
const VERSAO_FIXADA = "2026-11-03.1";
const HASH_FIXADO = "78ee21241de8674e9ea641d8dabb71dd067559f87ec2dcf5f6171993fa0b5f9f";

describe("catálogo versionado — regressão", () => {
  test("versão e hash fixados; o hash confere com o conteúdo", () => {
    assert.equal(CATALOGO_OPERACAO.versao, VERSAO_FIXADA);
    assert.equal(CATALOGO_VERSAO, VERSAO_FIXADA);
    assert.equal(CATALOGO_OPERACAO.hash, HASH_FIXADO);
    assert.equal(hashCatalogo(CATALOGO_OPERACAO.linhas), HASH_FIXADO, "conteúdo mudou sem nova versão");
    assert.deepEqual(Object.keys(CATALOGO_OPERACAO.linhas).sort(), ["acai_no_grau", "subway"]);
    assert.equal(CATALOGO_OPERACAO.linhas.subway.length, 329);
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
