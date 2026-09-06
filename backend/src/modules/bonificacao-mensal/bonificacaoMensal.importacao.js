// Proteções exclusivas da importação DIÁRIA. Não participa do fechamento mensal.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { ApiError } from '../../shared/ApiError.js';

const falha = (msg) => ApiError.badRequest(msg);
function dataIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) throw falha('Informe uma data válida para o período do relatório.');
  const d = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw falha('Data inválida no período do relatório.');
  return s;
}

// Somente rótulo explícito de período. Datas de geração e eixos de gráficos NÃO são período.
export function extrairPeriodoDiario(texto) {
  const normal = String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const encontrados = [...normal.matchAll(/(?:periodo(?:\s+de\s+vendas)?|data\s+de\s+venda)\s*:\s*(\d{2}\/\d{2}\/\d{4})(?:\s*(?:a|ate|[-–])\s*(\d{2}\/\d{2}\/\d{4}))?/gi)]
    .map(m => ({ inicio: dataIso(m[1].split('/').reverse().join('-')), fim: dataIso((m[2] || m[1]).split('/').reverse().join('-')) }));
  if (new Set(encontrados.map(p => `${p.inicio}/${p.fim}`)).size > 1) throw falha('O documento contém períodos conflitantes. Confira o relatório diário.');
  return encontrados[0] || null;
}

export function resolverPeriodoDiario({ data, persistido, extraido, declarado, nomeArquivo = '' }) {
  dataIso(data);
  const anterior = persistido && { inicio: persistido.periodo_inicio || persistido.data_lancamento, fim: persistido.periodo_fim || persistido.data_lancamento };
  const confirmarIgual = p => {
    if (dataIso(p.inicio) !== data || dataIso(p.fim) !== data) {
      throw falha(`O relatório pertence ao período ${p.inicio} a ${p.fim} e não pode alimentar o lançamento de ${data}. Envie o documento desse dia.`);
    }
  };
  if (anterior) confirmarIgual(anterior);
  if (extraido) confirmarIgual(extraido);
  if (declarado) confirmarIgual(declarado);
  const fonte = anterior ? (persistido.periodo_fonte || 'legado_data_lancamento') : extraido ? 'conteudo' : 'confirmacao_usuario';
  if (!anterior && !extraido && declarado?.confirmado !== true) {
    throw falha('O PDF não informa um período de venda inequívoco. Informe e confirme a data de venda deste relatório antes de importar.');
  }
  // Sinal auxiliar, nunca autoriza nem fornece sozinho o período. Conteúdo explícito prevalece.
  if (!extraido) {
    const nomeData = nomeArquivo.match(/(?:^|[\s_-])(\d{2})(\d{2})(?:\s+geral)?\.pdf$/i);
    if (nomeData && `${nomeData[2]}-${nomeData[1]}` !== data.slice(5)) {
      throw falha(`O nome do arquivo indica ${nomeData[1]}/${nomeData[2]}, diferente de ${data}. Confira o documento e seu período antes de continuar.`);
    }
  }
  return { inicio: data, fim: data, fonte };
}

export function validarVinculoImportacao(imp, alvo, vinculos = []) {
  if (!imp || imp.status !== 'concluida') throw falha('Importação inexistente ou não concluída.');
  if (imp.organizacao_id !== alvo.organizacaoId || imp.unidade_id !== alvo.unidadeId || imp.tipo_relatorio !== alvo.tipo) {
    throw falha('A importação pertence a outra organização, unidade ou tipo de relatório.');
  }
  if (imp.data_lancamento !== alvo.data || imp.data_lancamento?.slice(0, 7) !== alvo.data.slice(0, 7)) {
    throw falha(`A importação já pertence a ${imp.data_lancamento || 'um período não identificado'} e não pode ser reutilizada em ${alvo.data}, mesmo com substituir.`);
  }
  resolverPeriodoDiario({ data: alvo.data, persistido: imp });
  const coluna = alvo.tipo === 'loja' ? 'importacao_loja_id' : 'importacao_geral_id';
  for (const l of vinculos) {
    if (l.organizacao_id !== alvo.organizacaoId || l.unidade_id !== alvo.unidadeId || l.data !== alvo.data || l[coluna] !== imp.id) {
      throw falha('Este documento já está vinculado a outro dia ou contexto. O mesmo relatório não pode ser contabilizado duas vezes.');
    }
  }
}

export async function conferirImportacao(db, imp, alvo) {
  const { data: vinculos, error } = await db.from('bonificacao_lancamentos_diarios')
    .select('id,organizacao_id,unidade_id,data,importacao_loja_id,importacao_geral_id')
    .or(`importacao_loja_id.eq.${imp.id},importacao_geral_id.eq.${imp.id}`);
  if (error) throw ApiError.internal('Não foi possível verificar os vínculos da importação. Nenhum lançamento foi alterado.');
  validarVinculoImportacao(imp, alvo, vinculos || []);
}

export async function localizarImportacao(db, alvo, hash) {
  const { data: imps, error } = await db.from('bonificacao_importacoes').select('*')
    .eq('unidade_id', alvo.unidadeId).eq('hash_arquivo', hash).eq('status', 'concluida');
  if (error) throw ApiError.internal('Não foi possível verificar o histórico deste documento.');
  if ((imps || []).length > 1) throw falha('Há mais de uma importação para este documento. Revise os vínculos antes de continuar.');
  const imp = imps?.[0] || null;
  if (imp) await conferirImportacao(db, imp, alvo);
  return imp;
}

export async function prepararImportacaoDiaria(db, { alvo, parsed, buf, arquivo }) {
  const existente = await localizarImportacao(db, alvo, parsed.hash);
  const { text } = await pdfParse(buf);
  const periodo = resolverPeriodoDiario({ data: alvo.data, persistido: existente,
    extraido: extrairPeriodoDiario(text), declarado: arquivo.periodo, nomeArquivo: arquivo.nomeArquivo });
  return { existente, periodo };
}

export async function registrarImportacaoDiaria(db, { alvo, parsed, storage, nomeArquivo, usuario, periodo, anteriorId }) {
  // Repete a leitura antes do registro e depois de colisão UNIQUE (concorrência).
  const existente = await localizarImportacao(db, alvo, parsed.hash);
  if (existente) return existente.id;
  const { data: row, error } = await db.from('bonificacao_importacoes').insert({
    organizacao_id: alvo.organizacaoId, unidade_id: alvo.unidadeId, tipo_relatorio: alvo.tipo,
    data_lancamento: alvo.data, periodo_inicio: periodo.inicio, periodo_fim: periodo.fim, periodo_fonte: periodo.fonte,
    hash_arquivo: parsed.hash, nome_arquivo: nomeArquivo || null, arquivo_storage: storage,
    estabelecimento_detectado: parsed.estabelecimento, status: 'concluida',
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null,
    substituiu_importacao_id: anteriorId || null,
  }).select('id').single();
  if (!error) return row.id;
  if (error.code === '23505') {
    const concorrente = await localizarImportacao(db, alvo, parsed.hash);
    if (concorrente) return concorrente.id;
  }
  throw falha(error.message);
}
