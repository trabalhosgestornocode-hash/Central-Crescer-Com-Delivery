// WORKER do MOVA — processa a fila de forma contínua e envia as respostas pendentes.
//
// - Concorrência controlada: N laços; a fila (lease + `for update skip locked`) garante que dois laços/processos nunca peguem
//   o mesmo evento; item de processo que caiu volta quando o lease vence (recuperação após reinício).
// - Falhas: transitórias voltam com espera crescente; esgotadas vão para FALHOU (visível no Centro Financeiro, reprocessável).
// - Estado observável: `estado()` (rodando, rodadas, processados, última falha por CÓDIGO — nunca conteúdo).
// - Respostas: o ENVIADOR é separado e tem chave própria. Desligado, as respostas ficam PENDENTE (nada sai).
//   Ligado, cada resposta é tomada com lease, enviada pelo Gateway existente (rota de envio do MOVA, mesmo socket) e marcada
//   ENVIADA com o id do provedor — o eco dessa mensagem é reconhecido e ignorado (sem laço). Falha: tenta de novo até o teto.

import { mesmoCelularBr } from "../dominio/configuracao.js";
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
/** Erros que garantem que a mensagem NÃO saiu (seguro repetir). Qualquer outro código ⇒ sem nova tentativa automática. */
export const ERROS_ANTES_DO_ENVIO = Object.freeze(["GATEWAY_INALCANCAVEL", "WHATSAPP_GATEWAY_NOT_CONNECTED", "GATEWAY_429"]);

/**
 * 15H (H-2): endereço de envio. Conversa privada cadastrada com o nono dígito e mensagem entregue pelo WhatsApp sem ele ⇒
 * responde no JID que o WhatsApp usou (o mesmo celular). Qualquer outro caso (grupo, sem evento, celular diferente) ⇒ o JID
 * cadastrado. Nunca troca para um contato diferente: só a variante com/sem nono dígito do MESMO número.
 */
export function enderecoDeEnvio(r) {
  const original = r?.participanteOriginal ?? null;
  if (original && original !== r.grupoId && mesmoCelularBr(original, r.grupoId)) return original;
  return r.grupoId;
}
export function criarEnviadorDeRespostas({ armazenamento, enviar, habilitado = false, maxTentativas = 3, registrar = () => {}, controle = null, limitePorRodada = 5, naoAntesDe = null, destinosPermitidos = null, rele = null, maximoDeEnvios = null }) {
  // 15I: teto de respostas entregues ao transporte NESTE processo (teste controlado: 1). Atingido, nada mais sai até reiniciar.
  let entregues = 0;
  const tetoAtingido = () => Number.isInteger(maximoDeEnvios) && entregues >= maximoDeEnvios;
  // 15B: com `rele` (criarSaidaPeloRele), o envio é ASSÍNCRONO: publica na fila do relé (id estável = id da resposta) e o
  // Gateway (serviço privado) busca, envia e confirma lá. O resultado volta por `sincronizar`.
  let releLigado = null;
  async function sincronizarRele(ligado) {
    if (releLigado !== ligado) { await rele.definir(ligado, "backend-mova"); releLigado = ligado; } // suspensão chega ao relé
    const aguardando = await armazenamento.saida.aguardandoRele();
    if (!aguardando.length) return;
    for (const s of await rele.estados(aguardando)) {
      if (s.estado === "ENVIADA") await armazenamento.saida.marcarEnviada(s.id, s.providerMessageId ?? "SEM_ID");
      else if (s.estado === "INCERTA") { await armazenamento.saida.marcarFalhaDeEnvio(s.id, "ENVIO_INCERTO", { final: true }); registrar({ tipo: "MOVA_ENVIO_INCERTO" }); }
      else if (s.estado === "FALHOU" || s.estado === "CANCELADA") await armazenamento.saida.marcarFalhaDeEnvio(s.id, String(s.codigo ?? s.estado).slice(0, 60), { final: true });
    }
  }
  // 15A (Fase D): habilitado EXIGE marco de ativação e lista fechada de destinos — sem eles, o enviador fica desligado
  // (nunca "envia tudo o que está pendente" desde o início da homologação).
  const marcoValido = typeof naoAntesDe === "string" && !Number.isNaN(Date.parse(naoAntesDe));
  const destinos = Array.isArray(destinosPermitidos) && destinosPermitidos.length > 0 ? [...destinosPermitidos] : null;
  const ativo = habilitado && marcoValido && destinos !== null;
  if (habilitado && !ativo) registrar({ tipo: "MOVA_ENVIO_RECUSADO_SEM_MARCO_OU_DESTINOS" });
  return Object.freeze({
    habilitado: ativo,
    /** Envia o que estiver pendente. Desligado: não toca em nada (as respostas ficam PENDENTE). */
    async enviarPendentes({ limite = 10 } = {}) {
      if (!ativo) return { enviadas: 0, desligado: true };
      const envioLigado = controle ? await controle.ligado("envio") : true;
      if (rele) await sincronizarRele(envioLigado);
      if (!envioLigado) return { enviadas: 0, desligado: true }; // interruptor em tempo real
      if (tetoAtingido()) return { enviadas: 0, desligado: false, teto: true };
      const lote = await armazenamento.saida.tomarParaEnvio({ limite: Math.min(limite, limitePorRodada), naoAntesDe, destinos }); // limite de taxa
      let enviadas = 0;
      for (const r of lote) {
        // 15I: teto da sessão atingido ⇒ a resposta excedente NÃO sai (FALHOU, visível para revisão).
        if (tetoAtingido()) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "TETO_DE_ENVIOS_DA_SESSAO", { final: true }); registrar({ tipo: "MOVA_ENVIO_TETO" }); continue; }
        // Segunda barreira (além do filtro no banco): destino fora da lista nunca vai ao Gateway.
        if (!destinos.includes(r.grupoId)) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "DESTINO_NAO_AUTORIZADO", { final: true }); registrar({ tipo: "MOVA_ENVIO_DESTINO_RECUSADO" }); continue; }
        // Suspensão imediata: o interruptor é relido a cada mensagem, não só no início do lote.
        if (controle && !(await controle.ligado("envio"))) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "ENVIO_SUSPENSO", { final: false }); continue; }
        // 15H (H-2): a AUTORIZAÇÃO é pelo JID cadastrado (acima); o ENDEREÇO é o JID com que o WhatsApp entregou a mensagem
        // respondida, quando for o MESMO celular (nono dígito). O Gateway compara com a identidade verificada pelo WhatsApp.
        const destino = enderecoDeEnvio(r);
        if (rele) {
          try { await rele.publicar({ id: r.id, destino, texto: r.texto }); await armazenamento.saida.marcarNoRele(r.id); enviadas += 1; entregues += 1; }
          catch { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "RELE_INDISPONIVEL", { final: r.tentativas >= maxTentativas }); registrar({ tipo: "MOVA_RELE_INDISPONIVEL" }); }
          continue;
        }
        try {
          const { providerMessageId } = await enviar({ grupoId: destino, texto: r.texto, respostaA: r.respostaA, idempotencia: `mova-resposta:${r.id}` });
          await armazenamento.saida.marcarEnviada(r.id, providerMessageId);
          entregues += 1;
          enviadas += 1;
        } catch (err) {
          const codigo = err?.codigo ?? err?.code ?? "FALHA_NO_GATEWAY";
          // 15A (G-1): só repete o que comprovadamente não foi enviado; incerto/recusado vira FALHOU (revisão humana) — nunca duplica.
          const repetivel = ERROS_ANTES_DO_ENVIO.includes(codigo);
          await armazenamento.saida.marcarFalhaDeEnvio(r.id, String(codigo).slice(0, 60), { final: !repetivel || r.tentativas >= maxTentativas });
          registrar({ tipo: "MOVA_ENVIO_FALHOU", codigo });
        }
      }
      return { enviadas, desligado: false };
    },
  });
}
