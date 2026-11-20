// Consulta às APIs de leitura com isolamento de estado: só a resposta da ÚLTIMA solicitação é aplicada; respostas antigas
// (outra competência, outra unidade, clique rápido) são descartadas e as requisições anteriores são abortadas.
// Transporte ÚNICO de todas as chamadas da tela (consultas e ações). Na demonstração é o fetch; no modo plataforma
// (plataforma.js) leva as credenciais da Crescer às rotas reais. Trocado uma vez, na inicialização.
let transporte = (...a) => fetch(...a);
export function definirTransporte(fn) { transporte = fn; }

// CACHE CURTO EM MEMÓRIA (só desta aba; nada vai para localStorage, IndexedDB nem cookie): a MESMA consulta (a URL já traz unidade, competência e
// filtros; o cabeçalho da sessão de demonstração entra na chave) é reaproveitada por poucos segundos, o que evita refazer o mesmo pedido ao
// voltar para uma aba ou alternar entre telas. Regras que mantêm os números confiáveis:
//   - só respostas BEM-SUCEDIDAS entram (erro nunca fica guardado);
//   - qualquer AÇÃO confirmada (enviar) esvazia tudo: depois de gravar, a tela relê do servidor;
//   - a resposta é copiada (quem desenha pode alterar os dados sem sujar o cache);
//   - vale poucos segundos: nada antigo é apresentado como atual por muito tempo.
export const VALIDADE_DO_CACHE_MS = 15_000;
const cache = new Map();
const copia = (x) => (typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
const chaveDoCache = (url, cabecalhos) => `${cabecalhos?.["x-fv2-demo-sessao"] ?? ""}|${url}`;
export function invalidarCache() { cache.clear(); }
const lerDoCache = (chave, agora = Date.now()) => { const e = cache.get(chave); if (!e) return null; if (agora - e.em > VALIDADE_DO_CACHE_MS) { cache.delete(chave); return null; } return copia(e.resposta); };

export function criarConsultor(fetchFn = (...a) => transporte(...a), { usarCache = true } = {}) {
  let atual = 0;
  let controle = null;
  return {
    /** Descarta a consulta em andamento (ex.: sessão encerrada): nenhuma resposta antiga será aplicada depois. */
    cancelar() { atual += 1; controle?.abort(); controle = null; },
    /** @returns {Promise<{ok:true, dados:any} | {ok:false, status:number, erro:string, mensagem:string} | null>} null = resposta obsoleta */
    async consultar(url, cabecalhos = {}) {
      const minha = (atual += 1);
      controle?.abort();
      controle = typeof AbortController === "function" ? new AbortController() : null;
      const chave = chaveDoCache(url, cabecalhos);
      const guardada = usarCache ? lerDoCache(chave) : null;
      if (guardada) return guardada;
      let resposta;
      try {
        const r = await fetchFn(url, { headers: { accept: "application/json", ...cabecalhos }, signal: controle?.signal, credentials: "same-origin" });
        const corpo = await r.json().catch(() => ({}));
        resposta = r.ok ? { ok: true, dados: corpo } : { ok: false, status: r.status, erro: corpo.erro ?? corpo.codigo ?? "FALHA", motivo: corpo.motivo ?? null, mensagem: corpo.mensagem ?? "Falha na consulta." };
      } catch (e) {
        resposta = e?.name === "AbortError" ? null : { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Não foi possível consultar. Verifique a conexão." };
      }
      if (minha !== atual) return null;
      if (usarCache && resposta?.ok) cache.set(chave, { em: Date.now(), resposta: copia(resposta) });
      return resposta;
    },
  };
}

/**
 * Ação mutável da demonstração local (POST JSON). Envia o token CSRF da sessão; nunca reexecuta sozinha e nunca
 * trata como sucesso uma resposta que não seja 2xx.
 * @returns {Promise<{ok:true, dados:any} | {ok:false, status:number, erro:string, mensagem:string}>}
 */
export async function enviar(url, corpo, cabecalhos = {}, fetchFn = (...a) => transporte(...a)) {
  try {
    const r = await fetchFn(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...cabecalhos }, body: JSON.stringify(corpo), credentials: "same-origin" });
    const dados = await r.json().catch(() => ({}));
    if (r.ok) invalidarCache(); // depois de gravar, nada guardado pode ser mostrado como atual
    return r.ok ? { ok: true, dados } : { ok: false, status: r.status, erro: dados.erro ?? dados.codigo ?? "FALHA", motivo: dados.motivo ?? null, mensagem: dados.mensagem ?? "A ação não foi concluída." };
  } catch {
    return { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Sem conexão: nada foi confirmado." };
  }
}
