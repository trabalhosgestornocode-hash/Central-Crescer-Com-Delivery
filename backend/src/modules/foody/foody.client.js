// Cliente da API Foody v1.2 — SOMENTE LEITURA.
//
// GARANTIAS (cobertas por teste):
//   * o único método HTTP que este arquivo emite é GET (não existe parâmetro de método; a chamada fixa method: "GET");
//   * a única rota é /orders?startDate&endDate (a rota documentada "/orders/?" responde 404 na API real);
//   * paginação: 500 por página, ordenada por `date`; a próxima página recomeça no `date` do último pedido (startDate é
//     INCLUSIVO, então o pedido de fronteira se repete) e o resultado é DEDUPLICADO por uid;
//   * espaçamento entre chamadas (limite 100/min), timeout, poucas retentativas só para 429/5xx/rede;
//   * o token nunca aparece em mensagem de erro, retorno ou log (redação literal + chaves sensíveis).
import {
  FOODY_BASE_URL, FOODY_TAMANHO_PAGINA, FOODY_ESPACAMENTO_MS, FOODY_MAX_PAGINAS, FOODY_TIMEOUT_MS, FOODY_TENTATIVAS,
} from "./foody.constants.js";
import { redigir } from "./foody.seguranca.js";

export class FoodyApiErro extends Error {
  /** @param {string} codigo AUTENTICACAO | NAO_ENCONTRADO | LIMITE_REQUISICOES | SERVIDOR | REDE | TIMEOUT | RESPOSTA_INVALIDA | PAGINACAO_SEM_PROGRESSO | LIMITE_PAGINAS | HTTP_INESPERADO */
  constructor(codigo, mensagem, { status = null } = {}) {
    super(mensagem); this.name = "FoodyApiErro"; this.codigo = codigo; this.status = status;
  }
}

export function classificarStatusHttp(status) {
  if (status === 401 || status === 403) return "AUTENTICACAO";
  if (status === 404) return "NAO_ENCONTRADO";
  if (status === 429) return "LIMITE_REQUISICOES";
  if (status >= 500) return "SERVIDOR";
  return "HTTP_INESPERADO";
}
const retentavel = (codigo) => codigo === "LIMITE_REQUISICOES" || codigo === "SERVIDOR" || codigo === "REDE" || codigo === "TIMEOUT";

/**
 * @param {object} opcoes
 * @param {string} opcoes.token token Foody (em claro, só em memória)
 * @param {typeof fetch} [opcoes.fetch]
 * @param {(ms:number)=>Promise<void>} [opcoes.esperar]
 */
export function criarClienteFoody({
  token, fetch: fetchImpl = globalThis.fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  baseUrl = FOODY_BASE_URL, espacamentoMs = FOODY_ESPACAMENTO_MS, tamanhoPagina = FOODY_TAMANHO_PAGINA,
  maxPaginas = FOODY_MAX_PAGINAS, timeoutMs = FOODY_TIMEOUT_MS, tentativas = FOODY_TENTATIVAS,
} = {}) {
  if (typeof token !== "string" || token.trim().length < 8) throw new FoodyApiErro("AUTENTICACAO", "token Foody ausente.");
  const segredo = token.trim();
  let chamadas = 0;
  let primeira = true;

  async function getUmaVez(caminho) {
    if (!primeira) await esperar(espacamentoMs);
    primeira = false;
    chamadas++;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let resp;
    try {
      resp = await fetchImpl(`${baseUrl}${caminho}`, {
        method: "GET",
        headers: { Authorization: segredo, Accept: "application/json" },
        signal: ctrl?.signal,
      });
    } catch (e) {
      const codigo = e?.name === "AbortError" ? "TIMEOUT" : "REDE";
      throw new FoodyApiErro(codigo, redigir(`falha de ${codigo === "TIMEOUT" ? "tempo" : "rede"} na API Foody: ${e?.message ?? e}`, [segredo]));
    } finally {
      if (t) clearTimeout(t);
    }
    if (!resp.ok) {
      const codigo = classificarStatusHttp(resp.status);
      throw new FoodyApiErro(codigo, `API Foody respondeu HTTP ${resp.status} (${codigo}).`, { status: resp.status });
    }
    let corpo;
    try { corpo = await resp.json(); } catch { throw new FoodyApiErro("RESPOSTA_INVALIDA", "API Foody devolveu corpo que não é JSON."); }
    if (!Array.isArray(corpo)) throw new FoodyApiErro("RESPOSTA_INVALIDA", "API Foody devolveu algo diferente de uma lista de pedidos.");
    return corpo;
  }

  async function get(caminho) {
    let ultimo;
    for (let i = 1; i <= tentativas; i++) {
      try { return await getUmaVez(caminho); } catch (e) {
        ultimo = e;
        if (!(e instanceof FoodyApiErro) || !retentavel(e.codigo) || i === tentativas) throw e;
        await esperar(espacamentoMs * 2 ** i);
      }
    }
    throw ultimo;
  }

  /**
   * Lista os pedidos com `date` em [inicio, fim). Devolve pedidos únicos por uid, na ordem da API, e a prova de cobertura.
   * @param {{inicio:string, fim:string}} janela ISO com fuso (ex.: "2026-09-12T00:00:00-03:00")
   */
  async function listarPedidos({ inicio, fim }) {
    if (!inicio || !fim || !(Date.parse(fim) > Date.parse(inicio))) throw new RangeError("janela inválida para a API Foody.");
    const porUid = new Map();
    let cursor = inicio;
    let paginas = 0, recebidos = 0, semUid = 0;
    for (;;) {
      if (paginas >= maxPaginas) throw new FoodyApiErro("LIMITE_PAGINAS", `mais de ${maxPaginas} páginas na mesma janela.`);
      const lote = await get(`/orders?startDate=${encodeURIComponent(cursor)}&endDate=${encodeURIComponent(fim)}`);
      paginas++; recebidos += lote.length;
      for (const o of lote) {
        const uid = o && typeof o.uid === "string" && o.uid.trim() ? o.uid.trim() : null;
        if (!uid) { semUid++; continue; }
        if (!porUid.has(uid)) porUid.set(uid, o);
      }
      if (lote.length < tamanhoPagina) break;
      const ultimoDate = lote[lote.length - 1]?.date;
      // Página cheia com todos os pedidos no mesmo `date` do cursor: avançar seria impossível sem perder pedidos.
      if (!ultimoDate || Date.parse(ultimoDate) <= Date.parse(cursor)) {
        throw new FoodyApiErro("PAGINACAO_SEM_PROGRESSO", "página cheia sem avanço de data — cobertura não garantida.");
      }
      cursor = ultimoDate;
    }
    return { pedidos: [...porUid.values()], cobertura: { inicio, fim, paginas, recebidos, unicos: porUid.size, semUid } };
  }

  return { listarPedidos, get chamadas() { return chamadas; } };
}
