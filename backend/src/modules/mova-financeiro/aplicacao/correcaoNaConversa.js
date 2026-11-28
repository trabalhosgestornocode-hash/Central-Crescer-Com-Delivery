// 28/11 — MOVA Operador Financeiro (fase 1): CORREÇÃO CADASTRAL de conta a pagar pela conversa, SEM IA e SEM motor financeiro novo.
// Pedido natural → unidade(s) onde a pessoa é FINANCEIRO → busca nas contas OFICIAIS (consultarContasAPagar) → uma conta inequívoca
// segue direto; várias viram opções numeradas → valor novo (pergunta se faltou) → resumo ANTES → DEPOIS com a versão vista → UMA
// confirmação autorizada ("sim" de FINANCEIRO da unidade, identidade canônica) → execução estreita (corrigir_conta_a_pagar, 0036)
// com a conta revalidada na hora → conferência pela leitura oficial → resposta com o que mudou.
// Parcelas: "a segunda parcela" altera SÓ ela; "todas as parcelas" altera a compra inteira. Sem indicação, pergunta (nunca todas por padrão).
import { CAMPO_CORRECAO, NOME_DO_CAMPO, contaCasa, interpretarPedidoDeCorrecao, rotuloDaConta, valorAtual, valorDoCampo, valorNovo } from "../dominio/correcaoDeConta.js";
import { identificarParticipante, perfilNa } from "../dominio/participantes.js";
import { respostaSimNao } from "../dominio/divergencia.js";

export const TIPO_CORRECAO = Object.freeze({ ESCOLHA: "CORRECAO_ESCOLHA", VALOR: "CORRECAO_VALOR", CONFIRMACAO: "CORRECAO_CONFIRMACAO" });
export const ehPendenciaDeCorrecao = (div) => typeof div?.tipo === "string" && div.tipo.startsWith("CORRECAO_");
const MAX_OPCOES = 9;
const FORA = ["PAGO", "PARCIALMENTE_PAGO", "CANCELADO"]; // situação da leitura oficial (EM_ABERTO, VENCIDO, AGUARDANDO_… entram)
const elegivel = (t) => !FORA.includes(t.situacao) && !(t.pagoCentavos > 0) && !t.competenciaHomologada
  && (t.natureza === "DESPESA" || (t.natureza === "PATRIMONIAL" && t.categoria?.codigo === "IMOBILIZADO"));

/**
 * @param {{cfg:object, porta:object, armazenamento:object, execucao:object|null, concluir:Function, escopoDe:Function, hoje:Function, DECISAO:object}} deps
 */
export function criarCorrecaoNaConversa({ cfg, porta, armazenamento: a, execucao, concluir, escopoDe, hoje, DECISAO }) {
  const unidadePorId = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  const lembrar = (evento, divergencia, texto, motivo, escopo = null) =>
    a.mensagens.lembrar(evento.mensagemId, { grupoId: evento.grupoId, pendente: { evento, saida: null, divergencia } })
      .then(() => concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo, escopo, resposta: texto, extra: { divergencia: divergencia.tipo } }));

  /** Contas candidatas (título oficial + unidade) para o pedido; as não elegíveis só explicam por que não. */
  async function candidatas(pedido, unidades, ids = null) {
    const achadas = [];
    for (const u of unidades) {
      let titulos;
      // unidade que o MOVA não pode LER (sem concessão de leitura) fica fora da busca — nunca derruba o pedido; falha transitória sobe
      try { titulos = await porta.contasAPagarTodas(escopoDe(u)); } catch (e) { if (/PERMISSAO|ESCOPO/.test(String(e?.codigo ?? ""))) continue; throw e; }
      for (const t of titulos) {
        if (t.situacao === "CANCELADO") continue;
        if (ids ? !ids.includes(t.id) : !contaCasa(t, pedido.termos)) continue;
        achadas.push({ t, u });
      }
    }
    return achadas;
  }

  /** Opções: parcela indicada ⇒ só ela; "todas" ⇒ a compra (um alvo por grupo); sem indicação ⇒ cada parcela + "todas" da compra. */
  function opcoes(pedido, achadas) {
    const porGrupo = new Map();
    for (const x of achadas) { const k = `${x.u.unidadeId}|${x.t.grupoId}`; if (!porGrupo.has(k)) porGrupo.set(k, []); porGrupo.get(k).push(x); }
    const lista = [];
    for (const grupo of porGrupo.values()) {
      grupo.sort((p, q) => (p.t.parcela?.numero ?? 1) - (q.t.parcela?.numero ?? 1));
      const total = grupo[0].t.parcela?.total ?? 1;
      if (pedido.parcela !== null) {
        const n = pedido.parcela === "ULTIMA" ? total : pedido.parcela;
        for (const x of grupo.filter((y) => (y.t.parcela?.numero ?? 1) === n)) lista.push({ ...x, abrangencia: "PARCELA" });
      } else if (pedido.todas || total === 1) {
        lista.push({ ...grupo[0], abrangencia: total > 1 ? "GRUPO" : "PARCELA", grupo });
      } else {
        for (const x of grupo) lista.push({ ...x, abrangencia: "PARCELA" });
        if (pedido.campo !== CAMPO_CORRECAO.VENCIMENTO) lista.push({ ...grupo[0], abrangencia: "GRUPO", grupo });
      }
    }
    return lista;
  }
  const rotulo = (o, varias) => (o.abrangencia === "GRUPO" ? `${o.t.descricao ?? "Conta"} — TODAS as ${o.t.parcela?.total} parcelas · ${o.t.fornecedor?.nome ?? "sem fornecedor"}${varias ? ` · ${o.u.nome}` : ""}` : rotuloDaConta(o.t, varias ? o.u.nome : null));

  /** Início: o texto É um pedido de correção (já conferido pelo motor). */
  async function iniciar({ evento, grupo, participante, daPessoa, pedido, unidadeContexto = null, origemCitada = null }) {
    const unidades = cfg.unidades.filter((u) => daPessoa.unidades.includes(u.unidadeId) && perfilNa(participante, u.unidadeId) === "FINANCEIRO"
      && (!unidadeContexto || u.unidadeId === unidadeContexto));
    if (!unidades.length) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CORRECAO_SEM_PERFIL_FINANCEIRO", resposta: "Só quem tem perfil FINANCEIRO na unidade pode alterar contas pelo WhatsApp." });
    if (!execucao?.corrigirContas || typeof execucao.aposCorrecaoDeConta !== "function") {
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_DE_CONTAS_DESLIGADA", resposta: "A alteração de contas pelo WhatsApp ainda não está ligada. Faça a alteração pela Central Financeira." });
    }
    if (pedido.valorInvalido) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_VALOR_INVALIDO", resposta: `Não entendi o novo ${NOME_DO_CAMPO[pedido.campo]} ("${pedido.bruto}"). ${dicaDoValor(pedido.campo)}` });
    // "nessa conta": a conta da mensagem do MOVA citada (resultado da operação que gerou a resposta)
    let ids = null;
    if (pedido.nessaConta || !pedido.termos.length) {
      if (!origemCitada?.eventoId) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_SEM_CONTA_IDENTIFICADA", resposta: "Qual conta? Cite a mensagem do MOVA sobre a conta, ou diga o nome (ex.: \"altere o vencimento da conta de energia para 15/12\")." });
      ids = [...new Set((await a.propostas.porEvento(origemCitada.eventoId)).flatMap((p) => [...(p.resultado?.obrigacaoIds ?? []), p.resultado?.obrigacaoId, p.comando?.entrada?.obrigacaoId]).filter(Boolean))];
      if (!ids.length) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_SEM_CONTA_IDENTIFICADA", resposta: "A mensagem citada não tem conta registrada. Diga o nome da conta (ex.: \"altere a observação da conta de energia\")." });
    }
    const achadas = await candidatas(pedido, unidades, ids);
    const aptas = achadas.filter((x) => elegivel(x.t));
    if (!achadas.length) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ENCONTRADA", resposta: `Não encontrei conta a pagar com "${pedido.termos.join(" ")}". Confira o nome ou faça pela Central Financeira.` });
    if (!aptas.length) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ELEGIVEL", escopo: escopoDe(achadas[0].u),
      resposta: "Essa conta não pode ser alterada pelo WhatsApp (já tem pagamento, está fechada ou é empréstimo/parcelamento/entre empresas). A alteração é pela Central Financeira." });
    const lista = opcoes(pedido, aptas);
    if (!lista.length) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_PARCELA_NAO_ENCONTRADA", resposta: `Não encontrei a parcela ${pedido.parcela === "ULTIMA" ? "última" : pedido.parcela} em aberto dessa conta.` });
    if (lista.length > MAX_OPCOES) return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_MUITAS_CONTAS", resposta: `Encontrei ${lista.length} contas com "${pedido.termos.join(" ")}". Diga mais (fornecedor, vencimento ou parcela).` });
    const pedidoGuardado = { campo: pedido.campo, valor: pedido.valor };
    if (lista.length > 1) {
      const varias = new Set(lista.map((o) => o.u.unidadeId)).size > 1;
      const alvos = lista.map((o) => ({ unidadeId: o.u.unidadeId, obrigacaoId: o.t.id, abrangencia: o.abrangencia }));
      return lembrar(evento, { tipo: TIPO_CORRECAO.ESCOLHA, pedido: pedidoGuardado, alvos, unidadesExigidas: [...new Set(alvos.map((x) => x.unidadeId))] },
        `Qual conta?\n${lista.map((o, i) => `${i + 1}. ${rotulo(o, varias)}`).join("\n")}\nResponda com o número.`, "CORRECAO_ESCOLHER_CONTA");
    }
    return seguir(evento, pedidoGuardado, { unidadeId: lista[0].u.unidadeId, obrigacaoId: lista[0].t.id, abrangencia: lista[0].abrangencia });
  }

  const dicaDoValor = (campo) => ({ vencimento: "Informe a data (ex.: 15/12).", formaPagamento: "Informe Pix, boleto, cartão, dinheiro ou transferência.", fornecedor: "Informe o nome do fornecedor." }[campo] ?? "Informe o novo texto.");

  /** Com a conta escolhida: pergunta o valor (se faltou) ou monta o resumo antes → depois e pede a confirmação. */
  async function seguir(evento, pedido, alvo) {
    const u = unidadePorId(alvo.unidadeId);
    const escopo = escopoDe(u);
    if (pedido.valor === null || pedido.valor === undefined) {
      return lembrar(evento, { tipo: TIPO_CORRECAO.VALOR, pedido, alvo, unidadeId: alvo.unidadeId },
        `Qual o novo ${NOME_DO_CAMPO[pedido.campo]}? ${dicaDoValor(pedido.campo)}`, "CORRECAO_PEDIR_VALOR", escopo);
    }
    const d = await porta.ler("detalharContaAPagar", escopo, { id: alvo.obrigacaoId });
    const t = d.titulo;
    const afetadas = alvo.abrangencia === "GRUPO" ? d.parcelas.filter((p) => p.situacao !== "CANCELADO") : [t];
    if (!afetadas.every(elegivel)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ELEGIVEL", escopo, resposta: "Essa conta mudou e não pode mais ser alterada pelo WhatsApp (pagamento, fechamento ou proteção própria). A alteração é pela Central Financeira." });
    const antes = valorAtual(t, pedido.campo);
    const depois = valorNovo(pedido.campo, pedido.valor);
    if (afetadas.every((p) => valorAtual(p, pedido.campo) === depois)) return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_SEM_MUDANCA", escopo, resposta: `Nada a alterar: o ${NOME_DO_CAMPO[pedido.campo]} já é ${depois}.` });
    const mudancas = pedido.campo === CAMPO_CORRECAO.FORNECEDOR ? { contraparteNova: { tipo: "FORNECEDOR", nome: pedido.valor } } : { [pedido.campo]: pedido.valor };
    // duplicidade: o mesmo pedido (mesma conta, mesmo campo) aguardando confirmação não vira outra proposta
    // (só se for EXATAMENTE o mesmo: mesma versão vista e mesmo valor novo; um pedido antigo com outra versão/valor é encerrado)
    let pendente = null;
    for (const p of (await a.propostas.listar(escopo)).filter((x) => x.tipo === "CORRECAO_DE_CONTA" && x.estado === "AGUARDANDO_REVISAO" && x.comando?.entrada?.obrigacaoId === alvo.obrigacaoId && x.comando?.campo === pedido.campo)) {
      if (!pendente && p.comando.entrada.versaoEsperada === t.versao && p.comando.depois === depois && p.comando.entrada.abrangencia === alvo.abrangencia) pendente = p;
      else await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
    }
    const { proposta } = pendente ? { proposta: pendente } : await a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|CORRECAO_DE_CONTA|${alvo.obrigacaoId}|${alvo.abrangencia}|${pedido.campo}|v${t.versao}|${String(pedido.valor).slice(0, 80)}`, origem: "MOVA", tipo: "CORRECAO_DE_CONTA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, esclarecidoPor: null, valorCentavos: afetadas.reduce((s, p) => s + (p.saldoCentavos ?? 0), 0), evidencia: null, leitura: null,
      comando: { operacao: "corrigirContaAPagar", campo: pedido.campo, antes, depois, rotulo: rotuloDaConta(t),
        entrada: { obrigacaoId: alvo.obrigacaoId, abrangencia: alvo.abrangencia, mudancas, versaoEsperada: t.versao, justificativa: `Alteração de ${NOME_DO_CAMPO[pedido.campo]} pedida e confirmada no WhatsApp (MOVA).` } },
    });
    if (!pendente) await a.auditoria.registrar({ acao: "PROPOSTA_CRIADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: "CORRECAO_DE_CONTA", unidadeId: escopo.unidadeId, campo: pedido.campo } });
    const quais = alvo.abrangencia === "GRUPO" ? `todas as ${afetadas.length} parcelas de ${t.descricao ?? "a conta"}` : rotuloDaConta(t);
    return lembrar(evento, { tipo: TIPO_CORRECAO.CONFIRMACAO, propostaId: proposta.id, unidadeId: alvo.unidadeId },
      `Confirma a alteração em ${u.nome}?\n${quais}\n${NOME_DO_CAMPO[pedido.campo][0].toUpperCase()}${NOME_DO_CAMPO[pedido.campo].slice(1)}: ${antes} → ${depois}\nResponda "sim" para alterar ou "não" para cancelar.`, "CORRECAO_CONFIRMAR", escopo);
  }

  /** Continuação (resposta citando a pergunta, ou resposta curta/valor na memória curta). */
  async function continuar({ evento, grupo, esclarecimento }) {
    const div = esclarecimento.divergencia;
    const texto = String(esclarecimento.texto ?? "").trim();
    const resposta = { participanteId: esclarecimento.participanteId ?? evento.participanteId, telefoneE164: esclarecimento.telefoneE164 ?? null };
    const quem = identificarParticipante(grupo, resposta);
    if (quem.conflito) {
      await a.auditoria.registrar({ acao: "IDENTIDADE_CONFLITANTE", atorTipo: "PARTICIPANTE", atorRef: resposta.participanteId, alvo: div.propostaId ?? null, dados: { fluxo: div.tipo } });
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "IDENTIDADE_CONFLITANTE", resposta: "Só quem tem perfil FINANCEIRO na unidade pode alterar contas pelo WhatsApp." });
    }
    const unidadesDaDecisao = div.unidadeId ? [div.unidadeId] : (div.unidadesExigidas ?? []);
    if (!quem.participante || !unidadesDaDecisao.every((id) => perfilNa(quem.participante, id) === "FINANCEIRO")) {
      return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CORRECAO_SEM_PERFIL_FINANCEIRO", resposta: "Só quem tem perfil FINANCEIRO na unidade pode alterar contas pelo WhatsApp." });
    }
    if (div.tipo === TIPO_CORRECAO.ESCOLHA) {
      const n = /^\s*(\d{1,2})\s*$/.exec(texto);
      const alvo = n ? div.alvos[Number(n[1]) - 1] : null;
      if (!alvo) return lembrar(evento, div, `Não entendi. Responda só com o número da conta (1 a ${div.alvos.length}).`, "CORRECAO_ESCOLHA_NAO_ENTENDIDA");
      return seguir(evento, div.pedido, alvo);
    }
    if (div.tipo === TIPO_CORRECAO.VALOR) {
      const valor = valorDoCampo(div.pedido.campo, texto, hoje());
      if (valor === null) return lembrar(evento, div, `Não entendi o novo ${NOME_DO_CAMPO[div.pedido.campo]}. ${dicaDoValor(div.pedido.campo)}`, "CORRECAO_VALOR_NAO_ENTENDIDO", escopoDe(unidadePorId(div.unidadeId)));
      return seguir(evento, { ...div.pedido, valor }, div.alvo);
    }
    // CONFIRMAÇÃO
    const u = unidadePorId(div.unidadeId);
    const escopo = escopoDe(u);
    const p = await a.propostas.obter(escopo, div.propostaId);
    if (!p || p.estado !== "AGUARDANDO_REVISAO") return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_JA_DECIDIDA", escopo, propostaId: div.propostaId, resposta: "Esse pedido de alteração já foi decidido." });
    const sim = respostaSimNao(texto);
    if (sim === null) return lembrar(evento, div, "Não entendi. Responda \"sim\" para alterar ou \"não\" para cancelar.", "CORRECAO_CONFIRMACAO_NAO_ENTENDIDA", escopo);
    if (sim === false) {
      await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
      await a.auditoria.registrar({ acao: "CORRECAO_CANCELADA", atorTipo: "PARTICIPANTE", atorRef: resposta.participanteId, alvo: p.id, dados: { campo: p.comando.campo } });
      return concluir(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CANCELADA", escopo, propostaId: p.id, resposta: "Cancelado. Nada foi alterado." });
    }
    const r = await execucao.aposCorrecaoDeConta(p, escopo, { confirmadoPor: resposta.participanteId });
    const campo = NOME_DO_CAMPO[p.comando.campo];
    if (r.situacao === "CORRIGIDA") {
      const x = r.resultado ?? {};
      if (x.semMudanca) return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: "CORRECAO_SEM_MUDANCA", escopo, propostaId: p.id, resposta: `Nada mudou: o ${campo} já era ${p.comando.depois}.` });
      const texto2 = x.conferido === false
        ? `Alteração gravada, mas a conferência não bateu. A Central Financeira vai revisar.`
        : `Feito. ${campo[0].toUpperCase()}${campo.slice(1)} alterado de ${p.comando.antes} para ${p.comando.depois} em ${x.alteradas === 1 ? "1 conta" : `${x.alteradas} parcelas`}. Conferido no Financeiro.`;
      return concluir(evento, { decisao: DECISAO.EXECUTADO, motivo: x.conferido === false ? "CORRECAO_GRAVADA_SEM_CONFERENCIA" : "CORRECAO_EXECUTADA", escopo, propostaId: p.id, resposta: texto2, extra: { confirmadoPor: resposta.participanteId } });
    }
    const motivo = r.motivo ?? r.motivos?.[0] ?? "CORRECAO_NAO_EXECUTADA";
    // falha TRANSITÓRIA: nada mudou e a confirmação continua aberta; definitiva: o pedido é encerrado (nunca fica pendurado)
    if (/INDISPONIVEL|TENTATIVAS_ESGOTADAS/.test(motivo)) return lembrar(evento, div, "Não consegui falar com o Financeiro agora. Nada foi alterado. Responda \"sim\" de novo em instantes.", `CORRECAO_NAO_EXECUTADA:${motivo}`, escopo);
    await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
    const explicacao = /CONFLITO_VERSAO/.test(motivo) ? "A conta mudou depois do resumo. Peça a alteração de novo para ver os dados atuais."
      : /COMPETENCIA/.test(motivo) ? "O período dessa conta está em fechamento. A alteração é pela Central Financeira."
        : /OPERACAO_INVALIDA|INTEGRIDADE/.test(motivo) ? "Essa conta não pode mais ser alterada pelo WhatsApp (pagamento ou proteção própria). A alteração é pela Central Financeira."
          : /DESLIGADA|SEM_CONCESSAO|SEM_IDENTIDADE/.test(motivo) ? "A alteração de contas pelo WhatsApp não está liberada para esta unidade. Faça pela Central Financeira."
            : "Não consegui alterar agora. Nada foi mudado; tente de novo ou faça pela Central Financeira.";
    return concluir(evento, { decisao: DECISAO.PROPOSTA, motivo: `CORRECAO_NAO_EXECUTADA:${motivo}`, escopo, propostaId: p.id, resposta: explicacao });
  }

  return Object.freeze({ interpretar: (texto) => interpretarPedidoDeCorrecao(texto, hoje()), iniciar, continuar });
}
