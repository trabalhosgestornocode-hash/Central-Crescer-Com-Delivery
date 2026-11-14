// MOTOR DE FORMAÇÃO FINANCEIRA (Execução 03)
//   documento → registro importado → interpretação → PROPOSTA → revisão/aprovação → APLICAÇÃO autorizada → operação.
//
// Princípios:
//   - importar nunca cria efeito financeiro; gerar proposta também não. Só `aplicarProposta` (proposta APROVADA, permissão
//     financeiro_v2.revisar + a permissão da operação) cria a operação — numa ÚNICA transação com a marca "aplicada";
//   - a mesma origem gera no máximo uma proposta por operação; proposta aplicada não gera a operação de novo;
//   - fonte retificada: proposta não aplicada é SUBSTITUÍDA; proposta já aplicada gera nova proposta AGUARDANDO_REVISAO —
//     nada é sobrescrito; o efeito anterior precisa ser revertido antes;
//   - nada é inventado: relatório agregado vira receita AGREGADA (sem canal, pedido ou forma); Stone sem pedido
//     correspondente fica AGUARDANDO_EVIDENCIA; extrato vira movimentação sem receita nem despesa.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  CONFIANCA, ESTADO_DIVERGENCIA_FONTE, ESTADO_PROPOSTA as E, EVENTO_HISTORICO, OPERACAO_PROPOSTA as OP, RELACAO_CORRESPONDENCIA,
  SITUACAO_CORRESPONDENCIA, SITUACAO_MOVIMENTACAO, SITUACAO_REGISTRO_FONTE, SITUACAO_TITULO, SITUACAO_VENDA, TIPO,
} from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, subtrair } from "../dominio/dinheiro.js";
import { CATEGORIA_DE_VENDA, CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_VENDA_AGREGADA } from "../dominio/planoDeContas.js";
import { exigirCentavos } from "../dominio/dinheiro.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirLista, exigirTexto, exigirUuid, semCamposDesconhecidos, uuidOpcional } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDeVendas } from "./vendas.js";

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 40);
const CONCLUIDAS = ["IMPORTADO", "IMPORTADO_COM_PENDENCIAS"];
const FINAIS = [E.APLICADA, E.REJEITADA, E.SUBSTITUIDA];
const arredondar = (micros) => { const n = micros < 0; const a = BigInt(Math.abs(micros)); const c = Number((a + 5000n) / 10000n); return n ? -c : c; };
const produtoParaForma = { CREDITO: "CREDITO", DEBITO: "DEBITO", PIX: "PIX", VALE: "VALE" };

function validarGeracao(e) {
  semCamposDesconhecidos(e, ["importacaoId", "contaBancariaId", "contaCaixaId"], "geracao");
  return { importacaoId: exigirUuid(e.importacaoId, "importacaoId"), contaBancariaId: uuidOpcional(e.contaBancariaId, "contaBancariaId"), contaCaixaId: uuidOpcional(e.contaCaixaId, "contaCaixaId") };
}
function validarDecisao(e, { justificativaObrigatoria = false } = {}) {
  semCamposDesconhecidos(e, ["propostaId", "justificativa"], "decisao");
  return { propostaId: exigirUuid(e.propostaId, "propostaId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: !justificativaObrigatoria }) };
}
function validarPeriodo(e, extras = []) {
  semCamposDesconhecidos(e, ["periodoInicio", "periodoFim", ...extras], "periodo");
  const periodoInicio = exigirData(e.periodoInicio, "periodoInicio");
  const periodoFim = exigirData(e.periodoFim, "periodoFim");
  if (periodoFim < periodoInicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
  return { periodoInicio, periodoFim };
}

export function operacoesDeFormacao(b) {
  /** Operações aprovadas instanciadas DENTRO da transação corrente (composição atômica). */
  const nucleoNa = (tx, cx) => {
    const bt = baseNaTransacao(b, tx, cx);
    return { ...operacoesDeVendas(bt), ...operacoesEconomicas(bt), ...operacoesDeCaixa(bt) };
  };

  // ------------------------------------------------------------------------------------- interpretação por fonte
  async function propostasDeVendas(tx, cx, registros, g) {
    const saida = [];
    for (const r of registros.filter((x) => x.tipoRegistro === "PEDIDO")) {
      const d = r.dados;
      if (d.cancelado) continue; // cancelado não forma venda; permanece no registro de origem
      const divergencias = [];
      const pagamentos = [];
      if (d.formaPagamento === "DINHEIRO") pagamentos.push({ forma: "DINHEIRO", valorCentavos: r.valorCentavos, ...(g.contaCaixaId ? { contaId: g.contaCaixaId } : {}) });
      else if (d.formaPagamento === "ONLINE_PLATAFORMA" && d.canal === "IFOOD") pagamentos.push({ forma: "OUTRA", processador: "IFOOD", valorCentavos: r.valorCentavos });
      else if (d.formaPagamento === "ONLINE_PLATAFORMA" && d.canal === "ANOTA_AI") pagamentos.push({ forma: "OUTRA", processador: "ANOTA_AI", valorCentavos: r.valorCentavos });
      else divergencias.push({ codigo: "PAGAMENTO_A_EVIDENCIAR", mensagem: `Forma "${d.formaOriginal}" sem processador identificado: o pagamento entra quando houver evidência (ex.: transação Stone).` });
      if (!d.canal) divergencias.push({ codigo: "CANAL_NAO_RECONHECIDO", mensagem: `Canal "${d.canalOriginal}" não reconhecido.` });
      if (d.descontoCentavos) divergencias.push({ codigo: "FINANCIADOR_DO_DESCONTO_NAO_COMPROVADO", mensagem: "A fonte não informa quem financia o desconto: dedução a classificar (nunca presumida da loja)." });
      if (d.canal === "IFOOD" && d.taxaEntregaCentavos) divergencias.push({ codigo: "TITULARIDADE_DA_TAXA_DE_ENTREGA_A_CONFIRMAR", mensagem: "Taxa de entrega em pedido iFood: confirmar se pertence à loja ou ao iFood antes de tratá-la como receita." });
      const receitaPropria = somar(d.itensCentavos, d.acrescimoCentavos, d.taxaEntregaCentavos);
      const composicao = {
        itensCentavos: d.itensCentavos, acrescimosCentavos: d.acrescimoCentavos, servicosCentavos: d.taxaEntregaCentavos,
        descontos: d.descontoCentavos ? [{ valorCentavos: d.descontoCentavos, financiador: "PENDENTE", descricao: "Desconto do pedido (financiador não informado pela fonte)" }] : [],
      };
      saida.push({
        operacao: OP.VENDA, registro: r, competencia: r.competencia, dataOperacao: r.dataReferencia, natureza: "RECEITA", valorCentavos: receitaPropria,
        categoriaSugerida: d.canal ? CATEGORIA_DE_VENDA[d.canal] : null,
        comando: { canal: d.canal, dataVenda: r.dataReferencia, brutoCentavos: receitaPropria, composicao, pagamentos, ...(pagamentos.length ? {} : { pagamentoParcial: true }), fonte: { sistema: "SAIPOS", idExterno: r.idExterno }, descricao: `Pedido ${r.idExterno}` },
        extras: { autorizacao: d.autorizacao ?? null }, divergencias,
        confianca: d.canal && pagamentos.length ? CONFIANCA.ALTA : CONFIANCA.MEDIA,
        estado: d.canal && !(d.canal === "IFOOD" && d.taxaEntregaCentavos) ? E.PROPOSTA : E.AGUARDANDO_REVISAO,
        justificativa: "Pedido do relatório de vendas por pedido: uma venda, um canal, uma receita.",
      });
    }
    for (const r of registros.filter((x) => x.tipoRegistro === "TOTAL_DIA")) {
      const d = r.dados;
      // METODOLOGIA: o valor do dia é LÍQUIDO de descontos quando itens + entrega + serviço + acréscimos − descontos = valor
      // (comprovado na exportação real). Só então a receita bruta é recuperável. Sem os componentes, ou se não fecha, o
      // significado do valor não está comprovado: o registro fica como CONTROLE, sem efeito econômico.
      const temComponentes = [d.itensCentavos, d.taxaEntregaCentavos, d.taxaServicoCentavos, d.acrescimosCentavos, d.descontosCentavos].every((v) => Number.isSafeInteger(v));
      const bruto = temComponentes ? somar(d.itensCentavos, d.taxaEntregaCentavos, d.taxaServicoCentavos, d.acrescimosCentavos) : null;
      const metodologia = temComponentes && subtrair(bruto, d.descontosCentavos) === r.valorCentavos ? "VALOR_LIQUIDO_COMPOSICAO_COMPROVADA" : "DESCONHECIDA";
      const divergencias = [];
      if (metodologia === "DESCONHECIDA") divergencias.push({ codigo: "METODOLOGIA_DESCONHECIDA", mensagem: "Não se comprova se o valor do dia é bruto ou líquido: registro mantido só como controle agregado, sem efeito econômico." });
      if (temComponentes && d.descontosCentavos) divergencias.push({ codigo: "FINANCIADOR_DO_DESCONTO_NAO_COMPROVADO", mensagem: "Descontos do dia sem financiador informado: dedução a classificar." });
      saida.push({
        operacao: OP.VENDA_AGREGADA, registro: r, competencia: r.competencia, dataOperacao: r.dataReferencia, natureza: "RECEITA", valorCentavos: r.valorCentavos,
        categoriaSugerida: CATEGORIA_VENDA_AGREGADA,
        comando: { data: r.dataReferencia, metodologia, receitaBrutaCentavos: bruto, descontosCentavos: d.descontosCentavos ?? null, valorCentavos: r.valorCentavos, quantidadeVendas: d.quantidadeVendas ?? null },
        extras: {}, divergencias, confianca: metodologia === "DESCONHECIDA" ? CONFIANCA.BAIXA : CONFIANCA.MEDIA, estado: metodologia === "DESCONHECIDA" ? E.AGUARDANDO_EVIDENCIA : E.PROPOSTA,
        justificativa: "Relatório AGREGADO por dia: vira receita agregada sem canal, pedido ou forma de pagamento; nada é distribuído por suposição.",
      });
    }
    return saida;
  }

  async function propostasStone(tx, cx, registros) {
    const vendasPropostas = await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: OP.VENDA, estado: E.APLICADA } });
    const saida = [];
    for (const r of registros.filter((x) => x.tipoRegistro === "TRANSACAO" && x.dados.situacao === "APROVADA")) {
      const d = r.dados;
      const candidatas = [];
      for (const p of vendasPropostas.filter((v) => v.dataOperacao === r.dataReferencia)) {
        const vendaId = p.efeitos.find((e) => e.tipo === TIPO.VENDA)?.id;
        const venda = vendaId ? await tx.obter(cx, TIPO.VENDA, vendaId) : null;
        if (!venda || venda.situacao !== SITUACAO_VENDA.ATIVA) continue;
        const pendente = subtrair(subtrair(subtrair(venda.brutoCentavos, venda.descontosCentavos ?? 0), venda.devolvidoCentavos), venda.pagoCentavos);
        const porAutorizacao = d.autorizacao && p.autorizacao && p.autorizacao === d.autorizacao;
        if (porAutorizacao && pendente >= r.valorCentavos) candidatas.push({ vendaId, criterio: "AUTORIZACAO", forte: true });
        else if (pendente === r.valorCentavos) candidatas.push({ vendaId, criterio: "VALOR_PENDENTE_IGUAL_MESMO_DIA", forte: false });
      }
      const fortes = candidatas.filter((c) => c.forte);
      const escolhidas = fortes.length ? fortes : candidatas;
      const taxaMicros = Math.abs(d.mdrMicros ?? 0) + Math.abs(d.unificadoMicros ?? 0);
      const antecipacaoMicros = Math.abs(d.antecipacaoMicros ?? 0);
      const taxas = [];
      if (taxaMicros) taxas.push({ categoria: "TAXAS_STONE", valorCentavos: arredondar(taxaMicros), micros: taxaMicros });
      if (antecipacaoMicros) taxas.push({ categoria: "TAXAS_ANTECIPACAO", valorCentavos: arredondar(antecipacaoMicros), micros: antecipacaoMicros });
      const divergencias = taxas.filter((t) => t.micros % 10000 !== 0).map((t) => ({ codigo: "ARREDONDAMENTO_DE_TAXA", mensagem: `Taxa ${t.categoria} com fração de centavo: ${t.micros} milionésimos → ${t.valorCentavos} centavos (meio para cima).` }));
      let estado = E.PROPOSTA;
      let confianca = CONFIANCA.ALTA;
      if (!escolhidas.length) { estado = E.AGUARDANDO_EVIDENCIA; confianca = CONFIANCA.BAIXA; divergencias.push({ codigo: "SEM_PEDIDO_CORRESPONDENTE", mensagem: "Transação preservada sem venda correspondente: nenhuma venda é criada a partir da Stone." }); }
      else if (escolhidas.length > 1) { estado = E.AGUARDANDO_REVISAO; confianca = CONFIANCA.BAIXA; divergencias.push({ codigo: "VINCULO_AMBIGUO", mensagem: `${escolhidas.length} vendas possíveis: escolha manual exigida.` }); }
      else if (!escolhidas[0].forte) confianca = CONFIANCA.MEDIA;
      saida.push({
        operacao: OP.PAGAMENTO_STONE, registro: r, competencia: r.competencia, dataOperacao: r.dataReferencia, natureza: "RECEBIVEL_E_TAXAS", valorCentavos: r.valorCentavos,
        categoriaSugerida: "TAXAS_STONE",
        comando: { vendaId: escolhidas.length === 1 ? escolhidas[0].vendaId : null, forma: produtoParaForma[d.produto] ?? "OUTRA", processador: "STONE", valorCentavos: r.valorCentavos, dataPagamento: r.dataReferencia, fonte: { sistema: "STONE", idExterno: r.idExterno }, taxas, documentoId: r.documentoId },
        extras: { candidatas: escolhidas }, duplicidades: escolhidas.length > 1 ? escolhidas.map((c) => ({ tipo: "VENDA", id: c.vendaId, criterio: c.criterio })) : [],
        divergencias, confianca, estado,
        justificativa: "Transação Stone é evidência de PAGAMENTO de venda já existente: gera o recebível (bruto) e as taxas informadas como despesa de recebimento; não cria venda nem prova depósito.",
      });
    }
    return saida;
  }

  function propostasFoody(registros, imp) {
    const porEntregador = new Map();
    for (const r of registros.filter((x) => x.tipoRegistro === "ENTREGA")) porEntregador.set(r.dados.entregador, [...(porEntregador.get(r.dados.entregador) ?? []), r]);
    return [...porEntregador].map(([entregador, lista]) => {
      const devidas = lista.filter((r) => r.dados.devido);
      const rejeitadas = lista.filter((r) => r.dados.situacao === "TAXA_REJEITADA");
      const valor = devidas.reduce((s, r) => somar(s, r.valorCentavos), 0);
      return {
        operacao: OP.OBRIGACAO_ENTREGADOR, registro: lista[0], registros: lista, competencia: imp.periodoFim.slice(0, 7), dataOperacao: imp.periodoFim, natureza: "DESPESA", valorCentavos: valor,
        categoriaSugerida: "ENTREGADORES_PROPRIOS",
        comando: { entregador, valorOriginalCentavos: valor, categoria: "ENTREGADORES_PROPRIOS", competencia: imp.periodoFim.slice(0, 7), dataEmissao: imp.periodoFim, vencimento: imp.periodoFim, descricao: `Entregas de ${imp.periodoInicio} a ${imp.periodoFim}` },
        extras: { entregador, pedidos: devidas.map((r) => r.idExterno), taxasRejeitadas: rejeitadas.map((r) => r.idExterno), canceladas: lista.filter((r) => r.dados.situacao === "CANCELADA").map((r) => r.idExterno), periodo: [imp.periodoInicio, imp.periodoFim] },
        divergencias: [{ codigo: "VENCIMENTO_A_CONFIRMAR", mensagem: "Vencimento adotado = fim do período apurado (regra de pagamento dos entregadores a confirmar)." }],
        confianca: imp.compatibilidade === "AMOSTRA_REAL" ? CONFIANCA.ALTA : CONFIANCA.MEDIA, estado: valor > 0 ? E.PROPOSTA : E.AGUARDANDO_REVISAO,
        justificativa: "Valor DEVIDO ao entregador pelas entregas válidas do período (canceladas e taxas rejeitadas fora). O relatório não prova pagamento.",
      };
    });
  }

  function propostasUnicred(registros, g, imp) {
    return registros.filter((x) => x.tipoRegistro === "LANCAMENTO_BANCARIO").map((r) => {
      const d = r.dados;
      const divergencias = [];
      if (d.categoriaSugerida === "EMPRESTIMO") divergencias.push({ codigo: "PRINCIPAL_E_JUROS_NAO_SEPARADOS", mensagem: "Parcela de empréstimo: principal (patrimonial) e juros (despesa financeira) exigem o contrato/demonstrativo; nada é classificado como despesa." });
      if (!g.contaBancariaId) divergencias.push({ codigo: "CONTA_NAO_INFORMADA", mensagem: "Informe a conta bancária do extrato para formar a movimentação." });
      return {
        operacao: OP.MOVIMENTACAO_BANCARIA, registro: r, competencia: r.competencia, dataOperacao: r.dataReferencia, natureza: "MOVIMENTACAO", valorCentavos: r.valorCentavos,
        categoriaSugerida: d.categoriaSugerida,
        comando: {
          contaId: g.contaBancariaId, dataEfetiva: r.dataReferencia, sentido: d.sentido, valorCentavos: r.valorCentavos,
          natureza: d.sentido === "ENTRADA" ? "RECEBIMENTO" : "PAGAMENTO", descricao: d.historico.slice(0, 200), documentoId: r.documentoId,
          fonte: { sistema: "UNICRED", idExterno: hash(r.chaveIdempotencia) },
        },
        extras: { categoriaBancaria: d.categoriaSugerida, saldoInformadoCentavos: d.saldoAposCentavos, historicoCompleto: d.historico, pagina: d.pagina ?? null },
        divergencias, confianca: imp.compatibilidade === "AMOSTRA_REAL" ? CONFIANCA.ALTA : CONFIANCA.MEDIA, estado: g.contaBancariaId ? E.PROPOSTA : E.AGUARDANDO_REVISAO,
        justificativa: "Movimentação da conta conforme o extrato: sem receita, despesa, venda ou obrigação automáticas; classificação é posterior.",
      };
    });
  }

  // ------------------------------------------------------------------------------------- persistência das propostas
  async function persistir(tx, cx, imp, rascunho, contagem) {
    const registros = rascunho.registros ?? [rascunho.registro];
    const origemChave = rascunho.operacao === OP.OBRIGACAO_ENTREGADOR ? `entregador:${rascunho.comando.entregador}:${imp.periodoInicio}:${imp.periodoFim}` : rascunho.registro.chaveIdempotencia;
    const conteudo = hash(registros.map((r) => r.impressao).join("|"));
    const chave = `proposta:${rascunho.operacao}:${hash(origemChave)}:${conteudo}`;
    const mesma = await tx.buscarPorChave(cx, TIPO.PROPOSTA, chave);
    if (mesma) {
      // REAVALIAÇÃO: proposta ainda não decidida acompanha evidência nova (ex.: venda que passou a casar com a transação).
      // Aprovada/aplicada/final não muda de conteúdo.
      const novo = { comando: rascunho.comando, estado: rascunho.estado, confianca: rascunho.confianca, divergencias: rascunho.divergencias, duplicidades: rascunho.duplicidades ?? [], candidatas: rascunho.extras?.candidatas ?? mesma.candidatas ?? null };
      const atual = { comando: mesma.comando, estado: mesma.estado, confianca: mesma.confianca, divergencias: mesma.divergencias, duplicidades: mesma.duplicidades, candidatas: mesma.candidatas ?? null };
      if ([E.PROPOSTA, E.AGUARDANDO_EVIDENCIA, E.AGUARDANDO_REVISAO].includes(mesma.estado) && JSON.stringify(novo) !== JSON.stringify(atual)) {
        await b.alterar(tx, cx, TIPO.PROPOSTA, mesma, novo, EVENTO_HISTORICO.CORRECAO, "Proposta reavaliada com a evidência disponível.");
        contagem.reavaliadas += 1;
      } else contagem.existentes += 1;
      return;
    }
    // Só as propostas da MESMA origem (filtro resolvido no banco; antes da 06C eram lidas todas as da operação a cada proposta).
    const anteriores = (await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: rascunho.operacao, origemChave } })).filter((p) => p.estado !== E.SUBSTITUIDA && p.estado !== E.REJEITADA);
    const duplicidades = [...(rascunho.duplicidades ?? [])];
    let estado = rascunho.estado;
    for (const a of anteriores.filter((x) => x.estado === E.APLICADA)) {
      duplicidades.push({ tipo: "EFEITO_ANTERIOR_APLICADO", propostaId: a.id, mensagem: "A fonte foi retificada: reveja e reverta o efeito anterior antes de aplicar." });
      estado = E.AGUARDANDO_REVISAO;
    }
    const nova = await b.criar(tx, cx, TIPO.PROPOSTA, {
      operacao: rascunho.operacao, estado, fonte: imp.fonte, tipoRelatorio: imp.tipoRelatorio, importacaoId: imp.id,
      documentoIds: [...new Set(registros.map((r) => r.documentoId))], registroIds: registros.map((r) => r.id), competencia: rascunho.competencia,
      dataOperacao: rascunho.dataOperacao, natureza: rascunho.natureza, valorCentavos: rascunho.valorCentavos, categoriaSugerida: rascunho.categoriaSugerida,
      comando: rascunho.comando, duplicidades, divergencias: rascunho.divergencias, confianca: rascunho.confianca, justificativa: rascunho.justificativa,
      efeitos: [], decididoPor: null, decididoEm: null, substituidaPorId: null, chaveIdempotencia: chave, impressao: null,
      ...rascunho.extras, origemChave,
    });
    for (const a of anteriores.filter((x) => x.estado !== E.APLICADA)) {
      await b.alterar(tx, cx, TIPO.PROPOSTA, a, { estado: E.SUBSTITUIDA, substituidaPorId: nova.id }, EVENTO_HISTORICO.SUBSTITUICAO, "Fonte retificada.");
      contagem.substituidas += 1;
    }
    contagem.criadas += 1;
    contagem.porEstado[estado] = (contagem.porEstado[estado] ?? 0) + 1;
  }

  /** Conflito agregado × por pedido do MESMO dia: nunca as duas receitas ao mesmo tempo. */
  async function conflitoDeGranularidade(tx, cx, proposta) {
    if (![OP.VENDA, OP.VENDA_AGREGADA].includes(proposta.operacao)) return null;
    const outra = proposta.operacao === OP.VENDA ? OP.VENDA_AGREGADA : OP.VENDA;
    const aplicadas = await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: outra, estado: E.APLICADA, dataOperacao: proposta.dataOperacao } });
    return aplicadas[0] ?? null;
  }

  async function aplicar(tx, cx, p) {
    const n = nucleoNa(tx, cx);
    const c = p.comando;
    const efeitos = [];
    if (p.operacao === OP.VENDA) {
      const r = await n.registrarVenda(cx, c);
      efeitos.push({ tipo: TIPO.VENDA, id: r.venda.id }, { tipo: TIPO.LANCAMENTO, id: r.lancamento.id }, ...r.recebiveis.map((x) => ({ tipo: TIPO.RECEBIVEL, id: x.id })), ...r.movimentacoes.map((x) => ({ tipo: TIPO.MOVIMENTACAO, id: x.id })));
    } else if (p.operacao === OP.VENDA_AGREGADA) {
      await b.exigirCompetenciaEditavel(tx, cx, p.competencia);
      const receita = await b.lancar(tx, cx, await b.categoriaDoSistema(tx, cx, CATEGORIA_VENDA_AGREGADA), {
        valorCentavos: c.receitaBrutaCentavos, moeda: "BRL", descricao: `Vendas agregadas do dia ${c.data} (fonte agregada)`, dataOperacao: c.data, competencia: p.competencia,
        fonte: { sistema: p.fonte, idExterno: `dia:${c.data}` }, canal: null, origem: { tipo: TIPO.PROPOSTA, id: p.id },
      });
      efeitos.push({ tipo: TIPO.LANCAMENTO, id: receita.id });
      if (c.metodologia !== "VALOR_LIQUIDO_COMPOSICAO_COMPROVADA") falhar(CODIGO.OPERACAO_INVALIDA, "Agregado com metodologia não comprovada não gera efeito econômico.");
      if (c.descontosCentavos > 0) {
        // Financiador dos descontos do dia não é informado: dedução A CLASSIFICAR (nunca presumida da loja). Uma única vez:
        // a receita é o bruto recuperado, então o valor líquido do relatório não sofre nova dedução.
        const deducao = await b.lancar(tx, cx, await b.categoriaDoSistema(tx, cx, CATEGORIA_DESCONTO_A_CLASSIFICAR), {
          valorCentavos: c.descontosCentavos, moeda: "BRL", descricao: `Descontos do dia ${c.data} (fonte agregada)`, dataOperacao: c.data, competencia: p.competencia,
          fonte: { sistema: p.fonte, idExterno: `dia:${c.data}:descontos` }, canal: null, origem: { tipo: TIPO.PROPOSTA, id: p.id },
        });
        efeitos.push({ tipo: TIPO.LANCAMENTO, id: deducao.id });
      }
    } else if (p.operacao === OP.PAGAMENTO_STONE) {
      if (!c.vendaId) falhar(CODIGO.OPERACAO_INVALIDA, "Transação sem venda vinculada: não há o que aplicar.");
      const r = await n.registrarPagamentoDeVenda(cx, { vendaId: c.vendaId, forma: c.forma, processador: c.processador, valorCentavos: c.valorCentavos, dataPagamento: c.dataPagamento, fonte: c.fonte });
      efeitos.push({ tipo: TIPO.PAGAMENTO_VENDA, id: r.pagamento.id }, { tipo: TIPO.RECEBIVEL, id: r.recebivel.id });
      for (const t of c.taxas) {
        const a = await n.registrarAjuste(cx, { alvoTipo: "RECEBIVEL", alvoId: r.recebivel.id, valorCentavos: -t.valorCentavos, motivo: `Taxa informada pela Stone (${t.micros} milionésimos de real)`, categoria: t.categoria, documentoId: c.documentoId });
        efeitos.push({ tipo: TIPO.AJUSTE, id: a.ajuste.id }, { tipo: TIPO.LANCAMENTO, id: a.lancamento.id });
      }
    } else if (p.operacao === OP.OBRIGACAO_ENTREGADOR) {
      const chave = `contraparte:entregador:${hash(c.entregador.trim().toLowerCase())}`;
      let contraparte = await tx.buscarPorChave(cx, TIPO.CONTRAPARTE, chave);
      if (!contraparte) contraparte = await b.criar(tx, cx, TIPO.CONTRAPARTE, { tipo: "PRESTADOR", nome: c.entregador.slice(0, 120), chaveIdempotencia: chave, impressao: null });
      const r = await n.registrarObrigacao(cx, {
        contraparteId: contraparte.id, valorOriginalCentavos: c.valorOriginalCentavos, categoria: c.categoria, descricao: c.descricao, competencia: c.competencia,
        dataEmissao: c.dataEmissao, vencimento: c.vencimento, documentoIds: p.documentoIds, fonte: { sistema: p.fonte, idExterno: hash(p.origemChave) },
      });
      efeitos.push({ tipo: TIPO.CONTRAPARTE, id: contraparte.id }, ...r.obrigacoes.map((o) => ({ tipo: TIPO.OBRIGACAO, id: o.id })), { tipo: TIPO.LANCAMENTO, id: r.lancamento.id });
    } else if (p.operacao === OP.MOVIMENTACAO_BANCARIA) {
      if (!c.contaId) falhar(CODIGO.OPERACAO_INVALIDA, "Conta bancária não informada na proposta.");
      const m = await n.registrarMovimentacao(cx, c);
      efeitos.push({ tipo: TIPO.MOVIMENTACAO, id: (m.movimentacao ?? m).id });
    }
    return efeitos;
  }

  return {
    /** Interpreta os registros de UMA importação concluída e cria propostas (sem nenhum efeito financeiro). */
    gerarPropostas(ctx, entrada) {
      const g = validarGeracao(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, g.importacaoId, "Importação");
        if (!CONCLUIDAS.includes(imp.estado)) falhar(CODIGO.OPERACAO_INVALIDA, "Só uma importação concluída gera propostas.", { estado: imp.estado });
        await tx.travar(cx, `formacao:${imp.fonte}`, "EXCLUSIVA");
        const registros = await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: imp.id, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
        const porFonte = {
          SAIPOS: () => propostasDeVendas(tx, cx, registros, g), STONE: () => propostasStone(tx, cx, registros),
          FOODY: () => propostasFoody(registros, imp), UNICRED: () => propostasUnicred(registros, g, imp),
        };
        const rascunhos = porFonte[imp.fonte] ? await porFonte[imp.fonte]() : [];
        const contagem = { criadas: 0, existentes: 0, reavaliadas: 0, substituidas: 0, porEstado: {} };
        for (const r of rascunhos) await persistir(tx, cx, imp, r, contagem);
        return { importacaoId: imp.id, ...contagem, semProposta: registros.length - rascunhos.reduce((s, r) => s + (r.registros?.length ?? 1), 0) };
      });
    },

    aprovarProposta(ctx, entrada) {
      const c = validarDecisao(entrada);
      return b.executar(ctx, ACAO.APROVAR, async (cx, tx) => {
        const p = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaId, "Proposta");
        if (p.estado === E.APROVADA) return p;
        if (FINAIS.includes(p.estado)) falhar(CODIGO.TRANSICAO_INVALIDA, "Proposta já decidida.", { estado: p.estado });
        if (p.estado === E.AGUARDANDO_EVIDENCIA) falhar(CODIGO.TRANSICAO_INVALIDA, "Falta evidência: a proposta não pode ser aprovada assim.");
        if (p.estado === E.AGUARDANDO_REVISAO && !c.justificativa) falhar(CODIGO.TRANSICAO_INVALIDA, "Proposta em revisão exige justificativa para aprovar.");
        for (const d of p.duplicidades.filter((x) => x.tipo === "EFEITO_ANTERIOR_APLICADO")) {
          const anterior = await tx.obter(cx, TIPO.PROPOSTA, d.propostaId);
          if (anterior?.estado === E.APLICADA) falhar(CODIGO.TRANSICAO_INVALIDA, "Reverta o efeito da proposta anterior (fonte retificada) antes de aprovar esta.");
        }
        if (p.operacao === OP.PAGAMENTO_STONE && !p.comando.vendaId) falhar(CODIGO.TRANSICAO_INVALIDA, "Vínculo ambíguo ou ausente: a proposta não indica uma venda.");
        return b.alterar(tx, cx, TIPO.PROPOSTA, p, { estado: E.APROVADA, decididoPor: cx.usuarioId, decididoEm: b.agora() }, EVENTO_HISTORICO.MUDANCA_ESTADO, c.justificativa);
      });
    },

    rejeitarProposta(ctx, entrada) {
      const c = validarDecisao(entrada, { justificativaObrigatoria: true });
      return b.executar(ctx, ACAO.APROVAR, async (cx, tx) => {
        const p = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaId, "Proposta");
        if (FINAIS.includes(p.estado)) falhar(CODIGO.TRANSICAO_INVALIDA, "Proposta já decidida.", { estado: p.estado });
        return b.alterar(tx, cx, TIPO.PROPOSTA, p, { estado: E.REJEITADA, decididoPor: cx.usuarioId, decididoEm: b.agora() }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa);
      });
    },

    /** Cria a operação e marca a proposta como aplicada NA MESMA transação. Reaplicar devolve o resultado anterior. */
    aplicarProposta(ctx, entrada) {
      const c = validarDecisao(entrada);
      return b.executar(ctx, ACAO.APLICAR, async (cx, tx) => {
        const previa = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaId, "Proposta");
        await tx.travar(cx, `formacao-dia:${previa.dataOperacao}`, "EXCLUSIVA");
        const p = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaId, "Proposta");
        if (p.estado === E.APLICADA) return { proposta: p, efeitos: p.efeitos, repetido: true };
        if (p.estado !== E.APROVADA) falhar(CODIGO.TRANSICAO_INVALIDA, "Só proposta aprovada pode ser aplicada.", { estado: p.estado });
        const conflito = await conflitoDeGranularidade(tx, cx, p);
        if (conflito) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Já existe receita do mesmo dia pela outra granularidade (agregado × por pedido): reverta uma antes de aplicar a outra.", { propostaId: conflito.id });
        const efeitos = await aplicar(tx, cx, p);
        const aplicada = await b.alterar(tx, cx, TIPO.PROPOSTA, p, { estado: E.APLICADA, efeitos }, EVENTO_HISTORICO.MUDANCA_ESTADO, c.justificativa);
        return { proposta: aplicada, efeitos, repetido: false };
      });
    },

    /**
     * Política agregado → por pedido: o efeito AGREGADO de um dia é revertido (lançamentos cancelados, nunca apagados) e a
     * proposta fica SUBSTITUÍDA — só então as vendas por pedido do mesmo dia podem ser aplicadas.
     */
    reverterPropostaAgregada(ctx, entrada) {
      const c = validarDecisao(entrada, { justificativaObrigatoria: true });
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const p = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaId, "Proposta");
        if (p.operacao !== OP.VENDA_AGREGADA || p.estado !== E.APLICADA) falhar(CODIGO.TRANSICAO_INVALIDA, "Só uma venda agregada aplicada pode ser revertida por aqui.");
        for (const e of p.efeitos.filter((x) => x.tipo === TIPO.LANCAMENTO)) await b.cancelarLancamento(tx, cx, e.id, c.justificativa);
        return b.alterar(tx, cx, TIPO.PROPOSTA, p, { estado: E.SUBSTITUIDA }, EVENTO_HISTORICO.SUBSTITUICAO, c.justificativa);
      });
    },

    /**
     * Substituição ATÔMICA do agregado de um dia pelos pedidos do mesmo dia: numa só transação (trava exclusiva do dia),
     * o efeito agregado é cancelado (não apagado), a proposta agregada fica SUBSTITUÍDA e cada pedido aprovado é aplicado.
     * Qualquer falha desfaz tudo; uma segunda substituição concorrente encontra o agregado já substituído e é recusada.
     */
    substituirAgregadoPorPedidos(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["propostaAgregadaId", "propostaIds", "justificativa"], "substituicao");
      const c = {
        propostaAgregadaId: exigirUuid(entrada.propostaAgregadaId, "propostaAgregadaId"),
        propostaIds: [...new Set(exigirLista(entrada.propostaIds, "propostaIds", { min: 1, max: 2000 }).map((id, i) => exigirUuid(id, `propostaIds[${i}]`)))],
        justificativa: exigirTexto(entrada.justificativa, "justificativa", { max: 500 }),
      };
      return b.executar(ctx, ACAO.REVISAR, async (cx, tx) => {
        const previa = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaAgregadaId, "Proposta agregada");
        await tx.travar(cx, `formacao-dia:${previa.dataOperacao}`, "EXCLUSIVA");
        const agregada = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, c.propostaAgregadaId, "Proposta agregada");
        if (agregada.operacao !== OP.VENDA_AGREGADA || agregada.estado !== E.APLICADA) falhar(CODIGO.TRANSICAO_INVALIDA, "O agregado não está aplicado (já substituído ou nunca aplicado).", { estado: agregada.estado });
        const pedidos = [];
        for (const id of c.propostaIds) {
          const p = await b.obterOuFalhar(tx, cx, TIPO.PROPOSTA, id, "Proposta de pedido");
          if (p.operacao !== OP.VENDA || p.dataOperacao !== agregada.dataOperacao || p.estado !== E.APROVADA) falhar(CODIGO.TRANSICAO_INVALIDA, "Só propostas de venda APROVADAS do mesmo dia substituem o agregado.", { propostaId: id });
          pedidos.push(p);
        }
        for (const e of agregada.efeitos.filter((x) => x.tipo === TIPO.LANCAMENTO)) await b.cancelarLancamento(tx, cx, e.id, c.justificativa);
        const substituida = await b.alterar(tx, cx, TIPO.PROPOSTA, agregada, { estado: E.SUBSTITUIDA }, EVENTO_HISTORICO.SUBSTITUICAO, c.justificativa);
        const aplicadas = [];
        for (const p of pedidos) {
          const efeitos = await aplicar(tx, cx, p);
          aplicadas.push(await b.alterar(tx, cx, TIPO.PROPOSTA, p, { estado: E.APLICADA, efeitos }, EVENTO_HISTORICO.MUDANCA_ESTADO, c.justificativa));
        }
        return { agregada: substituida, pedidos: aplicadas };
      });
    },

    listarPropostas(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["operacao", "estado", "importacaoId"], "consulta");
      return b.consultar(ctx, (cx, tx) => tx.listar(cx, TIPO.PROPOSTA, { onde: Object.fromEntries(Object.entries(entrada).filter(([, v]) => v !== undefined)) }));
    },

    /** Faturamento por dia × formas de pagamento (SAIPOS): totais, diferença POR DIA e formas atípicas — sem ajuste. */
    registrarDivergenciaEntreFontes(ctx, entrada) {
      const p = validarPeriodo(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const no = (r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dataReferencia >= p.periodoInicio && r.dataReferencia <= p.periodoFim;
        const saipos = await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS" }, predicado: no });
        const dias = saipos.filter((r) => r.tipoRegistro === "TOTAL_DIA");
        const formas = saipos.filter((r) => r.tipoRegistro === "TOTAL_FORMA");
        if (!dias.length || !formas.length) falhar(CODIGO.OPERACAO_INVALIDA, "Faltam relatórios do período (faturamento por dia e formas de pagamento).");
        const porDia = {};
        for (const r of dias) porDia[r.dataReferencia] = { faturamentoCentavos: r.valorCentavos, formasCentavos: 0 };
        for (const f of formas) for (const [d, v] of Object.entries(f.dados.porDia ?? {})) if (d >= p.periodoInicio && d <= p.periodoFim) (porDia[d] ??= { faturamentoCentavos: 0, formasCentavos: 0 }).formasCentavos = somar(porDia[d].formasCentavos, v);
        for (const d of Object.values(porDia)) d.diferencaCentavos = subtrair(d.faturamentoCentavos, d.formasCentavos);
        const faturamento = dias.reduce((s, r) => somar(s, r.valorCentavos), 0);
        const formasTotal = formas.reduce((s, r) => somar(s, r.valorCentavos), 0);
        const registroIds = [...dias, ...formas].map((r) => r.id).sort();
        const chave = `divergencia:SAIPOS_FATURAMENTO_X_FORMAS:${p.periodoInicio}:${p.periodoFim}:${hash(registroIds.join(","))}`;
        const existente = await tx.buscarPorChave(cx, TIPO.DIVERGENCIA_FONTE, chave);
        if (existente) return existente;
        const diferenca = subtrair(faturamento, formasTotal);
        return b.criar(tx, cx, TIPO.DIVERGENCIA_FONTE, {
          tipo: "SAIPOS_FATURAMENTO_X_FORMAS", periodoInicio: p.periodoInicio, periodoFim: p.periodoFim,
          totais: { faturamentoCentavos: faturamento, formasCentavos: formasTotal, diasComDiferenca: Object.values(porDia).filter((d) => d.diferencaCentavos !== 0).length },
          diferencaCentavos: diferenca, porDia,
          atipicos: formas.filter((f) => f.dados.anomalia).map((f) => ({ registroId: f.id, forma: f.dados.formaOriginal, anomalia: f.dados.anomalia, valorCentavos: f.valorCentavos })),
          explicacoes: [], estado: diferenca === 0 ? ESTADO_DIVERGENCIA_FONTE.RESOLVIDA : ESTADO_DIVERGENCIA_FONTE.ABERTA, registroIds, chaveIdempotencia: chave, impressao: null,
        });
      });
    },

    /** Explicação com evidência. Só explicações CONFIRMADAS somam; a divergência só se resolve quando elas cobrem a diferença inteira. */
    explicarDivergencia(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["divergenciaId", "data", "valorCentavos", "explicacao", "evidenciaDocumentoIds", "confirmada"], "explicacao");
      const c = {
        divergenciaId: exigirUuid(entrada.divergenciaId, "divergenciaId"), data: entrada.data ? exigirData(entrada.data, "data") : null,
        valorCentavos: exigirCentavos(entrada.valorCentavos, "valorCentavos"), explicacao: exigirTexto(entrada.explicacao, "explicacao", { max: 1000 }),
        evidenciaDocumentoIds: exigirLista(entrada.evidenciaDocumentoIds ?? [], "evidenciaDocumentoIds", { min: 0, max: 20 }).map((id, i) => exigirUuid(id, `evidenciaDocumentoIds[${i}]`)),
        confirmada: entrada.confirmada === true,
      };
      if (c.confirmada && !c.evidenciaDocumentoIds.length) falhar(CODIGO.ENTRADA_INVALIDA, "Explicação confirmada exige documento de evidência.");
      return b.executar(ctx, ACAO.REVISAR, async (cx, tx) => {
        const d = await b.obterOuFalhar(tx, cx, TIPO.DIVERGENCIA_FONTE, c.divergenciaId, "Divergência");
        for (const id of c.evidenciaDocumentoIds) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, id, "Documento de evidência");
        const explicacoes = [...d.explicacoes, { ...c, divergenciaId: undefined, registradaPor: cx.usuarioId, em: b.agora() }];
        const confirmado = explicacoes.filter((x) => x.confirmada).reduce((s, x) => somar(s, x.valorCentavos), 0);
        const estado = confirmado === d.diferencaCentavos ? ESTADO_DIVERGENCIA_FONTE.RESOLVIDA : explicacoes.length ? ESTADO_DIVERGENCIA_FONTE.EXPLICADA_PARCIALMENTE : ESTADO_DIVERGENCIA_FONTE.ABERTA;
        return b.alterar(tx, cx, TIPO.DIVERGENCIA_FONTE, d, { explicacoes, estado }, EVENTO_HISTORICO.CORRECAO, c.explicacao);
      });
    },

    /** Movimentações sem vínculo: saída sem obrigação = "pagamento a classificar"; entrada sem origem = "crédito a classificar". */
    listarPendenciasDeClassificacao(ctx, entrada) {
      const p = validarPeriodo(entrada);
      return b.consultar(ctx, async (cx, tx) => {
        const movs = await tx.listar(cx, TIPO.MOVIMENTACAO, { predicado: (m) => m.situacao === SITUACAO_MOVIMENTACAO.VALIDA && m.dataEfetiva >= p.periodoInicio && m.dataEfetiva <= p.periodoFim && m.alocadoCentavos < m.valorCentavos && !m.transferenciaId && !m.pagamentoId });
        const emprestimos = await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: OP.MOVIMENTACAO_BANCARIA }, predicado: (x) => x.divergencias.some((d) => d.codigo === "PRINCIPAL_E_JUROS_NAO_SEPARADOS") });
        return {
          movimentacoes: movs.map((m) => ({ movimentacaoId: m.id, sentido: m.sentido, dataEfetiva: m.dataEfetiva, valorCentavos: m.valorCentavos, pendenteCentavos: subtrair(m.valorCentavos, m.alocadoCentavos), motivo: m.sentido === "SAIDA" ? "PAGAMENTO_SEM_OBRIGACAO" : "CREDITO_SEM_ORIGEM" })),
          emprestimosSemDetalhamento: emprestimos.map((x) => ({ propostaId: x.id, valorCentavos: x.valorCentavos, dataOperacao: x.dataOperacao })),
        };
      });
    },

    /** Candidatas conta a pagar × saída bancária (valor igual ao saldo, saída depois da emissão). Sempre FRACA. */
    gerarCandidatasObrigacaoMovimentacao(ctx, entrada) {
      const p = validarPeriodo(entrada);
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const saidas = await tx.listar(cx, TIPO.MOVIMENTACAO, { predicado: (m) => m.situacao === SITUACAO_MOVIMENTACAO.VALIDA && m.sentido === "SAIDA" && m.alocadoCentavos === 0 && !m.transferenciaId && m.dataEfetiva >= p.periodoInicio && m.dataEfetiva <= p.periodoFim && m.documentoId });
        const abertas = await tx.listar(cx, TIPO.OBRIGACAO, { predicado: (o) => [SITUACAO_TITULO.ABERTA, SITUACAO_TITULO.PARCIAL].includes(o.situacao) });
        let criadas = 0;
        for (const m of saidas) {
          for (const o of abertas.filter((x) => x.saldoCentavos === m.valorCentavos && x.dataEmissao <= m.dataEfetiva)) {
            const chave = `${RELACAO_CORRESPONDENCIA.OBRIGACAO_X_MOVIMENTACAO}|${o.id}|${m.id}`;
            if (await tx.buscarPorChave(cx, TIPO.CORRESPONDENCIA, chave)) continue;
            // 06D: a competência da conciliação é a mais recente; se homologada, a candidata não nasce.
            const comps = [o.competencia, m.dataEfetiva.slice(0, 7)].sort();
            await tx.travar(cx, `competencia:${comps[1]}`, "COMPARTILHADA");
            if ((await b.competenciaAtual(tx, cx, comps[1]))?.estado === "FECHAMENTO_HOMOLOGADO") continue;
            await b.criar(tx, cx, TIPO.CORRESPONDENCIA, {
              ladoA: [{ tipo: TIPO.OBRIGACAO, id: o.id, valorCentavos: m.valorCentavos }], ladoB: [{ tipo: TIPO.MOVIMENTACAO, id: m.id, valorCentavos: m.valorCentavos }],
              evidenciaDocumentoIds: [...new Set([m.documentoId, ...(o.documentoIds ?? [])])], justificativa: "Proposta automática (SALDO_IGUAL_A_SAIDA).",
              diferencaCentavos: 0, situacao: SITUACAO_CORRESPONDENCIA.CANDIDATA, responsavelId: null, decididoEm: null, justificativaDecisao: null,
              relacao: RELACAO_CORRESPONDENCIA.OBRIGACAO_X_MOVIMENTACAO, regra: "SALDO_IGUAL_A_SAIDA", forca: "FRACA", chaveIdempotencia: chave, impressao: null,
              competencia: comps[0], competenciaDaConciliacao: comps[1],
            });
            criadas += 1;
          }
        }
        return { criadas };
      });
    },
  };
}
