// MOVA CORE — métricas de qualidade e desempenho (em memória; o painel/persistência entra com a ligação em homologação).
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

export function criarMetricas() {
  const linhas = [];
  return Object.freeze({
    registrar(x) { linhas.push({ ...x, em: Date.now() }); if (linhas.length > 5000) linhas.shift(); },
    resumo() {
      const ia = linhas.filter((l) => l.uso);
      const porRota = {};
      for (const l of linhas) porRota[l.rota] = (porRota[l.rota] ?? 0) + 1;
      const porFerramenta = {};
      for (const l of ia) for (const f of l.ferramentas ?? []) porFerramenta[f.nome] = (porFerramenta[f.nome] ?? 0) + 1;
      return {
        total: linhas.length, porRota, porFerramenta,
        respondidas: ia.filter((l) => l.motivo === "RESPONDIDO").length, verificadorReprovou: ia.filter((l) => l.motivo === "VERIFICADOR_REPROVOU").length,
        errosDeFerramenta: ia.reduce((a, l) => a + (l.ferramentas ?? []).filter((f) => !f.ok).length, 0),
        latenciaMs: { p50: pct(ia.map((l) => l.latenciaMs), 50), p95: pct(ia.map((l) => l.latenciaMs), 95) },
        custoMicrousd: { total: ia.reduce((a, l) => a + l.uso.custoMicrousd, 0), medio: ia.length ? Math.round(ia.reduce((a, l) => a + l.uso.custoMicrousd, 0) / ia.length) : 0 },
        tokens: { entrada: ia.reduce((a, l) => a + l.uso.entrada, 0), saida: ia.reduce((a, l) => a + l.uso.saida, 0), cacheLeitura: ia.reduce((a, l) => a + l.uso.cacheLeitura, 0), cacheEscrita: ia.reduce((a, l) => a + l.uso.cacheEscrita, 0) },
      };
    },
  });
}
