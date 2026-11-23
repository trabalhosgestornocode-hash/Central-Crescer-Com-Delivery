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
import { avisoDeDemonstrativo, avisoDeLiberacao, avisoDeNotaRecebida, conferirNotaDoEntregador, escolherObrigacaoDaNota, EXTENSAO_DA_NOTA, mensagemCobrancaNota, mensagemSemanal, pendenciaDeNota, perguntaDeEmpresaDaNota, precisaCobrarNota, relatorioDeQuarta, respostaDaConferencia } from "../dominio/entregadores.js";
import { ErroTransitorio } from "../gateway/fila.js";
import { validarSaidaDaIa } from "../ia/contratos.js";

// 23/11: RELATORIO = quarta-feira (horário da automação; 08:00 pela decisão do proprietário) no grupo financeiro da unidade;
// AVISO_GRUPO = aviso de cada obrigação LIBERADA no grupo da unidade (a 1ª passada só registra o que já estava liberado).
export const AUTOMACAO = Object.freeze({ SEMANAL: "ENTREGADORES_SEMANAL", COBRANCA: "ENTREGADORES_COBRANCA", RELATORIO: "ENTREGADORES_RELATORIO", AVISO_GRUPO: "ENTREGADORES_AVISO_GRUPO" });
const AGUARDANDO = ["AGUARDANDO_NF", "NF_REJEITADA"];
const FUSO_MS = -3 * 3600 * 1000; // America/Fortaleza (UTC−3, sem horário de verão; igual a Brasília desde 2019)
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
    NOTA_PRECISA_SER_PDF: "Para a nota fiscal, envie o PDF da NFS-e ou uma foto/print legível da nota.",
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
export function criarEntregadoresMova({ cfg, porta, armazenamento: a, operacional = null, extrator = null, obterEvidencia, relogio = () => new Date(), registrar = () => {} }) {
  const servico = cfg.identidadeServico.usuarioId;
  const unidadeDe = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  const rotuloDe = (id) => { const u = unidadeDe(id); return { unidade: u?.nome ?? null, empresa: u?.empresa ?? null }; };
  const cnpjDe = (id) => (unidadeDe(id)?.documentos ?? []).map((d) => String(d).replace(/\D/g, "")).find((d) => d.length === 14) ?? null;
  // Grupo financeiro AUTORIZADO SÓ para esta unidade (nunca publica dados de uma unidade em grupo de outra ou de várias).
  const grupoDaUnidade = (id) => {
    const g = cfg.gruposAutorizados.filter((x) => !x.privada && !x.entregador && x.politicaResposta === "GRUPO_FINANCEIRO" && x.unidades.length === 1 && x.unidades[0] === id);
    return g.length === 1 ? g[0] : null;
  };
  const escopoDe = (unidadeId) => { const u = unidadeDe(unidadeId); return { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico }; };
  const lerFechamentos = async (ent) => {
    try { return (await porta.ler("consultarEntregador", escopoDe(ent.unidadeId), { entregador: ent.chave })).fechamentos.filter((f) => f.entregador?.chave === ent.chave); }
    catch (e) { if (naoEncontrado(e)) return []; throw e; }
  };

  /** Mensagem no privado do entregador (o motor já conferiu conversa e número). Devolve { decisao, motivo, resposta, escopo }. */
  async function atender(evento, grupo) {
    // 23/11: um vínculo por empresa (Açaí, Subway…). Cada um tem o seu fechamento, a sua obrigação e a sua nota.
    const vinculos = (grupo.entregadores?.length ? grupo.entregadores : [grupo.entregador]).filter((v) => unidadeDe(v.unidadeId));
    if (!vinculos.length) return { decisao: "BLOQUEADO", motivo: "ENTREGADOR_SEM_UNIDADE_ATENDIDA", resposta: RESPOSTA_ENTREGADOR.semFechamento(), escopo: null };
    const porVinculo = [];
    try { for (const v of vinculos) porVinculo.push({ ent: v, fechamentos: await lerFechamentos(v) }); } catch (e) {
      if (e instanceof ErroTransitorio) throw e; // a fila tenta de novo
      return { decisao: "CONSULTA", motivo: "FECHAMENTO_INDISPONIVEL", resposta: RESPOSTA_ENTREGADOR.indisponivel(), escopo: escopoDe(vinculos[0].unidadeId) };
    }
    if (!evento.midia) {
      // Uma seção por empresa, cada uma com o próprio fechamento (nunca somadas).
      const secoes = porVinculo.map(({ ent, fechamentos }) => fechamentos[0] && mensagemSemanal(fechamentos[0], vinculos.length > 1 ? rotuloDe(ent.unidadeId) : {})).filter(Boolean);
      return { decisao: "CONSULTA", motivo: secoes.length ? "FECHAMENTO_DO_ENTREGADOR" : "ENTREGADOR_SEM_FECHAMENTO", resposta: secoes.join("\n\n— — —\n\n") || RESPOSTA_ENTREGADOR.semFechamento(), escopo: escopoDe(vinculos[0].unidadeId) };
    }
    // Nota: em cada empresa, a semana mais antiga que ainda aguarda nota (sem duplicidade).
    const aguardando = porVinculo.map(({ ent, fechamentos }) => ({ ent, fechamento: [...fechamentos].reverse().find((f) => AGUARDANDO.includes(f.situacaoDocumental) && !f.duplicidade) ?? null })).filter((x) => x.fechamento);
    let ent = porVinculo[0].ent, alvo = porVinculo[0].fechamentos[0] ?? null, leituraPronta = null, retomada = null;
    // O MESMO arquivo já recebido (em qualquer semana e em qualquer empresa do entregador) ⇒ repetido, nada novo. Se tinha ficado
    // pendente de anexo, retoma exatamente a mesma semana/empresa (nunca escorrega para a semana seguinte).
    if (/^[0-9a-f]{64}$/.test(evento.midia.sha256 ?? "")) {
      for (const { ent: v, fechamentos } of porVinculo) {
        const ja = (await a.notasEntregador.listar(escopoDe(v.unidadeId))).find((n) => n.entregador === v.chave && n.sha256 === evento.midia.sha256);
        if (!ja) continue;
        if (ja.estado !== "PENDENTE_ANEXO") return { decisao: "DUPLICADO", motivo: "NOTA_JA_RECEBIDA", resposta: RESPOSTA_ENTREGADOR.notaJaRecebida(), escopo: escopoDe(v.unidadeId) };
        const f = fechamentos.find((x) => x.semanaInicio === ja.semanaInicio);
        if (f) { retomada = { ent: v, fechamento: f }; break; }
      }
    }
    if (retomada) { ent = retomada.ent; alvo = retomada.fechamento; }
    else if (vinculos.length > 1) {
      const candidatos = aguardando.map((x) => ({ ...x, unidade: { ...unidadeDe(x.ent.unidadeId) }, cnpj: cnpjDe(x.ent.unidadeId) }));
      let escolha = escolherObrigacaoDaNota({ candidatos, legenda: evento.texto ?? "" });
      if (escolha.ambigua && extrator) {
        leituraPronta = await lerNota(evento, candidatos.map((c) => c.unidade.nome));
        escolha = escolherObrigacaoDaNota({ candidatos, legenda: evento.texto ?? "", leitura: leituraPronta?.leitura ?? null });
      }
      if (escolha.ambigua) {
        await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_SEM_EMPRESA", atorTipo: "SISTEMA", alvo: evento.eventoId ?? null, dados: { unidades: candidatos.map((c) => c.ent.unidadeId), semanas: candidatos.map((c) => c.fechamento.semanaInicio) } });
        return { decisao: "BLOQUEADO", motivo: "NOTA_SEM_EMPRESA_IDENTIFICADA", resposta: perguntaDeEmpresaDaNota(candidatos), escopo: null };
      }
      if (escolha.escolhida) { ent = escolha.escolhida.ent; alvo = escolha.escolhida.fechamento; }
      else alvo = null; // nenhuma empresa citada/possível aguarda nota: a recusa abaixo explica
    } else {
      alvo = aguardando[0]?.fechamento ?? porVinculo[0].fechamentos[0] ?? null;
    }
    const escopo = escopoDe(ent.unidadeId);
    const pend = pendenciaDeNota({ entregador: { chave: ent.chave, unidadeId: ent.unidadeId }, fechamento: alvo, midia: evento.midia, recebidoEm: relogio().toISOString() });
    if (!pend.ok) return { decisao: "BLOQUEADO", motivo: pend.motivo, resposta: RESPOSTA_ENTREGADOR.notaRecusada(pend.motivo), escopo };
    if (!/^[0-9a-f]{64}$/.test(evento.midia.sha256 ?? "")) return { decisao: "BLOQUEADO", motivo: "NOTA_SEM_INTEGRIDADE", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    const { nota, nova } = await a.notasEntregador.registrar({ organizacaoId: escopo.organizacaoId, unidadeId: ent.unidadeId, entregador: ent.chave, semanaInicio: alvo.semanaInicio, sha256: evento.midia.sha256, eventoId: evento.eventoId });
    if (!nova && nota.estado !== "PENDENTE_ANEXO") return { decisao: "DUPLICADO", motivo: "NOTA_JA_RECEBIDA", resposta: RESPOSTA_ENTREGADOR.notaJaRecebida(), escopo };
    const esc = { organizacaoId: escopo.organizacaoId, unidadeId: ent.unidadeId };
    // 23/11: leitura e conferência da nota (emitente, tomador, valor, período) — uma vez por nota; nunca libera nada sozinha.
    const conferencia = nota.conferencia ? { resultado: nota.conferencia, motivos: [] } : await lerEConferir(nota, alvo, evento, leituraPronta);
    if (nova) await avisarNoGrupo({ unidadeId: ent.unidadeId, tipo: "AVISO_NOTA_RECEBIDA", semanaInicio: alvo.semanaInicio, entregador: ent.chave, chave: `AVISO_NOTA|${ent.unidadeId}|${ent.chave}|${alvo.semanaInicio}|${evento.midia.sha256}`, texto: avisoDeNotaRecebida(alvo, conferencia?.resultado ?? null, rotuloDe(ent.unidadeId)) });
    const respostaLida = conferencia ? respostaDaConferencia(alvo, conferencia) : null;
    if (!operacional || !(await operacional.pode("anexarDocumentoDoEntregador", esc))) {
      await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_PENDENTE", atorTipo: "SISTEMA", alvo: nota.id, dados: { semana: alvo.semanaInicio, conferencia: conferencia?.resultado ?? null, motivo: operacional ? "SEM_CONCESSAO_OPERACIONAL" : "SEM_IDENTIDADE_OPERACIONAL" } });
      return { decisao: "PROPOSTA", motivo: "NOTA_PENDENTE_ANEXO", resposta: respostaLida ?? pend.resposta, escopo };
    }
    const bytes = await obterEvidencia(evento.midia.referencia);
    if (!bytes) return { decisao: "BLOQUEADO", motivo: "SEM_EVIDENCIA", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    try {
      const r = await operacional.chamar("anexarDocumentoDoEntregador", esc, {
        inicio: alvo.semanaInicio, entregador: ent.chave, tipoAnexo: "NOTA_FISCAL",
        arquivo: { conteudo: bytes, nome: `nfse-${alvo.semanaInicio}.${EXTENSAO_DA_NOTA[evento.midia.mime] ?? "pdf"}`, tipoMime: evento.midia.mime },
      });
      const situacao = r.situacaoDocumental ?? r.fechamento?.situacaoDocumental ?? null;
      await a.notasEntregador.concluir(nota.id, { estado: "ANEXADA", documentoId: r.documento?.id ?? null, situacaoDocumental: situacao });
      await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_ANEXADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: nota.id, dados: { semana: alvo.semanaInicio, situacao } });
      return { decisao: "EXECUTADO", motivo: "NOTA_ANEXADA", resposta: conferencia?.resultado === "DIVERGENTE" && situacao !== "LIBERADO_PAGAMENTO" ? respostaLida : RESPOSTA_ENTREGADOR.notaAnexada(alvo, situacao), escopo };
    } catch (e) {
      if (e instanceof ErroTransitorio) throw e; // fica PENDENTE_ANEXO; a nova tentativa da fila anexa
      await a.notasEntregador.concluir(nota.id, { estado: "RECUSADA", motivo: String(e?.detalhes?.motivo ?? e?.codigo ?? "RECUSADA").slice(0, 120) });
      registrar({ tipo: "MOVA_NOTA_ENTREGADOR_RECUSADA", codigo: e?.codigo ?? "ERRO" });
      return { decisao: "BLOQUEADO", motivo: "NOTA_RECUSADA_NO_FINANCEIRO", resposta: RESPOSTA_ENTREGADOR.notaRecusadaNoFinanceiro(), escopo };
    }
  }

  /** Lê a NFS-e (IA, mesmo orçamento e teto). Devolve { leitura } ou { erro } — nunca lança. Uma leitura por nota. */
  async function lerNota(evento, unidades) {
    try {
      const bruta = await extrator.extrair({ texto: evento.texto ?? "", tipo: evento.tipo ?? "documento", midia: { mime: evento.midia.mime, referencia: evento.midia.referencia }, contexto: { unidades: unidades.filter(Boolean), mensagemCitada: null } });
      const v = validarSaidaDaIa(bruta);
      if (!v.ok) return { erro: `LEITURA_INVALIDA:${v.erro}` };
      const x = v.saida;
      return { leitura: { tipoDocumento: x.tipoDocumento, legivel: x.legivel, valorCentavos: x.valorCentavos, competencia: x.competencia, dataEmissao: x.dataEmissao, favorecido: x.favorecido,
        pagador: x.pagador ?? null, documentoDestinatario: x.documentoDestinatario, identificadorDocumento: x.identificadorDocumento, confianca: x.confianca } };
    } catch (e) {
      return { erro: `LEITURA_INDISPONIVEL:${e?.codigo ?? "ERRO"}` };
    }
  }

  /** Confere a nota lida com o fechamento. Falha ou orçamento esgotado ⇒ INCONCLUSIVA (revisão humana). */
  async function lerEConferir(nota, fechamento, evento, pronta = null) {
    if (!extrator || typeof a.notasEntregador.registrarLeitura !== "function") return null;
    const lida = pronta ?? await lerNota(evento, [rotuloDe(nota.unidadeId).unidade]);
    const leitura = lida.leitura ?? null;
    const conferencia = leitura ? conferirNotaDoEntregador({ leitura, fechamento, ...rotuloDe(nota.unidadeId), cnpjTomador: cnpjDe(nota.unidadeId) }) : { resultado: "INCONCLUSIVA", motivos: [lida.erro] };
    await a.notasEntregador.registrarLeitura(nota.id, { leitura: leitura ? { ...leitura, motivos: conferencia.motivos, situacaoFiscal: "NAO_CONSULTADA" } : { motivos: conferencia.motivos }, conferencia: conferencia.resultado });
    await a.auditoria.registrar({ acao: "NOTA_ENTREGADOR_CONFERIDA", atorTipo: "SISTEMA", alvo: nota.id, dados: { semana: fechamento.semanaInicio, resultado: conferencia.resultado, motivos: conferencia.motivos } });
    return conferencia;
  }

  /**
   * 23/11: aviso à GERÊNCIA no grupo autorizado SÓ desta unidade, quando a automação de avisos dela está ligada (e não pausada).
   * Sem grupo da unidade ⇒ fica pendente (auditoria), nunca vai para o grupo de outra empresa. Cada aviso sai uma vez (chave).
   */
  async function avisarNoGrupo({ unidadeId, tipo, semanaInicio, entregador, chave, texto }) {
    const auto = await a.automacoes.obter(AUTOMACAO.AVISO_GRUPO, unidadeId);
    if (!auto || !auto.ativa || auto.pausadaEm) return false;
    const grupo = grupoDaUnidade(unidadeId);
    if (!grupo) {
      await a.auditoria.registrar({ acao: "AVISO_GRUPO_PENDENTE", atorTipo: "SISTEMA", alvo: unidadeId, dados: { tipo, semana: semanaInicio, motivo: "SEM_GRUPO_DA_UNIDADE" } });
      return false;
    }
    try {
      return await enviarUmaVez({ unidadeId, destino: grupo.grupoId, tipo, semanaInicio, entregador, chave, texto });
    } catch (e) {
      // O aviso nunca derruba o envio privado nem a nota (ex.: banco sem a migração 0016): fica pendente e registrado.
      registrar({ tipo: "MOVA_AVISO_GRUPO_FALHOU", codigo: e?.code ?? e?.codigo ?? "ERRO" });
      await a.auditoria.registrar({ acao: "AVISO_GRUPO_PENDENTE", atorTipo: "SISTEMA", alvo: unidadeId, dados: { tipo, semana: semanaInicio, motivo: "FALHA_AO_REGISTRAR" } }).catch(() => {});
      return false;
    }
  }

  /** Envia uma vez (chave única); destino = privado do entregador ou o grupo da unidade. Devolve true se entrou na fila agora. */
  async function enviarUmaVez({ ent = null, destino = null, unidadeId = null, tipo, semanaInicio, chave, texto, entregador = null }) {
    const u = unidadeDe(unidadeId ?? ent.unidadeId);
    if (!(await a.enviosEntregador.registrar({ chave, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, entregador: entregador ?? ent?.chave ?? "-", tipo, semanaInicio }))) return false;
    if (texto !== null) await a.saida.enfileirar({ grupoId: destino ?? ent.privado, respostaA: null, eventoId: null, texto, simulada: true });
    return true;
  }
  const notasDaUnidade = async (escopo) => new Map((await a.notasEntregador.listar(escopo)).map((n) => [`${n.entregador}|${n.semanaInicio}`, n]));
  const fechamentosDaUnidade = async (unidadeId) => (await porta.ler("consultarEntregadoresProprios", escopoDe(unidadeId), {})).fechamentos ?? [];

  const ativa = (auto, hora) => auto && auto.ativa && !auto.pausadaEm && hora >= auto.horario;

  /**
   * Um passo da rotina (chamado periodicamente). Idempotente: pode rodar quantas vezes for; cada mensagem sai no máximo uma vez.
   * @returns {Promise<{semanais:number, cobrancas:number, pulados:string[]}>}
   */
  async function rotina() {
    const agora = relogio();
    const { dia, hora, semana } = local(agora);
    const resumo = { semanais: 0, cobrancas: 0, avisos: 0, pulados: [] };
    const porUnidade = new Map();
    for (const e of cfg.entregadores ?? []) if (e.ativo) porUnidade.set(e.unidadeId, [...(porUnidade.get(e.unidadeId) ?? []), e]);
    // Só entregadores com conversa válida (um número que é da equipe não recebe mensagem de entregador).
    const comConversa = new Set(cfg.gruposAutorizados.filter((g) => g.entregador).map((g) => g.grupoId));
    for (const [unidadeId, lista] of porUnidade) {
      const semanal = await a.automacoes.obter(AUTOMACAO.SEMANAL, unidadeId);
      const cobranca = await a.automacoes.obter(AUTOMACAO.COBRANCA, unidadeId);
      const fazSemanal = semana === 1 && ativa(semanal, hora);
      const fazCobranca = semana === 2 && ativa(cobranca, hora); // 23/11: lembrete dos pendentes só na TERÇA
      if (!fazSemanal && !fazCobranca) continue;
      const rotulo = rotuloDe(unidadeId);
      const inicioFechado = somarDias(dia, -7 - ((semana + 6) % 7)); // segunda-feira da semana anterior
      for (const ent of lista) {
        if (!comConversa.has(ent.privado)) { resumo.pulados.push("SEM_CONVERSA"); continue; }
        try {
          if (fazSemanal) {
            let f = null;
            try { f = await porta.ler("detalharFechamentoDoEntregador", escopoDe(unidadeId), { inicio: inicioFechado, entregador: ent.chave }); } catch (e) { if (!naoEncontrado(e)) throw e; }
            const texto = f && f.entregador?.chave === ent.chave ? mensagemSemanal(f, rotulo) : null;
            if (!texto) resumo.pulados.push("SEM_FECHAMENTO");
            else if (await enviarUmaVez({ ent, tipo: "SEMANAL", semanaInicio: inicioFechado, chave: `SEMANAL|${unidadeId}|${ent.chave}|${inicioFechado}`, texto })) {
              resumo.semanais += 1;
              if (AGUARDANDO.includes(f.situacaoDocumental) && await avisarNoGrupo({ unidadeId, tipo: "AVISO_DEMONSTRATIVO", semanaInicio: inicioFechado, entregador: ent.chave, chave: `AVISO_DEMONSTRATIVO|${unidadeId}|${ent.chave}|${inicioFechado}`, texto: avisoDeDemonstrativo(f, rotulo) })) resumo.avisos = (resumo.avisos ?? 0) + 1;
            }
          }
          if (fazCobranca) {
            for (const f of await lerFechamentos(ent)) {
              // 23/11: só a semana do ciclo atual (a encerrada mais recente). Ligar a automação depois NÃO cobra semanas
              // antigas de uma vez: as pendências anteriores ficam para a equipe, na Central.
              if (f.semanaInicio < inicioFechado) { if (precisaCobrarNota(f, dia)) resumo.pulados.push("COBRANCA_DE_SEMANA_ANTIGA"); continue; }
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
    await rotinaDoGrupo({ agora, dia, hora, semana, resumo });
    return resumo;
  }

  /** Aviso de liberação e relatório de quarta no GRUPO financeiro da unidade (só unidades com grupo exclusivo). */
  async function rotinaDoGrupo({ agora, dia, hora, semana, resumo }) {
    resumo.avisos = resumo.avisos ?? 0; resumo.relatorios = 0;
    for (const u of cfg.unidades) {
      const aviso = await a.automacoes.obter(AUTOMACAO.AVISO_GRUPO, u.unidadeId);
      const relatorio = await a.automacoes.obter(AUTOMACAO.RELATORIO, u.unidadeId);
      const fazAviso = ativa(aviso, hora), fazRelatorio = semana === 3 && ativa(relatorio, hora);
      if (!fazAviso && !fazRelatorio) continue;
      const grupo = grupoDaUnidade(u.unidadeId);
      if (!grupo) { resumo.pulados.push("SEM_GRUPO_DA_UNIDADE"); continue; }
      const rotulo = rotuloDe(u.unidadeId);
      let fechamentos;
      try { fechamentos = await fechamentosDaUnidade(u.unidadeId); } catch (e) {
        resumo.pulados.push("FALHA_DE_LEITURA"); registrar({ tipo: "MOVA_ROTINA_GRUPO_FALHOU", codigo: e?.codigo ?? "ERRO" }); continue;
      }
      if (fazAviso) {
        // 1ª passada: só registra o que JÁ estava liberado (nada retroativo vai para o grupo).
        const linhaDeBase = !aviso.ultimaExecucao;
        for (const f of fechamentos.filter((x) => x.situacaoDocumental === "LIBERADO_PAGAMENTO" && !x.duplicidade)) {
          const chave = `AVISO|${u.unidadeId}|${f.entregador?.chave}|${f.semanaInicio}`;
          if (await enviarUmaVez({ unidadeId: u.unidadeId, destino: grupo.grupoId, tipo: "AVISO_LIBERACAO", semanaInicio: f.semanaInicio, entregador: f.entregador?.chave, chave, texto: linhaDeBase ? null : avisoDeLiberacao(f, rotulo) }) && !linhaDeBase) resumo.avisos += 1;
        }
        await a.automacoes.marcarExecucao(AUTOMACAO.AVISO_GRUPO, u.unidadeId, agora.toISOString());
      }
      if (fazRelatorio) {
        // Considera as semanas com vencimento até hoje (+7) ainda abertas ou pagas recentemente: o que importa nesta quarta.
        const limite = somarDias(dia, 7), desde = somarDias(dia, -21);
        const alvo = fechamentos.filter((f) => f.vencimento <= limite && f.vencimento >= desde);
        const texto = relatorioDeQuarta({ ...rotulo, unidade: rotulo.unidade ?? u.nome, fechamentos: alvo, notas: await notasDaUnidade({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }), hoje: dia });
        if (await enviarUmaVez({ unidadeId: u.unidadeId, destino: grupo.grupoId, tipo: "RELATORIO_QUARTA", semanaInicio: somarDias(dia, -9), chave: `RELATORIO|${u.unidadeId}|${dia}`, texto })) resumo.relatorios += 1;
        await a.automacoes.marcarExecucao(AUTOMACAO.RELATORIO, u.unidadeId, agora.toISOString());
      }
    }
  }

  return Object.freeze({ atender, rotina });
}
