// 28/11 — MOVA Operador Financeiro (fase 1): CORREÇÃO CADASTRAL de conta a pagar pela conversa, SEM IA e SEM motor financeiro novo.
// Pedido natural → unidade(s) onde a pessoa é FINANCEIRO → busca nas contas OFICIAIS (consultarContasAPagar) → uma conta inequívoca
// segue direto; várias viram opções numeradas → valor novo (pergunta se faltou) → resumo ANTES → DEPOIS com a versão vista → UMA
// confirmação autorizada ("sim" de FINANCEIRO da unidade, identidade canônica) → execução estreita (corrigir_conta_a_pagar, 0036)
// com a conta revalidada na hora → conferência pela leitura oficial → resposta com o que mudou.
// Parcelas: "a segunda parcela" altera SÓ ela; "todas as parcelas" altera a compra inteira. Sem indicação, pergunta (nunca todas por padrão).
import { CAMPOS_DA_FASE_2, CAMPO_CORRECAO, NOME_DO_CAMPO, contaCasa, interpretarPedidoDeCorrecao, rotuloDaConta, valorAtual, valorDoCampo, valorNovo } from "../dominio/correcaoDeConta.js";
import { identificarParticipante, perfilNa } from "../dominio/participantes.js";
import { respostaSimNao } from "../dominio/divergencia.js";
import { createHash } from "node:crypto";

export const TIPO_CORRECAO = Object.freeze({ ESCOLHA: "CORRECAO_ESCOLHA", VALOR: "CORRECAO_VALOR", JUSTIFICATIVA: "CORRECAO_JUSTIFICATIVA", CONFIRMACAO: "CORRECAO_CONFIRMACAO" });
export const ehPendenciaDeCorrecao = (div) => typeof div?.tipo === "string" && div.tipo.startsWith("CORRECAO_");
const MAX_OPCOES = 9;
const FORA = ["PAGO", "PARCIALMENTE_PAGO", "CANCELADO"]; // situação da leitura oficial (EM_ABERTO, VENCIDO, AGUARDANDO_… entram)
const naturezaOk = (t) => t.natureza === "DESPESA" || (t.natureza === "PATRIMONIAL" && t.categoria?.codigo === "IMOBILIZADO");
const elegivel = (t) => !FORA.includes(t.situacao) && !(t.pagoCentavos > 0) && !t.competenciaHomologada && naturezaOk(t);
// 28/11 (fase 2): o valor também se corrige com pagamento PARCIAL (nunca abaixo do pago); a categoria vale para a compra mesmo com pagamento
const elegivelPara = (campo, t) => campo === "valor" ? !["PAGO", "CANCELADO"].includes(t.situacao) && !t.competenciaHomologada && naturezaOk(t)
  : campo === "categoria" ? t.situacao !== "CANCELADO" && !t.competenciaHomologada && naturezaOk(t) : elegivel(t);
const reais = (c) => "R$ " + (Number(c ?? 0) / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const mesBr = (c) => (c ? c.slice(5, 7) + "/" + c.slice(0, 4) : "—");
const dataBr = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "—");
const sem = (x) => String(x ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * @param {{cfg:object, porta:object, armazenamento:object, execucao:object|null, concluir:Function, escopoDe:Function, hoje:Function, DECISAO:object, rotear?:Function}} deps
 */
export function criarCorrecaoNaConversa({ cfg, porta, armazenamento: a, execucao, concluir, escopoDe, hoje, DECISAO, rotear = null }) {
  const unidadePorId = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  /**
   * Canal da conversa de correção: as mensagens levam dados da conta (fornecedor, valores, vencimento, observação) e seguem a MESMA
   * regra das demais operações financeiras (DOCUMENTO_COM_VALOR): no grupo só quando a política e o retrato dos membros permitem;
   * senão no privado de quem fala (no grupo, só o aviso). A pergunta pendente fica na conversa em que saiu.
   */
  function canal({ grupo, participante, unidades, quem = null }) {
    // `us` = as unidades das contas que ESTA mensagem mostra ([] = mensagem sem dado de conta). Detalhe por conta/fornecedor no grupo
    // só com TODOS os membros FINANCEIRO nessas unidades (mesma regra das consultas detalhadas); senão, privado.
    const privadoDe = async (evento, us = unidades) => {
      if (!rotear || !grupo) return null;
      const e = quem ? { ...evento, participanteId: quem } : evento;
      const r = await rotear(grupo, participante, e, us);
      if (!r || r.noGrupo) return null;
      return { destino: r.destino ?? null, aviso: "Os detalhes da conta foram para o seu privado.", avisoSemPrivado: "Os dados dessa conta não aparecem no grupo. Peça pelo privado do MOVA ou faça pela Central Financeira.", recusar: r.recusar === true };
    };
    const fim = async (evento, opts, us = unidades) => {
      const privado = await privadoDe(evento, us);
      if (privado?.recusar) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CORRECAO_DADOS_FORA_DO_GRUPO", escopo: opts.escopo ?? null, resposta: "Os dados dessa conta não podem ser mostrados nesta conversa. Peça pelo privado do MOVA." });
      return concluir(evento, { ...opts, privado });
    };
    const lembrar = async (evento, divergencia, texto, motivo, escopo = null, us = unidades) => {
      const privado = await privadoDe(evento, us);
      if (privado?.recusar) return fim(evento, { escopo }, us);
      await a.mensagens.lembrar(evento.mensagemId, { grupoId: privado?.destino ?? evento.grupoId, pendente: { evento, saida: null, divergencia } });
      return concluir(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo, escopo, resposta: texto, extra: { divergencia: divergencia.tipo }, privado });
    };
    return { fim, lembrar };
  }

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
      // fase 2: categoria e competência são da COMPRA inteira; valor é de UMA parcela (nunca "todas")
      if (pedido.campo === CAMPO_CORRECAO.CATEGORIA || pedido.campo === CAMPO_CORRECAO.COMPETENCIA) { lista.push({ ...grupo[0], abrangencia: "GRUPO", grupo, daCompra: true }); continue; }
      if (pedido.campo === CAMPO_CORRECAO.VALOR && pedido.parcela === null) { for (const x of grupo) lista.push({ ...x, abrangencia: "PARCELA" }); continue; }
      if (pedido.parcela !== null) {
        const n = pedido.parcela === "ULTIMA" ? total : pedido.parcela;
        for (const x of grupo.filter((y) => (y.t.parcela?.numero ?? 1) === n)) lista.push({ ...x, abrangencia: "PARCELA" });
      } else if (pedido.todas || total === 1) {
        lista.push({ ...grupo[0], abrangencia: total > 1 ? "GRUPO" : "PARCELA", grupo });
      } else {
        for (const x of grupo) lista.push({ ...x, abrangencia: "PARCELA" });
        if (pedido.campo !== CAMPO_CORRECAO.VENCIMENTO) lista.push({ ...grupo[0], abrangencia: "GRUPO", grupo, daCompra: pedido.campo === CAMPO_CORRECAO.CANCELAR });
      }
    }
    return lista;
  }
  const rotulo = (o, varias) => (o.abrangencia === "GRUPO" ? `${o.t.descricao ?? "Conta"} — ${o.daCompra ? "a compra inteira" : "TODAS as"} ${o.daCompra ? `(${o.t.parcela?.total ?? 1} parcela(s))` : `${o.t.parcela?.total} parcelas`} · ${o.t.fornecedor?.nome ?? "sem fornecedor"}${varias ? ` · ${o.u.nome}` : ""}` : rotuloDaConta(o.t, varias ? o.u.nome : null));

  /** Início: o texto É um pedido de correção (já conferido pelo motor). */
  async function iniciar({ evento, grupo, participante, daPessoa, pedido, unidadeContexto = null, origemCitada = null }) {
    const unidades = cfg.unidades.filter((u) => daPessoa.unidades.includes(u.unidadeId) && perfilNa(participante, u.unidadeId) === "FINANCEIRO"
      && (!unidadeContexto || u.unidadeId === unidadeContexto));
    const saida = canal({ grupo, participante, unidades: [] });
    if (!unidades.length) return concluir(evento, { decisao: DECISAO.BLOQUEADO, motivo: "CORRECAO_SEM_PERFIL_FINANCEIRO", resposta: "Só quem tem perfil FINANCEIRO na unidade pode alterar contas pelo WhatsApp." });
    const fase2 = CAMPOS_DA_FASE_2.includes(pedido.campo);
    if ((fase2 ? !execucao?.operarContas : !execucao?.corrigirContas) || typeof execucao.aposCorrecaoDeConta !== "function") {
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
    const aptas = achadas.filter((x) => elegivelPara(pedido.campo, x.t));
    if (!achadas.length) return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ENCONTRADA", resposta: `Não encontrei conta a pagar com "${pedido.termos.join(" ")}". Confira o nome ou faça pela Central Financeira.` });
    if (!aptas.length) return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ELEGIVEL", escopo: escopoDe(achadas[0].u),
      resposta: "Essa conta não pode ser alterada pelo WhatsApp (já tem pagamento, está fechada ou é empréstimo/parcelamento/entre empresas). A alteração é pela Central Financeira." }, [...new Set(achadas.map((x) => x.u.unidadeId))]);
    const lista = opcoes(pedido, aptas);
    if (!lista.length) return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_PARCELA_NAO_ENCONTRADA", resposta: `Não encontrei a parcela ${pedido.parcela === "ULTIMA" ? "última" : pedido.parcela} em aberto dessa conta.` });
    if (lista.length > MAX_OPCOES) return saida.fim(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_MUITAS_CONTAS", resposta: `Encontrei ${lista.length} contas com "${pedido.termos.join(" ")}". Diga mais (fornecedor, vencimento ou parcela).` });
    const pedidoGuardado = { campo: pedido.campo, valor: pedido.valor, ...(pedido.justificativa ? { justificativa: pedido.justificativa } : {}) };
    if (lista.length > 1) {
      const varias = new Set(lista.map((o) => o.u.unidadeId)).size > 1;
      const alvos = lista.map((o) => ({ unidadeId: o.u.unidadeId, obrigacaoId: o.t.id, abrangencia: o.abrangencia }));
      return saida.lembrar(evento, { tipo: TIPO_CORRECAO.ESCOLHA, pedido: pedidoGuardado, alvos, unidadesExigidas: [...new Set(alvos.map((x) => x.unidadeId))] },
        `Qual conta?\n${lista.map((o, i) => `${i + 1}. ${rotulo(o, varias)}`).join("\n")}\nResponda com o número.`, "CORRECAO_ESCOLHER_CONTA", null, [...new Set(alvos.map((x) => x.unidadeId))]);
    }
    return seguir(evento, pedidoGuardado, { unidadeId: lista[0].u.unidadeId, obrigacaoId: lista[0].t.id, abrangencia: lista[0].abrangencia }, saida);
  }

  const dicaDoValor = (campo) => ({ valor: "Informe o valor correto (ex.: 325,00).", competencia: "Informe o mês (ex.: novembro/2026).", categoria: "Informe a categoria como aparece no Dashboard.", vencimento: "Informe a data (ex.: 15/12).", formaPagamento: "Informe Pix, boleto, cartão, dinheiro ou transferência.", fornecedor: "Informe o nome do fornecedor." }[campo] ?? "Informe o novo texto.");

  /** Com a conta escolhida: pergunta o valor (se faltou) ou monta o resumo antes → depois e pede a confirmação. */
  async function seguir(evento, pedido, alvo, saidaBase, aviso = null) {
    const u = unidadePorId(alvo.unidadeId);
    const saida = { fim: (e, o) => saidaBase.fim(e, o, [alvo.unidadeId]), lembrar: (e, d, t, m, esc) => saidaBase.lembrar(e, d, t, m, esc, [alvo.unidadeId]) };
    const escopo = escopoDe(u);
    if (pedido.valor === null || pedido.valor === undefined) {
      return saida.lembrar(evento, { tipo: TIPO_CORRECAO.VALOR, pedido, alvo, unidadeId: alvo.unidadeId },
        `Qual o novo ${NOME_DO_CAMPO[pedido.campo]}? ${dicaDoValor(pedido.campo)}`, "CORRECAO_PEDIR_VALOR", escopo);
    }
    if (CAMPOS_DA_FASE_2.includes(pedido.campo)) return seguirFase2(evento, pedido, alvo, saida, u, escopo, aviso);
    const d = await porta.ler("detalharContaAPagar", escopo, { id: alvo.obrigacaoId });
    const t = d.titulo;
    const afetadas = alvo.abrangencia === "GRUPO" ? d.parcelas.filter((p) => p.situacao !== "CANCELADO") : [t];
    if (!afetadas.every(elegivel)) return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ELEGIVEL", escopo, resposta: "Essa conta mudou e não pode mais ser alterada pelo WhatsApp (pagamento, fechamento ou proteção própria). A alteração é pela Central Financeira." });
    const antesPorParcela = afetadas.map((p) => ({ n: p.parcela?.numero ?? 1, total: p.parcela?.total ?? 1, antes: valorAtual(p, pedido.campo) }));
    const antesDiferentes = new Set(antesPorParcela.map((x) => x.antes)).size > 1;
    const antes = antesDiferentes ? "(varia por parcela)" : antesPorParcela[0].antes;
    // GRUPO: a versão de CADA parcela vista agora vai junto; o núcleo recusa se o conjunto ou qualquer versão mudar
    const versoes = alvo.abrangencia === "GRUPO" ? Object.fromEntries(afetadas.map((p) => [p.id, p.versao])) : null;
    const depois = valorNovo(pedido.campo, pedido.valor);
    if (afetadas.every((p) => valorAtual(p, pedido.campo) === depois)) return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_SEM_MUDANCA", escopo, resposta: `Nada a alterar: o ${NOME_DO_CAMPO[pedido.campo]} já é ${depois}.` });
    const mudancas = pedido.campo === CAMPO_CORRECAO.FORNECEDOR ? { contraparteNova: { tipo: "FORNECEDOR", nome: pedido.valor } } : { [pedido.campo]: pedido.valor };
    // duplicidade: o mesmo pedido (mesma conta, mesmo campo) aguardando confirmação não vira outra proposta
    // (só se for EXATAMENTE o mesmo: mesma versão vista e mesmo valor novo; um pedido antigo com outra versão/valor é encerrado)
    let pendente = null;
    for (const p of (await a.propostas.listar(escopo)).filter((x) => x.tipo === "CORRECAO_DE_CONTA" && x.estado === "AGUARDANDO_REVISAO" && x.comando?.entrada?.obrigacaoId === alvo.obrigacaoId && x.comando?.campo === pedido.campo)) {
      if (!pendente && p.comando.entrada.versaoEsperada === t.versao && p.comando.depois === depois && p.comando.entrada.abrangencia === alvo.abrangencia
        && JSON.stringify(p.comando.entrada.versoes ?? null) === JSON.stringify(versoes)) pendente = p;
      else await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
    }
    const { proposta } = pendente ? { proposta: pendente } : await a.propostas.criar(escopo, {
      chaveIdempotencia: `${evento.eventoId}|CORRECAO_DE_CONTA|${alvo.obrigacaoId}|${alvo.abrangencia}|${pedido.campo}|v${t.versao}|${String(pedido.valor).slice(0, 80)}`, origem: "MOVA", tipo: "CORRECAO_DE_CONTA", eventoId: evento.eventoId, mensagemId: evento.mensagemId,
      participanteId: evento.participanteId, esclarecidoPor: null, valorCentavos: afetadas.reduce((s, p) => s + (p.saldoCentavos ?? 0), 0), evidencia: null, leitura: null,
      comando: { operacao: "corrigirContaAPagar", campo: pedido.campo, antes, depois, antesPorParcela, rotulo: rotuloDaConta(t), pedido, alvo,
        entrada: { obrigacaoId: alvo.obrigacaoId, abrangencia: alvo.abrangencia, mudancas, versaoEsperada: t.versao, ...(versoes ? { versoes } : {}), justificativa: `Alteração de ${NOME_DO_CAMPO[pedido.campo]} pedida e confirmada no WhatsApp (MOVA).` } },
    });
    if (!pendente) await a.auditoria.registrar({ acao: "PROPOSTA_CRIADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: "CORRECAO_DE_CONTA", unidadeId: escopo.unidadeId, campo: pedido.campo } });
    const quais = alvo.abrangencia === "GRUPO" ? `todas as ${afetadas.length} parcelas de ${t.descricao ?? "a conta"}` : rotuloDaConta(t);
    const Campo = `${NOME_DO_CAMPO[pedido.campo][0].toUpperCase()}${NOME_DO_CAMPO[pedido.campo].slice(1)}`;
    const linhas = antesDiferentes ? antesPorParcela.map((x) => `Parcela ${x.n}/${x.total} — ${Campo}: ${x.antes} → ${depois}`).join("\n") : `${Campo}: ${antes} → ${depois}`;
    return saida.lembrar(evento, { tipo: TIPO_CORRECAO.CONFIRMACAO, propostaId: proposta.id, unidadeId: alvo.unidadeId },
      `${aviso ? aviso + "\n" : ""}Confirma a alteração em ${u.nome}?\n${quais}\n${linhas}\nResponda "sim" para alterar ou "não" para cancelar.`, "CORRECAO_CONFIRMAR", escopo);
  }

  /** Plano de contas da unidade (árvore achatada), só leitura. */
  async function planoDe(escopo) {
    try {
      const p = await porta.ler("consultarPlanoDeContas", escopo, undefined);
      const plano = []; const visitar = (xs) => { for (const c of xs ?? []) { plano.push(c); visitar(c?.filhas); } };
      visitar(Array.isArray(p) ? p : p?.categorias ?? p?.itens ?? []);
      return plano;
    } catch { return []; }
  }

  /**
   * FASE 2 (0037): monta o resumo com o EFEITO na DRE e a entrada exata da operação do núcleo (com as versões vistas agora).
   * Compra com pagamento/ajuste/parcela cancelada que torne a operação ambígua ⇒ explica e manda para a Central (revisão humana).
   */
  async function seguirFase2(evento, pedido, alvo, saida, u, escopo, aviso = null) {
    const d = await porta.ler("detalharContaAPagar", escopo, { id: alvo.obrigacaoId });
    const t = d.titulo; const l = d.lancamento;
    const todas = d.parcelas ?? [t];
    const vivas = todas.filter((x) => x.situacao !== "CANCELADO");
    const desc = t.descricao ?? "a conta";
    const naoPode = (motivo) => saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CONTA_NAO_ELEGIVEL", escopo, resposta: motivo + " A alteração é pela Central Financeira (revisão humana)." });
    const nada = (texto) => saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_SEM_MUDANCA", escopo, resposta: texto });
    const padrao = (o) => o + " pedido e confirmado no WhatsApp (MOVA).";
    const doLancamento = l?.id ? { [l.id]: l.versao } : {};
    // a NATUREZA da compra decide o que muda: despesa está na DRE; equipamento (IMOBILIZADO) é patrimonial e NÃO entra na DRE
    const equipamento = l.natureza === "PATRIMONIAL";
    const naDre = (frase) => (equipamento ? "Não afeta a DRE: compra de equipamento (patrimonial, " + (t.categoria?.nome ?? l.categoria) + ")." : "Na DRE de " + mesBr(l.competencia) + ": " + frase + ".");
    const semCaixa = "Caixa realizado e pagamentos feitos não mudam.";
    // valor e cancelamento exigem a justificativa REAL de quem pediu (fica no histórico): sem ela, pergunta antes do resumo
    if ([CAMPO_CORRECAO.VALOR, CAMPO_CORRECAO.CANCELAR].includes(pedido.campo) && !pedido.justificativa) {
      return saida.lembrar(evento, { tipo: TIPO_CORRECAO.JUSTIFICATIVA, pedido, alvo, unidadeId: alvo.unidadeId },
        (aviso ? aviso + "\n" : "") + "Qual o motivo " + (pedido.campo === CAMPO_CORRECAO.VALOR ? "da correção do valor" : "do cancelamento") + "? Fica registrado no histórico da conta.", "CORRECAO_PEDIR_JUSTIFICATIVA", escopo);
    }
    let operacao; let entrada; let antes; let depois; let resumo; let feito; let valorCentavos;
    if (pedido.campo === CAMPO_CORRECAO.CATEGORIA) {
      if (todas.some((x) => x.situacao === "CANCELADO" || x.ajustesCentavos)) return naoPode("Essa compra tem parcela cancelada ou ajuste de valor.");
      const alvoTxt = sem(pedido.valor);
      const cands = (await planoDe(escopo)).filter((c) => c.aceitaLancamento !== false && c.ativa !== false && !/A_CLASSIFICAR$/.test(c.codigo ?? "")
        && (c.natureza === "DESPESA" || c.codigo === "IMOBILIZADO"));
      const exatas = cands.filter((c) => sem(c.nome) === alvoTxt || sem(c.codigo).replace(/_/g, " ") === alvoTxt);
      const achadas = exatas.length ? exatas : cands.filter((c) => sem(c.nome).includes(alvoTxt) || (alvoTxt.length >= 5 && alvoTxt.includes(sem(c.nome))));
      if (achadas.length !== 1) {
        return saida.fim(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_CATEGORIA_INDEFINIDA", escopo,
          resposta: achadas.length ? "Qual categoria? " + achadas.slice(0, 6).map((c) => c.nome).join(" · ") + ". Repita o pedido com o nome exato." : "Não encontrei a categoria \"" + pedido.valor + "\" no plano de contas de " + u.nome + ". Use o nome como aparece no Dashboard." });
      }
      const nova = achadas[0];
      if (nova.codigo === l.categoria) return nada("Nada a alterar: a compra já está em " + nova.nome + ".");
      antes = t.categoria?.nome ?? l.categoria; depois = nova.nome;
      const efeito = l.natureza === nova.natureza
        ? (equipamento ? "Não afeta a DRE (as duas categorias são patrimoniais)." : "Na DRE de " + mesBr(l.competencia) + ": " + reais(l.valorCentavos) + " sai de " + antes + " e entra em " + depois + " (o resultado total não muda).")
        : nova.natureza === "PATRIMONIAL" ? "Na DRE de " + mesBr(l.competencia) + ": a despesa de " + reais(l.valorCentavos) + " sai do resultado; a compra passa a ser equipamento (patrimonial)."
          : "Na DRE de " + mesBr(l.competencia) + ": " + reais(l.valorCentavos) + " passa a ser despesa em " + depois + " (antes era equipamento, fora da DRE).";
      operacao = "reclassificarContaAPagar"; valorCentavos = l.valorCentavos;
      entrada = { obrigacaoId: alvo.obrigacaoId, categoria: nova.codigo, versoes: { ...Object.fromEntries(todas.map((x) => [x.id, x.versao])), ...doLancamento }, justificativa: pedido.justificativa || padrao("Reclassificação da compra") };
      resumo = "Categoria da compra " + desc + " (" + reais(l.valorCentavos) + (todas.length > 1 ? " em " + todas.length + " parcelas" : "") + "): " + antes + " → " + depois + ".\n" + efeito
        + "\nContas a pagar, vencimentos e fluxo de caixa previsto não mudam. " + semCaixa;
      feito = "Categoria da compra " + desc + " alterada de " + antes + " para " + depois + ".";
    } else if (pedido.campo === CAMPO_CORRECAO.VALOR) {
      const original = t.valorOriginalCentavos; const atual = original + (t.ajustesCentavos ?? 0); const novo = pedido.valor; const dif = novo - atual;
      const pago = t.pagoCentavos ?? 0; const saldoAntes = t.saldoCentavos ?? atual - pago; const saldoDepois = novo - pago;
      if (dif === 0) return nada("Nada a alterar: o valor já é " + reais(novo) + ".");
      if (novo <= pago) return naoPode("O novo valor não pode ser igual ou menor que o já pago (" + reais(pago) + ").");
      antes = reais(atual); depois = reais(novo);
      const sinal = (v) => (v > 0 ? "+" : "−") + reais(Math.abs(v));
      operacao = "ajustarValorDeContaAPagar"; valorCentavos = Math.abs(dif);
      entrada = { obrigacaoId: alvo.obrigacaoId, valorCorretoCentavos: novo, versaoEsperada: t.versao, versaoLancamento: l.versao, justificativa: pedido.justificativa };
      resumo = rotuloDaConta(t)
        + "\nValor original: " + reais(original) + " · valor atual: " + reais(atual) + " · novo valor: " + reais(novo) + " (diferença " + sinal(dif) + ")"
        + "\nJá pago: " + reais(pago) + " · saldo anterior: " + reais(saldoAntes) + " · novo saldo: " + reais(saldoDepois)
        + "\nJustificativa: " + pedido.justificativa
        + "\nImpacto: " + naDre((dif > 0 ? "a despesa aumenta " : "a despesa diminui ") + reais(Math.abs(dif)) + " em " + (t.categoria?.nome ?? l.categoria))
        + " Contas a pagar e fluxo de caixa previsto (vencimento " + dataBr(t.vencimento) + "): " + sinal(dif) + ". " + semCaixa
        + "\nO valor original fica registrado; a diferença entra como ajuste auditado.";
      feito = "Valor da parcela " + (t.parcela?.numero ?? 1) + "/" + (t.parcela?.total ?? 1) + " de " + desc + " corrigido de " + antes + " para " + depois + " (ajuste de " + sinal(dif) + "; novo saldo " + reais(saldoDepois) + ").";
    } else if (pedido.campo === CAMPO_CORRECAO.COMPETENCIA) {
      if (!todas.every((x) => elegivel(x) && !x.ajustesCentavos)) return naoPode("Essa compra tem pagamento, ajuste ou parcela cancelada.");
      if (pedido.valor === l.competencia) return nada("Nada a alterar: a competência já é " + mesBr(l.competencia) + ".");
      antes = mesBr(l.competencia); depois = mesBr(pedido.valor);
      operacao = "moverCompetenciaDeContaAPagar"; valorCentavos = l.valorCentavos;
      entrada = { obrigacaoId: alvo.obrigacaoId, competencia: pedido.valor, versoes: { ...Object.fromEntries(todas.map((x) => [x.id, x.versao])), ...doLancamento }, justificativa: pedido.justificativa || padrao("Mudança de competência " + antes + " → " + depois) };
      resumo = "Competência da compra " + desc + " (" + reais(l.valorCentavos) + "): " + antes + " → " + depois + "."
        + "\n" + (equipamento ? "Não afeta a DRE (compra de equipamento, patrimonial): muda só o mês de referência." : "Na DRE: " + reais(l.valorCentavos) + " sai de " + antes + " e entra em " + depois + ".")
        + "\nContas a pagar, vencimentos e fluxo de caixa previsto não mudam. " + semCaixa;
      feito = "Competência da compra " + desc + " alterada de " + antes + " para " + depois + ".";
    } else if (alvo.abrangencia === "PARCELA" && vivas.length < 2) {
      // a ÚLTIMA parcela restante: cancelar ela é cancelar a compra — nunca converte sozinho; pede a autorização específica
      return saida.fim(evento, { decisao: DECISAO.PEDIR_INFORMACAO, motivo: "CORRECAO_ULTIMA_PARCELA", escopo,
        resposta: "A parcela " + t.parcela.numero + "/" + t.parcela.total + " é a única que resta em aberto de " + desc + ": cancelar ela é cancelar a compra inteira. Se é isso, peça \"cancele a compra " + desc + "\". Nada foi alterado." });
    } else if (alvo.abrangencia === "GRUPO") {
      if (!vivas.every(elegivel)) return naoPode("Essa compra tem pagamento (o estorno e o cancelamento são tratados na Central).");
      const total = vivas.reduce((x, y) => x + y.valorOriginalCentavos + (y.ajustesCentavos ?? 0), 0);
      operacao = "cancelarContaAPagar"; valorCentavos = total; antes = "ativa"; depois = "cancelada";
      entrada = { obrigacaoId: alvo.obrigacaoId, abrangencia: "GRUPO", versoes: { ...Object.fromEntries(vivas.map((x) => [x.id, x.versao])), ...doLancamento }, justificativa: pedido.justificativa };
      resumo = (todas.length > 1 ? "Cancelar a compra inteira " + desc + ": " + vivas.length + " parcela(s) em aberto" : "Cancelar a conta " + desc) + " (" + reais(total) + ")."
        + "\nJustificativa: " + pedido.justificativa
        + "\nImpacto: " + naDre("a despesa de " + reais(total) + " sai do resultado") + " Contas a pagar e fluxo de caixa previsto: −" + reais(total) + ". " + semCaixa
        + "\nNada é apagado: a compra e as parcelas ficam no histórico como canceladas.";
      feito = (todas.length > 1 ? "Compra " + desc + " cancelada (" + vivas.length + " parcela(s))" : "Conta " + desc + " cancelada") + ".";
    } else {
      if (!elegivel(t)) return naoPode("Essa parcela tem pagamento ou já está cancelada.");
      const v = t.valorOriginalCentavos + (t.ajustesCentavos ?? 0);
      operacao = "cancelarContaAPagar"; valorCentavos = v; antes = "ativa"; depois = "cancelada";
      entrada = { obrigacaoId: alvo.obrigacaoId, abrangencia: "PARCELA", versoes: { [t.id]: t.versao, ...doLancamento }, justificativa: pedido.justificativa };
      resumo = "Cancelar a parcela " + t.parcela.numero + "/" + t.parcela.total + " de " + desc + " (" + reais(v) + ", vence " + dataBr(t.vencimento) + "). As outras parcelas continuam."
        + "\nJustificativa: " + pedido.justificativa
        + "\nImpacto: " + naDre("a despesa diminui " + reais(v) + " (ajuste auditado)") + " Contas a pagar e fluxo de caixa previsto (" + dataBr(t.vencimento) + "): −" + reais(v) + ". " + semCaixa
        + "\nNada é apagado: a compra original fica registrada e a parcela fica cancelada no histórico.";
      feito = "Parcela " + t.parcela.numero + "/" + t.parcela.total + " de " + desc + " cancelada; as outras continuam.";
    }
    if (aviso) resumo = aviso + "\n" + resumo;
    // duplicidade: o MESMO pedido aguardando confirmação (mesma entrada) não vira outra proposta; um antigo diferente é encerrado
    let pendente = null;
    for (const x of (await a.propostas.listar(escopo)).filter((y) => y.tipo === "CORRECAO_DE_CONTA" && y.estado === "AGUARDANDO_REVISAO" && y.comando?.entrada?.obrigacaoId === alvo.obrigacaoId && y.comando?.campo === pedido.campo)) {
      if (!pendente && JSON.stringify(x.comando.entrada) === JSON.stringify(entrada)) pendente = x;
      else await a.propostas.transicionar(escopo, x.id, "AGUARDANDO_REVISAO", "REJEITADA");
    }
    const { proposta } = pendente ? { proposta: pendente } : await a.propostas.criar(escopo, {
      chaveIdempotencia: evento.eventoId + "|CORRECAO_DE_CONTA|" + operacao + "|" + alvo.obrigacaoId + "|" + createHash("sha256").update(JSON.stringify(entrada)).digest("hex").slice(0, 24) + "|" + String(pedido.valor).slice(0, 40) + "|" + (entrada.abrangencia ?? ""),
      origem: "MOVA", tipo: "CORRECAO_DE_CONTA", eventoId: evento.eventoId, mensagemId: evento.mensagemId, participanteId: evento.participanteId, esclarecidoPor: null,
      valorCentavos: Math.max(1, valorCentavos ?? 1), evidencia: null, leitura: null,
      comando: { operacao, campo: pedido.campo, antes, depois, resumo, feito, rotulo: rotuloDaConta(t), entrada, pedido, alvo },
    });
    if (!pendente) await a.auditoria.registrar({ acao: "PROPOSTA_CRIADA", atorTipo: "PARTICIPANTE", atorRef: evento.participanteId, alvo: proposta.id, dados: { tipo: "CORRECAO_DE_CONTA", operacao, unidadeId: escopo.unidadeId, campo: pedido.campo } });
    return saida.lembrar(evento, { tipo: TIPO_CORRECAO.CONFIRMACAO, propostaId: proposta.id, unidadeId: alvo.unidadeId },
      "Confirma em " + u.nome + "?\n" + resumo + "\nResponda \"sim\" para confirmar ou \"não\" para desistir.", "CORRECAO_CONFIRMAR", escopo);
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
    const saida = canal({ grupo, participante: quem.participante, unidades: unidadesDaDecisao, quem: resposta.participanteId });
    if (div.tipo === TIPO_CORRECAO.ESCOLHA) {
      const n = /^\s*(\d{1,2})\s*$/.exec(texto);
      const alvo = n ? div.alvos[Number(n[1]) - 1] : null;
      if (!alvo) return saida.lembrar(evento, div, `Não entendi. Responda só com o número da conta (1 a ${div.alvos.length}).`, "CORRECAO_ESCOLHA_NAO_ENTENDIDA");
      return seguir(evento, div.pedido, alvo, saida);
    }
    if (div.tipo === TIPO_CORRECAO.JUSTIFICATIVA) {
      const j = texto.replace(/\s+/g, " ").trim();
      if (j.length < 4 || j.length > 300) return saida.lembrar(evento, div, "Escreva o motivo em uma frase (ex.: \"o frete foi cobrado à parte\").", "CORRECAO_JUSTIFICATIVA_NAO_ENTENDIDA", escopoDe(unidadePorId(div.unidadeId)));
      return seguir(evento, { ...div.pedido, justificativa: j }, div.alvo, saida);
    }
    if (div.tipo === TIPO_CORRECAO.VALOR) {
      const valor = valorDoCampo(div.pedido.campo, texto, hoje());
      if (valor === null) return saida.lembrar(evento, div, `Não entendi o novo ${NOME_DO_CAMPO[div.pedido.campo]}. ${dicaDoValor(div.pedido.campo)}`, "CORRECAO_VALOR_NAO_ENTENDIDO", escopoDe(unidadePorId(div.unidadeId)));
      return seguir(evento, { ...div.pedido, valor }, div.alvo, saida);
    }
    // CONFIRMAÇÃO
    const u = unidadePorId(div.unidadeId);
    const escopo = escopoDe(u);
    const p = await a.propostas.obter(escopo, div.propostaId);
    if (!p || p.estado !== "AGUARDANDO_REVISAO") return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_JA_DECIDIDA", escopo, propostaId: div.propostaId, resposta: "Esse pedido de alteração já foi decidido." });
    const sim = respostaSimNao(texto);
    if (sim === null) return saida.lembrar(evento, div, "Não entendi. Responda \"sim\" para alterar ou \"não\" para cancelar.", "CORRECAO_CONFIRMACAO_NAO_ENTENDIDA", escopo);
    if (sim === false) {
      await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
      await a.auditoria.registrar({ acao: "CORRECAO_CANCELADA", atorTipo: "PARTICIPANTE", atorRef: resposta.participanteId, alvo: p.id, dados: { campo: p.comando.campo } });
      return saida.fim(evento, { decisao: DECISAO.ORIENTACAO, motivo: "CORRECAO_CANCELADA", escopo, propostaId: p.id, resposta: "Cancelado. Nada foi alterado." });
    }
    const r = await execucao.aposCorrecaoDeConta(p, escopo, { confirmadoPor: resposta.participanteId });
    const campo = NOME_DO_CAMPO[p.comando.campo];
    if (r.situacao === "CORRIGIDA") {
      const x = r.resultado ?? {};
      if (x.semMudanca) return saida.fim(evento, { decisao: DECISAO.EXECUTADO, motivo: "CORRECAO_SEM_MUDANCA", escopo, propostaId: p.id, resposta: `Nada mudou: o ${campo} já era ${p.comando.depois}.` });
      const texto2 = x.conferido === false
        ? `Alteração gravada, mas a conferência não bateu. A Central Financeira vai revisar.`
        : p.comando.feito ? `Feito. ${p.comando.feito} Conferido no Financeiro.`
          : `Feito. ${campo[0].toUpperCase()}${campo.slice(1)} alterado de ${p.comando.antes} para ${p.comando.depois} em ${x.alteradas === 1 ? "1 conta" : `${x.alteradas} parcelas`}. Conferido no Financeiro.`;
      return saida.fim(evento, { decisao: DECISAO.EXECUTADO, motivo: x.conferido === false ? "CORRECAO_GRAVADA_SEM_CONFERENCIA" : "CORRECAO_EXECUTADA", escopo, propostaId: p.id, resposta: texto2, extra: { confirmadoPor: resposta.participanteId } });
    }
    const motivo = r.motivo ?? r.motivos?.[0] ?? "CORRECAO_NAO_EXECUTADA";
    // falha TRANSITÓRIA: nada mudou e a confirmação continua aberta; definitiva: o pedido é encerrado (nunca fica pendurado)
    if (/INDISPONIVEL|TENTATIVAS_ESGOTADAS/.test(motivo)) return saida.lembrar(evento, div, "Não consegui falar com o Financeiro agora. Nada foi alterado. Responda \"sim\" de novo em instantes.", `CORRECAO_NAO_EXECUTADA:${motivo}`, escopo);
    await a.propostas.transicionar(escopo, p.id, "AGUARDANDO_REVISAO", "REJEITADA");
    if (/CONFLITO_VERSAO/.test(motivo) && p.comando?.pedido && p.comando?.alvo) {
      await a.auditoria.registrar({ acao: "CORRECAO_CONFIRMACAO_INVALIDADA", atorTipo: "SISTEMA", atorRef: "mova", alvo: p.id, dados: { motivo: "CONTA_MUDOU_DEPOIS_DO_RESUMO" } });
      return seguir(evento, p.comando.pedido, p.comando.alvo, saida, "A conta mudou depois do resumo: a confirmação anterior foi cancelada e nada foi alterado. Resumo atualizado:");
    }
    const explicacao = /CONFLITO_VERSAO/.test(motivo) ? "A conta mudou depois do resumo. Peça a alteração de novo para ver os dados atuais."
      : /COMPETENCIA/.test(motivo) ? "O período dessa conta está em fechamento. A alteração é pela Central Financeira."
        : /OPERACAO_INVALIDA|INTEGRIDADE/.test(motivo) ? "Essa conta não pode mais ser alterada pelo WhatsApp (pagamento ou proteção própria). A alteração é pela Central Financeira."
          : /DESLIGADA|SEM_CONCESSAO|SEM_IDENTIDADE/.test(motivo) ? "A alteração de contas pelo WhatsApp não está liberada para esta unidade. Faça pela Central Financeira."
            : "Não consegui alterar agora. Nada foi mudado; tente de novo ou faça pela Central Financeira.";
    return saida.fim(evento, { decisao: DECISAO.PROPOSTA, motivo: `CORRECAO_NAO_EXECUTADA:${motivo}`, escopo, propostaId: p.id, resposta: explicacao });
  }

  return Object.freeze({ interpretar: (texto) => interpretarPedidoDeCorrecao(texto, hoje()), iniciar, continuar });
}
