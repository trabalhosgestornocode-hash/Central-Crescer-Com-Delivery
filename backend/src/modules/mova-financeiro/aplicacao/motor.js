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
import { camposAlterados, podeConfirmarPendencia, versaoDaConta } from "../dominio/confirmacao.js";
import { chaveDoDocumento } from "../dominio/documentos.js";
import { esclarecerIncertezas } from "../dominio/esclarecimento.js";
import { SITUACAO_COMPROVANTE, avaliarComprovante } from "../dominio/comprovante.js";
import { grupoAutorizado, mascarar, normalizar, requisitosParaOperacao } from "../dominio/configuracao.js";
import { RESULTADO_UNIDADE, resolverUnidade, unidadesCitadas } from "../dominio/unidade.js";
import { CANAIS_SO_PELA_PLATAFORMA, fontesOficiais } from "../dominio/fontesDeReceita.js";
import { ehSaudacaoOuAjuda, mascararDadosSensiveis, pedidoForaDoEscopo, pedidoRestrito } from "../dominio/privacidade.js";
import { INTENCOES_BLOQUEADAS, INTENCOES_DE_REVISAO, SAIDA_VAZIA, sinaisDeInjecao, validarSaidaDaIa } from "../ia/contratos.js";
import { RESPOSTA, reais } from "./respostas.js";
import { TIPO_CORRECAO, criarCorrecaoNaConversa, ehPendenciaDeCorrecao } from "./correcaoNaConversa.js";
import { criarFerramentas, periodoDaConsulta } from "./ferramentas.js";
import { ErroTransitorio } from "../gateway/fila.js";
import { ACESSO, CAPACIDADES, JANELA_CONTINUIDADE_MS, chamaPeloNome, POLITICA_RESPOSTA, algumaUnidadePermite, consultaPodeSairNoGrupo, decidirSaidaNoGrupo, destinoPrivado, participanteAutorizado, perfilNa, perfilPodeConsultar, podeVerDetalhe, identificarParticipante } from "../dominio/participantes.js";
import { interpretarComando, interpretarSeguimento, saidaDeContinuacao } from "./comandos.js";
import { MIMES_SEM_LEITURA, MODO_SEM_LEITURA, RESPOSTA_DOCUMENTO, conferirArquivo, legendaDoDocumento, protocoloDoDocumento } from "./recebimentoDocumental.js";
import { MIDIA_RECUSADA } from "../contratos/evento.js";
import { categoriaPatrimonialDoRelato, observacaoDoTexto, classificarContaRelatada, competenciaDoRelato, complementoDaResposta, ehPatrimonialForaDaDre, interpretarContaRelatada, interpretarRespostaDaCategoria, interpretarRespostaDoValor } from "../dominio/contaRelatada.js";
import { contaCompativelComPeriodo, idTransacaoConfiavel, periodoDaLegenda } from "../dominio/periodo.js";
import { DESFECHO, TIPO_DIVERGENCIA, MAX_CANDIDATAS_NA_PERGUNTA, buscarSemelhantes, classificarCasamento, competenciaDaResposta, composicaoComprovada, composicaoSoPrincipal, pedidoDeRetomar, confirmacaoDeProposta, interpretarCategoria, respostaSimNao, favorecidosCompativeis, DOCUMENTOS_COMPLEMENTARES, descreverPendencia, descricaoDireta, desfechoPorFinalidade, diferencaPlausivelComoJuros, escolherCategoria, extracaoDaRespostaIA, interpretarResposta, legendaIndicaParcial, parecerRespostaDeDivergencia } from "../dominio/divergencia.js";

const NIVEL_APLICAR_COM_CONFIRMACAO = "APLICAR_COM_CONFIRMACAO";
/** 26/11: fuso da operação (Açaí e Subway Saci): data da mensagem, competência e ano das parcelas relatadas. */
export const FUSO_DA_OPERACAO = "America/Fortaleza";
/** 26/11: conta relatada sem fornecedor dito — o nome é este marcador, nunca um fornecedor deduzido. */
export const FORNECEDOR_NAO_INFORMADO = "Fornecedor não informado";
export const DECISAO = Object.freeze({
  IGNORADO: "IGNORADO", BLOQUEADO: "BLOQUEADO", PEDIR_INFORMACAO: "PEDIR_INFORMACAO", DUPLICADO: "DUPLICADO",
  CONSULTA: "CONSULTA", ORIENTACAO: "ORIENTACAO", PROPOSTA: "PROPOSTA", FALHA_LEITURA: "FALHA_LEITURA",
  EXECUTADO: "EXECUTADO", // Agente 2 — Frente C: operação aplicada pelo serviço oficial conforme a política de autonomia
  DOCUMENTO_RECEBIDO: "DOCUMENTO_RECEBIDO", // Agente 2 — documento guardado para conferência humana, sem leitura e sem proposta
});
export const TIPO_PROPOSTA = Object.freeze({ BAIXA_DE_OBRIGACAO: "BAIXA_DE_OBRIGACAO", DESPESA_PAGA: "DESPESA_PAGA", NOVA_OBRIGACAO: "NOVA_OBRIGACAO", SOLICITACAO_DE_REVISAO: "SOLICITACAO_DE_REVISAO",
  // 24/11 (0015): nota fiscal de uma conta JÁ registrada — só anexa o documento à conta (nenhum valor muda).
  VINCULO_DE_DOCUMENTO: "VINCULO_DE_DOCUMENTO",
  // 26/11 (0025): conta a pagar relatada por texto (parcelas explícitas, sem documento) e pagamento feito por outra empresa do grupo.
  CONTA_RELATADA: "CONTA_RELATADA", INTERCOMPANY: "INTERCOMPANY" });
const PAGAMENTOS = ["COMPROVANTE_PAGAMENTO", "RECIBO"];
const CONTAS = ["BOLETO", "NOTA_FISCAL"];
const CONSULTAS_DO_GRUPO = ["COMPARATIVO_UNIDADES", "SITUACAO_PROPOSTAS"];
const PEDIDO_DE_APROVACAO = /^\s*(aprov[ao]r?|aprovad[oa]|aplic[ao]r?|pode\s+aprovar|autoriz[ao]r?)\b/i;
// Execução 14 (achado real: o Haiku leu "faça o pagamento" como REGISTRAR_CONTA): pedido para EXECUTAR pagamento/transferência
// é barrado pelo backend antes da IA. "paguei" (relato) não casa: só imperativo/pedido.
/** 15A: validade da memória curta (esclarecimento sem citação). */
export const MEMORIA_CURTA_MS = 10 * 60 * 1000;
/** 24/11: validade de uma pendência retomada por CITAÇÃO da pergunta do MOVA (a conta é relida de qualquer forma). */
export const PENDENCIA_CITADA_VALIDADE_MS = 72 * 60 * 60 * 1000;
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
export function criarMotor({ cfg, porta, extrator, armazenamento: a, relogio = () => new Date(), registrar = () => {}, redator = null, somenteConsultas = false, comandosDeterministicos = false, execucao = null, entregadores = null, recebimentoDocumental = false, obterEvidencia = null, conversaNova = null }) {
  const hoje = () => relogio().toISOString().slice(0, 10);
  const ACAO = porta.acoes;
  const servico = cfg.identidadeServico.usuarioId;
  const escopoDe = (u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico });
  const ferramentas = criarFerramentas({ porta, armazenamento: a });
  // 28/11 (Operador Financeiro, fase 1): correção cadastral de conta a pagar pela conversa (operação oficial do núcleo; sem IA)
  const correcoes = criarCorrecaoNaConversa({ cfg, porta, armazenamento: a, execucao, concluir: (...x) => concluir(...x), escopoDe, hoje, DECISAO,
    // mesma regra de saída das demais operações financeiras; a correção mostra a CONTA e o FORNECEDOR ⇒ no grupo só com o "detalhe"
    // (todos os membros FINANCEIRO nas unidades da conta); senão, no privado de quem fala
    rotear: async (g, p, e, us) => {
      const r = await roteamento(g, p, e, "DOCUMENTO_COM_VALOR", us);
      if (!r?.noGrupo || r.detalhe === true || !us.length) return r;
      const jid = destinoPrivado(p, e.participanteId);
      return { destino: jid && cfg.gruposAutorizados.some((x) => x.derivada && x.grupoId === jid) ? jid : null, motivo: "DETALHE_SO_PARA_FINANCEIRO" };
    } });

  async function concluir(evento, { decisao, motivo, escopo = null, resposta = null, respostasExtras = [], propostaId = null, injecao = false, extra = {}, privado = null, consulta = null, contextoConversa = null }) {
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
    } else if (resposta) {
      await a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: evento.mensagemId, eventoId: evento.eventoId, texto: mascararDadosSensiveis(resposta), simulada: true });
      // 25/11: partes de uma lista montada pelo servidor (MOVA CORE), na ordem, no MESMO destino (só conversa privada chega aqui)
      for (const parte of respostasExtras ?? []) if (parte) await a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: null, eventoId: evento.eventoId, texto: mascararDadosSensiveis(parte), simulada: true });
    }
    // Continuidade: depois de responder, escuta a próxima mensagem DESTE participante nesta conversa (e lembra unidade/consulta).
    if (resposta && evento.participanteId && typeof a.conversas?.registrar === "function") {
      await a.conversas.registrar({ grupoId: evento.grupoId, participanteId: evento.participanteId, unidadeId: escopo?.unidadeId ?? null, consulta, contexto: contextoConversa, validadeMs: JANELA_CONTINUIDADE_MS });
    }
    return { decisao, motivo, propostaId, resposta };
  }

  async function lerDocumento(evento, grupo, conversa = null, { perguntaPendente = null } = {}) {
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
    // 24/11: a pergunta que o MOVA fez a esta pessoa e ainda espera resposta (texto do sistema; só para texto sem documento).
    if (perguntaPendente && !evento.midia) contexto.perguntaPendente = perguntaPendente;
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
    const u = resolverUnidade({ cfg, grupo: comDocumentos, textos, marcaBasta: Boolean(esclarecimento) });
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      const nomes = cfg.unidades.filter((x) => comDocumentos.unidades.includes(x.unidadeId)).map((x) => x.nome);
      if ((u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE) && !esclarecimento) {
        // Pendente de identificação: a pessoa já pode enviar documentos em TODAS as unidades oferecidas; o original é guardado
        // (sem unidade) para a resposta poder ser conferida depois, quando a mensagem desta fila já tiver terminado.
        if (midiaLocal) await midiaLocal.guardar();
        await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: { ...SAIDA_VAZIA, legivel: true, tipoDocumento: "DESCONHECIDO", intencao: "DESCONHECIDA", confianca: "BAIXA" } } });
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao, extra: { evidenciaUnidade: u.evidencia, semLeitura: true } });
      }
      const resposta = u.resultado === RESULTADO_UNIDADE.NAO_HABILITADA ? RESPOSTA.unidadeNaoHabilitada(u.unidadeDoDocumento, { documento: Boolean(evento.midia) })
        : u.evidencia === "PAGADOR_FORA_DA_CONVERSA" && u.unidadeDoDocumento ? RESPOSTA.pagadorDeOutraUnidade(u.unidadeDoDocumento)
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
    const u = resolverUnidade({ cfg, grupo, textos: [t], marcaBasta: true }); // resposta a "de qual unidade?": a marca basta
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) return false;
    let resto = ` ${normalizar(t)} `;
    for (const ap of [...u.unidade.apelidos].sort((a, b) => b.length - a.length)) resto = resto.split(` ${ap} `).join(" ");
    return resto.split(" ").filter(Boolean).every((p) => PALAVRAS_DE_LIGACAO.has(p));
  }

  /**
   * 26/11 — RETOMADA SEGURA de uma pendência já tomada (atomicamente) pela resposta `evento`.
   * Antes a resposta ganhava a decisão RELACIONADA ANTES de a operação rodar: uma falha transitória (Financeiro/IA fora) deixava a
   * pendência consumida e a resposta "já decidida" — a nova tentativa da fila virava DUPLICADO e a confirmação se perdia.
   * Agora: (1) a operação roda; (2) falhou com exceção ⇒ a pendência é DEVOLVIDA (aberta de novo) e a exceção sobe para a fila
   * tentar de novo — a resposta continua sem decisão, então a nova tentativa encontra a pendência e a retoma; (3) só depois do
   * sucesso a resposta é marcada RELACIONADA (com quem respondeu: auditoria individual). Nunca retoma duas vezes: a tomada é atômica.
   */
  async function retomarPendencia(evento, pend, motivo, extra = {}) {
    let r;
    try {
      r = await processar(pend.pendente.evento, { esclarecimento: { texto: evento.texto, saida: pend.pendente.saida, divergencia: pend.pendente.divergencia ?? null, observacoes: pend.pendente.observacoes ?? null, porEvento: evento.eventoId, participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null, ...extra } });
    } catch (e) {
      try {
        await a.mensagens.lembrar(pend.pendente.evento.mensagemId, { grupoId: pend.grupoId ?? evento.grupoId, pendente: pend.pendente });
        registrar({ tipo: "MOVA_PENDENCIA_DEVOLVIDA", grupo: mascarar(evento.grupoId) });
      } catch { registrar({ tipo: "MOVA_PENDENCIA_NAO_DEVOLVIDA", grupo: mascarar(evento.grupoId) }); }
      throw e;
    }
    await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo, participanteId: evento.participanteId, organizacaoId: null, unidadeId: null, retomou: pend.pendente.evento.eventoId });
    return r;
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
    // 24/11: pergunta de divergência/descrição pendente DESTA pessoa (só lida), para a resposta LIVRE ser interpretada pela leitura.
    let pendenteSemantico = null;
    let unidadeContexto = null; // 27/11: unidade da mensagem do MOVA que a pessoa citou (nunca a padrão do CORE)
    // 28/11 (Operador Financeiro, fase 1): resposta a uma pergunta da CORREÇÃO de conta (escolha, valor novo, confirmação)
    if (esclarecimento && ehPendenciaDeCorrecao(esclarecimento.divergencia)) return correcoes.continuar({ evento, grupo, esclarecimento });
    // 28/11: resposta à confirmação de CONTA A PAGAR de nota/boleto (política "com confirmação"): a proposta já existe; nada é relido.
    if (esclarecimento?.divergencia?.tipo === "CONTA_NOVA_CONFIRMACAO") return responderConfirmacaoDeContaNova({ evento, grupo, esclarecimento });

    if (!esclarecimento) {
      // 3. Evento repetido (reconexão do Baileys, reenvio do Gateway) — segunda barreira depois da fila.
      // Já registrado E já decidido ⇒ repetido. Registrado SEM decisão = nova tentativa depois de falha transitória: segue.
      const { novo } = await a.eventos.registrar(evento);
      if (!novo && await a.historico.temDecisao(evento.eventoId)) return { decisao: DECISAO.DUPLICADO, motivo: "EVENTO_JA_PROCESSADO" };
      // 4. NÍVEL 1: participante do grupo autorizado é registrado automaticamente (sem cadastro nem login).
      // 23/11: conversa privada de ENTREGADOR não é grupo (mova.participante exige mova.grupo_autorizado): o entregador já é o
      // cadastro dele (mova.entregador_autorizado); registrá-lo aqui derrubava TODA mensagem dele (ERRO_PERMANENTE, sem NF).
      // 24/11: idem a conversa privada DERIVADA da lista (OPERACAO): não é grupo e não tem linha em grupo_autorizado em produção
      // (2 das 9 falhas permanentes de 23/11). O membro é do GRUPO; a privada não registra participante.
      if (novo && !grupo.entregador && !grupo.derivada) {
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
        // 24/11 — só a MESMA pessoa autorizada que enviou o documento responde a pergunta dele (dominio/confirmacao.js).
        // Recusada, a pendência NÃO é consumida: continua aberta para quem perguntou; nada é registrado.
        // 25/11: o tipo da pergunta decide se é COMPLEMENTO (competência, descrição, unidade: outro FINANCEIRO da unidade pode
        // completar) ou CONFIRMAÇÃO de efeito (só quem enviou). O motivo real da recusa fica na decisão e na resposta.
        let motivoRecusa = null;
        const podeConfirmar = (origem, leitura) => {
          const r = podeConfirmarPendencia(cfg, origem, evento, { unidadeId: leitura?.divergencia?.unidadeId ?? leitura?.saida?.unidadeId ?? null, tipo: leitura?.divergencia?.tipo ?? null, unidadesExigidas: leitura?.divergencia?.unidadesExigidas ?? null });
          if (!r.pode) motivoRecusa = r.motivo;
          return r.pode;
        };
        const recusarOutro = () => concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: motivoRecusa === "OUTRO_PARTICIPANTE" || !motivoRecusa ? "CONFIRMACAO_DE_OUTRO_PARTICIPANTE" : `RESPOSTA_RECUSADA:${motivoRecusa}`,
          resposta: motivoRecusa === "SEM_PERMISSAO_FINANCEIRA_NA_UNIDADE" || motivoRecusa === "UNIDADE_FORA_DA_CONVERSA" ? RESPOSTA.complementoSemPermissao() : RESPOSTA.confirmacaoDeOutroParticipante(), extra: { retomou: null } });
        let pend = await a.mensagens.tomarPendente(evento.respostaA, { podeConfirmar, validadeMs: PENDENCIA_CITADA_VALIDADE_MS });
        if (pend?.expirada) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "PENDENCIA_EXPIRADA", resposta: RESPOSTA.pendenciaExpirada(), extra: { retomou: null, citou: "DOCUMENTO" } });
        if (pend?.outroParticipante) return recusarOutro();
        let motivoRelacao = "ESCLARECIMENTO_RECEBIDO";
        let origemCitada = null;
        // 24/11 — CITAÇÃO EXATA: a pessoa citou a PERGUNTA do MOVA (outro id que o do documento). A resposta do MOVA guarda o id
        // confirmado pelo provedor e o EVENTO que a gerou: a pendência é a desse evento, nesta conversa. Nada de aproximação: citação
        // de uma resposta sem pendência não retoma outra operação; pendência fora da validade não continua sem nova conferência.
        if (!pend?.pendente && typeof a.saida.origemDaResposta === "function" && typeof a.mensagens.tomarPendenteDoEvento === "function") {
          const origem = await a.saida.origemDaResposta({ providerMessageId: evento.respostaA, grupoId: evento.grupoId });
          origemCitada = origem ?? null;
          if (origem?.eventoId) {
            pend = await a.mensagens.tomarPendenteDoEvento({ eventoId: origem.eventoId, grupoId: evento.grupoId, validadeMs: PENDENCIA_CITADA_VALIDADE_MS, podeConfirmar });
            motivoRelacao = "RESPOSTA_CITANDO_PERGUNTA";
            if (pend?.outroParticipante) return recusarOutro();
            if (pend?.expirada) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "PENDENCIA_EXPIRADA", resposta: RESPOSTA.pendenciaExpirada(), extra: { retomou: null, citou: "PERGUNTA_DO_MOVA" } });
          }
        }
        if (pend?.pendente) return retomarPendencia(evento, pend, motivoRelacao);
        // 28/11: PEDIDO DE CORREÇÃO citando uma mensagem do MOVA ("adicione uma observação nessa conta: …"): a conta é a da mensagem citada
        const correcaoCitada = evento.texto ? correcoes.interpretar(evento.texto) : null;
        if (correcaoCitada) {
          const doOrigem = origemCitada?.eventoId ? await unidadesDoEvento(origemCitada.eventoId, daPessoa) : [];
          return correcoes.iniciar({ evento, grupo, participante, daPessoa, pedido: correcaoCitada, unidadeContexto: doOrigem.length === 1 ? doOrigem[0].unidadeId : null, origemCitada });
        }
        // 5a0. 27/11 — ESCLARECIMENTO de uma dúvida da leitura ("o 18.000 são os BTUs; o pagamento foi de R$ 260,00") citando a proposta:
        // resolve ESSA dúvida (a original fica na auditoria) e reavalia a proposta pela política vigente. Mesma proposta, sem outra despesa.
        if (origemCitada?.eventoId && evento.texto && !confirmacaoDeProposta(evento.texto)) {
          const esc = await esclarecerProposta(evento, origemCitada.eventoId, { grupo, participante, daPessoa, podeConfirmar, recusarOutro });
          if (esc) return esc;
        }
        // 5a. 25/11 — RETOMADA pela citação da resposta do MOVA sobre uma PROPOSTA (sem pergunta pendente): "registrar", "tenta de novo".
        // Nada novo é exigido (nem novo comprovante); a execução automática é refeita com TUDO revalidado (política, chaves, concessão,
        // competência aberta, duplicidade, fracionamento). Só vale para quem pode complementar a operação nesta unidade.
        if (origemCitada?.eventoId && pedidoDeRetomar(evento.texto)) {
          const retomada = await retomarProposta(evento, origemCitada.eventoId, { grupo, participante, daPessoa, podeConfirmar, recusarOutro });
          if (retomada) return retomada;
        }
        // 5a''. 27/11 — CONFIRMAÇÃO natural ("Confirmado", "pode lançar", "está correto") citando a resposta do MOVA que apresentou uma
        // proposta DESPESA_PAGA: é desta proposta, na unidade DELA (nunca a padrão nem a última consultada). Se só o Centro Financeiro
        // pode aprovar, diz isso; nada é executado por canal não autorizado.
        if (origemCitada?.eventoId && (pedidoDeRetomar(evento.texto) || confirmacaoDeProposta(evento.texto))) {
          // 28/11: CONTA A PAGAR de nota/boleto em revisão (ex.: criada antes da política "com confirmação"): a confirmação citando a resposta
          // do MOVA registra pela política VIGENTE, se quem confirma é FINANCEIRO da unidade. Uma só proposta do evento; senão segue o fluxo.
          if (confirmacaoDeProposta(evento.texto)) {
            const contas = (await a.propostas.porEvento(origemCitada.eventoId)).filter((p) => p.tipo === "NOVA_OBRIGACAO" && p.estado === "AGUARDANDO_REVISAO" && p.evidencia);
            if (contas.length === 1) {
              const pc = contas[0];
              const ev = await a.eventos.obter(origemCitada.eventoId);
              const origem = { participanteId: ev?.participanteId ?? ev?.participante_jid ?? pc.participanteId ?? null, telefoneE164: ev?.telefoneE164 ?? ev?.telefone_e164 ?? null, grupoId: ev?.grupoId ?? ev?.grupo_jid ?? evento.grupoId };
              if (!podeConfirmar(origem, { divergencia: { tipo: "CONTA_NOVA_CONFIRMACAO", unidadeId: pc.unidadeId }, saida: null })) return recusarOutro();
              return registrarContaNovaConfirmada({ evento, grupo, proposta: pc, confirmante: { participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null }, eventoOrigemId: origemCitada.eventoId });
            }
          }
          const propostas = (await a.propostas.porEvento(origemCitada.eventoId)).filter((p) => p.tipo === "DESPESA_PAGA" && p.estado === "AGUARDANDO_REVISAO");
          if (propostas.length) {
            const r = await responderConfirmacaoDeProposta(evento, propostas, { grupo, participante, daPessoa, podeConfirmar, recusarOutro });
            if (r) return r;
          }
        }
        // 5a'. 26/11 — a pessoa COMPLETA a proposta citando a resposta do MOVA (classificação/descrição, "outras despesas", o número da opção):
        // não é uma consulta nova. Só vale para proposta DESPESA_PAGA ainda em revisão, nesta conversa, por quem pode complementá-la.
        if (origemCitada?.eventoId && evento.texto) {
          const complemento = await complementarProposta(evento, origemCitada.eventoId, { grupo, participante, daPessoa, podeConfirmar, recusarOutro });
          if (complemento) return complemento;
        }
        // 5a-ctx. 27/11 — CONTEXTO da mensagem citada: as unidades da operação que gerou a resposta do MOVA citada. Uma só ⇒ a conversa
        // continua nela (o CORE recebe a unidade; nunca a padrão nem a primeira do cadastro); mais de uma ⇒ pergunta qual empresa;
        // confirmação sem nada pendente ⇒ diz isso, sem consultar outra unidade.
        if (origemCitada?.eventoId && evento.texto) {
          const doOrigem = await unidadesDoEvento(origemCitada.eventoId, daPessoa);
          if (doOrigem.length === 1) unidadeContexto = doOrigem[0].unidadeId;
          if (confirmacaoDeProposta(evento.texto)) {
            if (doOrigem.length > 1) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CONFIRMACAO_EMPRESA_AMBIGUA", resposta: RESPOSTA.qualEmpresa(doOrigem.map((x) => x.nome)), extra: { retomou: null } });
            return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONFIRMACAO_SEM_OPERACAO_PENDENTE", escopo: doOrigem[0] ? escopoDe(doOrigem[0]) : undefined, resposta: RESPOSTA.semOperacaoPendente(doOrigem[0]?.nome ?? null), extra: { retomou: null } });
          }
        }
      }
      // 5b. 15A — MEMÓRIA CURTA: esclarecimento SEM citar a pergunta ("Sanduíches Centro" logo depois de "de qual unidade?").
      // Só quando TODAS valem: mesma conversa e MESMO participante; pendência dos últimos 10 min (só a mais recente);
      // texto curto, sem números, que identifica exatamente UMA unidade da conversa. Retomada atômica (nunca duas vezes).
      // 23/11: também a resposta CURTA a uma pergunta de divergência (sim / não / número / juros / parcial / outra compra).
      // 24/11: SÓ sem citação. Uma mensagem que CITA algo e não achou pendência exata (passo 5) nunca é ligada por aproximação
      // à pendência mais recente — citar uma consulta antiga com "sim" não pode confirmar outra operação.
      // 28/11: PEDIDO DE CORREÇÃO sem citação ("MOVA, altere o vencimento da conta de energia para 15/12") — determinístico, sem IA
      if (!evento.respostaA && evento.tipo === "TEXTO" && !evento.midia) {
        const pedidoDeCorrecao = correcoes.interpretar(evento.texto);
        if (pedidoDeCorrecao) return correcoes.iniciar({ evento, grupo, participante, daPessoa, pedido: pedidoDeCorrecao });
      }
      const ehUnidade = !evento.respostaA && evento.tipo === "TEXTO" && ehEsclarecimentoDeUnidade(evento.texto, daPessoa);
      const ehRespostaCurta = !evento.respostaA && evento.tipo === "TEXTO" && parecerRespostaDeDivergencia(evento.texto);
      if ((ehUnidade || ehRespostaCurta) && typeof a.mensagens.tomarPendenteRecente === "function") {
        const pend = await a.mensagens.tomarPendenteRecente({ grupoId: evento.grupoId, participanteId: evento.participanteId, validadeMs: MEMORIA_CURTA_MS });
        if (pend?.pendente && !pend.pendente.divergencia && !ehUnidade) {
          // era a pergunta de unidade e a resposta curta não é uma unidade: devolve a pendência e segue o fluxo normal da mensagem
          await a.mensagens.lembrar(pend.pendente.evento.mensagemId, { grupoId: pend.grupoId ?? evento.grupoId, pendente: pend.pendente });
        } else if (pend?.pendente) {
          return retomarPendencia(evento, pend, pend.pendente.divergencia ? "RESPOSTA_DE_DIVERGENCIA_POR_CONTEXTO" : "ESCLARECIMENTO_POR_CONTEXTO");
        }
      }
      // 5b'. 26/11 — COLABORAÇÃO sem citação: resposta curta ("sim", "2", "Açaí", "outubro") de OUTRA pessoa, quando a conversa tem
      // pendência aberta recente de outro participante. Exatamente UMA que esta pessoa pode responder (perfil FINANCEIRO nas unidades da
      // operação) ⇒ retoma; mais de uma ⇒ pergunta só QUAL (citar a pergunta), sem consumir nenhuma; nenhuma ⇒ segue o fluxo normal.
      if (!evento.respostaA && evento.tipo === "TEXTO" && !evento.midia && (ehRespostaCurta || ehUnidade) && typeof a.mensagens.pendentesDoGrupo === "function") {
        const abertas = (await a.mensagens.pendentesDoGrupo({ grupoId: evento.grupoId, validadeMs: MEMORIA_CURTA_MS }))
          .filter((x) => x.pendente?.evento?.participanteId !== evento.participanteId);
        const elegiveis = abertas.filter((x) => podeConfirmarPendencia(cfg, x.pendente.evento, evento, { unidadeId: x.pendente.divergencia?.unidadeId ?? x.pendente.saida?.unidadeId ?? null, tipo: x.pendente.divergencia?.tipo ?? null, unidadesExigidas: x.pendente.divergencia?.unidadesExigidas ?? null }).pode);
        if (elegiveis.length > 1) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VARIAS_PENDENCIAS_ABERTAS", resposta: RESPOSTA.qualPendencia(elegiveis.length), extra: { retomou: null } });
        if (elegiveis.length === 1) {
          const pend = await a.mensagens.tomarPendente(elegiveis[0].mensagemId, { validadeMs: MEMORIA_CURTA_MS });
          if (pend?.pendente) return retomarPendencia(evento, pend, "RESPOSTA_DE_OUTRO_FINANCEIRO_POR_CONTEXTO");
        }
        // "sim"/"não" de quem NÃO pode confirmar a única pendência aberta: recusa explícita (a pendência continua para quem pode).
        if (elegiveis.length === 0 && abertas.length === 1 && respostaSimNao(evento.texto) !== null) {
          return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CONFIRMACAO_SEM_PERMISSAO_FINANCEIRA", resposta: RESPOSTA.complementoSemPermissao(), extra: { retomou: null } });
        }
      }
      // 5b''. 27/11 — confirmação natural SEM citação ("MOVA, pode confirmar"): só com UMA proposta DESPESA_PAGA em revisão, criada na última
      // hora nesta conversa, em unidade que a pessoa pode tratar; com várias, pergunta qual (citando a mensagem); com nenhuma, segue o fluxo.
      if (!evento.respostaA && evento.tipo === "TEXTO" && !evento.midia && confirmacaoDeProposta(evento.texto)) {
        const limite = Date.now() - 60 * 60 * 1000;
        const abertas = [];
        for (const u of cfg.unidades.filter((x) => daPessoa.unidades.includes(x.unidadeId))) {
          for (const p of await a.propostas.listar(escopoDe(u))) {
            if (p.tipo !== "DESPESA_PAGA" || p.estado !== "AGUARDANDO_REVISAO" || Date.parse(p.criadaEm ?? 0) < limite) continue;
            const ev = await a.eventos.obter(p.eventoId);
            if ((ev?.grupoId ?? ev?.grupo_jid ?? null) === evento.grupoId) abertas.push(p);
          }
        }
        if (abertas.length) {
          const r = await responderConfirmacaoDeProposta(evento, abertas, { grupo, participante, daPessoa, podeConfirmar: () => true, recusarOutro: () => null });
          if (r) return r;
        }
      }
      // 5c. 24/11 — resposta LIVRE a uma pergunta de divergência ou de descrição ("comprei brownies e já paguei", "brownies"): a
      // pendência DESTA pessoa (mesma conversa, 10 min) é só LIDA. Descrição curta responde sozinha (sem IA); o resto segue para a
      // leitura — a MESMA chamada de IA que a mensagem já teria — com a pergunta como contexto, e só é retomada se a leitura
      // responder a ela. Nada de lista de palavras: o sentido vem da leitura, a decisão continua determinística.
      // Só SEM citação (mesma regra da memória curta): quem cita outra mensagem e não achou a pendência exata não é ligado à mais recente.
      if (!evento.respostaA && evento.tipo === "TEXTO" && !evento.midia && String(evento.texto ?? "").length <= 300 && typeof a.mensagens.verPendenteRecente === "function") {
        const visto = await a.mensagens.verPendenteRecente({ grupoId: evento.grupoId, participanteId: evento.participanteId, validadeMs: MEMORIA_CURTA_MS });
        // 27/11: resposta ao "falta o vencimento / o mês de referência" da conta relatada ("vence 10/12, referente a novembro"):
        // lida sem IA; só retoma se preencher o que faltava (senão segue a leitura comum, com a pergunta como contexto).
        // 28/11: resposta LIVRE com o valor novo da correção ("Gelo Norte", "paga pela sócia") — sem IA
        if ([TIPO_CORRECAO.VALOR, TIPO_CORRECAO.JUSTIFICATIVA].includes(visto?.pendente?.divergencia?.tipo)) {
          const pend = await a.mensagens.tomarPendente(visto.mensagemId);
          if (pend?.pendente) return retomarPendencia(evento, pend, "VALOR_DA_CORRECAO");
        }
        const faltasDaConta = visto?.pendente?.divergencia?.tipo === "CONTA_RELATADA_COMPLEMENTO" ? visto.pendente.divergencia : null;
        if (faltasDaConta && complementoDaResposta(evento.texto, { faltas: faltasDaConta.faltas ?? [], complemento: faltasDaConta.complemento ?? {}, dataMensagem: dataDaMensagem(visto.pendente.evento), hoje: hoje(), competenciaDe: competenciaDoRelato })) {
          const pend = await a.mensagens.tomarPendente(visto.mensagemId);
          if (pend?.pendente) return retomarPendencia(evento, pend, "COMPLEMENTO_DA_CONTA_RELATADA");
        }
        if (visto?.pendente?.divergencia) {
          const descricao = visto.pendente.divergencia.tipo === TIPO_DIVERGENCIA.DESCRICAO ? descricaoDireta(evento.texto) : null;
          if (descricao) {
            const pend = await a.mensagens.tomarPendente(visto.mensagemId);
            if (pend?.pendente) return retomarPendencia(evento, pend, "DESCRICAO_RECEBIDA", { descricao });
          } else pendenteSemantico = visto;
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
    // MOVA CORE (desligado por padrão): TEXTO livre na conversa PRIVADA de quem está na lista, numa unidade do piloto. As guardas de
    // dado restrito e de pedido de execução acima continuam valendo. Sem resposta do núcleo (SOMBRA, fora do escopo, falha) ⇒ segue o
    // motor atual, que é também o rollback imediato (MOVA_CORE_CONVERSA=DESLIGADO).
    // 27/11 (caso real do empréstimo BNB): "registrar uma conta de R$ 2.911,08…" ia para o MOVA CORE, que só prepara rascunho
    // ("escritas pela conversa não estão habilitadas"). Pedido de REGISTRAR conta com valor é do motor financeiro (conta relatada:
    // resumo → confirmação → registro pela política e concessão). O núcleo continua só leitura — nada de escrita nova nele.
    if (conversaNova && evento.tipo === "TEXTO" && !evento.midia && !esclarecimento && !pendenteSemantico && !pedidoDeRegistrarConta(evento.texto)) {
      const nova = await conversaNova.atender({ evento: unidadeContexto ? { ...evento, unidadeContexto } : evento, grupo, participante });
      if (nova?.texto) return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: `MOVA_CORE:${nova.motivo}`, escopo: { organizacaoId: nova.organizacaoId, unidadeId: nova.unidadeId }, resposta: nova.texto, respostasExtras: nova.blocos ?? [], injecao,
        extra: { nucleo: "MOVA_CORE", mensagensExtras: (nova.blocos ?? []).length, requisicaoCore: nova.requisicaoId, ferramentas: nova.ferramentas, custoMicrousd: nova.custoMicrousd, latenciaMs: nova.latenciaMs } });
    }
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
    // 24/11: com uma pergunta do MOVA PENDENTE para esta pessoa, a frase é lida no contexto dela (atalhos de consulta ignoram o
    // contexto: "Já foi pago pelo Pix" viraria a consulta "a conta 'pelo pix' já foi paga?").
    if (!saida && comandosDeterministicos && evento.tipo === "TEXTO" && !evento.midia && !pendenteSemantico) {
      const cmd = interpretarComando(evento.texto, hoje());
      if (cmd && !cmd.soPeriodo) { saida = cmd.saida; interpretacao = "COMANDO"; }
      else if (cmd?.soPeriodo && conversa?.consulta) { saida = Object.freeze({ ...cmd.saida, consulta: conversa.consulta }); interpretacao = "CONTINUIDADE";
        // mantém o filtro (fornecedor/categoria) da consulta anterior; o dado vem do contexto guardado e é revalidado pelo contrato
        const f = conversa.contexto ?? {};
        if (COM_FILTRO.includes(conversa.consulta) && (f.favorecido || f.categoriaSugerida)) { const v = validarSaidaDaIa({ ...saida, favorecido: f.favorecido ?? null, categoriaSugerida: f.categoriaSugerida ?? null }); if (v.ok) saida = v.saida; }
      }
    }
    // Conversa natural sem IA (custo zero): "só as vencidas", "agora por fornecedor", "nas duas" e "e na Subway?" repetem a consulta
    // anterior DESTA pessoa nesta conversa (janela curta). A unidade continua vindo da regra determinística (nunca do histórico).
    if (!saida && !esclarecimento && !pendenteSemantico && conversa?.consulta && evento.tipo === "TEXTO" && !evento.midia) {
      const seg = interpretarSeguimento(evento.texto, conversa)
        ?? (/^\s*(e|mas)\b/i.test(evento.texto ?? "") && ehEsclarecimentoDeUnidade(evento.texto, daPessoa) ? saidaDeContinuacao(conversa.consulta, conversa) : null);
      if (seg) { saida = seg; interpretacao = "CONTINUIDADE"; }
    }
    if (!saida) {
      const lida = await lerDocumento(evento, daPessoa, conversa, { perguntaPendente: pendenteSemantico ? descreverPendencia(pendenteSemantico.pendente.divergencia) : null });
      // Execução 13C: a IA recusar NÃO é falha de leitura nem controle de acesso — vira bloqueio explícito, sem nova chamada.
      if (!lida.ok && lida.codigo === "IA_RECUSOU") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "IA_RECUSOU", resposta: RESPOSTA.pedidoNaoAtendido(), injecao });
      // 16A: orçamento esgotado/indisponível ou IA desligada NÃO é "mensagem mal escrita" — não pede para reenviar.
      if (!lida.ok && IA_PAUSADA.includes(lida.codigo)) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: RESPOSTA.iaPausada(), injecao });
      if (!lida.ok) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: respostaDaFalhaDeLeitura(lida, evento), injecao });
      saida = lida.saida;
      // 24/11 — a leitura RESPONDEU à pergunta pendente (finalidade, ou a descrição pedida): retoma a operação ORIGINAL do
      // comprovante (atômico: só uma vez). A finalidade só vira desfecho onde faz sentido (desfechoPorFinalidade); nada é escolhido pela IA.
      const pendDiv = pendenteSemantico?.pendente?.divergencia;
      if (pendDiv && (saida.finalidadePagamento || (pendDiv.tipo === TIPO_DIVERGENCIA.DESCRICAO && saida.descricaoCompra) || (pendDiv.tipo === TIPO_DIVERGENCIA.COMPETENCIA && saida.competencia && !saida.consulta))) {
        const pend = await a.mensagens.tomarPendente(pendenteSemantico.mensagemId);
        if (pend?.pendente) {
          await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "RESPOSTA_DE_DIVERGENCIA_POR_INTERPRETACAO", participanteId: evento.participanteId, organizacaoId: null, unidadeId: null, retomou: pend.pendente.evento.eventoId });
          return processar(pend.pendente.evento, { esclarecimento: { texto: evento.texto, saida: pend.pendente.saida, divergencia: pend.pendente.divergencia, observacoes: pend.pendente.observacoes ?? null, porEvento: evento.eventoId, participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null,
            finalidade: saida.finalidadePagamento ?? null, descricao: saida.descricaoCompra ?? null, ia: { competencia: saida.competencia ?? null, descricaoCompra: saida.descricaoCompra ?? null, finalidadePagamento: saida.finalidadePagamento ?? null, categoriaSugerida: saida.categoriaSugerida ?? null, favorecido: saida.favorecido ?? null, jurosCentavos: saida.jurosCentavos ?? null, multaCentavos: saida.multaCentavos ?? null } } });
        }
      }
      // A IA marcou que a mensagem depende da pergunta anterior e não trouxe consulta própria: repete a consulta da conversa (com o
      // mesmo período, se a mensagem não trouxe outro). Só consulta: nenhuma outra intenção é reescrita.
      if (saida.continuacao === true && !saida.consulta && conversa?.consulta && ["CONSULTAR", "OUTRA", "DESCONHECIDA"].includes(saida.intencao) && !saida.valorCentavos) {
        const r = conversa.contexto ?? {};
        const tem = Boolean(saida.competencia || saida.periodoInicio || saida.periodoFim);
        const rec = validarSaidaDaIa({ ...saida, intencao: "CONSULTAR", consulta: conversa.consulta, ...(tem ? {} : { competencia: r.competencia ?? null, periodoInicio: r.periodoInicio ?? null, periodoFim: r.periodoFim ?? null }),
          ...(COM_FILTRO.includes(conversa.consulta) ? { favorecido: saida.favorecido ?? r.favorecido ?? null, categoriaSugerida: saida.categoriaSugerida ?? r.categoriaSugerida ?? null } : {}) });
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
      // 25/11: no grupo por LISTA, conversa sem pedido financeiro só tem resposta quando o MOVA foi chamado PELO NOME. Mensagem que
      // entrou pela continuidade ou citação ("ok", "kkk", "valeu") não recebe apresentação no meio de uma operação.
      if (String(evento.grupoId).endsWith("@g.us") && (grupo.acesso ?? "ABERTO") === "LISTA" && !chamaPeloNome(evento.texto)) {
        return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "CONVERSA_SEM_PEDIDO_FINANCEIRO_SILENCIOSA", injecao });
      }
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
      pagador: doDocumento ? saida.pagador ?? null : null, documentoPagador: doDocumento ? saida.documentoPagador ?? null : null,
      // 27/11: a MARCA sozinha só basta na resposta a "de qual unidade?" (se não houver outra loja da marca) e em consulta (só leitura).
      marcaBasta: Boolean(esclarecimento && !esclarecimento.divergencia), somenteLeitura: Boolean(consulta) && !evento.midia });
    // Agente 2 — CONSULTA (só leitura) sem unidade no texto: a unidade da conversa em andamento DESTA pessoa (janela curta).
    // Documento/lançamento continua exigindo evidência própria (nunca pelo histórico do participante).
    if (consulta && u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA && conversa?.unidadeId && daPessoa.unidades.includes(conversa.unidadeId)) {
      const daConversa = cfg.unidades.find((x) => x.unidadeId === conversa.unidadeId);
      if (daConversa) u = { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: daConversa, evidencia: "CONVERSA_EM_ANDAMENTO" };
    }
    // 26/11 — comprovante pago pela conta de uma unidade da conversa citando OUTRA (ex.: a Subway pagou pelo Açaí): pergunta se é
    // operação entre empresas. Qualquer outro documento (boleto, nota) com esse conflito segue como conflito de unidade.
    if (u.resultado === RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE) {
      if (evento.midia && PAGAMENTOS.includes(saida.tipoDocumento) && saida.intencao !== "TRANSFERENCIA_INTERNA") {
        return tratarEntreEmpresas({ evento, saida, injecao, esclarecimento, grupo, participante, interpretacao, devedora: u.unidade, credora: u.pagadora });
      }
      // 28/11 (caso real: nota da distribuidora em nome da MP ALIMENTOS, "lançar no açaí"): NOTA/BOLETO em nome da empresa de uma
      // loja da conversa, com o texto citando OUTRA loja da conversa. Antes virava conflito e a pergunta genérica "Açaí ou Subway?"
      // se repetia a cada resposta (a nota continuava apontando a outra empresa) — beco sem saída. Agora o MOVA EXPLICA o conflito e
      // aceita a confirmação explícita de quem é FINANCEIRO nas DUAS unidades. Nada é presumido: sem confirmação, nada é gravado.
      if (evento.midia && CONTAS.includes(saida.tipoDocumento)) {
        const r = await confirmarUnidadeDoTomador({ evento, saida, injecao, esclarecimento, grupo, participante, citada: u.unidade, tomadora: u.pagadora });
        if (r.concluido) return r.concluido;
        u = r.u;
        esclarecimento = r.esclarecimento;
      } else u = { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: u.evidencia };
    }
    // 27/11 (caso real do empréstimo BNB): a resposta "Subway Saci" foi aceita, o MOVA perguntou o mês e, na resposta do mês, a unidade
    // era recalculada SÓ do texto original ("Empréstimo BNB…", pago pela MP, empresa de várias lojas) ⇒ "indicações de unidades
    // diferentes" e a operação morria. A unidade gravada na pendência (a estabelecida na pergunta anterior, com o esclarecimento de
    // quem pode) continua valendo — só quando o texto original NÃO a contradiz (não identificada/conflitante), nunca contra evidência.
    const unidadeDaPendencia = esclarecimento?.divergencia?.unidadeId && daPessoa.unidades.includes(esclarecimento.divergencia.unidadeId)
      ? cfg.unidades.find((x) => x.unidadeId === esclarecimento.divergencia.unidadeId) ?? null : null;
    if (unidadeDaPendencia && (u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE)) {
      u = { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: unidadeDaPendencia, evidencia: "ESCLARECIDA_NA_CONVERSA" };
    }
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      const nomes = cfg.unidades.filter((x) => daPessoa.unidades.includes(x.unidadeId)).map((x) => x.nome);
      // 27/11: também depois de um esclarecimento a pergunta GUARDA a pendência (antes: "responda a esta mensagem" sem pendência =
      // beco sem saída; a resposta caía na conversa comum/CORE). A nova pendência é a operação original, do zero (nada é presumido).
      if (u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE) {
        await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: esclarecimento?.saida ?? saida, ...(esclarecimento?.observacoes?.length ? { observacoes: esclarecimento.observacoes } : {}) } });
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao, extra: { evidenciaUnidade: u.evidencia } });
      }
      const resposta = u.resultado === RESULTADO_UNIDADE.NAO_HABILITADA ? RESPOSTA.unidadeNaoHabilitada(u.unidadeDoDocumento, { documento: Boolean(evento.midia) })
        : u.evidencia === "PAGADOR_FORA_DA_CONVERSA" && u.unidadeDoDocumento ? RESPOSTA.pagadorDeOutraUnidade(u.unidadeDoDocumento)
        : u.resultado === RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE || u.resultado === RESULTADO_UNIDADE.FORA_DO_GRUPO ? RESPOSTA.documentoDeOutraUnidade() : RESPOSTA.unidadeConflitante();
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: u.resultado, resposta, injecao, extra: { evidenciaUnidade: u.evidencia } });
    }
    const unidade = u.unidade;
    const escopo = escopoDe(unidade);
    // Agente 2 — Frente B: a MESMA transação (ID/E2E) já recebida nesta empresa, em outro arquivo (foto × PDF, print × encaminhado):
    // não cria segunda proposta. O sha256 só pega o mesmo arquivo; o identificador da transação pega o mesmo pagamento.
    if (evento.midia && idTransacaoConfiavel(saida.idTransacao) && typeof a.documentos.porTransacao === "function") {
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
    // 26/11: o favorecido só indica transferência interna num COMPROVANTE DE PAGAMENTO e quando ele é a MESMA empresa (mesma
    // organização) da unidade identificada. Relato por texto ("compra de bebedouro para o açaí") e conta a pagar nunca caem aqui; o
    // favorecido de OUTRA empresa do grupo é operação entre empresas (intercompany), tratada antes, na identificação da unidade.
    const favorecidoEhDaEmpresa = Boolean(evento.midia) && PAGAMENTOS.includes(saida.tipoDocumento) && saida.favorecido
      && unidadesCitadas(saida.favorecido, cfg.unidades).some((x) => x.organizacaoId === unidade.organizacaoId);
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
    // 26/11: conta relatada por TEXTO com valor e data(s) ⇒ leitura determinística das parcelas, resumo e confirmação (antes das
    // conferências de valor da IA: "total ou cada parcela?" é pergunta do MOVA, não falha de leitura). Sem valor+data, segue o fluxo comum.
    // 27/11: FOTO DO PRODUTO com legenda ("bebedouro para o açaí, 2x de 97,25, dia 19/12 e 19/01"): não é comprovante, boleto nem
    // nota (tipo lido fora de PAGAMENTOS/CONTAS) ⇒ a LEGENDA vira o relato da conta. Comprovante/boleto/nota seguem o fluxo documental.
    const fotoDeProduto = Boolean(evento.midia) && String(evento.midia.mime ?? "").startsWith("image/") && ![...PAGAMENTOS, ...CONTAS].includes(saida.tipoDocumento);
    const fluxoRelatado = String(esclarecimento?.divergencia?.tipo ?? "").startsWith("CONTA_RELATADA");
    if (relatoConta || fotoDeProduto || ((textoPuro || fotoDeProduto) && fluxoRelatado)) {
      const relatada = await tratarContaRelatada(ctx);
      if (relatada) return relatada;
    }
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

  async function criarProposta({ evento, escopo, unidade, saida, injecao, esclarecimento, grupo = null, participante = null, evidenciaUnidade = null, idRecortado = false }, dados, textoResposta, { posCriacao = null } = {}) {
    // 25/11: identificador da transação cortado na imagem ⇒ sem baixa automática (regra SEM_IDENTIFICADOR); pede a evidência completa.
    if (idRecortado) { const base = textoResposta; textoResposta = (p) => `${base(p)}
O identificador da transação está cortado na imagem: envie o comprovante completo (ou outra evidência oficial) para a baixa automática.`; }
    // Execução 14: o mesmo relato por TEXTO reenviado em outra mensagem (sem arquivo para comparar por sha256) não cria segunda
    // proposta: mesma unidade, tipo, valor e datas de uma proposta do MOVA ainda aguardando revisão ⇒ DUPLICADO.
    if (!evento.midia && [TIPO_PROPOSTA.DESPESA_PAGA, TIPO_PROPOSTA.NOVA_OBRIGACAO, TIPO_PROPOSTA.CONTA_RELATADA].includes(dados.tipo)) {
      const mesma = (await a.propostas.listar(escopo)).find((p) => p.estado === "AGUARDANDO_REVISAO" && p.eventoId !== evento.eventoId && !p.evidencia
        && p.tipo === dados.tipo && p.valorCentavos === dados.valorCentavos
        && (p.datas?.caixa ?? null) === (dados.datas?.caixa ?? null) && (p.datas?.vencimento ?? null) === (dados.datas?.vencimento ?? null));
      if (mesma) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "PROPOSTA_SEMELHANTE_PENDENTE", escopo, propostaId: mesma.id, resposta: RESPOSTA.relatoRepetido(mesma.id), injecao });
    }
    const incompleta = !requisitosParaOperacao(unidade, dados.tipo);
    const { proposta } = await a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|${dados.tipo}`, origem: "MOVA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, esclarecidoPor: esclarecimento ? esclarecimento.participanteId : null,
      evidencia: evento.midia ? { sha256: evento.midia.sha256, referencia: evento.midia.referencia, mime: evento.midia.mime } : null,
      // 15A (V-1): a justificativa e os campos ausentes da IA ficam na proposta para a revisão humana (texto puro não tem documento).
      leitura: { tipoDocumento: saida.tipoDocumento, intencao: saida.intencao, favorecido: saida.favorecido, identificadorDocumento: saida.identificadorDocumento, confianca: saida.confianca,
        pagador: saida.pagador ?? null, documentoPagador: saida.documentoPagador ?? null, instituicao: saida.instituicao ?? null, idTransacao: saida.idTransacao ?? null,
        // 27/11: evidências de unidade lidas do documento, para REVALIDAR a unidade antes de executar/aprovar a proposta.
        unidadeSugerida: saida.unidadeSugerida ?? null, documentoDestinatario: saida.documentoDestinatario ?? null,
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
    // 25/11: a política autorizou (APLICAR_AUTOMATICO) mas a execução não aconteceu por identidade/concessão ⇒ o motivo é registrado e dito.
    const motivosExecucao = pos && pos.situacao === "PROPOSTA" ? [...new Set([...(pos.motivosDocumentais ?? []), ...(pos.motivos ?? [])])].filter((m) => ["SEM_IDENTIDADE_OPERACIONAL", "SEM_CONCESSAO_OPERACIONAL"].includes(m) || /^FV2_/.test(m)) : [];
    if (motivosExecucao.length) await a.propostas.anotar(escopo, proposta.id, { semExecucao: { motivos: motivosExecucao, em: relogio().toISOString() } });
    const texto = (pos?.texto ?? textoResposta(proposta)) + (motivosExecucao.length ? ` ${RESPOSTA.semExecucaoAutomatica(motivosExecucao)}` : "") + (incompleta ? ` ${RESPOSTA.pendenteUnidadeIncompleta()}` : "");
    const extra = pos ? { conciliacao: pos.situacao, autonomia: pos.nivel, ...(pos.nivelDocumental ? { autonomiaDocumental: pos.nivelDocumental, comprovante: pos.comprovante } : {}), ...(pos.motivo ? { motivoExecucao: pos.motivo } : {}), ...(motivosExecucao.length ? { motivosExecucao } : {}) } : {};
    // Agente 2: a resposta do documento leva VALOR — num grupo por LISTA segue a política (privado, ou grupo comprovado).
    const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]);
    const privado = rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null;
    return concluir(evento, { decisao: ["EXECUTADA", "PAGO_POR_COMPROVANTE", "CONTA_REGISTRADA", "DOCUMENTO_VINCULADO"].includes(pos?.situacao) ? DECISAO.EXECUTADO : DECISAO.PROPOSTA, motivo: dados.tipo, escopo, propostaId: proposta.id, resposta: texto, injecao, extra, privado });
  }

  /** Categoria do plano da unidade pela descrição (uma só categoria casando); senão null → provisória "a classificar" (revisão humana). */
  async function planoDaUnidade(escopo) {
    try {
      const p = await porta.ler("consultarPlanoDeContas", escopo, undefined);
      // 24/11 (correção): o plano vem como ÁRVORE (lista de grupos com `filhas`); achata a árvore.
      const plano = [];
      const visitar = (xs) => { for (const c of xs ?? []) { plano.push(c); visitar(c?.filhas); } };
      visitar(Array.isArray(p) ? p : p?.categorias ?? p?.itens ?? []);
      return plano;
    } catch { return []; }
  }
  async function categoriaDaDespesa(escopo, saida, legenda) {
    const plano = await planoDaUnidade(escopo);
    return plano.length ? escolherCategoria({ categorias: plano, categoriaSugerida: saida.categoriaSugerida, legenda }) : null;
  }

  /**
   * 26/11 — COMPLETA uma proposta DESPESA_PAGA em revisão com a classificação/descrição dita depois (citando a resposta do MOVA).
   * Regras (determinísticas primeiro; Haiku só se não casar; o backend valida no PLANO DE CONTAS da unidade): uma categoria compatível ⇒
   * aplica; várias ⇒ mostra só as compatíveis (até 4) e a resposta pelo número continua; nenhuma ⇒ não é com este fluxo.
   * Proposta que a política autorizou a aplicar sozinha é retomada na sequência (tudo revalidado), sem pedir nada de novo.
   * @returns {Promise<object|null>}
   */
  async function complementarProposta(evento, eventoOrigemId, ctxp) {
    const { grupo, participante, daPessoa, podeConfirmar, recusarOutro } = ctxp;
    if (typeof a.propostas.porEvento !== "function") return null;
    let proposta = (await a.propostas.porEvento(eventoOrigemId)).find((p) => p.tipo === "DESPESA_PAGA" && p.estado === "AGUARDANDO_REVISAO") ?? null;
    // a citada pode ser a pergunta de opções de categoria (gerada por uma mensagem de resposta): a proposta guarda de qual evento ela veio
    if (!proposta) {
      for (const u of cfg.unidades.filter((x) => daPessoa.unidades.includes(x.unidadeId))) {
        proposta = (await a.propostas.listar(escopoDe(u))).find((p) => p.tipo === "DESPESA_PAGA" && p.estado === "AGUARDANDO_REVISAO" && p.categoriaOpcoesEventoId === eventoOrigemId) ?? null;
        if (proposta) break;
      }
    }
    if (!proposta) return null;
    const unidade = cfg.unidades.find((x) => x.unidadeId === proposta.unidadeId) ?? null;
    if (!unidade || !daPessoa.unidades.includes(proposta.unidadeId)) return null;
    const escopo = escopoDe(unidade);
    const ev = await a.eventos.obter(proposta.eventoId);
    const origem = { participanteId: ev?.participanteId ?? ev?.participante_jid ?? proposta.participanteId ?? null, telefoneE164: ev?.telefoneE164 ?? ev?.telefone_e164 ?? null, grupoId: ev?.grupoId ?? ev?.grupo_jid ?? evento.grupoId };
    if (!podeConfirmar(origem, { divergencia: { tipo: "COMPETENCIA", unidadeId: proposta.unidadeId }, saida: null })) return recusarOutro();
    const plano = await planoDaUnidade(escopo);
    if (!plano.length) return null;
    const lancavel = (c) => c?.aceitaLancamento && c.ativa !== false && ["CUSTO", "DESPESA"].includes(c.natureza);
    const base = { escopo, propostaId: proposta.id };
    let leitura;
    const numero = /^\s*([1-4])\s*[.)]?\s*$/.exec(evento.texto);
    if (numero && Array.isArray(proposta.categoriaOpcoes) && proposta.categoriaOpcoes[Number(numero[1]) - 1]) {
      const c = plano.find((x) => lancavel(x) && x.codigo === proposta.categoriaOpcoes[Number(numero[1]) - 1]);
      leitura = { categoria: c?.codigo ?? null, opcoes: [], descricao: null };
    } else {
      leitura = interpretarCategoria({ texto: evento.texto, categorias: plano });
      if (!leitura.categoria && !leitura.opcoes.length && evento.texto.length <= 120) {
        // as regras não entenderam: o Haiku (já disponível) lê a mensagem; o backend só aceita um código que EXISTA no plano da unidade
        try {
          const lida = await lerDocumento({ eventoId: evento.eventoId, tipo: "TEXTO", texto: evento.texto, grupoId: evento.grupoId, midia: null }, grupo ?? { unidades: [escopo.unidadeId] }, null, { perguntaPendente: "Qual a categoria (classificação) e a descrição desta despesa?" });
          if (lida.ok) {
            const x = extracaoDaRespostaIA(lida.saida, { texto: evento.texto, dataPagamento: proposta.datas?.caixa ?? null });
            const codigo = x.categoria ? escolherCategoria({ categorias: plano, categoriaSugerida: x.categoria, legenda: evento.texto }) : null;
            if (codigo || x.descricao) leitura = { categoria: codigo, opcoes: [], descricao: x.descricao };
          }
        } catch { /* indisponível: não é com este fluxo */ }
      }
    }
    if (!leitura.categoria && !leitura.opcoes.length) return null;
    await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "PROPOSTA_COMPLEMENTADA_POR_CITACAO", participanteId: evento.participanteId, organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, retomou: eventoOrigemId });
    const privadoDe = async () => { const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]); return rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null; };
    if (!leitura.categoria) {
      await a.propostas.anotar(escopo, proposta.id, { categoriaOpcoes: leitura.opcoes.map((o) => o.codigo), categoriaOpcoesEventoId: evento.eventoId });
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CATEGORIA_AMBIGUA", ...base, resposta: RESPOSTA.categoriaOpcoes(leitura.opcoes), privado: await privadoDe() });
    }
    const nome = plano.find((c) => c.codigo === leitura.categoria)?.nome ?? leitura.categoria;
    const descricao = leitura.descricao ? mascararDadosSensiveis(leitura.descricao).slice(0, 120) : null;
    const entrada = proposta.comando?.entrada ?? {};
    await a.propostas.anotar(escopo, proposta.id, { comando: { ...proposta.comando, entrada: { ...entrada, categoria: leitura.categoria, ...(descricao ? { descricao } : {}) } }, categoriaDefinida: true, categoriaOpcoes: null, categoriaOpcoesEventoId: null });
    await a.auditoria.registrar({ acao: "PROPOSTA_CLASSIFICADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { categoria: leitura.categoria, descricao: Boolean(descricao) } });
    // autorizada a aplicar sozinha e parada: segue para o registro (a MESMA execução, tudo revalidado)
    if (proposta.semExecucao || proposta.autonomiaDocumental?.nivel === "APLICAR_AUTOMATICO") {
      const r = await retomarProposta(evento, proposta.eventoId, ctxp);
      if (r) return r;
    }
    return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CATEGORIA_DEFINIDA", ...base, privado: await privadoDe(),
      resposta: RESPOSTA.categoriaDefinida(nome, descricao, "A proposta segue aguardando a confirmação de quem aprova no Centro Financeiro. Nada foi lançado ainda.") });
  }

  /** 27/11 — descrição da conta com a OBSERVAÇÃO dita; `cabe` = coube inteira nos 200 caracteres do núcleo (senão a proposta guarda o texto todo). */
  function descricaoComObservacao(c) {
    const obs = [c.observacao, ...c.parcelas.filter((p) => p.observacao).map((p) => `${p.numero}/${p.total} ${p.observacao}`)].filter(Boolean).join("; ") || null;
    if (!obs) return { descricao: c.descricao.slice(0, 200), observacao: null, cabe: true };
    const cheia = `${c.descricao} · ${obs}`;
    return cheia.length <= 200 ? { descricao: cheia, observacao: obs, cabe: true } : { descricao: `${c.descricao} · obs. completa na proposta MOVA`.slice(0, 200), observacao: obs, cabe: false };
  }

  /** 27/11 — unidades (da pessoa, desta configuração) envolvidas num evento: propostas e decisões dele. */
  async function unidadesDoEvento(eventoId, daPessoa) {
    const ids = new Set();
    if (typeof a.propostas.porEvento === "function") for (const p of await a.propostas.porEvento(eventoId)) if (p.unidadeId) ids.add(p.unidadeId);
    if (typeof a.historico.porEvento === "function") for (const h of await a.historico.porEvento(eventoId)) if (h.unidadeId) ids.add(h.unidadeId);
    return cfg.unidades.filter((u) => ids.has(u.unidadeId) && daPessoa.unidades.includes(u.unidadeId));
  }

  /**
   * 27/11 — a pessoa ESCLARECE a dúvida da leitura de uma proposta DESPESA_PAGA em revisão (citando a proposta). Só vale para quem pode
   * complementar a operação na unidade DELA. A dúvida esclarecida sai de `incertezas` (a original fica em `incertezasEsclarecidas`),
   * o comprovante é reavaliado e a MESMA proposta é reexecutada pela política vigente (nada de outra proposta, nem de novo comprovante).
   * Valor em reais diferente do comprovado = divergência real: protege e pergunta.
   */
  async function esclarecerProposta(evento, eventoOrigemId, ctxp) {
    if (typeof a.propostas.porEvento !== "function") return null;
    const { daPessoa } = ctxp;
    const candidatas = (await a.propostas.porEvento(eventoOrigemId)).filter((p) => p.tipo === "DESPESA_PAGA" && p.estado === "AGUARDANDO_REVISAO" && (p.leitura?.incertezas ?? []).length
      && daPessoa.unidades.includes(p.unidadeId) && cfg.unidades.some((x) => x.unidadeId === p.unidadeId));
    if (candidatas.length !== 1) return null;
    const p = candidatas[0];
    const r = esclarecerIncertezas(evento.texto, p.leitura.incertezas, p.valorCentavos);
    const unidade = cfg.unidades.find((x) => x.unidadeId === p.unidadeId);
    if (!r.ok) {
      if (r.motivo !== "VALOR_DIVERGENTE") return null;
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "ESCLARECIMENTO_VALOR_DIVERGENTE", escopo: escopoDe(unidade), propostaId: p.id, resposta: RESPOSTA.valorDivergenteNoEsclarecimento(r.informadoCentavos, p.valorCentavos), extra: { retomou: null } });
    }
    const ev = await a.eventos.obter(eventoOrigemId);
    const origem = { participanteId: ev?.participanteId ?? ev?.participante_jid ?? p.participanteId ?? null, telefoneE164: ev?.telefoneE164 ?? ev?.telefone_e164 ?? null, grupoId: ev?.grupoId ?? ev?.grupo_jid ?? evento.grupoId };
    if (!ctxp.podeConfirmar(origem, { divergencia: { tipo: "COMPETENCIA", unidadeId: p.unidadeId }, saida: null })) return ctxp.recusarOutro();
    const leitura = { ...p.leitura, incertezas: r.restantes,
      incertezasEsclarecidas: [...(p.leitura.incertezasEsclarecidas ?? []), ...r.esclarecidas.map((texto) => ({ texto, esclarecidoPor: evento.participanteId, esclarecidoEm: relogio().toISOString(), resposta: mascararDadosSensiveis(String(evento.texto)).slice(0, 300) }))] };
    leitura.comprovante = avaliarComprovante(leitura, { hoje: hoje() });
    await a.propostas.anotar(escopoDe(unidade), p.id, { leitura });
    await a.auditoria.registrar({ acao: "INCERTEZA_ESCLARECIDA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: p.id, dados: { esclarecidas: r.esclarecidas.length, restantes: r.restantes.length } });
    return retomarProposta(evento, eventoOrigemId, ctxp, { propostaId: p.id, motivoRelacao: "INCERTEZA_ESCLARECIDA_POR_CITACAO", aviso: RESPOSTA.esclarecimentoRecebido(r.esclarecidas.length) });
  }

  /**
   * 27/11 — resposta à CONFIRMAÇÃO natural de uma ou mais propostas DESPESA_PAGA em revisão. A unidade é SEMPRE a da proposta.
   * Várias ⇒ pergunta qual. Uma que a política autorizou a aplicar sozinha e ficou parada ⇒ a MESMA retomada de sempre (tudo revalidado).
   * Uma que só o Centro Financeiro aprova ⇒ explica (id, unidade, valor, motivo) sem executar nada.
   */
  async function responderConfirmacaoDeProposta(evento, propostas, ctxp) {
    const { grupo, participante, daPessoa } = ctxp;
    // Só quem pode COMPLEMENTAR a operação nesta unidade (perfil financeiro da unidade, no mesmo grupo) recebe os dados da proposta.
    const visiveis = [];
    for (const p of propostas) {
      if (!daPessoa.unidades.includes(p.unidadeId) || !cfg.unidades.some((x) => x.unidadeId === p.unidadeId)) continue;
      const ev = await a.eventos.obter(p.eventoId);
      const origem = { participanteId: ev?.participanteId ?? ev?.participante_jid ?? p.participanteId ?? null, telefoneE164: ev?.telefoneE164 ?? ev?.telefone_e164 ?? null, grupoId: ev?.grupoId ?? ev?.grupo_jid ?? evento.grupoId };
      if (podeConfirmarPendencia(cfg, origem, evento, { unidadeId: p.unidadeId, tipo: "COMPETENCIA", unidadesExigidas: null }).pode) visiveis.push(p);
    }
    if (!visiveis.length) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CONFIRMACAO_SEM_PERMISSAO_FINANCEIRA", resposta: RESPOSTA.complementoSemPermissao(), extra: { retomou: null } });
    const descrever = (p) => ({ idCurto: String(p.id).slice(0, 8), unidade: cfg.unidades.find((x) => x.unidadeId === p.unidadeId)?.nome ?? "unidade", valorCentavos: p.valorCentavos, favorecido: p.leitura?.favorecido ?? null });
    if (visiveis.length > 1) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VARIAS_PROPOSTAS_PENDENTES", resposta: RESPOSTA.qualProposta(visiveis.map(descrever)), extra: { retomou: null, propostas: visiveis.map((p) => String(p.id).slice(0, 8)) } });
    const p = visiveis[0];
    const unidade = cfg.unidades.find((x) => x.unidadeId === p.unidadeId);
    if (p.semExecucao || p.autonomiaDocumental?.nivel === "APLICAR_AUTOMATICO") {
      const r = await retomarProposta(evento, p.eventoId, ctxp);
      if (r) return r;
    }
    const duvida = (p.leitura?.incertezas ?? []).find((x) => typeof x === "string") ?? null;
    await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "CONFIRMACAO_DE_PROPOSTA_POR_CITACAO", participanteId: evento.participanteId, organizacaoId: unidade.organizacaoId, unidadeId: unidade.unidadeId, retomou: p.eventoId });
    return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "PROPOSTA_EXIGE_APROVACAO_NO_CENTRO", escopo: escopoDe(unidade), propostaId: p.id,
      resposta: RESPOSTA.propostaExigeAprovacao({ ...descrever(p), motivos: p.autonomiaDocumental?.motivos ?? [], duvida: duvida ? mascararDadosSensiveis(duvida).slice(0, 120) : null }), extra: { retomou: null, nivel: p.autonomiaDocumental?.nivel ?? null } });
  }

  /**
   * 26/11 — um documento novo pode ser DA MESMA COMPRA de uma proposta em revisão (cupom, nota, boleto, comprovante, recibo). Igualdade de
   * valor e favorecido é só um SINAL: com sinal, o MOVA pergunta (nunca presume duplicidade nem cria outra despesa sozinho).
   * @returns {Promise<object|null>} a proposta candidata, ou null
   */
  async function propostaDaMesmaCompra({ evento, escopo, saida }) {
    if (!evento.midia || !(saida.valorCentavos > 0)) return null;
    const recentes = (await a.propostas.listar(escopo)).filter((p) => p.tipo === "DESPESA_PAGA" && p.estado === "AGUARDANDO_REVISAO" && p.eventoId !== evento.eventoId
      && p.valorCentavos === saida.valorCentavos && p.evidencia?.sha256 !== evento.midia.sha256);
    const complementar = DOCUMENTOS_COMPLEMENTARES.includes(saida.tipoDocumento);
    const candidatas = recentes.filter((p) => complementar || favorecidosCompativeis(p.leitura?.favorecido, saida.favorecido));
    return candidatas.sort((x, y) => String(y.criadaEm ?? "").localeCompare(String(x.criadaEm ?? "")))[0] ?? null;
  }

  /**
   * 25/11 — retoma a execução automática de uma proposta DESPESA_PAGA já criada (citação da resposta do MOVA). Não cria proposta,
   * lançamento ou conta por conta própria: chama a MESMA execução (aposDespesaNova) que a criação chamou, com a política, as chaves e a
   * concessão de agora; a duplicidade é barrada pela reserva idempotente e pela chave da fonte (MOVA:<proposta>).
   * @returns {Promise<object|null>} null = não é com este fluxo (segue a mensagem normal)
   */
  /**
   * 27/11 — retomada de uma CONTA RELATADA já confirmada no WhatsApp que ficou parada (caso real f8f15a27): a MESMA proposta é executada
   * por aposContaRelatada, que revalida unidade, dados, política/limite vigentes e a concessão da identidade operacional. Quem retoma
   * precisa ser FINANCEIRO na unidade (reconhecido por LID ou telefone); a retomada fica auditada com quem confirmou.
   */
  async function retomarContaRelatada(evento, proposta, { grupo, daPessoa, motivoRelacao, eventoOrigemId }) {
    const unidade = cfg.unidades.find((x) => x.unidadeId === proposta.unidadeId) ?? null;
    if (!unidade || !daPessoa.unidades.includes(proposta.unidadeId)) return null;
    const escopo = escopoDe(unidade);
    const base = { escopo, propostaId: proposta.id };
    const quem = participanteAutorizado(grupo, { participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null });
    if (perfilNa(quem, unidade.unidadeId) !== "FINANCEIRO") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "RETOMADA_SEM_PERFIL_FINANCEIRO", ...base, resposta: RESPOSTA.complementoSemPermissao() });
    await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: motivoRelacao, participanteId: evento.participanteId, organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, retomou: eventoOrigemId });
    if (!execucao?.criarContas || typeof execucao.aposContaRelatada !== "function") return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "PROPOSTA_NAO_RETOMAVEL", ...base, resposta: RESPOSTA.semExecucaoAutomatica(["CRIACAO_DE_CONTAS_DESLIGADA"]) });
    const r = await execucao.aposContaRelatada(proposta, escopo);
    await a.auditoria.registrar({ acao: "PROPOSTA_RETOMADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: "CONTA_RELATADA", situacao: r.situacao, motivos: r.motivos ?? [], confirmadoAntesPor: proposta.esclarecidoPor } });
    const e = proposta.comando?.entrada ?? {};
    const c = { descricao: e.descricao ?? "Conta", parcelas: e.parcelas ?? [], totalCentavos: proposta.valorCentavos };
    if (r.situacao === "CONTA_REGISTRADA") return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: "CONTA_RELATADA_RETOMADA", ...base, resposta: RESPOSTA.contaRelatadaRegistrada(c, r.resultado), extra: { retomada: true } });
    const motivos = [...new Set([...(r.motivos ?? []), ...(r.motivo ? [r.motivo] : [])])];
    return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "RETOMADA_NAO_EXECUTADA", ...base, resposta: RESPOSTA.semExecucaoAutomatica(motivos), extra: { retomada: true, motivosExecucao: motivos } });
  }

  async function retomarProposta(evento, eventoOrigemId, { grupo, participante, daPessoa, podeConfirmar, recusarOutro }, { propostaId = null, motivoRelacao = "PROPOSTA_RETOMADA_POR_CITACAO", aviso = null } = {}) {
    if (typeof a.propostas.porEvento !== "function") return null;
    const todas = await a.propostas.porEvento(eventoOrigemId);
    const relatada = todas.find((p) => p.tipo === "CONTA_RELATADA" && p.estado === "AGUARDANDO_REVISAO" && p.esclarecidoPor && p.categoriaDefinida === true && (!propostaId || p.id === propostaId));
    if (relatada) return retomarContaRelatada(evento, relatada, { grupo, daPessoa, motivoRelacao, eventoOrigemId });
    const propostas = todas.filter((p) => p.tipo === "DESPESA_PAGA");
    // só é retomável a proposta que a POLÍTICA autorizou a aplicar sozinha e que ficou parada (motivo registrado, ou criada antes do registro do motivo)
    const proposta = propostas.find((p) => p.estado === "AGUARDANDO_REVISAO" && (propostaId ? p.id === propostaId : (p.semExecucao || p.autonomiaDocumental?.nivel === "APLICAR_AUTOMATICO"))) ?? null;
    if (!proposta) return null;
    const unidade = cfg.unidades.find((x) => x.unidadeId === proposta.unidadeId) ?? null;
    if (!unidade || !daPessoa.unidades.includes(proposta.unidadeId)) return null;
    const escopo = escopoDe(unidade); // a unidade tem de ser desta conversa e desta pessoa
    const ev = await a.eventos.obter(eventoOrigemId); // linha do banco (snake_case) ou objeto da memória (camelCase)
    const origem = { participanteId: ev?.participanteId ?? ev?.participante_jid ?? proposta.participanteId ?? null, telefoneE164: ev?.telefoneE164 ?? ev?.telefone_e164 ?? null, grupoId: ev?.grupoId ?? ev?.grupo_jid ?? evento.grupoId };
    if (!podeConfirmar(origem, { divergencia: { tipo: "COMPETENCIA", unidadeId: proposta.unidadeId }, saida: null })) return recusarOutro();
    const base = { escopo, propostaId: proposta.id };
    const responder = (decisao, motivo, texto, extra = {}) => concluir(evento, { decisao, motivo, ...base, resposta: texto, extra });
    await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: motivoRelacao, participanteId: evento.participanteId, organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, retomou: eventoOrigemId });
    if (proposta.estado !== "AGUARDANDO_REVISAO" || !execucao?.criarDespesas) return responder(DECISAO.PEDIR_INFORMACAO, "PROPOSTA_NAO_RETOMAVEL", execucao?.criarDespesas ? RESPOSTA.propostaNaoRetomavel() : RESPOSTA.semExecucaoAutomatica(["SEM_IDENTIDADE_OPERACIONAL"]));
    const competencia = proposta.datas?.competencia ?? proposta.comando?.entrada?.competencia ?? null;
    if (proposta.competenciaPendente || !competencia) return responder(DECISAO.PEDIR_INFORMACAO, "COMPETENCIA_PENDENTE", RESPOSTA.perguntaCompetencia(proposta.valorCentavos, proposta.leitura?.favorecido ?? null));
    const estado = await porta.estadoDaCompetencia(escopo, competencia);
    if (estado !== "ABERTA") return responder(DECISAO.BLOQUEADO, `COMPETENCIA_${estado}`, RESPOSTA.competenciaFechada(competencia));
    const r = await execucao.aposDespesaNova(proposta, escopo);
    await a.auditoria.registrar({ acao: "PROPOSTA_RETOMADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { situacao: r.situacao, motivos: r.motivosDocumentais ?? r.motivos ?? [] } });
    const resumo = { unidade: unidade.nome ?? null, descricao: proposta.comando?.entrada?.descricao ?? null, categoriaDefinida: Boolean(proposta.comando?.entrada?.categoria && proposta.comando.entrada.categoria !== "A_CLASSIFICAR"), intactas: [], contaNova: true };
    const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]);
    const privado = rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null;
    if (r.situacao === "PAGO_POR_COMPROVANTE") {
      return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: "DESPESA_PAGA_RETOMADA", ...base, resposta: (aviso ? `${aviso}\n` : "") + RESPOSTA.despesaPagaPorComprovante(proposta, r.resultado, resumo), privado, extra: { conciliacao: r.situacao, retomada: true } });
    }
    const motivos = [...new Set([...(r.motivosDocumentais ?? []), ...(r.motivos ?? []), ...(r.motivo ? [r.motivo] : [])])];
    return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "RETOMADA_NAO_EXECUTADA", ...base, resposta: (aviso ? `${aviso}\n` : "") + RESPOSTA.semExecucaoAutomatica(motivos), privado, extra: { retomada: true, motivosExecucao: motivos } });
  }

  /**
   * 23/11 — PERGUNTA objetiva de divergência: guarda a pendência (a resposta continua a operação) e responde no grupo ou, com valor,
   * conforme a política de resposta (privado). Nada é gravado no Financeiro.
   */
  async function perguntar({ evento, escopo, saida, injecao, unidade, grupo = null, participante = null, esclarecimento = null }, divergencia, texto, motivo) {
    const rota = await roteamento(grupo, participante, evento, "DOCUMENTO_COM_VALOR", [unidade.unidadeId]);
    const privado = rota && !rota.noGrupo ? { destino: rota.destino ?? null, aviso: RESPOSTA.documentoNoPrivado(), avisoSemPrivado: RESPOSTA.documentoSemPrivado() } : null;
    // A resposta vem na MESMA conversa em que a pergunta saiu (grupo ou privado): é por ela que a memória curta reencontra a pendência.
    await a.mensagens.lembrar(evento.mensagemId, { grupoId: privado?.destino ?? evento.grupoId, pendente: { evento, saida, divergencia: { ...divergencia, unidadeId: unidade.unidadeId }, ...(esclarecimento?.observacoes?.length ? { observacoes: esclarecimento.observacoes } : {}) } });
    return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo, escopo, resposta: texto, injecao, extra: { divergencia: divergencia.tipo }, privado });
  }

  /**
   * 27/11 (0035) — "sim" ao pagamento de EMPRÉSTIMO já feito: a proposta guardada é executada (conta + pagamento juntos, quitada, fora da
   * DRE) pela permissão estreita de empréstimo, se quem confirma é FINANCEIRO na unidade e a política/limite da unidade aceita. "não"
   * deixa a proposta para a Central. Nada é relido: o documento e os dados são os da proposta.
   */
  async function confirmarEmprestimoPago(ctx) {
    const { evento, escopo, esclarecimento, injecao, unidade } = ctx;
    const div = esclarecimento.divergencia;
    const p = await a.propostas.obter(escopo, div.propostaId);
    if (!p || p.estado !== "AGUARDANDO_REVISAO") return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "EMPRESTIMO_PROPOSTA_JA_DECIDIDA", escopo, resposta: RESPOSTA.propostaNaoRetomavel(), injecao });
    const sim = respostaSimNao(esclarecimento.texto);
    if (sim === null) return perguntar(ctx, { ...div }, `Não entendi. ${RESPOSTA.confirmarEmprestimoPago(p, {})}`, "EMPRESTIMO_RESPOSTA_NAO_ENTENDIDA");
    if (sim === false) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "EMPRESTIMO_NAO_CONFIRMADO", escopo, propostaId: p.id, resposta: RESPOSTA.emprestimoNaoConfirmado(p), injecao, extra: { confirmadoPor: esclarecimento.participanteId ?? null } });
    // 27/11: quem confirmou é reconhecido pelo identificador OU pelo telefone autenticado do Gateway (lista por telefone; WhatsApp manda LID)
    // 28/11 (#250): identificador e telefone de PESSOAS DIFERENTES ⇒ bloqueia e audita (nunca escolhe uma das duas)
    const quemConfirma = identificarParticipante(ctx.grupo, { participanteId: esclarecimento.participanteId ?? evento.participanteId, telefoneE164: esclarecimento.telefoneE164 ?? null });
    if (quemConfirma.conflito) {
      await a.auditoria.registrar({ acao: "IDENTIDADE_CONFLITANTE", atorTipo: "PARTICIPANTE", atorRef: esclarecimento.participanteId ?? evento.participanteId, alvo: p.id, dados: { fluxo: "EMPRESTIMO_PAGO_CONFIRMACAO" } });
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "IDENTIDADE_CONFLITANTE", escopo, propostaId: p.id, resposta: RESPOSTA.complementoSemPermissao(), injecao });
    }
    const confirmador = quemConfirma.participante;
    // 28/11: composição (só principal) precisa estar COMPROVADA ou DECLARADA — desconhecida ⇒ revisão humana no Centro Financeiro
    if (!p.comando?.composicaoEmprestimo) return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: "EMPRESTIMO_COMPOSICAO_DESCONHECIDA", escopo, propostaId: p.id, resposta: RESPOSTA.emprestimoNaoExecutado(p, ["EMPRESTIMO_COMPOSICAO_DESCONHECIDA"]), injecao });
    if (perfilNa(confirmador, unidade.unidadeId) !== "FINANCEIRO") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "EMPRESTIMO_CONFIRMACAO_SEM_PERFIL_FINANCEIRO", escopo, resposta: RESPOSTA.complementoSemPermissao(), injecao });
    const r = await execucao.aposDespesaNova(p, escopo, { confirmadoPor: esclarecimento.participanteId ?? evento.participanteId });
    if (r.situacao === "PAGO_POR_COMPROVANTE") return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: "EMPRESTIMO_PAGO_REGISTRADO", escopo, propostaId: p.id, resposta: RESPOSTA.emprestimoPagoRegistrado(p, r.resultado), injecao, extra: { confirmadoPor: esclarecimento.participanteId ?? null } });
    return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: "EMPRESTIMO_NAO_EXECUTADO", escopo, propostaId: p.id, resposta: RESPOSTA.emprestimoNaoExecutado(p, [...new Set([...(r.motivosDocumentais ?? []), ...(r.motivos ?? []), ...(r.motivo ? [r.motivo] : [])])]), injecao });
  }

  /**
   * 28/11 — resposta à pergunta "Confirma o registro?" da conta a pagar de nota/boleto (política CONTA_A_PAGAR "com confirmação").
   * "sim" ⇒ registra (unidade da PROPOSTA; quem confirma tem de ser FINANCEIRO nela); "não" ⇒ a proposta fica para o Centro Financeiro;
   * outra coisa ⇒ repete a pergunta (pendência preservada).
   */
  async function responderConfirmacaoDeContaNova({ evento, grupo, esclarecimento }) {
    const div = esclarecimento.divergencia;
    const unidade = cfg.unidades.find((x) => x.unidadeId === div.unidadeId) ?? null;
    if (!unidade) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONTA_NOVA_UNIDADE_FORA_DO_MOVA", resposta: RESPOSTA.propostaNaoRetomavel() });
    const escopo = escopoDe(unidade);
    const p = await a.propostas.obter(escopo, div.propostaId);
    if (!p || p.estado !== "AGUARDANDO_REVISAO" || p.tipo !== "NOVA_OBRIGACAO") return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONTA_NOVA_PROPOSTA_JA_DECIDIDA", escopo, resposta: RESPOSTA.propostaNaoRetomavel() });
    const sim = respostaSimNao(esclarecimento.texto) ?? (confirmacaoDeProposta(esclarecimento.texto) ? true : null);
    if (sim === false) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONTA_NOVA_NAO_CONFIRMADA", escopo, propostaId: p.id, resposta: RESPOSTA.contaNovaNaoConfirmada(p), extra: { confirmadoPor: esclarecimento.participanteId ?? null } });
    if (sim === null) {
      await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: esclarecimento.saida ?? null, divergencia: div } });
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CONTA_NOVA_RESPOSTA_NAO_ENTENDIDA", escopo, propostaId: p.id, resposta: `Não entendi. ${RESPOSTA.confirmarContaNova(p, unidade.nome)}` });
    }
    return registrarContaNovaConfirmada({ evento, grupo, proposta: p, confirmante: { participanteId: esclarecimento.participanteId ?? evento.participanteId, telefoneE164: esclarecimento.telefoneE164 ?? null }, pendente: { esclarecimento, div } });
  }

  /** 28/11 — registra a conta a pagar de uma proposta NOVA_OBRIGACAO com a confirmação de quem é FINANCEIRO na unidade dela (auditado). */
  async function registrarContaNovaConfirmada({ evento, grupo, proposta: p, confirmante, pendente = null, eventoOrigemId = null }) {
    const unidade = cfg.unidades.find((x) => x.unidadeId === p.unidadeId) ?? null;
    if (!unidade) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONTA_NOVA_UNIDADE_FORA_DO_MOVA", resposta: RESPOSTA.propostaNaoRetomavel() });
    const escopo = escopoDe(unidade);
    const quem = identificarParticipante(grupo, confirmante);
    if (quem.conflito) {
      await a.auditoria.registrar({ acao: "IDENTIDADE_CONFLITANTE", atorTipo: "PARTICIPANTE", atorRef: confirmante.participanteId, alvo: p.id, dados: { fluxo: "CONTA_NOVA_CONFIRMACAO" } });
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "IDENTIDADE_CONFLITANTE", escopo, propostaId: p.id, resposta: RESPOSTA.complementoSemPermissao() });
    }
    if (!quem.participante || quem.participante.aberto || perfilNa(quem.participante, unidade.unidadeId) !== "FINANCEIRO") {
      // a pergunta continua aberta para quem pode (a pendência é devolvida)
      if (pendente) await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: pendente.esclarecimento.saida ?? null, divergencia: pendente.div } });
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CONTA_NOVA_CONFIRMACAO_SEM_PERFIL_FINANCEIRO", escopo, propostaId: p.id, resposta: RESPOSTA.complementoSemPermissao() });
    }
    if (eventoOrigemId) await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "CONTA_NOVA_CONFIRMADA_POR_CITACAO", participanteId: evento.participanteId, organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, retomou: eventoOrigemId });
    if (!execucao?.criarContas || typeof execucao.aposContaNova !== "function") return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: "CONTA_NOVA_NAO_EXECUTADA", escopo, propostaId: p.id, resposta: RESPOSTA.semExecucaoAutomatica(["CRIACAO_DE_CONTAS_DESLIGADA"]) });
    const r = await execucao.aposContaNova(p, escopo, { confirmadoPor: confirmante.participanteId });
    await a.auditoria.registrar({ acao: "CONTA_NOVA_CONFIRMADA", atorTipo: "PARTICIPANTE", atorRef: confirmante.participanteId, alvo: p.id, dados: { situacao: r.situacao, nivel: r.nivel ?? null, motivos: r.motivos ?? [] } });
    if (r.situacao === "CONTA_REGISTRADA") return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: "CONTA_NOVA_CONFIRMADA_REGISTRADA", escopo, propostaId: p.id, resposta: RESPOSTA.contaRegistrada(p, r.resultado), extra: { confirmadoPor: confirmante.participanteId } });
    const motivos = [...new Set([...(r.motivos ?? []), ...(r.motivo ? [r.motivo] : [])])];
    return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: "CONTA_NOVA_NAO_EXECUTADA", escopo, propostaId: p.id, resposta: RESPOSTA.semExecucaoAutomatica(motivos), extra: { motivosExecucao: motivos } });
  }

  async function tratarPagamento(ctx0) {
    // 25/11: identificador de transação RECORTADO na imagem (E2E incompleto) não serve de chave de duplicidade: é descartado e a
    // conferência segue pelas demais evidências (arquivo, conta, pergunta objetiva) — nunca afirma "mesma transação" por ele.
    const recortado = Boolean(ctx0.saida?.idTransacao) && !idTransacaoConfiavel(ctx0.saida.idTransacao);
    const ctx = recortado ? { ...ctx0, idRecortado: true, saida: { ...ctx0.saida, idTransacao: null } } : ctx0;
    const { evento, escopo, saida, injecao, esclarecimento } = ctx;
    if (esclarecimento?.divergencia?.tipo === "EMPRESTIMO_PAGO_CONFIRMACAO") return confirmarEmprestimoPago(ctx);
    // 25/11 — resposta NATURAL a uma pergunta do MOVA: as regras curtas (determinísticas, custo zero) vêm primeiro; só se NÃO entenderem a
    // IA lê o texto e devolve campos estruturados, que o backend VALIDA (extracaoDaRespostaIA) antes de qualquer uso. No máximo UMA
    // leitura por mensagem (cache) e nenhuma quando a mensagem já foi lida (resposta sem citação traz `esclarecimento.ia`).
    // Falha, orçamento esgotado ou leitura inválida ⇒ não entendeu (pergunta de novo, nada é registrado).
    let leituraIa;
    const lerRespostaPorIA = async () => {
      if (leituraIa !== undefined) return leituraIa;
      leituraIa = esclarecimento?.ia ? extracaoDaRespostaIA(esclarecimento.ia, { texto: esclarecimento.texto, dataPagamento: saida.dataPagamento }) : null;
      if (leituraIa || !esclarecimento?.divergencia || !esclarecimento.texto) return leituraIa;
      try {
        const lida = await lerDocumento({ eventoId: evento.eventoId, tipo: "TEXTO", texto: esclarecimento.texto, grupoId: evento.grupoId, midia: null }, ctx.grupo ?? { unidades: [escopo.unidadeId] }, null, { perguntaPendente: descreverPendencia(esclarecimento.divergencia) });
        if (lida.ok) leituraIa = extracaoDaRespostaIA(lida.saida, { texto: esclarecimento.texto, dataPagamento: saida.dataPagamento });
      } catch { /* indisponível: segue como "não entendi" */ }
      return leituraIa;
    };
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
    // 26/11 — resposta à pergunta "é da mesma compra?": sim ⇒ anexa à proposta existente (sem despesa nova); não ⇒ segue como outra compra.
    let mesmaCompraNegada = false;
    if (esclarecimento?.divergencia?.tipo === TIPO_DIVERGENCIA.MESMA_COMPRA) {
      const sn = respostaSimNao(esclarecimento.texto);
      const alvo = (await a.propostas.listar(escopo)).find((p) => p.id === esclarecimento.divergencia.propostaId) ?? null;
      if (sn === null) return perguntar(ctx, esclarecimento.divergencia, RESPOSTA.mesmaCompraSemResposta(), "MESMA_COMPRA_SEM_RESPOSTA");
      if (sn === true && alvo) {
        const doc = { eventoId: evento.eventoId, sha256: evento.midia?.sha256 ?? null, referencia: evento.midia?.referencia ?? null, tipoDocumento: saida.tipoDocumento ?? null, valorCentavos: valor, em: relogio().toISOString() };
        const ja = (alvo.documentosComplementares ?? []).some((x) => x.sha256 && x.sha256 === doc.sha256);
        if (!ja) await a.propostas.anotar(escopo, alvo.id, { documentosComplementares: [...(alvo.documentosComplementares ?? []), doc] });
        await a.auditoria.registrar({ acao: "DOCUMENTO_COMPLEMENTAR_VINCULADO", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: alvo.id, dados: { tipoDocumento: doc.tipoDocumento } });
        return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "DOCUMENTO_COMPLEMENTAR_VINCULADO", escopo, propostaId: alvo.id, resposta: RESPOSTA.documentoComplementarVinculado(alvo.id), injecao });
      }
      mesmaCompraNegada = true;
    } else if (!esclarecimento && evento.midia) {
      const relacionada = await propostaDaMesmaCompra({ evento, escopo, saida });
      if (relacionada) {
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.MESMA_COMPRA, valorCentavos: valor, candidatas: [], propostaId: relacionada.id }, RESPOSTA.perguntaMesmaCompra(valor, saida.tipoDocumento === "COMPROVANTE_PAGAMENTO" ? null : saida.tipoDocumento, relacionada.leitura?.favorecido ?? null, relacionada.id), "POSSIVEL_DOCUMENTO_COMPLEMENTAR");
      }
    }
    void mesmaCompraNegada;
    const legenda = evento.midia ? legendaDoDocumento(evento.texto) : null; // legenda da mensagem original: descrição e evidência (entrada não confiável)
    // 25/11: juros/multa DISCRIMINADOS no comprovante e soma conferida (original + juros + multa − desconto = pago) ⇒ comprovado:
    // não pergunta se a diferença é juros. Genérico (qualquer boleto); a IA só lê os campos impressos, a conta é determinística.
    const composicao = evento.midia ? composicaoComprovada(saida) : null;
    // 25/11: PERÍODO/competência informados na legenda ("vale-refeição de 24/11 a 30/11", "aluguel referente a novembro"). Conta de
    // OUTRO período (outra semana do mesmo benefício, outra competência) não é candidata, mesmo com a mesma pessoa e o mesmo valor.
    const periodo = evento.midia ? periodoDaLegenda(legenda, saida.dataPagamento) : null;
    const noPeriodo = (t) => contaCompativelComPeriodo(t, periodo);
    let candidatas = (saida.favorecido ? abertas.filter((t) => fornecedorCompativel(saida.favorecido, t)) : abertas.filter((t) => t.saldoCentavos === valor || (composicao && t.saldoCentavos === composicao.principalCentavos))).filter(noPeriodo);
    let forcarNova = false; let contaEscolhida = null; let parcialConfirmado = false; let competenciaInformada = null;
    // Pagamento COM encargo de uma conta existente: um só caminho (resposta "são juros" ou composição comprovada no comprovante).
    const propostaComEncargo = (conta, encargo, confirmadoPor, comp = null) => criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, valorCentavos: valor, parcial: false,
      datas: { competencia: conta.competencia, caixa: saida.dataPagamento, vencimento: conta.vencimento },
      comando: { operacao: "pagarContaAPagar", entrada: { obrigacaoId: conta.id, contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor },
        juros: { valorCentavos: encargo, principalCentavos: conta.saldoCentavos, confirmadoPor,
          ...(comp ? { jurosCentavos: comp.jurosCentavos, multaCentavos: comp.multaCentavos, tipoEncargo: comp.jurosCentavos && comp.multaCentavos ? "JUROS_E_MULTA" : comp.jurosCentavos ? "JUROS" : "MULTA" } : {}) } },
    }, (p) => RESPOSTA.jurosAguardandoFinanceiro(p, conta, encargo), {
      // Com as chaves, a política JUROS_DOCUMENTAL (limite = encargo máximo) e a ação `registrar_juros`: registra encargo + pagamento por comprovante.
      posCriacao: execucao?.registrarJuros ? async (p) => {
        const r = await execucao.aposJuros(p, escopo);
        return r.situacao === "PAGO_POR_COMPROVANTE" ? { ...r, texto: RESPOSTA.pagoComJuros(p, r.resultado) } : r;
      } : null,
    });
    // 24/11 — o que a PESSOA disse sobre a finalidade e o que comprou (lido semanticamente; a resposta a uma pergunta prevalece
    // sobre a legenda do documento). "Compra nova" declarada não é presumida pela ausência de conta nem negada por valor igual.
    const finalidadeDaLegenda = evento.midia && !esclarecimento?.divergencia ? saida.finalidadePagamento ?? null : null;
    const novaDeclarada = finalidadeDaLegenda === "COMPRA_NOVA";
    let descricaoInformada = esclarecimento?.descricao ?? saida.descricaoCompra ?? null;
    if (novaDeclarada) forcarNova = true;
    if (finalidadeDaLegenda === "PARCIAL") parcialConfirmado = true;

    // 25/11 — resposta a "Qual é o mês de referência dessa conta?": a competência é a INFORMADA pela pessoa (nunca presumida).
    if (esclarecimento?.divergencia?.tipo === TIPO_DIVERGENCIA.COMPETENCIA) {
      const pend = esclarecimento.divergencia;
      competenciaInformada = competenciaDaResposta(esclarecimento.texto, saida.dataPagamento, hoje()) ?? (await lerRespostaPorIA())?.competencia ?? null;
      if (!competenciaInformada) return perguntar(ctx, pend, RESPOSTA.naoEntendiCompetencia(), "COMPETENCIA_NAO_ENTENDIDA");
      forcarNova = pend.forcarNova === true;
      if (pend.descricao) descricaoInformada = pend.descricao;
    // 23/11 — RESPOSTA a uma pergunta de divergência: a operação CONTINUA (sem segunda confirmação) conforme o que a pessoa disse.
    } else if (esclarecimento?.divergencia) {
      const pend = esclarecimento.divergencia;
      // 24/11: pergunta "o que foi comprado?" — a resposta é a DESCRIÇÃO (curta e direta, ou lida pela IA); a compra é nova.
      if (pend.tipo === TIPO_DIVERGENCIA.DESCRICAO) {
        descricaoInformada = esclarecimento.descricao ?? descricaoDireta(esclarecimento.texto) ?? (await lerRespostaPorIA())?.descricao ?? null;
        if (!descricaoInformada) return perguntar(ctx, pend, RESPOSTA.naoEntendiDescricao(), "DESCRICAO_NAO_ENTENDIDA");
      }
      let desf = pend.tipo === TIPO_DIVERGENCIA.DESCRICAO || pend.tipo === TIPO_DIVERGENCIA.MESMA_COMPRA ? { desfecho: DESFECHO.NOVA } : interpretarResposta(esclarecimento.texto, pend);
      // 24/11: as regras curtas não entenderam ⇒ vale o SENTIDO lido da resposta (só onde ele faz sentido; a IA nunca escolhe conta).
      if (desf.desfecho === DESFECHO.NAO_ENTENDI) desf = desfechoPorFinalidade(esclarecimento.finalidade ?? (await lerRespostaPorIA())?.finalidade ?? null, pend);
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
        // 24/11 — VERSÃO: a resposta vale para a conta COMO ELA ESTAVA na pergunta. Se o saldo mudou desde então (outra baixa,
        // correção), a pergunta ficou desatualizada: nada é executado e a conferência é refeita com o documento.
        const naPergunta = (pend.candidatas ?? []).find((c) => c.id === contaEscolhida.id);
        // revisão 24/11: a VERSÃO é a conta inteira (valor, saldo, pago, fornecedor, categoria, competência, vencimento, situação,
        // unidade) — e a unidade da pendência tem de ser a desta retomada.
        const versaoAgora = versaoDaConta(contaEscolhida, escopo.unidadeId);
        const unidadeMudou = Boolean(pend.unidadeId) && pend.unidadeId !== escopo.unidadeId;
        const saldoMudou = Number.isInteger(naPergunta?.saldoCentavos) && naPergunta.saldoCentavos !== contaEscolhida.saldoCentavos;
        const versaoMudou = saldoMudou || (Boolean(naPergunta?.versao) && naPergunta.versao !== versaoAgora);
        if (unidadeMudou || versaoMudou) {
          const mudou = unidadeMudou ? ["unidade"] : [...new Set([...(saldoMudou ? ["saldo"] : []), ...(naPergunta?.versao ? camposAlterados(naPergunta.versao, versaoAgora) : [])])];
          return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "PERGUNTA_DESATUALIZADA", escopo, resposta: RESPOSTA.perguntaDesatualizada(naPergunta?.saldoCentavos ?? null, contaEscolhida.saldoCentavos, mudou), injecao, extra: { mudou } });
        }
        if (desf.desfecho === DESFECHO.PARCIAL) parcialConfirmado = true;
        if (desf.desfecho === DESFECHO.JUROS) {
          if (valor <= contaEscolhida.saldoCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "JUROS_SEM_DIFERENCA", escopo, resposta: RESPOSTA.faltaInformacao(["a diferença não existe mais (o saldo mudou); reenvie o comprovante"]), injecao });
          // Juros CONFIRMADOS pela pessoa: nenhuma segunda conta; encargo + pagamento pelo caminho único.
          return propostaComEncargo(contaEscolhida, valor - contaEscolhida.saldoCentavos, esclarecimento.participanteId);
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
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.MENOR, valorCentavos: valor, candidatas: [{ id: casamento.conta.id, saldoCentavos: casamento.conta.saldoCentavos, versao: versaoDaConta(casamento.conta, escopo.unidadeId) }] }, RESPOSTA.perguntaValorMenor(casamento.conta, valor), "VALOR_MENOR_QUE_SALDO", [casamento.conta]);
      }
      // 25/11: o comprovante DISCRIMINA os encargos e o principal é o saldo de UMA conta do favorecido ⇒ pagamento dessa conta com
      // juros/multa comprovados, sem pergunta. Mais de uma conta com esse saldo continua perguntando qual.
      if (composicao && (casamento.caso === "MAIOR" || casamento.caso === "VARIAS")) {
        const lista = casamento.caso === "MAIOR" ? [casamento.conta] : casamento.candidatas;
        const exatas = lista.filter((t) => t.saldoCentavos === composicao.principalCentavos);
        if (exatas.length === 1) return propostaComEncargo(exatas[0], composicao.encargoCentavos, "COMPROVANTE", composicao);
      }
      if (casamento.caso === "MAIOR") {
        // 24/11 (caso real dos brownies: comprovante R$ 259 × conta de R$ 81): diferença grande demais para ser juros não vira a
        // pergunta "são juros?" — a pergunta objetiva passa a ser "é uma compra nova?" (o "sim" registra a compra nova paga).
        if (!contaEscolhida && !diferencaPlausivelComoJuros({ valorCentavos: valor, saldoCentavos: casamento.conta.saldoCentavos })) {
          return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.NOVA_OU_CONTA, valorCentavos: valor, candidatas: [{ id: casamento.conta.id, saldoCentavos: casamento.conta.saldoCentavos, versao: versaoDaConta(casamento.conta, escopo.unidadeId) }] }, RESPOSTA.perguntaCompraNovaOuConta(casamento.conta, valor), "DIFERENCA_GRANDE_DEMAIS_PARA_JUROS", [casamento.conta]);
        }
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.MAIOR, valorCentavos: valor, candidatas: [{ id: casamento.conta.id, saldoCentavos: casamento.conta.saldoCentavos, versao: versaoDaConta(casamento.conta, escopo.unidadeId) }] }, RESPOSTA.perguntaValorMaior(casamento.conta, valor), "VALOR_MAIOR_QUE_SALDO", [casamento.conta]);
      }
      if (casamento.caso === "VARIAS") {
        const proximas = [...casamento.candidatas].sort((x, y) => Math.abs(x.saldoCentavos - valor) - Math.abs(y.saldoCentavos - valor)).slice(0, MAX_CANDIDATAS_NA_PERGUNTA);
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.VARIAS, valorCentavos: valor, candidatas: proximas.map((t) => ({ id: t.id, saldoCentavos: t.saldoCentavos, versao: versaoDaConta(t, escopo.unidadeId) })) }, RESPOSTA.perguntaVariasContas(proximas), "VARIAS_OBRIGACOES_COMPATIVEIS", proximas);
      }
    }
    // Nenhuma conta do favorecido (ou a pessoa disse "outra compra"): compra NOVA — mas a AUSÊNCIA de conta do mesmo favorecido não é,
    // sozinha, prova de compra nova: antes, procura o mesmo pagamento já registrado e conta aberta de outro fornecedor com o mesmo valor.
    // 24/11: com "compra nova" DECLARADA, ainda se confere o pagamento IGUAL já registrado (mesmo favorecido, mesmo valor, data
    // próxima — possível reenvio do mesmo comprovante); conta aberta de outro fornecedor com o mesmo valor não é perguntada.
    if (!esclarecimento?.divergencia && (!forcarNova || novaDeclarada)) {
      const achados = buscarSemelhantes({ todas: (await porta.contasAPagarTodas(escopo)).filter(noPeriodo), valorCentavos: valor, favorecido: saida.favorecido, legenda, dataPagamento: saida.dataPagamento, compativel: (t) => fornecedorCompativel(saida.favorecido, t) });
      const semelhantes = novaDeclarada ? achados.filter((x) => x.situacao === "PAGA") : achados;
      const abertasSemelhantes = semelhantes.filter((x) => x.situacao === "ABERTA");
      // 27/11: várias contas abertas de OUTRO fornecedor com o mesmo valor (e nenhum pagamento igual já registrado): pede a escolha —
      // nunca baixa nem cria despesa sozinho.
      if (semelhantes[0]?.situacao === "ABERTA" && abertasSemelhantes.length > 1) {
        const proximas = abertasSemelhantes.slice(0, MAX_CANDIDATAS_NA_PERGUNTA).map((x) => x.conta);
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.VARIAS, valorCentavos: valor, candidatas: proximas.map((t) => ({ id: t.id, saldoCentavos: t.saldoCentavos, versao: versaoDaConta(t, escopo.unidadeId) })) }, RESPOSTA.perguntaVariasContas(proximas), "VARIAS_OBRIGACOES_COMPATIVEIS", proximas);
      }
      if (semelhantes.length) {
        const [primeiro] = semelhantes;
        // Valor, data e favorecido iguais NÃO provam a mesma transação: pergunta; com o identificador recortado, pede o comprovante completo.
        const texto = primeiro.situacao === "PAGA" ? RESPOSTA.perguntaSemelhantePaga(primeiro.conta) : RESPOSTA.perguntaSemelhanteAberta(primeiro.conta);
        return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.SEMELHANTE, valorCentavos: valor, candidatas: [{ id: primeiro.conta.id, situacao: primeiro.situacao }] },
          recortado ? `${texto} O identificador da transação está cortado na imagem: se puder, envie o comprovante completo.` : texto, "POSSIVEL_COMPRA_JA_REGISTRADA");
      }
    }
    // 15A: competência = a INFORMADA (ou o mês da emissão do documento, que é fato do documento). Nunca o mês do vencimento,
    // do pagamento ou do recebimento: sem ela, a proposta nasce com competência PENDENTE, a confirmar na revisão humana.
    // 25/11: a competência INEQUÍVOCA da legenda vale (período num mês só ou um único mês citado). Período que atravessa dois meses,
    // dois meses citados ou legenda que contradiz a leitura ⇒ sem competência: o MOVA pergunta só o mês (nunca escolhe).
    const daLegenda = periodo?.competencia ?? null;
    const duvida = Boolean(periodo?.ambigua) || Boolean(daLegenda && saida.competencia && daLegenda !== saida.competencia);
    const competencia = competenciaInformada ?? (duvida ? null : daLegenda ?? saida.competencia ?? mes(saida.dataEmissao) ?? null);
    const bloqueioEconomico = competencia ? await competenciaAberta(ctx, competencia) : null;
    if (bloqueioEconomico) return bloqueioEconomico;
    // 24/11: a descrição é o que a PESSOA disse que comprou (legenda, mensagem posterior ou resposta à pergunta), lido pela IA; sem
    // ela, a legenda inteira. A categoria vem do plano da unidade casando com essa descrição (uma só categoria; senão "a classificar").
    const textoDaCompra = [legenda, descricaoInformada].filter(Boolean).join(" ") || null;
    // só aproveita uma leitura que JÁ existe (a categoria nunca é motivo para chamar a IA)
    const lidaPelaIa = esclarecimento?.ia || leituraIa ? await lerRespostaPorIA() : null;
    let categoria = await categoriaDaDespesa(escopo, lidaPelaIa?.categoria && !saida.categoriaSugerida ? { ...saida, categoriaSugerida: lidaPelaIa.categoria } : saida, textoDaCompra);
    // 27/11 (caso real: boleto do empréstimo BNB já pago): o comprovante do PRINCIPAL de empréstimo/financiamento vai para a categoria
    // PATRIMONIAL do plano (fora da DRE) — ela vence qualquer despesa de nome parecido. A permissão estreita do MOVA não registra
    // patrimonial: a proposta (conta + pagamento juntos, nunca conta em aberto) fica para aprovação no Centro Financeiro.
    const patrimonialDoPagamento = evento.midia ? categoriaPatrimonialDoRelato(`${textoDaCompra ?? legenda ?? ""} ${String(saida.categoriaSugerida ?? "").replace(/_/g, " ")}`, await planoDaUnidade(escopo)) : null;
    if (patrimonialDoPagamento) categoria = patrimonialDoPagamento;
    // valor original, desconto e valor pago IMPRESSOS no comprovante (original − desconto = pago, centavo a centavo): preservados na descrição
    const comDesconto = Number.isSafeInteger(saida.valorOriginalCentavos) && Number.isSafeInteger(saida.descontoCentavos) && saida.descontoCentavos > 0
      && saida.valorOriginalCentavos - saida.descontoCentavos === valor ? ` — original ${reaisCurto(saida.valorOriginalCentavos)}, desconto ${reaisCurto(saida.descontoCentavos)}, pago ${reaisCurto(valor)}` : "";
    const descricao = (descricaoInformada ?? legenda) ? `${descricaoInformada ?? legenda}${comDesconto}` : null;
    // 27/11: observações (#244) também no comprovante: as da LEGENDA e as informadas na conversa desta operação vão com a proposta até a conta
    const observacaoDoPagamento = [observacaoDoTexto(legenda), ...(esclarecimento?.observacoes ?? [])].filter(Boolean).join("; ") || null;
    // Compra nova pelo comprovante sem descrição e sem categoria: pergunta SÓ o que foi comprado (uma vez), em vez de lançar às cegas.
    if (evento.midia && !descricao && !categoria && esclarecimento?.divergencia?.tipo !== TIPO_DIVERGENCIA.DESCRICAO) {
      return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.DESCRICAO, valorCentavos: valor, candidatas: [] }, RESPOSTA.perguntaDescricao(valor), "DESCRICAO_DA_COMPRA_AUSENTE");
    }
    // 25/11: comprovante sem mês de referência ⇒ pergunta SÓ isso (o Financeiro não registra conta sem competência e o MOVA não a
    // inventa: nem o mês do pagamento, nem o do vencimento). A resposta continua a operação sem nova confirmação.
    // Sem a execução automática ligada, vale o fluxo 15A (proposta com competência a confirmar na revisão humana, reaproveitado).
    if (evento.midia && !competencia && execucao?.criarDespesas) {
      return perguntar(ctx, { tipo: TIPO_DIVERGENCIA.COMPETENCIA, valorCentavos: valor, candidatas: [], forcarNova, descricao: descricaoInformada ?? null }, RESPOSTA.perguntaCompetencia(valor, saida.favorecido), "COMPETENCIA_AUSENTE");
    }
    // 25/11: com encargos comprovados, a conta nasce pelo valor ORIGINAL (o encargo é lançado à parte) e vence no vencimento impresso.
    const vencimentoDaConta = composicao && saida.vencimento ? saida.vencimento : saida.dataPagamento;
    const comando = comandoDeObrigacao(composicao ? { ...saida, valorCentavos: composicao.principalCentavos } : saida, { competencia, vencimento: vencimentoDaConta, descricao: descricao ? mascararDadosSensiveis(descricao).slice(0, 120) : null, categoria, observacao: observacaoDoPagamento });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    // 28/11 (0035, revisão): pagamento de EMPRÉSTIMO — composição "só principal" comprovada no documento ou declarada na conversa
    const composicaoEmprestimo = patrimonialDoPagamento === "EMPRESTIMOS_E_FINANCIAMENTOS" && !composicao
      ? composicaoSoPrincipal(saida, [legenda, esclarecimento?.texto, ...(esclarecimento?.observacoes ?? [])].filter(Boolean).join(". ")) : null;
    // Resumo consolidado: unidade, categoria e as contas em aberto do MESMO favorecido que este comprovante NÃO baixou.
    // A resposta NUNCA repete o texto recebido: só a descrição CURTA lida pela IA, mascarada e sem sinal de instrução, aparece.
    const descricaoExibivel = descricaoInformada && !sinaisDeInjecao(descricaoInformada) ? mascararDadosSensiveis(descricaoInformada).slice(0, 60) : null;
    const resumo = { unidade: ctx.unidade?.nome ?? null, descricao: descricaoExibivel, categoriaDefinida: Boolean(categoria), intactas: forcarNova && saida.favorecido ? candidatas : [], contaNova: true,
      ...(patrimonialDoPagamento ? { patrimonial: true, comDesconto: comDesconto || null } : {}), ...(observacaoDoPagamento ? { observacao: observacaoDoPagamento } : {}) };
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.DESPESA_PAGA, valorCentavos: valor, parcial: false,
      datas: { competencia, caixa: saida.dataPagamento, vencimento: vencimentoDaConta }, competenciaPendente: !competencia,
      // Execução 17: com comprovante, a aplicação registra a conta e o pagamento POR COMPROVANTE (nenhuma saída bancária
      // criada; o extrato concilia depois). Sem arquivo (relato por texto), a pessoa escolhe a conta do pagamento.
      // 24/11: com comprovante, a conta e o pagamento entram numa ÚNICA operação atômica (registrarDespesaPagaPorComprovante).
      comando: { operacao: !evento.midia ? "registrarObrigacao+pagarContaAPagar" : composicao ? "registrarDespesaPagaComEncargo" : "registrarDespesaPagaPorComprovante", entrada: comando.valor, pagamento: { contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor },
        ...(composicao ? { encargos: { principalCentavos: composicao.principalCentavos, jurosCentavos: composicao.jurosCentavos, multaCentavos: composicao.multaCentavos, encargoCentavos: composicao.encargoCentavos } } : {}),
        ...(composicaoEmprestimo ? { composicaoEmprestimo } : {}) },
      ...(novaDeclarada || esclarecimento?.divergencia ? { compraNovaDeclarada: true } : {}),
    }, comAvisoDeCompetencia((p) => RESPOSTA.propostaDespesaPaga(p, resumo), competencia), {
      // 23/11: com as chaves e a política DESPESA_DOCUMENTAL, a rotina registra a conta e o pagamento por comprovante.
      // 28/11: só com a composição (só principal) COMPROVADA ou DECLARADA; ausência de juros lidos não basta ⇒ Central.
      posCriacao: patrimonialDoPagamento === "EMPRESTIMOS_E_FINANCIAMENTOS" && execucao?.criarDespesas && evento.midia && !composicao && composicaoEmprestimo && typeof execucao?.podeRegistrarEmprestimo === "function"
        ? async (p) => {
          if (!(await execucao.podeRegistrarEmprestimo(escopo, "PAGAMENTO"))) return null; // sem a permissão de empréstimo: Central, como hoje
          await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida, divergencia: { tipo: "EMPRESTIMO_PAGO_CONFIRMACAO", propostaId: p.id, unidadeId: escopo.unidadeId } } });
          return { situacao: "AGUARDANDO_CONFIRMACAO", nivel: null, texto: RESPOSTA.confirmarEmprestimoPago(p, resumo) };
        }
        : execucao?.criarDespesas && evento.midia && !patrimonialDoPagamento ? async (p) => {
        const r = await execucao.aposDespesaNova(p, escopo);
        return r.situacao === "PAGO_POR_COMPROVANTE" ? { ...r, texto: RESPOSTA.despesaPagaPorComprovante(p, r.resultado, resumo) } : r;
      } : null,
    });
  }

  const reaisCurto = (c) => `R$ ${(c / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

  /** 27/11 — pedido de REGISTRAR conta (verbo de registro/cadastro + valor em reais): é do motor financeiro, nunca do MOVA CORE. */
  function pedidoDeRegistrarConta(texto) {
    const t = normalizar(texto);
    return /\b(registr|lanc|cadastr|anot|inclu)[a-z]*\b/.test(t) && /\b(conta|contas|a pagar|obrigac[a-z]*|boletos?|parcelas?|emprestim[a-z]*|financiament[a-z]*|aluguel|despesas?|dividas?|faturas?|impostos?|honorarios?)\b/.test(t)
      && /r\$\s*\d|\b\d+,\d{2}\b/i.test(String(texto ?? ""));
  }

  /** Data civil da MENSAGEM em America/Fortaleza (competência e ano das parcelas vêm dela, nunca do momento da confirmação). */
  const dataDaMensagem = (evento) => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_DA_OPERACAO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(evento.recebidoEm ?? relogio()));

  /**
   * 26/11 — CONTA A PAGAR RELATADA POR TEXTO (sem documento): "Compra de bebedouro para o açaí, 2 parcelas no cartão, dia 19/12 e 19/01,
   * valor de R$ 194,50". Leitura determinística (dominio/contaRelatada.js, sem IA além da leitura da intenção que a mensagem já teve).
   * Fluxo: (1) valor ambíguo (total × cada parcela) ⇒ pergunta UMA vez; (2) RESUMO completo e pedido de confirmação; (3) "sim" de quem
   * enviou (ou de outro FINANCEIRO da unidade) ⇒ proposta CONTA_RELATADA — registrada EM ABERTO (nunca como paga) só com a política
   * CONTA_A_PAGAR_RELATADA e a concessão `registrar_conta_parcelada`; sem elas fica para a aprovação no Centro Financeiro. "não" cancela.
   * Sem fornecedor dito, a conta vai como "Fornecedor não informado" (nunca inventado). Mensagem que não traz valor + data segue o fluxo antigo.
   * @returns {Promise<object|null>} null = não é conta relatada (segue o fluxo comum)
   */
  async function tratarContaRelatada(ctx) {
    const { evento, escopo, unidade, esclarecimento, injecao } = ctx;
    const div = esclarecimento?.divergencia ?? null;
    if (div && !String(div.tipo ?? "").startsWith("CONTA_RELATADA")) return null;
    // 27/11: FOTO do produto com legenda ⇒ a LEGENDA é o relato (a foto não é documento fiscal nem comprovante)
    const textoDaConta = evento.midia ? (legendaDoDocumento(evento.texto) ?? "") : evento.texto;
    // 27/11 (generalização): QUALQUER obrigação que a pessoa pede para registrar (empréstimo, aluguel, energia, água, internet, honorários,
    // impostos, royalties, compras) usa este MESMO fluxo. "declarada" = a leitura da mensagem é um pedido de registrar conta.
    const declarada = !evento.midia && ctx.saida?.intencao === "REGISTRAR_CONTA";
    // competência DITA na mensagem (lida; nunca presumida pelo vencimento) — só para o que não é compra
    const competenciaLida = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ctx.saida?.competencia ?? "")) ? ctx.saida.competencia : null;
    // estado acumulado da conversa (cada pergunta carrega as respostas anteriores; nada é perguntado duas vezes, nada se perde)
    let complemento = div?.complemento ?? null;
    const ler = (tv) => interpretarContaRelatada({ texto: textoDaConta, dataMensagem: dataDaMensagem(evento), unidades: cfg.unidades, tipoValor: tv, porFoto: Boolean(evento.midia), declarada, competenciaInformada: competenciaLida, complemento, vencimentoLido: declarada ? ctx.saida?.vencimento ?? null : null });
    let tipoValor = div?.tipoValor ?? null;
    let escolha = div?.categoriaEscolhida ?? null; // código do plano | "REVISAO" (a classificar no Centro Financeiro)
    const sugestaoDeCriacao = div?.sugestaoDeCriacao ?? null;
    // 27/11: com o que JÁ foi respondido a conta fica completa (ex.: retomada depois de uma correção) ⇒ segue sem pedir de novo
    if (div?.tipo === "CONTA_RELATADA_COMPLEMENTO" && !ler(tipoValor).faltas.length) complemento = complemento ?? {};
    else if (div?.tipo === "CONTA_RELATADA_COMPLEMENTO") {
      const novo = complementoDaResposta(esclarecimento.texto, { faltas: div.faltas ?? [], complemento: complemento ?? {}, dataMensagem: dataDaMensagem(evento), hoje: hoje(), competenciaDe: competenciaDoRelato });
      if (!novo) return perguntar(ctx, { ...div }, `Não entendi. ${RESPOSTA.contaRelatadaFaltas(ler(tipoValor), div.faltas ?? [], unidade.nome)}`, "CONTA_RELATADA_RESPOSTA_NAO_ENTENDIDA");
      complemento = novo;
    }
    if (div?.tipo === "CONTA_RELATADA_VALOR") {
      tipoValor = interpretarRespostaDoValor(esclarecimento.texto);
      if (!tipoValor) return perguntar(ctx, { tipo: "CONTA_RELATADA_VALOR", categoriaEscolhida: escolha, complemento }, RESPOSTA.contaRelatadaValorAmbiguo(ler(null)), "CONTA_RELATADA_RESPOSTA_NAO_ENTENDIDA");
    }
    const c = ler(tipoValor);
    if (!c.ehConta) return null;
    // 27/11: o que FALTA (vencimento, mês de referência, valor, descrição) é perguntado de uma vez, guardando o que já foi dito.
    const PREENCHIVEIS = ["VENCIMENTO", "VENCIMENTOS_DAS_PARCELAS", "DATA_INVALIDA", "VENCIMENTO_ANTERIOR_A_COMPRA", "COMPETENCIA", "VALOR", "VALORES_DIFERENTES", "DESCRICAO"];
    if (c.faltas.length && c.faltas.every((f) => PREENCHIVEIS.includes(f))) {
      // #245: falta SÓ o vencimento (ex.: a única data dita era a do desconto da remuneração) ⇒ a pergunta objetiva do vencimento
      const soVencimento = c.faltas.length === 1 && c.faltas[0] === "VENCIMENTO";
      return perguntar(ctx, { tipo: "CONTA_RELATADA_COMPLEMENTO", faltas: c.faltas, complemento: complemento ?? {}, tipoValor, categoriaEscolhida: escolha },
        soVencimento ? RESPOSTA.contaRelatadaVencimento(Boolean(c.observacao)) : RESPOSTA.contaRelatadaFaltas(c, c.faltas, unidade.nome),
        soVencimento ? "CONTA_RELATADA_PERGUNTA_VENCIMENTO" : "CONTA_RELATADA_FALTA_INFORMACAO");
    }
    // 27/11 (revisão do PR #236): conta ÚNICA e PARCELADA seguem o MESMO fluxo (resumo → confirmação → registro em aberto).
    if (c.faltas.length) {
      const nomes = { DATA_INVALIDA: "uma data válida (dia/mês)", VALOR: "valor", VALORES_DIFERENTES: "qual é o valor (a mensagem tem mais de um)", DESCRICAO: "o que foi comprado",
        PARCELAS: "quantidade de parcelas (1 a 24)", VENCIMENTO: "vencimento", VENCIMENTOS_DAS_PARCELAS: "o vencimento de cada parcela", VENCIMENTO_ANTERIOR_A_COMPRA: "vencimentos a partir da data da compra" };
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `CONTA_RELATADA_INCOMPLETA:${c.faltas.join(",")}`, escopo, resposta: RESPOSTA.faltaInformacao(c.faltas.map((f) => nomes[f] ?? f)), injecao });
    }
    if (c.ambiguo) return perguntar(ctx, { tipo: "CONTA_RELATADA_VALOR", categoriaEscolhida: escolha, complemento }, RESPOSTA.contaRelatadaValorAmbiguo(c), "CONTA_RELATADA_VALOR_AMBIGUO");
    const bloqueio = await competenciaAberta(ctx, c.competencia);
    if (bloqueio) return bloqueio;
    // Duplicidade: mesma parcela (valor + vencimento) já registrada nesta unidade ⇒ nada novo.
    const todas = (await porta.contasAPagarTodas(escopo)).filter((t) => t.situacao !== "CANCELADO");
    const igual = todas.find((t) => c.parcelas.some((p) => t.valorOriginalCentavos === p.valorCentavos && t.vencimento === p.vencimento && (!c.fornecedor || fornecedorCompativel(c.fornecedor, t))));
    if (igual) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "OBRIGACAO_JA_REGISTRADA", escopo, resposta: RESPOSTA.obrigacaoJaExiste(igual), injecao });
    // Cartão: a compra pode já estar dentro de uma FATURA registrada — avisa no resumo (a pessoa decide; nunca conta duas vezes calado).
    const fatura = c.forma === "CARTAO" ? todas.find((t) => /\b(fatura|cartao)\b/.test(normalizar(`${t.descricao ?? ""} ${t.fornecedor ?? t.favorecido ?? ""}`)) && c.parcelas.some((p) => String(t.vencimento ?? "").slice(0, 7) === p.vencimento.slice(0, 7))) : null;
    // CLASSIFICAÇÃO pelo plano da unidade (nunca IMOBILIZADO automático; categoria dita fora do plano ⇒ pergunta ou revisão)
    const plano = await planoDaUnidade(escopo);
    const cls = classificarContaRelatada({ descricao: c.descricao, texto: textoDaConta, categorias: plano, categoriaSugerida: ctx.saida?.categoriaSugerida ?? null });
    if (div?.tipo === "CONTA_RELATADA_CATEGORIA") {
      const r = interpretarRespostaDaCategoria(esclarecimento.texto, { opcoes: div.opcoes ?? [], categorias: plano });
      if (!r) return perguntar(ctx, { ...div }, `Não entendi. ${RESPOSTA.contaRelatadaCategoria({ opcoes: div.opcoes ?? [], motivo: div.motivo, sugestaoDeCriacao, descricao: c.descricao })}`, "CONTA_RELATADA_RESPOSTA_NAO_ENTENDIDA");
      escolha = r.revisao ? "REVISAO" : r.codigo;
    }
    if (!escolha && cls.perguntar) {
      if (!plano.length) escolha = "REVISAO"; // plano indisponível: nada é inventado; fica a classificar
      else return perguntar(ctx, { tipo: "CONTA_RELATADA_CATEGORIA", tipoValor: c.tipoValor, opcoes: cls.opcoes, motivo: cls.motivo, sugestaoDeCriacao: cls.sugestaoDeCriacao, complemento },
        RESPOSTA.contaRelatadaCategoria({ opcoes: cls.opcoes, motivo: cls.motivo, sugestaoDeCriacao: cls.sugestaoDeCriacao, descricao: c.descricao }), "CONTA_RELATADA_PERGUNTA_CATEGORIA");
    }
    const categoria = escolha === "REVISAO" ? null : escolha ? (plano.some((x) => x.codigo === escolha) ? escolha : null) : cls.codigo;
    const sugestao = categoria ? null : sugestaoDeCriacao ?? cls.sugestaoDeCriacao ?? null;
    const bruto = {
      contraparteNova: { tipo: "FORNECEDOR", nome: c.fornecedor ?? FORNECEDOR_NAO_INFORMADO }, categoria: categoria ?? porta.categoriaProvisoria,
      // 27/11: o núcleo não tem campo de observação (só a descrição, até 200 caracteres). A observação dita (composição do total, desconto,
      // observações das parcelas) acompanha a descrição quando CABE; senão a descrição aponta para a proposta, que guarda o texto inteiro.
      descricao: descricaoComObservacao(c).descricao, competencia: c.competencia, dataEmissao: c.dataEmissao,
      parcelas: c.parcelas.map((p) => ({ vencimento: p.vencimento, valorCentavos: p.valorCentavos })), ...(c.forma ? { formaPagamento: c.forma } : {}),
      // #244: a observação também fica num campo próprio da conta (até 500 caracteres; a proposta guarda o texto inteiro)
      ...(c.observacao ? { observacao: c.observacao.length > 500 ? `${c.observacao.slice(0, 497)}...` : c.observacao } : {}),
    };
    try { porta.validarComandoDeContaParcelada(bruto); } catch (e) {
      if (porta.ehErroDeRegra(e)) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${e.detalhes?.campo ?? "conta"}`, escopo, resposta: RESPOSTA.faltaInformacao([e.detalhes?.campo ?? "dados da conta"]), injecao });
      throw e;
    }
    const impressao = JSON.stringify(bruto);
    // a categoria do resumo fica gravada na pendência: o "sim" confirma ESTA (a leitura da resposta não traz a sugestão da original)
    const estado = { tipo: "CONTA_RELATADA_CONFIRMACAO", tipoValor: c.tipoValor, categoriaEscolhida: escolha ?? categoria ?? null, sugestaoDeCriacao: sugestao, impressao, complemento };
    // 27/11: categoria PATRIMONIAL (ex.: principal de empréstimo, fora da DRE). A permissão ESTREITA do MOVA registra só despesa e
    // imobilizado (regra do banco, 0033): depois do "sim" vira proposta para APROVAÇÃO no Centro Financeiro — nunca vira despesa.
    // 27/11 (0035): principal de EMPRÉSTIMO com a permissão estreita de empréstimo concedida ⇒ o "sim" registra (fora da DRE); senão, Central.
    // 28/11 (revisão): parcela de empréstimo costuma embutir juros — só registra como principal com a composição DECLARADA no relato.
    const composicaoEmprestimo = categoria === "EMPRESTIMOS_E_FINANCIAMENTOS" ? composicaoSoPrincipal(null, textoDaConta) : null;
    const emprestimoDireto = categoria === "EMPRESTIMOS_E_FINANCIAMENTOS" && Boolean(composicaoEmprestimo) && Boolean(execucao?.criarContas) && typeof execucao?.podeRegistrarEmprestimo === "function"
      && await execucao.podeRegistrarEmprestimo(escopo, "CONTA");
    const patrimonial = Boolean(categoria) && ehPatrimonialForaDaDre(categoria, plano) && !emprestimoDireto;
    const resumo = (prefixo = "", avisoFatura = null) => `${prefixo}${RESPOSTA.contaRelatadaResumo({ ...c, observacaoCompleta: descricaoComObservacao(c) }, { unidade: unidade.nome, categoriaNome: plano.find((x) => x.codigo === categoria)?.nome ?? null, avisoFatura, sugestaoDeCriacao: sugestao, patrimonial })}`;
    if (div?.tipo !== "CONTA_RELATADA_CONFIRMACAO") {
      return perguntar(ctx, estado, resumo("", fatura ? RESPOSTA.contaRelatadaFaturaDoCartao(fatura) : null), "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
    }
    const sim = respostaSimNao(esclarecimento.texto);
    if (sim === false) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CONTA_RELATADA_CANCELADA", escopo, resposta: RESPOSTA.contaRelatadaCancelada(), injecao, extra: { confirmadoPor: esclarecimento.participanteId ?? null } });
    if (sim !== true) return perguntar(ctx, estado, resumo("Não entendi. "), "CONTA_RELATADA_RESPOSTA_NAO_ENTENDIDA");
    // O que foi confirmado é exatamente o que vai para a proposta (plano/dados mudaram no meio ⇒ mostra de novo, nada é criado).
    if (div.impressao && div.impressao !== impressao) return perguntar(ctx, estado, resumo("Os dados mudaram desde o resumo. "), "CONTA_RELATADA_CONFIRMACAO_DESATUALIZADA");
    // Execução automática só quando QUEM CONFIRMOU é FINANCEIRO nesta unidade (operacional/consulta: fica a proposta para a Central).
    // 27/11 (caso real f8f15a27): o WhatsApp manda o LID; a lista do grupo é por TELEFONE. Sem o telefone, quem confirmou não era
    // encontrado ⇒ "não FINANCEIRO" ⇒ a execução nem era tentada. Mesma regra da entrada da mensagem: identificador OU telefone.
    const confirmador = participanteAutorizado(ctx.grupo, esclarecimento
      ? { participanteId: esclarecimento.participanteId ?? evento.participanteId, telefoneE164: esclarecimento.telefoneE164 ?? null }
      : { participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null });
    const confirmadorFinanceiro = perfilNa(confirmador, unidade.unidadeId) === "FINANCEIRO";
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.CONTA_RELATADA, valorCentavos: c.totalCentavos, parcial: false,
      datas: { competencia: c.competencia, caixa: null, vencimento: c.parcelas[0].vencimento }, categoriaDefinida: Boolean(categoria),
      // sem categoria do plano: a proposta fica para a classificação no Centro Financeiro (com a sugestão de criar a dita, se houver)
      ...(categoria ? {} : { classificacao: { pendente: true, motivo: cls.motivo, sugestaoDeCriacao: sugestao } }),
      ...(evento.midia ? { evidenciaNaoFiscal: "FOTO_DO_PRODUTO" } : {}),
      ...(descricaoComObservacao(c).observacao ? { observacaoCompleta: descricaoComObservacao(c).observacao, observacaoNaDescricao: descricaoComObservacao(c).cabe } : {}),
      comando: { operacao: "registrarContaParcelada", entrada: bruto, ...(composicaoEmprestimo ? { composicaoEmprestimo } : {}) },
    }, (p) => RESPOSTA.contaRelatadaProposta(p, c, { aClassificar: !categoria, patrimonial }), {
      posCriacao: !patrimonial && confirmadorFinanceiro && execucao?.criarContas && typeof execucao.aposContaRelatada === "function" ? async (p) => {
        const r = await execucao.aposContaRelatada(p, escopo);
        return r.situacao === "CONTA_REGISTRADA" ? { ...r, texto: RESPOSTA.contaRelatadaRegistrada(c, r.resultado) } : r;
      } : null,
    });
  }

  /**
   * 28/11 — NOTA/BOLETO em nome da empresa da `tomadora` (loja da conversa) com o texto citando a `citada` (outra loja da conversa).
   * Primeira vez: EXPLICA o conflito e pergunta se a conta é da citada (pendência com as DUAS unidades exigidas). Na resposta:
   *   "sim" ou o nome da citada ⇒ citada; o nome da tomadora ⇒ tomadora; "não" ⇒ pergunta qual das duas (nunca beco sem saída);
   *   outra coisa ⇒ repete a pergunta explicada. Só vale a confirmação de quem é FINANCEIRO nas DUAS unidades (a mesma pessoa que
   *   enviou também precisa ter). Confirmada, a operação segue normalmente na unidade escolhida (resumo, competência, política…),
   *   com quem confirmou registrado (esclarecidoPor) e auditado. Nada é gravado antes disso.
   * @returns {{concluido?:object, u?:object, esclarecimento?:object}}
   */
  async function confirmarUnidadeDoTomador({ evento, saida, injecao, esclarecimento, grupo, participante, citada, tomadora }) {
    const ctx = { evento, escopo: escopoDe(citada), saida, injecao, unidade: citada, grupo, participante, esclarecimento };
    const divergencia = { tipo: "UNIDADE_DO_TOMADOR", unidadesExigidas: [citada.unidadeId, tomadora.unidadeId], citada: citada.unidadeId, tomadora: tomadora.unidadeId };
    const tomador = String(saida.pagador || saida.documentoPagador || "outra empresa").slice(0, 80);
    const pergunta = RESPOSTA.tomadorDeOutraUnidade({ tomador, unidadeDoTomador: tomadora.nome, citada: citada.nome, tipoDocumento: saida.tipoDocumento });
    const div = esclarecimento?.divergencia ?? null;
    if (div?.tipo !== "UNIDADE_DO_TOMADOR" || div.citada !== citada.unidadeId || div.tomadora !== tomadora.unidadeId) {
      return { concluido: await perguntar(ctx, divergencia, pergunta, "UNIDADE_DO_TOMADOR_AGUARDANDO_CONFIRMACAO") };
    }
    const texto = esclarecimento.texto ?? "";
    const sim = respostaSimNao(texto);
    const nomeadas = unidadesCitadas(texto, [citada, tomadora]);
    const escolhida = nomeadas.length === 1 ? nomeadas[0] : sim === true && nomeadas.length === 0 ? citada : null;
    if (!escolhida) {
      if (sim === false) return { concluido: await perguntar(ctx, divergencia, RESPOSTA.tomadorQualUnidade(citada.nome, tomadora.nome), "UNIDADE_DO_TOMADOR_NEGADA") };
      return { concluido: await perguntar(ctx, divergencia, `Não entendi. ${pergunta}`, "UNIDADE_DO_TOMADOR_RESPOSTA_NAO_ENTENDIDA") };
    }
    // quem respondeu (outra pessoa da lista já passou pela conferência da pendência; a MESMA pessoa também precisa das duas)
    const respondeu = esclarecimento.participanteId ?? evento.participanteId;
    const quem = respondeu === evento.participanteId ? participante
      : participanteAutorizado(grupo, { participanteId: respondeu, telefoneE164: esclarecimento.telefoneE164 ?? null });
    const financeiroNasDuas = Boolean(quem) && !quem.aberto && [citada, tomadora].every((x) => (quem.unidades ?? grupo?.unidades ?? []).includes(x.unidadeId) && perfilNa(quem, x.unidadeId) === "FINANCEIRO");
    if (!financeiroNasDuas) {
      return { concluido: await perguntar(ctx, divergencia, RESPOSTA.tomadorSemPermissao(citada.nome, tomadora.nome), "UNIDADE_DO_TOMADOR_SEM_PERMISSAO_NAS_DUAS") };
    }
    await a.auditoria.registrar({ acao: "UNIDADE_DO_TOMADOR_CONFIRMADA", atorTipo: "PARTICIPANTE", atorRef: respondeu, alvo: evento.eventoId,
      dados: { unidadeId: escolhida.unidadeId, citada: citada.unidadeId, tomadora: tomadora.unidadeId, tipoDocumento: saida.tipoDocumento } });
    const evidencia = escolhida === citada ? "TEXTO_CONFIRMADO_CONTRA_TOMADOR" : "TOMADOR_CONFIRMADO_CONTRA_TEXTO";
    return { u: { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: escolhida, evidencia }, esclarecimento: { ...esclarecimento, divergencia: null } };
  }

  /**
   * 26/11 — OPERAÇÃO ENTRE EMPRESAS: o comprovante saiu da conta da `credora` (pagadora) e a mensagem cita a `devedora`.
   * Pergunta UMA vez; com o "sim" de quem é FINANCEIRO nas DUAS unidades, cria a proposta INTERCOMPANY na devedora (a conta do
   * fornecedor é a existente quando há UMA compatível; senão uma nova). Nada é lançado aqui: a execução é atômica no Financeiro
   * (registrarPagamentoPorOutraEmpresa), com permissão nas duas empresas. Sem política OPERACAO_ENTRE_EMPRESAS, nunca automática.
   */
  async function tratarEntreEmpresas({ evento, saida, injecao, esclarecimento, grupo, participante, interpretacao, devedora, credora }) {
    const escopo = escopoDe(devedora);
    const ctx = { evento, escopo, unidade: devedora, saida, injecao, esclarecimento, grupo, participante, interpretacao, evidenciaUnidade: "PAGO_POR_OUTRA_UNIDADE" };
    const div = esclarecimento?.divergencia ?? null;
    const financeiroNasDuas = (p) => Boolean(p) && !p.aberto && [devedora, credora].every((x) => (p.unidades ?? grupo?.unidades ?? []).includes(x.unidadeId) && perfilNa(p, x.unidadeId) === "FINANCEIRO");
    if (!financeiroNasDuas(participante)) {
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "ENTRE_EMPRESAS_SEM_PERMISSAO_NAS_DUAS", escopo, resposta: RESPOSTA.entreEmpresasSemPermissao(devedora.nome, credora.nome), injecao });
    }
    const valor = saida.valorCentavos;
    const dataPagamento = saida.dataPagamento;
    if (!(Number.isSafeInteger(valor) && valor > 0) || !dataPagamento) {
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "ENTRE_EMPRESAS_INCOMPLETO", escopo, resposta: RESPOSTA.faltaInformacao([!dataPagamento ? "data do pagamento" : "valor"]), injecao });
    }
    // conta do fornecedor na devedora: UMA compatível (mesmo saldo e fornecedor compatível) ⇒ ela; várias ⇒ a revisão escolhe; nenhuma ⇒ nova
    // 27/11 (homologação real): o favorecido lido do comprovante Pix pode ser a INSTITUIÇÃO DE PAGAMENTO (ex.: "PIXPAG PAGAMENTOS LTDA"),
    // não o fornecedor — exigir o nome fazia a conta aberta de mesmo valor passar despercebida e propor uma conta NOVA (duplicidade).
    // Sem fornecedor compatível, UMA conta aberta com exatamente o mesmo saldo é a candidata (marcada "por valor": a pergunta mostra
    // fornecedor/vencimento e pede a confirmação; nunca escolhe entre várias). Várias por valor ⇒ a revisão escolhe.
    const abertasDoValor = (await porta.contasAPagarAbertas(escopo)).filter((t) => t.saldoCentavos === valor);
    const comFornecedor = saida.favorecido ? abertasDoValor.filter((t) => fornecedorCompativel(saida.favorecido, t)) : abertasDoValor;
    const porValor = comFornecedor.length === 0 && abertasDoValor.length > 0;
    const candidatas = porValor ? abertasDoValor : comFornecedor;
    const existente = candidatas.length === 1 ? candidatas[0] : null;
    const competencia = saida.competencia ?? null; // nunca presumida: sem ela, a proposta nasce com a competência pendente
    if (competencia) { const bloqueio = await competenciaAberta(ctx, competencia); if (bloqueio) return bloqueio; }
    const descricao = `${saida.favorecido ? String(saida.favorecido).slice(0, 60) : "Pagamento"} — pago pela ${credora.nome}`.slice(0, 120);
    const obrigacaoNova = existente || candidatas.length > 1 ? null : {
      contraparteNova: { tipo: "FORNECEDOR", nome: saida.favorecido ? String(saida.favorecido).slice(0, 120) : FORNECEDOR_NAO_INFORMADO },
      valorOriginalCentavos: valor, categoria: porta.categoriaProvisoria, descricao, competencia, dataEmissao: dataPagamento, vencimento: dataPagamento,
    };
    const entrada = { ...(existente ? { obrigacaoId: existente.id } : {}), ...(obrigacaoNova ? { obrigacaoNova } : {}), valorCentavos: valor, dataPagamento,
      descricao, nomeDevedora: devedora.nome, nomeCredora: credora.nome, chave: `MOVA:${evento.eventoId}` };
    const impressao = JSON.stringify({ d: devedora.unidadeId, c: credora.unidadeId, valor, dataPagamento, obrigacaoId: existente?.id ?? null, candidatas: candidatas.length });
    const pergunta = RESPOSTA.entreEmpresasPergunta({ credora: credora.nome, devedora: devedora.nome, valorCentavos: valor, existente, varias: candidatas.length > 1, porValor, favorecido: saida.favorecido ?? null });
    const divergencia = { tipo: "ENTRE_EMPRESAS_CONFIRMACAO", unidadesExigidas: [devedora.unidadeId, credora.unidadeId], impressao };
    if (div?.tipo !== "ENTRE_EMPRESAS_CONFIRMACAO") return perguntar(ctx, divergencia, pergunta, "ENTRE_EMPRESAS_AGUARDANDO_CONFIRMACAO");
    const sim = respostaSimNao(esclarecimento.texto);
    if (sim === false) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "ENTRE_EMPRESAS_RECUSADA", escopo, resposta: RESPOSTA.entreEmpresasRecusada(), injecao, extra: { confirmadoPor: esclarecimento.participanteId ?? null } });
    if (sim !== true) return perguntar(ctx, divergencia, `Não entendi. ${pergunta}`, "ENTRE_EMPRESAS_RESPOSTA_NAO_ENTENDIDA");
    if (div.impressao && div.impressao !== impressao) return perguntar(ctx, divergencia, `As contas mudaram desde a pergunta. ${pergunta}`, "ENTRE_EMPRESAS_CONFIRMACAO_DESATUALIZADA");
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.INTERCOMPANY, valorCentavos: valor, parcial: false,
      datas: { competencia, caixa: dataPagamento, vencimento: null }, categoriaDefinida: false, competenciaPendente: !competencia && Boolean(obrigacaoNova),
      comando: { operacao: "registrarPagamentoPorOutraEmpresa", devedora: { organizacaoId: devedora.organizacaoId, unidadeId: devedora.unidadeId },
        credora: { organizacaoId: credora.organizacaoId, unidadeId: credora.unidadeId }, entrada, escolherConta: candidatas.length > 1 ? candidatas.map((t) => t.id) : null },
      // quem aplica precisa das permissões nas DUAS empresas (a aplicação confere de novo, com a concessão gravada em cada uma)
      exigeParaAplicar: [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR, ACAO.REGISTRAR_INTERCOMPANY].filter(Boolean),
    }, (p) => RESPOSTA.entreEmpresasProposta(p, { devedora: devedora.nome, credora: credora.nome }), {
      // 27/11: conta EXISTENTE + confirmação de quem é FINANCEIRO nas duas (já conferido acima) + política nas DUAS unidades
      // (menor limite) + concessão estreita da identidade operacional nas duas ⇒ registra; senão fica a proposta para a Central.
      posCriacao: existente && execucao?.criarContas && typeof execucao.aposIntercompany === "function" ? async (p) => {
        const r = await execucao.aposIntercompany(p, escopo);
        return r.situacao === "ENTRE_EMPRESAS_REGISTRADA" ? { ...r, texto: RESPOSTA.entreEmpresasRegistrada({ devedora: devedora.nome, credora: credora.nome, valorCentavos: valor }) } : r;
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
      // 28/11: política "com confirmação" ⇒ o MOVA mostra o resumo e pergunta; o "sim" de um FINANCEIRO da unidade registra.
      posCriacao: execucao?.criarContas && evento.midia ? async (p) => {
        const r = await execucao.aposContaNova(p, escopo);
        if (r.situacao === "AGUARDANDO_CONFIRMACAO") {
          // a resposta (com valores) pode ir para o privado: a pendência fica na conversa em que a pergunta saiu (como em `perguntar`)
          const rota = await roteamento(ctx.grupo ?? null, ctx.participante ?? null, evento, "DOCUMENTO_COM_VALOR", [escopo.unidadeId]);
          const destino = rota && !rota.noGrupo && rota.destino ? rota.destino : evento.grupoId;
          await a.mensagens.lembrar(evento.mensagemId, { grupoId: destino, pendente: { evento, saida, divergencia: { tipo: "CONTA_NOVA_CONFIRMACAO", propostaId: p.id, unidadeId: escopo.unidadeId } } });
          return { ...r, texto: RESPOSTA.confirmarContaNova(p, ctx.unidade?.nome ?? "unidade") };
        }
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
  function comandoDeObrigacao(saida, { competencia, vencimento, descricao = null, categoria = null, observacao = null }) {
    // 15A: competência pendente — os DEMAIS campos são validados (com um mês provisório só para a validação) e o comando é
    // guardado SEM competência; quem revisa informa a competência e a aplicação recusa enquanto ela faltar.
    if (!competencia) {
      const r = comandoDeObrigacao(saida, { competencia: mes(vencimento), vencimento, descricao, categoria, observacao });
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
      ...(observacao ? { observacao: observacao.length > 500 ? `${observacao.slice(0, 497)}...` : observacao } : {}),
    };
    try {
      return { ok: true, valor: porta.validarComandoDeObrigacao(bruto) };
    } catch (e) {
      if (porta.ehErroDeRegra(e)) return { ok: false, campo: e.detalhes?.campo ?? "dados do documento" };
      throw e;
    }
  }

  /** Recorte (período) da consulta, para a continuidade: só datas/competência já validadas, nunca texto. */
  // Consultas com filtro (fornecedor/categoria) levam o filtro junto: "e este mês?" depois de "quanto pagamos ao fornecedor X" mantém X.
  const COM_FILTRO = ["PAGAMENTOS_A_FORNECEDOR", "DESPESAS_POR_CATEGORIA", "COMPARATIVO_DE_DESPESAS"];
  const recorteDe = (s) => {
    const r = { competencia: s.competencia ?? null, periodoInicio: s.periodoInicio ?? null, periodoFim: s.periodoFim ?? null };
    if (COM_FILTRO.includes(s.consulta)) { r.favorecido = s.favorecido ?? null; r.categoriaSugerida = s.categoriaSugerida ?? null; }
    return Object.values(r).some(Boolean) ? r : null;
  };

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
