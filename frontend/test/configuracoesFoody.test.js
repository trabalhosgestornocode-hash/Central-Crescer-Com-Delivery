// Foody Delivery (Configurações → Integrações): regras puras da tela + contratos de segurança do módulo.
// Rodar: node --test frontend/test/configuracoesFoody.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acoesDaConexao, conexoesDaTriagem, opcoesDeDestino, validarToken, validarMotivo, mensagemDeErro, rotuloEvento, rotuloAtor, dataCurta,
} from "../src/configuracoesFoodyModelo.js";

const base = (o = {}) => ({ podeAdministrar: true, impersonando: false, unidade: { nome: "Loja" }, conexao: null, compartilhamentos: [], ...o });
const vinc = (o) => ({ id: "v1", conexaoId: "c9", papel: "titular", estado: "ATIVO", titular: { organizacao: "Org T", unidade: "Loja T" }, destino: { organizacao: "Org D", unidade: "Loja D" }, ...o });

describe("ações da conexão", () => {
  test("sem conexão: só cadastrar; como destino vivo, nem isso (com o motivo na tela)", () => {
    assert.equal(acoesDaConexao(base()).cadastrar, true);
    const d = acoesDaConexao(base({ compartilhamentos: [vinc({ papel: "destino", estado: "PENDENTE" })] }));
    assert.equal(d.cadastrar, false); assert.match(d.bloqueioCadastro, /Revogue o compartilhamento/);
  });
  test("pausada → ativar; ativa → pausar; revogada → reconectar; token não troca com vínculo vivo", () => {
    assert.deepEqual([acoesDaConexao(base({ conexao: { status: "PAUSADA" } })).ativar, acoesDaConexao(base({ conexao: { status: "PAUSADA" } })).pausar], [true, false]);
    assert.deepEqual([acoesDaConexao(base({ conexao: { status: "ATIVA" } })).ativar, acoesDaConexao(base({ conexao: { status: "ATIVA" } })).pausar], [false, true]);
    assert.equal(acoesDaConexao(base({ conexao: { status: "REVOGADA" } })).cadastrar, true);
    const v = acoesDaConexao(base({ conexao: { status: "ATIVA" }, compartilhamentos: [vinc({})] }));
    assert.equal(v.substituir, false); assert.match(v.substituirBloqueado, /Revogue o compartilhamento/);
  });
  test("sem poder (gestor, impersonação, sem unidade): nenhuma ação", () => {
    for (const s of [base({ podeAdministrar: false }), base({ impersonando: true }), base({ unidade: null })]) {
      const a = acoesDaConexao({ ...s, conexao: { status: "ATIVA" } });
      assert.ok(!Object.entries(a).some(([k, v]) => k !== "bloqueioCadastro" && v === true), JSON.stringify(a));
    }
  });
});

describe("triagem e destinos", () => {
  test("triagem: a própria conexão viva e as compartilhadas ATIVAS com este contexto", () => {
    const s = base({ conexao: { id: "c1", status: "ATIVA" }, compartilhamentos: [vinc({ papel: "destino", conexaoId: "c2" }), vinc({ papel: "destino", conexaoId: "c3", estado: "PENDENTE" })] });
    assert.deepEqual(conexoesDaTriagem(s).map((c) => c.conexaoId), ["c1", "c2"]);
    assert.deepEqual(conexoesDaTriagem(base({ conexao: { id: "c1", status: "REVOGADA" } })), []);
  });
  test("destinos possíveis viram uma opção por unidade", () => {
    assert.deepEqual(opcoesDeDestino([{ organizacaoId: "o", nome: "Açaí", unidades: [{ id: "u1", nome: "A" }, { id: "u2", nome: "B" }] }]).map((o) => o.valor), ["o|u1", "o|u2"]);
  });
});

describe("validações e textos", () => {
  test("token: mesma regra do servidor", () => {
    assert.match(validarToken(""), /Cole/); assert.ok(validarToken("curto")); assert.ok(validarToken("tem espaco no meio 123"));
    assert.equal(validarToken("tok_TESTE_nao_real_0123456789"), null);
  });
  test("motivo: 3 a 300, opcional quando pedido", () => {
    assert.ok(validarMotivo("x")); assert.equal(validarMotivo("", { obrigatorio: false }), null); assert.equal(validarMotivo("ok!"), null); assert.ok(validarMotivo("a".repeat(301)));
  });
  test("erros: mensagem por código; 429 vira 'aguarde'; desconhecido usa a mensagem do servidor", () => {
    assert.match(mensagemDeErro({ codigo: "CONTA_JA_CONECTADA" }), /outra unidade/);
    assert.match(mensagemDeErro({ status: 429 }), /Aguarde/);
    assert.equal(mensagemDeErro({ message: "x" }), "x");
  });
  test("auditoria: rótulos por tipo de evento; autoria só como você/outro/automático", () => {
    assert.equal(rotuloEvento({ tipo: "conexao", evento: "PAUSADA_POR_TRANSFERENCIA" }), "Pausada: a unidade mudou de empresa");
    assert.equal(rotuloEvento({ tipo: "compartilhamento", evento: "APROVADO_DESTINO" }), "Aprovado pela empresa destino");
    assert.equal(rotuloAtor("outro", "Org D"), "Outro administrador · Org D");
    assert.equal(rotuloAtor("automatico", "Org D"), "Automático (sistema)");
    assert.equal(dataCurta("2026-11-04"), "04/11/2026");
  });
});

describe("contratos do módulo (código-fonte)", () => {
  const fonte = readFileSync(new URL("../src/configuracoesFoody.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
  test("o token vai em campo de senha, sem autocompletar, e é apagado do campo antes do envio", () => {
    assert.match(fonte, /name="token" type="password" autocomplete="off" spellcheck="false"/);
    assert.match(fonte, /campo\.value = "";\s+\/\/ nunca fica no DOM/);
  });
  test("o token só sai no corpo de POST; nenhuma URL da Foody leva token", () => {
    const foody = api.slice(api.indexOf("Foody Delivery: administração"));
    for (const linha of foody.split("\n").filter((l) => /`\$\{FOODY\}[^`]*`/.test(l))) assert.doesNotMatch(linha.match(/`\$\{FOODY\}[^`]*`/)[0], /\$\{\s*token/i, linha);
    assert.match(foody, /postJson\(`\$\{FOODY\}\/conexao`, \{ token, pontoColetaEsperado \}\)/);
  });
  test("sem armazenamento local, sem innerHTML de dado cru (tudo passa por escapeHtml)", () => {
    assert.doesNotMatch(fonte, /localStorage|sessionStorage|indexedDB/);
    for (const [, expr] of fonte.matchAll(/\$\{(v|p|d|x|c|o)\.([a-zA-Z.]+)\}/g)) assert.fail(`interpolação sem escape: ${expr}`);
  });
  test("404/403 escondem a seção (administração desligada não aparece)", () => {
    assert.match(fonte, /err\?\.status === 404 \|\| err\?\.status === 403/);
    assert.match(fonte, /s\.hidden = true/);
  });
});
