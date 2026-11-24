// MOVA CORE — F1: REUSO das ferramentas do Agente Crescer (produtos/CMV, insumos, checklists, cancelamentos, dashboard).
// Sem importar o módulo do agente (isolamento): a camada de integração injeta o REGISTRO (agente.tools.js) e um resolvedor de
// `acesso` (módulos + permissões da plataforma) para o usuário vinculado ao participante. Sem resolvedor ⇒ nenhuma dessas
// ferramentas é oferecida (o participante do WhatsApp não herda acesso de ninguém). Cada chamada repete as checagens do próprio
// `executar()` do agente (garantirAcessoModulo/garantirPermissao) — além das do executor do MOVA CORE.
const SO_LEITURA = new Set(["read"]);
const MONETARIO = /(valor|total|custo|preco|faturamento|receita|ticket|cmv)/i;

/** Fatos genéricos: campos monetários (centavos ou reais) com o rótulo do objeto que os contém. */
function fatosGenericos(o, nome, prof = 0, entidade = null, acc = []) {
  if (!o || typeof o !== "object" || prof > 5) return acc;
  const rot = o.nome ?? o.produto ?? o.insumo ?? o.descricao ?? entidade;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && Number.isFinite(v) && MONETARIO.test(k) && !/percent|pct|quantidade|qtd/i.test(k)) {
      acc.push({ valorCentavos: k.endsWith("Centavos") ? Math.round(v) : Math.round(v * 100), significado: `CRESCER:${nome}:${k}`, entidade: rot ?? null, periodo: o.data ?? o.mes ?? null });
    } else if (v && typeof v === "object") fatosGenericos(v, nome, prof + 1, rot, acc);
  }
  return acc;
}

/**
 * @param {Array} registro entradas { definicao, executar, access:{module,permission}, mode, risk }
 * @param {{resolverAcesso:(escopo)=>Promise<object|null>, permitidas?:string[]}} opcoes
 * @returns {Array} ferramentas no formato do catálogo
 */
export function ferramentasDoAgenteCrescer(registro, { resolverAcesso, permitidas } = {}) {
  if (typeof resolverAcesso !== "function") return [];
  return (registro ?? [])
    .filter((e) => SO_LEITURA.has(e.mode) && e.definicao?.name && (!permitidas || permitidas.includes(e.definicao.name)))
    .map((e) => ({
      nome: `crescer_${e.definicao.name}`.slice(0, 64),
      descricao: `[Agente Crescer] ${e.definicao.description}`.slice(0, 1000),
      esquema: { ...e.definicao.input_schema, properties: { ...(e.definicao.input_schema?.properties ?? {}) } },
      valores: true, local: true, // permissão é a da plataforma (acesso), conferida pelo próprio executar() do agente
      origem: "AGENTE_CRESCER",
      async executar({ escopo, args }) {
        const acesso = await resolverAcesso(escopo);
        if (!acesso) return { erro: "SEM_ACESSO_NA_PLATAFORMA", dados: { mensagem: "Esta pessoa não tem acesso a esse módulo." }, fatos: [] };
        const r = await e.executar(args, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, acesso });
        return { dados: r, fatos: fatosGenericos(r, e.definicao.name) };
      },
    }));
}
