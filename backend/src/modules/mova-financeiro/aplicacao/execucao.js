import { createHash } from "node:crypto";
// EXECUÇÃO das operações do MOVA (Agente 2 — Frente C): comprovante → obrigação → EXTRATO → POLÍTICA → liquidação → conciliação.
//
// Fluxo (cada passo testado):
//   1. a proposta de BAIXA já identificou a conta a pagar (motor, tratarPagamento);
//   2. conferência com o EXTRATO (leitura, previaDoVinculoDoExtrato): valor exato, data ±2 dias, ID da transação desempata;
//      ambíguo nunca escolhe; a proposta é ANOTADA com o resultado (CONFERIDA / AMBIGUA / AGUARDANDO_EXTRATO);
//   3. política de autonomia (empresa, unidade, operação, valor): sem política ⇒ só propõe;
//   4. liquidação SÓ pelo serviço oficial vincularPagamentoDoExtrato (a saída JÁ existe no extrato: nenhuma saída nova, a DRE
//      não muda, o banco não muda), com o comprovante anexado ao cofre do Financeiro (enviarEvidencia) — nunca pagamento bancário;
//   5. idempotência em duas camadas: chave da operação no MOVA + chave do vínculo no Financeiro; trava condicional da proposta;
//   6. pagamento parcial: permitido (valor ≤ saldo); a conta continua com o saldo restante;
//   7. divergência (prévia com bloqueio, pagamento antecipado, juros/multa): NÃO executa — volta para revisão humana com o motivo;
//   8. auditoria de tudo; reversão pelo estorno oficial (aprovacao.reverterOperacao), por responsável autorizado.
//   Execução 17 — SEM saída no extrato ainda: com política BAIXA_DOCUMENTAL e comprovante avaliado como PIX_CONCLUIDO, a conta
//   é registrada como PAGA POR COMPROVANTE (registrarPagamentoPorComprovante: nenhuma saída inventada; conciliação PENDENTE).
//   Quando o extrato chega, conciliarPendentes LIGA a saída à mesma baixa (conciliarPagamentoPorComprovante) — nunca 2ª baixa.
import { ErroTransitorio } from "../gateway/fila.js";
import { NIVEL, OPERACAO, conferirComExtrato, decidirAutonomia, validarPolitica } from "../dominio/autonomia.js";
import { avaliarComprovante } from "../dominio/comprovante.js";
import { ErroDeExecucao } from "./portaOperacional.js";
import { revalidarUnidadeDaProposta } from "../dominio/unidade.js";

/** Janela (dias) em que pagamentos ao mesmo favorecido somam para o limite da baixa documental (anti-fracionamento). */
export const JANELA_FRACIONAMENTO_DIAS = 3;

const curto = (id) => String(id ?? "").slice(0, 8);
const EXTENSAO = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * @param {{armazenamento:object, porta:object, operacional?:object|null, obterEvidencia:Function, relogio?:Function, registrar?:Function}} deps
 */
export function criarExecucao({ armazenamento: a, porta, identidadeLeitura, operacional = null, pagamentoPorComprovante = false, criarDespesas = false, registrarJuros = false, criarContas = false, obterEvidencia, descartarEvidencia = null, relogio = () => new Date(), registrar = () => {}, cfg = null }) {
  /**
   * 27/11: a unidade da proposta é REVALIDADA com a configuração ATUAL (cadastro de lojas, regras de marca) antes de qualquer
   * execução — automática, retomada ou confirmada pelo participante. Sem confirmação: nada é gravado; fica como proposta.
   */
  async function unidadeConfirmada(proposta) {
    if (!cfg) return { ok: true, motivo: null };
    const evento = proposta.eventoId ? await a.eventos.obter(proposta.eventoId) : null;
    const v = revalidarUnidadeDaProposta({ cfg, proposta, evento });
    if (!v.ok) {
      registrar({ tipo: "MOVA_UNIDADE_NAO_CONFIRMADA", motivo: v.motivo });
      await a.auditoria.registrar({ acao: "EXECUCAO_RECUSADA_UNIDADE", atorTipo: "SISTEMA", atorRef: "mova", alvo: proposta.id, dados: { motivo: v.motivo, contradiz: v.contradiz } });
    }
    return v;
  }
  // 24/11: conta a pagar NOVA a partir de boleto/nota (e o vínculo da nota com a conta existente) só com a chave própria.
  const contasLigadas = Boolean(criarContas);
  // 23/11: criar a conta a pagar (despesa sem conta prévia) só com as DUAS chaves: pagamento por comprovante e criação de despesas.
  const despesasLigadas = Boolean(pagamentoPorComprovante && criarDespesas);
  // 23/11: registrar juros/multa junto com o pagamento por comprovante só com as DUAS chaves (pagamento por comprovante + juros).
  const jurosLigados = Boolean(pagamentoPorComprovante && registrarJuros);
  const hoje = () => relogio().toISOString().slice(0, 10);
  // Leituras do Financeiro SEMPRE com a identidade de leitura do MOVA (o escopo pode vir da Central, sem usuário).
  const lendo = (escopo) => ({ organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, usuarioId: identidadeLeitura });

  async function politicasDe(organizacaoId) {
    if (typeof a.politicas?.listar !== "function") return [];
    const validas = [];
    for (const p of await a.politicas.listar(organizacaoId)) {
      try { validas.push(validarPolitica(p)); } catch { registrar({ tipo: "MOVA_POLITICA_INVALIDA_IGNORADA", politica: curto(p.id) }); }
    }
    return validas;
  }

  /** Passo 2: confere a proposta de baixa com as saídas do extrato (só leitura). */
  async function conferir(proposta, escopo) {
    const e = proposta.comando?.entrada;
    if (!e?.obrigacaoId) return { situacao: "AGUARDANDO_EXTRATO", candidatas: 0, movimentacaoId: null };
    const previa = await porta.ler("previaDoVinculoDoExtrato", lendo(escopo), { obrigacaoId: e.obrigacaoId });
    const idTransacao = proposta.leitura?.idTransacao ?? null;
    const saidas = (previa.saidasElegiveis ?? []).filter((s) => s.competenciaAceitaBaixa !== false).map((s) => ({
      id: s.id, data: s.data, disponivelCentavos: s.disponivelCentavos,
      idExterno: idTransacao && String(s.descricao ?? "").includes(idTransacao) ? idTransacao : null,
    }));
    return conferirComExtrato({ valorCentavos: proposta.valorCentavos, dataPagamento: e.dataEfetiva, idTransacao }, saidas);
  }

  /**
   * Passos 4–8: liquida UMA proposta de baixa pela saída do extrato. `executor` = porta operacional (automático) ou a pessoa
   * que confirmou na Central (executorDaPessoa). Nunca lança erro de regra: devolve { ok:false, motivo } e a proposta volta.
   */
  async function liquidar({ proposta, escopo, movimentacaoId, nivel, politicaId = null, executor }) {
    const e = proposta.comando?.entrada;
    if (proposta.tipo !== "BAIXA_DE_OBRIGACAO" || !e?.obrigacaoId) return { ok: false, motivo: "PROPOSTA_NAO_E_BAIXA" };
    if (!movimentacaoId) return { ok: false, motivo: "SEM_SAIDA_CONFERIDA" };
    // Idempotência (camada 1): a mesma proposta nunca liquida duas vezes; falha anterior libera nova tentativa (nova chave).
    let reserva = null;
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      const r = await a.operacoes.reservar({ chave: `${OPERACAO.BAIXA_POR_EXTRATO}|${proposta.id}#${tentativa}`, propostaId: proposta.id, organizacaoId: escopo.organizacaoId,
        unidadeId: escopo.unidadeId, operacao: OPERACAO.BAIXA_POR_EXTRATO, nivel, politicaId, valorCentavos: proposta.valorCentavos, executadaPor: executor.identidade });
      if (r.nova) { reserva = r.operacao; break; }
      if (r.operacao.estado !== "FALHOU") return { ok: r.operacao.estado === "EXECUTADA", repetida: true, operacao: r.operacao, motivo: `OPERACAO_${r.operacao.estado}` };
    }
    if (!reserva) return { ok: false, motivo: "TENTATIVAS_ESGOTADAS" };
    const tomada = await a.propostas.transicionar(escopo, proposta.id, "AGUARDANDO_REVISAO", "APLICANDO");
    if (!tomada) { await a.operacoes.falhar(reserva.id, "PROPOSTA_JA_DECIDIDA"); return { ok: false, motivo: "PROPOSTA_JA_DECIDIDA" }; }
    try {
      // Divergência: a prévia oficial (com a saída escolhida) não pode ter bloqueio, antecipação nem sobra de juros/multa.
      const previa = await porta.ler("previaDoVinculoDoExtrato", lendo(escopo), { obrigacaoId: e.obrigacaoId, movimentacaoId, valorCentavos: proposta.valorCentavos });
      const esc = previa.escolhida;
      if (!esc) throw new ErroDeExecucao("SAIDA_NAO_ENCONTRADA");
      if (esc.bloqueios?.length) throw new ErroDeExecucao("PREVIA_COM_BLOQUEIO", { bloqueios: esc.bloqueios });
      if (esc.antecipacao) throw new ErroDeExecucao("PAGAMENTO_ANTECIPADO_EXIGE_REVISAO");
      if (esc.juros) throw new ErroDeExecucao("DIFERENCA_DE_JUROS_EXIGE_REVISAO");
      // 26/11 — o comprovante recebido NÃO é arquivado (só entregadores têm arquivo permanente): a evidência do vínculo é a saída do
      // extrato importado, conferida acima; os dados do comprovante (hash, identificador) ficam na proposta e na auditoria.
      const r = await executor.chamar("vincularPagamentoDoExtrato", escopo, {
        movimentacaoId, versaoMovimentacao: esc.versao, alocacoes: [{ obrigacaoId: e.obrigacaoId, valorCentavos: proposta.valorCentavos }], comprovanteSemArquivo: await dadosDoComprovante(proposta),
        justificativa: `Baixa pelo MOVA: comprovante conferido com a saída do extrato de ${esc.data} (${nivel === NIVEL.APLICAR_AUTOMATICO ? "política de autonomia" : "confirmada por responsável"}).`,
        confirmar: true,
      });
      const resultado = { obrigacaoId: e.obrigacaoId, movimentacaoId, documentoId: null, comprovanteArquivado: false, liquidacaoIds: (r.liquidacoes ?? []).map((l) => l.id), repetidoNoFinanceiro: Boolean(r.repetido),
        parcial: proposta.parcial === true, dataSaida: esc.data, saldoDepoisCentavos: esc.efeito?.obrigacao?.saldoDepoisCentavos ?? null };
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "APLICADA", resultado);
      await descartarArquivo(proposta, escopo);
      const operacao = await a.operacoes.concluir(reserva.id, resultado);
      await a.auditoria.registrar({ acao: "OPERACAO_EXECUTADA", atorTipo: nivel === NIVEL.APLICAR_AUTOMATICO ? "SISTEMA" : "USUARIO", atorRef: executor.identidade, alvo: proposta.id,
        dados: { operacao: OPERACAO.BAIXA_POR_EXTRATO, nivel, politicaId, valorCentavos: proposta.valorCentavos, movimentacaoId, liquidacoes: resultado.liquidacaoIds.length } });
      return { ok: true, operacao, resultado };
    } catch (erro) {
      const codigo = erro?.codigo ?? (erro instanceof ErroTransitorio ? "FINANCEIRO_INDISPONIVEL" : "FALHA_NA_EXECUCAO");
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "AGUARDANDO_REVISAO");
      await a.operacoes.falhar(reserva.id, codigo);
      await a.auditoria.registrar({ acao: "OPERACAO_FALHOU", atorTipo: nivel === NIVEL.APLICAR_AUTOMATICO ? "SISTEMA" : "USUARIO", atorRef: executor.identidade, alvo: proposta.id, dados: { codigo, detalhes: erro?.detalhes ?? null } });
      registrar({ tipo: "MOVA_OPERACAO_FALHOU", codigo });
      return { ok: false, motivo: codigo, detalhes: erro?.detalhes ?? null };
    }
  }

  /** Reserva idempotente da operação (camada 1): a mesma proposta nunca executa duas vezes; falha libera nova tentativa. */
  async function reservar(operacao, proposta, escopo, nivel, politicaId, executor) {
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      const r = await a.operacoes.reservar({ chave: `${operacao}|${proposta.id}#${tentativa}`, propostaId: proposta.id, organizacaoId: escopo.organizacaoId,
        unidadeId: escopo.unidadeId, operacao, nivel, politicaId, valorCentavos: proposta.valorCentavos, executadaPor: executor.identidade });
      if (r.nova) return { reserva: r.operacao };
      if (r.operacao.estado !== "FALHOU") return { repetida: { ok: r.operacao.estado === "EXECUTADA", repetida: true, operacao: r.operacao, motivo: `OPERACAO_${r.operacao.estado}` } };
    }
    return { repetida: { ok: false, motivo: "TENTATIVAS_ESGOTADAS" } };
  }

  /**
   * Execução 17 — PAGAMENTO POR COMPROVANTE (sem saída do extrato): anexa o comprovante ao cofre do Financeiro e registra o
   * pagamento da conta pelo serviço oficial. Nenhuma saída bancária é criada; a conciliação fica PENDENTE.
   */
  async function pagarPorComprovante({ proposta, escopo, nivel, politicaId = null, executor }) {
    const e = proposta.comando?.entrada;
    if (proposta.tipo !== "BAIXA_DE_OBRIGACAO" || !e?.obrigacaoId) return { ok: false, motivo: "PROPOSTA_NAO_E_BAIXA" };
    const { reserva, repetida } = await reservar(OPERACAO.BAIXA_DOCUMENTAL, proposta, escopo, nivel, politicaId, executor);
    if (repetida) return repetida;
    const tomada = await a.propostas.transicionar(escopo, proposta.id, "AGUARDANDO_REVISAO", "APLICANDO");
    if (!tomada) { await a.operacoes.falhar(reserva.id, "PROPOSTA_JA_DECIDIDA"); return { ok: false, motivo: "PROPOSTA_JA_DECIDIDA" }; }
    try {
      const resultado = await anexarEPagar({ proposta, escopo, obrigacaoId: e.obrigacaoId, dataPagamento: e.dataEfetiva, nivel, executor });
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "APLICADA", resultado);
      await descartarArquivo(proposta, escopo);
      const operacao = await a.operacoes.concluir(reserva.id, resultado);
      await a.auditoria.registrar({ acao: "OPERACAO_EXECUTADA", atorTipo: nivel === NIVEL.APLICAR_AUTOMATICO ? "SISTEMA" : "USUARIO", atorRef: executor.identidade, alvo: proposta.id,
        dados: { operacao: OPERACAO.BAIXA_DOCUMENTAL, nivel, politicaId, valorCentavos: proposta.valorCentavos, movimentacaoId: null, liquidacoes: 1, conciliacao: "PENDENTE" } });
      return { ok: true, operacao, resultado };
    } catch (erro) {
      const codigo = erro?.codigo ?? (erro instanceof ErroTransitorio ? "FINANCEIRO_INDISPONIVEL" : "FALHA_NA_EXECUCAO");
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "AGUARDANDO_REVISAO");
      await a.operacoes.falhar(reserva.id, codigo);
      await a.auditoria.registrar({ acao: "OPERACAO_FALHOU", atorTipo: nivel === NIVEL.APLICAR_AUTOMATICO ? "SISTEMA" : "USUARIO", atorRef: executor.identidade, alvo: proposta.id, dados: { operacao: OPERACAO.BAIXA_DOCUMENTAL, codigo, detalhes: erro?.detalhes ?? null } });
      registrar({ tipo: "MOVA_OPERACAO_FALHOU", codigo });
      return { ok: false, motivo: codigo, detalhes: erro?.detalhes ?? null };
    }
  }

  /**
   * Anexa o comprovante da proposta ao cofre do Financeiro (ligado à conta) e registra o PAGAMENTO POR COMPROVANTE da conta.
   * Usado pela baixa documental (automática ou confirmada) e pela aprovação humana da despesa paga com comprovante.
   */
  /**
   * 26/11 — comprovante COMUM: o arquivo recebido é conferido (existe e bate com o hash) e só os DADOS vão ao Financeiro
   * (hash, formato, tamanho). Nada é arquivado e nenhum anexo é simulado: só as notas dos entregadores têm arquivo permanente.
   */
  /**
   * 26/11 — RETENÇÃO TEMPORÁRIA: concluída a operação, o arquivo do comprovante comum é descartado (o conteúdo; ficam hash, dados
   * extraídos, identificador da transação e auditoria). Não descarta se outra proposta ainda aberta usa o mesmo arquivo. Uma falha
   * aqui nunca desfaz nem repete a operação financeira (o expurgo por validade recolhe o que sobrar).
   */
  async function descartarArquivo(proposta, escopo) {
    if (!descartarEvidencia || !proposta.evidencia?.referencia) return;
    try {
      const emUso = (await a.propostas.listar(escopo)).some((p) => p.id !== proposta.id && p.evidencia?.sha256 === proposta.evidencia.sha256 && ["AGUARDANDO_REVISAO", "APLICANDO"].includes(p.estado));
      if (emUso) return;
      if (await descartarEvidencia(proposta.evidencia.referencia)) await a.auditoria.registrar({ acao: "EVIDENCIA_DESCARTADA", atorTipo: "SISTEMA", atorRef: "retencao-temporaria", alvo: proposta.id, dados: { motivo: "OPERACAO_CONCLUIDA" } });
    } catch { registrar({ tipo: "MOVA_DESCARTE_FALHOU" }); }
  }

  async function dadosDoComprovante(proposta) {
    const bytes = proposta.evidencia?.referencia ? await obterEvidencia(proposta.evidencia.referencia) : null;
    if (!bytes) throw new ErroDeExecucao("SEM_EVIDENCIA_DO_COMPROVANTE");
    return { hashSha256: createHash("sha256").update(bytes).digest("hex"), tipoMime: proposta.evidencia.mime, tamanhoBytes: bytes.length };
  }

  async function anexarEPagar({ proposta, escopo, obrigacaoId, dataPagamento, nivel, executor }) {
    const r = await executor.chamar("registrarPagamentoPorComprovante", escopo, {
      obrigacaoId, valorCentavos: proposta.valorCentavos, dataPagamento, comprovanteSemArquivo: await dadosDoComprovante(proposta), idTransacao: proposta.leitura?.idTransacao ?? null,
      justificativa: `Pago por comprovante pelo MOVA (${nivel === NIVEL.APLICAR_AUTOMATICO ? "política de baixa documental" : "confirmado por responsável"}); conciliação com o extrato pendente.`,
      confirmar: true,
    });
    return { obrigacaoId, movimentacaoId: null, documentoId: null, comprovanteArquivado: false, liquidacaoIds: [r.liquidacao.id], repetidoNoFinanceiro: Boolean(r.repetido), favorecido: proposta.leitura?.favorecido ?? null,
      parcial: proposta.parcial === true, dataPagamento, saldoDepoisCentavos: r.titulo?.saldoCentavos ?? null, situacaoPagamento: "PAGO_POR_COMPROVANTE", conciliacao: "CONCILIACAO_PENDENTE" };
  }

  /**
   * 24/11 — compra NOVA já paga: a conta (despesa na competência), o comprovante e o pagamento por comprovante (data do pagamento,
   * sem saída bancária) numa ÚNICA operação atômica do Financeiro. Se qualquer parte falhar, nada fica gravado (antes, uma falha no
   * pagamento deixava a conta em aberto). Idempotente: mesma fonte (MOVA:<proposta>) e mesmo arquivo devolvem o que já existe.
   */
  async function registrarDespesaPaga({ proposta, escopo, entrada = proposta.comando.entrada, dataPagamento = proposta.comando.pagamento.dataEfetiva, nivel, executor }) {
    const bytes = proposta.evidencia?.referencia ? await obterEvidencia(proposta.evidencia.referencia) : null;
    if (!bytes) throw new ErroDeExecucao("SEM_EVIDENCIA_DO_COMPROVANTE");
    const mime = proposta.evidencia.mime;
    const encargos = proposta.comando?.encargos ?? null;
    const r = await executor.chamar(encargos ? "registrarDespesaPagaComEncargo" : "registrarDespesaPagaPorComprovante", escopo, {
      ...(encargos ? { encargos: { jurosCentavos: encargos.jurosCentavos, multaCentavos: encargos.multaCentavos } } : {}),
      obrigacao: { ...entrada, fonte: { sistema: "MANUAL", idExterno: `MOVA:${proposta.id}` } },
      comprovante: { arquivo: { conteudo: bytes, nome: `comprovante-mova-${curto(proposta.id)}.${EXTENSAO[mime] ?? "bin"}`, tipoMime: mime },
        descricao: `Comprovante recebido pelo MOVA (proposta ${curto(proposta.id)})`, competencia: proposta.datas?.competencia ?? null, arquivar: false },
      pagamento: { dataPagamento, idTransacao: proposta.leitura?.idTransacao ?? null, confirmar: true,
        justificativa: `Compra paga registrada pelo MOVA (${nivel === NIVEL.APLICAR_AUTOMATICO ? "política de despesa documental" : "confirmada por responsável"}); conciliação com o extrato pendente.` },
    });
    return { obrigacaoId: r.obrigacao.id, movimentacaoId: null, documentoId: r.documento?.id ?? null, comprovanteArquivado: Boolean(r.documento), liquidacaoIds: [r.liquidacao.id], repetidoNoFinanceiro: Boolean(r.repetido),
      favorecido: proposta.leitura?.favorecido ?? null, parcial: false, dataPagamento, saldoDepoisCentavos: r.obrigacao.saldoCentavos ?? 0, situacaoPagamento: "PAGO_POR_COMPROVANTE",
      conciliacao: "CONCILIACAO_PENDENTE", despesaCriada: r.efeito?.novasDespesas === 1, lancamentoId: r.lancamento?.id ?? null, categoria: entrada.categoria ?? null,
      ...(encargos ? { principalCentavos: r.efeito?.principalCentavos ?? encargos.principalCentavos, jurosCentavos: r.efeito?.jurosCentavos ?? encargos.jurosCentavos,
        multaCentavos: r.efeito?.multaCentavos ?? encargos.multaCentavos, encargoCentavos: r.efeito?.encargoCentavos ?? encargos.encargoCentavos, pagoCentavos: r.efeito?.pagoCentavos ?? null,
        vencimento: r.obrigacao?.vencimento ?? entrada.vencimento ?? null, situacaoConta: r.obrigacao?.situacao ?? null } : {}) };
  }

  /** Avaliação do comprovante guardada na proposta (ou refeita pela leitura, se a proposta é anterior à Execução 17). */
  const comprovanteDa = (proposta) => proposta.leitura?.comprovante ?? (proposta.evidencia ? avaliarComprovante(proposta.leitura, { hoje: hoje() }) : null);

  /**
   * Depois de criar a proposta de baixa (motor) ou numa reconferência (rotina): confere o extrato, decide pela política e,
   * se a política autorizar e houver identidade operacional com concessão, liquida. Falha de leitura NÃO derruba a mensagem:
   * a proposta fica aguardando extrato e é reconferida depois.
   * @returns {Promise<{situacao:"EXECUTADA"|"CONFERIDA"|"AMBIGUA"|"AGUARDANDO_EXTRATO", nivel:string, motivos:string[], resultado?:object, motivo?:string}>}
   */
  async function aposBaixa(proposta, escopo) {
    const u = await unidadeConfirmada(proposta);
    if (!u.ok) return { situacao: "AGUARDANDO_EXTRATO", nivel: NIVEL.SOMENTE_PROPOR, motivos: [u.motivo] };
    let conciliacao;
    try { conciliacao = await conferir(proposta, escopo); } catch (e) {
      registrar({ tipo: "MOVA_CONFERENCIA_ADIADA", codigo: e?.codigo ?? "LEITURA_FALHOU" });
      return { situacao: "AGUARDANDO_EXTRATO", nivel: NIVEL.SOMENTE_PROPOR, motivos: ["CONFERENCIA_ADIADA"] };
    }
    const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.BAIXA_POR_EXTRATO, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: proposta.valorCentavos, hoje: hoje(), conciliacao });
    const anotada = await a.propostas.anotar(escopo, proposta.id, {
      conciliacao: { situacao: conciliacao.situacao, movimentacaoId: conciliacao.movimentacaoId, candidatas: conciliacao.candidatas, idTransacao: proposta.leitura?.idTransacao ?? null, conferidaEm: relogio().toISOString() },
      autonomia: decisao,
    });
    const base = { situacao: conciliacao.situacao, nivel: decisao.nivel, motivos: decisao.motivos, movimentacaoId: conciliacao.movimentacaoId };
    // Execução 17: sem a saída no extrato (ainda), a baixa DOCUMENTAL pode registrar o pagamento pelo comprovante.
    // Execução 17: pagamento por comprovante só com a chave própria (MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE); desligada, fica como antes.
    if (pagamentoPorComprovante && conciliacao.situacao === "AGUARDANDO_EXTRATO" && proposta.evidencia) return documental(anotada ?? proposta, escopo, base);
    if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO) return base;
    if (!operacional) return { ...base, motivos: [...decisao.motivos, "SEM_IDENTIDADE_OPERACIONAL"] };
    if (!(await operacional.pode("vincularPagamentoDoExtrato", escopo))) return { ...base, motivos: [...decisao.motivos, "SEM_CONCESSAO_OPERACIONAL"] };
    const r = await liquidar({ proposta: anotada ?? proposta, escopo, movimentacaoId: conciliacao.movimentacaoId, nivel: NIVEL.APLICAR_AUTOMATICO, politicaId: decisao.politicaId, executor: operacional });
    return r.ok ? { ...base, situacao: "EXECUTADA", resultado: r.resultado } : { ...base, motivos: [...decisao.motivos, r.motivo], motivo: r.motivo };
  }

  /**
   * Anti-fracionamento: soma do que o MOVA já baixou por comprovante (operações executadas, não revertidas) na MESMA conta ou ao
   * MESMO favorecido com data de pagamento a até JANELA_FRACIONAMENTO_DIAS. Determinístico; não lê o Financeiro.
   */
  async function acumuladoDocumental(escopo, proposta) {
    if (!a.operacoes?.listar) return 0;
    const norm = (s) => (typeof s === "string" ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "");
    const dia = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 86400000 : null);
    const conta = proposta.comando?.entrada?.obrigacaoId ?? null; // despesa nova: sem conta; soma pelo favorecido
    const fav = norm(proposta.leitura?.favorecido);
    // Despesa nova: a data do pagamento fica em comando.pagamento (a entrada é a da conta a pagar).
    const data = dia(proposta.leitura?.dataPagamento ?? proposta.comando?.entrada?.dataEfetiva ?? proposta.comando?.pagamento?.dataEfetiva ?? proposta.datas?.caixa ?? null);
    return (await a.operacoes.listar(escopo))
      .filter((o) => [OPERACAO.BAIXA_DOCUMENTAL, OPERACAO.DESPESA_DOCUMENTAL].includes(o.operacao) && o.estado === "EXECUTADA" && o.propostaId !== proposta.id)
      .filter((o) => (conta && o.resultado?.obrigacaoId === conta)
        || (fav && norm(o.resultado?.favorecido) === fav && data !== null && dia(o.resultado?.dataPagamento) !== null && Math.abs(dia(o.resultado.dataPagamento) - data) <= JANELA_FRACIONAMENTO_DIAS))
      .reduce((s, o) => s + (Number.isSafeInteger(o.valorCentavos) ? o.valorCentavos : 0), 0);
  }

  async function documental(proposta, escopo, base) {
    const comprovante = comprovanteDa(proposta);
    const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.BAIXA_DOCUMENTAL, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: proposta.valorCentavos, hoje: hoje(), conciliacao: { situacao: base.situacao }, comprovante,
      acumuladoCentavos: await acumuladoDocumental(escopo, proposta) });
    await a.propostas.anotar(escopo, proposta.id, { autonomiaDocumental: decisao, comprovante });
    const doc = { ...base, nivelDocumental: decisao.nivel, motivosDocumentais: decisao.motivos, comprovante: comprovante?.situacao ?? null };
    if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO) return doc;
    if (!operacional) return { ...doc, motivosDocumentais: [...decisao.motivos, "SEM_IDENTIDADE_OPERACIONAL"] };
    if (!(await operacional.pode("registrarPagamentoPorComprovante", escopo))) return { ...doc, motivosDocumentais: [...decisao.motivos, "SEM_CONCESSAO_OPERACIONAL"] };
    const r = await pagarPorComprovante({ proposta, escopo, nivel: NIVEL.APLICAR_AUTOMATICO, politicaId: decisao.politicaId, executor: operacional });
    return r.ok ? { ...doc, situacao: "PAGO_POR_COMPROVANTE", resultado: r.resultado } : { ...doc, motivosDocumentais: [...decisao.motivos, r.motivo], motivo: r.motivo };
  }

  /**
   * 23/11 — DESPESA SEM CONTA PRÉVIA paga por comprovante (proposta DESPESA_PAGA com arquivo). Com as duas chaves, a política
   * DESPESA_DOCUMENTAL automática e a identidade operacional com `registrar_obrigacao` + `baixar_por_comprovante` +
   * `enviar_documento`, a rotina: (1) registra a conta a pagar pelo serviço oficial (uma parcela, despesa, fonte MOVA:<proposta>
   * — idempotente), (2) anexa o comprovante a ela e (3) registra o pagamento POR COMPROVANTE (conciliação pendente). Qualquer
   * falha volta a proposta para revisão; a nova tentativa reaproveita o que já foi gravado (mesma fonte, mesmo arquivo).
   */
  async function aposDespesaNova(proposta, escopo) {
    const base = { situacao: "PROPOSTA", nivel: NIVEL.SOMENTE_PROPOR, motivos: [] };
    const u = await unidadeConfirmada(proposta);
    if (!u.ok) return { ...base, motivos: [u.motivo] };
    if (!despesasLigadas) return { ...base, motivos: ["CRIACAO_DE_DESPESAS_DESLIGADA"] };
    if (proposta.tipo !== "DESPESA_PAGA" || !proposta.evidencia) return { ...base, motivos: ["SEM_COMPROVANTE"] };
    if (proposta.competenciaPendente || !proposta.comando?.entrada?.competencia) return { ...base, motivos: ["COMPETENCIA_PENDENTE"] };
    const comprovante = comprovanteDa(proposta);
    const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.DESPESA_DOCUMENTAL, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: proposta.valorCentavos, hoje: hoje(), conciliacao: { situacao: "AGUARDANDO_EXTRATO" }, comprovante,
      acumuladoCentavos: await acumuladoDocumental(escopo, proposta) });
    await a.propostas.anotar(escopo, proposta.id, { autonomiaDocumental: decisao, comprovante });
    // 25/11: juros/multa comprovados no documento — o ENCARGO tem a sua política (JUROS_DOCUMENTAL) e exige `registrar_juros`.
    const encargos = proposta.comando?.encargos ?? null;
    const doEncargo = encargos ? decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.JUROS_DOCUMENTAL, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: encargos.encargoCentavos, hoje: hoje(), conciliacao: { situacao: "AGUARDANDO_EXTRATO" }, comprovante }) : null;
    if (doEncargo) await a.propostas.anotar(escopo, proposta.id, { autonomiaJuros: doEncargo });
    const motivos0 = [...new Set([...decisao.motivos, ...(doEncargo?.motivos ?? [])])];
    const r0 = { ...base, nivel: decisao.nivel, nivelDocumental: decisao.nivel, motivos: motivos0, motivosDocumentais: motivos0, comprovante: comprovante?.situacao ?? null };
    if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO || (doEncargo && doEncargo.nivel !== NIVEL.APLICAR_AUTOMATICO)) return r0;
    if (!operacional) return { ...r0, motivosDocumentais: [...motivos0, "SEM_IDENTIDADE_OPERACIONAL"] };
    if (!(await operacional.pode(encargos ? "registrarDespesaPagaComEncargo" : "registrarDespesaPagaPorComprovante", escopo))) return { ...r0, motivosDocumentais: [...motivos0, "SEM_CONCESSAO_OPERACIONAL"] };
    const { reserva, repetida } = await reservar(OPERACAO.DESPESA_DOCUMENTAL, proposta, escopo, NIVEL.APLICAR_AUTOMATICO, decisao.politicaId, operacional);
    if (repetida) return { ...r0, ...(repetida.ok ? { situacao: "PAGO_POR_COMPROVANTE", resultado: repetida.operacao?.resultado } : { motivo: repetida.motivo }) };
    const tomada = await a.propostas.transicionar(escopo, proposta.id, "AGUARDANDO_REVISAO", "APLICANDO");
    if (!tomada) { await a.operacoes.falhar(reserva.id, "PROPOSTA_JA_DECIDIDA"); return { ...r0, motivo: "PROPOSTA_JA_DECIDIDA" }; }
    try {
      const resultado = await registrarDespesaPaga({ proposta, escopo, nivel: NIVEL.APLICAR_AUTOMATICO, executor: operacional });
      const { obrigacaoId } = resultado;
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "APLICADA", resultado);
      await descartarArquivo(proposta, escopo);
      const operacao = await a.operacoes.concluir(reserva.id, resultado);
      await a.auditoria.registrar({ acao: "OPERACAO_EXECUTADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id,
        dados: { operacao: OPERACAO.DESPESA_DOCUMENTAL, nivel: NIVEL.APLICAR_AUTOMATICO, politicaId: decisao.politicaId, valorCentavos: proposta.valorCentavos, obrigacaoId, movimentacaoId: null, conciliacao: "PENDENTE" } });
      return { ...r0, situacao: "PAGO_POR_COMPROVANTE", resultado, operacao };
    } catch (erro) {
      const codigo = erro?.codigo ?? (erro instanceof ErroTransitorio ? "FINANCEIRO_INDISPONIVEL" : "FALHA_NA_EXECUCAO");
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "AGUARDANDO_REVISAO");
      await a.operacoes.falhar(reserva.id, codigo);
      await a.auditoria.registrar({ acao: "OPERACAO_FALHOU", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id, dados: { operacao: OPERACAO.DESPESA_DOCUMENTAL, codigo, detalhes: erro?.detalhes ?? null } });
      registrar({ tipo: "MOVA_OPERACAO_FALHOU", codigo });
      return { ...r0, motivo: codigo, motivosDocumentais: [...decisao.motivos, codigo] };
    }
  }

  /**
   * 23/11 — PAGAMENTO COM JUROS/MULTA confirmados pela pessoa (proposta BAIXA com `comando.juros`): anexa o comprovante e registra, numa
   * só transação do Financeiro, o encargo (ajuste de juros e multas) e o pagamento por comprovante do TOTAL (conciliação pendente).
   * Exige as duas chaves, as DUAS políticas automáticas (JUROS_DOCUMENTAL: limite = encargo máximo; BAIXA_DOCUMENTAL: limite do
   * pagamento) e a identidade operacional com `registrar_juros`. Nunca cria segunda conta, saída ou segundo pagamento.
   */
  async function aposJuros(proposta, escopo) {
    const base = { situacao: "PROPOSTA", nivel: NIVEL.SOMENTE_PROPOR, motivos: [] };
    const u = await unidadeConfirmada(proposta);
    if (!u.ok) return { ...base, motivos: [u.motivo] };
    if (!jurosLigados) return { ...base, motivos: ["REGISTRO_DE_JUROS_DESLIGADO"] };
    const juros = proposta.comando?.juros;
    const e = proposta.comando?.entrada;
    if (proposta.tipo !== "BAIXA_DE_OBRIGACAO" || !proposta.evidencia || !(juros?.valorCentavos > 0) || !e?.obrigacaoId) return { ...base, motivos: ["SEM_COMPROVANTE_OU_ENCARGO"] };
    const comprovante = comprovanteDa(proposta);
    const politicas = await politicasDe(escopo.organizacaoId);
    const comum = { politicas, organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, hoje: hoje(), conciliacao: { situacao: "AGUARDANDO_EXTRATO" }, comprovante };
    const doEncargo = decidirAutonomia({ ...comum, operacao: OPERACAO.JUROS_DOCUMENTAL, valorCentavos: juros.valorCentavos });
    const doPagamento = decidirAutonomia({ ...comum, operacao: OPERACAO.BAIXA_DOCUMENTAL, valorCentavos: proposta.valorCentavos, acumuladoCentavos: await acumuladoDocumental(escopo, proposta) });
    await a.propostas.anotar(escopo, proposta.id, { autonomiaDocumental: doPagamento, autonomiaJuros: doEncargo, comprovante });
    const motivos = [...new Set([...doEncargo.motivos, ...doPagamento.motivos])];
    const r0 = { ...base, nivel: doEncargo.nivel, nivelDocumental: doPagamento.nivel, motivos, motivosDocumentais: motivos, comprovante: comprovante?.situacao ?? null };
    if (doEncargo.nivel !== NIVEL.APLICAR_AUTOMATICO || doPagamento.nivel !== NIVEL.APLICAR_AUTOMATICO) return r0;
    if (!operacional) return { ...r0, motivosDocumentais: [...motivos, "SEM_IDENTIDADE_OPERACIONAL"] };
    for (const op of ["registrarPagamentoComEncargo"]) {
      if (!(await operacional.pode(op, escopo))) return { ...r0, motivosDocumentais: [...motivos, "SEM_CONCESSAO_OPERACIONAL"] };
    }
    const { reserva, repetida } = await reservar(OPERACAO.JUROS_DOCUMENTAL, proposta, escopo, NIVEL.APLICAR_AUTOMATICO, doEncargo.politicaId, operacional);
    if (repetida) return { ...r0, ...(repetida.ok ? { situacao: "PAGO_POR_COMPROVANTE", resultado: repetida.operacao?.resultado } : { motivo: repetida.motivo }) };
    const tomada = await a.propostas.transicionar(escopo, proposta.id, "AGUARDANDO_REVISAO", "APLICANDO");
    if (!tomada) { await a.operacoes.falhar(reserva.id, "PROPOSTA_JA_DECIDIDA"); return { ...r0, motivo: "PROPOSTA_JA_DECIDIDA" }; }
    try {
      const r = await operacional.chamar("registrarPagamentoComEncargo", escopo, {
        obrigacaoId: e.obrigacaoId, valorCentavos: proposta.valorCentavos, encargoCentavos: juros.valorCentavos, tipoEncargo: juros.tipoEncargo ?? "JUROS", dataPagamento: e.dataEfetiva,
        comprovanteSemArquivo: await dadosDoComprovante(proposta), idTransacao: proposta.leitura?.idTransacao ?? null,
        justificativa: (juros.confirmadoPor === "COMPROVANTE" ? `Pago por comprovante pelo MOVA com encargos discriminados no comprovante (juros ${juros.jurosCentavos ?? 0} e multa ${juros.multaCentavos ?? 0} centavos; política de autonomia); conciliação com o extrato pendente.` : `Pago por comprovante pelo MOVA com juros/multa confirmados pelo remetente (política de autonomia); conciliação com o extrato pendente.`), confirmar: true,
      });
      const resultado = { obrigacaoId: e.obrigacaoId, movimentacaoId: null, documentoId: null, comprovanteArquivado: false, liquidacaoIds: [r.liquidacao.id], repetidoNoFinanceiro: Boolean(r.repetido),
        favorecido: proposta.leitura?.favorecido ?? null, parcial: false, dataPagamento: e.dataEfetiva, saldoDepoisCentavos: r.titulo?.saldoCentavos ?? null,
        situacaoPagamento: "PAGO_POR_COMPROVANTE", conciliacao: "CONCILIACAO_PENDENTE", encargoCentavos: juros.valorCentavos, principalCentavos: proposta.valorCentavos - juros.valorCentavos };
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "APLICADA", resultado);
      await descartarArquivo(proposta, escopo);
      const operacao = await a.operacoes.concluir(reserva.id, resultado);
      await a.auditoria.registrar({ acao: "OPERACAO_EXECUTADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id,
        dados: { operacao: OPERACAO.JUROS_DOCUMENTAL, nivel: NIVEL.APLICAR_AUTOMATICO, politicaId: doEncargo.politicaId, valorCentavos: proposta.valorCentavos, encargoCentavos: juros.valorCentavos, obrigacaoId: e.obrigacaoId, movimentacaoId: null, conciliacao: "PENDENTE" } });
      return { ...r0, situacao: "PAGO_POR_COMPROVANTE", resultado, operacao };
    } catch (erro) {
      const codigo = erro?.codigo ?? (erro instanceof ErroTransitorio ? "FINANCEIRO_INDISPONIVEL" : "FALHA_NA_EXECUCAO");
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "AGUARDANDO_REVISAO");
      await a.operacoes.falhar(reserva.id, codigo);
      await a.auditoria.registrar({ acao: "OPERACAO_FALHOU", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id, dados: { operacao: OPERACAO.JUROS_DOCUMENTAL, codigo, detalhes: erro?.detalhes ?? null } });
      registrar({ tipo: "MOVA_OPERACAO_FALHOU", codigo });
      return { ...r0, motivo: codigo, motivosDocumentais: [...motivos, codigo] };
    }
  }

  /**
   * Execução 17 — o extrato chegou: cada pagamento POR COMPROVANTE ainda pendente com UMA saída candidata (mesmo valor, data
   * na tolerância) é CONCILIADO com a mesma baixa, se a política BAIXA_POR_EXTRATO for automática e a identidade operacional
   * tiver a concessão. Ambíguo ou sem extrato: fica na Central para o financeiro. Nunca cria segunda baixa ou saída.
   */
  async function conciliarPendentes(escopo) {
    if (!pagamentoPorComprovante) return [];
    const r = await porta.ler("consultarPagamentosPorComprovanteAConciliar", lendo(escopo), {});
    const resultados = [];
    for (const item of r.itens ?? []) {
      if (item.situacao !== "CANDIDATA_UNICA") { resultados.push({ liquidacaoId: item.liquidacaoId, situacao: item.situacao }); continue; }
      const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.BAIXA_POR_EXTRATO, organizacaoId: escopo.organizacaoId,
        unidadeId: escopo.unidadeId, valorCentavos: item.valorCentavos, hoje: hoje(), conciliacao: { situacao: "CONFERIDA" } });
      const [saida] = item.candidatas;
      if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO || !operacional || !(await operacional.pode("conciliarPagamentoPorComprovante", escopo))) {
        resultados.push({ liquidacaoId: item.liquidacaoId, situacao: "CONCILIACAO_A_CONFIRMAR", movimentacaoId: saida.movimentacaoId, motivos: decisao.motivos });
        continue;
      }
      try {
        const k = await operacional.chamar("conciliarPagamentoPorComprovante", escopo, { liquidacaoId: item.liquidacaoId, movimentacaoId: saida.movimentacaoId, versaoMovimentacao: saida.versao,
          justificativa: `Conciliado pelo MOVA: saída do extrato de ${saida.data} com o pagamento registrado por comprovante (política de autonomia).`, confirmar: true });
        await a.auditoria.registrar({ acao: "CONCILIACAO_EXECUTADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: item.liquidacaoId,
          dados: { operacao: "CONCILIAR_PAGAMENTO_POR_COMPROVANTE", politicaId: decisao.politicaId, valorCentavos: item.valorCentavos, movimentacaoId: saida.movimentacaoId, repetida: Boolean(k.repetido) } });
        resultados.push({ liquidacaoId: item.liquidacaoId, situacao: "CONCILIADO_COM_EXTRATO", movimentacaoId: saida.movimentacaoId });
      } catch (erro) {
        registrar({ tipo: "MOVA_CONCILIACAO_FALHOU", codigo: erro?.codigo ?? "FALHA" });
        resultados.push({ liquidacaoId: item.liquidacaoId, situacao: "FALHOU", motivo: erro?.codigo ?? "FALHA" });
      }
    }
    return resultados;
  }

  /** Executa UMA operação de escrita da proposta com reserva idempotente, trava da proposta e auditoria (padrão das demais). */
  async function executarComReserva({ operacao, proposta, escopo, politicaId, passos }) {
    const { reserva, repetida } = await reservar(operacao, proposta, escopo, NIVEL.APLICAR_AUTOMATICO, politicaId, operacional);
    if (repetida) return repetida.ok ? { ok: true, repetida: true, resultado: repetida.operacao?.resultado } : { ok: false, motivo: repetida.motivo };
    const tomada = await a.propostas.transicionar(escopo, proposta.id, "AGUARDANDO_REVISAO", "APLICANDO");
    if (!tomada) { await a.operacoes.falhar(reserva.id, "PROPOSTA_JA_DECIDIDA"); return { ok: false, motivo: "PROPOSTA_JA_DECIDIDA" }; }
    try {
      const resultado = await passos();
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "APLICADA", resultado);
      const op = await a.operacoes.concluir(reserva.id, resultado);
      await a.auditoria.registrar({ acao: "OPERACAO_EXECUTADA", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id,
        dados: { operacao, nivel: NIVEL.APLICAR_AUTOMATICO, politicaId, valorCentavos: proposta.valorCentavos, obrigacaoId: resultado.obrigacaoId ?? null, movimentacaoId: null } });
      return { ok: true, resultado, operacao: op };
    } catch (erro) {
      const codigo = erro?.codigo ?? (erro instanceof ErroTransitorio ? "FINANCEIRO_INDISPONIVEL" : "FALHA_NA_EXECUCAO");
      await a.propostas.transicionar(escopo, proposta.id, "APLICANDO", "AGUARDANDO_REVISAO");
      await a.operacoes.falhar(reserva.id, codigo);
      await a.auditoria.registrar({ acao: "OPERACAO_FALHOU", atorTipo: "SISTEMA", atorRef: operacional.identidade, alvo: proposta.id, dados: { operacao, codigo, detalhes: erro?.detalhes ?? null } });
      registrar({ tipo: "MOVA_OPERACAO_FALHOU", codigo });
      return { ok: false, motivo: codigo, detalhes: erro?.detalhes ?? null };
    }
  }

  /** Anexa o documento da proposta (boleto/nota) ao cofre do Financeiro, ligado à conta a pagar (idempotente pelo conteúdo). */
  async function anexarDocumento({ proposta, escopo, obrigacaoId, executor = operacional }) {
    const bytes = proposta.evidencia?.referencia ? await obterEvidencia(proposta.evidencia.referencia) : null;
    if (!bytes) throw new ErroDeExecucao("SEM_EVIDENCIA_DO_DOCUMENTO");
    const mime = proposta.evidencia.mime;
    const tipo = proposta.leitura?.tipoDocumento === "NOTA_FISCAL" ? "NOTA_FISCAL" : "BOLETO";
    return executor.chamar("enviarEvidencia", escopo, {
      arquivo: { conteudo: bytes, nome: `${tipo === "NOTA_FISCAL" ? "nota" : "boleto"}-mova-${curto(proposta.id)}.${EXTENSAO[mime] ?? "bin"}`, tipoMime: mime }, tipo,
      descricao: `${tipo === "NOTA_FISCAL" ? "Nota fiscal" : "Boleto"} recebido pelo MOVA (proposta ${curto(proposta.id)})`, competencia: proposta.datas?.competencia ?? null,
      vinculo: { registroTipo: "OBRIGACAO", registroId: obrigacaoId },
    });
  }

  /**
   * 24/11 — CONTA A PAGAR NOVA a partir de BOLETO/NOTA (proposta NOVA_OBRIGACAO com arquivo). Com a chave MOVA_OPERACAO_CRIAR_CONTAS,
   * a política CONTA_A_PAGAR automática da unidade e a identidade operacional com `registrar_obrigacao` + `enviar_documento`:
   * registra a conta pelo serviço oficial (uma parcela, fonte MOVA:<proposta> — idempotente) e anexa o documento. A conta fica
   * EM ABERTO (aparece no Contas a Pagar e no calendário oficial); nenhuma baixa sem comprovante de pagamento.
   * Fica como PROPOSTA (encaminhada à Central) quando falta fornecedor, categoria definida, competência, vencimento ou documento.
   */
  async function aposContaNova(proposta, escopo) {
    const base = { situacao: "PROPOSTA", nivel: NIVEL.SOMENTE_PROPOR, motivos: [] };
    const u = await unidadeConfirmada(proposta);
    if (!u.ok) return { ...base, motivos: [u.motivo] };
    if (!contasLigadas) return { ...base, motivos: ["CRIACAO_DE_CONTAS_DESLIGADA"] };
    if (proposta.tipo !== "NOVA_OBRIGACAO" || !proposta.evidencia) return { ...base, motivos: ["SEM_DOCUMENTO"] };
    const e = proposta.comando?.entrada;
    const faltas = [
      ...(proposta.competenciaPendente || !e?.competencia ? ["COMPETENCIA_PENDENTE"] : []),
      ...(!proposta.leitura?.favorecido ? ["FORNECEDOR_NAO_IDENTIFICADO"] : []),
      ...(proposta.categoriaDefinida !== true ? ["CATEGORIA_A_CLASSIFICAR"] : []),
      ...(!e?.vencimento ? ["VENCIMENTO_AUSENTE"] : []),
    ];
    if (faltas.length) return { ...base, motivos: faltas };
    const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.CONTA_A_PAGAR, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: proposta.valorCentavos, hoje: hoje() });
    await a.propostas.anotar(escopo, proposta.id, { autonomia: decisao });
    const r0 = { ...base, nivel: decisao.nivel, motivos: decisao.motivos };
    if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO) return r0;
    if (!operacional) return { ...r0, motivos: [...decisao.motivos, "SEM_IDENTIDADE_OPERACIONAL"] };
    for (const op of ["registrarObrigacaoDocumental", "enviarEvidencia"]) if (!(await operacional.pode(op, escopo))) return { ...r0, motivos: [...decisao.motivos, "SEM_CONCESSAO_OPERACIONAL"] };
    const r = await executarComReserva({ operacao: OPERACAO.CONTA_A_PAGAR, proposta, escopo, politicaId: decisao.politicaId, passos: async () => {
      const ob = await operacional.chamar("registrarObrigacaoDocumental", escopo, { ...e, fonte: { sistema: "MANUAL", idExterno: `MOVA:${proposta.id}` } });
      const obrigacao = ob.obrigacoes[0];
      const doc = await anexarDocumento({ proposta, escopo, obrigacaoId: obrigacao.id });
      return { obrigacaoId: obrigacao.id, documentoId: doc.documento.id, contaCriada: !ob.repetido, lancamentoId: ob.lancamento?.id ?? null, categoria: e.categoria ?? null,
        vencimento: e.vencimento, competencia: e.competencia, favorecido: proposta.leitura?.favorecido ?? null, situacaoConta: "ABERTA" };
    } });
    return r.ok ? { ...r0, situacao: "CONTA_REGISTRADA", resultado: r.resultado } : { ...r0, motivos: [...decisao.motivos, r.motivo], motivo: r.motivo };
  }

  /**
   * 24/11 — NOTA FISCAL de uma conta JÁ registrada (proposta VINCULO_DE_DOCUMENTO): só ANEXA a nota à conta (nenhum valor muda,
   * nenhuma despesa nova). Automática com a chave MOVA_OPERACAO_CRIAR_CONTAS, a política ANEXAR_DOCUMENTO e `enviar_documento`.
   */
  async function aposVinculoDeDocumento(proposta, escopo) {
    const base = { situacao: "PROPOSTA", nivel: NIVEL.SOMENTE_PROPOR, motivos: [] };
    const u = await unidadeConfirmada(proposta);
    if (!u.ok) return { ...base, motivos: [u.motivo] };
    if (!contasLigadas) return { ...base, motivos: ["CRIACAO_DE_CONTAS_DESLIGADA"] };
    const obrigacaoId = proposta.comando?.entrada?.obrigacaoId;
    if (proposta.tipo !== "VINCULO_DE_DOCUMENTO" || !proposta.evidencia || !obrigacaoId) return { ...base, motivos: ["SEM_DOCUMENTO"] };
    const decisao = decidirAutonomia({ politicas: await politicasDe(escopo.organizacaoId), operacao: OPERACAO.ANEXAR_DOCUMENTO, organizacaoId: escopo.organizacaoId,
      unidadeId: escopo.unidadeId, valorCentavos: proposta.valorCentavos, hoje: hoje() });
    await a.propostas.anotar(escopo, proposta.id, { autonomia: decisao });
    const r0 = { ...base, nivel: decisao.nivel, motivos: decisao.motivos };
    if (decisao.nivel !== NIVEL.APLICAR_AUTOMATICO) return r0;
    if (!operacional) return { ...r0, motivos: [...decisao.motivos, "SEM_IDENTIDADE_OPERACIONAL"] };
    if (!(await operacional.pode("enviarEvidencia", escopo))) return { ...r0, motivos: [...decisao.motivos, "SEM_CONCESSAO_OPERACIONAL"] };
    const r = await executarComReserva({ operacao: OPERACAO.ANEXAR_DOCUMENTO, proposta, escopo, politicaId: decisao.politicaId, passos: async () => {
      const doc = await anexarDocumento({ proposta, escopo, obrigacaoId });
      return { obrigacaoId, documentoId: doc.documento.id };
    } });
    return r.ok ? { ...r0, situacao: "DOCUMENTO_VINCULADO", resultado: r.resultado } : { ...r0, motivos: [...decisao.motivos, r.motivo], motivo: r.motivo };
  }

  /** Reconferência: propostas de baixa ainda sem extrato conferido (o extrato pode ter chegado depois do comprovante). */
  async function reconferirPendentes(escopo) {
    const pendentes = (await a.propostas.listar(escopo)).filter((p) => p.estado === "AGUARDANDO_REVISAO" && p.tipo === "BAIXA_DE_OBRIGACAO" && p.conciliacao?.situacao !== "CONFERIDA");
    const resultados = [];
    for (const p of pendentes) resultados.push({ propostaId: p.id, ...(await aposBaixa(p, escopo)) });
    return resultados;
  }

  return Object.freeze({ descartarArquivo, pagamentoPorComprovante: Boolean(pagamentoPorComprovante), criarDespesas: despesasLigadas, registrarJuros: jurosLigados, conferir, liquidar, pagarPorComprovante, anexarEPagar, registrarDespesaPaga, aposBaixa, aposDespesaNova, aposJuros, aposContaNova, aposVinculoDeDocumento, anexarDocumento, criarContas: contasLigadas, reconferirPendentes, conciliarPendentes, operacional });
}
