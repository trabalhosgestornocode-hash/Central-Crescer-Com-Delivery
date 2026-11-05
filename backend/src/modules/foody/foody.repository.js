// Repositório da camada central Foody. Recebe o cliente de banco por injeção (supabase-js com service_role em produção,
// fake em memória nos testes) — este arquivo NÃO importa config/supabase.js, então importar o módulo não abre conexão.
//
// ISOLAMENTO: TODA leitura e escrita filtra por organizacao_id E unidade_id; toda linha gravada recebe os dois do contexto
// da execução (nunca do payload da API). O banco reforça com triggers de tenant (migration 147).
// CONEXÃO COMPARTILHADA (148): as leituras "da conexão" filtram por conexao_id e CONFEREM que cada linha devolvida está num
// tenant autorizado (titular ou destino da própria conexão) — linha de qualquer outro tenant aborta a operação.

const LOTE = 200;
const PAGINA_LEITURA = 1000;

export class FoodyRepoErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyRepoErro"; this.codigo = codigo; }
}
// `pgCodigo` (SQLSTATE/PostgREST) fica no erro para quem precisa distinguir "objeto não existe" (migrations ainda não aplicadas).
const falha = (operacao, error) => Object.assign(
  new FoodyRepoErro("BANCO", `${operacao}: ${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 160)}`.trim()), { pgCodigo: error?.code ?? null });

// Códigos estáveis devolvidos pelo banco nas regras da 149 ("foody_conexao_administrar: CODIGO — texto" / "foody_conexoes: CODIGO —").
const CODIGOS_ADMIN = ["SEM_PERMISSAO", "UNIDADE_FORA_DA_ORGANIZACAO", "ACAO_INVALIDA", "TOKEN_INVALIDO", "MOTIVO_INVALIDO", "SEM_CONEXAO",
  "CONEXAO_EXISTENTE", "CONEXAO_REVOGADA", "CONTA_JA_CONECTADA", "DESTINO_VIVO", "COMPARTILHAMENTO_VIVO", "TRANSICAO_INVALIDA"];
function erroAdministracao(operacao, error) {
  const msg = String(error?.message ?? "");
  const codigo = CODIGOS_ADMIN.find((c) => msg.includes(`: ${c} `) || msg.endsWith(`: ${c}`))
    ?? (/uq_foody_conexoes_conta_ativa/.test(msg) ? "CONTA_JA_CONECTADA" : null)
    ?? (/uq_foody_conexoes_unidade/.test(msg) ? "CONEXAO_EXISTENTE" : null);
  if (codigo) {
    const texto = msg.split(" — ").slice(1).join(" — ").trim() || codigo;
    return new FoodyRepoErro(codigo, texto.slice(0, 200));
  }
  return falha(operacao, error);
}
// Recusas do banco no vínculo e na triagem (148) → código estável para a tela explicar o motivo (sem eco de SQL).
const RECUSAS_VINCULO = [
  [/já tem conexão Foody própria/, "DESTINO_COM_CONEXAO_PROPRIA", "a unidade de destino já tem conexão Foody própria (seria contagem dupla)."],
  [/uq_foody_destino_conexao_operacao/, "VINCULO_EXISTENTE", "esta conexão já tem um compartilhamento vivo para essa operação."],
  [/uq_foody_destino_unidade_operacao/, "DESTINO_JA_VINCULADO", "a unidade de destino já recebe essa operação de outra conexão."],
  [/ato separado/, "ATO_SEPARADO", "a aprovação do destino precisa ser um ato separado da proposta."],
  [/conexão não está ATIVA/, "CONEXAO_INATIVA", "a conexão precisa estar ATIVA para o destino aprovar."],
  [/exige organization_admin|só organization_admin/, "SEM_PERMISSAO", "só um Administrador ativo da organização pode fazer isso."],
  [/revogado é definitivo|transição .* não permitida/, "ESTADO_INVALIDO", "o compartilhamento mudou de estado; recarregue."],
];
function erroVinculo(operacao, error) {
  const msg = String(error?.message ?? "");
  const achado = RECUSAS_VINCULO.find(([re]) => re.test(msg));
  return achado ? new FoodyRepoErro(achado[1], achado[2]) : falha(operacao, error);
}
/** Colunas da conexão que podem sair para a tela: NUNCA o token cifrado. */
const COLUNAS_CONEXAO_TELA = "id, organizacao_id, unidade_id, status, token_impressao, ponto_coleta_esperado, ultimo_erro_codigo, ultima_sync_em, criado_em, atualizado_em";
const COLUNAS_DESTINO_TELA = "id, conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id, aprovado_titular_por, aprovado_titular_em, "
  + "aprovado_destino_por, aprovado_destino_em, revogado_por, revogado_em, revogado_motivo, criado_em";

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

    /**
     * Execuções EM_ANDAMENTO desta UNIDADE (trava de concorrência da sincronização manual/agendada). O escopo é a unidade — de
     * QUALQUER conexão dela, inclusive revogada — porque é o mesmo escopo do índice único da 150: uma órfã de conexão antiga
     * que não fosse vista aqui nunca seria encerrada e bloquearia a unidade para sempre (23505 → CONCORRENCIA).
     * `_conexaoId` fica na assinatura só por compatibilidade; não filtra.
     */
    async listarExecucoesEmAndamento(t, _conexaoId) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_sync_execucoes").select("id, competencia, origem, iniciado_em, organizacao_id, unidade_id")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("status", "EM_ANDAMENTO")
        .order("iniciado_em", { ascending: false }).limit(20);
      if (error) throw falha("listarExecucoesEmAndamento", error);
      for (const r of data ?? []) if (r.organizacao_id !== t.organizacaoId || r.unidade_id !== t.unidadeId) throw falha("listarExecucoesEmAndamento", { code: "TENANT" });
      return data ?? [];
    },

    /**
     * Agendador: tenants (organização + unidade) das conexões ATIVAS cujas unidades estão na allowlist. Só ids e status —
     * nunca o token. A allowlist vem validada (uuid) de foody.flags.js.
     */
    async listarConexoesAtivasDaAllowlist(unidadeIds) {
      const ids = [...new Set([...(unidadeIds ?? [])].map((x) => String(x).toLowerCase()))];
      if (!ids.length) return [];
      const { data, error } = await db.from("foody_conexoes").select("organizacao_id, unidade_id, status")
        .in("unidade_id", ids).eq("status", "ATIVA").limit(ids.length);
      if (error) throw falha("listarConexoesAtivasDaAllowlist", error);
      return (data ?? []).filter((r) => r.status === "ATIVA" && ids.includes(String(r.unidade_id).toLowerCase()))
        .map((r) => ({ organizacaoId: r.organizacao_id, unidadeId: r.unidade_id }));
    },

    /** Últimas execuções da unidade (só contagens e códigos; nunca pedidos nem valores). */
    async listarExecucoesRecentes(t, limite = 20) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_sync_execucoes")
        .select("id, competencia, origem, status, paginas, pedidos_recebidos, pedidos_unicos, pedidos_fora_janela, pedidos_ponto_divergente, inseridos, atualizados, inalterados, erro_codigo, iniciado_em, concluido_em, fechamentos_pendentes, organizacao_id, unidade_id")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId)
        .order("iniciado_em", { ascending: false }).limit(Math.min(Math.max(1, limite), 100));
      if (error) throw falha("listarExecucoesRecentes", error);
      for (const r of data ?? []) if (r.organizacao_id !== t.organizacaoId || r.unidade_id !== t.unidadeId) throw falha("listarExecucoesRecentes", { code: "TENANT" });
      return data ?? [];
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

    // ------------------------------------------------------------------ conexão compartilhada (148)

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
          // Invariante da 148 (índice único global): um uid ativo em DOIS tenants nunca é "consertado" em silêncio.
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
          .select("id, foody_uid, operacao_decidida, decidido_em, decidido_por, motivo, catalogo_versao")
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
      if (error) throw erroVinculo("inserirDestino", error);
      return data;
    },

    /** Atualiza o destino SÓ se ele ainda estiver no estado esperado (corrida entre duas aprovações/revogações). */
    async atualizarDestino(destino, estadoEsperado, campos) {
      const { data, error } = await db.from("foody_conexao_destinos").update(campos)
        .eq("id", destino.id).eq("conexao_id", destino.conexao_id).eq("organizacao_id", destino.organizacao_id)
        .eq("unidade_id", destino.unidade_id).eq("estado", estadoEsperado).select("id, estado");
      if (error) throw erroVinculo("atualizarDestino", error);
      return (data ?? [])[0] ?? null;
    },

    /** Linha ATIVA de um uid na conexão (qualquer tenant autorizado). */
    async obterPedidoAtivoDaConexao(conexaoId, foodyUid, permitidos) {
      const { data, error } = await db.from("foody_pedidos").select("foody_uid, organizacao_id, unidade_id, operacao, destino_id, competencia")
        .eq("conexao_id", conexaoId).eq("roteamento_ativo", true).eq("foody_uid", foodyUid);
      if (error) throw falha("obterPedidoAtivoDaConexao", error);
      exigirTenantsPermitidos(data ?? [], permitidos, "obterPedidoAtivoDaConexao");
      return (data ?? [])[0] ?? null;
    },

    /** Pedidos em TRIAGEM (ativos) da conexão numa competência — só na titular; sem dado comercial (a linha não tem). */
    async listarTriagem(t, conexaoId, competencia) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_pedidos")
        .select("foody_uid, numero_pedido, competencia, data_hora, detalhes_pedido, operacao_motivo, triagem_motivo, catalogo_versao, situacao")
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
      if (error) throw erroVinculo("inserirDecisaoTriagem", error);
      return data;
    },

    /** Resultado do fechamento de cada organização a partir da execução (pendência durável do ciclo compartilhado). */
    async registrarFechamentosDaExecucao(t, execucaoId, fechamentos, pendentes) {
      exigirTenant(t);
      const { error } = await db.from("foody_sync_execucoes").update({ fechamentos, fechamentos_pendentes: pendentes })
        .eq("id", execucaoId).eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId);
      if (error) throw falha("registrarFechamentosDaExecucao", error);
    },

    /**
     * Competências da titular `t` (desde `desde`) cujo ciclo compartilhado NÃO terminou: a última execução concluída deixou
     * fechamento pendente, ou há pedido em triagem com decisão ainda não aplicada. Devolve [{ competencia, motivo }].
     */
    async listarCompetenciasParaReconciliar(t, desde) {
      exigirTenant(t);
      const out = new Map();
      const { data: execs, error } = await db.from("foody_sync_execucoes").select("competencia, fechamentos_pendentes, iniciado_em, status")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("status", "CONCLUIDA")
        .order("iniciado_em", { ascending: false }).range(0, PAGINA_LEITURA - 1);
      if (error) throw falha("listarCompetenciasParaReconciliar", error);
      const vistas = new Set();
      for (const e of execs ?? []) {
        const c = String(e.competencia).slice(0, 10);
        if (c < desde || vistas.has(c)) continue;
        vistas.add(c); // só a ÚLTIMA execução de cada dia decide
        if (Number(e.fechamentos_pendentes) > 0) out.set(c, "FECHAMENTO_PENDENTE");
      }
      const { data: tri, error: e2 } = await db.from("foody_pedidos").select("foody_uid, competencia, conexao_id")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("operacao", "triagem").eq("roteamento_ativo", true)
        .range(0, PAGINA_LEITURA - 1);
      if (e2) throw falha("listarCompetenciasParaReconciliar", e2);
      const triagem = (tri ?? []).filter((r) => String(r.competencia).slice(0, 10) >= desde);
      if (triagem.length) {
        const { data: decs, error: e3 } = await db.from("foody_triagem_decisoes").select("foody_uid")
          .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).in("foody_uid", triagem.map((r) => r.foody_uid));
        if (e3) throw falha("listarCompetenciasParaReconciliar", e3);
        const decididos = new Set((decs ?? []).map((d) => d.foody_uid));
        for (const r of triagem) if (decididos.has(r.foody_uid)) out.set(String(r.competencia).slice(0, 10), out.get(String(r.competencia).slice(0, 10)) ?? "DECISAO_DE_TRIAGEM");
      }
      return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([competencia, motivo]) => ({ competencia, motivo }));
    },

    // ------------------------------------------------------------------ administração pela tela (149)
    // Escrita SÓ pela função do banco (admin conferido em usuarios_organizacoes no momento da ação + evento na mesma transação).

    async administrarConexao(t, { acao, ator, tokenCifrado = null, tokenImpressao = null, pontoColeta = null, motivo = null }) {
      exigirTenant(t);
      const { data, error } = await db.rpc("foody_conexao_administrar", {
        p_acao: acao, p_organizacao_id: t.organizacaoId, p_unidade_id: t.unidadeId, p_ator: ator,
        p_token_cifrado: tokenCifrado, p_token_impressao: tokenImpressao, p_ponto_coleta: pontoColeta, p_motivo: motivo,
      });
      if (error) throw erroAdministracao("administrarConexao", error);
      const linha = Array.isArray(data) ? data[0] : data;
      return { resultado: linha?.resultado ?? null, conexaoId: linha?.conexao_id ?? null, status: linha?.status ?? null, evento: linha?.evento ?? null };
    },

    /** Conexão da unidade para a tela — sem o token cifrado. */
    async obterConexaoParaTela(t) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_conexoes").select(COLUNAS_CONEXAO_TELA)
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).maybeSingle();
      if (error) throw falha("obterConexaoParaTela", error);
      return data ?? null;
    },

    /** Destinos da conexão da titular (todos os estados, para o histórico do vínculo). */
    async listarDestinosDaTitular(t, conexaoId) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_conexao_destinos").select(COLUNAS_DESTINO_TELA)
        .eq("conexao_id", conexaoId).eq("organizacao_titular_id", t.organizacaoId)
        .order("criado_em", { ascending: false }).range(0, 49);
      if (error) throw falha("listarDestinosDaTitular", error);
      return data ?? [];
    },

    /** Vínculos em que a organização (e, se houver, a unidade) do contexto é o DESTINO. */
    async listarDestinosDaOrganizacao(organizacaoId, unidadeId = null) {
      if (!organizacaoId) throw new FoodyRepoErro("TENANT_AUSENTE", "organização obrigatória.");
      let q = db.from("foody_conexao_destinos").select(COLUNAS_DESTINO_TELA).eq("organizacao_id", organizacaoId);
      if (unidadeId) q = q.eq("unidade_id", unidadeId);
      const { data, error } = await q.order("criado_em", { ascending: false }).range(0, 49);
      if (error) throw falha("listarDestinosDaOrganizacao", error);
      return data ?? [];
    },

    /** Auditoria da conexão no tenant (só os eventos gravados no próprio tenant). */
    async listarEventosDaConexao(t, limite = 50) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_conexoes_eventos")
        .select("id, conexao_id, evento, ator_perfil_id, status_anterior, status_novo, token_impressao, motivo, criado_em")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId)
        .order("criado_em", { ascending: false }).range(0, Math.min(Math.max(1, limite), 100) - 1);
      if (error) throw falha("listarEventosDaConexao", error);
      return data ?? [];
    },

    /** Auditoria do vínculo gravada no tenant (148: cada organização só tem os eventos do próprio lado). */
    async listarEventosDeDestinos(organizacaoId, unidadeId, limite = 50) {
      if (!organizacaoId || !unidadeId) throw new FoodyRepoErro("TENANT_AUSENTE", "organização e unidade são obrigatórias.");
      const { data, error } = await db.from("foody_destinos_eventos")
        .select("id, destino_id, evento, ator_perfil_id, ator_organizacao_id, motivo, criado_em")
        .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
        .order("criado_em", { ascending: false }).range(0, Math.min(Math.max(1, limite), 100) - 1);
      if (error) throw falha("listarEventosDeDestinos", error);
      return data ?? [];
    },

    /** Dias com pedido em TRIAGEM (ativo) na titular, desde `desde` — só contagem por dia. */
    async listarDiasComTriagem(t, conexaoId, desde) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_pedidos").select("competencia")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("conexao_id", conexaoId)
        .eq("operacao", "triagem").eq("roteamento_ativo", true).range(0, PAGINA_LEITURA - 1);
      if (error) throw falha("listarDiasComTriagem", error);
      const contagem = new Map();
      for (const r of data ?? []) {
        const c = String(r.competencia).slice(0, 10);
        if (c >= desde) contagem.set(c, (contagem.get(c) ?? 0) + 1);
      }
      return [...contagem].sort(([a], [b]) => (a < b ? 1 : -1)).map(([competencia, quantidade]) => ({ competencia, quantidade }));
    },

    /** Histórico das decisões de triagem da conexão (somente inclusão), mais recentes primeiro. */
    async listarHistoricoDecisoes(t, conexaoId, limite = 100) {
      exigirTenant(t);
      const { data, error } = await db.from("foody_triagem_decisoes")
        .select("id, foody_uid, operacao_decidida, motivo, decidido_por, decidido_em, catalogo_versao")
        .eq("organizacao_id", t.organizacaoId).eq("unidade_id", t.unidadeId).eq("conexao_id", conexaoId)
        .order("decidido_em", { ascending: false }).range(0, Math.min(Math.max(1, limite), 200) - 1);
      if (error) throw falha("listarHistoricoDecisoes", error);
      return data ?? [];
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
