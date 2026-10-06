// Banco FAKE em memória para testar services que usam o cliente `supabase`
// exportado por src/config/supabase.js — SEM rede e SEM banco real.
//
// `instalar(supabase)` troca `supabase.from`/`supabase.rpc` do cliente
// exportado (o mesmo objeto que os services importam) e `restaurar()` devolve
// os originais. Suporta o subconjunto do PostgREST que os services do
// Dashboard iFood usam: select/eq/neq/gte/lte/gt/lt/in/is/order/limit +
// maybeSingle/single + insert/update/delete/upsert.
//
// Emula do Postgres só o que importa para os testes:
//   * `id` e `created_at`/`updated_at` gerados; `updated_at` sempre muda num
//     UPDATE (trigger set_updated_at) e nunca repete (relógio monotônico);
//   * valores DEFAULT por tabela (`defaults`);
//   * unicidade declarada (`unicos`) -> erro "duplicate key";
//   * cascata de FK no DELETE (`cascatas`);
//   * tabelas ausentes (`ausentes`) -> erro 42P01, como uma migration não aplicada.
// RPCs são funções JS plugadas por nome (`rpcs`) que recebem (args, banco).
import { randomUUID } from "node:crypto";

export function criarBancoFake({ tabelas = {}, defaults = {}, unicos = {}, cascatas = [], ausentes = [], rpcs = {} } = {}) {
  const banco = { tabelas: structuredClone(tabelas), log: [] };
  let relogio = Date.parse("2026-01-01T00:00:00.000Z");
  banco.agora = () => new Date((relogio += 1000)).toISOString();
  // Linhas semeadas ganham id/timestamps como se tivessem sido inseridas.
  for (const lista of Object.values(banco.tabelas)) {
    for (const l of lista) {
      l.id ??= randomUUID();
      l.created_at ??= banco.agora();
      l.updated_at ??= l.created_at;
    }
  }
  const linhas = (t) => (banco.tabelas[t] ??= []);

  const violaUnico = (t, linha, ignorar) => (unicos[t] ?? []).some((cols) =>
    linhas(t).some((o) => o !== ignorar && cols.every((c) => o[c] != null && o[c] === linha[c])));

  banco.inserir = (t, row) => {
    const agora = banco.agora();
    const linha = { id: randomUUID(), created_at: agora, updated_at: agora, ...(defaults[t] ?? {}), ...row };
    if (violaUnico(t, linha)) return { error: { code: "23505", message: `duplicate key value violates unique constraint on ${t}` } };
    linhas(t).push(linha);
    return { linha };
  };
  banco.apagar = (t, alvo) => {
    const ids = new Set(alvo.map((l) => l.id));
    banco.tabelas[t] = linhas(t).filter((l) => !ids.has(l.id));
    for (const c of cascatas.filter((x) => x.pai === t)) {
      banco.apagar(c.filho, linhas(c.filho).filter((f) => ids.has(f[c.fk])));
    }
  };

  function from(t) {
    const q = { op: "select", filtros: [], payload: null, opts: null, single: null, limite: null, ordem: [] };
    const filtro = (fn) => { q.filtros.push(fn); return b; };
    const executar = () => {
      banco.log.push({ tabela: t, op: q.op, payload: q.payload });
      if (ausentes.includes(t)) return { data: null, error: { code: "42P01", message: `relation "${t}" does not exist` } };
      const casa = (l) => q.filtros.every((f) => f(l));
      if (q.op === "insert") {
        const novas = [];
        for (const row of [].concat(q.payload)) {
          const r = banco.inserir(t, row);
          if (r.error) return { data: null, error: r.error };
          novas.push(r.linha);
        }
        return fim(novas);
      }
      if (q.op === "update") {
        const alvo = linhas(t).filter(casa);
        for (const l of alvo) {
          const depois = { ...l, ...q.payload };
          if (violaUnico(t, depois, l)) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${t}` } };
        }
        for (const l of alvo) Object.assign(l, q.payload, { updated_at: banco.agora() });
        return fim(alvo);
      }
      if (q.op === "delete") {
        const alvo = linhas(t).filter(casa);
        banco.apagar(t, alvo);
        return fim(alvo);
      }
      if (q.op === "upsert") {
        const k = q.opts?.onConflict;
        const existente = linhas(t).find((l) => l[k] === q.payload[k]);
        if (existente) Object.assign(existente, q.payload, { updated_at: banco.agora() });
        else banco.inserir(t, q.payload);
        return fim([existente ?? linhas(t).at(-1)]);
      }
      let achados = linhas(t).filter(casa);
      for (const [col, asc] of q.ordem) {
        achados = achados.slice().sort((a, x) => (a[col] < x[col] ? -1 : a[col] > x[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.limite != null) achados = achados.slice(0, q.limite);
      return fim(achados);
    };
    // Cópias: o service nunca segura referência viva do "banco".
    const fim = (achados) => {
      const copia = structuredClone(achados);
      if (q.single === "maybe") return { data: copia[0] ?? null, error: null };
      if (q.single === "um") return copia.length === 1 ? { data: copia[0], error: null } : { data: null, error: { message: `esperava 1 linha, veio ${copia.length}` } };
      return { data: copia, error: null };
    };
    const b = {
      select() { return b; },
      eq: (c, v) => filtro((l) => l[c] === v),
      neq: (c, v) => filtro((l) => l[c] !== v),
      gte: (c, v) => filtro((l) => l[c] != null && l[c] >= v),
      lte: (c, v) => filtro((l) => l[c] != null && l[c] <= v),
      gt: (c, v) => filtro((l) => l[c] != null && l[c] > v),
      lt: (c, v) => filtro((l) => l[c] != null && l[c] < v),
      in: (c, vs) => filtro((l) => vs.includes(l[c])),
      ilike: (c, padrao) => {
        const re = new RegExp(`^${String(padrao).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
        return filtro((l) => l[c] != null && re.test(String(l[c])));
      },
      is: (c, v) => filtro((l) => (v === null ? l[c] == null : l[c] === v)),
      not: (c, op, v) => filtro((l) => (op === "is" && v === null ? l[c] != null : true)),
      // `or` do PostgREST (ex.: metas globais OU da empresa): não filtra —
      // quem chama já resolve a cascata em JS sobre o que vier.
      or() { return b; },
      order(c, o = {}) { q.ordem.push([c, o.ascending !== false]); return b; },
      limit(n) { q.limite = n; return b; },
      insert(p) { q.op = "insert"; q.payload = p; return b; },
      update(p) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      upsert(p, o) { q.op = "upsert"; q.payload = p; q.opts = o; return b; },
      maybeSingle() { q.single = "maybe"; return Promise.resolve().then(executar); },
      single() { q.single = "um"; return Promise.resolve().then(executar); },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };
    return b;
  }

  async function rpc(nome, args) {
    banco.log.push({ rpc: nome, args });
    const fn = rpcs[nome];
    if (!fn) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${nome}` } };
    // "Transação": a RPC trabalha numa cópia; só confirma se não houver erro.
    const antes = structuredClone(banco.tabelas);
    try {
      const data = await fn(args, banco);
      return { data, error: null };
    } catch (e) {
      banco.tabelas = antes;
      return { data: null, error: { code: e.code ?? "P0001", message: e.message } };
    }
  }

  let originais = null;
  banco.instalar = (cliente) => {
    originais = { from: cliente.from, rpc: cliente.rpc };
    cliente.from = from;
    cliente.rpc = rpc;
    return banco;
  };
  banco.restaurar = (cliente) => {
    if (originais) Object.assign(cliente, originais);
    originais = null;
  };
  banco.from = from;
  banco.rpc = rpc;
  return banco;
}
