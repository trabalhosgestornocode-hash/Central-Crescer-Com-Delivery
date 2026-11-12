// Consulta às APIs de leitura com isolamento de estado: só a resposta da ÚLTIMA solicitação é aplicada; respostas antigas
// (outra competência, outra unidade, clique rápido) são descartadas e as requisições anteriores são abortadas.
export function criarConsultor(fetchFn = (...a) => fetch(...a)) {
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
        resposta = r.ok ? { ok: true, dados: corpo } : { ok: false, status: r.status, erro: corpo.erro ?? "FALHA", mensagem: corpo.mensagem ?? "Falha na consulta." };
      } catch (e) {
        resposta = e?.name === "AbortError" ? null : { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Não foi possível consultar. Verifique a conexão." };
      }
      return minha === atual ? resposta : null;
    },
  };
}
