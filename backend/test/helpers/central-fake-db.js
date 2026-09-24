// Supabase FALSO em memória para os testes da Central de Comunicação. Sem rede, sem banco. Suporta o subconjunto que o código da Central usa:
//   from(t).select().eq/neq/in/is/gt/gte/lt/lte/not/order/limit/range/maybeSingle/single, insert/update/upsert/delete, e rpc().
// A semântica das funções SQL da migration 096 (registrar idempotente + purga, marcar lida com greatest, resumo) é reproduzida aqui para que os testes
// de comportamento não dependam de banco. A migration em si só é validada num banco real (ver o relatório): estes testes provam a LÓGICA do backend.
import { randomUUID } from "node:crypto";

const ehIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
const cmp = (a, b) => {
  if (ehIso(a) && ehIso(b)) return Date.parse(a) - Date.parse(b);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

export function criarFakeDb(inicial = {}, { rpc = {} } = {}) {
  const tabelas = {};
  for (const [nome, linhas] of Object.entries(inicial)) tabelas[nome] = linhas.map((l) => ({ ...l }));
  const chamadasRpc = [];
  const consultas = [];

  const linhasDe = (t) => (tabelas[t] ??= []);

  function from(tabela) {
    const filtros = []; let ordem = null; let limite = null; let faixa = null; let modo = "select"; let payload = null; let opcoes = null;
    const casa = (r) => filtros.every(([op, col, val]) => {
      const x = r[col];
      switch (op) {
        case "eq": return x === val;
        case "neq": return x !== val;
        case "in": return val.includes(x);
        case "is": return val === null ? (x === null || x === undefined) : x === val;
        case "gt": return x != null && cmp(x, val) > 0;
        case "gte": return x != null && cmp(x, val) >= 0;
        case "lt": return x != null && cmp(x, val) < 0;
        case "lte": return x != null && cmp(x, val) <= 0;
        case "notin": return !val.includes(x);
        default: return true;
      }
    });
    const executar = () => {
      consultas.push({ tabela, modo, filtros: filtros.map((f) => [...f]) });
      if (modo === "insert") {
        const lista = Array.isArray(payload) ? payload : [payload];
        const novas = lista.map((p) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...p }));
        for (const n of novas) {
          const chaves = opcoes?.unicas ?? [];
          if (chaves.some((c) => linhasDe(tabela).some((r) => r[c] !== undefined && r[c] === n[c]))) return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        linhasDe(tabela).push(...novas);
        return { data: novas, error: null };
      }
      if (modo === "update") {
        const alvo = linhasDe(tabela).filter(casa);
        for (const r of alvo) Object.assign(r, payload);
        return { data: alvo.map((r) => ({ ...r })), error: null };
      }
      if (modo === "delete") {
        const alvo = new Set(linhasDe(tabela).filter(casa));
        tabelas[tabela] = linhasDe(tabela).filter((r) => !alvo.has(r));
        return { data: [...alvo], error: null };
      }
      let r = linhasDe(tabela).filter(casa).map((l) => ({ ...l }));
      if (ordem) r.sort((a, b) => cmp(a[ordem.col], b[ordem.col]) * (ordem.asc ? 1 : -1));
      if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
      if (limite != null) r = r.slice(0, limite);
      return { data: r, error: null };
    };
    const b = {
      select: () => (modo === "select" ? b : b), // após insert/update, select() só devolve as linhas afetadas
      eq: (c, v) => (filtros.push(["eq", c, v]), b), neq: (c, v) => (filtros.push(["neq", c, v]), b),
      in: (c, v) => (filtros.push(["in", c, v]), b), is: (c, v) => (filtros.push(["is", c, v]), b),
      gt: (c, v) => (filtros.push(["gt", c, v]), b), gte: (c, v) => (filtros.push(["gte", c, v]), b),
      lt: (c, v) => (filtros.push(["lt", c, v]), b), lte: (c, v) => (filtros.push(["lte", c, v]), b),
      not: (c, op, v) => { if (op === "in") filtros.push(["notin", c, String(v).replace(/[()]/g, "").split(",").filter(Boolean)]); return b; },
      order: (col, o = {}) => { ordem = { col, asc: o.ascending !== false }; return b; },
      limit: (n) => { limite = n; return b; }, range: (a, z) => { faixa = [a, z]; return b; },
      maybeSingle: () => { const r = executar(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      single: () => { const r = executar(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { message: "no rows" }) }); },
      insert: (p) => { modo = "insert"; payload = p; opcoes = { unicas: tabelaUnicas[tabela] ?? [] }; return b; },
      update: (p) => { modo = "update"; payload = p; return b; },
      delete: () => { modo = "delete"; return b; },
      upsert: (p, o = {}) => {
        const chave = String(o.onConflict ?? "id").split(",");
        const lista = Array.isArray(p) ? p : [p];
        for (const n of lista) {
          const i = linhasDe(tabela).findIndex((r) => chave.every((c) => r[c] === n[c]));
          if (i >= 0) Object.assign(linhasDe(tabela)[i], n); else linhasDe(tabela).push({ ...n });
        }
        return Promise.resolve({ data: lista, error: null });
      },
      then: (res, rej) => Promise.resolve(executar()).then(res, rej),
    };
    return b;
  }

  const tabelaUnicas = { comunicacao_mensagens: ["idempotency_key"] };

  // ---- semântica das funções SQL da 096 ----
  const funcoes = {
    comunicacao_inbox_registrar: (a) => {
      // defesa em profundidade da 096: só contato do roster (a organização da tabela é a da CONEXÃO, não a do responsável)
      if (!linhasDe("comunicacao_roster_autorizado").some((r) => r.contato_id === a.p_contato_id)) return { data: null, error: { code: "P0001", message: "contato nao autorizado" } };
      const t = linhasDe("comunicacao_inbox_mensagens");
      const existente = t.find((r) => r.organizacao_id === a.p_organizacao_id && r.provider_message_id === a.p_provider_message_id);
      const limiteCorte = Date.now() - Math.max(a.p_retencao_dias ?? 30, 1) * 86_400_000;
      let inserido = false; let id;
      if (existente) id = existente.id;
      else {
        if (a.p_origem_tipo !== "LIVE" && a.p_origem_tipo !== "OFFLINE_NORMAL") return { data: null, error: { code: "23514", message: "origem" } };
        if (a.p_tipo_conteudo === "texto" ? (typeof a.p_texto !== "string" || a.p_texto.length < 1 || a.p_texto.length > 4096) : a.p_texto !== null) return { data: null, error: { code: "23514", message: "texto" } };
        id = randomUUID(); inserido = true;
        t.push({ id, organizacao_id: a.p_organizacao_id, contato_id: a.p_contato_id, provider_message_id: a.p_provider_message_id, origem_tipo: a.p_origem_tipo, tipo_conteudo: a.p_tipo_conteudo, texto: a.p_texto, recebido_em: a.p_recebido_em, created_at: new Date().toISOString() });
      }
      tabelas.comunicacao_inbox_mensagens = linhasDe("comunicacao_inbox_mensagens").filter((r) => !(r.organizacao_id === a.p_organizacao_id && Date.parse(r.recebido_em) < limiteCorte));
      return { data: [{ inserido, id }], error: null };
    },
    comunicacao_inbox_marcar_lida: (a) => {
      const t = linhasDe("comunicacao_inbox_leituras");
      const l = t.find((r) => r.organizacao_id === a.p_organizacao_id && r.contato_id === a.p_contato_id);
      if (l) { if (Date.parse(a.p_ate) > Date.parse(l.lida_ate)) l.lida_ate = a.p_ate; l.lida_por = a.p_por; } else t.push({ organizacao_id: a.p_organizacao_id, contato_id: a.p_contato_id, lida_ate: a.p_ate, lida_por: a.p_por });
      return { data: null, error: null };
    },
    comunicacao_inbox_purgar: (a) => {
      const corte = Date.now() - Math.max(a.p_retencao_dias ?? 30, 1) * 86_400_000;
      const antes = linhasDe("comunicacao_inbox_mensagens").length;
      tabelas.comunicacao_inbox_mensagens = linhasDe("comunicacao_inbox_mensagens").filter((r) => Date.parse(r.recebido_em) >= corte);
      return { data: antes - tabelas.comunicacao_inbox_mensagens.length, error: null };
    },
    comunicacao_inbox_resumo: (a) => {
      const corteR = Date.now() - Math.max(a.p_retencao_dias ?? 30, 1) * 86_400_000;
      const msgs = linhasDe("comunicacao_inbox_mensagens").filter((m) => m.organizacao_id === a.p_organizacao_id && Date.parse(m.recebido_em) >= corteR);
      const por = new Map();
      for (const m of msgs) { if (!por.has(m.contato_id)) por.set(m.contato_id, []); por.get(m.contato_id).push(m); }
      const data = [...por.entries()].map(([contato_id, l]) => {
        const lida = linhasDe("comunicacao_inbox_leituras").find((x) => x.organizacao_id === a.p_organizacao_id && x.contato_id === contato_id)?.lida_ate;
        const ord = [...l].sort((x, y) => Date.parse(y.recebido_em) - Date.parse(x.recebido_em));
        return { contato_id, nao_lidas: l.filter((m) => !lida || Date.parse(m.recebido_em) > Date.parse(lida)).length, ultima_recebida_em: ord[0].recebido_em, ultima_texto: ord[0].texto, ultimo_tipo: ord[0].tipo_conteudo };
      });
      return { data, error: null };
    },
  };

  // ---- semântica das RPCs FENCED do outbox (087): só o dono do claim (worker + claim_geracao) avança a linha ----
  Object.assign(funcoes, {
    comunicacao_iniciar_envio: (a) => {
      const m = linhasDe("comunicacao_mensagens").find((r) => r.id === a.p_id && r.status === "PROCESSING" && r.claimed_by === a.p_worker && r.claim_geracao === a.p_claim_geracao && Date.parse(r.claim_expira_em) > Date.now());
      if (!m) return { data: [], error: null };
      Object.assign(m, { status: "SENDING", tentativas: (m.tentativas ?? 0) + 1, claim_expira_em: new Date(Date.now() + (a.p_lease_segundos ?? 90) * 1000).toISOString(), updated_at: new Date().toISOString() });
      return { data: [{ ...m }], error: null };
    },
    comunicacao_finalizar_envio: (a) => {
      const m = linhasDe("comunicacao_mensagens").find((r) => r.id === a.p_id && r.status === "SENDING" && r.claimed_by === a.p_worker && r.claim_geracao === a.p_claim_geracao && r.tentativas === a.p_tentativa);
      if (!m) return { data: [], error: null };
      const agora = new Date().toISOString();
      if (a.p_resultado === "SENT") Object.assign(m, { status: "SENT", enviado_em: agora, provider_message_id: a.p_provider_message_id });
      else if (a.p_resultado === "FAILED") Object.assign(m, { status: "FAILED", falhou_em: agora, erro: a.p_erro });
      else if (a.p_resultado === "DELIVERY_UNKNOWN") Object.assign(m, { status: "DELIVERY_UNKNOWN", entrega_incerta_em: agora, erro: a.p_erro });
      m.updated_at = agora;
      return { data: [{ ...m }], error: null };
    },
  });

  // ---- semântica das funções da 097 (trava de operação da conexão do WhatsApp) ----
  Object.assign(funcoes, {
    whatsapp_operacao_iniciar: (a) => {
      const t = linhasDe("whatsapp_identidade");
      let r = t.find((x) => x.organizacao_id === a.p_organizacao_id && x.provider_instance_id === a.p_provider_instance_id);
      if (!r) { r = { organizacao_id: a.p_organizacao_id, provider_instance_id: a.p_provider_instance_id, ambiente: "TESTE", status: "SEM_CONTA", operacao_id: null, operacao_tipo: null, operacao_por: null, operacao_expira_em: null }; t.push(r); }
      if (r.operacao_id == null || Date.parse(r.operacao_expira_em) < Date.now()) {
        Object.assign(r, { operacao_id: randomUUID(), operacao_tipo: a.p_tipo, operacao_por: a.p_por, operacao_expira_em: new Date(Date.now() + Math.max(a.p_ttl_segundos ?? 300, 30) * 1000).toISOString() });
        return { data: [{ iniciada: true, operacao_id: r.operacao_id, operacao_tipo: r.operacao_tipo }], error: null };
      }
      return { data: [{ iniciada: false, operacao_id: r.operacao_id, operacao_tipo: r.operacao_tipo }], error: null };
    },
    whatsapp_operacao_encerrar: (a) => {
      const r = linhasDe("whatsapp_identidade").find((x) => x.organizacao_id === a.p_organizacao_id && x.provider_instance_id === a.p_provider_instance_id && x.operacao_id === a.p_operacao_id);
      if (!r) return { data: false, error: null };
      Object.assign(r, { operacao_id: null, operacao_tipo: null, operacao_por: null, operacao_expira_em: null });
      return { data: true, error: null };
    },
  });

  const rpcFn = async (nome, args) => {
    chamadasRpc.push({ nome, args });
    const impl = rpc[nome] ?? funcoes[nome];
    if (!impl) return { data: null, error: { message: `rpc não simulada: ${nome}` } };
    return impl(args, tabelas);
  };

  return { from, rpc: rpcFn, tabelas, chamadasRpc, consultas };
}

/** Linhas da view comunicacao_roster_autorizado (uma por contato × empresa × unidade). */
export function linhaRoster(o = {}) {
  return {
    contato_id: "c1", telefone_e164: "+5511999990001", consentimento: true, verificado: true, opt_out: false,
    perfil_id: "p1", perfil_nome: "Maria Souza", organizacao_id: "o1", organizacao_nome: "Loja Centro", papel: "organization_admin", unidade_id: null, unidade_nome: null, ...o,
  };
}
