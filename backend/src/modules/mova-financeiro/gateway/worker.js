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
/** Quantas respostas antes do teto passam a avisar no próprio texto (e a 1ª delas gera auditoria). */
export const AVISO_TETO = 3;
export function criarEnviadorDeRespostas({ armazenamento, enviar, habilitado = false, maxTentativas = 3, registrar = () => {}, controle = null, limitePorRodada = 5, naoAntesDe = null, destinosPermitidos = null, rele = null, maximoDeEnvios = null }) {
  // 15I: teto de respostas entregues ao transporte. Agente 2: a contagem é PERSISTENTE (respostas enviadas desde o marco, no
  // banco), então reiniciar ou publicar não zera o teto. Perto do fim, a própria resposta avisa no grupo e fica na auditoria;
  // atingido, a resposta excedente não sai (FALHOU, com auditoria). O teto nunca é ampliado aqui.
  let entregues = 0;
  const comTeto = Number.isInteger(maximoDeEnvios);
  const tetoAtingido = () => comTeto && entregues >= maximoDeEnvios;
  async function sincronizarTeto() {
    if (!comTeto || typeof armazenamento.saida.contarEnviadasDesde !== "function") return;
    try { entregues = Math.max(entregues, await armazenamento.saida.contarEnviadasDesde(naoAntesDe)); } catch { /* sem leitura: mantém a contagem local */ }
  }
  const auditar = async (acao, dados) => {
    registrar({ tipo: acao, ...dados });
    try { await armazenamento.auditoria?.registrar?.({ acao, atorTipo: "SISTEMA", atorRef: "mova-enviador", alvo: "resposta", dados }); } catch { /* auditoria nunca impede o envio */ }
  };
  /** Texto com o aviso do teto: as últimas AVISO_TETO respostas dizem quantas restam; a última diz que o limite foi atingido. */
  function comAvisoDoTeto(texto) {
    if (!comTeto) return texto;
    const restantes = maximoDeEnvios - (entregues + 1);
    if (restantes === 0) return `${texto}\n\n⚠️ Limite de respostas do MOVA atingido (${maximoDeEnvios} de ${maximoDeEnvios}). Novas perguntas ficam sem resposta até o gestor liberar.`;
    if (restantes > 0 && restantes <= AVISO_TETO) return `${texto}\n\nAviso: restam ${restantes} resposta${restantes === 1 ? "" : "s"} do MOVA antes do limite configurado.`;
    return texto;
  }
  async function depoisDeEntregar() {
    const restantes = maximoDeEnvios - entregues;
    if (!comTeto) return;
    if (restantes === AVISO_TETO) await auditar("MOVA_ENVIO_TETO_PROXIMO", { enviadas: entregues, maximo: maximoDeEnvios });
    if (restantes === 0) await auditar("MOVA_ENVIO_TETO_ATINGIDO", { enviadas: entregues, maximo: maximoDeEnvios });
  }
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
      await sincronizarTeto();
      if (tetoAtingido()) {
        // Atingido: as pendentes não ficam esperando em silêncio — cada uma vira FALHOU com auditoria (gestor vê o motivo).
        for (const r of await armazenamento.saida.tomarParaEnvio({ limite: Math.min(limite, limitePorRodada), naoAntesDe, destinos })) {
          await armazenamento.saida.marcarFalhaDeEnvio(r.id, "TETO_DE_ENVIOS_DA_SESSAO", { final: true });
          await auditar("MOVA_ENVIO_BLOQUEADO_PELO_TETO", { resposta: r.id, maximo: maximoDeEnvios });
        }
        return { enviadas: 0, desligado: false, teto: true };
      }
      const lote = await armazenamento.saida.tomarParaEnvio({ limite: Math.min(limite, limitePorRodada), naoAntesDe, destinos }); // limite de taxa
      let enviadas = 0;
      for (const r of lote) {
        // 15I: teto da sessão atingido ⇒ a resposta excedente NÃO sai (FALHOU, visível para revisão).
        if (tetoAtingido()) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "TETO_DE_ENVIOS_DA_SESSAO", { final: true }); await auditar("MOVA_ENVIO_BLOQUEADO_PELO_TETO", { resposta: r.id, maximo: maximoDeEnvios }); continue; }
        // Segunda barreira (além do filtro no banco): destino fora da lista nunca vai ao Gateway.
        if (!destinos.includes(r.grupoId)) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "DESTINO_NAO_AUTORIZADO", { final: true }); registrar({ tipo: "MOVA_ENVIO_DESTINO_RECUSADO" }); continue; }
        // Suspensão imediata: o interruptor é relido a cada mensagem, não só no início do lote.
        if (controle && !(await controle.ligado("envio"))) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "ENVIO_SUSPENSO", { final: false }); continue; }
        // 15H (H-2): a AUTORIZAÇÃO é pelo JID cadastrado (acima); o ENDEREÇO é o JID com que o WhatsApp entregou a mensagem
        // respondida, quando for o MESMO celular (nono dígito). O Gateway compara com a identidade verificada pelo WhatsApp.
        const destino = enderecoDeEnvio(r);
        if (rele) {
          try { await rele.publicar({ id: r.id, destino, texto: comAvisoDoTeto(r.texto) }); await armazenamento.saida.marcarNoRele(r.id); enviadas += 1; entregues += 1; await depoisDeEntregar(); }
          catch { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "RELE_INDISPONIVEL", { final: r.tentativas >= maxTentativas }); registrar({ tipo: "MOVA_RELE_INDISPONIVEL" }); }
          continue;
        }
        try {
          const { providerMessageId } = await enviar({ grupoId: destino, texto: comAvisoDoTeto(r.texto), respostaA: r.respostaA, idempotencia: `mova-resposta:${r.id}` });
          await armazenamento.saida.marcarEnviada(r.id, providerMessageId);
          entregues += 1;
          enviadas += 1;
          await depoisDeEntregar();
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
