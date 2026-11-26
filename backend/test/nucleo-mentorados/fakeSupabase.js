// Supabase em memória, só o subconjunto usado pelo Núcleo Mentorados (select/in/eq/order/range, insert, upsert,
// update, delete, rpc). Cada consulta fica registrada em `log` para os testes de isolamento.
import { randomUUID } from "node:crypto";

export function fakeSupabase(tabelas = {}, { rpc = {}, ausentes = [] } = {}) {
  const db = Object.fromEntries(Object.entries(tabelas).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const log = [];
  const UNICOS = { mentoria_participantes: ["organizacao_id"], mentoria_apresentacoes: ["organizacao_id", "versao"] };

  function consulta(tabela) {
    const st = { op: "select", filtros: [], ordem: null, faixa: null, valores: null, onConflict: null, retornar: false };
    const api = {
      select() { if (st.op !== "select") st.retornar = true; return api; },
      in(c, vs) { st.filtros.push((r) => vs.includes(r[c])); st.log.push(["in", c, vs]); return api; },
      eq(c, v) { st.filtros.push((r) => r[c] === v); st.log.push(["eq", c, v]); return api; },
      order(c, { ascending = true } = {}) { st.ordem = { c, ascending }; return api; },
      range(a, b) { st.faixa = [a, b]; return api; },
      insert(v) { st.op = "insert"; st.valores = [].concat(v); return api; },
      upsert(v, { onConflict } = {}) { st.op = "upsert"; st.valores = [].concat(v); st.onConflict = onConflict.split(","); return api; },
      update(v) { st.op = "update"; st.valores = v; return api; },
      delete() { st.op = "delete"; return api; },
      then(ok, err) { return Promise.resolve().then(executar).then(ok, err); },
    };
    st.log = [];
    function executar() {
      log.push({ tabela, op: st.op, filtros: st.log });
      if (ausentes.includes(tabela)) return { data: null, error: { code: "42P01", message: `relation "${tabela}" does not exist` } };
      const linhas = (db[tabela] ??= []);
      const casa = (r) => st.filtros.every((f) => f(r));
      if (st.op === "select") {
        let out = linhas.filter(casa);
        if (st.ordem) out = out.slice().sort((a, b) => (a[st.ordem.c] < b[st.ordem.c] ? -1 : a[st.ordem.c] > b[st.ordem.c] ? 1 : 0) * (st.ordem.ascending ? 1 : -1));
        if (st.faixa) out = out.slice(st.faixa[0], st.faixa[1] + 1);
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      if (st.op === "insert" || st.op === "upsert") {
        const saida = [];
        for (const v of st.valores) {
          const chave = st.onConflict ?? UNICOS[tabela];
          const existente = chave ? linhas.find((r) => chave.every((c) => r[c] === v[c])) : null;
          if (existente && st.op === "insert") return { data: null, error: { code: "23505", message: "duplicate key" } };
          if (existente) { Object.assign(existente, v); saida.push({ ...existente }); continue; }
          const nova = { id: randomUUID(), created_at: new Date().toISOString(), ...v };
          linhas.push(nova); saida.push({ ...nova });
        }
        return { data: saida, error: null };
      }
      if (st.op === "update") {
        const alvo = linhas.filter(casa); for (const r of alvo) Object.assign(r, st.valores);
        return { data: alvo.map((r) => ({ ...r })), error: null };
      }
      if (st.op === "delete") {
        const alvo = linhas.filter(casa); db[tabela] = linhas.filter((r) => !casa(r));
        return { data: alvo.map((r) => ({ ...r })), error: null };
      }
      return { data: null, error: { message: "op?" } };
    }
    return api;
  }
  return {
    db, log,
    from: (t) => consulta(t),
    rpc: async (nome, args) => {
      log.push({ rpc: nome, args });
      if (!rpc[nome]) return { data: null, error: { code: "PGRST202", message: `Could not find the function ${nome}` } };
      return rpc[nome](args, db);
    },
  };
}

/** Implementação em memória da função SQL mentoria_importar_historico (mesma semântica idempotente). */
export function rpcImportar({ p_org, p_importacao, p_meses }, db) {
  db.mentoria_importacoes ??= []; db.mentoria_historico_mensal ??= [];
  if (!(db.mentoria_participantes ?? []).some((p) => p.organizacao_id === p_org)) return { data: null, error: { code: "P0002", message: "empresa não é participante da mentoria" } };
  const ja = db.mentoria_importacoes.find((i) => i.organizacao_id === p_org && i.arquivo_sha256 === p_importacao.arquivo_sha256);
  if (ja) return { data: [{ importacao_id: ja.id, ja_existia: true, meses_gravados: 0 }], error: null };
  const id = randomUUID();
  db.mentoria_importacoes.push({ id, organizacao_id: p_org, ...p_importacao, created_at: new Date().toISOString() });
  for (const m of p_meses) {
    const i = db.mentoria_historico_mensal.findIndex((h) => h.organizacao_id === p_org && h.mes === m.mes && h.fonte === "importacao");
    const linha = { organizacao_id: p_org, fonte: "importacao", importacao_id: id, ...m };
    if (i >= 0) db.mentoria_historico_mensal[i] = linha; else db.mentoria_historico_mensal.push(linha);
  }
  return { data: [{ importacao_id: id, ja_existia: false, meses_gravados: p_meses.length }], error: null };
}
