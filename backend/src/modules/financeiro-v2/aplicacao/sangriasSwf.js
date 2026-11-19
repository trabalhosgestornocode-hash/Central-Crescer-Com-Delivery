// Sangrias do SWF (Subway) → despesa PAGA em dinheiro pelo caixa da loja. Etapa EXPLÍCITA, separada da importação (doc 54).
//
// Mesmo mecanismo das sangrias da SAIPOS (sangriasComoDespesa.js), com estas regras próprias:
//   - a sugestão é recalculada pelas regras VIGENTES (REGRAS_SANGRIA_SWF) a cada leitura: o código da regra fica no lançamento;
//   - só DESPESA e BENEFICIO podem ser lançados; adiantamento, transferência e motivo não reconhecido ficam PENDENTES;
//   - DATAS: a conta (vencimento/calendário) fica no DIA OPERACIONAL do SWF; o PAGAMENTO (fluxo de caixa) sai na DATA REAL do desembolso;
//     a competência da DRE é a do dia operacional, salvo quando o motivo diz a que dia se refere ("REFERENTE A 31") e isso aponta para o
//     mês anterior — então a competência precisa ser escolhida na confirmação (nunca presumida);
//   - VR/VT (Benefícios de pessoal, regra confirmada pelo dono em 19/11/2026), antes de lançar:
//       · obrigação de benefício PROVISIONADA (aberta, mesmo valor e competência) → BAIXA dessa obrigação pelo caixa, sem despesa nova;
//       · benefício JÁ PAGO (obrigação quitada, ou saída do banco com cara de VR/VT no mês) → BLOQUEIO por possível duplicidade;
//       · nada encontrado → despesa nova na subcategoria (Vale-refeição/Vale-transporte), já paga pelo caixa.
// Nada é lançado duas vezes: o casamento com contas já pagas em dinheiro pelo caixa (no dia operacional OU na data real) é o mesmo da SAIPOS.
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_REGISTRO_FONTE, TIPO, TIPO_CONTA } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { NATUREZA_SANGRIA_SWF as N, TIPO_REGISTRO_SANGRIA_SWF, sugerirSangriaSwf } from "../importacao/fontes/swfSangrias.js";
import { rotulo } from "../importacao/leitor.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDeTesouraria } from "./tesouraria.js";
import { FORNECEDOR_DAS_SANGRIAS, PREFIXO_DA_FONTE, SITUACAO_RETIRADA, situacaoDasRetiradas } from "./sangriasComoDespesa.js";
import { fontesDaUnidade } from "./fontesDeFaturamento.js";

const SITUACOES_JA_LANCADAS = [SITUACAO_RETIRADA.JA_LANCADA_MANUALMENTE, SITUACAO_RETIRADA.JA_LANCADA_EM_CONTA_UNICA, SITUACAO_RETIRADA.JA_LANCADA_PELA_IMPORTACAO];
export const CATEGORIAS_DE_BENEFICIO = Object.freeze(["BENEFICIOS", "VALE_REFEICAO", "VALE_TRANSPORTE"]);
/** Destino de cada retirada lançável: CRIAR (despesa nova paga) ou BAIXAR (obrigação já provisionada). */
export const DESTINO_SANGRIA = Object.freeze({ CRIAR: "CRIAR_DESPESA_PAGA", BAIXAR: "BAIXAR_OBRIGACAO_EXISTENTE" });
const dataBR = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mesAnterior = (comp) => { const [a, m] = comp.split("-").map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; };
export const descricaoDaSangriaSwf = (d) => `${d.motivoOriginal} — sangria do caixa SWF (${dataBR(d.dataReal)} ${String(d.hora ?? "").slice(0, 5)})`.slice(0, 200);
const PALAVRAS_DO_BENEFICIO = new Set(["vr", "vt", "vale", "refeicao", "alimentacao", "alimentaca", "transporte", "e", "de", "da", "do", "referente", "a", "ao", "pago", "pagamento"]);
/** Nomes no motivo ("VR FULANO" → ["fulano"]): ajudam a escolher entre obrigações; nunca bastam sozinhos para baixar nada. */
const nomesDoMotivo = (motivo) => rotulo(motivo).split(" ").filter((p) => p.length >= 3 && !PALAVRAS_DO_BENEFICIO.has(p) && !/^\d+$/.test(p));

/** Retiradas do SWF ativas com data OPERACIONAL no período. */
export async function sangriasSwfDoPeriodo(tx, cx, inicio, fim) {
  return (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO", tipoRegistro: TIPO_REGISTRO_SANGRIA_SWF } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dataReferencia >= inicio && r.dataReferencia <= fim);
}

/**
 * Competência da DRE: a do dia operacional; se o motivo diz "REFERENTE A <dia>" e esse dia é posterior ao dia operacional, a retirada
 * paga algo do MÊS ANTERIOR — a competência fica em aberto (duas opções) até a confirmação escolher.
 */
export function competenciaDaRetirada(dados) {
  const doDia = dados.dataOperacional.slice(0, 7);
  const m = /\breferente (?:a |ao |ao dia )?(\d{1,2})\b/.exec(rotulo(dados.motivoOriginal));
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[1]) > Number(dados.dataOperacional.slice(8, 10))) {
    return { competencia: null, opcoes: [mesAnterior(doDia), doDia], alerta: `O motivo diz "referente a ${m[1]}": o benefício pode ser de ${mesAnterior(doDia)}. Escolha a competência ao lançar.` };
  }
  return { competencia: doDia, opcoes: [doDia], alerta: null };
}

/** Benefício já existente no Contas a Pagar ou no banco que corresponda à retirada (só leitura). */
async function correspondenciaDoBeneficio(tx, cx, item, competencias, contexto) {
  const nomes = nomesDoMotivo(item.descricao);
  const temNome = (texto) => nomes.some((n) => rotulo(texto).split(" ").includes(n));
  const daFuncao = (o) => String(o.fonte?.idExterno ?? "").startsWith(PREFIXO_DA_FONTE);
  const candidatas = contexto.obrigacoes.filter((o) => o.situacao !== "CANCELADA" && !daFuncao(o) && CATEGORIAS_DE_BENEFICIO.includes(contexto.categoriaDe(o))
    && o.valorBaseCentavos === item.valorCentavos && competencias.includes(o.competencia));
  const comNome = candidatas.filter((o) => temNome(`${o.descricao ?? ""} ${contexto.nomeDaContraparte(o) ?? ""}`));
  const escolher = comNome.length ? comNome : candidatas;
  const abertas = escolher.filter((o) => o.saldoCentavos === item.valorCentavos);
  const pagas = escolher.filter((o) => o.saldoCentavos === 0);
  const ref = (o) => ({ obrigacaoId: o.id, descricao: o.descricao ?? null, fornecedor: contexto.nomeDaContraparte(o), competencia: o.competencia, saldoCentavos: o.saldoCentavos });
  if (pagas.length && !abertas.length) return { situacao: "DUPLICIDADE_POSSIVEL", motivo: `Benefício de mesmo valor e competência já pago (${pagas.map((o) => o.descricao ?? "conta").join("; ")}): confira antes de lançar — nada é lançado em dobro.`, referencias: pagas.map(ref) };
  if (abertas.length === 1) return { situacao: "BAIXA", obrigacao: ref(abertas[0]) };
  if (abertas.length > 1) return { situacao: "AMBIGUA", motivo: `${abertas.length} obrigações de benefício abertas com o mesmo valor e competência: a escolha é manual (Contas a Pagar).`, referencias: abertas.map(ref) };
  // Saída do banco (ex.: Unicred) com cara de VR/VT no mesmo mês e valor, sem conta vinculada: pode ser o mesmo benefício pago por outro meio.
  const doBanco = contexto.saidasDoBanco.filter((m) => m.valorCentavos === item.valorCentavos && competencias.includes(m.dataEfetiva.slice(0, 7))
    && (/\b(vr|vt|vale|beneficio|refeicao|transporte)\b/.test(rotulo(m.descricao)) || temNome(m.descricao ?? "")));
  if (doBanco.length) return { situacao: "DUPLICIDADE_POSSIVEL", motivo: `Saída do banco de mesmo valor com indício de VR/VT no mês (${doBanco.map((m) => `${dataBR(m.dataEfetiva)} ${m.descricao ?? ""}`.trim()).join("; ")}): confira antes de lançar.`, referencias: doBanco.map((m) => ({ movimentacaoId: m.id, data: m.dataEfetiva, descricao: m.descricao ?? null })) };
  return { situacao: "NENHUMA" };
}

/** Situação de cada retirada do SWF: sugestão vigente + casamento com o que já existe. Só leitura. */
export async function situacaoDasSangriasSwf(tx, cx, inicio, fim) {
  const registros = await sangriasSwfDoPeriodo(tx, cx, inicio, fim);
  const s = await situacaoDasRetiradas(tx, cx, inicio, fim, { retiradas: registros });
  const porId = new Map(registros.map((r) => [r.id, r]));
  // Correção de arquivo: despesa lançada de uma retirada que foi SUBSTITUÍDA (não está mais ativa) trava o dia — a nova versão só pode
  // ser lançada depois que a despesa antiga for estornada/cancelada (senão o mesmo dinheiro sairia duas vezes).
  const ativas = new Set(s.itens.map((i) => i.chave));
  const obrigacoes = await tx.listar(cx, TIPO.OBRIGACAO);
  const orfas = obrigacoes.filter((o) => o.situacao !== "CANCELADA" && o.fonte?.sistema === "SWF" && String(o.fonte?.idExterno ?? "").startsWith(PREFIXO_DA_FONTE) && !ativas.has(o.fonte.idExterno) && o.vencimento >= inicio && o.vencimento <= fim);
  const diasTravados = new Map(orfas.map((o) => [o.vencimento, o]));
  // Contexto para o casamento dos benefícios (carregado uma vez).
  const categoriaDoLancamento = new Map((await tx.listar(cx, TIPO.LANCAMENTO)).map((l) => [l.id, l.categoria]));
  const contrapartes = new Map((await tx.listar(cx, TIPO.CONTRAPARTE)).map((x) => [x.id, x.nome]));
  const contas = await tx.listar(cx, TIPO.CONTA);
  const bancarias = new Set(contas.filter((c) => c.tipo !== TIPO_CONTA.CAIXA_FISICO).map((c) => c.id));
  const vinculadas = new Set((await tx.listar(cx, TIPO.LIQUIDACAO)).filter((l) => l.situacao !== "ESTORNADA").map((l) => l.movimentacaoId));
  const contexto = {
    obrigacoes, categoriaDe: (o) => categoriaDoLancamento.get(o.lancamentoId) ?? o.categoria ?? null, nomeDaContraparte: (o) => contrapartes.get(o.contraparteId) ?? null,
    saidasDoBanco: (await tx.listar(cx, TIPO.MOVIMENTACAO)).filter((m) => bancarias.has(m.contaId) && m.sentido === "SAIDA" && m.situacao !== "ESTORNADA" && !vinculadas.has(m.id)),
  };

  const itens = [];
  for (const i of s.itens) {
    const d = porId.get(i.registroId).dados;
    const sug = sugerirSangriaSwf(d.motivoOriginal); // regra VIGENTE (pode ter mudado desde a importação)
    const jaLancada = SITUACOES_JA_LANCADAS.includes(i.situacao);
    const orfa = !jaLancada ? diasTravados.get(i.data) : null;
    const comp = competenciaDaRetirada(d);
    const lancavel = [N.DESPESA, N.BENEFICIO].includes(sug.natureza) && Boolean(sug.categoria);
    let destino = null; let correspondencia = null; let bloqueio = null;
    if (!jaLancada && !orfa && lancavel && i.situacao === SITUACAO_RETIRADA.NOVA) {
      if (sug.natureza === N.BENEFICIO) {
        correspondencia = await correspondenciaDoBeneficio(tx, cx, { ...i, descricao: d.motivoOriginal }, comp.opcoes, contexto);
        if (correspondencia.situacao === "BAIXA") destino = DESTINO_SANGRIA.BAIXAR;
        else if (correspondencia.situacao === "NENHUMA") destino = DESTINO_SANGRIA.CRIAR;
        else bloqueio = correspondencia.motivo;
      } else destino = DESTINO_SANGRIA.CRIAR;
    }
    const podeLancar = Boolean(destino);
    const pendencia = jaLancada ? null : orfa ? `Há despesa lançada de uma retirada substituída neste dia ("${orfa.descricao}"): estorne/cancele-a antes de lançar a versão corrigida.`
      : bloqueio ?? (!lancavel ? sug.motivo : comp.alerta);
    itens.push({
      ...i, descricao: d.motivoOriginal, dataOperacional: d.dataOperacional, dataReal: d.dataReal, dataHoraReal: d.dataHoraReal, hora: d.hora, madrugada: d.madrugada, doFechamentoAnterior: d.doFechamentoAnterior,
      operador: d.operador, formaPagamento: "DINHEIRO", origem: "Caixa SWF", naturezaSugerida: sug.natureza, regra: sug.regra, categoriaSugerida: sug.categoria, categoriaPai: sug.categoriaPai ?? null,
      motivoDaSugestao: sug.motivo, sugestaoNaImportacao: d.regra !== sug.regra ? { regra: d.regra, natureza: d.naturezaSugerida } : null,
      // Já lançada: vale a competência GRAVADA na conta (a escolhida na confirmação ou a da obrigação baixada).
      competencia: jaLancada ? obrigacoes.find((o) => o.id === i.obrigacaoId)?.competencia ?? comp.competencia : comp.competencia, competenciaOpcoes: comp.opcoes, competenciaAConfirmar: !jaLancada && !comp.competencia,
      situacaoPagamento: jaLancada ? (i.quitada === false ? "CONTA_EXISTENTE_EM_ABERTO" : "PAGO") : podeLancar ? "A_LANCAR" : bloqueio ? "BLOQUEADA" : "A_CONFERIR",
      destino, correspondencia, pendencia, despesaDeRetiradaSubstituida: orfa ? orfa.id : null, podeLancar,
    });
  }
  return { conta: s.conta, motivoSemCaixa: s.motivoSemCaixa, itens, despesasDeRetiradasSubstituidas: orfas.map((o) => ({ obrigacaoId: o.id, data: o.vencimento, descricao: o.descricao, valorCentavos: o.valorBaseCentavos })) };
}

export function operacoesDeSangriasSwf(b) {
  const nucleoNa = (tx, cx) => { const bt = baseNaTransacao(b, tx, cx); return { ...operacoesEconomicas(bt), ...operacoesDeTesouraria(bt) }; };
  const periodoDe = (e) => {
    const inicio = exigirData(e.periodoInicio, "periodoInicio");
    const fim = exigirData(e.periodoFim, "periodoFim");
    if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
    return { inicio, fim };
  };
  const exigirSwf = async (tx, cx) => {
    if (fontesDaUnidade(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade")).sistemaDeLoja !== "SWF") falhar(CODIGO.OPERACAO_INVALIDA, "Esta unidade não usa o SWF.", { motivo: "FONTE_FORA_DA_UNIDADE" });
  };
  const soma = (l) => l.reduce((t, i) => t + i.valorCentavos, 0);

  const previa = (ctx, entrada = {}) => {
    semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
    const { inicio, fim } = periodoDe(entrada);
    return b.consultar(ctx, async (cx, tx) => {
      await exigirSwf(tx, cx);
      const s = await situacaoDasSangriasSwf(tx, cx, inicio, fim);
      const grupo = (f) => { const l = s.itens.filter(f); return { quantidade: l.length, totalCentavos: soma(l) }; };
      return {
        periodoInicio: inicio, periodoFim: fim, conta: s.conta, motivoSemCaixa: s.motivoSemCaixa, fornecedor: FORNECEDOR_DAS_SANGRIAS, itens: s.itens, despesasDeRetiradasSubstituidas: s.despesasDeRetiradasSubstituidas,
        resumo: {
          total: grupo(() => true), aLancar: grupo((i) => i.podeLancar), jaLancadas: grupo((i) => SITUACOES_JA_LANCADAS.includes(i.situacao)),
          pendentes: grupo((i) => i.situacao === SITUACAO_RETIRADA.NOVA && !i.podeLancar), madrugada: grupo((i) => i.madrugada),
          beneficios: grupo((i) => i.naturezaSugerida === N.BENEFICIO), baixas: grupo((i) => i.destino === DESTINO_SANGRIA.BAIXAR), competenciaAConfirmar: grupo((i) => i.podeLancar && i.competenciaAConfirmar),
        },
        voceTemPermissao: cx.permissoes.includes(ACAO.REGISTRAR),
        efeito: "Cada retirada escolhida vira uma conta PAGA em dinheiro pelo caixa da loja: a conta fica no dia operacional do SWF e o pagamento sai na data real do desembolso (fluxo de caixa). VR/VT vão para Benefícios de pessoal (Vale-refeição/Vale-transporte); se já houver obrigação de benefício provisionada, ela é baixada em vez de criar despesa nova; se o benefício já constar pago, a retirada fica bloqueada. O que já existe pago em dinheiro pelo caixa (no dia operacional ou na data real) não é lançado de novo.",
      };
    });
  };

  /** "id=AAAA-MM" separados por ";" → Map (competência escolhida para retiradas com competência a confirmar). */
  const competenciasEscolhidas = (v) => {
    const m = new Map();
    if (v === undefined || v === null || v === "") return m;
    const lista = typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : String(v).split(";").filter(Boolean).map((x) => x.split("="));
    for (const [id, comp] of lista) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(comp ?? "").trim())) falhar(CODIGO.ENTRADA_INVALIDA, "Competência escolhida inválida (use AAAA-MM).", { campo: "competencias" });
      m.set(String(id).trim(), String(comp).trim());
    }
    return m;
  };

  return {
    previaSangriasSwf: previa,

    /** Lança as retiradas escolhidas que estão prontas. Cada uma é atômica; falhas e recusas são listadas, nunca escondidas. */
    async lancarSangriasSwf(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim", "registros", "competencias", "justificativa", "confirmar"], "lancamento");
      if (entrada.confirmar !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Confira a prévia e confirme o lançamento das retiradas escolhidas.");
      const escolhidos = new Set(Array.isArray(entrada.registros) ? entrada.registros : []);
      if (!escolhidos.size) falhar(CODIGO.ENTRADA_INVALIDA, "Escolha as retiradas a lançar.", { campo: "registros" });
      const competencias = competenciasEscolhidas(entrada.competencias);
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 300 });
      const p = await previa(ctx, { periodoInicio: entrada.periodoInicio, periodoFim: entrada.periodoFim });
      if (!p.voceTemPermissao) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Lançar as retiradas exige a permissão de registrar.", { acaoExigida: ACAO.REGISTRAR });
      if (!p.conta) falhar(CODIGO.OPERACAO_INVALIDA, p.motivoSemCaixa, { motivo: "CAIXA_FISICO_INDEFINIDO" });
      const lancadas = []; const falhas = []; const recusadas = [];
      for (const id of escolhidos) {
        const item = p.itens.find((i) => i.registroId === id);
        if (!item) { recusadas.push({ registroId: id, motivo: "Retirada não encontrada no período." }); continue; }
        if (!item.podeLancar) { recusadas.push({ registroId: id, motivo: item.pendencia ?? "Já lançada." }); continue; }
        const competencia = item.competencia ?? competencias.get(id) ?? null;
        if (!competencia) { recusadas.push({ registroId: id, motivo: item.pendencia ?? "Escolha a competência." }); continue; }
        if (!item.competenciaOpcoes.includes(competencia)) { recusadas.push({ registroId: id, motivo: `Competência ${competencia} fora das opções (${item.competenciaOpcoes.join(" ou ")}).` }); continue; }
        try {
          const feito = await b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
            const agora = (await situacaoDasSangriasSwf(tx, cx, item.data, item.data)).itens.find((x) => x.registroId === item.registroId);
            if (!agora?.podeLancar || agora.destino !== item.destino) return { ignorada: true }; // algo mudou entre a prévia e agora: nada é duplicado
            const n = nucleoNa(tx, cx);
            let obrigacaoId;
            let categoria = item.categoriaSugerida;
            if (item.destino === DESTINO_SANGRIA.BAIXAR) {
              obrigacaoId = agora.correspondencia.obrigacao.obrigacaoId;
              categoria = null; // a obrigação provisionada já tem a categoria e a competência dela: nada muda na DRE
            } else {
              // Subcategoria quando existir na unidade; senão a categoria superior (ex.: Benefícios de pessoal). Sem nenhuma, falha listada.
              if (!(await b.categoriaPorCodigo(tx, cx, categoria)) && item.categoriaPai && (await b.categoriaPorCodigo(tx, cx, item.categoriaPai))) categoria = item.categoriaPai;
              const registrada = await n.registrarObrigacao(cx, {
                contraparteNova: { tipo: "FORNECEDOR", nome: FORNECEDOR_DAS_SANGRIAS }, valorOriginalCentavos: item.valorCentavos, categoria,
                descricao: descricaoDaSangriaSwf({ motivoOriginal: item.descricao, dataReal: item.dataReal, hora: item.hora }),
                competencia, dataEmissao: item.data, vencimento: item.data, fonte: { sistema: "SWF", idExterno: item.chave },
              });
              obrigacaoId = registrada.obrigacoes[0].id;
            }
            // Pagamento na DATA REAL do desembolso (fluxo de caixa); a conta continua no dia operacional (calendário).
            const pagamento = await n.pagarContaAPagar(cx, { obrigacaoId, contaId: p.conta.id, dataEfetiva: item.dataReal, valorCentavos: item.valorCentavos });
            return { obrigacaoId, movimentacaoId: pagamento.movimentacao?.id ?? null };
          });
          if (!feito.ignorada) lancadas.push({ registroId: item.registroId, dataOperacional: item.data, dataPagamento: item.dataReal, competencia, valorCentavos: item.valorCentavos, destino: item.destino, categoria: item.destino === DESTINO_SANGRIA.BAIXAR ? null : item.categoriaSugerida, regra: item.regra, ...feito });
          else recusadas.push({ registroId: item.registroId, motivo: "A situação mudou desde a prévia: confira de novo." });
        } catch (e) {
          if ([CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.ESCOPO_NAO_AUTORIZADO, CODIGO.CONFIRMACAO_EXIGIDA].includes(e?.codigo)) throw e;
          falhas.push({ registroId: item.registroId, data: item.data, valorCentavos: item.valorCentavos, motivo: e?.message ?? "Falha ao lançar.", codigo: e?.codigo ?? null });
        }
      }
      return { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim, justificativa, lancadas, falhas, recusadas, conta: p.conta };
    },
  };
}
