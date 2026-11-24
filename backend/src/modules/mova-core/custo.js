// MOVA CORE — custo REAL de uma chamada (µUS$) pelas tarifas oficiais revalidadas em 24/11/2026
// (platform.claude.com/docs/en/about-claude/pricing). Reserva conservadora: infra/orcamentoRenovavel.js#reservaPiorCaso.
// Haiku 5.5 tem DUAS faixas, escolhidas pelo tamanho do prompt (entrada + leitura + escrita de cache) — >100K custa 5×.
export const TARIFAS = Object.freeze({
  "claude-haiku-5-5": Object.freeze([
    { ate: 100_000, entrada: 0.1, escrita5m: 0.125, escrita1h: 0.2, leitura: 0.01, saida: 0.5 },
    { ate: Infinity, entrada: 0.5, escrita5m: 0.625, escrita1h: 1, leitura: 0.05, saida: 2.5 },
  ]),
  "claude-sonnet-5-5": Object.freeze([{ ate: Infinity, entrada: 2, escrita5m: 2.5, escrita1h: 4, leitura: 0.1, saida: 10 }]),
});

/** @param {{modelo:string, uso:object}} p uso = response.usage da API */
export function custoRealMicrousd({ modelo, uso = {} }) {
  const faixas = TARIFAS[String(modelo ?? "").replace(/-\d{8}$/, "")];
  const entrada = uso.input_tokens ?? 0;
  const leitura = uso.cache_read_input_tokens ?? 0;
  const escrita = uso.cache_creation_input_tokens ?? 0;
  const escrita1h = uso.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const escrita5m = Math.max(0, escrita - escrita1h);
  const saida = uso.output_tokens ?? 0;
  const prompt = entrada + leitura + escrita;
  // modelo desconhecido: a maior tarifa conhecida em cada componente (conservador)
  const t = faixas ? faixas.find((f) => prompt <= f.ate) : { entrada: 2, escrita5m: 2.5, escrita1h: 4, leitura: 0.1, saida: 10 };
  return Math.ceil(entrada * t.entrada + escrita5m * t.escrita5m + escrita1h * t.escrita1h + leitura * t.leitura + saida * t.saida);
}

/** Estimativa CONSERVADORA de tokens de um pedido (≈2,5 caracteres/token para português com JSON — superestima de propósito). */
export function estimarTokensDoPedido(req) {
  const texto = JSON.stringify([req.system ?? "", req.tools ?? [], req.messages ?? []]);
  return Math.ceil(texto.length / 2.5);
}
