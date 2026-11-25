// MOVA CORE — F1: REUSO das ferramentas do Agente Crescer (produtos/CMV, insumos, checklists, cancelamentos, dashboard).
// Sem importar o módulo do agente (isolamento): a camada de integração injeta o REGISTRO (agente.tools.js) e um resolvedor de
// `acesso` (módulos + permissões da plataforma) para o usuário vinculado ao participante. Sem resolvedor ⇒ nenhuma dessas
// ferramentas é oferecida (o participante do WhatsApp não herda acesso de ninguém). Cada chamada repete as checagens do próprio
// `executar()` do agente (garantirAcessoModulo/garantirPermissao) — além das do executor do MOVA CORE.
const SO_LEITURA = new Set(["read"]);

/**
 * F2 — MAPA DE PERMISSÕES das 13 ferramentas do Agente Crescer (agente.tools.js), na ordem de prioridade para o MOVA.
 * A permissão É a da plataforma (módulo contratado pela empresa/unidade + permissão do papel do perfil vinculado).
 * `sugerir_navegacao` não é oferecida no WhatsApp (aponta telas do navegador, não é dado).
 */
export const PERMISSOES_DO_AGENTE_CRESCER = Object.freeze([
  { nome: "consultar_dashboard_executivo", modulo: "ifood_dashboard", permissao: "dashboard_executivo.ver", tema: "Dashboard executivo", whatsapp: true },
  { nome: "consultar_dashboard_dia", modulo: "ifood_dashboard", permissao: "dashboard_executivo.ver", tema: "Indicadores do dia", whatsapp: true },
  { nome: "consultar_evolucao_diaria_financeiro", modulo: "ifood_dashboard", permissao: "dashboard_executivo.ver", tema: "Evolução diária (vendas/financeiro)", whatsapp: true },
  { nome: "consultar_diagnostico", modulo: "ifood_dashboard", permissao: "dashboard_executivo.ver", tema: "Análise gerencial (diagnóstico)", whatsapp: true },
  { nome: "listar_produtos_cmv", modulo: "products_cmv", permissao: "cmv.ver", tema: "Produtos e CMV (ranking)", whatsapp: true },
  { nome: "consultar_produto_cmv", modulo: "products_cmv", permissao: "cmv.ver", tema: "CMV de um produto", whatsapp: true },
  { nome: "listar_insumos", modulo: "ingredients", permissao: "insumos.ver", tema: "Insumos (ranking)", whatsapp: true },
  { nome: "consultar_insumo", modulo: "ingredients", permissao: "insumos.ver", tema: "Um insumo", whatsapp: true },
  { nome: "listar_cancelamentos", modulo: "parser_food_delivery", permissao: "parser_food_delivery.ver", tema: "Cancelamentos", whatsapp: true },
  { nome: "consultar_cancelamento", modulo: "parser_food_delivery", permissao: "parser_food_delivery.ver", tema: "Um cancelamento", whatsapp: true },
  { nome: "consultar_parser_resumo", modulo: "parser_food_delivery", permissao: "parser_food_delivery.ver", tema: "Resumo de vendas por plataforma", whatsapp: true },
  { nome: "consultar_checklist_operacional", modulo: "checklist_operacional", permissao: "checklist.visualizar", tema: "Checklists", whatsapp: true },
  { nome: "sugerir_navegacao", modulo: "agente_ia", permissao: null, tema: "Navegação de telas", whatsapp: false },
]);
const MAPA = new Map(PERMISSOES_DO_AGENTE_CRESCER.map((x) => [x.nome, x]));
/** O acesso (formato agenteAcesso) alcança esta ferramenta? — mesma regra de ferramentasDisponiveis, sem bypass de impersonação. */
export function acessoAlcanca(acesso, nome) {
  const m = MAPA.get(nome);
  if (!acesso || acesso.impersonando || !m || !m.whatsapp) return false;
  return (acesso.modulos ?? []).includes(m.modulo) && (m.permissao === null || (acesso.permissoes ?? []).includes(m.permissao));
}
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
 * F3 — CMV SÓ COMO VÁLIDO QUANDO OS DADOS DA UNIDADE PERMITEM. Produto com ficha técnica INCOMPLETA ou margem DESATUALIZADA:
 * custo, CMV e lucro saem dos dados (viram null) com o motivo — o modelo não tem número para afirmar e o verificador não aceita
 * nenhum. O ranking não traz a situação da ficha: os valores ficam (são da view oficial), com o aviso de que não foram conferidos.
 */
const CAMPOS_CMV = ["custoTotal", "margemReais", "cmvPercentual", "lucroLiquido", "custoTotalProduto"];
export function validarCmv(nome, r) {
  if (!r || typeof r !== "object") return r;
  if (nome === "consultar_produto_cmv" && r.produto) {
    const fichaOk = r.produto.possuiFichaTecnicaCompleta === true;
    const precos = (r.produto.precos ?? []).map((p) => {
      if (fichaOk && !p.desatualizado) return p;
      return { ...p, ...Object.fromEntries(CAMPOS_CMV.filter((k) => k in p).map((k) => [k, null])), cmvNaoValidado: !fichaOk ? "FICHA_TECNICA_INCOMPLETA" : "MARGEM_DESATUALIZADA" };
    });
    const invalidos = precos.filter((p) => p.cmvNaoValidado).length;
    return { ...r, produto: { ...r.produto, precos, ...(fichaOk ? {} : { custoTotalProduto: null }) },
      ...(invalidos ? { avisoMova: `CMV NÃO VALIDADO em ${invalidos} de ${precos.length} preço(s): ${!fichaOk ? `ficha técnica ${r.produto.statusFicha ?? "incompleta"}` : "margem desatualizada"}. Não apresente custo, CMV ou lucro como válidos; diga o que falta (completar a ficha / recalcular).` } : {}) };
  }
  if (nome === "listar_produtos_cmv") return { ...r, avisoMova: "Ranking pela tabela comercial indicada, SEM conferir a ficha técnica de cada produto: para afirmar o CMV de um produto como válido, consulte esse produto." };
  return r;
}

/**
 * @param {Array} registro entradas { definicao, executar, access:{module,permission}, mode, risk }
 * @param {{resolverAcesso:(escopo)=>Promise<object|null>, permitidas?:string[]}} opcoes
 * @returns {Array} ferramentas no formato do catálogo
 */
export function ferramentasDoAgenteCrescer(registro, { resolverAcesso, permitidas, acessoInicial } = {}) {
  if (typeof resolverAcesso !== "function") return [];
  return (registro ?? [])
    .filter((e) => SO_LEITURA.has(e.mode) && e.definicao?.name && (!permitidas || permitidas.includes(e.definicao.name)))
    // F2: com o acesso da pessoa vinculada, só oferece o que o módulo E a permissão dela alcançam (o executar() repete a checagem)
    .filter((e) => acessoInicial === undefined || acessoAlcanca(acessoInicial, e.definicao.name))
    .map((e) => ({
      nome: `crescer_${e.definicao.name}`.slice(0, 64),
      descricao: `[Agente Crescer] ${e.definicao.description}`.slice(0, 1000),
      esquema: { ...e.definicao.input_schema, properties: { ...(e.definicao.input_schema?.properties ?? {}) } },
      valores: true, local: true, // permissão é a da plataforma (acesso), conferida pelo próprio executar() do agente
      origem: "AGENTE_CRESCER",
      async executar({ escopo, args }) {
        const acesso = await resolverAcesso(escopo); // RE-resolvido a cada chamada: revogação vale no meio da conversa
        if (!acesso || (acessoInicial !== undefined && !acessoAlcanca(acesso, e.definicao.name))) return { erro: "SEM_ACESSO_NA_PLATAFORMA", dados: { mensagem: "Esta pessoa não tem acesso a esse módulo." }, fatos: [] };
        const r = validarCmv(e.definicao.name, await e.executar(args, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, acesso }));
        return { dados: r, fatos: fatosGenericos(r, e.definicao.name) };
      },
    }));
}
