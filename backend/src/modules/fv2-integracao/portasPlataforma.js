// PORTAS DA PLATAFORMA para o adaptador do Financeiro v2 (Execução 10). Leem os vínculos REAIS da Crescer no servidor:
//   - pessoa operacional → conta: perfis_operacionais (id, conta_id, ativo)
//   - pessoa operacional → unidades: usuarios_unidades (perfil_id, unidade_id, ativo) + unidades.organizacao_id
//   - quantas pessoas ativas a conta tem (conta compartilhada com PIN ≠ conta pessoal)
// Qualquer erro de leitura LANÇA: o adaptador transforma em "falha fechada" (nada é liberado sem confirmação).
// Vínculo de EMPRESA sem vínculo de UNIDADE não dá acesso ao v2 (o v2 opera por unidade explícita).
import { criarConcessoesDoRepositorio } from "../financeiro-v2/index.js";
import { identidadeDaRequisicao } from "./clienteGateway.js";

const exigir = (r) => {
  if (r?.error) throw new Error("Financeiro v2: falha ao ler vínculos da plataforma.");
  return r?.data;
};

/** @param {{from:Function}} db cliente do servidor (supabase) — só leitura de vínculos */
export function criarVinculosDaPlataforma(db) {
  return Object.freeze({
    async contaDoPerfil({ perfilId }) {
      const p = exigir(await db.from("perfis_operacionais").select("id, conta_id, ativo").eq("id", perfilId).maybeSingle());
      return p && p.ativo === true ? String(p.conta_id).toLowerCase() : null;
    },
    async perfisAtivosDaConta({ contaId }) {
      const r = await db.from("perfis_operacionais").select("id", { count: "exact", head: true }).eq("conta_id", contaId).eq("ativo", true);
      if (r?.error || !Number.isInteger(r?.count)) throw new Error("Financeiro v2: falha ao contar pessoas da conta.");
      return r.count;
    },
    async unidadesDoPerfil({ perfilId, organizacaoId }) {
      const linhas = exigir(await db.from("usuarios_unidades").select("unidade_id, ativo, unidades(organizacao_id)").eq("perfil_id", perfilId).eq("ativo", true)) ?? [];
      return linhas.filter((l) => l?.ativo === true && String(l?.unidades?.organizacao_id ?? "").toLowerCase() === String(organizacaoId).toLowerCase()).map((l) => String(l.unidade_id).toLowerCase());
    },
  });
}

/**
 * Concessões do v2 lidas COMO a própria pessoa, só na unidade da SESSÃO corrente (o gateway só emite sessão de banco
 * para essa unidade). Sem concessão ativa o banco recusa a sessão → "nenhuma concessão".
 */
export function criarConcessoesDaSessao({ repositorio }) {
  return Object.freeze({
    async listar({ organizacaoId, usuarioId }) {
      const unidadeId = identidadeDaRequisicao()?.sessao?.tenant?.unidadeId;
      if (!unidadeId) return [];
      return criarConcessoesDoRepositorio({ repositorio, escopos: [{ organizacaoId, unidadeId }] }).listar({ organizacaoId, usuarioId });
    },
  });
}
