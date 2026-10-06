// Lançamento "Sanduíches + Saladas" no formulário do Dashboard iFood
// (Checkpoints E/F) — estado por fonte de venda, abas acessíveis, painéis das
// Etapas 1–4, consolidado da unidade, validação mínima e payload.
//
// Os nomes exibidos ("Sanduíches", "Saladas") vêm do backend, que é quem
// garante as duas fontes quando o SuperAdmin liga a opção na unidade.
//
// Usado por dashboardExecutivoForm.js SÓ quando o GET por data devolve o bloco
// `multicanal` (dia multicanal). Dia padrão nunca passa por aqui.
//
// O frontend não decide estrutura, participantes, escopo de entregadores nem
// aplicabilidade (Full Service): renderiza o que o backend devolveu. Nenhum
// nome de canal/empresa é conhecido aqui — são dados.
//
// Convenções iguais às do formulário padrão: campo vazio ("") = não
// informado (nunca vira 0); dinheiro no formato digitado/mascarado, convertido
// só no payload (numeroDecimal). As prévias espelham as fórmulas do servidor
// (Σ dos canais; null se algum canal estiver sem o valor) apenas para exibição
// — o consolidado gravado é sempre o que o backend recalcula.
import { escapeHtml, fmtMoeda, fmtPct } from "./utils.js";
import { icon } from "./icons.js";
import { aplicarMascaraMoeda, formatarMoedaBRL, numeroDecimal, numeroDecimalOuIndefinido } from "./numeroDecimal.js";

export const SITUACOES_CANAL = [
  ["com_vendas", "Com vendas"],
  ["sem_vendas", "Sem vendas"],
  ["nao_informado", "Não informado"],
];
const ROTULO_ESTADO = { completo: "completo", incompleto: "incompleto", sem_vendas: "sem vendas", nao_informado: "não informado" };
const CAMPOS_DESEMPENHO = ["qtdVendas", "valorVendasBruto", "novosClientes"];
const CAMPOS_FINANCEIRO = ["valorVendasIfood", "taxasComissoes", "servicosPromocoes", "taxasEntregadores", "ajustesFavorLoja", "ajustesContraLoja"];
const CAMPOS_INTEIROS = new Set(["qtdVendas", "novosClientes"]);
const ROTULO_CAMPO_QUEDA = {
  valorVendasIfood: "Financeiro Oficial", taxasComissoes: "Taxas e Comissões",
  servicosPromocoes: "Serviços e Promoções", taxasEntregadores: "Taxas de Entregadores",
};

const vazio = (v) => v === "" || v == null;
const paraCampo = (v) => (v == null ? "" : v);
const valorMoedaInput = (v) => escapeHtml(formatarMoedaBRL(v));
const operou = (situacao) => situacao === "normal" || situacao === "parcial";
const numeroDoCampo = (campo, v) => (vazio(v) ? null : (CAMPOS_INTEIROS.has(campo) ? Number(v) : numeroDecimal(v)));
const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const naoInformado = '<span class="dex-mc-ni">Não informado</span>';
const moedaOuNi = (v) => (v == null ? naoInformado : escapeHtml(fmtMoeda(v)));
const numeroOuNi = (v) => (v == null ? naoInformado : escapeHtml(String(v)));

// ---------------------------------------------------------------------------
// ESTADO
// ---------------------------------------------------------------------------

/**
 * Estado do formulário a partir do bloco `multicanal` do GET por data.
 * Dia novo: cada canal começa "Com vendas" (mesmo espírito do "normal" já
 * pré-marcado na unidade) e com todos os campos VAZIOS.
 */
export function criarEstadoMulticanal(bloco) {
  const salvos = new Map((bloco.valores ?? []).map((v) => [v.canalId, v]));
  const diaNovo = !(bloco.valores ?? []).length;
  const mc = {
    escopo: bloco.taxasEntregadoresEscopo === "canal" ? "canal" : "unidade",
    entregadoresAplicavel: bloco.entregadoresAplicavel !== false,
    canais: (bloco.canais ?? []).map((c) => {
      const v = salvos.get(c.canalId);
      return {
        canalId: c.canalId,
        nome: c.nome,
        situacaoCanal: v?.situacaoCanal ?? (diaNovo ? "com_vendas" : null),
        campos: Object.fromEntries([...CAMPOS_DESEMPENHO, ...CAMPOS_FINANCEIRO].map((k) => [k, paraCampo(v?.[k])])),
      };
    }),
    anteriores: new Map((bloco.anteriores ?? []).map((a) => [a.canalId, a])),
    taxasEntregadoresUnidade: paraCampo(bloco.taxasEntregadoresEscopo === "canal" ? null : bloco.consolidado?.taxasEntregadores),
    servidor: { consolidado: bloco.consolidado ?? null, resumo: bloco.resumo ?? null },
    etapaIncompleta: bloco.etapaIncompleta ?? null,
    alterado: false,
    abaAtiva: null,
  };
  return mc;
}

const canalPorId = (mc, id) => mc.canais.find((c) => c.canalId === id) ?? null;

/** "Sanduíches e Saladas" — os nomes das fontes, na ordem do backend. */
export function rotuloFontes(mc) {
  const nomes = mc.canais.map((c) => c.nome);
  return nomes.length > 1 ? `${nomes.slice(0, -1).join(", ")} e ${nomes.at(-1)}` : (nomes[0] ?? "");
}
const entregadoresNoCanal = (mc) => mc.escopo === "canal" && mc.entregadoresAplicavel;
const entregadoresNaUnidade = (mc) => mc.escopo !== "canal" && mc.entregadoresAplicavel;

/** Muda a situação de um canal. "Sem vendas" pré-preenche (só campos VAZIOS) o Financeiro com o último extrato do canal. */
export function definirSituacaoCanal(mc, canalId, situacao) {
  const canal = canalPorId(mc, canalId);
  if (!canal) return;
  canal.situacaoCanal = situacao;
  mc.alterado = true;
  if (situacao === "sem_vendas") {
    const fin = mc.anteriores.get(canalId)?.financeiro;
    if (fin) {
      for (const k of CAMPOS_FINANCEIRO) {
        if (k === "taxasEntregadores" && !entregadoresNoCanal(mc)) continue;
        if (vazio(canal.campos[k]) && fin[k] != null) canal.campos[k] = fin[k];
      }
    }
  }
}

export function definirCampoCanal(mc, canalId, campo, valor) {
  const canal = canalPorId(mc, canalId);
  if (!canal) return;
  canal.campos[campo] = valor;
  mc.alterado = true;
}

/** Desempenho EFETIVO de um canal: "Sem vendas" repete o acumulado anterior devolvido pelo backend (ou fica não informado). */
export function desempenhoDoCanal(mc, canal) {
  if (canal.situacaoCanal === "nao_informado" || !canal.situacaoCanal) return { qtdVendas: null, valorVendasBruto: null, novosClientes: null };
  if (canal.situacaoCanal === "sem_vendas") {
    const d = mc.anteriores.get(canal.canalId)?.desempenho;
    return d?.conhecido
      ? { qtdVendas: d.qtdVendas ?? null, valorVendasBruto: d.valorVendasBruto ?? null, novosClientes: d.novosClientes ?? null }
      : { qtdVendas: null, valorVendasBruto: null, novosClientes: null };
  }
  return Object.fromEntries(CAMPOS_DESEMPENHO.map((k) => [k, numeroDoCampo(k, canal.campos[k])]));
}

const ticket = (bruto, qtd) => (bruto == null || qtd == null || !(Number(qtd) > 0) ? null : Number(bruto) / Number(qtd));

/** Σ com a regra do servidor: null se QUALQUER canal estiver sem o valor. */
function somar(valores, inteiro = false) {
  if (!valores.length || valores.some((v) => v == null || !Number.isFinite(Number(v)))) return null;
  return inteiro ? valores.reduce((s, v) => s + Number(v), 0) : valores.reduce((s, v) => s + Math.round(Number(v) * 100), 0) / 100;
}

/** Consolidado de Desempenho: o do servidor enquanto nada mudou; depois, prévia com a mesma regra. */
export function consolidadoDesempenho(mc) {
  if (!mc.alterado && mc.servidor.consolidado) {
    const c = mc.servidor.consolidado;
    return { qtdVendas: c.qtdVendas, valorVendasBruto: c.valorVendasBruto, novosClientes: c.novosClientes, ticketMedio: mc.servidor.resumo?.ticketMedio ?? ticket(c.valorVendasBruto, c.qtdVendas) };
  }
  const efetivos = mc.canais.map((c) => desempenhoDoCanal(mc, c));
  const qtdVendas = somar(efetivos.map((e) => e.qtdVendas), true);
  const valorVendasBruto = somar(efetivos.map((e) => e.valorVendasBruto));
  // Ticket consolidado = Σ bruto ÷ Σ pedidos — nunca média dos tickets dos canais.
  return { qtdVendas, valorVendasBruto, novosClientes: somar(efetivos.map((e) => e.novosClientes), true), ticketMedio: ticket(valorVendasBruto, qtdVendas) };
}

/** Consolidado Financeiro (prévia): Σ por campo; ajustes somam os conhecidos; entregadores conforme escopo. */
export function consolidadoFinanceiro(mc) {
  if (!mc.alterado && mc.servidor.consolidado && mc.servidor.consolidado.valorVendasIfood != null) {
    const c = mc.servidor.consolidado;
    return { valorVendasIfood: c.valorVendasIfood, taxasComissoes: c.taxasComissoes, servicosPromocoes: c.servicosPromocoes, taxasEntregadores: c.taxasEntregadores, ajustesFavorLoja: c.ajustesFavorLoja, ajustesContraLoja: c.ajustesContraLoja };
  }
  const ativos = mc.canais;
  const algumNi = ativos.some((c) => c.situacaoCanal === "nao_informado" || !c.situacaoCanal);
  const campo = (k) => (algumNi ? null : somar(ativos.map((c) => numeroDoCampo(k, c.campos[k]))));
  const ajuste = (k) => {
    if (algumNi) return null;
    const conhecidos = ativos.map((c) => numeroDoCampo(k, c.campos[k])).filter((v) => v != null && Number.isFinite(v));
    return conhecidos.length ? somar(conhecidos) : null;
  };
  return {
    valorVendasIfood: campo("valorVendasIfood"), taxasComissoes: campo("taxasComissoes"), servicosPromocoes: campo("servicosPromocoes"),
    taxasEntregadores: !mc.entregadoresAplicavel ? null
      : entregadoresNoCanal(mc) ? campo("taxasEntregadores") : numeroDoCampo("taxasEntregadores", mc.taxasEntregadoresUnidade),
    ajustesFavorLoja: ajuste("ajustesFavorLoja"), ajustesContraLoja: ajuste("ajustesContraLoja"),
  };
}

/** Derivados da prévia financeira — mesmas fórmulas do servidor, sobre o consolidado. */
export function previaFinanceira(mc) {
  const f = consolidadoFinanceiro(mc);
  const base = f.valorVendasIfood;
  const partes = [f.taxasComissoes, f.servicosPromocoes, f.taxasEntregadores, f.ajustesContraLoja];
  const totalDed = partes.every((p) => p == null) ? null : partes.reduce((s, p) => s + (p ?? 0), 0);
  const pct = (v) => (v == null || base == null || !(base > 0) ? null : (v / base) * 100);
  return {
    ...f, totalDed,
    pctTaxas: pct(f.taxasComissoes), pctServicos: pct(f.servicosPromocoes), pctEntregadores: pct(f.taxasEntregadores),
    pctTotal: pct(totalDed), receita: base == null || totalDed == null ? null : base - totalDed + (f.ajustesFavorLoja ?? 0),
  };
}

/** Campos obrigatórios do Financeiro de um canal (com/sem vendas). */
function obrigatoriosFinanceiro(mc) {
  return ["valorVendasIfood", "taxasComissoes", "servicosPromocoes", ...(entregadoresNoCanal(mc) ? ["taxasEntregadores"] : [])];
}

/**
 * Estado visual de UM canal numa etapa: completo | incompleto | sem_vendas |
 * nao_informado. Desempenho é opcional no fluxo, mas a aba mostra
 * "incompleto" enquanto faltar algo, para orientar o preenchimento.
 */
export function estadoCanal(mc, canal, etapa, { mostrarFinanceiro = true } = {}) {
  if (canal.situacaoCanal === "nao_informado") return "nao_informado";
  if (!canal.situacaoCanal) return "incompleto";
  if (etapa === "financeiro" && mostrarFinanceiro) {
    const falta = obrigatoriosFinanceiro(mc).some((k) => vazio(canal.campos[k]));
    if (falta) return "incompleto";
    return canal.situacaoCanal === "sem_vendas" ? "sem_vendas" : "completo";
  }
  if (canal.situacaoCanal === "sem_vendas") return "sem_vendas";
  if (etapa === "desempenho") return CAMPOS_DESEMPENHO.some((k) => vazio(canal.campos[k])) ? "incompleto" : "completo";
  return "completo";
}

/** Aba que abre: a já escolhida; senão o primeiro canal incompleto; senão o primeiro. */
export function abaInicial(mc, etapa, opts) {
  if (mc.abaAtiva && canalPorId(mc, mc.abaAtiva)) return mc.abaAtiva;
  const incompleto = mc.canais.find((c) => ["incompleto", "nao_informado"].includes(estadoCanal(mc, c, etapa, opts)));
  return (incompleto ?? mc.canais[0])?.canalId ?? null;
}

/** Financeiro de todos os canais pronto para finalizar (antecipa o 400 do backend). */
export function financeiroMulticanalCompleto(mc) {
  if (mc.canais.some((c) => c.situacaoCanal === "nao_informado" || !c.situacaoCanal)) return false;
  if (mc.canais.some((c) => obrigatoriosFinanceiro(mc).some((k) => vazio(c.campos[k])))) return false;
  return !entregadoresNaUnidade(mc) || !vazio(mc.taxasEntregadoresUnidade);
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO MÍNIMA (a autoritativa é o backend)
// ---------------------------------------------------------------------------
export function validarEtapaMulticanal(mc, etapa, { mostrarFinanceiro = true } = {}) {
  const semSituacao = mc.canais.find((c) => !c.situacaoCanal);
  if (semSituacao) return `Informe a situação do canal "${semSituacao.nome}".`;
  const invalido = (k, v) => !vazio(v) && (CAMPOS_INTEIROS.has(k) ? !(Number(v) >= 0) : !(numeroDoCampo(k, v) >= 0));
  if (etapa === "desempenho") {
    for (const c of mc.canais.filter((x) => x.situacaoCanal === "com_vendas")) {
      if (CAMPOS_DESEMPENHO.some((k) => invalido(k, c.campos[k]))) return `Valores de desempenho inválidos no canal "${c.nome}".`;
    }
  }
  if (etapa === "financeiro" && mostrarFinanceiro) {
    const ni = mc.canais.find((c) => c.situacaoCanal === "nao_informado");
    if (ni) return `O canal "${ni.nome}" está como "Não informado". Informe os valores (ou marque "Sem vendas") antes de seguir — ou salve como rascunho.`;
    for (const c of mc.canais) {
      if (obrigatoriosFinanceiro(mc).some((k) => vazio(c.campos[k]))) return `Preencha os campos financeiros obrigatórios do canal "${c.nome}".`;
      if (CAMPOS_FINANCEIRO.some((k) => invalido(k, c.campos[k]))) return `Valores financeiros inválidos no canal "${c.nome}".`;
    }
    if (entregadoresNaUnidade(mc)) {
      if (vazio(mc.taxasEntregadoresUnidade)) return "Informe as taxas de entregadores da unidade.";
      if (invalido("taxasEntregadores", mc.taxasEntregadoresUnidade)) return "Informe uma taxa de entregadores válida.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PAYLOAD (contrato do Checkpoint D) — nunca manda o consolidado
// ---------------------------------------------------------------------------
const numOuIndefinido = (k, v) => (vazio(v) ? undefined : (CAMPOS_INTEIROS.has(k) ? Number(v) : numeroDecimalOuIndefinido(v)));

/**
 * `{ canais, taxasEntregadores? }` para POST/PUT de um dia multicanal.
 * Unidade "Não funcionou"/"Sem vendas": nada de canais (o backend gera).
 * Desempenho só de canal "Com vendas" (em "Sem vendas" o backend repete o
 * acumulado); Financeiro de "Com/Sem vendas" só quando a etapa existe.
 */
export function payloadMulticanal(mc, { situacao, mostrarFinanceiro }) {
  if (!operou(situacao)) return {};
  const canais = mc.canais.map((c) => {
    const item = { canalId: c.canalId, situacaoCanal: c.situacaoCanal ?? undefined };
    if (c.situacaoCanal === "com_vendas") for (const k of CAMPOS_DESEMPENHO) item[k] = numOuIndefinido(k, c.campos[k]);
    if (mostrarFinanceiro && (c.situacaoCanal === "com_vendas" || c.situacaoCanal === "sem_vendas")) {
      for (const k of CAMPOS_FINANCEIRO) {
        if (k === "taxasEntregadores" && !entregadoresNoCanal(mc)) continue;
        item[k] = numOuIndefinido(k, c.campos[k]);
      }
    }
    return item;
  });
  const extra = mostrarFinanceiro && entregadoresNaUnidade(mc)
    ? { taxasEntregadores: numOuIndefinido("taxasEntregadores", mc.taxasEntregadoresUnidade) }
    : {};
  return { canais, ...extra };
}

/** Consolidado no formato de `fm.campos` — só para a Conferência (Etapa 4) exibir a unidade. */
export function camposConsolidadosParaConferencia(mc, campos) {
  const d = consolidadoDesempenho(mc);
  const f = consolidadoFinanceiro(mc);
  const v = (x) => (x == null ? "" : x);
  return {
    ...campos,
    qtdVendas: v(d.qtdVendas), valorVendasBruto: v(d.valorVendasBruto), novosClientes: v(d.novosClientes),
    valorVendasIfood: v(f.valorVendasIfood), taxasComissoes: v(f.taxasComissoes), servicosPromocoes: v(f.servicosPromocoes),
    taxasEntregadores: v(f.taxasEntregadores), ajustesFavorLoja: v(f.ajustesFavorLoja), ajustesContraLoja: v(f.ajustesContraLoja),
  };
}

/**
 * Texto de um sinal de queda de acumulado para o usuário — nunca o código
 * interno (`canal:<uuid>:<campo>`). Sinal de canal ganha frase própria com o
 * NOME do canal; sinal do consolidado mantém a mensagem do servidor.
 */
export function mensagemSinalQueda(sinal) {
  const [, , campo] = /^canal:([^:]+):(.+)$/.exec(sinal?.campo ?? "") ?? [];
  if (!campo || !sinal.canal) return sinal?.mensagem ?? "";
  const rotulo = ROTULO_CAMPO_QUEDA[campo] ?? "o valor";
  return `O acumulado de ${rotulo} do canal ${sinal.canal} é menor que o último valor informado `
    + `(${fmtMoeda(sinal.valorAnterior)} em ${fmtDataBr(sinal.dataAnterior)}; agora ${fmtMoeda(sinal.valorNovo)}).`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Etapa 1 — bloco compacto "Situação por canal" (só com a unidade normal/parcial). */
export function htmlSituacaoCanais(mc, { visivel }) {
  return `
    <fieldset class="dex-mc-situacao" id="dex-mc-situacao" ${visivel ? "" : "hidden"}>
      <legend>${escapeHtml(rotuloFontes(mc))}</legend>
      ${mc.canais.map((c) => `
        <div class="dex-mc-sit-linha" role="radiogroup" aria-label="Situação de ${escapeHtml(c.nome)} neste dia">
          <span class="dex-mc-sit-nome">${escapeHtml(c.nome)}</span>
          <span class="dex-mc-sit-opcoes">
            ${SITUACOES_CANAL.map(([valor, rotulo]) => `
              <label class="dex-radio"><input type="radio" class="dex-mc-sit" name="dex-mc-sit-${escapeHtml(c.canalId)}" data-canal="${escapeHtml(c.canalId)}" value="${valor}" ${c.situacaoCanal === valor ? "checked" : ""}> ${rotulo}</label>`).join("")}
          </span>
        </div>`).join("")}
      <p class="dex-form-info dex-mc-nota">Os dois entram no resultado da unidade. "Sem vendas" mantém o acumulado do mês (o dia não soma nada). "Não informado" deixa em aberto — dá para salvar como rascunho, mas não finalizar o Financeiro.</p>
    </fieldset>`;
}

/** Abas dos canais (segmented control). Botões com role=tab, roving tabindex e estado discreto. */
export function htmlAbas(mc, etapa, opts) {
  return `
    <div class="dex-mc-abas" role="tablist" aria-label="${escapeHtml(rotuloFontes(mc))}">
      ${mc.canais.map((c) => {
        const ativo = c.canalId === mc.abaAtiva;
        const estado = estadoCanal(mc, c, etapa, opts);
        return `<button type="button" role="tab" class="dex-mc-aba dex-mc-aba--${estado}${ativo ? " ativo" : ""}" id="dex-mc-aba-${escapeHtml(c.canalId)}"
          data-canal="${escapeHtml(c.canalId)}" aria-selected="${ativo}" aria-controls="dex-mc-painel" tabindex="${ativo ? 0 : -1}"><span class="dex-mc-aba-marca" aria-hidden="true"></span><span class="dex-mc-aba-nome">${escapeHtml(c.nome)}</span><span class="sr-only"> — ${ROTULO_ESTADO[estado]}</span></button>`;
      }).join("")}
    </div>`;
}

const painelAberto = (mc) => `<div class="dex-mc-painel" id="dex-mc-painel" role="tabpanel" aria-labelledby="dex-mc-aba-${escapeHtml(mc.abaAtiva ?? "")}">`;

function notaNaoInformado(etapa, nome) {
  return `<p class="dex-form-info dex-mc-nota">${icon("info", { size: 13 })} ${escapeHtml(nome)} está como "Não informado"${etapa === "financeiro" ? " — precisa ser informado (ou marcado como \"Sem vendas\") antes de finalizar com o Financeiro" : ""}. Altere a situação na Etapa 1 se já tiver os dados.</p>`;
}

/** Etapa 2 — Desempenho por canal + consolidado da unidade. */
export function htmlDesempenhoMulticanal(mc, { inicioMesBr, dataBr, mostrarFinanceiro }) {
  mc.abaAtiva = abaInicial(mc, "desempenho", { mostrarFinanceiro });
  const canal = canalPorId(mc, mc.abaAtiva);
  let painel = "";
  if (canal?.situacaoCanal === "nao_informado") painel = notaNaoInformado("desempenho", canal.nome);
  else if (canal?.situacaoCanal === "sem_vendas") {
    const d = desempenhoDoCanal(mc, canal);
    const conhecido = mc.anteriores.get(canal.canalId)?.desempenho?.conhecido;
    painel = `
      <p class="dex-form-info dex-mc-nota">${icon("info", { size: 13 })} ${escapeHtml(canal.nome)} sem vendas neste dia: o acumulado do mês se repete (nenhum incremento).${conhecido ? "" : ` Ainda não há acumulado confiável de ${escapeHtml(canal.nome)} no mês — fica como não informado.`}</p>
      <div class="cfg-form-grid">
        <label class="cfg-campo"><span>Quantidade de vendas acumulada no mês</span><input type="text" id="dex-mc-qtd" value="${d.qtdVendas ?? ""}" placeholder="Não informado" disabled></label>
        <label class="cfg-campo"><span>Valor bruto acumulado no mês (R$)</span><input type="text" id="dex-mc-valorbruto" value="${d.valorVendasBruto == null ? "" : valorMoedaInput(d.valorVendasBruto)}" placeholder="Não informado" disabled></label>
        <label class="cfg-campo"><span>Novos clientes acumulados no mês</span><input type="text" id="dex-mc-novos" value="${d.novosClientes ?? ""}" placeholder="Não informado" disabled></label>
        <label class="cfg-campo"><span>Ticket médio — ${escapeHtml(canal.nome)} (mês até aqui)</span><input type="text" id="dex-mc-ticket" value="${escapeHtml(fmtMoeda(ticket(d.valorVendasBruto, d.qtdVendas)))}" disabled></label>
      </div>`;
  } else if (canal) {
    const c = canal.campos;
    const ant = mc.anteriores.get(canal.canalId)?.desempenho;
    const efet = desempenhoDoCanal(mc, canal);
    painel = `
      <div class="cfg-form-grid">
        <label class="cfg-campo"><span>Quantidade de vendas acumulada no mês</span><input type="number" min="0" step="1" id="dex-mc-qtd" data-campo="qtdVendas" value="${escapeHtml(String(c.qtdVendas))}" placeholder="Não informado"></label>
        <label class="cfg-campo"><span>Valor bruto acumulado no mês (R$)</span><input type="text" inputmode="decimal" data-moeda id="dex-mc-valorbruto" data-campo="valorVendasBruto" value="${valorMoedaInput(c.valorVendasBruto)}" placeholder="R$ 0,00"></label>
        <label class="cfg-campo"><span>Novos clientes acumulados no mês</span><input type="number" min="0" step="1" id="dex-mc-novos" data-campo="novosClientes" value="${escapeHtml(String(c.novosClientes))}" placeholder="Não informado"></label>
        <label class="cfg-campo"><span>Ticket médio — ${escapeHtml(canal.nome)} (mês até aqui)</span><input type="text" id="dex-mc-ticket" value="${escapeHtml(fmtMoeda(ticket(efet.valorVendasBruto, efet.qtdVendas)))}" disabled></label>
      </div>
      ${ant?.conhecido && (ant.qtdVendas || ant.valorVendasBruto) ? `<p class="dex-mc-anterior">Último acumulado de ${escapeHtml(canal.nome)}: ${escapeHtml(String(ant.qtdVendas ?? "—"))} vendas · ${escapeHtml(fmtMoeda(ant.valorVendasBruto))}</p>` : ""}`;
  }
  return `
    <p class="dex-form-info">${icon("bar-chart", { size: 13 })} Desempenho acumulado do mês até aqui — informe o TOTAL de ${escapeHtml(rotuloFontes(mc))}, cada um na sua aba, desde ${inicioMesBr} até ${dataBr} (não só o que esse dia fez sozinho). O consolidado da unidade é a soma dos dois. O sistema calcula automaticamente quanto cada dia rendeu, pela diferença com o acumulado do dia anterior. Nada aqui é obrigatório: o que ficar em branco fica registrado como "não informado", nunca como zero.</p>
    ${htmlAbas(mc, "desempenho", { mostrarFinanceiro })}
    ${painelAberto(mc)}${painel}</div>
    ${htmlConsolidadoDesempenho(mc)}`;
}

export function htmlConsolidadoDesempenho(mc) {
  const d = consolidadoDesempenho(mc);
  return `
    <section class="dex-mc-consolidado" aria-label="Consolidado da unidade">
      <h4>Consolidado da unidade</h4>
      <div class="dex-calc-preview">
        <div><span>Quantidade de vendas</span><b data-mc-cons="qtdVendas">${numeroOuNi(d.qtdVendas)}</b></div>
        <div><span>Valor bruto</span><b data-mc-cons="valorVendasBruto">${moedaOuNi(d.valorVendasBruto)}</b></div>
        <div><span>Novos clientes</span><b data-mc-cons="novosClientes">${numeroOuNi(d.novosClientes)}</b></div>
        <div class="destaque"><span>Ticket médio</span><b data-mc-cons="ticketMedio">${moedaOuNi(d.ticketMedio)}</b></div>
      </div>
    </section>`;
}

/** Etapa 3 — Financeiro por canal + operação logística da unidade + prévia consolidada. */
export function htmlFinanceiroMulticanal(mc, { inicioBr, fimBr }) {
  mc.abaAtiva = abaInicial(mc, "financeiro", { mostrarFinanceiro: true });
  const canal = canalPorId(mc, mc.abaAtiva);
  let painel = "";
  if (canal?.situacaoCanal === "nao_informado") painel = notaNaoInformado("financeiro", canal.nome);
  else if (canal) {
    const c = canal.campos;
    const fin = mc.anteriores.get(canal.canalId)?.financeiro;
    const campo = (id, chave, rotulo, obrig, ajuda = "") => `
      <label class="cfg-campo"><span>${rotulo}${obrig ? " *" : ""}</span>
        <input type="text" inputmode="decimal" data-moeda id="${id}" data-campo="${chave}" value="${valorMoedaInput(c[chave])}" placeholder="R$ 0,00">
        ${ajuda ? `<small class="cfg-campo-ajuda">${ajuda}</small>` : ""}</label>`;
    painel = `
      ${canal.situacaoCanal === "sem_vendas" ? `<p class="dex-form-info dex-mc-nota">${icon("info", { size: 13 })} Sem vendas neste dia não zera o extrato: informe o acumulado do mês de ${escapeHtml(canal.nome)}${fin ? " (pré-preenchido com o último extrato — confira)" : ""}.</p>` : ""}
      <div class="cfg-form-grid">
        ${campo("dex-mc-vifood", "valorVendasIfood", "Valor das vendas no financeiro do iFood (R$)", true)}
        ${campo("dex-mc-taxas", "taxasComissoes", "Taxas e comissões (R$)", true)}
        ${campo("dex-mc-servicos", "servicosPromocoes", "Serviços e promoções (R$)", true)}
        ${entregadoresNoCanal(mc) ? campo("dex-mc-entregadores", "taxasEntregadores", `Taxas de entregadores — ${escapeHtml(canal.nome)} (R$)`, true) : ""}
        ${campo("dex-mc-aj-favor", "ajustesFavorLoja", "Ajustes a favor da loja (R$)", false, "Créditos, reembolsos ou correções que aumentam o valor recebido pela loja.")}
        ${campo("dex-mc-aj-contra", "ajustesContraLoja", "Ajustes contra a loja (R$)", false, "Débitos, descontos ou correções que reduzem o valor recebido pela loja.")}
      </div>
      ${fin ? `<p class="dex-mc-anterior">Último extrato de ${escapeHtml(canal.nome)} (${fmtDataBr(fin.dataReferencia)}): vendas ${escapeHtml(fmtMoeda(fin.valorVendasIfood))} · taxas ${escapeHtml(fmtMoeda(fin.taxasComissoes))} · serviços ${escapeHtml(fmtMoeda(fin.servicosPromocoes))}</p>` : ""}`;
  }
  const logistica = entregadoresNaUnidade(mc) ? `
    <section class="dex-mc-logistica" aria-label="Operação logística da unidade">
      <h4>${icon("truck", { size: 14 })} Operação logística da unidade</h4>
      <label class="cfg-campo"><span>Taxas de entregadores (R$) *</span>
        <input type="text" inputmode="decimal" data-moeda id="dex-mc-entregadores-unidade" value="${valorMoedaInput(mc.taxasEntregadoresUnidade)}" placeholder="R$ 0,00">
        <small class="cfg-campo-ajuda">Este valor é compartilhado por ${escapeHtml(rotuloFontes(mc))} e deve ser informado apenas uma vez, para a unidade.</small></label>
    </section>` : "";
  return `
    <p class="dex-form-info">${icon("calendar", { size: 13 })} Financeiro acumulado do mês até aqui — dados de ${inicioBr} até ${fimBr}, o extrato que o iFood libera hoje, de ${escapeHtml(rotuloFontes(mc))}, cada um na sua aba. Digite o valor normalmente. Use vírgula para centavos.</p>
    ${htmlAbas(mc, "financeiro", { mostrarFinanceiro: true })}
    ${painelAberto(mc)}${painel}</div>
    ${logistica}
    ${htmlConsolidadoFinanceiro(mc)}`;
}

export function htmlConsolidadoFinanceiro(mc) {
  const p = previaFinanceira(mc);
  return `
    <section class="dex-mc-consolidado" aria-label="Consolidado da unidade">
      <h4>Consolidado da unidade</h4>
      <div class="dex-calc-preview">
        <div><span>Vendas (iFood)</span><b data-mc-cons="valorVendasIfood">${moedaOuNi(p.valorVendasIfood)}</b></div>
        <div><span>% Taxas e comissões</span><b data-mc-cons="pctTaxas">${p.pctTaxas == null ? naoInformado : fmtPct(p.pctTaxas)}</b></div>
        <div><span>% Serviços e promoções</span><b data-mc-cons="pctServicos">${p.pctServicos == null ? naoInformado : fmtPct(p.pctServicos)}</b></div>
        ${mc.entregadoresAplicavel ? `<div><span>% Taxas de entregadores</span><b data-mc-cons="pctEntregadores">${p.pctEntregadores == null ? naoInformado : fmtPct(p.pctEntregadores)}</b></div>` : ""}
        <div><span>Total de deduções</span><b data-mc-cons="totalDed">${moedaOuNi(p.totalDed)}</b></div>
        <div><span>% Total de deduções</span><b data-mc-cons="pctTotal">${p.pctTotal == null ? naoInformado : fmtPct(p.pctTotal)}</b></div>
        <div class="destaque"><span>Receita líquida</span><b data-mc-cons="receita">${moedaOuNi(p.receita)}</b></div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// ETAPA 4 — CONFERÊNCIA: Sanduíches, Saladas, Operação da unidade, Consolidado.
// Tudo somente leitura (texto) — o total nunca é editável.
// ---------------------------------------------------------------------------
const ROTULO_SITUACAO = { com_vendas: "Com vendas", sem_vendas: "Sem vendas", nao_informado: "Não informado" };
const linhaConf = (rotulo, valorHtml) => `<div class="dex-conf-item"><span>${rotulo}</span><b>${valorHtml}</b></div>`;
const pctOuNi = (v) => (v == null ? naoInformado : escapeHtml(fmtPct(v)));
const moedaComPct = (v, pctV) => (v == null ? naoInformado : `${escapeHtml(fmtMoeda(v))} <small class="dex-mc-pct">(${pctV == null ? "—" : escapeHtml(fmtPct(pctV))})</small>`);

/**
 * @param {{mostrarFinanceiro: boolean}} opts — sem Financeiro (dia que não é D-1) mostra só o Desempenho.
 */
export function htmlConferenciaMulticanal(mc, { mostrarFinanceiro }) {
  const blocoFonte = (canal) => {
    const d = desempenhoDoCanal(mc, canal);
    const fin = (k) => (canal.situacaoCanal === "nao_informado" ? null : numeroDoCampo(k, canal.campos[k]));
    return `
      <section class="dex-mc-conf-bloco" aria-label="${escapeHtml(canal.nome)}">
        <h4>${escapeHtml(canal.nome)} <span class="dex-mc-conf-sit">${ROTULO_SITUACAO[canal.situacaoCanal] ?? "—"}</span></h4>
        <div class="dex-conf-grid">
          ${linhaConf("Quantidade de vendas", numeroOuNi(d.qtdVendas))}
          ${linhaConf("Valor bruto", moedaOuNi(d.valorVendasBruto))}
          ${linhaConf("Novos clientes", numeroOuNi(d.novosClientes))}
          ${mostrarFinanceiro ? `
          ${linhaConf("Financeiro Oficial", moedaOuNi(fin("valorVendasIfood")))}
          ${linhaConf("Taxas e Comissões", moedaOuNi(fin("taxasComissoes")))}
          ${linhaConf("Serviços e Promoções", moedaOuNi(fin("servicosPromocoes")))}
          ${linhaConf("Ajustes a favor", moedaOuNi(fin("ajustesFavorLoja")))}
          ${linhaConf("Ajustes contra", moedaOuNi(fin("ajustesContraLoja")))}` : ""}
        </div>
      </section>`;
  };
  const d = consolidadoDesempenho(mc);
  const p = previaFinanceira(mc);
  const operacao = mostrarFinanceiro ? `
    <section class="dex-mc-conf-bloco" aria-label="Operação da unidade">
      <h4>Operação da unidade</h4>
      <div class="dex-conf-grid">
        ${linhaConf("Taxa de entregadores", mc.entregadoresAplicavel
          ? moedaOuNi(numeroDoCampo("taxasEntregadores", mc.taxasEntregadoresUnidade))
          : "Não se aplica (Full Service)")}
      </div>
    </section>` : "";
  const consolidadoFin = mostrarFinanceiro ? `
          ${linhaConf("Financeiro Oficial", moedaOuNi(p.valorVendasIfood))}
          ${linhaConf("Taxas e Comissões", moedaComPct(p.taxasComissoes, p.pctTaxas))}
          ${linhaConf("Serviços e Promoções", moedaComPct(p.servicosPromocoes, p.pctServicos))}
          ${mc.entregadoresAplicavel ? linhaConf("Taxa de entregadores", moedaComPct(p.taxasEntregadores, p.pctEntregadores)) : ""}
          ${linhaConf("Ajustes a favor", moedaOuNi(p.ajustesFavorLoja))}
          ${linhaConf("Ajustes contra", moedaOuNi(p.ajustesContraLoja))}
          ${linhaConf("Total de deduções", moedaComPct(p.totalDed, p.pctTotal))}
          ${linhaConf("% Total de deduções", pctOuNi(p.pctTotal))}
          ${linhaConf("Receita líquida", moedaOuNi(p.receita))}` : "";
  return `
    ${mc.canais.map(blocoFonte).join("")}
    ${operacao}
    <section class="dex-mc-conf-bloco dex-mc-conf-consolidado" aria-label="Consolidado da unidade">
      <h4>Consolidado da unidade <span class="dex-mc-conf-sit">${escapeHtml(rotuloFontes(mc))}</span></h4>
      <div class="dex-conf-grid">
        ${linhaConf("Quantidade total", numeroOuNi(d.qtdVendas))}
        ${linhaConf("Valor bruto total", moedaOuNi(d.valorVendasBruto))}
        ${linhaConf("Novos clientes", numeroOuNi(d.novosClientes))}
        ${linhaConf("Ticket médio", moedaOuNi(d.ticketMedio))}
        ${consolidadoFin}
      </div>
      <p class="dex-form-info dex-mc-nota">Somente leitura — o resultado da unidade é sempre a soma de ${escapeHtml(rotuloFontes(mc))}${mostrarFinanceiro && mc.entregadoresAplicavel ? " mais a taxa de entregadores da unidade" : ""}, recalculada pelo sistema ao salvar.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// LIGAÇÃO DE EVENTOS
// ---------------------------------------------------------------------------

/** Atualiza, sem redesenhar (o foco fica no campo), consolidados e marcas das abas. */
function atualizarEmLugar(m, mc, etapa, opts) {
  const dados = etapa === "desempenho" ? consolidadoDesempenho(mc) : previaFinanceira(mc);
  const fmt = {
    qtdVendas: numeroOuNi, novosClientes: numeroOuNi, valorVendasBruto: moedaOuNi, ticketMedio: moedaOuNi,
    valorVendasIfood: moedaOuNi, totalDed: moedaOuNi, receita: moedaOuNi,
    pctTaxas: (v) => (v == null ? naoInformado : fmtPct(v)), pctServicos: (v) => (v == null ? naoInformado : fmtPct(v)),
    pctEntregadores: (v) => (v == null ? naoInformado : fmtPct(v)), pctTotal: (v) => (v == null ? naoInformado : fmtPct(v)),
  };
  for (const b of m.querySelectorAll("[data-mc-cons]")) {
    const chave = b.dataset.mcCons;
    if (fmt[chave]) b.innerHTML = fmt[chave](dados[chave]);
  }
  const canal = canalPorId(mc, mc.abaAtiva);
  if (etapa === "desempenho" && canal) {
    const t = m.querySelector("#dex-mc-ticket");
    const e = desempenhoDoCanal(mc, canal);
    if (t) t.value = fmtMoeda(ticket(e.valorVendasBruto, e.qtdVendas));
  }
  for (const c of mc.canais) {
    const aba = m.querySelector(`#dex-mc-aba-${c.canalId}`);
    if (!aba) continue;
    const estado = estadoCanal(mc, c, etapa, opts);
    for (const est of Object.keys(ROTULO_ESTADO)) aba.classList.remove(`dex-mc-aba--${est}`);
    aba.classList.add(`dex-mc-aba--${estado}`);
    // O estado também é anunciado a leitores de tela — mantém em sincronia.
    const leitor = aba.querySelector(".sr-only");
    if (leitor) leitor.textContent = ` — ${ROTULO_ESTADO[estado]}`;
  }
}

/**
 * Liga os eventos da etapa corrente.
 * @param {{rerender: () => void, mostrarFinanceiro: boolean, aoAlterarFinanceiro?: () => void}} ctx
 */
export function ligarCanais(m, mc, etapa, ctx) {
  const opts = { mostrarFinanceiro: ctx.mostrarFinanceiro };
  if (etapa === "situacao") {
    for (const r of m.querySelectorAll(".dex-mc-sit")) {
      r.addEventListener("change", (e) => definirSituacaoCanal(mc, e.target.dataset.canal, e.target.value));
    }
    return;
  }

  // Abas: clique e teclado (setas, Home, End) — padrão WAI-ARIA de tabs.
  const abas = [...m.querySelectorAll(".dex-mc-aba")];
  const ir = (canalId) => {
    mc.abaAtiva = canalId;
    ctx.rerender();
    m.querySelector(`#dex-mc-aba-${canalId}`)?.focus();
  };
  abas.forEach((aba, i) => {
    aba.addEventListener("click", () => ir(aba.dataset.canal));
    aba.addEventListener("keydown", (e) => {
      const alvo = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: abas.length - 1 }[e.key];
      if (alvo == null) return;
      e.preventDefault?.();
      ir(abas[(alvo + abas.length) % abas.length].dataset.canal);
    });
  });

  const canal = canalPorId(mc, mc.abaAtiva);
  const aoMudar = (financeiro) => () => {
    atualizarEmLugar(m, mc, etapa, opts);
    if (financeiro) ctx.aoAlterarFinanceiro?.();
  };
  if (canal) {
    for (const input of m.querySelectorAll("#dex-mc-painel [data-campo]")) {
      const chave = input.dataset.campo;
      if (input.disabled) continue;
      if ("moeda" in input.dataset) {
        aplicarMascaraMoeda(input, { aoAlterar: (valor) => { definirCampoCanal(mc, canal.canalId, chave, valor); aoMudar(etapa === "financeiro")(); } });
      } else {
        input.addEventListener("input", (e) => { definirCampoCanal(mc, canal.canalId, chave, e.target.value); aoMudar(false)(); });
      }
    }
  }
  aplicarMascaraMoeda(m.querySelector("#dex-mc-entregadores-unidade"), {
    aoAlterar: (valor) => { mc.taxasEntregadoresUnidade = valor; mc.alterado = true; aoMudar(true)(); },
  });
}

export { operou as situacaoOperouMulticanal };
