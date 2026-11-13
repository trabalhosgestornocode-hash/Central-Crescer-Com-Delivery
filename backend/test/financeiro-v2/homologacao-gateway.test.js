// Execução 08 — GATEWAY LOCAL DE TESTE como PROCESSO SEPARADO + PostgreSQL isolado + núcleo. Identidades sintéticas,
// senhas geradas na hora (só o hash vai para o arquivo do gateway, fora do repositório). A aplicação só conhece o endereço
// do gateway e a SUA credencial: toda sessão de banco passa pelo gateway.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACAO, CODIGO, criarNucleoFinanceiro, criarRepositorioPostgres } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, UNI_A, UNI_A2, ctx, rejeita } from "./helpers/cenario.js";
import { abrirPool, ambiente, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const GATEWAY = fileURLToPath(new URL("../../scripts/fv2/gatewayTeste.mjs", import.meta.url));
const segredo = (texto) => { const sal = randomBytes(16); return { sal: sal.toString("hex"), hash: scryptSync(texto, sal, 32).toString("hex") }; };
const processos = [];
after(() => { for (const p of processos) p.kill(); });

async function iniciarGateway(identidades, { validadeSegundos = 900 } = {}) {
  const { urlApp, urlAutoridade } = await criarBancoDeTeste(ESCOPOS_PADRAO);
  const pasta = mkdtempSync(join(tmpdir(), "fv2-gateway-"));
  const senhas = Object.fromEntries(identidades.map((i) => [i.login, { senha: randomBytes(12).toString("hex"), fator: randomBytes(4).toString("hex") }]));
  const config = {
    urlAutoridade, marcador: ambiente().marcador, arquivoDeEventos: join(pasta, "eventos.jsonl"), validadeSegundos,
    identidades: identidades.map((i) => ({ ...i, senha: segredo(senhas[i.login].senha), segundoFator: i.mfa ? segredo(senhas[i.login].fator) : null })),
  };
  writeFileSync(join(pasta, "gateway.json"), JSON.stringify(config), { mode: 0o600 });
  const p = spawn(process.execPath, [GATEWAY, join(pasta, "gateway.json")], { stdio: ["ignore", "pipe", "inherit"] });
  processos.push(p);
  const porta = await new Promise((ok, falha) => {
    p.stdout.on("data", (d) => { const m = /GATEWAY PRONTO (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); });
    p.once("exit", (c) => falha(new Error(`gateway saiu: ${c}`)));
  });
  const url = `http://127.0.0.1:${porta}`;
  const chamar = async (rota, corpo, token) => {
    const r = await fetch(url + rota, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(corpo ?? {}) });
    return { status: r.status, corpo: await r.json() };
  };
  const login = async (login, { comFator = true } = {}) => (await chamar("/login", { login, senha: senhas[login].senha, segundoFator: comFator ? senhas[login].fator : undefined })).corpo;
  // Lado da APLICAÇÃO: só a credencial da aplicação + o token do usuário no gateway.
  const pool = await abrirPool(urlApp);
  const repositorioDe = (sessao) => criarRepositorioPostgres({
    pool,
    sessoes: {
      async emitir(e) {
        if (e.usuarioId !== sessao.usuarioId) throw Object.assign(new Error("usuário diferente da sessão"), { code: "FV020" });
        const r = await chamar("/sessao-banco", { unidadeId: e.unidadeId }, sessao.token);
        if (r.status !== 200) throw Object.assign(new Error(r.corpo.erro), { code: r.corpo.sqlstate ?? "FV020" });
        return r.corpo.token;
      },
      async emitirProvisionamento(ato) {
        const r = await chamar("/provisionamento", { usuarioId: ato.usuarioId, unidadeId: ato.unidadeId, acoes: ato.acoes, justificativa: ato.justificativa, evidencia: ato.evidencia }, sessao.token);
        if (r.status !== 200) throw Object.assign(new Error(r.corpo.erro), { code: "FV021" });
        return r.corpo.token;
      },
    },
  });
  const nucleoDe = (sessao, extra = {}) => criarNucleoFinanceiro({ repositorio: repositorioDe(sessao), escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, ...extra });
  const eventos = () => readFileSync(config.arquivoDeEventos, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { chamar, login, nucleoDe, eventos, urlApp };
}

const ID = { plataforma: randomUUID(), admin: randomUUID(), gestor: randomUUID(), operador: randomUUID(), forasteiro: randomUUID() };
const IDENTIDADES = [
  { login: "admin-plataforma", usuarioId: ID.plataforma, organizacaoId: ORG_A, unidades: [UNI_A, UNI_A2], administradorDaPlataforma: true, mfa: true },
  { login: "admin-financeiro", usuarioId: ID.admin, organizacaoId: ORG_A, unidades: [UNI_A], mfa: true },
  { login: "gestor", usuarioId: ID.gestor, organizacaoId: ORG_A, unidades: [UNI_A] },
  { login: "operador", usuarioId: ID.operador, organizacaoId: ORG_A, unidades: [UNI_A, UNI_A2] },
  { login: "forasteiro", usuarioId: ID.forasteiro, organizacaoId: ORG_A, unidades: [UNI_A2] },
];

test("08 — gateway separado: provisionamento com MFA, perfis, unidade não permitida, revogação, logout, token falso e sessão expirada", pular, async () => {
  const g = await iniciarGateway(IDENTIDADES, { validadeSegundos: 900 });
  // Atestante SEM MFA (aal1): o gateway repassa o nível e o BANCO recusa.
  const platSemMfa = await g.login("admin-plataforma", { comFator: false });
  assert.equal(platSemMfa.aal, "aal1");
  const atoA = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: ID.admin, acoes: Object.values(ACAO), justificativa: "Administrador financeiro sintético.", evidencia: "Ato sintético 08", atestado: "gateway" };
  const autoridadeDe = (s) => ({ verificar: async () => ({ ok: true, autoridadeId: s.usuarioId, nivelAutenticacao: "aal2" }) }); // núcleo confia; o BANCO confere o aal real
  await rejeita(g.nucleoDe(platSemMfa, { autoridadeDeProvisionamento: autoridadeDe(platSemMfa) }).provisionarAdministradorInicial(atoA), CODIGO.PROVISIONAMENTO_RECUSADO);
  // Com MFA: provisiona; o atestante não ganha acesso.
  const plat = await g.login("admin-plataforma");
  assert.equal(plat.aal, "aal2");
  await g.nucleoDe(plat, { autoridadeDeProvisionamento: autoridadeDe(plat) }).provisionarAdministradorInicial(atoA);
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A }, plat.token)).corpo.erro, "SEM_CONCESSAO");
  // Quem não é administrador da plataforma não atesta.
  const adm = await g.login("admin-financeiro");
  assert.equal((await g.chamar("/provisionamento", { unidadeId: UNI_A2, usuarioId: ID.operador, acoes: [ACAO.VER], justificativa: "x", evidencia: "y" }, adm.token)).status, 403);

  // Administrador financeiro concede gestor (só ver) e operador (ver + registrar) em A.
  const nAdm = g.nucleoDe(adm);
  const cAdm = ctx(ORG_A, UNI_A, Object.values(ACAO), ID.admin);
  await nAdm.concederAcesso(cAdm, { usuarioId: ID.gestor, acoes: [ACAO.VER], justificativa: "Gestor somente leitura." });
  await nAdm.concederAcesso(cAdm, { usuarioId: ID.operador, acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Operador." });
  await nAdm.configurarContaFinanceira(cAdm, { tipo: "BANCARIA", nome: "Banco sintético" }).catch(() => {});

  const gestor = await g.login("gestor");
  const nGestor = g.nucleoDe(gestor);
  assert.ok(Array.isArray(await nGestor.consultarRegistros(ctx(ORG_A, UNI_A, [ACAO.VER], ID.gestor), { tipo: "CONTA" })));
  await rejeita(nGestor.registrarContraparte(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR], ID.gestor), { tipo: "FORNECEDOR", nome: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);

  const op = await g.login("operador");
  const nOp = g.nucleoDe(op);
  const cOp = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR], ID.operador);
  assert.equal((await nOp.registrarContraparte(cOp, { tipo: "FORNECEDOR", nome: "Fornecedor do operador" })).nome, "Fornecedor do operador");
  // Unidade permitida no gateway (A2) mas SEM concessão: o banco recusa. Unidade não permitida (forasteiro em A): o gateway recusa.
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A2 }, op.token)).corpo.erro, "SEM_CONCESSAO");
  const fora = await g.login("forasteiro");
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A }, fora.token)).corpo.erro, "UNIDADE_NAO_PERMITIDA");
  // Revogação: a próxima ação do operador já é recusada.
  await nAdm.revogarAcesso(cAdm, { usuarioId: ID.operador, justificativa: "Desligamento sintético." });
  await rejeita(nOp.registrarContraparte(cOp, { tipo: "FORNECEDOR", nome: "Depois" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Token falsificado e logout.
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A }, randomBytes(32).toString("base64url"))).status, 401);
  assert.equal((await g.chamar("/logout", {}, gestor.token)).status, 200);
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A }, gestor.token)).status, 401);
  await rejeita(nGestor.consultarRegistros(ctx(ORG_A, UNI_A, [ACAO.VER], ID.gestor), { tipo: "CONTA" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Trilha: eventos de login, emissões, provisionamento e recusas registrados.
  const tipos = new Set(g.eventos().map((e) => e.tipo));
  for (const t of ["LOGIN", "SESSAO_BANCO", "PROVISIONAMENTO", "PROVISIONAMENTO_RECUSADO", "SESSAO_BANCO_RECUSADA", "LOGOUT"]) assert.ok(tipos.has(t), t);
  assert.ok(!JSON.stringify(g.eventos()).match(/"token"|senha/), "eventos sem token nem senha");
});

test("08 — sessão do gateway EXPIRADA não obtém sessão de banco", pular, async () => {
  const g = await iniciarGateway(IDENTIDADES, { validadeSegundos: 2 });
  const s = await g.login("gestor");
  await new Promise((ok) => { setTimeout(ok, 2500); });
  assert.equal((await g.chamar("/sessao-banco", { unidadeId: UNI_A }, s.token)).status, 401);
});
