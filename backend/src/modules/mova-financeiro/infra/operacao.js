// OPERAÇÃO do MOVA (Execução 05): interruptores em tempo real e orçamento PERSISTENTE da IA (migração 0004).
//
// Interruptores: efetivo = variável de ambiente (quem monta decide) E linha `mova.controle` E não `suspenso`. Qualquer falha ao
// ler o banco = DESLIGADO (conservador). Cache curto (padrão 5 s) para não consultar a cada mensagem.
// Orçamento: antes de CADA chamada à IA reserva-se um valor fixo numa transação que trava a linha do orçamento e confere
// chamadas e custo acumulados (o menor limite atingido vence). Se o processo cair, a reserva continua contando. Depois da
// resposta, a reserva é acertada com o uso real. Banco indisponível = NENHUMA chamada (não dá para verificar o consumo).
import { ErroDeIa, ehFalhaTransitoriaDeIa } from "../ia/provedorAnthropic.js";

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
/** US$ por milhão de tokens [entrada, saída] (preço-base, roteamento global; conferido na documentação em 21/11/2026). */
export const PRECOS_IA = Object.freeze({ "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] });
export function criarOrcamentoIa({ pool, precoEntradaPorMilhao = 4, precoSaidaPorMilhao = 20 }) {
  // Execução 13C: o custo segue o modelo que RESPONDEU; modelo desconhecido usa o maior preço tabelado (conservador).
  const microusd = (entrada, saida, modelo) => {
    const tab = PRECOS_IA[String(modelo ?? "").replace(/-\d{8}$/, "")];
    const [pe, ps] = tab ?? [Math.max(precoEntradaPorMilhao, 4), Math.max(precoSaidaPorMilhao, 20)];
    return Math.ceil(entrada * pe + saida * ps); // tokens × US$/M = µUS$
  };
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
        // Teto TOTAL fixo no código (US$ 10,00, decisão do proprietário 23/11): o banco pode configurar menos, nunca mais.
        const limite = Math.min(Number(o.limite_custo_microusd), TETO_TOTAL_IA_MICROUSD);
        if (u.n >= o.limite_chamadas || Number(u.c) + Number(o.reserva_microusd) > limite) throw new ErroDeIa("ORCAMENTO_ESGOTADO");
        const id = (await cli.query("insert into mova.consumo_ia (estado, custo_microusd) values ('RESERVADA', $1) returning id", [o.reserva_microusd])).rows[0].id;
        await cli.query("commit");
        return id;
      } catch (e) {
        try { await cli.query("rollback"); } catch { /* conexão caiu */ }
        throw e instanceof ErroDeIa ? e : new ErroDeIa("ORCAMENTO_INDISPONIVEL");
      } finally { cli.release(); }
    },
    async concluir(id, { modelo, entrada, saida }) {
      await pool.query("update mova.consumo_ia set estado = 'CONCLUIDA', modelo = $2, entrada = $3, saida = $4, custo_microusd = $5 where id = $1", [id, modelo ?? null, entrada, saida, microusd(entrada, saida, modelo)]);
    },
    /** Falha com resposta de erro da API: libera a reserva (custo 0) mas mantém o registro (conta como chamada tentada).
     *  `possivelmenteFaturada` (sem resposta: tempo, conexão): a RESERVA INTEIRA fica como custo — o limite acumulado nunca subestima. */
    async falhar(id, { possivelmenteFaturada = false } = {}) {
      await pool.query(possivelmenteFaturada ? "update mova.consumo_ia set estado = 'FALHOU' where id = $1" : "update mova.consumo_ia set estado = 'FALHOU', custo_microusd = 0 where id = $1", [id]);
    },
    async resumo() {
      const o = (await pool.query("select limite_chamadas, limite_custo_microusd from mova.orcamento_ia where id")).rows[0];
      const u = (await pool.query("select count(*)::int as n, coalesce(sum(custo_microusd),0)::bigint as c, coalesce(sum(entrada),0)::bigint as e, coalesce(sum(saida),0)::bigint as s from mova.consumo_ia")).rows[0];
      return { chamadas: u.n, limiteChamadas: o.limite_chamadas, custoUsd: Number(u.c) / 1e6, limiteUsd: Math.min(Number(o.limite_custo_microusd), TETO_TOTAL_IA_MICROUSD) / 1e6, tokensEntrada: Number(u.e), tokensSaida: Number(u.s) };
    },
  });
}

/** Envolve o cliente Anthropic: cada `create` reserva antes e acerta depois; IA desligada no controle = nenhuma chamada. */
/**
 * Execução 13B — TETO ESTRITO por chamada (`teto = {maxSaida, maxEntrada, esforco?}`), para orçamentos pequenos em que a
 * reserva contábil precisa corresponder à exposição real: max_tokens reduzido de fato, só texto (mídia recusada), entrada
 * conferida ANTES pelo endpoint gratuito de contagem (inclui o formato estruturado) e sem fallback para outro modelo.
 * Qualquer recusa acontece antes de reservar: nenhuma chamada cobrada sai.
 */
const BLOCOS_CONTAVEIS = new Set(["text", "image", "document"]);
/** Falha COM resposta HTTP da API (4xx/5xx): a requisição não foi faturada. Sem resposta (tempo esgotado, conexão caída): pode ter sido. */
/** Teto TOTAL acumulado de IA (US$ 10,00 em micro-dólares). Não reinicia: o consumo é a soma de mova.consumo_ia. */
export const TETO_TOTAL_IA_MICROUSD = 10_000_000;
export const falhaComRespostaDaApi = (e) => Number.isInteger(Number(e?.status)) && Number(e.status) >= 400;
export async function aplicarTeto(cliente, req, teto) {
  if (!teto) return req;
  const blocos = (req.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text" }]));
  // Piloto documental (23/11): imagem e PDF entram — a contagem gratuita os mede ANTES de reservar; outro tipo é recusado.
  if (blocos.some((b) => !BLOCOS_CONTAVEIS.has(b.type))) throw new ErroDeIa("IA_TETO_MIDIA_RECUSADA");
  const { betas: _b, fallbacks: _f, ...resto } = req;
  const ajustado = { ...resto, max_tokens: Math.min(req.max_tokens ?? teto.maxSaida, teto.maxSaida),
    output_config: { ...(req.output_config ?? {}), ...(teto.esforco ? { effort: teto.esforco } : {}) } };
  let n;
  try { n = (await cliente.beta.messages.countTokens({ model: ajustado.model, system: ajustado.system, messages: ajustado.messages, output_config: ajustado.output_config, ...(ajustado.thinking ? { thinking: ajustado.thinking } : {}) })).input_tokens; }
  catch (e) {
    // A causa REAL não pode ser engolida (23/11: um comprovante legível virou "foto ilegível" sem rastro). Instabilidade da API
    // (429/5xx/conexão) volta como o erro original → o provedor a trata como transitória e a fila tenta de novo; 4xx vira código
    // próprio. Nenhum conteúdo do documento entra no código: só status HTTP e nome do erro.
    if (ehFalhaTransitoriaDeIa(e)) throw e;
    const status = Number(e?.status);
    const erro = new ErroDeIa(status === 400 || status === 413 ? "IA_TETO_MIDIA_INVALIDA" : status === 401 || status === 403 ? "IA_SEM_AUTORIZACAO" : "IA_TETO_CONTAGEM_INDISPONIVEL");
    erro.detalhe = `contagem:http_${Number.isInteger(status) ? status : "sem_resposta"}:${String(e?.name ?? "Erro").slice(0, 40)}`;
    throw erro;
  }
  if (!Number.isFinite(n) || n > teto.maxEntrada) throw new ErroDeIa("IA_TETO_ENTRADA_EXCEDIDA");
  return ajustado;
}

/** `contexto()` (opcional): {organizacaoId, unidadeId, requisicaoId} da mensagem em curso — o orçamento renovável usa; o acumulado ignora. */
export function clienteComOrcamento(cliente, { orcamento, controle = null, teto = null, contexto = null }) {
  return { beta: { messages: { async create(reqOriginal) {
    if (controle && !(await controle.ligado("ia"))) throw new ErroDeIa("IA_DESLIGADA_NO_CONTROLE");
    const req = await aplicarTeto(cliente, reqOriginal, teto);
    const id = await orcamento.reservar({ modelo: req.model ?? null, ...(contexto?.() ?? {}) });
    let r;
    try { r = await cliente.beta.messages.create(req); } catch (e) {
      try { await orcamento.falhar(id, { possivelmenteFaturada: !falhaComRespostaDaApi(e) }); } catch { /* a reserva fica contando: conservador */ }
      throw e;
    }
    try { await orcamento.concluir(id, { modelo: r?.model, entrada: r?.usage?.input_tokens ?? 0, saida: r?.usage?.output_tokens ?? 0, cacheLeitura: r?.usage?.cache_read_input_tokens ?? 0, cacheEscrita: r?.usage?.cache_creation_input_tokens ?? 0 }); } catch { /* reserva fica (conservador) */ }
    return r;
  } } } };
}
