// 24/11 — DESPESA JÁ PAGA POR COMPROVANTE numa ÚNICA operação atômica (compra nova paga no ato: "comprei brownies e já paguei").
//
// Uma compra já paga é UMA despesa e a SUA liquidação, nunca duas despesas. Antes, quem registrava fazia três chamadas
// separadas (conta → anexo → pagamento): se o pagamento falhasse (comprovante já usado, competência fechada, indisponibilidade),
// sobrava uma conta EM ABERTO que não existia. Aqui, a conta (lançamento de despesa na COMPETÊNCIA), a ficha do comprovante, o
// vínculo e a liquidação por comprovante (na data do PAGAMENTO, sem movimentação bancária) nascem na MESMA transação:
// ou tudo existe, ou nada existe.
//
// Reaproveita os serviços oficiais, sem regra nova de negócio:
//   - conta: `registrarObrigacaoDocumental` (ação estreita `registrar_obrigacao`; despesa, uma parcela) ou, para quem tem
//     `registrar` (pessoa que aprova na Central), `registrarObrigacao` com a MESMA restrição de uma parcela sem repetição;
//   - comprovante: o protocolo de evidências (cofre conferido fora da transação; ficha + vínculo dentro dela);
//   - pagamento: o corpo único do pagamento por comprovante (idempotente pelo documento e pelo identificador da transação;
//     quita a conta pelo valor INTEGRAL; conciliação PENDENTE até o extrato chegar — `conciliarPagamentoPorComprovante` liga a
//     saída do extrato à MESMA liquidação, sem duplicar).
// Permissões: as três ações (conta, `baixar_por_comprovante`, `enviar_documento`), conferidas no contexto E na concessão gravada.
// Repetir o pedido (mesma fonte, mesmo arquivo) devolve o que já existe.
import { createHash } from "node:crypto";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { pagarPorComprovante, validarPagamentoDaDespesaPaga } from "./baixaPorComprovante.js";
import { gravarFichaEVinculo, guardarNoCofreConferido, validarArquivoDeEvidencia } from "./evidencias.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { exigirCentavos, formatarBRL } from "../dominio/dinheiro.js";

/**
 * 25/11 — encargos DISCRIMINADOS no comprovante (juros e/ou multa impressos). A conta nasce pelo valor ORIGINAL; o encargo entra
 * pelo mecanismo oficial (ajuste na categoria de juros e multas, ação estreita `registrar_juros`) e o pagamento é o TOTAL.
 */
export function validarEncargosDoComprovante(e) {
  semCamposDesconhecidos(e ?? {}, ["jurosCentavos", "multaCentavos"], "encargos");
  const v = (x, campo) => (x === undefined || x === null ? 0 : exigirCentavos(x, campo));
  const juros = v(e.jurosCentavos, "jurosCentavos"); const multa = v(e.multaCentavos, "multaCentavos");
  if (!(juros + multa > 0)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe juros ou multa do comprovante.", { campo: "encargos" });
  return { jurosCentavos: juros, multaCentavos: multa, encargoCentavos: juros + multa, tipoEncargo: juros && multa ? "JUROS_E_MULTA" : juros ? "JUROS" : "MULTA",
    detalhe: [juros ? `juros ${formatarBRL(juros)}` : null, multa ? `multa ${formatarBRL(multa)}` : null].filter(Boolean).join(", ") };
}

export function operacoesDeDespesaPagaPorComprovante(b, { cofre }) {
  const ops = {
    /**
     * @param {object} ctx
     * @param {{obrigacao:object, comprovante:{arquivo:{conteudo:Buffer,nome:string,tipoMime:string}, descricao:string, competencia?:string|null},
     *          pagamento:{dataPagamento:string, idTransacao?:string|null, justificativa:string, confirmar:boolean}}} entrada
     */
    async registrarDespesaPagaPorComprovante(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["obrigacao", "comprovante", "pagamento", "encargos"], "despesaPagaPorComprovante");
      const encargos = entrada?.encargos === undefined || entrada?.encargos === null ? null : validarEncargosDoComprovante(entrada.encargos);
      if (encargos) b.autorizarContexto(ctx, ACAO.REGISTRAR_JUROS);
      if (!entrada?.obrigacao || typeof entrada.obrigacao !== "object") falhar(CODIGO.ENTRADA_INVALIDA, "Informe a conta a pagar.", { campo: "obrigacao" });
      semCamposDesconhecidos(entrada.comprovante ?? {}, ["arquivo", "descricao", "competencia", "arquivar"], "comprovante");
      // 26/11 — despesa comum: o arquivo é VALIDADO (formato, tamanho, conteúdo ativo) e conferido por hash, mas NÃO é arquivado
      // (arquivar:false). Só as notas dos entregadores têm arquivamento permanente. Padrão (omitido) = arquivar, como antes.
      const arquivarArquivo = entrada.comprovante?.arquivar !== false;
      const { arquivar: _a, ...comprovanteSemFlag } = entrada.comprovante ?? {};
      const arquivo = validarArquivoDeEvidencia({ ...comprovanteSemFlag, tipo: "COMPROVANTE" });
      const pagamento = validarPagamentoDaDespesaPaga(entrada.pagamento);
      if ((entrada.obrigacao.parcelas ?? 1) !== 1 || entrada.obrigacao.recorrencia) falhar(CODIGO.ENTRADA_INVALIDA, "Despesa paga por comprovante entra em uma parcela, sem repetição.", { campo: "parcelas" });
      // A conta nasce pela ação estreita quando o contexto a tem; senão pelo cadastro comum (quem aprova na Central).
      const permissoes = ctx?.permissoes ?? [];
      const acaoDaConta = permissoes.includes(ACAO.REGISTRAR_OBRIGACAO) ? ACAO.REGISTRAR_OBRIGACAO : ACAO.REGISTRAR;
      for (const acao of arquivarArquivo ? [acaoDaConta, ACAO.ENVIAR_DOCUMENTO] : [acaoDaConta]) b.autorizarContexto(ctx, acao);
      const cx0 = b.autorizarContexto(ctx, ACAO.BAIXAR_POR_COMPROVANTE);
      if (!pagamento.confirmar) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a despesa, o valor e o comprovante e confirme o registro.");
      if (arquivarArquivo && !cofre) falhar(CODIGO.COFRE_INDISPONIVEL, "Envio de documentos exige um cofre privado configurado.");
      // Cofre FORA da transação (protocolo de evidências): se a transação falhar, o arquivo fica sem ficha — invisível, reaproveitado.
      const guardado = arquivarArquivo ? await guardarNoCofreConferido(cofre, { organizacaoId: cx0.organizacaoId, unidadeId: cx0.unidadeId }, arquivo) : null;
      const hashDoArquivo = arquivarArquivo ? null : createHash("sha256").update(arquivo.conteudo).digest("hex");
      return b.executar(ctx, ACAO.BAIXAR_POR_COMPROVANTE, async (cx, tx) => {
        await b.exigirConcessaoVigente(tx, cx, acaoDaConta);
        if (arquivarArquivo) await b.exigirConcessaoVigente(tx, cx, ACAO.ENVIAR_DOCUMENTO);
        if (encargos) await b.exigirConcessaoVigente(tx, cx, ACAO.REGISTRAR_JUROS);
        const economico = operacoesEconomicas(baseNaTransacao(b, tx, cx));
        const ob = acaoDaConta === ACAO.REGISTRAR_OBRIGACAO
          ? await economico.registrarObrigacaoDocumental(ctx, entrada.obrigacao)
          : await economico.registrarObrigacao(ctx, entrada.obrigacao);
        if (ob.obrigacoes.length !== 1) falhar(CODIGO.ENTRADA_INVALIDA, "Despesa paga por comprovante entra em uma parcela.", { campo: "parcelas" });
        const [conta] = ob.obrigacoes;
        const documento = arquivarArquivo ? await gravarFichaEVinculo(b, tx, cx, { cofre, guardado, envio: { ...arquivo, vinculo: { registroTipo: TIPO.OBRIGACAO, registroId: conta.id } } }) : null;
        // Liquidação INTEGRAL: o valor pago é o valor da despesa (nunca uma segunda despesa, nunca saída bancária inventada).
        // Com encargos: o pagamento é o TOTAL (original + juros + multa); o encargo é lançado à parte (nunca tudo como a despesa).
        const pagoCentavos = conta.valorBaseCentavos + (encargos?.encargoCentavos ?? 0);
        const pago = await pagarPorComprovante(b, tx, cx, {
          obrigacaoId: conta.id, valorCentavos: pagoCentavos, dataPagamento: pagamento.dataPagamento, ...(documento ? { documentoId: documento.documento.id } : { documentoId: null, semArquivo: { hashSha256: hashDoArquivo, tipoMime: arquivo.formato.tipoMime, tamanhoBytes: arquivo.formato.tamanhoBytes } }),
          idTransacao: pagamento.idTransacao, justificativa: pagamento.justificativa, confirmar: true,
          ...(encargos ? { encargoCentavos: encargos.encargoCentavos, tipoEncargo: encargos.tipoEncargo, detalheDoEncargo: encargos.detalhe } : {}),
        });
        // F4 §13 — COMPROVANTE FOTOGRAFADO DE NOVO (depois das conferências exatas: mesmo arquivo/mesma transação já recusados acima): outro arquivo (outro hash) não basta para ser outro pagamento. Mesmo valor, mesma
        // data e mesmo beneficiário de um pagamento por comprovante já registrado, sem identificadores de transação DIFERENTES dos
        // dois lados ⇒ recusa (nada fica gravado) até a pessoa confirmar que é outra compra (`naoEDuplicado` + justificativa).
        if (!ob.repetido && !pago.repetido && !pagamento.naoEDuplicado) {
          const iguais = (await tx.listar(cx, TIPO.LIQUIDACAO)).filter((l) => l.origemDoVinculo === "COMPROVANTE" && l.situacao !== "ESTORNADA" && l.alvoId !== conta.id && l.id !== pago.liquidacao?.id
            && l.valorCentavos === pagoCentavos && l.dataEfetiva === pagamento.dataPagamento
            && !(l.idTransacao && pagamento.idTransacao && String(l.idTransacao).toUpperCase() !== pagamento.idTransacao.toUpperCase()));
          for (const l of iguais) {
            const outra = await tx.obter(cx, TIPO.OBRIGACAO, l.alvoId);
            if (outra && outra.contraparteId && outra.contraparteId === conta.contraparteId) {
              falhar(CODIGO.POSSIVEL_DUPLICIDADE, "Já existe um pagamento por comprovante com o mesmo valor, a mesma data e o mesmo fornecedor. Se for outra compra, confirme que não é o mesmo comprovante.", { obrigacaoId: outra.id, liquidacaoId: l.id, valorCentavos: l.valorCentavos, dataPagamento: l.dataEfetiva });
            }
          }
        }
        return {
          repetido: Boolean(ob.repetido && pago.repetido),
          lancamento: ob.lancamento, obrigacao: pago.titulo, documento: documento?.documento ?? null, comprovanteArquivado: Boolean(documento), liquidacao: pago.liquidacao,
          conciliacao: pago.conciliacao,
          efeito: { novasDespesas: ob.repetido ? 0 : 1, novasSaidas: 0, pagoCentavos, ...(encargos ? { principalCentavos: conta.valorBaseCentavos, jurosCentavos: encargos.jurosCentavos, multaCentavos: encargos.multaCentavos, encargoCentavos: encargos.encargoCentavos } : {}) },
          ...(pago.encargo ? { encargo: pago.encargo } : {}),
        };
      });
    },
  };
  /** 25/11 — operação ESTREITA da compra nova paga COM juros/multa discriminados (exige também `registrar_juros`). */
  ops.registrarDespesaPagaComEncargo = (ctx, entrada) => {
    if (!entrada?.encargos) falhar(CODIGO.ENTRADA_INVALIDA, "Informe juros ou multa do comprovante.", { campo: "encargos" });
    return ops.registrarDespesaPagaPorComprovante(ctx, entrada);
  };
  return ops;
}
