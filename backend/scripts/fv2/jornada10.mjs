#!/usr/bin/env node
// JORNADA NO NAVEGADOR da Execução 10 — interface REAL do Financeiro v2 em MODO PLATAFORMA → rotas /api/v1/financeiro-v2
// → adaptador → GATEWAY (em processo, canal assinado) → PostgreSQL ISOLADO (schema dedicado). Dados e identidades
// SINTÉTICOS, só 127.0.0.1.
//
//   node scripts/fv2/jornada10.mjs [--ver]
//
// A "plataforma" é simulada só no que ela entrega ao v2 (requireAuth + requireContexto): token de acesso (HS256 de TESTE)
// e contexto (pessoa, empresa, unidade). No navegador, apenas os módulos de credencial da Crescer (../src/supabaseClient.js,
// ../src/sessao.js) e o script do Supabase são substituídos por versões sintéticas via interceptação do Playwright — o
// código de produção não tem gancho de teste.
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { ACAO, alterarLiberacaoPostgres, criarAdaptadorDaPlataforma, criarLiberacoesPostgres, criarNucleoFinanceiro, criarRepositorioPostgres, verificadorHs256 } from "../../src/modules/financeiro-v2/index.js";
import { criarRotasFinanceiroV2 } from "../../src/modules/fv2-integracao/rotas.js";
import { criarClienteDoGateway } from "../../src/modules/fv2-integracao/clienteGateway.js";
import { criarConcessoesDaSessao } from "../../src/modules/fv2-integracao/portasPlataforma.js";
import { criarMfaPeloProvedor } from "../../src/modules/fv2-integracao/mfaPeloProvedor.js";
import { criarGateway } from "../../src/fv2-gateway/gateway.js";
import { abrirPoolSeguro, fixarSearchPathDoBanco, lerAmbiente, urlDoBanco } from "./ambiente.mjs";

const aqui = resolve(fileURLToPath(new URL(".", import.meta.url)));
const FRONTEND = resolve(aqui, "..", "..", "..", "frontend");
const SAIDA = process.env.FV2_JORNADA_SAIDA || join(tmpdir(), "fv2-jornada10");
mkdirSync(SAIDA, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT || join(process.env.APPDATA || "", "npm", "node_modules", "@playwright", "cli", "node_modules", "playwright-core"));

const SEGREDO = `jornada10-${randomBytes(16).toString("hex")}`; // "provedor" sintético desta execução
const CHAVE = randomBytes(32).toString("hex");
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const UNI = "aaaaaaaa-0000-4000-8000-0000000000a1";
const UNI2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const P = { // pessoa → conta
  gestora: { pessoa: "dddddddd-0000-4000-8000-0000000000a1", conta: "dddddddd-0000-4000-8000-0000000000c1", nome: "Gestora Sintética" },
  semAcesso: { pessoa: "dddddddd-0000-4000-8000-0000000000a2", conta: "dddddddd-0000-4000-8000-0000000000c2", nome: "Sem Acesso Sintético" },
  nova: { pessoa: "dddddddd-0000-4000-8000-0000000000a3", conta: "dddddddd-0000-4000-8000-0000000000c3", nome: "Pessoa Nova Sintética" },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => { const c = b64({ alg: "HS256", typ: "JWT" }); const d = b64(p); return `${c}.${d}.${createHmac("sha256", SEGREDO).update(`${c}.${d}`).digest("base64url")}`; };
const tokenDe = (conta, { expEmS = 3600 } = {}) => { const s = Math.floor(Date.now() / 1000); return jwt({ sub: conta, aal: "aal2", amr: [{ method: "password", timestamp: s - 600 }, { method: "totp", timestamp: s - 60 }], iat: s - 30, exp: s + expEmS, session_id: "sintetica" }); };
const provedor = verificadorHs256(SEGREDO);
const obterUsuario = async (t) => { const p = provedor(t); return p && p.exp * 1000 > Date.now() ? { id: p.sub } : null; };

const registro = [];
const passo = (n, texto, dados = {}) => { registro.push({ n, texto, ...dados }); process.stdout.write(`[${n}] ${texto}${Object.keys(dados).length ? ` ${JSON.stringify(dados)}` : ""}\n`); };
const exigir = (cond, msg) => { if (!cond) throw new Error(`FALHOU: ${msg}`); };

// ------------------------------------------------------------------------------------------- banco isolado
const amb = lerAmbiente();
if (!amb?.bancoModelo) throw new Error("Ambiente isolado indisponível: rode `node scripts/fv2-banco-teste.mjs iniciar`.");
const banco = `fv2_teste_jornada10_${randomBytes(4).toString("hex")}`;
const controle = await abrirPoolSeguro(amb.urlAdmin, amb.marcador, { max: 1 });
await controle.query(`create database ${banco} template ${amb.bancoModelo}`);
await controle.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${amb.marcador}'`);
await fixarSearchPathDoBanco(controle, banco);
await controle.end();
const admin = await abrirPoolSeguro(urlDoBanco(amb.urlAdmin, banco), amb.marcador, { max: 1 });
for (const u of [UNI, UNI2]) await admin.query("insert into fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, 'Escopo sintético da jornada 10')", [ORG, u]);
const poolApp = await abrirPoolSeguro(urlDoBanco(amb.urlApp, banco), amb.marcador, { max: 4 });
const poolAut = await abrirPoolSeguro(urlDoBanco(amb.urlAutoridade, banco), amb.marcador, { max: 2 });
/** Concessão INICIAL sintética (fixture do ambiente isolado, gravada pelo dono do banco — como o provisionamento faria). */
async function conceder(pessoa, acoes) {
  await admin.query(`with nova as (insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
      values (gen_random_uuid(), $1::uuid, $2::uuid, 1, now(), $4::uuid, now(), $4::uuid, 'concessao:' || $3, null, '{}'::jsonb, $3::uuid, $5::jsonb, 'ATIVA', $4::uuid, 'Fixture da jornada 10 (sintética).') returning *)
    insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
    select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', 1, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova`,
  [ORG, UNI, pessoa, "f1f1f1f1-0000-4000-8000-0000000000f1", JSON.stringify(acoes)]);
}
await conceder(P.gestora.pessoa, Object.values(ACAO));
await conceder(P.nova.pessoa, [ACAO.VER]);
const semente = criarRepositorioPostgres({ pool: poolApp, sessoes: { emitir: async (e) => (await poolAut.query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, 3600, 'jornada10') as t", [e.usuarioId, e.organizacaoId, e.unidadeId])).rows[0].t } });
const n0 = criarNucleoFinanceiro({ repositorio: semente, escoposAutorizados: [{ organizacaoId: ORG, unidadeId: UNI }], exigirConcessaoPersistida: true });
const c0 = { organizacaoId: ORG, unidadeId: UNI, usuarioId: P.gestora.pessoa, permissoes: Object.values(ACAO) };
const mes = new Date().toISOString().slice(0, 7);
await n0.implantarPlanoDeContas(c0, { modelo: "ACAITERIA" });
const conta = await n0.configurarContaFinanceira(c0, { tipo: "BANCARIA", nome: "Banco Sintético da Jornada" });
await n0.registrarSaldoDeConta(c0, { contaId: conta.id, data: `${mes}-01`, valorCentavos: 250000 });
const forn = await n0.registrarContraparte(c0, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético da Jornada" });
await n0.registrarObrigacao(c0, { contraparteId: forn.id, valorOriginalCentavos: 45678, categoria: "INSUMOS", descricao: "Insumos sintéticos da jornada", competencia: mes, dataEmissao: `${mes}-02`, vencimento: `${mes}-25` });
const prova = { ok: true, contaId: "dddddddd-0000-4000-8000-0000000000c9", segundoFatorEm: Date.now() - 60_000 };
for (const unidadeId of [null, UNI]) await alterarLiberacaoPostgres(poolAut, { organizacaoId: ORG, unidadeId, ativa: true, atorContaId: prova.contaId, justificativa: "Liberação sintética da jornada 10 (só a unidade 1).", provaDeSegundoFator: prova });

// --------------------------------------------------------------------------------- gateway + "plataforma"
const mfa = criarMfaPeloProvedor({ obterUsuario });
const gateway = createServer(criarGateway({ poolAutoridade: poolAut, chave: CHAVE, obterUsuario, mfa }));
await new Promise((ok) => { gateway.listen(0, "127.0.0.1", ok); });
const repositorio = criarRepositorioPostgres({ pool: poolApp, sessoes: criarClienteDoGateway({ url: `http://127.0.0.1:${gateway.address().port}`, chave: CHAVE }) });
const PESSOAS = Object.values(P);
const vinculos = {
  contaDoPerfil: async ({ perfilId }) => PESSOAS.find((x) => x.pessoa === perfilId)?.conta ?? null,
  perfisAtivosDaConta: async ({ contaId }) => PESSOAS.filter((x) => x.conta === contaId).length,
  unidadesDoPerfil: async () => [UNI, UNI2],
  nomesDosPerfis: async ({ perfilIds }) => new Map(perfilIds.map((id) => [id, PESSOAS.find((x) => x.pessoa === id)?.nome ?? null])),
};
const adaptador = criarAdaptadorDaPlataforma({ liberacoes: criarLiberacoesPostgres({ poolApp }), vinculos, concessoes: criarConcessoesDaSessao({ repositorio }), mfa });
const CONTEXTOS = { // x-context-token sintético → sessão de contexto
  "ctx-gestora": { quem: P.gestora, unidade: UNI }, "ctx-sem": { quem: P.semAcesso, unidade: UNI }, "ctx-gestora-u2": { quem: P.gestora, unidade: UNI2 }, "ctx-nova": { quem: P.nova, unidade: UNI },
};
const app = express();
app.use("/api/v1", express.json(), (req, res, next) => { // requireAuth + requireContexto (simulados)
  const t = (req.header("authorization") || "").replace(/^Bearer /, "");
  const p = provedor(t);
  if (!p || p.exp * 1000 <= Date.now()) return res.status(401).json({ erro: "SESSAO_EXPIRADA", mensagem: "Sessão expirada." });
  const ctx = CONTEXTOS[req.header("x-context-token")];
  if (!ctx || ctx.quem.conta !== p.sub) return res.status(409).json({ erro: "CONTEXTO_INVALIDO", mensagem: "Contexto inválido." });
  req.user = { id: p.sub, nome: ctx.quem.nome, ativo: true, senhaProvisoria: false, aal: "aal2" };
  req.tenant = { organizacaoId: ORG, unidadeId: ctx.unidade };
  req.acesso = { sessionId: `s-${ctx.quem.pessoa}-${ctx.unidade}`, expiraEm: new Date(Date.now() + 3600_000).toISOString(), perfilId: ctx.quem.pessoa, papel: "finance", impersonando: false, impersonadoPor: null, empresa: { id: ORG }, unidade: { id: ctx.unidade, nome: ctx.unidade === UNI ? "Açaí Sintético (unidade 1)" : "Unidade Sintética 2" } };
  return next();
});
app.use("/api/v1/financeiro-v2", criarRotasFinanceiroV2({ habilitado: true, escritaHabilitada: true, dependencias: () => ({ repositorio, adaptador, vinculos }) }));
app.use(express.static(FRONTEND));
const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const ORIGEM = `http://127.0.0.1:${servidor.address().port}`;

// ------------------------------------------------------------------------------------------------ navegador
const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
const executablePath = [process.env.FV2_CHROMIUM, join(base, "chromium_headless_shell-1248", "chrome-headless-shell-win64", "chrome-headless-shell.exe"), join(base, "chromium-1248", "chrome-win64", "chrome.exe")].filter(Boolean).find((c) => existsSync(c));
const navegador = await chromium.launch({ headless: !process.argv.includes("--ver"), ...(executablePath ? { executablePath } : {}) });
const erros = [];
async function abrir(ctxToken, token, rota = "visao-geral") {
  const pagina = await navegador.newPage({ viewport: { width: 1280, height: 900 } });
  pagina.on("pageerror", (e) => erros.push(String(e)));
  await pagina.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ contentType: "application/javascript", body: "window.supabase = {};" }));
  await pagina.route("**/src/supabaseClient.js", (r) => r.fulfill({ contentType: "application/javascript", body: `export async function tokenAtual() { return ${JSON.stringify(token)}; }` }));
  await pagina.route("**/src/sessao.js", (r) => r.fulfill({ contentType: "application/javascript", body: `export function contextTokenAtual() { return ${JSON.stringify(ctxToken)}; }` }));
  await pagina.goto(`${ORIGEM}/financeiro-v2/?modo=plataforma#/${rota}`);
  await pagina.waitForFunction(() => !document.querySelector("#conteudo")?.getAttribute("aria-busy"), null, { timeout: 15000 });
  return pagina;
}
const texto = (p) => p.locator("#conteudo").innerText();
const foto = (p, nome) => p.screenshot({ path: join(SAIDA, `${nome}.png`), fullPage: true });
let falhou = null;
try {
  const tk = tokenDe(P.gestora.conta);
  const p1 = await abrir("ctx-gestora", tk);
  const t1 = await texto(p1);
  exigir(/Visão Geral/.test(t1), "Visão Geral carregada");
  exigir(await p1.locator("#filtro-sessao").isHidden(), "seletor de sessão da demonstração escondido");
  exigir((await p1.locator("#filtro-competencia").inputValue()) === mes, "competência inicial = mês da data-base do servidor");
  exigir(/Gestora Sintética/.test(await p1.locator("body").innerText()), "usuário da plataforma exibido");
  exigir(await p1.locator(".faixa-demo").isHidden(), "faixa da demonstração escondida no modo plataforma");
  passo(1, "Visão Geral pelo login da plataforma (sem login financeiro), unidade e competência da sessão");
  await foto(p1, "01-visao-geral");
  for (const [n, rota, padrao] of [[2, "caixa-e-bancos", /Banco Sintético da Jornada/], [3, "contas-a-pagar", /Insumos sintéticos da jornada/], [4, "dre", /DRE/], [5, "vendas-e-recebimentos", /Vendas/], [6, "conferencias", /Confer/], [7, "configuracoes", /Configura/], [8, "fluxo-de-caixa", /Fluxo/]]) {
    await p1.goto(`${ORIGEM}/financeiro-v2/?modo=plataforma#/${rota}`);
    await p1.waitForFunction(() => !document.querySelector("#conteudo")?.getAttribute("aria-busy"), null, { timeout: 15000 });
    const t = await texto(p1);
    exigir(padrao.test(t), `${rota}: ${t.slice(0, 160)}`);
    exigir(!/Não foi possível carregar|Acesso negado/.test(t), `${rota} sem erro`);
    passo(n, `${rota} carregada da API real`);
    await foto(p1, `0${n}-${rota}`);
  }
  // escrita pela tela: registrar conta a pagar (operação comum; sem 2º fator)
  await p1.goto(`${ORIGEM}/financeiro-v2/?modo=plataforma#/contas-a-pagar`);
  await p1.waitForFunction(() => !document.querySelector("#conteudo")?.getAttribute("aria-busy"), null, { timeout: 15000 });
  const form = p1.locator('form[data-acao$="obrigacoes/registrar"]');
  if (await form.count()) {
    const abrirForm = p1.locator("summary, button", { hasText: /Registrar conta/i }).first();
    if (await abrirForm.count()) await abrirForm.click().catch(() => {});
    await form.locator('[name="fornecedorNovo"]').fill("Fornecedor Sintético pela Tela").catch(() => {});
    await form.locator('[name="descricao"]').fill("Conta sintética registrada pela tela");
    await form.locator('[name="valor"]').fill("321,09");
    const cat = form.locator('[name="categoria"]');
    if ((await cat.evaluate((e) => e.tagName)) === "SELECT") await cat.selectOption({ index: 1 }); else await cat.fill("INSUMOS");
    await form.locator('[name="competencia"]').fill(mes).catch(() => {});
    await form.locator('[name="dataEmissao"]').fill(`${mes}-03`);
    await form.locator('[name="vencimento"]').fill(`${mes}-28`);
    await form.locator('[name="confirmar"]').check().catch(() => {});
    await form.locator('button[type="submit"]').click();
    await p1.waitForTimeout(1500);
    const { rows } = await admin.query("select count(*)::int n from fv2_obrigacao where descricao = 'Conta sintética registrada pela tela'");
    exigir(rows[0].n === 1, "conta registrada pela tela gravada no banco (uma vez)");
    passo(9, "conta a pagar registrada PELA TELA, gravada no PostgreSQL pelo gateway (sem duplicar)");
    await foto(p1, "09-registrar-conta");
  } else passo(9, "formulário de registro não encontrado na tela (NÃO TESTADO)");
  // recusas
  const p2 = await abrir("ctx-sem", tokenDe(P.semAcesso.conta));
  exigir(/não tem permissão/.test(await texto(p2)), "pessoa sem concessão vê acesso negado");
  passo(10, "pessoa sem concessão: acesso negado, nenhum dado");
  await foto(p2, "10-sem-concessao");
  const p3 = await abrir("ctx-gestora-u2", tk);
  exigir(/não está liberado/.test(await texto(p3)), "unidade não liberada");
  passo(11, "troca para unidade NÃO liberada: o v2 não abre (nenhum dado da unidade 1 aparece)");
  exigir(!/Banco Sintético da Jornada/.test(await texto(p3)), "sem vazamento entre unidades");
  const p4 = await abrir("ctx-gestora", tokenDe(P.gestora.conta, { expEmS: -10 }));
  exigir(/sessão expirou/i.test(await texto(p4)), "sessão expirada");
  passo(12, "sessão expirada: pede novo login pela plataforma, nada gravado");
  gateway.close();
  gateway.closeAllConnections?.();
  const p5 = await abrir("ctx-nova", tokenDe(P.nova.conta));
  const t5 = await texto(p5);
  exigir(/indisponível|Não foi possível/.test(t5) && !/Banco Sintético/.test(t5), `gateway fora do ar: ${t5.slice(0, 200)}`);
  passo(13, "gateway fora do ar: tela de indisponibilidade, nenhum dado sintético no lugar");
  await foto(p5, "13-gateway-indisponivel");
  exigir(erros.length === 0, `erros de JavaScript na página: ${erros.join(" | ")}`);
  passo(14, "nenhum erro de JavaScript nas páginas");
} catch (e) {
  falhou = e;
  process.stdout.write(`${e.message}\n`);
} finally {
  writeFileSync(join(SAIDA, "registro.json"), JSON.stringify(registro, null, 2));
  await navegador.close();
  servidor.close();
  gateway.close();
  await Promise.allSettled([poolApp.end(), poolAut.end(), admin.end()]);
  const ctl = await abrirPoolSeguro(amb.urlAdmin, amb.marcador, { max: 1 });
  await ctl.query(`drop database if exists ${banco} with (force)`).catch(() => {});
  await ctl.end();
}
process.stdout.write(`${falhou ? "JORNADA FALHOU" : "JORNADA OK"} — ${registro.length} passos; capturas em ${SAIDA}\n`);
process.exit(falhou ? 1 : 0);
