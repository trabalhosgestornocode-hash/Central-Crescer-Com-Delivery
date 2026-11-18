// Retiradas de caixa (sangrias) da SAIPOS → DESPESA paga em dinheiro. Etapa EXPLÍCITA, separada da importação.
//
// Regra do negócio (confirmada pelo dono): cada retirada é uma despesa pequena paga com dinheiro do caixa. No sistema ela é uma conta a pagar
// do fornecedor "Sangrias", categoria "Outras despesas", paga em dinheiro pelo caixa físico ("Caixa da loja") na própria data — o mesmo que a
// equipe já lançava à mão ("Paguei em dinheiro · Sai do caixa da loja"). Entra na DRE em Outras despesas, no Contas a Pagar e no calendário como paga.
//
//   - importar o relatório continua sem efeito financeiro; só esta ação lança, e só o que está NOVO;
//   - NÃO duplica o que já existe: retirada com a mesma data e valor de uma conta do fornecedor "Sangrias" lançada à mão é reconhecida como
//     "já lançada manualmente" e ignorada (casamento 1 para 1: duas retiradas iguais exigem duas contas);
//   - idempotente: cada retirada tem identificador próprio (derivado da linha importada); repetir a ação não lança de novo;
//   - cada retirada é atômica (conta + pagamento juntos); uma que falhe (ex.: competência homologada) não impede as outras e é listada com o motivo;
//   - reforço e transferência NÃO viram despesa (reforço é dinheiro que volta ao caixa; transferência tem sentido desconhecido).
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_TITULO, TIPO, TIPO_CONTA } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { sha256 } from "../importacao/motor.js";
import { NATUREZA_MOVIMENTO_CAIXA as N } from "../importacao/fontes/saipos.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDeTesouraria } from "./tesouraria.js";
import { movimentosDoPeriodo } from "./movimentosDeCaixa.js";

export const FORNECEDOR_DAS_SANGRIAS = "Sangrias";
export const CATEGORIA_DAS_SANGRIAS = "OUTRAS_DESPESAS";
export const PREFIXO_DA_FONTE = "sangria:";
export const SITUACAO_RETIRADA = Object.freeze({ NOVA: "NOVA", JA_LANCADA_MANUALMENTE: "JA_LANCADA_MANUALMENTE", JA_LANCADA_PELA_IMPORTACAO: "JA_LANCADA_PELA_IMPORTACAO" });

const norm = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
const chaveDaRetirada = (r) => `${PREFIXO_DA_FONTE}${sha256(r.chaveIdempotencia).slice(0, 32)}`;
const descricaoDaRetirada = (r) => `Retirada de Frente de Caixa (SAIPOS) em ${r.dataReferencia.slice(8, 10)}/${r.dataReferencia.slice(5, 7)}`;

/**
 * Situação de cada retirada do período em relação ao que já existe no Contas a Pagar. Só LEITURA (usada pela prévia e, de novo, DENTRO da
 * transação de cada lançamento para não duplicar nada que tenha sido lançado entre a prévia e a confirmação).
 */
export async function situacaoDasRetiradas(tx, cx, inicio, fim) {
  const retiradas = (await movimentosDoPeriodo(tx, cx, inicio, fim))
    .filter((r) => r.dados.natureza === N.SANGRIA && r.dados.considerar)
    .sort((a, x) => a.dataReferencia.localeCompare(x.dataReferencia) || a.linha - x.linha);
  const caixas = (await tx.listar(cx, TIPO.CONTA)).filter((c) => c.ativa && c.tipo === TIPO_CONTA.CAIXA_FISICO);
  const fornecedor = (await tx.listar(cx, TIPO.CONTRAPARTE)).find((x) => x.tipo === "FORNECEDOR" && norm(x.nome) === norm(FORNECEDOR_DAS_SANGRIAS)) ?? null;
  const contas = fornecedor ? (await tx.listar(cx, TIPO.OBRIGACAO, { onde: { contraparteId: fornecedor.id } })).filter((o) => o.situacao !== SITUACAO_TITULO.CANCELADA) : [];
  const daImportacao = new Map(contas.filter((o) => String(o.fonte?.idExterno ?? "").startsWith(PREFIXO_DA_FONTE)).map((o) => [o.fonte.idExterno, o]));
  const manuais = contas.filter((o) => !String(o.fonte?.idExterno ?? "").startsWith(PREFIXO_DA_FONTE));
  const usadas = new Set(); // casamento 1 para 1: cada conta lançada à mão cobre UMA retirada
  const itens = retiradas.map((r) => {
    const chave = chaveDaRetirada(r);
    const base = { registroId: r.id, chave, data: r.dataReferencia, valorCentavos: r.dados.valorAbsolutoCentavos, descricao: r.dados.descricaoOriginal, linha: r.linha, importacaoId: r.importacaoId };
    const feita = daImportacao.get(chave);
    if (feita) return { ...base, situacao: SITUACAO_RETIRADA.JA_LANCADA_PELA_IMPORTACAO, obrigacaoId: feita.id, quitada: feita.saldoCentavos === 0 };
    const o = manuais.find((x) => !usadas.has(x.id) && x.vencimento === base.data && x.valorBaseCentavos === base.valorCentavos);
    if (o) { usadas.add(o.id); return { ...base, situacao: SITUACAO_RETIRADA.JA_LANCADA_MANUALMENTE, obrigacaoId: o.id, descricaoDaConta: o.descricao ?? null, quitada: o.saldoCentavos === 0 }; }
    return { ...base, situacao: SITUACAO_RETIRADA.NOVA };
  });
  const motivoSemCaixa = caixas.length === 0 ? "Não há caixa físico cadastrado nesta unidade: cadastre o \"Caixa da loja\" antes de lançar." : caixas.length > 1 ? "Há mais de um caixa físico: o lançamento automático só funciona com um." : null;
  return { conta: caixas.length === 1 ? { id: caixas[0].id, nome: caixas[0].nome } : null, motivoSemCaixa, fornecedor: fornecedor ? { id: fornecedor.id, nome: fornecedor.nome } : null, itens };
}

/** Prévia pronta (dentro de uma transação de leitura): usada pela consulta e pelo detalhe da importação. */
export async function previaDeSangriasNaTransacao(tx, cx, inicio, fim) {
  const s = await situacaoDasRetiradas(tx, cx, inicio, fim);
  const por = (st) => s.itens.filter((i) => i.situacao === st);
  const soma = (l) => l.reduce((t, i) => t + i.valorCentavos, 0);
  return {
    periodoInicio: inicio, periodoFim: fim, conta: s.conta, motivoSemCaixa: s.motivoSemCaixa, fornecedor: FORNECEDOR_DAS_SANGRIAS, fornecedorExiste: Boolean(s.fornecedor),
    categoria: CATEGORIA_DAS_SANGRIAS, itens: s.itens,
    resumo: {
      novas: { quantidade: por(SITUACAO_RETIRADA.NOVA).length, totalCentavos: soma(por(SITUACAO_RETIRADA.NOVA)) },
      jaLancadasManualmente: { quantidade: por(SITUACAO_RETIRADA.JA_LANCADA_MANUALMENTE).length, totalCentavos: soma(por(SITUACAO_RETIRADA.JA_LANCADA_MANUALMENTE)) },
      jaLancadasPelaImportacao: { quantidade: por(SITUACAO_RETIRADA.JA_LANCADA_PELA_IMPORTACAO).length, totalCentavos: soma(por(SITUACAO_RETIRADA.JA_LANCADA_PELA_IMPORTACAO)) },
    },
    permissaoExigida: ACAO.REGISTRAR, voceTemPermissao: cx.permissoes.includes(ACAO.REGISTRAR),
    efeito: "Cada retirada NOVA vira uma conta a pagar do fornecedor Sangrias (categoria Outras despesas), paga em dinheiro pelo caixa da loja na própria data. Entra na DRE em Outras despesas e aparece no Contas a Pagar e no calendário como paga. O que já foi lançado à mão não é lançado de novo.",
  };
}

export function operacoesDeSangriasComoDespesa(b) {
  const nucleoNa = (tx, cx) => { const bt = baseNaTransacao(b, tx, cx); return { ...operacoesEconomicas(bt), ...operacoesDeTesouraria(bt) }; };
  const periodoDe = (entrada) => {
    const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
    const fim = exigirData(entrada.periodoFim, "periodoFim");
    if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
    return { inicio, fim };
  };
  const previa = (ctx, entrada = {}) => {
    semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
    const { inicio, fim } = periodoDe(entrada);
    return b.consultar(ctx, (cx, tx) => previaDeSangriasNaTransacao(tx, cx, inicio, fim));
  };

  return {
    previaSangriasComoDespesa: previa,

    /** Lança as retiradas NOVAS do período como despesas pagas em dinheiro. Cada uma é atômica; falhas são listadas, não escondidas. */
    async lancarSangriasComoDespesa(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim", "justificativa", "confirmar"], "lancamento");
      if (entrada.confirmar !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a prévia e confirme o lançamento das retiradas como despesas.");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 300, opcional: true }) ?? "Retiradas de caixa importadas da SAIPOS lançadas como despesa paga em dinheiro.";
      const p = await previa(ctx, { periodoInicio: entrada.periodoInicio, periodoFim: entrada.periodoFim });
      if (!p.voceTemPermissao) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Lançar as retiradas como despesas exige a permissão de registrar.", { acaoExigida: ACAO.REGISTRAR });
      if (!p.conta) falhar(CODIGO.OPERACAO_INVALIDA, p.motivoSemCaixa, { motivo: "CAIXA_FISICO_INDEFINIDO" });
      const lancadas = [];
      const falhas = [];
      for (const item of p.itens.filter((i) => i.situacao === SITUACAO_RETIRADA.NOVA)) {
        try {
          const feito = await b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
            // Reconfere DENTRO da transação: nada lançado entre a prévia e agora (à mão ou por outra confirmação) pode ser duplicado.
            const agora = (await situacaoDasRetiradas(tx, cx, item.data, item.data)).itens.find((x) => x.registroId === item.registroId);
            if (!agora || agora.situacao !== SITUACAO_RETIRADA.NOVA) return { ignorada: true };
            const n = nucleoNa(tx, cx);
            const registrada = await n.registrarObrigacao(cx, {
              contraparteNova: { tipo: "FORNECEDOR", nome: FORNECEDOR_DAS_SANGRIAS }, valorOriginalCentavos: item.valorCentavos, categoria: CATEGORIA_DAS_SANGRIAS,
              descricao: descricaoDaRetirada({ dataReferencia: item.data }), competencia: item.data.slice(0, 7), dataEmissao: item.data, vencimento: item.data,
              fonte: { sistema: "SAIPOS", idExterno: item.chave },
            });
            const conta = registrada.obrigacoes[0];
            const pagamento = await n.pagarContaAPagar(cx, { obrigacaoId: conta.id, contaId: p.conta.id, dataEfetiva: item.data, valorCentavos: item.valorCentavos });
            return { obrigacaoId: conta.id, movimentacaoId: pagamento.movimentacao?.id ?? null };
          });
          if (!feito.ignorada) lancadas.push({ registroId: item.registroId, data: item.data, valorCentavos: item.valorCentavos, ...feito });
        } catch (e) {
          // Acesso negado e escopo errado recusam a ação inteira; só falha de NEGÓCIO de uma retirada (ex.: competência homologada) vira item da lista.
          if ([CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.ESCOPO_NAO_AUTORIZADO, CODIGO.CONFIRMACAO_EXIGIDA].includes(e?.codigo)) throw e;
          falhas.push({ registroId: item.registroId, data: item.data, valorCentavos: item.valorCentavos, motivo: e?.message ?? "Falha ao lançar.", codigo: e?.codigo ?? null });
        }
      }
      return { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim, justificativa, lancadas, falhas, jaLancadas: p.itens.length - p.itens.filter((i) => i.situacao === SITUACAO_RETIRADA.NOVA).length, conta: p.conta };
    },
  };
}
