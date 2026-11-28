// Produtos / CMV 2.0 no APP REAL, em navegador real (mesma técnica de fichasLoja Doces.browser.test.js: servidor estático
// + API falsa que registra as chamadas + Supabase falso). Sem Playwright o teste é PULADO.
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/node_modules/playwright node --test frontend/test/produtosCmv2.browser.test.js
// Opcional: CMV2_RETRATO=<retrato.json> (gerado por backend/scripts/retrato-cmv2.mjs, só leitura) usa respostas reais;
//           CMV2_SHOTS=<pasta> grava capturas desktop e mobile.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const UND = { id: "00000000-0000-4000-8000-0000000000c1", nome: "Matriz" };
const CONTA = "00000000-0000-4000-8000-0000000000a1";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };
const PAPEIS = {
  admin: { papelRotulo: "Administrador", permissoes: ["dashboard.ver", "produtos.ver", "produtos.editar", "insumos.ver", "insumos.editar", "cmv.ver", "configuracoes.ver", "configuracoes.gerenciar"] },
  consulta: { papelRotulo: "Consulta", permissoes: ["dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "configuracoes.ver"] },
};

// ---------------------------------------------------------------- dados sintéticos (formato idêntico ao da API)
const P = (id, nome, tipo, situacao, pendencias = [], extra = {}) => ({ id, nome, tipo, vendavel: tipo !== "submontagem", homologacao: "pendente", situacao, pendencias, rendimento: 1, unidade_rendimento: null, homologacao_info: {}, ...extra });
const catalogo = {
  rendimento_unidade_suspeita: { criticidade: "critica", onde: "Rendimento e porcionamento", problema: "O rendimento parece estar em uma unidade diferente da informada (ex.: 2,6 kg digitado como 2,6 g).", impacto: "O custo por grama fica ~1.000× maior.", correcao: "Pese o lote pronto e informe 2.6 g." },
  insumo_sem_custo: { criticidade: "critica", onde: "Insumos e embalagens", problema: "Insumo sem preço de compra válido.", impacto: "O custo fica incompleto.", correcao: "Cadastre o preço uma vez." },
  preparacao_comprometida: { criticidade: "alta", onde: "Preparações utilizadas", problema: "Uma preparação usada nesta ficha tem pendência crítica.", impacto: "Custo herdado não confiável.", correcao: "Corrija a preparação indicada." },
  sem_preco_venda: { criticidade: "media", onde: "Preço de venda e canais", problema: "Produto vendável sem preço de venda.", impacto: "Sem CMV %.", correcao: "Informe o preço." },
};
const sintetico = () => {
  const produtos = [
    P("cb", "CREME BASE", "submontagem", "inconsistente", [{ codigo: "rendimento_unidade_suspeita", detalhe: { rendimento: 2.6, unidade: "g", massa_componentes: 2700, sugestao: 2600 } }], { vendavel: false, rendimento: 2.6, unidade_rendimento: "g" }),
    P("bolo", "BOLO BASE", "sobremesa", "incompleta", [{ codigo: "preparacao_comprometida", detalhe: "cb" }, { codigo: "sem_preco_venda" }]),
    P("cap", "CAPPUCCINO", "bebida", "inconsistente", [{ codigo: "insumo_sem_custo", detalhe: "AGUA" }, { codigo: "sem_preco_venda" }]),
    P("cook", "COOKIE TRADICIONAL", "sobremesa", "aguardando_revisao", [{ codigo: "sem_preco_venda" }]),
  ];
  const causas = [
    { chave: "ins:agua", codigo: "insumo_sem_custo", criticidade: "critica", alvo: { tipo: "insumo", id: "agua" }, nome: "AGUA", ...catalogo.insumo_sem_custo, qtd_impactados: 77, qtd_diretos: 70, impactados: ["cap"], diretos: ["cap"] },
    { chave: "rend:cb", codigo: "rendimento_unidade_suspeita", criticidade: "critica", alvo: { tipo: "produto", id: "cb" }, nome: "CREME BASE", detalhe: { rendimento: 2.6, unidade: "g", massa_componentes: 2700, sugestao: 2600 }, ...catalogo.rendimento_unidade_suspeita, qtd_impactados: 2, qtd_diretos: 1, impactados: ["cb", "bolo"], diretos: ["cb"] },
  ];
  const saude = { perfil: { modelo: "marca_propria", recursos: { assistente_receitas: true, homologacao: true, revisao_rendimentos: true } },
    resumo: { produtos_finais: 3, preparacoes: 1, por_situacao: { inconsistente: 2, incompleta: 1, aguardando_revisao: 1 }, insumos: 3, insumos_sem_custo: 1, insumos_custo_zero_declarado: 0, homologadas: 0, elegiveis_homologacao: 1, rendimentos_suspeitos: 1, fichas_sem_pendencia: 1, qualidade_pct: 25 },
    dimensoes: { receita_completa: 4, custo_confiavel: 1, cmv_disponivel: 0, rentabilidade_disponivel: 0 },
    precos: { vendaveis: 3, com_preco: 0, cobertura_pct: 0, linhas: 0, condicoes_configuradas: false }, causas_raiz: causas, evolucao_correcoes: [], ultima_atualizacao_custo: null };
  const reccb = { produto_id: "cb", natureza: "preparacao", nome: "CREME BASE", proxima_etapa: "porcionamento", custo_unitario: 20.0009,
    etapas: [{ etapa: "identificacao", estado: "valida", pendencias: [] }, { etapa: "ingredientes", estado: "valida", pendencias: [] }, { etapa: "aproveitamento", estado: "valida", pendencias: [] },
      { etapa: "porcionamento", estado: "pendente", pendencias: [{ codigo: "rendimento_unidade_suspeita", detalhe: { sugestao: 2600, unidade: "g" }, ...catalogo.rendimento_unidade_suspeita }] }, { etapa: "revisao", estado: "bloqueada", pendencias: [] }],
    dados: { identificacao: { nome: "CREME BASE" }, porcionamento: { rendimento: 2.6, unidade_rendimento: "g" }, precos: [],
      ingredientes: [{ ficha_id: "f1", tipo: "insumo", nome: "INSUMO A", quantidade: 1200, unidade: "g", unidade_base: "g", custo_unitario_base: 0.015, custo_aplicado: 17.7, ativo: true },
        { ficha_id: "f2", tipo: "insumo", nome: "INSUMO D", quantidade: 300, unidade: "g", unidade_base: "g", custo_unitario_base: 0.04, custo_aplicado: 12.1, ativo: true }] }, rascunho: null };
  const recBolo = { ...reccb, produto_id: "bolo", natureza: "produto_final", nome: "BOLO BASE", proxima_etapa: "ingredientes", custo_unitario: 8000,
    etapas: ["identificacao", "ingredientes", "aproveitamento", "porcionamento", "complementares", "precos", "revisao"].map((e) => ({ etapa: e, estado: e === "ingredientes" || e === "precos" ? "pendente" : e === "revisao" ? "bloqueada" : "valida", pendencias: [] })),
    dados: { ...reccb.dados, porcionamento: { rendimento: 12, unidade_rendimento: null }, ingredientes: [{ ficha_id: "f3", tipo: "submontagem", nome: "CREME BASE", quantidade: 400, unidade: "g", unidade_base: "g", custo_unitario_base: 20.0009, custo_aplicado: 8000.36, ativo: true }] } };
  return { saude, pend: { catalogo, causas_raiz: causas, produtos }, homol: { elegiveis: [{ id: "cook", nome: "COOKIE TRADICIONAL", situacao: "aguardando_revisao", elegivel: true, motivos: [] }], bloqueadas: [{ id: "cb", nome: "CREME BASE", situacao: "inconsistente", motivos: [catalogo.rendimento_unidade_suspeita.problema] }], homologadas: 0, padronizadas: 0 },
    rend: { itens: [{ produto_id: "cb", nome: "CREME BASE", unidade: "g", rendimento_atual: 2.6, massa_ingredientes: 2700, linhas_comparaveis: 4, linhas_total: 4, origem: { arquivo: "fichas-doces.xlsx", aba: "B49", rendimento_planilha: 2.6 }, causa: "Valor provavelmente em kg: 2600 g = 97% da massa.", sugestao: 2600, confianca: "alta", rendimento_proposto: 2600, editado: false, custo_unitario_antes: 20.0009, custo_unitario_depois: 0.0200, dependentes: 1, impacto_dependentes: [], reducao_custo_dependentes: 7992.3 },
      { produto_id: "sg", nome: "PEIXE GRELHADO", unidade: "g", rendimento_atual: 1.5, massa_ingredientes: 540, linhas_comparaveis: 3, linhas_total: 3, origem: null, causa: "Nem 1.5 nem 1500 g são compatíveis com 540 g — exige pesagem.", sugestao: null, confianca: "nenhuma", rendimento_proposto: null, editado: false, custo_unitario_antes: 31.2, custo_unitario_depois: null, dependentes: 13, impacto_dependentes: [], reducao_custo_dependentes: 0 }] },
    custoZero: { agua: { insumo: { id: "agua", nome: "AGUA", natureza_custo: "desconhecido", preco_unitario: 0 }, afetados: 77, ficariam_sem_pendencia: 70, continuariam_com_pendencia: 7, itens: [{ id: "cap", nome: "CAPPUCCINO", situacao_antes: "inconsistente", situacao_depois: "aguardando_revisao", pendencias_restantes: [] }], aviso: "Declarar custo zero é uma decisão de metodologia." } },
    recuperacao: { "cb": reccb, bolo: recBolo, cap: { ...recBolo, produto_id: "cap", nome: "CAPPUCCINO" }, cook: { ...recBolo, produto_id: "cook", nome: "COOKIE TRADICIONAL", etapas: recBolo.etapas.map((e) => ({ ...e, estado: e.etapa === "revisao" ? "pronta" : e.etapa === "precos" ? "pendente" : "valida" })) } },
    simulacao: {},
  };
};

const RETRATO = process.env.CMV2_RETRATO ? JSON.parse(readFileSync(process.env.CMV2_RETRATO, "utf8")) : null;
const api = { chamadas: [], corpos: [], papel: "admin", modulos: ["dashboard", "products_cmv", "ingredients", "products_cmv_v2"], d: sintetico(), nomeEmpresa: "Loja Doces" };
const usar = (d, nome) => Object.assign(api, { d, nomeEmpresa: nome, chamadas: [], corpos: [] });
let servidor; let base; let browser;
const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
const lerCorpo = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : null); } catch { ok(null); } }); });

before(async () => {
  if (PULAR) return;
  servidor = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"); const c = u.pathname; let m;
    if (c === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
    if (c.startsWith("/api/v1/")) {
      const corpo = req.method === "GET" ? null : await lerCorpo(req);
      api.chamadas.push(`${req.method} ${c}`); if (corpo) api.corpos.push({ chamada: `${req.method} ${c}`, corpo });
      const papel = PAPEIS[api.papel]; const d = api.d;
      const ctx = () => ({ contextToken: "ctx", expiraEm: new Date(Date.now() + 8 * 3600e3).toISOString(), sessionId: "s", perfil: { id: CONTA, nome: "Conta" },
        empresa: { id: "org", nome: api.nomeEmpresa, logoUrl: null, status: "ativa" }, unidade: UND, papel: api.papel, papelRotulo: papel.papelRotulo, permissoes: papel.permissoes, modulos: api.modulos, impersonando: false });
      if (c === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "admin@exemplo.test", nome: "Admin", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
      if (c === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "Admin", ativo: true, temPin: false }] });
      if (c === "/api/v1/sessao/acessos") return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: [{ organizacaoId: "org", unidadeId: UND.id, empresaNome: api.nomeEmpresa, unidadeNome: UND.nome, papel: api.papel, papelRotulo: papel.papelRotulo, acessivel: true, empresaStatus: "ativa" }] } });
      if (c === "/api/v1/sessao/selecionar") return json(res, 201, { data: ctx() });
      if (c === "/api/v1/sessao/atual") return json(res, 200, { data: ctx() });
      if (c === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [UND] } });
      if (c === "/api/v1/realtime/credencial") return json(res, 200, { data: { topicos: [], expiraEm: new Date(Date.now() + 300e3).toISOString(), validadeS: 300 } });
      if (c === "/api/v1/cmv") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Tabela comercial (balcão) não configurada para esta unidade.", codigo: "TABELA_NAO_CONFIGURADA" })); }
      if (c === "/api/v1/produtos/cmv/saude") return json(res, 200, { data: d.saude });
      if (c === "/api/v1/produtos/cmv/pendencias") return json(res, 200, { data: d.pend });
      if (c === "/api/v1/produtos/cmv/rascunhos" && req.method === "GET") return json(res, 200, { data: [] });
      if (c === "/api/v1/produtos/cmv/rascunhos" && req.method === "POST") return json(res, 200, { data: { id: "r1", ...corpo } });
      if ((m = c.match(/^\/api\/v1\/produtos\/cmv\/rascunhos\/([^/]+)$/)) && req.method === "PUT") return json(res, 200, { data: { id: m[1], ...corpo } });
      if (c === "/api/v1/produtos/cmv/rendimentos/previa") return json(res, 200, { data: d.rend });
      if (c === "/api/v1/produtos/cmv/rendimentos/aplicar") return json(res, 200, { data: { lote_id: "l1", corrigidos: corpo.itens.length, recalculados: 2 } });
      if ((m = c.match(/^\/api\/v1\/produtos\/cmv\/custo-zero\/([^/]+)\/previa$/))) return json(res, 200, { data: d.custoZero[m[1]] ?? Object.values(d.custoZero)[0] });
      if (c === "/api/v1/produtos/cmv/homologacao/previa") return json(res, 200, { data: d.homol });
      if (c === "/api/v1/produtos/cmv/homologacao/lote") return json(res, 200, { data: { homologadas: corpo.ids, recusadas: [] } });
      if ((m = c.match(/^\/api\/v1\/produtos\/cmv\/fichas\/([^/]+)\/recuperacao$/))) return json(res, 200, { data: d.recuperacao[m[1]] ?? Object.values(d.recuperacao)[0] });
      if ((m = c.match(/^\/api\/v1\/produtos\/cmv\/fichas\/([^/]+)\/simular$/))) return json(res, 200, { data: d.simulacao[m[1]] ?? { produto: { id: m[1] }, canais: [{ canal: "ifood", preco_oficial: null, origem_preco: null, disponivel: true, custo: 9, preco: corpo.preco ?? 30, condicao_configurada: true, deducoes_pct: 0.295, deducoes_fixas: 0, cmv_pct: 30, margem_bruta: 21, margem_bruta_pct: 70, margem_contribuicao: 12.15, margem_contribuicao_pct: 40.5, preco_para_meta_cmv: 30, preco_para_margem_alvo: 19.6, avisos: [] }], aviso: "Simulação: nenhum preço real é alterado. Margem de contribuição não é lucro líquido (faltam despesas fixas)." } });
      if (c === "/api/v1/produtos/cmv/fichas" && req.method === "POST") return json(res, 200, { data: { id: "novo", nome: corpo.nome } });
      if (c.startsWith("/api/v1/insumos") && d.custoZero && !d.custoZero.agua) {
        // retrato real: insumos sem custo (das prévias) + insumos com preço vistos nas fichas
        const vistos = new Map(Object.values(d.custoZero).map((z) => [z.insumo.id, { id: z.insumo.id, nome: z.insumo.nome, unidade_medida: "ml", preco_unitario: 0, tipo: "outro" }]));
        for (const r of Object.values(d.recuperacao)) for (const x of r.dados.ingredientes) if (x.insumo_id && !vistos.has(x.insumo_id)) vistos.set(x.insumo_id, { id: x.insumo_id, nome: x.nome, unidade_medida: x.unidade_base, preco_unitario: x.custo_unitario_base ?? 0, tipo: x.categoria ?? "outro" });
        return json(res, 200, { data: [...vistos.values()] });
      }
      if (c.startsWith("/api/v1/insumos")) return json(res, 200, { data: [{ id: "agua", nome: "AGUA", unidade_medida: "ml", preco_unitario: 0, tipo: "outro" }, { id: "lc", nome: "INSUMO A", unidade_medida: "g", preco_unitario: 0.015, tipo: "outro" }, { id: "cx", nome: "CAIXA KRAFT", unidade_medida: "un", preco_unitario: 1.2, tipo: "embalagem" }] });
      if ((m = c.match(/^\/api\/v1\/produtos\/([^/]+)\/historico$/))) return json(res, 200, { data: [] });
      if (c === "/api/v1/produtos/catalogo/fichas") return json(res, 200, { data: { resumo: { total: 0 }, itens: [] } });
      return json(res, 200, { data: [] });
    }
    const arq = resolve(RAIZ, "." + (c === "/" ? "/index.html" : c));
    if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader("Content-Type", MIME[extname(arq)] ?? "application/octet-stream"); res.end(readFileSync(arq)); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHECKLIST_BROWSER_CHANNEL ? { channel: process.env.CHECKLIST_BROWSER_CHANNEL } : {}) });
});
after(async () => { await browser?.close(); if (servidor) await new Promise((r) => servidor.close(r)); });

async function abrirApp(viewport = { width: 1440, height: 900 }) {
  const contexto = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await contexto.route((url) => url.origin !== base, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = []; pagina.__erros = erros; pagina.on("pageerror", (e) => erros.push(e.message));
  await pagina.addInitScript(({ conta }) => {
    window.__sessaoSupabase = { access_token: "jwt", user: { id: conta, email: "admin@exemplo.test" } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: window.__sessaoSupabase } }), signOut: async () => ({ error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: window.__sessaoSupabase.user } }) }, realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {} }) };
  }, { conta: CONTA });
  await pagina.goto(base + "/");
  await pagina.waitForFunction(() => !document.querySelector("#app")?.hidden && document.querySelector("#menu li[data-rota]"));
  return { pagina, contexto, erros };
}
const SHOTS = process.env.CMV2_SHOTS;
const foto = async (pagina, nome, inteira = true) => { if (SHOTS) { await pagina.waitForTimeout(400); await pagina.screenshot({ path: resolve(SHOTS, nome + ".png"), fullPage: inteira }); } };
const abrirProdutos = async (pagina) => {
  await pagina.click('#menu li[data-rota="produtos"]');
  try { await pagina.waitForSelector(".c2-hero, .c2-vazio", { timeout: 10000 }); }
  catch { throw new Error(`Produtos não abriu: ${await pagina.evaluate(() => document.querySelector("#view")?.innerHTML.slice(0, 500))} | ${(pagina.__erros ?? []).join(" ; ")}`); }
};
const area = async (pagina, id) => {
  await pagina.click(`.c2-nav-item[data-area="${id}"]`);
  await pagina.waitForFunction(() => { const c = document.querySelector("#c2-conteudo"); return c && c.firstElementChild && !c.querySelector(".c2-esqueleto"); });
};
const semRolagemHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

describe("Produtos / CMV 2.0 — navegador real", { skip: PULAR, timeout: 600_000 }, () => {
  test("sem o módulo piloto, a tela atual de Produtos continua (nenhuma chamada /cmv/*)", async () => {
    usar(sintetico(), "Empresa sem piloto"); const antes = api.modulos; api.modulos = ["dashboard", "products_cmv", "ingredients"];
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.click('#menu li[data-rota="produtos"]'); await pagina.waitForTimeout(800);
      assert.equal(await pagina.$(".c2"), null);
      assert.ok(!api.chamadas.some((x) => x.includes("/produtos/cmv/")));
      assert.deepEqual(erros, []);
    } finally { api.modulos = antes; await contexto.close(); }
  });

  test("marca própria: visão geral, causas-raiz, ficha com régua, assistente, rendimentos, custo zero, homologação, precificação", async () => {
    usar(sintetico(), "Loja Doces"); api.papel = "admin";
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await abrirProdutos(pagina);
      assert.match(await pagina.textContent(".c2-hero-titulo"), /1 de 4 fichas com custo confiável/);
      assert.match(await pagina.textContent(".c2-nota"), /Sem pendências não significa homologada/);
      assert.match(await pagina.textContent("#c2-conteudo"), /AGUA/);
      // página da ficha: régua com o erro de rendimento destacado
      await area(pagina, "preparacoes"); await pagina.click('.c2-linha[data-id="cb"]'); await pagina.waitForSelector(".c2-regua");
      assert.ok(await pagina.$(".c2-regua-alerta"), "rendimento suspeito destacado na régua");
      assert.match(await pagina.textContent(".c2-regua"), /20,00/);
      // recuperação: abre direto na etapa pendente; preparação não tem etapa de preço
      await pagina.click('[data-acao="recuperar"]'); await pagina.waitForSelector(".c2-assist");
      assert.equal(await pagina.getAttribute('.c2-etapa[aria-current="step"]', "data-etapa"), "porcionamento");
      assert.equal(await pagina.$('.c2-etapa[data-etapa="precos"]'), null);
      assert.match(await pagina.textContent(".c2-ajuda"), /2\.600 g/);
      await pagina.click('[data-acao="assist-salvar"]'); await pagina.waitForTimeout(300);
      assert.ok(api.corpos.some((x) => x.chamada.includes("/rascunhos") && x.corpo.natureza === "preparacao" && x.corpo.etapa === "porcionamento"), "rascunho salvo com etapa");
      // revisão de rendimentos: PEIXE sem sugestão; aplicar exige seleção e envia justificativa
      await area(pagina, "pendencias"); await pagina.click('[data-acao="rendimentos"]'); await pagina.waitForSelector("#c2-rend-form");
      assert.equal(await pagina.inputValue('li.c2-rev[data-id="sg"] [name="novo"]'), "");
      await pagina.check('li.c2-rev[data-id="cb"] [name="sel"]'); await pagina.fill('li.c2-rev[data-id="cb"] [name="just"]', "lote pesado em 28/11: 2.6 g");
      await pagina.click('#c2-rend-form button[type="submit"]'); await pagina.waitForTimeout(400);
      const ap = api.corpos.find((x) => x.chamada.endsWith("/rendimentos/aplicar"));
      assert.deepEqual(ap.corpo.itens, [{ produto_id: "cb", rendimento_atual: 2.6, rendimento_novo: 2600, justificativa: "lote pesado em 28/11: 2.6 g" }]);
      // custo zero: prévia mostra quantas continuariam com pendência; exige motivo
      await area(pagina, "insumos"); await pagina.click('[data-acao="custo-zero"][data-id="agua"]'); await pagina.waitForSelector('[data-form="custo-zero"]');
      assert.match(await pagina.textContent("#c2-conteudo"), /70.*ficariam sem pendência.*7.*continuariam/s);
      // homologação: elegíveis × bloqueadas com motivo
      await area(pagina, "visao"); await pagina.click('[data-acao="homologacao"]'); await pagina.waitForSelector("#c2-hom-form");
      assert.match(await pagina.textContent("#c2-conteudo"), /Bloqueadas e por quê/);
      // precificação: não grava preço; texto não chama margem de contribuição de lucro
      await area(pagina, "precificacao"); await pagina.selectOption('#c2-sim [name="produto"]', "cook"); await pagina.fill('#c2-sim [name="preco"]', "30"); await pagina.click('#c2-sim button[type="submit"]');
      await pagina.waitForSelector(".c2-canal");
      assert.match(await pagina.textContent("#c2-sim-res"), /não é lucro líquido/);
      assert.ok(!api.chamadas.some((x) => /PUT .*\/preco$/.test(x)), "simular nunca grava preço");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("perfil Consulta: vê tudo, sem ações de escrita", async () => {
    usar(sintetico(), "Loja Doces"); api.papel = "consulta";
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await abrirProdutos(pagina);
      assert.equal(await pagina.$('[data-acao="homologacao"]'), null);
      await area(pagina, "pendencias"); await pagina.click('[data-acao="rendimentos"]'); await pagina.waitForSelector("#c2-rend-form");
      assert.equal(await pagina.$('#c2-rend-form button[type="submit"]'), null);
      assert.deepEqual(erros, []);
    } finally { api.papel = "admin"; await contexto.close(); }
  });

  test("unidade vazia: estado inicial educativo", async () => {
    const d = sintetico(); d.saude = { ...d.saude, perfil: { modelo: "sem_catalogo", recursos: { assistente_receitas: true } }, resumo: { ...d.saude.resumo, produtos_finais: 0, preparacoes: 0, por_situacao: {} } };
    usar(d, "Loja vazia");
    const { pagina, contexto } = await abrirApp();
    try { await abrirProdutos(pagina); assert.match(await pagina.textContent(".c2-vazio"), /ainda não tem fichas técnicas/); } finally { await contexto.close(); }
  });

  test("mobile 390px: navegação em abas e sem rolagem horizontal nas telas principais", async () => {
    usar(sintetico(), "Loja Doces");
    const { pagina, contexto } = await abrirApp();
    try {
      await abrirProdutos(pagina); await pagina.setViewportSize({ width: 390, height: 844 }); // o menu lateral do app vira gaveta no celular
      for (const a of ["visao", "produtos", "pendencias", "precificacao"]) { await area(pagina, a); assert.ok(await semRolagemHorizontal(pagina), `sem rolagem horizontal em ${a}`); }
      await area(pagina, "preparacoes"); await pagina.click('.c2-linha[data-id="cb"]'); await pagina.waitForSelector(".c2-regua");
      assert.ok(await semRolagemHorizontal(pagina), "ficha sem rolagem horizontal");
    } finally { await contexto.close(); }
  });

  // Capturas com dados reais (retrato somente leitura). Só roda com CMV2_RETRATO + CMV2_SHOTS.
  test("capturas: quatro empresas, desktop e mobile", { skip: !(RETRATO && SHOTS) && "defina CMV2_RETRATO e CMV2_SHOTS" }, async () => {
    // Nomes das pastas: CMV2_NOMES='{"<orgId>":"<rotulo>"}' (fica fora do repositório); sem ele, org-1, org-2…
    const nomes = process.env.CMV2_NOMES ? JSON.parse(process.env.CMV2_NOMES) : Object.fromEntries(Object.keys(RETRATO).map((k, i) => [k, `org-${i + 1}`]));
    for (const [org, nome] of Object.entries(nomes)) {
      if (!RETRATO[org]) continue;
      for (const vp of [{ w: 1440, h: 900, s: "desktop" }, { w: 390, h: 844, s: "mobile" }]) {
        usar(RETRATO[org], nome); api.papel = "admin";
        const { pagina, contexto, erros } = await abrirApp();
        try {
          await abrirProdutos(pagina); await pagina.setViewportSize({ width: vp.w, height: vp.h }); await foto(pagina, `${nome}-${vp.s}-01-visao`);
          if (RETRATO[org].pend.produtos.length) {
            await area(pagina, "produtos"); await foto(pagina, `${nome}-${vp.s}-02-produtos`, vp.s === "mobile");
            await area(pagina, "preparacoes"); await foto(pagina, `${nome}-${vp.s}-03-preparacoes`, false);
            await area(pagina, "insumos"); await foto(pagina, `${nome}-${vp.s}-04-insumos`, false);
            await area(pagina, "pendencias"); await foto(pagina, `${nome}-${vp.s}-05-pendencias`);
            const alvo = Object.keys(RETRATO[org].recuperacao)[0];
            if (alvo) {
              await pagina.evaluate(() => 0); const id = alvo;
              await area(pagina, RETRATO[org].pend.produtos.find((p) => p.id === id)?.tipo === "submontagem" ? "preparacoes" : "produtos");
              await pagina.click(`.c2-linha[data-id="${id}"]`); await pagina.waitForSelector(".c2-regua"); await foto(pagina, `${nome}-${vp.s}-06-ficha`);
              if (await pagina.$('[data-acao="recuperar"]')) { await pagina.click('[data-acao="recuperar"]'); await pagina.waitForSelector(".c2-assist"); await foto(pagina, `${nome}-${vp.s}-07-recuperacao`); }
            }
            if (RETRATO[org].rend.itens.length) { await area(pagina, "pendencias"); await pagina.click('[data-acao="rendimentos"]'); await pagina.waitForSelector("#c2-rend-form"); await foto(pagina, `${nome}-${vp.s}-08-rendimentos`); }
            const cz = Object.keys(RETRATO[org].custoZero)[0];
            if (cz) { await area(pagina, "insumos"); await pagina.click(`[data-acao="custo-zero"][data-id="${cz}"]`); await pagina.waitForSelector('[data-form="custo-zero"]'); await foto(pagina, `${nome}-${vp.s}-09-custo-zero`, false); }
            if (await pagina.$('.c2-nav-item[data-area="visao"]')) { await area(pagina, "visao"); if (await pagina.$('[data-acao="homologacao"]')) { await pagina.click('[data-acao="homologacao"]'); await pagina.waitForSelector("#c2-hom-form"); await foto(pagina, `${nome}-${vp.s}-10-homologacao`, false); } }
            await area(pagina, "precificacao"); const opc = await pagina.$$eval('#c2-sim [name="produto"] option', (o) => o.map((x) => x.value).filter(Boolean));
            const simId = Object.keys(RETRATO[org].simulacao).find((k) => opc.includes(k)) ?? opc[0];
            if (simId) { await pagina.selectOption('#c2-sim [name="produto"]', simId); await pagina.click('#c2-sim button[type="submit"]'); await pagina.waitForSelector(".c2-canal, .c2-aviso, .c2-erro"); }
            await foto(pagina, `${nome}-${vp.s}-11-precificacao`);
            if (Object.keys(nomes)[0] === org) { await area(pagina, "produtos"); const b = await pagina.$('[data-acao="nova-ficha"]'); if (b) { await b.click(); await pagina.waitForSelector(".c2-assist"); await foto(pagina, `${nome}-${vp.s}-12-assistente-novo`); } }
          }
          assert.deepEqual(erros, [], `${nome} ${vp.s} sem erros de página`);
        } finally { await contexto.close(); }
      }
    }
  });
});
