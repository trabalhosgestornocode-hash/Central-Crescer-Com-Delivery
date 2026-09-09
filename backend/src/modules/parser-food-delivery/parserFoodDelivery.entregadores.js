// Cadastro MESTRE de entregadores do Parser Food Delivery — por unidade,
// isolado por tenant, com deduplicação por nome normalizado. Os lançamentos
// operacionais (parserFoodDelivery.lancamentos.js) referenciam o entregador
// por FK; os pedidos importados do iFood continuam guardando o nome-texto
// original e ganham `entregador_id` de forma PROGRESSIVA (reconhecimento),
// nunca destrutiva.
//
// Mesmo padrão de I/O de parserFoodDelivery.service.js: service_role,
// resolverUnidade() em toda função, auditoria que nunca derruba a operação.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { temEntregador } from "./parserFoodDelivery.calc.js";
import { registrarAuditoriaGenerica, resolverUnidade } from "./parserFoodDelivery.shared.js";
import { normalizarNomeEntregador } from "./parserFoodDelivery.lancamentos.calc.js";

const TABELA = "parser_fd_entregadores";

function paraApi(row) {
  return {
    id: row.id,
    organizacaoId: row.organizacao_id,
    unidadeId: row.unidade_id,
    nome: row.nome,
    nomeChave: row.nome_chave,
    nomeOriginal: row.nome_original,
    ativo: row.ativo,
    origemCadastro: row.origem_cadastro,
    criadoPorNome: row.criado_por_nome,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

export { normalizarNomeEntregador };

// ---------------------------------------------------------------------------
// LEITURA
// ---------------------------------------------------------------------------
export async function listarEntregadores({ organizacaoId, unidadeId, incluirInativos = false }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  let q = supabase.from(TABELA).select("*").eq("unidade_id", unidadeId);
  if (!incluirInativos) q = q.eq("ativo", true);
  const { data, error } = await q.order("nome", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return (data || []).map(paraApi);
}

/**
 * Resolve um entregador da unidade para uso num lançamento. Aceita
 * `entregadorId` (caminho normal) ou `nome` (cadastro inline — REUSA este
 * mesmo service, mesma normalização/dedup). Entregador INATIVO nunca pode
 * ser usado em lançamento novo sem reativação.
 * @returns {Promise<object>} linha da API do entregador
 */
export async function resolverEntregadorParaLancamento({ organizacaoId, unidadeId, entregadorId, nome, usuario, criarSeNaoExistir = false }) {
  await resolverUnidade({ organizacaoId, unidadeId });

  if (entregadorId) {
    const { data, error } = await supabase.from(TABELA).select("*")
      .eq("id", entregadorId).eq("unidade_id", unidadeId).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    if (!data) throw ApiError.badRequest("Entregador não encontrado nesta unidade.");
    if (!data.ativo) throw ApiError.badRequest(`O entregador "${data.nome}" está inativo. Reative-o antes de usá-lo em um novo lançamento.`);
    return paraApi(data);
  }

  const { nome: nomeLimpo, chave } = normalizarNomeEntregador(nome);
  if (!temEntregador(nomeLimpo)) throw ApiError.badRequest("Informe o entregador do lançamento.");

  const { data: existente, error: eBusca } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidadeId).eq("nome_chave", chave).maybeSingle();
  if (eBusca) throw ApiError.internal(eBusca.message);
  if (existente) {
    if (!existente.ativo) throw ApiError.badRequest(`O entregador "${existente.nome}" está inativo. Reative-o antes de usá-lo em um novo lançamento.`);
    return paraApi(existente);
  }
  if (!criarSeNaoExistir) {
    throw ApiError.badRequest(`Nenhum entregador cadastrado como "${nomeLimpo}" nesta unidade. Cadastre-o antes de lançar.`);
  }
  return criarEntregador({ organizacaoId, unidadeId, nome: nomeLimpo, usuario });
}

// ---------------------------------------------------------------------------
// ESCRITA
// ---------------------------------------------------------------------------
export async function criarEntregador({ organizacaoId, unidadeId, nome, nomeOriginal = null, origemCadastro = "manual", usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { nome: nomeLimpo, chave } = normalizarNomeEntregador(nome);
  if (nomeLimpo.length < 2) throw ApiError.badRequest("O nome do entregador precisa ter ao menos 2 caracteres.");

  const { data: existente } = await supabase.from(TABELA).select("id, nome, ativo")
    .eq("unidade_id", unidadeId).eq("nome_chave", chave).maybeSingle();
  if (existente) {
    throw ApiError.badRequest(`Já existe um entregador equivalente a "${nomeLimpo}" nesta unidade ("${existente.nome}"${existente.ativo ? "" : ", inativo"}).`);
  }

  const { data, error } = await supabase.from(TABELA).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    nome: nomeLimpo, nome_chave: chave, nome_original: nomeOriginal,
    origem_cadastro: origemCadastro === "reconhecido_ifood" ? "reconhecido_ifood" : "manual",
    criado_por: usuario?.id || null, criado_por_nome: usuario?.nome || null,
  }).select("*").single();
  if (error) {
    if (String(error.message).toLowerCase().includes("uq_pfdentr_unidade_chave")) {
      throw ApiError.badRequest(`Já existe um entregador equivalente a "${nomeLimpo}" nesta unidade.`);
    }
    throw ApiError.badRequest(error.message);
  }

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao: "entregador_criado",
    entregadorId: data.id, dadosDepois: paraApi(data), usuario,
  });
  return paraApi(data);
}

export async function editarEntregador({ organizacaoId, unidadeId, entregadorId, nome, ativo, usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: atual, error: eAtual } = await supabase.from(TABELA).select("*")
    .eq("id", entregadorId).eq("unidade_id", unidadeId).maybeSingle();
  if (eAtual) throw ApiError.internal(eAtual.message);
  if (!atual) throw ApiError.notFound("Entregador não encontrado nesta unidade.");

  const patch = {};
  let acao = "entregador_editado";

  if (nome != null) {
    const { nome: nomeLimpo, chave } = normalizarNomeEntregador(nome);
    if (nomeLimpo.length < 2) throw ApiError.badRequest("O nome do entregador precisa ter ao menos 2 caracteres.");
    if (chave !== atual.nome_chave) {
      const { data: colide } = await supabase.from(TABELA).select("id, nome")
        .eq("unidade_id", unidadeId).eq("nome_chave", chave).neq("id", entregadorId).maybeSingle();
      if (colide) throw ApiError.badRequest(`Já existe um entregador equivalente a "${nomeLimpo}" nesta unidade ("${colide.nome}").`);
    }
    patch.nome = nomeLimpo;
    patch.nome_chave = chave;
  }
  if (typeof ativo === "boolean" && ativo !== atual.ativo) {
    patch.ativo = ativo;
    acao = "entregador_status_alterado";
  }
  if (!Object.keys(patch).length) return paraApi(atual);

  const { data, error } = await supabase.from(TABELA).update(patch)
    .eq("id", entregadorId).eq("unidade_id", unidadeId).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  await registrarAuditoriaGenerica({
    organizacaoId, unidadeId, acao, entregadorId,
    dadosAntes: paraApi(atual), dadosDepois: paraApi(data), usuario,
  });
  return paraApi(data);
}

// ---------------------------------------------------------------------------
// RECONHECIMENTO PROGRESSIVO — nunca cria em massa automaticamente.
// ---------------------------------------------------------------------------
/**
 * Nomes que aparecem em parser_fd_pedidos (iFood) desta unidade e ainda NÃO
 * têm correspondência no cadastro mestre (por nome_chave). Cada sugestão
 * traz a contagem de pedidos e a 1ª/última data — o admin escolhe quais
 * cadastrar em `reconhecerEntregadores`.
 */
export async function sugestoesReconhecimento({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });

  const nomes = new Map(); // chave -> { nomeExibicao, pedidos, entregadorIdVinculado }
  const PAGINA = 1000;
  for (let offset = 0; ; offset += PAGINA) {
    const { data, error } = await supabase.from("parser_fd_pedidos")
      .select("entregador, entregador_id")
      .eq("unidade_id", unidadeId)
      .not("entregador", "is", null)
      .range(offset, offset + PAGINA - 1);
    if (error) throw ApiError.internal(error.message);
    for (const row of data || []) {
      const { nome, chave } = normalizarNomeEntregador(row.entregador);
      if (!temEntregador(nome)) continue;
      const item = nomes.get(chave) || { nomeExibicao: nome, chave, pedidos: 0, jaVinculado: false };
      item.pedidos += 1;
      if (row.entregador_id) item.jaVinculado = true;
      nomes.set(chave, item);
    }
    if (!data || data.length < PAGINA) break;
  }

  const { data: mestre, error: eM } = await supabase.from(TABELA).select("nome_chave").eq("unidade_id", unidadeId);
  if (eM) throw ApiError.internal(eM.message);
  const jaCadastrados = new Set((mestre || []).map((m) => m.nome_chave));

  return [...nomes.values()]
    .filter((n) => !jaCadastrados.has(n.chave))
    .sort((a, b) => b.pedidos - a.pedidos)
    .map((n) => ({ nome: n.nomeExibicao, chave: n.chave, pedidos: n.pedidos }));
}

/**
 * Cadastra os nomes escolhidos (origem_cadastro='reconhecido_ifood') e
 * vincula `parser_fd_pedidos.entregador_id` de todas as linhas cujo nome
 * casa (por nome_chave). Não apaga nem altera o texto original do pedido.
 * @param {{ nomes: string[] }} p
 */
export async function reconhecerEntregadores({ organizacaoId, unidadeId, nomes, usuario }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const lista = [...new Set((nomes || []).map((n) => normalizarNomeEntregador(n).chave).filter(Boolean))];
  if (!lista.length) throw ApiError.badRequest("Selecione ao menos um nome para reconhecer.");

  const criados = [];
  for (const nomeBruto of nomes || []) {
    const { nome, chave } = normalizarNomeEntregador(nomeBruto);
    if (!temEntregador(nome)) continue;

    let { data: entregador } = await supabase.from(TABELA).select("*")
      .eq("unidade_id", unidadeId).eq("nome_chave", chave).maybeSingle();
    if (!entregador) {
      const { data, error } = await supabase.from(TABELA).insert({
        organizacao_id: organizacaoId, unidade_id: unidadeId,
        nome, nome_chave: chave, nome_original: nome, origem_cadastro: "reconhecido_ifood",
        criado_por: usuario?.id || null, criado_por_nome: usuario?.nome || null,
      }).select("*").maybeSingle();
      if (error && !String(error.message).toLowerCase().includes("uq_pfdentr_unidade_chave")) throw ApiError.badRequest(error.message);
      entregador = data || (await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("nome_chave", chave).single()).data;
      if (data) criados.push(paraApi(data));
    }

    // Vincula os pedidos que casam (nome bruto == este nome, comparando
    // normalizado no cliente — Supabase não expõe a função de normalização).
    const { data: pedidos } = await supabase.from("parser_fd_pedidos")
      .select("id, entregador").eq("unidade_id", unidadeId).is("entregador_id", null).not("entregador", "is", null);
    const idsParaVincular = (pedidos || [])
      .filter((p) => normalizarNomeEntregador(p.entregador).chave === chave)
      .map((p) => p.id);
    for (let i = 0; i < idsParaVincular.length; i += 200) {
      const lote = idsParaVincular.slice(i, i + 200);
      const { error } = await supabase.from("parser_fd_pedidos").update({ entregador_id: entregador.id }).in("id", lote);
      if (error) throw ApiError.internal(`Falha ao vincular pedidos ao entregador ${nome}: ${error.message}`);
    }

    await registrarAuditoriaGenerica({
      organizacaoId, unidadeId, acao: "entregador_criado",
      entregadorId: entregador.id, dadosDepois: { ...paraApi(entregador), pedidosVinculados: idsParaVincular.length }, usuario,
    });
  }

  return { criados, total: criados.length };
}
