// MOVA CORE — F4: repositório POSTGRES das propostas (migração 0020). Mesmo contrato do repositório em memória de operacoes.js:
//   salvar(p, {versaoEsperada}) — compare-and-set pela `revisao` (duas instâncias confirmando: só uma passa);
//   obter(id), daConversa(chave), acumuladoDoFavorecido({...}).
// O comprovante (bytes) fica na coluna `anexo` só enquanto a proposta ainda pode ser executada; em estado final é apagado.
const FINAIS = new Set(["EXECUTADA", "EXECUTADA_PARCIAL", "FALHOU", "CANCELADA", "SUBSTITUIDA", "EXPIRADA", "RECUSADA", "DESATUALIZADA"]);

function separar(p) {
  const conteudo = p.anexo?.arquivo?.conteudo ?? null;
  const semBytes = p.anexo?.arquivo ? { ...p, anexo: { ...p.anexo, arquivo: { ...p.anexo.arquivo, conteudo: null } } } : p;
  return { json: semBytes, bytes: conteudo && !FINAIS.has(p.estado) ? Buffer.from(conteudo) : null };
}
function juntar(linha) {
  if (!linha) return null;
  const p = { ...linha.proposta, revisao: Number(linha.revisao) };
  if (p.anexo?.arquivo) p.anexo = { ...p.anexo, arquivo: { ...p.anexo.arquivo, conteudo: linha.anexo ? new Uint8Array(linha.anexo) : null } };
  return p;
}

export function criarRepositorioDePropostasPostgres(pool) {
  return {
    async salvar(p, { versaoEsperada = null } = {}) {
      const { json, bytes } = separar(p);
      const valores = [p.id, p.raiz, p.versao, p.conversaChave, p.organizacaoId, p.unidadeId, p.autor, p.tipo, p.estado, p.favorecidoChave ?? null,
        p.valorCentavos ?? null, p.executadaEm ?? null, p.criadaEm, p.expiraEm, JSON.stringify(json), bytes, versaoEsperada];
      const { rows } = await pool.query(
        `insert into mova.core_proposta as c (id, raiz, versao, conversa_chave, organizacao_id, unidade_id, autor, tipo, estado, favorecido_chave,
           valor_centavos, executada_em, criada_em, expira_em, proposta, anexo)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16 where $17::bigint is null
         on conflict (id) do update set estado = excluded.estado, favorecido_chave = excluded.favorecido_chave, valor_centavos = excluded.valor_centavos,
           executada_em = excluded.executada_em, proposta = excluded.proposta, anexo = excluded.anexo, revisao = c.revisao + 1, atualizada_em = now()
         returning *`, valores);
      if (rows[0]) return { ok: true, proposta: juntar(rows[0]) };
      if (versaoEsperada === null) return { ok: false, motivo: "CONCORRENCIA" };
      // compare-and-set: só atualiza se ninguém gravou desde a leitura (outra instância, outra confirmação)
      const r = await pool.query(
        `update mova.core_proposta set estado = $2, favorecido_chave = $3, valor_centavos = $4, executada_em = $5, proposta = $6::jsonb, anexo = $7,
           revisao = revisao + 1, atualizada_em = now() where id = $1 and revisao = $8 returning *`,
        [p.id, p.estado, p.favorecidoChave ?? null, p.valorCentavos ?? null, p.executadaEm ?? null, JSON.stringify(json), bytes, versaoEsperada]);
      return r.rows[0] ? { ok: true, proposta: juntar(r.rows[0]) } : { ok: false, motivo: "CONCORRENCIA" };
    },
    async obter(id) {
      const { rows } = await pool.query("select * from mova.core_proposta where id = $1", [id]);
      return juntar(rows[0]);
    },
    async daConversa(conversaChave, { limite = 20 } = {}) {
      const { rows } = await pool.query("select * from mova.core_proposta where conversa_chave = $1 order by criada_em desc, versao desc limit $2", [conversaChave, limite]);
      return rows.map(juntar);
    },
    async acumuladoDoFavorecido({ organizacaoId, unidadeId, favorecido, desde }) {
      const { rows } = await pool.query(
        `select coalesce(sum(valor_centavos), 0)::bigint as total from mova.core_proposta
          where organizacao_id = $1 and unidade_id = $2 and favorecido_chave = $3 and executada_em >= $4 and estado in ('EXECUTADA', 'EXECUTADA_PARCIAL')`,
        [organizacaoId, unidadeId, favorecido, desde]);
      return Number(rows[0].total);
    },
  };
}
