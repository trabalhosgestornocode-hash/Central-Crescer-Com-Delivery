// ENTREGADORES PRÓPRIOS — do parser Foody até Contas a Pagar, com conferência da nota fiscal.
//
//   * A apuração vem da PORTA `fonte` (implementada na integração com a plataforma): o núcleo não conhece o parser.
//   * Semana em andamento é só LEITURA (valores provisórios). Nada é gravado até a semana encerrar e a apuração estar completa.
//   * O fechamento grava, numa única transação: o retrato por entregador e UMA conta a pagar, pelo módulo que já existe.
//   * Semana anterior à primeira semana automática só fecha com reconciliação explícita de uma pessoa autorizada.
//   * Mudança depois do fechamento vira divergência: o valor original nunca é reescrito.
//   * Nenhuma operação daqui movimenta dinheiro. A baixa continua sendo a do extrato, com a trava de guardaEntregadores.js.
import { CODIGO, ErroFinanceiro, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somarLista } from "../dominio/dinheiro.js";
import {
  CATEGORIA_ENTREGADORES, CODIGO_PENDENCIA, DECISAO_DIVERGENCIA, DECISAO_DUPLICIDADE, FUSO_OPERACIONAL, SITUACAO_DOCUMENTAL as DOC, SITUACAO_PAGAMENTO, SITUACAO_SEMANA,
  chaveDaSemana, chaveDeRegistro, chaveDoFechamento, compararComFechamento, competenciaDaSemana, consolidar, contasManuaisCandidatas, descricaoDaConta, exigirSegunda, exigirTransicao,
  idExternoDaConta, pastaDoDocumento, pendenciasDaApuracao, rotuloDaSemana, semanaDe, semanaEncerrada, situacaoDoPagamento,
} from "../dominio/entregadoresProprios.js";
import { diaDaSemana, exigirData, hojeEm, somarDias } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, semCamposDesconhecidos } from "../dominio/validacao.js";
import { exigirCentavos } from "../dominio/dinheiro.js";
import { exigirFormatoDeEvidencia } from "../dominio/evidencias.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCofreDocumental } from "./cofreDocumental.js";
import { operacoesEconomicas } from "./economico.js";
import { resumoDaSemana, visaoDoExtra } from "./extrasEntregadores.js";
import { operacoesDeEvidencias } from "./evidencias.js";

const CONFERENCIAS = Object.freeze(["emitente", "tomador", "periodo", "valor", "numero", "duplicidade"]);
const TIPOS_DE_ANEXO = Object.freeze({ NOTA_FISCAL: "NOTA_FISCAL", DEMONSTRATIVO: "APURACAO_ENTREGADORES", COMPROVANTE: "COMPROVANTE", OUTRO: "OUTRO" });
const SEMANAS_DE_REVISAO = 5;
const HORA_DO_FECHAMENTO = 6; // segunda 06:00 em Fortaleza: a coleta de D-1 (a cada 6 h) já teve tempo de terminar
const textoOpcional = (v, campo, max = 160) => (v === undefined || v === null || String(v).trim() === "" ? null : exigirTexto(String(v), campo, { max }));

export function operacoesDeEntregadoresProprios(b, { fonte = null, inicioDaOperacao = null, cofreDeNotas = null, acessosNegados = null } = {}) {
  const hoje = () => hojeEm(new Date(b.agora()), FUSO_OPERACIONAL);
  const evidencias = operacoesDeEvidencias(b, { cofre: cofreDeNotas });
  const cofreDoc = operacoesDeCofreDocumental(b, { cofre: cofreDeNotas, acessosNegados });

  async function apurar(cx, inicio) {
    if (!fonte) return { disponivel: false, motivo: "FONTE_NAO_CONFIGURADA", dias: [], entregas: [] };
    const s = semanaDe(inicio);
    try {
      return await fonte.apurar({ organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId, inicio: s.inicio, fim: s.fim });
    } catch {
      return { disponivel: false, motivo: "FALHA_NA_LEITURA", dias: [], entregas: [] };
    }
  }
  const contexto = (ctx) => b.autorizarContexto(ctx, ACAO.VER);
  const obterSemana = (tx, cx, inicio) => tx.buscarPorChave(cx, TIPO.SEMANA_ENTREGADORES, chaveDaSemana(inicio));
  const listarFechamentos = (tx, cx, onde) => tx.listar(cx, TIPO.FECHAMENTO_ENTREGADOR, onde ? { onde } : undefined);
  async function obterFechamento(tx, cx, inicio, chave) {
    const [f] = await listarFechamentos(tx, cx, { semanaInicio: exigirSegunda(inicio), entregadorChave: exigirTexto(chave, "entregador", { max: 200 }) });
    if (!f) falhar(CODIGO.NAO_ENCONTRADO, "Fechamento do entregador não encontrado nesta unidade.");
    return f;
  }

  async function gravarSemana(tx, cx, inicio, situacao, dados, justificativa) {
    const s = semanaDe(inicio);
    await tx.travar(cx, chaveDaSemana(inicio), "EXCLUSIVA");
    const atual = await obterSemana(tx, cx, inicio);
    if (atual) return b.alterar(tx, cx, TIPO.SEMANA_ENTREGADORES, atual, { situacao, dados: { ...atual.dados, ...dados } }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa);
    return b.criar(tx, cx, TIPO.SEMANA_ENTREGADORES, { semanaInicio: s.inicio, semanaFim: s.fim, situacao, dados, chaveIdempotencia: chaveDaSemana(inicio), impressao: null }, justificativa);
  }

  /** Conta a pagar pelo módulo existente: mesma validação, histórico, idempotência, calendário e DRE das demais contas. */
  async function criarConta(tx, cx, g, inicio, { valorCentavos = g.valorCentavos, idExterno, descricao, vencimento }) {
    const s = semanaDe(inicio);
    const economico = operacoesEconomicas(baseNaTransacao(b, tx, cx));
    const r = await economico.registrarObrigacao(cx, {
      contraparteNova: { tipo: "FORNECEDOR", nome: g.nome }, valorOriginalCentavos: valorCentavos, categoria: CATEGORIA_ENTREGADORES,
      descricao: descricao ?? descricaoDaConta(g.nome, inicio), competencia: competenciaDaSemana(inicio), dataEmissao: s.fim, vencimento: vencimento ?? s.vencimento,
      fonte: { sistema: "FOODY", idExterno },
    });
    return r.obrigacoes[0];
  }

  /** Pedidos da semana que uma pessoa decidiu pagar em outra quarta-feira. O pedido continua na semana em que foi entregue. */
  function validarAdiamentos(e, inicio, justificativa) {
    if (e.adiamentos === undefined) return new Map();
    if (!justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Adiar o pagamento de pedidos exige justificativa.", { campo: "justificativa" });
    const mapa = new Map();
    for (const a of e.adiamentos) {
      const vencimento = exigirData(a?.vencimento, "vencimento");
      if (diaDaSemana(vencimento) !== 3 || vencimento <= semanaDe(inicio).vencimento) falhar(CODIGO.DATA_INVALIDA, "O pagamento adiado precisa cair em uma quarta-feira posterior ao vencimento da semana.", { campo: "vencimento" });
      mapa.set(exigirTexto(String(a?.numeroPedido ?? ""), "numeroPedido", { max: 40 }), vencimento);
    }
    return mapa;
  }
  const dividirAdiados = (itens, adiados) => itens.filter((i) => i.tipo === "ENTREGA" && adiados.has(String(i.numeroPedido))).map((i) => ({ numeroPedido: String(i.numeroPedido), vencimento: adiados.get(String(i.numeroPedido)), valorCentavos: i.valorCentavos }));
  /** Uma conta por entregador e quarta-feira de pagamento, ligada ao mesmo fechamento semanal. */
  async function criarContasAdiadas(tx, cx, g, inicio, chave, adiamentos) {
    const contas = [];
    for (const vencimento of [...new Set(adiamentos.map((a) => a.vencimento))].sort()) {
      const valorCentavos = somarLista(adiamentos.filter((a) => a.vencimento === vencimento), (a) => a.valorCentavos);
      const conta = await criarConta(tx, cx, g, inicio, { valorCentavos, vencimento, idExterno: `${idExternoDaConta(chave)}:a${vencimento.replaceAll("-", "")}`, descricao: `${descricaoDaConta(g.nome, inicio)} — pagamento adiado para ${vencimento.slice(8, 10)}/${vencimento.slice(5, 7)}` });
      contas.push({ obrigacaoId: conta.id, valorCentavos, vencimento, tipo: "ADIAMENTO" });
    }
    return contas;
  }

  async function bloqueiosDaTransacao(tx, cx, inicio) {
    const p = [];
    if (!(await b.categoriaPorCodigo(tx, cx, CATEGORIA_ENTREGADORES))) p.push({ codigo: CODIGO_PENDENCIA.CATEGORIA_AUSENTE, mensagem: "A categoria Entregadores Próprios (Motoboys) não existe no plano de contas desta unidade." });
    const competencia = await b.competenciaAtual(tx, cx, competenciaDaSemana(inicio));
    if (competencia?.estado === "FECHAMENTO_HOMOLOGADO") p.push({ codigo: CODIGO_PENDENCIA.COMPETENCIA_HOMOLOGADA, mensagem: `A competência ${competenciaDaSemana(inicio)} está homologada: reabra-a por revisão formal antes de fechar a semana.` });
    return p;
  }

  async function fechar(ctx, e, origem) {
    const inicio = exigirSegunda(e.inicio);
    const justificativa = textoOpcional(e.justificativa, "justificativa", 500);
    const cx0 = b.autorizarContexto(ctx, ACAO.REGISTRAR);
    if (!semanaEncerrada(inicio, hoje())) falhar(CODIGO.OPERACAO_INVALIDA, "A semana ainda está em andamento: os valores são provisórios e não geram conta a pagar.", { motivo: "SEMANA_EM_ANDAMENTO" });
    const historica = !inicioDaOperacao || inicio < inicioDaOperacao;
    if (historica && e.reconciliacao !== true) falhar(CODIGO.OPERACAO_INVALIDA, "Semana anterior ao início do fechamento automático: confira a prévia e confirme a reconciliação.", { motivo: "HISTORICO_EXIGE_RECONCILIACAO" });
    if (historica && !justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Reconciliação de semana histórica exige justificativa.", { campo: "justificativa" });
    if ((e.aceitarDiasSemDados === true || e.aceitarTriagem === true) && !justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Aceitar dia sem dados ou triagem pendente exige justificativa.", { campo: "justificativa" });
    if (e.aceitarTriagem === true && origem !== "MANUAL") falhar(CODIGO.OPERACAO_INVALIDA, "Só uma pessoa pode aceitar triagem pendente.");
    if (e.adiamentos !== undefined && origem !== "MANUAL") falhar(CODIGO.OPERACAO_INVALIDA, "Só uma pessoa pode adiar o pagamento de pedidos.");
    const adiados = validarAdiamentos(e, inicio, justificativa);
    const apuracao = await apurar(cx0, inicio);
    return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
      await tx.travar(cx, chaveDaSemana(inicio), "EXCLUSIVA");
      const atual = await obterSemana(tx, cx, inicio);
      if (atual?.situacao === SITUACAO_SEMANA.CONSOLIDADA) return { situacao: atual.situacao, repetido: true, contasCriadas: 0, semana: atual };
      const pendencias = [...pendenciasDaApuracao(apuracao, inicio, { aceitarDiasSemDados: e.aceitarDiasSemDados === true, aceitarTriagem: e.aceitarTriagem === true }), ...(await bloqueiosDaTransacao(tx, cx, inicio))];
      const execucao = { em: b.agora(), origem, por: cx.usuarioId };
      if (pendencias.length) {
        const semana = await gravarSemana(tx, cx, inicio, SITUACAO_SEMANA.PENDENTE, { pendencias, ultimaExecucao: execucao }, "Fechamento semanal pendente: a apuração operacional ainda não está completa.");
        return { situacao: semana.situacao, pendencias, contasCriadas: 0, semana };
      }
      const grupos = consolidar(apuracao.entregas).filter((g) => g.valorCentavos > 0);
      const dosExtras = new Set((await tx.listar(cx, TIPO.EXTRA_ENTREGADOR)).map((x) => x.obrigacaoId).filter(Boolean)); // extra reconhecido não é duplicidade das taxas
      const [obrigacoes, contrapartes, lancamentos] = [(await tx.listar(cx, TIPO.OBRIGACAO)).filter((o) => !dosExtras.has(o.id)), await tx.listar(cx, TIPO.CONTRAPARTE), await tx.listar(cx, TIPO.LANCAMENTO, { onde: { categoria: CATEGORIA_ENTREGADORES } })];
      const s = semanaDe(inicio);
      let contasCriadas = 0;
      const fechamentos = [];
      const encontrados = new Set(grupos.flatMap((g) => dividirAdiados(g.itens, adiados).map((a) => a.numeroPedido)));
      const ausentes = [...adiados.keys()].filter((n) => !encontrados.has(n));
      if (ausentes.length) falhar(CODIGO.ENTRADA_INVALIDA, "Há pedido adiado que não pertence às entregas elegíveis desta semana.", { campo: "adiamentos", ausentes });
      for (const g of grupos) {
        const chave = chaveDoFechamento({ organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId, entregadorChave: g.chave, inicio });
        if (await tx.buscarPorChave(cx, TIPO.FECHAMENTO_ENTREGADOR, chaveDeRegistro(chave))) continue;
        const candidatas = contasManuaisCandidatas({ nome: g.nome, inicio, obrigacoes, contrapartes, lancamentos });
        const adiamentos = dividirAdiados(g.itens, adiados);
        const principal = g.valorCentavos - somarLista(adiamentos, (a) => a.valorCentavos);
        const contaPrincipal = candidatas.length || principal <= 0 ? null : await criarConta(tx, cx, g, inicio, { valorCentavos: principal, idExterno: idExternoDaConta(chave) });
        const contasAdiadas = candidatas.length ? [] : await criarContasAdiadas(tx, cx, g, inicio, chave, adiamentos);
        const conta = contaPrincipal ?? (contasAdiadas[0] ? { id: contasAdiadas[0].obrigacaoId } : null);
        contasCriadas += (contaPrincipal ? 1 : 0) + contasAdiadas.length;
        fechamentos.push(await b.criar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, {
          semanaInicio: s.inicio, semanaFim: s.fim, vencimento: s.vencimento, entregadorChave: g.chave, entregadorNome: g.nome, obrigacaoId: conta?.id ?? null, valorCentavos: g.valorCentavos, entregas: g.entregas,
          situacaoDocumental: DOC.AGUARDANDO_NF, chaveIdempotencia: chaveDeRegistro(chave), impressao: null,
          dados: { chaveEstavel: chave, referencia: g.referencia, entregasCentavos: g.entregasCentavos, ajustesCentavos: g.ajustesCentavos, porDia: g.porDia, itens: g.itens, notas: [], conferencias: [], duplicidade: candidatas.length ? { situacao: "ABERTA", candidatas } : null, adiamentos, complementos: contasAdiadas },
        }, "Retrato da apuração semanal do parser Foody Delivery."));
      }
      const semana = await gravarSemana(tx, cx, inicio, SITUACAO_SEMANA.CONSOLIDADA, { pendencias: [], ultimaExecucao: execucao, consolidadoEm: b.agora(), origem, ...(historica ? { reconciliacao: { justificativa, por: cx.usuarioId } } : {}), ...(e.aceitarDiasSemDados === true ? { diasSemDadosAceitos: justificativa } : {}), ...(e.aceitarTriagem === true ? { triagemAceita: justificativa } : {}), retrato: grupos.map(({ chave, nome, valorCentavos, itens }) => ({ chave, nome, valorCentavos, itens })), divergencias: [] }, justificativa ?? "Semana consolidada a partir do parser Foody Delivery.");
      return { situacao: semana.situacao, pendencias: [], contasCriadas, entregadores: fechamentos.length, duplicidades: fechamentos.filter((f) => f.dados.duplicidade).length, totalCentavos: somarLista(fechamentos, (f) => f.valorCentavos), semana };
    });
  }

  async function verificar(ctx, inicio) {
    const cx0 = b.autorizarContexto(ctx, ACAO.REGISTRAR);
    const apuracao = await apurar(cx0, inicio);
    if (!apuracao.disponivel) return { novas: 0, indisponivel: true };
    return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
      await tx.travar(cx, chaveDaSemana(inicio), "EXCLUSIVA");
      const semana = await obterSemana(tx, cx, inicio);
      if (semana?.situacao !== SITUACAO_SEMANA.CONSOLIDADA) return { novas: 0 };
      const atuais = consolidar(apuracao.entregas);
      const achadas = compararComFechamento(semana.dados.retrato ?? [], atuais);
      const conhecidas = new Set((semana.dados.divergencias ?? []).map((d) => d.id));
      const novas = achadas.filter((d) => !conhecidas.has(d.id)).map((d) => ({ ...d, situacao: "ABERTA", detectadaEm: b.agora() }));
      if (novas.length) await b.alterar(tx, cx, TIPO.SEMANA_ENTREGADORES, semana, { dados: { ...semana.dados, divergencias: [...(semana.dados.divergencias ?? []), ...novas] } }, EVENTO_HISTORICO.CORRECAO, "Alteração operacional detectada depois do fechamento semanal.");
      return { novas: novas.length };
    });
  }

  const visaoDoFechamento = (f, o, dia, documentos = []) => {
    const situacaoPagamento = situacaoDoPagamento(o, dia);
    const emAberto = ![SITUACAO_PAGAMENTO.PAGO, SITUACAO_PAGAMENTO.CANCELADO].includes(situacaoPagamento);
    const impedido = emAberto && dia >= f.vencimento && f.situacaoDocumental !== DOC.LIBERADO_PAGAMENTO;
    return {
      id: f.id, semanaInicio: f.semanaInicio, semanaFim: f.semanaFim, rotuloSemana: rotuloDaSemana(f.semanaInicio), vencimento: f.vencimento, prazoDaNota: somarDias(f.semanaInicio, 8),
      entregador: { chave: f.entregadorChave, nome: f.entregadorNome, referencia: f.dados.referencia ?? null }, entregas: f.entregas, valorCentavos: f.valorCentavos,
      entregasCentavos: f.dados.entregasCentavos, ajustesCentavos: f.dados.ajustesCentavos, situacaoDocumental: f.situacaoDocumental, situacaoPagamento, obrigacaoId: f.obrigacaoId,
      saldoCentavos: o?.saldoCentavos ?? null, pagoCentavos: o?.liquidadoCentavos ?? 0, impedimentoDocumental: impedido, duplicidade: f.dados.duplicidade ?? null, contaManual: f.dados.contaManual ?? null,
      notaVigente: (f.dados.notas ?? []).find((n) => n.vigente) ?? null, documentos, pasta: pastaDoDocumento(f.entregadorNome, f.semanaInicio),
    };
  };

  return {
    /** Painel único da área: indicadores, cards, fechamentos, notas, pagamentos e histórico. Tudo calculado aqui. */
    async consultarEntregadoresProprios(ctx, e = {}) {
      semCamposDesconhecidos(e, ["semana", "mes", "entregador", "situacao"], "filtro");
      const cx0 = contexto(ctx);
      const dia = hoje();
      const atual = semanaDe(dia);
      const selecionada = semanaDe(e.semana || atual.inicio);
      const apuracao = await apurar(cx0, selecionada.inicio);
      return b.consultar(ctx, async (cx, tx) => {
        const fechamentos = await listarFechamentos(tx, cx);
        const obrigacoes = new Map((await tx.listar(cx, TIPO.OBRIGACAO)).map((o) => [o.id, o]));
        const semanas = await tx.listar(cx, TIPO.SEMANA_ENTREGADORES);
        const todos = fechamentos.map((f) => visaoDoFechamento(f, obrigacoes.get(f.obrigacaoId), dia)).sort((a, b2) => b2.semanaInicio.localeCompare(a.semanaInicio) || a.entregador.nome.localeCompare(b2.entregador.nome, "pt-BR"));
        const filtrados = todos.filter((f) => (!e.mes || f.vencimento.startsWith(e.mes)) && (!e.entregador || f.entregador.chave === e.entregador) && (!e.situacao || f.situacaoDocumental === e.situacao || f.situacaoPagamento === e.situacao));
        const registro = semanas.find((s) => s.semanaInicio === selecionada.inicio);
        const consolidada = registro?.situacao === SITUACAO_SEMANA.CONSOLIDADA;
        const grupos = consolidada ? (registro.dados.retrato ?? []).map((g) => ({ ...g, ...consolidar(g.itens.map((i) => ({ ...i, elegivel: true, entregadorChave: g.chave, entregadorNome: g.nome })))[0] })) : consolidar(apuracao.entregas);
        const situacao = consolidada ? SITUACAO_SEMANA.CONSOLIDADA : registro?.situacao === SITUACAO_SEMANA.PENDENTE ? SITUACAO_SEMANA.PENDENTE : semanaEncerrada(selecionada.inicio, dia) ? SITUACAO_SEMANA.AGUARDANDO_FECHAMENTO : SITUACAO_SEMANA.EM_ANDAMENTO;
        const emAberto = filtrados.filter((f) => ![SITUACAO_PAGAMENTO.PAGO, SITUACAO_PAGAMENTO.CANCELADO].includes(f.situacaoPagamento) && f.obrigacaoId);
        const proximaQuarta = dia <= semanaDe(somarDias(atual.inicio, -7)).vencimento ? semanaDe(somarDias(atual.inicio, -7)).vencimento : atual.vencimento;
        const soma = (lista) => somarLista(lista, (f) => f.saldoCentavos ?? f.valorCentavos);
        const extras = (await tx.listar(cx, TIPO.EXTRA_ENTREGADOR)).filter((x) => x.situacao !== "CANCELADO").map((x) => visaoDoExtra(x, obrigacoes)).sort((a, x) => x.data.localeCompare(a.data));
        const fechadosDaSemana = fechamentos.filter((f) => f.semanaInicio === selecionada.inicio);
        const pagoDaTaxa = (f) => Math.min(f.valorCentavos, (f.dados.complementos ?? []).filter((x) => x.tipo === "ADIAMENTO" && x.obrigacaoId !== f.obrigacaoId).reduce((t, x) => t + (obrigacoes.get(x.obrigacaoId)?.liquidadoCentavos ?? 0), 0) + (obrigacoes.get(f.obrigacaoId)?.liquidadoCentavos ?? 0) + (obrigacoes.get((f.dados.contaManual ?? f.dados.duplicidade?.contaManual)?.obrigacaoId)?.liquidadoCentavos ?? 0));
        const taxas = consolidada ? fechadosDaSemana.map((f) => ({ chave: f.entregadorChave, nome: f.entregadorNome, valorCentavos: f.valorCentavos, pagoCentavos: pagoDaTaxa(f) })) : grupos.map((g) => ({ chave: g.chave, nome: g.nome, valorCentavos: g.valorCentavos, pagoCentavos: 0 }));
        const resumoSemana = resumoDaSemana(taxas, extras.filter((x) => x.semanaInicio === selecionada.inicio), fechadosDaSemana.filter((f) => f.situacaoDocumental !== DOC.LIBERADO_PAGAMENTO).length);
        const vinculadas = new Set(extras.map((x) => x.obrigacaoId).filter(Boolean));
        const contrapartes = new Map((await tx.listar(cx, TIPO.CONTRAPARTE)).map((x) => [x.id, x.nome]));
        const naSemana = (d) => d >= selecionada.inicio && d <= selecionada.fim;
        const origensDeExtra = {
          contas: [...obrigacoes.values()].filter((o) => o.situacao !== "CANCELADA" && !vinculadas.has(o.id) && !String(o.fonte?.idExterno ?? "").startsWith("entregador-semana:") && (naSemana(o.dataEmissao) || naSemana(o.vencimento))).map((o) => ({ id: o.id, data: o.vencimento, descricao: o.descricao, fornecedor: contrapartes.get(o.contraparteId) ?? null, valorCentavos: o.valorBaseCentavos + o.ajustesCentavos, saldoCentavos: o.saldoCentavos })),
          saidas: (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { sentido: "SAIDA", situacao: "VALIDA" } })).filter((m) => naSemana(m.dataEfetiva) && !m.transferenciaId && m.alocadoCentavos < m.valorCentavos).map((m) => ({ id: m.id, data: m.dataEfetiva, descricao: m.descricao ?? "", livreCentavos: m.valorCentavos - m.alocadoCentavos })),
        };
        const cards = new Map();
        for (const g of grupos) cards.set(g.chave, { chave: g.chave, nome: g.nome, referencia: g.referencia ?? null, valorSemanaCentavos: g.valorCentavos, entregasSemana: g.entregas, porDia: g.porDia, aPagarCentavos: 0, aguardandoNota: 0 });
        for (const f of todos) {
          const c = cards.get(f.entregador.chave) ?? { chave: f.entregador.chave, nome: f.entregador.nome, referencia: f.entregador.referencia, valorSemanaCentavos: 0, entregasSemana: 0, porDia: [], aPagarCentavos: 0, aguardandoNota: 0 };
          if (f.obrigacaoId && f.saldoCentavos > 0) c.aPagarCentavos += f.saldoCentavos;
          if ([DOC.AGUARDANDO_NF, DOC.NF_REJEITADA].includes(f.situacaoDocumental) && f.saldoCentavos > 0) c.aguardandoNota += 1;
          cards.set(f.entregador.chave, c);
        }
        return {
          dataBase: dia, fuso: FUSO_OPERACIONAL, inicioDaOperacao, semanaAtual: atual,
          semana: { ...selecionada, rotulo: rotuloDaSemana(selecionada.inicio), situacao, provisoria: !consolidada, pendencias: registro?.dados?.pendencias ?? (apuracao.disponivel && semanaEncerrada(selecionada.inicio, dia) ? pendenciasDaApuracao(apuracao, selecionada.inicio) : []), dias: apuracao.dias ?? [], fonteDisponivel: apuracao.disponivel, motivoDaFonte: apuracao.motivo ?? null, atualizadoEm: apuracao.atualizadoEm ?? null, historica: !inicioDaOperacao || selecionada.inicio < inicioDaOperacao, divergencias: registro?.dados?.divergencias ?? [] },
          indicadores: {
            acumuladoSemanaCentavos: somarLista(grupos, (g) => g.valorCentavos), entregadoresAtivos: grupos.length, entregas: somarLista(grupos, (g) => g.entregas),
            proximaQuarta: (() => { const contas = [...obrigacoes.values()].filter((o) => String(o.fonte?.idExterno ?? "").startsWith("entregador-semana:") && o.vencimento === proximaQuarta && o.situacao !== "CANCELADA" && o.saldoCentavos > 0); return { data: proximaQuarta, quantidade: contas.length, valorCentavos: somarLista(contas, (o) => o.saldoCentavos) }; })(),
            aguardandoNotaCentavos: soma(emAberto.filter((f) => [DOC.AGUARDANDO_NF, DOC.NF_REJEITADA, DOC.NF_RECEBIDA, DOC.NF_EM_CONFERENCIA].includes(f.situacaoDocumental))),
            liberadoCentavos: soma(emAberto.filter((f) => f.situacaoDocumental === DOC.LIBERADO_PAGAMENTO)), vencidoCentavos: soma(emAberto.filter((f) => f.situacaoPagamento === SITUACAO_PAGAMENTO.VENCIDO)),
            pagoCentavos: somarLista(filtrados, (f) => f.pagoCentavos),
          },
          entregadores: [...cards.values()].sort((a, b2) => a.nome.localeCompare(b2.nome, "pt-BR")), fechamentos: filtrados,
          semanas: semanas.map((s) => ({ inicio: s.semanaInicio, rotulo: rotuloDaSemana(s.semanaInicio), situacao: s.situacao, pendencias: s.dados.pendencias?.length ?? 0, divergenciasAbertas: (s.dados.divergencias ?? []).filter((d) => d.situacao === "ABERTA").length, origem: s.dados.origem ?? s.dados.ultimaExecucao?.origem ?? null })).sort((a, b2) => b2.inicio.localeCompare(a.inicio)),
          extras, resumoSemana, origensDeExtra, cofreDisponivel: Boolean(cofreDeNotas), permissoes: cx.permissoes,
        };
      });
    },

    /** Prévia sem efeito: o que seria gerado na semana, com pendências e possíveis duplicidades. */
    async previaDoFechamentoSemanal(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio"], "previa");
      const inicio = exigirSegunda(e.inicio);
      const apuracao = await apurar(contexto(ctx), inicio);
      return b.consultar(ctx, async (cx, tx) => {
        const [obrigacoes, contrapartes, lancamentos] = [await tx.listar(cx, TIPO.OBRIGACAO), await tx.listar(cx, TIPO.CONTRAPARTE), await tx.listar(cx, TIPO.LANCAMENTO, { onde: { categoria: CATEGORIA_ENTREGADORES } })];
        const itens = consolidar(apuracao.entregas).filter((g) => g.valorCentavos > 0).map((g) => ({ chave: g.chave, nome: g.nome, entregas: g.entregas, valorCentavos: g.valorCentavos, candidatas: contasManuaisCandidatas({ nome: g.nome, inicio, obrigacoes, contrapartes, lancamentos }) }));
        return { inicio, rotulo: rotuloDaSemana(inicio), vencimento: semanaDe(inicio).vencimento, historica: !inicioDaOperacao || inicio < inicioDaOperacao, pendencias: [...pendenciasDaApuracao(apuracao, inicio), ...(await bloqueiosDaTransacao(tx, cx, inicio))], itens, totalCentavos: somarLista(itens, (i) => i.valorCentavos), comDuplicidade: itens.filter((i) => i.candidatas.length).length };
      });
    },

    /** Demonstrativo, documentos e histórico de conferência de um entregador numa semana. */
    detalharFechamentoDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador"], "detalhe");
      return b.consultar(ctx, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        const o = f.obrigacaoId ? await tx.obter(cx, TIPO.OBRIGACAO, f.obrigacaoId) : null;
        const vinculos = f.obrigacaoId ? await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.OBRIGACAO, registroId: f.obrigacaoId } }) : [];
        const documentos = [];
        for (const v of vinculos) { const d = await tx.obter(cx, TIPO.DOCUMENTO, v.documentoId); if (d) documentos.push({ id: d.id, tipo: d.tipo, descricao: d.descricao, recebidoEm: d.recebidoEm, enviadoPor: d.responsavelId === cx.usuarioId ? "Você" : "Usuário autorizado", vigente: !d.substituidoPorId }); }
        const historico = (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.FECHAMENTO_ENTREGADOR, registroId: f.id } })).map((h) => ({ evento: h.evento, em: h.em, justificativa: h.justificativa ?? null, situacaoAntes: h.antes?.situacaoDocumental ?? null, situacaoDepois: h.depois?.situacaoDocumental ?? null }));
        const historica = !inicioDaOperacao || f.semanaInicio < inicioDaOperacao;
        const saidasDoExtrato = historica && f.obrigacaoId && f.situacaoDocumental !== DOC.LIBERADO_PAGAMENTO
          ? (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { sentido: "SAIDA", situacao: "VALIDA" } })).filter((m) => m.dataEfetiva >= f.semanaFim && m.dataEfetiva <= somarDias(f.vencimento, 7) && m.alocadoCentavos < m.valorCentavos)
            .sort((a, x) => a.dataEfetiva.localeCompare(x.dataEfetiva)).map((m) => ({ id: m.id, data: m.dataEfetiva, valorCentavos: m.valorCentavos, livreCentavos: m.valorCentavos - m.alocadoCentavos, descricao: m.descricao ?? "" }))
          : [];
        const contasDosExtras = new Map((await tx.listar(cx, TIPO.OBRIGACAO)).map((c) => [c.id, c]));
        const extras = (await tx.listar(cx, TIPO.EXTRA_ENTREGADOR, { onde: { entregadorChave: f.entregadorChave, semanaInicio: f.semanaInicio } })).filter((x) => x.situacao !== "CANCELADO").map((x) => visaoDoExtra(x, contasDosExtras));
        return { dataBase: hoje(), semanaHistorica: historica, saidasDoExtrato, extras, ...visaoDoFechamento(f, o, hoje(), documentos), porDia: f.dados.porDia, itens: f.dados.itens, notas: f.dados.notas ?? [], conferencias: f.dados.conferencias ?? [], complementos: f.dados.complementos ?? [], historico, cofreDisponivel: Boolean(cofreDeNotas), permissoes: cx.permissoes };
      });
    },

    /** Histórico do entregador nesta unidade (a identidade nunca é unida a outra unidade por semelhança de nome). */
    consultarEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["entregador"], "entregador");
      const chave = exigirTexto(e.entregador, "entregador", { max: 200 });
      return b.consultar(ctx, async (cx, tx) => {
        const fechamentos = await listarFechamentos(tx, cx, { entregadorChave: chave });
        if (!fechamentos.length) falhar(CODIGO.NAO_ENCONTRADO, "Entregador sem fechamentos nesta unidade.");
        const dia = hoje();
        const itens = [];
        for (const f of fechamentos) itens.push(visaoDoFechamento(f, f.obrigacaoId ? await tx.obter(cx, TIPO.OBRIGACAO, f.obrigacaoId) : null, dia));
        itens.sort((a, x) => x.semanaInicio.localeCompare(a.semanaInicio));
        return { chave, nome: itens[0].entregador.nome, referencia: itens[0].entregador.referencia, fechamentos: itens, totalCentavos: somarLista(itens, (f) => f.valorCentavos), entregas: somarLista(itens, (f) => f.entregas), pagoCentavos: somarLista(itens, (f) => f.pagoCentavos) };
      });
    },

    /** Resumo usado no detalhe da conta a pagar e no calendário financeiro. */
    resumoDoEntregadorDaConta(ctx, e = {}) {
      return b.consultar(ctx, async (cx, tx) => {
        const [f] = await listarFechamentos(tx, cx, { obrigacaoId: e.obrigacaoId });
        if (!f) return null;
        return visaoDoFechamento(f, await tx.obter(cx, TIPO.OBRIGACAO, f.obrigacaoId), hoje());
      });
    },

    fecharSemanaDeEntregadores(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "reconciliacao", "aceitarDiasSemDados", "aceitarTriagem", "adiamentos", "justificativa"], "fechamento");
      return fechar(ctx, e, "MANUAL");
    },
    verificarAlteracoesDaSemana(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio"], "verificacao");
      return verificar(ctx, exigirSegunda(e.inicio));
    },

    /**
     * Ciclo do agendador: fecha as semanas encerradas desde a primeira semana automática e revisa as recentes.
     * Idempotente e recuperável: uma execução perdida é refeita no ciclo seguinte. Sem data de início, não faz nada.
     */
    async executarCicloDeEntregadores(ctx) {
      if (!inicioDaOperacao) return { executado: false, motivo: "SEM_DATA_DE_INICIO", semanas: [] };
      const agora = new Date(b.agora());
      const dia = hojeEm(agora, FUSO_OPERACIONAL);
      const hora = Number(new Intl.DateTimeFormat("en-US", { timeZone: FUSO_OPERACIONAL, hour: "2-digit", hourCycle: "h23" }).format(agora));
      const semanas = [];
      const ultima = semanaDe(somarDias(dia, -7)).inicio;
      for (let inicio = exigirSegunda(inicioDaOperacao); inicio <= ultima; inicio = somarDias(inicio, 7)) {
        if (inicio === ultima && dia === somarDias(inicio, 7) && hora < HORA_DO_FECHAMENTO) continue;
        try {
          const r = await fechar(ctx, { inicio }, "AUTOMATICA");
          const v = r.repetido && inicio >= somarDias(ultima, -7 * (SEMANAS_DE_REVISAO - 1)) ? await verificar(ctx, inicio) : { novas: 0 };
          semanas.push({ inicio, situacao: r.situacao, contasCriadas: r.contasCriadas, pendencias: r.pendencias?.length ?? 0, divergenciasNovas: v.novas });
        } catch (erro) {
          if (!(erro instanceof ErroFinanceiro)) throw erro;
          semanas.push({ inicio, erro: erro.codigo });
        }
      }
      return { executado: true, semanas };
    },

    /** Decide uma possível duplicidade com conta manual. Nunca escolhe sozinho. */
    resolverDuplicidadeDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "decisao", "obrigacaoManualId", "justificativa"], "duplicidade");
      const decisao = exigirUmDe(e.decisao, DECISAO_DUPLICIDADE, "decisao");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        if (f.dados.duplicidade?.situacao !== "ABERTA") falhar(CODIGO.OPERACAO_INVALIDA, "Não há duplicidade aberta neste fechamento.");
        const base = { ...f.dados.duplicidade, situacao: "RESOLVIDA", decisao, justificativa, por: cx.usuarioId, em: b.agora() };
        if (decisao === DECISAO_DUPLICIDADE.VINCULAR_MANUAL) {
          const candidata = f.dados.duplicidade.candidatas.find((c) => c.obrigacaoId === e.obrigacaoManualId);
          if (!candidata) falhar(CODIGO.ENTRADA_INVALIDA, "Escolha uma das contas manuais encontradas para esta semana.", { campo: "obrigacaoManualId" });
          return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { dados: { ...f.dados, duplicidade: base, contaManual: candidata } }, EVENTO_HISTORICO.CORRECAO, justificativa);
        }
        const adiamentos = f.dados.adiamentos ?? [];
        let saldoDaSemana = f.valorCentavos - somarLista(adiamentos, (a) => a.valorCentavos);
        if (decisao === DECISAO_DUPLICIDADE.GERAR_DIFERENCA) {
          const manual = f.dados.duplicidade.candidatas.find((c) => c.obrigacaoId === e.obrigacaoManualId);
          if (!manual) falhar(CODIGO.ENTRADA_INVALIDA, "Escolha a conta manual que já cobre parte desta semana.", { campo: "obrigacaoManualId" });
          saldoDaSemana -= manual.valorCentavos;
          if (saldoDaSemana <= 0) falhar(CODIGO.OPERACAO_INVALIDA, "A conta manual já cobre todo o valor da semana: vincule-a em vez de gerar diferença.");
          base.contaManual = manual;
        }
        const conta = await criarConta(tx, cx, { nome: f.entregadorNome, valorCentavos: saldoDaSemana }, f.semanaInicio, { valorCentavos: saldoDaSemana, idExterno: idExternoDaConta(f.dados.chaveEstavel), ...(decisao === DECISAO_DUPLICIDADE.GERAR_DIFERENCA ? { descricao: `${descricaoDaConta(f.entregadorNome, f.semanaInicio)} — saldo além da conta manual` } : {}) });
        const contasAdiadas = await criarContasAdiadas(tx, cx, { nome: f.entregadorNome }, f.semanaInicio, f.dados.chaveEstavel, adiamentos);
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { obrigacaoId: conta.id, dados: { ...f.dados, duplicidade: base, complementos: [...(f.dados.complementos ?? []), ...contasAdiadas] } }, EVENTO_HISTORICO.CORRECAO, justificativa);
      });
    },

    /** Anexa nota, demonstrativo, comprovante ou outro documento à conta da semana. O arquivo anterior nunca é apagado. */
    async anexarDocumentoDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "arquivo", "tipoAnexo", "numero", "emitente", "tomador", "valorCentavos", "referencia"], "anexo");
      const tipoAnexo = exigirUmDe(e.tipoAnexo ?? "NOTA_FISCAL", Object.keys(TIPOS_DE_ANEXO), "tipoAnexo");
      const nota = tipoAnexo === "NOTA_FISCAL";
      const dadosFiscais = { numero: textoOpcional(e.numero, "numero", 60), emitente: textoOpcional(e.emitente, "emitente"), tomador: textoOpcional(e.tomador, "tomador"), referencia: textoOpcional(e.referencia, "referencia"), valorCentavos: e.valorCentavos === undefined || e.valorCentavos === null || e.valorCentavos === "" ? null : exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }) };
      const alvo = await b.consultar(ctx, (cx, tx) => obterFechamento(tx, cx, e.inicio, e.entregador));
      if (!alvo.obrigacaoId) falhar(CODIGO.OPERACAO_INVALIDA, "Resolva a duplicidade desta semana antes de anexar documentos.", { motivo: "SEM_CONTA_A_PAGAR" });
      if (nota && alvo.situacaoDocumental === DOC.LIBERADO_PAGAMENTO) falhar(CODIGO.OPERACAO_INVALIDA, "O pagamento já foi liberado: a nota aprovada não pode ser substituída.");
      // Quarentena: sem antivírus, PDF com conteúdo ativo é recusado antes de chegar ao cofre; o resto só sai como download autorizado.
      if (exigirFormatoDeEvidencia({ conteudo: e.arquivo?.conteudo, tipoMime: e.arquivo?.tipoMime, nomeArquivo: e.arquivo?.nome }).conteudoAtivo) falhar(CODIGO.DOCUMENTO_INVALIDO, "PDF com conteúdo ativo (scripts, anexos ou ações automáticas) não é aceito. Peça ao emitente uma via simples da nota.", { motivo: "PDF_COM_CONTEUDO_ATIVO" });
      const envio = await evidencias.enviarEvidencia(ctx, { arquivo: e.arquivo, tipo: TIPOS_DE_ANEXO[tipoAnexo], descricao: `${pastaDoDocumento(alvo.entregadorNome, alvo.semanaInicio).join(" / ")} — ${tipoAnexo}`, competencia: competenciaDaSemana(alvo.semanaInicio), vinculo: { registroTipo: TIPO.OBRIGACAO, registroId: alvo.obrigacaoId } });
      if (!nota) return { documento: envio.documento, situacaoDocumental: alvo.situacaoDocumental };
      return b.executar(ctx, ACAO.ENVIAR_DOCUMENTO, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        const outros = (await listarFechamentos(tx, cx)).filter((x) => x.id !== f.id);
        const repetida = outros.some((x) => (x.dados.notas ?? []).some((n) => n.vigente && (n.documentoId === envio.documento.id || (dadosFiscais.numero && n.numero === dadosFiscais.numero && n.emitente === dadosFiscais.emitente))));
        if (repetida) falhar(CODIGO.OPERACAO_INVALIDA, "Esta nota fiscal já está vinculada a outra semana ou entregador.", { motivo: "NOTA_DUPLICADA" });
        const notas = (f.dados.notas ?? []).map((n) => ({ ...n, vigente: false, substituidaEm: n.vigente ? b.agora() : n.substituidaEm ?? null }));
        notas.push({ documentoId: envio.documento.id, enviadaEm: b.agora(), enviadaPor: cx.usuarioId, vigente: true, situacao: DOC.NF_RECEBIDA, ...dadosFiscais });
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { situacaoDocumental: exigirTransicao(f.situacaoDocumental, DOC.NF_RECEBIDA), dados: { ...f.dados, notas } }, EVENTO_HISTORICO.MUDANCA_ESTADO, "Nota fiscal recebida.");
      });
    },

    iniciarConferenciaDaNota(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador"], "conferencia");
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { situacaoDocumental: exigirTransicao(f.situacaoDocumental, DOC.NF_EM_CONFERENCIA) }, EVENTO_HISTORICO.MUDANCA_ESTADO, "Conferência da nota iniciada.");
      });
    },

    /** Aprovar exige cada item conferido por uma pessoa e o valor da nota igual ao devido. PDF enviado não prova validade fiscal. */
    decidirNotaDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "decisao", "conferido", "justificativa"], "decisao");
      const decisao = exigirUmDe(e.decisao, ["APROVAR", "REJEITAR"], "decisao");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      const conferido = Object.fromEntries(CONFERENCIAS.map((k) => [k, e.conferido?.[k] === true]));
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        const nota = (f.dados.notas ?? []).find((n) => n.vigente);
        if (!nota) falhar(CODIGO.OPERACAO_INVALIDA, "Nenhuma nota fiscal vigente para conferir.");
        if (decisao === "APROVAR") {
          const faltando = CONFERENCIAS.filter((k) => !conferido[k]);
          if (faltando.length) falhar(CODIGO.ENTRADA_INVALIDA, "Confira emitente, tomador, período, valor, número e duplicidade antes de aprovar.", { faltando });
          if (nota.valorCentavos !== f.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "O valor informado na nota é diferente do total devido na semana.", { motivo: "VALOR_DA_NOTA_DIVERGENTE", notaCentavos: nota.valorCentavos, devidoCentavos: f.valorCentavos });
        }
        const nova = decisao === "APROVAR" ? DOC.NF_APROVADA : DOC.NF_REJEITADA;
        const notas = f.dados.notas.map((n) => (n.vigente ? { ...n, situacao: nova } : n));
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { situacaoDocumental: exigirTransicao(f.situacaoDocumental, nova), dados: { ...f.dados, notas, conferencias: [...(f.dados.conferencias ?? []), { decisao, conferido, justificativa, por: cx.usuarioId, em: b.agora() }] } }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa);
      });
    },

    liberarPagamentoDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "demonstrativoConferido", "justificativa"], "liberacao");
      if (e.demonstrativoConferido !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confirme que o demonstrativo da semana foi conferido.");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        const semana = await obterSemana(tx, cx, f.semanaInicio);
        if ((semana?.dados?.divergencias ?? []).some((d) => d.situacao === "ABERTA" && d.entregadorChave === f.entregadorChave)) falhar(CODIGO.OPERACAO_INVALIDA, "Há alteração operacional sem decisão nesta semana: resolva antes de liberar o pagamento.", { motivo: "DIVERGENCIA_ABERTA" });
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { situacaoDocumental: exigirTransicao(f.situacaoDocumental, DOC.LIBERADO_PAGAMENTO), dados: { ...f.dados, liberacao: { justificativa, por: cx.usuarioId, em: b.agora() } } }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa);
      });
    },

    /**
     * Semana histórica JÁ PAGA antes desta área existir: uma pessoa aponta a saída do extrato e dispensa a nota daquela semana.
     * Só libera a baixa pelo extrato; não cria movimento nem marca a conta como paga.
     */
    reconhecerPagamentoHistorico(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "movimentacaoId", "justificativa"], "pagamentoHistorico");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        if (inicioDaOperacao && f.semanaInicio >= inicioDaOperacao) falhar(CODIGO.OPERACAO_INVALIDA, "Só semanas anteriores ao fechamento automático dispensam a nota.", { motivo: "SEMANA_NAO_HISTORICA" });
        if (!f.obrigacaoId) falhar(CODIGO.OPERACAO_INVALIDA, "Esta semana não tem conta a pagar para baixar.");
        const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, e.movimentacaoId, "Saída do extrato");
        if (mov.sentido !== "SAIDA" || mov.situacao !== "VALIDA" || mov.alocadoCentavos >= mov.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "Escolha uma saída válida do extrato que ainda não esteja vinculada.");
        return b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { situacaoDocumental: DOC.LIBERADO_PAGAMENTO, dados: { ...f.dados, liberacao: { historica: true, movimentacaoId: mov.id, justificativa, por: cx.usuarioId, em: b.agora() } } }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa);
      });
    },

    /** Decide uma alteração posterior: o valor original fica preservado em qualquer caminho. */
    decidirDivergenciaDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "divergencia", "decisao", "justificativa"], "divergencia");
      const decisao = exigirUmDe(e.decisao, DECISAO_DIVERGENCIA, "decisao");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      const inicio = exigirSegunda(e.inicio);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        await tx.travar(cx, chaveDaSemana(inicio), "EXCLUSIVA");
        const semana = await obterSemana(tx, cx, inicio);
        const d = (semana?.dados?.divergencias ?? []).find((x) => x.id === e.divergencia);
        if (!d || d.situacao !== "ABERTA") falhar(CODIGO.NAO_ENCONTRADO, "Divergência aberta não encontrada.");
        const [f] = await listarFechamentos(tx, cx, { semanaInicio: inicio, entregadorChave: d.entregadorChave });
        const o = f?.obrigacaoId ? await tx.obter(cx, TIPO.OBRIGACAO, f.obrigacaoId) : null;
        let efeito = null;
        if (decisao === DECISAO_DIVERGENCIA.AJUSTAR_CONTA) {
          if (!o || o.saldoCentavos === 0 || [DOC.NF_APROVADA, DOC.LIBERADO_PAGAMENTO].includes(f.situacaoDocumental)) falhar(CODIGO.OPERACAO_INVALIDA, "Conta paga ou com nota aprovada não é ajustada: use conta complementar ou compensação futura.", { motivo: "CONTA_NAO_AJUSTAVEL" });
          const r = await operacoesEconomicas(baseNaTransacao(b, tx, cx)).registrarAjuste(cx, { alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: d.diferencaCentavos, motivo: `Alteração operacional após o fechamento: ${justificativa}`.slice(0, 500), categoria: CATEGORIA_ENTREGADORES });
          efeito = { ajusteId: r.ajuste?.id ?? null };
        }
        if (decisao === DECISAO_DIVERGENCIA.CONTA_COMPLEMENTAR) {
          if (d.diferencaCentavos <= 0) falhar(CODIGO.OPERACAO_INVALIDA, "Conta complementar só existe para diferença a favor do entregador.");
          const chave = f?.dados.chaveEstavel ?? chaveDoFechamento({ organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId, entregadorChave: d.entregadorChave, inicio });
          const venc = semanaDe(hoje()).vencimento;
          const conta = await criarConta(tx, cx, { nome: d.entregadorNome }, inicio, { valorCentavos: d.diferencaCentavos, idExterno: `${idExternoDaConta(chave)}:c${d.id.slice(0, 8)}`, descricao: `${descricaoDaConta(d.entregadorNome, inicio)} — complemento`, vencimento: venc });
          efeito = { obrigacaoId: conta.id };
          if (f) await b.alterar(tx, cx, TIPO.FECHAMENTO_ENTREGADOR, f, { dados: { ...f.dados, complementos: [...(f.dados.complementos ?? []), { obrigacaoId: conta.id, valorCentavos: d.diferencaCentavos, divergenciaId: d.id }] } }, EVENTO_HISTORICO.AJUSTE, justificativa);
        }
        const divergencias = semana.dados.divergencias.map((x) => (x.id === d.id ? { ...x, situacao: "DECIDIDA", decisao, justificativa, efeito, por: cx.usuarioId, em: b.agora() } : x));
        return b.alterar(tx, cx, TIPO.SEMANA_ENTREGADORES, semana, { dados: { ...semana.dados, divergencias } }, EVENTO_HISTORICO.CORRECAO, justificativa);
      });
    },

    /** Entrega o arquivo a quem tem a permissão de documentos, conferindo que ele pertence a este fechamento. */
    async abrirDocumentoDoEntregador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["inicio", "entregador", "documento"], "documento");
      const pertence = await b.consultar(ctx, async (cx, tx) => {
        const f = await obterFechamento(tx, cx, e.inicio, e.entregador);
        if (!f.obrigacaoId) return false;
        return (await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.OBRIGACAO, registroId: f.obrigacaoId } })).some((v) => v.documentoId === e.documento);
      });
      if (!pertence) falhar(CODIGO.NAO_ENCONTRADO, "Documento não encontrado neste fechamento.");
      return cofreDoc.obterArquivoDoDocumento(ctx, { id: e.documento, finalidade: "BAIXAR" });
    },
  };
}
