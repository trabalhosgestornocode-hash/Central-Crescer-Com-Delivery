// Faturamento por CANAL e ponte até a base gerencial (migration 153). Registrar faturamento NÃO cria recebimento bancário nem altera as
// vendas diárias oficiais (fin_referencias): é a consolidação por canal, com a granularidade DECLARADA (mensal ou diária). Nunca se
// fabrica venda diária a partir de total mensal. Ajuste é reconciliação entre dois totais de vendas, não taxa financeira nem dedução.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, valorPositivo, valorOuNulo, mesAno, enumerado, inteiro, bad } from "./validacao.js";
import { comporPonte, nomeDoCanal } from "../../../financeiro-calculos/canaisVenda.js";

const padrao = { repo: repositorio, db: undefined, agora: () => new Date().toISOString() };
export const TIPOS_AJUSTE = ["estimativa", "taxa_entrega", "desconto", "outro"];
const motivo = (v) => { const m = texto(v, "motivo", { max: 500 }); if (m.length < 5) throw bad("Informe o motivo (mínimo de 5 caracteres).", "MOTIVO_OBRIGATORIO"); return m; };
const linhaCanal = (r) => ({ id: r.id, canal: r.canal, origemTecnica: r.origem_tecnica, vendasQtd: r.vendas_qtd, ticketMedioCentavos: r.vendas_qtd ? Math.round(Number(r.valor_gerencial_centavos) / r.vendas_qtd) : null, painelCentavos: Number(r.valor_painel_centavos), gerencialCentavos: Number(r.valor_gerencial_centavos), granularidade: r.granularidade, fonte: r.fonte, observacao: r.observacao, competencia: String(r.competencia).slice(0, 7) });
const linhaAjuste = (r) => ({ id: r.id, canal: r.canal, tipo: r.tipo, valorCentavos: Number(r.valor_centavos), descricao: r.descricao, estado: r.estado, evidencia: r.evidencia, confirmadoPor: r.confirmado_por, confirmadoEm: r.confirmado_em, competencia: String(r.competencia).slice(0, 7) });

async function brutoOficial(c, mes, deps) {
  const refs = await deps.repo.listarReferencias(c, { mes }, deps.db);
  const v = refs.filter((r) => r.tipo === "venda");
  return v.length ? v.reduce((s, r) => s + Number(r.valor_centavos), 0) : null;
}

/** Visão do mês: canais, ajustes e a ponte painel → base gerencial (com a conferência contra o bruto oficial). */
export async function listar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const [canais, ajustes, bruto] = await Promise.all([deps.repo.listarVendasCanal(c, { competencia: `${mes}-01` }, deps.db), deps.repo.listarVendasAjustes(c, { competencia: `${mes}-01` }, deps.db), brutoOficial(c, mes, deps)]);
  return { mes, ...comporPonte({ canais: canais.map(linhaCanal), ajustes: ajustes.map(linhaAjuste), brutoOficialCentavos: bruto }) };
}

function validarCanal(b) {
  const mes = mesAno(b?.mes, "mes");
  const painel = valorPositivo(b?.valorPainel ?? b?.valor, "valor do painel");
  const gerencial = b?.valorGerencial == null || b.valorGerencial === "" ? painel : valorPositivo(b.valorGerencial, "valor gerencial");
  const origem = texto(b?.origemTecnica, "origemTecnica", { max: 120, obrigatorio: false });
  return { competencia: `${mes}-01`, mes, canal: nomeDoCanal(texto(b?.canal ?? origem, "canal", { max: 60 })), origem_tecnica: origem, granularidade: enumerado(b?.granularidade ?? "mensal", "granularidade", ["mensal", "diaria"]),
    vendas_qtd: b?.vendasQtd == null || b.vendasQtd === "" ? null : inteiro(b.vendasQtd, "vendasQtd", { min: 0, max: 10_000_000 }), valor_painel_centavos: painel, valor_gerencial_centavos: gerencial,
    fonte: texto(b?.fonte, "fonte", { max: 120 }), observacao: texto(b?.observacao, "observacao", { max: 500, obrigatorio: false }), chave_origem: texto(b?.chaveOrigem, "chaveOrigem", { max: 200, obrigatorio: false }) };
}
function validarAjuste(b) {
  const mes = mesAno(b?.mes, "mes");
  const v = valorOuNulo(b?.valor, "valor");
  if (v == null || v === 0) throw bad("O valor do ajuste não pode ser zero.");
  return { competencia: `${mes}-01`, mes, canal: nomeDoCanal(texto(b?.canal, "canal", { max: 60 })), tipo: enumerado(b?.tipo, "tipo", TIPOS_AJUSTE), valor_centavos: v, descricao: texto(b?.descricao, "descricao", { max: 300 }),
    estado: "estimado", evidencia: texto(b?.evidencia, "evidencia", { max: 500, obrigatorio: false }), chave_origem: texto(b?.chaveOrigem, "chaveOrigem", { max: 200, obrigatorio: false }) };
}
const semMes = ({ mes, ...r }) => r;

/** Registra a consolidação de UM canal no mês (manual ou importada). Um canal ativo por mês: para trocar, cancele com motivo. */
export async function registrarCanal(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const v = validarCanal(b);
  const existentes = await deps.repo.listarVendasCanal(c, { competencia: v.competencia }, deps.db);
  const dup = existentes.find((e) => nomeDoCanal(e.canal) === v.canal);
  if (dup) throw bad(`Já existe faturamento de ${v.canal} em ${v.mes}. Cancele o registro atual (com motivo) antes de registrar outro.`, "CANAL_JA_REGISTRADO");
  const row = await deps.repo.inserirVendaCanal(c, semMes(v), deps.db);
  return { ...linhaCanal(row), mostrarEm: ["Visão Geral → Faturamento por canal", "DRE Gerencial → Faturamento bruto (composição)"], observacaoFluxo: "Não cria recebimento bancário. O faturamento oficial do mês continua sendo o das vendas diárias." };
}

export async function cancelarCanal(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await deps.repo.atualizarVendaCanal(c, id, { status: "cancelada", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: (deps.agora ?? padrao.agora)() }, deps.db);
  if (!r) throw bad("Registro não encontrado.", "NAO_ENCONTRADO");
  return linhaCanal(r);
}

export async function registrarAjuste(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const v = validarAjuste(b);
  return linhaAjuste(await deps.repo.inserirVendaAjuste(c, semMes(v), deps.db));
}
/** Confirmar é decisão de responsável autorizado (CLASSIFICAR) e exige evidência: estimado nunca vira confirmado sozinho. */
export async function confirmarAjuste(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const evidencia = texto(b?.evidencia, "evidencia", { max: 500 });
  if (evidencia.length < 5) throw bad("Informe a evidência da confirmação (ex.: relatório do Portal do Parceiro).", "EVIDENCIA_OBRIGATORIA");
  const r = await deps.repo.atualizarVendaAjuste(c, id, { estado: "confirmado", evidencia, confirmado_por: c.usuarioId, confirmado_em: (deps.agora ?? padrao.agora)() }, deps.db);
  if (!r) throw bad("Ajuste não encontrado.", "NAO_ENCONTRADO");
  return linhaAjuste(r);
}
export async function cancelarAjuste(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const r = await deps.repo.atualizarVendaAjuste(c, id, { status: "cancelada", motivo_cancelamento: motivo(b?.motivo), cancelado_por: c.usuarioId, cancelado_em: (deps.agora ?? padrao.agora)() }, deps.db);
  if (!r) throw bad("Ajuste não encontrado.", "NAO_ENCONTRADO");
  return linhaAjuste(r);
}

/**
 * Importação de um relatório mensal por canal (ex.: SAIPOS + base gerencial da contadora). IDEMPOTENTE: cada linha tem chave
 * `${fonte}:${mes}:${canal}`; reimportar não duplica (linhas já existentes são contadas e, se o valor mudou, reportadas como conflito).
 */
export async function importar(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(b?.mes, "mes"), fonte = texto(b?.fonte, "fonte", { max: 120 });
  if (!Array.isArray(b?.canais) || !b.canais.length) throw bad("Informe ao menos um canal.");
  if (b.canais.length > 20 || (b.ajustes ?? []).length > 50) throw bad("Importação grande demais.");
  const existentesC = await deps.repo.listarVendasCanal(c, { competencia: `${mes}-01` }, deps.db);
  const existentesA = await deps.repo.listarVendasAjustes(c, { competencia: `${mes}-01` }, deps.db);
  const out = { mes, criados: { canais: 0, ajustes: 0 }, jaExistentes: { canais: 0, ajustes: 0 }, conflitos: [] };
  for (const raw of b.canais) {
    const v = validarCanal({ ...raw, mes, fonte, granularidade: raw.granularidade ?? "mensal" });
    v.chave_origem = `${fonte}:${mes}:${v.canal}`;
    const ja = existentesC.find((e) => e.chave_origem === v.chave_origem || nomeDoCanal(e.canal) === v.canal);
    if (ja) { out.jaExistentes.canais++; if (Number(ja.valor_painel_centavos) !== v.valor_painel_centavos || Number(ja.valor_gerencial_centavos) !== v.valor_gerencial_centavos) out.conflitos.push(`${v.canal}: já registrado com valores diferentes (cancele o anterior para substituir).`); continue; }
    await deps.repo.inserirVendaCanal(c, semMes(v), deps.db); out.criados.canais++;
  }
  for (const raw of b.ajustes ?? []) {
    const v = validarAjuste({ ...raw, mes });
    v.chave_origem = `${fonte}:${mes}:ajuste:${v.canal}:${v.tipo}:${v.valor_centavos}`;
    if (existentesA.some((e) => e.chave_origem === v.chave_origem)) { out.jaExistentes.ajustes++; continue; }
    await deps.repo.inserirVendaAjuste(c, semMes(v), deps.db); out.criados.ajustes++;
  }
  return out;
}
