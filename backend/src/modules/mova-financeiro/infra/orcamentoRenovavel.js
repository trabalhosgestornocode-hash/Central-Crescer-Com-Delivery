// MOVA CORE — F0 (24/11/2026): orçamento de IA RENOVÁVEL (somente HOMOLOGAÇÃO; produção segue no acumulado de operacao.js).
// Mesmo contrato do orçamento acumulado (reservar / concluir / falhar / resumo), com três limites que valem JUNTOS:
//   mensal (renova no 1º dia do mês, no fuso da política), diário (renova às 00h) e por requisição (soma das etapas de uma mesma
//   mensagem do usuário + número máximo de etapas). A reserva é ATÔMICA (bloqueio consultivo da transação) e entra no consumo
//   ANTES da chamada; o acerto usa o uso real, inclusive leitura e escrita de cache. Nenhum histórico é apagado na renovação.
import { ErroDeIa } from "../ia/provedorAnthropic.js";
import { PRECOS_IA } from "./operacao.js";

/** Tetos máximos no CÓDIGO (decisão do proprietário 24/11): o banco pode configurar menos, nunca mais. */
export const TETOS_RENOVAVEIS_MICROUSD = Object.freeze({ mensal: 10_000_000, diario: 1_000_000, requisicao: 100_000 });
/** Multiplicadores oficiais sobre o preço de ENTRADA: leitura de cache 0,1×; escrita de cache (5 min) 1,25×. */
export const MULTIPLICADOR_CACHE = Object.freeze({ leitura: 0.1, escrita: 1.25 });
/**
 * 24/11 — preços OFICIAIS revalidados (platform.claude.com/docs/en/about-claude/pricing, lidos em 24/11/2026), US$/MTok:
 *   claude-haiku-5-5 ≤100K tokens de prompt: entrada 0,10 · escrita 5 min 0,125 · escrita 1 h 0,20 · leitura 0,01 · saída 0,50
 *   claude-haiku-5-5 >100K: 0,50 · 0,625 · 1 · 0,05 · 2,50  (o tamanho do prompt inclui leitura e escrita de cache)
 *   claude-sonnet-5-5 (qualquer tamanho): 2 · 2,50 · 4 · 0,10 (0,05×) · 10
 * Sobrecarga de ferramentas no prompt: 286 tokens (tool_choice auto) / 406 (any/tool) no Haiku 5.5; 286 no Sonnet 5.5.
 */
export const PRECO_PIOR_CASO = Object.freeze({
  "claude-haiku-5-5": Object.freeze({ entrada: 0.5, escrita1h: 1, saida: 2.5 }), // pior faixa (>100K)
  "claude-sonnet-5-5": Object.freeze({ entrada: 2, escrita1h: 4, saida: 10 }),
});
export const SOBRECARGA_FERRAMENTAS_TOKENS = 406;

/**
 * RESERVA CONSERVADORA de UMA chamada (µUS$), sem depender do cache: TODO o prompt cobrado como escrita de cache de 1 h (a
 * tarifa de entrada mais cara) na faixa de preço mais alta, mais a sobrecarga de ferramentas, mais o teto de saída inteiro
 * (max_tokens, que inclui o raciocínio). Modelo desconhecido ⇒ o maior preço tabelado.
 */
export function reservaPiorCaso({ modelo, tokensDePrompt, maxTokens }) {
  if (!Number.isInteger(tokensDePrompt) || tokensDePrompt < 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) throw new TypeError("reserva exige tokens de prompt e max_tokens");
  const p = PRECO_PIOR_CASO[String(modelo ?? "").replace(/-\d{8}$/, "")]
    ?? Object.values(PRECO_PIOR_CASO).reduce((a, b) => ({ entrada: Math.max(a.entrada, b.entrada), escrita1h: Math.max(a.escrita1h, b.escrita1h), saida: Math.max(a.saida, b.saida) }));
  return Math.ceil((tokensDePrompt + SOBRECARGA_FERRAMENTAS_TOKENS) * p.escrita1h + maxTokens * p.saida);
}

/** Custo em µUS$ (tokens × US$/MTok). Modelo desconhecido: maior preço tabelado (conservador). */
export function custoMicrousd({ modelo, entrada = 0, saida = 0, cacheLeitura = 0, cacheEscrita = 0 }) {
  const tab = PRECOS_IA[String(modelo ?? "").replace(/-\d{8}$/, "")];
  const [pe, ps] = tab ?? Object.values(PRECOS_IA).reduce(([a, b], [x, y]) => [Math.max(a, x), Math.max(b, y)], [0, 0]);
  return Math.ceil(entrada * pe + saida * ps + cacheLeitura * pe * MULTIPLICADOR_CACHE.leitura + cacheEscrita * pe * MULTIPLICADOR_CACHE.escrita);
}

const ANCORAS = `with agora as (select (now() at time zone $1) as l)
  select (date_trunc('month', l) at time zone $1) as mes, (date_trunc('day', l) at time zone $1) as dia,
         to_char(l, 'YYYY-MM') as rotulo_mes, to_char(l, 'YYYY-MM-DD') as rotulo_dia from agora`;

function limitesDe(p) {
  return {
    mensal: Math.min(Number(p.limite_mensal_microusd), TETOS_RENOVAVEIS_MICROUSD.mensal),
    diario: Math.min(Number(p.limite_diario_microusd), TETOS_RENOVAVEIS_MICROUSD.diario),
    requisicao: Math.min(Number(p.limite_requisicao_microusd), TETOS_RENOVAVEIS_MICROUSD.requisicao),
    reserva: Number(p.reserva_microusd), maxPassos: Number(p.max_passos_requisicao),
    alertas: [...(p.alertas_percentuais ?? [])].map(Number).filter((n) => n > 0 && n <= 100).sort((a, b) => a - b), fuso: p.fuso,
  };
}

export function criarOrcamentoRenovavel({ pool, registrar = () => {} }) {
  async function politica(q) {
    const p = (await q.query("select * from mova.orcamento_ia_politica where id")).rows[0];
    if (!p || !p.ativo) throw new ErroDeIa("ORCAMENTO_INDISPONIVEL");
    return limitesDe(p);
  }
  async function consumos(q, lim, requisicaoId) {
    const a = (await q.query(ANCORAS, [lim.fuso])).rows[0];
    const u = (await q.query(`select coalesce(sum(custo_microusd) filter (where em >= $1), 0)::bigint as mes,
                                     coalesce(sum(custo_microusd) filter (where em >= $2), 0)::bigint as dia,
                                     coalesce(sum(custo_microusd) filter (where requisicao_id = $3), 0)::bigint as req,
                                     count(*) filter (where requisicao_id = $3)::int as passos
                                from mova.consumo_ia where em >= least($1, $2) or requisicao_id = $3`, [a.mes, a.dia, requisicaoId ?? null])).rows[0];
    return { ancoras: a, mes: Number(u.mes), dia: Number(u.dia), req: Number(u.req), passos: u.passos };
  }
  async function alertar(lim) {
    const c = await consumos(pool, lim, null);
    const novos = [];
    for (const [periodo, consumo, limite] of [[`M:${c.ancoras.rotulo_mes}`, c.mes, lim.mensal], [`D:${c.ancoras.rotulo_dia}`, c.dia, lim.diario]]) {
      if (!limite) continue;
      for (const pct of lim.alertas) {
        if (consumo * 100 < limite * pct) continue;
        const r = await pool.query("insert into mova.orcamento_ia_alerta (periodo, percentual, consumo_microusd, limite_microusd) values ($1,$2,$3,$4) on conflict do nothing", [periodo, pct, consumo, limite]);
        if (r.rowCount) { novos.push({ periodo, percentual: pct }); registrar({ tipo: "MOVA_ORCAMENTO_ALERTA", periodo, percentual: pct, consumoUsd: consumo / 1e6, limiteUsd: limite / 1e6 }); }
      }
    }
    return novos;
  }
  return Object.freeze({
    regime: "RENOVAVEL",
    /** Reserva ANTES da chamada. Recusa: ORCAMENTO_MENSAL_ESGOTADO, ORCAMENTO_DIARIO_ESGOTADO, ORCAMENTO_REQUISICAO_ESGOTADO, PASSOS_ESGOTADOS. */
    async reservar({ modelo = null, organizacaoId = null, unidadeId = null, requisicaoId = null, piorCasoMicrousd = 0 } = {}) {
      let cli;
      try { cli = await pool.connect(); } catch { throw new ErroDeIa("ORCAMENTO_INDISPONIVEL"); }
      try {
        await cli.query("begin");
        await cli.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["mova|orcamento_ia"]); // o MESMO bloqueio do acumulado
        const lim = await politica(cli);
        const c = await consumos(cli, lim, requisicaoId);
        // 24/11 — a reserva é o MAIOR entre a reserva fixa da política e o pior caso estimado DESTA chamada (reservaPiorCaso).
        const r = Math.max(lim.reserva, Number.isInteger(piorCasoMicrousd) && piorCasoMicrousd > 0 ? piorCasoMicrousd : 0);
        if (c.mes + r > lim.mensal) throw new ErroDeIa("ORCAMENTO_MENSAL_ESGOTADO");
        if (c.dia + r > lim.diario) throw new ErroDeIa("ORCAMENTO_DIARIO_ESGOTADO");
        if (requisicaoId && c.req + r > lim.requisicao) throw new ErroDeIa("ORCAMENTO_REQUISICAO_ESGOTADO");
        if (requisicaoId && c.passos >= lim.maxPassos) throw new ErroDeIa("PASSOS_ESGOTADOS");
        const id = (await cli.query(`insert into mova.consumo_ia (estado, custo_microusd, modelo, organizacao_id, unidade_id, requisicao_id, regime)
                                     values ('RESERVADA', $1, $2, $3, $4, $5, 'RENOVAVEL') returning id`, [r, modelo, organizacaoId, unidadeId, requisicaoId])).rows[0].id;
        await cli.query("commit");
        return id;
      } catch (e) {
        try { await cli.query("rollback"); } catch { /* conexão caiu */ }
        if (e instanceof ErroDeIa && e.codigo !== "ORCAMENTO_INDISPONIVEL") registrar({ tipo: "MOVA_ORCAMENTO_RECUSOU", codigo: e.codigo, requisicaoId });
        throw e instanceof ErroDeIa ? e : new ErroDeIa("ORCAMENTO_INDISPONIVEL");
      } finally { cli.release(); }
    },
    async concluir(id, { modelo, entrada = 0, saida = 0, cacheLeitura = 0, cacheEscrita = 0 }) {
      await pool.query("update mova.consumo_ia set estado = 'CONCLUIDA', modelo = coalesce($2, modelo), entrada = $3, saida = $4, cache_leitura = $5, cache_escrita = $6, custo_microusd = $7 where id = $1",
        [id, modelo ?? null, entrada, saida, cacheLeitura, cacheEscrita, custoMicrousd({ modelo, entrada, saida, cacheLeitura, cacheEscrita })]);
      try { await alertar(await politica(pool)); } catch { /* alerta nunca derruba a resposta */ }
    },
    async falhar(id, { possivelmenteFaturada = false } = {}) {
      await pool.query(possivelmenteFaturada ? "update mova.consumo_ia set estado = 'FALHOU' where id = $1" : "update mova.consumo_ia set estado = 'FALHOU', custo_microusd = 0 where id = $1", [id]);
    },
    /** Painel administrativo: mês, dia, por modelo e por unidade (só o período corrente; o histórico fica no banco). */
    async resumo() {
      const lim = await politica(pool);
      const c = await consumos(pool, lim, null);
      const porModelo = (await pool.query("select coalesce(modelo,'?') as modelo, count(*)::int as chamadas, sum(custo_microusd)::bigint as c from mova.consumo_ia where em >= $1 group by 1 order by 3 desc", [c.ancoras.mes])).rows;
      const porUnidade = (await pool.query("select unidade_id as \"unidadeId\", count(*)::int as chamadas, sum(custo_microusd)::bigint as c from mova.consumo_ia where em >= $1 group by 1 order by 3 desc", [c.ancoras.mes])).rows;
      const alertas = (await pool.query("select periodo, percentual, em from mova.orcamento_ia_alerta where periodo in ($1, $2) order by em", [`M:${c.ancoras.rotulo_mes}`, `D:${c.ancoras.rotulo_dia}`])).rows;
      return {
        regime: "RENOVAVEL", mes: c.ancoras.rotulo_mes, dia: c.ancoras.rotulo_dia,
        mensal: { custoUsd: c.mes / 1e6, limiteUsd: lim.mensal / 1e6, percentual: lim.mensal ? Math.round((c.mes * 100) / lim.mensal) : 100 },
        diario: { custoUsd: c.dia / 1e6, limiteUsd: lim.diario / 1e6, percentual: lim.diario ? Math.round((c.dia * 100) / lim.diario) : 100 },
        porRequisicaoUsd: lim.requisicao / 1e6, maxPassos: lim.maxPassos,
        porModelo: porModelo.map((x) => ({ modelo: x.modelo, chamadas: x.chamadas, custoUsd: Number(x.c) / 1e6 })),
        porUnidade: porUnidade.map((x) => ({ unidadeId: x.unidadeId, chamadas: x.chamadas, custoUsd: Number(x.c) / 1e6 })),
        alertas,
      };
    },
  });
}

/** Escolha do regime (fail-closed): renovável SÓ com a chave E em homologação; em qualquer outro caso, o acumulado de sempre. */
export function regimeDeOrcamento({ ligado = false, modo }) {
  return ligado === true && modo === "HOMOLOGACAO" ? "RENOVAVEL" : "ACUMULADO";
}
