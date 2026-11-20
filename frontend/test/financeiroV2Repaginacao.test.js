// Regressão da repaginação do Crescer Com Delivery Financeiro (entrada em etapas, fontes por unidade, sessão expirada, navegação).
// Rodar: node --test frontend/test/financeiroV2Repaginacao.test.js
// (A verificação em navegador real fica em backend/scripts/fv2/navegadorRepaginacao.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decidirSetor, consumirSetorPedido } from "../src/setores.js";
import { TRANSICAO_FINANCEIRO, gravarUltimoFinanceiro, lerUltimoFinanceiro } from "../src/financeiroAcesso.js";
import { ROTAS_PLATAFORMA, criarTransportePlataforma, estadoDoErro, traduzirEndereco } from "../financeiro-v2/plataforma.js";
import { definirFontesDaUnidade, relatorioDeOutroSistema, sistemaDeLoja, usaAnotaAi } from "../financeiro-v2/formatar.js";
import * as telas from "../financeiro-v2/telas.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as ven from "../financeiro-v2/telasVendas.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

const arquivo = (n) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${n}`, import.meta.url)), "utf8");
const resp = (status, corpo = {}) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

// ------------------------------------------------------------------ entrada: uma só interface
test("shell: o menu de canais nasce vazio (nenhuma fonte visível até a configuração da unidade chegar)", () => {
  const html = arquivo("index.html");
  for (const f of ["SAIPOS", "SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]) assert.match(html, new RegExp(`<li hidden data-fonte="${f}">`), `${f} começa escondido`);
  assert.match(html, /<html lang="pt-BR" data-boot="identificando">/, "a página já nasce na etapa 'identificando'");
  assert.match(html, /class="nav-esqueleto"/, "há esqueleto de menu enquanto a unidade não é conhecida");
  assert.ok(!/Anota A[ií]/i.test(html), "o HTML estático não menciona Anota Aí");
  const css = arquivo("fv2.css");
  assert.match(css, /html\[data-boot="identificando"\] \.nav-grupos, html\[data-boot="configurando"\] \.nav-grupos/, "grupos do menu escondidos nas etapas iniciais");
});

test("app: etapas explícitas da entrada e nenhuma queda silenciosa para SAIPOS", () => {
  const app = arquivo("app.js");
  for (const e of ["identificando", "configurando", "carregando", "pronto", "erro", "sessao-expirada"]) assert.match(app, new RegExp(`"${e}"`), `etapa ${e}`);
  assert.ok(!/sistema: r\.ok \? r\.dados\.sistemaDeLoja : "SAIPOS"/.test(app), "falha ao carregar as fontes NÃO vira 'SAIPOS por padrão'");
  assert.match(app, /fontesAdiantadas = consultorFontes\.consultar/, "as fontes saem em paralelo com a sessão");
  assert.match(app, /const consultorFontes = criarConsultor\(\)/);
  // dados de outra unidade nunca ficam: a troca de unidade/sessão esvazia as fontes e o cache
  assert.match(app, /estado\.fontesDaUnidade = null; reiniciarFiltros\(\); invalidarCache\(\)/);
});

test("app: telas pesadas sob demanda (a primeira tela não baixa as demais)", () => {
  const app = arquivo("app.js");
  for (const m of ["telasAdministracao", "telasConferencias", "telasVendas", "telasCanais", "telasCalendarioCanais", "telasImportacoesCanais", "telasEntregadores"]) {
    assert.ok(!new RegExp(`^import .* from "\\./${m}\\.js";`, "m").test(app), `${m} não é importado de forma estática`);
    assert.match(app, new RegExp(`import\\("\\./${m}\\.js"\\)`), `${m} é importado sob demanda`);
  }
  const html = arquivo("index.html");
  assert.ok(!/modulepreload" href="telasConferencias\.js"/.test(html), "sem pré-carga dos módulos que não são da primeira tela");
});

// ------------------------------------------------------------------ plataforma: setor pedido e navegação
test("plataforma: ?setor= só vale se o servidor ainda autoriza o setor", () => {
  assert.deepEqual(decidirSetor({ setores: ["financeiro", "operacional"], setorPedido: "operacional" }), { acao: "entrar", setor: "operacional", setores: ["financeiro", "operacional"] });
  assert.equal(decidirSetor({ setores: ["operacional"], setorPedido: "financeiro" }).setor, "operacional", "pedido sem autorização cai na regra normal");
  assert.equal(decidirSetor({ setores: ["financeiro"], setorPedido: "escolher" }).acao, "escolher", "voltar à plataforma mostra a escolha mesmo com um setor só (sem reentrar no financeiro)");
  assert.equal(decidirSetor({ setores: [], setorPedido: "financeiro" }).acao, "bloqueado");
  assert.equal(decidirSetor({ setores: null, setorPedido: "financeiro" }).setor, "operacional", "falha ao consultar nunca libera o financeiro");
  assert.equal(decidirSetor({ setores: ["financeiro", "operacional"], exibicao: true, setorPedido: "financeiro" }).setor, "operacional", "perfil de exibição ignora o pedido");
  assert.equal(decidirSetor({ setores: ["financeiro", "operacional"], impersonando: true, setorPedido: "financeiro" }).setor, "operacional", "suporte (impersonação) ignora o pedido");
});

test("plataforma: o pedido de setor é lido uma vez e o parâmetro some da barra de endereço", () => {
  let url = "https://app.exemplo/?setor=operacional&x=1#/a";
  const loc = { get href() { return url; } };
  const hist = { state: null, replaceState: (_s, _t, novo) => { url = `https://app.exemplo${novo}`; } };
  assert.equal(consumirSetorPedido(loc, hist), "operacional");
  assert.equal(url, "https://app.exemplo/?x=1#/a");
  assert.equal(consumirSetorPedido(loc, hist), null, "segunda leitura não encontra mais nada");
  url = "https://app.exemplo/?setor=qualquer-coisa";
  assert.equal(consumirSetorPedido(loc, hist), null, "valor desconhecido é ignorado");
});

test("rotas oficiais da plataforma usadas pelos botões do Financeiro", () => {
  assert.deepEqual({ ...ROTAS_PLATAFORMA }, { entrar: "/?setor=financeiro", inicio: "/?setor=escolher", operacional: "/?setor=operacional" });
  const html = arquivo("index.html");
  assert.match(html, /id="link-operacional" href="\/\?setor=operacional"/);
  assert.match(html, /id="link-plataforma" href="\/\?setor=escolher"/);
  const plat = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
  assert.match(plat, /window\.location\.replace\(ENDERECO_FINANCEIRO_V2\)/, "o redirecionamento não deixa a página de transição no histórico");
  assert.ok(!/window\.location\.assign\(ENDERECO_FINANCEIRO_V2\)/.test(plat));
});

test("transição da plataforma tem a mesma estrutura do v2 e cobre o cabeçalho da plataforma", () => {
  assert.match(TRANSICAO_FINANCEIRO, /fin-transicao-menu/);
  assert.match(TRANSICAO_FINANCEIRO, /Crescer Com Delivery<\/span><strong>Financeiro/);
  assert.match(TRANSICAO_FINANCEIRO, /role="status"/);
  const css = readFileSync(fileURLToPath(new URL("../src/financeiro.css", import.meta.url)), "utf8");
  assert.match(css, /\.fin-transicao \{ position: fixed; inset: 0;/);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(lerUltimoFinanceiro("a:b:c", storage), null);
  gravarUltimoFinanceiro("a:b:c", false, storage);
  assert.equal(lerUltimoFinanceiro("a:b:c", storage), false);
  assert.equal(lerUltimoFinanceiro("outro", storage), null, "a dica é por contexto");
  assert.ok(!/R\$|centavos|token/i.test([...store.values()].join("")), "nada financeiro nem credencial na dica");
});

// ------------------------------------------------------------------ sessão: expirada × rede × permissão
test("erros: sessão expirada, rede e permissão são estados diferentes", () => {
  assert.equal(estadoDoErro({ status: 401, erro: "SEM_SESSAO" }).tipo, "sem-sessao");
  assert.equal(estadoDoErro({ status: 401, motivo: "SESSAO_EXPIRADA" }).tipo, "sem-sessao");
  assert.equal(estadoDoErro({ status: 0, erro: "SEM_CONEXAO", mensagem: "x" }).tipo, "rede");
  assert.equal(estadoDoErro({ status: 403, motivo: "SEM_CONCESSAO", mensagem: "x" }).tipo, "negado");
  assert.equal(estadoDoErro({ status: 409, erro: "SEM_CONTEXTO", mensagem: "Escolha a unidade" }).tipo, "sem-contexto");
  assert.equal(estadoDoErro({ status: 500, mensagem: "falha" }).tipo, "erro");
});

test("estados: sessão expirada e rede oferecem ação; carregando reserva o espaço do conteúdo", () => {
  const h = telas.estado("sem-sessao", "x", { titulo: "Sua sessão expirou", acoes: [{ rotulo: "Entrar novamente", href: "/?setor=financeiro", primario: true }, { rotulo: "Voltar à plataforma", href: "/?setor=escolher" }] });
  assert.match(h, /Sua sessão expirou/);
  assert.match(h, /<a class="botao botao--primario" href="\/\?setor=financeiro">Entrar novamente<\/a>/);
  assert.match(h, /href="\/\?setor=escolher">Voltar à plataforma/);
  assert.match(telas.estado("rede", "sem internet"), /data-tentar-novamente/);
  assert.match(telas.estado("carregando"), /esq-cards/);
  assert.match(telas.estado("carregando", "", { compacto: true }), /class="esqueleto"/);
  assert.ok(!/esq-cards/.test(telas.estado("carregando", "", { compacto: true })));
  assert.match(telas.estado("sem-sessao"), /Sessão ausente/, "mensagem padrão da demonstração preservada");
});

test("transporte: 401 → UMA renovação e UMA repetição; nunca em laço", async () => {
  let chamadas = 0; let renovacoes = 0;
  const base = { credenciais: async () => ({ token: "t", contexto: "c" }), fetchFn: async () => { chamadas += 1; return resp(401, { erro: "SEM_SESSAO" }); } };
  const t = criarTransportePlataforma({ ...base, renovar: async () => { renovacoes += 1; return true; } });
  const r = await t("/api/fv2/visao-geral?competencia=2026-11");
  assert.equal(r.status, 401);
  assert.equal(chamadas, 2, "1 chamada + 1 repetição");
  assert.equal(renovacoes, 1);
  // renovação que não funciona: nenhuma repetição
  chamadas = 0;
  const t2 = criarTransportePlataforma({ ...base, renovar: async () => false });
  assert.equal((await t2("/api/fv2/dre")).status, 401);
  assert.equal(chamadas, 1);
  // renovação que dá certo e a repetição passa
  let n = 0;
  const t3 = criarTransportePlataforma({ credenciais: base.credenciais, renovar: async () => true, fetchFn: async () => (++n === 1 ? resp(401, { erro: "SEM_SESSAO" }) : resp(200, { ok: 1 })) });
  assert.equal((await t3("/api/fv2/dre")).status, 200);
  // 403 e 5xx não disparam renovação
  renovacoes = 0;
  const t4 = criarTransportePlataforma({ credenciais: base.credenciais, renovar: async () => { renovacoes += 1; return true; }, fetchFn: async () => resp(403, { motivo: "SEM_CONCESSAO" }) });
  assert.equal((await t4("/api/fv2/dre")).status, 403);
  assert.equal(renovacoes, 0);
  // segundo fator exigido (401 com MFA) NÃO é sessão expirada: sem renovação
  const t5 = criarTransportePlataforma({ credenciais: base.credenciais, renovar: async () => { renovacoes += 1; return true; }, fetchFn: async () => resp(401, { motivo: "MFA_REQUERIDA" }) });
  assert.equal((await t5("/api/fv2/acoes/x")).status, 401);
  assert.equal(renovacoes, 0);
});

test("transporte: sem token = sessão expirada local (nada é enviado ao servidor)", async () => {
  let enviados = 0;
  const t = criarTransportePlataforma({ credenciais: async () => ({ token: null, contexto: "c" }), fetchFn: async () => { enviados += 1; return resp(200); } });
  const r = await t("/api/fv2/dre");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).motivo, "SESSAO_EXPIRADA");
  assert.equal(enviados, 0);
  assert.equal(traduzirEndereco("/api/fv2/login"), null, "login da demonstração nunca vai à plataforma");
});

// ------------------------------------------------------------------ fontes por unidade
const FONTES_SUBWAY = { sistemaDeLoja: "SWF", fontes: ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"] };
const FONTES_ACAI = { sistemaDeLoja: "SAIPOS", fontes: ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"], plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"] };
const vgDe = (canais) => ({
  competencia: "2026-11", fechamento: { estado: "ABERTA" }, cadaCem: { grupos: [] }, alertas: [],
  faturamentoBruto: { valorCentavos: null, situacao: "SEM_EVIDENCIA", porCanal: canais.map((canal) => ({ canal, valorCentavos: 0, registros: [], comprovado: false, percentualDoBruto: 0 })) },
  faturamentoLiquidoGerencial: { valorCentavos: null, situacao: "SEM_EVIDENCIA", porCanal: [], deducoesCentavos: null },
  resultadoGerencial: { valorCentavos: null, situacao: "SEM_EVIDENCIA" },
});

test("Visão Geral: derivada das fontes — Subway sem SAIPOS/Anota Aí; Açaí preservado", () => {
  const canais = ["BALCAO", "ANOTA_AI", "IFOOD", "NOVENTA_E_NOVE_FOOD"];
  const sub = telas.visaoGeral(vgDe(canais), { unidadeNome: "Subway", fontes: FONTES_SUBWAY });
  assert.ok(!/SAIPOS/.test(sub) && !/Anota A[ií]/i.test(sub), "nenhum SAIPOS/Anota Aí na Subway");
  assert.match(sub, /SWF — Presencial \/ Balcão/);
  assert.match(sub, /href="#\/swf"/, "a composição do Presencial leva ao SWF");
  assert.match(sub, /iFood — fonte oficial/);
  assert.match(sub, /99Food — fonte oficial/);
  const acai = telas.visaoGeral(vgDe(canais), { unidadeNome: "Açaí", fontes: FONTES_ACAI });
  assert.match(acai, /Presencial — SAIPOS/);
  assert.match(acai, /Anota Aí — SAIPOS/);
  assert.match(acai, /href="#\/saipos"/);
  // sem fontes conhecidas (compatibilidade): nada é filtrado
  assert.match(telas.visaoGeral(vgDe(canais), { unidadeNome: "x" }), /Anota Aí — SAIPOS/);
});

test("Visão Geral: canal fora das fontes só aparece se tiver dinheiro (nenhum valor some da tela)", () => {
  const vg = vgDe(["BALCAO", "ANOTA_AI"]);
  vg.faturamentoBruto.porCanal[1] = { canal: "ANOTA_AI", valorCentavos: 12345, registros: [{ id: "x" }], comprovado: true, percentualDoBruto: 100 };
  assert.match(telas.visaoGeral(vg, { fontes: FONTES_SUBWAY }), /Anota Aí/);
});

test("telas puras leem as fontes da unidade ativa (Anota AI e relatórios de outro sistema somem)", async () => {
  const demo = await criarDemo();
  const vendasReais = (await demo.responder("/api/fv2/vendas", { unidade: UNIDADES[0].id, competencia: "2026-09" }, "administrador")).corpo;
  definirFontesDaUnidade(FONTES_SUBWAY);
  try {
    assert.equal(sistemaDeLoja(), "SWF");
    assert.equal(usaAnotaAi(), false);
    assert.equal(relatorioDeOutroSistema({ tipoRelatorio: "SAIPOS_VENDAS", nome: "Vendas por pedido do SAIPOS" }), true);
    assert.equal(relatorioDeOutroSistema({ tipoRelatorio: "SWF_PAGAMENTOS", nome: "SWF 03" }), false);
    assert.equal(relatorioDeOutroSistema({ tipoRelatorio: "STONE_VENDAS", nome: "Vendas da Stone" }), false);
    const lanc = tes.lancamentos({ contas: [{ id: "11111111-1111-4111-8111-111111111111", nome: "Unicred", tipo: "BANCARIA" }], dataBase: "2026-11-15" }, {}, { permissoes: ["financeiro_v2.registrar", "financeiro_v2.ver"] });
    assert.ok(!/Anota A[ií]/i.test(lanc), "Lançamentos sem Anota AI");
    const vendas = ven.vendasERecebimentos(vendasReais, { aba: "vendas" });
    const filtros = (vendas.match(/<select name="(?:canal|processador)">[\s\S]*?<\/select>/g) ?? []).join("");
    assert.ok(filtros.length > 0 && !/Anota A[ií]/i.test(filtros), "filtros de Vendas e Recebimentos sem Anota AI");
  } finally { definirFontesDaUnidade(null); }
  assert.match((ven.vendasERecebimentos(vendasReais, { aba: "vendas" }).match(/<select name="canal">[\s\S]*?<\/select>/) ?? [""])[0], /Anota A[ií]/i, "sem fontes conhecidas (e no Açaí) a opção Anota AI continua");
  assert.equal(usaAnotaAi(), true, "sem fontes conhecidas nada é filtrado");
  definirFontesDaUnidade(FONTES_ACAI);
  try { assert.equal(relatorioDeOutroSistema({ tipoRelatorio: "SWF_PAGAMENTOS" }), true); assert.equal(usaAnotaAi(), true); } finally { definirFontesDaUnidade(null); }
});

test("sessão expirada: o app esvazia o estado financeiro e cancela consultas em voo", () => {
  const app = arquivo("app.js");
  const trecho = app.slice(app.indexOf("function sessaoExpirada"), app.indexOf("function sessaoExpirada") + 1800);
  for (const parte of ["numeroDoCarregamento += 1", "c.cancelar()", "invalidarCache()", "definirFontesDaUnidade(null)", "unidades: []", "fontesDaUnidade: null", "calendario: null", "configuracoes: null", "fecharPainel(false)", 'alvo.innerHTML = ""', "Sessão encerrada"]) assert.ok(trecho.includes(parte), parte);
  assert.match(arquivo("consulta.js"), /cancelar\(\) \{ atual \+= 1; controle\?\.abort\(\)/);
});
