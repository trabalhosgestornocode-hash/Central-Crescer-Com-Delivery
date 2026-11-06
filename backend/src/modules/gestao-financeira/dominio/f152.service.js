// Financeiro 2.0 (migration 152): rateios por competência, contas a receber e dívidas/empréstimos.
// Este serviço valida a entrada e monta as visões; a autoridade final é o banco (somas, tetos, trava de mês, escopo).
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, enumerado, data, valorPositivo, valorOuNulo, mesAno, inteiro, bad } from "./validacao.js";

const padrao = { repo: repositorio, db: undefined, hoje: () => new Date().toISOString().slice(0, 10) };
const motivo = (v) => { const m = texto(v, "motivo", { max: 1000 }); if (m.length < 5) throw bad("Informe o motivo (mínimo de 5 caracteres).", "MOTIVO_OBRIGATORIO"); return m; };
const soma = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

// ===================== RATEIOS =====================
export const CRITERIOS_RATEIO = ["dias_consumo", "producao", "outro"];

export async function listarRateios(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const [rats, parc, obrs, forn, cats] = await Promise.all([deps.repo.listarRateios(c, deps.db), deps.repo.listarParcelasRateio(c, deps.db), deps.repo.listarObrigacoes(c, deps.db),
    deps.repo.listarFornecedores(c, deps.db), deps.repo.listarPlanoContas(c, deps.db)]);
  const fn = new Map(forn.map((f) => [f.id, f.nome])), cn = new Map(cats.map((x) => [x.id, x.nome]));
  const porRat = new Map(); for (const p of parc) (porRat.get(p.rateio_id) ?? porRat.set(p.rateio_id, []).get(p.rateio_id)).push({ competencia: String(p.competencia).slice(0, 7), valorCentavos: Number(p.valor_centavos) });
  const obrPorId = new Map(obrs.map((o) => [o.id, o]));
  const itens = rats.filter((r) => q?.todos === "true" || r.status !== "cancelado").map((r) => {
    const o = obrPorId.get(r.obrigacao_id);
    return { id: r.id, obrigacaoId: r.obrigacao_id, obrigacao: o ? { descricao: o.descricao, fornecedor: fn.get(o.fornecedor_id) ?? null, categoria: cn.get(o.categoria_id) ?? null, competencia: String(o.competencia).slice(0, 7), valorOriginalCentavos: Number(o.valor_original_centavos) } : null,
      valorElegivelCentavos: Number(r.valor_elegivel_centavos), competenciaOrigem: String(r.competencia_origem).slice(0, 7), criterio: r.criterio, justificativa: r.justificativa, origemDocumental: r.origem_documental,
      status: r.status, aprovadoPor: r.aprovado_por, aprovadoEm: r.aprovado_em, motivoCancelamento: r.motivo_cancelamento, origem: r.origem, parcelas: porRat.get(r.id) ?? [] };
  });
  const mes = q?.mes ? mesAno(q.mes) : null;
  const filtrados = mes ? itens.filter((i) => i.parcelas.some((p) => p.competencia === mes) || i.competenciaOrigem === mes) : itens;
  const comRateio = new Set(itens.filter((i) => i.status !== "cancelado").map((i) => i.obrigacaoId));
  const elegiveis = obrs.filter((o) => o.status !== "cancelada" && !comRateio.has(o.id)).map((o) => ({ id: o.id, descricao: o.descricao, fornecedor: fn.get(o.fornecedor_id) ?? null, categoria: cn.get(o.categoria_id) ?? null, competencia: String(o.competencia).slice(0, 7), valorOriginalCentavos: Number(o.valor_original_centavos) }));
  return { mes, itens: filtrados, obrigacoesSemRateio: elegiveis, resumo: { propostos: itens.filter((i) => i.status === "proposto").length, aprovados: itens.filter((i) => i.status === "aprovado").length } };
}

export async function definirRateio(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const parcelas = Array.isArray(b?.parcelas) ? b.parcelas : null;
  if (!parcelas?.length) throw bad("Informe ao menos uma competência de destino.", "RATEIO_SEM_PARCELAS");
  const ps = parcelas.map((p, i) => ({ competencia: `${mesAno(p?.competencia, `parcelas[${i}].competencia`)}-01`, valorCentavos: valorPositivo(p?.valor, `parcelas[${i}].valor`) }));
  const elegivel = valorPositivo(b?.valorElegivel, "valorElegivel");
  if (soma(ps, (p) => p.valorCentavos) !== elegivel) throw bad("A soma das competências deve ser igual ao valor elegível.", "RATEIO_SOMA_DIVERGENTE");
  const id = await deps.repo.definirRateioRpc(c, { obrigacaoId: uuid(b?.obrigacaoId, "obrigacaoId"), valorElegivelCentavos: elegivel, criterio: enumerado(b?.criterio, "criterio", CRITERIOS_RATEIO),
    justificativa: texto(b?.justificativa, "justificativa", { max: 1000 }), origemDocumental: texto(b?.origemDocumental, "origemDocumental", { max: 300, obrigatorio: false }), parcelas: ps }, deps.db);
  return { id };
}
export const aprovarRateio = async (ctx, id, deps = padrao) => { await deps.repo.aprovarRateioRpc(exigirContexto(ctx), uuid(id, "id"), deps.db); return { id, status: "aprovado" }; };
export const cancelarRateio = async (ctx, id, b, deps = padrao) => { await deps.repo.cancelarRateioRpc(exigirContexto(ctx), uuid(id, "id"), motivo(b?.motivo), deps.db); return { id, status: "cancelado" }; };

/** Rateios ativos (proposto/aprovado) no formato do motor do DRE de referência. */
export async function rateiosParaDre(c, deps = padrao) {
  const [rats, parc] = await Promise.all([deps.repo.listarRateios(c, deps.db), deps.repo.listarParcelasRateio(c, deps.db)]);
  const ativos = new Map(rats.filter((r) => r.status !== "cancelado").map((r) => [r.id, r]));
  return parc.filter((p) => ativos.has(p.rateio_id)).map((p) => { const r = ativos.get(p.rateio_id); return { obrigacaoChave: r.obrigacao_id, competencia: String(p.competencia).slice(0, 7), valorCentavos: Number(p.valor_centavos), criterio: r.criterio, status: r.status }; });
}

// ===================== CONTAS A RECEBER =====================
export const ORIGENS_RECEBIVEL = ["venda", "repasse", "reembolso", "emprestimo_concedido", "outro"];

export async function listarRecebiveis(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const hoje = (deps.hoje ?? padrao.hoje)();
  const [recs, rcbs, contas] = await Promise.all([deps.repo.listarRecebiveis(c, deps.db), deps.repo.listarRecebimentos(c, deps.db), deps.repo.listarContas(c, deps.db)]);
  const cn = new Map(contas.map((x) => [x.id, x.nome]));
  const porRec = new Map(); for (const r of rcbs) (porRec.get(r.recebivel_id) ?? porRec.set(r.recebivel_id, []).get(r.recebivel_id)).push(r);
  const mes = q?.mes ? mesAno(q.mes) : null;
  const itens = recs.filter((r) => !mes || String(r.competencia).startsWith(mes) || (r.status === "aberto")).map((r) => {
    const ativos = (porRec.get(r.id) ?? []).filter((x) => x.status === "ativo");
    const recebido = soma(ativos, (x) => Number(x.valor_centavos)), original = Number(r.valor_original_centavos), pendente = Math.max(0, original - recebido);
    const situacao = r.status === "cancelado" ? "cancelado" : pendente === 0 ? "recebido" : recebido > 0 ? "parcial" : r.previsao && r.previsao < hoje ? "atrasado" : "a_receber";
    return { id: r.id, origem: r.origem, contraparte: r.contraparte, descricao: r.descricao, competencia: String(r.competencia).slice(0, 7), valorOriginalCentavos: original, recebidoCentavos: recebido, pendenteCentavos: r.status === "cancelado" ? 0 : pendente,
      previsao: r.previsao, contaId: r.conta_id, conta: cn.get(r.conta_id) ?? null, status: r.status, situacao, origemRegistro: r.origem_registro, observacoes: r.observacoes,
      recebimentos: (porRec.get(r.id) ?? []).map((x) => ({ id: x.id, data: x.data, valorCentavos: Number(x.valor_centavos), conta: cn.get(x.conta_id) ?? null, lancamentoId: x.lancamento_id, conciliado: Boolean(x.lancamento_id), status: x.status })) };
  });
  const abertos = itens.filter((i) => i.status !== "cancelado");
  return { mes, itens, resumo: { pendenteCentavos: soma(abertos, (i) => i.pendenteCentavos), recebidoCentavos: soma(abertos, (i) => i.recebidoCentavos), atrasados: abertos.filter((i) => i.situacao === "atrasado").length, quantidade: abertos.length } };
}
export async function criarRecebivel(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return deps.repo.inserirRecebivel(c, { origem: enumerado(b?.origem, "origem", ORIGENS_RECEBIVEL), contraparte: texto(b?.contraparte, "contraparte", { max: 120 }), descricao: texto(b?.descricao, "descricao", { obrigatorio: false }),
    competencia: `${mesAno(b?.competencia, "competencia")}-01`, valor_original_centavos: valorPositivo(b?.valor), previsao: data(b?.previsao, "previsao", { obrigatorio: false }),
    conta_id: uuid(b?.contaId, "contaId", { obrigatorio: false }), observacoes: texto(b?.observacoes, "observacoes", { max: 1000, obrigatorio: false }) }, deps.db);
}
export async function registrarRecebimento(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return deps.repo.inserirRecebimento(c, { recebivel_id: uuid(id, "id"), data: data(b?.data), valor_centavos: valorPositivo(b?.valor), conta_id: uuid(b?.contaId, "contaId"),
    lancamento_id: uuid(b?.lancamentoId, "lancamentoId", { obrigatorio: false }), observacao: texto(b?.observacao, "observacao", { max: 1000, obrigatorio: false }) }, deps.db);
}
export async function cancelarRecebivel(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return deps.repo.atualizarRecebivel(c, uuid(id, "id"), { status: "cancelado", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: new Date().toISOString() }, deps.db);
}
export async function cancelarRecebimento(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return deps.repo.atualizarRecebimento(c, uuid(id, "id"), { status: "cancelado", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: new Date().toISOString() }, deps.db);
}

// ===================== DÍVIDAS E EMPRÉSTIMOS =====================
export const NATUREZAS_DIVIDA = ["propria", "socio", "entre_empresas", "terceiros", "tributaria"];
export const TIPOS_EVENTO = ["captacao", "amortizacao", "juros", "encargo", "retencao", "reembolso", "envio", "recebimento", "outro"];
const ROTULO_NATUREZA = { propria: "Dívida própria", socio: "Empréstimo de sócio", entre_empresas: "Entre empresas", terceiros: "Obrigação de terceiros", tributaria: "Parcelamento tributário" };

export async function listarDividas(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const [divs, evs] = await Promise.all([deps.repo.listarDividas(c, deps.db), deps.repo.listarEventosDivida(c, deps.db)]);
  const porDiv = new Map(); for (const e of evs) (porDiv.get(e.divida_id) ?? porDiv.set(e.divida_id, []).get(e.divida_id)).push(e);
  const mes = q?.mes ? mesAno(q.mes) : null;
  const itens = divs.map((d) => {
    const ativos = (porDiv.get(d.id) ?? []).filter((e) => e.status === "ativo");
    const t = (tipo, campo) => soma(ativos.filter((e) => e.tipo === tipo), (e) => Number(e[campo]));
    const captado = t("captacao", "principal_centavos"), amortizado = t("amortizacao", "principal_centavos");
    const original = d.valor_original_centavos == null ? null : Number(d.valor_original_centavos);
    const saldoCalculado = original == null ? null : original + captado - amortizado;
    const doMes = mes ? ativos.filter((e) => String(e.data).startsWith(mes)) : ativos;
    return { id: d.id, natureza: d.natureza, naturezaRotulo: ROTULO_NATUREZA[d.natureza], credor: d.credor, descricao: d.descricao, valorOriginalCentavos: original, dataContratacao: d.data_contratacao,
      parcelasTotal: d.parcelas_total, valorParcelaCentavos: d.valor_parcela_centavos == null ? null : Number(d.valor_parcela_centavos), parcelasPagasAntes: d.parcelas_pagas_antes,
      parcelasPagas: (d.parcelas_pagas_antes ?? 0) + ativos.filter((e) => e.tipo === "amortizacao").length,
      saldoInformadoCentavos: d.saldo_informado_centavos == null ? null : Number(d.saldo_informado_centavos), saldoInformadoEm: d.saldo_informado_em, saldoCalculadoCentavos: saldoCalculado,
      documentada: d.documentada, pendenciaDocumental: d.pendencia_documental, entraPeFinanceiro: d.entra_pe_financeiro, status: d.status, origem: d.origem, observacoes: d.observacoes,
      noMes: { principalCentavos: soma(doMes.filter((e) => e.tipo === "amortizacao"), (e) => Number(e.principal_centavos)), jurosCentavos: soma(doMes, (e) => Number(e.juros_centavos)), encargosCentavos: soma(doMes, (e) => Number(e.encargos_centavos)) },
      eventos: (porDiv.get(d.id) ?? []).map((e) => ({ id: e.id, data: e.data, tipo: e.tipo, principalCentavos: Number(e.principal_centavos), jurosCentavos: Number(e.juros_centavos), encargosCentavos: Number(e.encargos_centavos), parcela: e.parcela_numero, status: e.status, observacao: e.observacao })) };
  });
  const ativas = itens.filter((i) => i.status === "ativa");
  // parcelas do PE financeiro = principal + juros das dívidas marcadas. ENCARGOS ficam fora: já entram nas despesas fixas (contá-los aqui duplicaria)
  const peMes = itens.filter((i) => i.entraPeFinanceiro).reduce((s, i) => s + i.noMes.principalCentavos + i.noMes.jurosCentavos, 0);
  return { mes, itens, resumo: { porNatureza: Object.fromEntries(NATUREZAS_DIVIDA.map((n) => [n, ativas.filter((i) => i.natureza === n).length])), semDocumentacao: ativas.filter((i) => !i.documentada).length,
    saldoInformadoCentavos: soma(ativas.filter((i) => i.saldoInformadoCentavos != null), (i) => i.saldoInformadoCentavos), saldoDesconhecido: ativas.filter((i) => i.saldoInformadoCentavos == null && i.saldoCalculadoCentavos == null).length,
    parcelasPeFinanceiroNoMesCentavos: mes ? peMes : null } };
}
export async function criarDivida(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const saldo = valorOuNulo(b?.saldoInformado, "saldoInformado");
  return deps.repo.inserirDivida(c, { natureza: enumerado(b?.natureza, "natureza", NATUREZAS_DIVIDA), credor: texto(b?.credor, "credor", { max: 120 }), descricao: texto(b?.descricao, "descricao", { obrigatorio: false }),
    valor_original_centavos: valorOuNulo(b?.valorOriginal, "valorOriginal"), data_contratacao: data(b?.dataContratacao, "dataContratacao", { obrigatorio: false }),
    parcelas_total: b?.parcelasTotal ? inteiro(b.parcelasTotal, "parcelasTotal", { min: 1, max: 1000 }) : null, valor_parcela_centavos: valorOuNulo(b?.valorParcela, "valorParcela"),
    parcelas_pagas_antes: b?.parcelasPagasAntes ? inteiro(b.parcelasPagasAntes, "parcelasPagasAntes") : null,
    saldo_informado_centavos: saldo, saldo_informado_em: saldo == null ? null : data(b?.saldoInformadoEm, "saldoInformadoEm"),
    documentada: b?.documentada === true, pendencia_documental: texto(b?.pendenciaDocumental, "pendenciaDocumental", { max: 500, obrigatorio: false }), entra_pe_financeiro: b?.entraPeFinanceiro === true,
    observacoes: texto(b?.observacoes, "observacoes", { max: 1000, obrigatorio: false }) }, deps.db);
}
export async function registrarEventoDivida(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const ev = { principal_centavos: valorOuNulo(b?.principal, "principal") ?? 0, juros_centavos: valorOuNulo(b?.juros, "juros") ?? 0, encargos_centavos: valorOuNulo(b?.encargos, "encargos") ?? 0 };
  if (ev.principal_centavos < 0 || ev.juros_centavos < 0 || ev.encargos_centavos < 0 || ev.principal_centavos + ev.juros_centavos + ev.encargos_centavos <= 0) throw bad("Informe principal, juros ou encargos (valores positivos).", "EVENTO_SEM_VALOR");
  return deps.repo.inserirEventoDivida(c, { divida_id: uuid(id, "id"), data: data(b?.data), tipo: enumerado(b?.tipo, "tipo", TIPOS_EVENTO), ...ev,
    parcela_numero: b?.parcela ? inteiro(b.parcela, "parcela", { min: 1, max: 1000 }) : null, pagamento_id: uuid(b?.pagamentoId, "pagamentoId", { obrigatorio: false }),
    lancamento_id: uuid(b?.lancamentoId, "lancamentoId", { obrigatorio: false }), observacao: texto(b?.observacao, "observacao", { max: 1000, obrigatorio: false }) }, deps.db);
}
export async function cancelarEventoDivida(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return deps.repo.atualizarEventoDivida(c, uuid(id, "id"), { status: "cancelado", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: new Date().toISOString() }, deps.db);
}
export async function atualizarSaldoDivida(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const saldo = valorOuNulo(b?.saldoInformado, "saldoInformado");
  return deps.repo.atualizarDivida(c, uuid(id, "id"), { saldo_informado_centavos: saldo, saldo_informado_em: saldo == null ? null : data(b?.saldoInformadoEm, "saldoInformadoEm"),
    documentada: b?.documentada === true, pendencia_documental: texto(b?.pendenciaDocumental, "pendenciaDocumental", { max: 500, obrigatorio: false }),
    ...(b?.status ? { status: enumerado(b.status, "status", ["ativa", "quitada", "cancelada"]) } : {}) }, deps.db);
}
