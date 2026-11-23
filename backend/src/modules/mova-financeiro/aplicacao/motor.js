// MOTOR do MOVA — determinístico. Recebe um evento VALIDADO (contratos/evento.js) e decide UMA coisa:
// ignorar, bloquear, pedir informação, responder uma consulta, orientar ou criar uma PROPOSTA para revisão humana.
//
// Execução 02 — acesso por GRUPO (decisão do proprietário):
//   NÍVEL 1: todo participante do grupo autorizado conversa, consulta o que é compartilhável, envia documentos e cria
//            propostas — sem cadastro nem login. O participante é registrado automaticamente (JID + nome exibido, que NÃO é
//            prova de identidade) e fica como origem de cada pedido.
//   NÍVEL 2: aprovar/aplicar/corrigir só no Centro Financeiro autenticado (aplicacao/aprovacao.js), nunca por mensagem.
//
// Ordem (cada passo é fail-closed):
//   grupo autorizado → eco do próprio agente → evento repetido → participante (auto) → resposta relacionada → documento repetido
//   → dado restrito / pedido de aprovação (determinísticos, antes da IA) → leitura (IA estrita) → intenção proibida → consulta
//   → unidade → revisão | transferência | receita | pagamento | conta → competência → obrigações → PROPOSTA.
// Nunca: grava no Financeiro, paga, exclui, classifica em definitivo, age em competência que não esteja ABERTA, presume a
// unidade pelo histórico do participante. Comprovante de obrigação existente = proposta de BAIXA (nunca despesa nova).
import { chaveDoDocumento } from "../dominio/documentos.js";
import { SITUACAO_COMPROVANTE, avaliarComprovante } from "../dominio/comprovante.js";
import { grupoAutorizado, mascarar, normalizar, requisitosCompletos } from "../dominio/configuracao.js";
import { RESULTADO_UNIDADE, resolverUnidade, unidadesCitadas } from "../dominio/unidade.js";
import { CANAIS_SO_PELA_PLATAFORMA, fontesOficiais } from "../dominio/fontesDeReceita.js";
import { ehSaudacaoOuAjuda, mascararDadosSensiveis, pedidoForaDoEscopo, pedidoRestrito } from "../dominio/privacidade.js";
import { INTENCOES_BLOQUEADAS, INTENCOES_DE_REVISAO, SAIDA_VAZIA, sinaisDeInjecao, validarSaidaDaIa } from "../ia/contratos.js";
import { RESPOSTA, reais } from "./respostas.js";
import { criarFerramentas, periodoDaConsulta } from "./ferramentas.js";
import { ErroTransitorio } from "../gateway/fila.js";
import { ACESSO, CAPACIDADES, JANELA_CONTINUIDADE_MS, POLITICA_RESPOSTA, algumaUnidadePermite, consultaPodeSairNoGrupo, decidirSaidaNoGrupo, destinoPrivado, participanteAutorizado, perfilNa, perfilPodeConsultar, podeVerDetalhe } from "../dominio/participantes.js";
import { interpretarComando, interpretarSeguimento, saidaDeContinuacao } from "./comandos.js";
import { MIMES_SEM_LEITURA, MODO_SEM_LEITURA, RESPOSTA_DOCUMENTO, conferirArquivo, legendaDoDocumento, protocoloDoDocumento } from "./recebimentoDocumental.js";
import { MIDIA_RECUSADA } from "../contratos/evento.js";
import { DESFECHO, TIPO_DIVERGENCIA, MAX_CANDIDATAS_NA_PERGUNTA, buscarSemelhantes, classificarCasamento, escolherCategoria, interpretarResposta, legendaIndicaParcial, parecerRespostaDeDivergencia } from "../dominio/divergencia.js";

const NIVEL_APLICAR_COM_CONFIRMACAO = "APLICAR_COM_CONFIRMACAO";
export const DECISAO = Object.freeze({
  IGNORADO: "IGNORADO", BLOQUEADO: "BLOQUEADO", PEDIR_INFORMACAO: "PEDIR_INFORMACAO", DUPLICADO: "DUPLICADO",
  CONSULTA: "CONSULTA", ORIENTACAO: "ORIENTACAO", PROPOSTA: "PROPOSTA", FALHA_LEITURA: "FALHA_LEITURA",
  EXECUTADO: "EXECUTADO", // Agente 2 — Frente C: operação aplicada pelo serviço oficial conforme a política de autonomia
  DOCUMENTO_RECEBIDO: "DOCUMENTO_RECEBIDO", // Agente 2 — documento guardado para conferência humana, sem leitura e sem proposta
});
export const TIPO_PROPOSTA = Object.freeze({ BAIXA_DE_OBRIGACAO: "BAIXA_DE_OBRIGACAO", DESPESA_PAGA: "DESPESA_PAGA", NOVA_OBRIGACAO: "NOVA_OBRIGACAO", SOLICITACAO_DE_REVISAO: "SOLICITACAO_DE_REVISAO",
  // 24/11 (0015): nota fiscal de uma conta JÁ registrada — só anexa o documento à conta (nenhum valor muda).
  VINCULO_DE_DOCUMENTO: "VINCULO_DE_DOCUMENTO" });
const PAGAMENTOS = ["COMPROVANTE_PAGAMENTO", "RECIBO"];
const CONTAS = ["BOLETO", "NOTA_FISCAL"];
const CONSULTAS_DO_GRUPO = ["COMPARATIVO_UNIDADES", "SITUACAO_PROPOSTAS"];
const PEDIDO_DE_APROVACAO = /^\s*(aprov[ao]r?|aprovad[oa]|aplic[ao]r?|pode\s+aprovar|autoriz[ao]r?)\b/i;
// Execução 14 (achado real: o Haiku leu "faça o pagamento" como REGISTRAR_CONTA): pedido para EXECUTAR pagamento/transferência
// é barrado pelo backend antes da IA. "paguei" (relato) não casa: só imperativo/pedido.
/** 15A: validade da memória curta (esclarecimento sem citação). */
export const MEMORIA_CURTA_MS = 10 * 60 * 1000;
const PALAVRAS_DE_LIGACAO = new Set(["e", "eh", "a", "o", "da", "do", "de", "na", "no", "em", "foi", "unidade", "loja", "mova", "pra", "para", "sim", "ok", "hml"]);
const PEDIDO_DE_EXECUCAO = [
  /\b(fa[çc]a|faz|efetue|realize|execute|agende|programe|mande)\s+(o|a|os|as|um|uma)?\s*(pagamento|pix|transfer[eê]ncia|ted|doc)s?\b/i,
  /\b(pague|transfira|deposite)\s+(o|a|os|as|um|uma|r\$|\d)/i,
  /\b(pode|consegue|voc[eê]\s+pode)\s+(pagar|transferir|fazer\s+(o|um)\s+pix)\b/i,
];
const mes = (d) => (d ? d.slice(0, 7) : null);

/** Fornecedor da conta compatível com o favorecido do documento (contém um no outro, sem acento/caixa). */
function fornecedorCompativel(favorecido, titulo) {
  const a = normalizar(favorecido); const b = normalizar(titulo?.fornecedor?.nome);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

/**
 * @param {{cfg:object, porta:object, extrator:{extrair:Function}, armazenamento:object, relogio?:() => Date, registrar?:(e:object)=>void}} deps
 *   `registrar` recebe só códigos e ids mascarados (log operacional) — nunca texto, valor ou documento.
 */
/** 16A: códigos do controle/orçamento da IA (a pergunta não foi lida por decisão operacional, não por erro de quem escreveu). */
const IA_PAUSADA = Object.freeze(["ORCAMENTO_ESGOTADO", "ORCAMENTO_INDISPONIVEL", "IA_DESLIGADA_NO_CONTROLE"]);
/** Resposta por CAUSA da falha de leitura: problema técnico nunca vira "envie uma foto mais nítida" (23/11). */
const CODIGOS_FORMATO = ["MIDIA_NAO_SUPORTADA", "IA_TETO_MIDIA_RECUSADA"];
const CODIGOS_PESADO = ["IA_TETO_ENTRADA_EXCEDIDA", "IA_TETO_MIDIA_INVALIDA"];
export function respostaDaFalhaDeLeitura(lida, evento) {
  if (lida.codigo === "AUDIO_SEM_TRANSCRICAO") return RESPOSTA.audioSemTranscricao();
  if (!evento.midia) return RESPOSTA.falhaInterpretacao();
  if (CODIGOS_FORMATO.includes(lida.codigo)) return RESPOSTA_DOCUMENTO.formatoNaoAceito();
  if (CODIGOS_PESADO.includes(lida.codigo)) return RESPOSTA.documentoPesadoParaLeitura();
  if (String(lida.motivo).startsWith("IA_SAIDA_INVALIDA")) return RESPOSTA.documentoNaoIdentificado();
  if (lida.motivo === "DOCUMENTO_ILEGIVEL") return RESPOSTA.falhaLeitura(); // único caso em que o MODELO leu e declarou ilegível
  return RESPOSTA.falhaTecnicaDeLeitura();
}
export function criarMotor({ cfg, porta, extrator, armazenamento: a, relogio = () => new Date(), registrar = () => {}, redator = null, somenteConsultas = false, comandosDeterministicos = false, execucao = null, entregadores = null, recebimentoDocumental = false, obterEvidencia = null }) {
  const hoje = () => relogio().toISOString().slice(0, 10);
  const ACAO = porta.acoes;
  const servico = cfg.identidadeServico.usuarioId;
  const escopoDe = (u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico });
  const ferramentas = criarFerramentas({ porta, armazenamento: a });

  async function concluir(evento, { decisao, motivo, escopo = null, resposta = null, propostaId = null, injecao = false, extra = {}, privado = null, consulta = null, contextoConversa = null }) {
    if (privado) extra = { ...extra, respostaPrivada: privado.destino ? "ENVIADA_NO_PRIVADO" : "SEM_CONVERSA_PRIVADA" };
    await a.historico.registrar({
      organizacaoId: escopo?.organizacaoId ?? null, unidadeId: escopo?.unidadeId ?? null, eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, provedor: evento.provedor, tipoMensagem: evento.tipo, decisao, motivo, propostaId, sinaisDeInjecao: injecao,
      documentoSha256: evento.midia?.sha256 ?? null, ...extra,
    });
    registrar({ tipo: "MOVA_DECISAO", decisao, motivo, grupo: mascarar(evento.grupoId) });
    if (resposta && privado) {
      // Agente 2 — confidencialidade: o valor vai SÓ para a conversa privada do participante; no grupo fica o aviso (sem valores).
      if (privado.destino) await a.saida.enfileirar({ grupoId: privado.destino, respostaA: null, eventoId: evento.eventoId, texto: mascararDadosSensiveis(resposta), simulada: true });
      const aviso = privado.destino ? (privado.aviso ?? RESPOSTA.respondidoNoPrivado()) : (privado.avisoSemPrivado ?? RESPOSTA.semConversaPrivada());
      await a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: evento.mensagemId, eventoId: evento.eventoId, texto: aviso, simulada: true });
    } else if (resposta) await a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: evento.mensagemId, eventoId: evento.eventoId, texto: mascararDadosSensiveis(resposta), simulada: true });
    // Continuidade: depois de responder, escuta a próxima mensagem DESTE participante nesta conversa (e lembra unidade/consulta).
    if (resposta && evento.participanteId && typeof a.conversas?.registrar === "function") {
      await a.conversas.registrar({ grupoId: evento.grupoId, participanteId: evento.participanteId, unidadeId: escopo?.unidadeId ?? null, consulta, contexto: contextoConversa, validadeMs: JANELA_CONTINUIDADE_MS });
    }
    return { decisao, motivo, propostaId, resposta };
  }

  async function lerDocumento(evento, grupo, conversa = null) {
    if (!evento.midia && !evento.texto) return { ok: true, saida: { ...SAIDA_VAZIA, legivel: true, tipoDocumento: "DESCONHECIDO", intencao: "DESCONHECIDA", confianca: "BAIXA" } };
    // Contexto de conversa = SÓ a mensagem respondida (respostaA), do MESMO grupo. Mensagens apenas próximas no tempo nunca entram.
    const citada = evento.respostaA ? await a.eventos.obter(evento.respostaA, evento.grupoId) : null;
    const contexto = { unidades: cfg.unidades.filter((x) => grupo.unidades.includes(x.unidadeId)).map((x) => x.nome), mensagemCitada: citada?.texto ?? null };
    // Conversa (só TEXTO): consulta/unidade/período da última pergunta DESTA pessoa nesta conversa (janela curta). Compacto, sem texto
    // nem valores; só a unidade que a pessoa pode tratar entra (o histórico nunca amplia permissões).
    if (conversa?.consulta && !evento.midia) {
      const un = conversa.unidadeId && grupo.unidades.includes(conversa.unidadeId) ? cfg.unidades.find((x) => x.unidadeId === conversa.unidadeId) : null;
      const r = conversa.contexto ?? {};
      contexto.conversa = { consulta: conversa.consulta, unidade: un?.nome ?? null, periodo: r.competencia ?? ((r.periodoInicio || r.periodoFim) ? `${r.periodoInicio ?? "?"} a ${r.periodoFim ?? "?"}` : null) };
    }
    const t0 = Date.now();
    let bruta;
    try {
      bruta = await extrator.extrair({ texto: evento.texto, tipo: evento.tipo, midia: evento.midia ? { mime: evento.midia.mime, referencia: evento.midia.referencia } : null, contexto });
      registrar({ tipo: "MOVA_IA_LEITURA", ok: true, ms: Date.now() - t0, comContexto: Boolean(contexto.conversa), grupo: mascarar(evento.grupoId) }); // métrica sem texto, valor ou documento
    } catch (e) {
      registrar({ tipo: "MOVA_IA_LEITURA", ok: false, ms: Date.now() - t0, codigo: e?.codigo ?? (e instanceof ErroTransitorio ? "TRANSITORIO" : "ERRO"), grupo: mascarar(evento.grupoId) });
      if (e instanceof ErroTransitorio) throw e; // IA/transcrição fora do ar: a fila tenta de novo; nada é criado agora
      return { ok: false, motivo: e?.codigo ? `EXTRATOR_FALHOU:${e.codigo}${e.detalhe ? `:${e.detalhe}` : ""}` : "EXTRATOR_FALHOU", codigo: e?.codigo ?? null };
    }
    const v = validarSaidaDaIa(bruta);
    if (!v.ok) return { ok: false, motivo: `IA_SAIDA_INVALIDA:${v.erro}` };
    if (!v.saida.legivel) return { ok: false, motivo: "DOCUMENTO_ILEGIVEL" };
    return v;
  }

  /**
   * Agente 2 — documento SEM leitura: formato aceito, perfil que envia documentos NA unidade, unidade determinística (texto/legenda,
   * esclarecimento ou grupo de uma unidade), arquivo GUARDADO conferido (sha256, assinatura, PDF sem conteúdo ativo) e registro
   * efetivo antes de confirmar. A confirmação não tem valor nem conteúdo do arquivo (pode sair no grupo).
   */
  async function receberSemLeitura(evento, { participante, daPessoa, esclarecimento, injecao, midiaLocal = null }) {
    const m = evento.midia;
    if (!MIMES_SEM_LEITURA.includes(m.mime)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "FORMATO_NAO_ACEITO_SEM_LEITURA", resposta: RESPOSTA_DOCUMENTO.formatoNaoAceito(), injecao });
    if (!algumaUnidadePermite(participante, (c) => c.documentos)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PERFIL_SEM_DOCUMENTOS", resposta: RESPOSTA.perfilSemDocumentos(), injecao });
    // Integridade ANTES de gravar (bytes ainda em memória): arquivo hostil não chega ao banco nem de quem é autorizado.
    const arquivoRecusado = (c) => concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: c.motivo, resposta: c.motivo === "PDF_COM_CONTEUDO_ATIVO" ? RESPOSTA_DOCUMENTO.conteudoAtivo() : c.motivo === "ARQUIVO_NAO_GUARDADO" ? RESPOSTA_DOCUMENTO.falhaAoRegistrar() : RESPOSTA_DOCUMENTO.naoConfere(), injecao, extra: { semLeitura: true } });
    if (midiaLocal) { const c0 = conferirArquivo({ bytes: midiaLocal.bytes, sha256: m.sha256, mime: m.mime }); if (!c0.ok) return arquivoRecusado(c0); }
    const textos = (esclarecimento ? [esclarecimento.texto] : [evento.texto]).filter(Boolean);
    // Só as unidades em que ESTA pessoa envia documentos: a pergunta de unidade nunca oferece uma unidade que ela não pode usar.
    const comDocumentos = { ...daPessoa, unidades: daPessoa.unidades.filter((x) => CAPACIDADES[perfilNa(participante, x)]?.documentos) };
    const u = resolverUnidade({ cfg, grupo: comDocumentos, textos });
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      const nomes = cfg.unidades.filter((x) => comDocumentos.unidades.includes(x.unidadeId)).map((x) => x.nome);
      if ((u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE) && !esclarecimento) {
        // Pendente de identificação: a pessoa já pode enviar documentos em TODAS as unidades oferecidas; o original é guardado
        // (sem unidade) para a resposta poder ser conferida depois, quando a mensagem desta fila já tiver terminado.
        if (midiaLocal) await midiaLocal.guardar();
        await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: { ...SAIDA_VAZIA, legivel: true, tipoDocumento: "DESCONHECIDO", intencao: "DESCONHECIDA", confianca: "BAIXA" } } });
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao, extra: { evidenciaUnidade: u.evidencia, semLeitura: true } });
      }
      const resposta = u.evidencia === "PAGADOR_FORA_DA_CONVERSA" && u.unidadeDoDocumento ? RESPOSTA.pagadorDeOutraUnidade(u.unidadeDoDocumento)
        : u.resultado === RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE || u.resultado === RESULTADO_UNIDADE.FORA_DO_GRUPO ? RESPOSTA.documentoDeOutraUnidade() : RESPOSTA.unidadeConflitante();
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: u.resultado, resposta, injecao, extra: { evidenciaUnidade: u.evidencia, semLeitura: true } });
    }
    const unidade = u.unidade;
    const escopo = escopoDe(unidade);
    if (!(CAPACIDADES[perfilNa(participante, unidade.unidadeId)]?.documentos)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PERFIL_SEM_DOCUMENTOS", escopo, resposta: RESPOSTA.perfilSemDocumentos(), injecao });
    if (midiaLocal) await midiaLocal.guardar(); // autorizado: perfil na unidade, formato, tamanho e integridade conferidos
    const bytes = obterEvidencia ? await obterEvidencia(m.referencia) : null;
    const c = conferirArquivo({ bytes, sha256: m.sha256, mime: m.mime });
    if (!c.ok) return arquivoRecusado(c); // conferência do que FICOU guardado (lido de volta)
    await a.documentos.marcar(m.sha256, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, eventoId: evento.eventoId, propostaId: null,
      leitura: { modo: MODO_SEM_LEITURA, mime: m.mime, tamanhoBytes: m.tamanhoBytes, nomeArquivo: m.nomeArquivo ?? null, participanteId: evento.participanteId,
        recebidoEm: evento.recebidoEm, legenda: legendaDoDocumento(esclarecimento ? `${evento.texto ?? ""} ${esclarecimento.texto}` : evento.texto), evidenciaUnidade: u.evidencia } });
    // Confirmação SÓ depois do registro efetivo (lido de volta): mesmo arquivo, mesma mensagem, mesma unidade.
    const gravado = await a.documentos.visto(m.sha256);
    if (gravado && gravado.eventoId !== evento.eventoId) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "DOCUMENTO_JA_RECEBIDO", escopo: gravado, resposta: RESPOSTA_DOCUMENTO.jaRecebido(protocoloDoDocumento(m.sha256)), injecao });
    if (!gravado || gravado.unidadeId !== escopo.unidadeId) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: "DOCUMENTO_NAO_REGISTRADO", escopo, resposta: RESPOSTA_DOCUMENTO.falhaAoRegistrar(), injecao });
    await a.auditoria.registrar({ acao: "DOCUMENTO_RECEBIDO_SEM_LEITURA", atorTipo: "SISTEMA", alvo: m.sha256, dados: { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, eventoId: evento.eventoId, mime: m.mime, tamanhoBytes: m.tamanhoBytes } });
    return concluir(evento, { decisao: DECISAO.DOCUMENTO_RECEBIDO, motivo: "AGUARDANDO_CONFERENCIA", escopo, resposta: RESPOSTA_DOCUMENTO.recebido(unidade.nome, protocoloDoDocumento(m.sha256)), injecao, extra: { semLeitura: true, protocolo: protocoloDoDocumento(m.sha256) } });
  }

  /**
   * 15A: o texto é SÓ a resposta a "de qual unidade?" — curto, sem números, uma única unidade da conversa e, tirando o
   * nome/apelido dela e palavras de ligação, NADA sobra. ("paguei a luz da alfa" é pedido NOVO, não esclarecimento:
   * achado do conjunto de avaliação, caso C14.)
   */
  function ehEsclarecimentoDeUnidade(texto, grupo) {
    const t = String(texto ?? "").trim();
    if (!t || t.length > 60 || /\d/.test(t)) return false;
    const u = resolverUnidade({ cfg, grupo, textos: [t] });
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) return false;
    let resto = ` ${normalizar(t)} `;
    for (const ap of [...u.unidade.apelidos].sort((a, b) => b.length - a.length)) resto = resto.split(` ${ap} `).join(" ");
    return resto.split(" ").filter(Boolean).every((p) => PALAVRAS_DE_LIGACAO.has(p));
  }

  async function processar(evento, { esclarecimento = null, midiaLocal = null } = {}) {
    // 1. Grupo autorizado. Fora da lista: nada é lido, guardado nem respondido.
    const grupo = grupoAutorizado(cfg, evento.grupoId);
    if (!grupo) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "GRUPO_NAO_AUTORIZADO" });
    // 2. Mensagens do próprio agente (fromMe, ou eco de uma resposta registrada): ignora, sem histórico — evita laço.
    if (evento.fromMe || await a.saida.ehRespostaPropria(evento.mensagemId)) return { decisao: DECISAO.IGNORADO, motivo: "MENSAGEM_PROPRIA" };
    if (!evento.participanteId) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "SEM_PARTICIPANTE" });
    // Agente 2 — grupo por LISTA: só participante autorizado (segunda barreira; o receptor já descarta antes de guardar).
    // Sem resposta: quem não está na lista não recebe nada do MOVA.
    const participante = participanteAutorizado(grupo, evento);
    if (!participante) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "PARTICIPANTE_NAO_AUTORIZADO" });
    const daPessoa = participante.aberto ? grupo : { ...grupo, unidades: participante.unidades }; // unidades que ESTA pessoa pode tratar
    const conversa = typeof a.conversas?.obter === "function" ? await a.conversas.obter({ grupoId: evento.grupoId, participanteId: evento.participanteId }) : null;

    if (!esclarecimento) {
      // 3. Evento repetido (reconexão do Baileys, reenvio do Gateway) — segunda barreira depois da fila.
      // Já registrado E já decidido ⇒ repetido. Registrado SEM decisão = nova tentativa depois de falha transitória: segue.
      const { novo } = await a.eventos.registrar(evento);
      if (!novo && await a.historico.temDecisao(evento.eventoId)) return { decisao: DECISAO.DUPLICADO, motivo: "EVENTO_JA_PROCESSADO" };
      // 4. NÍVEL 1: participante do grupo autorizado é registrado automaticamente (sem cadastro nem login).
      // 23/11: conversa privada de ENTREGADOR não é grupo (mova.participante exige mova.grupo_autorizado): o entregador já é o
      // cadastro dele (mova.entregador_autorizado); registrá-lo aqui derrubava TODA mensagem dele (ERRO_PERMANENTE, sem NF).
      if (novo && !grupo.entregador) {
        const p = await a.participantes.registrar({ grupoId: evento.grupoId, participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null, nomeExibicao: evento.nomeExibicao ?? null });
        if (p.novo) await a.auditoria.registrar({ acao: "PARTICIPANTE_REGISTRADO", atorTipo: "SISTEMA", alvo: evento.participanteId, dados: { grupo: mascarar(evento.grupoId) } });
      }
      // Agente 2 — Frente D: conversa privada de ENTREGADOR ⇒ fluxo próprio, determinístico e SEM IA (só o fechamento dele).
      if (grupo.entregador) {
        if (!entregadores) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "ENTREGADORES_DESLIGADO" });
        if (evento.midia && midiaLocal) await midiaLocal.guardar(); // entregador cadastrado (fluxo próprio, desligado em produção)
        const r = await entregadores.atender(evento, grupo);
        return concluir(evento, { decisao: r.decisao, motivo: r.motivo, escopo: r.escopo, resposta: r.resposta, extra: { entregador: true } });
      }

      // 5. Mensagem relacionada: texto respondendo a um documento que aguarda esclarecimento (atômico; sobrevive a reinício).
      if (evento.respostaA && evento.tipo === "TEXTO") {
        const pend = await a.mensagens.tomarPendente(evento.respostaA);
        if (pend?.pendente) {
          await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "ESCLARECIMENTO_RECEBIDO", participanteId: evento.participanteId, organizacaoId: null, unidadeId: null });
          return processar(pend.pendente.evento, { esclarecimento: { texto: evento.texto, saida: pend.pendente.saida, divergencia: pend.pendente.divergencia ?? null, porEvento: evento.eventoId, participanteId: evento.participanteId } });
        }
      }
      // 5b. 15A — MEMÓRIA CURTA: esclarecimento SEM citar a pergunta ("Sanduíches Centro" logo depois de "de qual unidade?").
      // Só quando TODAS valem: mesma conversa e MESMO participante; pendência dos últimos 10 min (só a mais recente);
      // texto curto, sem números, que identifica exatamente UMA unidade da conversa. Retomada atômica (nunca duas vezes).
      // 23/11: também a resposta CURTA a uma pergunta de divergência (sim / não / número / juros / parcial / outra compra).
      const ehUnidade = !evento.respostaA && evento.tipo === "TEXTO" && ehEsclarecimentoDeUnidade(evento.texto, daPessoa);
      const ehRespostaCurta = !evento.respostaA && evento.tipo === "TEXTO" && parecerRespostaDeDivergencia(evento.texto);
      if ((ehUnidade || ehRespostaCurta) && typeof a.mensagens.tomarPendenteRecente === "function") {
        const pend = await a.mensagens.tomarPendenteRecente({ grupoId: evento.grupoId, participanteId: evento.participanteId, validadeMs: MEMORIA_CURTA_MS });
        if (pend?.pendente && !pend.pendente.divergencia && !ehUnidade) {
          // era a pergunta de unidade e a resposta curta não é uma unidade: devolve a pendência e segue o fluxo normal da mensagem
          await a.mensagens.lembrar(pend.pendente.evento.mensagemId, { grupoId: pend.grupoId ?? evento.grupoId, pendente: pend.pendente });
        } else if (pend?.pendente) {
          await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: pend.pendente.divergencia ? "RESPOSTA_DE_DIVERGENCIA_POR_CONTEXTO" : "ESCLARECIMENTO_POR_CONTEXTO", participanteId: evento.participanteId, organizacaoId: null, unidadeId: null, retomou: pend.pendente.evento.eventoId });
          return processar(pend.pendente.evento, { esclarecimento: { texto: evento.texto, saida: pend.pendente.saida, divergencia: pend.pendente.divergencia ?? null, porEvento: evento.eventoId, participanteId: evento.participanteId } });
        }
      }
    }

    // Agente 2 — arquivo recusado no receptor ANTES de qualquer gravação (perfil, formato, tamanho, cadastro revogado): só a resposta.
    if (evento.midiaRecusada) {
      const resposta = { [MIDIA_RECUSADA.PERFIL_SEM_DOCUMENTOS]: RESPOSTA.perfilSemDocumentos(), [MIDIA_RECUSADA.ARQUIVO_GRANDE]: RESPOSTA_DOCUMENTO.arquivoGrande() }[evento.midiaRecusada] ?? RESPOSTA_DOCUMENTO.formatoNaoAceito();
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: evento.midiaRecusada, resposta, extra: { arquivoDescartadoAntesDeGuardar: true } });
    }
    // 6. Idempotência por DOCUMENTO (mesmo arquivo reenviado em outra mensagem).
    if (evento.midia) {
      const visto = await a.documentos.visto(evento.midia.sha256);
      if (visto && visto.eventoId !== evento.eventoId) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "DOCUMENTO_JA_RECEBIDO", escopo: visto, propostaId: visto.propostaId ?? null, resposta: recebimentoDocumental && !visto.propostaId ? RESPOSTA_DOCUMENTO.jaRecebido(protocoloDoDocumento(evento.midia.sha256)) : RESPOSTA.duplicado(visto.propostaId) });
    }

    // 7. Guardas determinísticas ANTES da IA (nada restrito vai ao modelo): dado restrito e pedido de aprovação pelo grupo.
    const injecao = sinaisDeInjecao(evento.texto) || sinaisDeInjecao(esclarecimento?.texto);
    if (evento.tipo === "TEXTO" && !esclarecimento && pedidoRestrito(evento.texto)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "DADO_RESTRITO", resposta: RESPOSTA.dadoRestrito(), injecao });
    if (evento.tipo === "TEXTO" && !esclarecimento && PEDIDO_DE_EXECUCAO.some((r) => r.test(evento.texto ?? ""))) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "INTENCAO_PROIBIDA:PEDIR_PAGAMENTO", resposta: RESPOSTA.operacaoBloqueada(), injecao });
    if (evento.tipo === "TEXTO" && !esclarecimento && pedidoForaDoEscopo(evento.texto)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "FORA_DO_ESCOPO", resposta: RESPOSTA.foraDoEscopo(), injecao });
    // 15H (H-1): saudação/pergunta sobre o MOVA, sem número nem palavra financeira ⇒ orientação determinística, SEM IA.
    if (evento.tipo === "TEXTO" && !evento.midia && !esclarecimento && ehSaudacaoOuAjuda(evento.texto)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "SAUDACAO", resposta: somenteConsultas ? RESPOSTA.conversaPiloto() : RESPOSTA.conversaSemPedido(), injecao });
    // Agente 2 — recebimento SEM IA: o documento é conferido, guardado e fica para a revisão humana (nada vai à IA, nada é criado
    // no Financeiro). Vem antes do "só consultas": com o recebimento ligado, documento deixa de ser recusado.
    if (recebimentoDocumental && evento.midia) return receberSemLeitura(evento, { participante, daPessoa, esclarecimento, injecao, midiaLocal });
    // 16A (piloto): documento/áudio não é lido (nada vai à IA, nada é criado) — o piloto só responde consultas.
    if (somenteConsultas && evento.midia) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PILOTO_SOMENTE_CONSULTAS", resposta: RESPOSTA.pilotoSomenteConsultas(), injecao });
    // Agente 2: perfil sem envio de documentos (ex.: só consultas) — o documento nem vai à IA.
    if (evento.midia && !algumaUnidadePermite(participante, (c) => c.documentos)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PERFIL_SEM_DOCUMENTOS", resposta: RESPOSTA.perfilSemDocumentos(), injecao });
    if (evento.midia && midiaLocal) await midiaLocal.guardar(); // leitura por IA (legado): o original é guardado só depois da conferência de perfil
    if (evento.tipo === "TEXTO" && !esclarecimento && PEDIDO_DE_APROVACAO.test(evento.texto ?? "")) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "APROVACAO_SO_NO_CENTRO_FINANCEIRO", resposta: RESPOSTA.aprovacaoSoNoDashboard(), injecao });

    // 8. Leitura (IA): saída estrita; falha = pede reenvio, nada é criado.
    let saida = esclarecimento?.saida ?? null;
    let interpretacao = "IA";
    // Agente 2 — comando simples (sem IA, sem custo): "MOVA, contas a pagar da semana". Só período ("e a semana que vem?") =
    // continuação da consulta anterior DESTA pessoa nesta conversa; sem consulta anterior, segue para a IA.
    if (!saida && comandosDeterministicos && evento.tipo === "TEXTO" && !evento.midia) {
      const cmd = interpretarComando(evento.texto, hoje());
      if (cmd && !cmd.soPeriodo) { saida = cmd.saida; interpretacao = "COMANDO"; }
      else if (cmd?.soPeriodo && conversa?.consulta) { saida = Object.freeze({ ...cmd.saida, consulta: conversa.consulta }); interpretacao = "CONTINUIDADE"; }
    }
    // Conversa natural sem IA (custo zero): "só as vencidas", "agora por fornecedor", "nas duas" e "e na Subway?" repetem a consulta
    // anterior DESTA pessoa nesta conversa (janela curta). A unidade continua vindo da regra determinística (nunca do histórico).
    if (!saida && !esclarecimento && conversa?.consulta && evento.tipo === "TEXTO" && !evento.midia) {
      const seg = interpretarSeguimento(evento.texto, conversa)
        ?? (/^\s*(e|mas)\b/i.test(evento.texto ?? "") && ehEsclarecimentoDeUnidade(evento.texto, daPessoa) ? saidaDeContinuacao(conversa.consulta, conversa) : null);
      if (seg) { saida = seg; interpretacao = "CONTINUIDADE"; }
    }
    if (!saida) {
      const lida = await lerDocumento(evento, daPessoa, conversa);
      // Execução 13C: a IA recusar NÃO é falha de leitura nem controle de acesso — vira bloqueio explícito, sem nova chamada.
      if (!lida.ok && lida.codigo === "IA_RECUSOU") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "IA_RECUSOU", resposta: RESPOSTA.pedidoNaoAtendido(), injecao });
      // 16A: orçamento esgotado/indisponível ou IA desligada NÃO é "mensagem mal escrita" — não pede para reenviar.
      if (!lida.ok && IA_PAUSADA.includes(lida.codigo)) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: RESPOSTA.iaPausada(), injecao });
      if (!lida.ok) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: respostaDaFalhaDeLeitura(lida, evento), injecao });
      saida = lida.saida;
      // A IA marcou que a mensagem depende da pergunta anterior e não trouxe consulta própria: repete a consulta da conversa (com o
      // mesmo período, se a mensagem não trouxe outro). Só consulta: nenhuma outra intenção é reescrita.
      if (saida.continuacao === true && !saida.consulta && conversa?.consulta && ["CONSULTAR", "OUTRA", "DESCONHECIDA"].includes(saida.intencao) && !saida.valorCentavos) {
        const r = conversa.contexto ?? {};
        const tem = Boolean(saida.competencia || saida.periodoInicio || saida.periodoFim);
        const rec = validarSaidaDaIa({ ...saida, intencao: "CONSULTAR", consulta: conversa.consulta, ...(tem ? {} : { competencia: r.competencia ?? null, periodoInicio: r.periodoInicio ?? null, periodoFim: r.periodoFim ?? null }) });
        if (rec.ok) { saida = rec.saida; interpretacao = "IA_CONTINUIDADE"; }
      }
    }

    // 9. Intenções que o MOVA nunca executa / que só o Nível 2 faz.
    if (INTENCOES_BLOQUEADAS.includes(saida.intencao)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `INTENCAO_PROIBIDA:${saida.intencao}`, resposta: RESPOSTA.operacaoBloqueada(), injecao });
    if (saida.intencao === "APROVAR_PROPOSTA") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "APROVACAO_SO_NO_CENTRO_FINANCEIRO", resposta: RESPOSTA.aprovacaoSoNoDashboard(), injecao });
    if (saida.consulta === "DADO_RESTRITO") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "DADO_RESTRITO", resposta: RESPOSTA.dadoRestrito(), injecao });

    // 10. Consultas do GRUPO (não dependem de uma unidade).
    const consulta = (saida.intencao === "CONSULTAR" && saida.consulta) || null;
    if (consulta && !perfilPodeConsultarAlguma(participante, consulta)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "PERFIL_SEM_CONSULTA", resposta: RESPOSTA.perfilSemConsulta(), injecao });
    if (consulta && (CONSULTAS_DO_GRUPO.includes(consulta) || saida.todasUnidades)) return responderConsultaDoGrupo(evento, daPessoa, consulta, saida, injecao, { grupo, participante, interpretacao });

    // 10b. Execução 13B (achado com IA real + WhatsApp real): texto puro sem pedido financeiro (saudação, conversa) não é
    // lançamento — antes caía na pergunta "Esse lançamento pertence à…?". Sem documento, sem valor e sem esclarecimento pendente.
    // 15H (H-1): CONSULTAR sem assunto definido (ex.: "você está funcionando?") também é conversa — nunca pergunta de unidade.
    if (!evento.midia && !esclarecimento && !saida.valorCentavos && (["OUTRA", "DESCONHECIDA"].includes(saida.intencao) || (saida.intencao === "CONSULTAR" && !saida.consulta && !saida.todasUnidades))) {
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONVERSA_SEM_PEDIDO_FINANCEIRO", resposta: somenteConsultas ? RESPOSTA.conversaPiloto() : RESPOSTA.conversaSemPedido(), injecao });
    }
    // 16A (piloto): qualquer coisa que não seja consulta (pagamento, conta, correção, transferência) NÃO vira proposta.
    if (somenteConsultas && !consulta) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PILOTO_SOMENTE_CONSULTAS", resposta: RESPOSTA.pilotoSomenteConsultas(), injecao });

    // 11. Unidade (determinística; IA só confirma; nunca pelo histórico do participante).
    // O esclarecimento (resposta à pergunta) PREVALECE sobre o texto original, que era justamente o ambíguo.
    // Áudio: a TRANSCRIÇÃO conta como texto da mensagem (a unidade pode ter sido dita no áudio).
    // Resposta a uma pergunta de DIVERGÊNCIA ("sim", "2", "outra compra") não fala de unidade: a unidade segue a da mensagem original.
    const textos = (esclarecimento && !esclarecimento.divergencia ? [esclarecimento.texto] : [evento.texto, saida.transcricao]).filter(Boolean);
    // 24/11: o PAGADOR lido do DOCUMENTO (comprovante: titular da conta de origem; boleto: sacado; nota: tomador) identifica a
    // unidade pelo cadastro `pagadores`. Relato só por texto não tem documento: o pagador dito no texto não conta.
    const doDocumento = Boolean(evento.midia) && [...PAGAMENTOS, ...CONTAS].includes(saida.tipoDocumento);
    let u = resolverUnidade({ cfg, grupo: daPessoa, textos, documentoDestinatario: saida.documentoDestinatario, sugestaoIa: saida.unidadeSugerida,
      pagador: doDocumento ? saida.pagador ?? null : null, documentoPagador: doDocumento ? saida.documentoPagador ?? null : null });
    // Agente 2 — CONSULTA (só leitura) sem unidade no texto: a unidade da conversa em andamento DESTA pessoa (janela curta).
    // Documento/lançamento continua exigindo evidência própria (nunca pelo histórico do participante).
    if (consulta && u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA && conversa?.unidadeId && daPessoa.unidades.includes(conversa.unidadeId)) {
      const daConversa = cfg.unidades.find((x) => x.unidadeId === conversa.unidadeId);
      if (daConversa) u = { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: daConversa, evidencia: "CONVERSA_EM_ANDAMENTO" };
    }
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      const nomes = cfg.unidades.filter((x) => daPessoa.unidades.includes(x.unidadeId)).map((x) => x.nome);
      if ((u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE) && !esclarecimento) {
        await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida } });
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao, extra: { evidenciaUnidade: u.evidencia } });
      }
      const resposta = u.evidencia === "PAGADOR_FORA_DA_CONVERSA" && u.unidadeDoDocumento ? RESPOSTA.pagadorDeOutraUnidade(u.unidadeDoDocumento)
        : u.resultado === RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE || u.resultado === RESULTADO_UNIDADE.FORA_DO_GRUPO ? RESPOSTA.documentoDeOutraUnidade() : RESPOSTA.unidadeConflitante();
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: u.resultado, resposta, injecao, extra: { evidenciaUnidade: u.evidencia } });
    }
    const unidade = u.unidade;
    const escopo = escopoDe(unidade);
    // Agente 2 — Frente B: a MESMA transação (ID/E2E) já recebida nesta empresa, em outro arquivo (foto × PDF, print × encaminhado):
    // não cria segunda proposta. O sha256 só pega o mesmo arquivo; o identificador da transação pega o mesmo pagamento.
    if (evento.midia && saida.idTransacao && typeof a.documentos.porTransacao === "function") {
      const mesma = await a.documentos.porTransacao({ organizacaoId: escopo.organizacaoId, idTransacao: saida.idTransacao });
      if (mesma && mesma.eventoId !== evento.eventoId) {
        await marcarDocumento(evento, escopo, null, saida);
        return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "TRANSACAO_JA_RECEBIDA", escopo, propostaId: mesma.propostaId ?? null, resposta: RESPOSTA.duplicado(mesma.propostaId), injecao });
      }
    }
    // Agente 2 — o MESMO boleto (linha digitável × código de barras) ou a MESMA nota (chave de acesso) em outro formato:
    // chave canônica só com dígitos verificadores válidos; sem ela, vale só o sha256 (nunca um palpite).
    const chaveDoc = evento.midia ? chaveDoDocumento(saida) : null;
    if (chaveDoc && typeof a.documentos.porChave === "function") {
      const mesmo = await a.documentos.porChave({ organizacaoId: escopo.organizacaoId, chave: chaveDoc });
      if (mesmo && mesmo.eventoId !== evento.eventoId) {
        await marcarDocumento(evento, escopo, null, saida);
        return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "DOCUMENTO_JA_RECEBIDO", escopo, propostaId: mesmo.propostaId ?? null, resposta: RESPOSTA.duplicado(mesmo.propostaId), injecao });
      }
    }
    const ctx = { evento, escopo, unidade, saida, injecao, esclarecimento, grupo, participante, interpretacao, evidenciaUnidade: u.evidencia };

    if (consulta) {
      if (!perfilPodeConsultar(perfilNa(participante, unidade.unidadeId), consulta)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "PERFIL_SEM_CONSULTA", escopo, resposta: RESPOSTA.perfilSemConsulta(), injecao });
      return responderConsulta(ctx, consulta);
    }
    // Agente 2: lançamento/documento exige perfil com documentos NA unidade identificada.
    if (!(CAPACIDADES[perfilNa(participante, unidade.unidadeId)]?.documentos)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PERFIL_SEM_DOCUMENTOS", escopo, resposta: RESPOSTA.perfilSemDocumentos(), injecao });

    // 12. Pedido de correção/classificação: vira SOLICITAÇÃO para o administrador (sem comando financeiro).
    if (INTENCOES_DE_REVISAO.includes(saida.intencao)) {
      return criarProposta(ctx, { tipo: TIPO_PROPOSTA.SOLICITACAO_DE_REVISAO, valorCentavos: saida.valorCentavos ?? null, parcial: false, datas: {}, comando: null }, RESPOSTA.solicitacaoRevisao);
    }

    // 13. Transferência entre contas da própria empresa: nunca despesa (reconhecida pelo extrato, na conciliação).
    const favorecidoEhDaEmpresa = saida.favorecido && unidadesCitadas(saida.favorecido, cfg.unidades).length > 0;
    if (saida.intencao === "INFORMAR_TRANSFERENCIA" || favorecidoEhDaEmpresa) {
      await marcarDocumento(evento, escopo, null, saida);
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "TRANSFERENCIA_INTERNA_NAO_E_DESPESA", escopo, resposta: RESPOSTA.transferenciaInterna(), injecao });
    }

    // 14. Receita: nunca pelo MOVA; responde a fonte oficial (sem contar duas vezes).
    if (saida.tipoDocumento === "RELATORIO_VENDAS" || saida.natureza === "RECEITA") {
      const f = fontesOficiais(unidade);
      if (f.situacao !== "CONFIRMADA") return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "FONTES_NAO_CONFIRMADAS", escopo, resposta: RESPOSTA.fonteNaoConfirmada(), injecao });
      const canais = Object.entries(f.canais).map(([c, fonte]) => `${c}: ${fonte}${CANAIS_SO_PELA_PLATAFORMA.includes(c) ? " (oficial da plataforma)" : ""}`).join("; ");
      await marcarDocumento(evento, escopo, null, saida);
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "RECEITA_SO_PELA_FONTE_OFICIAL", escopo, resposta: RESPOSTA.fonteOficial(canais), injecao });
    }

    // Execução 14: relato só por TEXTO (sem documento) — a INTENÇÃO decide (pagamento feito × conta a vencer), não um "tipo de
    // documento" que não existe. Com documento, segue valendo o tipo lido.
    const textoPuro = !evento.midia;
    const relatoPagamento = textoPuro && saida.intencao === "INFORMAR_PAGAMENTO";
    const relatoConta = textoPuro && saida.intencao === "REGISTRAR_CONTA";
    if (!relatoPagamento && !relatoConta && ![...PAGAMENTOS, ...CONTAS].includes(saida.tipoDocumento)) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "TIPO_DE_DOCUMENTO_NAO_RECONHECIDO", escopo, resposta: RESPOSTA.faltaInformacao(["tipo do documento (comprovante, boleto ou nota)"]), injecao });
    if (!saida.valorCentavos && saida.camposAusentes.includes("valorCentavos") && saida.incertezas.length > 0) {
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VALOR_AMBIGUO", escopo, resposta: RESPOSTA.faltaInformacao(["qual é o valor correto (o documento tem mais de um valor possível)"]), injecao });
    }
    if (!saida.valorCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VALOR_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["valor"]), injecao });

    // Execução 04B (achado com a IA real): cupom/nota fiscal JÁ PAGO ("paguei…") é pagamento, não conta a vencer. Sem data de
    // pagamento, tratarPagamento pergunta — nunca presume a data pela emissão.
    const notaJaPaga = saida.tipoDocumento === "NOTA_FISCAL" && saida.intencao === "INFORMAR_PAGAMENTO" && !saida.vencimento;
    if (relatoPagamento) return tratarPagamento(ctx);
    if (relatoConta) return tratarConta(ctx);
    return PAGAMENTOS.includes(saida.tipoDocumento) || notaJaPaga ? tratarPagamento(ctx) : tratarConta(ctx);
  }

  async function marcarDocumento(evento, escopo, propostaId, leitura) {
    if (evento.midia) await a.documentos.marcar(evento.midia.sha256, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, propostaId, eventoId: evento.eventoId,
      leitura: leitura ? { ...leitura, chaveDocumento: chaveDoDocumento(leitura) } : leitura });
  }

  async function competenciaAberta({ evento, escopo, injecao }, competencia) {
    const estado = await porta.estadoDaCompetencia(escopo, competencia);
    if (estado === "ABERTA") return null;
    return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `COMPETENCIA_${estado}`, escopo, resposta: RESPOSTA.competenciaFechada(competencia), injecao });
  }

  async function criarProposta({ evento, escopo, unidade, saida, injecao, esclarecimento, grupo = null, participante = null, evidenciaUnidade = null }, dados, textoResposta, { posCriacao = null } = {}) {
    // Execução 14: o mesmo relato por TEXTO reenviado em outra mensagem (sem arquivo para comparar por sha256) não cria segunda
    // proposta: mesma unidade, tipo, valor e datas de uma proposta do MOVA ainda aguardando revisão ⇒ DUPLICADO.
    if (!evento.midia && [TIPO_PROPOSTA.DESPESA_PAGA, TIPO_PROPOSTA.NOVA_OBRIGACAO].includes(dados.tipo)) {
      const mesma = (await a.propostas.listar(escopo)).find((p) => p.estado === "AGUARDANDO_REVISAO" && p.eventoId !== evento.eventoId && !p.evidencia
        && p.tipo === dados.tipo && p.valorCentavos === dados.valorCentavos
        && (p.datas?.caixa ?? null) === (dados.datas?.caixa ?? null) && (p.datas?.vencimento ?? null) === (dados.datas?.vencimento ?? null));
      if (mesma) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "PROPOSTA_SEMELHANTE_PENDENTE", escopo, propostaId: mesma.id, resposta: RESPOSTA.relatoRepetido(mesma.id), injecao });
    }
    const incompleta = !requisitosCompletos(unidade);
    const { proposta } = await a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|${dados.tipo}`, origem: "MOVA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, esclarecidoPor: esclarecimento ? esclarecimento.participanteId : null,
      evidencia: evento.midia ? { sha256: evento.midia.sha256, referencia: evento.midia.referencia, mime: evento.midia.mime } : null,
      // 15A (V-1): a justificativa e os campos ausentes da IA ficam na proposta para a revisão humana (texto puro não tem documento).
      leitura: { tipoDocumento: saida.tipoDocumento, intencao: saida.intencao, favorecido: saida.favorecido, identificadorDocumento: saida.identificadorDocumento, confianca: saida.confianca,
        pagador: saida.pagador ?? null, documentoPagador: saida.documentoPagador ?? null, instituicao: saida.instituicao ?? null, idTransacao: saida.idTransacao ?? null,
        // 23/11: evidências bancárias do comprovante para a conciliação (nunca confirmam compensação): banco do recebedor, data e hora impressas, valor.
        instituicaoDestino: saida.instituicaoDestino ?? null, horaTransacao: saida.horaTransacao ?? null, dataPagamento: saida.dataPagamento ?? null, valorCentavos: saida.valorCentavos ?? null,
        // Execução 17: situação IMPRESSA e a avaliação determinística do comprovante (a IA não atesta autenticidade).
        situacaoTransacao: saida.situacaoTransacao ?? null, incertezas: saida.incertezas ?? [],
        comprovante: evento.midia && saida.tipoDocumento === "COMPROVANTE_PAGAMENTO" ? avaliarComprovante(saida, { hoje: hoje() }) : null,
        justificativa: saida.justificativa ? mascararDadosSensiveis(String(saida.justificativa).slice(0, 300)) : null, camposAusentes: saida.camposAusentes ?? [],
        // 24/11: COMO a unidade foi identificada (TITULAR_DO_PAGADOR, DOCUMENTO_DO_PAGADOR, TEXTO, DOCUMENTO, GRUPO_DE_UMA_UNIDADE…), para a auditoria.
        evidenciaUnidade },
      categoriaSugerida: saida.categoriaSugerida, naturezaSugerida: saida.natureza, sinaisDeInjecao: injecao,
      // Unidade com requisitos financeiros incompletos: a proposta é guardada, mas a APLICAÇÃO fica bloqueada até completar.
      bloqueioDeAplicacao: incompleta ? "REQUISITOS_FINANCEIROS_INCOMPLETOS" : null,
      // Agente 2 — Frente B/C: imagem/PDF de comprovante NÃO é prova definitiva. A liquidação só vale com a evidência bancária
      // (extrato) conferida; até lá a proposta fica marcada como aguardando extrato.
      conciliacao: [TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, TIPO_PROPOSTA.DESPESA_PAGA].includes(dados.tipo) ? { situacao: "AGUARDANDO_EXTRATO", idTransacao: saida.idTransacao ?? null } : null,
      // Quem aplica: uma pessoa com financeiro_v2.aprovar + financeiro_v2.aplicar (+ registrar), pelo Centro Financeiro.
      exigeParaAplicar: [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR],
      ...dados,
    });
    await marcarDocumento(evento, escopo, proposta.id, saida);
    await a.auditoria.registrar({ acao: "PROPOSTA_CRIADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: dados.tipo, unidadeId: escopo.unidadeId } });
    // Agente 2 — Frente C: depois de criada, a baixa é conferida com o extrato e, se a política autorizar, liquidada.
    const pos = posCriacao ? await posCriacao(proposta) : null;
    const texto = (pos?.texto ?? textoResposta(proposta)) + (incompleta ? ` ${RESPOSTA.pendenteUnidadeIncompleta()}` : "");
    const extra = pos ? { conciliacao: pos.situacao, autonomia: pos.nivel, ...(pos.nivelDocumental ? { autonomiaDocumental: pos.nivelDocumental, comprovante: pos.comprovante } : {}), ...(pos.motivo ? { motivoExecucao: pos.motivo } : {}) } : {};
    // Agente 2: a resposta do documento leva VALOR — num grupo por LISTA segue a política (privado, ou grupo comprovado).
    const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]);
    const privado = rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null;
    return concluir(evento, { decisao: ["EXECUTADA", "PAGO_POR_COMPROVANTE", "CONTA_REGISTRADA", "DOCUMENTO_VINCULADO"].includes(pos?.situacao) ? DECISAO.EXECUTADO : DECISAO.PROPOSTA, motivo: dados.tipo, escopo, propostaId: proposta.id, resposta: texto, injecao, extra, privado });
  }

  /** Categoria do plano da unidade pela descrição (uma só categoria casando); senão null → provisória "a classificar" (revisão humana). */
  async function categoriaDaDespesa(escopo, saida, legenda) {
    try {
      const p = await porta.ler("consultarPlanoDeContas", escopo, undefined);
      // 24/11 (correção): o plano vem como ÁRVORE (lista de grupos com `filhas`); antes só `categorias`/`itens` eram lidos e nenhuma
      // categoria era escolhida (tudo ia para "a classificar"). Achata a árvore; a regra continua: só UMA categoria lançável casando.
      const plano = [];
      const visitar = (xs) => { for (const c of xs ?? []) { plano.push(c); visitar(c?.filhas); } };
      visitar(Array.isArray(p) ? p : p?.categorias ?? p?.itens ?? []);
      return escolherCategoria({ categorias: plano, categoriaSugerida: saida.categoriaSugerida, legenda });
    } catch { return null; }
  }

  /**
   * 23/11 — PERGUNTA objetiva de divergência: guarda a pendência (a resposta continua a operação) e responde no grupo ou, com valor,
   * conforme a política de resposta (privado). Nada é gravado no Financeiro.
   */
  async function perguntar({ evento, escopo, saida, injecao, unidade, grupo = null, participante = null }, divergencia, texto, motivo) {
    const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]);
    const privado = rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null;
    // A resposta vem na MESMA conversa em que a pergunta saiu (grupo ou privado): é por ela que a memória curta reencontra a pendência.
    await a.mensagens.lembrar(evento.mensagemId, { grupoId: privado?.destino ?? evento.grupoId, pendente: { evento, saida, divergencia } });
    return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo, escopo, resposta: texto, injecao, extra: { divergencia: divergencia.tipo }, privado });
  }

  async function tratarPagamento(ctx) {
    const { evento, escopo, saida, injecao, esclarecimento } = ctx;
    // Execução 17: comprovante AGENDADO, PENDENTE ou CANCELADO não é pagamento — nada é proposto como pago.
    if (evento.midia && saida.tipoDocumento === "COMPROVANTE_PAGAMENTO") {
      const av = avaliarComprovante(saida, { hoje: hoje() });
      if ([SITUACAO_COMPROVANTE.PIX_AGENDADO, SITUACAO_COMPROVANTE.TRANSFERENCIA_PENDENTE, SITUACAO_COMPROVANTE.TRANSACAO_CANCELADA].includes(av.situacao)) {
        await marcarDocumento(evento, escopo, null, saida);
        return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: av.situacao, escopo, resposta: RESPOSTA.comprovanteNaoConcluido(av.situacao), injecao, extra: { comprovante: av.situacao } });
      }
    }
    if (!saida.dataPagamento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "DATA_DE_PAGAMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["data do pagamento"]), injecao });
    // CAIXA: o mês do pagamento precisa estar aberto (a saída de dinheiro cai nele).
    const bloqueio = await competenciaAberta(ctx, mes(saida.dataPagamento));
    if (bloqueio) return bloqueio;
    const abertas = await porta.contasAPagarAbertas(escopo);
    const valor = saida.valorCentavos;
    const legenda = evento.midia ? legendaDoDocumento(evento.texto) : null; // legenda da mensagem original: descrição e evidência (entrada não confiável)
    let candidatas = saida.favorecido ? abertas.filter((t) => fornecedorCompativel(saida.favorecido, t)) : abertas.filter((t) => t.saldoCentavos === valor);
    let forcarNova = false; let contaEscolhida = null; let parcialConfirmado = false;

    // 23/11 — RESPOSTA a uma pergunta de divergência: a operação CONTINUA (sem segunda confirmação) conforme o que a pessoa disse.
    if (esclarecimento?.divergencia) {
      const pend = esclarecimento.divergencia;
      const desf = interpretarResposta(esclarecimento.texto, pend);
      // O saldo pode ter mudado entre a pergunta e a resposta: a conta é relida pelo id, nunca usada do que foi guardado.
      const porId = (id) => abertas.find((t) => t.id === id) ?? null;
      if (desf.desfecho === DESFECHO.NAO_ENTENDI) return perguntar(ctx, pend, RESPOSTA.naoEntendiDivergencia(), "RESPOSTA_NAO_ENTENDIDA");
      if (desf.desfecho === DESFECHO.NOVA) forcarNova = true;
      else if (pend.tipo === TIPO_DIVERGENCIA.SEMELHANTE && pend.candidatas[0]?.situacao === "PAGA") {
        // "É o mesmo pagamento?" — sim: nada novo; o registro existente é informado (nunca segunda despesa, baixa ou saída).
        const existente = (await porta.contasAPagarTodas(escopo)).find((t) => t.id === pend.candidatas[0].id) ?? null;
        await marcarDocumento(evento, escopo, null, saida);
        return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "PAGAMENTO_IGUAL_JA_REGISTRADO", escopo, resposta: existente ? RESPOSTA.pagamentoJaRegistrado(existente) : RESPOSTA.duplicado(null), injecao });
      } else {
        contaEscolhida = porId(desf.desfecho === DESFECHO.ESCOLHER ? pend.candidatas[desf.indice]?.id : pend.candidatas[0]?.id);
        if (!contaEscolhida) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CONTA_NAO_ESTA_MAIS_ABERTA", escopo, resposta: RESPOSTA.faltaInformacao(["qual conta este comprovante paga (ela mudou desde a pergunta; reenvie o comprovante)"]), injecao });
        if (desf.desfecho === DESFECHO.PARCIAL) parcialConfirmado = true;
        if (desf.desfecho === DESFECHO.JUROS) {
          if (valor <= contaEscolhida.saldoCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "JUROS_SEM_DIFERENCA", escopo, resposta: RESPOSTA.faltaInformacao(["a diferença não existe mais (o saldo mudou); reenvie o comprovante"]), injecao });
          const juros = valor - contaEscolhida.saldoCentavos;
          // Juros CONFIRMADOS: nenhuma segunda conta. O pagamento com juros (saída + juros classificados) é aplicado pelo Financeiro na
          // Central pelo mesmo serviço oficial de "Paguei pelo banco" (a diferença vira juros e multas); o MOVA não tem ação para isso.
          return criarProposta(ctx, {
            tipo: TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, valorCentavos: valor, parcial: false,
            datas: { competencia: contaEscolhida.competencia, caixa: saida.dataPagamento, vencimento: contaEscolhida.vencimento },
            comando: { operacao: "pagarContaAPagar", entrada: { obrigacaoId: contaEscolhida.id, contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor },
              juros: { valorCentavos: juros, principalCentavos: contaEscolhida.saldoCentavos, confirmadoPor: esclarecimento.participanteId } },
          }, (p) => RESPOSTA.jurosAguardandoFinanceiro(p, contaEscolhida, juros), {
            // Com as chaves, a política JUROS_DOCUMENTAL (limite = encargo máximo) e a ação `registrar_juros`: registra encargo + pagamento por comprovante.
            posCriacao: execucao?.registrarJuros ? async (p) => {
              const r = await execucao.aposJuros(p, escopo);
              return r.situacao === "PAGO_POR_COMPROVANTE" ? { ...r, texto: RESPOSTA.pagoComJuros(p, r.resultado) } : r;
            } : null,
          });
        }
      }
    }

    if (!forcarNova) {
      const casamento = contaEscolhida
        ? { caso: valor === contaEscolhida.saldoCentavos ? "EXATA" : valor > contaEscolhida.saldoCentavos ? "MAIOR" : "MENOR", conta: contaEscolhida }
        : classificarCasamento({ valorCentavos: valor, candidatas });
      const baixa = (t) => criarProposta(ctx, {
        // BAIXA de obrigação existente: competência é a DA OBRIGAÇÃO; caixa é a data do pagamento. Não concilia extrato.
        tipo: TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, valorCentavos: valor, parcial: valor < t.saldoCentavos,
        datas: { competencia: t.competencia, caixa: saida.dataPagamento, vencimento: t.vencimento },
        comando: { operacao: "pagarContaAPagar", entrada: { obrigacaoId: t.id, contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
      }, RESPOSTA.propostaBaixa, { posCriacao: execucao ? async (p) => textoDaExecucao(p, await execucao.aposBaixa(p, escopo)) : null });
      // Cenários: A/B (exata) executa; D (menor) só com evidência de parcial; C (maior) e E (várias) SEMPRE perguntam — a diferença
      // nunca é presumida como juros, nem a conta como compra nova.
      if (casamento.caso === "EXATA") return baixa(casamento.conta);
      if (casamento.caso === "MENOR") {
        if (parcialConfirmado || legendaIndicaParcial(legenda)) return baixa(casamento.conta);
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.MENOR, valorCentavos: valor, candidatas: [{ id: casamento.conta.id }] }, RESPOSTA.perguntaValorMenor(casamento.conta, valor), "VALOR_MENOR_QUE_SALDO", [casamento.conta]);
      }
      if (casamento.caso === "MAIOR") return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.MAIOR, valorCentavos: valor, candidatas: [{ id: casamento.conta.id }] }, RESPOSTA.perguntaValorMaior(casamento.conta, valor), "VALOR_MAIOR_QUE_SALDO", [casamento.conta]);
      if (casamento.caso === "VARIAS") {
        const proximas = [...casamento.candidatas].sort((x, y) => Math.abs(x.saldoCentavos - valor) - Math.abs(y.saldoCentavos - valor)).slice(0, MAX_CANDIDATAS_NA_PERGUNTA);
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.VARIAS, valorCentavos: valor, candidatas: proximas.map((t) => ({ id: t.id })) }, RESPOSTA.perguntaVariasContas(proximas), "VARIAS_OBRIGACOES_COMPATIVEIS", proximas);
      }
    }
    // Nenhuma conta do favorecido (ou a pessoa disse "outra compra"): compra NOVA — mas a AUSÊNCIA de conta do mesmo favorecido não é,
    // sozinha, prova de compra nova: antes, procura o mesmo pagamento já registrado e conta aberta de outro fornecedor com o mesmo valor.
    if (!forcarNova && !esclarecimento?.divergencia) {
      const semelhantes = buscarSemelhantes({ todas: await porta.contasAPagarTodas(escopo), valorCentavos: valor, favorecido: saida.favorecido, legenda, dataPagamento: saida.dataPagamento, compativel: (t) => fornecedorCompativel(saida.favorecido, t) });
      if (semelhantes.length) {
        const [primeiro] = semelhantes;
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.SEMELHANTE, valorCentavos: valor, candidatas: [{ id: primeiro.conta.id, situacao: primeiro.situacao }] },
          primeiro.situacao === "PAGA" ? RESPOSTA.perguntaSemelhantePaga(primeiro.conta) : RESPOSTA.perguntaSemelhanteAberta(primeiro.conta), "POSSIVEL_COMPRA_JA_REGISTRADA");
      }
    }
    // 15A: competência = a INFORMADA (ou o mês da emissão do documento, que é fato do documento). Nunca o mês do vencimento,
    // do pagamento ou do recebimento: sem ela, a proposta nasce com competência PENDENTE, a confirmar na revisão humana.
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? null;
    const bloqueioEconomico = competencia ? await competenciaAberta(ctx, competencia) : null;
    if (bloqueioEconomico) return bloqueioEconomico;
    const categoria = await categoriaDaDespesa(escopo, saida, legenda);
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.dataPagamento, descricao: legenda ? mascararDadosSensiveis(legenda).slice(0, 120) : null, categoria });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.DESPESA_PAGA, valorCentavos: valor, parcial: false,
      datas: { competencia, caixa: saida.dataPagamento, vencimento: saida.dataPagamento }, competenciaPendente: !competencia,
      // Execução 17: com comprovante, a aplicação registra a conta e o pagamento POR COMPROVANTE (nenhuma saída bancária
      // criada; o extrato concilia depois). Sem arquivo (relato por texto), a pessoa escolhe a conta do pagamento.
      comando: { operacao: evento.midia ? "registrarObrigacao+registrarPagamentoPorComprovante" : "registrarObrigacao+pagarContaAPagar", entrada: comando.valor, pagamento: { contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
    }, comAvisoDeCompetencia(RESPOSTA.propostaDespesaPaga, competencia), {
      // 23/11: com as chaves e a política DESPESA_DOCUMENTAL, a rotina registra a conta e o pagamento por comprovante.
      posCriacao: execucao?.criarDespesas && evento.midia ? async (p) => {
        const r = await execucao.aposDespesaNova(p, escopo);
        return r.situacao === "PAGO_POR_COMPROVANTE" ? { ...r, texto: RESPOSTA.despesaPagaPorComprovante(p, r.resultado) } : r;
      } : null,
    });
  }

  async function tratarConta(ctx) {
    const { evento, escopo, saida, injecao } = ctx;
    // 24/11: NOTA FISCAL de uma conta JÁ registrada (mesmo fornecedor e mesmo valor, qualquer vencimento): não duplica a despesa —
    // a nota é VINCULADA à conta existente. Mais de uma conta compatível: vai para a conferência (nunca escolhe sozinho).
    if (evento.midia && saida.tipoDocumento === "NOTA_FISCAL" && saida.favorecido) {
      const daNota = (await porta.contasAPagarTodas(escopo)).filter((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === saida.valorCentavos && fornecedorCompativel(saida.favorecido, t));
      if (daNota.length === 1) {
        const [t] = daNota;
        return criarProposta(ctx, {
          tipo: TIPO_PROPOSTA.VINCULO_DE_DOCUMENTO, valorCentavos: saida.valorCentavos, parcial: false,
          datas: { competencia: t.competencia ?? null, caixa: null, vencimento: t.vencimento ?? null },
          comando: { operacao: "vincularDocumento", entrada: { obrigacaoId: t.id } },
        }, (p) => RESPOSTA.notaParaVincular(p, t), {
          posCriacao: execucao?.criarContas ? async (p) => {
            const r = await execucao.aposVinculoDeDocumento(p, escopo);
            return r.situacao === "DOCUMENTO_VINCULADO" ? { ...r, texto: RESPOSTA.notaVinculada(t) } : r;
          } : null,
        });
      }
      if (daNota.length > 1) {
        return criarProposta(ctx, { tipo: TIPO_PROPOSTA.SOLICITACAO_DE_REVISAO, valorCentavos: saida.valorCentavos, parcial: false, datas: {}, comando: null }, RESPOSTA.notaComVariasContas);
      }
    }
    if (!saida.vencimento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VENCIMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["vencimento"]), injecao });
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? null; // 15A: nunca o mês do vencimento
    const bloqueio = competencia ? await competenciaAberta(ctx, competencia) : null;
    if (bloqueio) return bloqueio;
    const todas = await porta.contasAPagarTodas(escopo);
    const igual = todas.find((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === saida.valorCentavos && t.vencimento === saida.vencimento && (!saida.favorecido || fornecedorCompativel(saida.favorecido, t)));
    if (igual) {
      await marcarDocumento(evento, escopo, null, saida);
      return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "OBRIGACAO_JA_REGISTRADA", escopo, resposta: RESPOSTA.obrigacaoJaExiste(igual), injecao });
    }
    // 24/11: categoria do plano (uma só casando com a legenda/sugestão) e a descrição da legenda, como na compra nova (PR #188).
    const legenda = evento.midia ? legendaDoDocumento(evento.texto) : null;
    const categoria = await categoriaDaDespesa(escopo, saida, legenda);
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.vencimento, descricao: legenda ? mascararDadosSensiveis(legenda).slice(0, 120) : null, categoria });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.NOVA_OBRIGACAO, valorCentavos: saida.valorCentavos, parcial: false,
      datas: { competencia, caixa: null, vencimento: saida.vencimento }, competenciaPendente: !competencia, categoriaDefinida: Boolean(categoria),
      comando: { operacao: "registrarObrigacao", entrada: comando.valor },
    }, comAvisoDeCompetencia(RESPOSTA.propostaObrigacao, competencia), {
      // 24/11: com a chave MOVA_OPERACAO_CRIAR_CONTAS e a política CONTA_A_PAGAR automática, registra a conta (em aberto) e anexa o documento.
      posCriacao: execucao?.criarContas && evento.midia ? async (p) => {
        const r = await execucao.aposContaNova(p, escopo);
        return r.situacao === "CONTA_REGISTRADA" ? { ...r, texto: RESPOSTA.contaRegistrada(p, r.resultado) } : r;
      } : null,
    });
  }

  /** Texto da resposta conforme o que a execução fez com a baixa (nada é dito como lançado sem ter sido). */
  function textoDaExecucao(p, r) {
    if (r.situacao === "EXECUTADA") return { ...r, texto: RESPOSTA.baixaExecutada(p, r.resultado) };
    if (r.situacao === "PAGO_POR_COMPROVANTE") return { ...r, texto: RESPOSTA.pagoPorComprovante(p, r.resultado) };
    if (r.situacao === "AGUARDANDO_EXTRATO" && r.comprovante === SITUACAO_COMPROVANTE.PIX_CONCLUIDO && r.nivelDocumental === NIVEL_APLICAR_COM_CONFIRMACAO) return { ...r, texto: RESPOSTA.comprovanteAguardandoConfirmacao(p) };
    // Com política de baixa documental, o comprovante que não serviu de evidência diz o porquê (sem política: só aguarda o extrato).
    if (r.situacao === "AGUARDANDO_EXTRATO" && r.comprovante && r.comprovante !== SITUACAO_COMPROVANTE.PIX_CONCLUIDO && !(r.motivosDocumentais ?? []).includes("SEM_POLITICA")) {
      return { ...r, texto: `${RESPOSTA.propostaBaixa(p)} ${RESPOSTA.aguardandoExtrato()} ${RESPOSTA.comprovanteEmRevisao(r.comprovante)}` };
    }
    if (r.situacao === "CONFERIDA") return { ...r, texto: RESPOSTA.baixaConferida(p) };
    if (r.situacao === "AMBIGUA") return { ...r, texto: `${RESPOSTA.propostaBaixa(p)} ${RESPOSTA.extratoAmbiguo()}` };
    return { ...r, texto: `${RESPOSTA.propostaBaixa(p)} ${RESPOSTA.aguardandoExtrato()}` };
  }

  const comAvisoDeCompetencia = (texto, competencia) => (competencia ? texto : (p) => `${texto(p)} A competência ficou para confirmar na revisão.`);

  /** Comando no contrato REAL do Financeiro v2; categoria PROVISÓRIA (a sugestão da IA fica ao lado, para quem aprova). */
  function comandoDeObrigacao(saida, { competencia, vencimento, descricao = null, categoria = null }) {
    // 15A: competência pendente — os DEMAIS campos são validados (com um mês provisório só para a validação) e o comando é
    // guardado SEM competência; quem revisa informa a competência e a aplicação recusa enquanto ela faltar.
    if (!competencia) {
      const r = comandoDeObrigacao(saida, { competencia: mes(vencimento), vencimento, descricao, categoria });
      if (!r.ok) return r;
      const { competencia: _provisoria, ...semCompetencia } = r.valor;
      return { ok: true, valor: semCompetencia };
    }
    const emissao = saida.dataEmissao && saida.dataEmissao <= vencimento ? saida.dataEmissao : (hoje() <= vencimento ? hoje() : vencimento);
    const bruto = {
      contraparteNova: { tipo: "FORNECEDOR", nome: saida.favorecido ?? "Favorecido a identificar" },
      valorOriginalCentavos: saida.valorCentavos, categoria: categoria ?? porta.categoriaProvisoria,
      descricao: descricao ?? `${saida.tipoDocumento === "BOLETO" ? "Boleto" : saida.tipoDocumento === "NOTA_FISCAL" ? "Nota fiscal" : "Comprovante"} recebido pelo MOVA`,
      competencia, dataEmissao: emissao, vencimento,
      ...(saida.identificadorDocumento ? { identificador: saida.identificadorDocumento } : {}),
    };
    try {
      return { ok: true, valor: porta.validarComandoDeObrigacao(bruto) };
    } catch (e) {
      if (porta.ehErroDeRegra(e)) return { ok: false, campo: e.detalhes?.campo ?? "dados do documento" };
      throw e;
    }
  }

  /** Recorte (período) da consulta, para a continuidade: só datas/competência já validadas, nunca texto. */
  const recorteDe = (s) => (s.competencia || s.periodoInicio || s.periodoFim ? { competencia: s.competencia ?? null, periodoInicio: s.periodoInicio ?? null, periodoFim: s.periodoFim ?? null } : null);

  /** Contexto comum das ferramentas: período explícito na resposta e data de referência do motor. */
  function contextoDaConsulta(saida) {
    const periodo = periodoDaConsulta(saida, hoje());
    return { periodo: { ...periodo, explicito: Boolean(saida.periodoInicio || saida.periodoFim) }, hoje: hoje(), saida };
  }

  /** Consulta de UMA unidade, pela ferramenta do catálogo. Sem dados = diz que não há (nunca estima). */
  /** Agente 2: a resposta desta consulta sai no grupo ou no privado do participante? (conversa privada = sai nela mesma) */
  async function roteamento(grupo, participante, evento, consulta, unidades) {
    if (!grupo || !evento.grupoId.endsWith("@g.us") || (grupo.acesso ?? ACESSO.ABERTO) !== ACESSO.LISTA || consultaPodeSairNoGrupo(grupo, consulta)) return null;
    // Política do grupo: GRUPO_FINANCEIRO só responde no grupo com o retrato RECENTE dos membros e todos autorizados.
    const retrato = grupo.politicaResposta === POLITICA_RESPOSTA.GRUPO_FINANCEIRO && typeof a.membros?.obter === "function" ? await a.membros.obter(grupo.grupoId) : null;
    const d = decidirSaidaNoGrupo({ grupo, consulta, unidades, retrato, agora: relogio() });
    if (d.saida === "GRUPO") return { noGrupo: true, motivo: d.motivo, detalhe: d.detalhe === true };
    const jid = destinoPrivado(participante, evento.participanteId);
    // Só endereça uma conversa privada que a configuração conhece (derivada da lista): nunca um JID qualquer.
    const destino = jid && cfg.gruposAutorizados.some((g) => g.derivada && g.grupoId === jid) ? jid : null;
    return { destino, motivo: d.motivo, ...(d.saida === "RECUSAR" ? { recusar: true } : {}) };
  }
  /** Concluir uma consulta conforme a rota: no grupo (null/noGrupo), no privado, ou recusada (grupo operacional). */
  function rotaParaConcluir(rota) {
    if (!rota || rota.noGrupo) return { privado: null, extraRota: rota ? { politicaResposta: rota.motivo } : {} };
    return { privado: rota, extraRota: { politicaResposta: rota.motivo } };
  }
  const perfilPodeConsultarAlguma = (participante, consulta) => participante.aberto || participante.unidades.some((u) => perfilPodeConsultar(perfilNa(participante, u), consulta));

  async function responderConsulta({ evento, escopo, unidade, saida, injecao, grupo = null, participante = null, interpretacao = "IA" }, consulta) {
    const rota = await roteamento(grupo, participante, evento, consulta, [unidade.unidadeId]);
    if (rota?.recusar) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: rota.motivo, escopo, resposta: RESPOSTA.grupoOperacional(), injecao });
    const { privado, extraRota } = rotaParaConcluir(rota);
    const marca = { interpretacao, ...extraRota };
    const ferramenta = ferramentas[consulta];
    if (!ferramenta) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `CONSULTA_SEM_FERRAMENTA:${consulta}`, escopo, resposta: RESPOSTA.faltaInformacao(["o que você quer consultar"]), injecao });
    // Detalhe por conta e fornecedor: no grupo, só com TODOS os membros FINANCEIRO na unidade; no privado (a conversa derivada ou
    // o desvio da resposta para o privado), só se quem perguntou é FINANCEIRO na unidade. Fora disso, só agregados.
    const detalhe = rota?.noGrupo ? rota.detalhe === true
      : rota?.destino ? podeVerDetalhe(participante, unidade.unidadeId)
      : !rota && grupo?.derivada === true && !evento.grupoId.endsWith("@g.us") ? podeVerDetalhe(participante, unidade.unidadeId) : false;
    // palavrasDaUnidade: o nome/apelidos da unidade citados na pergunta ("…da Alfa") não entram na busca da conta.
    const c = { ...contextoDaConsulta(saida), detalhe, pergunta: evento.texto ?? "", palavrasDaUnidade: unidade.apelidos ?? [] };
    const r = await ferramenta(escopo, c);
    if (r.dadosInsuficientes) {
      return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: `${consulta}:DADOS_INSUFICIENTES`, escopo, resposta: RESPOSTA.dadosInsuficientes(`${unidade.nome} (${r.rotulo ?? c.periodo.rotulo})`), injecao, extra: { motivoSemDados: r.motivo, ...marca }, privado, consulta, contextoConversa: recorteDe(saida) });
    }
    // 16A: rastreabilidade — quando o Financeiro foi lido (os números podem mudar com novas importações).
    const lidoEm = relogio().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    // Agente 2: consulta de posição (vencidas, maiores, sem comprovante…) diz a data da posição, não uma competência que não usou.
    const rotulo = r.rotulo ?? c.periodo.rotulo;
    const linhas = [`${unidade.nome} — ${rotulo}:`, ...r.linhas.map((l) => `• ${l}`), `Posição do Financeiro em ${lidoEm}. Detalhes no Centro Financeiro.`];
    // 15A (desligado por padrão): resposta natural redigida SÓ a partir das linhas calculadas aqui; o redator valida e, em
    // qualquer dúvida, devolve o texto determinístico.
    const padrao = RESPOSTA.consulta(linhas);
    const redacao = redator ? await redator.redigir({ textoPadrao: padrao, fatos: [`${unidade.nome} — ${rotulo}`, ...r.linhas], pergunta: evento.texto }) : null;
    return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: consulta, escopo, resposta: redacao?.texto ?? padrao, injecao, extra: { ...marca, ...(redacao ? { redacao: redacao.origem, redacaoMotivo: redacao.motivo } : {}) }, privado, consulta, contextoConversa: recorteDe(saida) });
  }

  /** Consulta das unidades do grupo: cada uma separada; total só quando TODAS têm o valor (senão "total indisponível"). */
  async function responderConsultaDoGrupo(evento, grupo, consulta, saida, injecao, { grupo: original = null, participante = null, interpretacao = "IA" } = {}) {
    const unidades = cfg.unidades.filter((x) => grupo.unidades.includes(x.unidadeId));
    const rota = await roteamento(original, participante, evento, consulta, unidades.map((x) => x.unidadeId));
    if (rota?.recusar) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: rota.motivo, resposta: RESPOSTA.grupoOperacional(), injecao });
    const { privado, extraRota } = rotaParaConcluir(rota);
    const ferramenta = ferramentas[consulta];
    if (!ferramenta) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `CONSULTA_SEM_FERRAMENTA:${consulta}`, resposta: RESPOSTA.faltaInformacao(["o que você quer consultar"]), injecao });
    const c = contextoDaConsulta(saida);
    const linhas = [`${c.periodo.rotulo}:`];
    const valores = [];
    for (const u of unidades) {
      const r = await ferramenta(escopoDe(u), c);
      linhas.push(r.dadosInsuficientes ? `• ${u.nome}: dados insuficientes.` : `• ${u.nome}: ${r.linhas.join("; ")}`);
      valores.push(r.dadosInsuficientes ? null : r.valorCentavos ?? null);
    }
    // 24/11: empresas diferentes (ex.: Açaí e Subway na mesma conversa privada multiempresa) nunca são somadas.
    const empresas = new Set(unidades.map((u) => u.organizacaoId));
    if (consulta === "FATURAMENTO") linhas.push(empresas.size > 1 ? "Total: não somado (unidades de empresas diferentes)."
      : valores.every((v) => typeof v === "number") ? `Total das unidades: ${reais(valores.reduce((s, v) => s + v, 0))}.` : "Total das unidades: indisponível (há unidade sem dados).");
    return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: consulta, resposta: RESPOSTA.consulta(linhas), injecao, privado, consulta, contextoConversa: recorteDe(saida), extra: { interpretacao, ...extraRota } });
  }

  return Object.freeze({ processar });
}

function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10);
}
