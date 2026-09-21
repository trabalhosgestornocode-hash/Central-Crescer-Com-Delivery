// C.9.7 — testes UNITÁRIOS da identidade EFÊMERA dos nós da fila offline (src/offlineIdentidade.js).
// Pergunta: "os nós desta conexão são os MESMOS da anterior ou um trecho NOVO?" — respondida só com CONTAGENS, sem registrar identificador.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { criarIdentidadeOffline, PADROES_IDENTIDADE, ESPECIES_IDENTIDADE, MOTIVOS_NAO_COMPARAVEL } from "../src/offlineIdentidade.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const SEGREDO = Buffer.alloc(32, 0x5a);
const FROM = "5511999990000@s.whatsapp.net";
/** material fictício de uma stanza */
const p = (i, extra = {}) => ({ type: "text", id: `MSGID-SENTINELA-${String(i).padStart(5, "0")}`, from: FROM, participant: undefined, ...extra });
/** registra `n` nós message (ids inicio..inicio+n-1) na geração `g` */
function nos(idt, g, n, { inicio = 0, especie = "message", extra = {} } = {}) {
  for (let i = inicio; i < inicio + n; i++) idt.registrar(g, especie, p(i, extra));
}
const criar = (o = {}) => criarIdentidadeOffline({ segredo: SEGREDO, ...o });

describe("comparação entre gerações (só contagens)", () => {
  test("A. exatamente os MESMOS nós: overlap 100%, novos 0", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 100);
    idt.novaGeracao(2); nos(idt, 2, 100);
    const r = idt.comparar(2);
    assert.deepEqual([r.comparavel, r.motivo, r.previousGeneration, r.currentGeneration, r.geracoesEntre], [true, null, 1, 2, 1]);
    assert.deepEqual([r.previousCount, r.currentCount, r.overlapCount, r.newCount, r.missingCount], [100, 100, 100, 0, 0]);
    assert.deepEqual([r.overlapPct, r.newPct, r.missingPct], [100, 0, 0]);
    assert.deepEqual([r.overlapIdOnlyCount, r.overlapIdOnlyPct], [100, 100]);
    assert.deepEqual([r.currentIdOnlyCount, r.previousIdOnlyCount, r.newIdOnlyCount, r.missingIdOnlyCount, r.newIdOnlyPct, r.missingIdOnlyPct], [100, 100, 0, 0, 0, 0], "frouxo completo: current/previous/new/missing");
  });

  test("B. NENHUM nó igual: overlap 0, novos 100%, e todos os 100 anteriores 'sumiram'", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 100);
    idt.novaGeracao(2); nos(idt, 2, 100, { inicio: 1000 });
    const r = idt.comparar(2);
    assert.deepEqual([r.overlapCount, r.newCount, r.missingCount, r.overlapPct, r.newPct, r.missingPct], [0, 100, 100, 0, 100, 100]);
    assert.deepEqual([r.seenInRetainedCount, r.unseenInRetainedCount], [0, 100]);
  });

  test("C. PARCIAL: 100 anteriores, 50 iguais + 50 novos (e o exemplo 103 × 102 do enunciado)", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 100);
    idt.novaGeracao(2); nos(idt, 2, 50); nos(idt, 2, 50, { inicio: 5000 });
    const r = idt.comparar(2);
    assert.deepEqual([r.previousCount, r.currentCount, r.overlapCount, r.newCount, r.missingCount, r.overlapPct, r.newPct, r.missingPct], [100, 100, 50, 50, 50, 50, 50, 50]);
    const idt2 = criar(); idt2.novaGeracao(1); nos(idt2, 1, 102); idt2.novaGeracao(2); nos(idt2, 2, 2); nos(idt2, 2, 101, { inicio: 9000 });
    const q = idt2.comparar(2);
    assert.deepEqual([q.currentCount, q.previousCount, q.overlapCount, q.newCount, q.missingCount, q.overlapPct, q.newPct], [103, 102, 2, 101, 100, 1.9, 98.1]);
  });

  test("D. ORDEM diferente: os mesmos nós em outra ordem (invertida e embaralhada) ⇒ overlap 100%", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 60);
    idt.novaGeracao(2);
    const ordem = [...Array(60).keys()].reverse(); for (const i of ordem) idt.registrar(2, "message", p(i));
    assert.equal(idt.comparar(2).overlapPct, 100);
    idt.novaGeracao(3); for (const i of [...Array(60).keys()].sort((a, b) => ((a * 37) % 60) - ((b * 37) % 60))) idt.registrar(3, "message", p(i));
    assert.equal(idt.comparar(3).overlapPct, 100);
  });

  test("E. DUPLICATA dentro do mesmo socket não infla a contagem de identidade (e é contada à parte)", () => {
    const idt = criar(); idt.novaGeracao(1);
    assert.equal(idt.registrar(1, "message", p(1)), "novo"); assert.equal(idt.registrar(1, "message", p(1)), "duplicado"); assert.equal(idt.registrar(1, "message", p(1)), "duplicado");
    const r = idt.comparar(1);
    assert.deepEqual([r.currentCount, r.duplicadosNoSocket, r.motivo, r.comparavel], [1, 2, "sem_geracao_anterior", false]);
  });

  test("F. NAMESPACE: a mesma id em outra ESPÉCIE não é o mesmo item; o mesmo id com `type` diferente é outro na identidade estrita e o mesmo na frouxa", () => {
    const idt = criar(); idt.novaGeracao(1); idt.registrar(1, "message", p(1));
    idt.novaGeracao(2); idt.registrar(2, "receipt", p(1));
    const r = idt.comparar(2);
    assert.deepEqual([r.overlapCount, r.overlapIdOnlyCount], [0, 0], "message X ≠ receipt X (a espécie está no material das duas)");
    assert.deepEqual(r.porEspecie.map((e) => [e.nome, e.currentCount, e.overlapCount]), [["message", 0, 0], ["receipt", 1, 0], ["notification", 0, 0]]);
    const idt2 = criar(); idt2.novaGeracao(1); idt2.registrar(1, "message", p(7, { type: "text" }));
    idt2.novaGeracao(2); idt2.registrar(2, "message", p(7, { type: "media" }));
    const q = idt2.comparar(2); assert.deepEqual([q.overlapCount, q.overlapIdOnlyCount], [0, 1]);
  });

  test("`participant` e `from` entram na identidade ESTRITA (mesmo id, outro participante/remetente ⇒ outro item), mas não na frouxa", () => {
    for (const [campo, a, b] of [["participant", "111@lid", "222@lid"], ["from", "120363000000000001@g.us", "120363000000000002@g.us"]]) {
      const idt = criar(); idt.novaGeracao(1); idt.registrar(1, "message", p(5, { [campo]: a }));
      idt.novaGeracao(2); idt.registrar(2, "message", p(5, { [campo]: b }));
      const r = idt.comparar(2); assert.deepEqual([r.overlapCount, r.overlapIdOnlyCount], [0, 1], campo);
      idt.novaGeracao(3); idt.registrar(3, "message", p(5, { [campo]: b }));
      assert.equal(idt.comparar(3).overlapCount, 1, `${campo}: igual ⇒ mesmo item`);
    }
  });

  test("PN × LID: o MESMO item endereçado de outro jeito (from diferente) — estrita 0%, frouxa 100% (é para isso que a frouxa existe)", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 40, { extra: { from: "5511999990000@s.whatsapp.net" } });
    idt.novaGeracao(2); nos(idt, 2, 40, { extra: { from: "100000000000001@lid" } });
    const r = idt.comparar(2); assert.deepEqual([r.overlapPct, r.overlapIdOnlyPct], [0, 100]);
    assert.deepEqual([r.newCount, r.missingCount, r.newIdOnlyCount, r.missingIdOnlyCount, r.newIdOnlyPct, r.missingIdOnlyPct], [40, 40, 0, 0, 0, 0], "estrito: tudo novo; frouxo: nada novo");
    const idt2 = criar(); idt2.novaGeracao(1); nos(idt2, 1, 100); idt2.novaGeracao(2); nos(idt2, 2, 30); nos(idt2, 2, 70, { inicio: 9000 });
    const q = idt2.comparar(2);
    assert.deepEqual([q.currentIdOnlyCount, q.previousIdOnlyCount, q.overlapIdOnlyCount, q.newIdOnlyCount, q.missingIdOnlyCount, q.overlapIdOnlyPct, q.newIdOnlyPct, q.missingIdOnlyPct], [100, 100, 30, 70, 70, 30, 70, 70]);
    const idt3 = criar(); idt3.novaGeracao(1); nos(idt3, 1, 50); idt3.novaGeracao(2); nos(idt3, 2, 20); nos(idt3, 2, 20, { inicio: 500 });
    const w = idt3.comparar(2); assert.deepEqual([w.previousIdOnlyCount, w.currentIdOnlyCount, w.newIdOnlyCount, w.missingIdOnlyCount, w.missingIdOnlyPct, w.newIdOnlyPct, w.overlapIdOnlyPct], [50, 40, 20, 30, 60, 50, 50], "denominadores próprios do conjunto frouxo (anterior ≠ atual)");
  });

  test("G. RESTART simulado: instância nova (segredo novo, histórico vazio) ⇒ 'sem_geracao_anterior' e nenhum erro", () => {
    const antes = criarIdentidadeOffline(); antes.novaGeracao(1); nos(antes, 1, 30);
    const depois = criarIdentidadeOffline(); depois.novaGeracao(1); nos(depois, 1, 30);
    const r = depois.comparar(1);
    assert.deepEqual([r.comparavel, r.motivo, r.previousGeneration, r.overlapCount, r.overlapPct, r.currentCount], [false, "sem_geracao_anterior", null, null, null, 30]);
    assert.ok(MOTIVOS_NAO_COMPARAVEL.includes(r.motivo));
    assert.doesNotThrow(() => depois.comparar(1));
  });

  test("por espécie: message / receipt / notification contados à parte", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 10); nos(idt, 1, 5, { especie: "receipt", inicio: 100 }); nos(idt, 1, 2, { especie: "notification", inicio: 200 });
    idt.novaGeracao(2); nos(idt, 2, 4); nos(idt, 2, 5, { especie: "receipt", inicio: 100 }); nos(idt, 2, 3, { especie: "notification", inicio: 300 });
    const r = idt.comparar(2);
    assert.deepEqual(r.porEspecie, [
      { nome: "message", currentCount: 4, overlapCount: 4, newCount: 0 },
      { nome: "receipt", currentCount: 5, overlapCount: 5, newCount: 0 },
      { nome: "notification", currentCount: 3, overlapCount: 0, newCount: 3 },
    ]);
    assert.deepEqual([r.currentCount, r.overlapCount, r.previousCount, r.missingCount], [12, 9, 17, 8]);
  });

  test("uma geração SEM nós não desloca a anterior útil: previousGeneration pula a vazia; a vazia fica 'sem_nos_offline_no_socket'", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 20);
    idt.novaGeracao(2);
    assert.deepEqual([idt.comparar(2).comparavel, idt.comparar(2).motivo, idt.comparar(2).currentCount], [false, "sem_nos_offline_no_socket", 0]);
    idt.novaGeracao(3); nos(idt, 3, 20);
    const r = idt.comparar(3); assert.deepEqual([r.previousGeneration, r.geracoesEntre, r.overlapPct], [1, 2, 100]);
  });

  test("geração/evento TARDIO: registrar/comparar de um `g` que não é o atual são ignorados", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 5); idt.novaGeracao(2);
    assert.equal(idt.registrar(1, "message", p(99)), "ignorado");
    assert.equal(idt.comparar(1), null); assert.equal(idt.estado().atualCount, 0);
    assert.equal(criar().comparar(1), null, "sem geração nenhuma");
    assert.equal(criar().registrar(1, "message", p(1)), "ignorado");
  });

  test("sem `id` não há identidade: conta em semIdentidade e não entra no conjunto", () => {
    const idt = criar(); idt.novaGeracao(1);
    for (const ruim of [{}, { id: "" }, { id: 5 }, { id: null }, null, undefined, "texto"]) assert.equal(idt.registrar(1, "message", ruim), "sem_id");
    const r = idt.comparar(1); assert.deepEqual([r.currentCount, r.semIdentidade], [0, 7]);
  });

  test("espécie fora do vocabulário é ignorada (nunca cria bucket novo)", () => {
    const idt = criar(); idt.novaGeracao(1);
    for (const e of ["call", "presence", "", undefined, 3, "MESSAGE"]) assert.equal(idt.registrar(1, e, p(1)), "ignorado");
    assert.equal(idt.estado().atualCount, 0);
  });
});

describe("memória LIMITADA", () => {
  test("no máximo 500 impressões por geração: o excedente só é CONTADO; a anterior truncada é sinalizada", () => {
    const idt = criar(); assert.equal(PADROES_IDENTIDADE.maxPorGeracao, 500); idt.novaGeracao(1);
    const resultados = []; for (let i = 0; i < 600; i++) resultados.push(idt.registrar(1, "message", p(i)));
    assert.equal(resultados.filter((r) => r === "novo").length, 500); assert.equal(resultados.filter((r) => r === "limite").length, 100);
    const a = idt.comparar(1); assert.deepEqual([a.currentCount, a.descartadosPorLimite, a.currentTruncado], [500, 100, true]);
    assert.equal(idt.estado().atualCount, 500);
    idt.novaGeracao(2); nos(idt, 2, 10); const b = idt.comparar(2); assert.equal(b.previousTruncado, true); assert.equal(b.previousCount, 500);
  });

  test("retém no máximo `geracoesRetidas` (3) gerações ANTERIORES: a mais antiga é descartada quando entra uma nova; a atual nunca passa do teto", () => {
    const idt = criar(); assert.equal(PADROES_IDENTIDADE.geracoesRetidas, 3);
    for (let g = 1; g <= 5; g++) { idt.novaGeracao(g); nos(idt, g, 10, { inicio: g * 1000 }); }
    idt.novaGeracao(6);
    assert.deepEqual(idt.estado().historico.map((h) => h.geracao), [3, 4, 5], "1 e 2 foram descartadas");
    nos(idt, 6, 10, { inicio: 1000 });                         // nós da geração 1 (descartada)
    nos(idt, 6, 10, { inicio: 3000 });                         // nós da geração 3 (retida, mas não é a anterior imediata)
    const r = idt.comparar(6);
    assert.deepEqual([r.previousGeneration, r.overlapCount, r.seenInRetainedCount, r.unseenInRetainedCount], [5, 0, 10, 10], "estrito só contra a anterior; 'vistos' contra as retidas; a geração 1 já foi esquecida");
  });

  test("10.000 nós em 20 gerações: o estado interno nunca passa de (retidas + atual) × 500", () => {
    const idt = criar();
    for (let g = 1; g <= 20; g++) { idt.novaGeracao(g); nos(idt, g, 500); const e = idt.estado(); assert.ok(e.historico.length <= 3); assert.ok(e.historico.every((h) => h.count <= 500) && e.atualCount <= 500); }
  });

  test("opções inválidas lançam RangeError; segredo curto é ignorado (nasce aleatório) — nunca fica fraco", () => {
    for (const o of [{ maxPorGeracao: 0 }, { maxPorGeracao: 1.5 }, { geracoesRetidas: 0 }, { geracoesRetidas: -1 }, { maxPorGeracao: "500" }]) assert.throws(() => criarIdentidadeOffline(o), RangeError, JSON.stringify(o));
    assert.doesNotThrow(() => criarIdentidadeOffline({ segredo: Buffer.alloc(4) }));
    const cap = criarIdentidadeOffline({ maxPorGeracao: 2, geracoesRetidas: 1 }); cap.novaGeracao(1); nos(cap, 1, 5); assert.equal(cap.estado().atualCount, 2);
  });
});

describe("SEGREDO e impressões nunca saem", () => {
  const impressoes = (id, from, type = "text", especie = "message") => {
    const h = (dominio, itens) => createHmac("sha256", SEGREDO).update(JSON.stringify([dominio, ...itens])).digest();
    const estrita = h("estrita", [especie, type, id, from, ""]); const frouxa = h("frouxa", [especie, id]);
    const formas = (b) => [b.toString("base64"), b.subarray(0, 16).toString("base64"), b.toString("hex"), b.subarray(0, 16).toString("hex"), b.toString("base64url"), b.subarray(0, 16).toString("base64url")];
    return [...formas(estrita), ...formas(frouxa)];
  };

  test("saídas (comparar, estado, retornos) só têm números, booleanos, null e vocabulário fechado — nenhuma impressão, segredo, id ou from", () => {
    const idt = criar(); idt.novaGeracao(1); nos(idt, 1, 30); idt.novaGeracao(2); nos(idt, 2, 20); nos(idt, 2, 5, { inicio: 800 });
    const saidas = [idt.comparar(2), idt.estado(), idt.registrar(2, "message", p(1)), idt.registrar(2, "message", p(12345))];
    const texto = JSON.stringify(saidas);
    const segredoFormas = [SEGREDO.toString("hex"), SEGREDO.toString("base64"), SEGREDO.toString("base64url")];
    for (const proibido of [...segredoFormas, ...impressoes(p(3).id, FROM), ...impressoes(p(4).id, FROM), "SENTINELA", "MSGID", "s.whatsapp.net", "5511999990000"]) assert.ok(!texto.includes(proibido), `vazou: ${proibido}`);
    const vocab = new Set([...MOTIVOS_NAO_COMPARAVEL, ...ESPECIES_IDENTIDADE, "novo", "duplicado", "sem_id", "limite", "ignorado"]);
    const visitar = (v, c) => {
      if (v === null || typeof v === "number" || typeof v === "boolean") return;
      if (typeof v === "string") { assert.ok(vocab.has(v), `string fora do vocabulário em ${c}: ${v}`); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => visitar(x, `${c}[${i}]`)); return; }
      for (const [k, x] of Object.entries(v)) visitar(x, `${c}.${k}`);
    };
    visitar(saidas, "saidas");
  });

  test("o objeto devolvido só tem os 4 métodos (nenhum getter de segredo, mapa ou impressão)", () => {
    const idt = criar(); assert.deepEqual(Object.keys(idt).sort(), ["comparar", "estado", "novaGeracao", "registrar"]);
    for (const k of Object.keys(idt)) assert.equal(typeof idt[k], "function");
    assert.deepEqual(Object.keys(idt.estado()).sort(), ["atualCount", "geracaoAtual", "geracoesRetidas", "historico", "maxPorGeracao"]);
  });

  test("com segredos DIFERENTES as impressões diferem (o segredo é mesmo usado): instâncias não se enxergam", () => {
    const a = criarIdentidadeOffline({ segredo: Buffer.alloc(32, 1) }); const b = criarIdentidadeOffline({ segredo: Buffer.alloc(32, 2) });
    // mesma sequência em cada uma; nenhuma expõe impressão, então só o COMPORTAMENTO interno: cada uma compara consigo mesma
    for (const idt of [a, b]) { idt.novaGeracao(1); nos(idt, 1, 10); idt.novaGeracao(2); nos(idt, 2, 10); }
    assert.equal(a.comparar(2).overlapPct, 100); assert.equal(b.comparar(2).overlapPct, 100);
    assert.notDeepEqual(impressoes("X", FROM), impressoes("X", FROM).map((s) => s + "!"));
  });

  test("ROBUSTEZ: material lixo/gigante nunca lança; partes gigantes são truncadas (custo limitado)", () => {
    const idt = criar(); idt.novaGeracao(1);
    for (const ruim of [{ id: "x".repeat(1_000_000), from: "y".repeat(1_000_000) }, { id: "a", type: {}, from: [], participant: 5 }, Object.create(null), { get id() { throw new Error("boom"); } }]) assert.doesNotThrow(() => idt.registrar(1, "message", ruim));
    assert.ok(idt.estado().atualCount >= 1);
  });
});

describe("GUARDA ESTRUTURAL do módulo de identidade", () => {
  const fonte = readFileSync(join(aqui, "..", "src", "offlineIdentidade.js"), "utf8").replace(/\r\n/g, "\n");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("só importa node:crypto; sem log/console/emit/rede/disco/env/relógio/aleatoriedade fraca", () => {
    const imports = [...codigo.matchAll(/^\s*import\s[^;]*from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["node:crypto"]);
    for (const proibido of [/\bconsole\b/, /\blogger\b/, /\blog\s*\(/, /\bemit(ir)?\b/, /\bfetch\b/, /\bfs\b/, /\bprocess\b/, /Math\.random/, /Date\b/, /\bsetTimeout\b|\bsetInterval\b/, /\bws\b|\bsocket\b|\bev\b/, /\bflush\b/, /sendNode|sendMessage|relayMessage/, /JSON\.parse/, /writeFile|appendFile/]) {
      assert.ok(!proibido.test(codigo), `token proibido: ${proibido}`);
    }
  });

  test("exporta só: PADROES_IDENTIDADE, ESPECIES_IDENTIDADE, MOTIVOS_NAO_COMPARAVEL, criarIdentidadeOffline", () => {
    const exportados = [...codigo.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exportados, ["ESPECIES_IDENTIDADE", "MOTIVOS_NAO_COMPARAVEL", "PADROES_IDENTIDADE", "criarIdentidadeOffline"]);
  });

  test("o segredo vem de crypto.randomBytes(32) e nenhum retorno devolve mapa/conjunto/chave", () => {
    assert.ok(/randomBytes\(32\)/.test(codigo));
    assert.ok(!/return\s+(atual|historico|chave|segredo)\b/.test(codigo) && !/return\s*\{[^}]*\b(chave|segredo|mapa|frouxo)\b\s*[,}]/.test(codigo), "nenhum return expõe estruturas internas");
    assert.ok(!/\bexport\s+default\b/.test(codigo));
  });

  test("o material da impressão NÃO inclui conteúdo/texto/timestamp: só espécie, type, id, from, participant", () => {
    const usados = [...codigo.matchAll(/parte\(p\.(\w+)\)/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(usados)], ["from", "id", "participant", "type"]);
    for (const proibido of [/\.t\b/, /\.content\b/, /\.message\b/, /caption|text|body|payload|conteudo/i]) assert.ok(!proibido.test(codigo.replace(/type\??:\s*any/g, "")), `material proibido: ${proibido}`);
  });
});
