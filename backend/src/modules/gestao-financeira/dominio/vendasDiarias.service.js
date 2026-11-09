// VENDAS DIÁRIAS (SAIPOS): uma linha por dia com venda bruta, recebido em espécie e sangria. Guardadas em `fin_referencias` (tipos venda · dinheiro · sangria),
// a MESMA fonte que já alimenta o faturamento, a conciliação e a Visão Geral: registrar aqui não cria outra venda, não cria recebimento bancário e não
// cria despesa. Os identificadores e as referências de origem dos dados já importados são preservados.
//   • venda bruta  → faturamento do mês (Visão Geral / DRE), pela mesma soma de sempre;
//   • espécie      → conferida contra as entradas do CAIXA FÍSICO do dia (sem criar movimento);
//   • sangria      → retirada de dinheiro do caixa, com DESTINO escrito; é conferida contra as saídas do caixa e NÃO vira despesa automaticamente.
// Edição = a linha antiga é CANCELADA com motivo e outra é registrada (nada é sobrescrito): o histórico fica na própria base e na trilha de auditoria.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, valorOuNulo, mesAno, data as validarData, bad } from "./validacao.js";
import { ApiError } from "../../../shared/ApiError.js";
import { calcularMes } from "./conciliacao.service.js";
import { lerVendasDiarias } from "./importacao/leitorVendasDiarias.js";
import { ESTADO } from "../../../financeiro-calculos/conciliacao.js";

const padrao = { repo: repositorio, db: undefined, hoje: () => new Date().toISOString().slice(0, 10) };
const CAMPOS = [["venda", "venda", "Venda bruta"], ["especie", "dinheiro", "Recebido em espécie"], ["sangria", "sangria", "Sangria"]];   // [campo, tipo em fin_referencias, rótulo]
const TIPO_DE = Object.fromEntries(CAMPOS.map(([c, t]) => [c, t])), ROTULO = Object.fromEntries(CAMPOS.map(([c, , r]) => [c, r]));
const TIPOS = CAMPOS.map(([, t]) => t);
const ACAO = { EDITAR: "gestao_financeira.editar" };
const pode = (perms, a) => Array.isArray(perms) && perms.includes(a);
const motivoTxt = (v) => { const m = texto(v, "motivo", { max: 500 }); if (m.length < 5) throw bad("Informe o motivo (mínimo de 5 caracteres).", "MOTIVO_OBRIGATORIO"); return m; };
const diasDoMes = (mes) => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };

/** nota da linha de sangria = "Destino: X | Obs: Y" (estruturada de propósito: não há coluna própria e não se cria tabela). */
export const montarNotaSangria = (destino, obs) => [destino ? `Destino: ${destino}` : "Destino: não informado", obs ? `Obs: ${obs}` : null].filter(Boolean).join(" | ").slice(0, 500);
export function lerNotaSangria(nota) {
  const m = /^Destino: (.*?)(?: \| Obs: (.*))?$/s.exec(nota ?? "");
  const destino = m ? m[1] : null;
  return { destino: destino && destino !== "não informado" ? destino : null, observacao: m ? (m[2] ?? null) : (nota ?? null) };
}
const quem = (id, fonte) => (fonte === "saipos" || fonte === "planilha_complementar" ? "Importação" : id ? `usuário ····${String(id).slice(-4)}` : "—");
const fonteRotulo = (f) => ({ saipos: "SAIPOS (importação)", manual: "Manual", planilha_complementar: "Planilha complementar (importação)", arquivo_referencia: "Arquivo de referência" }[f] ?? f);

function agrupar(refs) {
  const por = new Map();
  for (const r of refs.filter((x) => TIPOS.includes(x.tipo) && x.status === "ativa")) {
    const d = String(r.data).slice(0, 10), x = por.get(d) ?? { data: d, campos: {} };
    const campo = CAMPOS.find(([, t]) => t === r.tipo)[0];
    if (x.campos[campo]) x.duplicado = true;                                  // nunca soma duas vezes em silêncio: marca
    else x.campos[campo] = r;
    por.set(d, x);
  }
  return [...por.values()].sort((a, b) => a.data.localeCompare(b.data));
}
const celula = (r) => (r ? { id: r.id, valorCentavos: Number(r.valor_centavos), fonte: r.fonte, fonteRotulo: fonteRotulo(r.fonte), referenciaOrigem: r.referencia_origem ?? null, registradoEm: r.created_at, responsavel: quem(r.criado_por, r.fonte), nota: r.nota ?? null } : null);

/** Visão do mês: dias, indicadores, conferência com o caixa físico (divergência com dia, campo e valores) e integração. */
export async function listar(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const { resultado, referencias } = await calcularMes(c, mes, deps);
  const dias = agrupar(referencias);
  const caixa = new Map(resultado.caixaDias.map((d) => [d.data, d])), sang = new Map(resultado.sangriaDias.map((d) => [d.data, d]));
  const linhas = dias.map((d) => {
    const venda = celula(d.campos.venda), especie = celula(d.campos.especie), sangria = celula(d.campos.sangria);
    const divergencias = [];
    const cx = caixa.get(d.data), sg = sang.get(d.data);
    if (especie && cx && [ESTADO.PENDENTE, ESTADO.PARCIAL].includes(cx.estado)) divergencias.push({ campo: ROTULO.especie, informadoCentavos: especie.valorCentavos, caixaCentavos: cx.fluxoCentavos, diferencaCentavos: cx.diferencaCentavos, comparadoCom: "entradas do caixa físico no dia" });
    if (sangria && sg && [ESTADO.PENDENTE, ESTADO.PARCIAL].includes(sg.estado)) divergencias.push({ campo: ROTULO.sangria, informadoCentavos: sangria.valorCentavos, caixaCentavos: sg.fluxoCentavos, diferencaCentavos: sg.diferencaCentavos, comparadoCom: "saídas do caixa físico no dia (exceto exceções aprovadas)" });
    if (d.duplicado) divergencias.push({ campo: "Registros", informadoCentavos: null, caixaCentavos: null, diferencaCentavos: null, comparadoCom: "há mais de um registro ativo para o mesmo campo e dia: confira o histórico" });
    const conferiveis = [especie && cx, sangria && sg].filter(Boolean);
    const situacao = divergencias.length ? "divergente" : conferiveis.length && conferiveis.every((x) => [ESTADO.CONCILIADO, ESTADO.RESOLVIDO].includes(x.estado)) ? "conferido" : "registrado";
    const { destino, observacao: obsSang } = lerNotaSangria(sangria?.nota);
    const fontes = [...new Set([venda, especie, sangria].filter(Boolean).map((x) => x.fonteRotulo))];
    return { data: d.data, venda, especie, sangria: sangria ? { ...sangria, destino, destinoPendente: sangria.valorCentavos > 0 && !destino, observacao: obsSang } : null, observacao: venda?.nota ?? null, fontes,
      situacao, situacaoRotulo: { divergente: "Divergente", conferido: "Conferido com o caixa", registrado: "Registrado" }[situacao], divergencias,
      responsavel: venda?.responsavel ?? especie?.responsavel ?? sangria?.responsavel ?? "—", registradoEm: venda?.registradoEm ?? especie?.registradoEm ?? sangria?.registradoEm ?? null };
  });
  const busca = String(q?.busca ?? "").trim().toLowerCase();
  const filtradas = linhas.filter((l) => (!busca || [l.data, `${l.data.slice(8, 10)}/${l.data.slice(5, 7)}`, ...l.fontes, l.sangria?.destino, l.observacao, l.situacaoRotulo].filter(Boolean).join(" ").toLowerCase().includes(busca))
    && (!q?.situacao || l.situacao === q.situacao));
  const soma = (f) => linhas.reduce((s, l) => s + (l[f]?.valorCentavos ?? 0), 0);
  const comVenda = linhas.filter((l) => l.venda);
  const hoje = (deps.hoje ?? padrao.hoje)(), ultimo = `${mes}-${String(diasDoMes(mes)).padStart(2, "0")}`, limite = hoje < ultimo ? hoje : ultimo;
  const registrados = new Set(linhas.map((l) => l.data));
  const semRegistro = []; for (let d = 1; d <= diasDoMes(mes); d++) { const iso = `${mes}-${String(d).padStart(2, "0")}`; if (iso <= limite && !registrados.has(iso)) semRegistro.push(iso); }
  const refCx = resultado.caixaDias.filter((d) => d.referenciaCentavos !== null), refSg = resultado.sangriaDias.filter((d) => d.referenciaCentavos !== null);
  return {
    mes, linhas: filtradas, totalDias: linhas.length,
    indicadores: { totalVendaBrutaCentavos: soma("venda"), totalEspecieCentavos: soma("especie"), totalSangriaCentavos: soma("sangria"), mediaDiariaCentavos: comVenda.length ? Math.round(soma("venda") / comVenda.length) : null,
      diasRegistrados: linhas.length, diasComVenda: comVenda.length, diasNoMes: diasDoMes(mes), diasSemRegistro: semRegistro, divergentes: linhas.filter((l) => l.situacao === "divergente").length, conferidos: linhas.filter((l) => l.situacao === "conferido").length,
      destinosPendentes: linhas.filter((l) => l.sangria?.destinoPendente).length },
    conferencia: { especie: { informadoCentavos: refCx.reduce((s, d) => s + d.referenciaCentavos, 0), caixaFisicoCentavos: refCx.reduce((s, d) => s + d.fluxoCentavos, 0) }, sangria: { informadoCentavos: refSg.reduce((s, d) => s + d.referenciaCentavos, 0), caixaFisicoCentavos: refSg.reduce((s, d) => s + d.fluxoCentavos, 0) } },
    integracao: { faturamentoBrutoCentavos: soma("venda"), onde: ["Visão Geral → Faturamento bruto", "DRE Gerencial → Faturamento bruto", "Conciliação → ponte de vendas × recebimentos"],
      regras: ["A venda bruta é o faturamento: não cria recebimento bancário (o que entra no banco vem do extrato, com prazo e taxas).", "O recebimento em espécie é conferido com o caixa físico; não cria movimento.", "A sangria é retirada de dinheiro do caixa com destino; só vira despesa se o gasto for lançado como despesa.", "Sem divisão por canal: o relatório diário não a traz. A divisão por canal é a consolidação mensal (Visão Geral)."] },
  };
}

/** Detalhe de um dia: origem de cada valor, versões anteriores (canceladas com motivo), trilha de auditoria e o caixa físico do dia. */
export async function detalhe(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const dia = validarData(q?.data, "data"), mes = dia.slice(0, 7);
  const [todas, calc] = await Promise.all([deps.repo.listarReferencias(c, { mes, incluirCanceladas: true }, deps.db), calcularMes(c, mes, deps)]);
  const doDia = todas.filter((r) => String(r.data).slice(0, 10) === dia && TIPOS.includes(r.tipo));
  if (!doDia.length) throw ApiError.notFound("Não há venda registrada neste dia.");
  const aud = (await Promise.all(doDia.map((r) => deps.repo.listarAuditoria(c, { entidade: "fin_referencias", entidadeId: r.id, limite: 30 }, deps.db).catch(() => [])))).flat();
  const contaCaixa = new Set(calc.contas.filter((x) => x.tipo_conta === "caixa_fisico").map((x) => x.id));
  const caixaDoDia = calc.lancamentos.filter((l) => String(l.data_movimento).slice(0, 10) === dia && contaCaixa.has(l.conta_id) && l.status !== "cancelado");
  const versao = (r) => ({ id: r.id, campo: ROTULO[CAMPOS.find(([, t]) => t === r.tipo)[0]], valorCentavos: Number(r.valor_centavos), fonte: fonteRotulo(r.fonte), referenciaOrigem: r.referencia_origem ?? null, registradoEm: r.created_at, responsavel: quem(r.criado_por, r.fonte),
    status: r.status, canceladaEm: r.cancelada_em ?? null, motivoCancelamento: r.motivo_cancelamento ?? null, nota: r.nota ?? null, chaveOrigem: r.chave_origem ?? null });
  return { data: dia, atuais: doDia.filter((r) => r.status === "ativa").map(versao), anteriores: doDia.filter((r) => r.status !== "ativa").map(versao).sort((a, b) => String(b.canceladaEm).localeCompare(String(a.canceladaEm))),
    auditoria: aud.map((a) => ({ id: a.id, em: a.created_at, acao: a.acao, entidadeId: a.entidade_id })).sort((a, b) => String(b.em).localeCompare(String(a.em))),
    caixaFisico: caixaDoDia.map((l) => ({ id: l.id, descricao: l.descricao, sentido: l.sentido, valorCentavos: Number(l.valor_centavos) })),
    conferencia: { especie: calc.resultado.caixaDias.find((d) => d.data === dia) ?? null, sangria: calc.resultado.sangriaDias.find((d) => d.data === dia) ?? null } };
}

/** Histórico do mês: tudo o que foi registrado, trocado ou cancelado (versões), do mais recente ao mais antigo. */
export async function historico(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const todas = (await deps.repo.listarReferencias(c, { mes, incluirCanceladas: true }, deps.db)).filter((r) => TIPOS.includes(r.tipo));
  const eventos = todas.flatMap((r) => {
    const base = { data: String(r.data).slice(0, 10), campo: ROTULO[CAMPOS.find(([, t]) => t === r.tipo)[0]], valorCentavos: Number(r.valor_centavos), fonte: fonteRotulo(r.fonte), responsavel: quem(r.criado_por, r.fonte) };
    return [{ ...base, evento: "registrado", em: r.created_at, referenciaOrigem: r.referencia_origem ?? null }, ...(r.status === "cancelada" ? [{ ...base, evento: "cancelado", em: r.cancelada_em, motivo: r.motivo_cancelamento }] : [])];
  }).sort((a, b) => String(b.em).localeCompare(String(a.em)));
  return { mes, total: eventos.length, eventos: eventos.slice(0, 300) };
}

function valorCampo(b, campo, obrigatorio) {
  const bruto = b?.[campo];
  if (bruto == null || bruto === "") { if (obrigatorio) throw bad(`${ROTULO[campo]} é obrigatório (zero é permitido e significa "zero informado").`, "VALOR_OBRIGATORIO"); return null; }
  const v = valorOuNulo(bruto, ROTULO[campo]);
  if (v == null) { if (obrigatorio) throw bad(`${ROTULO[campo]} inválido.`, "VALOR_INVALIDO"); return null; }
  if (v < 0) throw bad(`${ROTULO[campo]} não pode ser negativo.`, "VALOR_NEGATIVO");
  return v;
}
const novaLinha = (dia, campo, valor, fonte, extra = {}) => ({ data: dia, tipo: TIPO_DE[campo], canal: null, valor_centavos: valor, fonte, referencia_origem: extra.referenciaOrigem ?? null, chave_origem: null, nota: extra.nota ?? null });

/** Registro MANUAL de um dia. Um dia só existe uma vez: para trocar valores use Editar (com motivo). */
export async function registrar(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const dia = validarData(b?.data, "data");
  const venda = valorCampo(b, "venda", true), especie = valorCampo(b, "especie", false), sangria = valorCampo(b, "sangria", false);
  const destino = texto(b?.destinoSangria, "destino da sangria", { max: 120, obrigatorio: false });
  if (sangria > 0 && !destino) throw bad("Informe o destino da sangria (para onde o dinheiro foi retirado).", "DESTINO_OBRIGATORIO");
  const fonte = ["manual", "saipos"].includes(b?.fonte) ? b.fonte : "manual";
  const existentes = (await deps.repo.listarReferencias(c, { mes: dia.slice(0, 7) }, deps.db)).filter((r) => String(r.data).slice(0, 10) === dia && TIPOS.includes(r.tipo));
  if (existentes.length) throw bad(`Já existe venda registrada em ${dia.slice(8, 10)}/${dia.slice(5, 7)}. Use “Editar” (com motivo) para corrigir; nada é somado duas vezes.`, "DIA_JA_REGISTRADO");
  const obs = texto(b?.observacao, "observação", { max: 300, obrigatorio: false });
  const linhas = [novaLinha(dia, "venda", venda, fonte, { nota: obs, referenciaOrigem: `Registro ${fonte === "saipos" ? "SAIPOS (digitado)" : "manual"}` })];
  if (especie != null) linhas.push(novaLinha(dia, "especie", especie, fonte, { referenciaOrigem: `Registro ${fonte === "saipos" ? "SAIPOS (digitado)" : "manual"}` }));
  if (sangria != null) linhas.push(novaLinha(dia, "sangria", sangria, fonte, { nota: montarNotaSangria(destino, null), referenciaOrigem: `Registro ${fonte === "saipos" ? "SAIPOS (digitado)" : "manual"}` }));
  const gravadas = await deps.repo.inserirReferenciasRetornando(c, linhas, deps.db);
  return { data: dia, registros: gravadas.map((r) => ({ id: r.id, campo: ROTULO[CAMPOS.find(([, t]) => t === r.tipo)[0]], valorCentavos: Number(r.valor_centavos) })),
    aparecera: ["Visão Geral → Faturamento (soma do mês)", "DRE Gerencial → Faturamento bruto", "Conferência com o caixa físico (espécie e sangria)"], observacao: "Nenhum recebimento bancário foi criado e a sangria não foi lançada como despesa." };
}

/** Troca valores/destino de um dia: a linha antiga é cancelada com motivo e outra é registrada (ordem: grava a nova, só então cancela a antiga). */
async function trocar(c, antiga, nova, motivo, deps) {
  const [criada] = await deps.repo.inserirReferenciasRetornando(c, [{ ...nova, referencia_origem: `${nova.referencia_origem ?? "Edição"} (substitui ${antiga.id})` }], deps.db);
  try { if (!(await deps.repo.cancelarReferencia(c, antiga.id, motivo, deps.db))) throw new Error("não cancelada"); }
  catch (e) { await deps.repo.cancelarReferencia(c, criada.id, "Edição desfeita: a linha anterior não pôde ser cancelada (evita contar o dia duas vezes).", deps.db).catch(() => {}); throw e; }
  return criada;
}

export async function editar(ctx, dia0, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  if (!pode(permissoes, ACAO.EDITAR)) throw ApiError.forbidden("Seu perfil registra vendas, mas não edita registros existentes.", { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" });
  const dia = validarData(dia0, "data"), motivo = motivoTxt(b?.motivo);
  const ativas = (await deps.repo.listarReferencias(c, { mes: dia.slice(0, 7) }, deps.db)).filter((r) => String(r.data).slice(0, 10) === dia && TIPOS.includes(r.tipo));
  if (!ativas.length) throw ApiError.notFound("Não há venda registrada neste dia.");
  const alterados = [];
  for (const campo of ["venda", "especie", "sangria"]) {
    const informado = b?.[campo] != null && b[campo] !== "";
    const antiga = ativas.find((r) => r.tipo === TIPO_DE[campo]);
    const destinoMudou = campo === "sangria" && b?.destinoSangria !== undefined;
    const obsMudou = campo === "venda" && b?.observacao !== undefined;
    if (!informado && !destinoMudou && !obsMudou) continue;
    const valor = informado ? valorCampo(b, campo, true) : antiga ? Number(antiga.valor_centavos) : null;
    if (valor == null) continue;
    let nota = antiga?.nota ?? null;
    if (campo === "sangria") { const atual = lerNotaSangria(antiga?.nota); const destino = texto(b?.destinoSangria ?? atual.destino, "destino da sangria", { max: 120, obrigatorio: false }); if (valor > 0 && !destino) throw bad("Informe o destino da sangria.", "DESTINO_OBRIGATORIO"); nota = montarNotaSangria(destino, atual.observacao); }
    if (campo === "venda" && obsMudou) nota = texto(b.observacao, "observação", { max: 300, obrigatorio: false });
    if (antiga && Number(antiga.valor_centavos) === valor && (antiga.nota ?? null) === (nota ?? null)) continue;      // nada mudou neste campo
    const linha = novaLinha(dia, campo, valor, "manual", { nota, referenciaOrigem: "Edição manual" });
    if (antiga) await trocar(c, antiga, linha, motivo, deps); else await deps.repo.inserirReferenciasRetornando(c, [linha], deps.db);
    alterados.push({ campo: ROTULO[campo], de: antiga ? Number(antiga.valor_centavos) : null, para: valor });
  }
  if (!alterados.length) throw bad("Nada mudou: os valores informados são iguais aos registrados.", "SEM_MUDANCA");
  return { data: dia, alterados, motivo };
}

// ------------------------------------------------------------------ importação do relatório SAIPOS
function classificar(dias, existentes) {
  const porDia = new Map();
  for (const r of existentes.filter((x) => TIPOS.includes(x.tipo) && x.status === "ativa")) { const d = String(r.data).slice(0, 10); (porDia.get(d) ?? porDia.set(d, []).get(d)).push(r); }
  return dias.map((d) => {
    const atuais = porDia.get(d.data) ?? [];
    const campos = [["venda", d.vendaCentavos], ["especie", d.especieCentavos], ["sangria", d.sangriaCentavos]].filter(([, v]) => v != null).map(([campo, arquivo]) => {
      const a = atuais.find((r) => r.tipo === TIPO_DE[campo]);
      return { campo, rotulo: ROTULO[campo], atualCentavos: a ? Number(a.valor_centavos) : null, arquivoCentavos: arquivo, estado: !a ? "novo" : Number(a.valor_centavos) === arquivo ? "igual" : "diferente", id: a?.id ?? null };
    });
    const estado = !atuais.length ? "novo" : campos.some((x) => x.estado === "diferente") ? "atualizar" : campos.some((x) => x.estado === "novo") ? "completar" : "igual";
    return { ...d, estado, campos };
  });
}
async function lerEPrever(c, b, deps) {
  const b64 = b?.conteudoBase64;
  if (typeof b64 !== "string" || !b64) throw bad("Arquivo não enviado.", "ARQUIVO_AUSENTE");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad("Arquivo em formato inválido.", "ARQUIVO_INVALIDO");
  const { dias, erros, colunas } = (deps.leitorVendasDiarias ?? lerVendasDiarias)(Buffer.from(b64, "base64"));
  const meses = [...new Set(dias.map((d) => d.data.slice(0, 7)))];
  if (meses.length > 3) throw bad("O arquivo cobre mais de 3 meses: importe um período menor por vez.", "PERIODO_GRANDE");
  const existentes = (await Promise.all(meses.map((m) => deps.repo.listarReferencias(c, { mes: m }, deps.db)))).flat();
  const previa = classificar(dias, existentes);
  const n = (e) => previa.filter((d) => d.estado === e).length;
  return { arquivo: { nome: texto(b?.arquivoNome, "nome do arquivo", { max: 120, obrigatorio: false }) ?? "relatório SAIPOS", colunas }, meses, dias: previa, erros,
    resumo: { dias: previa.length, novos: n("novo"), iguais: n("igual"), atualizar: n("atualizar"), completar: n("completar"), erros: erros.length } };
}

export async function previaImportacao(ctx, b, deps = padrao) { return lerEPrever(exigirContexto(ctx), b, deps); }

/**
 * Importa o relatório. IDEMPOTENTE por dia+campo: o que já existe igual é REJEITADO como duplicidade (nunca soma de novo); o que difere só é
 * atualizado com `atualizar:true`, motivo e permissão de editar (a linha antiga é cancelada, nada some). Com erro no arquivo, não grava nada.
 */
export async function importar(ctx, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  const p = await lerEPrever(c, b, deps);
  if (p.erros.length) throw bad(`O arquivo tem ${p.erros.length} linha(s) com erro e nada foi importado: ${p.erros.slice(0, 3).map((e) => `linha ${e.linha}: ${e.motivo}`).join("; ")}.`, "ARQUIVO_COM_ERROS");
  const atualizar = b?.atualizar === true;
  if (atualizar && !pode(permissoes, ACAO.EDITAR)) throw ApiError.forbidden("Atualizar registros existentes exige permissão de edição.", { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" });
  const motivo = atualizar && p.resumo.atualizar ? motivoTxt(b?.motivo) : null;
  const origem = (d) => `SAIPOS · ${p.arquivo.nome} · linha ${d.linha}`;
  const novas = [], trocas = [];
  for (const d of p.dias) {
    for (const f of d.campos) {
      const nota = f.campo === "sangria" ? montarNotaSangria(d.destino, d.observacao) : f.campo === "venda" ? d.observacao : null;
      if (f.estado === "novo") novas.push(novaLinha(d.data, f.campo, f.arquivoCentavos, "saipos", { nota, referenciaOrigem: origem(d) }));
      else if (f.estado === "diferente" && atualizar) trocas.push({ id: f.id, linha: novaLinha(d.data, f.campo, f.arquivoCentavos, "saipos", { nota, referenciaOrigem: origem(d) }) });
    }
  }
  if (novas.length) await deps.repo.inserirReferenciasRetornando(c, novas, deps.db);
  const existentes = trocas.length ? (await Promise.all(p.meses.map((m) => deps.repo.listarReferencias(c, { mes: m }, deps.db)))).flat() : [];
  for (const t of trocas) await trocar(c, existentes.find((r) => r.id === t.id), t.linha, motivo, deps);
  const iguais = p.dias.reduce((s, d) => s + d.campos.filter((f) => f.estado === "igual").length, 0);
  const diferentes = p.dias.reduce((s, d) => s + d.campos.filter((f) => f.estado === "diferente").length, 0);
  return { importado: true, registrosCriados: novas.length, registrosAtualizados: trocas.length, duplicidadesRejeitadas: iguais, divergentesNaoAtualizados: atualizar ? 0 : diferentes,
    resumo: p.resumo, observacao: "Nenhum recebimento bancário foi criado e nenhuma sangria foi lançada como despesa." };
}
