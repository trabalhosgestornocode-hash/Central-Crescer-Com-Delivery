// Conciliação de SAÍDAS (Financeiro 2.0): pagamento registrado ⇄ saída do extrato (fin_lancamentos).
// Status: conciliado | sugerido | divergente (vínculos) e pendente (pagamento sem saída) | a_identificar (saída sem pagamento nem classificação).
// NUNCA concilia automaticamente: o motor só SUGERE (e só quando o par/grupo é único); confirmar é ação humana com `conciliar`.
// Tolerância de sugestão: R$ 0,01 e 1 dia (a mesma do banco). Fora dela, confirmar exige justificativa. Evidência gravada pelo banco.
import { randomUUID } from "node:crypto";
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, bad, mesAno } from "./validacao.js";
import { sugerirVinculos, diasEntre, dentroDaTolerancia, TOLERANCIA } from "../../../financeiro-calculos/contasPagar.js";
import { PAPEL } from "../../../financeiro-calculos/planoContas.js";
import { ApiError } from "../../../shared/ApiError.js";

const padrao = { repo: repositorio, db: undefined };
const ATIVOS = ["sugerido", "conciliado", "divergente"];
const ultimoDia = (ym) => { const [a, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const somaDias = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function carregar(c, mes, deps) {
  const de = `${mes}-01`, ate = ultimoDia(mes);
  // janela de ±1 dia (tolerância) para enxergar o par que cruza a virada do mês
  const [vincs, pags, obrs, forn, cats, contas, saidas] = await Promise.all([
    deps.repo.listarVinculosSaidas(c, deps.db), deps.repo.listarPagamentos(c, deps.db), deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarFornecedores(c, deps.db),
    deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarContas(c, deps.db), deps.repo.listarSaidasExtrato(c, { de: somaDias(de, -TOLERANCIA.dias), ate: somaDias(ate, TOLERANCIA.dias) }, deps.db),
  ]);
  const catPor = new Map(cats.map((x) => [x.id, x]));
  const obrPor = new Map(obrs.map((o) => [o.id, o]));
  const fornPor = new Map(forn.map((f) => [f.id, f.nome]));
  const contaPor = new Map(contas.map((x) => [x.id, x.nome]));
  const pagPor = new Map(pags.map((p) => [p.id, p]));
  const saidaPor = new Map(saidas.map((s) => [s.id, s]));
  const ativos = vincs.filter((v) => ATIVOS.includes(v.status));
  const alocPag = new Map(), alocSaida = new Map();
  for (const v of ativos) {
    alocPag.set(v.pagamento_id, (alocPag.get(v.pagamento_id) ?? 0) + Number(v.valor_alocado_centavos));
    alocSaida.set(v.lancamento_id, (alocSaida.get(v.lancamento_id) ?? 0) + Number(v.valor_alocado_centavos));
  }
  const ehTransf = (s) => catPor.get(s.categoria_id)?.papel === PAPEL.TRANSFERENCIA;
  return { de, ate, vincs, ativos, pags, pagPor, obrPor, fornPor, contaPor, saidas, saidaPor, alocPag, alocSaida, ehTransf, catPor };
}

const descPag = (b, p) => { const o = b.obrPor.get(p.obrigacao_id); return { id: p.id, obrigacaoId: p.obrigacao_id, fornecedor: o ? b.fornPor.get(o.fornecedor_id) ?? null : null, descricao: o?.descricao ?? null, data: p.data_pagamento, valorCentavos: Number(p.valor_centavos), contaId: p.conta_id, conta: b.contaPor.get(p.conta_id) ?? null }; };
const descSaida = (b, s) => (s ? { id: s.id, data: s.data_movimento, valorCentavos: Number(s.valor_centavos), descricao: s.descricao, contaId: s.conta_id, conta: b.contaPor.get(s.conta_id) ?? null, origem: s.origem, referenciaOrigem: s.referencia_origem ?? null, importacaoId: s.importacao_id ?? null } : null);
const noMes = (d, b) => d >= b.de && d <= b.ate;

/** Painel do mês: grupos (sugerido/divergente/conciliado), pagamentos pendentes e saídas a identificar. */
export async function painel(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const b = await carregar(c, mes, deps);
  const grupos = new Map();
  for (const v of b.vincs.filter((x) => ATIVOS.includes(x.status) || x.status === "revogado")) {
    if (!grupos.has(v.grupo)) grupos.set(v.grupo, []);
    grupos.get(v.grupo).push(v);
  }
  const listaGrupos = [];
  for (const [grupo, vs] of grupos) {
    const st = vs.find((x) => ATIVOS.includes(x.status))?.status ?? vs[0].status;
    const pags = vs.filter((x) => x.status === st).map((x) => b.pagPor.get(x.pagamento_id)).filter(Boolean);
    const saida = b.saidaPor.get(vs[0].lancamento_id) ?? null;
    const dataRef = saida?.data_movimento ?? pags[0]?.data_pagamento;
    if (!dataRef || !(noMes(dataRef, b) || pags.some((p) => noMes(p.data_pagamento, b)))) continue;
    const somaPag = pags.reduce((a, p) => a + Number(p.valor_centavos), 0);
    const dif = saida ? Number(saida.valor_centavos) - somaPag : null;
    const dias = saida ? Math.max(0, ...pags.map((p) => Math.abs(diasEntre(saida.data_movimento, p.data_pagamento)))) : null;
    const v0 = vs.find((x) => x.status === st);
    listaGrupos.push({
      grupo, status: st, regra: v0.regra, agrupado: pags.length > 1, pagamentos: pags.map((p) => descPag(b, p)), saida: descSaida(b, saida),
      diferencaCentavos: dif, diasDiferenca: dias, contaDiferente: !!saida && pags.some((p) => p.conta_id !== saida.conta_id),
      dentroTolerancia: dif !== null && dentroDaTolerancia(dif, dias) && pags.every((p) => p.conta_id === saida.conta_id), justificativa: v0.justificativa ?? null,
      confirmadoPor: v0.confirmado_por ?? null, confirmadoEm: v0.confirmado_em ?? null, evidencia: v0.evidencia ?? null,
      revogadoEm: v0.revogado_em ?? null, motivoRevogacao: v0.motivo_revogacao ?? null,
    });
  }
  const pendentes = b.pags.filter((p) => p.status === "ativo" && noMes(p.data_pagamento, b) && (b.alocPag.get(p.id) ?? 0) < Number(p.valor_centavos)).map((p) => descPag(b, p));
  const semVinculo = b.saidas.filter((s) => noMes(s.data_movimento, b) && !b.ehTransf(s) && (b.alocSaida.get(s.id) ?? 0) === 0);
  const aIdentificar = semVinculo.filter((s) => s.classificacao_pendente || !s.categoria_id).map((s) => descSaida(b, s));
  const disponiveis = semVinculo.filter((s) => !(s.classificacao_pendente || !s.categoria_id)).map((s) => ({ ...descSaida(b, s), categoria: b.catPor.get(s.categoria_id)?.nome ?? null }));
  const cont = (st) => listaGrupos.filter((g) => g.status === st).length;
  return {
    mes, tolerancia: TOLERANCIA,
    contagem: { conciliado: cont("conciliado"), sugerido: cont("sugerido"), divergente: cont("divergente"), pendente: pendentes.length, aIdentificar: aIdentificar.length, revogado: cont("revogado") },
    grupos: listaGrupos.sort((a, b) => (a.saida?.data ?? "").localeCompare(b.saida?.data ?? "")), pendentes, aIdentificar, saidasSemVinculo: disponiveis,
  };
}

/** Roda o motor e grava as sugestões (status "sugerido"). Idempotente: o que já tem vínculo ativo não entra; reexecutar não duplica. */
export async function sugerir(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const b = await carregar(c, mes, deps);
  const pagamentos = b.pags.filter((p) => p.status === "ativo" && (b.alocPag.get(p.id) ?? 0) === 0 && p.data_pagamento >= somaDias(b.de, -TOLERANCIA.dias) && p.data_pagamento <= somaDias(b.ate, TOLERANCIA.dias));
  const saidas = b.saidas.filter((s) => !b.ehTransf(s) && (b.alocSaida.get(s.id) ?? 0) === 0 && (noMes(s.data_movimento, b) || pagamentos.some((p) => noMes(p.data_pagamento, b))));
  const { sugestoes, ambiguos } = sugerirVinculos({ pagamentos, saidas });
  let criadas = 0;
  for (const s of sugestoes) {
    const grupo = randomUUID();
    await deps.repo.inserirVinculosSaidas(c, s.alocacoes.map((a) => ({ grupo, pagamento_id: a.pagamentoId, lancamento_id: s.lancamentoId, valor_alocado_centavos: a.valorCentavos, status: "sugerido", regra: s.regra, diferenca_centavos: s.diferencaCentavos, dias_diferenca: s.diasDiferenca })), deps.db);
    criadas += 1;
  }
  return { mes, sugestoesCriadas: criadas, ambiguos: ambiguos.length, observacao: "Sugestões NÃO são conciliações: confirme uma a uma. Casos ambíguos ficam para vínculo manual." };
}

/**
 * Vínculo MANUAL (ação humana com `conciliar`): uma saída ⇄ um ou mais pagamentos. Dentro da tolerância → confirmado na mesma ação (quem vincula
 * é quem confirma). Fora → nasce "divergente" e só concilia com justificativa (agora ou depois). Divergente não resolvido bloqueia o fechamento.
 */
export async function vincular(ctx, body, deps = padrao) {
  const c = exigirContexto(ctx);
  const lancamentoId = uuid(body?.lancamentoId, "lancamentoId");
  const ids = Array.isArray(body?.pagamentoIds) ? [...new Set(body.pagamentoIds.map((x) => uuid(x, "pagamentoIds")))] : [];
  if (!ids.length || ids.length > 20) throw bad("Informe de 1 a 20 pagamentos.", "PAGAMENTOS_OBRIGATORIOS");
  const justificativa = texto(body?.justificativa, "justificativa", { max: 1000, obrigatorio: false });
  const pags = (await deps.repo.listarPagamentos(c, deps.db)).filter((p) => ids.includes(p.id));
  if (pags.length !== ids.length) throw ApiError.notFound("Pagamento não encontrado.");
  const saida = (await deps.repo.listarSaidasExtrato(c, {}, deps.db)).find((s) => s.id === lancamentoId);
  if (!saida) throw ApiError.notFound("Saída do extrato não encontrada.");
  const dif = Number(saida.valor_centavos) - pags.reduce((a, p) => a + Number(p.valor_centavos), 0);
  const dias = Math.max(...pags.map((p) => Math.abs(diasEntre(saida.data_movimento, p.data_pagamento))));
  // (3ª revisão, A-1) nunca conciliar pagamentos que somem MAIS que a saída do extrato (o banco repete a regra)
  if (dif < -TOLERANCIA.centavos) throw bad("Os pagamentos escolhidos somam mais que a saída do extrato. Confira os pagamentos (ou a saída correta).", "FIN2_ALOCACAO_EXCEDIDA");
  // (revisão #6) pagamento numa conta e saída em OUTRA conta: não é "dentro da tolerância" — exige justificativa (o banco repete a regra)
  const dentro = dentroDaTolerancia(dif, dias) && pags.every((p) => p.conta_id === saida.conta_id);
  const grupo = randomUUID();
  await deps.repo.inserirVinculosSaidas(c, pags.map((p) => ({ grupo, pagamento_id: p.id, lancamento_id: lancamentoId, valor_alocado_centavos: Number(p.valor_centavos), status: dentro ? "sugerido" : "divergente", regra: "manual", diferenca_centavos: dif, dias_diferenca: dias })), deps.db);
  if (dentro || (justificativa && justificativa.length >= 10)) {
    const evidencia = await deps.repo.confirmarVinculoSaidaRpc(c, grupo, dentro ? null : justificativa, deps.db);
    return { grupo, status: "conciliado", diferencaCentavos: dif, diasDiferenca: dias, evidencia };
  }
  return { grupo, status: "divergente", diferencaCentavos: dif, diasDiferenca: dias, observacao: "Fora da tolerância: confirme com justificativa ou rejeite. Divergência não resolvida bloqueia o fechamento." };
}

export async function confirmar(ctx, grupo, body, deps = padrao) {
  const c = exigirContexto(ctx);
  const justificativa = texto(body?.justificativa, "justificativa", { max: 1000, obrigatorio: false });
  const evidencia = await deps.repo.confirmarVinculoSaidaRpc(c, uuid(grupo, "grupo"), justificativa, deps.db);
  return { grupo, status: "conciliado", evidencia };
}
export async function rejeitar(ctx, grupo, deps = padrao) {
  const c = exigirContexto(ctx);
  const n = await deps.repo.rejeitarVinculosSaidas(c, uuid(grupo, "grupo"), deps.db);
  if (!n) throw ApiError.notFound("Sugestão não encontrada (ou já decidida).");
  return { grupo, status: "rejeitado" };
}
export async function revogar(ctx, grupo, body, deps = padrao) {
  const c = exigirContexto(ctx);
  const motivo = texto(body?.motivo, "motivo", { max: 1000 });
  if (motivo.length < 10) throw bad("Informe o motivo (mínimo de 10 caracteres).", "MOTIVO_OBRIGATORIO");
  await deps.repo.revogarVinculoSaidaRpc(c, uuid(grupo, "grupo"), motivo, deps.db);
  return { grupo, status: "revogado" };
}
