// Consulta às APIs de leitura com isolamento de estado: só a resposta da ÚLTIMA solicitação é aplicada; respostas antigas
// (outra competência, outra unidade, clique rápido) são descartadas e as requisições anteriores são abortadas.
// Transporte ÚNICO de todas as chamadas da tela (consultas e ações). Na demonstração é o fetch; no modo plataforma
// (plataforma.js) leva as credenciais da Crescer às rotas reais. Trocado uma vez, na inicialização.
let transporte = (...a) => fetch(...a);
export function definirTransporte(fn) { transporte = fn; }

export function criarConsultor(fetchFn = (...a) => transporte(...a)) {
  let atual = 0;
  let controle = null;
  return {
    /** @returns {Promise<{ok:true, dados:any} | {ok:false, status:number, erro:string, mensagem:string} | null>} null = resposta obsoleta */
    async consultar(url, cabecalhos = {}) {
      const minha = (atual += 1);
      controle?.abort();
      controle = typeof AbortController === "function" ? new AbortController() : null;
      let resposta;
      try {
        const r = await fetchFn(url, { headers: { accept: "application/json", ...cabecalhos }, signal: controle?.signal, credentials: "same-origin" });
        const corpo = await r.json().catch(() => ({}));
        resposta = r.ok ? { ok: true, dados: corpo } : { ok: false, status: r.status, erro: corpo.erro ?? corpo.codigo ?? "FALHA", motivo: corpo.motivo ?? null, mensagem: corpo.mensagem ?? "Falha na consulta." };
      } catch (e) {
        resposta = e?.name === "AbortError" ? null : { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Não foi possível consultar. Verifique a conexão." };
      }
      return minha === atual ? resposta : null;
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
    return r.ok ? { ok: true, dados } : { ok: false, status: r.status, erro: dados.erro ?? dados.codigo ?? "FALHA", motivo: dados.motivo ?? null, mensagem: dados.mensagem ?? "A ação não foi concluída." };
  } catch {
    return { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Sem conexão: nada foi confirmado." };
  }
}
