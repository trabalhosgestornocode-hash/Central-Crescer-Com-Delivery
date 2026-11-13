#!/usr/bin/env node
// HOMOLOGAÇÃO FULL STACK do Financeiro v2 (Execução 08B) — navegador → serviço da aplicação → gateway → PostgreSQL isolado,
// com cofre em disco. SOMENTE dados e identidades SINTÉTICOS, SOMENTE 127.0.0.1, credenciais FORA do repositório.
//
//   node scripts/fv2-homologacao.mjs preparar   cria o banco da homologação (a partir do banco-modelo do ambiente isolado),
//                                               as identidades sintéticas, os arquivos de credenciais e a carga sintética
//   node scripts/fv2-homologacao.mjs iniciar    sobe o gateway (processo separado) e o serviço da aplicação
//
// Separação de credenciais:
//   - `gateway.json` (credencial da AUTORIDADE + hashes das senhas) é lido SÓ pelo processo do gateway;
//   - `aplicacao.json` (credencial da APLICAÇÃO) é lido SÓ por este serviço; ele nunca abre o gateway.json;
//   - `credenciais-sinteticas.txt` (senhas sintéticas em claro, para quem testa) não é lido por nenhum serviço.
// LIMITE: os processos rodam no mesmo usuário do Windows e poderiam ler os arquivos uns dos outros. Isto homologa
// CONTRATOS, não equivale ao isolamento de produção.
//
// A CARGA (preparar) faz o papel de um DBA carregando dados sintéticos: usa a autoridade de TESTE com uma fixture que grava
// concessões das identidades de carga — exceto `conceder`/`revogar`, que só existem pelo provisionamento atestado.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as m from "../src/modules/financeiro-v2/index.js";
import { abrirPoolSeguro, lerAmbiente, urlDoBanco } from "./fv2/ambiente.mjs";
import { ORG, UNIDADES, USUARIOS, criarDemo, pdfSintetico } from "./fv2/demoInterface.mjs";

const PASTA_HOMOLOGACAO = process.env.FV2_HOMOLOGACAO_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "fv2-homologacao");
const PASTA_FRONT = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "financeiro-v2"));
const GATEWAY = fileURLToPath(new URL("./fv2/gatewayTeste.mjs", import.meta.url));
const RELOGIO = () => new Date("2026-11-12T15:00:00Z"); // data-base da demonstração sintética
const PORTA_APP = Number(process.env.FV2_HOMOLOGACAO_PORTA || 5181);
const PORTA_GATEWAY = PORTA_APP + 1;
const escopos = UNIDADES.map((u) => ({ organizacaoId: ORG, unidadeId: u.id }));
const dizer = (...x) => process.stdout.write(`${x.join(" ")}\n`);
const segredo = (texto) => { const sal = randomBytes(16); return { sal: sal.toString("hex"), hash: scryptSync(texto, sal, 32).toString("hex") }; };

async function preparar() {
  const a = lerAmbiente();
  if (!a?.bancoModelo || !a.urlAutoridade) throw new Error("Ambiente isolado indisponível: rode `node scripts/fv2-banco-teste.mjs iniciar`.");
  mkdirSync(PASTA_HOMOLOGACAO, { recursive: true });
  writeFileSync(join(PASTA_HOMOLOGACAO, "FV2_HOMOLOGACAO_SINTETICA"), "Homologação local do Financeiro v2. Dados e identidades sintéticos. Pode ser apagada.\n");
  const banco = `fv2_teste_homologacao_${randomBytes(4).toString("hex")}`; // a guarda de destino só aceita bancos de teste
  const controle = await abrirPoolSeguro(a.urlAdmin, a.marcador, { max: 1 });
  await controle.query(`create database ${banco} template ${a.bancoModelo}`);
  await controle.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  await controle.end();
  const dono = await abrirPoolSeguro(urlDoBanco(a.urlAdmin, banco), a.marcador, { max: 1 });
  for (const e of escopos) await dono.query("insert into fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, 'Unidade sintética de homologação')", [e.organizacaoId, e.unidadeId]);
  await dono.end();

  // Identidades sintéticas (mesmos ids da demonstração) + aprovador e aplicador separados.
  const [u1, u2] = UNIDADES.map((u) => u.id);
  const identidades = [
    { login: "gestor", usuarioId: USUARIOS.gestor, unidades: [u1, u2] },
    { login: "operador", usuarioId: USUARIOS.operador, unidades: [u1, u2] },
    { login: "administrador", usuarioId: USUARIOS.administrador, unidades: [u1, u2], mfa: true },
    { login: "sem-acesso", usuarioId: USUARIOS.leitor, unidades: [u1] },
    { login: "aprovador", usuarioId: randomUUID(), unidades: [u1] },
    { login: "aplicador", usuarioId: randomUUID(), unidades: [u1] },
  ];
  const senhas = Object.fromEntries(identidades.map((i) => [i.login, { senha: randomBytes(9).toString("base64url"), fator: i.mfa ? String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)) : null }]));
  const gatewayJson = {
    urlAutoridade: urlDoBanco(a.urlAutoridade, banco), marcador: a.marcador, porta: PORTA_GATEWAY, validadeSegundos: 900,
    arquivoDeEventos: join(PASTA_HOMOLOGACAO, "eventos-gateway.jsonl"),
    identidades: identidades.map((i) => ({ ...i, organizacaoId: ORG, senha: segredo(senhas[i.login].senha), segundoFator: i.mfa ? segredo(senhas[i.login].fator) : null })),
  };
  writeFileSync(join(PASTA_HOMOLOGACAO, "gateway.json"), JSON.stringify(gatewayJson, null, 2), { mode: 0o600 });
  writeFileSync(join(PASTA_HOMOLOGACAO, "aplicacao.json"), JSON.stringify({ urlApp: urlDoBanco(a.urlApp, banco), marcador: a.marcador, gateway: `http://127.0.0.1:${PORTA_GATEWAY}`, cofre: join(PASTA_HOMOLOGACAO, "cofre"), banco }, null, 2), { mode: 0o600 });
  writeFileSync(join(PASTA_HOMOLOGACAO, "credenciais-sinteticas.txt"), ["CREDENCIAIS SINTÉTICAS da homologação local (não são de pessoas reais; não versionar).", ...identidades.map((i) => `${i.login}\tsenha: ${senhas[i.login].senha}${senhas[i.login].fator ? `\tsegundo fator: ${senhas[i.login].fator}` : ""}`), ""].join("\n"), { mode: 0o600 });

  // Carga sintética pelo núcleo (como um DBA): autoridade de TESTE, fixture SEM conceder/revogar.
  const { criarAutoridadeDeTeste } = await import("../test/financeiro-v2/helpers/postgres.js");
  const autoridadeDeCarga = criarAutoridadeDeTeste({ urlAutoridade: gatewayJson.urlAutoridade, urlAdmin: urlDoBanco(a.urlAdmin, banco) });
  const sessoes = {
    emitir: (e) => autoridadeDeCarga.emitir({ ...e, permissoes: (e.permissoes ?? []).filter((x) => x !== m.ACAO.CONCEDER && x !== m.ACAO.REVOGAR) }),
    emitirProvisionamento: (ato) => autoridadeDeCarga.emitirProvisionamento(ato),
  };
  const repositorio = m.criarRepositorioPostgres({ pool: await abrirPoolSeguro(urlDoBanco(a.urlApp, banco), a.marcador, { max: 4 }), sessoes });
  const cofre = m.criarCofreDisco({ raiz: join(PASTA_HOMOLOGACAO, "cofre") });
  await criarDemo({ repositorio, cofre, carregar: true, relogio: RELOGIO });
  const n = m.criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio: RELOGIO, cofre, exigirConcessaoPersistida: true });
  const adm = { organizacaoId: ORG, unidadeId: u1, usuarioId: USUARIOS.administrador, permissoes: Object.values(m.ACAO) };
  const id = (login) => identidades.find((i) => i.login === login).usuarioId;
  await n.concederAcesso(adm, { usuarioId: id("aprovador"), acoes: [m.ACAO.VER, m.ACAO.APROVAR], justificativa: "Aprovador de propostas (homologação sintética)." });
  await n.concederAcesso(adm, { usuarioId: id("aplicador"), acoes: [m.ACAO.VER, m.ACAO.APLICAR, m.ACAO.REGISTRAR], justificativa: "Aplicador de propostas (homologação sintética)." });
  // 08C: evidência SINTÉTICA de outubro no cofre (registrada antes da jornada; a jornada só a vincula pela tela).
  const g = await cofre.guardar(adm, { conteudo: pdfSintetico("Relatorio sintetico do canal - outubro - financiador dos descontos: loja"), tipoMime: "application/pdf" });
  await n.registrarDocumento(adm, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "DEMONSTRATIVO_REPASSE", recebidoEm: "2026-11-05", competencia: "2026-10", descricao: "Relatório do canal de outubro (sintético)" });
  dizer(`Homologação preparada em ${PASTA_HOMOLOGACAO} (banco ${banco}). Credenciais SINTÉTICAS em credenciais-sinteticas.txt.`);
  process.exit(0);
}

async function iniciar() {
  const cfg = JSON.parse(readFileSync(join(PASTA_HOMOLOGACAO, "aplicacao.json"), "utf8")); // só a credencial da APLICAÇÃO
  // Gateway: processo SEPARADO; este serviço só passa o caminho do arquivo dele, nunca o lê.
  const gw = spawn(process.execPath, [GATEWAY, join(PASTA_HOMOLOGACAO, "gateway.json")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, falha) => { gw.stdout.on("data", (d) => { if (/GATEWAY PRONTO/.test(String(d))) ok(); }); gw.once("exit", (c) => falha(new Error(`gateway saiu (${c})`))); });
  const chamarGateway = async (rota, corpo, token) => {
    const r = await fetch(cfg.gateway + rota, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(corpo ?? {}) });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };
  const sessoesDoServidor = new Map(); // sid (cookie HttpOnly) → sessão autenticada no gateway
  const viva = (s) => s && s.expiraEm > Date.now();
  const sessoes = {
    async emitir(e) {
      const s = [...sessoesDoServidor.values()].find((x) => viva(x) && x.usuarioId === e.usuarioId);
      if (!s) throw Object.assign(new Error("Sem sessão autenticada deste usuário."), { code: "FV020" });
      const r = await chamarGateway("/sessao-banco", { unidadeId: e.unidadeId }, s.gatewayToken);
      if (r.status !== 200) throw Object.assign(new Error(r.corpo.erro ?? "recusada"), { code: r.corpo.sqlstate ?? "FV020" });
      return r.corpo.token;
    },
  };
  const repositorio = m.criarRepositorioPostgres({ pool: await abrirPoolSeguro(cfg.urlApp, cfg.marcador, { max: 8 }), sessoes, reusoDoTokenMs: 60000 });
  const demo = await criarDemo({
    repositorio, cofre: m.criarCofreDisco({ raiz: cfg.cofre }), carregar: false, relogio: RELOGIO,
    sessaoDoPedido: (sid) => {
      const s = sessoesDoServidor.get(sid);
      return viva(s) ? { user: { id: s.usuarioId, ativo: true }, tenant: { organizacaoId: s.organizacaoId, unidadeId: null }, acesso: { sessionId: sid, expiraEm: "2099-01-01T00:00:00.000Z", impersonando: false } } : null;
    },
  });
  const ORIGEM = `http://127.0.0.1:${PORTA_APP}`;
  const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src blob:; object-src blob:; base-uri 'none'; form-action 'self'";
  const sidDe = (req) => /(?:^|;\s*)fv2_sid=([A-Za-z0-9_-]{30,80})/.exec(req.headers.cookie ?? "")?.[1] ?? null;
  const lerCorpo = async (req) => { let b = ""; for await (const p of req) { b += p; if (b.length > 8192) throw new Error("grande"); } return JSON.parse(b || "{}"); };

  createServer(async (req, res) => {
    const url = new URL(req.url, ORIGEM);
    const base = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    const json = (status, corpo, extra = {}) => res.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8", ...extra }).end(JSON.stringify(corpo));
    try {
      if (req.method === "POST") {
        // Toda escrita: mesma origem + JSON (o token CSRF por sessão é conferido nas ações).
        if (req.headers.origin && req.headers.origin !== ORIGEM) return json(403, { erro: "ORIGEM", mensagem: "Origem não permitida." });
        if (!/^application\/json(;|$)/.test(req.headers["content-type"] ?? "")) return json(415, { erro: "TIPO", mensagem: "Envie JSON." });
      }
      if (url.pathname === "/api/fv2/login" && req.method === "POST") {
        const b = await lerCorpo(req);
        const r = await chamarGateway("/login", { login: String(b.login ?? "").slice(0, 60), senha: String(b.senha ?? "").slice(0, 200), segundoFator: b.segundoFator ? String(b.segundoFator).slice(0, 20) : undefined });
        if (r.status !== 200) return json(401, { erro: "CREDENCIAL_INVALIDA", mensagem: "Usuário ou senha inválidos." });
        const sid = randomBytes(32).toString("base64url");
        sessoesDoServidor.set(sid, { gatewayToken: r.corpo.token, usuarioId: r.corpo.usuarioId, organizacaoId: r.corpo.organizacaoId, aal: r.corpo.aal, expiraEm: Date.parse(r.corpo.expiraEm) });
        return json(200, { ok: true, aal: r.corpo.aal }, { "set-cookie": `fv2_sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (url.pathname === "/api/fv2/logout" && req.method === "POST") {
        const sid = sidDe(req);
        const s = sid ? sessoesDoServidor.get(sid) : null;
        if (s) { await chamarGateway("/logout", {}, s.gatewayToken); s.expiraEm = 0; }
        return json(200, { ok: true }, { "set-cookie": "fv2_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (url.pathname.startsWith("/api/fv2/acoes/")) {
        if (req.method !== "POST") return res.writeHead(405, base).end();
        const r = await demo.agir(url.pathname, await lerCorpo(req), sidDe(req), { csrf: req.headers["x-fv2-csrf"] });
        return json(r.status, r.corpo);
      }
      if (url.pathname.startsWith("/api/fv2/")) {
        if (req.method !== "GET") return res.writeHead(405, base).end();
        if (!viva(sessoesDoServidor.get(sidDe(req) ?? ""))) return json(401, { erro: "LOGIN_EXIGIDO", mensagem: "Entre com um usuário da homologação." });
        const r = await demo.responder(url.pathname, Object.fromEntries(url.searchParams), sidDe(req));
        if (r.binario) return res.writeHead(r.status, { ...base, ...r.cabecalhos }).end(r.binario);
        return json(r.status, r.corpo);
      }
      if (url.pathname === "/entrar") return res.writeHead(200, { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP }).end(await readFile(join(PASTA_FRONT, "entrar.html")));
      const arquivo = normalize(join(PASTA_FRONT, url.pathname === "/" ? "index.html" : url.pathname));
      const ext = arquivo.slice(arquivo.lastIndexOf("."));
      if (!arquivo.startsWith(PASTA_FRONT + sep) || !TIPOS[ext]) return res.writeHead(404, base).end("Não encontrado");
      return res.writeHead(200, { ...base, "content-type": TIPOS[ext], "content-security-policy": CSP }).end(await readFile(arquivo));
    } catch {
      return json(400, { erro: "REQUISICAO_INVALIDA", mensagem: "Requisição inválida." });
    }
  }).listen(PORTA_APP, "127.0.0.1", () => dizer(`HOMOLOGACAO PRONTA ${ORIGEM}/entrar (dados sintéticos; gateway em processo separado)`));
  const parar = () => { gw.kill(); process.exit(0); };
  process.on("SIGTERM", parar);
  process.on("SIGINT", parar);
}

const comando = process.argv[2];
if (comando === "preparar") await preparar();
else if (comando === "iniciar") {
  if (!existsSync(join(PASTA_HOMOLOGACAO, "aplicacao.json"))) { dizer("Rode antes: node scripts/fv2-homologacao.mjs preparar"); process.exit(1); }
  await iniciar();
} else dizer("uso: node scripts/fv2-homologacao.mjs preparar | iniciar");
