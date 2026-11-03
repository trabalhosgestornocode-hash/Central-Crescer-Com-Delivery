// Banco FALSO em memória com a API mínima do supabase-js usada por foody.repository.js. Simula as travas da migration 144:
// tenant (unidade pertence à organização), unicidade (unidade_id, foody_uid) e a função foody_fechamento_registrar.
// Da 145: tabelas de destino/decisão e a unicidade GLOBAL de linha ativa por (conexao_id, foody_uid) — escrita que deixaria um
// uid ativo em dois tenants é recusada (23505) e desfeita, como o índice uq_foody_pedidos_conexao_uid_ativo faria.
// Registra cada chamada para os testes conferirem os filtros de organização/unidade.
import { randomUUID } from "node:crypto";

export function criarFakeDb({ unidades = {} } = {}) {
  const tabelas = { foody_conexoes: [], foody_sync_execucoes: [], foody_pedidos: [], foody_fechamentos_logisticos: [],
    foody_conexao_destinos: [], foody_triagem_decisoes: [] };
  const chamadas = [];
  let seqCarimbo = 0;
  const validarTenant = (t, linha) => {
    if (unidades[linha.unidade_id] !== linha.organizacao_id) {
      const e = new Error(`${t}: a unidade ${linha.unidade_id} não pertence à organização ${linha.organizacao_id}`); e.code = "42501"; throw e;
    }
  };

  const unicoAtivoViolado = () => {
    const vistos = new Set();
    for (const r of tabelas.foody_pedidos) {
      if (r.roteamento_ativo === false || !r.conexao_id) continue;
      const k = `${r.conexao_id}|${r.foody_uid}`;
      if (vistos.has(k)) return true;
      vistos.add(k);
    }
    return false;
  };
  const comUnicidade = (tabela, fn) => {
    if (tabela !== "foody_pedidos") return fn();
    const antes = tabelas.foody_pedidos.map((r) => ({ ...r }));
    const r = fn();
    if (unicoAtivoViolado()) {
      tabelas.foody_pedidos.splice(0, tabelas.foody_pedidos.length, ...antes);
      throw Object.assign(new Error("uq_foody_pedidos_conexao_uid_ativo"), { code: "23505" });
    }
    return r;
  };

  function builder(tabela) {
    const st = { tabela, op: "select", filtros: [], cols: "*", ordem: null, faixa: null, lim: null, modo: "lista", valor: null, opcoes: null, retornar: false };
    const casa = (r) => st.filtros.every(([tipo, k, v]) => (tipo === "eq" ? r[k] === v : v.includes(r[k])));
    const executar = () => {
      chamadas.push({ tabela, op: st.op, filtros: st.filtros.map(([t, k, v]) => [t, k, v]), valor: st.valor });
      const linhas = tabelas[tabela];
      try {
        if (st.op === "insert") {
          // Como o default now() do banco: carimbo estritamente crescente (a ordem por iniciado_em é a ordem de inserção).
          const carimbo = tabela === "foody_sync_execucoes" ? { iniciado_em: new Date(Date.UTC(2026, 0, 1) + ++seqCarimbo).toISOString() } : {};
          const novas = (Array.isArray(st.valor) ? st.valor : [st.valor]).map((v) => ({ id: randomUUID(), ...carimbo, ...v }));
          for (const n of novas) validarTenant(tabela, n);
          linhas.push(...novas);
          return { data: st.modo === "lista" ? novas : novas[0], error: null };
        }
        if (st.op === "upsert") {
          comUnicidade(tabela, () => {
            for (const v of st.valor) {
              validarTenant(tabela, v);
              const i = linhas.findIndex((r) => r.unidade_id === v.unidade_id && r.foody_uid === v.foody_uid);
              if (i >= 0) linhas[i] = { ...linhas[i], ...v }; else linhas.push({ id: randomUUID(), roteamento_ativo: true, ...v });
            }
          });
          return { data: null, error: null };
        }
        if (st.op === "update") {
          const alteradas = comUnicidade(tabela, () => {
            const lista = linhas.filter(casa);
            for (const r of lista) {
              const novo = { ...r, ...st.valor };
              validarTenant(tabela, novo);
              if (novo.unidade_id !== r.unidade_id) throw Object.assign(new Error("unidade não muda"), { code: "42501" });
              Object.assign(r, st.valor);
            }
            return lista;
          });
          return { data: st.retornar ? alteradas.map((r) => ({ ...r })) : null, error: null };
        }
        let res = linhas.filter(casa);
        if (st.ordem) {
          const [k, asc] = st.ordem;
          res = [...res].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (st.faixa) res = res.slice(st.faixa[0], st.faixa[1] + 1);
        if (st.lim != null) res = res.slice(0, st.lim);
        const projetar = (r) => (st.cols === "*" ? { ...r } : Object.fromEntries(st.cols.split(",").map((c) => c.trim()).map((c) => [c, r[c]])));
        if (st.modo === "maybeSingle") return { data: res[0] ? projetar(res[0]) : null, error: null };
        if (st.modo === "single") return res[0] ? { data: projetar(res[0]), error: null } : { data: null, error: { code: "PGRST116", message: "0 linhas" } };
        return { data: res.map(projetar), error: null };
      } catch (e) {
        return { data: null, error: { code: e.code ?? "XX000", message: e.message } };
      }
    };
    const b = {
      select(cols = "*") { if (st.op === "select") st.cols = cols; else st.retornar = true; return b; },
      eq(k, v) { st.filtros.push(["eq", k, v]); return b; },
      in(k, v) { st.filtros.push(["in", k, v]); return b; },
      order(k, { ascending = true } = {}) { st.ordem = [k, ascending]; return b; },
      range(a, z) { st.faixa = [a, z]; return b; },
      limit(n) { st.lim = n; return b; },
      insert(v) { st.op = "insert"; st.valor = v; return b; },
      update(v) { st.op = "update"; st.valor = v; return b; },
      upsert(v, o) { st.op = "upsert"; st.valor = v; st.opcoes = o; return b; },
      maybeSingle() { st.modo = "maybeSingle"; return Promise.resolve(executar()); },
      single() { st.modo = "single"; return Promise.resolve(executar()); },
      then(ok, ko) { return Promise.resolve(executar()).then(ok, ko); },
    };
    return b;
  }

  // Mesma lógica de foody_fechamento_registrar (a versão real é exercitada no teste com Postgres).
  function registrar(p) {
    if (unidades[p.p_unidade_id] !== p.p_organizacao_id) return { data: null, error: { code: "42501", message: "unidade fora da organização" } };
    const f = tabelas.foody_fechamentos_logisticos;
    const existente = f.find((r) => r.execucao_id === p.p_execucao_id);
    if (existente) return { data: [{ resultado: "JA_REGISTRADO", fechamento_id: existente.id, versao_registrada: existente.versao, status_registrado: existente.status }], error: null };
    const ultima = f.filter((r) => r.unidade_id === p.p_unidade_id && r.competencia === p.p_competencia).sort((a, b) => b.versao - a.versao)[0];
    if (ultima && ultima.hash_conteudo === p.p_hash && ultima.status === p.p_status && ultima.estado_valores === p.p_estado_valores) {
      return { data: [{ resultado: "SEM_MUDANCA", fechamento_id: ultima.id, versao_registrada: ultima.versao, status_registrado: ultima.status }], error: null };
    }
    if (ultima && ["CONSOLIDADO", "CORRIGIDO"].includes(ultima.status) && p.p_status === "PRELIMINAR") return { data: null, error: { code: "22023", message: "não volta a PRELIMINAR" } };
    if (p.p_status === "CORRIGIDO" && (!ultima || !String(p.p_motivo ?? "").trim())) return { data: null, error: { code: "22023", message: "CORRIGIDO exige consolidado e motivo" } };
    const linha = {
      id: randomUUID(), organizacao_id: p.p_organizacao_id, unidade_id: p.p_unidade_id, competencia: p.p_competencia,
      versao: (ultima?.versao ?? 0) + 1, status: p.p_status, estado_valores: p.p_estado_valores, execucao_id: p.p_execucao_id,
      sync_execucao_id: p.p_sync_execucao_id, motivo: p.p_motivo, substitui_id: ultima?.id ?? null, indicadores: p.p_indicadores,
      outras_operacoes: p.p_outras_operacoes, pendencias: p.p_pendencias, cobertura: p.p_cobertura, hash_conteudo: p.p_hash,
    };
    f.push(linha);
    return { data: [{ resultado: "REGISTRADO", fechamento_id: linha.id, versao_registrada: linha.versao, status_registrado: linha.status }], error: null };
  }

  return {
    tabelas, chamadas,
    from: (t) => {
      if (!(t in tabelas)) throw new Error(`fake-db: tabela inesperada ${t}`);
      return builder(t);
    },
    rpc: async (nome, params) => {
      chamadas.push({ rpc: nome, params });
      if (nome !== "foody_fechamento_registrar") return { data: null, error: { code: "42883", message: `rpc inesperada ${nome}` } };
      return registrar(params);
    },
  };
}
