// WORKER do MOVA — processa a fila de forma contínua e envia as respostas pendentes.
//
// - Concorrência controlada: N laços; a fila (lease + `for update skip locked`) garante que dois laços/processos nunca peguem
//   o mesmo evento; item de processo que caiu volta quando o lease vence (recuperação após reinício).
// - Falhas: transitórias voltam com espera crescente; esgotadas vão para FALHOU (visível no Centro Financeiro, reprocessável).
// - Estado observável: `estado()` (rodando, rodadas, processados, última falha por CÓDIGO — nunca conteúdo).
// - Respostas: o ENVIADOR é separado e tem chave própria. Desligado, as respostas ficam PENDENTE (nada sai).
//   Ligado, cada resposta é tomada com lease, enviada pelo Gateway existente (rota de envio do MOVA, mesmo socket) e marcada
//   ENVIADA com o id do provedor — o eco dessa mensagem é reconhecido e ignorado (sem laço). Falha: tenta de novo até o teto.

/**
 * @param {{receptor:{trabalhar:Function}, concorrencia?:number, intervaloMs?:number, agendar?:Function, cancelar?:Function, registrar?:Function}} deps
 */
export function criarWorker({ receptor, concorrencia = 2, intervaloMs = 2000, agendar = setTimeout, cancelar = clearTimeout, registrar = () => {} }) {
  const e = { rodando: false, rodadas: 0, processados: 0, ultimaFalha: null, ultimaRodadaEm: null };
  const timers = new Set();
  async function rodada() {
    try {
      const n = await receptor.trabalhar();
      e.processados += n; e.rodadas += 1; e.ultimaRodadaEm = new Date().toISOString();
    } catch (err) {
      e.ultimaFalha = err?.codigo ?? "FALHA_NA_RODADA"; // banco fora etc.: tenta na próxima rodada
      registrar({ tipo: "MOVA_WORKER_FALHA", codigo: e.ultimaFalha });
    }
  }
  function laco() {
    if (!e.rodando) return;
    const t = agendar(async () => { timers.delete(t); await rodada(); laco(); }, intervaloMs);
    timers.add(t);
  }
  return Object.freeze({
    iniciar() { if (e.rodando) return; e.rodando = true; for (let i = 0; i < concorrencia; i++) laco(); },
    parar() { e.rodando = false; for (const t of timers) cancelar(t); timers.clear(); },
    rodada,
    estado: () => ({ ...e }),
  });
}

/**
 * @param {{armazenamento:object, enviar:(r:{grupoId:string, texto:string, respostaA:string|null, idempotencia:string}) => Promise<{providerMessageId:string}>,
 *          habilitado?:boolean, maxTentativas?:number, registrar?:Function}} deps
 */
export function criarEnviadorDeRespostas({ armazenamento, enviar, habilitado = false, maxTentativas = 3, registrar = () => {} }) {
  return Object.freeze({
    habilitado,
    /** Envia o que estiver pendente. Desligado: não toca em nada (as respostas ficam PENDENTE). */
    async enviarPendentes({ limite = 10 } = {}) {
      if (!habilitado) return { enviadas: 0, desligado: true };
      const lote = await armazenamento.saida.tomarParaEnvio({ limite });
      let enviadas = 0;
      for (const r of lote) {
        try {
          const { providerMessageId } = await enviar({ grupoId: r.grupoId, texto: r.texto, respostaA: r.respostaA, idempotencia: `mova-resposta:${r.id}` });
          await armazenamento.saida.marcarEnviada(r.id, providerMessageId);
          enviadas += 1;
        } catch (err) {
          const codigo = err?.codigo ?? err?.code ?? "FALHA_NO_GATEWAY";
          await armazenamento.saida.marcarFalhaDeEnvio(r.id, String(codigo).slice(0, 60), { final: r.tentativas >= maxTentativas });
          registrar({ tipo: "MOVA_ENVIO_FALHOU", codigo });
        }
      }
      return { enviadas, desligado: false };
    },
  });
}
