// OPERAÇÕES ENTRE EMPRESAS (intercompany) — 26/11/2026. Espelho da migração 0034.
//
// Uma empresa do grupo PAGA uma conta que é de OUTRA (ex.: a Subway Saci pagou R$ 6.495,60 à distribuidora pelo Açaí no Grau Saci).
// Pagadora e beneficiária são dimensões diferentes; os dois lados ficam ligados por UM vínculo e gravados na MESMA transação:
//   DEVEDORA (beneficiária): a conta do fornecedor é LIQUIDADA "paga por outra empresa" (liquidação sem saída bancária nesta
//     empresa) — se a conta não existia, ela é criada antes, na mesma transação (despesa reconhecida UMA vez) — e nasce o PASSIVO
//     com a credora;
//   CREDORA (pagadora): nasce o ATIVO (a receber da devedora). A saída real é a do EXTRATO, só LIGADA quando já foi importada
//     (nunca criada aqui): não é despesa operacional da credora e não duplica a saída.
// REEMBOLSO (parcial ou integral) liquida os DOIS lados; não é receita nem despesa (nenhum lançamento). Sem compensação automática.
// Vencimento do reembolso é opcional (nunca inventado). Permissão: `registrar_intercompany` NAS DUAS empresas (cada lado confere a
// concessão gravada no seu escopo); criar a conta que faltava exige também `registrar_obrigacao` (ou `registrar`) na devedora.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, EVENTO_HISTORICO, SITUACAO_LIQUIDACAO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirCentavos, subtrair } from "../dominio/dinheiro.js";
import { competenciaDe, exigirData } from "../dominio/tempo.js";
import { aplicarLiquidacao } from "../dominio/titulos.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";

export const CATEGORIA_ENTRE_EMPRESAS = "OPERACOES_ENTRE_EMPRESAS";
export const ORIGEM_INTERCOMPANY = "INTERCOMPANY";
export const PAPEL = Object.freeze({ DEVEDORA: "DEVEDORA", CREDORA: "CREDORA" });
const situacaoDe = (valor, reembolsado) => (reembolsado === 0 ? "ABERTO" : reembolsado === valor ? "LIQUIDADO" : "PARCIAL");
const textoOpcional = (v, campo, max = 300) => (v === undefined || v === null || v === "" ? null : exigirTexto(v, campo, { max }));
const uuidOpcional = (v, campo) => (v === undefined || v === null ? null : exigirUuid(v, campo));
const dataOpcional = (v, campo) => (v === undefined || v === null ? null : exigirData(v, campo));

function validarPagamento(e) {
  semCamposDesconhecidos(e, ["obrigacaoId", "obrigacaoNova", "valorCentavos", "dataPagamento", "descricao", "vencimentoReembolso", "movimentacaoCredoraId", "nomeDevedora", "nomeCredora", "chave"], "intercompany");
  if ((e.obrigacaoId === undefined || e.obrigacaoId === null) === (e.obrigacaoNova === undefined || e.obrigacaoNova === null)) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Informe a conta existente da devedora OU os dados da conta nova (exatamente um).", { campo: "obrigacaoId" });
  }
  const dataPagamento = exigirData(e.dataPagamento, "dataPagamento");
  const vencimentoReembolso = dataOpcional(e.vencimentoReembolso, "vencimentoReembolso");
  if (vencimentoReembolso && vencimentoReembolso < dataPagamento) falhar(CODIGO.DATA_INVALIDA, "O vencimento do reembolso não pode ser anterior ao pagamento.", { campo: "vencimentoReembolso" });
  return {
    obrigacaoId: uuidOpcional(e.obrigacaoId, "obrigacaoId"),
    obrigacaoNova: e.obrigacaoNova ?? null,
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    dataPagamento,
    descricao: exigirTexto(e.descricao, "descricao", { max: 300 }),
    vencimentoReembolso,
    movimentacaoCredoraId: uuidOpcional(e.movimentacaoCredoraId, "movimentacaoCredoraId"),
    nomeDevedora: exigirTexto(e.nomeDevedora, "nomeDevedora", { max: 200 }),
    nomeCredora: exigirTexto(e.nomeCredora, "nomeCredora", { max: 200 }),
    chave: exigirTexto(e.chave, "chave", { max: 300 }),
  };
}

/** Saída do EXTRATO da credora que sustenta o ativo: já importada, válida, de saída, do mesmo valor, ainda não ligada a outro ativo. */
async function exigirSaidaDaCredora(tx, cx, movimentacaoId, valorCentavos) {
  const m = await tx.obter(cx, TIPO.MOVIMENTACAO, movimentacaoId);
  if (!m) falhar(CODIGO.NAO_ENCONTRADO, "Saída do extrato não encontrada na empresa pagadora.");
  if (m.sentido !== "SAIDA" || m.situacao !== "VALIDA" || m.valorCentavos !== valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "A saída do extrato precisa ser válida e do mesmo valor do pagamento.", { motivo: "SAIDA_INCOMPATIVEL" });
  const ligada = (await tx.listar(cx, TIPO.INTERCOMPANY, { onde: { movimentacaoId } }))[0];
  if (ligada) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Esta saída do extrato já sustenta outra operação entre empresas.", { motivo: "SAIDA_JA_LIGADA", intercompanyId: ligada.id });
  return m;
}

export function operacoesEntreEmpresas(b) {
  const lado = (ctx, papel, v, contra, extra) => ({
    vinculoId: extra.vinculoId, papel, contraparteOrganizacaoId: contra.organizacaoId, contraparteUnidadeId: contra.unidadeId,
    contraparteNome: papel === PAPEL.DEVEDORA ? v.nomeCredora : v.nomeDevedora, descricao: v.descricao, dataPagamento: v.dataPagamento,
    valorCentavos: v.valorCentavos, reembolsadoCentavos: 0, saldoCentavos: v.valorCentavos, vencimento: v.vencimentoReembolso, situacao: "ABERTO",
    obrigacaoId: papel === PAPEL.DEVEDORA ? extra.obrigacaoId : null, movimentacaoId: papel === PAPEL.CREDORA ? (v.movimentacaoCredoraId ?? null) : null,
    documentoIds: [], liquidacoes: [], categoria: CATEGORIA_ENTRE_EMPRESAS, chaveIdempotencia: `intercompany:${v.chave}:${papel}`, impressao: extra.impressao,
  });

  return {
    /**
     * Pagamento feito por OUTRA empresa do grupo. `ctxDevedora` = empresa beneficiária (a conta é dela); `ctxCredora` = pagadora.
     * Idempotente pela `chave` (ex.: MOVA:<proposta>): repetir devolve o mesmo vínculo; conteúdo diferente é conflito.
     */
    registrarPagamentoPorOutraEmpresa(ctxDevedora, ctxCredora, entrada) {
      const v = validarPagamento(entrada);
      const impressao = JSON.stringify({ ...v, devedora: [ctxDevedora?.organizacaoId, ctxDevedora?.unidadeId], credora: [ctxCredora?.organizacaoId, ctxCredora?.unidadeId] });
      return b.executarEntreEscopos([ctxDevedora, ctxCredora], ACAO.REGISTRAR_INTERCOMPANY, async (emEscopo) => {
        const vinculoId = b.gerarId();
        // 1) DEVEDORA: conta do fornecedor (existente ou criada agora), passivo e liquidação "paga por outra empresa"
        const devedora = await emEscopo(ctxDevedora, async (cx, tx) => {
          await tx.travar(cx, `intercompany:${v.chave}`, "EXCLUSIVA");
          const ja = await b.jaRegistrado(tx, cx, TIPO.INTERCOMPANY, `intercompany:${v.chave}:${PAPEL.DEVEDORA}`, impressao);
          if (ja) return { repetido: true, registro: ja };
          let obrigacaoId = v.obrigacaoId;
          let contaCriada = false;
          if (!obrigacaoId) {
            const n = operacoesEconomicas(baseNaTransacao(b, tx, cx));
            const permissoes = ctxDevedora.permissoes ?? [];
            const ob = permissoes.includes(ACAO.REGISTRAR) ? await n.registrarObrigacao({ ...ctxDevedora }, v.obrigacaoNova)
              : permissoes.includes(ACAO.REGISTRAR_OBRIGACAO) ? await n.registrarObrigacaoDocumental({ ...ctxDevedora }, v.obrigacaoNova)
              : falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Criar a conta do fornecedor exige permissão de registrar conta a pagar na empresa beneficiária.", { acao: ACAO.REGISTRAR_OBRIGACAO });
            if (ob.obrigacoes.length !== 1) falhar(CODIGO.ENTRADA_INVALIDA, "A conta paga por outra empresa tem uma parcela.");
            obrigacaoId = ob.obrigacoes[0].id;
            contaCriada = !ob.repetido;
          }
          await tx.travar(cx, `obrigacao:${obrigacaoId}`, "EXCLUSIVA");
          const o = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, obrigacaoId, "Conta a pagar");
          if (o.situacao === SITUACAO_TITULO.CANCELADA || o.situacao === SITUACAO_TITULO.QUITADA) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "A conta já está quitada ou cancelada: nada a pagar por outra empresa.", { motivo: "CONTA_SEM_SALDO" });
          if (v.valorCentavos > o.saldoCentavos) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "O valor pago pela outra empresa é maior que o saldo da conta.", { motivo: "VALOR_MAIOR_QUE_SALDO", saldoCentavos: o.saldoCentavos });
          await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(v.dataPagamento)], referenciadas: [o.competencia], motivo: "conta paga por outra empresa do grupo" });
          const registro = await b.criar(tx, cx, TIPO.INTERCOMPANY, lado(cx, PAPEL.DEVEDORA, v, ctxCredora, { vinculoId, obrigacaoId, impressao }), "Conta paga por outra empresa do grupo");
          const liquidacao = await b.criar(tx, cx, TIPO.LIQUIDACAO, {
            movimentacaoId: null, alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id, valorCentavos: v.valorCentavos, estornadoCentavos: 0, dataEfetiva: v.dataPagamento,
            situacao: SITUACAO_LIQUIDACAO.VALIDA, chaveIdempotencia: `intercompany:${v.chave}:liquidacao`, origemDoVinculo: ORIGEM_INTERCOMPANY, intercompanyId: registro.id,
            pagaPor: { organizacaoId: ctxCredora.organizacaoId, unidadeId: ctxCredora.unidadeId, nome: v.nomeCredora },
          }, `Paga por ${v.nomeCredora} (operação entre empresas)`);
          const titulo = await b.alterar(tx, cx, TIPO.OBRIGACAO, o, aplicarLiquidacao(o, v.valorCentavos), EVENTO_HISTORICO.LIQUIDACAO, `Paga por ${v.nomeCredora} (operação entre empresas)`.slice(0, 500));
          return { repetido: false, registro, liquidacao, titulo, contaCriada };
        });
        // 2) CREDORA: ativo (a receber da devedora), ligado à saída do extrato quando ela já existe
        const credora = await emEscopo(ctxCredora, async (cx, tx) => {
          const ja = await b.jaRegistrado(tx, cx, TIPO.INTERCOMPANY, `intercompany:${v.chave}:${PAPEL.CREDORA}`, impressao);
          if (ja) return { repetido: true, registro: ja };
          if (devedora.repetido) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Operação entre empresas registrada só de um lado: revisar.", { motivo: "VINCULO_INCOMPLETO" });
          if (v.movimentacaoCredoraId) await exigirSaidaDaCredora(tx, cx, v.movimentacaoCredoraId, v.valorCentavos);
          const registro = await b.criar(tx, cx, TIPO.INTERCOMPANY, lado(cx, PAPEL.CREDORA, v, ctxDevedora, { vinculoId, impressao }), "Pagamento feito por esta empresa pela outra empresa do grupo");
          return { repetido: false, registro };
        });
        if (devedora.repetido !== credora.repetido || devedora.registro.vinculoId !== credora.registro.vinculoId) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Operação entre empresas inconsistente entre os dois lados: revisar.", { motivo: "VINCULO_INCOMPLETO" });
        return {
          repetido: devedora.repetido, vinculoId: devedora.registro.vinculoId, devedora: devedora.registro, credora: credora.registro,
          liquidacao: devedora.liquidacao ?? null, titulo: devedora.titulo ?? null, contaCriada: devedora.contaCriada ?? false,
          efeito: { novasSaidas: 0, despesasNaCredora: 0, despesasNaDevedora: devedora.contaCriada ? 1 : 0 },
        };
      });
    },

    /** REEMBOLSO (parcial ou integral): liquida os DOIS lados do mesmo vínculo. Não é receita nem despesa; nenhuma saída é criada. */
    registrarReembolsoEntreEmpresas(ctxDevedora, ctxCredora, entrada) {
      semCamposDesconhecidos(entrada, ["vinculoId", "valorCentavos", "data", "observacao", "chave"], "reembolso");
      const vinculoId = exigirUuid(entrada.vinculoId, "vinculoId");
      const valor = exigirCentavos(entrada.valorCentavos, "valorCentavos", { positivo: true });
      const data = exigirData(entrada.data, "data");
      const chave = exigirTexto(entrada.chave, "chave", { max: 200 });
      const observacao = textoOpcional(entrada.observacao, "observacao");
      return b.executarEntreEscopos([ctxDevedora, ctxCredora], ACAO.REGISTRAR_INTERCOMPANY, async (emEscopo) => {
        const um = (ctx, papel) => emEscopo(ctx, async (cx, tx) => {
          await tx.travar(cx, `intercompany-vinculo:${vinculoId}`, "EXCLUSIVA");
          const r = (await tx.listar(cx, TIPO.INTERCOMPANY, { onde: { vinculoId } }))[0];
          if (!r || r.papel !== papel) falhar(CODIGO.NAO_ENCONTRADO, "Operação entre empresas não encontrada nesta empresa.");
          if ((r.liquidacoes ?? []).some((l) => l.chave === chave)) return { repetido: true, registro: r };
          if (valor > r.saldoCentavos) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "O reembolso é maior que o saldo entre as empresas.", { motivo: "REEMBOLSO_MAIOR_QUE_SALDO", saldoCentavos: r.saldoCentavos });
          if (data < r.dataPagamento) falhar(CODIGO.DATA_INVALIDA, "O reembolso não pode ser anterior ao pagamento original.", { campo: "data" });
          await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(data)], referenciadas: [], motivo: "reembolso entre empresas" });
          const reembolsado = r.reembolsadoCentavos + valor;
          const liquidacoes = [...(r.liquidacoes ?? []), { chave, valorCentavos: valor, data, observacao, registradoPor: cx.usuarioId, registradoEm: b.agora() }];
          const registro = await b.alterar(tx, cx, TIPO.INTERCOMPANY, r, { reembolsadoCentavos: reembolsado, saldoCentavos: subtrair(r.valorCentavos, reembolsado), situacao: situacaoDe(r.valorCentavos, reembolsado), liquidacoes },
            EVENTO_HISTORICO.LIQUIDACAO, `Reembolso entre empresas${observacao ? `: ${observacao}` : ""}`.slice(0, 500));
          return { repetido: false, registro };
        });
        const devedora = await um(ctxDevedora, PAPEL.DEVEDORA);
        const credora = await um(ctxCredora, PAPEL.CREDORA);
        if (devedora.repetido !== credora.repetido || devedora.registro.saldoCentavos !== credora.registro.saldoCentavos) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Os dois lados da operação entre empresas divergem: revisar.", { motivo: "LADOS_DIVERGENTES" });
        return { repetido: devedora.repetido, devedora: devedora.registro, credora: credora.registro };
      });
    },

    /** Liga a saída do EXTRATO (já importada) ao ativo da credora, uma única vez. Só na credora. */
    vincularSaidaDaOperacaoEntreEmpresas(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["intercompanyId", "movimentacaoId"], "vinculoSaida");
      const id = exigirUuid(entrada.intercompanyId, "intercompanyId");
      const movimentacaoId = exigirUuid(entrada.movimentacaoId, "movimentacaoId");
      return b.executar(ctx, ACAO.REGISTRAR_INTERCOMPANY, async (cx, tx) => {
        await tx.travar(cx, `movimentacao:${movimentacaoId}`, "EXCLUSIVA");
        const r = await b.obterOuFalhar(tx, cx, TIPO.INTERCOMPANY, id, "Operação entre empresas");
        if (r.papel !== PAPEL.CREDORA) falhar(CODIGO.OPERACAO_INVALIDA, "Só o lado da empresa pagadora recebe a saída do extrato.");
        if (r.movimentacaoId === movimentacaoId) return { repetido: true, registro: r };
        if (r.movimentacaoId) falhar(CODIGO.OPERACAO_INVALIDA, "Esta operação já está ligada a outra saída do extrato.", { motivo: "JA_LIGADA" });
        await exigirSaidaDaCredora(tx, cx, movimentacaoId, r.valorCentavos);
        return { repetido: false, registro: await b.alterar(tx, cx, TIPO.INTERCOMPANY, r, { movimentacaoId }, EVENTO_HISTORICO.CONCILIACAO, "Saída do extrato da empresa pagadora") };
      });
    },

    /**
     * "Contas entre Empresas" de UMA unidade (a visão junta as unidades que a pessoa vê). Nunca entra no total de contas a pagar a
     * fornecedores nem nas despesas: é patrimonial. `aReceber` = esta empresa é credora; `aPagar` = devedora.
     */
    consultarContasEntreEmpresas(ctx, { incluirLiquidadas = true } = {}) {
      return b.consultar(ctx, async (cx, tx) => {
        const todos = (await tx.listar(cx, TIPO.INTERCOMPANY)).filter((r) => incluirLiquidadas || r.situacao !== "LIQUIDADO");
        const itens = todos.map((r) => ({
          id: r.id, vinculoId: r.vinculoId, papel: r.papel, devedora: r.papel === PAPEL.DEVEDORA ? { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId } : { organizacaoId: r.contraparteOrganizacaoId, unidadeId: r.contraparteUnidadeId, nome: r.contraparteNome },
          credora: r.papel === PAPEL.CREDORA ? { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId } : { organizacaoId: r.contraparteOrganizacaoId, unidadeId: r.contraparteUnidadeId, nome: r.contraparteNome },
          contraparteNome: r.contraparteNome, descricao: r.descricao, dataPagamento: r.dataPagamento, valorCentavos: r.valorCentavos, reembolsadoCentavos: r.reembolsadoCentavos,
          saldoCentavos: r.saldoCentavos, vencimento: r.vencimento ?? null, situacao: r.situacao, liquidacoes: r.liquidacoes ?? [], obrigacaoId: r.obrigacaoId ?? null,
          saidaDoExtratoLigada: Boolean(r.movimentacaoId),
        })).sort((x, y) => String(y.dataPagamento).localeCompare(String(x.dataPagamento)));
        const soma = (papel) => itens.filter((i) => i.papel === papel).reduce((s, i) => s + i.saldoCentavos, 0);
        return { itens, totais: { aPagarCentavos: soma(PAPEL.DEVEDORA), aReceberCentavos: soma(PAPEL.CREDORA) } };
      });
    },
  };
}
