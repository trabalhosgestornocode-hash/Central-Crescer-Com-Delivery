// MOVA — Agente 2, Frente D INTEGRADA: o entregador no WhatsApp, ligado ao fechamento OFICIAL do Financeiro.
//
// Não é um segundo módulo de entregadores: fechamento, nota, conferência e liberação são de Financeiro v2 (entregadoresProprios).
// Aqui:
//   - conversa privada do entregador (lista fechada por unidade; identidade = número/LID cadastrado, nunca o nome digitado);
//   - ele vê SÓ o próprio fechamento (consulta pela chave cadastrada, nunca pelo que ele digitar);
//   - a NFS-e em PDF vira anexo OFICIAL (anexarDocumentoDoEntregador) pela identidade OPERACIONAL, se houver concessão; sem ela,
//     fica PENDENTE_ANEXO para o Centro Financeiro. A conferência/liberação continua sendo a do Financeiro (exige "conciliar",
//     que a porta operacional não leva);
//   - rotina: segunda-feira no horário configurado, a mensagem da semana fechada; depois, a cobrança da nota perto do prazo.
//     Cada envio tem chave única (nunca repete); automação ausente ou pausada não envia nada. A saída passa pelo enviador de
//     sempre (mova.controle, marco de envio, destinos permitidos).
import { reais, dataBr } from "./respostas.js";
import { mensagemCobrancaNota, mensagemSemanal, pendenciaDeNota, precisaCobrarNota } from "../dominio/entregadores.js";
import { ErroTransitorio } from "../gateway/fila.js";

export const AUTOMACAO = Object.freeze({ SEMANAL: "ENTREGADORES_SEMANAL", COBRANCA: "ENTREGADORES_COBRANCA" });
const AGUARDANDO = ["AGUARDANDO_NF", "NF_REJEITADA"];
const FUSO_MS = -3 * 3600 * 1000; // horário de Brasília (sem horário de verão desde 2019)
const naoEncontrado = (e) => e?.codigo === "FV2_NAO_ENCONTRADO";

export const RESPOSTA_ENTREGADOR = Object.freeze({
  semFechamento: () => "Ainda não há fechamento seu nesta unidade. Quando a semana for fechada, mando o resumo por aqui.",
  indisponivel: () => "Não consegui consultar seu fechamento agora. Tente de novo em alguns minutos.",
  notaAnexada: (f, situacao) => situacao === "LIBERADO_PAGAMENTO"
    ? `Recebi sua nota da semana ${dataBr(f.semanaInicio)} (${reais(f.valorCentavos)}): conferida e pagamento liberado.`
    : `Recebi sua nota da semana ${dataBr(f.semanaInicio)} (${reais(f.valorCentavos)}) e anexei ao seu fechamento. Ela está em conferência; aviso quando o pagamento for liberado.`,
  notaJaRecebida: () => "Essa nota já tinha sido recebida. Se precisar trocar, envie o PDF novo.",
  notaRecusadaNoFinanceiro: () => "Recebi o arquivo, mas ele não pôde ser anexado automaticamente. O financeiro vai conferir e te retorna por aqui.",
  notaRecusada: (motivo) => ({
    NOTA_PRECISA_SER_PDF: "Para a nota fiscal, envie o PDF da NFS-e (foto ou print não servem como nota).",
    PAGAMENTO_JA_LIBERADO: "O pagamento dessa semana já foi liberado; não é preciso enviar nota de novo.",
    SEMANA_COM_DUPLICIDADE: "Essa semana está em revisão pelo financeiro. Aguarde o retorno antes de enviar a nota.",
  })[motivo] ?? "Não achei uma semana sua aguardando nota. O financeiro confere e te retorna por aqui.",
});

/** Data local (Brasília) e hora "HH:MM" de um instante. */
function local(agora) {
  const d = new Date(agora.getTime() + FUSO_MS);
  return { dia: d.toISOString().slice(0, 10), hora: d.toISOString().slice(11, 16), semana: d.getUTCDay() };
}
const somarDias = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * @param {{cfg:object, porta:object, armazenamento:object, operacional?:object|null, obterEvidencia:Function, relogio?:Function, registrar?:Function}} deps
 */
export function criarEntregadoresMova({ cfg, porta, armazenamento: a, operacional = null, obterEvidencia, relogio = () => new Date(), registrar = () => {} }) {
  const servico = cfg.identidadeServico.usuarioId;
  const unidadeDe = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  const escopoDe = (unidadeId) => { const u = unidadeDe(unidadeId); return { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico }; };
  const lerFechamentos = async (ent) => {
    try { return (await porta.ler("consultarEntregador", escopoDe(ent.unidadeId), { entregador: ent.chave })).fechamentos.filter((f) => f.entregador?.chave === ent.chave); }
    catch (e) { if (naoEncontrado(e)) return []; throw e; }
  };

  /** Mensagem no privado do entregador (o motor já conferiu conversa e número). Devolve { decisao, motivo, resposta, escopo }. */
  async function atender(evento, grupo) {
    const ent = grupo.entregador;
    const escopo = escopoDe(ent.unidadeId);
    let fechamentos;
    try { fechamentos = await lerFechamentos(ent); } catch (e) {
      if (e instanceof ErroTransitorio) throw e; // a fila tenta de novo
      return { decisao: "CONSULTA", motivo: "FECHAMENTO_INDISPONIVEL", resposta: RESPOSTA_ENTREGADOR.indisponivel(), escopo };
    }
    if (!evento.midia) {
      const atual = fechamentos[0] ?? null;
      return { decisao: "CONSULTA", motivo: atual ? "FECHAMENTO_DO_ENTREGADOR" : "ENTREGADOR_SEM_FECHAMENTO", resposta: (atual && mensagemSemanal(atual)) || RESPOSTA_ENTREGADOR.semFechamento(), escopo };
    }
    // Nota: a semana mais antiga dele que ainda aguarda nota (sem duplicidade); senão a mais recente (a recusa explica o motivo).
    const alvo = [...fechamentos].reverse().find((f) => AGUARDANDO.includes(f.situacaoDocumental) && !f.duplicidade) ?? fechamentos[0] ?? null;
    const pend = pendenciaDeNota({ entregador: { chave: ent.chave, unidadeId: ent.unidadeId }, fechamento: alvo, midia: evento.midia, recebidoEm: relogio().toISOString() });
    if (!pend.ok) return { decisao: "BLOQUEADO", motivo: pend.motivo, resposta: RESPOSTA_ENTREGADOR.notaRecusada(pend.motivo), escopo };
    if (!/^[0-9a-f]{64}$/.test(evento.midia.sha256 ?? "")) return { decisao: "BLOQUEADO", motivo: "NOTA_SEM_INTEGRIDADE", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    const { nota, nova } = await a.notasEntregador.registrar({ organizacaoId: escopo.organizacaoId, unidadeId: ent.unidadeId, entregador: ent.chave, semanaInicio: alvo.semanaInicio, sha256: evento.midia.sha256, eventoId: evento.eventoId });
    if (!nova && nota.estado !== "PENDENTE_ANEXO") return { decisao: "DUPLICADO", motivo: "NOTA_JA_RECEBIDA", resposta: RESPOSTA_ENTREGADOR.notaJaRecebida(), escopo };
    const esc = { organizacaoId: escopo.organizacaoId, unidadeId: ent.unidadeId };
    if (!operacional || !(await operacional.pode("anexarDocumentoDoEntregador", esc))) {
      await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_PENDENTE", atorTipo: "SISTEMA", alvo: nota.id, dados: { semana: alvo.semanaInicio, motivo: operacional ? "SEM_CONCESSAO_OPERACIONAL" : "SEM_IDENTIDADE_OPERACIONAL" } });
      return { decisao: "PROPOSTA", motivo: "NOTA_PENDENTE_ANEXO", resposta: pend.resposta, escopo };
    }
    const bytes = await obterEvidencia(evento.midia.referencia);
    if (!bytes) return { decisao: "BLOQUEADO", motivo: "SEM_EVIDENCIA", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    try {
      const r = await operacional.chamar("anexarDocumentoDoEntregador", esc, {
        inicio: alvo.semanaInicio, entregador: ent.chave, tipoAnexo: "NOTA_FISCAL",
        arquivo: { conteudo: bytes, nome: `nfse-${alvo.semanaInicio}.pdf`, tipoMime: "application/pdf" },
      });
      const situacao = r.situacaoDocumental ?? r.fechamento?.situacaoDocumental ?? null;
      await a.notasEntregador.concluir(nota.id, { estado: "ANEXADA", documentoId: r.documento?.id ?? null, situacaoDocumental: situacao });
      await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_ANEXADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: nota.id, dados: { semana: alvo.semanaInicio, situacao } });
      return { decisao: "EXECUTADO", motivo: "NOTA_ANEXADA", resposta: RESPOSTA_ENTREGADOR.notaAnexada(alvo, situacao), escopo };
    } catch (e) {
      if (e instanceof ErroTransitorio) throw e; // fica PENDENTE_ANEXO; a nova tentativa da fila anexa
      await a.notasEntregador.concluir(nota.id, { estado: "RECUSADA", motivo: String(e?.detalhes?.motivo ?? e?.codigo ?? "RECUSADA").slice(0, 120) });
      registrar({ tipo: "MOVA_NOTA_ENTREGADOR_RECUSADA", codigo: e?.codigo ?? "ERRO" });
      return { decisao: "BLOQUEADO", motivo: "NOTA_RECUSADA_NO_FINANCEIRO", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    }
  }

  /** Envia uma vez (chave única) para o privado do entregador; devolve true se entrou na fila agora. */
  async function enviarUmaVez({ ent, tipo, semanaInicio, chave, texto }) {
    const u = unidadeDe(ent.unidadeId);
    if (!(await a.enviosEntregador.registrar({ chave, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, entregador: ent.chave, tipo, semanaInicio }))) return false;
    await a.saida.enfileirar({ grupoId: ent.privado, respostaA: null, eventoId: null, texto, simulada: true });
    return true;
  }

  const ativa = (auto, hora) => auto && auto.ativa && !auto.pausadaEm && hora >= auto.horario;

  /**
   * Um passo da rotina (chamado periodicamente). Idempotente: pode rodar quantas vezes for; cada mensagem sai no máximo uma vez.
   * @returns {Promise<{semanais:number, cobrancas:number, pulados:string[]}>}
   */
  async function rotina() {
    const agora = relogio();
    const { dia, hora, semana } = local(agora);
    const resumo = { semanais: 0, cobrancas: 0, pulados: [] };
    const porUnidade = new Map();
    for (const e of cfg.entregadores ?? []) if (e.ativo) porUnidade.set(e.unidadeId, [...(porUnidade.get(e.unidadeId) ?? []), e]);
    // Só entregadores com conversa válida (um número que é da equipe não recebe mensagem de entregador).
    const comConversa = new Set(cfg.gruposAutorizados.filter((g) => g.entregador).map((g) => g.grupoId));
    for (const [unidadeId, lista] of porUnidade) {
      const semanal = await a.automacoes.obter(AUTOMACAO.SEMANAL, unidadeId);
      const cobranca = await a.automacoes.obter(AUTOMACAO.COBRANCA, unidadeId);
      const fazSemanal = semana === 1 && ativa(semanal, hora);
      const fazCobranca = ativa(cobranca, hora);
      if (!fazSemanal && !fazCobranca) continue;
      const inicioFechado = somarDias(dia, -7 - ((semana + 6) % 7)); // segunda-feira da semana anterior
      for (const ent of lista) {
        if (!comConversa.has(ent.privado)) { resumo.pulados.push("SEM_CONVERSA"); continue; }
        try {
          if (fazSemanal) {
            let f = null;
            try { f = await porta.ler("detalharFechamentoDoEntregador", escopoDe(unidadeId), { inicio: inicioFechado, entregador: ent.chave }); } catch (e) { if (!naoEncontrado(e)) throw e; }
            const texto = f && f.entregador?.chave === ent.chave ? mensagemSemanal(f) : null;
            if (!texto) resumo.pulados.push("SEM_FECHAMENTO");
            else if (await enviarUmaVez({ ent, tipo: "SEMANAL", semanaInicio: inicioFechado, chave: `SEMANAL|${unidadeId}|${ent.chave}|${inicioFechado}`, texto })) resumo.semanais += 1;
          }
          if (fazCobranca) {
            for (const f of await lerFechamentos(ent)) {
              if (!precisaCobrarNota(f, dia)) continue;
              if (await enviarUmaVez({ ent, tipo: "COBRANCA_NOTA", semanaInicio: f.semanaInicio, chave: `COBRANCA|${unidadeId}|${ent.chave}|${f.semanaInicio}|${dia}`, texto: mensagemCobrancaNota(f, dia) })) resumo.cobrancas += 1;
            }
          }
        } catch (e) {
          resumo.pulados.push("FALHA_DE_LEITURA");
          registrar({ tipo: "MOVA_ROTINA_ENTREGADOR_FALHOU", codigo: e?.codigo ?? "ERRO" });
        }
      }
      if (fazSemanal) await a.automacoes.marcarExecucao(AUTOMACAO.SEMANAL, unidadeId, agora.toISOString());
      if (fazCobranca) await a.automacoes.marcarExecucao(AUTOMACAO.COBRANCA, unidadeId, agora.toISOString());
    }
    return resumo;
  }

  return Object.freeze({ atender, rotina });
}
