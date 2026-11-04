// Leituras de PLATAFORMA (fora do prefixo foody_) de que a administração Foody precisa — SÓ leitura, SÓ o mínimo:
//   * nomes de organizações/unidades que já aparecem nos vínculos do próprio contexto;
//   * organizações em que o PRÓPRIO administrador tem vínculo ativo (para escolher o destino de uma proposta) e as unidades delas.
// Nunca lista as empresas da plataforma. O módulo foody não importa este arquivo (ele continua sem acesso a tabelas de fora).

const STATUS_BLOQUEANTES = new Set(["bloqueada", "suspensa", "cancelada"]);
const LIMITE = 200;

export function criarPlataformaFoody(db) {
  if (!db || typeof db.from !== "function") throw new TypeError("criarPlataformaFoody: cliente de banco obrigatório.");
  const falha = (op, error) => Object.assign(new Error(`${op}: ${error?.code ?? ""}`.trim()), { codigo: "BANCO" });

  return {
    async nomes({ organizacoes = [], unidades = [] }) {
      const orgs = new Map(); const unis = new Map();
      const ids = (xs) => [...new Set(xs.filter(Boolean))].slice(0, LIMITE);
      if (ids(organizacoes).length) {
        const { data, error } = await db.from("organizacoes").select("id, nome").in("id", ids(organizacoes));
        if (error) throw falha("nomes.organizacoes", error);
        for (const o of data ?? []) orgs.set(o.id, o.nome);
      }
      if (ids(unidades).length) {
        const { data, error } = await db.from("unidades").select("id, nome").in("id", ids(unidades));
        if (error) throw falha("nomes.unidades", error);
        for (const u of data ?? []) unis.set(u.id, u.nome);
      }
      return { organizacoes: orgs, unidades: unis };
    },

    /** Organizações (não bloqueadas) em que o perfil tem vínculo ATIVO, de qualquer papel. */
    async organizacoesDoPerfil(perfilId) {
      if (!perfilId) return [];
      const { data: vinc, error } = await db.from("usuarios_organizacoes").select("organizacao_id")
        .eq("perfil_id", perfilId).eq("ativo", true).range(0, LIMITE - 1);
      if (error) throw falha("organizacoesDoPerfil", error);
      const ids = [...new Set((vinc ?? []).map((v) => v.organizacao_id))];
      if (!ids.length) return [];
      const { data, error: e2 } = await db.from("organizacoes").select("id, nome, status").in("id", ids);
      if (e2) throw falha("organizacoesDoPerfil.nomes", e2);
      return (data ?? []).filter((o) => !STATUS_BLOQUEANTES.has(o.status))
        .map((o) => ({ id: o.id, nome: o.nome })).sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
    },

    async unidadesDaOrganizacao(organizacaoId) {
      const { data, error } = await db.from("unidades").select("id, nome, ativo").eq("organizacao_id", organizacaoId).range(0, LIMITE - 1);
      if (error) throw falha("unidadesDaOrganizacao", error);
      return (data ?? []).filter((u) => u.ativo !== false).map((u) => ({ id: u.id, nome: u.nome }))
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
    },
  };
}
