// Repositório da camada central Foody. Recebe o cliente de banco por injeção (supabase-js com service_role em produção,
// fake em memória nos testes) — este arquivo NÃO importa config/supabase.js, então importar o módulo não abre conexão.
//
// ISOLAMENTO: TODA leitura e escrita filtra por organizacao_id E unidade_id; toda linha gravada recebe os dois do contexto
// da execução (nunca do payload da API). O banco reforça com triggers de tenant (migration 144).
// CONEXÃO COMPARTILHADA (145): as leituras "da conexão" filtram por conexao_id e CONFEREM que cada linha devolvida está num
// tenant autorizado (titular ou destino da própria conexão) — linha de qualquer outro tenant aborta a operação.

const LOTE = 200;
const PAGINA_LEITURA = 1000;

export class FoodyRepoErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyRepoErro"; this.codigo = codigo; }
}
const falha = (operacao, error) => new FoodyRepoErro("BANCO", `${operacao}: ${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 160)}`.trim());

function exigirTenant({ organizacaoId, unidadeId }) {
  if (!organizacaoId || !unidadeId) throw new FoodyRepoErro("TENANT_AUSENTE", "organização e unidade são obrigatórias.");
}
const chave = (org, uni) => `${org}|${uni}`;
function exigirTenantsPermitidos(linhas, permitidos, operacao) {
  for (const r of linhas) {
    if (!permitidos.has(chave(r.organizacao_id, r.unidade_id))) {
      throw new FoodyRepoErro("TENANT_DIVERGENTE", `${operacao}: linha da conexão fora dos tenants autorizados.`);
    }
  }
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
    async carregarExistentes(t, uids, colunas = "foody_uid, fonte_hash, primeira_execucao_id") {
      exigirTenant(t);
      const mapa = new Map();
      for (let i = 0; i < uids.length; i += LOTE) {
        const { data, error } = await db.from("foody_pedidos").select(colunas)
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

    // ------------------------------------------------------------------ conexão compartilhada (145)

    /** Destinos (todos os estados) da conexão da unidade titular `t`. */
    async listarDestinosDaConexao(t, conexaoId) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_conexao_destinos")
        .select("id, conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id")
        .eq("conexao_id", conexaoId).eq("organizacao_titular_id", t.organizacaoId);
      if (error) throw falha("listarDestinosDaConexao", error);
      return data ?? [];
    },

    /** uid → linha ATIVA do pedido na conexão (em qualquer tenant autorizado). */
    async carregarAtivosDaConexao(conexaoId, uids, permitidos) {
      const mapa = new Map();
      for (let i = 0; i < uids.length; i += LOTE) {
        const { data, error } = await db.from("foody_pedidos")
          .select("foody_uid, organizacao_id, unidade_id, destino_id, operacao, fonte_hash, primeira_execucao_id")
          .eq("conexao_id", conexaoId).eq("roteamento_ativo", true).in("foody_uid", uids.slice(i, i + LOTE));
        if (error) throw falha("carregarAtivosDaConexao", error);
        exigirTenantsPermitidos(data ?? [], permitidos, "carregarAtivosDaConexao");
        for (const r of data ?? []) {
          // Invariante da 145 (índice único global): um uid ativo em DOIS tenants nunca é "consertado" em silêncio.
          if (mapa.has(r.foody_uid)) throw new FoodyRepoErro("INTEGRIDADE", "carregarAtivosDaConexao: pedido ativo em dois tenants.");
          mapa.set(r.foody_uid, r);
        }
      }
      return mapa;
    },

    /** uids ATIVOS da conexão na competência (todos os tenants autorizados) — base dos "ausentes na API". */
    async listarUidsAtivosDaConexao(conexaoId, competencia, permitidos) {
      const todos = [];
      for (let de = 0; ; de += PAGINA_LEITURA) {
        const { data, error } = await db.from("foody_pedidos").select("foody_uid, organizacao_id, unidade_id")
          .eq("conexao_id", conexaoId).eq("roteamento_ativo", true).eq("competencia", competencia)
          .order("foody_uid", { ascending: true }).range(de, de + PAGINA_LEITURA - 1);
        if (error) throw falha("listarUidsAtivosDaConexao", error);
        exigirTenantsPermitidos(data ?? [], permitidos, "listarUidsAtivosDaConexao");
        todos.push(...(data ?? []).map((r) => r.foody_uid));
        if (!data || data.length < PAGINA_LEITURA) break;
      }
      return todos;
    },

    /** Desativa (sem apagar) as linhas de `uids` no tenant `t`: deixam de ser a linha ativa e perdem o dado comercial. */
    async desativarPedidos(t, conexaoId, uids, motivo, camposZerados) {
      exigirTenant(t);
      if (!/^[A-Z_]{2,40}$/.test(String(motivo))) throw new FoodyRepoErro("MOTIVO_INVALIDO", "motivo de desativação inválido.");
      const valores = { roteamento_ativo: false, roteamento_motivo: motivo, atualizado_em: new Date().toISOString() };
      for (const k of camposZerados) valores[k] = null;
      for (let i = 0; i < uids.length; i += LOTE) {
        const { error } = await db.from("foody_pedidos").update(valores)
          .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("conexao_id", conexaoId)
          .in("foody_uid", uids.slice(i, i + LOTE));
        if (error) throw falha("desativarPedidos", error);
      }
    },

    /** uid → última decisão de triagem (somente inclusão; vale a mais recente). Tenant = titular da conexão. */
    async listarDecisoesTriagem(t, conexaoId, uids) {
      exigirTenant(t);
      const mapa = new Map();
      for (let i = 0; i < uids.length; i += LOTE) {
        const { data, error } = await db.from("foody_triagem_decisoes")
          .select("foody_uid, operacao_decidida, decidido_em, decidido_por, catalogo_versao")
          .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("conexao_id", conexaoId)
          .in("foody_uid", uids.slice(i, i + LOTE));
        if (error) throw falha("listarDecisoesTriagem", error);
        for (const r of data ?? []) {
          const ant = mapa.get(r.foody_uid);
          if (!ant || String(r.decidido_em) > String(ant.decidido_em)) mapa.set(r.foody_uid, r);
        }
      }
      return mapa;
    },

    // ------------------------------------------------------------------ vínculo e triagem (serviço de compartilhamento)
    // Leituras por id: quem chama (foody.compartilhamento.service.js) confere a organização do ator contra a linha devolvida.

    async obterConexaoPorId(conexaoId) {
      const { data, error } = await db.from("foody_conexoes").select("id, organizacao_id, unidade_id, status").eq("id", conexaoId).maybeSingle();
      if (error) throw falha("obterConexaoPorId", error);
      return data ?? null;
    },

    async obterDestino(destinoId) {
      const { data, error } = await db.from("foody_conexao_destinos")
        .select("id, conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id, aprovado_titular_por")
        .eq("id", destinoId).maybeSingle();
      if (error) throw falha("obterDestino", error);
      return data ?? null;
    },

    async inserirDestino(linha) {
      const { data, error } = await db.from("foody_conexao_destinos").insert(linha).select("id, estado").single();
      if (error) throw falha("inserirDestino", error);
      return data;
    },

    /** Atualiza o destino SÓ se ele ainda estiver no estado esperado (corrida entre duas aprovações/revogações). */
    async atualizarDestino(destino, estadoEsperado, campos) {
      const { data, error } = await db.from("foody_conexao_destinos").update(campos)
        .eq("id", destino.id).eq("conexao_id", destino.conexao_id).eq("organizacao_id", destino.organizacao_id)
        .eq("unidade_id", destino.unidade_id).eq("estado", estadoEsperado).select("id, estado");
      if (error) throw falha("atualizarDestino", error);
      return (data ?? [])[0] ?? null;
    },

    /** Linha ATIVA de um uid na conexão (qualquer tenant autorizado). */
    async obterPedidoAtivoDaConexao(conexaoId, foodyUid, permitidos) {
      const { data, error } = await db.from("foody_pedidos").select("foody_uid, organizacao_id, unidade_id, operacao, destino_id")
        .eq("conexao_id", conexaoId).eq("roteamento_ativo", true).eq("foody_uid", foodyUid);
      if (error) throw falha("obterPedidoAtivoDaConexao", error);
      exigirTenantsPermitidos(data ?? [], permitidos, "obterPedidoAtivoDaConexao");
      return (data ?? [])[0] ?? null;
    },

    /** Pedidos em TRIAGEM (ativos) da conexão numa competência — só na titular; sem dado comercial (a linha não tem). */
    async listarTriagem(t, conexaoId, competencia) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_pedidos")
        .select("foody_uid, numero_pedido, competencia, data_hora, detalhes_pedido, triagem_motivo, catalogo_versao, situacao")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("conexao_id", conexaoId)
        .eq("operacao", "triagem").eq("roteamento_ativo", true).eq("competencia", competencia)
        .order("foody_uid", { ascending: true }).range(0, PAGINA_LEITURA - 1);
      if (error) throw falha("listarTriagem", error);
      return data ?? [];
    },

    async inserirDecisaoTriagem(t, linha) {
      exigirTenant(t);
      if (linha.organizacao_id !== t.organizacaoId || linha.unidade_id !== t.unidadeId) {
        throw new FoodyRepoErro("TENANT_DIVERGENTE", "decisão de triagem fora do tenant da conexão.");
      }
      const { data, error } = await db.from("foody_triagem_decisoes").insert(linha).select("id, decidido_em").single();
      if (error) throw falha("inserirDecisaoTriagem", error);
      return data;
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
