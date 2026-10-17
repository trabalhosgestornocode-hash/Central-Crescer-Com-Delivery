// Importação do livro-caixa — núcleo PURO (sem I/O). Recebe linhas brutas já lidas do arquivo e devolve a prévia.
//
// Idempotência: chave = impressão(conteúdo normalizado) + "#" + n-ésima ocorrência de linhas IDÊNTICAS.
//  • reimportar o mesmo arquivo → mesmas chaves → nada duplica;
//  • reordenar linhas → o multiconjunto de impressões não muda → mesmas chaves (linhas idênticas são intercambiáveis);
//  • duplicata legítima (duas linhas idênticas) → #1 e #2, ambas preservadas e sinalizadas para revisão;
//  • linha editada → impressão nova: entra como "novo" e, se casar (data, conta, sentido, valor) com uma existente que sumiu
//    do arquivo, vira POSSÍVEL ALTERAÇÃO e só entra com aceite explícito. Nada é excluído nem sobrescrito automaticamente.
// Comentários e fórmulas de célula não entram na impressão (não geram "novo"), mas são preservados como nota de revisão.

import { createHash } from "node:crypto";
import { paraCentavos } from "./dinheiro.js";
import { PAPEL, papelDeTipoNatureza } from "./planoContas.js";

export const MOTIVO = Object.freeze({
  SEM_PAPEL: "sem_papel",
  A_IDENTIFICAR: "a_identificar",
  COMENTARIO: "comentario",
  FORMULA: "valor_por_formula",
  IDENTICA: "identica_no_arquivo",
  TRANSFERENCIA_SEM_PAR: "transferencia_sem_contraparte",
  POSSIVEL_ALTERACAO: "possivel_alteracao",
});

const colapsar = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export const norm = (s) => colapsar(s).normalize("NFC").toUpperCase();
const semAcento = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Data → "YYYY-MM-DD" | null. Aceita serial do Excel, Date (componentes UTC), ISO e dd/mm/aaaa. */
export function paraDataISO(v) {
  if (v == null || v === "") return null;
  const mk = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : mk(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === "number") {
    if (!(v > 20000 && v < 80000)) return null; // 1954–2118
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return mk(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? mk(+m[3], +m[2], +m[1]) : null;
}

/**
 * Linha bruta: { linha, data, descricao, entrada, saida, tipo, natureza, categoria, conta, comentario?, formulaEntrada?, formulaSaida? }
 * Retorna { lancamentos, saldos, erros } — erros por linha, nunca exceção por dado ruim.
 */
export function normalizarLinhas(brutas) {
  const lancamentos = [];
  const saldos = [];
  const erros = [];
  for (const b of brutas) {
    const falha = (motivo) => erros.push({ linha: b.linha, motivo });
    try {
      const dataISO = paraDataISO(b.data);
      if (!dataISO) { falha("data inválida"); continue; }
      const conta = colapsar(b.conta);
      if (!conta) { falha("conta ausente"); continue; }
      const descricao = colapsar(b.descricao);
      if (!descricao) { falha("descrição ausente"); continue; }
      const ent = paraCentavos(b.entrada) ?? 0;
      const sai = paraCentavos(b.saida) ?? 0;
      if (ent < 0 || sai < 0) { falha("valor negativo"); continue; }
      if (ent > 0 && sai > 0) { falha("entrada e saída preenchidas na mesma linha"); continue; }
      if (ent === 0 && sai === 0) { falha("linha sem valor"); continue; }
      const sentido = ent > 0 ? "entrada" : "saida";
      const valorCentavos = ent > 0 ? ent : sai;
      const tipo = norm(b.tipo);
      const natureza = norm(b.natureza);
      const categoria = norm(b.categoria);
      const papel = papelDeTipoNatureza(tipo, natureza);
      const formula = ent > 0 ? b.formulaEntrada : b.formulaSaida;
      const base = { linha: b.linha, dataISO, descricao, conta, sentido, valorCentavos, tipo, natureza, categoria, papel,
        comentario: b.comentario ? colapsar(b.comentario) : null, formula: formula ? String(formula) : null };
      if (papel === PAPEL.SALDO_ANTERIOR) {
        if (sentido !== "entrada") { falha("saldo anterior deve ser entrada"); continue; }
        saldos.push({ linha: b.linha, conta, dataISO, valorCentavos, descricao, comentario: base.comentario });
      } else lancamentos.push(base);
    } catch (e) {
      falha(e?.message ?? "linha inválida");
    }
  }
  return { lancamentos, saldos, erros };
}

/** Impressão do conteúdo que identifica o lançamento (não inclui comentário nem fórmula). */
export function impressao(l) {
  const s = [l.dataISO, norm(l.conta), norm(l.descricao), l.sentido, l.valorCentavos, l.tipo, l.natureza, l.categoria].join("|");
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}

export function atribuirChaves(lancamentos) {
  const vistos = new Map();
  return lancamentos.map((l) => {
    const h = impressao(l);
    const n = (vistos.get(h) ?? 0) + 1;
    vistos.set(h, n);
    return { ...l, impressao: h, ocorrencia: n, chave: `${h}#${n}` };
  });
}

/** Hash do ARQUIVO lógico (multiconjunto de chaves + saldos): igual para o mesmo conteúdo, independente da ordem. */
export function hashConteudo(lancamentos, saldos) {
  const partes = [...lancamentos.map((l) => l.chave), ...saldos.map((s) => `S|${norm(s.conta)}|${s.dataISO}|${s.valorCentavos}`)].sort();
  return createHash("sha256").update(partes.join("\n"), "utf8").digest("hex");
}

const REGRAS_A_IDENTIFICAR = [/A IDENTIFICAR/, /N[AÃ]O IDENTIFICAD/];
export const ehAIdentificar = (l) => REGRAS_A_IDENTIFICAR.some((r) => r.test(semAcento(`${l.categoria} ${l.descricao}`)));

const SETA = /(.+?)\s*(?:→|->|>)\s*(.+)$/;
function origemDestino(descricao, contasConhecidas) {
  const m = SETA.exec(norm(descricao));
  if (!m) return null;
  // palavra inteira (evita "A" casar dentro de "TRANSFERENCIA"); entre várias, a mais longa
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const acha = (txt) => [...contasConhecidas].sort((a, b) => b.length - a.length)
    .find((c) => new RegExp(`(^|[^A-Z0-9])${esc(norm(c))}($|[^A-Z0-9])`).test(txt));
  const o = acha(m[1]);
  const d = acha(m[2]);
  return o && d ? { origem: o, destino: d } : null;
}

/**
 * Propõe pares (saída em A ↔ entrada em B). NUNCA efetiva: devolve sugestões com confiança e motivos.
 * 'alta' = candidato único e mútuo (valor + data + contas diferentes) e, havendo mais de um candidato, evidência textual que desempata.
 * Qualquer outra situação é 'ambigua' e exige decisão humana. Sem contraparte → fica de fora (externa/pendente).
 */
export function sugerirPares(lancamentos) {
  const pernas = lancamentos.filter((l) => l.papel === PAPEL.TRANSFERENCIA);
  const contas = [...new Set(lancamentos.map((l) => l.conta))];
  const saidas = pernas.filter((l) => l.sentido === "saida");
  const entradas = pernas.filter((l) => l.sentido === "entrada");
  const cand = (s) => entradas.filter((e) => e.valorCentavos === s.valorCentavos && e.dataISO === s.dataISO && e.conta !== s.conta);
  const candE = (e) => saidas.filter((s) => s.valorCentavos === e.valorCentavos && s.dataISO === e.dataISO && s.conta !== e.conta);
  const evidencia = (s, e) => {
    const motivos = [];
    if (norm(s.descricao) === norm(e.descricao)) motivos.push("mesma descrição");
    for (const l of [s, e]) {
      const od = origemDestino(l.descricao, contas);
      if (od && norm(od.origem) === norm(s.conta) && norm(od.destino) === norm(e.conta)) { motivos.push("descrição indica origem→destino"); break; }
    }
    return motivos;
  };
  const pares = [];
  const usados = new Set();
  for (const s of saidas) {
    const cs = cand(s);
    if (!cs.length) continue;
    let alvo = null;
    let confianca = "ambigua";
    const motivos = ["mesmo valor e data, contas diferentes"];
    if (cs.length === 1 && candE(cs[0]).length === 1) { alvo = cs[0]; confianca = "alta"; }
    else {
      const pontuados = cs.map((e) => ({ e, ev: evidencia(s, e) })).sort((a, b) => b.ev.length - a.ev.length);
      if (pontuados[0].ev.length > 0 && (pontuados.length === 1 || pontuados[0].ev.length > pontuados[1].ev.length)) {
        alvo = pontuados[0].e; motivos.push(...pontuados[0].ev);
        confianca = candE(alvo).filter((x) => evidencia(x, alvo).length >= pontuados[0].ev.length).length === 1 ? "alta" : "ambigua";
      } else { alvo = cs[0]; motivos.push(`${cs.length} candidatos equivalentes`); }
    }
    const idPar = `${s.chave}>${alvo.chave}`;
    if (usados.has(alvo.chave) || usados.has(s.chave)) { pares.push({ id: idPar, saida: s.chave, entrada: alvo.chave, confianca: "ambigua", motivos: [...motivos, "perna já sugerida em outro par"], confirmado: false }); continue; }
    usados.add(s.chave); usados.add(alvo.chave);
    pares.push({ id: idPar, saida: s.chave, entrada: alvo.chave, confianca, motivos: [...new Set(motivos)], confirmado: false });
  }
  return pares;
}

/**
 * Monta a prévia.
 *  existentes: [{ chave, dataISO, conta, sentido, valorCentavos, descricao }] — já gravados para esta unidade (origem importação).
 *  aceitarAlteracoes: Set de chaves que o usuário aceitou importar mesmo sendo possível alteração.
 */
export function montarPrevia({ brutas, existentes = [], aceitarAlteracoes = new Set(), totalDeclarado = null, saldosAbertura = {} }) {
  const { lancamentos: norms, saldos, erros } = normalizarLinhas(brutas);
  const lancs = atribuirChaves(norms);
  const porImpressao = new Map();
  for (const l of lancs) porImpressao.set(l.impressao, (porImpressao.get(l.impressao) ?? 0) + 1);

  const chavesExistentes = new Set(existentes.map((e) => e.chave));
  const chavesArquivo = new Set(lancs.map((l) => l.chave));
  const ausentes = existentes.filter((e) => !chavesArquivo.has(e.chave));
  const ausentePorBase = new Map();
  for (const a of ausentes) {
    const k = `${a.dataISO}|${norm(a.conta)}|${a.sentido}|${a.valorCentavos}`;
    ausentePorBase.set(k, [...(ausentePorBase.get(k) ?? []), a]);
  }

  const pares = sugerirPares(lancs);
  const chavesEmPar = new Set(pares.flatMap((p) => [p.saida, p.entrada]));

  const itens = lancs.map((l) => {
    const motivos = [];
    if (!l.papel) motivos.push({ codigo: MOTIVO.SEM_PAPEL, texto: `Tipo/natureza sem mapeamento (${l.tipo}/${l.natureza}); permanece sem classificação` });
    if (ehAIdentificar(l)) motivos.push({ codigo: MOTIVO.A_IDENTIFICAR, texto: "Origem/destino a identificar; classificação empresarial não confirmada" });
    if (l.comentario) motivos.push({ codigo: MOTIVO.COMENTARIO, texto: l.comentario });
    if (l.formula) motivos.push({ codigo: MOTIVO.FORMULA, texto: `Valor calculado por fórmula no arquivo: ${l.formula}` });
    if (porImpressao.get(l.impressao) > 1) motivos.push({ codigo: MOTIVO.IDENTICA, texto: `${porImpressao.get(l.impressao)} linhas idênticas no arquivo (preservadas; verificar se é duplicidade)` });
    if (l.papel === PAPEL.TRANSFERENCIA) {
      motivos.push({ codigo: MOTIVO.TRANSFERENCIA_SEM_PAR, texto: chavesEmPar.has(l.chave) ? "Par sugerido aguardando confirmação" : "Transferência sem contraparte identificada (movimento externo ou perna ausente)" });
    }

    const existente = chavesExistentes.has(l.chave);
    const candidatos = existente ? [] : (ausentePorBase.get(`${l.dataISO}|${norm(l.conta)}|${l.sentido}|${l.valorCentavos}`) ?? []);
    const possivelAlteracao = candidatos.length > 0;
    if (possivelAlteracao) motivos.push({ codigo: MOTIVO.POSSIVEL_ALTERACAO, texto: `Parece ser edição de lançamento já importado ("${candidatos[0].descricao}")` });
    const importar = !existente && (!possivelAlteracao || aceitarAlteracoes.has(l.chave));
    return { ...l, status: existente ? "existente" : possivelAlteracao ? "possivel_alteracao" : "novo", importar, motivos };
  });

  const pendenteClass = (i) => i.motivos.some((m) => [MOTIVO.SEM_PAPEL, MOTIVO.A_IDENTIFICAR, MOTIVO.TRANSFERENCIA_SEM_PAR].includes(m.codigo));

  const ent = itens.reduce((s, i) => s + (i.sentido === "entrada" ? i.valorCentavos : 0), 0);
  const sai = itens.reduce((s, i) => s + (i.sentido === "saida" ? i.valorCentavos : 0), 0);
  const entArquivo = ent + saldos.reduce((s, x) => s + x.valorCentavos, 0);
  const conferencia = totalDeclarado
    ? { declarado: totalDeclarado, calculado: { entradaCentavos: entArquivo, saidaCentavos: sai }, confere: totalDeclarado.entradaCentavos === entArquivo && totalDeclarado.saidaCentavos === sai }
    : { declarado: null, calculado: { entradaCentavos: entArquivo, saidaCentavos: sai }, confere: null };

  const categorias = [];
  const vistas = new Set();
  for (const i of itens) {
    if (!i.papel) continue;
    const k = `${i.tipo}|${i.natureza}|${i.categoria}`;
    if (!vistas.has(k)) { vistas.add(k); categorias.push({ tipo: i.tipo, natureza: i.natureza, nome: i.categoria, papel: i.papel }); }
  }
  const nomesContas = [...new Set([...itens.map((i) => i.conta), ...saldos.map((s) => s.conta)])];

  const saldosPrevia = saldos.map((s) => ({ conta: s.conta, data: s.dataISO, valor_centavos: s.valorCentavos, linha: s.linha }));
  const contasSemAbertura = nomesContas.filter((c) => !saldos.some((s) => s.conta === c) && saldosAbertura[c] == null);

  return {
    versao: 1,
    contas: nomesContas.map((nome) => ({ nome })),
    categorias,
    saldos: saldosPrevia,
    lancamentos: itens.map((i) => ({
      chave: i.chave, linha: i.linha, papel: i.papel, data: i.dataISO, descricao: i.descricao, sentido: i.sentido, valor_centavos: i.valorCentavos, conta: i.conta,
      categoria: i.papel ? { tipo: i.tipo, natureza: i.natureza, nome: i.categoria } : null,
      pendente: pendenteClass(i), nota: i.motivos.filter((m) => m.codigo !== MOTIVO.TRANSFERENCIA_SEM_PAR).map((m) => m.texto).join(" | ") || null,
      referencia: `linha ${i.linha}`, importar: i.importar, status: i.status, motivos: i.motivos.map((m) => m.codigo),
    })),
    pares,
    resumo: {
      linhasLidas: brutas.length, lancamentos: itens.length, saldos: saldos.length, erros: erros.length,
      novos: itens.filter((i) => i.status === "novo").length,
      existentes: itens.filter((i) => i.status === "existente").length,
      possiveisAlteracoes: itens.filter((i) => i.status === "possivel_alteracao").length,
      ausentesNoArquivo: ausentes.length,
      pendentes: itens.filter(pendenteClass).length,
      semPapel: itens.filter((i) => !i.papel).length,
      aIdentificar: itens.filter((i) => i.motivos.some((m) => m.codigo === MOTIVO.A_IDENTIFICAR)).length,
      comComentario: itens.filter((i) => i.comentario).length,
      comFormula: itens.filter((i) => i.formula).length,
      identicas: itens.filter((i) => porImpressao.get(i.impressao) > 1).length,
      paresSugeridos: pares.length, paresAltaConfianca: pares.filter((p) => p.confianca === "alta").length,
      contasSemAbertura,
      conferencia,
    },
    erros,
    ausentes: ausentes.map((a) => ({ chave: a.chave, data: a.dataISO, conta: a.conta, descricao: a.descricao, valor_centavos: a.valorCentavos })),
    hashConteudo: hashConteudo(lancs, saldos.map((s) => ({ ...s }))),
  };
}

/**
 * Aplica as decisões humanas sobre os pares sugeridos e recalcula quem fica pendente.
 * decisoes: { confirmar: [idPar], rejeitar: [idPar], confirmarAltaConfianca: boolean }
 */
export function aplicarDecisoesPares(previa, { confirmar = [], rejeitar = [], confirmarAltaConfianca = false } = {}) {
  const conf = new Set(confirmar);
  const rej = new Set(rejeitar);
  const pares = previa.pares.map((p) => {
    if (rej.has(p.id)) return { ...p, confirmado: false, rejeitado: true };
    const ok = conf.has(p.id) || (confirmarAltaConfianca && p.confianca === "alta" && !p.rejeitado);
    return { ...p, confirmado: ok ? true : p.confirmado };
  });
  const emParConfirmado = new Set(pares.filter((p) => p.confirmado).flatMap((p) => [p.saida, p.entrada]));
  const lancamentos = previa.lancamentos.map((l) => {
    const ehTransf = l.papel === PAPEL.TRANSFERENCIA;
    if (!ehTransf) return l;
    const semPar = !emParConfirmado.has(l.chave);
    const outros = (l.motivos ?? []).filter((m) => m !== MOTIVO.TRANSFERENCIA_SEM_PAR);
    const outrosPendentes = outros.some((m) => [MOTIVO.SEM_PAPEL, MOTIVO.A_IDENTIFICAR].includes(m));
    return { ...l, pendente: semPar || outrosPendentes, motivos: semPar ? [...outros, MOTIVO.TRANSFERENCIA_SEM_PAR] : outros };
  });
  return { ...previa, pares, lancamentos, resumo: { ...previa.resumo, paresConfirmados: pares.filter((p) => p.confirmado).length, pendentes: lancamentos.filter((l) => l.pendente).length } };
}
