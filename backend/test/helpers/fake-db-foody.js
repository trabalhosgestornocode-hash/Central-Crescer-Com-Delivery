// Banco FALSO em memória com a API mínima do supabase-js usada por foody.repository.js. Simula as travas da migration 147:
// tenant (unidade pertence à organização), unicidade (unidade_id, foody_uid) e a função foody_fechamento_registrar.
// Da 148: tabelas de destino/decisão e a unicidade GLOBAL de linha ativa por (conexao_id, foody_uid) — escrita que deixaria um
// uid ativo em dois tenants é recusada (23505) e desfeita, como o índice uq_foody_pedidos_conexao_uid_ativo faria.
// Da 149: a função foody_conexao_administrar (admin conferido em `admins`, guardas de dupla contagem, evento por ação) — a versão
// real é exercitada no teste com Postgres; aqui ela só precisa ter o MESMO contrato.
// Registra cada chamada para os testes conferirem os filtros de organização/unidade.
import { randomUUID } from "node:crypto";

export function criarFakeDb({ unidades = {}, admins = [] } = {}) {
  const tabelas = { foody_conexoes: [], foody_sync_execucoes: [], foody_pedidos: [], foody_fechamentos_logisticos: [],
    foody_conexao_destinos: [], foody_triagem_decisoes: [], foody_conexoes_eventos: [], foody_destinos_eventos: [] };
  /** [perfilId, organizacaoId] de organization_admin ATIVO (o que usuarios_organizacoes diria). Mutável pelos testes. */
  const papeis = new Set(admins.map(([p, o]) => `${p}|${o}`));
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
    const casa = (r) => st.filtros.every(([tipo, k, v]) => (tipo === "eq" ? r[k] === v : tipo === "gte" ? r[k] >= v : tipo === "lte" ? r[k] <= v : v.includes(r[k])));
    const executar = () => {
      chamadas.push({ tabela, op: st.op, filtros: st.filtros.map(([t, k, v]) => [t, k, v]), valor: st.valor });
      const linhas = tabelas[tabela];
      try {
        if (st.op === "insert") {
          // Como o default now() do banco: carimbo estritamente crescente (a ordem por iniciado_em é a ordem de inserção).
          const instante = () => new Date(Date.UTC(2026, 0, 1) + ++seqCarimbo).toISOString();
          const carimbo = tabela === "foody_sync_execucoes" ? { iniciado_em: instante() }
            : tabela === "foody_triagem_decisoes" ? { decidido_em: instante() } : {};
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
      gte(k, v) { st.filtros.push(["gte", k, v]); return b; },
      lte(k, v) { st.filtros.push(["lte", k, v]); return b; },
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

  // Mesmo contrato de foody_conexao_administrar (149).
  let relogio = 0;
  const agoraIso = () => new Date(Date.UTC(2026, 10, 1) + ++relogio * 1000).toISOString();
  function administrar(p) {
    const recusa = (codigo, code = "42501") => ({ data: null, error: { code, message: `foody_conexao_administrar: ${codigo} — recusado` } });
    if (!["CADASTRAR", "SUBSTITUIR_TOKEN", "ATIVAR", "PAUSAR", "REVOGAR", "PONTO_COLETA"].includes(p.p_acao)) return recusa("ACAO_INVALIDA", "22023");
    if (!p.p_ator || !papeis.has(`${p.p_ator}|${p.p_organizacao_id}`)) return recusa("SEM_PERMISSAO");
    if (unidades[p.p_unidade_id] !== p.p_organizacao_id) return recusa("UNIDADE_FORA_DA_ORGANIZACAO");
    const cs = tabelas.foody_conexoes;
    const c = cs.find((x) => x.unidade_id === p.p_unidade_id);
    if (c && c.organizacao_id !== p.p_organizacao_id) return recusa("SEM_PERMISSAO");
    const destinoVivo = (filtro) => tabelas.foody_conexao_destinos.some((d) => filtro(d) && d.estado !== "REVOGADO");
    const evento = (conexao, ev, anterior, novo, extra = {}) => tabelas.foody_conexoes_eventos.push({ id: randomUUID(), conexao_id: conexao.id,
      organizacao_id: p.p_organizacao_id, unidade_id: p.p_unidade_id, evento: ev, ator_perfil_id: p.p_ator, status_anterior: anterior ?? null,
      status_novo: novo, token_impressao: null, motivo: p.p_motivo ?? null, criado_em: agoraIso(), ...extra });
    const ok = (resultado, conexao, status, ev) => ({ data: [{ resultado, conexao_id: conexao.id, status, evento: ev }], error: null });
    const ponto = String(p.p_ponto_coleta ?? "").trim().slice(0, 120) || null;
    if (["CADASTRAR", "SUBSTITUIR_TOKEN"].includes(p.p_acao)) {
      if (!/^k[0-9]+:/.test(String(p.p_token_cifrado ?? "")) || !/^[0-9a-f]{12}$/.test(String(p.p_token_impressao ?? ""))) return recusa("TOKEN_INVALIDO", "22023");
      if (cs.some((x) => x.token_impressao === p.p_token_impressao && x.status !== "REVOGADA" && x.unidade_id !== p.p_unidade_id)) return recusa("CONTA_JA_CONECTADA", "23505");
      if (destinoVivo((d) => d.unidade_id === p.p_unidade_id)) return recusa("DESTINO_VIVO");
    }
    if (p.p_acao === "CADASTRAR") {
      if (c && c.status !== "REVOGADA") return recusa("CONEXAO_EXISTENTE", "23505");
      if (c) {
        const anterior = c.status;
        Object.assign(c, { token_cifrado: p.p_token_cifrado, token_impressao: p.p_token_impressao, status: "PAUSADA", ponto_coleta_esperado: ponto, ultimo_erro_codigo: null, atualizado_em: agoraIso() });
        evento(c, "RECONECTADA", anterior, "PAUSADA", { token_impressao: p.p_token_impressao });
        return ok("REGISTRADO", c, "PAUSADA", "RECONECTADA");
      }
      const nova = { id: randomUUID(), organizacao_id: p.p_organizacao_id, unidade_id: p.p_unidade_id, status: "PAUSADA", token_cifrado: p.p_token_cifrado,
        token_impressao: p.p_token_impressao, ponto_coleta_esperado: ponto, criado_por: p.p_ator, criado_em: agoraIso(), atualizado_em: agoraIso() };
      cs.push(nova);
      evento(nova, "CADASTRADA", null, "PAUSADA", { token_impressao: p.p_token_impressao });
      return ok("REGISTRADO", nova, "PAUSADA", "CADASTRADA");
    }
    if (!c) return recusa("SEM_CONEXAO", "22023");
    if (c.status === "REVOGADA") return recusa("CONEXAO_REVOGADA", "22023");
    if (p.p_acao === "SUBSTITUIR_TOKEN") {
      if (p.p_token_impressao === c.token_impressao) return ok("SEM_MUDANCA", c, c.status, null);
      if (destinoVivo((d) => d.conexao_id === c.id)) return recusa("COMPARTILHAMENTO_VIVO");
      const anterior = c.status;
      Object.assign(c, { token_cifrado: p.p_token_cifrado, token_impressao: p.p_token_impressao, status: "PAUSADA", ultimo_erro_codigo: null });
      evento(c, "TOKEN_SUBSTITUIDO", anterior, "PAUSADA", { token_impressao: p.p_token_impressao });
      return ok("REGISTRADO", c, "PAUSADA", "TOKEN_SUBSTITUIDO");
    }
    if (p.p_acao === "PONTO_COLETA") {
      if (ponto === (c.ponto_coleta_esperado ?? null)) return ok("SEM_MUDANCA", c, c.status, null);
      c.ponto_coleta_esperado = ponto;
      evento(c, "PONTO_COLETA_ALTERADO", c.status, c.status);
      return ok("REGISTRADO", c, c.status, "PONTO_COLETA_ALTERADO");
    }
    const novo = { ATIVAR: "ATIVA", PAUSAR: "PAUSADA", REVOGAR: "REVOGADA" }[p.p_acao];
    const ev = { ATIVAR: "ATIVADA", PAUSAR: "PAUSADA", REVOGAR: "REVOGADA" }[p.p_acao];
    if (p.p_acao === "REVOGAR" && String(p.p_motivo ?? "").trim().length < 3) return recusa("MOTIVO_INVALIDO", "22023");
    if (c.status === novo) return ok("SEM_MUDANCA", c, c.status, null);
    if ((p.p_acao === "ATIVAR" && !["PAUSADA", "ERRO"].includes(c.status)) || (p.p_acao === "PAUSAR" && !["ATIVA", "ERRO"].includes(c.status))) return recusa("TRANSICAO_INVALIDA", "22023");
    const anterior = c.status;
    c.status = novo;
    evento(c, ev, anterior, novo);
    // 148: conexão revogada derruba os destinos vivos.
    if (novo === "REVOGADA") for (const d of tabelas.foody_conexao_destinos) if (d.conexao_id === c.id && d.estado !== "REVOGADO") Object.assign(d, { estado: "REVOGADO", revogado_motivo: "Conexão revogada.", revogado_em: agoraIso(), revogado_por: null });
    return ok("REGISTRADO", c, novo, ev);
  }

  return {
    tabelas, chamadas, papeis,
    from: (t) => {
      if (!(t in tabelas)) throw new Error(`fake-db: tabela inesperada ${t}`);
      return builder(t);
    },
    rpc: async (nome, params) => {
      chamadas.push({ rpc: nome, params });
      if (nome === "foody_conexao_administrar") return administrar(params);
      if (nome !== "foody_fechamento_registrar") return { data: null, error: { code: "42883", message: `rpc inesperada ${nome}` } };
      return registrar(params);
    },
  };
}
