// Núcleo PURO da importação dos complementos da Central (migration 152): rateios, dívidas/eventos, recebíveis e
// pernas de transferência que faltam no caixa. Não lê arquivo nem banco. Mesmas garantias do importador principal:
// chave de origem, existente/novo (nunca sobrescreve), de-para explícito, nada adivinhado, registros fora de escopo relatados.
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

export const NATUREZA_POR_TIPO = [[/DIVIDA PROPRIA/, "propria"], [/EMPRESTIMO DE SOCIO/, "socio"], [/EMPRESTIMO DE TERCEIRO/, "terceiros"], [/ENTRE EMPRESAS/, "entre_empresas"],
  [/PARCELAMENTO TRIBUT/, "tributaria"], [/RETENCAO DE OBRIGACAO DE TERCEIROS/, "terceiros"]];
const TIPO_EVENTO = { AMORTIZACAO: "amortizacao", ENCARGOS: "encargo", CAPTACAO: "captacao", REEMBOLSO: "reembolso", RETENCAO: "retencao", ENVIO: "envio", RECEBIMENTO: "recebimento",
  "REPASSE (ENTRADA)": "recebimento", "REPASSE (SAIDA)": "envio" };
const CRITERIO_RATEIO = { "DIAS DE CONSUMO": "dias_consumo", PRODUCAO: "producao" };

/**
 * @param central { rateios, dividas, eventosDivida, recebiveis, movimentos }
 * @param sistema { obrigacoesPorChave: Map(chave→{id,valorCentavos}), rateiosChaves:Set, dividasChaves:Set, eventosChaves:Set, recebiveisChaves:Set,
 *                  lancamentosChaves:Set, contas:[{id,nome}], categoriaTransferenciaId, entradasSemPar:[{id,conta,data,valorCentavos}] }
 * @param dePara  { contas: {nomeCentral: nomeSistema}, mesmoFato: [{ recebivel: "<ID CR>", divida: "<ID DV>" }] }
 *                 mesmoFato = decisão EXPLÍCITA: a dívida e o recebível representam o mesmo valor → importa como recebível (não duplica)
 */
export function planejarComplementos({ central, sistema, dePara }) {
  const contaPorNome = new Map(sistema.contas.map((c) => [sa(c.nome), c]));
  const dpConta = new Map(Object.entries(dePara.contas ?? {}).map(([k, v]) => [sa(k), v]));
  const conta = (nome) => { const alvo = dpConta.get(sa(nome)); return alvo == null ? null : contaPorNome.get(sa(alvo)) ?? null; };
  const fora = [];

  // ---- rateios: um por obrigação; Σ linhas = valor elegível ----
  const porObr = new Map();
  for (const r of central.rateios ?? []) (porObr.get(r.obrigacaoId) ?? porObr.set(r.obrigacaoId, []).get(r.obrigacaoId)).push(r);
  const rateios = [];
  for (const [obrId, rs] of porObr) {
    const chave = `central:RAT:${obrId}`;
    const obr = sistema.obrigacoesPorChave.get(`central:CP:${obrId}`);
    const criterios = [...new Set(rs.map((r) => CRITERIO_RATEIO[sa(r.criterio)] ?? "outro"))];
    const parcelas = rs.map((r) => ({ competencia: `${r.competencia}-01`, valorCentavos: r.valorCentavos }));
    const elegivel = parcelas.reduce((s, p) => s + p.valorCentavos, 0);
    const motivos = [!obr && "obrigação não importada (bloqueada ou fora de contas a pagar)", obr && elegivel > obr.valorCentavos && `Σ rateio (${elegivel}) acima do valor original (${obr.valorCentavos})`,
      new Set(parcelas.map((p) => p.competencia)).size !== parcelas.length && "competência repetida"].filter(Boolean);
    rateios.push({ chave, obrigacaoCentral: obrId, obrigacaoId: obr?.id ?? null, valorElegivelCentavos: elegivel, criterio: criterios.length === 1 ? criterios[0] : "outro", parcelas,
      justificativa: `Rateio da Central (${rs.map((r) => r.id).join(", ")}): ${[...new Set(rs.map((r) => r.criterio))].join("/")}. Referência PROVISÓRIA, pendente de aprovação da contadora.`,
      origemDocumental: `Central 03_BD_RATEIOS ${rs.map((r) => r.id).join(", ")}`,
      situacao: motivos.length ? "bloqueado" : sistema.rateiosChaves.has(chave) ? "existente" : "novo", motivos });
  }

  // ---- recebíveis: só os que representam valor a receber de fato (consolidados de vendas não viram recebível) ----
  const recebiveis = [];
  for (const r of central.recebiveis ?? []) {
    const chave = `central:CR:${r.id}`;
    if (/CONSOLIDADO/.test(sa(r.tipo))) { fora.push({ id: r.id, motivo: "controle consolidado de vendas × recebimentos: já coberto pela Conciliação de vendas (importar duplicaria faturamento/recebimentos)" }); continue; }
    const c = conta(r.contaDestino);
    const motivos = [!(r.valorPrevistoCentavos > 0) && "sem valor previsto", !r.competencia && "sem competência"].filter(Boolean);
    recebiveis.push({ chave, id: r.id, origem: /REEMBOLSO/.test(sa(r.origem)) ? "reembolso" : /REPASSE/.test(sa(r.origem)) ? "repasse" : "outro", contraparte: r.canal || "—", descricao: r.origem.slice(0, 300),
      competencia: `${r.competencia}-01`, valorOriginalCentavos: r.valorPrevistoCentavos, previsao: r.previsao, contaId: c?.id ?? null, recebidoCentralCentavos: r.valorRecebidoCentavos, statusCentral: r.status,
      situacao: motivos.length ? "bloqueado" : sistema.recebiveisChaves.has(chave) ? "existente" : "novo", motivos });
  }
  const mesmoFato = new Map((dePara.mesmoFato ?? []).map((v) => [v.recebivel, v.divida]));
  const dividaComoRecebivel = new Set(recebiveis.filter((r) => mesmoFato.has(r.id)).map((r) => mesmoFato.get(r.id)));
  // recebimentos do recebível = reembolsos registrados nos eventos da dívida declarada como o MESMO FATO (mesma origem documental)
  const movPorId = new Map((central.movimentos ?? []).map((m) => [m.id, m]));
  const usadasEntrada = new Set();
  for (const r of recebiveis.filter((x) => mesmoFato.has(x.id))) {
    const ret = (central.dividas ?? []).find((d) => d.id === mesmoFato.get(r.id));
    r.recebimentos = (central.eventosDivida ?? []).filter((e) => ret && e.dividaId === ret.id && sa(e.tipo) === "REEMBOLSO").map((e) => {
      const c = conta(movPorId.get(e.idMovimento)?.conta);
      const cand = (sistema.entradas ?? []).filter((l) => c && sa(l.conta) === sa(c.nome) && l.data === e.data && l.valorCentavos === Math.abs(e.valorCentavos) && !usadasEntrada.has(l.id));
      if (cand.length === 1) usadasEntrada.add(cand[0].id);
      return { chave: `central:RCB:${e.id}`, data: e.data, valorCentavos: Math.abs(e.valorCentavos), contaId: c?.id ?? null, lancamentoId: cand.length === 1 ? cand[0].id : null, origem: `${e.id} (${e.idMovimento})` };
    }).filter((x) => x.contaId);
    const tot = r.recebimentos.reduce((a, x) => a + x.valorCentavos, 0);
    if (r.recebidoCentralCentavos != null && tot !== r.recebidoCentralCentavos) r.motivos.push(`recebimentos (${tot}) ≠ recebido na Central (${r.recebidoCentralCentavos})`);
    if (r.motivos.length) r.situacao = "bloqueado";
  }

  // ---- dívidas e eventos ----
  const dividas = [], eventos = [];
  for (const d of central.dividas ?? []) {
    const chave = `central:DV:${d.id}`;
    const natureza = NATUREZA_POR_TIPO.find(([re]) => re.test(sa(d.tipo)))?.[1] ?? null;
    if (dividaComoRecebivel.has(d.id)) { fora.push({ id: d.id, motivo: "declarada como o MESMO FATO de um recebível: importada como conta a receber, não como dívida (não duplica)" }); continue; }
    const saldoNum = d.saldoCentavos != null;
    dividas.push({ chave, id: d.id, natureza, credor: d.credor || "—", descricao: d.tipo, valorOriginalCentavos: d.valorOriginalCentavos, dataContratacao: d.dataContratacao, parcelasTotal: d.parcelasTotal,
      valorParcelaCentavos: d.valorParcelaCentavos, parcelasPagasAntes: d.parcelasPagasAntes, entraPe: d.entraPe,
      saldoInformadoCentavos: saldoNum ? d.saldoCentavos : null, saldoInformadoEm: saldoNum ? "2026-09-30" : null,
      pendencia: [`Fonte: ${d.fonte || "—"}`, d.valorOriginalCentavos == null && "valor original não informado", !saldoNum && "saldo devedor não calculável (N/D)", saldoNum && "saldo calculado pela Central: confirmar com documento", /CONFIRMAR/.test(sa(d.tipo + d.situacao)) && "natureza/vínculo a confirmar"].filter(Boolean).join("; ").slice(0, 500),
      observacoes: `Situação na Central: ${d.situacao}. ${d.observacao}`.slice(0, 1000), situacao: !natureza ? "bloqueado" : sistema.dividasChaves.has(chave) ? "existente" : "novo", motivos: natureza ? [] : [`natureza não reconhecida: ${d.tipo}`] });
  }
  const dividasImportaveis = new Set(dividas.filter((d) => d.situacao !== "bloqueado").map((d) => d.id));
  for (const e of central.eventosDivida ?? []) {
    const chave = `central:DVE:${e.id}`;
    if (!dividasImportaveis.has(e.dividaId)) { fora.push({ id: e.id, motivo: `evento de dívida não importada (${e.dividaId})` }); continue; }
    const tipo = TIPO_EVENTO[sa(e.tipo)] ?? "outro";
    eventos.push({ chave, id: e.id, dividaChave: `central:DV:${e.dividaId}`, data: e.data, tipo,
      principalCentavos: tipo === "encargo" ? 0 : Math.abs(e.valorCentavos), jurosCentavos: 0, encargosCentavos: tipo === "encargo" ? Math.abs(e.valorCentavos) : 0,
      observacao: `${e.tipo} (Central ${e.id}${e.idMovimento ? `, ${e.idMovimento}` : ""}). ${tipo === "amortizacao" ? "Principal e juros NÃO separados na Central: valor integral em principal até a contadora informar. " : ""}${e.observacao}`.slice(0, 1000),
      situacao: !e.data || !(Math.abs(e.valorCentavos) > 0) ? "bloqueado" : sistema.eventosChaves.has(chave) ? "existente" : "novo" });
  }

  // ---- pernas de transferência que faltam (movimento da Conciliação sem linha no Fluxo, com a outra perna já no sistema) ----
  const pernas = [];
  const usadas = new Set();
  const movs = central.movimentos ?? [];
  for (const m of movs) {
    if (m.refFluxo || sa(m.categoria) !== "TRANSFERENCIA INTERNA" || !(m.saidaCentavos > 0)) continue;
    const chave = `central:MOV:${m.id}`;
    const origem = conta(m.conta);
    const par = movs.find((x) => x.id !== m.id && x.parTransferencia && x.parTransferencia === m.parTransferencia && x.entradaCentavos > 0);
    const destinoConta = par ? conta(par.conta) : null;
    const cand = destinoConta ? sistema.entradasSemPar.filter((l) => sa(l.conta) === sa(destinoConta.nome) && l.data === m.data && l.valorCentavos === m.saidaCentavos && !usadas.has(l.id)) : [];
    const motivos = [!origem && `conta sem de-para: ${m.conta}`, !par && `par ${m.parTransferencia || "—"} não encontrado na Central`, par && !destinoConta && `conta do par sem de-para: ${par.conta}`,
      destinoConta && cand.length !== 1 && `entrada correspondente na ${destinoConta.nome} ${cand.length ? "ambígua" : "não encontrada"} no sistema`, !sistema.categoriaTransferenciaId && "plano sem categoria de transferência"].filter(Boolean);
    if (cand.length === 1) usadas.add(cand[0].id);
    pernas.push({ chave, id: m.id, contaId: origem?.id ?? null, conta: origem?.nome ?? m.conta, data: m.data, valorCentavos: m.saidaCentavos, descricao: m.descricao.slice(0, 300), par: m.parTransferencia,
      entradaId: cand.length === 1 ? cand[0].id : null, situacao: sistema.lancamentosChaves.has(chave) ? "existente" : motivos.length ? "bloqueado" : "novo", motivos: sistema.lancamentosChaves.has(chave) ? [] : motivos });
  }

  const cont = (xs) => xs.reduce((m, x) => ((m[x.situacao] = (m[x.situacao] ?? 0) + 1), m), {});
  return { rateios, recebiveis, dividas, eventos, pernas, fora,
    resumo: { rateios: cont(rateios), recebiveis: cont(recebiveis), dividas: cont(dividas), eventos: cont(eventos), pernasCaixa: cont(pernas), foraDeEscopo: fora.length,
      valorPernasNovasCentavos: pernas.filter((p) => p.situacao === "novo").reduce((s, p) => s + p.valorCentavos, 0) } };
}
