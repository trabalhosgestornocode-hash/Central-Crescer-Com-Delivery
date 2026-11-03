// Repositório da camada central Foody. Recebe o cliente de banco por injeção (supabase-js com service_role em produção,
// fake em memória nos testes) — este arquivo NÃO importa config/supabase.js, então importar o módulo não abre conexão.
//
// ISOLAMENTO: TODA leitura e escrita filtra por organizacao_id E unidade_id; toda linha gravada recebe os dois do contexto
// da execução (nunca do payload da API). O banco reforça com triggers de tenant (migration 144).

const LOTE = 200;
const PAGINA_LEITURA = 1000;

export class FoodyRepoErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyRepoErro"; this.codigo = codigo; }
}
const falha = (operacao, error) => new FoodyRepoErro("BANCO", `${operacao}: ${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 160)}`.trim());

function exigirTenant({ organizacaoId, unidadeId }) {
  if (!organizacaoId || !unidadeId) throw new FoodyRepoErro("TENANT_AUSENTE", "organização e unidade são obrigatórias.");
}

export function criarRepositorioFoody(db) {
  if (!db || typeof db.from !== "function") throw new TypeError("criarRepositorioFoody: cliente de banco obrigatório.");

  return {
    async obterConexao(t) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_conexoes")
        .select("id, organizacao_id, unidade_id, status, token_cifrado, token_impressao, ponto_coleta_esperado")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).maybeSingle();
      if (error) throw falha("obterConexao", error);
      return data ?? null;
    },

    async marcarConexao(t, conexaoId, campos) {
      exigirTenant(t);
      const permitidos = {};
      for (const k of ["status", "ultimo_erro_codigo", "ultima_sync_em"]) if (k in campos) permitidos[k] = campos[k];
      const { error } = await db.from("foody_conexoes").update({ ...permitidos, atualizado_em: new Date().toISOString() })
        .eq("id", conexaoId).eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId);
      if (error) throw falha("marcarConexao", error);
    },

    async abrirExecucao(t, linha) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_sync_execucoes")
        .insert({ ...linha, organizacao_id: t.organizacaoId, unidade_id: t.unidadeId, status: "EM_ANDAMENTO" })
        .select("id").single();
      if (error) throw falha("abrirExecucao", error);
      return data.id;
    },

    async concluirExecucao(t, execucaoId, campos) {
      exigirTenant(t);
      const { error } = await db.from("foody_sync_execucoes").update({ ...campos, concluido_em: new Date().toISOString() })
        .eq("id", execucaoId).eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId);
      if (error) throw falha("concluirExecucao", error);
    },

    /** uid → { fonte_hash, primeira_execucao_id } dos pedidos já gravados desta unidade. */
    async carregarExistentes(t, uids) {
      exigirTenant(t);
      const mapa = new Map();
      for (let i = 0; i < uids.length; i += LOTE) {
        const { data, error } = await db.from("foody_pedidos").select("foody_uid, fonte_hash, primeira_execucao_id")
          .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).in("foody_uid", uids.slice(i, i + LOTE));
        if (error) throw falha("carregarExistentes", error);
        for (const r of data ?? []) mapa.set(r.foody_uid, r);
      }
      return mapa;
    },

    async listarUidsDaCompetencia(t, competencia) {
      exigirTenant(t);
      return (await this.listarPedidosDaCompetencia(t, competencia, "foody_uid")).map((r) => r.foody_uid);
    },

    async gravarPedidos(t, linhas) {
      exigirTenant(t);
      for (const l of linhas) {
        if (l.organizacao_id !== t.organizacaoId || l.unidade_id !== t.unidadeId) {
          throw new FoodyRepoErro("TENANT_DIVERGENTE", "linha de pedido com tenant diferente do contexto da execução.");
        }
      }
      for (let i = 0; i < linhas.length; i += LOTE) {
        const { error } = await db.from("foody_pedidos").upsert(linhas.slice(i, i + LOTE), { onConflict: "unidade_id,foody_uid" });
        if (error) throw falha("gravarPedidos", error);
      }
    },

    async listarPedidosDaCompetencia(t, competencia, colunas = "*") {
      exigirTenant(t);
      const todos = [];
      for (let de = 0; ; de += PAGINA_LEITURA) {
        const { data, error } = await db.from("foody_pedidos").select(colunas)
          .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("competencia", competencia)
          .order("foody_uid", { ascending: true }).range(de, de + PAGINA_LEITURA - 1);
        if (error) throw falha("listarPedidosDaCompetencia", error);
        todos.push(...(data ?? []));
        if (!data || data.length < PAGINA_LEITURA) break;
      }
      return todos;
    },

    async ultimoFechamento(t, competencia) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_fechamentos_logisticos").select("id, versao, status, estado_valores, hash_conteudo")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("competencia", competencia)
        .order("versao", { ascending: false }).limit(1).maybeSingle();
      if (error) throw falha("ultimoFechamento", error);
      return data ?? null;
    },

    async registrarFechamento(t, p) {
      exigirTenant(t);
      const { data, error } = await db.rpc("foody_fechamento_registrar", {
        p_organizacao_id: t.organizacaoId, p_unidade_id: t.unidadeId, p_competencia: p.competencia, p_status: p.status,
        p_estado_valores: p.estadoValores, p_execucao_id: p.execucaoId, p_sync_execucao_id: p.syncExecucaoId ?? null,
        p_regra_versao: p.regraVersao, p_origem: p.origem, p_gerado_por: p.geradoPor ?? null, p_motivo: p.motivo ?? null,
        p_cobertura: p.cobertura, p_indicadores: p.indicadores, p_outras_operacoes: p.outrasOperacoes, p_pendencias: p.pendencias,
        p_hash: p.hash,
      });
      if (error) throw falha("registrarFechamento", error);
      const linha = Array.isArray(data) ? data[0] : data;
      return { resultado: linha?.resultado, fechamentoId: linha?.fechamento_id, versao: linha?.versao_registrada, status: linha?.status_registrado };
    },
  };
}
