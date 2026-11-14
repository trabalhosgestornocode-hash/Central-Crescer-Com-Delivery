#!/usr/bin/env node
// GATEWAY LOCAL DE TESTE do Financeiro v2 (Execução 08) — autenticação e autoridade SINTÉTICAS, só em 127.0.0.1.
//
// NÃO é o login da plataforma e não deve ser apresentado como tal. Serve para homologar CONTRATOS:
//   - autentica identidades sintéticas (senha + segundo fator opcional → nível aal1/aal2);
//   - representa organização e unidades permitidas de cada identidade;
//   - emite SESSÕES DE BANCO pela credencial da AUTORIDADE (fv2_autoridade), que só este processo conhece;
//   - emite sessões de PROVISIONAMENTO só para administrador de plataforma com aal2;
//   - revoga sessões (logout) e registra eventos em arquivo JSONL fora do repositório.
//
// Separação de credenciais: este processo lê `gateway.json` (credencial da autoridade + identidades). O serviço da
// aplicação recebe só o endereço do gateway e a SUA credencial. LIMITE: no mesmo usuário do sistema operacional os dois
// arquivos são legíveis por ambos os processos — isso NÃO equivale ao isolamento de um gateway de produção.
//
// Uso: node scripts/fv2/gatewayTeste.mjs <arquivo gateway.json>   (imprime "GATEWAY PRONTO <porta>")
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { abrirPoolSeguro } from "./ambiente.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const autoridade = await abrirPoolSeguro(config.urlAutoridade, config.marcador, { max: 4 });
const sessoes = new Map(); // hash do token do gateway → sessão
const VALIDADE_MS = (config.validadeSegundos ?? 900) * 1000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const evento = (tipo, dados = {}) => appendFileSync(config.arquivoDeEventos, `${JSON.stringify({ em: new Date().toISOString(), tipo, ...dados })}\n`);
const confere = (texto, { sal, hash: esperado }) => {
  const calculado = scryptSync(String(texto ?? ""), Buffer.from(sal, "hex"), 32);
  return timingSafeEqual(calculado, Buffer.from(esperado, "hex"));
};

function sessaoDe(req) {
  const t = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? "")?.[1];
  const s = t ? sessoes.get(hash(t)) : null;
  if (!s || s.revogadaEm || s.expiraEm <= Date.now()) return null;
  return s;
}
const ler = (req) => new Promise((ok, falha) => {
  let corpo = "";
  req.on("data", (c) => { corpo += c; if (corpo.length > 20000) req.destroy(); });
  req.on("end", () => { try { ok(corpo ? JSON.parse(corpo) : {}); } catch (e) { falha(e); } });
});
const responder = (res, status, corpo) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(corpo)); };

const rotas = {
  /** Login sintético: senha; segundo fator correto eleva a aal2. */
  async "POST /login"(req, res) {
    const b = await ler(req);
    const id = config.identidades.find((x) => x.login === b.login);
    if (!id || !confere(b.senha, id.senha)) { evento("LOGIN_RECUSADO", { login: String(b.login).slice(0, 40) }); return responder(res, 401, { erro: "CREDENCIAL_INVALIDA" }); }
    const aal = id.segundoFator && b.segundoFator && confere(b.segundoFator, id.segundoFator) ? "aal2" : "aal1";
    const token = randomBytes(32).toString("base64url");
    const s = { id: randomBytes(8).toString("hex"), usuarioId: id.usuarioId, organizacaoId: id.organizacaoId, unidades: id.unidades, administradorDaPlataforma: !!id.administradorDaPlataforma, aal, expiraEm: Date.now() + VALIDADE_MS, revogadaEm: null };
    sessoes.set(hash(token), s);
    evento("LOGIN", { sessao: s.id, usuarioId: s.usuarioId, aal });
    return responder(res, 200, { token, usuarioId: s.usuarioId, organizacaoId: s.organizacaoId, unidades: s.unidades, aal, expiraEm: new Date(s.expiraEm).toISOString() });
  },

  /** Sessão de banco para a unidade pedida — só entre as unidades da identidade; o banco ainda exige concessão ativa. */
  async "POST /sessao-banco"(req, res) {
    const s = sessaoDe(req);
    if (!s) { evento("SESSAO_BANCO_RECUSADA", { motivo: "SESSAO_DO_GATEWAY_INVALIDA" }); return responder(res, 401, { erro: "SESSAO_INVALIDA" }); }
    const { unidadeId } = await ler(req);
    if (!s.unidades.includes(unidadeId)) { evento("SESSAO_BANCO_RECUSADA", { sessao: s.id, motivo: "UNIDADE_NAO_PERMITIDA" }); return responder(res, 403, { erro: "UNIDADE_NAO_PERMITIDA" }); }
    const segundos = Math.max(1, Math.min(900, Math.floor((s.expiraEm - Date.now()) / 1000)));
    try {
      const { rows } = await autoridade.query("select fv2_abrir_sessao($1, $2, $3, $4, $5) as t", [s.usuarioId, s.organizacaoId, unidadeId, segundos, `gateway:${s.id}`]);
      evento("SESSAO_BANCO", { sessao: s.id, unidadeId });
      return responder(res, 200, { token: rows[0].t });
    } catch (e) {
      evento("SESSAO_BANCO_RECUSADA", { sessao: s.id, motivo: e.code ?? "ERRO" });
      return responder(res, 403, { erro: e.code === "FV020" ? "SEM_CONCESSAO" : "RECUSADA", sqlstate: e.code ?? null });
    }
  },

  /** Provisionamento inicial: só administrador da plataforma com aal2 atesta; ele mesmo não recebe acesso. */
  async "POST /provisionamento"(req, res) {
    const s = sessaoDe(req);
    if (!s || !s.administradorDaPlataforma) { evento("PROVISIONAMENTO_RECUSADO", { motivo: "SEM_AUTORIDADE" }); return responder(res, 403, { erro: "SEM_AUTORIDADE" }); }
    const a = await ler(req);
    try {
      const { rows } = await autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, $5::jsonb, $6, $7, $8) as t",
        [s.usuarioId, a.usuarioId, s.organizacaoId, a.unidadeId, JSON.stringify(a.acoes ?? []), s.aal, a.justificativa, a.evidencia]);
      evento("PROVISIONAMENTO", { sessao: s.id, unidadeId: a.unidadeId, alvo: a.usuarioId, aal: s.aal });
      return responder(res, 200, { token: rows[0].t, atestanteId: s.usuarioId, nivelAutenticacao: s.aal });
    } catch (e) {
      evento("PROVISIONAMENTO_RECUSADO", { sessao: s.id, motivo: e.code ?? "ERRO" });
      return responder(res, 403, { erro: "PROVISIONAMENTO_RECUSADO", sqlstate: e.code ?? null });
    }
  },

  /** Logout: revoga a sessão do gateway e todas as sessões de banco da identidade nas unidades dela. */
  async "POST /logout"(req, res) {
    const s = sessaoDe(req);
    if (!s) return responder(res, 401, { erro: "SESSAO_INVALIDA" });
    s.revogadaEm = Date.now();
    for (const u of s.unidades) await autoridade.query("select fv2_encerrar_sessoes($1, $2, $3, 'logout no gateway')", [s.usuarioId, s.organizacaoId, u]);
    evento("LOGOUT", { sessao: s.id });
    return responder(res, 200, { ok: true });
  },

  async "GET /saude"(_req, res) { return responder(res, 200, { ok: true }); },
};

const servidor = createServer(async (req, res) => {
  // Só loopback; sem CORS (o navegador nunca fala com o gateway diretamente).
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return responder(res, 403, { erro: "SOMENTE_LOCAL" });
  const rota = rotas[`${req.method} ${req.url}`];
  if (!rota) return responder(res, 404, { erro: "NAO_ENCONTRADO" });
  try { return await rota(req, res); } catch { return responder(res, 400, { erro: "REQUISICAO_INVALIDA" }); }
});
servidor.listen(config.porta ?? 0, "127.0.0.1", () => {
  evento("INICIO", { porta: servidor.address().port });
  process.stdout.write(`GATEWAY PRONTO ${servidor.address().port}\n`);
});
const parar = () => { servidor.close(); autoridade.end().finally(() => process.exit(0)); };
process.on("SIGTERM", parar);
process.on("SIGINT", parar);
