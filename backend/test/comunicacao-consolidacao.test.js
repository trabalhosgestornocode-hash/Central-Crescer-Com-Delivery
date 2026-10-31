// PROTÓTIPO de consolidação por telefone (alternativa do RATE_LIMIT do D-1) — função pura, nada ligado ao envio.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consolidarPorTelefone, chaveDeConsolidacao } from "../src/modules/comunicacao/comunicacao.consolidacao.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const item = (n, over = {}) => ({ id: `m${n}`, contatoWhatsappId: "CW-X", organizacaoId: `org-${n}`, empresa: `Empresa ${n}`, unidade: `Unidade ${n}`, conteudo: `Pendências da unidade ${n}: 2 itens.`, autorizado: true, ...over });
const sete = () => [1, 2, 3, 4, 5, 6, 7].map((n) => item(n));

describe("consolidar por telefone", () => {
  test("o caso real: 7 registros do MESMO telefone viram 1 mensagem (não 7), cada bloco atribuído à própria empresa/unidade", () => {
    const { mensagens, excluidos } = consolidarPorTelefone(sete());
    assert.equal(excluidos.length, 0);
    assert.equal(mensagens.length, 1);
    assert.equal(mensagens[0].blocos, 7);
    for (let n = 1; n <= 7; n++) assert.ok(mensagens[0].texto.includes(`*Empresa ${n} — Unidade ${n}*\nPendências da unidade ${n}: 2 itens.`), `bloco ${n} atribuído`);
  });
  test("telefones diferentes NUNCA se misturam (cada um recebe só os próprios blocos)", () => {
    const itens = [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" }), item(4, { contatoWhatsappId: "CW-Y" })];
    const { mensagens } = consolidarPorTelefone(itens);
    const por = Object.fromEntries(mensagens.map((m) => [m.contatoWhatsappId, m]));
    assert.deepEqual(por["CW-X"].ids.sort(), ["m1", "m2"]);
    assert.deepEqual(por["CW-Y"].ids.sort(), ["m3", "m4"]);
    assert.ok(!por["CW-X"].texto.includes("unidade 3") && !por["CW-Y"].texto.includes("unidade 1"));
  });
  test("AUTORIZAÇÃO: bloco não autorizado (revogado, categoria/unidade fora do escopo) nunca entra; vem listado como excluído", () => {
    const itens = [item(1), item(2, { autorizado: false }), item(3, { autorizado: undefined }), item(4)];
    const { mensagens, excluidos } = consolidarPorTelefone(itens);
    assert.deepEqual(mensagens[0].ids.sort(), ["m1", "m4"]);
    assert.deepEqual(excluidos.map((e) => [e.id, e.motivo]).sort(), [["m2", "NAO_AUTORIZADO"], ["m3", "NAO_AUTORIZADO"]]);
    assert.ok(!mensagens[0].texto.includes("unidade 2") && !mensagens[0].texto.includes("unidade 3"));
  });
  test("itens inválidos (sem id/telefone/empresa/conteúdo) são excluídos, sem derrubar o lote", () => {
    const { mensagens, excluidos } = consolidarPorTelefone([item(1), item(2, { conteudo: "  " }), { id: "x" }, null, item(3, { organizacaoId: "" })]);
    assert.deepEqual(mensagens[0].ids, ["m1"]);
    assert.equal(excluidos.length, 4);
  });
  test("1 bloco só: a mensagem ORIGINAL, intacta (comportamento de hoje), com a própria chave", () => {
    const { mensagens } = consolidarPorTelefone([item(1)]);
    assert.deepEqual([mensagens[0].texto, mensagens[0].chave, mensagens[0].blocos], ["Pendências da unidade 1: 2 itens.", "m1", 1]);
  });
  test("DETERMINÍSTICO e IDEMPOTENTE: a ordem de entrada não muda o texto nem a chave; reprocessar dá o mesmo resultado", () => {
    const a = consolidarPorTelefone(sete()); const b = consolidarPorTelefone(sete().reverse()); const c = consolidarPorTelefone(sete());
    assert.deepEqual(a, b); assert.deepEqual(a, c);
    assert.equal(a.mensagens[0].chave, chaveDeConsolidacao(sete().map((i) => i.id)));
    assert.notEqual(chaveDeConsolidacao(["m1", "m2"]), chaveDeConsolidacao(["m1", "m2", "m3"]));
  });
  test("LIMITE de tamanho: divide em várias mensagens SEM cortar bloco; bloco gigante vai sozinho, inteiro", () => {
    const grandes = sete().map((i, n) => ({ ...i, conteudo: "x".repeat(300) + n }));
    const { mensagens } = consolidarPorTelefone(grandes, { maxCaracteres: 700 });
    assert.ok(mensagens.length > 1 && mensagens.length < 7);
    assert.equal(mensagens.reduce((s, m) => s + m.blocos, 0), 7);
    for (const m of mensagens) for (const id of m.ids) { const n = Number(id.slice(1)) - 1; assert.ok(m.texto.includes("x".repeat(300) + n), "bloco inteiro"); }
    const gigante = consolidarPorTelefone([item(1, { conteudo: "y".repeat(5000) }), item(2)], { maxCaracteres: 700 }).mensagens;
    assert.equal(gigante.length, 2);
    assert.ok(gigante.some((m) => m.texto.includes("y".repeat(5000))));
  });
  test("o protótipo não toca em banco, provider, fila nem política", () => {
    const s = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.consolidacao.js"), "utf8");
    assert.doesNotMatch(s, /^import .*(supabase|provider|fila|policy|worker|whatsapp)/im);
    assert.doesNotMatch(s, /\.(from|rpc|sendText|enviarTexto)\(/);
  });
});
