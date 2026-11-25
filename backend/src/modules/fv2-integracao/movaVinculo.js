// MOVA CORE — F2: MONTAGEM DE PRODUÇÃO do vínculo WhatsApp ↔ plataforma (§5). Só é usada quando MOVA_CORE_VINCULO_HABILITADO=1
// (desligada por padrão) e exige a migração 0019 (NÃO aplicada em produção nesta execução).
//
//   * Quem pode vincular: as pessoas da LISTA autorizada do MOVA (participantes dos grupos com acesso por LISTA e das conversas
//     privadas derivadas). Grupos ABERTOS e grupos de entregadores não geram entradas.
//   * O código só é aceito na conversa PRIVADA da pessoa (o serviço recusa no grupo).
//   * As permissões vêm da plataforma calculadas AGORA (acessoDoPerfilParaMova = as mesmas regras do seletor de contexto).
//   * Pool próprio e pequeno (MOVA_VINCULO_POOL_MAX, padrão 1, teto 2), aberto só no 1º uso; trilha na auditoria da plataforma.
import { createHash } from "node:crypto";
import { ACESSO } from "../mova-financeiro/dominio/participantes.js";

const ehPrivadoDeTelefone = (jid) => /@s\.whatsapp\.net$/.test(String(jid ?? ""));

/**
 * Entradas da lista autorizada, por organização. A mesma pessoa em vários grupos vira UMA entrada (mesmos identificadores).
 * O `id` é estável (hash dos identificadores) e não expõe o número.
 * @returns {Map<string, Array<{id:string, nome:string|null, ids:string[], privado:string|null, unidades:string[]}>>}
 */
export function entradasDaConfiguracao(cfg) {
  const orgDe = new Map((cfg?.unidades ?? []).map((u) => [u.unidadeId, u.organizacaoId]));
  const porOrg = new Map();
  for (const g of cfg?.gruposAutorizados ?? []) {
    if (g.entregador || (g.acesso ?? ACESSO.ABERTO) !== ACESSO.LISTA) continue;
    const orgs = [...new Set(g.unidades.map((u) => orgDe.get(u)).filter(Boolean))];
    if (orgs.length !== 1) continue; // grupo que mistura empresas não gera vínculo (ambíguo)
    const org = orgs[0];
    if (!porOrg.has(org)) porOrg.set(org, new Map());
    const mapa = porOrg.get(org);
    for (const p of g.participantes ?? []) {
      const ids = [...new Set([...(p.ids ?? []), ...(p.privado ? [p.privado] : [])])].sort();
      if (!ids.length) continue;
      const id = createHash("sha256").update(`${org}|${ids.join("|")}`).digest("hex").slice(0, 20);
      const atual = mapa.get(id);
      mapa.set(id, { id, nome: atual?.nome ?? p.nome ?? null, ids: p.ids ? [...p.ids] : [], privado: p.privado ?? atual?.privado ?? null,
        unidades: [...new Set([...(atual?.unidades ?? []), ...(p.unidades ?? [])])] });
    }
  }
  return new Map([...porOrg].map(([org, m]) => [org, [...m.values()]]));
}

/** identificarParticipante para o serviço de identidade: quem escreveu, de qual organização e se a conversa é PRIVADA. */
export function criarIdentificadorPelaLista(lerCfg) {
  return ({ grupoId, participanteId }) => {
    if (!participanteId) return null;
    const cfg = lerCfg();
    const grupo = (cfg?.gruposAutorizados ?? []).find((g) => g.grupoId === grupoId) ?? null;
    const privado = Boolean(grupo?.privada) || (grupoId === participanteId && ehPrivadoDeTelefone(grupoId));
    for (const [organizacaoId, entradas] of entradasDaConfiguracao(cfg)) {
      const entrada = entradas.find((e) => e.ids.includes(participanteId) || e.privado === participanteId);
      if (entrada && (!grupo || privado || (grupo.participantes ?? []).some((p) => (p.ids ?? []).includes(participanteId)))) return { entrada, organizacaoId, privado, unidades: entrada.unidades };
    }
    return null;
  };
}

/**
 * Monta (preguiçoso) o serviço de identidade de produção. Nada abre conexão até a 1ª chamada.
 * @param {{ env:object, pg:object, carregarCfg:(pool)=>Promise<object>, acessoDoPerfil:Function, auditar:Function }} deps
 */
export function montarVinculoDeProducao({ env, pg, carregarCfg, acessoDoPerfil, auditar, criarServico, criarRepositorio }) {
  let pronto = null; let cfg = null; let lidoEm = 0;
  const VALIDADE_MS = 60_000;
  const garantir = () => (pronto ??= (async () => {
    const max = Math.min(2, Math.max(1, Number.parseInt(env.MOVA_VINCULO_POOL_MAX ?? "1", 10) || 1));
    const ca = env.MOVA_PG_CA ?? env.FV2_PG_CA ?? null;
    const pool = new pg.Pool({ connectionString: env.MOVA_DATABASE_URL, max, idleTimeoutMillis: 10_000, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
    pool.on?.("error", () => {});
    const recarregar = async () => { cfg = await carregarCfg(pool); lidoEm = Date.now(); return cfg; };
    try { await recarregar(); } catch (e) { await pool.end?.().catch(() => {}); throw e; } // falhou: fecha o pool desta tentativa (sem vazar conexões)
    const servico = criarServico({
      identificarParticipante: criarIdentificadorPelaLista(() => { if (Date.now() - lidoEm > VALIDADE_MS) recarregar().catch(() => {}); return cfg; }),
      plataforma: { acessoDoPerfil },
      repositorio: criarRepositorio(pool),
      auditoria: { registrar: (x) => { auditar({ atorTipo: "sistema", acao: `mova.vinculo_whatsapp.${String(x.acao ?? "evento").toLowerCase()}`, entidade: "mova_vinculo", entidadeId: x.vinculoId ?? null, organizacaoId: x.organizacaoId ?? null, detalhes: x }).catch?.(() => {}); } },
    });
    return { servico, entradas: async (org) => { if (Date.now() - lidoEm > VALIDADE_MS) await recarregar(); return entradasDaConfiguracao(cfg).get(org) ?? []; }, fechar: () => pool.end() };
  })().catch((e) => { pronto = null; throw e; }));
  return { servico: async () => (await garantir()).servico, entradasDaOrganizacao: async (org) => (await garantir()).entradas(org), fechar: async () => { if (pronto) await (await pronto).fechar(); } };
}

/** Router de produção (a plataforma só conhece este ponto de entrada; o MOVA continua isolado em fv2-integracao). */
export async function routerDoVinculoDaPlataforma(env) {
  const [{ default: pg }, rv, ident, pers, sessao, cfgMova, pgMova, dom, aud] = await Promise.all([
    import("pg"), import("../mova-core/rotasVinculo.js"), import("../mova-core/identidade.js"), import("../mova-core/persistencia.js"),
    import("../sessao/sessao.service.js"), import("./mova.js"), import("../mova-financeiro/infra/postgres.js"),
    import("../mova-financeiro/dominio/configuracao.js"), import("../../shared/auditoria.js"),
  ]);
  const cfg = cfgMova.lerConfiguracaoMova(env);
  if (!cfg.habilitado) throw new Error("MOVA_DESLIGADO"); // sem o MOVA não há lista autorizada: a rota responde 503
  const montagem = montarVinculoDeProducao({ env, pg,
    carregarCfg: async (pool) => dom.validarConfiguracao(await pgMova.carregarConfiguracao(pool, { identidadeServico: { usuarioId: cfg.servicoUsuarioId }, modo: cfg.modo ?? "SIMULACAO" })),
    acessoDoPerfil: (x) => sessao.acessoDoPerfilParaMova(x), auditar: aud.auditar,
    criarServico: ident.criarServicoDeIdentidade, criarRepositorio: (pool) => pers.criarRepositorioDeIdentidadePostgres(pool) });
  return rv.criarRouterVinculoMova(montagem);
}
