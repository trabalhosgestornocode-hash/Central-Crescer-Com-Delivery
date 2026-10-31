// PROPOSTA de consolidação do D-1 por telefone — função pura; nada ligado ao agendador, à fila, à política, às cotas nem ao envio.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consolidarPorTelefone, motivoDeExclusao, chaveDeConsolidacao, LIMITE_PADRAO, LIMITE_PROVEDOR } from "../src/modules/comunicacao/comunicacao.consolidacao.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOM = { registroAtivo: true, revogado: false, categoriaHabilitada: true, optOutContato: false, empresaHabilitada: true, empresaPausadaAte: null, escopoUnidades: null };
const item = (n, over = {}) => ({ id: `m${n}`, contatoWhatsappId: "CW-X", organizacaoId: `org-${n}`, empresa: `Empresa ${n}`, unidade: `Unidade ${n}`, unidadeId: `un-${n}`,
  conteudo: `Pendências da unidade ${n}: 2 itens.`, estado: { ...BOM }, ...over });
const sete = () => [1, 2, 3, 4, 5, 6, 7].map((n) => item(n));

describe("o caso real: um responsável, 7 lojas", () => {
  test("7 registros do MESMO telefone viram 1 mensagem; cada bloco atribuído à própria empresa/unidade; detalhes rastreáveis", () => {
    const { mensagens, excluidos } = consolidarPorTelefone(sete());
    assert.equal(excluidos.length, 0);
    assert.equal(mensagens.length, 1);
    assert.equal(mensagens[0].blocos, 7);
    for (let n = 1; n <= 7; n++) assert.ok(mensagens[0].texto.includes(`*Empresa ${n} — Unidade ${n}*\nPendências da unidade ${n}: 2 itens.`), `bloco ${n}`);
    assert.deepEqual(mensagens[0].detalhes.map((d) => d.organizacaoId).sort(), [1, 2, 3, 4, 5, 6, 7].map((n) => `org-${n}`));
  });
  test("tamanho real do D-1 (máx. 357 caracteres por relatório): 7 relatórios cabem em UMA mensagem abaixo do limite do provedor", () => {
    const grandes = sete().map((i) => ({ ...i, conteudo: "r".repeat(357) }));
    const { mensagens } = consolidarPorTelefone(grandes);
    assert.equal(mensagens.length, 1);
    assert.ok(mensagens[0].texto.length <= LIMITE_PADRAO && LIMITE_PADRAO < LIMITE_PROVEDOR, String(mensagens[0].texto.length));
  });
});

describe("conteúdo completo", () => {
  test("o texto de cada relatório entra byte a byte (espaços, quebras, emojis, asteriscos) — nada de trim, resumo ou corte", () => {
    const conteudos = ["  Resumo ✅\n- 3 pedidos *atrasados*\n- 1 loja fechada  ", "Linha única", "Tab\there\r\ncrlf"];
    const itens = conteudos.map((c, i) => item(i + 1, { conteudo: c }));
    const { mensagens } = consolidarPorTelefone(itens);
    assert.equal(mensagens.length, 1);
    for (const c of conteudos) assert.ok(mensagens[0].texto.includes(c), JSON.stringify(c));
  });
  test("1 bloco só: a mensagem ORIGINAL, intacta, com a própria chave (igual ao comportamento de hoje)", () => {
    const { mensagens } = consolidarPorTelefone([item(1)]);
    assert.deepEqual([mensagens[0].texto, mensagens[0].chave, mensagens[0].blocos], ["Pendências da unidade 1: 2 itens.", "m1", 1]);
  });
});

describe("autorização INDEPENDENTE por empresa e unidade (regras do registro)", () => {
  const motivo = (patch, extra) => motivoDeExclusao({ ...BOM, ...patch }, { unidadeId: "un-1", ...extra }, new Date("2026-11-01T12:00:00Z"));
  test("cada regra exclui com motivo fixo; sem exclusão devolve null", () => {
    assert.equal(motivo({}), null);
    assert.equal(motivo({ registroAtivo: false }), "REGISTRO_INATIVO");
    assert.equal(motivo({ revogado: true }), "REVOGADO");
    assert.equal(motivo({ optOutContato: true }), "OPT_OUT");
    assert.equal(motivo({ categoriaHabilitada: false }), "CATEGORIA_DESABILITADA");
    assert.equal(motivo({ empresaHabilitada: false }), "EMPRESA_NAO_HABILITADA");
    assert.equal(motivo({ empresaPausadaAte: "2026-11-02T00:00:00Z" }), "EMPRESA_PAUSADA");
    assert.equal(motivo({ empresaPausadaAte: "2026-10-31T00:00:00Z" }), null, "pausa já vencida não exclui");
    assert.equal(motivo({ escopoUnidades: ["un-2"] }), "UNIDADE_FORA_DO_ESCOPO");
    assert.equal(motivo({ escopoUnidades: ["un-1", "un-2"] }), null);
  });
  test("FAIL-CLOSED: campo ausente/indeterminado nunca autoriza", () => {
    assert.equal(motivoDeExclusao({}, {}), "REGISTRO_INATIVO");
    assert.equal(motivoDeExclusao(null, {}), "REGISTRO_INATIVO");
    assert.equal(motivoDeExclusao({ registroAtivo: true }, {}), "OPT_OUT");
    assert.equal(motivoDeExclusao({ registroAtivo: true, optOutContato: false }, {}), "CATEGORIA_DESABILITADA");
    const { mensagens, excluidos } = consolidarPorTelefone([item(1, { estado: undefined }), item(2, { estado: undefined, autorizado: undefined })]);
    assert.equal(mensagens.length, 0);
    assert.deepEqual(excluidos.map((e) => e.motivo), ["NAO_AUTORIZADO", "NAO_AUTORIZADO"]);
  });
  test("bloco não autorizado NUNCA entra e NÃO derruba os demais; o conteúdo dele não aparece em lugar nenhum", () => {
    const itens = [item(1), item(2, { estado: { ...BOM, empresaHabilitada: false }, conteudo: "SEGREDO-DA-EMPRESA-2" }), item(3, { estado: { ...BOM, empresaPausadaAte: "2999-01-01T00:00:00Z" }, conteudo: "SEGREDO-DA-EMPRESA-3" }), item(4)];
    const { mensagens, excluidos } = consolidarPorTelefone(itens, { agora: new Date("2026-11-01T12:00:00Z") });
    assert.deepEqual(mensagens[0].ids, ["m1", "m4"]);
    assert.deepEqual(excluidos.map((e) => [e.id, e.motivo]).sort(), [["m2", "EMPRESA_NAO_HABILITADA"], ["m3", "EMPRESA_PAUSADA"]]);
    assert.ok(!JSON.stringify(mensagens).includes("SEGREDO"));
  });
  test("`autorizado` explícito (calculado fora) também vale; booleano manda sobre `estado`", () => {
    const { mensagens, excluidos } = consolidarPorTelefone([item(1, { autorizado: true, estado: undefined }), item(2, { autorizado: false })]);
    assert.deepEqual([mensagens[0].ids, excluidos[0].motivo], [["m1"], "NAO_AUTORIZADO"]);
  });
});

describe("revogação por destinatário e isolamento", () => {
  test("revogar UM registro tira só o bloco dele; o conjunto muda ⇒ outra mensagem (outra chave)", () => {
    const inteiro = consolidarPorTelefone(sete());
    const itens = sete(); itens[2] = item(3, { estado: { ...BOM, revogado: true } });
    const sem3 = consolidarPorTelefone(itens);
    assert.equal(sem3.mensagens[0].blocos, 6);
    assert.ok(!sem3.mensagens[0].ids.includes("m3") && sem3.excluidos[0].motivo === "REVOGADO");
    assert.notEqual(sem3.mensagens[0].chave, inteiro.mensagens[0].chave);
  });
  test("opt-out do contato (SAIR) tira TODOS os blocos daquele telefone e não toca em outro telefone", () => {
    const itens = [...sete().map((i) => ({ ...i, estado: { ...BOM, optOutContato: true } })), item(8, { contatoWhatsappId: "CW-Y" })];
    const { mensagens, excluidos } = consolidarPorTelefone(itens);
    assert.deepEqual(mensagens.map((m) => m.contatoWhatsappId), ["CW-Y"]);
    assert.equal(excluidos.filter((e) => e.motivo === "OPT_OUT").length, 7);
  });
  test("ISOLAMENTO: telefones diferentes nunca se misturam; um bloco só aparece na mensagem do SEU telefone", () => {
    const itens = [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" }), item(4, { contatoWhatsappId: "CW-Y" })];
    const por = Object.fromEntries(consolidarPorTelefone(itens).mensagens.map((m) => [m.contatoWhatsappId, m]));
    assert.deepEqual(por["CW-X"].ids.sort(), ["m1", "m2"]);
    assert.deepEqual(por["CW-Y"].ids.sort(), ["m3", "m4"]);
    assert.ok(!por["CW-X"].texto.includes("Empresa 3") && !por["CW-Y"].texto.includes("Empresa 1"));
  });
  test("a mesma empresa com duas unidades no mesmo telefone mantém os dois blocos separados e atribuídos", () => {
    const itens = [item(1, { organizacaoId: "org-A", empresa: "Rede A", unidade: "Centro" }), item(2, { organizacaoId: "org-A", empresa: "Rede A", unidade: "Norte", unidadeId: "un-N" })];
    const t = consolidarPorTelefone(itens).mensagens[0].texto;
    assert.ok(t.includes("*Rede A — Centro*") && t.includes("*Rede A — Norte*"));
  });
});

describe("limites de tamanho, determinismo e idempotência", () => {
  test("nenhuma mensagem passa do limite; divide SEM cortar bloco; o teto nunca excede o limite do provedor", () => {
    const grandes = sete().map((i, n) => ({ ...i, conteudo: "x".repeat(300) + n }));
    const { mensagens } = consolidarPorTelefone(grandes, { maxCaracteres: 700 });
    assert.ok(mensagens.length > 1 && mensagens.every((m) => m.texto.length <= 700));
    assert.equal(mensagens.reduce((s, m) => s + m.blocos, 0), 7);
    for (const m of mensagens) for (const id of m.ids) assert.ok(m.texto.includes("x".repeat(300) + (Number(id.slice(1)) - 1)));
    const enorme = consolidarPorTelefone(sete().map((i) => ({ ...i, conteudo: "z".repeat(2000) })), { maxCaracteres: 99999 });
    assert.ok(enorme.mensagens.every((m) => m.texto.length <= LIMITE_PROVEDOR));
  });
  test("bloco que não cabe nem sozinho com título sai como a mensagem ORIGINAL inteira; acima do limite do provedor é excluído", () => {
    const { mensagens, excluidos } = consolidarPorTelefone([item(1, { conteudo: "y".repeat(900) }), item(2), item(3, { conteudo: "w".repeat(LIMITE_PROVEDOR + 1) })], { maxCaracteres: 700 });
    const original = mensagens.find((m) => m.ids.includes("m1"));
    assert.deepEqual([original.texto, original.blocos], ["y".repeat(900), 1]);
    assert.deepEqual(excluidos.map((e) => [e.id, e.motivo]), [["m3", "BLOCO_MAIOR_QUE_O_LIMITE_DO_PROVEDOR"]]);
  });
  test("DETERMINÍSTICO e IDEMPOTENTE: a ordem de entrada não muda texto nem chave; o mesmo conjunto = a mesma chave", () => {
    const a = consolidarPorTelefone(sete()); const b = consolidarPorTelefone(sete().reverse()); const c = consolidarPorTelefone(sete());
    assert.deepEqual(a, b); assert.deepEqual(a, c);
    assert.equal(a.mensagens[0].chave, chaveDeConsolidacao(sete().map((i) => i.id)));
    assert.notEqual(chaveDeConsolidacao(["m1", "m2"]), chaveDeConsolidacao(["m1", "m2", "m3"]));
  });
  test("itens inválidos são excluídos sem derrubar o lote", () => {
    const { mensagens, excluidos } = consolidarPorTelefone([item(1), item(2, { conteudo: "  " }), { id: "x" }, null, item(3, { organizacaoId: "" }), item(4, { empresa: "" })]);
    assert.deepEqual(mensagens[0].ids, ["m1"]);
    assert.equal(excluidos.length, 5);
  });
});

describe("pureza: não toca em banco, provider, fila, política, cotas nem relógio global", () => {
  test("sem imports de infraestrutura e sem chamadas de envio/banco", () => {
    const s = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.consolidacao.js"), "utf8");
    assert.doesNotMatch(s, /^import .*(supabase|provider|fila|policy|worker|whatsapp|config)/im);
    assert.doesNotMatch(s, /\.(from|rpc|sendText|enviarTexto|insert)\(|Date\.now\(\)/);
  });
  test("ninguém no código de produção usa o módulo (proposta NÃO ligada)", () => {
    const usos = ["comunicacao.alertas.service.js", "comunicacao.entrega.js", "comunicacao.fila.repo.js", "comunicacao.policy.js", "whatsapp.service.js"]
      .filter((f) => /comunicacao\.consolidacao/.test(readFileSync(path.join(RAIZ, "src/modules/comunicacao", f), "utf8")));
    assert.deepEqual(usos, []);
  });
});
