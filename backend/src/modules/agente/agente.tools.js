// Registry central + dispatcher das tools do Agente Crescer.
//
// FASE 1 — TODAS as tools abaixo são de LEITURA. Nunca adicione aqui uma
// tool que crie, altere, corrija ou exclua qualquer dado (meta, lançamento,
// CMV, produto, insumo, classificação...). Claude só pode consultar o que já
// foi calculado pelos services existentes — nunca escrever no banco.
//
// Claude NUNCA acessa o Supabase diretamente: cada tool abaixo chama um
// service já existente do Crescer (ver tools/*.tool.js).
import { ApiError } from "../../shared/ApiError.js";
import { MODULOS } from "../../shared/modulos.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";
import * as dashboardExecutivoTool from "./tools/dashboardExecutivo.tool.js";
import * as diagnosticoTool from "./tools/diagnostico.tool.js";
import * as dashboardDiaTool from "./tools/dashboardDia.tool.js";
import * as produtoCmvTool from "./tools/produtoCmv.tool.js";
import * as produtosCmvRankingTool from "./tools/produtosCmvRanking.tool.js";
import * as insumoTool from "./tools/insumo.tool.js";
import * as insumosRankingTool from "./tools/insumosRanking.tool.js";
import * as parserResumoTool from "./tools/parserResumo.tool.js";
import * as parserCancelamentosTool from "./tools/parserCancelamentos.tool.js";
import * as parserCancelamentoTool from "./tools/parserCancelamento.tool.js";
import * as navegacaoTool from "./tools/navegacao.tool.js";
import * as evolucaoDiariaFinanceiroTool from "./tools/evolucaoDiariaFinanceiro.tool.js";
import * as checklistOperacionalTool from "./tools/checklistOperacional.tool.js";

/** Nome da tool de navegação (Etapa F.1) — única exceção ao "Consultou": nunca é fonte de dado, ver agente.service.js. */
export const NOME_TOOL_NAVEGACAO = navegacaoTool.definicao.name;

/**
 * Registry central — 1 entrada por tool, com METADADOS declarados (não só o
 * dispatcher). `access` é usado por `ferramentasDisponiveis` para filtrar o
 * CATÁLOGO enviado a Claude (1ª camada de defesa em profundidade) — mas
 * nunca substitui a validação de `garantirAcessoModulo`/`garantirPermissao`
 * DENTRO de cada `executar()` (agenteAcesso.js), que continua rodando sempre
 * (2ª camada, no momento da execução). As duas juntas: filtro prévio +
 * validação no executor.
 * `access.permission` pode ser `null` (só o módulo é exigido) — hoje só
 * `sugerir_navegacao` usa isso: ela não tem UM módulo/permissão próprios (é
 * um dispatcher pra vários destinos, cada um com o SEU módulo/permissão,
 * revalidados dentro de agente.acoes.js#resolverAcao) — só precisa que o
 * usuário esteja no Agente Crescer, o que já é garantido pra qualquer tool
 * chegar até aqui.
 * @type {Array<{
 *   definicao: object, executar: Function,
 *   access: {module: string, permission: string|null},
 *   mode: 'read'|'write', risk: 'low'|'medium'|'high',
 * }>}
 */
export const REGISTRO = [
  {
    definicao: checklistOperacionalTool.definicao, executar: checklistOperacionalTool.executar,
    access: { module: MODULOS.CHECKLIST_OPERACIONAL, permission: PERMISSOES.CHECKLIST_VISUALIZAR },
    mode: "read", risk: "low",
  },
  {
    definicao: dashboardExecutivoTool.definicao, executar: dashboardExecutivoTool.executar,
    access: { module: MODULOS.IFOOD_DASHBOARD, permission: PERMISSOES.DASHBOARD_EXECUTIVO_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: diagnosticoTool.definicao, executar: diagnosticoTool.executar,
    access: { module: MODULOS.IFOOD_DASHBOARD, permission: PERMISSOES.DASHBOARD_EXECUTIVO_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: dashboardDiaTool.definicao, executar: dashboardDiaTool.executar,
    access: { module: MODULOS.IFOOD_DASHBOARD, permission: PERMISSOES.DASHBOARD_EXECUTIVO_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: produtoCmvTool.definicao, executar: produtoCmvTool.executar,
    access: { module: MODULOS.PRODUTOS_CMV, permission: PERMISSOES.CMV_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: produtosCmvRankingTool.definicao, executar: produtosCmvRankingTool.executar,
    access: { module: MODULOS.PRODUTOS_CMV, permission: PERMISSOES.CMV_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: insumoTool.definicao, executar: insumoTool.executar,
    access: { module: MODULOS.INGREDIENTS, permission: PERMISSOES.INSUMOS_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: insumosRankingTool.definicao, executar: insumosRankingTool.executar,
    access: { module: MODULOS.INGREDIENTS, permission: PERMISSOES.INSUMOS_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: parserResumoTool.definicao, executar: parserResumoTool.executar,
    access: { module: MODULOS.PARSER_FOOD_DELIVERY, permission: PERMISSOES.PARSER_FD_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: parserCancelamentosTool.definicao, executar: parserCancelamentosTool.executar,
    access: { module: MODULOS.PARSER_FOOD_DELIVERY, permission: PERMISSOES.PARSER_FD_VER },
    mode: "read", risk: "low",
  },
  {
    definicao: parserCancelamentoTool.definicao, executar: parserCancelamentoTool.executar,
    access: { module: MODULOS.PARSER_FOOD_DELIVERY, permission: PERMISSOES.PARSER_FD_VER },
    mode: "read", risk: "low",
  },
  {
    // Etapa F.1 — sugestão de navegação. mode "read": nunca escreve nada;
    // "risk": low porque o alvo real é revalidado por módulo/permissão
    // dentro de agente.acoes.js#resolverAcao antes de qualquer sugestão
    // sair — nunca confia só no enum do input_schema.
    definicao: navegacaoTool.definicao, executar: navegacaoTool.executar,
    access: { module: MODULOS.AGENTE_IA, permission: null },
    mode: "read", risk: "low",
  },
  {
    // Etapa H — Diagnóstico Investigativo.
    definicao: evolucaoDiariaFinanceiroTool.definicao, executar: evolucaoDiariaFinanceiroTool.executar,
    access: { module: MODULOS.IFOOD_DASHBOARD, permission: PERMISSOES.DASHBOARD_EXECUTIVO_VER },
    mode: "read", risk: "low",
  },
];

/** Catálogo completo, sem filtro — só para documentação/testes. Nunca enviar isto direto a Claude (ver `ferramentasDisponiveis`). */
export const FERRAMENTAS = REGISTRO.map((r) => r.definicao);

const EXECUTORES = Object.fromEntries(REGISTRO.map((r) => [r.definicao.name, r.executar]));

/**
 * FILTRO PRÉVIO DO CATÁLOGO — o Agente não deve nem ENXERGAR uma tool que
 * não pode usar: reduz tokens, reduz confusão do modelo, reduz superfície de
 * tentativa inútil. Só declara a Claude as tools cujo módulo E permissão o
 * `acesso` atual já tem — mas isso é a 1ª camada, não a única (ver REGISTRO
 * acima: o executor sempre revalida, mesmo que este filtro tenha um bug).
 *
 * `acesso.impersonando` vê o catálogo inteiro — mesmo bypass já aplicado em
 * `agenteAcesso.js`/`requireModulo`/`requirePermissao`: o superadmin entrou
 * pra dar suporte, e travar as tools no que a empresa contratou impediria
 * justamente o diagnóstico para o qual a impersonação existe.
 * @param {import('../../middlewares/auth.js').AcessoContexto|undefined} acesso
 * @returns {object[]} subconjunto de FERRAMENTAS, no formato pronto para `tools:` da Anthropic
 */
export function ferramentasDisponiveis(acesso) {
  if (!acesso) return [];
  if (acesso.impersonando) return FERRAMENTAS;
  return REGISTRO
    .filter((r) => acesso.modulos.includes(r.access.module) && (r.access.permission == null || temPermissao(acesso.permissoes, r.access.permission)))
    .map((r) => r.definicao);
}

/**
 * Executa a tool pelo nome que Claude pediu.
 *
 * `contexto` é SEMPRE montado pelo backend a partir de `req.tenant`/
 * `req.acesso` (ver agente.service.js) — nunca do que o modelo mandou.
 * @param {string} nome
 * @param {unknown} input
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto
 */
export async function executarFerramenta(nome, input, contexto) {
  const executor = EXECUTORES[nome];
  if (!executor) throw ApiError.badRequest(`Ferramenta desconhecida: "${nome}".`);
  return executor(input && typeof input === "object" ? input : {}, contexto);
}
