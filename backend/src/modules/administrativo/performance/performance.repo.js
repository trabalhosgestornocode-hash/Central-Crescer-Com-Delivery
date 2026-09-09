import { supabase } from '../../../config/supabase.js';
import { ApiError } from '../../../shared/ApiError.js';
import { deslocarMes } from './performance.calc.js';
const T = 'performance_mensal_complemento';
function erro(error) {
  if (!error) return;
  if (['42P01','PGRST205'].includes(error.code)) throw new ApiError(503, 'Fechamento indisponível: a migration 078 ainda não foi aplicada neste ambiente.');
  if (error.code === '23505') throw new ApiError(409, 'A competência já foi criada. Recarregue antes de salvar.');
  throw ApiError.internal('Não foi possível consultar ou salvar a competência.');
}
export function criarRepositorio(deps = {}) {
  const db = deps.supabase ?? supabase;
  const escopo = (q, u) => q.eq('organizacao_id', u.organizacaoId).eq('unidade_id', u.unidadeId);
  async function paginar(factory) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await factory().range(offset, offset + 999); erro(r.error);
      rows.push(...(r.data ?? []));
      if ((r.data ?? []).length < 1000) return rows;
    }
  }
  return {
    async carregar(u, inicio, fim) {
      const [linhas, complementos, importacoes] = await Promise.all([
        paginar(() => escopo(db.from('lancamentos_financeiros_diarios').select('id,unidade_id,organizacao_id,data_lancamento,status,situacao,origem_lancamento,valor_vendas_ifood,taxas_comissoes,servicos_promocoes,taxas_entregadores,ajustes_contra_loja,qtd_vendas,valor_vendas_bruto,novos_clientes'),u)
          .gte('data_lancamento',`${inicio}-01`).lt('data_lancamento',`${deslocarMes(fim,1)}-01`).order('data_lancamento').order('id')),
        paginar(() => escopo(db.from(T).select('*'),u).gte('competencia',`${inicio}-01`).lte('competencia',`${fim}-01`).order('competencia').order('id')),
        u.usaParser ? paginar(() => escopo(db.from('parser_fd_importacoes').select('id,organizacao_id,unidade_id,periodo_inicio,periodo_fim,taxas_validas,status'),u)
          .eq('status','concluida').gte('periodo_fim',`${inicio}-01`).lt('periodo_inicio',`${deslocarMes(fim,1)}-01`).order('periodo_inicio').order('id')) : Promise.resolve([]),
      ]);
      return { linhas, complementos, importacoes };
    },
    async salvar(u, competencia, atual, patch, ator) {
      const base = { ...patch, atualizado_por: ator };
      const r = atual
        ? await escopo(db.from(T).update(base),u).eq('competencia',`${competencia}-01`).eq('versao',atual.versao).select('*').maybeSingle()
        : await db.from(T).insert({ ...base, organizacao_id:u.organizacaoId, unidade_id:u.unidadeId, competencia:`${competencia}-01`, criado_por:ator }).select('*').single();
      erro(r.error);
      if (!r.data) throw new ApiError(409,'A competência mudou durante a edição. Recarregue antes de salvar.');
      return r.data;
    },
  };
}
