// Leitura resiliente do relatório de pedidos do food delivery (.xls/.xlsx).
// Mesma técnica de vendas/sw-parser.js: lê a planilha em MATRIZ (linhas x
// colunas) via a lib `xlsx` (já usada no projeto, lê .xls e .xlsx), localiza
// o cabeçalho por conteúdo (não por posição fixa) e casa cada coluna por
// nome normalizado — tolera acento/maiúscula/espaço extra sem hardcodar
// posição nenhuma (item 14 do pedido).
//
// Toda a interpretação acontece aqui, no BACKEND — o frontend só embala o
// arquivo em base64 (mesmo padrão de bonificacaoMensalImportModal.js).
import crypto from "node:crypto";
import { ApiError } from "../../shared/ApiError.js";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** minúsculo, sem acento, espaços colapsados — comparação tolerante de cabeçalho. */
export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
/** `norm`, mas também ignora pontuação (parênteses, hífen, ponto) — cabeçalhos como "Data e horario (entregue)". */
const solto = (s) => norm(s).replace(/[().:/\-]/g, " ").replace(/\s+/g, " ").trim();

// Cada campo interno aceita uma lista de variações de cabeçalho (forma "solta").
// Adicionar uma variação nova aqui NUNCA muda o comportamento de quem já
// funciona — só amplia o que é reconhecido.
const ALIASES = {
  numeroPedido: ["n pedido", "numero pedido", "numero do pedido", "codigo do pedido", "codigo pedido", "no pedido", "pedido"],
  dataHora: ["data e hora", "data hora"],
  situacao: ["situacao", "status"],
  entregador: ["entregador", "nome do entregador"],
  taxaEntregador: ["taxa do entregador", "taxa entregador"],
  valorTotalPedido: ["valor total do pedido", "valor total"],
  formaPagamento: ["forma de pagamento"],
  razaoCancelamento: ["razao do cancelamento"],
  justificativaCancelamento: ["justificativa do cancelamento"],
  dataEntregue: ["data e horario entregue"],
  dataFinalizado: ["data e horario finalizado"],
  dataCancelado: ["data e horario cancelado"],
  // Timeline logística do pedido (item 14/motor de classificação de
  // cancelamentos, ver parserFoodDelivery.classificacao.js) — nenhuma entra
  // em OBRIGATORIOS: relatório antigo sem essas colunas continua sendo lido
  // normalmente, só que o motor cai em REVISAR por falta de evidência.
  dataPronto: ["data e horario pronto"],
  dataDespachado: ["data e horario despachado"],
  dataAceito: ["data e horario aceito"],
  dataColetado: ["data e horario coletado"],
  dataChegadaEntrega: ["data da chegada para entrega", "data e horario chegada para entrega", "data chegada para entrega"],
  dataRejeitado: ["data e horario rejeitado"],
  razaoRejeicao: ["razao da rejeicao"],
  justificativaRejeicao: ["justificativa da rejeicao"],
  origem: ["origem"],
  // Distância — auditoria confirmou (relatório real, set/2026) que "Distância
  // em rota (km)" existe no cabeçalho mas vem SEMPRE vazia; só "Distância em
  // raio (km)" tem valor real. Guardamos as duas (rota fica pronta pra uma
  // troca de fonte futura, se o relatório passar a preenchê-la), mas só a de
  // raio alimenta o Dashboard Operacional — nunca chamar isso de "km
  // rodados"/"percurso real": raio é estimativa, não trajeto percorrido.
  distanciaRaioKm: ["distancia em raio km", "distancia em raio"],
  distanciaRotaKm: ["distancia em rota km", "distancia em rota"],
  // Prazo de entrega prometido (datetime absoluto, ex. "07/09/2026 00:36:19")
  // — comparado contra `dataEntregue` na Etapa 7 (Entregas no prazo). NUNCA
  // contra `dataFinalizado` (ver parserFoodDelivery.dashboard.js).
  prazoEntrega: ["prazo de entrega", "prazo entrega"],
  // Campo de composição/produtos do pedido — fonte principal da identificação
  // de operação (Subway x Açaí no Grau x outras), ver parserFoodDelivery.operacao.js.
  detalhesPedido: ["detalhes do pedido", "detalhes pedido", "itens do pedido", "produtos do pedido"],
};
// Rótulo em pt-BR de cada campo — usado nas mensagens de erro/preview.
const ROTULO = {
  numeroPedido: "N Pedido", dataHora: "Data e hora", situacao: "Situação", entregador: "Entregador",
  taxaEntregador: "Taxa do entregador", valorTotalPedido: "Valor total do pedido", formaPagamento: "Forma de pagamento",
  razaoCancelamento: "Razão do cancelamento", justificativaCancelamento: "Justificativa do cancelamento",
  dataEntregue: "Data e horario (entregue)", dataFinalizado: "Data e horario (finalizado)",
  dataCancelado: "Data e horario (cancelado)", origem: "Origem", detalhesPedido: "Detalhes do pedido",
  dataPronto: "Data e horario (pronto)", dataDespachado: "Data e horario (despachado)",
  dataAceito: "Data e horario (aceito)", dataColetado: "Data e horario (coletado)",
  dataChegadaEntrega: "Data da chegada para entrega", dataRejeitado: "Data e horario (rejeitado)",
  razaoRejeicao: "Razão da rejeição", justificativaRejeicao: "Justificativa da rejeição",
  distanciaRaioKm: "Distância em raio (km)", distanciaRotaKm: "Distância em rota (km)",
  prazoEntrega: "Prazo de entrega",
};
// Colunas sem as quais o parser recusa o arquivo (a conciliação depende delas).
const OBRIGATORIOS = ["numeroPedido", "dataHora", "situacao", "entregador", "taxaEntregador"];

const ALIAS_PARA_CAMPO = new Map();
for (const [campo, variacoes] of Object.entries(ALIASES)) for (const v of variacoes) ALIAS_PARA_CAMPO.set(v, campo);

async function matrizDeExcel(buf) {
  const { read, utils } = await import("xlsx");
  const wb = read(buf, { type: "buffer" });
  const primeira = wb.SheetNames[0];
  if (!primeira) throw ApiError.badRequest("A planilha não tem nenhuma aba.");
  return utils.sheet_to_json(wb.Sheets[primeira], { header: 1, defval: null, raw: true });
}

/** Acha a linha de cabeçalho procurando, nas 5 primeiras linhas, a que reconhece mais colunas. */
function localizarCabecalho(matriz) {
  let melhorIdx = -1, melhorScore = 0;
  for (let i = 0; i < Math.min(matriz.length, 5); i++) {
    const linha = matriz[i] || [];
    const score = linha.filter((c) => ALIAS_PARA_CAMPO.has(solto(c))).length;
    if (score > melhorScore) { melhorScore = score; melhorIdx = i; }
  }
  return melhorScore >= 3 ? melhorIdx : -1;
}

function parseNumero(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[R$\s]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** "01/08/2026 00:15:35" (ou Date, se a planilha guardou como data real) -> ISO local, sem shift de fuso. */
function parseDataHoraBr(v) {
  if (v == null || v === "") return null;
  // `xlsx` entrega datas nativas como número serial quando a célula não foi
  // marcada como date. Convertemos em UTC apenas para fazer a aritmética do
  // calendário; o retorno continua sem sufixo de fuso, como as strings do
  // relatório, preservando a hora local informada pela operação.
  if (typeof v === "number" && Number.isFinite(v)) {
    const segundos = Math.round(v * 86400);
    const d = new Date(Date.UTC(1899, 11, 30) + segundos * 1000); // calendário Excel (inclui o ajuste de 1900)
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) { const [, dd, mm, yyyy, hh, mi, ss] = m; return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss || "00"}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) { const [, yyyy, mm, dd, hh, mi, ss] = m; return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss || "00"}`; }
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) { const [, dd, mm, yyyy] = m; return `${yyyy}-${mm}-${dd}T00:00:00`; }
  return null;
}

const dataParte = (isoDataHora) => (isoDataHora ? isoDataHora.slice(0, 10) : null);

/**
 * Lê o relatório e devolve os pedidos + período detectado.
 * @param {Buffer} buf
 * @param {string} nomeArquivo
 * @returns {Promise<{pedidos: object[], periodoInicio: string|null, periodoFim: string|null, periodoDetectado: boolean, colunasEncontradas: string[], hash: string, nomeArquivo: string}>}
 */
export async function lerRelatorio(buf, nomeArquivo) {
  const matriz = await matrizDeExcel(buf);
  const hi = localizarCabecalho(matriz);
  if (hi < 0) {
    throw ApiError.badRequest("Não reconheci o cabeçalho deste relatório (esperava colunas como \"N Pedido\", \"Situação\", \"Entregador\"...). Confira se é o relatório de pedidos correto.");
  }
  const cabecalho = matriz[hi];
  /** @type {Record<string, number>} */
  const indicePorCampo = {};
  cabecalho.forEach((celula, i) => {
    const campo = ALIAS_PARA_CAMPO.get(solto(celula));
    if (campo && !(campo in indicePorCampo)) indicePorCampo[campo] = i;
  });

  const faltando = OBRIGATORIOS.filter((campo) => !(campo in indicePorCampo));
  if (faltando.length) {
    throw ApiError.badRequest(`Coluna(s) obrigatória(s) não encontrada(s) no relatório: ${faltando.map((c) => `"${ROTULO[c]}"`).join(", ")}.`);
  }

  const pedidos = [];
  let periodoInicio = null, periodoFim = null;
  for (let r = hi + 1; r < matriz.length; r++) {
    const linha = matriz[r];
    if (!linha || linha.every((c) => c === null || c === "" || c === undefined)) continue;

    const numeroPedido = linha[indicePorCampo.numeroPedido];
    if (numeroPedido == null || String(numeroPedido).trim() === "") continue; // linha sem código não é um pedido

    const dataHora = parseDataHoraBr(linha[indicePorCampo.dataHora]);
    if (dataHora) {
      const d = dataParte(dataHora);
      if (!periodoInicio || d < periodoInicio) periodoInicio = d;
      if (!periodoFim || d > periodoFim) periodoFim = d;
    }

    const dadosBrutos = {};
    cabecalho.forEach((celula, i) => {
      const rotulo = celula == null || celula === "" ? `coluna_${i + 1}` : String(celula).trim();
      dadosBrutos[rotulo] = linha[i] ?? null;
    });

    pedidos.push({
      numeroPedido: String(numeroPedido).trim(),
      dataHora,
      situacao: linha[indicePorCampo.situacao] != null ? String(linha[indicePorCampo.situacao]).trim() : null,
      entregador: linha[indicePorCampo.entregador] != null ? String(linha[indicePorCampo.entregador]).trim() : null,
      taxaEntregador: parseNumero(linha[indicePorCampo.taxaEntregador]),
      valorTotalPedido: indicePorCampo.valorTotalPedido != null ? parseNumero(linha[indicePorCampo.valorTotalPedido]) : null,
      formaPagamento: indicePorCampo.formaPagamento != null && linha[indicePorCampo.formaPagamento] != null ? String(linha[indicePorCampo.formaPagamento]).trim() : null,
      razaoCancelamento: indicePorCampo.razaoCancelamento != null && linha[indicePorCampo.razaoCancelamento] != null ? String(linha[indicePorCampo.razaoCancelamento]).trim() : null,
      justificativaCancelamento: indicePorCampo.justificativaCancelamento != null && linha[indicePorCampo.justificativaCancelamento] != null ? String(linha[indicePorCampo.justificativaCancelamento]).trim() : null,
      dataEntregue: indicePorCampo.dataEntregue != null ? parseDataHoraBr(linha[indicePorCampo.dataEntregue]) : null,
      dataFinalizado: indicePorCampo.dataFinalizado != null ? parseDataHoraBr(linha[indicePorCampo.dataFinalizado]) : null,
      dataCancelado: indicePorCampo.dataCancelado != null ? parseDataHoraBr(linha[indicePorCampo.dataCancelado]) : null,
      dataPronto: indicePorCampo.dataPronto != null ? parseDataHoraBr(linha[indicePorCampo.dataPronto]) : null,
      dataDespachado: indicePorCampo.dataDespachado != null ? parseDataHoraBr(linha[indicePorCampo.dataDespachado]) : null,
      dataAceito: indicePorCampo.dataAceito != null ? parseDataHoraBr(linha[indicePorCampo.dataAceito]) : null,
      dataColetado: indicePorCampo.dataColetado != null ? parseDataHoraBr(linha[indicePorCampo.dataColetado]) : null,
      dataChegadaEntrega: indicePorCampo.dataChegadaEntrega != null ? parseDataHoraBr(linha[indicePorCampo.dataChegadaEntrega]) : null,
      dataRejeitado: indicePorCampo.dataRejeitado != null ? parseDataHoraBr(linha[indicePorCampo.dataRejeitado]) : null,
      razaoRejeicao: indicePorCampo.razaoRejeicao != null && linha[indicePorCampo.razaoRejeicao] != null ? String(linha[indicePorCampo.razaoRejeicao]).trim() : null,
      justificativaRejeicao: indicePorCampo.justificativaRejeicao != null && linha[indicePorCampo.justificativaRejeicao] != null ? String(linha[indicePorCampo.justificativaRejeicao]).trim() : null,
      origem: indicePorCampo.origem != null && linha[indicePorCampo.origem] != null ? String(linha[indicePorCampo.origem]).trim() : null,
      detalhesPedido: indicePorCampo.detalhesPedido != null && linha[indicePorCampo.detalhesPedido] != null ? String(linha[indicePorCampo.detalhesPedido]) : null,
      distanciaRaioKm: indicePorCampo.distanciaRaioKm != null ? parseNumero(linha[indicePorCampo.distanciaRaioKm]) : null,
      distanciaRotaKm: indicePorCampo.distanciaRotaKm != null ? parseNumero(linha[indicePorCampo.distanciaRotaKm]) : null,
      prazoEntrega: indicePorCampo.prazoEntrega != null ? parseDataHoraBr(linha[indicePorCampo.prazoEntrega]) : null,
      dadosBrutos,
    });
  }

  if (!pedidos.length) throw ApiError.badRequest("Não encontrei nenhum pedido neste relatório (planilha vazia ou só com o cabeçalho).");

  return {
    pedidos,
    periodoInicio, periodoFim,
    periodoDetectado: !!(periodoInicio && periodoFim),
    colunasEncontradas: Object.keys(indicePorCampo).map((c) => ROTULO[c]),
    // Sem esta coluna não dá pra identificar a operação de cada pedido (ver
    // parserFoodDelivery.operacao.js) — o serviço usa esta flag pra decidir
    // se tenta classificar por pedido ou avisa que não foi possível separar.
    colunaDetalhesEncontrada: indicePorCampo.detalhesPedido != null,
    hash: sha256(buf), nomeArquivo,
  };
}

// ---------- entrada da API: arquivo base64 -> Buffer ----------
const MAX_ARQUIVO = 15 * 1024 * 1024; // 15 MB
export function decodificarArquivo(arq) {
  if (!arq?.conteudoBase64) throw ApiError.badRequest("Arquivo sem conteúdo.");
  const nome = String(arq.nomeArquivo || "").toLowerCase();
  if (!/\.(xls|xlsx)$/.test(nome)) throw ApiError.badRequest("Envie um arquivo .xls ou .xlsx.");
  const buf = Buffer.from(arq.conteudoBase64, "base64");
  if (!buf.length) throw ApiError.badRequest("Arquivo vazio ou corrompido.");
  if (buf.length > MAX_ARQUIVO) throw ApiError.badRequest("Arquivo acima de 15 MB.");
  return buf;
}
