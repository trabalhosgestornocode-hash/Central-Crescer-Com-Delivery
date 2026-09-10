// PAINEL ADMINISTRATIVO — Mentorados (somente leitura).
//
// Uma VISÃO consolidada das contas de acesso da plataforma e dos vínculos que
// cada uma tem com empresas/unidades. É o mesmo dado que o Painel SuperAdmin
// mostra em /plataforma/usuarios (plataforma.usuarios.service.js#listarUsuarios),
// porém:
//   * exposto sob `requirePainelAdministrativo` (NÃO exige SuperAdmin — ver
//     administrativo.routes.js), e
//   * SOMENTE LEITURA — nenhuma ação administrativa (redefinir senha, trocar
//     e-mail, associar empresa, permissões) é alcançável por aqui.
//
// MODELO DE IDENTIDADE (o mesmo do resto do sistema):
//   perfis                 -> a CONTA (espelho 1:1 de auth.users): e-mail + login
//   perfis_operacionais    -> a PESSOA: N por conta (multi-perfil, migration 060)
//   usuarios_organizacoes  -> ACESSO a uma empresa   (chave canônica: perfil_id;
//   usuarios_unidades      -> ACESSO a uma unidade     `usuario_id` = a conta,
//                             LEGACY porém sempre preenchido == conta)
//
// Um "mentorado" é a CONTA. Quando a conta tem mais de um perfil, os vínculos
// de todos os perfis aparecem juntos, marcados com o nome do perfil.
//
// QUEM NÃO É MENTORADO: quem tem acesso ao PRÓPRIO Painel Administrativo. O
// critério é a MESMA regra do middleware `requirePainelAdministrativo`
// (superadmin || painelAdministrativo) — lida das fontes oficiais:
//   * `painel_administrativo_usuarios` com `ativo = true`  -> acesso explícito
//   * `plataforma_admins`              com `ativo = true`  -> SuperAdmin (bypass)
// Sem lista manual, sem e-mail/ID fixo. Nada da concessão de acesso muda aqui —
// só é CONSULTADA para excluir essas contas da listagem.
//
// CUSTO: 8 queries FIXAS, independente do número de contas. Nunca
// `for conta: SELECT`.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { rotuloPapel } from "../../shared/permissoes.js";

// PostgREST tem limite prático de URL — fatiar `.in(...)` grande (mesma
// disciplina de administrativo.repo.js).
const LOTE_IN = 200;
const emLotes = (arr, n = LOTE_IN) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Roda `carregar(lote)` para cada fatia de `ids` e concatena. Query única quando `ids` cabe num lote. */
async function buscarEmLotes(ids, carregar) {
  if (!ids.length) return [];
  const partes = await Promise.all(emLotes(ids).map(carregar));
  return partes.flat();
}

const papelRotuloOuHerda = (papel) => (papel ? rotuloPapel(papel) : "herda da empresa");

/**
 * Lista as contas da plataforma e seus vínculos empresa/unidade, já
 * consolidados por empresa. Entra a conta que (1) tem ao menos um vínculo de
 * empresa/unidade E (2) NÃO tem acesso ao Painel Administrativo (nem explícito
 * nem como SuperAdmin) — "mentorado" é o cliente acompanhado, não quem opera o
 * painel.
 *
 * @param {{}} [_filtros] reservado (a busca por nome/e-mail é client-side na tela).
 * @param {{supabase?: typeof supabase}} [deps] injeção para teste.
 * @returns {Promise<{mentorados: Array<object>, total: number}>}
 */
export async function listarMentorados(_filtros = {}, deps = {}) {
  const db = deps.supabase ?? supabase;

  // 1. CONTAS (perfis) — a identidade de login. `nome`/`email` de exibição.
  const { data: contasData, error: errContas } = await db
    .from("perfis")
    .select("id, nome, email, ativo");
  if (errContas) throw ApiError.internal(errContas.message);
  const contas = (contasData ?? [])
    .slice()
    .sort((a, b) => String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR"));
  if (!contas.length) return { mentorados: [], total: 0 };

  const contaIds = contas.map((c) => c.id);

  // 2..6 — carregadas em paralelo, todas em lote por conta.
  const [perfisOp, vincOrg, vincUni, comPainelAdm, superadmins] = await Promise.all([
    // 2. PERFIS OPERACIONAIS (a pessoa). Degrada pré-060 (sem a tabela) para
    //    "a conta é seu próprio perfil".
    buscarEmLotes(contaIds, (lote) =>
      db.from("perfis_operacionais").select("id, conta_id, nome, ativo").in("conta_id", lote)
        .then((r) => {
          if (r.error && /perfis_operacionais|does not exist|schema cache|could not find/i.test(r.error.message || "")) return [];
          if (r.error) throw ApiError.internal(r.error.message);
          return r.data ?? [];
        })),
    // 3. VÍNCULOS DE EMPRESA — por `usuario_id` (a conta), como faz o Painel
    //    SuperAdmin. `perfil_id` diz de qual perfil da conta veio o vínculo.
    buscarEmLotes(contaIds, (lote) =>
      db.from("usuarios_organizacoes")
        .select("usuario_id, perfil_id, organizacao_id, papel, ativo")
        .in("usuario_id", lote)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
    // 4. VÍNCULOS DE UNIDADE — idem. `papel` NULL = herda o papel da empresa.
    buscarEmLotes(contaIds, (lote) =>
      db.from("usuarios_unidades")
        .select("usuario_id, perfil_id, unidade_id, papel, ativo")
        .in("usuario_id", lote)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
    // 5. ACESSO EXPLÍCITO ao Painel Administrativo (fonte oficial, migration 061).
    buscarEmLotes(contaIds, (lote) =>
      db.from("painel_administrativo_usuarios").select("usuario_id")
        .in("usuario_id", lote).eq("ativo", true)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
    // 6. SuperAdmins (fonte oficial) — entram no Painel Administrativo por bypass
    //    no `requirePainelAdministrativo`, então também não são mentorados.
    buscarEmLotes(contaIds, (lote) =>
      db.from("plataforma_admins").select("usuario_id")
        .in("usuario_id", lote).eq("ativo", true)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
  ]);

  // Contas com acesso ao PRÓPRIO Painel Administrativo — critério idêntico ao
  // middleware `requirePainelAdministrativo` (painelAdministrativo || superadmin).
  const temAcessoPainelAdm = new Set([
    ...comPainelAdm.map((r) => r.usuario_id),
    ...superadmins.map((r) => r.usuario_id),
  ]);

  // 7. Nomes das empresas e unidades referenciadas (uma query cada).
  const orgIds = [...new Set(vincOrg.map((v) => v.organizacao_id).filter(Boolean))];
  const uniIds = [...new Set(vincUni.map((v) => v.unidade_id).filter(Boolean))];
  const [orgs, unidades] = await Promise.all([
    buscarEmLotes(orgIds, (lote) =>
      db.from("organizacoes").select("id, nome, status").in("id", lote)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
    buscarEmLotes(uniIds, (lote) =>
      db.from("unidades").select("id, nome, organizacao_id").in("id", lote)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; })),
  ]);

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const uniById = new Map(unidades.map((u) => [u.id, u]));
  // Empresas referenciadas SÓ por um vínculo de unidade também precisam de nome.
  const orgIdsDeUnidades = [...new Set(unidades.map((u) => u.organizacao_id).filter((id) => id && !orgById.has(id)))];
  if (orgIdsDeUnidades.length) {
    const extra = await buscarEmLotes(orgIdsDeUnidades, (lote) =>
      db.from("organizacoes").select("id, nome, status").in("id", lote)
        .then((r) => { if (r.error) throw ApiError.internal(r.error.message); return r.data ?? []; }));
    for (const o of extra) orgById.set(o.id, o);
  }

  // Índices por conta.
  const perfisPorConta = new Map();
  for (const p of perfisOp) {
    const lista = perfisPorConta.get(p.conta_id) ?? [];
    lista.push(p);
    perfisPorConta.set(p.conta_id, lista);
  }
  const nomePerfil = new Map(perfisOp.map((p) => [p.id, p.nome]));
  const orgPorConta = new Map();
  for (const v of vincOrg) {
    const lista = orgPorConta.get(v.usuario_id) ?? [];
    lista.push(v);
    orgPorConta.set(v.usuario_id, lista);
  }
  const uniPorConta = new Map();
  for (const v of vincUni) {
    const lista = uniPorConta.get(v.usuario_id) ?? [];
    lista.push(v);
    uniPorConta.set(v.usuario_id, lista);
  }

  const mentorados = [];
  for (const conta of contas) {
    // Quem opera o PRÓPRIO Painel Administrativo não é mentorado (regra igual à
    // do `requirePainelAdministrativo`). A concessão de acesso não é tocada —
    // só consultada acima.
    if (temAcessoPainelAdm.has(conta.id)) continue;

    const vOrg = orgPorConta.get(conta.id) ?? [];
    const vUni = uniPorConta.get(conta.id) ?? [];
    if (!vOrg.length && !vUni.length) continue;   // sem vínculo => não é mentorado (ainda)

    const perfisDaConta = (perfisPorConta.get(conta.id) ?? [{ id: conta.id, nome: conta.nome, ativo: conta.ativo }])
      .map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo !== false }));
    const multiPerfil = perfisDaConta.length > 1;
    const perfilNomeDe = (perfilId) => (multiPerfil ? (nomePerfil.get(perfilId) ?? null) : null);

    // Consolida por empresa. `grupo(orgId)` cria a entrada sob demanda.
    const grupos = new Map();
    const grupo = (orgId) => {
      if (!grupos.has(orgId)) {
        const o = orgById.get(orgId);
        grupos.set(orgId, {
          empresaId: orgId ?? null,
          empresaNome: o?.nome ?? "—",
          empresaStatus: o?.status ?? null,
          associacaoDireta: false,
          papel: null,
          papelRotulo: null,
          unidades: [],
          _perfis: new Set(),
        });
      }
      return grupos.get(orgId);
    };

    for (const v of vOrg) {
      const g = grupo(v.organizacao_id);
      g.associacaoDireta = true;
      g.papel = v.papel ?? null;
      g.papelRotulo = v.papel ? rotuloPapel(v.papel) : null;
      const pn = perfilNomeDe(v.perfil_id);
      if (pn) g._perfis.add(pn);
    }
    for (const v of vUni) {
      const u = uniById.get(v.unidade_id);
      const orgId = u?.organizacao_id ?? null;
      const g = grupo(orgId);
      const pn = perfilNomeDe(v.perfil_id);
      if (pn) g._perfis.add(pn);
      g.unidades.push({
        unidadeId: v.unidade_id ?? null,
        unidadeNome: u?.nome ?? "—",
        papel: v.papel ?? null,
        papelRotulo: papelRotuloOuHerda(v.papel),
        perfilNome: pn,
      });
    }

    const vinculos = [...grupos.values()]
      .map((g) => {
        g.unidades.sort((a, b) => String(a.unidadeNome).localeCompare(String(b.unidadeNome), "pt-BR"));
        const { _perfis, ...limpo } = g;
        return { ...limpo, perfilNomes: [..._perfis].sort((a, b) => a.localeCompare(b, "pt-BR")) };
      })
      .sort((a, b) => String(a.empresaNome).localeCompare(String(b.empresaNome), "pt-BR"));

    mentorados.push({
      id: conta.id,
      nome: conta.nome ?? "—",
      email: conta.email ?? "—",
      contaAtiva: conta.ativo !== false,
      perfis: perfisDaConta,
      multiPerfil,
      totalVinculos: vOrg.length + vUni.length,
      totalEmpresas: vinculos.length,
      totalUnidades: vUni.length,
      vinculos,
    });
  }

  return { mentorados, total: mentorados.length };
}
