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
import { grupoAutorizado, mascarar, normalizar, requisitosCompletos } from "../dominio/configuracao.js";
import { RESULTADO_UNIDADE, resolverUnidade, unidadesCitadas } from "../dominio/unidade.js";
import { CANAIS_SO_PELA_PLATAFORMA, fontesOficiais } from "../dominio/fontesDeReceita.js";
import { mascararDadosSensiveis, pedidoRestrito } from "../dominio/privacidade.js";
import { INTENCOES_BLOQUEADAS, INTENCOES_DE_REVISAO, SAIDA_VAZIA, sinaisDeInjecao, validarSaidaDaIa } from "../ia/contratos.js";
import { RESPOSTA, reais } from "./respostas.js";

export const DECISAO = Object.freeze({
  IGNORADO: "IGNORADO", BLOQUEADO: "BLOQUEADO", PEDIR_INFORMACAO: "PEDIR_INFORMACAO", DUPLICADO: "DUPLICADO",
  CONSULTA: "CONSULTA", ORIENTACAO: "ORIENTACAO", PROPOSTA: "PROPOSTA", FALHA_LEITURA: "FALHA_LEITURA",
});
export const TIPO_PROPOSTA = Object.freeze({ BAIXA_DE_OBRIGACAO: "BAIXA_DE_OBRIGACAO", DESPESA_PAGA: "DESPESA_PAGA", NOVA_OBRIGACAO: "NOVA_OBRIGACAO", SOLICITACAO_DE_REVISAO: "SOLICITACAO_DE_REVISAO" });
const PAGAMENTOS = ["COMPROVANTE_PAGAMENTO", "RECIBO"];
const CONTAS = ["BOLETO", "NOTA_FISCAL"];
const CONSULTAS_DO_GRUPO = ["COMPARATIVO_UNIDADES", "SITUACAO_PROPOSTAS"];
const PEDIDO_DE_APROVACAO = /^\s*(aprov[ao]r?|aprovad[oa]|aplic[ao]r?|pode\s+aprovar|autoriz[ao]r?)\b/i;
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
export function criarMotor({ cfg, porta, extrator, armazenamento: a, relogio = () => new Date(), registrar = () => {} }) {
  const hoje = () => relogio().toISOString().slice(0, 10);
  const ACAO = porta.acoes;
  const servico = cfg.identidadeServico.usuarioId;
  const escopoDe = (u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico });

  async function concluir(evento, { decisao, motivo, escopo = null, resposta = null, propostaId = null, injecao = false, extra = {} }) {
    await a.historico.registrar({
      organizacaoId: escopo?.organizacaoId ?? null, unidadeId: escopo?.unidadeId ?? null, eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, provedor: evento.provedor, tipoMensagem: evento.tipo, decisao, motivo, propostaId, sinaisDeInjecao: injecao,
      documentoSha256: evento.midia?.sha256 ?? null, ...extra,
    });
    registrar({ tipo: "MOVA_DECISAO", decisao, motivo, grupo: mascarar(evento.grupoId) });
    if (resposta) await a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: evento.mensagemId, eventoId: evento.eventoId, texto: mascararDadosSensiveis(resposta), simulada: true });
    return { decisao, motivo, propostaId, resposta };
  }

  async function lerDocumento(evento) {
    if (!evento.midia && !evento.texto) return { ok: true, saida: { ...SAIDA_VAZIA, legivel: true, tipoDocumento: "DESCONHECIDO", intencao: "DESCONHECIDA", confianca: "BAIXA" } };
    let bruta;
    try {
      bruta = await extrator.extrair({ texto: evento.texto, tipo: evento.tipo, midia: evento.midia ? { mime: evento.midia.mime, referencia: evento.midia.referencia } : null });
    } catch {
      return { ok: false, motivo: "EXTRATOR_FALHOU" };
    }
    const v = validarSaidaDaIa(bruta);
    if (!v.ok) return { ok: false, motivo: `IA_SAIDA_INVALIDA:${v.erro}` };
    if (!v.saida.legivel) return { ok: false, motivo: "DOCUMENTO_ILEGIVEL" };
    return v;
  }

  async function processar(evento, { esclarecimento = null } = {}) {
    // 1. Grupo autorizado. Fora da lista: nada é lido, guardado nem respondido.
    const grupo = grupoAutorizado(cfg, evento.grupoId);
    if (!grupo) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "GRUPO_NAO_AUTORIZADO" });
    // 2. Mensagens do próprio agente (fromMe, ou eco de uma resposta registrada): ignora, sem histórico — evita laço.
    if (evento.fromMe || await a.saida.ehRespostaPropria(evento.mensagemId)) return { decisao: DECISAO.IGNORADO, motivo: "MENSAGEM_PROPRIA" };
    if (!evento.participanteId) return concluir(evento, { decisao: DECISAO.IGNORADO, motivo: "SEM_PARTICIPANTE" });

    if (!esclarecimento) {
      // 3. Evento repetido (reconexão do Baileys, reenvio do Gateway) — segunda barreira depois da fila.
      const { novo } = await a.eventos.registrar(evento);
      if (!novo) return { decisao: DECISAO.DUPLICADO, motivo: "EVENTO_JA_PROCESSADO" };
      // 4. NÍVEL 1: participante do grupo autorizado é registrado automaticamente (sem cadastro nem login).
      const p = await a.participantes.registrar({ grupoId: evento.grupoId, participanteId: evento.participanteId, telefoneE164: evento.telefoneE164 ?? null, nomeExibicao: evento.nomeExibicao ?? null });
      if (p.novo) await a.auditoria.registrar({ acao: "PARTICIPANTE_REGISTRADO", atorTipo: "SISTEMA", alvo: evento.participanteId, dados: { grupo: mascarar(evento.grupoId) } });

      // 5. Mensagem relacionada: texto respondendo a um documento que aguarda esclarecimento (atômico; sobrevive a reinício).
      if (evento.respostaA && evento.tipo === "TEXTO") {
        const pend = await a.mensagens.tomarPendente(evento.respostaA);
        if (pend?.pendente) {
          await a.historico.registrar({ eventoId: evento.eventoId, decisao: "RELACIONADA", motivo: "ESCLARECIMENTO_RECEBIDO", participanteId: evento.participanteId, organizacaoId: null, unidadeId: null });
          return processar(pend.pendente.evento, { esclarecimento: { texto: evento.texto, saida: pend.pendente.saida, porEvento: evento.eventoId, participanteId: evento.participanteId } });
        }
      }
    }

    // 6. Idempotência por DOCUMENTO (mesmo arquivo reenviado em outra mensagem).
    if (evento.midia) {
      const visto = await a.documentos.visto(evento.midia.sha256);
      if (visto && visto.eventoId !== evento.eventoId) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "DOCUMENTO_JA_RECEBIDO", escopo: visto, propostaId: visto.propostaId ?? null, resposta: RESPOSTA.duplicado(visto.propostaId) });
    }

    // 7. Guardas determinísticas ANTES da IA (nada restrito vai ao modelo): dado restrito e pedido de aprovação pelo grupo.
    const injecao = sinaisDeInjecao(evento.texto) || sinaisDeInjecao(esclarecimento?.texto);
    if (evento.tipo === "TEXTO" && !esclarecimento && pedidoRestrito(evento.texto)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "DADO_RESTRITO", resposta: RESPOSTA.dadoRestrito(), injecao });
    if (evento.tipo === "TEXTO" && !esclarecimento && PEDIDO_DE_APROVACAO.test(evento.texto ?? "")) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "APROVACAO_SO_NO_CENTRO_FINANCEIRO", resposta: RESPOSTA.aprovacaoSoNoDashboard(), injecao });

    // 8. Leitura (IA): saída estrita; falha = pede reenvio, nada é criado.
    let saida = esclarecimento?.saida ?? null;
    if (!saida) {
      const lida = await lerDocumento(evento);
      if (!lida.ok) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: RESPOSTA.falhaLeitura(), injecao });
      saida = lida.saida;
    }

    // 9. Intenções que o MOVA nunca executa / que só o Nível 2 faz.
    if (INTENCOES_BLOQUEADAS.includes(saida.intencao)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `INTENCAO_PROIBIDA:${saida.intencao}`, resposta: RESPOSTA.operacaoBloqueada(), injecao });
    if (saida.intencao === "APROVAR_PROPOSTA") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "APROVACAO_SO_NO_CENTRO_FINANCEIRO", resposta: RESPOSTA.aprovacaoSoNoDashboard(), injecao });
    if (saida.consulta === "DADO_RESTRITO") return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "DADO_RESTRITO", resposta: RESPOSTA.dadoRestrito(), injecao });

    // 10. Consultas do GRUPO (não dependem de uma unidade).
    const consulta = (saida.intencao === "CONSULTAR" && saida.consulta) || null;
    if (consulta && CONSULTAS_DO_GRUPO.includes(consulta)) return responderConsultaDoGrupo(evento, grupo, consulta, injecao);

    // 11. Unidade (determinística; IA só confirma; nunca pelo histórico do participante).
    // O esclarecimento (resposta à pergunta) PREVALECE sobre o texto original, que era justamente o ambíguo.
    const textos = (esclarecimento ? [esclarecimento.texto] : [evento.texto]).filter(Boolean);
    const u = resolverUnidade({ cfg, grupo, textos, documentoDestinatario: saida.documentoDestinatario, sugestaoIa: saida.unidadeSugerida });
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      const nomes = cfg.unidades.filter((x) => grupo.unidades.includes(x.unidadeId)).map((x) => x.nome);
      if ((u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA || u.resultado === RESULTADO_UNIDADE.CONFLITANTE) && !esclarecimento) {
        await a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida } });
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao, extra: { evidenciaUnidade: u.evidencia } });
      }
      const resposta = u.resultado === RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE || u.resultado === RESULTADO_UNIDADE.FORA_DO_GRUPO ? RESPOSTA.documentoDeOutraUnidade() : RESPOSTA.unidadeConflitante();
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: u.resultado, resposta, injecao, extra: { evidenciaUnidade: u.evidencia } });
    }
    const unidade = u.unidade;
    const escopo = escopoDe(unidade);
    const ctx = { evento, escopo, unidade, saida, injecao, esclarecimento };

    if (consulta) return responderConsulta(ctx, consulta);

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

    if (![...PAGAMENTOS, ...CONTAS].includes(saida.tipoDocumento)) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "TIPO_DE_DOCUMENTO_NAO_RECONHECIDO", escopo, resposta: RESPOSTA.faltaInformacao(["tipo do documento (comprovante, boleto ou nota)"]), injecao });
    if (!saida.valorCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VALOR_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["valor"]), injecao });

    return PAGAMENTOS.includes(saida.tipoDocumento) ? tratarPagamento(ctx) : tratarConta(ctx);
  }

  async function marcarDocumento(evento, escopo, propostaId, leitura) {
    if (evento.midia) await a.documentos.marcar(evento.midia.sha256, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, propostaId, eventoId: evento.eventoId, leitura });
  }

  async function competenciaAberta({ evento, escopo, injecao }, competencia) {
    const estado = await porta.estadoDaCompetencia(escopo, competencia);
    if (estado === "ABERTA") return null;
    return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `COMPETENCIA_${estado}`, escopo, resposta: RESPOSTA.competenciaFechada(competencia), injecao });
  }

  async function criarProposta({ evento, escopo, unidade, saida, injecao, esclarecimento }, dados, textoResposta) {
    const incompleta = !requisitosCompletos(unidade);
    const { proposta } = await a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|${dados.tipo}`, origem: "MOVA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, esclarecidoPor: esclarecimento ? esclarecimento.participanteId : null,
      evidencia: evento.midia ? { sha256: evento.midia.sha256, referencia: evento.midia.referencia, mime: evento.midia.mime } : null,
      leitura: { tipoDocumento: saida.tipoDocumento, intencao: saida.intencao, favorecido: saida.favorecido, identificadorDocumento: saida.identificadorDocumento, confianca: saida.confianca },
      categoriaSugerida: saida.categoriaSugerida, naturezaSugerida: saida.natureza, sinaisDeInjecao: injecao,
      // Unidade com requisitos financeiros incompletos: a proposta é guardada, mas a APLICAÇÃO fica bloqueada até completar.
      bloqueioDeAplicacao: incompleta ? "REQUISITOS_FINANCEIROS_INCOMPLETOS" : null,
      // Quem aplica: uma pessoa com financeiro_v2.aprovar + financeiro_v2.aplicar (+ registrar), pelo Centro Financeiro.
      exigeParaAplicar: [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR],
      ...dados,
    });
    await marcarDocumento(evento, escopo, proposta.id, saida);
    await a.auditoria.registrar({ acao: "PROPOSTA_CRIADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: dados.tipo, unidadeId: escopo.unidadeId } });
    const texto = textoResposta(proposta) + (incompleta ? ` ${RESPOSTA.pendenteUnidadeIncompleta()}` : "");
    return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: dados.tipo, escopo, propostaId: proposta.id, resposta: texto, injecao });
  }

  async function tratarPagamento(ctx) {
    const { evento, escopo, saida, injecao } = ctx;
    if (!saida.dataPagamento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "DATA_DE_PAGAMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["data do pagamento"]), injecao });
    // CAIXA: o mês do pagamento precisa estar aberto (a saída de dinheiro cai nele).
    const bloqueio = await competenciaAberta(ctx, mes(saida.dataPagamento));
    if (bloqueio) return bloqueio;
    const abertas = await porta.contasAPagarAbertas(escopo);
    const valor = saida.valorCentavos;
    let candidatas = saida.favorecido ? abertas.filter((t) => fornecedorCompativel(saida.favorecido, t)) : abertas.filter((t) => t.saldoCentavos === valor);
    if (candidatas.length > 1) {
      const exatas = candidatas.filter((t) => t.saldoCentavos === valor);
      if (exatas.length === 1) candidatas = exatas;
      else return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VARIAS_OBRIGACOES_COMPATIVEIS", escopo, resposta: RESPOSTA.variasObrigacoes(candidatas.length), injecao });
    }
    if (candidatas.length === 1) {
      const t = candidatas[0];
      if (valor > t.saldoCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VALOR_MAIOR_QUE_SALDO", escopo, resposta: RESPOSTA.valorMaiorQueSaldo(), injecao });
      // BAIXA de obrigação existente: competência é a DA OBRIGAÇÃO; caixa é a data do pagamento. Não concilia extrato.
      return criarProposta(ctx, {
        tipo: TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, valorCentavos: valor, parcial: valor < t.saldoCentavos,
        datas: { competencia: t.competencia, caixa: saida.dataPagamento, vencimento: t.vencimento },
        comando: { operacao: "pagarContaAPagar", entrada: { obrigacaoId: t.id, contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
      }, RESPOSTA.propostaBaixa);
    }
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? mes(saida.dataPagamento);
    const bloqueioEconomico = await competenciaAberta(ctx, competencia);
    if (bloqueioEconomico) return bloqueioEconomico;
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.dataPagamento });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.DESPESA_PAGA, valorCentavos: valor, parcial: false,
      datas: { competencia, caixa: saida.dataPagamento, vencimento: saida.dataPagamento },
      comando: { operacao: "registrarObrigacao+pagarContaAPagar", entrada: comando.valor, pagamento: { contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
    }, RESPOSTA.propostaDespesaPaga);
  }

  async function tratarConta(ctx) {
    const { evento, escopo, saida, injecao } = ctx;
    if (!saida.vencimento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VENCIMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["vencimento"]), injecao });
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? mes(saida.vencimento);
    const bloqueio = await competenciaAberta(ctx, competencia);
    if (bloqueio) return bloqueio;
    const todas = await porta.contasAPagarTodas(escopo);
    const igual = todas.find((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === saida.valorCentavos && t.vencimento === saida.vencimento && (!saida.favorecido || fornecedorCompativel(saida.favorecido, t)));
    if (igual) {
      await marcarDocumento(evento, escopo, null, saida);
      return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "OBRIGACAO_JA_REGISTRADA", escopo, resposta: RESPOSTA.obrigacaoJaExiste(igual), injecao });
    }
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.vencimento });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(ctx, {
      tipo: TIPO_PROPOSTA.NOVA_OBRIGACAO, valorCentavos: saida.valorCentavos, parcial: false,
      datas: { competencia, caixa: null, vencimento: saida.vencimento },
      comando: { operacao: "registrarObrigacao", entrada: comando.valor },
    }, RESPOSTA.propostaObrigacao);
  }

  /** Comando no contrato REAL do Financeiro v2; categoria PROVISÓRIA (a sugestão da IA fica ao lado, para quem aprova). */
  function comandoDeObrigacao(saida, { competencia, vencimento }) {
    const emissao = saida.dataEmissao && saida.dataEmissao <= vencimento ? saida.dataEmissao : (hoje() <= vencimento ? hoje() : vencimento);
    const bruto = {
      contraparteNova: { tipo: "FORNECEDOR", nome: saida.favorecido ?? "Favorecido a identificar" },
      valorOriginalCentavos: saida.valorCentavos, categoria: porta.categoriaProvisoria,
      descricao: `${saida.tipoDocumento === "BOLETO" ? "Boleto" : saida.tipoDocumento === "NOTA_FISCAL" ? "Nota fiscal" : "Comprovante"} recebido pelo MOVA`,
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

  /** Agregados compartilháveis de UMA unidade (política em dominio/privacidade.js). `null` = dados insuficientes. */
  async function agregados(escopo) {
    const r = await porta.resumo(escopo, mes(hoje()));
    const pagar = r?.contasAPagar; const receber = r?.contasAReceber;
    if ((!pagar || pagar.situacao === "SEM_REGISTROS") && (!receber || receber.situacao === "SEM_REGISTROS")) return null;
    return {
      pagar: pagar?.situacao === "CALCULADO" ? { saldo: pagar.saldoCentavos, vencido: pagar.vencidoCentavos, registros: pagar.registros } : null,
      receber: receber?.situacao === "CALCULADO" ? { saldo: receber.saldoCentavos, registros: receber.registros } : null,
    };
  }

  async function responderConsulta({ evento, escopo, unidade, injecao }, consulta) {
    const linhas = [];
    if (consulta === "CONTAS_VENCENDO") {
      const abertas = await porta.contasAPagarAbertas(escopo);
      const lista = abertas.filter((t) => t.vencimento >= hoje() && t.vencimento <= somarDias(hoje(), 7));
      linhas.push(`${unidade.nome} — vencendo em 7 dias: ${lista.length} (${reais(lista.reduce((s, t) => s + t.saldoCentavos, 0))}).`);
    } else {
      const g = await agregados(escopo);
      if (!g) return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: `${consulta}:DADOS_INSUFICIENTES`, escopo, resposta: RESPOSTA.dadosInsuficientes(unidade.nome), injecao });
      if (g.pagar) linhas.push(`${unidade.nome} — a pagar em aberto: ${reais(g.pagar.saldo)} (vencido: ${reais(g.pagar.vencido)}).`);
      if (consulta === "RESUMO_DA_COMPETENCIA" && g.receber) linhas.push(`${unidade.nome} — a receber em aberto: ${reais(g.receber.saldo)}.`);
      linhas.push("Detalhes no Centro Financeiro.");
    }
    return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: consulta, escopo, resposta: RESPOSTA.consulta(linhas), injecao });
  }

  async function responderConsultaDoGrupo(evento, grupo, consulta, injecao) {
    const unidades = cfg.unidades.filter((x) => grupo.unidades.includes(x.unidadeId));
    const linhas = [];
    for (const u of unidades) {
      if (consulta === "SITUACAO_PROPOSTAS") {
        const ps = await a.propostas.listar(escopoDe(u));
        const n = (e) => ps.filter((p) => p.estado === e).length;
        linhas.push(`${u.nome}: ${n("AGUARDANDO_REVISAO")} aguardando revisão, ${n("APLICADA")} aplicadas, ${n("REJEITADA")} rejeitadas.`);
      } else {
        const g = await agregados(escopoDe(u));
        linhas.push(g?.pagar ? `${u.nome}: a pagar em aberto ${reais(g.pagar.saldo)} (vencido ${reais(g.pagar.vencido)}).` : `${u.nome}: dados insuficientes.`);
      }
    }
    return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: consulta, resposta: RESPOSTA.consulta(linhas), injecao });
  }

  return Object.freeze({ processar });
}

function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10);
}
