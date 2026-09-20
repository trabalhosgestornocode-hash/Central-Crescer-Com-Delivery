// (fora de test/ de propósito: `node --test test/` executaria este arquivo como se fosse um teste)
// C.9.5 — servidor de FILA OFFLINE falso: o suficiente do protocolo para exercitar o fluxo offline do Baileys REAL
// (socket real → servidor WebSocket LOCAL; criptografia real; pares fictícios; NENHUMA rede externa):
//
//   servidor → cliente : ib/offline_preview                       (o Baileys responde sozinho com ib/offline_batch count=100)
//   cliente  → servidor: ib/offline_batch count=N                 (observado no fio: é o quadro que o Baileys REALMENTE envia)
//   servidor → cliente : até N nós offline (message …)            (entregues como rajada, como o servidor faz)
//   servidor → cliente : ib/offline count=total  (marcador de fim) (só conforme a política)
//
// ATENÇÃO: o comportamento do servidor REAL do WhatsApp é DESCONHECIDO. Cada `politica` abaixo é um MODELO (hipótese) do servidor.
// O que estes testes provam é o comportamento do CLIENTE (Baileys) diante desse modelo — nunca o do servidor.
//
//   politica "fim_ao_esgotar" — entrega N nós por `offline_batch` recebido e, quando a fila esgota, envia o marcador de fim.
//   politica "nunca_envia_fim" — entrega N nós por `offline_batch` recebido e NUNCA envia o marcador (nem ao esgotar).
export function criarServidorOfflineFalso({ gw, nos, politica = "fim_ao_esgotar", atributosPreview = {} }) {
  const restante = [...nos];
  const total = nos.length;
  const estado = {
    politica, total,
    batches: [],            // { count, tMs } — os offline_batch que o CLIENTE realmente enviou (decodificados do fio)
    nosEntregues: 0,
    fimEnviado: false,
    previewEnviado: false,
    t0: null,
  };
  const t = () => (estado.t0 == null ? 0 : Date.now() - estado.t0);
  const esperas = [];       // resoluções pendentes de aguardarBatches()

  function entregar(n) {
    const lote = restante.splice(0, n);
    for (const no of lote) { gw.sock.ws.emit("CB:message", no); estado.nosEntregues++; }
    if (restante.length === 0 && politica === "fim_ao_esgotar" && !estado.fimEnviado) { estado.fimEnviado = true; gw.emitirOfflineFim(estado.nosEntregues); }
  }

  gw.aoNoDoCliente((no) => {
    if (no?.tag !== "ib" || !Array.isArray(no.content)) return;
    const b = no.content.find((c) => c?.tag === "offline_batch");
    if (!b) return;
    const count = Number(b.attrs?.count);
    estado.batches.push({ count, tMs: t() });
    entregar(Number.isFinite(count) ? count : 0);
    for (const e of [...esperas]) if (estado.batches.length >= e.n) { esperas.splice(esperas.indexOf(e), 1); e.resolver(); }
  });

  return {
    estado,
    /** o servidor anuncia a fila offline; o Baileys responde sozinho com o offline_batch (se o código o fizer). */
    iniciar() {
      estado.t0 = Date.now(); estado.previewEnviado = true;
      gw.sock.ws.emit("CB:ib,,offline_preview", { tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs: { count: String(total), message: String(total), notification: "0", receipt: "0", appdata: "0", ...atributosPreview } }] });
    },
    /** espera o cliente ter enviado n offline_batch (ou estoura o timeout, devolvendo false). */
    aguardarBatches(n, timeoutMs = 3000) {
      if (estado.batches.length >= n) return Promise.resolve(true);
      return new Promise((resolver) => {
        const e = { n, resolver: () => resolver(true) };
        esperas.push(e);
        setTimeout(() => { const i = esperas.indexOf(e); if (i >= 0) { esperas.splice(i, 1); resolver(false); } }, timeoutMs);
      });
    },
    restante: () => restante.length,
  };
}

/**
 * Gera `quantidade` stanzas de mensagem DIRETA decifráveis (criptografia real) espalhadas por `pares` remetentes fictícios.
 * O attrs.offline sai "1" (padrão do harness).
 */
export async function gerarMensagensOffline(gw, quantidade, { pares = 20, prefixo = "55118888" } = {}) {
  const peers = [];
  for (let i = 0; i < pares; i++) peers.push(await gw.criarPar(`${prefixo}${String(i + 1).padStart(5, "0")}@s.whatsapp.net`));
  const nos = [];
  for (let i = 0; i < quantidade; i++) nos.push(await gw.mensagemDireta(peers[i % pares], `m${i}`));
  return nos;
}
