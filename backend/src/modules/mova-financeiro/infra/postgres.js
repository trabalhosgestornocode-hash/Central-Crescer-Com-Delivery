// Persistência PostgreSQL do MOVA (schema `mova`, database/mova-financeiro/migracoes/). Mesmo contrato do armazenamento em
// memória (infra/memoria.js), da fila (gateway/fila.js) e das evidências (gateway/evidencias.js) — todos os métodos são async.
//
// Recebe um `pool` (pg.Pool ou compatível: query + connect). Não lê ambiente nem decide destino: quem monta escolhe o banco.
// NESTA EXECUÇÃO só é usado com o PostgreSQL local de teste.
//
// Falha de conexão (banco fora, rede) vira ErroTransitorio: o receptor responde "indisponível" (o Gateway reenvia) e a fila
// tenta de novo. Erro de regra do banco (gatilhos MV00x, violação de chave) NÃO é transitório.
import { createHash, randomUUID } from "node:crypto";
import { ErroTransitorio } from "../gateway/fila.js";

const TRANSITORIOS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006", "53300"]);
export function ehFalhaDeConexao(e) {
  return TRANSITORIOS.has(e?.code) || /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(String(e?.message ?? ""));
}

function consultar(pool) {
  return async (sql, params = []) => {
    try { return await pool.query(sql, params); } catch (e) {
      if (ehFalhaDeConexao(e)) throw new ErroTransitorio("BANCO_INDISPONIVEL");
      throw e;
    }
  };
}

async function emTransacao(pool, fn) {
  let cliente;
  try { cliente = await pool.connect(); } catch (e) { if (ehFalhaDeConexao(e)) throw new ErroTransitorio("BANCO_INDISPONIVEL"); throw e; }
  try {
    await cliente.query("begin");
    const r = await fn((sql, p = []) => cliente.query(sql, p));
    await cliente.query("commit");
    return r;
  } catch (e) {
    try { await cliente.query("rollback"); } catch { /* conexão já caiu */ }
    if (ehFalhaDeConexao(e)) throw new ErroTransitorio("BANCO_INDISPONIVEL");
    throw e;
  } finally { cliente.release(); }
}

const linhaProposta = (r) => r && Object.freeze({
  id: r.id, organizacaoId: r.organizacao_id, unidadeId: r.unidade_id, estado: r.estado, tipo: r.tipo, valorCentavos: r.valor_centavos === null ? null : Number(r.valor_centavos),
  eventoId: r.evento_id, participanteId: r.participante_jid, versao: r.versao, criadaEm: r.criada_em.toISOString(), resultado: r.resultado, simulada: false, ...r.dados,
});

/**
 * @param {{pool:object, gerarId?:() => string}} deps
 */
export function criarArmazenamentoPostgres({ pool, gerarId = randomUUID }) {
  const q = consultar(pool);
  return Object.freeze({
    eventos: Object.freeze({
      /** @returns {Promise<{novo:boolean}>} */
      async registrar(e) {
        const r = await q(`insert into mova.evento (evento_id, grupo_jid, mensagem_id, participante_jid, provedor, tipo, texto, resposta_a, documento_sha256, recebido_em)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning evento_id`,
        [e.eventoId, e.grupoId, e.mensagemId, e.participanteId, e.provedor, e.tipo, e.texto, e.respostaA, e.midia?.sha256 ?? null, e.recebidoEm]);
        return { novo: r.rowCount === 1 };
      },
      /** Por eventoId; com grupoId, pela mensagem_id DENTRO do grupo (mensagem respondida). */
      async obter(id, grupoId = null) {
        const r = grupoId ? await q("select * from mova.evento where grupo_jid = $1 and mensagem_id = $2", [grupoId, id]) : await q("select * from mova.evento where evento_id = $1", [id]);
        return r.rows[0] ?? null;
      },
    }),
    participantes: Object.freeze({
      /** Registro automático: novo participante entra na primeira mensagem. */
      async registrar({ grupoId, participanteId, telefoneE164 = null, nomeExibicao = null }) {
        const r = await q(`insert into mova.participante (grupo_jid, participante_jid, telefone_e164, nome_exibicao, mensagens) values ($1,$2,$3,$4,1)
                           on conflict (grupo_jid, participante_jid) do update set ultimo_em = now(), mensagens = mova.participante.mensagens + 1,
                             nome_exibicao = coalesce(excluded.nome_exibicao, mova.participante.nome_exibicao), telefone_e164 = coalesce(excluded.telefone_e164, mova.participante.telefone_e164)
                           returning (xmax = 0) as novo`, [grupoId, participanteId, telefoneE164, nomeExibicao]);
        return { novo: r.rows[0].novo };
      },
      async listar(grupoId) {
        return (await q("select participante_jid, nome_exibicao, primeiro_em, mensagens from mova.participante where grupo_jid = $1 order by primeiro_em", [grupoId])).rows;
      },
    }),
    propostas: Object.freeze({
      async criar(escopo, dados) {
        const { chaveIdempotencia, tipo, valorCentavos, eventoId, participanteId, ...resto } = dados;
        const id = gerarId();
        const r = await q(`insert into mova.proposta (id, organizacao_id, unidade_id, chave_idempotencia, tipo, estado, valor_centavos, evento_id, participante_jid, dados)
                           values ($1,$2,$3,$4,$5,'AGUARDANDO_REVISAO',$6,$7,$8,$9) on conflict (chave_idempotencia) do nothing returning *`,
        [id, escopo.organizacaoId, escopo.unidadeId, chaveIdempotencia, tipo, valorCentavos ?? null, eventoId, participanteId ?? null, JSON.stringify({ chaveIdempotencia, tipo, ...resto })]);
        if (r.rowCount === 1) return { proposta: linhaProposta(r.rows[0]), repetida: false };
        const ex = await q("select * from mova.proposta where chave_idempotencia = $1", [chaveIdempotencia]);
        return { proposta: linhaProposta(ex.rows[0]), repetida: true };
      },
      async listar(escopo) {
        return (await q("select * from mova.proposta where organizacao_id = $1 and unidade_id = $2 order by seq", [escopo.organizacaoId, escopo.unidadeId])).rows.map(linhaProposta);
      },
      async obter(escopo, id) {
        const r = await q("select * from mova.proposta where id = $1 and organizacao_id = $2 and unidade_id = $3", [id, escopo.organizacaoId, escopo.unidadeId]);
        return linhaProposta(r.rows[0]) ?? null;
      },
      /** Transição CONDICIONAL (só se o estado atual for `de`): é o que impede duas aplicações da mesma proposta. */
      async transicionar(escopo, id, de, para, resultado = null) {
        const r = await q(`update mova.proposta set estado = $4, resultado = coalesce($5::jsonb, resultado)
                           where id = $1 and organizacao_id = $2 and unidade_id = $3 and estado = $6 returning *`,
        [id, escopo.organizacaoId, escopo.unidadeId, para, resultado ? JSON.stringify(resultado) : null, de]);
        return linhaProposta(r.rows[0]) ?? null;
      },
      async quantidade() { return Number((await q("select count(*)::int as n from mova.proposta")).rows[0].n); },
      /** Revisão (Nível 2) enquanto AGUARDANDO_REVISAO; só mescla `alteracoes` em dados; exige a versão lida (senão null). */
      async revisar(escopo, id, versao, alteracoes) {
        const r = await q(`update mova.proposta set dados = dados || $5::jsonb
                           where id = $1 and organizacao_id = $2 and unidade_id = $3 and versao = $4 and estado = 'AGUARDANDO_REVISAO' returning *`,
        [id, escopo.organizacaoId, escopo.unidadeId, versao, JSON.stringify(alteracoes)]);
        return linhaProposta(r.rows[0]) ?? null;
      },
    }),
    historico: Object.freeze({
      async registrar(h) {
        const { organizacaoId = null, unidadeId = null, eventoId, decisao, motivo, propostaId = null, sinaisDeInjecao = false, documentoSha256 = null, ...extra } = h;
        await q(`insert into mova.decisao (organizacao_id, unidade_id, evento_id, decisao, motivo, proposta_id, sinais_injecao, documento_sha256, extra)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [organizacaoId, unidadeId, eventoId ?? "-", decisao, motivo, propostaId, sinaisDeInjecao, documentoSha256, JSON.stringify(extra)]);
      },
      async listar({ organizacaoId, unidadeId }) {
        const r = await q(`select * from mova.decisao where organizacao_id is not distinct from $1 and unidade_id is not distinct from $2 order by seq`, [organizacaoId, unidadeId]);
        return r.rows.map((x) => ({ organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, eventoId: x.evento_id, decisao: x.decisao, motivo: x.motivo, propostaId: x.proposta_id, sinaisDeInjecao: x.sinais_injecao, ...x.extra }));
      },
      // Decidido = existe decisão final DEPOIS da última liberação de reprocessamento (REPROCESSAR, ato auditado do administrador).
      async temDecisao(eventoId) {
        return (await q(`select 1 from mova.decisao d where d.evento_id = $1 and d.decisao not in ('FALHOU','REPROCESSAR')
                          and d.seq > coalesce((select max(r.seq) from mova.decisao r where r.evento_id = $1 and r.decisao = 'REPROCESSAR'), 0) limit 1`, [eventoId])).rowCount > 0;
      },
      async todos() {
        const r = await q("select * from mova.decisao order by seq");
        return r.rows.map((x) => ({ organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, eventoId: x.evento_id, decisao: x.decisao, motivo: x.motivo, propostaId: x.proposta_id, sinaisDeInjecao: x.sinais_injecao, ...x.extra }));
      },
    }),
    documentos: Object.freeze({
      async visto(sha256) {
        const r = await q("select organizacao_id, unidade_id, proposta_id, evento_id from mova.documento where sha256 = $1", [sha256]);
        const x = r.rows[0];
        return x ? { organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, propostaId: x.proposta_id, eventoId: x.evento_id } : null;
      },
      async marcar(sha256, d) {
        await q(`insert into mova.documento (sha256, organizacao_id, unidade_id, evento_id, proposta_id, leitura) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [sha256, d.organizacaoId ?? null, d.unidadeId ?? null, d.eventoId, d.propostaId ?? null, d.leitura ? JSON.stringify(d.leitura) : null]);
        if (d.unidadeId) await q("update mova.evidencia set organizacao_id = $2, unidade_id = $3 where sha256 = $1 and unidade_id is null", [sha256, d.organizacaoId, d.unidadeId]);
      },
    }),
    mensagens: Object.freeze({
      async lembrar(mensagemId, { grupoId, pendente }) {
        if (!pendente) { await q("update mova.mensagem_pendente set resolvida_em = now() where mensagem_id = $1 and resolvida_em is null", [mensagemId]); return; }
        await q(`insert into mova.mensagem_pendente (mensagem_id, grupo_jid, evento_id, leitura) values ($1,$2,$3,$4)
                 on conflict (mensagem_id) do update set leitura = excluded.leitura, resolvida_em = null`, [mensagemId, grupoId, pendente.evento.eventoId, JSON.stringify({ evento: pendente.evento, saida: pendente.saida })]);
      },
      /** Resolução ATÔMICA: duas respostas simultâneas à mesma pergunta não retomam o documento duas vezes. */
      async tomarPendente(mensagemId) {
        const r = await q("update mova.mensagem_pendente set resolvida_em = now() where mensagem_id = $1 and resolvida_em is null returning leitura, grupo_jid", [mensagemId]);
        return r.rows[0] ? { grupoId: r.rows[0].grupo_jid, pendente: r.rows[0].leitura } : null;
      },
    }),
    saida: Object.freeze({
      async enfileirar({ grupoId, respostaA, texto, eventoId = null }) {
        await q("insert into mova.resposta (grupo_jid, resposta_a, evento_id, texto) values ($1,$2,$3,$4)", [grupoId, respostaA, eventoId, texto]);
      },
      async listar() {
        return (await q("select grupo_jid as \"grupoId\", resposta_a as \"respostaA\", texto, estado from mova.resposta order by seq")).rows;
      },
      /** Eco de uma resposta do próprio agente (id do provedor registrado no envio) ⇒ nunca reprocessar. */
      async ehRespostaPropria(mensagemId) {
        return (await q("select 1 from mova.resposta where provider_message_id = $1", [mensagemId])).rowCount > 0;
      },
      async marcarEnviada(id, providerMessageId) {
        await q("update mova.resposta set estado = 'ENVIADA', provider_message_id = $2, enviada_em = now(), lease_ate = null where id = $1", [id, providerMessageId]);
      },
      /** Pega até `limite` respostas PENDENTES (ou ENVIANDO com lease vencido) para envio — dois enviadores nunca pegam a mesma. */
      async tomarParaEnvio({ limite = 10, leaseMs = 60_000, agora = new Date() } = {}) {
        return emTransacao(pool, async (tx) => (await tx(`
          update mova.resposta set estado = 'ENVIANDO', tentativas = tentativas + 1, lease_ate = $2
           where id in (select id from mova.resposta where estado = 'PENDENTE' or (estado = 'ENVIANDO' and lease_ate < $1)
                         order by seq limit $3 for update skip locked)
          returning id, grupo_jid as "grupoId", resposta_a as "respostaA", evento_id as "eventoId", texto, tentativas`,
        [agora.toISOString(), new Date(agora.getTime() + leaseMs).toISOString(), limite])).rows);
      },
      async marcarFalhaDeEnvio(id, codigo, { final }) {
        await q("update mova.resposta set estado = $2, ultimo_erro = $3, lease_ate = null where id = $1", [id, final ? "FALHOU" : "PENDENTE", codigo]);
      },
      async contagem() {
        return Object.fromEntries((await q("select estado, count(*)::int as n from mova.resposta group by estado")).rows.map((x) => [x.estado, x.n]));
      },
    }),
    aprovacoes: Object.freeze({
      async registrar({ propostaId, acao, usuarioId, motivo = null, resultado = null }) {
        await q("insert into mova.aprovacao (proposta_id, acao, usuario_id, motivo, resultado) values ($1,$2,$3,$4,$5)", [propostaId, acao, usuarioId, motivo, resultado ? JSON.stringify(resultado) : null]);
      },
      async listar(propostaId) {
        return (await q("select acao, usuario_id as \"usuarioId\", motivo, resultado from mova.aprovacao where proposta_id = $1 order by seq", [propostaId])).rows;
      },
    }),
    auditoria: Object.freeze({
      async registrar({ acao, atorTipo, atorRef = null, alvo = null, dados = {} }) {
        await q("insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ($1,$2,$3,$4,$5)", [acao, atorTipo, atorRef, alvo, JSON.stringify(dados)]);
      },
      async listar() { return (await q("select acao, ator_tipo as \"atorTipo\", ator_ref as \"atorRef\", alvo, dados from mova.auditoria order by seq")).rows; },
    }),
    transacao: (fn) => emTransacao(pool, fn),
  });
}

/** Evidências no banco (bytea). Mesmo contrato de criarEvidenciasMemoria. */
export function criarEvidenciasPostgres({ pool }) {
  const q = consultar(pool);
  return Object.freeze({
    async guardar(bytes, { mime, nomeArquivo = null } = {}) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError("bytes inválidos");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const referencia = `evd_${sha256.slice(0, 32)}`;
      const r = await q("insert into mova.evidencia (sha256, referencia, mime, tamanho, nome_arquivo, conteudo) values ($1,$2,$3,$4,$5,$6) on conflict do nothing",
        [sha256, referencia, mime, bytes.length, nomeArquivo, Buffer.from(bytes)]);
      return { referencia, sha256, tamanhoBytes: bytes.length, repetido: r.rowCount === 0 };
    },
    async obter(referencia) {
      return (await q("select conteudo from mova.evidencia where referencia = $1", [referencia])).rows[0]?.conteudo ?? null;
    },
    async quantidade() { return Number((await q("select count(*)::int as n from mova.evidencia")).rows[0].n); },
    /** Conteúdo SÓ para a unidade dona (Centro Financeiro). Removida ou de outra unidade = null. */
    async obterDaUnidade(sha256, escopo) {
      const r = await q("select conteudo, mime, nome_arquivo from mova.evidencia where sha256 = $1 and organizacao_id = $2 and unidade_id = $3 and removida_em is null", [sha256, escopo.organizacaoId, escopo.unidadeId]);
      if (!r.rows[0]) return null;
      // Integridade: o conteúdo precisa bater com o hash gravado (adulteração no banco ⇒ recusa, nunca entrega).
      if (createHash("sha256").update(r.rows[0].conteudo).digest("hex") !== sha256) throw Object.assign(new Error("evidência adulterada"), { codigo: "EVIDENCIA_ADULTERADA" });
      return { bytes: r.rows[0].conteudo, mime: r.rows[0].mime, nomeArquivo: r.rows[0].nome_arquivo };
    },
    async expurgar(agora = new Date()) { return Number((await q("select mova.expurgar_evidencias($1) as n", [agora.toISOString()])).rows[0].n); },
  });
}

/**
 * Fila persistente com lease (`for update skip locked`): dois processos nunca pegam o mesmo item; item cujo lease venceu
 * (processo caiu no meio) volta a ser elegível. Mesmo contrato de criarFilaMemoria.
 */
export function criarFilaPostgres({ pool, maxTentativas = 5, esperaBaseMs = 1000, leaseMs = 120_000, relogio = () => Date.now(), lote = 10 }) {
  const q = consultar(pool);
  const agora = () => new Date(relogio()).toISOString();
  return Object.freeze({
    async enfileirar(eventoId, carga) {
      const r = await q(`insert into mova.fila (evento_id, carga, estado, proxima_em) values ($1,$2,'PENDENTE',$3) on conflict do nothing`, [eventoId, JSON.stringify(carga), agora()]);
      return r.rowCount === 1 ? { aceito: true, duplicado: false } : { aceito: false, duplicado: true };
    },
    async processarPendentes(tratar, { aoDesistir } = {}) {
      let processados = 0;
      for (;;) {
        const t = relogio();
        const pegos = await emTransacao(pool, async (tx) => (await tx(`
          update mova.fila set estado = 'PROCESSANDO', tentativas = tentativas + 1, lease_ate = $2, atualizado_em = $1
           where evento_id in (select evento_id from mova.fila
                                where (estado = 'PENDENTE' and proxima_em <= $1) or (estado = 'PROCESSANDO' and lease_ate < $1)
                                order by criado_em, evento_id limit $3 for update skip locked)
          returning evento_id, carga, tentativas`, [new Date(t).toISOString(), new Date(t + leaseMs).toISOString(), lote])).rows);
        if (pegos.length === 0) return processados;
        for (const item of pegos) {
          try {
            const resultado = await tratar(item.carga, { eventoId: item.evento_id, tentativas: item.tentativas });
            await q("update mova.fila set estado = 'CONCLUIDO', resultado = $2, ultimo_erro = null, lease_ate = null, atualizado_em = now() where evento_id = $1", [item.evento_id, JSON.stringify(resultado ?? null)]);
          } catch (e) {
            const codigo = e instanceof ErroTransitorio ? e.codigo : "ERRO_PERMANENTE";
            const tentarDeNovo = e instanceof ErroTransitorio && item.tentativas < maxTentativas;
            const proxima = new Date(relogio() + esperaBaseMs * 2 ** (item.tentativas - 1)).toISOString();
            try {
              await q(`update mova.fila set estado = $2, ultimo_erro = $3, proxima_em = $4, lease_ate = null, atualizado_em = now() where evento_id = $1`,
                [item.evento_id, tentarDeNovo ? "PENDENTE" : "FALHOU", codigo, proxima]);
            } catch { /* banco caiu: o lease vence e o item volta sozinho */ }
            if (!tentarDeNovo && aoDesistir) await aoDesistir({ eventoId: item.evento_id, carga: item.carga, codigo });
          }
          processados += 1;
        }
      }
    },
    async estado(eventoId) {
      const r = await q("select estado, tentativas, ultimo_erro, resultado from mova.fila where evento_id = $1", [eventoId]);
      const x = r.rows[0];
      return x ? { estado: x.estado, tentativas: x.tentativas, ultimoErro: x.ultimo_erro, resultado: x.resultado } : null;
    },
    async listar() { return (await q("select evento_id as \"eventoId\", estado, tentativas, ultimo_erro as \"ultimoErro\" from mova.fila order by criado_em")).rows; },
    async estatisticas() {
      const r = await q("select estado, count(*)::int as n, min(case when estado = 'PENDENTE' then criado_em end) as mais_antigo from mova.fila group by estado");
      return { porEstado: Object.fromEntries(r.rows.map((x) => [x.estado, x.n])), pendenteMaisAntigo: r.rows.find((x) => x.estado === "PENDENTE")?.mais_antigo?.toISOString() ?? null };
    },
    async falhas(limite = 50) {
      return (await q("select evento_id as \"eventoId\", tentativas, ultimo_erro as \"ultimoErro\", atualizado_em as \"em\" from mova.fila where estado = 'FALHOU' order by atualizado_em desc limit $1", [limite])).rows;
    },
    /** Reprocessar (Nível 2): devolve um item FALHOU para a fila. */
    async reprocessar(eventoId) {
      return (await q("update mova.fila set estado = 'PENDENTE', proxima_em = '-infinity', tentativas = 0, ultimo_erro = null where evento_id = $1 and estado = 'FALHOU'", [eventoId])).rowCount === 1;
    },
    /**
     * H-1: libera para nova leitura um evento cuja ÚLTIMA decisão é FALHA_LEITURA sem unidade, de conversa que atende o escopo.
     * Numa transação: registra REPROCESSAR (sem unidade, sem conteúdo) e devolve à fila. Condicional ⇒ repetir não duplica.
     */
    async reprocessarLeitura(eventoId, { organizacaoId, unidadeId }) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const alvo = await c.query(`select 1 from mova.fila f
            where f.evento_id = $1 and f.estado = 'CONCLUIDO'
              and f.carga->>'grupoId' in (select gu.grupo_jid from mova.grupo_unidade gu where gu.organizacao_id = $2 and gu.unidade_id = $3)
              and (select d.decisao || '|' || coalesce(d.unidade_id::text, '') from mova.decisao d where d.evento_id = $1 order by d.seq desc limit 1) = 'FALHA_LEITURA|'
            for update of f`, [eventoId, organizacaoId, unidadeId]);
        if (alvo.rowCount !== 1) { await c.query("rollback"); return false; }
        await c.query("insert into mova.decisao (evento_id, decisao, motivo) values ($1, 'REPROCESSAR', 'LIBERADO_PELO_ADMINISTRADOR')", [eventoId]);
        await c.query("update mova.fila set estado = 'PENDENTE', proxima_em = '-infinity', tentativas = 0, ultimo_erro = null, resultado = null where evento_id = $1", [eventoId]);
        await c.query("commit");
        return true;
      } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
    },
  });
}

/** Grava a configuração (instância, grupos, unidades) — uso administrativo/teste. Grupo nasce desligado salvo `ativo: true`. */
export async function instalarConfiguracao(pool, cfg, { instanciaId = "principal" } = {}) {
  await emTransacao(pool, async (tx) => {
    await tx("insert into mova.instancia_gateway (id) values ($1) on conflict do nothing", [instanciaId]);
    for (const g of cfg.gruposAutorizados) {
      const unidades = cfg.unidades.filter((u) => g.unidades.includes(u.unidadeId));
      await tx(`insert into mova.grupo_autorizado (grupo_jid, organizacao_id, instancia_id, ativo, tipo) values ($1,$2,$3,true,$4)
                on conflict (grupo_jid) do update set ativo = true`, [g.grupoId, unidades[0].organizacaoId, instanciaId, g.grupoId.endsWith("@g.us") ? "GRUPO" : "PRIVADO_HOMOLOGACAO"]);
      for (const u of unidades) {
        await tx(`insert into mova.grupo_unidade (grupo_jid, organizacao_id, unidade_id, nome, apelidos, documentos, fontes) values ($1,$2,$3,$4,$5,$6,$7)
                  on conflict (grupo_jid, unidade_id) do update set nome = excluded.nome, apelidos = excluded.apelidos, documentos = excluded.documentos, fontes = excluded.fontes`,
        [g.grupoId, u.organizacaoId, u.unidadeId, u.nome, u.apelidosOriginais ?? u.apelidos, u.documentos, JSON.stringify(u.fontesOriginais ?? u.fontes)]);
      }
    }
  });
}

/** Lê do banco a configuração BRUTA (para validarConfiguracao): só grupos ATIVOS. */
export async function carregarConfiguracao(pool, { identidadeServico, modo = "SIMULACAO" }) {
  const q = consultar(pool);
  // Conversas privadas de homologação só entram no modo HOMOLOGACAO; fora dele são ignoradas mesmo que ativas no banco.
  const grupos = (await q("select grupo_jid from mova.grupo_autorizado where ativo and (tipo = 'GRUPO' or $1 = 'HOMOLOGACAO')", [modo])).rows;
  const unidades = (await q("select gu.* from mova.grupo_unidade gu join mova.grupo_autorizado g using (grupo_jid) where g.ativo and (g.tipo = 'GRUPO' or $1 = 'HOMOLOGACAO') order by gu.nome", [modo])).rows;
  const porId = new Map();
  for (const u of unidades) porId.set(u.unidade_id, { organizacaoId: u.organizacao_id, unidadeId: u.unidade_id, nome: u.nome, apelidos: u.apelidos, documentos: u.documentos, fontes: u.fontes });
  return {
    modo, identidadeServico,
    unidades: [...porId.values()],
    gruposAutorizados: grupos.map((g) => ({ grupoId: g.grupo_jid, unidades: unidades.filter((u) => u.grupo_jid === g.grupo_jid).map((u) => u.unidade_id) })),
  };
}

/**
 * LEITURA para o Centro Financeiro (Caixa de Entrada). Só para quem já passou pela sessão autenticada com financeiro_v2.ver
 * na unidade (a rota confere). Itens sem unidade (aguardando esclarecimento) vêm à parte, só do grupo da unidade.
 */
export function criarConsultasPostgres({ pool }) {
  const q = consultar(pool);
  const mascararJid = (j) => { const d = String(j ?? "").split("@")[0].replace(/\D/g, ""); return d ? `…${d.slice(-4)}` : null; };
  const item = (r) => ({
    eventoId: r.evento_id, recebidoEm: r.recebido_em.toISOString(), tipo: r.tipo, texto: r.texto,
    participante: { referencia: mascararJid(r.participante_jid), nomeExibicao: r.nome_exibicao, nomeNaoEProvaDeIdentidade: true },
    documento: r.sha256 ? { sha256: r.sha256, mime: r.mime, nomeArquivo: r.nome_arquivo } : null,
    dadosExtraidos: r.leitura ?? null,
    proposta: r.proposta_id ? { id: r.proposta_id, tipo: r.proposta_tipo, estado: r.proposta_estado, valorCentavos: r.valor_centavos === null ? null : Number(r.valor_centavos),
      categoriaSugerida: r.dados?.categoriaSugerida ?? null, datas: r.dados?.datas ?? null, bloqueioDeAplicacao: r.dados?.bloqueioDeAplicacao ?? null, sinaisDeInjecao: r.dados?.sinaisDeInjecao ?? false } : null,
    decisoes: r.decisoes,
  });
  const SQL = `
    select e.evento_id, e.recebido_em, e.tipo, e.texto, e.participante_jid, pa.nome_exibicao, ev.sha256, ev.mime, ev.nome_arquivo, d.leitura,
           p.id as proposta_id, p.tipo as proposta_tipo, p.estado as proposta_estado, p.valor_centavos, p.dados,
           (select coalesce(jsonb_agg(jsonb_build_object('decisao', x.decisao, 'motivo', x.motivo, 'em', x.em) order by x.seq), '[]'::jsonb)
              from mova.decisao x where x.evento_id = e.evento_id) as decisoes
      from mova.evento e
      left join mova.participante pa on pa.grupo_jid = e.grupo_jid and pa.participante_jid = e.participante_jid
      left join mova.evidencia ev on ev.sha256 = e.documento_sha256
      left join mova.documento d on d.sha256 = e.documento_sha256 and d.evento_id = e.evento_id
      left join mova.proposta p on p.evento_id = e.evento_id`;
  // Conversas que atendem a unidade (escopo das falhas sem unidade). Só metadados saem destas consultas — nunca texto ou documento.
  const CONVERSAS = "select gu.grupo_jid from mova.grupo_unidade gu where gu.organizacao_id = $1 and gu.unidade_id = $2";
  return Object.freeze({
    /** H-1: falhas GERAIS (sem unidade identificada) das conversas que atendem a unidade + pendentes dessas conversas. */
    async falhasGerais({ organizacaoId, unidadeId, limite = 100 }) {
      const itens = (await q(`select d.evento_id as "eventoId", d.decisao as tipo, d.motivo, d.em, f.estado, f.tentativas
          from mova.decisao d join mova.fila f on f.evento_id = d.evento_id
         where d.unidade_id is null and d.decisao not in ('IGNORADO','REPROCESSAR')
           and d.seq = (select max(x.seq) from mova.decisao x where x.evento_id = d.evento_id)
           and f.carga->>'grupoId' in (${CONVERSAS})
         order by d.seq desc limit $3`, [organizacaoId, unidadeId, limite])).rows;
      const pend = (await q(`select count(*)::int n from mova.fila f where f.estado in ('PENDENTE','PROCESSANDO') and f.carga->>'grupoId' in (${CONVERSAS})`, [organizacaoId, unidadeId])).rows[0].n;
      const porTipo = {};
      for (const i of itens) porTipo[i.tipo] = (porTipo[i.tipo] ?? 0) + 1;
      return { total: itens.length, porTipo, pendentes: pend, itens: itens.map((i) => ({ ...i, reprocessavel: i.tipo === "FALHA_LEITURA" && i.estado === "CONCLUIDO" })) };
    },
    /** Falhas da FILA restritas às conversas da unidade (antes: todas as conversas). */
    async falhasDaFila({ organizacaoId, unidadeId, limite = 50 }) {
      return (await q(`select f.evento_id as "eventoId", f.tentativas, f.ultimo_erro as "ultimoErro", f.atualizado_em as em from mova.fila f
         where f.estado = 'FALHOU' and f.carga->>'grupoId' in (${CONVERSAS}) order by f.atualizado_em desc limit $3`, [organizacaoId, unidadeId, limite])).rows;
    },
    /** O evento está em falha na fila e é de conversa que atende a unidade? */
    async falhaDaFilaNoEscopo({ organizacaoId, unidadeId, eventoId }) {
      return (await q(`select 1 from mova.fila f where f.evento_id = $3 and f.estado = 'FALHOU' and f.carga->>'grupoId' in (${CONVERSAS})`, [organizacaoId, unidadeId, eventoId])).rowCount === 1;
    },
    async caixaDeEntrada({ organizacaoId, unidadeId, limite = 100 }) {
      const daUnidade = await q(`${SQL} where exists (select 1 from mova.decisao x where x.evento_id = e.evento_id and x.organizacao_id = $1 and x.unidade_id = $2)
                                 order by e.recebido_em desc limit $3`, [organizacaoId, unidadeId, limite]);
      const semUnidade = await q(`${SQL} where e.grupo_jid in (select grupo_jid from mova.grupo_unidade where organizacao_id = $1 and unidade_id = $2)
                                   and not exists (select 1 from mova.decisao x where x.evento_id = e.evento_id and x.unidade_id is not null)
                                   and exists (select 1 from mova.mensagem_pendente m where m.evento_id = e.evento_id and m.resolvida_em is null)
                                 order by e.recebido_em desc limit $3`, [organizacaoId, unidadeId, limite]);
      return { itens: daUnidade.rows.map(item), aguardandoUnidade: semUnidade.rows.map(item) };
    },
    /** Item da Caixa ligado a UMA proposta (da unidade). */
    async proposta({ organizacaoId, unidadeId, id }) {
      const r = await q(`${SQL} where p.id = $1 and p.organizacao_id = $2 and p.unidade_id = $3`, [id, organizacaoId, unidadeId]);
      if (!r.rows[0]) return null;
      const aprov = (await q("select acao, usuario_id as \"usuarioId\", motivo, em from mova.aprovacao where proposta_id = $1 order by seq", [id])).rows;
      const p = (await q("select versao, dados from mova.proposta where id = $1", [id])).rows[0];
      return { ...item(r.rows[0]), versao: p.versao, comando: p.dados.comando ?? null, categoriaRevisada: p.dados.categoriaRevisada ?? null, aprovacoes: aprov };
    },
    async documento({ organizacaoId, unidadeId, eventoId }) {
      const r = await q(`${SQL} where e.evento_id = $1 and exists (select 1 from mova.decisao x where x.evento_id = e.evento_id and x.organizacao_id = $2 and x.unidade_id = $3)`, [eventoId, organizacaoId, unidadeId]);
      return r.rows[0] ? item(r.rows[0]) : null;
    },
    async historico({ organizacaoId, unidadeId, limite = 200 }) {
      return (await q("select evento_id as \"eventoId\", decisao, motivo, proposta_id as \"propostaId\", sinais_injecao as \"sinaisDeInjecao\", em from mova.decisao where organizacao_id = $1 and unidade_id = $2 order by seq desc limit $3", [organizacaoId, unidadeId, limite])).rows;
    },
  });
}
