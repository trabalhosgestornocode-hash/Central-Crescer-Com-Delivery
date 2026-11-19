// SWF — relatório de SANGRIAS (retiradas do caixa), layout REAL conferido com a exportação XLSX de 01–17/11/2026 da Subway Saci.
//
// Layout: título, loja, período; cabeçalho "Data/Hora | Motivo | Operador | Valor" (repetido a cada página); uma linha de DIA
// ("Dom, 01/11/2026") que abre o grupo; as retiradas do dia; subtotal " (3) | R$ 12,34"; rodapé de impressão; total " (30) | R$ 1.234,56".
//
//   - DATA OPERACIONAL = o dia do grupo do SWF (fechamento do caixa). DATA/HORA REAL = a da linha. Ficam separadas: uma retirada de
//     04/11 00:04 no grupo de 03/11 é do fechamento de 03/11 (o SWF já agrupa assim) e guarda a hora real;
//   - madrugada (antes das 06:00) é sinalizada para conferência, mesmo quando o SWF a pôs no próprio dia;
//   - cabeçalhos repetidos, rodapés, subtotais e o total NUNCA viram movimentação: subtotais e total são CONFERIDOS;
//   - importar não lança nada. A classificação é SUGESTÃO por regras explícitas (REGRAS_SANGRIA_SWF); só retirada com natureza DESPESA
//     pode virar despesa paga em dinheiro, numa etapa separada e confirmada. VR/VT, adiantamento, transferência e motivo desconhecido
//     ficam PENDENTES de conferência — nunca viram despesa em silêncio.
import { DIVERGENCIA, diferenca } from "../motor.js";
import { centavos, rotulo } from "../leitor.js";
import { col, definirFonte } from "./comum.js";
import { somar } from "../../dominio/dinheiro.js";
import { formatarBRL } from "../../dominio/dinheiro.js";

export const SWF_SANGRIAS = "SWF_SANGRIAS";
export const TIPO_REGISTRO_SANGRIA_SWF = "SANGRIA_SWF";

/** Natureza sugerida para o motivo digitado no SWF. Só DESPESA pode virar despesa paga; as demais exigem conferência. */
export const NATUREZA_SANGRIA_SWF = Object.freeze({
  DESPESA: "DESPESA", BENEFICIO: "BENEFICIO", BENEFICIO_A_CONFERIR: "BENEFICIO_A_CONFERIR", ADIANTAMENTO: "ADIANTAMENTO", TRANSFERENCIA: "TRANSFERENCIA", A_CLASSIFICAR: "A_CLASSIFICAR",
});
const N = NATUREZA_SANGRIA_SWF;
/**
 * Regras auditáveis, na ordem: a PRIMEIRA que casa decide a sugestão. Cada regra tem código (vai para o registro) e motivo.
 * Regras de pendência vêm ANTES das de despesa: "VALE REFEIÇÃO" nunca cai numa regra de compra.
 */
export const REGRAS_SANGRIA_SWF = Object.freeze([
  { codigo: "TRANSFERENCIA", padrao: /\b(transferencia|deposito|cofre|troco|sangria para)\b/, natureza: N.TRANSFERENCIA, motivo: "Dinheiro que muda de lugar (cofre, banco, troco): não é despesa." },
  // Regra confirmada pelo dono (19/11/2026): VR e VT são Benefícios de pessoal (subcategorias Vale-refeição e Vale-transporte). Normalmente pagos
  // pelo banco (Unicred), às vezes em dinheiro pelo caixa. Antes de lançar, procura obrigação provisionada (baixa) ou pagamento anterior (bloqueio).
  { codigo: "VT", padrao: /\b(vt|vale transporte)\b/, natureza: N.BENEFICIO, categoria: "VALE_TRANSPORTE", categoriaPai: "BENEFICIOS", subtipo: "VALE_TRANSPORTE", motivo: "Vale-transporte pago em dinheiro pelo caixa." },
  { codigo: "VR", padrao: /\b(vr|vale refeicao|vale alimentacao|refeicao e alimentaca?o?)\b/, natureza: N.BENEFICIO, categoria: "VALE_REFEICAO", categoriaPai: "BENEFICIOS", subtipo: "VALE_REFEICAO", motivo: "Vale-refeição pago em dinheiro pelo caixa." },
  { codigo: "ADIANTAMENTO", padrao: /\b(adiantamento|adiant|vale)\b/, natureza: N.ADIANTAMENTO, motivo: "Adiantamento a funcionário: é a receber/abatimento de salário, não despesa nova." },
  { codigo: "DIARIA", padrao: /^diaria\b/, natureza: N.DESPESA, categoria: "DIARIAS_EXTRAS", motivo: "Diária paga em dinheiro." },
  { codigo: "SEGURANCA", padrao: /^seguranca\b/, natureza: N.DESPESA, categoria: "SERVICOS_DE_TERCEIROS", motivo: "Serviço de segurança pago em dinheiro." },
  { codigo: "FRETE_E_TAXA_DE_COMPRA", padrao: /^(uber|taxa|taxas)\b/, natureza: N.DESPESA, categoria: "SERVICOS_DE_TERCEIROS", motivo: "Frete/serviço de entrega ou de compra pago em dinheiro." },
  { codigo: "DESCARTAVEIS", padrao: /\b(copo|copos|sacola|sacolas|papel manteiga|guardanapo|embalagem)\b/, natureza: N.DESPESA, categoria: "EMBALAGENS", motivo: "Descartáveis/embalagens comprados em dinheiro." },
  { codigo: "MATERIAL_DE_ESCRITORIO", padrao: /\b(grampo|grampos|etiqueta|etiquetadora|caneta|papel a4)\b/, natureza: N.DESPESA, categoria: "MATERIAL_DE_ESCRITORIO", motivo: "Material de escritório comprado em dinheiro." },
  { codigo: "LIMPEZA", padrao: /\b(rodo|vassoura|detergente|limpeza|pano)\b/, natureza: N.DESPESA, categoria: "OUTRAS_DESPESAS", motivo: "Material de limpeza comprado em dinheiro." },
]);
export function sugerirSangriaSwf(motivo) {
  const r = rotulo(motivo);
  const regra = REGRAS_SANGRIA_SWF.find((x) => x.padrao.test(r));
  return regra ? { natureza: regra.natureza, regra: regra.codigo, categoria: regra.categoria ?? null, categoriaPai: regra.categoriaPai ?? null, subtipo: regra.subtipo ?? null, motivo: regra.motivo } : { natureza: N.A_CLASSIFICAR, regra: null, categoria: null, motivo: "Motivo não reconhecido por nenhuma regra: classifique na conferência." };
}

const DIA = /^(dom|seg|ter|qua|qui|sex|sab)\w*,?\s*(\d{2})\/(\d{2})\/(\d{4})$/i;
const DATA_HORA = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const CONTAGEM = /^\((\d+)\)$/;
const PERIODO_DOC = /(\d{2})\/(\d{2})\/(\d{4})\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/;
const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Planilha impressa → tabela longa: Tipo | DataOperacional | DataHora | Motivo | Operador | Valor | Quantidade | Loja | PeriodoInicioDoc | PeriodoFimDoc.
 * Tipo: MOV (retirada), SUBTOTAL (do dia), TOTAL (do relatório). Cabeçalho repetido e rodapé de página somem; linha não reconhecida
 * vira tipo DESCONHECIDA (aparece como erro na prévia — nunca é ignorada em silêncio).
 */
export function tabelaDeSangriasSwf(linhas) {
  const cab = linhas.findIndex((l) => { const r = l.map(rotulo); return r.includes("data hora") && r.includes("motivo") && r.includes("valor"); });
  if (cab < 0) return linhas;
  let loja = null; let periodo = null;
  for (const l of linhas.slice(0, cab)) for (const c of l) {
    const t = String(c ?? "").trim();
    const m = PERIODO_DOC.exec(t);
    if (m && !periodo) periodo = { inicio: `${m[3]}-${m[2]}-${m[1]}`, fim: `${m[6]}-${m[5]}-${m[4]}` };
    else if (/^subway\b/i.test(t) && !loja) loja = t.replace(/\s+/g, " ").toUpperCase();
  }
  const saida = [["Tipo", "DataOperacional", "DataHora", "Motivo", "Operador", "Valor", "Quantidade", "Loja", "PeriodoInicioDoc", "PeriodoFimDoc"]];
  let dia = "";
  const doc = [loja ?? "", periodo?.inicio ?? "", periodo?.fim ?? ""];
  for (const l of linhas.slice(cab + 1)) {
    const cheias = l.map((c) => String(c ?? "").trim()).filter(Boolean);
    if (!cheias.length) continue;
    const r = cheias.map(rotulo);
    if (r.includes("data hora") && r.includes("motivo")) continue; // cabeçalho repetido na página seguinte
    if (/^(dom|seg|ter|qua|qui|sex|sab),? \d{1,2} [a-z]{3} \d{4}/.test(semAcento(cheias[0]).toLowerCase()) || cheias.some((c) => /^p.gina \d+ de/i.test(semAcento(c)))) continue; // rodapé de impressão
    const d = DIA.exec(semAcento(cheias[0]));
    if (cheias.length === 1 && d) { dia = `${d[4]}-${d[3]}-${d[2]}`; continue; }
    const cont = CONTAGEM.exec(cheias[0]);
    if (cont && cheias.length === 2) { saida.push(["SUBTOTAL", dia, "", "", "", cheias[1], cont[1], ...doc]); continue; }
    if (DATA_HORA.test(cheias[0])) { saida.push(["MOV", dia, cheias[0], cheias[1] ?? "", cheias.length >= 4 ? cheias[2] : "", cheias.at(-1), "", ...doc]); continue; }
    saida.push(["DESCONHECIDA", dia, "", cheias.join(" | ").slice(0, 200), "", "", "", ...doc]);
  }
  // O ÚLTIMO "(n) R$" do arquivo é o total do relatório (vem depois do subtotal do último dia).
  const subs = saida.map((x, i) => [x, i]).filter(([x]) => x[0] === "SUBTOTAL");
  if (subs.length >= 2) {
    const [ultimo] = subs.at(-1);
    const [penultimo, ip] = subs.at(-2);
    const movsDepois = saida.slice(ip + 1).some((x) => x[0] === "MOV");
    if (!movsDepois && penultimo[1] === ultimo[1]) ultimo[0] = "TOTAL";
  }
  return saida;
}

export const SWF_SANGRIAS_ADAPTADOR = definirFonte({
  fonte: "OUTRO",
  tipoRelatorio: SWF_SANGRIAS,
  tipoDocumento: "OUTRO",
  descricao: "relatório de sangrias do SWF",
  formatosHomologados: ["xlsx"],
  colunas: {
    tipo: col(["Tipo"]), dataOperacional: col(["DataOperacional"]), dataHora: col(["DataHora"]), motivo: col(["Motivo"]), operador: col(["Operador"]), valor: col(["Valor"]),
    quantidade: col(["Quantidade"]), loja: col(["Loja"], false), periodoInicioDoc: col(["PeriodoInicioDoc"], false), periodoFimDoc: col(["PeriodoFimDoc"], false),
  },
  prepararTabela: tabelaDeSangriasSwf,
  ehTotal: (u) => ["SUBTOTAL", "TOTAL"].includes(u.bruto("tipo")),
  lerTotal(u) {
    let v = null;
    try { v = centavos(u.bruto("valor").replace(/^R\$\s*/, ""), "valor"); } catch (e) { u.erro("VALOR_INVALIDO", e.message, "valor"); return null; }
    return { tipo: u.bruto("tipo"), dia: u.bruto("dataOperacional") || null, quantidade: Number(u.bruto("quantidade")), valorCentavos: v };
  },
  converter(u) {
    if (u.bruto("tipo") === "DESCONHECIDA") { u.erro("FORMATO_NAO_RECONHECIDO", `Linha não reconhecida no relatório de sangrias: "${u.bruto("motivo")}".`, "linha"); return null; }
    const ini = u.bruto("periodoInicioDoc"); const fim = u.bruto("periodoFimDoc");
    if (!ini || !fim) u.erro("PERIODO_INCORRETO", "O relatório não informa o período no cabeçalho.", "periodo");
    else if (ini !== u.periodo.inicio || fim !== u.periodo.fim) u.erro("PERIODO_INCORRETO", `O relatório é de ${ini} a ${fim}, diferente do período declarado (${u.periodo.inicio} a ${u.periodo.fim}).`, "periodo");
    const dataOperacional = u.bruto("dataOperacional");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataOperacional)) u.erro("DATA_INVALIDA", "Retirada fora de um grupo de dia do SWF.", "dataOperacional");
    const quando = u.dataHora("dataHora");
    const valor = u.valor("valor");
    const motivo = u.texto("motivo");
    if (u.erros.length) return null;
    if (valor <= 0) { u.erro("VALOR_INVALIDO", "Retirada com valor zero ou negativo.", "valor"); return null; }
    const operador = u.bruto("operador").replace(/\s+/g, " ").trim() || null;
    const horaNum = Number(quando.hora?.slice(0, 2) ?? 12);
    const sugestao = sugerirSangriaSwf(motivo);
    const dataHoraReal = `${quando.data}T${quando.hora ?? "00:00:00"}`;
    return {
      tipoRegistro: TIPO_REGISTRO_SANGRIA_SWF, idExterno: null, data: dataOperacional, valorCentavos: valor,
      dados: {
        dataOperacional, dataHoraReal, dataReal: quando.data, hora: quando.hora, madrugada: horaNum < 6,
        doFechamentoAnterior: quando.data > dataOperacional, motivoOriginal: motivo, descricaoOriginal: motivo, operador,
        valorAbsolutoCentavos: valor, naturezaSugerida: sugestao.natureza, regra: sugestao.regra, categoriaSugerida: sugestao.categoria, motivoDaSugestao: sugestao.motivo,
        estabelecimento: u.bruto("loja") || null, formaPagamento: "DINHEIRO", origem: "CAIXA_SWF",
      },
      // Sem identificador da fonte: a impressão digital usa a data/hora real (ao segundo), o motivo, o operador e o valor.
      identidade: { tipoRegistro: TIPO_REGISTRO_SANGRIA_SWF, dataHoraReal, motivo: rotulo(motivo), operador: rotulo(operador), valor },
    };
  },
  /** Arquivo corrigido: retiradas já importadas nos dias deste arquivo que ele NÃO traz viram divergência (substituição só com aceite). */
  conflitosComImportadas({ registros, anteriores, periodo }) {
    const chaves = new Set(registros.map((r) => r.chave));
    const ausentes = anteriores.filter((a) => a.tipoRegistro === TIPO_REGISTRO_SANGRIA_SWF && a.dataReferencia >= periodo.inicio && a.dataReferencia <= periodo.fim && !chaves.has(a.chaveIdempotencia));
    const porDia = new Map();
    for (const a of ausentes) porDia.set(a.dataReferencia, [...(porDia.get(a.dataReferencia) ?? []), a]);
    const divergencias = [...porDia].sort(([x], [y]) => x.localeCompare(y)).map(([data, lista]) => ({
      codigo: DIVERGENCIA.CONFLITO_COM_IMPORTADO, linha: null, quantidade: lista.length,
      mensagem: `Dia ${data.slice(8, 10)}/${data.slice(5, 7)}: ${lista.length} retirada(s) já importada(s) (${lista.map((a) => `${a.dados.motivoOriginal} ${formatarBRL(a.dados.valorAbsolutoCentavos)}`).join("; ")}) que este arquivo NÃO traz. Se for um arquivo corrigido, aceite a substituição com justificativa; senão, nada é somado em dobro.`,
    }));
    return { divergencias, ausentes };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    const porDia = new Map();
    for (const r of registros) { const x = porDia.get(r.data) ?? { quantidade: 0, valorCentavos: 0 }; x.quantidade += 1; x.valorCentavos = somar(x.valorCentavos, r.valorCentavos); porDia.set(r.data, x); }
    const subtotais = declarados.filter((d) => d.tipo === "SUBTOTAL");
    for (const d of subtotais) {
      const x = porDia.get(d.dia) ?? { quantidade: 0, valorCentavos: 0 };
      if (x.valorCentavos !== d.valorCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `Subtotal do dia ${d.dia} não confere com a soma das retiradas.`, d.valorCentavos, x.valorCentavos, { linha: d.linha }));
      if (x.quantidade !== d.quantidade) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `Dia ${d.dia}: o SWF conta ${d.quantidade} retirada(s), o arquivo traz ${x.quantidade}.`, linha: d.linha });
    }
    for (const dia of porDia.keys()) if (!subtotais.some((d) => d.dia === dia)) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `Dia ${dia} sem subtotal impresso no relatório.` });
    const total = registros.reduce((s, r) => somar(s, r.valorCentavos), 0);
    const totais = declarados.filter((d) => d.tipo === "TOTAL");
    if (!totais.length) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: "O relatório não traz o total geral impresso: confira se o arquivo está completo." });
    for (const d of totais) {
      if (d.valorCentavos !== total) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Total do relatório não confere com a soma das retiradas.", d.valorCentavos, total, { linha: d.linha }));
      if (d.quantidade !== registros.length) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `O SWF conta ${d.quantidade} retirada(s), o arquivo traz ${registros.length}.`, linha: d.linha });
    }
    const porNatureza = {};
    for (const r of registros) { const k = r.dados.naturezaSugerida; porNatureza[k] = { quantidade: (porNatureza[k]?.quantidade ?? 0) + 1, valorCentavos: somar(porNatureza[k]?.valorCentavos ?? 0, r.valorCentavos) }; }
    for (const r of registros.filter((x) => ![N.DESPESA, N.BENEFICIO].includes(x.dados.naturezaSugerida))) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `"${r.dados.motivoOriginal}" (${formatarBRL(r.valorCentavos)}): ${r.dados.motivoDaSugestao}`, linha: r.linha, valorCentavos: r.valorCentavos });
    return {
      controles: {
        sangriasSwf: {
          retiradas: registros.length, totalCentavos: total, dias: porDia.size, porNatureza,
          madrugada: registros.filter((r) => r.dados.madrugada).length, doFechamentoAnterior: registros.filter((r) => r.dados.doFechamentoAnterior).length,
          porDia: [...porDia].sort(([a], [b]) => a.localeCompare(b)).map(([data, x]) => ({ data, ...x })),
        },
      },
      divergencias,
    };
  },
});
