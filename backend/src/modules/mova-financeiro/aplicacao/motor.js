// MOTOR do MOVA — determinístico. Recebe um evento VALIDADO (contratos/evento.js) e decide UMA coisa:
// ignorar, bloquear, pedir informação, responder uma consulta ou criar uma PROPOSTA SIMULADA para revisão humana.
//
// Ordem (cada passo é fail-closed):
//   grupo autorizado → mensagem própria (ignora) → vínculo do participante → mensagem relacionada (esclarecimento)
//   → duplicidade do documento → leitura (IA, saída estrita) → intenção proibida → unidade → permissão na unidade
//   → consulta OU documento → fontes de receita → competência × caixa → obrigações existentes → proposta.
// Nunca: grava no Financeiro, paga, exclui, corrige, classifica em definitivo (categoria vai como SUGESTÃO; o comando usa a
// categoria provisória do plano) nem age em competência que não esteja ABERTA.
// Comprovante de obrigação existente = proposta de BAIXA (nunca despesa nova).
import { grupoAutorizado, mascarar, normalizar, vinculoDe } from "../dominio/configuracao.js";
import { RESULTADO_UNIDADE, resolverUnidade } from "../dominio/unidade.js";
import { CANAIS_SO_PELA_PLATAFORMA, fontesOficiais } from "../dominio/fontesDeReceita.js";
import { INTENCOES_BLOQUEADAS, SAIDA_VAZIA, sinaisDeInjecao, validarSaidaDaIa } from "../ia/contratos.js";
import { RESPOSTA, reais } from "./respostas.js";

export const DECISAO = Object.freeze({
  IGNORADO: "IGNORADO", BLOQUEADO: "BLOQUEADO", PEDIR_INFORMACAO: "PEDIR_INFORMACAO", DUPLICADO: "DUPLICADO",
  CONSULTA: "CONSULTA", ORIENTACAO: "ORIENTACAO", PROPOSTA: "PROPOSTA", FALHA_LEITURA: "FALHA_LEITURA",
});
export const TIPO_PROPOSTA = Object.freeze({ BAIXA_DE_OBRIGACAO: "BAIXA_DE_OBRIGACAO", DESPESA_PAGA: "DESPESA_PAGA", NOVA_OBRIGACAO: "NOVA_OBRIGACAO" });
const PAGAMENTOS = ["COMPROVANTE_PAGAMENTO", "RECIBO"];
const CONTAS = ["BOLETO", "NOTA_FISCAL"];
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
  const ACAO = porta.acoes;   // permissões do Financeiro v2, vindas da porta (o MOVA não importa o núcleo)

  function concluir(evento, { decisao, motivo, escopo = null, resposta = null, propostaId = null, injecao = false, extra = {} }) {
    a.historico.registrar({
      organizacaoId: escopo?.organizacaoId ?? null, unidadeId: escopo?.unidadeId ?? null, eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      provedor: evento.provedor, tipoMensagem: evento.tipo, decisao, motivo, propostaId, sinaisDeInjecao: injecao, documentoSha256: evento.midia?.sha256 ?? null, ...extra,
    });
    registrar({ tipo: "MOVA_DECISAO", decisao, motivo, grupo: mascarar(evento.grupoId) });
    if (resposta) a.saida.enfileirar({ grupoId: evento.grupoId, respostaA: evento.mensagemId, texto: resposta, simulada: true });
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
    // 2. Mensagem da própria conta (inclusive as respostas do MOVA): ignora, sem histórico — evita laço.
    if (evento.fromMe) return { decisao: DECISAO.IGNORADO, motivo: "MENSAGEM_PROPRIA" };
    // 3. Participar do grupo NÃO dá acesso: só participante vinculado a um usuário.
    const vinculo = vinculoDe(cfg, evento.participanteId);
    if (!vinculo) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "PARTICIPANTE_SEM_VINCULO", resposta: RESPOSTA.participanteSemVinculo() });

    // 4. Mensagem relacionada: texto respondendo a um documento que ficou aguardando a unidade.
    const anterior = evento.respostaA ? a.mensagens.obter(evento.respostaA) : null;
    if (anterior?.pendente && evento.tipo === "TEXTO" && !esclarecimento) {
      a.mensagens.lembrar(evento.respostaA, { ...anterior, pendente: null });
      return processar(anterior.pendente.evento, { esclarecimento: { texto: evento.texto, saida: anterior.pendente.saida, porEvento: evento.eventoId } });
    }

    // 5. Idempotência por DOCUMENTO (mesmo arquivo reenviado em outra mensagem).
    if (evento.midia) {
      const visto = a.documentos.visto(evento.midia.sha256);
      if (visto) return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "DOCUMENTO_JA_RECEBIDO", escopo: visto, propostaId: visto.propostaId ?? null, resposta: RESPOSTA.duplicado(visto.propostaId) });
    }

    // 6. Leitura (IA): saída estrita; falha = pede reenvio, nada é criado.
    const injecao = sinaisDeInjecao(evento.texto) || sinaisDeInjecao(esclarecimento?.texto);
    let saida = esclarecimento?.saida ?? null;
    if (!saida) {
      const lida = await lerDocumento(evento);
      if (!lida.ok) return concluir(evento, { decisao: DECISAO.FALHA_LEITURA, motivo: lida.motivo, resposta: RESPOSTA.falhaLeitura(), injecao });
      saida = lida.saida;
    }

    // 7. Intenções que o MOVA nunca executa.
    if (INTENCOES_BLOQUEADAS.includes(saida.intencao)) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `INTENCAO_PROIBIDA:${saida.intencao}`, resposta: RESPOSTA.operacaoBloqueada(), injecao });

    // 8. Unidade (determinística; IA só confirma).
    const textos = [evento.texto, esclarecimento?.texto].filter(Boolean);
    const u = resolverUnidade({ cfg, grupo, textos, documentoDestinatario: saida.documentoDestinatario, sugestaoIa: saida.unidadeSugerida });
    if (u.resultado !== RESULTADO_UNIDADE.IDENTIFICADA) {
      if (u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA && !esclarecimento) {
        a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida } });
        const nomes = cfg.unidades.filter((x) => grupo.unidades.includes(x.unidadeId)).map((x) => x.nome);
        return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: u.resultado, resposta: RESPOSTA.unidadeNaoIdentificada(nomes), injecao });
      }
      const resposta = u.resultado === RESULTADO_UNIDADE.CONFLITANTE ? RESPOSTA.unidadeConflitante() : u.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA ? RESPOSTA.unidadeConflitante() : RESPOSTA.documentoDeOutraUnidade();
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: u.resultado, resposta, injecao, extra: { evidenciaUnidade: u.evidencia } });
    }
    const unidade = u.unidade;
    const escopo = { organizacaoId: unidade.organizacaoId, unidadeId: unidade.unidadeId, usuarioId: vinculo.usuarioId };

    // 9. Permissão do USUÁRIO vinculado NA unidade (concessão gravada do Financeiro v2).
    const permissoes = await porta.permissoesDoUsuario(escopo);
    const consulta = saida.intencao === "CONSULTAR" && saida.consulta;
    const exigidas = consulta ? [ACAO.VER] : [ACAO.VER, ACAO.ENVIAR_DOCUMENTO];
    if (!exigidas.every((p) => permissoes.includes(p))) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "PERMISSAO_INSUFICIENTE", escopo, resposta: RESPOSTA.semPermissao(unidade.nome), injecao });

    // 10. Consulta autorizada ao dashboard (somente leitura, lista fechada).
    if (consulta) return responderConsulta(evento, escopo, saida, injecao);

    // 11. Receita: nunca pelo MOVA; responde a fonte oficial (sem contar duas vezes).
    if (saida.tipoDocumento === "RELATORIO_VENDAS" || saida.natureza === "RECEITA") {
      const f = fontesOficiais(unidade);
      if (f.situacao !== "CONFIRMADA") return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "FONTES_NAO_CONFIRMADAS", escopo, resposta: RESPOSTA.fonteNaoConfirmada(), injecao });
      const canais = Object.entries(f.canais).map(([c, fonte]) => `${c}: ${fonte}${CANAIS_SO_PELA_PLATAFORMA.includes(c) ? " (oficial da plataforma)" : ""}`).join("; ");
      marcarDocumento(evento, escopo, null);
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "RECEITA_SO_PELA_FONTE_OFICIAL", escopo, resposta: RESPOSTA.fonteOficial(canais), injecao });
    }

    if (![...PAGAMENTOS, ...CONTAS].includes(saida.tipoDocumento)) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "TIPO_DE_DOCUMENTO_NAO_RECONHECIDO", escopo, resposta: RESPOSTA.faltaInformacao(["tipo do documento (comprovante, boleto ou nota)"]), injecao });
    if (!saida.valorCentavos) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VALOR_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["valor"]), injecao });

    return PAGAMENTOS.includes(saida.tipoDocumento) ? tratarPagamento(evento, escopo, saida, injecao) : tratarConta(evento, escopo, saida, injecao);
  }

  function marcarDocumento(evento, escopo, propostaId) {
    if (evento.midia) a.documentos.marcar(evento.midia.sha256, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, propostaId, eventoId: evento.eventoId });
  }

  async function competenciaAberta(evento, escopo, competencia, injecao) {
    const estado = await porta.estadoDaCompetencia(escopo, competencia);
    if (estado === "ABERTA") return null;
    return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: `COMPETENCIA_${estado}`, escopo, resposta: RESPOSTA.competenciaFechada(competencia), injecao });
  }

  function criarProposta(evento, escopo, saida, injecao, dados, textoResposta) {
    const { proposta } = a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|${dados.tipo}`, origem: "MOVA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      proponenteUsuarioId: escopo.usuarioId, evidencia: evento.midia ? { sha256: evento.midia.sha256, referencia: evento.midia.referencia, mime: evento.midia.mime } : null,
      leitura: { tipoDocumento: saida.tipoDocumento, favorecido: saida.favorecido, identificadorDocumento: saida.identificadorDocumento, confianca: saida.confianca },
      categoriaSugerida: saida.categoriaSugerida, naturezaSugerida: saida.natureza, sinaisDeInjecao: injecao,
      // Quem aplica: uma pessoa com financeiro_v2.aprovar + financeiro_v2.aplicar, pelo serviço real (pendente nesta execução).
      exigeParaAplicar: [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR],
      ...dados,
    });
    marcarDocumento(evento, escopo, proposta.id);
    return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: dados.tipo, escopo, propostaId: proposta.id, resposta: textoResposta(proposta), injecao });
  }

  async function tratarPagamento(evento, escopo, saida, injecao) {
    if (!saida.dataPagamento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "DATA_DE_PAGAMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["data do pagamento"]), injecao });
    // CAIXA: o mês do pagamento precisa estar aberto (a saída de dinheiro cai nele).
    const bloqueio = await competenciaAberta(evento, escopo, mes(saida.dataPagamento), injecao);
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
      // BAIXA de obrigação existente: competência é a DA OBRIGAÇÃO (não muda); caixa é a data do pagamento.
      return criarProposta(evento, escopo, saida, injecao, {
        tipo: TIPO_PROPOSTA.BAIXA_DE_OBRIGACAO, valorCentavos: valor, parcial: valor < t.saldoCentavos,
        datas: { competencia: t.competencia, caixa: saida.dataPagamento, vencimento: t.vencimento },
        // Formato EXATO de pagarContaAPagar do Financeiro v2 (contaId é escolhida por quem aprova).
        comando: { operacao: "pagarContaAPagar", entrada: { obrigacaoId: t.id, contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
      }, RESPOSTA.propostaBaixa);
    }
    // Sem obrigação correspondente: despesa já paga = obrigação + pagamento, ambos na proposta.
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? mes(saida.dataPagamento);
    const bloqueioEconomico = await competenciaAberta(evento, escopo, competencia, injecao);
    if (bloqueioEconomico) return bloqueioEconomico;
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.dataPagamento });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(evento, escopo, saida, injecao, {
      tipo: TIPO_PROPOSTA.DESPESA_PAGA, valorCentavos: valor, parcial: false,
      datas: { competencia, caixa: saida.dataPagamento, vencimento: saida.dataPagamento },
      comando: { operacao: "registrarObrigacao+pagarContaAPagar", entrada: comando.valor, pagamento: { contaId: null, dataEfetiva: saida.dataPagamento, valorCentavos: valor } },
    }, RESPOSTA.propostaDespesaPaga);
  }

  async function tratarConta(evento, escopo, saida, injecao) {
    if (!saida.vencimento) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "VENCIMENTO_AUSENTE", escopo, resposta: RESPOSTA.faltaInformacao(["vencimento"]), injecao });
    const competencia = saida.competencia ?? mes(saida.dataEmissao) ?? mes(saida.vencimento);
    const bloqueio = await competenciaAberta(evento, escopo, competencia, injecao);
    if (bloqueio) return bloqueio;
    const todas = await porta.contasAPagarTodas(escopo);
    const igual = todas.find((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === saida.valorCentavos && t.vencimento === saida.vencimento && (!saida.favorecido || fornecedorCompativel(saida.favorecido, t)));
    if (igual) {
      marcarDocumento(evento, escopo, null);
      return concluir(evento, { decisao: DECISAO.DUPLICADO, motivo: "OBRIGACAO_JA_REGISTRADA", escopo, resposta: RESPOSTA.obrigacaoJaExiste(igual), injecao });
    }
    const comando = comandoDeObrigacao(saida, { competencia, vencimento: saida.vencimento });
    if (!comando.ok) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: `COMANDO_INVALIDO:${comando.campo}`, escopo, resposta: RESPOSTA.faltaInformacao([comando.campo]), injecao });
    return criarProposta(evento, escopo, saida, injecao, {
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

  async function responderConsulta(evento, escopo, saida, injecao) {
    const competencia = mes(hoje());
    const linhas = [];
    if (saida.consulta === "RESUMO_DA_COMPETENCIA") {
      const r = await porta.resumo(escopo, competencia);
      linhas.push(`Resumo ${competencia} disponível no Centro Financeiro (consulta somente leitura).`);
      if (r?.contasAPagar?.saldoCentavos !== undefined) linhas.push(`A pagar em aberto: ${reais(r.contasAPagar.saldoCentavos)}.`);
    } else {
      const abertas = await porta.contasAPagarAbertas(escopo);
      const lista = saida.consulta === "CONTAS_VENCENDO" ? abertas.filter((t) => t.vencimento >= hoje() && t.vencimento <= somarDias(hoje(), 7)) : abertas;
      const total = lista.reduce((s, t) => s + t.saldoCentavos, 0);
      linhas.push(`${saida.consulta === "CONTAS_VENCENDO" ? "Vencendo em 7 dias" : "Contas a pagar em aberto"}: ${lista.length} (${reais(total)}).`);
    }
    return concluir(evento, { decisao: DECISAO.CONSULTA, motivo: saida.consulta, escopo, resposta: RESPOSTA.consulta(linhas), injecao });
  }

  return Object.freeze({ processar });
}

function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10);
}
