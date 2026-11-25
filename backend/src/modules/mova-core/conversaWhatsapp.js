// MOVA CORE — ADAPTADOR ao pipeline do WhatsApp (motor atual do MOVA). Usado pelo motor em `processar`, só para TEXTO na conversa
// PRIVADA de quem está na LISTA autorizada, numa unidade do piloto. Tudo o resto (grupo, documento, pendência, entregador,
// unidade fora do piloto) continua no motor atual, que também é o fallback de qualquer falha do núcleo.
//
//   * Identidade: a da LISTA (a mesma que o motor atual usa) + o perfil de CADA unidade; se o serviço de vínculo for injetado,
//     a pessoa precisa estar vinculada AGORA e a unidade precisa estar no perfil da plataforma (interseção, nunca soma).
//   * Leitura: a porta do MOVA (lista fechada de leituras), embrulhada em `portaSomenteLeitura`; identidade de serviço.
//   * Modos: SOMBRA = roda, registra e NÃO responde (o motor atual responde); RESPOSTA = a resposta conferida do núcleo sai.
//   * Escrita: nenhuma. O núcleo é montado SEM operações (preparar/confirmar não existem nesta montagem).
import { CAPACIDADES, perfilNa } from "../mova-financeiro/dominio/participantes.js";
import { RESULTADO_UNIDADE, resolverUnidade } from "../mova-financeiro/dominio/unidade.js";

export const MODO_CONVERSA = Object.freeze({ DESLIGADO: "DESLIGADO", SOMBRA: "SOMBRA", RESPOSTA: "RESPOSTA" });
/** Desfechos do núcleo que NÃO viram resposta: o motor atual trata (ele responde 'IA pausada' etc. pelo próprio caminho). */
const SEM_RESPOSTA = new Set(["IA_INDISPONIVEL", "ORCAMENTO_INDISPONIVEL", "ORCAMENTO_MENSAL_ESGOTADO", "ORCAMENTO_DIARIO_ESGOTADO", "ORCAMENTO_REQUISICAO_ESGOTADO", "ORCAMENTO_CHAMADAS_ESGOTADAS", "IA_RECUSOU"]);
const ehPrivada = (grupo, grupoId) => Boolean(grupo?.privada || grupo?.derivada) || /@s\.whatsapp\.net$/.test(String(grupoId ?? ""));
const hojeEm = (agora, fuso) => new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);

/** Lê o modo e as unidades do piloto do ambiente (sempre por parâmetro). Inválido = DESLIGADO (falha segura). */
export function configuracaoDaConversa(env = {}) {
  const modo = String(env.MOVA_CORE_CONVERSA ?? "").toUpperCase() || MODO_CONVERSA.DESLIGADO;
  const unidades = String(env.MOVA_CORE_CONVERSA_UNIDADES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!Object.values(MODO_CONVERSA).includes(modo)) return { modo: MODO_CONVERSA.DESLIGADO, motivo: "MODO_INVALIDO", unidades: [] };
  if (modo !== MODO_CONVERSA.DESLIGADO && !unidades.length) return { modo: MODO_CONVERSA.DESLIGADO, motivo: "SEM_UNIDADES_DO_PILOTO", unidades: [] };
  return { modo, unidades, exigirVinculo: env.MOVA_CORE_EXIGIR_VINCULO === "1", motivo: null };
}

/**
 * @param {{ core:object, cfg:object, modo:string, unidadesDoPiloto:string[], identidadeServico:string, identidade?:object,
 *           exigirVinculo?:boolean, registrar?:Function, relogio?:() => Date, fuso?:string }} deps
 */
export function criarConversaWhatsapp({ core, cfg, modo, unidadesDoPiloto, identidadeServico, identidade = null, exigirVinculo = false, registrar = () => {}, relogio = () => new Date(), fuso = "America/Fortaleza" }) {
  if (!core?.responder) throw new TypeError("conversa exige o núcleo do MOVA CORE");
  if (!Object.values(MODO_CONVERSA).includes(modo) || modo === MODO_CONVERSA.DESLIGADO) throw new TypeError("conversa só é montada em SOMBRA ou RESPOSTA");
  if (!identidadeServico) throw new TypeError("conversa exige a identidade de serviço das leituras");
  const piloto = new Set((unidadesDoPiloto ?? []).map((x) => String(x).toLowerCase()));
  if (!piloto.size) throw new TypeError("conversa exige as unidades do piloto");
  if (exigirVinculo && !identidade?.resolver) throw new TypeError("vínculo exigido sem o serviço de identidade");
  const ultimaUnidade = new Map(); // conversa|pessoa → unidade da última resposta (só conveniência; a permissão é recalculada a cada mensagem)

  /** Unidades que ESTA pessoa alcança nesta conversa (lista ∩ piloto ∩ plataforma), com o perfil de cada uma. */
  async function alcance(evento, grupo, participante) {
    let unidades = (participante.aberto ? grupo.unidades : participante.unidades).filter((u) => piloto.has(u));
    let vinculo = null;
    if (identidade?.resolver) {
      try { vinculo = await identidade.resolver({ grupoId: evento.grupoId, participanteId: evento.participanteId }); } catch { vinculo = { vinculado: false, motivo: "IDENTIDADE_INDISPONIVEL" }; }
      if (vinculo?.vinculado) { const daPlataforma = vinculo.usuario?.unidades ?? []; if (daPlataforma.length) unidades = unidades.filter((u) => daPlataforma.includes(u)); }
      else if (exigirVinculo) return { unidades: [], motivo: vinculo?.motivo ?? "SEM_VINCULO" };
    }
    return { unidades: unidades.map((u) => ({ u, perfil: perfilNa(participante, u) })).filter((x) => CAPACIDADES[x.perfil]), vinculo };
  }

  function escolherUnidade(evento, permitidas, chave) {
    const grupoDaPessoa = { unidades: permitidas.map((x) => x.u) };
    const r = resolverUnidade({ cfg, grupo: grupoDaPessoa, textos: [evento.texto] });
    if (r.resultado === RESULTADO_UNIDADE.IDENTIFICADA && r.unidade && grupoDaPessoa.unidades.includes(r.unidade.unidadeId)) return r.unidade.unidadeId;
    const anterior = ultimaUnidade.get(chave);
    if (anterior && grupoDaPessoa.unidades.includes(anterior)) return anterior;
    return permitidas[0].u;
  }

  /**
   * @returns {Promise<null | {texto:string, motivo:string, requisicaoId:string, ferramentas:string[], custoMicrousd:number, latenciaMs:number}>}
   *   null = o motor atual trata (fora do escopo do núcleo, modo SOMBRA, ou falha).
   */
  async function atender({ evento, grupo, participante }) {
    if (evento.tipo !== "TEXTO" || evento.midia || !String(evento.texto ?? "").trim()) return null;
    if (!ehPrivada(grupo, evento.grupoId)) return null; // 1ª versão: só conversa privada (valores nunca vão a grupo pelo núcleo)
    const a = await alcance(evento, grupo, participante);
    if (!a.unidades.length) { registrar({ tipo: "MOVA_CORE_CONVERSA_FORA", motivo: a.motivo ?? "SEM_UNIDADE_DO_PILOTO" }); return null; }
    const chave = `${evento.grupoId}|${evento.participanteId}`;
    const unidadeId = escolherUnidade(evento, a.unidades, chave);
    const daUnidade = cfg.unidades.find((u) => u.unidadeId === unidadeId);
    const perfil = a.unidades.find((x) => x.u === unidadeId).perfil;
    const consultas = CAPACIDADES[perfil].consultas;
    // nunca soma poder: só entram as unidades da MESMA empresa e com a MESMA capacidade de consulta que a da conversa
    const mesmas = a.unidades.filter((x) => cfg.unidades.find((u) => u.unidadeId === x.u)?.organizacaoId === daUnidade.organizacaoId && CAPACIDADES[x.perfil].consultas === consultas);
    const entrada = {
      organizacaoId: daUnidade.organizacaoId, conversaId: evento.grupoId, participanteId: evento.participanteId, usuarioId: identidadeServico,
      unidadeId, unidadesPermitidas: mesmas.map((x) => ({ id: x.u, nome: cfg.unidades.find((u) => u.unidadeId === x.u).nome })),
      perfil: { nome: perfil, consultas }, podeValores: consultas === "TODAS", texto: String(evento.texto).slice(0, 2000),
      hoje: hojeEm(relogio(), fuso), requisicaoId: `mova-core-${evento.eventoId}`, temAnexo: false, pendenciaAberta: false,
    };
    let r;
    try { r = await core.responder(entrada); }
    catch (e) { registrar({ tipo: "MOVA_CORE_CONVERSA_FALHOU", erro: String(e?.message ?? e).slice(0, 200) }); return null; }
    const resumo = { requisicaoId: r.requisicaoId, motivo: r.motivo, rota: r.rota, ferramentas: (r.ferramentas ?? []).map((f) => f.nome), custoMicrousd: r.uso?.custoMicrousd ?? 0, latenciaMs: r.latenciaMs ?? 0 };
    if (modo === MODO_CONVERSA.SOMBRA) { registrar({ tipo: "MOVA_CORE_SOMBRA", ...resumo, respondeu: Boolean(r.texto), mensagensExtras: (r.blocos ?? []).length }); return null; }
    if (!r.texto || SEM_RESPOSTA.has(r.motivo)) { registrar({ tipo: "MOVA_CORE_CONVERSA_DEVOLVIDA", ...resumo }); return null; }
    ultimaUnidade.set(chave, unidadeId);
    // 25/11: lista montada pelo SERVIDOR (ex.: todas as contas) segue em mensagens próprias, depois da resposta do modelo
    return { texto: r.texto, blocos: (r.blocos ?? []).slice(0, MAX_MENSAGENS_EXTRAS), unidadeId, organizacaoId: daUnidade.organizacaoId, ...resumo };
  }
  return Object.freeze({ modo, atender });
}

/**
 * Orçamento do núcleo por cima do orçamento REAL do MOVA (o mesmo de produção): o cliente da IA já passa por
 * `clienteComOrcamento` (reserva/conclusão persistentes, controle 'ia' e teto total). Aqui fica só o limite POR MENSAGEM
 * (passos e custo de uma requisição), em memória — nunca substitui o persistente.
 */
/** No máximo 6 mensagens extras por pergunta (lista longa): o resto vem por "continuar" — nada de enxurrada no WhatsApp. */
export const MAX_MENSAGENS_EXTRAS = 6;

export function orcamentoPorMensagem({ maxPassos = 6, requisicaoMicrousd = 60_000, custo }) {
  const req = new Map(); let n = 0;
  return Object.freeze({
    ambiente: "PRODUCAO_COMPARTILHADO",
    reservar({ requisicaoId }) {
      const s = req.get(requisicaoId) ?? { passos: 0, gasto: 0 };
      if (s.passos >= maxPassos) throw Object.assign(new Error("PASSOS_ESGOTADOS"), { codigo: "PASSOS_ESGOTADOS" });
      if (s.gasto >= requisicaoMicrousd) throw Object.assign(new Error("ORCAMENTO_REQUISICAO_ESGOTADO"), { codigo: "ORCAMENTO_REQUISICAO_ESGOTADO" });
      s.passos++; req.set(requisicaoId, s);
      if (req.size > 500) req.delete(req.keys().next().value);
      return { id: ++n, requisicaoId };
    },
    concluir(reserva, { modelo, uso }) { const c = custo({ modelo, uso }); const s = req.get(reserva.requisicaoId); if (s) s.gasto += c; return c; },
    falhar() {},
  });
}
