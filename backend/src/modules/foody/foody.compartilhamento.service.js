// Vínculo da CONEXÃO COMPARTILHADA (145) e decisões de TRIAGEM — regras de aplicação. O banco confere tudo de novo (triggers
// foody_destino_validar / foody_triagem_decisao_validar, com o papel lido de usuarios_organizacoes no momento da escrita).
//
//   1. PROPOR: organization_admin da organização TITULAR propõe o destino (organização + unidade + operação). A proposta já leva
//      a aprovação da titular; o destino nasce PENDENTE.
//   2. APROVAR: organization_admin da organização de DESTINO aprova → ATIVO. Só então a distribuição começa (e só com a flag).
//   3. REVOGAR: admin de qualquer uma das duas, com motivo. Definitivo (novo vínculo = nova proposta e novas aprovações).
//   4. TRIAGEM: admin de uma organização do vínculo decide a operação de um pedido em triagem (somente inclusão; a última vale
//      na próxima sincronização). Pedido FORA da triagem só pode ser reclassificado pelo admin da organização que hoje o detém
//      (ninguém puxa para si um pedido já atribuído à outra empresa).
// Superadmin em IMPERSONAÇÃO não aprova, não revoga e não decide: a decisão é da própria empresa.
// Exposto por rota autenticada em modules/foody-admin (146); tudo exige a flag de ADMINISTRAÇÃO, exceto revogar.
import { administracaoPermitida } from "./foody.flags.js";
import { OPERACAO_COMPARTILHADA, RESULTADO_TRIAGEM, CATALOGO_VERSAO } from "./foody.classificacao.js";
import { chaveTenant } from "./foody.roteamento.js";

export class FoodyCompartilhamentoErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyCompartilhamentoErro"; this.codigo = codigo; }
}
const erro = (c, m) => new FoodyCompartilhamentoErro(c, m);

/** Operações que podem ter destino (a da titular, subway, nunca tem). */
export const OPERACOES_DESTINO = Object.freeze([OPERACAO_COMPARTILHADA.ACAI_NO_GRAU]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ator a partir do contexto de acesso autenticado (req.acesso). */
export function atorDeAcesso(acesso) {
  return {
    perfilId: acesso?.perfilId ?? null,
    papel: acesso?.papel ?? null,
    impersonando: acesso?.impersonando === true || Boolean(acesso?.impersonando),
    organizacaoId: acesso?.empresa?.id ?? null,
  };
}

/** organization_admin da organização, SEM impersonação. */
export function ehAdminDaOrganizacao(ator, organizacaoId) {
  return Boolean(ator && UUID.test(String(ator.perfilId ?? "")) && ator.papel === "organization_admin" && !ator.impersonando
    && organizacaoId && ator.organizacaoId === organizacaoId);
}

// Administrar o vínculo e a triagem depende só da flag de ADMINISTRAÇÃO (146) — nunca da de sincronização: aprovar um destino
// não coleta pedido nenhum; a distribuição só acontece quando a sync (outra flag) rodar.
function exigirFlag(env) {
  if (!administracaoPermitida(env)) throw erro("DESLIGADO", "administração da integração Foody desligada.");
}
function motivoValido(m) {
  const s = String(m ?? "").trim();
  if (s.length < 3 || s.length > 300) throw erro("MOTIVO_INVALIDO", "motivo obrigatório (3 a 300 caracteres).");
  return s;
}

/** 1. Proposta (com a aprovação da titular). */
export async function proporDestino({ ator, conexaoId, destino }, { env = process.env, repo, agora = () => new Date() }) {
  exigirFlag(env);
  const conexao = await repo.obterConexaoPorId(conexaoId);
  if (!conexao) throw erro("SEM_CONEXAO", "conexão não encontrada.");
  if (!ehAdminDaOrganizacao(ator, conexao.organizacao_id)) throw erro("SEM_PERMISSAO", "só o organization_admin da organização titular propõe.");
  if (!OPERACOES_DESTINO.includes(destino?.operacao)) throw erro("OPERACAO_INVALIDA", "operação sem destino possível.");
  if (!UUID.test(String(destino?.organizacaoId ?? "")) || !UUID.test(String(destino?.unidadeId ?? ""))) throw erro("DESTINO_INVALIDO", "destino inválido.");
  if (destino.unidadeId === conexao.unidade_id) throw erro("DESTINO_INVALIDO", "a unidade titular não é destino da própria conexão.");
  const quando = agora().toISOString();
  return repo.inserirDestino({
    conexao_id: conexao.id, organizacao_id: destino.organizacaoId, unidade_id: destino.unidadeId, operacao: destino.operacao,
    estado: "PENDENTE", organizacao_titular_id: conexao.organizacao_id, aprovado_titular_por: ator.perfilId, aprovado_titular_em: quando,
  });
}

/** 2. Aprovação da organização de destino → ATIVO. */
export async function aprovarDestino({ ator, destinoId }, { env = process.env, repo, agora = () => new Date() }) {
  exigirFlag(env);
  const d = await repo.obterDestino(destinoId);
  if (!d) throw erro("SEM_DESTINO", "destino não encontrado.");
  if (!ehAdminDaOrganizacao(ator, d.organizacao_id)) throw erro("SEM_PERMISSAO", "só o organization_admin da organização de destino aprova.");
  if (d.estado !== "PENDENTE") throw erro("ESTADO_INVALIDO", `destino ${d.estado}.`);
  if (!d.aprovado_titular_por) throw erro("ESTADO_INVALIDO", "falta a aprovação da titular.");
  const conexao = await repo.obterConexaoPorId(d.conexao_id);
  if (!conexao || conexao.status !== "ATIVA") throw erro("CONEXAO_INATIVA", "a conexão precisa estar ATIVA.");
  const quando = agora().toISOString();
  const r = await repo.atualizarDestino(d, "PENDENTE", { estado: "ATIVO", aprovado_destino_por: ator.perfilId, aprovado_destino_em: quando });
  if (!r) throw erro("CONCORRENCIA", "o destino mudou durante a aprovação; recarregue.");
  return r;
}

/** 3. Revogação (qualquer uma das duas organizações, com motivo). */
export async function revogarDestino({ ator, destinoId, motivo }, { env = process.env, repo, agora = () => new Date() }) {
  // Revogar é sempre permitido mesmo com a flag desligada: desligar o vínculo nunca pode depender de ligar algo.
  void env;
  const d = await repo.obterDestino(destinoId);
  if (!d) throw erro("SEM_DESTINO", "destino não encontrado.");
  if (!ehAdminDaOrganizacao(ator, d.organizacao_id) && !ehAdminDaOrganizacao(ator, d.organizacao_titular_id)) {
    throw erro("SEM_PERMISSAO", "só o organization_admin de uma das organizações revoga.");
  }
  if (d.estado === "REVOGADO") throw erro("ESTADO_INVALIDO", "destino já revogado.");
  const r = await repo.atualizarDestino(d, d.estado, {
    estado: "REVOGADO", revogado_por: ator.perfilId, revogado_em: agora().toISOString(), revogado_motivo: motivoValido(motivo),
  });
  if (!r) throw erro("CONCORRENCIA", "o destino mudou durante a revogação; recarregue.");
  return r;
}

async function contextoDaConexao(conexaoId, repo) {
  const conexao = await repo.obterConexaoPorId(conexaoId);
  if (!conexao) throw erro("SEM_CONEXAO", "conexão não encontrada.");
  const titular = { organizacaoId: conexao.organizacao_id, unidadeId: conexao.unidade_id };
  const destinos = await repo.listarDestinosDaConexao(titular, conexao.id);
  const permitidos = new Set([chaveTenant(titular), ...destinos.map((d) => chaveTenant({ organizacaoId: d.organizacao_id, unidadeId: d.unidade_id }))]);
  return { conexao, titular, destinos, ativos: destinos.filter((d) => d.estado === "ATIVO"), permitidos };
}

/** Organizações do vínculo cujo admin o ator é (titular e/ou destinos ATIVOS). */
function organizacoesDoAtor(ator, ctx) {
  const orgs = [ctx.titular.organizacaoId, ...ctx.ativos.map((d) => d.organizacao_id)];
  return new Set(orgs.filter((o) => ehAdminDaOrganizacao(ator, o)));
}

/**
 * Lista a triagem de uma competência (admin de uma organização do vínculo). Sem dado comercial: a linha de triagem não tem
 * valor, pagamento nem cancelamento, e dos itens só guarda as linhas SEM atribuição segura — os itens já reconhecidos aparecem
 * apenas como contagem (no resumo), para nenhuma empresa ver o pedido da outra.
 */
export async function listarTriagem({ ator, conexaoId, competencia }, { env = process.env, repo }) {
  exigirFlag(env);
  const ctx = await contextoDaConexao(conexaoId, repo);
  if (organizacoesDoAtor(ator, ctx).size === 0) throw erro("SEM_PERMISSAO", "só organization_admin de uma organização do vínculo vê a triagem.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(competencia ?? ""))) throw erro("COMPETENCIA_INVALIDA", "competência inválida.");
  const linhas = await repo.listarTriagem(ctx.titular, ctx.conexao.id, competencia);
  // Decisão já registrada e ainda não aplicada (vale na próxima sincronização): a tela mostra, sem esconder o pedido.
  const decisoes = linhas.length && repo.listarDecisoesTriagem
    ? await repo.listarDecisoesTriagem(ctx.titular, ctx.conexao.id, linhas.map((r) => r.foody_uid)) : new Map();
  return linhas.map((r) => {
    const d = decisoes.get(r.foody_uid);
    return {
      foodyUid: r.foody_uid, numeroPedido: r.numero_pedido, competencia: r.competencia, dataHora: r.data_hora, situacao: r.situacao,
      motivo: r.triagem_motivo, resumo: r.operacao_motivo, catalogoVersao: r.catalogo_versao,
      linhasSemEvidencia: String(r.detalhes_pedido ?? "").split(/\n/).filter(Boolean),
      decisaoPendente: d ? { operacao: d.operacao_decidida, decididoEm: d.decidido_em, porVoce: d.decidido_por === ator.perfilId } : null,
    };
  });
}

/** Dias com pedido em triagem nos últimos `dias` (só contagem por dia). Admin de uma organização do vínculo. */
export async function listarDiasDeTriagem({ ator, conexaoId, dias = 35 }, { env = process.env, repo, agora = () => new Date() }) {
  exigirFlag(env);
  const ctx = await contextoDaConexao(conexaoId, repo);
  if (organizacoesDoAtor(ator, ctx).size === 0) throw erro("SEM_PERMISSAO", "só organization_admin de uma organização do vínculo vê a triagem.");
  const desde = new Date(agora().getTime() - Math.min(Math.max(1, dias), 90) * 86_400_000).toISOString().slice(0, 10);
  return repo.listarDiasComTriagem(ctx.titular, ctx.conexao.id, desde);
}

/** Histórico das decisões de triagem (somente inclusão). Quem decidiu aparece só como "você" ou "outro administrador". */
export async function historicoDeDecisoes({ ator, conexaoId }, { env = process.env, repo }) {
  exigirFlag(env);
  const ctx = await contextoDaConexao(conexaoId, repo);
  if (organizacoesDoAtor(ator, ctx).size === 0) throw erro("SEM_PERMISSAO", "só organization_admin de uma organização do vínculo vê o histórico.");
  return (await repo.listarHistoricoDecisoes(ctx.titular, ctx.conexao.id)).map((d) => ({
    id: d.id, foodyUid: d.foody_uid, operacao: d.operacao_decidida, motivo: d.motivo, decididoEm: d.decidido_em,
    catalogoVersao: d.catalogo_versao, porVoce: d.decidido_por === ator.perfilId,
  }));
}

/** 4. Decisão de triagem (somente inclusão). */
export async function decidirTriagem({ ator, conexaoId, foodyUid, operacao, motivo }, { env = process.env, repo }) {
  exigirFlag(env);
  const ctx = await contextoDaConexao(conexaoId, repo);
  if (ctx.ativos.length === 0) throw erro("SEM_DESTINO_ATIVO", "a conexão não tem destino ativo.");
  const minhas = organizacoesDoAtor(ator, ctx);
  if (minhas.size === 0) throw erro("SEM_PERMISSAO", "só organization_admin de uma organização do vínculo decide.");
  if (!Object.values(OPERACAO_COMPARTILHADA).includes(operacao)) throw erro("OPERACAO_INVALIDA", "operação inválida.");
  const uid = String(foodyUid ?? "").trim();
  if (!uid || uid.length > 80) throw erro("PEDIDO_INVALIDO", "pedido inválido.");
  const texto = motivoValido(motivo);
  const atual = await repo.obterPedidoAtivoDaConexao(ctx.conexao.id, uid, ctx.permitidos);
  if (!atual) throw erro("SEM_PEDIDO", "pedido não encontrado nesta conexão.");
  // Fora da triagem, só quem DETÉM o pedido pode soltá-lo: impede uma empresa de puxar para si o dado da outra.
  if (atual.operacao !== RESULTADO_TRIAGEM && !minhas.has(atual.organizacao_id)) {
    throw erro("SEM_PERMISSAO", "pedido já atribuído a outra organização: só ela pode reclassificá-lo.");
  }
  const r = await repo.inserirDecisaoTriagem(ctx.titular, {
    conexao_id: ctx.conexao.id, organizacao_id: ctx.titular.organizacaoId, unidade_id: ctx.titular.unidadeId, foody_uid: uid,
    operacao_decidida: operacao, decidido_por: ator.perfilId, motivo: texto, catalogo_versao: CATALOGO_VERSAO,
  });
  // A decisão NÃO move dado agora: vale na próxima sincronização da competência (D-1..D-3 no ciclo normal; dia congelado pela
  // reconciliação do agendador, como reprocessamento com motivo). Os fechamentos ganham nova versão; o histórico fica.
  return { ...r, competencia: String(atual.competencia ?? "").slice(0, 10) || null, aplicacao: "PROXIMA_SINCRONIZACAO" };
}
