// Catálogo de módulos e módulos habilitados por empresa.
//
// Mesmo espírito de permissoes.js: fonte única das constantes, usadas tanto
// pelo backend (rotas, sessão) quanto — indiretamente — pelo frontend
// (frontend/src/config.js#MENU replica os mesmos ids nas entradas gateadas).
//
// Diferença de permissoes.js: permissão é POR PAPEL (fixa em código); módulo
// é POR EMPRESA (dado, vive em `organizacao_modulos`). O catálogo de ids e
// nomes, porém, é fixo em código — não dá para uma empresa "inventar" um
// módulo novo, só habilitar/desabilitar os que existem.

import { supabase } from "../config/supabase.js";
import { ApiError } from "./ApiError.js";

/** Identificadores estáveis. Use estas constantes em vez de string solta. */
export const MODULOS = {
  DASHBOARD: "dashboard",
  PRODUTOS_CMV: "products_cmv",
  INGREDIENTS: "ingredients",
  INVENTORY: "inventory",
  SALES: "sales",
  IFOOD_DASHBOARD: "ifood_dashboard",
  MONTHLY_BONUS: "monthly_bonus",
  DISTRIBUTORS: "distributors",
  MARTIN_BROWER: "martin_brower",
  SWFAST: "swfast",
  IFOOD: "ifood",
  COCA_COLA: "coca_cola",
  HORTIFRUTI: "hortifruti",
  PARSER_FOOD_DELIVERY: "parser_food_delivery",
  AGENTE_IA: "agente_ia",
  // Gate-pai da seção "INTELIGÊNCIA" do menu (Agente Crescer · Relatórios ·
  // Integrações). Sem ele a seção inteira some e os endpoints ligados a ela
  // recusam — mesmo com `agente_ia` habilitado (dupla autorização no /agente).
  INTELIGENCIA: "inteligencia",
  // Painel operacional (TV/HDMI) da unidade. Independe do módulo `ifood`: sem integração o painel abre com aviso
  // informativo; com integração mostra os pedidos. Migration 123.
  CHECKLIST_OPERACIONAL: "checklist_operacional",
};

/**
 * Catálogo completo — espelha o seed da migration 030. `categoria` alimenta
 * o agrupamento do checklist de módulos no painel (OPERAÇÃO/INTEGRAÇÕES).
 * @type {Array<{id: string, nome: string, categoria: 'operacao'|'integracao', ordem: number}>}
 */
export const CATALOGO_MODULOS = [
  { id: MODULOS.DASHBOARD, nome: "Dashboard", categoria: "operacao", ordem: 1 },
  { id: MODULOS.PRODUTOS_CMV, nome: "Produtos / CMV", categoria: "operacao", ordem: 2 },
  { id: MODULOS.INGREDIENTS, nome: "Insumos", categoria: "operacao", ordem: 3 },
  { id: MODULOS.INVENTORY, nome: "Estoque", categoria: "operacao", ordem: 4 },
  { id: MODULOS.SALES, nome: "Vendas", categoria: "operacao", ordem: 5 },
  { id: MODULOS.IFOOD_DASHBOARD, nome: "Dashboard iFood", categoria: "operacao", ordem: 6 },
  { id: MODULOS.MONTHLY_BONUS, nome: "Bonificação Mensal", categoria: "operacao", ordem: 7 },
  { id: MODULOS.DISTRIBUTORS, nome: "Distribuidoras", categoria: "operacao", ordem: 8 },
  { id: MODULOS.MARTIN_BROWER, nome: "Martin Brower", categoria: "integracao", ordem: 9 },
  { id: MODULOS.SWFAST, nome: "SWFast / PDV", categoria: "integracao", ordem: 10 },
  { id: MODULOS.IFOOD, nome: "iFood", categoria: "integracao", ordem: 11 },
  { id: MODULOS.COCA_COLA, nome: "Coca-Cola", categoria: "integracao", ordem: 12 },
  { id: MODULOS.HORTIFRUTI, nome: "Cláudia Hortifruti", categoria: "integracao", ordem: 13 },
  { id: MODULOS.PARSER_FOOD_DELIVERY, nome: "Parser Food Delivery", categoria: "operacao", ordem: 14 },
  { id: MODULOS.AGENTE_IA, nome: "Agente Crescer (IA)", categoria: "operacao", ordem: 15 },
  // `inteligencia` fica em 'operacao' (mesma escolha de `agente_ia`) para não
  // depender de uma categoria/grupo novo nos checklists de Acessos (empresa e
  // unidade). Aparece no grupo "Operação", ao lado do Agente Crescer.
  { id: MODULOS.INTELIGENCIA, nome: "Inteligência (seção)", categoria: "operacao", ordem: 16 },
  { id: MODULOS.CHECKLIST_OPERACIONAL, nome: "Checklist Operacional", categoria: "operacao", ordem: 18 },
];

const IDS_VALIDOS = new Set(CATALOGO_MODULOS.map((m) => m.id));

/** @param {string} id */
export function rotuloModulo(id) {
  return CATALOGO_MODULOS.find((m) => m.id === id)?.nome ?? id;
}

/**
 * Módulos habilitados de uma empresa. Alimenta a sessão no momento da
 * seleção de contexto — é o que `requireModulo` acaba checando.
 * @param {string} organizacaoId
 * @returns {Promise<string[]>}
 */
export async function modulosDaEmpresa(organizacaoId) {
  const { data, error } = await supabase
    .from("organizacao_modulos").select("modulo_id").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((r) => r.modulo_id);
}

/**
 * Valida uma lista de ids de módulo vinda do cliente. Rejeita ids fora do
 * catálogo — uma empresa não pode ganhar acesso a um módulo que não existe.
 * @param {unknown} lista
 * @returns {string[]} ids únicos, validados
 */
export function validarModulos(lista) {
  if (!Array.isArray(lista)) throw ApiError.badRequest("Módulos deve ser uma lista.");
  const ids = [...new Set(lista.map((x) => String(x)))];
  const invalidos = ids.filter((id) => !IDS_VALIDOS.has(id));
  if (invalidos.length) {
    throw ApiError.badRequest(`Módulo(s) desconhecido(s): ${invalidos.join(", ")}.`);
  }
  return ids;
}

/**
 * Calcula quais módulos entram e quais saem, dado o estado atual e o
 * desejado. Função PURA (sem I/O) de propósito: separa a decisão (o quê
 * mudou) da escrita (`definirModulosEmpresa`), o que permite testar a lógica
 * do diff sem tocar o banco.
 * @param {string[]} atuais
 * @param {string[]} desejados
 * @returns {{habilitados: string[], desabilitados: string[]}}
 */
export function calcularDiffModulos(atuais, desejados) {
  const atuaisSet = new Set(atuais);
  const desejadosSet = new Set(desejados);
  return {
    habilitados: desejados.filter((id) => !atuaisSet.has(id)),
    desabilitados: atuais.filter((id) => !desejadosSet.has(id)),
  };
}

/**
 * Substitui os módulos habilitados de uma empresa pelo conjunto informado
 * (`moduloIds`), calculando o diff contra o estado atual.
 *
 * NÃO audita nem revoga sessões — isso é responsabilidade de quem chama
 * (plataforma.empresas.service.js), que sabe o ator e o motivo. Esta função
 * só aplica a escrita e devolve o que mudou, para o chamador decidir o que
 * logar.
 *
 * @param {string} organizacaoId
 * @param {string[]} moduloIds já validados (ver `validarModulos`)
 * @param {string|null} [habilitadoPor] id do superadmin, para auditoria futura na própria linha
 * @returns {Promise<{habilitados: string[], desabilitados: string[]}>}
 */
export async function definirModulosEmpresa(organizacaoId, moduloIds, habilitadoPor = null) {
  const atuais = await modulosDaEmpresa(organizacaoId);
  const { habilitados, desabilitados } = calcularDiffModulos(atuais, moduloIds);

  if (habilitados.length) {
    const { error } = await supabase.from("organizacao_modulos").insert(
      habilitados.map((modulo_id) => ({ organizacao_id: organizacaoId, modulo_id, habilitado_por: habilitadoPor }))
    );
    if (error) throw ApiError.internal(error.message);
  }
  if (desabilitados.length) {
    const { error } = await supabase.from("organizacao_modulos")
      .delete().eq("organizacao_id", organizacaoId).in("modulo_id", desabilitados);
    if (error) throw ApiError.internal(error.message);
  }

  return { habilitados, desabilitados };
}

/**
 * Insere de uma vez os módulos escolhidos na criação de uma empresa. Difere
 * de `definirModulosEmpresa` por não calcular diff (a empresa é nova — não
 * há "atual" para comparar) e por tolerar lista vazia (empresa criada sem
 * módulo nenhum, o SuperAdmin libera depois pela aba Acessos).
 * @param {string} organizacaoId
 * @param {string[]} moduloIds já validados
 * @param {string|null} [habilitadoPor]
 */
export async function provisionarModulosEmpresa(organizacaoId, moduloIds, habilitadoPor = null) {
  if (!moduloIds.length) return;
  const { error } = await supabase.from("organizacao_modulos").insert(
    moduloIds.map((modulo_id) => ({ organizacao_id: organizacaoId, modulo_id, habilitado_por: habilitadoPor }))
  );
  if (error) throw ApiError.internal(error.message);
}

// ---------------------------------------------------------------------------
// MÓDULOS POR UNIDADE — HERANÇA EMPRESA -> UNIDADE
//
// Uma unidade nunca pode ter acesso a um módulo que a própria empresa não
// tem. A regra é imposta em DOIS pontos, nunca só um:
//   * na ESCRITA (definirModulosUnidade/provisionarModulosUnidade): grava
//     só o que a empresa também tem, mesmo que o chamador peça mais;
//   * na LEITURA efetiva (modulosEfetivosDaUnidade): interseção sempre,
//     mesmo que `unidade_modulos` tenha uma linha "órfã" (ex.: a empresa
//     perdeu o módulo DEPOIS de a unidade já tê-lo — ver definirModulosEmpresa,
//     que não mexe em unidade_modulos ao remover um módulo da empresa: a
//     preferência da unidade fica registrada e volta a valer sozinha se a
//     empresa reganhar o módulo depois, sem o SuperAdmin precisar reconfigurar).
//
// `modulosEfetivosDaUnidade` é a ÚNICA função que qualquer parte do sistema
// deve chamar para saber o que uma unidade pode de fato usar — é o que
// `sessao.service.js#selecionarContexto` grava na sessão, e é o mesmo cálculo
// que a tela "Acessos" da unidade usa para desenhar o checklist.
// ---------------------------------------------------------------------------

/**
 * Módulos que a UNIDADE tem habilitados (antes de cruzar com a empresa).
 * @param {string} unidadeId
 * @returns {Promise<string[]>}
 */
export async function modulosDaUnidade(unidadeId) {
  const { data, error } = await supabase
    .from("unidade_modulos").select("modulo_id").eq("unidade_id", unidadeId);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((r) => r.modulo_id);
}

/**
 * Acesso EFETIVO de uma unidade = módulos da empresa ∩ módulos da unidade
 * (item 4 do pedido). Fonte única — usada tanto pela sessão quanto pelo
 * painel SuperAdmin, para nunca haver dois lugares calculando isso de jeitos
 * diferentes.
 * @param {string} organizacaoId
 * @param {string} unidadeId
 * @returns {Promise<string[]>}
 */
export async function modulosEfetivosDaUnidade(organizacaoId, unidadeId) {
  const [daEmpresa, daUnidade] = await Promise.all([
    modulosDaEmpresa(organizacaoId),
    modulosDaUnidade(unidadeId),
  ]);
  return interseccaoModulos(daEmpresa, daUnidade);
}

/**
 * Interseção pura entre dois conjuntos de ids de módulo — separada de
 * `modulosEfetivosDaUnidade` (que faz I/O) para poder ser testada sem banco,
 * mesmo espírito de `calcularDiffModulos`.
 * @param {string[]} modulosEmpresa
 * @param {string[]} modulosUnidade
 * @returns {string[]}
 */
export function interseccaoModulos(modulosEmpresa, modulosUnidade) {
  const daEmpresaSet = new Set(modulosEmpresa);
  return modulosUnidade.filter((id) => daEmpresaSet.has(id));
}

/**
 * Insere de uma vez os módulos escolhidos na criação de uma unidade. Filtra
 * silenciosamente para dentro do que a empresa tem — nunca lança por causa
 * disso: o chamador já deveria ter oferecido só esses no formulário, isto é
 * a última linha de defesa, não a validação principal.
 * @param {string} unidadeId
 * @param {string[]} moduloIds já validados (ver `validarModulos`)
 * @param {string[]} modulosDaEmpresaAtual
 * @param {string|null} [habilitadoPor]
 * @returns {Promise<string[]>} os que de fato entraram
 */
export async function provisionarModulosUnidade(unidadeId, moduloIds, modulosDaEmpresaAtual, habilitadoPor = null) {
  const permitidos = interseccaoModulos(modulosDaEmpresaAtual, moduloIds);
  if (!permitidos.length) return [];
  const { error } = await supabase.from("unidade_modulos").insert(
    permitidos.map((modulo_id) => ({ unidade_id: unidadeId, modulo_id, habilitado_por: habilitadoPor }))
  );
  if (error) throw ApiError.internal(error.message);
  return permitidos;
}

/**
 * Substitui os módulos habilitados de uma unidade pelo conjunto desejado,
 * recusando qualquer módulo fora do que a empresa possui (a chamada
 * simplesmente não os grava — quem chama já valida e avisa o usuário antes
 * disso, ver plataforma.unidades.service.js).
 * @param {string} unidadeId
 * @param {string[]} moduloIdsDesejados já validados contra o catálogo geral
 * @param {string[]} modulosDaEmpresaAtual
 * @param {string|null} [habilitadoPor]
 * @returns {Promise<{habilitados: string[], desabilitados: string[], recusados: string[]}>}
 */
export async function definirModulosUnidade(unidadeId, moduloIdsDesejados, modulosDaEmpresaAtual, habilitadoPor = null) {
  const permitidos = interseccaoModulos(modulosDaEmpresaAtual, moduloIdsDesejados);
  const recusados = moduloIdsDesejados.filter((id) => !permitidos.includes(id));

  const atuais = await modulosDaUnidade(unidadeId);
  const { habilitados, desabilitados } = calcularDiffModulos(atuais, permitidos);

  if (habilitados.length) {
    const { error } = await supabase.from("unidade_modulos").insert(
      habilitados.map((modulo_id) => ({ unidade_id: unidadeId, modulo_id, habilitado_por: habilitadoPor }))
    );
    if (error) throw ApiError.internal(error.message);
  }
  if (desabilitados.length) {
    const { error } = await supabase.from("unidade_modulos")
      .delete().eq("unidade_id", unidadeId).in("modulo_id", desabilitados);
    if (error) throw ApiError.internal(error.message);
  }

  return { habilitados, desabilitados, recusados };
}
