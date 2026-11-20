// OPERAÇÃO do MOVA (Execução 05): interruptores em tempo real e orçamento PERSISTENTE da IA (migração 0004).
//
// Interruptores: efetivo = variável de ambiente (quem monta decide) E linha `mova.controle` E não `suspenso`. Qualquer falha ao
// ler o banco = DESLIGADO (conservador). Cache curto (padrão 5 s) para não consultar a cada mensagem.
// Orçamento: antes de CADA chamada à IA reserva-se um valor fixo numa transação que trava a linha do orçamento e confere
// chamadas e custo acumulados (o menor limite atingido vence). Se o processo cair, a reserva continua contando. Depois da
// resposta, a reserva é acertada com o uso real. Banco indisponível = NENHUMA chamada (não dá para verificar o consumo).
import { ErroDeIa } from "../ia/provedorAnthropic.js";

export const CHAVES_DE_CONTROLE = Object.freeze(["recebimento", "processamento", "ia", "envio"]);

export function criarControle({ pool, cacheMs = 5000, relogio = () => Date.now() }) {
  let cache = null;
  async function ler() {
    if (cache && relogio() - cache.em < cacheMs) return cache.linha;
    const r = await pool.query("select suspenso, recebimento, processamento, ia, envio, motivo, atualizado_por, atualizado_em from mova.controle where id");
    cache = { em: relogio(), linha: r.rows[0] ?? null };
    return cache.linha;
  }
  return Object.freeze({
    /** Ligado AGORA? (falha de leitura ou linha ausente = false) */
    async ligado(chave) {
      if (!CHAVES_DE_CONTROLE.includes(chave)) return false;
      try { const l = await ler(); return Boolean(l && !l.suspenso && l[chave]); } catch { return false; }
    },
    async estado() { try { return await ler(); } catch { return null; } },
    /** Reversão funcional (ou religar). `alteracoes`: { suspenso?, recebimento?, processamento?, ia?, envio? } */
    async alterar(alteracoes, { autor, motivo = null }) {
      const campos = Object.keys(alteracoes).filter((k) => k === "suspenso" || CHAVES_DE_CONTROLE.includes(k));
      if (campos.length === 0 || campos.some((k) => typeof alteracoes[k] !== "boolean")) throw new TypeError("alterações inválidas");
      const sets = campos.map((k, i) => `${k} = $${i + 1}`).join(", ");
      await pool.query(`update mova.controle set ${sets}, motivo = $${campos.length + 1}, atualizado_por = $${campos.length + 2}, atualizado_em = now() where id`, [...campos.map((k) => alteracoes[k]), motivo, String(autor ?? "desconhecido").slice(0, 120)]);
      await pool.query("insert into mova.auditoria (acao, ator_tipo, ator_ref, dados) values ('CONTROLE_ALTERADO', 'USUARIO', $1, $2)", [String(autor ?? "desconhecido").slice(0, 120), JSON.stringify({ ...alteracoes, motivo })]);
      cache = null;
    },
  });
}

/**
 * @param {{pool:object, precoEntradaPorMilhao?:number, precoSaidaPorMilhao?:number}} deps  preços em US$ por milhão de tokens
 */
export function criarOrcamentoIa({ pool, precoEntradaPorMilhao = 4, precoSaidaPorMilhao = 20 }) {
  const microusd = (entrada, saida) => Math.ceil((entrada * precoEntradaPorMilhao + saida * precoSaidaPorMilhao)); // tokens × US$/M = µUS$
  return Object.freeze({
    /** Reserva ANTES da chamada. Lança ErroDeIa ORCAMENTO_ESGOTADO / ORCAMENTO_INDISPONIVEL (nunca transitório: não re-tenta sozinho). */
    async reservar() {
      let cli;
      try { cli = await pool.connect(); } catch { throw new ErroDeIa("ORCAMENTO_INDISPONIVEL"); }
      try {
        await cli.query("begin");
        // Serializa as reservas com bloqueio CONSULTIVO da transação: o papel mova_app só LÊ o orçamento (FOR UPDATE exigiria UPDATE).
        await cli.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["mova|orcamento_ia"]);
        const o = (await cli.query("select limite_chamadas, limite_custo_microusd, reserva_microusd from mova.orcamento_ia where id")).rows[0];
        if (!o) throw new ErroDeIa("ORCAMENTO_INDISPONIVEL");
        const u = (await cli.query("select count(*)::int as n, coalesce(sum(custo_microusd), 0)::bigint as c from mova.consumo_ia")).rows[0];
        if (u.n >= o.limite_chamadas || Number(u.c) + Number(o.reserva_microusd) > Number(o.limite_custo_microusd)) throw new ErroDeIa("ORCAMENTO_ESGOTADO");
        const id = (await cli.query("insert into mova.consumo_ia (estado, custo_microusd) values ('RESERVADA', $1) returning id", [o.reserva_microusd])).rows[0].id;
        await cli.query("commit");
        return id;
      } catch (e) {
        try { await cli.query("rollback"); } catch { /* conexão caiu */ }
        throw e instanceof ErroDeIa ? e : new ErroDeIa("ORCAMENTO_INDISPONIVEL");
      } finally { cli.release(); }
    },
    async concluir(id, { modelo, entrada, saida }) {
      await pool.query("update mova.consumo_ia set estado = 'CONCLUIDA', modelo = $2, entrada = $3, saida = $4, custo_microusd = $5 where id = $1", [id, modelo ?? null, entrada, saida, microusd(entrada, saida)]);
    },
    /** Falha antes do modelo responder: libera a reserva (custo 0) mas mantém o registro (conta como chamada tentada). */
    async falhar(id) { await pool.query("update mova.consumo_ia set estado = 'FALHOU', custo_microusd = 0 where id = $1", [id]); },
    async resumo() {
      const o = (await pool.query("select limite_chamadas, limite_custo_microusd from mova.orcamento_ia where id")).rows[0];
      const u = (await pool.query("select count(*)::int as n, coalesce(sum(custo_microusd),0)::bigint as c, coalesce(sum(entrada),0)::bigint as e, coalesce(sum(saida),0)::bigint as s from mova.consumo_ia")).rows[0];
      return { chamadas: u.n, limiteChamadas: o.limite_chamadas, custoUsd: Number(u.c) / 1e6, limiteUsd: Number(o.limite_custo_microusd) / 1e6, tokensEntrada: Number(u.e), tokensSaida: Number(u.s) };
    },
  });
}

/** Envolve o cliente Anthropic: cada `create` reserva antes e acerta depois; IA desligada no controle = nenhuma chamada. */
export function clienteComOrcamento(cliente, { orcamento, controle = null }) {
  return { beta: { messages: { async create(req) {
    if (controle && !(await controle.ligado("ia"))) throw new ErroDeIa("IA_DESLIGADA_NO_CONTROLE");
    const id = await orcamento.reservar();
    let r;
    try { r = await cliente.beta.messages.create(req); } catch (e) {
      try { await orcamento.falhar(id); } catch { /* a reserva fica contando: conservador */ }
      throw e;
    }
    try { await orcamento.concluir(id, { modelo: r?.model, entrada: r?.usage?.input_tokens ?? 0, saida: r?.usage?.output_tokens ?? 0 }); } catch { /* reserva fica (conservador) */ }
    return r;
  } } } };
}
