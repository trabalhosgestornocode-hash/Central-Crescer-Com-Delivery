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
import { LIMITES_PADRAO, NOME_DA_PRIORIDADE, classificarPadrao, criarCircuito, decidirEnvio, esperaDaTentativa, faixaDeUso, resolverLimites } from "../dominio/politicaEnvio.js";
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
export function criarEnviadorDeRespostas({ armazenamento, enviar, habilitado = false, maxTentativas = 3, registrar = () => {}, controle = null, limitePorRodada = 5, naoAntesDe = null, destinosPermitidos = null, rele = null, maximoDeEnvios = null , maximoPorDia = null, maximoPorConversaDia = null, relogio = () => new Date(), politica = null }) {
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
  // 23/11: TETO OPERACIONAL DIÁRIO (rotina semanal com vários entregadores). Configurável (MOVA_ENVIO_MAXIMO_DIA e
  // MOVA_ENVIO_MAXIMO_POR_CONVERSA_DIA), nunca ampliado aqui, e PERSISTENTE: contado no banco desde 00h de America/Fortaleza
  // (UTC−3, sem horário de verão) — reiniciar não zera. O teto por conversa barra laço/repetição para um mesmo destino.
  // Excedente não sai: FALHOU com auditoria (o gestor vê). Independente do orçamento de IA.
  const comTetoDiario = Number.isInteger(maximoPorDia);
  const comTetoConversa = Number.isInteger(maximoPorConversaDia);
  const inicioDoDia = () => { const f = new Date(relogio().getTime() - 3 * 3600_000); return new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), 3)).toISOString(); };
  let doDia = { dia: null, entregues: 0, porConversa: new Map() };
  async function sincronizarDia() {
    if (!comTetoDiario && !comTetoConversa) return;
    const dia = inicioDoDia();
    if (doDia.dia !== dia) doDia = { dia, entregues: 0, porConversa: new Map() };
    const desde = naoAntesDe && Date.parse(naoAntesDe) > Date.parse(dia) ? naoAntesDe : dia;
    try { if (typeof armazenamento.saida.contarEnviadasDesde === "function") doDia.entregues = Math.max(doDia.entregues, await armazenamento.saida.contarEnviadasDesde(desde)); } catch { /* mantém a contagem local */ }
    try {
      if (comTetoConversa && typeof armazenamento.saida.contarEnviadasPorDestinoDesde === "function")
        for (const [k, n] of await armazenamento.saida.contarEnviadasPorDestinoDesde(desde)) doDia.porConversa.set(k, Math.max(doDia.porConversa.get(k) ?? 0, n));
    } catch { /* mantém a contagem local */ }
  }
  /** Motivo do bloqueio pelo teto do dia (ou null). */
  function bloqueioDoDia(r) {
    if (comTetoDiario && doDia.entregues >= maximoPorDia) return "TETO_DIARIO_DE_ENVIOS";
    if (comTetoConversa && (doDia.porConversa.get(r.grupoId) ?? 0) >= maximoPorConversaDia) return "TETO_DIARIO_DA_CONVERSA";
    return null;
  }
  function contarNoDia(r) { doDia.entregues += 1; doDia.porConversa.set(r.grupoId, (doDia.porConversa.get(r.grupoId) ?? 0) + 1); }
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
      if (s.estado === "ENVIADA") await armazenamento.saida.marcarEnviada(s.id, s.providerMessageId ?? null) // 24/11: sem id, fica nulo (a coluna é UNIQUE; "SEM_ID" repetido falharia);
      else if (s.estado === "INCERTA") { await armazenamento.saida.marcarFalhaDeEnvio(s.id, "ENVIO_INCERTO", { final: true }); registrar({ tipo: "MOVA_ENVIO_INCERTO" }); }
      else if (s.estado === "FALHOU" || s.estado === "CANCELADA") await armazenamento.saida.marcarFalhaDeEnvio(s.id, String(s.codigo ?? s.estado).slice(0, 60), { final: true });
    }
  }
  // 28/11: ENVIO COM POLÍTICA (fila priorizada). Com `politica` ({ regras(), avisarAdministracao?(aviso) }) o enviador deixa de FALHAR
  // mensagem por teto: ADIA (continua pendente, persistente), na ordem de prioridade, com capacidade reservada à crítica, ritmo por
  // minuto e circuit breaker valendo para TODAS as categorias, expiração só depois da validade, e alerta de uso (70/85/95%) e de
  // represamento. Sem `politica`, tudo funciona exatamente como antes (tetos legados).
  const circuito = politica ? criarCircuito({ falhasSeguidas: LIMITES_PADRAO.circuitoFalhasSeguidas, pausaSegundos: LIMITES_PADRAO.circuitoPausaSegundos }) : null;
  let regrasEmCache = { em: 0, regras: [] };
  const lerRegras = async () => {
    const agora = relogio().getTime();
    if (agora - regrasEmCache.em > 30_000) { try { regrasEmCache = { em: agora, regras: (await politica.regras()) ?? [] }; } catch { /* mantém as regras anteriores */ } }
    return regrasEmCache.regras;
  };
  const diaLocal = (d) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  async function alertar(tipo, chave, faixa, detalhe, texto, unidadeId = null) {
    let nova = false;
    try { nova = await armazenamento.alertasDeEnvio.registrar({ dia: diaLocal(relogio()), tipo, chave, faixa, detalhe }); } catch { return; }
    if (!nova) return;
    await auditar("MOVA_ENVIO_ALERTA", { tipo, chave, faixa, ...detalhe });
    try { await politica.avisarAdministracao?.({ tipo, chave, faixa, texto, unidadeId }); } catch { /* o alerta nunca impede o envio */ }
  }
  async function enviarComPolitica({ limite, destinos }) {
    const agora = relogio();
    for (const e of (await armazenamento.saida.expirarVencidas(agora)) ?? [])
      await alertar("EXPIRADA", `${e.unidadeId ?? "SEM_UNIDADE"}|${e.categoria}`, e.prioridade, { prioridade: e.prioridade, categoria: e.categoria },
        `⚠️ MOVA: uma mensagem ${e.categoria.toLowerCase()} venceu a validade sem poder ser enviada (prioridade ${NOME_DA_PRIORIDADE[e.prioridade]}). Ela ficou registrada como EXPIRADA para revisão.`, e.unidadeId);
    const regras = await lerRegras();
    const base = resolverLimites({ regras });
    const uso = await armazenamento.saida.usoDeEnvio({ desde: naoAntesDe && Date.parse(naoAntesDe) > Date.parse(inicioDoDia()) ? naoAntesDe : inicioDoDia(), agora });
    const lote = await armazenamento.saida.tomarParaEnvio({ limite: Math.min(limite, limitePorRodada), naoAntesDe, destinos, agora });
    let enviadas = 0, adiadas = 0;
    for (const r of lote) {
      const cat = classificarPadrao({ eventoId: r.eventoId, respostaA: r.respostaA, categoria: r.categoria, prioridade: r.prioridade });
      const item = { categoria: cat.categoria, prioridade: cat.prioridade, destinoTipo: String(r.grupoId).endsWith("@g.us") ? "GRUPO" : "PRIVADO" };
      const limites = resolverLimites({ regras, empresaId: r.organizacaoId ?? null, unidadeId: r.unidadeId ?? null, destino: r.grupoId, categoria: item.categoria });
      const decisao = decidirEnvio({ item, limites, agora: relogio(), circuitoAbertoAte: circuito.abertoAte,
        uso: { dia: uso.dia, porDestino: uso.porDestino.get(r.grupoId) ?? 0, ultimoMinuto: uso.ultimoMinuto, ultimoMinutoDestino: uso.ultimoMinutoPorDestino.get(r.grupoId) ?? 0, respostasHoraDestino: uso.respostasHoraPorDestino.get(r.grupoId) ?? 0 } });
      if (decisao.acao === "ADIAR") {
        await armazenamento.saida.adiar(r.id, { ate: decisao.liberarEm, motivo: decisao.motivo });
        adiadas += 1;
        if (decisao.motivo === "LIMITE_DIARIO" || decisao.motivo === "LIMITE_DA_CONVERSA")
          await alertar("REPRESAMENTO", `${decisao.motivo}|${decisao.motivo === "LIMITE_DA_CONVERSA" ? r.grupoId : "GERAL"}`, 100, { motivo: decisao.motivo, prioridade: item.prioridade },
            `⚠️ MOVA: o limite ${decisao.motivo === "LIMITE_DIARIO" ? "diário de mensagens proativas" : "da conversa"} foi atingido. As mensagens continuam na fila, em ordem de prioridade, e saem quando houver capacidade. Ajuste em Financeiro > MOVA > Limites, se necessário.`, r.unidadeId ?? null);
        if (decisao.motivo === "CIRCUITO_ABERTO") await alertar("CIRCUITO", "GATEWAY", 100, {}, "⚠️ MOVA: o envio foi pausado por falhas seguidas do Gateway do WhatsApp. As mensagens seguem na fila e saem quando o envio normalizar.", r.unidadeId ?? null);
        continue;
      }
      if (!destinos.includes(r.grupoId)) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "DESTINO_NAO_AUTORIZADO", { final: true }); registrar({ tipo: "MOVA_ENVIO_DESTINO_RECUSADO" }); continue; }
      if (controle && !(await controle.ligado("envio"))) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "ENVIO_SUSPENSO", { final: false }); continue; }
      const marcarUso = () => { if (decisao.contada) { uso.dia += 1; uso.porDestino.set(r.grupoId, (uso.porDestino.get(r.grupoId) ?? 0) + 1); } uso.ultimoMinuto += 1; uso.ultimoMinutoPorDestino.set(r.grupoId, (uso.ultimoMinutoPorDestino.get(r.grupoId) ?? 0) + 1); };
      const destino = enderecoDeEnvio(r);
      try {
        if (rele) { await rele.publicar({ id: r.id, destino, texto: r.texto }); await armazenamento.saida.marcarNoRele(r.id); }
        else { const { providerMessageId } = await enviar({ grupoId: destino, texto: r.texto, respostaA: r.respostaA, idempotencia: `mova-resposta:${r.id}` }); await armazenamento.saida.marcarEnviada(r.id, providerMessageId); }
        circuito.sucesso(); marcarUso(); enviadas += 1; entregues += 1;
      } catch (err) {
        const codigo = err?.codigo ?? err?.code ?? (rele ? "RELE_INDISPONIVEL" : "FALHA_NO_GATEWAY");
        const repetivel = rele ? true : ERROS_ANTES_DO_ENVIO.includes(codigo);
        const final = !repetivel || r.tentativas >= maxTentativas;
        await armazenamento.saida.marcarFalhaDeEnvio(r.id, String(codigo).slice(0, 60), { final, liberarEm: final ? null : new Date(relogio().getTime() + esperaDaTentativa(r.tentativas)).toISOString() });
        circuito.falha(relogio());
        registrar({ tipo: "MOVA_ENVIO_FALHOU", codigo });
      }
    }
    // Uso do dia: alerta nas faixas configuradas (70/85/95%) para o total e para cada conversa.
    const faixas = base.alertaFaixas;
    const f = faixaDeUso(uso.dia, base.proativasDia, faixas);
    if (f.faixa) await alertar("USO_DIARIO", "GERAL", f.faixa, { usado: uso.dia, limite: base.proativasDia, pct: f.pct }, `📊 MOVA: ${f.pct}% do limite diário de mensagens proativas foi usado (${uso.dia} de ${base.proativasDia}).`);
    for (const [destinoJid, n] of uso.porDestino) {
      const tipoDestino = String(destinoJid).endsWith("@g.us") ? base.proativasPorGrupoDia : base.proativasPorPrivadoDia;
      const fc = faixaDeUso(n, tipoDestino, faixas);
      if (fc.faixa) await alertar("USO_CONVERSA", destinoJid, fc.faixa, { usado: n, limite: tipoDestino, pct: fc.pct }, `📊 MOVA: ${fc.pct}% do limite diário desta conversa foi usado (${n} de ${tipoDestino}).`);
    }
    return { enviadas, adiadas, desligado: false, politica: true };
  }

  // 15A (Fase D): habilitado EXIGE marco de ativação e lista fechada de destinos — sem eles, o enviador fica desligado
  // (nunca "envia tudo o que está pendente" desde o início da homologação).
  const marcoValido = typeof naoAntesDe === "string" && !Number.isNaN(Date.parse(naoAntesDe));
  // 23/11: `destinosPermitidos` pode ser uma FUNÇÃO (lista viva: cadastro de entregador sem reinício). É lida a cada lote;
  // lista vazia ⇒ nada sai. O número antigo de um entregador sai da lista no ato da troca.
  const dinamico = typeof destinosPermitidos === "function";
  const lerDestinos = () => { const l = dinamico ? destinosPermitidos() : destinosPermitidos; return Array.isArray(l) && l.length > 0 ? [...l] : null; };
  const destinosIniciais = lerDestinos();
  const ativo = habilitado && marcoValido && (dinamico || destinosIniciais !== null);
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
      await sincronizarDia();
      const destinos = lerDestinos();
      if (!destinos) return { enviadas: 0, desligado: false, semDestinos: true };
      if (politica) return enviarComPolitica({ limite, destinos });
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
        const doDiaBloqueio = bloqueioDoDia(r);
        if (doDiaBloqueio) {
          await armazenamento.saida.marcarFalhaDeEnvio(r.id, doDiaBloqueio, { final: true });
          await auditar("MOVA_ENVIO_BLOQUEADO_PELO_TETO_DIARIO", { resposta: r.id, motivo: doDiaBloqueio, maximoDia: maximoPorDia, maximoPorConversa: maximoPorConversaDia });
          continue;
        }
        // Segunda barreira (além do filtro no banco): destino fora da lista nunca vai ao Gateway.
        if (!destinos.includes(r.grupoId)) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "DESTINO_NAO_AUTORIZADO", { final: true }); registrar({ tipo: "MOVA_ENVIO_DESTINO_RECUSADO" }); continue; }
        // Suspensão imediata: o interruptor é relido a cada mensagem, não só no início do lote.
        if (controle && !(await controle.ligado("envio"))) { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "ENVIO_SUSPENSO", { final: false }); continue; }
        // 15H (H-2): a AUTORIZAÇÃO é pelo JID cadastrado (acima); o ENDEREÇO é o JID com que o WhatsApp entregou a mensagem
        // respondida, quando for o MESMO celular (nono dígito). O Gateway compara com a identidade verificada pelo WhatsApp.
        const destino = enderecoDeEnvio(r);
        if (rele) {
          try { await rele.publicar({ id: r.id, destino, texto: comAvisoDoTeto(r.texto) }); await armazenamento.saida.marcarNoRele(r.id); enviadas += 1; entregues += 1; contarNoDia(r); await depoisDeEntregar(); }
          catch { await armazenamento.saida.marcarFalhaDeEnvio(r.id, "RELE_INDISPONIVEL", { final: r.tentativas >= maxTentativas }); registrar({ tipo: "MOVA_RELE_INDISPONIVEL" }); }
          continue;
        }
        try {
          const { providerMessageId } = await enviar({ grupoId: destino, texto: comAvisoDoTeto(r.texto), respostaA: r.respostaA, idempotencia: `mova-resposta:${r.id}` });
          await armazenamento.saida.marcarEnviada(r.id, providerMessageId);
          entregues += 1;
          contarNoDia(r);
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
