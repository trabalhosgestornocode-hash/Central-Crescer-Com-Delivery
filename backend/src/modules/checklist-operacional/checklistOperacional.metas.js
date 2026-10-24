// Checklist Operacional — METAS da unidade (funções puras: validação, formato e meta vigente num instante).
//
// Fonte da verdade: `checklist_metas` (migration 127), uma linha por unidade com `versao`. Toda escrita passa por
// `checklist_metas_salvar` (compara a versão esperada e grava o histórico na mesma transação). Este módulo não lê nem
// grava nada: o service chama, os testes chamam direto.
//
// MESMA régua do formulário da tela (frontend/src/checklistOperacionalModelo.js#validarMetas): meta em minutos,
// 0 < meta ≤ 240; aviso ("próximo da meta a partir de") em % da meta, 50 ≤ aviso ≤ 99. Uma casa decimal (o banco
// arredonda igual). Vírgula decimal aceita.
//
// SEM METAS SALVAS a unidade usa METAS_PADRAO — os exemplos de partida que a tela já usava —, sempre marcadas
// `origem: 'padrao'`: a tela diz que são de exemplo e o Dashboard NUNCA as usa para avaliar pedidos passados.

export const ETAPAS_META = Object.freeze(["preparo", "entrega", "vida"]);

/** Exemplos de partida (os mesmos de METAS_EXEMPLO no frontend). Nunca metas universais. */
export const METAS_PADRAO = Object.freeze({
  preparo: Object.freeze({ meta: 12, avisoPct: 80 }),
  entrega: Object.freeze({ meta: 35, avisoPct: 80 }),
  vida: Object.freeze({ meta: 45, avisoPct: 80 }),
});

export const LIMITES_META = Object.freeze({ metaMax: 240, avisoMin: 50, avisoMax: 99 });

const umaCasa = (n) => Math.round(n * 10) / 10;

function numero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Valida o corpo `{ preparo: {meta, avisoPct}, entrega: {...}, vida: {...} }`.
 * @returns {{ok: true, metas: object} | {ok: false, erros: Record<string, string>}}
 */
export function validarMetasEntrada(entrada) {
  const erros = {};
  const metas = {};
  for (const etapa of ETAPAS_META) {
    const meta = numero(entrada?.[etapa]?.meta);
    const aviso = numero(entrada?.[etapa]?.avisoPct);
    if (meta == null || meta <= 0 || meta > LIMITES_META.metaMax) erros[`${etapa}.meta`] = "Informe uma meta entre 1 e 240 minutos.";
    if (aviso == null || aviso < LIMITES_META.avisoMin || aviso > LIMITES_META.avisoMax) erros[`${etapa}.avisoPct`] = "Use um valor entre 50% e 99% da meta.";
    metas[etapa] = { meta: meta == null ? null : umaCasa(meta), avisoPct: aviso == null ? null : umaCasa(aviso) };
  }
  // Arredondar pode levar 0,04 a 0: o banco recusaria; aqui a mensagem é a mesma do formulário.
  for (const etapa of ETAPAS_META) if (!erros[`${etapa}.meta`] && !(metas[etapa].meta > 0)) erros[`${etapa}.meta`] = "Informe uma meta entre 1 e 240 minutos.";
  return Object.keys(erros).length ? { ok: false, erros } : { ok: true, metas };
}

/** Valores de uma linha (ou do jsonb do histórico) como números. */
export function valoresDeJson(json) {
  if (!json) return null;
  const out = {};
  for (const etapa of ETAPAS_META) {
    const meta = numero(json?.[etapa]?.meta);
    const avisoPct = numero(json?.[etapa]?.avisoPct);
    if (meta == null || avisoPct == null) return null;
    out[etapa] = { meta, avisoPct };
  }
  return out;
}

const valoresDaLinha = (l) => ({
  preparo: { meta: Number(l.preparo_meta_min), avisoPct: Number(l.preparo_aviso_pct) },
  entrega: { meta: Number(l.entrega_meta_min), avisoPct: Number(l.entrega_aviso_pct) },
  vida: { meta: Number(l.vida_meta_min), avisoPct: Number(l.vida_aviso_pct) },
});

const copiaPadrao = () => JSON.parse(JSON.stringify(METAS_PADRAO));

/**
 * Formato único das metas na API (resumo, GET e PUT).
 * `origem`: 'unidade' (salvas) | 'padrao' (exemplo; a unidade ainda não salvou) | 'indisponivel' (migration 127 ausente
 * ou falha de leitura — a tela usa o exemplo e avisa; a edição fica bloqueada).
 */
export function metasDaLinha(linha) {
  if (!linha) return { origem: "padrao", versao: 0, valores: copiaPadrao(), atualizadoEm: null, atualizadoPor: null };
  return {
    origem: "unidade",
    versao: Number(linha.versao),
    valores: valoresDaLinha(linha),
    atualizadoEm: linha.atualizado_em ?? null,
    atualizadoPor: linha.atualizado_por_nome ?? null,
  };
}

export const metasIndisponiveis = (motivo) => ({
  origem: "indisponivel", versao: null, valores: copiaPadrao(), atualizadoEm: null, atualizadoPor: null, motivo,
});

/** Resultado da função do banco → resposta. */
export function resultadoDoSalvar(linha) {
  return {
    resultado: linha?.resultado ?? "erro",
    metas: linha?.metas_atual
      ? { origem: "unidade", versao: Number(linha.versao_atual), valores: valoresDeJson(linha.metas_atual), atualizadoEm: linha.atualizado_em_atual ?? null, atualizadoPor: linha.atualizado_por_atual ?? null }
      : metasDaLinha(null),
  };
}

/**
 * Versões ordenadas para avaliar pedidos passados: `[{ desdeMs, versao, valores }]`, da mais antiga para a mais nova.
 * Entradas inválidas são ignoradas (nunca inventam meta).
 */
export function linhaDoTempoDasMetas(historico) {
  return (historico ?? [])
    .map((h) => ({ desdeMs: Date.parse(h.alterado_em), versao: Number(h.versao), valores: valoresDeJson(h.novo) }))
    .filter((h) => Number.isFinite(h.desdeMs) && h.valores)
    .sort((a, b) => a.desdeMs - b.desdeMs || a.versao - b.versao);
}

/**
 * Meta vigente no instante `t` (ms): a última versão salva com `desdeMs ≤ t`. Antes da primeira: null — o pedido fica
 * "sem meta vigente" (nunca é avaliado pelo exemplo). Busca binária: o histórico é pequeno, mas o Dashboard chama isto
 * por pedido.
 */
export function metaVigenteEm(linhaDoTempo, t) {
  if (!Number.isFinite(t) || !linhaDoTempo?.length) return null;
  let lo = 0;
  let hi = linhaDoTempo.length - 1;
  let achou = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (linhaDoTempo[m].desdeMs <= t) { achou = m; lo = m + 1; } else hi = m - 1;
  }
  return achou < 0 ? null : linhaDoTempo[achou];
}
