// Cliente MÍNIMO com a mesma interface do supabase-js (subconjunto usado pelos repositórios financeiros) que fala com o PostgreSQL LOCAL DESCARTÁVEL
// via psql, executando como `service_role` — o mesmo papel do backend. Serve para rodar o CÓDIGO REAL de carregamento da aplicação (repositórios,
// filtros, ordenação, paginação e `.limit()`) contra o banco local, sem PostgREST nem Supabase (F-3/F-4 locais).
// Não é um PostgREST completo: só o necessário (select/insert/update/upsert, eq/neq/gt/gte/lt/lte/in/is/ilike/not/filter, order, range, limit,
// single/maybeSingle, rpc). Recusa rodar sem o cluster DESCARTÁVEL (arquivo MARCADOR_DESCARTAVEL) e só fala com 127.0.0.1.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function criarClienteLocal({ cluster = process.env.PG_CLUSTER_DIR, porta = "54321", banco = "sim", psql = "C:/Program Files/PostgreSQL/17/bin/psql.exe", papel = "service_role" } = {}) {
  if (!cluster || !existsSync(path.join(cluster, "MARCADOR_DESCARTAVEL"))) throw new Error("postgrest_local: defina PG_CLUSTER_DIR de um cluster DESCARTÁVEL (MARCADOR_DESCARTAVEL)");
  const executar = (sql) => {
    const r = spawnSync(psql, ["-h", "127.0.0.1", "-p", porta, "-U", "postgres", "-d", banco, "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
      { input: `set role ${papel};\n${sql}`, encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" }, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) {
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.stderr || "") ?? /ERROR:\s+([^\n]*)/.exec(r.stderr || "");
      return { erro: m && m.length === 3 ? { code: m[1], message: m[2] } : { code: "XX000", message: (m?.[1] ?? r.stderr ?? "erro").trim() } };
    }
    return { saida: (r.stdout || "").trim() };
  };
  // como o PostgREST do Supabase: no máximo `maxLinhas` (padrão 1000, o `max-rows` do projeto) por requisição, mesmo com .limit() maior
  const maxLinhas = Number(process.env.POSTGREST_MAX_ROWS ?? 1000);
  return { from: (t) => Object.assign(new Consulta(executar, t), { maxLinhas }), rpc: (fn, args = {}) => rpc(executar, fn, args) };
}

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador inválido: ${s}`); return `"${s}"`; };
const texto = (s) => `'${String(s).replaceAll("'", "''")}'`;
function literal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return texto(`{${v.map((x) => (x === null ? "NULL" : `"${String(x).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)).join(",")}}`);   // literal de array (tipo resolvido pelo destino)
  if (typeof v === "object") return texto(JSON.stringify(v));
  return texto(v);
}
function colunas(sel) {
  if (!sel || sel.trim() === "*") return "*";
  return sel.split(",").map((c) => c.trim()).filter(Boolean).map((c) => { if (c.includes("(")) throw new Error(`select com relação não suportado: ${c}`); return ident(c); }).join(", ");
}

class Consulta {
  constructor(executar, tabela) { Object.assign(this, { executar, tabela, op: "select", cols: "*", where: [], ordem: [], lim: null, off: null, um: null, dados: null, conflito: null, retorna: false }); }
  select(c = "*") { if (this.op === "select") this.cols = c; else this.retorna = c || "*"; return this; }
  insert(d) { this.op = "insert"; this.dados = d; return this; }
  upsert(d, o = {}) { this.op = "upsert"; this.dados = d; this.conflito = o.onConflict ?? null; return this; }
  update(d) { this.op = "update"; this.dados = d; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.where.push(`${ident(c)} = ${literal(v)}`); return this; }
  neq(c, v) { this.where.push(`${ident(c)} is distinct from ${literal(v)}`); return this; }
  gt(c, v) { this.where.push(`${ident(c)} > ${literal(v)}`); return this; }
  gte(c, v) { this.where.push(`${ident(c)} >= ${literal(v)}`); return this; }
  lt(c, v) { this.where.push(`${ident(c)} < ${literal(v)}`); return this; }
  lte(c, v) { this.where.push(`${ident(c)} <= ${literal(v)}`); return this; }
  in(c, vs) { this.where.push(vs.length ? `${ident(c)} in (${vs.map(literal).join(", ")})` : "false"); return this; }
  is(c, v) { this.where.push(`${ident(c)} is ${v === null ? "null" : v ? "true" : "false"}`); return this; }
  ilike(c, v) { this.where.push(`${ident(c)} ilike ${literal(v)}`); return this; }
  not(c, op, v) { if (op === "is") this.where.push(`${ident(c)} is not ${v === null ? "null" : v}`); else throw new Error(`not(${op}) não suportado`); return this; }
  filter(c, op, v) { const ops = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }; if (op === "cs") this.where.push(`${ident(c)} @> ${literal(v)}`); else if (ops[op]) this.where.push(`${ident(c)} ${ops[op]} ${literal(v)}`); else throw new Error(`filter(${op}) não suportado`); return this; }
  order(c, o = {}) { this.ordem.push(`${ident(c)} ${o.ascending === false ? "desc" : "asc"}${o.nullsFirst ? " nulls first" : ""}`); return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.um = "single"; return this; }
  maybeSingle() { this.um = "maybe"; return this; }
  sql() {
    const w = this.where.length ? ` where ${this.where.join(" and ")}` : "";
    if (this.op === "select") {
      const o = this.ordem.length ? ` order by ${this.ordem.join(", ")}` : "";
      const lim = Math.min(this.lim ?? Infinity, this.maxLinhas ?? Infinity);
      const l = (Number.isFinite(lim) ? ` limit ${lim}` : "") + (this.off != null ? ` offset ${this.off}` : "");
      return `select coalesce(json_agg(t), '[]'::json) from (select ${colunas(this.cols)} from ${ident(this.tabela)}${w}${o}${l}) t;`;
    }
    const ret = this.retorna ? ` returning ${colunas(this.retorna)}` : "";
    const embrulha = (q) => this.retorna ? `with x as (${q}) select coalesce(json_agg(x), '[]'::json) from x;` : `${q};`;
    if (this.op === "insert" || this.op === "upsert") {
      const linhas = Array.isArray(this.dados) ? this.dados : [this.dados];
      const cs = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
      const vals = linhas.map((l) => `(${cs.map((c) => (c in l ? literal(l[c]) : "default")).join(", ")})`).join(", ");
      const conf = this.op === "upsert" && this.conflito ? ` on conflict (${this.conflito.split(",").map((c) => ident(c.trim())).join(", ")}) do update set ${cs.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}` : "";
      return embrulha(`insert into ${ident(this.tabela)} (${cs.map(ident).join(", ")}) values ${vals}${conf}${ret}`);
    }
    if (this.op === "update") return embrulha(`update ${ident(this.tabela)} set ${Object.entries(this.dados).map(([c, v]) => `${ident(c)} = ${literal(v)}`).join(", ")}${w}${ret}`);
    return embrulha(`delete from ${ident(this.tabela)}${w}${ret}`);
  }
  then(res, rej) {
    let saida;
    try { saida = this.executar(this.sql()); } catch (e) { return Promise.resolve({ data: null, error: { message: e.message, code: "XX000" } }).then(res, rej); }
    if (saida.erro) return Promise.resolve({ data: null, error: saida.erro }).then(res, rej);
    let data = saida.saida ? JSON.parse(saida.saida) : null;   // json_agg quebra linhas entre elementos: o JSON é a saída inteira
    if (this.um) {
      if (this.um === "single" && (!data || data.length !== 1)) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "esperava 1 linha" } }).then(res, rej);
      data = data?.[0] ?? null;
    }
    return Promise.resolve({ data, error: null }).then(res, rej);
  }
}

function rpc(executar, fn, args) {
  const params = Object.entries(args).map(([k, v]) => `${ident(k)} := ${literal(v)}`).join(", ");
  const saida = executar(`select coalesce(to_json(${ident(fn)}(${params})), 'null'::json);`);
  if (saida.erro) return Promise.resolve({ data: null, error: saida.erro });
  return Promise.resolve({ data: JSON.parse(saida.saida), error: null });
}
