// Auxiliar de testes — "Supabase" local que fala o PROTOCOLO (Auth + PostgREST) por cima de um Postgres REAL.
//
// O backend usa o supabase-js de verdade, apontado para este servidor. Assim a cadeia inteira (requireAuth,
// seleção de contexto, requireContexto, criação/revogação de sessão, auditoria, grants do Realtime) roda sem
// nenhuma troca de módulo: o que muda é só a URL. Cobre o que essa cadeia usa:
//   * GET/HEAD com select (colunas e embed de UM nível, `rel(cols)` via FK `singular_id`), filtros
//     eq/neq/gt/gte/lt/lte/is/in/not.*/or, order, limit, count exato;
//   * Accept `application/vnd.pgrst.object+json` (single/maybeSingle);
//   * POST (insert e upsert com on_conflict), PATCH, DELETE, com `return=representation`.
// Nunca fala com o Supabase de verdade: a URL do projeto é a deste servidor local.
import http from "node:http";
import { psqlAsync } from "./pg-descartavel.js";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw new Error(`identificador inválido: ${s}`); return s; };
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

/** Divide por vírgula respeitando parênteses. */
function dividirTopo(texto) {
  const partes = []; let prof = 0; let atual = "";
  for (const c of texto) {
    if (c === "(") prof += 1;
    if (c === ")") prof -= 1;
    if (c === "," && prof === 0) { partes.push(atual); atual = ""; } else atual += c;
  }
  if (atual.trim()) partes.push(atual);
  return partes.map((p) => p.trim()).filter(Boolean);
}

/** "papel, organizacao_id, organizacoes(id, nome)" -> { cols, embeds } */
function lerSelect(texto) {
  const cols = []; const embeds = [];
  for (const t of dividirTopo(texto || "*")) {
    const m = /^([a-z_][a-z0-9_]*)(![a-z]+)?\((.*)\)$/s.exec(t);
    if (m) embeds.push({ rel: m[1], ...lerSelect(m[3]) }); else cols.push(t);
  }
  return { cols, embeds };
}

const operador = (op) => ({ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]);

/** Um filtro de coluna -> SQL. `v` no formato PostgREST: `eq.x`, `is.null`, `in.(a,b)`, `not.in.(a,b)`... */
function condicao(coluna, v, pref = "") {
  const col = pref + ident(coluna);
  let neg = false; let resto = v;
  if (resto.startsWith("not.")) { neg = true; resto = resto.slice(4); }
  const i = resto.indexOf(".");
  const op = resto.slice(0, i); const val = resto.slice(i + 1);
  let sql;
  if (op === "is") sql = `${col} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`;
  else if (op === "in") sql = `${col} in (${dividirTopo(val.replace(/^\(|\)$/g, "")).map((x) => lit(x.replace(/^"|"$/g, ""))).join(", ")})`;
  else if (operador(op)) sql = `${col} ${operador(op)} ${lit(val)}`;
  else throw new Error(`filtro não suportado: ${coluna}=${v}`);
  return neg ? `not (${sql})` : sql;
}

/** `or=(a.is.null,b.not.in.(x,y))` */
function condicaoOr(valor, pref = "") {
  const termos = dividirTopo(valor.replace(/^\(|\)$/g, "")).map((t) => {
    const i = t.indexOf("."); return condicao(t.slice(0, i), t.slice(i + 1), pref);
  });
  return `(${termos.join(" or ")})`;
}

const RESERVADOS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function where(u, pref = "") {
  const w = [];
  for (const [k, v] of u.searchParams) {
    if (RESERVADOS.has(k)) continue;
    w.push(k === "or" ? condicaoOr(v, pref) : condicao(k, v, pref));
  }
  return w.length ? ` where ${w.join(" and ")}` : "";
}
function ordem(u) {
  const o = u.searchParams.get("order"); if (!o) return "";
  return ` order by ${o.split(",").map((p) => { const [c, d] = p.split("."); return `${ident(c)}${d === "desc" ? " desc" : ""}`; }).join(", ")}`;
}
const limite = (u) => (u.searchParams.get("limit") ? ` limit ${Number(u.searchParams.get("limit"))}` : "");

const fkDe = (rel) => ({ unidades: "unidade_id", organizacoes: "organizacao_id", perfis_operacionais: "perfil_id", planos: "plano_id" }[rel]);

function projetar(linha, { cols, embeds }, relacionados) {
  const out = {};
  const todas = cols.includes("*") || !cols.length;
  for (const k of (todas ? Object.keys(linha) : cols)) out[k] = linha[k] ?? null;
  for (const e of embeds) out[e.rel] = relacionados.get(`${e.rel}:${linha[fkDe(e.rel)]}`) ?? null;
  return out;
}

/**
 * @param {{ pgUrl: string, usuarios: Map<string, {id: string, email: string}>, aoConsultar?: (sql: string) => void }} cfg
 */
export async function iniciarSupabaseFalso({ pgUrl, usuarios, aoAuthAdmin = null }) {
  const consultar = async (sql) => {
    const r = await psqlAsync(pgUrl, sql);
    return r;
  };
  const erroPg = (res, r) => {
    const msg = (r.err || "").split("\n")[0];
    let status = 400; let code = "P0001";
    if (/relation .* does not exist/.test(msg)) { status = 404; code = "42P01"; }
    else if (/column .* does not exist/.test(msg)) { status = 400; code = "42703"; }
    else if (/duplicate key|unique constraint/.test(msg)) { status = 409; code = "23505"; }
    else if (/violates (check|foreign key|not-null)/.test(msg)) { status = 409; code = "23514"; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ code, message: msg, details: null, hint: null }));
  };
  const json = (res, status, corpo, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(corpo === undefined ? "" : JSON.stringify(corpo));
  };

  async function relacionados(linhas, embeds) {
    const mapa = new Map();
    for (const e of embeds) {
      const fk = fkDe(e.rel); if (!fk) throw new Error(`embed não suportado: ${e.rel}`);
      const ids = [...new Set(linhas.map((l) => l[fk]).filter(Boolean))];
      if (!ids.length) continue;
      const r = await consultar(`select coalesce(json_agg(to_jsonb(t)), '[]') from ${ident(e.rel)} t where id in (${ids.map(lit).join(", ")})`);
      if (!r.ok) throw new Error(r.err);
      const filhas = await relacionados(JSON.parse(r.out), e.embeds);
      for (const f of JSON.parse(r.out)) mapa.set(`${e.rel}:${f.id}`, projetar(f, e, filhas));
    }
    return mapa;
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      let corpo = ""; for await (const c of req) corpo += c;
      const dados = corpo ? JSON.parse(corpo) : null;

      // ---- Auth ----
      if (u.pathname === "/auth/v1/user") {
        const jwt = (req.headers.authorization || "").replace(/^Bearer /, "");
        const user = usuarios.get(jwt);
        return user
          ? json(res, 200, { id: user.id, email: user.email, aud: "authenticated", app_metadata: {}, user_metadata: {}, factors: [] })
          : json(res, 401, { code: 401, msg: "invalid JWT" });
      }

      // ---- Auth administrativo (GoTrue): o painel lê o usuário, bloqueia e encerra sessões ----
      const admin = u.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})(\/logout)?$/);
      if (admin) {
        const alvo = [...usuarios.values()].find((x) => x.id === admin[1]);
        if (admin[2]) { aoAuthAdmin?.({ acao: "logout", id: admin[1] }); res.writeHead(204); return res.end(); }
        if (!alvo) return json(res, 404, { code: 404, msg: "User not found" });
        if (req.method === "PUT") { aoAuthAdmin?.({ acao: "atualizar", id: admin[1], corpo: dados }); return json(res, 200, { id: alvo.id, email: alvo.email }); }
        return json(res, 200, { id: alvo.id, email: alvo.email, last_sign_in_at: "2026-10-10T12:00:00Z", app_metadata: {}, user_metadata: {} });
      }

      // ---- PostgREST ----
      const m = u.pathname.match(/^\/rest\/v1\/([a-z_][a-z0-9_]*)$/);
      if (!m) return json(res, 404, { message: "rota desconhecida" });
      const tabela = ident(m[1]);
      const querObjeto = /vnd\.pgrst\.object/.test(req.headers.accept || "");
      const querRepresentacao = /return=representation/.test(req.headers.prefer || "");
      const contar = /count=exact/.test(req.headers.prefer || "");

      if (req.method === "GET" || req.method === "HEAD") {
        const sel = lerSelect(u.searchParams.get("select") || "*");
        const filtro = where(u, "t.");
        const r = await consultar(`select coalesce(json_agg(to_jsonb(x)), '[]') from (select * from ${tabela} t${filtro}${ordem(u)}${limite(u)}) x`);
        if (!r.ok) return erroPg(res, r);
        const linhas = JSON.parse(r.out);
        let extra = {};
        if (contar) {
          const c = await consultar(`select count(*) from ${tabela} t${filtro}`);
          if (!c.ok) return erroPg(res, c);
          extra = { "content-range": `*/${c.out}` };
        }
        if (req.method === "HEAD") { res.writeHead(200, extra); return res.end(); }
        const rel = await relacionados(linhas, sel.embeds);
        const saida = linhas.map((l) => projetar(l, sel, rel));
        if (querObjeto) {
          return saida.length === 1 ? json(res, 200, saida[0], extra)
            : json(res, 406, { code: "PGRST116", details: `The result contains ${saida.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
        }
        return json(res, 200, saida, extra);
      }

      if (req.method === "POST") {
        const linhas = Array.isArray(dados) ? dados : [dados];
        const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l)))].map(ident);
        const json_ = lit(JSON.stringify(linhas));
        let sql = `insert into ${tabela} (${colunas.join(", ")}) select ${colunas.join(", ")} from jsonb_populate_recordset(null::${tabela}, ${json_}::jsonb)`;
        const conflito = u.searchParams.get("on_conflict");
        if (conflito && /merge-duplicates/.test(req.headers.prefer || "")) {
          const alvo = conflito.split(",").map(ident);
          const set = colunas.filter((c) => !alvo.includes(c)).map((c) => `${c} = excluded.${c}`);
          sql += ` on conflict (${alvo.join(", ")}) ${set.length ? `do update set ${set.join(", ")}` : "do nothing"}`;
        }
        const r = await consultar(`with q as (${sql} returning to_jsonb(${tabela}.*) as j) select coalesce(json_agg(q), '[]') from q`);
        if (!r.ok) return erroPg(res, r);
        const saida = JSON.parse(r.out).map((x) => x.j);
        if (!querRepresentacao) return json(res, 201);
        return querObjeto ? json(res, 201, saida[0]) : json(res, 201, saida);
      }

      if (req.method === "PATCH") {
        const colunas = Object.keys(dados).map(ident);
        const set = colunas.map((c) => `${c} = r.${c}`).join(", ");
        const r = await consultar(`with q as (update ${tabela} t set ${set} from jsonb_populate_record(null::${tabela}, ${lit(JSON.stringify(dados))}::jsonb) r${where(u, "t.")} returning to_jsonb(t.*) as j) select coalesce(json_agg(q), '[]') from q`);
        if (!r.ok) return erroPg(res, r);
        const saida = JSON.parse(r.out).map((x) => x.j);
        return querRepresentacao ? json(res, 200, querObjeto ? saida[0] : saida) : json(res, 204);
      }

      if (req.method === "DELETE") {
        const r = await consultar(`with q as (delete from ${tabela} t${where(u, "t.")} returning to_jsonb(t.*) as j) select coalesce(json_agg(q), '[]') from q`);
        if (!r.ok) return erroPg(res, r);
        return querRepresentacao ? json(res, 200, JSON.parse(r.out).map((x) => x.j)) : json(res, 204);
      }
      return json(res, 405, {});
    } catch (e) {
      json(res, 500, { message: String(e.message || e) });
    }
  });

  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  servidor.unref();
  return {
    url: `http://127.0.0.1:${servidor.address().port}`,
    parar: () => new Promise((r) => servidor.close(r)),
  };
}
