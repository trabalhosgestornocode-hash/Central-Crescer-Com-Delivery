// Núcleo PURO da importação da Central Financeira Unificada → Financeiro 2.0 (contas a pagar).
// Não lê arquivo nem banco: recebe a Central já lida + o estado atual do sistema e devolve um PLANO.
//
// Garantias:
//  • identificador de origem preservado: chave_origem = "central:CP:<ID>" / "central:PAG:<ID>" (+ referencia_origem com aba e linha);
//  • sem duplicidade: chave já existente com o MESMO conteúdo → "existente" (nada a gravar); com conteúdo diferente → "divergente"
//    (NUNCA sobrescreve; vai para o relatório);
//  • movimentos bancários NÃO são importados como lançamentos: a Central os tem em nível de transação, o sistema já tem o caixa
//    (Fluxo de Caixa). Eles só servem para LOCALIZAR o lançamento do sistema que corresponde a cada pagamento;
//  • vínculo pagamento ↔ saída do extrato só como SUGESTÃO (ou divergência); confirmar é sempre humano;
//  • valor original, valor pago e acréscimo/desconto PRESUMIDO separados; a classificação (juros/multa/…) fica para a contadora;
//  • nenhum de-para é adivinhado: categoria ou conta sem correspondência explícita BLOQUEIA o registro (com motivo).
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

export const TIPOS_IMPORTAVEIS = Object.freeze(["Obrigação"]);
export const TOLERANCIA_CENTAVOS = 1;

export const chaveObrigacao = (id) => `central:CP:${id}`;
export const chavePagamento = (id) => `central:PAG:${id}`;
export const impressaoObrigacao = (o) => [sa(o.fornecedor), sa(o.categoriaSistema), o.competencia, o.vencimento, o.valorCentavos].join("|");
export const impressaoPagamento = (p) => [p.obrigacaoChave, sa(p.contaSistema), p.data, p.valorCentavos].join("|");

const diasEntre = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * @param central  { obrigacoes, pagamentos, movimentos, fluxo }  (lerCentralXlsx)
 * @param sistema  { contas:[{id,nome}], categorias:[{id,nome,tipo}], fornecedores:[{id,nome}],
 *                   lancamentos:[{id,conta,data,sentido,valorCentavos,descricao,status,transferencia}],
 *                   obrigacoes:[{id,chave,impressao}], pagamentos:[{id,chave,impressao}], vinculos:[{pagamentoChave,lancamentoId}],
 *                   mesesFechados:["AAAA-MM"] }
 * @param dePara   { contas: {nomeCentral: nomeSistema}, categorias: {nomeCentral: nomeSistema} }
 */
export function planejarImportacaoCentral({ central, sistema, dePara, tipos = TIPOS_IMPORTAVEIS }) {
  const contaPorNome = new Map(sistema.contas.map((c) => [sa(c.nome), c]));
  const catPorNome = new Map(sistema.categorias.map((c) => [sa(c.nome), c]));
  const dpConta = new Map(Object.entries(dePara.contas ?? {}).map(([k, v]) => [sa(k), v]));
  const dpCat = new Map(Object.entries(dePara.categorias ?? {}).map(([k, v]) => [sa(k), v]));
  const fechados = new Set(sistema.mesesFechados ?? []);
  const obrExist = new Map(sistema.obrigacoes.map((o) => [o.chave, o]));
  const pagExist = new Map(sistema.pagamentos.map((p) => [p.chave, p]));
  const vincExist = new Set((sistema.vinculos ?? []).map((v) => v.pagamentoChave));
  const fornExist = new Map(sistema.fornecedores.map((f) => [sa(f.nome), f]));

  const fornAusente = dePara.fornecedorAusente ? String(dePara.fornecedorAusente).trim() : null;   // opção EXPLÍCITA; desligada = bloqueia
  const resolverConta = (nome) => { const alvo = dpConta.get(sa(nome)); return alvo == null ? null : contaPorNome.get(sa(alvo)) ?? null; };
  const resolverCat = (nome) => { const alvo = dpCat.get(sa(nome)); return alvo == null ? null : catPorNome.get(sa(alvo)) ?? null; };

  // ---------- obrigações ----------
  const obrigacoes = [], excluidas = [];
  for (const o of central.obrigacoes) {
    if (!tipos.includes(o.tipoRegistro)) { excluidas.push({ id: o.id, tipo: o.tipoRegistro, motivo: "tipo de registro fora de contas a pagar (transferência interna, entre empresas ou de terceiros)" }); continue; }
    if (o.cancelado) { excluidas.push({ id: o.id, tipo: o.tipoRegistro, motivo: "cancelada na Central" }); continue; }
    const cat = resolverCat(o.categoria);
    const motivos = [], pendencias = [];
    const complemento = (dePara.fornecedoresPorId ?? {})[o.id]?.trim() || null;   // planilha preenchida pela contadora (não altera a Central)
    const fornecedor = o.fornecedor || complemento || fornAusente || "";
    if (!o.fornecedor && !complemento && !fornAusente) motivos.push("sem fornecedor");
    if (!o.fornecedor && complemento) pendencias.push("fornecedor informado pelo complemento (não consta na Central)");
    if (!o.fornecedor && !complemento && fornAusente) pendencias.push("fornecedor não informado na Central: identificar");
    // validação por competência: datas atípicas viram AVISO (não bloqueiam; ficam no relatório)
    if (o.competencia && o.vencimento && Math.abs(diasEntre(`${o.competencia}-01`, o.vencimento)) > 120) pendencias.push(`vencimento ${o.vencimento} distante da competência ${o.competencia}`);
    if (!cat) motivos.push(`categoria sem de-para aprovado: "${o.categoria}"`);
    else if (!["DESPESA", "CUSTO", "TRIBUTACAO", "TRIBUTAÇÃO", "FINANCIAMENTOS"].includes(sa(cat.tipo))) motivos.push(`categoria do sistema não é de saída: "${cat.nome}" (${cat.tipo})`);
    if (!o.competencia) motivos.push("sem competência");
    if (!o.vencimento) motivos.push("sem vencimento");
    if (!(o.valorPrevistoCentavos > 0)) motivos.push("valor previsto inválido");
    if (o.competencia && fechados.has(o.competencia)) motivos.push(`competência ${o.competencia} FECHADA no sistema`);
    const reg = { id: o.id, chave: chaveObrigacao(o.id), referencia: `Central 03_BD_OBRIGACOES linha ${o.linha} (ID ${o.id})`, fornecedor,
      descricao: o.descricao || o.fornecedor, categoriaCentral: o.categoria, categoriaSistema: cat?.nome ?? null, categoriaId: cat?.id ?? null,
      competencia: o.competencia, vencimento: o.vencimento, valorCentavos: o.valorPrevistoCentavos,
      informado: { jurosCentavos: o.jurosCentavos, multaCentavos: o.multaCentavos, descontoCentavos: o.descontoCentavos, valorPagoCentavos: o.valorPagoCentavos, status: o.status } };
    reg.impressao = impressaoObrigacao(reg);
    const ex = obrExist.get(reg.chave);
    reg.situacao = motivos.length ? "bloqueada" : !ex ? "nova" : ex.impressao === reg.impressao ? "existente" : "divergente";
    reg.motivos = motivos; reg.pendencias = pendencias; reg.idSistema = ex?.id ?? null;
    obrigacoes.push(reg);
  }
  const obrPorId = new Map(obrigacoes.map((o) => [o.id, o]));

  // ---------- pagamentos ----------
  const pagamentos = [], pagExcluidos = [];
  for (const p of central.pagamentos) {
    const obr = obrPorId.get(p.obrigacaoId);
    if (!obr) { pagExcluidos.push({ id: p.id, obrigacaoId: p.obrigacaoId, motivo: excluidas.some((e) => e.id === p.obrigacaoId) ? "obrigação fora de contas a pagar" : "obrigação inexistente na Central" }); continue; }
    if (p.cancelado) { pagExcluidos.push({ id: p.id, obrigacaoId: p.obrigacaoId, motivo: "cancelado na Central" }); continue; }
    const conta = resolverConta(p.conta);
    const motivos = [];
    if (obr.situacao === "bloqueada") motivos.push("obrigação bloqueada");
    if (!conta) motivos.push(`conta sem de-para aprovado: "${p.conta}"`);
    if (!p.data) motivos.push("sem data");
    if (!(p.valorCentavos > 0)) motivos.push("valor inválido");
    if (p.data && fechados.has(p.data.slice(0, 7))) motivos.push(`mês ${p.data.slice(0, 7)} FECHADO no sistema`);
    const reg = { id: p.id, chave: chavePagamento(p.id), referencia: `Central 03_BD_PAGAMENTOS linha ${p.linha} (ID ${p.id})`, obrigacaoId: p.obrigacaoId, obrigacaoChave: obr.chave,
      contaCentral: p.conta, contaSistema: conta?.nome ?? null, contaId: conta?.id ?? null, data: p.data, valorCentavos: p.valorCentavos,
      idMovimento: p.idMovimento || null, situacaoVinculoCentral: p.situacaoVinculo };
    reg.impressao = impressaoPagamento(reg);
    const ex = pagExist.get(reg.chave);
    reg.situacao = motivos.length ? "bloqueado" : !ex ? "novo" : ex.impressao === reg.impressao ? "existente" : "divergente";
    reg.motivos = motivos; reg.idSistema = ex?.id ?? null;
    pagamentos.push(reg);
  }

  // ---------- localizar o lançamento do sistema de cada pagamento (movimento → linha do fluxo → lançamento) ----------
  const movPorId = new Map(central.movimentos.map((m) => [m.id, m]));
  const fxPorId = new Map(central.fluxo.map((f) => [f.id, f]));
  // lançamentos de SAÍDA candidatos, por (conta, data, valor, descrição); ocorrências idênticas são intercambiáveis → atribuição em ordem
  const assin = (conta, data, valor, desc) => `${sa(conta)}|${data}|${valor}|${sa(desc)}`;
  const filas = new Map();
  for (const l of sistema.lancamentos) {
    if (l.sentido !== "saida" || l.status !== "realizado" || l.transferencia) continue;   // perna de transferência interna nunca é pagamento
    const k = assin(l.conta, l.data, l.valorCentavos, l.descricao); (filas.get(k) ?? filas.set(k, []).get(k)).push(l);
  }
  for (const f of filas.values()) f.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fxParaLanc = new Map();   // FX id → lançamento (1:1)
  const fxOrdenado = [...central.fluxo].sort((a, b) => a.id.localeCompare(b.id));
  const usados = new Map();
  for (const f of fxOrdenado) {
    if (!(f.saidaCentavos > 0)) continue;
    const conta = resolverConta(f.conta); if (!conta) continue;
    const k = assin(conta.nome, f.data, f.saidaCentavos, f.descricao);
    const fila = filas.get(k); if (!fila) continue;
    const n = usados.get(k) ?? 0; if (n >= fila.length) continue;
    fxParaLanc.set(f.id, fila[n]); usados.set(k, n + 1);
  }

  const grupos = new Map(), semVinculo = [];
  for (const p of pagamentos) {
    if (p.situacao === "bloqueado") continue;
    if (vincExist.has(p.chave)) continue;    // já vinculado no sistema: idempotente
    const mov = p.idMovimento ? movPorId.get(p.idMovimento) : null;
    const fx = mov?.refFluxo ? fxPorId.get(mov.refFluxo) : null;
    const lanc = fx ? fxParaLanc.get(fx.id) : null;
    if (!lanc) {
      semVinculo.push({ pagamento: p.id, motivo: !p.idMovimento ? `sem movimento na Central (${p.situacaoVinculoCentral || "a conciliar"})` : !mov ? "movimento inexistente na Central" : !fx ? "movimento sem referência ao Fluxo" : "linha do Fluxo sem lançamento correspondente único no sistema" });
      continue;
    }
    if (sa(lanc.conta) !== sa(p.contaSistema)) { semVinculo.push({ pagamento: p.id, motivo: `conta do pagamento (${p.contaSistema}) ≠ conta da saída (${lanc.conta})` }); continue; }
    (grupos.get(lanc.id) ?? grupos.set(lanc.id, { lancamento: lanc, pagamentos: [] }).get(lanc.id)).pagamentos.push(p);
  }
  const vinculos = [];
  for (const { lancamento: l, pagamentos: ps } of grupos.values()) {
    const soma = ps.reduce((s, p) => s + p.valorCentavos, 0);
    const dif = l.valorCentavos - soma;
    if (dif < -TOLERANCIA_CENTAVOS) { for (const p of ps) semVinculo.push({ pagamento: p.id, motivo: `soma dos pagamentos excede a saída do extrato em ${-dif} centavos (teto da conciliação)` }); continue; }
    const dias = Math.max(...ps.map((p) => Math.abs(diasEntre(l.data, p.data))));
    vinculos.push({ lancamentoId: l.id, pagamentos: ps.map((p) => p.chave), somaCentavos: soma, diferencaCentavos: dif, diasDiferenca: dias,
      status: Math.abs(dif) <= TOLERANCIA_CENTAVOS && dias <= 1 ? "sugerido" : "divergente",
      regra: ps.length > 1 ? "agrupado" : dias > 0 ? "data_proxima" : "exato" });
  }

  // ---------- acréscimo/desconto PRESUMIDO (sem classificar) ----------
  const pagosPorObr = new Map();
  for (const p of pagamentos) if (p.situacao !== "bloqueado") pagosPorObr.set(p.obrigacaoChave, (pagosPorObr.get(p.obrigacaoChave) ?? 0) + p.valorCentavos);
  for (const o of obrigacoes) {
    const pago = pagosPorObr.get(o.chave) ?? 0;
    o.pagoCentavos = pago; o.saldoCentavos = Math.max(0, o.valorCentavos - pago);
    o.diferencaPresumidaCentavos = pago > o.valorCentavos ? pago - o.valorCentavos : 0;     // acréscimo presumido (juros/multa/tarifa): contadora classifica
    o.situacaoPagamento = pago === 0 ? "aberta" : pago >= o.valorCentavos ? "paga (aguarda quitação humana)" : "parcial";
    const inf = o.informado.jurosCentavos + o.informado.multaCentavos - o.informado.descontoCentavos;
    o.divergenciaAcrescimoCentral = o.diferencaPresumidaCentavos - Math.max(0, inf);
  }

  // ---------- saldos de abertura INFORMADOS (só os que a Central traz como informados; nunca os calculados) ----------
  const abert = new Map((sistema.aberturas ?? []).map((a) => [`${sa(a.conta)}|${a.data}`, a]));
  const saldos = [];
  for (const s of central.saldos ?? []) {
    if (s.inicialInformadoCentavos == null) continue;
    const conta = resolverConta(s.conta);
    const reg = { conta: s.conta, contaSistema: conta?.nome ?? null, contaId: conta?.id ?? null, data: s.data, valorCentavos: s.inicialInformadoCentavos, fonte: s.fonte };
    const ex = conta ? abert.get(`${sa(conta.nome)}|${s.data}`) : null;
    reg.motivos = [!conta && `conta sem de-para aprovado: "${s.conta}"`, !s.data && "sem data", s.data && fechados.has(s.data.slice(0, 7)) && `mês ${s.data.slice(0, 7)} FECHADO`].filter(Boolean);
    reg.situacao = reg.motivos.length ? "bloqueado" : !ex ? "novo" : Number(ex.valorCentavos) === reg.valorCentavos ? "existente" : "divergente";
    saldos.push(reg);
  }
  // ---------- validação por competência ----------
  const porCompetencia = {};
  for (const o of obrigacoes) { const m = o.competencia ?? "sem competência"; const x = (porCompetencia[m] ??= { obrigacoes: 0, valorOriginalCentavos: 0, bloqueadas: 0 }); x.obrigacoes++; x.valorOriginalCentavos += o.valorCentavos; if (o.situacao === "bloqueada") x.bloqueadas++; }
  const pagamentosAntesDaCompetencia = pagamentos.filter((p) => { const o = obrPorId.get(p.obrigacaoId); return o?.competencia && p.data && diasEntre(`${o.competencia}-01`, p.data) > 62; }).map((p) => p.id);
  // rateios: o sistema ainda não tem onde guardá-los → relatados, nunca descartados em silêncio
  const rateiosNaoImportados = (central.rateios ?? []).map((r) => ({ obrigacao: r.obrigacaoId, competencia: r.competencia, valorCentavos: r.valorCentavos, criterio: r.criterio, motivo: "sistema sem tabela de rateios (DRE de referência os recebe como parâmetro)" }));
  const novosFornecedores = [...new Set(obrigacoes.filter((o) => o.situacao === "nova").map((o) => o.fornecedor))].filter((f) => !fornExist.has(sa(f)));
  const cont = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = (m[x[k]] ?? 0) + 1), m), {});
  return {
    obrigacoes, pagamentos, vinculos, semVinculo, saldos, porCompetencia, pagamentosAntesDaCompetencia, rateiosNaoImportados, excluidas, pagamentosExcluidos: pagExcluidos, novosFornecedores,
    resumo: {
      obrigacoes: cont(obrigacoes, "situacao"), pagamentos: cont(pagamentos, "situacao"), saldosAbertura: cont(saldos, "situacao"),
      vinculos: cont(vinculos, "status"), pagamentosSemVinculo: semVinculo.length,
      excluidas: excluidas.length, pagamentosExcluidos: pagExcluidos.length, novosFornecedores: novosFornecedores.length, rateiosNaoImportados: rateiosNaoImportados.length,
      obrigacoesComPendencia: obrigacoes.filter((o) => o.pendencias.length).length,
      valorOriginalNovoCentavos: obrigacoes.filter((o) => o.situacao === "nova").reduce((s, o) => s + o.valorCentavos, 0),
      valorPagoNovoCentavos: pagamentos.filter((p) => p.situacao === "novo").reduce((s, p) => s + p.valorCentavos, 0),
      acrescimoPresumidoCentavos: obrigacoes.reduce((s, o) => s + o.diferencaPresumidaCentavos, 0),
      bloqueiaGravacao: obrigacoes.some((o) => o.situacao === "divergente") || pagamentos.some((p) => p.situacao === "divergente") || saldos.some((s) => s.situacao === "divergente"),
    },
  };
}
