// Cliente MÍNIMO com a API do supabase-js usada por foody.repository.js, traduzida para SQL e executada via `psql` num Postgres
// LOCAL e DESCARTÁVEL. Serve para rodar o repositório/serviços REAIS contra o schema real (triggers, checks e índices da 147/148).
// Só testes. Nunca aponta para banco remoto (o URL vem de criarBancoDescartavel, que recusa host não local).
import { psqlSync } from "./pg-descartavel.js";

const id = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador inválido: ${s}`);
  return s;
};
const lit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const json = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::json`;

export function criarClientePg(url) {
  const chamadas = [];
  function executar(texto) {
    chamadas.push(texto);
    const r = psqlSync(url, `\\set VERBOSITY verbose\n${texto}`);
    if (!r.ok) {
      const m = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(r.err);
      return { data: null, error: { code: m?.[1] ?? "XX000", message: m?.[2] ?? r.err.slice(0, 300) } };
    }
    const linha = r.out.split(/\r?\n/).filter(Boolean).pop() ?? "null";
    return { data: JSON.parse(linha), error: null };
  }

  function builder(tabela) {
    const st = { op: "select", cols: "*", filtros: [], ordem: null, faixa: null, lim: null, valor: null, opcoes: null, retornar: false, modo: "lista" };
    const where = () => {
      const cs = st.filtros.map(([t, k, v]) => {
        if (t === "eq") return v === null ? `${id(k)} is null` : `${id(k)} = ${lit(v)}`;
        return v.length ? `${id(k)} in (${v.map(lit).join(", ")})` : "false";
      });
      return cs.length ? ` where ${cs.join(" and ")}` : "";
    };
    const colunas = (c) => (c === "*" ? "*" : c.split(",").map((x) => id(x.trim())).join(", "));
    const finalizar = (res) => {
      if (res.error) return res;
      const lista = res.data ?? [];
      if (st.modo === "maybeSingle") return { data: lista[0] ?? null, error: null };
      if (st.modo === "single") return lista[0] ? { data: lista[0], error: null } : { data: null, error: { code: "PGRST116", message: "0 linhas" } };
      return { data: st.op === "select" || st.retornar ? lista : null, error: null };
    };
    const rodar = () => {
      const t = id(tabela);
      if (st.op === "select") {
        let q = `select ${colunas(st.cols)} from ${t}${where()}`;
        if (st.ordem) q += ` order by ${id(st.ordem[0])} ${st.ordem[1] ? "asc" : "desc"}`;
        if (st.faixa) q += ` limit ${st.faixa[1] - st.faixa[0] + 1} offset ${st.faixa[0]}`;
        else if (st.lim != null) q += ` limit ${st.lim}`;
        return finalizar(executar(`select coalesce(jsonb_agg(x), '[]'::jsonb) from (${q}) x;`));
      }
      if (st.op === "insert" || st.op === "upsert") {
        const linhas = Array.isArray(st.valor) ? st.valor : [st.valor];
        const cols = [...new Set(linhas.flatMap((l) => Object.keys(l)))].map(id);
        const normal = linhas.map((l) => Object.fromEntries(cols.map((c) => [c, l[c] ?? null])));
        let q = `insert into ${t} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_recordset(null::${t}, ${json(normal)})`;
        if (st.op === "upsert") {
          const alvo = st.opcoes.onConflict.split(",").map((x) => id(x.trim()));
          q += ` on conflict (${alvo.join(", ")}) do update set ${cols.filter((c) => !alvo.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ")}`;
        }
        return finalizar(executar(`with w as (${q} returning *) select coalesce(jsonb_agg(w), '[]'::jsonb) from w;`));
      }
      if (st.op === "update") {
        const cols = Object.keys(st.valor).map(id);
        const q = `update ${t} set (${cols.join(", ")}) = (select ${cols.join(", ")} from json_populate_record(null::${t}, ${json(st.valor)}))${where()}`;
        return finalizar(executar(`with w as (${q} returning *) select coalesce(jsonb_agg(w), '[]'::jsonb) from w;`));
      }
      throw new Error(`op ${st.op}`);
    };
    const b = {
      select(c = "*") { if (st.op === "select") st.cols = c; else { st.retornar = true; st.cols = c; } return b; },
      eq(k, v) { st.filtros.push(["eq", k, v]); return b; },
      in(k, v) { st.filtros.push(["in", k, v]); return b; },
      order(k, { ascending = true } = {}) { st.ordem = [k, ascending]; return b; },
      range(a, z) { st.faixa = [a, z]; return b; },
      limit(n) { st.lim = n; return b; },
      insert(v) { st.op = "insert"; st.valor = v; return b; },
      update(v) { st.op = "update"; st.valor = v; return b; },
      upsert(v, o) { st.op = "upsert"; st.valor = v; st.opcoes = o; return b; },
      maybeSingle() { st.modo = "maybeSingle"; return Promise.resolve(rodar()); },
      single() { st.modo = "single"; return Promise.resolve(rodar()); },
      then(ok, ko) { return Promise.resolve(rodar()).then(ok, ko); },
    };
    return b;
  }

  return {
    chamadas,
    from: (t) => builder(t),
    rpc: async (nome, params) => {
      const args = Object.entries(params).map(([k, v]) => `${id(k)} => ${lit(v)}`).join(", ");
      return executar(`select coalesce(jsonb_agg(r), '[]'::jsonb) from ${id(nome)}(${args}) r;`);
    },
  };
}
