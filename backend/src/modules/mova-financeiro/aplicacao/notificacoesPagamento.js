// MOVA — 27/11: NOTIFICAÇÕES DE PAGAMENTO aos entregadores (caixa de saída persistente + aviso consolidado à gerência).
//
// Não é um segundo motor financeiro: LÊ as baixas já gravadas no Financeiro v2 (`consultarBaixasDeEntregadores`, só leitura) e
// não escreve nada lá. Fluxo de uma passada (idempotente; roda a cada ~1 min e pode rodar em duas instâncias):
//   1. DETECTAR  baixa nova (liquidação criada depois do marco da unidade, data efetiva ≤ hoje) → UM evento por entregador/baixa
//                (chave única; cada liquidação entra em um evento só). Estorno → aviso só à gerência. Sem telefone → SEM_TELEFONE.
//   2. DESPACHAR evento PENDENTE → reserva (transição condicional) → fila de saída do MOVA (mesmo enviador, mesmos tetos e
//                destinos permitidos) → acompanha o retorno do WhatsApp: ENVIADA ⇒ ENVIADO, FALHOU ⇒ FALHOU.
//   3. AVISAR    o grupo recebe UMA mensagem por baixa (pagamento + desfecho da mensagem ao entregador), nunca antes do desfecho.
// O estado financeiro nunca depende do WhatsApp: falha de envio muda só o evento. O texto sai SÓ do retrato gravado (`dados`).
// Sem a automação ENTREGADORES_PAGAMENTO ativa na unidade (e não pausada) nada é criado nem enviado; 1ª passada só fixa o marco.
import { ErroTransitorio } from "../gateway/fila.js";
import {
  ESTADO_NOTIFICACAO as E, LIMITE_DE_REENVIOS, TIPO_NOTIFICACAO as T, agruparBaixas, avisoDeEstornoNoGrupo, avisoDePagamentoNoGrupo, avisoDeReenvioNoGrupo, chaveDoAvisoDoGrupo,
  chaveDoEvento, fatosDeBaixa, gruposDeEstorno, mensagemDePagamento,
} from "../dominio/notificacaoPagamento.js";
import { criarAuxiliaresDeUnidade } from "./unidadesDoMova.js";
import { enfileiramentoDoTipo } from "../dominio/politicaEnvio.js";

export const AUTOMACAO_PAGAMENTO = "ENTREGADORES_PAGAMENTO";
const FUSO_MS = -3 * 3600 * 1000; // America/Fortaleza
const TERMINAIS_DO_ENTREGADOR = [E.ENVIADO, E.FALHOU, E.SEM_TELEFONE];
const erroCurto = (e) => String(e?.codigo ?? e?.code ?? e?.name ?? "ERRO").slice(0, 100);

/** @param {{cfg:object, porta:object, armazenamento:object, relogio?:Function, registrar?:Function, avisosNoGrupo?:object}} deps */
export function criarNotificacoesPagamento({ cfg, porta, armazenamento: a, relogio = () => new Date(), registrar = () => {}, avisosNoGrupo = {} }) {
  const { rotuloDe, grupoDaUnidade, escopoDe, unidadeDe } = criarAuxiliaresDeUnidade({ cfg, avisosNoGrupo });
  const hoje = () => new Date(relogio().getTime() + FUSO_MS).toISOString().slice(0, 10);
  const empresaDe = (id) => { const r = rotuloDe(id); return r.empresa ?? r.unidade ?? "Unidade"; };
  const entregadorDe = (unidadeId, chave) => (cfg.entregadores ?? []).find((e) => e.ativo && e.unidadeId === unidadeId && e.chave === chave) ?? null;
  const ativa = (auto) => Boolean(auto && auto.ativa && !auto.pausadaEm);
  const auditar = (acao, alvo, dados, extra = {}) => a.auditoria.registrar({ acao, atorTipo: "SISTEMA", alvo, dados, ...extra }).catch(() => {});

  /** Cria (idempotente) o aviso à gerência ligado a um evento do entregador. Chamado também na recuperação após queda. */
  async function garantirAviso(u, e, { reenvio = 0 } = {}) {
    const terminal = TERMINAIS_DO_ENTREGADOR.includes(e.estado);
    return a.pagamentos.registrar({
      chave: chaveDoAvisoDoGrupo(e.chave, reenvio), organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, entregador: e.entregador, destino: "GRUPO", tipo: T.AVISO_GRUPO,
      estado: reenvio || terminal ? E.PENDENTE : E.AGUARDANDO_ENTREGADOR, eventoPaiId: e.id, dados: { ...e.dados, tipoPagamento: e.tipo, ...(reenvio ? { reenvio: true } : {}) }, itens: [],
    });
  }

  async function criarEvento(u, g, resumo) {
    const ent = entregadorDe(u.unidadeId, g.entregador.chave);
    const chave = chaveDoEvento({ unidadeId: u.unidadeId, entregadorChave: g.entregador.chave, tipo: g.tipo, itens: g.itens });
    const base = { chave, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, entregador: g.entregador.chave, tipo: g.tipo, dados: g.dados, itens: g.itens };
    if (g.tipo === T.ESTORNO) {
      const r = await a.pagamentos.registrar({ ...base, destino: "GRUPO", estado: E.PENDENTE });
      if (r.novo) { resumo.criadas += 1; await auditar("NOTIFICACAO_PAGAMENTO_CRIADA", r.evento.id, { tipo: g.tipo, liquidacoes: g.itens.length }); }
      return;
    }
    const r = await a.pagamentos.registrar({ ...base, destino: "ENTREGADOR", estado: ent ? E.PENDENTE : E.SEM_TELEFONE });
    if (r.novo) { resumo.criadas += 1; await auditar("NOTIFICACAO_PAGAMENTO_CRIADA", r.evento.id, { tipo: g.tipo, liquidacoes: g.itens.length, semTelefone: !ent }); }
    if (r.evento) await garantirAviso(u, r.evento);
  }

  async function detectar(u, resumo) {
    const { marcoEm, novo } = await a.pagamentos.marco({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, em: relogio().toISOString() });
    if (novo) { resumo.pulados.push("MARCO_FIXADO"); await auditar("NOTIFICACAO_PAGAMENTO_MARCO", u.unidadeId, { marcoEm }); return; } // nada anterior vira mensagem
    const lida = await porta.ler("consultarBaixasDeEntregadores", escopoDe(u.unidadeId), {});
    const { baixas, estornos, agendadas, historicas } = fatosDeBaixa(lida.itens ?? [], { marcoEm, hoje: hoje() });
    resumo.agendadas += agendadas; resumo.historicas += historicas;
    const ids = [...new Set([...baixas, ...estornos].map((q) => q.liquidacaoId))];
    const registrados = await a.pagamentos.itensRegistrados(u.unidadeId, ids);
    const novasBaixas = baixas.filter((q) => !registrados.has(`${q.liquidacaoId}|BAIXA`));
    const novosEstornos = estornos.filter((q) => !registrados.has(`${q.liquidacaoId}|ESTORNO:${q.estornadoCentavos}`));
    for (const g of agruparBaixas(novasBaixas)) await criarEvento(u, g, resumo);
    for (const g of gruposDeEstorno(novosEstornos)) await criarEvento(u, g, resumo);
  }

  // 28/11: pagamento/estorno ao entregador = TRANSACIONAL crítica; aviso consolidado ao grupo = administrativa alta; reenvio = categoria REENVIO.
  const enfileirar = (destino, texto, e = null, { reenvio = false } = {}) => a.saida.enfileirar({ grupoId: destino, respostaA: null, eventoId: null, texto, simulada: true,
    ...(e ? enfileiramentoDoTipo(e.destino === "GRUPO" ? "AVISO_GRUPO" : e.tipo, { agora: relogio(), organizacaoId: e.organizacaoId ?? null, unidadeId: e.unidadeId ?? null, reenvio }) : {}) });

  /** Reserva (condicional) → enfileira → liga a mensagem. Falha ao enfileirar devolve o evento a PENDENTE. */
  async function reservarEEnviar(e, { de, destino, texto, extra = {} }) {
    const reservado = await a.pagamentos.atualizar(e.id, { de, estado: E.ENFILEIRADO, ...extra });
    if (!reservado) return false; // outra instância/passada já pegou
    let respostaId;
    try { respostaId = await enfileirar(destino, texto, e); } catch (erro) {
      await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: E.PENDENTE, ultimoErro: "ENFILEIRAR_FALHOU" });
      throw erro;
    }
    await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: E.ENFILEIRADO, respostaId });
    return true;
  }

  /** ENFILEIRADO → ENVIADO/FALHOU conforme o retorno REAL da fila de saída (Gateway). Nunca presume entrega. */
  async function sincronizar(u, e, resumo) {
    if (!e.respostaId || typeof a.saida.situacoes !== "function") return;
    const sit = (await a.saida.situacoes([e.respostaId])).get(e.respostaId);
    if (sit?.estado === "ENVIADA") {
      const novo = await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: E.ENVIADO, enviadoEm: relogio().toISOString() });
      if (novo) {
        resumo.enviadas += 1;
        if (novo.destino === "ENTREGADOR" && novo.reenvios > 0) await garantirAviso(u, novo, { reenvio: novo.reenvios });
      }
    } else if (sit?.estado === "FALHOU" || sit?.estado === "SUPRIMIDA") {
      const novo = await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: E.FALHOU, ultimoErro: String(sit.erro ?? sit.estado).slice(0, 120), tentativasEnvio: (e.tentativasEnvio ?? 0) + 1 });
      if (novo) { resumo.falhas += 1; await auditar("NOTIFICACAO_PAGAMENTO_FALHOU", e.id, { motivo: String(sit.erro ?? sit.estado).slice(0, 60) }); }
    }
  }

  function textoDoGrupo(e, desfecho) {
    const empresa = empresaDe(e.unidadeId);
    if (e.tipo === T.ESTORNO) return avisoDeEstornoNoGrupo(e.dados, { empresa });
    if (e.dados.reenvio) return avisoDeReenvioNoGrupo(e.dados, { empresa });
    return avisoDePagamentoNoGrupo(e.dados, { empresa, desfecho, parcial: e.dados.saldoRestanteCentavos > 0 });
  }

  async function despachar(u, resumo) {
    for (const e of (await a.pagamentos.emAndamento(u.unidadeId)).filter((x) => x.destino === "ENTREGADOR")) await garantirAviso(u, e); // recuperação após queda
    const escopo = { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId };
    // 1) mensagens aos entregadores
    for (const e of (await a.pagamentos.emAndamento(u.unidadeId)).filter((x) => x.destino === "ENTREGADOR")) {
      if (e.estado === E.ENFILEIRADO) { await sincronizar(u, e, resumo); continue; }
      if (e.estado !== E.PENDENTE) continue;
      const ent = entregadorDe(u.unidadeId, e.entregador);
      if (!ent) { await a.pagamentos.atualizar(e.id, { de: [E.PENDENTE], estado: E.SEM_TELEFONE }); resumo.semTelefone += 1; await auditar("NOTIFICACAO_PAGAMENTO_SEM_TELEFONE", e.id, {}); continue; }
      if (await reservarEEnviar(e, { de: [E.PENDENTE], destino: ent.privado, texto: mensagemDePagamento(e.dados, { empresa: empresaDe(u.unidadeId), nome: ent.nome ?? e.dados.entregador?.nome }) })) resumo.enfileiradas += 1;
    }
    // 2) avisos à gerência (depois do desfecho da mensagem do entregador; estorno não espera ninguém)
    for (const e of (await a.pagamentos.emAndamento(u.unidadeId)).filter((x) => x.destino === "GRUPO")) {
      if (e.estado === E.ENFILEIRADO) { await sincronizar(u, e, resumo); continue; }
      let desfecho = null;
      if (e.estado === E.AGUARDANDO_ENTREGADOR) {
        const pai = e.eventoPaiId ? await a.pagamentos.obter(e.eventoPaiId, escopo) : null;
        if (!pai || !TERMINAIS_DO_ENTREGADOR.includes(pai.estado)) continue;
        desfecho = pai.estado;
      } else if (e.estado === E.PENDENTE && e.tipo === T.AVISO_GRUPO && !e.dados.reenvio) {
        desfecho = (await a.pagamentos.obter(e.eventoPaiId, escopo))?.estado ?? E.FALHOU;
      } else if (e.estado !== E.PENDENTE) continue;
      const grupo = grupoDaUnidade(u.unidadeId);
      if (!grupo) { await a.pagamentos.atualizar(e.id, { de: [E.PENDENTE, E.AGUARDANDO_ENTREGADOR], estado: E.SEM_GRUPO }); await auditar("NOTIFICACAO_PAGAMENTO_SEM_GRUPO", e.id, {}); continue; }
      if (await reservarEEnviar(e, { de: [E.PENDENTE, E.AGUARDANDO_ENTREGADOR], destino: grupo.grupoId, texto: textoDoGrupo(e, desfecho) })) resumo.avisos += 1;
    }
  }

  /**
   * Uma passada em todas as unidades com a automação ligada. Devolve null quando nenhuma está ligada (a rotina não muda de saída).
   * Unidade com a automação desligada/pausada: o marco ACOMPANHA o tempo, para que religar não dispare o que se pagou nesse intervalo.
   */
  async function passada() {
    const resumo = { unidades: 0, criadas: 0, enfileiradas: 0, enviadas: 0, falhas: 0, avisos: 0, semTelefone: 0, agendadas: 0, historicas: 0, pulados: [] };
    let algum = false;
    for (const u of cfg.unidades) {
      const auto = await a.automacoes.obter(AUTOMACAO_PAGAMENTO, u.unidadeId);
      if (!ativa(auto)) { if (auto) await a.pagamentos.avancarMarco(u.unidadeId, relogio().toISOString()).catch(() => {}); continue; }
      algum = true; resumo.unidades += 1;
      try { await detectar(u, resumo); await despachar(u, resumo); await a.automacoes.marcarExecucao(AUTOMACAO_PAGAMENTO, u.unidadeId, relogio().toISOString()); }
      catch (e) {
        if (e instanceof ErroTransitorio) resumo.pulados.push(e.codigo);
        else { resumo.pulados.push("FALHA_NA_PASSADA"); registrar({ tipo: "MOVA_PAGAMENTO_PASSADA_FALHOU", codigo: erroCurto(e) }); }
      }
    }
    return algum ? resumo : null;
  }

  /** Reenvio MANUAL controlado (quem chama já foi autorizado pela rota): só estados terminais com falha/sem destino; no máximo LIMITE_DE_REENVIOS. */
  async function reenviar({ organizacaoId, unidadeId, eventoId, por, forcar = false }) {
    const u = unidadeDe(unidadeId);
    if (!u || u.organizacaoId !== organizacaoId) return { ok: false, motivo: "UNIDADE_DESCONHECIDA" };
    const e = await a.pagamentos.obter(eventoId, { organizacaoId, unidadeId });
    if (!e) return { ok: false, motivo: "NAO_ENCONTRADA" };
    if (e.tipo === T.ESTORNO && e.estado === E.ENVIADO) return { ok: false, motivo: "JA_ENVIADA" };
    if (e.reenvios >= LIMITE_DE_REENVIOS) return { ok: false, motivo: "LIMITE_DE_REENVIOS" };
    const orfa = e.estado === E.ENFILEIRADO && !e.respostaId;
    const elegivel = [E.FALHOU, E.SEM_TELEFONE, E.SEM_GRUPO].includes(e.estado) || (forcar && (e.estado === E.ENVIADO || orfa));
    if (!elegivel) return { ok: false, motivo: e.estado === E.ENVIADO ? "JA_ENVIADA" : "NAO_ELEGIVEL" };
    let destino, texto;
    if (e.destino === "ENTREGADOR") {
      const ent = entregadorDe(unidadeId, e.entregador);
      if (!ent) return { ok: false, motivo: "SEM_TELEFONE" };
      destino = ent.privado; texto = mensagemDePagamento(e.dados, { empresa: empresaDe(unidadeId), nome: ent.nome ?? e.dados.entregador?.nome });
    } else {
      const grupo = grupoDaUnidade(unidadeId);
      if (!grupo) return { ok: false, motivo: "SEM_GRUPO" };
      const pai = e.eventoPaiId ? await a.pagamentos.obter(e.eventoPaiId, { organizacaoId, unidadeId }) : null;
      destino = grupo.grupoId; texto = textoDoGrupo(e, pai?.estado ?? E.FALHOU);
    }
    const reservado = await a.pagamentos.atualizar(e.id, { de: [e.estado], estado: E.ENFILEIRADO, reenvios: e.reenvios + 1 });
    if (!reservado) return { ok: false, motivo: "CONCORRENCIA" };
    try { const respostaId = await enfileirar(destino, texto, e, { reenvio: true }); await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: E.ENFILEIRADO, respostaId }); }
    catch (erro) { await a.pagamentos.atualizar(e.id, { de: [E.ENFILEIRADO], estado: e.estado, ultimoErro: "ENFILEIRAR_FALHOU" }); throw erro; }
    await a.auditoria.registrar({ acao: "NOTIFICACAO_PAGAMENTO_REENVIADA", atorTipo: "USUARIO", atorRef: por ?? null, alvo: e.id, dados: { de: e.estado, reenvio: e.reenvios + 1, forcado: Boolean(forcar) } });
    return { ok: true, evento: await a.pagamentos.obter(e.id, { organizacaoId, unidadeId }) };
  }

  /** Histórico para a Central (só desta unidade); `entregador` filtra pela chave cadastrada. */
  const listar = (escopo, o = {}) => a.pagamentos.listar(escopo, o);

  return Object.freeze({ passada, reenviar, listar });
}
