// Leituras da simulação: mesmas dimensões e carimbos de comunicacao_reservar_envio.
// Cotas de contatos retornam apenas contagens globais; nenhum histórico de outra empresa sai daqui.
import { supabase } from '../../config/supabase.js';
import { ApiError } from '../../shared/ApiError.js';

const STATUS = ['SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN'];
const dbDe = (deps) => deps.supabase ?? supabase;
const periodo = (inicio) => {
  const iso = inicio.toISOString();
  return `enviado_em.gte.${iso},entrega_incerta_em.gte.${iso},and(status.eq.SENDING,claimed_at.gte.${iso})`;
};
async function contar(q) {
  const { count, error } = await q;
  if (error) throw ApiError.internal(error.message);
  if (!Number.isInteger(count) || count < 0) throw ApiError.internal('Não foi possível obter a contagem para simular os limites.');
  return count;
}
const saidas = (deps) => dbDe(deps).from('comunicacao_mensagens')
  .select('id', { count: 'exact', head: true }).eq('direcao', 'saida').in('status', STATUS);

export function contarConsumoContato({ contatoId, inicioDia }, deps = {}) {
  return contar(saidas(deps).eq('contato_id', contatoId).or(periodo(inicioDia)));
}

export function contarConsumoEmpresa({ organizacaoId, inicioDia }, deps = {}) {
  return contar(saidas(deps).eq('organizacao_id', organizacaoId).not('alerta_id', 'is', null).or(periodo(inicioDia)));
}

export async function contatoEmCooldown({ organizacaoId, unidadeId, tipoAlerta, contatoId, desde }, deps = {}) {
  const q = saidas(deps).eq('organizacao_id', organizacaoId).eq('unidade_id', unidadeId)
    .eq('tipo', tipoAlerta).eq('contato_id', contatoId)
    .or(`status.in.(SENDING,DELIVERY_UNKNOWN),and(status.in.(SENT,DELIVERED,READ),enviado_em.gte.${desde.toISOString()})`);
  return (await contar(q)) > 0;
}

// Idempotência não expira: uma saída antiga do alerta ainda impede outra inicial.
// Paginação explícita evita perder identidades por causa do limite de linhas do PostgREST.
export async function listarIdentidadesDoAlerta({ organizacaoId, alertaId }, deps = {}) {
  const itens = [];
  const tamanho = 500;
  for (let inicio = 0; ; inicio += tamanho) {
    const { data, error } = await dbDe(deps).from('comunicacao_mensagens')
      .select('id, alerta_id, contato_id, contato_empresa_id, metadados')
      .eq('organizacao_id', organizacaoId).eq('alerta_id', alertaId).eq('direcao', 'saida')
      .order('id', { ascending: true }).range(inicio, inicio + tamanho - 1);
    if (error) throw ApiError.internal(error.message);
    if (!Array.isArray(data)) throw ApiError.internal('Não foi possível consultar mensagens anteriores do alerta.');
    itens.push(...data);
    if (data.length < tamanho) return itens;
  }
}
