// Configurações 2.0 + Central de Notificações — contratos da tela (sem jsdom: fake mínimo de DOM, como configuracoes.test.js).
//
// Rodar: node --test frontend/test/configuracoes2.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function elementoFake() {
  return {
    _html: "", get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, appendChild: () => {},
    textContent: "", classList: { toggle: () => {}, add: () => {}, remove: () => {} }, style: {}, dataset: {},
  };
}
const elementos = new Map();
const pegar = (sel) => { if (!elementos.has(sel)) elementos.set(sel, elementoFake()); return elementos.get(sel); };
const chamadas = [];
globalThis.document = {
  querySelector: (sel) => pegar(sel), querySelectorAll: () => [], createElement: () => elementoFake(),
  getElementById: () => null, addEventListener: () => {}, dispatchEvent: () => true, documentElement: { setAttribute: () => {} },
};
globalThis.window = globalThis;
const armazenamento = () => ({ _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }, setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); } });
globalThis.localStorage = armazenamento();
globalThis.sessionStorage = armazenamento();
globalThis.window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "acc" } } }) } }) };
const RESPOSTAS = {
  "/api/v1/notificacoes/resumo": { data: { disponivel: true, transporte: { simulado: true, envioReal: false }, selecaoPorEscopo: false,
    unidades: [{ id: "u1", nome: "Loja Centro" }], pendencias: [{ codigo: "SEM_DESTINATARIO_D1", unidadeId: "u1", unidadeNome: "Loja Centro", texto: "Nenhum destinatário configurado para o Dashboard iFood D-1" }], podeGerenciar: true, recorte: "empresa" } },
  "/api/v1/notificacoes/categorias": { data: [{ codigo: "pendencia_d1", rotulo: "Dashboard iFood D-1", selecionavel: true }, { codigo: "x", rotulo: "Em breve X", selecionavel: false }] },
  "/api/v1/notificacoes/destinatarios": { data: { selecaoPorEscopo: false, convites: [], destinatarios: [
    { id: "d1", nome: "Joao", tipo: "principal", telefoneMascarado: "+5531*******89", estado: "LEGACY_ACTIVE", origem: "LEGACY_ACTIVE", configuracaoAnteriorTodasUnidades: true, vinculos: [] },
    { id: "d2", nome: "Maria", tipo: "operacional", telefoneMascarado: "+5531*******12", estado: "REVOGADO", origem: "CONVITE_OTP", vinculos: [] },
  ] } },
};
globalThis.fetch = async (url, opcoes = {}) => {
  const u = String(url);
  chamadas.push({ url: u, metodo: opcoes.method ?? "GET" });
  const corpo = u.includes("/api/config") ? { supabaseUrl: "https://x.example", supabaseAnonKey: "anon" } : (RESPOSTAS[u] ?? { data: {} });
  return { ok: true, status: 200, statusText: "", json: async () => corpo };
};

const { state } = await import("../src/state.js");
const { aplicarContexto } = await import("../src/sessao.js");
const { renderConfiguracoes, abrirSecaoConfiguracoes } = await import("../src/configuracoes.js");
const { montarCentralNotificacoes } = await import("../src/configuracoesNotificacoes.js");
const fuso = await import("../src/checklistOperacionalFuso.js");
const { lerFragmento } = await import("../src/conviteUsuario.js");

const fonte = (arq) => readFileSync(fileURLToPath(new URL(`../${arq}`, import.meta.url)), "utf8");
const semComentarios = (s) => s.split("\n").filter((l) => !/^(\/\/|\/\*|\*)/.test(l.trim())).join("\n");
const esperar = () => new Promise((r) => setTimeout(r, 10));
const entrar = (permissoes) => aplicarContexto({ contextToken: "tok", empresa: { id: "org", nome: "Rede X" }, unidade: { id: "u1", nome: "Loja Centro" }, papel: "organization_admin", permissoes, modulos: [] });

beforeEach(() => { chamadas.length = 0; elementos.clear(); sessionStorage._d.clear(); });

describe("Configurações 2.0 — navegação por categorias", () => {
  test("7 categorias, nesta ordem, com a primeira aberta por padrão e o cabeçalho do contexto", () => {
    entrar(["configuracoes.ver"]);
    renderConfiguracoes();
    const html = pegar("#view").innerHTML;
    const cats = [...html.matchAll(/data-cat="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(cats, ["unidade-empresa", "metas-operacao", "notificacoes", "usuarios-acesso", "integracoes", "seguranca-privacidade", "preferencias"]);
    assert.match(html, /Rede X · Loja Centro/);
    assert.match(html, /data-cat="unidade-empresa" aria-current="true"/);
    assert.match(html, /id="cfg-corpo-unidade"/);
    assert.match(html, /id="cfg-corpo-fuso"/);
    assert.match(html, /aria-label="Categorias de configurações"/);
  });

  test("a categoria aberta por último volta ao reabrir (sessionStorage)", () => {
    entrar(["configuracoes.ver"]);
    sessionStorage.setItem("cd.configuracoes.categoria", "preferencias");
    renderConfiguracoes();
    assert.match(pegar("#view").innerHTML, /data-cat="preferencias" aria-current="true"/);
  });

  test("deep-link de uma seção: só ela, dentro de #cfg-detalhe, com caminho de volta à categoria", async () => {
    entrar(["configuracoes.ver"]);
    abrirSecaoConfiguracoes("precos");
    await esperar();
    const html = pegar("#view").innerHTML;
    assert.match(html, /Metas e operação/);
    assert.match(html, /id="cfg-ver-categoria"/);
    assert.ok(chamadas.some((c) => c.url.endsWith("/api/v1/unidade/tabelas-comerciais")));
    assert.ok(!chamadas.some((c) => c.url.endsWith("/api/v1/unidade/metas-cmv")), "não carrega as outras seções da categoria");
  });

  test("seção desconhecida cai na tela inicial", () => {
    entrar(["configuracoes.ver"]);
    abrirSecaoConfiguracoes("nao-existe");
    assert.match(pegar("#view").innerHTML, /data-cat="unidade-empresa"/);
  });

  test("selo de pendências da Central só é buscado com permissão", async () => {
    entrar(["configuracoes.ver"]);
    renderConfiguracoes(); await esperar();
    assert.ok(!chamadas.some((c) => c.url.includes("/notificacoes/")));
    entrar(["configuracoes.ver", "notificacoes.ver"]);
    renderConfiguracoes(); await esperar();
    assert.ok(chamadas.some((c) => c.url.endsWith("/api/v1/notificacoes/resumo")));
  });
});

describe("Configurações 2.0 — regras de código", () => {
  const SRC = semComentarios(fonte("src/configuracoes.js"));
  const NTF = semComentarios(fonte("src/configuracoesNotificacoes.js"));
  test("nada de confirm()/alert() nativos: ações críticas usam diálogo próprio", () => {
    for (const s of [SRC, NTF]) assert.doesNotMatch(s, /\b(confirm|alert|prompt)\(/);
    assert.match(SRC, /export function confirmarDialogo/);
    assert.match(SRC, /showModal\(\)/);
  });
  test("nenhum emoji como ícone (ícones do conjunto do app)", () => {
    for (const s of [SRC, NTF]) assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
  test("D-14: conceder acesso não tem campo de senha nem gerador de senha", () => {
    assert.doesNotMatch(SRC, /nu-senha|gerarSenha|getRandomValues/);
    assert.doesNotMatch(SRC, /criarUsuario\(\{[^}]*senha/);
  });
  test("ações de usuários e da Central dependem das permissões de gestão", () => {
    assert.match(SRC, /pode\("usuarios\.gerenciar"\)/);
    assert.match(NTF, /pode\("notificacoes\.gerenciar"\)/);
    assert.match(NTF, /pode\("notificacoes\.ver"\)/);
  });
  test("a Central nunca oferece consentir/reativar revogação pelo titular", () => {
    assert.doesNotMatch(NTF, /consentir|\/convite\/verificar|habilitado:\s*true/);
    assert.match(NTF, /v\.consentimento !== "REVOGADO"/);   // sem botões para vínculo revogado
  });
  test("Configurações 2.0 tem CSS próprio ligado no index.html", () => {
    assert.match(fonte("index.html"), /\/src\/configuracoes\.css\?v=\d+/);
  });
  test("atalhos navegam pelo shell (app:navegar) e app.js usa irPara (que recusa rota sem acesso)", () => {
    assert.match(SRC, /new CustomEvent\("app:navegar"/);
    assert.match(fonte("src/app.js"), /addEventListener\("app:navegar", \(e\) => \{ if \(typeof e\.detail\?\.rota === "string"\) irPara\(e\.detail\.rota\); \}\)/);
  });
});

describe("Central de Notificações — tela", () => {
  test("mostra simulação, o estado anterior do D-1, a pendência da unidade e números mascarados", async () => {
    entrar(["notificacoes.ver", "notificacoes.gerenciar"]);
    const root = elementoFake();
    montarCentralNotificacoes(root, { confirmarDialogo: async () => false, carregarProtegido: (fn) => fn() });
    await esperar(); await esperar();
    const h = root.innerHTML;
    assert.match(h, /Modo de simulação/);
    assert.match(h, /continua recebendo de todas as unidades/);
    assert.match(h, /Loja Centro<\/b>: Nenhum destinatário configurado para o Dashboard iFood D-1/);
    assert.match(h, /Ativo — configuração anterior/);
    assert.match(h, /Revogado pelo titular/);
    assert.match(h, /\+5531\*{7}89/);
    assert.doesNotMatch(h, /\+5531\d{9}/, "nenhum número completo");
    assert.match(h, /data-novo-convite/);
  });

  test("Central indisponível (sem segredo): os avisos não se contradizem", async () => {
    entrar(["notificacoes.ver", "notificacoes.gerenciar"]);
    RESPOSTAS["/api/v1/notificacoes/resumo"] = { data: { ...RESPOSTAS["/api/v1/notificacoes/resumo"].data, disponivel: false, transporte: { modo: "desligado", simulado: false, envioReal: false } } };
    try {
      const root = elementoFake();
      montarCentralNotificacoes(root, { confirmarDialogo: async () => false, carregarProtegido: (fn) => fn() });
      await esperar(); await esperar();
      assert.match(root.innerHTML, /ainda não está habilitada/);
      assert.doesNotMatch(root.innerHTML, /convites podem ser criados/);
    } finally { RESPOSTAS["/api/v1/notificacoes/resumo"].data.disponivel = true; }
  });

  test("sem permissão de gestão: nada de convidar e sem aba de auditoria", async () => {
    entrar(["notificacoes.ver"]);
    const root = elementoFake();
    montarCentralNotificacoes(root, { confirmarDialogo: async () => false, carregarProtegido: (fn) => fn() });
    await esperar(); await esperar();
    assert.doesNotMatch(root.innerHTML, /data-novo-convite|data-aba="auditoria"/);
  });

  test("sem notificacoes.ver: não chama a API", async () => {
    entrar(["configuracoes.ver"]);
    const root = elementoFake();
    montarCentralNotificacoes(root, { confirmarDialogo: async () => false, carregarProtegido: (fn) => fn() });
    await esperar();
    assert.match(root.innerHTML, /não tem acesso/);
    assert.ok(!chamadas.some((c) => c.url.includes("/notificacoes/")));
  });
});

describe("D-15 no frontend: horários no fuso informado pelo servidor", () => {
  const instante = "2026-10-30T02:30:00.000Z";    // 23:30 de 29/10 em Brasília; 22:30 em Manaus; 21:30 em Rio Branco
  test("o mesmo instante aparece no fuso de cada unidade", () => {
    assert.equal(fuso.horaNoFuso(instante, "America/Sao_Paulo"), "23:30");
    assert.equal(fuso.horaNoFuso(instante, "America/Manaus"), "22:30");
    assert.equal(fuso.horaNoFuso(instante, "America/Rio_Branco"), "21:30");
    assert.equal(fuso.horaNoFuso(instante, "America/Noronha"), "00:30");
  });
  test("virada de dia depende do fuso", () => {
    const d = new Date(instante);
    assert.equal(fuso.diaNoFuso(d, "America/Sao_Paulo"), "2026-10-29");
    assert.equal(fuso.diaNoFuso(d, "America/Noronha"), "2026-10-30");
  });
  test("fuso inválido ou ausente volta ao padrão; o servidor define o atual", () => {
    assert.equal(fuso.definirFusoOperacao("Marte/Base"), fuso.FUSO_PADRAO);
    assert.equal(fuso.definirFusoOperacao(null), fuso.FUSO_PADRAO);
    assert.equal(fuso.definirFusoOperacao("America/Manaus"), "America/Manaus");
    assert.equal(fuso.horaNoFuso(instante), "22:30");
    fuso.definirFusoOperacao(null);
  });
  test("nenhum fuso fixo sobra nas telas do Dashboard Operacional", () => {
    for (const arq of ["checklistOperacionalOperacional.js", "checklistOperacionalDashboard.js", "checklistOperacionalDashboardVisual.js", "checklistOperacionalRelatorio.js"]) {
      assert.doesNotMatch(fonte(`src/${arq}`), /"America\/Sao_Paulo"/, arq);
    }
  });
});

describe("Páginas públicas", () => {
  test("convite de usuário: lê o token mesmo com o fragmento do Supabase anexado com outro #", () => {
    const p = lerFragmento("#t=abc_DEF-123#access_token=x&refresh_token=y&type=invite");
    assert.deepEqual([p.get("t"), p.get("access_token"), p.get("refresh_token")], ["abc_DEF-123", "x", "y"]);
  });
  test("páginas do titular: sem script inline (CSP), sem referrer, sem indexação, POST só na API pública", () => {
    for (const arq of ["notificacoes/convite.html", "notificacoes/gerenciar.html", "convite-usuario.html"]) {
      const h = fonte(arq);
      assert.doesNotMatch(h, /<script(?![^>]*\bsrc=)[^>]*>/, `${arq}: script inline`);
      assert.doesNotMatch(h, /\son[a-z]+=/i, `${arq}: handler inline`);
      assert.match(h, /name="referrer" content="no-referrer"/);
      assert.match(h, /name="robots" content="noindex, nofollow"/);
    }
    const js = semComentarios(fonte("notificacoes/titular.js"));
    assert.match(js, /const API = "\/api\/publico\/notificacoes"/);
    assert.match(js, /history\.replaceState\(null, "", location\.pathname\)/, "token sai da barra de endereço");
    assert.doesNotMatch(js, /console\./);
    assert.doesNotMatch(js, /localStorage/, "nada persiste além da aba");
    assert.doesNotMatch(js, /checked\s*\/?>/, "nenhuma categoria pré-marcada");
  });
});
