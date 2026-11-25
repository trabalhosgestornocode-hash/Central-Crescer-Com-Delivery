// MOVA CORE — F2.1: PERSISTÊNCIA REAL do vínculo WhatsApp ↔ plataforma e da memória do fio (tabelas mova.core_* da 0019).
//
// Mesmo contrato dos repositórios em memória (identidade.js, memoria.js); o que muda é a garantia ENTRE PROCESSOS:
//  - vínculo ATIVO único por pessoa e por perfil: índice único parcial (duas confirmações simultâneas ⇒ uma vence, a outra JA_VINCULADO);
//  - código de uso ÚNICO: consumo é UPDATE condicional (consumido_em is null) — só um processo recebe a linha;
//  - limite de tentativas ATÔMICO: trava consultiva da chave na transação + contagem da última hora;
//  - revogação imediata: o resolver lê o banco a cada requisição (nenhum cache);
//  - memória com VERSÃO (compare-and-set): duas mensagens simultâneas da mesma pessoa não se sobrescrevem;
//  - retenção: cada fio tem expira_em; o expurgo APAGA o conteúdo (estado '{}'), nunca a linha (mova_app não tem DELETE).
// Sem dado pessoal em claro além dos identificadores já usados pelo MOVA (JID nas chaves da memória, como em mova.conversa_ativa).
import { ESTADO_VINCULO } from "./identidade.js";

const ms = (d) => (d == null ? null : new Date(d).getTime());
const iso = (n) => new Date(n).toISOString();

const vinculoDaLinha = (r) => r && ({
  id: r.id, chave: r.chave_canonica, organizacaoId: r.organizacao_id, perfilId: r.perfil_id, contaId: r.conta_id, metodo: r.metodo, estado: r.estado,
  criadoPor: r.criado_por, criadoEm: r.criado_em?.toISOString?.() ?? r.criado_em, revogadoEm: r.revogado_em?.toISOString?.() ?? null, revogadoPor: r.revogado_por, motivoRevogacao: r.motivo_revogacao,
});
const desafioDaLinha = (r) => r && ({ id: r.id, organizacaoId: r.organizacao_id, perfilId: r.perfil_id, contaId: r.conta_id, sal: r.sal, codigoHash: r.codigo_hash, expiraEm: ms(r.expira_em), consumidoEm: ms(r.consumido_em) });

async function emTransacao(pool, fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}

/** @param {import("pg").Pool} pool  pool do papel de operação do MOVA (mova_app) */
export function criarRepositorioDeIdentidadePostgres(pool, { janelaTentativasMs = 3_600_000 } = {}) {
  return Object.freeze({
    persistente: true,
    async vinculoAtivo(chave) {
      const { rows } = await pool.query("select * from mova.core_vinculo where chave_canonica = $1 and estado = 'ATIVO'", [chave]);
      return vinculoDaLinha(rows[0]) ?? null;
    },
    async criarVinculo(v) {
      try {
        const { rows } = await pool.query(
          `insert into mova.core_vinculo (id, organizacao_id, chave_canonica, conta_id, perfil_id, metodo, estado, criado_por, criado_em)
           values ($1, $2, $3, $4, $5, $6, 'ATIVO', $7, $8) returning *`,
          [v.id, v.organizacaoId, v.chave, v.contaId ?? null, v.perfilId, v.metodo, v.criadoPor ?? null, v.criadoEm]);
        return vinculoDaLinha(rows[0]);
      } catch (e) {
        if (e.code === "23505") throw Object.assign(new Error("já vinculado"), { codigo: "JA_VINCULADO" }); // índice único parcial
        throw e;
      }
    },
    async revogar(id, { revogadoPor = null, revogadoEm, motivoRevogacao = "REVOGADO" } = {}) {
      const { rows } = await pool.query(
        `update mova.core_vinculo set estado = 'REVOGADO', revogado_em = $2, revogado_por = $3, motivo_revogacao = $4
          where id = $1 and estado = 'ATIVO' returning *`, [id, revogadoEm ?? new Date().toISOString(), revogadoPor, String(motivoRevogacao).slice(0, 120)]);
      return vinculoDaLinha(rows[0]) ?? null;
    },
    async obterVinculo(id) { const { rows } = await pool.query("select * from mova.core_vinculo where id = $1", [id]); return vinculoDaLinha(rows[0]) ?? null; },
    async vinculosDaOrganizacao(organizacaoId) {
      const { rows } = await pool.query("select * from mova.core_vinculo where organizacao_id = $1 order by criado_em desc limit 500", [organizacaoId]);
      return rows.map(vinculoDaLinha);
    },
    /** Um desafio vigente por perfil: o anterior é SUBSTITUÍDO (marcado), na mesma transação do novo. */
    async guardarDesafio(d) {
      await emTransacao(pool, async (c) => {
        await c.query("update mova.core_desafio_vinculo set substituido_em = $3 where organizacao_id = $1 and perfil_id = $2 and consumido_em is null and substituido_em is null", [d.organizacaoId, d.perfilId, iso(d.criadoEm ?? Date.now())]);
        await c.query(`insert into mova.core_desafio_vinculo (id, organizacao_id, conta_id, perfil_id, codigo_hash, sal, criado_em, expira_em) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [d.id, d.organizacaoId, d.contaId ?? null, d.perfilId, d.codigoHash, d.sal, iso(d.criadoEm ?? Date.now()), iso(d.expiraEm)]);
      });
    },
    /** Uso ÚNICO entre processos: só quem consegue o UPDATE condicional recebe o desafio. */
    async consumirDesafio({ organizacaoId, id, agora = Date.now() }) {
      const { rows } = await pool.query(
        `update mova.core_desafio_vinculo set consumido_em = $3 where id = $1 and organizacao_id = $2 and consumido_em is null and substituido_em is null returning *`,
        [id, organizacaoId, iso(agora)]);
      return desafioDaLinha(rows[0]) ?? null;
    },
    async desafiosDaOrganizacao(organizacaoId) {
      const { rows } = await pool.query("select * from mova.core_desafio_vinculo where organizacao_id = $1 and consumido_em is null and substituido_em is null order by criado_em desc limit 200", [organizacaoId]);
      return rows.map(desafioDaLinha);
    },
    /** Registra e conta as tentativas da última hora sob TRAVA da chave (dois processos não passam juntos do limite). */
    async registrarTentativa(chave, agora = Date.now()) {
      return emTransacao(pool, async (c) => {
        await c.query("select pg_advisory_xact_lock(hashtextextended($1, 77))", [`mova-core-tentativa:${chave}`]);
        await c.query("insert into mova.core_tentativa_vinculo (chave_canonica, em) values ($1, $2)", [chave, iso(agora)]);
        const { rows } = await c.query("select count(*)::int as n from mova.core_tentativa_vinculo where chave_canonica = $1 and em > $2 and em <= $3", [chave, iso(agora - janelaTentativasMs), iso(agora)]);
        return rows[0].n;
      });
    },
  });
}

/** @param {import("pg").Pool} pool  pool do papel de operação do MOVA (mova_app) */
export function criarRepositorioDeMemoriaPostgres(pool, { relogio = () => Date.now() } = {}) {
  const partes = (chave) => { const [organizacaoId, conversaId, ...resto] = String(chave).split("|"); return { organizacaoId, conversaId, participanteId: resto.join("|") }; };
  return Object.freeze({
    persistente: true,
    /** null = nunca houve fio; {estado:null} = fio APAGADO (a pedido/retenção) ou vencido pela retenção. */
    async ler(chave) {
      const { rows } = await pool.query("select estado, versao, apagada_em, expira_em from mova.core_memoria_conversa where chave = $1", [chave]);
      const r = rows[0];
      if (!r) return null;
      const vencida = ms(r.expira_em) <= relogio();
      return { estado: r.apagada_em || vencida ? null : r.estado, versao: Number(r.versao) };
    },
    /** Compare-and-set pela versão: versaoEsperada null ⇒ a linha não pode existir ainda. */
    async gravar(chave, estado, { versaoEsperada = null, expiraEm } = {}) {
      const { organizacaoId, conversaId, participanteId } = partes(chave);
      const expira = iso(expiraEm ?? relogio() + 30 * 86_400_000);
      if (versaoEsperada == null) {
        const { rows } = await pool.query(
          `insert into mova.core_memoria_conversa (chave, organizacao_id, conversa_id, participante_id, estado, versao, atualizado_em, expira_em)
           values ($1, $2, $3, $4, $5, 1, $6, $7) on conflict (chave) do nothing returning versao`,
          [chave, organizacaoId, conversaId, participanteId, JSON.stringify(estado), iso(relogio()), expira]);
        return rows[0] ? { ok: true, versao: Number(rows[0].versao) } : { ok: false, versao: null };
      }
      const { rows } = await pool.query(
        `update mova.core_memoria_conversa set estado = $2, versao = versao + 1, atualizado_em = $4, expira_em = $5, apagada_em = null, motivo_apagamento = null
          where chave = $1 and versao = $3 returning versao`, [chave, JSON.stringify(estado), versaoEsperada, iso(relogio()), expira]);
      return rows[0] ? { ok: true, versao: Number(rows[0].versao) } : { ok: false, versao: null };
    },
    /** EXCLUSÃO: apaga o conteúdo (a linha fica sem dado, como prova). */
    async apagar(chave, motivo = "PEDIDO") {
      const { rowCount } = await pool.query(
        `update mova.core_memoria_conversa set estado = '{}'::jsonb, versao = versao + 1, apagada_em = $2, motivo_apagamento = $3 where chave = $1 and apagada_em is null`,
        [chave, iso(relogio()), motivo]);
      return rowCount > 0;
    },
    /** Apaga a memória de TODAS as conversas de um participante numa organização (ex.: pessoa saiu da lista). */
    async apagarDoParticipante({ organizacaoId, participanteId }, motivo = "REVOGACAO") {
      const { rowCount } = await pool.query(
        `update mova.core_memoria_conversa set estado = '{}'::jsonb, versao = versao + 1, apagada_em = $3, motivo_apagamento = $4
          where organizacao_id = $1 and participante_id = $2 and apagada_em is null`, [organizacaoId, participanteId, iso(relogio()), motivo]);
      return rowCount;
    },
    /** RETENÇÃO: apaga o conteúdo dos fios vencidos (expira_em ≤ agora). Idempotente. */
    async expurgarVencidas() {
      const { rowCount } = await pool.query(
        `update mova.core_memoria_conversa set estado = '{}'::jsonb, versao = versao + 1, apagada_em = $1, motivo_apagamento = 'RETENCAO'
          where expira_em <= $1 and apagada_em is null`, [iso(relogio())]);
      return rowCount;
    },
  });
}

export { ESTADO_VINCULO };
