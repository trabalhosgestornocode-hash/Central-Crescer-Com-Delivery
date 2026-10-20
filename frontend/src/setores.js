// Setores do app (Financeiro × Operacional) — decisão de navegação, PURA e sem DOM.
//
// A lista de setores vem SEMPRE do servidor (GET /api/v1/sessao/setores, recalculada a cada entrada no shell).
// Nada aqui autoriza coisa alguma: o backend recusa (403) qualquer rota financeira sem concessão vigente. A preferência
// guardada no navegador só decide qual cartão aparece em destaque — nunca pula a escolha nem concede acesso.

export const SETOR = Object.freeze({ FINANCEIRO: "financeiro", OPERACIONAL: "operacional" });
export const SETOR_ROTULO = Object.freeze({ financeiro: "Dashboard Financeiro", operacional: "Dashboard Operacional" });

const CHAVE_PREFERENCIA = "crescer:setor-preferido";

/** Só aceita valores conhecidos; qualquer outra coisa vira lista vazia. @param {unknown} lista */
export function setoresValidos(lista) {
  return Array.isArray(lista) ? [...new Set(lista.filter((s) => s === SETOR.FINANCEIRO || s === SETOR.OPERACIONAL))] : [];
}

/**
 * Decide o que fazer ao entrar num contexto.
 * @param {{
 *   setores: string[]|null,        // resposta do servidor; null = não foi possível consultar
 *   setorAtual?: string|null,      // setor já escolhido NESTE contexto
 *   exibicao?: boolean,            // perfil de exibição (TV): fluxo próprio, sem escolha de setor
 *   impersonando?: boolean,
 * }} e
 * @returns {{acao: 'entrar'|'escolher'|'bloqueado', setor?: string, setores: string[]}}
 */
export function decidirSetor({ setores, setorAtual = null, exibicao = false, impersonando = false }) {
  // Perfil de exibição e suporte (impersonação): sempre o operacional, como antes — o financeiro é bloqueado no backend.
  if (exibicao || impersonando) return { acao: "entrar", setor: SETOR.OPERACIONAL, setores: [SETOR.OPERACIONAL] };
  // Falha ao consultar: NÃO libera financeiro. O operacional segue o comportamento atual (o backend continua decidindo).
  if (setores === null) return { acao: "entrar", setor: SETOR.OPERACIONAL, setores: [SETOR.OPERACIONAL] };

  const validos = setoresValidos(setores);
  if (validos.length === 0) return { acao: "bloqueado", setores: validos };
  if (validos.length === 1) return { acao: "entrar", setor: validos[0], setores: validos };
  // Dois setores: mantém a escolha já feita neste contexto, desde que o servidor ainda a autorize; senão pergunta.
  if (setorAtual && validos.includes(setorAtual)) return { acao: "entrar", setor: setorAtual, setores: validos };
  return { acao: "escolher", setores: validos };
}

/** Identidade do contexto — a escolha de setor só vale dentro dele (trocar unidade/empresa/perfil pergunta de novo). */
export function chaveDoContexto(sessao) {
  return [sessao?.empresa?.id ?? "", sessao?.unidade?.id ?? "", sessao?.perfil?.id ?? ""].join(":");
}

/** Preferência de UI (por usuário). Nunca autoriza nada. */
export function lerPreferencia(usuarioId, storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(CHAVE_PREFERENCIA) || "{}")?.[usuarioId];
    return v === SETOR.FINANCEIRO || v === SETOR.OPERACIONAL ? v : null;
  } catch { return null; }
}

export function gravarPreferencia(usuarioId, setor, storage = globalThis.localStorage) {
  try {
    if (!usuarioId || (setor !== SETOR.FINANCEIRO && setor !== SETOR.OPERACIONAL)) return;
    const atual = JSON.parse(storage?.getItem(CHAVE_PREFERENCIA) || "{}");
    storage?.setItem(CHAVE_PREFERENCIA, JSON.stringify({ ...atual, [usuarioId]: setor }));
  } catch { /* storage indisponível: a preferência é só conveniência */ }
}
