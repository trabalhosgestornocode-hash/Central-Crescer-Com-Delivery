// Telas de exibição — contrato de segurança (funções puras) e travas estáticas da migration 110.
// Rodar: node --test test/exibicao-seguranca.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  POLITICA, gerarTokenTela, hashSegredo, gerarSegredoPareamento, ALFABETO_CODIGO, TAMANHO_CODIGO, gerarCodigoPareamento,
  normalizarCodigo, hashCodigo, urlAprovacaoQr, opcoesCookie, lerCookieUnico, PATH_API_EXIBICAO, COOKIE_TELA,
  origemPermitida, prefixoRede, resumoNavegador, respostaDaResolucao, ACOES_AUDITORIA, detalhesAuditoria,
  PERMISSAO_GERENCIAR_TELAS,
} from "../src/modules/exibicao/exibicao.seguranca.js";

const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PEPPER = "p".repeat(48);

describe("token da tela e segredo do pedido", () => {
  test("256 bits em base64url; 20 mil gerados, todos diferentes", () => {
    const vistos = new Set();
    for (let i = 0; i < 20_000; i++) {
      const t = gerarTokenTela();
      assert.match(t, /^[A-Za-z0-9_-]{43}$/);
      vistos.add(t);
    }
    assert.equal(vistos.size, 20_000);
    assert.match(gerarSegredoPareamento(), /^[A-Za-z0-9_-]{43}$/);
  });
  test("o banco recebe só o hash (hex 64), determinístico e diferente do token", () => {
    const t = gerarTokenTela();
    const h = hashSegredo(t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(hashSegredo(t), h);
    assert.notEqual(h, t);
    assert.ok(!h.includes(t));
  });
  test("formato inválido não é 'hasheado' (nem texto livre, nem hash reenviado)", () => {
    for (const v of ["", "abc", "x".repeat(44), "a".repeat(64), null, 123]) assert.throws(() => hashSegredo(v));
  });
});

describe("código de pareamento", () => {
  test("8 símbolos de Crockford (40 bits), formato XXXX-XXXX, sem I/L/O/U", () => {
    assert.equal(ALFABETO_CODIGO.length, 32);
    assert.doesNotMatch(ALFABETO_CODIGO, /[ILOU]/);
    for (let i = 0; i < 2000; i++) {
      const c = gerarCodigoPareamento();
      assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    assert.equal(TAMANHO_CODIGO * Math.log2(ALFABETO_CODIGO.length), 40);
  });
  test("distribuição sem viés aparente (cada símbolo perto de 1/32)", () => {
    const n = 40_000;
    const cont = new Map();
    for (let i = 0; i < n / 8; i++) for (const c of gerarCodigoPareamento().replace("-", "")) cont.set(c, (cont.get(c) ?? 0) + 1);
    assert.equal(cont.size, 32);
    for (const [, k] of cont) assert.ok(Math.abs(k - n / 32) < (n / 32) * 0.15, `símbolo fora da faixa: ${k}`);
  });
  test("normalização tolera digitação (minúsculas, espaço, traço, O/I/L) e recusa o resto", () => {
    assert.equal(normalizarCodigo(" 7kq2-m9xd "), "7KQ2M9XD");
    assert.equal(normalizarCodigo("7KQ2 OILX"), "7KQ2011X");
    for (const v of ["7KQ2-M9X", "7KQ2-M9XDD", "7KQ2-M9XU", "", null, "🙂🙂🙂🙂🙂🙂🙂🙂"]) assert.equal(normalizarCodigo(v), null);
  });
  test("hash do código é HMAC com segredo do servidor: muda com o pepper; pepper curto é recusado", () => {
    const c = normalizarCodigo(gerarCodigoPareamento());
    const h1 = hashCodigo(c, PEPPER);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.notEqual(hashCodigo(c, "q".repeat(48)), h1);
    assert.throws(() => hashCodigo(c, "curto"));
    assert.throws(() => hashCodigo("7kq2-m9xd", PEPPER), /não normalizado/);
  });
  test("QR abre a aprovação NA CENTRAL com o código no fragmento (#): sem query, sem token, só https", () => {
    const url = urlAprovacaoQr("https://centralcrescercomdelivery.com.br/qualquer?x=1", "7KQ2-M9XD");
    assert.equal(url, "https://centralcrescercomdelivery.com.br/#aprovar-tela=7KQ2-M9XD");
    assert.equal(new URL(url).search, "");
    assert.throws(() => urlAprovacaoQr("http://centralcrescercomdelivery.com.br", "7KQ2-M9XD"), /https/);
  });
});

describe("cookies e CSRF", () => {
  test("produção: HttpOnly, Secure, SameSite=Strict, Path restrito, prefixo __Secure-, sem Domain", () => {
    const c = opcoesCookie({ producao: true, tipo: "tela", maxAgeS: POLITICA.telaValidadeDias * 86400 });
    assert.deepEqual(c, { nome: COOKIE_TELA, httpOnly: true, secure: true, sameSite: "strict", path: PATH_API_EXIBICAO, maxAge: 90 * 86400 * 1000 });
    assert.ok(!("domain" in c));
    const p = opcoesCookie({ producao: true, tipo: "pareamento", maxAgeS: 600 });
    assert.equal(p.path, "/api/v1/exibicao/pareamentos");
    assert.equal(p.nome, "__Secure-cko_par");
  });
  test("desenvolvimento local (http): sem Secure e sem prefixo; ainda HttpOnly e Strict", () => {
    const c = opcoesCookie({ producao: false, tipo: "tela", maxAgeS: 60 });
    assert.deepEqual([c.nome, c.secure, c.httpOnly, c.sameSite], ["cko_tela", false, true, "strict"]);
    assert.throws(() => opcoesCookie({ producao: true, tipo: "tela", maxAgeS: 0 }));
  });
  test("cookie duplicado (fixação) é recusado em vez de escolher um", () => {
    assert.deepEqual(lerCookieUnico("a=1; __Secure-cko_tela=AAA; b=2", COOKIE_TELA), { valor: "AAA", duplicado: false });
    assert.deepEqual(lerCookieUnico("__Secure-cko_tela=AAA; __Secure-cko_tela=BBB", COOKIE_TELA), { valor: null, duplicado: true });
    assert.deepEqual(lerCookieUnico("", COOKIE_TELA), { valor: null, duplicado: false });
  });
  test("operações que mudam estado exigem Origin da lista; GET não muda estado", () => {
    const permitidas = ["https://centralcrescercomdelivery.com.br"];
    assert.equal(origemPermitida("POST", "https://centralcrescercomdelivery.com.br", permitidas), true);
    assert.equal(origemPermitida("POST", "https://evil.example", permitidas), false);
    assert.equal(origemPermitida("POST", undefined, permitidas), false, "sem Origin: recusa");
    assert.equal(origemPermitida("DELETE", "null", permitidas), false);
    assert.equal(origemPermitida("GET", undefined, permitidas), true);
  });
});

describe("identificação mínima (sem PII)", () => {
  test("rede: IPv4 /24 e IPv6 /48; nunca o IP completo", () => {
    assert.equal(prefixoRede("200.10.20.77"), "200.10.20.0/24");
    assert.equal(prefixoRede("::ffff:200.10.20.77"), "200.10.20.0/24");
    assert.equal(prefixoRede("2804:14c:5b8a:1234::abcd"), "2804:14c:5b8a::/48");
    for (const v of ["999.1.1.1", "abc", null, ""]) assert.equal(prefixoRede(v), null);
  });
  test("navegador: só família e sistema (para reconhecer a TV na lista)", () => {
    assert.equal(resumoNavegador("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/4.0 Chrome/76.0 TV Safari/537.36"), "Samsung Internet / Tizen (TV)");
    assert.equal(resumoNavegador("Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"), "Chrome / Android TV");
    assert.equal(resumoNavegador("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1"), "Safari / iPad");
    assert.equal(resumoNavegador(undefined), null);
  });
});

describe("resolução -> HTTP (fail-closed)", () => {
  test("só ok/ok_token_anterior servem dados", () => {
    assert.equal(respostaDaResolucao("ok").servirDados, true);
    assert.equal(respostaDaResolucao("ok_token_anterior").servirDados, true);
    for (const r of ["nao_encontrado", "revogado", "expirado", "inativo", "token_substituido"]) {
      assert.deepEqual([respostaDaResolucao(r).status, respostaDaResolucao(r).servirDados], [401, false], r);
    }
    for (const r of ["unidade_indisponivel", "empresa_indisponivel", "modulo_indisponivel"]) {
      assert.deepEqual([respostaDaResolucao(r).status, respostaDaResolucao(r).codigo], [403, "EXIBICAO_SEM_ACESSO"], r);
    }
  });
  test("resultado desconhecido = 401 e apaga o cookie; banco fora = 503 sem dados e SEM apagar o cookie", () => {
    assert.deepEqual(respostaDaResolucao("algo_novo"), { status: 401, codigo: "EXIBICAO_ALGO_NOVO", servirDados: false, limparCookie: true });
    assert.deepEqual(respostaDaResolucao("ok", { erroBanco: true }), { status: 503, codigo: "EXIBICAO_INDISPONIVEL", servirDados: false, limparCookie: false });
  });
  test("token anterior reaparecido não apaga o cookie (a TV legítima pode estar com o novo)", () => {
    assert.equal(respostaDaResolucao("token_substituido").limparCookie, false);
    assert.equal(respostaDaResolucao("revogado").limparCookie, true);
  });
});

describe("permissão e auditoria", () => {
  test("permissão própria, separada de integracoes.ver", () => {
    assert.equal(PERMISSAO_GERENCIAR_TELAS, "checklist.telas.gerenciar");
    assert.notEqual(PERMISSAO_GERENCIAR_TELAS, "integracoes.ver");
  });
  test("detalhes de auditoria: só campos do contrato; nada de token, código, segredo, cookie ou IP", () => {
    const d = detalhesAuditoria(ACOES_AUDITORIA.PAREAMENTO_APROVADO, {
      dispositivoNome: "TV Cozinha", modo: "tv", unidadeId: "a1000000-0000-4000-8000-0000000000a1", redePrefixo: "200.10.20.0/24",
      codigo: "7KQ2-M9XD", token: gerarTokenTela(), segredo: "x", ip: "200.10.20.77", cookie: "a=b", email: "g@x.com",
    });
    assert.deepEqual(Object.keys(d).sort(), ["dispositivoNome", "modo", "redePrefixo", "unidadeId"]);
    assert.doesNotMatch(JSON.stringify(d), /7KQ2|200\.10\.20\.77|g@x/);
  });
  test("valor com cara de credencial é descartado mesmo num campo permitido", () => {
    const d = detalhesAuditoria(ACOES_AUDITORIA.TELA_RENOMEADA, { dispositivoId: "id-1", nomeAnterior: gerarTokenTela(), nomeNovo: "a".repeat(64) });
    assert.deepEqual(d, { dispositivoId: "id-1" });
  });
  test("ação sem contrato não é auditada por engano", () => {
    assert.throws(() => detalhesAuditoria("exibicao.qualquer", {}), /desconhecida/);
  });
  test("política: tela offline esconde os números depois de 15 min", () => {
    assert.ok(POLITICA.offlineOcultarS > POLITICA.offlineDesatualizadoS);
    assert.equal(POLITICA.offlineOcultarS, 900);
  });
});

describe("migration 110 — travas estáticas", () => {
  const sql = ler("../../database/migrations/110_exibicao_dispositivos.sql");
  const rollback = ler("../../database/migrations/110_rollback.sql");
  test("nenhum privilégio para anon/authenticated; tabelas fechadas até para o service_role", () => {
    assert.doesNotMatch(sql, /grant [^;]* to (anon|authenticated|public)/i);
    assert.match(sql, /revoke all on dispositivos_exibicao from public, anon, authenticated, service_role;/);
    assert.match(sql, /revoke all on pareamentos_exibicao from public, anon, authenticated, service_role;/);
  });
  test("toda função criada tem EXECUTE revogado e search_path fixo", () => {
    const funcoes = [...sql.matchAll(/create or replace function (exibicao_\w+)\(/g)].map((m) => m[1]);
    assert.ok(funcoes.length >= 14);
    for (const f of funcoes) assert.match(sql, new RegExp(`revoke all on function ${f}\\(`), f);
    assert.equal((sql.match(/set search_path = public, pg_temp/g) ?? []).length, funcoes.length);
  });
  test("só hashes: nenhuma coluna de token/código/segredo em claro", () => {
    // Colunas de TEXTO (onde um segredo poderia morar) com token/código/segredo no nome: só *_hash.
    const texto = [...sql.matchAll(/^\s{2}(\w+)\s+text/gm)].map((m) => m[1]).filter((x) => /token|codigo|segredo/.test(x));
    assert.ok(texto.length >= 4);
    for (const c of texto) assert.match(c, /_hash$/, c);
  });
  test("migration transacional, aditiva, com aviso de não aplicar sem aprovação; rollback aborta com tela ativa", () => {
    assert.match(sql, /^begin;$/m);
    assert.match(sql, /^commit;$/m);
    assert.match(sql, /NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA/);
    assert.doesNotMatch(sql, /\b(drop|alter) table (?!pareamentos_exibicao|dispositivos_exibicao)\w+/i, "não altera tabela existente");
    assert.match(rollback, /raise exception 'ROLLBACK 110 abortado/);
  });
});
