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
import { linhaDoRecebido } from "../dominio/documentos.js";

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

/** Linha do cadastro de entregador para a tela: telefone SEMPRE mascarado (o número completo só entra, nunca sai). */
const linhaCadastro = (r) => ({ id: r.id, chave: r.chave, telefone: `…${r.telefone_e164.slice(-4)}`, nome: r.nome, observacoes: r.observacoes ?? null, ativo: r.ativo,
  criadoEm: r.criado_em.toISOString(), cadastradoPor: r.cadastrado_por ?? null, verificadoEm: r.verificado_em?.toISOString() ?? null,
  revogadoEm: r.revogado_em?.toISOString() ?? null, revogadoPor: r.revogado_por ?? null, motivoRevogacao: r.motivo_revogacao ?? null });
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

const linhaNota = (r) => r && Object.freeze({ id: r.id, organizacaoId: r.organizacao_id, unidadeId: r.unidade_id, entregador: r.entregador, semanaInicio: dia(r.semana_inicio), sha256: r.sha256,
  eventoId: r.evento_id, estado: r.estado, motivo: r.motivo, documentoId: r.documento_id, situacaoDocumental: r.situacao_documental, conferencia: r.conferencia ?? null, leitura: r.leitura ?? null, criadaEm: r.criada_em.toISOString() });
const linhaAutomacao = (r) => r ? Object.freeze({ nome: r.nome, organizacaoId: r.organizacao_id, unidadeId: r.unidade_id, ativa: r.ativa, horario: r.horario,
  pausadaEm: r.pausada_em?.toISOString() ?? null, pausadaPor: r.pausada_por, motivo: r.motivo, ultimaExecucao: r.ultima_execucao?.toISOString() ?? null }) : null;
/**
 * @param {{pool:object, gerarId?:() => string}} deps
 */
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const linhaOperacao = (x) => (x ? Object.freeze({ id: x.id, chave: x.chave, propostaId: x.proposta_id, organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, operacao: x.operacao, nivel: x.nivel,
  politicaId: x.politica_id, estado: x.estado, valorCentavos: Number(x.valor_centavos), executadaPor: x.executada_por, resultado: x.resultado, motivo: x.motivo,
  criadaEm: x.criada_em.toISOString(), revertidaPor: x.revertida_por, revertidaEm: x.revertida_em ? x.revertida_em.toISOString() : null, justificativaReversao: x.justificativa_reversao }) : null);

export function criarArmazenamentoPostgres({ pool, gerarId = randomUUID }) {
  const q = consultar(pool);
  return Object.freeze({
    eventos: Object.freeze({
      /** @returns {Promise<{novo:boolean}>} */
      async registrar(e) {
        const r = await q(`insert into mova.evento (evento_id, grupo_jid, mensagem_id, participante_jid, provedor, tipo, texto, resposta_a, documento_sha256, recebido_em)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,(select sha256 from mova.evidencia where sha256 = $9),$10) on conflict do nothing returning evento_id`,
        // Agente 2: o evento é registrado ANTES de o arquivo ser autorizado e guardado; o vínculo com o arquivo vem do documento.
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
      /** Agente 2: anotação INTERNA (conciliação, autonomia) enquanto AGUARDANDO_REVISAO; não muda tipo, valor nem estado. */
      async anotar(escopo, id, alteracoes) {
        const r = await q("update mova.proposta set dados = dados || $4::jsonb where id = $1 and organizacao_id = $2 and unidade_id = $3 and estado = 'AGUARDANDO_REVISAO' returning *",
        [id, escopo.organizacaoId, escopo.unidadeId, JSON.stringify(alteracoes)]);
        return linhaProposta(r.rows[0]) ?? null;
      },
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
      /** Agente 2 — Frente B: documento já recebido com o MESMO identificador de transação na MESMA organização. */
      async porChave({ organizacaoId, chave }) {
        const r = await q(`select unidade_id, proposta_id, evento_id from mova.documento where organizacao_id = $1 and leitura->>'chaveDocumento' = $2 order by evento_id limit 1`, [organizacaoId, chave]);
        const x = r.rows[0];
        return x ? { organizacaoId, unidadeId: x.unidade_id, propostaId: x.proposta_id, eventoId: x.evento_id } : null;
      },
      async porTransacao({ organizacaoId, idTransacao }) {
        const r = await q(`select organizacao_id, unidade_id, proposta_id, evento_id from mova.documento
                            where organizacao_id = $1 and leitura->>'idTransacao' = $2 order by evento_id limit 1`, [organizacaoId, idTransacao]);
        const x = r.rows[0];
        return x ? { organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, propostaId: x.proposta_id, eventoId: x.evento_id } : null;
      },
      async marcar(sha256, d) {
        await q(`insert into mova.documento (sha256, organizacao_id, unidade_id, evento_id, proposta_id, leitura) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [sha256, d.organizacaoId ?? null, d.unidadeId ?? null, d.eventoId, d.propostaId ?? null, d.leitura ? JSON.stringify(d.leitura) : null]);
        if (d.unidadeId) await q("update mova.evidencia set organizacao_id = $2, unidade_id = $3 where sha256 = $1 and unidade_id is null", [sha256, d.organizacaoId, d.unidadeId]);
      },
    }),
    // Agente 2 — documentos recebidos SEM leitura. A conferência humana é trilha SÓ DE INCLUSÃO em mova.auditoria
    // (DOCUMENTO_CONFERENCIA, alvo = sha256): nada é atualizado nem apagado; o estado é a última conferência.
    documentosRecebidos: Object.freeze({
      async listar({ organizacaoId, unidadeId, limite = 200, sha256 = null }) {
        const r = await q(`select d.sha256, d.evento_id, d.leitura, ev.removida_em, coalesce(c.lista, '[]'::jsonb) as lista
                             from mova.documento d join mova.evidencia ev on ev.sha256 = d.sha256
                             left join lateral (select jsonb_agg(a.dados || jsonb_build_object('por', a.ator_ref, 'em', a.em) order by a.seq) as lista
                                                  from mova.auditoria a where a.acao = 'DOCUMENTO_CONFERENCIA' and a.alvo = d.sha256 and a.dados->>'unidadeId' = d.unidade_id::text) c on true
                            where d.organizacao_id = $1 and d.unidade_id = $2 and d.leitura->>'modo' = 'SEM_LEITURA' and ($4::text is null or d.sha256 = $4)
                            order by d.criado_em desc limit $3`, [organizacaoId, unidadeId, limite, sha256]);
        return r.rows.map((x) => linhaDoRecebido(x.sha256, { eventoId: x.evento_id, leitura: x.leitura }, x.lista, { removida: Boolean(x.removida_em) }));
      },
      async obter({ organizacaoId, unidadeId, sha256 }) {
        return (await this.listar({ organizacaoId, unidadeId, limite: 1, sha256 }))[0] ?? null;
      },
      async conferir({ organizacaoId, unidadeId, sha256, versao, por, ...dados }) {
        return emTransacao(pool, async (tq) => {
          // Duas pessoas conferindo o MESMO documento: uma espera a outra (sem UPDATE em mova.documento: trava consultiva).
          await tq("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mova.documento:${sha256}`]);
          const d = await tq("select 1 from mova.documento where sha256 = $1 and organizacao_id = $2 and unidade_id = $3 and leitura->>'modo' = 'SEM_LEITURA'", [sha256, organizacaoId, unidadeId]);
          if (d.rowCount === 0) return null;
          const n = Number((await tq("select count(*)::int as n from mova.auditoria where acao = 'DOCUMENTO_CONFERENCIA' and alvo = $1", [sha256])).rows[0].n);
          if (n !== versao) throw Object.assign(new Error("versão"), { codigo: "CONFLITO_VERSAO" });
          await tq("insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('DOCUMENTO_CONFERENCIA', 'USUARIO', $1, $2, $3)",
            [por, sha256, JSON.stringify({ ...dados, organizacaoId, unidadeId, versao })]);
          return true;
        }).then(async (ok) => (ok ? this.obter({ organizacaoId, unidadeId, sha256 }) : null));
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
      /**
       * 15A — memória curta: a pendência MAIS RECENTE da MESMA conversa e do MESMO participante, dentro da validade. O prazo
       * usa o relógio do BANCO (o mesmo de criada_em) — nunca compara dois relógios.
       * Atômica (FOR UPDATE SKIP LOCKED + resolvida_em): nunca retomada duas vezes. Nada de outra conversa ou participante.
       */
      async tomarPendenteRecente({ grupoId, participanteId, validadeMs }) {
        const r = await q(`update mova.mensagem_pendente set resolvida_em = now()
                            where mensagem_id = (select mensagem_id from mova.mensagem_pendente
                                                  where grupo_jid = $1 and resolvida_em is null and criada_em >= now() - make_interval(secs => $3::double precision / 1000)
                                                    and leitura->'evento'->>'participanteId' = $2
                                                  order by criada_em desc limit 1 for update skip locked)
                              and resolvida_em is null
                          returning leitura, grupo_jid`, [grupoId, participanteId, validadeMs]);
        return r.rows[0] ? { grupoId: r.rows[0].grupo_jid, pendente: r.rows[0].leitura } : null;
      },
    }),
    /**
     * Agente 2 — CONTINUIDADE por participante e conversa: depois de uma resposta do MOVA, a próxima mensagem da MESMA pessoa na
     * MESMA conversa é escutada sem exigir o nome, até `ate` (relógio do banco). Guarda só a unidade e a consulta (nunca texto).
     */
    conversas: Object.freeze({
      async registrar({ grupoId, participanteId, unidadeId = null, consulta = null, validadeMs }) {
        await q(`insert into mova.conversa_ativa (grupo_jid, participante_jid, ate, unidade_id, consulta) values ($1,$2, now() + make_interval(secs => $3::double precision / 1000), $4, $5)
                 on conflict (grupo_jid, participante_jid) do update set ate = excluded.ate, unidade_id = coalesce(excluded.unidade_id, mova.conversa_ativa.unidade_id),
                   consulta = coalesce(excluded.consulta, mova.conversa_ativa.consulta), atualizado_em = now()`, [grupoId, participanteId, validadeMs, unidadeId, consulta]);
      },
      async obter({ grupoId, participanteId }) {
        const r = await q("select unidade_id, consulta from mova.conversa_ativa where grupo_jid = $1 and participante_jid = $2 and ate > now()", [grupoId, participanteId]);
        return r.rows[0] ? { unidadeId: r.rows[0].unidade_id, consulta: r.rows[0].consulta } : null;
      },
      async encerrar({ grupoId, participanteId }) {
        await q("delete from mova.conversa_ativa where grupo_jid = $1 and participante_jid = $2", [grupoId, participanteId]);
      },
    }),
    /** Agente 2 — Frente C: políticas de AUTONOMIA (cadastradas por administrador na Central; o motor só lê). */
    politicas: Object.freeze({
      async listar(organizacaoId) {
        const r = await q("select * from mova.politica_autonomia where organizacao_id = $1 order by criada_em", [organizacaoId]);
        return r.rows.map((x) => ({ id: x.id, operacao: x.operacao, organizacaoId: x.organizacao_id, unidadeId: x.unidade_id, nivel: x.nivel, limiteCentavos: Number(x.limite_centavos),
          responsavel: x.responsavel, motivo: x.motivo, vigenteDe: dia(x.vigente_de), vigenteAte: x.vigente_ate ? dia(x.vigente_ate) : null, revogadaEm: x.revogada_em ? x.revogada_em.toISOString() : null }));
      },
      async criar(p, { criadaPor }) {
        const r = await q(`insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, vigente_ate, criada_por)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [p.operacao, p.organizacaoId, p.unidadeId ?? null, p.nivel, p.limiteCentavos, p.responsavel, p.motivo, p.vigenteDe, p.vigenteAte ?? null, criadaPor]);
        return r.rows[0].id;
      },
      async revogar({ id, organizacaoId, por }) {
        return (await q("update mova.politica_autonomia set revogada_em = now(), revogada_por = $3 where id = $1 and organizacao_id = $2 and revogada_em is null", [id, organizacaoId, por])).rowCount === 1;
      },
    }),
    /** Agente 2 — Frente C: operações executadas (chave única = idempotência; reversão registrada, nunca apagada). */
    operacoes: Object.freeze({
      async reservar(o) {
        const r = await q(`insert into mova.operacao_executada (chave, proposta_id, organizacao_id, unidade_id, operacao, nivel, politica_id, estado, valor_centavos, executada_por)
                           values ($1,$2,$3,$4,$5,$6,$7,'EXECUTANDO',$8,$9) on conflict (chave) do nothing returning *`,
        [o.chave, o.propostaId, o.organizacaoId, o.unidadeId, o.operacao, o.nivel, o.politicaId ?? null, o.valorCentavos, o.executadaPor]);
        if (r.rowCount === 1) return { operacao: linhaOperacao(r.rows[0]), nova: true };
        return { operacao: linhaOperacao((await q("select * from mova.operacao_executada where chave = $1", [o.chave])).rows[0]), nova: false };
      },
      async concluir(id, resultado) { return linhaOperacao((await q("update mova.operacao_executada set estado = 'EXECUTADA', resultado = $2 where id = $1 and estado = 'EXECUTANDO' returning *", [id, JSON.stringify(resultado)])).rows[0]); },
      async falhar(id, motivo) { return linhaOperacao((await q("update mova.operacao_executada set estado = 'FALHOU', motivo = $2 where id = $1 and estado = 'EXECUTANDO' returning *", [id, String(motivo).slice(0, 200)])).rows[0]); },
      async reverter(id, escopo, { por, justificativa, resultado }) {
        return linhaOperacao((await q(`update mova.operacao_executada set estado = 'REVERTIDA', revertida_por = $4, revertida_em = now(), justificativa_reversao = $5,
                                          resultado = resultado || jsonb_build_object('reversao', $6::jsonb)
                                        where id = $1 and organizacao_id = $2 and unidade_id = $3 and estado = 'EXECUTADA' returning *`,
        [id, escopo.organizacaoId, escopo.unidadeId, por, justificativa, JSON.stringify(resultado ?? {})])).rows[0]);
      },
      async obter(id, escopo) { return linhaOperacao((await q("select * from mova.operacao_executada where id = $1 and organizacao_id = $2 and unidade_id = $3", [id, escopo.organizacaoId, escopo.unidadeId])).rows[0]); },
      async listar(escopo, limite = 200) {
        return (await q("select * from mova.operacao_executada where organizacao_id = $1 and unidade_id = $2 order by criada_em desc limit $3", [escopo.organizacaoId, escopo.unidadeId, limite])).rows.map(linhaOperacao);
      },
    }),
    /**
     * Agente 2 — RETRATO DOS MEMBROS do grupo (gravado pelo Gateway/relé; o MOVA só confere). Base da política GRUPO_FINANCEIRO:
     * sem retrato recente, valores nunca saem no grupo.
     */
    // Agente 2 — Frente D: notas recebidas dos entregadores, envios da rotina (chave única) e automações com pausa.
    notasEntregador: Object.freeze({
      async registrar(n) {
        const ins = await q(`insert into mova.nota_entregador (organizacao_id, unidade_id, entregador, semana_inicio, sha256, evento_id, estado) values ($1,$2,$3,$4,$5,$6,'PENDENTE_ANEXO')
                             on conflict (unidade_id, entregador, semana_inicio, sha256) do nothing returning *`, [n.organizacaoId, n.unidadeId, n.entregador, n.semanaInicio, n.sha256, n.eventoId]);
        if (ins.rows[0]) return { nota: linhaNota(ins.rows[0]), nova: true };
        const r = await q("select * from mova.nota_entregador where unidade_id = $1 and entregador = $2 and semana_inicio = $3 and sha256 = $4", [n.unidadeId, n.entregador, n.semanaInicio, n.sha256]);
        return { nota: linhaNota(r.rows[0]), nova: false };
      },
      async concluir(id, { estado, motivo = null, documentoId = null, situacaoDocumental = null }) {
        const r = await q(`update mova.nota_entregador set estado = $2, motivo = $3, documento_id = $4, situacao_documental = $5, atualizada_em = now() where id = $1 and estado = 'PENDENTE_ANEXO'`, [id, estado, motivo, documentoId, situacaoDocumental]);
        return r.rowCount === 1;
      },
      /** 23/11: resultado da leitura e da conferência da nota (sem o arquivo; só os campos conferidos). */
      async registrarLeitura(id, { leitura, conferencia }) {
        await q("update mova.nota_entregador set leitura = $2, conferencia = $3, atualizada_em = now() where id = $1", [id, leitura ? JSON.stringify(leitura) : null, conferencia]);
      },
      async listar(escopo) {
        return (await q("select * from mova.nota_entregador where organizacao_id = $1 and unidade_id = $2 order by criada_em desc limit 200", [escopo.organizacaoId, escopo.unidadeId])).rows.map(linhaNota);
      },
    }),
    // 23/11: cadastro pelo gestor (a chave já foi conferida no Financeiro pela rota). FONTE ÚNICA dos contatos (Financeiro e MOVA).
    // Nada é apagado: alterar/desativar ENCERRA a linha vigente (quem, quando, por quê) e, se for o caso, abre outra (histórico).
    entregadores: Object.freeze({
      async cadastrar(e) {
        try {
          const r = await q(`insert into mova.entregador_autorizado (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, observacoes) values ($1,$2,$3,$4,$5,'{}',$6,$7,$8) returning id`,
            [e.organizacaoId, e.unidadeId, e.chave, e.telefoneE164, e.privado, e.nome ?? null, e.cadastradoPor ?? null, e.observacoes ?? null]);
          return { id: r.rows[0].id };
        } catch (erro) { if (erro?.code === "23505") return { conflito: true }; throw erro; }
      },
      async revogar({ organizacaoId, unidadeId, chave, por = null, motivo = "DESATIVADO" }) {
        return (await q("update mova.entregador_autorizado set ativo = false, revogado_em = now(), revogado_por = $4, motivo_revogacao = $5 where organizacao_id = $1 and unidade_id = $2 and chave = $3 and ativo",
          [organizacaoId, unidadeId, chave, por, motivo])).rowCount;
      },
      /** Troca número/nome/observação: encerra a linha vigente e abre a nova NA MESMA transação (conflito ⇒ nada muda). */
      async alterar({ organizacaoId, unidadeId, chave, por, mudancas }) {
        try {
          return await emTransacao(pool, async (tx) => {
            await tx("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mova.entregador:${unidadeId}:${chave}`]);
            const [v] = (await tx("select * from mova.entregador_autorizado where organizacao_id = $1 and unidade_id = $2 and chave = $3 and ativo", [organizacaoId, unidadeId, chave])).rows;
            if (!v) return { naoEncontrado: true };
            const nova = { telefoneE164: mudancas.telefoneE164 ?? v.telefone_e164, privado: mudancas.privado ?? v.privado, nome: mudancas.nome !== undefined ? mudancas.nome : v.nome, observacoes: mudancas.observacoes !== undefined ? mudancas.observacoes : v.observacoes };
            if (nova.telefoneE164 === v.telefone_e164 && nova.nome === v.nome && nova.observacoes === v.observacoes) return { semMudanca: true };
            const motivo = nova.telefoneE164 !== v.telefone_e164 ? "TROCA_DE_NUMERO" : "EDICAO";
            await tx("update mova.entregador_autorizado set ativo = false, revogado_em = now(), revogado_por = $2, motivo_revogacao = $3 where id = $1", [v.id, por, motivo]);
            const r = await tx(`insert into mova.entregador_autorizado (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, observacoes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
              [organizacaoId, unidadeId, chave, nova.telefoneE164, nova.privado, motivo === "TROCA_DE_NUMERO" ? [] : v.ids, nova.nome, por, nova.observacoes]);
            return { id: r.rows[0].id, motivo, anterior: `…${v.telefone_e164.slice(-4)}`, atual: `…${nova.telefoneE164.slice(-4)}` };
          });
        } catch (erro) { if (erro?.code === "23505") return { conflito: true }; throw erro; }
      },
      /** Reativa o ÚLTIMO cadastro encerrado do entregador (mesmo número, nome e observação), numa linha nova. */
      async reativar({ organizacaoId, unidadeId, chave, por }) {
        try {
          return await emTransacao(pool, async (tx) => {
            await tx("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mova.entregador:${unidadeId}:${chave}`]);
            if ((await tx("select 1 from mova.entregador_autorizado where unidade_id = $1 and chave = $2 and ativo", [unidadeId, chave])).rowCount) return { conflito: true };
            const [u] = (await tx("select * from mova.entregador_autorizado where organizacao_id = $1 and unidade_id = $2 and chave = $3 order by criado_em desc limit 1", [organizacaoId, unidadeId, chave])).rows;
            if (!u) return { naoEncontrado: true };
            const r = await tx(`insert into mova.entregador_autorizado (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, observacoes) values ($1,$2,$3,$4,$5,'{}',$6,$7,$8) returning id`,
              [organizacaoId, unidadeId, chave, u.telefone_e164, u.privado, u.nome, por, u.observacoes]);
            return { id: r.rows[0].id, telefone: `…${u.telefone_e164.slice(-4)}` };
          });
        } catch (erro) { if (erro?.code === "23505") return { conflito: true }; throw erro; }
      },
      async listar(escopo) {
        return (await q("select * from mova.entregador_autorizado where organizacao_id = $1 and unidade_id = $2 order by criado_em desc limit 500", [escopo.organizacaoId, escopo.unidadeId])).rows.map(linhaCadastro);
      },
    }),
    enviosEntregador: Object.freeze({
      async registrar(e) {
        const r = await q(`insert into mova.entregador_envio (chave, organizacao_id, unidade_id, entregador, tipo, semana_inicio) values ($1,$2,$3,$4,$5,$6) on conflict (chave) do nothing`, [e.chave, e.organizacaoId, e.unidadeId, e.entregador, e.tipo, e.semanaInicio]);
        return r.rowCount === 1;
      },
      async listar(escopo) {
        return (await q(`select chave, entregador, tipo, semana_inicio, criado_em from mova.entregador_envio where organizacao_id = $1 and unidade_id = $2 order by criado_em desc limit 200`, [escopo.organizacaoId, escopo.unidadeId]))
          .rows.map((r) => ({ chave: r.chave, entregador: r.entregador, tipo: r.tipo, semanaInicio: dia(r.semana_inicio), criadoEm: r.criado_em.toISOString() }));
      },
    }),
    automacoes: Object.freeze({
      async obter(nome, unidadeId) { return linhaAutomacao((await q("select * from mova.automacao where nome = $1 and unidade_id = $2", [nome, unidadeId])).rows[0]); },
      async listar(escopo) { return (await q("select * from mova.automacao where organizacao_id = $1 and unidade_id = $2 order by nome", [escopo.organizacaoId, escopo.unidadeId])).rows.map(linhaAutomacao); },
      async definir({ nome, organizacaoId, unidadeId, ativa, horario = "09:00" }) {
        return linhaAutomacao((await q(`insert into mova.automacao (nome, organizacao_id, unidade_id, ativa, horario) values ($1,$2,$3,$4,$5)
          on conflict (nome, unidade_id) do update set ativa = excluded.ativa, horario = excluded.horario, atualizada_em = now() where mova.automacao.organizacao_id = excluded.organizacao_id returning *`, [nome, organizacaoId, unidadeId, ativa, horario])).rows[0]);
      },
      async pausar({ nome, unidadeId, por, motivo = null }) {
        return linhaAutomacao((await q("update mova.automacao set pausada_em = now(), pausada_por = $3, motivo = $4, atualizada_em = now() where nome = $1 and unidade_id = $2 returning *", [nome, unidadeId, por, motivo])).rows[0]);
      },
      async retomar({ nome, unidadeId }) {
        return linhaAutomacao((await q("update mova.automacao set pausada_em = null, pausada_por = null, motivo = null, atualizada_em = now() where nome = $1 and unidade_id = $2 returning *", [nome, unidadeId])).rows[0]);
      },
      async marcarExecucao(nome, unidadeId, em) { await q("update mova.automacao set ultima_execucao = $3 where nome = $1 and unidade_id = $2", [nome, unidadeId, em]); },
    }),
    // Agente 2 — cadastro VIGENTE no banco (não só na configuração carregada no início): revogar um participante passa a valer
    // para documentos sem reiniciar o backend. Grupo: o próprio grupo ativo. Conversa privada derivada: os grupos ativos da pessoa.
    autorizacoes: Object.freeze({
      async vigentes({ grupoId, participanteId, telefoneE164 = null }) {
        if (!participanteId) return [];
        const r = await q(`select p.perfil, p.unidades from mova.participante_autorizado p join mova.grupo_autorizado g using (grupo_jid)
           where p.ativo and g.ativo and g.tipo = 'GRUPO'
             and (case when $1 like '%@g.us' then p.grupo_jid = $1 else true end)
             and ($2 = any(p.ids) or p.privado = $2 or ($3::text is not null and $3 = any(p.telefones)))`, [grupoId, participanteId, telefoneE164]);
        return r.rows.map((x) => ({ perfil: x.perfil, unidades: x.unidades }));
      },
    }),
    membros: Object.freeze({
      async registrar({ grupoId, membros, verificadoEm = null, fonte = "GATEWAY" }) {
        await q(`insert into mova.grupo_membros (grupo_jid, membros, verificado_em, fonte) values ($1, $2, coalesce($3::timestamptz, now()), $4)
                 on conflict (grupo_jid) do update set membros = excluded.membros, verificado_em = excluded.verificado_em, fonte = excluded.fonte`, [grupoId, membros, verificadoEm, fonte]);
      },
      async obter(grupoId) {
        const r = await q("select membros, verificado_em from mova.grupo_membros where grupo_jid = $1", [grupoId]);
        return r.rows[0] ? { membros: r.rows[0].membros, verificadoEm: r.rows[0].verificado_em } : null;
      },
    }),
    saida: Object.freeze({
      async enfileirar({ grupoId, respostaA, texto, eventoId = null }) {
        await q("insert into mova.resposta (grupo_jid, resposta_a, evento_id, texto) values ($1,$2,$3,$4)", [grupoId, respostaA, eventoId, texto]);
      },
      async listar() {
        return (await q("select grupo_jid as \"grupoId\", resposta_a as \"respostaA\", texto, estado from mova.resposta order by seq")).rows;
      },
      /** 15B: publicada no relé — fica ENVIANDO com lease longo (o resultado vem por sincronização, não por nova reserva). */
      async marcarNoRele(id) {
        await q("update mova.resposta set estado = 'ENVIANDO', ultimo_erro = 'AGUARDANDO_RELE', lease_ate = now() + interval '1 day' where id = $1", [id]);
      },
      async aguardandoRele() {
        return (await q("select id from mova.resposta where estado = 'ENVIANDO' and ultimo_erro = 'AGUARDANDO_RELE' order by seq limit 100")).rows.map((r) => r.id);
      },
      /** Eco de uma resposta do próprio agente (id do provedor registrado no envio) ⇒ nunca reprocessar. */
      async ehRespostaPropria(mensagemId) {
        return (await q("select 1 from mova.resposta where provider_message_id = $1", [mensagemId])).rowCount > 0;
      },
      /** Respostas efetivamente entregues ao transporte desde o marco de ativação (base PERSISTENTE do teto de envios). */
      async contarEnviadasDesde(naoAntesDe) {
        return Number((await q("select count(*)::int as n from mova.resposta where criada_em >= $1::timestamptz and (estado = 'ENVIADA' or (estado = 'ENVIANDO' and ultimo_erro = 'AGUARDANDO_RELE'))", [naoAntesDe])).rows[0].n);
      },
      async marcarEnviada(id, providerMessageId) {
        await q("update mova.resposta set estado = 'ENVIADA', provider_message_id = $2, enviada_em = now(), lease_ate = null where id = $1", [id, providerMessageId]);
      },
      /** Pega até `limite` respostas PENDENTES (ou ENVIANDO com lease vencido) para envio — dois enviadores nunca pegam a mesma. */
      // 15A: `naoAntesDe` (marco de ativação do envio) e `destinos` (conversas autorizadas) filtram NO BANCO — resposta antiga ou
      // para destino fora da lista nunca é sequer reservada (proteção contra envio retroativo, independente do descarte).
      async tomarParaEnvio({ limite = 10, leaseMs = 60_000, agora = new Date(), naoAntesDe = null, destinos = null } = {}) {
        return emTransacao(pool, async (tx) => (await tx(`
          update mova.resposta set estado = 'ENVIANDO', tentativas = tentativas + 1, lease_ate = $2
           where id in (select id from mova.resposta where (estado = 'PENDENTE' or (estado = 'ENVIANDO' and lease_ate < $1))
                           and ($4::timestamptz is null or criada_em >= $4::timestamptz)
                           and ($5::text[] is null or grupo_jid = any($5::text[]))
                         order by seq limit $3 for update skip locked)
          returning id, seq, grupo_jid as "grupoId", resposta_a as "respostaA", evento_id as "eventoId", texto, tentativas,
                    -- 15H: o JID com que o WhatsApp entregou a mensagem respondida (o endereço que o Gateway reconhece)
                    (select e.participante_jid from mova.evento e where e.evento_id = mova.resposta.evento_id) as "participanteOriginal"`,
        [agora.toISOString(), new Date(agora.getTime() + leaseMs).toISOString(), limite, naoAntesDe, destinos])).rows
          // 15A: UPDATE … RETURNING não garante ordem — as respostas saem na ordem em que foram criadas.
          .sort((a, b) => Number(a.seq) - Number(b.seq)));
      },
      /**
       * 15A: DESCARTE auditável de respostas PENDENTES (nunca DELETE): estado SUPRIMIDA + motivo; uma linha de auditoria com
       * quem, por quê, quantas e quais ids (sem texto nem número). Só PENDENTE criada até `criadasAte` (e, se dado, só os `ids`).
       */
      async suprimir({ criadasAte, motivo, ator, ids = null }) {
        if (!criadasAte || !/^[A-Z0-9_]{3,40}$/.test(motivo ?? "") || !ator) throw new TypeError("suprimir exige criadasAte, motivo (CÓDIGO) e ator");
        return emTransacao(pool, async (tx) => {
          const r = (await tx(`update mova.resposta set estado = 'SUPRIMIDA', ultimo_erro = $2, lease_ate = null
                                where estado = 'PENDENTE' and criada_em <= $1::timestamptz and ($3::uuid[] is null or id = any($3::uuid[]))
                              returning id`, [criadasAte, `SUPRIMIDA:${motivo}`, ids])).rows.map((x) => x.id);
          await tx(`insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('RESPOSTAS_SUPRIMIDAS', 'USUARIO', $1, 'resposta', $2)`,
            [String(ator).slice(0, 80), JSON.stringify({ motivo, criadasAte, quantidade: r.length, ids: r })]);
          return { suprimidas: r.length, ids: r };
        });
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
            // Agente 2: terminado, o CONTEÚDO do arquivo sai da fila (o original autorizado fica só em mova.evidencia).
            await q("update mova.fila set estado = 'CONCLUIDO', resultado = $2, ultimo_erro = null, lease_ate = null, atualizado_em = now(), carga = case when carga->'midia'->>'base64' is null then carga else jsonb_set(carga, '{midia,base64}', 'null'::jsonb) end where evento_id = $1", [item.evento_id, JSON.stringify(resultado ?? null)]);
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

/**
 * Grava a configuração (instância, grupos, unidades, participantes) — uso administrativo/teste. Grupo nasce desligado salvo
 * `ativo: true`. Participantes: a lista ATIVA do grupo passa a ser exatamente a informada (quem saiu é REVOGADO, nunca apagado).
 */
export async function instalarConfiguracao(pool, cfg, { instanciaId = "principal" } = {}) {
  const tipoDe = (g) => (g.grupoId.endsWith("@g.us") ? "GRUPO" : g.entregador ? "PRIVADO_ENTREGADOR" : g.derivada ? "PRIVADO_PARTICIPANTE" : "PRIVADO_HOMOLOGACAO");
  const mesmo = (r, p) => JSON.stringify([[...r.ids].sort(), [...r.telefones].sort(), r.perfil, [...r.unidades].sort(), r.privado ?? null, r.nome ?? null])
    === JSON.stringify([[...p.ids].sort(), [...p.telefones].sort(), p.perfil, [...p.unidades].sort(), p.privado ?? null, p.nome ?? null]);
  await emTransacao(pool, async (tx) => {
    await tx("insert into mova.instancia_gateway (id) values ($1) on conflict do nothing", [instanciaId]);
    for (const g of cfg.gruposAutorizados) {
      const unidades = cfg.unidades.filter((u) => g.unidades.includes(u.unidadeId));
      await tx(`insert into mova.grupo_autorizado (grupo_jid, organizacao_id, instancia_id, ativo, tipo, acesso, consultas_no_grupo, politica_resposta) values ($1,$2,$3,true,$4,$5,$6,$7)
                on conflict (grupo_jid) do update set ativo = true, acesso = excluded.acesso, consultas_no_grupo = excluded.consultas_no_grupo, politica_resposta = excluded.politica_resposta`,
      [g.grupoId, unidades[0].organizacaoId, instanciaId, tipoDe(g), g.acesso ?? "ABERTO", g.consultasNoGrupo ?? [], g.politicaResposta ?? "PRIVADO_RESTRITO"]);
      for (const u of unidades) {
        await tx(`insert into mova.grupo_unidade (grupo_jid, organizacao_id, unidade_id, nome, apelidos, documentos, fontes) values ($1,$2,$3,$4,$5,$6,$7)
                  on conflict (grupo_jid, unidade_id) do update set nome = excluded.nome, apelidos = excluded.apelidos, documentos = excluded.documentos, fontes = excluded.fontes`,
        [g.grupoId, u.organizacaoId, u.unidadeId, u.nome, u.apelidosOriginais ?? u.apelidos, u.documentos, JSON.stringify(u.fontesOriginais ?? u.fontes)]);
      }
      if (g.derivada || (g.acesso ?? "ABERTO") !== "LISTA") continue; // a privada derivada (e a do entregador) vem das listas
      const ativos = (await tx("select id, ids, telefones, perfil, unidades, privado, nome from mova.participante_autorizado where grupo_jid = $1 and ativo for update", [g.grupoId])).rows;
      const lista = g.participantes.map((p) => ({ ...p, unidades: p.unidades.length === g.unidades.length && g.unidades.every((u) => p.unidades.includes(u)) ? [] : p.unidades }));
      for (const r of ativos) if (!lista.some((p) => mesmo(r, p))) await tx("update mova.participante_autorizado set ativo = false, revogado_em = now() where id = $1", [r.id]);
      for (const p of lista) if (!ativos.some((r) => mesmo(r, p))) {
        await tx("insert into mova.participante_autorizado (grupo_jid, ids, telefones, perfil, unidades, privado, nome) values ($1,$2,$3,$4,$5,$6,$7)", [g.grupoId, p.ids, p.telefones, p.perfil, p.unidades, p.privado, p.nome]);
      }
    }
    // Agente 2 — Frente D: a lista ATIVA de entregadores passa a ser exatamente a informada (quem saiu é REVOGADO, nunca apagado).
    if (Array.isArray(cfg.entregadores)) {
      // 23/11: cadastros feitos pelo gestor na Central (cadastrado_por) só saem pela revogação da própria Central.
      const ativos = (await tx("select id, unidade_id, chave, telefone_e164, privado, ids, nome from mova.entregador_autorizado where ativo and cadastrado_por is null for update")).rows;
      const igual = (r, e) => r.unidade_id === e.unidadeId && r.chave === e.chave && r.telefone_e164 === e.telefoneE164 && r.privado === e.privado && JSON.stringify([...r.ids].sort()) === JSON.stringify([...e.ids].sort()) && (r.nome ?? null) === (e.nome ?? null);
      const lista = cfg.entregadores.filter((e) => e.ativo);
      for (const r of ativos) if (!lista.some((e) => igual(r, e))) await tx("update mova.entregador_autorizado set ativo = false, revogado_em = now() where id = $1", [r.id]);
      for (const e of lista) if (!ativos.some((r) => igual(r, e))) {
        await tx("insert into mova.entregador_autorizado (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome) values ($1,$2,$3,$4,$5,$6,$7)", [e.organizacaoId, e.unidadeId, e.chave, e.telefoneE164, e.privado, e.ids, e.nome]);
      }
    }
  });
}

/** Lê do banco a configuração BRUTA (para validarConfiguracao): só grupos ATIVOS. */
export async function carregarConfiguracao(pool, { identidadeServico, modo = "SIMULACAO" }) {
  const q = consultar(pool);
  // Conversas privadas só entram nos modos HOMOLOGACAO e PILOTO; fora deles são ignoradas mesmo que ativas no banco.
  // 16A: no PILOTO entram SÓ as conversas privadas — nenhum grupo, mesmo ativo.
  // Agente 2: OPERACAO lê só GRUPOS; as conversas privadas dos participantes são DERIVADAS da lista (validarConfiguracao).
  // A conversa privada de homologação (PRIVADO_HOMOLOGACAO) nunca entra na OPERACAO, e a derivada nunca entra fora dela.
  const filtro = "g.ativo and g.tipo not in ('PRIVADO_PARTICIPANTE','PRIVADO_ENTREGADOR') and (case $1 when 'PILOTO' then g.tipo <> 'GRUPO' when 'HOMOLOGACAO' then true else g.tipo = 'GRUPO' end)";
  const grupos = (await q(`select g.grupo_jid, g.acesso, g.consultas_no_grupo, g.politica_resposta from mova.grupo_autorizado g where ${filtro}`, [modo])).rows;
  const participantes = (await q(`select p.* from mova.participante_autorizado p join mova.grupo_autorizado g using (grupo_jid) where p.ativo and ${filtro} order by p.criado_em`, [modo])).rows;
  const unidades = (await q(`select gu.* from mova.grupo_unidade gu join mova.grupo_autorizado g using (grupo_jid) where ${filtro} order by gu.nome`, [modo])).rows;
  const porId = new Map();
  for (const u of unidades) porId.set(u.unidade_id, { organizacaoId: u.organizacao_id, unidadeId: u.unidade_id, nome: u.nome, empresa: u.empresa ?? null, apelidos: u.apelidos, documentos: u.documentos, fontes: u.fontes });
  // Agente 2 — Frente D: entregadores autorizados (só OPERACAO); as conversas deles nascem em validarConfiguracao.
  const entregadores = modo === "OPERACAO" ? (await q("select * from mova.entregador_autorizado where ativo order by criado_em")).rows
    .filter((r) => porId.has(r.unidade_id)) // 23/11: unidade fora do MOVA (sem grupo) não derruba a montagem; a rota já recusa
    .map((r) => ({ organizacaoId: r.organizacao_id, unidadeId: r.unidade_id, chave: r.chave, telefoneE164: r.telefone_e164, privado: r.privado, ids: r.ids, nome: r.nome })) : [];
  return {
    modo, identidadeServico, entregadores,
    unidades: [...porId.values()],
    gruposAutorizados: grupos.map((g) => ({
      grupoId: g.grupo_jid, unidades: unidades.filter((u) => u.grupo_jid === g.grupo_jid).map((u) => u.unidade_id), acesso: g.acesso, consultasNoGrupo: g.consultas_no_grupo, politicaResposta: g.politica_resposta,
      ...(g.acesso === "LISTA" ? { participantes: participantes.filter((p) => p.grupo_jid === g.grupo_jid).map((p) => ({ ids: p.ids, telefones: p.telefones, perfil: p.perfil, unidades: p.unidades.length ? p.unidades : undefined, privado: p.privado, nome: p.nome })) } : {}),
    })),
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
    // 15A (V-1): texto puro não tem documento — a leitura da IA vem da proposta (marcada como tal).
    dadosExtraidos: r.leitura ?? (r.dados?.leitura ? { ...r.dados.leitura, fonte: "PROPOSTA" } : null),
    proposta: r.proposta_id ? { id: r.proposta_id, tipo: r.proposta_tipo, estado: r.proposta_estado, valorCentavos: r.valor_centavos === null ? null : Number(r.valor_centavos),
      categoriaSugerida: r.dados?.categoriaSugerida ?? null, datas: r.dados?.datas ?? null, bloqueioDeAplicacao: r.dados?.bloqueioDeAplicacao ?? null, sinaisDeInjecao: r.dados?.sinaisDeInjecao ?? false,
      competenciaPendente: r.dados?.competenciaPendente === true, competenciaRevisada: r.dados?.competenciaRevisada ?? null } : null,
    decisoes: r.decisoes,
  });
  const SQL = `
    select e.evento_id, e.recebido_em, e.tipo, e.texto, e.participante_jid, pa.nome_exibicao, ev.sha256, ev.mime, ev.nome_arquivo, d.leitura,
           p.id as proposta_id, p.tipo as proposta_tipo, p.estado as proposta_estado, p.valor_centavos, p.dados,
           (select coalesce(jsonb_agg(jsonb_build_object('decisao', x.decisao, 'motivo', x.motivo, 'em', x.em, 'propostaId', x.proposta_id) order by x.seq), '[]'::jsonb)
              from mova.decisao x where x.evento_id = e.evento_id) as decisoes
      from mova.evento e
      left join mova.participante pa on pa.grupo_jid = e.grupo_jid and pa.participante_jid = e.participante_jid
      left join lateral (select coalesce(e.documento_sha256, (select d2.sha256 from mova.documento d2 where d2.evento_id = e.evento_id limit 1)) as sha) ds on true
      left join mova.evidencia ev on ev.sha256 = ds.sha
      left join mova.documento d on d.sha256 = ds.sha and d.evento_id = e.evento_id
      left join mova.proposta p on p.evento_id = e.evento_id`;
  // Conversas que atendem a unidade (escopo das falhas sem unidade). Só metadados saem destas consultas — nunca texto ou documento.
  const CONVERSAS = "select gu.grupo_jid from mova.grupo_unidade gu where gu.organizacao_id = $1 and gu.unidade_id = $2";
  return Object.freeze({
    /**
     * Agente 2 — Frente E: VISÃO GERAL da Central de Operações, só com CONTAGENS REAIS do banco do MOVA desta unidade
     * (nenhum indicador estimado). `dias` limita o período das mensagens; propostas/operações/notas são o estado atual.
     */
    async visaoGeral({ organizacaoId, unidadeId, dias = 7 }) {
      const d = Number.isInteger(dias) && dias >= 1 && dias <= 90 ? dias : 7;
      const p = [organizacaoId, unidadeId, d];
      const periodo = "organizacao_id = $1 and unidade_id = $2 and em >= now() - make_interval(days => $3::int)";
      const [decisoes, mensagens, respostas, propostas, operacoes, notas, automacoes] = await Promise.all([
        q(`select decisao, count(*)::int n from mova.decisao where ${periodo} group by decisao`, p),
        q(`select count(distinct evento_id)::int mensagens, count(distinct documento_sha256)::int documentos from mova.decisao where ${periodo}`, p),
        q(`select r.estado, count(*)::int n from mova.resposta r where r.evento_id in (select evento_id from mova.decisao where ${periodo}) group by r.estado`, p),
        q("select estado, count(*)::int n, coalesce(sum(valor_centavos), 0)::bigint v from mova.proposta where organizacao_id = $1 and unidade_id = $2 group by estado", [organizacaoId, unidadeId]),
        q("select estado, count(*)::int n, coalesce(sum(valor_centavos), 0)::bigint v from mova.operacao_executada where organizacao_id = $1 and unidade_id = $2 group by estado", [organizacaoId, unidadeId]),
        q("select estado, count(*)::int n from mova.nota_entregador where organizacao_id = $1 and unidade_id = $2 group by estado", [organizacaoId, unidadeId]),
        q("select count(*) filter (where ativa and pausada_em is null)::int ativas, count(*) filter (where pausada_em is not null)::int pausadas from mova.automacao where organizacao_id = $1 and unidade_id = $2", [organizacaoId, unidadeId]),
      ]);
      const mapa = (rows, f = (r) => r.n) => Object.fromEntries(rows.map((r) => [r.decisao ?? r.estado, f(r)]));
      const porDecisao = mapa(decisoes.rows);
      return {
        periodoDias: d, geradoEm: new Date().toISOString(),
        mensagens: { recebidas: mensagens.rows[0].mensagens, consultas: porDecisao.CONSULTA ?? 0, documentos: mensagens.rows[0].documentos, ignoradas: porDecisao.IGNORADO ?? 0, bloqueadas: porDecisao.BLOQUEADO ?? 0, porDecisao },
        respostas: mapa(respostas.rows),
        propostas: mapa(propostas.rows, (r) => ({ quantidade: r.n, valorCentavos: Number(r.v) })),
        operacoes: mapa(operacoes.rows, (r) => ({ quantidade: r.n, valorCentavos: Number(r.v) })),
        notasEntregadores: mapa(notas.rows),
        automacoes: automacoes.rows[0],
      };
    },
    /** H-1: falhas GERAIS (sem unidade identificada) das conversas que atendem a unidade + pendentes dessas conversas. */
    async falhasGerais({ organizacaoId, unidadeId, limite = 100 }) {
      const itens = (await q(`select d.evento_id as "eventoId", d.decisao as tipo, d.motivo, d.em, f.estado, f.tentativas
          from mova.decisao d join mova.fila f on f.evento_id = d.evento_id
         where d.unidade_id is null and d.decisao in ('FALHA_LEITURA','FALHOU') -- só FALHAS (pergunta pendente, ignorado etc. não são falha)
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
